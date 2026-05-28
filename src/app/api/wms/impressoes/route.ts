import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/wms/impressoes?status=erro&limit=50
 *
 * Lista jobs PrintNode rastreados pra retry/auditoria.
 * Status válidos: enviado | sucesso | erro | cancelado.
 *
 * [Fix-D #5.7] Operador acessa via /wms/etiquetas pra reimprimir jobs
 * que falharam (printer offline, conta inativa, timeout). Substituí o
 * toast volátil por fila persistente.
 */
export async function GET(request: Request) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.imprimir")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "erro";
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_impressoes_log")
    .select(
      "id, printnode_job_id, printer_id, printer_nome, contexto, contexto_ref_id, " +
        "total_etiquetas, status, erro_msg, enviado_em, atualizado_em, " +
        "usuario:siso_usuarios(nome), galpao:siso_galpoes(nome)",
    )
    .eq("status", status)
    .order("enviado_em", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ itens: data ?? [] });
}
