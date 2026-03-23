-- =============================================
-- Módulo Inventário
-- =============================================

CREATE TABLE siso_inventarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id       uuid NOT NULL REFERENCES siso_galpoes(id),
  usuario_id      uuid NOT NULL REFERENCES siso_usuarios(id),
  deposito_id     int,
  modo            text NOT NULL CHECK (modo IN ('loc_only', 'loc_estoque')),
  tipo_estoque    text CHECK (tipo_estoque IN ('B', 'E', 'S')),
  manter_localizacao_antiga boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'em_andamento'
                  CHECK (status IN ('em_andamento', 'processando', 'concluido', 'cancelado', 'erro', 'revertendo', 'revertido')),
  observacoes     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processado_em   timestamptz,
  concluido_em    timestamptz
);

CREATE TABLE siso_inventario_itens (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventario_id           uuid NOT NULL REFERENCES siso_inventarios(id) ON DELETE CASCADE,
  produto_id_tiny         int,
  sku                     text NOT NULL,
  nome_produto            text,
  ean                     text,
  localizacao             text NOT NULL,
  quantidade              int NOT NULL DEFAULT 1,
  status                  text NOT NULL DEFAULT 'pendente'
                          CHECK (status IN ('pendente', 'processando', 'sucesso', 'erro')),
  erro_msg                text,
  localizacao_antiga_tiny text,       -- preenchido no processamento, antes de atualizar
  saldo_anterior_tiny     numeric,    -- preenchido no processamento, antes de movimentar (tipo B)
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventarios_status ON siso_inventarios(status);
CREATE INDEX idx_inventarios_empresa ON siso_inventarios(empresa_id);
CREATE INDEX idx_inventarios_usuario ON siso_inventarios(usuario_id);
CREATE INDEX idx_inventario_itens_inv ON siso_inventario_itens(inventario_id);
CREATE INDEX idx_inventario_itens_sku ON siso_inventario_itens(inventario_id, sku);

-- =============================================
-- Módulo Transferência de Estoque
-- =============================================

CREATE TABLE siso_transferencias (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_origem_id   uuid NOT NULL REFERENCES siso_empresas(id),
  empresa_destino_id  uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_origem_id    uuid NOT NULL REFERENCES siso_galpoes(id),
  galpao_destino_id   uuid NOT NULL REFERENCES siso_galpoes(id),
  usuario_id          uuid NOT NULL REFERENCES siso_usuarios(id),
  deposito_origem_id  int,
  deposito_destino_id int,
  status              text NOT NULL DEFAULT 'em_andamento'
                      CHECK (status IN ('em_andamento', 'processando', 'concluido', 'cancelado', 'erro', 'revertendo', 'revertido')),
  observacoes         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  processado_em       timestamptz,
  concluido_em        timestamptz
);

CREATE TABLE siso_transferencia_itens (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transferencia_id        uuid NOT NULL REFERENCES siso_transferencias(id) ON DELETE CASCADE,
  produto_id_tiny_origem  int NOT NULL,
  produto_id_tiny_destino int,           -- preenchido no processamento
  sku                     text NOT NULL,
  nome_produto            text,
  ean                     text,
  quantidade              int NOT NULL DEFAULT 1,
  clonado                 boolean NOT NULL DEFAULT false,
  status                  text NOT NULL DEFAULT 'pendente'
                          CHECK (status IN ('pendente', 'processando', 'sucesso', 'erro')),
  erro_msg                text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transferencias_status ON siso_transferencias(status);
CREATE INDEX idx_transferencias_empresa_o ON siso_transferencias(empresa_origem_id);
CREATE INDEX idx_transferencias_empresa_d ON siso_transferencias(empresa_destino_id);
CREATE INDEX idx_transferencias_usuario ON siso_transferencias(usuario_id);
CREATE INDEX idx_transferencia_itens_tr ON siso_transferencia_itens(transferencia_id);
