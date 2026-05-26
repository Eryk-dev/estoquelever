-- Migration: realtime publication completeness
-- Date: 2026-05-27
-- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
-- Finding(s): 0.1 (ALTO — publication omite 4+ tabelas), 1.8 (BAIXO — siso_wms_pendencias_guarda)
--
-- Adds the 6 tables that CLAUDE.md declares as part of the realtime contract
-- but were never added to the publication (likely lost in 3D ledger DROP/CREATE
-- around 2026-05-20, similar to siso_estoque/siso_movimentacoes that were
-- already restored in 20260525_realtime_estoque_movimentacoes.sql).
--
-- Idempotent: per-table existence check against pg_publication_tables before
-- each ALTER PUBLICATION ADD TABLE (ALTER PUBLICATION does NOT support
-- IF NOT EXISTS in any Postgres version yet — manual guard is required).
-- Low risk: publications are append-only metadata; ALTER PUBLICATION ADD
-- TABLE takes only ShareUpdateExclusiveLock briefly on each target table.

DO $$
DECLARE
  t text;
  tables_to_add text[] := ARRAY[
    'siso_pedidos',
    'siso_pedido_itens',
    'siso_wms_pendencias_guarda',
    'siso_inventario_sessoes',
    'siso_devolucoes_pendentes',
    'siso_transferencias_galpao'
  ];
BEGIN
  FOREACH t IN ARRAY tables_to_add LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
      RAISE NOTICE 'Added table % to supabase_realtime publication', t;
    ELSE
      RAISE NOTICE 'Table % already in supabase_realtime publication (skipped)', t;
    END IF;
  END LOOP;
END $$;

-- Rollback (manual, if ever needed):
-- ALTER PUBLICATION supabase_realtime DROP TABLE siso_pedidos;
-- ALTER PUBLICATION supabase_realtime DROP TABLE siso_pedido_itens;
-- ALTER PUBLICATION supabase_realtime DROP TABLE siso_wms_pendencias_guarda;
-- ALTER PUBLICATION supabase_realtime DROP TABLE siso_inventario_sessoes;
-- ALTER PUBLICATION supabase_realtime DROP TABLE siso_devolucoes_pendentes;
-- ALTER PUBLICATION supabase_realtime DROP TABLE siso_transferencias_galpao;
