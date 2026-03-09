import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * GET /api/tiny/connections
 * List all Tiny connections (secrets masked).
 */
export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_tiny_connections")
    .select(
      "id, filial, nome_empresa, cnpj, ativo, ultimo_teste_em, ultimo_teste_ok, client_id, client_secret, access_token, token_expires_at, deposito_id, deposito_nome, criado_em, atualizado_em",
    )
    .order("filial");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Mask secrets for display
  const masked = (data ?? []).map((c) => ({
    id: c.id,
    filial: c.filial,
    nome_empresa: c.nome_empresa,
    cnpj: c.cnpj,
    ativo: c.ativo,
    ultimo_teste_em: c.ultimo_teste_em,
    ultimo_teste_ok: c.ultimo_teste_ok,
    criado_em: c.criado_em,
    atualizado_em: c.atualizado_em,
    // OAuth2 status
    has_client_id: !!c.client_id,
    client_id_preview: c.client_id
      ? `${c.client_id.slice(0, 8)}...`
      : null,
    has_client_secret: !!c.client_secret,
    is_authorized: !!c.access_token,
    token_expires_at: c.token_expires_at,
    // Deposit selection
    deposito_id: c.deposito_id ?? null,
    deposito_nome: c.deposito_nome ?? null,
  }));

  return NextResponse.json(masked);
}

/**
 * PUT /api/tiny/connections
 * Update OAuth2 client credentials (client_id + client_secret).
 */
export async function PUT(request: NextRequest) {
  const body = (await request.json()) as {
    id?: string;
    client_id?: string;
    client_secret?: string;
    deposito_id?: number | null;
    deposito_nome?: string | null;
  };

  if (!body.id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  if (body.client_id !== undefined) {
    updates.client_id = body.client_id.trim();
  }
  if (body.client_secret !== undefined) {
    updates.client_secret = body.client_secret.trim();
  }

  // If credentials changed, clear existing tokens
  if (updates.client_id || updates.client_secret) {
    updates.access_token = null;
    updates.refresh_token = null;
    updates.token_expires_at = null;
    updates.token = null;
    updates.ultimo_teste_em = null;
    updates.ultimo_teste_ok = null;
  }

  // Deposit selection (independent of credential changes)
  if (body.deposito_id !== undefined) {
    updates.deposito_id = body.deposito_id;
  }
  if (body.deposito_nome !== undefined) {
    updates.deposito_nome = body.deposito_nome;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("siso_tiny_connections")
    .update(updates)
    .eq("id", body.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
