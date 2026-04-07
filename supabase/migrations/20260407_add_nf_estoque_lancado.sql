-- Track whether lancarEstoqueNota + compensating entries were done (one-time, permanent).
-- Separate from estoque_lancado which tracks the full cycle including exits.
-- Encaminhar resets estoque_lancado but preserves nf_estoque_lancado.
ALTER TABLE siso_pedidos ADD COLUMN nf_estoque_lancado boolean NOT NULL DEFAULT false;

-- Backfill: any pedido that already had estoque_lancado = true also had NF posted
UPDATE siso_pedidos SET nf_estoque_lancado = true WHERE estoque_lancado = true;
