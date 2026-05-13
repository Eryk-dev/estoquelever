// Tipos compartilhados entre as três abas de /wms/configuracoes.
// Reflete o payload de /api/admin/galpoes (com FK aninhada de empresas).

export interface EmpresaHierarquiaWms {
  id: string;
  nome: string;
  cnpj: string;
  ativo: boolean;
  grupo: { id: string; nome: string } | null;
  tier: number | null;
  grupoEmpresaId: string | null;
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
  siso_empresas: EmpresaHierarquiaWms[];
}

export interface GrupoInfoWms {
  id: string;
  nome: string;
  descricao: string | null;
  siso_grupo_empresas: Array<{
    id: string;
    tier: number;
    siso_empresas: { id: string; nome: string; cnpj: string };
  }>;
}
