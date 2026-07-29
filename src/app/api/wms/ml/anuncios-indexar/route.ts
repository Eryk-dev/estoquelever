import { NextResponse } from "next/server";
import { processarFatiaIndiceMl } from "@/lib/ml-anuncios-index";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

export const maxDuration = 300;

/**
 * Processa no máximo uma página por conta ativa. O pg_cron chama esta rota a
 * cada minuto; checkpoints no banco permitem retomar sem fazer um scan global
 * dentro da requisição do relatório.
 */
export async function GET(request: Request) {
  const secret = request.headers.get("X-Worker-Secret");
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
    return NextResponse.json(await processarFatiaIndiceMl());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
