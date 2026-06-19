import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase-server";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/** DELETE /api/wms/cross/[id] → remove a ligação. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  const { id } = await params;
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const sb = createServiceClient();
  const { data: row } = await sb
    .from("siso_cross_equivalencias")
    .select("id, status, criado_por")
    .eq("id", idNum)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "não encontrado" }, { status: 404 });

  // Palpite próprio: produtos.editar. Qualquer outro estado/dono: vendas.aprovar_troca.
  const ehPalpiteProprio = row.status === "sugestao" && row.criado_por === session.id;
  const permitido = ehPalpiteProprio
    ? userCan(session, "produtos.editar")
    : userCan(session, "vendas.aprovar_troca");
  if (!permitido) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  try {
    const { error } = await sb.from("siso_cross_equivalencias").delete().eq("id", idNum);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.delete", error, message: "erro removendo ligação" });
  }
}
