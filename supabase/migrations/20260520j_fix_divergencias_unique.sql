-- Recria UNIQUE constraint em siso_inventario_divergencias após drop de empresa_dona_id.
-- Spec: docs/superpowers/specs/2026-05-20-ledger-simplificado-design.md
--
-- O original (20260529_wms_inventario.sql:111) era:
--   UNIQUE(sessao_id, localizacao_id, produto_id, empresa_dona_id)
--
-- A migration 20260520i_drop_dona_inventario.sql dropou a coluna
-- empresa_dona_id pra mover pro modelo 3D — Postgres dropou junto o
-- UNIQUE constraint (qualquer constraint que cita a coluna some no
-- DROP COLUMN). O constraint nunca foi recriado.
--
-- Sintoma: computarDivergencias() no inventario.ts faz
--   .upsert(..., { onConflict: "sessao_id,localizacao_id,produto_id" })
-- Sem o constraint, Postgres responde "42P10: there is no unique or
-- exclusion constraint matching the ON CONFLICT specification". O
-- supabase-js NÃO encadeia .select(), então o erro é descartado em
-- silêncio. Resultado: 0 divergências criadas mesmo quando reconciliarTemporal()
-- emite N delas, sessão vai pra 'aprovada' (sem pendentes, nenhuma aprovada
-- pra aplicar), aplicarSessao() gera 0 movs.
--
-- Reproduzido na sessão be1c0fa8-424f-4d16-904d-ce77a6f94e3e (3 contagens
-- registradas, 0 divergências persistidas, status='aplicada' com 0 movs).
--
-- IF NOT EXISTS pra idempotência (prod main não tem inventário ainda, mas
-- a migration entra na cadeia pra quando promover).

ALTER TABLE IF EXISTS siso_inventario_divergencias
  DROP CONSTRAINT IF EXISTS siso_inventario_divergencias_tripla_unique;

ALTER TABLE IF EXISTS siso_inventario_divergencias
  ADD CONSTRAINT siso_inventario_divergencias_tripla_unique
  UNIQUE (sessao_id, localizacao_id, produto_id);
