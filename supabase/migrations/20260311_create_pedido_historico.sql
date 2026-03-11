-- Audit trail for orders. Every status transition and significant action
-- is recorded as an immutable event row.
CREATE TABLE IF NOT EXISTS siso_pedido_historico (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id text NOT NULL REFERENCES siso_pedidos(id) ON DELETE CASCADE,
  evento text NOT NULL,
  usuario_id uuid REFERENCES siso_usuarios(id),
  usuario_nome text,
  detalhes jsonb DEFAULT '{}',
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Fast lookups by pedido (timeline view)
CREATE INDEX idx_pedido_historico_pedido
  ON siso_pedido_historico (pedido_id, criado_em ASC);

-- Possible event values (documented, not enforced via CHECK for flexibility):
--   recebido           — webhook received, order created
--   auto_aprovado      — auto-approved (propria, no human review)
--   aprovado           — manually approved by operator
--   aguardando_nf      — waiting for NF authorization
--   nf_autorizada      — NF authorized via webhook or manual override
--   aguardando_separacao — ready for separation
--   separacao_iniciada — separation started (wave picking)
--   item_separado      — individual item checked in separation
--   separacao_concluida — all items separated
--   embalagem_iniciada — packing started
--   item_embalado      — individual item scanned/confirmed in packing
--   embalagem_concluida — all items packed
--   etiqueta_impressa  — shipping label printed
--   etiqueta_falhou    — label print failed
--   cancelado          — order cancelled
--   erro               — processing error

COMMENT ON TABLE siso_pedido_historico
  IS 'Immutable audit trail of order lifecycle events';
