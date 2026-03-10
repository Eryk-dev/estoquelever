-- ============================================================
-- Migration: PL/pgSQL function to consolidate products for wave picking
-- US-003: Consolidate products across multiple orders into a single
--         wave-picking list grouped by produto_id with summed quantities.
-- ============================================================

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
      ELSE MAX(pie.localizacao)
    END NULLS LAST;
END;
$$ LANGUAGE plpgsql;
