-- ============================================================
-- Fix-pack realocação cascateável — Foundation
-- Spec: docs/superpowers/specs/2026-05-18-realocacao-cascateavel-fix-pack-design.md
--
-- 1. Tabela ponte siso_pedido_item_mov_links (C3)
-- 2. Coluna siso_movimentacoes.qty_estornada + backfill (pré-req da RPC parcial)
-- 3. Backfill parcial_motivo padronizado (M4)
-- 4. Publication realtime pra realocações (C5)
-- ============================================================

BEGIN;

-- 1. Tabela ponte
CREATE TABLE IF NOT EXISTS siso_pedido_item_mov_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_item_id bigint NOT NULL REFERENCES siso_pedido_itens(id) ON DELETE CASCADE,
  realocacao_id uuid REFERENCES siso_pedido_item_realocacoes(id) ON DELETE CASCADE,
  mov_id uuid NOT NULL REFERENCES siso_movimentacoes(id),
  qty integer NOT NULL CHECK (qty > 0),
  tipo_link text NOT NULL CHECK (tipo_link IN ('saida','ajuste_loc_zerou')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pedido_item_id, realocacao_id, mov_id, tipo_link)
);

CREATE INDEX IF NOT EXISTS idx_mov_links_mov ON siso_pedido_item_mov_links(mov_id);
CREATE INDEX IF NOT EXISTS idx_mov_links_item ON siso_pedido_item_mov_links(pedido_item_id);
CREATE INDEX IF NOT EXISTS idx_mov_links_realoc ON siso_pedido_item_mov_links(realocacao_id) WHERE realocacao_id IS NOT NULL;

-- 2. qty_estornada em siso_movimentacoes
-- Tipo numeric pra compat com siso_movimentacoes.quantidade (kits têm qty fracional).
ALTER TABLE siso_movimentacoes
  ADD COLUMN IF NOT EXISTS qty_estornada numeric NOT NULL DEFAULT 0
  CHECK (qty_estornada >= 0);

-- Backfill: movs que já têm um estorno full → qty_estornada = quantidade.
-- Guarda contra qty_estornada=0 garante idempotência: re-run após estornos
-- parciais reais (Task 1.3) não sobrescreve contadores legítimos.
UPDATE siso_movimentacoes m
   SET qty_estornada = m.quantidade
 WHERE m.qty_estornada = 0
   AND EXISTS (SELECT 1 FROM siso_movimentacoes e WHERE e.estorno_de = m.id);

-- 3. Backfill parcial_motivo (M4)
-- Restrito a valores legados — evita rewrite no-op de linhas já canônicas.
UPDATE siso_pedido_item_realocacoes
   SET parcial_motivo = CASE
     WHEN parcial_motivo = 'cascade_loc_zerou' THEN 'loc_zerou'
     WHEN parcial_motivo = 'cascade_parcial' THEN 'qty_diferente'
     ELSE parcial_motivo
   END
 WHERE parcial = true
   AND parcial_motivo IN ('cascade_loc_zerou','cascade_parcial');

-- 4. Publication realtime
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='siso_pedido_item_realocacoes'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE siso_pedido_item_realocacoes';
  END IF;
END $$;

COMMIT;
