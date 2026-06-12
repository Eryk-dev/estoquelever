import { NextRequest, NextResponse } from "next/server";
import { processQueue, kickWorker } from "@/lib/execution-worker";
import { logger } from "@/lib/logger";

// Janela de drain do kick disparado pelo cron (GET abaixo). Sem isso a função
// morre no default da plataforma e a fila só anda em fatias minúsculas.
export const maxDuration = 300;

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
 * - limit: max jobs to process (default 5). Use limit=0 to drain the entire queue.
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

  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam === null ? 5 : Number(limitParam);

  try {
    // limit=0 → drain entire queue via singleton loop
    if (limit === 0) {
      kickWorker().catch((err) => {
        logger.error("worker-api", "kickWorker failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return NextResponse.json({ status: "draining" });
    }

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

/**
 * GET — alvo do Vercel Cron (crons só fazem GET). Kicka o drain loop e
 * retorna imediatamente; o drain roda em background até maxDuration.
 *
 * Auth: aceita Bearer CRON_SECRET/WORKER_SECRET OU user-agent do Vercel Cron
 * (`vercel-cron/`). O bypass por user-agent é aceitável porque o kick é
 * inofensivo: não recebe input, só processa jobs já enfileirados (idempotente).
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.WORKER_SECRET;
  const auth = request.headers.get("authorization");
  const isVercelCron = request.headers
    .get("user-agent")
    ?.startsWith("vercel-cron/");

  if (secret && auth !== `Bearer ${secret}` && !isVercelCron) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  kickWorker().catch((err) => {
    logger.error("worker-api", "kickWorker (cron) failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return NextResponse.json({ status: "kicked" });
}
