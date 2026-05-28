import { NextResponse } from "next/server";
import { reconciliarTinyEntradas } from "@/lib/wms/reconciliacao-tiny";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/wms/reconciliacao-tiny
 *
 * Compara saldo WMS (agregado por produto×empresa, somando todos galpões)
 * com saldo Tiny. Divergências > threshold (default 1 unidade) entram no
 * resultado.
 *
 * Auth: WORKER_SECRET (cron) OU admin/insights.ver.
 *
 * Query params:
 *   - empresa_id (opcional)
 *   - limit (default 100)
 *   - threshold (default 1)
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret =
    request.headers.get("X-Worker-Secret") ?? url.searchParams.get("secret");
  const isCron = secret && secret === process.env.WORKER_SECRET;

  if (!isCron) {
    const session = await getSessionUser(request);
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!userCan(session, "insights.ver")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const empresa_id = url.searchParams.get("empresa_id") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const threshold = Number(url.searchParams.get("threshold") ?? 1);

  try {
    const result = await reconciliarTinyEntradas({ empresa_id, limit, threshold });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
