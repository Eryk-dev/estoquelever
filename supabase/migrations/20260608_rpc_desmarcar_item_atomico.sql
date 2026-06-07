-- Fase 5 (P014/P015 — D4) — RPC wms_desmarcar_item_atomico: estorna o par
-- S+L de um pick numa única transação (tudo-ou-nada). Ordem S-antes-de-L
-- (fix p3-2.7): a E do estorno-S recupera o saldo antes de recriar a R.
-- D4 tolerante: se recriar a R cheia violaria reservado<=saldo (terceiros
-- consumiram saldo), recria CLAMPADA ao saldo livre e retorna status_alerta
-- em vez de travar o operador. Idempotente: se a S já tem E counter, no-op.
CREATE OR REPLACE FUNCTION public.wms_desmarcar_item_atomico(
  p_mov_s_id uuid,
  p_mov_l_id uuid,
  p_pedido_id text,
  p_usuario_id uuid DEFAULT NULL,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_s RECORD; v_l RECORD;
  v_ja_estornada boolean;
  v_saldo_livre numeric;
  v_qty_r numeric;
  v_qty_clamp numeric;
  v_status_alerta text := NULL;
  v_e_id uuid; v_r_id uuid;
  v_expira timestamptz := now() + interval '30 days';
BEGIN
  -- Lock + valida S
  SELECT id, produto_id, galpao_id, localizacao_id, quantidade, tipo, estorno_de
    INTO v_s FROM siso_movimentacoes WHERE id = p_mov_s_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mov S % não encontrada', p_mov_s_id USING ERRCODE = 'P0002'; END IF;

  -- Idempotência: S já estornada (existe E com estorno_de=S)?
  SELECT EXISTS(SELECT 1 FROM siso_movimentacoes WHERE tipo='E' AND estorno_de=p_mov_s_id) INTO v_ja_estornada;
  IF v_ja_estornada THEN
    RETURN jsonb_build_object('estornado', false, 'idempotente', true, 'status_alerta', NULL);
  END IF;

  -- 1) Estorno da S → E counter (saldo += qty). Recupera saldo ANTES de recriar R.
  SELECT wms_inserir_movimentacao(
    p_produto_id := v_s.produto_id, p_galpao_id := v_s.galpao_id, p_localizacao_id := v_s.localizacao_id,
    p_tipo := 'E', p_quantidade := v_s.quantidade, p_origem_tipo := 'estorno', p_origem_id := p_pedido_id,
    p_origem_detalhes := jsonb_build_object('motivo', COALESCE(p_motivo,'desmarca'), 'reversal', true),
    p_estorno_de := p_mov_s_id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
    p_motivo := COALESCE(p_motivo, 'Desmarcar — estorno S')
  ) INTO v_e_id;

  -- 2) Recria a R (ressuscita reserva). Clampa ao saldo livre se preciso (D4).
  IF p_mov_l_id IS NOT NULL THEN
    SELECT id, produto_id, galpao_id, localizacao_id, quantidade
      INTO v_l FROM siso_movimentacoes WHERE id = p_mov_l_id AND tipo='L' FOR UPDATE;
    IF FOUND THEN
      v_qty_r := v_l.quantidade;
      SELECT saldo - reservado INTO v_saldo_livre FROM siso_estoque
        WHERE produto_id=v_l.produto_id AND galpao_id=v_l.galpao_id AND localizacao_id=v_l.localizacao_id FOR UPDATE;
      v_qty_clamp := LEAST(v_qty_r, GREATEST(v_saldo_livre, 0));
      IF v_qty_clamp < v_qty_r THEN
        v_status_alerta := 'reserva_clampada_pos_desmarca';
      END IF;
      IF v_qty_clamp > 0 THEN
        SELECT wms_inserir_movimentacao(
          p_produto_id := v_l.produto_id, p_galpao_id := v_l.galpao_id, p_localizacao_id := v_l.localizacao_id,
          p_tipo := 'R', p_quantidade := v_qty_clamp, p_origem_tipo := 'reserva_pedido', p_origem_id := p_pedido_id,
          p_origem_detalhes := jsonb_build_object('contexto','estorno_liberacao','estorno_de_L', p_mov_l_id,
                                                  'qty_original', v_qty_r, 'clampada', (v_qty_clamp < v_qty_r)),
          p_expira_em := v_expira, p_estorno_de := p_mov_l_id, p_usuario_id := p_usuario_id,
          p_pedido_id := p_pedido_id, p_motivo := COALESCE(p_motivo,'Desmarcar — ressuscita reserva')
        ) INTO v_r_id;
      ELSE
        v_status_alerta := 'reserva_nao_recriada_sem_saldo';
      END IF;
    END IF;
  END IF;

  -- 3) Status alerta no pedido (best-effort, schema pode não ter a coluna)
  IF v_status_alerta IS NOT NULL THEN
    BEGIN
      UPDATE siso_pedidos SET status_alerta = v_status_alerta WHERE id = p_pedido_id;
    EXCEPTION WHEN undefined_column THEN NULL; END;
  END IF;

  RETURN jsonb_build_object('estornado', true, 'mov_e_id', v_e_id, 'mov_r_id', v_r_id, 'status_alerta', v_status_alerta);
END;
$function$;
