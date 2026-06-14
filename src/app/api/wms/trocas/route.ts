import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCanAny } from "@/lib/permissions";
import {
  solicitarTroca,
  TrocaError,
  type TrocaOrigem,
} from "@/lib/wms/trocas-equivalencia";
import { trocaErrorResponse } from "@/lib/wms/trocas-api";

/**
 * GET /api/wms/trocas?status=pendente
 *
 * Fila de trocas de equivalência (modal de aprovação + card da home).
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });

  const status = request.nextUrl.searchParams.get("status") ?? "pendente";
  const pedidoId = request.nextUrl.searchParams.get("pedido_id");

  const sb = createServiceClient();
  let query = sb
    .from("siso_trocas_equivalencia")
    .select(
      `*,
       produto_vendido:siso_produtos!siso_trocas_equivalencia_produto_vendido_id_fkey(sku, descricao, imagem_url, imagens, tier_qualidade),
       produto_substituto:siso_produtos!siso_trocas_equivalencia_produto_substituto_id_fkey(sku, descricao, imagem_url, imagens, tier_qualidade),
       solicitante:siso_usuarios!siso_trocas_equivalencia_solicitado_por_fkey(nome),
       galpao:siso_galpoes(nome)`,
    )
    .order("solicitado_em", { ascending: false })
    .limit(100);
  if (status !== "todas") query = query.eq("status", status);
  if (pedidoId) query = query.eq("pedido_id", pedidoId);

  const { data, error } = await query;
  if (error) {
    logger.error("api.wms.trocas", "falha listando trocas", { error: error.message });
    return NextResponse.json({ error: "Erro ao listar trocas" }, { status: 500 });
  }
  return NextResponse.json({ trocas: data ?? [] });
}

/**
 * POST /api/wms/trocas
 *
 * Solicita troca de peça equivalente pra um item de pedido. Se a regra der
 * 'livre' (mesmo tier + par verificado), aplica na hora (auto=true).
 *
 * Body: { pedido_item_id, sku_substituto, origem: 'separacao'|'compras'|'painel' }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (
    !userCanAny(
      session,
      "separacao.executar",
      "compras.executar",
      "pedidos.aprovar",
      "vendas.aprovar_troca",
    )
  ) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const body = await request.json();
  const pedidoItemId = body.pedido_item_id as number | string | undefined;
  const skuSubstituto = (body.sku_substituto as string | undefined)?.trim();
  const origem = body.origem as TrocaOrigem | undefined;

  if (!pedidoItemId || !skuSubstituto || !origem) {
    return NextResponse.json(
      { error: "Envie { pedido_item_id, sku_substituto, origem }" },
      { status: 400 },
    );
  }
  if (!["separacao", "compras", "painel"].includes(origem)) {
    // 'roteamento' é exclusivo do webhook-processor — não aceito via API.
    return NextResponse.json({ error: "origem inválida" }, { status: 400 });
  }

  try {
    const result = await solicitarTroca({
      pedidoItemId,
      skuSubstituto,
      origem,
      usuarioId: session.id,
      usuarioNome: session.nome,
    });
    return NextResponse.json({
      ok: true,
      auto: result.auto,
      troca: result.troca,
    });
  } catch (err) {
    if (err instanceof TrocaError) return trocaErrorResponse(err);
    logger.error("api.wms.trocas", "erro solicitando troca", {
      error: err instanceof Error ? err.message : String(err),
      pedidoItemId,
      skuSubstituto,
    });
    return NextResponse.json({ error: "Erro interno ao solicitar troca" }, { status: 500 });
  }
}
