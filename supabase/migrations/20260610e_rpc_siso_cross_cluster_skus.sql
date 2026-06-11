-- RPC do módulo cross: expande o cluster de SKUs equivalentes a partir de um SKU,
-- seguindo arestas de OEM compartilhado (array overlap) e links manuais (ambas direções).
-- Portada da definição em produção (pg_get_functiondef) — o módulo cross na develop
-- (catalogo-queries.ts, equivalentes-rapidos, has-cross) depende dela.
CREATE OR REPLACE FUNCTION public.siso_cross_cluster_skus(p_sku text)
 RETURNS SETOF text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
