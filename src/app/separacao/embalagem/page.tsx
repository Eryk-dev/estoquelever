"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  ScanBarcode,
  CheckCircle2,
  Circle,
} from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { CARGO_LABELS } from "@/types";
import type { SeparacaoPedido } from "@/components/separacao/separacao-card";

// --- Types ---

interface LastScannedItem {
  descricao: string;
  sku: string;
  quantidade_bipada: number;
  pedido_id: string;
  pedido_completo: boolean;
}

// --- Page ---

export default function EmbalagemPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const pedidoIds = useMemo(() => {
    const param = searchParams.get("pedidos");
    return param ? param.split(",").filter(Boolean) : [];
  }, [searchParams]);

  const [scanValue, setScanValue] = useState("");
  const [scanQty, setScanQty] = useState(1);
  const [lastScanned, setLastScanned] = useState<LastScannedItem | null>(null);
  const [highlightedPedidoId, setHighlightedPedidoId] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  // Auth redirect
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  // Fetch pedidos from API
  const queryKey = useMemo(
    () => ["embalagem-pedidos", pedidoIds.join(",")],
    [pedidoIds],
  );

  const { data, isLoading } = useQuery<{ pedidos: SeparacaoPedido[] }>({
    queryKey,
    queryFn: async () => {
      // Fetch separado orders — the embalagem page shows these
      const res = await sisoFetch("/api/separacao?status_separacao=separado");
      if (!res.ok) return { pedidos: [] };
      const json = await res.json();
      return { pedidos: json.pedidos ?? [] };
    },
    enabled: !!user && pedidoIds.length > 0,
    refetchInterval: 5000,
  });

  // Filter pedidos to only the ones from URL params
  // Also include any that transitioned to 'embalado' during this session
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
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());

  // Scan handler
  const handleScan = useCallback(async () => {
    const sku = scanValue.trim();
    setScanValue("");
    if (!sku || !galpaoId) {
      if (!galpaoId) toast.error("Galpao nao identificado");
      return;
    }

    try {
      const res = await sisoFetch("/api/separacao/bipar-embalagem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku,
          galpao_id: galpaoId,
          quantidade: scanQty,
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

      // Update "Ultimo item lido"
      setLastScanned({
        descricao: sku, // We use SKU as description since the API doesn't return it
        sku,
        quantidade_bipada: result.quantidade_bipada,
        pedido_id: result.pedido_id,
        pedido_completo: result.pedido_completo,
      });

      // Highlight matched order
      setHighlightedPedidoId(result.pedido_id);
      setTimeout(() => setHighlightedPedidoId(null), 2000);

      if (result.pedido_completo) {
        setCompletedIds((prev) => new Set(prev).add(result.pedido_id));
        toast.success("Pedido embalado — etiqueta enviada");
      }

      // Refresh data to update progress
      queryClient.invalidateQueries({ queryKey });
    } catch {
      toast.error("Erro de conexao");
    } finally {
      scanRef.current?.focus();
    }
  }, [scanValue, scanQty, galpaoId, queryClient, queryKey]);

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
  const completedPedidos = pedidos.filter((p) => completedIds.has(p.id));

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link
            href="/separacao"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
            title="Voltar"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex-1">
            <h1 className="text-base font-bold tracking-tight text-ink">
              Embalagem
            </h1>
            <p className="text-[11px] text-ink-faint">
              {pedidoIds.length} pedido(s) — Bipagem e conferencia
            </p>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
            <span className="font-mono text-xs font-semibold text-ink">
              {user.nome}
            </span>
            <span className="text-[10px] text-ink-faint">
              {CARGO_LABELS[user.cargo]}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-4">
        {/* Scan input */}
        <div className="rounded-xl border border-line bg-paper px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <ScanBarcode className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <input
                ref={scanRef}
                type="text"
                value={scanValue}
                onChange={(e) => setScanValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleScan();
                  }
                }}
                placeholder="Bipar SKU ou GTIN..."
                autoFocus
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
          </div>
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
        ) : pedidos.length === 0 ? (
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
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// --- Order Row Component ---

function EmbalagemOrderRow({
  pedido,
  highlighted,
  completed,
}: {
  pedido: SeparacaoPedido;
  highlighted: boolean;
  completed?: boolean;
}) {
  const totalItens = pedido.total_itens || 0;
  const itensBipados = pedido.itens_bipados || 0;
  const isComplete = completed || itensBipados >= totalItens;

  return (
    <article
      className={cn(
        "flex items-center gap-3 rounded-xl border px-4 py-3 transition-all duration-300",
        isComplete
          ? "border-emerald-200 bg-emerald-50/30 dark:border-emerald-800 dark:bg-emerald-950/10"
          : "border-line bg-paper",
        highlighted &&
          "ring-2 ring-blue-400 border-blue-300 bg-blue-50/50 dark:ring-blue-500 dark:border-blue-600 dark:bg-blue-950/20",
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
    </article>
  );
}
