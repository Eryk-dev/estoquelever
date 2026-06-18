-- Compras item-cêntrico Fase 1 (review Eryk 2026-06-18): galpão de recebimento
-- FIXO por fornecedor (config da localização do fornecedor). A lista de compras
-- deixa de pedir o galpão por linha — ele vem do fornecedor escolhido (fallback
-- no prefix map sku-fornecedor.ts quando a coluna está nula).
ALTER TABLE siso_fornecedores
  ADD COLUMN IF NOT EXISTS galpao_id uuid REFERENCES siso_galpoes(id);

COMMENT ON COLUMN siso_fornecedores.galpao_id IS
  'Galpão de recebimento padrão deste fornecedor (config da localização). NULL = cai no prefix map (sku-fornecedor.ts filialOC).';
