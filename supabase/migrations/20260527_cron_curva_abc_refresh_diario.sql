-- Migration: cron — curva ABC refresh diário (3am UTC = 00:00 BRT)
-- Date: 2026-05-27
-- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
-- Finding: 0.6 (MÉD — curva ABC stale, função sem cron)
--
-- Schedules direct SQL call to wms_refresh_curva_abc() once per day at
-- 3am UTC (00:00 BRT — fim do dia comercial brasileiro). Unlike the
-- other crons in this plan, this one runs SQL directly (no HTTP) because
-- the function exists in the database and doesn't need an HTTP boundary.
--
-- siso_curva_abc é materialized view com ranking ABC por giro 30d.
-- Sem refresh diário, fica stale logo após a primeira semana do mês.
-- Refresh leva poucos segundos (universo total de produtos = ~milhares).
--
-- Idempotent: unschedules any existing job with the same name before scheduling.
-- Rollback: SELECT cron.unschedule('wms_curva_abc_refresh_diario');

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'wms_curva_abc_refresh_diario'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_curva_abc_refresh_diario',
  '0 3 * * *',
  $cron$SELECT wms_refresh_curva_abc();$cron$
);
