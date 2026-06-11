-- P2-EST-07 + P2-EST-08 — Desfazer guarda sem vínculo + liveness da R de guarda.
--
-- ── P2-EST-07: desfazer seleciona movs E de OUTRA pendência ──────────────────
-- wms_desfazer_guarda_atomico estorna o replenishment varrendo movs E de
-- origem_tipo='transferencia_localizacao' por (produto, galpão, loc<>origem,
-- criado_em >= iniciada/criada). Esse filtro NÃO tem vínculo com a pendência:
-- duas pendências do mesmo SKU no mesmo galpão (ou um replenishment manual)
-- geram movs E indistinguíveis → desfazer de uma pode estornar o put-away da
-- OUTRA.
--
-- FIX (1): wms_confirmar_guarda_atomico passa a CARIMBAR o par S+E do
-- replenishment com origem_detalhes->>'pendencia_id'. wms_replenishment_intra_
-- galpao ganha um param opcional p_origem_detalhes (default NULL → todos os
-- callers existentes seguem idênticos). FIX (2): o cursor do desfazer, se achar
-- pelo menos 1 candidate carimbado com este pendencia_id, filtra SÓ por esse
-- vínculo; senão (movs antigas pré-migration, sem carimbo) mantém a heurística
-- legada (com RAISE NOTICE).
--
-- ── P2-EST-08: liveness da R de guarda testa estorno_de IS NULL (sempre true) ─
-- Uma R reserva_guarda sempre tem estorno_de IS NULL (o L de liberação aponta
-- pra R via estorno_de, não o contrário). A idempotência do iniciar checava
-- "existe R com estorno_de IS NULL" → TRUE mesmo quando a R já foi 100%
-- liberada por L → iniciar pulava a criação da R → a re-guarda rodava SEM
-- reserva forte (um pick podia roubar a peça do recebimento).
--
-- FIX: o teste de "R viva" do iniciar vira NET = SUM(R) - SUM(L) > 0 (L que
-- aponta pras R da pendência via estorno_de). Net > 0 → viva, não recria.
-- Net <= 0 → cria R nova sobre o saldo livre.
--
-- Append-only: redefine a partir das versões vigentes —
--   wms_confirmar_guarda_atomico ← 20260611g_guarda_liberacao_parcial_marca_indice.sql
--   wms_iniciar_guarda_atomico   ← 20260609b_guarda_confirmar_valida_saldo_livre.sql
--   wms_desfazer_guarda_atomico  ← 20260609_guarda_reserva_forte_auto_encerrar.sql
--   wms_replenishment_intra_galpao ← 20260527_p3_rpc_wms_replenishment_atomico.sql
-- mudando SÓ o necessário pra cada fix.

-- ── 1. wms_replenishment_intra_galpao: +p_origem_detalhes (default NULL) ─────
-- Param opcional, no fim, default NULL → callers existentes seguem chamando
-- com 7 args nomeados. DROP do overload de 7 args ANTES de criar o de 8:
-- manter os dois causaria ambiguidade (42725) na chamada por args nomeados do
-- caller TS (movimentacoes.ts passa exatamente os 7 originais — casaria com
-- AMBOS). Com só o overload de 8 (último param default NULL), a chamada de 7
-- args resolve sem ambiguidade. Carimba S e E com o detalhe (usado pelo
-- confirmar da guarda pra plantar pendencia_id).
DROP FUNCTION IF EXISTS wms_replenishment_intra_galpao(uuid,uuid,uuid,jsonb,uuid,text,uuid);

