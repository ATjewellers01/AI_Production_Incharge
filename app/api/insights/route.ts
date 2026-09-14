import { NextRequest, NextResponse } from 'next/server';

import { requireUser, AuthError } from '@/lib/auth';
import { getDelayedOrders, getStageBottlenecks, getKarigarLoad, getSummary } from '@/lib/tools';
import { getDelayedOrdersJf, getStageBottlenecksJf, getKarigarLoadJf, getSummaryJf } from '@/lib/tools-jf';
import {
  getMetalStockSummaryErp,
  getDepartmentEfficiencyErp,
  getKarigarRankingsErp,
  getDepartmentSummaryErp,
  getAlloySummaryErp,
  getJobPipelineErp,
  getRecentActivityErp,
  getOrdersSummaryErp,
  deriveUrgentAlertsErp,
} from '@/lib/tools-erp';
import { getOpenAI, CHAT_MODEL, type Source } from '@/lib/openai';

/**
 * The fixed dashboard — always these insights, computed fresh on every
 * call (no caching, no scheduled job — real-time per the product
 * decision). This is deliberately NOT the LLM function-calling path (see
 * /api/chat for that) — the insights here are pre-decided and always
 * shown, so they're called directly rather than left to the model to
 * choose.
 *
 * ?source=o2d (default), ?source=jf, or ?source=erp selects which data
 * comes back — jf added 2026-09-13, erp added 2026-09-14.
 *
 * O2D and Jewel Factory share one response shape (summary/delayedOrders/
 * stageBottlenecks/karigarLoad — "customer order" concepts). ERP's data is
 * genuinely different (metal/production flow, not orders), so it gets its
 * OWN response shape entirely (stock levels, department efficiency,
 * karigar rankings, alloy summary, job pipeline, recent activity, alerts)
 * mirroring erp-new-frontend's own dashboard — see lib/tools-erp.ts's
 * header comment. app/page.tsx renders a dedicated ERP section rather than
 * forcing this through the O2D/JF card layout.
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

  if (source === 'erp') {
    return handleErpInsights(user);
  }

  let summary, delayedOrders, stageBottlenecks, karigarLoad;
  try {
    if (source === 'jf') {
      [summary, delayedOrders, stageBottlenecks, karigarLoad] = await Promise.all([
        getSummaryJf(user),
        getDelayedOrdersJf(user),
        getStageBottlenecksJf(user),
        getKarigarLoadJf(user),
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
    console.error(`[insights:${source}] database query failed:`, e);
    return NextResponse.json(
      { success: false, message: e instanceof Error ? `Database error: ${e.message}` : 'Database error' },
      { status: 500 },
    );
  }

  let narrative: string | null = null;
  if (process.env.OPENAI_API_KEY) {
    try {
      const narrativeSystemPrompt =
        source === 'jf'
          ? 'You are a production-floor analyst for a jewellery manufacturer (Jewel Factory). Given raw JSON data (delayed orders across Catalogue/Store Customer/Customised orders, stage bottlenecks, karigar workload), write a short (4-6 sentence) plain-language briefing a manufacturer would read first thing. Call out the single most urgent thing to act on. No price/monetary language. Do not invent any number not present in the data.'
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

async function handleErpInsights(user: Awaited<ReturnType<typeof requireUser>>) {
  let stock, departmentEfficiency, karigarRankings, departmentSummary, alloySummary, jobPipeline, recentActivity, ordersSummary;
  try {
    [stock, departmentEfficiency, karigarRankings, departmentSummary, alloySummary, jobPipeline, recentActivity, ordersSummary] =
      await Promise.all([
        getMetalStockSummaryErp(user),
        getDepartmentEfficiencyErp(user),
        getKarigarRankingsErp(user),
        getDepartmentSummaryErp(user),
        getAlloySummaryErp(user),
        getJobPipelineErp(user),
        getRecentActivityErp(user),
        getOrdersSummaryErp(user),
      ]);
  } catch (e) {
    console.error('[insights:erp] database query failed:', e);
    return NextResponse.json(
      { success: false, message: e instanceof Error ? `Database error: ${e.message}` : 'Database error' },
      { status: 500 },
    );
  }

  const alerts = deriveUrgentAlertsErp(stock);

  let narrative: string | null = null;
  if (process.env.OPENAI_API_KEY) {
    try {
      const completion = await getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a production-floor analyst for a jewellery manufacturing ERP (metal/production-flow tracking, not customer orders). Given raw JSON data (metal stock levels by karat, department recovery %, karigar recovery rankings, alloy conversion loss stats, job pipeline counts), write a short (4-6 sentence) plain-language briefing a factory manager would read first thing. Call out the single most urgent thing to act on (e.g. a low-stock karat, a department or karigar with poor recovery, high conversion loss). No price/monetary language. Do not invent any number not present in the data.',
          },
          {
            role: 'user',
            content: JSON.stringify({ stock, departmentEfficiency, karigarRankings: karigarRankings.slice(0, 10), departmentSummary, alloySummary, jobPipeline }),
          },
        ],
        temperature: 0.3,
      });
      narrative = completion.choices[0]?.message?.content ?? null;
    } catch (e) {
      console.error('[insights:erp] OpenAI narrative failed:', e);
    }
  }

  return NextResponse.json({
    success: true,
    data: { stock, departmentEfficiency, karigarRankings, departmentSummary, alloySummary, jobPipeline, recentActivity, ordersSummary, alerts, narrative },
  });
}
