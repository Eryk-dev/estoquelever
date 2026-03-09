-- Migration: create siso_logs table
-- Used by src/lib/logger.ts for structured application logging

CREATE TABLE IF NOT EXISTS siso_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp timestamptz DEFAULT now() NOT NULL,
  level text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  source text NOT NULL,  -- e.g., 'webhook', 'oauth', 'processor', 'api'
  message text NOT NULL,
  metadata jsonb DEFAULT '{}',
  pedido_id text,        -- optional reference to order
  filial text,           -- optional branch reference
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_siso_logs_timestamp ON siso_logs (timestamp DESC);
CREATE INDEX idx_siso_logs_level ON siso_logs (level);
CREATE INDEX idx_siso_logs_source ON siso_logs (source);
CREATE INDEX idx_siso_logs_pedido ON siso_logs (pedido_id) WHERE pedido_id IS NOT NULL;
