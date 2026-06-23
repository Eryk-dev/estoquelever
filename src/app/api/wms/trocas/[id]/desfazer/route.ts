import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { desfazerTrocaAplicada, TrocaError } from "@/lib/wms/trocas-equivalencia";
import { trocaErrorResponse } from "@/lib/wms/trocas-api";

/**
 * POST /api/wms/trocas/[id]/desfazer
 *
 * Desfaz uma troca de equivalência APLICADA num pedido reaberto e NÃO-picado
 * (BUG-A): libera a R do substituto, limpa produto_wms_substituto_id +
 * troca_equivalencia_id do item e fecha a troca como 'desfeita'. O item volta a
 * resolver pro produto original — o operador re-roteia OU solicita nova troca
 * (3º SKU). Exige vendas.aprovar_troca (D4).
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
    const resultado = await desfazerTrocaAplicada({
      trocaId: id,
      usuarioId: session.id,
      usuarioNome: session.nome,
    });
    return NextResponse.json(resultado);
  } catch (err) {
    if (err instanceof TrocaError) return trocaErrorResponse(err);
    logger.error("api.wms.trocas.desfazer", "erro desfazendo troca aplicada", {
      error: err instanceof Error ? err.message : String(err),
      troca_id: id,
    });
    return NextResponse.json(
      { error: "Erro interno ao desfazer troca" },
      { status: 500 },
    );
  }
}
