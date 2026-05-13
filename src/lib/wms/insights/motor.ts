// Motor de insights: executa cada regra ativa e persiste resultados em
// siso_wms_insights_ativos. Respeita cooldown_min (não re-dispara mesma
// regra + entidade dentro do cooldown). Marca expira_em = now() + expira_min.
//
// Chamado pelo cron /api/wms/insights/refresh a cada 5min.

import { createServiceClient } from "@/lib/supabase-server";
import type { InsightRegra } from "./types";

interface RegraResultado {
  entidade_tipo: string | null;
  entidade_id: string | null;
  titulo: string;
  descricao: string;
  dados: Record<string, unknown>;
  galpao_id: string | null;
  link: string | null;
}

interface ExecucaoResumo {
  codigo: string;
  status: "ok" | "erro";
  resultados: number;
  inseridos: number;
  ignorados_cooldown: number;
  mensagem?: string;
}

export async function executarRefreshCompleto(): Promise<ExecucaoResumo[]> {
  const sb = createServiceClient();
  const { data: regras, error } = await sb
    .from("siso_wms_insights_regras")
    .select("*")
    .eq("ativa", true);
  if (error) throw new Error(error.message);

  const resumos: ExecucaoResumo[] = [];
  for (const r of (regras ?? []) as InsightRegra[]) {
    resumos.push(await executarRegra(r));
  }
  return resumos;
}

export async function executarRegra(regra: InsightRegra): Promise<ExecucaoResumo> {
  const sb = createServiceClient();
  try {
    const { data: resultados, error } = await sb.rpc(
      "wms_insights_executar_regra",
      { p_codigo: regra.codigo, p_threshold: regra.threshold },
    );
    if (error) throw new Error(error.message);

    const cooldownCutoff = new Date(
      Date.now() - regra.cooldown_min * 60_000,
    ).toISOString();
    const expiraEm = new Date(
      Date.now() + regra.expira_min * 60_000,
    ).toISOString();

    let inseridos = 0;
    let ignorados = 0;
    for (const r of (resultados ?? []) as RegraResultado[]) {
      // Verifica cooldown: existe insight da mesma regra+entidade dentro da janela?
      const { data: recente } = await sb
        .from("siso_wms_insights_ativos")
        .select("id")
        .eq("regra_id", regra.id)
        .eq("entidade_tipo", r.entidade_tipo ?? "")
        .eq("entidade_id", r.entidade_id ?? "")
        .gte("criado_em", cooldownCutoff)
        .limit(1);
      if (recente && recente.length > 0) {
        ignorados++;
        continue;
      }
      // Upsert respeitando índice único (regra + entidade WHERE dispensado_em IS NULL)
      const { error: insErr } = await sb.from("siso_wms_insights_ativos").insert({
        regra_id: regra.id,
        categoria: regra.categoria,
        severidade: regra.severidade,
        entidade_tipo: r.entidade_tipo,
        entidade_id: r.entidade_id,
        titulo: r.titulo,
        descricao: r.descricao,
        dados: r.dados,
        galpao_id: r.galpao_id,
        link: r.link,
        expira_em: expiraEm,
      });
      if (!insErr) inseridos++;
    }

    // Auto-expira insights antigos da regra que não voltaram (rolling refresh)
    await sb
      .from("siso_wms_insights_ativos")
      .update({ expira_em: new Date().toISOString() })
      .eq("regra_id", regra.id)
      .is("dispensado_em", null)
      .lt("criado_em", new Date(Date.now() - 60 * 60_000).toISOString());

    await sb
      .from("siso_wms_insights_regras")
      .update({
        ultima_execucao_em: new Date().toISOString(),
        ultima_execucao_status: "ok",
        ultima_execucao_mensagem: null,
        falhas_consecutivas: 0,
      })
      .eq("id", regra.id);

    return {
      codigo: regra.codigo,
      status: "ok",
      resultados: (resultados ?? []).length,
      inseridos,
      ignorados_cooldown: ignorados,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const novasFalhas = (regra.falhas_consecutivas ?? 0) + 1;
    await sb
      .from("siso_wms_insights_regras")
      .update({
        ultima_execucao_em: new Date().toISOString(),
        ultima_execucao_status: "erro",
        ultima_execucao_mensagem: msg.slice(0, 500),
        falhas_consecutivas: novasFalhas,
        // Auto-desativa após 3 falhas seguidas pra não inundar logs
        ativa: novasFalhas >= 3 ? false : regra.ativa,
      })
      .eq("id", regra.id);

    return {
      codigo: regra.codigo,
      status: "erro",
      resultados: 0,
      inseridos: 0,
      ignorados_cooldown: 0,
      mensagem: msg,
    };
  }
}
