-- Add prazo_envio (shipping deadline) to siso_pedidos
ALTER TABLE siso_pedidos ADD COLUMN IF NOT EXISTS prazo_envio timestamptz;

-- Index for queries filtering/sorting by prazo_envio
CREATE INDEX IF NOT EXISTS idx_siso_pedidos_prazo_envio
  ON siso_pedidos (prazo_envio)
  WHERE prazo_envio IS NOT NULL;
