import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/pedidos/tracking
 *
 * Paginated list of pedidos for the universal tracking page.
 * Returns pedido summary data with combined status, empresa/galpao names.
 *
 * Query params:
 *   page — page number (default 1)
 *   limit — items per page (default 50, max 200)
 *   data_inicio — start date filter (ISO, default 30 days ago)
 *   data_fim — end date filter (ISO, default now)
 *   busca — text search (matches numero, id_pedido_ecommerce, cliente_nome, item sku)
 *   status — comma-separated status filter (e.g. "pendente,concluido")
 *   status_separacao — comma-separated status_separacao filter
 *   decisao — comma-separated decisao_final filter
 *   empresa_origem_id — filter by origin empresa
 *   marketplace — ilike filter on nome_ecommerce
 *   tab — "expedidos" for final-state orders, default for all others
 *
 * Role-based filtering:
 *   admin — sees all
 *   operador_cwb/operador_sp — sees only their galpao
 *   comprador — sees only decisao_final='oc'
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));

  // Date range — default last 30 days
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const dataInicio = searchParams.get("data_inicio") ?? thirtyDaysAgo.toISOString().split("T")[0];
  const dataFim = searchParams.get("data_fim") ?? now.toISOString().split("T")[0];

  // Search & filters
  const busca = searchParams.get("busca");
  const statusFilter = searchParams.get("status");
  const statusSeparacaoFilter = searchParams.get("status_separacao");
  const decisaoFilter = searchParams.get("decisao");
  const empresaOrigemId = searchParams.get("empresa_origem_id");
  const marketplaceFilter = searchParams.get("marketplace");
  const tab = searchParams.get("tab");

  const supabase = createServiceClient();
  const isAdmin = session.cargos.includes("admin");
  const isComprador = !isAdmin && session.cargos.includes("comprador");

  try {
    // Pre-fetch pedido_ids matching SKU search
    let buscaItemPedidoIds: string[] | null = null;
    if (busca) {
      const { data: matchingItems } = await supabase
        .from("siso_pedido_itens")
        .select("pedido_id")
        .ilike("sku", `%${busca}%`);
      if (matchingItems && matchingItems.length > 0) {
        buscaItemPedidoIds = [...new Set(matchingItems.map((i) => i.pedido_id))];
      }
    }

    // Helper: apply busca OR filter combining pedido fields + item-matched IDs
    function applyBuscaFilter<T extends { or: (filter: string) => T }>(q: T): T {
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

    // Helper: apply all shared filters (role, date, search, status, tab) to a query
    function applyFilters<
      T extends {
        gte: (col: string, val: string) => T;
        lte: (col: string, val: string) => T;
        eq: (col: string, val: string) => T;
        in: (col: string, vals: string[]) => T;
        ilike: (col: string, val: string) => T;
        or: (filter: string) => T;
        not: (col: string, op: string, val: unknown) => T;
      },
    >(q: T, empresaIds?: string[]): T {
      // Date range
      q = q.gte("data", dataInicio).lte("data", dataFim);

      // Role-based filtering
      if (isComprador) {
        q = q.eq("decisao_final", "oc");
      } else if (!isAdmin && empresaIds && empresaIds.length > 0) {
        q = q.in("empresa_origem_id", empresaIds);
      }

      // Tab filter
      if (tab === "expedidos") {
        // Expedidos: embalado with etiqueta impresso, or cancelado
        q = q.or(
          "and(status_separacao.eq.embalado,etiqueta_status.eq.impresso),status.eq.cancelado"
        );
      } else {
        // Default tab: exclude expedidos — NOT cancelado AND NOT (embalado+impresso)
        q = q.not("status", "eq", "cancelado");
        // NOT(A AND B) = (NOT A) OR (NOT B): keep rows where status_separacao != embalado OR etiqueta_status != impresso
        q = q.or("status_separacao.neq.embalado,status_separacao.is.null,etiqueta_status.neq.impresso,etiqueta_status.is.null");
      }

      // Text search
      q = applyBuscaFilter(q);

      // Status filter (comma-separated)
      if (statusFilter) {
        const statuses = statusFilter.split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          q = q.eq("status", statuses[0]);
        } else if (statuses.length > 1) {
          q = q.in("status", statuses);
        }
      }

      // Status separacao filter (comma-separated)
      if (statusSeparacaoFilter) {
        const statuses = statusSeparacaoFilter.split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          q = q.eq("status_separacao", statuses[0]);
        } else if (statuses.length > 1) {
          q = q.in("status_separacao", statuses);
        }
      }

      // Decisao filter (comma-separated)
      if (decisaoFilter && !isComprador) {
        const decisoes = decisaoFilter.split(",").map((s) => s.trim()).filter(Boolean);
        if (decisoes.length === 1) {
          q = q.eq("decisao_final", decisoes[0]);
        } else if (decisoes.length > 1) {
          q = q.in("decisao_final", decisoes);
        }
      }

      // Empresa filter
      if (empresaOrigemId) {
        q = q.eq("empresa_origem_id", empresaOrigemId);
      }

      // Marketplace filter
      if (marketplaceFilter) {
        q = q.ilike("nome_ecommerce", `%${marketplaceFilter}%`);
      }

      return q;
    }

    // Build base query with empresa/galpao JOINs
    const selectFields = `
      id, numero, id_pedido_ecommerce, nome_ecommerce,
      cliente_nome, cliente_cpf_cnpj, data, status, status_separacao,
      sugestao, decisao_final, tipo_resolucao, operador_nome,
      empresa_origem_id, filial_origem, marcadores, separacao_tags,
      etiqueta_status, embalagem_concluida_em, criado_em, erro,
      siso_empresas(nome, galpao_id, siso_galpoes(nome))
    `;

    // For operador role: pre-fetch empresa IDs in their galpao
    let empresaIds: string[] | undefined;
    if (!isAdmin && !isComprador && session.galpaoId) {
      const { data: empresasInGalpao } = await supabase
        .from("siso_empresas")
        .select("id")
        .eq("galpao_id", session.galpaoId);

      empresaIds = (empresasInGalpao ?? []).map((e) => e.id);
      if (empresaIds.length === 0) {
        return NextResponse.json({ pedidos: [], total: 0, page, totalPages: 0 });
      }
    }

    // Count query (same filters, no pagination)
    let countQuery = supabase
      .from("siso_pedidos")
      .select("*", { count: "exact", head: true });
    countQuery = applyFilters(countQuery, empresaIds);

    // Data query (with pagination)
    let dataQuery = supabase
      .from("siso_pedidos")
      .select(selectFields)
      .order("criado_em", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    dataQuery = applyFilters(dataQuery, empresaIds);

    // Execute count + data in parallel
    const [countResult, dataResult] = await Promise.all([countQuery, dataQuery]);

    if (dataResult.error) {
      logger.error("pedidos-tracking", "Failed to fetch pedidos", {
        error: dataResult.error.message,
      });
      return NextResponse.json({ error: dataResult.error.message }, { status: 500 });
    }

    const total = countResult.count ?? 0;
    const totalPages = Math.ceil(total / limit);

    // Map to response shape
    const pedidos = (dataResult.data ?? []).map((p) => {
      const empresa = p.siso_empresas as unknown as {
        nome: string;
        galpao_id: string;
        siso_galpoes: { nome: string };
      } | null;

      return {
        id: p.id,
        numero: p.numero ?? "",
        id_pedido_ecommerce: p.id_pedido_ecommerce ?? "",
        nome_ecommerce: p.nome_ecommerce ?? "",
        cliente_nome: p.cliente_nome ?? "",
        cliente_cpf_cnpj: p.cliente_cpf_cnpj ?? "",
        data: p.data ?? "",
        status: p.status ?? "pendente",
        status_separacao: p.status_separacao ?? null,
        sugestao: p.sugestao ?? "propria",
        decisao_final: p.decisao_final ?? null,
        tipo_resolucao: p.tipo_resolucao ?? null,
        operador: p.operador_nome ?? null,
        empresa_origem_nome: empresa?.nome ?? null,
        filial_origem: empresa?.siso_galpoes?.nome ?? p.filial_origem ?? null,
        marcadores: p.marcadores ?? [],
        separacao_tags: p.separacao_tags ?? [],
        etiqueta_status: p.etiqueta_status ?? null,
        embalagem_concluida_em: p.embalagem_concluida_em ?? null,
        criado_em: p.criado_em ?? "",
        erro: p.erro ?? null,
      };
    });

    return NextResponse.json({ pedidos, total, page, totalPages });
  } catch (err) {
    logger.error("pedidos-tracking", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
