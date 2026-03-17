-- ============================================================
-- Migration: Natural sort for localizacao (e.g. B-2-1 before B-10-1)
--
-- Creates a helper function siso_loc_sort_key() that pads numeric
-- segments with leading zeros so that standard text ORDER BY
-- produces natural ordering. Then updates the consolidation
-- function to use it.
-- ============================================================

-- 1. Helper: convert "B-10-1" → "B-0000000010-0000000001" for sorting
CREATE OR REPLACE FUNCTION siso_loc_sort_key(loc text)
RETURNS text AS $$
DECLARE
  parts text[];
  part text;
  result text := '';
  i int;
BEGIN
  IF loc IS NULL THEN RETURN NULL; END IF;
  parts := string_to_array(loc, '-');
  FOR i IN 1..array_length(parts, 1) LOOP
    part := parts[i];
    IF i > 1 THEN result := result || '-'; END IF;
    IF part ~ '^\d+$' THEN
      result := result || lpad(part, 10, '0');
    ELSE
      result := result || part;
    END IF;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 2. Replace consolidation function to use natural sort
CREATE OR REPLACE FUNCTION siso_consolidar_produtos_separacao(
  p_pedido_ids text[],
  p_order_by text DEFAULT 'localizacao'
)
RETURNS TABLE(
  produto_id text,
  descricao text,
  sku text,
  gtin text,
  quantidade_total numeric,
  unidade text,
  localizacao text
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    pi.produto_id::text,
    pi.descricao,
    pi.sku,
    MAX(pi.gtin),
    SUM(pi.quantidade_pedida),
    'UN'::text AS unidade,
    MAX(pie.localizacao)
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  LEFT JOIN siso_pedido_item_estoques pie
    ON pie.pedido_id = pi.pedido_id
    AND pie.produto_id = pi.produto_id
    AND pie.empresa_id = p.empresa_origem_id
  WHERE pi.pedido_id = ANY(p_pedido_ids)
  GROUP BY pi.produto_id, pi.descricao, pi.sku
  ORDER BY
    CASE p_order_by
      WHEN 'sku' THEN pi.sku
      WHEN 'descricao' THEN pi.descricao
      ELSE siso_loc_sort_key(MAX(pie.localizacao))
    END NULLS LAST;
END;
$$ LANGUAGE plpgsql;
