import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import {
  COMPRA_EXCEPTION_STATUSES,
  getAgingDays,
  getCompraQuantidadeRestante,
  getCompraQuantidadeSolicitada,
} from "@/lib/compras-utils";
import { calcularNecessidadeLiquida } from "@/lib/compras-necessidade";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { userCan } from "@/lib/permissions";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PedidoRef {
  pedido_id: string;
  numero: string;
  cliente_nome: string;
  quantidade: number;
  aging_dias: number;
  item_id: string;
}

interface ComprarSkuEntry {
  sku: string;
  descricao: string;
  imagem_url: string | null;
  /** Número VIVO: max(0, demanda_aberta − estoque_livre − em_transito). */
  quantidade_necessaria: number;
  // Quebra pra transparência do comprador (PR-necessidade-viva 2026-05-29):
  demanda_aberta: number;
  estoque_livre: number;
  em_transito: number;
  aging_dias: number;
  pedidos: PedidoRef[];
}

interface FornecedorComprarGroup {
  fornecedor: string;
  galpao_sugerido_id: string | null;
  galpao_sugerido_nome: string | null;
  skus_count: number;
  pedidos_bloqueados: number;
  aging_dias: number;
  itens: ComprarSkuEntry[];
}

interface ReceberSkuEntry {
  sku: string;
  descricao: string;
  imagem_url: string | null;
  quantidade_comprada: number;
  quantidade_recebida: number;
  quantidade_pendente: number;
  // [Fix-D #3.5] Excesso recebido vs comprado (max(recebida - comprada, 0)).
  // Surfacing pra alertar fornecedor mandou a mais / contagem errada / ajuste
  // manual posterior. Backend já tem `getCompraQuantidadeRestante` retornando
  // negativo, mas o agregado por SKU é computado localmente aqui.
  quantidade_excedente: number;
  aging_dias: number;
  comprado_em: string | null;
  pedidos: PedidoRef[];
}

interface FornecedorReceberGroup {
  fornecedor: string;
  galpao_sugerido_nome: string | null;
  skus_count: number;
  pendente_count: number;
  aging_dias: number;
  itens: ReceberSkuEntry[];
}

interface ExcecaoItem {
  id: string;
  sku: string;
  descricao: string;
  imagem_url: string | null;
  compra_status: string;
  quantidade: number;
  aging_dias: number;
  fornecedor_oc: string | null;
  pedido_id: string;
  numero_pedido: string;
  compra_equivalente_sku: string | null;
  compra_equivalente_descricao: string | null;
  compra_equivalente_fornecedor: string | null;
  compra_equivalente_observacao: string | null;
  compra_cancelamento_motivo: string | null;
}

interface RawItem {
  id: string;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
  quantidade_pega: number | null;
  compra_status: string;
  compra_quantidade_solicitada: number | null;
  compra_quantidade_recebida: number | null;
  compra_quantidade_comprada: number | null;
  compra_solicitada_em: string | null;
  comprado_em: string | null;
  fornecedor_oc: string | null;
  imagem_url: string | null;
  pedido_id: string;
  siso_pedidos: {
    numero: string;
    cliente_nome: string;
    criado_em: string;
  } | null;
}

type SupabaseClient = ReturnType<typeof createServiceClient>;

// ─── GET /api/compras ───────────────────────────────────────────────────────

const VALID_TABS = ["comprar", "receber", "historico", "pendentes", "recebidos"] as const;

