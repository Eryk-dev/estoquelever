-- [P0-01 — plano 2026-06-11] Desmarcar item de wave consolidada estornava a
-- mov S INTEIRA, não a fração do item.
--
-- O parcial (modo item) cria 1 mov S única pro wave com rateio por item em
-- siso_pedido_item_mov_links.qty. wms_desmarcar_item_atomico estornava
-- v_s.quantidade (total da mov): wave A(2)+B(3) → S de 5; desmarcar A gerava
-- E de 5 (deveria 2) → estoque fantasma +3.
--
-- Fix: novo param p_qty_link (default NULL = comportamento atual, compat):
--   · NULL  → estorno FULL da S (E counter), idempotência via
--             EXISTS(E estorno_de=S) — idêntico a 20260608.
--   · valor → estorno PARCIAL da fração (padrão wms_estornar_parcial_movimentacao:
--             valida acumulado + atualiza qty_estornada, marker 'parcial' no
--             origem_detalhes pra escapar do índice uq_mov_estorno_unico).
--             Idempotência POR ITEM via origem_detalhes->>'pedido_item_id' do E
--             (exige p_pedido_item_id); retry do mesmo item → no-op.
--             R recriada clampada ao saldo livre SÓ da fração
--             (LEAST(L.quantidade, p_qty_link)) — mesma semântica D4/status_alerta.
--
-- Guarda anti-over-reversal no ramo parcial: valida contra GREATEST(qty_estornada,
-- SUM(E counters)) — cobre S que já recebeu um full estorno legado (que não
-- atualizava qty_estornada).
--
-- DROP da assinatura antiga (5 args): manter as duas viraria overload ambíguo
-- pro PostgREST (mesma convenção de 20260607c).

BEGIN;

DROP FUNCTION IF EXISTS public.wms_desmarcar_item_atomico(uuid, uuid, text, uuid, text);

