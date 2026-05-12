-- WMS Inventário — Rewrite v2: pull queue + slots de operador + sugestão inteligente
--
-- Mudança fundamental: dropamos a divisão estática por "área" (que causava
-- operador ocioso) e passamos a um modelo de pool compartilhado. Operadores
-- assumem um "slot" (OP1-OP5) e puxam a próxima localização sob demanda,
-- com anti-colisão por zona e priorização geográfica.
--
-- IMPORTANTE: como estava em staging, NÃO preservamos dados das sessões antigas.

BEGIN;

------------------------------------------------------------------------------
-- 1. Limpeza: drop o que não vamos mais usar
------------------------------------------------------------------------------

-- A RPC antiga recebia um localizacao_id específico — agora a nova é "puxar próxima"
DROP FUNCTION IF EXISTS wms_inventario_pegar_localizacao(uuid, uuid, uuid);

-- A tabela de áreas é o coração da divisão estática — fora
DROP TABLE IF EXISTS siso_inventario_areas CASCADE;

------------------------------------------------------------------------------
-- 2. Ajustes em siso_localizacoes (catálogo de locs do galpão)
------------------------------------------------------------------------------

ALTER TABLE siso_localizacoes
  ADD COLUMN IF NOT EXISTS ultima_contagem_em timestamptz,
  ADD COLUMN IF NOT EXISTS zona text;

CREATE INDEX IF NOT EXISTS idx_loc_ultima_contagem
  ON siso_localizacoes(galpao_id, ultima_contagem_em NULLS FIRST)
  WHERE ativo;

CREATE INDEX IF NOT EXISTS idx_loc_zona
  ON siso_localizacoes(galpao_id, zona)
  WHERE ativo AND zona IS NOT NULL;

------------------------------------------------------------------------------
-- 3. siso_inventario_sessoes: pequenos ajustes
------------------------------------------------------------------------------

-- Adiciona nome (frontend já referenciava com ??)
ALTER TABLE siso_inventario_sessoes
  ADD COLUMN IF NOT EXISTS nome text,
  ADD COLUMN IF NOT EXISTS tamanho_pool int;

-- Tira duplo_blind do CHECK (não usamos mais — sem recontagem mid-flow)
ALTER TABLE siso_inventario_sessoes
  DROP CONSTRAINT IF EXISTS siso_inventario_sessoes_modo_contagem_check;

ALTER TABLE siso_inventario_sessoes
  ADD CONSTRAINT siso_inventario_sessoes_modo_contagem_check
  CHECK (modo_contagem IN ('aberto','blind'));

-- Garante default blind (já era)
ALTER TABLE siso_inventario_sessoes
  ALTER COLUMN modo_contagem SET DEFAULT 'blind';

------------------------------------------------------------------------------
-- 4. siso_inventario_localizacoes: pool de locs da sessão (sem area_id)
------------------------------------------------------------------------------

-- Drop FK + coluna de área
ALTER TABLE siso_inventario_localizacoes
  DROP COLUMN IF EXISTS area_id;

-- Status: tira 'recontagem' (não tem mais recontagem mid-flow)
ALTER TABLE siso_inventario_localizacoes
  DROP CONSTRAINT IF EXISTS siso_inventario_localizacoes_status_check;

ALTER TABLE siso_inventario_localizacoes
  ADD CONSTRAINT siso_inventario_localizacoes_status_check
  CHECK (status IN ('pendente','em_contagem','contada','divergente','aprovada'));

-- Adiciona motivo da seleção (vindo da sugestão inteligente, ou 'manual'/'completo')
ALTER TABLE siso_inventario_localizacoes
  ADD COLUMN IF NOT EXISTS motivo text;

-- Adiciona timestamps de início/fim da contagem (pra calcular tempo médio)
ALTER TABLE siso_inventario_localizacoes
  ADD COLUMN IF NOT EXISTS contagem_iniciada_em timestamptz,
  ADD COLUMN IF NOT EXISTS contagem_finalizada_em timestamptz;

-- Recria índice antigo idx_inv_loc_area (não existe mais)
DROP INDEX IF EXISTS idx_inv_loc_area;
CREATE INDEX IF NOT EXISTS idx_inv_loc_pendente_pool
  ON siso_inventario_localizacoes(sessao_id, status)
  WHERE status = 'pendente';

