-- US-004: PL/pgSQL function to process barcode scan during packing (embalagem)
-- Finds the oldest separado-status order in the given galpao with the scanned SKU,
-- increments quantidade_bipada, and transitions to 'embalado' when all items are complete.

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
  pedido_completo boolean
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
BEGIN
  -- Find the oldest separado-status order in the given galpao with the scanned SKU
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

  -- Return nothing if no matching item found
  IF v_item_id IS NULL THEN
    RETURN;
  END IF;

  -- Increment quantidade_bipada
  v_qtd_bipada := COALESCE(v_qtd_bipada, 0) + p_quantidade;

  -- Check if item is fully scanned
  v_bipado_completo := (v_qtd_bipada >= v_qtd_pedida);

  -- Update the item
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

  -- If all items complete, update pedido status to 'embalado'
  IF v_pedido_completo THEN
    UPDATE siso_pedidos
    SET status_separacao = 'embalado',
        embalagem_concluida_em = now()
    WHERE id = v_pedido_id;
  END IF;

  -- Return result
  RETURN QUERY SELECT
    v_pedido_id,
    v_produto_id::text,
    v_qtd_bipada::numeric,
    v_bipado_completo,
    v_pedido_completo;
END;
$$;
