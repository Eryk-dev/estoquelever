export interface VendaItemTraceLike {
  quantidade_pedida: number | string | null;
  quantidade_pega?: number | string | null;
  quantidade_bipada?: number | string | null;
  quantidade_encaixotada?: number | string | null;
  /**
   * Soma autoritativa das saídas S atribuídas ao item no ledger.
   *
   * É derivada por `calcularSaidasVendaPorItem`; não deve ser preenchida a
   * partir do status do pedido. Vendas em baixa direta não atualizam os campos
   * de picking do item, então este é o único progresso físico confiável delas.
   */
  quantidade_baixada_movimentos?: number | string | null;
  separacao_marcado?: boolean | null;
  separacao_parcial?: boolean | null;
  bipado_completo?: boolean | null;
  estoque_saida_lancada?: boolean | null;
  mov_saida_id?: string | null;
  compra_status?: string | null;
}

export interface VendaItemIdentificavelTrace extends VendaItemTraceLike {
  id: string | number;
  sku?: string | null;
}

export interface VendaMovimentoTraceLike {
  id: string | number;
  tipo: string | null;
  quantidade: number | string | null;
  qty_estornada?: number | string | null;
  estorno_de?: string | number | null;
  sku?: string | null;
  origem_detalhes?: Record<string, unknown> | null;
}

export interface VendaMovLinkTraceLike {
  pedido_item_id: string | number;
  mov_id: string | number;
  qty: number | string;
  tipo_link: string;
}

export type VendaItemTraceTone = "mute" | "info" | "warn" | "ok";

export interface VendaItemTraceStage {
  key:
    | "aguardando"
    | "em_compra"
    | "parcial"
    | "separado"
    | "conferido"
    | "encaixotado"
    | "baixado";
  label: string;
  tone: VendaItemTraceTone;
}

