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
import { calcularNecessidadeLiquida, piorStatusCobertura } from "@/lib/compras-necessidade";
import type { StatusCobertura } from "@/lib/wms/cobertura";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { userCan, userCanAny } from "@/lib/permissions";
import {
  mergeReceberDocs,
  type OcDoc,
  type ManualDoc,
  type ReceberDoc,
  type ReceberFornecedorGrupo,
} from "@/lib/wms/compras-receber-merge";
import { listarComprasManuais } from "@/lib/wms/compras-manuais";

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
  giro_diario: number;
  dias_cobertura: number | null;
  status_cobertura: StatusCobertura;
  lead_time_medio: number | null;
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

const VALID_TABS = ["comprar", "receber", "historico", "counts", "pendentes", "recebidos"] as const;

export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
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

  // Operador de doca (só operacoes.receber) pode consultar a fila de
  // recebimento e os counts; o resto do módulo continua exigindo compras.ver.
  const podeVer =
    tab === "receber" || tab === "counts"
      ? userCanAny(session, "compras.ver", "operacoes.receber")
      : userCan(session, "compras.ver");
  if (!podeVer) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();

  try {
    const counts = await fetchCounts(supabase);

    if (tab === "counts") {
      return NextResponse.json({ counts });
    }

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
  const [comprar, excecoes, historico, bloqueados, receberDocs, manuaisReceb] =
    await Promise.all([
      supabase
        .from("siso_pedido_itens")
        .select("id", { count: "exact", head: true })
        .eq("compra_status", "aguardando_compra"),
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
      // Receber conta DOCUMENTOS pendentes — mesma fonte/filtro da aba
      // (ocDocs + manualDocs com qty_pendente > 0), pro badge bater com a lista.
      fetchReceberDocs(supabase),
      listarComprasManuais("recebido"),
    ]);

  const pedidosUnicos = new Set(
    (bloqueados.data ?? []).map((r) => r.pedido_id),
  );

  return {
    comprar: comprar.count ?? 0,
    receber: receberDocs.ocDocs.length + receberDocs.manualDocs.length,
    excecoes: excecoes.count ?? 0,
    historico: (historico.count ?? 0) + manuaisReceb.length,
    pedidos_bloqueados: pedidosUnicos.size,
  };
}

// ─── Tab: Comprar ───────────────────────────────────────────────────────────

// ─── Contexto vivo por SKU (necessidade líquida) ──────────────────────────────

interface ContextoSku {
  demandaComprado: number; // Σ(pedida − pega) dos itens já 'comprado' (ainda precisam do SKU)
  emTransito: number; // Σ max(0, solicitada − recebida) dos itens 'comprado'
  estoqueLivre: number; // Σ siso_estoque.disponivel (ao vivo) do produto
  giroDiario: number;
  statusCobertura: StatusCobertura;
  leadTimeMedio: number | null;
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
    ctx.set(sku, {
      demandaComprado: 0,
      emTransito: 0,
      estoqueLivre: 0,
      giroDiario: 0,
      statusCobertura: "sem_giro",
      leadTimeMedio: null,
    });
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

