-- =====================================================================
-- CROSS — links manuais entre produtos (equivalência sem precisar de OEM)
-- =====================================================================
-- Operador pode linkar 2 SKUs como equivalentes mesmo sem compartilharem
-- OEM. Útil para correlações conhecidas que ainda não têm OEM cadastrado
-- ou produtos legados com nomenclatura inconsistente.
--
-- Armazenamento canônico: sempre sku_a < sku_b (ordenado lexicograficamente)
-- pra evitar duplicatas A→B e B→A. Queries devem buscar em ambos os lados.

CREATE TABLE siso_produto_links (
  id              bigserial PRIMARY KEY,
  sku_a           text NOT NULL REFERENCES siso_produtos_catalogo(sku) ON DELETE CASCADE,
  sku_b           text NOT NULL REFERENCES siso_produtos_catalogo(sku) ON DELETE CASCADE,
  motivo          text,
  adicionado_por  uuid REFERENCES siso_usuarios(id),
  adicionado_em   timestamptz NOT NULL DEFAULT now(),
  CHECK (sku_a < sku_b),
  UNIQUE(sku_a, sku_b)
);

CREATE INDEX idx_produto_links_sku_a ON siso_produto_links(sku_a);
CREATE INDEX idx_produto_links_sku_b ON siso_produto_links(sku_b);

COMMENT ON TABLE siso_produto_links IS 'Equivalência manual entre 2 SKUs (sem precisar de OEM compartilhado). Pares sempre ordenados (sku_a < sku_b) para evitar duplicatas bidirecionais.';
