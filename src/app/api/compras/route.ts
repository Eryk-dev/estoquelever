import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import {
  COMPRA_EXCEPTION_STATUSES,
  getAgingDays,
  getCompraPrioridade,
  getCompraQuantidadeRestante,
  getCompraQuantidadeSolicitada,
} from "@/lib/compras-utils";
import type { CompraItemAgrupado } from "@/types";

type CompraStatusFilter = "aguardando_compra" | "comprado" | "indisponivel" | "excecoes";

const VALID_STATUSES: CompraStatusFilter[] = [
  "aguardando_compra",
  "comprado",
  "indisponivel",
  "excecoes",
];

const ALLOWED_CARGOS = ["admin", "comprador"];
const OPEN_OC_STATUSES = ["aguardando_compra", "comprado", "parcialmente_recebido"] as const;
const UNRESOLVED_COMPRA_STATUSES = [
  "aguardando_compra",
  "comprado",
  ...COMPRA_EXCEPTION_STATUSES,
] as const;

interface RawPedidoRef {
  numero: string;
  empresa_origem_id: string | null;
}

interface RawCompraBaseItem {
  id: string;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
  compra_quantidade_solicitada: number;
  compra_quantidade_recebida: number;
  compra_status: string | null;
  compra_solicitada_em: string | null;
  comprado_em?: string | null;
  recebido_em?: string | null;
  fornecedor_oc: string | null;
  imagem_url: string | null;
  pedido_id: string;
  ordem_compra_id?: string | null;
  siso_pedidos: RawPedidoRef | null;
}

interface RawCompradoOc {
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

interface RawExceptionItem extends RawCompraBaseItem {
  compra_equivalente_sku: string | null;
  compra_equivalente_descricao: string | null;
  compra_equivalente_fornecedor: string | null;
  compra_equivalente_observacao: string | null;
  compra_cancelamento_motivo: string | null;
  compra_cancelamento_solicitado_em: string | null;
  compra_equivalente_definido_em: string | null;
}

type SummaryAccumulator = {
  quantidade: number;
  pedidos: Set<string>;
};

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
    const [counts, summary] = await Promise.all([
      fetchCounts(supabase),
      fetchSummary(supabase),
    ]);

    let data: unknown;
    if (status === "aguardando_compra") {
      data = await fetchAguardandoCompra(supabase);
    } else if (status === "comprado") {
      data = await fetchComprado(supabase);
    } else {
      data = await fetchExcecoes(supabase);
    }

    return NextResponse.json({ counts, summary, data });
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

async function buildEmpresaNameMap(
  supabase: ReturnType<typeof createServiceClient>,
  empresaIds: Array<string | null | undefined>,
) {
  const ids = [...new Set(empresaIds.filter(Boolean))] as string[];
  const map = new Map<string, string>();

  if (ids.length === 0) return map;

  const { data: empresas, error } = await supabase
    .from("siso_empresas")
    .select("id, nome")
    .in("id", ids);

  if (error) {
    throw new Error(`Erro ao buscar empresas: ${error.message}`);
  }

  for (const empresa of empresas ?? []) {
    map.set(empresa.id, empresa.nome);
  }

  return map;
}

function getTimelineBaseDate(item: {
  compra_status: string | null;
  compra_solicitada_em: string | null;
  comprado_em?: string | null;
}): string | null {
  if (item.compra_status === "comprado" && item.comprado_em) {
    return item.comprado_em;
  }
  return item.compra_solicitada_em;
}

async function fetchCounts(supabase: ReturnType<typeof createServiceClient>) {
  const [aguardando, comprado, excecoes] = await Promise.all([
    supabase
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .eq("compra_status", "aguardando_compra"),
    supabase
      .from("siso_ordens_compra")
      .select("id", { count: "exact", head: true })
      .in("status", [...OPEN_OC_STATUSES]),
    supabase
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .in("compra_status", [...COMPRA_EXCEPTION_STATUSES]),
  ]);

  return {
    aguardando_compra: aguardando.count ?? 0,
    comprado: comprado.count ?? 0,
    indisponivel: excecoes.count ?? 0,
  };
}

async function fetchSummary(supabase: ReturnType<typeof createServiceClient>) {
  const { data: items, error } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, quantidade_pedida, compra_quantidade_solicitada, compra_quantidade_recebida, compra_status, compra_solicitada_em, comprado_em, fornecedor_oc, siso_pedidos(empresa_origem_id)",
    )
    .in("compra_status", [...UNRESOLVED_COMPRA_STATUSES]);

