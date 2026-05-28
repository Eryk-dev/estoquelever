import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";

/**
 * POST /api/wms/guarda/[id]/desvincular-crossdock
 *
 * Decisão 9 (28/05): operador rejeita o cross-dock (queria guardar em outra
 * loc por algum motivo). Reseta prioridade='normal', limpa destino_sugerido
 * e desvincula pedidos_vinculados — pedidos voltam pra "Aguard. OC"
 * esperando próxima entrega.
 *
 * UI mostra confirmação dupla antes de chamar (botão verde = aceitar
 * cross-dock; link cinza = desvincular).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.guarda")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const supabase = createServiceClient();

  const { data: pend } = await supabase
    .from("siso_wms_pendencias_guarda")
    .select("id, prioridade, pedidos_vinculados, status")
    .eq("id", id)
    .maybeSingle();
  if (!pend) {
    return NextResponse.json(
      { error: "Pendência não encontrada" },
      { status: 404 },
    );
  }
  if (pend.prioridade !== "cross_dock") {
    return NextResponse.json(
      { error: "Pendência não é cross-dock" },
      { status: 422 },
    );
  }
  if (pend.status === "guardada") {
    return NextResponse.json(
      { error: "Pendência já guardada — não dá pra desvincular" },
      { status: 409 },
    );
  }

  const pedidosDesvinculados = pend.pedidos_vinculados?.length ?? 0;

  await supabase
    .from("siso_wms_pendencias_guarda")
    .update({
      prioridade: "normal",
      destino_sugerido_id: null,
      pedidos_vinculados: null,
    })
    .eq("id", id);

  logger.info("guarda.desvincular-crossdock", "cross-dock desvinculado", {
    pendencia_id: id,
    pedidos_desvinculados: pedidosDesvinculados,
    operador: session.nome,
  });

  return NextResponse.json({ ok: true, pedidos_desvinculados: pedidosDesvinculados });
}
