-- Baixa atômica de pick (Fase 1.1): L (libera R) + S (saída nf_venda) numa
-- única transação plpgsql. Espelha wms_confirmar_guarda_atomico.
--
-- Se a S falhar (saldo insuficiente), a função inteira faz rollback — incluindo
-- a L. Garante o invariante "S sempre criada junto com seu L, ou nada".
--
-- Dois modos:
--   p_reserva_id != NULL  → loc derivada da R viva; L(qty)+S(qty) na tripla da R.
--   p_reserva_id  = NULL  → S-only na tripla passada (item sem reserva, ex.: completar
--                            parcial-em-progresso cuja R já foi liberada, ou OC item).
CREATE OR REPLACE FUNCTION public.wms_pick_item_atomico(
  p_reserva_id uuid,
  p_produto_id uuid,
  p_galpao_id uuid,
  p_localizacao_id uuid,
  p_qty numeric,
  p_pedido_id text,
  p_empresa_vendedora_id uuid,
  p_usuario_id uuid,
  p_nota_fiscal_id uuid DEFAULT NULL,
  p_motivo text DEFAULT NULL,
  p_origem_detalhes jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_r RECORD;
  v_ja_liberada boolean;
  v_l_id uuid;
  v_s_id uuid;
  v_prod uuid;
  v_galp uuid;
  v_loc uuid;
  v_det jsonb;
BEGIN
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'qty deve ser > 0' USING ERRCODE = '22023';
  END IF;

  IF p_reserva_id IS NOT NULL THEN
    -- Lock pessimista na R + valida
    SELECT id, produto_id, galpao_id, localizacao_id, quantidade, tipo, origem_tipo
      INTO v_r
      FROM siso_movimentacoes
     WHERE id = p_reserva_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reserva % não encontrada', p_reserva_id USING ERRCODE = 'P0002';
    END IF;
    IF v_r.tipo <> 'R' OR v_r.origem_tipo <> 'reserva_pedido' THEN
      RAISE EXCEPTION 'mov % não é R reserva_pedido (tipo=%, origem=%)',
        p_reserva_id, v_r.tipo, v_r.origem_tipo USING ERRCODE = '22023';
    END IF;

    -- Idempotência: R já liberada? (existe L apontando pra ela)
    SELECT EXISTS(
      SELECT 1 FROM siso_movimentacoes
       WHERE tipo = 'L' AND estorno_de = p_reserva_id
    ) INTO v_ja_liberada;
    IF v_ja_liberada THEN
      RAISE EXCEPTION 'reserva % já liberada — pick já realizado', p_reserva_id
        USING ERRCODE = '22023';
    END IF;

    v_prod := v_r.produto_id;
    v_galp := v_r.galpao_id;
    v_loc  := v_r.localizacao_id;
    v_det  := COALESCE(p_origem_detalhes, '{}'::jsonb)
              || jsonb_build_object('reserva_origem', p_reserva_id, 'contexto', 'pick_atomico');

    -- L: libera a reserva (estorno_de=R.id marca idempotência)
    SELECT wms_inserir_movimentacao(
      p_produto_id := v_prod, p_galpao_id := v_galp, p_localizacao_id := v_loc,
      p_tipo := 'L', p_quantidade := p_qty,
      p_origem_tipo := 'liberacao_reserva', p_origem_id := p_pedido_id,
      p_origem_detalhes := v_det,
      p_estorno_de := p_reserva_id,
      p_usuario_id := p_usuario_id,
      p_pedido_id := p_pedido_id,
      p_motivo := COALESCE(p_motivo, 'Pick atômico — libera reserva')
    ) INTO v_l_id;
  ELSE
    v_prod := p_produto_id;
    v_galp := p_galpao_id;
    v_loc  := p_localizacao_id;
    v_det  := COALESCE(p_origem_detalhes, '{}'::jsonb)
              || jsonb_build_object('contexto', 'pick_atomico_sem_reserva');
  END IF;

  -- S: saída nf_venda na tripla (da R, ou a passada no fallback)
  SELECT wms_inserir_movimentacao(
    p_produto_id := v_prod, p_galpao_id := v_galp, p_localizacao_id := v_loc,
    p_tipo := 'S', p_quantidade := p_qty,
    p_origem_tipo := 'nf_venda', p_origem_id := p_pedido_id,
    p_origem_detalhes := v_det,
    p_empresa_vendedora_id := p_empresa_vendedora_id,
    p_usuario_id := p_usuario_id,
    p_pedido_id := p_pedido_id,
    p_nota_fiscal_id := p_nota_fiscal_id,
    p_motivo := COALESCE(p_motivo, 'Pick atômico — saída')
  ) INTO v_s_id;

  RETURN jsonb_build_object(
    'mov_l_id', v_l_id,
    'mov_s_id', v_s_id,
    'produto_id', v_prod,
    'galpao_id', v_galp,
    'localizacao_id', v_loc,
    'qty', p_qty
  );
END;
$function$;
