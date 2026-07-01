import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { agruparPedidosPorDiaSp, construirOrPrazoDias } from "@/lib/wms/prazo-dias";
import type { SeparacaoCounts, StatusSeparacao } from "@/types";

const VALID_STATUSES: StatusSeparacao[] = [
  "aguardando_compra",
  "aguardando_nf",
  "validacao_oc",
  "aguardando_separacao",
  "em_separacao",
  "separado",
  "embalado",
  "conferido",
  "pendente_realocacao",
];

const COUNT_STATUSES: (keyof SeparacaoCounts)[] = [
  "aguardando_compra",
  "aguardando_nf",
  "validacao_oc",
  "aguardando_separacao",
  "em_separacao",
  "separado",
  "embalado",
  "conferido",
  "pendente_realocacao",
];

/**
 * GET /api/separacao
 *
 * List orders filtered by separation status with search and sorting.
 * Returns { counts: SeparacaoCounts, pedidos: array }
 *
 * Query params:
 *   status_separacao — filter by status
 *   empresa_origem_id — filter by origin empresa
 *   sort — data_pedido (default) | localizacao | sku
 *   busca — search string (matches numero, id_pedido_ecommerce, cliente_nome, item sku/gtin
 *           vendido E sku/gtin do substituto da troca de equivalência)
 *
 * Galpão filtering:
 *   uses the authenticated session and filters by siso_pedidos.separacao_galpao_id.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilterRaw = searchParams.get("status_separacao");
  const statusFilters: StatusSeparacao[] = statusFilterRaw
    ? (statusFilterRaw.split(",") as StatusSeparacao[])
    : [];
  const empresaFilterRaw = searchParams.get("empresa_origem_id");
  // Multi-empresa: aceita lista separada por vírgula (filtro multi-select).
  const empresaIds = empresaFilterRaw
    ? empresaFilterRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const multiEmpresa = empresaIds.length > 1;
  const marketplaceFilter = searchParams.get("marketplace");
  const busca = searchParams.get("busca");
  const tagFilter = searchParams.get("tag");
  // Multi-tag: aceita lista separada por vírgula (multi-select, semântica OU).
  // overlaps([a]) ≡ contains([a]), então single-tag mantém o comportamento.
  const tagList = tagFilter
    ? tagFilter.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  // Filtro por prazo de envio (range calculado no cliente p/ respeitar o
  // fuso local). prazoSem = só pedidos sem prazo. hasPrazo força os counts
  // pro caminho legado (a RPC não filtra prazo).
  const prazoDe = searchParams.get("prazo_de");
  const prazoAte = searchParams.get("prazo_ate");
  const prazoSem = searchParams.get("prazo_sem") === "1";
  // Dias específicos (multi-select): lista de "YYYY-MM-DD" (dia em SP) +/- token
  // "sem" (sem prazo). Vira um OR de ranges UTC [de,ate) no servidor.
  const prazoDias = (searchParams.get("prazo_dias") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const orPrazoDias = construirOrPrazoDias(prazoDias);
  const hasPrazoFilter = !!(prazoDe || prazoAte || prazoSem || orPrazoDias);
  // Pista futura (ML buffered): ?futura=1 → fila futura (separacao_futura=true).
  // Ausente → fila NORMAL, que EXCLUI futura (senão um pedido futura cairia na
  // embalagem normal e geraria NF cedo).
  const futura = searchParams.get("futura") === "1";
  // Lane Full (envio ao CDF do ML): ?full=1 → separacao_full=true. Ausente →
  // exclui Full das lanes normal/futura (mesmo mecanismo do ?futura=1).
  const full = searchParams.get("full") === "1";
  // Encaixotamento (pista futura): "0" = ainda não encaixotado (fila do que falta),
  // "1" = já encaixotado (encaixotado_em preenchido). Ausente = sem filtro.
  const encaixotado = searchParams.get("encaixotado");
  // Aba Cancelados: ?cancelado=1 → pedidos status='cancelado' (status_separacao é
  // null, então NÃO usa o filtro de status_separacao nem o de separacao_futura).
  const cancelado = searchParams.get("cancelado") === "1";

  if (statusFilters.length > 0 && statusFilters.some((s) => !VALID_STATUSES.includes(s))) {
    return NextResponse.json(
      { error: `Status inválido. Use: ${VALID_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  // Filtro multi-tenant: admin vê todos os galpões; outros precisam galpão ativo.
  // Proxy: sistema.usuarios = admin no seed.
  const isAdmin = userCan(session, "sistema.usuarios");
  const activeGalpaoId = session.galpaoId;

  if (!isAdmin && !activeGalpaoId) {
    const emptyCounts: SeparacaoCounts = {
      aguardando_compra: 0,
      aguardando_nf: 0,
      validacao_oc: 0,
      aguardando_separacao: 0,
      em_separacao: 0,
      separado: 0,
      embalado: 0,
      conferido: 0,
      pendente_realocacao: 0,
    };
    return NextResponse.json({
      counts: emptyCounts,
      pedidos: [],
      empresas: [],
      error: "galpao_nao_selecionado",
    });
  }

  try {
    // Pre-fetch pedido_ids matching SKU/GTIN when searching
    let buscaItemPedidoIds: string[] | null = null;
    if (busca) {
      // 1. itens cujo SKU/GTIN VENDIDO casa.
      const { data: matchingItems } = await supabase
        .from("siso_pedido_itens")
        .select("pedido_id")
        .or(`sku.ilike.%${busca}%,gtin.ilike.%${busca}%`);
      const ids = new Set(
        (matchingItems ?? []).map((i) => i.pedido_id as string),
      );

      // 2. itens com troca de equivalência cujo SUBSTITUTO casa por SKU/GTIN —
      //    a separação exibe o substituto, então a busca acha pelo SKU novo
      //    (físico) tanto quanto pelo antigo (vendido).
      const { data: prodSub } = await supabase
        .from("siso_produtos")
        .select("id")
        .or(`sku.ilike.%${busca}%,gtin.ilike.%${busca}%`);
      const subIds = (prodSub ?? []).map((p) => p.id as string);
      if (subIds.length > 0) {
        const { data: itensSub } = await supabase
          .from("siso_pedido_itens")
          .select("pedido_id")
          .in("produto_wms_substituto_id", subIds);
        for (const i of itensSub ?? []) ids.add(i.pedido_id as string);
      }

      if (ids.size > 0) buscaItemPedidoIds = [...ids];
    }

    // Build the busca OR filter combining pedido fields + item-matched IDs
    function applyBuscaFilter<T extends { or: (filter: string) => T; in: (col: string, values: string[]) => T }>(q: T): T {
      if (!busca) return q;
      const parts = [
        `numero.ilike.%${busca}%`,
        `id_pedido_ecommerce.ilike.%${busca}%`,
        `cliente_nome.ilike.%${busca}%`,
      ];
      if (buscaItemPedidoIds && buscaItemPedidoIds.length > 0) {
        parts.push(`id.in.(${buscaItemPedidoIds.join(",")})`);
      }
      return q.or(parts.join(","));
    }

    // Aplica o filtro de prazo de envio a qualquer query (lista + counts).
    // Preset (de/ate/sem, range único calculado no cliente) E/OU dias
    // específicos (orPrazoDias, OR de ranges) — empilham como os demais filtros.
    function applyPrazoFilter<T extends {
      gte: (col: string, v: string) => T;
      lt: (col: string, v: string) => T;
      is: (col: string, v: null) => T;
      or: (filter: string) => T;
    }>(q: T): T {
      let out = q;
      if (prazoSem) out = out.is("prazo_envio", null);
      else {
        if (prazoDe) out = out.gte("prazo_envio", prazoDe);
        if (prazoAte) out = out.lt("prazo_envio", prazoAte);
      }
      if (orPrazoDias) out = out.or(orPrazoDias);
      return out;
    }

    // 1. Counts — antes 9 HEAD-counts paralelos, agora 1 RPC (wms_separacao_counts).
    // aguardando_compra skips separacao_galpao_id — filtered by supplier destination instead (post-filter)
    // legacyCounts() é o caminho antigo, intacto — usado só no fallback se a RPC falhar.
    function legacyCounts() {
      return Promise.all(
        COUNT_STATUSES.map((status) => {
          let q = supabase
            .from("siso_pedidos")
            .select("*", { count: "exact", head: true })
            .eq("status_separacao", status)
            .eq("separacao_futura", futura).eq("separacao_full", full);
          if (activeGalpaoId && status !== "aguardando_compra") q = q.eq("separacao_galpao_id", activeGalpaoId);
          if (empresaIds.length === 1) q = q.eq("empresa_origem_id", empresaIds[0]);
          else if (empresaIds.length > 1) q = q.in("empresa_origem_id", empresaIds);
          if (marketplaceFilter) q = q.ilike("nome_ecommerce", `%${marketplaceFilter}%`);
          q = applyBuscaFilter(q);
          q = applyPrazoFilter(q);
          if (tagList.length) q = q.overlaps("separacao_tags", tagList);
          return q;
        }),
      );
    }

    // RPC de counts só aceita 1 empresa e não filtra prazo. Com multi-empresa
    // ou filtro de prazo, força o caminho legado (9 HEAD-counts) reusando o
    // fallback já existente.
    const countsRpcPromise = multiEmpresa || hasPrazoFilter
      ? Promise.resolve({
          data: null,
          error: { message: "multi-empresa/prazo: usar legacy counts" },
        })
      : supabase.rpc("wms_separacao_counts", {
          p_galpao_id: activeGalpaoId ?? null,
          p_empresa_id: empresaIds[0] ?? null,
          p_marketplace: marketplaceFilter ?? null,
          p_tag: tagFilter ?? null,
          p_busca: busca ?? null,
          p_busca_pedido_ids: buscaItemPedidoIds,
          p_separacao_futura: futura,
          p_separacao_full: full,
        });

    // 1b. Fetch distinct origin empresas inside the current separation context
    let empresasPromise = supabase
      .from("siso_pedidos")
      .select("empresa_origem_id, siso_empresas(id, nome)")
      .not("status_separacao", "is", null)
      .eq("separacao_futura", futura).eq("separacao_full", full);

    if (activeGalpaoId) {
      empresasPromise = empresasPromise.eq("separacao_galpao_id", activeGalpaoId);
    }

    // 2. Pedidos query
    let pedidosQuery = supabase
      .from("siso_pedidos")
      .select(
        `id, numero, data, prazo_envio, id_pedido_ecommerce, cliente_nome,
         nome_ecommerce, forma_envio_descricao, status_separacao, decisao_final, filial_origem, marcadores, separacao_tags,
         empresa_origem_id, separacao_galpao_id, etiqueta_status, etiqueta_zpl, embalagem_concluida_em,
         nota_fiscal_id, agrupamento_expedicao_id,
         encaminhado_de, motivo_cancelamento, cancelado_origem, cancelado_em, siso_empresas(nome)`,
      );
    if (cancelado) {
      // Aba Cancelados: independe de status_separacao (sempre null) e de futura.
      pedidosQuery = pedidosQuery.eq("status", "cancelado");
    } else {
      pedidosQuery = pedidosQuery
        .not("status_separacao", "is", null)
        // Defensivo: cancelados têm status_separacao=null, mas um pedido cancelado
        // que ficasse com status_separacao preenchido (bug) vazaria aqui.
        .neq("status", "cancelado")
        .eq("separacao_futura", futura).eq("separacao_full", full);
    }

    // aguardando_compra: skip galpão filter — post-filtered by supplier destination
    const isAguardandoCompraOnly = statusFilters.length === 1 && statusFilters[0] === "aguardando_compra";
    if (activeGalpaoId && !isAguardandoCompraOnly) {
      pedidosQuery = pedidosQuery.eq("separacao_galpao_id", activeGalpaoId);
    }
    if (empresaIds.length === 1) {
      pedidosQuery = pedidosQuery.eq("empresa_origem_id", empresaIds[0]);
    } else if (empresaIds.length > 1) {
      pedidosQuery = pedidosQuery.in("empresa_origem_id", empresaIds);
    }
    if (marketplaceFilter) {
      pedidosQuery = pedidosQuery.ilike("nome_ecommerce", `%${marketplaceFilter}%`);
    }

    if (statusFilters.length === 1) {
      pedidosQuery = pedidosQuery.eq("status_separacao", statusFilters[0]);
    } else if (statusFilters.length > 1) {
      pedidosQuery = pedidosQuery.in("status_separacao", statusFilters);
    }
    pedidosQuery = applyBuscaFilter(pedidosQuery);
    pedidosQuery = applyPrazoFilter(pedidosQuery);
    if (tagList.length) {
      pedidosQuery = pedidosQuery.overlaps("separacao_tags", tagList);
    }
    if (encaixotado === "1") {
      pedidosQuery = pedidosQuery.not("encaixotado_em", "is", null);
    } else if (encaixotado === "0") {
      pedidosQuery = pedidosQuery.is("encaixotado_em", null);
    }
    if (cancelado) {
      // Cancelados: mais recente primeiro.
      pedidosQuery = pedidosQuery
        .order("cancelado_em", { ascending: false, nullsFirst: false })
        .order("data", { ascending: false });
    } else if (statusFilters.includes("embalado") || statusFilters.includes("conferido")) {
      pedidosQuery = pedidosQuery
        .order("embalagem_concluida_em", { ascending: false, nullsFirst: false })
        .order("data", { ascending: true });
    } else {
      // Fase 3 #3: pedidos reenfileirados (parcial com saldo na prateleira) vão
      // pro FIM da fila. nullsFirst → não-reenfileirados (NULL) primeiro por
      // data; reenfileirados depois, na ordem em que voltaram.
      pedidosQuery = pedidosQuery
        .order("separacao_reenfileirado_em", { ascending: true, nullsFirst: true })
        .order("data", { ascending: true });
    }

    // 1b2. Facet de DIAS de prazo disponíveis (pro multi-select "Dias").
    // Mesma base da lista (tab + galpão + empresa + marketplace + busca + tag +
    // encaixotado), MAS sem o filtro de prazo — senão a lista de dias colapsaria
    // nos já marcados e não daria pra adicionar/remover dia. Cap defensivo de
    // 5000 linhas (1 coluna só); acima disso o facet subconta (raro nas tabs).
    let diasQuery = supabase
      .from("siso_pedidos")
      .select("prazo_envio")
      .not("status_separacao", "is", null)
      .eq("separacao_futura", futura).eq("separacao_full", full)
      .limit(5000);
    if (activeGalpaoId && !isAguardandoCompraOnly) {
      diasQuery = diasQuery.eq("separacao_galpao_id", activeGalpaoId);
    }
    if (empresaIds.length === 1) diasQuery = diasQuery.eq("empresa_origem_id", empresaIds[0]);
    else if (empresaIds.length > 1) diasQuery = diasQuery.in("empresa_origem_id", empresaIds);
    if (marketplaceFilter) diasQuery = diasQuery.ilike("nome_ecommerce", `%${marketplaceFilter}%`);
    if (statusFilters.length === 1) diasQuery = diasQuery.eq("status_separacao", statusFilters[0]);
    else if (statusFilters.length > 1) diasQuery = diasQuery.in("status_separacao", statusFilters);
    diasQuery = applyBuscaFilter(diasQuery);
    if (tagList.length) diasQuery = diasQuery.overlaps("separacao_tags", tagList);
    if (encaixotado === "1") diasQuery = diasQuery.not("encaixotado_em", "is", null);
    else if (encaixotado === "0") diasQuery = diasQuery.is("encaixotado_em", null);

    // 1c. Fetch all active galpões (for encaminhar dropdown)
    const galpoesPromise = supabase
      .from("siso_galpoes")
      .select("id, nome")
      .eq("ativo", true)
      .order("nome");

    // 1d. For aguardando_compra badge count: fetch pedido IDs + item SKUs
    // to filter by supplier destination. Runs only when a galpão is active.
    async function fetchOcItems() {
      // Aplica os MESMOS filtros do toolbar (busca/empresa/marketplace/tag/
      // prazo) ao count de Compras — aguardando_compra ignora galpão (é
      // filtrado por fornecedor depois). Sem isso o badge "Compras" ficava
      // estático, fora de sincronia com a busca/filtros.
      let ocQ = supabase
        .from("siso_pedidos")
        .select("id")
        .eq("status_separacao", "aguardando_compra")
        .eq("separacao_futura", futura).eq("separacao_full", full);
      if (empresaIds.length === 1) ocQ = ocQ.eq("empresa_origem_id", empresaIds[0]);
      else if (empresaIds.length > 1) ocQ = ocQ.in("empresa_origem_id", empresaIds);
      if (marketplaceFilter) ocQ = ocQ.ilike("nome_ecommerce", `%${marketplaceFilter}%`);
      ocQ = applyBuscaFilter(ocQ);
      ocQ = applyPrazoFilter(ocQ);
      if (tagList.length) ocQ = ocQ.overlaps("separacao_tags", tagList);
      const { data: ocPedidos } = await ocQ;
      if (!ocPedidos?.length) return [];
      const { data: items } = await supabase
        .from("siso_pedido_itens")
        .select("pedido_id, sku")
        .not("compra_status", "is", null)
        .not("compra_status", "in", '("cancelado","indisponivel")')
        .in("pedido_id", ocPedidos.map((p) => p.id));
      return items ?? [];
    }

    // Execute counts + pedidos + empresas + galpoes + ocItems in parallel
    const [countsRpc, { data: pedidos, error: pedidosError }, { data: empresasList }, { data: galpoesList }, ocItems, { data: diasList }] =
      await Promise.all([
        countsRpcPromise,
        pedidosQuery,
        empresasPromise,
        galpoesPromise,
        activeGalpaoId ? fetchOcItems() : Promise.resolve([]),
        diasQuery,
      ]);

    if (pedidosError) {
      logger.error("separacao-list", "Failed to fetch pedidos", {
        error: pedidosError.message,
      });
      return NextResponse.json(
        { error: pedidosError.message },
        { status: 500 },
      );
    }

    // Build raw counts from the RPC (jsonb {status: count}); fallback ao caminho
    // legado (9 HEAD-counts) se a RPC falhar — comportamento final idêntico.
    let rawCounts: SeparacaoCounts;
    if (countsRpc.error) {
      logger.warn("separacao-list", "RPC counts falhou — fallback legado", {
        error: countsRpc.error.message,
      });
      const legacy = await legacyCounts();
      rawCounts = {
        aguardando_compra: legacy[0].count ?? 0,
        aguardando_nf: legacy[1].count ?? 0,
        validacao_oc: legacy[2].count ?? 0,
        aguardando_separacao: legacy[3].count ?? 0,
        em_separacao: legacy[4].count ?? 0,
        separado: legacy[5].count ?? 0,
        embalado: legacy[6].count ?? 0,
        conferido: legacy[7].count ?? 0,
        pendente_realocacao: legacy[8].count ?? 0,
      };
    } else {
      const d = (countsRpc.data ?? {}) as Record<string, number>;
      rawCounts = {
        aguardando_compra: Number(d.aguardando_compra ?? 0),
        aguardando_nf: Number(d.aguardando_nf ?? 0),
        validacao_oc: Number(d.validacao_oc ?? 0),
        aguardando_separacao: Number(d.aguardando_separacao ?? 0),
        em_separacao: Number(d.em_separacao ?? 0),
        separado: Number(d.separado ?? 0),
        embalado: Number(d.embalado ?? 0),
        conferido: Number(d.conferido ?? 0),
        pendente_realocacao: Number(d.pendente_realocacao ?? 0),
      };
    }

    // For aguardando_compra with active galpão: compute filtered count from item SKUs
    let aguardandoCompraCount = rawCounts.aguardando_compra;
    if (activeGalpaoId && ocItems.length > 0) {
      const activeGalpao = (galpoesList ?? []).find((g) => g.id === activeGalpaoId);
      const galpaoNome = activeGalpao?.nome ?? null;
      if (galpaoNome) {
        const pedidoSkus = new Map<string, string[]>();
        for (const item of ocItems) {
          const list = pedidoSkus.get(item.pedido_id) ?? [];
          list.push(item.sku);
          pedidoSkus.set(item.pedido_id, list);
        }
        let filtered = 0;
        for (const [, skus] of pedidoSkus) {
          if (skus.some((sku) => getFornecedorBySku(sku).filialOC === galpaoNome)) {
            filtered++;
          }
        }
        aguardandoCompraCount = filtered;
      }
    }

    const counts: SeparacaoCounts = {
      ...rawCounts,
      aguardando_compra: aguardandoCompraCount,
    };

    // Pista futura: separa o count de "separado" em ainda-a-encaixotar (fila real)
    // vs já-encaixotado (aba Encaixotados). encaixotado_em não é status, então a
    // RPC de counts não distingue — 1 HEAD-count extra (só na futura) resolve.
    let encaixotadoCount = 0;
    if (futura) {
      let eq = supabase
        .from("siso_pedidos")
        .select("*", { count: "exact", head: true })
        .eq("separacao_futura", true)
        .eq("status_separacao", "separado")
        .not("encaixotado_em", "is", null);
      if (activeGalpaoId) eq = eq.eq("separacao_galpao_id", activeGalpaoId);
      if (empresaIds.length === 1) eq = eq.eq("empresa_origem_id", empresaIds[0]);
      else if (empresaIds.length > 1) eq = eq.in("empresa_origem_id", empresaIds);
      if (marketplaceFilter) eq = eq.ilike("nome_ecommerce", `%${marketplaceFilter}%`);
      eq = applyBuscaFilter(eq);
      eq = applyPrazoFilter(eq);
      if (tagList.length) eq = eq.overlaps("separacao_tags", tagList);
      const { count } = await eq;
      encaixotadoCount = count ?? 0;
      // "Separados" passa a contar só o que falta encaixotar.
      counts.separado = Math.max(0, counts.separado - encaixotadoCount);
    }

    // Count da aba Cancelados (status='cancelado', sem status_separacao/futura).
    // Mesmos filtros do toolbar (galpão/empresa/marketplace/busca/tag).
    let canceladoCount = 0;
    {
      let cq = supabase
        .from("siso_pedidos")
        .select("*", { count: "exact", head: true })
        .eq("status", "cancelado");
      if (activeGalpaoId) cq = cq.eq("separacao_galpao_id", activeGalpaoId);
      if (empresaIds.length === 1) cq = cq.eq("empresa_origem_id", empresaIds[0]);
      else if (empresaIds.length > 1) cq = cq.in("empresa_origem_id", empresaIds);
      if (marketplaceFilter) cq = cq.ilike("nome_ecommerce", `%${marketplaceFilter}%`);
      cq = applyBuscaFilter(cq);
      if (tagList.length) cq = cq.overlaps("separacao_tags", tagList);
      const { count } = await cq;
      canceladoCount = count ?? 0;
    }

    // 3. Fetch item stats for progress display (separation + packing counts)
    const pedidoIds = (pedidos ?? []).map((p) => p.id);
    const itemStats: Record<
      string,
      { total: number; pecas: number; marcados: number; bipados: number }
    > = {};
    // Compra stats per pedido (for aguardando_compra tab)
    const compraStats: Record<
      string,
      {
        total: number;
        aguardando: number;
        comprado: number;
        recebido: number;
        indisponivel: number;
        equivalente_pendente: number;
        cancelamento_pendente: number;
        oc_pendente: number;
        itens: Array<{
          sku: string;
          descricao: string;
          quantidade: number;
          compra_status: string | null;
          fornecedor_oc: string | null;
          imagem_url: string | null;
        }>;
      }
    > = {};

    if (pedidoIds.length > 0) {
      const { data: items } = await supabase
        .from("siso_pedido_itens")
        .select("pedido_id, separacao_marcado, bipado_completo, compra_status, fornecedor_oc, sku, descricao, quantidade_pedida, compra_quantidade_solicitada, imagem_url")
        .in("pedido_id", pedidoIds);

      for (const item of items ?? []) {
        if (item.compra_status === "cancelado" || item.compra_status === "indisponivel") continue;

        if (!itemStats[item.pedido_id]) {
          itemStats[item.pedido_id] = { total: 0, pecas: 0, marcados: 0, bipados: 0 };
        }
        itemStats[item.pedido_id].total++;
        itemStats[item.pedido_id].pecas += Number(item.quantidade_pedida ?? 0);
        if (item.separacao_marcado) itemStats[item.pedido_id].marcados++;
        if (item.bipado_completo) itemStats[item.pedido_id].bipados++;

        // Build compra stats for OC orders
        if (item.compra_status) {
          if (!compraStats[item.pedido_id]) {
            compraStats[item.pedido_id] = {
              total: 0,
              aguardando: 0,
              comprado: 0,
              recebido: 0,
              indisponivel: 0,
              equivalente_pendente: 0,
              cancelamento_pendente: 0,
              oc_pendente: 0,
              itens: [],
            };
          }
          const cs = compraStats[item.pedido_id];
          cs.total++;
          if (item.compra_status === "aguardando_compra") cs.aguardando++;
          else if (item.compra_status === "comprado") cs.comprado++;
          else if (item.compra_status === "recebido") cs.recebido++;
          else if (item.compra_status === "indisponivel") cs.indisponivel++;
          else if (item.compra_status === "equivalente_pendente") cs.equivalente_pendente++;
          else if (item.compra_status === "cancelamento_pendente") cs.cancelamento_pendente++;
          else if (item.compra_status === "oc_pendente") cs.oc_pendente++;
          cs.itens.push({
            sku: item.sku,
            descricao: item.descricao,
            quantidade:
              Number(item.compra_quantidade_solicitada ?? 0) > 0
                ? item.compra_quantidade_solicitada
                : item.quantidade_pedida,
            compra_status: item.compra_status,
            fornecedor_oc: item.fornecedor_oc,
            imagem_url: item.imagem_url ?? null,
          });
        }
      }
    }

    // Shape response
    const result = (pedidos ?? []).map((p) => {
      const empresa = p.siso_empresas as unknown as { nome: string } | null;
      const stats = itemStats[p.id] ?? { total: 0, pecas: 0, marcados: 0, bipados: 0 };
      const cs = compraStats[p.id] ?? null;
      return {
        id: p.id,
        numero_nf: p.numero,
        numero_ec: p.id_pedido_ecommerce,
        numero_pedido: p.numero,
        cliente: p.cliente_nome,
        nome_ecommerce: p.nome_ecommerce ?? null,
        uf: null,
        cidade: null,
        forma_envio: p.forma_envio_descricao,
        data_pedido: p.data,
        prazo_envio: p.prazo_envio ?? null,
        embalagem_concluida_em: p.embalagem_concluida_em ?? null,
        empresa_origem_nome: empresa?.nome ?? null,
        filial_origem: p.filial_origem ?? null,
        galpao_id: p.separacao_galpao_id ?? null,
        decisao_final: p.decisao_final ?? null,
        status_separacao: p.status_separacao,
        marcadores: p.marcadores ?? [],
        separacao_tags: p.separacao_tags ?? [],
        total_itens: stats.total,
        total_pecas: stats.pecas,
        itens_marcados: stats.marcados,
        itens_bipados: stats.bipados,
        compra_stats: cs,
        etiqueta_status: p.etiqueta_status ?? null,
        etiqueta_pronta: !!p.etiqueta_zpl,
        nf_emitida: !!p.nota_fiscal_id,
        agrupamento_criado: !!p.agrupamento_expedicao_id && p.agrupamento_expedicao_id !== "pending",
        encaminhado_de: p.encaminhado_de ?? null,
        motivo_cancelamento: p.motivo_cancelamento ?? null,
        cancelado_origem: p.cancelado_origem ?? null,
        cancelado_em: p.cancelado_em ?? null,
      };
    });

    // Filter aguardando_compra pedidos by supplier destination galpão
    let filteredResult = result;
    if (activeGalpaoId && isAguardandoCompraOnly) {
      const activeGalpao = (galpoesList ?? []).find((g) => g.id === activeGalpaoId);
      const activeGalpaoNome = activeGalpao?.nome ?? null;

      if (activeGalpaoNome) {
        filteredResult = result.filter((p) => {
          const cs = p.compra_stats;
          if (!cs || cs.itens.length === 0) return true;
          return cs.itens.some((item) => getFornecedorBySku(item.sku).filialOC === activeGalpaoNome);
        });
      }
    }

    // Build empresas dropdown from pedidos visible to the active separation galpão
    const empresasMap = new Map<string, string>();
    for (const row of empresasList ?? []) {
      const empresaId = row.empresa_origem_id;
      const empresa = row.siso_empresas as unknown as
        | { id: string; nome: string }
        | { id: string; nome: string }[]
        | null;
      const resolvedEmpresa = Array.isArray(empresa) ? (empresa[0] ?? null) : empresa;

      if (empresaId && resolvedEmpresa?.nome) {
        empresasMap.set(empresaId, resolvedEmpresa.nome);
      }
    }
    const empresas = Array.from(empresasMap.entries())
      .map(([id, nome]) => ({ id, nome }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

    // Dias de prazo disponíveis (facet do multi-select), agrupados no fuso SP.
    const prazoDiasDisponiveis = agruparPedidosPorDiaSp(
      (diasList ?? []) as { prazo_envio: string | null }[],
    );

    return NextResponse.json({
      counts: { ...counts, encaixotado: encaixotadoCount, cancelado: canceladoCount },
      pedidos: filteredResult,
      empresas,
      galpoes: galpoesList ?? [],
      prazoDias: prazoDiasDisponiveis,
    });
  } catch (err) {
    logger.error("separacao-list", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
