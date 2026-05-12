-- RPC: última contagem de inventário por produto+loc+dona.
-- Usada na aba "Movimentações" do produto pra mostrar "conferido em X"
-- mesmo quando a contagem não gerou divergência (e portanto não há mov no ledger).

CREATE OR REPLACE FUNCTION wms_produto_ultimas_contagens(p_produto_id uuid)
RETURNS TABLE (
  localizacao_id uuid,
  loc_codigo text,
  loc_tipo text,
  galpao_id uuid,
  galpao_nome text,
  empresa_dona_id uuid,
  empresa_nome text,
  qty_contada numeric,
  contada_por uuid,
  contada_por_nome text,
  contada_em timestamptz,
  sessao_id uuid,
  sessao_nome text,
  sessao_status text,
  saldo_atual numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH ultimas AS (
    SELECT DISTINCT ON (c.localizacao_id, c.empresa_dona_id)
      c.localizacao_id,
      c.empresa_dona_id,
      c.qty_contada,
      c.contada_por,
      c.criado_em AS contada_em,
      c.sessao_id
    FROM siso_inventario_contagens c
    JOIN siso_inventario_sessoes s ON s.id = c.sessao_id
    WHERE c.produto_id = p_produto_id
      AND s.status <> 'cancelada'
    ORDER BY c.localizacao_id, c.empresa_dona_id, c.criado_em DESC
  )
  SELECT
    u.localizacao_id,
    l.codigo                              AS loc_codigo,
    l.tipo                                AS loc_tipo,
    l.galpao_id,
    g.nome                                AS galpao_nome,
    u.empresa_dona_id,
    e.nome                                AS empresa_nome,
    u.qty_contada,
    u.contada_por,
    usr.nome                              AS contada_por_nome,
    u.contada_em,
    u.sessao_id,
    sess.nome                             AS sessao_nome,
    sess.status                           AS sessao_status,
    COALESCE(est.saldo, 0)                AS saldo_atual
  FROM ultimas u
  JOIN siso_localizacoes l         ON l.id = u.localizacao_id
  JOIN siso_galpoes g              ON g.id = l.galpao_id
  JOIN siso_empresas e             ON e.id = u.empresa_dona_id
  LEFT JOIN siso_usuarios usr      ON usr.id = u.contada_por
  JOIN siso_inventario_sessoes sess ON sess.id = u.sessao_id
  LEFT JOIN siso_estoque est       ON est.produto_id      = p_produto_id
                                  AND est.localizacao_id  = u.localizacao_id
                                  AND est.empresa_dona_id = u.empresa_dona_id
  ORDER BY u.contada_em DESC;
$$;

COMMENT ON FUNCTION wms_produto_ultimas_contagens(uuid) IS
  'Retorna a última contagem de inventário de um produto por (localização, empresa dona). Inclui contagens de sessões em qualquer status menos "cancelada". Mostra também o saldo atual da quádrupla pra comparação.';