export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "compras.ver")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  let tab = searchParams.get("tab") ?? "comprar";

  // Backwards compat
  if (tab === "pendentes") tab = "comprar";
  if (tab === "recebidos") tab = "historico";

  if (!VALID_TABS.includes(tab as (typeof VALID_TABS)[number])) {
    return NextResponse.json(
      { error: "Tab inválida. Use: comprar, receber, historico" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    const counts = await fetchCounts(supabase);

    if (tab === "historico") {
      const cursorRaw = searchParams.get("cursor");
      const cursorValid =
        cursorRaw && !Number.isNaN(Date.parse(cursorRaw)) ? cursorRaw : null;
      const limit = Math.min(
        200,
        Math.max(1, parseInt(searchParams.get("limit") ?? "100", 10)),
      );
      const { fornecedores, next_cursor } = await fetchHistorico(
        supabase,
        cursorValid,
        limit,
      );
      return NextResponse.json({ counts, fornecedores, next_cursor });
    }

    if (tab === "receber") {
      const fornecedores = await fetchReceber(supabase);
      return NextResponse.json({ counts, fornecedores });
    }

    // tab === "comprar"
    const [fornecedores, excecoes] = await Promise.all([
      fetchComprar(supabase),
      fetchExcecoes(supabase),
    ]);
    return NextResponse.json({ counts, fornecedores, excecoes });
  } catch (err) {
    logger.error("compras-api", "Erro ao buscar compras", {
      error: err instanceof Error ? err.message : String(err),
      tab,
    });
    return NextResponse.json(
      { error: "Erro interno ao buscar compras" },
      { status: 500 },
    );
  }
}

// ─── Counts ─────────────────────────────────────────────────────────────────

async function fetchCounts(supabase: SupabaseClient) {
  const [comprar, receber, excecoes, historico, bloqueados] = await Promise.all([
    supabase
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .eq("compra_status", "aguardando_compra"),
    supabase
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .eq("compra_status", "comprado"),
    supabase
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .in("compra_status", [...COMPRA_EXCEPTION_STATUSES]),
    supabase
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .eq("compra_status", "recebido"),
    supabase
      .from("siso_pedido_itens")
      .select("pedido_id")
      .in("compra_status", ["aguardando_compra", "comprado"]),
  ]);

  const pedidosUnicos = new Set(
    (bloqueados.data ?? []).map((r) => r.pedido_id),
  );

  return {
    comprar: comprar.count ?? 0,
    receber: receber.count ?? 0,
    excecoes: excecoes.count ?? 0,
    historico: historico.count ?? 0,
    pedidos_bloqueados: pedidosUnicos.size,
  };
}

// ─── Tab: Comprar ───────────────────────────────────────────────────────────

// ─── Contexto vivo por SKU (necessidade líquida) ──────────────────────────────

interface ContextoSku {
  demandaComprado: number; // Σ(pedida − pega) dos itens já 'comprado' (ainda precisam do SKU)
  emTransito: number; // Σ max(0, solicitada − recebida) dos itens 'comprado'
  estoqueLivre: number; // Σ siso_estoque.disponivel (ao vivo) do produto
}

/**
 * Carrega, por SKU, os números VIVOS usados pra calcular a necessidade líquida:
 * demanda dos pedidos já comprados (ainda não recebidos), o que está em trânsito,
 * e o estoque livre atual lido direto de siso_estoque (não a MV de cobertura,
 * que é defasada). Chave = sku (UNIQUE em siso_produtos), evitando o legado
 * produto_id=tiny_produto_id em siso_pedido_itens.
 */
async function carregarContextoNecessidade(
  supabase: SupabaseClient,
  skus: string[],
): Promise<Map<string, ContextoSku>> {
  const ctx = new Map<string, ContextoSku>();
  for (const sku of skus) {
    ctx.set(sku, { demandaComprado: 0, emTransito: 0, estoqueLivre: 0 });
  }
  if (skus.length === 0) return ctx;

  // 1) Itens já COMPRADOS (a caminho): contam como demanda E como em-trânsito.
  const { data: comprados } = await supabase
    .from("siso_pedido_itens")
    .select(
      "sku, quantidade_pedida, quantidade_pega, compra_quantidade_solicitada, compra_quantidade_recebida, compra_status",
    )
    .eq("compra_status", "comprado")
    .in("sku", skus);

  for (const it of comprados ?? []) {
    const c = ctx.get(it.sku as string);
    if (!c) continue;
    const residual = Math.max(
      0,
      Number(it.quantidade_pedida ?? 0) - Number(it.quantidade_pega ?? 0),
    );
    c.demandaComprado += residual;
    c.emTransito += Math.max(0, getCompraQuantidadeRestante(it));
  }

  // 2) Estoque livre AO VIVO por SKU: sku → siso_produtos.id → Σ siso_estoque.disponivel.
  const { data: produtos } = await supabase
    .from("siso_produtos")
    .select("id, sku")
    .in("sku", skus);

  const skuPorUuid = new Map<string, string>();
  const uuids: string[] = [];
  for (const p of produtos ?? []) {
    skuPorUuid.set(p.id as string, p.sku as string);
    uuids.push(p.id as string);
  }

  if (uuids.length > 0) {
    const { data: saldos } = await supabase
      .from("siso_estoque")
      .select("produto_id, disponivel")
      .in("produto_id", uuids);

    for (const s of saldos ?? []) {
      const sku = skuPorUuid.get(s.produto_id as string);
      if (!sku) continue;
      const c = ctx.get(sku);
      if (c) c.estoqueLivre += Number(s.disponivel ?? 0);
    }
  }

  return ctx;
}

async function fetchComprar(supabase: SupabaseClient): Promise<FornecedorComprarGroup[]> {
  const { data: items, error } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, quantidade_pedida, quantidade_pega, compra_status, compra_quantidade_solicitada, compra_solicitada_em, fornecedor_oc, imagem_url, pedido_id, siso_pedidos(numero, cliente_nome, criado_em)",
    )
    .eq("compra_status", "aguardando_compra");

  if (error) throw new Error(`Erro ao buscar itens para comprar: ${error.message}`);
  if (!items || items.length === 0) return [];

  const rawItems = items as unknown as RawItem[];
  const galpaoByNome = await loadGalpaoMap(supabase);

  // Demanda residual dos itens AINDA em aguardando_compra (pedida − pega), por SKU.
  const demandaAgPorSku = new Map<string, number>();
  const todosSkus = new Set<string>();

  const fornecedorMap = new Map<
    string,
    {
      skuMap: Map<string, { entry: ComprarSkuEntry; pedidoIds: Set<string> }>;
      allPedidoIds: Set<string>;
      oldestAging: number;
    }
  >();

  for (const item of rawItems) {
    const fornecedor = item.fornecedor_oc ?? "Sem fornecedor";
    const qtySolicitada = getCompraQuantidadeSolicitada(item);
    // Fase 3 #4: tempo de espera = desde quando a compra foi SOLICITADA
    // (compra_solicitada_em), não desde a criação do pedido. Fallback defensivo
    // pro criado_em caso a solicitada esteja nula.
    const agingBase = item.compra_solicitada_em ?? item.siso_pedidos?.criado_em;
    const itemAging = getAgingDays(agingBase);

    todosSkus.add(item.sku);
    const residualAg = Math.max(
      0,
      Number(item.quantidade_pedida ?? 0) - Number(item.quantidade_pega ?? 0),
    );
    demandaAgPorSku.set(item.sku, (demandaAgPorSku.get(item.sku) ?? 0) + residualAg);

    if (!fornecedorMap.has(fornecedor)) {
      fornecedorMap.set(fornecedor, {
        skuMap: new Map(),
        allPedidoIds: new Set(),
        oldestAging: 0,
      });
    }

    const group = fornecedorMap.get(fornecedor)!;
    group.allPedidoIds.add(item.pedido_id);
    group.oldestAging = Math.max(group.oldestAging, itemAging);

    const pedidoRef: PedidoRef = {
      pedido_id: item.pedido_id,
      numero: item.siso_pedidos?.numero ?? "?",
      cliente_nome: item.siso_pedidos?.cliente_nome ?? "?",
      quantidade: qtySolicitada,
      aging_dias: getAgingDays(item.siso_pedidos?.criado_em),
      item_id: String(item.id),
    };

    if (!group.skuMap.has(item.sku)) {
      group.skuMap.set(item.sku, {
        entry: {
          sku: item.sku,
          descricao: item.descricao,
          imagem_url: item.imagem_url,
          quantidade_necessaria: 0,
          demanda_aberta: 0,
          estoque_livre: 0,
          em_transito: 0,
          aging_dias: 0,
          pedidos: [],
        },
        pedidoIds: new Set(),
      });
    }

    const skuData = group.skuMap.get(item.sku)!;
    skuData.entry.quantidade_necessaria += qtySolicitada;
    skuData.entry.aging_dias = Math.max(skuData.entry.aging_dias, itemAging);
    skuData.entry.pedidos.push(pedidoRef);
    skuData.pedidoIds.add(item.pedido_id);
  }

  const ctx = await carregarContextoNecessidade(supabase, [...todosSkus]);

  const result: FornecedorComprarGroup[] = [];

  for (const [fornecedor, group] of fornecedorMap) {
    const itens: ComprarSkuEntry[] = [];

    for (const [, { entry }] of group.skuMap) {
      entry.pedidos.sort((a, b) => b.aging_dias - a.aging_dias);
      const c = ctx.get(entry.sku);
      const demandaAberta =
        (demandaAgPorSku.get(entry.sku) ?? 0) + (c?.demandaComprado ?? 0);
      const res = calcularNecessidadeLiquida({
        demandaAberta,
        estoqueLivre: c?.estoqueLivre ?? 0,
        emTransito: c?.emTransito ?? 0,
      });
      entry.quantidade_necessaria = res.necessidadeLiquida;
      entry.demanda_aberta = res.demandaAberta;
      entry.estoque_livre = res.estoqueLivre;
      entry.em_transito = res.emTransito;
      itens.push(entry);
    }

    itens.sort((a, b) => b.aging_dias - a.aging_dias);

    const firstSku = itens[0]?.sku;
    const skuInfo = firstSku ? getFornecedorBySku(firstSku) : null;
    const galpaoNome = skuInfo?.filialOC ?? null;
    const galpaoId = galpaoNome ? (galpaoByNome.get(galpaoNome) ?? null) : null;

    result.push({
      fornecedor,
      galpao_sugerido_id: galpaoId,
      galpao_sugerido_nome: galpaoNome,
      skus_count: itens.length,
      pedidos_bloqueados: group.allPedidoIds.size,
      aging_dias: group.oldestAging,
      itens,
    });
  }

  result.sort(
    (a, b) =>
      b.pedidos_bloqueados - a.pedidos_bloqueados ||
      b.aging_dias - a.aging_dias ||
      a.fornecedor.localeCompare(b.fornecedor, "pt-BR"),
  );

  return result;
}

