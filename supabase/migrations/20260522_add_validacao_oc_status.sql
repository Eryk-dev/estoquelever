-- Add 'validacao_oc' to the status_separacao CHECK constraint
-- Required for the OC validation flow (execution-worker.ts:665 setta esse
-- valor após gerar OCs; sem isso o UPDATE falha silenciosamente).

ALTER TABLE siso_pedidos DROP CONSTRAINT IF EXISTS siso_pedidos_status_separacao_check;

ALTER TABLE siso_pedidos ADD CONSTRAINT siso_pedidos_status_separacao_check
  CHECK (
    status_separacao IS NULL
    OR status_separacao = ANY (ARRAY[
      'aguardando_compra',
      'aguardando_nf',
      'aguardando_separacao',
      'em_separacao',
      'separado',
      'embalado',
      'expedido',
      'pendente_realocacao',
      'validacao_oc'
    ])
  );
