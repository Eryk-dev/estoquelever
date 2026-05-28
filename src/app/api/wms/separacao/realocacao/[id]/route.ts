import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import { estornarReservaIndividual } from "@/lib/wms/reservas";

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

    // PR-1 (#2.10): libera Rs do pedido associadas à realocação cancelada.
    //
    // Por que per-R (via `estornarReservaIndividual`) em vez de
    // `liberarReserva` global (por pedido_id): `liberarReserva` tem
    // short-circuit — se QUALQUER L do pedido já existe (ex.: outro item
    // já bipado), ele pula todas as Rs sem liberar. Resultado: as Rs da
    // realocação cancelada ficam zumbis, inflando `reservado` da loc
    // destino. Per-R é idempotente (acha L com estorno_de=R.id e retorna),
    // então é seguro pra TODAS as Rs do pedido — as já liberadas por
    // picking retornam o L existente sem criar novo. Ver #2.9 follow-up
    // (encaminhar) pro mesmo padrão.
    //
    // Granularidade: o loop varre TODAS as Rs abertas do pedido, não só as
    // ligadas a esta realocação específica. O plano explicita que isso é
    // aceitável: cancelar uma chain de realocação implica perda de cobertura
    // pro item — qualquer R associada perdeu sentido. Operador deve
    // re-aprovar/encaminhar pra reservar de novo.
    if (item) {
      try {
        const { data: reservasAbertas } = await supabase
          .from("siso_movimentacoes")
          .select("id")
          .eq("tipo", "R")
          .eq("origem_tipo", "reserva_pedido")
          .eq("origem_id", String(item.pedido_id));
        const lista = (reservasAbertas ?? []) as Array<{ id: string }>;
        let liberadas = 0;
        for (const r of lista) {
          try {
            await estornarReservaIndividual({
              reserva_id: r.id,
              motivo: "outro",
              usuario_id: session.id,
            });
            liberadas++;
          } catch (e) {
            // Idempotente: já liberada retorna o L existente sem throw.
            // Único erro esperado: "Reserva X não encontrada" (race).
            logger.warn(
              "separacao-realocacao-cancel",
              "falha estornando R individual (segue)",
              {
                pedido_id: item.pedido_id,
                reserva_id: r.id,
                error: e instanceof Error ? e.message : String(e),
              },
            );
          }
        }
        logger.info(
          "separacao-realocacao-cancel",
          "Rs liberadas no cancel da chain",
          {
            pedido_id: item.pedido_id,
            realoc_root: realocId,
            chain_size: todos.length,
            liberadas,
            tentadas: lista.length,
          },
        );
      } catch (e) {
        logger.warn(
          "separacao-realocacao-cancel",
          "falha liberando Rs (segue)",
          {
            error: e instanceof Error ? e.message : String(e),
          },
        );
      }
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
