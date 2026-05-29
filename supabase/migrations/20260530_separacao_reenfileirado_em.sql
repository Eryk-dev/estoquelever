-- Fase 3 #3 — Parcial na separação (prateleira ainda tem) volta pro FIM da fila.
-- Quando o operador faz um parcial sem zerar a loc (loc_zerou=false) e sobra
-- residual, o pedido inteiro volta pra aguardando_separacao preservando
-- quantidade_pega, e vai pro FIM da fila. Esta coluna marca o instante do
-- reenfileiramento; a listagem ordena não-reenfileirados (NULL) primeiro por
-- data, depois os reenfileirados por este timestamp.
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS separacao_reenfileirado_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_pedidos_reenfileirado
  ON siso_pedidos(separacao_reenfileirado_em)
  WHERE separacao_reenfileirado_em IS NOT NULL;

COMMENT ON COLUMN siso_pedidos.separacao_reenfileirado_em IS
  'Fase 3 #3: instante em que o pedido foi reenfileirado pro fim da fila de separação (parcial com saldo restante na prateleira). NULL = nunca reenfileirado (ordena por data).';
