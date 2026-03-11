import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * GET /api/pedidos
 *
 * Returns all orders from siso_pedidos + siso_pedido_itens,
 * mapped to the frontend Pedido interface (camelCase).
 *
 * Query params:
 *   ?status=pendente,executando           (comma-separated filter on old status column)
 *   ?status_unificado=pendente,executando  (comma-separated filter on unified status column)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");
  const statusUnificadoFilter = searchParams.get("status_unificado");

  const supabase = createServiceClient();

  let query = supabase
    .from("siso_pedidos")
    .select("*, siso_empresas(nome)")
    .order("criado_em", { ascending: false })
    .limit(200);

  if (statusUnificadoFilter) {
    const statuses = statusUnificadoFilter.split(",").map((s) => s.trim());
    query = query.in("status_unificado", statuses);
  } else if (statusFilter) {
    const statuses = statusFilter.split(",").map((s) => s.trim());
    query = query.in("status", statuses);
  }

  const { data: pedidos, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!pedidos || pedidos.length === 0) {
    return NextResponse.json([]);
  }

  // Fetch items for all pedidos in one query
  const pedidoIds = pedidos.map((p) => p.id);
  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select("*")
    .in("pedido_id", pedidoIds);

  // Fetch normalized stock data from siso_pedido_item_estoques with empresa→galpao join
  const { data: itemEstoques } = await supabase
    .from("siso_pedido_item_estoques")
    .select("pedido_id, produto_id, empresa_id, deposito_id, deposito_nome, saldo, reservado, disponivel, localizacao, siso_empresas(galpao_id, siso_galpoes(id, nome))")
    .in("pedido_id", pedidoIds);

  // Group stock by (pedido_id, produto_id, galpao_id) and aggregate
  type GalpaoStockAgg = {
    galpaoId: string;
    galpaoNome: string;
    disponivel: number;
    saldo: number;
    reservado: number;
    depositoId: number | null;
    depositoNome: string | null;
    localizacao: string | undefined;
  };
  const stockByPedidoItem = new Map<string, Map<string, GalpaoStockAgg>>();
  for (const row of itemEstoques ?? []) {
    const empresa = row.siso_empresas as unknown as { galpao_id: string; siso_galpoes: { id: string; nome: string } | null } | null;
    if (!empresa?.siso_galpoes) continue;
    const galpaoId = empresa.siso_galpoes.id;
    const galpaoNome = empresa.siso_galpoes.nome;
    const key = `${row.pedido_id}::${row.produto_id}`;

    let byGalpao = stockByPedidoItem.get(key);
    if (!byGalpao) {
      byGalpao = new Map();
      stockByPedidoItem.set(key, byGalpao);
    }

    const existing = byGalpao.get(galpaoId);
    if (existing) {
      existing.disponivel += Number(row.disponivel ?? 0);
      existing.saldo += Number(row.saldo ?? 0);
      existing.reservado += Number(row.reservado ?? 0);
    } else {
      byGalpao.set(galpaoId, {
        galpaoId,
        galpaoNome,
        disponivel: Number(row.disponivel ?? 0),
        saldo: Number(row.saldo ?? 0),
        reservado: Number(row.reservado ?? 0),
        depositoId: row.deposito_id ?? null,
        depositoNome: row.deposito_nome ?? null,
        localizacao: row.localizacao ?? undefined,
      });
    }
  }

  // Group items by pedido_id
  const itensByPedido = new Map<string, typeof itens>();
  for (const item of itens ?? []) {
    const list = itensByPedido.get(item.pedido_id) ?? [];
    list.push(item);
    itensByPedido.set(item.pedido_id, list);
  }

  // Map to frontend shape
  const result = pedidos.map((p) => {
    const dbItens = itensByPedido.get(p.id) ?? [];

    return {
      id: p.id,
      numero: p.numero ?? "",
      data: p.data ?? "",
      filialOrigem: p.filial_origem ?? "CWB",
      empresaOrigemId: p.empresa_origem_id ?? undefined,
      empresaOrigemNome: (p.siso_empresas as unknown as { nome: string } | null)?.nome ?? undefined,
      idPedidoEcommerce: p.id_pedido_ecommerce ?? "",
      nomeEcommerce: p.nome_ecommerce ?? "",
      cliente: {
        nome: p.cliente_nome ?? "Desconhecido",
        cpfCnpj: p.cliente_cpf_cnpj ?? "",
      },
      formaEnvio: {
        id: p.forma_envio_id ?? "",
        descricao: p.forma_envio_descricao ?? "",
      },
      itens: dbItens.map((item) => {
        const quantidadePedida = item.quantidade_pedida ?? 0;
        const stockKey = `${p.id}::${item.produto_id}`;
        const galpaoMap = stockByPedidoItem.get(stockKey);
        const estoquesPorGalpao = galpaoMap
          ? Array.from(galpaoMap.values()).map((g) => ({
              ...g,
              atende: g.disponivel >= quantidadePedida,
            }))
          : undefined;

        return {
          produtoId: item.produto_id,
          sku: item.sku ?? "",
          descricao: item.descricao ?? "",
          quantidadePedida,
          estoqueCWB: item.estoque_cwb_deposito_id != null
            ? {
                id: item.estoque_cwb_deposito_id,
                nome: item.estoque_cwb_deposito_nome ?? "",
                saldo: item.estoque_cwb_saldo ?? 0,
                reservado: item.estoque_cwb_reservado ?? 0,
                disponivel: item.estoque_cwb_disponivel ?? 0,
              }
            : null,
          estoqueSP: item.estoque_sp_deposito_id != null
            ? {
                id: item.estoque_sp_deposito_id,
                nome: item.estoque_sp_deposito_nome ?? "",
                saldo: item.estoque_sp_saldo ?? 0,
                reservado: item.estoque_sp_reservado ?? 0,
                disponivel: item.estoque_sp_disponivel ?? 0,
              }
            : null,
          cwbAtende: item.cwb_atende ?? false,
          spAtende: item.sp_atende ?? false,
          fornecedorOC: item.fornecedor_oc ?? null,
          localizacaoCWB: item.localizacao_cwb ?? undefined,
          localizacaoSP: item.localizacao_sp ?? undefined,
          imagemUrl: item.imagem_url ?? undefined,
          estoquesPorGalpao,
        };
      }),
      sugestao: p.sugestao ?? "propria",
      sugestaoMotivo: p.sugestao_motivo ?? "",
      status: p.status ?? "pendente",
      statusUnificado: p.status_unificado ?? undefined,
      tipoResolucao: p.tipo_resolucao ?? undefined,
      decisaoFinal: p.decisao_final ?? undefined,
      operador: p.operador_nome ?? undefined,
      processadoEm: p.processado_em ?? undefined,
      marcadores: p.marcadores ?? [],
      erro: p.erro ?? undefined,
      criadoEm: p.criado_em ?? "",
    };
  });

  return NextResponse.json(result);
}
