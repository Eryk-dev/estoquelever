"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDownUp,
  Clock3,
  RefreshCw,
  Search,
  SlidersHorizontal,
  ShoppingCart,
  X,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { FornecedorCard } from "@/components/compras/fornecedor-card";
import { OrdemCompraCard } from "@/components/compras/ordem-compra-card";
import { ExceptionItemCard } from "@/components/compras/exception-item-card";
import { sisoFetch, useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

import type { Tab, CompraItemAgrupado, CompraOcItem, CompraExceptionItem } from "@/types";

type CompraTab = "aguardando_compra" | "comprado" | "recebido" | "excecoes";
type Prioridade = "critica" | "alta" | "normal";
type PrioridadeFilter = "todas" | Prioridade;
type AgingFilter = "todos" | "hoje" | "1-2" | "3+";
type OcSortOption = "recente" | "prioridade" | "aging";
type OcStatusFilter = "todas" | "comprado" | "parcialmente_recebido";

interface ComprasCounts {
  aguardando_compra: number;
  comprado: number;
  recebido: number;
  indisponivel: number;
}

interface GalpaoOption {
  id: string;
  nome: string;
}

interface EmpresaBadge {
  id: string;
  nome: string;
}

interface SummaryItem {
  nome: string | null;
  quantidade: number;
  pedidos: number;
  empresa_id?: string | null;
}

interface ComprasSummary {
  itens_pendentes: number;
  quantidade_pendente: number;
  pedidos_bloqueados: number;
  empresas_em_compra: number;
  ocs_abertas: number;
  excecoes: number;
  mais_antigo_dias: number;
  gargalos_fornecedor: SummaryItem[];
  gargalos_empresa: SummaryItem[];
}

interface FornecedorGroup {
  fornecedor: string;
  galpao_sugerido_id: string | null;
  galpao_sugerido_nome: string | null;
  empresas: EmpresaBadge[];
  prioridade: Prioridade;
  aging_dias: number;
  pedidos_bloqueados: number;
  quantidade_total: number;
  total_skus: number;
  rascunho_ocs: number;
  itens_em_rascunho: number;
  proxima_acao: string;
  itens: CompraItemAgrupado[];
}

interface OcData {
  id: string;
  fornecedor: string;
  galpao_id: string | null;
  galpao_nome: string | null;
  status: string;
  observacao: string | null;
  comprado_por_nome: string | null;
  comprado_em: string | null;
  recebido_em?: string | null;
  created_at: string;
  aging_dias: number;
  prioridade: Prioridade;
  pedidos_bloqueados: number;
  quantidade_total: number;
  quantidade_recebida: number;
  total_itens: number;
  itens_recebidos: number;
  proxima_acao: string;
  itens: CompraOcItem[];
}

type ExceptionData = CompraExceptionItem;

interface ComprasResponse {
  counts: ComprasCounts;
  summary: ComprasSummary;
  data: unknown[];
}

interface ActiveFilterPill {
  key: string;
  label: string;
  clear: () => void;
}

const ALLOWED_CARGOS = ["admin", "comprador"];

async function fetchCompras(
  status: CompraTab,
): Promise<ComprasResponse> {
  const res = await sisoFetch(`/api/compras?status=${status}`);
  if (res.status === 401) throw new Error("Sessão expirada");
  if (res.status === 403) throw new Error("Acesso negado");
  if (!res.ok) throw new Error("Erro ao carregar compras");
  return res.json();
}

async function fetchGalpoes(): Promise<GalpaoOption[]> {
  const res = await sisoFetch("/api/admin/galpoes");
  if (!res.ok) return [];
  const data = await res.json();
  // API returns array directly (not wrapped in { galpoes: [...] })
  const galpoes = Array.isArray(data) ? data : (data.galpoes ?? []);
  return galpoes
    .filter((g: { ativo: boolean }) => g.ativo)
    .map((g: { id: string; nome: string }) => ({ id: g.id, nome: g.nome }));
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function matchesAging(days: number, filter: AgingFilter) {
  if (filter === "todos") return true;
  if (filter === "hoje") return days === 0;
  if (filter === "1-2") return days >= 1 && days <= 2;
  return days >= 3;
}

function formatDays(days: number) {
  if (days <= 0) return "Hoje";
  if (days === 1) return "1 dia";
  return `${days} dias`;
}

const EXCEPTION_META = {
  equivalente_pendente: {
    title: "Intercambiáveis aguardando confirmação",
    description: "Itens com SKU alternativo já definido, mas ainda dependentes de ajuste externo.",
  },
  cancelamento_pendente: {
    title: "Cancelamentos pendentes",
    description: "Itens que precisam ser removidos ou cancelados fora do SISO antes de liberar o pedido.",
  },
  indisponivel: {
    title: "Indisponíveis sem saída",
    description: "Itens travados que ainda exigem decisão do comprador.",
  },
} as const;

export default function ComprasPage() {
  const { user } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<CompraTab>("aguardando_compra");
  const [search, setSearch] = useState("");
  const [galpaoFilter, setGalpaoFilter] = useState("todos");
  const [prioridadeFilter, setPrioridadeFilter] = useState<PrioridadeFilter>("todas");
  const [agingFilter, setAgingFilter] = useState<AgingFilter>("todos");
  const [ocSort, setOcSort] = useState<OcSortOption>("recente");
  const [ocStatusFilter, setOcStatusFilter] = useState<OcStatusFilter>("todas");
  const [selectedOcIds, setSelectedOcIds] = useState<string[]>([]);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const deferredSearch = useDeferredValue(search);

  const cargos = user?.cargos ?? (user?.cargo ? [user.cargo] : []);
  const cargo = cargos.find((c) => ALLOWED_CARGOS.includes(c)) ?? "";
  const allowed = cargo !== "";

  const handleSwitchTab = useCallback((e: Event) => {
    const tab = (e as CustomEvent).detail as CompraTab;
    if (tab) setActiveTab(tab);
  }, []);

  useEffect(() => {
    window.addEventListener("compras:switch-tab", handleSwitchTab);
    return () => window.removeEventListener("compras:switch-tab", handleSwitchTab);
  }, [handleSwitchTab]);

  const { data, error, isError, isLoading, isRefetching } = useQuery({
    queryKey: ["compras", activeTab],
    queryFn: () => fetchCompras(activeTab),
    enabled: !!user && allowed,
    refetchInterval: 30_000,
  });

  const { data: galpoes = [] } = useQuery({
    queryKey: ["galpoes-compras"],
    queryFn: fetchGalpoes,
    enabled: !!user && allowed,
    staleTime: 5 * 60 * 1000,
  });
  const queryError = error instanceof Error ? error.message : "Erro ao carregar compras";

  const counts = data?.counts ?? {
    aguardando_compra: 0,
    comprado: 0,
    recebido: 0,
    indisponivel: 0,
  };
  const summary = data?.summary ?? {
    itens_pendentes: 0,
    quantidade_pendente: 0,
    pedidos_bloqueados: 0,
    empresas_em_compra: 0,
    ocs_abertas: 0,
    excecoes: 0,
    mais_antigo_dias: 0,
    gargalos_fornecedor: [],
    gargalos_empresa: [],
  };
  const items = useMemo(() => (data?.data ?? []) as unknown[], [data?.data]);

  const tabs: Tab[] = [
    {
      id: "aguardando_compra",
      label: "1. Planejamento",
      count: counts.aguardando_compra,
    },
    { id: "comprado", label: "2. Em aberto", count: counts.comprado },
    { id: "recebido", label: "3. Concluídas", count: counts.recebido },
    { id: "excecoes", label: "4. Exceções", count: counts.indisponivel },
  ];

  const emptyMessages: Record<CompraTab, string> = {
    aguardando_compra: "Nenhuma demanda aguardando decisão de compra.",
    comprado: "Nenhuma ordem de compra aberta.",
    recebido: "Nenhuma OC concluída até agora.",
    excecoes: "Nenhum item bloqueado por intercambiável ou exceção.",
  };

  const galpaoOptions = useMemo(() => {
    const map = new Map<string, string>();
    if (activeTab === "aguardando_compra") {
      for (const group of items as FornecedorGroup[]) {
        if (group.galpao_sugerido_id) map.set(group.galpao_sugerido_id, group.galpao_sugerido_nome ?? group.galpao_sugerido_id);
      }
    } else if (activeTab === "comprado" || activeTab === "recebido") {
      for (const oc of items as OcData[]) {
        if (oc.galpao_id) map.set(oc.galpao_id, oc.galpao_nome ?? oc.galpao_id);
      }
    } else {
      for (const item of items as ExceptionData[]) {
        if (item.galpao_id) map.set(item.galpao_id, item.galpao_nome ?? item.galpao_id);
      }
    }
    return [...map.entries()].map(([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label, "pt-BR"),
    );
  }, [activeTab, items]);

  const filteredItems = useMemo(() => {
    const searchTerm = normalizeText(deferredSearch);

    if (activeTab === "aguardando_compra") {
      return (items as FornecedorGroup[]).filter((group) => {
        if (galpaoFilter !== "todos" && group.galpao_sugerido_id !== galpaoFilter) return false;
        if (prioridadeFilter !== "todas" && group.prioridade !== prioridadeFilter) return false;
        if (!matchesAging(group.aging_dias, agingFilter)) return false;

        if (!searchTerm) return true;

        const haystack = normalizeText(
          [
            group.fornecedor,
            group.galpao_sugerido_nome,
            group.proxima_acao,
            ...group.itens.flatMap((item) => [
              item.sku,
              item.descricao,
              ...item.pedidos.map((pedido) => pedido.numero_pedido),
            ]),
          ].join(" "),
        );
        return haystack.includes(searchTerm);
      });
    }

    if (activeTab === "comprado" || activeTab === "recebido") {
      const filtered = (items as OcData[]).filter((oc) => {
        if (activeTab === "comprado" && ocStatusFilter !== "todas" && oc.status !== ocStatusFilter) return false;
        if (galpaoFilter !== "todos" && oc.galpao_id !== galpaoFilter) return false;
        if (prioridadeFilter !== "todas" && oc.prioridade !== prioridadeFilter) return false;
        if (!matchesAging(oc.aging_dias, agingFilter)) return false;

        if (!searchTerm) return true;

        const haystack = normalizeText(
          [
            oc.fornecedor,
            oc.galpao_nome,
            oc.proxima_acao,
            ...oc.itens.flatMap((item) => [
              item.sku,
              item.descricao,
              item.numero_pedido,
            ]),
          ].join(" "),
        );
        return haystack.includes(searchTerm);
      });

      if (ocSort === "prioridade") {
        const prioridadeOrder = { critica: 0, alta: 1, normal: 2 } as const;
        filtered.sort((a, b) =>
          prioridadeOrder[a.prioridade] - prioridadeOrder[b.prioridade] ||
          b.aging_dias - a.aging_dias ||
          b.pedidos_bloqueados - a.pedidos_bloqueados,
        );
      } else if (ocSort === "aging") {
        filtered.sort((a, b) => b.aging_dias - a.aging_dias);
      }
      // "recente" keeps API default (comprado_em DESC)

      return filtered;
    }

    return (items as ExceptionData[]).filter((item) => {
      if (galpaoFilter !== "todos" && item.galpao_id !== galpaoFilter) return false;
      if (prioridadeFilter !== "todas" && item.prioridade !== prioridadeFilter) return false;
      if (!matchesAging(item.aging_dias, agingFilter)) return false;

      if (!searchTerm) return true;

      const haystack = normalizeText(
        [
          item.sku,
          item.descricao,
          item.fornecedor_oc,
          item.numero_pedido,
          item.proxima_acao,
        ].join(" "),
      );
      return haystack.includes(searchTerm);
    });
  }, [activeTab, agingFilter, deferredSearch, galpaoFilter, items, ocSort, ocStatusFilter, prioridadeFilter]);

  const exceptionSections = useMemo(() => {
    if (activeTab !== "excecoes") return [];

    const grouped = new Map<string, ExceptionData[]>();
    for (const item of filteredItems as ExceptionData[]) {
      const key = item.compra_status ?? "indisponivel";
      const current = grouped.get(key) ?? [];
      current.push(item);
      grouped.set(key, current);
    }

    return ["equivalente_pendente", "cancelamento_pendente", "indisponivel"]
      .map((status) => ({
        status,
        title: EXCEPTION_META[status as keyof typeof EXCEPTION_META].title,
        description: EXCEPTION_META[status as keyof typeof EXCEPTION_META].description,
        items: grouped.get(status) ?? [],
      }))
      .filter((section) => section.items.length > 0);
  }, [activeTab, filteredItems]);

  const effectiveSelectedOcIds = useMemo(() => {
    if (activeTab !== "comprado") return [];
    const availableIds = new Set((items as OcData[]).map((oc) => oc.id));
    return selectedOcIds.filter((id) => availableIds.has(id));
  }, [activeTab, items, selectedOcIds]);

  const selectedOcs = useMemo(
    () => (items as OcData[]).filter((oc) => effectiveSelectedOcIds.includes(oc.id)),
    [effectiveSelectedOcIds, items],
  );

  const selectedOcGalpoes = useMemo(
    () => [...new Set(selectedOcs.map((oc) => oc.galpao_id ?? "__sem_galpao__"))],
    [selectedOcs],
  );

  const canStartBatchConference = selectedOcs.length > 0 && selectedOcGalpoes.length <= 1;

  function resetFilters() {
    setSearch("");
    setGalpaoFilter("todos");
    setPrioridadeFilter("todas");
    setAgingFilter("todos");
    setOcSort("recente");
    setOcStatusFilter("todas");
  }

  function toggleOcSelection(ocId: string) {
    setSelectedOcIds((prev) =>
      prev.includes(ocId)
        ? prev.filter((id) => id !== ocId)
        : [...prev, ocId],
    );
  }

  function clearOcSelection() {
    setSelectedOcIds([]);
  }

  function startBatchConference() {
    if (!canStartBatchConference) return;

    const orderedIds = (items as OcData[])
      .filter((oc) => effectiveSelectedOcIds.includes(oc.id))
      .map((oc) => oc.id);

    if (orderedIds.length === 0) return;

    router.push(
      `/compras/conferencia/${orderedIds[0]}?ocs=${orderedIds.join(",")}`,
    );
  }

  const headerRight = (
    <button
      type="button"
      onClick={() =>
        queryClient.invalidateQueries({ queryKey: ["compras"] })
      }
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint hover:bg-surface hover:text-ink"
      title="Atualizar"
    >
      <RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
    </button>
  );

  const resultEntityLabel =
    activeTab === "aguardando_compra"
      ? filteredItems.length === 1
        ? "fornecedor"
        : "fornecedores"
      : activeTab === "comprado" || activeTab === "recebido"
        ? filteredItems.length === 1
          ? "OC"
          : "OCs"
        : filteredItems.length === 1
          ? "item"
          : "itens";

  const galpaoFilterLabel =
    galpaoFilter === "todos"
      ? null
      : galpaoOptions.find((option) => option.value === galpaoFilter)?.label ?? galpaoFilter;

  const activeFilterPills: ActiveFilterPill[] = [
    ...(search.trim()
      ? [
          {
            key: "search",
            label: `Busca: ${search.trim().slice(0, 28)}${search.trim().length > 28 ? "..." : ""}`,
            clear: () => setSearch(""),
          },
        ]
      : []),
    ...(galpaoFilterLabel
      ? [
          {
            key: "galpao",
            label: `Galpão: ${galpaoFilterLabel}`,
            clear: () => setGalpaoFilter("todos"),
          },
        ]
      : []),
    ...(prioridadeFilter !== "todas"
      ? [
          {
            key: "prioridade",
            label: `Prioridade: ${
              prioridadeFilter === "critica"
                ? "Crítica"
                : prioridadeFilter === "alta"
                  ? "Alta"
                  : "Normal"
            }`,
            clear: () => setPrioridadeFilter("todas"),
          },
        ]
      : []),
    ...(agingFilter !== "todos"
      ? [
          {
            key: "aging",
            label: `Aging: ${
              agingFilter === "hoje"
                ? "Hoje"
                : agingFilter === "1-2"
                  ? "1 a 2 dias"
                  : "3 dias ou mais"
            }`,
            clear: () => setAgingFilter("todos"),
          },
        ]
      : []),
    ...(activeTab === "comprado" && ocStatusFilter !== "todas"
      ? [
          {
            key: "oc-status",
            label:
              ocStatusFilter === "comprado"
                ? "Status: aguardando chegada"
                : "Status: para conferir",
            clear: () => setOcStatusFilter("todas"),
          },
        ]
      : []),
    ...((activeTab === "comprado" || activeTab === "recebido") && ocSort !== "recente"
      ? [
          {
            key: "oc-sort",
            label: `Ordem: ${ocSort === "prioridade" ? "prioridade" : "aging"}`,
            clear: () => setOcSort("recente"),
          },
        ]
      : []),
  ];

  const activeFilterCount = activeFilterPills.length;
  const compactSummaryCards = [
    { label: "Pendentes", value: String(summary.itens_pendentes), highlight: summary.itens_pendentes > 0 },
    { label: "OCs abertas", value: String(summary.ocs_abertas), highlight: false },
    { label: "Concluídas", value: String(counts.recebido), highlight: false },
    { label: "Exceções", value: String(summary.excecoes), highlight: summary.excecoes > 0 },
    { label: "Pedidos travados", value: String(summary.pedidos_bloqueados), highlight: summary.pedidos_bloqueados > 0 },
    { label: "Mais antigo", value: formatDays(summary.mais_antigo_dias), highlight: summary.mais_antigo_dias >= 3 },
  ];

  return (
    <AppShell
      title="Compras"
      subtitle="Operação do comprador"
      backHref="/"
      headerRight={allowed ? headerRight : undefined}
      mainClassName="max-w-[1480px] px-4 py-4 sm:px-5 sm:py-6"
    >
      {!allowed ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16">
          <ShoppingCart className="h-8 w-8 text-ink-faint" />
          <p className="text-sm text-ink-faint">
            Acesso negado. Apenas administradores e compradores podem acessar
            esta página.
          </p>
        </div>
      ) : isError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-6 py-10">
          <div className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="h-5 w-5" />
            <p className="text-sm font-semibold">Falha ao carregar compras</p>
          </div>
          <p className="mt-2 text-sm text-red-700/90">{queryError}</p>
          <button
            type="button"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["compras"] })}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-red-200 bg-paper px-4 py-2 text-sm font-medium text-red-700 hover:bg-white"
          >
            <RefreshCw className="h-4 w-4" />
            Tentar novamente
          </button>
        </div>
      ) : isLoading ? (
        <LoadingSpinner message="Carregando compras..." />
      ) : (
        <>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {compactSummaryCards.map((card) => (
                <div
                  key={card.label}
                  className={cn(
                    "rounded-lg px-2.5 py-2",
                    card.highlight
                      ? "border border-amber-200 bg-amber-50/60"
                      : "border border-line bg-surface/50",
                  )}
                >
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">
                    {card.label}
                  </p>
                  <p className={cn(
                    "mt-0.5 text-lg font-semibold",
                    card.highlight ? "text-amber-800" : "text-ink",
                  )}>{card.value}</p>
                </div>
              ))}
            </div>

            <div className="min-w-0 space-y-4">
              <div>
                <Tabs
                  tabs={tabs}
                  activeTab={activeTab}
                  onChange={(id) => {
                    setActiveTab(id as CompraTab);
                    resetFilters();
                    setShowAdvancedFilters(false);
                    setSelectedOcIds([]);
                  }}
                />
              </div>

              <section className="rounded-2xl border border-line bg-paper p-3 sm:p-4">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
                      <label className="relative flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Buscar fornecedor, SKU, pedido ou ação"
                          className="w-full rounded-xl border border-line bg-surface py-2 pl-10 pr-10 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
                        />
                        {search.trim() && (
                          <button
                            type="button"
                            onClick={() => setSearch("")}
                            className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-paper hover:text-ink"
                            title="Limpar busca"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </label>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setShowAdvancedFilters((current) => !current)}
                          className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                            showAdvancedFilters || activeFilterCount > 0
                              ? "border-ink bg-ink text-paper"
                              : "border-line bg-surface text-ink hover:bg-paper"
                          }`}
                          aria-expanded={showAdvancedFilters}
                        >
                          <SlidersHorizontal className="h-4 w-4" />
                          {showAdvancedFilters ? "Ocultar filtros" : "Mais filtros"}
                          {activeFilterCount > 0 && (
                            <span className="rounded-full bg-paper/15 px-1.5 py-0.5 text-[10px] font-semibold text-paper">
                              {activeFilterCount}
                            </span>
                          )}
                        </button>

                        {activeFilterCount > 0 && (
                          <button
                            type="button"
                            onClick={resetFilters}
                            className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper"
                          >
                            <X className="h-4 w-4" />
                            Limpar
                          </button>
                        )}
                      </div>
                    </div>

                    <span className="shrink-0 text-xs text-ink-muted">
                      {filteredItems.length}/{items.length} {resultEntityLabel}
                    </span>
                  </div>

                  {activeFilterPills.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {activeFilterPills.map((pill) => (
                        <button
                          key={pill.key}
                          type="button"
                          onClick={pill.clear}
                          className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink transition-colors hover:bg-paper"
                        >
                          {pill.label}
                          <X className="h-3 w-3 text-ink-faint" />
                        </button>
                      ))}
                    </div>
                  )}

                  {showAdvancedFilters && (
                    <div className="grid gap-3 border-t border-line pt-3 lg:grid-cols-4">
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                          Galpão
                        </span>
                        <select
                          value={galpaoFilter}
                          onChange={(e) => setGalpaoFilter(e.target.value)}
                          className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                        >
                          <option value="todos">Todos os galpões</option>
                          {galpaoOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                          Prioridade
                        </span>
                        <select
                          value={prioridadeFilter}
                          onChange={(e) => setPrioridadeFilter(e.target.value as PrioridadeFilter)}
                          className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                        >
                          <option value="todas">Todas as prioridades</option>
                          <option value="critica">Crítica</option>
                          <option value="alta">Alta</option>
                          <option value="normal">Normal</option>
                        </select>
                      </label>

                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                          Aging
                        </span>
                        <select
                          value={agingFilter}
                          onChange={(e) => setAgingFilter(e.target.value as AgingFilter)}
                          className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                        >
                          <option value="todos">Todo aging</option>
                          <option value="hoje">Hoje</option>
                          <option value="1-2">1 a 2 dias</option>
                          <option value="3+">3 dias ou mais</option>
                        </select>
                      </label>

                      {(activeTab === "comprado" || activeTab === "recebido") ? (
                        <label className="flex flex-col gap-1">
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                            <ArrowDownUp className="h-3.5 w-3.5" />
                            Ordenação
                          </span>
                          <select
                            value={ocSort}
                            onChange={(e) => setOcSort(e.target.value as OcSortOption)}
                            className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                          >
                            <option value="recente">Mais recente</option>
                            <option value="prioridade">Prioridade</option>
                            <option value="aging">Aging</option>
                          </select>
                        </label>
                      ) : (
                        <div className="hidden lg:block" />
                      )}

                      {activeTab === "comprado" && (
                        <div className="space-y-2 lg:col-span-4">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                            Status das OCs
                          </span>
                          <div className="flex flex-wrap items-center gap-2">
                            {([
                              { value: "todas", label: "Todas" },
                              { value: "comprado", label: "Aguardando chegada" },
                              { value: "parcialmente_recebido", label: "Para conferir" },
                            ] as const).map((opt) => (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => setOcStatusFilter(opt.value)}
                                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                                  ocStatusFilter === opt.value
                                    ? "bg-ink text-paper"
                                    : "bg-surface text-ink-muted hover:bg-zinc-200"
                                }`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>

              {activeTab === "comprado" && selectedOcs.length > 0 && (
                <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50/60 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-blue-800">
                      {selectedOcs.length} OC{selectedOcs.length !== 1 ? "s" : ""} selecionada{selectedOcs.length !== 1 ? "s" : ""}
                    </span>
                    {selectedOcs.length > 0 && (
                      <span className="text-blue-600">
                        · {selectedOcs[0].galpao_nome ?? "sem galpão"}
                      </span>
                    )}
                    {selectedOcs.length > 0 && !canStartBatchConference && (
                      <span className="text-xs text-red-600">
                        Selecione OCs do mesmo galpão
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={clearOcSelection}
                      className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50"
                    >
                      Limpar
                    </button>
                    <button
                      type="button"
                      onClick={startBatchConference}
                      disabled={!canStartBatchConference}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                    >
                      Conferir em lote
                    </button>
                  </div>
                </section>
              )}

              {items.length === 0 ? (
                <EmptyState message={emptyMessages[activeTab]} />
              ) : filteredItems.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-line bg-paper px-6 py-10 text-center">
                  <AlertTriangle className="mx-auto h-6 w-6 text-ink-faint" />
                  <p className="mt-3 text-sm text-ink-muted">
                    Nenhum resultado com os filtros atuais.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {activeTab === "aguardando_compra" &&
                    (filteredItems as FornecedorGroup[]).map((group) => (
                      <FornecedorCard
                        key={group.fornecedor}
                        fornecedor={group.fornecedor}
                        galpao_sugerido_id={group.galpao_sugerido_id}
                        galpao_sugerido_nome={group.galpao_sugerido_nome}
                        empresas={group.empresas}
                        galpoes={galpoes}
                        prioridade={group.prioridade}
                        aging_dias={group.aging_dias}
                        pedidos_bloqueados={group.pedidos_bloqueados}
                        quantidade_total={group.quantidade_total}
                        total_skus={group.total_skus}
                        rascunho_ocs={group.rascunho_ocs}
                        itens_em_rascunho={group.itens_em_rascunho}
                        proxima_acao={group.proxima_acao}
                        itens={group.itens}
                      />
                    ))}

                  {(activeTab === "comprado" || activeTab === "recebido") &&
                    (filteredItems as OcData[]).map((oc) => (
                      <OrdemCompraCard
                        key={oc.id}
                        id={oc.id}
                        fornecedor={oc.fornecedor}
                        galpao_nome={oc.galpao_nome}
                        status={oc.status}
                        observacao={oc.observacao}
                        comprado_por_nome={oc.comprado_por_nome}
                        comprado_em={oc.comprado_em}
                        recebido_em={oc.recebido_em}
                        aging_dias={oc.aging_dias}
                        prioridade={oc.prioridade}
                        pedidos_bloqueados={oc.pedidos_bloqueados}
                        quantidade_total={oc.quantidade_total}
                        quantidade_recebida={oc.quantidade_recebida}
                        total_itens={oc.total_itens}
                        itens_recebidos={oc.itens_recebidos}
                        proxima_acao={oc.proxima_acao}
                        itens={oc.itens}
                        selected={activeTab === "comprado" ? effectiveSelectedOcIds.includes(oc.id) : false}
                        onToggleSelect={activeTab === "comprado" ? () => toggleOcSelection(oc.id) : undefined}
                      />
                    ))}

                  {activeTab === "excecoes" &&
                    exceptionSections.map((section) => (
                      <section
                        key={section.status}
                        className="rounded-2xl border border-line bg-paper p-4"
                      >
                        <div className="flex flex-col gap-1 border-b border-line pb-3">
                          <h3 className="text-sm font-semibold text-ink">{section.title}</h3>
                          <p className="text-xs text-ink-muted">{section.description}</p>
                        </div>
                        <div className="mt-4 flex flex-col gap-3">
                          {section.items.map((item) => (
                            <ExceptionItemCard
                              key={item.id}
                              item={item}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
