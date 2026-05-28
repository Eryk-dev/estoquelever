-- Decisão 8 (28/05): adiciona loc tipo "packing" pra cross-docking +
-- seed 1 loc PACKING-{nome_galpao} em cada galpão ativo. Recebimento OC
-- com demanda viva splita pendência: parte cross-dock vai pra PACKING,
-- parte excedente vai pra guarda normal.

ALTER TABLE siso_localizacoes DROP CONSTRAINT IF EXISTS siso_localizacoes_tipo_check;
ALTER TABLE siso_localizacoes ADD CONSTRAINT siso_localizacoes_tipo_check
  CHECK (tipo IN ('picking','overstock','recebimento','expedicao','quarentena','packing'));

-- Seed PACKING-{nome} em cada galpão ativo (idempotente)
INSERT INTO siso_localizacoes (galpao_id, codigo, descricao, tipo, ativo)
SELECT g.id, 'PACKING-' || UPPER(g.nome), 'Staging cross-docking', 'packing', true
FROM siso_galpoes g
WHERE g.ativo = true
ON CONFLICT (galpao_id, codigo) DO NOTHING;
