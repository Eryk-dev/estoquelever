-- P2-EST-01 — Estorno PARCIAL de entrada de custo restaura custo médio INTEIRO.
--
-- CENÁRIO: produto com 100 un @ R$10 (custo médio 10). Lançamento retroativo
-- adiciona 100 un @ R$20 → custo médio ponderado vira 15. Operador estorna
-- PARCIALMENTE 10 un dessa entrada retroativa. O comportamento vigente (branch
-- P110) faz `v_custo_medio_novo := v_orig_cm_anterior` — restaura o custo médio
-- ao estado PRÉ-entrada (10), como se a entrada inteira tivesse sumido. Errado:
-- só 10 das 100 un foram removidas; o custo correto fica ~14,7, não 10.
--
-- Fórmula do estorno parcial (remove p_quantidade un que entraram a
-- custo_unitario da mov original, do pool global atual a custo médio atual):
--   cm_novo = (saldo_global * cm_atual - p_quantidade * custo_unitario_orig)
--             / (saldo_global - p_quantidade)
-- Ex.: (200*15 - 10*20)/(200-10) = (3000-200)/190 = 2800/190 ≈ 14,7368.
--
-- Guards (qualquer falha → mantém cm_atual, sem corromper):
--   · custo_unitario da mov original NULL → mantém cm_atual.
--   · denominador (saldo_global - p_quantidade) <= 0 → mantém cm_atual.
--   · resultado < 0 → mantém cm_atual.
--
-- ESTORNO TOTAL (p_quantidade >= quantidade da mov original) → comportamento
-- atual preservado (restaura cm_anterior — correto quando o estorno é o último
-- evento de custo e remove a entrada inteira).
--
-- "saldo_global_atual" reusa EXATAMENTE a mesma agregação que o ramo de ENTRADA
-- desta RPC usa pra ponderar custo (SUM(saldo) de siso_estoque por produto),
-- carregada em v_saldo_global.
--
-- Append-only: redefine wms_inserir_movimentacao copiando INTEGRAL a versão
-- vigente (20260607c_inserir_mov_idempotency_param.sql — último CREATE OR
-- REPLACE; 20260611e/f mexeram em OUTRAS funções). Muda SÓ o branch P110.
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
  p_motivo_categoria text DEFAULT NULL::text,
  p_idempotency_key uuid DEFAULT NULL::uuid   -- +P072
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
  v_existente           uuid;   -- +P072
  v_orig_qty            numeric;   -- +EST-01: qty da mov original (estorno parcial)
  v_orig_custo_unit     numeric;   -- +EST-01: custo_unitario da mov original
  v_cm_estorno_parcial  numeric;   -- +EST-01: cm calculado no estorno parcial
BEGIN
  -- +P072: no-op idempotente. Token já consumido → retorna a mov existente.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existente FROM siso_movimentacoes WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_existente; END IF;
  END IF;

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

  -- P110: estorno de uma entrada que compôs custo médio → reverte o efeito.
  IF p_estorno_de IS NOT NULL THEN
    SELECT tipo, origem_tipo, custo_medio_anterior, quantidade, custo_unitario
      INTO v_orig_tipo, v_orig_origem, v_orig_cm_anterior, v_orig_qty, v_orig_custo_unit
      FROM siso_movimentacoes WHERE id = p_estorno_de;
    IF v_orig_tipo = 'E'
       AND v_orig_origem IN ('nf_compra','devolucao_cliente_integra','lancamento_retroativo','ajuste_manual','inventario_inicial')
       AND v_orig_cm_anterior IS NOT NULL THEN
      IF p_quantidade >= v_orig_qty THEN
        -- ESTORNO TOTAL: restaura o custo médio ao pré-entrada (comportamento
        -- vigente — correto quando a entrada inteira é removida).
        v_custo_medio_novo := v_orig_cm_anterior;
      ELSE
        -- +EST-01 ESTORNO PARCIAL: remove só p_quantidade un (a custo_unitario
        -- da mov original) do pool global atual (a custo médio atual). Reusa
        -- v_saldo_global = SUM(saldo) por produto (mesma fonte do ramo de
        -- entrada acima). Carrega se ainda não foi computado (entrada não-custo).
        IF v_saldo_global IS NULL THEN
          SELECT COALESCE(SUM(saldo),0) INTO v_saldo_global FROM siso_estoque WHERE produto_id=p_produto_id;
        END IF;
        v_cm_estorno_parcial := v_custo_medio_atual;  -- fallback: mantém cm_atual
        IF v_orig_custo_unit IS NOT NULL
           AND (v_saldo_global - p_quantidade) > 0 THEN
          v_cm_estorno_parcial :=
            (v_saldo_global * v_custo_medio_atual - p_quantidade * v_orig_custo_unit)
            / (v_saldo_global - p_quantidade);
          IF v_cm_estorno_parcial < 0 THEN
            v_cm_estorno_parcial := v_custo_medio_atual;  -- guard: resultado < 0
          END IF;
        END IF;
        v_custo_medio_novo := v_cm_estorno_parcial;
      END IF;
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
    motivo_categoria,
    idempotency_key   -- +P072
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
    p_motivo_categoria::wms_motivo_categoria_enum,
    p_idempotency_key   -- +P072
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
