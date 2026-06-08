import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { resolverCustoEntrada } from "@/lib/wms/custo-fallback";
import { logger } from "@/lib/logger";

export type StatusCompraManual = "comprado" | "parcial" | "recebido" | "cancelado";

export interface CompraManualItemInput {
  produto_id: string;
  qty_comprada: number;
  custo_unitario?: number | null;
}

export interface CriarCompraManualInput {
  fornecedor_id: string;
  empresa_compradora_id: string;
  galpao_id: string;
  observacao?: string | null;
  itens: CompraManualItemInput[];
  criado_por: string;
}

/**
 * Status do cabeçalho derivado das quantidades dos itens.
 * Pura — não toca DB. (cancelado é setado explicitamente, nunca derivado aqui.)
 */
export function computeStatusCompra(
  itens: { qty_comprada: number; qty_recebida: number }[],
): "comprado" | "parcial" | "recebido" {
  if (itens.length === 0) return "comprado";
  const algoRecebido = itens.some((i) => Number(i.qty_recebida) > 0);
  const tudoRecebido = itens.every(
    (i) => Number(i.qty_recebida) >= Number(i.qty_comprada),
  );
  if (tudoRecebido) return "recebido";
  if (algoRecebido) return "parcial";
  return "comprado";
}
