-- ============================================================
-- WMS Insights — RPCs auxiliares pras páginas
-- ============================================================
-- Mat views diárias foram deliberadamente descartadas (queries on-the-fly
-- são <1s com 500 pedidos/dia). Pode adicionar depois se virar gargalo.

-- ---- 1. Ranking de operadores por função ----
-- Retorna pedidos/h (separação+embalagem), tempo médio/loc (guarda+contagem),
-- acuracidade, ações/h por operador.
CREATE OR REPLACE FUNCTION wms_insights_ranking_operadores(
  p_galpao_id uuid DEFAULT NULL,
  p_dias int DEFAULT 7
) RETURNS TABLE (
  usuario_id uuid,
  usuario_nome text,
  funcao_efetiva text,
  pedidos_separados int,
  pedidos_embalados int,
  pendencias_guardadas int,
  locs_contadas int,
  acoes_outras int,
  horas_ativas numeric,
  pedidos_por_hora numeric,
  tempo_medio_separacao_min numeric,
  tempo_medio_embalagem_min numeric,
  tempo_medio_guarda_min numeric,
  tempo_medio_contagem_min numeric,
  acuracidade_pct numeric,
  divergencias int,
  ajustes_manuais int
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_desde timestamptz := now() - (p_dias || ' days')::interval;
BEGIN
  RETURN QUERY
  WITH separacoes AS (
    SELECT separacao_operador_id AS op,
           COUNT(*) FILTER (WHERE separacao_operador_id IS NOT NULL) AS qtd,
           AVG(EXTRACT(EPOCH FROM (embalagem_concluida_em - separacao_iniciada_em))/60) AS tempo_med
    FROM siso_pedidos p
    LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
    WHERE p.embalagem_concluida_em >= v_desde
      AND p.separacao_operador_id IS NOT NULL
      AND p.separacao_iniciada_em IS NOT NULL
      AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  embalagens AS (
    SELECT embalagem_operador_id AS op,
           COUNT(*) AS qtd,
           AVG(EXTRACT(EPOCH FROM (embalagem_concluida_em - COALESCE(separacao_concluida_em, separacao_iniciada_em)))/60) AS tempo_med
    FROM siso_pedidos p
    LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
    WHERE p.embalagem_concluida_em >= v_desde
      AND p.embalagem_operador_id IS NOT NULL
      AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  guardas AS (
    SELECT iniciada_por AS op,
           COUNT(*) AS qtd,
           AVG(EXTRACT(EPOCH FROM (guardada_em - iniciada_em))/60) AS tempo_med
    FROM siso_wms_pendencias_guarda
    WHERE guardada_em >= v_desde
      AND iniciada_por IS NOT NULL
      AND iniciada_em IS NOT NULL
      AND (p_galpao_id IS NULL OR galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  contagens AS (
    SELECT il.bloqueada_por AS op,
           COUNT(*) AS qtd,
           AVG(EXTRACT(EPOCH FROM (il.contagem_finalizada_em - il.contagem_iniciada_em))/60) AS tempo_med
    FROM siso_inventario_localizacoes il
    JOIN siso_inventario_sessoes s ON s.id = il.sessao_id
    WHERE il.contagem_finalizada_em >= v_desde
      AND il.bloqueada_por IS NOT NULL
      AND il.contagem_iniciada_em IS NOT NULL
      AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  outras AS (
    SELECT m.usuario_id AS op, COUNT(*) AS qtd
    FROM siso_movimentacoes m
    WHERE m.criado_em >= v_desde
      AND m.usuario_id IS NOT NULL
      AND m.estorno_de IS NULL
      AND m.origem_tipo NOT IN ('nf_venda','emprestimo','liberacao_reserva','reserva_pedido')
      AND (p_galpao_id IS NULL OR m.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  divergencias AS (
    SELECT il.bloqueada_por AS op, COUNT(d.id) AS qtd
    FROM siso_inventario_divergencias d
    JOIN siso_inventario_localizacoes il
      ON il.sessao_id = d.sessao_id AND il.localizacao_id = d.localizacao_id
    JOIN siso_inventario_sessoes s ON s.id = il.sessao_id
    WHERE s.criada_em >= v_desde
      AND il.bloqueada_por IS NOT NULL
      AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  ajustes AS (
    SELECT m.usuario_id AS op, COUNT(*) AS qtd
    FROM siso_movimentacoes m
    WHERE m.criado_em >= v_desde
      AND m.origem_tipo = 'ajuste_manual'
      AND m.usuario_id IS NOT NULL
      AND m.estorno_de IS NULL
      AND (p_galpao_id IS NULL OR m.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  horas AS (
    -- Soma de horas distintas onde tem qualquer ação (proxy de horas ativas)
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
  todos_ops AS (
    SELECT id AS op FROM siso_usuarios WHERE ativo = true
  )
  SELECT
    u.id,
    u.nome,
    CASE
      WHEN COALESCE(s.qtd,0) >= GREATEST(COALESCE(g.qtd,0), COALESCE(c.qtd,0), COALESCE(emb.qtd,0))
        AND COALESCE(s.qtd,0) > 0 THEN 'separacao'
      WHEN COALESCE(emb.qtd,0) >= GREATEST(COALESCE(g.qtd,0), COALESCE(c.qtd,0))
        AND COALESCE(emb.qtd,0) > 0 THEN 'embalagem'
      WHEN COALESCE(g.qtd,0) >= COALESCE(c.qtd,0) AND COALESCE(g.qtd,0) > 0 THEN 'guarda'
      WHEN COALESCE(c.qtd,0) > 0 THEN 'contagem'
      ELSE 'sem_atividade'
    END AS funcao_efetiva,
    COALESCE(s.qtd, 0)::int,
    COALESCE(emb.qtd, 0)::int,
    COALESCE(g.qtd, 0)::int,
    COALESCE(c.qtd, 0)::int,
    COALESCE(o.qtd, 0)::int,
    COALESCE(h.horas, 0),
    CASE WHEN COALESCE(h.horas, 0) > 0
      THEN ROUND(COALESCE(s.qtd, 0)::numeric / h.horas, 2)
      ELSE NULL END,
    ROUND(s.tempo_med::numeric, 1),
    ROUND(emb.tempo_med::numeric, 1),
    ROUND(g.tempo_med::numeric, 1),
    ROUND(c.tempo_med::numeric, 1),
    CASE WHEN COALESCE(c.qtd, 0) > 0
      THEN ROUND((1 - COALESCE(div.qtd, 0)::numeric / NULLIF(c.qtd, 0)) * 100, 1)
      ELSE NULL END,
    COALESCE(div.qtd, 0)::int,
    COALESCE(aj.qtd, 0)::int
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

-- ---- 2. Funil de etapas (tempos médios + acumulado atual) ----
CREATE OR REPLACE FUNCTION wms_insights_funil_etapas(
  p_galpao_id uuid DEFAULT NULL,
  p_dias int DEFAULT 7
) RETURNS TABLE (
  etapa text,
  ordem int,
  tempo_medio_min numeric,
  acumulado_atual int
) LANGUAGE plpgsql STABLE AS $$
DECLARE v_desde timestamptz := now() - (p_dias || ' days')::interval;
BEGIN
  RETURN QUERY
  -- Tempo médio: separação iniciada → concluída
  SELECT 'separacao'::text, 1,
    AVG(EXTRACT(EPOCH FROM (COALESCE(separacao_concluida_em, embalagem_concluida_em) - separacao_iniciada_em))/60)::numeric,
    (SELECT COUNT(*)::int FROM siso_pedidos p2
      LEFT JOIN siso_empresas e2 ON e2.id = p2.empresa_origem_id
     WHERE p2.status_separacao = 'em_separacao'
       AND (p_galpao_id IS NULL OR e2.galpao_id = p_galpao_id))
  FROM siso_pedidos p
  LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
  WHERE p.embalagem_concluida_em >= v_desde
    AND p.separacao_iniciada_em IS NOT NULL
    AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)

  UNION ALL

  SELECT 'embalagem'::text, 2,
    AVG(EXTRACT(EPOCH FROM (embalagem_concluida_em - COALESCE(separacao_concluida_em, separacao_iniciada_em)))/60)::numeric,
    (SELECT COUNT(*)::int FROM siso_pedidos p2
      LEFT JOIN siso_empresas e2 ON e2.id = p2.empresa_origem_id
     WHERE p2.status_separacao = 'separado'
       AND (p_galpao_id IS NULL OR e2.galpao_id = p_galpao_id))
  FROM siso_pedidos p
  LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
  WHERE p.embalagem_concluida_em >= v_desde
    AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)

  UNION ALL

  SELECT 'guarda'::text, 3,
    AVG(EXTRACT(EPOCH FROM (guardada_em - iniciada_em))/60)::numeric,
    (SELECT COUNT(*)::int FROM siso_wms_pendencias_guarda
     WHERE status IN ('pendente','em_guarda')
       AND (p_galpao_id IS NULL OR galpao_id = p_galpao_id))
  FROM siso_wms_pendencias_guarda
  WHERE guardada_em >= v_desde
    AND iniciada_em IS NOT NULL
    AND (p_galpao_id IS NULL OR galpao_id = p_galpao_id);
END;
$$;

-- ---- 3. Lead time percentis (P50/P90/P95) hoje + 7d + 30d ----
CREATE OR REPLACE FUNCTION wms_insights_lead_time_percentis(
  p_galpao_id uuid DEFAULT NULL
) RETURNS TABLE (
  periodo text,
  qtd int,
  p50_min numeric,
  p90_min numeric,
  p95_min numeric,
  media_min numeric
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  WITH lt AS (
    SELECT
      p.id,
      EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.created_at))/60 AS minutos,
      CASE
        WHEN p.embalagem_concluida_em >= now() - interval '24 hours' THEN '24h'
        WHEN p.embalagem_concluida_em >= now() - interval '7 days' THEN '7d'
        WHEN p.embalagem_concluida_em >= now() - interval '30 days' THEN '30d'
      END AS bucket
    FROM siso_pedidos p
    LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
    WHERE p.embalagem_concluida_em IS NOT NULL
      AND p.embalagem_concluida_em >= now() - interval '30 days'
      AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)
  )
  SELECT
    b AS periodo,
    COUNT(*)::int,
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

-- ---- 4. Throughput diário (últimos N dias) ----
CREATE OR REPLACE FUNCTION wms_insights_throughput_diario(
  p_galpao_id uuid DEFAULT NULL,
  p_dias int DEFAULT 30
) RETURNS TABLE (
  dia date,
  pedidos int,
  dow int
) LANGUAGE plpgsql STABLE AS $$
DECLARE v_desde date := (now() AT TIME ZONE 'America/Sao_Paulo')::date - p_dias;
BEGIN
  RETURN QUERY
  WITH dias AS (
    SELECT generate_series(v_desde, (now() AT TIME ZONE 'America/Sao_Paulo')::date, '1 day'::interval)::date AS d
  ),
  contagem AS (
    SELECT p.embalagem_concluida_em::date AS dia, COUNT(*)::int AS qtd
    FROM siso_pedidos p
    LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
    WHERE p.embalagem_concluida_em IS NOT NULL
      AND p.embalagem_concluida_em::date >= v_desde
      AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)
    GROUP BY 1
  )
  SELECT d.d, COALESCE(c.qtd, 0)::int, EXTRACT(DOW FROM d.d)::int
  FROM dias d
  LEFT JOIN contagem c ON c.dia = d.d
  ORDER BY d.d;
END;
$$;

-- ---- 5. Throughput por hora hoje vs média 14d ----
CREATE OR REPLACE FUNCTION wms_insights_throughput_hora(
  p_galpao_id uuid DEFAULT NULL
) RETURNS TABLE (
  hora int,
  hoje int,
  media_14d numeric,
  delta_pct numeric
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  WITH horas AS (SELECT generate_series(0, 23) AS h),
  hoje AS (
    SELECT EXTRACT(HOUR FROM p.embalagem_concluida_em AT TIME ZONE 'America/Sao_Paulo')::int AS hora,
           COUNT(*)::int AS qtd
    FROM siso_pedidos p
    LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
    WHERE p.embalagem_concluida_em::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
      AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)
    GROUP BY 1
  ),
  media AS (
    SELECT hora, AVG(qtd)::numeric AS m FROM (
      SELECT EXTRACT(HOUR FROM p.embalagem_concluida_em AT TIME ZONE 'America/Sao_Paulo')::int AS hora,
             p.embalagem_concluida_em::date AS dia,
             COUNT(*)::numeric AS qtd
      FROM siso_pedidos p
      LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
      WHERE p.embalagem_concluida_em >= now() - interval '14 days'
        AND p.embalagem_concluida_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)
      GROUP BY 1, 2
    ) t GROUP BY 1
  )
  SELECT h.h, COALESCE(hj.qtd, 0)::int, ROUND(COALESCE(m.m, 0), 1),
    CASE WHEN COALESCE(m.m, 0) > 0
      THEN ROUND((COALESCE(hj.qtd, 0)::numeric / m.m - 1) * 100, 1)
      ELSE NULL END
  FROM horas h
  LEFT JOIN hoje hj ON hj.hora = h.h
  LEFT JOIN media m ON m.hora = h.h
  ORDER BY h.h;
END;
$$;

-- ---- 6. Detalhe individual de operador (drill-down) ----
CREATE OR REPLACE FUNCTION wms_insights_pessoa_detalhe(
  p_user_id uuid,
  p_dias int DEFAULT 30
) RETURNS TABLE (
  dia date,
  pedidos_separados int,
  pendencias_guardadas int,
  locs_contadas int,
  acoes_outras int,
  divergencias int
) LANGUAGE plpgsql STABLE AS $$
DECLARE v_desde date := (now() AT TIME ZONE 'America/Sao_Paulo')::date - p_dias;
BEGIN
  RETURN QUERY
  WITH dias AS (
    SELECT generate_series(v_desde, (now() AT TIME ZONE 'America/Sao_Paulo')::date, '1 day'::interval)::date AS d
  ),
  sep AS (
    SELECT embalagem_concluida_em::date AS dia, COUNT(*)::int AS qtd
    FROM siso_pedidos
    WHERE separacao_operador_id = p_user_id AND embalagem_concluida_em::date >= v_desde
    GROUP BY 1
  ),
  guard AS (
    SELECT guardada_em::date AS dia, COUNT(*)::int AS qtd
    FROM siso_wms_pendencias_guarda
    WHERE iniciada_por = p_user_id AND guardada_em::date >= v_desde
    GROUP BY 1
  ),
  cont AS (
    SELECT contagem_finalizada_em::date AS dia, COUNT(*)::int AS qtd
    FROM siso_inventario_localizacoes
    WHERE bloqueada_por = p_user_id AND contagem_finalizada_em::date >= v_desde
    GROUP BY 1
  ),
  outras AS (
    SELECT criado_em::date AS dia, COUNT(*)::int AS qtd
    FROM siso_movimentacoes
    WHERE usuario_id = p_user_id AND criado_em::date >= v_desde
      AND origem_tipo NOT IN ('nf_venda','emprestimo','liberacao_reserva','reserva_pedido')
      AND estorno_de IS NULL
    GROUP BY 1
  ),
  divs AS (
    SELECT s.criada_em::date AS dia, COUNT(d.id)::int AS qtd
    FROM siso_inventario_divergencias d
    JOIN siso_inventario_localizacoes il
      ON il.sessao_id = d.sessao_id AND il.localizacao_id = d.localizacao_id
    JOIN siso_inventario_sessoes s ON s.id = il.sessao_id
    WHERE il.bloqueada_por = p_user_id AND s.criada_em::date >= v_desde
    GROUP BY 1
  )
  SELECT d.d,
    COALESCE(sep.qtd, 0),
    COALESCE(guard.qtd, 0),
    COALESCE(cont.qtd, 0),
    COALESCE(outras.qtd, 0),
    COALESCE(divs.qtd, 0)
  FROM dias d
  LEFT JOIN sep ON sep.dia = d.d
  LEFT JOIN guard ON guard.dia = d.d
  LEFT JOIN cont ON cont.dia = d.d
  LEFT JOIN outras ON outras.dia = d.d
  LEFT JOIN divs ON divs.dia = d.d
  ORDER BY d.d;
END;
$$;

-- ---- 7. Estoque quadrante (giro × cobertura) ----
CREATE OR REPLACE FUNCTION wms_insights_estoque_quadrante(
  p_galpao_id uuid DEFAULT NULL,
  p_empresa_dona_id uuid DEFAULT NULL,
  p_limit int DEFAULT 500
) RETURNS TABLE (
  produto_id uuid,
  sku text,
  giro_diario numeric,
  dias_cobertura numeric,
  saldo numeric,
  valor numeric,
  status_cobertura text,
  curva text
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.produto_id,
    p.sku,
    c.giro_diario,
    c.dias_cobertura,
    c.disponivel_total,
    c.disponivel_total * COALESCE(e.custo_medio_avg, 0) AS valor,
    c.status_cobertura,
    COALESCE(abc.curva, 'C') AS curva
  FROM siso_cobertura_estoque c
  JOIN siso_produtos p ON p.id = c.produto_id
  LEFT JOIN (
    SELECT produto_id, empresa_dona_id, galpao_id, AVG(custo_medio) AS custo_medio_avg
    FROM siso_estoque GROUP BY 1, 2, 3
  ) e ON e.produto_id = c.produto_id
    AND e.empresa_dona_id = c.empresa_dona_id
    AND e.galpao_id = c.galpao_id
  LEFT JOIN siso_curva_abc abc ON abc.produto_id = c.produto_id
  WHERE (p_galpao_id IS NULL OR c.galpao_id = p_galpao_id)
    AND (p_empresa_dona_id IS NULL OR c.empresa_dona_id = p_empresa_dona_id)
  ORDER BY c.disponivel_total * COALESCE(e.custo_medio_avg, 0) DESC
  LIMIT p_limit;
END;
$$;

-- ---- 8. Devoluções agregadas (A/B/C/D + motivo) ----
CREATE OR REPLACE FUNCTION wms_insights_devolucoes_agregado(
  p_dias int DEFAULT 30
) RETURNS TABLE (
  classificacao text,
  qtd int,
  qtd_pendentes int
) LANGUAGE plpgsql STABLE AS $$
DECLARE v_desde timestamptz := now() - (p_dias || ' days')::interval;
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(classificacao, 'pendente')::text,
    COUNT(*)::int,
    COUNT(*) FILTER (WHERE status = 'aguardando_classificacao')::int
  FROM siso_devolucoes_pendentes
  WHERE criado_em >= v_desde
  GROUP BY 1
  ORDER BY 2 DESC;
END;
$$;

-- ---- 9. Estoque por dona/galpão (Financeiro) ----
CREATE OR REPLACE FUNCTION wms_insights_estoque_valor_atual(
  p_galpao_id uuid DEFAULT NULL
) RETURNS TABLE (
  empresa_dona_id uuid,
  empresa_nome text,
  galpao_id uuid,
  galpao_nome text,
  qtd_skus int,
  saldo_total numeric,
  valor_total numeric,
  valor_curva_a numeric,
  valor_curva_b numeric,
  valor_curva_c numeric
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT s.empresa_dona_id, s.galpao_id, s.produto_id,
           s.saldo, s.custo_medio,
           s.saldo * s.custo_medio AS valor,
           COALESCE(abc.curva, 'C') AS curva
    FROM siso_estoque s
    LEFT JOIN siso_curva_abc abc ON abc.produto_id = s.produto_id
    WHERE s.saldo > 0
      AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id)
  )
  SELECT
    b.empresa_dona_id,
    emp.nome,
    b.galpao_id,
    g.nome,
    COUNT(DISTINCT b.produto_id)::int,
    SUM(b.saldo),
    ROUND(SUM(b.valor), 2),
    ROUND(SUM(b.valor) FILTER (WHERE b.curva = 'A'), 2),
    ROUND(SUM(b.valor) FILTER (WHERE b.curva = 'B'), 2),
    ROUND(SUM(b.valor) FILTER (WHERE b.curva = 'C'), 2)
  FROM base b
  JOIN siso_empresas emp ON emp.id = b.empresa_dona_id
  JOIN siso_galpoes g ON g.id = b.galpao_id
  GROUP BY 1, 2, 3, 4
  ORDER BY ROUND(SUM(b.valor), 2) DESC;
END;
$$;

-- ---- 10. KPIs hub ----
CREATE OR REPLACE FUNCTION wms_insights_hub_kpis(
  p_galpao_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_throughput_hoje int;
  v_throughput_7d_avg numeric;
  v_lead_time_p50_24h numeric;
  v_lead_time_p50_7d numeric;
  v_acuracidade_pct numeric;
  v_cobertura_critico int;
  v_capital_total numeric;
  v_devolucoes_pct numeric;
BEGIN
  -- Throughput
  SELECT COUNT(*) INTO v_throughput_hoje
  FROM siso_pedidos p LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
  WHERE p.embalagem_concluida_em::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
    AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id);

  SELECT AVG(qtd) INTO v_throughput_7d_avg FROM (
    SELECT embalagem_concluida_em::date AS dia, COUNT(*)::numeric AS qtd
    FROM siso_pedidos p LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
    WHERE p.embalagem_concluida_em >= now() - interval '7 days'
      AND p.embalagem_concluida_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date
      AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)
    GROUP BY 1
  ) t;

  -- Lead time 24h
  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (embalagem_concluida_em - created_at))/60)
  INTO v_lead_time_p50_24h
  FROM siso_pedidos p LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
  WHERE p.embalagem_concluida_em >= now() - interval '24 hours'
    AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id);

  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (embalagem_concluida_em - created_at))/60)
  INTO v_lead_time_p50_7d
  FROM siso_pedidos p LEFT JOIN siso_empresas e ON e.id = p.empresa_origem_id
  WHERE p.embalagem_concluida_em >= now() - interval '7 days'
    AND p.embalagem_concluida_em < now() - interval '24 hours'
    AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id);

  -- Acuracidade (1 − div/contagens) últimos 30d
  SELECT CASE WHEN COUNT(il.id) > 0
    THEN ROUND((1 - COUNT(d.id)::numeric / NULLIF(COUNT(il.id), 0)) * 100, 1)
    ELSE NULL END
  INTO v_acuracidade_pct
  FROM siso_inventario_localizacoes il
  JOIN siso_inventario_sessoes s ON s.id = il.sessao_id
  LEFT JOIN siso_inventario_divergencias d
    ON d.sessao_id = il.sessao_id AND d.localizacao_id = il.localizacao_id
  WHERE il.contagem_finalizada_em >= now() - interval '30 days'
    AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id);

  -- Cobertura crítico
  SELECT COUNT(*) INTO v_cobertura_critico
  FROM siso_cobertura_estoque
  WHERE status_cobertura IN ('critico','lead_time_risco')
    AND (p_galpao_id IS NULL OR galpao_id = p_galpao_id);

  -- Capital
  SELECT SUM(saldo * custo_medio) INTO v_capital_total
  FROM siso_estoque
  WHERE saldo > 0
    AND (p_galpao_id IS NULL OR galpao_id = p_galpao_id);

  -- Devoluções (taxa 30d)
  WITH v AS (SELECT COUNT(*) AS qtd FROM siso_movimentacoes
    WHERE tipo = 'S' AND origem_tipo = 'nf_venda'
      AND criado_em >= now() - interval '30 days' AND estorno_de IS NULL
      AND (p_galpao_id IS NULL OR galpao_id = p_galpao_id)),
  d AS (SELECT COUNT(*) AS qtd FROM siso_devolucoes_pendentes
    WHERE criado_em >= now() - interval '30 days' AND status <> 'cancelada')
  SELECT CASE WHEN v.qtd > 0 THEN ROUND(d.qtd::numeric / v.qtd * 100, 2) ELSE NULL END
  INTO v_devolucoes_pct FROM v, d;

  RETURN jsonb_build_object(
    'throughput_hoje', v_throughput_hoje,
    'throughput_7d_avg', ROUND(COALESCE(v_throughput_7d_avg, 0), 1),
    'delta_throughput_pct',
      CASE WHEN COALESCE(v_throughput_7d_avg, 0) > 0
        THEN ROUND((v_throughput_hoje::numeric / v_throughput_7d_avg - 1) * 100, 1)
        ELSE NULL END,
    'lead_time_p50_24h_min', ROUND(COALESCE(v_lead_time_p50_24h, 0), 1),
    'lead_time_p50_7d_min', ROUND(COALESCE(v_lead_time_p50_7d, 0), 1),
    'delta_lead_time_pct',
      CASE WHEN COALESCE(v_lead_time_p50_7d, 0) > 0
        THEN ROUND((v_lead_time_p50_24h / v_lead_time_p50_7d - 1) * 100, 1)
        ELSE NULL END,
    'acuracidade_pct', v_acuracidade_pct,
    'cobertura_critico', v_cobertura_critico,
    'capital_total', ROUND(COALESCE(v_capital_total, 0), 2),
    'devolucoes_taxa_30d', v_devolucoes_pct
  );
END;
$$;
