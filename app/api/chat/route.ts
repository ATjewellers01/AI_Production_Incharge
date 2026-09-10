import { NextRequest, NextResponse } from 'next/server';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { requireUser, AuthError } from '@/lib/auth';
import { getOpenAI, CHAT_MODEL, TOOL_SCHEMAS, SYSTEM_PROMPT, runTool } from '@/lib/openai';

// Caps how many tool-call round-trips one question can trigger, so a
// confused model can't loop indefinitely against the database.
const MAX_TOOL_ROUNDS = 5;

type ChatBody = { messages: Array<{ role: 'user' | 'assistant'; content: string }> };

/**
 * The flexible side of this service — unlike /api/insights (three fixed
 * calls, always), this lets the model choose which of lib/tools.ts's
 * functions (if any) to call, in whatever combination the free-text
 * question needs. It can never call anything beyond TOOL_SCHEMAS, and none
 * of those functions can write to the database (see lib/tools.ts).
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

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
  ];

  const toolCallLog: Array<{ name: string; args: unknown }> = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      messages,
      tools: TOOL_SCHEMAS,
      temperature: 0.2,
    });

    const choice = completion.choices[0];
    const toolCalls = choice?.message?.tool_calls;

    if (!toolCalls?.length) {
      // Model is done — no more tools to call, this is the final answer.
      return NextResponse.json({
        success: true,
        data: { reply: choice?.message?.content ?? '', toolCalls: toolCallLog },
      });
    }

    // Record the assistant's tool-call turn, then run every requested tool
    // and feed each result back as its own 'tool' message before asking the
    // model to continue — the standard OpenAI function-calling round-trip.
    messages.push(choice.message);
    for (const call of toolCalls) {
      const args = JSON.parse(call.function.arguments || '{}');
      toolCallLog.push({ name: call.function.name, args });
      let result: unknown;
      try {
        result = await runTool(call.function.name, args, user);
      } catch (e) {
        result = { error: e instanceof Error ? e.message : 'Tool failed' };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return NextResponse.json(
    { success: false, message: 'Could not produce an answer within the tool-call limit — try a more specific question.' },
    { status: 500 },
  );
}
