import { createServiceClient } from "@/lib/supabase-server";
import { prepararPedidosDasOcsParaEmbalagem } from "@/lib/compras-embalagem";
import { logger } from "@/lib/logger";

export interface CrossDockTriggerResult {
  pedidos_separados: string[];
  ocs_processadas: string[];
}

/**
 * Decisão (28/05): trigger pós-confirmação de guarda.
 *
 * Se a pendência confirmada era cross-dock E o destino final é uma loc
 * tipo='packing', varre os pedidos vinculados — pra cada um, verifica se
 * TODOS os itens OC do pedido já foram recebidos. Se sim, dispara
 * prepararPedidosDasOcsParaEmbalagem que transita o pedido pra
 * status_separacao='separado'.
 *
 * Se operador rejeitou cross-dock (destino final != packing), trigger
 * vira no-op. Audita decisão pra log.
 */
export async function dispararTriggerCrossDock(args: {
  pendencia_id: string;
  destino_final_id: string;
}): Promise<CrossDockTriggerResult> {
  const supabase = createServiceClient();

  const { data: pend } = await supabase
    .from("siso_wms_pendencias_guarda")
    .select("id, prioridade, pedidos_vinculados, mov_entrada_id")
    .eq("id", args.pendencia_id)
    .maybeSingle();
  if (!pend || pend.prioridade !== "cross_dock") {
    return { pedidos_separados: [], ocs_processadas: [] };
  }
  if (!pend.pedidos_vinculados || pend.pedidos_vinculados.length === 0) {
    return { pedidos_separados: [], ocs_processadas: [] };
  }

  // Confirma que destino final é loc tipo 'packing'
  const { data: loc } = await supabase
    .from("siso_localizacoes")
    .select("tipo")
    .eq("id", args.destino_final_id)
    .maybeSingle();
  if (loc?.tipo !== "packing") {
    logger.info(
      "crossdock-trigger",
      "destino final não é packing — operador rejeitou cross-dock",
      {
        pendencia_id: args.pendencia_id,
        tipo: loc?.tipo,
      },
    );
    return { pedidos_separados: [], ocs_processadas: [] };
  }

  // Resolve ordem_compra_id via mov_entrada_id (mov.origem_id é o OC uuid)
  const { data: mov } = await supabase
    .from("siso_movimentacoes")
    .select("origem_id")
    .eq("id", pend.mov_entrada_id)
    .maybeSingle();
  const ocId = (mov?.origem_id as string | null) ?? null;
  if (!ocId) {
    logger.warn("crossdock-trigger", "mov sem origem_id — não dá pra resolver OC", {
      pendencia_id: args.pendencia_id,
    });
    return { pedidos_separados: [], ocs_processadas: [] };
  }

  // Pra cada pedido vinculado, verifica se TODOS itens OC chegaram
  const pedidosSeparados: string[] = [];
  for (const pedidoId of pend.pedidos_vinculados ?? []) {
    const { data: itens } = await supabase
      .from("siso_pedido_itens")
      .select(
        "compra_status, compra_quantidade_recebida, compra_quantidade_solicitada",
      )
      .eq("pedido_id", pedidoId);
    const todosRecebidos = (itens ?? []).every(
      (it) =>
        !it.compra_status ||
        Number(it.compra_quantidade_recebida ?? 0) >=
          Number(it.compra_quantidade_solicitada ?? 0),
    );
    if (todosRecebidos) {
      pedidosSeparados.push(pedidoId);
    }
  }

  const ocsProcessadas: string[] = [];
  if (pedidosSeparados.length > 0) {
    try {
      const res = await prepararPedidosDasOcsParaEmbalagem({
        ordemCompraIds: [ocId],
        usuarioId: null,
        usuarioNome: null,
      });
      ocsProcessadas.push(ocId);
      logger.info(
        "crossdock-trigger",
        "pedidos viraram separado via cross-dock",
        {
          pendencia_id: args.pendencia_id,
          oc_id: ocId,
          pedidos: pedidosSeparados,
          resultado: res,
        },
      );
    } catch (err) {
      logger.warn("crossdock-trigger", "prepararPedidosDasOcs falhou (não-fatal)", {
        err: err instanceof Error ? err.message : String(err),
        oc_id: ocId,
      });
    }
  }

  return {
    pedidos_separados: pedidosSeparados,
    ocs_processadas: ocsProcessadas,
  };
}
