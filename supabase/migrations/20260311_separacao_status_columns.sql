-- ============================================================
-- Migration: Align separation statuses and columns with new PRD
-- US-002: Schema — Migration for new separation statuses and columns
-- ============================================================

-- 1. Drop old CHECK constraint on status_separacao (auto-generated name)
DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT c.conname INTO v_constraint_name
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
  WHERE c.conrelid = 'siso_pedidos'::regclass
    AND c.contype = 'c'
    AND a.attname = 'status_separacao';

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE siso_pedidos DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

-- 2. Migrate existing status values to new names
UPDATE siso_pedidos SET status_separacao = 'aguardando_separacao' WHERE status_separacao = 'pendente';
UPDATE siso_pedidos SET status_separacao = 'embalado' WHERE status_separacao = 'expedido';

-- 3. Add new CHECK constraint with PRD status values
ALTER TABLE siso_pedidos
  ADD CONSTRAINT siso_pedidos_status_separacao_check
  CHECK (status_separacao IS NULL OR status_separacao IN (
    'aguardando_nf', 'aguardando_separacao', 'em_separacao', 'separado', 'embalado', 'cancelado'
  ));

-- 4. Rename columns to match new PRD naming
ALTER TABLE siso_pedidos RENAME COLUMN separado_por TO separacao_operador_id;
ALTER TABLE siso_pedidos RENAME COLUMN separado_em TO separacao_iniciada_em;
ALTER TABLE siso_pedidos RENAME COLUMN embalado_em TO embalagem_concluida_em;

-- 5. Add new columns to siso_pedidos
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS separacao_concluida_em timestamptz NULL;

-- Replace agrupamento_tiny_id (bigint) with agrupamento_expedicao_id (text)
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS agrupamento_expedicao_id text NULL;
UPDATE siso_pedidos
  SET agrupamento_expedicao_id = agrupamento_tiny_id::text
  WHERE agrupamento_tiny_id IS NOT NULL;
ALTER TABLE siso_pedidos DROP COLUMN IF EXISTS agrupamento_tiny_id;

-- etiqueta_url already exists from 20260311_add_separacao_columns.sql — skip

-- 6. Add separation checklist columns to siso_pedido_itens
ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS separacao_marcado boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS separacao_marcado_em timestamptz NULL;

-- 7. Drop stale indexes that reference old 'pendente' status value
DROP INDEX IF EXISTS idx_pedidos_separacao_galpao;
DROP INDEX IF EXISTS idx_pedidos_separacao_data;

-- 8. Recreate indexes with updated status values
CREATE INDEX IF NOT EXISTS idx_pedidos_separacao_galpao
  ON siso_pedidos (separacao_galpao_id, status_separacao)
  WHERE status_separacao IN ('aguardando_separacao', 'em_separacao');

CREATE INDEX IF NOT EXISTS idx_pedidos_separacao_data
  ON siso_pedidos (separacao_galpao_id, data ASC)
  WHERE status_separacao IN ('aguardando_separacao', 'em_separacao');

-- 9. Create index for separation queries by status + empresa (PRD requirement)
CREATE INDEX IF NOT EXISTS idx_siso_pedidos_status_empresa
  ON siso_pedidos (status_separacao, empresa_origem_id);

-- 10. Update PL/pgSQL function to use renamed columns and new status values
CREATE OR REPLACE FUNCTION siso_processar_bip(
  p_codigo text,
  p_usuario_id uuid,
  p_galpao_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_item RECORD;
  v_pedido RECORD;
  v_itens_faltam integer;
BEGIN
  SELECT pi.pedido_id, pi.produto_id, pi.quantidade_bipada, pi.quantidade_pedida,
         pi.sku, p.numero AS pedido_numero, p.status_separacao
  INTO v_item
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  WHERE (pi.gtin = p_codigo OR pi.sku = p_codigo)
    AND pi.bipado_completo = false
    AND p.separacao_galpao_id = p_galpao_id
    AND p.status_separacao IN ('aguardando_separacao', 'em_separacao')
    AND p.status != 'cancelado'
  ORDER BY p.data ASC
  LIMIT 1
  FOR UPDATE OF pi SKIP LOCKED;

  IF v_item IS NULL THEN
    RETURN jsonb_build_object('status', 'nao_encontrado', 'codigo', p_codigo);
  END IF;

  IF v_item.quantidade_bipada >= v_item.quantidade_pedida THEN
    RETURN jsonb_build_object('status', 'ja_completo', 'pedido_id', v_item.pedido_id, 'sku', v_item.sku);
  END IF;

  UPDATE siso_pedido_itens SET
    quantidade_bipada = quantidade_bipada + 1,
    bipado_por = p_usuario_id,
    bipado_completo = (quantidade_bipada + 1 >= quantidade_pedida),
    bipado_em = CASE WHEN (quantidade_bipada + 1 >= quantidade_pedida) THEN now() ELSE bipado_em END
  WHERE pedido_id = v_item.pedido_id AND produto_id = v_item.produto_id;

  IF v_item.status_separacao = 'aguardando_separacao' THEN
    UPDATE siso_pedidos SET
      status_separacao = 'em_separacao',
      separacao_operador_id = p_usuario_id,
      separacao_iniciada_em = now()
    WHERE id = v_item.pedido_id AND status_separacao = 'aguardando_separacao';
  END IF;

  SELECT COUNT(*) FILTER (WHERE bipado_completo = false) INTO v_itens_faltam
  FROM siso_pedido_itens WHERE pedido_id = v_item.pedido_id;

  IF v_itens_faltam = 0 THEN
    UPDATE siso_pedidos SET
      status_separacao = 'embalado',
      embalagem_concluida_em = now(),
      etiqueta_status = 'pendente'
    WHERE id = v_item.pedido_id;

    RETURN jsonb_build_object(
      'status', 'pedido_completo',
      'pedido_id', v_item.pedido_id,
      'pedido_numero', v_item.pedido_numero,
      'sku', v_item.sku,
      'bipados', v_item.quantidade_bipada + 1,
      'total', v_item.quantidade_pedida
    );
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN (v_item.quantidade_bipada + 1 >= v_item.quantidade_pedida) THEN 'item_completo' ELSE 'parcial' END,
    'pedido_id', v_item.pedido_id,
    'pedido_numero', v_item.pedido_numero,
    'sku', v_item.sku,
    'bipados', v_item.quantidade_bipada + 1,
    'total', v_item.quantidade_pedida,
    'itens_faltam', v_itens_faltam
  );
END;
$$ LANGUAGE plpgsql;
