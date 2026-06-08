-- FASE 6 — F2-guarda: reserva forte ao iniciar + auto-encerrar.
--
-- Guarda dinâmica: quando o operador INICIA a guarda, reserva (R) todo o
-- saldo físico ainda presente na loc de recebimento — travando-o contra picks
-- concorrentes ("reserva forte"). Ao CONFIRMAR, libera (L) a fração guardada
-- ANTES da perna S do replenishment (senão o S violaria CHECK reservado<=saldo).
--
-- Auto-encerrar: se um pick consumiu TODO o saldo físico da loc de recebimento
-- antes do put-away, confirmar não tem o que mover → encerra a pendência com
-- status terminal 'encerrada_sem_saldo' (sem par S+E, saldo intacto).
--
-- CORREÇÃO: o trigger do auto-encerrar é saldo=0 (físico sumiu), NÃO
-- disponivel=0 — a R da própria pendência ainda está viva nesse ponto (é
-- liberada depois, na mesma função), então disponivel=0 é o caso NORMAL.

-- ── 1. origem_tipo: +reserva_guarda, +liberacao_guarda ──────────────────────
ALTER TABLE siso_movimentacoes DROP CONSTRAINT siso_movimentacoes_origem_tipo_check;
ALTER TABLE siso_movimentacoes ADD CONSTRAINT siso_movimentacoes_origem_tipo_check
  CHECK (origem_tipo = ANY (ARRAY[
    'nf_compra','devolucao_cliente_integra','devolucao_cliente_avariada',
    'devolucao_cliente_troca_sku','devolucao_fornecedor_recebida',
    'devolucao_fornecedor_enviada','nf_venda','venda_manual','ajuste_manual',
    'ajuste_pick_zerou','inventario_perda','inventario_ganho','inventario_inicial',
    'transferencia_galpao','transferencia_localizacao','reserva_pedido',
    'liberacao_reserva','lancamento_retroativo','estorno',
    'reserva_guarda','liberacao_guarda'
  ]::text[]));

-- ── 2. pendência guarda status: +encerrada_sem_saldo ────────────────────────
ALTER TABLE siso_wms_pendencias_guarda DROP CONSTRAINT siso_wms_pendencias_guarda_status_check;
ALTER TABLE siso_wms_pendencias_guarda ADD CONSTRAINT siso_wms_pendencias_guarda_status_check
  CHECK (status = ANY (ARRAY[
    'pendente','em_guarda','guardada','cancelada','encerrada_sem_saldo'
  ]::text[]));