  if (error) throw new Error(`Erro ao buscar resumo de compras: ${error.message}`);

  const rawItems = (items ?? []) as unknown as Array<
    Pick<
      RawCompraBaseItem,
      | "pedido_id"
      | "quantidade_pedida"
      | "compra_quantidade_solicitada"
      | "compra_quantidade_recebida"
      | "compra_status"
      | "compra_solicitada_em"
      | "comprado_em"
      | "fornecedor_oc"
      | "siso_pedidos"
    >
  >;
  const empresaNameMap = await buildEmpresaNameMap(
    supabase,
    rawItems.map((item) => item.siso_pedidos?.empresa_origem_id),
  );

  const pedidosBloqueados = new Set<string>();
  const empresasAtivas = new Set<string>();
  const gargaloFornecedor = new Map<string, SummaryAccumulator>();
  const gargaloEmpresa = new Map<string, SummaryAccumulator & { empresa_id: string | null; nome: string | null }>();

  let quantidadePendente = 0;
  let maisAntigoDias = 0;

  for (const item of rawItems) {
    pedidosBloqueados.add(item.pedido_id);

    const empresaId = item.siso_pedidos?.empresa_origem_id ?? null;
    if (empresaId) empresasAtivas.add(empresaId);

    const quantidadeItem = getCompraQuantidadeRestante(item);
    quantidadePendente += quantidadeItem;

    const agingDias = getAgingDays(getTimelineBaseDate(item));
    maisAntigoDias = Math.max(maisAntigoDias, agingDias);

    const fornecedor = item.fornecedor_oc ?? "Sem fornecedor";
    const fornecedorAgg = gargaloFornecedor.get(fornecedor) ?? {
      quantidade: 0,
      pedidos: new Set<string>(),
    };
    fornecedorAgg.quantidade += quantidadeItem;
    fornecedorAgg.pedidos.add(item.pedido_id);
    gargaloFornecedor.set(fornecedor, fornecedorAgg);

    const empresaKey = empresaId ?? "sem-empresa";
    const empresaAgg = gargaloEmpresa.get(empresaKey) ?? {
      empresa_id: empresaId,
      nome: empresaId ? (empresaNameMap.get(empresaId) ?? null) : null,
      quantidade: 0,
      pedidos: new Set<string>(),
    };
    empresaAgg.quantidade += quantidadeItem;
    empresaAgg.pedidos.add(item.pedido_id);
    gargaloEmpresa.set(empresaKey, empresaAgg);
  }

  const { count: ocsAbertas } = await supabase
    .from("siso_ordens_compra")
    .select("id", { count: "exact", head: true })
    .in("status", [...OPEN_OC_STATUSES]);

  return {
    itens_pendentes: rawItems.length,
    quantidade_pendente: quantidadePendente,
    pedidos_bloqueados: pedidosBloqueados.size,
    empresas_em_compra: empresasAtivas.size,
    ocs_abertas: ocsAbertas ?? 0,
    excecoes: rawItems.filter((item) =>
      COMPRA_EXCEPTION_STATUSES.includes(item.compra_status as (typeof COMPRA_EXCEPTION_STATUSES)[number]),
    ).length,
    mais_antigo_dias: maisAntigoDias,
    gargalos_fornecedor: [...gargaloFornecedor.entries()]
      .map(([nome, acc]) => ({
        nome,
        quantidade: acc.quantidade,
        pedidos: acc.pedidos.size,
      }))
      .sort((a, b) => b.quantidade - a.quantidade || b.pedidos - a.pedidos)
      .slice(0, 4),
    gargalos_empresa: [...gargaloEmpresa.values()]
      .map((acc) => ({
        empresa_id: acc.empresa_id,
        nome: acc.nome,
        quantidade: acc.quantidade,
        pedidos: acc.pedidos.size,
      }))
      .sort((a, b) => b.quantidade - a.quantidade || b.pedidos - a.pedidos)
      .slice(0, 4),
  };
}

