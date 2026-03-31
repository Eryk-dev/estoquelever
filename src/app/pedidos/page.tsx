"use client";

import { Suspense, useState, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Tabs } from "@/components/ui/tabs";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { sisoFetch } from "@/lib/auth-context";
import {
  getEcommerceAbbr,
  getEcommerceColors,
  getDecisaoStripColor,
  getFilialColors,
  formatRelativeTime,
} from "@/lib/domain-helpers";
import { cn } from "@/lib/utils";
import type { Tab, Decisao } from "@/types";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TrackingPedido {
  id: string;
  numero: string;
  id_pedido_ecommerce: string;
  nome_ecommerce: string;
  cliente_nome: string;
  cliente_cpf_cnpj: string;
  data: string;
  status: string;
  status_separacao: string | null;
  sugestao: string;
  decisao_final: string | null;
  tipo_resolucao: string | null;
  operador: string | null;
  empresa_origem_nome: string | null;
  filial_origem: string | null;
  marcadores: string[];
  separacao_tags: string[];
  etiqueta_status: string | null;
  embalagem_concluida_em: string | null;
  criado_em: string;
  erro: string | null;
}

interface TrackingResponse {
  pedidos: TrackingPedido[];
  total: number;
  page: number;
  totalPages: number;
}

// ─── Status badge helpers ───────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pendente: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/60 dark:text-yellow-300",
  executando: "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
  concluido: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  cancelado: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  erro: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
};

const STATUS_SEPARACAO_COLORS: Record<string, string> = {
  aguardando_compra: "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  aguardando_nf: "bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300",
  aguardando_separacao: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  em_separacao: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/60 dark:text-cyan-300",
  separado: "bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  embalado: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
};

const DECISAO_BADGE_COLORS: Record<string, string> = {
  propria: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  transferencia: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  oc: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
};

const STATUS_SEPARACAO_LABELS: Record<string, string> = {
  aguardando_compra: "Ag. Compra",
  aguardando_nf: "Ag. NF",
  aguardando_separacao: "Ag. Separacao",
  em_separacao: "Em Separacao",
  separado: "Separado",
  embalado: "Embalado",
};

const DECISAO_LABELS: Record<string, string> = {
  propria: "Propria",
  transferencia: "Transferencia",
  oc: "OC",
};

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  } catch {
    return iso;
  }
}

/** Check if embalagem was completed more than 24h ago */
function isEmbalagemStale(embalagemConcluidaEm: string | null): boolean {
  if (!embalagemConcluidaEm) return false;
  const diff = Date.now() - new Date(embalagemConcluidaEm).getTime();
  return diff > 24 * 60 * 60 * 1000;
}

// ─── Pedido Card ────────────────────────────────────────────────────────────

function TrackingCard({ pedido, onClick }: { pedido: TrackingPedido; onClick: () => void }) {
  const ecommerceAbbr = getEcommerceAbbr(pedido.nome_ecommerce);
  const ecommerceColors = getEcommerceColors(pedido.nome_ecommerce);
  const decisao = pedido.decisao_final ?? pedido.sugestao;
  const stripColor = getDecisaoStripColor(decisao as Decisao);
  const stale = pedido.status_separacao === "embalado" && isEmbalagemStale(pedido.embalagem_concluida_em);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full overflow-hidden rounded-xl border bg-paper shadow-sm text-left",
        "border-line hover:border-zinc-300 dark:hover:border-zinc-600",
        "transition-colors duration-150",
        "animate-slide-up",
      )}
    >
      {/* Color strip */}
      <div className={cn("w-1 shrink-0", stripColor)} aria-hidden="true" />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-2.5 sm:px-4 sm:py-3">
        {/* Row 1: numero, EC, client, marketplace, galpao */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0 font-mono text-sm font-bold text-ink">
            #{pedido.numero}
          </span>
          {pedido.id_pedido_ecommerce && (
            <span className="shrink-0 font-mono text-[11px] text-ink-faint" title="Numero ecommerce">
              EC {pedido.id_pedido_ecommerce}
            </span>
          )}
          <span
            className="min-w-0 flex-1 truncate text-sm text-zinc-600 dark:text-zinc-300"
            title={pedido.cliente_nome}
          >
            {pedido.cliente_nome}
          </span>

          {/* Empresa badge */}
          {pedido.empresa_origem_nome && (
            <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-bold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {pedido.empresa_origem_nome}
            </span>
          )}

          {/* Marketplace */}
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide",
              ecommerceColors,
            )}
            title={pedido.nome_ecommerce}
          >
            {ecommerceAbbr}
          </span>

          {/* Galpao */}
          {pedido.filial_origem && (
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold",
                getFilialColors(pedido.filial_origem),
              )}
            >
              {pedido.filial_origem}
            </span>
          )}
        </div>

        {/* Row 2: status badges + date + stale warning */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Status */}
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              STATUS_COLORS[pedido.status] ?? STATUS_COLORS.pendente,
            )}
          >
            {pedido.status}
          </span>

          {/* Status separacao */}
          {pedido.status_separacao && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                STATUS_SEPARACAO_COLORS[pedido.status_separacao] ?? "bg-zinc-100 text-zinc-600",
              )}
            >
              {STATUS_SEPARACAO_LABELS[pedido.status_separacao] ?? pedido.status_separacao}
            </span>
          )}

          {/* Decisao */}
          {decisao && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                DECISAO_BADGE_COLORS[decisao] ?? "bg-zinc-100 text-zinc-600",
              )}
            >
              {DECISAO_LABELS[decisao] ?? decisao}
            </span>
          )}

          {/* Stale warning */}
          {stale && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:bg-red-950/40 dark:text-red-400"
              title="Embalado ha mais de 24h sem expedicao"
            >
              <AlertTriangle className="h-3 w-3" />
              +24h
            </span>
          )}

          {/* Date */}
          <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
            {formatDate(pedido.data)}
          </span>
        </div>
      </div>
    </button>
  );
}

