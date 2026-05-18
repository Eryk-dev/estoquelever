import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";

/**
 * DELETE /api/separacao/realocacao/[id]
 * Cancela uma realocação aguardando_picking + TODOS os descendentes da chain
 * (via parent_realocacao_id). Não gera estorno.
 *
 * I7: BFS app-level coleta descendentes camada por camada e cancela todos
 * em batch. Se algum descendente já foi picado (`picado` ou `picado_parcial`),
 * aborta com 409 — operador precisa usar Cancelar separação pra esse caso.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const { id: realocId } = await params;
  const supabase = createServiceClient();

  try {
    const { data: realoc, error: realocErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("id, pedido_item_id, status")
      .eq("id", realocId)
      .single();
    if (realocErr || !realoc) {
      return NextResponse.json({ error: "realocação não encontrada" }, { status: 404 });
    }
    if (realoc.status !== "aguardando_picking") {
      return NextResponse.json(
        { error: `só pode cancelar realocação aguardando_picking (atual: ${realoc.status})` },
        { status: 409 },
      );
    }

    // I7: BFS coleta descendentes via parent_realocacao_id. Bloqueia se
    // qualquer descendente já foi picado — chain mista exige Cancelar separação.
    async function coletarDescendentes(rootId: string): Promise<string[]> {
      const acc: string[] = [];
      let camada = [rootId];
      while (camada.length > 0) {
        const { data, error } = await supabase
          .from("siso_pedido_item_realocacoes")
          .select("id, status")
          .in("parent_realocacao_id", camada);
        if (error) throw error;
        if (!data || data.length === 0) break;
        const picado = data.find(
          (r) => r.status === "picado" || r.status === "picado_parcial",
        );
        if (picado) {
          throw new Error("chain tem realoc picada — use Cancelar separação");
        }
        acc.push(...data.map((r) => r.id as string));
        camada = data.map((r) => r.id as string);
      }
      return acc;
    }

    let descendentes: string[];
    try {
      descendentes = await coletarDescendentes(realocId);
    } catch (e) {
      return NextResponse.json(
        { error: "chain_tem_picadas", message: (e as Error).message },
        { status: 409 },
      );
    }

    const todos = [realocId, ...descendentes];
    const { error: updErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .update({ status: "cancelado" })
      .in("id", todos)
      .eq("status", "aguardando_picking");

    if (updErr) {
      logger.logError({
        error: updErr,
        source: "separacao-realocacao-cancel",
        message: "Falhou cancelar chain de realocações",
        category: "database",
        requestPath: `/api/wms/separacao/realocacao/${realocId}`,
        requestMethod: "DELETE",
        metadata: { realocId, descendentes },
      });
      return NextResponse.json({ error: "erro cancelando chain" }, { status: 500 });
    }

    const { data: item } = await supabase
      .from("siso_pedido_itens")
      .select("pedido_id, sku")
      .eq("id", realoc.pedido_item_id)
      .single();

    if (item) {
      await registrarEvento({
        pedidoId: item.pedido_id,
        evento: descendentes.length > 0 ? "realocacao_cancelada_chain" : "realocacao_cancelada",
        detalhes: {
          realocacao_id: realocId,
          sku: item.sku,
          descendentes_canceladas: descendentes.length,
        },
        usuarioId: session.id,
      });
    }

    return NextResponse.json({
      status: "cancelado",
      descendentes_canceladas: descendentes.length,
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-realocacao-cancel",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: `/api/wms/separacao/realocacao/${realocId}`,
      requestMethod: "DELETE",
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