async function fetchAguardandoCompra(
  supabase: ReturnType<typeof createServiceClient>,
) {
  const { data: items, error } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, quantidade_pedida, compra_quantidade_solicitada, compra_quantidade_recebida, compra_status, compra_solicitada_em, fornecedor_oc, imagem_url, pedido_id, ordem_compra_id, siso_pedidos(numero, empresa_origem_id)",
    )
    .eq("compra_status", "aguardando_compra");

  if (error) throw new Error(`Erro ao buscar itens aguardando: ${error.message}`);
  if (!items || items.length === 0) return [];

  const rawItems = items as unknown as RawCompraBaseItem[];
  const empresaNameMap = await buildEmpresaNameMap(
    supabase,
    rawItems.map((item) => item.siso_pedidos?.empresa_origem_id),
  );

  const byGrupo = new Map<
    string,
    {
      fornecedor: string;
      empresa_id: string | null;
      empresa_nome: string | null;
      primeira_solicitacao_em: string | null;
      pedidos: Set<string>;
      quantidade_total: number;
      itens: Map<string, CompraItemAgrupado>;
    }
  >();

  for (const item of rawItems) {
    const fornecedor = item.fornecedor_oc ?? "Sem fornecedor";
    const empresaId = item.siso_pedidos?.empresa_origem_id ?? null;
    const groupKey = `${fornecedor}::${empresaId ?? "sem-empresa"}`;
    const quantidadeSolicitada = getCompraQuantidadeSolicitada(item);
    const primeiraSolicitacao = item.compra_solicitada_em ?? null;

    if (!byGrupo.has(groupKey)) {
      byGrupo.set(groupKey, {
        fornecedor,
        empresa_id: empresaId,
        empresa_nome: empresaId ? (empresaNameMap.get(empresaId) ?? null) : null,
        primeira_solicitacao_em: primeiraSolicitacao,
        pedidos: new Set<string>(),
        quantidade_total: 0,
        itens: new Map(),
      });
    }

    const grupo = byGrupo.get(groupKey)!;
    grupo.quantidade_total += quantidadeSolicitada;
    grupo.pedidos.add(item.pedido_id);
    if (
      primeiraSolicitacao &&
      (!grupo.primeira_solicitacao_em || primeiraSolicitacao < grupo.primeira_solicitacao_em)
    ) {
      grupo.primeira_solicitacao_em = primeiraSolicitacao;
    }

    if (!grupo.itens.has(item.sku)) {
      grupo.itens.set(item.sku, {
        sku: item.sku,
        descricao: item.descricao,
        imagem: item.imagem_url ?? null,
        quantidade_total: 0,
        pedidos_bloqueados: 0,
        aging_dias: 0,
        primeira_solicitacao_em: primeiraSolicitacao,
        fornecedor_oc: fornecedor,
        pedidos: [],
        itens_ids: [],
      });
    }

    const agrupado = grupo.itens.get(item.sku)!;
    agrupado.quantidade_total += quantidadeSolicitada;
    agrupado.pedidos.push({
      pedido_id: item.pedido_id,
      numero_pedido: item.siso_pedidos?.numero ?? "?",
      quantidade: quantidadeSolicitada,
    });
    agrupado.itens_ids.push(String(item.id));
    agrupado.pedidos_bloqueados = new Set(agrupado.pedidos.map((pedido) => pedido.pedido_id)).size;

    if (
      primeiraSolicitacao &&
      (!agrupado.primeira_solicitacao_em || primeiraSolicitacao < agrupado.primeira_solicitacao_em)
    ) {
      agrupado.primeira_solicitacao_em = primeiraSolicitacao;
    }
    agrupado.aging_dias = getAgingDays(agrupado.primeira_solicitacao_em);
  }

  return [...byGrupo.values()]
    .map((grupo) => {
      const agingDias = getAgingDays(grupo.primeira_solicitacao_em);
      const pedidosBloqueados = grupo.pedidos.size;
      const prioridade = getCompraPrioridade({
        agingDias,
        pedidosBloqueados,
        quantidadeTotal: grupo.quantidade_total,
      });

      return {
        fornecedor: grupo.fornecedor,
        empresa_id: grupo.empresa_id,
        empresa_nome: grupo.empresa_nome,
        prioridade,
        aging_dias: agingDias,
        primeira_solicitacao_em: grupo.primeira_solicitacao_em,
        pedidos_bloqueados: pedidosBloqueados,
        quantidade_total: grupo.quantidade_total,
        total_skus: grupo.itens.size,
        proxima_acao:
          prioridade === "critica"
            ? "Criar OC e destravar pedidos desta empresa"
            : "Confirmar compra com o fornecedor",
        itens: [...grupo.itens.values()].sort((a, b) =>
          b.quantidade_total - a.quantidade_total || a.sku.localeCompare(b.sku, "pt-BR"),
        ),
      };
    })
    .sort((a, b) => {
      const prioridadeOrder = { critica: 0, alta: 1, normal: 2 } as const;
      return (
        prioridadeOrder[a.prioridade] - prioridadeOrder[b.prioridade] ||
        b.aging_dias - a.aging_dias ||
        b.quantidade_total - a.quantidade_total ||
        (a.empresa_nome ?? a.empresa_id ?? "").localeCompare(
          b.empresa_nome ?? b.empresa_id ?? "",
          "pt-BR",
        ) ||
        a.fornecedor.localeCompare(b.fornecedor, "pt-BR")
      );
    });
}

