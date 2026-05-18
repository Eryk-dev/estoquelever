/**
 * /api/ml/app — credenciais globais do app dev (singleton)
 *
 * GET     → status + preview do App ID
 * PUT     → cria/atualiza app_id + client_secret
 * DELETE  → remove configuração (e por cascata invalida conexões na prox refresh)
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_ml_app_config")
    .select("id, app_id, client_secret, site_id, redirect_uri, atualizado_em")
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({
      configured: false,
      has_app_id: false,
      has_client_secret: false,
    });
  }

  const id = data.app_id ?? "";
  const secret = data.client_secret ?? "";
  return NextResponse.json({
    configured: true,
    has_app_id: !!id,
    has_client_secret: !!secret,
    app_id_preview: id ? `${id.slice(0, 6)}…${id.slice(-4)}` : null,
    site_id: data.site_id ?? "MLB",
    redirect_uri: data.redirect_uri ?? null,
    atualizado_em: data.atualizado_em,
  });
}

export async function PUT(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    app_id?: string;
    client_secret?: string;
    redirect_uri?: string | null;
    site_id?: string;
  };

  if (!body.app_id?.trim() || !body.client_secret?.trim()) {
    return NextResponse.json(
      { error: "app_id e client_secret são obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const { data: existing } = await supabase
    .from("siso_ml_app_config")
    .select("id")
    .limit(1)
    .maybeSingle();

  const payload = {
    app_id: body.app_id.trim(),
    client_secret: body.client_secret.trim(),
    site_id: body.site_id?.trim() || "MLB",
    redirect_uri: body.redirect_uri ?? null,
    atualizado_em: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await supabase
      .from("siso_ml_app_config")
      .update(payload)
      .eq("id", existing.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase
      .from("siso_ml_app_config")
      .insert(payload);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("siso_ml_app_config")
    .delete()
    .gte("atualizado_em", "1970-01-01");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
