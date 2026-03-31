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

  const supabase = createServiceClient();
  const isAdmin = session.cargos.includes("admin");
  const isComprador = !isAdmin && session.cargos.includes("comprador");

  try {
    // Build base query with empresa/galpao JOINs
    const selectFields = `
      id, numero, id_pedido_ecommerce, nome_ecommerce,
      cliente_nome, cliente_cpf_cnpj, data, status, status_separacao,
      sugestao, decisao_final, tipo_resolucao, operador_nome,
      empresa_origem_id, filial_origem, marcadores, separacao_tags,
      etiqueta_status, embalagem_concluida_em, criado_em, erro,
      siso_empresas(nome, galpao_id, siso_galpoes(nome))
    `;

    // Count query (same filters, no pagination)
    let countQuery = supabase
      .from("siso_pedidos")
      .select("*", { count: "exact", head: true })
      .gte("data", dataInicio)
      .lte("data", dataFim);

    // Data query (with pagination)
    let dataQuery = supabase
      .from("siso_pedidos")
      .select(selectFields)
      .gte("data", dataInicio)
      .lte("data", dataFim)
      .order("criado_em", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    // Role-based filtering
    if (isComprador) {
      countQuery = countQuery.eq("decisao_final", "oc");
      dataQuery = dataQuery.eq("decisao_final", "oc");
    } else if (!isAdmin && session.galpaoId) {
      // Operador: filter by galpao via empresa_origem_id -> siso_empresas.galpao_id
      // Get empresa IDs for this galpao
      const { data: empresasInGalpao } = await supabase
        .from("siso_empresas")
        .select("id")
        .eq("galpao_id", session.galpaoId);

      const empresaIds = (empresasInGalpao ?? []).map((e) => e.id);
      if (empresaIds.length > 0) {
        countQuery = countQuery.in("empresa_origem_id", empresaIds);
        dataQuery = dataQuery.in("empresa_origem_id", empresaIds);
      } else {
        // No empresas in this galpao — return empty
        return NextResponse.json({ pedidos: [], total: 0, page, totalPages: 0 });
      }
    }

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
