-- Fase 5 (P075) — RPC wms_vender_baixa_direta_atomico: baixa N movs S de uma
-- venda manual numa ÚNICA transação. Tranca as triplas via pg_advisory_xact_lock
-- (auto-libera no fim da tx) e insere cada S; qualquer falha (saldo insuficiente)
-- faz RAISE → rollback total (nenhuma S persiste). Substitui o loop JS +
-- rollback best-effort de vendas/criar/route.ts:540-634.
CREATE OR REPLACE FUNCTION public.wms_vender_baixa_direta_atomico(
  p_origem_venda_id uuid,
  p_pedido_id_manual text,
  p_empresa_vendedora_id uuid,
  p_cliente_nome text,
  p_movs jsonb,            -- array de {produto_id, galpao_id, localizacao_id, qty, sku, ...}
  p_usuario_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_mov jsonb;
  v_mov_id uuid;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_lock_key bigint;
BEGIN
  FOR v_mov IN SELECT * FROM jsonb_array_elements(p_movs)
  LOOP
    -- Advisory lock por tripla (hashtext determinístico) — serializa baixas
    -- concorrentes na mesma prateleira. Auto-libera no commit/rollback.
    v_lock_key := hashtextextended(
      (v_mov->>'produto_id') || (v_mov->>'galpao_id') || (v_mov->>'localizacao_id'), 0
    );
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT wms_inserir_movimentacao(
      p_produto_id := (v_mov->>'produto_id')::uuid,
      p_galpao_id := (v_mov->>'galpao_id')::uuid,
      p_localizacao_id := (v_mov->>'localizacao_id')::uuid,
      p_tipo := 'S', p_quantidade := (v_mov->>'qty')::numeric,
      p_origem_tipo := 'venda_manual', p_origem_id := p_origem_venda_id::text,
      -- marker 'baixa_direta_rpc' prova que a S saiu por ESTA RPC (não pelo loop
      -- JS antigo) — assert distintivo no cenário 83 (RED do wrapper Task 5.2).
      p_origem_detalhes := v_mov || jsonb_build_object('pedido_id_manual', p_pedido_id_manual, 'baixa_direta_rpc', true),
      p_empresa_vendedora_id := p_empresa_vendedora_id, p_cliente_nome := p_cliente_nome,
      p_pedido_id := p_pedido_id_manual, p_usuario_id := p_usuario_id,
      p_motivo := 'Venda manual ' || p_pedido_id_manual || ' — ' || COALESCE(p_cliente_nome,'')
    ) INTO v_mov_id;
    v_ids := array_append(v_ids, v_mov_id);
  END LOOP;

  RETURN jsonb_build_object('mov_ids', to_jsonb(v_ids));
END;
$function$;
