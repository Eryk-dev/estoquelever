-- WMS: kit disponível agora agrupa SOMENTE por galpão (não por empresa_dona).
--
-- Motivação: fisicamente, o kit é montado no galpão. Não importa quem é
-- dono do estoque — se os componentes estão no mesmo galpão, dá pra montar.
-- O agrupamento anterior por (empresa_dona, galpão) era estrito demais:
-- excluía galpões onde os componentes pertenciam a empresas diferentes.
--
-- O filtro `p_empresa_dona_id` continua disponível (ex: "quantos kits dá
-- pra montar usando SÓ estoque da NetAir?") mas agora não é grouping key.

CREATE OR REPLACE FUNCTION wms_kit_disponivel(
  p_kit_id uuid,
  p_empresa_dona_id uuid DEFAULT NULL,
  p_galpao_id uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
STABLE
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
      AND (p_empresa_dona_id IS NULL OR e.empresa_dona_id = p_empresa_dona_id)
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

COMMENT ON FUNCTION wms_kit_disponivel(uuid, uuid, uuid) IS
  'Quantos kits podem ser montados (soma por galpão — agrupamento físico, independente da empresa dona). Filtros opcionais.';


-- Breakdown por galpão — sem coluna de empresa.
CREATE OR REPLACE FUNCTION wms_kit_disponivel_por_galpao(
  p_kit_id uuid,
  p_empresa_dona_id uuid DEFAULT NULL
)
RETURNS TABLE (
  galpao_id uuid,
  galpao_nome text,
  disponivel_kits numeric,
  gargalo_componente_id uuid,
  gargalo_componente_sku text,
  gargalo_disponivel numeric,
  empresas_contribuindo text
)
LANGUAGE sql
STABLE
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
    JOIN siso_estoque e
      ON e.produto_id = c.componente_produto_id
      AND (p_empresa_dona_id IS NULL OR e.empresa_dona_id = p_empresa_dona_id)
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
  ),
  empresas_por_galpao AS (
    SELECT
      e.galpao_id,
      string_agg(DISTINCT emp.nome, ', ' ORDER BY emp.nome) AS nomes
    FROM siso_estoque e
    JOIN siso_empresas emp ON emp.id = e.empresa_dona_id
    JOIN composicao c ON c.componente_produto_id = e.produto_id
    WHERE e.disponivel > 0
      AND (p_empresa_dona_id IS NULL OR e.empresa_dona_id = p_empresa_dona_id)
    GROUP BY e.galpao_id
  )
  SELECT
    pg.galpao_id,
    galp.nome AS galpao_nome,
    pg.kits AS disponivel_kits,
    g.gargalo_componente_id,
    prod.sku AS gargalo_componente_sku,
    g.gargalo_disponivel,
    epg.nomes AS empresas_contribuindo
  FROM per_galpao_valido pg
  JOIN gargalo g ON g.galpao_id = pg.galpao_id
  JOIN siso_galpoes galp ON galp.id = pg.galpao_id
  LEFT JOIN siso_produtos prod ON prod.id = g.gargalo_componente_id
  LEFT JOIN empresas_por_galpao epg ON epg.galpao_id = pg.galpao_id
  ORDER BY pg.kits DESC, galp.nome;
$$;

COMMENT ON FUNCTION wms_kit_disponivel_por_galpao(uuid, uuid) IS
  'Breakdown de kits montáveis por galpão (físico). Lista também as empresas donas contribuindo com estoque.';
