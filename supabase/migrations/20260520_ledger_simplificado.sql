-- ============================================================================
-- Ledger Simplificado 3D — dropa empresa_dona do físico, cria custo médio global
-- Spec: docs/superpowers/specs/2026-05-20-ledger-simplificado-design.md
-- ============================================================================

BEGIN;

-- 1. DROP tabelas obsoletas (empréstimo regras + mini-swap config)
DROP TABLE IF EXISTS siso_emprestimo_regras CASCADE;
DROP TABLE IF EXISTS siso_wms_mini_swap_config CASCADE;

-- 2. DROP RPCs obsoletas
DROP FUNCTION IF EXISTS wms_executar_mini_swap CASCADE;
DROP FUNCTION IF EXISTS wms_executar_swap CASCADE;
DROP FUNCTION IF EXISTS wms_saldos_devedores CASCADE;

-- 2b. DROP materialized views que dependem de empresa_dona_id (serão recriadas em 3D na Task 2.5)
DROP MATERIALIZED VIEW IF EXISTS siso_cobertura_estoque CASCADE;
DROP MATERIALIZED VIEW IF EXISTS siso_curva_abc CASCADE;

-- 3. TRUNCATE caches operacionais (zero dados reais — confirmado pelo user)
TRUNCATE siso_movimentacoes CASCADE;
TRUNCATE siso_estoque CASCADE;
TRUNCATE siso_pedido_item_estoques CASCADE;
TRUNCATE siso_pedido_item_realocacoes CASCADE;
TRUNCATE siso_wms_pendencias_guarda CASCADE;
TRUNCATE siso_inventario_contagens CASCADE;
TRUNCATE siso_inventario_divergencias CASCADE;
TRUNCATE siso_inventario_localizacoes CASCADE;
TRUNCATE siso_inventario_operadores CASCADE;
TRUNCATE siso_inventario_sessoes CASCADE;

-- 4. ALTER siso_estoque pra 3D
ALTER TABLE siso_estoque
  DROP CONSTRAINT IF EXISTS siso_estoque_produto_dona_galpao_loc_key;
ALTER TABLE siso_estoque DROP COLUMN IF EXISTS empresa_dona_id;
ALTER TABLE siso_estoque DROP COLUMN IF EXISTS custo_medio;
ALTER TABLE siso_estoque
  ADD CONSTRAINT siso_estoque_unique_3d UNIQUE (produto_id, galpao_id, localizacao_id);

-- 5. ALTER siso_movimentacoes — drop colunas obsoletas
ALTER TABLE siso_movimentacoes
  DROP COLUMN IF EXISTS empresa_dona_id,
  DROP COLUMN IF EXISTS emprestimo_devedora_id;

-- 6. ALTER siso_movimentacoes — add metadata nova (todas nullable)
-- IF NOT EXISTS porque `custo_unitario` já existe no schema legado
ALTER TABLE siso_movimentacoes
  ADD COLUMN IF NOT EXISTS empresa_compradora_id uuid REFERENCES siso_empresas(id),
  ADD COLUMN IF NOT EXISTS empresa_vendedora_id  uuid REFERENCES siso_empresas(id),
  ADD COLUMN IF NOT EXISTS empresa_referencia_id uuid REFERENCES siso_empresas(id),
  ADD COLUMN IF NOT EXISTS fornecedor_id         uuid REFERENCES siso_fornecedores(id),
  ADD COLUMN IF NOT EXISTS motivo                text,
  ADD COLUMN IF NOT EXISTS cliente_nome          text,
  ADD COLUMN IF NOT EXISTS custo_unitario        numeric,
  ADD COLUMN IF NOT EXISTS custo_medio_anterior  numeric,
  ADD COLUMN IF NOT EXISTS custo_medio_posterior numeric;

-- 7. Atualizar CHECK constraint de origem_tipo
ALTER TABLE siso_movimentacoes
  DROP CONSTRAINT IF EXISTS siso_movimentacoes_origem_tipo_check;
ALTER TABLE siso_movimentacoes
  ADD CONSTRAINT siso_movimentacoes_origem_tipo_check CHECK (origem_tipo IN (
    'nf_compra',
    'devolucao_cliente_integra',
    'devolucao_cliente_avariada',
    'devolucao_fornecedor_recebida',
    'nf_venda',
    'venda_manual',
    'devolucao_fornecedor_enviada',
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

-- 8. Criar siso_custo_medio (cache global por produto)
CREATE TABLE siso_custo_medio (
  produto_id              uuid PRIMARY KEY REFERENCES siso_produtos(id) ON DELETE CASCADE,
  custo_medio             numeric NOT NULL DEFAULT 0 CHECK (custo_medio >= 0),
  ultima_movimentacao_id  uuid REFERENCES siso_movimentacoes(id),
  atualizado_em           timestamptz NOT NULL DEFAULT now()
);

-- 9. Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE siso_custo_medio;

COMMIT;
