-- ============================================================
-- Fase 2 · Task 2.5 — Materialized views em 3D
-- ============================================================
-- Recria siso_curva_abc e siso_cobertura_estoque agregadas em
-- (produto_id, galpao_id) — sem a dimensão empresa_dona.
-- Ambas foram dropadas em Fase 1; aqui criamos do zero.
-- ============================================================

-- ── siso_curva_abc ──────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW siso_curva_abc AS
SELECT
  m.produto_id,
  m.galpao_id,
  SUM(m.quantidade) AS giro_30d,
  PERCENT_RANK() OVER (PARTITION BY m.galpao_id ORDER BY SUM(m.quantidade)) AS pct_giro,
  CASE
    WHEN PERCENT_RANK() OVER (PARTITION BY m.galpao_id ORDER BY SUM(m.quantidade)) >= 0.8 THEN 'A'
    WHEN PERCENT_RANK() OVER (PARTITION BY m.galpao_id ORDER BY SUM(m.quantidade)) >= 0.5 THEN 'B'
    ELSE 'C'
  END AS curva
FROM siso_movimentacoes m
WHERE m.tipo='S'
  AND m.origem_tipo IN ('nf_venda','venda_manual')
  AND m.criado_em >= now() - interval '30 days'
  AND m.estorno_de IS NULL
GROUP BY m.produto_id, m.galpao_id;

CREATE INDEX siso_curva_abc_produto_galpao_idx ON siso_curva_abc (produto_id, galpao_id);

CREATE OR REPLACE FUNCTION wms_refresh_curva_abc() RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW siso_curva_abc;
$$;

-- ── siso_cobertura_estoque ──────────────────────────────────────────────
-- Adaptado de 20260605_wms_excecoes_dashboards.sql:
--   • Drop empresa_dona_id de saldo_agregado, giro_30d e do GROUP BY
--   • UNIQUE INDEX vira (produto_id, galpao_id)
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
