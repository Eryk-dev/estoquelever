-- US-001 + US-004: Add produto_id_na_empresa to siso_pedido_item_estoques
-- Stores the Tiny product ID specific to each empresa (different from the origin produto_id)

ALTER TABLE siso_pedido_item_estoques
ADD COLUMN produto_id_na_empresa bigint;

-- Backfill: for rows where empresa_id matches the order's empresa_origem_id,
-- the produto_id_na_empresa equals the existing produto_id (origin product).
UPDATE siso_pedido_item_estoques est
SET produto_id_na_empresa = est.produto_id
FROM siso_pedidos p
WHERE est.pedido_id = p.id
  AND est.empresa_id = p.empresa_origem_id;

COMMENT ON COLUMN siso_pedido_item_estoques.produto_id_na_empresa IS
  'Tiny product ID in this specific empresa. May differ from produto_id (which is always the origin empresa ID).';
