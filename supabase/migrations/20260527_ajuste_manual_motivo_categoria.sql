-- D.1.1 — Estrutura categoria de motivo em ajustes manuais.
--
-- Hoje `siso_movimentacoes.motivo` é texto livre — útil pra contexto, mas
-- não filtra/agrupa. Pra apuração (saídas por categoria, perdas por avaria,
-- etc.) precisamos de campo discriminado. Solução: enum `wms_motivo_categoria_enum`
-- + coluna `motivo_categoria` nullable em movs.
--
-- Soft-enforce via aplicação: o endpoint /api/wms/ajuste exigirá a
-- categoria; rows antigas ficam com motivo_categoria=NULL (compat).

BEGIN;

DO $$ BEGIN
  CREATE TYPE wms_motivo_categoria_enum AS ENUM (
    'avaria',
    'perda',
    'achado',
    'correcao_inventario',
    'devolucao_sem_fluxo',
    'outro'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE siso_movimentacoes
  ADD COLUMN IF NOT EXISTS motivo_categoria wms_motivo_categoria_enum;

CREATE INDEX IF NOT EXISTS idx_movs_motivo_categoria
  ON siso_movimentacoes(motivo_categoria, origem_tipo)
  WHERE motivo_categoria IS NOT NULL;

COMMIT;

-- DOWN:
--   ALTER TABLE siso_movimentacoes DROP COLUMN motivo_categoria;
--   DROP TYPE wms_motivo_categoria_enum;
