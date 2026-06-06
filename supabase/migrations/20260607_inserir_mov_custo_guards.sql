-- P108 + P110 — recria wms_inserir_movimentacao (corpo de
-- 20260527_wms_inserir_mov_motivo_categoria.sql) com dois guards de custo:
--   P108: entrada (E) com qty>0 e custo 0 nas origens que compõem custo médio → RAISE.
--   P110: estorno (p_estorno_de) de uma entrada que compôs custo → reverte o custo
--         médio ao custo_medio_anterior da mov original (como se a entrada não tivesse existido).
-- Nenhuma outra lógica (saldo, reservado, recálculo ponderado) muda.

BEGIN;

DROP FUNCTION IF EXISTS public.wms_inserir_movimentacao(
  uuid, uuid, uuid, character, numeric, text, text, jsonb, uuid,
  timestamptz, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid, text, numeric, text
);

CREATE OR REPLACE FUNCTION public.wms_inserir_movimentacao(
  p_produto_id uuid, p_galpao_id uuid, p_localizacao_id uuid,
  p_tipo character, p_quantidade numeric,
  p_origem_tipo text, p_origem_id text DEFAULT NULL::text,
  p_origem_detalhes jsonb DEFAULT NULL::jsonb,
  p_usuario_id uuid DEFAULT NULL::uuid,
  p_expira_em timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_estorno_de uuid DEFAULT NULL::uuid,
  p_empresa_compradora_id uuid DEFAULT NULL::uuid,
  p_empresa_vendedora_id uuid DEFAULT NULL::uuid,
  p_empresa_referencia_id uuid DEFAULT NULL::uuid,
  p_fornecedor_id uuid DEFAULT NULL::uuid,
  p_motivo text DEFAULT NULL::text,
  p_cliente_nome text DEFAULT NULL::text,
  p_pedido_id text DEFAULT NULL::text,
  p_nota_fiscal_id uuid DEFAULT NULL::uuid,
  p_chave_acesso_nf text DEFAULT NULL::text,
  p_custo_unitario numeric DEFAULT NULL::numeric,
  p_motivo_categoria text DEFAULT NULL::text
) RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
  v_mov_id              uuid;
  v_saldo_anterior      numeric;
  v_saldo_posterior     numeric;
  v_reservado_anterior  numeric;
  v_reservado_posterior numeric;
  v_custo_medio_atual   numeric;
  v_custo_medio_novo    numeric;
  v_saldo_global        numeric;
  v_recalcula_custo     boolean;
  v_orig_tipo           char(1);
  v_orig_origem         text;
  v_orig_cm_anterior    numeric;
