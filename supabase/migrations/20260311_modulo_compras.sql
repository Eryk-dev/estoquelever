-- ============================================================
-- Migration: Modulo de Compras
-- US-002: siso_ordens_compra table + compra columns on siso_pedido_itens
-- ============================================================

-- 1. Create siso_ordens_compra table
CREATE TABLE siso_ordens_compra (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  fornecedor text NOT NULL,
  empresa_id uuid NOT NULL REFERENCES siso_empresas(id),
  status text NOT NULL DEFAULT 'comprado'
    CHECK (status IN ('aguardando_compra', 'comprado', 'parcialmente_recebido', 'recebido', 'cancelado')),
  observacao text,
  comprado_por uuid REFERENCES siso_usuarios(id),
  comprado_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ordens_compra_status ON siso_ordens_compra (status);
CREATE INDEX idx_ordens_compra_fornecedor ON siso_ordens_compra (fornecedor);

-- 2. Add compra columns to siso_pedido_itens
-- Note: fornecedor_oc already exists from original schema
ALTER TABLE siso_pedido_itens
  ADD COLUMN produto_id_tiny bigint,
  ADD COLUMN ordem_compra_id uuid REFERENCES siso_ordens_compra(id),
  ADD COLUMN compra_status text,
  ADD COLUMN compra_quantidade_recebida int NOT NULL DEFAULT 0,
  ADD COLUMN comprado_em timestamptz,
  ADD COLUMN comprado_por uuid,
  ADD COLUMN recebido_em timestamptz,
  ADD COLUMN recebido_por uuid;

CREATE INDEX idx_pedido_itens_compra_status ON siso_pedido_itens (compra_status) WHERE compra_status IS NOT NULL;
CREATE INDEX idx_pedido_itens_fornecedor_oc ON siso_pedido_itens (fornecedor_oc) WHERE fornecedor_oc IS NOT NULL;
CREATE INDEX idx_pedido_itens_ordem_compra_id ON siso_pedido_itens (ordem_compra_id) WHERE ordem_compra_id IS NOT NULL;

-- 3. Update status_separacao CHECK to include 'aguardando_compra'
ALTER TABLE siso_pedidos DROP CONSTRAINT IF EXISTS siso_pedidos_status_separacao_check;
ALTER TABLE siso_pedidos
  ADD CONSTRAINT siso_pedidos_status_separacao_check
  CHECK (status_separacao IS NULL OR status_separacao IN (
    'aguardando_nf', 'aguardando_separacao', 'em_separacao', 'separado', 'embalado', 'cancelado',
    'aguardando_compra'
  ));
