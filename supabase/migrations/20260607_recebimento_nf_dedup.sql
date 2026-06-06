-- P099/P109 — dedup de recebimento por assinatura da NF de compra.
-- Espelha 20260527_p3_movs_unique_inventario_divergencia.sql.
--
-- DOIS índices parciais complementares (caminhos REAIS de entrada divergem na
-- assinatura disponível):
--   uq_mov_recebimento_nf_chave: (chave_acesso_nf, produto, galpão) — /api/wms/receber
--     (receberEstoque propaga chave_acesso_nf, movimentacoes.ts:138,187).
--   uq_mov_recebimento_nf_id:    (nota_fiscal_id, produto, galpão) — compras/receber
--     (gravarMovEntradaCompra propaga só nota_fiscal_id, route.ts:447).
-- 2º clique / reenvio do integrador bate em 23505 → tratado como idempotente no TS.
--
-- receber-oc.ts NÃO propaga NF (nem chave nem id) → NÃO é dedupado por NF (sem
-- assinatura estável); idempotência desse caminho fica no claim atômico de OC (fora desta fase).
--
-- Pré-condição: nenhuma duplicata viva já existente; senão o CREATE UNIQUE falha
-- (proteção). Cleanup retroativo de duplicatas históricas é P6.
--
-- ⚠️ PROD: siso_movimentacoes é a tabela de maior escrita do sistema. Numa base
-- de prod populada, criar estes índices DEVE rodar com CREATE UNIQUE INDEX
-- CONCURRENTLY, FORA de BEGIN/COMMIT (CONCURRENTLY não roda em transação), pra
-- não travar writes. Inline (em transação) é aceitável só em staging.

BEGIN;

CREATE UNIQUE INDEX uq_mov_recebimento_nf_chave
  ON siso_movimentacoes(chave_acesso_nf, produto_id, galpao_id)
  WHERE origem_tipo = 'nf_compra'
    AND chave_acesso_nf IS NOT NULL
    AND estorno_de IS NULL;

CREATE UNIQUE INDEX uq_mov_recebimento_nf_id
  ON siso_movimentacoes(nota_fiscal_id, produto_id, galpao_id)
  WHERE origem_tipo = 'nf_compra'
    AND nota_fiscal_id IS NOT NULL
    AND estorno_de IS NULL;

COMMENT ON INDEX uq_mov_recebimento_nf_chave IS
  'P099/P109: dedup de recebimento por (chave_acesso_nf, produto, galpão) — caminho /api/wms/receber.';
COMMENT ON INDEX uq_mov_recebimento_nf_id IS
  'P099/P109: dedup de recebimento por (nota_fiscal_id, produto, galpão) — caminho compras/receber.';

COMMIT;
