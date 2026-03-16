-- Fix: add nota_fiscal_id to claim RPC return, qualify column references to avoid ambiguity.
-- idsPedidos works correctly (Tiny auto-includes pedido's NF in the expedition).
-- Removed nota_fiscal_id IS NOT NULL filter so agrupamentos can be created
-- before the NF webhook arrives.

DROP FUNCTION IF EXISTS siso_claim_pedidos_para_agrupamento(text[]);

CREATE OR REPLACE FUNCTION siso_claim_pedidos_para_agrupamento(p_pedido_ids text[])
RETURNS TABLE(id text, numero text, empresa_origem_id text, nota_fiscal_id bigint, forma_envio_id text, forma_frete_id text, transportador_id text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  UPDATE siso_pedidos
  SET agrupamento_expedicao_id = 'pending', updated_at = now()
  WHERE siso_pedidos.id = ANY(p_pedido_ids)
    AND siso_pedidos.empresa_origem_id IS NOT NULL
    AND siso_pedidos.agrupamento_expedicao_id IS NULL
  RETURNING
    siso_pedidos.id,
    siso_pedidos.numero,
    siso_pedidos.empresa_origem_id,
    siso_pedidos.nota_fiscal_id,
    siso_pedidos.forma_envio_id,
    siso_pedidos.forma_frete_id,
    siso_pedidos.transportador_id;
END;
$$;

GRANT EXECUTE ON FUNCTION siso_claim_pedidos_para_agrupamento(text[]) TO service_role, authenticated, anon;
