-- Separação futura — promoção em tempo real via webhook do Mercado Livre.
--
-- A promoção da futura (etiqueta liberou no ML → emitir NF) hoje roda só por
-- polling (cron a cada 30min). Pra ter real-time, o app passa a receber as
-- notificações do ML (tópico `shipments`). A notificação traz o shipment_id,
-- não o order_id — então persistimos o shipment_id no pedido pra casar
-- notificação → pedido em O(1). Populado no enrich de SLA (processWebhookWms 5c).
--
-- O polling de 30min continua como rede de segurança (notificação ML não é 100%
-- confiável). Coluna nullable, sem backfill: pedidos antigos seguem promovendo
-- pelo polling; novos ganham o caminho real-time.

ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS ml_shipment_id text;

-- Lookup do webhook: shipment_id → futura viva. Parcial (só o que interessa).
CREATE INDEX IF NOT EXISTS idx_siso_pedidos_ml_shipment_id
  ON siso_pedidos (ml_shipment_id)
  WHERE ml_shipment_id IS NOT NULL;
