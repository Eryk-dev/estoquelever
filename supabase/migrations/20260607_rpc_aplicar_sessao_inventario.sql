-- Fase 5 (P060) — RPC wms_aplicar_sessao_inventario: aplica todas as
-- divergências aprovadas de uma sessão de inventário TUDO-OU-NADA. Num único
-- BEGIN: itera divergências status='aprovada', gera mov E (ganho, com custo
-- médio atual como custo_unitario) ou S (perda) via wms_inserir_movimentacao,
-- marca divergência 'aplicada'+mov_aplicada_id, e transiciona sessão→'aplicada'.
-- Qualquer RAISE (ex.: saldo insuficiente numa perda) faz rollback TOTAL —
-- nenhuma mov persiste, sessão fica 'aprovada'. Idempotente p/ sessão já
-- 'aplicada' (conta movs existentes, no-op). Espelha o loop TS de
-- src/lib/wms/inventario.ts:973-1103 movendo a atomicidade pro banco.
CREATE OR REPLACE FUNCTION public.wms_aplicar_sessao_inventario(
  p_sessao uuid,
  p_usuario uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_status      text;
  v_galpao      uuid;
  v_div         RECORD;
  v_tipo        char(1);
  v_qty         numeric;
  v_custo       numeric;
  v_mov_id      uuid;
  v_count       integer := 0;
BEGIN
  -- Lock pessimista da sessão — serializa duas aplicações concorrentes.
  SELECT status, galpao_id INTO v_status, v_galpao
    FROM siso_inventario_sessoes
   WHERE id = p_sessao
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sessão % não encontrada', p_sessao USING ERRCODE = 'P0002';
  END IF;

  -- Idempotência: já aplicada → conta movs existentes, no-op.
  IF v_status = 'aplicada' THEN
    SELECT count(*) INTO v_count
      FROM siso_movimentacoes
     WHERE origem_id = p_sessao::text
       AND origem_tipo IN ('inventario_ganho', 'inventario_perda');
    RETURN jsonb_build_object('movs_geradas', v_count, 'idempotente', true);
  END IF;

  IF v_status <> 'aprovada' THEN
    RAISE EXCEPTION 'sessão % não está aprovada (status=%)', p_sessao, v_status USING ERRCODE = '22023';
  END IF;

  FOR v_div IN
    SELECT id, produto_id, localizacao_id, delta, delta_pct
      FROM siso_inventario_divergencias
     WHERE sessao_id = p_sessao
       AND status = 'aprovada'
     ORDER BY id
  LOOP
    IF v_div.delta = 0 THEN CONTINUE; END IF;
    v_tipo := CASE WHEN v_div.delta > 0 THEN 'E' ELSE 'S' END;
    v_qty  := abs(v_div.delta);

    -- Ganho carrega custo médio atual (preserva valor do entrante no ledger).
    v_custo := NULL;
    IF v_tipo = 'E' THEN
      SELECT custo_medio INTO v_custo FROM siso_custo_medio WHERE produto_id = v_div.produto_id;
    END IF;

    -- wms_inserir_movimentacao valida saldo (perda > saldo → RAISE → rollback total).
    SELECT wms_inserir_movimentacao(
      p_produto_id := v_div.produto_id,
      p_galpao_id := v_galpao,
      p_localizacao_id := v_div.localizacao_id,
      p_tipo := v_tipo,
      p_quantidade := v_qty,
      p_origem_tipo := CASE WHEN v_tipo = 'E' THEN 'inventario_ganho' ELSE 'inventario_perda' END,
      p_origem_id := p_sessao::text,
      p_origem_detalhes := jsonb_build_object('divergencia_id', v_div.id, 'delta_pct', v_div.delta_pct),
      p_custo_unitario := v_custo,
      p_usuario_id := p_usuario,
      p_motivo := 'inventário sessão ' || p_sessao::text
    ) INTO v_mov_id;

    UPDATE siso_inventario_divergencias
       SET status = 'aplicada', mov_aplicada_id = v_mov_id
     WHERE id = v_div.id;
    v_count := v_count + 1;
  END LOOP;

  -- Libera locks externos da sessão (idempotente).
  UPDATE siso_localizacao_locks
     SET finalizado_em = now()
   WHERE finalizado_em IS NULL
     AND localizacao_id IN (
       SELECT localizacao_id FROM siso_inventario_localizacoes WHERE sessao_id = p_sessao
     );

  UPDATE siso_inventario_sessoes
     SET status = 'aplicada', aplicada_em = now()
   WHERE id = p_sessao;

  RETURN jsonb_build_object('movs_geradas', v_count, 'idempotente', false);
END;
$function$;
