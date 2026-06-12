-- Perf Tier 1 — refresh das MVs sem bloquear leitores.
--
-- REFRESH MATERIALIZED VIEW (sem CONCURRENTLY) toma AccessExclusiveLock:
-- toda query em siso_cobertura_estoque trava durante o refresh — que roda
-- A CADA 1 MINUTO via pg_cron (20260526_cron_refresh_cobertura_1min.sql).
--
-- CONCURRENTLY não pode rodar dentro de função (exige top-level, fora de
-- transação), então o fix é o cron executar o REFRESH direto em vez de
-- SELECT wms_refresh_cobertura(). As funções wms_refresh_cobertura() e
-- wms_refresh_curva_abc() ficam intactas (caller manual em
-- src/lib/wms/cobertura.ts e smoke tests) — comportamento delas inalterado.
--
-- Pré-requisito de CONCURRENTLY (índice UNIQUE na MV) já existe:
--   uq_cobertura (produto_id, galpao_id) — 20260607_fix_cobertura_3d.sql
--   uq_curva_abc (produto_id)            — 20260529_wms_curva_abc.sql
--
-- Idempotente: remove jobs anteriores antes de re-agendar.
-- Rollback: re-rodar 20260526_cron_refresh_cobertura_1min.sql e
--           20260527_cron_curva_abc_refresh_diario.sql.

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job
    WHERE jobname IN ('wms_refresh_cobertura_1min', 'wms_curva_abc_refresh_diario')
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_refresh_cobertura_1min',
  '* * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY siso_cobertura_estoque;$$
);

SELECT cron.schedule(
  'wms_curva_abc_refresh_diario',
  '0 3 * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY siso_curva_abc;$$
);
