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
  Boxes,
  ScanBarcode,
  CheckCircle2,
  RotateCcw,
  X,
  XCircle,
  Loader2,
  Pencil,
  Save,
  Send,
  ShoppingCart,
} from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { naturalLocCompare } from "@/lib/domain-helpers";
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
  saldo: number;
  disponivel: number;
  galpao_nome: string | null;
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
  saldo: number;
  disponivel: number;
  galpao_nome: string | null;
  first_pedido_id: string;
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
  const [esgotadoModal, setEsgotadoModal] = useState<{
    sku: string;
    loading: boolean;
    galpoes: Array<{ galpao_id: string; galpao_nome: string }>;
    pedidos_afetados: number;
  } | null>(null);
  const [editingLoc, setEditingLoc] = useState<string | null>(null); // produto_id being edited
  const [editLocValue, setEditLocValue] = useState("");
  const [savingLoc, setSavingLoc] = useState(false);
  const [editingStock, setEditingStock] = useState<string | null>(null); // produto_id being edited
  const [editStockValue, setEditStockValue] = useState("");
  const [savingStock, setSavingStock] = useState(false);
  const locInputRef = useRef<HTMLInputElement>(null);
  const stockInputRef = useRef<HTMLInputElement>(null);
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
          saldo: item.saldo,
          disponivel: item.disponivel,
          galpao_nome: item.galpao_nome,
          first_pedido_id: item.pedido_id,
        });
      }
    }

    const result = Array.from(map.values());

    result.sort((a, b) => {
      if (sort === "sku") return a.sku.localeCompare(b.sku);
      if (sort === "descricao") return a.descricao.localeCompare(b.descricao);
      // Default: localizacao (natural sort — B-2 before B-10)
      return naturalLocCompare(a.localizacao, b.localizacao);
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
      // Optimistic: immediately clear all marcado flags in cache
      queryClient.setQueryData<{ items: ChecklistItem[] }>(queryKey, (old) => {
        if (!old) return old;
        return {
          items: old.items.map((item) => ({
            ...item,
            separacao_marcado: false,
            separacao_marcado_em: null,
          })),
        };
      });
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

    if (!window.confirm(
      `Alterar localizacao de ${product.sku}?\n\nDe: ${product.localizacao || "(vazio)"}\nPara: ${trimmed || "(vazio)"}`,
    )) return;

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

  // Handle stock edit
  function startEditStock(product: ConsolidatedProduct, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingStock(product.produto_id);
    setEditStockValue(String(product.saldo));
    setTimeout(() => stockInputRef.current?.focus(), 50);
  }

  async function saveStock(product: ConsolidatedProduct) {
    const newSaldo = parseInt(editStockValue, 10);
    if (isNaN(newSaldo) || newSaldo < 0) {
      toast.error("Quantidade invalida");
      return;
    }
    if (newSaldo === product.saldo) {
      setEditingStock(null);
      return;
    }

    if (!product.galpao_nome) {
      toast.error("Galpao nao identificado");
      setEditingStock(null);
      return;
    }

    if (!window.confirm(
      `Ajustar estoque de ${product.sku}?\n\nSaldo atual: ${product.saldo}\nNovo saldo: ${newSaldo}\n\nEsta acao altera o estoque no Tiny ERP.`,
    )) return;

    setSavingStock(true);
    try {
      const res = await sisoFetch("/api/tiny/stock/ajustar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedidoId: product.first_pedido_id,
          produtoId: Number(product.produto_id),
          galpao: product.galpao_nome,
          quantidade: newSaldo,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Erro ao ajustar estoque");
        return;
      }

      const result = await res.json();

      // Optimistic update in cache
      queryClient.setQueryData<{ items: ChecklistItem[] }>(queryKey, (old) => {
        if (!old) return old;
        return {
          items: old.items.map((item) =>
            item.produto_id === product.produto_id
              ? { ...item, saldo: result.saldo, disponivel: result.disponivel }
              : item,
          ),
        };
      });

      toast.success(`Estoque ajustado: ${product.sku} → saldo ${result.saldo}`);
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setSavingStock(false);
      setEditingStock(null);
    }
  }

  // Handle esgotado — step 1: preview (check alternatives)
  async function handleEsgotado(sku: string, e: React.MouseEvent) {
    e.stopPropagation();
    setEsgotadoLoading(sku);
    try {
      const res = await sisoFetch("/api/separacao/produto-esgotado", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Erro ao verificar estoque");
        return;
      }
      // Open modal with alternatives
      setEsgotadoModal({
        sku,
        loading: false,
        galpoes: data.galpoes_alternativos ?? [],
        pedidos_afetados: data.pedidos_afetados ?? 0,
      });
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setEsgotadoLoading(null);
    }
  }

  // Handle esgotado — step 2: execute chosen action
  async function handleEsgotadoAction(
    acao: "oc" | "encaminhar",
    galpaoDestinoId?: string,
  ) {
    if (!esgotadoModal) return;
    const { sku } = esgotadoModal;
    setEsgotadoModal((prev) => (prev ? { ...prev, loading: true } : null));
    try {
      const payload: Record<string, string> = { sku, acao };
      if (galpaoDestinoId) payload.galpao_destino_id = galpaoDestinoId;

      const res = await sisoFetch("/api/separacao/produto-esgotado", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (acao === "encaminhar") {
          toast.success(
            `SKU ${sku} — ${data.pedidos_afetados} pedido(s) encaminhado(s) para ${data.galpao_destino_nome}`,
          );
        } else {
          toast.success(
            `SKU ${sku} esgotado — ${data.pedidos_afetados} pedido(s) movido(s) para OC`,
          );
        }
        setEsgotadoModal(null);
        // If all pedidos were affected, go back to separation list
        if (data.pedidos_afetados >= pedidoIds.length) {
          queryClient.invalidateQueries({ queryKey: ["separacao"] });
          router.push("/separacao");
          return;
        }
        queryClient.invalidateQueries({ queryKey });
        queryClient.invalidateQueries({ queryKey: ["separacao"] });
      } else {
        toast.error(data.error ?? "Erro ao processar");
        setEsgotadoModal((prev) =>
          prev ? { ...prev, loading: false } : null,
        );
      }
    } catch {
      toast.error("Erro de conexao");
      setEsgotadoModal((prev) => (prev ? { ...prev, loading: false } : null));
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
              Checklist de Separacao
            </h1>
            <p className="text-[11px] text-ink-faint">
              {pedidoIds.length} pedido(s) — Wave picking
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
            <span className="font-mono text-xs font-semibold text-ink">
              {user.nome}
            </span>
            <span className="text-[10px] text-ink-faint">
              {(user.cargos ?? [user.cargo]).map((c) => CARGO_LABELS[c]).join(", ")}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-3 sm:px-4 py-3 sm:py-4">
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
                  "flex w-full min-h-[44px] items-start sm:items-center gap-2.5 sm:gap-3 rounded-xl border px-3 sm:px-4 py-3 text-left transition-all duration-300",
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
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors mt-0.5 sm:mt-0",
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

                {/* Content — stacks on mobile, single row on sm+ */}
                <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
                  {/* SKU / Description block */}
                  <div className="min-w-0 sm:flex-1">
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
                          <span className="hidden sm:inline">GTIN </span>{product.gtin}
                        </span>
                      )}
                      {/* Qty badge — mobile only */}
                      <span
                        className={cn(
                          "sm:hidden ml-auto shrink-0 rounded-md px-2 py-0.5 font-mono text-sm font-semibold",
                          product.all_marcado
                            ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                            : "bg-zinc-100 text-ink dark:bg-zinc-800",
                        )}
                      >
                        {product.quantidade_total}
                      </span>
                    </div>
                    <p
                      className={cn(
                        "truncate text-xs sm:text-sm mt-0.5",
                        product.all_marcado
                          ? "text-emerald-600/60 line-through dark:text-emerald-400/60"
                          : "text-ink-faint sm:text-ink",
                      )}
                    >
                      {product.descricao}
                    </p>
                  </div>

                  {/* Qty badge — desktop only */}
                  <span
                    className={cn(
                      "hidden sm:inline-flex shrink-0 rounded-md px-2 py-0.5 font-mono text-sm font-semibold",
                      product.all_marcado
                        ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                        : "bg-zinc-100 text-ink dark:bg-zinc-800",
                    )}
                  >
                    {product.quantidade_total}
                  </span>

                  {/* Stock + Location + Esgotado — wraps on mobile, inline on sm+ */}
                  <div className="mt-1.5 sm:mt-0 flex flex-wrap sm:flex-nowrap items-center gap-1.5 sm:shrink-0">
                    {/* Stock badge */}
                    {editingStock === product.produto_id ? (
                      <div
                        className="inline-flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          ref={stockInputRef}
                          type="number"
                          min={0}
                          value={editStockValue}
                          onChange={(e) => setEditStockValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); saveStock(product); }
                            if (e.key === "Escape") { e.preventDefault(); setEditingStock(null); }
                          }}
                          disabled={savingStock}
                          className="h-7 w-20 rounded-md border border-amber-300 bg-white px-2 font-mono text-xs text-ink text-center focus:border-amber-500 focus:outline-none dark:border-amber-700 dark:bg-zinc-900"
                        />
                        <button
                          type="button"
                          disabled={savingStock}
                          onClick={() => saveStock(product)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-amber-500 text-white transition-colors hover:bg-amber-600 disabled:opacity-40"
                          title="Salvar estoque"
                        >
                          {savingStock ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => startEditStock(product, e)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs font-semibold transition-colors",
                          product.disponivel >= product.quantidade_total
                            ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/60"
                            : product.disponivel > 0
                              ? "bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60"
                              : "bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/60",
                        )}
                        title={`Estoque: saldo ${product.saldo}, disponivel ${product.disponivel} — clique para ajustar`}
                      >
                        <Boxes className="h-3 w-3" />
                        {product.disponivel}
                        <Pencil className="h-2.5 w-2.5 opacity-50" />
                      </button>
                    )}

                    {/* Location */}
                    {editingLoc === product.produto_id ? (
                      <div
                        className="inline-flex items-center gap-1"
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
                          "inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs font-semibold transition-colors",
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
                        className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-600 transition-colors hover:bg-red-100 disabled:opacity-40 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50"
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
                  </div>
                </div>
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

      {/* Esgotado modal — choose between encaminhar or OC */}
      {esgotadoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl border border-line bg-paper p-5 shadow-xl">
            <h3 className="text-sm font-bold text-ink">
              SKU {esgotadoModal.sku} — Esgotado
            </h3>
            <p className="mt-1 text-xs text-ink/60">
              {esgotadoModal.pedidos_afetados} pedido(s) afetado(s). O que
              deseja fazer?
            </p>

            <div className="mt-4 flex flex-col gap-2">
              {esgotadoModal.galpoes.map((g) => (
                <button
                  key={g.galpao_id}
                  type="button"
                  disabled={esgotadoModal.loading}
                  onClick={() =>
                    handleEsgotadoAction("encaminhar", g.galpao_id)
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-40 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-950/50"
                >
                  {esgotadoModal.loading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  Encaminhar para {g.galpao_nome}
                </button>
              ))}

              <button
                type="button"
                disabled={esgotadoModal.loading}
                onClick={() => handleEsgotadoAction("oc")}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-40 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50"
              >
                {esgotadoModal.loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShoppingCart className="h-3.5 w-3.5" />
                )}
                Criar Ordem de Compra
              </button>
            </div>

            <button
              type="button"
              disabled={esgotadoModal.loading}
              onClick={() => setEsgotadoModal(null)}
              className="mt-3 w-full rounded-lg border border-line px-4 py-2 text-xs font-medium text-ink/60 transition-colors hover:bg-surface disabled:opacity-40"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
