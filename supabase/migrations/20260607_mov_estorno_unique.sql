-- P106 — promove idx_mov_estorno (não-único, foundation 20260508:156) a UNIQUE parcial.
-- Garante no banco que cada mov só pode ser estornada uma vez. O guard de código
-- em ledger.ts (estornarMovimentacao) é TOCTOU sob concorrência; este é o backstop.
--
-- Pré-condição: nenhum estorno_de duplicado já existente (verificado: staging limpo).
--
-- ⚠️ PROD: siso_movimentacoes é a tabela de maior escrita (ledger). Em staging (sem
-- tráfego) o build inline é instantâneo. Num prod populado, rodar o CREATE UNIQUE INDEX
-- como CONCURRENTLY (fora de transação, sem o BEGIN/COMMIT) pra não travar escrita
-- durante o build — mesma convenção de 20260531_perf_p0_indexes.sql.

BEGIN;

DROP INDEX IF EXISTS idx_mov_estorno;

CREATE UNIQUE INDEX uq_mov_estorno_unico
  ON siso_movimentacoes(estorno_de)
  WHERE estorno_de IS NOT NULL;

COMMENT ON INDEX uq_mov_estorno_unico IS
  'P106: cada movimentação só pode ser estornada uma vez (UNIQUE parcial em estorno_de).';

COMMIT;
