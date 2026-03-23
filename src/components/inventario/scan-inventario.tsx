"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Loader2,
  ScanBarcode,
  Keyboard,
  Trash2,
  Minus,
  Plus,
  MapPin,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { sisoFetch } from "@/lib/auth-context";
import {
  playSuccess,
  playError,
  playDuplicate,
} from "@/components/separacao/audio-feedback";
import type { InventarioItem } from "@/types";

interface ScanInventarioProps {
  inventarioId: string;
  modo: string;
  tipoEstoque: string | null;
  onProcessar: () => void;
  onCancelar?: () => void;
}

interface ColetarResponse {
  item: InventarioItem;
  ja_escaneado: boolean;
  localizacoes_anteriores: string[];
  total_itens: number;
}

interface ItemDisplay extends InventarioItem {
  /** If duplicate, shows previous locations */
  localizacoes_anteriores?: string[];
}

const TIPO_LABELS: Record<string, string> = {
  B: "Balanço",
  E: "Entrada",
  S: "Saída",
};

export function ScanInventario({
  inventarioId,
  modo,
  tipoEstoque,
  onProcessar,
  onCancelar,
}: ScanInventarioProps) {
  const skuInputRef = useRef<HTMLInputElement>(null);
  const [localizacao, setLocalizacao] = useState("");
  const [quantidade, setQuantidade] = useState(1);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [itens, setItens] = useState<ItemDisplay[]>([]);
  const [totalItens, setTotalItens] = useState(0);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingQty, setEditingQty] = useState(1);

  // Load existing items on mount
  useEffect(() => {
    async function loadItens() {
      try {
        const res = await sisoFetch(`/api/inventario/${inventarioId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.itens) {
            setItens(data.itens.reverse());
            setTotalItens(data.itens.length);
          }
        }
      } catch {
        // silent — items will show as they are scanned
      }
    }
    loadItens();
  }, [inventarioId]);

  // Focus SKU input when location is set
  useEffect(() => {
    if (localizacao.trim() && skuInputRef.current) {
      skuInputRef.current.focus();
    }
  }, [localizacao]);

  const handleScan = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const input = skuInputRef.current;
      if (!input) return;

      const codigo = input.value.trim();
      if (!codigo) return;

      if (!localizacao.trim()) {
        toast.error("Defina uma localização");
        return;
      }

      setProcessing(true);

      try {
        const res = await sisoFetch(
          `/api/inventario/${inventarioId}/coletar`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              codigo,
              localizacao: localizacao.trim(),
              quantidade,
            }),
          },
        );

        if (res.status === 404) {
          playError();
          toast.error("Produto não encontrado", {
            description: `Código: ${codigo}`,
          });
          return;
        }

        if (!res.ok) {
          playError();
          const data = await res.json().catch(() => ({}));
          toast.error(data.error ?? "Erro ao coletar item");
          return;
        }

        const data: ColetarResponse = await res.json();

        if (data.ja_escaneado) {
          playDuplicate();
          toast.info("SKU já escaneado neste inventário", {
            description: `Também em: ${data.localizacoes_anteriores.join(", ")}`,
          });
        } else {
          playSuccess();
        }

        // Add item to list (newest first)
        const displayItem: ItemDisplay = {
          ...data.item,
          localizacoes_anteriores: data.ja_escaneado
            ? data.localizacoes_anteriores
            : undefined,
        };
        setItens((prev) => [displayItem, ...prev]);
        setTotalItens(data.total_itens);
        setQuantidade(1);
      } catch {
        playError();
        toast.error("Erro de conexão");
      } finally {
        setProcessing(false);
        if (skuInputRef.current) {
          skuInputRef.current.value = "";
          skuInputRef.current.focus();
        }
      }
    },
    [inventarioId, localizacao, quantidade],
  );

  async function handleUpdateQty(itemId: string, newQty: number) {
    if (newQty < 1) return;
    try {
      const res = await sisoFetch(
        `/api/inventario/${inventarioId}/itens/${itemId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantidade: newQty }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        setItens((prev) =>
          prev.map((it) =>
            it.id === itemId ? { ...it, quantidade: data.item.quantidade } : it,
          ),
        );
        setTotalItens(data.total_itens);
      } else {
        toast.error("Erro ao atualizar quantidade");
      }
    } catch {
      toast.error("Erro de conexão");
    }
    setEditingItemId(null);
  }

  async function handleDeleteItem(itemId: string) {
    try {
      const res = await sisoFetch(
        `/api/inventario/${inventarioId}/itens/${itemId}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        const data = await res.json();
        setItens((prev) => prev.filter((it) => it.id !== itemId));
        setTotalItens(data.total_itens);
      } else {
        toast.error("Erro ao remover item");
      }
    } catch {
      toast.error("Erro de conexão");
    }
  }

  const modoLabel =
    modo === "loc_estoque" && tipoEstoque
      ? TIPO_LABELS[tipoEstoque] ?? tipoEstoque
      : "Localização";

  return (
    <div className="flex flex-col gap-3 pb-20">
      {/* Header counter */}
      <div className="text-center text-sm font-medium text-ink-muted">
        {totalItens} {totalItens === 1 ? "item" : "itens"}
      </div>

      {/* Location field — sticky */}
      <div className="sticky top-0 z-10 bg-paper pb-2">
        <div className="relative">
          <MapPin
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-400"
            aria-hidden="true"
          />
          <input
            type="text"
            value={localizacao}
            onChange={(e) => setLocalizacao(e.target.value.toUpperCase())}
            placeholder="Localização (ex: A-01-1)"
            className="w-full rounded-xl border border-line bg-paper py-3 pl-11 pr-4 font-mono text-lg text-ink placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            aria-label="Localização do produto"
          />
        </div>
      </div>

      {/* SKU scan field */}
      <form onSubmit={handleScan} className="relative">
        <ScanBarcode
          className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-400"
          aria-hidden="true"
        />
        <input
          ref={skuInputRef}
          type="text"
          inputMode={showKeyboard ? "text" : "none"}
          autoFocus={!!localizacao.trim()}
          disabled={processing || !localizacao.trim()}
          placeholder={
            localizacao.trim()
              ? "Escanear código..."
              : "Defina uma localização primeiro"
          }
          className="w-full rounded-xl border border-line bg-paper py-3 pl-11 pr-20 font-mono text-sm text-ink placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50"
          aria-label="Campo de leitura de código de barras"
        />
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {processing && (
            <Loader2
              className="h-5 w-5 animate-spin text-blue-500"
              aria-label="Processando..."
            />
          )}
          <button
            type="button"
            onClick={() => setShowKeyboard(!showKeyboard)}
            className={cn(
              "rounded p-1 transition-colors",
              showKeyboard
                ? "bg-blue-100 text-blue-600"
                : "text-zinc-400 hover:text-ink-muted",
            )}
            aria-label={showKeyboard ? "Desativar teclado" : "Ativar teclado"}
          >
            <Keyboard className="h-5 w-5" />
          </button>
        </div>
      </form>

      {/* Quantity stepper */}
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => setQuantidade((q) => Math.max(1, q - 1))}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted transition-colors hover:bg-zinc-100"
        >
          <Minus className="h-4 w-4" />
        </button>
        <span className="min-w-[3rem] text-center font-mono text-lg font-semibold text-ink tabular-nums">
          {quantidade}
        </span>
        <button
          type="button"
          onClick={() => setQuantidade((q) => q + 1)}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted transition-colors hover:bg-zinc-100"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Item list — newest first */}
      <div className="flex flex-col gap-2">
        {itens.map((item) => (
          <div
            key={item.id}
            className="rounded-lg border border-line bg-paper px-3 py-2"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {/* SKU + name */}
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-sm font-bold text-ink">
                    {item.sku}
                  </span>
                  <span className="truncate text-xs text-ink-muted">
                    {item.nome_produto}
                  </span>
                </div>
                {/* Location badge + qty */}
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    {item.localizacao}
                  </span>
                  {/* Tappable quantity */}
                  {editingItemId === item.id ? (
                    <input
                      type="number"
                      min={1}
                      value={editingQty}
                      onChange={(e) =>
                        setEditingQty(Math.max(1, parseInt(e.target.value) || 1))
                      }
                      onBlur={() => handleUpdateQty(item.id, editingQty)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleUpdateQty(item.id, editingQty);
                        }
                      }}
                      autoFocus
                      className="w-14 rounded border border-blue-300 px-1 py-0.5 text-center text-xs font-mono text-ink outline-none focus:ring-1 focus:ring-blue-400"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingItemId(item.id);
                        setEditingQty(item.quantidade);
                      }}
                      className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-ink-muted hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                    >
                      ×{item.quantidade}
                    </button>
                  )}
                </div>
                {/* Duplicate notice */}
                {item.localizacoes_anteriores &&
                  item.localizacoes_anteriores.length > 0 && (
                    <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                      Também em: {item.localizacoes_anteriores.join(", ")}
                    </p>
                  )}
              </div>
              {/* Delete */}
              <button
                type="button"
                onClick={() => handleDeleteItem(item.id)}
                className="shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-500"
                aria-label={`Remover ${item.sku}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom fixed: Processar + Cancelar buttons */}
      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-paper p-4">
        <button
          type="button"
          onClick={onProcessar}
          disabled={totalItens === 0}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-ink py-3.5 text-sm font-medium text-paper transition-opacity disabled:opacity-50"
        >
          Processar Inventário — {totalItens} {totalItens === 1 ? "item" : "itens"}{" "}
          · {modoLabel}
        </button>
        {onCancelar && (
          <button
            type="button"
            onClick={onCancelar}
            className="mt-2 flex w-full items-center justify-center rounded-xl border border-line py-2.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface"
          >
            Cancelar Inventário
          </button>
        )}
      </div>
    </div>
  );
}
