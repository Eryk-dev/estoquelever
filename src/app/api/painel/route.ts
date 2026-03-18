import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
const BACKLOG_STATUSES = [
  "aguardando_compra",
  "aguardando_nf",
  "aguardando_separacao",
  "em_separacao",
  "separado",
  "embalado",
] as const;
const TRACKED_STATUSES = [...BACKLOG_STATUSES, "expedido"] as const;

const STAGE_META: Record<
  (typeof TRACKED_STATUSES)[number],
  { label: string; href: string }
> = {
  aguardando_compra: {
    label: "Aguardando OC",
    href: "/separacao?tab=aguardando_compra",
  },
  aguardando_nf: {
    label: "Aguardando NF",
    href: "/separacao?tab=aguardando_nf",
  },
  aguardando_separacao: {
    label: "Aguardando separação",
    href: "/separacao?tab=aguardando_separacao",
  },
  em_separacao: {
    label: "Em separação",
    href: "/separacao?tab=em_separacao",
  },
  separado: {
    label: "Separado",
    href: "/separacao?tab=separado",
  },
  embalado: {
    label: "Embalado",
    href: "/separacao?tab=embalado",
  },
  expedido: {
    label: "Expedido",
    href: "/separacao?tab=embalado",
  },
};

type PainelOrderRow = {
  status_separacao: string | null;
  criado_em: string | null;
  separacao_iniciada_em: string | null;
  embalagem_concluida_em: string | null;
  prazo_envio: string | null;
  decisao_final: string | null;
  nome_ecommerce: string | null;
  separacao_galpao_id: string | null;
  separacao_operador_id: string | null;
  etiqueta_zpl: string | null;
};

function toBrtDateKey(date: Date): string {
  return new Date(date.getTime() - BRT_OFFSET_MS).toISOString().slice(0, 10);
}

function toBrtHour(date: Date): number {
  return new Date(date.getTime() - BRT_OFFSET_MS).getUTCHours();
}

function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function safePct(value: number, total: number, precision = 0): number {
  if (!total) return 0;
  return Number(((value / total) * 100).toFixed(precision));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], percentileTarget: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(percentileTarget * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

function deltaPct(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null || baseline === 0) return null;
  return Math.round(((current - baseline) / baseline) * 100);
}

function normalizeChannel(name: string | null): string {
  if (!name) return "Sem canal";
  const lower = name.toLowerCase();
  if (
    lower.includes("mercado livre") ||
    lower.startsWith("ml_") ||
    lower.startsWith("ml ")
  ) {
    return "Mercado Livre";
  }
  if (lower.includes("shopee")) return "Shopee";
  if (lower.includes("amazon")) return "Amazon";
  if (lower.includes("magalu")) return "Magalu";
  return name;
}

function isBacklogStatus(
  status: string | null,
): status is (typeof BACKLOG_STATUSES)[number] {
  return BACKLOG_STATUSES.includes(status as (typeof BACKLOG_STATUSES)[number]);
}

