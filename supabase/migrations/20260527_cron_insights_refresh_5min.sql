-- Migration: cron — insights refresh every 5 min
-- Date: 2026-05-27
-- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
-- Finding: 0.3 (ALTO — motor insights nunca executa)
--
-- Schedules HTTP GET to /api/wms/insights/refresh every 5 minutes.
-- The endpoint runs the 16 anomaly-detection rules and refreshes
-- siso_wms_insights_ativos. Without this cron, 0 alerts ever fire.
--
-- Auth: WORKER_SECRET is stored in Supabase Vault (name='worker_secret').
-- Plan §2.2 originally suggested current_setting('app.worker_secret') but
-- Supabase sandbox blocks ALTER DATABASE/ROLE for custom GUCs, so the
-- canonical Supabase pattern (vault.decrypted_secrets) is used here.
--
-- NOTE: /api/wms/insights/refresh accepts GET (per src/app/api/wms/insights/refresh/route.ts).
-- net.http_get is used accordingly.
--
-- Idempotent: unschedules any existing job with the same name before scheduling.
-- Rollback: SELECT cron.unschedule('wms_insights_refresh');

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'wms_insights_refresh'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_insights_refresh',
  '*/5 * * * *',
  $cron$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/insights/refresh',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      timeout_milliseconds := 30000
    );
  $cron$
);
