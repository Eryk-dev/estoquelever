-- P4 finding 6.2 + 8.9: 2 new granular permissions
--   operacoes.devolucoes_classificar — só admin + operador (vendedor/comprador FORA)
--   operacoes.retroativo            — só admin + operador
--
-- A permissão `operacoes.devolucoes` continua existindo (label mudou pra
-- "Ver devoluções (read)") — mantém compat com requireWarehouseAccess.

-- 1. Grant operacoes.devolucoes_classificar pras roles admin + operador*
INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
SELECT r.id, 'operacoes.devolucoes_classificar'
FROM siso_roles r
WHERE r.codigo IN ('admin', 'operador', 'operador_cwb', 'operador_sp')
ON CONFLICT (role_id, permissao_codigo) DO NOTHING;

-- 2. Grant operacoes.retroativo pras mesmas roles
INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
SELECT r.id, 'operacoes.retroativo'
FROM siso_roles r
WHERE r.codigo IN ('admin', 'operador', 'operador_cwb', 'operador_sp')
ON CONFLICT (role_id, permissao_codigo) DO NOTHING;

-- 3. Verify (will fail loud if rows missing — okay for CI)
DO $$
DECLARE c int;
BEGIN
  SELECT count(*) INTO c FROM siso_role_permissoes
  WHERE permissao_codigo IN ('operacoes.devolucoes_classificar', 'operacoes.retroativo');
  IF c < 8 THEN  -- 2 perms × 4 roles = 8
    RAISE EXCEPTION 'P4 perm seed incompleto: encontrado % grants (esperado ≥ 8)', c;
  END IF;
END $$;