------------------------------------------------------------------------------
-- 5. siso_inventario_contagens: simplifica (sem rodada — só 1 contagem)
------------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_inv_cont_quadrupla;
DROP INDEX IF EXISTS idx_inv_cont_loc;

ALTER TABLE siso_inventario_contagens
  DROP COLUMN IF EXISTS rodada;

CREATE INDEX IF NOT EXISTS idx_inv_cont_loc
  ON siso_inventario_contagens(sessao_id, localizacao_id);

CREATE INDEX IF NOT EXISTS idx_inv_cont_quadrupla
  ON siso_inventario_contagens(sessao_id, localizacao_id, produto_id, empresa_dona_id);

------------------------------------------------------------------------------
-- 6. siso_inventario_operadores: NOVO — slots OP1..OP5 dinâmicos
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS siso_inventario_operadores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 5),
  usuario_id uuid NOT NULL REFERENCES siso_usuarios(id),
  entrou_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  locs_contadas int NOT NULL DEFAULT 0,
  ultima_acao_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sessao_id, slot)
);

-- Um usuário só pode estar em um slot por sessão (enquanto ativo)
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_op_user_ativo
  ON siso_inventario_operadores(sessao_id, usuario_id)
  WHERE finalizado_em IS NULL;

CREATE INDEX IF NOT EXISTS idx_inv_op_sessao_ativo
  ON siso_inventario_operadores(sessao_id)
  WHERE finalizado_em IS NULL;

------------------------------------------------------------------------------
-- 7. Trigger: atualiza siso_localizacoes.ultima_contagem_em em cada bipe
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wms_inv_trigger_atualizar_ultima_contagem()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE siso_localizacoes
  SET ultima_contagem_em = NEW.criado_em
  WHERE id = NEW.localizacao_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inv_atualiza_ultima_contagem ON siso_inventario_contagens;
CREATE TRIGGER trg_inv_atualiza_ultima_contagem
  AFTER INSERT ON siso_inventario_contagens
  FOR EACH ROW EXECUTE FUNCTION wms_inv_trigger_atualizar_ultima_contagem();

