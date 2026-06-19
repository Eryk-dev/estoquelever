-- Cross — OEM no catálogo principal (integração total)
-- Plano: integração Cross ↔ Fornecedor ↔ OEM (2026-06-19)
-- Campo manual de códigos OEM por produto. NÃO ressuscita siso_produto_oems
-- (catálogo sujo dropado em 20260619d). Aqui é coluna no catálogo limpo,
-- preenchida à mão; alimenta busca do cross + palpites por OEM compartilhado.

BEGIN;

ALTER TABLE siso_produtos ADD COLUMN IF NOT EXISTS oem text[];

-- Busca por elemento do array (oem @> array[termo]).
CREATE INDEX IF NOT EXISTS idx_produtos_oem ON siso_produtos USING gin (oem);

COMMIT;
