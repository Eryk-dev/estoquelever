-- Fase 5 (P084) — RPC wms_resolver_pedido_fantasma: resolve as R vivas de um
-- pedido forward sem saída (padrão C do safety-net). Numa transação, para cada
-- R viva (sem L estornando):
--   acao='saiu'      → L (estorno_de=R) + S (nf_venda): converte R→saída final.
--   acao='cancelado' → L (estorno_de=R): devolve à prateleira (reservado zera,
--                      saldo intacto). Idempotente (pula R já liberada).
CREATE OR REPLACE FUNCTION public.wms_resolver_pedido_fantasma(
  p_pedido_id text,
  p_acao text,                 -- 'saiu' | 'cancelado'
  p_empresa_vendedora_id uuid DEFAULT NULL,
  p_usuario_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_r RECORD;
  v_resolvidas integer := 0;
BEGIN
  IF p_acao NOT IN ('saiu','cancelado') THEN
    RAISE EXCEPTION 'acao inválida: % (use saiu|cancelado)', p_acao USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM siso_pedidos WHERE id = p_pedido_id FOR UPDATE;

  FOR v_r IN
    SELECT id, produto_id, galpao_id, localizacao_id, quantidade
      FROM siso_movimentacoes
     WHERE tipo='R' AND origem_tipo='reserva_pedido' AND origem_id = p_pedido_id
       AND NOT EXISTS (SELECT 1 FROM siso_movimentacoes l WHERE l.tipo='L' AND l.estorno_de = siso_movimentacoes.id)
     FOR UPDATE
  LOOP
    -- L: libera a reserva (estorno_de=R marca idempotência/conversão).
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_r.produto_id, p_galpao_id := v_r.galpao_id, p_localizacao_id := v_r.localizacao_id,
      p_tipo := 'L', p_quantidade := v_r.quantidade, p_origem_tipo := 'liberacao_reserva', p_origem_id := p_pedido_id,
      p_origem_detalhes := jsonb_build_object('contexto','resolver_fantasma','acao', p_acao),
      p_estorno_de := v_r.id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := 'Resolver fantasma (' || p_acao || ') — libera reserva'
    );

    IF p_acao = 'saiu' THEN
      PERFORM wms_inserir_movimentacao(
        p_produto_id := v_r.produto_id, p_galpao_id := v_r.galpao_id, p_localizacao_id := v_r.localizacao_id,
        p_tipo := 'S', p_quantidade := v_r.quantidade, p_origem_tipo := 'nf_venda', p_origem_id := p_pedido_id,
        p_origem_detalhes := jsonb_build_object('reserva_origem', v_r.id, 'contexto','resolver_fantasma'),
        p_empresa_vendedora_id := p_empresa_vendedora_id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
        p_motivo := 'Resolver fantasma — confirma saída'
      );
    END IF;
    v_resolvidas := v_resolvidas + 1;
  END LOOP;

  -- 'cancelado' marca o pedido cancelado (saída não houve). 'saiu' deixa o forward.
  IF p_acao = 'cancelado' THEN
    UPDATE siso_pedidos SET status = 'cancelado' WHERE id = p_pedido_id;
  END IF;

  RETURN jsonb_build_object('reservas_resolvidas', v_resolvidas, 'acao', p_acao);
END;
$function$;
