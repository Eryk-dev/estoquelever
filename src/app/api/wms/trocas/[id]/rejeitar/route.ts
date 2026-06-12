import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { rejeitarTroca, TrocaError } from "@/lib/wms/trocas-equivalencia";
import { reRotearPedidoPosTroca } from "@/lib/wms/trocas-roteamento";
import { trocaErrorResponse } from "@/lib/wms/trocas-api";

/**
 * POST /api/wms/trocas/[id]/rejeitar
 *
 * Rejeita a troca pendente: libera as R de troca do substituto e fecha a
 * solicitação (RPC atômica). O pedido segue o caminho normal — quando a
 * origem é 'roteamento', o caller (painel) dispara o re-roteamento (D8).
 *
 * Body: { motivo?: string }
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
  const body = await request.json().catch(() => ({}));
  const motivo = (body.motivo as string | undefined)?.trim() || undefined;

  try {
    const troca = await rejeitarTroca({
      trocaId: id,
      usuarioId: session.id,
      usuarioNome: session.nome,
      motivo,
    });

    // Troca nascida no ROTEAMENTO rejeitada → re-roteia automático (D8):
    // propria (estoque apareceu) / transferencia (painel) / oc (auto).
    let reRoteado: string | null = null;
    if (troca.origem_solicitacao === "roteamento") {
      try {
        const r = await reRotearPedidoPosTroca({
          pedidoId: String(troca.pedido_id),
          usuarioId: session.id,
        });
        reRoteado = r.acao;
      } catch (e) {
        logger.error("api.wms.trocas.rejeitar", "re-rotear pós-rejeição falhou", {
          troca_id: id,
          pedido_id: troca.pedido_id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return NextResponse.json({ ok: true, troca, re_roteado: reRoteado });
  } catch (err) {
    if (err instanceof TrocaError) return trocaErrorResponse(err);
    logger.error("api.wms.trocas.rejeitar", "erro rejeitando troca", {
      error: err instanceof Error ? err.message : String(err),
      troca_id: id,
    });
    return NextResponse.json({ error: "Erro interno ao rejeitar troca" }, { status: 500 });
  }
}
