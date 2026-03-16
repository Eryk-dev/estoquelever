-- RPC functions to bypass PostgREST schema cache issue with etiqueta_status column.
-- PostgREST's introspection cache doesn't see this column, so .update() calls fail.
-- These functions use direct SQL, bypassing the cache entirely.

-- 1. Atomic claim for printing: transitions null/pendente/falhou -> imprimindo
--    Returns the claimed row as JSON, or null if already claimed.
CREATE OR REPLACE FUNCTION siso_claim_etiqueta(p_pedido_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row jsonb;
BEGIN
  UPDATE siso_pedidos
  SET etiqueta_status = 'imprimindo', updated_at = now()
  WHERE id = p_pedido_id
    AND (etiqueta_status IS NULL OR etiqueta_status IN ('pendente', 'falhou'))
  RETURNING jsonb_build_object(
    'id', id,
    'numero', numero,
    'empresa_origem_id', empresa_origem_id,
    'agrupamento_expedicao_id', agrupamento_expedicao_id,
    'etiqueta_url', etiqueta_url,
    'etiqueta_zpl', etiqueta_zpl,
    'separacao_galpao_id', separacao_galpao_id,
    'separacao_operador_id', separacao_operador_id
  ) INTO v_row;

  RETURN v_row; -- null if no row matched (already claimed/printed)
END;
$$;

-- 2. Set etiqueta_status to any valid value (or null)
CREATE OR REPLACE FUNCTION siso_set_etiqueta_status(
  p_pedido_id uuid,
  p_status text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE siso_pedidos
  SET etiqueta_status = p_status, updated_at = now()
  WHERE id = p_pedido_id;
END;
$$;

-- Grant execute to all roles
GRANT EXECUTE ON FUNCTION siso_claim_etiqueta(uuid) TO service_role, authenticated, anon;
GRANT EXECUTE ON FUNCTION siso_set_etiqueta_status(uuid, text) TO service_role, authenticated, anon;
