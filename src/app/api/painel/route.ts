import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

const ACTIVE_STATUSES = [
  "aguardando_nf",
  "aguardando_separacao",
  "em_separacao",
  "separado",
  "embalado",
] as const;

/**
 * GET /api/painel
 *
 * Returns all active separation orders with counts grouped by status,
 * sorted by prazo_envio ASC NULLS LAST for the operational panel.
 *
 * Query params:
 *   galpao_id — filter by galpão (optional)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const galpaoFilter = searchParams.get("galpao_id");

  const supabase = createServiceClient();

  try {
    // Resolve empresa IDs for galpao filter
    let allowedEmpresaIds: string[] | null = null;
    if (galpaoFilter) {
      const { data: empresas } = await supabase
        .from("siso_empresas")
        .select("id")
        .eq("galpao_id", galpaoFilter);
      allowedEmpresaIds = empresas?.map((e) => e.id) ?? [];
      if (allowedEmpresaIds.length === 0) {
        return NextResponse.json({
          counts: Object.fromEntries(ACTIVE_STATUSES.map((s) => [s, 0])),
          pedidos: [],
          galpoes: [],
          server_time: new Date().toISOString(),
        });
      }
    }

    // Counts per status
    const countPromises = ACTIVE_STATUSES.map((status) => {
      let q = supabase
        .from("siso_pedidos")
        .select("*", { count: "exact", head: true })
        .eq("status_separacao", status);
      if (allowedEmpresaIds) q = q.in("empresa_origem_id", allowedEmpresaIds);
      return q;
    });

    // Pedidos query — all active statuses, sorted by prazo_envio
    let pedidosQuery = supabase
      .from("siso_pedidos")
      .select(
        `id, numero, data, id_pedido_ecommerce, cliente_nome,
         forma_envio_descricao, status_separacao, marcadores,
         empresa_origem_id, prazo_envio,
         siso_empresas(nome, galpao_id)`,
      )
      .in("status_separacao", ACTIVE_STATUSES as unknown as string[]);

    if (allowedEmpresaIds) {
      pedidosQuery = pedidosQuery.in("empresa_origem_id", allowedEmpresaIds);
    }

    // Sort by prazo_envio ASC NULLS LAST, then by data ASC
    pedidosQuery = pedidosQuery
      .order("prazo_envio", { ascending: true, nullsFirst: false })
      .order("data", { ascending: true });

    // Galpoes list for filter dropdown
    const galpoesPromise = supabase
      .from("siso_galpoes")
      .select("id, nome")
      .eq("ativo", true)
      .order("nome");

    // Execute all in parallel
    const [countResults, { data: pedidos, error: pedidosError }, { data: galpoes }] =
      await Promise.all([Promise.all(countPromises), pedidosQuery, galpoesPromise]);

    if (pedidosError) {
      logger.error("painel", "Failed to fetch pedidos", {
        error: pedidosError.message,
      });
      return NextResponse.json(
        { error: pedidosError.message },
        { status: 500 },
      );
    }

    // Build counts
    const counts: Record<string, number> = {};
    ACTIVE_STATUSES.forEach((status, i) => {
      counts[status] = countResults[i].count ?? 0;
    });

    // Fetch item counts per pedido (lightweight — just total)
    const pedidoIds = (pedidos ?? []).map((p) => p.id);
    const itemCounts: Record<string, number> = {};

    if (pedidoIds.length > 0) {
      const { data: items } = await supabase
        .from("siso_pedido_itens")
        .select("pedido_id")
        .in("pedido_id", pedidoIds);

      for (const item of items ?? []) {
        itemCounts[item.pedido_id] = (itemCounts[item.pedido_id] ?? 0) + 1;
      }
    }

    // Shape response
    const result = (pedidos ?? []).map((p) => {
      const empresa = p.siso_empresas as unknown as {
        nome: string;
        galpao_id: string;
      } | null;
      return {
        id: p.id,
        numero: p.numero,
        numero_ec: p.id_pedido_ecommerce,
        cliente: p.cliente_nome,
        forma_envio: p.forma_envio_descricao,
        status_separacao: p.status_separacao,
        marcadores: p.marcadores ?? [],
        empresa_nome: empresa?.nome ?? null,
        galpao_id: empresa?.galpao_id ?? null,
        prazo_envio: p.prazo_envio ?? null,
        total_itens: itemCounts[p.id] ?? 0,
      };
    });

    return NextResponse.json({
      counts,
      pedidos: result,
      galpoes: galpoes ?? [],
      server_time: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("painel", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
