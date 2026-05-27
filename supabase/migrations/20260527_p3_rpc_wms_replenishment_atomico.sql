-- P3 fix #8.8: replenishment intra-galpão transacional.
--
-- Hoje `replenishmentIntraGalpao` chama `wms_inserir_movimentacao` 2x em loop
-- TypeScript. Se a 1ª (S) passa e a 2ª (E) falha (ex: loc destino desativada
-- entre chamadas), saldo "evapora" — sai da origem e nunca entra no destino.
-- Wrap em RPC plpgsql traz tudo pra mesma transação.
--
-- Cada chamada gera 1 par S+E por item, compartilhando origem_id. Em caso de
-- falha em qualquer leg, RAISE EXCEPTION propaga rollback automático da
-- transação no PostgreSQL.
--
-- NOTA: a assinatura atual de wms_inserir_movimentacao usa p_origem_id text,
-- p_pedido_id text (cast pra texto pra acomodar IDs híbridos). Mantemos uuid
-- na assinatura externa e convertemos internamente.

CREATE OR REPLACE FUNCTION wms_replenishment_intra_galpao(
  p_galpao_id uuid,
  p_localizacao_origem_id uuid,
  p_localizacao_destino_id uuid,
  p_itens jsonb,             -- [{ produto_id: uuid, qty: numeric }]
  p_usuario_id uuid,
  p_observacoes text DEFAULT NULL,
  p_origem_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_origem_id uuid;
  v_origem_id_txt text;
  v_item jsonb;
  v_mov_s_id uuid;
  v_mov_e_id uuid;
  v_mov_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_localizacao_origem_id = p_localizacao_destino_id THEN
    RAISE EXCEPTION 'origem e destino não podem ser a mesma localização'
      USING ERRCODE = '22023';
  END IF;
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'itens vazios'
      USING ERRCODE = '22023';
  END IF;

  v_origem_id := COALESCE(p_origem_id, gen_random_uuid());
  v_origem_id_txt := v_origem_id::text;

  FOR v_item IN SELECT jsonb_array_elements(p_itens) LOOP
    -- Leg 1: SAÍDA da origem
    SELECT wms_inserir_movimentacao(
      p_produto_id := (v_item->>'produto_id')::uuid,
      p_galpao_id := p_galpao_id,
      p_localizacao_id := p_localizacao_origem_id,
      p_tipo := 'S'::char(1),
      p_quantidade := (v_item->>'qty')::numeric,
      p_origem_tipo := 'transferencia_localizacao'::text,
      p_origem_id := v_origem_id_txt,
      p_origem_detalhes := NULL::jsonb,
      p_usuario_id := p_usuario_id,
      p_expira_em := NULL::timestamptz,
      p_estorno_de := NULL::uuid,
      p_empresa_compradora_id := NULL::uuid,
      p_empresa_vendedora_id := NULL::uuid,
      p_empresa_referencia_id := NULL::uuid,
      p_fornecedor_id := NULL::uuid,
      p_motivo := p_observacoes,
      p_cliente_nome := NULL::text,
      p_pedido_id := NULL::text,
      p_nota_fiscal_id := NULL::uuid,
      p_chave_acesso_nf := NULL::text,
      p_custo_unitario := NULL::numeric
    ) INTO v_mov_s_id;
    v_mov_ids := array_append(v_mov_ids, v_mov_s_id);

    -- Leg 2: ENTRADA no destino. Se falhar, transação inteira rollback.
    SELECT wms_inserir_movimentacao(
      p_produto_id := (v_item->>'produto_id')::uuid,
      p_galpao_id := p_galpao_id,
      p_localizacao_id := p_localizacao_destino_id,
      p_tipo := 'E'::char(1),
      p_quantidade := (v_item->>'qty')::numeric,
      p_origem_tipo := 'transferencia_localizacao'::text,
      p_origem_id := v_origem_id_txt,
      p_origem_detalhes := NULL::jsonb,
      p_usuario_id := p_usuario_id,
      p_expira_em := NULL::timestamptz,
      p_estorno_de := NULL::uuid,
      p_empresa_compradora_id := NULL::uuid,
      p_empresa_vendedora_id := NULL::uuid,
      p_empresa_referencia_id := NULL::uuid,
      p_fornecedor_id := NULL::uuid,
      p_motivo := p_observacoes,
      p_cliente_nome := NULL::text,
      p_pedido_id := NULL::text,
      p_nota_fiscal_id := NULL::uuid,
      p_chave_acesso_nf := NULL::text,
      p_custo_unitario := NULL::numeric
    ) INTO v_mov_e_id;
    v_mov_ids := array_append(v_mov_ids, v_mov_e_id);
  END LOOP;

  RETURN jsonb_build_object(
    'origem_id', v_origem_id,
    'mov_ids', to_jsonb(v_mov_ids)
  );
END;
$$;

COMMENT ON FUNCTION wms_replenishment_intra_galpao(uuid,uuid,uuid,jsonb,uuid,text,uuid) IS
  'P3 #8.8: replenishment intra-galpão atômico. Par S+E na mesma transação.';
