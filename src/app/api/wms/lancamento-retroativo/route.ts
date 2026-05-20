import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import {
  lancarRetroativo,
  listarRetroativosPendentes,
} from "@/lib/wms/movimentacoes";

/**
 * POST /api/wms/lancamento-retroativo
 *
 * 3D body shape:
 *   - tripla: { produto_id, galpao_id, localizacao_id }  (required)
 *   - qty (required, > 0)
 *   - motivo (required, ≥ 3 chars)
 *   - empresa_compradora_id (optional, tag histórica)
 *   - fornecedor_id (optional, tag histórica)
 *   - custo_unitario (optional, alimenta recálculo custo médio global)
 *   - pedido_id (optional)
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (!body.motivo || body.motivo.length < 3) {
    return NextResponse.json({ error: "motivo obrigatório (≥3 caracteres)" }, { status: 400 });
  }
  const tripla = body.tripla;
  if (
    !tripla ||
    !tripla.produto_id ||
    !tripla.galpao_id ||
    !tripla.localizacao_id
  ) {
    return NextResponse.json(
      { error: "tripla {produto_id, galpao_id, localizacao_id} é obrigatória" },
      { status: 400 },
    );
  }
  const qty = Number(body.qty);
  if (!qty || qty <= 0) {
    return NextResponse.json({ error: "qty deve ser > 0" }, { status: 400 });
  }
  const custoUnitario =
    body.custo_unitario !== undefined && body.custo_unitario !== null
      ? Number(body.custo_unitario)
      : undefined;
  if (custoUnitario !== undefined && (!Number.isFinite(custoUnitario) || custoUnitario < 0)) {
    return NextResponse.json(
      { error: "custo_unitario inválido (≥ 0)" },
      { status: 400 },
    );
  }
  try {
    await lancarRetroativo({
      tripla,
      qty,
      motivo: body.motivo,
      empresa_compradora_id: body.empresa_compradora_id ?? null,
      fornecedor_id: body.fornecedor_id ?? null,
      custo_unitario: custoUnitario,
      pedido_id: body.pedido_id ?? null,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.lancamento-retroativo",
      error: e,
      requestPath: "/api/wms/lancamento-retroativo",
      requestMethod: "POST",
    });
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  try {
    const rows = await listarRetroativosPendentes();
    return NextResponse.json({ rows });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.lancamento-retroativo",
      error: e,
      requestPath: "/api/wms/lancamento-retroativo",
      requestMethod: "GET",
    });
  }
}
