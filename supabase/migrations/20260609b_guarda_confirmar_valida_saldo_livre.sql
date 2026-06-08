-- FASE 6 — follow-up (LEDGER review)
--
-- FIX 1 (Important): valida saldo livre antes de mover no put-away.
--   A loc de recebimento pode carregar uma reserva ALHEIA (ex.: um pedido
--   reservando estoque do recebimento). Se `confirmar` for chamado com p_qty
--   excedendo o saldo fisicamente LIVRE, a perna S do replenishment empurra
--   `saldo` abaixo do `reservado` alheio → viola CHECK(reservado <= saldo) →
--   rollback com erro opaco do Postgres. Adicionamos uma validação limpa que
--   levanta uma exceção legível ('qty (%) excede saldo livre (%)') ANTES de
--   liberar a R / disparar o replenishment.
--
--   v_livre = v_saldo_origem - (v_reservado_total - v_own_R)
--     onde v_own_R = R - L vivos desta própria pendência (vamos liberá-los).
--
-- FIX 3 (Minor): wms_iniciar_guarda_atomico retornava `reservado` somando
--   só R (sem subtrair L), super-reportando após uma confirmação parcial que
--   já liberou parte da R. Passa a ser o NET (SUM(R) - SUM(L)) — honesto.
--
-- Append-only: NÃO re-aplica o 20260609_guarda_reserva_forte_auto_encerrar.sql.
-- Mantém verbatim: trigger auto-encerra (saldo=0), ordem liberar-R-antes-do-S,
-- e todos os literais de exceção existentes.

CREATE OR REPLACE FUNCTION public.wms_confirmar_guarda_atomico(p_pendencia_id uuid, p_qty numeric, p_localizacao_destino_id uuid, p_usuario_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_pend RECORD;
  v_loc_dest RECORD;
  v_repl_result jsonb;
  v_nova_qty_guardada numeric;
  v_totalmente boolean;
  v_novo_status text;
  v_saldo_origem numeric;
  v_reservado_total numeric;
  v_own_R numeric;
  v_livre numeric;
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
  -- Lê saldo E reservado da tripla origem (reservado é usado na validação (a2)).
  SELECT COALESCE(saldo, 0), COALESCE(reservado, 0)
    INTO v_saldo_origem, v_reservado_total
    FROM siso_estoque
   WHERE produto_id = v_pend.produto_id
     AND galpao_id = v_pend.galpao_id
     AND localizacao_id = v_pend.localizacao_origem_id;
  v_saldo_origem := COALESCE(v_saldo_origem, 0);
  v_reservado_total := COALESCE(v_reservado_total, 0);

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

  -- (a2) VALIDA SALDO LIVRE: a R desta própria pendência (v_own_R) será
  -- liberada no bloco (b) antes da perna S, então NÃO conta como ocupando
  -- saldo. Mas reservas ALHEIAS (outros pedidos) na loc origem ocupam saldo
  -- que o put-away não pode mover. v_livre é o saldo que esta guarda realmente
  -- pode movimentar. Se p_qty excede, levanta erro LIMPO em vez de deixar o
  -- replenishment violar CHECK(reservado <= saldo) com erro opaco.
  -- v_own_R = R - L vivos desta pendência (mesmo net que o bloco (b) usa).
  SELECT GREATEST(0,
           COALESCE(SUM(CASE WHEN tipo = 'R' THEN quantidade ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN tipo = 'L' THEN quantidade ELSE 0 END), 0))
    INTO v_own_R
    FROM siso_movimentacoes
   WHERE origem_tipo IN ('reserva_guarda','liberacao_guarda')
     AND origem_id = p_pendencia_id::text;
  v_livre := v_saldo_origem - (v_reservado_total - v_own_R);
  IF p_qty > v_livre THEN
    RAISE EXCEPTION 'qty (%) excede saldo livre (%)', p_qty, v_livre
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
    -- Reservado vivo desta pendência na loc origem (= v_own_R já computado).
    v_liberar := LEAST(p_qty, v_own_R);
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

-- FIX 3 (Minor): `reservado` retornado vira o NET (SUM(R) - SUM(L)) vivo.
CREATE OR REPLACE FUNCTION public.wms_iniciar_guarda_atomico(p_pendencia_id uuid, p_usuario_id uuid, p_forcar boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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

  -- Recalcula reservado NET vivo da pendência: SUM(R) - SUM(L). Subtrair L
  -- (liberacao_guarda) garante que re-claim após uma confirmação parcial não
  -- super-reporte a reserva remanescente.
  SELECT GREATEST(0,
           COALESCE(SUM(CASE WHEN m.tipo = 'R' THEN m.quantidade ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN m.tipo = 'L' THEN m.quantidade ELSE 0 END), 0))
    INTO v_reservar
    FROM siso_movimentacoes m
   WHERE m.origem_tipo IN ('reserva_guarda','liberacao_guarda')
     AND m.origem_id = p_pendencia_id::text;

  RETURN jsonb_build_object(
    'pendencia_id', p_pendencia_id,
    'reservado', v_reservar,
    'iniciada_por', p_usuario_id
  );
END;
$function$;
