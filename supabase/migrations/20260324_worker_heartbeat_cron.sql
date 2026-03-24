-- Worker queue reliability: pg_cron heartbeat + zombie reclamation
--
-- Prerequisites: pg_cron (already enabled), pg_net (already enabled)
--
-- Configuration: set these keys in siso_configuracoes BEFORE the cron fires:
--   chave = 'worker_url'    valor = 'https://your-app-url' (no trailing slash)
--   chave = 'worker_secret' valor = '<same as WORKER_SECRET env var>' (optional)

-- ── Helper function: reads URL from siso_configuracoes and calls the worker ──
CREATE OR REPLACE FUNCTION siso_trigger_worker_heartbeat()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  _url text;
  _secret text;
  _headers jsonb;
  _pending_count int;
BEGIN
  -- Only call if there are pending jobs (avoid unnecessary HTTP calls)
  SELECT count(*) INTO _pending_count
  FROM siso_fila_execucao
  WHERE status = 'pendente'
    AND (proximo_retry_em IS NULL OR proximo_retry_em <= now());

  IF _pending_count = 0 THEN
    RETURN;
  END IF;

  SELECT valor INTO _url FROM siso_configuracoes WHERE chave = 'worker_url';
  IF _url IS NULL THEN
    RAISE WARNING 'siso_trigger_worker_heartbeat: worker_url not configured in siso_configuracoes';
    RETURN;
  END IF;

  SELECT valor INTO _secret FROM siso_configuracoes WHERE chave = 'worker_secret';

  IF _secret IS NOT NULL AND _secret != '' THEN
    _headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _secret
    );
  ELSE
    _headers := jsonb_build_object('Content-Type', 'application/json');
  END IF;

  PERFORM net.http_post(
    url := _url || '/api/worker/processar?limit=0',
    headers := _headers,
    body := '{}'::jsonb
  );
END;
$$;

-- ── Heartbeat: check every minute, call worker if there are pending jobs ──
-- pg_cron minimum interval is 1 minute with standard cron syntax.
-- The function itself checks for pending jobs before making the HTTP call.
SELECT cron.schedule(
  'worker-heartbeat',
  '* * * * *',
  $$SELECT siso_trigger_worker_heartbeat()$$
);

-- ── Zombie reclamation: reclaim jobs stuck in 'executando' for >5 minutes ──
-- This handles process crashes where a job was claimed but never completed.
-- Safe because all jobs are idempotent.
SELECT cron.schedule(
  'worker-reclaim-zombies',
  '*/5 * * * *',
  $$UPDATE siso_fila_execucao
    SET status = 'pendente',
        atualizado_em = now(),
        erro = COALESCE(erro, '') || ' [reclaimed]'
    WHERE status = 'executando'
    AND atualizado_em < now() - interval '5 minutes'$$
);
