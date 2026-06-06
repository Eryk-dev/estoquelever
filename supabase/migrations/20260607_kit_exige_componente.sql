-- P120 — invariante hard: siso_produtos.eh_kit=true só persiste com ≥1 linha
-- em siso_produto_kits. Cobre sync-tiny e escrita direta (o editor manual já
-- foi reordenado pra inserir o componente antes de marcar eh_kit).
--
-- BEFORE INSERT OR UPDATE em siso_produtos: dispara só quando eh_kit passa a true.

BEGIN;

CREATE OR REPLACE FUNCTION wms_kit_exige_componente()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Só valida quando eh_kit está sendo ligado (ou já é true num INSERT).
  IF NEW.eh_kit = true AND (TG_OP = 'INSERT' OR COALESCE(OLD.eh_kit, false) = false) THEN
    IF NOT EXISTS (
      SELECT 1 FROM siso_produto_kits WHERE kit_produto_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'kit % exige ≥1 componente em siso_produto_kits antes de eh_kit=true', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kit_exige_componente ON siso_produtos;
CREATE TRIGGER trg_kit_exige_componente
  BEFORE INSERT OR UPDATE ON siso_produtos
  FOR EACH ROW
  EXECUTE FUNCTION wms_kit_exige_componente();

COMMENT ON FUNCTION wms_kit_exige_componente() IS
  'P120: bloqueia eh_kit=true sem composição em siso_produto_kits (cobre sync e escrita direta).';

COMMIT;
