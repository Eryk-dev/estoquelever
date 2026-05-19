import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * GET /api/wms/admin/printnode/contas
 *
 * Lista contas PrintNode (multi-key). Nunca expõe a api_key real — devolve
 * apenas um preview mascarado (••••XXXX) pra evitar leak.
 *
 * PUT/PATCH/DELETE de uma conta específica vivem em /contas/[id].
 * POST cria uma nova conta.
 *
 * Headers: x-siso-user-id (admin only)
 */
export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-siso-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: user } = await supabase
    .from("siso_usuarios")
    .select("cargo, cargos")
    .eq("id", userId)
    .single();

  if (!user || !(user.cargos ?? [user.cargo]).includes("admin")) {
    return NextResponse.json({ error: "Acesso restrito" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("siso_printnode_contas")
    .select("id, label, api_key, ativo, criado_em, atualizado_em")
    .order("label");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const result = (data ?? []).map((c) => ({
    id: c.id,
    label: c.label,
    ativo: c.ativo,
    masked: maskKey(c.api_key),
    criado_em: c.criado_em,
    atualizado_em: c.atualizado_em,
  }));

  return NextResponse.json(result);
}

/**
 * POST /api/wms/admin/printnode/contas
 * Body: { label: string, api_key: string }
 */
export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-siso-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: user } = await supabase
    .from("siso_usuarios")
    .select("cargo, cargos")
    .eq("id", userId)
    .single();

  if (!user || !(user.cargos ?? [user.cargo]).includes("admin")) {
    return NextResponse.json({ error: "Acesso restrito" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : "";

  if (!label) {
    return NextResponse.json({ error: "label é obrigatório" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: "api_key é obrigatório" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("siso_printnode_contas")
    .insert({ label, api_key: apiKey })
    .select("id, label, api_key, ativo, criado_em, atualizado_em")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Já existe uma conta com esse label" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      id: data.id,
      label: data.label,
      ativo: data.ativo,
      masked: maskKey(data.api_key),
      criado_em: data.criado_em,
      atualizado_em: data.atualizado_em,
    },
    { status: 201 },
  );
}

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "•".repeat(key.length);
  return "•".repeat(key.length - 4) + key.slice(-4);
}
