-- Troca de Equivalência — trocar o SUBSTITUTO de uma troca PENDENTE (atômico)
--
-- Feature: no modal de aprovação (/wms/trocas), o operador pode trocar o
-- substituto sugerido por outro equivalente com saldo. A mutação de reservas
-- precisa ser tudo-ou-nada: liberar as R reserva_troca do substituto ANTIGO e
-- criar as R reserva_troca do NOVO numa única transação — senão sobra R órfã
-- (saldo travado 48h → OC espúria).
--
-- Locs do novo substituto são resolvidas no app (resolverRealocacao) e chegam
-- em p_reservas = [{"localizacao_id": uuid, "qty": numeric}]. Modela-se em
-- wms_aprovar_troca_atomico (20260612f): mesmo lock FOR UPDATE + mesmo par L/R
-- via wms_inserir_movimentacao (único write do ledger).

BEGIN;

CREATE OR REPLACE FUNCTION public.wms_trocar_substituto_atomico(
  p_troca_id uuid,
  p_usuario_id uuid,
  p_novo_produto_id uuid,
  p_novo_sku text,
  p_novo_tipo text,
  p_novo_tier text,
  p_reservas jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE
  v_troca RECORD;
  v_r RECORD;
  v_res jsonb;
  v_nova_r uuid;
  v_novas uuid[] := '{}';
  v_liberadas int := 0;
BEGIN
  SELECT * INTO v_troca
    FROM siso_trocas_equivalencia
   WHERE id = p_troca_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TROCA_NAO_ENCONTRADA';
  END IF;
  IF v_troca.status <> 'pendente' THEN
    RAISE EXCEPTION 'TROCA_NAO_PENDENTE:%', v_troca.status;
  END IF;
  IF p_novo_produto_id = v_troca.produto_vendido_id THEN
    RAISE EXCEPTION 'SUBSTITUTO_IGUAL_VENDIDO';
  END IF;

  -- 1. Libera as R de troca VIVAS (sem L apontando) do substituto ANTIGO.
  FOR v_r IN
    SELECT m.*
      FROM siso_movimentacoes m
     WHERE m.id = ANY (COALESCE(v_troca.reserva_mov_ids, '{}'::uuid[]))
       AND m.tipo = 'R'
       AND NOT EXISTS (
         SELECT 1 FROM siso_movimentacoes l
          WHERE l.tipo = 'L' AND l.estorno_de = m.id
       )
  LOOP
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_r.produto_id,
      p_galpao_id := v_r.galpao_id,
      p_localizacao_id := v_r.localizacao_id,
      p_tipo := 'L'::char(1),
      p_quantidade := v_r.quantidade,
      p_origem_tipo := 'liberacao_troca'::text,
      p_origem_id := p_troca_id::text,
      p_origem_detalhes := jsonb_build_object('contexto', 'troca_substituto'),
      p_usuario_id := p_usuario_id,
      p_expira_em := NULL::timestamptz,
      p_estorno_de := v_r.id,
      p_empresa_compradora_id := NULL::uuid,
      p_empresa_vendedora_id := NULL::uuid,
      p_empresa_referencia_id := NULL::uuid,
      p_fornecedor_id := NULL::uuid,
      p_motivo := 'troca substituto — libera reserva antiga',
      p_cliente_nome := NULL::text,
      p_pedido_id := v_troca.pedido_id,
      p_nota_fiscal_id := NULL::uuid,
      p_chave_acesso_nf := NULL::text,
      p_custo_unitario := NULL::numeric
    );
    v_liberadas := v_liberadas + 1;
  END LOOP;

  -- 2. Cria as R de troca NOVAS no substituto NOVO (locs resolvidas no app),
  --    no mesmo galpão da troca, TTL 48h.
  FOR v_res IN SELECT * FROM jsonb_array_elements(p_reservas)
  LOOP
    SELECT wms_inserir_movimentacao(
      p_produto_id := p_novo_produto_id,
      p_galpao_id := v_troca.galpao_id,
      p_localizacao_id := (v_res->>'localizacao_id')::uuid,
      p_tipo := 'R'::char(1),
      p_quantidade := (v_res->>'qty')::numeric,
      p_origem_tipo := 'reserva_troca'::text,
      p_origem_id := p_troca_id::text,
      p_origem_detalhes := jsonb_build_object(
        'contexto', 'troca_substituto',
        'pedido_id', v_troca.pedido_id,
        'pedido_item_id', v_troca.pedido_item_id
      ),
      p_usuario_id := p_usuario_id,
      p_expira_em := now() + interval '48 hours',
      p_estorno_de := NULL::uuid,
      p_empresa_compradora_id := NULL::uuid,
      p_empresa_vendedora_id := NULL::uuid,
      p_empresa_referencia_id := NULL::uuid,
      p_fornecedor_id := NULL::uuid,
      p_motivo := 'troca substituto — nova reserva',
      p_cliente_nome := NULL::text,
      p_pedido_id := v_troca.pedido_id,
      p_nota_fiscal_id := NULL::uuid,
      p_chave_acesso_nf := NULL::text,
      p_custo_unitario := NULL::numeric
    ) INTO v_nova_r;
    v_novas := array_append(v_novas, v_nova_r);
  END LOOP;

  -- 3. Atualiza a troca (segue pendente — operador aprova depois).
  UPDATE siso_trocas_equivalencia
     SET produto_substituto_id = p_novo_produto_id,
         sku_substituto = p_novo_sku,
         tipo = p_novo_tipo,
         tier_substituto_snapshot = p_novo_tier,
         reserva_mov_ids = v_novas
   WHERE id = p_troca_id;

  RETURN jsonb_build_object(
    'ok', true,
    'liberadas', v_liberadas,
    'novas_reservas', to_jsonb(v_novas)
  );
END;
$function$;

COMMIT;
