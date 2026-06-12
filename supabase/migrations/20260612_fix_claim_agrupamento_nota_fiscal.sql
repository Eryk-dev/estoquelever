-- ============================================================
-- 20260612 — fix: siso_claim_pedidos_para_agrupamento perdeu nota_fiscal_id
--
-- A 20260611q corrigiu a ambiguidade do claim partindo da versão ERRADA
-- (20260316_etiqueta_status_rpc_functions, sem nota_fiscal_id) em vez da
-- corrigida (20260316_fix_agrupamento_use_nf_ids, com nota_fiscal_id).
-- Resultado: o claim retorna sem nota_fiscal_id, o guard pós-claim do
-- criarAgrupamentoFase1 vê undefined, DESFAZ o claim e retorna em silêncio
-- — nenhum agrupamento era criado em staging (visto em 2026-06-12 nos 16
-- pedidos recuperados do incidente do webhook).
--
-- Esta versão: referências qualificadas (sem 42702), tipos casados com as
-- colunas reais (empresa_origem_id uuid, nota_fiscal_id bigint — sem 42804)
-- e nota_fiscal_id de volta no RETURNING.
-- ============================================================

-- Return type muda (nota_fiscal_id volta) — CREATE OR REPLACE não pode (42P13)
DROP FUNCTION IF EXISTS siso_claim_pedidos_para_agrupamento(text[]);

CREATE FUNCTION siso_claim_pedidos_para_agrupamento(p_pedido_ids text[])
RETURNS TABLE(
  id text,
  numero text,
  empresa_origem_id uuid,
  nota_fiscal_id bigint,
  forma_envio_id text,
  forma_frete_id text,
  transportador_id text
)
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
