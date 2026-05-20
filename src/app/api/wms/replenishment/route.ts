import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { replenishmentIntraGalpao } from "@/lib/wms/movimentacoes";

/**
 * POST /api/wms/replenishment
 *
 * 3D body shape:
 *   - galpao_id (required)
 *   - localizacao_origem_id (required)
 *   - localizacao_destino_id (required)
 *   - itens: [{ produto_id, qty }]  (required)
 *   - observacoes (optional)
 *   - origem_id (optional uuid)
 *
 * Par S+E NEUTRO intra-galpão — em 3D, replenishment não carrega dona.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (
    !body.galpao_id ||
    !body.localizacao_origem_id ||
    !body.localizacao_destino_id ||
    !Array.isArray(body.itens) ||
    body.itens.length === 0
  ) {
    return NextResponse.json(
      {
        error:
          "galpao_id, localizacao_origem_id, localizacao_destino_id e itens[] são obrigatórios",
      },
      { status: 400 },
    );
  }
  try {
    const r = await replenishmentIntraGalpao({
      galpao_id: body.galpao_id,
      localizacao_origem_id: body.localizacao_origem_id,
      localizacao_destino_id: body.localizacao_destino_id,
      itens: body.itens,
      observacoes: body.observacoes,
      origem_id: body.origem_id,
      usuario_id: auth.user.id,
    });
    return NextResponse.json(r);
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.replenishment",
      error: e,
      status: 400,
      requestPath: "/api/wms/replenishment",
      requestMethod: "POST",
    });
  }
}
