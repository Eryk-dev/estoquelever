-- [INV-01/INV-02/INV-04] Re-aplicação de sessão de inventário após estorno.
--
-- INV-01: o fluxo prometido pela UI (estornar → re-aprovar → re-aplicar) SEMPRE
-- falhava com 23505: o índice uniq_movs_inventario_divergencia é sobre
-- (origem_detalhes->>'divergencia_id') e a mov original (estornada) continua
-- casando o predicado — a re-aplicação insere mov com o MESMO divergencia_id.
-- Fix: "geração de aplicação" — coluna `aplicacoes` em
-- siso_inventario_divergencias (int, default 0), incrementada a cada estorno
-- (sessão inteira aqui; divergência individual em
-- src/lib/wms/inventario.ts:estornarDivergenciaInventario). A RPC de aplicar
-- grava a geração em origem_detalhes.aplicacao e o índice único vira
-- (divergencia_id, COALESCE(aplicacao,'0')) — movs históricas sem a chave caem
-- na geração 0. A proteção contra dupla-aplicação DENTRO da mesma geração
-- continua (mesma divergencia_id + mesma geração → 23505).
--
-- INV-02/INV-04 (lado aplicar): aplicar que falha numa perda devolvia erro
-- genérico ('saldo insuficiente: 10 - 12 < 0' da wms_inserir_movimentacao) ou
-- 23514 cru do CHECK (reservado <= saldo) — sem nomear a divergência culpada,
-- a sessão fica presa em 'aprovada' sem o supervisor saber qual linha rejeitar.
-- Fix: pré-check por perda (saldo e reservado) com RAISE estruturado nomeando
-- divergência/sku/loc e a ação corretiva. O TS mapeia pra 409 (rota aplicar já
-- casa /saldo|insuficiente|reservado/).
BEGIN;

-- 1) Geração de aplicação por divergência.
ALTER TABLE siso_inventario_divergencias
  ADD COLUMN IF NOT EXISTS aplicacoes integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN siso_inventario_divergencias.aplicacoes IS
  '[INV-01] Geração de aplicação: bump a cada estorno (sessão ou individual). A RPC de aplicar grava em origem_detalhes.aplicacao — re-aplicar pós-estorno não colide no índice único.';

-- 2) Índice único por (divergencia, geração). Movs históricas não têm a chave
--    'aplicacao' → COALESCE '0' (geração zero), coerente com o default 0.
DROP INDEX IF EXISTS uniq_movs_inventario_divergencia;
CREATE UNIQUE INDEX uniq_movs_inventario_divergencia
  ON siso_movimentacoes (
    (origem_detalhes->>'divergencia_id'),
    (COALESCE(origem_detalhes->>'aplicacao', '0'))
  )
  WHERE origem_tipo IN ('inventario_ganho', 'inventario_perda')
    AND origem_detalhes ? 'divergencia_id';

COMMENT ON INDEX uniq_movs_inventario_divergencia IS
  'P3 #4.1 + [INV-01]: 1 mov por (divergência, geração de aplicação). Idempotência do aplicar dentro da geração; estorno bumpa a geração e libera a re-aplicação.';

-- 3) wms_aplicar_sessao_inventario: grava a geração em origem_detalhes +
--    pré-check de perdas nomeando a divergência culpada (INV-02/INV-04).
--    Corpo base: 20260607_rpc_aplicar_sessao_inventario.sql.
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

-- 4) wms_estornar_sessao_inventario: bump da geração ao resetar a divergência.
--    Corpo base: 20260605_rpc_estornar_sessao_inventario.sql — única mudança é
--    o `aplicacoes = aplicacoes + 1` no UPDATE do reset.
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
    -- [INV-01] aplicacoes+1: a próxima aplicação grava nova geração em
    -- origem_detalhes.aplicacao e não colide com a mov estornada no índice.
    UPDATE siso_inventario_divergencias
       SET status = 'pendente', mov_aplicada_id = NULL,
           aplicacoes = aplicacoes + 1
     WHERE id = v_div.id;
    v_estornadas := v_estornadas + 1;
  END LOOP;

  UPDATE siso_inventario_sessoes
     SET status = 'revisao', aplicada_em = NULL
   WHERE id = p_sessao;

  RETURN jsonb_build_object('movs_estornadas', v_estornadas, 'status', 'revisao');
END;
$$;

COMMENT ON FUNCTION public.wms_aplicar_sessao_inventario(uuid,uuid) IS
  'Fase 5 (P060) + [INV-01/02/04]: aplica divergências aprovadas tudo-ou-nada; grava geração de aplicação em origem_detalhes.aplicacao; pré-check de perdas nomeia a divergência culpada (saldo e reservado).';
COMMENT ON FUNCTION wms_estornar_sessao_inventario(uuid,uuid,text) IS
  '[P056/P061] Estorno de sessão de inventário tudo-ou-nada + [INV-01] bump de aplicacoes (geração) no reset das divergências.';

COMMIT;
