-- Smoke-test P1 · Migration 2 (insights RPCs 3D patch)
-- Expected before migration: each call raises ERROR referencing dropped column.
-- Expected after migration: each call returns successfully (rowcount >= 0).
--
-- Run each block separately and capture which raise errors.

-- 1. wms_insight_estoque_slow_mover
-- Pre-fix: ERROR: column s.custo_medio does not exist
SELECT * FROM wms_insight_estoque_slow_mover('{}'::jsonb) LIMIT 1;

-- 2. wms_insights_estoque_quadrante
-- Pre-fix: ERROR: column e.custo_medio does not exist
SELECT * FROM wms_insights_estoque_quadrante(NULL, NULL, 1) LIMIT 1;

-- 3. wms_insights_estoque_valor_atual
-- Pre-fix: ERROR: column s.empresa_dona_id does not exist
SELECT * FROM wms_insights_estoque_valor_atual(NULL) LIMIT 1;

-- 4. wms_insights_hub_kpis
-- Pre-fix: ERROR: column e.galpao_id does not exist OR column custo_medio does not exist
SELECT wms_insights_hub_kpis(NULL);
