ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
