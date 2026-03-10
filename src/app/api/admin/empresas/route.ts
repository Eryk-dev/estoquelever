import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { clearEmpresaCache } from "@/lib/empresa-lookup";

/**
 * GET /api/admin/empresas
 */
export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_empresas")
    .select("id, nome, cnpj, galpao_id, ativo, criado_em")
    .order("nome");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * POST /api/admin/empresas
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { nome, cnpj, galpao_id } = body;

  if (!nome?.trim() || !cnpj?.trim() || !galpao_id) {
    return NextResponse.json({ error: "nome, cnpj e galpao_id são obrigatórios" }, { status: 400 });
  }

  const cleanCnpj = cnpj.replace(/\D/g, "");

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_empresas")
    .insert({ nome: nome.trim(), cnpj: cleanCnpj, galpao_id })
    .select("id, nome, cnpj")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "CNPJ já cadastrado" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Also create a siso_tiny_connections entry for this empresa
  await supabase.from("siso_tiny_connections").insert({
    filial: "CWB", // placeholder, will be deprecated
    nome_empresa: nome.trim(),
    cnpj: cleanCnpj,
    token: "",
    empresa_id: data.id,
  });

  clearEmpresaCache();
  return NextResponse.json(data, { status: 201 });
}
