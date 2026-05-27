-- Smoke-test P1 · Migration 6 (curva ABC refresh diário)
-- Expected after migration: 1 row with jobname='wms_curva_abc_refresh_diario'
-- and schedule='0 3 * * *' (3am UTC = 00:00 BRT).

SELECT jobid, jobname, schedule, active,
       left(command, 100) AS command_preview
FROM cron.job
WHERE jobname = 'wms_curva_abc_refresh_diario';

-- Verify the function it calls still exists
SELECT proname, pg_get_function_identity_arguments(oid) AS args
FROM pg_proc WHERE proname = 'wms_refresh_curva_abc';
