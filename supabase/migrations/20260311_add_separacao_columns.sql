-- ============================================================
-- Migration: Separation tracking columns, indexes, and PL/pgSQL function
-- PRD 1/7 — Separação: Schema + Dados Base (US-001)
-- ============================================================

-- siso_pedidos: separation tracking
ALTER TABLE siso_pedidos
  ADD COLUMN status_separacao text DEFAULT NULL
    CHECK (status_separacao IS NULL OR status_separacao IN ('aguardando_nf', 'pendente', 'em_separacao', 'embalado', 'expedido', 'cancelado')),
  ADD COLUMN separacao_galpao_id uuid REFERENCES siso_galpoes(id),
  ADD COLUMN separado_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN separado_em timestamptz,
  ADD COLUMN embalado_em timestamptz,
  ADD COLUMN agrupamento_tiny_id bigint,
  ADD COLUMN etiqueta_url text,
  ADD COLUMN etiqueta_status text DEFAULT NULL
    CHECK (etiqueta_status IS NULL OR etiqueta_status IN ('pendente', 'imprimindo', 'impresso', 'falhou')),
  ADD COLUMN url_danfe text,
  ADD COLUMN chave_acesso_nf text;

-- siso_pedido_itens: bip tracking + GTIN
ALTER TABLE siso_pedido_itens
  ADD COLUMN gtin text,
  ADD COLUMN quantidade_bipada integer DEFAULT 0,
  ADD COLUMN bipado_completo boolean DEFAULT false,
  ADD COLUMN bipado_em timestamptz,
  ADD COLUMN bipado_por uuid REFERENCES siso_usuarios(id);

-- siso_pedido_item_estoques: localizacao normalizada
ALTER TABLE siso_pedido_item_estoques
  ADD COLUMN localizacao text;

-- Indexes for separation queries
CREATE INDEX idx_pedidos_separacao_galpao
  ON siso_pedidos (separacao_galpao_id, status_separacao)
  WHERE status_separacao IN ('pendente', 'em_separacao');

CREATE INDEX idx_pedidos_separacao_aguardando
  ON siso_pedidos (separacao_galpao_id)
  WHERE status_separacao = 'aguardando_nf';

CREATE INDEX idx_pedidos_separacao_embalado
  ON siso_pedidos (separacao_galpao_id)
  WHERE status_separacao = 'embalado';

CREATE INDEX idx_pedido_itens_gtin ON siso_pedido_itens (gtin)
  WHERE gtin IS NOT NULL AND bipado_completo = false;

CREATE INDEX idx_pedido_itens_sku ON siso_pedido_itens (sku)
  WHERE bipado_completo = false;

CREATE INDEX idx_pedidos_separacao_data
  ON siso_pedidos (separacao_galpao_id, data ASC)
  WHERE status_separacao IN ('pendente', 'em_separacao');

-- PL/pgSQL function: siso_processar_bip
CREATE OR REPLACE FUNCTION siso_processar_bip(
  p_codigo text,
  p_usuario_id uuid,
  p_galpao_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_item RECORD;
  v_pedido RECORD;
  v_itens_faltam integer;
BEGIN
  -- 1. Find and lock the oldest pending item atomically
  SELECT pi.pedido_id, pi.produto_id, pi.quantidade_bipada, pi.quantidade_pedida,
         pi.sku, p.numero AS pedido_numero, p.status_separacao
  INTO v_item
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  WHERE (pi.gtin = p_codigo OR pi.sku = p_codigo)
    AND pi.bipado_completo = false
    AND p.separacao_galpao_id = p_galpao_id
    AND p.status_separacao IN ('pendente', 'em_separacao')
    AND p.status != 'cancelado'
  ORDER BY p.data ASC
  LIMIT 1
  FOR UPDATE OF pi SKIP LOCKED;

  IF v_item IS NULL THEN
    RETURN jsonb_build_object('status', 'nao_encontrado', 'codigo', p_codigo);
  END IF;

  -- 2. Safety check
  IF v_item.quantidade_bipada >= v_item.quantidade_pedida THEN
    RETURN jsonb_build_object('status', 'ja_completo', 'pedido_id', v_item.pedido_id, 'sku', v_item.sku);
  END IF;

  -- 3. Increment bip
  UPDATE siso_pedido_itens SET
    quantidade_bipada = quantidade_bipada + 1,
    bipado_por = p_usuario_id,
    bipado_completo = (quantidade_bipada + 1 >= quantidade_pedida),
    bipado_em = CASE WHEN (quantidade_bipada + 1 >= quantidade_pedida) THEN now() ELSE bipado_em END
  WHERE pedido_id = v_item.pedido_id AND produto_id = v_item.produto_id;

  -- 4. Transition pendente → em_separacao on first bip
  IF v_item.status_separacao = 'pendente' THEN
    UPDATE siso_pedidos SET
      status_separacao = 'em_separacao',
      separado_por = p_usuario_id,
      separado_em = now()
    WHERE id = v_item.pedido_id AND status_separacao = 'pendente';
  END IF;

  -- 5. Check if all items are complete
  SELECT COUNT(*) FILTER (WHERE bipado_completo = false) INTO v_itens_faltam
  FROM siso_pedido_itens WHERE pedido_id = v_item.pedido_id;

  IF v_itens_faltam = 0 THEN
    UPDATE siso_pedidos SET
      status_separacao = 'embalado',
      embalado_em = now(),
      etiqueta_status = 'pendente'
    WHERE id = v_item.pedido_id;

    RETURN jsonb_build_object(
      'status', 'pedido_completo',
      'pedido_id', v_item.pedido_id,
      'pedido_numero', v_item.pedido_numero,
      'sku', v_item.sku,
      'bipados', v_item.quantidade_bipada + 1,
      'total', v_item.quantidade_pedida
    );
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN (v_item.quantidade_bipada + 1 >= v_item.quantidade_pedida) THEN 'item_completo' ELSE 'parcial' END,
    'pedido_id', v_item.pedido_id,
    'pedido_numero', v_item.pedido_numero,
    'sku', v_item.sku,
    'bipados', v_item.quantidade_bipada + 1,
    'total', v_item.quantidade_pedida,
    'itens_faltam', v_itens_faltam
  );
END;
$$ LANGUAGE plpgsql;
