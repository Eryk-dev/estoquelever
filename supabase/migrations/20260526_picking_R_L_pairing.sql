-- ============================================================
-- Pareamento R↔L↔S no picking
--
-- Estende `siso_pedido_item_mov_links.tipo_link` com 2 novos valores
-- usados pelos endpoints de picking (marcar-item, parcial,
-- marcar-realocacao) ao parear cada saída com uma liberação de reserva:
--
--   * `liberacao_reserva` — aponta pra mov L (estorno_de=R.id) que
--     consome a reserva criada no aprovar.
--   * `reserva_cascade`   — aponta pra mov R nova criada pelo cascade
--     do parcial em loc destino (residual de qty quando loc original
--     esvaziou). Permite o `desfazer-parcial` estornar o cascade.
--
-- Sem reescrever dados existentes (`saida` e `ajuste_loc_zerou`
-- permanecem). CHECK substituído inline (drop+add).
-- ============================================================

BEGIN;

ALTER TABLE siso_pedido_item_mov_links
  DROP CONSTRAINT IF EXISTS siso_pedido_item_mov_links_tipo_link_check;

ALTER TABLE siso_pedido_item_mov_links
  ADD CONSTRAINT siso_pedido_item_mov_links_tipo_link_check
  CHECK (tipo_link IN (
    'saida',
    'ajuste_loc_zerou',
    'liberacao_reserva',
    'reserva_cascade'
  ));

COMMIT;
