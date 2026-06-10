import { NextResponse } from "next/server";
import { pollTiny } from "@/lib/tiny-polling";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

// Varredura de 7 dias × N empresas pode passar do timeout default
export const maxDuration = 300;

/**
 * GET /api/wms/tiny/polling
 *
 * Fallback de polling pro webhook Tiny: varre todas as contas conectadas
 * e reprocessa pedidos aprovados/cancelados e NFs autorizadas que escaparam
 * do webhook (janela de 7 dias pra trás).
 *
 * Auth: WORKER_SECRET (cron pg_cron a cada 10min) OU admin (sistema.usuarios).
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
    if (!userCan(session, "sistema.usuarios")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  try {
    const result = await pollTiny();
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
