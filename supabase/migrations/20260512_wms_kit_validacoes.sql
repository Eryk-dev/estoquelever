-- WMS: validações de movimentação envolvendo kits.
--
-- 1. Bloqueia entradas, reservas e liberações diretas em SKUs de kit
--    (kit não tem saldo próprio — deve ser feito nos componentes).
-- 2. Saída de kit é permitida MAS deve ter explodido em componentes pelo
--    chamador (ledger.venderKit). Não bloqueamos saída direta no DB porque
--    em alguns edge-cases (estornos legados) ela pode ser necessária com
--    `origem_detalhes.kit_componente=true`. UI normal usa venderKit.

CREATE OR REPLACE FUNCTION wms_check_mov_nao_kit_entrada()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_eh_kit boolean;
BEGIN
  SELECT eh_kit INTO v_eh_kit FROM siso_produtos WHERE id = NEW.produto_id;
  IF v_eh_kit AND NEW.tipo IN ('E', 'R', 'L') THEN
    RAISE EXCEPTION 'Produto % é um kit — entradas/reservas devem ser feitas nos componentes', NEW.produto_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_mov_nao_kit_entrada ON siso_movimentacoes;
CREATE TRIGGER trg_check_mov_nao_kit_entrada
  BEFORE INSERT ON siso_movimentacoes
  FOR EACH ROW
  EXECUTE FUNCTION wms_check_mov_nao_kit_entrada();
