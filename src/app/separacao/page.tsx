"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Home, LogOut, Search, PackageCheck, Play, ShieldAlert, Printer, Undo2 } from "lucide-react";
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
import { CARGO_LABELS } from "@/types";
import type { Tab, StatusSeparacao, SeparacaoCounts } from "@/types";

// 6 tabs mapping 1:1 to StatusSeparacao values
const TAB_CONFIG: {
  id: StatusSeparacao;
  label: string;
  emptyMessage: string;
}[] = [
  {
    id: "aguardando_compra",
    label: "Aguardando OC",
    emptyMessage: "Nenhum pedido aguardando ordem de compra",
  },
  {
    id: "aguardando_nf",
    label: "Aguardando NF",
    emptyMessage: "Nenhum pedido aguardando nota fiscal",
  },
  {
    id: "aguardando_separacao",
    label: "Aguardando Separacao",
    emptyMessage: "Nenhum pedido aguardando separacao",
  },
  {
    id: "em_separacao",
    label: "Em Separacao",
    emptyMessage: "Nenhum pedido em separacao",
  },
  {
    id: "separado",
    label: "Separados",
    emptyMessage: "Nenhum pedido separado",
  },
  {
    id: "embalado",
    label: "Embalados",
    emptyMessage: "Nenhum pedido embalado",
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

// Revert target options per current tab
const REVERT_TARGETS: Partial<Record<StatusSeparacao, { value: StatusSeparacao; label: string }[]>> = {
  embalado: [
    { value: "separado", label: "Separado" },
    { value: "aguardando_separacao", label: "Aguardando Separacao" },
  ],
  separado: [
    { value: "em_separacao", label: "Em Separacao" },
    { value: "aguardando_separacao", label: "Aguardando Separacao" },
  ],
  em_separacao: [
    { value: "aguardando_separacao", label: "Aguardando Separacao" },
  ],
};

interface SeparacaoResponse {
  counts: SeparacaoCounts;
  pedidos: SeparacaoPedido[];
  empresas: { id: string; nome: string }[];
}

export default function SeparacaoPage() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<StatusSeparacao>("aguardando_separacao");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Filter state (only applies to aguardando_separacao tab)
  const [empresaFilter, setEmpresaFilter] = useState("");
  const [sortFilter, setSortFilter] = useState("data_pedido");
  const [busca, setBusca] = useState("");

  // Action loading states
  const [actionLoading, setActionLoading] = useState(false);
  const [revertMenuOpen, setRevertMenuOpen] = useState(false);

  // Realtime: auto-refresh when other operators change order statuses
  useRealtimeSeparacao();

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    if (sortFilter !== "data_pedido") params.set("sort", sortFilter);
    if (busca.trim()) params.set("busca", busca.trim());
    return params.toString();
  }, [activeTab, empresaFilter, sortFilter, busca]);

  // Fetch pedidos for active tab + counts for all tabs
  const {
    data,
    isLoading: isFetching,
    refetch,
  } = useQuery<SeparacaoResponse>({
    queryKey: ["separacao", queryParams],
    queryFn: async () => {
      const res = await sisoFetch(`/api/separacao?${queryParams}`);
      if (!res.ok) return { counts: EMPTY_COUNTS, pedidos: [] };
      return res.json();
    },
    enabled: canFetch,
    refetchInterval: 10000,
  });

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
        setSelectedIds(new Set());
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

  async function handleVoltarEtapa(novoStatus: StatusSeparacao) {
    if (selectedIds.size === 0) return;
    setActionLoading(true);
    setRevertMenuOpen(false);
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
        toast.success(`${body.total} pedido(s) revertido(s)`);
        setSelectedIds(new Set());
        refetch();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao voltar etapa");
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

  const isAdmin = user.cargo === "admin";
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
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pedidos.map((p) => p.id)));
    }
  }

  const revertTargets = REVERT_TARGETS[activeTab];

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
            title="Inicio"
          >
            <Home className="h-4 w-4" />
          </Link>
          <div className="flex-1">
            <h1 className="text-base font-bold tracking-tight text-ink">
              Separacao
            </h1>
            <p className="text-[11px] text-ink-faint">
              Separacao fisica por galpao
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
              <span className="font-mono text-xs font-semibold text-ink">
                {user.nome}
              </span>
              <span className="text-[10px] text-ink-faint">
                {CARGO_LABELS[user.cargo]}
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

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-4">
        {/* Tabs */}
        <div className="overflow-x-auto">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onChange={(id) => {
              setActiveTab(id as StatusSeparacao);
              setSelectedIds(new Set());
              setRevertMenuOpen(false);
            }}
          />
        </div>

        {/* Filter bar — all tabs */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar pedido, cliente..."
              className="h-8 w-full rounded-lg border border-line bg-paper pl-8 pr-3 text-xs text-ink placeholder:text-ink-faint focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
            />
          </div>

          {/* Empresa dropdown */}
          {empresaOptions.length > 0 && (
            <select
              value={empresaFilter}
              onChange={(e) => setEmpresaFilter(e.target.value)}
              className="h-8 rounded-lg border border-line bg-paper px-2 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
            >
              <option value="">Todas empresas</option>
              {empresaOptions.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.nome}
                </option>
              ))}
            </select>
          )}

          {/* Sort dropdown */}
          <select
            value={sortFilter}
            onChange={(e) => setSortFilter(e.target.value)}
            className="h-8 rounded-lg border border-line bg-paper px-2 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

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
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-faint">
              {selectedIds.size > 0
                ? `${selectedIds.size} selecionado(s)`
                : `${pedidos.length} pedido(s)`}
            </span>
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
        )}

        {activeTab === "separado" && pedidos.length > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-faint">
              {selectedIds.size > 0
                ? `${selectedIds.size} selecionado(s)`
                : `${pedidos.length} pedido(s)`}
            </span>
            <div className="flex items-center gap-2">
              {isAdmin && revertTargets && selectedIds.size > 0 && (
                <RevertButton
                  targets={revertTargets}
                  open={revertMenuOpen}
                  onToggle={() => setRevertMenuOpen((v) => !v)}
                  onSelect={handleVoltarEtapa}
                  disabled={actionLoading}
                  count={selectedIds.size}
                />
              )}
              <button
                type="button"
                onClick={handleEmbalarSelecionados}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                <PackageCheck className="h-3.5 w-3.5" />
                {selectedIds.size > 0
                  ? `Embalar ${selectedIds.size} pedido(s)`
                  : `Embalar ${pedidos.length} pedido(s)`}
              </button>
            </div>
          </div>
        )}

        {activeTab === "embalado" && pedidos.length > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-faint">
              {selectedIds.size > 0
                ? `${selectedIds.size} selecionado(s)`
                : `${pedidos.length} pedido(s)`}
            </span>
            <div className="flex items-center gap-2">
              {isAdmin && revertTargets && selectedIds.size > 0 && (
                <RevertButton
                  targets={revertTargets}
                  open={revertMenuOpen}
                  onToggle={() => setRevertMenuOpen((v) => !v)}
                  onSelect={handleVoltarEtapa}
                  disabled={actionLoading}
                  count={selectedIds.size}
                />
              )}
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
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-faint">
              {selectedIds.size > 0
                ? `${selectedIds.size} selecionado(s)`
                : `${pedidos.length} pedido(s)`}
            </span>
            <div className="flex items-center gap-2">
              {isAdmin && revertTargets && selectedIds.size > 0 && (
                <RevertButton
                  targets={revertTargets}
                  open={revertMenuOpen}
                  onToggle={() => setRevertMenuOpen((v) => !v)}
                  onSelect={handleVoltarEtapa}
                  disabled={actionLoading}
                  count={selectedIds.size}
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

        {activeTab === "aguardando_nf" && isAdmin && pedidos.length > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-faint">
              {selectedIds.size > 0
                ? `${selectedIds.size} selecionado(s)`
                : `${pedidos.length} pedido(s)`}
            </span>
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
                checkbox={showCheckbox}
                checked={selectedIds.has(pedido.id)}
                onToggle={toggleSelected}
                onRefetch={refetch}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Revert dropdown button (page-level, no overflow issues) ─────────────────

function RevertButton({
  targets,
  open,
  onToggle,
  onSelect,
  disabled,
  count,
}: {
  targets: { value: StatusSeparacao; label: string }[];
  open: boolean;
  onToggle: () => void;
  onSelect: (status: StatusSeparacao) => void;
  disabled: boolean;
  count: number;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50"
      >
        <Undo2 className="h-3.5 w-3.5" />
        Voltar {count} pedido(s)
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[200px] rounded-lg border border-line bg-paper py-1 shadow-lg">
          <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Voltar para
          </p>
          {targets.map((t) => (
            <button
              key={t.value}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink transition-colors hover:bg-surface"
              onClick={() => onSelect(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
