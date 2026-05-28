-- Migration: cron — reconciliação Tiny↔ledger diária 6am UTC
-- Fix-D #3.7 (BAIXO — auditoria silenciosa)
--
-- Schedules HTTP GET to /api/wms/reconciliacao-tiny at 06:00 UTC daily.
-- Compara saldo agregado WMS por (produto × empresa) com Tiny e retorna
-- divergências > threshold. Resultado vai pros logs estruturados (não
-- persiste — UI roda on-demand pra ver detalhes).
--
-- Idempotent: unschedules any existing job with the same name before scheduling.

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'wms_reconciliacao_tiny_diario'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_reconciliacao_tiny_diario',
  '0 6 * * *',
  $cron$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/reconciliacao-tiny?limit=100&threshold=1',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      timeout_milliseconds := 300000
    );
  $cron$
);
