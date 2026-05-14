/**
 * GET /api/ml/oauth/callback — recebe code do ML
 *
 * Fluxo:
 *   1. Valida state (cookie HttpOnly)
 *   2. POST /oauth/token com authorization_code
 *   3. GET /users/me com novo token → pega nickname/email/site_id
 *   4. UPSERT siso_ml_connections por ml_user_id (suporta re-autorização)
 *   5. Redireciona pra /wms/configuracoes/conexoes?ml_success=nickname
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import {
  exchangeMlCodeForTokens,
  getMlAppConfig,
} from "@/lib/ml-oauth";
import { ML_API_BASE } from "@/lib/ml-oauth";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const forwardedHost =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    request.nextUrl.host;
  const publicOrigin = `${forwardedProto}://${forwardedHost}`;
  const back = new URL("/wms/configuracoes/conexoes", publicOrigin);

  function fail(reason: string) {
    back.searchParams.set("ml_error", reason);
    const res = NextResponse.redirect(back);
    res.cookies.delete("ml_oauth_state");
    return res;
  }

  if (error) return fail(error);
  if (!code || !state) return fail("missing_params");

  const expectedState = request.cookies.get("ml_oauth_state")?.value;
  if (!expectedState || expectedState !== state) {
    return fail("state_mismatch");
  }

  const app = await getMlAppConfig();
  if (!app) return fail("app_not_configured");

  const redirectUri = app.redirect_uri ?? `${publicOrigin}/api/ml/oauth/callback`;

  let tokens;
  try {
    tokens = await exchangeMlCodeForTokens({
      code,
      clientId: app.app_id,
      clientSecret: app.client_secret,
      redirectUri,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.logError({
      error: err,
      source: "ml-oauth-callback",
      message: "Token exchange failed",
      category: "auth",
      metadata: { redirectUri },
    });
    return fail(`token_exchange:${msg.slice(0, 100)}`);
  }

  // Pega dados do seller pra usar nickname como label
  let nickname = `seller_${tokens.user_id}`;
  let email: string | null = null;
  let siteId = app.site_id;
  try {
    const meRes = await fetch(`${ML_API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (meRes.ok) {
      const me = (await meRes.json()) as {
        nickname?: string;
        email?: string;
        site_id?: string;
      };
      nickname = me.nickname ?? nickname;
      email = me.email ?? null;
      siteId = me.site_id ?? siteId;
    }
  } catch {
    // não bloqueia o save
  }

  const supabase = createServiceClient();
  const payload = {
    ml_user_id: tokens.user_id,
    nickname,
    email,
    site_id: siteId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    scope: tokens.scope,
    ativo: true,
    ultimo_sync_em: new Date().toISOString(),
    ultimo_erro: null,
    oauth_state: null,
  };

  const { error: upsertErr } = await supabase
    .from("siso_ml_connections")
    .upsert(payload, { onConflict: "ml_user_id" });

  if (upsertErr) {
    logger.logError({
      error: upsertErr,
      source: "ml-oauth-callback",
      message: "Upsert connection falhou",
      category: "database",
      metadata: { ml_user_id: tokens.user_id, nickname },
    });
    return fail(`db:${upsertErr.message.slice(0, 100)}`);
  }

  back.searchParams.set("ml_success", nickname);
  const res = NextResponse.redirect(back);
  res.cookies.delete("ml_oauth_state");
  return res;
}
