import { NextRequest, NextResponse } from "next/server";
import { listarLocalizacoes, criarLocalizacao } from "@/lib/wms/localizacoes";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const galpaoId = req.nextUrl.searchParams.get("galpao_id") ?? undefined;
  return NextResponse.json({ rows: await listarLocalizacoes(galpaoId) });
}

export async function POST(req: NextRequest) {
  // Operadores podem criar códigos no fluxo, desde que o galpão selecionado
  // esteja marcado como editável no vínculo do usuário.
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (!body.galpao_id || !body.codigo) {
    return NextResponse.json({ error: "galpao_id e codigo obrigatórios" }, { status: 400 });
  }
  try {
    const loc = await criarLocalizacao(body);
    return NextResponse.json(loc, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.localizacoes.criar",
      error: e,
      requestPath: "/api/wms/localizacoes",
      requestMethod: "POST",
      metadata: { galpao_id: body.galpao_id, codigo: body.codigo },
    });
  }
}
