-- Perf Tier 1 — índices para os padrões de query mais quentes.
-- Nenhuma mudança de comportamento: índices não alteram semântica, só plano.
--
-- 1. Listagem de pedidos (GET /api/wms/pedidos): .in("status", ...) +
--    ORDER BY criado_em DESC + LIMIT. Hoje seq scan + sort.
-- 2. Varredura validação OC / filtros 3-way em pedidos:
--    (status_separacao, separacao_galpao_id, empresa_origem_id). O índice
--    existente idx_siso_pedidos_status_empresa cobre só 2 das 3 colunas.
-- 3. Giro de vendas no ledger: as MVs siso_cobertura_estoque (refresh 1min)
--    e siso_curva_abc agregam siso_movimentacoes com
--    WHERE tipo='S' AND origem_tipo IN (...) AND criado_em >= 30d
--    AND estorno_de IS NULL. Ledger só cresce — sem índice parcial, cada
--    refresh é full scan.

CREATE INDEX IF NOT EXISTS idx_pedidos_status_criado
  ON siso_pedidos (status, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_pedidos_status_sep_galpao_empresa
  ON siso_pedidos (status_separacao, separacao_galpao_id, empresa_origem_id);

CREATE INDEX IF NOT EXISTS idx_mov_giro
  ON siso_movimentacoes (origem_tipo, criado_em)
  WHERE tipo = 'S' AND estorno_de IS NULL;
