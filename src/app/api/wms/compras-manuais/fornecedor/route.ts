import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { criarFornecedor } from "@/lib/wms/fornecedores";
import { createServiceClient } from "@/lib/supabase-server";

// Criação inline de fornecedor a partir do modal de compra manual.
// Guard compras.executar (operador), não requireAdmin como /api/wms/fornecedores.
export async function POST(req: NextRequest) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const body = await req.json();
  if (!body.nome || typeof body.nome !== "string") {
    return NextResponse.json({ error: "nome obrigatório" }, { status: 400 });
  }
  const sb = createServiceClient();
  const { data: existente } = await sb
    .from("siso_fornecedores")
    .select("id")
    .ilike("nome", body.nome)
    .maybeSingle();
  if (existente) {
    return NextResponse.json({ error: "Fornecedor com esse nome já existe" }, { status: 409 });
  }
  try {
    const f = await criarFornecedor({
      nome: body.nome,
      cnpj: typeof body.cnpj === "string" && body.cnpj ? body.cnpj : undefined,
    });
    return NextResponse.json(f, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.fornecedor",
      error: e,
      requestPath: "/api/wms/compras-manuais/fornecedor",
      requestMethod: "POST",
    });
  }
}
