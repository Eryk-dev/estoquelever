/**
 * GET /api/wms/ml/oauth — inicia OAuth2 do ML
 *
 * Redireciona pra https://auth.mercadolivre.com.br/authorization com state
 * único. O state é guardado num cookie HttpOnly e validado no callback.
 *
 * Não precisa de connectionId: cada conexão é criada quando o callback
 * volta com sucesso (1 conexão por seller ML autorizado).
 */
import { NextRequest, NextResponse } from "next/server";
import { buildMlAuthorizeUrl, getMlAppConfig } from "@/lib/ml-oauth";

export async function GET(request: NextRequest) {
  const app = await getMlAppConfig();
  if (!app) {
    return NextResponse.json(
      { error: "App ML não configurado em /api/ml/app" },
      { status: 400 },
    );
  }

  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const forwardedHost =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    request.nextUrl.host;
  const origin = `${forwardedProto}://${forwardedHost}`;
  const redirectUri = app.redirect_uri ?? `${origin}/api/wms/ml/oauth/callback`;

  const state = crypto.randomUUID();
  const url = buildMlAuthorizeUrl({
    clientId: app.app_id,
    redirectUri,
    state,
  });

  const res = NextResponse.redirect(url);
  // Cookie HttpOnly pra validar no callback (CSRF defense)
  res.cookies.set("ml_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: forwardedProto === "https",
    maxAge: 600,
    path: "/",
  });
  return res;
}