async function fetchComprado(
  supabase: ReturnType<typeof createServiceClient>,
) {
  const { data: ordens, error: ordensError } = await supabase
    .from("siso_ordens_compra")
    .select("id, fornecedor, empresa_id, status, observacao, comprado_por, comprado_em, created_at, siso_usuarios:comprado_por(nome)")
    .in("status", ["comprado", "parcialmente_recebido"])
    .order("created_at", { ascending: false });

  if (ordensError) throw new Error(`Erro ao buscar OCs: ${ordensError.message}`);
  if (!ordens || ordens.length === 0) return [];

  const ocs = ordens as unknown as RawCompradoOc[];
  const empresaNameMap = await buildEmpresaNameMap(
    supabase,
    ocs.map((oc) => oc.empresa_id),
  );

  const { data: items, error: itemsError } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, quantidade_pedida, compra_quantidade_solicitada, compra_quantidade_recebida, compra_status, compra_solicitada_em, comprado_em, imagem_url, pedido_id, ordem_compra_id, siso_pedidos(numero, empresa_origem_id)",
    )
    .in("ordem_compra_id", ocs.map((oc) => oc.id));

  if (itemsError) throw new Error(`Erro ao buscar itens OC: ${itemsError.message}`);

  const itemsByOc = new Map<string, RawCompraBaseItem[]>();
  for (const item of (items ?? []) as unknown as RawCompraBaseItem[]) {
    const ordemCompraId = item.ordem_compra_id;
    if (!ordemCompraId) continue;
    const list = itemsByOc.get(ordemCompraId) ?? [];
    list.push(item);
    itemsByOc.set(ordemCompraId, list);
  }

  return ocs
    .map((oc) => {
      const ocItems = itemsByOc.get(oc.id) ?? [];
      const pedidosBloqueados = new Set(ocItems.map((item) => item.pedido_id)).size;
      const quantidadeTotal = ocItems.reduce(
        (sum, item) => sum + getCompraQuantidadeSolicitada(item),
        0,
      );
      const quantidadeRecebida = ocItems.reduce(
        (sum, item) => sum + Number(item.compra_quantidade_recebida ?? 0),
        0,
      );
      const itensRecebidos = ocItems.filter((item) => item.compra_status === "recebido").length;
      const agingDias = getAgingDays(oc.comprado_em ?? oc.created_at);
      const prioridade = getCompraPrioridade({
        agingDias,
        pedidosBloqueados,
        quantidadeTotal: Math.max(quantidadeTotal - quantidadeRecebida, 0),
      });

      return {
        id: oc.id,
        fornecedor: oc.fornecedor,
        empresa_id: oc.empresa_id,
        empresa_nome: empresaNameMap.get(oc.empresa_id) ?? null,
        status: oc.status,
        observacao: oc.observacao,
        comprado_por_nome: oc.siso_usuarios?.nome ?? null,
        comprado_em: oc.comprado_em,
        created_at: oc.created_at,
        aging_dias: agingDias,
        prioridade,
        pedidos_bloqueados: pedidosBloqueados,
        quantidade_total: quantidadeTotal,
        quantidade_recebida: quantidadeRecebida,
        total_itens: ocItems.length,
        itens_recebidos: itensRecebidos,
        proxima_acao:
          oc.status === "parcialmente_recebido"
            ? "Conferir saldo restante e cobrar fornecedor"
            : "Conferir recebimento da OC",
        itens: ocItems.map((item) => ({
          id: String(item.id),
          sku: item.sku,
          descricao: item.descricao,
          imagem: item.imagem_url ?? null,
          quantidade: getCompraQuantidadeSolicitada(item),
          compra_status: item.compra_status,
          compra_quantidade_recebida: item.compra_quantidade_recebida,
          pedido_id: item.pedido_id,
          numero_pedido: item.siso_pedidos?.numero ?? "?",
          aging_dias: getAgingDays(getTimelineBaseDate(item)),
        })),
      };
    })
    .sort((a, b) => {
      const prioridadeOrder = { critica: 0, alta: 1, normal: 2 } as const;
      return (
        prioridadeOrder[a.prioridade] - prioridadeOrder[b.prioridade] ||
        b.aging_dias - a.aging_dias ||
        b.pedidos_bloqueados - a.pedidos_bloqueados ||
        b.quantidade_total - a.quantidade_total
      );
    });
}

