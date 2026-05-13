-- WMS Inventário — Claim hierárquico (rua > prédio > buffer > colisão controlada)
--
-- Modelo:
--   Endereço = rua-prédio-andar (3 segmentos do código).
--   Operador "reivindica" (claim) uma unidade hierárquica e trabalha nela até
--   esgotar — em vez de re-decidir a cada loc pela priority chain antiga.
--
-- Algoritmo:
--   1. Tem claim ativo com loc pendente?
--        → retorna próxima loc na direção do claim (asc/desc).
--   2. Sem claim ou claim esgotado → tenta novo claim, na ordem:
--        a) RUA livre (zero ops ativos na rua).
--        b) PRÉDIO livre com buffer ≥1 prédio em relação a ops ativos.
--           Se entrar numa rua com claim de outro op, esse claim degrada
--           pra prédio (no prédio em que o op concorrente está agora).
--        c) PRÉDIO livre SEM buffer (adjacente). Pega o mais distante.
--        d) Colisão no ÚLTIMO prédio da sessão (se restar só ele e tiver
--           1 op nele). Limita a 2 ops simultâneos; o 2º entra pela ponta
--           oposta do prédio (max distance vertical) e desce DESC.
--        e) Senão → pool_vazio.
--
-- Como estávamos em staging, sessões antigas com slot_atribuido não
-- precisam ser preservadas — dropamos a coluna direto.

BEGIN;

------------------------------------------------------------------------------
-- 1. Limpeza: tira o modelo de slot_atribuido do rewrite anterior
------------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_inv_locs_slot_atribuido;
ALTER TABLE siso_inventario_localizacoes
  DROP COLUMN IF EXISTS slot_atribuido;

------------------------------------------------------------------------------
-- 2. siso_inventario_operadores: armazena o claim ativo de cada operador
------------------------------------------------------------------------------
--
-- claim_tipo:
--   'rua'     → claim_codigo é a rua (ex: 'A'); op desce todos os prédios.
--   'predio'  → claim_codigo é rua-prédio (ex: 'A-03'); op desce os andares.
--   'colisao' → claim_codigo é rua-prédio (mesmo prédio do "dono original");
--               op entra na ponta oposta. Só pode existir um 'colisao' por
--               prédio (o "dono original" permanece como 'predio').
--
-- claim_direcao: 'asc' (default) ou 'desc' (só usado em 'colisao' do 2º op).

ALTER TABLE siso_inventario_operadores
  ADD COLUMN IF NOT EXISTS claim_tipo text
    CHECK (claim_tipo IS NULL OR claim_tipo IN ('rua','predio','colisao')),
  ADD COLUMN IF NOT EXISTS claim_codigo text,
  ADD COLUMN IF NOT EXISTS claim_direcao text
    CHECK (claim_direcao IS NULL OR claim_direcao IN ('asc','desc')),
  ADD COLUMN IF NOT EXISTS claim_atualizado_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_inv_op_claim_ativo
  ON siso_inventario_operadores(sessao_id, claim_tipo, claim_codigo)
  WHERE finalizado_em IS NULL AND claim_tipo IS NOT NULL;

------------------------------------------------------------------------------
-- 3. Helpers de parsing do código rua-prédio-andar
------------------------------------------------------------------------------

