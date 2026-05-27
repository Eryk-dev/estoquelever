-- WMS — siso_wms_pendencias_guarda: coluna tracking_origem_ids text[]
--
-- Scaffolding futuro para vincular 1 pendência a múltiplas NFs / tracking IDs.
-- Hoje a tabela só tem nf_referencia text (singular — chave de acesso da NF).
-- Não existe coluna singular tracking_origem_id, portanto não há backfill possível.
--
-- População futura: quando Tiny expor tracking_ids no payload de NF,
-- nf-webhook-handler.ts deve incluir tracking_origem_ids no INSERT/UPDATE
-- da pendência (e nf_referencia continua como chave-de-acesso legacy).
--
-- Referência: fix-final-B T13 / B11
-- Plano: docs/superpowers/plans/2026-05-27-wms-fix-final-B.md §Phase 12

BEGIN;

ALTER TABLE siso_wms_pendencias_guarda
  ADD COLUMN IF NOT EXISTS tracking_origem_ids text[] NULL;

COMMENT ON COLUMN siso_wms_pendencias_guarda.tracking_origem_ids IS
  'Array de tracking IDs associados a esta pendência (ex: múltiplas NFs de um mesmo lote). NULL até que o webhook Tiny exponha tracking_ids no payload. População via nf-webhook-handler.ts quando disponível.';

COMMIT;
