-- Migration: insights RPCs 3D patch v2 (cobertura completa)
-- Date: 2026-05-28
-- Plan: 2026-05-28-wms-reaudit-fixes (Task 5, P1 re-audit cross-module #2)
-- Finding: P1 patch (20260527_insights_rpcs_3d_patch.sql) só cobriu 4 RPCs;
-- 8 ainda referenciam siso_empresas.galpao_id deprecated.
--
-- Transformação canônica (mesma do P1):
--   - DROP JOIN siso_empresas e ON e.id = p.empresa_origem_id
--   - WHERE/SELECT trocam e.galpao_id por p.separacao_galpao_id
--   - Filter "todos os galpões" quando p_galpao_id IS NULL
--
-- Background: empresa deixou de ser coordenada física em 2026-05-20
-- (ledger 3D). siso_empresas.galpao_id ficou nullable como espelho do
-- primeiro preferencial — filtrar por isso esconde pedidos do galpão B
-- se empresa origem tem A como primeiro. siso_pedidos.separacao_galpao_id
-- é o source-of-truth real.

-- ─── 1. wms_insight_fluxo_aging_outlier ──────────────────────────────────
CREATE OR REPLACE FUNCTION wms_insight_fluxo_aging_outlier(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE v_min_min int := COALESCE((p_threshold->>'min_minutos')::int, 120);
BEGIN
  RETURN QUERY
  SELECT
    'pedido'::text, p.id::text,
    'Pedido em separação há muito tempo',
    'Pedido #' || p.id || ' está em separação há ' ||
      ROUND(EXTRACT(EPOCH FROM (now() - p.separacao_iniciada_em))/60)::text || ' min.',
    jsonb_build_object(
      'minutos', ROUND(EXTRACT(EPOCH FROM (now() - p.separacao_iniciada_em))/60),
      'operador_id', p.separacao_operador_id
    ),
    p.separacao_galpao_id,  -- [P1-v2 #2] era e.galpao_id
    '/wms/separacao'
  FROM siso_pedidos p
  WHERE p.status_separacao = 'em_separacao'
    AND p.separacao_iniciada_em IS NOT NULL
    AND p.separacao_iniciada_em < now() - (v_min_min || ' minutes')::interval;
END;
$$;

-- ─── 2. wms_insight_fluxo_lead_time_p90 ──────────────────────────────────
-- Antes: aggrega por empresa_origem_id, JOIN siso_empresas pra resolver galpao.
-- Depois: aggrega direto por separacao_galpao_id (semanticamente correto em 3D).
CREATE OR REPLACE FUNCTION wms_insight_fluxo_lead_time_p90(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE v_fator numeric := COALESCE((p_threshold->>'fator')::numeric, 1.5);
BEGIN
  RETURN QUERY
  WITH p90_24h AS (
    SELECT p.separacao_galpao_id AS galpao_id,
           (PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (embalagem_concluida_em - criado_em))/60))::numeric AS p90_min
    FROM siso_pedidos p
    WHERE embalagem_concluida_em IS NOT NULL
      AND embalagem_concluida_em >= now() - interval '24 hours'
      AND p.separacao_galpao_id IS NOT NULL
    GROUP BY 1
  ),
  p90_30d AS (
    SELECT p.separacao_galpao_id AS galpao_id,
           (PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (embalagem_concluida_em - criado_em))/60))::numeric AS p90_min
    FROM siso_pedidos p
    WHERE embalagem_concluida_em IS NOT NULL
      AND embalagem_concluida_em >= now() - interval '30 days'
      AND embalagem_concluida_em < now() - interval '24 hours'
      AND p.separacao_galpao_id IS NOT NULL
    GROUP BY 1
  )
  SELECT
    'galpao'::text, g.id::text,
    'Lead time fora do padrão — ' || g.nome,
    'P90 nas últimas 24h foi ' || ROUND(p24.p90_min)::text || 'min vs ' || ROUND(p30.p90_min)::text || 'min de média 30d (' ||
      ROUND(p24.p90_min / NULLIF(p30.p90_min, 0), 1)::text || '× pior).',
    jsonb_build_object('p90_24h_min', p24.p90_min, 'p90_30d_min', p30.p90_min, 'fator', v_fator),
    g.id,
    '/wms/insights/fluxo'
  FROM p90_24h p24
  JOIN p90_30d p30 ON p30.galpao_id = p24.galpao_id
  JOIN siso_galpoes g ON g.id = p24.galpao_id
  WHERE p30.p90_min > 0 AND p24.p90_min > v_fator * p30.p90_min;
