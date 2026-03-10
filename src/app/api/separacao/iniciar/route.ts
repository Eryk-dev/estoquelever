import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import type { ProdutoConsolidado } from "@/types";

/**
 * POST /api/separacao/iniciar
 *
 * Start separation for selected orders: moves them to em_separacao
 * and returns a consolidated product checklist for wave picking.
 *
 * Headers: X-Session-Id
 * Body: { pedido_ids: string[], operador_id: string }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string") ||
    !body.operador_id ||
    typeof body.operador_id !== "string"
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) e 'operador_id' (string) são obrigatórios" },
      { status: 400 },
    );
  }

  const { pedido_ids, operador_id } = body as {
    pedido_ids: string[];
    operador_id: string;
  };

  const supabase = createServiceClient();

  try {
    // 1. Fetch all referenced pedidos and validate status
    const { data: pedidos, error: fetchError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao")
      .in("id", pedido_ids);

    if (fetchError) {
      logger.error("separacao-iniciar", "Failed to fetch pedidos", {
        error: fetchError.message,
      });
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 },
      );
    }

    // Check for missing pedidos
    const foundIds = new Set((pedidos ?? []).map((p) => p.id));
    const missingIds = pedido_ids.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      return NextResponse.json(
        { error: "pedidos não encontrados", pedido_ids: missingIds },
        { status: 404 },
      );
    }

    // Validate all have status_separacao = 'aguardando_separacao'
    const invalidPedidos = (pedidos ?? []).filter(
      (p) => p.status_separacao !== "aguardando_separacao",
    );
    if (invalidPedidos.length > 0) {
      return NextResponse.json(
        {
          error: "todos os pedidos devem estar com status 'aguardando_separacao'",
          pedido_ids: invalidPedidos.map((p) => p.id),
          statuses: invalidPedidos.map((p) => p.status_separacao),
        },
        { status: 400 },
      );
    }

    // 2. Update all pedidos to em_separacao
    const { error: updateError } = await supabase
      .from("siso_pedidos")
      .update({
        status_separacao: "em_separacao",
        separacao_operador_id: operador_id,
        separacao_iniciada_em: new Date().toISOString(),
      })
      .in("id", pedido_ids)
      .eq("status_separacao", "aguardando_separacao");

    if (updateError) {
      logger.error("separacao-iniciar", "Failed to update pedidos", {
        error: updateError.message,
      });
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    // 3. Call RPC to get consolidated product list for wave picking
    const { data: produtos, error: rpcError } = await supabase.rpc(
      "siso_consolidar_produtos_separacao",
      { p_pedido_ids: pedido_ids, p_order_by: "localizacao" },
    );

    if (rpcError) {
      logger.error("separacao-iniciar", "RPC consolidar failed", {
        error: rpcError.message,
      });
      // Orders are already updated — return them without products
      return NextResponse.json(
        { error: rpcError.message },
        { status: 500 },
      );
    }

    const consolidados: ProdutoConsolidado[] = (produtos ?? []).map(
      (p: Record<string, unknown>) => ({
        produto_id: String(p.produto_id),
        descricao: String(p.descricao ?? ""),
        sku: String(p.sku ?? ""),
        gtin: p.gtin ? String(p.gtin) : null,
        quantidade_total: Number(p.quantidade_total),
        unidade: String(p.unidade ?? "UN"),
        localizacao: p.localizacao ? String(p.localizacao) : null,
      }),
    );

    logger.info("separacao-iniciar", "Separação iniciada", {
      pedido_ids,
      operador_id,
      produtos_count: consolidados.length,
    });

    return NextResponse.json({ pedido_ids, produtos: consolidados });
  } catch (err) {
    logger.error("separacao-iniciar", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
