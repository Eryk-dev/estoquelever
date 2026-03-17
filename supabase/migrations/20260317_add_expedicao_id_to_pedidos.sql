-- Add expedicao_id to siso_pedidos to cache the Tiny expedition ID
-- per pedido at agrupamento creation time. This avoids an extra
-- obterAgrupamento API call during label retry.
ALTER TABLE siso_pedidos ADD COLUMN IF NOT EXISTS expedicao_id text;
COMMENT ON COLUMN siso_pedidos.expedicao_id IS 'Tiny expedition ID within agrupamento — saved at creation to avoid re-fetching';
