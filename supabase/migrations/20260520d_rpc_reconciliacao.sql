-- ============================================================
-- Fase 2 · Task 2.3 — RPCs de reconciliação em 3D
-- ============================================================
-- Detecta divergências entre cache (siso_estoque) e ledger (siso_movimentacoes)
-- e permite rebuild de linha específica. Drop empresa_dona_id de todos os JOINs.
-- ============================================================

-- Drop assinatura antiga (RETURNS TABLE muda, precisa DROP antes)
DROP FUNCTION IF EXISTS wms_detectar_divergencias_estoque() CASCADE;
DROP FUNCTION IF EXISTS wms_rebuild_linha_estoque(uuid) CASCADE;

CREATE OR REPLACE FUNCTION wms_detectar_divergencias_estoque()
RETURNS TABLE (
  estoque_id     uuid,
  produto_id     uuid,
  galpao_id      uuid,
  localizacao_id uuid,
  saldo_cache    numeric,
  saldo_ledger   numeric,
  delta          numeric
)
LANGUAGE sql AS $$
  SELECT e.id, e.produto_id, e.galpao_id, e.localizacao_id,
         e.saldo,
         COALESCE(
           SUM(CASE m.tipo WHEN 'E' THEN m.quantidade WHEN 'S' THEN -m.quantidade ELSE 0 END),
           0
         ) AS saldo_ledger,
         e.saldo - COALESCE(
           SUM(CASE m.tipo WHEN 'E' THEN m.quantidade WHEN 'S' THEN -m.quantidade ELSE 0 END),
           0
         ) AS delta
    FROM siso_estoque e
    LEFT JOIN siso_movimentacoes m
      ON m.produto_id=e.produto_id
     AND m.galpao_id=e.galpao_id
     AND m.localizacao_id=e.localizacao_id
   GROUP BY e.id, e.produto_id, e.galpao_id, e.localizacao_id, e.saldo
  HAVING e.saldo <> COALESCE(
    SUM(CASE m.tipo WHEN 'E' THEN m.quantidade WHEN 'S' THEN -m.quantidade ELSE 0 END),
    0
  );
$$;

CREATE OR REPLACE FUNCTION wms_rebuild_linha_estoque(p_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_saldo numeric; v_reservado numeric; v_produto uuid; v_galpao uuid; v_loc uuid;
BEGIN
  SELECT produto_id, galpao_id, localizacao_id INTO v_produto, v_galpao, v_loc
    FROM siso_estoque WHERE id=p_id;

  SELECT
    COALESCE(SUM(CASE tipo WHEN 'E' THEN quantidade WHEN 'S' THEN -quantidade ELSE 0 END), 0),
    COALESCE(SUM(CASE tipo WHEN 'R' THEN quantidade WHEN 'L' THEN -quantidade ELSE 0 END), 0)
  INTO v_saldo, v_reservado
    FROM siso_movimentacoes
   WHERE produto_id=v_produto AND galpao_id=v_galpao AND localizacao_id=v_loc;

  UPDATE siso_estoque
     SET saldo=v_saldo, reservado=GREATEST(0,v_reservado), atualizado_em=now()
   WHERE id=p_id;
END;
$$;
