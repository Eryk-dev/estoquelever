-- Migration: substitui o vínculo 1:1 siso_empresas.galpao_id por uma relação
-- N:N opcional siso_empresa_galpoes_preferenciais. Premissa nova: empresa NÃO
-- pertence a um galpão; ela pode operar em todos e ter zero, um ou vários
-- galpões marcados como preferenciais (geo-priority do roteamento).
--
-- Pra não quebrar consumidores legados que ainda leem siso_empresas.galpao_id
-- (compras-release, oc-recebimento, snapshot-inicial, cross/empresa-origem,
-- separacao/encaminhar, separacao/produto-esgotado, equivalente/confirmar)
-- mantemos a coluna nullable e um trigger AFTER que espelha sempre
-- galpao_id = preferenciais[0] (ordem alfabética estável do nome do galpão)
-- ou NULL quando não houver preferencial. Código novo (roteamento.ts,
-- swap.ts) lê da tabela N:N como fonte de verdade.

-- 1. Tabela N:N opcional ------------------------------------------------------
CREATE TABLE IF NOT EXISTS siso_empresa_galpoes_preferenciais (
  empresa_id uuid NOT NULL REFERENCES siso_empresas(id) ON DELETE CASCADE,
  galpao_id  uuid NOT NULL REFERENCES siso_galpoes(id)  ON DELETE CASCADE,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, galpao_id)
);

CREATE INDEX IF NOT EXISTS idx_siso_empresa_galpoes_pref_galpao
  ON siso_empresa_galpoes_preferenciais (galpao_id);

COMMENT ON TABLE siso_empresa_galpoes_preferenciais IS
  'Galpões preferenciais (geo-priority) por empresa. Opcional — zero, um ou vários por empresa. Empresa sem preferencial trata todos os galpões como iguais no roteamento.';

-- 2. Backfill: cada empresa ativa hoje já tem um galpao_id; vira preferencial -
INSERT INTO siso_empresa_galpoes_preferenciais (empresa_id, galpao_id)
SELECT id, galpao_id
FROM siso_empresas
WHERE galpao_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 3. Relaxa NOT NULL em siso_empresas.galpao_id ------------------------------
ALTER TABLE siso_empresas
  ALTER COLUMN galpao_id DROP NOT NULL;

COMMENT ON COLUMN siso_empresas.galpao_id IS
  'DEPRECADO — espelha primeiro preferencial via trigger sync_empresa_galpao_id_from_preferenciais. Código novo deve consultar siso_empresa_galpoes_preferenciais. Mantido nullable enquanto consumidores legados (compras-release, oc-recebimento, snapshot-inicial, etc.) não migram.';

-- 4. Trigger espelho: galpao_id = primeiro preferencial (ordem alfabética
--    estável por nome do galpão) ou NULL ------------------------------------
CREATE OR REPLACE FUNCTION sync_empresa_galpao_id_from_preferenciais()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_empresa_id uuid;
BEGIN
  -- Identifica empresa afetada (NEW em INSERT/UPDATE, OLD em DELETE)
  IF TG_OP = 'DELETE' THEN
    v_empresa_id := OLD.empresa_id;
  ELSE
    v_empresa_id := NEW.empresa_id;
  END IF;

  UPDATE siso_empresas
    SET galpao_id = (
      SELECT egp.galpao_id
      FROM siso_empresa_galpoes_preferenciais egp
      JOIN siso_galpoes g ON g.id = egp.galpao_id
      WHERE egp.empresa_id = v_empresa_id
      ORDER BY g.nome ASC
      LIMIT 1
    )
  WHERE id = v_empresa_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_empresa_galpao_id_pref
  ON siso_empresa_galpoes_preferenciais;

CREATE TRIGGER trg_sync_empresa_galpao_id_pref
AFTER INSERT OR UPDATE OR DELETE
ON siso_empresa_galpoes_preferenciais
FOR EACH ROW
EXECUTE FUNCTION sync_empresa_galpao_id_from_preferenciais();

-- 5. Reaplica o backfill via trigger pra normalizar galpao_id por ordenação --
--    (alguns registros podem já estar fora de ordem se nome do galpão mudar)
UPDATE siso_empresas e
SET galpao_id = (
  SELECT egp.galpao_id
  FROM siso_empresa_galpoes_preferenciais egp
  JOIN siso_galpoes g ON g.id = egp.galpao_id
  WHERE egp.empresa_id = e.id
  ORDER BY g.nome ASC
  LIMIT 1
);
