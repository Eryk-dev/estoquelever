import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ galpaoId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (session.cargo !== "admin") return NextResponse.json({ error: "apenas admin" }, { status: 403 });

  const { galpaoId } = await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.ativo !== "boolean") {
    return NextResponse.json({ error: "campo 'ativo' (boolean) obrigatório" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { error } = await sb.from("siso_wms_mini_swap_config").upsert({
    galpao_id: galpaoId,
    ativo: body.ativo,
    atualizado_em: new Date().toISOString(),
    atualizado_por: session.id,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
