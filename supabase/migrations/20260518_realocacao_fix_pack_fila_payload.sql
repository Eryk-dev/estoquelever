-- ============================================================
-- Fix-pack realocação cascateável — I5
-- Adiciona coluna payload jsonb na siso_fila_execucao pra que o
-- worker possa pular itens cujo estoque já foi lançado via realocação
-- (mov_saida_id setado) sem precisar inferir do banco.
-- ============================================================

ALTER TABLE siso_fila_execucao
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN siso_fila_execucao.payload IS
  'Dados extras do job (ex: itens_ja_lancados: number[] — IDs de siso_pedido_itens com mov_saida_id já preenchido por realoc/parcial; worker pula a dedução desses).';
