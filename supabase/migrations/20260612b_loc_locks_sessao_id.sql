-- [INV-06] Dono explícito do lock de localização + liberação escopada.
--
-- Problema (P2-INV-02, limitação documentada): siso_localizacao_locks não tinha
-- coluna de dono — aprovar/cancelar/aplicar liberavam locks por proxy
-- (localizacao_id + iniciado_em >= iniciada_em), com ambiguidade se duas
-- sessões travavam a mesma loc no mesmo instante.
--
-- Fix:
--   1. Coluna sessao_id (nullable; locks legados ficam NULL — código trata
--      NULL como fallback por localizacao_id, seguro porque uq_loc_lock_ativo
--      garante 1 lock ativo por loc).
--   2. wms_aplicar_sessao_inventario libera por sessao_id (com fallback NULL).
--   3. (TS) iniciarSessao grava sessao_id; finalizarLoc libera o lock da loc
--      assim que ela é finalizada — loc contada volta pro roteamento NA HORA,
--      em vez de esperar a aprovação da sessão inteira (decisão D2 do plano
--      2026-06-12-inventario-operacao-viva-fixes). A matemática da
--      reconciliação temporal e a aplicação por delta continuam corretas com
--      movs pós-contagem; colisão perda×reserva é pega pelo preflight INV-02/04.

BEGIN;

ALTER TABLE siso_localizacao_locks
  ADD COLUMN IF NOT EXISTS sessao_id uuid REFERENCES siso_inventario_sessoes(id);

COMMENT ON COLUMN siso_localizacao_locks.sessao_id IS
  '[INV-06] Sessão de inventário dona do lock (motivo cycle_count). NULL = lock legado pré-coluna; liberação cai no fallback por localizacao_id.';

CREATE INDEX IF NOT EXISTS idx_loc_locks_sessao_ativo
  ON siso_localizacao_locks(sessao_id)
  WHERE finalizado_em IS NULL;

-- wms_aplicar_sessao_inventario: liberação de locks escopada por dono.
-- Corpo base: 20260611e_inventario_reaplicacao_geracao.sql — única mudança é
-- o WHERE do UPDATE de siso_localizacao_locks.
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
  v_saldo       numeric;   -- [INV-02/INV-04]
  v_reservado   numeric;   -- [INV-02/INV-04]
  v_sku         text;      -- [INV-02/INV-04]
  v_loc_codigo  text;      -- [INV-02/INV-04]
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
  -- [INV-01] re-aplicações geram novas gerações; conta só as movs vivas
  -- (não estornadas), senão o retorno dobraria a cada ciclo estorno+re-aplicar.
  IF v_status = 'aplicada' THEN
    SELECT count(*) INTO v_count
      FROM siso_movimentacoes m
     WHERE m.origem_id = p_sessao::text
       AND m.origem_tipo IN ('inventario_ganho', 'inventario_perda')
       AND NOT EXISTS (SELECT 1 FROM siso_movimentacoes e WHERE e.estorno_de = m.id);
    RETURN jsonb_build_object('movs_geradas', v_count, 'idempotente', true);
  END IF;

  IF v_status <> 'aprovada' THEN
    RAISE EXCEPTION 'sessão % não está aprovada (status=%)', p_sessao, v_status USING ERRCODE = '22023';
  END IF;

  FOR v_div IN
    SELECT id, produto_id, localizacao_id, delta, delta_pct, aplicacoes
      FROM siso_inventario_divergencias
     WHERE sessao_id = p_sessao
       AND status = 'aprovada'
     ORDER BY id
  LOOP
    IF v_div.delta = 0 THEN CONTINUE; END IF;
    v_tipo := CASE WHEN v_div.delta > 0 THEN 'E' ELSE 'S' END;
    v_qty  := abs(v_div.delta);

    -- [INV-02/INV-04] Pré-check de perda nomeando a divergência culpada.
    -- Sem isso: wms_inserir_movimentacao falha genérico ('saldo insuficiente')
    -- ou o CHECK (reservado <= saldo) estoura 23514 cru — rollback total e o
    -- supervisor não sabe qual linha rejeitar. FOR UPDATE segura a tripla até
    -- o fim da tx (wms_inserir_movimentacao re-adquire o mesmo lock, ok).
    IF v_tipo = 'S' THEN
      SELECT COALESCE(saldo, 0), COALESCE(reservado, 0)
        INTO v_saldo, v_reservado
        FROM siso_estoque
       WHERE produto_id = v_div.produto_id
         AND galpao_id = v_galpao
         AND localizacao_id = v_div.localizacao_id
       FOR UPDATE;
      IF NOT FOUND THEN
        v_saldo := 0;
        v_reservado := 0;
      END IF;
      SELECT sku INTO v_sku FROM siso_produtos WHERE id = v_div.produto_id;
      SELECT codigo INTO v_loc_codigo FROM siso_localizacoes WHERE id = v_div.localizacao_id;
      IF v_saldo - v_qty < 0 THEN
        RAISE EXCEPTION 'divergência % (produto %, loc %): perda % maior que o saldo atual % — rejeite essa divergência e re-aplique a sessão',
          v_div.id, v_sku, v_loc_codigo, v_qty, v_saldo
          USING ERRCODE = '22023';
      END IF;
      IF v_saldo - v_qty < v_reservado THEN
        RAISE EXCEPTION 'divergência % (produto %, loc %): perda % deixaria o saldo (%) abaixo do reservado (%) — libere/realoque as reservas antes de aplicar a perda, ou rejeite a divergência',
          v_div.id, v_sku, v_loc_codigo, v_qty, v_saldo, v_reservado
          USING ERRCODE = '22023';
      END IF;
    END IF;

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
      -- [INV-01] 'aplicacao' = geração — re-aplicar pós-estorno não colide no índice.
      p_origem_detalhes := jsonb_build_object(
        'divergencia_id', v_div.id,
        'delta_pct', v_div.delta_pct,
        'aplicacao', v_div.aplicacoes
      ),
      p_custo_unitario := v_custo,
      p_usuario_id := p_usuario,
      p_motivo := 'inventário sessão ' || p_sessao::text
    ) INTO v_mov_id;

    UPDATE siso_inventario_divergencias
       SET status = 'aplicada', mov_aplicada_id = v_mov_id
     WHERE id = v_div.id;
    v_count := v_count + 1;
  END LOOP;

  -- [INV-06] Libera locks externos DA SESSÃO (escopado por dono; fallback
  -- por localizacao_id pra locks legados sem sessao_id). Idempotente.
  UPDATE siso_localizacao_locks
     SET finalizado_em = now()
   WHERE finalizado_em IS NULL
     AND (
       sessao_id = p_sessao
       OR (sessao_id IS NULL AND localizacao_id IN (
         SELECT localizacao_id FROM siso_inventario_localizacoes WHERE sessao_id = p_sessao
       ))
     );

  UPDATE siso_inventario_sessoes
     SET status = 'aplicada', aplicada_em = now()
   WHERE id = p_sessao;

  RETURN jsonb_build_object('movs_geradas', v_count, 'idempotente', false);
END;
$function$;

COMMENT ON FUNCTION public.wms_aplicar_sessao_inventario(uuid,uuid) IS
  'Fase 5 (P060) + [INV-01/02/04/06]: aplica divergências aprovadas tudo-ou-nada; geração de aplicação em origem_detalhes.aplicacao; pré-check de perdas (saldo e reservado); liberação de locks escopada por sessao_id.';

COMMIT;
