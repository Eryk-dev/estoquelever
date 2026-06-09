import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCanAny } from "@/lib/permissions";
import { logger } from "@/lib/logger";
import { receberItensViaOC } from "@/lib/wms/receber-oc";

interface PostBody {
  itens: Array<{
    item_id: string;
    qty_real: number;
    custo_unitario?: number;
    motivo_divergencia?: string;
  }>;
}

/**
 * GET /api/wms/receber/oc/[id]
 *
 * Retorna detalhe da OC + itens com qty esperada/recebida/pendente,
 * pra pré-preencher o form de recebimento.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!userCanAny(session, "operacoes.receber", "compras.executar")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const supabase = createServiceClient();

  const { data: oc } = await supabase
    .from("siso_ordens_compra")
    .select(
      "id, fornecedor, galpao_id, status, observacao, siso_galpoes(nome)",
    )
    .eq("id", id)
    .single();
  if (!oc) {
    return NextResponse.json({ error: "OC não encontrada" }, { status: 404 });
  }

  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, imagem_url, compra_quantidade_solicitada, compra_quantidade_recebida, produto_id",
    )
    .eq("ordem_compra_id", id);

  const itensFmt = (itens ?? []).map((it) => ({
    id: String(it.id),
    sku: it.sku,
    descricao: it.descricao,
    imagem_url: it.imagem_url,
    esperado: Number(it.compra_quantidade_solicitada ?? 0),
    ja_recebido: Number(it.compra_quantidade_recebida ?? 0),
    pendente:
      Number(it.compra_quantidade_solicitada ?? 0) -
      Number(it.compra_quantidade_recebida ?? 0),
    produto_id: it.produto_id,
  }));

  return NextResponse.json({
    oc: {
      id: oc.id,
      fornecedor: oc.fornecedor,
      galpao_id: oc.galpao_id,
      galpao_nome:
        (oc.siso_galpoes as { nome?: string } | null)?.nome ?? null,
      status: oc.status,
      observacao: oc.observacao,
    },
    itens: itensFmt,
  });
}

/**
 * POST /api/wms/receber/oc/[id]
 *
 * Body: { itens: [{ item_id, qty_real, custo_unitario?, motivo_divergencia? }] }
 *
 * Gera mov E em RECEBIMENTO + cria pendência de guarda + atualiza
 * compra_quantidade_recebida + fecha OC se completa.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!userCanAny(session, "operacoes.receber", "compras.executar")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  if (!body.itens || !Array.isArray(body.itens) || body.itens.length === 0) {
    return NextResponse.json(
      { error: "itens obrigatório" },
      { status: 400 },
    );
  }

  try {
    const result = await receberItensViaOC({
      ocId: id,
      itens: body.itens,
      operadorId: session.id,
      operadorNome: session.nome ?? "—",
    });
    return NextResponse.json(result);
  } catch (err) {
    logger.logError({
      error: err,
      source: "receber-oc",
      message: "erro inesperado em receber via OC",
      category: "business_logic",
      requestPath: `/api/wms/receber/oc/${id}`,
      requestMethod: "POST",
    });
    const msg = err instanceof Error ? err.message : "erro";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
