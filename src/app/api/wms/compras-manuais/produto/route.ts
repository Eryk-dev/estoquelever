import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { criarProduto } from "@/lib/wms/produtos";

// Criação inline de produto mínimo (sku+descrição) a partir do modal de compra
// manual. Sem dados fiscais — Tiny é a camada fiscal. Guard compras.executar.
export async function POST(req: NextRequest) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const body = await req.json();
  if (!body.sku || !body.descricao) {
    return NextResponse.json({ error: "sku e descricao obrigatórios" }, { status: 400 });
  }
  try {
    const p = await criarProduto({ sku: body.sku, descricao: body.descricao });
    return NextResponse.json(p, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.produto",
      error: e,
      status: 400,
      requestPath: "/api/wms/compras-manuais/produto",
      requestMethod: "POST",
    });
  }
}
