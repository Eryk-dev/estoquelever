-- [P2-INV-01 / P3-16] Inventário — UNIQUE real de contagens por tripla+operador
-- + métrica de localização ordenada por tempo.
--
-- ── P2-INV-01 ──────────────────────────────────────────────────────────────
-- O JSDoc de registrarContagem (inventario.ts) afirmava que a tabela tinha
-- UNIQUE(sessao_id, localizacao_id, produto_id, contada_por). NUNCA existiu:
-- o índice original era quádruplo COM empresa_dona_id (20260529_wms_inventario
-- :85) e sumiu junto com a coluna no DROP COLUMN (20260520i). O `rodada` também
-- foi dropado (20260512). Resultado: registrarContagemSimples fazia check-then-act
-- (SELECT prévia → UPDATE | INSERT) SEM constraint — duas chamadas concorrentes do
-- mesmo operador na mesma tripla inserem 2 rows; a partir daí o .maybeSingle()
-- do check estoura ("multiple rows") e TRAVA a tripla pro operador.
--
-- Fix: (1) dedup das duplicatas pré-existentes (soma na row mais antiga, deleta o
-- resto); (2) cria o UNIQUE prometido.
--
-- ⚠ A sessão contínua "Contagens operacionais" (continua=true) registra 1 INSERT
-- por evento de acerto-no-pick via wms_contagem_inline_atomica (sem unique
-- disponível, comentário no 20260605). Com o UNIQUE novo esse INSERT colidiria.
-- (3) recria a RPC pra fazer UPSERT incremental — consolida em 1 row por
-- tripla+operador (consistente com a semântica 'incremental' do
-- registrarContagemSimples). A acuracidade aplicada do inline vive em
-- divergencias + movs do ledger, não na contagem de rows; e computarDivergencias
-- é hard-guard contra continua=true (INV-03), então consolidar não altera saldo.
--
-- ── P3-16 ──────────────────────────────────────────────────────────────────
-- wms_metricas_localizacao amostrava "últimas 5000 locs" por `ORDER BY id DESC`
-- (uuid v4 aleatório = amostra aleatória, não temporal). Troca pra
-- contagem_finalizada_em DESC NULLS LAST (coluna temporal real).

BEGIN;

-- 1) Dedup pré-existente: para CADA grupo (sessao, loc, produto, contada_por)
--    com count > 1, soma qty_contada na row mais antiga (menor criado_em) e
--    deleta as demais. Só toca grupos duplicados (NOT a row vencedora).
WITH grupos AS (
  SELECT
    id,
    qty_contada,
    first_value(id) OVER w           AS keep_id,
    sum(qty_contada) OVER w          AS soma_qty,
    count(*) OVER w                  AS n
  FROM siso_inventario_contagens
  WINDOW w AS (
    PARTITION BY sessao_id, localizacao_id, produto_id, contada_por
    ORDER BY criado_em ASC, id ASC
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  )
),
vencedoras AS (
  SELECT DISTINCT keep_id, soma_qty
  FROM grupos
  WHERE n > 1
)
UPDATE siso_inventario_contagens c
   SET qty_contada = v.soma_qty
  FROM vencedoras v
 WHERE c.id = v.keep_id;

-- Deleta as extras (não-vencedoras) dos grupos duplicados.
WITH grupos AS (
  SELECT
    id,
    first_value(id) OVER w  AS keep_id,
    count(*) OVER w         AS n
  FROM siso_inventario_contagens
  WINDOW w AS (
    PARTITION BY sessao_id, localizacao_id, produto_id, contada_por
    ORDER BY criado_em ASC, id ASC
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  )
)
DELETE FROM siso_inventario_contagens c
 USING grupos g
 WHERE c.id = g.id
   AND g.n > 1
   AND g.id <> g.keep_id;

-- 2) UNIQUE real (o que o JSDoc sempre prometeu).
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventario_contagens_tripla_operador
  ON siso_inventario_contagens(sessao_id, localizacao_id, produto_id, contada_por);

