ALTER TABLE siso_pedidos ADD COLUMN IF NOT EXISTS compra_estoque_lancado_alerta boolean NOT NULL DEFAULT false;
