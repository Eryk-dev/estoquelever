import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { exchangeCodeForTokens } from "@/lib/tiny-oauth";
import { testarConexao } from "@/lib/tiny-api";

/**
 * GET /api/tiny/oauth/callback?code=xxx&state=xxx
 *
 * OAuth2 callback. Exchanges authorization code for tokens.
 * Redirects back to /configuracoes with status.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  const configUrl = new URL("/configuracoes", request.nextUrl.origin);

  // Handle OAuth errors
  if (error) {
    configUrl.searchParams.set("oauth_error", error);
    return NextResponse.redirect(configUrl);
  }

  if (!code || !state) {
    configUrl.searchParams.set("oauth_error", "missing_params");
    return NextResponse.redirect(configUrl);
  }

  // Extract connectionId from state
  const connectionId = state.split(":")[0];
  if (!connectionId) {
    configUrl.searchParams.set("oauth_error", "invalid_state");
    return NextResponse.redirect(configUrl);
  }

  const supabase = createServiceClient();

  // Validate state (CSRF protection)
  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select("id, client_id, client_secret, oauth_state, filial")
    .eq("id", connectionId)
    .single();

  if (!conn || conn.oauth_state !== state) {
    configUrl.searchParams.set("oauth_error", "state_mismatch");
    return NextResponse.redirect(configUrl);
  }

  try {
    // Exchange code for tokens
    const redirectUri = `${request.nextUrl.origin}/api/tiny/oauth/callback`;
    const tokens = await exchangeCodeForTokens({
      code,
      clientId: conn.client_id,
      clientSecret: conn.client_secret,
      redirectUri,
    });

    // Test the new token
    const testResult = await testarConexao(tokens.access_token);

    // Save tokens
    await supabase
      .from("siso_tiny_connections")
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: new Date(
          Date.now() + tokens.expires_in * 1000,
        ).toISOString(),
        token: tokens.access_token, // backward compat
        oauth_state: null, // clear state
        ultimo_teste_em: new Date().toISOString(),
        ultimo_teste_ok: testResult.ok,
      })
      .eq("id", connectionId);

    configUrl.searchParams.set("oauth_success", conn.filial);
    return NextResponse.redirect(configUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown_error";
    configUrl.searchParams.set("oauth_error", msg);
    return NextResponse.redirect(configUrl);
  }
}
