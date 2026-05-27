-- Remove 'aplicada' do CHECK de siso_devolucoes_pendentes.status — nunca
-- foi usado no fluxo. 'classificada' é o estado terminal pós-classificação.
BEGIN;

-- Sanity: garante que nenhuma linha tem status='aplicada' (caso edge)
UPDATE siso_devolucoes_pendentes
   SET status = 'classificada'
 WHERE status = 'aplicada';

-- Recria CHECK sem 'aplicada'
ALTER TABLE siso_devolucoes_pendentes
  DROP CONSTRAINT IF EXISTS siso_devolucoes_pendentes_status_check;

ALTER TABLE siso_devolucoes_pendentes
  ADD CONSTRAINT siso_devolucoes_pendentes_status_check
  CHECK (status IN ('aguardando_classificacao', 'classificada', 'cancelada'));

COMMIT;

-- DOWN:
--   ALTER TABLE siso_devolucoes_pendentes DROP CONSTRAINT siso_devolucoes_pendentes_status_check;
--   ALTER TABLE siso_devolucoes_pendentes ADD CONSTRAINT siso_devolucoes_pendentes_status_check
--     CHECK (status IN ('aguardando_classificacao', 'classificada', 'aplicada', 'cancelada'));
