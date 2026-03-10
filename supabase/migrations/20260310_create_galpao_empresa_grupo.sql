-- ============================================================
-- Migration: Galpao / Empresa / Grupo hierarchy
-- Phase 1: Create new tables + seed existing data + add FKs
-- Applied via Supabase MCP on 2026-03-10
-- ============================================================

-- 1. New tables
CREATE TABLE siso_galpoes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nome text UNIQUE NOT NULL,
  descricao text,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE siso_empresas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nome text NOT NULL,
  cnpj text UNIQUE NOT NULL,
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_empresas_galpao ON siso_empresas (galpao_id);
CREATE INDEX idx_empresas_cnpj ON siso_empresas (cnpj);

CREATE TABLE siso_grupos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nome text UNIQUE NOT NULL,
  descricao text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE siso_grupo_empresas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  grupo_id uuid NOT NULL REFERENCES siso_grupos(id) ON DELETE CASCADE,
  empresa_id uuid NOT NULL REFERENCES siso_empresas(id) ON DELETE CASCADE,
  tier integer NOT NULL DEFAULT 1 CHECK (tier > 0),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_grupo_empresa UNIQUE (empresa_id)
);
CREATE INDEX idx_grupo_empresas_grupo ON siso_grupo_empresas (grupo_id);

-- 2. Seed existing data
INSERT INTO siso_galpoes (nome, descricao) VALUES
  ('CWB', 'Galpão Curitiba'),
  ('SP', 'Galpão São Paulo');

INSERT INTO siso_empresas (nome, cnpj, galpao_id) VALUES
  ('NetAir', '34857388000163', (SELECT id FROM siso_galpoes WHERE nome = 'CWB')),
  ('NetParts', '34857388000244', (SELECT id FROM siso_galpoes WHERE nome = 'SP'));

INSERT INTO siso_grupos (nome, descricao) VALUES
  ('Autopeças', 'Grupo de empresas de autopeças');

INSERT INTO siso_grupo_empresas (grupo_id, empresa_id, tier) VALUES
  ((SELECT id FROM siso_grupos WHERE nome = 'Autopeças'),
   (SELECT id FROM siso_empresas WHERE cnpj = '34857388000163'), 1),
  ((SELECT id FROM siso_grupos WHERE nome = 'Autopeças'),
   (SELECT id FROM siso_empresas WHERE cnpj = '34857388000244'), 1);

-- 3. Add empresa_id to existing tables
ALTER TABLE siso_tiny_connections ADD COLUMN empresa_id uuid REFERENCES siso_empresas(id);
UPDATE siso_tiny_connections tc SET empresa_id = e.id
  FROM siso_empresas e WHERE e.cnpj = tc.cnpj;
CREATE INDEX idx_tiny_connections_empresa ON siso_tiny_connections (empresa_id);

ALTER TABLE siso_pedidos ADD COLUMN empresa_origem_id uuid REFERENCES siso_empresas(id);
UPDATE siso_pedidos p SET empresa_origem_id = e.id
  FROM siso_empresas e JOIN siso_galpoes g ON g.id = e.galpao_id
  WHERE g.nome = p.filial_origem::text AND e.nome IN ('NetAir', 'NetParts');

ALTER TABLE siso_webhook_logs ADD COLUMN empresa_id uuid REFERENCES siso_empresas(id);
UPDATE siso_webhook_logs wl SET empresa_id = e.id
  FROM siso_empresas e WHERE e.cnpj = wl.cnpj;

ALTER TABLE siso_api_calls ADD COLUMN empresa_id uuid REFERENCES siso_empresas(id);
UPDATE siso_api_calls ac SET empresa_id = e.id
  FROM siso_empresas e JOIN siso_galpoes g ON g.id = e.galpao_id
  WHERE g.nome = ac.filial AND e.nome IN ('NetAir', 'NetParts');
CREATE INDEX idx_api_calls_empresa ON siso_api_calls (empresa_id, called_at DESC);

ALTER TABLE siso_pedido_itens ADD COLUMN empresa_deducao_id uuid REFERENCES siso_empresas(id);

-- 4. Create siso_fila_execucao (with both legacy filial and new empresa_id)
CREATE TABLE IF NOT EXISTS siso_fila_execucao (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id text NOT NULL,
  tipo text NOT NULL DEFAULT 'lancar_estoque',
  filial_execucao text,
  empresa_id uuid REFERENCES siso_empresas(id),
  decisao text NOT NULL,
  status text NOT NULL DEFAULT 'pendente',
  tentativas integer DEFAULT 0,
  max_tentativas integer DEFAULT 3,
  erro text,
  operador_id text,
  operador_nome text,
  executado_em timestamptz,
  proximo_retry_em timestamptz,
  criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now(),
  CONSTRAINT chk_fila_tipo CHECK (tipo IN ('lancar_estoque')),
  CONSTRAINT chk_fila_decisao CHECK (decisao IN ('propria', 'transferencia', 'oc')),
  CONSTRAINT chk_fila_status CHECK (status IN ('pendente', 'executando', 'concluido', 'erro', 'cancelado'))
);
CREATE INDEX IF NOT EXISTS idx_fila_status_retry ON siso_fila_execucao (status, proximo_retry_em) WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS idx_fila_pedido ON siso_fila_execucao (pedido_id);
CREATE INDEX IF NOT EXISTS idx_fila_empresa ON siso_fila_execucao (empresa_id);

-- 5. Normalized stock per empresa
CREATE TABLE siso_pedido_item_estoques (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id text NOT NULL,
  produto_id bigint NOT NULL,
  empresa_id uuid NOT NULL REFERENCES siso_empresas(id),
  deposito_id integer,
  deposito_nome text,
  saldo numeric DEFAULT 0,
  reservado numeric DEFAULT 0,
  disponivel numeric DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_item_estoques_unique ON siso_pedido_item_estoques (pedido_id, produto_id, empresa_id);
CREATE INDEX idx_item_estoques_pedido ON siso_pedido_item_estoques (pedido_id);