async function fetchExcecoes(
  supabase: ReturnType<typeof createServiceClient>,
) {
  const { data: items, error } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, quantidade_pedida, compra_quantidade_solicitada, compra_quantidade_recebida, compra_status, compra_solicitada_em, fornecedor_oc, imagem_url, pedido_id, compra_equivalente_sku, compra_equivalente_descricao, compra_equivalente_fornecedor, compra_equivalente_observacao, compra_cancelamento_motivo, compra_cancelamento_solicitado_em, compra_equivalente_definido_em, siso_pedidos(numero, empresa_origem_id)",
    )
    .in("compra_status", [...COMPRA_EXCEPTION_STATUSES]);

  if (error) throw new Error(`Erro ao buscar exceções de compras: ${error.message}`);

  const rawItems = (items ?? []) as unknown as RawExceptionItem[];
  const empresaNameMap = await buildEmpresaNameMap(
    supabase,
    rawItems.map((item) => item.siso_pedidos?.empresa_origem_id),
  );

  return rawItems
    .map((item) => {
      const agingBase =
        item.compra_cancelamento_solicitado_em ??
        item.compra_equivalente_definido_em ??
        item.compra_solicitada_em;
      const quantidade = getCompraQuantidadeRestante(item);
      const agingDias = getAgingDays(agingBase);

      return {
        id: String(item.id),
        sku: item.sku,
        descricao: item.descricao,
        imagem: item.imagem_url ?? null,
        quantidade,
        aging_dias: agingDias,
        prioridade: getCompraPrioridade({
          agingDias,
          pedidosBloqueados: 1,
          quantidadeTotal: quantidade,
          hasException: true,
        }),
        proxima_acao:
          item.compra_status === "equivalente_pendente"
            ? "Confirmar troca e devolver para a fila"
            : item.compra_status === "cancelamento_pendente"
              ? "Confirmar cancelamento externo"
              : "Definir equivalente ou cancelar o item",
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
      };
    })
    .sort((a, b) =>
      b.aging_dias - a.aging_dias || b.quantidade - a.quantidade || a.sku.localeCompare(b.sku, "pt-BR"),
    );
}