-- ── 3. NEW: wms_iniciar_guarda_atomico ──────────────────────────────────────
-- Reivindica a pendência (status→em_guarda) com lock pessimista + cria a
-- reserva forte (R reserva_guarda) sobre o saldo livre da loc de recebimento.
-- Idempotente: re-chamar do mesmo operador (ou re-claim) não duplica a R.
CREATE OR REPLACE FUNCTION public.wms_iniciar_guarda_atomico(
  p_pendencia_id uuid,
  p_usuario_id uuid,
  p_forcar boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE
  v_pend RECORD;
  v_saldo numeric;
  v_reservado numeric;
  v_livre numeric;
  v_reservar numeric;
  v_r_existente uuid;
BEGIN
  SELECT id, produto_id, galpao_id, localizacao_origem_id,
         qty_inicial, qty_guardada, qty_pendente, status, iniciada_por
    INTO v_pend
    FROM siso_wms_pendencias_guarda
   WHERE id = p_pendencia_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pendência não encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_pend.status = 'guardada' OR v_pend.status = 'cancelada'
     OR v_pend.status = 'encerrada_sem_saldo' THEN
    RAISE EXCEPTION 'pendência em status terminal (%)', v_pend.status
      USING ERRCODE = '22023';
  END IF;

  -- Já reivindicada por OUTRO operador: só pode tomar com forcar (takeover).
  IF NOT p_forcar
     AND v_pend.status = 'em_guarda'
     AND v_pend.iniciada_por IS NOT NULL
     AND v_pend.iniciada_por <> p_usuario_id THEN
    RAISE EXCEPTION 'pendência já está em_guarda com outro operador (%)',
      v_pend.iniciada_por USING ERRCODE = '55006';  -- lock_not_available
  END IF;

  -- Reivindica (idempotente p/ mesmo operador; takeover preserva qty_guardada,
  -- que é coluna não-tocada aqui). Só seta iniciada_em quando ainda não era
  -- deste operador, pra não resetar relógio em re-chamada do mesmo dono.
  UPDATE siso_wms_pendencias_guarda
     SET status = 'em_guarda',
         iniciada_por = p_usuario_id,
         iniciada_em = CASE
           WHEN v_pend.status = 'em_guarda' AND v_pend.iniciada_por = p_usuario_id
             THEN iniciada_em
           ELSE now()
         END
   WHERE id = p_pendencia_id;

  -- Reserva forte: trava o saldo físico LIVRE ainda presente na loc origem.
  -- Idempotente: se já existe R reserva_guarda viva p/ esta pendência, não cria.
  SELECT id INTO v_r_existente
    FROM siso_movimentacoes
   WHERE tipo = 'R'
     AND origem_tipo = 'reserva_guarda'
     AND origem_id = p_pendencia_id::text
     AND estorno_de IS NULL
   LIMIT 1;

  IF v_r_existente IS NULL THEN
    SELECT COALESCE(saldo, 0), COALESCE(reservado, 0)
      INTO v_saldo, v_reservado
      FROM siso_estoque
     WHERE produto_id = v_pend.produto_id
       AND galpao_id = v_pend.galpao_id
       AND localizacao_id = v_pend.localizacao_origem_id;
    v_saldo := COALESCE(v_saldo, 0);
    v_reservado := COALESCE(v_reservado, 0);
    v_livre := v_saldo - v_reservado;
    v_reservar := LEAST(v_pend.qty_pendente, v_livre);

    -- Só reserva se há saldo livre. Se <= 0, não cria R de 0 (candidato a
    -- auto-encerrar no confirmar — o saldo físico já sumiu).
    IF v_reservar > 0 THEN
      PERFORM wms_inserir_movimentacao(
        p_produto_id := v_pend.produto_id,
        p_galpao_id := v_pend.galpao_id,
        p_localizacao_id := v_pend.localizacao_origem_id,
        p_tipo := 'R'::char(1),
        p_quantidade := v_reservar,
        p_origem_tipo := 'reserva_guarda'::text,
        p_origem_id := p_pendencia_id::text,
        p_origem_detalhes := NULL::jsonb,
        p_usuario_id := p_usuario_id,
        p_expira_em := now() + interval '7 days',
        p_estorno_de := NULL::uuid,
        p_empresa_compradora_id := NULL::uuid,
        p_empresa_vendedora_id := NULL::uuid,
        p_empresa_referencia_id := NULL::uuid,
        p_fornecedor_id := NULL::uuid,
        p_motivo := 'reserva forte put-away',
        p_cliente_nome := NULL::text,
        p_pedido_id := NULL::text,
        p_nota_fiscal_id := NULL::uuid,
        p_chave_acesso_nf := NULL::text,
        p_custo_unitario := NULL::numeric
      );
    END IF;
  END IF;

  -- Recalcula reservado total da R viva (pode ser a pré-existente).
  SELECT COALESCE(SUM(m.quantidade), 0)
    INTO v_reservar
    FROM siso_movimentacoes m
   WHERE m.tipo = 'R'
     AND m.origem_tipo = 'reserva_guarda'
     AND m.origem_id = p_pendencia_id::text;

  RETURN jsonb_build_object(
    'pendencia_id', p_pendencia_id,
    'reservado', v_reservar,
    'iniciada_por', p_usuario_id
  );
END;
$function$;

-- ── 4. CREATE OR REPLACE wms_confirmar_guarda_atomico (auto-encerrar + libera R) ──
CREATE OR REPLACE FUNCTION public.wms_confirmar_guarda_atomico(
  p_pendencia_id uuid,
  p_qty numeric,
  p_localizacao_destino_id uuid,
  p_usuario_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE
  v_pend RECORD;
  v_loc_dest RECORD;
  v_repl_result jsonb;
  v_nova_qty_guardada numeric;
  v_totalmente boolean;
  v_novo_status text;
  v_saldo_origem numeric;
  v_r RECORD;
  v_liberar numeric;
BEGIN
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'qty deve ser > 0' USING ERRCODE = '22023';
  END IF;

  SELECT id, produto_id, galpao_id, localizacao_origem_id, qty_inicial,
         qty_guardada, qty_pendente, status, guardada_em, iniciada_por
    INTO v_pend
    FROM siso_wms_pendencias_guarda
   WHERE id = p_pendencia_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pendência não encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_pend.status = 'guardada' OR v_pend.status = 'cancelada'
     OR v_pend.status = 'encerrada_sem_saldo' THEN
    RAISE EXCEPTION 'pendência em status terminal (%)', v_pend.status
      USING ERRCODE = '22023';
  END IF;

  -- (a) AUTO-ENCERRAR: se o saldo FÍSICO da loc de recebimento sumiu (=0)
  -- mas a pendência ainda tem qty_pendente, um pick consumiu a peça antes do
  -- put-away. Não há o que mover → encerra como terminal, saldo intacto,
  -- SEM par S+E. Trigger é saldo=0 (NÃO disponivel=0: a R da própria
  -- pendência ainda está viva aqui — ela é liberada só no bloco (b)).
  SELECT COALESCE(saldo, 0) INTO v_saldo_origem
    FROM siso_estoque
   WHERE produto_id = v_pend.produto_id
     AND galpao_id = v_pend.galpao_id
     AND localizacao_id = v_pend.localizacao_origem_id;
  v_saldo_origem := COALESCE(v_saldo_origem, 0);

  IF v_saldo_origem = 0 AND v_pend.qty_pendente > 0 THEN
    UPDATE siso_wms_pendencias_guarda
       SET status = 'encerrada_sem_saldo',
           guardada_em = now()
     WHERE id = p_pendencia_id;
    RETURN jsonb_build_object(
      'pendencia_id', p_pendencia_id,
      'auto_encerrada', true,
      'status', 'encerrada_sem_saldo',
      'qty_guardada', v_pend.qty_guardada,
      'totalmente_guardada', false
    );
  END IF;

  IF p_qty > v_pend.qty_pendente THEN
    RAISE EXCEPTION 'qty (%) excede pendente (%)', p_qty, v_pend.qty_pendente
      USING ERRCODE = '22023';
  END IF;

  IF p_localizacao_destino_id = v_pend.localizacao_origem_id THEN
    RAISE EXCEPTION 'loc destino não pode ser a loc de recebimento (origem da guarda)'
      USING ERRCODE = '22023';
  END IF;

  SELECT id, galpao_id, ativo INTO v_loc_dest
    FROM siso_localizacoes WHERE id = p_localizacao_destino_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'localização destino não encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_loc_dest.ativo THEN
    RAISE EXCEPTION 'localização destino inativa' USING ERRCODE = '22023';
  END IF;
  IF v_loc_dest.galpao_id <> v_pend.galpao_id THEN
    RAISE EXCEPTION 'localização destino é de outro galpão' USING ERRCODE = '22023';
  END IF;

  -- (b) LIBERAR A RESERVA FORTE (L) ANTES da perna S do replenishment.
  -- Se a pendência foi iniciada com reserva forte, existe uma R reserva_guarda
  -- viva. O S do replenishment reduz o saldo da loc origem; se o reservado
  -- continuasse cravado, violaria CHECK(reservado<=saldo). Liberamos só p_qty
  -- (clampado ao reservado vivo); o resto da R fica pra próxima confirmação.
  SELECT id
    INTO v_r
    FROM siso_movimentacoes
   WHERE tipo = 'R'
     AND origem_tipo = 'reserva_guarda'
     AND origem_id = p_pendencia_id::text
     AND estorno_de IS NULL
   ORDER BY criado_em DESC
   LIMIT 1;

  IF v_r.id IS NOT NULL THEN
    -- Reservado vivo desta pendência na loc origem (somando R - L já emitidos).
    SELECT GREATEST(0,
             COALESCE(SUM(CASE WHEN tipo = 'R' THEN quantidade ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN tipo = 'L' THEN quantidade ELSE 0 END), 0))
      INTO v_liberar
      FROM siso_movimentacoes
     WHERE origem_tipo IN ('reserva_guarda','liberacao_guarda')
       AND origem_id = p_pendencia_id::text;
    v_liberar := LEAST(p_qty, v_liberar);
    IF v_liberar > 0 THEN
      PERFORM wms_inserir_movimentacao(
        p_produto_id := v_pend.produto_id,
        p_galpao_id := v_pend.galpao_id,
        p_localizacao_id := v_pend.localizacao_origem_id,
        p_tipo := 'L'::char(1),
        p_quantidade := v_liberar,
        p_origem_tipo := 'liberacao_guarda'::text,
        p_origem_id := p_pendencia_id::text,
        p_origem_detalhes := NULL::jsonb,
        p_usuario_id := p_usuario_id,
        p_expira_em := NULL::timestamptz,
        p_estorno_de := v_r.id,
        p_empresa_compradora_id := NULL::uuid,
        p_empresa_vendedora_id := NULL::uuid,
        p_empresa_referencia_id := NULL::uuid,
        p_fornecedor_id := NULL::uuid,
        p_motivo := 'libera reserva forte (put-away confirmado)',
        p_cliente_nome := NULL::text,
        p_pedido_id := NULL::text,
        p_nota_fiscal_id := NULL::uuid,
        p_chave_acesso_nf := NULL::text,
        p_custo_unitario := NULL::numeric
      );
    END IF;
  END IF;

  SELECT wms_replenishment_intra_galpao(
    p_galpao_id := v_pend.galpao_id,
    p_localizacao_origem_id := v_pend.localizacao_origem_id,
    p_localizacao_destino_id := p_localizacao_destino_id,
    p_itens := jsonb_build_array(
      jsonb_build_object('produto_id', v_pend.produto_id, 'qty', p_qty)
    ),
    p_usuario_id := p_usuario_id,
    p_observacoes := NULL::text,
    p_origem_id := NULL::uuid
  ) INTO v_repl_result;

  v_nova_qty_guardada := v_pend.qty_guardada + p_qty;
  v_totalmente := v_nova_qty_guardada >= v_pend.qty_inicial;
  v_novo_status := CASE WHEN v_totalmente THEN 'guardada' ELSE 'em_guarda' END;

  UPDATE siso_wms_pendencias_guarda
     SET qty_guardada = v_nova_qty_guardada,
         status = v_novo_status,
         guardada_em = CASE WHEN v_totalmente THEN now() ELSE NULL END,
         guardada_por = p_usuario_id
   WHERE id = p_pendencia_id;

  RETURN jsonb_build_object(
    'pendencia_id', p_pendencia_id,
    'origem_id', v_repl_result->>'origem_id',
    'mov_ids', v_repl_result->'mov_ids',
    'totalmente_guardada', v_totalmente,
    'qty_guardada', v_nova_qty_guardada,
    'status', v_novo_status,
    'guardada_por', p_usuario_id
  );
END;
$function$;

-- ── 5. CREATE OR REPLACE wms_desfazer_guarda_atomico (recria R se volta em_guarda) ──
CREATE OR REPLACE FUNCTION public.wms_desfazer_guarda_atomico(
  p_pendencia_id uuid,
  p_qty numeric,
  p_motivo text,
  p_usuario_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $function$
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
  v_r_existia uuid;
  v_saldo numeric;
  v_reservado numeric;
  v_livre numeric;
  v_re_reservar numeric;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'motivo do undo é obrigatório (≥3 caracteres)'
      USING ERRCODE = '22023';
  END IF;

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

  -- Reserva forte pós-undo: o estoque voltou pra loc de recebimento (perna E
  -- acima). Se a pendência tinha reserva forte (foi iniciada via iniciar) e
  -- volta a em_guarda, re-reserva o saldo livre que retornou pra manter a peça
  -- travada pro put-away em progresso. Condicional: só se já EXISTIU uma R
  -- reserva_guarda p/ esta pendência (senão deixa o estado como estava — ex.:
  -- confirmar sem iniciar, que nunca reservou). Clampado ao saldo livre.
  IF v_novo_status = 'em_guarda' THEN
    SELECT id INTO v_r_existia
      FROM siso_movimentacoes
     WHERE origem_tipo = 'reserva_guarda'
       AND origem_id = p_pendencia_id::text
     LIMIT 1;

    IF v_r_existia IS NOT NULL THEN
      SELECT COALESCE(saldo, 0), COALESCE(reservado, 0)
        INTO v_saldo, v_reservado
        FROM siso_estoque
       WHERE produto_id = v_pend.produto_id
         AND galpao_id = v_pend.galpao_id
         AND localizacao_id = v_pend.localizacao_origem_id;
      v_livre := COALESCE(v_saldo, 0) - COALESCE(v_reservado, 0);
      -- Re-reserva o que voltou (v_qty_desfeita), clampado ao saldo livre.
      v_re_reservar := LEAST(v_qty_desfeita, v_livre);
      IF v_re_reservar > 0 THEN
        PERFORM wms_inserir_movimentacao(
          p_produto_id := v_pend.produto_id,
          p_galpao_id := v_pend.galpao_id,
          p_localizacao_id := v_pend.localizacao_origem_id,
          p_tipo := 'R'::char(1),
          p_quantidade := v_re_reservar,
          p_origem_tipo := 'reserva_guarda'::text,
          p_origem_id := p_pendencia_id::text,
          p_origem_detalhes := NULL::jsonb,
          p_usuario_id := p_usuario_id,
          p_expira_em := now() + interval '7 days',
          p_estorno_de := NULL::uuid,
          p_empresa_compradora_id := NULL::uuid,
          p_empresa_vendedora_id := NULL::uuid,
          p_empresa_referencia_id := NULL::uuid,
          p_fornecedor_id := NULL::uuid,
          p_motivo := 'reserva forte re-aplicada (undo guarda)',
          p_cliente_nome := NULL::text,
          p_pedido_id := NULL::text,
          p_nota_fiscal_id := NULL::uuid,
          p_chave_acesso_nf := NULL::text,
          p_custo_unitario := NULL::numeric
        );
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'pendencia_id', p_pendencia_id,
    'qty_desfeita', v_qty_desfeita,
    'movs_estornadas', v_movs_estornadas,
    'nova_qty_guardada', v_nova_qty_guardada,
    'novo_status', v_novo_status
  );
END;
$function$;

-- ── 6. NEW: wms_cancelar_pendencia_guarda_atomico ───────────────────────────
-- Cancela a pendência liberando (L) qualquer reserva forte (R reserva_guarda)
-- remanescente ANTES de marcar 'cancelada' — devolvendo o disponível da loc de
-- recebimento. NÃO mexe no saldo físico (a peça continua na loc). Atômico:
-- FOR UPDATE na pendência + L + UPDATE numa só transação.
CREATE OR REPLACE FUNCTION public.wms_cancelar_pendencia_guarda_atomico(
  p_pendencia_id uuid,
  p_motivo text,
  p_usuario_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE
  v_pend RECORD;
  v_r RECORD;
  v_liberar numeric;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'motivo do cancelamento é obrigatório (≥3 caracteres)'
      USING ERRCODE = '22023';
  END IF;

  SELECT id, produto_id, galpao_id, localizacao_origem_id, status
    INTO v_pend
    FROM siso_wms_pendencias_guarda
   WHERE id = p_pendencia_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pendência não encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_pend.status = 'guardada' OR v_pend.status = 'cancelada'
     OR v_pend.status = 'encerrada_sem_saldo' THEN
    RAISE EXCEPTION 'pendência em status terminal (%)', v_pend.status
      USING ERRCODE = '22023';
  END IF;

  -- Libera a reserva forte remanescente (R - L já emitidos) antes de cancelar.
  SELECT id
    INTO v_r
    FROM siso_movimentacoes
   WHERE tipo = 'R'
     AND origem_tipo = 'reserva_guarda'
     AND origem_id = p_pendencia_id::text
     AND estorno_de IS NULL
   ORDER BY criado_em DESC
   LIMIT 1;

  IF v_r.id IS NOT NULL THEN
    SELECT GREATEST(0,
             COALESCE(SUM(CASE WHEN tipo = 'R' THEN quantidade ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN tipo = 'L' THEN quantidade ELSE 0 END), 0))
      INTO v_liberar
      FROM siso_movimentacoes
     WHERE origem_tipo IN ('reserva_guarda','liberacao_guarda')
       AND origem_id = p_pendencia_id::text;
    IF v_liberar > 0 THEN
      PERFORM wms_inserir_movimentacao(
        p_produto_id := v_pend.produto_id,
        p_galpao_id := v_pend.galpao_id,
        p_localizacao_id := v_pend.localizacao_origem_id,
        p_tipo := 'L'::char(1),
        p_quantidade := v_liberar,
        p_origem_tipo := 'liberacao_guarda'::text,
        p_origem_id := p_pendencia_id::text,
        p_origem_detalhes := NULL::jsonb,
        p_usuario_id := p_usuario_id,
        p_expira_em := NULL::timestamptz,
        p_estorno_de := v_r.id,
        p_empresa_compradora_id := NULL::uuid,
        p_empresa_vendedora_id := NULL::uuid,
        p_empresa_referencia_id := NULL::uuid,
        p_fornecedor_id := NULL::uuid,
        p_motivo := 'libera reserva forte (pendência cancelada)',
        p_cliente_nome := NULL::text,
        p_pedido_id := NULL::text,
        p_nota_fiscal_id := NULL::uuid,
        p_chave_acesso_nf := NULL::text,
        p_custo_unitario := NULL::numeric
      );
    END IF;
  END IF;

  UPDATE siso_wms_pendencias_guarda
     SET status = 'cancelada',
         cancelada_em = now(),
         cancelada_por = p_usuario_id,
         motivo_cancelamento = trim(p_motivo)
   WHERE id = p_pendencia_id;

  RETURN jsonb_build_object(
    'pendencia_id', p_pendencia_id,
    'reserva_liberada', COALESCE(v_liberar, 0)
  );
END;
$function$;
