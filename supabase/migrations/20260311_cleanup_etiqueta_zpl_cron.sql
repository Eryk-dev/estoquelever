-- Cleanup cached ZPL labels older than 7 days (runs daily at 3am UTC)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

SELECT cron.schedule(
  'cleanup-etiqueta-zpl',
  '0 3 * * *',
  $$UPDATE siso_pedidos SET etiqueta_zpl = NULL, etiqueta_url = NULL WHERE etiqueta_zpl IS NOT NULL AND etiqueta_status = 'impresso' AND updated_at < now() - interval '7 days'$$
);
