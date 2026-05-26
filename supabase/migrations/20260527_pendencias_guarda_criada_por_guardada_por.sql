BEGIN;

ALTER TABLE siso_wms_pendencias_guarda
  ADD COLUMN IF NOT EXISTS criada_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN IF NOT EXISTS guardada_por uuid REFERENCES siso_usuarios(id);

CREATE INDEX IF NOT EXISTS idx_pend_guarda_criada_por
  ON siso_wms_pendencias_guarda(criada_por);

UPDATE siso_wms_pendencias_guarda p
   SET criada_por = m.usuario_id
  FROM siso_movimentacoes m
 WHERE p.criada_por IS NULL
   AND p.mov_entrada_id = m.id
   AND m.usuario_id IS NOT NULL;

UPDATE siso_wms_pendencias_guarda
   SET guardada_por = iniciada_por
 WHERE guardada_por IS NULL
   AND status = 'guardada'
   AND iniciada_por IS NOT NULL;

COMMIT;
