-- [INV-05] wms_inventario_proxima_loc v3 — FASE 0 de RETOMADA + p_somente_retomar.
--
-- Bug: refresh do app no meio da contagem perdia a loc ativa. Nenhuma fase da
-- RPC buscava a loc já reivindicada pelo PRÓPRIO operador (todas filtram
-- status='pendente'), então o claim seguinte pegava a PRÓXIMA loc e a antiga
-- ficava órfã em 'em_contagem' por até 30min, quando o recovery descartava os
-- bipes (P0-02) e devolvia ao pool — trabalho perdido + recontagem.
--
-- Fix:
--   FASE 0 (antes de qualquer claim): se existe loc 'em_contagem' com
--   bloqueada_por = p_user na sessão, retorna ELA com retomada=true + 'bipes'
--   (agregado das contagens deste operador na loc, pra reidratar a UI).
--   p_somente_retomar=true: se não há loc ativa, retorna sem_loc_ativa=true SEM
--   claimar nada — usado pelo frontend no mount (refresh não pode claimar).
--
-- Assinatura muda (2→3 params) → DROP antes (evita overload ambíguo no PostgREST).
-- Corpo base: 20260520e_rpc_inventario.sql (fases 1–2d inalteradas).

BEGIN;

DROP FUNCTION IF EXISTS wms_inventario_proxima_loc(uuid, uuid);

CREATE OR REPLACE FUNCTION wms_inventario_proxima_loc(
  p_sessao uuid,
  p_user uuid,
  p_somente_retomar boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_inv_loc_id uuid;
  v_loc_id uuid;
  v_codigo text;
  v_tipo text;
  v_zona text;
  v_modo text;
  v_esperados jsonb;
  v_bipes jsonb;

  v_meu_op_id uuid;
  v_claim_tipo text;
  v_claim_codigo text;
  v_claim_direcao text;
  v_predios_pendentes_total int;
  v_rua_alvo text;
  v_predio_alvo text;
BEGIN
  SELECT id INTO v_meu_op_id
  FROM siso_inventario_operadores
  WHERE sessao_id = p_sessao
    AND usuario_id = p_user
    AND finalizado_em IS NULL;
  IF v_meu_op_id IS NULL THEN
    RAISE EXCEPTION 'usuário não está na party desta sessão';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM siso_inventario_sessoes
    WHERE id = p_sessao AND status = 'em_andamento'
  ) THEN
    RAISE EXCEPTION 'sessão não está em andamento';
  END IF;

  SELECT modo_contagem
  INTO v_modo
  FROM siso_inventario_sessoes
  WHERE id = p_sessao;

  SELECT claim_tipo, claim_codigo, claim_direcao
  INTO v_claim_tipo, v_claim_codigo, v_claim_direcao
  FROM siso_inventario_operadores
  WHERE id = v_meu_op_id;

  ------------------------------------------------------------------
  -- FASE 0 [INV-05]: retomada — loc já em contagem POR ESTE operador.
  -- Refresh/reconexão volta pra MESMA loc em vez de claimar a próxima.
  -- Se houver mais de uma (estado legado do próprio bug), retoma a mais
  -- recente; as demais o recovery resolve.
  ------------------------------------------------------------------
  SELECT inv_loc.id, loc.id, loc.codigo, loc.tipo,
         COALESCE(loc.zona, wms_loc_rua(loc.codigo))
    INTO v_inv_loc_id, v_loc_id, v_codigo, v_tipo, v_zona
  FROM siso_inventario_localizacoes inv_loc
  JOIN siso_localizacoes loc ON loc.id = inv_loc.localizacao_id
  WHERE inv_loc.sessao_id = p_sessao
    AND inv_loc.status = 'em_contagem'
    AND inv_loc.bloqueada_por = p_user
  ORDER BY inv_loc.bloqueada_em DESC NULLS LAST
  LIMIT 1;

  IF v_inv_loc_id IS NOT NULL THEN
    UPDATE siso_inventario_operadores
    SET ultima_acao_em = now()
    WHERE id = v_meu_op_id;

    IF v_modo = 'aberto' THEN
      SELECT jsonb_agg(jsonb_build_object(
        'produto_id', e.produto_id,
        'sku', p.sku,
        'descricao', p.descricao,
        'saldo_esperado', e.saldo
      ))
        INTO v_esperados
      FROM siso_estoque e
      JOIN siso_produtos p ON p.id = e.produto_id
      WHERE e.localizacao_id = v_loc_id
        AND e.saldo > 0;
    END IF;

    -- Bipes já registrados por este operador nesta loc — reidrata a UI.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'produto_id', c.produto_id,
      'sku', p.sku,
      'descricao', p.descricao,
      'qty', c.qty_contada
    )), '[]'::jsonb)
      INTO v_bipes
    FROM siso_inventario_contagens c
    JOIN siso_produtos p ON p.id = c.produto_id
    WHERE c.sessao_id = p_sessao
      AND c.localizacao_id = v_loc_id
      AND c.contada_por = p_user;

    RETURN jsonb_build_object(
      'ok', true,
      'pool_vazio', false,
      'retomada', true,
      'inv_loc_id', v_inv_loc_id,
      'loc_id', v_loc_id,
      'codigo', v_codigo,
      'tipo', v_tipo,
      'zona', v_zona,
      'modo', v_modo,
      'esperados', v_esperados,
      'bipes', v_bipes,
      'claim_tipo', v_claim_tipo,
      'claim_codigo', v_claim_codigo,
      'claim_direcao', v_claim_direcao
    );
  END IF;

  -- Modo só-retomar: sem loc ativa → NÃO claima (mount pós-refresh).
  IF p_somente_retomar THEN
    RETURN jsonb_build_object('ok', true, 'pool_vazio', false, 'sem_loc_ativa', true);
  END IF;

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
      UPDATE siso_inventario_operadores
      SET claim_tipo = NULL, claim_codigo = NULL, claim_direcao = NULL,
          claim_atualizado_em = now()
      WHERE id = v_meu_op_id;
      v_claim_tipo := NULL;
      v_claim_codigo := NULL;
      v_claim_direcao := NULL;
    END IF;
  END IF;

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

  IF v_inv_loc_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'pool_vazio', true);
  END IF;

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

  IF v_modo = 'aberto' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'produto_id', e.produto_id,
      'sku', p.sku,
      'descricao', p.descricao,
      'saldo_esperado', e.saldo
    ))
      INTO v_esperados
    FROM siso_estoque e
    JOIN siso_produtos p ON p.id = e.produto_id
    WHERE e.localizacao_id = v_loc_id
      AND e.saldo > 0;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'pool_vazio', false,
    'retomada', false,
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
$function$;

COMMENT ON FUNCTION wms_inventario_proxima_loc(uuid, uuid, boolean) IS
  '[INV-05] Pull queue do inventário com FASE 0 de retomada (loc em_contagem do próprio operador volta com retomada=true + bipes) e p_somente_retomar (mount pós-refresh não claima).';

COMMIT;