// ─── Tab: Receber ───────────────────────────────────────────────────────────

async function fetchReceber(supabase: SupabaseClient): Promise<FornecedorReceberGroup[]> {
  const { data: items, error } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, quantidade_pedida, compra_status, compra_quantidade_solicitada, compra_quantidade_recebida, compra_quantidade_comprada, comprado_em, fornecedor_oc, imagem_url, pedido_id, siso_pedidos(numero, cliente_nome, criado_em)",
    )
    .eq("compra_status", "comprado");

  if (error) throw new Error(`Erro ao buscar itens para receber: ${error.message}`);
  if (!items || items.length === 0) return [];

  // Diagnóstico: itens cuja qty recebida >= solicitada mas status segue 'comprado'.
  // ANTES (auto-fix): GET silenciosamente promovia esses itens pra 'recebido' e disparava
  // checkAndReleasePedidos. Removido em 2026-05-27 [#P6-6.31 #P6-3.12]: GET deve ser puro.
  // Inconsistência real é tarefa do receber endpoint ou de um job manual — não de leitura.
  // Itens sobre-recebidos seguem filtrados da listagem (UX), apenas não são auto-promovidos.
  const stuckIds: string[] = [];
  const activeItems: typeof items = [];

  for (const item of items) {
    const solicitada = Number(item.compra_quantidade_solicitada ?? 0) || Number(item.quantidade_pedida ?? 0);
    const recebida = Number(item.compra_quantidade_recebida ?? 0);
    if (recebida >= solicitada && solicitada > 0) {
      stuckIds.push(String(item.id));
    } else {
      activeItems.push(item);
    }
  }

  if (stuckIds.length > 0) {
    logger.warn(
      "compras.tab-receber",
      "inconsistências detectadas em GET (itens sobre-recebidos ainda em status='comprado')",
      {
        count: stuckIds.length,
        sample_ids: stuckIds.slice(0, 10),
      },
    );
  }

  if (activeItems.length === 0) return [];

  const rawItems = activeItems as unknown as RawItem[];

  const fornecedorMap = new Map<
    string,
    {
      skuMap: Map<string, { entry: ReceberSkuEntry; pedidoIds: Set<string> }>;
      oldestAging: number;
      galpaoNome: string | null;
    }
  >();

  for (const item of rawItems) {
    const fornecedor = item.fornecedor_oc ?? "Sem fornecedor";
    const qtySolicitada = getCompraQuantidadeSolicitada(item);
    const qtyRecebida = Number(item.compra_quantidade_recebida ?? 0);
    const qtyComprada = item.compra_quantidade_comprada
      ? Number(item.compra_quantidade_comprada)
      : qtySolicitada;
    const itemAging = getAgingDays(item.comprado_em);

    if (!fornecedorMap.has(fornecedor)) {
      const skuInfo = getFornecedorBySku(item.sku);
      fornecedorMap.set(fornecedor, {
        skuMap: new Map(),
        oldestAging: 0,
        galpaoNome: skuInfo?.filialOC ?? null,
      });
    }

    const group = fornecedorMap.get(fornecedor)!;
    group.oldestAging = Math.max(group.oldestAging, itemAging);

    const pedidoRef: PedidoRef = {
      pedido_id: item.pedido_id,
      numero: item.siso_pedidos?.numero ?? "?",
      cliente_nome: item.siso_pedidos?.cliente_nome ?? "?",
      quantidade: qtySolicitada,
      aging_dias: getAgingDays(item.siso_pedidos?.criado_em),
      item_id: String(item.id),
    };

    if (!group.skuMap.has(item.sku)) {
      group.skuMap.set(item.sku, {
        entry: {
          sku: item.sku,
          descricao: item.descricao,
          imagem_url: item.imagem_url,
          quantidade_comprada: 0,
          quantidade_recebida: 0,
          quantidade_pendente: 0,
          quantidade_excedente: 0,
          aging_dias: 0,
          comprado_em: null,
          pedidos: [],
        },
        pedidoIds: new Set(),
      });
    }

    const skuData = group.skuMap.get(item.sku)!;
    skuData.entry.quantidade_comprada += qtyComprada;
    skuData.entry.quantidade_recebida += qtyRecebida;
    skuData.entry.aging_dias = Math.max(skuData.entry.aging_dias, itemAging);
    skuData.entry.comprado_em = skuData.entry.comprado_em ?? item.comprado_em;
    skuData.entry.pedidos.push(pedidoRef);
    skuData.pedidoIds.add(item.pedido_id);
  }

  const result: FornecedorReceberGroup[] = [];

  for (const [fornecedor, group] of fornecedorMap) {
    const itens: ReceberSkuEntry[] = [];
    let pendenteCount = 0;

    for (const [, { entry }] of group.skuMap) {
      entry.quantidade_pendente = Math.max(
        entry.quantidade_comprada - entry.quantidade_recebida,
        0,
      );
      entry.quantidade_excedente = Math.max(
        entry.quantidade_recebida - entry.quantidade_comprada,
        0,
      );
      entry.pedidos.sort((a, b) => b.aging_dias - a.aging_dias);
      itens.push(entry);
      if (entry.quantidade_pendente > 0) pendenteCount++;
    }

    itens.sort((a, b) => b.aging_dias - a.aging_dias);

    result.push({
      fornecedor,
      galpao_sugerido_nome: group.galpaoNome,
      skus_count: itens.length,
      pendente_count: pendenteCount,
      aging_dias: group.oldestAging,
      itens,
    });
  }

  result.sort(
    (a, b) =>
      b.aging_dias - a.aging_dias ||
      a.fornecedor.localeCompare(b.fornecedor, "pt-BR"),
  );

  return result;
}