CREATE OR REPLACE FUNCTION wms_replenishment_intra_galpao(
  p_galpao_id uuid,
  p_localizacao_origem_id uuid,
  p_localizacao_destino_id uuid,
  p_itens jsonb,             -- [{ produto_id: uuid, qty: numeric }]
  p_usuario_id uuid,
  p_observacoes text DEFAULT NULL,
  p_origem_id uuid DEFAULT NULL,
  p_origem_detalhes jsonb DEFAULT NULL   -- +EST-07: carimbo (ex.: {pendencia_id})
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_origem_id uuid;
  v_origem_id_txt text;
  v_item jsonb;
  v_mov_s_id uuid;
  v_mov_e_id uuid;
  v_mov_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_localizacao_origem_id = p_localizacao_destino_id THEN
    RAISE EXCEPTION 'origem e destino não podem ser a mesma localização'
      USING ERRCODE = '22023';
  END IF;
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'itens vazios'
      USING ERRCODE = '22023';
  END IF;

  v_origem_id := COALESCE(p_origem_id, gen_random_uuid());
  v_origem_id_txt := v_origem_id::text;

  FOR v_item IN SELECT jsonb_array_elements(p_itens) LOOP
    -- Leg 1: SAÍDA da origem
    SELECT wms_inserir_movimentacao(
      p_produto_id := (v_item->>'produto_id')::uuid,
      p_galpao_id := p_galpao_id,
      p_localizacao_id := p_localizacao_origem_id,
      p_tipo := 'S'::char(1),
      p_quantidade := (v_item->>'qty')::numeric,
      p_origem_tipo := 'transferencia_localizacao'::text,
      p_origem_id := v_origem_id_txt,
      p_origem_detalhes := p_origem_detalhes,
      p_usuario_id := p_usuario_id,
      p_expira_em := NULL::timestamptz,
      p_estorno_de := NULL::uuid,
      p_empresa_compradora_id := NULL::uuid,
      p_empresa_vendedora_id := NULL::uuid,
      p_empresa_referencia_id := NULL::uuid,
      p_fornecedor_id := NULL::uuid,
      p_motivo := p_observacoes,
      p_cliente_nome := NULL::text,
      p_pedido_id := NULL::text,
      p_nota_fiscal_id := NULL::uuid,
      p_chave_acesso_nf := NULL::text,
      p_custo_unitario := NULL::numeric
    ) INTO v_mov_s_id;
    v_mov_ids := array_append(v_mov_ids, v_mov_s_id);

    -- Leg 2: ENTRADA no destino. Se falhar, transação inteira rollback.
    SELECT wms_inserir_movimentacao(
      p_produto_id := (v_item->>'produto_id')::uuid,
      p_galpao_id := p_galpao_id,
      p_localizacao_id := p_localizacao_destino_id,
      p_tipo := 'E'::char(1),
      p_quantidade := (v_item->>'qty')::numeric,
      p_origem_tipo := 'transferencia_localizacao'::text,
      p_origem_id := v_origem_id_txt,
      p_origem_detalhes := p_origem_detalhes,
      p_usuario_id := p_usuario_id,
      p_expira_em := NULL::timestamptz,
      p_estorno_de := NULL::uuid,
      p_empresa_compradora_id := NULL::uuid,
      p_empresa_vendedora_id := NULL::uuid,
      p_empresa_referencia_id := NULL::uuid,
      p_fornecedor_id := NULL::uuid,
      p_motivo := p_observacoes,
      p_cliente_nome := NULL::text,
      p_pedido_id := NULL::text,
      p_nota_fiscal_id := NULL::uuid,
      p_chave_acesso_nf := NULL::text,
      p_custo_unitario := NULL::numeric
    ) INTO v_mov_e_id;
    v_mov_ids := array_append(v_mov_ids, v_mov_e_id);
  END LOOP;

  RETURN jsonb_build_object(
    'origem_id', v_origem_id,
    'mov_ids', to_jsonb(v_mov_ids)
  );
END;
$$;

COMMENT ON FUNCTION wms_replenishment_intra_galpao(uuid,uuid,uuid,jsonb,uuid,text,uuid,jsonb) IS
  'P3 #8.8 + EST-07: replenishment intra-galpão atômico. Par S+E na mesma transação. p_origem_detalhes carimba ambas as movs (vínculo de pendência de guarda).';

-- ── 2. wms_confirmar_guarda_atomico (base: 20260611g) ───────────────────────
-- Único delta vs 20260611g: passa p_origem_detalhes := {'pendencia_id': ...}
-- ao wms_replenishment_intra_galpao, carimbando o par S+E. Tudo o mais
-- (auto-encerrar saldo=0, valida saldo livre, libera R parcial marcada
-- 'parcial'=true ANTES do S) é idêntico.
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

  -- (a) AUTO-ENCERRAR: saldo FÍSICO = 0 com qty_pendente > 0 → encerra terminal.
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

  -- (a2) VALIDA SALDO LIVRE (v_own_R = R - L vivos desta pendência).
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

  -- (b) LIBERA A RESERVA FORTE (L parcial) ANTES da perna S do replenishment.
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
    v_liberar := LEAST(p_qty, v_own_R);
    IF v_liberar > 0 THEN
      PERFORM wms_inserir_movimentacao(
        p_produto_id := v_pend.produto_id,
        p_galpao_id := v_pend.galpao_id,
        p_localizacao_id := v_pend.localizacao_origem_id,
        p_tipo := 'L'::char(1),
        p_quantidade := v_liberar,
        p_origem_tipo := 'liberacao_guarda'::text,
        -- EST-01: marca 'parcial' pra escapar do uq_mov_estorno_unico.
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

  -- EST-07: carimba o par S+E do replenishment com o pendencia_id pra que o
  -- desfazer estorne SÓ as movs desta pendência (não as de outra do mesmo SKU).
  SELECT wms_replenishment_intra_galpao(
    p_galpao_id := v_pend.galpao_id,
    p_localizacao_origem_id := v_pend.localizacao_origem_id,
    p_localizacao_destino_id := p_localizacao_destino_id,
    p_itens := jsonb_build_array(
      jsonb_build_object('produto_id', v_pend.produto_id, 'qty', p_qty)
    ),
    p_usuario_id := p_usuario_id,
    p_observacoes := NULL::text,
    p_origem_id := NULL::uuid,
    p_origem_detalhes := jsonb_build_object('pendencia_id', p_pendencia_id::text)
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

-- ── 3. wms_iniciar_guarda_atomico (base: 20260609b) ─────────────────────────
-- EST-08: a idempotência da reserva forte passa a checar o NET (R - L vivos),
-- não "existe R com estorno_de IS NULL" (que era sempre true, já que a R nunca
-- carrega estorno_de). NET <= 0 (R totalmente liberada) → recria R nova sobre o
-- saldo livre, garantindo que a re-guarda tenha reserva forte. Resto idêntico.
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
  v_net_vivo numeric;
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

  -- Reivindica (idempotente p/ mesmo operador; takeover preserva qty_guardada).
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
  -- EST-08: idempotência por NET (R - L vivos) > 0, NÃO por "existe R com
  -- estorno_de IS NULL". Uma R reserva_guarda NUNCA tem estorno_de (o L de
  -- liberação aponta pra ELA via estorno_de) — então o teste antigo era sempre
  -- true e pulava a recriação mesmo com a R 100% liberada → re-guarda sem
  -- reserva forte. Net <= 0 (sem reserva viva) → cria R nova sobre o livre.
  SELECT GREATEST(0,
           COALESCE(SUM(CASE WHEN tipo = 'R' THEN quantidade ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN tipo = 'L' THEN quantidade ELSE 0 END), 0))
    INTO v_net_vivo
    FROM siso_movimentacoes
   WHERE origem_tipo IN ('reserva_guarda','liberacao_guarda')
     AND origem_id = p_pendencia_id::text;

  IF v_net_vivo <= 0 THEN
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

  -- Recalcula reservado NET vivo da pendência: SUM(R) - SUM(L).
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

-- ── 4. wms_desfazer_guarda_atomico (base: 20260609) ─────────────────────────
-- EST-07: cursor de candidates ganha vínculo. Se EXISTE >= 1 mov E carimbada
-- com origem_detalhes->>'pendencia_id' = p_pendencia_id → filtra SÓ por esse
-- vínculo (não toca movs de outra pendência). Senão (movs antigas pré-carimbo)
-- → mantém a heurística legada por (produto, galpão, loc, janela) com NOTICE.
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
  v_tem_vinculo boolean;
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

  -- EST-07: há movs E do replenishment carimbadas com este pendencia_id?
  SELECT EXISTS (
    SELECT 1
      FROM siso_movimentacoes
     WHERE origem_tipo = 'transferencia_localizacao'
       AND produto_id = v_pend.produto_id
       AND galpao_id = v_pend.galpao_id
       AND localizacao_id <> v_pend.localizacao_origem_id
       AND tipo = 'E'
       AND estorno_de IS NULL
       AND origem_detalhes->>'pendencia_id' = p_pendencia_id::text
  ) INTO v_tem_vinculo;

  IF NOT v_tem_vinculo THEN
    RAISE NOTICE 'desfazer guarda %: sem vínculo — heurística legada (movs pré-carimbo)',
      p_pendencia_id;
  END IF;

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
       -- EST-07: COM vínculo → SÓ as movs desta pendência; SEM vínculo →
       -- todas as candidates da janela (heurística legada, NOTICE acima).
       AND (NOT v_tem_vinculo
            OR origem_detalhes->>'pendencia_id' = p_pendencia_id::text)
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

  -- Reserva forte pós-undo: o estoque voltou pra loc de recebimento (perna E).
  -- Se a pendência usa reserva forte (foi iniciada via iniciar) e volta a
  -- em_guarda, re-reserva o saldo livre que retornou. Gate: já existiu (em
  -- algum momento) uma R reserva_guarda p/ esta pendência — existência, não
  -- liveness: o caso comum é desfazer APÓS confirmar ter liberado 100% da R
  -- (net=0); ainda assim a peça voltou e precisa ser re-travada. Clampado ao
  -- saldo livre, e a re-reserva é sempre uma R NOVA (aditiva, segura).
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
