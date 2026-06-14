import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { trocarSubstitutoDaTroca, TrocaError } from "@/lib/wms/trocas-equivalencia";
import { trocaErrorResponse } from "@/lib/wms/trocas-api";

/**
 * POST /api/wms/trocas/[id]/trocar-substituto
 *
 * Troca o substituto sugerido de uma troca PENDENTE por outro equivalente
 * (operador no modal escolhe entre as opções). Move as R reserva_troca do
 * substituto antigo pro novo (RPC atômica). A troca segue pendente — o
 * operador aprova depois. Exige vendas.aprovar_troca (D4).
 *
 * Body: { novo_sku: string }
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
  const novoSku = (body.novo_sku as string | undefined)?.trim();
  if (!novoSku) {
    return NextResponse.json({ error: "Envie { novo_sku }" }, { status: 400 });
  }

  try {
    const troca = await trocarSubstitutoDaTroca({
      trocaId: id,
      novoSku,
      usuarioId: session.id,
      usuarioNome: session.nome,
    });
    return NextResponse.json({ ok: true, troca });
  } catch (err) {
    if (err instanceof TrocaError) return trocaErrorResponse(err);
    logger.error("api.wms.trocas.trocar-substituto", "erro trocando substituto", {
      error: err instanceof Error ? err.message : String(err),
      troca_id: id,
    });
    return NextResponse.json(
      { error: "Erro interno ao trocar substituto" },
      { status: 500 },
    );
  }
}
