import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { criarProduto } from "@/lib/wms/produtos";
import { createServiceClient } from "@/lib/supabase-server";

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
  const sb = createServiceClient();
  const { data: existente } = await sb
    .from("siso_produtos")
    .select("id")
    .eq("sku", body.sku)
    .maybeSingle();
  if (existente) {
    return NextResponse.json({ error: "SKU já existe" }, { status: 409 });
  }
  try {
    const p = await criarProduto({ sku: body.sku, descricao: body.descricao });
    return NextResponse.json(p, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.produto",
      error: e,
      requestPath: "/api/wms/compras-manuais/produto",
      requestMethod: "POST",
    });
  }
}
