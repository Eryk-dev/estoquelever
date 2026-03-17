/**
 * In-memory request queue for Tiny API calls.
 *
 * Enforces per-empresa rate limiting (55 req/60s sliding window)
 * and concurrency control (max 5 concurrent requests per empresa).
 *
 * Uses AsyncLocalStorage to automatically detect which empresa
 * a tinyFetch call belongs to — callers just wrap their code in
 * runWithEmpresa(empresaId, async () => { ... }).
 *
 * All tinyFetch calls within that scope are individually queued
 * and rate-limited, even when fired in parallel (e.g. Promise.all).
 *
 * Replaces the Supabase-based rate-limiter.ts for rate control.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger";

const LOG_SOURCE = "tiny-queue";

// ── Configuration ────────────────────────────────────────────────────────────

/** Max requests per empresa per 60s window (Tiny limit is 60, we keep 5 buffer) */
const MAX_PER_MINUTE = 55;
const WINDOW_MS = 60_000;

/** Max concurrent in-flight requests per empresa */
const MAX_CONCURRENT = 5;

/** Max time a request can wait in queue before being rejected */
const MAX_QUEUE_WAIT_MS = 120_000;

// ── AsyncLocalStorage Context ────────────────────────────────────────────────

const empresaContext = new AsyncLocalStorage<string>();

/**
 * Run a function with Tiny API rate limiting for the given empresa.
 * All tinyFetch calls within the async scope will be queued and
 * rate-limited for this empresa.
 *
 * Can be nested — inner calls with a different empresaId will use
 * the innermost context.
 *
 * @example
 * await runWithEmpresa(empresaId, async () => {
 *   const pedido = await getPedido(token, id);      // queued
 *   const stock = await getEstoque(token, prodId);   // queued
 * });
 */
export function runWithEmpresa<T>(
  empresaId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return empresaContext.run(empresaId, fn);
}

/**
 * Get the current empresa ID from the async context.
 * Returns undefined if not within a runWithEmpresa scope.
 */
export function getContextEmpresaId(): string | undefined {
  return empresaContext.getStore();
}

// ── Queue Implementation ─────────────────────────────────────────────────────

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

class EmpresaRequestQueue {
  private queue: QueueItem[] = [];
  private active = 0;
  private timestamps: number[] = [];
  private scheduledDrain: ReturnType<typeof setTimeout> | null = null;

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      });
      this.drain();
    });
  }

  private drain(): void {
    // Expire timed-out items
    const now = Date.now();
    while (
      this.queue.length > 0 &&
      now - this.queue[0].enqueuedAt > MAX_QUEUE_WAIT_MS
    ) {
      const item = this.queue.shift()!;
      item.reject(
        new Error(
          `Tiny API queue timeout (waited ${Math.round((now - item.enqueuedAt) / 1000)}s)`,
        ),
      );
    }

    // Clean old timestamps from sliding window
    const windowStart = Date.now() - WINDOW_MS;
    this.timestamps = this.timestamps.filter((t) => t > windowStart);

    // Process items from queue
    while (this.queue.length > 0 && this.active < MAX_CONCURRENT) {
      // Check rate limit
      if (this.timestamps.length >= MAX_PER_MINUTE) {
        const oldestTs = this.timestamps[0];
        const waitMs = Math.max(100, oldestTs + WINDOW_MS - Date.now() + 100);
        this.scheduleDrain(Math.min(waitMs, 5000));
        return;
      }

      const item = this.queue.shift()!;
      this.active++;
      this.timestamps.push(Date.now());

      // Fire and forget — completion triggers re-drain
      item
        .fn()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }

    // If queue still has items but we're at max concurrency,
    // they'll be picked up when an active request completes (via finally→drain)
  }

  private scheduleDrain(ms: number): void {
    if (this.scheduledDrain) return;
    this.scheduledDrain = setTimeout(() => {
      this.scheduledDrain = null;
      this.drain();
    }, ms);
  }

  get stats() {
    return {
      queued: this.queue.length,
      active: this.active,
      windowUsed: this.timestamps.filter((t) => Date.now() - t < WINDOW_MS)
        .length,
    };
  }
}

class TinyRequestQueue {
  private queues = new Map<string, EmpresaRequestQueue>();

  private getQueue(empresaId: string): EmpresaRequestQueue {
    let queue = this.queues.get(empresaId);
    if (!queue) {
      queue = new EmpresaRequestQueue();
      this.queues.set(empresaId, queue);
    }
    return queue;
  }

  /**
   * Execute a function through the rate-limited queue for an empresa.
   * Called automatically by tinyFetch when AsyncLocalStorage context is set.
   */
  execute<T>(empresaId: string, fn: () => Promise<T>): Promise<T> {
    return this.getQueue(empresaId).enqueue(fn);
  }

  /**
   * Get stats for all empresas (for monitoring endpoint).
   */
  getStats(): Record<
    string,
    { queued: number; active: number; windowUsed: number }
  > {
    const stats: Record<
      string,
      { queued: number; active: number; windowUsed: number }
    > = {};
    for (const [id, queue] of this.queues) {
      const s = queue.stats;
      // Only include empresas with activity
      if (s.queued > 0 || s.active > 0 || s.windowUsed > 0) {
        stats[id] = s;
      }
    }
    return stats;
  }
}

/** Singleton queue instance (shared across all API routes in the same process) */
export const tinyQueue = new TinyRequestQueue();
