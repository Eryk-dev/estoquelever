-- Schedules the cleanup endpoint to run every 6h via pg_cron + http extension.
BEGIN;

-- pg_cron + http já habilitados (vide migrations 20260526 cobertura)
-- Job: chama o endpoint worker secret-protected
SELECT cron.schedule(
  'cron_transferencias_em_transito_cleanup',
  '0 */6 * * *',  -- a cada 6h no minuto 0
  $$
  SELECT net.http_get(
    url := concat(current_setting('app.base_url', true), '/api/wms/transferencias/cleanup'),
    headers := jsonb_build_object('x-worker-secret', current_setting('app.worker_secret', true))
  );
  $$
);

COMMIT;

-- DOWN:
--   SELECT cron.unschedule('cron_transferencias_em_transito_cleanup');
