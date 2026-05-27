-- Smoke-test P1 · Migration 3 (insights refresh cron)
-- Expected after migration: 1 row with jobname='wms_insights_refresh'
-- and schedule='*/5 * * * *' and active=true.

SELECT jobid, jobname, schedule, active,
       left(command, 80) AS command_preview
FROM cron.job
WHERE jobname = 'wms_insights_refresh';
