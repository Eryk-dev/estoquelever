-- Fase 5 (P077) — RPC wms_cancelar_venda_atomico: estorna todas as S de uma
-- venda baixa_direta (match por origem_detalhes->>'pedido_id_manual') + marca
-- pedido cancelado na MESMA transação. As N devoluções são bloco indivisível:
-- só marca cancelado se todas estornarem; falha rola back tudo. Idempotente:
-- pula S que já têm E counter (re-cancelamento → movs_estornadas=0).
CREATE OR REPLACE FUNCTION public.wms_cancelar_venda_atomico(
  p_pedido_id text,
  p_usuario_id uuid DEFAULT NULL,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_s RECORD;
  v_estornadas integer := 0;
  v_status text;
BEGIN
  SELECT status INTO v_status FROM siso_pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pedido % não encontrado', p_pedido_id USING ERRCODE = 'P0002'; END IF;
  IF v_status = 'cancelado' THEN
    RETURN jsonb_build_object('movs_estornadas', 0, 'idempotente', true);
  END IF;

  FOR v_s IN
    SELECT id, produto_id, galpao_id, localizacao_id, quantidade
      FROM siso_movimentacoes
     WHERE tipo = 'S' AND origem_tipo = 'venda_manual'
       AND origem_detalhes->>'pedido_id_manual' = p_pedido_id
       AND NOT EXISTS (SELECT 1 FROM siso_movimentacoes e WHERE e.tipo='E' AND e.estorno_de = siso_movimentacoes.id)
     FOR UPDATE
  LOOP
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_s.produto_id, p_galpao_id := v_s.galpao_id, p_localizacao_id := v_s.localizacao_id,
      p_tipo := 'E', p_quantidade := v_s.quantidade, p_origem_tipo := 'estorno', p_origem_id := p_pedido_id,
      -- marker 'cancelamento_rpc' prova que o estorno saiu por ESTA RPC (não pelo
      -- loop JS antigo) — assert distintivo no wrapper (RED da Task 5.4).
      p_origem_detalhes := jsonb_build_object('motivo', COALESCE(p_motivo,'cancelamento'), 'reversal', true, 'cancelamento_rpc', true),
      p_estorno_de := v_s.id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := 'Cancelamento venda manual: ' || COALESCE(p_motivo,'')
    );
    v_estornadas := v_estornadas + 1;
  END LOOP;

  UPDATE siso_pedidos SET status = 'cancelado' WHERE id = p_pedido_id;
  RETURN jsonb_build_object('movs_estornadas', v_estornadas, 'idempotente', false);
END;
$function$;
