import { randomUUID, timingSafeEqual } from "node:crypto";
import { after, NextResponse } from "next/server";
import { reconcileMlOrders } from "@/lib/ml-reconciliation";
import { logger } from "@/lib/logger";

export const maxDuration = 240;

export async function GET(request: Request) {
  const expected = process.env.WORKER_SECRET;
  const received = request.headers.get("x-worker-secret");
  if (!expected || !received || Buffer.byteLength(expected) !== Buffer.byteLength(received) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const runId = randomUUID();
  const options = {
    runId,
    dryRun: url.searchParams.get("dry_run") === "1",
    limitPerLane: Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 60, 100)),
  };
  if (url.searchParams.get("wait") === "1") {
    return NextResponse.json(await reconcileMlOrders(options));
  }
  // The cron HTTP request returns immediately, instead of blocking pg_net's queue.
  after(async () => {
    try { await reconcileMlOrders(options); }
    catch (error) {
      logger.error("ml-reconciliation", "Falha no ciclo automático ML", {
        runId, error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return NextResponse.json({ accepted: true, runId }, { status: 202 });
}
