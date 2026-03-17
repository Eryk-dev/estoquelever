import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

const PIPELINE_STATUSES = [
  "aguardando_compra",
  "aguardando_nf",
  "aguardando_separacao",
  "em_separacao",
  "separado",
  "embalado",
] as const;

/**
 * GET /api/painel
 *
 * Returns aggregated data for the Torre de Controle (control tower) view:
 * pipeline counts, throughput, alerts, KPIs.
 *
 * Query params:
 *   galpao_id — filter by galpão (optional)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const galpaoFilter = searchParams.get("galpao_id");

  const supabase = createServiceClient();

  try {
    // ── Build all queries in parallel ─────────────────────────────────────
    const now = new Date();
    const nowIso = now.toISOString();

    // BRT = UTC-3
    const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const todayStr = brt.toISOString().slice(0, 10);
    const todayStartBrt = `${todayStr}T00:00:00-03:00`;

    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    // Filter the operational pipeline by the destination separation galpão.
    function applyFilter<T extends { eq: (col: string, val: string) => T }>(q: T): T {
      if (galpaoFilter) return q.eq("separacao_galpao_id", galpaoFilter);
      return q;
    }

    // 1. Pipeline counts — 6× HEAD queries
    const pipelinePromises = PIPELINE_STATUSES.map((status) => {
      const q = supabase
        .from("siso_pedidos")
        .select("*", { count: "exact", head: true })
        .eq("status_separacao", status);
      return applyFilter(q);
    });

    // 2. Throughput — orders packed today (embalagem_concluida_em >= today BRT)
    let throughputQuery = supabase
      .from("siso_pedidos")
      .select("embalagem_concluida_em")
      .eq("status_separacao", "embalado")
      .gte("embalagem_concluida_em", todayStartBrt);
    throughputQuery = applyFilter(throughputQuery);

    // 3. Stuck NF — aguardando_nf with criado_em > 4h ago
    let stuckNfQuery = supabase
      .from("siso_pedidos")
      .select("*", { count: "exact", head: true })
      .eq("status_separacao", "aguardando_nf")
      .lt("criado_em", fourHoursAgo);
    stuckNfQuery = applyFilter(stuckNfQuery);

    // 4. Stuck separacao — em_separacao with separacao_iniciada_em > 2h ago
    let stuckSepQuery = supabase
      .from("siso_pedidos")
      .select("*", { count: "exact", head: true })
      .eq("status_separacao", "em_separacao")
      .lt("separacao_iniciada_em", twoHoursAgo);
    stuckSepQuery = applyFilter(stuckSepQuery);

    // 5. Recent errors — last 1h (no empresa filter on erros table)
    const errorsCountQuery = supabase
      .from("siso_erros")
      .select("*", { count: "exact", head: true })
      .gte("timestamp", oneHourAgo);

    const errorSamplesQuery = supabase
      .from("siso_erros")
      .select("source, message, timestamp")
      .gte("timestamp", oneHourAgo)
      .order("timestamp", { ascending: false })
      .limit(3);

    // 6. Avg cycle time — embalados in last 24h, fetch both timestamps
    let cycleQuery = supabase
      .from("siso_pedidos")
      .select("criado_em, embalagem_concluida_em")
      .eq("status_separacao", "embalado")
      .gte("embalagem_concluida_em", twentyFourHoursAgo)
      .not("embalagem_concluida_em", "is", null);
    cycleQuery = applyFilter(cycleQuery);

    // 7. Galpoes list
    const galpoesQuery = supabase
      .from("siso_galpoes")
      .select("id, nome")
      .eq("ativo", true)
      .order("nome");

    // ── Execute all in parallel ───────────────────────────────────────────
    const [
      pipelineResults,
      { data: throughputData },
      stuckNfResult,
      stuckSepResult,
      errorsCountResult,
      { data: errorSamples },
      { data: cycleData },
      { data: galpoes },
    ] = await Promise.all([
      Promise.all(pipelinePromises),
      throughputQuery,
      stuckNfQuery,
      stuckSepQuery,
      errorsCountQuery,
      errorSamplesQuery,
      cycleQuery,
      galpoesQuery,
    ]);

    // ── Build pipeline ────────────────────────────────────────────────────
    const pipeline: Record<string, number> = {};
    PIPELINE_STATUSES.forEach((status, i) => {
      pipeline[status] = pipelineResults[i].count ?? 0;
    });

    // ── Build throughput buckets ──────────────────────────────────────────
    const hourBuckets = new Map<number, number>();
    for (let h = 0; h < 24; h++) hourBuckets.set(h, 0);

    let totalToday = 0;
    for (const row of throughputData ?? []) {
      if (!row.embalagem_concluida_em) continue;
      totalToday++;
      // Convert to BRT hour
      const d = new Date(row.embalagem_concluida_em);
      const brtH = new Date(d.getTime() - 3 * 60 * 60 * 1000).getUTCHours();
      hourBuckets.set(brtH, (hourBuckets.get(brtH) ?? 0) + 1);
    }

    const buckets = Array.from(hourBuckets.entries())
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => a.hour - b.hour);

    // ── Avg cycle time ────────────────────────────────────────────────────
    let avgCycleTimeMin: number | null = null;
    if (cycleData && cycleData.length > 0) {
      let totalMs = 0;
      let count = 0;
      for (const row of cycleData) {
        if (!row.criado_em || !row.embalagem_concluida_em) continue;
        totalMs += new Date(row.embalagem_concluida_em).getTime() - new Date(row.criado_em).getTime();
        count++;
      }
      if (count > 0) avgCycleTimeMin = Math.round(totalMs / count / (1000 * 60));
    }

    // ── Build response ────────────────────────────────────────────────────
    const pipelineTotal = Object.values(pipeline).reduce((s, n) => s + n, 0);

    return NextResponse.json({
      server_time: nowIso,
      galpoes: galpoes ?? [],

      pipeline,

      throughput: {
        buckets,
        total_today: totalToday,
      },

      alerts: {
        stuck_nf: stuckNfResult.count ?? 0,
        stuck_separacao: stuckSepResult.count ?? 0,
        recent_errors: errorsCountResult.count ?? 0,
        error_samples: (errorSamples ?? []).map((e) => ({
          source: e.source,
          message: e.message,
          timestamp: e.timestamp,
        })),
      },

      kpis: {
        processed_today: totalToday,
        pipeline_total: pipelineTotal,
        avg_cycle_time_min: avgCycleTimeMin,
      },
    });
  } catch (err) {
    logger.error("painel", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
