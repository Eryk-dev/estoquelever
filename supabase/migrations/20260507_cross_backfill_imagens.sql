-- =====================================================================
-- CROSS — backfill de imagens que o seed inicial perdeu
-- =====================================================================
-- O seed inicial só leu external_image_urls.urls[0] e ignorou:
--   - url_imgs (formato legado)
--   - external_image_urls em outros formatos (array de objetos, array de arrays)
-- Resultado: ~6k imagens não migraram. Esta migration recupera todas as URLs
-- extraíveis em qualquer formato histórico do cross.

UPDATE siso_produtos_catalogo c
SET imagem_url = COALESCE(
    -- Formato 1: { "urls": [ "url", ... ] }
    p.external_image_urls -> 'urls' ->> 0,
    -- Formato 2: [ { "url": "...", "source": "..." }, ... ]
    p.external_image_urls -> 0 ->> 'url',
    -- Formato 3: [[ "url1", "url2", ... ]] (array dentro de array)
    p.external_image_urls -> 0 ->> 0,
    -- Formato 4: url_imgs como [[ "url1", "url2" ]]
    p.url_imgs -> 0 ->> 0,
    -- Formato 5: url_imgs como [ { "url_1": "...", "url_2": null, ... } ]
    p.url_imgs -> 0 ->> 'url_1',
    -- Formato 6: url_imgs.urls[0]
    p.url_imgs -> 'urls' ->> 0
  )
FROM products p
WHERE c.sku = p.sku
  AND c.imagem_url IS NULL
  AND (p.external_image_urls IS NOT NULL OR p.url_imgs IS NOT NULL);
