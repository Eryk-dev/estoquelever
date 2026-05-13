-- WMS — Recebimento em 2 etapas (Recebimento + Guarda)
-- Spec: conversa de brainstorming 2026-05-13
--
-- Mudança de fluxo: o recebimento agora grava na localização tipo='recebimento'
-- (dock de chegada) e cria pendências de guarda. A guarda física vira uma etapa
-- separada (tela tablet) onde o operador imprime etiquetas, bipa a loc destino
-- e registra mov de replenishment_intra (RECEBIMENTO → loc final). Tudo
-- rastreado em siso_wms_pendencias_guarda (1 linha por linha de recebimento).

BEGIN;

-- 1. Impressora de produto separada (etiqueta de produto ≠ etiqueta de envio).
--    Fallback no resolver: se _produto vazio, cai pro _printer_id genérico.
ALTER TABLE siso_galpoes
  ADD COLUMN IF NOT EXISTS printnode_printer_id_produto bigint,
  ADD COLUMN IF NOT EXISTS printnode_printer_nome_produto text;

ALTER TABLE siso_usuarios
  ADD COLUMN IF NOT EXISTS printnode_printer_id_produto bigint,
  ADD COLUMN IF NOT EXISTS printnode_printer_nome_produto text;

COMMENT ON COLUMN siso_galpoes.printnode_printer_id_produto IS
  'Impressora térmica dedicada pra etiquetas de produto (recebimento). NULL = usa printnode_printer_id (mesma da etiqueta de envio).';
COMMENT ON COLUMN siso_usuarios.printnode_printer_id_produto IS
  'Override por operador da impressora de etiqueta de produto. Prioridade: user._produto > galpao._produto > user._printer_id > galpao._printer_id.';

-- 2. Garante 1 loc tipo='recebimento' ativa por galpão.
--    Códigos preferidos: RECEBIMENTO, DOCK, ENTRADA. Se nenhum existe, cria
--    "RECEBIMENTO" como default. Idempotente — pode rodar várias vezes.
INSERT INTO siso_localizacoes (galpao_id, codigo, descricao, tipo, ativo)
SELECT g.id, 'RECEBIMENTO', 'Área de chegada (auto-criada pra fluxo de guarda)', 'recebimento', true
FROM siso_galpoes g
WHERE g.ativo = true
  AND NOT EXISTS (
    SELECT 1 FROM siso_localizacoes l
    WHERE l.galpao_id = g.id AND l.tipo = 'recebimento' AND l.ativo = true
  );

-- 3. Tabela de pendências de guarda.
--    1 linha por linha de recebimento (rastreio fino por NF/lote).
--    qty_pendente é coluna GENERATED — não pode ser escrita direto.
--    Status: pendente → em_guarda (operador iniciou) → guardada (qty_pendente=0)
--           ou cancelada (peça sumiu, devolveu fornecedor, etc).
CREATE TABLE IF NOT EXISTS siso_wms_pendencias_guarda (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  localizacao_origem_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  mov_entrada_id uuid NOT NULL REFERENCES siso_movimentacoes(id),
  nf_referencia text,
  origem_tipo text NOT NULL,
  custo_unitario numeric(14,4),
  qty_inicial numeric(14,4) NOT NULL CHECK (qty_inicial > 0),
  qty_guardada numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_guardada >= 0),
  qty_pendente numeric(14,4) GENERATED ALWAYS AS (qty_inicial - qty_guardada) STORED,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','em_guarda','guardada','cancelada')),
  iniciada_em timestamptz,
  iniciada_por uuid REFERENCES siso_usuarios(id),
  guardada_em timestamptz,
  cancelada_em timestamptz,
  cancelada_por uuid REFERENCES siso_usuarios(id),
  motivo_cancelamento text,
  observacoes text,
  criada_em timestamptz NOT NULL DEFAULT now(),
  atualizada_em timestamptz NOT NULL DEFAULT now(),
  CHECK (qty_guardada <= qty_inicial),
  CHECK (
    (status = 'guardada' AND qty_guardada = qty_inicial AND guardada_em IS NOT NULL)
    OR status <> 'guardada'
  ),
  CHECK (
    (status = 'cancelada' AND cancelada_em IS NOT NULL)
    OR status <> 'cancelada'
  )
);

CREATE INDEX IF NOT EXISTS idx_pendencias_guarda_fila
  ON siso_wms_pendencias_guarda(galpao_id, status, criada_em)
  WHERE status IN ('pendente','em_guarda');

CREATE INDEX IF NOT EXISTS idx_pendencias_guarda_mov
  ON siso_wms_pendencias_guarda(mov_entrada_id);

CREATE INDEX IF NOT EXISTS idx_pendencias_guarda_produto
  ON siso_wms_pendencias_guarda(produto_id, empresa_dona_id, galpao_id);

-- Trigger pra atualizar atualizada_em a cada UPDATE.
CREATE OR REPLACE FUNCTION siso_wms_pendencias_guarda_touch()
RETURNS trigger AS $$
BEGIN
  NEW.atualizada_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pendencias_guarda_touch ON siso_wms_pendencias_guarda;
CREATE TRIGGER trg_pendencias_guarda_touch
  BEFORE UPDATE ON siso_wms_pendencias_guarda
  FOR EACH ROW EXECUTE FUNCTION siso_wms_pendencias_guarda_touch();

COMMENT ON TABLE siso_wms_pendencias_guarda IS
  'Fila de pendências de put-away. Criada pelo POST /api/wms/receber. Consumida pela tela /wms/guarda (tablet). Quando qty_pendente=0 vira status=guardada. Cancelamento explícito quando peça some/devolve.';

COMMIT;