/**
 * GET /api/painel
 *
 * Returns aggregated data for the control tower view.
 * Preserves legacy keys used by the home page and adds
 * richer operational + managerial sections for the dashboard.
 *
 * Query params:
 *   galpao_id — filter by galpão (optional)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const galpaoFilter = searchParams.get("galpao_id");

  const supabase = createServiceClient();

  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const todayKey = toBrtDateKey(now);
    const historyStartKey = shiftDateKey(todayKey, -7);
    const chartStartKey = shiftDateKey(todayKey, -6);
    const historyStartBrt = `${historyStartKey}T00:00:00-03:00`;
    const endOfTodayBrt = new Date(`${shiftDateKey(todayKey, 1)}T00:00:00-03:00`);

    function applyFilter<T extends { eq: (col: string, val: string) => T }>(query: T): T {
      if (galpaoFilter) return query.eq("separacao_galpao_id", galpaoFilter);
      return query;
    }

    let trackedOrdersQuery = supabase
      .from("siso_pedidos")
      .select(
        "status_separacao, criado_em, separacao_iniciada_em, embalagem_concluida_em, prazo_envio, decisao_final, nome_ecommerce, separacao_galpao_id, separacao_operador_id, etiqueta_zpl",
      )
      .in("status_separacao", [...TRACKED_STATUSES]);
    trackedOrdersQuery = applyFilter(trackedOrdersQuery);

    let cycleRowsQuery = supabase
      .from("siso_pedidos")
      .select("criado_em, embalagem_concluida_em")
      .gte("embalagem_concluida_em", historyStartBrt)
      .not("embalagem_concluida_em", "is", null);
    cycleRowsQuery = applyFilter(cycleRowsQuery);

    const galpoesQuery = supabase
      .from("siso_galpoes")
      .select("id, nome")
      .eq("ativo", true)
      .order("nome");

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

    const [
      { data: trackedOrdersData },
      { data: cycleRowsData },
      errorsCountResult,
      { data: errorSamplesData },
      { data: galpoesData },
    ] = await Promise.all([
      trackedOrdersQuery,
      cycleRowsQuery,
      errorsCountQuery,
      errorSamplesQuery,
      galpoesQuery,
    ]);

    const trackedOrders = (trackedOrdersData ?? []) as PainelOrderRow[];
    const backlogOrders = trackedOrders.filter((order) =>
      isBacklogStatus(order.status_separacao),
    );
    const shippedTotal = trackedOrders.filter(
      (order) => order.status_separacao === "expedido",
    ).length;

    const galpoes = galpoesData ?? [];
    const galpaoNameById = new Map(galpoes.map((galpao) => [galpao.id, galpao.nome]));

    const operatorIds = Array.from(
      new Set(
        backlogOrders
          .filter(
            (order) =>
              order.status_separacao === "em_separacao" &&
              order.separacao_operador_id,
          )
          .map((order) => order.separacao_operador_id as string),
      ),
    );

    let operatorNames = new Map<string, string>();
    if (operatorIds.length > 0) {
      const { data: operators } = await supabase
        .from("siso_usuarios")
        .select("id, nome")
        .in("id", operatorIds);

      operatorNames = new Map(
        (operators ?? []).map((operator) => [operator.id, operator.nome]),
      );
    }

    const legacyPipeline: Record<string, number> = {};
    for (const status of BACKLOG_STATUSES) legacyPipeline[status] = 0;
    for (const order of backlogOrders) {
      if (!order.status_separacao) continue;
      legacyPipeline[order.status_separacao] =
        (legacyPipeline[order.status_separacao] ?? 0) + 1;
    }

    const activeBacklog = Object.values(legacyPipeline).reduce(
      (sum, value) => sum + value,
      0,
    );

    const funnelStages = TRACKED_STATUSES.map((status) => {
      const count =
        status === "expedido"
          ? shippedTotal
          : legacyPipeline[status] ?? 0;

      return {
        key: status,
        label: STAGE_META[status].label,
        href: STAGE_META[status].href,
        count,
        share_pct:
          status === "expedido"
            ? safePct(count, trackedOrders.length)
            : safePct(count, activeBacklog),
      };
    });

    const bottleneck = [...funnelStages]
      .filter((stage) => stage.key !== "expedido")
      .sort((left, right) => right.count - left.count)[0] ?? null;

    const deadlines = {
      overdue: 0,
      due_in_2h: 0,
      due_today: 0,
      future: 0,
      without_deadline: 0,
    };

    for (const order of backlogOrders) {
      if (!order.prazo_envio) {
        deadlines.without_deadline++;
        continue;
      }

      const deadline = new Date(order.prazo_envio);
      if (deadline < now) deadlines.overdue++;
      else if (deadline < twoHoursFromNow) deadlines.due_in_2h++;
      else if (deadline < endOfTodayBrt) deadlines.due_today++;
      else deadlines.future++;
    }

    const riskOrders = deadlines.overdue + deadlines.due_in_2h;
    const todayWindowOrders = riskOrders + deadlines.due_today;

    const aging = {
      nf_over_4h: 0,
      queue_over_6h: 0,
      picking_over_2h: 0,
      packed_over_2h: 0,
      separated_without_label: 0,
    };

    for (const order of backlogOrders) {
      if (order.status_separacao === "aguardando_nf" && order.criado_em && order.criado_em < fourHoursAgo) {
        aging.nf_over_4h++;
      }
      if (
        order.status_separacao === "aguardando_separacao" &&
        order.criado_em &&
        order.criado_em < sixHoursAgo
      ) {
        aging.queue_over_6h++;
      }
      if (
        order.status_separacao === "em_separacao" &&
        order.separacao_iniciada_em &&
        order.separacao_iniciada_em < twoHoursAgo
      ) {
        aging.picking_over_2h++;
      }
      if (
        order.status_separacao === "embalado" &&
        order.embalagem_concluida_em &&
        order.embalagem_concluida_em < twoHoursAgo
      ) {
        aging.packed_over_2h++;
      }
      if (order.status_separacao === "separado" && !order.etiqueta_zpl) {
        aging.separated_without_label++;
      }
    }

    const dailyHistory = new Map<string, number>();
    for (let offset = -7; offset <= 0; offset++) {
      const dateKey = shiftDateKey(todayKey, offset);
      dailyHistory.set(dateKey, 0);
    }

    const hourBuckets = new Map<number, number>();
    for (let hour = 0; hour < 24; hour++) hourBuckets.set(hour, 0);

    const cycleDurations7dMin: number[] = [];
    const cycleDurations24hMin: number[] = [];
    const cycleRows = cycleRowsData ?? [];

    for (const row of cycleRows) {
      if (!row.embalagem_concluida_em) continue;

      const finishedAt = new Date(row.embalagem_concluida_em);
      const dateKey = toBrtDateKey(finishedAt);
      if (dailyHistory.has(dateKey)) {
        dailyHistory.set(dateKey, (dailyHistory.get(dateKey) ?? 0) + 1);
      }

      if (dateKey === todayKey) {
        const hour = toBrtHour(finishedAt);
        hourBuckets.set(hour, (hourBuckets.get(hour) ?? 0) + 1);
      }

      if (!row.criado_em) continue;
      const startedAt = new Date(row.criado_em);
      const durationMin = Math.round(
        (finishedAt.getTime() - startedAt.getTime()) / (1000 * 60),
      );
      if (durationMin <= 0) continue;
      cycleDurations7dMin.push(durationMin);
      if (finishedAt.toISOString() >= twentyFourHoursAgo) {
        cycleDurations24hMin.push(durationMin);
      }
    }

    const dailySeriesAll = Array.from(dailyHistory.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, count]) => ({ date, count }));
    const dailySeries = dailySeriesAll.filter((bucket) => bucket.date >= chartStartKey);
    const previous7Days = dailySeriesAll.slice(0, 7).map((bucket) => bucket.count);
    const todayTotal = dailySeriesAll[dailySeriesAll.length - 1]?.count ?? 0;
    const yesterdayTotal = dailySeriesAll[dailySeriesAll.length - 2]?.count ?? 0;
    const avgLast7d = previous7Days.length > 0
      ? Number(
          (
            previous7Days.reduce((sum, value) => sum + value, 0) /
            previous7Days.length
          ).toFixed(1),
        )
      : null;

    const brtNow = new Date(now.getTime() - BRT_OFFSET_MS);
    const elapsedHoursToday = Math.max(
      1,
      brtNow.getUTCHours() + brtNow.getUTCMinutes() / 60,
    );
    const currentPacePerHour = Number((todayTotal / elapsedHoursToday).toFixed(1));

    const throughputBuckets = Array.from(hourBuckets.entries())
      .map(([hour, count]) => ({ hour, count }))
      .sort((left, right) => left.hour - right.hour);

    const avgCycle24hMin = average(cycleDurations24hMin);
    const avgCycle7dMin = average(cycleDurations7dMin);
    const p90Cycle24hMin = percentile(cycleDurations24hMin, 0.9);

    const inProgressOrders = backlogOrders.filter(
      (order) => order.status_separacao === "em_separacao",
    );
    const workloadMap = new Map<string, number>();
    for (const order of inProgressOrders) {
      const operatorId = order.separacao_operador_id;
      const label = operatorId
        ? operatorNames.get(operatorId) ?? operatorId
        : "Sem operador";
      workloadMap.set(label, (workloadMap.get(label) ?? 0) + 1);
    }

    const operatorWorkload = Array.from(workloadMap.entries())
      .map(([name, orders]) => ({
        name,
        orders,
        share_pct: safePct(orders, inProgressOrders.length),
      }))
      .sort((left, right) => right.orders - left.orders);

    const decisionCounts = new Map<string, number>();
    for (const order of backlogOrders) {
      const key = order.decisao_final ?? "sem_decisao";
      decisionCounts.set(key, (decisionCounts.get(key) ?? 0) + 1);
    }

    const decisionLabels: Record<string, string> = {
      propria: "Própria",
      transferencia: "Transferência",
      oc: "OC",
      sem_decisao: "Sem decisão",
    };

    const decisionMix = Array.from(decisionCounts.entries())
      .map(([key, count]) => ({
        key,
        label: decisionLabels[key] ?? key,
        count,
        share_pct: safePct(count, activeBacklog),
      }))
      .sort((left, right) => right.count - left.count);

    const channelCounts = new Map<string, number>();
    for (const order of backlogOrders) {
      const channel = normalizeChannel(order.nome_ecommerce);
      channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
    }

    const channelMix = Array.from(channelCounts.entries())
      .map(([label, count]) => ({
        label,
        count,
        share_pct: safePct(count, activeBacklog),
      }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 5);

    const galpaoCounts = new Map<string, number>();
    for (const order of backlogOrders) {
      const label = order.separacao_galpao_id
        ? galpaoNameById.get(order.separacao_galpao_id) ?? "Galpão desconhecido"
        : "Sem galpão";
      galpaoCounts.set(label, (galpaoCounts.get(label) ?? 0) + 1);
    }

    const galpaoMix = Array.from(galpaoCounts.entries())
      .map(([label, count]) => ({
        label,
        count,
        share_pct: safePct(count, activeBacklog),
      }))
      .sort((left, right) => right.count - left.count);

    const topChannel = channelMix[0] ?? null;
    const topGalpao = galpaoMix[0] ?? null;
    const decisionMap = Object.fromEntries(decisionMix.map((item) => [item.key, item.count]));

    return NextResponse.json({
      server_time: nowIso,
      galpoes,

      pipeline: legacyPipeline,

      throughput: {
        buckets: throughputBuckets,
        total_today: todayTotal,
      },

      alerts: {
        stuck_nf: aging.nf_over_4h,
        stuck_separacao: aging.picking_over_2h,
        recent_errors: errorsCountResult.count ?? 0,
        error_samples: (errorSamplesData ?? []).map((sample) => ({
          source: sample.source,
          message: sample.message,
          timestamp: sample.timestamp,
        })),
      },

      kpis: {
        processed_today: todayTotal,
        pipeline_total: activeBacklog,
        avg_cycle_time_min: avgCycle24hMin,
      },

      operations: {
        summary: {
          active_backlog: activeBacklog,
          in_progress_orders: inProgressOrders.length,
          at_risk_orders: riskOrders,
          at_risk_share_pct: safePct(riskOrders, activeBacklog),
          packed_today: todayTotal,
          delta_vs_avg_7d_pct: deltaPct(todayTotal, avgLast7d),
          aged_orders:
            aging.nf_over_4h +
            aging.queue_over_6h +
            aging.picking_over_2h +
            aging.packed_over_2h,
        },
        funnel: {
          active_total: activeBacklog,
          shipped_total: shippedTotal,
          stages: funnelStages,
          bottleneck,
        },
        deadlines: {
          ...deadlines,
          risk_orders: riskOrders,
          risk_share_pct: safePct(riskOrders, activeBacklog),
          today_window_orders: todayWindowOrders,
          without_deadline_share_pct: safePct(deadlines.without_deadline, activeBacklog),
        },
        aging: {
          ...aging,
          total_aged:
            aging.nf_over_4h +
            aging.queue_over_6h +
            aging.picking_over_2h +
            aging.packed_over_2h,
        },
        throughput: {
          today_total: todayTotal,
          hourly: throughputBuckets,
          daily_last_7d: dailySeries,
          avg_last_7d: avgLast7d,
          yesterday_total: yesterdayTotal,
          delta_vs_avg_7d_pct: deltaPct(todayTotal, avgLast7d),
          delta_vs_yesterday_pct: deltaPct(todayTotal, yesterdayTotal || null),
          current_pace_per_hour: currentPacePerHour,
        },
        operators: {
          active_count: operatorIds.length,
          orders_in_progress: inProgressOrders.length,
          workload: operatorWorkload,
        },
      },

      management: {
        lead_time: {
          avg_24h_min: avgCycle24hMin,
          avg_7d_min: avgCycle7dMin,
          p90_24h_min: p90Cycle24hMin,
          delta_pct: deltaPct(avgCycle24hMin, avgCycle7dMin),
        },
        decision_mix: decisionMix,
        channel_mix: channelMix,
        galpao_mix: galpaoMix,
        concentration: {
          bottleneck_stage_key: bottleneck?.key ?? null,
          bottleneck_stage_label: bottleneck?.label ?? null,
          bottleneck_orders: bottleneck?.count ?? 0,
          bottleneck_share_pct: bottleneck?.share_pct ?? 0,
          top_channel_label: topChannel?.label ?? null,
          top_channel_share_pct: topChannel?.share_pct ?? 0,
          top_galpao_label: topGalpao?.label ?? null,
          top_galpao_share_pct: topGalpao?.share_pct ?? 0,
          external_dependency_pct: safePct(
            (decisionMap.transferencia ?? 0) + (decisionMap.oc ?? 0),
            activeBacklog,
          ),
          without_deadline_count: deadlines.without_deadline,
          without_deadline_share_pct: safePct(deadlines.without_deadline, activeBacklog),
          recent_errors: errorsCountResult.count ?? 0,
        },
      },
    });
  } catch (err) {
    logger.error("painel", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
