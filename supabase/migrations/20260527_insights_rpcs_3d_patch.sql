-- Migration: insights RPCs 3D patch
-- Date: 2026-05-27
-- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
-- Finding(s): 0.2 (ALTO — 4 RPCs broken), 0.4 (ALTO — galpao_id deprecated)
--
-- Rewrites 4 insights RPCs that referenced columns dropped in the 3D ledger
-- migration (20260520_ledger_simplificado.sql):
--   - siso_estoque.custo_medio  → JOIN siso_custo_medio.custo_medio (global por produto)
--   - siso_estoque.empresa_dona_id  → dropped; estoque é por (produto, galpão, loc) apenas
--   - siso_empresas.galpao_id  → trocar por siso_pedidos.separacao_galpao_id
--
-- Princípios restabelecidos: PR-5 (empresa = tag em movs) + PR-6 (custo médio global).
--
-- Rollback: re-apply 20260514_wms_insights_motor.sql + 20260515_wms_insights_rpcs.sql
-- (essas RPCs eram a definição original; trazê-las de volta restaura o estado pré-fix
-- mas reintroduz o bug runtime — só fazer se for pra debug histórico).

-- ---- 1. wms_insight_estoque_slow_mover (motor anomalias) ----
CREATE OR REPLACE FUNCTION wms_insight_estoque_slow_mover(p_threshold jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_dias int := COALESCE((p_threshold->>'dias_sem_saida')::int, 60);
  v_min_valor numeric := COALESCE((p_threshold->>'min_valor')::numeric, 500);
BEGIN
  RETURN QUERY
  WITH ultima_saida AS (
    SELECT produto_id, galpao_id, MAX(criado_em) AS ultima
    FROM siso_movimentacoes
    WHERE tipo = 'S'
      AND origem_tipo IN ('nf_venda', 'venda_manual')
      AND estorno_de IS NULL
    GROUP BY 1, 2
  ),
  saldos AS (
    SELECT s.produto_id, s.galpao_id, SUM(s.saldo) AS saldo
    FROM siso_estoque s
    WHERE s.saldo > 0
    GROUP BY 1, 2
  )
  SELECT
    'sku'::text,
    sa.produto_id::text || '|' || sa.galpao_id::text,
    'Slow-mover — ' || p.sku,
    p.sku || ' parado há ' ||
      COALESCE(EXTRACT(DAYS FROM (now() - u.ultima))::text, '60+') || ' dias. ' ||
      'R$ ' || ROUND(sa.saldo * cm.custo_medio, 2)::text || ' empatado.',
    jsonb_build_object(
      'dias_parado', COALESCE(EXTRACT(DAYS FROM (now() - u.ultima))::int, 999),
      'saldo', sa.saldo,
      'valor', sa.saldo * cm.custo_medio
    ),
    sa.galpao_id,
    '/wms/insights/estoque'
  FROM saldos sa
  JOIN siso_produtos p ON p.id = sa.produto_id
  JOIN siso_custo_medio cm ON cm.produto_id = sa.produto_id
  LEFT JOIN ultima_saida u
    ON u.produto_id = sa.produto_id
    AND u.galpao_id = sa.galpao_id
  WHERE cm.custo_medio > 0
    AND sa.saldo * cm.custo_medio >= v_min_valor
    AND (u.ultima IS NULL OR u.ultima < now() - (v_dias || ' days')::interval);
END;
$$;

-- ---- 2. wms_insights_estoque_quadrante (consultas frontend) ----
-- Drop legacy signature first (parameter list changed — empresa_dona_id removed).
DROP FUNCTION IF EXISTS wms_insights_estoque_quadrante(uuid, uuid, int);

CREATE OR REPLACE FUNCTION wms_insights_estoque_quadrante(
  p_galpao_id uuid DEFAULT NULL,
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
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT
    c.produto_id,
    p.sku,
    c.giro_diario,
    c.dias_cobertura,
    c.disponivel_total AS saldo,
    c.disponivel_total * COALESCE(cm.custo_medio, 0) AS valor,
    c.status_cobertura,
    COALESCE(abc.curva, 'C') AS curva
  FROM siso_cobertura_estoque c
  JOIN siso_produtos p ON p.id = c.produto_id
  LEFT JOIN siso_custo_medio cm ON cm.produto_id = c.produto_id
  LEFT JOIN siso_curva_abc abc ON abc.produto_id = c.produto_id
  WHERE (p_galpao_id IS NULL OR c.galpao_id = p_galpao_id)
  ORDER BY c.disponivel_total * COALESCE(cm.custo_medio, 0) DESC
  LIMIT p_limit;
END;
$$;

-- ---- 3. wms_insights_estoque_valor_atual (consultas frontend, financeiro) ----
-- Removed empresa_dona_id axis: 3D-canonical "valor por empresa" lives in
-- /api/wms/relatorios/saldos-por-empresa (recompõe via tags em movs).
-- Esta RPC vira "valor por galpão" apenas.
DROP FUNCTION IF EXISTS wms_insights_estoque_valor_atual(uuid);

CREATE OR REPLACE FUNCTION wms_insights_estoque_valor_atual(
  p_galpao_id uuid DEFAULT NULL
) RETURNS TABLE (
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
    SELECT s.galpao_id, s.produto_id,
           SUM(s.saldo) AS saldo,
           COALESCE(cm.custo_medio, 0) AS custo_medio,
           SUM(s.saldo) * COALESCE(cm.custo_medio, 0) AS valor,
           COALESCE(abc.curva, 'C') AS curva
    FROM siso_estoque s
    LEFT JOIN siso_custo_medio cm ON cm.produto_id = s.produto_id
    LEFT JOIN siso_curva_abc abc ON abc.produto_id = s.produto_id
    WHERE s.saldo > 0
      AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id)
    GROUP BY s.galpao_id, s.produto_id, cm.custo_medio, abc.curva
  )
  SELECT
    b.galpao_id,
    g.nome,
    COUNT(DISTINCT b.produto_id)::int,
    SUM(b.saldo),
    ROUND(SUM(b.valor), 2),
    ROUND(COALESCE(SUM(b.valor) FILTER (WHERE b.curva = 'A'), 0), 2),
    ROUND(COALESCE(SUM(b.valor) FILTER (WHERE b.curva = 'B'), 0), 2),
    ROUND(COALESCE(SUM(b.valor) FILTER (WHERE b.curva = 'C'), 0), 2)
  FROM base b
  JOIN siso_galpoes g ON g.id = b.galpao_id
  GROUP BY 1, 2
  ORDER BY ROUND(SUM(b.valor), 2) DESC;
END;
$$;

-- ---- 4. wms_insights_hub_kpis (dashboard hub) ----
-- Trocas:
--   - siso_empresas.galpao_id (deprecated)  → siso_pedidos.separacao_galpao_id
--   - siso_estoque.custo_medio  → siso_custo_medio.custo_medio
--   - filtro devoluções por galpão removido (siso_devolucoes_pendentes não tem
--     galpao_id direto; agregação global é o comportamento correto pós-3D).
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
  -- Throughput (filtra por separacao_galpao_id, fonte de verdade pós-3D)
  SELECT COUNT(*) INTO v_throughput_hoje
  FROM siso_pedidos p
  WHERE p.embalagem_concluida_em::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
    AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id);

  SELECT AVG(qtd) INTO v_throughput_7d_avg FROM (
    SELECT embalagem_concluida_em::date AS dia, COUNT(*)::numeric AS qtd
    FROM siso_pedidos p
    WHERE p.embalagem_concluida_em >= now() - interval '7 days'
      AND p.embalagem_concluida_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date
      AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
    GROUP BY 1
  ) t;

  -- Lead time 24h
  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.criado_em))/60)
  INTO v_lead_time_p50_24h
  FROM siso_pedidos p
  WHERE p.embalagem_concluida_em >= now() - interval '24 hours'
    AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id);

  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.criado_em))/60)
  INTO v_lead_time_p50_7d
  FROM siso_pedidos p
  WHERE p.embalagem_concluida_em >= now() - interval '7 days'
    AND p.embalagem_concluida_em < now() - interval '24 hours'
    AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id);

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

  -- Capital total: valor empatado = saldo × custo_medio (global por produto)
  SELECT SUM(s.saldo * COALESCE(cm.custo_medio, 0))
  INTO v_capital_total
  FROM siso_estoque s
  LEFT JOIN siso_custo_medio cm ON cm.produto_id = s.produto_id
  WHERE s.saldo > 0
    AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id);

  -- Devoluções (taxa 30d) — agregação global pós-3D (devoluções não têm galpao direto)
  WITH v AS (
    SELECT COUNT(*) AS qtd
    FROM siso_movimentacoes m
    WHERE m.tipo = 'S' AND m.origem_tipo = 'nf_venda'
      AND m.criado_em >= now() - interval '30 days'
      AND m.estorno_de IS NULL
      AND (p_galpao_id IS NULL OR m.galpao_id = p_galpao_id)
  ),
  d AS (
    SELECT COUNT(*) AS qtd
    FROM siso_devolucoes_pendentes
    WHERE criado_em >= now() - interval '30 days'
      AND status <> 'cancelada'
  )
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

-- Sanity: comment marker for future audits
COMMENT ON FUNCTION wms_insight_estoque_slow_mover(jsonb) IS
  'Patched 2026-05-27 (P1): removed siso_estoque.custo_medio + empresa_dona_id references (3D schema). See spec §5.';
COMMENT ON FUNCTION wms_insights_estoque_quadrante(uuid, int) IS
  'Patched 2026-05-27 (P1): removed empresa_dona_id axis + JOIN siso_custo_medio. See spec §5.';
COMMENT ON FUNCTION wms_insights_estoque_valor_atual(uuid) IS
  'Patched 2026-05-27 (P1): "valor por empresa" agora vive em /api/wms/relatorios/saldos-por-empresa. Aqui só valor por galpão. See spec §5.';
COMMENT ON FUNCTION wms_insights_hub_kpis(uuid) IS
  'Patched 2026-05-27 (P1): troca siso_empresas.galpao_id por siso_pedidos.separacao_galpao_id; JOIN siso_custo_medio. See spec §5.';
