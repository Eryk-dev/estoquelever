-- [P078] Repara wms_estornar_parcial_movimentacao — quebrada desde o 3D.
--
-- A versão de 20260518 chamava wms_inserir_movimentacao POSICIONALMENTE
-- passando v_original.empresa_dona_id (coluna DROPADA no 3D — siso_movimentacoes
-- não tem mais esse campo) e na ordem ANTIGA da assinatura. A redefinição da
-- assinatura em 20260520b removeu o arg empresa_dona e passou a RETORNAR uuid
-- (não mais a linha siso_movimentacoes). Resultado: 42703 (empresa_dona_id) em
-- TODA chamada — quebrava estorno parcial e separacao/desfazer-parcial em runtime.
--
-- Fix cirúrgico (só a chamada wms_inserir_movimentacao + a captura do retorno):
--  1. chamada por NAMED params na assinatura atual (sem empresa_dona_id);
--  2. captura o uuid retornado em v_estorno_id, depois SELECT da linha pra
--     manter o contrato RETURNS siso_movimentacoes (callers como
--     separacao/desfazer-parcial só checam error, mas preservamos a forma).
-- Todo o resto (FOR UPDATE, guards not-found/estorno_de/qty<=0/excede-saldo,
-- v_tipo_inverso CASE, UPDATE qty_estornada) permanece idêntico.

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
  v_estorno_id uuid;
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

  -- Assinatura ATUAL de wms_inserir_movimentacao (sem empresa_dona; retorna uuid).
  -- Chamada por named params pra blindar contra futuras mudanças de ordem.
  v_estorno_id := wms_inserir_movimentacao(
    p_produto_id     := v_original.produto_id,
    p_galpao_id      := v_original.galpao_id,
    p_localizacao_id := v_original.localizacao_id,
    p_tipo           := v_tipo_inverso,
    p_quantidade     := p_qty,
    p_origem_tipo    := 'estorno',
    p_origem_id      := p_mov_id::text,
    p_origem_detalhes := jsonb_build_object('estorno_de', p_mov_id, 'parcial', true,
                                            'mov_original_origem', v_original.origem_tipo),
    p_usuario_id     := p_usuario_id,
    p_estorno_de     := p_mov_id,
    p_motivo         := p_observacoes
  );

  UPDATE siso_movimentacoes
    SET qty_estornada = qty_estornada + p_qty
    WHERE id = p_mov_id;

  SELECT * INTO v_estorno FROM siso_movimentacoes WHERE id = v_estorno_id;
  RETURN v_estorno;
END;
$$;

COMMIT;
