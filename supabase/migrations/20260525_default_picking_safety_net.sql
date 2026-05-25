-- Garante que cada galpão ativo tenha uma loc DEFAULT-PICKING.
-- Pré-requisito do cutover WMS_AS_SOURCE: src/lib/separacao/wms-mapping.ts
-- usa essa loc como fallback quando o estoque vem sem código de localização
-- (e lança "schema corrompido" se não existir).

INSERT INTO siso_localizacoes (galpao_id, codigo, tipo, ativo)
SELECT g.id, 'DEFAULT-PICKING', 'picking', true
FROM siso_galpoes g
WHERE g.ativo
  AND NOT EXISTS (
    SELECT 1 FROM siso_localizacoes l
    WHERE l.galpao_id = g.id AND l.codigo = 'DEFAULT-PICKING'
  );
