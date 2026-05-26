-- Cron job: refresh siso_cobertura_estoque every minute.
-- Materialized view fica stale conforme novas movs entram; sem refresh agendado
-- a aba /wms/cobertura zera (foi o que aconteceu pós-cutover ledger 3D em 2026-05-20).
-- Refresh é barato (poucas centenas de linhas) e usuário quer dados sempre quentes.

-- Idempotente: remove job anterior (se existir) antes de agendar.
DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job
    WHERE jobname IN ('wms_refresh_cobertura_30min', 'wms_refresh_cobertura_1min')
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_refresh_cobertura_1min',
  '* * * * *',
  $$SELECT wms_refresh_cobertura();$$
);
