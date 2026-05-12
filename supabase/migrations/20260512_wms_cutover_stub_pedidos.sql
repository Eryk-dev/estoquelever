-- ─── WMS Cutover (Plano 2): tabela auxiliar pra Tiny stub em staging ──────────
-- Armazena payloads Tiny-shape de pedidos sintéticos pra que o stub do Tiny
-- consiga responder GET /pedidos/{id} sem chamar a API real.
--
-- Uso: scripts/wms/seed-staging.ts popula essa tabela com cenários de teste;
-- src/lib/tiny-stub.ts lê dela quando TINY_DISABLED=true.
--
-- Idempotente, aditiva, segura pra prod (tabela só é populada em staging).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siso_stub_pedidos (
  id text PRIMARY KEY,                       -- mesmo ID que o Tiny usaria
  empresa_id uuid NOT NULL REFERENCES siso_empresas(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,                    -- TinyPedidoRaw shape (numeroPedido, data, cliente, ecommerce, itens, etc.)
  cenario text,                              -- 'propria-auto' | 'transferencia' | 'oc' | 'cancel-pre' | ...
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS siso_stub_pedidos_empresa_idx
  ON siso_stub_pedidos(empresa_id);

CREATE INDEX IF NOT EXISTS siso_stub_pedidos_cenario_idx
  ON siso_stub_pedidos(cenario);

COMMENT ON TABLE siso_stub_pedidos IS
  'Pedidos sintéticos Tiny-shape para o stub TINY_DISABLED. Staging-only — em prod fica vazia.';
