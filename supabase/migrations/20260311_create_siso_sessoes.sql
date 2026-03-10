-- ============================================================
-- Migration: Server-side sessions table
-- Applied via Supabase MCP on 2026-03-11
-- ============================================================

CREATE TABLE siso_sessoes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  usuario_id uuid NOT NULL REFERENCES siso_usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL DEFAULT now() + interval '12 hours'
);

-- Regular index on expira_em (partial index with now() not possible — now() is STABLE, not IMMUTABLE)
CREATE INDEX idx_sessoes_expira ON siso_sessoes (expira_em);
