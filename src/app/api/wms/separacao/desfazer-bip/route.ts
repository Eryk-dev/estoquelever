import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";
import { reverterCutoverSeRetrocedeu } from "@/lib/wms/cutover";

/**
 * POST /api/separacao/desfazer-bip
 *
 * Undo a bip: decrement quantidade_bipada by 1 for the given item,
 * revert bipado_completo if needed, and revert pedido status if applicable.
 *
 * Headers: X-Session-Id
 * Body: { pedido_id: string, produto_id: number }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  // Admin pode desfazer bip de qualquer galpão (bypass ownership abaixo).
  // Proxy: sistema.usuarios = admin no seed.
  const isAdmin = userCan(session, "sistema.usuarios");

  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_id ||
    typeof body.pedido_id !== "string" ||
    body.produto_id == null ||
    typeof body.produto_id !== "number"
  ) {
    return NextResponse.json(
      { error: "campos 'pedido_id' (string) e 'produto_id' (number) são obrigatórios" },
      { status: 400 },
    );
  }

  const { pedido_id, produto_id } = body as {
    pedido_id: string;
    produto_id: number;
  };

  const supabase = createServiceClient();

  try {
    // 1. Validate pedido belongs to operator's galpão
    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao, separacao_galpao_id")
      .eq("id", pedido_id)
      .single();

    if (pedidoError || !pedido) {
      return NextResponse.json(
        { error: "pedido não encontrado" },
        { status: 404 },
      );
    }

    if (!isAdmin && pedido.separacao_galpao_id !== session.galpaoId) {
      return NextResponse.json(
        { error: "pedido não pertence ao seu galpão" },
        { status: 403 },
      );
    }

    // 2. Fetch the item
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("produto_id, sku, quantidade_pedida, quantidade_bipada, bipado_completo")
      .eq("pedido_id", pedido_id)
      .eq("produto_id", produto_id)
      .single();

    if (itemError || !item) {
      return NextResponse.json(
        { error: "item não encontrado neste pedido" },
        { status: 404 },
      );
    }

    const currentBipada = item.quantidade_bipada ?? 0;
    if (currentBipada <= 0) {
      return NextResponse.json(
        { error: "item não tem bips para desfazer" },
        { status: 400 },
      );
    }

    // 3. Decrement quantidade_bipada by 1 — P021: decremento atômico no SQL
    // (dois cliques rápidos decrementam exatamente 1 cada, sem perder
    // decrementos). Usa o valor RETORNADO pela RPC pra decidir status.
    const { data: rpcRes, error: rpcErr } = await supabase.rpc(
      "wms_desfazer_bip_atomico",
      { p_pedido_id: pedido_id, p_produto_id: produto_id },
    );
    if (rpcErr) {
      logger.error("separacao-desfazer-bip", "RPC atomica falhou", {
        error: rpcErr.message,
        pedido_id,
        produto_id,
      });
      return NextResponse.json({ error: rpcErr.message }, { status: 500 });
    }
    const decRes = (rpcRes ?? {}) as {
      quantidade_bipada?: number;
      bipado_completo?: boolean;
    };
    const newBipada = Number(decRes.quantidade_bipada ?? currentBipada - 1);
    const newBipadoCompleto = Boolean(decRes.bipado_completo ?? false);

    // 4. Check if pedido status needs reverting
    let newStatusSeparacao = pedido.status_separacao;
    const pedidoUpdates: Record<string, unknown> = {};

    if (pedido.status_separacao === "embalado") {
      // Revert embalado → em_separacao
      newStatusSeparacao = "em_separacao";
      pedidoUpdates.status_separacao = "em_separacao";
      pedidoUpdates.embalagem_concluida_em = null;
      // etiqueta_status cleared via RPC below (PostgREST cache workaround)
    } else if (pedido.status_separacao === "em_separacao") {
      // Check if all bips are now zero across all items
      const { data: allItems } = await supabase
        .from("siso_pedido_itens")
        .select("quantidade_bipada")
        .eq("pedido_id", pedido_id);

      // Sum all bipadas (the current item was already updated)
      const totalBipada = (allItems ?? []).reduce(
        (sum, i) => sum + ((i.quantidade_bipada as number) ?? 0),
        0,
      );

      if (totalBipada === 0) {
        newStatusSeparacao = "aguardando_separacao";
        pedidoUpdates.status_separacao = "aguardando_separacao";
        pedidoUpdates.separacao_operador_id = null;
        pedidoUpdates.separacao_iniciada_em = null;
      }
    }

    if (Object.keys(pedidoUpdates).length > 0) {
      const { error: updatePedidoError } = await supabase
        .from("siso_pedidos")
        .update(pedidoUpdates)
        .eq("id", pedido_id);

      if (updatePedidoError) {
        logger.error("separacao-desfazer-bip", "Failed to update pedido status", {
          error: updatePedidoError.message,
          pedido_id,
        });
        return NextResponse.json(
          { error: updatePedidoError.message },
          { status: 500 },
        );
      }

      // Clear etiqueta_status via RPC (PostgREST schema cache workaround)
      if (pedido.status_separacao === "embalado") {
        await supabase.rpc("siso_set_etiqueta_status", {
          p_pedido_id: pedido_id,
          p_status: null,
        });
      }

      // WMS cutover reverse: se saiu do conjunto forward com estoque_lancado=true,
      // estorna S, recria R. Idempotente — no-op se nada precisa reverter.
      // FAIL-LOUD: a função NÃO lança em falha da RPC — retorna motivo='rpc_error'.
      // Se ignorássemos isso, o status já retrocedeu mas estoque_lancado ficaria
      // true + S viva → re-pick geraria baixa DUPLA. Surfacing 500 + logError
      // força retry (a operação é idempotente e converge).
      const revResult = await reverterCutoverSeRetrocedeu(
        pedido_id,
        newStatusSeparacao,
        "desfazer_bip",
        session.id,
      ).catch((err) => {
        return { reverted: false, motivo: "rpc_error" as const, err };
      });
      if (revResult.motivo === "rpc_error") {
        logger.logError({
          error: "err" in revResult ? revResult.err : "wms_reverter_cutover_atomico falhou",
          source: "separacao-desfazer-bip",
          message: "Reversão de estoque falhou — estoque_lancado pode estar incoerente com status",
          category: "business_logic",
          metadata: { pedido_id, novoStatus: newStatusSeparacao },
        });
        return NextResponse.json(
          { error: "reverter_estoque_falhou", pedido_id },
          { status: 500 },
        );
      }
    }

    logger.info("separacao-desfazer-bip", "Bip desfeito", {
      pedido_id,
      produto_id,
      newBipada,
      newStatusSeparacao,
    });

    return NextResponse.json({
      pedido_id,
      produto_id,
      quantidade_bipada: newBipada,
      bipado_completo: newBipadoCompleto,
      status_separacao: newStatusSeparacao,
    });
  } catch (err) {
    logger.error("separacao-desfazer-bip", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
