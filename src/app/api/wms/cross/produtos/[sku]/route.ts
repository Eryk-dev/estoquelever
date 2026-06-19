import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import { aggregateLiveStockBySku } from "@/lib/wms/live-stock";
import { equivalentesDaPeca } from "@/lib/cross/equivalencias";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * GET /api/wms/cross/produtos/[sku]
 * Ficha: a peça (com NOSSO estoque do ledger) + equivalentes diretos.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sku: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();

  try {
    const sb = createServiceClient();
    const { data: prod } = await sb
      .from("siso_produtos")
      .select("sku, descricao, imagem_url, imagens, tier_qualidade")
      .eq("sku", sku)
      .maybeSingle();
    if (!prod) return NextResponse.json({ error: "produto não encontrado" }, { status: 404 });

    const estoqueMap = await aggregateLiveStockBySku(sb, [sku]);
    const nossoEstoquePorGalpao = Object.fromEntries(estoqueMap.get(sku)?.entries() ?? []);

    const eq = await equivalentesDaPeca(sku, { incluirBloqueado: true });
    return NextResponse.json({ produto: prod, nossoEstoquePorGalpao, equivalentes: eq.equivalentes });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.ficha", error, message: "erro montando ficha" });
  }
}
