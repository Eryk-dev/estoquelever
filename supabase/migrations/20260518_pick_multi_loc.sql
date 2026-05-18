-- 20260518_pick_multi_loc.sql
-- Picking multi-loc — captura de qty real e posição esvaziada na separação.
-- Spec: docs/superpowers/specs/2026-05-18-pick-multi-loc-design.md

BEGIN;

-- 1. Novo origem_tipo no ledger: ajuste_pick_zerou
ALTER TABLE siso_movimentacoes
  DROP CONSTRAINT siso_movimentacoes_origem_tipo_check;

ALTER TABLE siso_movimentacoes
  ADD CONSTRAINT siso_movimentacoes_origem_tipo_check
  CHECK (origem_tipo IN (
    'compra_manual','lancamento_retroativo','nf_venda','nf_devolucao_cliente',
    'nf_devolucao_avariada','nf_devolucao_fornecedor','transferencia_galpao',
    'transferencia_localizacao','emprestimo','reserva_pedido','liberacao_reserva',
    'troca_sku_in','troca_sku_out','ajuste_manual','inventario','inventario_inicial',
    'estorno','cancelamento_nf','swap',
    'ajuste_pick_zerou'
  ));

-- 2. Nova tabela: realocações pendentes por item de pedido
CREATE TABLE siso_pedido_item_realocacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_item_id bigint NOT NULL REFERENCES siso_pedido_itens(id) ON DELETE CASCADE,
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  quantidade integer NOT NULL CHECK (quantidade > 0),
  is_emprestimo boolean NOT NULL DEFAULT false,
  empresa_devedora_id uuid REFERENCES siso_empresas(id),
  status text NOT NULL DEFAULT 'aguardando_picking'
    CHECK (status IN ('aguardando_picking','picado','cancelado')),
  motivo text NOT NULL DEFAULT 'loc_zerou',
  criado_em timestamptz NOT NULL DEFAULT now(),
  criado_por uuid REFERENCES siso_usuarios(id),
  picado_em timestamptz,
  picado_por uuid REFERENCES siso_usuarios(id),
  mov_saida_id uuid REFERENCES siso_movimentacoes(id),
  CHECK (
    (is_emprestimo = true AND empresa_devedora_id IS NOT NULL)
    OR (is_emprestimo = false AND empresa_devedora_id IS NULL)
  )
);

CREATE INDEX idx_realoc_pedido_item ON siso_pedido_item_realocacoes(pedido_item_id);
CREATE INDEX idx_realoc_status_aguardando
  ON siso_pedido_item_realocacoes(pedido_item_id, status)
  WHERE status = 'aguardando_picking';

-- 3. Novas colunas em siso_pedido_itens
ALTER TABLE siso_pedido_itens
  ADD COLUMN quantidade_pega integer,
  ADD COLUMN separacao_parcial boolean NOT NULL DEFAULT false,
  ADD COLUMN parcial_motivo text,
  ADD COLUMN parcial_em timestamptz,
  ADD COLUMN parcial_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN mov_saida_id uuid REFERENCES siso_movimentacoes(id),
  ADD COLUMN mov_ajuste_loc_zerou_id uuid REFERENCES siso_movimentacoes(id);

-- 4. Novo status em siso_pedidos.status_separacao: pendente_realocacao
ALTER TABLE siso_pedidos
  DROP CONSTRAINT IF EXISTS siso_pedidos_status_separacao_check;

ALTER TABLE siso_pedidos
  ADD CONSTRAINT siso_pedidos_status_separacao_check
  CHECK (status_separacao IS NULL OR status_separacao IN (
    'aguardando_compra','aguardando_nf','aguardando_separacao',
    'em_separacao','separado','embalado','expedido',
    'pendente_realocacao'
  ));

COMMIT;
