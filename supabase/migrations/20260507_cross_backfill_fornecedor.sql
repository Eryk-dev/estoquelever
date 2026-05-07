-- =====================================================================
-- CROSS — backfill de fornecedor por prefixo de SKU
-- =====================================================================
-- 4.927 SKUs vieram do cross sem campo `supplier` preenchido. O SISO já
-- tem mapeamento de prefixo→fornecedor em src/lib/sku-fornecedor.ts; esta
-- migration espelha essa lógica em SQL para preencher o catálogo de uma
-- vez (evita confusão na UI quando operador busca um SKU sem fornecedor
-- exibido — hoje todo SKU se encaixa em algum prefixo conhecido ou cai
-- em "Diversos").
--
-- IMPORTANTE: prefixos longos (3 chars) avaliados primeiro pra não casar
-- com prefixos curtos por engano (ex: "MAN" antes de "MA").

UPDATE siso_produtos_catalogo
SET fornecedor = (
  CASE
    -- Prefixos de 3 chars (longest-first)
    WHEN UPPER(sku) LIKE 'CAK%' THEN 'Delphi'
    WHEN UPPER(sku) LIKE 'APX%' THEN 'Multiqualita'
    WHEN UPPER(sku) LIKE 'WDC%' THEN 'Multiqualita'
    WHEN UPPER(sku) LIKE 'MAN%' THEN 'Multiqualita'
    -- Prefixos de 2 chars
    WHEN UPPER(sku) LIKE 'A1%' THEN '141'
    WHEN UPPER(sku) LIKE 'EW%' OR UPPER(sku) LIKE 'TG%' THEN 'Tiger'
    WHEN UPPER(sku) LIKE 'LD%' THEN 'LDRU'
    WHEN UPPER(sku) LIKE 'L0%' THEN 'LEFS'
    WHEN UPPER(sku) LIKE 'GB%' OR UPPER(sku) LIKE 'GE%' OR UPPER(sku) LIKE 'GS%' OR UPPER(sku) LIKE 'GI%' THEN 'GAUSS'
    WHEN UPPER(sku) LIKE 'MK%' OR UPPER(sku) LIKE 'M0%' OR UPPER(sku) LIKE 'B0%' THEN 'MRMK'
    WHEN UPPER(sku) LIKE 'CS%' THEN 'Delphi'
    WHEN UPPER(sku) LIKE 'KT%' THEN 'Kintop'
    WHEN UPPER(sku) LIKE 'MQ%' OR UPPER(sku) LIKE 'AT%' OR UPPER(sku) LIKE 'FD%' OR UPPER(sku) LIKE 'FI%'
      OR UPPER(sku) LIKE 'GM%' OR UPPER(sku) LIKE 'HO%' OR UPPER(sku) LIKE 'HY%' OR UPPER(sku) LIKE 'KI%'
      OR UPPER(sku) LIKE 'MB%' OR UPPER(sku) LIKE 'NI%' OR UPPER(sku) LIKE 'PG%' OR UPPER(sku) LIKE 'RN%'
      OR UPPER(sku) LIKE 'SC%' OR UPPER(sku) LIKE 'TO%' OR UPPER(sku) LIKE 'UN%' OR UPPER(sku) LIKE 'VO%'
      OR UPPER(sku) LIKE 'VW%' OR UPPER(sku) LIKE 'AG%' OR UPPER(sku) LIKE 'BI%' OR UPPER(sku) LIKE 'BA%' THEN 'Multiqualita'
    -- 6 dígitos puros = ACA
    WHEN UPPER(sku) ~ '^[0-9]{6}$' THEN 'ACA'
    WHEN UPPER(sku) LIKE '19%' THEN 'Diversos'
    ELSE 'Diversos'
  END
)
WHERE fornecedor IS NULL OR fornecedor = '';
