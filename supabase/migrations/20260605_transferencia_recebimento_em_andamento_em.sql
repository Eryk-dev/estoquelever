-- P062 — Timestamp do lock de recebimento de transferência inter-galpão.
--
-- A migration 20260527_p3 adicionou recebimento_em_andamento_por (uuid) mas
-- SEM timestamp. cancelarTransferencia precisa do timestamp pra decidir se o
-- lock está stale (>30min) e pode ser sobrescrito por qualquer operador
-- (caso a tela do recebedor caia no meio).

ALTER TABLE siso_transferencias_galpao
  ADD COLUMN IF NOT EXISTS recebimento_em_andamento_em timestamptz;

COMMENT ON COLUMN siso_transferencias_galpao.recebimento_em_andamento_em IS
  'P062 — Quando o lock de recebimento foi adquirido. NULL = sem recebimento. '
  'Usado por cancelarTransferencia pro timeout de 30min (lock stale = qualquer '
  'um pode cancelar). Setado junto com recebimento_em_andamento_por no claim do '
  'receber; limpado (NULL implícito) no flip pra status=recebida.';
