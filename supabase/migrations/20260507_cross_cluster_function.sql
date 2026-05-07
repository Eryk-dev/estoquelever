-- =====================================================================
-- CROSS — função de fecho transitivo de equivalências
-- =====================================================================
-- Retorna todos os SKUs no mesmo "cluster de equivalência" do SKU base.
-- Cluster = componente conexo do grafo onde arestas são:
--   - OEM compartilhado (intersecção de arrays oem)
--   - Link manual em siso_produto_links (em qualquer direção)
--
-- Usado pra computar cross-references com transitividade: se A↔B e B↔C,
-- consultar A retorna {B, C} mesmo que A não tenha link/OEM direto com C.

CREATE OR REPLACE FUNCTION siso_cross_cluster_skus(p_sku text)
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH RECURSIVE cluster AS (
    SELECT p_sku AS sku
    UNION
    SELECT next_sku.sku
    FROM cluster c
    CROSS JOIN LATERAL (
      -- Arestas via OEM compartilhado
      SELECT p2.sku FROM siso_produtos_catalogo p1
      JOIN siso_produtos_catalogo p2 ON p1.oem && p2.oem AND p1.sku <> p2.sku
      WHERE p1.sku = c.sku
      UNION
      -- Arestas via link manual (ambas direções)
      SELECT pl.sku_b AS sku FROM siso_produto_links pl WHERE pl.sku_a = c.sku
      UNION
      SELECT pl.sku_a AS sku FROM siso_produto_links pl WHERE pl.sku_b = c.sku
    ) AS next_sku
  )
  SELECT sku FROM cluster WHERE sku <> p_sku;
$$;

COMMENT ON FUNCTION siso_cross_cluster_skus(text) IS
  'Retorna todos os SKUs equivalentes ao p_sku via fecho transitivo (OEM compartilhado + links manuais). Componente conexo do grafo de equivalência.';
