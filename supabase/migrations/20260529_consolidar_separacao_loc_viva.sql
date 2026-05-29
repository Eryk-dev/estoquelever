-- Fase 1.4 follow-up: siso_consolidar_produtos_separacao referenciava a tabela
-- dropada siso_pedido_item_estoques (LEFT JOIN pra pegar localizacao). Migra pra
-- ler a loc da RESERVA VIVA do pedido (siso_movimentacoes tipo='R' reserva_pedido
-- não-liberada) → siso_localizacoes.codigo. Mesma fonte de verdade do pick.
CREATE OR REPLACE FUNCTION public.siso_consolidar_produtos_separacao(
  p_pedido_ids text[],
  p_order_by text DEFAULT 'localizacao'::text
)
RETURNS TABLE(produto_id text, descricao text, sku text, gtin text, quantidade_total numeric, unidade text, localizacao text)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    pi.produto_id::text,
    pi.descricao,
    pi.sku,
    MAX(pi.gtin),
    SUM(pi.quantidade_pedida),
    'UN'::text AS unidade,
    MAX(loc.codigo)
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  -- Resolve produto WMS via mapeamento (empresa origem + tiny_produto_id)
  LEFT JOIN siso_produto_empresas pe
    ON pe.empresa_id = p.empresa_origem_id
    AND pe.tiny_produto_id = pi.produto_id
  -- Loc vem da R VIVA do pedido pra esse produto (posição reservada por aprovar).
  LEFT JOIN LATERAL (
    SELECT l.codigo
    FROM siso_movimentacoes r
    JOIN siso_localizacoes l ON l.id = r.localizacao_id
    WHERE r.origem_id = pi.pedido_id
      AND r.origem_tipo = 'reserva_pedido'
      AND r.tipo = 'R'
      AND r.produto_id = pe.produto_id
      AND NOT EXISTS (
        SELECT 1 FROM siso_movimentacoes lib
        WHERE lib.tipo = 'L' AND lib.estorno_de = r.id
      )
    ORDER BY r.criado_em DESC
    LIMIT 1
  ) loc ON true
  WHERE pi.pedido_id = ANY(p_pedido_ids)
    AND COALESCE(pi.compra_status, '') <> 'cancelado'
  GROUP BY pi.produto_id, pi.descricao, pi.sku
  ORDER BY
    CASE p_order_by
      WHEN 'sku' THEN pi.sku
      WHEN 'descricao' THEN pi.descricao
      ELSE MAX(loc.codigo)
    END NULLS LAST;
END;
$function$;
