-- Spec § 1.2 — RPC pra UPDATE atômico de quantidade_pega em siso_pedido_itens.
-- Substitui read-modify-write em parcial/route.ts e marcar-realocacao/route.ts.

BEGIN;

CREATE OR REPLACE FUNCTION wms_acumular_qty_pega(p_item_id bigint, p_delta integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_nova integer;
BEGIN
  UPDATE siso_pedido_itens
    SET quantidade_pega = COALESCE(quantidade_pega, 0) + p_delta
    WHERE id = p_item_id
    RETURNING quantidade_pega INTO v_nova;
  IF v_nova IS NULL THEN
    RAISE EXCEPTION 'item % nao encontrado', p_item_id;
  END IF;
  IF v_nova < 0 THEN
    RAISE EXCEPTION 'quantidade_pega negativa: novo=% delta=%', v_nova, p_delta;
  END IF;
  RETURN v_nova;
END;
$$;

COMMIT;
