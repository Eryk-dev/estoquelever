"use client";

import { Suspense, useState, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Home, LogOut, Search, PackageCheck, Play, ShieldAlert, Printer, Undo2, ArrowRight, AlertTriangle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { useRealtimeSeparacao } from "@/hooks/use-realtime-separacao";
import { Tabs } from "@/components/ui/tabs";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  SeparacaoCard,
  type SeparacaoPedido,
} from "@/components/separacao/separacao-card";
import { GalpaoSelector } from "@/components/galpao-selector";
import type { Tab, StatusSeparacao, SeparacaoCounts } from "@/types";

type VisibleSeparacaoTab = Exclude<StatusSeparacao, "cancelado">;

// 6 tabs mapping 1:1 to StatusSeparacao values
const TAB_CONFIG: {
  id: VisibleSeparacaoTab;
  label: string;
  emptyMessage: string;
  description: string;
}[] = [
  {
    id: "aguardando_compra",
    label: "Aguardando OC",
    emptyMessage: "Nenhum pedido aguardando ordem de compra",
    description: "Pedidos sem estoque aguardando ação do time de compras antes de entrar na separação.",
  },
  {
    id: "aguardando_nf",
    label: "Aguardando NF",
    emptyMessage: "Nenhum pedido aguardando nota fiscal",
    description: "Pedidos que já podem avançar, mas dependem de NF ou liberação manual para seguir o fluxo.",
  },
  {
    id: "aguardando_separacao",
    label: "Aguardando Separacao",
    emptyMessage: "Nenhum pedido aguardando separacao",
    description: "Fila pronta para iniciar checklist e começar a execução física no galpão.",
  },
  {
    id: "em_separacao",
    label: "Em Separacao",
    emptyMessage: "Nenhum pedido em separacao",
    description: "Pedidos já em andamento. O objetivo aqui é retomar rapidamente o que ficou aberto.",
  },
  {
    id: "separado",
    label: "Separados",
    emptyMessage: "Nenhum pedido separado",
    description: "Pedidos concluídos na separação e aguardando embalagem, idealmente já com etiqueta pronta.",
  },
  {
    id: "embalado",
    label: "Embalados",
    emptyMessage: "Nenhum pedido embalado",
    description: "Fila final do fluxo. Use para reimpressão, conferência final e eventuais retornos de etapa.",
  },
];

const EMPTY_COUNTS: SeparacaoCounts = {
  aguardando_compra: 0,
  aguardando_nf: 0,
  aguardando_separacao: 0,
  em_separacao: 0,
  separado: 0,
  embalado: 0,
};

const SORT_OPTIONS = [
  { value: "data_pedido", label: "Data" },
  { value: "localizacao", label: "Localizacao" },
  { value: "sku", label: "SKU" },
] as const;

function parseTabParam(value: string | null): VisibleSeparacaoTab | null {
  if (!value) return null;
  return TAB_CONFIG.some((tab) => tab.id === value) ? (value as VisibleSeparacaoTab) : null;
}

// Move target options per current tab (backward + forward)
const MOVE_TARGETS: Partial<Record<StatusSeparacao, {
  back: { value: StatusSeparacao; label: string }[];
  forward: { value: StatusSeparacao; label: string }[];
}>> = {
  aguardando_nf: {
    back: [],
    forward: [
      { value: "aguardando_separacao", label: "Aguardando Separacao" },
      { value: "em_separacao", label: "Em Separacao" },
      { value: "separado", label: "Separado" },
      { value: "embalado", label: "Embalado" },
    ],
  },
  aguardando_separacao: {
    back: [
      { value: "aguardando_nf", label: "Aguardando NF" },
    ],
    forward: [
      { value: "em_separacao", label: "Em Separacao" },
      { value: "separado", label: "Separado" },
      { value: "embalado", label: "Embalado" },
    ],
  },
  em_separacao: {
    back: [
      { value: "aguardando_separacao", label: "Aguardando Separacao" },
    ],
    forward: [
      { value: "separado", label: "Separado" },
      { value: "embalado", label: "Embalado" },
    ],
  },
  separado: {
    back: [
      { value: "em_separacao", label: "Em Separacao" },
      { value: "aguardando_separacao", label: "Aguardando Separacao" },
    ],
    forward: [
      { value: "embalado", label: "Embalado" },
    ],
  },
  embalado: {
    back: [
      { value: "separado", label: "Separado" },
      { value: "aguardando_separacao", label: "Aguardando Separacao" },
    ],
    forward: [],
  },
};

