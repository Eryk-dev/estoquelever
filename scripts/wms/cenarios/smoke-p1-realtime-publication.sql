-- Smoke-test P1 · Migration 1 (realtime publication completeness)
-- Expected after migration: 14 rows total in supabase_realtime publication,
-- including the 6 tables added by 20260527_realtime_publication_completeness.sql.

WITH expected AS (
  SELECT unnest(ARRAY[
    'siso_custo_medio',
    'siso_devolucoes_pendentes',
    'siso_estoque',
    'siso_inventario_contagens',
    'siso_inventario_divergencias',
    'siso_inventario_localizacoes',
    'siso_inventario_operadores',
    'siso_inventario_sessoes',
    'siso_movimentacoes',
    'siso_pedido_item_realocacoes',
    'siso_pedido_itens',
    'siso_pedidos',
    'siso_transferencias_galpao',
    'siso_wms_pendencias_guarda'
  ]) AS tablename
),
actual AS (
  SELECT tablename
  FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'
)
SELECT
  e.tablename,
  CASE WHEN a.tablename IS NULL THEN 'MISSING' ELSE 'OK' END AS status
FROM expected e
LEFT JOIN actual a USING (tablename)
ORDER BY status DESC, tablename;
