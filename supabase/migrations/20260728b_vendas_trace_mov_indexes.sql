-- Rastreabilidade de Vendas Diretas.
--
-- /api/wms/vendas/[id] e o resumo da lista consultam o ledger pelo pedido
-- atual (`pedido_id`) e pelo marcador JSON das baixas diretas legadas. O banco
-- de produção não tinha índice para nenhum dos dois predicados.
--
-- A tabela é de alta escrita; CONCURRENTLY evita bloquear picks/baixas durante
-- o build. Este arquivo não pode ser envolvido em BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mov_pedido_trace
  ON public.siso_movimentacoes (pedido_id, criado_em)
  WHERE pedido_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mov_pedido_manual_trace
  ON public.siso_movimentacoes (
    (origem_detalhes->>'pedido_id_manual'),
    criado_em
  )
  WHERE origem_detalhes ? 'pedido_id_manual';
