-- ============================================================
-- Fase 2 · Task 2.2 — wms_reservar_atomico em 3D
-- ============================================================
-- Wrapper sobre wms_inserir_movimentacao com tipo='R' e expira_em.
-- Drop param p_dona (empresa_dona não existe mais).
-- ============================================================

DROP FUNCTION IF EXISTS wms_reservar_atomico(
  uuid, uuid, uuid, uuid, numeric, text, integer, uuid
) CASCADE;

CREATE OR REPLACE FUNCTION wms_reservar_atomico(
  p_produto_id     uuid,
  p_galpao_id      uuid,
  p_localizacao_id uuid,
  p_quantidade     numeric,
  p_pedido_id      uuid,
  p_ttl_horas      integer DEFAULT 48,
  p_usuario_id     uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_mov_id uuid;
BEGIN
  v_mov_id := wms_inserir_movimentacao(
    p_produto_id, p_galpao_id, p_localizacao_id,
    'R', p_quantidade, 'reserva_pedido',
    p_origem_id := p_pedido_id,
    p_pedido_id := p_pedido_id,
    p_usuario_id := p_usuario_id,
    p_expira_em := now() + (p_ttl_horas || ' hours')::interval
  );
  RETURN v_mov_id;
END;
$$;
