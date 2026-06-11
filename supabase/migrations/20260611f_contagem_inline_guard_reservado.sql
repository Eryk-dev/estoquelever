-- [INV-04] Contagem inline (acerto de prateleira no pick): perda que derrubaria
-- o saldo abaixo do reservado vivo estourava o CHECK (reservado <= saldo) com
-- 23514 cru → 500 genérico no handheld (OC "Encontrei"), sem orientação.
-- Fix: pré-check `qty_contada < reservado` na perda com RAISE estruturado
-- (produto, loc, saldo, reservado + ação corretiva). O caller TS
-- (validar-oc-item) mapeia a mensagem pra 409. Sem auto-liberar R de pedidos —
-- decisão de escopo: só superfície de erro.
-- Corpo base: 20260605_rpc_contagem_inline_atomica.sql — mudanças marcadas
-- '-- [INV-04]'.
BEGIN;

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
  v_saldo     numeric;
  v_reservado numeric;   -- [INV-04]
  v_delta     numeric;
  v_mov_id    uuid := NULL;
  v_cont_id   uuid;
  v_div_id    uuid;
BEGIN
  IF p_qty_contada < 0 THEN
    RAISE EXCEPTION 'qty_contada não pode ser negativa' USING ERRCODE = '22023';
  END IF;

  -- Lock pessimista da linha de estoque (impede contagens concorrentes na mesma
  -- tripla de divergirem). COALESCE saldo 0 se a posição ainda não existe.
  SELECT COALESCE(saldo, 0), COALESCE(reservado, 0) INTO v_saldo, v_reservado   -- [INV-04] + reservado
    FROM siso_estoque
   WHERE produto_id = p_produto_id
     AND galpao_id = p_galpao_id
     AND localizacao_id = p_localizacao_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_saldo := 0;
    v_reservado := 0;   -- [INV-04]
  END IF;

  v_delta := p_qty_contada - v_saldo;

  -- [INV-04] Perda que deixaria saldo < reservado vivo: o UPDATE do cache
  -- violaria o CHECK (reservado <= saldo) com 23514 cru. Pré-checa e RAISE
  -- orientado — o operador/supervisor precisa liberar ou realocar as reservas
  -- (pedidos vivos apontando pra essa loc) antes de aplicar a perda.
  IF v_delta < 0 AND p_qty_contada < v_reservado THEN
    RAISE EXCEPTION 'contagem bloqueada: contado % deixaria o saldo abaixo do reservado % (produto %, loc %, saldo atual %) — libere ou realoque as reservas antes de aplicar a perda',
      p_qty_contada, v_reservado,
      COALESCE(p_sku, (SELECT sku FROM siso_produtos WHERE id = p_produto_id)),
      (SELECT codigo FROM siso_localizacoes WHERE id = p_localizacao_id),
      v_saldo
      USING ERRCODE = '22023';
  END IF;

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

  -- contagem oficial — sem unique disponível → INSERT por evento.
  INSERT INTO siso_inventario_contagens (sessao_id, localizacao_id, produto_id, qty_contada, contada_por)
  VALUES (p_sessao_id, p_localizacao_id, p_produto_id, p_qty_contada, p_contada_por)
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

COMMENT ON FUNCTION wms_contagem_inline_atomica(uuid,uuid,uuid,numeric,uuid,uuid,text,text) IS
  '[P057] Contagem inline atômica + [INV-04] pré-check de perda abaixo do reservado com erro orientado (em vez de 23514 cru).';

COMMIT;
