-- Fase 5 (P072) — token de idempotência no ledger. Coluna nullable +
-- UNIQUE parcial (só quando não-nulo) pra não afetar movs legadas. O 2º INSERT
-- com a mesma key estoura 23505 → o caller trata como já-processado (no-op).
ALTER TABLE siso_movimentacoes
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mov_idempotency_key
  ON siso_movimentacoes (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN siso_movimentacoes.idempotency_key IS
  'Token client-gerado pra deduplicar picks sem reserva (P072). UNIQUE parcial.';
