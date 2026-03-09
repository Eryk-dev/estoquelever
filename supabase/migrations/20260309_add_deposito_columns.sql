-- Add deposit selection columns to siso_tiny_connections
-- Allows each branch connection to have a specific deposit (warehouse)
-- selected by the admin, replacing the fragile hardcoded array index approach.

ALTER TABLE siso_tiny_connections
  ADD COLUMN IF NOT EXISTS deposito_id   integer,
  ADD COLUMN IF NOT EXISTS deposito_nome text;

COMMENT ON COLUMN siso_tiny_connections.deposito_id   IS 'Tiny deposit ID selected for this branch connection';
COMMENT ON COLUMN siso_tiny_connections.deposito_nome IS 'Tiny deposit display name (cached for UI)';
