/**
 * Discord error forwarder.
 *
 * Posts SISO errors (backend + frontend) to a Discord channel via webhook,
 * formatted as a copy-paste-ready block so the message can be dropped straight
 * into Claude to triage/fix.
 *
 * Design:
 * - Webhook only (no bot/gateway). One HTTPS POST per error.
 * - Gated on DISCORD_ERROR_WEBHOOK_URL — absent ⇒ silent no-op (mirrors *_DISABLED).
 * - Fire-and-forget. NEVER throws, NEVER calls logger (would loop), NEVER blocks
 *   the caller. Self-failures are swallowed (one console.warn at most).
 * - Only severity error/critical is forwarded (warnings stay out of the channel).
 * - Dedup + cooldown: an identical error (same source+message) posts once, then
 *   repeats within the window are suppressed and counted. In-memory, per-instance
 *   (serverless cold starts reset it — acceptable; collapses warm bursts, which
 *   is the bad-deploy storm case).
 */

export interface DiscordErrorPayload {
  /** Module/component that produced the error (e.g. 'webhook-processor', 'separacao'). */
  source: string;
  /** Human-readable message. */
  message: string;
  severity?: "warning" | "error" | "critical";
  category?: string | null;
  errorCode?: string | null;
  stack?: string | null;
  pedidoId?: string | null;
  empresaNome?: string | null;
  galpaoNome?: string | null;
  correlationId?: string | null;
  requestPath?: string | null;
  requestMethod?: string | null;
  /** siso_erros row id (so we can find the full row in Supabase). */
  errosId?: string | null;
  /** Where it came from. */
  origin?: "backend" | "frontend";
  /** Operator name (frontend errors). */
  userName?: string | null;
  /** Page URL the operator was on (frontend errors). */
  url?: string | null;
  metadata?: Record<string, unknown>;
}

// ─── Dedup / cooldown ──────────────────────────────────────────────────────────

const COOLDOWN_MS = 10 * 60_000; // 10 min
const MAX_KEYS = 500;

interface DedupEntry {
  count: number;
  windowStart: number;
}

const seen = new Map<string, DedupEntry>();

/**
 * Decide whether to post. First occurrence in a window posts; repeats within the
 * window are suppressed and counted. Returns null when suppressed, or the number
 * of suppressed repeats carried over from the previous (just-expired) window.
 */
function gate(key: string): { repeatedBefore: number } | null {
  const now = Date.now();

  // Lazy prune so the map can't grow unbounded.
  if (seen.size > MAX_KEYS) {
    for (const [k, e] of seen) {
      if (now - e.windowStart > COOLDOWN_MS) seen.delete(k);
    }
  }

  const entry = seen.get(key);
  if (entry && now - entry.windowStart <= COOLDOWN_MS) {
    entry.count += 1;
    return null; // within cooldown → suppress
  }

  // Open a new window. If the (expired) previous window saw repeats, carry the count.
  const repeatedBefore = entry ? Math.max(0, entry.count - 1) : 0;
  seen.set(key, { count: 1, windowStart: now });
  return { repeatedBefore };
}

// ─── Message formatting ──────────────────────────────────────────────────────────

const DISCORD_CONTENT_LIMIT = 2000;
// Leave headroom for the header line + code fences + truncation marker.
const BLOCK_BUDGET = 1750;

function severityEmoji(sev: DiscordErrorPayload["severity"]): string {
  if (sev === "critical") return "🚨";
  return "🔴";
}

/** Build the fenced, copy-ready block (the part the user copies into Claude). */
function buildBlock(p: DiscordErrorPayload): string {
  const lines: string[] = [];
  lines.push(`[SISO erro] ${new Date().toISOString()}`);
  lines.push(`origin: ${p.origin ?? "backend"}`);
  lines.push(`source: ${p.source}`);
  const sev = p.severity ?? "error";
  lines.push(`category: ${p.category ?? "unknown"}  severity: ${sev}`);
  lines.push(`message: ${p.message}`);
  if (p.errorCode) lines.push(`error_code: ${p.errorCode}`);
  if (p.requestPath) lines.push(`path: ${p.requestMethod ?? ""} ${p.requestPath}`.trim());
  if (p.url) lines.push(`url: ${p.url}`);
  if (p.userName) lines.push(`user: ${p.userName}`);
  if (p.pedidoId) lines.push(`pedido: ${p.pedidoId}`);
  if (p.empresaNome) lines.push(`empresa: ${p.empresaNome}`);
  if (p.galpaoNome) lines.push(`galpao: ${p.galpaoNome}`);
  if (p.correlationId) lines.push(`correlation: ${p.correlationId}`);
  if (p.errosId) lines.push(`siso_erros.id: ${p.errosId}`);

  if (p.metadata && Object.keys(p.metadata).length > 0) {
    let meta = "";
    try {
      meta = JSON.stringify(p.metadata);
    } catch {
      meta = "(metadata não serializável)";
    }
    if (meta && meta !== "{}") lines.push(`metadata: ${meta}`);
  }

  let block = lines.join("\n");

  if (p.stack) {
    const remaining = BLOCK_BUDGET - block.length - "\n\nstack:\n".length;
    if (remaining > 80) {
      let stack = p.stack;
      if (stack.length > remaining) {
        stack = stack.slice(0, remaining) + "\n… (stack truncado — ver siso_erros)";
      }
      block += `\n\nstack:\n${stack}`;
    }
  }

  if (block.length > BLOCK_BUDGET) {
    block = block.slice(0, BLOCK_BUDGET) + "\n… (truncado)";
  }
  return block;
}

function buildContent(p: DiscordErrorPayload, repeatedBefore: number): string {
  const sev = p.severity ?? "error";
  const parts = [
    severityEmoji(sev),
    `**${(p.origin ?? "backend").toUpperCase()}**`,
    `\`${p.source}\``,
  ];
  if (p.category) parts.push(`· ${p.category}`);
  if (sev === "critical") parts.push("· **CRITICAL**");
  if (repeatedBefore > 0) parts.push(`· _(+${repeatedBefore} repetições suprimidas antes deste alerta)_`);
  const header = parts.join(" ");

  const content = `${header}\n\`\`\`text\n${buildBlock(p)}\n\`\`\``;
  return content.length > DISCORD_CONTENT_LIMIT
    ? content.slice(0, DISCORD_CONTENT_LIMIT - 4) + "\n```"
    : content;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Forward an error to Discord. Fire-and-forget, never throws.
 *
 * Skips silently when the webhook is unconfigured or severity is 'warning'.
 */
export function forwardErrorToDiscord(p: DiscordErrorPayload): void {
  try {
    const webhookUrl = process.env.DISCORD_ERROR_WEBHOOK_URL;
    if (!webhookUrl) return; // not configured → no-op

    const sev = p.severity ?? "error";
    if (sev === "warning") return; // only error/critical reach the channel

    const key = `${p.source}|${p.message}`.slice(0, 300);
    const decision = gate(key);
    if (!decision) return; // deduped within cooldown

    const content = buildContent(p, decision.repeatedBefore);

    // Fire-and-forget. allowed_mentions empty so an error text can't @ everyone.
    void fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "SISO Erros",
        content,
        allowed_mentions: { parse: [] },
      }),
    }).catch(() => {
      // Network/Discord failure — swallow. Logging here could loop.
    });
  } catch {
    // Absolute last resort — this path must never throw into the caller.
  }
}
