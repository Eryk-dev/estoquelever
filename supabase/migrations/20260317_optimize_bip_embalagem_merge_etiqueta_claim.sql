-- Optimize bip embalagem: merge etiqueta claim into bip processing
-- to eliminate one DB roundtrip (~30-50ms savings per print).
--
-- When pedido_completo, the function now also:
-- 1. Claims etiqueta_status = 'imprimindo' (same as siso_claim_etiqueta)
-- 2. Returns print-related fields so the caller can skip the claim RPC

DROP FUNCTION IF EXISTS siso_processar_bip_embalagem(text, uuid, int);

CREATE OR REPLACE FUNCTION siso_processar_bip_embalagem(
  p_sku text,
  p_galpao_id uuid,
  p_quantidade int DEFAULT 1
)
RETURNS TABLE(
  pedido_id text,
  produto_id text,
  quantidade_bipada numeric,
  bipado_completo boolean,
  pedido_completo boolean,
  -- Print-related fields (populated only when pedido_completo AND etiqueta claimed)
  etiqueta_empresa_origem_id text,
  etiqueta_agrupamento_id text,
  etiqueta_zpl text,
  etiqueta_url text,
  etiqueta_galpao_id text,
  etiqueta_operador_id text,
  etiqueta_numero text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id uuid;
  v_pedido_id text;
  v_produto_id bigint;
  v_qtd_bipada integer;
  v_qtd_pedida numeric;
  v_bipado_completo boolean;
  v_pedido_completo boolean;
  v_itens_pendentes integer;
  -- Print fields
  v_empresa_origem_id text;
  v_agrupamento_id text;
  v_etiqueta_zpl text;
  v_etiqueta_url text;
  v_galpao_id text;
  v_operador_id text;
  v_numero text;
BEGIN
  -- Find the oldest separado-status order with the scanned SKU
  -- Lock the item row to prevent race conditions on concurrent scans
  SELECT i.id, i.pedido_id, i.produto_id, i.quantidade_bipada, i.quantidade_pedida
  INTO v_item_id, v_pedido_id, v_produto_id, v_qtd_bipada, v_qtd_pedida
  FROM siso_pedido_itens i
  JOIN siso_pedidos p ON p.id = i.pedido_id
  JOIN siso_empresas e ON e.id = p.empresa_origem_id
  WHERE p.status_separacao = 'separado'
    AND e.galpao_id = p_galpao_id
    AND (i.sku = p_sku OR i.gtin = p_sku)
    AND i.bipado_completo = false
  ORDER BY p.data ASC
  LIMIT 1
  FOR UPDATE OF i;

  IF v_item_id IS NULL THEN
    RETURN;
  END IF;

  -- Increment quantidade_bipada
  v_qtd_bipada := COALESCE(v_qtd_bipada, 0) + p_quantidade;
  v_bipado_completo := (v_qtd_bipada >= v_qtd_pedida);

  UPDATE siso_pedido_itens
  SET quantidade_bipada = v_qtd_bipada,
      bipado_completo = v_bipado_completo
  WHERE id = v_item_id;

  -- Check if ALL items of this pedido have bipado_completo = true
  SELECT COUNT(*)
  INTO v_itens_pendentes
  FROM siso_pedido_itens
  WHERE siso_pedido_itens.pedido_id = v_pedido_id
    AND bipado_completo = false;

  v_pedido_completo := (v_itens_pendentes = 0);

  IF v_pedido_completo THEN
    -- Transition to embalado (always)
    UPDATE siso_pedidos
    SET status_separacao = 'embalado',
        embalagem_concluida_em = now()
    WHERE id = v_pedido_id;

    -- Claim etiqueta atomically (only if claimable)
    -- If already claimed by another path, print fields remain null
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
      separacao_operador_id::text,
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
