-- WMS Mini-Swap — implementação real do RPC executar
-- Recebe plano pré-computado pelo TS, re-valida sob lock pessimista, aplica.
-- Spec: docs/superpowers/specs/2026-05-14-mini-swap-intra-galpao-design.md

BEGIN;

CREATE OR REPLACE FUNCTION wms_executar_mini_swap(
  p_plano       jsonb,
  p_pedido_ids  uuid[],
  p_galpao_id   uuid,
  p_usuario_id  uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_demanda      jsonb;
  v_swap_op      jsonb;
  v_emp_op       jsonb;
  v_reserva_id   uuid;
  v_executado    jsonb := '[]'::jsonb;
  v_demanda_exec jsonb;
  v_movs         jsonb;
  v_reserva_mov  siso_movimentacoes;
  v_mov_ent      siso_movimentacoes;
  v_mov_estorno  siso_movimentacoes;
  v_produto      uuid;
  v_pedido_text  text;
BEGIN
  IF p_plano IS NULL OR jsonb_typeof(p_plano) <> 'object' THEN
    RAISE EXCEPTION 'p_plano deve ser jsonb object';
  END IF;
  IF NOT (p_plano ? 'demandas_planejadas') THEN
    RETURN '[]'::jsonb;
  END IF;
  IF jsonb_array_length(p_plano->'demandas_planejadas') = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  -- Lock pessimista: trava todas as rows de siso_estoque do galpão pros SKUs do plano
  PERFORM 1 FROM siso_estoque
  WHERE galpao_id = p_galpao_id
    AND produto_id IN (
      SELECT DISTINCT (d->>'produto_id')::uuid
      FROM jsonb_array_elements(p_plano->'demandas_planejadas') d
    )
  FOR UPDATE;

  -- Pega 1 pedido_id pra usar como origem_id (texto) das movs
  SELECT id::text INTO v_pedido_text FROM siso_pedidos
  WHERE id = ANY(p_pedido_ids) LIMIT 1;

  -- Itera sobre cada demanda planejada
  FOR v_demanda IN SELECT * FROM jsonb_array_elements(p_plano->'demandas_planejadas')
  LOOP
    v_produto := (v_demanda->>'produto_id')::uuid;
    v_movs := '[]'::jsonb;

    -- 1. Cancela reservas existentes (mov L = liberacao_reserva)
    FOR v_reserva_id IN
      SELECT (jsonb_array_elements_text(v_demanda->'reservas_a_cancelar'))::uuid
    LOOP
      SELECT * INTO v_reserva_mov FROM siso_movimentacoes WHERE id = v_reserva_id;
      IF v_reserva_mov IS NULL THEN CONTINUE; END IF;
      -- Defesa: já estornada?
      PERFORM 1 FROM siso_movimentacoes WHERE estorno_de = v_reserva_id;
      IF FOUND THEN CONTINUE; END IF;

      v_mov_estorno := wms_inserir_movimentacao(
        v_reserva_mov.produto_id, v_reserva_mov.empresa_dona_id,
        v_reserva_mov.galpao_id, v_reserva_mov.localizacao_id,
        'L', v_reserva_mov.quantidade,
        'liberacao_reserva', v_reserva_mov.origem_id,
        jsonb_build_object('motivo', 'mini_swap_relocate'),
        NULL, NULL,
        NULL, NULL,
        p_usuario_id, 'cancelada por mini-swap', v_reserva_id
      );
      v_movs := v_movs || jsonb_build_array(jsonb_build_object('tipo', 'L', 'mov_id', v_mov_estorno.id));
    END LOOP;

    -- 2. Executa swaps (cada op = par S+E entre 2 empresas na mesma loc)
    FOR v_swap_op IN SELECT * FROM jsonb_array_elements(v_demanda->'swaps')
    LOOP
      DECLARE
        v_mov_sai siso_movimentacoes;
        v_mov_ent_inner siso_movimentacoes;
      BEGIN
        v_mov_sai := wms_inserir_movimentacao(
          v_produto,
          (v_swap_op->>'empresa_origem_id')::uuid,
          p_galpao_id,
          (v_swap_op->>'loc_id')::uuid,
          'S', (v_swap_op->>'qty')::numeric,
          'swap', NULL,
          jsonb_build_object('etapa', 'saida', 'mini_swap', true),
          NULL, NULL,
          NULL, NULL,
          p_usuario_id, 'mini-swap', NULL
        );
        v_mov_ent_inner := wms_inserir_movimentacao(
          v_produto,
          (v_swap_op->>'empresa_destino_id')::uuid,
          p_galpao_id,
          (v_swap_op->>'loc_id')::uuid,
          'E', (v_swap_op->>'qty')::numeric,
          'swap', NULL,
          jsonb_build_object('etapa', 'entrada', 'mini_swap', true, 'par_de', v_mov_sai.id),
          NULL, NULL,
          NULL, NULL,
          p_usuario_id, 'mini-swap', NULL
        );
        v_movs := v_movs || jsonb_build_array(jsonb_build_object('tipo', 'swap_pair', 'mov_s', v_mov_sai.id, 'mov_e', v_mov_ent_inner.id));
      END;
    END LOOP;

    -- 3. Recria reservas de empréstimo na nova loc consolidada
    FOR v_emp_op IN SELECT * FROM jsonb_array_elements(v_demanda->'emprestimos')
    LOOP
      v_mov_ent := wms_inserir_movimentacao(
        v_produto,
        (v_emp_op->>'empresa_credora_id')::uuid,
        p_galpao_id,
        (v_emp_op->>'loc_id')::uuid,
        'R', (v_emp_op->>'qty')::numeric,
        'reserva_pedido',
        v_pedido_text,
        jsonb_build_object('mini_swap', true, 'devedora', v_emp_op->>'empresa_devedora_id'),
        (v_emp_op->>'empresa_devedora_id')::uuid,
        (now() + interval '48 hours')::timestamptz,
        NULL, NULL,
        p_usuario_id, 'reserva recriada por mini-swap', NULL
      );
      v_movs := v_movs || jsonb_build_array(jsonb_build_object('tipo', 'R_recriada', 'mov_id', v_mov_ent.id));
    END LOOP;

    v_demanda_exec := jsonb_build_object(
      'produto_id', v_produto,
      'loc_destino_id', v_demanda->'loc_destino_id',
      'qty_swap', v_demanda->'qty_swap',
      'qty_emprestimo', v_demanda->'qty_emprestimo',
      'movs', v_movs
    );
    v_executado := v_executado || jsonb_build_array(v_demanda_exec);
  END LOOP;

  RETURN v_executado;
END;
$$;

COMMIT;
