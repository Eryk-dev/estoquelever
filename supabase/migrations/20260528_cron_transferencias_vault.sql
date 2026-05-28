-- Migration: cron transferências cleanup — vault pattern
-- Date: 2026-05-28
-- Plan: 2026-05-28-wms-reaudit-fixes (Task 1, P0 re-audit #8.1)
--
-- Re-schedule cron_transferencias_em_transito_cleanup substituindo o pattern
-- current_setting('app.base_url', true) / current_setting('app.worker_secret', true)
-- — esses GUCs custom retornam NULL em Supabase staging (ALTER DATABASE/ROLE
-- bloqueado). Resultado: concat(NULL, ...) → net.http_get(NULL, ...) → OOM.
--
-- Evidência (re-audit 2026-05-28): cron.job_run_details mostrou 100% failed
-- nas últimas 5 execuções (2026-05-27 06:00, 12:00, 18:00 + 2026-05-28 00:00, 06:00).
--
-- Padrão herdado de 20260527_cron_insights_refresh_5min.sql (vault.decrypted_secrets
-- + URL hardcoded — 4 crons funcionando com esse pattern: insights, reservas,
-- inventário, ABC, reconciliação Tiny).

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'cron_transferencias_em_transito_cleanup'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'cron_transferencias_em_transito_cleanup',
  '0 */6 * * *',
  $cron$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/transferencias/cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      timeout_milliseconds := 60000
    );
  $cron$
);

-- Rollback:
--   SELECT cron.unschedule('cron_transferencias_em_transito_cleanup');
--   (e re-aplicar 20260527_cron_transferencias_em_transito_cleanup.sql só pra debug)
