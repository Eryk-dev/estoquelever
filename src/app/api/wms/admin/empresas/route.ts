import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { clearEmpresaCache } from "@/lib/empresa-lookup";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/admin/empresas
 *
 * Lista plana de empresas com galpão "principal" (siso_empresas.galpao_id ─
 * espelha primeiro preferencial via trigger). Pra detalhe completo com lista
 * de preferenciais, usar GET /api/admin/galpoes (nested) ou a tabela
 * siso_empresa_galpoes_preferenciais diretamente.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.galpoes_empresas")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

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
 *
 * Body:
 *   - nome: string (obrigatório)
 *   - cnpj: string (obrigatório, só dígitos)
 *   - galpoes_preferenciais?: string[] — galpão preferencial 0..N (opcional)
 *   - galpao_id?: string — DEPRECADO; aceito como atalho equivalente a
 *     `galpoes_preferenciais: [galpao_id]`. Quando ausente e preferenciais
 *     também ausente, empresa fica sem preferencial nenhum (válido).
 *
 * Cria também a entrada base em siso_tiny_connections.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.galpoes_empresas")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const body = await request.json();
  const { nome, cnpj } = body;
  const galpoesInput = normalizePreferenciais(body);

  if (!nome?.trim() || !cnpj?.trim()) {
    return NextResponse.json(
      { error: "nome e cnpj são obrigatórios" },
      { status: 400 },
    );
  }

  const cleanCnpj = cnpj.replace(/\D/g, "");
  if (cleanCnpj.length < 8) {
    return NextResponse.json({ error: "CNPJ inválido" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_empresas")
    .insert({ nome: nome.trim(), cnpj: cleanCnpj })
    .select("id, nome, cnpj")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "CNPJ já cadastrado" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Insere preferenciais (se houver). Trigger atualiza siso_empresas.galpao_id
  // automaticamente pra primeiro preferencial.
  if (galpoesInput.length > 0) {
    const rows = galpoesInput.map((galpao_id) => ({
      empresa_id: data.id,
      galpao_id,
    }));
    const { error: prefError } = await supabase
      .from("siso_empresa_galpoes_preferenciais")
      .insert(rows);
    if (prefError) {
      return NextResponse.json(
        { error: `Empresa criada mas falhou ao registrar preferenciais: ${prefError.message}` },
        { status: 500 },
      );
    }
  }

  // Cria conexão Tiny placeholder (será preenchida via /api/tiny/connections).
  await supabase.from("siso_tiny_connections").insert({
    filial: "CWB", // placeholder, será deprecado
    nome_empresa: nome.trim(),
    cnpj: cleanCnpj,
    token: "",
    empresa_id: data.id,
  });

  clearEmpresaCache();
  return NextResponse.json(data, { status: 201 });
}

function normalizePreferenciais(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.galpoes_preferenciais)) {
    return [...new Set(body.galpoes_preferenciais.filter((x) => typeof x === "string"))] as string[];
  }
  if (typeof body.galpao_id === "string" && body.galpao_id) {
    return [body.galpao_id];
  }
  return [];
}
