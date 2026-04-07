-- Fix CHECK constraint to allow lancar_estoque_pos_nf job type.
-- The commit 6b371be deferred stock posting for transferência to a post-NF job,
-- but the old constraint only accepted 'lancar_estoque', silently blocking all
-- post-NF stock jobs and leaving 173+ transferência orders with estoque_lancado = false.

ALTER TABLE siso_fila_execucao DROP CONSTRAINT chk_fila_tipo;
ALTER TABLE siso_fila_execucao ADD CONSTRAINT chk_fila_tipo
  CHECK (tipo IN ('lancar_estoque', 'lancar_estoque_pos_nf'));
