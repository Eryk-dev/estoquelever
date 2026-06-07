-- Fase 5 (P023) — RPC wms_reverter_cutover_atomico: numa transação, para cada
-- S do pedido (nf_venda, sem E counter), insere E (estorno_de=S) + recria R, e
-- flipa estoque_lancado/nf_estoque_lancado=false. RAISE em qualquer falha rola
-- back tudo (nenhuma S estornada, flag permanece true coerente). Idempotente:
-- pula S que já têm E counter. Espelha o loop TS de cutover.ts:290-346.
CREATE OR REPLACE FUNCTION public.wms_reverter_cutover_atomico(
  p_pedido_id text,
  p_motivo text,
  p_usuario_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_s RECORD;
  v_e_id uuid;
  v_estornadas integer := 0;
  v_recriadas integer := 0;
  v_expira timestamptz := now() + interval '30 days';
BEGIN
  -- Trava o pedido (serializa reversões concorrentes do mesmo pedido).
  PERFORM 1 FROM siso_pedidos WHERE id = p_pedido_id FOR UPDATE;

  FOR v_s IN
    -- Caminho 1: S com origem_id=pedido. Caminho 2: S via mov_saida_id dos itens.
    SELECT DISTINCT m.id, m.produto_id, m.galpao_id, m.localizacao_id, m.quantidade
      FROM siso_movimentacoes m
     WHERE m.tipo = 'S'
       AND (
         (m.origem_id = p_pedido_id AND m.origem_tipo = 'nf_venda')
         OR m.id IN (SELECT mov_saida_id FROM siso_pedido_itens WHERE pedido_id = p_pedido_id AND mov_saida_id IS NOT NULL)
       )
       AND NOT EXISTS (SELECT 1 FROM siso_movimentacoes e WHERE e.tipo='E' AND e.estorno_de = m.id)
  LOOP
    -- Trava a linha da S (FOR UPDATE não é permitido junto com DISTINCT na cursor).
    PERFORM 1 FROM siso_movimentacoes WHERE id = v_s.id FOR UPDATE;

    SELECT wms_inserir_movimentacao(
      p_produto_id := v_s.produto_id, p_galpao_id := v_s.galpao_id, p_localizacao_id := v_s.localizacao_id,
      p_tipo := 'E', p_quantidade := v_s.quantidade, p_origem_tipo := 'estorno', p_origem_id := p_pedido_id,
      -- marker 'reversal_cutover_rpc' prova que o estorno saiu por ESTA RPC (não
      -- pelo loop TS antigo) — assert distintivo no wrapper (RED da Task 4.2).
      p_origem_detalhes := jsonb_build_object('motivo', p_motivo, 'reversal', true, 'reversal_cutover_rpc', true),
      p_estorno_de := v_s.id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := 'Reversal por ' || p_motivo
    ) INTO v_e_id;
    v_estornadas := v_estornadas + 1;

    -- Recria R (reserva volta). Na mesma tx — se exceder saldo, RAISE → rollback total.
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_s.produto_id, p_galpao_id := v_s.galpao_id, p_localizacao_id := v_s.localizacao_id,
      p_tipo := 'R', p_quantidade := v_s.quantidade, p_origem_tipo := 'reserva_pedido', p_origem_id := p_pedido_id,
      p_origem_detalhes := jsonb_build_object('contexto','reversal_cutover'),
      p_expira_em := v_expira, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := 'Recria reserva no reversal'
    );
    v_recriadas := v_recriadas + 1;
  END LOOP;

  UPDATE siso_pedidos SET estoque_lancado = false, nf_estoque_lancado = false WHERE id = p_pedido_id;

  RETURN jsonb_build_object('reverted', true, 'saidas_estornadas', v_estornadas, 'reservas_recriadas', v_recriadas);
END;
$function$;
