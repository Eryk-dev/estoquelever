-- ============================================================
-- Migration: Compra parcial + sinais operacionais
-- ============================================================

ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS compra_quantidade_solicitada int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compra_solicitada_em timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'siso_pedido_itens_compra_quantidade_solicitada_check'
  ) THEN
    ALTER TABLE siso_pedido_itens
      ADD CONSTRAINT siso_pedido_itens_compra_quantidade_solicitada_check
      CHECK (compra_quantidade_solicitada >= 0);
  END IF;
END $$;

UPDATE siso_pedido_itens
SET
  compra_quantidade_solicitada = CASE
    WHEN COALESCE(compra_quantidade_solicitada, 0) > 0 THEN compra_quantidade_solicitada
    ELSE COALESCE(quantidade_pedida, 0)
  END,
  compra_solicitada_em = COALESCE(compra_solicitada_em, comprado_em, recebido_em, now())
WHERE compra_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pedido_itens_compra_solicitada_em
  ON siso_pedido_itens (compra_solicitada_em)
  WHERE compra_status IS NOT NULL;
