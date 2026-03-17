import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
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
 * List orders filtered by separation status with search, sorting, and role-based filtering.
 * Returns { counts: SeparacaoCounts, pedidos: array }
 *
 * Query params:
 *   status_separacao — filter by status
 *   empresa_origem_id — filter by origin empresa
 *   sort — data_pedido (default) | localizacao | sku
 *   busca — search string (matches numero, id_pedido_ecommerce, cliente_nome)
 *
 * Role-based filtering via X-User-Cargo header:
 *   operador_cwb — sees only pedidos where empresa galpao = CWB
 *   operador_sp — sees only pedidos where empresa galpao = SP
 *   admin (default) — sees all
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get(
    "status_separacao",
  ) as StatusSeparacao | null;
  const empresaFilter = searchParams.get("empresa_origem_id");
  const sortParam = searchParams.get("sort") ?? "data_pedido";
  const busca = searchParams.get("busca");

  if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
    return NextResponse.json(
      { error: `Status inválido. Use: ${VALID_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  // Role-based filtering: resolve allowed empresa IDs from cargo
  const cargoHeader = request.headers.get("X-User-Cargo") ?? "admin";
  const cargos = cargoHeader.split(",").map((c) => c.trim());
  let allowedEmpresaIds: string[] | null = null; // null = no restriction

  // Admin sees all; otherwise find operador cargo to filter by galpao
  const operadorCargo = cargos.includes("admin") ? null : cargos.find((c) => c === "operador_cwb" || c === "operador_sp");
  if (operadorCargo) {
    const galpaoNome = operadorCargo === "operador_cwb" ? "CWB" : "SP";
    const { data: galpao } = await supabase
      .from("siso_galpoes")
      .select("id")
      .eq("nome", galpaoNome)
      .single();

    if (galpao) {
      const { data: empresas } = await supabase
        .from("siso_empresas")
        .select("id")
        .eq("galpao_id", galpao.id);
      allowedEmpresaIds = empresas?.map((e) => e.id) ?? [];
    } else {
      allowedEmpresaIds = [];
    }
  }

  // No empresas for this role — return empty
  if (allowedEmpresaIds !== null && allowedEmpresaIds.length === 0) {
    const emptyCounts: SeparacaoCounts = {
      aguardando_compra: 0,
      aguardando_nf: 0,
      aguardando_separacao: 0,
      em_separacao: 0,
      separado: 0,
      embalado: 0,
    };
    return NextResponse.json({ counts: emptyCounts, pedidos: [] });
  }

  try {
    // 1. Counts — parallel HEAD queries per status (NOT affected by empresa/busca filters)
    const countPromises = COUNT_STATUSES.map((status) => {
      let q = supabase
        .from("siso_pedidos")
        .select("*", { count: "exact", head: true })
        .eq("status_separacao", status);
      if (allowedEmpresaIds) q = q.in("empresa_origem_id", allowedEmpresaIds);
      return q;
    });

    // 1b. Fetch distinct empresas that have pedidos (for dropdown)
    const empresasPromise = supabase
      .from("siso_empresas")
      .select("id, nome")
      .order("nome");

    // 2. Pedidos query
    let pedidosQuery = supabase
      .from("siso_pedidos")
      .select(
        `id, numero, data, id_pedido_ecommerce, cliente_nome,
         forma_envio_descricao, status_separacao, marcadores,
         empresa_origem_id, etiqueta_status, etiqueta_zpl,
         siso_empresas(nome, galpao_id)`,
      )
      .not("status_separacao", "is", null);

    if (allowedEmpresaIds) {
      pedidosQuery = pedidosQuery.in("empresa_origem_id", allowedEmpresaIds);
    }
    if (empresaFilter) {
      pedidosQuery = pedidosQuery.eq("empresa_origem_id", empresaFilter);
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
              itens: [],
            };
          }
          const cs = compraStats[item.pedido_id];
          cs.total++;
          if (item.compra_status === "aguardando_compra") cs.aguardando++;
          else if (item.compra_status === "comprado") cs.comprado++;
          else if (item.compra_status === "recebido") cs.recebido++;
          else if (item.compra_status === "indisponivel") cs.indisponivel++;
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
      const empresa = p.siso_empresas as unknown as { nome: string; galpao_id: string } | null;
      const stats = itemStats[p.id] ?? { total: 0, marcados: 0, bipados: 0 };
      const cs = compraStats[p.id] ?? null;
      return {
        id: p.id,
        numero_nf: p.numero,
        numero_ec: p.id_pedido_ecommerce,
        numero_pedido: p.numero,
        cliente: p.cliente_nome,
        uf: null,
        cidade: null,
        forma_envio: p.forma_envio_descricao,
        data_pedido: p.data,
        empresa_origem_nome: empresa?.nome ?? null,
        galpao_id: empresa?.galpao_id ?? null,
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

    // Build empresas list (filtered by role if applicable)
    let empresas = (empresasList ?? []).map((e) => ({ id: e.id, nome: e.nome }));
    if (allowedEmpresaIds) {
      empresas = empresas.filter((e) => allowedEmpresaIds!.includes(e.id));
    }

    return NextResponse.json({ counts, pedidos: result, empresas });
  } catch (err) {
    logger.error("separacao-list", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
