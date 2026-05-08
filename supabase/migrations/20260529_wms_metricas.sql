-- WMS Plano 4 — Métricas de acuracidade

CREATE OR REPLACE FUNCTION wms_metricas_operador()
RETURNS TABLE (
  operador_id uuid,
  nome text,
  contagens int,
  erro_medio_pct numeric
) LANGUAGE sql AS $$
  SELECT
    u.id AS operador_id,
    u.nome,
    COUNT(DISTINCT c.id)::int AS contagens,
    AVG(ABS(d.delta_pct)) FILTER (WHERE d.id IS NOT NULL) AS erro_medio_pct
  FROM siso_inventario_contagens c
  JOIN siso_usuarios u ON u.id = c.contada_por
  LEFT JOIN siso_inventario_divergencias d
    ON d.sessao_id = c.sessao_id
   AND d.localizacao_id = c.localizacao_id
   AND d.produto_id = c.produto_id
   AND d.empresa_dona_id = c.empresa_dona_id
  WHERE c.criado_em >= now() - interval '30 days'
  GROUP BY u.id, u.nome
  ORDER BY 4 DESC NULLS LAST;
$$;

CREATE OR REPLACE FUNCTION wms_metricas_localizacao()
RETURNS TABLE (
  localizacao_id uuid,
  codigo text,
  total int,
  sem_div int,
  erro_medio_pct numeric
) LANGUAGE sql AS $$
  SELECT
    l.id AS localizacao_id,
    l.codigo,
    COUNT(DISTINCT il.sessao_id)::int AS total,
    COUNT(DISTINCT CASE WHEN d.delta = 0 OR d.id IS NULL THEN il.sessao_id END)::int AS sem_div,
    AVG(ABS(d.delta_pct)) FILTER (WHERE d.id IS NOT NULL) AS erro_medio_pct
  FROM siso_inventario_localizacoes il
  JOIN siso_localizacoes l ON l.id = il.localizacao_id
  LEFT JOIN siso_inventario_divergencias d
    ON d.localizacao_id = il.localizacao_id AND d.sessao_id = il.sessao_id
  WHERE il.id IN (SELECT id FROM siso_inventario_localizacoes ORDER BY id DESC LIMIT 5000)
  GROUP BY l.id, l.codigo
  ORDER BY 5 DESC NULLS LAST;
$$;