------------------------------------------------------------------------------
-- 8. RPC: wms_inventario_proxima_loc — puxa próxima loc com smart routing
------------------------------------------------------------------------------
--
-- Algoritmo de priorização (ordem):
--   1. Mesma zona da última loc deste operador  (continuidade — caminho curto)
--   2. Zona NÃO ocupada por outros operadores   (anti-colisão)
--   3. Ordem alfabética do código              (fallback determinístico)
--
-- Zona = coluna siso_localizacoes.zona (se setada) ou prefixo antes do "-"
-- (ex: codigo "A-03-02" → zona "A").
--
-- Retorna null/pool_vazio se não há mais locs disponíveis.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wms_inventario_proxima_loc(
  p_sessao uuid,
  p_user uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_inv_loc_id uuid;
  v_loc_id uuid;
  v_codigo text;
  v_tipo text;
  v_zona text;
  v_modo text;
  v_empresa_dona uuid;
  v_ultima_zona text;
  v_esperados jsonb;
BEGIN
  -- Confirma que usuário tem slot ativo nesta sessão
  IF NOT EXISTS (
    SELECT 1 FROM siso_inventario_operadores
    WHERE sessao_id = p_sessao
      AND usuario_id = p_user
      AND finalizado_em IS NULL
  ) THEN
    RAISE EXCEPTION 'usuário não está em nenhum slot ativo desta sessão';
  END IF;

  -- Confirma que sessão está em andamento
  IF NOT EXISTS (
    SELECT 1 FROM siso_inventario_sessoes
    WHERE id = p_sessao AND status = 'em_andamento'
  ) THEN
    RAISE EXCEPTION 'sessão não está em andamento';
  END IF;

  -- Lê configuração da sessão
  SELECT modo_contagem, empresa_dona_id
  INTO v_modo, v_empresa_dona
  FROM siso_inventario_sessoes
  WHERE id = p_sessao;

  -- Descobre zona da última loc deste user (pra priorizar continuidade)
  SELECT COALESCE(loc.zona, split_part(loc.codigo, '-', 1))
  INTO v_ultima_zona
  FROM siso_inventario_localizacoes inv_loc
  JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
  WHERE inv_loc.sessao_id = p_sessao
    AND inv_loc.bloqueada_por = p_user
  ORDER BY inv_loc.bloqueada_em DESC NULLS LAST
  LIMIT 1;

  -- Seleciona a próxima loc com lock atômico (SKIP LOCKED evita race entre ops)
  SELECT inv_loc.id, loc.id, loc.codigo, loc.tipo,
         COALESCE(loc.zona, split_part(loc.codigo, '-', 1))
  INTO v_inv_loc_id, v_loc_id, v_codigo, v_tipo, v_zona
  FROM siso_inventario_localizacoes inv_loc
  JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
  WHERE inv_loc.sessao_id = p_sessao
    AND inv_loc.status = 'pendente'
    AND inv_loc.bloqueada_por IS NULL
  ORDER BY
    -- 1. Continuidade: mesma zona da última do user (0 vence 1)
    (CASE
      WHEN v_ultima_zona IS NOT NULL
       AND COALESCE(loc.zona, split_part(loc.codigo, '-', 1)) = v_ultima_zona
      THEN 0 ELSE 1
    END),
    -- 2. Anti-colisão: prefere zona NÃO ocupada por outros operadores ativos
    (CASE
      WHEN COALESCE(loc.zona, split_part(loc.codigo, '-', 1)) IN (
        SELECT DISTINCT COALESCE(loc2.zona, split_part(loc2.codigo, '-', 1))
        FROM siso_inventario_localizacoes il2
        JOIN siso_localizacoes loc2 ON loc2.id = il2.localizacao_id
        WHERE il2.sessao_id = p_sessao
          AND il2.status = 'em_contagem'
          AND il2.bloqueada_por IS NOT NULL
          AND il2.bloqueada_por != p_user
      ) THEN 1 ELSE 0
    END),
    -- 3. Determinístico por código (proximidade lexicográfica)
    loc.codigo ASC
  LIMIT 1
  FOR UPDATE OF inv_loc SKIP LOCKED;

  IF v_inv_loc_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'pool_vazio', true);
  END IF;

  -- Atribui a loc ao usuário
  UPDATE siso_inventario_localizacoes
  SET bloqueada_por = p_user,
      bloqueada_em = now(),
      status = 'em_contagem',
      contagem_iniciada_em = COALESCE(contagem_iniciada_em, now())
  WHERE id = v_inv_loc_id;

  -- Atualiza última ação do operador
  UPDATE siso_inventario_operadores
  SET ultima_acao_em = now()
  WHERE sessao_id = p_sessao
    AND usuario_id = p_user
    AND finalizado_em IS NULL;

  -- Modo aberto: anexa lista de SKUs esperados nesta loc
  IF v_modo = 'aberto' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'produto_id', e.produto_id,
      'sku', p.sku,
      'descricao', p.descricao,
      'saldo_esperado', e.saldo,
      'empresa_dona_id', e.empresa_dona_id
    ))
    INTO v_esperados
    FROM siso_estoque e
    JOIN siso_produtos p ON p.id = e.produto_id
    WHERE e.localizacao_id = v_loc_id
      AND e.saldo > 0
      AND (v_empresa_dona IS NULL OR e.empresa_dona_id = v_empresa_dona);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'pool_vazio', false,
    'inv_loc_id', v_inv_loc_id,
    'loc_id', v_loc_id,
    'codigo', v_codigo,
    'tipo', v_tipo,
    'zona', v_zona,
    'modo', v_modo,
    'esperados', v_esperados
  );
END;
$$;

