-- Reescreve wms_kit_disponivel + wms_kit_disponivel_por_galpao removendo
-- referências a `siso_estoque.empresa_dona_id`, dropada em 2026-05-20 com
-- o ledger simplificado 3D. Sem essa correção o endpoint /api/wms/produtos/[id]/kit
-- retorna 500 silencioso e a UI mostra "Kit sem componentes" mesmo quando
-- a composição existe em siso_produto_kits.
--
-- Parâmetro p_empresa_dona_id é preservado com DEFAULT NULL pra não quebrar
-- chamadores legados (kits.ts:298,303 ainda passa explicitamente null). Ele
-- é ignorado internamente — pool fungível 3D, sem dimensão de dona física.

CREATE OR REPLACE FUNCTION public.wms_kit_disponivel(
  p_kit_id uuid,
  p_empresa_dona_id uuid DEFAULT NULL,
  p_galpao_id uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql STABLE
AS $$
  WITH composicao AS (
    SELECT pk.componente_produto_id, pk.quantidade AS qty_kit
    FROM siso_produto_kits pk
    WHERE pk.kit_produto_id = p_kit_id
  ),
  num_componentes AS (
    SELECT count(*)::int AS n FROM composicao
  ),
  por_galpao_comp AS (
    SELECT
      e.galpao_id,
      c.componente_produto_id,
      c.qty_kit,
      SUM(e.disponivel) AS disp
    FROM composicao c
    JOIN siso_estoque e
      ON e.produto_id = c.componente_produto_id
      AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)
    GROUP BY e.galpao_id, c.componente_produto_id, c.qty_kit
  ),
  kits_por_galpao AS (
    SELECT
      galpao_id,
      MIN(FLOOR(disp / qty_kit))::numeric AS kits
    FROM por_galpao_comp
    GROUP BY galpao_id
    HAVING COUNT(DISTINCT componente_produto_id) = (SELECT n FROM num_componentes)
       AND (SELECT n FROM num_componentes) > 0
  )
  SELECT COALESCE(SUM(kits), 0)::numeric FROM kits_por_galpao;
$$;

CREATE OR REPLACE FUNCTION public.wms_kit_disponivel_por_galpao(
  p_kit_id uuid,
  p_empresa_dona_id uuid DEFAULT NULL
)
RETURNS TABLE(
  galpao_id uuid,
  galpao_nome text,
  disponivel_kits numeric,
  gargalo_componente_id uuid,
  gargalo_componente_sku text,
  gargalo_disponivel numeric,
  empresas_contribuindo text
)
LANGUAGE sql STABLE
AS $$
  WITH composicao AS (
    SELECT pk.componente_produto_id, pk.quantidade AS qty_kit
    FROM siso_produto_kits pk
    WHERE pk.kit_produto_id = p_kit_id
  ),
  num_componentes AS (
    SELECT count(*)::int AS n FROM composicao
  ),
  por_galpao_comp AS (
    SELECT
      e.galpao_id,
      c.componente_produto_id,
      c.qty_kit,
      SUM(e.disponivel) AS disp,
      FLOOR(SUM(e.disponivel) / c.qty_kit)::numeric AS kits_possiveis
    FROM composicao c
    JOIN siso_estoque e ON e.produto_id = c.componente_produto_id
    GROUP BY e.galpao_id, c.componente_produto_id, c.qty_kit
  ),
  per_galpao AS (
    SELECT
      galpao_id,
      MIN(kits_possiveis) AS kits,
      COUNT(DISTINCT componente_produto_id) AS comp_count
    FROM por_galpao_comp
    GROUP BY galpao_id
  ),
  per_galpao_valido AS (
    SELECT pg.galpao_id, pg.kits
    FROM per_galpao pg
    WHERE pg.comp_count = (SELECT n FROM num_componentes)
      AND (SELECT n FROM num_componentes) > 0
  ),
  gargalo AS (
    SELECT DISTINCT ON (p.galpao_id)
      p.galpao_id,
      p.componente_produto_id AS gargalo_componente_id,
      p.disp AS gargalo_disponivel
    FROM por_galpao_comp p
    JOIN per_galpao_valido pg ON pg.galpao_id = p.galpao_id
    ORDER BY p.galpao_id, p.kits_possiveis, p.componente_produto_id
  )
  SELECT
    pg.galpao_id,
    galp.nome AS galpao_nome,
    pg.kits AS disponivel_kits,
    g.gargalo_componente_id,
    prod.sku AS gargalo_componente_sku,
    g.gargalo_disponivel,
    NULL::text AS empresas_contribuindo  -- 3D fungível: sem dimensão de dona
  FROM per_galpao_valido pg
  JOIN gargalo g ON g.galpao_id = pg.galpao_id
  JOIN siso_galpoes galp ON galp.id = pg.galpao_id
  LEFT JOIN siso_produtos prod ON prod.id = g.gargalo_componente_id
  ORDER BY pg.kits DESC, galp.nome;
$$;
