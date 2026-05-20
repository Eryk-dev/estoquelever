import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import {
  criarTransferencia,
  listarTransferencias,
  type StatusTransferencia,
} from "@/lib/wms/transferencias";

/**
 * POST /api/wms/transferencias
 *
 * 3D body shape:
 *   - galpao_origem_id (required)
 *   - galpao_destino_id (required)
 *   - itens: [{ produto_id, localizacao_origem_id, qty }]  (required)
 *   - observacoes (optional)
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (
    !body.galpao_origem_id ||
    !body.galpao_destino_id ||
    !Array.isArray(body.itens) ||
    body.itens.length === 0
  ) {
    return NextResponse.json(
      { error: "campos obrigatórios: galpao_origem_id, galpao_destino_id, itens[]" },
      { status: 400 },
    );
  }
  try {
    const r = await criarTransferencia({
      galpao_origem_id: body.galpao_origem_id,
      galpao_destino_id: body.galpao_destino_id,
      itens: body.itens,
      observacoes: body.observacoes,
      usuario_id: auth.user.id,
    });
    return NextResponse.json(r, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.transferencias.criar",
      error: e,
      status: 400,
      requestPath: "/api/wms/transferencias",
      requestMethod: "POST",
      metadata: {
        galpao_origem_id: body.galpao_origem_id,
        galpao_destino_id: body.galpao_destino_id,
        n_itens: Array.isArray(body.itens) ? body.itens.length : 0,
      },
    });
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") as StatusTransferencia | null;
  try {
    const rows = await listarTransferencias({
      status: status ?? undefined,
      galpao_origem_id: sp.get("galpao_origem_id") ?? undefined,
      galpao_destino_id: sp.get("galpao_destino_id") ?? undefined,
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.transferencias.list",
      error: e,
      requestPath: "/api/wms/transferencias",
      requestMethod: "GET",
    });
  }
}
