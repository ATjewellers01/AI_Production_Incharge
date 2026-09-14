import { NextRequest, NextResponse } from 'next/server';

import { requireUser, AuthError } from '@/lib/auth';
import { getDelayedOrders, getStageBottlenecks, getKarigarLoad, getSummary } from '@/lib/tools';
import { getDelayedOrdersJf, getStageBottlenecksJf, getKarigarLoadJf, getSummaryJf } from '@/lib/tools-jf';
import { getDelayedIssuesErp, getStageBottlenecksErp, getKarigarLoadErp, getSummaryErp } from '@/lib/tools-erp';
import { getOpenAI, CHAT_MODEL, type Source } from '@/lib/openai';

/**
 * The fixed dashboard — always these three insights (plus a quick top-line
 * summary), in this order, computed fresh on every call (no caching, no
 * scheduled job — real-time per the product decision). This is deliberately
 * NOT the LLM function-calling path (see /api/chat for that) — the three
 * insights here are pre-decided and always shown, so they're called
 * directly rather than left to the model to choose.
 *
 * ?source=o2d (default), ?source=jf, or ?source=erp selects which data
 * comes back — jf added 2026-09-13, erp added 2026-09-14. The dashboard's
 * own source toggle passes this; the response shape is identical either
 * way so the frontend cards render the same regardless of which is active.
 */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUser(req.headers.get('authorization'));
  } catch (e) {
    const err = e as AuthError;
    return NextResponse.json({ success: false, message: err.message }, { status: err.status ?? 401 });
  }

  const sourceParam = req.nextUrl.searchParams.get('source');
  const source: Source = sourceParam === 'jf' ? 'jf' : sourceParam === 'erp' ? 'erp' : 'o2d';

  let summary, delayedOrders, stageBottlenecks, karigarLoad;
  try {
    if (source === 'jf') {
      [summary, delayedOrders, stageBottlenecks, karigarLoad] = await Promise.all([
        getSummaryJf(user),
        getDelayedOrdersJf(user),
        getStageBottlenecksJf(user),
        getKarigarLoadJf(user),
      ]);
    } else if (source === 'erp') {
      [summary, delayedOrders, stageBottlenecks, karigarLoad] = await Promise.all([
        getSummaryErp(user),
        getDelayedIssuesErp(user),
        getStageBottlenecksErp(user),
        getKarigarLoadErp(user),
      ]);
    } else {
      [summary, delayedOrders, stageBottlenecks, karigarLoad] = await Promise.all([
        getSummary(user),
        getDelayedOrders(user),
        getStageBottlenecks(user),
        getKarigarLoad(user),
      ]);
    }
  } catch (e) {
    // A database-connection failure (bad DATABASE_URL, SSL mismatch,
    // unreachable host, etc.) previously crashed this whole route with no
    // JSON body at all — surfaced as a bare 502 from the platform, with no
    // hint of the real cause. Log the full error server-side and return a
    // real error response instead.
    console.error(`[insights:${source}] database query failed:`, e);
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
      const narrativeSystemPrompt =
        source === 'jf'
          ? 'You are a production-floor analyst for a jewellery manufacturer (Jewel Factory). Given raw JSON data (delayed orders across Catalogue/Store Customer/Customised orders, stage bottlenecks, karigar workload), write a short (4-6 sentence) plain-language briefing a manufacturer would read first thing. Call out the single most urgent thing to act on. No price/monetary language. Do not invent any number not present in the data.'
          : source === 'erp'
            ? 'You are a production-floor analyst for a jewellery manufacturing ERP (metal/production-flow tracking, not customer orders). Given raw JSON data (outstanding karigar metal issues, production-planning stage counts, karigar workload by outstanding weight), write a short (4-6 sentence) plain-language briefing. This data has no real due-date or urgent flag — "delayed"/"urgent" are proxies based on how long metal has been outstanding, make that clear rather than implying a real deadline was missed. No price/monetary language. Do not invent any number not present in the data.'
            : 'You are a production-floor analyst for a jewellery order-to-delivery system. Given raw JSON data (delayed orders, stage bottlenecks, karigar workload), write a short (4-6 sentence) plain-language briefing a production incharge would read first thing. Call out the single most urgent thing to act on. No price/monetary language. Do not invent any number not present in the data.';

      const completion = await getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: narrativeSystemPrompt },
          {
            role: 'user',
            content: JSON.stringify({ summary, delayedOrders: delayedOrders.slice(0, 20), stageBottlenecks, karigarLoad: karigarLoad.slice(0, 20) }),
          },
        ],
        temperature: 0.3,
      });
      narrative = completion.choices[0]?.message?.content ?? null;
    } catch (e) {
      console.error(`[insights:${source}] OpenAI narrative failed:`, e);
    }
  }

  return NextResponse.json({ success: true, data: { summary, delayedOrders, stageBottlenecks, karigarLoad, narrative } });
}
