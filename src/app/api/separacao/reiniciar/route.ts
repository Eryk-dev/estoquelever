import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * POST /api/separacao/reiniciar
 *
 * Reset checklist or packing progress for the given pedidos.
 *
 * Body: { pedido_ids: string[], etapa: 'separacao' | 'embalagem' }
 *
 * - separacao: resets separacao_marcado/separacao_marcado_em (pedido must be em_separacao)
 * - embalagem: resets quantidade_bipada/bipado_completo (pedido must be separado)
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  if (
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) é obrigatório" },
      { status: 400 },
    );
  }

  if (body.etapa !== "separacao" && body.etapa !== "embalagem") {
    return NextResponse.json(
      { error: "'etapa' deve ser 'separacao' ou 'embalagem'" },
      { status: 400 },
    );
  }

  const { pedido_ids, etapa } = body as {
    pedido_ids: string[];
    etapa: "separacao" | "embalagem";
  };

  const supabase = createServiceClient();

  try {
    // Validate pedidos are in the correct status for the requested reset
    const expectedStatus = etapa === "separacao" ? "em_separacao" : "separado";

    const { data: pedidos, error: fetchError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao")
      .in("id", pedido_ids);

    if (fetchError) {
      logger.error("separacao-reiniciar", "Failed to fetch pedidos", {
        error: fetchError.message,
      });
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 },
      );
    }

    const invalidPedidos = (pedidos ?? []).filter(
      (p) => p.status_separacao !== expectedStatus,
    );

    if (invalidPedidos.length > 0) {
      return NextResponse.json(
        {
          error: `Pedidos devem estar com status '${expectedStatus}' para reiniciar ${etapa}`,
          pedidos_invalidos: invalidPedidos.map((p) => ({
            id: p.id,
            status_atual: p.status_separacao,
          })),
        },
        { status: 400 },
      );
    }

    // Reset item progress based on etapa
    if (etapa === "separacao") {
      const { error: updateError } = await supabase
        .from("siso_pedido_itens")
        .update({
          separacao_marcado: false,
          separacao_marcado_em: null,
        })
        .in("pedido_id", pedido_ids);

      if (updateError) {
        logger.error("separacao-reiniciar", "Failed to reset separacao items", {
          error: updateError.message,
        });
        return NextResponse.json(
          { error: updateError.message },
          { status: 500 },
        );
      }
    } else {
      const { error: updateError } = await supabase
        .from("siso_pedido_itens")
        .update({
          quantidade_bipada: 0,
          bipado_completo: false,
        })
        .in("pedido_id", pedido_ids);

      if (updateError) {
        logger.error("separacao-reiniciar", "Failed to reset embalagem items", {
          error: updateError.message,
        });
        return NextResponse.json(
          { error: updateError.message },
          { status: 500 },
        );
      }
    }

    logger.info("separacao-reiniciar", `Progresso de ${etapa} reiniciado`, {
      pedido_ids,
      etapa,
    });

    return NextResponse.json({ ok: true, pedido_ids, etapa });
  } catch (err) {
    logger.error("separacao-reiniciar", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
