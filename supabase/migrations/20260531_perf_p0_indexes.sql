-- P0.6 — Índices faltantes pros hot paths (auditoria de performance 2026-05-31).
--
-- (a) Busca de produtos: o filtro `sku ILIKE '%termo%' OR descricao ILIKE '%termo%'`
--     sobre 46k linhas fazia Seq Scan no pior caso (termo raro/sem match):
--     ~1043ms / "Rows Removed by Filter: 46443". Índices trigram GIN tornam isso
--     um index scan. pg_trgm já está habilitado; a tabela irmã
--     siso_produtos_catalogo (módulo Cross) já usa exatamente este padrão.
--
-- (b) Relatórios por empresa varrem o ledger inteiro sem cobertura de índice:
--       saldos-por-empresa: WHERE estorno_de IS NULL AND tipo IN ('E','S') [AND galpao_id=?]
--       movs-por-empresa:   WHERE criado_em BETWEEN ? AND ? AND estorno_de IS NULL ...
--     Índices parciais casam os predicados reais. Latente hoje (poucos movs em
--     staging), preventivo pra escala de produção (~50-100k movs/mês).
--
-- Nota pra promoção a PROD: a tabela siso_produtos tem volume; rodar os CREATE
-- INDEX como CONCURRENTLY (fora de transação) pra não travar escrita durante o
-- build. Em staging (sem tráfego) o build inline é instantâneo.

CREATE INDEX IF NOT EXISTS idx_produtos_sku_trgm
  ON siso_produtos USING gin (sku gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_produtos_descricao_trgm
  ON siso_produtos USING gin (descricao gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_mov_saldos_empresa
  ON siso_movimentacoes (galpao_id)
  WHERE estorno_de IS NULL AND tipo IN ('E', 'S');

CREATE INDEX IF NOT EXISTS idx_mov_criado_em
  ON siso_movimentacoes (criado_em)
  WHERE estorno_de IS NULL;
