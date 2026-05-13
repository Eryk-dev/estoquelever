-- WMS — Pendência de guarda guarda a loc destino decidida no recebimento
-- O operador do recebimento agora decide a loc destino (vendo onde o SKU
-- já tem saldo + atalhos). A loc é salva na pendência e usada como:
--   1) localização impressa na etiqueta (em vez de adivinhar via query)
--   2) default no tablet de guarda (operador pode bipa outra pra trocar)
-- Optional — se NULL, comportamento velho (sugestão dinâmica no tablet).

BEGIN;

ALTER TABLE siso_wms_pendencias_guarda
  ADD COLUMN IF NOT EXISTS localizacao_destino_id uuid REFERENCES siso_localizacoes(id);

COMMENT ON COLUMN siso_wms_pendencias_guarda.localizacao_destino_id IS
  'Loc destino decidida pelo operador do recebimento (opcional). Quando NULL, o tablet de guarda usa a sugestão dinâmica de putaway. Não força a guarda — o tablet pode trocar via bipe.';

CREATE INDEX IF NOT EXISTS idx_pendencias_guarda_destino
  ON siso_wms_pendencias_guarda(localizacao_destino_id)
  WHERE localizacao_destino_id IS NOT NULL;

COMMIT;