// ─── Excecoes ───────────────────────────────────────────────────────────────

async function fetchExcecoes(supabase: SupabaseClient): Promise<ExcecaoItem[]> {
  const { data: items, error } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, imagem_url, compra_status, quantidade_pedida, compra_quantidade_solicitada, compra_solicitada_em, fornecedor_oc, pedido_id, compra_equivalente_sku, compra_equivalente_descricao, compra_equivalente_fornecedor, compra_equivalente_observacao, compra_cancelamento_motivo, siso_pedidos(numero, criado_em)",
    )
    .in("compra_status", [...COMPRA_EXCEPTION_STATUSES])
    .order("compra_solicitada_em", { ascending: true });

  if (error) throw new Error(`Erro ao buscar exceções: ${error.message}`);
  if (!items || items.length === 0) return [];

  return items.map((item) => {
    const pedido = item.siso_pedidos as { numero?: string; criado_em?: string } | null;
    const qty = getCompraQuantidadeSolicitada(item as unknown as RawItem);
    return {
      id: String(item.id),
      sku: item.sku as string,
      descricao: item.descricao as string,
      imagem_url: item.imagem_url as string | null,
      compra_status: item.compra_status as string,
      quantidade: qty,
      aging_dias: getAgingDays((item.compra_solicitada_em as string | null) ?? pedido?.criado_em ?? null),
      fornecedor_oc: item.fornecedor_oc as string | null,
      pedido_id: item.pedido_id as string,
      numero_pedido: pedido?.numero ?? "?",
      compra_equivalente_sku: item.compra_equivalente_sku as string | null,
      compra_equivalente_descricao: item.compra_equivalente_descricao as string | null,
      compra_equivalente_fornecedor: item.compra_equivalente_fornecedor as string | null,
      compra_equivalente_observacao: item.compra_equivalente_observacao as string | null,
      compra_cancelamento_motivo: item.compra_cancelamento_motivo as string | null,
    };
  });
}

