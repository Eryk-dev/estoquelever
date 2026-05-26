BEGIN;

WITH dup AS (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY pedido_id, tipo ORDER BY criado_em DESC) AS rn
      FROM siso_fila_execucao
     WHERE tipo = 'lancar_estoque'
       AND status = 'pendente'
  ) sub WHERE rn > 1
)
DELETE FROM siso_fila_execucao WHERE id IN (SELECT id FROM dup);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fila_release_pedido
  ON siso_fila_execucao(pedido_id)
  WHERE tipo = 'lancar_estoque' AND status = 'pendente';

COMMIT;
