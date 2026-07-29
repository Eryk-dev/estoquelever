import { NextRequest, NextResponse } from "next/server";
import {
  getIndiceRecenteAnunciosAtivos,
  skuTemAnuncioAtivo,
} from "@/lib/ml-anuncios";
import { getIndiceCompletoAnunciosAtivos } from "@/lib/ml-anuncios-index";
import { LIMITACAO_BUSCA_DIRETA_ML } from "@/lib/ml-anuncios-status";
import { saldosPorPerspectiva } from "@/lib/wms/estoque";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const galpaoId = req.nextUrl.searchParams.get("galpao_id") ?? undefined;

  try {
    const saldos = await saldosPorPerspectiva("produto", {
      galpao_id: galpaoId,
    });
    const comSaldo = saldos.filter((row) => Number(row.saldo) > 0);
    const [indiceCompleto, indiceRecente] = await Promise.all([
      getIndiceCompletoAnunciosAtivos(),
      getIndiceRecenteAnunciosAtivos(),
    ]);
    const skusAtivos = new Set([
      ...indiceCompleto.skusAtivos,
      ...indiceRecente.skusAtivos,
    ]);
    const ausenciaConclusiva = indiceCompleto.coberturaCompleta;

    const rows = comSaldo
      .filter((row) => {
        const sku = row.itens[0]?.produto.sku ?? "";
        return !!sku && !skuTemAnuncioAtivo(sku, skusAtivos);
      })
      .map((row) => {
        const produto = row.itens[0]!.produto;
        const galpoesMap = new Map<string, number>();
        for (const item of row.itens) {
          const saldo = Number(item.saldo);
          if (saldo <= 0) continue;
          galpoesMap.set(
            item.galpao.nome,
            (galpoesMap.get(item.galpao.nome) ?? 0) + saldo,
          );
        }
        return {
          produto_id: produto.id,
          sku: produto.sku,
          descricao: produto.descricao,
          imagem_url: produto.imagem_url,
          saldo: Number(row.saldo),
          reservado: Number(row.reservado),
          disponivel: Number(row.disponivel),
          situacao: ausenciaConclusiva
            ? ("sem_anuncio_no_snapshot_completo" as const)
            : ("candidato" as const),
          galpoes: Array.from(galpoesMap, ([nome, saldo]) => ({
            nome,
            saldo,
          })),
        };
      })
      .sort((a, b) => b.saldo - a.saldo);

    return NextResponse.json({
      rows,
      produtos_com_saldo: comSaldo.length,
      contas_ativas: indiceCompleto.contasAtivas,
      contas_indexadas: indiceCompleto.contasComSnapshot,
      anuncios_ativos_indexados: indiceCompleto.coberturaCompleta
        ? indiceCompleto.anunciosAtivos
        : indiceRecente.anunciosAtivos,
      indice_atualizado_em:
        indiceCompleto.atualizadoEm ?? indiceRecente.atualizadoEm,
      indice_completo_disponivel: indiceCompleto.schemaDisponivel,
      varredura_completa_em: indiceCompleto.atualizadoEm,
      snapshot_mais_antigo_em: indiceCompleto.snapshotMaisAntigoEm,
      indice_valido_ate: indiceCompleto.validoAte,
      contas_indice: indiceCompleto.contas,
      tipo_lista: ausenciaConclusiva
        ? "sem_anuncio_no_snapshot_completo"
        : "candidatos",
      ausencia_conclusiva: ausenciaConclusiva,
      limitacao_busca_direta: ausenciaConclusiva
        ? null
        : LIMITACAO_BUSCA_DIRETA_ML,
      gerado_em: new Date().toISOString(),
    });
  } catch (error) {
    return wmsErrorResponse({
      source: "wms.estoque.sem-anuncio",
      error,
      requestPath: "/api/wms/estoque/sem-anuncio",
      requestMethod: "GET",
      metadata: { galpaoId },
    });
  }
}
