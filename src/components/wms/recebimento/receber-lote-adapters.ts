import type { ReceberLoteItem } from "./receber-lote-types";

export function buildOcPayload(
  itens: ReceberLoteItem[],
  opts: { entradaDireta: boolean; nfReferencia?: string | null },
) {
  return {
    itens: itens
      .filter((it) => Number(it.qty || "0") > 0)
      .map((it) => {
        const qty = Number(it.qty || "0");
        const custo = Number(it.custo || "0");
        const divergiu = it.qtyEsperada != null && qty !== it.qtyEsperada;
        return {
          item_id: it.backendItemId!,
          qty_real: qty,
          custo_unitario: custo > 0 ? custo : undefined,
          motivo_divergencia: divergiu && it.motivoDivergencia ? it.motivoDivergencia : undefined,
          localizacao_destino_id: it.locIdOverride ?? undefined,
        };
      }),
    entrada_direta: opts.entradaDireta,
    nf_referencia: opts.nfReferencia ?? undefined,
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

export function buildManualPayload(
  itens: ReceberLoteItem[],
  opts: { entradaDireta: boolean },
) {
  return {
    itens: itens
      .map((it) => ({
        item_id: it.backendItemId!,
        qty_recebida: Number(it.qty || "0"),
        ...(it.custo ? { custo_unitario: Number(it.custo) } : {}),
        ...(it.locIdOverride ? { localizacao_destino_id: it.locIdOverride } : {}),
      }))
      .filter((x) => x.qty_recebida > 0),
    entrada_direta: opts.entradaDireta,
  };
}

export function buildCompraPayload(
  itens: ReceberLoteItem[],
  opts: { fornecedorId: string; empresaId: string; galpaoId: string; observacao: string | null },
) {
  return {
    fornecedor_id: opts.fornecedorId,
    empresa_compradora_id: opts.empresaId,
    galpao_id: opts.galpaoId,
    observacao: opts.observacao,
    itens: itens
      .filter((it) => it.produto && Number(it.qty || "0") > 0)
      .map((it) => ({
        produto_id: it.produto!.id,
        qty_comprada: Number(it.qty),
        ...(it.custo && Number(it.custo) > 0 ? { custo_unitario: Number(it.custo) } : {}),
      })),
  };
}

/** Separa linhas pré-definidas do documento das linhas extras adicionadas na tela. */
export function splitOcExtras(itens: ReceberLoteItem[]) {
  const ocItens = itens.filter((it) => it.backendItemId != null);
  const extras = itens.filter((it) => it.backendItemId == null && it.produto != null);
  return { ocItens, extras };
}
