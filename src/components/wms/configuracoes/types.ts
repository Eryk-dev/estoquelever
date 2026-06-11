// Tipos compartilhados entre as abas de /wms/configuracoes.
// Reflete o payload de /api/admin/galpoes (com FK aninhada de empresas) já no
// modelo novo: empresa NÃO pertence a um galpão; tem 0..N preferenciais.

export interface PreferencialRef {
  id: string;
  nome: string;
}

export interface EmpresaHierarquiaWms {
  id: string;
  nome: string;
  cnpj: string;
  ativo: boolean;
  /**
   * Corte de migração (ISO timestamp): pedidos Tiny criados antes não entram
   * no WMS (webhook ignora, polling clampa a janela). null = sem corte.
   */
  sync_pedidos_desde: string | null;
  /**
   * Galpões preferenciais (geo-priority no roteamento). Pode estar vazio.
   * Vem de siso_empresa_galpoes_preferenciais (N:N).
   */
  preferenciais: PreferencialRef[];
  conexao: {
    id: string;
    ativo: boolean;
    conectado: boolean;
    ultimoTesteOk: boolean | null;
    depositoId: number | null;
    depositoNome: string | null;
  } | null;
}

export interface GalpaoHierarquiaWms {
  id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  cidade: string | null;
  estado: string | null;
  pais: string | null;
  /**
   * IMPORTANTE — aqui aparecem as empresas em que siso_empresas.galpao_id
   * espelha esse galpão (i.e. primeiro preferencial). Pra ver TODAS as
   * empresas (incluindo as que têm esse galpão como preferencial não-primeiro)
   * use o array `preferenciais` de cada empresa em outras instâncias.
   */
  siso_empresas: EmpresaHierarquiaWms[];
}
