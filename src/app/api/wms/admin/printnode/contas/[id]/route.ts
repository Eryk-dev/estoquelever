import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * PATCH /api/wms/admin/printnode/contas/[id]
 * Body: { label?: string, api_key?: string, ativo?: boolean }
 *
 * - label/api_key vazios são rejeitados (em vez de virar string vazia).
 * - Trocar a api_key NÃO invalida atribuições existentes — galpões/usuários
 *   continuam apontando pra mesma conta, só passam a usar a key nova.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.label !== undefined) {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) {
      return NextResponse.json({ error: "label não pode ficar vazio" }, { status: 400 });
    }
    updates.label = label;
  }
  if (body.api_key !== undefined) {
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (!apiKey) {
      return NextResponse.json({ error: "api_key não pode ficar vazio" }, { status: 400 });
    }
    updates.api_key = apiKey;
  }
  if (body.ativo !== undefined) {
    updates.ativo = !!body.ativo;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nada pra atualizar" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("siso_printnode_contas")
    .update(updates)
    .eq("id", id)
    .select("id, label, api_key, ativo, criado_em, atualizado_em")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Já existe uma conta com esse label" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Conta não encontrada" }, { status: 404 });
  }

  return NextResponse.json({
    id: data.id,
    label: data.label,
    ativo: data.ativo,
    masked: maskKey(data.api_key),
    criado_em: data.criado_em,
    atualizado_em: data.atualizado_em,
  });
}

/**
 * DELETE /api/wms/admin/printnode/contas/[id]
 *
 * Remove a conta. FKs em siso_galpoes e siso_usuarios são ON DELETE SET NULL
 * — atribuições existentes viram null e o `resolverImpressora` passa a
 * retornar null (silent fallback pra "sem impressora").
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id } = await params;
  const { error } = await supabase
    .from("siso_printnode_contas")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "•".repeat(key.length);
  return "•".repeat(key.length - 4) + key.slice(-4);
}
