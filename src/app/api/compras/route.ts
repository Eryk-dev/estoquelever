import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import type { CompraItemAgrupado } from "@/types";
import { COMPRA_EXCEPTION_STATUSES } from "@/lib/compras-utils";

type CompraStatusFilter = "aguardando_compra" | "comprado" | "indisponivel" | "excecoes";

const VALID_STATUSES: CompraStatusFilter[] = [
  "aguardando_compra",
  "comprado",
  "indisponivel",
  "excecoes",
];

const ALLOWED_CARGOS = ["admin", "comprador"];

/**
 * GET /api/compras
 *
 * Returns compra items grouped by supplier and status.
 * Query params:
 *   - status: 'aguardando_compra' | 'comprado' | 'excecoes' (legacy: 'indisponivel')
 *   - cargo: user cargo for auth check
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Auth check: only admin or comprador
  const cargo = searchParams.get("cargo");
  if (cargo && !ALLOWED_CARGOS.includes(cargo)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const statusParam = searchParams.get("status") ?? "aguardando_compra";
  if (!VALID_STATUSES.includes(statusParam as CompraStatusFilter)) {
    return NextResponse.json(
      { error: `Status invalido. Use: ${VALID_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  const status = statusParam as CompraStatusFilter;
  const supabase = createServiceClient();

  try {
    // Fetch counts for all statuses (tab badges)
    const counts = await fetchCounts(supabase);

    // Fetch data for the requested status
    let data: unknown;
    if (status === "aguardando_compra") {
      data = await fetchAguardandoCompra(supabase);
    } else if (status === "comprado") {
      data = await fetchComprado(supabase);
    } else {
      data = await fetchExcecoes(supabase);
    }

    return NextResponse.json({ counts, data });
  } catch (err) {
    logger.error("compras-api", "Erro ao buscar compras", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Erro interno ao buscar compras" },
      { status: 500 },
    );
  }
}

// ─── Count helpers ───────────────────────────────────────────────────────────

async function fetchCounts(supabase: ReturnType<typeof createServiceClient>) {
  const [aguardando, comprado, indisponivel] = await Promise.all([
    supabase
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .eq("compra_status", "aguardando_compra"),
    supabase
      .from("siso_ordens_compra")
      .select("id", { count: "exact", head: true })
      .in("status", ["comprado", "parcialmente_recebido"]),
    supabase
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .in("compra_status", [...COMPRA_EXCEPTION_STATUSES]),
  ]);

  return {
    aguardando_compra: aguardando.count ?? 0,
    comprado: comprado.count ?? 0,
    indisponivel: indisponivel.count ?? 0,
  };
}

// ─── Aguardando Compra ──────────────────────────────────────────────────────

interface RawAguardandoItem {
  id: string;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
  fornecedor_oc: string | null;
  imagem_url: string | null;
  pedido_id: string;
  ordem_compra_id: string | null;
  siso_pedidos: {
    numero: string;
    empresa_origem_id: string | null;
  } | null;
}

async function fetchAguardandoCompra(
  supabase: ReturnType<typeof createServiceClient>,
) {
  const { data: items, error } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, quantidade_pedida, fornecedor_oc, imagem_url, pedido_id, ordem_compra_id, siso_pedidos(numero, empresa_origem_id)",
    )
    .eq("compra_status", "aguardando_compra")
    .order("fornecedor_oc");

  if (error) throw new Error(`Erro ao buscar itens aguardando: ${error.message}`);
  if (!items || items.length === 0) return [];

  const rawItems = items as unknown as RawAguardandoItem[];
  const empresaIds = [
    ...new Set(
      rawItems
        .map((item) => item.siso_pedidos?.empresa_origem_id)
        .filter(Boolean),
    ),
  ] as string[];

  const empresaNameMap = new Map<string, string>();
  if (empresaIds.length > 0) {
    const { data: empresas, error: empresasError } = await supabase
      .from("siso_empresas")
      .select("id, nome")
      .in("id", empresaIds);

    if (empresasError) {
      throw new Error(`Erro ao buscar empresas: ${empresasError.message}`);
    }

    for (const empresa of empresas ?? []) {
      empresaNameMap.set(empresa.id, empresa.nome);
    }
  }

  // Group by fornecedor + empresa_origem_id so the buyer can see clearly
  // which empresa needs each purchase.
  const byGrupo = new Map<
    string,
    {
      fornecedor: string;
      empresa_id: string | null;
      empresa_nome: string | null;
      itens: Map<string, CompraItemAgrupado>;
    }
  >();

  for (const item of rawItems) {
    const fornecedor = item.fornecedor_oc ?? "Desconhecido";
    const pedido = item.siso_pedidos;
    const numeroPedido = pedido?.numero ?? "?";
    const empresaId = pedido?.empresa_origem_id ?? null;
    const groupKey = `${fornecedor}::${empresaId ?? "sem-empresa"}`;

    if (!byGrupo.has(groupKey)) {
      byGrupo.set(groupKey, {
        fornecedor,
        empresa_id: empresaId,
        empresa_nome: empresaId ? (empresaNameMap.get(empresaId) ?? null) : null,
        itens: new Map(),
      });
    }
    const skuMap = byGrupo.get(groupKey)!.itens;

    if (!skuMap.has(item.sku)) {
      skuMap.set(item.sku, {
        sku: item.sku,
        descricao: item.descricao,
        imagem: item.imagem_url ?? null,
        quantidade_total: 0,
        fornecedor_oc: fornecedor,
        pedidos: [],
        itens_ids: [],
      });
    }

    const agrupado = skuMap.get(item.sku)!;
    agrupado.quantidade_total += item.quantidade_pedida;
    agrupado.pedidos.push({
      pedido_id: item.pedido_id,
      numero_pedido: numeroPedido,
      quantidade: item.quantidade_pedida,
    });
    agrupado.itens_ids.push(String(item.id));
  }

  // Convert to array grouped by fornecedor
  const result: Array<{
    fornecedor: string;
    empresa_id: string | null;
    empresa_nome: string | null;
    itens: CompraItemAgrupado[];
  }> = [];

  for (const grupo of byGrupo.values()) {
    result.push({
      fornecedor: grupo.fornecedor,
      empresa_id: grupo.empresa_id,
      empresa_nome: grupo.empresa_nome,
      itens: Array.from(grupo.itens.values()).sort((a, b) =>
        a.sku.localeCompare(b.sku),
      ),
    });
  }

  return result.sort((a, b) => {
    const empresaA = a.empresa_nome ?? a.empresa_id ?? "";
    const empresaB = b.empresa_nome ?? b.empresa_id ?? "";
    return (
      empresaA.localeCompare(empresaB, "pt-BR") ||
      a.fornecedor.localeCompare(b.fornecedor, "pt-BR")
    );
  });
}

// ─── Comprado ────────────────────────────────────────────────────────────────

interface RawOrdemCompra {
  id: string;
  fornecedor: string;
  empresa_id: string;
  status: string;
  observacao: string | null;
  comprado_por: string | null;
  comprado_em: string | null;
  created_at: string;
  siso_usuarios: { nome: string } | null;
}

interface RawCompradoItem {
  id: string;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
  compra_status: string | null;
  compra_quantidade_recebida: number;
  imagem_url: string | null;
  pedido_id: string;
  siso_pedidos: { numero: string } | null;
}

async function fetchComprado(
  supabase: ReturnType<typeof createServiceClient>,
) {
  // Fetch OCs with status comprado or parcialmente_recebido
  const { data: ordens, error: ordensError } = await supabase
    .from("siso_ordens_compra")
    .select("id, fornecedor, empresa_id, status, observacao, comprado_por, comprado_em, created_at, siso_usuarios:comprado_por(nome)")
    .in("status", ["comprado", "parcialmente_recebido"])
    .order("created_at", { ascending: false });

  if (ordensError) throw new Error(`Erro ao buscar OCs: ${ordensError.message}`);
  if (!ordens || ordens.length === 0) return [];

  const ocIds = (ordens as unknown as RawOrdemCompra[]).map((oc) => oc.id);

  // Fetch items for these OCs
  const { data: items, error: itemsError } = await supabase
    .from("siso_pedido_itens")
    .select("id, sku, descricao, quantidade_pedida, compra_status, compra_quantidade_recebida, imagem_url, pedido_id, ordem_compra_id, siso_pedidos(numero)")
    .in("ordem_compra_id", ocIds);

  if (itemsError) throw new Error(`Erro ao buscar itens OC: ${itemsError.message}`);

  // Group items by ordem_compra_id
  const itemsByOc = new Map<string, RawCompradoItem[]>();
  for (const item of (items ?? []) as unknown as (RawCompradoItem & { ordem_compra_id: string })[]) {
    const list = itemsByOc.get(item.ordem_compra_id) ?? [];
    list.push(item);
    itemsByOc.set(item.ordem_compra_id, list);
  }

  return (ordens as unknown as RawOrdemCompra[]).map((oc) => {
    const ocItems = itemsByOc.get(oc.id) ?? [];
    const totalItens = ocItems.length;
    const recebidos = ocItems.filter((i) => i.compra_status === "recebido").length;

    return {
      id: oc.id,
      fornecedor: oc.fornecedor,
      empresa_id: oc.empresa_id,
      status: oc.status,
      observacao: oc.observacao,
      comprado_por_nome: oc.siso_usuarios?.nome ?? null,
      comprado_em: oc.comprado_em,
      created_at: oc.created_at,
      total_itens: totalItens,
      itens_recebidos: recebidos,
      itens: ocItems.map((item) => ({
        id: String(item.id),
        sku: item.sku,
        descricao: item.descricao,
        imagem: item.imagem_url ?? null,
        quantidade: item.quantidade_pedida,
        compra_status: item.compra_status,
        compra_quantidade_recebida: item.compra_quantidade_recebida,
        pedido_id: item.pedido_id,
        numero_pedido: item.siso_pedidos?.numero ?? "?",
      })),
    };
  });
}

// ─── Exceções ────────────────────────────────────────────────────────────────

interface RawExceptionItem {
  id: string;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
  fornecedor_oc: string | null;
  imagem_url: string | null;
  pedido_id: string;
  compra_status: string | null;
  compra_equivalente_sku: string | null;
  compra_equivalente_descricao: string | null;
  compra_equivalente_fornecedor: string | null;
  compra_equivalente_observacao: string | null;
  compra_cancelamento_motivo: string | null;
  siso_pedidos: {
    numero: string;
    empresa_origem_id: string | null;
  } | null;
}

async function fetchExcecoes(
  supabase: ReturnType<typeof createServiceClient>,
) {
  const { data: items, error } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, quantidade_pedida, fornecedor_oc, imagem_url, pedido_id, compra_status, compra_equivalente_sku, compra_equivalente_descricao, compra_equivalente_fornecedor, compra_equivalente_observacao, compra_cancelamento_motivo, siso_pedidos(numero, empresa_origem_id)",
    )
    .in("compra_status", [...COMPRA_EXCEPTION_STATUSES]);

  if (error) throw new Error(`Erro ao buscar exceções de compras: ${error.message}`);

  const rawItems = (items ?? []) as unknown as RawExceptionItem[];
  const empresaIds = [
    ...new Set(
      rawItems
        .map((item) => item.siso_pedidos?.empresa_origem_id)
        .filter(Boolean),
    ),
  ] as string[];

  const empresaNameMap = new Map<string, string>();
  if (empresaIds.length > 0) {
    const { data: empresas, error: empresasError } = await supabase
      .from("siso_empresas")
      .select("id, nome")
      .in("id", empresaIds);

    if (empresasError) {
      throw new Error(`Erro ao buscar empresas das exceções: ${empresasError.message}`);
    }

    for (const empresa of empresas ?? []) {
      empresaNameMap.set(empresa.id, empresa.nome);
    }
  }

  return rawItems.map((item) => ({
    id: String(item.id),
    sku: item.sku,
    descricao: item.descricao,
    imagem: item.imagem_url ?? null,
    quantidade: item.quantidade_pedida,
    fornecedor_oc: item.fornecedor_oc,
    pedido_id: item.pedido_id,
    compra_status: item.compra_status,
    compra_equivalente_sku: item.compra_equivalente_sku,
    compra_equivalente_descricao: item.compra_equivalente_descricao,
    compra_equivalente_fornecedor: item.compra_equivalente_fornecedor,
    compra_equivalente_observacao: item.compra_equivalente_observacao,
    compra_cancelamento_motivo: item.compra_cancelamento_motivo,
    numero_pedido: item.siso_pedidos?.numero ?? "?",
    empresa_id: item.siso_pedidos?.empresa_origem_id ?? null,
    empresa_nome: item.siso_pedidos?.empresa_origem_id
      ? (empresaNameMap.get(item.siso_pedidos.empresa_origem_id) ?? null)
      : null,
  }));
}
