-- =====================================================================
-- CROSS — remove UNIQUE em siso_produtos_catalogo.tiny_id
-- =====================================================================
-- A origem (Tiny ERP) tem duplicatas legítimas de tiny_id (variantes,
-- imports antigos, kits). A unicidade quebrava o seed. Lookup primário
-- continua sendo por sku (UNIQUE preservado).

ALTER TABLE siso_produtos_catalogo DROP CONSTRAINT IF EXISTS siso_produtos_catalogo_tiny_id_key;
