-- =====================================================================
-- CROSS — backfill final de imagens vindas de ads_meli
-- =====================================================================
-- Buscador antigo combinava 3 fontes de imagem:
--   1. cross.products.external_image_urls
--   2. cross.products.url_imgs
--   3. cross.ads_meli.pictures (anúncios MercadoLivre — esta é a maior fonte)
--
-- Os 2 primeiros já cobertos em migrations anteriores. Este recupera o 3:
-- pega a primeira foto (HTTPS preferido) de qualquer anúncio MLB do SKU.

-- Conta principal (ads_meli)
WITH primeira_foto AS (
  SELECT DISTINCT ON (sku)
    sku,
    COALESCE(pictures -> 0 ->> 'secure_url', pictures -> 0 ->> 'url') AS img
  FROM ads_meli
  WHERE jsonb_typeof(pictures) = 'array'
  ORDER BY sku
)
UPDATE siso_produtos_catalogo c
SET imagem_url = pf.img
FROM primeira_foto pf
WHERE c.sku = pf.sku
  AND c.imagem_url IS NULL
  AND pf.img IS NOT NULL;

-- Conta secundária (ads_meli_141 — 141Air)
WITH primeira_foto_141 AS (
  SELECT DISTINCT ON (sku)
    sku,
    COALESCE(pictures -> 0 ->> 'secure_url', pictures -> 0 ->> 'url') AS img
  FROM ads_meli_141
  WHERE jsonb_typeof(pictures) = 'array'
  ORDER BY sku
)
UPDATE siso_produtos_catalogo c
SET imagem_url = pf.img
FROM primeira_foto_141 pf
WHERE c.sku = pf.sku
  AND c.imagem_url IS NULL
  AND pf.img IS NOT NULL;
