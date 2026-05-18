-- ============================================================
-- Fix-pack realocação cascateável — Task 1.4
-- Spec: docs/superpowers/specs/2026-05-18-realocacao-cascateavel-fix-pack-design.md § 1.4
--
-- Ampliação da RPC `siso_processar_bip_embalagem`:
--   - novo parâmetro `p_strict_qty_pega boolean DEFAULT false` (no fim, pra
--     preservar chamadores posicionais).
--   - quando true E item.separacao_parcial=true, teto da bipagem passa a ser
--     `quantidade_pega + Σ realocacoes.quantidade_pega (picado|picado_parcial)`
--     em vez de `quantidade_pedida`. Defesa em profundidade (Bug I6).
--   - quando false (default), comportamento idêntico ao da versão atual em
--     produção (4-arg, RETURNS TABLE) — backward-compat total.
--
-- Base preservada: versão live em prod (= migration 20260401_embalagem_operador_id.sql).
-- Staging ainda não tinha a função; CREATE OR REPLACE cria do zero lá.
-- ============================================================

CREATE OR REPLACE FUNCTION siso_processar_bip_embalagem(
  p_sku text,
  p_galpao_id uuid DEFAULT NULL,
  p_quantidade integer DEFAULT 1,
  p_operador_id uuid DEFAULT NULL,
  p_strict_qty_pega boolean DEFAULT false
)
RETURNS TABLE(
  pedido_id text,
  produto_id text,
  quantidade_bipada numeric,
  bipado_completo boolean,
  pedido_completo boolean,
  etiqueta_empresa_origem_id text,
  etiqueta_agrupamento_id text,
  etiqueta_zpl text,
  etiqueta_url text,
  etiqueta_galpao_id text,
  etiqueta_operador_id text,
  etiqueta_numero text
)
LANGUAGE plpgsql AS $$
DECLARE
  v_item_id bigint;
  v_pedido_id text;
  v_produto_id bigint;
  v_qtd_bipada integer;
  v_qtd_pedida numeric;
  v_bipado_completo boolean;
  v_pedido_completo boolean;
  v_itens_pendentes integer;
  v_empresa_origem_id text;
  v_agrupamento_id text;
  v_etiqueta_zpl text;
  v_etiqueta_url text;
  v_galpao_id text;
  v_operador_id text;
  v_numero text;
  v_sku_upper text := UPPER(TRIM(p_sku));
  v_separacao_parcial boolean;
  v_qtd_pega integer;
  v_teto numeric;
BEGIN
  SELECT i.id, i.pedido_id, i.produto_id, i.quantidade_bipada, i.quantidade_pedida,
         i.separacao_parcial, i.quantidade_pega
  INTO v_item_id, v_pedido_id, v_produto_id, v_qtd_bipada, v_qtd_pedida,
       v_separacao_parcial, v_qtd_pega
  FROM siso_pedido_itens i
  JOIN siso_pedidos p ON p.id = i.pedido_id
  WHERE p.status_separacao = 'separado'
    AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
    AND (UPPER(i.sku) = v_sku_upper OR UPPER(i.gtin) = v_sku_upper)
    AND i.bipado_completo = false
    AND COALESCE(i.compra_status, '') NOT IN ('cancelado', 'indisponivel')
  ORDER BY
    -- Prioritize orders that already have items scanned (in-progress packing)
    CASE WHEN EXISTS (
      SELECT 1 FROM siso_pedido_itens x
      WHERE x.pedido_id = p.id AND x.quantidade_bipada > 0
    ) THEN 0 ELSE 1 END,
    p.data ASC
  LIMIT 1
  FOR UPDATE OF i;

  IF v_item_id IS NULL THEN
    RETURN;
  END IF;

  v_qtd_bipada := COALESCE(v_qtd_bipada, 0) + p_quantidade;

  -- Cálculo do teto:
  --   strict + parcial → soma quantidade_pega do item + das realocs picadas
  --   caso contrário   → preserva comportamento legacy (quantidade_pedida)
  IF p_strict_qty_pega AND COALESCE(v_separacao_parcial, false) THEN
    v_teto := COALESCE(v_qtd_pega, 0) +
              COALESCE(
                (SELECT SUM(quantidade_pega)
                   FROM siso_pedido_item_realocacoes
                  WHERE pedido_item_id = v_item_id
                    AND status IN ('picado','picado_parcial')),
                0
              );
    IF v_qtd_bipada > v_teto THEN
      RAISE EXCEPTION 'bipou_alem_do_teto'
        USING DETAIL = format('teto=%s,tentado=%s', v_teto, v_qtd_bipada),
              HINT   = 'item em separacao_parcial — limite = quantidade_pega real';
    END IF;
  ELSE
    v_teto := v_qtd_pedida;
  END IF;

  v_bipado_completo := (v_qtd_bipada >= v_teto);

  UPDATE siso_pedido_itens
  SET quantidade_bipada = v_qtd_bipada,
      bipado_completo = v_bipado_completo
  WHERE id = v_item_id;

  SELECT COUNT(*)
  INTO v_itens_pendentes
  FROM siso_pedido_itens pit
  WHERE pit.pedido_id = v_pedido_id
    AND pit.bipado_completo = false
    AND COALESCE(pit.compra_status, '') NOT IN ('cancelado', 'indisponivel');

  v_pedido_completo := (v_itens_pendentes = 0);

  IF v_pedido_completo THEN
    UPDATE siso_pedidos
    SET status_separacao = 'embalado',
        embalagem_concluida_em = now(),
        embalagem_operador_id = p_operador_id
    WHERE id = v_pedido_id;

    UPDATE siso_pedidos
    SET etiqueta_status = 'imprimindo',
        updated_at = now()
    WHERE id = v_pedido_id
      AND (etiqueta_status IS NULL OR etiqueta_status IN ('pendente', 'falhou'))
    RETURNING
      empresa_origem_id,
      agrupamento_expedicao_id,
      siso_pedidos.etiqueta_zpl,
      siso_pedidos.etiqueta_url,
      separacao_galpao_id::text,
      COALESCE(p_operador_id, separacao_operador_id)::text,
      numero
    INTO
      v_empresa_origem_id,
      v_agrupamento_id,
      v_etiqueta_zpl,
      v_etiqueta_url,
      v_galpao_id,
      v_operador_id,
      v_numero;
  END IF;

  RETURN QUERY SELECT
    v_pedido_id,
    v_produto_id::text,
    v_qtd_bipada::numeric,
    v_bipado_completo,
    v_pedido_completo,
    v_empresa_origem_id,
    v_agrupamento_id,
    v_etiqueta_zpl,
    v_etiqueta_url,
    v_galpao_id,
    v_operador_id,
    v_numero;
END;
$$;
