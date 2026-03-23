"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Ban, CircleDashed, Loader2, PackageX, RefreshCcw, ShoppingCart } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import type { CompraExceptionItem } from "@/types";

interface ExceptionItemCardProps {
  item: CompraExceptionItem;
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  indisponivel: {
    label: "Indisponível",
    className: "bg-red-100 text-red-700",
  },
  equivalente_pendente: {
    label: "Equivalente pendente",
    className: "bg-amber-100 text-amber-700",
  },
  cancelamento_pendente: {
    label: "Cancelamento pendente",
    className: "bg-zinc-200 text-zinc-700",
  },
};

const PRIORIDADE_META = {
  critica: "border-red-200 bg-red-50 text-red-700",
  alta: "border-amber-200 bg-amber-50 text-amber-700",
  normal: "border-emerald-200 bg-emerald-50 text-emerald-700",
} as const;

type ActionMode = "equivalente" | "cancelamento" | null;

export function ExceptionItemCard({
  item,
}: ExceptionItemCardProps) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState<string | null>(null);
  const [mode, setMode] = useState<ActionMode>(null);
  const [confirmingAction, setConfirmingAction] = useState<"cancelar-pedido" | "confirmar-equivalente" | "confirmar-cancelamento" | null>(null);
  const [skuEquivalente, setSkuEquivalente] = useState(item.compra_equivalente_sku ?? "");
  const [fornecedorEquivalente, setFornecedorEquivalente] = useState(
    item.compra_equivalente_fornecedor ?? "",
  );
  const [obsEquivalente, setObsEquivalente] = useState(
    item.compra_equivalente_observacao ?? "",
  );
  const [motivoCancelamento, setMotivoCancelamento] = useState(
    item.compra_cancelamento_motivo ?? "",
  );

  const statusMeta = STATUS_META[item.compra_status ?? "indisponivel"] ?? STATUS_META.indisponivel;
  const isEquivalentePendente = item.compra_status === "equivalente_pendente";
  const isCancelamentoPendente = item.compra_status === "cancelamento_pendente";

  const helperText = useMemo(() => {
    if (isEquivalentePendente) {
      return `Aplicar externamente a troca ${item.sku} -> ${item.compra_equivalente_sku ?? "?"} e depois confirmar aqui.`;
    }
    if (isCancelamentoPendente) {
      return "Cancelar/remover o item externamente e depois confirmar aqui.";
    }
    return "Escolha como o comprador vai destravar este item.";
  }, [isCancelamentoPendente, isEquivalentePendente, item.compra_equivalente_sku, item.sku]);

  const prioridadeClassName = PRIORIDADE_META[item.prioridade];

  function invalidateCompras() {
    queryClient.invalidateQueries({ queryKey: ["compras"] });
  }

  async function runAction(actionKey: string, action: () => Promise<void>) {
    setLoading(actionKey);
    try {
      await action();
      invalidateCompras();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro inesperado");
    } finally {
      setLoading(null);
    }
  }

  async function postJson(url: string, body: Record<string, unknown>) {
    const res = await sisoFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({ error: "Erro interno" }));
    if (!res.ok) {
      throw new Error(data.error ?? "Erro interno");
    }
    return data;
  }

  async function handleVoltarFila() {
    await runAction("fila", async () => {
      await postJson(`/api/compras/itens/${item.id}/devolver`, {});
      toast.success("Item devolvido para a fila de compras");
    });
  }

  async function handleCancelarPedido() {
    await runAction("pedido", async () => {
      const data = await postJson(`/api/compras/pedidos/${item.pedido_id}/cancelar`, {});
      setConfirmingAction(null);
      if (data.estoque_lancado_alerta) {
        toast.warning("Pedido cancelado, mas já havia estoque lançado para parte da compra");
      } else {
        toast.success("Pedido cancelado");
      }
    });
  }

  async function handleRegistrarEquivalente() {
    if (!skuEquivalente.trim()) {
      toast.error("Informe o SKU equivalente");
      return;
    }

    await runAction("equivalente", async () => {
      await postJson(`/api/compras/itens/${item.id}/equivalente`, {
        sku_equivalente: skuEquivalente.trim(),
        fornecedor_equivalente: fornecedorEquivalente.trim() || undefined,
        observacao: obsEquivalente.trim() || undefined,
      });
      setMode(null);
      toast.success("Equivalente registrado. Falta confirmar a troca externa.");
    });
  }

  async function handleRegistrarCancelamento() {
    await runAction("cancelamento", async () => {
      await postJson(`/api/compras/itens/${item.id}/cancelamento`, {
        motivo: motivoCancelamento.trim() || undefined,
      });
      setMode(null);
      toast.success("Cancelamento pendente registrado");
    });
  }

  async function handleConfirmarEquivalente() {
    await runAction("confirmar-equivalente", async () => {
      await postJson(`/api/compras/itens/${item.id}/equivalente/confirmar`, {});
      setConfirmingAction(null);
      toast.success("Item sincronizado com o SKU equivalente e devolvido para a fila");
    });
  }

  async function handleConfirmarCancelamento() {
    await runAction("confirmar-cancelamento", async () => {
      const data = await postJson(`/api/compras/itens/${item.id}/cancelamento/confirmar`, {});
      setConfirmingAction(null);
      if (data.pedido_cancelado) {
        toast.success("Item confirmado e pedido cancelado localmente");
      } else if (Array.isArray(data.pedidos_liberados) && data.pedidos_liberados.length > 0) {
        toast.success("Item cancelado e pedido liberado para seguir o fluxo");
      } else {
        toast.success("Cancelamento do item confirmado");
      }
    });
  }

  return (
    <div className="rounded-xl border border-line bg-paper overflow-hidden">
      {/* Item info */}
      <div className="px-4 py-3">
        <div className="flex gap-3 min-w-0">
          {item.imagem ? (
            <img
              src={item.imagem}
              alt={item.sku}
              className="h-11 w-11 shrink-0 rounded-lg border border-line bg-surface object-cover"
            />
          ) : (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-dashed border-line bg-surface text-ink-faint">
              <PackageX className="h-4 w-4" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-sm font-semibold text-ink">{item.sku}</p>
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusMeta.className}`}>
                {statusMeta.label}
              </span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${prioridadeClassName}`}>
                {item.prioridade === "critica" ? "Crítica" : item.prioridade === "alta" ? "Alta" : "Normal"}
              </span>
              <span className="text-[11px] text-ink-faint">#{item.numero_pedido}</span>
            </div>
            <p className="mt-0.5 text-xs text-ink-muted line-clamp-1">{item.descricao}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-faint">
              <span>{item.quantidade}un</span>
              <span>{item.aging_dias <= 0 ? "Hoje" : `${item.aging_dias}d`}</span>
              {item.empresa_nome && <span>{item.empresa_nome}</span>}
              {item.fornecedor_oc && <span>{item.fornecedor_oc}</span>}
            </div>

            {isEquivalentePendente && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                Equivalente: <span className="font-semibold">{item.compra_equivalente_sku ?? "?"}</span>
                {item.compra_equivalente_fornecedor ? ` · ${item.compra_equivalente_fornecedor}` : ""}
              </div>
            )}
            {isCancelamentoPendente && item.compra_cancelamento_motivo && (
              <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[11px] text-zinc-700">
                Motivo: {item.compra_cancelamento_motivo}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation banner */}
      {confirmingAction && (
        <div className="flex items-center justify-between gap-2 border-t border-red-200 bg-red-50 px-4 py-2.5">
          <p className="text-xs font-medium text-red-800">
            {confirmingAction === "cancelar-pedido" && `Cancelar pedido #${item.numero_pedido}?`}
            {confirmingAction === "confirmar-equivalente" && "Confirmar troca externa?"}
            {confirmingAction === "confirmar-cancelamento" && "Confirmar cancelamento externo?"}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirmingAction(null)}
              className="text-xs text-red-600 hover:text-red-800"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirmingAction === "cancelar-pedido") handleCancelarPedido();
                else if (confirmingAction === "confirmar-equivalente") handleConfirmarEquivalente();
                else handleConfirmarCancelamento();
              }}
              disabled={loading !== null}
              className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Sim"}
            </button>
          </div>
        </div>
      )}

      {/* Actions bar */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line/60 px-4 py-2">
        {!isEquivalentePendente && !isCancelamentoPendente && (
          <>
            <button
              type="button"
              onClick={() => setMode(mode === "equivalente" ? null : "equivalente")}
              className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-medium text-ink hover:bg-surface transition-colors"
            >
              <CircleDashed className="h-3 w-3" />
              Equivalente
            </button>
            <button
              type="button"
              onClick={() => setMode(mode === "cancelamento" ? null : "cancelamento")}
              className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-medium text-ink hover:bg-surface transition-colors"
            >
              <Ban className="h-3 w-3" />
              Cancelar item
            </button>
          </>
        )}

        {isEquivalentePendente && (
          <>
            <button
              type="button"
              onClick={() => setConfirmingAction("confirmar-equivalente")}
              disabled={loading !== null}
              className="inline-flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1.5 text-[11px] font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-50"
            >
              {loading === "confirmar-equivalente" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShoppingCart className="h-3 w-3" />}
              Confirmar troca
            </button>
            <button
              type="button"
              onClick={() => setMode(mode === "equivalente" ? null : "equivalente")}
              className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-medium text-ink hover:bg-surface transition-colors"
            >
              <RefreshCcw className="h-3 w-3" />
              Editar
            </button>
          </>
        )}

        {isCancelamentoPendente && (
          <button
            type="button"
            onClick={() => setConfirmingAction("confirmar-cancelamento")}
            disabled={loading !== null}
            className="inline-flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1.5 text-[11px] font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-50"
          >
            {loading === "confirmar-cancelamento" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}
            Confirmar cancelamento
          </button>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={handleVoltarFila}
          disabled={loading !== null}
          className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-medium text-ink hover:bg-surface transition-colors disabled:opacity-50"
        >
          {loading === "fila" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowLeft className="h-3 w-3" />}
          Fila
        </button>
        <button
          type="button"
          onClick={() => setConfirmingAction("cancelar-pedido")}
          disabled={loading !== null}
          className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1.5 text-[11px] font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
        >
          {loading === "pedido" ? <Loader2 className="h-3 w-3 animate-spin" /> : <AlertTriangle className="h-3 w-3" />}
          Cancelar pedido
        </button>
      </div>

      {mode === "equivalente" && (
        <div className="border-t border-line bg-surface/30 px-4 py-2.5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={skuEquivalente}
              onChange={(e) => setSkuEquivalente(e.target.value)}
              placeholder="SKU equivalente"
              autoFocus
              className="flex-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            <input
              type="text"
              value={fornecedorEquivalente}
              onChange={(e) => setFornecedorEquivalente(e.target.value)}
              placeholder="Fornecedor"
              className="flex-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            <input
              type="text"
              value={obsEquivalente}
              onChange={(e) => setObsEquivalente(e.target.value)}
              placeholder="Obs (opcional)"
              className="flex-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRegistrarEquivalente}
                disabled={loading !== null}
                className="inline-flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1.5 text-[11px] font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
              >
                {loading === "equivalente" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Salvar"}
              </button>
              <button type="button" onClick={() => setMode(null)} className="text-[11px] text-ink-muted hover:text-ink">
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {mode === "cancelamento" && (
        <div className="border-t border-line bg-surface/30 px-4 py-2.5">
          <div className="flex items-start gap-2">
            <textarea
              value={motivoCancelamento}
              onChange={(e) => setMotivoCancelamento(e.target.value)}
              placeholder="Motivo do cancelamento (opcional)"
              rows={1}
              className="flex-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none resize-none"
            />
            <button
              type="button"
              onClick={handleRegistrarCancelamento}
              disabled={loading !== null}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-ink px-2.5 py-1.5 text-[11px] font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
            >
              {loading === "cancelamento" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Salvar"}
            </button>
            <button type="button" onClick={() => setMode(null)} className="shrink-0 py-1.5 text-[11px] text-ink-muted hover:text-ink">
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
