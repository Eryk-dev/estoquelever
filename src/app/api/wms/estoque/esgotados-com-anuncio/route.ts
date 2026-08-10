import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { saldosPorPerspectiva } from "@/lib/wms/estoque";
import {
  getIndiceCompletoAnunciosAtivos,
  listarAnunciosAtivosIndexadosPorSku,
} from "@/lib/ml-anuncios-index";
import { normalizarSkuAnuncio } from "@/lib/ml-anuncios";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const galpaoId = req.nextUrl.searchParams.get("galpao_id") ?? undefined;
  try {
    const [saldos, indice] = await Promise.all([
      saldosPorPerspectiva("produto", { galpao_id: galpaoId }),
      getIndiceCompletoAnunciosAtivos(),
    ]);
    const esgotados = saldos.filter((row) => Number(row.saldo) <= 0);
    const porSku = new Map(
      esgotados.map((row) => [
        normalizarSkuAnuncio(row.itens[0]?.produto.sku ?? ""),
        row,
      ]),
    );
    const anuncios = await listarAnunciosAtivosIndexadosPorSku(porSku.keys());
    const anunciosPorSku = new Map<string, typeof anuncios>();
    for (const anuncio of anuncios) {
      const lista = anunciosPorSku.get(anuncio.sku_normalizado) ?? [];
      lista.push(anuncio);
      anunciosPorSku.set(anuncio.sku_normalizado, lista);
    }
    const rows = [...porSku.entries()]
      .filter(([sku]) => (anunciosPorSku.get(sku)?.length ?? 0) > 0)
      .map(([sku, row]) => {
        const produto = row.itens[0]!.produto;
        return {
          produto_id: produto.id,
          sku: produto.sku,
          descricao: produto.descricao,
          imagem_url: produto.imagem_url,
          saldo: Number(row.saldo),
          anuncios: anunciosPorSku.get(sku) ?? [],
        };
      })
      .sort((a, b) => b.anuncios.length - a.anuncios.length || a.sku.localeCompare(b.sku));
    return NextResponse.json({
      rows,
      total_skus: rows.length,
      total_anuncios: rows.reduce((n, row) => n + row.anuncios.length, 0),
      cobertura_completa: indice.coberturaCompleta,
      indice_atualizado_em: indice.atualizadoEm,
      gerado_em: new Date().toISOString(),
    });
  } catch (error) {
    return wmsErrorResponse({
      source: "wms.estoque.esgotados-com-anuncio",
      error,
      requestPath: "/api/wms/estoque/esgotados-com-anuncio",
      requestMethod: "GET",
    });
  }
}