BEGIN
  IF p_tipo NOT IN ('E','S','R','L') THEN RAISE EXCEPTION 'tipo inválido: %', p_tipo; END IF;
  IF p_tipo = 'R' AND p_expira_em IS NULL THEN RAISE EXCEPTION 'reserva (tipo R) exige expira_em'; END IF;
  IF p_tipo <> 'R' AND p_expira_em IS NOT NULL THEN RAISE EXCEPTION 'expira_em só é válido pra tipo R'; END IF;

  SELECT saldo, reservado INTO v_saldo_anterior, v_reservado_anterior
    FROM siso_estoque
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_saldo_anterior := 0;
    v_reservado_anterior := 0;
    INSERT INTO siso_estoque (produto_id, galpao_id, localizacao_id, saldo, reservado)
    VALUES (p_produto_id, p_galpao_id, p_localizacao_id, 0, 0);
  END IF;

  v_saldo_posterior := v_saldo_anterior;
  v_reservado_posterior := v_reservado_anterior;
  IF p_tipo = 'E' THEN
    v_saldo_posterior := v_saldo_anterior + p_quantidade;
  ELSIF p_tipo = 'S' THEN
    v_saldo_posterior := v_saldo_anterior - p_quantidade;
    IF v_saldo_posterior < 0 THEN RAISE EXCEPTION 'saldo insuficiente: % - % < 0', v_saldo_anterior, p_quantidade; END IF;
  ELSIF p_tipo = 'R' THEN
    v_reservado_posterior := v_reservado_anterior + p_quantidade;
    IF v_reservado_posterior > v_saldo_anterior THEN RAISE EXCEPTION 'reserva excede saldo: % + % > %', v_reservado_anterior, p_quantidade, v_saldo_anterior; END IF;
  ELSIF p_tipo = 'L' THEN
    v_reservado_posterior := v_reservado_anterior - p_quantidade;
    IF v_reservado_posterior < 0 THEN RAISE EXCEPTION 'liberação excede reservado: % - % < 0', v_reservado_anterior, p_quantidade; END IF;
  END IF;

  -- WHITELIST: origens de entrada que compõem custo médio quando custo_unitario é informado.
  v_recalcula_custo := (p_tipo = 'E' AND p_custo_unitario IS NOT NULL
                        AND p_origem_tipo IN (
                          'nf_compra',
                          'devolucao_cliente_integra',
                          'lancamento_retroativo',
                          'ajuste_manual',
                          'inventario_inicial'
                        ));

  -- P108: entrada com qty>0 e custo 0 nas origens que compõem custo médio é
  -- bloqueada — evita custo médio R$0 com estoque físico presente.
  IF v_recalcula_custo AND p_quantidade > 0 AND COALESCE(p_custo_unitario, 0) = 0 THEN
    RAISE EXCEPTION 'entrada com custo zero não permitida quando há quantidade (origem %)', p_origem_tipo
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(custo_medio, 0) INTO v_custo_medio_atual
    FROM siso_custo_medio WHERE produto_id=p_produto_id FOR UPDATE;
  IF NOT FOUND THEN v_custo_medio_atual := 0; END IF;
  v_custo_medio_novo := v_custo_medio_atual;

  IF v_recalcula_custo THEN
    SELECT COALESCE(SUM(saldo),0) INTO v_saldo_global FROM siso_estoque WHERE produto_id=p_produto_id;
    IF v_saldo_global + p_quantidade > 0 THEN
      v_custo_medio_novo := (v_saldo_global * v_custo_medio_atual + p_quantidade * p_custo_unitario) / (v_saldo_global + p_quantidade);
    ELSE
      v_custo_medio_novo := p_custo_unitario;
    END IF;
  END IF;

  -- P110: estorno de uma entrada que compôs custo médio → reverte o efeito,
  -- restaurando o custo_medio ao custo_medio_anterior da mov original
  -- (correto quando o estorno é o último evento de custo do produto).
  IF p_estorno_de IS NOT NULL THEN
    SELECT tipo, origem_tipo, custo_medio_anterior
      INTO v_orig_tipo, v_orig_origem, v_orig_cm_anterior
      FROM siso_movimentacoes WHERE id = p_estorno_de;
    IF v_orig_tipo = 'E'
       AND v_orig_origem IN ('nf_compra','devolucao_cliente_integra','lancamento_retroativo','ajuste_manual','inventario_inicial')
       AND v_orig_cm_anterior IS NOT NULL THEN
      v_custo_medio_novo := v_orig_cm_anterior;
    END IF;
  END IF;

  INSERT INTO siso_movimentacoes (
    produto_id, galpao_id, localizacao_id,
    tipo, quantidade,
    saldo_anterior, saldo_posterior,
    reservado_anterior, reservado_posterior,
    origem_tipo, origem_id, origem_detalhes,
    usuario_id, expira_em, estorno_de,
    empresa_compradora_id, empresa_vendedora_id, empresa_referencia_id,
    fornecedor_id, motivo, cliente_nome,
    pedido_id, nota_fiscal_id, chave_acesso_nf,
    custo_unitario, custo_medio_anterior, custo_medio_posterior,
    motivo_categoria
  ) VALUES (
    p_produto_id, p_galpao_id, p_localizacao_id,
    p_tipo, p_quantidade,
    v_saldo_anterior, v_saldo_posterior,
    v_reservado_anterior, v_reservado_posterior,
    p_origem_tipo, p_origem_id, p_origem_detalhes,
    p_usuario_id, p_expira_em, p_estorno_de,
    p_empresa_compradora_id, p_empresa_vendedora_id, p_empresa_referencia_id,
    p_fornecedor_id, p_motivo, p_cliente_nome,
    p_pedido_id, p_nota_fiscal_id, p_chave_acesso_nf,
    p_custo_unitario, v_custo_medio_atual, v_custo_medio_novo,
    p_motivo_categoria::wms_motivo_categoria_enum
  ) RETURNING id INTO v_mov_id;

  UPDATE siso_estoque
     SET saldo = v_saldo_posterior, reservado = v_reservado_posterior, atualizado_em = now()
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id;

  -- Persiste o custo médio quando recalculou (P108) OU quando o estorno o reverteu (P110).
  IF v_recalcula_custo OR (p_estorno_de IS NOT NULL AND v_custo_medio_novo <> v_custo_medio_atual) THEN
    INSERT INTO siso_custo_medio (produto_id, custo_medio, ultima_movimentacao_id, atualizado_em)
    VALUES (p_produto_id, v_custo_medio_novo, v_mov_id, now())
    ON CONFLICT (produto_id) DO UPDATE
      SET custo_medio = EXCLUDED.custo_medio,
          ultima_movimentacao_id = EXCLUDED.ultima_movimentacao_id,
          atualizado_em = EXCLUDED.atualizado_em;
  END IF;

  RETURN v_mov_id;
END;
$function$;

COMMIT;
