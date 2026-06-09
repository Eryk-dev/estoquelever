import type { ReceberLoteItem } from "./receber-lote-types";

export function buildOcPayload(itens: ReceberLoteItem[]) {
  return {
    itens: itens.map((it) => {
      const qty = Number(it.qty || "0");
      const custo = Number(it.custo || "0");
      const divergiu = it.qtyEsperada != null && qty !== it.qtyEsperada;
      return {
        item_id: it.backendItemId!,
        qty_real: qty,
        custo_unitario: custo > 0 ? custo : undefined,
        motivo_divergencia: divergiu && it.motivoDivergencia ? it.motivoDivergencia : undefined,
      };
    }),
  };
}

export function buildTransferenciaPayload(itens: ReceberLoteItem[]) {
  const out = itens.map((it) => ({
    transferencia_item_id: it.backendItemId!,
    localizacao_destino_id: it.locIdOverride ?? "",
  }));
  if (out.some((o) => !o.localizacao_destino_id)) {
    throw new Error("Defina a loc destino em todos os itens");
  }
  return { itens: out };
}

export function buildManualPayload(itens: ReceberLoteItem[]) {
  return {
    itens: itens
      .map((it) => {
        const qty = Number(it.qty || "0");
        const custo = it.custo ? Number(it.custo) : undefined;
        return {
          item_id: it.backendItemId!,
          qty_recebida: qty,
          ...(custo ? { custo_unitario: custo } : {}),
        };
      })
      .filter((x) => x.qty_recebida > 0),
  };
}
