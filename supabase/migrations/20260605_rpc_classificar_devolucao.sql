-- [P049/P050/P051/P054] Classificação de devolução atômica e serializada.
--
-- Substitui o caminho do classificarDevolucao que emitia até 3 movs em txs
-- separadas (cada inserirMovimentacao = 1 tx) e SÓ DEPOIS dava UPDATE de status
-- (TOCTOU). Falha no meio deixava saldo subido com status pendente (re-run
-- duplicava); avariado sem quarentena fazia ajuste_manual silencioso.
--
-- Agora: FOR UPDATE na devolução (serializa por linha, P054) + N movs +
-- UPDATE status numa única tx (tudo-ou-nada, P049/P050). Idempotente: status
-- != aguardando_classificacao → no-op { ja_classificada: true }. Avariado sem
-- quarentena: RAISE backstop (TS já valida antes, P051).
--
-- NF/empresa/custo são resolvidos no TS e passados como params. A resolução de
-- quarentena também é feita no TS (guard) e re-validada aqui (backstop).
-- A RPC SETA devolucao_id nas movs criadas (back-fill pelos ids capturados de
-- cada wms_inserir_movimentacao): a assinatura nomeada não tem esse param, e o
-- desclassificarDevolucao busca as movs estritamente por devolucao_id pra
-- estornar — sem o back-fill, reverter não estornaria nada.
BEGIN;

