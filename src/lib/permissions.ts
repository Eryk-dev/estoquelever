export const MODULOS_ORDEM = [
  "vendas",
  "visibilidade",
  "operacoes",
  "inventario",
  "insights",
  "relatorios",
  "cadastros",
  "sistema",
] as const;

export type ModuloId = (typeof MODULOS_ORDEM)[number];

type PermissionEntry = { modulo: ModuloId; label: string };

export const PERMISSIONS = {
  // ── Vendas ──
  "vendas.ver":                { modulo: "vendas",   label: "Ver Vendas Diretas" },
  "vendas.criar":              { modulo: "vendas",   label: "Criar venda manual" },
  "vendas.criar_em_nome_de":   { modulo: "vendas",   label: "Criar venda em nome de outro vendedor" },
  "pedidos.ver":          { modulo: "vendas",        label: "Ver Pedidos (marketplace)" },
  "pedidos.aprovar":      { modulo: "vendas",        label: "Aprovar/rejeitar pedido" },
  "separacao.ver":        { modulo: "vendas",        label: "Ver Separação" },
  "separacao.executar":   { modulo: "vendas",        label: "Bipar/separar pedidos" },
  "separacao.administrar": { modulo: "vendas",       label: "Forçar status / voltar etapa / reimprimir" },
  "compras.ver":          { modulo: "vendas",        label: "Ver Compras" },
  "compras.executar":     { modulo: "vendas",        label: "Comprar/receber/cancelar OC" },
  "pedidos.estornar":         { modulo: "vendas",    label: "Estornar pedido (Banner D10 admin)" },
  "pedidos.liberar_reservas": { modulo: "vendas",    label: "Liberar reservas do pedido (D2 override admin)" },

  // ── Visibilidade ──
  "estoque.ver":          { modulo: "visibilidade",  label: "Ver Estoque" },
  "cobertura.ver":        { modulo: "visibilidade",  label: "Ver Cobertura" },

  // ── Operações ──
  "operacoes.transferir":           { modulo: "operacoes", label: "Transferir entre galpões" },
  "operacoes.replenishment":        { modulo: "operacoes", label: "Realocar intra-galpão" },
  "operacoes.devolucoes":           { modulo: "operacoes", label: "Ver devoluções (read)" },
  "operacoes.devolucoes_classificar": { modulo: "operacoes", label: "Classificar devolução (escrita)" },
  "operacoes.receber":              { modulo: "operacoes", label: "Receber NF (dock)" },
  "operacoes.guarda":               { modulo: "operacoes", label: "Put-away" },
  "operacoes.ajuste_manual":        { modulo: "operacoes", label: "Ajuste manual de saldo" },
  "operacoes.retroativo":           { modulo: "operacoes", label: "Lançamento retroativo + reconciliar" },
  "operacoes.imprimir":             { modulo: "operacoes", label: "Ver fila de impressões + retry" },

  // ── Inventário ──
  "inventario.ver":            { modulo: "inventario", label: "Ver sessões" },
  "inventario.executar":       { modulo: "inventario", label: "Contar (handheld)" },
  "inventario.supervisionar":  { modulo: "inventario", label: "Criar/aprovar/aplicar sessão" },
  "inventario.iniciar_sessao": { modulo: "inventario", label: "Auto-iniciar sessão (ao entrar party)" },

  // ── Insights & Relatórios ──
  "insights.ver":          { modulo: "insights",    label: "Ver insights" },
  "insights.financeiro":   { modulo: "insights",    label: "Ver insights financeiros" },
  "insights.regras":       { modulo: "insights",    label: "Gerenciar regras" },
  "relatorios.ver":        { modulo: "relatorios",  label: "Ver relatórios" },

  // ── Cadastros ──
  "produtos.editar":       { modulo: "cadastros",   label: "Editar produtos/Cross" },
  "localizacoes.editar":   { modulo: "cadastros",   label: "Editar localizações" },
  "fornecedores.editar":   { modulo: "cadastros",   label: "Editar fornecedores" },

  // ── Sistema (sempre admin) ──
  "sistema.usuarios":         { modulo: "sistema",  label: "Gerenciar usuários" },
  "sistema.roles":            { modulo: "sistema",  label: "Gerenciar roles e permissões" },
  "sistema.conexoes":         { modulo: "sistema",  label: "Gerenciar conexões Tiny/ML/PrintNode" },
  "sistema.galpoes_empresas": { modulo: "sistema",  label: "Gerenciar galpões/empresas/grupos" },
} as const satisfies Record<string, PermissionEntry>;

export type PermissaoCodigo = keyof typeof PERMISSIONS;
export const PERMISSAO_CODIGOS = Object.keys(PERMISSIONS) as PermissaoCodigo[];

export type PermissoesPort = { permissoes: Set<string> };

/**
 * Check that the session has ALL of the given permissions.
 *
 * - Returns `false` when session is null (no auth).
 * - Returns `true` when `required` is empty (vacuously satisfied — useful
 *   for filtering nav items where an empty `requires` means "show to any
 *   authenticated user").
 * - Returns `true` only when EVERY required code is in the session set.
 */
export function userCan(
  session: PermissoesPort | null,
  ...required: PermissaoCodigo[]
): boolean {
  if (!session) return false;
  return required.every((p) => session.permissoes.has(p));
}

/**
 * Check that the session has AT LEAST ONE of the given permissions.
 *
 * - Returns `false` when session is null OR `required` is empty.
 * - Returns `true` when at least one required code is in the session set.
 *
 * Note: asymmetric with `userCan` on empty `required` (this returns false,
 * `userCan` returns true). Empty OR-of-nothing is vacuously false.
 */
export function userCanAny(
  session: PermissoesPort | null,
  ...required: PermissaoCodigo[]
): boolean {
  if (!session) return false;
  if (required.length === 0) return false;
  return required.some((p) => session.permissoes.has(p));
}

export const MODULOS_LABEL: Record<ModuloId, string> = {
  vendas: "Vendas",
  visibilidade: "Visibilidade",
  operacoes: "Operações",
  inventario: "Inventário",
  insights: "Insights",
  relatorios: "Relatórios",
  cadastros: "Cadastros",
  sistema: "Sistema",
};
