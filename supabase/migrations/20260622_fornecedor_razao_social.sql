-- siso_fornecedores: razão social (nome jurídico) separada do `nome`.
-- `nome` é o CÓDIGO CURTO usado como chave de match (prefix map em sku-fornecedor.ts,
-- seed autoCriarFornecedoresDosPrefixosSku, fornecedor_oc, .ilike("nome",...) nas rotas
-- de compra/recebimento). Não renomear `nome` — guardar o nome jurídico aqui.

ALTER TABLE siso_fornecedores
  ADD COLUMN IF NOT EXISTS razao_social text;

COMMENT ON COLUMN siso_fornecedores.razao_social IS
  'Razão social / nome jurídico do fornecedor. O `nome` é o código curto usado como chave de match (prefix map, fornecedor_oc) — não confundir.';
