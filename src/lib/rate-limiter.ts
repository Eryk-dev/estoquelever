/**
 * Rate limiter for Tiny API calls.
 *
 * Tracks API calls per empresa (Tiny account) in Supabase `siso_api_calls` table.
 * Both the webhook processor and the execution worker share this tracker,
 * ensuring we never exceed 60 req/min per Tiny account.
 *
 * Budget: 55 calls/min (5 buffer under the 60 limit).
 */

import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";

const MAX_CALLS_PER_MINUTE = 55;

export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  /** How many ms to wait before retrying (0 if allowed) */
  waitMs: number;
}

/**
 * Check how many calls remain in the current 60s window for an empresa.
 */
export async function checkRateLimit(
  empresaId: string,
): Promise<RateLimitStatus> {
  const supabase = createServiceClient();
  const windowStart = new Date(Date.now() - 60_000).toISOString();

  const { count } = await supabase
    .from("siso_api_calls")
    .select("*", { count: "exact", head: true })
    .eq("empresa_id", empresaId)
    .gte("called_at", windowStart);

  const used = count ?? 0;
  const remaining = MAX_CALLS_PER_MINUTE - used;

  if (remaining <= 0) {
    // Find the oldest call in the window to estimate when a slot opens
    const { data } = await supabase
      .from("siso_api_calls")
      .select("called_at")
      .eq("empresa_id", empresaId)
      .gte("called_at", windowStart)
      .order("called_at", { ascending: true })
      .limit(1);

    const oldestCall = data?.[0]?.called_at;
    const waitMs = oldestCall
      ? Math.max(0, new Date(oldestCall).getTime() + 60_000 - Date.now()) + 1000
      : 5000;

    return { allowed: false, remaining: 0, waitMs };
  }

  return { allowed: true, remaining, waitMs: 0 };
}

/**
 * Register an API call for rate limit tracking.
 * Call this BEFORE each Tiny API request.
 */
export async function registerApiCall(
  empresaId: string,
  endpoint: string,
): Promise<void> {
  const supabase = createServiceClient();

  await supabase.from("siso_api_calls").insert({ empresa_id: empresaId, endpoint });

  // Cleanup entries older than 5 min (fire-and-forget)
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  supabase
    .from("siso_api_calls")
    .delete()
    .lt("called_at", cutoff)
    .then(({ error }) => {
      if (error) {
        console.error("Rate limiter cleanup failed:", error.message);
      }
    });
}

/**
 * Block until a call is allowed for the given empresa.
 * Throws after 2 minutes of waiting.
 */
export async function waitForRateLimit(
  empresaId: string,
): Promise<void> {
  const maxWait = 120_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const status = await checkRateLimit(empresaId);
    if (status.allowed) return;

    logger.info("rate-limiter", `Rate limited for empresa ${empresaId}, waiting ${status.waitMs}ms`, {
      empresaId,
      waitMs: status.waitMs,
    });
    await new Promise((r) => setTimeout(r, Math.min(status.waitMs, 5000)));
  }

  throw new Error(`Rate limit wait timeout for empresa ${empresaId} (waited ${maxWait}ms)`);
}
