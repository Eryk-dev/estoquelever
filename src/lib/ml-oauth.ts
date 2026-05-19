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

/**
 * Scope `offline_access` é OBRIGATÓRIO pra o ML devolver refresh_token —
 * sem ele, o token de acesso dura só 6h e a conexão morre quando expira.
 * `read` + `write` cobrem todos os endpoints (consulta de items + futura
 * atualização de estoque/preço).
 */
export const ML_DEFAULT_SCOPE = "offline_access read write";

export function buildMlAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL(ML_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("scope", params.scope ?? ML_DEFAULT_SCOPE);
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
 * Buffer pré-expiry: refresh se faltam menos que isso. Levercopy usa 5min;
 * adotei o mesmo valor — o token dura 6h, então 5min é bem conservador e
 * cobre operações longas (paginação, multi-get, retries).
 */
const REFRESH_BUFFER_MS = 5 * 60_000;

/**
 * TTL do lease lock de refresh. Se o processo claimer cair (lambda timeout,
 * crash), outro processo pode reivindicar depois desse prazo. 30s é >> que
 * a duração esperada de uma chamada /oauth/token (~1s).
 */
const REFRESH_LEASE_TTL_MS = 30_000;

/** Poll interval enquanto espera outro processo terminar o refresh. */
const REFRESH_POLL_INTERVAL_MS = 400;
const REFRESH_POLL_MAX_ATTEMPTS = 50; // 50 × 400ms = 20s

interface ConnRow {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  nickname: string;
  refreshing_at: string | null;
}

async function readConn(connectionId: string): Promise<ConnRow> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_ml_connections")
    .select(
      "id, access_token, refresh_token, token_expires_at, nickname, refreshing_at",
    )
    .eq("id", connectionId)
    .single();
  if (error || !data) {
    throw new Error(`Conexão ML ${connectionId} não encontrada`);
  }
  return data as ConnRow;
}

function tokenValid(conn: ConnRow, bufferMs = REFRESH_BUFFER_MS): boolean {
  if (!conn.access_token || !conn.token_expires_at) return false;
  return new Date(conn.token_expires_at).getTime() > Date.now() + bufferMs;
}

/**
 * Tenta reivindicar o lease lock de refresh pra esta conexão. Retorna a
 * linha completa SE conseguir claim (precisamos do refresh_token dentro da
 * janela protegida). Retorna null se outro processo já tem o lease.
 *
 * Usa UPDATE atômico com WHERE composto:
 *   - id = $id
 *   - (refreshing_at IS NULL OR refreshing_at < now() - 30s)  // lease livre ou expirado
 *
 * Sob concorrência, só 1 UPDATE retorna linha — os demais retornam vazio.
 */
async function claimRefreshLease(
  connectionId: string,
): Promise<ConnRow | null> {
  const supabase = createServiceClient();
  const staleCutoff = new Date(
    Date.now() - REFRESH_LEASE_TTL_MS,
  ).toISOString();

  const { data, error } = await supabase
    .from("siso_ml_connections")
    .update({ refreshing_at: new Date().toISOString() })
    .eq("id", connectionId)
    .or(`refreshing_at.is.null,refreshing_at.lt.${staleCutoff}`)
    .select(
      "id, access_token, refresh_token, token_expires_at, nickname, refreshing_at",
    )
    .maybeSingle();

  if (error) {
    throw new Error(`Falha ao reivindicar lease ML: ${error.message}`);
  }
  return (data as ConnRow) ?? null;
}

async function clearLease(
  connectionId: string,
  patch: Record<string, unknown> = {},
): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from("siso_ml_connections")
    .update({ refreshing_at: null, ...patch })
    .eq("id", connectionId);
}

