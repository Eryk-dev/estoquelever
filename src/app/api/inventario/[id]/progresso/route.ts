import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import type { InventarioItem, InventarioItemStatus } from "@/types";

/**
 * GET /api/inventario/[id]/progresso
 *
 * Returns processing progress: status, counters, and consolidated item list.
 * Designed for polling during processamento/reversão.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  try {
    // Fetch inventario status
    const { data: inventario, error: fetchError } = await supabase
      .from("siso_inventarios")
      .select("id, status")
      .eq("id", id)
      .single();

    if (fetchError || !inventario) {
      return NextResponse.json(
        { error: "Inventário não encontrado" },
        { status: 404 },
      );
    }

    // Count by status
    const { count: total } = await supabase
      .from("siso_inventario_itens")
      .select("id", { count: "exact", head: true })
      .eq("inventario_id", id);

    const { count: sucesso } = await supabase
      .from("siso_inventario_itens")
      .select("id", { count: "exact", head: true })
      .eq("inventario_id", id)
      .eq("status", "sucesso");

    const { count: erro } = await supabase
      .from("siso_inventario_itens")
      .select("id", { count: "exact", head: true })
      .eq("inventario_id", id)
      .eq("status", "erro");

    const processados = (sucesso ?? 0) + (erro ?? 0);

    // Fetch all items for consolidated view
    const { data: itens } = await supabase
      .from("siso_inventario_itens")
      .select("*")
      .eq("inventario_id", id)
      .order("created_at", { ascending: true });

    // Build consolidated items (group by SKU, aggregate status)
    const items = (itens ?? []) as InventarioItem[];
    const groups = new Map<
      string,
      {
        sku: string;
        nome_produto: string | null;
        quantidade_total: number;
        localizacoes: Set<string>;
        statuses: InventarioItemStatus[];
        erro_msg: string | null;
      }
    >();

    for (const item of items) {
      const key = item.sku.toUpperCase();
      const existing = groups.get(key);
      if (existing) {
        existing.quantidade_total += item.quantidade;
        existing.localizacoes.add(item.localizacao);
        existing.statuses.push(item.status);
        if (item.erro_msg) existing.erro_msg = item.erro_msg;
      } else {
        groups.set(key, {
          sku: item.sku,
          nome_produto: item.nome_produto,
          quantidade_total: item.quantidade,
          localizacoes: new Set([item.localizacao]),
          statuses: [item.status],
          erro_msg: item.erro_msg,
        });
      }
    }

    const consolidados = Array.from(groups.values()).map((g) => {
      // Aggregate status: any sucesso → sucesso, any erro → erro, else pendente
      let status: InventarioItemStatus = "pendente";
      if (g.statuses.some((s) => s === "sucesso")) status = "sucesso";
      else if (g.statuses.some((s) => s === "erro")) status = "erro";
      else if (g.statuses.some((s) => s === "processando"))
        status = "processando";

      return {
        sku: g.sku,
        nome_produto: g.nome_produto,
        quantidade_total: g.quantidade_total,
        localizacoes: Array.from(g.localizacoes).sort().join("; "),
        status,
        erro_msg: g.erro_msg,
      };
    });

    return NextResponse.json({
      status: inventario.status,
      total: total ?? 0,
      processados,
      sucesso: sucesso ?? 0,
      erro: erro ?? 0,
      itens: consolidados,
    });
  } catch (err) {
    logger.error("inventario-progresso", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      inventarioId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
