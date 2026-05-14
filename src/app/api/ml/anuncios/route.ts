/**
 * GET /api/ml/anuncios?sku=XYZ[&refresh=1]
 *
 * Retorna anúncios encontrados pra esse SKU em todas as conexões ML
 * ativas. Usa cache de 5min por (conexao, sku).
 *
 * Query params:
 *   - sku (obrigatório)
 *   - refresh=1 força bypass do cache
 *   - conexoes=id1,id2 limita às conexões dadas
 */
import { NextRequest, NextResponse } from "next/server";
import { getAnunciosPorSku } from "@/lib/ml-anuncios";

export async function GET(request: NextRequest) {
  const sku = request.nextUrl.searchParams.get("sku");
  if (!sku) {
    return NextResponse.json({ error: "Missing sku" }, { status: 400 });
  }
  const forceRefresh =
    request.nextUrl.searchParams.get("refresh") === "1" ||
    request.nextUrl.searchParams.get("refresh") === "true";

  const conexoesParam = request.nextUrl.searchParams.get("conexoes");
  const conexaoIds =
    conexoesParam && conexoesParam.trim()
      ? conexoesParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

  try {
    const result = await getAnunciosPorSku(sku, {
      conexaoIds,
      forceRefresh,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
