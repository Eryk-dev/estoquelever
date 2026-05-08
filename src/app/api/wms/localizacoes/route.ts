import { NextRequest, NextResponse } from "next/server";
import { listarLocalizacoes, criarLocalizacao } from "@/lib/wms/localizacoes";
import { requireAuth, requireAdmin } from "@/lib/wms/auth";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const galpaoId = req.nextUrl.searchParams.get("galpao_id") ?? undefined;
  return NextResponse.json({ rows: await listarLocalizacoes(galpaoId) });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (!body.galpao_id || !body.codigo) {
    return NextResponse.json({ error: "galpao_id e codigo obrigatórios" }, { status: 400 });
  }
  try {
    const loc = await criarLocalizacao(body);
    return NextResponse.json(loc, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
