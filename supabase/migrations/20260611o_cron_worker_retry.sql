-- Migration: cron — kick do execution worker a cada 2 min
-- Date: 2026-06-11
--
-- [P2-CST-02] Sem motor de retry: um job de siso_fila_execucao que falha e
-- recebe `proximo_retry_em` no futuro só volta a rodar no próximo kick orgânico
-- (aprovação humana, reconciliador, etc). De madrugada — sem tráfego — a fila
-- congela: jobs com retry agendado, jobs de manutenção (varredura_pos_entrada /
-- reconciliar_oc_retry) e jobs reclamados de instâncias estagnadas ficam parados
-- até alguém mexer no sistema. Este cron dá o motor que faltava.
--
-- Chama POST /api/wms/worker/processar?limit=0 — o ?limit=0 invoca kickWorker(),
-- que drena a fila inteira (processQueue seleciona jobs com
-- proximo_retry_em IS NULL OR proximo_retry_em <= now()). Rodadas com a fila
-- vazia terminam em ms.
--
-- Auth: a rota /worker/processar valida `Authorization: Bearer <WORKER_SECRET>`
-- (diferente do polling, que lê X-Worker-Secret). WORKER_SECRET vem do Supabase
-- Vault (name='worker_secret'), mesmo pattern do cron de polling.
--
-- Timeout 60s: kickWorker drena em lotes de 5 e devolve "draining" imediato
-- (drenagem segue server-side mesmo se o http_post expirar); 60s é folga de sobra.
--
-- Idempotent: unschedules any existing job with the same name before scheduling.
-- Rollback: SELECT cron.unschedule('wms_worker_kick');

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'wms_worker_kick'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_worker_kick',
  '*/2 * * * *',
  $cron$
    SELECT net.http_post(
      url := 'https://estoquelever.vercel.app/api/wms/worker/processar?limit=0',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cron$
);
