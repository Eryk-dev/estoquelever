"use client";

import {
  type ElementType,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Clock,
  FileWarning,
  Home,
  Layers,
  Monitor,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  ShoppingCart,
  Timer,
  TrendingUp,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface StageMetric {
  key: string;
  label: string;
  href: string;
  count: number;
  share_pct: number;
}

interface ShareMetric {
  label: string;
  count: number;
  share_pct: number;
}

export type PainelMode = "operacao" | "gerencial";

interface PainelResponse {
  server_time: string;
  client_received_at?: number;
  galpoes: { id: string; nome: string }[];
  pipeline: Record<string, number>;
  throughput: {
    buckets: { hour: number; count: number }[];
    total_today: number;
  };
  alerts: {
    stuck_nf: number;
    stuck_separacao: number;
    recent_errors: number;
    error_samples: { source: string; message: string; timestamp: string }[];
  };
  kpis: {
    processed_today: number;
    pipeline_total: number;
    avg_cycle_time_min: number | null;
  };
  operations: {
    summary: {
      active_backlog: number;
      in_progress_orders: number;
      at_risk_orders: number;
      at_risk_share_pct: number;
      packed_today: number;
      delta_vs_avg_7d_pct: number | null;
      aged_orders: number;
    };
    funnel: {
      active_total: number;
      shipped_total: number;
      stages: StageMetric[];
      bottleneck: StageMetric | null;
    };
    deadlines: {
      overdue: number;
      due_in_2h: number;
      due_today: number;
      future: number;
      without_deadline: number;
      risk_orders: number;
      risk_share_pct: number;
      today_window_orders: number;
      without_deadline_share_pct: number;
    };
    aging: {
      nf_over_4h: number;
      queue_over_6h: number;
      picking_over_2h: number;
      packed_over_2h: number;
      separated_without_label: number;
      total_aged: number;
    };
    throughput: {
      today_total: number;
      hourly: { hour: number; count: number }[];
      daily_last_7d: { date: string; count: number }[];
      avg_last_7d: number | null;
      yesterday_total: number;
      delta_vs_avg_7d_pct: number | null;
      delta_vs_yesterday_pct: number | null;
      current_pace_per_hour: number;
    };
    operators: {
      active_count: number;
      orders_in_progress: number;
      workload: { name: string; orders: number; share_pct: number }[];
    };
  };
  management: {
    lead_time: {
      avg_24h_min: number | null;
      avg_7d_min: number | null;
      p90_24h_min: number | null;
      delta_pct: number | null;
    };
    decision_mix: Array<ShareMetric & { key: string }>;
    channel_mix: ShareMetric[];
    galpao_mix: ShareMetric[];
    concentration: {
      bottleneck_stage_key: string | null;
      bottleneck_stage_label: string | null;
      bottleneck_orders: number;
      bottleneck_share_pct: number;
      top_channel_label: string | null;
      top_channel_share_pct: number;
      top_galpao_label: string | null;
      top_galpao_share_pct: number;
      external_dependency_pct: number;
      without_deadline_count: number;
      without_deadline_share_pct: number;
      recent_errors: number;
    };
  };
}

const EMPTY_RESPONSE: PainelResponse = {
  server_time: "",
  galpoes: [],
  pipeline: {},
  throughput: { buckets: [], total_today: 0 },
  alerts: { stuck_nf: 0, stuck_separacao: 0, recent_errors: 0, error_samples: [] },
  kpis: { processed_today: 0, pipeline_total: 0, avg_cycle_time_min: null },
  operations: {
    summary: {
      active_backlog: 0,
      in_progress_orders: 0,
      at_risk_orders: 0,
      at_risk_share_pct: 0,
      packed_today: 0,
      delta_vs_avg_7d_pct: null,
      aged_orders: 0,
    },
    funnel: {
      active_total: 0,
      shipped_total: 0,
      stages: [],
      bottleneck: null,
    },
    deadlines: {
      overdue: 0,
      due_in_2h: 0,
      due_today: 0,
      future: 0,
      without_deadline: 0,
      risk_orders: 0,
      risk_share_pct: 0,
      today_window_orders: 0,
      without_deadline_share_pct: 0,
    },
    aging: {
      nf_over_4h: 0,
      queue_over_6h: 0,
      picking_over_2h: 0,
      packed_over_2h: 0,
      separated_without_label: 0,
      total_aged: 0,
    },
    throughput: {
      today_total: 0,
      hourly: [],
      daily_last_7d: [],
      avg_last_7d: null,
      yesterday_total: 0,
      delta_vs_avg_7d_pct: null,
      delta_vs_yesterday_pct: null,
      current_pace_per_hour: 0,
    },
    operators: {
      active_count: 0,
      orders_in_progress: 0,
      workload: [],
    },
  },
  management: {
    lead_time: {
      avg_24h_min: null,
      avg_7d_min: null,
      p90_24h_min: null,
      delta_pct: null,
    },
    decision_mix: [],
    channel_mix: [],
    galpao_mix: [],
    concentration: {
      bottleneck_stage_key: null,
      bottleneck_stage_label: null,
      bottleneck_orders: 0,
      bottleneck_share_pct: 0,
      top_channel_label: null,
      top_channel_share_pct: 0,
      top_galpao_label: null,
      top_galpao_share_pct: 0,
      external_dependency_pct: 0,
      without_deadline_count: 0,
      without_deadline_share_pct: 0,
      recent_errors: 0,
    },
  },
};

const VIEW_META: Record<
  PainelMode,
  {
    title: string;
    subtitle: string;
    boardTitle: string;
    boardSubtitle: string;
    boardIcon: typeof Monitor;
    boardTone: "ops" | "mgmt";
  }
> = {
  operacao: {
    title: "Painel Operacional",
    subtitle: "Prioridade, SLA e fluidez do galpão em tempo real",
    boardTitle: "Quadro Operacional",
    boardSubtitle:
      "Leitura do chão de operação com foco em urgência, fluxo e execução",
    boardIcon: Monitor,
    boardTone: "ops",
  },
  gerencial: {
    title: "Painel Gerencial",
    subtitle: "Produtividade, concentração e controle da carteira logística",
    boardTitle: "Quadro Gerencial",
    boardSubtitle:
      "Leitura executiva de produtividade, concentração e disciplina operacional",
    boardIcon: TrendingUp,
    boardTone: "mgmt",
  },
};

function formatCycleTime(minutes: number | null): string {
  if (minutes === null) return "--";
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}h`;
}

function formatDateLabel(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

function formatRelative(nowMs: number, iso: string): string {
  const diff = nowMs - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s atrás`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min atrás`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h atrás`;
}

