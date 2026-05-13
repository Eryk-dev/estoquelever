-- ============================================================
-- WMS Insights Dashboard — Motor de anomalia (Fase 1/4)
-- ============================================================
-- Tabelas + 15 regras seed. As SQL queries de cada regra ficam
-- em FUNCTIONS (segurança: não há SQL dinâmico armazenado em coluna).
-- Tabela siso_wms_insights_regras só guarda metadata + threshold + cooldown.
-- O worker /api/wms/insights/refresh itera as regras ativas e chama
-- wms_insight_<codigo>(threshold) pra cada uma.

-- ---- 1. Tabelas ----

CREATE TABLE IF NOT EXISTS siso_wms_insights_regras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text UNIQUE NOT NULL,
  nome text NOT NULL,
  descricao text,
  categoria text NOT NULL CHECK (categoria IN ('pessoas','fluxo','estoque','financeiro','devolucoes')),
  severidade text NOT NULL CHECK (severidade IN ('critico','alerta','info')),
  ativa boolean NOT NULL DEFAULT true,
  threshold jsonb NOT NULL DEFAULT '{}'::jsonb,
  cooldown_min int NOT NULL DEFAULT 360 CHECK (cooldown_min > 0),
  expira_min int NOT NULL DEFAULT 1440 CHECK (expira_min > 0),
  ultima_execucao_em timestamptz,
  ultima_execucao_status text CHECK (ultima_execucao_status IN ('ok','erro')),
  ultima_execucao_mensagem text,
  falhas_consecutivas int NOT NULL DEFAULT 0,
  criada_em timestamptz NOT NULL DEFAULT now(),
  atualizada_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insights_regras_categoria_ativa
  ON siso_wms_insights_regras(categoria, ativa);

CREATE TABLE IF NOT EXISTS siso_wms_insights_ativos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regra_id uuid NOT NULL REFERENCES siso_wms_insights_regras(id) ON DELETE CASCADE,
  categoria text NOT NULL,
  severidade text NOT NULL,
  entidade_tipo text,                       -- 'operador'|'sku'|'fornecedor'|'galpao'|null
  entidade_id text,
  titulo text NOT NULL,
  descricao text NOT NULL,
  dados jsonb NOT NULL DEFAULT '{}'::jsonb,
  galpao_id uuid REFERENCES siso_galpoes(id),
  link text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  dispensado_em timestamptz,
  dispensado_por uuid REFERENCES siso_usuarios(id)
);

-- Lookups rápidos (strip de insights ativos)
CREATE INDEX IF NOT EXISTS idx_insights_ativos_categoria
  ON siso_wms_insights_ativos(categoria, severidade, criado_em DESC)
  WHERE dispensado_em IS NULL;

-- Garante 1 insight ativo por (regra, entidade) — upsert respeita isso
CREATE UNIQUE INDEX IF NOT EXISTS uq_insights_ativos_entidade
  ON siso_wms_insights_ativos(regra_id, COALESCE(entidade_tipo,''), COALESCE(entidade_id,''))
  WHERE dispensado_em IS NULL;

-- Trigger pra manter atualizada_em
CREATE OR REPLACE FUNCTION wms_insights_regras_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.atualizada_em := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_insights_regras_touch ON siso_wms_insights_regras;
CREATE TRIGGER trg_insights_regras_touch
  BEFORE UPDATE ON siso_wms_insights_regras
  FOR EACH ROW
  EXECUTE FUNCTION wms_insights_regras_touch();

-- ---- 2. Tipo de retorno das funções de regra ----

