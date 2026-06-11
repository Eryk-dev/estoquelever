-- ============================================================
-- 20260611q — fix: siso_claim_pedidos_para_agrupamento com referência ambígua
--
-- A versão de 20260316 falha com 42702 ("empresa_origem_id is ambiguous"):
-- RETURNS TABLE cria variáveis PL/pgSQL com os nomes das colunas de saída,
-- e o WHERE referenciava colunas sem qualificar. Em prod a função antiga
-- (criada manualmente) não tinha o conflito; no staging a migration era a
-- fonte e o claim quebrava SILENCIOSAMENTE (claimErr engolido no fase-1) —
-- nenhum agrupamento era criado.
--
-- Fix: qualificar TODAS as referências de coluna + cast de
-- empresa_origem_id (a coluna virou uuid no refactor 3D; a função de
-- 20260316 declarava text → 42804 "structure of query does not match").
-- ============================================================

CREATE OR REPLACE FUNCTION siso_claim_pedidos_para_agrupamento(p_pedido_ids text[])
RETURNS TABLE(id text, numero text, empresa_origem_id text, forma_envio_id text, forma_frete_id text, transportador_id text)
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
    siso_pedidos.empresa_origem_id::text,
    siso_pedidos.forma_envio_id,
    siso_pedidos.forma_frete_id,
    siso_pedidos.transportador_id;
END;
$$;

GRANT EXECUTE ON FUNCTION siso_claim_pedidos_para_agrupamento(text[]) TO service_role, authenticated, anon;
