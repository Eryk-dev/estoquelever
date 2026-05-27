-- Adiciona valor 'devolucao_cliente_troca_sku' ao CHECK de
-- siso_movimentacoes.origem_tipo. Classes A (íntegro) e D (troca_sku)
-- usavam ambos 'devolucao_cliente_integra' — apuração misturada. Reports
-- financeiros precisam separar (troca_sku é receita zero — troca de
-- mercadoria).
BEGIN;

ALTER TABLE siso_movimentacoes
  DROP CONSTRAINT IF EXISTS siso_movimentacoes_origem_tipo_check;

ALTER TABLE siso_movimentacoes
  ADD CONSTRAINT siso_movimentacoes_origem_tipo_check
  CHECK (origem_tipo IN (
    'nf_compra',
    'devolucao_cliente_integra',
    'devolucao_cliente_avariada',
    'devolucao_cliente_troca_sku',  -- NOVO
    'devolucao_fornecedor_recebida',
    'devolucao_fornecedor_enviada',
    'nf_venda',
    'venda_manual',
    'ajuste_manual',
    'ajuste_pick_zerou',
    'inventario_perda',
    'inventario_ganho',
    'inventario_inicial',
    'transferencia_galpao',
    'transferencia_localizacao',
    'reserva_pedido',
    'liberacao_reserva',
    'lancamento_retroativo',
    'estorno'
  ));

COMMIT;

-- DOWN: restaura CHECK sem o valor novo.
--   ALTER TABLE siso_movimentacoes DROP CONSTRAINT siso_movimentacoes_origem_tipo_check;
--   ALTER TABLE siso_movimentacoes ADD CONSTRAINT siso_movimentacoes_origem_tipo_check
--     CHECK (origem_tipo IN (
--       'nf_compra','devolucao_cliente_integra','devolucao_cliente_avariada',
--       'devolucao_fornecedor_recebida','devolucao_fornecedor_enviada',
--       'nf_venda','venda_manual','ajuste_manual','ajuste_pick_zerou',
--       'inventario_perda','inventario_ganho','inventario_inicial',
--       'transferencia_galpao','transferencia_localizacao',
--       'reserva_pedido','liberacao_reserva','lancamento_retroativo','estorno'
--     ));
