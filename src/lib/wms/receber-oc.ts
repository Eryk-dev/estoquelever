import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao, estornarMovimentacao } from "@/lib/wms/ledger";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import { resolverLocRecebimento, criarPendencia } from "@/lib/wms/guarda";
import { resolverProdutoWmsFlex } from "@/lib/separacao/wms-mapping";
import { detectarCrossDock } from "@/lib/wms/crossdock-detector";
import { resolverCustoEntrada } from "./custo-fallback";
import { checkAndReleasePedidos } from "@/lib/compras-release";
import { upsertNotaFiscal } from "@/lib/nf-webhook-handler";

export interface ReceberOCItemInput {
  /** ID do siso_pedido_itens vinculado a essa OC */
  item_id: string;
  /** Qty realmente recebida (operador conferiu fisicamente) */
  qty_real: number;
  /** Custo unitário (operador conferiu — usado pra recálculo de custo médio) */
  custo_unitario?: number;
  /** Motivo de divergência se qty_real != qty_solicitada */
  motivo_divergencia?: string;
  /**
   * NOVO: loc final (entrada direta) ou destino planejado da pendência (dock).
   * Espelha `ItemRecebimento.localizacao_destino_id` de movimentacoes.ts.
   */
  localizacao_destino_id?: string | null;
}

export interface ReceberOCArgs {
  ocId: string;
  itens: ReceberOCItemInput[];
  operadorId: string;
  operadorNome: string;
  /**
   * NOVO: true = E direto na loc do item (exige loc em todos os itens com
   * qty>0), sem pendência, sem cross-dock. Espelha `receberEstoque`.
   */
  entrada_direta?: boolean;
  /**
   * NOVO: NF que chegou com a caixa (opcional). Com valor → upsertNotaFiscal →
   * nota_fiscal_id nas movs E de compra (NÃO na mov "achado" de excedente).
   */
  nf_referencia?: string | null;
  chave_acesso_nf?: string | null;
}

export interface ReceberOCResult {
  oc_id: string;
  itens_recebidos: number;
  pendencias_criadas: string[];
  oc_fechada: boolean;
  divergencias: Array<{ item_id: string; motivo: string }>;
}

/**
 * P2-CMP-01: cancela pendências de guarda como COMPENSAÇÃO num rollback de
 * recebimento. Libera a reserva forte remanescente via RPC atômico antes de
 * marcar 'cancelada'. Best-effort: falha de uma não aborta o resto do rollback
 * (loga via logError business_logic e segue).
 */
