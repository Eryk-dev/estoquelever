-- [PERF-T2] Counts de separação em 1 query (substitui 9 HEAD-counts paralelos).
-- A rota /api/wms/separacao disparava 9 HEAD-counts (um por status_separacao),
-- cada um um round-trip ao Postgres. Esta RPC agrega tudo num único GROUP BY
-- com filtros idênticos aos da rota (galpão NÃO filtra aguardando_compra,
-- empresa, marketplace, tag, busca por numero/id_pedido_ecommerce/cliente/
-- pedido_ids casados por SKU). Retorna jsonb {status: count}; '{}' se vazio.
-- O TS faz Number(data?.[status] ?? 0) pra cada um dos 9.
BEGIN;

CREATE OR REPLACE FUNCTION wms_separacao_counts(
  p_galpao_id uuid DEFAULT NULL,
  p_empresa_id uuid DEFAULT NULL,
  p_marketplace text DEFAULT NULL,
  p_tag text DEFAULT NULL,
  p_busca text DEFAULT NULL,
  p_busca_pedido_ids text[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_object_agg(status_separacao, cnt), '{}'::jsonb)
  FROM (
    SELECT status_separacao, count(*) AS cnt
    FROM siso_pedidos
    WHERE status_separacao IN (
        'aguardando_compra','aguardando_nf','validacao_oc','aguardando_separacao',
        'em_separacao','separado','embalado','conferido','pendente_realocacao'
      )
      -- galpão NÃO filtra aguardando_compra (réplica do guard na rota)
      AND (p_galpao_id IS NULL OR status_separacao = 'aguardando_compra' OR separacao_galpao_id = p_galpao_id)
      AND (p_empresa_id IS NULL OR empresa_origem_id = p_empresa_id)
      AND (p_marketplace IS NULL OR nome_ecommerce ILIKE '%' || p_marketplace || '%')
      AND (p_tag IS NULL OR separacao_tags @> ARRAY[p_tag])
      AND (
        p_busca IS NULL
        OR numero ILIKE '%' || p_busca || '%'
        OR id_pedido_ecommerce ILIKE '%' || p_busca || '%'
        OR cliente_nome ILIKE '%' || p_busca || '%'
        OR (p_busca_pedido_ids IS NOT NULL AND id = ANY(p_busca_pedido_ids))
      )
    GROUP BY status_separacao
  ) g;
$$;

COMMENT ON FUNCTION wms_separacao_counts(uuid,uuid,text,text,text,text[]) IS
  '[PERF-T2] Counts de separação por status_separacao numa query (substitui 9 HEAD-counts da rota /api/wms/separacao).';

COMMIT;
