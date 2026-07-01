-- Separação Full: counts da fila devem separar a lane Full da normal/futura,
-- igual ao que 20260624b fez pra futura. Novo param p_separacao_full (default
-- false = fila normal/futura). A tela /wms/separacao-full passa true.
--
-- O split virtual "separado vs fechado" (fechado_em IS NOT NULL) NÃO entra
-- nesta RPC — segue o mesmo padrão do split "separado vs encaixotado" da
-- futura, que é 1 HEAD-count extra em separacao/route.ts (a RPC só agrega por
-- status_separacao; timestamps virtuais ficam de fora de propósito).

-- Dropa o overload antigo (7 args) — o novo (8 args, com default) cobre todos
-- os callers existentes (param novo cai pro default false). Evita ambiguidade
-- no PostgREST entre as duas assinaturas.
DROP FUNCTION IF EXISTS public.wms_separacao_counts(uuid, uuid, text, text, text, text[], boolean);

CREATE OR REPLACE FUNCTION public.wms_separacao_counts(
  p_galpao_id uuid DEFAULT NULL::uuid,
  p_empresa_id uuid DEFAULT NULL::uuid,
  p_marketplace text DEFAULT NULL::text,
  p_tag text DEFAULT NULL::text,
  p_busca text DEFAULT NULL::text,
  p_busca_pedido_ids text[] DEFAULT NULL::text[],
  p_separacao_futura boolean DEFAULT false,
  p_separacao_full boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT COALESCE(jsonb_object_agg(status_separacao, cnt), '{}'::jsonb)
  FROM (
    SELECT status_separacao, count(*) AS cnt
    FROM siso_pedidos
    WHERE status_separacao IN (
        'aguardando_compra','aguardando_nf','validacao_oc','aguardando_separacao',
        'em_separacao','separado','embalado','conferido','pendente_realocacao'
      )
      AND separacao_futura = p_separacao_futura
      AND separacao_full = p_separacao_full
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
$function$;
