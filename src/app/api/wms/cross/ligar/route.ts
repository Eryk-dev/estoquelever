import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase-server";
import { criarLigacao } from "@/lib/cross/equivalencias";
import { saoLigaveis } from "@/lib/cross/equivalencias-core";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/** POST /api/wms/cross/ligar { sku_a, sku_b } → cria palpite (sugestao). */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "produtos.editar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  let body: { sku_a?: string; sku_b?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const a = body.sku_a?.trim();
  const b = body.sku_b?.trim();
  if (!a || !b) return NextResponse.json({ error: "Envie sku_a e sku_b" }, { status: 400 });
  if (!saoLigaveis(a, b)) {
    return NextResponse.json({ error: "Não dá pra ligar uma peça com ela mesma" }, { status: 400 });
  }

  const sb = createServiceClient();
  // Garante que os dois SKUs existem no catálogo principal.
  const { data: existem } = await sb.from("siso_produtos").select("sku").in("sku", [a, b]);
  if (!existem || existem.length < 2) {
    return NextResponse.json({ error: "SKU não encontrado no catálogo" }, { status: 404 });
  }

  try {
    const r = await criarLigacao(sb, { a, b, criadoPor: session.id });
    return NextResponse.json({ ok: true, id: r.id, criado: r.criado }, { status: r.criado ? 201 : 200 });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.ligar", error, message: "erro criando ligação" });
  }
}
