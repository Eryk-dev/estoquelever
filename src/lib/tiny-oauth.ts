/**
 * Tiny ERP OAuth2 configuration and token management.
 *
 * Tiny v3 uses Keycloak-based OAuth2 Authorization Code flow:
 * - Authorization: https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth
 * - Token:         https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token
 * - Grant type:    authorization_code
 * - Scope:         openid
 * - Auth method:   credentials in body (not header)
 */

import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";

// ─── OAuth2 endpoints ───────────────────────────────────────────────────────

const TINY_AUTH_BASE =
  "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect";

export const TINY_AUTHORIZE_URL = `${TINY_AUTH_BASE}/auth`;
export const TINY_TOKEN_URL = `${TINY_AUTH_BASE}/token`;
export const TINY_SCOPE = "openid";

// ─── Build authorization URL ────────────────────────────────────────────────

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(TINY_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", TINY_SCOPE);
  url.searchParams.set("state", params.state);
  return url.toString();
}

// ─── Exchange authorization code for tokens ─────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
}

export async function exchangeCodeForTokens(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });

  const res = await fetch(TINY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
}

// ─── Refresh access token ───────────────────────────────────────────────────

export async function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const res = await fetch(TINY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
}

// ─── Get a valid access token for a connection ──────────────────────────────

/**
 * Returns a valid access_token for the given connection.
 * Automatically refreshes if expired.
 */
export async function getValidToken(connectionId: string): Promise<string> {
  const supabase = createServiceClient();

  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select(
      "id, access_token, refresh_token, token_expires_at, client_id, client_secret",
    )
    .eq("id", connectionId)
    .single();

  if (!conn) throw new Error("Connection not found");
  if (!conn.access_token || !conn.refresh_token) {
    throw new Error("Connection not authorized — complete OAuth2 flow first");
  }
  if (!conn.client_id || !conn.client_secret) {
    throw new Error("Client ID/Secret not configured");
  }

  // Check if token is still valid (with 60s buffer)
  const expiresAt = conn.token_expires_at
    ? new Date(conn.token_expires_at).getTime()
    : 0;
  const now = Date.now();

  if (expiresAt > now + 60_000) {
    return conn.access_token;
  }

  // Token expired — refresh
  logger.info("oauth", "Refreshing access token", { connectionId });

  let tokens;
  try {
    tokens = await refreshAccessToken({
      refreshToken: conn.refresh_token,
      clientId: conn.client_id,
      clientSecret: conn.client_secret,
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: "oauth",
      message: "Token refresh failed",
      category: "auth",
      severity: "critical",
      metadata: { connectionId },
    });
    throw err;
  }

  logger.info("oauth", "Token refreshed successfully", {
    connectionId,
    expiresIn: tokens.expires_in,
  });

  // Save new tokens
  await supabase
    .from("siso_tiny_connections")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: new Date(
        Date.now() + tokens.expires_in * 1000,
      ).toISOString(),
    })
    .eq("id", connectionId);

  return tokens.access_token;
}

// ─── Get valid token by empresa ─────────────────────────────────────────────

/**
 * Returns a valid access_token for the given empresa (company).
 * Looks up the connection via empresa_id in siso_tiny_connections.
 */
export async function getValidTokenByEmpresa(
  empresaId: string,
): Promise<{ token: string; connectionId: string }> {
  const supabase = createServiceClient();

  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("ativo", true)
    .single();

  if (!conn) throw new Error(`No active connection for empresa ${empresaId}`);

  const token = await getValidToken(conn.id);
  return { token, connectionId: conn.id };
}

// ─── Legacy: get valid token by filial (deprecated) ─────────────────────────

/** @deprecated Use getValidTokenByEmpresa instead */
export async function getValidTokenByFilial(
  filial: "CWB" | "SP",
): Promise<{ token: string; connectionId: string }> {
  const supabase = createServiceClient();

  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select("id")
    .eq("filial", filial)
    .eq("ativo", true)
    .single();

  if (!conn) throw new Error(`No active connection for filial ${filial}`);

  const token = await getValidToken(conn.id);
  return { token, connectionId: conn.id };
}
