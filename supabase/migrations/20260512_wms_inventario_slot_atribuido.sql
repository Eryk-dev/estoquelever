-- ============================================================================
-- WMS · Inventário · slot_atribuido (soft bucketing entre operadores)
-- ============================================================================
-- Permite ao supervisor pré-atribuir cada localização a um slot de operador
-- (OP1..OP5) na hora de criar a sessão. O RPC wms_inventario_proxima_loc
-- prioriza locs com slot_atribuido = slot do operador; quando o bucket
-- próprio esvazia, cai nas regras existentes (continuidade > anti-colisão).
--
-- Sessões antigas (slot_atribuido IS NULL em todas as locs) preservam o
-- comportamento da v2 — nenhum bucket, pull queue puro.
-- ============================================================================

ALTER TABLE siso_inventario_localizacoes
  ADD COLUMN IF NOT EXISTS slot_atribuido smallint NULL
    CHECK (slot_atribuido IS NULL OR (slot_atribuido BETWEEN 1 AND 5));

-- Index parcial — só pra sessões que usam buckets (a maioria das queries
-- da v2 não passa por essa coluna; manter o índice apertado evita custo)
CREATE INDEX IF NOT EXISTS idx_inv_locs_slot_atribuido
  ON siso_inventario_localizacoes(sessao_id, slot_atribuido, status)
  WHERE slot_atribuido IS NOT NULL;

-- ============================================================================
-- RPC: wms_inventario_proxima_loc — adiciona priorização por slot_atribuido
-- ============================================================================
-- Mudança vs versão 20260512_wms_inventario_rewrite.sql: nova prioridade 0
-- antes da continuidade. Se há locs com slot_atribuido = meu slot, elas vêm
-- primeiro. Fallback automático pras regras existentes quando o bucket
-- próprio esvazia.

CREATE OR REPLACE FUNCTION wms_inventario_proxima_loc(
  p_sessao uuid,
  p_user uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_inv_loc_id uuid;
  v_loc_id uuid;
  v_codigo text;
  v_tipo text;
  v_zona text;
  v_modo text;
  v_empresa_dona uuid;
  v_ultima_zona text;
  v_esperados jsonb;
  v_meu_slot smallint;
BEGIN
  -- Confirma que usuário tem slot ativo nesta sessão e descobre qual
  SELECT slot
    INTO v_meu_slot
  FROM siso_inventario_operadores
  WHERE sessao_id = p_sessao
    AND usuario_id = p_user
    AND finalizado_em IS NULL
  LIMIT 1;

  IF v_meu_slot IS NULL THEN
    RAISE EXCEPTION 'usuário não está em nenhum slot ativo desta sessão';
  END IF;

  -- Confirma que sessão está em andamento
  IF NOT EXISTS (
    SELECT 1 FROM siso_inventario_sessoes
    WHERE id = p_sessao AND status = 'em_andamento'
  ) THEN
    RAISE EXCEPTION 'sessão não está em andamento';
  END IF;

  -- Lê configuração da sessão
  SELECT modo_contagem, empresa_dona_id
    INTO v_modo, v_empresa_dona
  FROM siso_inventario_sessoes
  WHERE id = p_sessao;

  -- Descobre zona da última loc deste user (pra priorizar continuidade)
  SELECT COALESCE(loc.zona, split_part(loc.codigo, '-', 1))
    INTO v_ultima_zona
  FROM siso_inventario_localizacoes inv_loc
  JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
  WHERE inv_loc.sessao_id = p_sessao
    AND inv_loc.bloqueada_por = p_user
  ORDER BY inv_loc.bloqueada_em DESC NULLS LAST
  LIMIT 1;

  -- Seleciona a próxima loc com lock atômico (SKIP LOCKED evita race entre ops)
  SELECT inv_loc.id, loc.id, loc.codigo, loc.tipo,
         COALESCE(loc.zona, split_part(loc.codigo, '-', 1))
    INTO v_inv_loc_id, v_loc_id, v_codigo, v_tipo, v_zona
  FROM siso_inventario_localizacoes inv_loc
  JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
  WHERE inv_loc.sessao_id = p_sessao
    AND inv_loc.status = 'pendente'
    AND inv_loc.bloqueada_por IS NULL
  ORDER BY
    -- 0. Bucket próprio: locs com slot_atribuido = meu slot vêm primeiro.
    --    Quando meu bucket esvazia, cai automaticamente nas próximas regras.
    (CASE
      WHEN inv_loc.slot_atribuido = v_meu_slot THEN 0 ELSE 1
    END),
    -- 1. Continuidade: mesma zona da última do user (0 vence 1)
    (CASE
      WHEN v_ultima_zona IS NOT NULL
       AND COALESCE(loc.zona, split_part(loc.codigo, '-', 1)) = v_ultima_zona
      THEN 0 ELSE 1
    END),
    -- 2. Anti-colisão: prefere zona NÃO ocupada por outros operadores ativos
    (CASE
      WHEN COALESCE(loc.zona, split_part(loc.codigo, '-', 1)) IN (
        SELECT DISTINCT COALESCE(loc2.zona, split_part(loc2.codigo, '-', 1))
        FROM siso_inventario_localizacoes il2
        JOIN siso_localizacoes loc2 ON loc2.id = il2.localizacao_id
        WHERE il2.sessao_id = p_sessao
          AND il2.status = 'em_contagem'
          AND il2.bloqueada_por IS NOT NULL
          AND il2.bloqueada_por != p_user
      ) THEN 1 ELSE 0
    END),
    -- 3. Determinístico por código (proximidade lexicográfica)
    loc.codigo ASC
  LIMIT 1
  FOR UPDATE OF inv_loc SKIP LOCKED;

  IF v_inv_loc_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'pool_vazio', true);
  END IF;

  -- Atribui a loc ao usuário
  UPDATE siso_inventario_localizacoes
  SET bloqueada_por = p_user,
      bloqueada_em = now(),
      status = 'em_contagem',
      contagem_iniciada_em = COALESCE(contagem_iniciada_em, now())
  WHERE id = v_inv_loc_id;

  -- Atualiza última ação do operador
  UPDATE siso_inventario_operadores
  SET ultima_acao_em = now()
  WHERE sessao_id = p_sessao
    AND usuario_id = p_user
    AND finalizado_em IS NULL;

  -- Modo aberto: anexa lista de SKUs esperados nesta loc
  IF v_modo = 'aberto' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'produto_id', e.produto_id,
      'sku', p.sku,
      'descricao', p.descricao,
      'saldo_esperado', e.saldo,
      'empresa_dona_id', e.empresa_dona_id
    ))
      INTO v_esperados
    FROM siso_estoque e
    JOIN siso_produtos p ON p.id = e.produto_id
    WHERE e.localizacao_id = v_loc_id
      AND e.saldo > 0
      AND (v_empresa_dona IS NULL OR e.empresa_dona_id = v_empresa_dona);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'pool_vazio', false,
    'inv_loc_id', v_inv_loc_id,
    'loc_id', v_loc_id,
    'codigo', v_codigo,
    'tipo', v_tipo,
    'zona', v_zona,
    'modo', v_modo,
    'esperados', v_esperados
  );
END;
$$;
