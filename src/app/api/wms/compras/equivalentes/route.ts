import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { listarEquivalentesParaCompra } from "@/lib/wms/trocas-equivalencia";

/**
 * GET /api/wms/compras/equivalentes?sku=X
 *
 * Equivalentes do SKU (cluster cross) pro painel de COMPRAS: lista TODOS os
 * equivalentes do catálogo WMS (com ou sem saldo) + saldo disponível por galpão
 * de cada um (informativo) + tier + curadoria do par. O comprador pode comprar
 * o equivalente mesmo sem estoque (vira compra de outro fornecedor).
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.ver")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const sku = request.nextUrl.searchParams.get("sku")?.trim();
  if (!sku) {
    return NextResponse.json({ error: "Envie ?sku=X" }, { status: 400 });
  }

  try {
    const equivalentes = await listarEquivalentesParaCompra({ sku });
    return NextResponse.json({ sku, equivalentes });
  } catch (err) {
    logger.error("api.wms.compras.equivalentes", "erro listando equivalentes", {
      error: err instanceof Error ? err.message : String(err),
      sku,
    });
    return NextResponse.json(
      { error: "Erro interno ao listar equivalentes" },
      { status: 500 },
    );
  }
}
