-- Add idempotency flag for stock exit movements (transferencia)
-- When the execution worker deducts stock item-by-item from the support branch,
-- this flag prevents double-deduction on job retries.

ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS estoque_saida_lancada boolean NOT NULL DEFAULT false;

-- Cache product ID in the support branch's Tiny account (avoids redundant SKU lookup)
ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS produto_id_suporte bigint;

-- Idempotency flag for order-level stock posting (propria decisions)
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS estoque_lancado boolean NOT NULL DEFAULT false;