// ─── Tab: Historico (Recebidos) ─────────────────────────────────────────────

async function fetchHistorico(
  supabase: SupabaseClient,
  cursor: string | null,
  limit: number,
): Promise<{
  fornecedores: Array<{
    fornecedor: string;
    data_recebimento: string;
    itens: Array<{
      sku: string;
      descricao: string;
      quantidade_recebida: number;
      recebido_em: string | null;
    }>;
  }>;
  next_cursor: string | null;
}> {
  let query = supabase
    .from("siso_pedido_itens")
    .select(
      "sku, descricao, compra_quantidade_recebida, comprado_em, fornecedor_oc",
    )
    .eq("compra_status", "recebido")
    .not("compra_quantidade_recebida", "is", null)
    .order("comprado_em", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("comprado_em", cursor);
  }

  const { data: items, error } = await query;

  if (error) throw new Error(`Erro ao buscar itens recebidos: ${error.message}`);
  if (!items || items.length === 0) return { fornecedores: [], next_cursor: null };

  const groups = new Map<
    string,
    {
      fornecedor: string;
      data_recebimento: string;
      itens: Array<{
        sku: string;
        descricao: string;
        quantidade_recebida: number;
        recebido_em: string | null;
      }>;
    }
  >();

  for (const item of items) {
    const fornecedor = (item.fornecedor_oc as string) ?? "Sem fornecedor";
    const dataRecebimento = item.comprado_em
      ? (item.comprado_em as string).substring(0, 10)
      : "sem-data";
    const key = `${fornecedor}||${dataRecebimento}`;

    if (!groups.has(key)) {
      groups.set(key, { fornecedor, data_recebimento: dataRecebimento, itens: [] });
    }

    groups.get(key)!.itens.push({
      sku: item.sku as string,
      descricao: item.descricao as string,
      quantidade_recebida: Number(item.compra_quantidade_recebida ?? 0),
      recebido_em: item.comprado_em as string | null,
    });
  }

  const fornecedores = [...groups.values()].sort((a, b) =>
    b.data_recebimento.localeCompare(a.data_recebimento),
  );

  // next_cursor: comprado_em do último item retornado pela query (não do último
  // group), pra cliente continuar a paginação a partir do próximo item.
  const nextCursor =
    items.length === limit
      ? ((items[items.length - 1].comprado_em as string | null) ?? null)
      : null;

  return { fornecedores, next_cursor: nextCursor };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadGalpaoMap(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data: galpoes } = await supabase
    .from("siso_galpoes")
    .select("id, nome")
    .eq("ativo", true);
  const map = new Map<string, string>();
  for (const g of galpoes ?? []) map.set(g.nome, g.id);
  return map;
}
