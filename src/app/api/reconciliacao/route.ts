import { NextRequest, NextResponse } from "next/server";
import { reconciliar } from "@/lib/reconciliacao";

/**
 * GET /api/reconciliacao
 *
 * Two-pronged reconciliation:
 * 1. Internal: reprocess stuck webhook_logs (status=processando > 5 min)
 * 2. External: query Tiny for approved orders not in siso_pedidos
 *
 * Query params:
 *   ?hours=48    — lookback window (default 48)
 *   ?dryRun=true — only report, don't reprocess
 *
 * Also runs automatically every 20 min via instrumentation.ts polling.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const lookbackHours = parseInt(searchParams.get("hours") ?? "48", 10);
  const dryRun = searchParams.get("dryRun") === "true";

  const results = await reconciliar({ lookbackHours, dryRun });

  return NextResponse.json(results);
}