CREATE FUNCTION public.wms_desmarcar_item_atomico(
  p_mov_s_id uuid,
  p_mov_l_id uuid,
  p_pedido_id text,
  p_usuario_id uuid DEFAULT NULL,
  p_motivo text DEFAULT NULL,
  p_qty_link numeric DEFAULT NULL,
  p_pedido_item_id bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_s RECORD; v_l RECORD;
  v_ja_estornada boolean;
  v_total_estornado numeric;
  v_saldo_livre numeric;
  v_qty_r numeric;
  v_qty_clamp numeric;
  v_status_alerta text := NULL;
  v_e_id uuid; v_r_id uuid;
  v_expira timestamptz := now() + interval '30 days';
BEGIN
  -- Lock + valida S
  SELECT id, produto_id, galpao_id, localizacao_id, quantidade, qty_estornada, tipo, estorno_de
    INTO v_s FROM siso_movimentacoes WHERE id = p_mov_s_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mov S % não encontrada', p_mov_s_id USING ERRCODE = 'P0002'; END IF;

  IF p_qty_link IS NOT NULL THEN
    -- ── Ramo PARCIAL (P0-01): estorna SÓ a fração deste item ──
    IF p_pedido_item_id IS NULL THEN
      RAISE EXCEPTION 'p_pedido_item_id obrigatório quando p_qty_link informado';
    END IF;
    IF p_qty_link <= 0 THEN
      RAISE EXCEPTION 'p_qty_link deve ser positiva: %', p_qty_link;
    END IF;
    IF v_s.estorno_de IS NOT NULL THEN
      RAISE EXCEPTION 'mov % é ela mesma um estorno', p_mov_s_id;
    END IF;

    -- Idempotência POR ITEM: a fração DESTE item já foi estornada desta S?
    SELECT EXISTS(
      SELECT 1 FROM siso_movimentacoes
       WHERE tipo='E' AND estorno_de = p_mov_s_id
         AND origem_detalhes->>'pedido_item_id' = p_pedido_item_id::text
    ) INTO v_ja_estornada;
    IF v_ja_estornada THEN
      RETURN jsonb_build_object('estornado', false, 'idempotente', true, 'status_alerta', NULL);
    END IF;

    -- Anti-over-reversal: SUM real dos E counters cobre full estorno legado
    -- (não atualizava qty_estornada); qty_estornada cobre o caminho parcial.
    SELECT COALESCE(SUM(quantidade), 0) INTO v_total_estornado
      FROM siso_movimentacoes WHERE tipo='E' AND estorno_de = p_mov_s_id;
    v_total_estornado := GREATEST(v_total_estornado, COALESCE(v_s.qty_estornada, 0));
    IF v_total_estornado + p_qty_link > v_s.quantidade THEN
      RAISE EXCEPTION 'estorno parcial excede a mov: ja_estornado=% + qty=% > total=%',
        v_total_estornado, p_qty_link, v_s.quantidade;
    END IF;

    -- 1) E parcial da fração (recupera saldo ANTES de recriar R). Marker
    --    'parcial'=true é exigido pelo índice uq_mov_estorno_unico (que só
    --    permite UM estorno full por mov) e 'pedido_item_id' é a chave de
    --    idempotência por item.
    SELECT wms_inserir_movimentacao(
      p_produto_id := v_s.produto_id, p_galpao_id := v_s.galpao_id, p_localizacao_id := v_s.localizacao_id,
      p_tipo := 'E', p_quantidade := p_qty_link, p_origem_tipo := 'estorno', p_origem_id := p_pedido_id,
      p_origem_detalhes := jsonb_build_object('motivo', COALESCE(p_motivo,'desmarca'), 'reversal', true,
                                              'parcial', true, 'pedido_item_id', p_pedido_item_id),
      p_estorno_de := p_mov_s_id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := COALESCE(p_motivo, 'Desmarcar — estorno parcial da S consolidada')
    ) INTO v_e_id;

    -- Acumulador compartilhado com wms_estornar_parcial_movimentacao —
    -- desfazer-parcial de um wave-mate na mesma S continua validando certo.
    UPDATE siso_movimentacoes SET qty_estornada = COALESCE(qty_estornada, 0) + p_qty_link
     WHERE id = p_mov_s_id;
  ELSE
    -- ── Ramo FULL (comportamento original de 20260608, compat) ──
    -- Idempotência: S já estornada (existe E com estorno_de=S)? Nota: um E
    -- PARCIAL de wave-mate também satisfaz — o full vira no-op (direção segura,
    -- nunca over-reversa).
    SELECT EXISTS(SELECT 1 FROM siso_movimentacoes WHERE tipo='E' AND estorno_de=p_mov_s_id) INTO v_ja_estornada;
    IF v_ja_estornada THEN
      RETURN jsonb_build_object('estornado', false, 'idempotente', true, 'status_alerta', NULL);
    END IF;

    -- Estorno da S → E counter (saldo += qty). Recupera saldo ANTES de recriar R.
    SELECT wms_inserir_movimentacao(
      p_produto_id := v_s.produto_id, p_galpao_id := v_s.galpao_id, p_localizacao_id := v_s.localizacao_id,
      p_tipo := 'E', p_quantidade := v_s.quantidade, p_origem_tipo := 'estorno', p_origem_id := p_pedido_id,
      p_origem_detalhes := jsonb_build_object('motivo', COALESCE(p_motivo,'desmarca'), 'reversal', true),
      p_estorno_de := p_mov_s_id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := COALESCE(p_motivo, 'Desmarcar — estorno S')
    ) INTO v_e_id;
  END IF;

  -- 2) Recria a R (ressuscita reserva). Clampa ao saldo livre se preciso (D4).
  --    Ramo parcial: a R alvo é SÓ a fração (limitada pela L par).
  IF p_mov_l_id IS NOT NULL THEN
    SELECT id, produto_id, galpao_id, localizacao_id, quantidade
      INTO v_l FROM siso_movimentacoes WHERE id = p_mov_l_id AND tipo='L' FOR UPDATE;
    IF FOUND THEN
      v_qty_r := CASE WHEN p_qty_link IS NOT NULL THEN LEAST(v_l.quantidade, p_qty_link)
                      ELSE v_l.quantidade END;
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

COMMIT;
