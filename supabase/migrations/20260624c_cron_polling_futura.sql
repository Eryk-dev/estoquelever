-- pg_cron pra separação futura: varre pedidos ABERTOS do Tiny e classifica via
-- ML substatus (buffered → futura). Mirror do wms_tiny_polling_fallback, mas a
-- cada 30min (ML-heavy, rate-limited). Vercel rejeita cron */N — por isso pg_cron.

SELECT cron.schedule(
  'wms_tiny_polling_futura',
  '*/30 * * * *',
  $$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/tiny/polling-futura',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      timeout_milliseconds := 290000
    );
  $$
);
