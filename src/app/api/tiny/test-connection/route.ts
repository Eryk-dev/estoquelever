import { NextRequest, NextResponse } from "next/server";
import { testarConexao } from "@/lib/tiny-api";
import { getValidToken } from "@/lib/tiny-oauth";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * POST /api/tiny/test-connection
 * Tests a Tiny ERP connection by using its OAuth2 access token.
 * Accepts { connectionId } to fetch + auto-refresh token from DB.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as { connectionId?: string };

  if (!body.connectionId) {
    return NextResponse.json(
      { ok: false, erro: "connectionId não informado" },
      { status: 400 },
    );
  }

  try {
    // Get valid (auto-refreshed) token
    const token = await getValidToken(body.connectionId);
    const result = await testarConexao(token);

    // Update test status
    const supabase = createServiceClient();
    await supabase
      .from("siso_tiny_connections")
      .update({
        ultimo_teste_em: new Date().toISOString(),
        ultimo_teste_ok: result.ok,
      })
      .eq("id", body.connectionId);

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    return NextResponse.json({ ok: false, erro: msg });
  }
}
