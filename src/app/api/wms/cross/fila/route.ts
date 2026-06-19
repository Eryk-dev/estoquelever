import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase-server";
import { listarFila } from "@/lib/cross/equivalencias";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/** GET /api/wms/cross/fila → palpites aguardando validação. */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  // Ver a fila exige a permissão de decisão (quem cura).
  if (!userCan(session, "vendas.aprovar_troca")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  try {
    const itens = await listarFila(createServiceClient());
    return NextResponse.json({ itens });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.fila", error, message: "erro listando fila" });
  }
}
