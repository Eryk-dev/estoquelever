-- Migration: cron — polling fallback Tiny (pedidos + NFs) a cada 10 min
-- Date: 2026-06-10
--
-- O fluxo primário é o webhook do Tiny; este cron chama o fallback de
-- polling (GET /api/wms/tiny/polling) que varre todas as contas Tiny
-- conectadas e reprocessa, com janela de 7 dias pra trás:
--   - pedidos aprovados sem webhook (→ processWebhook)
--   - pedidos cancelados no Tiny mas ativos no SISO (→ cancelamento)
--   - NFs autorizadas sem webhook (→ handleNfWebhook)
--
-- Auth: WORKER_SECRET via Supabase Vault (name='worker_secret') — mesmo
-- pattern dos crons de insights/reservas/inventário (vault.decrypted_secrets
-- + URL hardcoded; GUCs custom são bloqueados no Supabase).
--
-- Timeout 120s: rodada típica é rápida (dedup em lote, só processa o delta);
-- backlogs grandes continuam server-side mesmo se o http_get expirar.
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
      timeout_milliseconds := 120000
    );
  $cron$
);
