-- Migration: cron — inventário cleanup every 30 min
-- Date: 2026-05-27
-- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
-- Finding: 0.8 (MÉD — locks órfãos de localização travam inventário)
--
-- Schedules HTTP GET to /api/wms/inventario/cleanup every 30 minutes.
-- The endpoint calls recoveryInventario() to release orphan localização
-- locks (operador caiu mid-contagem deixou loc 'em_contagem' presa).
-- Sem cron, locks ficam até alguém abrir a sessão e clicar manual.
--
-- Auth: WORKER_SECRET is stored in Supabase Vault (name='worker_secret').
-- See 20260527_cron_insights_refresh_5min.sql for context on this deviation
-- from the plan's current_setting() suggestion.
--
-- NOTE: /api/wms/inventario/cleanup accepts GET only (per
-- src/app/api/wms/inventario/cleanup/route.ts). net.http_get is used.
--
-- Idempotent: unschedules any existing job with the same name before scheduling.
-- Rollback: SELECT cron.unschedule('wms_inventario_cleanup');

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'wms_inventario_cleanup'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_inventario_cleanup',
  '*/30 * * * *',
  $cron$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/inventario/cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      timeout_milliseconds := 60000
    );
  $cron$
);
