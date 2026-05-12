-- WMS: código do produto no fornecedor + tracking do tiny_fornecedor_id
-- Habilita atribuir manualmente um código de produto por fornecedor (como no Tiny)
-- e dedupar fornecedores ao sincronizar do Tiny.

ALTER TABLE siso_produto_fornecedores
  ADD COLUMN IF NOT EXISTS codigo_fornecedor text;

COMMENT ON COLUMN siso_produto_fornecedores.codigo_fornecedor IS
  'Código interno deste produto no catálogo do fornecedor (codigoProdutoNoFornecedor no Tiny).';

ALTER TABLE siso_fornecedores
  ADD COLUMN IF NOT EXISTS tiny_fornecedor_id bigint;

COMMENT ON COLUMN siso_fornecedores.tiny_fornecedor_id IS
  'ID do fornecedor no Tiny (contato com tipo Fornecedor). Usado pra dedup ao sincronizar produtos.';

-- Unique parcial: 1 fornecedor por tiny_fornecedor_id (NULL permite múltiplos
-- sem tiny_id, ex.: fornecedores cadastrados manualmente).
CREATE UNIQUE INDEX IF NOT EXISTS siso_fornecedores_tiny_id_uidx
  ON siso_fornecedores(tiny_fornecedor_id)
  WHERE tiny_fornecedor_id IS NOT NULL;
