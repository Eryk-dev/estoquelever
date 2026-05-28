-- Decisão 7+9 (28/05): pendência de guarda ganha 3 colunas pra cross-dock.
-- prioridade='cross_dock' faz UI render badge verde no topo da fila;
-- pedidos_vinculados[] guarda os pedidos que o batch fecha quando guardado
-- em loc PACKING; destino_sugerido_id pré-preenche a PACKING-{galpao} no
-- form do tablet.

ALTER TABLE siso_wms_pendencias_guarda
  ADD COLUMN IF NOT EXISTS prioridade text NOT NULL DEFAULT 'normal'
    CHECK (prioridade IN ('normal','cross_dock')),
  ADD COLUMN IF NOT EXISTS pedidos_vinculados text[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS destino_sugerido_id uuid REFERENCES siso_localizacoes(id);

-- Nota: pedidos_vinculados é text[] porque siso_pedidos.id é text (Tiny pedido_id como número string ou MAN-... pra venda manual).

CREATE INDEX IF NOT EXISTS idx_pendencia_prioridade
  ON siso_wms_pendencias_guarda(prioridade, status, criada_em)
  WHERE status IN ('pendente','em_guarda');
