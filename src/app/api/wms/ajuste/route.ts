import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { ajustarEstoque, type MotivoCategoria } from "@/lib/wms/movimentacoes";

const CATEGORIAS_VALIDAS = [
  "avaria",
  "perda",
  "achado",
  "correcao_inventario",
  "devolucao_sem_fluxo",
  "outro",
] as const satisfies readonly MotivoCategoria[];

/**
 * POST /api/wms/ajuste
 *
 * 3D body shape:
 *   - tripla: { produto_id, galpao_id, localizacao_id }  (required)
 *   - qty (required, > 0)
 *   - motivo (required, ≥ 3 chars)
 *   - direcao: 'entrada' | 'saida'  (required)
 *   - localizacoes_saida?: uuid[] (locs que também serão reduzidas no lote)
 *
 * Sem dona — em 3D ajuste mexe direto na posição física. Se uma saída
 * atravessar o reservado, a RPC realoca Rs de pedido antes de baixar o saldo.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  if (!userCan(auth.user, "operacoes.ajuste_manual")) {
    return NextResponse.json(
      { error: "requer permissão operacoes.ajuste_manual" },
      { status: 403 },
    );
  }

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
  const motivoCategoria = body.motivo_categoria;
  if (
    typeof motivoCategoria !== "string" ||
    !(CATEGORIAS_VALIDAS as readonly string[]).includes(motivoCategoria)
  ) {
    return NextResponse.json(
      {
        error: `motivo_categoria é obrigatório e deve ser uma de: ${CATEGORIAS_VALIDAS.join(", ")}`,
      },
      { status: 400 },
    );
  }
  // PR-6 #8.4 — custo_unitario opcional, só faz sentido em entrada.
  const custoUnitario =
    body.custo_unitario !== undefined && body.custo_unitario !== null
      ? Number(body.custo_unitario)
      : undefined;
  if (
    custoUnitario !== undefined &&
    (!Number.isFinite(custoUnitario) || custoUnitario < 0)
  ) {
    return NextResponse.json(
      { error: "custo_unitario inválido (≥ 0)" },
      { status: 400 },
    );
  }
  try {
    const r = await ajustarEstoque({
      tripla,
      qty,
      motivo,
      motivo_categoria: motivoCategoria as MotivoCategoria,
      direcao: body.direcao,
      custo_unitario:
        body.direcao === "entrada" ? custoUnitario : undefined,
      localizacoes_saida: Array.isArray(body.localizacoes_saida)
        ? body.localizacoes_saida.filter(
            (id: unknown): id is string => typeof id === "string",
          )
        : [],
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true, ...r });
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
