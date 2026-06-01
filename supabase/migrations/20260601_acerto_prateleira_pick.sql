-- Acerto de prateleira no pick (Fase 1)
-- Marca a sessão de inventário "operacional contínua" por galpão, que hospeda
-- as contagens inline aplicadas na hora (fora do ciclo planejada→aprovada→aplicada).

ALTER TABLE siso_inventario_sessoes
  ADD COLUMN IF NOT EXISTS continua boolean NOT NULL DEFAULT false;

-- No máximo 1 sessão contínua por galpão (get-or-create idempotente).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sessao_continua_galpao
  ON siso_inventario_sessoes (galpao_id)
  WHERE continua;

COMMENT ON COLUMN siso_inventario_sessoes.continua IS
  'Sessão operacional contínua (1 por galpão) que hospeda contagens inline do pick (acerto de prateleira). Nunca passa por aprovação em bloco.';
