/**
 * Mercado Livre OAuth2 — Authorization Code flow + Refresh.
 *
 * Endpoints (site BR):
 *   - Authorize: https://auth.mercadolivre.com.br/authorization
 *   - Token:     https://api.mercadolibre.com/oauth/token
 *
 * Notas importantes do ML:
 *   - access_token dura 6h (21600s)
 *   - refresh_token é single-use: cada refresh devolve um novo refresh_token
 *   - refresh_token caduca em 6 meses se não usado
 *   - redirect_uri tem que bater EXATAMENTE com o cadastrado no DevCenter
 */
import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";

export const ML_AUTHORIZE_URL = "https://auth.mercadolivre.com.br/authorization";
export const ML_TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
export const ML_API_BASE = "https://api.mercadolibre.com";

// ─── Build authorize URL ────────────────────────────────────────────

export function buildMlAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(ML_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

// ─── Token response shapes ──────────────────────────────────────────

export interface MlTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // 21600 (6h)
  scope: string;
  token_type: string;
  user_id: number;
}

interface MlErrorResponse {
  error: string;
  error_description?: string;
  status?: number;
}

function isMlError(j: unknown): j is MlErrorResponse {
  return !!j && typeof j === "object" && "error" in (j as Record<string, unknown>);
}

// ─── Exchange code for tokens ───────────────────────────────────────

export async function exchangeMlCodeForTokens(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<MlTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });

  const res = await fetch(ML_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const j = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok || isMlError(j)) {
    const msg = isMlError(j)
      ? `${j.error}${j.error_description ? `: ${j.error_description}` : ""}`
      : `HTTP ${res.status}`;
    throw new Error(`ML token exchange failed: ${msg}`);
  }
  return j as MlTokenResponse;
}

// ─── Refresh access token ───────────────────────────────────────────

export async function refreshMlAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<MlTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
  });

  const res = await fetch(ML_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const j = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok || isMlError(j)) {
    const msg = isMlError(j)
      ? `${j.error}${j.error_description ? `: ${j.error_description}` : ""}`
      : `HTTP ${res.status}`;
    throw new Error(`ML token refresh failed: ${msg}`);
  }
  return j as MlTokenResponse;
}

// ─── App config helpers ─────────────────────────────────────────────

export interface MlAppConfig {
  id: string;
  app_id: string;
  client_secret: string;
  site_id: string;
  redirect_uri: string | null;
}

export async function getMlAppConfig(): Promise<MlAppConfig | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_ml_app_config")
    .select("id, app_id, client_secret, site_id, redirect_uri")
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function getMlAppConfigOrThrow(): Promise<MlAppConfig> {
  const cfg = await getMlAppConfig();
  if (!cfg) {
    throw new Error(
      "App do Mercado Livre não configurado. Cadastre App ID e Client Secret em /wms/configuracoes/conexoes",
    );
  }
  return cfg;
}

// ─── Get a valid token for a connection (auto-refresh) ──────────────

/**
 * Retorna um access_token válido pra conexão. Renova automaticamente se
 * faltam menos de 60s pra expirar. Persiste novo access+refresh na mesma
 * transação (refresh_token é single-use no ML).
 */
export async function getValidMlToken(connectionId: string): Promise<string> {
  const supabase = createServiceClient();

  const { data: conn, error } = await supabase
    .from("siso_ml_connections")
    .select(
      "id, access_token, refresh_token, token_expires_at, ml_user_id, nickname",
    )
    .eq("id", connectionId)
    .single();

  if (error || !conn) {
    throw new Error(`Conexão ML ${connectionId} não encontrada`);
  }
  if (!conn.access_token || !conn.refresh_token) {
    throw new Error(
      `Conexão ML ${conn.nickname} sem tokens — execute o fluxo OAuth primeiro`,
    );
  }

  const expiresAt = conn.token_expires_at
    ? new Date(conn.token_expires_at).getTime()
    : 0;
  const now = Date.now();

  if (expiresAt > now + 60_000) {
    return conn.access_token;
  }

  // Token vencido (ou expirando) → refresh
  const app = await getMlAppConfigOrThrow();
  logger.info("ml-oauth", "Refreshing access token", {
    connectionId,
    nickname: conn.nickname,
  });

  let tokens: MlTokenResponse;
  try {
    tokens = await refreshMlAccessToken({
      refreshToken: conn.refresh_token,
      clientId: app.app_id,
      clientSecret: app.client_secret,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from("siso_ml_connections")
      .update({ ultimo_erro: `refresh: ${msg}` })
      .eq("id", connectionId);

    logger.logError({
      error: err,
      source: "ml-oauth",
      message: "Refresh token falhou — re-autorização necessária",
      category: "auth",
      severity: "critical",
      metadata: { connectionId, nickname: conn.nickname },
    });
    throw err;
  }

  // Persiste novo access + refresh (ML troca o refresh_token a cada uso)
  await supabase
    .from("siso_ml_connections")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: new Date(
        Date.now() + tokens.expires_in * 1000,
      ).toISOString(),
      scope: tokens.scope,
      ultimo_erro: null,
    })
    .eq("id", connectionId);

  logger.info("ml-oauth", "Token refreshed", {
    connectionId,
    nickname: conn.nickname,
    expiresIn: tokens.expires_in,
  });

  return tokens.access_token;
}

// ─── Helper: redirect URI dinâmico baseado em request ───────────────

export function deriveMlRedirectUri(request: {
  headers: Headers;
  url: URL;
}): string {
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    request.url.host;
  return `${proto}://${host}/api/ml/oauth/callback`;
}
