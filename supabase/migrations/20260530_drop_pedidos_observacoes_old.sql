-- Fix-Final C T9: drop coluna deprecated observacoes_old
-- Idempotente: já não existe em staging, mas garante a remoção em prod
-- quando promoção acontecer.
ALTER TABLE siso_pedidos DROP COLUMN IF EXISTS observacoes_old;
