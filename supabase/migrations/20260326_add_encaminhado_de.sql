ALTER TABLE siso_pedidos ADD COLUMN IF NOT EXISTS encaminhado_de text DEFAULT NULL;
COMMENT ON COLUMN siso_pedidos.encaminhado_de IS 'Nome do galpão de origem quando o pedido foi encaminhado manualmente';
