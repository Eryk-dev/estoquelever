-- Migration: RPC wms_confirmar_guarda_atomico seta guardada_por
-- Date: 2026-05-28
-- Plan: 2026-05-28-wms-reaudit-fixes (Task 2, P0 re-audit #5.10 regressão)
--
-- Regressão pós-P3: commit 54c921e (P6) afirmou que confirmarGuarda setava
-- guardada_por. Commit 46e71b4 (P3 #5.3) substituiu o caminho JS por RPC
-- plpgsql atômico sem preservar essa escrita. As 2 versões da RPC
-- (20260527_p3_rpc_wms_confirmar_guarda_atomico.sql e
-- 20260528_p5_8_pendencia_em_guarda_parcial.sql) atualizam só
-- qty_guardada, status, guardada_em — guardada_por nunca tocado.
--
-- Toda guarda confirmada após 2026-05-27 tem guardada_por=NULL.
-- Cenário 38 (38-criada-por-guarda.ts:50-56) valida esta asserção.
--
-- Single change vs 20260528_p5_8: adiciona guardada_por = p_usuario_id
-- no UPDATE final. Em parcial setamos pra rastrear "último operador
-- que tocou" — diferença vs iniciada_por captura trade-offs mid-flow.

CREATE OR REPLACE FUNCTION wms_confirmar_guarda_atomico(
  p_pendencia_id uuid,
  p_qty numeric,
  p_localizacao_destino_id uuid,
  p_usuario_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_pend RECORD;
  v_loc_dest RECORD;
  v_repl_result jsonb;
  v_nova_qty_guardada numeric;
  v_totalmente boolean;
  v_novo_status text;
BEGIN
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'qty deve ser > 0' USING ERRCODE = '22023';
  END IF;

  SELECT id, produto_id, galpao_id, localizacao_origem_id, qty_inicial,
         qty_guardada, qty_pendente, status, guardada_em, iniciada_por
    INTO v_pend
    FROM siso_wms_pendencias_guarda
   WHERE id = p_pendencia_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pendência não encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_pend.status = 'guardada' OR v_pend.status = 'cancelada' THEN
    RAISE EXCEPTION 'pendência em status terminal (%)', v_pend.status
      USING ERRCODE = '22023';
  END IF;

  IF p_qty > v_pend.qty_pendente THEN
    RAISE EXCEPTION 'qty (%) excede pendente (%)', p_qty, v_pend.qty_pendente
      USING ERRCODE = '22023';
  END IF;

  IF p_localizacao_destino_id = v_pend.localizacao_origem_id THEN
    RAISE EXCEPTION 'loc destino não pode ser a loc de recebimento (origem da guarda)'
      USING ERRCODE = '22023';
  END IF;

  SELECT id, galpao_id, ativo INTO v_loc_dest
    FROM siso_localizacoes WHERE id = p_localizacao_destino_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'localização destino não encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_loc_dest.ativo THEN
    RAISE EXCEPTION 'localização destino inativa' USING ERRCODE = '22023';
  END IF;
  IF v_loc_dest.galpao_id <> v_pend.galpao_id THEN
    RAISE EXCEPTION 'localização destino é de outro galpão' USING ERRCODE = '22023';
  END IF;

  SELECT wms_replenishment_intra_galpao(
    p_galpao_id := v_pend.galpao_id,
    p_localizacao_origem_id := v_pend.localizacao_origem_id,
    p_localizacao_destino_id := p_localizacao_destino_id,
    p_itens := jsonb_build_array(
      jsonb_build_object('produto_id', v_pend.produto_id, 'qty', p_qty)
    ),
    p_usuario_id := p_usuario_id,
    p_observacoes := NULL::text,
    p_origem_id := NULL::uuid
  ) INTO v_repl_result;

  v_nova_qty_guardada := v_pend.qty_guardada + p_qty;
  v_totalmente := v_nova_qty_guardada >= v_pend.qty_inicial;
  -- [Fix-D #5.8] parcial preserva 'em_guarda' pra manter avatar do operador
  v_novo_status := CASE WHEN v_totalmente THEN 'guardada' ELSE 'em_guarda' END;

  -- [P7 re-audit #5.10] guardada_por setado também em parcial — rastreio
  -- de "último operador que tocou". Difere de iniciada_por (primeiro a
  -- reivindicar) pra capturar trade-offs mid-flow.
  UPDATE siso_wms_pendencias_guarda
     SET qty_guardada = v_nova_qty_guardada,
         status = v_novo_status,
         guardada_em = CASE WHEN v_totalmente THEN now() ELSE NULL END,
         guardada_por = p_usuario_id
   WHERE id = p_pendencia_id;

  RETURN jsonb_build_object(
    'pendencia_id', p_pendencia_id,
    'origem_id', v_repl_result->>'origem_id',
    'mov_ids', v_repl_result->'mov_ids',
    'totalmente_guardada', v_totalmente,
    'qty_guardada', v_nova_qty_guardada,
    'status', v_novo_status,
    'guardada_por', p_usuario_id
  );
END;
$$;

COMMENT ON FUNCTION wms_confirmar_guarda_atomico(uuid,numeric,uuid,uuid) IS
  'P3 #5.3 + #5.8 + P7 re-audit #5.10: confirmar guarda atômico com FOR UPDATE; parcial preserva em_guarda; seta guardada_por.';
