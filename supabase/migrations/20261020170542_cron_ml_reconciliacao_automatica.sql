-- Aplicar após o deploy da rota /api/wms/ml/reconciliar.
-- Resposta 202 imediata; a consulta continua via Next after(), sem ocupar pg_net.
create policy siso_ml_reconciliacao_service on public.siso_ml_reconciliacao
  for all to service_role using (true) with check (true);

do $$
begin
  if not exists(select 1 from vault.decrypted_secrets where name='worker_secret') then
    raise exception 'worker_secret ausente no Vault: cron não será habilitado';
  end if;
  perform cron.schedule(
    'wms_ml_reconciliacao_automatica',
    '*/5 * * * *',
    $cron$
      select net.http_get(
        url := 'https://estoquelever.vercel.app/api/wms/ml/reconciliar',
        headers := jsonb_build_object(
          'x-worker-secret',
          (select decrypted_secret from vault.decrypted_secrets where name='worker_secret' limit 1)
        ),
        timeout_milliseconds := 10000
      );
    $cron$
  );
end; $$;

-- Desativação operacional, preservando evidências:
-- select cron.unschedule('wms_ml_reconciliacao_automatica');
