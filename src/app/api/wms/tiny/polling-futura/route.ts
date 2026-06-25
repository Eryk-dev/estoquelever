import { NextResponse } from "next/server";
import {
  pollTinyFutura,
  promoverFuturasLiberadas,
} from "@/lib/tiny-polling-futura";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";

// Varredura de abertos + N lookups ML por empresa pode passar do timeout default.
export const maxDuration = 300;

/**
 * GET /api/wms/tiny/polling-futura
 *
 * Duas fases (ver src/lib/tiny-polling-futura.ts):
 *  1. INTAKE — descobre vendas ML buffered presas em "aberto" no Tiny e as
 *     carrega na pista futura (reserva + separa + compra, SEM gerar NF).
 *  2. PROMOÇÃO — re-checa o substatus das futura já carregadas e promove as que
 *     a etiqueta liberou (não depende do webhook do Tiny disparar no flip).
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
    // 1. Intake: carrega buffered novos na pista futura.
    const intake = await pollTinyFutura();
    // 2. Promoção: re-checa o substatus das futura já carregadas e promove as
    //    que a etiqueta liberou (não depende mais do webhook do Tiny disparar).
    //    Isolado do intake — uma falha aqui não invalida a carga acima.
    let promocao: Awaited<ReturnType<typeof promoverFuturasLiberadas>> | { error: string };
    try {
      promocao = await promoverFuturasLiberadas();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("polling-futura", "promoção de futuras falhou (intake ok)", { error: msg });
      promocao = { error: msg };
    }
    return NextResponse.json({ intake, promocao });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
