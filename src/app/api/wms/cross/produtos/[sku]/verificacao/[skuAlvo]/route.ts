import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ sku: string; skuAlvo: string }>;
}

/**
 * DELETE /api/wms/cross/produtos/:sku/verificacao/:skuAlvo
 *
 * Remove a curadoria do par (volta a "não curado" → toda troca exige aprovação).
 * Par normalizado lexicográfico antes de procurar.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "produtos.editar")) {
    return NextResponse.json(
      { error: "Sem permissão pra curar equivalências" },
      { status: 403 },
    );
  }

  const { sku: skuRaw, skuAlvo: skuAlvoRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();
  const skuAlvo = decodeURIComponent(skuAlvoRaw).trim();

  if (!sku || !skuAlvo) {
    return NextResponse.json({ error: "SKU obrigatório" }, { status: 400 });
  }

  const [sku_a, sku_b] = sku < skuAlvo ? [sku, skuAlvo] : [skuAlvo, sku];

  const supabase = createServiceClient();

  const { error: delErr } = await supabase
    .from("siso_equivalencias_verificadas")
    .delete()
    .eq("sku_a", sku_a)
    .eq("sku_b", sku_b);

  if (delErr) {
    logger.error("cross-verificacao-del", "Erro ao remover curadoria", {
      sku_a,
      sku_b,
      error: delErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }

  logger.info("cross-verificacao-del", "Curadoria de par removida", {
    usuario: session.id,
    sku_a,
    sku_b,
  });

  return NextResponse.json({ ok: true });
}