  // 3) Giro/cobertura da MV (defasada, mas giro muda devagar — ok pra âncora).
  if (uuids.length > 0) {
    const { data: cob } = await supabase
      .from("siso_cobertura_estoque")
      .select("produto_id, giro_diario, lead_time_medio, status_cobertura")
      .in("produto_id", uuids);

    for (const r of cob ?? []) {
      const sku = skuPorUuid.get(r.produto_id as string);
      if (!sku) continue;
      const c = ctx.get(sku);
      if (!c) continue;
      c.giroDiario += Number(r.giro_diario ?? 0);
      c.statusCobertura = piorStatusCobertura(
        c.statusCobertura,
        (r.status_cobertura ?? "sem_giro") as StatusCobertura,
      );
      if (r.lead_time_medio != null) {
        c.leadTimeMedio = Math.max(c.leadTimeMedio ?? 0, Number(r.lead_time_medio));
      }
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
          giro_diario: 0,
          dias_cobertura: null,
          status_cobertura: "sem_giro",
          lead_time_medio: null,
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
      entry.giro_diario = c?.giroDiario ?? 0;
      entry.dias_cobertura =
        c && c.giroDiario > 0 ? Math.round(c.estoqueLivre / c.giroDiario) : null;
      entry.status_cobertura = c?.statusCobertura ?? "sem_giro";
      entry.lead_time_medio = c?.leadTimeMedio ?? null;
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

interface ReceberDocsResult {
  ocDocs: OcDoc[];
  manualDocs: ManualDoc[];
  /** nº de SKUs com pendência por documento (id → count), pra UI identificar o doc. */
  skusByDoc: Map<string, number>;
}

/**
 * Fonte única dos documentos pendentes de recebimento: OCs (`siso_ordens_compra`
 * status 'comprado' com pendência) + compras manuais pendentes. Usada tanto pela
 * aba Receber quanto pelo contador, pro badge bater com a lista.
 */
async function fetchReceberDocs(supabase: SupabaseClient): Promise<ReceberDocsResult> {
  const { data: ocs, error: ocErr } = await supabase
    .from("siso_ordens_compra")
    .select("id, fornecedor, galpao_id, status, created_at, siso_galpoes(nome)")
    .eq("status", "comprado")
    .order("created_at", { ascending: true });
  if (ocErr) throw new Error(`Erro ao buscar OCs: ${ocErr.message}`);

  const ocIds = (ocs ?? []).map((o) => String(o.id));
  const pendenteByOC = new Map<string, number>();
  const skusByDoc = new Map<string, number>();
  if (ocIds.length > 0) {
    // Só itens efetivamente comprados contam pendência: uma OC draft pode ter
    // itens ainda 'aguardando_compra' linkados (validar-oc-item) que não devem
    // aparecer como "a receber". Itens 'recebido' contribuem 0 de toda forma.
    const { data: itens } = await supabase
      .from("siso_pedido_itens")
      .select("ordem_compra_id, sku, compra_quantidade_solicitada, compra_quantidade_recebida")
      .in("ordem_compra_id", ocIds)
      .eq("compra_status", "comprado");
    const skusPendentes = new Map<string, Set<string>>();
    for (const it of itens ?? []) {
      const ocId = String(it.ordem_compra_id ?? "");
      if (!ocId) continue;
      const pend =
        Number(it.compra_quantidade_solicitada ?? 0) -
        Number(it.compra_quantidade_recebida ?? 0);
      if (pend > 0) {
        pendenteByOC.set(ocId, (pendenteByOC.get(ocId) ?? 0) + pend);
        if (!skusPendentes.has(ocId)) skusPendentes.set(ocId, new Set());
        skusPendentes.get(ocId)!.add(String(it.sku ?? ""));
      }
    }
    for (const [ocId, skus] of skusPendentes) skusByDoc.set(ocId, skus.size);
  }

  const ocDocs: OcDoc[] = (ocs ?? [])
    .map((oc) => ({
      id: String(oc.id),
      fornecedor: (oc.fornecedor as string | null) ?? null,
      galpao_nome: (oc.siso_galpoes as { nome?: string } | null)?.nome ?? null,
      qty_pendente: pendenteByOC.get(String(oc.id)) ?? 0,
      criado_em: (oc.created_at as string | null) ?? null,
    }))
    .filter((d) => d.qty_pendente > 0);

  const manuais = await listarComprasManuais("pendentes");

  const galpaoIds = [...new Set(manuais.map((m) => m.galpao_id).filter(Boolean))];
  const galpaoNomeById = new Map<string, string>();
  if (galpaoIds.length > 0) {
    const { data: galpoes } = await supabase
      .from("siso_galpoes")
      .select("id, nome")
      .in("id", galpaoIds);
    for (const g of galpoes ?? []) galpaoNomeById.set(String(g.id), String(g.nome));
  }

  const manualDocs: ManualDoc[] = manuais.map((m) => {
    const pend = m.itens.reduce(
      (s, it) => s + Math.max(it.qty_comprada - it.qty_recebida, 0),
      0,
    );
    const custoTotal = m.itens.reduce(
      (s, it) => s + it.qty_comprada * (it.custo_unitario ?? 0),
      0,
    );
    skusByDoc.set(
      m.id,
      m.itens.filter((it) => it.qty_comprada - it.qty_recebida > 0).length,
    );
    return {
      id: m.id,
      fornecedor: m.fornecedor?.nome ?? null,
      galpao_nome: galpaoNomeById.get(m.galpao_id) ?? null,
      qty_pendente: pend,
      criado_em: m.criado_em,
      custo_total: custoTotal,
    };
  });

  return { ocDocs, manualDocs, skusByDoc };
}

type ReceberDocOut = ReceberDoc & { skus_count: number };
type ReceberGrupoOut = Omit<ReceberFornecedorGrupo, "documentos"> & {
  documentos: ReceberDocOut[];
};

/**
 * Aba "Receber" unificada por DOCUMENTO (Fase B): cada OC (`siso_ordens_compra`)
 * + cada compra manual (`siso_compras_manuais`), agrupados por fornecedor via o
 * helper puro `mergeReceberDocs`. Substitui a agregação antiga por SKU sobre
 * `siso_pedido_itens`. Cada documento aponta pra sua page rica de recebimento.
 */
async function fetchReceber(supabase: SupabaseClient): Promise<ReceberGrupoOut[]> {
  const { ocDocs, manualDocs, skusByDoc } = await fetchReceberDocs(supabase);
  return mergeReceberDocs(ocDocs, manualDocs).map((g) => ({
    ...g,
    documentos: g.documentos.map((d) => ({
      ...d,
      skus_count: skusByDoc.get(d.id) ?? 0,
    })),
  }));
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
      origem: "oc" | "manual";
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

  type HistoricoLinha = {
    sku: string;
    descricao: string;
    quantidade_recebida: number;
    recebido_em: string | null;
    origem: "oc" | "manual";
  };

  const groups = new Map<
    string,
    {
      fornecedor: string;
      data_recebimento: string;
      itens: HistoricoLinha[];
    }
  >();

  function addLinha(
    fornecedor: string,
    recebidoEm: string | null,
    linha: HistoricoLinha,
  ) {
    const dataRecebimento = recebidoEm ? recebidoEm.substring(0, 10) : "sem-data";
    const key = `${fornecedor}||${dataRecebimento}`;
    if (!groups.has(key)) {
      groups.set(key, { fornecedor, data_recebimento: dataRecebimento, itens: [] });
    }
    groups.get(key)!.itens.push(linha);
  }

  for (const item of items ?? []) {
    const fornecedor = (item.fornecedor_oc as string) ?? "Sem fornecedor";
    addLinha(fornecedor, item.comprado_em as string | null, {
      sku: item.sku as string,
      descricao: item.descricao as string,
      quantidade_recebida: Number(item.compra_quantidade_recebida ?? 0),
      recebido_em: item.comprado_em as string | null,
      origem: "oc",
    });
  }

  // Compras manuais recebidas: incluídas SOMENTE na primeira página (cursor==null).
  // O cursor (comprado_em) pagina apenas as OCs de siso_pedido_itens; manuais não
  // têm cursor equivalente, então paginá-las junto exigiria um merge-cursor. Pra
  // o volume atual (poucos manuais), adicioná-las na 1ª página é suficiente.
  if (cursor == null) {
    const manuais = await listarComprasManuais("recebido");
    // Limitação: manuais recebidos só entram na 1ª página (cursor pagina só OC).
    for (const m of manuais) {
      const fornecedor = m.fornecedor?.nome ?? "Sem fornecedor";
      for (const it of m.itens) {
        addLinha(fornecedor, m.recebido_em, {
          sku: it.sku,
          descricao: it.descricao,
          quantidade_recebida: it.qty_recebida,
          recebido_em: m.recebido_em,
          origem: "manual",
        });
      }
    }
  }

  if (groups.size === 0) return { fornecedores: [], next_cursor: null };

  const fornecedores = [...groups.values()].sort((a, b) =>
    b.data_recebimento.localeCompare(a.data_recebimento),
  );

  // next_cursor: comprado_em do último item OC retornado pela query (não do
  // último group), pra cliente continuar a paginação a partir do próximo item.
  // Pagina SÓ OCs — manuais entram apenas na 1ª página.
  const nextCursor =
    items && items.length === limit
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
