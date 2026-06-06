-- [P067] Desfazer recebimento de transferência atômico (tudo-ou-nada).
-- Hoje o wrapper TS estorna cada leg E num loop, DEPOIS faz UPDATEs separados de
-- itens e header — 3 statements PostgREST sem tx. Se o UPDATE de itens falha
-- após os estornos, o estoque volta mas header/itens ficam 'recebida' (P067).
-- Esta RPC faz estorno legs E + reset itens + reset header numa única tx.
BEGIN;

CREATE OR REPLACE FUNCTION wms_desfazer_recebimento_transferencia(
  p_transferencia_id uuid,
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_head RECORD;
  v_item RECORD;
  v_orig siso_movimentacoes;
  v_estornadas int := 0;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'motivo do undo é obrigatório (>=3 caracteres)' USING ERRCODE = '22023';
  END IF;

  -- Lock pessimista no header — serializa undo concorrente.
  SELECT id, status INTO v_head
    FROM siso_transferencias_galpao
   WHERE id = p_transferencia_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transferência não encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_head.status <> 'recebida' THEN
    RAISE EXCEPTION 'só transferências recebidas podem ter recebimento desfeito (status atual: %)', v_head.status
      USING ERRCODE = '22023';
  END IF;

  -- Estorna cada leg E (entrada destino). Idempotente: pula se a mov original
  -- já tem estorno (EXISTS estorno_de). Lock pessimista na mov original.
  FOR v_item IN
    SELECT id, mov_entrada_id
      FROM siso_transferencia_galpao_itens
     WHERE transferencia_id = p_transferencia_id
       AND mov_entrada_id IS NOT NULL
  LOOP
    SELECT * INTO v_orig
      FROM siso_movimentacoes
     WHERE id = v_item.mov_entrada_id
     FOR UPDATE;
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM siso_movimentacoes WHERE estorno_de = v_orig.id
    );

    -- Counter-mov da leg E é um S com origem_tipo='estorno' + estorno_de.
    PERFORM wms_inserir_movimentacao(
      p_produto_id      := v_orig.produto_id,
      p_galpao_id       := v_orig.galpao_id,
      p_localizacao_id  := v_orig.localizacao_id,
      p_tipo            := 'S',
      p_quantidade      := v_orig.quantidade,
      p_origem_tipo     := 'estorno',
      p_origem_id       := v_orig.id::text,
      p_origem_detalhes := jsonb_build_object(
        'estorno_de', v_orig.id,
        'mov_original_origem', v_orig.origem_tipo
      ),
      p_usuario_id      := p_usuario_id,
      p_estorno_de      := v_orig.id,
      p_motivo          := format('Desfaz recebimento de transferência %s: %s', p_transferencia_id, p_motivo)
    );
    v_estornadas := v_estornadas + 1;
  END LOOP;

  -- Reset dos itens (toda a transferência) + reset do header — mesma tx.
  UPDATE siso_transferencia_galpao_itens
     SET mov_entrada_id = NULL, localizacao_destino_id = NULL
   WHERE transferencia_id = p_transferencia_id;

  UPDATE siso_transferencias_galpao
     SET status = 'em_transito', recebida_em = NULL, recebida_por = NULL
   WHERE id = p_transferencia_id;

  RETURN jsonb_build_object('movs_estornadas', v_estornadas, 'status', 'em_transito');
END;
$$;

COMMENT ON FUNCTION wms_desfazer_recebimento_transferencia(uuid, uuid, text) IS
  '[P067] Undo de recebimento de transferência atômico: estorno legs E + reset itens + reset header numa tx.';

COMMIT;
