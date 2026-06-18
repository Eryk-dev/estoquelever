-- Migration: cron — sync incremental do catálogo de produtos do Tiny (1 min)
-- Date: 2026-06-18
--
-- Varre TODAS as contas Tiny conectadas a cada minuto e sincroniza pro
-- catálogo (siso_produtos) os produtos criados OU alterados nos últimos ~2 min
-- (GET /api/wms/tiny/sync-produtos → sincronizarProdutosRecentes).
--
-- Janela de 2 min > cadência de 1 min: cobre o minuto anterior inteiro mesmo
-- com skew de relógio. Upsert idempotente por SKU → a sobreposição entre
-- rodadas é inofensiva. Estoque não é tocado (WMS é a fonte única).
--
-- Auth: WORKER_SECRET via Supabase Vault (name='worker_secret') — mesmo pattern
-- do wms_tiny_polling_fallback (vault.decrypted_secrets + URL hardcoded; GUCs
-- custom são bloqueados no Supabase).
--
-- timeout 60s: a rodada típica (janela de 2 min) é rápida; backlogs continuam
-- server-side mesmo se o http_get expirar.
--
-- Idempotent: unschedules any existing job with the same name before scheduling.
-- Rollback: SELECT cron.unschedule('wms_tiny_sync_produtos');

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'wms_tiny_sync_produtos'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_tiny_sync_produtos',
  '* * * * *',
  $cron$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/tiny/sync-produtos',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      timeout_milliseconds := 60000
    );
  $cron$
);
