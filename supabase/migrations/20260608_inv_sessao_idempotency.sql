-- Remove o limite P055 (no máx. 1 sessão de inventário não-cancelada/não-contínua
-- por galpão por dia). O usuário precisa criar quantas sessões quiser por dia.
--
-- No lugar do limite duro, guarda anti-duplo-clique via idempotency_key: os 2
-- requests de um duplo-clique acidental carregam a MESMA key (gerada 1x pelo
-- cliente por intenção de criação) e colidem no índice único parcial
-- uq_inv_sessao_idempotency. O app (criarSessao) traduz a colisão devolvendo a
-- sessão já criada — no-op idempotente, sem duplicar nem estourar erro. Uma 2ª
-- sessão INTENCIONAL usa key nova e passa normal.
--
-- NOTA (prod populada): em prod com volume, construir o índice CONCURRENTLY,
-- FORA do BEGIN/COMMIT. Inline é aceitável só pra staging (volume baixo).

BEGIN;

-- 1. Derruba o limite por (galpão, dia) — P055.
DROP INDEX IF EXISTS uq_inv_sessao_galpao_dia;

-- 2. Coluna do token de idempotência (nullable: cliente antigo ⇒ sem dedup).
ALTER TABLE siso_inventario_sessoes
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- 3. Dedup por token (parcial: NULL não participa, então sessões sem key não colidem).
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_sessao_idempotency
  ON siso_inventario_sessoes (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON INDEX uq_inv_sessao_idempotency IS
  'Dedup de duplo-clique em Criar Sessão: 1 sessão por idempotency_key. Substitui o limite P055 de 1/galpão/dia.';
COMMENT ON COLUMN siso_inventario_sessoes.idempotency_key IS
  'Token do cliente (1 por intenção de criação). Duplo-clique reusa a mesma key → devolve a sessão existente.';

COMMIT;
