import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { atualizarLocalizacaoProduto } from "@/lib/tiny-api";

/**
 * POST /api/separacao/localizacao
 *
 * Updates a product's warehouse location (localização) in Tiny ERP
 * and in the local DB (siso_pedido_item_estoques).
 *
 * Body: { produto_id: number, localizacao: string, empresa_id: string }
 * Returns: { ok: true }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  const produtoId = body?.produto_id;
  const localizacao = body?.localizacao;
  const empresaId = body?.empresa_id;

  if (!produtoId || typeof produtoId !== "number") {
    return NextResponse.json(
      { error: "Campo 'produto_id' (number) obrigatorio" },
      { status: 400 },
    );
  }
  if (typeof localizacao !== "string") {
    return NextResponse.json(
      { error: "Campo 'localizacao' (string) obrigatorio" },
      { status: 400 },
    );
  }
  if (!empresaId || typeof empresaId !== "string") {
    return NextResponse.json(
      { error: "Campo 'empresa_id' (string) obrigatorio" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const trimmed = localizacao.trim();

  try {
    // 1. Update in Tiny ERP
    const { token } = await getValidTokenByEmpresa(empresaId);
    await atualizarLocalizacaoProduto(token, produtoId, trimmed);

    // 2. Update all rows in siso_pedido_item_estoques for this product+empresa
    const { error: dbError } = await supabase
      .from("siso_pedido_item_estoques")
      .update({ localizacao: trimmed || null })
      .eq("produto_id", produtoId)
      .eq("empresa_id", empresaId);

    if (dbError) {
      logger.warn("localizacao", "Tiny updated but DB update failed", {
        produtoId,
        empresaId,
        error: dbError.message,
      });
    }

    logger.info("localizacao", "Localizacao atualizada", {
      produtoId,
      empresaId,
      localizacao: trimmed,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("localizacao", "Erro ao atualizar localizacao", {
      produtoId,
      empresaId,
      error: msg,
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