function formatDelta(delta: number | null, inverse = false): {
  label: string;
  className: string;
} {
  if (delta === null) {
    return { label: "sem base", className: "text-ink-faint" };
  }

  const positiveIsGood = inverse ? delta < 0 : delta > 0;
  const neutral = delta === 0;

  return {
    label: `${delta > 0 ? "+" : ""}${delta}%`,
    className: neutral
      ? "text-ink-faint"
      : positiveIsGood
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400",
  };
}

function formatPace(value: number): string {
  return `${value.toFixed(1)}/h`;
}

function getPriorityAction(data: PainelResponse) {
  const deadlines = data.operations.deadlines;
  const aging = data.operations.aging;
  const bottleneck = data.operations.funnel.bottleneck;

  if (deadlines.overdue > 0) {
    return {
      icon: AlertTriangle,
      title: `${deadlines.overdue} pedido(s) com prazo vencido`,
      description: "A primeira prioridade é zerar atraso de expedição. Essa fila já estourou SLA.",
      href: "/separacao",
      cta: "Abrir operação",
      panelClassName:
        "border-red-200 bg-red-50/90 dark:border-red-900/60 dark:bg-red-950/20",
      iconClassName:
        "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
    };
  }

  if (deadlines.due_in_2h > 0) {
    return {
      icon: Truck,
      title: `${deadlines.due_in_2h} pedido(s) vencem nas próximas 2h`,
      description: "A janela crítica do despacho está aberta. Vale puxar a fila mais próxima da expedição.",
      href: "/separacao",
      cta: "Priorizar despacho",
      panelClassName:
        "border-amber-200 bg-amber-50/90 dark:border-amber-900/60 dark:bg-amber-950/20",
      iconClassName:
        "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
    };
  }

  if (aging.packed_over_2h > 0) {
    return {
      icon: Truck,
      title: `${aging.packed_over_2h} pedido(s) embalado(s) aguardando expedição`,
      description: "Há volume parado no fim do fluxo. O gargalo já saiu do picking e está no despacho.",
      href: "/separacao?tab=embalado",
      cta: "Abrir embalados",
      panelClassName:
        "border-orange-200 bg-orange-50/90 dark:border-orange-900/60 dark:bg-orange-950/20",
      iconClassName:
        "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300",
    };
  }

  if (aging.nf_over_4h > 0) {
    return {
      icon: FileWarning,
      title: `${aging.nf_over_4h} pedido(s) travado(s) em NF`,
      description: "Antes de puxar mais carga para o galpão, vale destravar o que ainda depende de nota fiscal.",
      href: "/separacao?tab=aguardando_nf",
      cta: "Abrir NF",
      panelClassName:
        "border-violet-200 bg-violet-50/90 dark:border-violet-900/60 dark:bg-violet-950/20",
      iconClassName:
        "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
    };
  }

  if (aging.picking_over_2h > 0) {
    return {
      icon: Timer,
      title: `${aging.picking_over_2h} separação(ões) aberta(s) há mais de 2h`,
      description: "O fluxo perdeu cadência no chão. Retomar o que está aberto evita acúmulo invisível.",
      href: "/separacao?tab=em_separacao",
      cta: "Retomar separação",
      panelClassName:
        "border-sky-200 bg-sky-50/90 dark:border-sky-900/60 dark:bg-sky-950/20",
      iconClassName:
        "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
    };
  }

  if (bottleneck && bottleneck.count > 0) {
    return {
      icon: Layers,
      title: `${bottleneck.count} pedido(s) concentrados em ${bottleneck.label}`,
      description: "Sem urgência crítica de SLA no momento. O próximo ganho vem de aliviar a etapa mais carregada.",
      href: bottleneck.href,
      cta: `Abrir ${bottleneck.label}`,
      panelClassName:
        "border-blue-200 bg-blue-50/90 dark:border-blue-900/60 dark:bg-blue-950/20",
      iconClassName:
        "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
    };
  }

  return {
    icon: PackageCheck,
    title: "Fluxo estabilizado",
    description: "Sem fila crítica no momento. O painel agora serve mais para manter ritmo e disciplina.",
    href: "/separacao",
    cta: "Abrir operação",
    panelClassName:
      "border-emerald-200 bg-emerald-50/90 dark:border-emerald-900/60 dark:bg-emerald-950/20",
    iconClassName:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  };
}