-- 3) RPC inline: contagem agora UPSERT incremental (coexiste com o UNIQUE).
--    Corpo base: 20260605_rpc_contagem_inline_atomica.sql — única mudança é o
--    INSERT da contagem (linha 73) virar ON CONFLICT DO UPDATE incremental.
CREATE OR REPLACE FUNCTION wms_contagem_inline_atomica(
  p_produto_id uuid,
  p_galpao_id uuid,
  p_localizacao_id uuid,
  p_qty_contada numeric,
  p_contada_por uuid,
  p_sessao_id uuid,
  p_sku text DEFAULT NULL,
  p_pedido_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_saldo    numeric;
  v_delta    numeric;
  v_mov_id   uuid := NULL;
  v_cont_id  uuid;
  v_div_id   uuid;
BEGIN
  IF p_qty_contada < 0 THEN
    RAISE EXCEPTION 'qty_contada não pode ser negativa' USING ERRCODE = '22023';
  END IF;

  -- Lock pessimista da linha de estoque (impede contagens concorrentes na mesma
  -- tripla de divergirem). COALESCE saldo 0 se a posição ainda não existe.
  SELECT COALESCE(saldo, 0) INTO v_saldo
    FROM siso_estoque
   WHERE produto_id = p_produto_id
     AND galpao_id = p_galpao_id
     AND localizacao_id = p_localizacao_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_saldo := 0;
  END IF;

  v_delta := p_qty_contada - v_saldo;

  IF v_delta <> 0 THEN
    -- divergencia_id por evento (gen_random_uuid) satisfaz o índice parcial
    -- uniq_movs_inventario_divergencia sem colidir entre contagens repetidas.
    v_mov_id := wms_inserir_movimentacao(
      p_produto_id     := p_produto_id,
      p_galpao_id      := p_galpao_id,
      p_localizacao_id := p_localizacao_id,
      p_tipo           := CASE WHEN v_delta > 0 THEN 'E' ELSE 'S' END,
      p_quantidade     := abs(v_delta),
      p_origem_tipo    := CASE WHEN v_delta > 0 THEN 'inventario_ganho' ELSE 'inventario_perda' END,
      p_origem_id      := p_sessao_id::text,
      p_origem_detalhes := jsonb_build_object(
        'divergencia_id', gen_random_uuid(),
        'contexto', 'acerto_pick',
        'sku', p_sku,
        'pedido_id', p_pedido_id
      ),
      p_usuario_id     := p_contada_por,
      p_motivo         := 'Acerto de prateleira no pick'
    );
  END IF;

  -- loc como membro da sessão (metrica_localizacao lê daqui).
  INSERT INTO siso_inventario_localizacoes (sessao_id, localizacao_id, status, motivo)
  VALUES (p_sessao_id, p_localizacao_id, 'contada', 'manual')
  ON CONFLICT (sessao_id, localizacao_id) DO UPDATE SET status = 'contada';

  -- contagem oficial — [P2-INV-01] UNIQUE(sessao,loc,produto,operador) agora
  -- existe → UPSERT incremental (cada acerto soma na row do operador) em vez de
  -- 1 row por evento. Consistente com registrarContagemSimples('incremental').
  INSERT INTO siso_inventario_contagens (sessao_id, localizacao_id, produto_id, qty_contada, contada_por)
  VALUES (p_sessao_id, p_localizacao_id, p_produto_id, p_qty_contada, p_contada_por)
  ON CONFLICT (sessao_id, localizacao_id, produto_id, contada_por) DO UPDATE
    SET qty_contada = siso_inventario_contagens.qty_contada + EXCLUDED.qty_contada
  RETURNING id INTO v_cont_id;

  -- divergência aplicada — UNIQUE 3D (sessao, loc, produto).
  INSERT INTO siso_inventario_divergencias
    (sessao_id, localizacao_id, produto_id, saldo_sistema, qty_contada_final,
     status, mov_aplicada_id, resolucao_por, resolucao_em)
  VALUES (p_sessao_id, p_localizacao_id, p_produto_id, v_saldo, p_qty_contada,
          'aplicada', v_mov_id, p_contada_por, now())
  ON CONFLICT (sessao_id, localizacao_id, produto_id) DO UPDATE
    SET saldo_sistema     = EXCLUDED.saldo_sistema,
        qty_contada_final = EXCLUDED.qty_contada_final,
        status            = 'aplicada',
        mov_aplicada_id   = EXCLUDED.mov_aplicada_id,
        resolucao_por     = EXCLUDED.resolucao_por,
        resolucao_em      = EXCLUDED.resolucao_em
  RETURNING id INTO v_div_id;

  -- última contagem (explícito — não depende do trigger AFTER INSERT).
  UPDATE siso_localizacoes SET ultima_contagem_em = now() WHERE id = p_localizacao_id;

  RETURN jsonb_build_object(
    'contagem_id', v_cont_id,
    'divergencia_id', v_div_id,
    'mov_reconciliacao_id', v_mov_id,
    'saldo_anterior', v_saldo,
    'delta', v_delta
  );
END;
$$;

-- 4) [P3-16] Métrica de localização ordenada por tempo (não por uuid aleatório).
--    Corpo base: 20260529_wms_metricas.sql — única mudança é o ORDER BY da
--    subquery das "últimas 5000 locs" (id DESC → contagem_finalizada_em DESC).
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
  WHERE il.id IN (
    SELECT id FROM siso_inventario_localizacoes
    ORDER BY contagem_finalizada_em DESC NULLS LAST
    LIMIT 5000
  )
  GROUP BY l.id, l.codigo
  ORDER BY 5 DESC NULLS LAST;
$$;

COMMIT;
