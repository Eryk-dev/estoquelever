-- ============================================================
-- Migration: Exceções de compras (equivalente + cancelamento)
-- ============================================================

ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS compra_equivalente_sku text,
  ADD COLUMN IF NOT EXISTS compra_equivalente_descricao text,
  ADD COLUMN IF NOT EXISTS compra_equivalente_produto_id_tiny bigint,
  ADD COLUMN IF NOT EXISTS compra_equivalente_fornecedor text,
  ADD COLUMN IF NOT EXISTS compra_equivalente_imagem_url text,
  ADD COLUMN IF NOT EXISTS compra_equivalente_gtin text,
  ADD COLUMN IF NOT EXISTS compra_equivalente_observacao text,
  ADD COLUMN IF NOT EXISTS compra_equivalente_definido_em timestamptz,
  ADD COLUMN IF NOT EXISTS compra_equivalente_definido_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN IF NOT EXISTS compra_equivalente_sku_original text,
  ADD COLUMN IF NOT EXISTS compra_equivalente_descricao_original text,
  ADD COLUMN IF NOT EXISTS compra_equivalente_produto_id_original bigint,
  ADD COLUMN IF NOT EXISTS compra_cancelamento_motivo text,
  ADD COLUMN IF NOT EXISTS compra_cancelamento_solicitado_em timestamptz,
  ADD COLUMN IF NOT EXISTS compra_cancelamento_solicitado_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN IF NOT EXISTS compra_cancelado_em timestamptz,
  ADD COLUMN IF NOT EXISTS compra_cancelado_por uuid REFERENCES siso_usuarios(id);

CREATE INDEX IF NOT EXISTS idx_pedido_itens_compra_equivalente_sku
  ON siso_pedido_itens (compra_equivalente_sku)
  WHERE compra_equivalente_sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pedido_itens_compra_cancelado
  ON siso_pedido_itens (pedido_id)
  WHERE compra_status = 'cancelado';

