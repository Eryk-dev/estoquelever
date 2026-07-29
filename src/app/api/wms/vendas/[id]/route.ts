/**
 * GET /api/wms/vendas/[id]
 *
 * Detalhe completo de um pedido de venda direta (manual ou marketplace).
 * Retorna pedido + items + observações + histórico. Esconde custo pra vendedor.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import {
  calcularSaidasVendaPorItem,
  quantidadeMovimentoPorItem,
} from "@/lib/wms/vendas-trace";

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
       separacao_full, fechado_em,
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

  // Permissão: vendedor "puro" (sem perms de admin/operador) só pode ver
  // pedidos da aba Vendas (manual OR ML/Shopee) E que sejam seus
  // (vendedor_id == session.id OR vendedor_nome contém session.nome).
  const isVendaDireta =
    pedido.origem_pedido === "manual" ||
    pedido.nome_ecommerce === "Mercado Livre" ||
    pedido.nome_ecommerce === "Shopee";
  const isAdmin = userCan(user, "sistema.usuarios");
  const isOperador = userCan(user, "separacao.executar");
  const exigeOwnership = !isAdmin && !isOperador;
  if (exigeOwnership) {
    if (!isVendaDireta) {
      return NextResponse.json({ erro: "Sem permissão" }, { status: 403 });
    }
    // Ownership: vendedor_id match OR auto-atribuição via vendedor_nome
    // (webhook-processor seta vendedor_nome = `${ecomNome} ${empresaNome}`
    // — chequeamos com case-insensitive contains pra cobrir esse caso).
    const ownedById = pedido.vendedor_id === user.id;
    const ownedByName = pedido.vendedor_nome
      ? pedido.vendedor_nome.toLowerCase().includes(user.nome.toLowerCase())
      : false;
    if (!ownedById && !ownedByName) {
      return NextResponse.json({ erro: "Sem permissão (não é seu pedido)" }, { status: 403 });
    }
  }

  const { data: itens, error: itensError } = await supabase
    .from("siso_pedido_itens")
    .select(
      `id, pedido_id, produto_id, sku, descricao, imagem_url, gtin,
       quantidade_pedida, quantidade_pega, quantidade_bipada,
       quantidade_encaixotada, bipado_completo, bipado_em, bipado_por,
       separacao_marcado, separacao_marcado_em, separacao_parcial,
       parcial_motivo, parcial_em, parcial_por, estoque_saida_lancada,
       mov_saida_id, mov_ajuste_loc_zerou_id, compra_status,
       compra_quantidade_solicitada, compra_quantidade_recebida,
       comprado_em, recebido_em, ordem_full, linha`,
    )
    .eq("pedido_id", id);
  if (itensError) {
    return NextResponse.json({ erro: itensError.message }, { status: 500 });
  }

  const { data: historico, error: historicoError } = await supabase
    .from("siso_pedido_historico")
    .select("id, pedido_id, evento, usuario_id, usuario_nome, detalhes, criado_em")
    .eq("pedido_id", id)
    .order("criado_em", { ascending: true });
  if (historicoError) {
    return NextResponse.json({ erro: historicoError.message }, { status: 500 });
  }

  const itemRows = itens ?? [];
  const itemIds = itemRows.map((item) => Number(item.id));
  const MOV_SELECT = `
    id, produto_id, galpao_id, localizacao_id, tipo, quantidade,
    origem_tipo, origem_id, origem_detalhes, usuario_id, observacoes,
    motivo, estorno_de, qty_estornada, criado_em, pedido_id,
    produto:siso_produtos(sku, descricao),
    galpao:siso_galpoes(nome),
    localizacao:siso_localizacoes(codigo, tipo)
  `;

  const [linksResult, pedidoMovsResult, legacyMovsResult] = await Promise.all([
    itemIds.length > 0
      ? supabase
          .from("siso_pedido_item_mov_links")
          .select("pedido_item_id, mov_id, qty, tipo_link, criado_em")
          .in("pedido_item_id", itemIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("siso_movimentacoes")
      .select(MOV_SELECT)
      .eq("pedido_id", id)
      .order("criado_em", { ascending: true })
      .limit(500),
    // Movimentações antigas de venda direta só carregavam o pedido dentro do
    // JSON de origem. Mantém a trilha visível também para esse legado.
    supabase
      .from("siso_movimentacoes")
      .select(MOV_SELECT)
      .eq("origem_detalhes->>pedido_id_manual", id)
      .order("criado_em", { ascending: true })
      .limit(500),
  ]);

  const traceError =
    linksResult.error ?? pedidoMovsResult.error ?? legacyMovsResult.error;
  if (traceError) {
    return NextResponse.json({ erro: traceError.message }, { status: 500 });
  }

  const links = linksResult.data ?? [];
  const movimentosMap = new Map<
    string,
    Record<string, unknown>
  >();
  for (const movimento of [
    ...(pedidoMovsResult.data ?? []),
    ...(legacyMovsResult.data ?? []),
  ]) {
    movimentosMap.set(
      String(movimento.id),
      movimento as unknown as Record<string, unknown>,
    );
  }

  const linkedIds = links.map((link) => String(link.mov_id));
  const missingLinkedIds = linkedIds.filter((movId) => !movimentosMap.has(movId));
  if (missingLinkedIds.length > 0) {
    const { data: linkedMovs, error: linkedMovsError } = await supabase
      .from("siso_movimentacoes")
      .select(MOV_SELECT)
      .in("id", missingLinkedIds);
    if (linkedMovsError) {
      return NextResponse.json({ erro: linkedMovsError.message }, { status: 500 });
    }
    for (const movimento of linkedMovs ?? []) {
      movimentosMap.set(
        String(movimento.id),
        movimento as unknown as Record<string, unknown>,
      );
    }
  }

  const movimentoIds = [...movimentosMap.keys()];
  const estornosQtyPorMov = new Map<string, number>();
  const estornosItemPorMov = new Map<string, Set<string>>();
  if (movimentoIds.length > 0) {
    const { data: estornos, error: estornosError } = await supabase
      .from("siso_movimentacoes")
      .select("estorno_de, quantidade, origem_detalhes")
      .in("estorno_de", movimentoIds);
    if (estornosError) {
      return NextResponse.json({ erro: estornosError.message }, { status: 500 });
    }
    for (const estorno of estornos ?? []) {
      if (!estorno.estorno_de) continue;
      const movId = String(estorno.estorno_de);
      estornosQtyPorMov.set(
        movId,
        (estornosQtyPorMov.get(movId) ?? 0) +
          Number(estorno.quantidade ?? 0),
      );
      const detalhes =
        estorno.origem_detalhes &&
        typeof estorno.origem_detalhes === "object" &&
        !Array.isArray(estorno.origem_detalhes)
          ? (estorno.origem_detalhes as Record<string, unknown>)
          : {};
      const itemId =
        detalhes.pedido_item_id ?? detalhes.item_id ?? detalhes.pedidoItemId;
      if (itemId != null) {
        const grupo = estornosItemPorMov.get(movId) ?? new Set<string>();
        grupo.add(String(itemId));
        estornosItemPorMov.set(movId, grupo);
      }
    }
  }

  const movimentosTotalmenteEstornados = new Set<string>();
  for (const [movId, movimento] of movimentosMap) {
    const quantidade = Number(movimento.quantidade ?? 0);
    const estornada = Math.max(
      Number(movimento.qty_estornada ?? 0),
      estornosQtyPorMov.get(movId) ?? 0,
    );
    if (quantidade > 0 && estornada >= quantidade) {
      movimentosTotalmenteEstornados.add(movId);
    }
  }

  const userIds = new Set<string>();
  if (pedido.separacao_operador_id) {
    userIds.add(String(pedido.separacao_operador_id));
  }
  for (const item of itemRows) {
    if (item.bipado_por) userIds.add(String(item.bipado_por));
    if (item.parcial_por) userIds.add(String(item.parcial_por));
  }
  for (const movimento of movimentosMap.values()) {
    if (movimento.usuario_id) userIds.add(String(movimento.usuario_id));
  }

  const usuarios = new Map<string, string>();
  if (userIds.size > 0) {
    const { data: usuariosRows, error: usuariosError } = await supabase
      .from("siso_usuarios")
      .select("id, nome")
      .in("id", [...userIds]);
    if (usuariosError) {
      return NextResponse.json({ erro: usuariosError.message }, { status: 500 });
    }
    for (const usuario of usuariosRows ?? []) {
      usuarios.set(String(usuario.id), usuario.nome);
    }
  }

  const linkPorMovItem = new Map<
    string,
    { qty: number; tipo_link: string }
  >();
  for (const link of links) {
    const itemId = Number(link.pedido_item_id);
    const key = `${itemId}:${String(link.mov_id)}`;
    const atual = linkPorMovItem.get(key);
    linkPorMovItem.set(key, {
      qty: (atual?.qty ?? 0) + Number(link.qty),
      tipo_link: atual?.tipo_link ?? link.tipo_link,
    });
  }

  const skuCount = new Map<string, number>();
  for (const item of itemRows) {
    const sku = String(item.sku ?? "");
    skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
  }

  function relationOne<T>(value: T | T[] | null | undefined): T | null {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }

  function movimentoDetalhes(
    movimento: Record<string, unknown>,
  ): Record<string, unknown> {
    return movimento.origem_detalhes &&
      typeof movimento.origem_detalhes === "object" &&
      !Array.isArray(movimento.origem_detalhes)
      ? (movimento.origem_detalhes as Record<string, unknown>)
      : {};
  }

  function movimentoSku(movimento: Record<string, unknown>): string {
    const produto = relationOne(
      movimento.produto as
        | { sku?: string | null }
        | Array<{ sku?: string | null }>
        | null,
    );
    return String(movimentoDetalhes(movimento).sku ?? produto?.sku ?? "");
  }

  function movimentoPertenceAoItem(
    movimento: Record<string, unknown>,
    item: (typeof itemRows)[number],
  ): boolean {
    if (linkPorMovItem.has(`${Number(item.id)}:${String(movimento.id)}`)) {
      return true;
    }
    if (
      String(item.mov_saida_id ?? "") === String(movimento.id) ||
      String(item.mov_ajuste_loc_zerou_id ?? "") === String(movimento.id)
    ) {
      return true;
    }
    const detalhes = movimentoDetalhes(movimento);
    const detalheItemId =
      detalhes.pedido_item_id ?? detalhes.item_id ?? detalhes.pedidoItemId;
    if (detalheItemId != null && Number(detalheItemId) === Number(item.id)) {
      return true;
    }
    // Venda direta sem tabela ponte: SKU é suficiente porque a criação normal
    // deduplica linhas. No Full com SKU repetido, só o vínculo explícito vale.
    const sku = String(item.sku ?? "");
    return (
      skuCount.get(sku) === 1 &&
      movimentoSku(movimento) === sku
    );
  }

  function formatarMovimento(
    movimento: Record<string, unknown>,
    itemId?: number,
  ) {
    const link =
      itemId == null
        ? undefined
        : linkPorMovItem.get(`${itemId}:${String(movimento.id)}`);
    const localizacao = relationOne(
      movimento.localizacao as
        | { codigo?: string | null; tipo?: string | null }
        | Array<{ codigo?: string | null; tipo?: string | null }>
        | null,
    );
    const galpao = relationOne(
      movimento.galpao as
        | { nome?: string | null }
        | Array<{ nome?: string | null }>
        | null,
    );
    return {
      id: String(movimento.id),
      tipo: String(movimento.tipo ?? ""),
      // Uma S consolidada pode atender várias linhas; nesse caso a quantidade
      // global da movimentação não é a quantidade deste item.
      quantidade: quantidadeMovimentoPorItem(
        movimento.quantidade as number | string | null | undefined,
        link?.qty,
      ),
      tipo_link: link?.tipo_link ?? null,
      origem_tipo: String(movimento.origem_tipo ?? ""),
      localizacao_codigo: localizacao?.codigo ?? null,
      localizacao_tipo: localizacao?.tipo ?? null,
      galpao_nome: galpao?.nome ?? null,
      operador_nome: movimento.usuario_id
        ? usuarios.get(String(movimento.usuario_id)) ?? null
        : null,
      criado_em: String(movimento.criado_em),
      estornado:
        movimentosTotalmenteEstornados.has(String(movimento.id)) ||
        (itemId != null &&
          (estornosItemPorMov.get(String(movimento.id))?.has(String(itemId)) ??
            false)),
      motivo: movimento.motivo ? String(movimento.motivo) : null,
    };
  }

  const movimentosOrdenados = [...movimentosMap.values()].sort(
    (a, b) =>
      new Date(String(a.criado_em)).getTime() -
      new Date(String(b.criado_em)).getTime(),
  );

  const saidasPorItem = calcularSaidasVendaPorItem(
    itemRows,
    movimentosOrdenados.map((movimento) => ({
      id: String(movimento.id),
      tipo: movimento.tipo ? String(movimento.tipo) : null,
      quantidade: Number(movimento.quantidade ?? 0),
      qty_estornada: Number(movimento.qty_estornada ?? 0),
      estorno_de: movimento.estorno_de
        ? String(movimento.estorno_de)
        : null,
      sku: movimentoSku(movimento),
      origem_detalhes: movimentoDetalhes(movimento),
    })),
    links,
  );

  // A reserva do Full é agregada por produto, não por linha. Quando o mesmo
  // SKU aparece em mais de uma linha, R/L sem pedido_item_id não podem ser
  // rateadas honestamente. Mantemos essas movs numa trilha compartilhada do
  // produto, visível nas linhas irmãs, sem atribuir quantidade individual.
  const compartilhadosPorSku = new Map<
    string,
    Array<ReturnType<typeof formatarMovimento>>
  >();
  for (const movimento of movimentosOrdenados) {
    const sku = movimentoSku(movimento);
    if (!sku || (skuCount.get(sku) ?? 0) <= 1) continue;
    const atribuidaAAlgumItem = itemRows.some((item) =>
      movimentoPertenceAoItem(movimento, item),
    );
    if (atribuidaAAlgumItem) continue;
    const grupo = compartilhadosPorSku.get(sku) ?? [];
    grupo.push(formatarMovimento(movimento));
    compartilhadosPorSku.set(sku, grupo);
  }

  const itensComTrace = itemRows
    .map((item) => {
      const itemId = Number(item.id);
      const movimentos = movimentosOrdenados
        .filter((movimento) => movimentoPertenceAoItem(movimento, item))
        .map((movimento) => formatarMovimento(movimento, itemId));

      return {
        ...item,
        quantidade_baixada_movimentos:
          saidasPorItem.get(String(item.id)) ?? 0,
        bipado_por_nome: item.bipado_por
          ? usuarios.get(String(item.bipado_por)) ?? null
          : null,
        parcial_por_nome: item.parcial_por
          ? usuarios.get(String(item.parcial_por)) ?? null
          : null,
        movimentos,
        movimentos_compartilhados_produto:
          compartilhadosPorSku.get(String(item.sku ?? "")) ?? [],
      };
    })
    .sort(
      (a, b) =>
        Number(a.ordem_full ?? a.linha ?? a.id) -
        Number(b.ordem_full ?? b.linha ?? b.id),
    );

  return NextResponse.json({
    pedido,
    itens: itensComTrace,
    historico: historico ?? [],
  });
}
