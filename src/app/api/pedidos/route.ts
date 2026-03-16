import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import type { GalpaoEstoque } from "@/types";

/**
 * GET /api/pedidos
 *
 * Returns all orders from siso_pedidos + siso_pedido_item_estoques (normalized),
 * mapped to the frontend Pedido interface (camelCase).
 *
 * Stock is returned as a dynamic map keyed by galpão name, supporting any
 * number of galpões without hardcoded CWB/SP references.
 *
 * Query params:
 *   ?status=pendente,executando  (comma-separated filter)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");

  const supabase = createServiceClient();

  let query = supabase
    .from("siso_pedidos")
    .select("*, siso_empresas(nome)")
    .order("criado_em", { ascending: false })
    .limit(200);

  if (statusFilter) {
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

  const pedidoIds = pedidos.map((p) => p.id);

  // Fetch items + normalized stock in parallel
  const [itensResult, estoquesResult] = await Promise.all([
    supabase
      .from("siso_pedido_itens")
      .select("pedido_id, produto_id, sku, descricao, quantidade_pedida, fornecedor_oc, imagem_url")
      .in("pedido_id", pedidoIds),
    supabase
      .from("siso_pedido_item_estoques")
      .select("pedido_id, produto_id, empresa_id, deposito_id, deposito_nome, saldo, reservado, disponivel, localizacao, siso_empresas!inner(galpao_id, siso_galpoes!inner(nome))")
      .in("pedido_id", pedidoIds),
  ]);

  const itens = itensResult.data ?? [];
  const estoques = estoquesResult.data ?? [];

  // Group items by pedido_id
  const itensByPedido = new Map<string, typeof itens>();
  for (const item of itens) {
    const list = itensByPedido.get(item.pedido_id) ?? [];
    list.push(item);
    itensByPedido.set(item.pedido_id, list);
  }

  // Build stock map: pedido_id → produto_id → galpão_name → aggregated stock
  type StockEntry = {
    depositoId: number | null;
    depositoNome: string | null;
    saldo: number;
    reservado: number;
    disponivel: number;
    localizacao: string | null;
  };

  const stockMap = new Map<string, Map<number, Map<string, StockEntry>>>();

  for (const est of estoques) {
    const empresa = est.siso_empresas as unknown as {
      galpao_id: string;
      siso_galpoes: { nome: string };
    } | null;
    if (!empresa) continue;

    const galpaoNome = empresa.siso_galpoes.nome;
    const pedidoKey = est.pedido_id as string;
    const produtoKey = est.produto_id as number;

    if (!stockMap.has(pedidoKey)) stockMap.set(pedidoKey, new Map());
    const produtoMap = stockMap.get(pedidoKey)!;
    if (!produtoMap.has(produtoKey)) produtoMap.set(produtoKey, new Map());
    const galpaoMap = produtoMap.get(produtoKey)!;

    const existing = galpaoMap.get(galpaoNome);
    if (existing) {
      // Aggregate across empresas in the same galpão
      existing.saldo += (est.saldo as number) ?? 0;
      existing.reservado += (est.reservado as number) ?? 0;
      existing.disponivel += (est.disponivel as number) ?? 0;
      if (!existing.localizacao && est.localizacao) {
        existing.localizacao = est.localizacao as string;
      }
    } else {
      galpaoMap.set(galpaoNome, {
        depositoId: est.deposito_id as number | null,
        depositoNome: est.deposito_nome as string | null,
        saldo: (est.saldo as number) ?? 0,
        reservado: (est.reservado as number) ?? 0,
        disponivel: (est.disponivel as number) ?? 0,
        localizacao: (est.localizacao as string) ?? null,
      });
    }
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
        const galpaoStock = stockMap.get(p.id)?.get(item.produto_id);
        const estoques: Record<string, GalpaoEstoque> = {};

        if (galpaoStock) {
          for (const [galpaoNome, stock] of galpaoStock) {
            estoques[galpaoNome] = {
              deposito: {
                id: stock.depositoId ?? 0,
                nome: stock.depositoNome ?? "",
                saldo: stock.saldo,
                reservado: stock.reservado,
                disponivel: stock.disponivel,
              },
              atende: stock.disponivel >= (item.quantidade_pedida ?? 0),
              localizacao: stock.localizacao ?? undefined,
            };
          }
        }

        return {
          produtoId: item.produto_id,
          sku: item.sku ?? "",
          descricao: item.descricao ?? "",
          quantidadePedida: item.quantidade_pedida ?? 0,
          estoques,
          fornecedorOC: item.fornecedor_oc ?? null,
          imagemUrl: item.imagem_url ?? undefined,
        };
      }),
      sugestao: p.sugestao ?? "propria",
      sugestaoMotivo: p.sugestao_motivo ?? "",
      status: p.status ?? "pendente",
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
