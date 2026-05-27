BEGIN;

ALTER TABLE siso_transferencias_galpao
  ADD COLUMN IF NOT EXISTS expira_em timestamptz;

UPDATE siso_transferencias_galpao
   SET expira_em = COALESCE(criada_em, now()) + interval '7 days'
 WHERE expira_em IS NULL
   AND status = 'em_transito';

ALTER TABLE siso_transferencias_galpao
  ALTER COLUMN expira_em SET DEFAULT (now() + interval '7 days');

CREATE INDEX IF NOT EXISTS idx_transf_galpao_expira_em
  ON siso_transferencias_galpao(expira_em)
  WHERE status = 'em_transito';

COMMIT;
