-- WMS Plano 4 — Curva ABC automática (giro 30d)
-- A=top 20%, B=próximos 30%, C=resto.

DROP MATERIALIZED VIEW IF EXISTS siso_curva_abc;

CREATE MATERIALIZED VIEW siso_curva_abc AS
WITH giro AS (
  SELECT produto_id,
         SUM(quantidade) AS qty_30d,
         COUNT(*) AS movs_30d
  FROM siso_movimentacoes
  WHERE tipo = 'S'
    AND origem_tipo IN ('nf_venda','emprestimo')
    AND criado_em >= now() - interval '30 days'
    AND estorno_de IS NULL
  GROUP BY produto_id
),
ranked AS (
  SELECT produto_id, qty_30d, movs_30d,
         PERCENT_RANK() OVER (ORDER BY qty_30d DESC) AS rank_pct
  FROM giro
)
SELECT
  produto_id, qty_30d, movs_30d, rank_pct,
  CASE
    WHEN rank_pct <= 0.20 THEN 'A'
    WHEN rank_pct <= 0.50 THEN 'B'
    ELSE 'C'
  END AS curva
FROM ranked;

CREATE UNIQUE INDEX uq_curva_abc ON siso_curva_abc(produto_id);
CREATE INDEX idx_curva_abc_categoria ON siso_curva_abc(curva);

CREATE OR REPLACE FUNCTION wms_refresh_curva_abc()
RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW siso_curva_abc;
$$;
