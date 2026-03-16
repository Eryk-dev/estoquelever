-- Dedicated error tracking table for SISO
-- Richer structure than siso_logs for diagnostics and resolution tracking

CREATE TABLE IF NOT EXISTS siso_erros (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp timestamptz DEFAULT now() NOT NULL,

  -- Classification
  source text NOT NULL,
  category text NOT NULL DEFAULT 'unknown'
    CHECK (category IN (
      'validation',      -- bad input, missing fields
      'database',        -- supabase query failures
      'external_api',    -- Tiny ERP, PrintNode failures
      'auth',            -- token/session issues
      'config',          -- missing config (PrintNode key, deposito, etc)
      'business_logic',  -- stock insufficient, no empresa found, etc
      'infrastructure',  -- rate limit, timeout, network
      'unknown'
    )),
  severity text NOT NULL DEFAULT 'error'
    CHECK (severity IN ('warning', 'error', 'critical')),

  -- Error details
  message text NOT NULL,
  stack_trace text,
  error_code text,

  -- Context
  pedido_id text,
  empresa_id uuid,
  empresa_nome text,
  galpao_nome text,

  -- Tracing
  correlation_id text,
  request_path text,
  request_method text,

  -- Structured context
  metadata jsonb DEFAULT '{}',

  -- Resolution tracking
  resolved boolean DEFAULT false,
  resolved_at timestamptz,
  resolved_by text,
  resolution_notes text,

  created_at timestamptz DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_siso_erros_timestamp ON siso_erros (timestamp DESC);
CREATE INDEX idx_siso_erros_source ON siso_erros (source);
CREATE INDEX idx_siso_erros_category ON siso_erros (category);
CREATE INDEX idx_siso_erros_severity ON siso_erros (severity);
CREATE INDEX idx_siso_erros_pedido ON siso_erros (pedido_id) WHERE pedido_id IS NOT NULL;
CREATE INDEX idx_siso_erros_empresa ON siso_erros (empresa_id) WHERE empresa_id IS NOT NULL;
CREATE INDEX idx_siso_erros_correlation ON siso_erros (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_siso_erros_resolved ON siso_erros (resolved) WHERE resolved = false;
CREATE INDEX idx_siso_erros_error_code ON siso_erros (error_code) WHERE error_code IS NOT NULL;

-- Composite index for "recent unresolved errors by source"
CREATE INDEX idx_siso_erros_unresolved_by_source
  ON siso_erros (source, timestamp DESC)
  WHERE resolved = false;
