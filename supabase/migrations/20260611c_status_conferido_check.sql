-- Conferência de embalagem: o CHECK de status_separacao enumera os valores
-- válidos e não tinha 'conferido' — o UPDATE embalado→conferido violava o
-- constraint e o claim atômico da rota de bip falhava silenciosamente.
ALTER TABLE siso_pedidos
  DROP CONSTRAINT IF EXISTS siso_pedidos_status_separacao_check;

ALTER TABLE siso_pedidos
  ADD CONSTRAINT siso_pedidos_status_separacao_check
  CHECK (
    status_separacao IS NULL
    OR status_separacao = ANY (ARRAY[
      'aguardando_compra'::text,
      'aguardando_nf'::text,
      'aguardando_separacao'::text,
      'em_separacao'::text,
      'separado'::text,
      'embalado'::text,
      'conferido'::text,
      'expedido'::text,
      'pendente_realocacao'::text,
      'validacao_oc'::text
    ])
  );
