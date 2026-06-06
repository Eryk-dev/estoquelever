-- [P056/P061] Estorno de sessão de inventário tudo-ou-nada.
-- Substitui o loop TS de estornarSessaoInventario (uma tx RPC independente por
-- divergência → estado parcial se a N-ésima negativaria o saldo). Aqui: preflight
-- de saldo de TODAS as contra-movs antes de inserir qualquer uma; qualquer RAISE
-- → rollback total + nomeia o produto que negativaria.
BEGIN;

CREATE OR REPLACE FUNCTION wms_estornar_sessao_inventario(
  p_sessao uuid,
  p_usuario uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_sessao   RECORD;
  v_div      RECORD;
  v_orig     siso_movimentacoes%ROWTYPE;
  v_saldo    numeric;
  v_tipo_inv char(1);
  v_estornadas int := 0;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'motivo do estorno é obrigatório (>=3 caracteres)' USING ERRCODE = '22023';
  END IF;

  -- Serializa estornos concorrentes da mesma sessão.
  SELECT id, status, galpao_id INTO v_sessao
    FROM siso_inventario_sessoes WHERE id = p_sessao FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sessão não encontrada' USING ERRCODE = 'P0002';
  END IF;
  -- Idempotente: se já não está 'aplicada', no-op.
  IF v_sessao.status <> 'aplicada' THEN
    RETURN jsonb_build_object('movs_estornadas', 0, 'status', v_sessao.status);
  END IF;

  -- ── PREFLIGHT: valida que TODA contra-mov tem saldo, sem escrever nada. ──
  -- Movs de divergência de inventário são só E (ganho)→S ou S (perda)→E; só o
  -- undo E→S reduz saldo, então só E precisa de preflight (S→E só adiciona).
  FOR v_div IN
    SELECT d.id, d.mov_aplicada_id
      FROM siso_inventario_divergencias d
     WHERE d.sessao_id = p_sessao AND d.status = 'aplicada' AND d.mov_aplicada_id IS NOT NULL
  LOOP
    SELECT * INTO v_orig FROM siso_movimentacoes WHERE id = v_div.mov_aplicada_id FOR UPDATE;
    CONTINUE WHEN NOT FOUND;
    -- Já estornada: o guard estorno_de cobre tanto o estorno total quanto o
    -- parcial (qualquer contra-mov prévia aponta estorno_de à origem → skip).
    -- Movs de inventário só são estornadas FULL, então isto basta.
    CONTINUE WHEN EXISTS (SELECT 1 FROM siso_movimentacoes WHERE estorno_de = v_orig.id);
    -- Só uma entrada (E) gera uma saída (S) no undo → única que pode negativar saldo.
    IF v_orig.tipo = 'E' THEN
      SELECT COALESCE(saldo, 0) INTO v_saldo
        FROM siso_estoque
       WHERE produto_id = v_orig.produto_id
         AND galpao_id = v_orig.galpao_id
         AND localizacao_id = v_orig.localizacao_id;
      IF v_saldo < v_orig.quantidade THEN
        RAISE EXCEPTION 'estorno deixaria saldo negativo no produto % (loc %): saldo % < estorno %',
          (SELECT sku FROM siso_produtos WHERE id = v_orig.produto_id),
          v_orig.localizacao_id, v_saldo, v_orig.quantidade
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END LOOP;

  -- ── EXECUÇÃO: insere contra-movs + reseta divergências. ──
  FOR v_div IN
    SELECT d.id, d.mov_aplicada_id
      FROM siso_inventario_divergencias d
     WHERE d.sessao_id = p_sessao AND d.status = 'aplicada' AND d.mov_aplicada_id IS NOT NULL
  LOOP
    -- v_orig já travado no preflight (lock mantido até o fim da tx)
    SELECT * INTO v_orig FROM siso_movimentacoes WHERE id = v_div.mov_aplicada_id;
    CONTINUE WHEN NOT FOUND;
    -- Mesmo guard estorno_de do preflight (cobre estorno total e parcial).
    CONTINUE WHEN EXISTS (SELECT 1 FROM siso_movimentacoes WHERE estorno_de = v_orig.id);
    v_tipo_inv := CASE v_orig.tipo
                    WHEN 'E' THEN 'S'
                    WHEN 'S' THEN 'E'
                    ELSE NULL
                  END;
    IF v_tipo_inv IS NULL THEN
      RAISE EXCEPTION 'tipo de mov inesperado em divergência de inventário: % (mov %)', v_orig.tipo, v_orig.id
        USING ERRCODE = '22023';
    END IF;
    PERFORM wms_inserir_movimentacao(
      p_produto_id     := v_orig.produto_id,
      p_galpao_id      := v_orig.galpao_id,
      p_localizacao_id := v_orig.localizacao_id,
      p_tipo           := v_tipo_inv,
      p_quantidade     := v_orig.quantidade,
      p_origem_tipo    := 'estorno',
      p_origem_id      := v_orig.id::text,
      p_usuario_id     := p_usuario,
      p_estorno_de     := v_orig.id,
      p_motivo         := format('Estorno sessão inventário %s: %s', p_sessao, p_motivo)
    );
    UPDATE siso_inventario_divergencias
       SET status = 'pendente', mov_aplicada_id = NULL
     WHERE id = v_div.id;
    v_estornadas := v_estornadas + 1;
  END LOOP;

  UPDATE siso_inventario_sessoes
     SET status = 'revisao', aplicada_em = NULL
   WHERE id = p_sessao;

  RETURN jsonb_build_object('movs_estornadas', v_estornadas, 'status', 'revisao');
END;
$$;

COMMENT ON FUNCTION wms_estornar_sessao_inventario(uuid,uuid,text) IS
  '[P056/P061] Estorno de sessão de inventário tudo-ou-nada (preflight saldo + contra-movs + reset divergências).';

COMMIT;
