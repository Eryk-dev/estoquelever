-- Fix-Final C T17 (Concern A Fix-B audit): desfazer guarda atômico com lock
-- pessimista na pendência.
--
-- Hoje desfazerGuarda em src/lib/wms/guarda.ts lê pendência → busca movs
-- candidates → loop chamando inserirMovimentacao 2x por par → UPDATE
-- pendência. Sem FOR UPDATE no row da pendência, 2 calls concorrentes de
-- desfazer (ou um confirmar+desfazer simultâneo) podem ler o mesmo
-- qty_guardada, ambas desfazerem qty unidades, e UPDATE-arem o valor
-- decrementado da última a escrever — over-decremento da qty_guardada
-- ou status inconsistente.
--
-- RPC envolve tudo em SELECT FOR UPDATE no row da pendência + chamadas
-- ao RPC wms_inserir_movimentacao (par S+E) + UPDATE final, tudo na
-- mesma transação. Espelha estrutura de wms_confirmar_guarda_atomico
-- (P3 #5.3 + #5.8).

CREATE OR REPLACE FUNCTION wms_desfazer_guarda_atomico(
  p_pendencia_id uuid,
  p_qty numeric,
  p_motivo text,
  p_usuario_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_pend RECORD;
  v_mov_candidate RECORD;
  v_qty_alvo numeric;
  v_qty_desfeita numeric := 0;
  v_movs_estornadas int := 0;
  v_qty_par numeric;
  v_novo_origem_id text;
  v_motivo_full text;
  v_nova_qty_guardada numeric;
  v_novo_status text;
  v_nova_guardada_em timestamptz;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'motivo do undo é obrigatório (≥3 caracteres)'
      USING ERRCODE = '22023';
  END IF;

  -- LOCK pessimista no row da pendência. Concorrentes ficam esperando.
  SELECT id, produto_id, galpao_id, localizacao_origem_id,
         qty_inicial, qty_guardada, status, iniciada_em, criada_em,
         guardada_em
    INTO v_pend
    FROM siso_wms_pendencias_guarda
   WHERE id = p_pendencia_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pendência não encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_pend.status = 'cancelada' THEN
    RAISE EXCEPTION 'pendência cancelada — undo de guarda não se aplica'
      USING ERRCODE = '22023';
  END IF;

  IF v_pend.qty_guardada IS NULL OR v_pend.qty_guardada = 0 THEN
    RAISE EXCEPTION 'pendência sem guardas confirmadas — nada a desfazer'
      USING ERRCODE = '22023';
  END IF;

  v_qty_alvo := COALESCE(p_qty, v_pend.qty_guardada);
  IF v_qty_alvo <= 0 THEN
    RAISE EXCEPTION 'qty deve ser > 0' USING ERRCODE = '22023';
  END IF;
  IF v_qty_alvo > v_pend.qty_guardada THEN
    RAISE EXCEPTION 'qty (%) excede qty_guardada (%)',
      v_qty_alvo, v_pend.qty_guardada USING ERRCODE = '22023';
  END IF;

  v_motivo_full := format('Desfaz guarda pendência %s: %s',
                          p_pendencia_id, p_motivo);

  -- Itera sobre as movs E (entrada na loc destino) das confirmações
  -- anteriores, da mais recente pra mais antiga. Para cada uma, emite par
  -- S+E forward com novo origem_id (não reutiliza original — preserva
  -- auditabilidade).
  FOR v_mov_candidate IN
    SELECT id, quantidade, localizacao_id
      FROM siso_movimentacoes
     WHERE origem_tipo = 'transferencia_localizacao'
       AND produto_id = v_pend.produto_id
       AND galpao_id = v_pend.galpao_id
       AND localizacao_id <> v_pend.localizacao_origem_id
       AND tipo = 'E'
       AND estorno_de IS NULL
       AND criado_em >= COALESCE(v_pend.iniciada_em, v_pend.criada_em,
                                  '1970-01-01'::timestamptz)
     ORDER BY criado_em DESC
  LOOP
    EXIT WHEN v_qty_desfeita >= v_qty_alvo;

    v_qty_par := LEAST(v_mov_candidate.quantidade, v_qty_alvo - v_qty_desfeita);
    v_novo_origem_id := gen_random_uuid()::text;

    -- S: remove da loc destino (onde o estoque está agora)
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_pend.produto_id,
      p_galpao_id := v_pend.galpao_id,
      p_localizacao_id := v_mov_candidate.localizacao_id,
      p_tipo := 'S',
      p_quantidade := v_qty_par,
      p_origem_tipo := 'transferencia_localizacao',
      p_origem_id := v_novo_origem_id,
      p_motivo := v_motivo_full,
      p_usuario_id := p_usuario_id
    );

    -- E: devolve pra RECEBIMENTO (localizacao_origem_id)
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_pend.produto_id,
      p_galpao_id := v_pend.galpao_id,
      p_localizacao_id := v_pend.localizacao_origem_id,
      p_tipo := 'E',
      p_quantidade := v_qty_par,
      p_origem_tipo := 'transferencia_localizacao',
      p_origem_id := v_novo_origem_id,
      p_motivo := v_motivo_full,
      p_usuario_id := p_usuario_id
    );

    v_movs_estornadas := v_movs_estornadas + 2;
    v_qty_desfeita := v_qty_desfeita + v_qty_par;
  END LOOP;

  IF v_qty_desfeita < v_qty_alvo THEN
    RAISE EXCEPTION 'cobertura insuficiente nas movs candidates: desfeito %, alvo %',
      v_qty_desfeita, v_qty_alvo USING ERRCODE = '22023';
  END IF;

  -- Atualiza pendência: decrementa qty_guardada, ajusta status.
  v_nova_qty_guardada := GREATEST(0, v_pend.qty_guardada - v_qty_desfeita);
  v_novo_status := CASE WHEN v_nova_qty_guardada > 0 THEN 'em_guarda' ELSE 'pendente' END;
  v_nova_guardada_em := CASE
    WHEN v_nova_qty_guardada >= v_pend.qty_inicial THEN v_pend.guardada_em
    ELSE NULL
  END;

  UPDATE siso_wms_pendencias_guarda
     SET qty_guardada = v_nova_qty_guardada,
         status = v_novo_status,
         guardada_em = v_nova_guardada_em
   WHERE id = p_pendencia_id;

  RETURN jsonb_build_object(
    'pendencia_id', p_pendencia_id,
    'qty_desfeita', v_qty_desfeita,
    'movs_estornadas', v_movs_estornadas,
    'nova_qty_guardada', v_nova_qty_guardada,
    'novo_status', v_novo_status
  );
END;
$$;

COMMENT ON FUNCTION wms_desfazer_guarda_atomico(uuid, numeric, text, uuid) IS
  'Fix-Final C T17 (Concern A Fix-B audit): desfaz guarda com FOR UPDATE no row da pendência. Espelha wms_confirmar_guarda_atomico.';
