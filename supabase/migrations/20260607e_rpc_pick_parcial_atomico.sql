-- Fase 5 (P019) — RPC wms_pick_parcial_atomico: S(qty_pega) + ajuste(delta)
-- da loc esgotada na MESMA transação. A liberação das R por pedido do wave
-- continua via wms_pick_item_atomico (já atômico, 1 por pedido); esta RPC
-- garante que a saída do wave + o ajuste loc_zerou comitem juntos ou revertam
-- juntos (queda de rede entre os dois não deixa saída sem ajuste).
CREATE OR REPLACE FUNCTION public.wms_pick_parcial_atomico(
  p_produto_id uuid, p_galpao_id uuid, p_localizacao_id uuid,
  p_qty_pega numeric, p_delta_ajuste numeric, p_pedido_id text,
  p_empresa_vendedora_id uuid, p_usuario_id uuid DEFAULT NULL,
  p_origem_detalhes jsonb DEFAULT NULL, p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE v_s_id uuid; v_aj_id uuid;
BEGIN
  IF p_qty_pega > 0 THEN
    SELECT wms_inserir_movimentacao(
      p_produto_id := p_produto_id, p_galpao_id := p_galpao_id, p_localizacao_id := p_localizacao_id,
      p_tipo := 'S', p_quantidade := p_qty_pega, p_origem_tipo := 'nf_venda', p_origem_id := p_pedido_id,
      p_origem_detalhes := p_origem_detalhes, p_empresa_vendedora_id := p_empresa_vendedora_id,
      p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := COALESCE(p_motivo, 'Picking parcial — saída')
    ) INTO v_s_id;
  END IF;

  IF p_delta_ajuste > 0 THEN
    SELECT wms_inserir_movimentacao(
      p_produto_id := p_produto_id, p_galpao_id := p_galpao_id, p_localizacao_id := p_localizacao_id,
      p_tipo := 'S', p_quantidade := p_delta_ajuste, p_origem_tipo := 'ajuste_pick_zerou',
      p_origem_id := p_pedido_id, p_origem_detalhes := p_origem_detalhes, p_usuario_id := p_usuario_id,
      p_motivo := 'loc zerou no bipe'
    ) INTO v_aj_id;
  END IF;

  RETURN jsonb_build_object('mov_s_id', v_s_id, 'mov_ajuste_id', v_aj_id);
END;
$function$;
