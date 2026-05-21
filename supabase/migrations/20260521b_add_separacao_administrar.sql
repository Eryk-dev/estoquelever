-- Adiciona permissão separacao.administrar ao registro de roles
-- (criada após o seed inicial da Task 1)

BEGIN;

-- Admin recebe automaticamente (regra: admin tem todas as 31 perms)
INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
SELECT id, 'separacao.administrar'
FROM siso_roles
WHERE codigo = 'admin'
ON CONFLICT (role_id, permissao_codigo) DO NOTHING;

COMMIT;
