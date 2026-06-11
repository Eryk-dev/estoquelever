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
}

/**
 * Bulk-load idempotente: pra cada (produto, empresa) com mapeamento, busca
 * saldo atual no Tiny e cria mov 'inventario_inicial' na localização
 * DEFAULT-PICKING. A empresa do Tiny vai como TAG histórica
 * (`empresa_compradora_id`) — não é mais coordenada do estoque.
 *
 * Idempotência: se já existe mov 'inventario_inicial' pra essa tripla
 * (produto, galpao, localizacao) com a mesma `empresa_compradora_id`, pula.
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
    .select(`produto_id, empresa_id, tiny_produto_id`)
    .eq("ativo", true);
  if (error) throw error;

  // Resolve o galpão de cada empresa via siso_empresa_galpoes_preferenciais
  // (fonte de verdade; siso_empresas.galpao_id é DEPRECADA). Sem coluna de
  // prioridade na tabela — usa o preferencial mais antigo (criado_em, depois
  // galpao_id pra desempate estável) como principal.
  const { data: prefs, error: prefsErr } = await sb
    .from("siso_empresa_galpoes_preferenciais")
    .select("empresa_id, galpao_id")
    .order("criado_em", { ascending: true })
    .order("galpao_id", { ascending: true });
  if (prefsErr) throw prefsErr;
  const galpaoPorEmpresa = new Map<string, string>();
  for (const p of (prefs ?? []) as Array<{
    empresa_id: string;
    galpao_id: string;
  }>) {
    if (!galpaoPorEmpresa.has(p.empresa_id)) {
      galpaoPorEmpresa.set(p.empresa_id, p.galpao_id);
    }
  }

  const tokenCache = new Map<string, string>();
  const paresList = (pares ?? []) as unknown as ParRow[];

  for (const par of paresList) {
    try {
      const galpaoId = galpaoPorEmpresa.get(par.empresa_id);
      if (!galpaoId) {
        logger.error("wms.snapshot", "empresa sem galpão preferencial", {
          empresa_id: par.empresa_id,
          produto_id: par.produto_id,
        });
        pulados++;
        continue;
      }

      const { data: loc } = await sb
        .from("siso_localizacoes")
        .select("id")
        .eq("galpao_id", galpaoId)
        .eq("codigo", "DEFAULT-PICKING")
        .single();
      if (!loc) continue;

      const tripla = {
        produto_id: par.produto_id,
        galpao_id: galpaoId,
        localizacao_id: loc.id,
      };

      // Idempotência: pula se já tem snapshot com a mesma tag de empresa
      const { data: jaExiste } = await sb
        .from("siso_movimentacoes")
        .select("id")
        .match(tripla)
        .eq("origem_tipo", "inventario_inicial")
        .eq("empresa_compradora_id", par.empresa_id)
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
          tripla,
          tipo: "E",
          qty: totalSaldo,
          origem_tipo: "inventario_inicial",
          empresa_compradora_id: par.empresa_id,
          motivo: "snapshot inicial Fase 0",
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
