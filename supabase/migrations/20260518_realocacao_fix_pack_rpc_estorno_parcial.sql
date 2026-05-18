-- Spec § 1.3 — estorno proporcional de mov compartilhada (C3).
-- Cria mov de estorno com qty parcial; contabiliza em siso_movimentacoes.qty_estornada.
--
-- Type override vs spec: p_qty numeric (NOT integer) — siso_movimentacoes.quantidade
-- e qty_estornada sao numeric (Task 1.1 fixou qty_estornada pra numeric).

BEGIN;

CREATE OR REPLACE FUNCTION wms_estornar_parcial_movimentacao(
  p_mov_id uuid,
  p_qty numeric,
  p_usuario_id uuid,
  p_observacoes text
) RETURNS siso_movimentacoes LANGUAGE plpgsql AS $$
DECLARE
  v_original siso_movimentacoes;
  v_tipo_inverso char(1);
  v_estorno siso_movimentacoes;
BEGIN
  SELECT * INTO v_original
    FROM siso_movimentacoes
    WHERE id = p_mov_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mov % nao encontrada', p_mov_id;
  END IF;
  IF v_original.estorno_de IS NOT NULL THEN
    RAISE EXCEPTION 'mov % e ela mesma um estorno', p_mov_id;
  END IF;
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'qty deve ser positiva: %', p_qty;
  END IF;
  IF v_original.qty_estornada + p_qty > v_original.quantidade THEN
    RAISE EXCEPTION 'estorno parcial excede saldo: ja_estornado=% + qty=% > total=%',
      v_original.qty_estornada, p_qty, v_original.quantidade;
  END IF;

  v_tipo_inverso := CASE v_original.tipo
                      WHEN 'E' THEN 'S'
                      WHEN 'S' THEN 'E'
                      WHEN 'R' THEN 'L'
                      WHEN 'L' THEN 'R'
                    END;

  -- Assinatura real de wms_inserir_movimentacao (verificada em staging):
  -- p_produto, p_dona, p_galpao, p_localizacao, p_tipo, p_qty,
  -- p_origem_tipo, p_origem_id, p_origem_detalhes,
  -- p_emprestimo_devedora, p_expira_em, p_nota_fiscal_id, p_custo_unitario,
  -- p_usuario, p_observacoes, p_estorno_de, p_criado_em DEFAULT NULL
  v_estorno := wms_inserir_movimentacao(
    v_original.produto_id,
    v_original.empresa_dona_id,
    v_original.galpao_id,
    v_original.localizacao_id,
    v_tipo_inverso,
    p_qty,
    'estorno',
    p_mov_id::text,
    jsonb_build_object('estorno_de', p_mov_id, 'parcial', true,
                       'mov_original_origem', v_original.origem_tipo),
    NULL,    -- p_emprestimo_devedora
    NULL,    -- p_expira_em
    NULL,    -- p_nota_fiscal_id
    NULL,    -- p_custo_unitario
    p_usuario_id,
    p_observacoes,
    p_mov_id -- p_estorno_de
  );

  UPDATE siso_movimentacoes
    SET qty_estornada = qty_estornada + p_qty
    WHERE id = p_mov_id;

  RETURN v_estorno;
END;
$$;

COMMIT;
