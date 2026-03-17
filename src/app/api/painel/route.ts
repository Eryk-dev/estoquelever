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

// Active statuses for SLA calculation (not yet embalado)
const SLA_STATUSES = [
  "aguardando_compra",
  "aguardando_nf",
  "aguardando_separacao",
  "em_separacao",
  "separado",
] as const;

/**
 * GET /api/painel
 *
 * Returns aggregated data for the Torre de Controle (control tower) view:
 * pipeline counts, SLA breakdown, throughput, alerts, KPIs.
 *
 * Query params:
 *   galpao_id — filter by galpão (optional)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const galpaoFilter = searchParams.get("galpao_id");

  const supabase = createServiceClient();

  try {
    // ── Resolve empresa IDs for galpao filter ─────────────────────────────
    let allowedEmpresaIds: string[] | null = null;
    if (galpaoFilter) {
      const { data: empresas } = await supabase
        .from("siso_empresas")
        .select("id")
        .eq("galpao_id", galpaoFilter);
      allowedEmpresaIds = empresas?.map((e) => e.id) ?? [];
      if (allowedEmpresaIds.length === 0) {
        return NextResponse.json(emptyResponse());
      }
    }

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

    // Helper to apply empresa filter to a query builder
    function applyFilter<T extends { in: (col: string, vals: string[]) => T }>(q: T): T {
      if (allowedEmpresaIds) return q.in("empresa_origem_id", allowedEmpresaIds);
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

    // 2. SLA — fetch prazo_envio for active (non-embalado) orders
    let slaQuery = supabase
      .from("siso_pedidos")
      .select("prazo_envio")
      .in("status_separacao", SLA_STATUSES as unknown as string[]);
    slaQuery = applyFilter(slaQuery);

    // 3. Throughput — orders packed today (embalagem_concluida_em >= today BRT)
    let throughputQuery = supabase
      .from("siso_pedidos")
      .select("embalagem_concluida_em")
      .eq("status_separacao", "embalado")
      .gte("embalagem_concluida_em", todayStartBrt);
    throughputQuery = applyFilter(throughputQuery);

    // 4. Stuck NF — aguardando_nf with criado_em > 4h ago
    let stuckNfQuery = supabase
      .from("siso_pedidos")
      .select("*", { count: "exact", head: true })
      .eq("status_separacao", "aguardando_nf")
      .lt("criado_em", fourHoursAgo);
    stuckNfQuery = applyFilter(stuckNfQuery);

    // 5. Stuck separacao — em_separacao with separacao_iniciada_em > 2h ago
    let stuckSepQuery = supabase
      .from("siso_pedidos")
      .select("*", { count: "exact", head: true })
      .eq("status_separacao", "em_separacao")
      .lt("separacao_iniciada_em", twoHoursAgo);
    stuckSepQuery = applyFilter(stuckSepQuery);

    // 6. Recent errors — last 1h (no empresa filter on erros table)
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

    // 7. Avg cycle time — embalados in last 24h, fetch both timestamps
    let cycleQuery = supabase
      .from("siso_pedidos")
      .select("criado_em, embalagem_concluida_em")
      .eq("status_separacao", "embalado")
      .gte("embalagem_concluida_em", twentyFourHoursAgo)
      .not("embalagem_concluida_em", "is", null);
    cycleQuery = applyFilter(cycleQuery);

    // 8. Galpoes list
    const galpoesQuery = supabase
      .from("siso_galpoes")
      .select("id, nome")
      .eq("ativo", true)
      .order("nome");

    // ── Execute all in parallel ───────────────────────────────────────────
    const [
      pipelineResults,
      { data: slaData },
      { data: throughputData },
      stuckNfResult,
      stuckSepResult,
      errorsCountResult,
      { data: errorSamples },
      { data: cycleData },
      { data: galpoes },
    ] = await Promise.all([
      Promise.all(pipelinePromises),
      slaQuery,
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

    // ── Build SLA ─────────────────────────────────────────────────────────
    const sla = { overdue: 0, urgent: 0, attention: 0, on_time: 0, no_deadline: 0 };
    const nowMs = now.getTime();
    for (const row of slaData ?? []) {
      if (!row.prazo_envio) {
        sla.no_deadline++;
        continue;
      }
      const diffH = (new Date(row.prazo_envio).getTime() - nowMs) / (1000 * 60 * 60);
      if (diffH < 0) sla.overdue++;
      else if (diffH < 2) sla.urgent++;
      else if (diffH < 4) sla.attention++;
      else sla.on_time++;
    }

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

      sla,

      throughput: {
        buckets,
        total_today: totalToday,
      },

      alerts: {
        overdue_count: sla.overdue,
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
        overdue_count: sla.overdue,
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

function emptyResponse() {
  return {
    server_time: new Date().toISOString(),
    galpoes: [],
    pipeline: Object.fromEntries(PIPELINE_STATUSES.map((s) => [s, 0])),
    sla: { overdue: 0, urgent: 0, attention: 0, on_time: 0, no_deadline: 0 },
    throughput: { buckets: [], total_today: 0 },
    alerts: { overdue_count: 0, stuck_nf: 0, stuck_separacao: 0, recent_errors: 0, error_samples: [] },
    kpis: { processed_today: 0, pipeline_total: 0, overdue_count: 0, avg_cycle_time_min: null },
  };
}
