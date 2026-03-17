-- Add forma_frete_id to siso_claim_etiqueta RPC return
-- so etiqueta-service can pass it to criarAgrupamento
CREATE OR REPLACE FUNCTION siso_claim_etiqueta(p_pedido_id text)
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
    'nota_fiscal_id', nota_fiscal_id,
    'forma_frete_id', forma_frete_id,
    'agrupamento_expedicao_id', agrupamento_expedicao_id,
    'etiqueta_url', etiqueta_url,
    'etiqueta_zpl', etiqueta_zpl,
    'separacao_galpao_id', separacao_galpao_id,
    'separacao_operador_id', separacao_operador_id
  ) INTO v_row;

  RETURN v_row;
END;
$$;
