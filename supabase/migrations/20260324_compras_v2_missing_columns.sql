-- ============================================================
-- Migration: Compras v2 — columns applied to prod but missing from migrations
-- Covers: compra_quantidade_comprada, comprado_por_nome (siso_pedido_itens)
--         prioridade (siso_fila_execucao)
-- ============================================================

-- 1. compra_quantidade_comprada — qty effectively ordered by the buyer (may differ from qty needed)
ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS compra_quantidade_comprada integer;

-- 2. comprado_por_nome — denormalized buyer name for display
ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS comprado_por_nome text;

-- 3. prioridade — priority flag for post-receipt jobs (processed before normal jobs)
ALTER TABLE siso_fila_execucao
  ADD COLUMN IF NOT EXISTS prioridade boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_fila_prioridade
  ON siso_fila_execucao (prioridade DESC, criado_em ASC)
  WHERE status = 'pendente';
