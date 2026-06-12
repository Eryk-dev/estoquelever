import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { aprovarTroca, TrocaError } from "@/lib/wms/trocas-equivalencia";
import { aprovarPedidoPosTroca } from "@/lib/wms/trocas-roteamento";
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
    }

    return NextResponse.json({ ok: true, troca, pedido_aprovado: pedidoAprovado });
  } catch (err) {
    if (err instanceof TrocaError) return trocaErrorResponse(err);
    logger.error("api.wms.trocas.aprovar", "erro aprovando troca", {
      error: err instanceof Error ? err.message : String(err),
      troca_id: id,
    });
    return NextResponse.json({ error: "Erro interno ao aprovar troca" }, { status: 500 });
  }
}
