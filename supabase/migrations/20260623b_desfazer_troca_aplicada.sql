-- BUG-A (2026-06-23) — desfazer troca de equivalência APLICADA.
--
-- Beco-sem-saída: quando uma troca já foi APLICADA (item com
-- produto_wms_substituto_id setado) e o pedido é reaberto (voltar-etapa →
-- aguardando_separacao), o operador não conseguia trocar pra um 3º SKU nem
-- voltar ao original: solicitarTroca → TROCA_JA_APLICADA, trocarSubstituto →
-- TROCA_NAO_PENDENTE, rejeitar/cancelar → TROCA_NAO_PENDENTE. reset-state NÃO
-- limpa produto_wms_substituto_id/troca_equivalencia_id (de propósito — o caso
-- normal quer MANTER o substituto pra re-picar a mesma peça).
--
-- Fix: ação EXPLÍCITA "desfazer troca aplicada", só permitida com o item
-- REABERTO e NÃO-PICADO. Libera a R reserva_pedido viva do SUBSTITUTO, limpa os
-- 2 campos do item (volta a resolver pro original) e fecha a troca como
-- 'desfeita'. NÃO recria R no original aqui — o item fica sem R e o operador
-- re-roteia OU solicita nova troca (o guard de solicitarTroca volta a passar).

BEGIN;

-- 1. +status 'desfeita' (desfazer de troca aplicada após reabertura).
-- O índice único parcial siso_trocas_equivalencia_pendente_por_item é WHERE
-- status='pendente' — 'desfeita' não conflita.
ALTER TABLE siso_trocas_equivalencia
  DROP CONSTRAINT IF EXISTS siso_trocas_equivalencia_status_check;
ALTER TABLE siso_trocas_equivalencia
  ADD CONSTRAINT siso_trocas_equivalencia_status_check
  CHECK (status IN (
    'pendente', 'aprovada', 'rejeitada', 'expirada', 'cancelada', 'desfeita'
  ));

