import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { receberEstoque } from "@/lib/wms/movimentacoes";
import { sugerirLocalizacaoPutaway } from "@/lib/wms/putaway";
import { createServiceClient } from "@/lib/supabase-server";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.empresa_dona_id || !body.galpao_id || !Array.isArray(body.itens)) {
    return NextResponse.json({ error: "campos obrigatórios faltando" }, { status: 400 });
  }
  try {
    await receberEstoque({ ...body, usuario_id: user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const produto_id = sp.get("produto_id");
  const empresa_id = sp.get("empresa_id");
  const galpao_id = sp.get("galpao_id");
  if (!produto_id || !empresa_id || !galpao_id) {
    return NextResponse.json(
      { error: "produto_id, empresa_id, galpao_id obrigatórios" },
      { status: 400 },
    );
  }
  try {
    const sb = createServiceClient();
    const sugestao = await sugerirLocalizacaoPutaway(sb as never, {
      produto_id,
      empresa_id,
      galpao_id,
    });
    return NextResponse.json(sugestao);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
