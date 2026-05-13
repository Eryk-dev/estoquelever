// Tipos compartilhados entre lib, API routes e UI do módulo Insights.

export type InsightCategoria =
  | "pessoas"
  | "fluxo"
  | "estoque"
  | "financeiro"
  | "devolucoes";

export type InsightSeveridade = "critico" | "alerta" | "info";

export interface InsightRegra {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  categoria: InsightCategoria;
  severidade: InsightSeveridade;
  ativa: boolean;
  threshold: Record<string, unknown>;
  cooldown_min: number;
  expira_min: number;
  ultima_execucao_em: string | null;
  ultima_execucao_status: "ok" | "erro" | null;
  ultima_execucao_mensagem: string | null;
  falhas_consecutivas: number;
}

export interface InsightAtivo {
  id: string;
  regra_id: string;
  categoria: InsightCategoria;
  severidade: InsightSeveridade;
  entidade_tipo: string | null;
  entidade_id: string | null;
  titulo: string;
  descricao: string;
  dados: Record<string, unknown>;
  galpao_id: string | null;
  link: string | null;
  criado_em: string;
  expira_em: string;
  dispensado_em: string | null;
  dispensado_por: string | null;
}

export interface HubKpis {
  throughput_hoje: number;
  throughput_7d_avg: number;
  delta_throughput_pct: number | null;
  lead_time_p50_24h_min: number;
  lead_time_p50_7d_min: number;
  delta_lead_time_pct: number | null;
  acuracidade_pct: number | null;
  cobertura_critico: number;
  capital_total: number;
  devolucoes_taxa_30d: number | null;
}

export interface RankingOperador {
  usuario_id: string;
  usuario_nome: string;
  funcao_efetiva:
    | "separacao"
    | "embalagem"
    | "guarda"
    | "contagem"
    | "sem_atividade";
  pedidos_separados: number;
  pedidos_embalados: number;
  pendencias_guardadas: number;
  locs_contadas: number;
  acoes_outras: number;
  horas_ativas: number;
  pedidos_por_hora: number | null;
  tempo_medio_separacao_min: number | null;
  tempo_medio_embalagem_min: number | null;
  tempo_medio_guarda_min: number | null;
  tempo_medio_contagem_min: number | null;
  acuracidade_pct: number | null;
  divergencias: number;
  ajustes_manuais: number;
}

export interface FunilEtapa {
  etapa: string;
  ordem: number;
  tempo_medio_min: number | null;
  acumulado_atual: number;
}

export interface LeadTimePercentil {
  periodo: "24h" | "7d" | "30d";
  qtd: number;
  p50_min: number | null;
  p90_min: number | null;
  p95_min: number | null;
  media_min: number | null;
}

export interface ThroughputDia {
  dia: string;
  pedidos: number;
  dow: number;
}

export interface ThroughputHora {
  hora: number;
  hoje: number;
  media_14d: number;
  delta_pct: number | null;
}

export interface PessoaDetalheDia {
  dia: string;
  pedidos_separados: number;
  pendencias_guardadas: number;
  locs_contadas: number;
  acoes_outras: number;
  divergencias: number;
}

export interface EstoqueQuadrantePonto {
  produto_id: string;
  sku: string;
  giro_diario: number;
  dias_cobertura: number | null;
  saldo: number;
  valor: number;
  status_cobertura: string;
  curva: "A" | "B" | "C";
}

export interface DevolucaoAgregado {
  classificacao: string;
  qtd: number;
  qtd_pendentes: number;
}

export interface FinanceiroValor {
  empresa_dona_id: string;
  empresa_nome: string;
  galpao_id: string;
  galpao_nome: string;
  qtd_skus: number;
  saldo_total: number;
  valor_total: number;
  valor_curva_a: number;
  valor_curva_b: number;
  valor_curva_c: number;
}
