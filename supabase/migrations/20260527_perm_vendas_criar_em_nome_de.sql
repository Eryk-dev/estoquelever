-- ─────────────────────────────────────────────────────────────────
-- Permissão: vendas.criar_em_nome_de
--
-- Atribui a permissão de "criar venda em nome de outro vendedor"
-- pras roles admin + operador + operador_cwb + operador_sp. Vendedor
-- regular NÃO recebe essa perm (não pode atribuir ao colega).
--
-- A permissão é declarada em src/lib/permissions.ts; aqui só plumbamos
-- o vínculo role→permissao via INSERT idempotente.
--
-- Plan ref: docs/superpowers/plans/2026-05-26-wms-fix-p6-estado-fantasma-cleanups.md
-- Task: E.10.2 [#P6-6.38 #P6-7.10]
-- ─────────────────────────────────────────────────────────────────

BEGIN;

INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
SELECT r.id, 'vendas.criar_em_nome_de'
FROM siso_roles r
WHERE r.codigo IN ('admin', 'operador', 'operador_cwb', 'operador_sp')
ON CONFLICT (role_id, permissao_codigo) DO NOTHING;

COMMIT;
