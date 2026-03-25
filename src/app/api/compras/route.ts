import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import {
  COMPRA_EXCEPTION_STATUSES,
  hasComprasAccess,
  getAgingDays,
  getCompraQuantidadeSolicitada,
} from "@/lib/compras-utils";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

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
  quantidade_necessaria: number;
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
  if (!hasComprasAccess(session.cargos)) {
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
      const fornecedores = await fetchHistorico(supabase);
      return NextResponse.json({ counts, fornecedores });
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

async function fetchComprar(supabase: SupabaseClient): Promise<FornecedorComprarGroup[]> {
  const { data: items, error } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, quantidade_pedida, compra_status, compra_quantidade_solicitada, compra_solicitada_em, fornecedor_oc, imagem_url, pedido_id, siso_pedidos(numero, cliente_nome, criado_em)",
    )
    .eq("compra_status", "aguardando_compra");

  if (error) throw new Error(`Erro ao buscar itens para comprar: ${error.message}`);
  if (!items || items.length === 0) return [];

  const rawItems = items as unknown as RawItem[];
  const galpaoByNome = await loadGalpaoMap(supabase);

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
    const agingBase = item.siso_pedidos?.criado_em ?? item.compra_solicitada_em;
    const itemAging = getAgingDays(agingBase);

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

  const result: FornecedorComprarGroup[] = [];

  for (const [fornecedor, group] of fornecedorMap) {
    const itens: ComprarSkuEntry[] = [];

    for (const [, { entry }] of group.skuMap) {
      entry.pedidos.sort((a, b) => b.aging_dias - a.aging_dias);
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

  // Auto-fix: items that are fully received but stuck as "comprado"
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
    await supabase
      .from("siso_pedido_itens")
      .update({ compra_status: "recebido" })
      .in("id", stuckIds);
    logger.info("compras-api", "Auto-fix: itens sobre-recebidos marcados como recebido", {
      count: stuckIds.length,
      ids: stuckIds,
    });
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
      aging_dias: getAgingDays(pedido?.criado_em ?? (item.compra_solicitada_em as string | null)),
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

async function fetchHistorico(supabase: SupabaseClient) {
  const { data: items, error } = await supabase
    .from("siso_pedido_itens")
    .select(
      "sku, descricao, compra_quantidade_recebida, comprado_em, fornecedor_oc",
    )
    .eq("compra_status", "recebido")
    .not("compra_quantidade_recebida", "is", null)
    .order("comprado_em", { ascending: false })
    .limit(500);

  if (error) throw new Error(`Erro ao buscar itens recebidos: ${error.message}`);
  if (!items || items.length === 0) return [];

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

  return [...groups.values()].sort((a, b) =>
    b.data_recebimento.localeCompare(a.data_recebimento),
  );
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