-- 2. RPC atômica: desfaz uma troca APLICADA num item reaberto e não-picado.
CREATE OR REPLACE FUNCTION public.wms_desfazer_troca_aplicada_atomico(
  p_pedido_item_id bigint,
  p_usuario_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE
  v_item RECORD;
  v_pedido RECORD;
  v_r RECORD;
  v_liberadas int := 0;
  v_restante numeric;
BEGIN
  -- Trava o item.
  SELECT id, pedido_id, produto_wms_substituto_id, troca_equivalencia_id,
         separacao_marcado, quantidade_pega, quantidade_pedida
    INTO v_item
    FROM siso_pedido_itens
   WHERE id = p_pedido_item_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NAO_ENCONTRADO';
  END IF;
  IF v_item.produto_wms_substituto_id IS NULL THEN
    RAISE EXCEPTION 'TROCA_NAO_APLICADA';
  END IF;
  -- Só desfaz se NADA foi picado (a S do substituto não saiu). Se já picou,
  -- exige reabrir/estornar o pick antes (senão desfazer cego deixaria estoque
  -- inconsistente).
  IF v_item.separacao_marcado IS TRUE OR COALESCE(v_item.quantidade_pega, 0) > 0 THEN
    RAISE EXCEPTION 'ITEM_JA_PICADO';
  END IF;

  SELECT id, status_separacao INTO v_pedido
    FROM siso_pedidos WHERE id = v_item.pedido_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PEDIDO_NAO_ENCONTRADO';
  END IF;
  IF v_pedido.status_separacao NOT IN ('aguardando_separacao', 'em_separacao') THEN
    RAISE EXCEPTION 'PEDIDO_ESTADO_INVALIDO:%', v_pedido.status_separacao;
  END IF;

  -- Libera as R reserva_pedido VIVAS (sem L apontando) do SUBSTITUTO neste
  -- pedido — a R que reset-state recriou no substituto após voltar-etapa.
  -- ANTES de qualquer recriação no original (não há recriação aqui — o item
  -- fica sem R e é re-roteado depois).
  --
  -- ⚠ A R NÃO carrega discriminador de item: é chaveada por (pedido, produto,
  -- loc) e a R ressuscitada pelo reset-state (estornarLiberacaoReserva) perde o
  -- troca_id que o aprovar-troca tinha posto em origem_detalhes. Pra NÃO liberar
  -- a R de um item-irmão do MESMO pedido que use o MESMO produto físico
  -- (segunda troca pro mesmo substituto OU item que vende nativamente esse
  -- produto), limitamos o total liberado à qty DESTE item (não-picado →
  -- quantidade_pedida) e priorizamos R(s) que ainda carreguem o troca_id deste
  -- item (caso fresco, sem reabertura). Item não-picado ⇒ a R dele soma
  -- exatamente quantidade_pedida; o EXIT corta antes de invadir o irmão.
  -- Limitação residual aceita: se DOIS itens do mesmo pedido reservam o MESMO
  -- substituto na MESMA loc, reservarAtomico dedup-a numa R única compartilhada
  -- (dedup por tripla) — desfazer um libera essa R e o outro perde cobertura.
  -- Caso raro (mesmo substituto + mesma loc) e herdado do dedup; o teto de qty
  -- já evita o caso comum (locs distintas → R(s) separadas).
  v_restante := COALESCE(v_item.quantidade_pedida, 0) - COALESCE(v_item.quantidade_pega, 0);
  FOR v_r IN
    SELECT m.*
      FROM siso_movimentacoes m
     WHERE m.tipo = 'R'
       AND m.origem_tipo = 'reserva_pedido'
       AND m.origem_id = v_item.pedido_id
       AND m.produto_id = v_item.produto_wms_substituto_id
       AND NOT EXISTS (
         SELECT 1 FROM siso_movimentacoes l
          WHERE l.tipo = 'L' AND l.estorno_de = m.id
       )
     ORDER BY (m.origem_detalhes->>'troca_id' = v_item.troca_equivalencia_id::text) DESC
                NULLS LAST,
              m.criado_em
  LOOP
    EXIT WHEN v_restante <= 0;
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_r.produto_id,
      p_galpao_id := v_r.galpao_id,
      p_localizacao_id := v_r.localizacao_id,
      p_tipo := 'L'::char(1),
      p_quantidade := v_r.quantidade,
      p_origem_tipo := 'liberacao_reserva'::text,
      p_origem_id := v_item.pedido_id,
      p_origem_detalhes := jsonb_build_object('contexto', 'desfazer_troca_aplicada'),
      p_usuario_id := p_usuario_id,
      p_estorno_de := v_r.id,
      p_pedido_id := v_item.pedido_id,
      p_motivo := 'troca desfeita — libera reserva do substituto'
    );
    v_restante := v_restante - v_r.quantidade;
    v_liberadas := v_liberadas + 1;
  END LOOP;

  -- Limpa o substituto do item (volta a resolver pro produto original — D3:
  -- produto_id/tiny INTOCADO). resolverProdutoEfetivoDoItem passa a devolver o
  -- original em todo pick/reserva subsequente.
  UPDATE siso_pedido_itens
     SET produto_wms_substituto_id = NULL,
         troca_equivalencia_id = NULL
   WHERE id = p_pedido_item_id;

  -- Fecha o registro da troca como 'desfeita' (não reusa wms_encerrar_troca_atomico,
  -- que exige status='pendente').
  IF v_item.troca_equivalencia_id IS NOT NULL THEN
    UPDATE siso_trocas_equivalencia
       SET status = 'desfeita',
           decidido_por = p_usuario_id,
           decidido_em = now()
     WHERE id = v_item.troca_equivalencia_id
       AND status = 'aprovada';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'reservas_liberadas', v_liberadas,
    'troca_id', v_item.troca_equivalencia_id,
    'produto_substituto_id', v_item.produto_wms_substituto_id
  );
END;
$function$;

COMMIT;
