-- ============================================================================
-- WMS · Inventário · num_operadores na sessão
-- ============================================================================
-- Supervisor escolhe quantos operadores vão trabalhar na sessão (1..5). A
-- tela handheld só expõe slots OP1..OP{num_operadores} — os demais ficam
-- escondidos. Default 5 preserva o comportamento histórico (todos os 5
-- slots disponíveis) pra sessões já criadas.
-- ============================================================================

ALTER TABLE siso_inventario_sessoes
  ADD COLUMN IF NOT EXISTS num_operadores smallint NOT NULL DEFAULT 5
    CHECK (num_operadores BETWEEN 1 AND 5);