function qty(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function quantidadeMovimentoPorItem(
  quantidadeMovimento: number | string | null | undefined,
  quantidadeLink?: number | string | null,
): number {
  return qty(quantidadeLink ?? quantidadeMovimento);
}

function itemIdFromDetails(
  detalhes: Record<string, unknown> | null | undefined,
): string | null {
  const value =
    detalhes?.pedido_item_id ?? detalhes?.item_id ?? detalhes?.pedidoItemId;
  return value == null ? null : String(value);
}

/**
 * Atribui saídas físicas do ledger aos itens sem rateio presumido:
 *
 * 1. link explícito item↔mov (usa `link.qty`, pois uma S pode ser consolidada);
 * 2. `pedido_item_id` gravado em `origem_detalhes`;
 * 3. `mov_saida_id` legado do item;
 * 4. SKU, somente quando ele identifica uma única linha do pedido.
 *
 * Uma movimentação de SKU duplicado sem link/item_id fica deliberadamente sem
 * atribuição. Dividi-la entre linhas inventaria uma rastreabilidade inexistente.
 */
export function calcularSaidasVendaPorItem(
  items: VendaItemIdentificavelTrace[],
  movimentos: VendaMovimentoTraceLike[],
  links: VendaMovLinkTraceLike[] = [],
): Map<string, number> {
  const saidas = new Map(items.map((item) => [String(item.id), 0]));
  const itemPorId = new Map(items.map((item) => [String(item.id), item]));
  const quantidadeDeLinhasPorSku = new Map<string, number>();
  const itemUnicoPorSku = new Map<string, string>();

  for (const item of items) {
    const sku = String(item.sku ?? "").trim();
    if (!sku) continue;
    quantidadeDeLinhasPorSku.set(
      sku,
      (quantidadeDeLinhasPorSku.get(sku) ?? 0) + 1,
    );
    itemUnicoPorSku.set(sku, String(item.id));
  }

  const linksSaidaPorMov = new Map<string, VendaMovLinkTraceLike[]>();
  for (const link of links) {
    if (link.tipo_link !== "saida") continue;
    const movId = String(link.mov_id);
    const grupo = linksSaidaPorMov.get(movId) ?? [];
    grupo.push(link);
    linksSaidaPorMov.set(movId, grupo);
  }

  const qtyEstornadaPorMov = new Map<string, number>();
  const itensEstornadosPorMov = new Map<string, Set<string>>();
  for (const movimento of movimentos) {
    if (movimento.estorno_de == null) continue;
    const movOriginalId = String(movimento.estorno_de);
    qtyEstornadaPorMov.set(
      movOriginalId,
      (qtyEstornadaPorMov.get(movOriginalId) ?? 0) +
        qty(movimento.quantidade),
    );
    const itemId = itemIdFromDetails(movimento.origem_detalhes);
    if (itemId) {
      const grupo = itensEstornadosPorMov.get(movOriginalId) ?? new Set();
      grupo.add(itemId);
      itensEstornadosPorMov.set(movOriginalId, grupo);
    }
  }

  for (const movimento of movimentos) {
    if (movimento.tipo !== "S") continue;
    const movId = String(movimento.id);

    const quantidadeLiquida = Math.max(
      0,
      qty(movimento.quantidade) -
        Math.max(
          qty(movimento.qty_estornada),
          qtyEstornadaPorMov.get(movId) ?? 0,
        ),
    );
    if (quantidadeLiquida <= 0) continue;

    const linksDaSaida = linksSaidaPorMov.get(movId) ?? [];
    if (linksDaSaida.length > 0) {
      let restante = quantidadeLiquida;
      const itensEstornados = itensEstornadosPorMov.get(movId);
      for (const link of linksDaSaida) {
        const itemId = String(link.pedido_item_id);
        if (!itemPorId.has(itemId)) continue;
        if (itensEstornados?.has(itemId)) continue;
        const atribuida = Math.min(qty(link.qty), restante);
        if (atribuida <= 0) continue;
        saidas.set(itemId, (saidas.get(itemId) ?? 0) + atribuida);
        restante -= atribuida;
      }
      continue;
    }

    const itemIdDetalhes = itemIdFromDetails(movimento.origem_detalhes);
    if (itemIdDetalhes && itemPorId.has(itemIdDetalhes)) {
      saidas.set(
        itemIdDetalhes,
        (saidas.get(itemIdDetalhes) ?? 0) + quantidadeLiquida,
      );
      continue;
    }

    const itemPorMovSaida = items.find(
      (item) => String(item.mov_saida_id ?? "") === movId,
    );
    if (itemPorMovSaida) {
      const itemId = String(itemPorMovSaida.id);
      saidas.set(itemId, (saidas.get(itemId) ?? 0) + quantidadeLiquida);
      continue;
    }

    const sku = String(
      movimento.origem_detalhes?.sku ?? movimento.sku ?? "",
    ).trim();
    if (sku && quantidadeDeLinhasPorSku.get(sku) === 1) {
      const itemId = itemUnicoPorSku.get(sku)!;
      saidas.set(itemId, (saidas.get(itemId) ?? 0) + quantidadeLiquida);
    }
  }

  return saidas;
}

export function quantidadeProcessadaVenda(item: VendaItemTraceLike): number {
  const pedida = qty(item.quantidade_pedida);
  const pega = qty(item.quantidade_pega);
  const bipada = qty(item.quantidade_bipada);
  const encaixotada = qty(item.quantidade_encaixotada);
  const baixada = qty(item.quantidade_baixada_movimentos);
  // Em separações parciais, os indicadores booleanos representam a
  // existência de uma baixa/marca — não que toda a quantidade foi atendida.
  const permiteInferirQuantidadeTotal = !item.separacao_parcial;
  const inferidaMarcada =
    permiteInferirQuantidadeTotal && item.separacao_marcado ? pedida : 0;
  const inferidaBaixada =
    permiteInferirQuantidadeTotal && item.estoque_saida_lancada ? pedida : 0;

  return Math.min(
    pedida,
    Math.max(
      pega,
      bipada,
      encaixotada,
      baixada,
      inferidaMarcada,
      inferidaBaixada,
    ),
  );
}

export function classificarVendaItem(item: VendaItemTraceLike): VendaItemTraceStage {
  const pedida = qty(item.quantidade_pedida);
  const pega = quantidadeProcessadaVenda(item);
  const encaixotada = qty(item.quantidade_encaixotada);
  const bipada = qty(item.quantidade_bipada);
  const baixada = qty(item.quantidade_baixada_movimentos);
  const compraAtiva =
    !!item.compra_status &&
    !["recebido", "cancelado", "concluido"].includes(item.compra_status);

  if (compraAtiva) {
    return { key: "em_compra", label: "Em compra", tone: "warn" };
  }
  if (item.separacao_parcial || (pega > 0 && pega < pedida)) {
    return { key: "parcial", label: "Separado parcial", tone: "warn" };
  }
  if (pedida > 0 && encaixotada >= pedida) {
    return { key: "encaixotado", label: "Encaixotado", tone: "ok" };
  }
  if (item.bipado_completo || (pedida > 0 && bipada >= pedida)) {
    return { key: "conferido", label: "Conferido", tone: "ok" };
  }
  if (
    item.estoque_saida_lancada ||
    (pedida > 0 && baixada >= pedida)
  ) {
    return { key: "baixado", label: "Baixado", tone: "ok" };
  }
  if (
    item.separacao_marcado ||
    item.mov_saida_id ||
    (pedida > 0 && pega >= pedida)
  ) {
    return { key: "separado", label: "Separado", tone: "info" };
  }
  return { key: "aguardando", label: "A separar", tone: "mute" };
}

export function resumirItensVenda(items: VendaItemTraceLike[]) {
  return items.reduce(
    (acc, item) => {
      const pedida = qty(item.quantidade_pedida);
      const processada = quantidadeProcessadaVenda(item);
      const stage = classificarVendaItem(item);

      acc.itens_total += 1;
      acc.unidades_total += pedida;
      acc.unidades_processadas += processada;
      if (processada >= pedida && pedida > 0) acc.itens_processados += 1;
      if (stage.key === "parcial" || stage.key === "em_compra") {
        acc.itens_com_excecao += 1;
      }
      return acc;
    },
    {
      itens_total: 0,
      itens_processados: 0,
      itens_com_excecao: 0,
      unidades_total: 0,
      unidades_processadas: 0,
    },
  );
}
