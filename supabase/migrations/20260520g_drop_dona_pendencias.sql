-- ============================================================
-- Fase 5 · Task 5.9 — drop empresa_dona_id de pendencias_guarda
-- ============================================================
-- Schema 3D: pendência herda empresa_dona da mov de entrada via mov_entrada_id
-- (e mov nem precisa mais — a partir do Plano 6 ledger é neutro em empresa).
-- Drop é seguro: o índice idx_pendencias_guarda_produto será recriado sem
-- dona pra preservar performance da query "tem pendência desse SKU no galpão?".
-- ============================================================

DROP INDEX IF EXISTS idx_pendencias_guarda_produto;

ALTER TABLE siso_wms_pendencias_guarda
  DROP COLUMN IF EXISTS empresa_dona_id;

CREATE INDEX IF NOT EXISTS idx_pendencias_guarda_produto
  ON siso_wms_pendencias_guarda (produto_id, galpao_id);
