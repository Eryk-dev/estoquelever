import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { listarEquivalentesComEstoque } from "@/lib/wms/trocas-equivalencia";

/**
 * GET /api/wms/trocas/equivalentes?sku=X&galpao_id=Y
 *
 * Equivalentes do SKU (cluster cross) presentes no catálogo WMS, com
 * disponível LIVE no galpão + tier + status de curadoria do par. Alimenta as
 * superfícies de troca (separação, compras, painel de pedidos).
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });

  const sku = request.nextUrl.searchParams.get("sku")?.trim();
  const galpaoId = request.nextUrl.searchParams.get("galpao_id")?.trim();
  if (!sku || !galpaoId) {
    return NextResponse.json({ error: "Envie ?sku=X&galpao_id=Y" }, { status: 400 });
  }

  try {
    const equivalentes = await listarEquivalentesComEstoque({ sku, galpaoId });
    return NextResponse.json({ sku, equivalentes });
  } catch (err) {
    logger.error("api.wms.trocas.equivalentes", "erro listando equivalentes", {
      error: err instanceof Error ? err.message : String(err),
      sku,
    });
    return NextResponse.json(
      { error: "Erro interno ao listar equivalentes" },
      { status: 500 },
    );
  }
}
