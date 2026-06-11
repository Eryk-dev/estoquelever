-- EST-01 — Guarda parcial em 2+ locs quebrada pelo uq_mov_estorno_unico.
--
-- Os L `liberacao_guarda` de wms_confirmar_guarda_atomico e
-- wms_cancelar_pendencia_guarda_atomico apontam pra reserva forte via
-- `p_estorno_de := v_r.id` mas gravavam `origem_detalhes := NULL`. O índice
-- uq_mov_estorno_unico (20260608) é UNIQUE(estorno_de) WHERE
-- COALESCE(origem_detalhes->>'parcial','false') <> 'true' → o 2º L na MESMA R
-- (guardar 4 no picking + 6 no overstock; ou cancelar após confirmação
-- parcial) estourava 23505 → 500.
--
-- FIX: marcar TODOS os L de liberacao_guarda com origem_detalhes
-- {'parcial': true} (mesma convenção de wms_estornar_parcial_movimentacao,
-- 20260518). Não havia nenhum detalhe gravado antes (era NULL) — nada a
-- preservar.
--
-- DECISÃO — por que marcar TODOS (inclusive a última fração e o L "total" do
-- cancelar), e não só os parciais:
--   1. A proteção contra double-release dos L de guarda NUNCA veio do índice:
--      vem da própria RPC — FOR UPDATE na pendência serializa toda operação de
--      guarda por pendência, e v_liberar = LEAST(p_qty, net SUM(R)-SUM(L))
--      é recomputado dentro da transação (não há como liberar além do
--      reservado vivo). O branch L de wms_inserir_movimentacao ainda valida
--      reservado - qty >= 0 sob lock da tripla.
--   2. A RPC não tem como saber com segurança se um L é "o último" da R:
--      cancelar pode vir depois de N confirmações parciais (apontando pra
--      mesma R), e desfazer recria R nova no meio do ciclo. Distinguir
--      parcial/total no insert criaria exatamente os casos de colisão que
--      este fix elimina.
--   3. Nada mais depende do índice nesses L: a idempotência do iniciar checa
--      R com estorno_de IS NULL (coluna da própria R); o auto-encerrar do
--      confirmar é por saldo físico = 0; o desfazer NÃO emite L (só par S+E
--      de transferencia_localizacao + re-reserva R) — por isso ele não é
--      redefinido aqui. Os nets de reserva somam R-L por origem_tipo/origem_id,
--      indiferentes a origem_detalhes.
--
-- Nota residual: ledger.estornarMovimentacao (TS) usa o índice como backstop
-- TOCTOU de full-estorno, mas nenhum caller estorna R reserva_guarda via esse
-- caminho — os ciclos de guarda passam exclusivamente pelas RPCs abaixo.
--
-- Append-only: redefine verbatim a partir das versões vigentes —
-- wms_confirmar_guarda_atomico de 20260609b_guarda_confirmar_valida_saldo_livre.sql
-- e wms_cancelar_pendencia_guarda_atomico de
-- 20260609_guarda_reserva_forte_auto_encerrar.sql — mudando SÓ o
-- p_origem_detalhes do L de liberação.

-- ── 1. wms_confirmar_guarda_atomico (base: 20260609b) ───────────────────────
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
        -- EST-01: marca 'parcial' pra escapar do uq_mov_estorno_unico —
        -- N liberações na mesma R são o fluxo normal da guarda em 2+ locs.
        -- Double-release é prevenido pelo net R-L sob FOR UPDATE (acima).
        p_origem_detalhes := jsonb_build_object('parcial', true),
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

-- ── 2. wms_cancelar_pendencia_guarda_atomico (base: 20260609) ───────────────
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
        -- EST-01: marca 'parcial' pra escapar do uq_mov_estorno_unico —
        -- cancelar após confirmação parcial emite L na MESMA R já liberada
        -- parcialmente. Double-release é prevenido pelo net R-L sob FOR UPDATE
        -- + status terminal (re-cancelar levanta 22023 acima).
        p_origem_detalhes := jsonb_build_object('parcial', true),
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
