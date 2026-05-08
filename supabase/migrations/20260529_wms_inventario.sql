-- WMS Plano 4 — Inventário robusto multi-operador
-- Spec: docs/superpowers/specs/2026-05-07-wms-design.md §3.10-3.14, 5.7
-- Plano: docs/superpowers/plans/2026-05-29-wms-4-inventario.md

BEGIN;

-- 1. Sessões de inventário (cycle_count ou completo)
CREATE TABLE IF NOT EXISTS siso_inventario_sessoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('cycle_count','completo')),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  empresa_dona_id uuid REFERENCES siso_empresas(id),
  modo_contagem text NOT NULL DEFAULT 'blind' CHECK (modo_contagem IN ('aberto','blind','duplo_blind')),
  tolerancia_pct numeric NOT NULL DEFAULT 2.0 CHECK (tolerancia_pct >= 0),
  tolerancia_qty_min numeric NOT NULL DEFAULT 0 CHECK (tolerancia_qty_min >= 0),
  exige_aprovacao_acima_valor numeric DEFAULT 1000,
  status text NOT NULL DEFAULT 'planejada' CHECK (status IN (
    'planejada','em_andamento','revisao','aprovada','aplicada','cancelada'
  )),
  programada_para date,
  iniciada_em timestamptz,
  finalizada_em timestamptz,
  aplicada_em timestamptz,
  criada_por uuid NOT NULL REFERENCES siso_usuarios(id),
  aprovada_por uuid REFERENCES siso_usuarios(id),
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_sessoes_status ON siso_inventario_sessoes(status, galpao_id);
CREATE INDEX IF NOT EXISTS idx_inv_sessoes_galpao ON siso_inventario_sessoes(galpao_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_inv_sessoes_ativas ON siso_inventario_sessoes(galpao_id) WHERE status = 'em_andamento';

-- 2. Áreas de uma sessão (uma área = um operador)
CREATE TABLE IF NOT EXISTS siso_inventario_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  nome text NOT NULL,
  operador_id uuid REFERENCES siso_usuarios(id),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','em_andamento','concluida')),
  iniciada_em timestamptz,
  finalizada_em timestamptz,
  UNIQUE(sessao_id, nome)
);

CREATE INDEX IF NOT EXISTS idx_inv_areas_sessao ON siso_inventario_areas(sessao_id, status);
CREATE INDEX IF NOT EXISTS idx_inv_areas_operador ON siso_inventario_areas(operador_id) WHERE status = 'em_andamento';

-- 3. Localizações da sessão (com bloqueio por operador)
CREATE TABLE IF NOT EXISTS siso_inventario_localizacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  area_id uuid NOT NULL REFERENCES siso_inventario_areas(id) ON DELETE CASCADE,
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente','em_contagem','contada','divergente','recontagem','aprovada'
  )),
  bloqueada_por uuid REFERENCES siso_usuarios(id),
  bloqueada_em timestamptz,
  UNIQUE(sessao_id, localizacao_id)
);

CREATE INDEX IF NOT EXISTS idx_inv_loc_sessao ON siso_inventario_localizacoes(sessao_id, status);
CREATE INDEX IF NOT EXISTS idx_inv_loc_area ON siso_inventario_localizacoes(area_id, status);
CREATE INDEX IF NOT EXISTS idx_inv_loc_bloqueada
  ON siso_inventario_localizacoes(bloqueada_por, bloqueada_em)
  WHERE bloqueada_em IS NOT NULL;

-- 4. Contagens individuais (cada bipe)
CREATE TABLE IF NOT EXISTS siso_inventario_contagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  qty_contada numeric NOT NULL CHECK (qty_contada >= 0),
  rodada smallint NOT NULL DEFAULT 1 CHECK (rodada >= 1),
  contada_por uuid NOT NULL REFERENCES siso_usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_cont_sessao ON siso_inventario_contagens(sessao_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_inv_cont_loc ON siso_inventario_contagens(sessao_id, localizacao_id, rodada);
CREATE INDEX IF NOT EXISTS idx_inv_cont_operador ON siso_inventario_contagens(contada_por, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_inv_cont_quadrupla
  ON siso_inventario_contagens(sessao_id, localizacao_id, produto_id, empresa_dona_id, rodada);

-- 5. Divergências (saldo sistema vs contagem final)
CREATE TABLE IF NOT EXISTS siso_inventario_divergencias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  saldo_sistema numeric NOT NULL,
  qty_contada_final numeric NOT NULL,
  delta numeric GENERATED ALWAYS AS (qty_contada_final - saldo_sistema) STORED,
  delta_pct numeric GENERATED ALWAYS AS (
    CASE WHEN saldo_sistema = 0 THEN NULL
         ELSE ROUND((qty_contada_final - saldo_sistema) / saldo_sistema * 100, 4)
    END
  ) STORED,
  valor_financeiro numeric,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente','recontagem_solicitada','aprovada','rejeitada','aplicada'
  )),
  resolucao_por uuid REFERENCES siso_usuarios(id),
  resolucao_em timestamptz,
  observacoes_resolucao text,
  mov_aplicada_id uuid REFERENCES siso_movimentacoes(id),
  UNIQUE(sessao_id, localizacao_id, produto_id, empresa_dona_id)
);

CREATE INDEX IF NOT EXISTS idx_inv_div_sessao ON siso_inventario_divergencias(sessao_id, status);
CREATE INDEX IF NOT EXISTS idx_inv_div_status ON siso_inventario_divergencias(status, sessao_id);
CREATE INDEX IF NOT EXISTS idx_inv_div_aprovacao ON siso_inventario_divergencias(sessao_id) WHERE status = 'pendente';

-- 6. RPC: pega próxima localização atomicamente (anti-colisão entre operadores)
CREATE OR REPLACE FUNCTION wms_inventario_pegar_localizacao(
  p_sessao uuid, p_localizacao uuid, p_user uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE siso_inventario_localizacoes
  SET bloqueada_por = p_user, bloqueada_em = now(), status = 'em_contagem'
  WHERE sessao_id = p_sessao
    AND localizacao_id = p_localizacao
    AND bloqueada_por IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'localização já está sendo contada por outro operador ou status inválido';
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- 7. Realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='siso_inventario_contagens'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE siso_inventario_contagens';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='siso_inventario_localizacoes'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE siso_inventario_localizacoes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='siso_inventario_areas'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE siso_inventario_areas';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='siso_inventario_divergencias'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE siso_inventario_divergencias';
  END IF;
END $$;

COMMIT;
