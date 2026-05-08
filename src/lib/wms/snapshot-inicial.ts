import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import { getEstoque } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { logger } from "@/lib/logger";

interface SnapshotResult {
  total: number;
  criados: number;
  pulados: number;
  erros: number;
}

interface ParRow {
  produto_id: string;
  empresa_id: string;
  tiny_produto_id: number;
  empresa: { galpao_id: string } | null;
}

/**
 * Bulk-load idempotente: pra cada (produto, empresa) com mapeamento, busca saldo atual no Tiny
 * e cria mov 'inventario_inicial' na localização DEFAULT-PICKING.
 *
 * Idempotência: se já existe mov 'inventario_inicial' pra essa quádrupla, pula.
 *
 * Roda 1x na Fase 0. Pode levar horas (3000+ chamadas Tiny).
 */
export async function executarSnapshotInicial(
  opts: { dryRun?: boolean } = {},
): Promise<SnapshotResult> {
  const sb = createServiceClient();
  let criados = 0;
  let pulados = 0;
  let erros = 0;

  const { data: pares, error } = await sb
    .from("siso_produto_empresas")
    .select(
      `
        produto_id, empresa_id, tiny_produto_id,
        empresa:siso_empresas(galpao_id)
      `,
    )
    .eq("ativo", true);
  if (error) throw error;

  const tokenCache = new Map<string, string>();
  const paresList = (pares ?? []) as unknown as ParRow[];

  for (const par of paresList) {
    try {
      const galpaoId = par.empresa?.galpao_id;
      if (!galpaoId) continue;

      const { data: loc } = await sb
        .from("siso_localizacoes")
        .select("id")
        .eq("galpao_id", galpaoId)
        .eq("codigo", "DEFAULT-PICKING")
        .single();
      if (!loc) continue;

      const quadrupla = {
        produto_id: par.produto_id,
        empresa_dona_id: par.empresa_id,
        galpao_id: galpaoId,
        localizacao_id: loc.id,
      };

      const { data: jaExiste } = await sb
        .from("siso_movimentacoes")
        .select("id")
        .match(quadrupla)
        .eq("origem_tipo", "inventario_inicial")
        .limit(1);
      if (jaExiste && jaExiste.length > 0) {
        pulados++;
        continue;
      }

      let token = tokenCache.get(par.empresa_id);
      if (!token) {
        const t = await getValidTokenByEmpresa(par.empresa_id);
        token = t.token;
        tokenCache.set(par.empresa_id, token);
      }

      const estoque = await runWithEmpresa(par.empresa_id, () =>
        getEstoque(token!, par.tiny_produto_id),
      );
      const totalSaldo = (estoque?.depositos ?? []).reduce(
        (sum, d) => sum + Number(d.saldo ?? 0),
        0,
      );
      if (totalSaldo <= 0) {
        pulados++;
        continue;
      }

      if (!opts.dryRun) {
        await inserirMovimentacao({
          quadrupla,
          tipo: "E",
          qty: totalSaldo,
          origem_tipo: "inventario_inicial",
          observacoes: "snapshot inicial Fase 0",
        });
      }
      criados++;
    } catch (e) {
      logger.error("wms.snapshot", "erro em par", { par, e: String(e) });
      erros++;
    }
  }

  return { total: paresList.length, criados, pulados, erros };
}
