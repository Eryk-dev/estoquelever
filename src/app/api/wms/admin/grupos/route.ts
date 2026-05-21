import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/admin/grupos
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.galpoes_empresas")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_grupos")
    .select(`
      id, nome, descricao, criado_em,
      siso_grupo_empresas (
        id, tier,
        siso_empresas ( id, nome, cnpj )
      )
    `)
    .order("nome");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * POST /api/admin/grupos
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.galpoes_empresas")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const body = await request.json();
  const { nome, descricao } = body;

  if (!nome?.trim()) {
    return NextResponse.json({ error: "Nome é obrigatório" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_grupos")
    .insert({ nome: nome.trim(), descricao: descricao?.trim() || null })
    .select("id, nome")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Nome já existe" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
