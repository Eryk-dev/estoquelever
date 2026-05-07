-- =====================================================================
-- CROSS — adiciona localização no catálogo
-- =====================================================================
-- Vem de cross.products.location (texto livre, ex: "E-10-3, E-09-...")

ALTER TABLE siso_produtos_catalogo ADD COLUMN IF NOT EXISTS localizacao text;

-- Backfill a partir do projeto cross — existem ~580 produtos com location
UPDATE siso_produtos_catalogo c
SET localizacao = p.location
FROM products p
WHERE c.sku = p.sku AND p.location IS NOT NULL;
