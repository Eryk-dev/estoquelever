-- P2-EST-02 — Usuário "Sistema (automação)" pra crons/automações.
--
-- O cron de transferências (transferencias/cleanup/route.ts) estornava movs
-- passando usuario_id = '00000000-0000-0000-0000-000000000000', mas esse uuid
-- nunca existiu em siso_usuarios. siso_movimentacoes.usuario_id tem FK pra
-- siso_usuarios(id) → toda inserção de mov pelo cron violava a FK → o cron
-- inteiro lançava e ficava MORTO (nenhuma transferência abandonada era
-- cancelada). Idem pra qualquer automação futura que carimbe usuario_id=zero.
--
-- FIX: criar a linha do usuário sistema com o uuid-zero. Não-logável:
--   · ativo=false → o login retorna 403 "Usuário desativado" antes de checar PIN
--     (auth/login/route.ts:42).
--   · pin='----' → coluna é character(4); valor não-numérico jamais casa com um
--     PIN digitado (4 dígitos). Dupla barreira além do ativo=false.
--   · nome 'Sistema (automação)' → improvável de ser digitado; e nem chegaria
--     a comparar PIN por causa do ativo=false.
--
-- cargo e cargos são NOT NULL: cargo usa 'operador_cwb' (mesmo default da
-- coluna, role neutro existente — a CHECK de cargo foi dropada em 20260521 e
-- não há gate por cargo no código; permissões reais vêm de siso_usuario_roles,
-- que deixamos vazio → zero permissões). cargos fica '{}' (default).
--
-- Idempotente: ON CONFLICT (id) DO NOTHING.

INSERT INTO siso_usuarios (id, nome, pin, cargo, cargos, ativo)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'Sistema (automação)',
  '----',
  'operador_cwb',
  '{}'::text[],
  false
)
ON CONFLICT (id) DO NOTHING;
