import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GalpaoEstoque } from "@/types";
import { aggregateLiveStockBySku } from "@/lib/wms/live-stock";
import {
  recomputarSugestaoBatch,
  type PedidoInput,
} from "@/lib/wms/sugestao-dinamica";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildResponse(supabase: SupabaseClient, pedidos: any[]) {
  if (!pedidos || pedidos.length === 0) return [];

  const pedidoIds = pedidos.map((p) => p.id);

  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select("id, pedido_id, produto_id, sku, descricao, quantidade_pedida, fornecedor_oc, imagem_url")
    .in("pedido_id", pedidoIds);

  const itensList = itens ?? [];

  const itensByPedido = new Map<string, typeof itensList>();
  for (const item of itensList) {
    const list = itensByPedido.get(item.pedido_id) ?? [];
    list.push(item);
    itensByPedido.set(item.pedido_id, list);
  }

  // Estoque LIVE: agrega siso_estoque (3D) por (sku, galpão) — não usa o snapshot
  // de siso_pedido_item_estoques, que congela na hora do webhook.
  const skus = Array.from(new Set(itensList.map((i) => i.sku).filter((s): s is string => !!s)));
  const stockBySku = await aggregateLiveStockBySku(supabase, skus);

  // Sugestão dinâmica: pra pedidos ainda em decisão (pendente/erro), recomputa
  // sugestao com base no estoque atual. Snapshot em siso_pedidos.sugestao é
  // preservado pra auditoria, mas o response devolve o valor recomputado.
  const pedidosPraRecalcular: PedidoInput[] = pedidos
    .filter((p) => p.status === "pendente" || p.status === "erro")
    .filter((p) => !!p.empresa_origem_id)
    .map((p) => ({
      pedidoId: p.id,
      empresaOrigemId: p.empresa_origem_id as string,
      itens: (itensByPedido.get(p.id) ?? [])
        .filter((it) => !!it.sku)
        .map((it) => ({
          sku: it.sku as string,
          quantidade: Number(it.quantidade_pedida) || 0,
        })),
    }));
  const sugestoesAtuais = await recomputarSugestaoBatch(supabase, pedidosPraRecalcular);

  return pedidos.map((p) => {
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
        const galpaoStock = item.sku ? stockBySku.get(item.sku) : undefined;
        const estoquesMap: Record<string, GalpaoEstoque> = {};

        if (galpaoStock) {
          for (const [gNome, stock] of galpaoStock) {
            estoquesMap[gNome] = {
              deposito: {
                id: 0,
                nome: gNome,
                saldo: stock.saldo,
                reservado: stock.reservado,
                disponivel: stock.disponivel,
              },
              atende: stock.disponivel >= (item.quantidade_pedida ?? 0),
              localizacao: stock.localizacaoTop ?? undefined,
            };
          }
        }

        return {
          itemId: item.id,
          produtoId: item.produto_id,
          sku: item.sku ?? "",
          descricao: item.descricao ?? "",
          quantidadePedida: item.quantidade_pedida ?? 0,
          estoques: estoquesMap,
          fornecedorOC: item.fornecedor_oc ?? null,
          imagemUrl: item.imagem_url ?? undefined,
        };
      }),
      sugestao: sugestoesAtuais.get(p.id)?.sugestao ?? p.sugestao ?? "propria",
      sugestaoMotivo:
        sugestoesAtuais.get(p.id)?.motivo ?? p.sugestao_motivo ?? "",
      status: p.status ?? "pendente",
      tipoResolucao: p.tipo_resolucao ?? undefined,
      decisaoFinal: p.decisao_final ?? undefined,
      operador: p.operador_nome ?? undefined,
      processadoEm: p.processado_em ?? undefined,
      marcadores: p.marcadores ?? [],
      erro: p.erro ?? undefined,
      criadoEm: p.criado_em ?? "",
      encaminhado_de: p.encaminhado_de ?? null,
      status_separacao: p.status_separacao ?? null,
    };
  });
}

/**
 * GET /api/pedidos
 *
 * Returns all orders from siso_pedidos + LIVE stock from siso_estoque (3D
 * WMS cache), mapped to the frontend Pedido interface (camelCase).
 *
 * Stock is aggregated by (sku, galpão), so any movement (recebimento,
 * ajuste, transferência, separação) reflects on the next render. NÃO usa
 * o snapshot congelado de siso_pedido_item_estoques. A `sugestao` do
 * pedido permanece o cálculo histórico do webhook, mas saldo é live.
 *
 * Query params:
 *   ?status=pendente,executando  (comma-separated filter)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");

  const supabase = createServiceClient();

  if (statusFilter) {
    const statuses = statusFilter.split(",").map((s) => s.trim());
    const { data: pedidos, error } = await supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .in("status", statuses)
      .order("criado_em", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(await buildResponse(supabase, pedidos ?? []));
  }

  // No status filter: fetch ALL active orders (pendente/executando/erro) +
  // orders awaiting reallocation (pendente_realocacao — status=concluido but need operator) +
  // recent concluido/cancelado. This prevents the limit from hiding pending orders.
  const activeStatuses = ["pendente", "executando", "erro"];
  const [activeResult, realocacaoResult, recentResult] = await Promise.all([
    supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .in("status", activeStatuses)
      .order("criado_em", { ascending: false }),
    supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .eq("status_separacao", "pendente_realocacao")
      .order("criado_em", { ascending: false }),
    supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .not("status", "in", `(${activeStatuses.join(",")})`)
      .neq("status_separacao", "pendente_realocacao")
      .order("criado_em", { ascending: false })
      .limit(150),
  ]);

  const error = activeResult.error || realocacaoResult.error || recentResult.error;
  // Deduplicate: realocacao orders might also appear in active (e.g. if status=pendente)
  const seen = new Set<string>();
  const pedidos: typeof activeResult.data = [];
  for (const p of [
    ...(activeResult.data ?? []),
    ...(realocacaoResult.data ?? []),
    ...(recentResult.data ?? []),
  ]) {
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      pedidos.push(p);
    }
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(await buildResponse(supabase, pedidos));
}
