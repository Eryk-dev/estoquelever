BEGIN;
ALTER TABLE siso_movimentacoes
  ADD COLUMN IF NOT EXISTS devolucao_id uuid NULL REFERENCES siso_devolucoes_pendentes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_siso_movimentacoes_devolucao_id ON siso_movimentacoes(devolucao_id) WHERE devolucao_id IS NOT NULL;
COMMIT;
