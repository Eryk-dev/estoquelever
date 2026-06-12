import type { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

type Supabase = ReturnType<typeof createServiceClient>;

export interface MandarComprasArgs {
  supabase: Supabase;
  pedido_ids: string[];
  item_ids: string[];
  usuario_id: string | null;
  usuario_nome: string | null;
}

export interface MandarComprasResult {
  itens_atualizados: number;
  pedidos_atualizados: number;
}

/**
 * Transição compartilhada: itens vão pra `compra_status='aguardando_compra'`,
 * pedidos pra `status_separacao='aguardando_compra'`.
 *
 * Usado por:
 *  - POST /api/wms/separacao/mandar-pra-compras (chamada manual via modal — legado)
 *  - POST /api/wms/separacao/parcial (inline quando cascade esgota — fluxo automático novo)
 *
 * Decisão 28/05 (revisão): cascade esgotado já transita automaticamente, sem
 * modal. O caminho manual existe pra eventuais reaproveitamentos.
 */
export async function mandarItensParaCompras(
  args: MandarComprasArgs,
): Promise<MandarComprasResult> {
  const { supabase, pedido_ids, item_ids, usuario_id, usuario_nome } = args;
  const now = new Date().toISOString();

  const { data: items } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, sku, quantidade_pedida, quantidade_pega, fornecedor_oc",
    )
    .in("id", item_ids);

  if (!items || items.length === 0) {
    return { itens_atualizados: 0, pedidos_atualizados: 0 };
  }

  let itensAtualizados = 0;
  for (const item of items) {
    const qtyResidual = Math.max(
      0,
      Number(item.quantidade_pedida ?? 0) - Number(item.quantidade_pega ?? 0),
    );
    const fornecedor =
      item.fornecedor_oc || getFornecedorBySku(item.sku ?? "").fornecedor;

    const { error: updErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "aguardando_compra",
        compra_quantidade_solicitada: qtyResidual,
        compra_solicitada_em: now,
        fornecedor_oc: fornecedor,
      })
      .eq("id", item.id);

    if (updErr) {
      logger.warn("mandar-compras", "falhou update item", {
        item_id: item.id,
        err: updErr.message,
      });
      continue;
    }

    itensAtualizados++;

    registrarEvento({
      pedidoId: item.pedido_id,
      evento: "mandado_pra_compras_via_cascade",
      usuarioId: usuario_id,
      usuarioNome: usuario_nome,
      detalhes: {
        item_id: item.id,
        sku: item.sku,
        qty_residual: qtyResidual,
        fornecedor,
      },
    }).catch(() => {});
  }

  await supabase
    .from("siso_pedidos")
    .update({
      status_separacao: "aguardando_compra",
      separacao_operador_id: null,
      separacao_iniciada_em: null,
    })
    .in("id", pedido_ids);

  logger.info("mandar-compras", "transição executada", {
    pedido_ids,
    item_ids,
    itens_atualizados: itensAtualizados,
    usuario_nome,
  });

  return {
    itens_atualizados: itensAtualizados,
    pedidos_atualizados: pedido_ids.length,
  };
}

/**
 * Variante do cascade: itens vão pra `compra_status='oc_pendente'`,
 * pedidos pra `status_separacao='validacao_oc'` (fila "pick OC").
 *
 * Decisão 2026-06-12: quando o cascade esgota sem cobertura de SISTEMA em
 * galpão nenhum, a loc cadastrada pode estar errada e a peça existir noutra
 * prateleira. Em vez de mandar direto pra Compras, o pedido entra no pick OC —
 * o fluxo EXISTENTE de busca física (validar-oc-item: "encontrei" bipa loc nova
 * + contagem inline · "esgotado" → compras) decide. Espelha o estado que o
 * execution-worker já cria pra pedidos OC de webhook (execution-worker.ts).
 */
export async function mandarItensParaValidacaoOC(
  args: MandarComprasArgs,
): Promise<MandarComprasResult> {
  const { supabase, pedido_ids, item_ids, usuario_id, usuario_nome } = args;
  const now = new Date().toISOString();

  const { data: items } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, sku, quantidade_pedida, quantidade_pega, fornecedor_oc",
    )
    .in("id", item_ids);

  if (!items || items.length === 0) {
    return { itens_atualizados: 0, pedidos_atualizados: 0 };
  }

  let itensAtualizados = 0;
  for (const item of items) {
    const qtyResidual = Math.max(
      0,
      Number(item.quantidade_pedida ?? 0) - Number(item.quantidade_pega ?? 0),
    );
    const fornecedor =
      item.fornecedor_oc || getFornecedorBySku(item.sku ?? "").fornecedor;

    const { error: updErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "oc_pendente",
        compra_quantidade_solicitada: qtyResidual,
        compra_solicitada_em: now,
        fornecedor_oc: fornecedor,
      })
      .eq("id", item.id);

    if (updErr) {
      logger.warn("mandar-compras", "falhou update item (validacao_oc)", {
        item_id: item.id,
        err: updErr.message,
      });
      continue;
    }

    itensAtualizados++;

    registrarEvento({
      pedidoId: item.pedido_id,
      evento: "enviado_validacao_oc_pos_zerou",
      usuarioId: usuario_id,
      usuarioNome: usuario_nome,
      detalhes: {
        item_id: item.id,
        sku: item.sku,
        qty_residual: qtyResidual,
        fornecedor,
      },
    }).catch(() => {});
  }

  await supabase
    .from("siso_pedidos")
    .update({
      status_separacao: "validacao_oc",
      separacao_operador_id: null,
      separacao_iniciada_em: null,
    })
    .in("id", pedido_ids);

  logger.info("mandar-compras", "transição pra validacao_oc executada", {
    pedido_ids,
    item_ids,
    itens_atualizados: itensAtualizados,
    usuario_nome,
  });

  return {
    itens_atualizados: itensAtualizados,
    pedidos_atualizados: pedido_ids.length,
  };
}
