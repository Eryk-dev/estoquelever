-- Smoke-test P1 · Migration 5 (inventário cleanup cron)
-- Expected after migration: 1 row with jobname='wms_inventario_cleanup'
-- and schedule='*/30 * * * *' (every 30 minutes).

SELECT jobid, jobname, schedule, active,
       left(command, 80) AS command_preview
FROM cron.job
WHERE jobname = 'wms_inventario_cleanup';