------------------------------------------------------------------------------
-- 9. RPC: wms_inventario_sugerir — mix inteligente de locs pra cycle count
------------------------------------------------------------------------------
--
-- Compõe um pool de p_tamanho localizações segundo o mix 50/30/20:
--   50%  locs com produtos curva A (alto giro 30d)
--   30%  locs com divergências aplicadas nos últimos 60d
--   20%  locs sem contagem há mais de 30d (ou nunca contadas)
--
-- Filtra apenas locs com saldo > 0. Dedupe automático (uma loc só aparece uma vez,
-- priorizada na categoria de maior peso).
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wms_inventario_sugerir(
  p_galpao uuid,
  p_empresa_dona uuid DEFAULT NULL,
  p_tamanho int DEFAULT 30
) RETURNS TABLE(
  localizacao_id uuid,
  codigo text,
  motivo text,
  score numeric
) LANGUAGE plpgsql AS $$
DECLARE
  v_qtd_a int := GREATEST(1, FLOOR(p_tamanho * 0.5)::int);
  v_qtd_div int := GREATEST(0, FLOOR(p_tamanho * 0.3)::int);
  v_qtd_old int := GREATEST(0, p_tamanho - v_qtd_a - v_qtd_div);
BEGIN
  RETURN QUERY
  WITH curva_a AS (
    SELECT e.localizacao_id AS loc_id,
           SUM(c.qty_30d) AS score
    FROM siso_estoque e
    JOIN siso_curva_abc c ON c.produto_id = e.produto_id
    JOIN siso_localizacoes loc ON loc.id = e.localizacao_id
    WHERE c.curva = 'A'
      AND loc.galpao_id = p_galpao
      AND loc.ativo
      AND e.saldo > 0
      AND (p_empresa_dona IS NULL OR e.empresa_dona_id = p_empresa_dona)
    GROUP BY e.localizacao_id
    ORDER BY score DESC
    LIMIT v_qtd_a
  ),
  divergentes AS (
    SELECT d.localizacao_id AS loc_id,
           COUNT(*)::numeric AS score
    FROM siso_inventario_divergencias d
    JOIN siso_inventario_sessoes s ON s.id = d.sessao_id
    JOIN siso_localizacoes loc ON loc.id = d.localizacao_id
    WHERE d.status = 'aplicada'
      AND s.aplicada_em >= now() - interval '60 days'
      AND loc.galpao_id = p_galpao
      AND loc.ativo
      AND d.localizacao_id NOT IN (SELECT loc_id FROM curva_a)
    GROUP BY d.localizacao_id
    ORDER BY score DESC
    LIMIT v_qtd_div
  ),
  antigos AS (
    SELECT loc.id AS loc_id,
           COALESCE(
             EXTRACT(EPOCH FROM (now() - loc.ultima_contagem_em)) / 86400,
             9999
           )::numeric AS score
    FROM siso_localizacoes loc
    WHERE loc.galpao_id = p_galpao
      AND loc.ativo
      AND (loc.ultima_contagem_em IS NULL
           OR loc.ultima_contagem_em < now() - interval '30 days')
      AND loc.id NOT IN (SELECT loc_id FROM curva_a)
      AND loc.id NOT IN (SELECT loc_id FROM divergentes)
      AND EXISTS (
        SELECT 1 FROM siso_estoque e
        WHERE e.localizacao_id = loc.id
          AND e.saldo > 0
          AND (p_empresa_dona IS NULL OR e.empresa_dona_id = p_empresa_dona)
      )
    ORDER BY score DESC
    LIMIT v_qtd_old
  )
  SELECT ca.loc_id, loc.codigo, 'curva_a'::text, ca.score
    FROM curva_a ca JOIN siso_localizacoes loc ON loc.id = ca.loc_id
  UNION ALL
  SELECT d.loc_id, loc.codigo, 'divergente_recente'::text, d.score
    FROM divergentes d JOIN siso_localizacoes loc ON loc.id = d.loc_id
  UNION ALL
  SELECT a.loc_id, loc.codigo, 'sem_contagem_recente'::text, a.score
    FROM antigos a JOIN siso_localizacoes loc ON loc.id = a.loc_id;
END;
$$;

------------------------------------------------------------------------------
-- 10. Realtime: adiciona siso_inventario_operadores à publication
------------------------------------------------------------------------------

DO $$
BEGIN
  -- Remove publication da tabela de áreas (não existe mais)
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='siso_inventario_areas'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE siso_inventario_areas';
  END IF;

  -- Adiciona tabela nova de operadores (slots ao vivo na tela do supervisor)
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='siso_inventario_operadores'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE siso_inventario_operadores';
  END IF;
END $$;

COMMIT;
