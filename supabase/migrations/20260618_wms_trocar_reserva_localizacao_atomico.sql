-- Trocar a LOCALIZAÇÃO de uma reserva de pedido (atômico) — Parte 4 do plano
-- "revisão do fluxo de escolha de localização na separação".
--
-- Feature: na separação, o operador vê outras localizações com saldo disponível
-- e pode escolher picar de OUTRA loc. Mover a reserva R do pedido precisa ser
-- tudo-ou-nada: liberar (L) a R na loc ANTIGA e criar a R nova na loc DESTINO
-- numa única transação — senão sobra R órfã (saldo travado) ou o pedido fica
-- sem R viva (o pick cairia no fallback e sairia da loc errada).
--
-- NÃO pica — só MOVE a reserva. O pick seguinte (marcar-item → wms_pick_item_
-- atomico) acha a R nova via buscarReservaPendentePorProduto e funciona sem mudança.
--
-- Move SEMPRE a reserva INTEIRA (v_r.quantidade). Move parcial seria inseguro:
-- a idempotência da R antiga é "EXISTS L WHERE estorno_de=R.id" (ignora qty),
-- então um L parcial marcaria a R antiga inteira como consumida e perderia o
-- resíduo. Cascade/realocação multi-loc segue pelo caminho marcar-realocacao.
--
-- Modela-se em wms_trocar_substituto_atomico (20260614): mesmo lock FOR UPDATE +
-- par L/R via wms_inserir_movimentacao (único write do ledger).
--
-- ⚠ p_pedido_id é TEXT (siso_movimentacoes.pedido_id/origem_id são text — torná-los
-- uuid quebrou callers de wms_reservar_atomico numa migration anterior). Os movs
-- usam v_r.origem_id (text).
--
-- Ordenação L-antes-R é só clareza: as duas movs tocam ROWS DIFERENTES de
-- siso_estoque (locs distintas), então a R no destino NÃO depende do L na origem
-- — o disponivel do destino é independente. O guarda de oversell é a R-check
-- interna do wms_inserir_movimentacao (reservado > saldo → "reserva excede
-- saldo"), que faz rollback de TUDO (inclusive o L), preservando a R original.

BEGIN;

CREATE OR REPLACE FUNCTION public.wms_trocar_reserva_localizacao_atomico(
  p_reserva_id uuid,
  p_destino_localizacao_id uuid,
  p_pedido_id text,
  p_usuario_id uuid,
  p_motivo text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE
  v_r RECORD;
  v_l_id uuid;
  v_nova_r uuid;
BEGIN
  IF p_destino_localizacao_id IS NULL THEN
    RAISE EXCEPTION 'DESTINO_INVALIDO' USING ERRCODE = '22023';
  END IF;

  -- Lock pessimista na R atual.
  SELECT id, produto_id, galpao_id, localizacao_id, quantidade, tipo, origem_tipo, origem_id
    INTO v_r
    FROM siso_movimentacoes
   WHERE id = p_reserva_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESERVA_NAO_ENCONTRADA' USING ERRCODE = 'P0002';
  END IF;
  IF v_r.tipo <> 'R' OR v_r.origem_tipo <> 'reserva_pedido' THEN
    RAISE EXCEPTION 'RESERVA_INVALIDA';
  END IF;
  IF v_r.origem_id IS DISTINCT FROM p_pedido_id THEN
    RAISE EXCEPTION 'RESERVA_PEDIDO_MISMATCH';
  END IF;

  -- Idempotência / já-consumida: se já existe L apontando pra esta R, ela já
  -- foi picada ou movida — first-writer-wins.
  IF EXISTS (
    SELECT 1 FROM siso_movimentacoes
     WHERE tipo = 'L' AND estorno_de = p_reserva_id
  ) THEN
    RAISE EXCEPTION 'RESERVA_JA_CONSUMIDA';
  END IF;

  -- No-op: já está na loc destino.
  IF v_r.localizacao_id = p_destino_localizacao_id THEN
    RETURN jsonb_build_object(
      'ok', true,
      'sem_mudanca', true,
      'reserva_antiga_id', p_reserva_id,
      'reserva_nova_id', p_reserva_id,
      'destino_localizacao_id', p_destino_localizacao_id,
      'qty', v_r.quantidade
    );
  END IF;

  -- 1. L na loc ANTIGA (libera a R atual por inteiro).
  SELECT wms_inserir_movimentacao(
    p_produto_id := v_r.produto_id,
    p_galpao_id := v_r.galpao_id,
    p_localizacao_id := v_r.localizacao_id,
    p_tipo := 'L'::char(1),
    p_quantidade := v_r.quantidade,
    p_origem_tipo := 'liberacao_reserva'::text,
    p_origem_id := v_r.origem_id,
    p_origem_detalhes := jsonb_build_object('contexto', 'troca_localizacao_picking'),
    p_usuario_id := p_usuario_id,
    p_expira_em := NULL::timestamptz,
    p_estorno_de := p_reserva_id,
    p_empresa_compradora_id := NULL::uuid,
    p_empresa_vendedora_id := NULL::uuid,
    p_empresa_referencia_id := NULL::uuid,
    p_fornecedor_id := NULL::uuid,
    p_motivo := COALESCE(p_motivo, 'troca de localização — libera R antiga'),
    p_cliente_nome := NULL::text,
    p_pedido_id := v_r.origem_id,
    p_nota_fiscal_id := NULL::uuid,
    p_chave_acesso_nf := NULL::text,
    p_custo_unitario := NULL::numeric
  ) INTO v_l_id;

  -- 2. R na loc DESTINO (mesma qty). A R-check interna do wms_inserir_movimentacao
  --    é o guarda de oversell: se o destino não tem saldo livre, "reserva excede
  --    saldo" → rollback de tudo (o L acima volta atrás), R original intacta.
  SELECT wms_inserir_movimentacao(
    p_produto_id := v_r.produto_id,
    p_galpao_id := v_r.galpao_id,
    p_localizacao_id := p_destino_localizacao_id,
    p_tipo := 'R'::char(1),
    p_quantidade := v_r.quantidade,
    p_origem_tipo := 'reserva_pedido'::text,
    p_origem_id := v_r.origem_id,
    p_origem_detalhes := jsonb_build_object(
      'contexto', 'troca_localizacao_picking',
      'reserva_origem', p_reserva_id
    ),
    p_usuario_id := p_usuario_id,
    p_expira_em := now() + interval '30 days',
    p_estorno_de := NULL::uuid,
    p_empresa_compradora_id := NULL::uuid,
    p_empresa_vendedora_id := NULL::uuid,
    p_empresa_referencia_id := NULL::uuid,
    p_fornecedor_id := NULL::uuid,
    p_motivo := COALESCE(p_motivo, 'troca de localização — nova reserva'),
    p_cliente_nome := NULL::text,
    p_pedido_id := v_r.origem_id,
    p_nota_fiscal_id := NULL::uuid,
    p_chave_acesso_nf := NULL::text,
    p_custo_unitario := NULL::numeric
  ) INTO v_nova_r;

  RETURN jsonb_build_object(
    'ok', true,
    'reserva_antiga_id', p_reserva_id,
    'reserva_nova_id', v_nova_r,
    'mov_l_id', v_l_id,
    'destino_localizacao_id', p_destino_localizacao_id,
    'qty', v_r.quantidade
  );
END;
$function$;

COMMIT;
