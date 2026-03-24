/**
 * Next.js instrumentation — runs once on server startup.
 *
 * Sets up periodic reconciliation polling (every 20 minutes)
 * to catch orders that fell through the webhook pipeline.
 */

export async function register() {
  // Only run on the server (not during build or on the client)
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
  const LOOKBACK_HOURS = 48;

  // Delay first run by 2 minutes to let the server fully warm up
  const INITIAL_DELAY_MS = 2 * 60 * 1000;

  async function runReconciliacao() {
    try {
      const { reconciliar } = await import("@/lib/reconciliacao");
      await reconciliar({ lookbackHours: LOOKBACK_HOURS, dryRun: false });
    } catch (err) {
      // Import logger lazily to avoid issues during startup
      try {
        const { logger } = await import("@/lib/logger");
        logger.error("instrumentation", "Reconciliação polling failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        console.error("[reconciliacao] Polling failed:", err);
      }
    }
  }

  setTimeout(() => {
    // First run after initial delay
    runReconciliacao();

    // Then every 20 minutes
    setInterval(runReconciliacao, INTERVAL_MS);

    console.log(
      `[reconciliacao] Polling started — every ${INTERVAL_MS / 60_000}min, lookback ${LOOKBACK_HOURS}h`,
    );
  }, INITIAL_DELAY_MS);
}
