import { NextResponse } from "next/server";
import { pollTinyFutura } from "@/lib/tiny-polling-futura";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

// Varredura de abertos + N lookups ML por empresa pode passar do timeout default.
export const maxDuration = 300;

/**
 * GET /api/wms/tiny/polling-futura
 *
 * Descobre vendas ML com etiqueta segurada (shipment.substatus=buffered) presas
 * em situacao "aberto" no Tiny e as carrega na pista de separação futura
 * (reserva + separa + compra, SEM gerar NF). Ver src/lib/tiny-polling-futura.ts.
 *
 * Auth: WORKER_SECRET (cron pg_cron ~30min) OU admin (sistema.usuarios).
 * Cadência separada do poll normal porque é ML-heavy (rate-limited).
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
    const result = await pollTinyFutura();
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
