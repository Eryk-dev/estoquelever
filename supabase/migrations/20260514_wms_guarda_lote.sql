-- WMS — lote_id na pendência de guarda
--
-- Compartilhado entre pendências do mesmo recebimento (1 UUID gerado por
-- chamada do POST /api/wms/receber). Permite agrupar a fila de guarda por
-- lote e gerar "rotas únicas" pro operador (1 lote = 1 caminhada).
--
-- NULL = recebimentos antigos (pré-2026-05-14) ou casos edge — viram
-- pendências avulsas que podem ser bundled ad-hoc na URL /wms/guarda/rota.

BEGIN;

ALTER TABLE siso_wms_pendencias_guarda
  ADD COLUMN IF NOT EXISTS lote_id uuid;

COMMENT ON COLUMN siso_wms_pendencias_guarda.lote_id IS
  'UUID compartilhado entre pendências do mesmo recebimento (1 por POST /api/wms/receber). Frontend agrupa por isso pra montar rotas. NULL = pendência avulsa (pré-feature ou caso edge).';

CREATE INDEX IF NOT EXISTS idx_pendencias_guarda_lote_ativo
  ON siso_wms_pendencias_guarda(galpao_id, lote_id, criada_em)
  WHERE status IN ('pendente','em_guarda') AND lote_id IS NOT NULL;

COMMIT;
