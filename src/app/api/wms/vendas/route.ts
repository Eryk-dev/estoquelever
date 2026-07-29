/**
 * GET /api/wms/vendas
 *
 * Lista pedidos de venda direta — agrega:
 *   - Pedidos manuais (origem_pedido='manual')
 *   - Pedidos de marketplaces rastreados (Mercado Livre, Shopee)
 *
 * Auto-filtro "Meus pedidos" se cargos.includes('vendedor') E vendedor_id
 * não foi passado explicitamente.
 *
 * Query params:
 *   tab        = pendentes | em_separacao | baixados | concluidos (default pendentes)
 *   vendedor_id (string|"__todos__") — filtro exclusivo de admin/operador;
 *                                      outros perfis sempre usam o próprio id
 *   marketplace = "Mercado Livre" | "Shopee" | "manual" — filtro de origem
 *   galpao_id  — filtra por separacao_galpao_id
 *   data_de / data_ate (ISO date)
 *   busca      — número, cliente_nome, id_pedido_ecommerce
 *   page (default 1) / page_size (default 50, max 200)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import {
  calcularSaidasVendaPorItem,
  resumirItensVenda,
  type VendaMovLinkTraceLike,
  type VendaMovimentoTraceLike,
} from "@/lib/wms/vendas-trace";

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ erro: "Sessão inválida" }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const tab = (sp.get("tab") ?? "pendentes") as
    | "pendentes"
    | "em_separacao"
    | "baixados"
    | "concluidos"
    | "full";

  const vendedorParam = sp.get("vendedor_id");
  const marketplace = sp.get("marketplace");
  const galpaoId = sp.get("galpao_id");
  const dataDe = sp.get("data_de");
  const dataAte = sp.get("data_ate");
  const busca = sp.get("busca")?.trim();
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10));
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, parseInt(sp.get("page_size") ?? String(PAGE_SIZE_DEFAULT), 10)),
  );

  // Filtro de visibilidade. Só admin/operador pode escolher outro vendedor ou
  // todos; qualquer outro perfil autenticado fica preso ao próprio user.id.
  // Espelha a fronteira de autorização usada no detalhe da venda.
  const isAdmin = userCan(user, "sistema.usuarios");
  const isOperador = userCan(user, "separacao.executar");
  const podeFiltrarVendedor = isAdmin || isOperador;
  const isVendedor =
    !podeFiltrarVendedor && userCan(user, "vendas.criar");
  const hideCusto = isVendedor && !isAdmin;

  let vendedorFilter: string | null = user.id;
  if (podeFiltrarVendedor) {
    if (vendedorParam === "__todos__") {
      vendedorFilter = null;
    } else {
      vendedorFilter = vendedorParam || null;
    }
  }

  const supabase = createServiceClient();

  let query = supabase
    .from("siso_pedidos")
    .select(
      `id, numero, data, filial_origem, empresa_origem_id, cliente_nome, cliente_cpf_cnpj,
       nome_ecommerce, id_pedido_ecommerce, sugestao, sugestao_motivo, status, tipo_resolucao,
       decisao_final, separacao_galpao_id, status_separacao, marcadores, criado_em,
       processado_em, embalagem_concluida_em, etiqueta_url,
       vendedor_id, vendedor_nome, origem_pedido, canal_venda,
       separacao_full, fechado_em`,
      { count: "exact" },
    )
    .or("origem_pedido.eq.manual,nome_ecommerce.in.(\"Mercado Livre\",\"Shopee\")")
    // Aba "Full" mostra os pedidos Full; as abas de STATUS excluem Full
    // (zero-regressão — a lane de picking deles é /wms/separacao-full).
    .eq("separacao_full", tab === "full");

  // Filtro por tab
  switch (tab) {
    case "pendentes":
      query = query
        .in("status", ["pendente", "executando"])
        .is("embalagem_concluida_em", null);
      break;
    case "em_separacao":
      query = query.in("status_separacao", [
        "aguardando_nf",
        "aguardando_separacao",
        "em_separacao",
        "separado",
        "embalado",
        "conferido",
      ]);
      break;
    case "baixados":
      query = query
        .eq("origem_pedido", "manual")
        .eq("status", "concluido")
        .is("status_separacao", null);
      break;
    case "concluidos":
      query = query.eq("status", "concluido");
      break;
    case "full":
      // Aba Full: todos os pedidos Full, qualquer status (o base já filtra
      // separacao_full=true). Sem filtro de status.
      break;
  }

  if (vendedorFilter) query = query.eq("vendedor_id", vendedorFilter);
  if (marketplace === "manual") query = query.eq("origem_pedido", "manual");
  else if (marketplace) query = query.eq("nome_ecommerce", marketplace);

  if (galpaoId) query = query.eq("separacao_galpao_id", galpaoId);
  if (dataDe) query = query.gte("data", dataDe);
  if (dataAte) query = query.lte("data", dataAte);
  if (busca) {
    const safe = busca.replace(/[%,]/g, "");
    query = query.or(
      `numero.ilike.%${safe}%,cliente_nome.ilike.%${safe}%,id_pedido_ecommerce.ilike.%${safe}%`,
    );
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.order("criado_em", { ascending: false }).range(from, to);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }

  // A lista precisa mostrar progresso real do pedido, não só o status do
  // cabeçalho. Busca os itens somente da página atual e agrega no servidor
  // para manter o payload pequeno.
  const pedidos = data ?? [];
  const pedidoIds = pedidos.map((pedido) => String(pedido.id));
  const resumoPorPedido = new Map<
    string,
    ReturnType<typeof resumirItensVenda>
  >();

  if (pedidoIds.length > 0) {
    const { data: itens, error: itensError } = await supabase
      .from("siso_pedido_itens")
      .select(
        `id, pedido_id, sku, quantidade_pedida, quantidade_pega, quantidade_bipada,
         quantidade_encaixotada, separacao_marcado, separacao_parcial,
         bipado_completo, estoque_saida_lancada, mov_saida_id, compra_status`,
      )
      .in("pedido_id", pedidoIds);

    if (itensError) {
      return NextResponse.json({ erro: itensError.message }, { status: 500 });
    }

    const itemRows = itens ?? [];
    const itemIds = itemRows.map((item) => Number(item.id));
    const [linksResult, pedidoMovsResult, legacyMovsResult] = await Promise.all([
      itemIds.length > 0
        ? supabase
            .from("siso_pedido_item_mov_links")
            .select("pedido_item_id, mov_id, qty, tipo_link")
            .in("pedido_item_id", itemIds)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from("siso_movimentacoes")
        .select(
          "id, pedido_id, tipo, quantidade, qty_estornada, estorno_de, origem_detalhes",
        )
        .in("pedido_id", pedidoIds),
      // Cutover legado da baixa direta: as primeiras vendas gravavam o pedido
      // somente dentro do JSON da movimentação.
      supabase
        .from("siso_movimentacoes")
        .select(
          "id, pedido_id, tipo, quantidade, qty_estornada, estorno_de, origem_detalhes",
        )
        .in("origem_detalhes->>pedido_id_manual", pedidoIds),
    ]);

    const traceError =
      linksResult.error ?? pedidoMovsResult.error ?? legacyMovsResult.error;
    if (traceError) {
      return NextResponse.json({ erro: traceError.message }, { status: 500 });
    }

    const movimentosMap = new Map<string, VendaMovimentoTraceLike & {
      pedido_id?: string | null;
    }>();
    for (const movimento of [
      ...(pedidoMovsResult.data ?? []),
      ...(legacyMovsResult.data ?? []),
    ]) {
      const origemDetalhes =
        movimento.origem_detalhes &&
        typeof movimento.origem_detalhes === "object" &&
        !Array.isArray(movimento.origem_detalhes)
          ? (movimento.origem_detalhes as Record<string, unknown>)
          : {};
      movimentosMap.set(String(movimento.id), {
        ...movimento,
        origem_detalhes: origemDetalhes,
      });
    }

    const itensAgrupados = new Map<string, typeof itemRows>();
    for (const item of itemRows) {
      const pedidoId = String(item.pedido_id);
      const grupo = itensAgrupados.get(pedidoId) ?? [];
      grupo.push(item);
      itensAgrupados.set(pedidoId, grupo);
    }

    const movimentosAgrupados = new Map<string, VendaMovimentoTraceLike[]>();
    for (const movimento of movimentosMap.values()) {
      const pedidoId = String(
        movimento.pedido_id ??
          movimento.origem_detalhes?.pedido_id_manual ??
          "",
      );
      if (!pedidoId) continue;
      const grupo = movimentosAgrupados.get(pedidoId) ?? [];
      grupo.push(movimento);
      movimentosAgrupados.set(pedidoId, grupo);
    }

    const linksPorItem = new Map<string, VendaMovLinkTraceLike[]>();
    for (const link of linksResult.data ?? []) {
      const itemId = String(link.pedido_item_id);
      const grupo = linksPorItem.get(itemId) ?? [];
      grupo.push(link);
      linksPorItem.set(itemId, grupo);
    }

    for (const pedidoId of pedidoIds) {
      const itensPedido = itensAgrupados.get(pedidoId) ?? [];
      const linksPedido = itensPedido.flatMap(
        (item) => linksPorItem.get(String(item.id)) ?? [],
      );
      const saidasPorItem = calcularSaidasVendaPorItem(
        itensPedido,
        movimentosAgrupados.get(pedidoId) ?? [],
        linksPedido,
      );
      resumoPorPedido.set(
        pedidoId,
        resumirItensVenda(
          itensPedido.map((item) => ({
            ...item,
            quantidade_baixada_movimentos:
              saidasPorItem.get(String(item.id)) ?? 0,
          })),
        ),
      );
    }
  }

  // Hide custo (defense in depth — pedido row doesn't expose custo direct, but
  // garantia futura). Por ora não filtra nada — só sinaliza no payload.
  return NextResponse.json({
    pedidos: pedidos.map((pedido) => ({
      ...pedido,
      resumo_itens:
        resumoPorPedido.get(String(pedido.id)) ?? resumirItensVenda([]),
    })),
    total: count ?? 0,
    page,
    page_size: pageSize,
    auto_filtro_meus: !podeFiltrarVendedor,
    hide_custo: hideCusto,
  });
}
