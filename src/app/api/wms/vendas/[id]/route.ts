/**
 * GET /api/wms/vendas/[id]
 *
 * Detalhe completo de um pedido de venda direta (manual ou marketplace).
 * Retorna pedido + items + observações + histórico. Esconde custo pra vendedor.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ erro: "Sessão inválida" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  const { data: pedido, error } = await supabase
    .from("siso_pedidos")
    .select(
      `id, numero, data, filial_origem, empresa_origem_id, cliente_nome, cliente_cpf_cnpj,
       nome_ecommerce, id_pedido_ecommerce, sugestao, sugestao_motivo, status, tipo_resolucao,
       decisao_final, separacao_galpao_id, status_separacao, marcadores, criado_em,
       processado_em, embalagem_concluida_em, etiqueta_url, separacao_operador_id,
       separacao_iniciada_em, separacao_concluida_em, payload_original,
       vendedor_id, vendedor_nome, origem_pedido, canal_venda`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }
  if (!pedido) {
    return NextResponse.json({ erro: "Pedido não encontrado" }, { status: 404 });
  }

  // Permissão: vendedor só pode ver pedidos da aba Vendas (manual OR ML/Shopee).
  const isVendaDireta =
    pedido.origem_pedido === "manual" ||
    pedido.nome_ecommerce === "Mercado Livre" ||
    pedido.nome_ecommerce === "Shopee";
  const isVendedor = user.cargos.includes("vendedor");
  if (isVendedor && !isVendaDireta) {
    return NextResponse.json({ erro: "Sem permissão" }, { status: 403 });
  }

  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, produto_id, sku, descricao, quantidade_pedida, quantidade_bipada, bipado_completo, separacao_marcado, separacao_marcado_em, compra_status, compra_quantidade_solicitada, compra_quantidade_recebida",
    )
    .eq("pedido_id", id);

  const { data: historico } = await supabase
    .from("siso_pedido_historico")
    .select("id, pedido_id, evento, usuario_id, usuario_nome, detalhes, criado_em")
    .eq("pedido_id", id)
    .order("criado_em", { ascending: true });

  return NextResponse.json({
    pedido,
    itens: itens ?? [],
    historico: historico ?? [],
  });
}
