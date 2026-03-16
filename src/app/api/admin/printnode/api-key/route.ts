import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getConfig, setConfig, deleteConfig } from "@/lib/config";

const CONFIG_KEY = "PRINTNODE_API_KEY";

/**
 * GET /api/admin/printnode/api-key
 * Returns masked API key status (never exposes the full key).
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

  const key = await getConfig(CONFIG_KEY);
  if (!key) {
    return NextResponse.json({ configured: false, masked: null });
  }

  // Mask: show last 4 chars only
  const masked = key.length > 4
    ? "•".repeat(key.length - 4) + key.slice(-4)
    : "•".repeat(key.length);

  return NextResponse.json({ configured: true, masked });
}

/**
 * PUT /api/admin/printnode/api-key
 * Sets or updates the PrintNode API key.
 * Body: { api_key: string }
 */
export async function PUT(request: NextRequest) {
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
  if (!body?.api_key || typeof body.api_key !== "string" || body.api_key.trim().length === 0) {
    return NextResponse.json({ error: "api_key é obrigatório" }, { status: 400 });
  }

  await setConfig(CONFIG_KEY, body.api_key.trim());

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/admin/printnode/api-key
 * Removes the PrintNode API key.
 */
export async function DELETE(request: NextRequest) {
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

  await deleteConfig(CONFIG_KEY);

  return NextResponse.json({ ok: true });
}
