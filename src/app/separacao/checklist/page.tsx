"use client";

import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  MapPin,
  MapPinOff,
  Check,
  Package,
  ScanBarcode,
  CheckCircle2,
  RotateCcw,
  X,
  XCircle,
  Loader2,
  Pencil,
  Save,
} from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { CARGO_LABELS } from "@/types";

// ─── Types ───────────────────────────────────────────────────

interface ChecklistItem {
  id: string;
  pedido_id: string;
  produto_id: string;
  sku: string;
  gtin: string | null;
  descricao: string;
  quantidade: number;
  separacao_marcado: boolean;
  separacao_marcado_em: string | null;
  localizacao: string | null;
  imagem_url: string | null;
  empresa_origem_id: string | null;
}

interface ConsolidatedProduct {
  produto_id: string;
  sku: string;
  gtin: string | null;
  descricao: string;
  quantidade_total: number;
  localizacao: string | null;
  imagem_url: string | null;
  item_ids: string[];
  all_marcado: boolean;
  empresa_origem_id: string | null;
}

const SORT_OPTIONS = [
  { value: "localizacao", label: "Localizacao" },
  { value: "sku", label: "SKU" },
  { value: "descricao", label: "Nome" },
] as const;

// ─── Page ────────────────────────────────────────────────────

export default function ChecklistPageWrapper() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <ChecklistPage />
    </Suspense>
  );
}

function ChecklistPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const iniciarCalled = useRef(false);

  const pedidoIds = useMemo(() => {
    const param = searchParams.get("pedidos");
    return param ? param.split(",").filter(Boolean) : [];
  }, [searchParams]);

  const [sort, setSort] = useState<string>("localizacao");
  const [scanValue, setScanValue] = useState("");
  const [highlightedSku, setHighlightedSku] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [esgotadoLoading, setEsgotadoLoading] = useState<string | null>(null);
  const [editingLoc, setEditingLoc] = useState<string | null>(null); // produto_id being edited
  const [editLocValue, setEditLocValue] = useState("");
  const [savingLoc, setSavingLoc] = useState(false);
  const locInputRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  // Auth redirect
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  // Try to call iniciar on mount (for new separations — may 400 if already em_separacao)
  useEffect(() => {
    if (iniciarCalled.current || !user || pedidoIds.length === 0) return;
    iniciarCalled.current = true;

    sisoFetch("/api/separacao/iniciar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pedido_ids: pedidoIds,
        operador_id: user.id,
      }),
    }).catch(() => {
      // Orders may already be em_separacao — ignore
    });
  }, [pedidoIds, user]);

  // Fetch individual items
  const queryKey = useMemo(
    () => ["checklist-items", pedidoIds.join(",")],
    [pedidoIds],
  );

  const { data, isLoading } = useQuery<{ items: ChecklistItem[] }>({
    queryKey,
    queryFn: async () => {
      const res = await sisoFetch(
        `/api/separacao/checklist-items?pedidos=${pedidoIds.join(",")}`,
      );
      if (!res.ok) return { items: [] };
      return res.json();
    },
    enabled: !!user && pedidoIds.length > 0,
  });

  const items = useMemo(() => data?.items ?? [], [data?.items]);

  // Consolidate items by produto_id
  const consolidated = useMemo(() => {
    const map = new Map<string, ConsolidatedProduct>();

    for (const item of items) {
      const key = item.produto_id;
      const existing = map.get(key);
      if (existing) {
        existing.quantidade_total += item.quantidade;
        existing.item_ids.push(item.id);
        if (!item.separacao_marcado) existing.all_marcado = false;
      } else {
        map.set(key, {
          produto_id: item.produto_id,
          sku: item.sku,
          gtin: item.gtin,
          descricao: item.descricao,
          quantidade_total: item.quantidade,
          localizacao: item.localizacao,
          imagem_url: item.imagem_url,
          item_ids: [item.id],
          all_marcado: item.separacao_marcado,
          empresa_origem_id: item.empresa_origem_id,
        });
      }
    }

    const result = Array.from(map.values());

    result.sort((a, b) => {
      if (sort === "sku") return a.sku.localeCompare(b.sku);
      if (sort === "descricao") return a.descricao.localeCompare(b.descricao);
      // Default: localizacao
      const aLoc = a.localizacao ?? "\uffff";
      const bLoc = b.localizacao ?? "\uffff";
      return aLoc.localeCompare(bLoc);
    });

    return result;
  }, [items, sort]);

  // Progress
  const totalProducts = consolidated.length;
  const marcadoProducts = consolidated.filter((p) => p.all_marcado).length;
  const progressPct =
    totalProducts > 0 ? (marcadoProducts / totalProducts) * 100 : 0;

  // Handle checkbox toggle
  async function handleToggle(product: ConsolidatedProduct) {
    const newMarcado = !product.all_marcado;

    // Optimistic update
    queryClient.setQueryData<{ items: ChecklistItem[] }>(queryKey, (old) => {
      if (!old) return old;
      return {
        items: old.items.map((item) =>
          product.item_ids.includes(item.id)
            ? {
                ...item,
                separacao_marcado: newMarcado,
                separacao_marcado_em: newMarcado
                  ? new Date().toISOString()
                  : null,
              }
            : item,
        ),
      };
    });

    // Call API for each underlying item
    try {
      const results = await Promise.all(
        product.item_ids.map((itemId) =>
          sisoFetch("/api/separacao/marcar-item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pedido_item_id: itemId,
              marcado: newMarcado,
            }),
          }),
        ),
      );

      if (results.some((r) => !r.ok)) {
        toast.error("Erro ao salvar marcacao");
        queryClient.invalidateQueries({ queryKey });
      }
    } catch {
      toast.error("Erro de conexao");
      queryClient.invalidateQueries({ queryKey });
    }
  }

  // Handle barcode scan
  async function handleScan() {
    const sku = scanValue.trim();
    setScanValue("");
    if (!sku) return;

    try {
      const res = await sisoFetch("/api/separacao/bipar-checklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku, pedido_ids: pedidoIds }),
      });

      if (res.status === 404) {
        toast.error("SKU nao encontrado");
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao bipar");
        return;
      }

      // Optimistic: mark matching items in cache
      queryClient.setQueryData<{ items: ChecklistItem[] }>(queryKey, (old) => {
        if (!old) return old;
        return {
          items: old.items.map((item) =>
            (item.sku === sku || item.gtin === sku) && !item.separacao_marcado
              ? { ...item, separacao_marcado: true, separacao_marcado_em: new Date().toISOString() }
              : item,
          ),
        };
      });

      // Brief highlight animation
      const matchedProduct = consolidated.find(
        (p) => p.sku === sku || p.gtin === sku,
      );
      if (matchedProduct) {
        setHighlightedSku(matchedProduct.produto_id);
        setTimeout(() => setHighlightedSku(null), 1500);
      }

      toast.success(`Item marcado: ${sku}`);
    } catch {
      toast.error("Erro de conexao");
    } finally {
      scanRef.current?.focus();
    }
  }

  // Handle concluir
  async function handleConcluir() {
    setActionLoading(true);
    try {
      const res = await sisoFetch("/api/separacao/concluir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: pedidoIds }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao concluir");
        return;
      }

      const { separados, pendentes } = (await res.json()) as {
        separados: string[];
        pendentes: string[];
      };

      const parts: string[] = [];
      if (separados.length > 0) parts.push(`${separados.length} separado(s)`);
      if (pendentes.length > 0) parts.push(`${pendentes.length} pendente(s)`);
      toast.success(parts.join(", "));

      queryClient.invalidateQueries({ queryKey: ["separacao"] });
      router.push("/separacao");
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setActionLoading(false);
    }
  }

  // Handle reiniciar
  async function handleReiniciar() {
    if (!window.confirm("Reiniciar progresso? Todas as marcacoes serao desmarcadas.")) return;

    setActionLoading(true);
    try {
      const res = await sisoFetch("/api/separacao/reiniciar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: pedidoIds, etapa: "separacao" }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao reiniciar");
        return;
      }

      toast.success("Progresso reiniciado");
      queryClient.invalidateQueries({ queryKey });
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setActionLoading(false);
    }
  }

  // Handle cancelar
  async function handleCancelar() {
    if (!window.confirm("Cancelar separacao? Pedidos voltarao para Aguardando Separacao.")) return;

    setActionLoading(true);
    try {
      const res = await sisoFetch("/api/separacao/cancelar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: pedidoIds }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao cancelar");
        return;
      }

      toast.success("Separacao cancelada");
      queryClient.invalidateQueries({ queryKey: ["separacao"] });
      router.push("/separacao");
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setActionLoading(false);
    }
  }

  // Handle location edit
  function startEditLocation(product: ConsolidatedProduct, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingLoc(product.produto_id);
    setEditLocValue(product.localizacao ?? "");
    setTimeout(() => locInputRef.current?.focus(), 50);
  }

  async function saveLocation(product: ConsolidatedProduct) {
    const trimmed = editLocValue.trim();
    if (trimmed === (product.localizacao ?? "")) {
      setEditingLoc(null);
      return;
    }

    if (!product.empresa_origem_id) {
      toast.error("Empresa de origem nao encontrada");
      setEditingLoc(null);
      return;
    }

    setSavingLoc(true);
    try {
      const res = await sisoFetch("/api/separacao/localizacao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          produto_id: Number(product.produto_id),
          localizacao: trimmed,
          empresa_id: product.empresa_origem_id,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Erro ao salvar localizacao");
        return;
      }

      // Optimistic update in cache
      queryClient.setQueryData<{ items: ChecklistItem[] }>(queryKey, (old) => {
        if (!old) return old;
        return {
          items: old.items.map((item) =>
            item.produto_id === product.produto_id
              ? { ...item, localizacao: trimmed || null }
              : item,
          ),
        };
      });

      toast.success(`Localizacao atualizada: ${trimmed || "(vazio)"}`);
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setSavingLoc(false);
      setEditingLoc(null);
    }
  }

  // Handle esgotado (product out of stock)
  async function handleEsgotado(sku: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (
      !window.confirm(
        `Marcar SKU ${sku} como esgotado?\n\nTODOS os pedidos em separacao com este produto serao movidos para Aguardando OC.`,
      )
    )
      return;

    setEsgotadoLoading(sku);
    try {
      const res = await sisoFetch("/api/separacao/produto-esgotado", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(
          `SKU ${sku} esgotado — ${data.pedidos_afetados} pedido(s) movido(s) para Aguardando OC`,
        );
        // If all pedidos were affected, go back to separation list
        if (data.pedidos_afetados >= pedidoIds.length) {
          queryClient.invalidateQueries({ queryKey: ["separacao"] });
          router.push("/separacao");
          return;
        }
        queryClient.invalidateQueries({ queryKey });
        queryClient.invalidateQueries({ queryKey: ["separacao"] });
      } else {
        toast.error(data.error ?? "Erro ao marcar como esgotado");
      }
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setEsgotadoLoading(null);
    }
  }

  // ─── Render ──────────────────────────────────────────────────

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
              Checklist de Separacao
            </h1>
            <p className="text-[11px] text-ink-faint">
              {pedidoIds.length} pedido(s) — Wave picking
            </p>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
            <span className="font-mono text-xs font-semibold text-ink">
              {user.nome}
            </span>
            <span className="text-[10px] text-ink-faint">
              {(user.cargos ?? [user.cargo]).map((c) => CARGO_LABELS[c]).join(", ")}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-4">
        {/* Progress indicator */}
        <div className="rounded-xl border border-line bg-paper px-4 py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-ink">
              <Package className="mr-1.5 inline-block h-4 w-4 text-ink-faint" />
              {marcadoProducts} de {totalProducts} itens marcados
            </span>
            <span className="font-mono text-xs text-ink-faint tabular-nums">
              {Math.round(progressPct)}%
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                progressPct >= 100
                  ? "bg-emerald-500"
                  : progressPct > 0
                    ? "bg-blue-500"
                    : "bg-zinc-300 dark:bg-zinc-600",
              )}
              style={{ width: `${Math.min(progressPct, 100)}%` }}
            />
          </div>
        </div>

        {/* Barcode scan input */}
        <div className="relative">
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
            className="h-10 w-full rounded-xl border border-line bg-paper pl-10 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
          />
        </div>

        {/* Sort dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-faint">Ordenar por:</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="h-8 rounded-lg border border-line bg-paper px-2 text-xs text-ink focus:border-zinc-400 focus:outline-none dark:focus:border-zinc-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Items list */}
        {isLoading ? (
          <LoadingSpinner message="Carregando itens..." />
        ) : consolidated.length === 0 ? (
          <EmptyState message="Nenhum item encontrado" />
        ) : (
          <div className="space-y-1">
            {consolidated.map((product) => (
              <button
                key={product.produto_id}
                type="button"
                onClick={() => handleToggle(product)}
                className={cn(
                  "flex w-full min-h-[44px] items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all duration-300",
                  product.all_marcado
                    ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20"
                    : "border-line bg-paper hover:bg-surface",
                  highlightedSku === product.produto_id &&
                    "ring-2 ring-blue-400 border-blue-300 bg-blue-50/50 dark:ring-blue-500 dark:border-blue-600 dark:bg-blue-950/20",
                )}
              >
                {/* Checkbox visual */}
                <div
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors",
                    product.all_marcado
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : "border-zinc-300 dark:border-zinc-600",
                  )}
                >
                  {product.all_marcado && <Check className="h-4 w-4" />}
                </div>

                {/* Product thumbnail */}
                <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-line bg-surface">
                  {product.imagem_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={product.imagem_url}
                      alt={product.sku}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <Package className="h-4 w-4 text-ink-faint" aria-hidden="true" />
                    </div>
                  )}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "font-mono text-xs font-semibold",
                        product.all_marcado
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-ink",
                      )}
                    >
                      {product.sku}
                    </span>
                    {product.gtin && (
                      <span className="text-[10px] text-ink-faint">
                        GTIN {product.gtin}
                      </span>
                    )}
                  </div>
                  <p
                    className={cn(
                      "truncate text-sm",
                      product.all_marcado
                        ? "text-emerald-600/60 line-through dark:text-emerald-400/60"
                        : "text-ink",
                    )}
                  >
                    {product.descricao}
                  </p>
                </div>

                {/* Quantity badge */}
                <span
                  className={cn(
                    "shrink-0 rounded-md px-2 py-0.5 font-mono text-sm font-semibold",
                    product.all_marcado
                      ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : "bg-zinc-100 text-ink dark:bg-zinc-800",
                  )}
                >
                  {product.quantidade_total}
                </span>

                {/* Location */}
                {editingLoc === product.produto_id ? (
                  <div
                    className="inline-flex shrink-0 items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      ref={locInputRef}
                      type="text"
                      value={editLocValue}
                      onChange={(e) => setEditLocValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); saveLocation(product); }
                        if (e.key === "Escape") { e.preventDefault(); setEditingLoc(null); }
                      }}
                      disabled={savingLoc}
                      placeholder="Ex: A1-02"
                      className="h-7 w-24 rounded-md border border-blue-300 bg-white px-2 font-mono text-xs text-ink focus:border-blue-500 focus:outline-none dark:border-blue-700 dark:bg-zinc-900"
                    />
                    <button
                      type="button"
                      disabled={savingLoc}
                      onClick={() => saveLocation(product)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-blue-500 text-white transition-colors hover:bg-blue-600 disabled:opacity-40"
                      title="Salvar"
                    >
                      {savingLoc ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => startEditLocation(product, e)}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-mono text-xs font-semibold transition-colors",
                      product.localizacao
                        ? "bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/60"
                        : "bg-zinc-100 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600 dark:bg-zinc-800 dark:text-zinc-500 dark:hover:bg-zinc-700",
                    )}
                    title="Editar localizacao"
                  >
                    {product.localizacao ? (
                      <>
                        <MapPin className="h-3 w-3" />
                        {product.localizacao}
                      </>
                    ) : (
                      <>
                        <MapPinOff className="h-3 w-3" />
                        Sem loc.
                      </>
                    )}
                    <Pencil className="h-2.5 w-2.5 opacity-50" />
                  </button>
                )}

                {/* Esgotado button */}
                {!product.all_marcado && (
                  <button
                    type="button"
                    disabled={esgotadoLoading !== null}
                    onClick={(e) => handleEsgotado(product.sku, e)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-600 transition-colors hover:bg-red-100 disabled:opacity-40 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50"
                    title={`Marcar ${product.sku} como esgotado`}
                  >
                    {esgotadoLoading === product.sku ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <XCircle className="h-3 w-3" />
                    )}
                    Esgotado
                  </button>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Action buttons */}
        {!isLoading && consolidated.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <button
              type="button"
              onClick={handleConcluir}
              disabled={actionLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {actionLoading ? "Processando..." : "Concluir"}
            </button>

            <button
              type="button"
              onClick={handleReiniciar}
              disabled={actionLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-4 py-2 text-xs font-semibold text-ink transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reiniciar progresso
            </button>

            <button
              type="button"
              onClick={handleCancelar}
              disabled={actionLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50"
            >
              <X className="h-3.5 w-3.5" />
              Cancelar
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
