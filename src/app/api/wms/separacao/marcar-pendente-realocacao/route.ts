import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";

/**
 * POST /api/wms/separacao/marcar-pendente-realocacao
 *
 * Caminho legado preservado: vira pedido em pendente_realocacao pra
 * supervisor decidir. Acionado pelo botão "Pedir realocação manual"
 * no modal de cascade esgotado.
 *
 * Substitui a auto-transição que rodava dentro do endpoint de parcial
 * antes da Decisão 28/05 (que abria loop infinito ao voltar pra
 * /wms/pedidos Pendentes).
 *
 * Body: { pedido_ids: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.separar")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { pedido_ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const { pedido_ids } = body;
  if (!Array.isArray(pedido_ids) || pedido_ids.length === 0) {
    return NextResponse.json(
      { error: "pedido_ids obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("siso_pedidos")
    .update({ status_separacao: "pendente_realocacao" })
    .in("id", pedido_ids);

  if (error) {
    logger.warn("marcar-pendente-realocacao", "falhou update", {
      err: error.message,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logger.info(
    "marcar-pendente-realocacao",
    "pedidos marcados pendente_realocacao via caminho legado",
    { pedido_ids, operador: session.nome },
  );

  return NextResponse.json({
    ok: true,
    pedidos_atualizados: pedido_ids.length,
  });
}