interface SeparacaoResponse {
  counts: SeparacaoCounts;
  pedidos: SeparacaoPedido[];
  empresas: { id: string; nome: string }[];
}

function SeparacaoPageFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface">
      <LoadingSpinner />
    </div>
  );
}

function SeparacaoPageContent() {
  const { user, loading, logout, activeGalpaoId, activeGalpaoNome } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = useMemo(
    () => parseTabParam(searchParams.get("tab")),
    [searchParams],
  );

  const activeTab = requestedTab ?? "aguardando_separacao";
  const contextKey = `${activeGalpaoId ?? "all"}:${activeTab}`;
  const [selectionState, setSelectionState] = useState<{
    key: string;
    ids: Set<string>;
  }>({
    key: "",
    ids: new Set(),
  });

  // Filter state
  const [empresaFilter, setEmpresaFilter] = useState("");
  const [marketplaceFilter, setMarketplaceFilter] = useState("");
  const [sortFilter, setSortFilter] = useState("data_pedido");
  const [busca, setBusca] = useState("");
  // Action loading states
  const [actionLoading, setActionLoading] = useState(false);
  const [revertMenuState, setRevertMenuState] = useState<{
    key: string;
    open: boolean;
  }>({
    key: "",
    open: false,
  });

  const selectedIds =
    selectionState.key === contextKey ? selectionState.ids : new Set<string>();
  const revertMenuOpen =
    revertMenuState.key === contextKey ? revertMenuState.open : false;

  // Realtime: auto-refresh when other operators change order statuses
  useRealtimeSeparacao();

  function toggleSelected(id: string) {
    setSelectionState((prev) => {
      const baseIds = prev.key === contextKey ? prev.ids : new Set<string>();
      const next = new Set(baseIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { key: contextKey, ids: next };
    });
  }

  function clearSelection() {
    setSelectionState({ key: contextKey, ids: new Set() });
  }

  function setSelection(ids: Set<string>) {
    setSelectionState({ key: contextKey, ids });
  }

  function toggleRevertMenu() {
    setRevertMenuState((prev) => ({
      key: contextKey,
      open: prev.key === contextKey ? !prev.open : true,
    }));
  }

  function closeRevertMenu() {
    setRevertMenuState({ key: contextKey, open: false });
  }

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  const canFetch = !loading && !!user;

  // Build query params — filters apply to all tabs
  const queryParams = useMemo(() => {
    const params = new URLSearchParams({ status_separacao: activeTab });
    if (empresaFilter) params.set("empresa_origem_id", empresaFilter);
    if (marketplaceFilter) params.set("marketplace", marketplaceFilter);
    if (sortFilter !== "data_pedido") params.set("sort", sortFilter);
    if (busca.trim()) params.set("busca", busca.trim());
    return params.toString();
  }, [activeTab, empresaFilter, marketplaceFilter, sortFilter, busca]);

  // Fetch pedidos for active tab + counts for all tabs
  const {
    data,
    error,
    isError,
    isLoading: isFetching,
    refetch,
  } = useQuery<SeparacaoResponse>({
    queryKey: ["separacao", activeGalpaoId ?? "all", queryParams],
    queryFn: async () => {
      const res = await sisoFetch(`/api/separacao?${queryParams}`);
      const body = await res.json().catch(() => ({}));

      if (res.status === 401) {
        logout();
        router.replace("/login");
        throw new Error("Sua sessão expirou. Faça login novamente.");
      }

      if (!res.ok) {
        throw new Error(body.error ?? "Erro ao carregar separação");
      }

      if (body?.error === "galpao_nao_selecionado") {
        throw new Error("Selecione um galpão para visualizar a fila de separação.");
      }

      return body;
    },
    enabled: canFetch,
    refetchInterval: 10000,
  });
  const queryError = error instanceof Error ? error.message : "Erro ao carregar separação";

  const counts = data?.counts ?? EMPTY_COUNTS;
  const pedidos = useMemo(() => data?.pedidos ?? [], [data?.pedidos]);

  // Empresa options from API (stable, not affected by filters)
  const empresaOptions = data?.empresas ?? [];

  const activeConfig = TAB_CONFIG.find((t) => t.id === activeTab)!;

  const tabs: Tab[] = TAB_CONFIG.map((t) => ({
    id: t.id,
    label: t.label,
    count: counts[t.id as keyof SeparacaoCounts] ?? 0,
  }));

  // --- Action handlers ---

  async function handleSepararSelecionados() {
    if (!user) return;
    const ids =
      selectedIds.size > 0
        ? Array.from(selectedIds)
        : pedidos.map((p) => p.id);
    if (ids.length === 0) return;
    setActionLoading(true);
    try {
      const res = await sisoFetch("/api/separacao/iniciar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_ids: ids,
          operador_id: user.id,
        }),
      });
      if (res.ok) {
        toast.success(`Separacao iniciada para ${ids.length} pedido(s)`);
        router.push(`/separacao/checklist?pedidos=${ids.join(",")}`);
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao iniciar separacao");
      }
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setActionLoading(false);
    }
  }

  function handleEmbalarSelecionados() {
    const ids =
      selectedIds.size > 0
        ? Array.from(selectedIds)
        : pedidos.map((p) => p.id);
    if (ids.length === 0) return;
    router.push(`/separacao/embalagem?pedidos=${ids.join(",")}`);
  }

  function handleEmbalarComEtiqueta() {
    const source =
      selectedIds.size > 0
        ? pedidos.filter((p) => selectedIds.has(p.id))
        : pedidos;
    const ids = source.filter((p) => p.etiqueta_pronta).map((p) => p.id);
    if (ids.length === 0) {
      toast.error("Nenhum pedido com etiqueta pronta");
      return;
    }
    router.push(`/separacao/embalagem?pedidos=${ids.join(",")}`);
  }

  async function handleForcarPendente() {
    if (selectedIds.size === 0) return;
    setActionLoading(true);
    try {
      const res = await sisoFetch("/api/separacao/forcar-pendente", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: Array.from(selectedIds) }),
      });
      if (res.ok) {
        const body = await res.json();
        toast.success(`${body.total ?? selectedIds.size} pedido(s) movido(s) para Aguardando Separacao`);
        clearSelection();
        refetch();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao forcar pendente");
      }
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleImprimirSelecionados() {
    if (selectedIds.size === 0) return;
    setActionLoading(true);
    const ids = Array.from(selectedIds);
    let ok = 0;
    let fail = 0;
    // Fire all in parallel
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const res = await sisoFetch("/api/separacao/reimprimir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pedido_id: id }),
        });
        const body = await res.json().catch(() => ({}));
        return res.ok && body.status === "impresso";
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) ok++;
      else fail++;
    }
    if (ok > 0) toast.success(`${ok} etiqueta(s) enviada(s)`);
    if (fail > 0) toast.error(`${fail} etiqueta(s) falharam`);
    setActionLoading(false);
  }

  async function handleRetryEtiquetas(pedidoIds: string[]) {
    if (pedidoIds.length === 0) return;
    setActionLoading(true);
    try {
      const res = await sisoFetch("/api/separacao/retry-etiqueta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: pedidoIds }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(body.error ?? "Erro ao tentar obter etiquetas");
        return;
      }

      if (body.recuperadas > 0) {
        toast.success(`${body.recuperadas} etiqueta(s) recuperada(s)`);
      }
      if (body.em_andamento > 0) {
        toast.message(`${body.em_andamento} etiqueta(s) ainda em processamento`);
      }
      if (body.falhas > 0) {
        toast.error(`${body.falhas} etiqueta(s) ainda sem retorno`);
      }
      if (body.recuperadas === 0 && body.em_andamento === 0 && body.falhas === 0) {
        toast.success("As etiquetas selecionadas já estavam disponíveis");
      }
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleMoverEtapa(novoStatus: StatusSeparacao) {
    if (selectedIds.size === 0) return;
    setActionLoading(true);
    closeRevertMenu();
    try {
      const res = await sisoFetch("/api/separacao/voltar-etapa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_ids: Array.from(selectedIds),
          novo_status: novoStatus,
        }),
      });
      if (res.ok) {
        const body = await res.json();
        toast.success(`${body.total} pedido(s) movido(s)`);
        clearSelection();
        refetch();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao mover pedido(s)");
      }
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-faint border-t-ink" />
      </div>
    );
  }

  if (!user) return null;

  if (isError) {
    return (
      <div className="min-h-screen bg-surface">
        <header className="sticky top-0 z-10 border-b border-line bg-paper">
          <div className="mx-auto flex max-w-5xl items-center gap-2 px-3 py-3 sm:px-4">
            <Link
              href="/"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink shrink-0"
              title="Inicio"
            >
              <Home className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <h1 className="text-sm font-bold tracking-tight text-ink sm:text-base">
                Separacao
              </h1>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-3 py-4 sm:px-4">
          <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
            <div className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="h-5 w-5" />
              <p className="text-sm font-semibold">Falha ao carregar separação</p>
            </div>
            <p className="mt-2 text-sm text-red-700/90">{queryError}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => refetch()}
                className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-paper px-4 py-2 text-sm font-medium text-red-700 hover:bg-white"
              >
                <ArrowRight className="h-4 w-4" />
                Tentar novamente
              </button>
              <button
                type="button"
                onClick={logout}
                className="inline-flex items-center gap-2 rounded-lg border border-line bg-paper px-4 py-2 text-sm font-medium text-ink hover:bg-surface"
              >
                <LogOut className="h-4 w-4" />
                Entrar de novo
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const isAdmin = user.cargos?.includes("admin") ?? user.cargo === "admin";
  const showCheckbox =
    activeTab === "aguardando_compra" ||
    activeTab === "aguardando_separacao" ||
    activeTab === "separado" ||
    activeTab === "embalado" ||
    activeTab === "em_separacao" ||
    activeTab === "aguardando_nf";

  const allSelected = pedidos.length > 0 && selectedIds.size === pedidos.length;

  function toggleSelectAll() {
    if (allSelected) {
      clearSelection();
    } else {
      setSelection(new Set(pedidos.map((p) => p.id)));
    }
  }

  const moveTargets = MOVE_TARGETS[activeTab];
  const hasFilters =
    busca.trim().length > 0 ||
    empresaFilter.length > 0 ||
    marketplaceFilter.length > 0 ||
    sortFilter !== "data_pedido";
  const activeFilterCount = [
    busca.trim().length > 0,
    empresaFilter.length > 0,
    marketplaceFilter.length > 0,
    sortFilter !== "data_pedido",
  ].filter(Boolean).length;
  const markedItemsTotal = pedidos.reduce((sum, pedido) => sum + pedido.itens_marcados, 0);
  const itemsTotal = pedidos.reduce((sum, pedido) => sum + pedido.total_itens, 0);
  const queueInsight = (() => {
    if (activeTab === "aguardando_compra") {
      const waitingItems = pedidos.reduce(
        (sum, pedido) => sum + (pedido.compra_stats?.aguardando ?? 0),
        0,
      );
      return {
        label: "Itens aguardando compra",
        value: waitingItems,
        helper: "Volume de itens ainda sem pedido de compra iniciado.",
      };
    }

    if (activeTab === "em_separacao") {
      return {
        label: "Itens marcados",
        value: itemsTotal > 0 ? `${markedItemsTotal}/${itemsTotal}` : "0/0",
        helper: "Avanço consolidado dos pedidos já em execução.",
      };
    }

    if (activeTab === "separado") {
      const readyLabels = pedidos.filter((pedido) => pedido.etiqueta_pronta).length;
      return {
        label: "Com etiqueta pronta",
        value: readyLabels,
        helper: "Pedidos que entram na embalagem sem perda de ritmo.",
      };
    }

    if (activeTab === "embalado") {
      const missingLabels = pedidos.filter((pedido) => !pedido.etiqueta_pronta).length;
      return {
        label: "Sem etiqueta",
        value: missingLabels,
        helper: "Pedidos embalados que ainda precisam recuperar a etiqueta no Tiny.",
      };
    }

    return {
      label: "Prontos para agir",
      value: pedidos.length,
      helper: "Pedidos visíveis na etapa atual para execução imediata.",
    };
  })();

  function handleTabChange(nextTab: StatusSeparacao) {
    clearSelection();
    closeRevertMenu();

    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", nextTab);
    const query = params.toString();
    router.replace(query ? `/separacao?${query}` : "/separacao", { scroll: false });
  }

  function clearFilters() {
    setBusca("");
    setEmpresaFilter("");
    setMarketplaceFilter("");
    setSortFilter("data_pedido");
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-line bg-paper">
        <div className="mx-auto flex max-w-5xl items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3">
          <Link
            href="/"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink shrink-0"
            title="Inicio"
          >
            <Home className="h-4 w-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm sm:text-base font-bold tracking-tight text-ink">
              Separacao
            </h1>
            <p className="text-[11px] text-ink-faint hidden sm:block">
              Separacao fisica por galpao
            </p>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
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

      <main className="mx-auto max-w-5xl space-y-4 px-3 sm:px-4 py-3 sm:py-4">
        {/* Tabs */}
        <div className="overflow-x-auto">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onChange={(id) => handleTabChange(id as StatusSeparacao)}
          />
        </div>

        <section className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(180px,1fr)_minmax(180px,1fr)]">
          <div className="rounded-2xl border border-line bg-paper p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ink-faint">
              Etapa atual
            </p>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight text-ink">
                  {activeConfig.label}
                </h2>
                <p className="mt-1 text-sm text-ink-muted">
                  {activeConfig.description}
                </p>
              </div>
              <div className="inline-flex w-fit flex-col rounded-2xl border border-line bg-surface px-4 py-3 text-left">
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                  Na fila
                </span>
                <span className="font-mono text-2xl font-bold tracking-tight text-ink">
                  {counts[activeTab]}
                </span>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <ContextChip
                label="Galpão"
                value={activeGalpaoNome ?? "Todos"}
              />
              <ContextChip
                label="Selecionados"
                value={selectedIds.size}
              />
              {hasFilters && (
                <ContextChip
                  label="Filtros"
                  value={`${activeFilterCount} ativo(s)`}
                />
              )}
            </div>
          </div>

          <QueueInsightCard
            label="Selecionados"
            value={selectedIds.size}
            helper="Pedidos marcados para ação em lote nesta etapa."
          />
          <QueueInsightCard
            label={queueInsight.label}
            value={queueInsight.value}
            helper={queueInsight.helper}
          />
        </section>

        {/* Filter bar — all tabs */}
        <section className="rounded-2xl border border-line bg-paper p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[140px] sm:min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
              <input
                type="text"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar pedido, cliente..."
                className="h-9 w-full rounded-xl border border-line bg-surface pl-8 pr-3 text-xs text-ink placeholder:text-ink-faint focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
              />
            </div>

            {empresaOptions.length > 0 && (
              <select
                value={empresaFilter}
                onChange={(e) => setEmpresaFilter(e.target.value)}
                className="h-9 rounded-xl border border-line bg-surface px-3 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
              >
                <option value="">Todas empresas</option>
                {empresaOptions.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.nome}
                  </option>
                ))}
              </select>
            )}

            <select
              value={marketplaceFilter}
              onChange={(e) => setMarketplaceFilter(e.target.value)}
              className="h-9 rounded-xl border border-line bg-surface px-3 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
            >
              <option value="">Todos marketplaces</option>
              <option value="Mercado Livre">Mercado Livre</option>
              <option value="Shopee">Shopee</option>
            </select>

            <select
              value={sortFilter}
              onChange={(e) => setSortFilter(e.target.value)}
              className="h-9 rounded-xl border border-line bg-surface px-3 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex h-9 items-center justify-center rounded-xl border border-line px-3 text-xs font-semibold text-ink transition-colors hover:bg-surface"
              >
                Limpar filtros
              </button>
            )}
          </div>

          {hasFilters && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-faint">
                {activeFilterCount} filtro(s) ativo(s)
              </span>
              {busca.trim() && <ContextChip label="Busca" value={busca.trim()} />}
              {empresaFilter && (
                <ContextChip
                  label="Empresa"
                  value={empresaOptions.find((emp) => emp.id === empresaFilter)?.nome ?? empresaFilter}
                />
              )}
              {marketplaceFilter && <ContextChip label="Marketplace" value={marketplaceFilter} />}
              {sortFilter !== "data_pedido" && (
                <ContextChip
                  label="Ordenação"
                  value={SORT_OPTIONS.find((option) => option.value === sortFilter)?.label ?? sortFilter}
                />
              )}
            </div>
          )}
        </section>

        {/* Select all + count */}
        {showCheckbox && pedidos.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <span className="text-xs text-ink-faint">
                {allSelected
                  ? `Todos ${pedidos.length} selecionados`
                  : selectedIds.size > 0
                    ? `${selectedIds.size} de ${pedidos.length} selecionado(s)`
                    : `Selecionar todos (${pedidos.length})`}
              </span>
            </label>
          </div>
        )}

        {/* Action buttons per tab */}
        {activeTab === "aguardando_separacao" && pedidos.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-faint">
              {selectedIds.size > 0
                ? `${selectedIds.size} selecionado(s)`
                : `${pedidos.length} pedido(s)`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {isAdmin && moveTargets && (
                <MoveButton
                  targets={moveTargets}
                  open={revertMenuOpen}
                  onToggle={toggleRevertMenu}
                  onSelect={handleMoverEtapa}
                  disabled={actionLoading || selectedIds.size === 0}
                  count={selectedIds.size || pedidos.length}
                />
              )}
              <button
                type="button"
                onClick={handleSepararSelecionados}
                disabled={actionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                <Play className="h-3.5 w-3.5" />
                {actionLoading
                  ? "Iniciando..."
                  : `Separar ${selectedIds.size > 0 ? selectedIds.size : pedidos.length} pedido(s)`}
              </button>
            </div>
          </div>
        )}

        {activeTab === "separado" && pedidos.length > 0 && (() => {
          const comEtiquetaSource = selectedIds.size > 0
            ? pedidos.filter((p) => selectedIds.has(p.id))
            : pedidos;
          const comEtiqueta = comEtiquetaSource.filter((p) => p.etiqueta_pronta).length;
          const semEtiqueta = comEtiquetaSource.length - comEtiqueta;
          return (
          <>
          {semEtiqueta > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                <strong>{semEtiqueta}</strong> pedido(s) sem etiqueta pronta — impressao sera mais lenta
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-faint">
              {selectedIds.size > 0
                ? `${selectedIds.size} selecionado(s)`
                : `${pedidos.length} pedido(s)`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {isAdmin && moveTargets && (
                <MoveButton
                  targets={moveTargets}
                  open={revertMenuOpen}
                  onToggle={toggleRevertMenu}
                  onSelect={handleMoverEtapa}
                  disabled={actionLoading || selectedIds.size === 0}
                  count={selectedIds.size || pedidos.length}
                />
              )}
              {semEtiqueta > 0 && comEtiqueta > 0 && (
                <button
                  type="button"
                  onClick={handleEmbalarComEtiqueta}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 sm:px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
                >
                  <PackageCheck className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Embalar</span> {comEtiqueta} <span className="hidden sm:inline">com etiqueta</span>
                </button>
              )}
              {semEtiqueta > 0 && (
                <button
                  type="button"
                  onClick={() => handleRetryEtiquetas(comEtiquetaSource.filter((p) => !p.etiqueta_pronta).map((p) => p.id))}
                  disabled={actionLoading}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 sm:px-4 py-2 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {actionLoading
                    ? "Tentando..."
                    : `Gerar ${semEtiqueta} etiqueta(s)`}
                </button>
              )}
              <button
                type="button"
                onClick={handleEmbalarSelecionados}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 sm:px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                <PackageCheck className="h-3.5 w-3.5" />
                {selectedIds.size > 0
                  ? `Embalar ${selectedIds.size}`
                  : `Embalar todos (${pedidos.length})`}
              </button>
            </div>
          </div>
          </>
          );
        })()}

        {activeTab === "embalado" && pedidos.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-faint">
              {selectedIds.size > 0
                ? `${selectedIds.size} selecionado(s)`
                : `${pedidos.length} pedido(s)`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {isAdmin && moveTargets && (
                <MoveButton
                  targets={moveTargets}
                  open={revertMenuOpen}
                  onToggle={toggleRevertMenu}
                  onSelect={handleMoverEtapa}
                  disabled={actionLoading || selectedIds.size === 0}
                  count={selectedIds.size || pedidos.length}
                />
              )}
              <button
                type="button"
                onClick={() => handleRetryEtiquetas(Array.from(selectedIds))}
                disabled={selectedIds.size === 0 || actionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {actionLoading
                  ? "Tentando..."
                  : `Retry etiqueta (${selectedIds.size})`}
              </button>
              <button
                type="button"
                onClick={handleImprimirSelecionados}
                disabled={selectedIds.size === 0 || actionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Printer className="h-3.5 w-3.5" />
                {actionLoading
                  ? "Imprimindo..."
                  : `Imprimir ${selectedIds.size || pedidos.length} etiqueta(s)`}
              </button>
            </div>
          </div>
        )}

        {activeTab === "em_separacao" && pedidos.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-faint">
              {selectedIds.size > 0
                ? `${selectedIds.size} selecionado(s)`
                : `${pedidos.length} pedido(s)`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {isAdmin && moveTargets && (
                <MoveButton
                  targets={moveTargets}
                  open={revertMenuOpen}
                  onToggle={toggleRevertMenu}
                  onSelect={handleMoverEtapa}
                  disabled={actionLoading || selectedIds.size === 0}
                  count={selectedIds.size || pedidos.length}
                />
              )}
              <button
                type="button"
                onClick={handleSepararSelecionados}
                disabled={actionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                <Play className="h-3.5 w-3.5" />
                {actionLoading
                  ? "Retomando..."
                  : `Retomar ${selectedIds.size > 0 ? selectedIds.size : pedidos.length} pedido(s)`}
              </button>
            </div>
          </div>
        )}

        {activeTab === "aguardando_nf" && isAdmin && pedidos.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-faint">
              {selectedIds.size > 0
                ? `${selectedIds.size} selecionado(s)`
                : `${pedidos.length} pedido(s)`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {moveTargets && (
                <MoveButton
                  targets={moveTargets}
                  open={revertMenuOpen}
                  onToggle={toggleRevertMenu}
                  onSelect={handleMoverEtapa}
                  disabled={actionLoading || selectedIds.size === 0}
                  count={selectedIds.size || pedidos.length}
                />
              )}
              <button
                type="button"
                onClick={handleForcarPendente}
                disabled={selectedIds.size === 0 || actionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50"
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                {actionLoading
                  ? "Movendo..."
                  : `Forcar pendente (${selectedIds.size})`}
              </button>
            </div>
          </div>
        )}

        {/* Tab content */}
        {isFetching ? (
          <LoadingSpinner message="Carregando pedidos..." />
        ) : pedidos.length === 0 ? (
          <EmptyState message={activeConfig.emptyMessage} />
        ) : (
          <div className="space-y-2">
            {pedidos.map((pedido) => (
              <SeparacaoCard
                key={pedido.id}
                pedido={pedido}
                activeGalpaoNome={activeGalpaoNome}
                checkbox={showCheckbox}
                checked={selectedIds.has(pedido.id)}
                onToggle={toggleSelected}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default function SeparacaoPage() {
  return (
    <Suspense fallback={<SeparacaoPageFallback />}>
      <SeparacaoPageContent />
    </Suspense>
  );
}

function QueueInsightCard({
  label,
  value,
  helper,
}: {
  label: string;
  value: string | number;
  helper: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-paper p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
        {label}
      </p>
      <p className="mt-3 font-mono text-3xl font-bold tracking-tight text-ink">
        {value}
      </p>
      <p className="mt-2 text-xs text-ink-faint">{helper}</p>
    </div>
  );
}

function ContextChip({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink">
      <span className="font-semibold text-ink-faint">{label}</span>
      <span className="font-medium text-ink">{value}</span>
    </span>
  );
}

// ─── Move dropdown button (backward + forward) ──────────────────────────────

function MoveButton({
  targets,
  open,
  onToggle,
  onSelect,
  disabled,
  count,
}: {
  targets: { back: { value: StatusSeparacao; label: string }[]; forward: { value: StatusSeparacao; label: string }[] };
  open: boolean;
  onToggle: () => void;
  onSelect: (status: StatusSeparacao) => void;
  disabled: boolean;
  count: number;
}) {
  const hasBack = targets.back.length > 0;
  const hasForward = targets.forward.length > 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50"
      >
        <Undo2 className="h-3.5 w-3.5" />
        Mover {count} pedido(s)
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[200px] rounded-lg border border-line bg-paper py-1 shadow-lg">
          {hasBack && (
            <>
              <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                <Undo2 className="mr-1 inline h-3 w-3" />
                Voltar para
              </p>
              {targets.back.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink transition-colors hover:bg-surface"
                  onClick={() => onSelect(t.value)}
                >
                  {t.label}
                </button>
              ))}
            </>
          )}
          {hasBack && hasForward && (
            <div className="my-1 border-t border-line" />
          )}
          {hasForward && (
            <>
              <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                <ArrowRight className="mr-1 inline h-3 w-3" />
                Avancar para
              </p>
              {targets.forward.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-emerald-700 transition-colors hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                  onClick={() => onSelect(t.value)}
                >
                  {t.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
