-- WMS: kit disponível agora é calculado POR GALPÃO.
--
-- Antes: SUM(componente.disp) cross-galpão → MIN(SUM/qty). Resultado errado:
-- contava kits que NÃO podem ser montados (componentes em galpões diferentes).
--
-- Agora: pra cada (empresa_dona, galpão), calcula MIN(disp_galpao / qty_kit)
-- exigindo que TODOS os componentes estejam presentes naquele galpão; soma o
-- total ao longo de todos os galpões. Adiciona também uma RPC de breakdown.

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
      e.empresa_dona_id,
      e.galpao_id,
      c.componente_produto_id,
      c.qty_kit,
      SUM(e.disponivel) AS disp
    FROM composicao c
    JOIN siso_estoque e
      ON e.produto_id = c.componente_produto_id
      AND (p_empresa_dona_id IS NULL OR e.empresa_dona_id = p_empresa_dona_id)
      AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)
    GROUP BY e.empresa_dona_id, e.galpao_id, c.componente_produto_id, c.qty_kit
  ),
  kits_por_galpao AS (
    SELECT
      empresa_dona_id,
      galpao_id,
      MIN(FLOOR(disp / qty_kit))::numeric AS kits
    FROM por_galpao_comp
    GROUP BY empresa_dona_id, galpao_id
    HAVING COUNT(DISTINCT componente_produto_id) = (SELECT n FROM num_componentes)
       AND (SELECT n FROM num_componentes) > 0
  )
  SELECT COALESCE(SUM(kits), 0)::numeric FROM kits_por_galpao;
$$;

COMMENT ON FUNCTION wms_kit_disponivel(uuid, uuid, uuid) IS
  'Quantos kits podem ser montados (soma por galpão — cada galpão precisa ter todos os componentes). Filtros opcionais por empresa/galpão.';


-- Breakdown por (empresa_dona, galpão) — pra mostrar na UI.
CREATE OR REPLACE FUNCTION wms_kit_disponivel_por_galpao(
  p_kit_id uuid,
  p_empresa_dona_id uuid DEFAULT NULL
)
RETURNS TABLE (
  empresa_dona_id uuid,
  empresa_nome text,
  galpao_id uuid,
  galpao_nome text,
  disponivel_kits numeric,
  gargalo_componente_id uuid,
  gargalo_componente_sku text,
  gargalo_disponivel numeric
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
      e.empresa_dona_id,
      e.galpao_id,
      c.componente_produto_id,
      c.qty_kit,
      SUM(e.disponivel) AS disp,
      FLOOR(SUM(e.disponivel) / c.qty_kit)::numeric AS kits_possiveis
    FROM composicao c
    JOIN siso_estoque e
      ON e.produto_id = c.componente_produto_id
      AND (p_empresa_dona_id IS NULL OR e.empresa_dona_id = p_empresa_dona_id)
    GROUP BY e.empresa_dona_id, e.galpao_id, c.componente_produto_id, c.qty_kit
  ),
  per_galpao AS (
    SELECT
      empresa_dona_id,
      galpao_id,
      MIN(kits_possiveis) AS kits,
      COUNT(DISTINCT componente_produto_id) AS comp_count
    FROM por_galpao_comp
    GROUP BY empresa_dona_id, galpao_id
  ),
  per_galpao_valido AS (
    SELECT pg.empresa_dona_id, pg.galpao_id, pg.kits
    FROM per_galpao pg
    WHERE pg.comp_count = (SELECT n FROM num_componentes)
      AND (SELECT n FROM num_componentes) > 0
  ),
  gargalo AS (
    SELECT DISTINCT ON (p.empresa_dona_id, p.galpao_id)
      p.empresa_dona_id,
      p.galpao_id,
      p.componente_produto_id AS gargalo_componente_id,
      p.disp AS gargalo_disponivel
    FROM por_galpao_comp p
    JOIN per_galpao_valido pg
      ON pg.empresa_dona_id = p.empresa_dona_id
     AND pg.galpao_id = p.galpao_id
    ORDER BY p.empresa_dona_id, p.galpao_id, p.kits_possiveis, p.componente_produto_id
  )
  SELECT
    pg.empresa_dona_id,
    emp.nome AS empresa_nome,
    pg.galpao_id,
    galp.nome AS galpao_nome,
    pg.kits AS disponivel_kits,
    g.gargalo_componente_id,
    prod.sku AS gargalo_componente_sku,
    g.gargalo_disponivel
  FROM per_galpao_valido pg
  JOIN gargalo g
    ON g.empresa_dona_id = pg.empresa_dona_id
   AND g.galpao_id = pg.galpao_id
  JOIN siso_empresas emp ON emp.id = pg.empresa_dona_id
  JOIN siso_galpoes  galp ON galp.id = pg.galpao_id
  LEFT JOIN siso_produtos prod ON prod.id = g.gargalo_componente_id
  ORDER BY pg.kits DESC, galp.nome, emp.nome;
$$;

COMMENT ON FUNCTION wms_kit_disponivel_por_galpao(uuid, uuid) IS
  'Breakdown de kits montáveis por (empresa_dona, galpão) com gargalo identificado. Filtro opcional por empresa.';
