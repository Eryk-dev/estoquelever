/**
 * One-time script: insere marcador "LVR" no Tiny em todos os pedidos com
 * status = 'pendente' (aguardando decisão do SISO) e atualiza a coluna
 * marcadores no DB.
 *
 * Usage: npx tsx scripts/backfill-lvr.ts [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  for (const candidate of [".env.local", ".env"]) {
    try {
      const envPath = resolve(__dirname, "..", candidate);
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    } catch {
      // try next candidate
    }
  }
}

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TINY_BASE = "https://api.tiny.com.br/public-api/v3";
const TINY_AUTH_BASE = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect";

const DRY_RUN = process.argv.includes("--dry-run");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCache>();

async function getToken(empresaId: string): Promise<string> {
  const cached = tokenCache.get(empresaId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select("id, access_token, refresh_token, token_expires_at, client_id, client_secret")
    .eq("empresa_id", empresaId)
    .eq("ativo", true)
    .single();

  if (!conn) throw new Error(`No connection for empresa ${empresaId}`);

  const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 60_000) {
    tokenCache.set(empresaId, { token: conn.access_token, expiresAt });
    return conn.access_token;
  }

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

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newExpiresAt = Date.now() + tokens.expires_in * 1000;

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

async function postMarcador(token: string, pedidoId: string, descricao: string): Promise<void> {
  const res = await fetch(`${TINY_BASE}/pedidos/${pedidoId}/marcadores`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ descricao }]),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
    console.log(`  ⏳ Rate limited, waiting ${waitMs}ms...`);
    await sleep(waitMs);
    return postMarcador(token, pedidoId, descricao);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }
}

async function main() {
  console.log(`\n🏷️  Backfill LVR ${DRY_RUN ? "(DRY RUN)" : ""}\n`);

  const { data: pedidos, error } = await supabase
    .from("siso_pedidos")
    .select("id, numero, marcadores, empresa_origem_id, nome_ecommerce, criado_em")
    .eq("status", "pendente")
    .not("empresa_origem_id", "is", null)
    .order("criado_em", { ascending: true });

  if (error) {
    console.error("Query error:", error.message);
    process.exit(1);
  }

  if (!pedidos || pedidos.length === 0) {
    console.log("Nenhum pedido pendente.");
    return;
  }

  console.log(`Total: ${pedidos.length} pedidos pendentes\n`);

  let ok = 0;
  let idempotent = 0;
  let errors = 0;

  for (const p of pedidos) {
    const atuais: string[] = p.marcadores ?? [];
    const jaTemLvr = atuais.includes("LVR");
    const prefix = `[${p.id}] nº${p.numero}`;

    if (DRY_RUN) {
      console.log(`${prefix} — marcadores atuais: [${atuais.join(", ")}] ${jaTemLvr ? "(já LVR)" : ""}`);
      continue;
    }

    try {
      const token = await getToken(p.empresa_origem_id!);
      try {
        await postMarcador(token, p.id, "LVR");
        console.log(`${prefix} ✅ LVR enviado ao Tiny`);
        ok++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("400")) {
          console.log(`${prefix} ⊘ LVR já existia no Tiny (idempotente)`);
          idempotent++;
        } else {
          throw err;
        }
      }

      if (!jaTemLvr) {
        await supabase
          .from("siso_pedidos")
          .update({ marcadores: [...atuais, "LVR"] })
          .eq("id", p.id);
      }
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${prefix} ❌ ${msg}`);
    }

    await sleep(1500);
  }

  console.log(`\n✨ Fim: ${ok} ok · ${idempotent} idempotente · ${errors} erro · ${pedidos.length} total\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
