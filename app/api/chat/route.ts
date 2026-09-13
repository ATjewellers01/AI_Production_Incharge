import { NextRequest, NextResponse } from 'next/server';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { requireUser, AuthError } from '@/lib/auth';
import { getOpenAI, CHAT_MODEL, getToolSchemas, getSystemPrompt, runTool, type Source } from '@/lib/openai';

// Caps how many tool-call round-trips one question can trigger, so a
// confused model can't loop indefinitely against the database.
const MAX_TOOL_ROUNDS = 5;

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
 * Tool-call rounds (the model deciding which data to fetch) are NOT
 * streamed — they produce no user-visible text, only function-call
 * arguments, so there's nothing worth showing incrementally. Only the
 * FINAL round (the model's actual answer, once it has every tool result it
 * asked for) streams its text back token-by-token.
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
  const source: Source = body.source === 'jf' ? 'jf' : 'o2d';
  const toolSchemas = getToolSchemas(source);

  // Keep only the last 10 turns as context — this is a stateless Q&A
  // assistant, not a long-running conversation that needs full history.
  const history = body.messages.slice(-10);

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
            // Non-streamed: we need to see whether the model wants to call a
            // tool BEFORE committing to a streamed text response, since a
            // streaming completion with tool_calls arrives as fragmented
            // JSON-argument deltas, not readable text — not worth streaming.
            const completion = await getOpenAI().chat.completions.create({
              model: CHAT_MODEL,
              messages,
              tools: toolSchemas,
              temperature: 0.2,
            });
            const choice = completion.choices[0];
            const toolCalls = choice?.message?.tool_calls;

            if (!toolCalls?.length) {
              // Model answered directly with no tool call — stream this
              // text back in small artificial chunks so the UI still gets
              // the live-typing effect, then finish.
              const text = choice?.message?.content ?? '';
              for (const chunk of chunkText(text)) send({ type: 'delta', text: chunk });
              send({ type: 'done', toolCalls: toolCallLog });
              controller.close();
              return;
            }

            messages.push(choice.message);
            for (const call of toolCalls) {
              const args = JSON.parse(call.function.arguments || '{}');
              toolCallLog.push({ name: call.function.name, args });
              let result: unknown;
              try {
                result = await runTool(call.function.name, args, user, source);
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

/** Splits text into small chunks so a non-streamed model reply still gets a
 * live-typing effect on the client, matching the real-streamed case. */
function chunkText(text: string, size = 6): string[] {
  const words = text.split(/(\s+)/);
  const chunks: string[] = [];
  let buf = '';
  for (const w of words) {
    buf += w;
    if (buf.length >= size) {
      chunks.push(buf);
      buf = '';
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}
