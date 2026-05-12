-- WMS — Lead time default por fornecedor
-- Permite configurar lead_time_dias_min/medio/max direto em siso_fornecedores.
-- Quando um produto é vinculado ao fornecedor (siso_produto_fornecedores) sem
-- lead_time explícito, herda-se desses defaults. Vínculo continua podendo
-- sobrescrever caso a caso.

BEGIN;

ALTER TABLE siso_fornecedores
  ADD COLUMN IF NOT EXISTS lead_time_dias_min int
    CHECK (lead_time_dias_min IS NULL OR lead_time_dias_min >= 0),
  ADD COLUMN IF NOT EXISTS lead_time_dias_medio int
    CHECK (lead_time_dias_medio IS NULL OR lead_time_dias_medio >= 0),
  ADD COLUMN IF NOT EXISTS lead_time_dias_max int
    CHECK (lead_time_dias_max IS NULL OR lead_time_dias_max >= 0);

-- Ordenação min <= medio <= max quando os pares estão preenchidos.
-- NULL em qualquer lado deixa a expressão como UNKNOWN, o que a CHECK aceita.
ALTER TABLE siso_fornecedores
  DROP CONSTRAINT IF EXISTS siso_fornecedores_lead_time_ordem_min_medio,
  DROP CONSTRAINT IF EXISTS siso_fornecedores_lead_time_ordem_medio_max;

ALTER TABLE siso_fornecedores
  ADD CONSTRAINT siso_fornecedores_lead_time_ordem_min_medio
    CHECK (lead_time_dias_min IS NULL OR lead_time_dias_medio IS NULL
           OR lead_time_dias_min <= lead_time_dias_medio),
  ADD CONSTRAINT siso_fornecedores_lead_time_ordem_medio_max
    CHECK (lead_time_dias_medio IS NULL OR lead_time_dias_max IS NULL
           OR lead_time_dias_medio <= lead_time_dias_max);

COMMENT ON COLUMN siso_fornecedores.lead_time_dias_min IS
  'Default mínimo. Herdado por siso_produto_fornecedores ao vincular um produto sem lead_time explícito.';
COMMENT ON COLUMN siso_fornecedores.lead_time_dias_medio IS
  'Default médio. Herdado por siso_produto_fornecedores ao vincular um produto sem lead_time explícito.';
COMMENT ON COLUMN siso_fornecedores.lead_time_dias_max IS
  'Default máximo. Herdado por siso_produto_fornecedores ao vincular um produto sem lead_time explícito.';

COMMIT;
