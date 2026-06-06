-- P128 — recria siso_cobertura_estoque no shape 3D (produto+galpão, sem
-- empresa_dona_id), revertendo a regressão de 20260605_wms_excecoes_dashboards.sql
-- (que reintroduziu empresa_dona_id, dropado do ledger em 20260520_ledger_simplificado).
-- Réplica fiel de 20260520f_mviews.sql:38-88 — origem_tipo IN ('nf_venda','venda_manual').

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS siso_cobertura_estoque;

CREATE MATERIALIZED VIEW siso_cobertura_estoque AS
WITH giro_30d AS (
  SELECT produto_id, galpao_id,
         SUM(quantidade) / 30.0 AS giro_diario
  FROM siso_movimentacoes
  WHERE tipo = 'S'
    AND origem_tipo IN ('nf_venda','venda_manual')
    AND criado_em >= now() - interval '30 days'
    AND estorno_de IS NULL
  GROUP BY produto_id, galpao_id
),
saldo_agregado AS (
  SELECT produto_id, galpao_id,
         SUM(disponivel) AS disponivel_total
  FROM siso_estoque
  GROUP BY produto_id, galpao_id
),
lead_pref AS (
  SELECT pf.produto_id, pf.lead_time_dias_medio
  FROM siso_produto_fornecedores pf
  WHERE pf.preferencial = true AND pf.ativo = true
)
SELECT
  s.produto_id,
  s.galpao_id,
  s.disponivel_total,
  COALESCE(g.giro_diario, 0) AS giro_diario,
  CASE WHEN g.giro_diario > 0
       THEN s.disponivel_total / g.giro_diario
       ELSE NULL END AS dias_cobertura,
  lp.lead_time_dias_medio AS lead_time_medio,
  CASE
    WHEN g.giro_diario IS NULL OR g.giro_diario = 0 THEN 'sem_giro'
    WHEN s.disponivel_total / g.giro_diario < 7 THEN 'critico'
    WHEN s.disponivel_total / g.giro_diario < 14 THEN 'atencao'
    WHEN lp.lead_time_dias_medio IS NOT NULL
      AND s.disponivel_total / g.giro_diario < lp.lead_time_dias_medio THEN 'lead_time_risco'
    ELSE 'ok'
  END AS status_cobertura
FROM saldo_agregado s
LEFT JOIN giro_30d g USING (produto_id, galpao_id)
LEFT JOIN lead_pref lp USING (produto_id);

CREATE UNIQUE INDEX uq_cobertura
  ON siso_cobertura_estoque(produto_id, galpao_id);
CREATE INDEX idx_cobertura_status
  ON siso_cobertura_estoque(status_cobertura, dias_cobertura);

CREATE OR REPLACE FUNCTION wms_refresh_cobertura() RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW siso_cobertura_estoque;
$$;

COMMIT;
