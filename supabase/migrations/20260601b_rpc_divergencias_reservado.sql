-- Reconciliação de RESERVADO (complementa wms_detectar_divergencias_estoque,
-- que só checa saldo). Cache.reservado deve bater com GREATEST(0, Σ(R) − Σ(L))
-- do ledger — mesma fórmula usada por wms_rebuild_linha_estoque.
DROP FUNCTION IF EXISTS wms_detectar_divergencias_reservado() CASCADE;

CREATE OR REPLACE FUNCTION wms_detectar_divergencias_reservado()
RETURNS TABLE (
  estoque_id        uuid,
  produto_id        uuid,
  galpao_id         uuid,
  localizacao_id    uuid,
  reservado_cache   numeric,
  reservado_ledger  numeric,
  delta             numeric
)
LANGUAGE sql AS $$
  SELECT e.id, e.produto_id, e.galpao_id, e.localizacao_id,
         e.reservado,
         GREATEST(0, COALESCE(
           SUM(CASE m.tipo WHEN 'R' THEN m.quantidade WHEN 'L' THEN -m.quantidade ELSE 0 END),
           0
         )) AS reservado_ledger,
         e.reservado - GREATEST(0, COALESCE(
           SUM(CASE m.tipo WHEN 'R' THEN m.quantidade WHEN 'L' THEN -m.quantidade ELSE 0 END),
           0
         )) AS delta
    FROM siso_estoque e
    LEFT JOIN siso_movimentacoes m
      ON m.produto_id=e.produto_id
     AND m.galpao_id=e.galpao_id
     AND m.localizacao_id=e.localizacao_id
   GROUP BY e.id, e.produto_id, e.galpao_id, e.localizacao_id, e.reservado
  HAVING e.reservado <> GREATEST(0, COALESCE(
    SUM(CASE m.tipo WHEN 'R' THEN m.quantidade WHEN 'L' THEN -m.quantidade ELSE 0 END),
    0
  ));
$$;
