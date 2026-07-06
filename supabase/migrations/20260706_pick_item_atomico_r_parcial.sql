-- 2026-07-06 — wms_pick_item_atomico suporta R PARCIAL e R multi-loc.
--
-- Sintoma (pedido FULL-d6b39e3b, SKU 027158): "falha_baixa_estoque: pick
-- atômico falhou: liberação excede reservado: 1 - 6 < 0". A lane Full reserva
-- "o que der" (R=1 pra item de qty=6); wms_desmarcar_item_atomico também
-- recria R clampada ao saldo livre. Mas a L do pick saía com p_qty CHEIO do
-- item → estoura o guard de reservado do wms_inserir_movimentacao → item
-- impossível de pickar PRA SEMPRE (estoque adicionado depois não re-reserva).
-- Classe já documentada em erros-conhecidos wms-fase3-2-reserva-parcial-quebra-pick
-- (na época a feature de R parcial foi revertida; a lane Full a reintroduziu
-- by design sem corrigir o pick).
--
-- Fix (regra: L sempre pareia com a qty da PRÓPRIA R — all-or-nothing por mov):
--   (a) L âncora usa v_r.quantidade, não p_qty. R parcial → L parcial válida.
--   (b) Após a âncora, libera TODAS as demais R vivas do mesmo
--       (pedido, produto, galpão) — a lane Full pode ter espalhado a reserva
--       em N locs. O pick com reserva é sempre da qty INTEIRA restante do item,
--       então qualquer R remanescente dele viraria reserva órfã (trava
--       disponível por 30d) ou bloquearia a S na mesma loc.
--   (c) A S continua saindo com p_qty na loc da R âncora — validada contra o
--       saldo físico e contra o reservado dos OUTROS pedidos (CHECK
--       reservado<=saldo). Faltou físico → falha loud (comportamento correto).
--
-- Lane normal (R == qty do item, única): comportamento idêntico ao anterior
-- (L=p_qty, loop vazio). Zero regressão.
--
-- Assinatura inalterada (12 args de 20260607d) → CREATE OR REPLACE, sem DROP.

