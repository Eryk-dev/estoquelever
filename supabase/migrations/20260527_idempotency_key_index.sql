BEGIN;

-- Index parcial sobre payload_original->>'idempotency_key' pra lookup rápido
-- quando consumidores (webhook re-entrega, replay manual) querem checar se
-- um pedido com idempotency_key X já existe antes de inserir duplicata.
-- Parcial WHERE payload_original ? 'idempotency_key' evita inflar o índice
-- com NULLs (a maioria dos pedidos não tem essa chave hoje).
CREATE INDEX IF NOT EXISTS idx_pedidos_idempotency_key
  ON siso_pedidos((payload_original->>'idempotency_key'))
  WHERE payload_original ? 'idempotency_key';

COMMIT;

-- DOWN: DROP INDEX IF EXISTS idx_pedidos_idempotency_key;
