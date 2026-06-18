import { NextResponse } from "next/server";
import { sincronizarProdutosRecentes } from "@/lib/wms/sync-produtos-tiny";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

// Caso o Tiny ignore a hora do filtro e devolva o dia inteiro, a varredura
// pode passar do timeout default.
export const maxDuration = 300;

/**
 * GET /api/wms/tiny/sync-produtos
 *
 * Sync incremental do catálogo: varre todas as contas Tiny conectadas e
 * sincroniza pro siso_produtos os produtos criados OU alterados nos últimos
 * ~2 min (cria os novos, atualiza os existentes). Mantém a base espelhada
 * com o Tiny. Estoque não é tocado (WMS é a fonte única).
 *
 * Auth: WORKER_SECRET (cron pg_cron a cada 1 min) OU admin (sistema.usuarios).
 * Param opcional `?lookbackMin=N` (1..60) pra um catch-up manual mais largo.
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

  const lookbackParam = url.searchParams.get("lookbackMin");
  const lookbackMin = lookbackParam
    ? Math.max(1, Math.min(60, Number(lookbackParam) || 0))
    : undefined;

  try {
    const result = await sincronizarProdutosRecentes(
      lookbackMin ? { lookbackMin } : {},
    );
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
