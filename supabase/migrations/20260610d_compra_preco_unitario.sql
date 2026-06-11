-- Preço unitário informado pelo comprador na hora de marcar a compra
-- (POST /api/wms/compras/comprar). Pré-preenche o custo no recebimento da OC.
ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS compra_preco_unitario numeric(14,4);

COMMENT ON COLUMN siso_pedido_itens.compra_preco_unitario IS
  'Preço unitário declarado pelo comprador ao marcar comprado; sugere custo no recebimento da OC.';
