import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser, checkBipRateLimit } from "@/lib/session";
import { logger } from "@/lib/logger";

/**
 * POST /api/separacao/bipar
 *
 * Process a barcode scan (GTIN or SKU) to confirm item separation.
 * Calls the atomic PL/pgSQL function siso_processar_bip.
 *
 * Headers: X-Session-Id
 * Body: { codigo: string }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  // Rate limit: max 2 bips/second per session
  const sessionId = request.headers.get("X-Session-Id")!;
  const rateCheck = checkBipRateLimit(sessionId);
  if (!rateCheck.allowed) {
    return NextResponse.json({ error: "rate_limit" }, { status: 429 });
  }

  // Operators must have a galpão; admins cannot bip
  if (!session.galpaoId) {
    return NextResponse.json(
      { error: "admin não pode bipar diretamente" },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);
  if (!body?.codigo || typeof body.codigo !== "string") {
    return NextResponse.json(
      { error: "campo 'codigo' é obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    const { data, error } = await supabase.rpc("siso_processar_bip", {
      p_codigo: body.codigo,
      p_usuario_id: session.id,
      p_galpao_id: session.galpaoId,
    });

    if (error) {
      logger.error("separacao-bipar", "RPC siso_processar_bip failed", {
        error: error.message,
        codigo: body.codigo,
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const result = data as {
      status: string;
      pedido_id?: string;
      pedido_numero?: number;
      produto_id?: number;
      sku?: string;
      bipados?: number;
      total?: number;
      itens_faltam?: number;
      codigo?: string;
    };

    // Map PL/pgSQL status to HTTP response
    switch (result.status) {
      case "parcial":
        return NextResponse.json({
          status: "parcial",
          pedido_id: result.pedido_id,
          pedido_numero: result.pedido_numero,
          produto_id: result.produto_id,
          sku: result.sku,
          bipados: result.bipados,
          total: result.total,
          itens_faltam: result.itens_faltam,
        });

      case "item_completo":
        return NextResponse.json({
          status: "item_completo",
          pedido_id: result.pedido_id,
          pedido_numero: result.pedido_numero,
          produto_id: result.produto_id,
          sku: result.sku,
          itens_faltam: result.itens_faltam,
        });

      case "pedido_completo":
        return NextResponse.json({
          status: "pedido_completo",
          pedido_id: result.pedido_id,
          pedido_numero: result.pedido_numero,
          etiqueta_status: "pendente",
        });

      case "nao_encontrado":
        return NextResponse.json(
          { error: "item_nao_encontrado", codigo: body.codigo },
          { status: 404 },
        );

      case "ja_completo":
        return NextResponse.json(
          {
            error: "item_ja_completo",
            pedido_id: result.pedido_id,
            sku: result.sku,
          },
          { status: 409 },
        );

      default:
        logger.error("separacao-bipar", "Unknown RPC status", {
          status: result.status,
        });
        return NextResponse.json({ error: "Erro interno" }, { status: 500 });
    }
  } catch (err) {
    logger.error("separacao-bipar", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
