"use client";

import { type ElementType, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Layers3,
  LogOut,
  Monitor,
  PackageSearch,
  Settings,
  ShoppingCart,
} from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { GalpaoSelector } from "@/components/galpao-selector";
import { cn } from "@/lib/utils";

interface Module {
  id: string;
  href: string;
  title: string;
  subtitle: string;
  description: string;
  cta: string;
  icon: typeof ClipboardList;
  color: string;
}

const MODULES: Module[] = [
  {
    id: "siso",
    href: "/siso",
    title: "SISO",
    subtitle: "Decisão entre filiais",
    description:
      "Analise pedidos pendentes e valide rapidamente quando separar na própria filial, transferir ou comprar.",
    cta: "Abrir pendências",
    icon: ClipboardList,
    color: "var(--color-info)",
  },
  {
    id: "separacao",
    href: "/separacao",
    title: "Separação",
    subtitle: "Fila do galpão",
    description:
      "Inicie, retome e finalize a separação física com leitura clara do estágio atual e próximo passo.",
    cta: "Entrar na fila",
    icon: PackageSearch,
    color: "var(--color-positive)",
  },
  {
    id: "compras",
    href: "/compras",
    title: "Compras",
    subtitle: "Reposição imediata",
    description:
      "Concentre pedidos sem estoque por fornecedor e reduza o tempo até a criação da ordem de compra.",
    cta: "Ver compras",
    icon: ShoppingCart,
    color: "var(--color-warning)",
  },
  {
    id: "painel",
    href: "/painel",
    title: "Painel",
    subtitle: "Torre de controle",
    description:
      "Visualize gargalos, throughput e alertas para direcionar a operação sem depender de interpretação manual.",
    cta: "Abrir torre",
    icon: Monitor,
    color: "var(--color-danger)",
  },
];

interface DashboardCounts {
  siso: number;
  separacao: number;
  compras: number;
}

interface OverviewResponse {
  pipeline: Record<string, number>;
  alerts: {
    stuck_nf: number;
    stuck_separacao: number;
    recent_errors: number;
  };
  kpis: {
    processed_today: number;
    pipeline_total: number;
    avg_cycle_time_min: number | null;
  };
}

interface PriorityAction {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  cta: string;
  count: number;
  tone: "danger" | "warning" | "info" | "success";
}

const STAGE_LABELS: Record<string, string> = {
  aguardando_compra: "Compras",
  aguardando_nf: "Aguardando NF",
  aguardando_separacao: "Aguardando separação",
  em_separacao: "Em separação",
  separado: "Separados",
  embalado: "Embalados",
};

const STAGE_LINKS: Record<string, string> = {
  aguardando_compra: "/separacao?tab=aguardando_compra",
  aguardando_nf: "/separacao?tab=aguardando_nf",
  aguardando_separacao: "/separacao?tab=aguardando_separacao",
  em_separacao: "/separacao?tab=em_separacao",
  separado: "/separacao?tab=separado",
  embalado: "/separacao?tab=embalado",
};

