-- Encaixotamento por dia — etapa pós-separação na pista FUTURA.
--
-- Depois que o operador pica a onda futura (status_separacao='separado',
-- separacao_futura=true), o carrinho fica cheio de peças misturadas. Esta etapa
-- distribui o carrinho em CAIXAS = DIA de despacho (DATE de prazo_envio): o
-- operador bipa SKU/EAN + qty e o sistema diz em qual(is) caixa(s) depositar e
-- quanto. Tracking no banco (sobrevive reload / multi-operador).
--
-- NÃO muda status_separacao (continua 'separado'; quem avança é a promoção da
-- etiqueta). encaixotado_em é só marca de "caixa fechada" (pedido 100% encaixotado).

BEGIN;

-- Quanto de cada item já foi depositado na caixa do seu dia.
ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS quantidade_encaixotada integer NOT NULL DEFAULT 0
    CHECK (quantidade_encaixotada >= 0);

-- Marca quando o pedido ficou 100% encaixotado (todos os itens depositados).
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS encaixotado_em timestamptz;

-- ── RPC atômica: aloca p_qty do código bipado nas caixas (dias) ──────────────
-- Varre os itens de pedidos FUTURA já separados que precisam do código, FIFO por
-- prazo_envio (caixa mais urgente primeiro), e deposita até esgotar p_qty. Lock
-- pessimista (FOR UPDATE) serializa operadores bipando o mesmo SKU. Devolve a
-- quebra por dia + sobra (qty que não coube em nenhum pedido).
CREATE OR REPLACE FUNCTION wms_encaixotar_atomico(
  p_codigo text,
  p_qty integer
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_codigo text := upper(trim(p_codigo));
  v_sku text;
  v_descricao text;
  v_imagem text;
  v_restante integer := p_qty;
  v_alvo integer;
  v_alocar integer;
  v_item record;
  v_alocacoes jsonb := '[]'::jsonb;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'qty_invalida' USING ERRCODE = '22023';
  END IF;

  -- Resolve o SKU canônico (caso o operador bipe o EAN/GTIN do produto).
  SELECT sku, descricao, imagem_url INTO v_sku, v_descricao, v_imagem
  FROM siso_produtos
  WHERE upper(sku) = v_codigo OR upper(gtin) = v_codigo
  LIMIT 1;

  FOR v_item IN
    SELECT pi.id,
           pi.pedido_id,
           COALESCE(pi.quantidade_pega, pi.quantidade_pedida) AS alvo,
           COALESCE(pi.quantidade_encaixotada, 0)             AS feito,
           p.prazo_envio,
           p.numero
    FROM siso_pedido_itens pi
    JOIN siso_pedidos p ON p.id = pi.pedido_id
    WHERE p.separacao_futura = true
      AND p.status_separacao = 'separado'
      AND COALESCE(pi.quantidade_pega, pi.quantidade_pedida) > COALESCE(pi.quantidade_encaixotada, 0)
      AND (
        upper(pi.sku) = v_codigo
        OR upper(pi.gtin) = v_codigo
        OR (v_sku IS NOT NULL AND upper(pi.sku) = upper(v_sku))
      )
    ORDER BY p.prazo_envio ASC NULLS LAST, p.id ASC
    FOR UPDATE OF pi
  LOOP
    EXIT WHEN v_restante <= 0;
    v_alvo := v_item.alvo - v_item.feito;
    v_alocar := LEAST(v_restante, v_alvo);
    IF v_alocar <= 0 THEN CONTINUE; END IF;

    UPDATE siso_pedido_itens
      SET quantidade_encaixotada = COALESCE(quantidade_encaixotada, 0) + v_alocar
      WHERE id = v_item.id;

    v_restante := v_restante - v_alocar;

    v_alocacoes := v_alocacoes || jsonb_build_object(
      'pedido_id', v_item.pedido_id,
      'pedido_item_id', v_item.id,
      'numero', v_item.numero,
      'prazo_envio', v_item.prazo_envio,
      -- prazo_envio é ISO com offset -03:00; os 10 primeiros chars = dia local.
      'dia', left(v_item.prazo_envio, 10),
      'qty', v_alocar
    );
  END LOOP;

  -- Fecha (encaixotado_em) os pedidos que ficaram 100% encaixotados.
  UPDATE siso_pedidos p
    SET encaixotado_em = now()
    WHERE p.encaixotado_em IS NULL
      AND p.id IN (SELECT DISTINCT (e->>'pedido_id') FROM jsonb_array_elements(v_alocacoes) e)
      AND NOT EXISTS (
        SELECT 1 FROM siso_pedido_itens pi
        WHERE pi.pedido_id = p.id
          AND COALESCE(pi.quantidade_pega, pi.quantidade_pedida) > COALESCE(pi.quantidade_encaixotada, 0)
      );

  RETURN jsonb_build_object(
    'codigo', p_codigo,
    'sku', v_sku,
    'descricao', v_descricao,
    'imagem_url', v_imagem,
    'qty_pedida', p_qty,
    'qty_alocada', p_qty - v_restante,
    'sobra', v_restante,
    'alocacoes', v_alocacoes
  );
END;
$$;

-- ── RPC atômica: desfaz um conjunto de alocações (undo do último bip) ─────────
CREATE OR REPLACE FUNCTION wms_desencaixotar_atomico(
  p_alocacoes jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_a jsonb;
  v_pedidos text[] := '{}';
BEGIN
  FOR v_a IN SELECT * FROM jsonb_array_elements(p_alocacoes)
  LOOP
    UPDATE siso_pedido_itens
      SET quantidade_encaixotada = GREATEST(0, COALESCE(quantidade_encaixotada, 0) - (v_a->>'qty')::integer)
      WHERE id = (v_a->>'pedido_item_id')::uuid;
    v_pedidos := array_append(v_pedidos, (v_a->>'pedido_id'));
  END LOOP;

  -- Reabre as caixas que deixaram de estar 100% após o estorno.
  UPDATE siso_pedidos p
    SET encaixotado_em = NULL
    WHERE p.id = ANY(v_pedidos)
      AND p.encaixotado_em IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM siso_pedido_itens pi
        WHERE pi.pedido_id = p.id
          AND COALESCE(pi.quantidade_pega, pi.quantidade_pedida) > COALESCE(pi.quantidade_encaixotada, 0)
      );

  RETURN jsonb_build_object('ok', true);
END;
$$;

COMMIT;
