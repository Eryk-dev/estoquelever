import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao, estornarMovimentacao } from "@/lib/wms/ledger";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import { resolverLocRecebimento, criarPendencia } from "@/lib/wms/guarda";
import { resolverProdutoWms } from "@/lib/separacao/wms-mapping";
import { detectarCrossDock } from "@/lib/wms/crossdock-detector";
import { resolverCustoEntrada } from "./custo-fallback";
import { checkAndReleasePedidos } from "@/lib/compras-release";

export interface ReceberOCItemInput {
  /** ID do siso_pedido_itens vinculado a essa OC */
  item_id: string;
  /** Qty realmente recebida (operador conferiu fisicamente) */
  qty_real: number;
  /** Custo unitário (operador conferiu — usado pra recálculo de custo médio) */
  custo_unitario?: number;
  /** Motivo de divergência se qty_real != qty_solicitada */
  motivo_divergencia?: string;
}

export interface ReceberOCArgs {
  ocId: string;
  itens: ReceberOCItemInput[];
  operadorId: string;
  operadorNome: string;
}

export interface ReceberOCResult {
  oc_id: string;
  itens_recebidos: number;
  pendencias_criadas: string[];
  oc_fechada: boolean;
  divergencias: Array<{ item_id: string; motivo: string }>;
}

/**
 * Recebe itens vinculados a uma OC: gera mov E em RECEBIMENTO com custo da
 * compra (atualiza custo médio), cria pendência de guarda pra tablet,
 * atualiza compra_quantidade_recebida no item, e fecha a OC se todos
 * recebidos.
 *
 * Por enquanto não dispara cross-docking — Task 3.3 adiciona detecção.
 */