async function performRefresh(claimed: ConnRow): Promise<string> {
  const supabase = createServiceClient();
  const app = await getMlAppConfigOrThrow();

  if (!claimed.refresh_token) {
    await clearLease(claimed.id, {
      ultimo_erro: "refresh: sem refresh_token salvo",
      ativo: false,
    });
    throw new Error(
      `Conexão ML ${claimed.nickname} sem refresh_token — reconecte`,
    );
  }

  logger.info("ml-oauth", "Refreshing access token", {
    connectionId: claimed.id,
    nickname: claimed.nickname,
  });

  let tokens: MlTokenResponse;
  try {
    tokens = await refreshMlAccessToken({
      refreshToken: claimed.refresh_token,
      clientId: app.app_id,
      clientSecret: app.client_secret,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isInvalidGrant =
      /invalid_grant|invalid_token|invalid_refresh/i.test(msg);

    // invalid_grant = refresh_token revogado/inválido → desativa conexão
    // pra forçar re-auth (não adianta seguir tentando)
    const patch: Record<string, unknown> = {
      ultimo_erro: `refresh: ${msg}`,
    };
    if (isInvalidGrant) {
      patch.ativo = false;
      patch.access_token = null;
      patch.refresh_token = null;
      patch.token_expires_at = null;
    }
    await clearLease(claimed.id, patch);

    logger.logError({
      error: err,
      source: "ml-oauth",
      message: isInvalidGrant
        ? "Refresh token revogado/inválido — conexão desativada"
        : "Refresh token falhou",
      category: "auth",
      severity: isInvalidGrant ? "critical" : "error",
      metadata: { connectionId: claimed.id, nickname: claimed.nickname },
    });
    throw err;
  }

  // Persiste novo access + refresh em UMA chamada com clear do lease.
  // refresh_token é single-use no ML — precisa ser persistido aqui antes
  // de qualquer outro consumidor poder usar a conexão.
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
      refreshing_at: null,
    })
    .eq("id", claimed.id);

  logger.info("ml-oauth", "Token refreshed", {
    connectionId: claimed.id,
    nickname: claimed.nickname,
    expiresIn: tokens.expires_in,
  });

  return tokens.access_token;
}

/**
 * Espera (poll) outro processo terminar o refresh, retornando o novo
 * access_token quando ele aparecer.
 */
async function waitForOtherRefresh(connectionId: string): Promise<string> {
  for (let i = 0; i < REFRESH_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, REFRESH_POLL_INTERVAL_MS));
    const fresh = await readConn(connectionId);
    if (fresh.refreshing_at === null && tokenValid(fresh, 60_000)) {
      return fresh.access_token!;
    }
    // Se o lease expirou (outro processo crashou), volta pro caller pra
    // tentar reivindicar.
    if (
      fresh.refreshing_at &&
      new Date(fresh.refreshing_at).getTime() <
        Date.now() - REFRESH_LEASE_TTL_MS
    ) {
      throw new Error("__retry_claim__");
    }
  }
  throw new Error(
    `Timeout aguardando refresh do ML (conexão ${connectionId})`,
  );
}

/**
 * Retorna um access_token válido pra conexão. Renova automaticamente se
 * faltam menos de 5min pra expirar. Garante single-flight via lease lock
 * (refresh_token do ML é single-use — 2 refreshes paralelos matam a
 * conexão).
 *
 * Opts:
 *   - forceRefresh: ignora buffer + força refresh imediato (usar só em
 *     401 retry).
 */
export async function getValidMlToken(
  connectionId: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const conn = await readConn(connectionId);

    if (!conn.refresh_token) {
      throw new Error(
        `Conexão ML ${conn.nickname} sem tokens — execute o fluxo OAuth primeiro`,
      );
    }

    if (!opts.forceRefresh && tokenValid(conn)) {
      return conn.access_token!;
    }

    // Outro processo já está refresh-ando — espera ele terminar
    if (
      conn.refreshing_at &&
      new Date(conn.refreshing_at).getTime() >
        Date.now() - REFRESH_LEASE_TTL_MS
    ) {
      try {
        return await waitForOtherRefresh(connectionId);
      } catch (e) {
        if (e instanceof Error && e.message === "__retry_claim__") continue;
        throw e;
      }
    }

    // Tenta reivindicar o lease
    const claimed = await claimRefreshLease(connectionId);
    if (!claimed) {
      // Outro processo nos ultrapassou no claim — vai pro poll
      continue;
    }

    // Double-check: outro processo pode ter completado o refresh entre o
    // read inicial e o claim (rare race window)
    if (!opts.forceRefresh && tokenValid(claimed)) {
      await clearLease(claimed.id);
      return claimed.access_token!;
    }

    return await performRefresh(claimed);
  }
  throw new Error(
    `Não foi possível obter token ML pra conexão ${connectionId} após 3 tentativas`,
  );
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
  return `${proto}://${host}/api/wms/ml/oauth/callback`;
}
