import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { reverterReplenishment } from "@/lib/wms/movimentacoes";

/**
 * POST /api/wms/replenishment/[id]/reverter
 *
 * **Importante:** `[id]` aqui é o `origem_id` (uuid) compartilhado pelas movs
 * S+E de UMA operação de replenishment intra-galpão — NÃO é um id de header
 * (replenishment não tem header próprio). O caller normalmente captura o
 * `origem_id` na resposta de `POST /api/wms/replenishment`.
 *
 * Body: { motivo: string }
 *
 * Estorna ambas as legs (S origem + E destino) do par e devolve `movsEstornadas`.
 * Idempotente — chamadas repetidas pulam movs já estornadas.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 3) {
    return NextResponse.json(
      { error: "motivo (≥3 chars) é obrigatório" },
      { status: 400 },
    );
  }
  try {
    const r = await reverterReplenishment({
      origem_id: id,
      usuario_id: auth.user.id,
      motivo,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient = msg.includes("nenhuma mov") || msg.includes("motivo");
    return wmsErrorResponse({
      source: "wms.replenishment.reverter",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/replenishment/${id}/reverter`,
      requestMethod: "POST",
      metadata: { origem_id: id },
    });
  }
}
