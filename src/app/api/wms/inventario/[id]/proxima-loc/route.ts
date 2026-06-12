import { NextRequest, NextResponse } from "next/server";
import { pegarProximaLoc } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// POST /api/wms/inventario/[id]/proxima-loc
// Operador (auth.user) puxa a próxima localização disponível.
// Retorna { pool_vazio: true } quando não há mais locs.
//
// [INV-05] ?retomar=1: só retoma a loc já em contagem deste operador
// (refresh do app) — se não houver, retorna { sem_loc_ativa: true } SEM
// claimar a próxima. Retomada inclui `bipes` (contagens prévias) pra
// reidratar a UI.
//
// Algoritmo interno (RPC wms_inventario_proxima_loc):
//   0. Loc já em contagem por este operador (retomada)
//   1. Mesma zona da última loc deste operador (continuidade)
//   2. Zona NÃO ocupada por outros operadores (anti-colisão)
//   3. Ordem alfabética do código (fallback)
//
// Em modo aberto, retorna lista de SKUs esperados na loc.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const somenteRetomar = req.nextUrl.searchParams.get("retomar") === "1";
    const result = await pegarProximaLoc(id, auth.user.id, { somenteRetomar });
    return NextResponse.json(result);
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.proxima_loc",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/proxima-loc`,
      requestMethod: "POST",
      metadata: { sessao_id: id, usuario_id: auth.user.id },
    });
  }
}
