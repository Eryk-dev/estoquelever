import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { rotearPedidoDoBanco } from "@/lib/wms/roteamento";

export async function POST(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  if (!body.empresa_vendedora_id || !Array.isArray(body.itens)) {
    return NextResponse.json(
      { error: "empresa_vendedora_id e itens obrigatórios" },
      { status: 400 },
    );
  }
  try {
    const r = await rotearPedidoDoBanco(body.empresa_vendedora_id, body.itens);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
