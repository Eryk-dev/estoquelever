-- 20260619 — siso_cobertura_estoque ganha vendas REAIS por janela (7/30/60 dias).
--
-- Alimenta o chip de velocidade da tela de Compras (redesign Compras.dc.html):
-- cada peça mostra quanto vendeu nos últimos 7 / 30 / 60 dias.
--
-- Recria a MV no MESMO shape 3D de 20260607_fix_cobertura_3d.sql (réplica fiel),
-- trocando o CTE `giro_30d` por um único scan de 60 dias com SUM(...) FILTER por
-- janela. É SUPERSET: mantém todas as colunas anteriores (disponivel_total,
-- giro_diario, dias_cobertura, lead_time_medio, status_cobertura) — nenhum leitor
-- atual quebra. giro_diario continua = vendas_30d / 30.0 (comportamento idêntico).
--
-- CREATE MATERIALIZED VIEW ... AS já popula com dados (WITH DATA é o default), e o
-- cron `wms_refresh_cobertura_1min` (REFRESH CONCURRENTLY por nome, inalterado)
-- segue válido — depende do índice UNIQUE uq_cobertura, recriado abaixo.

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS siso_cobertura_estoque;

CREATE MATERIALIZED VIEW siso_cobertura_estoque AS
WITH vendas AS (
  SELECT produto_id, galpao_id,
         COALESCE(SUM(quantidade) FILTER (WHERE criado_em >= now() - interval '7 days'), 0)  AS vendas_7d,
         COALESCE(SUM(quantidade) FILTER (WHERE criado_em >= now() - interval '30 days'), 0) AS vendas_30d,
         COALESCE(SUM(quantidade) FILTER (WHERE criado_em >= now() - interval '60 days'), 0) AS vendas_60d
  FROM siso_movimentacoes
  WHERE tipo = 'S'
    AND origem_tipo IN ('nf_venda','venda_manual')
    AND criado_em >= now() - interval '60 days'
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
  COALESCE(v.vendas_30d, 0) / 30.0 AS giro_diario,
  COALESCE(v.vendas_7d, 0)  AS vendas_7d,
  COALESCE(v.vendas_30d, 0) AS vendas_30d,
  COALESCE(v.vendas_60d, 0) AS vendas_60d,
  CASE WHEN COALESCE(v.vendas_30d, 0) > 0
       THEN s.disponivel_total / (v.vendas_30d / 30.0)
       ELSE NULL END AS dias_cobertura,
  lp.lead_time_dias_medio AS lead_time_medio,
  CASE
    WHEN COALESCE(v.vendas_30d, 0) = 0 THEN 'sem_giro'
    WHEN s.disponivel_total / (v.vendas_30d / 30.0) < 7 THEN 'critico'
    WHEN s.disponivel_total / (v.vendas_30d / 30.0) < 14 THEN 'atencao'
    WHEN lp.lead_time_dias_medio IS NOT NULL
      AND s.disponivel_total / (v.vendas_30d / 30.0) < lp.lead_time_dias_medio THEN 'lead_time_risco'
    ELSE 'ok'
  END AS status_cobertura
FROM saldo_agregado s
LEFT JOIN vendas v USING (produto_id, galpao_id)
LEFT JOIN lead_pref lp USING (produto_id);

CREATE UNIQUE INDEX uq_cobertura
  ON siso_cobertura_estoque(produto_id, galpao_id);
CREATE INDEX idx_cobertura_status
  ON siso_cobertura_estoque(status_cobertura, dias_cobertura);

CREATE OR REPLACE FUNCTION wms_refresh_cobertura() RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW siso_cobertura_estoque;
$$;

COMMIT;