END;
$$;

-- ─── 3. wms_insight_fluxo_ritmo_baixo ────────────────────────────────────
-- Antes: aggrega por e.galpao_id via JOIN empresas. Depois: por separacao_galpao_id.
CREATE OR REPLACE FUNCTION wms_insight_fluxo_ritmo_baixo(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE v_fator numeric := COALESCE((p_threshold->>'fator')::numeric, 0.7);
BEGIN
  RETURN QUERY
  WITH hora_atual AS (
    SELECT EXTRACT(HOUR FROM (now() AT TIME ZONE 'America/Sao_Paulo'))::int AS h
  ),
  hoje AS (
    SELECT p.separacao_galpao_id AS galpao_id, COUNT(*)::numeric AS qtd
    FROM siso_pedidos p
    WHERE p.embalagem_concluida_em::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
      AND p.separacao_galpao_id IS NOT NULL
    GROUP BY 1
  ),
  esperado AS (
    SELECT t.galpao_id,
           AVG(daily_count)::numeric AS media_dia,
           AVG(daily_count) * ((SELECT h FROM hora_atual)::numeric / 18.0) AS esperado_agora
    FROM (
      SELECT separacao_galpao_id AS galpao_id, embalagem_concluida_em::date AS dia, COUNT(*)::numeric AS daily_count
      FROM siso_pedidos
      WHERE embalagem_concluida_em >= now() - interval '14 days'
        AND embalagem_concluida_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND separacao_galpao_id IS NOT NULL
      GROUP BY 1, 2
    ) t
    GROUP BY 1
  )
  SELECT
    'galpao'::text, h.galpao_id::text,
    'Ritmo abaixo do esperado — ' || g.nome,
    'Embalados até agora: ' || h.qtd::text || '. Esperado pra esse horário: ~' ||
      ROUND(e.esperado_agora, 1)::text || ' (média 14d).',
    jsonb_build_object('hoje', h.qtd, 'esperado_agora', e.esperado_agora, 'media_dia', e.media_dia),
    h.galpao_id,
    '/wms/insights/fluxo'
  FROM hoje h
  JOIN esperado e ON e.galpao_id = h.galpao_id
  JOIN siso_galpoes g ON g.id = h.galpao_id
  WHERE e.esperado_agora > 5 AND h.qtd < v_fator * e.esperado_agora;
END;
$$;

-- ─── 4. wms_insights_funil_etapas ────────────────────────────────────────
-- Antes: LEFT JOIN siso_empresas + filtros e.galpao_id. Depois: direto.
CREATE OR REPLACE FUNCTION wms_insights_funil_etapas(p_galpao_id uuid DEFAULT NULL::uuid, p_dias integer DEFAULT 7)
RETURNS TABLE(etapa text, ordem integer, tempo_medio_min numeric, acumulado_atual integer)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_desde timestamptz := now() - (p_dias || ' days')::interval;
BEGIN
  RETURN QUERY
  SELECT 'separacao'::text, 1,
    AVG(EXTRACT(EPOCH FROM (COALESCE(separacao_concluida_em, embalagem_concluida_em) - separacao_iniciada_em))/60)::numeric,
    (SELECT COUNT(*)::int FROM siso_pedidos p2
     WHERE p2.status_separacao = 'em_separacao'
       AND (p_galpao_id IS NULL OR p2.separacao_galpao_id = p_galpao_id))
  FROM siso_pedidos p
  WHERE p.embalagem_concluida_em >= v_desde AND p.separacao_iniciada_em IS NOT NULL
    AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
  UNION ALL
  SELECT 'embalagem'::text, 2,
    AVG(EXTRACT(EPOCH FROM (embalagem_concluida_em - COALESCE(separacao_concluida_em, separacao_iniciada_em)))/60)::numeric,
    (SELECT COUNT(*)::int FROM siso_pedidos p2
     WHERE p2.status_separacao = 'separado'
       AND (p_galpao_id IS NULL OR p2.separacao_galpao_id = p_galpao_id))
  FROM siso_pedidos p
  WHERE p.embalagem_concluida_em >= v_desde
    AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
  UNION ALL
  SELECT 'guarda'::text, 3,
    AVG(EXTRACT(EPOCH FROM (guardada_em - iniciada_em))/60)::numeric,
    (SELECT COUNT(*)::int FROM siso_wms_pendencias_guarda
     WHERE status IN ('pendente','em_guarda')
       AND (p_galpao_id IS NULL OR galpao_id = p_galpao_id))
  FROM siso_wms_pendencias_guarda
  WHERE guardada_em >= v_desde AND iniciada_em IS NOT NULL
    AND (p_galpao_id IS NULL OR galpao_id = p_galpao_id);
END;
$$;

-- ─── 5. wms_insights_lead_time_percentis ────────────────────────────────
CREATE OR REPLACE FUNCTION wms_insights_lead_time_percentis(p_galpao_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(periodo text, qtd integer, p50_min numeric, p90_min numeric, p95_min numeric, media_min numeric)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  WITH lt AS (
    SELECT
      p.id,
      EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.criado_em))/60 AS minutos,
      CASE
        WHEN p.embalagem_concluida_em >= now() - interval '24 hours' THEN '24h'
        WHEN p.embalagem_concluida_em >= now() - interval '7 days' THEN '7d'
        WHEN p.embalagem_concluida_em >= now() - interval '30 days' THEN '30d'
      END AS bucket
    FROM siso_pedidos p
    WHERE p.embalagem_concluida_em IS NOT NULL
      AND p.embalagem_concluida_em >= now() - interval '30 days'
      AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
  )
  SELECT b AS periodo, COUNT(*)::int,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY minutos)::numeric, 1),
    ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY minutos)::numeric, 1),
    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY minutos)::numeric, 1),
    ROUND(AVG(minutos)::numeric, 1)
  FROM (
    SELECT minutos, '24h' AS b FROM lt WHERE bucket = '24h'
    UNION ALL
    SELECT minutos, '7d' FROM lt WHERE bucket IN ('24h','7d')
    UNION ALL
    SELECT minutos, '30d' FROM lt WHERE bucket IS NOT NULL
  ) t
  GROUP BY 1
  ORDER BY CASE b WHEN '24h' THEN 1 WHEN '7d' THEN 2 ELSE 3 END;
