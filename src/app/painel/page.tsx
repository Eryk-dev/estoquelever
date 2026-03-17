"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Home,
  Clock,
  AlertTriangle,
  Package,
  FileText,
  PackageSearch,
  PackageCheck,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PainelPedido {
  id: string;
  numero: string;
  numero_ec: string | null;
  cliente: string | null;
  forma_envio: string | null;
  status_separacao: string;
  marcadores: string[];
  empresa_nome: string | null;
  galpao_id: string | null;
  prazo_envio: string | null;
  total_itens: number;
}

interface PainelResponse {
  counts: Record<string, number>;
  pedidos: PainelPedido[];
  galpoes: { id: string; nome: string }[];
  server_time: string;
}

type UrgencyLevel = "overdue" | "urgent" | "attention" | "on_time" | "no_deadline";

interface UrgencyGroup {
  level: UrgencyLevel;
  label: string;
  color: string;
  bgClass: string;
  dotClass: string;
  pedidos: PainelPedido[];
}

// ─── Status config ──────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  string,
  { label: string; icon: typeof Clock; colorClass: string }
> = {
  aguardando_nf: {
    label: "Ag.NF",
    icon: FileText,
    colorClass: "text-amber-500",
  },
  aguardando_separacao: {
    label: "Ag.Sep",
    icon: PackageSearch,
    colorClass: "text-blue-500",
  },
  em_separacao: {
    label: "Em Sep",
    icon: Package,
    colorClass: "text-violet-500",
  },
  separado: {
    label: "Separado",
    icon: PackageCheck,
    colorClass: "text-emerald-500",
  },
  embalado: {
    label: "Embalado",
    icon: Truck,
    colorClass: "text-teal-500",
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function classifyUrgency(
  prazoEnvio: string | null,
  serverTime: string,
): UrgencyLevel {
  if (!prazoEnvio) return "no_deadline";
  const deadline = new Date(prazoEnvio).getTime();
  const now = new Date(serverTime).getTime();
  const diffH = (deadline - now) / (1000 * 60 * 60);
  if (diffH < 0) return "overdue";
  if (diffH < 2) return "urgent";
  if (diffH < 4) return "attention";
  return "on_time";
}

function formatCountdown(prazoEnvio: string, serverTime: string): string {
  const deadline = new Date(prazoEnvio).getTime();
  const now = new Date(serverTime).getTime();
  const diffMs = deadline - now;

  if (diffMs < 0) {
    const absMs = Math.abs(diffMs);
    const h = Math.floor(absMs / (1000 * 60 * 60));
    const m = Math.floor((absMs % (1000 * 60 * 60)) / (1000 * 60));
    return h > 0 ? `-${h}h ${m}min` : `-${m}min`;
  }

  const h = Math.floor(diffMs / (1000 * 60 * 60));
  const m = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

function abbreviateEcommerce(name: string | null): string {
  if (!name) return "";
  const lower = name.toLowerCase();
  if (lower.includes("mercado")) return "ML";
  if (lower.includes("shopee")) return "SH";
  if (lower.includes("magalu") || lower.includes("magazine")) return "MG";
  if (lower.includes("amazon")) return "AZ";
  if (lower.includes("shopify")) return "SF";
  return name.slice(0, 3).toUpperCase();
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function PainelPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const channelRef = useRef<RealtimeChannel | null>(null);

  const [galpaoFilter, setGalpaoFilter] = useState("");
  const [clockTime, setClockTime] = useState(new Date());
  const [serverOffset, setServerOffset] = useState(0); // ms diff: server - client

  // Redirect if not logged in
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  // Live clock (1s interval)
  useEffect(() => {
    const interval = setInterval(() => setClockTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Supabase Realtime — invalidate on pedido changes
  useEffect(() => {
    const channel = supabase
      .channel("painel_changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_pedidos",
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ["painel"] });
        },
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

  // Build query params
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (galpaoFilter) params.set("galpao_id", galpaoFilter);
    return params.toString();
  }, [galpaoFilter]);

  // Fetch data
  const { data } = useQuery<PainelResponse>({
    queryKey: ["painel", queryParams],
    queryFn: async () => {
      const url = queryParams
        ? `/api/painel?${queryParams}`
        : "/api/painel";
      const res = await sisoFetch(url);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !loading && !!user,
    refetchInterval: 10_000,
  });

  // Sync server time offset when data arrives
  useEffect(() => {
    if (data?.server_time) {
      const serverNow = new Date(data.server_time).getTime();
      const clientNow = Date.now();
      setServerOffset(serverNow - clientNow);
    }
  }, [data?.server_time]);

  // Current "server time" — client clock + offset
  const currentServerTime = useMemo(
    () => new Date(clockTime.getTime() + serverOffset).toISOString(),
    [clockTime, serverOffset],
  );

  const counts = data?.counts ?? {};
  const pedidos = data?.pedidos ?? [];
  const galpoes = data?.galpoes ?? [];

  // Group pedidos by urgency
  const urgencyGroups = useMemo((): UrgencyGroup[] => {
    const groups: Record<UrgencyLevel, PainelPedido[]> = {
      overdue: [],
      urgent: [],
      attention: [],
      on_time: [],
      no_deadline: [],
    };

    for (const p of pedidos) {
      const level = classifyUrgency(p.prazo_envio, currentServerTime);
      groups[level].push(p);
    }

    const config: Omit<UrgencyGroup, "pedidos">[] = [
      {
        level: "overdue",
        label: "Atrasados",
        color: "text-red-500",
        bgClass: "bg-red-500",
        dotClass: "bg-red-500 animate-pulse-urgent",
      },
      {
        level: "urgent",
        label: "Urgentes (< 2h)",
        color: "text-orange-500",
        bgClass: "bg-orange-500",
        dotClass: "bg-orange-500",
      },
      {
        level: "attention",
        label: "Atencao (< 4h)",
        color: "text-amber-500",
        bgClass: "bg-amber-500",
        dotClass: "bg-amber-500",
      },
      {
        level: "on_time",
        label: "No Prazo (> 4h)",
        color: "text-emerald-500",
        bgClass: "bg-emerald-500",
        dotClass: "bg-emerald-500",
      },
      {
        level: "no_deadline",
        label: "Sem Prazo",
        color: "text-zinc-400",
        bgClass: "bg-zinc-400",
        dotClass: "bg-zinc-400",
      },
    ];

    return config
      .map((c) => ({ ...c, pedidos: groups[c.level] }))
      .filter((g) => g.pedidos.length > 0);
  }, [pedidos, currentServerTime]);

  // Format clock display
  const clockDisplay = useMemo(() => {
    const brt = new Date(clockTime.getTime() + serverOffset);
    return brt.toLocaleTimeString("pt-BR", { hour12: false });
  }, [clockTime, serverOffset]);

  const getStatusBadge = useCallback(
    (status: string) => {
      const cfg = STATUS_CONFIG[status];
      if (!cfg) return null;
      const Icon = cfg.icon;
      return (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            "bg-zinc-100 dark:bg-zinc-800",
            cfg.colorClass,
          )}
        >
          <Icon className="h-2.5 w-2.5" />
          {cfg.label}
        </span>
      );
    },
    [],
  );

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
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-line bg-paper">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
          <Link
            href="/"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink shrink-0"
            title="Inicio"
          >
            <Home className="h-4 w-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm sm:text-base font-bold tracking-tight text-ink">
              Painel Operacional
            </h1>
          </div>

          {/* Galpao filter */}
          {galpoes.length > 1 && (
            <div className="flex items-center gap-1">
              {[{ id: "", nome: "Todos" }, ...galpoes].map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGalpaoFilter(g.id)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                    galpaoFilter === g.id
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-ink-faint hover:bg-surface hover:text-ink",
                  )}
                >
                  {g.nome}
                </button>
              ))}
            </div>
          )}

          {/* Clock */}
          <div className="shrink-0 font-mono text-sm font-bold tabular-nums text-ink">
            {clockDisplay}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-4 space-y-4">
        {/* Status counters bar */}
        <div className="flex flex-wrap items-center gap-2">
          {Object.entries(STATUS_CONFIG).map(([status, cfg]) => {
            const Icon = cfg.icon;
            const count = counts[status] ?? 0;
            return (
              <div
                key={status}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2",
                  count > 0 ? "opacity-100" : "opacity-50",
                )}
              >
                <Icon className={cn("h-4 w-4", cfg.colorClass)} />
                <span className="font-mono text-sm font-bold tabular-nums text-ink">
                  {count}
                </span>
                <span className="text-xs text-ink-faint">{cfg.label}</span>
              </div>
            );
          })}
        </div>

        {/* Urgency groups */}
        {urgencyGroups.length === 0 && pedidos.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <PackageCheck className="h-12 w-12 text-ink-faint" />
            <p className="mt-3 text-sm text-ink-faint">
              Nenhum pedido ativo no momento
            </p>
          </div>
        )}

        {urgencyGroups.map((group) => (
          <section key={group.level}>
            {/* Group header */}
            <div className="mb-2 flex items-center gap-2">
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  group.dotClass,
                )}
              />
              <h2 className={cn("text-xs font-bold uppercase tracking-wider", group.color)}>
                {group.label}
              </h2>
              <span className="font-mono text-xs text-ink-faint">
                ({group.pedidos.length})
              </span>
              <div className="flex-1 border-t border-line" />
            </div>

            {/* Cards grid */}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {group.pedidos.map((p) => (
                <PedidoCard
                  key={p.id}
                  pedido={p}
                  urgency={group.level}
                  serverTime={currentServerTime}
                  statusBadge={getStatusBadge(p.status_separacao)}
                />
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

// ─── Pedido Card ────────────────────────────────────────────────────────────

function PedidoCard({
  pedido,
  urgency,
  serverTime,
  statusBadge,
}: {
  pedido: PainelPedido;
  urgency: UrgencyLevel;
  serverTime: string;
  statusBadge: React.ReactNode;
}) {
  const ecAbbrv = abbreviateEcommerce(pedido.marcadores?.[0] ?? null);

  return (
    <div
      className={cn(
        "rounded-xl border bg-paper p-3 transition-colors",
        urgency === "overdue"
          ? "animate-pulse-urgent border-red-300 dark:border-red-800"
          : urgency === "urgent"
            ? "border-orange-200 dark:border-orange-800"
            : urgency === "attention"
              ? "border-amber-200 dark:border-amber-800"
              : "border-line",
      )}
    >
      {/* Row 1: Order number + ecommerce badge + status */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-bold text-ink">
          #{pedido.numero}
        </span>
        {ecAbbrv && (
          <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {ecAbbrv}
          </span>
        )}
        <div className="flex-1" />
        {statusBadge}
      </div>

      {/* Row 2: Client name */}
      <p className="mt-1 truncate text-xs text-ink-muted" title={pedido.cliente ?? ""}>
        {pedido.cliente ?? "—"}
      </p>

      {/* Row 3: Countdown + item count */}
      <div className="mt-2 flex items-center justify-between">
        {pedido.prazo_envio ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs font-semibold",
              urgency === "overdue"
                ? "text-red-600 dark:text-red-400"
                : urgency === "urgent"
                  ? "text-orange-600 dark:text-orange-400"
                  : urgency === "attention"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-emerald-600 dark:text-emerald-400",
            )}
          >
            <Clock className="h-3 w-3" />
            {formatCountdown(pedido.prazo_envio, serverTime)}
          </span>
        ) : (
          <span className="text-xs text-ink-faint">Sem prazo</span>
        )}

        <span className="text-xs text-ink-faint">
          {pedido.total_itens} {pedido.total_itens === 1 ? "item" : "itens"}
        </span>
      </div>

      {/* Row 4: Empresa + forma envio */}
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-ink-faint">
        {pedido.empresa_nome && (
          <span className="truncate font-medium">{pedido.empresa_nome}</span>
        )}
        {pedido.forma_envio && (
          <>
            <span className="text-line">•</span>
            <span className="truncate">{pedido.forma_envio}</span>
          </>
        )}
      </div>
    </div>
  );
}
