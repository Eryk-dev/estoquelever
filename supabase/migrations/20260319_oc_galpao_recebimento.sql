-- OC por Fornecedor com Galpão de Recebimento
-- Add galpao_id to siso_ordens_compra so the buyer chooses the receiving warehouse.
-- empresa_id becomes nullable (derived from galpao for backwards compat).

-- 1. Add galpao_id column
ALTER TABLE siso_ordens_compra
  ADD COLUMN galpao_id uuid REFERENCES siso_galpoes(id);

-- 2. Backfill existing OCs: derive galpao_id from empresa_id
UPDATE siso_ordens_compra oc
SET galpao_id = e.galpao_id
FROM siso_empresas e
WHERE oc.empresa_id = e.id
  AND oc.galpao_id IS NULL;

-- 3. Add index on galpao_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_siso_ordens_compra_galpao_id ON siso_ordens_compra(galpao_id);

-- 4. Make empresa_id nullable (kept for backwards compat, will be derived from galpao)
ALTER TABLE siso_ordens_compra ALTER COLUMN empresa_id DROP NOT NULL;
