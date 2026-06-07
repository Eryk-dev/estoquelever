-- Fase 5 (P152/P150/P151/P147/P148) — RPC wms_reconciliar_retroativo unifica:
--   P152: FOR UPDATE da mov retroativo serializa 2 operadores concorrentes.
--   P150/P148/P151: checa estorno pré-existente (estorno_de=retro) → no-op
--          idempotente (duplo-clique e reclique tardio respondem sucesso).
--   P147: estorno PARCIAL clampado ao disponível atual; aceita p_qty_estorno;
--          default = min(qty_original, disponível). Grava qty_original vs
--          qty_estornada em origem_detalhes.
CREATE OR REPLACE FUNCTION public.wms_reconciliar_retroativo(
  p_retroativo_mov_id uuid,
  p_compra_mov_id uuid,
  p_usuario_id uuid DEFAULT NULL,
  p_qty_estorno numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_retro RECORD;
  v_ja_estornado boolean;
  v_disponivel numeric;
  v_qty numeric;
BEGIN
  -- P152: trava a mov retroativo (serializa concorrência).
  SELECT id, produto_id, galpao_id, localizacao_id, quantidade, origem_tipo
    INTO v_retro FROM siso_movimentacoes WHERE id = p_retroativo_mov_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lançamento retroativo % não encontrado', p_retroativo_mov_id USING ERRCODE='P0002'; END IF;
  IF v_retro.origem_tipo <> 'lancamento_retroativo' THEN
    RAISE EXCEPTION 'mov % não é um lançamento retroativo', p_retroativo_mov_id USING ERRCODE='22023';
  END IF;

  -- P150/P148/P151: já reconciliado? (existe estorno ligado a este lançamento)
  SELECT EXISTS(
    SELECT 1 FROM siso_movimentacoes WHERE estorno_de = p_retroativo_mov_id AND tipo = 'S'
  ) INTO v_ja_estornado;
  IF v_ja_estornado THEN
    RETURN jsonb_build_object('idempotente', true, 'qty_estornada', 0, 'mensagem', 'lançamento já reconciliado');
  END IF;

  -- P147: estorno parcial clampado ao disponível atual.
  SELECT COALESCE(saldo - reservado, 0) INTO v_disponivel FROM siso_estoque
    WHERE produto_id = v_retro.produto_id AND galpao_id = v_retro.galpao_id AND localizacao_id = v_retro.localizacao_id;
  v_qty := LEAST(COALESCE(p_qty_estorno, v_retro.quantidade), v_retro.quantidade, GREATEST(v_disponivel, 0));
  IF v_qty <= 0 THEN
    RAISE EXCEPTION 'sem saldo disponível para estornar (disponível=%)', v_disponivel USING ERRCODE='22023';
  END IF;

  PERFORM wms_inserir_movimentacao(
    p_produto_id := v_retro.produto_id, p_galpao_id := v_retro.galpao_id, p_localizacao_id := v_retro.localizacao_id,
    p_tipo := 'S', p_quantidade := v_qty, p_origem_tipo := 'estorno', p_estorno_de := p_retroativo_mov_id,
    p_usuario_id := p_usuario_id, p_motivo := 'reconciliado com mov ' || p_compra_mov_id::text,
    p_origem_detalhes := jsonb_build_object('compra_mov_id', p_compra_mov_id,
      'qty_original', v_retro.quantidade, 'qty_estornada', v_qty, 'parcial', (v_qty < v_retro.quantidade))
  );

  RETURN jsonb_build_object('idempotente', false, 'qty_estornada', v_qty,
    'qty_original', v_retro.quantidade, 'parcial', (v_qty < v_retro.quantidade));
END;
$function$;
