-- WMS — Reconciliação ledger ↔ siso_estoque
-- Spec: docs/superpowers/specs/2026-05-07-wms-design.md §12.1

-- Detecta linhas de siso_estoque com saldo divergente do ledger
CREATE OR REPLACE FUNCTION wms_detectar_divergencias_estoque()
RETURNS TABLE (
  id uuid,
  produto_id uuid,
  empresa_dona_id uuid,
  galpao_id uuid,
  localizacao_id uuid,
  saldo_estoque numeric,
  saldo_calculado numeric,
  divergencia numeric
) LANGUAGE sql AS $$
  SELECT
    e.id, e.produto_id, e.empresa_dona_id, e.galpao_id, e.localizacao_id,
    e.saldo,
    COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                      WHEN m.tipo='S' THEN -m.quantidade ELSE 0 END), 0),
    e.saldo - COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                                WHEN m.tipo='S' THEN -m.quantidade ELSE 0 END), 0)
  FROM siso_estoque e
  LEFT JOIN siso_movimentacoes m
    ON m.produto_id = e.produto_id
   AND m.empresa_dona_id = e.empresa_dona_id
   AND m.galpao_id = e.galpao_id
   AND m.localizacao_id = e.localizacao_id
  GROUP BY e.id
  HAVING e.saldo <> COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                                      WHEN m.tipo='S' THEN -m.quantidade ELSE 0 END), 0);
$$;

-- Reconstrói linha de estoque a partir do ledger (autoritativo)
CREATE OR REPLACE FUNCTION wms_rebuild_linha_estoque(p_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_saldo numeric;
  v_reservado numeric;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN tipo='E' THEN quantidade
                      WHEN tipo='S' THEN -quantidade ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN tipo='R' THEN quantidade
                      WHEN tipo='L' THEN -quantidade ELSE 0 END), 0)
  INTO v_saldo, v_reservado
  FROM siso_movimentacoes m
  JOIN siso_estoque e ON e.id = p_id
  WHERE m.produto_id = e.produto_id
    AND m.empresa_dona_id = e.empresa_dona_id
    AND m.galpao_id = e.galpao_id
    AND m.localizacao_id = e.localizacao_id;

  UPDATE siso_estoque
  SET saldo = v_saldo, reservado = v_reservado, atualizado_em = now()
  WHERE id = p_id;
END;
$$;
