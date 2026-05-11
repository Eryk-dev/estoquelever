-- Permite registrar movimentação com data customizada (retroativo) pelo modal
-- de Receber Mercadoria. Antes, retroativos exigiam fluxo separado em
-- /wms/retroativos. Agora o operador escolhe a data no próprio modal de
-- Receber; default = hoje. Se NULL, mantém comportamento antigo (now()).
BEGIN;

CREATE OR REPLACE FUNCTION wms_inserir_movimentacao(
  p_produto uuid, p_dona uuid, p_galpao uuid, p_localizacao uuid,
  p_tipo char(1), p_qty numeric,
  p_origem_tipo text, p_origem_id text, p_origem_detalhes jsonb,
  p_emprestimo_devedora uuid, p_expira_em timestamptz,
  p_nota_fiscal_id bigint, p_custo_unitario numeric,
  p_usuario uuid, p_observacoes text, p_estorno_de uuid,
  p_criado_em timestamptz DEFAULT NULL
) RETURNS siso_movimentacoes LANGUAGE plpgsql AS $$
DECLARE
  v_saldo numeric := 0;
  v_reservado numeric := 0;
  v_saldo_posterior numeric;
  v_reservado_posterior numeric;
  v_mov siso_movimentacoes;
  v_estoque_id uuid;
BEGIN
  SELECT id, saldo, reservado INTO v_estoque_id, v_saldo, v_reservado
  FROM siso_estoque
  WHERE produto_id = p_produto AND empresa_dona_id = p_dona
    AND galpao_id = p_galpao AND localizacao_id = p_localizacao
  FOR UPDATE;

  IF v_estoque_id IS NULL THEN
    v_saldo := 0;
    v_reservado := 0;
  END IF;

  IF p_tipo = 'E' THEN
    v_saldo_posterior := v_saldo + p_qty;
    v_reservado_posterior := v_reservado;
  ELSIF p_tipo = 'S' THEN
    v_saldo_posterior := v_saldo - p_qty;
    v_reservado_posterior := v_reservado;
  ELSIF p_tipo = 'R' THEN
    v_saldo_posterior := v_saldo;
    v_reservado_posterior := v_reservado + p_qty;
  ELSIF p_tipo = 'L' THEN
    v_saldo_posterior := v_saldo;
    v_reservado_posterior := v_reservado - p_qty;
  ELSE
    RAISE EXCEPTION 'tipo inválido: %', p_tipo;
  END IF;

  IF v_saldo_posterior < 0 THEN
    RAISE EXCEPTION 'saldo insuficiente: anterior=% qty=% tipo=%', v_saldo, p_qty, p_tipo;
  END IF;
  IF v_reservado_posterior < 0 THEN
    RAISE EXCEPTION 'reservado iria negativo: anterior=% qty=%', v_reservado, p_qty;
  END IF;
  IF v_reservado_posterior > v_saldo_posterior THEN
    RAISE EXCEPTION 'reservado (%) excederia saldo (%)', v_reservado_posterior, v_saldo_posterior;
  END IF;

  INSERT INTO siso_movimentacoes (
    produto_id, empresa_dona_id, galpao_id, localizacao_id,
    tipo, quantidade,
    saldo_anterior, saldo_posterior,
    reservado_anterior, reservado_posterior,
    origem_tipo, origem_id, origem_detalhes,
    emprestimo_devedora_id, expira_em,
    nota_fiscal_id, custo_unitario,
    usuario_id, observacoes, estorno_de,
    criado_em
  ) VALUES (
    p_produto, p_dona, p_galpao, p_localizacao,
    p_tipo, p_qty,
    v_saldo, v_saldo_posterior,
    v_reservado, v_reservado_posterior,
    p_origem_tipo, p_origem_id, p_origem_detalhes,
    p_emprestimo_devedora, p_expira_em,
    p_nota_fiscal_id, p_custo_unitario,
    p_usuario, p_observacoes, p_estorno_de,
    COALESCE(p_criado_em, now())
  ) RETURNING * INTO v_mov;

  IF v_estoque_id IS NOT NULL THEN
    UPDATE siso_estoque
    SET saldo = v_saldo_posterior, reservado = v_reservado_posterior, atualizado_em = now()
    WHERE id = v_estoque_id;
  ELSE
    INSERT INTO siso_estoque (
      produto_id, empresa_dona_id, galpao_id, localizacao_id,
      saldo, reservado
    ) VALUES (
      p_produto, p_dona, p_galpao, p_localizacao,
      v_saldo_posterior, v_reservado_posterior
    );
  END IF;

  RETURN v_mov;
END;
$$;

COMMIT;
