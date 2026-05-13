// Wrappers tipados sobre RPCs do Insights. Usados em todas as API routes.
import { createServiceClient } from "@/lib/supabase-server";
import type {
  DevolucaoAgregado,
  EstoqueQuadrantePonto,
  FinanceiroValor,
  FunilEtapa,
  HubKpis,
  InsightAtivo,
  InsightCategoria,
  InsightRegra,
  LeadTimePercentil,
  PessoaDetalheDia,
  RankingOperador,
  ThroughputDia,
  ThroughputHora,
} from "./types";

function sb() {
  return createServiceClient();
}

export async function getHubKpis(galpaoId: string | null): Promise<HubKpis> {
  const { data, error } = await sb().rpc("wms_insights_hub_kpis", {
    p_galpao_id: galpaoId,
  });
  if (error) throw new Error(error.message);
  return data as HubKpis;
}

export async function getInsightsAtivos(
  categoria?: InsightCategoria | "all",
  galpaoId?: string | null,
  limit = 6,
): Promise<InsightAtivo[]> {
  let q = sb()
    .from("siso_wms_insights_ativos")
    .select("*")
    .is("dispensado_em", null)
    .gt("expira_em", new Date().toISOString())
    .order("severidade", { ascending: true }) // critico vem antes alfabeticamente que alerta/info
    .order("criado_em", { ascending: false })
    .limit(limit);
  if (categoria && categoria !== "all") q = q.eq("categoria", categoria);
  if (galpaoId) q = q.or(`galpao_id.eq.${galpaoId},galpao_id.is.null`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as InsightAtivo[];
}

export async function getRankingOperadores(
  galpaoId: string | null,
  dias = 7,
): Promise<RankingOperador[]> {
  const { data, error } = await sb().rpc("wms_insights_ranking_operadores", {
    p_galpao_id: galpaoId,
    p_dias: dias,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as RankingOperador[];
}

export async function getPessoaDetalhe(
  userId: string,
  dias = 30,
): Promise<PessoaDetalheDia[]> {
  const { data, error } = await sb().rpc("wms_insights_pessoa_detalhe", {
    p_user_id: userId,
    p_dias: dias,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as PessoaDetalheDia[];
}

export async function getFunilEtapas(
  galpaoId: string | null,
  dias = 7,
): Promise<FunilEtapa[]> {
  const { data, error } = await sb().rpc("wms_insights_funil_etapas", {
    p_galpao_id: galpaoId,
    p_dias: dias,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as FunilEtapa[];
}

export async function getLeadTimePercentis(
  galpaoId: string | null,
): Promise<LeadTimePercentil[]> {
  const { data, error } = await sb().rpc("wms_insights_lead_time_percentis", {
    p_galpao_id: galpaoId,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as LeadTimePercentil[];
}

export async function getThroughputDiario(
  galpaoId: string | null,
  dias = 30,
): Promise<ThroughputDia[]> {
  const { data, error } = await sb().rpc("wms_insights_throughput_diario", {
    p_galpao_id: galpaoId,
    p_dias: dias,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ThroughputDia[];
}

export async function getThroughputHora(
  galpaoId: string | null,
): Promise<ThroughputHora[]> {
  const { data, error } = await sb().rpc("wms_insights_throughput_hora", {
    p_galpao_id: galpaoId,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ThroughputHora[];
}

export async function getEstoqueQuadrante(
  galpaoId: string | null,
  empresaDonaId: string | null,
  limit = 500,
): Promise<EstoqueQuadrantePonto[]> {
  const { data, error } = await sb().rpc("wms_insights_estoque_quadrante", {
    p_galpao_id: galpaoId,
    p_empresa_dona_id: empresaDonaId,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as EstoqueQuadrantePonto[];
}

export async function getDevolucoesAgregado(
  dias = 30,
): Promise<DevolucaoAgregado[]> {
  const { data, error } = await sb().rpc("wms_insights_devolucoes_agregado", {
    p_dias: dias,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as DevolucaoAgregado[];
}

export async function getEstoqueValorAtual(
  galpaoId: string | null,
): Promise<FinanceiroValor[]> {
  const { data, error } = await sb().rpc("wms_insights_estoque_valor_atual", {
    p_galpao_id: galpaoId,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as FinanceiroValor[];
}

export async function listarRegras(): Promise<InsightRegra[]> {
  const { data, error } = await sb()
    .from("siso_wms_insights_regras")
    .select("*")
    .order("categoria", { ascending: true })
    .order("codigo", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as InsightRegra[];
}

export async function atualizarRegra(
  id: string,
  patch: Partial<
    Pick<InsightRegra, "ativa" | "threshold" | "cooldown_min" | "expira_min">
  >,
): Promise<InsightRegra> {
  const { data, error } = await sb()
    .from("siso_wms_insights_regras")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as InsightRegra;
}

export async function testarRegra(codigo: string, threshold: Record<string, unknown>) {
  const { data, error } = await sb().rpc("wms_insights_executar_regra", {
    p_codigo: codigo,
    p_threshold: threshold,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function dispensarInsight(id: string, userId: string) {
  const { error } = await sb()
    .from("siso_wms_insights_ativos")
    .update({ dispensado_em: new Date().toISOString(), dispensado_por: userId })
    .eq("id", id);
  if (error) throw new Error(error.message);
}
