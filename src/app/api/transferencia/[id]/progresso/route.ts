import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import type { InventarioItemStatus } from "@/types";

/**
 * GET /api/transferencia/[id]/progresso
 *
 * Returns processing progress: status, counters, and item list.
 * Designed for polling during processamento/reversao.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessao invalida" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  try {
    const { data: transferencia, error: fetchError } = await supabase
      .from("siso_transferencias")
      .select("id, status")
      .eq("id", id)
      .single();

    if (fetchError || !transferencia) {
      return NextResponse.json(
        { error: "Transferencia nao encontrada" },
        { status: 404 },
      );
    }

    // Count by status
    const { count: total } = await supabase
      .from("siso_transferencia_itens")
      .select("id", { count: "exact", head: true })
      .eq("transferencia_id", id);

    const { count: sucesso } = await supabase
      .from("siso_transferencia_itens")
      .select("id", { count: "exact", head: true })
      .eq("transferencia_id", id)
      .eq("status", "sucesso");

    const { count: erro } = await supabase
      .from("siso_transferencia_itens")
      .select("id", { count: "exact", head: true })
      .eq("transferencia_id", id)
      .eq("status", "erro");

    const processados = (sucesso ?? 0) + (erro ?? 0);

    // Fetch all items for list view (transfers are not consolidated — shown individually)
    const { data: itens } = await supabase
      .from("siso_transferencia_itens")
      .select("*")
      .eq("transferencia_id", id)
      .order("created_at", { ascending: true });

    const items = (itens ?? []).map((item) => {
      // Determine display status
      let status: InventarioItemStatus = "pendente";
      if (item.status === "sucesso") status = "sucesso";
      else if (item.status === "erro") status = "erro";
      else if (item.status === "processando") status = "processando";

      return {
        sku: item.sku,
        nome_produto: item.nome_produto,
        quantidade_total: item.quantidade,
        localizacoes: "",
        status,
        erro_msg: item.erro_msg,
      };
    });

    return NextResponse.json({
      status: transferencia.status,
      total: total ?? 0,
      processados,
      sucesso: sucesso ?? 0,
      erro: erro ?? 0,
      itens: items,
    });
  } catch (err) {
    logger.error("transferencia-progresso", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      transferenciaId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
