import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GalpaoEstoque } from "@/types";
import { aggregateLiveStockBySku } from "@/lib/wms/live-stock";
import { recomputarSugestaoBatch } from "@/lib/wms/sugestao-dinamica";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";

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
  // + fotos do produto (siso_produtos.imagens) por SKU, em paralelo — alimenta o lightbox.
  const skus = Array.from(new Set(itensList.map((i) => i.sku).filter((s): s is string => !!s)));
  const [stockBySku, produtosImgs] = await Promise.all([
    aggregateLiveStockBySku(supabase, skus),
    supabase.from("siso_produtos").select("sku, imagens").in("sku", skus),
  ]);
  const imagensBySku = new Map<string, string[]>();
  for (const p of (produtosImgs.data ?? []) as { sku: string; imagens: string[] | null }[]) {
    if (p.sku && p.imagens && p.imagens.length > 0) imagensBySku.set(p.sku, p.imagens);
  }

  // Sugestão VIVA pra pedidos ainda em decisão (pendente/erro): recomputa a
  // rota contra o estoque atual de siso_estoque em vez de servir o snapshot
  // congelado no webhook. Um pedido que caiu OC por falta de saldo e depois
  // ganhou estoque passa a sugerir Própria/Transferência — o operador nunca
  // vê (nem aprova) OC com estoque coberto. Espelha o que /pedidos/[id]/detalhe
  // já faz; recomputarSugestaoBatch custa 5 queries fixas pro lote inteiro
  // (independe de N). Snapshot em siso_pedidos.sugestao vira só fallback
  // (pedidos já decididos ou sem empresa_origem_id).
  const decidiveis = pedidos.filter(
    (p) => (p.status === "pendente" || p.status === "erro") && p.empresa_origem_id,
  );
  // O recompute é um realce de exibição — se falhar (timeout/erro DB), degrada
  // pro snapshot persistido (?? p.sugestao abaixo) em vez de derrubar a listagem
  // inteira com 500. O detalhe é blindado pelo try-catch do handler; aqui o
  // .catch local cobre o mesmo.
  const sugestoesVivas =
    decidiveis.length > 0
      ? await recomputarSugestaoBatch(
          supabase,
          decidiveis.map((p) => ({
            pedidoId: p.id,
            empresaOrigemId: p.empresa_origem_id,
            itens: (itensByPedido.get(p.id) ?? [])
              .filter((it) => !!it.sku)
              .map((it) => ({
                sku: it.sku as string,
                quantidade: Number(it.quantidade_pedida) || 0,
              })),
          })),
        ).catch((err) => {
          logger.warn(
            "pedidos-lista",
            "recompute de sugestão falhou — servindo snapshot persistido",
            {
              error: err instanceof Error ? err.message : String(err),
              pedidos: decidiveis.length,
            },
          );
          return null;
        })
      : null;

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
          imagens: imagensBySku.get(item.sku ?? "") ?? [],
        };
      }),
      sugestao: sugestoesVivas?.get(p.id)?.sugestao ?? p.sugestao ?? "propria",
      sugestaoMotivo: sugestoesVivas?.get(p.id)?.motivo ?? p.sugestao_motivo ?? "",
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
 * [Fix-D #12] Filtra server-side por galpão. Operadores galpão-scoped
 * (operador_cwb / operador_sp) só veem pedidos do seu galpão OU pedidos
 * ainda sem `separacao_galpao_id` (pré-aprovação — visíveis pra todos).
 * Admin (sem cargo galpão-scoped) vê tudo.
 *
 * Query params:
 *   ?status=pendente,executando  (comma-separated filter)
 */
export async function GET(request: Request) {
  // Auth + perm (finding 1.7 + 1.10)
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "pedidos.ver")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");
  const supabase = createServiceClient();

  // [Fix-D #12] Filtro galpão server-side. Aplica quando session tem galpão
  // resolvido E user NÃO é admin (admin vê tudo). Pedidos sem
  // separacao_galpao_id (pré-aprovação) aparecem pra todos via OR is.null.
  const galpaoSession = session.galpaoId;
  const isAdmin = session.cargos.includes("admin");
  const filterGalpao = !isAdmin && galpaoSession;
  const galpaoOrClause = filterGalpao
    ? `separacao_galpao_id.eq.${galpaoSession},separacao_galpao_id.is.null`
    : null;

  if (statusFilter) {
    const statuses = statusFilter.split(",").map((s) => s.trim());
    let q = supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .in("status", statuses);
    if (galpaoOrClause) q = q.or(galpaoOrClause);
    const { data: pedidos, error } = await q
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

  function buildActive() {
    let q = supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .in("status", activeStatuses);
    if (galpaoOrClause) q = q.or(galpaoOrClause);
    return q.order("criado_em", { ascending: false });
  }

  function buildRealocacao() {
    let q = supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .eq("status_separacao", "pendente_realocacao");
    if (galpaoOrClause) q = q.or(galpaoOrClause);
    return q.order("criado_em", { ascending: false });
  }

  function buildRecent() {
    let q = supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .not("status", "in", `(${activeStatuses.join(",")})`)
      .neq("status_separacao", "pendente_realocacao");
    if (galpaoOrClause) q = q.or(galpaoOrClause);
    return q.order("criado_em", { ascending: false }).limit(150);
  }

  const [activeResult, realocacaoResult, recentResult] = await Promise.all([
    buildActive(),
    buildRealocacao(),
    buildRecent(),
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
