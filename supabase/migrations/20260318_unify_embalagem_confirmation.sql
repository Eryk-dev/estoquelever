-- Unify embalagem confirmation logic.
-- The scanner now only resolves the next eligible item and delegates to the
-- same item-level RPC used by the manual +/- flow.

CREATE OR REPLACE FUNCTION siso_processar_item_embalagem(
  p_pedido_item_id uuid,
  p_delta integer DEFAULT 1
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
  v_pedido_id text;
  v_produto_id bigint;
  v_qtd_bipada integer;
  v_qtd_pedida numeric;
  v_bipado_completo boolean;
  v_pedido_completo boolean;
  v_itens_pendentes integer;
  v_status_separacao text;
  v_empresa_origem_id text;
  v_agrupamento_id text;
  v_etiqueta_zpl text;
  v_etiqueta_url text;
  v_galpao_id text;
  v_operador_id text;
  v_numero text;
BEGIN
  SELECT
    i.pedido_id,
    i.produto_id,
    COALESCE(i.quantidade_bipada, 0),
    COALESCE(i.quantidade_pedida, 0),
    p.status_separacao
  INTO
    v_pedido_id,
    v_produto_id,
    v_qtd_bipada,
    v_qtd_pedida,
    v_status_separacao
  FROM siso_pedido_itens i
  JOIN siso_pedidos p ON p.id = i.pedido_id
  WHERE i.id = p_pedido_item_id
  FOR UPDATE OF i, p;

  IF v_pedido_id IS NULL THEN
    RETURN;
  END IF;

  IF v_status_separacao <> 'separado' THEN
    RAISE EXCEPTION 'Pedido deve estar com status separado para embalagem';
  END IF;

  v_qtd_bipada := GREATEST(0, v_qtd_bipada + COALESCE(p_delta, 0));
  v_bipado_completo := (v_qtd_bipada >= v_qtd_pedida);

  UPDATE siso_pedido_itens
  SET quantidade_bipada = v_qtd_bipada,
      bipado_completo = v_bipado_completo
  WHERE id = p_pedido_item_id;

  SELECT COUNT(*)
  INTO v_itens_pendentes
  FROM siso_pedido_itens i
  WHERE i.pedido_id = v_pedido_id
    AND COALESCE(i.compra_status, '') NOT IN ('cancelado', 'indisponivel')
    AND COALESCE(i.quantidade_bipada, 0) < COALESCE(i.quantidade_pedida, 0);

  v_pedido_completo := (v_itens_pendentes = 0);

  IF v_pedido_completo THEN
    UPDATE siso_pedidos
    SET status_separacao = 'embalado',
        embalagem_concluida_em = now()
    WHERE id = v_pedido_id;

    UPDATE siso_pedidos
    SET etiqueta_status = 'imprimindo',
        updated_at = now()
    WHERE id = v_pedido_id
      AND (etiqueta_status IS NULL OR etiqueta_status IN ('pendente', 'falhou'))
    RETURNING
      empresa_origem_id,
      agrupamento_expedicao_id,
      etiqueta_zpl,
      etiqueta_url,
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

CREATE OR REPLACE FUNCTION siso_processar_bip_embalagem(
  p_sku text,
  p_galpao_id uuid,
  p_quantidade integer DEFAULT 1,
  p_pedido_ids text[] DEFAULT NULL
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
  v_item_id uuid;
BEGIN
  SELECT i.id
  INTO v_item_id
  FROM siso_pedido_itens i
  JOIN siso_pedidos p ON p.id = i.pedido_id
  WHERE p.status_separacao = 'separado'
    AND p.separacao_galpao_id = p_galpao_id
    AND (p_pedido_ids IS NULL OR p.id = ANY(p_pedido_ids))
    AND (i.sku = p_sku OR i.gtin = p_sku)
    AND COALESCE(i.compra_status, '') NOT IN ('cancelado', 'indisponivel')
    AND COALESCE(i.quantidade_bipada, 0) < COALESCE(i.quantidade_pedida, 0)
  ORDER BY p.data ASC, p.id ASC
  LIMIT 1
  FOR UPDATE OF i, p;

  IF v_item_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM siso_processar_item_embalagem(v_item_id, p_quantidade);
END;
$$;
