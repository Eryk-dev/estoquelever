-- Migration: cron — reservas cleanup every 1h
-- Date: 2026-05-27
-- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
-- Finding: 0.7 (MÉD — reservas órfãs inflam siso_estoque.reservado)
--
-- Schedules HTTP GET to /api/wms/reservas/cleanup at the top of every hour.
-- The endpoint releases R (reserva) movs that have expira_em < now()
-- via wms_inserir_movimentacao(tipo='L'). Without this cron, expired
-- reservations accumulate and siso_estoque.reservado inflates over time
-- (a pedido cancelled mid-flow leaves an R that never gets liberated).
--
-- Auth: WORKER_SECRET is stored in Supabase Vault (name='worker_secret').
-- See 20260527_cron_insights_refresh_5min.sql for context on this deviation
-- from the plan's current_setting() suggestion.
--
-- NOTE: /api/wms/reservas/cleanup accepts GET only (per
-- src/app/api/wms/reservas/cleanup/route.ts). net.http_get is used.
--
-- Idempotent: unschedules any existing job with the same name before scheduling.
-- Rollback: SELECT cron.unschedule('wms_reservas_cleanup');

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'wms_reservas_cleanup'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_reservas_cleanup',
  '0 * * * *',
  $cron$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/reservas/cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      timeout_milliseconds := 60000
    );
  $cron$
);
