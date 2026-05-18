"use client";

import { Suspense, useState, useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Search, PackageCheck, Play, ShieldAlert, Printer, Undo2, ArrowRight, AlertTriangle, RotateCcw, Tag, X, Plus, Package } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { getGalpaoAccent } from "@/lib/domain-helpers";
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

// validacao_oc appears in aguardando_separacao tab — pedidos com itens OC pendentes de validação física
type VisibleSeparacaoTab =
  | "aguardando_compra"
  | "aguardando_nf"
  | "aguardando_separacao"
  | "em_separacao"
  | "separado"
  | "embalado";

// Maps tab ID → status_separacao values fetched for that tab
const TAB_STATUS_MAP: Record<VisibleSeparacaoTab, StatusSeparacao[]> = {
  aguardando_compra: ["aguardando_compra"],
  aguardando_nf: ["aguardando_nf"],
  aguardando_separacao: ["aguardando_separacao", "validacao_oc"],
  em_separacao: ["em_separacao"],
  separado: ["separado"],
  embalado: ["embalado"],
};

// 6 tabs — aguardando_separacao includes validacao_oc (OC validated during wave picking)
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
  validacao_oc: 0,
  aguardando_separacao: 0,
  em_separacao: 0,
  separado: 0,
  embalado: 0,
  pendente_realocacao: 0,
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
const MOVE_TARGETS: Partial<Record<VisibleSeparacaoTab, {
  back: { value: StatusSeparacao; label: string }[];
  forward: { value: StatusSeparacao; label: string }[];
}>> = {
  aguardando_compra: {
    back: [],
    forward: [
      { value: "aguardando_separacao", label: "Aguardando Separacao" },
      { value: "em_separacao", label: "Em Separacao" },
    ],
  },
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
      { value: "aguardando_compra", label: "Aguardando OC" },
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
      { value: "aguardando_compra", label: "Aguardando OC" },
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
  galpoes: { id: string; nome: string }[];
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
  const queryClient = useQueryClient();
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
  const [tagFilter, setTagFilter] = useState("");
  const [fornecedorFilter, setFornecedorFilter] = useState("");
  // Tag modal state
  const [tagModalOpen, setTagModalOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [tagActionLoading, setTagActionLoading] = useState(false);
  const lastCheckedIdx = useRef<number | null>(null);
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

  function toggleSelected(id: string, event?: React.MouseEvent | React.ChangeEvent) {
    const nativeEvent = event?.nativeEvent as MouseEvent | undefined;
    const isShift = nativeEvent?.shiftKey ?? false;

    if (isShift && lastCheckedIdx.current !== null && pedidos.length > 0) {
      const curIdx = pedidos.findIndex((p) => p.id === id);
      if (curIdx !== -1) {
        const start = Math.min(lastCheckedIdx.current, curIdx);
        const end = Math.max(lastCheckedIdx.current, curIdx);
        setSelectionState((prev) => {
          const baseIds = prev.key === contextKey ? prev.ids : new Set<string>();
          const next = new Set(baseIds);
          for (let i = start; i <= end; i++) next.add(pedidos[i].id);
          return { key: contextKey, ids: next };
        });
        lastCheckedIdx.current = curIdx;
        return;
      }
    }

    const idx = pedidos.findIndex((p) => p.id === id);
    if (idx !== -1) lastCheckedIdx.current = idx;

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
  // aguardando_compra tab fetches both aguardando_compra + validacao_oc statuses
  const queryParams = useMemo(() => {
    const statuses = TAB_STATUS_MAP[activeTab];
    const params = new URLSearchParams({ status_separacao: statuses.join(",") });
    if (empresaFilter) params.set("empresa_origem_id", empresaFilter);
    if (marketplaceFilter) params.set("marketplace", marketplaceFilter);
    if (sortFilter !== "data_pedido") params.set("sort", sortFilter);
    if (busca.trim()) params.set("busca", busca.trim());
    if (tagFilter) params.set("tag", tagFilter);
    return params.toString();
  }, [activeTab, empresaFilter, marketplaceFilter, sortFilter, busca, tagFilter]);

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
  // Fetch all existing tags for filter/autocomplete
  const { data: tagsData } = useQuery<{ tags: string[] }>({
    queryKey: ["separacao-tags", activeGalpaoId ?? "all"],
    queryFn: async () => {
      const res = await sisoFetch("/api/separacao/tags");
      return res.json();
    },
    enabled: canFetch,
    staleTime: 30000,
  });
  const allTags = tagsData?.tags ?? [];

  const queryError = error instanceof Error ? error.message : "Erro ao carregar separação";

  const counts = data?.counts ?? EMPTY_COUNTS;
  const allPedidos = useMemo(() => data?.pedidos ?? [], [data?.pedidos]);

  // Extract unique fornecedor values from aguardando_compra items
  const fornecedorOptions = useMemo(() => {
    if (activeTab !== "aguardando_compra") return [];
    const set = new Set<string>();
    for (const p of allPedidos) {
      for (const item of p.compra_stats?.itens ?? []) {
        if (item.fornecedor_oc) set.add(item.fornecedor_oc);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [allPedidos, activeTab]);

  // Apply client-side fornecedor filter (only for aguardando_compra tab)
  const pedidos = useMemo(() => {
    if (!fornecedorFilter || activeTab !== "aguardando_compra") return allPedidos;
    return allPedidos.filter((p) =>
      p.compra_stats?.itens?.some((item) => item.fornecedor_oc === fornecedorFilter),
    );
  }, [allPedidos, fornecedorFilter, activeTab]);

  // Empresa options from API (stable, not affected by filters)
  const empresaOptions = data?.empresas ?? [];
  const allGalpoes = data?.galpoes ?? [];

  const activeConfig = TAB_CONFIG.find((t) => t.id === activeTab)!;

  const tabs: Tab[] = TAB_CONFIG.map((t) => {
    const statuses = TAB_STATUS_MAP[t.id];
    const count = statuses.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
    return { id: t.id, label: t.label, count };
  });

  // --- Action handlers ---

  async function handleSepararSelecionados(modo?: string) {
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
        const checklistUrl = `/separacao/checklist?pedidos=${ids.join(",")}${modo ? `&modo=${modo}` : ""}`;
        router.push(checklistUrl);
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
    const ids = selectedIds.size > 0
      ? Array.from(selectedIds)
      : pedidos.map((p) => p.id);
    if (ids.length === 0) return;
    setActionLoading(true);
    try {
      const res = await sisoFetch("/api/separacao/forcar-pendente", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: ids }),
      });
      if (res.ok) {
        const body = await res.json();
        const semNf = body.pedidos_sem_nf?.length ?? 0;
        const naoAutorizados = body.pedidos_nf_nao_autorizada?.length ?? 0;
        const movidos = body.total ?? 0;

        if (movidos > 0) {
          toast.success(`${movidos} pedido(s) movido(s) para Aguardando Separacao`);
        }
        if (semNf > 0) {
          toast.warning(`${semNf} pedido(s) sem NF — não puderam ser movidos`);
        }
        if (naoAutorizados > 0) {
          toast.warning(`${naoAutorizados} pedido(s) com NF não autorizada no Tiny`);
        }
        if (movidos === 0 && semNf === 0 && naoAutorizados === 0) {
          toast.info("Nenhum pedido elegível para mover");
        }
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
    const ids = selectedIds.size > 0
      ? Array.from(selectedIds)
      : pedidos.map((p) => p.id);
    if (ids.length === 0) return;
    setActionLoading(true);
    closeRevertMenu();
    try {
      const res = await sisoFetch("/api/separacao/voltar-etapa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_ids: ids,
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

  async function handleAddTag(tag: string) {
    const ids = selectedIds.size > 0 ? Array.from(selectedIds) : [];
    if (ids.length === 0 || !tag.trim()) return;
    setTagActionLoading(true);
    try {
      const res = await sisoFetch("/api/separacao/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: ids, tags: [tag.trim()], action: "add" }),
      });
      if (res.ok) {
        const body = await res.json();
        toast.success(`Tag "${tag.trim()}" adicionada a ${body.total} pedido(s)`);
        setTagInput("");
        setTagModalOpen(false);
        refetch();
        queryClient.invalidateQueries({ queryKey: ["separacao-tags"] });
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao adicionar tag");
      }
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setTagActionLoading(false);
    }
  }

  async function handleRemoveTag(tag: string, pedidoIds?: string[]) {
    const ids = pedidoIds ?? (selectedIds.size > 0 ? Array.from(selectedIds) : []);
    if (ids.length === 0) return;
    setTagActionLoading(true);
    try {
      const res = await sisoFetch("/api/separacao/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: ids, tags: [tag], action: "remove" }),
      });
      if (res.ok) {
        toast.success(`Tag "${tag}" removida`);
        refetch();
        queryClient.invalidateQueries({ queryKey: ["separacao-tags"] });
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao remover tag");
      }
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setTagActionLoading(false);
    }
  }

  async function handleEncaminhar(pedidoId: string, galpaoDestinoId: string) {
    try {
      const res = await sisoFetch("/api/separacao/encaminhar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: [pedidoId], galpao_destino_id: galpaoDestinoId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Erro ao encaminhar pedido");
        return;
      }
      if (body.encaminhados?.length > 0) {
        toast.success(`Pedido encaminhado para ${body.galpao_destino_nome}`);
        refetch();
      }
      if (body.falhas?.length > 0) {
        toast.error(body.falhas[0].erro ?? "Falha ao encaminhar");
      }
    } catch {
      toast.error("Erro de conexao");
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

  const accent = getGalpaoAccent(activeGalpaoNome);

  if (isError) {
    return (
      <div className="min-h-screen bg-surface">
        <AppHeader
          title="Separacao"
          accentColor={accent.color}
        />

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
    sortFilter !== "data_pedido" ||
    tagFilter.length > 0 ||
    fornecedorFilter.length > 0;
  const activeFilterCount = [
    busca.trim().length > 0,
    empresaFilter.length > 0,
    marketplaceFilter.length > 0,
    sortFilter !== "data_pedido",
    tagFilter.length > 0,
    fornecedorFilter.length > 0,
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

  function handleTabChange(nextTab: VisibleSeparacaoTab) {
    clearSelection();
    closeRevertMenu();
    if (nextTab !== "aguardando_compra") setFornecedorFilter("");

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
    setTagFilter("");
    setFornecedorFilter("");
  }

  return (
    <div className="min-h-screen bg-surface">
      <AppHeader
        title="Separacao"
        subtitle={<span className="hidden sm:inline">Separacao fisica por galpao</span>}
        accentColor={accent.color}
        rightSlot={(
          <div className="flex items-center gap-2">
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

      <main className="mx-auto max-w-5xl space-y-4 px-3 sm:px-4 py-3 sm:py-4">
        {/* Tabs */}
        <div className="overflow-x-auto">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onChange={(id) => handleTabChange(id as VisibleSeparacaoTab)}
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
                  {TAB_STATUS_MAP[activeTab].reduce((sum, s) => sum + (counts[s] ?? 0), 0)}
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
                placeholder="Buscar pedido, cliente, SKU, GTIN..."
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

            {allTags.length > 0 && (
              <select
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                className="h-9 rounded-xl border border-line bg-surface px-3 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
              >
                <option value="">Todas tags</option>
                {allTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            )}

            {activeTab === "aguardando_compra" && fornecedorOptions.length > 0 && (
              <select
                value={fornecedorFilter}
                onChange={(e) => setFornecedorFilter(e.target.value)}
                className="h-9 rounded-xl border border-line bg-surface px-3 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
              >
                <option value="">Todos fornecedores</option>
                {fornecedorOptions.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            )}

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
              {tagFilter && <ContextChip label="Tag" value={tagFilter} />}
              {fornecedorFilter && <ContextChip label="Fornecedor" value={fornecedorFilter} />}
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

        {/* Tag action — all tabs when items selected */}
        {selectedIds.size > 0 && (
          <div className="relative flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setTagModalOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-950/50"
            >
              <Tag className="h-3.5 w-3.5" />
              Tag ({selectedIds.size})
            </button>

            {tagModalOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-line bg-paper p-3 shadow-lg">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && tagInput.trim()) {
                        e.preventDefault();
                        handleAddTag(tagInput);
                      }
                      if (e.key === "Escape") setTagModalOpen(false);
                    }}
                    placeholder="Nome da tag..."
                    autoFocus
                    className="h-8 flex-1 rounded-lg border border-line bg-surface px-2.5 text-xs text-ink placeholder:text-ink-faint focus:border-blue-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!tagInput.trim() || tagActionLoading}
                    onClick={() => handleAddTag(tagInput)}
                    className="inline-flex h-8 items-center gap-1 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" />
                    Add
                  </button>
                </div>

                {/* Existing tags as quick-add */}
                {allTags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {allTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        disabled={tagActionLoading}
                        onClick={() => handleAddTag(tag)}
                        className="rounded bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600 transition-colors hover:bg-blue-100 disabled:opacity-40 dark:bg-blue-950/30 dark:text-blue-400 dark:hover:bg-blue-950/50"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}

                {/* Remove tags from selection */}
                {(() => {
                  const selectedPedidos = pedidos.filter((p) => selectedIds.has(p.id));
                  const tagsInSelection = new Set<string>();
                  for (const p of selectedPedidos) {
                    for (const t of p.separacao_tags) tagsInSelection.add(t);
                  }
                  if (tagsInSelection.size === 0) return null;
                  return (
                    <div className="mt-2 border-t border-line pt-2">
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                        Remover
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {Array.from(tagsInSelection).map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            disabled={tagActionLoading}
                            onClick={() => handleRemoveTag(tag)}
                            className="inline-flex items-center gap-0.5 rounded bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-600 transition-colors hover:bg-red-100 disabled:opacity-40 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50"
                          >
                            <X className="h-2 w-2" />
                            {tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* Action buttons per tab */}
        {activeTab === "aguardando_compra" && pedidos.length > 0 && (() => {
          const engatilhados = (() => {
            if (selectedIds.size > 0) {
              return pedidos.filter((p) => selectedIds.has(p.id) && p.nf_emitida && p.agrupamento_criado);
            }
            return pedidos.filter((p) => p.nf_emitida && p.agrupamento_criado);
          })();
          const engatilhadoCount = engatilhados.length;
          return (
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
                onClick={() => handleSepararSelecionados("pick-oc")}
                disabled={actionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                <Play className="h-3.5 w-3.5" />
                {actionLoading
                  ? "Iniciando..."
                  : `Separar ${selectedIds.size > 0 ? selectedIds.size : pedidos.length} pedido(s)`}
              </button>
              <button
                type="button"
                onClick={() => {
                  const ids = engatilhados.map((p) => p.id);
                  router.push(`/separacao/embalagem?pedidos=${ids.join(",")}&modo=embalagem-oc`);
                }}
                disabled={engatilhadoCount === 0 || actionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Package className="h-3.5 w-3.5" />
                {`Embalar ${engatilhadoCount} pedido(s)`}
              </button>
            </div>
          </div>
          );
        })()}

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
                onClick={() => handleSepararSelecionados()}
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
                onClick={() => handleSepararSelecionados()}
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
                galpoes={allGalpoes}
                onEncaminhar={handleEncaminhar}
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
