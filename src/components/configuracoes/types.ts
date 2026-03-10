// Local types for the configuracoes feature

export interface TinyConnection {
  id: string;
  filial: "CWB" | "SP";
  nome_empresa: string;
  cnpj: string;
  ativo: boolean;
  ultimo_teste_em: string | null;
  ultimo_teste_ok: boolean | null;
  criado_em: string;
  atualizado_em: string;
  has_client_id: boolean;
  client_id_preview: string | null;
  has_client_secret: boolean;
  is_authorized: boolean;
  token_expires_at: string | null;
  deposito_id: number | null;
  deposito_nome: string | null;
}

export interface DepositoOption {
  id: number;
  nome: string;
}

export interface EmpresaHierarquia {
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

export interface GalpaoHierarquia {
  id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  printnode_printer_id: number | null;
  printnode_printer_nome: string | null;
  siso_empresas: EmpresaHierarquia[];
}

export interface UsuarioPrintNode {
  id: string;
  nome: string;
  cargo: string;
  printnode_printer_id: number | null;
  printnode_printer_nome: string | null;
}

export interface GrupoInfo {
  id: string;
  nome: string;
  descricao: string | null;
  siso_grupo_empresas: Array<{
    id: string;
    tier: number;
    siso_empresas: { id: string; nome: string; cnpj: string };
  }>;
}
