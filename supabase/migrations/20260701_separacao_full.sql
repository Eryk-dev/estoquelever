-- Separação Full: envio ao CDF do Mercado Livre sem pedido-fantasma no Tiny.
-- Clona o padrão de `separacao_futura` (20260624_separacao_futura.sql): flag
-- boolean discriminadora + índice parcial. `fechado_em`/`fechado_por` sustentam
-- a etapa terminal virtual `fechado` (espelha `encaixotado_em`). `ordem_full`
-- persiste a ordem de inserção dos itens pro checklist ordenar por "ordem do
-- pedido" (default no Full).
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS separacao_full boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fechado_em timestamptz,
  -- SPEC_DEVIATION: design.md pedia `fechado_por text`; usamos uuid FK pra
  -- bater com a convenção existente de TODAS as colunas *_por (embalado_real_por,
  -- conferido_por, separado_por, criada_por, guardada_por...).
  ADD COLUMN IF NOT EXISTS fechado_por uuid REFERENCES siso_usuarios(id) ON DELETE SET NULL;

-- Índice parcial: a lane Full é uma fração pequena dos pedidos (espelha idx_pedidos_separacao_futura).
CREATE INDEX IF NOT EXISTS idx_pedidos_separacao_full
  ON siso_pedidos (status_separacao)
  WHERE separacao_full = true;

ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS ordem_full integer;
