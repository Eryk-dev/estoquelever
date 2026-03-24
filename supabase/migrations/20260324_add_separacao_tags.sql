-- Add separacao_tags column for user-created tags (separate from Tiny marcadores)
ALTER TABLE siso_pedidos ADD COLUMN IF NOT EXISTS separacao_tags text[] DEFAULT '{}';

-- Index for GIN array queries (filtering by tag)
CREATE INDEX IF NOT EXISTS idx_siso_pedidos_separacao_tags ON siso_pedidos USING GIN (separacao_tags);
