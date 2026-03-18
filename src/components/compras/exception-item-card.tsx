"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Ban, CircleDashed, Loader2, PackageX, RefreshCcw, ShoppingCart } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface ExceptionItem {
  id: string;
  sku: string;
  descricao: string;
  imagem: string | null;
  quantidade: number;
  aging_dias: number;
  prioridade: "critica" | "alta" | "normal";
  proxima_acao: string;
  fornecedor_oc: string | null;
  pedido_id: string;
  numero_pedido: string;
  empresa_nome: string | null;
  compra_status: string | null;
  compra_equivalente_sku: string | null;
  compra_equivalente_descricao: string | null;
  compra_equivalente_fornecedor: string | null;
  compra_equivalente_observacao: string | null;
  compra_cancelamento_motivo: string | null;
}

interface ExceptionItemCardProps {
  item: ExceptionItem;
  cargo: string;
  usuario_id: string;
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
  cargo,
  usuario_id,
}: ExceptionItemCardProps) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState<string | null>(null);
  const [mode, setMode] = useState<ActionMode>(null);
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
    const res = await fetch(url, {
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
      await postJson(`/api/compras/itens/${item.id}/devolver`, { cargo });
      toast.success("Item devolvido para a fila de compras");
    });
  }

  async function handleCancelarPedido() {
    if (!window.confirm(`Cancelar o pedido #${item.numero_pedido} inteiro?`)) return;

    await runAction("pedido", async () => {
      const data = await postJson(`/api/compras/pedidos/${item.pedido_id}/cancelar`, { cargo });
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
        usuario_id,
        cargo,
      });
      setMode(null);
      toast.success("Equivalente registrado. Falta confirmar a troca externa.");
    });
  }

  async function handleRegistrarCancelamento() {
    await runAction("cancelamento", async () => {
      await postJson(`/api/compras/itens/${item.id}/cancelamento`, {
        motivo: motivoCancelamento.trim() || undefined,
        usuario_id,
        cargo,
      });
      setMode(null);
      toast.success("Cancelamento pendente registrado");
    });
  }

  async function handleConfirmarEquivalente() {
    if (!window.confirm("Confirmar que a troca do item já foi aplicada externamente?")) return;

    await runAction("confirmar-equivalente", async () => {
      await postJson(`/api/compras/itens/${item.id}/equivalente/confirmar`, { cargo });
      toast.success("Item sincronizado com o SKU equivalente e devolvido para a fila");
    });
  }

  async function handleConfirmarCancelamento() {
    if (!window.confirm("Confirmar que o item já foi cancelado/removido externamente?")) return;

    await runAction("confirmar-cancelamento", async () => {
      const data = await postJson(`/api/compras/itens/${item.id}/cancelamento/confirmar`, {
        usuario_id,
        cargo,
      });
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
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3 min-w-0">
          {item.imagem ? (
            <img
              src={item.imagem}
              alt={item.sku}
              className="h-14 w-14 rounded-lg border border-line bg-surface object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-line bg-surface text-ink-faint">
              <PackageX className="h-5 w-5" />
            </div>
          )}

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-ink">{item.sku}</p>
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusMeta.className}`}>
                {statusMeta.label}
              </span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${prioridadeClassName}`}>
                {item.prioridade === "critica" ? "Crítica" : item.prioridade === "alta" ? "Alta" : "Normal"}
              </span>
              <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                #{item.numero_pedido}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">{item.descricao}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-faint">
              <span>{item.quantidade}un</span>
              <span>Aging: {item.aging_dias <= 0 ? "Hoje" : `${item.aging_dias}d`}</span>
              {item.empresa_nome && <span>Empresa: {item.empresa_nome}</span>}
              {item.fornecedor_oc && <span>Fornecedor atual: {item.fornecedor_oc}</span>}
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              Próxima ação: <span className="font-medium text-ink">{item.proxima_acao}</span>
            </p>
            <p className="mt-1 text-xs text-ink-muted">{helperText}</p>
            {isEquivalentePendente && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <p className="font-medium">
                  Equivalente: {item.compra_equivalente_sku ?? "?"}
                  {item.compra_equivalente_fornecedor ? ` · ${item.compra_equivalente_fornecedor}` : ""}
                </p>
                {item.compra_equivalente_descricao && (
                  <p className="mt-0.5">{item.compra_equivalente_descricao}</p>
                )}
              </div>
            )}
            {isCancelamentoPendente && item.compra_cancelamento_motivo && (
              <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
                Motivo: {item.compra_cancelamento_motivo}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!isEquivalentePendente && !isCancelamentoPendente && (
            <>
              <button
                type="button"
                onClick={() => setMode(mode === "equivalente" ? null : "equivalente")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink hover:bg-surface transition-colors"
              >
                <CircleDashed className="h-3.5 w-3.5" />
                SKU equivalente
              </button>
              <button
                type="button"
                onClick={() => setMode(mode === "cancelamento" ? null : "cancelamento")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink hover:bg-surface transition-colors"
              >
                <Ban className="h-3.5 w-3.5" />
                Cancelar item
              </button>
            </>
          )}

          {isEquivalentePendente && (
            <>
              <button
                type="button"
                onClick={handleConfirmarEquivalente}
                disabled={loading !== null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-xs font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-50"
              >
                {loading === "confirmar-equivalente" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShoppingCart className="h-3.5 w-3.5" />
                )}
                Confirmar troca
              </button>
              <button
                type="button"
                onClick={() => setMode(mode === "equivalente" ? null : "equivalente")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink hover:bg-surface transition-colors"
              >
                <RefreshCcw className="h-3.5 w-3.5" />
                Editar
              </button>
            </>
          )}

          {isCancelamentoPendente && (
            <button
              type="button"
              onClick={handleConfirmarCancelamento}
              disabled={loading !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-xs font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-50"
            >
              {loading === "confirmar-cancelamento" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Ban className="h-3.5 w-3.5" />
              )}
              Confirmar cancelamento
            </button>
          )}

          <button
            type="button"
            onClick={handleVoltarFila}
            disabled={loading !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink hover:bg-surface transition-colors disabled:opacity-50"
          >
            {loading === "fila" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowLeft className="h-3.5 w-3.5" />
            )}
            Voltar pra fila
          </button>
          <button
            type="button"
            onClick={handleCancelarPedido}
            disabled={loading !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            {loading === "pedido" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5" />
            )}
            Cancelar pedido
          </button>
        </div>
      </div>

      {mode === "equivalente" && (
        <div className="border-t border-line bg-surface/40 px-4 py-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <input
              type="text"
              value={skuEquivalente}
              onChange={(e) => setSkuEquivalente(e.target.value)}
              placeholder="SKU equivalente"
              className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            <input
              type="text"
              value={fornecedorEquivalente}
              onChange={(e) => setFornecedorEquivalente(e.target.value)}
              placeholder="Fornecedor do equivalente"
              className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            <input
              type="text"
              value={obsEquivalente}
              onChange={(e) => setObsEquivalente(e.target.value)}
              placeholder="Observação opcional"
              className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRegistrarEquivalente}
              disabled={loading !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-xs font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-50"
            >
              {loading === "equivalente" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CircleDashed className="h-3.5 w-3.5" />
              )}
              Salvar equivalente
            </button>
            <button
              type="button"
              onClick={() => setMode(null)}
              className="text-xs text-ink-muted hover:text-ink transition-colors"
            >
              Fechar
            </button>
          </div>
        </div>
      )}

      {mode === "cancelamento" && (
        <div className="border-t border-line bg-surface/40 px-4 py-3">
          <textarea
            value={motivoCancelamento}
            onChange={(e) => setMotivoCancelamento(e.target.value)}
            placeholder="Motivo do cancelamento do item (opcional)"
            rows={2}
            className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none resize-none"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRegistrarCancelamento}
              disabled={loading !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-xs font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-50"
            >
              {loading === "cancelamento" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Ban className="h-3.5 w-3.5" />
              )}
              Salvar cancelamento
            </button>
            <button
              type="button"
              onClick={() => setMode(null)}
              className="text-xs text-ink-muted hover:text-ink transition-colors"
            >
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