-- Extrai a rua (prefixo) do código. 'A-03-02' → 'A'.
CREATE OR REPLACE FUNCTION wms_loc_rua(p_codigo text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT split_part(p_codigo, '-', 1);
$$;

-- Extrai o prédio (rua-horizontal) do código. 'A-03-02' → 'A-03'.
-- Códigos sem hífen ou com formato fora do padrão retornam o código inteiro
-- (degrada graceful — vira "prédio único").
CREATE OR REPLACE FUNCTION wms_loc_predio(p_codigo text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN strpos(p_codigo, '-') = 0 THEN p_codigo
    ELSE split_part(p_codigo, '-', 1) || '-' || split_part(p_codigo, '-', 2)
  END;
$$;

-- Extrai o número horizontal (prédio) como int, pra calcular buffer.
-- Falha silenciosa: retorna NULL se não for parseável.
CREATE OR REPLACE FUNCTION wms_loc_horizontal_int(p_codigo text) RETURNS int
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_h text;
  v_n int;
BEGIN
  v_h := split_part(p_codigo, '-', 2);
  IF v_h IS NULL OR v_h = '' THEN RETURN NULL; END IF;
  BEGIN
    v_n := v_h::int;
    RETURN v_n;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$$;

------------------------------------------------------------------------------
-- 4. RPC: wms_inventario_proxima_loc — claim hierárquico
------------------------------------------------------------------------------
-- Estrutura: cada fase tenta achar v_inv_loc_id. Se achar, define o claim
-- novo e SAI da cadeia (próximas fases checam v_inv_loc_id IS NULL).
-- Ao final, se nada achou, retorna pool_vazio. Senão, atribuir + retornar.

CREATE OR REPLACE FUNCTION wms_inventario_proxima_loc(
  p_sessao uuid,
  p_user uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_inv_loc_id uuid;
  v_loc_id uuid;
  v_codigo text;
  v_tipo text;
  v_zona text;
  v_modo text;
  v_empresa_dona uuid;
  v_esperados jsonb;

  v_meu_op_id uuid;
  v_claim_tipo text;
  v_claim_codigo text;
  v_claim_direcao text;
  v_predios_pendentes_total int;
  v_rua_alvo text;
  v_predio_alvo text;
BEGIN
  -- Confirma slot ativo
  SELECT id INTO v_meu_op_id
  FROM siso_inventario_operadores
  WHERE sessao_id = p_sessao
    AND usuario_id = p_user
    AND finalizado_em IS NULL;
  IF v_meu_op_id IS NULL THEN
    RAISE EXCEPTION 'usuário não está em nenhum slot ativo desta sessão';
  END IF;

  -- Confirma sessão em andamento
  IF NOT EXISTS (
    SELECT 1 FROM siso_inventario_sessoes
    WHERE id = p_sessao AND status = 'em_andamento'
  ) THEN
    RAISE EXCEPTION 'sessão não está em andamento';
  END IF;

  SELECT modo_contagem, empresa_dona_id
  INTO v_modo, v_empresa_dona
  FROM siso_inventario_sessoes
  WHERE id = p_sessao;

  SELECT claim_tipo, claim_codigo, claim_direcao
  INTO v_claim_tipo, v_claim_codigo, v_claim_direcao
  FROM siso_inventario_operadores
  WHERE id = v_meu_op_id;

  ------------------------------------------------------------------
  -- FASE 1: continuar claim ativo
  ------------------------------------------------------------------
  IF v_claim_tipo IS NOT NULL AND v_claim_codigo IS NOT NULL THEN
    IF v_claim_tipo = 'rua' THEN
      SELECT inv_loc.id, loc.id, loc.codigo, loc.tipo,
             COALESCE(loc.zona, wms_loc_rua(loc.codigo))
        INTO v_inv_loc_id, v_loc_id, v_codigo, v_tipo, v_zona
      FROM siso_inventario_localizacoes inv_loc
      JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
      WHERE inv_loc.sessao_id = p_sessao
        AND inv_loc.status = 'pendente'
        AND inv_loc.bloqueada_por IS NULL
        AND wms_loc_rua(loc.codigo) = v_claim_codigo
      ORDER BY loc.codigo ASC
      LIMIT 1
      FOR UPDATE OF inv_loc SKIP LOCKED;
    ELSE
      SELECT inv_loc.id, loc.id, loc.codigo, loc.tipo,
             COALESCE(loc.zona, wms_loc_rua(loc.codigo))
        INTO v_inv_loc_id, v_loc_id, v_codigo, v_tipo, v_zona
      FROM siso_inventario_localizacoes inv_loc
      JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
      WHERE inv_loc.sessao_id = p_sessao
        AND inv_loc.status = 'pendente'
        AND inv_loc.bloqueada_por IS NULL
        AND wms_loc_predio(loc.codigo) = v_claim_codigo
      ORDER BY CASE WHEN v_claim_direcao = 'desc'
                    THEN loc.codigo END DESC,
               loc.codigo ASC
      LIMIT 1
      FOR UPDATE OF inv_loc SKIP LOCKED;
    END IF;

    IF v_inv_loc_id IS NULL THEN
      -- Claim esgotado: limpa pra cair nas próximas fases
      UPDATE siso_inventario_operadores
      SET claim_tipo = NULL, claim_codigo = NULL, claim_direcao = NULL,
          claim_atualizado_em = now()
      WHERE id = v_meu_op_id;
      v_claim_tipo := NULL;
      v_claim_codigo := NULL;
      v_claim_direcao := NULL;
    END IF;
  END IF;

  ------------------------------------------------------------------
  -- FASE 2a: claim de rua livre
  ------------------------------------------------------------------
  IF v_inv_loc_id IS NULL THEN
    WITH ruas_ocupadas AS (
      SELECT DISTINCT CASE
               WHEN op.claim_tipo = 'rua' THEN op.claim_codigo
               ELSE wms_loc_rua(op.claim_codigo)
             END AS rua
      FROM siso_inventario_operadores op
      WHERE op.sessao_id = p_sessao
        AND op.finalizado_em IS NULL
        AND op.id != v_meu_op_id
        AND op.claim_tipo IS NOT NULL
      UNION
      SELECT DISTINCT wms_loc_rua(loc.codigo) AS rua
      FROM siso_inventario_localizacoes inv_loc
      JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
      WHERE inv_loc.sessao_id = p_sessao
        AND inv_loc.status = 'em_contagem'
        AND inv_loc.bloqueada_por IS NOT NULL
        AND inv_loc.bloqueada_por != p_user
    ),
    contagem_por_rua AS (
      SELECT wms_loc_rua(loc.codigo) AS rua,
             COUNT(*) AS qty_pendente
      FROM siso_inventario_localizacoes inv_loc
      JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
      WHERE inv_loc.sessao_id = p_sessao
        AND inv_loc.status = 'pendente'
        AND inv_loc.bloqueada_por IS NULL
      GROUP BY wms_loc_rua(loc.codigo)
    )
    SELECT cpr.rua
      INTO v_rua_alvo
    FROM contagem_por_rua cpr
    WHERE cpr.rua NOT IN (SELECT rua FROM ruas_ocupadas WHERE rua IS NOT NULL)
    ORDER BY cpr.qty_pendente DESC, cpr.rua ASC
    LIMIT 1;

    IF v_rua_alvo IS NOT NULL THEN
      SELECT inv_loc.id, loc.id, loc.codigo, loc.tipo,
             COALESCE(loc.zona, wms_loc_rua(loc.codigo))
        INTO v_inv_loc_id, v_loc_id, v_codigo, v_tipo, v_zona
      FROM siso_inventario_localizacoes inv_loc
      JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
      WHERE inv_loc.sessao_id = p_sessao
        AND inv_loc.status = 'pendente'
        AND inv_loc.bloqueada_por IS NULL
        AND wms_loc_rua(loc.codigo) = v_rua_alvo
      ORDER BY loc.codigo ASC
      LIMIT 1
      FOR UPDATE OF inv_loc SKIP LOCKED;

      IF v_inv_loc_id IS NOT NULL THEN
        v_claim_tipo := 'rua';
        v_claim_codigo := v_rua_alvo;
        v_claim_direcao := 'asc';
      END IF;
    END IF;
  END IF;

  ------------------------------------------------------------------
  -- FASE 2b: claim de prédio com buffer ≥1
  ------------------------------------------------------------------
  IF v_inv_loc_id IS NULL THEN
    WITH predios_ativos AS (
      SELECT DISTINCT
        CASE
          WHEN op.claim_tipo IN ('predio','colisao') THEN op.claim_codigo
          WHEN op.claim_tipo = 'rua' THEN
            (SELECT wms_loc_predio(loc.codigo)
               FROM siso_inventario_localizacoes il
               JOIN siso_localizacoes loc ON loc.id = il.localizacao_id
              WHERE il.sessao_id = p_sessao
                AND il.bloqueada_por = op.usuario_id
                AND il.status = 'em_contagem'
              ORDER BY il.bloqueada_em DESC NULLS LAST
              LIMIT 1)
        END AS predio
      FROM siso_inventario_operadores op
      WHERE op.sessao_id = p_sessao
        AND op.finalizado_em IS NULL
        AND op.id != v_meu_op_id
        AND op.claim_tipo IS NOT NULL
      UNION
      SELECT DISTINCT wms_loc_predio(loc.codigo) AS predio
      FROM siso_inventario_localizacoes inv_loc
      JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
      WHERE inv_loc.sessao_id = p_sessao
        AND inv_loc.status = 'em_contagem'
        AND inv_loc.bloqueada_por IS NOT NULL
        AND inv_loc.bloqueada_por != p_user
    ),
    predios_pendentes AS (
      SELECT wms_loc_predio(loc.codigo) AS predio,
             wms_loc_rua(loc.codigo) AS rua,
             wms_loc_horizontal_int(loc.codigo) AS horizontal,
             COUNT(*) AS qty_andares
      FROM siso_inventario_localizacoes inv_loc
      JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
      WHERE inv_loc.sessao_id = p_sessao
        AND inv_loc.status = 'pendente'
        AND inv_loc.bloqueada_por IS NULL
      GROUP BY wms_loc_predio(loc.codigo),
               wms_loc_rua(loc.codigo),
               wms_loc_horizontal_int(loc.codigo)
    ),
    predios_buffered AS (
      SELECT pp.predio, pp.rua, pp.horizontal, pp.qty_andares
      FROM predios_pendentes pp
      WHERE pp.predio NOT IN (SELECT predio FROM predios_ativos WHERE predio IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1
          FROM predios_ativos pa
          JOIN predios_pendentes pa_info ON pa_info.predio = pa.predio
          WHERE pa_info.rua = pp.rua
            AND pa_info.horizontal IS NOT NULL
            AND pp.horizontal IS NOT NULL
            AND ABS(pa_info.horizontal - pp.horizontal) < 2
        )
        AND NOT EXISTS (
          SELECT 1
          FROM siso_inventario_operadores op
          WHERE op.sessao_id = p_sessao
            AND op.finalizado_em IS NULL
            AND op.id != v_meu_op_id
            AND op.claim_tipo IN ('predio','colisao')
            AND wms_loc_rua(op.claim_codigo) = pp.rua
            AND wms_loc_horizontal_int(op.claim_codigo) IS NOT NULL
            AND pp.horizontal IS NOT NULL
            AND ABS(wms_loc_horizontal_int(op.claim_codigo) - pp.horizontal) < 2
        )
    )
    SELECT pb.predio
      INTO v_predio_alvo
    FROM predios_buffered pb
    ORDER BY pb.qty_andares DESC, pb.predio ASC
    LIMIT 1;

    IF v_predio_alvo IS NOT NULL THEN
      SELECT inv_loc.id, loc.id, loc.codigo, loc.tipo,
             COALESCE(loc.zona, wms_loc_rua(loc.codigo))
        INTO v_inv_loc_id, v_loc_id, v_codigo, v_tipo, v_zona
      FROM siso_inventario_localizacoes inv_loc
      JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
      WHERE inv_loc.sessao_id = p_sessao
        AND inv_loc.status = 'pendente'
        AND inv_loc.bloqueada_por IS NULL
        AND wms_loc_predio(loc.codigo) = v_predio_alvo
      ORDER BY loc.codigo ASC
      LIMIT 1
      FOR UPDATE OF inv_loc SKIP LOCKED;

      IF v_inv_loc_id IS NOT NULL THEN
        v_claim_tipo := 'predio';
        v_claim_codigo := v_predio_alvo;
        v_claim_direcao := 'asc';

        -- Auto-degrade: rua claim em mesma rua, dono em em_contagem
        UPDATE siso_inventario_operadores op
        SET claim_tipo = 'predio',
            claim_codigo = (
              SELECT wms_loc_predio(loc.codigo)
              FROM siso_inventario_localizacoes il
              JOIN siso_localizacoes loc ON loc.id = il.localizacao_id
              WHERE il.sessao_id = p_sessao
                AND il.bloqueada_por = op.usuario_id
                AND il.status = 'em_contagem'
              ORDER BY il.bloqueada_em DESC NULLS LAST
              LIMIT 1
            ),
            claim_atualizado_em = now()
        WHERE op.sessao_id = p_sessao
          AND op.finalizado_em IS NULL
          AND op.id != v_meu_op_id
          AND op.claim_tipo = 'rua'
          AND op.claim_codigo = wms_loc_rua(v_predio_alvo)
          AND EXISTS (
            SELECT 1
            FROM siso_inventario_localizacoes il2
            WHERE il2.sessao_id = p_sessao
              AND il2.bloqueada_por = op.usuario_id
              AND il2.status = 'em_contagem'
          );
      END IF;
    END IF;
  END IF;

  ------------------------------------------------------------------
  -- FASE 2c: prédio sem buffer (mais distante de qualquer ativo)
  ------------------------------------------------------------------
  IF v_inv_loc_id IS NULL THEN
    WITH predios_ativos AS (
      SELECT DISTINCT
        CASE
          WHEN op.claim_tipo IN ('predio','colisao') THEN op.claim_codigo
          WHEN op.claim_tipo = 'rua' THEN
            (SELECT wms_loc_predio(loc.codigo)
               FROM siso_inventario_localizacoes il
               JOIN siso_localizacoes loc ON loc.id = il.localizacao_id
              WHERE il.sessao_id = p_sessao
                AND il.bloqueada_por = op.usuario_id
                AND il.status = 'em_contagem'
              ORDER BY il.bloqueada_em DESC NULLS LAST
              LIMIT 1)
        END AS predio
      FROM siso_inventario_operadores op
      WHERE op.sessao_id = p_sessao
        AND op.finalizado_em IS NULL
        AND op.id != v_meu_op_id
        AND op.claim_tipo IS NOT NULL
    ),
    predios_pendentes AS (
      SELECT wms_loc_predio(loc.codigo) AS predio,
             wms_loc_rua(loc.codigo) AS rua,
             wms_loc_horizontal_int(loc.codigo) AS horizontal,
             COUNT(*) AS qty_andares
      FROM siso_inventario_localizacoes inv_loc
      JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
      WHERE inv_loc.sessao_id = p_sessao
        AND inv_loc.status = 'pendente'
        AND inv_loc.bloqueada_por IS NULL
      GROUP BY wms_loc_predio(loc.codigo),
               wms_loc_rua(loc.codigo),
               wms_loc_horizontal_int(loc.codigo)
    ),
    predios_com_distancia AS (
      SELECT pp.predio,
             pp.qty_andares,
             COALESCE(
               (SELECT MIN(ABS(pa_info.horizontal - pp.horizontal))
                  FROM predios_ativos pa
                  JOIN predios_pendentes pa_info ON pa_info.predio = pa.predio
                 WHERE pa_info.rua = pp.rua
                   AND pa_info.horizontal IS NOT NULL
                   AND pp.horizontal IS NOT NULL),
               999
             ) AS dist_min_ativo
      FROM predios_pendentes pp
      WHERE pp.predio NOT IN (SELECT predio FROM predios_ativos WHERE predio IS NOT NULL)
    )
    SELECT pd.predio
      INTO v_predio_alvo
    FROM predios_com_distancia pd
    ORDER BY pd.dist_min_ativo DESC, pd.qty_andares DESC, pd.predio ASC
    LIMIT 1;

    IF v_predio_alvo IS NOT NULL THEN
      SELECT inv_loc.id, loc.id, loc.codigo, loc.tipo,
             COALESCE(loc.zona, wms_loc_rua(loc.codigo))
        INTO v_inv_loc_id, v_loc_id, v_codigo, v_tipo, v_zona
      FROM siso_inventario_localizacoes inv_loc
      JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
      WHERE inv_loc.sessao_id = p_sessao
        AND inv_loc.status = 'pendente'
        AND inv_loc.bloqueada_por IS NULL
        AND wms_loc_predio(loc.codigo) = v_predio_alvo
      ORDER BY loc.codigo ASC
      LIMIT 1
      FOR UPDATE OF inv_loc SKIP LOCKED;

      IF v_inv_loc_id IS NOT NULL THEN
        v_claim_tipo := 'predio';
        v_claim_codigo := v_predio_alvo;
        v_claim_direcao := 'asc';

        UPDATE siso_inventario_operadores op
        SET claim_tipo = 'predio',
            claim_codigo = (
              SELECT wms_loc_predio(loc.codigo)
              FROM siso_inventario_localizacoes il
              JOIN siso_localizacoes loc ON loc.id = il.localizacao_id
              WHERE il.sessao_id = p_sessao
                AND il.bloqueada_por = op.usuario_id
                AND il.status = 'em_contagem'
              ORDER BY il.bloqueada_em DESC NULLS LAST
              LIMIT 1
            ),
            claim_atualizado_em = now()
        WHERE op.sessao_id = p_sessao
          AND op.finalizado_em IS NULL
          AND op.id != v_meu_op_id
          AND op.claim_tipo = 'rua'
          AND op.claim_codigo = wms_loc_rua(v_predio_alvo)
          AND EXISTS (
            SELECT 1
            FROM siso_inventario_localizacoes il2
            WHERE il2.sessao_id = p_sessao
              AND il2.bloqueada_por = op.usuario_id
              AND il2.status = 'em_contagem'
          );
      END IF;
    END IF;
  END IF;

  ------------------------------------------------------------------
  -- FASE 2d: último prédio + colisão controlada (máx 2 ops, dist vert máx)
  ------------------------------------------------------------------
  IF v_inv_loc_id IS NULL THEN
    SELECT COUNT(DISTINCT wms_loc_predio(loc.codigo))
      INTO v_predios_pendentes_total
    FROM siso_inventario_localizacoes inv_loc
    JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
    WHERE inv_loc.sessao_id = p_sessao
      AND inv_loc.status = 'pendente'
      AND inv_loc.bloqueada_por IS NULL;

    SELECT DISTINCT wms_loc_predio(loc.codigo)
      INTO v_predio_alvo
    FROM siso_inventario_localizacoes inv_loc
    JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
    WHERE inv_loc.sessao_id = p_sessao
      AND inv_loc.status = 'em_contagem'
      AND inv_loc.bloqueada_por IS NOT NULL
      AND inv_loc.bloqueada_por != p_user
    LIMIT 1;

    IF v_predios_pendentes_total = 1 AND v_predio_alvo IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM siso_inventario_localizacoes inv_loc
        JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
        WHERE inv_loc.sessao_id = p_sessao
          AND inv_loc.status = 'pendente'
          AND inv_loc.bloqueada_por IS NULL
          AND wms_loc_predio(loc.codigo) = v_predio_alvo
      ) THEN
        v_predio_alvo := NULL;
      END IF;
    ELSE
      v_predio_alvo := NULL;
    END IF;

    IF v_predio_alvo IS NOT NULL THEN
      IF (
        SELECT COUNT(*)
        FROM siso_inventario_operadores op
        WHERE op.sessao_id = p_sessao
          AND op.finalizado_em IS NULL
          AND op.id != v_meu_op_id
          AND op.claim_tipo IN ('predio','colisao')
          AND op.claim_codigo = v_predio_alvo
      ) < 2 THEN
        SELECT inv_loc.id, loc.id, loc.codigo, loc.tipo,
               COALESCE(loc.zona, wms_loc_rua(loc.codigo))
          INTO v_inv_loc_id, v_loc_id, v_codigo, v_tipo, v_zona
        FROM siso_inventario_localizacoes inv_loc
        JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
        WHERE inv_loc.sessao_id = p_sessao
          AND inv_loc.status = 'pendente'
          AND inv_loc.bloqueada_por IS NULL
          AND wms_loc_predio(loc.codigo) = v_predio_alvo
        ORDER BY loc.codigo DESC
        LIMIT 1
        FOR UPDATE OF inv_loc SKIP LOCKED;

        IF v_inv_loc_id IS NOT NULL THEN
          v_claim_tipo := 'colisao';
          v_claim_codigo := v_predio_alvo;
          v_claim_direcao := 'desc';
        END IF;
      END IF;
    END IF;
  END IF;

  ------------------------------------------------------------------
  -- Pool vazio: esgotou todas as fases sem achar nada
  ------------------------------------------------------------------
  IF v_inv_loc_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'pool_vazio', true);
  END IF;

  ------------------------------------------------------------------
  -- Atribuir: marca loc como em_contagem, atualiza claim do operador
  ------------------------------------------------------------------
  UPDATE siso_inventario_localizacoes
  SET bloqueada_por = p_user,
      bloqueada_em = now(),
      status = 'em_contagem',
      contagem_iniciada_em = COALESCE(contagem_iniciada_em, now())
  WHERE id = v_inv_loc_id;

  UPDATE siso_inventario_operadores
  SET claim_tipo = v_claim_tipo,
      claim_codigo = v_claim_codigo,
      claim_direcao = v_claim_direcao,
      claim_atualizado_em = now(),
      ultima_acao_em = now()
  WHERE id = v_meu_op_id;

  -- Modo aberto: anexa lista de SKUs esperados
  IF v_modo = 'aberto' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'produto_id', e.produto_id,
      'sku', p.sku,
      'descricao', p.descricao,
      'saldo_esperado', e.saldo,
      'empresa_dona_id', e.empresa_dona_id
    ))
      INTO v_esperados
    FROM siso_estoque e
    JOIN siso_produtos p ON p.id = e.produto_id
    WHERE e.localizacao_id = v_loc_id
      AND e.saldo > 0
      AND (v_empresa_dona IS NULL OR e.empresa_dona_id = v_empresa_dona);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'pool_vazio', false,
    'inv_loc_id', v_inv_loc_id,
    'loc_id', v_loc_id,
    'codigo', v_codigo,
    'tipo', v_tipo,
    'zona', v_zona,
    'modo', v_modo,
    'esperados', v_esperados,
    'claim_tipo', v_claim_tipo,
    'claim_codigo', v_claim_codigo,
    'claim_direcao', v_claim_direcao
  );
END;
$$;

------------------------------------------------------------------------------
-- 5. Trigger: quando op finaliza slot (sairSlot), limpa claim
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wms_inv_trigger_limpar_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.finalizado_em IS NOT NULL AND OLD.finalizado_em IS NULL THEN
    NEW.claim_tipo := NULL;
    NEW.claim_codigo := NULL;
    NEW.claim_direcao := NULL;
    NEW.claim_atualizado_em := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inv_limpar_claim ON siso_inventario_operadores;
CREATE TRIGGER trg_inv_limpar_claim
  BEFORE UPDATE OF finalizado_em ON siso_inventario_operadores
  FOR EACH ROW EXECUTE FUNCTION wms_inv_trigger_limpar_claim();

COMMIT;
