import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { aprovarTroca, TrocaError } from "@/lib/wms/trocas-equivalencia";
import {
  aprovarPedidoPosTroca,
  liberarPedidoPosTrocaOC,
  cascataTrocaOC,
} from "@/lib/wms/trocas-roteamento";
import { trocaErrorResponse } from "@/lib/wms/trocas-api";

/**
 * POST /api/wms/trocas/[id]/aprovar
 *
 * Aprova a troca pendente: libera as R do produto vendido, converte as R de
 * troca em R de pedido e aplica o substituto no item (RPC atômica).
 * Exige vendas.aprovar_troca (D4).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "vendas.aprovar_troca")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const troca = await aprovarTroca({
      trocaId: id,
      usuarioId: session.id,
      usuarioNome: session.nome,
    });

    // Troca nascida no ROTEAMENTO: quando a última pendente do pedido é
    // aprovada, o pedido (pendente, sugestao='troca_equivalente') é aprovado
    // como propria + enfileirado (mesma mecânica do painel).
    let pedidoAprovado = false;
    if (troca.origem_solicitacao === "roteamento") {
      const r = await aprovarPedidoPosTroca({
        pedidoId: String(troca.pedido_id),
        usuarioId: session.id,
        usuarioNome: session.nome,
      });
      pedidoAprovado = r.aprovado;
      if (!r.aprovado) {
        logger.info("api.wms.trocas.aprovar", "pedido não aprovado pós-troca", {
          troca_id: id,
          pedido_id: troca.pedido_id,
          motivo: r.motivo,
        });
      }
    } else {
      // Troca origem compras/separação/painel: se o pedido está parado em OC
      // (aguardando_compra/validacao_oc), tira o item de compras e libera o
      // pedido de volta pro fluxo (self-gate em estado OC; no-op se já em
      // separação). Sem isso o pedido fica preso na OC com o substituto
      // reservado (bug: troca aprovava mas pedido não saía da OC).
      const r = await liberarPedidoPosTrocaOC({
        pedidoId: String(troca.pedido_id),
        pedidoItemId: troca.pedido_item_id,
        usuarioId: session.id,
        usuarioNome: session.nome,
      });
      pedidoAprovado = r.liberado;
      if (!r.liberado) {
        logger.info("api.wms.trocas.aprovar", "pedido não liberado pós-troca", {
          troca_id: id,
          pedido_id: troca.pedido_id,
          motivo: r.motivo,
        });
      }
    }

    // CASCATA OC: aplica o mesmo substituto aos pedidos IRMÃOS parados em OC
    // (mesmo produto original + galpão), enquanto o saldo do substituto cobrir
    // (FIFO). O operador aprovou o par uma vez → vale pra todos os irmãos.
    // Não-fatal: a troca principal já foi aprovada.
    let pedidosCascateados: string[] = [];
    if (troca.galpao_id) {
      try {
        const c = await cascataTrocaOC({
          trocaAprovada: {
            pedido_item_id: troca.pedido_item_id,
            galpao_id: troca.galpao_id,
            sku_vendido: troca.sku_vendido,
            sku_substituto: troca.sku_substituto,
          },
          usuarioId: session.id,
          usuarioNome: session.nome,
        });
        pedidosCascateados = c.pedidosCascateados;
      } catch (e) {
        logger.warn("api.wms.trocas.aprovar", "cascata OC falhou (não-fatal)", {
          troca_id: id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return NextResponse.json({
      ok: true,
      troca,
      pedido_aprovado: pedidoAprovado,
      pedidos_cascateados: pedidosCascateados,
    });
  } catch (err) {
    if (err instanceof TrocaError) return trocaErrorResponse(err);
    logger.error("api.wms.trocas.aprovar", "erro aprovando troca", {
      error: err instanceof Error ? err.message : String(err),
      troca_id: id,
    });
    return NextResponse.json({ error: "Erro interno ao aprovar troca" }, { status: 500 });
  }
}