export async function receberItensViaOC(
  args: ReceberOCArgs,
): Promise<ReceberOCResult> {
  const supabase = createServiceClient();

  const { data: oc, error: ocErr } = await supabase
    .from("siso_ordens_compra")
    .select("id, galpao_id, fornecedor, empresa_id")
    .eq("id", args.ocId)
    .single();
  if (ocErr || !oc) {
    throw new Error("OC não encontrada");
  }
  if (!oc.galpao_id) {
    throw new Error("OC sem galpao_id");
  }

  const pendenciasCriadas: string[] = [];
  const divergencias: ReceberOCResult["divergencias"] = [];
  const itensRecebidosIds: string[] = [];

  // Resolve loc RECEBIMENTO do galpão da OC (uma vez por chamada)
  const { id: locRecebId } = await resolverLocRecebimento(oc.galpao_id);
  const loteId = crypto.randomUUID();

  // Resolve fornecedor_id (best effort — pode ser NULL se fornecedor da OC
  // for texto livre sem cadastro).
  let fornecedorId: string | null = null;
  if (oc.fornecedor) {
    const { data: forn } = await supabase
      .from("siso_fornecedores")
      .select("id")
      .eq("nome", oc.fornecedor)
      .maybeSingle();
    fornecedorId = (forn?.id as string | null) ?? null;
  }

  let itensRecebidos = 0;
  // P028: tudo-ou-nada. Acumula as movs E criadas no lote; se QUALQUER item
  // falhar, o catch externo estorna TODAS e re-lança (nada fica comitado).
  const movsCriadasLote: string[] = [];
  // P028: também acumula os incrementos de compra_quantidade_recebida pra
  // reverter no rollback all-items (estornar a mov não desfaz esse UPDATE).
  const updatesRecebimentoLote: Array<{
    itemId: string;
    qtyAnterior: number;
    statusAnterior: string | null;
  }> = [];
  try {
  for (const itemReq of args.itens) {
    const { data: item } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, sku, produto_id, compra_quantidade_solicitada, compra_quantidade_recebida, compra_status, ordem_compra_id",
      )
      .eq("id", itemReq.item_id)
      .single();
    if (!item) {
      throw new Error(`item de OC não encontrado: ${itemReq.item_id}`);
    }

    if (itemReq.qty_real <= 0) {
      registrarEvento({
        pedidoId: item.pedido_id,
        evento: "recebimento_item_zero",
        usuarioId: args.operadorId,
        usuarioNome: args.operadorNome,
        detalhes: {
          item_id: item.id,
          sku: item.sku,
          motivo: itemReq.motivo_divergencia ?? "qty_real=0",
        },
      }).catch(() => {});
      if (itemReq.motivo_divergencia) {
        divergencias.push({
          item_id: String(item.id),
          motivo: itemReq.motivo_divergencia,
        });
      }
      continue;
    }

    // Resolve produto WMS uuid via empresa da OC (tiny_produto_id → uuid)
    let produtoWmsId: string;
    try {
      produtoWmsId = await resolverProdutoWms(
        String(oc.empresa_id),
        String(item.produto_id),
      );
    } catch (mapErr) {
      throw new Error(
        `falha ao resolver produto WMS do item ${item.id} (sku ${item.sku}): ${mapErr instanceof Error ? mapErr.message : String(mapErr)}`,
      );
    }

    // Mov E em RECEBIMENTO + pendência (modelo idêntico ao /api/wms/receber)
    let movEntradaId: string;
    try {
      const custoResolvido = await resolverCustoEntrada({
        produto_id: produtoWmsId,
        custo_informado: itemReq.custo_unitario,
      });
      const movE = await inserirMovimentacao({
        tripla: {
          produto_id: produtoWmsId,
          galpao_id: oc.galpao_id,
          localizacao_id: locRecebId,
        },
        tipo: "E",
        qty: itemReq.qty_real,
        origem_tipo: "nf_compra",
        origem_id: args.ocId,
        origem_detalhes: {
          ordem_compra_id: args.ocId,
          item_id: item.id,
          pedido_id: item.pedido_id,
          sku: item.sku,
          motivo_divergencia: itemReq.motivo_divergencia ?? null,
        },
        custo_unitario: custoResolvido,
        fornecedor_id: fornecedorId,
        empresa_compradora_id: oc.empresa_id ?? null,
        motivo: itemReq.motivo_divergencia
          ? `Divergência: ${itemReq.motivo_divergencia}`
          : null,
        usuario_id: args.operadorId,
      });
      movEntradaId = movE.id;
    } catch (movErr) {
      throw new Error(
        `falha na mov E em recebimento OC do item ${item.id}: ${movErr instanceof Error ? movErr.message : String(movErr)}`,
      );
    }
    movsCriadasLote.push(movEntradaId);

    // Decisão 7 (28/05): detecta demanda viva pra esse SKU+OC e splita
    // pendência em 2 quando há cross-docking. Pendência cross-dock vai
    // pra PACKING; resto vira pendência normal (livre escolha de loc).
    let pendsCriadasItem = 0;
    try {
      const split = await detectarCrossDock({
        produto_id: produtoWmsId,
        galpao_id: oc.galpao_id,
        qty_recebida: itemReq.qty_real,
        ordem_compra_id: args.ocId,
      });

      if (split.qty_cross_dock > 0 && split.loc_packing_id) {
        const pendCross = await criarPendencia({
          produto_id: produtoWmsId,
          galpao_id: oc.galpao_id,
          localizacao_origem_id: locRecebId,
          mov_entrada_id: movEntradaId,
          qty_inicial: split.qty_cross_dock,
          origem_tipo: "nf_compra",
          custo_unitario: itemReq.custo_unitario ?? null,
          lote_id: loteId,
          criada_por: args.operadorId,
          prioridade: "cross_dock",
          pedidos_vinculados: split.pedidos_vinculados,
          destino_sugerido_id: split.loc_packing_id,
        });
        pendenciasCriadas.push(pendCross);
        pendsCriadasItem++;
        logger.info(
          "receber-oc.crossdock",
          "pendência cross-dock criada",
          {
            pendencia_id: pendCross,
            qty: split.qty_cross_dock,
            pedidos: split.pedidos_vinculados.length,
            oc_id: args.ocId,
            sku: item.sku,
          },
        );
      }

      if (split.qty_guarda_normal > 0) {
        const pendNormal = await criarPendencia({
          produto_id: produtoWmsId,
          galpao_id: oc.galpao_id,
          localizacao_origem_id: locRecebId,
          mov_entrada_id: movEntradaId,
          qty_inicial: split.qty_guarda_normal,
          origem_tipo: "nf_compra",
          custo_unitario: itemReq.custo_unitario ?? null,
          lote_id: loteId,
          criada_por: args.operadorId,
          prioridade: "normal",
        });
        pendenciasCriadas.push(pendNormal);
        pendsCriadasItem++;
      }
    } catch (pendErr) {
      throw new Error(
        `falha ao criar pendência de guarda do item ${item.id} (sku ${item.sku}): ${pendErr instanceof Error ? pendErr.message : String(pendErr)}`,
      );
    }

    // Atualiza compra_quantidade_recebida (optimistic lock + flip compra_status)
    const jaRecebido = Number(item.compra_quantidade_recebida ?? 0);
    const novaQtyReceb = jaRecebido + itemReq.qty_real;
    const qtySolic = Number(item.compra_quantidade_solicitada ?? 0);
    const updatePayload: Record<string, unknown> = {
      compra_quantidade_recebida: novaQtyReceb,
    };
    if (qtySolic > 0 && novaQtyReceb >= qtySolic) {
      updatePayload.compra_status = "recebido";
    }
    const { data: updRows, error: updRecebErr } = await supabase
      .from("siso_pedido_itens")
      .update(updatePayload)
      .eq("id", item.id)
      .eq("compra_quantidade_recebida", jaRecebido) // optimistic lock
      .select("id");
    if (updRecebErr) {
      throw new Error(
        `falha ao atualizar recebimento do item ${item.id}: ${updRecebErr.message}`,
      );
    }
    // 0 linhas = outro recebimento concorrente já incrementou (a guarda .eq
    // não casou). Estorna SÓ esta mov, tira do lote e segue — o vencedor já
    // contou (concorrência não é falha do lote → não dispara rollback all-items).
    if (!updRows || updRows.length === 0) {
      try {
        await estornarMovimentacao({
          mov_id: movEntradaId,
          usuario_id: args.operadorId,
          motivo: `Recebimento concorrente do item ${item.id}: estorno da mov duplicada`,
        });
      } catch (estErr) {
        logger.error(
          "receber-oc",
          "FALHA ao estornar mov de item concorrente — mov órfã",
          { movId: movEntradaId, itemId: item.id, ocId: args.ocId, err: String(estErr) },
        );
      }
      movsCriadasLote.splice(movsCriadasLote.indexOf(movEntradaId), 1);
      logger.warn("receber-oc", "recebimento concorrente detectado; pulando item", {
        item_id: item.id,
      });
      continue;
    }
    updatesRecebimentoLote.push({
      itemId: String(item.id),
      qtyAnterior: jaRecebido,
      statusAnterior: (item.compra_status as string | null) ?? null,
    });
    itensRecebidosIds.push(String(item.id));

    if (itemReq.motivo_divergencia) {
      divergencias.push({
        item_id: String(item.id),
        motivo: itemReq.motivo_divergencia,
      });
    }

    registrarEvento({
      pedidoId: item.pedido_id,
      evento: "recebimento_via_oc",
      usuarioId: args.operadorId,
      usuarioNome: args.operadorNome,
      detalhes: {
        oc_id: args.ocId,
        item_id: item.id,
        sku: item.sku,
        qty_real: itemReq.qty_real,
        mov_id: movEntradaId,
        divergencia: itemReq.motivo_divergencia ?? null,
      },
    }).catch(() => {});

    itensRecebidos++;
  }
  } catch (loteErr) {
    // P028: rollback all-items — estorna TODAS as movs E criadas no lote e
    // re-lança. Item 1 não pode ficar comitado se item 2 falhou.
    for (const movId of movsCriadasLote) {
      try {
        await estornarMovimentacao({
          mov_id: movId,
          usuario_id: args.operadorId,
          motivo: `Rollback all-items recebimento OC ${args.ocId}: ${loteErr instanceof Error ? loteErr.message : String(loteErr)}`,
        });
      } catch (estErr) {
        logger.error(
          "receber-oc",
          "FALHA ao estornar mov no rollback all-items — mov órfã",
          { movId, ocId: args.ocId, err: String(estErr) },
        );
      }
    }
    // Reverte os incrementos de compra_quantidade_recebida/compra_status já
    // aplicados (estornar a mov não desfaz esse UPDATE).
    for (const upd of updatesRecebimentoLote) {
      const { error: revErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          compra_quantidade_recebida: upd.qtyAnterior,
          compra_status: upd.statusAnterior,
        })
        .eq("id", upd.itemId);
      if (revErr) {
        logger.error(
          "receber-oc",
          "FALHA ao reverter compra_quantidade_recebida no rollback all-items",
          { itemId: upd.itemId, ocId: args.ocId, err: revErr.message },
        );
      }
    }
    throw loteErr;
  }

  // Verifica se OC fechou (todos itens com qty_recebida >= qty_solicitada)
  const { data: itensRestantes } = await supabase
    .from("siso_pedido_itens")
    .select("compra_quantidade_solicitada, compra_quantidade_recebida")
    .eq("ordem_compra_id", args.ocId);

  const ocFechada = (itensRestantes ?? []).every(
    (it) =>
      Number(it.compra_quantidade_recebida ?? 0) >=
      Number(it.compra_quantidade_solicitada ?? 0),
  );

  if (ocFechada) {
    await supabase
      .from("siso_ordens_compra")
      .update({ status: "recebido" })
      .eq("id", args.ocId);
  }

  // Mec. 2: libera os pedidos cujos itens de compra agora estão todos resolvidos.
  // checkAndReleasePedidos é idempotente (guarda de status + índice único).
  if (itensRecebidosIds.length > 0) {
    try {
      await checkAndReleasePedidos(itensRecebidosIds);
    } catch (err) {
      logger.warn("receber-oc", "checkAndReleasePedidos falhou (não-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    oc_id: args.ocId,
    itens_recebidos: itensRecebidos,
    pendencias_criadas: pendenciasCriadas,
    oc_fechada: ocFechada,
    divergencias,
  };
}
