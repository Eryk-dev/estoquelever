-- Fix-D #5.7: perm operacoes.imprimir pra fila de impressões.
-- Permissão declarada em src/lib/permissions.ts; aqui só plumbamos role→perm.

INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
SELECT r.id, 'operacoes.imprimir'
  FROM siso_roles r
 WHERE r.codigo IN ('admin', 'operador', 'operador_cwb', 'operador_sp')
ON CONFLICT (role_id, permissao_codigo) DO NOTHING;
