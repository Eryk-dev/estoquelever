import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import type { SeparacaoCounts, StatusSeparacao } from "@/types";

const VALID_STATUSES: StatusSeparacao[] = [
  "aguardando_compra",
  "aguardando_nf",
  "aguardando_separacao",
  "em_separacao",
  "separado",
  "embalado",
  "cancelado",
];

const COUNT_STATUSES: (keyof SeparacaoCounts)[] = [
  "aguardando_compra",
  "aguardando_nf",
  "aguardando_separacao",
  "em_separacao",
  "separado",
  "embalado",
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
 *   busca — search string (matches numero, id_pedido_ecommerce, cliente_nome)
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
  const statusFilter = searchParams.get(
    "status_separacao",
  ) as StatusSeparacao | null;
  const empresaFilter = searchParams.get("empresa_origem_id");
  const marketplaceFilter = searchParams.get("marketplace");
  const busca = searchParams.get("busca");

  if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
    return NextResponse.json(
      { error: `Status inválido. Use: ${VALID_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const isAdmin = session.cargos.includes("admin");
  const activeGalpaoId = session.galpaoId;

  if (!isAdmin && !activeGalpaoId) {
    const emptyCounts: SeparacaoCounts = {
      aguardando_compra: 0,
      aguardando_nf: 0,
      aguardando_separacao: 0,
      em_separacao: 0,
      separado: 0,
      embalado: 0,
    };
    return NextResponse.json({
      counts: emptyCounts,
      pedidos: [],
      empresas: [],
      error: "galpao_nao_selecionado",
    });
  }

  try {
    // 1. Counts — parallel HEAD queries per status (NOT affected by empresa/busca filters)
    const countPromises = COUNT_STATUSES.map((status) => {
      let q = supabase
        .from("siso_pedidos")
        .select("*", { count: "exact", head: true })
        .eq("status_separacao", status);
      if (activeGalpaoId) q = q.eq("separacao_galpao_id", activeGalpaoId);
      return q;
    });

    // 1b. Fetch distinct origin empresas inside the current separation context
    let empresasPromise = supabase
      .from("siso_pedidos")
      .select("empresa_origem_id, siso_empresas(id, nome)")
      .not("status_separacao", "is", null);

    if (activeGalpaoId) {
      empresasPromise = empresasPromise.eq("separacao_galpao_id", activeGalpaoId);
    }

    // 2. Pedidos query
    let pedidosQuery = supabase
      .from("siso_pedidos")
      .select(
        `id, numero, data, id_pedido_ecommerce, cliente_nome,
         nome_ecommerce, forma_envio_descricao, status_separacao, decisao_final, filial_origem, marcadores,
         empresa_origem_id, separacao_galpao_id, etiqueta_status, etiqueta_zpl,
         siso_empresas(nome)`,
      )
      .not("status_separacao", "is", null);

    if (activeGalpaoId) {
      pedidosQuery = pedidosQuery.eq("separacao_galpao_id", activeGalpaoId);
    }
    if (empresaFilter) {
      pedidosQuery = pedidosQuery.eq("empresa_origem_id", empresaFilter);
    }
    if (marketplaceFilter) {
      pedidosQuery = pedidosQuery.ilike("nome_ecommerce", `%${marketplaceFilter}%`);
    }

    if (statusFilter) {
      pedidosQuery = pedidosQuery.eq("status_separacao", statusFilter);
    }
    if (busca) {
      pedidosQuery = pedidosQuery.or(
        `numero.ilike.%${busca}%,id_pedido_ecommerce.ilike.%${busca}%,cliente_nome.ilike.%${busca}%`,
      );
    }
    pedidosQuery = pedidosQuery.order("data", { ascending: true });

    // Execute counts + pedidos + empresas in parallel
    const [countResults, { data: pedidos, error: pedidosError }, { data: empresasList }] =
      await Promise.all([Promise.all(countPromises), pedidosQuery, empresasPromise]);

    if (pedidosError) {
      logger.error("separacao-list", "Failed to fetch pedidos", {
        error: pedidosError.message,
      });
      return NextResponse.json(
        { error: pedidosError.message },
        { status: 500 },
      );
    }

    // Build counts
    const counts: SeparacaoCounts = {
      aguardando_compra: countResults[0].count ?? 0,
      aguardando_nf: countResults[1].count ?? 0,
      aguardando_separacao: countResults[2].count ?? 0,
      em_separacao: countResults[3].count ?? 0,
      separado: countResults[4].count ?? 0,
      embalado: countResults[5].count ?? 0,
    };

    // 3. Fetch item stats for progress display (separation + packing counts)
    const pedidoIds = (pedidos ?? []).map((p) => p.id);
    const itemStats: Record<
      string,
      { total: number; marcados: number; bipados: number }
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
        itens: Array<{
          sku: string;
          descricao: string;
          quantidade: number;
          compra_status: string | null;
          fornecedor_oc: string | null;
        }>;
      }
    > = {};

    if (pedidoIds.length > 0) {
      const { data: items } = await supabase
        .from("siso_pedido_itens")
        .select("pedido_id, separacao_marcado, bipado_completo, compra_status, fornecedor_oc, sku, descricao, quantidade_pedida")
        .in("pedido_id", pedidoIds);

      for (const item of items ?? []) {
        if (item.compra_status === "cancelado") continue;

        if (!itemStats[item.pedido_id]) {
          itemStats[item.pedido_id] = { total: 0, marcados: 0, bipados: 0 };
        }
        itemStats[item.pedido_id].total++;
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
          cs.itens.push({
            sku: item.sku,
            descricao: item.descricao,
            quantidade: item.quantidade_pedida,
            compra_status: item.compra_status,
            fornecedor_oc: item.fornecedor_oc,
          });
        }
      }
    }

    // Shape response
    const result = (pedidos ?? []).map((p) => {
      const empresa = p.siso_empresas as unknown as { nome: string } | null;
      const stats = itemStats[p.id] ?? { total: 0, marcados: 0, bipados: 0 };
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
        empresa_origem_nome: empresa?.nome ?? null,
        filial_origem: p.filial_origem ?? null,
        galpao_id: p.separacao_galpao_id ?? null,
        decisao_final: p.decisao_final ?? null,
        status_separacao: p.status_separacao,
        marcadores: p.marcadores ?? [],
        total_itens: stats.total,
        itens_marcados: stats.marcados,
        itens_bipados: stats.bipados,
        compra_stats: cs,
        etiqueta_status: p.etiqueta_status ?? null,
        etiqueta_pronta: !!p.etiqueta_zpl,
      };
    });

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

    return NextResponse.json({ counts, pedidos: result, empresas });
  } catch (err) {
    logger.error("separacao-list", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