// ─── Main page content ──────────────────────────────────────────────────────

function PedidosPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tab = searchParams.get("tab") ?? "pedidos";
  const page = parseInt(searchParams.get("page") ?? "1", 10);

  // Build query params for API
  const queryParams = useMemo(() => {
    const params: Record<string, string> = {
      page: String(page),
      limit: "50",
    };
    if (tab === "expedidos") params.tab = "expedidos";
    return params;
  }, [tab, page]);

  const { data, isLoading } = useQuery<TrackingResponse>({
    queryKey: ["pedidos-tracking", queryParams],
    queryFn: async () => {
      const qs = new URLSearchParams(queryParams).toString();
      const res = await sisoFetch(`/api/pedidos/tracking?${qs}`);
      if (!res.ok) throw new Error("Erro ao carregar pedidos");
      return res.json();
    },
  });

  const pedidos = data?.pedidos ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 0;
  const currentPage = data?.page ?? page;

  // Tab counts — total for current, use separate query for the other tab count
  const { data: otherTabData } = useQuery<TrackingResponse>({
    queryKey: ["pedidos-tracking-count", tab === "expedidos" ? "pedidos" : "expedidos"],
    queryFn: async () => {
      const params: Record<string, string> = { page: "1", limit: "1" };
      if (tab !== "expedidos") params.tab = "expedidos";
      const qs = new URLSearchParams(params).toString();
      const res = await sisoFetch(`/api/pedidos/tracking?${qs}`);
      if (!res.ok) return { pedidos: [], total: 0, page: 1, totalPages: 0 };
      return res.json();
    },
  });

  const tabs: Tab[] = [
    {
      id: "pedidos",
      label: "Pedidos",
      count: tab === "pedidos" ? total : (otherTabData?.total ?? 0),
    },
    {
      id: "expedidos",
      label: "Expedidos",
      count: tab === "expedidos" ? total : (otherTabData?.total ?? 0),
    },
  ];

  function setTab(newTab: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (newTab === "pedidos") {
      params.delete("tab");
    } else {
      params.set("tab", newTab);
    }
    params.delete("page");
    router.push(`/pedidos?${params.toString()}`);
  }

  function setPage(newPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (newPage <= 1) {
      params.delete("page");
    } else {
      params.set("page", String(newPage));
    }
    router.push(`/pedidos?${params.toString()}`);
  }

  return (
    <AppShell title="Pedidos">
      <div className="space-y-4">
        {/* Tabs */}
        <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />

        {/* List */}
        {isLoading ? (
          <LoadingSpinner message="Carregando pedidos..." />
        ) : pedidos.length === 0 ? (
          <EmptyState message={tab === "expedidos" ? "Nenhum pedido expedido" : "Nenhum pedido encontrado"} />
        ) : (
          <div className="space-y-2">
            {pedidos.map((p) => (
              <TrackingCard
                key={p.id}
                pedido={p}
                onClick={() => router.push(`/pedidos/${p.id}`)}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage <= 1}
              className={cn(
                "inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                currentPage <= 1
                  ? "cursor-not-allowed text-ink-faint"
                  : "text-ink hover:bg-surface",
              )}
            >
              <ChevronLeft className="h-4 w-4" />
              Anterior
            </button>

            <span className="text-sm text-ink-faint">
              {currentPage} / {totalPages}
              <span className="ml-2 text-xs">({total} pedidos)</span>
            </span>

            <button
              type="button"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
              className={cn(
                "inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                currentPage >= totalPages
                  ? "cursor-not-allowed text-ink-faint"
                  : "text-ink hover:bg-surface",
              )}
            >
              Proxima
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}

// ─── Page export with Suspense (for useSearchParams) ────────────────────────

export default function PedidosPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface">
          <LoadingSpinner />
        </div>
      }
    >
      <PedidosPageContent />
    </Suspense>
  );
}