DO $$ BEGIN
  CREATE TYPE wms_insight_resultado AS (
    entidade_tipo text,
    entidade_id text,
    titulo text,
    descricao text,
    dados jsonb,
    galpao_id uuid,
    link text
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- 3. PESSOAS — 5 regras ----

-- op_queda_produtividade: produtividade ontem < (média_pessoal_14d − N*sigma)
CREATE OR REPLACE FUNCTION wms_insight_op_queda_produtividade(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_sigma numeric := COALESCE((p_threshold->>'sigma')::numeric, 2.0);
  v_dias int := COALESCE((p_threshold->>'days')::int, 14);
  v_min_sample int := COALESCE((p_threshold->>'min_sample')::int, 20);
BEGIN
  RETURN QUERY
  WITH ontem AS (
    SELECT separacao_operador_id AS op, COUNT(*)::numeric AS pedidos_ontem
    FROM siso_pedidos
    WHERE embalagem_concluida_em::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1
      AND separacao_operador_id IS NOT NULL
    GROUP BY 1
  ),
  hist AS (
    SELECT separacao_operador_id AS op,
           AVG(c)::numeric AS media,
           STDDEV_POP(c)::numeric AS sigma_val,
           SUM(c)::numeric AS total_pedidos
    FROM (
      SELECT separacao_operador_id, embalagem_concluida_em::date AS dia, COUNT(*)::numeric AS c
      FROM siso_pedidos
      WHERE embalagem_concluida_em IS NOT NULL
        AND embalagem_concluida_em >= now() - (v_dias || ' days')::interval
        AND embalagem_concluida_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND separacao_operador_id IS NOT NULL
      GROUP BY 1, 2
    ) d
    GROUP BY 1
  )
  SELECT
    'operador'::text,
    o.op::text,
    'Queda de produtividade — ' || u.nome,
    u.nome || ' separou ' || o.pedidos_ontem::text || ' pedidos ontem (média ' ||
      ROUND(h.media, 1)::text || ' nos últimos ' || v_dias || 'd; queda fora do esperado).',
    jsonb_build_object(
      'ontem', o.pedidos_ontem,
      'media', h.media,
      'sigma', h.sigma_val,
      'limite_inferior', h.media - v_sigma * h.sigma_val,
      'amostra', h.total_pedidos
    ),
    NULL::uuid,
    '/wms/insights/pessoas/' || o.op::text
  FROM ontem o
  JOIN hist h ON h.op = o.op
  JOIN siso_usuarios u ON u.id = o.op
  WHERE h.total_pedidos >= v_min_sample
    AND h.sigma_val > 0
    AND o.pedidos_ontem < (h.media - v_sigma * h.sigma_val);
END;
$$;

-- op_alta_divergencia: divergências do op > N× mediana do galpão (30d)
CREATE OR REPLACE FUNCTION wms_insight_op_alta_divergencia(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_fator numeric := COALESCE((p_threshold->>'fator')::numeric, 2.0);
  v_min_diverg int := COALESCE((p_threshold->>'min_divergencias')::int, 3);
BEGIN
  RETURN QUERY
  WITH divs AS (
    SELECT il.bloqueada_por AS op,
           s.galpao_id,
           COUNT(*)::int AS qtd
    FROM siso_inventario_divergencias d
    JOIN siso_inventario_localizacoes il
      ON il.sessao_id = d.sessao_id AND il.localizacao_id = d.localizacao_id
    JOIN siso_inventario_sessoes s ON s.id = il.sessao_id
    WHERE s.criado_em >= now() - interval '30 days'
      AND il.bloqueada_por IS NOT NULL
    GROUP BY 1, 2
  ),
  mediana_galpao AS (
    SELECT galpao_id,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY qtd)::numeric AS mediana
    FROM divs
    GROUP BY 1
  )
  SELECT
    'operador'::text,
    d.op::text,
    'Acima da mediana em divergências — ' || u.nome,
    u.nome || ' acumulou ' || d.qtd::text || ' divergências de inventário em 30d (mediana do galpão: ' ||
      ROUND(m.mediana, 1)::text || ').',
    jsonb_build_object('divergencias', d.qtd, 'mediana_galpao', m.mediana, 'fator', v_fator),
    d.galpao_id,
    '/wms/insights/pessoas/' || d.op::text
  FROM divs d
  JOIN mediana_galpao m ON m.galpao_id = d.galpao_id
  JOIN siso_usuarios u ON u.id = d.op
  WHERE d.qtd >= v_min_diverg
    AND m.mediana > 0
    AND d.qtd >= v_fator * m.mediana;
END;
$$;

-- op_especializacao: 80%+ horas em 1 função em 7d (info)
CREATE OR REPLACE FUNCTION wms_insight_op_especializacao(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_pct numeric := COALESCE((p_threshold->>'pct')::numeric, 0.80);
BEGIN
  RETURN QUERY
  WITH atividade AS (
    SELECT separacao_operador_id AS op, 'separacao' AS funcao, COUNT(*)::numeric AS qtd
    FROM siso_pedidos
    WHERE embalagem_concluida_em >= now() - interval '7 days'
      AND separacao_operador_id IS NOT NULL
    GROUP BY 1
    UNION ALL
    SELECT embalagem_operador_id, 'embalagem', COUNT(*)::numeric
    FROM siso_pedidos
    WHERE embalagem_concluida_em >= now() - interval '7 days'
      AND embalagem_operador_id IS NOT NULL
    GROUP BY 1
    UNION ALL
    SELECT iniciada_por, 'guarda', COUNT(*)::numeric
    FROM siso_wms_pendencias_guarda
    WHERE guardada_em >= now() - interval '7 days'
      AND iniciada_por IS NOT NULL
    GROUP BY 1
    UNION ALL
    SELECT bloqueada_por, 'contagem', COUNT(*)::numeric
    FROM siso_inventario_localizacoes
    WHERE contagem_finalizada_em >= now() - interval '7 days'
      AND bloqueada_por IS NOT NULL
    GROUP BY 1
  ),
  pivot AS (
    SELECT op, funcao, qtd, SUM(qtd) OVER (PARTITION BY op) AS total
    FROM atividade
  )
  SELECT
    'operador'::text,
    p.op::text,
    'Especialização detectada — ' || u.nome,
    u.nome || ' fez ' || ROUND((p.qtd / p.total) * 100, 0)::text || '% das ações em ' || p.funcao || ' nos últimos 7d.',
    jsonb_build_object('funcao', p.funcao, 'qtd', p.qtd, 'total', p.total, 'pct', p.qtd/p.total),
    NULL::uuid,
    '/wms/insights/pessoas/' || p.op::text
  FROM pivot p
  JOIN siso_usuarios u ON u.id = p.op
  WHERE p.total >= 10
    AND (p.qtd / p.total) >= v_pct;
END;
$$;

-- op_alto_ajuste: ajustes manuais > N em 7d
CREATE OR REPLACE FUNCTION wms_insight_op_alto_ajuste(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_min int := COALESCE((p_threshold->>'min')::int, 3);
BEGIN
  RETURN QUERY
  WITH ajustes AS (
    SELECT usuario_id, galpao_id, COUNT(*)::int AS qtd, SUM(quantidade) AS qty_total
    FROM siso_movimentacoes
    WHERE origem_tipo = 'ajuste_manual'
      AND criado_em >= now() - interval '7 days'
      AND usuario_id IS NOT NULL
      AND estorno_de IS NULL
    GROUP BY 1, 2
    HAVING COUNT(*) >= v_min
  )
  SELECT
    'operador'::text,
    a.usuario_id::text,
    'Alto volume de ajustes — ' || u.nome,
    u.nome || ' fez ' || a.qtd::text || ' ajustes manuais em 7d. Investigar processo upstream.',
    jsonb_build_object('ajustes', a.qtd, 'qty_total', a.qty_total),
    a.galpao_id,
    '/wms/insights/pessoas/' || a.usuario_id::text
  FROM ajustes a
  JOIN siso_usuarios u ON u.id = a.usuario_id;
END;
$$;

-- op_baixo_sample: operador novo (< N dias trabalhados)
CREATE OR REPLACE FUNCTION wms_insight_op_baixo_sample(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_dias int := COALESCE((p_threshold->>'dias')::int, 5);
BEGIN
  RETURN QUERY
  WITH dias_atividade AS (
    SELECT op, COUNT(DISTINCT dia) AS dias
    FROM (
      SELECT separacao_operador_id AS op, embalagem_concluida_em::date AS dia
      FROM siso_pedidos
      WHERE embalagem_concluida_em IS NOT NULL AND separacao_operador_id IS NOT NULL
      UNION
      SELECT iniciada_por, guardada_em::date
      FROM siso_wms_pendencias_guarda
      WHERE guardada_em IS NOT NULL AND iniciada_por IS NOT NULL
      UNION
      SELECT bloqueada_por, contagem_finalizada_em::date
      FROM siso_inventario_localizacoes
      WHERE contagem_finalizada_em IS NOT NULL AND bloqueada_por IS NOT NULL
    ) t
    GROUP BY 1
  )
  SELECT
    'operador'::text,
    d.op::text,
    'Operador novo — ' || u.nome,
    u.nome || ' tem apenas ' || d.dias::text || ' dias de atividade registrada. Métricas com pouca amostra.',
    jsonb_build_object('dias_atividade', d.dias),
    NULL::uuid,
    '/wms/insights/pessoas/' || d.op::text
  FROM dias_atividade d
  JOIN siso_usuarios u ON u.id = d.op
  WHERE u.ativo = true
    AND d.dias < v_dias;
END;
$$;

-- ---- 4. FLUXO — 4 regras ----

-- fluxo_lead_time_p90: P90 24h > 1.5× P90 30d
CREATE OR REPLACE FUNCTION wms_insight_fluxo_lead_time_p90(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_fator numeric := COALESCE((p_threshold->>'fator')::numeric, 1.5);
BEGIN
  RETURN QUERY
  WITH p90_24h AS (
    SELECT empresa_origem_id,
           (PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (embalagem_concluida_em - criado_em))/60))::numeric AS p90_min
    FROM siso_pedidos
    WHERE embalagem_concluida_em IS NOT NULL
      AND embalagem_concluida_em >= now() - interval '24 hours'
    GROUP BY 1
  ),
  p90_30d AS (
    SELECT empresa_origem_id,
           (PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (embalagem_concluida_em - criado_em))/60))::numeric AS p90_min
    FROM siso_pedidos
    WHERE embalagem_concluida_em IS NOT NULL
      AND embalagem_concluida_em >= now() - interval '30 days'
      AND embalagem_concluida_em < now() - interval '24 hours'
    GROUP BY 1
  )
  SELECT
    'galpao'::text,
    e.galpao_id::text,
    'Lead time fora do padrão — ' || g.nome,
    'P90 nas últimas 24h foi ' || ROUND(p24.p90_min)::text || 'min vs ' || ROUND(p30.p90_min)::text || 'min de média 30d (' ||
      ROUND(p24.p90_min / NULLIF(p30.p90_min, 0), 1)::text || '× pior).',
    jsonb_build_object('p90_24h_min', p24.p90_min, 'p90_30d_min', p30.p90_min, 'fator', v_fator),
    e.galpao_id,
    '/wms/insights/fluxo'
  FROM p90_24h p24
  JOIN p90_30d p30 ON p30.empresa_origem_id = p24.empresa_origem_id
  JOIN siso_empresas e ON e.id = p24.empresa_origem_id
  JOIN siso_galpoes g ON g.id = e.galpao_id
  WHERE p30.p90_min > 0
    AND p24.p90_min > v_fator * p30.p90_min;
END;
$$;

-- fluxo_fila_etapa: fila atual de qualquer etapa > N× média 30d
CREATE OR REPLACE FUNCTION wms_insight_fluxo_fila_etapa(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_fator numeric := COALESCE((p_threshold->>'fator')::numeric, 2.0);
BEGIN
  -- Compara guarda pendente hoje vs média 30d
  RETURN QUERY
  WITH fila_atual AS (
    SELECT galpao_id, COUNT(*)::numeric AS qtd
    FROM siso_wms_pendencias_guarda
    WHERE status IN ('pendente', 'em_guarda')
    GROUP BY 1
  ),
  media_30d AS (
    SELECT galpao_id, AVG(qtd_dia)::numeric AS media
    FROM (
      SELECT galpao_id, dia, COUNT(*)::numeric AS qtd_dia
      FROM (
        SELECT galpao_id, criada_em::date AS dia
        FROM siso_wms_pendencias_guarda
        WHERE criada_em >= now() - interval '30 days'
          AND criada_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date
      ) t
      GROUP BY 1, 2
    ) d
    GROUP BY 1
  )
  SELECT
    'galpao'::text,
    f.galpao_id::text,
    'Fila de guarda acumulada — ' || g.nome,
    f.qtd::text || ' pendências de guarda (média 30d: ' || ROUND(m.media, 1)::text || ').',
    jsonb_build_object('fila_atual', f.qtd, 'media_30d', m.media, 'etapa', 'guarda'),
    f.galpao_id,
    '/wms/guarda'
  FROM fila_atual f
  JOIN media_30d m ON m.galpao_id = f.galpao_id
  JOIN siso_galpoes g ON g.id = f.galpao_id
  WHERE m.media > 0
    AND f.qtd > v_fator * m.media;
END;
$$;

-- fluxo_ritmo_baixo: throughput acumulado hoje < N% do esperado pra esse horário
CREATE OR REPLACE FUNCTION wms_insight_fluxo_ritmo_baixo(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_fator numeric := COALESCE((p_threshold->>'fator')::numeric, 0.7);
BEGIN
  RETURN QUERY
  WITH hora_atual AS (
    SELECT EXTRACT(HOUR FROM (now() AT TIME ZONE 'America/Sao_Paulo'))::int AS h
  ),
  hoje AS (
    SELECT e.galpao_id, COUNT(*)::numeric AS qtd
    FROM siso_pedidos p
    JOIN siso_empresas e ON e.id = p.empresa_origem_id
    WHERE p.embalagem_concluida_em::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
    GROUP BY 1
  ),
  esperado AS (
    SELECT e.galpao_id,
           AVG(daily_count)::numeric AS media_dia,
           AVG(daily_count) * ((SELECT h FROM hora_atual)::numeric / 18.0) AS esperado_agora
    FROM (
      SELECT empresa_origem_id, embalagem_concluida_em::date AS dia, COUNT(*)::numeric AS daily_count
      FROM siso_pedidos
      WHERE embalagem_concluida_em >= now() - interval '14 days'
        AND embalagem_concluida_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date
      GROUP BY 1, 2
    ) t
    JOIN siso_empresas e ON e.id = t.empresa_origem_id
    GROUP BY 1
  )
  SELECT
    'galpao'::text,
    h.galpao_id::text,
    'Ritmo abaixo do esperado — ' || g.nome,
    'Embalados até agora: ' || h.qtd::text || '. Esperado pra esse horário: ~' ||
      ROUND(e.esperado_agora, 1)::text || ' (média 14d).',
    jsonb_build_object('hoje', h.qtd, 'esperado_agora', e.esperado_agora, 'media_dia', e.media_dia),
    h.galpao_id,
    '/wms/insights/fluxo'
  FROM hoje h
  JOIN esperado e ON e.galpao_id = h.galpao_id
  JOIN siso_galpoes g ON g.id = h.galpao_id
  WHERE e.esperado_agora > 5  -- evita falso-positivo em horário muito cedo
    AND h.qtd < v_fator * e.esperado_agora;
END;
$$;

-- fluxo_aging_outlier: pedido em etapa há tempo > P95 histórico
CREATE OR REPLACE FUNCTION wms_insight_fluxo_aging_outlier(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_min_min int := COALESCE((p_threshold->>'min_minutos')::int, 120);
BEGIN
  -- pedidos em em_separacao há > N min
  RETURN QUERY
  SELECT
    'pedido'::text,
    p.id::text,
    'Pedido em separação há muito tempo',
    'Pedido #' || p.id || ' está em separação há ' ||
      ROUND(EXTRACT(EPOCH FROM (now() - p.separacao_iniciada_em))/60)::text || ' min.',
    jsonb_build_object(
      'minutos', ROUND(EXTRACT(EPOCH FROM (now() - p.separacao_iniciada_em))/60),
      'operador_id', p.separacao_operador_id
    ),
    e.galpao_id,
    '/separacao'
  FROM siso_pedidos p
  JOIN siso_empresas e ON e.id = p.empresa_origem_id
  WHERE p.status_separacao = 'em_separacao'
    AND p.separacao_iniciada_em IS NOT NULL
    AND p.separacao_iniciada_em < now() - (v_min_min || ' minutes')::interval;
END;
$$;

-- ---- 5. ESTOQUE — 3 regras ----

-- estoque_ruptura_iminente: cobertura < lead_time_min E sem OC pendente
CREATE OR REPLACE FUNCTION wms_insight_estoque_ruptura_iminente(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT
    'sku'::text,
    c.produto_id::text,
    'Risco de ruptura — ' || prod.sku,
    prod.sku || ' (' || COALESCE(prod.descricao, '') || '): cobertura de ' ||
      ROUND(c.dias_cobertura, 1)::text || 'd vs lead time médio do fornecedor ' ||
      COALESCE(c.lead_time_medio::text, 'sem fornecedor') || 'd.',
    jsonb_build_object(
      'dias_cobertura', c.dias_cobertura,
      'lead_time_medio', c.lead_time_medio,
      'saldo', c.disponivel_total,
      'giro_diario', c.giro_diario,
      'status_cobertura', c.status_cobertura
    ),
    c.galpao_id,
    '/wms/insights/estoque'
  FROM siso_cobertura_estoque c
  JOIN siso_produtos prod ON prod.id = c.produto_id
  WHERE c.status_cobertura IN ('critico','lead_time_risco');
END;
$$;

-- estoque_slow_mover: sem saída 60d+ E valor > R$ 500
CREATE OR REPLACE FUNCTION wms_insight_estoque_slow_mover(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_dias int := COALESCE((p_threshold->>'dias_sem_saida')::int, 60);
  v_min_valor numeric := COALESCE((p_threshold->>'min_valor')::numeric, 500);
BEGIN
  RETURN QUERY
  WITH ultima_saida AS (
    SELECT produto_id, empresa_dona_id, galpao_id, MAX(criado_em) AS ultima
    FROM siso_movimentacoes
    WHERE tipo = 'S'
      AND origem_tipo IN ('nf_venda','emprestimo')
      AND estorno_de IS NULL
    GROUP BY 1, 2, 3
  )
  SELECT
    'sku'::text,
    s.produto_id::text || '|' || s.empresa_dona_id::text,
    'Slow-mover — ' || p.sku,
    p.sku || ' parado há ' ||
      COALESCE(EXTRACT(DAYS FROM (now() - u.ultima))::text, '60+') || ' dias. ' ||
      'R$ ' || ROUND(s.saldo * s.custo_medio, 2)::text || ' empatado.',
    jsonb_build_object(
      'dias_parado', COALESCE(EXTRACT(DAYS FROM (now() - u.ultima))::int, 999),
      'saldo', s.saldo,
      'valor', s.saldo * s.custo_medio
    ),
    s.galpao_id,
    '/wms/insights/estoque'
  FROM siso_estoque s
  JOIN siso_produtos p ON p.id = s.produto_id
  LEFT JOIN ultima_saida u
    ON u.produto_id = s.produto_id
    AND u.empresa_dona_id = s.empresa_dona_id
    AND u.galpao_id = s.galpao_id
  WHERE s.saldo > 0
    AND s.custo_medio > 0
    AND s.saldo * s.custo_medio >= v_min_valor
    AND (u.ultima IS NULL OR u.ultima < now() - (v_dias || ' days')::interval);
END;
$$;

-- estoque_mudanca_curva: SKU mudou de curva ABC em 30d (info)
-- Placeholder simples — depende de snapshot histórico de curva. MVP retorna vazio.
CREATE OR REPLACE FUNCTION wms_insight_estoque_mudanca_curva(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN; -- TODO: requer siso_curva_abc_snapshots_diarios; será habilitado quando histórico existir
END;
$$;

-- ---- 6. FINANCEIRO — 1 regra ----

-- fin_custo_medio_pulou: custo atual > N× custo 30d atrás
-- Depende de siso_estoque_valor_diario (snapshot) que vem na migration 3.
-- MVP: usa última entrada com custo nas movs como proxy.
CREATE OR REPLACE FUNCTION wms_insight_fin_custo_medio_pulou(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_fator numeric := COALESCE((p_threshold->>'fator')::numeric, 1.15);
BEGIN
  RETURN QUERY
  WITH entradas_com_custo AS (
    SELECT produto_id, custo_unitario, criado_em,
           ROW_NUMBER() OVER (PARTITION BY produto_id ORDER BY criado_em DESC) AS rn_recent,
           ROW_NUMBER() OVER (
             PARTITION BY produto_id
             ORDER BY ABS(EXTRACT(EPOCH FROM (criado_em - (now() - interval '30 days'))))
           ) AS rn_30d
    FROM siso_movimentacoes
    WHERE tipo = 'E'
      AND custo_unitario IS NOT NULL
      AND custo_unitario > 0
      AND criado_em >= now() - interval '60 days'
      AND estorno_de IS NULL
  ),
  recent AS (SELECT produto_id, custo_unitario AS c_now FROM entradas_com_custo WHERE rn_recent = 1),
  base AS (SELECT produto_id, custo_unitario AS c_30d FROM entradas_com_custo WHERE rn_30d = 1)
  SELECT
    'sku'::text,
    r.produto_id::text,
    'Custo médio subiu — ' || p.sku,
    p.sku || ': custo passou de R$ ' || ROUND(b.c_30d, 2)::text ||
      ' pra R$ ' || ROUND(r.c_now, 2)::text || ' (+' || ROUND((r.c_now/b.c_30d - 1) * 100, 1)::text || '%).',
    jsonb_build_object('custo_atual', r.c_now, 'custo_30d_atras', b.c_30d, 'fator', v_fator),
    NULL::uuid,
    '/wms/insights/financeiro'
  FROM recent r
  JOIN base b ON b.produto_id = r.produto_id
  JOIN siso_produtos p ON p.id = r.produto_id
  WHERE b.c_30d > 0
    AND r.c_now > v_fator * b.c_30d;
END;
$$;

-- ---- 7. DEVOLUÇÕES — 2 regras ----

-- dev_taxa_alta: taxa 30d > N× média 90d
CREATE OR REPLACE FUNCTION wms_insight_dev_taxa_alta(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_fator numeric := COALESCE((p_threshold->>'fator')::numeric, 1.3);
BEGIN
  RETURN QUERY
  WITH vendas_30d AS (
    SELECT COUNT(*)::numeric AS qtd
    FROM siso_movimentacoes
    WHERE tipo = 'S' AND origem_tipo = 'nf_venda'
      AND criado_em >= now() - interval '30 days'
      AND estorno_de IS NULL
  ),
  dev_30d AS (
    SELECT COUNT(*)::numeric AS qtd
    FROM siso_devolucoes_pendentes
    WHERE criado_em >= now() - interval '30 days'
      AND status <> 'cancelada'
  ),
  vendas_90d AS (
    SELECT COUNT(*)::numeric AS qtd
    FROM siso_movimentacoes
    WHERE tipo = 'S' AND origem_tipo = 'nf_venda'
      AND criado_em >= now() - interval '90 days'
      AND estorno_de IS NULL
  ),
  dev_90d AS (
    SELECT COUNT(*)::numeric AS qtd
    FROM siso_devolucoes_pendentes
    WHERE criado_em >= now() - interval '90 days'
      AND status <> 'cancelada'
  )
  SELECT
    NULL::text,
    NULL::text,
    'Taxa de devolução acima do esperado',
    'Taxa 30d: ' || ROUND(d30.qtd / NULLIF(v30.qtd, 0) * 100, 2)::text || '% vs ' ||
      ROUND(d90.qtd / NULLIF(v90.qtd, 0) * 100, 2)::text || '% média 90d.',
    jsonb_build_object(
      'taxa_30d', d30.qtd / NULLIF(v30.qtd, 0),
      'taxa_90d', d90.qtd / NULLIF(v90.qtd, 0),
      'fator', v_fator
    ),
    NULL::uuid,
    '/wms/insights/devolucoes'
  FROM vendas_30d v30, dev_30d d30, vendas_90d v90, dev_90d d90
  WHERE v30.qtd > 0
    AND v90.qtd > 0
    AND (d30.qtd / v30.qtd) > v_fator * (d90.qtd / v90.qtd)
    AND d30.qtd >= 5; -- evita ruído com poucos dados
END;
$$;

-- dev_motivo_subindo: motivo cresceu >N% week-over-week
-- Usa classificacao (siso_devolucoes_pendentes.classificacao)
CREATE OR REPLACE FUNCTION wms_insight_dev_motivo_subindo(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_fator numeric := COALESCE((p_threshold->>'fator')::numeric, 1.5);
  v_min int := COALESCE((p_threshold->>'min_amostra')::int, 3);
BEGIN
  RETURN QUERY
  WITH semana_atual AS (
    SELECT classificacao, COUNT(*)::numeric AS qtd
    FROM siso_devolucoes_pendentes
    WHERE classificacao IS NOT NULL
      AND classificada_em >= now() - interval '7 days'
    GROUP BY 1
  ),
  semana_anterior AS (
    SELECT classificacao, COUNT(*)::numeric AS qtd
    FROM siso_devolucoes_pendentes
    WHERE classificacao IS NOT NULL
      AND classificada_em >= now() - interval '14 days'
      AND classificada_em < now() - interval '7 days'
    GROUP BY 1
  )
  SELECT
    'motivo_devolucao'::text,
    sa.classificacao::text,
    'Motivo de devolução crescendo — ' || sa.classificacao,
    'Motivo "' || sa.classificacao || '" passou de ' || sant.qtd::text || ' pra ' || sa.qtd::text ||
      ' essa semana (+' || ROUND((sa.qtd / NULLIF(sant.qtd, 0) - 1) * 100, 0)::text || '%).',
    jsonb_build_object('atual', sa.qtd, 'anterior', sant.qtd, 'fator', v_fator),
    NULL::uuid,
    '/wms/insights/devolucoes'
  FROM semana_atual sa
  JOIN semana_anterior sant ON sant.classificacao = sa.classificacao
  WHERE sa.qtd >= v_min
    AND sant.qtd > 0
    AND sa.qtd > v_fator * sant.qtd;
END;
$$;

-- ---- 8. Função orquestradora: chama regra por código ----

CREATE OR REPLACE FUNCTION wms_insights_executar_regra(p_codigo text, p_threshold jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
BEGIN
  -- whitelist explícita pra evitar function injection
  CASE p_codigo
    WHEN 'op_queda_produtividade'    THEN RETURN QUERY SELECT * FROM wms_insight_op_queda_produtividade(p_threshold);
    WHEN 'op_alta_divergencia'       THEN RETURN QUERY SELECT * FROM wms_insight_op_alta_divergencia(p_threshold);
    WHEN 'op_especializacao'         THEN RETURN QUERY SELECT * FROM wms_insight_op_especializacao(p_threshold);
    WHEN 'op_alto_ajuste'            THEN RETURN QUERY SELECT * FROM wms_insight_op_alto_ajuste(p_threshold);
    WHEN 'op_baixo_sample'           THEN RETURN QUERY SELECT * FROM wms_insight_op_baixo_sample(p_threshold);
    WHEN 'fluxo_lead_time_p90'       THEN RETURN QUERY SELECT * FROM wms_insight_fluxo_lead_time_p90(p_threshold);
    WHEN 'fluxo_fila_etapa'          THEN RETURN QUERY SELECT * FROM wms_insight_fluxo_fila_etapa(p_threshold);
    WHEN 'fluxo_ritmo_baixo'         THEN RETURN QUERY SELECT * FROM wms_insight_fluxo_ritmo_baixo(p_threshold);
    WHEN 'fluxo_aging_outlier'       THEN RETURN QUERY SELECT * FROM wms_insight_fluxo_aging_outlier(p_threshold);
    WHEN 'estoque_ruptura_iminente'  THEN RETURN QUERY SELECT * FROM wms_insight_estoque_ruptura_iminente(p_threshold);
    WHEN 'estoque_slow_mover'        THEN RETURN QUERY SELECT * FROM wms_insight_estoque_slow_mover(p_threshold);
    WHEN 'estoque_mudanca_curva'     THEN RETURN QUERY SELECT * FROM wms_insight_estoque_mudanca_curva(p_threshold);
    WHEN 'fin_custo_medio_pulou'     THEN RETURN QUERY SELECT * FROM wms_insight_fin_custo_medio_pulou(p_threshold);
    WHEN 'dev_taxa_alta'             THEN RETURN QUERY SELECT * FROM wms_insight_dev_taxa_alta(p_threshold);
    WHEN 'dev_motivo_subindo'        THEN RETURN QUERY SELECT * FROM wms_insight_dev_motivo_subindo(p_threshold);
    ELSE
      RAISE EXCEPTION 'Regra desconhecida: %', p_codigo;
  END CASE;
END;
$$;

-- ---- 9. Seed: 15 regras iniciais ----

INSERT INTO siso_wms_insights_regras (codigo, nome, descricao, categoria, severidade, threshold, cooldown_min, expira_min)
VALUES
  -- Pessoas
  ('op_queda_produtividade', 'Queda de produtividade individual',
   'Operador com produtividade ontem abaixo de (média_14d − 2σ).',
   'pessoas', 'alerta', '{"sigma":2.0,"days":14,"min_sample":20}', 720, 1440),

  ('op_alta_divergencia', 'Alto volume de divergências',
   'Operador com >2× a mediana do galpão em divergências de inventário (30d).',
   'pessoas', 'alerta', '{"fator":2.0,"min_divergencias":3}', 720, 1440),

  ('op_especializacao', 'Especialização detectada',
   'Operador concentrou 80%+ das ações em 1 função nos últimos 7d.',
   'pessoas', 'info', '{"pct":0.80}', 10080, 10080),

  ('op_alto_ajuste', 'Alto volume de ajustes manuais',
   'Operador fez >3 ajustes manuais em 7d (sinal de processo upstream com problema).',
   'pessoas', 'alerta', '{"min":3}', 720, 1440),

  ('op_baixo_sample', 'Operador novo (pouca amostra)',
   'Operador com <5 dias de atividade — métricas pouco confiáveis.',
   'pessoas', 'info', '{"dias":5}', 10080, 10080),

  -- Fluxo
  ('fluxo_lead_time_p90', 'Lead time P90 fora do padrão',
   'P90 nas últimas 24h > 1.5× média 30d.',
   'fluxo', 'critico', '{"fator":1.5}', 240, 1440),

  ('fluxo_fila_etapa', 'Fila de guarda acumulada',
   'Pendências de guarda > 2× média 30d.',
   'fluxo', 'alerta', '{"fator":2.0}', 240, 720),

  ('fluxo_ritmo_baixo', 'Ritmo de embalo abaixo do esperado',
   'Throughput acumulado hoje < 70% do esperado pra esse horário.',
   'fluxo', 'alerta', '{"fator":0.7}', 360, 720),

  ('fluxo_aging_outlier', 'Pedido travado em separação',
   'Pedido em status em_separacao há > 120 min.',
   'fluxo', 'critico', '{"min_minutos":120}', 60, 360),

  -- Estoque
  ('estoque_ruptura_iminente', 'Risco de ruptura',
   'SKU com cobertura inferior ao lead time mínimo do fornecedor (e sem OC pendente).',
   'estoque', 'critico', '{}', 720, 4320),

  ('estoque_slow_mover', 'Capital parado em slow-movers',
   'SKU sem saída há 60d+ e com valor empatado > R$ 500.',
   'estoque', 'info', '{"dias_sem_saida":60,"min_valor":500}', 10080, 10080),

  ('estoque_mudanca_curva', 'Mudança de curva ABC',
   'SKU mudou de curva (A↔B↔C) nos últimos 30d.',
   'estoque', 'info', '{}', 10080, 10080),

  -- Financeiro
  ('fin_custo_medio_pulou', 'Custo médio subiu',
   'Custo unitário em última entrada > 1.15× custo de 30d atrás.',
   'financeiro', 'alerta', '{"fator":1.15}', 1440, 4320),

  -- Devoluções
  ('dev_taxa_alta', 'Taxa de devolução acima do esperado',
   'Taxa de devolução 30d > 1.3× média 90d.',
   'devolucoes', 'alerta', '{"fator":1.3}', 1440, 4320),

  ('dev_motivo_subindo', 'Motivo de devolução crescendo',
   'Motivo cresceu >50% week-over-week.',
   'devolucoes', 'alerta', '{"fator":1.5,"min_amostra":3}', 10080, 10080)
ON CONFLICT (codigo) DO NOTHING;

COMMENT ON TABLE siso_wms_insights_regras IS
  'Catálogo de regras de detecção de anomalia. Cada regra mapeia pra wms_insight_<codigo>() function. Edit threshold/cooldown via UI admin.';
COMMENT ON TABLE siso_wms_insights_ativos IS
  'Insights ativos detectados pelo motor. Lidos pelo dashboard como strip de alerta. Snooze global via dispensado_em.';
