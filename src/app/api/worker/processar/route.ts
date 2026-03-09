import { NextRequest, NextResponse } from "next/server";
import { processQueue } from "@/lib/execution-worker";
import { logger } from "@/lib/logger";

/**
 * POST /api/worker/processar
 *
 * Triggers the execution worker to process pending jobs.
 * Call this from:
 * - A cron job (e.g., every 10s via Easypanel/external cron)
 * - The approval endpoint (immediate kick)
 * - The monitoring page (manual trigger)
 *
 * Optional auth via WORKER_SECRET env var for external cron calls.
 *
 * Query params:
 * - limit: max jobs to process (default 5)
 */
export async function POST(request: NextRequest) {
  // Optional auth for cron calls
  const secret = process.env.WORKER_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "5");

  try {
    const result = await processQueue(Math.min(limit, 20));

    logger.info("worker-api", "Queue processed", {
      processed: result.processed,
      errors: result.errors,
      rateLimited: result.rateLimited,
    });

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("worker-api", "Queue processing failed", { error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** GET for health check */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "SISO Execution Worker",
    usage: "POST to process pending jobs from siso_fila_execucao",
  });
}
