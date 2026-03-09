-- Migration: execution queue + API rate limit tracking
-- Used by the execution worker to process approved orders sequentially
-- and respect Tiny API rate limits (60 req/min per account)

-- ─── Execution Queue ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siso_fila_execucao (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id text NOT NULL,
  tipo text NOT NULL DEFAULT 'lancar_estoque',
  filial_execucao text NOT NULL,
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
  CONSTRAINT chk_fila_filial CHECK (filial_execucao IN ('CWB', 'SP')),
  CONSTRAINT chk_fila_decisao CHECK (decisao IN ('propria', 'transferencia', 'oc')),
  CONSTRAINT chk_fila_status CHECK (status IN ('pendente', 'executando', 'concluido', 'erro', 'cancelado'))
);

CREATE INDEX idx_fila_status_retry ON siso_fila_execucao (status, proximo_retry_em)
  WHERE status = 'pendente';
CREATE INDEX idx_fila_pedido ON siso_fila_execucao (pedido_id);

-- ─── API Rate Limit Tracking ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siso_api_calls (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  filial text NOT NULL,
  endpoint text,
  called_at timestamptz DEFAULT now()
);

CREATE INDEX idx_api_calls_rate ON siso_api_calls (filial, called_at DESC);
