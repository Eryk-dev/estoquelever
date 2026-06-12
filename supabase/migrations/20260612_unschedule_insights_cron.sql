-- Migration: unschedule insights refresh cron
-- Date: 2026-06-12
--
-- O módulo Insights foi removido do código (rotas /api/wms/insights/*
-- deletadas). Sem este unschedule, o cron seguiria chamando a rota
-- /api/wms/insights/refresh a cada 5 min e recebendo 404.
--
-- Tabelas (siso_wms_insights_regras, siso_wms_insights_ativos) e RPCs de
-- insights permanecem no banco — mortas, sem efeito; drop fica pra um
-- cleanup futuro se desejado.
--
-- Idempotent: laço sobre cron.job; no-op se o job não existir.

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'wms_insights_refresh'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;
