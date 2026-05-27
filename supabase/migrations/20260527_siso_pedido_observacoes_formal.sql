-- Finding 1.13: siso_pedido_observacoes existia em prod via SQL direto.
-- Formalizamos com CREATE TABLE IF NOT EXISTS. Schema espelha o que já
-- está em staging (project_id ehbxpbeijofxtsbezwxd). Idempotente.
--
-- Notas de fidelidade ao estado existente (descoberto via information_schema):
--   - usuario_id FK em staging está como ON DELETE SET NULL (apesar do NOT NULL).
--     Mantemos esse comportamento aqui para idempotência — corrigir essa
--     incoerência fica para uma migration futura dedicada.
--   - O índice (pedido_id, criado_em) já existe como `idx_pedido_observacoes_pedido`.
--     Reusamos esse nome para evitar criar índice duplicado.

CREATE TABLE IF NOT EXISTS siso_pedido_observacoes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id    text        NOT NULL REFERENCES siso_pedidos(id) ON DELETE CASCADE,
  usuario_id   uuid        NOT NULL REFERENCES siso_usuarios(id) ON DELETE SET NULL,
  usuario_nome text        NOT NULL,
  texto        text        NOT NULL,
  criado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pedido_observacoes_pedido
  ON siso_pedido_observacoes (pedido_id, criado_em);

CREATE INDEX IF NOT EXISTS siso_pedido_observacoes_usuario_idx
  ON siso_pedido_observacoes (usuario_id);

-- Comment para futuras gerações de docs
COMMENT ON TABLE siso_pedido_observacoes IS
  'Comentários livres por pedido (formalizado via migration 20260527 — finding 1.13)';
