"use client";

import { Suspense, useState, useEffect, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
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
  validacao_oc: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
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
  validacao_oc: "Validação OC",
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

// ─── Filter options ─────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "pendente", label: "Pendente" },
  { value: "executando", label: "Executando" },
  { value: "concluido", label: "Concluido" },
  { value: "cancelado", label: "Cancelado" },
  { value: "erro", label: "Erro" },
];

const STATUS_SEPARACAO_OPTIONS = [
  { value: "aguardando_compra", label: "Ag. Compra" },
  { value: "aguardando_nf", label: "Ag. NF" },
  { value: "validacao_oc", label: "Validação OC" },
  { value: "aguardando_separacao", label: "Ag. Separacao" },
  { value: "em_separacao", label: "Em Separacao" },
  { value: "separado", label: "Separado" },
  { value: "embalado", label: "Embalado" },
];

const DECISAO_OPTIONS = [
  { value: "propria", label: "Propria" },
  { value: "transferencia", label: "Transferencia" },
  { value: "oc", label: "OC" },
];

const MARKETPLACE_OPTIONS = [
  { value: "Mercado Livre", label: "Mercado Livre" },
  { value: "Shopee", label: "Shopee" },
];

// ─── Checkbox group ─────────────────────────────────────────────────────────

function CheckboxGroup({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  function toggle(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  return (
    <div>
      <span className="mb-1.5 block text-xs font-semibold text-ink-faint uppercase tracking-wide">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

  // ─── Read URL state ────────────────────────────────────────────────────────
  const tab = searchParams.get("tab") ?? "pedidos";
  const page = parseInt(searchParams.get("page") ?? "1", 10);
  const urlBusca = searchParams.get("busca") ?? "";
  const urlStatus = searchParams.get("status") ?? "";
  const urlStatusSeparacao = searchParams.get("status_separacao") ?? "";
  const urlDecisao = searchParams.get("decisao") ?? "";
  const urlEmpresa = searchParams.get("empresa_origem_id") ?? "";
  const urlMarketplace = searchParams.get("marketplace") ?? "";
  const urlDataInicio = searchParams.get("data_inicio") ?? "";
  const urlDataFim = searchParams.get("data_fim") ?? "";

  // ─── Local state for search debounce ───────────────────────────────────────
  const [searchInput, setSearchInput] = useState(urlBusca);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // ─── URL update helper ─────────────────────────────────────────────────────
  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value) {
          params.set(key, value);
        } else {
          params.delete(key);
        }
      }
      // Reset page when filters change (unless page itself is being set)
      if (!("page" in updates)) {
        params.delete("page");
      }
      router.push(`/pedidos?${params.toString()}`);
    },
    [searchParams, router],
  );

  // Sync searchInput when URL changes externally (e.g. back/forward)
  useEffect(() => {
    setSearchInput(urlBusca);
  }, [urlBusca]);

  // Debounced search — 300ms
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === urlBusca) return;
    const timer = setTimeout(() => {
      updateParams({ busca: trimmed, page: "" });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, urlBusca, updateParams]);

  // ─── Filter state derived from URL ─────────────────────────────────────────
  const statusFilter = urlStatus ? urlStatus.split(",").filter(Boolean) : [];
  const statusSeparacaoFilter = urlStatusSeparacao ? urlStatusSeparacao.split(",").filter(Boolean) : [];
  const decisaoFilter = urlDecisao ? urlDecisao.split(",").filter(Boolean) : [];

  // ─── Active filter count ───────────────────────────────────────────────────
  const activeFilterCount =
    (urlBusca ? 1 : 0) +
    (statusFilter.length > 0 ? 1 : 0) +
    (statusSeparacaoFilter.length > 0 ? 1 : 0) +
    (decisaoFilter.length > 0 ? 1 : 0) +
    (urlEmpresa ? 1 : 0) +
    (urlMarketplace ? 1 : 0) +
    (urlDataInicio ? 1 : 0) +
    (urlDataFim ? 1 : 0);

  const hasFilters = activeFilterCount > 0;

  function clearFilters() {
    setSearchInput("");
    const params = new URLSearchParams();
    if (tab !== "pedidos") params.set("tab", tab);
    router.push(`/pedidos?${params.toString()}`);
  }

  // ─── Build query params for API ────────────────────────────────────────────
  const queryParams = useMemo(() => {
    const params: Record<string, string> = {
      page: String(page),
      limit: "50",
    };
    if (tab === "expedidos") params.tab = "expedidos";
    if (urlBusca) params.busca = urlBusca;
    if (urlStatus) params.status = urlStatus;
    if (urlStatusSeparacao) params.status_separacao = urlStatusSeparacao;
    if (urlDecisao) params.decisao = urlDecisao;
    if (urlEmpresa) params.empresa_origem_id = urlEmpresa;
    if (urlMarketplace) params.marketplace = urlMarketplace;
    if (urlDataInicio) params.data_inicio = urlDataInicio;
    if (urlDataFim) params.data_fim = urlDataFim;
    return params;
  }, [tab, page, urlBusca, urlStatus, urlStatusSeparacao, urlDecisao, urlEmpresa, urlMarketplace, urlDataInicio, urlDataFim]);

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

        {/* Search + filter toggle */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Buscar pedido, cliente, SKU..."
              className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput("");
                  updateParams({ busca: "" });
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-faint hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={cn(
              "relative inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors",
              filtersOpen
                ? "border-zinc-400 bg-zinc-100 text-ink dark:border-zinc-500 dark:bg-zinc-800"
                : "border-line bg-surface text-ink-faint hover:text-ink hover:bg-zinc-50 dark:hover:bg-zinc-800",
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
            <span className="hidden sm:inline">Filtros</span>
            {activeFilterCount > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-900 px-1.5 text-[10px] font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {/* Expandable filter panel */}
        {filtersOpen && (
          <div className="space-y-4 rounded-2xl border border-line bg-paper p-4 animate-slide-up">
            <CheckboxGroup
              label="Status"
              options={STATUS_OPTIONS}
              selected={statusFilter}
              onChange={(values) => updateParams({ status: values.join(",") })}
            />

            <CheckboxGroup
              label="Status Separacao"
              options={STATUS_SEPARACAO_OPTIONS}
              selected={statusSeparacaoFilter}
              onChange={(values) => updateParams({ status_separacao: values.join(",") })}
            />

            <CheckboxGroup
              label="Decisao"
              options={DECISAO_OPTIONS}
              selected={decisaoFilter}
              onChange={(values) => updateParams({ decisao: values.join(",") })}
            />

            <div className="flex flex-wrap gap-3">
              {/* Marketplace */}
              <div className="min-w-[140px]">
                <span className="mb-1.5 block text-xs font-semibold text-ink-faint uppercase tracking-wide">
                  Marketplace
                </span>
                <select
                  value={urlMarketplace}
                  onChange={(e) => updateParams({ marketplace: e.target.value })}
                  className="h-9 w-full rounded-xl border border-line bg-surface px-3 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
                >
                  <option value="">Todos</option>
                  {MARKETPLACE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Empresa */}
              <div className="min-w-[140px]">
                <span className="mb-1.5 block text-xs font-semibold text-ink-faint uppercase tracking-wide">
                  Empresa
                </span>
                <select
                  value={urlEmpresa}
                  onChange={(e) => updateParams({ empresa_origem_id: e.target.value })}
                  className="h-9 w-full rounded-xl border border-line bg-surface px-3 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
                >
                  <option value="">Todas</option>
                  <option value="4473ca97-6939-4c6b-9b88-79e654eae137">NetAir</option>
                  <option value="c27d85ce-1b08-4177-a467-e193da0a2777">NetParts</option>
                </select>
              </div>

              {/* Date range */}
              <div className="min-w-[130px]">
                <span className="mb-1.5 block text-xs font-semibold text-ink-faint uppercase tracking-wide">
                  Data inicio
                </span>
                <input
                  type="date"
                  value={urlDataInicio}
                  onChange={(e) => updateParams({ data_inicio: e.target.value })}
                  className="h-9 w-full rounded-xl border border-line bg-surface px-3 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
                />
              </div>

              <div className="min-w-[130px]">
                <span className="mb-1.5 block text-xs font-semibold text-ink-faint uppercase tracking-wide">
                  Data fim
                </span>
                <input
                  type="date"
                  value={urlDataFim}
                  onChange={(e) => updateParams({ data_fim: e.target.value })}
                  className="h-9 w-full rounded-xl border border-line bg-surface px-3 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
                />
              </div>
            </div>

            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-faint transition-colors hover:text-ink hover:bg-surface"
              >
                <X className="h-3 w-3" />
                Limpar filtros
              </button>
            )}
          </div>
        )}

        {/* Active filters summary (visible even when panel is collapsed) */}
        {hasFilters && !filtersOpen && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-faint">
              {activeFilterCount} filtro(s) ativo(s)
            </span>
            {urlBusca && <FilterChip label="Busca" value={urlBusca} onClear={() => { setSearchInput(""); updateParams({ busca: "" }); }} />}
            {statusFilter.length > 0 && <FilterChip label="Status" value={statusFilter.join(", ")} onClear={() => updateParams({ status: "" })} />}
            {statusSeparacaoFilter.length > 0 && <FilterChip label="Sep." value={statusSeparacaoFilter.join(", ")} onClear={() => updateParams({ status_separacao: "" })} />}
            {decisaoFilter.length > 0 && <FilterChip label="Decisao" value={decisaoFilter.join(", ")} onClear={() => updateParams({ decisao: "" })} />}
            {urlEmpresa && <FilterChip label="Empresa" value={urlEmpresa.slice(0, 8)} onClear={() => updateParams({ empresa_origem_id: "" })} />}
            {urlMarketplace && <FilterChip label="Marketplace" value={urlMarketplace} onClear={() => updateParams({ marketplace: "" })} />}
            {urlDataInicio && <FilterChip label="De" value={urlDataInicio} onClear={() => updateParams({ data_inicio: "" })} />}
            {urlDataFim && <FilterChip label="Ate" value={urlDataFim} onClear={() => updateParams({ data_fim: "" })} />}
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs font-semibold text-ink-faint hover:text-ink"
            >
              Limpar
            </button>
          </div>
        )}

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

// ─── Filter chip ────────────────────────────────────────────────────────────

function FilterChip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-lg bg-zinc-100 px-2 py-1 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      <span className="font-semibold">{label}:</span>
      <span className="max-w-[120px] truncate">{value}</span>
      <button type="button" onClick={onClear} className="ml-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700">
        <X className="h-3 w-3" />
      </button>
    </span>
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
