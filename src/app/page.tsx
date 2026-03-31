"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock3,
  LogOut,
  Monitor,
  PackageSearch,
  Search,
  Settings,
  ShoppingCart,
} from "lucide-react";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { GalpaoSelector } from "@/components/galpao-selector";
import { getGalpaoAccent } from "@/lib/domain-helpers";
import { cn } from "@/lib/utils";

interface Module {
  id: string;
  href: string;
  title: string;
  subtitle: string;
  icon: typeof ClipboardList;
  color: string;
  accentBg: string;
}

const MODULES: Module[] = [
  {
    id: "siso",
    href: "/siso",
    title: "SISO",
    subtitle: "Decisão entre filiais",
    icon: ClipboardList,
    color: "#3b82f6",
    accentBg: "bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400",
  },
  {
    id: "separacao",
    href: "/separacao",
    title: "Separação",
    subtitle: "Fila do galpão",
    icon: PackageSearch,
    color: "#10b981",
    accentBg: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400",
  },
  {
    id: "compras",
    href: "/compras",
    title: "Compras",
    subtitle: "Reposição imediata",
    icon: ShoppingCart,
    color: "#f59e0b",
    accentBg: "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400",
  },
  {
    id: "pedidos",
    href: "/pedidos",
    title: "Pedidos",
    subtitle: "Rastreamento universal",
    icon: Search,
    color: "#8b5cf6",
    accentBg: "bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-400",
  },
  {
    id: "painel",
    href: "/painel",
    title: "Painel",
    subtitle: "Torre de controle",
    icon: Monitor,
    color: "#ef4444",
    accentBg: "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400",
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
): number | null {
  if (moduleId === "painel" || moduleId === "pedidos") return null;
  return counts?.[moduleId as keyof DashboardCounts] ?? null;
}

export default function HomePage() {
  const { user, loading, logout, activeGalpaoId, activeGalpaoNome } = useAuth();
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
        // Silent fallback
      }
    }

    fetchHomeData();
    const interval = setInterval(fetchHomeData, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user, activeGalpaoId]);

  const alertCount = useMemo(() => {
    if (!overview) return 0;
    return overview.alerts.stuck_nf + overview.alerts.stuck_separacao;
  }, [overview]);

  const topStages = useMemo(() => {
    if (!overview) return [];
    return Object.entries(overview.pipeline)
      .filter(([stage, count]) => count > 0 && stage !== "embalado")
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);
  }, [overview]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-faint border-t-ink" />
      </div>
    );
  }

  if (!user) return null;

  const accent = getGalpaoAccent(activeGalpaoNome);

  return (
    <div className="min-h-screen bg-surface">
      <AppHeader
        title="Estoque Lever"
        subtitle={(
          <span className="flex items-center gap-1.5">
            <span className={cn("inline-block h-2 w-2 rounded-full transition-colors duration-300", accent.dot)} />
            {activeGalpaoNome ?? "Todos os galpões"}
          </span>
        )}
        accentColor={accent.color}
        rightSlot={(
          <div className="flex items-center gap-2">
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

            <div className="h-4 w-px bg-line" />

            <div className="flex items-center gap-1">
              <span className="hidden font-mono text-xs font-semibold text-ink-muted sm:inline">
                {user.nome}
              </span>
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
        )}
      />

      <main className="mx-auto max-w-5xl px-3 sm:px-4 py-3 sm:py-4 space-y-6">
        {/* ── Alert banner (only when something needs attention) ── */}
        {alertCount > 0 && (
          <Link
            href={
              overview!.alerts.stuck_nf > 0
                ? "/separacao?tab=aguardando_nf"
                : "/separacao?tab=em_separacao"
            }
            className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 transition-colors hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/50 dark:hover:bg-amber-950"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="flex-1 text-sm font-medium text-amber-800 dark:text-amber-300">
              {overview!.alerts.stuck_nf > 0
                ? `${overview!.alerts.stuck_nf} pedido(s) preso(s) em NF há mais de 4h`
                : `${overview!.alerts.stuck_separacao} pedido(s) travado(s) em separação há mais de 2h`}
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          </Link>
        )}

        {/* ── Module cards ── */}
        <div className="grid grid-cols-2 gap-3">
          {MODULES.map((mod) => {
            const Icon = mod.icon;
            const count = getModuleCount(mod.id, counts);

            return (
              <Link
                key={mod.id}
                href={mod.href}
                className="group relative flex flex-col gap-4 rounded-2xl border border-line bg-paper p-4 sm:p-5 transition-all hover:border-ink/15 hover:shadow-md active:scale-[0.98]"
              >
                <div className="flex items-center justify-between">
                  <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl", mod.accentBg)}>
                    <Icon className="h-[18px] w-[18px]" />
                  </div>
                  {count !== null && count > 0 && (
                    <span
                      className="inline-flex min-w-7 items-center justify-center rounded-full px-2 py-0.5 font-mono text-xs font-bold text-white"
                      style={{ backgroundColor: mod.color }}
                    >
                      {count > 999 ? "999+" : count}
                    </span>
                  )}
                </div>

                <div>
                  <h2 className="text-base font-semibold tracking-tight text-ink">
                    {mod.title}
                  </h2>
                  <p className="mt-0.5 text-xs text-ink-muted">{mod.subtitle}</p>
                </div>
              </Link>
            );
          })}
        </div>

        {/* ── Compact stats ── */}
        {overview && (
          <div className="flex items-center justify-center gap-6 rounded-xl border border-line bg-paper px-4 py-3">
            <Stat
              icon={CheckCircle2}
              label="Hoje"
              value={overview.kpis.processed_today}
            />
            <div className="h-4 w-px bg-line" />
            <Stat
              icon={PackageSearch}
              label="Pipeline"
              value={overview.kpis.pipeline_total}
            />
            <div className="h-4 w-px bg-line" />
            <Stat
              icon={Clock3}
              label="Ciclo"
              value={formatCycleTime(overview.kpis.avg_cycle_time_min)}
            />
          </div>
        )}

        {/* ── Pipeline stages (compact) ── */}
        {topStages.length > 0 && (
          <div className="space-y-1.5">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
              Filas ativas
            </p>
            <div className="divide-y divide-line rounded-xl border border-line bg-paper">
              {topStages.map(([stage, count]) => (
                <Link
                  key={stage}
                  href={STAGE_LINKS[stage] ?? "/separacao"}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface"
                >
                  <span className="font-mono text-sm font-bold text-ink w-10 text-right tabular-nums">
                    {count}
                  </span>
                  <span className="flex-1 text-sm text-ink-muted">
                    {STAGE_LABELS[stage] ?? stage}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-ink-faint" />
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-ink-muted">
      <Icon className="h-3.5 w-3.5 text-ink-faint" />
      <span>{label}</span>
      <span className="font-mono font-bold text-ink">{value}</span>
    </div>
  );
}
