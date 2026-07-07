-- 2026-07-07 — linha em siso_pedido_itens: permite 2+ linhas do MESMO produto
-- no MESMO pedido (lane Full com "Separar na ordem da lista": o operador quer
-- o checklist espelhando a lista do envio Full do ML, linha a linha, mesmo com
-- SKU repetido).
--
-- O índice único antigo (pedido_id, produto_id) forçava o dedupe-com-soma nas
-- rotas de criação. Vira (pedido_id, produto_id, linha):
--   · webhook / vendas / Full sem toggle: linha=1 (DEFAULT) → proteção idêntica
--     à anterior (1 row por produto).
--   · Full com preservar_linhas: linha = 1..N por produto (ocorrência).
--
-- ⚠ O upsert do webhook (webhook-processor-wms.ts) usa onConflict
-- "pedido_id,produto_id,linha" a partir deste commit — o ON CONFLICT precisa
-- casar exatamente com o índice único. Migration e código sobem juntos.

ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS linha smallint NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS idx_siso_pedido_itens_pedido_produto;

CREATE UNIQUE INDEX IF NOT EXISTS idx_siso_pedido_itens_pedido_produto_linha
  ON siso_pedido_itens (pedido_id, produto_id, linha);