function formatCycleTime(minutes: number | null): string {
  if (minutes === null) return "--";
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function getModuleCount(
  moduleId: Module["id"],
  counts: DashboardCounts | null,
  overview: OverviewResponse | null,
): number | null {
  if (moduleId === "painel") {
    return overview?.kpis.pipeline_total ?? null;
  }

  return counts?.[moduleId as keyof DashboardCounts] ?? null;
}

function getPriorityAction(overview: OverviewResponse | null): PriorityAction {
  if (!overview) {
    return {
      eyebrow: "Central operacional",
      title: "Carregando prioridades da operação",
      description: "Buscando filas e alertas para recomendar a próxima ação.",
      href: "/painel",
      cta: "Abrir painel",
      count: 0,
      tone: "info",
    };
  }

  if (overview.alerts.stuck_nf > 0) {
    return {
      eyebrow: "Ação imediata",
      title: `${overview.alerts.stuck_nf} pedido(s) presos em NF`,
      description: "Há pedidos aguardando nota fiscal há mais de 4 horas. Essa fila precisa ser destravada primeiro.",
      href: "/separacao?tab=aguardando_nf",
      cta: "Abrir aguardando NF",
      count: overview.alerts.stuck_nf,
      tone: "danger",
    };
  }

  if (overview.alerts.stuck_separacao > 0) {
    return {
      eyebrow: "Ação imediata",
      title: `${overview.alerts.stuck_separacao} pedido(s) travados em separação`,
      description: "A operação tem pedidos em separação há mais de 2 horas. Vale retomar essa fila antes de puxar novos.",
      href: "/separacao?tab=em_separacao",
      cta: "Retomar separação",
      count: overview.alerts.stuck_separacao,
      tone: "warning",
    };
  }

  const rankedStages = Object.entries(overview.pipeline)
    .filter(([stage]) => stage !== "embalado")
    .sort(([, leftCount], [, rightCount]) => rightCount - leftCount);

  const [topStage, topCount = 0] = rankedStages[0] ?? [];
  if (topStage && topCount > 0) {
    return {
      eyebrow: "Próxima prioridade",
      title: `${topCount} pedido(s) em ${STAGE_LABELS[topStage] ?? topStage}`,
      description: "A home agora aponta a fila mais carregada para reduzir a decisão manual de onde começar.",
      href: STAGE_LINKS[topStage] ?? "/separacao",
      cta: `Abrir ${STAGE_LABELS[topStage] ?? topStage}`,
      count: topCount,
      tone: "info",
    };
  }

  return {
    eyebrow: "Operação estabilizada",
    title: "Nenhuma fila crítica no momento",
    description: "Os principais estágios estão sem acúmulo relevante. Use o painel para acompanhar o fluxo completo.",
    href: "/painel",
    cta: "Abrir torre de controle",
    count: overview.kpis.pipeline_total,
    tone: "success",
  };
}

export default function HomePage() {
  const {
    user,
    loading,
    logout,
    activeGalpaoId,
    activeGalpaoNome,
  } = useAuth();
  const router = useRouter();
  const [counts, setCounts] = useState<DashboardCounts | null>(null);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function fetchHomeData() {
      try {
        const overviewPath = activeGalpaoId
          ? `/api/painel?galpao_id=${activeGalpaoId}`
          : "/api/painel";

        const [countsRes, overviewRes] = await Promise.all([
          sisoFetch("/api/dashboard/counts"),
          sisoFetch(overviewPath),
        ]);

        if (!cancelled && countsRes.ok) {
          setCounts(await countsRes.json());
        }

        if (!cancelled && overviewRes.ok) {
          setOverview(await overviewRes.json());
        }
      } catch {
        // Silent fallback. The home still renders with partial data.
      }
    }

    fetchHomeData();
    const interval = setInterval(fetchHomeData, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user, activeGalpaoId]);

  const priorityAction = useMemo(() => getPriorityAction(overview), [overview]);
  const radarItems = useMemo(() => {
    if (!overview) return [];

    return Object.entries(overview.pipeline)
      .filter(([, count]) => count > 0)
      .sort(([, leftCount], [, rightCount]) => rightCount - leftCount)
      .slice(0, 4);
  }, [overview]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-faint border-t-ink" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#f7f7f5,transparent_48%)] bg-surface">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-sm sm:text-base font-bold tracking-tight text-ink">
              Central da Operação
            </h1>
            <p className="text-[11px] text-ink-faint">
              {activeGalpaoNome ? `Fila ativa em ${activeGalpaoNome}` : "Visão consolidada de todos os galpões"}
            </p>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {(user.cargos ?? [user.cargo]).includes("admin") && (
              <Link
                href="/configuracoes"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
                title="Configurações"
              >
                <Settings className="h-4 w-4" />
              </Link>
            )}
            <GalpaoSelector />
            <div className="hidden sm:flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
              <span className="font-mono text-xs font-semibold text-ink">
                {user.nome}
              </span>
            </div>
            <button
              type="button"
              onClick={logout}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
              title="Sair"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-3 sm:px-4 py-5 sm:py-7 space-y-5">
        <section className="overflow-hidden rounded-[28px] border border-line bg-paper shadow-sm">
          <div className="relative p-5 sm:p-6">
            <div
              className={cn(
                "absolute inset-x-0 top-0 h-28 opacity-70",
                priorityAction.tone === "danger" && "bg-[linear-gradient(135deg,rgba(239,68,68,0.14),transparent_55%)]",
                priorityAction.tone === "warning" && "bg-[linear-gradient(135deg,rgba(245,158,11,0.14),transparent_55%)]",
                priorityAction.tone === "info" && "bg-[linear-gradient(135deg,rgba(59,130,246,0.14),transparent_55%)]",
                priorityAction.tone === "success" && "bg-[linear-gradient(135deg,rgba(16,185,129,0.14),transparent_55%)]",
              )}
            />
            <div className="relative">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-ink-faint">
                <span>{priorityAction.eyebrow}</span>
                <span className="rounded-full border border-line bg-paper/80 px-2.5 py-1 tracking-normal text-ink">
                  {priorityAction.count} na fila
                </span>
              </div>
              <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-3xl">
                  <h2 className="text-2xl sm:text-[2rem] font-semibold tracking-tight text-ink">
                    {priorityAction.title}
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm sm:text-base text-ink-muted">
                    {priorityAction.description}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <HomeSignal
                      icon={Layers3}
                      label="Pipeline ativo"
                      value={overview?.kpis.pipeline_total ?? 0}
                    />
                    <HomeSignal
                      icon={AlertTriangle}
                      label="Alertas"
                      value={
                        (overview?.alerts.stuck_nf ?? 0) +
                        (overview?.alerts.stuck_separacao ?? 0) +
                        (overview?.alerts.recent_errors ?? 0)
                      }
                    />
                    <HomeSignal
                      icon={Clock3}
                      label="Tempo médio"
                      value={formatCycleTime(overview?.kpis.avg_cycle_time_min ?? null)}
                    />
                  </div>
                </div>

                <Link
                  href={priorityAction.href}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-ink px-4 py-3 text-sm font-semibold text-paper transition-transform hover:scale-[1.01]"
                >
                  {priorityAction.cta}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          </div>

          <div className="grid gap-px bg-line sm:grid-cols-3">
            <HomeMetricCard
              label="Processados hoje"
              value={overview?.kpis.processed_today ?? 0}
              helper="Pedidos finalizados no dia"
              icon={CheckCircle2}
              tone="success"
            />
            <HomeMetricCard
              label="Fila de separação"
              value={counts?.separacao ?? 0}
              helper="Pedidos aguardando, em separação ou separados"
              icon={PackageSearch}
              tone="info"
            />
            <HomeMetricCard
              label="Compras pendentes"
              value={counts?.compras ?? 0}
              helper="Itens sem estoque aguardando compra"
              icon={ShoppingCart}
              tone="warning"
            />
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
          <div className="grid gap-4 sm:grid-cols-2">
            {MODULES.map((module) => {
              const Icon = module.icon;
              const count = getModuleCount(module.id, counts, overview);
              const isPriorityModule =
                priorityAction.href.startsWith(module.href) ||
                (module.id === "painel" && priorityAction.href === "/monitoramento");

              return (
                <Link
                  key={module.id}
                  href={module.href}
                  className={cn(
                    "group relative overflow-hidden rounded-3xl border border-line bg-paper p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md",
                    isPriorityModule && "border-ink/20",
                  )}
                >
                  <div
                    className="absolute inset-x-0 top-0 h-20 opacity-0 transition-opacity group-hover:opacity-100"
                    style={{
                      background: `linear-gradient(135deg, color-mix(in srgb, ${module.color} 16%, white), transparent 60%)`,
                    }}
                  />

                  <div className="relative flex h-full flex-col gap-4">
                    <div className="flex items-start justify-between gap-3">
                      <div
                        className="flex h-11 w-11 items-center justify-center rounded-2xl"
                        style={{
                          backgroundColor: `color-mix(in srgb, ${module.color} 13%, white)`,
                          color: module.color,
                        }}
                      >
                        <Icon className="h-5 w-5" />
                      </div>

                      {count !== null && (
                        <span className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full bg-ink px-2.5 font-mono text-xs font-bold text-paper">
                          {count > 99 ? "99+" : count}
                        </span>
                      )}
                    </div>

                    <div>
                      <h2 className="text-lg font-semibold tracking-tight text-ink">
                        {module.title}
                      </h2>
                      <p className="text-sm text-ink-muted">{module.subtitle}</p>
                    </div>

                    <p className="text-sm leading-relaxed text-ink-muted">
                      {module.description}
                    </p>

                    <div className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-4">
                      <span className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-faint">
                        {module.cta}
                      </span>
                      <ArrowRight className="h-4 w-4 text-ink-faint transition-transform group-hover:translate-x-0.5" />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>

          <aside className="rounded-3xl border border-line bg-paper p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-ink-faint">
                  Radar da operação
                </p>
                <h2 className="mt-2 text-lg font-semibold text-ink">
                  Onde a fila está concentrada
                </h2>
              </div>
              <Link
                href="/painel"
                className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-line text-ink-faint transition-colors hover:bg-surface hover:text-ink"
                title="Abrir painel"
              >
                <Monitor className="h-4 w-4" />
              </Link>
            </div>

            <div className="mt-5 space-y-3">
              {radarItems.length > 0 ? (
                radarItems.map(([stage, count]) => (
                  <Link
                    key={stage}
                    href={STAGE_LINKS[stage] ?? "/separacao"}
                    className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 transition-colors hover:bg-paper"
                  >
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-paper font-mono text-sm font-bold text-ink shadow-sm">
                      {count}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink">
                        {STAGE_LABELS[stage] ?? stage}
                      </p>
                      <p className="text-xs text-ink-faint">
                        Abrir a etapa e agir diretamente na fila
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-ink-faint" />
                  </Link>
                ))
              ) : (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-700">
                  Nenhum acúmulo relevante nas filas operacionais.
                </div>
              )}
            </div>

            <div className="mt-5 rounded-2xl border border-line bg-surface px-4 py-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-500" />
                <div className="space-y-1 text-sm">
                  <p className="font-semibold text-ink">Sinal rápido</p>
                  <p className="text-ink-muted">
                    {overview?.alerts.recent_errors
                      ? `${overview.alerts.recent_errors} erro(s) recente(s) exigem acompanhamento no monitoramento.`
                      : "Sem erros recentes críticos registrados na última hora."}
                  </p>
                </div>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

function HomeSignal({
  icon: Icon,
  label,
  value,
}: {
  icon: ElementType;
  label: string;
  value: string | number;
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-paper/80 px-3 py-2 text-xs font-medium text-ink">
      <Icon className="h-3.5 w-3.5 text-ink-faint" />
      <span>{label}</span>
      <span className="font-mono font-bold text-ink">{value}</span>
    </span>
  );
}

function HomeMetricCard({
  label,
  value,
  helper,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  helper: string;
  icon: ElementType;
  tone: "success" | "info" | "warning";
}) {
  return (
    <div className="bg-paper p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink-muted">{label}</p>
          <p className="mt-2 font-mono text-3xl font-bold tracking-tight text-ink">
            {value}
          </p>
        </div>
        <div
          className={cn(
            "inline-flex h-10 w-10 items-center justify-center rounded-2xl",
            tone === "success" && "bg-emerald-50 text-emerald-600",
            tone === "info" && "bg-blue-50 text-blue-600",
            tone === "warning" && "bg-amber-50 text-amber-600",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-xs text-ink-faint">{helper}</p>
    </div>
  );
}
