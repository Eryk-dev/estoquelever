"use client";

import { useState, useEffect, useMemo, useRef, useCallback, Suspense, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  ScanBarcode,
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronUp,
  Plus,
  Minus,
  Save,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { GalpaoSelector } from "@/components/galpao-selector";
import type { SeparacaoPedido } from "@/components/separacao/separacao-card";

// --- Types ---

interface LastScannedItem {
  descricao: string;
  sku: string;
  quantidade_bipada: number;
  pedido_id: string;
  pedido_completo: boolean;
}

interface PedidoItem {
  id: string;
  pedido_id: string;
  produto_id: string;
  sku: string;
  gtin: string | null;
  descricao: string;
  quantidade: number;
  quantidade_bipada: number;
  bipado_completo: boolean;
  localizacao: string | null;
  imagem_url: string | null;
}

// --- Page ---

export default function EmbalagemPageWrapper() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <EmbalagemPage />
    </Suspense>
  );
}

function EmbalagemPage() {
  const { user, loading, activeGalpaoId } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const pedidoIds = useMemo(() => {
    const param = searchParams.get("pedidos");
    return param ? param.split(",").filter(Boolean) : [];
  }, [searchParams]);

  const [scanQty, setScanQty] = useState(1);
  const [lastScanned, setLastScanned] = useState<LastScannedItem | null>(null);
  const [highlightedPedidoId, setHighlightedPedidoId] = useState<
    string | null
  >(null);
  const [expandedPedidoIds, setExpandedPedidoIds] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const toggleExpandedPedido = useCallback((pedidoId: string) => {
    setExpandedPedidoIds((prev) => {
      const next = new Set(prev);
      if (next.has(pedidoId)) {
        next.delete(pedidoId);
      } else {
        next.add(pedidoId);
      }
      return next;
    });
  }, []);

  // Auth redirect
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  // Fetch pedidos from API
  const pedidosQueryKey = useMemo(
    () => ["embalagem-pedidos", activeGalpaoId ?? "all", pedidoIds.join(",")],
    [activeGalpaoId, pedidoIds],
  );

  const { data, isLoading } = useQuery<{ pedidos: SeparacaoPedido[] }>({
    queryKey: pedidosQueryKey,
    queryFn: async () => {
      const res = await sisoFetch("/api/separacao?status_separacao=separado");
      if (!res.ok) return { pedidos: [] };
      const json = await res.json();
      return { pedidos: json.pedidos ?? [] };
    },
    enabled: !!user && pedidoIds.length > 0,
    refetchInterval: 5000,
  });

  // Fetch items for expanded pedido
  const itemsQueryKey = useMemo(
    () => ["embalagem-items", activeGalpaoId ?? "all", pedidoIds.join(",")],
    [activeGalpaoId, pedidoIds],
  );

  const { data: itemsData } = useQuery<{ items: PedidoItem[] }>({
    queryKey: itemsQueryKey,
    queryFn: async () => {
      const res = await sisoFetch(
        `/api/separacao/checklist-items?pedidos=${pedidoIds.join(",")}`,
      );
      if (!res.ok) return { items: [] };
      return res.json();
    },
    enabled: !!user && pedidoIds.length > 0,
  });

  // Group items by pedido_id
  const itemsByPedido = useMemo(() => {
    const map = new Map<string, PedidoItem[]>();
    for (const item of itemsData?.items ?? []) {
      const list = map.get(item.pedido_id) ?? [];
      list.push(item);
      map.set(item.pedido_id, list);
    }
    return map;
  }, [itemsData]);

  // Filter pedidos to only the ones from URL params
  const allPedidos = useMemo(() => data?.pedidos ?? [], [data?.pedidos]);

  const pedidos = useMemo(() => {
    return allPedidos.filter((p) => pedidoIds.includes(p.id));
  }, [allPedidos, pedidoIds]);

  // Derive galpao_id from first pedido
  const galpaoId = useMemo(() => {
    for (const p of pedidos) {
      if (p.galpao_id) return p.galpao_id;
    }
    return null;
  }, [pedidos]);

  // Track completed pedidos (transitioned to embalado during this session)
  // Store full pedido data so it persists after API stops returning them
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const completedPedidoData = useRef<Map<string, SeparacaoPedido>>(new Map());

  // Handle pedido completion (shared between scan and manual)
  const handlePedidoComplete = useCallback(
    (pedidoId: string, etiquetaStatus?: string, etiquetaErro?: string | null) => {
      // Save pedido data before it disappears from the API response
      const pedidoData = allPedidos.find((p) => p.id === pedidoId);
      if (pedidoData) {
        completedPedidoData.current.set(pedidoId, pedidoData);
      }
      setCompletedIds((prev) => new Set(prev).add(pedidoId));

      if (etiquetaStatus === "falhou") {
        toast.error(
          `Pedido embalado — FALHA na etiqueta${etiquetaErro ? `: ${etiquetaErro}` : ""}. Use reimprimir.`,
          { duration: 8000 },
        );
      } else if (etiquetaStatus === "impresso") {
        toast.success("Pedido embalado — etiqueta impressa");
      } else {
        toast.success("Pedido embalado");
      }

      queryClient.invalidateQueries({ queryKey: pedidosQueryKey });
      queryClient.invalidateQueries({ queryKey: itemsQueryKey });
    },
    [allPedidos, queryClient, pedidosQueryKey, itemsQueryKey],
  );

  // Scan handler
  const handleScan = useCallback(async (rawCode?: string) => {
    const sku = (rawCode ?? scanRef.current?.value ?? "").trim();
    if (scanRef.current) {
      scanRef.current.value = "";
    }
    if (!sku || !galpaoId) {
      if (!galpaoId) toast.error("Galpao nao identificado");
      return;
    }

    const qty = scanQty;
    setScanQty(1);

    try {
      const res = await sisoFetch("/api/separacao/bipar-embalagem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku,
          galpao_id: galpaoId,
          quantidade: qty,
        }),
      });

      if (res.status === 404) {
        toast.error("Nenhum pedido com este SKU pendente");
        scanRef.current?.focus();
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao bipar");
        scanRef.current?.focus();
        return;
      }

      const result = await res.json();

      setLastScanned({
        descricao: sku,
        sku,
        quantidade_bipada: result.quantidade_bipada,
        pedido_id: result.pedido_id,
        pedido_completo: result.pedido_completo,
      });

      setHighlightedPedidoId(result.pedido_id);
      setTimeout(() => setHighlightedPedidoId(null), 2000);

      if (result.pedido_completo) {
        handlePedidoComplete(result.pedido_id, result.etiqueta_status, result.etiqueta_erro);
      } else {
        queryClient.invalidateQueries({ queryKey: pedidosQueryKey });
        queryClient.invalidateQueries({ queryKey: itemsQueryKey });
      }
    } catch {
      toast.error("Erro de conexao");
    } finally {
      scanRef.current?.focus();
    }
  }, [
    scanQty,
    galpaoId,
    queryClient,
    pedidosQueryKey,
    itemsQueryKey,
    handlePedidoComplete,
  ]);

  const handleScanSubmit = useCallback((e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void handleScan(scanRef.current?.value);
  }, [handleScan]);

  // Manual +/- handler with optimistic UI
  const handleConfirmItem = useCallback(
    async (item: PedidoItem, delta: number) => {
      const optimisticBipada = Math.max(0, item.quantidade_bipada + delta);
      const optimisticComplete = optimisticBipada >= item.quantidade;

      // Optimistic update
      queryClient.setQueryData<{ items: PedidoItem[] }>(
        itemsQueryKey,
        (old) => {
          if (!old) return old;
          return {
            items: old.items.map((i) =>
              i.id === item.id
                ? {
                    ...i,
                    quantidade_bipada: optimisticBipada,
                    bipado_completo: optimisticComplete,
                  }
                : i,
            ),
          };
        },
      );

      try {
        const res = await sisoFetch(
          "/api/separacao/confirmar-item-embalagem",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pedido_item_id: item.id,
              quantidade: delta,
            }),
          },
        );

        if (!res.ok) {
          // Revert optimistic update
          queryClient.invalidateQueries({ queryKey: itemsQueryKey });
          const body = await res.json().catch(() => ({}));
          toast.error(body.error ?? "Erro ao confirmar item");
          return;
        }

        const result = await res.json();

        if (result.pedido_completo) {
          handlePedidoComplete(item.pedido_id, result.etiqueta_status, result.etiqueta_erro);
        } else {
          // Sync with server response
          queryClient.setQueryData<{ items: PedidoItem[] }>(
            itemsQueryKey,
            (old) => {
              if (!old) return old;
              return {
                items: old.items.map((i) =>
                  i.id === item.id
                    ? {
                        ...i,
                        quantidade_bipada: result.quantidade_bipada,
                        bipado_completo: result.bipado_completo,
                      }
                    : i,
                ),
              };
            },
          );
          queryClient.invalidateQueries({ queryKey: pedidosQueryKey });
        }
      } catch {
        // Revert optimistic update
        queryClient.invalidateQueries({ queryKey: itemsQueryKey });
        toast.error("Erro de conexao");
      }
    },
    [
      queryClient,
      itemsQueryKey,
      pedidosQueryKey,
      handlePedidoComplete,
    ],
  );

  // Reiniciar progresso handler
  const handleReiniciar = useCallback(async () => {
    const activePedidoIds = pedidoIds.filter((id) => !completedIds.has(id));
    if (activePedidoIds.length === 0) return;

    if (
      !window.confirm(
        "Reiniciar progresso de embalagem? Todas as bipagens serao zeradas.",
      )
    )
      return;

    setActionLoading(true);
    try {
      const res = await sisoFetch("/api/separacao/reiniciar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_ids: activePedidoIds,
          etapa: "embalagem",
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao reiniciar");
        return;
      }

      toast.success("Progresso reiniciado");
      queryClient.invalidateQueries({ queryKey: pedidosQueryKey });
      queryClient.invalidateQueries({ queryKey: itemsQueryKey });
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setActionLoading(false);
    }
  }, [pedidoIds, completedIds, queryClient, pedidosQueryKey, itemsQueryKey]);

  // --- Render ---

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <LoadingSpinner />
      </div>
    );
  }

  if (!user) return null;

  if (pedidoIds.length === 0) {
    return (
      <div className="min-h-screen bg-surface">
        <div className="mx-auto max-w-5xl px-4 py-8">
          <EmptyState message="Nenhum pedido selecionado" />
        </div>
      </div>
    );
  }

  // Separate active (separado) and completed (embalado during session)
  const activePedidos = pedidos.filter((p) => !completedIds.has(p.id));
  // Use stored data for completed pedidos (persists even after API stops returning them)
  const completedPedidos = Array.from(completedIds)
    .map((id) => completedPedidoData.current.get(id) ?? pedidos.find((p) => p.id === id))
    .filter((p): p is SeparacaoPedido => p !== undefined);

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-line bg-paper">
        <div className="mx-auto flex max-w-5xl items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3">
          <Link
            href="/separacao"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink shrink-0"
            title="Voltar"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm sm:text-base font-bold tracking-tight text-ink">
              Embalagem
            </h1>
            <p className="text-[11px] text-ink-faint">
              {pedidoIds.length} pedido(s) — Bipagem e conferencia
            </p>
          </div>
          <GalpaoSelector />
          <div className="hidden sm:flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
            <span className="font-mono text-xs font-semibold text-ink">
              {user.nome}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-3 sm:px-4 py-3 sm:py-4">
        {/* Scan input */}
        <div className="rounded-xl border border-line bg-paper px-4 py-3">
          <form onSubmit={handleScanSubmit} className="flex items-center gap-2">
            <div className="relative flex-1">
              <ScanBarcode className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <input
                ref={scanRef}
                type="text"
                placeholder="Bipar SKU ou GTIN..."
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                className="h-10 w-full rounded-xl border border-line bg-surface pl-10 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
              />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-ink-faint" htmlFor="scan-qty">
                Qtd
              </label>
              <input
                id="scan-qty"
                type="number"
                min={1}
                value={scanQty}
                onChange={(e) =>
                  setScanQty(Math.max(1, parseInt(e.target.value) || 1))
                }
                className="h-10 w-16 rounded-xl border border-line bg-surface px-2 text-center font-mono text-sm text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
              />
            </div>
            <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          </form>
        </div>

        {/* Ultimo item lido */}
        {lastScanned && (
          <div
            className={cn(
              "rounded-xl border px-4 py-3 transition-colors",
              lastScanned.pedido_completo
                ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20"
                : "border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20",
            )}
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              Ultimo item lido
            </p>
            <div className="mt-1 flex items-center gap-3">
              <span className="font-mono text-sm font-bold text-ink">
                {lastScanned.sku}
              </span>
              <span className="text-xs text-ink-faint">
                Bipado: {lastScanned.quantidade_bipada}
              </span>
              {lastScanned.pedido_completo && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  Pedido completo
                </span>
              )}
            </div>
          </div>
        )}

        {/* Order list */}
        {isLoading ? (
          <LoadingSpinner message="Carregando pedidos..." />
        ) : pedidos.length === 0 && completedPedidos.length === 0 ? (
          <EmptyState message="Nenhum pedido encontrado" />
        ) : (
          <div className="space-y-3">
            {/* Active orders */}
            {activePedidos.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-ink-faint">
                  Pendentes ({activePedidos.length})
                </p>
                {activePedidos.map((pedido) => (
                  <EmbalagemOrderRow
                    key={pedido.id}
                    pedido={pedido}
                    highlighted={highlightedPedidoId === pedido.id}
                    expanded={expandedPedidoIds.has(pedido.id)}
                    onToggleExpand={() => toggleExpandedPedido(pedido.id)}
                    items={itemsByPedido.get(pedido.id) ?? []}
                    onConfirmItem={handleConfirmItem}
                  />
                ))}
              </div>
            )}

            {/* Completed orders */}
            {completedPedidos.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  Embalados ({completedPedidos.length})
                </p>
                {completedPedidos.map((pedido) => (
                  <EmbalagemOrderRow
                    key={pedido.id}
                    pedido={pedido}
                    highlighted={false}
                    completed
                    expanded={expandedPedidoIds.has(pedido.id)}
                    onToggleExpand={() => toggleExpandedPedido(pedido.id)}
                    items={itemsByPedido.get(pedido.id) ?? []}
                    onConfirmItem={handleConfirmItem}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3 border-t border-line pt-4">
          <button
            onClick={() => router.push("/separacao")}
            disabled={actionLoading}
            className="inline-flex items-center gap-2 rounded-xl border border-line bg-paper px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface disabled:opacity-50"
          >
            {activePedidos.length === 0 ? (
              <>
                <ArrowLeft className="h-4 w-4" />
                Voltar
              </>
            ) : (
              <>
                <Save className="h-4 w-4" />
                Salvar para depois
              </>
            )}
          </button>
          <button
            onClick={handleReiniciar}
            disabled={actionLoading || activePedidos.length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-paper px-4 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/20"
          >
            <RotateCcw className="h-4 w-4" />
            Reiniciar progresso
          </button>
        </div>
      </main>
    </div>
  );
}

// --- Order Row Component (expandable) ---

function EmbalagemOrderRow({
  pedido,
  highlighted,
  completed,
  expanded,
  onToggleExpand,
  items,
  onConfirmItem,
}: {
  pedido: SeparacaoPedido;
  highlighted: boolean;
  completed?: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  items: PedidoItem[];
  onConfirmItem: (item: PedidoItem, delta: number) => void;
}) {
  const totalItens = pedido.total_itens || 0;
  const itensBipados = pedido.itens_bipados || 0;
  const isComplete = completed || itensBipados >= totalItens;

  return (
    <article
      className={cn(
        "overflow-hidden rounded-xl border transition-all duration-300",
        isComplete
          ? "border-emerald-200 bg-emerald-50/30 dark:border-emerald-800 dark:bg-emerald-950/10"
          : "border-line bg-paper",
        highlighted &&
          "ring-2 ring-blue-400 border-blue-300 bg-blue-50/50 dark:ring-blue-500 dark:border-blue-600 dark:bg-blue-950/20",
      )}
    >
      {/* Clickable header */}
      <button
        type="button"
        onClick={onToggleExpand}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left cursor-pointer hover:bg-zinc-50/50 dark:hover:bg-zinc-800/20",
        )}
      >
        {/* Status dot */}
        <div className="shrink-0">
          {isComplete ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          ) : itensBipados > 0 ? (
            <Circle className="h-5 w-5 fill-amber-400 text-amber-400" />
          ) : (
            <Circle className="h-5 w-5 text-zinc-300 dark:text-zinc-600" />
          )}
        </div>

        {/* Order info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold text-ink">
              #{pedido.numero_pedido}
            </span>
            <span className="h-3 w-px bg-line" aria-hidden="true" />
            <span
              className="min-w-0 flex-1 truncate text-sm text-zinc-600 dark:text-zinc-300"
              title={pedido.cliente ?? ""}
            >
              {pedido.cliente ?? "---"}
            </span>
          </div>
          {pedido.empresa_origem_nome && (
            <span className="mt-0.5 inline-block rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {pedido.empresa_origem_nome}
            </span>
          )}
        </div>

        {/* Progress */}
        <div className="shrink-0 text-right">
          <span
            className={cn(
              "font-mono text-sm font-semibold tabular-nums",
              isComplete
                ? "text-emerald-600 dark:text-emerald-400"
                : itensBipados > 0
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-ink-faint",
            )}
          >
            {itensBipados}/{totalItens}
          </span>
          <p className="text-[10px] text-ink-faint">itens</p>
        </div>

        {/* Expand icon */}
        <div className="shrink-0 text-ink-faint">
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </button>

      {/* Expanded items */}
      {expanded && items.length > 0 && (
        <div className="border-t border-line">
          {items.map((item) => (
            <EmbalagemItemRow
              key={item.id}
              item={item}
              onConfirm={onConfirmItem}
              readOnly={isComplete}
            />
          ))}
        </div>
      )}
    </article>
  );
}

// --- Item Row Component (with +/- buttons) ---

function EmbalagemItemRow({
  item,
  onConfirm,
  readOnly,
}: {
  item: PedidoItem;
  onConfirm: (item: PedidoItem, delta: number) => void;
  readOnly?: boolean;
}) {
  const isDone = item.bipado_completo;

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-line/50 px-4 py-2.5 last:border-b-0",
        isDone && "bg-emerald-50/30 dark:bg-emerald-950/10",
      )}
      style={{ minHeight: "44px" }}
    >
      {/* Item image */}
      {item.imagem_url && (
        <img
          src={item.imagem_url}
          alt={item.sku}
          className="h-12 w-12 shrink-0 rounded-md border border-line object-cover bg-surface"
        />
      )}

      {/* Item info */}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm",
            isDone
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-ink",
          )}
          title={item.descricao}
        >
          {item.descricao}
        </p>
        <p className="text-[11px] text-ink-faint">
          <span className="font-mono">{item.sku}</span>
          {item.localizacao && (
            <span className="ml-2">Loc: {item.localizacao}</span>
          )}
        </p>
      </div>

      {/* Progress + buttons */}
      <div className="flex shrink-0 items-center gap-2">
        <span
          className={cn(
            "min-w-[3.5rem] text-center font-mono text-sm font-semibold tabular-nums",
            isDone
              ? "text-emerald-600 dark:text-emerald-400"
              : item.quantidade_bipada > 0
                ? "text-amber-600 dark:text-amber-400"
                : "text-ink-faint",
          )}
        >
          {item.quantidade_bipada}/{item.quantidade}
        </span>

        {!readOnly && (
          <>
            <button
              type="button"
              onClick={() => onConfirm(item, -1)}
              disabled={item.quantidade_bipada <= 0}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-faint transition-colors hover:bg-zinc-100 hover:text-ink disabled:opacity-30 dark:hover:bg-zinc-800"
              aria-label="Diminuir quantidade"
            >
              <Minus className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => onConfirm(item, 1)}
              disabled={isDone}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-faint transition-colors hover:bg-zinc-100 hover:text-ink disabled:opacity-30 dark:hover:bg-zinc-800"
              aria-label="Aumentar quantidade"
            >
              <Plus className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