CREATE OR REPLACE FUNCTION public.wms_pick_item_atomico(
  p_reserva_id uuid, p_produto_id uuid, p_galpao_id uuid, p_localizacao_id uuid,
  p_qty numeric, p_pedido_id text, p_empresa_vendedora_id uuid,
  p_usuario_id uuid DEFAULT NULL,
  p_nota_fiscal_id uuid DEFAULT NULL, p_motivo text DEFAULT NULL, p_origem_detalhes jsonb DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_r RECORD;
  v_r2 RECORD;
  v_ja_liberada boolean;
  v_l_id uuid;
  v_l_extra_id uuid;
  v_l_extra_ids uuid[] := '{}';
  v_s_id uuid;
  v_prod uuid;
  v_galp uuid;
  v_loc uuid;
  v_det jsonb;
BEGIN
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'qty deve ser > 0' USING ERRCODE = '22023';
  END IF;

  IF p_reserva_id IS NOT NULL THEN
    -- Lock pessimista na R + valida
    SELECT id, produto_id, galpao_id, localizacao_id, quantidade, tipo, origem_tipo
      INTO v_r
      FROM siso_movimentacoes
     WHERE id = p_reserva_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reserva % não encontrada', p_reserva_id USING ERRCODE = 'P0002';
    END IF;
    IF v_r.tipo <> 'R' OR v_r.origem_tipo <> 'reserva_pedido' THEN
      RAISE EXCEPTION 'mov % não é R reserva_pedido (tipo=%, origem=%)',
        p_reserva_id, v_r.tipo, v_r.origem_tipo USING ERRCODE = '22023';
    END IF;

    -- Idempotência: R já liberada? (existe L apontando pra ela)
    SELECT EXISTS(
      SELECT 1 FROM siso_movimentacoes
       WHERE tipo = 'L' AND estorno_de = p_reserva_id
    ) INTO v_ja_liberada;
    IF v_ja_liberada THEN
      RAISE EXCEPTION 'reserva % já liberada — pick já realizado', p_reserva_id
        USING ERRCODE = '22023';
    END IF;

    v_prod := v_r.produto_id;
    v_galp := v_r.galpao_id;
    v_loc  := v_r.localizacao_id;
    v_det  := COALESCE(p_origem_detalhes, '{}'::jsonb)
              || jsonb_build_object('reserva_origem', p_reserva_id, 'contexto', 'pick_atomico');

    -- L: libera a reserva com a qty da PRÓPRIA R (não p_qty) — a R pode ser
    -- parcial (lane Full / R clampada pós-desmarca). estorno_de=R.id marca
    -- idempotência.
    SELECT wms_inserir_movimentacao(
      p_produto_id := v_prod, p_galpao_id := v_galp, p_localizacao_id := v_loc,
      p_tipo := 'L', p_quantidade := v_r.quantidade,
      p_origem_tipo := 'liberacao_reserva', p_origem_id := p_pedido_id,
      p_origem_detalhes := v_det,
      p_estorno_de := p_reserva_id,
      p_usuario_id := p_usuario_id,
      p_pedido_id := p_pedido_id,
      p_motivo := COALESCE(p_motivo, 'Pick atômico — libera reserva')
    ) INTO v_l_id;

    -- Libera as DEMAIS R vivas do mesmo (pedido, produto, galpão) — reserva
    -- parcial multi-loc da lane Full. Cada L pareia com a qty da própria R.
    FOR v_r2 IN
      SELECT m.id, m.produto_id, m.galpao_id, m.localizacao_id, m.quantidade
        FROM siso_movimentacoes m
       WHERE m.tipo = 'R' AND m.origem_tipo = 'reserva_pedido'
         AND m.origem_id = p_pedido_id
         AND m.produto_id = v_prod AND m.galpao_id = v_galp
         AND m.id <> p_reserva_id
         AND NOT EXISTS (SELECT 1 FROM siso_movimentacoes l
                          WHERE l.tipo = 'L' AND l.estorno_de = m.id)
       ORDER BY m.criado_em, m.id
         FOR UPDATE OF m
    LOOP
      SELECT wms_inserir_movimentacao(
        p_produto_id := v_r2.produto_id, p_galpao_id := v_r2.galpao_id,
        p_localizacao_id := v_r2.localizacao_id,
        p_tipo := 'L', p_quantidade := v_r2.quantidade,
        p_origem_tipo := 'liberacao_reserva', p_origem_id := p_pedido_id,
        p_origem_detalhes := COALESCE(p_origem_detalhes, '{}'::jsonb)
          || jsonb_build_object('reserva_origem', v_r2.id, 'contexto', 'pick_atomico_libera_r_extra'),
        p_estorno_de := v_r2.id,
        p_usuario_id := p_usuario_id,
        p_pedido_id := p_pedido_id,
        p_motivo := COALESCE(p_motivo, 'Pick atômico — libera R extra do item')
      ) INTO v_l_extra_id;
      v_l_extra_ids := v_l_extra_ids || v_l_extra_id;
    END LOOP;
  ELSE
    v_prod := p_produto_id;
    v_galp := p_galpao_id;
    v_loc  := p_localizacao_id;
    v_det  := COALESCE(p_origem_detalhes, '{}'::jsonb)
              || jsonb_build_object('contexto', 'pick_atomico_sem_reserva');
  END IF;

  -- S: saída nf_venda na tripla (da R, ou a passada no fallback)
  SELECT wms_inserir_movimentacao(
    p_produto_id := v_prod, p_galpao_id := v_galp, p_localizacao_id := v_loc,
    p_tipo := 'S', p_quantidade := p_qty,
    p_origem_tipo := 'nf_venda', p_origem_id := p_pedido_id,
    p_origem_detalhes := v_det,
    p_empresa_vendedora_id := p_empresa_vendedora_id,
    p_usuario_id := p_usuario_id,
    p_pedido_id := p_pedido_id,
    p_nota_fiscal_id := p_nota_fiscal_id,
    p_motivo := COALESCE(p_motivo, 'Pick atômico — saída'),
    -- P072: token só no ramo SEM reserva (com reserva, a R FOR UPDATE já serializa).
    p_idempotency_key := CASE WHEN p_reserva_id IS NULL THEN p_idempotency_key ELSE NULL END
  ) INTO v_s_id;

  RETURN jsonb_build_object(
    'mov_l_id', v_l_id,
    'mov_l_extra_ids', to_jsonb(v_l_extra_ids),
    'mov_s_id', v_s_id,
    'produto_id', v_prod,
    'galpao_id', v_galp,
    'localizacao_id', v_loc,
    'qty', p_qty
  );
END;
$function$;
