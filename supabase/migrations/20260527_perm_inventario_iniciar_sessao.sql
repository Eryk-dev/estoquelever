-- ─────────────────────────────────────────────────────────────────
-- Permissão: inventario.iniciar_sessao
--
-- Atribui a permissão de "auto-iniciar sessão (ao entrar party)" pras
-- roles admin + operador_cwb + operador_sp. Operador regular e vendedor
-- NÃO recebem (operador padrão também não — só o admin/operadores de
-- galpão específicos podem fazer essa transição implícita).
--
-- Por que isso importa: entrarParty arrasta uma sessão "planejada" pra
-- "em_andamento" via iniciarSessao. Quando um operador entra antes do
-- supervisor formalmente iniciar a sessão, o sistema acaba transitando
-- silenciosamente — virando estado fantasma. Esta perm fecha o gate.
--
-- A permissão é declarada em src/lib/permissions.ts; aqui só plumbamos
-- o vínculo role→permissao via INSERT idempotente.
--
-- Plan ref: docs/superpowers/plans/2026-05-26-wms-fix-p6-estado-fantasma-cleanups.md
-- Task: E.23 [#P6-4.14]
-- ─────────────────────────────────────────────────────────────────

BEGIN;

INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
SELECT r.id, 'inventario.iniciar_sessao'
FROM siso_roles r
WHERE r.codigo IN ('admin', 'operador_cwb', 'operador_sp')
ON CONFLICT (role_id, permissao_codigo) DO NOTHING;

COMMIT;
