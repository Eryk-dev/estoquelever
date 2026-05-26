-- Smoke-test P1 · Migration 4 (reservas cleanup cron)
-- Expected after migration: 1 row with jobname='wms_reservas_cleanup'
-- and schedule='0 * * * *' (top of every hour).

SELECT jobid, jobname, schedule, active,
       left(command, 80) AS command_preview
FROM cron.job
WHERE jobname = 'wms_reservas_cleanup';
