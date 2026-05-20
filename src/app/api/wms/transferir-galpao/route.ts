import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { transferirInterGalpao } from "@/lib/wms/movimentacoes";

/**
 * POST /api/wms/transferir-galpao
 *
 * 3D body shape:
 *   - galpao_origem_id (required)
 *   - localizacao_origem_id (required)
 *   - galpao_destino_id (required)
 *   - localizacao_destino_id (required)
 *   - itens: [{ produto_id, qty }]  (required)
 *   - observacoes (optional)
 *   - origem_id (optional uuid p/ correlacionar c/ header)
 *
 * Par S+E NEUTRO — em 3D a transferência inter-galpão não carrega dona.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (
    !body.galpao_origem_id ||
    !body.localizacao_origem_id ||
    !body.galpao_destino_id ||
    !body.localizacao_destino_id ||
    !Array.isArray(body.itens) ||
    body.itens.length === 0
  ) {
    return NextResponse.json(
      {
        error:
          "galpao_origem_id, localizacao_origem_id, galpao_destino_id, localizacao_destino_id e itens[] são obrigatórios",
      },
      { status: 400 },
    );
  }
  try {
    const r = await transferirInterGalpao({
      galpao_origem_id: body.galpao_origem_id,
      localizacao_origem_id: body.localizacao_origem_id,
      galpao_destino_id: body.galpao_destino_id,
      localizacao_destino_id: body.localizacao_destino_id,
      itens: body.itens,
      observacoes: body.observacoes,
      origem_id: body.origem_id,
      usuario_id: auth.user.id,
    });
    return NextResponse.json(r);
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.transferir-galpao",
      error: e,
      status: 400,
      requestPath: "/api/wms/transferir-galpao",
      requestMethod: "POST",
    });
  }
}
