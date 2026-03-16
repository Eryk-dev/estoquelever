-- Add forma_frete_id and transportador_id to siso_pedidos
-- so agrupamento-service can group pedidos with matching shipping methods.
-- Tiny requires all pedidos in an agrupamento to have the same
-- forma_envio, forma_frete, and transportador.
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS forma_frete_id text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS transportador_id text DEFAULT NULL;
