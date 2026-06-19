-- Cross — caderno único de equivalência (cross + troca)
-- Spec: docs/superpowers/specs/2026-06-19-cross-redesign-design.md §3
-- Plano: docs/superpowers/plans/2026-06-19-cross-nucleo.md

BEGIN;

CREATE TABLE IF NOT EXISTS siso_cross_equivalencias (
  id          bigserial PRIMARY KEY,
  sku_a       text NOT NULL REFERENCES siso_produtos(sku) ON DELETE CASCADE,
  sku_b       text NOT NULL REFERENCES siso_produtos(sku) ON DELETE CASCADE,
  relacao     text NOT NULL DEFAULT 'equivalente' CHECK (relacao IN ('equivalente')),
  status      text NOT NULL DEFAULT 'sugestao' CHECK (status IN ('sugestao','confirmado','bloqueado')),
  fonte       text NOT NULL DEFAULT 'manual',
  observacao  text,
  criado_por  uuid REFERENCES siso_usuarios(id),
  criado_em   timestamptz NOT NULL DEFAULT now(),
  decidido_por uuid REFERENCES siso_usuarios(id),
  decidido_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (sku_a < sku_b),
  UNIQUE (sku_a, sku_b)
);

CREATE INDEX IF NOT EXISTS idx_cross_eq_sku_a  ON siso_cross_equivalencias(sku_a);
CREATE INDEX IF NOT EXISTS idx_cross_eq_sku_b  ON siso_cross_equivalencias(sku_b);
CREATE INDEX IF NOT EXISTS idx_cross_eq_status ON siso_cross_equivalencias(status);

COMMIT;
