/**
 * One-time script to find and link nota_fiscal_id for orders stuck in aguardando_nf.
 *
 * For each order without nota_fiscal_id, queries Tiny API GET /notas?idVenda={id}&tipo=S
 * to find the associated NF, then updates the DB and transitions to aguardando_separacao.
 *
 * Usage: npx tsx scripts/vincular-nf.ts [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Load .env.local ───────────────────────────────────────────────────────

function loadEnv() {
  const envPath = resolve(__dirname, "../.env");
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TINY_BASE = "https://api.tiny.com.br/public-api/v3";
const TINY_AUTH_BASE = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect";

const DRY_RUN = process.argv.includes("--dry-run");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Tiny token management ─────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCache>();

async function getToken(empresaId: string): Promise<string> {
  const cached = tokenCache.get(empresaId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select("id, access_token, refresh_token, token_expires_at, client_id, client_secret")
    .eq("empresa_id", empresaId)
    .eq("ativo", true)
    .single();

  if (!conn) throw new Error(`No connection for empresa ${empresaId}`);

  const expiresAt = conn.token_expires_at
    ? new Date(conn.token_expires_at).getTime()
    : 0;

  if (expiresAt > Date.now() + 60_000) {
    tokenCache.set(empresaId, { token: conn.access_token, expiresAt });
    return conn.access_token;
  }

  // Refresh token
  console.log(`  🔄 Refreshing token for empresa ${empresaId}...`);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: conn.refresh_token,
    client_id: conn.client_id,
    client_secret: conn.client_secret,
  });

  const res = await fetch(`${TINY_AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed for ${empresaId}: ${res.status} ${text}`);
  }

  const tokens = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newExpiresAt = Date.now() + tokens.expires_in * 1000;

  // Save refreshed tokens
  await supabase
    .from("siso_tiny_connections")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: new Date(newExpiresAt).toISOString(),
    })
    .eq("id", conn.id);

  tokenCache.set(empresaId, { token: tokens.access_token, expiresAt: newExpiresAt });
  return tokens.access_token;
}

// ─── Tiny API call ──────────────────────────────────────────────────────────

async function tinyFetch<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${TINY_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
    console.log(`  ⏳ Rate limited, waiting ${waitMs}ms...`);
    await sleep(waitMs);
    return tinyFetch<T>(token, path);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tiny ${path} → ${res.status}: ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) as T : (undefined as unknown as T);
}

interface TinyNfListItem {
  id: number;
  numero?: string | null;
  serie?: string | null;
  chaveAcesso?: string | null;
  situacao?: number | null;
  tipo?: string | null;
  origem?: {
    id?: string | null;
    tipo?: string | null;
  };
}

interface TinyNfListResponse {
  itens: TinyNfListItem[];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Vincular NF — ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`${"=".repeat(60)}\n`);

  // 1. Get all orders without nota_fiscal_id
  const { data: orders, error } = await supabase
    .from("siso_pedidos")
    .select("id, numero, status_separacao, empresa_origem_id")
    .in("status_separacao", ["aguardando_nf", "aguardando_separacao", "em_separacao", "separado"])
    .is("nota_fiscal_id", null)
    .order("criado_em", { ascending: false });

  if (error) {
    console.error("Failed to fetch orders:", error.message);
    process.exit(1);
  }

  console.log(`Found ${orders.length} orders without nota_fiscal_id\n`);

  if (orders.length === 0) {
    console.log("Nothing to do!");
    return;
  }

  // 2. Group by empresa
  const byEmpresa = new Map<string, typeof orders>();
  for (const o of orders) {
    const list = byEmpresa.get(o.empresa_origem_id) ?? [];
    list.push(o);
    byEmpresa.set(o.empresa_origem_id, list);
  }

  // Get empresa names
  const { data: empresas } = await supabase
    .from("siso_empresas")
    .select("id, nome")
    .in("id", [...byEmpresa.keys()]);

  const empresaNames = new Map<string, string>();
  for (const e of empresas ?? []) {
    empresaNames.set(e.id, e.nome);
  }

  let totalLinked = 0;
  let totalNotFound = 0;
  let totalErrors = 0;

  // 3. Process each empresa
  for (const [empresaId, empresaOrders] of byEmpresa) {
    const name = empresaNames.get(empresaId) ?? empresaId;
    console.log(`\n── ${name} (${empresaOrders.length} orders) ──`);

    let token: string;
    try {
      token = await getToken(empresaId);
    } catch (err) {
      console.error(`  ❌ Failed to get token: ${err instanceof Error ? err.message : err}`);
      totalErrors += empresaOrders.length;
      continue;
    }

    for (const order of empresaOrders) {
      try {
        // Query Tiny for NFs linked to this order (venda)
        const result = await tinyFetch<TinyNfListResponse>(
          token,
          `/notas?idVenda=${order.id}&tipo=S&limit=10`,
        );

        const nfs = (result.itens ?? []).filter(
          (nf) =>
            nf.origem?.tipo === "venda" &&
            // Situacao 6=Autorizada, 2=Emitida, 7=Emitida Danfe
            [2, 6, 7].includes(nf.situacao ?? 0),
        );

        if (nfs.length === 0) {
          console.log(`  ${order.numero} (${order.id}): no NF found`);
          totalNotFound++;
          await sleep(200); // gentle rate limit
          continue;
        }

        const nf = nfs[0]; // Take the first valid NF
        console.log(
          `  ${order.numero} (${order.id}): NF ${nf.id} (num=${nf.numero}, sit=${nf.situacao})` +
            (DRY_RUN ? " [DRY RUN]" : ""),
        );

        if (!DRY_RUN) {
          // Update nota_fiscal_id + chave_acesso_nf
          const updateData: Record<string, unknown> = {
            nota_fiscal_id: String(nf.id),
          };
          if (nf.chaveAcesso) {
            updateData.chave_acesso_nf = nf.chaveAcesso;
          }

          // If in aguardando_nf, also transition to aguardando_separacao
          if (order.status_separacao === "aguardando_nf") {
            updateData.status_separacao = "aguardando_separacao";
          }

          await supabase
            .from("siso_pedidos")
            .update(updateData)
            .eq("id", order.id);
        }

        totalLinked++;
        await sleep(300); // gentle rate limit
      } catch (err) {
        console.error(
          `  ❌ ${order.numero} (${order.id}): ${err instanceof Error ? err.message : err}`,
        );
        totalErrors++;
        await sleep(500);
      }
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Results: ${totalLinked} linked, ${totalNotFound} not found, ${totalErrors} errors`);
  console.log(`${"=".repeat(60)}\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