async function cancelarPendenciasCompensacao(
  supabase: ReturnType<typeof createServiceClient>,
  pendenciaIds: string[],
  usuarioId: string,
  motivo: string,
  ctx: { ocId: string },
): Promise<void> {
  for (const pendId of pendenciaIds) {
    const { error } = await supabase.rpc(
      "wms_cancelar_pendencia_guarda_atomico",
      { p_pendencia_id: pendId, p_motivo: motivo, p_usuario_id: usuarioId },
    );
    if (error) {
      logger.logError({
        error,
        source: "receber-oc",
        message: "FALHA ao cancelar pendência de guarda na compensação — pendência órfã",
        category: "business_logic",
        metadata: { pendencia_id: pendId, oc_id: ctx.ocId, motivo },
      });
    }
  }
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

  // Entrada direta: valida loc destino presente em TODO item com qty>0 ANTES de
  // escrever no ledger (espelha receberEstoque em movimentacoes.ts:113-117).
  if (args.entrada_direta) {
    const semLoc = args.itens.some(
      (it) => it.qty_real > 0 && !it.localizacao_destino_id,
    );
    if (semLoc) {
      throw new Error(
        "entrada direta exige localizacao_destino_id em todos os itens",
      );
    }
  }

  // NF opcional: se chegou referência/chave, garante a linha canônica em
  // siso_notas_fiscais ANTES do loop e carimba o uuid nas movs E de compra
  // (mesmo padrão de devolucoes.ts:146-154). Sem NF → warn do ledger continua.
  let notaFiscalId: string | null = null;
  if (args.nf_referencia || args.chave_acesso_nf) {
    notaFiscalId = await upsertNotaFiscal({
      chave_acesso: args.chave_acesso_nf ?? null,
      numero: args.nf_referencia ?? null,
      empresa_id: oc.empresa_id ?? null,
      tipo: "entrada",
    });
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

    // Resolve produto WMS uuid via empresa da OC (SKU-first: tiny → SKU)
    let produtoWmsId: string;
    try {
      produtoWmsId = await resolverProdutoWmsFlex(String(oc.empresa_id), {
        tinyProdutoId: item.produto_id,
        sku: item.sku,
      });
    } catch (mapErr) {
      throw new Error(
        `falha ao resolver produto WMS do item ${item.id} (sku ${item.sku}): ${mapErr instanceof Error ? mapErr.message : String(mapErr)}`,
      );
    }

    // Mov E em RECEBIMENTO + pendência (modelo idêntico ao /api/wms/receber)
    // [P033] Over-receive: splita em nf_compra (até o solicitado restante,
    // custo da compra) + ajuste_manual 'achado' (excedente — NÃO alimenta o
    // custo médio de compra). Ambas no mesmo lote (cobertas pelo rollback).
    let movEntradaId: string;
    // P2-CMP-01: rastreia a mov 'achado' (over-receive) e as pendências de
    // guarda criadas POR ESTE item, pra compensar no caminho perdedor de corrida
    // (estornar achado + cancelar pendências) — não só a mov de compra.
    let movAchadoId: string | null = null;
    const pendsDesteItem: string[] = [];
    try {
      const custoResolvido = await resolverCustoEntrada({
        produto_id: produtoWmsId,
        custo_informado: itemReq.custo_unitario,
      });
      const qtySolicitada = Number(item.compra_quantidade_solicitada ?? 0);
      const jaRecebidoItem = Number(item.compra_quantidade_recebida ?? 0);
      const solicitadoRestante = Math.max(0, qtySolicitada - jaRecebidoItem);
      const qtyCompra =
        qtySolicitada > 0
          ? Math.min(itemReq.qty_real, solicitadoRestante)
          : itemReq.qty_real;
      const qtyExcedente = itemReq.qty_real - qtyCompra;

      // Entrada direta: E vai pra loc do item; senão, dock RECEBIMENTO (atual).
      const locEntradaId = args.entrada_direta
        ? itemReq.localizacao_destino_id!
        : locRecebId;

      const movE = await inserirMovimentacao({
        tripla: {
          produto_id: produtoWmsId,
          galpao_id: oc.galpao_id,
          localizacao_id: locEntradaId,
        },
        tipo: "E",
        // qtyCompra=0 (solicitado já 100% recebido e chega mais) → lança tudo como nf_compra, sem achado.
        qty: qtyCompra > 0 ? qtyCompra : itemReq.qty_real,
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
        nota_fiscal_id: notaFiscalId,
        motivo: itemReq.motivo_divergencia
          ? `Divergência: ${itemReq.motivo_divergencia}`
          : null,
        usuario_id: args.operadorId,
      });
      movEntradaId = movE.id;
      movsCriadasLote.push(movEntradaId);

      if (qtyCompra > 0 && qtyExcedente > 0) {
        // excedente como ganho de inventário (achado) — SEM custo_unitario,
        // pra não contaminar o custo médio de compra.
        const movGanho = await inserirMovimentacao({
          tripla: {
            produto_id: produtoWmsId,
            galpao_id: oc.galpao_id,
            localizacao_id: locEntradaId,
          },
          tipo: "E",
          qty: qtyExcedente,
          origem_tipo: "ajuste_manual",
          origem_id: args.ocId,
          origem_detalhes: {
            ordem_compra_id: args.ocId,
            item_id: item.id,
            sku: item.sku,
            contexto: "over_receive",
          },
          motivo_categoria: "achado",
          motivo: `over-receive: ${qtyExcedente} acima do solicitado (brinde/conferência)`,
          usuario_id: args.operadorId,
        });
        movAchadoId = movGanho.id;
        movsCriadasLote.push(movGanho.id);
      }
    } catch (movErr) {
      throw new Error(
        `falha na mov E em recebimento OC do item ${item.id}: ${movErr instanceof Error ? movErr.message : String(movErr)}`,
      );
    }

    // Entrada direta: a peça já está acessível na loc final — sem dock, sem
    // cross-dock, sem pendência de guarda. Pula esse bloco inteiro.
    // Decisão 7 (28/05): detecta demanda viva pra esse SKU+OC e splita
    // pendência em 2 quando há cross-docking. Pendência cross-dock vai
    // pra PACKING; resto vira pendência normal (livre escolha de loc).
    let pendsCriadasItem = 0;
    if (!args.entrada_direta) {
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
        pendsDesteItem.push(pendCross);
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
          // Destino planejado (escolha do operador no dock) — espelha
          // movimentacoes.ts:201. Cross-dock (pendCross) mantém seu próprio
          // destino_sugerido_id; aqui aplica só à fração de guarda normal.
          localizacao_destino_id: itemReq.localizacao_destino_id ?? null,
          mov_entrada_id: movEntradaId,
          qty_inicial: split.qty_guarda_normal,
          origem_tipo: "nf_compra",
          custo_unitario: itemReq.custo_unitario ?? null,
          lote_id: loteId,
          criada_por: args.operadorId,
          prioridade: "normal",
        });
        pendenciasCriadas.push(pendNormal);
        pendsDesteItem.push(pendNormal);
        pendsCriadasItem++;
      }
    } catch (pendErr) {
      throw new Error(
        `falha ao criar pendência de guarda do item ${item.id} (sku ${item.sku}): ${pendErr instanceof Error ? pendErr.message : String(pendErr)}`,
      );
    }
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
      // P2-CMP-01: além da mov de compra, estorna a mov 'achado' (over-receive)
      // e cancela as pendências de guarda criadas POR ESTE item — senão o
      // perdedor de corrida deixa saldo fantasma + pendências órfãs.
      // Cancela pendências ANTES dos estornos (libera a R forte antes de o
      // estorno do E baixar o saldo — senão violaria CHECK(reservado<=saldo)).
      if (pendsDesteItem.length > 0) {
        await cancelarPendenciasCompensacao(
          supabase,
          pendsDesteItem,
          args.operadorId,
          "race recebimento — perdedor",
          { ocId: args.ocId },
        );
        // tira do array global pra não reportar como criada
        for (const pendId of pendsDesteItem) {
          const pIdx = pendenciasCriadas.indexOf(pendId);
          if (pIdx >= 0) pendenciasCriadas.splice(pIdx, 1);
        }
      }
      const movsCompensar = [movEntradaId, ...(movAchadoId ? [movAchadoId] : [])];
      for (const movId of movsCompensar) {
        try {
          await estornarMovimentacao({
            mov_id: movId,
            usuario_id: args.operadorId,
            motivo: `Recebimento concorrente do item ${item.id}: estorno da mov duplicada`,
          });
        } catch (estErr) {
          logger.logError({
            error: estErr,
            source: "receber-oc",
            message: "FALHA ao estornar mov de item concorrente — mov órfã",
            category: "business_logic",
            metadata: { movId, itemId: String(item.id), ocId: args.ocId },
          });
        }
        const idx = movsCriadasLote.indexOf(movId);
        if (idx >= 0) movsCriadasLote.splice(idx, 1);
      }
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
    // P2-CMP-01: cancela ANTES as pendências de guarda criadas pelos itens já
    // processados (libera a R forte antes de o estorno do E baixar o saldo —
    // senão o estorno violaria CHECK(reservado<=saldo) na loc de recebimento).
    if (pendenciasCriadas.length > 0) {
      await cancelarPendenciasCompensacao(
        supabase,
        [...pendenciasCriadas],
        args.operadorId,
        `rollback recebimento OC ${args.ocId}`,
        { ocId: args.ocId },
      );
      pendenciasCriadas.length = 0;
    }
    for (const movId of movsCriadasLote) {
      try {
        await estornarMovimentacao({
          mov_id: movId,
          usuario_id: args.operadorId,
          motivo: `Rollback all-items recebimento OC ${args.ocId}: ${loteErr instanceof Error ? loteErr.message : String(loteErr)}`,
        });
      } catch (estErr) {
        logger.logError({
          error: estErr,
          source: "receber-oc",
          message: "FALHA ao estornar mov no rollback all-items — mov órfã",
          category: "business_logic",
          metadata: { movId, ocId: args.ocId },
        });
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
        logger.logError({
          error: revErr,
          source: "receber-oc",
          message: "FALHA ao reverter compra_quantidade_recebida no rollback all-items",
          category: "business_logic",
          metadata: { itemId: upd.itemId, ocId: args.ocId },
        });
      }
    }
    throw loteErr;
  }

  // Verifica se OC fechou (todos itens com qty_recebida >= qty_solicitada)
  // P2-CMP-02: SELECT falho NÃO pode fechar a OC. `(data ?? []).every()` de
  // uma lista vazia retorna true → marcaria 'recebido' com itens pendentes.
  // Em erro: loga e pula o update de status (o recebimento em si foi OK).
  const { data: itensRestantes, error: itensRestantesErr } = await supabase
    .from("siso_pedido_itens")
    .select("compra_quantidade_solicitada, compra_quantidade_recebida")
    .eq("ordem_compra_id", args.ocId);

  let ocFechada = false;
  if (itensRestantesErr) {
    logger.error(
      "receber-oc",
      "FALHA ao buscar itens restantes — pulando atualização de status da OC",
      { ocId: args.ocId, error: itensRestantesErr.message },
    );
  } else {
    ocFechada = (itensRestantes ?? []).every(
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
