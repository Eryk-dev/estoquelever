-- Drop empresa_dona_id de todas as tabelas siso_inventario_* (modelo 3D)
-- Spec: docs/superpowers/specs/2026-05-20-ledger-simplificado-design.md
-- Plano: Fase 5 Batch C, Task 5.6.
--
-- Por que aqui (e não na 20260520_ledger_simplificado.sql): a migration
-- gigante da Fase 1 não tocou no inventário (foi pra estoque/movimentações
-- + custo médio). Lib `inventario.ts` foi reescrita pra 3D na Fase 5 e
-- não passa mais `empresa_dona_id` em INSERTs — colunas NOT NULL bloqueiam
-- o write. IF EXISTS pra idempotência (staging tem, prod main não tem).

ALTER TABLE IF EXISTS siso_inventario_sessoes       DROP COLUMN IF EXISTS empresa_dona_id;
ALTER TABLE IF EXISTS siso_inventario_localizacoes  DROP COLUMN IF EXISTS empresa_dona_id;
ALTER TABLE IF EXISTS siso_inventario_contagens     DROP COLUMN IF EXISTS empresa_dona_id;
ALTER TABLE IF EXISTS siso_inventario_divergencias  DROP COLUMN IF EXISTS empresa_dona_id;