CREATE OR REPLACE FUNCTION siso_consolidar_produtos_separacao(
  p_pedido_ids text[],
  p_order_by text DEFAULT 'localizacao'
)
RETURNS TABLE(
  produto_id text,
  descricao text,
  sku text,
  gtin text,
  quantidade_total numeric,
  unidade text,
  localizacao text
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    pi.produto_id::text,
    pi.descricao,
    pi.sku,
    MAX(pi.gtin),
    SUM(pi.quantidade_pedida),
    'UN'::text AS unidade,
    MAX(pie.localizacao)
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  LEFT JOIN siso_pedido_item_estoques pie
    ON pie.pedido_id = pi.pedido_id
    AND pie.produto_id = pi.produto_id
    AND pie.empresa_id = p.empresa_origem_id
  WHERE pi.pedido_id = ANY(p_pedido_ids)
    AND COALESCE(pi.compra_status, '') <> 'cancelado'
  GROUP BY pi.produto_id, pi.descricao, pi.sku
  ORDER BY
    CASE p_order_by
      WHEN 'sku' THEN pi.sku
      WHEN 'descricao' THEN pi.descricao
      ELSE MAX(pie.localizacao)
    END NULLS LAST;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION siso_processar_bip(
  p_codigo text,
  p_usuario_id uuid,
  p_galpao_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_item RECORD;
  v_itens_faltam integer;
BEGIN
  SELECT pi.pedido_id, pi.produto_id, pi.quantidade_bipada, pi.quantidade_pedida,
         pi.sku, p.numero AS pedido_numero, p.status_separacao
  INTO v_item
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  WHERE (pi.gtin = p_codigo OR pi.sku = p_codigo)
    AND pi.bipado_completo = false
    AND COALESCE(pi.compra_status, '') <> 'cancelado'
    AND p.separacao_galpao_id = p_galpao_id
    AND p.status_separacao IN ('aguardando_separacao', 'em_separacao')
    AND p.status != 'cancelado'
  ORDER BY p.data ASC
  LIMIT 1
  FOR UPDATE OF pi SKIP LOCKED;

  IF v_item IS NULL THEN
    RETURN jsonb_build_object('status', 'nao_encontrado', 'codigo', p_codigo);
  END IF;

  IF v_item.quantidade_bipada >= v_item.quantidade_pedida THEN
    RETURN jsonb_build_object('status', 'ja_completo', 'pedido_id', v_item.pedido_id, 'sku', v_item.sku);
  END IF;

  UPDATE siso_pedido_itens SET
    quantidade_bipada = quantidade_bipada + 1,
    bipado_por = p_usuario_id,
    bipado_completo = (quantidade_bipada + 1 >= quantidade_pedida),
    bipado_em = CASE WHEN (quantidade_bipada + 1 >= quantidade_pedida) THEN now() ELSE bipado_em END
  WHERE pedido_id = v_item.pedido_id
    AND produto_id = v_item.produto_id
    AND COALESCE(compra_status, '') <> 'cancelado';

  IF v_item.status_separacao = 'aguardando_separacao' THEN
    UPDATE siso_pedidos SET
      status_separacao = 'em_separacao',
      separacao_operador_id = p_usuario_id,
      separacao_iniciada_em = now()
    WHERE id = v_item.pedido_id AND status_separacao = 'aguardando_separacao';
  END IF;

  SELECT COUNT(*) FILTER (WHERE bipado_completo = false) INTO v_itens_faltam
  FROM siso_pedido_itens
  WHERE pedido_id = v_item.pedido_id
    AND COALESCE(compra_status, '') <> 'cancelado';

  IF v_itens_faltam = 0 THEN
    UPDATE siso_pedidos SET
      status_separacao = 'embalado',
      embalagem_concluida_em = now(),
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

CREATE OR REPLACE FUNCTION siso_processar_bip_embalagem(
  p_sku text,
  p_galpao_id uuid,
  p_quantidade int DEFAULT 1
)
RETURNS TABLE(
  pedido_id text,
  produto_id text,
  quantidade_bipada numeric,
  bipado_completo boolean,
  pedido_completo boolean,
  etiqueta_empresa_origem_id text,
  etiqueta_agrupamento_id text,
  etiqueta_zpl text,
  etiqueta_url text,
  etiqueta_galpao_id text,
  etiqueta_operador_id text,
  etiqueta_numero text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id uuid;
  v_pedido_id text;
  v_produto_id bigint;
  v_qtd_bipada integer;
  v_qtd_pedida numeric;
  v_bipado_completo boolean;
  v_pedido_completo boolean;
  v_itens_pendentes integer;
  v_empresa_origem_id text;
  v_agrupamento_id text;
  v_etiqueta_zpl text;
  v_etiqueta_url text;
  v_galpao_id text;
  v_operador_id text;
  v_numero text;
BEGIN
  SELECT i.id, i.pedido_id, i.produto_id, i.quantidade_bipada, i.quantidade_pedida
  INTO v_item_id, v_pedido_id, v_produto_id, v_qtd_bipada, v_qtd_pedida
  FROM siso_pedido_itens i
  JOIN siso_pedidos p ON p.id = i.pedido_id
  JOIN siso_empresas e ON e.id = p.empresa_origem_id
  WHERE p.status_separacao = 'separado'
    AND e.galpao_id = p_galpao_id
    AND (i.sku = p_sku OR i.gtin = p_sku)
    AND i.bipado_completo = false
    AND COALESCE(i.compra_status, '') <> 'cancelado'
  ORDER BY p.data ASC
  LIMIT 1
  FOR UPDATE OF i;

  IF v_item_id IS NULL THEN
    RETURN;
  END IF;

  v_qtd_bipada := COALESCE(v_qtd_bipada, 0) + p_quantidade;
  v_bipado_completo := (v_qtd_bipada >= v_qtd_pedida);

  UPDATE siso_pedido_itens
  SET quantidade_bipada = v_qtd_bipada,
      bipado_completo = v_bipado_completo
  WHERE id = v_item_id;

  SELECT COUNT(*)
  INTO v_itens_pendentes
  FROM siso_pedido_itens
  WHERE siso_pedido_itens.pedido_id = v_pedido_id
    AND bipado_completo = false
    AND COALESCE(siso_pedido_itens.compra_status, '') <> 'cancelado';

  v_pedido_completo := (v_itens_pendentes = 0);

  IF v_pedido_completo THEN
    UPDATE siso_pedidos
    SET status_separacao = 'embalado',
        embalagem_concluida_em = now()
    WHERE id = v_pedido_id;

    UPDATE siso_pedidos
    SET etiqueta_status = 'imprimindo',
        updated_at = now()
    WHERE id = v_pedido_id
      AND (etiqueta_status IS NULL OR etiqueta_status IN ('pendente', 'falhou'))
    RETURNING
      empresa_origem_id,
      agrupamento_expedicao_id,
      siso_pedidos.etiqueta_zpl,
      siso_pedidos.etiqueta_url,
      separacao_galpao_id::text,
      separacao_operador_id::text,
      numero
    INTO
      v_empresa_origem_id,
      v_agrupamento_id,
      v_etiqueta_zpl,
      v_etiqueta_url,
      v_galpao_id,
      v_operador_id,
      v_numero;
  END IF;

  RETURN QUERY SELECT
    v_pedido_id,
    v_produto_id::text,
    v_qtd_bipada::numeric,
    v_bipado_completo,
    v_pedido_completo,
    v_empresa_origem_id,
    v_agrupamento_id,
    v_etiqueta_zpl,
    v_etiqueta_url,
    v_galpao_id,
    v_operador_id,
    v_numero;
END;
$$;
