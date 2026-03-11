-- ============================================================
-- Migration: Add status_unificado column to siso_pedidos
-- US-001: Unify status + status_separacao into one column
-- ============================================================

-- 1. Add status_unificado column with CHECK and DEFAULT
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS status_unificado text DEFAULT 'pendente'
    CHECK (status_unificado IN (
      'pendente',
      'executando',
      'aguardando_compra',
      'aguardando_nf',
      'aguardando_separacao',
      'em_separacao',
      'separado',
      'embalado',
      'cancelado',
      'erro'
    ));

-- 2. Backfill existing rows from status + status_separacao
-- Order matters: most specific first (concluido + status_separacao), then general

-- concluido + specific status_separacao values
UPDATE siso_pedidos SET status_unificado = 'aguardando_compra'
  WHERE status = 'concluido' AND status_separacao = 'aguardando_compra';

UPDATE siso_pedidos SET status_unificado = 'aguardando_nf'
  WHERE status = 'concluido' AND status_separacao = 'aguardando_nf';

UPDATE siso_pedidos SET status_unificado = 'aguardando_separacao'
  WHERE status = 'concluido' AND status_separacao = 'aguardando_separacao';

UPDATE siso_pedidos SET status_unificado = 'em_separacao'
  WHERE status = 'concluido' AND status_separacao = 'em_separacao';

UPDATE siso_pedidos SET status_unificado = 'separado'
  WHERE status = 'concluido' AND status_separacao = 'separado';

UPDATE siso_pedidos SET status_unificado = 'embalado'
  WHERE status = 'concluido' AND status_separacao = 'embalado';

-- concluido with NULL status_separacao defaults to aguardando_separacao
UPDATE siso_pedidos SET status_unificado = 'aguardando_separacao'
  WHERE status = 'concluido' AND status_separacao IS NULL;

-- Direct status mappings (non-concluido)
UPDATE siso_pedidos SET status_unificado = 'pendente'
  WHERE status = 'pendente';

UPDATE siso_pedidos SET status_unificado = 'executando'
  WHERE status = 'executando';

UPDATE siso_pedidos SET status_unificado = 'cancelado'
  WHERE status = 'cancelado';

UPDATE siso_pedidos SET status_unificado = 'erro'
  WHERE status = 'erro';

-- 3. Create index for queries by status_unificado
CREATE INDEX IF NOT EXISTS idx_siso_pedidos_status_unificado
  ON siso_pedidos (status_unificado);
