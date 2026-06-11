-- Conferência de embalagem: barcode da etiqueta + auditoria embalador/conferente
-- Fluxo: embalador bipa etiqueta de envio ao embalar (embalado_real_*, sem mudança
-- de status); conferente bipa de novo → status_separacao='conferido'. Divergência
-- achada na conferência registra tipo+obs (conta contra o embalador nas métricas).
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS etiqueta_barcodes text[],
  ADD COLUMN IF NOT EXISTS embalado_real_por uuid REFERENCES siso_usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS embalado_real_em timestamptz,
  ADD COLUMN IF NOT EXISTS conferido_por uuid REFERENCES siso_usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS conferido_em timestamptz,
  ADD COLUMN IF NOT EXISTS divergencia_tipo text
    CHECK (divergencia_tipo IN ('produto_errado','faltou_item','sobrou_item','quantidade_errada')),
  ADD COLUMN IF NOT EXISTS divergencia_obs text;

-- Lookup do bip: contains no array (etiqueta pode ter vários barcodes: envio + DANFE)
CREATE INDEX IF NOT EXISTS idx_pedidos_etiqueta_barcodes
  ON siso_pedidos USING gin (etiqueta_barcodes)
  WHERE etiqueta_barcodes IS NOT NULL;

-- Métricas por embalador (relatório filtra por período)
CREATE INDEX IF NOT EXISTS idx_pedidos_embalado_real
  ON siso_pedidos (embalado_real_por, embalado_real_em)
  WHERE embalado_real_por IS NOT NULL;
