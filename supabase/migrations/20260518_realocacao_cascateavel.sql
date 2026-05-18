-- ============================================================
-- Migration: realocação cascateável no picking
-- Spec: docs/superpowers/specs/2026-05-18-realocacao-cascateavel-design.md
--
-- Adiciona à siso_pedido_item_realocacoes:
--   - parent_realocacao_id: rastreia chain de cascade
--   - quantidade_pega + parcial + parcial_motivo/em/por: estado de parcial
--   - mov_ajuste_loc_zerou_id: ref ao ajuste 'ajuste_pick_zerou' (qdo loc zerou)
--
-- Amplia status: adiciona 'picado_parcial' (terminal — gerou cascade ou sem cobertura).
-- ============================================================

BEGIN;

ALTER TABLE siso_pedido_item_realocacoes
  ADD COLUMN parent_realocacao_id uuid REFERENCES siso_pedido_item_realocacoes(id),
  ADD COLUMN quantidade_pega integer,
  ADD COLUMN parcial boolean NOT NULL DEFAULT false,
  ADD COLUMN parcial_motivo text,
  ADD COLUMN parcial_em timestamptz,
  ADD COLUMN parcial_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN mov_ajuste_loc_zerou_id uuid REFERENCES siso_movimentacoes(id);

-- Substitui constraint de status: adiciona 'picado_parcial'
ALTER TABLE siso_pedido_item_realocacoes
  DROP CONSTRAINT siso_pedido_item_realocacoes_status_check;

ALTER TABLE siso_pedido_item_realocacoes
  ADD CONSTRAINT siso_pedido_item_realocacoes_status_check
  CHECK (status IN ('aguardando_picking','picado','picado_parcial','cancelado'));

-- Index pra navegar a chain do cascade (debug + reconciliação)
CREATE INDEX idx_realoc_parent ON siso_pedido_item_realocacoes(parent_realocacao_id);

COMMIT;