export function PainelScreen({ mode }: { mode: PainelMode }) {
  const { user, loading, activeGalpaoId, setActiveGalpao } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const channelRef = useRef<RealtimeChannel | null>(null);
  const viewMeta = VIEW_META[mode];
  const isOperational = mode === "operacao";

  const [clockTime, setClockTime] = useState(new Date());

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  useEffect(() => {
    const interval = setInterval(() => setClockTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("painel_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "siso_pedidos" },
        () => queryClient.invalidateQueries({ queryKey: ["painel"] }),
      )
      .subscribe();
    channelRef.current = channel;
    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [queryClient]);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (activeGalpaoId) params.set("galpao_id", activeGalpaoId);
    return params.toString();
  }, [activeGalpaoId]);

  const {
    data: queryData,
    isFetching,
    error,
    refetch,
  } = useQuery<PainelResponse>({
    queryKey: ["painel", queryParams],
    queryFn: async () => {
      const url = queryParams ? `/api/painel?${queryParams}` : "/api/painel";
      const clientReceivedAt = Date.now();
      const res = await sisoFetch(url);
      if (!res.ok) throw new Error("Falha ao carregar painel");
      const json = await res.json();
      return {
        ...json,
        client_received_at: clientReceivedAt,
      };
    },
    enabled: !loading && !!user,
    refetchInterval: 30_000,
  });

  const data = queryData ?? EMPTY_RESPONSE;
  const priorityAction = useMemo(() => getPriorityAction(data), [data]);

  const clockDisplay = !data.server_time || !data.client_received_at
    ? clockTime.toLocaleTimeString("pt-BR", { hour12: false })
    : new Date(
        clockTime.getTime() +
          (new Date(data.server_time).getTime() - data.client_received_at),
      ).toLocaleTimeString("pt-BR", { hour12: false });

  const operationalCards = [
    {
      label: "Backlog ativo",
      value: data.operations.summary.active_backlog,
      sub:
        data.operations.funnel.bottleneck && data.operations.funnel.bottleneck.count > 0
          ? `Gargalo em ${data.operations.funnel.bottleneck.label}`
          : "Sem gargalo dominante",
      icon: Layers,
      tone: "sky",
    },
    {
      label: "Risco de SLA",
      value: data.operations.summary.at_risk_orders,
      sub: `${data.operations.summary.at_risk_share_pct}% da carteira`,
      icon: Truck,
      tone: data.operations.summary.at_risk_orders > 0 ? "red" : "emerald",
    },
    {
      label: "Em execução",
      value: data.operations.summary.in_progress_orders,
      sub: `${data.operations.operators.active_count} operador(es) ativos`,
      icon: Activity,
      tone: "amber",
    },
    {
      label: "Embalados hoje",
      value: data.operations.summary.packed_today,
      sub:
        data.operations.summary.delta_vs_avg_7d_pct === null
          ? "Sem histórico comparável"
          : `${formatDelta(data.operations.summary.delta_vs_avg_7d_pct).label} vs média 7d`,
      icon: PackageCheck,
      tone:
        data.operations.summary.delta_vs_avg_7d_pct !== null &&
        data.operations.summary.delta_vs_avg_7d_pct < 0
          ? "red"
          : "emerald",
    },
  ] as const;

  const managementCards = [
    {
      label: "Ritmo vs média 7d",
      value:
        data.operations.throughput.delta_vs_avg_7d_pct === null
          ? "--"
          : `${data.operations.throughput.delta_vs_avg_7d_pct > 0 ? "+" : ""}${data.operations.throughput.delta_vs_avg_7d_pct}%`,
      sub: `${data.operations.throughput.today_total} hoje vs ${data.operations.throughput.avg_last_7d ?? 0}/dia`,
      icon: TrendingUp,
      tone:
        data.operations.throughput.delta_vs_avg_7d_pct !== null &&
        data.operations.throughput.delta_vs_avg_7d_pct < 0
          ? "red"
          : "emerald",
    },
    {
      label: "Lead time 24h",
      value: formatCycleTime(data.management.lead_time.avg_24h_min),
      sub:
        data.management.lead_time.delta_pct === null
          ? "Sem base histórica"
          : `${formatDelta(data.management.lead_time.delta_pct, true).label} vs média 7d`,
      icon: Clock,
      tone:
        data.management.lead_time.delta_pct !== null &&
        data.management.lead_time.delta_pct > 0
          ? "red"
          : "emerald",
    },
    {
      label: "Dependência externa",
      value: `${data.management.concentration.external_dependency_pct}%`,
      sub: "Transferência + OC na carteira",
      icon: ShoppingCart,
      tone:
        data.management.concentration.external_dependency_pct >= 35
          ? "amber"
          : "sky",
    },
    {
      label: "Sem prazo de envio",
      value: data.management.concentration.without_deadline_count,
      sub: `${data.management.concentration.without_deadline_share_pct}% sem SLA explícito`,
      icon: ShieldAlert,
      tone:
        data.management.concentration.without_deadline_count > 0
          ? "amber"
          : "emerald",
    },
  ] as const;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-faint border-t-ink" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-faint transition-colors hover:bg-surface hover:text-ink"
            title="Início"
          >
            <Home className="h-4 w-4" />
          </Link>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-bold tracking-tight text-ink sm:text-base">
              {viewMeta.title}
            </h1>
            <p className="truncate text-[11px] text-ink-faint sm:text-xs">
              {viewMeta.subtitle}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <PainelNavLink
                href="/painel/operacao"
                active={mode === "operacao"}
                label="Operação"
              />
              <PainelNavLink
                href="/painel/gerencial"
                active={mode === "gerencial"}
                label="Gerencial"
              />
            </div>
          </div>

          {data.galpoes.length > 1 && (
            <div className="hidden items-center gap-1 md:flex">
              {[{ id: "", nome: "Todos" }, ...data.galpoes].map((galpao) => (
                <button
                  key={galpao.id}
                  type="button"
                  onClick={() => setActiveGalpao(galpao.id || null)}
                  className={cn(
                    "rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors",
                    (activeGalpaoId ?? "") === galpao.id
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-ink-faint hover:bg-surface hover:text-ink",
                  )}
                >
                  {galpao.nome}
                </button>
              ))}
            </div>
          )}

          <div className="hidden shrink-0 font-mono text-sm font-bold tabular-nums text-ink sm:block">
            {clockDisplay}
          </div>

          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            Atualizar
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-5">
        {error && (
          <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error instanceof Error ? error.message : "Erro ao carregar painel"}
          </div>
        )}

        {data.galpoes.length > 1 && (
          <section className="rounded-2xl border border-line bg-paper px-3 py-3 md:hidden">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
              Filtro de galpão
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {[{ id: "", nome: "Todos" }, ...data.galpoes].map((galpao) => (
                <button
                  key={galpao.id}
                  type="button"
                  onClick={() => setActiveGalpao(galpao.id || null)}
                  className={cn(
                    "shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors",
                    (activeGalpaoId ?? "") === galpao.id
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-surface text-ink-faint hover:text-ink",
                  )}
                >
                  {galpao.nome}
                </button>
              ))}
            </div>
          </section>
        )}

        <BoardShell
          title={viewMeta.boardTitle}
          subtitle={viewMeta.boardSubtitle}
          icon={viewMeta.boardIcon}
          tone={viewMeta.boardTone}
        >
          {isOperational ? (
            <OperacaoContent
              data={data}
              clockTime={clockTime}
              operationalCards={operationalCards}
              priorityAction={priorityAction}
            />
          ) : (
            <GerencialContent
              data={data}
              clockTime={clockTime}
              managementCards={managementCards}
            />
          )}
        </BoardShell>
      </main>
    </div>
  );
}

