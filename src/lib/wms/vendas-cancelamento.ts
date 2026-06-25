import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { liberarReserva, estornarReservaIndividual } from "./reservas";
import { registrarEvento } from "@/lib/historico-service";
import { classificarItensParaCancelamento } from "./cancelamento-parcial";
import { camposCancelamento } from "./cancelamento-fields";

/**
 * P3 #7.13 — cancela uma venda manual.
 *
 * Casos:
 *   - Venda em status_separacao='aguardando_separacao'|'aguardando_compra'
 *     (modo separação ainda não picada): libera reservas R (se houver),
 *     marca pedido como 'cancelado'.
 *   - Venda em status='concluido' com movs de baixa_direta (modo baixa
 *     direta): estorna cada mov S, marca pedido como 'cancelado'.
 *   - Venda em separação parcial ('em_separacao', 'separado', 'embalado'):
 *     libera as reservas R ainda abertas, preserva as movs S dos itens já
 *     pegos (auditoria), marca pedido como 'cancelado' e retorna
 *     itensParaDevolverManual (itens pegos → pendência de devolução manual).
 *   - Pedido já 'cancelado': retorna { movsEstornadas: 0, reservasLiberadas: 0 }
 *     (idempotente).
 *
 * Nota: `siso_pedidos.id` é text ('MAN-...'). Em modo baixa_direta as movs
 * são gravadas com `origem_id=uuid_aleatorio` + `origem_detalhes.pedido_id_manual=MAN-...`
 * (não em `pedido_id`), então a busca de movs estornáveis acontece via
 * filtro JSONB no `origem_detalhes->>'pedido_id_manual'`.
 */
export async function cancelarVendaManual(input: {
  pedido_id: string;
  usuario_id: string;
  motivo: string;
}): Promise<{ movsEstornadas: number; reservasLiberadas: number; itensParaDevolverManual: Array<{ id: string; sku: string | null }> }> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do cancelamento é obrigatório (≥3 caracteres)");
  }

  const sb = createServiceClient();

  const { data: pedido, error: pedErr } = await sb
    .from("siso_pedidos")
    .select("id, status, status_separacao")
    .eq("id", input.pedido_id)
    .maybeSingle();
  if (pedErr) {
    throw new Error(`falha lendo pedido: ${pedErr.message}`);
  }
  if (!pedido) {
    throw new Error("pedido não encontrado");
  }
  const p = pedido as {
    id: string;
    status: string;
    status_separacao: string | null;
  };

  let movsEstornadas = 0;
  let reservasLiberadas = 0;
  let itensParaDevolverManual: Array<{ id: string; sku: string | null }> = [];

  // Idempotente: já cancelado
  if (p.status === "cancelado") {
    return { movsEstornadas: 0, reservasLiberadas: 0, itensParaDevolverManual: [] };
  }

  // D1 (P007): libera TODAS as R vivas do pedido. As R dos itens já pegos foram
  // consumidas no pick (R→L+S), então estornarReservaIndividual é idempotente-no-op
  // nelas; efetivamente só as R dos não-pegos são liberadas. A S dos pegos NÃO é
  // estornada (auditoria preservada); pegos viram pendência de devolução manual.
  if (["em_separacao", "separado", "embalado", "conferido"].includes(p.status_separacao ?? "")) {
    const { data: itensRaw } = await sb
      .from("siso_pedido_itens")
      .select("id, sku, mov_saida_id, quantidade_pega")
      .eq("pedido_id", input.pedido_id);
    const { pegos } = classificarItensParaCancelamento(
      (itensRaw ?? []).map((i) => ({
        id: String(i.id),
        sku: (i.sku as string) ?? null,
        mov_saida_id: (i.mov_saida_id as string) ?? null,
        quantidade_pega: (i.quantidade_pega as number) ?? null,
      })),
    );
    itensParaDevolverManual = pegos.map((i) => ({ id: i.id, sku: i.sku }));

    const { data: reservasAbertas, error: rQErr } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("origem_id", input.pedido_id);
    if (rQErr) {
      logger.warn("wms.vendas.cancelar", "falha buscando Rs (segue)", { pedido_id: input.pedido_id, error: rQErr.message });
    }
    for (const r of (reservasAbertas ?? []) as Array<{ id: string }>) {
      try {
        await estornarReservaIndividual({ reserva_id: r.id, motivo: "outro", usuario_id: input.usuario_id });
        reservasLiberadas++;
      } catch (e) {
        logger.warn("wms.vendas.cancelar", "falha estornando R não-pego (segue)", {
          pedido_id: input.pedido_id, reserva_id: r.id, error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const { error: updErr } = await sb
      .from("siso_pedidos")
      .update({
        status: "cancelado",
        status_separacao: null,
        ...camposCancelamento("operador", input.motivo ?? "Cancelado na venda"),
      })
      .eq("id", input.pedido_id);
    if (updErr) throw new Error(`falha ao atualizar status: ${updErr.message}`);

    registrarEvento({
      pedidoId: input.pedido_id,
      evento: "cancelado",
      usuarioId: input.usuario_id,
      detalhes: {
        motivo: input.motivo,
        modo: "separacao_parcial",
        reservas_liberadas: reservasLiberadas,
        itens_devolucao_manual: itensParaDevolverManual,
        origem: "cancelarVendaManual",
      },
    }).catch(() => {});

    return { movsEstornadas: 0, reservasLiberadas, itensParaDevolverManual };
  }

  // Caminho 1: separação ainda não iniciada — libera R se existirem.
  if (
    p.status_separacao === "aguardando_separacao" ||
    p.status_separacao === "aguardando_compra"
  ) {
    try {
      reservasLiberadas = await liberarReserva({
        pedido_id: input.pedido_id,
        motivo: "cancelamento",
        usuario_id: input.usuario_id,
      });
    } catch (err) {
      // Se falhar a liberação, propaga o erro pra não silenciar inconsistência.
      logger.error("wms.vendas.cancelar", "falha ao liberar reservas", {
        pedido_id: input.pedido_id,
        erro: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Caminho 2: baixa direta — estorno das N S + status na MESMA tx via RPC.
  // A RPC casa as S por origem_detalhes->>'pedido_id_manual' (siso_pedidos.id é
  // text 'MAN-...'), estorna como bloco indivisível e marca o pedido cancelado.
  // Quando não há S (veio só do caminho 1 de reservas), estorna 0 e mesmo assim
  // marca cancelado — unifica o UPDATE de status dos dois caminhos.
  const { data: rpcRes, error: rpcErr } = await sb.rpc("wms_cancelar_venda_atomico", {
    p_pedido_id: input.pedido_id,
    p_usuario_id: input.usuario_id,
    p_motivo: input.motivo,
  });
  if (rpcErr) throw new Error(`falha ao cancelar venda: ${rpcErr.message}`);
  movsEstornadas = Number((rpcRes as { movs_estornadas: number }).movs_estornadas);

  // Audit fire-and-forget
  registrarEvento({
    pedidoId: input.pedido_id,
    evento: "cancelado",
    usuarioId: input.usuario_id,
    detalhes: {
      motivo: input.motivo,
      movs_estornadas: movsEstornadas,
      reservas_liberadas: reservasLiberadas,
      origem: "cancelarVendaManual",
    },
  }).catch(() => {
    /* fire-and-forget */
  });

  return { movsEstornadas, reservasLiberadas, itensParaDevolverManual };
}
