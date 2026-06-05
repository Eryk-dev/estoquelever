-- P021 — Decremento atômico de quantidade_bipada no desfazer-bip.
--
-- Substitui o read-modify-write em desfazer-bip/route.ts (dois cliques rápidos
-- lêem N e ambos gravam N-1 → fica N-1 em vez de N-2). Espelha o padrão de
-- wms_acumular_qty_pega (UPDATE += delta atômico).
--
-- desfazer-bip identifica o item por (pedido_id text, produto_id = tiny_produto_id).
-- GREATEST(... - 1, 0) garante clamp em 0 e a soma é atômica sob a linha.

CREATE OR REPLACE FUNCTION wms_desfazer_bip_atomico(
  p_pedido_id text,
  p_produto_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_qtd_pedida  integer;
  v_nova_bipada integer;
BEGIN
  SELECT quantidade_pedida INTO v_qtd_pedida
    FROM siso_pedido_itens
    WHERE pedido_id = p_pedido_id AND produto_id = p_produto_id
    FOR UPDATE;
  IF v_qtd_pedida IS NULL THEN
    RAISE EXCEPTION 'item (pedido=%, produto=%) nao encontrado', p_pedido_id, p_produto_id;
  END IF;

  UPDATE siso_pedido_itens
    SET quantidade_bipada = GREATEST(COALESCE(quantidade_bipada, 0) - 1, 0),
        bipado_completo   = GREATEST(COALESCE(quantidade_bipada, 0) - 1, 0) >= v_qtd_pedida
    WHERE pedido_id = p_pedido_id AND produto_id = p_produto_id
    RETURNING quantidade_bipada INTO v_nova_bipada;

  RETURN jsonb_build_object(
    'quantidade_bipada', v_nova_bipada,
    'bipado_completo', v_nova_bipada >= v_qtd_pedida
  );
END;
$$;
