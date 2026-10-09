import { NextRequest, NextResponse } from 'next/server';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { requireUser, AuthError } from '@/lib/auth';
import { getOpenAI, CHAT_MODEL, getToolSchemas, getSystemPrompt, runTool, type Source } from '@/lib/openai';

// Caps how many tool-call round-trips one question can trigger, so a
// confused model can't loop indefinitely against the database.
const MAX_TOOL_ROUNDS = 5;

// Hindi/Hinglish/English wordings of "where should we focus / what is stuck /
// what do you suggest". Kept narrow on purpose (no bare "late"/"kahan") so
// order-lookup questions like "JF-1042 kahan hai?" are not hijacked.
const TAT_QUESTION_RE = /dhyan|attention|focus|prioriti|\btat\b|turnaround|suggest|sujhav|action plan|kya kare|kya karna|stuck|atk[ae]|ruk[ae]|bottleneck/i;

type ChatBody = {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  // Which business this question is scoped to — 'o2d' (default, for
  // backward compatibility with any client not yet sending it) or 'jf'
  // (Jewel Factory, added 2026-09-13). Determines both which tools the
  // model is offered and which lib/tools*.ts functions actually run.
  source?: Source;
};

// Streamed as newline-delimited JSON ("NDJSON") text chunks, NOT Server-Sent
// Events — simpler to produce here and to parse on the client with a plain
// ReadableStream reader, no EventSource/'data: ' framing needed. Each line
// is one of:
//   {"type":"delta","text":"..."}   — one more slice of the reply to append
//   {"type":"done","toolCalls":[...]} — stream finished, carries the
//                                        tool-call log for the UI's debug view
//   {"type":"error","message":"..."}  — something failed mid-stream; the
//                                        client shows this instead of more text
type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; toolCalls: Array<{ name: string; args: unknown }> }
  | { type: 'error'; message: string };

/**
 * The flexible side of this service — unlike /api/insights (three fixed
 * calls, always), this lets the model choose which of lib/tools.ts's (O2D)
 * or lib/tools-jf.ts's (Jewel Factory) functions to call, in whatever
 * combination the free-text question needs. It can never call anything
 * beyond the tool schemas for the request's own `source`, and none of
 * those functions can write to the database (see each tools file's own
 * header comment).
 *
 * Every round is streamed from OpenAI: text deltas are forwarded to the
 * client immediately (a direct answer, or the answer written after the tool
 * results come back, types out live), while tool-call argument fragments are
 * accumulated silently and executed once the round's stream ends.
 */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser(req.headers.get('authorization'));
  } catch (e) {
    const err = e as AuthError;
    return NextResponse.json({ success: false, message: err.message }, { status: err.status ?? 401 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ success: false, message: 'Chat is not configured (OPENAI_API_KEY unset).' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as ChatBody | null;
  if (!body?.messages?.length) {
    return NextResponse.json({ success: false, message: 'messages is required' }, { status: 400 });
  }
  // Keep only the last 10 turns as context — this is a stateless Q&A
  // assistant, not a long-running conversation that needs full history.
  const history = body.messages.slice(-10);

  // "Where should we give attention / what is stuck / any suggestions" questions
  // must always be answered from the TAT analysis, not from the model's own
  // guess. TAT lives in the O2D data, so such a question is answered from O2D
  // whichever source the chat dropdown is on, and the first round is forced to
  // call getTatDelays (later rounds stay free). Plain "delayed orders"
  // questions are deliberately NOT matched here; the model picks between the
  // due-date tool and the TAT tool for those.
  const lastUserText = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
  const forceTat = TAT_QUESTION_RE.test(lastUserText);

  const source: Source = forceTat ? 'o2d' : body.source === 'jf' ? 'jf' : body.source === 'erp' ? 'erp' : 'o2d';
  const toolSchemas = getToolSchemas(source);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: getSystemPrompt(source) },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
  ];

  const toolCallLog: Array<{ name: string; args: unknown }> = [];
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(event: StreamEvent) {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      }

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const isLastPossibleRound = round === MAX_TOOL_ROUNDS - 1;

          if (!isLastPossibleRound) {
            // Streamed end-to-end: text deltas go to the client the moment
            // they arrive (so a direct answer, or the answer after the tool
            // results, types out live), while any tool_calls fragments are
            // accumulated silently by index until the stream ends.
            const completionStream = await getOpenAI().chat.completions.create({
              model: CHAT_MODEL,
              messages,
              tools: toolSchemas,
              ...(forceTat && round === 0 ? { tool_choice: { type: 'function' as const, function: { name: 'getTatDelays' } } } : {}),
              temperature: 0.2,
              stream: true,
            });

            let text = '';
            const acc = new Map<number, { id: string; name: string; args: string }>();
            for await (const part of completionStream) {
              const delta = part.choices[0]?.delta;
              if (delta?.content) {
                text += delta.content;
                send({ type: 'delta', text: delta.content });
              }
              for (const tc of delta?.tool_calls ?? []) {
                const entry = acc.get(tc.index) ?? { id: '', name: '', args: '' };
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name += tc.function.name;
                if (tc.function?.arguments) entry.args += tc.function.arguments;
                acc.set(tc.index, entry);
              }
            }

            const toolCalls = Array.from(acc.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([, v]) => v);

            if (!toolCalls.length) {
              send({ type: 'done', toolCalls: toolCallLog });
              controller.close();
              return;
            }

            messages.push({
              role: 'assistant',
              content: text || null,
              tool_calls: toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.args } })),
            });
            for (const call of toolCalls) {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(call.args || '{}');
              } catch {
                // malformed arguments from the model — run the tool with no filters
              }
              toolCallLog.push({ name: call.name, args });
              let result: unknown;
              try {
                result = await runTool(call.name, args, user, source);
              } catch (e) {
                result = { error: e instanceof Error ? e.message : 'Tool failed' };
              }
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
            }
            continue;
          }

          // Final allowed round: no more tool calls permitted, so ask for a
          // real streamed text answer directly.
          const completionStream = await getOpenAI().chat.completions.create({
            model: CHAT_MODEL,
            messages,
            temperature: 0.2,
            stream: true,
          });
          for await (const part of completionStream) {
            const delta = part.choices[0]?.delta?.content;
            if (delta) send({ type: 'delta', text: delta });
          }
          send({ type: 'done', toolCalls: toolCallLog });
          controller.close();
          return;
        }
      } catch (e) {
        // Covers a failing OpenAI call itself (bad/missing API key, network
        // issue, rate limit) — reported as a stream event since headers are
        // already committed once streaming has started.
        console.error('[chat] request failed:', e);
        send({ type: 'error', message: e instanceof Error ? `Chat error: ${e.message}` : 'Chat error' });
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
