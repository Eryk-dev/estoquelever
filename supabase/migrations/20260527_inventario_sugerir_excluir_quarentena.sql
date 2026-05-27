-- Plano 6 — fix B.1: wms_inventario_sugerir exclui locs tipo='quarentena'
--
-- Quarentena guarda produtos retidos (avaria, garantia, devoluções) — não
-- devem ser sugeridos pra cycle count (gerariam divergência sobre saldo
-- "esperado-bloqueado"). Adiciona `loc.tipo <> 'quarentena'` nas 3 CTEs.
--
-- DOWN: restaurar versão anterior em 20260520e_rpc_inventario.sql linha 506+.

BEGIN;

CREATE OR REPLACE FUNCTION wms_inventario_sugerir(p_galpao uuid, p_tamanho integer DEFAULT 30)
RETURNS TABLE(localizacao_id uuid, codigo text, motivo text, score numeric)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_qtd_a int := GREATEST(1, FLOOR(p_tamanho * 0.5)::int);
  v_qtd_div int := GREATEST(0, FLOOR(p_tamanho * 0.3)::int);
  v_qtd_old int := GREATEST(0, p_tamanho - v_qtd_a - v_qtd_div);
BEGIN
  RETURN QUERY
  WITH curva_a AS (
    SELECT e.localizacao_id AS loc_id,
           SUM(c.giro_30d) AS score
    FROM siso_estoque e
    JOIN siso_curva_abc c ON c.produto_id = e.produto_id AND c.galpao_id = e.galpao_id
    JOIN siso_localizacoes loc ON loc.id = e.localizacao_id
    WHERE c.curva = 'A'
      AND loc.galpao_id = p_galpao
      AND loc.ativo
      AND loc.tipo <> 'quarentena'  -- ← exclui retidos
      AND e.saldo > 0
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
      AND loc.tipo <> 'quarentena'  -- ← exclui retidos
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
      AND loc.tipo <> 'quarentena'  -- ← exclui retidos
      AND (loc.ultima_contagem_em IS NULL
           OR loc.ultima_contagem_em < now() - interval '30 days')
      AND loc.id NOT IN (SELECT loc_id FROM curva_a)
      AND loc.id NOT IN (SELECT loc_id FROM divergentes)
      AND EXISTS (
        SELECT 1 FROM siso_estoque e
        WHERE e.localizacao_id = loc.id
          AND e.saldo > 0
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
$function$;

COMMIT;