function PainelNavLink({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors",
        active
          ? "bg-ink text-paper"
          : "bg-surface text-ink-faint hover:text-ink",
      )}
    >
      {label}
    </Link>
  );
}

function OperacaoContent({
  data,
  clockTime,
  operationalCards,
  priorityAction,
}: {
  data: PainelResponse;
  clockTime: Date;
  operationalCards: ReadonlyArray<{
    label: string;
    value: string | number;
    sub: string;
    icon: ElementType;
    tone: "sky" | "emerald" | "amber" | "red";
  }>;
  priorityAction: ReturnType<typeof getPriorityAction>;
}) {
  return (
    <>
      <section className={cn("rounded-2xl border p-4", priorityAction.panelClassName)}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
                priorityAction.iconClassName,
              )}
            >
              <priorityAction.icon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-faint">
                Prioridade do turno
              </p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink">
                {priorityAction.title}
              </h2>
              <p className="mt-1 text-sm text-ink-muted">
                {priorityAction.description}
              </p>
            </div>
          </div>

          <Link
            href={priorityAction.href}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-xs font-semibold text-paper transition-opacity hover:opacity-90"
          >
            {priorityAction.cta}
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {operationalCards.map((card) => (
          <MetricCard
            key={card.label}
            label={card.label}
            value={card.value}
            sub={card.sub}
            icon={card.icon}
            tone={card.tone}
          />
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Funil operacional"
          subtitle="Onde a carteira está acumulando agora"
          right={`Expedido: ${data.operations.funnel.shipped_total}`}
        >
          <StageList
            items={data.operations.funnel.stages}
            highlightKey={data.operations.funnel.bottleneck?.key ?? null}
          />
        </SectionCard>

        <SectionCard
          title="Janela de SLA"
          subtitle="Prioridade de despacho por prazo de envio"
          right={`${data.operations.deadlines.today_window_orders} dentro da janela do dia`}
        >
          <DeadlineList
            items={[
              {
                label: "Vencido",
                count: data.operations.deadlines.overdue,
                tone: "red",
              },
              {
                label: "Vence em 2h",
                count: data.operations.deadlines.due_in_2h,
                tone: "amber",
              },
              {
                label: "Ainda hoje",
                count: data.operations.deadlines.due_today,
                tone: "sky",
              },
              {
                label: "Futuro",
                count: data.operations.deadlines.future,
                tone: "emerald",
              },
              {
                label: "Sem prazo",
                count: data.operations.deadlines.without_deadline,
                tone: "slate",
              },
            ]}
            total={data.operations.funnel.active_total}
          />
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Filas envelhecidas"
          subtitle="Pedidos que perderam cadência dentro da própria etapa"
          right={`${data.operations.aging.total_aged} pontos de atenção`}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <AlertMetric
              label="NF > 4h"
              value={data.operations.aging.nf_over_4h}
              tone="violet"
            />
            <AlertMetric
              label="Fila pronta > 6h"
              value={data.operations.aging.queue_over_6h}
              tone="sky"
            />
            <AlertMetric
              label="Separação > 2h"
              value={data.operations.aging.picking_over_2h}
              tone="amber"
            />
            <AlertMetric
              label="Embalado > 2h"
              value={data.operations.aging.packed_over_2h}
              tone="orange"
            />
          </div>

          <div className="mt-3 rounded-xl border border-line bg-surface px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
              Qualidade do fluxo
            </p>
            <p className="mt-1 text-sm text-ink-muted">
              {data.operations.aging.separated_without_label} separado(s) sem etiqueta pronta
            </p>
          </div>
        </SectionCard>

        <SectionCard
          title="Ritmo do dia"
          subtitle="Embalados por hora no dia corrente"
          right={`${formatPace(data.operations.throughput.current_pace_per_hour)} no turno`}
        >
          <HourlyChart
            buckets={data.operations.throughput.hourly}
            currentHour={new Date(clockTime.getTime() - 3 * 60 * 60 * 1000).getUTCHours()}
          />

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <InlineMetric
              label="Hoje"
              value={data.operations.throughput.today_total}
            />
            <InlineMetric
              label="Ontem"
              value={data.operations.throughput.yesterday_total}
            />
            <InlineMetric
              label="Média 7d"
              value={data.operations.throughput.avg_last_7d ?? 0}
            />
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Carga por operador"
        subtitle="Distribuição dos pedidos em separação agora"
        right={`${data.operations.operators.orders_in_progress} pedidos em execução`}
      >
        <ShareList
          items={data.operations.operators.workload.map((item) => ({
            label: item.name,
            count: item.orders,
            share_pct: item.share_pct,
          }))}
          emptyMessage="Nenhuma separação em andamento."
          accent="bg-sky-500"
        />
      </SectionCard>
    </>
  );
}

function GerencialContent({
  data,
  clockTime,
  managementCards,
}: {
  data: PainelResponse;
  clockTime: Date;
  managementCards: ReadonlyArray<{
    label: string;
    value: string | number;
    sub: string;
    icon: ElementType;
    tone: "sky" | "emerald" | "amber" | "red";
  }>;
}) {
  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {managementCards.map((card) => (
          <MetricCard
            key={card.label}
            label={card.label}
            value={card.value}
            sub={card.sub}
            icon={card.icon}
            tone={card.tone}
          />
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Produtividade dos últimos 7 dias"
          subtitle="Embalo diário para comparar fôlego do fluxo"
          right={
            data.operations.throughput.delta_vs_avg_7d_pct === null
              ? "Sem base"
              : `${formatDelta(data.operations.throughput.delta_vs_avg_7d_pct).label} hoje`
          }
        >
          <DailyTrendChart buckets={data.operations.throughput.daily_last_7d} />
        </SectionCard>

        <SectionCard
          title="Lead time"
          subtitle="Do pedido criado até o pacote finalizar a embalagem"
          right={
            data.management.lead_time.delta_pct === null
              ? "Sem comparação"
              : `${formatDelta(data.management.lead_time.delta_pct, true).label} vs 7d`
          }
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricPill
              label="Média 24h"
              value={formatCycleTime(data.management.lead_time.avg_24h_min)}
            />
            <MetricPill
              label="Média 7d"
              value={formatCycleTime(data.management.lead_time.avg_7d_min)}
            />
            <MetricPill
              label="P90 24h"
              value={formatCycleTime(data.management.lead_time.p90_24h_min)}
            />
          </div>

          <p className="mt-3 text-sm text-ink-muted">
            O P90 mostra quanto tempo leva para fechar os casos mais lentos. Ele ajuda a enxergar instabilidade mesmo quando a média parece boa.
          </p>
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Mix por decisão"
          subtitle="Quanto da carteira depende da própria operação, transferência ou compra"
        >
          <ShareList
            items={data.management.decision_mix}
            emptyMessage="Sem pedidos com decisão registrada."
            accent="bg-amber-500"
          />
        </SectionCard>

        <SectionCard
          title="Mix por canal"
          subtitle="Concentração da demanda por marketplace"
          right={
            data.management.concentration.top_channel_label
              ? `${data.management.concentration.top_channel_label} ${data.management.concentration.top_channel_share_pct}%`
              : "Sem canal dominante"
          }
        >
          <ShareList
            items={data.management.channel_mix}
            emptyMessage="Sem canal ativo."
            accent="bg-indigo-500"
          />
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Carga por galpão"
          subtitle="Onde a carteira está fisicamente concentrada"
          right={
            data.management.concentration.top_galpao_label
              ? `${data.management.concentration.top_galpao_label} ${data.management.concentration.top_galpao_share_pct}%`
              : "Sem concentração"
          }
        >
          <ShareList
            items={data.management.galpao_mix}
            emptyMessage="Sem galpão definido."
            accent="bg-emerald-500"
          />
        </SectionCard>

        <SectionCard
          title="Disciplina operacional"
          subtitle="Indicadores que evitam leitura falsa de performance"
        >
          <div className="space-y-3">
            <DisciplineRow
              label="Concentração no gargalo"
              value={
                data.management.concentration.bottleneck_stage_label
                  ? `${data.management.concentration.bottleneck_stage_label} · ${data.management.concentration.bottleneck_share_pct}%`
                  : "Sem gargalo"
              }
            />
            <DisciplineRow
              label="Pedidos sem prazo"
              value={`${data.management.concentration.without_deadline_count} (${data.management.concentration.without_deadline_share_pct}%)`}
            />
            <DisciplineRow
              label="Erros na última hora"
              value={String(data.management.concentration.recent_errors)}
            />
          </div>

          {data.alerts.error_samples.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
                  Estabilidade da integração
                </p>
                <Link
                  href="/monitoramento"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-muted transition-colors hover:text-ink"
                >
                  Ver técnico
                  <ChevronRight className="h-3 w-3" />
                </Link>
              </div>

              <div className="space-y-2">
                {data.alerts.error_samples.map((sample, index) => (
                  <div
                    key={`${sample.source}-${index}`}
                    className="rounded-xl border border-line bg-surface px-3 py-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-red-600 dark:bg-red-950/40 dark:text-red-400">
                        {sample.source}
                      </span>
                      <span className="text-[10px] text-ink-faint">
                        {formatRelative(clockTime.getTime(), sample.timestamp)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">
                      {sample.message}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}

function BoardShell({
  title,
  subtitle,
  icon: Icon,
  tone,
  children,
}: {
  title: string;
  subtitle: string;
  icon: ElementType;
  tone: "ops" | "mgmt";
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-[28px] border p-4 shadow-sm sm:p-5",
        tone === "ops"
          ? "border-sky-200 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,250,252,0.96))] dark:border-sky-900/50 dark:bg-zinc-950"
          : "border-amber-200 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.15),transparent_36%),linear-gradient(180deg,rgba(255,255,255,0.98),rgba(255,251,235,0.96))] dark:border-amber-900/50 dark:bg-zinc-950",
      )}
    >
      <div className="mb-4 flex items-start gap-3">
        <div
          className={cn(
            "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
            tone === "ops"
              ? "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
              : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-ink">
            {title}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            {subtitle}
          </p>
        </div>
      </div>

      <div className="space-y-4">{children}</div>
    </section>
  );
}

function SectionCard({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle: string;
  right?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-paper/90 p-4 dark:bg-zinc-900/80">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="mt-1 text-xs text-ink-faint">{subtitle}</p>
        </div>
        {right && (
          <span className="shrink-0 rounded-full bg-surface px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
            {right}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function MetricCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  sub: string;
  icon: ElementType;
  tone: "sky" | "emerald" | "amber" | "red";
}) {
  const toneStyles = {
    sky: "bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300",
    emerald: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
    red: "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300",
  }[tone];

  return (
    <div className="rounded-2xl border border-line bg-paper/90 p-4 dark:bg-zinc-900/80">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        <span className={cn("inline-flex h-8 w-8 items-center justify-center rounded-xl", toneStyles)}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-3 font-mono text-3xl font-bold tracking-tight tabular-nums text-ink">
        {value}
      </p>
      <p className="mt-1 text-[11px] text-ink-faint">{sub}</p>
    </div>
  );
}

function StageList({
  items,
  highlightKey,
}: {
  items: StageMetric[];
  highlightKey: string | null;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-ink-faint">Nenhum estágio em andamento.</p>;
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          className={cn(
            "block rounded-xl border px-3 py-3 transition-colors hover:bg-surface",
            item.key === highlightKey
              ? "border-amber-300 bg-amber-50/80 dark:border-amber-900/60 dark:bg-amber-950/20"
              : "border-line bg-paper/60",
          )}
        >
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-sm font-semibold text-ink">
                  {item.label}
                </span>
                <span className="font-mono text-sm font-bold tabular-nums text-ink">
                  {item.count}
                </span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-surface">
                <div
                  className={cn(
                    "h-full rounded-full",
                    item.key === highlightKey ? "bg-amber-500" : "bg-sky-500",
                  )}
                  style={{ width: `${Math.max(item.share_pct, item.count > 0 ? 6 : 0)}%` }}
                />
              </div>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                {item.share_pct}%
              </p>
              <ChevronRight className="ml-auto mt-1 h-4 w-4 text-ink-faint" />
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function DeadlineList({
  items,
  total,
}: {
  items: { label: string; count: number; tone: string }[];
  total: number;
}) {
  const toneMap: Record<string, string> = {
    red: "bg-red-500",
    amber: "bg-amber-500",
    sky: "bg-sky-500",
    emerald: "bg-emerald-500",
    slate: "bg-zinc-400",
  };

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const share = total > 0 ? Math.round((item.count / total) * 100) : 0;
        return (
          <div key={item.label} className="rounded-xl border border-line bg-paper/60 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-ink">{item.label}</span>
                  <span className="font-mono text-sm font-bold tabular-nums text-ink">
                    {item.count}
                  </span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-surface">
                  <div
                    className={cn("h-full rounded-full", toneMap[item.tone] ?? "bg-zinc-400")}
                    style={{ width: `${Math.max(share, item.count > 0 ? 6 : 0)}%` }}
                  />
                </div>
              </div>
              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                {share}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AlertMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "violet" | "sky" | "amber" | "orange";
}) {
  const toneStyles = {
    violet: "bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300",
    sky: "bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
    orange: "bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300",
  }[tone];

  return (
    <div className={cn("rounded-xl px-3 py-3", toneStyles)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em]">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function HourlyChart({
  buckets,
  currentHour,
}: {
  buckets: { hour: number; count: number }[];
  currentHour: number;
}) {
  const max = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const visible = buckets.slice(Math.max(0, currentHour - 9), currentHour + 1);

  if (visible.length === 0) {
    return <p className="text-sm text-ink-faint">Nenhum volume no dia.</p>;
  }

  return (
    <div>
      <div className="flex h-32 items-end gap-2">
        {visible.map((bucket) => {
          const height = Math.max((bucket.count / max) * 100, bucket.count > 0 ? 8 : 2);
          const isCurrent = bucket.hour === currentHour;
          return (
            <div key={bucket.hour} className="flex flex-1 flex-col items-center gap-2">
              <span className="text-[10px] font-semibold text-ink-faint">
                {bucket.count}
              </span>
              <div className="flex h-full w-full items-end rounded-t-xl bg-surface px-1">
                <div
                  className={cn(
                    "w-full rounded-t-xl",
                    isCurrent ? "bg-sky-600" : "bg-sky-400/80 dark:bg-sky-500/70",
                  )}
                  style={{ height: `${height}%` }}
                />
              </div>
              <span className="text-[10px] text-ink-faint">{formatHour(bucket.hour)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DailyTrendChart({
  buckets,
}: {
  buckets: { date: string; count: number }[];
}) {
  const max = Math.max(...buckets.map((bucket) => bucket.count), 1);

  if (buckets.length === 0) {
    return <p className="text-sm text-ink-faint">Sem histórico recente.</p>;
  }

  return (
    <div className="flex h-36 items-end gap-3">
      {buckets.map((bucket, index) => {
        const height = Math.max((bucket.count / max) * 100, bucket.count > 0 ? 8 : 2);
        const isToday = index === buckets.length - 1;
        return (
          <div key={bucket.date} className="flex flex-1 flex-col items-center gap-2">
            <span className="text-[10px] font-semibold text-ink-faint">{bucket.count}</span>
            <div className="flex h-full w-full items-end rounded-t-xl bg-surface px-1">
              <div
                className={cn(
                  "w-full rounded-t-xl",
                  isToday ? "bg-amber-500" : "bg-amber-300/90 dark:bg-amber-500/70",
                )}
                style={{ height: `${height}%` }}
              />
            </div>
            <span className="text-[10px] text-ink-faint">{formatDateLabel(bucket.date)}</span>
          </div>
        );
      })}
    </div>
  );
}

function InlineMetric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">{label}</p>
      <p className="mt-1 font-mono text-lg font-bold tabular-nums text-ink">{value}</p>
    </div>
  );
}

function MetricPill({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-3">
      <p className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">{label}</p>
      <p className="mt-1 text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

function ShareList({
  items,
  emptyMessage,
  accent,
}: {
  items: ShareMetric[];
  emptyMessage: string;
  accent: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-ink-faint">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl border border-line bg-paper/60 px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
              {item.label}
            </span>
            <span className="font-mono text-sm font-bold tabular-nums text-ink">
              {item.count}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-2 flex-1 rounded-full bg-surface">
              <div
                className={cn("h-full rounded-full", accent)}
                style={{ width: `${Math.max(item.share_pct, item.count > 0 ? 6 : 0)}%` }}
              />
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              {item.share_pct}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DisciplineRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
      <span className="text-sm text-ink-muted">{label}</span>
      <span className="text-sm font-semibold text-ink">{value}</span>
    </div>
  );
}
