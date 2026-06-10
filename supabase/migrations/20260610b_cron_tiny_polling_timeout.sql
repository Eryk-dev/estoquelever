-- Migration: cron tiny polling — timeout 120s → 290s
-- Date: 2026-06-10
--
-- Primeira rodada real do polling (backlog: 20 pedidos + 95 NFs recuperados
-- na EasyPeasy SP) levou 203s — acima do timeout de 120s do net.http_get.
-- Rodadas pós-downtime (justamente o cenário que o fallback existe pra
-- cobrir) podem repetir isso. 290s fica colado no maxDuration=300 da rota.
-- Rodadas normais (delta vazio) terminam em segundos.
--
-- Idempotent: unschedules any existing job with the same name before scheduling.
-- Rollback: SELECT cron.unschedule('wms_tiny_polling_fallback');

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'wms_tiny_polling_fallback'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_tiny_polling_fallback',
  '*/10 * * * *',
  $cron$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/tiny/polling',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      timeout_milliseconds := 290000
    );
  $cron$
);
