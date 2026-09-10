import { NextRequest, NextResponse } from 'next/server';

import { requireUser, AuthError } from '@/lib/auth';
import { getDelayedOrders, getStageBottlenecks, getKarigarLoad, getSummary } from '@/lib/tools';
import { getOpenAI, CHAT_MODEL } from '@/lib/openai';

/**
 * The fixed dashboard — always these three insights (plus a quick top-line
 * summary), in this order, computed fresh on every call (no caching, no
 * scheduled job — real-time per the product decision). This is deliberately
 * NOT the LLM function-calling path (see /api/chat for that) — the three
 * insights here are pre-decided and always shown, so they're called
 * directly rather than left to the model to choose.
 */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUser(req.headers.get('authorization'));
  } catch (e) {
    const err = e as AuthError;
    return NextResponse.json({ success: false, message: err.message }, { status: err.status ?? 401 });
  }

  let summary, delayedOrders, stageBottlenecks, karigarLoad;
  try {
    [summary, delayedOrders, stageBottlenecks, karigarLoad] = await Promise.all([
      getSummary(user),
      getDelayedOrders(user),
      getStageBottlenecks(user),
      getKarigarLoad(user),
    ]);
  } catch (e) {
    // A database-connection failure (bad DATABASE_URL, SSL mismatch,
    // unreachable host, etc.) previously crashed this whole route with no
    // JSON body at all — surfaced as a bare 502 from the platform, with no
    // hint of the real cause. Log the full error server-side and return a
    // real error response instead.
    console.error('[insights] database query failed:', e);
    return NextResponse.json(
      { success: false, message: e instanceof Error ? `Database error: ${e.message}` : 'Database error' },
      { status: 500 },
    );
  }

  // One AI-generated narrative summary over the three raw datasets — the
  // "insight" on top of the numbers. If OpenAI isn't configured or the call
  // fails, the raw data above is still fully useful on its own (dashboard
  // cards render straight from it), so this degrades to null rather than
  // failing the whole request.
  let narrative: string | null = null;
  if (process.env.OPENAI_API_KEY) {
    try {
      const completion = await getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a production-floor analyst for a jewellery order-to-delivery system. Given raw JSON data (delayed orders, stage bottlenecks, karigar workload), write a short (4-6 sentence) plain-language briefing a production incharge would read first thing. Call out the single most urgent thing to act on. No price/monetary language. Do not invent any number not present in the data.',
          },
          {
            role: 'user',
            content: JSON.stringify({ summary, delayedOrders: delayedOrders.slice(0, 20), stageBottlenecks, karigarLoad: karigarLoad.slice(0, 20) }),
          },
        ],
        temperature: 0.3,
      });
      narrative = completion.choices[0]?.message?.content ?? null;
    } catch (e) {
      console.error('[insights] OpenAI narrative failed:', e);
    }
  }

  return NextResponse.json({ success: true, data: { summary, delayedOrders, stageBottlenecks, karigarLoad, narrative } });
}