CREATE OR REPLACE FUNCTION wms_classificar_devolucao(
  p_devolucao_id uuid,
  p_classificacao text,
  p_produto_id uuid,
  p_galpao_id uuid,
  p_localizacao_id uuid,
  p_qty numeric,
  p_loc_quarentena_id uuid,
  p_usuario_id uuid,
  p_origem_compartilhado uuid,
  p_nota_fiscal_id uuid DEFAULT NULL,
  p_empresa_referencia_id uuid DEFAULT NULL,
  p_fornecedor_id uuid DEFAULT NULL,
  p_custo_unitario numeric DEFAULT NULL,
  p_observacoes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_dev RECORD;
  v_origem text := p_origem_compartilhado::text;
  v_mov_ids uuid[] := '{}';
BEGIN
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'qty deve ser > 0' USING ERRCODE = '22023';
  END IF;

  -- P054: FOR UPDATE serializa concorrentes por devolução.
  SELECT id, status INTO v_dev
    FROM siso_devolucoes_pendentes
   WHERE id = p_devolucao_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'devolução não encontrada' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotência: já classificada (ou outro status) → no-op.
  IF v_dev.status <> 'aguardando_classificacao' THEN
    RETURN jsonb_build_object('status', v_dev.status, 'ja_classificada', true);
  END IF;

  IF p_classificacao = 'integro' THEN
    -- Classe A — íntegra do cliente.
    v_mov_ids := array_append(v_mov_ids, wms_inserir_movimentacao(
      p_produto_id            => p_produto_id,
      p_galpao_id             => p_galpao_id,
      p_localizacao_id        => p_localizacao_id,
      p_tipo                  => 'E',
      p_quantidade            => p_qty,
      p_origem_tipo           => 'devolucao_cliente_integra',
      p_origem_id             => v_origem,
      p_usuario_id            => p_usuario_id,
      p_empresa_referencia_id => p_empresa_referencia_id,
      p_motivo                => p_observacoes,
      p_nota_fiscal_id        => p_nota_fiscal_id,
      p_custo_unitario        => p_custo_unitario
    ));

  ELSIF p_classificacao = 'avariado' THEN
    -- [P051] backstop: sem quarentena BLOQUEIA antes de tirar da prateleira.
    IF p_loc_quarentena_id IS NULL THEN
      RAISE EXCEPTION 'quarentena inexistente no galpão % — crie uma localização tipo ''quarentena'' antes de classificar avariado', p_galpao_id
        USING ERRCODE = '22023';
    END IF;
    -- Classe B — avariada: entra na loc, transfere imediatamente pra quarentena.
    v_mov_ids := array_append(v_mov_ids, wms_inserir_movimentacao(
      p_produto_id            => p_produto_id,
      p_galpao_id             => p_galpao_id,
      p_localizacao_id        => p_localizacao_id,
      p_tipo                  => 'E',
      p_quantidade            => p_qty,
      p_origem_tipo           => 'devolucao_cliente_avariada',
      p_origem_id             => v_origem,
      p_usuario_id            => p_usuario_id,
      p_empresa_referencia_id => p_empresa_referencia_id,
      p_motivo                => p_observacoes,
      p_nota_fiscal_id        => p_nota_fiscal_id,
      p_custo_unitario        => p_custo_unitario
    ));
    v_mov_ids := array_append(v_mov_ids, wms_inserir_movimentacao(
      p_produto_id     => p_produto_id,
      p_galpao_id      => p_galpao_id,
      p_localizacao_id => p_localizacao_id,
      p_tipo           => 'S',
      p_quantidade     => p_qty,
      p_origem_tipo    => 'transferencia_localizacao',
      p_origem_id      => v_origem,
      p_usuario_id     => p_usuario_id,
      p_motivo         => 'avaria → quarentena: ' || COALESCE(p_observacoes, '')
    ));
    v_mov_ids := array_append(v_mov_ids, wms_inserir_movimentacao(
      p_produto_id     => p_produto_id,
      p_galpao_id      => p_galpao_id,
      p_localizacao_id => p_loc_quarentena_id,
      p_tipo           => 'E',
      p_quantidade     => p_qty,
      p_origem_tipo    => 'transferencia_localizacao',
      p_origem_id      => v_origem,
      p_usuario_id     => p_usuario_id
    ));

  ELSIF p_classificacao = 'garantia' THEN
    -- Classe A+C combo: entra do cliente, sai pro fornecedor (garantia).
    IF p_fornecedor_id IS NULL THEN
      RAISE EXCEPTION 'classificacao=''garantia'' exige fornecedor_id (Classe C — devolução pro fornecedor)'
        USING ERRCODE = '22023';
    END IF;
    v_mov_ids := array_append(v_mov_ids, wms_inserir_movimentacao(
      p_produto_id            => p_produto_id,
      p_galpao_id             => p_galpao_id,
      p_localizacao_id        => p_localizacao_id,
      p_tipo                  => 'E',
      p_quantidade            => p_qty,
      p_origem_tipo           => 'devolucao_cliente_integra',
      p_origem_id             => v_origem,
      p_usuario_id            => p_usuario_id,
      p_empresa_referencia_id => p_empresa_referencia_id,
      p_nota_fiscal_id        => p_nota_fiscal_id,
      p_custo_unitario        => p_custo_unitario
    ));
    v_mov_ids := array_append(v_mov_ids, wms_inserir_movimentacao(
      p_produto_id     => p_produto_id,
      p_galpao_id      => p_galpao_id,
      p_localizacao_id => p_localizacao_id,
      p_tipo           => 'S',
      p_quantidade     => p_qty,
      p_origem_tipo    => 'devolucao_fornecedor_enviada',
      p_origem_id      => v_origem,
      p_usuario_id     => p_usuario_id,
      p_fornecedor_id  => p_fornecedor_id,
      p_motivo         => 'garantia: ' || COALESCE(p_observacoes, '')
    ));

  ELSIF p_classificacao = 'troca_sku' THEN
    -- Classe D — apenas reintegra; troca de SKU vira fluxo separado.
    v_mov_ids := array_append(v_mov_ids, wms_inserir_movimentacao(
      p_produto_id            => p_produto_id,
      p_galpao_id             => p_galpao_id,
      p_localizacao_id        => p_localizacao_id,
      p_tipo                  => 'E',
      p_quantidade            => p_qty,
      p_origem_tipo           => 'devolucao_cliente_troca_sku',
      p_origem_id             => v_origem,
      p_usuario_id            => p_usuario_id,
      p_empresa_referencia_id => p_empresa_referencia_id,
      p_motivo                => 'troca SKU: ' || COALESCE(p_observacoes, ''),
      p_nota_fiscal_id        => p_nota_fiscal_id,
      p_custo_unitario        => p_custo_unitario
    ));

  ELSE
    RAISE EXCEPTION 'classificação inválida: %', p_classificacao USING ERRCODE = '22023';
  END IF;

  -- Back-fill devolucao_id nas movs deste classify, taggeando pelos ids
  -- capturados (PK) de cada wms_inserir_movimentacao. A assinatura nomeada de
  -- wms_inserir_movimentacao não tem p_devolucao_id, então setamos a FK aqui
  -- (na mesma tx); usamos os ids capturados (id = ANY) porque é preciso e bate
  -- na PK index (sem scan do ledger). Mantém o lookup determinístico de
  -- desclassificarDevolucao (que estorna estritamente por devolucao_id) — sem
  -- isto, reverter uma devolução classificada via RPC não estornaria nenhuma mov.
  IF array_length(v_mov_ids, 1) > 0 THEN
    UPDATE siso_movimentacoes
       SET devolucao_id = p_devolucao_id
     WHERE id = ANY(v_mov_ids);
  END IF;

  UPDATE siso_devolucoes_pendentes
     SET status = 'classificada',
         classificacao = p_classificacao,
         classificada_por = p_usuario_id,
         classificada_em = now(),
         observacoes = p_observacoes,
         classificacao_em_andamento_por = NULL
   WHERE id = p_devolucao_id;

  RETURN jsonb_build_object('status', 'classificada', 'ja_classificada', false);
END;
$$;

COMMENT ON FUNCTION wms_classificar_devolucao(uuid,text,uuid,uuid,uuid,numeric,uuid,uuid,uuid,uuid,uuid,uuid,numeric,text) IS
  '[P049/P050/P051/P054] Classificação de devolução: FOR UPDATE + N movs + status numa tx (tudo-ou-nada). Idempotente; avariado sem quarentena = RAISE.';

COMMIT;
