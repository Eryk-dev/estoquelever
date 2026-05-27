import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { ajustarEstoque } from "@/lib/wms/movimentacoes";

/**
 * POST /api/wms/ajuste
 *
 * 3D body shape:
 *   - tripla: { produto_id, galpao_id, localizacao_id }  (required)
 *   - qty (required, > 0)
 *   - motivo (required, ≥ 3 chars)
 *   - direcao: 'entrada' | 'saida'  (required)
 *
 * Sem dona — em 3D ajuste mexe direto na posição física.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  const tripla = body.tripla;
  if (
    !tripla ||
    !tripla.produto_id ||
    !tripla.galpao_id ||
    !tripla.localizacao_id
  ) {
    return NextResponse.json(
      {
        error:
          "tripla {produto_id, galpao_id, localizacao_id} é obrigatória",
      },
      { status: 400 },
    );
  }
  const qty = Number(body.qty);
  if (!qty || qty <= 0) {
    return NextResponse.json(
      { error: "qty deve ser > 0" },
      { status: 400 },
    );
  }
  if (body.direcao !== "entrada" && body.direcao !== "saida") {
    return NextResponse.json(
      { error: "direcao deve ser 'entrada' ou 'saida'" },
      { status: 400 },
    );
  }
  const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 3) {
    return NextResponse.json(
      { error: "motivo é obrigatório (≥3 caracteres)" },
      { status: 400 },
    );
  }
  try {
    const r = await ajustarEstoque({
      tripla,
      qty,
      motivo,
      direcao: body.direcao,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true, mov_id: r.mov_id });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.ajuste",
      error: e,
      status: 400,
      requestPath: "/api/wms/ajuste",
      requestMethod: "POST",
    });
  }
}