END;
$$;

-- ─── 6. wms_insights_ranking_operadores ─────────────────────────────────
-- Antes: cada CTE tem LEFT JOIN siso_empresas. Depois: direto via p.separacao_galpao_id.
CREATE OR REPLACE FUNCTION wms_insights_ranking_operadores(p_galpao_id uuid DEFAULT NULL::uuid, p_dias integer DEFAULT 7)
RETURNS TABLE(usuario_id uuid, usuario_nome text, funcao_efetiva text, pedidos_separados integer, pedidos_embalados integer, pendencias_guardadas integer, locs_contadas integer, acoes_outras integer, horas_ativas numeric, pedidos_por_hora numeric, tempo_medio_separacao_min numeric, tempo_medio_embalagem_min numeric, tempo_medio_guarda_min numeric, tempo_medio_contagem_min numeric, acuracidade_pct numeric, divergencias integer, ajustes_manuais integer)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_desde timestamptz := now() - (p_dias || ' days')::interval;
BEGIN
  RETURN QUERY
  WITH separacoes AS (
    SELECT separacao_operador_id AS op,
           COUNT(*) FILTER (WHERE separacao_operador_id IS NOT NULL) AS qtd,
           AVG(EXTRACT(EPOCH FROM (embalagem_concluida_em - separacao_iniciada_em))/60) AS tempo_med
    FROM siso_pedidos p
    WHERE p.embalagem_concluida_em >= v_desde
      AND p.separacao_operador_id IS NOT NULL
      AND p.separacao_iniciada_em IS NOT NULL
      AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  embalagens AS (
    SELECT embalagem_operador_id AS op, COUNT(*) AS qtd,
           AVG(EXTRACT(EPOCH FROM (embalagem_concluida_em - COALESCE(separacao_concluida_em, separacao_iniciada_em)))/60) AS tempo_med
    FROM siso_pedidos p
    WHERE p.embalagem_concluida_em >= v_desde AND p.embalagem_operador_id IS NOT NULL
      AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  guardas AS (
    SELECT iniciada_por AS op, COUNT(*) AS qtd,
           AVG(EXTRACT(EPOCH FROM (guardada_em - iniciada_em))/60) AS tempo_med
    FROM siso_wms_pendencias_guarda
    WHERE guardada_em >= v_desde AND iniciada_por IS NOT NULL AND iniciada_em IS NOT NULL
      AND (p_galpao_id IS NULL OR galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  contagens AS (
    SELECT il.bloqueada_por AS op, COUNT(*) AS qtd,
           AVG(EXTRACT(EPOCH FROM (il.contagem_finalizada_em - il.contagem_iniciada_em))/60) AS tempo_med
    FROM siso_inventario_localizacoes il
    JOIN siso_inventario_sessoes s ON s.id = il.sessao_id
    WHERE il.contagem_finalizada_em >= v_desde AND il.bloqueada_por IS NOT NULL AND il.contagem_iniciada_em IS NOT NULL
      AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  outras AS (
    SELECT m.usuario_id AS op, COUNT(*) AS qtd
    FROM siso_movimentacoes m
    WHERE m.criado_em >= v_desde AND m.usuario_id IS NOT NULL AND m.estorno_de IS NULL
      AND m.origem_tipo NOT IN ('nf_venda','emprestimo','liberacao_reserva','reserva_pedido')
      AND (p_galpao_id IS NULL OR m.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  divergencias AS (
    SELECT il.bloqueada_por AS op, COUNT(d.id) AS qtd
    FROM siso_inventario_divergencias d
    JOIN siso_inventario_localizacoes il ON il.sessao_id = d.sessao_id AND il.localizacao_id = d.localizacao_id
    JOIN siso_inventario_sessoes s ON s.id = il.sessao_id
    WHERE s.criado_em >= v_desde AND il.bloqueada_por IS NOT NULL
      AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  ajustes AS (
    SELECT m.usuario_id AS op, COUNT(*) AS qtd
    FROM siso_movimentacoes m
    WHERE m.criado_em >= v_desde AND m.origem_tipo = 'ajuste_manual'
      AND m.usuario_id IS NOT NULL AND m.estorno_de IS NULL
      AND (p_galpao_id IS NULL OR m.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  horas AS (
    SELECT op, COUNT(DISTINCT bucket)::numeric AS horas
    FROM (
      SELECT separacao_operador_id AS op, date_trunc('hour', embalagem_concluida_em) AS bucket
      FROM siso_pedidos
      WHERE embalagem_concluida_em >= v_desde AND separacao_operador_id IS NOT NULL
      UNION
      SELECT iniciada_por, date_trunc('hour', guardada_em)
      FROM siso_wms_pendencias_guarda
      WHERE guardada_em >= v_desde AND iniciada_por IS NOT NULL
      UNION
      SELECT il.bloqueada_por, date_trunc('hour', il.contagem_finalizada_em)
      FROM siso_inventario_localizacoes il
      WHERE il.contagem_finalizada_em >= v_desde AND il.bloqueada_por IS NOT NULL
      UNION
      SELECT m.usuario_id, date_trunc('hour', m.criado_em)
      FROM siso_movimentacoes m
      WHERE m.criado_em >= v_desde AND m.usuario_id IS NOT NULL AND m.estorno_de IS NULL
    ) t GROUP BY 1
  ),
  todos_ops AS (SELECT id AS op FROM siso_usuarios WHERE ativo = true)
  SELECT
    u.id, u.nome,
    CASE
      WHEN COALESCE(s.qtd,0) >= GREATEST(COALESCE(g.qtd,0), COALESCE(c.qtd,0), COALESCE(emb.qtd,0))
        AND COALESCE(s.qtd,0) > 0 THEN 'separacao'
      WHEN COALESCE(emb.qtd,0) >= GREATEST(COALESCE(g.qtd,0), COALESCE(c.qtd,0))
        AND COALESCE(emb.qtd,0) > 0 THEN 'embalagem'
      WHEN COALESCE(g.qtd,0) >= COALESCE(c.qtd,0) AND COALESCE(g.qtd,0) > 0 THEN 'guarda'
      WHEN COALESCE(c.qtd,0) > 0 THEN 'contagem'
      ELSE 'sem_atividade' END,
    COALESCE(s.qtd, 0)::int, COALESCE(emb.qtd, 0)::int, COALESCE(g.qtd, 0)::int,
    COALESCE(c.qtd, 0)::int, COALESCE(o.qtd, 0)::int, COALESCE(h.horas, 0),
    CASE WHEN COALESCE(h.horas, 0) > 0
      THEN ROUND(COALESCE(s.qtd, 0)::numeric / h.horas, 2)
      ELSE NULL END,
    ROUND(s.tempo_med::numeric, 1), ROUND(emb.tempo_med::numeric, 1),
    ROUND(g.tempo_med::numeric, 1), ROUND(c.tempo_med::numeric, 1),
    CASE WHEN COALESCE(c.qtd, 0) > 0
      THEN ROUND((1 - COALESCE(div.qtd, 0)::numeric / NULLIF(c.qtd, 0)) * 100, 1)
      ELSE NULL END,
    COALESCE(div.qtd, 0)::int, COALESCE(aj.qtd, 0)::int
  FROM todos_ops t
  JOIN siso_usuarios u ON u.id = t.op
  LEFT JOIN separacoes s ON s.op = t.op
  LEFT JOIN embalagens emb ON emb.op = t.op
  LEFT JOIN guardas g ON g.op = t.op
  LEFT JOIN contagens c ON c.op = t.op
  LEFT JOIN outras o ON o.op = t.op
  LEFT JOIN divergencias div ON div.op = t.op
  LEFT JOIN ajustes aj ON aj.op = t.op
  LEFT JOIN horas h ON h.op = t.op
  WHERE COALESCE(s.qtd,0) + COALESCE(emb.qtd,0) + COALESCE(g.qtd,0) + COALESCE(c.qtd,0) + COALESCE(o.qtd,0) > 0
  ORDER BY (COALESCE(s.qtd,0) + COALESCE(emb.qtd,0) + COALESCE(g.qtd,0) + COALESCE(c.qtd,0)) DESC;
END;
$$;

-- ─── 7. wms_insights_throughput_diario ──────────────────────────────────
CREATE OR REPLACE FUNCTION wms_insights_throughput_diario(p_galpao_id uuid DEFAULT NULL::uuid, p_dias integer DEFAULT 30)
RETURNS TABLE(dia date, pedidos integer, dow integer)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_desde date := (now() AT TIME ZONE 'America/Sao_Paulo')::date - p_dias;
BEGIN
  RETURN QUERY
  WITH dias AS (
    SELECT generate_series(v_desde, (now() AT TIME ZONE 'America/Sao_Paulo')::date, '1 day'::interval)::date AS d
  ),
  contagem AS (
    SELECT p.embalagem_concluida_em::date AS dia, COUNT(*)::int AS qtd
    FROM siso_pedidos p
    WHERE p.embalagem_concluida_em IS NOT NULL
      AND p.embalagem_concluida_em::date >= v_desde
      AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
    GROUP BY 1
  )
  SELECT d.d, COALESCE(c.qtd, 0)::int, EXTRACT(DOW FROM d.d)::int
  FROM dias d LEFT JOIN contagem c ON c.dia = d.d ORDER BY d.d;
END;
$$;

-- ─── 8. wms_insights_throughput_hora ────────────────────────────────────
CREATE OR REPLACE FUNCTION wms_insights_throughput_hora(p_galpao_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(hora integer, hoje integer, media_14d numeric, delta_pct numeric)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH horas AS (SELECT generate_series(0, 23) AS h),
  hj AS (
    SELECT EXTRACT(HOUR FROM p.embalagem_concluida_em AT TIME ZONE 'America/Sao_Paulo')::int AS h_,
           COUNT(*)::int AS qtd
    FROM siso_pedidos p
    WHERE p.embalagem_concluida_em::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
      AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  media AS (
    SELECT h_, AVG(qtd)::numeric AS m FROM (
      SELECT EXTRACT(HOUR FROM p.embalagem_concluida_em AT TIME ZONE 'America/Sao_Paulo')::int AS h_,
             p.embalagem_concluida_em::date AS dia, COUNT(*)::numeric AS qtd
      FROM siso_pedidos p
      WHERE p.embalagem_concluida_em >= now() - interval '14 days'
        AND p.embalagem_concluida_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
      GROUP BY 1, 2
    ) t GROUP BY 1
  )
  SELECT h.h, COALESCE(hj.qtd, 0)::int, ROUND(COALESCE(m.m, 0), 1),
    CASE WHEN COALESCE(m.m, 0) > 0
      THEN ROUND((COALESCE(hj.qtd, 0)::numeric / m.m - 1) * 100, 1)
      ELSE NULL END
  FROM horas h
  LEFT JOIN hj ON hj.h_ = h.h
  LEFT JOIN media m ON m.h_ = h.h
  ORDER BY h.h;
END;
$$;
