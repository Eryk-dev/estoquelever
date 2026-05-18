import type { Decisao, StatusSeparacao } from "@/types";

export interface CompraStatsData {
  total: number;
  aguardando: number;
  comprado: number;
  recebido: number;
  indisponivel: number;
  equivalente_pendente: number;
  cancelamento_pendente: number;
  oc_pendente: number;
  itens: Array<{
    sku: string;
    descricao: string;
    quantidade: number;
    compra_status: string | null;
    fornecedor_oc: string | null;
    imagem_url: string | null;
  }>;
}

export interface SeparacaoPedido {
  id: string;
  numero_nf: string;
  numero_ec: string | null;
  numero_pedido: string;
  cliente: string | null;
  nome_ecommerce: string | null;
  uf: string | null;
  cidade: string | null;
  forma_envio: string | null;
  data_pedido: string;
  embalagem_concluida_em?: string | null;
  empresa_origem_nome: string | null;
  filial_origem: string | null;
  decisao_final: Decisao | null;
  status_separacao: StatusSeparacao;
  marcadores: string[];
  total_itens: number;
  itens_marcados: number;
  itens_bipados: number;
  galpao_id: string | null;
  compra_stats: CompraStatsData | null;
  etiqueta_status: string | null;
  etiqueta_pronta: boolean;
  nf_emitida: boolean;
  agrupamento_criado: boolean;
  separacao_tags: string[];
  encaminhado_de: string | null;
}
