/**
 * /api/ml/connections — lista de conexões ML (multi-conta)
 *
 * GET     → lista todas com tokens mascarados
 * PATCH   → toggle ativo / vincular empresa
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_ml_connections")
    .select(
      `id, ml_user_id, nickname, email, site_id, scope,
       access_token, token_expires_at, ativo, empresa_id,
       ultimo_sync_em, ultimo_erro, criada_em, atualizada_em,
       siso_empresas(id, nome, cnpj)`,
    )
    .order("nickname");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const masked = (data ?? []).map((c) => ({
    id: c.id,
    ml_user_id: c.ml_user_id,
    nickname: c.nickname,
    email: c.email,
    site_id: c.site_id,
    scope: c.scope,
    ativo: c.ativo,
    empresa_id: c.empresa_id,
    empresa: c.siso_empresas
      ? {
          id: (c.siso_empresas as unknown as { id: string }).id,
          nome: (c.siso_empresas as unknown as { nome: string }).nome,
          cnpj: (c.siso_empresas as unknown as { cnpj: string }).cnpj,
        }
      : null,
    is_authorized: !!c.access_token,
    token_expires_at: c.token_expires_at,
    ultimo_sync_em: c.ultimo_sync_em,
    ultimo_erro: c.ultimo_erro,
    criada_em: c.criada_em,
    atualizada_em: c.atualizada_em,
  }));

  return NextResponse.json(masked);
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    ativo?: boolean;
    empresa_id?: string | null;
  };
  if (!body.id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.ativo !== undefined) updates.ativo = body.ativo;
  if (body.empresa_id !== undefined) updates.empresa_id = body.empresa_id;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("siso_ml_connections")
    .update(updates)
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
