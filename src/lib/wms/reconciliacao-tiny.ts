// Fix-D #3.7: reconciliação Tiny ↔ ledger WMS.
//
// Pós-cutover WMS_AS_SOURCE (2026-05-25), o saldo de verdade vive em
// `siso_estoque` (3D). Tiny continua sincronizado como camada fiscal/marketplace
// mas pode divergir silenciosamente em casos de:
//   - falha de propagação Tiny → ML/Shopee
//   - ajuste manual no Tiny por terceiro (não-SISO)
//   - bug histórico de mov não-aplicada
//
// Este módulo agrega saldo WMS por (produto, empresa) — somando sobre todos
// os galpões e localizações — e compara com `obterEstoque(token, tiny_id)`.
// Divergências > 1 unidade entram no relatório.
//
// Performance: 1 Tiny API call por (produto, empresa) ativo. Para projeto
// pequeno (~hundreds de SKUs × 5 empresas) viável em batch sem rate limit;
// pra escala maior, mover pra worker assíncrono com paginação.

import { createServiceClient } from "@/lib/supabase-server";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { getEstoque } from "@/lib/tiny-api";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { logger } from "@/lib/logger";

export interface DivergenciaReconc {
  empresa_id: string;
  empresa_nome: string;
  produto_id: string;
  sku: string;
  tiny_produto_id: number;
  saldo_wms: number;
  saldo_tiny: number;
  delta: number; // wms - tiny (positivo = WMS tem mais)
}

export interface ReconciliacaoResult {
  divergencias: DivergenciaReconc[];
  total_produtos_comparados: number;
  total_falhas_tiny: number;
  computado_em: string;
}

const LOG_SOURCE = "wms.reconciliacao.tiny";

/**
 * Compara saldo agregado WMS vs Tiny por (produto × empresa).
 *
 * @param opts.empresa_id    Filtra uma empresa específica (default: todas ativas)
 * @param opts.limit         Limite de produtos por empresa (default: 100)
 * @param opts.threshold     Delta mínimo pra considerar divergência (default: 1)
 */
export async function reconciliarTinyEntradas(opts: {
  empresa_id?: string;
  limit?: number;
  threshold?: number;
} = {}): Promise<ReconciliacaoResult> {
  const threshold = opts.threshold ?? 1;
  const sb = createServiceClient();

  // Lista empresas ativas (ou só a solicitada)
  const empresasQ = opts.empresa_id
    ? sb.from("siso_empresas").select("id, nome").eq("id", opts.empresa_id)
    : sb.from("siso_empresas").select("id, nome").eq("ativo", true);
  const { data: empresas } = await empresasQ;

  const divergencias: DivergenciaReconc[] = [];
  let totalComparados = 0;
  let totalFalhas = 0;

  for (const emp of empresas ?? []) {
    // Produtos mapeados pra essa empresa
    const { data: mapeamentos } = await sb
      .from("siso_produto_empresas")
      .select("produto_id, tiny_produto_id")
      .eq("empresa_id", emp.id)
      .limit(opts.limit ?? 100);

    if (!mapeamentos || mapeamentos.length === 0) continue;

    const produtoIds = mapeamentos.map((m) => m.produto_id);
    const { data: produtosInfo } = await sb
      .from("siso_produtos")
      .select("id, sku")
      .in("id", produtoIds);
    const skuPorId = new Map<string, string>();
    for (const p of (produtosInfo ?? []) as Array<{ id: string; sku: string }>) {
      skuPorId.set(p.id, p.sku);
    }

    // Saldo agregado WMS por produto (soma de todos galpões/locs)
    const { data: estoque } = await sb
      .from("siso_estoque")
      .select("produto_id, saldo")
      .in("produto_id", produtoIds);
    const saldoWmsPorProduto = new Map<string, number>();
    for (const e of (estoque ?? []) as Array<{ produto_id: string; saldo: number }>) {
      const atual = saldoWmsPorProduto.get(e.produto_id) ?? 0;
      saldoWmsPorProduto.set(e.produto_id, atual + Number(e.saldo ?? 0));
    }

    // Pra cada produto mapeado, busca saldo Tiny
    for (const m of mapeamentos) {
      const sku = skuPorId.get(m.produto_id) ?? "?";
      const saldoWms = saldoWmsPorProduto.get(m.produto_id) ?? 0;

      try {
        const { token } = await getValidTokenByEmpresa(emp.id);
        const tinyEstoque = await runWithEmpresa(emp.id, () =>
          getEstoque(token, m.tiny_produto_id as number),
        );
        const saldoTiny = (tinyEstoque.depositos ?? []).reduce(
          (acc, d) => acc + Number(d.saldo ?? 0),
          0,
        );
        totalComparados++;

        const delta = saldoWms - saldoTiny;
        if (Math.abs(delta) >= threshold) {
          divergencias.push({
            empresa_id: emp.id,
            empresa_nome: emp.nome,
            produto_id: m.produto_id,
            sku,
            tiny_produto_id: m.tiny_produto_id as number,
            saldo_wms: saldoWms,
            saldo_tiny: saldoTiny,
            delta,
          });
        }
      } catch (err) {
        totalFalhas++;
        logger.warn(LOG_SOURCE, "falha ao consultar Tiny", {
          empresa_id: emp.id,
          produto_id: m.produto_id,
          tiny_produto_id: m.tiny_produto_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logger.info(LOG_SOURCE, "reconciliação concluída", {
    divergencias: String(divergencias.length),
    comparados: String(totalComparados),
    falhas: String(totalFalhas),
  });

  return {
    divergencias,
    total_produtos_comparados: totalComparados,
    total_falhas_tiny: totalFalhas,
    computado_em: new Date().toISOString(),
  };
}
