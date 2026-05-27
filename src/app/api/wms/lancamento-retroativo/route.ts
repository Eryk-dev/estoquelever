import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
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
 *   - data_recebimento (optional, ISO; ≤ now; vai pra origem_detalhes.data_recebimento — #8.7)
 */
export async function POST(req: NextRequest) {
  // Auth + perm granular (finding 8.9)
  const session = await getSessionUser(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.retroativo")) {
    return NextResponse.json({ error: "forbidden — requer operacoes.retroativo" }, { status: 403 });
  }
  const auth = { user: session };

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
  // PR-6 #8.7 — data_recebimento opcional (ISO, ≤ now). Carimbar criado_em
  // da mov com a data real exigiria mudar a RPC `wms_inserir_movimentacao`
  // (out of scope). Por enquanto guardamos em origem_detalhes.data_recebimento
  // pra reports filtrarem via (origem_detalhes->>'data_recebimento').
  const dataRecebimento = body.data_recebimento as string | undefined;
  if (dataRecebimento) {
    const d = new Date(dataRecebimento);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now()) {
      return NextResponse.json(
        { error: "data_recebimento inválida ou no futuro" },
        { status: 400 },
      );
    }
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
      data_recebimento: dataRecebimento,
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
