# Inventário · Modelo Party — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o modelo de "slots numerados (OP1..OP5)" do inventário por um modelo de "party" — lista dinâmica de operadores ativos, sem cap rígido, identidade = usuário, reentrada retoma registro.

**Architecture:** Mudança incremental em 5 camadas: migration → RPC (mensagem só) → service (rename + reentrada) → API (deleta `/slots/*`, cria `/party`) → frontend (handheld pula picker, supervisor vira lista). Sem nova feature — refatoração de modelo. Mais código deletado do que adicionado.

**Tech Stack:** Next.js 16 App Router · TypeScript · Supabase (PostgreSQL + Realtime) · TanStack React Query · Vitest. Spec: `docs/superpowers/specs/2026-05-18-inventario-party-model-design.md`.

**Pré-requisito:** Branch isolado já criado (você está no branch `develop` ou similar pra essa feature). Se for usar worktree, isso já foi feito antes.

---

## File Structure

**Criar:**
- `supabase/migrations/20260518_wms_inventario_party_model.sql` — drop colunas slot/num_operadores, add ultima_reentrada_em, CREATE OR REPLACE da RPC só pra atualizar mensagem de erro.
- `src/app/api/wms/inventario/[id]/party/route.ts` — POST (entrar) + DELETE (sair) na party.
- `src/lib/wms/inventario-party.test.ts` — testes unitários da função pura `decidirAcaoEntrada`.

**Modificar:**
- `src/lib/wms/inventario.ts` — extrai função pura `decidirAcaoEntrada`, renomeia `entrarSlot`→`entrarParty` (com retomada), `sairSlot`→`sairParty`, limpa `CriarSessaoInput` (remove `num_operadores`).
- `src/app/api/wms/inventario/route.ts` — remove `num_operadores` do POST body interface e do call.
- `src/app/wms/inventario/[id]/contar/page.tsx` — apaga componente `SlotPicker`, troca etapa inicial pra auto-entrada via `entrarParty`, renomeia variáveis `meuSlot`→`meuOp`, troca textos "OP{n}" por nome do usuário.
- `src/app/wms/inventario/[id]/page.tsx` — substitui grade fixa OP1..OP{n} por `operadores.filter(ativo).map(<ParticipanteCard>)`, renomeia componente `SlotCard`→`ParticipanteCard`, remove header "· N configurado(s)".
- `src/hooks/use-inventario-realtime.ts` — type `Operador` perde `slot: number`, ganha `ultima_reentrada_em: string | null`.
- `CLAUDE.md` — atualiza blocos `siso_inventario_operadores`, `siso_inventario_sessoes` e o texto da seção "WMS Plano 4 v2".
- `docs/api-reference-complete.md` — substitui rotas `/slots` por `/party`, remove menção a `slot_atribuido` e `num_operadores`.
- `docs/database-schema.md` — atualiza colunas de `siso_inventario_operadores` e `siso_inventario_sessoes`.

**Deletar:**
- `src/app/api/wms/inventario/[id]/slots/route.ts`
- `src/app/api/wms/inventario/[id]/slots/[slot]/entrar/route.ts`
- Diretório `src/app/api/wms/inventario/[id]/slots/` inteiro (depois dos arquivos saírem).

---

## Task 1: Migration SQL — drop slot/num_operadores + add ultima_reentrada_em + RPC com mensagem nova

**Files:**
- Create: `supabase/migrations/20260518_wms_inventario_party_model.sql`

- [ ] **Step 1: Criar arquivo de migration**

Cole o conteúdo exato abaixo. A RPC `wms_inventario_proxima_loc` é reproduzida na íntegra a partir da versão atual em `20260513_wms_inventario_claim_hierarquico.sql`, com APENAS a string da mensagem de erro alterada na linha 136 (era `'usuário não está em nenhum slot ativo desta sessão'` → vira `'usuário não está na party desta sessão'`). Não há outras mudanças no corpo da RPC.

```sql
-- ============================================================================
-- WMS · Inventário · Modelo Party (substitui slots numerados)
-- ============================================================================
-- Troca o conceito de "slot numerado OP1..OP5" por uma "party" de operadores:
-- - lista dinâmica de operadores ativos, sem cap rígido
-- - identidade é o usuário, não um número de cadeira
-- - reentrada reativa registro existente (locs_contadas preservada)
--
-- Como estamos em staging, drop direto sem preservar histórico de sessões.
-- Spec: docs/superpowers/specs/2026-05-18-inventario-party-model-design.md
-- ============================================================================

BEGIN;

------------------------------------------------------------------------------
-- 1. Drop: slot numerado de operador
------------------------------------------------------------------------------

ALTER TABLE siso_inventario_operadores
  DROP CONSTRAINT IF EXISTS siso_inventario_operadores_slot_check;

ALTER TABLE siso_inventario_operadores
  DROP CONSTRAINT IF EXISTS siso_inventario_operadores_sessao_id_slot_key;

ALTER TABLE siso_inventario_operadores
  DROP COLUMN IF EXISTS slot;

------------------------------------------------------------------------------
-- 2. Drop: num_operadores da sessão (ornamental após a0b0063)
------------------------------------------------------------------------------

ALTER TABLE siso_inventario_sessoes
  DROP CONSTRAINT IF EXISTS siso_inventario_sessoes_num_operadores_check;

ALTER TABLE siso_inventario_sessoes
  DROP COLUMN IF EXISTS num_operadores;

------------------------------------------------------------------------------
-- 3. Add: ultima_reentrada_em pra auditar reentradas na party
------------------------------------------------------------------------------

ALTER TABLE siso_inventario_operadores
  ADD COLUMN IF NOT EXISTS ultima_reentrada_em timestamptz NULL;

-- O UNIQUE parcial (sessao_id, usuario_id) WHERE finalizado_em IS NULL
-- já existe (idx uq_inv_op_user_ativo do rewrite.sql 2026-05-12) e continua
-- sendo a única defesa contra duplicação ativa. Reentrada atualiza a linha
-- existente (vide service entrarParty), nunca insere outra.

-- NOTA: siso_inventario_localizacoes.slot_atribuido já foi dropada em
-- 20260513_wms_inventario_claim_hierarquico.sql — nada a fazer aqui.

------------------------------------------------------------------------------
-- 4. RPC: wms_inventario_proxima_loc — só atualiza a mensagem de erro
------------------------------------------------------------------------------
-- Corpo idêntico à versão claim_hierarquico (20260513). A única diferença é
-- a string do RAISE EXCEPTION que mencionava "slot ativo" → vira "party".
-- CREATE OR REPLACE substitui a função inteira, então temos que reproduzir
-- todo o corpo.

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
  -- Confirma presença na party
  SELECT id INTO v_meu_op_id
  FROM siso_inventario_operadores
  WHERE sessao_id = p_sessao
    AND usuario_id = p_user
    AND finalizado_em IS NULL;
  IF v_meu_op_id IS NULL THEN
    RAISE EXCEPTION 'usuário não está na party desta sessão';
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
  -- Pool vazio
  ------------------------------------------------------------------
  IF v_inv_loc_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'pool_vazio', true);
  END IF;

  ------------------------------------------------------------------
  -- Atribuir + retornar
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

COMMIT;
```

- [ ] **Step 2: Verificar que o arquivo foi salvo**

```bash
ls -la supabase/migrations/20260518_wms_inventario_party_model.sql
```

Expected: arquivo existe, tamanho > 15KB (a RPC é grande).

- [ ] **Step 3: Commit da migration**

```bash
git add supabase/migrations/20260518_wms_inventario_party_model.sql
git commit -m "$(cat <<'EOF'
feat(wms/inventario): migration party model — drop slot/num_operadores

Drop colunas siso_inventario_operadores.slot e siso_inventario_sessoes.
num_operadores. Add ultima_reentrada_em pra auditar reentradas na party.
RPC wms_inventario_proxima_loc: troca mensagem de erro 'slot ativo' por
'party' (corpo idêntico ao claim_hierarquico).

Spec: docs/superpowers/specs/2026-05-18-inventario-party-model-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Aplicar migration no staging

**Files:** nenhum (operação no Supabase staging via MCP).

- [ ] **Step 1: Verificar projeto staging**

A migration vai pra projeto Supabase `ehbxpbeijofxtsbezwxd` (WMS staging). Confirma via MCP:

Use `mcp__supabase__list_projects` e localiza o projeto com esse ID. Se não estiver visível, peça ao usuário pra autenticar.

- [ ] **Step 2: Aplicar migration via MCP**

Use `mcp__supabase__apply_migration` com:
- `project_id`: `ehbxpbeijofxtsbezwxd`
- `name`: `20260518_wms_inventario_party_model`
- `query`: conteúdo completo do arquivo `supabase/migrations/20260518_wms_inventario_party_model.sql`

Expected: `{ success: true }` ou similar.

- [ ] **Step 3: Validar drops via SQL**

Use `mcp__supabase__execute_sql` com `project_id: ehbxpbeijofxtsbezwxd` e query:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'siso_inventario_operadores'
  AND column_name IN ('slot', 'ultima_reentrada_em');
```

Expected: 1 linha — `ultima_reentrada_em` (sem `slot`).

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'siso_inventario_sessoes'
  AND column_name = 'num_operadores';
```

Expected: 0 linhas.

- [ ] **Step 4: Validar RPC**

```sql
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname = 'wms_inventario_proxima_loc';
```

Expected: snippet com a string `'usuário não está na party desta sessão'` (sem mais "slot ativo").

---

## Task 3: Atualizar type `Operador` no hook de realtime

**Files:**
- Modify: `src/hooks/use-inventario-realtime.ts:44-59`

- [ ] **Step 1: Editar type Operador**

Substituir:

```ts
export interface Operador {
  id: string;
  slot: number;
  sessao_id: string;
  usuario_id: string;
  entrou_em: string;
  finalizado_em: string | null;
  locs_contadas: number;
  ultima_acao_em: string;
  /** Claim hierárquico ativo. NULL antes do primeiro pull ou após esgotar. */
  claim_tipo: ClaimTipo | null;
  claim_codigo: string | null;
  claim_direcao: ClaimDirecao | null;
  claim_atualizado_em: string | null;
  usuario?: { nome?: string };
}
```

Por:

```ts
export interface Operador {
  id: string;
  sessao_id: string;
  usuario_id: string;
  entrou_em: string;
  /** NULL na primeira entrada. Setada toda vez que reentra na party. */
  ultima_reentrada_em: string | null;
  finalizado_em: string | null;
  locs_contadas: number;
  ultima_acao_em: string;
  /** Claim hierárquico ativo. NULL antes do primeiro pull ou após esgotar. */
  claim_tipo: ClaimTipo | null;
  claim_codigo: string | null;
  claim_direcao: ClaimDirecao | null;
  claim_atualizado_em: string | null;
  usuario?: { nome?: string };
}
```

- [ ] **Step 2: Rodar typecheck**

```bash
npx tsc --noEmit
```

Expected: erros novos em `inventario.ts`, `contar/page.tsx`, `inventario/[id]/page.tsx` apontando uso de `.slot` em `Operador`. Esses serão resolvidos nas tasks seguintes — anote o ranking.

Não commitar ainda — espera tarefas seguintes pra ter um snapshot funcional.

---

## Task 4: Extrair função pura `decidirAcaoEntrada` + escrever testes

**Files:**
- Create: `src/lib/wms/inventario-party.test.ts`
- Modify: `src/lib/wms/inventario.ts` (adiciona export da função pura na seção de slots)

- [ ] **Step 1: Escrever o teste falho primeiro**

Crie `src/lib/wms/inventario-party.test.ts` com:

```ts
import { describe, it, expect } from "vitest";
import { decidirAcaoEntrada } from "./inventario";

describe("decidirAcaoEntrada", () => {
  it("retorna 'criar' quando não existe registro do usuário", () => {
    expect(decidirAcaoEntrada(null)).toEqual({ tipo: "criar" });
  });

  it("retorna 'no-op' quando o usuário já está ativo na party", () => {
    expect(
      decidirAcaoEntrada({ id: "op-1", finalizado_em: null }),
    ).toEqual({ tipo: "no-op" });
  });

  it("retorna 'reativar' quando o usuário saiu e está voltando", () => {
    expect(
      decidirAcaoEntrada({
        id: "op-1",
        finalizado_em: "2026-05-18T13:00:00.000Z",
      }),
    ).toEqual({ tipo: "reativar", id: "op-1" });
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

```bash
npx vitest run src/lib/wms/inventario-party.test.ts
```

Expected: `FAIL` — `decidirAcaoEntrada is not a function` ou similar.

- [ ] **Step 3: Adicionar a função pura em `src/lib/wms/inventario.ts`**

Abre o arquivo e localiza a seção `// Slots de operador (OP1..OP5)` (linha ~189). Substitua o cabeçalho de seção e adicione a função pura logo abaixo, ANTES da função `entrarSlot`:

```ts
// ─────────────────────────────────────────────────────────────────────
// Party de operadores (modelo dinâmico — substitui slots numerados)
// ─────────────────────────────────────────────────────────────────────

export type AcaoEntradaParty =
  | { tipo: "no-op" }
  | { tipo: "reativar"; id: string }
  | { tipo: "criar" };

/** Decide o que fazer quando um usuário tenta entrar na party. Função
 *  pura — não toca DB. Permite testar a lógica de reentrada sem mock. */
export function decidirAcaoEntrada(
  existente: { id: string; finalizado_em: string | null } | null,
): AcaoEntradaParty {
  if (!existente) return { tipo: "criar" };
  if (existente.finalizado_em === null) return { tipo: "no-op" };
  return { tipo: "reativar", id: existente.id };
}
```

- [ ] **Step 4: Rodar o teste de novo e ver passar**

```bash
npx vitest run src/lib/wms/inventario-party.test.ts
```

Expected: `PASS` — 3 testes passam.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/inventario.ts src/lib/wms/inventario-party.test.ts
git commit -m "$(cat <<'EOF'
test(wms/inventario): função pura decidirAcaoEntrada da reentrada na party

Extrai a lógica de decisão da reentrada (criar/reativar/no-op) numa
função pura testável, antes de reescrever entrarParty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Reescrever `entrarSlot` → `entrarParty` + `sairSlot` → `sairParty`

**Files:**
- Modify: `src/lib/wms/inventario.ts:193-231`

- [ ] **Step 1: Substituir `entrarSlot` por `entrarParty`**

Localize a função `entrarSlot` (começa na linha ~193). Substitua INTEIRAMENTE pelo bloco abaixo (mantém a posição relativa, logo após `decidirAcaoEntrada`):

```ts
export async function entrarParty(
  sessaoId: string,
  usuarioId: string,
): Promise<{ retomado: boolean }> {
  const sb = createServiceClient();

  // Auto-start: se sessão tá planejada, inicia (idempotente)
  await iniciarSessao(sessaoId, usuarioId);

  // Existe registro deste usuário nesta sessão? (ativo ou finalizado)
  const { data: existente, error: errSel } = await sb
    .from("siso_inventario_operadores")
    .select("id, finalizado_em")
    .eq("sessao_id", sessaoId)
    .eq("usuario_id", usuarioId)
    .maybeSingle();
  if (errSel) throw errSel;

  const acao = decidirAcaoEntrada(existente);

  if (acao.tipo === "no-op") {
    return { retomado: false };
  }

  if (acao.tipo === "reativar") {
    const nowIso = new Date().toISOString();
    const { error } = await sb
      .from("siso_inventario_operadores")
      .update({
        finalizado_em: null,
        ultima_reentrada_em: nowIso,
        ultima_acao_em: nowIso,
      })
      .eq("id", acao.id);
    if (error) throw error;
    return { retomado: true };
  }

  // acao.tipo === "criar"
  const { error } = await sb.from("siso_inventario_operadores").insert({
    sessao_id: sessaoId,
    usuario_id: usuarioId,
  });
  if (error) {
    // 23505 = duplicate key (UNIQUE parcial em sessao+user ativo). Pode
    // acontecer em race condition rara entre maybeSingle e insert. Trata
    // como no-op (alguém já entrou pelo mesmo user concorrente).
    if (error.code === "23505") return { retomado: false };
    throw error;
  }
  return { retomado: false };
}
```

- [ ] **Step 2: Substituir `sairSlot` por `sairParty`**

Localize a função `sairSlot` (logo abaixo de entrarSlot). Substitua inteira por:

```ts
export async function sairParty(
  sessaoId: string,
  usuarioId: string,
): Promise<void> {
  const sb = createServiceClient();
  await sb
    .from("siso_inventario_operadores")
    .update({ finalizado_em: new Date().toISOString() })
    .eq("sessao_id", sessaoId)
    .eq("usuario_id", usuarioId)
    .is("finalizado_em", null);
}
```

- [ ] **Step 3: Rodar typecheck e testes**

```bash
npx tsc --noEmit
npx vitest run src/lib/wms/inventario-party.test.ts
```

Expected typecheck: erros novos em arquivos que ainda importam `entrarSlot`/`sairSlot` (API routes + páginas) — resolveremos nas próximas tasks. Confirma que os erros são SÓ esses (sem regressão de tipo na função em si).

Expected vitest: 3 PASS.

Não commitar — segue pra próxima task.

---

## Task 6: Limpar `CriarSessaoInput` (remove `num_operadores`)

**Files:**
- Modify: `src/lib/wms/inventario.ts:31-80`

- [ ] **Step 1: Limpar interface `CriarSessaoInput`**

Localize a interface e remova o campo `num_operadores`:

```ts
export interface CriarSessaoInput {
  tipo: TipoSessao;
  nome?: string;
  galpao_id: string;
  empresa_dona_id?: string | null;
  modo_contagem?: ModoContagem;
  tolerancia_pct?: number;
  tolerancia_qty_min?: number;
  exige_aprovacao_acima_valor?: number;
  observacoes?: string;
  criada_por: string;
  localizacoes: LocSessaoInput[];
}
```

(Apaga as 4 linhas: comentário JSDoc + `num_operadores?: number;`.)

- [ ] **Step 2: Limpar `criarSessao`**

Substitua o corpo atual da função `criarSessao` (linha ~49) pelo bloco abaixo. As mudanças: apaga `const numOps = ...`, apaga `num_operadores: numOps` do insert.

```ts
export async function criarSessao(input: CriarSessaoInput): Promise<string> {
  if (input.localizacoes.length === 0) {
    throw new Error("sessão precisa de pelo menos uma localização");
  }
  const sb = createServiceClient();
  const { data: sessao, error } = await sb
    .from("siso_inventario_sessoes")
    .insert({
      tipo: input.tipo,
      nome: input.nome ?? null,
      galpao_id: input.galpao_id,
      empresa_dona_id: input.empresa_dona_id ?? null,
      modo_contagem: input.modo_contagem ?? "blind",
      tolerancia_pct: input.tolerancia_pct ?? 2.0,
      tolerancia_qty_min: input.tolerancia_qty_min ?? 0,
      exige_aprovacao_acima_valor: input.exige_aprovacao_acima_valor ?? 1000,
      observacoes: input.observacoes ?? null,
      criada_por: input.criada_por,
      tamanho_pool: input.localizacoes.length,
    })
    .select("id")
    .single();
  if (error) throw error;
  const sessaoId = (sessao as { id: string }).id;

  const rows = input.localizacoes.map((l) => ({
    sessao_id: sessaoId,
    localizacao_id: l.localizacao_id,
    motivo: l.motivo ?? "manual",
  }));

  const { error: errL } = await sb
    .from("siso_inventario_localizacoes")
    .insert(rows);
  if (errL) {
    await sb
      .from("siso_inventario_sessoes")
      .update({ status: "cancelada" })
      .eq("id", sessaoId);
    throw errL;
  }
  return sessaoId;
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: erros remanescentes só em `src/app/api/wms/inventario/route.ts` (POST body) — próximo task. Sem regressão em `inventario.ts` agora.

Sem commit ainda.

---

## Task 7: Limpar POST `/api/wms/inventario` (remove `num_operadores`)

**Files:**
- Modify: `src/app/api/wms/inventario/route.ts:40-83`

- [ ] **Step 1: Remover `num_operadores` do body type**

Localize a interface `PostBody` (linha ~37). Remova a linha `num_operadores?: number;`:

```ts
interface PostBody {
  tipo: TipoSessao;
  nome?: string;
  galpao_id: string;
  empresa_dona_id?: string | null;
  modo_contagem?: "aberto" | "blind";
  tolerancia_pct?: number;
  tolerancia_qty_min?: number;
  exige_aprovacao_acima_valor?: number;
  observacoes?: string;
  localizacoes?: LocSessaoInput[];
}
```

- [ ] **Step 2: Remover do call `criarSessao`**

Localize o `criarSessao({...})` (linha ~70) e apague a linha `num_operadores: body.num_operadores,`:

```ts
    const id = await criarSessao({
      tipo: body.tipo,
      nome: body.nome,
      galpao_id: body.galpao_id,
      empresa_dona_id: body.empresa_dona_id,
      modo_contagem: body.modo_contagem,
      tolerancia_pct: body.tolerancia_pct,
      tolerancia_qty_min: body.tolerancia_qty_min,
      exige_aprovacao_acima_valor: body.exige_aprovacao_acima_valor,
      observacoes: body.observacoes,
      criada_por: auth.user.id,
      localizacoes: body.localizacoes,
    });
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: erros remanescentes só nas páginas (`contar/page.tsx`, `[id]/page.tsx`) e nas rotas `/slots/*` antigas que ainda importam `entrarSlot`/`sairSlot`. Sem regressão nos arquivos modificados.

Sem commit ainda.

---

## Task 8: Criar nova rota `/api/wms/inventario/[id]/party`

**Files:**
- Create: `src/app/api/wms/inventario/[id]/party/route.ts`

- [ ] **Step 1: Criar diretório e arquivo**

```bash
mkdir -p src/app/api/wms/inventario/\[id\]/party
```

Crie `src/app/api/wms/inventario/[id]/party/route.ts` com:

```ts
import { NextRequest, NextResponse } from "next/server";
import { entrarParty, sairParty } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// POST /api/wms/inventario/[id]/party
// Operador entra na party desta sessão. Idempotente: chamadas repetidas
// pelo mesmo user retornam ok sem duplicar. Auto-inicia a sessão se
// ainda estiver em 'planejada'. Reentrada (após sair) retorna retomado=true
// e preserva locs_contadas acumulada.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const { retomado } = await entrarParty(id, auth.user.id);
    return NextResponse.json({ ok: true, retomado });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.party.entrar",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/party`,
      requestMethod: "POST",
      metadata: { sessao_id: id, usuario_id: auth.user.id },
    });
  }
}

// DELETE /api/wms/inventario/[id]/party
// Operador (auth.user) sai da party. Locs em em_contagem dele ficam
// até o cleanup cron (siso_inventario_recovery) liberar. Reentrar depois
// preserva locs_contadas.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    await sairParty(id, auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.party.sair",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/party`,
      requestMethod: "DELETE",
      metadata: { sessao_id: id, usuario_id: auth.user.id },
    });
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: erros remanescentes só nas páginas + nas rotas antigas `/slots/*`. A nova rota `/party` deve passar limpo.

Sem commit ainda.

---

## Task 9: Deletar rotas antigas `/slots`

**Files:**
- Delete: `src/app/api/wms/inventario/[id]/slots/route.ts`
- Delete: `src/app/api/wms/inventario/[id]/slots/[slot]/entrar/route.ts`
- Delete: diretório `src/app/api/wms/inventario/[id]/slots/`

- [ ] **Step 1: Apagar os arquivos e o diretório**

```bash
rm src/app/api/wms/inventario/\[id\]/slots/route.ts
rm src/app/api/wms/inventario/\[id\]/slots/\[slot\]/entrar/route.ts
rm -rf src/app/api/wms/inventario/\[id\]/slots
```

- [ ] **Step 2: Verificar que sumiu**

```bash
find src/app/api/wms/inventario/\[id\]/slots 2>&1 | head -3
```

Expected: `find: src/app/api/wms/inventario/[id]/slots: No such file or directory`.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: erros remanescentes só nas páginas `/wms/inventario/[id]/contar/page.tsx` e `/wms/inventario/[id]/page.tsx` (uso de `.slot`, `entrarSlot`, `sairSlot`, `num_operadores`).

Sem commit ainda — agrupar com refactor das páginas.

---

## Task 10: Refatorar handheld `/wms/inventario/[id]/contar/page.tsx`

**Files:**
- Modify: `src/app/wms/inventario/[id]/contar/page.tsx`

Esse é o passo mais grande do plano (página com ~1000 linhas). Quebra em sub-steps cirúrgicos.

- [ ] **Step 1: Remover `num_operadores` da type local**

Linha 17-27 — substituir:

```ts
interface SessaoDetail {
  sessao?: {
    id: string;
    nome?: string;
    tipo: string;
    modo_contagem: "aberto" | "blind";
    empresa_dona_id?: string | null;
    status: string;
    num_operadores?: number;
  };
}
```

Por:

```ts
interface SessaoDetail {
  sessao?: {
    id: string;
    nome?: string;
    tipo: string;
    modo_contagem: "aberto" | "blind";
    empresa_dona_id?: string | null;
    status: string;
  };
}
```

- [ ] **Step 2: Trocar nome do tipo `Etapa` (remove `slot-picker`, adiciona `entering`)**

Linha 48 — substituir:

```ts
type Etapa = "slot-picker" | "standby" | "confirming-loc" | "counting" | "pool-vazio";
```

Por:

```ts
type Etapa = "entering" | "standby" | "confirming-loc" | "counting" | "pool-vazio";
```

E linha 61 (`useState<Etapa>("slot-picker")`):

```ts
  const [etapa, setEtapa] = useState<Etapa>("entering");
```

- [ ] **Step 3: Renomear `meuSlot` → `meuOp` em todo o arquivo**

Use Edit com `replace_all: true`:
- `meuSlot` → `meuOp`

(Atinge declaração na linha 86 e todos os usos subsequentes.)

- [ ] **Step 4: Substituir useEffect de sincronização etapa**

Linhas 92-98 — substituir:

```ts
  // Sincroniza etapa com slot: se já tem slot e tá em slot-picker, vai pra standby
  useEffect(() => {
    if (meuOp && etapa === "slot-picker") {
      setEtapa("standby");
      setEntrouEm(new Date(meuOp.entrou_em).getTime());
    }
  }, [meuOp, etapa]);
```

Por:

```ts
  // Sincroniza etapa com presença: se já entrou na party e tá em 'entering',
  // pula direto pra standby. Setado tanto pela auto-entrada quanto por usuário
  // que já estava ativo numa sessão anterior do app.
  useEffect(() => {
    if (meuOp && etapa === "entering") {
      setEtapa("standby");
      setEntrouEm(new Date(meuOp.entrou_em).getTime());
    }
  }, [meuOp, etapa]);
```

- [ ] **Step 5: Substituir mutations `entrarSlot` e `sairSlot`**

Linhas 107-131 — substituir o bloco inteiro:

```ts
  // ─── Mutations ───
  const entrarSlot = useMutation({
    mutationFn: (slot: number) =>
      wmsApi<{ ok: true; slot: number }>(
        `/api/wms/inventario/${id}/slots/${slot}/entrar`,
        { method: "POST" },
      ),
    onSuccess: (r) => {
      toast.success(`Entrou como OP${r.slot}`);
      setEntrouEm(Date.now());
      setEtapa("standby");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sairSlot = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/slots`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Você saiu do slot");
      router.push(`/wms/inventario/${id}`);
```

Por:

```ts
  // ─── Mutations ───
  const [retomadoFlag, setRetomadoFlag] = useState(false);

  const entrarParty = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true; retomado: boolean }>(
        `/api/wms/inventario/${id}/party`,
        { method: "POST" },
      ),
    onSuccess: (r) => {
      if (r.retomado) {
        setRetomadoFlag(true);
        toast.success("Voltou pra party — contagens preservadas");
        // Limpa o flag após 5s pra esconder o selo "retomado" do header
        setTimeout(() => setRetomadoFlag(false), 5000);
      } else {
        toast.success("Entrou na party");
      }
      setEntrouEm(Date.now());
      setEtapa("standby");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sairParty = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/party`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Você saiu da party");
      router.push(`/wms/inventario/${id}`);
```

(Os `}` e `});` finais do `sairSlot` ficam — só renomeou o objeto.)

- [ ] **Step 6: Adicionar auto-entrada na party**

Logo após o bloco de mutations renomeadas (procura o useEffect que faz `if (etapa === "confirming-loc"...) { scanRef.current?.focus(); }` na linha ~101), ADICIONE um useEffect novo ACIMA dele:

```ts
  // Auto-entrada: ao montar, se user não está na party ainda, entra automático
  useEffect(() => {
    if (!user || meuOp || entrarParty.isPending) return;
    if (etapa !== "entering") return;
    entrarParty.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, meuOp, etapa]);
```

- [ ] **Step 7: Apagar o bloco `// Slot picker` (lines ~424-435)**

Localize e apague:

```ts
  // Slot picker
  if (etapa === "slot-picker") {
    return (
      <SlotPicker
        operadores={operadores}
        meuId={user?.id}
        onEscolher={(slot) => entrarSlot.mutate(slot)}
        pending={entrarSlot.isPending}
        numSlots={sessao?.num_operadores ?? 5}
      />
    );
  }
```

Substitua por:

```ts
  // Entrando na party
  if (etapa === "entering") {
    return (
      <div className="wms-loading-pane">
        {entrarParty.isPending ? "Entrando na party…" : "Aguardando…"}
      </div>
    );
  }
```

- [ ] **Step 8: Atualizar `PageHeader` (subtitle + botão sair)**

Localize o bloco que começa com `<PageHeader title={sessao.nome ?? ...}` (linha ~440). Substitua o subtitle e o botão:

De:

```tsx
        subtitle={`Você é OP${meuOp?.slot ?? "?"} · ${
          modoBlind ? "blind" : "aberto"
        }`}
      >
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={() => {
            if (
              confirm(
                "Sair do slot? Locs em contagem ficam liberadas pra cleanup.",
              )
            ) {
              sairSlot.mutate();
            }
          }}
        >
          Sair do slot
        </button>
      </PageHeader>
```

Por:

```tsx
        subtitle={`${user?.nome ?? "Você"} na party · ${
          modoBlind ? "blind" : "aberto"
        }${retomadoFlag ? " · ↻ retomado" : ""}`}
      >
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={() => {
            if (
              confirm(
                "Sair da party? Locs em contagem ficam liberadas pra cleanup.",
              )
            ) {
              sairParty.mutate();
            }
          }}
        >
          Sair da party
        </button>
      </PageHeader>
```

- [ ] **Step 9: Atualizar botão sair no `ResumoFinal`**

Localize linha ~418 (no return de `etapa === "pool-vazio"`):

```tsx
        onSair={() => sairSlot.mutate()}
```

Substituir por:

```tsx
        onSair={() => sairParty.mutate()}
```

- [ ] **Step 10: Atualizar referências a `meuOp.slot` no resto do arquivo**

Existe outra ocorrência perto da linha ~940 (`Sair do slot`). Procurar e atualizar:

```bash
grep -n "Sair do slot\|sairSlot\|entrarSlot\|meuOp.slot\|OP\${meu" src/app/wms/inventario/\[id\]/contar/page.tsx
```

Substituir cada ocorrência:
- `Sair do slot` → `Sair da party`
- `sairSlot.mutate()` → `sairParty.mutate()`
- `sairSlot.isPending` → `sairParty.isPending`
- `entrarSlot.mutate(...)` → `entrarParty.mutate()` (sem argumento agora)
- `entrarSlot.isPending` → `entrarParty.isPending`
- `OP${meuOp?.slot ?? "?"}` → `user?.nome ?? "Você"`

- [ ] **Step 11: Apagar componente `SlotPicker`**

Localize a função `function SlotPicker(...)` que começa na linha ~518 e vai até ~605. Apague ela inteira (incluindo o bloco de comentário acima `// ─── ...`).

- [ ] **Step 12: Typecheck**

```bash
npx tsc --noEmit
```

Expected: erros remanescentes só em `src/app/wms/inventario/[id]/page.tsx` (uso de `.slot`, `num_operadores`). O `contar/page.tsx` deve passar limpo.

Sem commit ainda.

---

## Task 11: Refatorar supervisor `/wms/inventario/[id]/page.tsx`

**Files:**
- Modify: `src/app/wms/inventario/[id]/page.tsx`

- [ ] **Step 1: Remover `num_operadores` da type local**

Linha 28-35 — substituir:

```ts
interface SessaoDetail {
  sessao?: {
    id: string;
    nome?: string;
    ...
    num_operadores?: number;
    ...
  };
}
```

Apague apenas a linha `num_operadores?: number;`. (Manter o resto.)

- [ ] **Step 2: Renomear `meuSlot` → `meuOp`**

Use Edit com `replace_all: true`:
- `meuSlot` → `meuOp`

- [ ] **Step 3: Atualizar botão "Continuar como OP{slot}"**

Linha ~342 — substituir:

```tsx
            {meuOp ? `Continuar como OP${meuOp.slot}` : "Entrar como operador"}
```

Por:

```tsx
            {meuOp ? "Continuar contando" : "Entrar na party"}
```

- [ ] **Step 4: Substituir o bloco "Slots de operadores" inteiro**

Localize as linhas ~437-467 (header + grade de slots). Substituir o bloco inteiro:

```tsx
      {/* Slots de operadores */}
      <h3 className="wms-sec-h">
        Slots de operador
        {sessao?.num_operadores ? (
          <span
            className="wms-td-mute"
            style={{ marginLeft: 6, fontSize: 12, fontWeight: 400 }}
          >
            · {sessao.num_operadores} configurado
            {sessao.num_operadores > 1 ? "s" : ""}
          </span>
        ) : null}
      </h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
          marginBottom: 24,
        }}
      >
        {Array.from(
          { length: Math.max(1, Math.min(5, sessao?.num_operadores ?? 5)) },
          (_, i) => i + 1,
        ).map((slot) => {
          const op = operadores.find(
            (o) => o.slot === slot && o.finalizado_em === null,
          );
          return <SlotCard key={slot} slot={slot} op={op} locs={locs} />;
        })}
      </div>
```

Por:

```tsx
      {/* Na party — lista dinâmica de operadores ativos */}
      {(() => {
        const ativos = operadores.filter((o) => o.finalizado_em === null);
        return (
          <>
            <h3 className="wms-sec-h">
              Na party
              {ativos.length > 0 ? (
                <span
                  className="wms-td-mute"
                  style={{ marginLeft: 6, fontSize: 12, fontWeight: 400 }}
                >
                  · {ativos.length} operador
                  {ativos.length > 1 ? "es" : ""}
                </span>
              ) : null}
            </h3>
            {ativos.length === 0 ? (
              <div
                style={{
                  border: "1.5px dashed var(--wms-c-border)",
                  borderRadius: "var(--wms-r-3)",
                  padding: "32px 16px",
                  textAlign: "center",
                  marginBottom: 24,
                  color: "var(--wms-c-mute)",
                  fontStyle: "italic",
                  fontSize: 13,
                }}
              >
                Ninguém na party ainda. Aguardando o primeiro operador entrar.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 10,
                  marginBottom: 24,
                }}
              >
                {ativos.map((op) => (
                  <ParticipanteCard key={op.id} op={op} locs={locs} />
                ))}
              </div>
            )}
          </>
        );
      })()}
```

- [ ] **Step 5: Renomear `SlotCard` → `ParticipanteCard` e atualizar internals**

Localize a função `function SlotCard(...)` (linha ~622). Substitua inteira pelo bloco abaixo. As mudanças vs antes: tira parâmetro `slot`, troca render do "OP{slot}" pelo nome do usuário, adiciona "↻ voltou às HH:MM" se houver `ultima_reentrada_em`. Tipo `op` deixa de ser `Operador | undefined` e vira `Operador` (já que só renderizamos ativos).

```tsx
function ParticipanteCard({
  op,
  locs,
}: {
  op: Operador;
  locs: Array<{
    status: string;
    bloqueada_por: string | null;
    localizacao?: { codigo?: string };
  }>;
}) {
  const locAtual = locs.find(
    (l) => l.bloqueada_por === op.usuario_id && l.status === "em_contagem",
  );

  const horasAtivo = Math.max(
    0.001,
    (Date.now() - new Date(op.entrou_em).getTime()) / 3600000,
  );
  const velocidade =
    horasAtivo > 0 ? Math.round(op.locs_contadas / horasAtivo) : 0;

  // Render do claim ao vivo (rua / prédio / colisão + direção)
  const claimLabel = op.claim_tipo
    ? (() => {
        const arrow =
          op.claim_direcao === "desc" ? "↑" : op.claim_direcao === "asc" ? "↓" : "";
        if (op.claim_tipo === "rua") {
          return `rua ${op.claim_codigo ?? "?"} ${arrow}`.trim();
        }
        if (op.claim_tipo === "predio") {
          return `prédio ${op.claim_codigo ?? "?"} ${arrow}`.trim();
        }
        return `colisão ${op.claim_codigo ?? "?"} ${arrow}`.trim();
      })()
    : null;

  const reentradaLabel = op.ultima_reentrada_em
    ? `↻ voltou às ${new Date(op.ultima_reentrada_em).toLocaleTimeString(
        "pt-BR",
        { hour: "2-digit", minute: "2-digit" },
      )}`
    : null;

  return (
    <div
      style={{
        border: "1px solid var(--wms-c-border)",
        background: "var(--wms-c-faint)",
        borderRadius: "var(--wms-r-3)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minHeight: 130,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13 }}>
          {op.usuario?.nome ?? "Operador"}
        </strong>
        <span
          className="wms-mono wms-td-mute"
          style={{ fontSize: 11, fontFamily: "var(--wms-mono)" }}
        >
          {velocidade} locs/h
        </span>
      </div>
      <div className="wms-td-mute" style={{ fontSize: 11.5 }}>
        {op.locs_contadas} loc(s) contada(s)
      </div>
      {claimLabel && (
        <div
          className="wms-mono"
          style={{
            fontSize: 11,
            color:
              op.claim_tipo === "colisao"
                ? "var(--wms-c-warn)"
                : "var(--wms-c-accent)",
          }}
        >
          {claimLabel}
        </div>
      )}
      {locAtual?.localizacao?.codigo && (
        <div className="wms-mono wms-td-mute" style={{ fontSize: 10.5 }}>
          contando: {locAtual.localizacao.codigo}
        </div>
      )}
      {reentradaLabel && (
        <div className="wms-td-mute" style={{ fontSize: 10.5 }}>
          {reentradaLabel}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

Expected: SUCCESS — sem erros.

- [ ] **Step 7: Rodar build pra checar imports/runtime**

```bash
npm run build
```

Expected: build conclui sem erros (warnings de lint ok).

- [ ] **Step 8: Commit do bundle inteiro de service + API + páginas**

```bash
git add src/lib/wms/inventario.ts \
        src/app/api/wms/inventario/route.ts \
        src/app/api/wms/inventario/\[id\]/party/route.ts \
        src/hooks/use-inventario-realtime.ts \
        src/app/wms/inventario/\[id\]/contar/page.tsx \
        src/app/wms/inventario/\[id\]/page.tsx
git rm -r src/app/api/wms/inventario/\[id\]/slots
git commit -m "$(cat <<'EOF'
feat(wms/inventario): modelo party — lista dinâmica sem slot numerado

Service: entrarSlot/sairSlot → entrarParty/sairParty. entrarParty
upserta por (sessao, user), reativa em reentrada, retorna { retomado }.
criarSessao perde num_operadores.

API: deleta /api/wms/inventario/[id]/slots/* (entrar + sair),
cria /api/wms/inventario/[id]/party (POST + DELETE).

UI handheld: pula SlotPicker — auto-entrada via useEffect ao montar.
Header mostra nome do usuário e selo "↻ retomado" por 5s se voltou.

UI supervisor: grade fixa OP1..OP5 vira lista dinâmica de operadores
ativos (filter+map). Empty state quando ninguém entrou ainda. Card
mostra nome + claim + "↻ voltou às HH:MM" se reentrada.

Hook realtime: type Operador perde slot, ganha ultima_reentrada_em.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Atualizar documentação

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/api-reference-complete.md`
- Modify: `docs/database-schema.md` (se existir referência)

- [ ] **Step 1: Atualizar bloco `siso_inventario_operadores` em CLAUDE.md**

Procura no `CLAUDE.md` a linha que começa com `` `siso_inventario_operadores` | NOVO. Slots OP1..OP5 dinâmicos`` (busca "Slots OP1..OP5 dinâmicos"). Substitua a linha inteira da tabela por:

```
| `siso_inventario_operadores` | Party dinâmica de operadores ativos. **Sem slot numerado** — identidade = `usuario_id`. UNIQUE parcial (sessao_id, usuario_id) WHERE finalizado_em IS NULL evita duplicação. Reentrada (após `sairParty`) reativa registro existente: zera `finalizado_em`, seta `ultima_reentrada_em`, preserva `locs_contadas`. **+ Claim hierárquico ativo**: `claim_tipo` (rua\|predio\|colisao\|NULL), `claim_codigo` (ex: 'A' ou 'A-03'), `claim_direcao` (asc\|desc), `claim_atualizado_em`. Trigger BEFORE UPDATE limpa claim quando `finalizado_em` é setado (sairParty). |
```

- [ ] **Step 2: Atualizar bloco `siso_inventario_sessoes` em CLAUDE.md**

Procurar a linha de tabela de `siso_inventario_sessoes` (busca "Sessão master. nome"). Substituir a linha inteira por:

```
| `siso_inventario_sessoes` | Sessão master. nome (opcional), tipo cycle_count\|completo, modo aberto\|blind (default blind, sem duplo_blind), tolerancia_pct, exige_aprovacao_acima_valor, tamanho_pool. Status workflow: planejada→em_andamento→revisao→aprovada→aplicada\|cancelada. |
```

(Diferença: remove `num_operadores` da descrição.)

- [ ] **Step 3: Atualizar bloco "WMS Plano 4 v2" em CLAUDE.md**

Procura a linha que começa com `**WMS Plano 4 v2 (Inventário pull queue + slots)`. Adicione uma nota no final do parágrafo dela:

Localize:

```
- **WMS Plano 4 v2 (Inventário pull queue + slots) — implementado em staging, 2026-05-12.** ... Migration: `supabase/migrations/20260512_wms_inventario_rewrite.sql`.
```

E adicione logo após o `.` final:

```
**Refatorado 2026-05-18 — modelo party:** dropados `siso_inventario_operadores.slot` e `siso_inventario_sessoes.num_operadores`. Operadores agora são lista dinâmica sem cap rígido — identidade = usuário, reentrada preserva `locs_contadas`. Rotas `/slots/*` viram `/party`. Migration: `supabase/migrations/20260518_wms_inventario_party_model.sql`. Spec: `docs/superpowers/specs/2026-05-18-inventario-party-model-design.md`.
```

- [ ] **Step 4: Atualizar APIs em CLAUDE.md (Project Structure)**

Localize as linhas em `src/app/api/wms/inventario/`:

```
        inventario/[id]/slots/[slot]/entrar/route.ts # POST — assume slot
        inventario/[id]/slots/route.ts     # DELETE — sai do slot
```

Substituir por linha única:

```
        inventario/[id]/party/route.ts     # POST entrar + DELETE sair da party
```

- [ ] **Step 5: Atualizar docs/api-reference-complete.md**

Buscar referências aos endpoints antigos:

```bash
grep -n "inventario/\[id\]/slots\|num_operadores\|slot_atribuido" docs/api-reference-complete.md
```

Para cada ocorrência:
- Substituir bloco do endpoint `POST /api/wms/inventario/[id]/slots/[slot]/entrar` pelo bloco do `POST /api/wms/inventario/[id]/party`. Conteúdo de referência: body vazio, response `{ ok: true, retomado: boolean }` — retomado=true se user já tinha estado e voltou; retomado=false na primeira entrada. Auto-inicia sessão. Auth: warehouse access.
- Substituir bloco do endpoint `DELETE /api/wms/inventario/[id]/slots` pelo `DELETE /api/wms/inventario/[id]/party` (response `{ ok: true }`, idêntico ao antigo em comportamento).
- Remover menções a `num_operadores` no body de `POST /api/wms/inventario`.
- Remover bloco de descrição de `slot_atribuido` (não existe mais — já estava obsoleto, mas a doc ainda menciona).

Salvar e revisar com:

```bash
grep -n "inventario/\[id\]/slots\|num_operadores\|slot_atribuido" docs/api-reference-complete.md
```

Expected: 0 ocorrências.

- [ ] **Step 6: Atualizar docs/database-schema.md (se mencionar campos)**

```bash
grep -n "num_operadores\|slot_atribuido\|operadores.*slot " docs/database-schema.md
```

Para cada ocorrência: remover/atualizar pra refletir o schema novo (`siso_inventario_operadores` sem `slot`, com `ultima_reentrada_em`; `siso_inventario_sessoes` sem `num_operadores`).

- [ ] **Step 7: Commit das docs**

```bash
git add CLAUDE.md docs/api-reference-complete.md docs/database-schema.md
git commit -m "$(cat <<'EOF'
docs: atualiza inventário pro modelo party

- CLAUDE.md: schema de operadores e sessoes; nota no plano 4 v2;
  rota /party em vez de /slots.
- api-reference-complete: troca endpoints /slots por /party, remove
  num_operadores e slot_atribuido.
- database-schema: reflete schema novo.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Validação end-to-end em staging

**Files:** nenhum (validação via Supabase MCP + browser).

- [ ] **Step 1: Subir dev server local apontando pra staging**

```bash
npm run dev
```

Abra `http://localhost:3000/wms/inventario` no browser. Faça login com `Eryk / 1234`.

- [ ] **Step 2: Criar sessão de teste**

No painel, clique "Nova sessão" → escolhe Manual ou Cycle Inteligente, pool pequeno (5-10 locs). Confirme que o modal **não** mostra mais o campo "Operadores esperados" (já tinha sido removido em `a0b0063`; verificação dupla).

- [ ] **Step 3: Validar handheld auto-entry**

Abra `/wms/inventario/<id>/contar` em uma aba nova. Expected:
- Tela mostra "Entrando na party…" por um instante.
- Pula direto pra standby com header "Eryk na party · blind".
- Não há SlotPicker.
- Botão "Próxima loc" aparece.

- [ ] **Step 4: Validar painel do supervisor com 1 operador**

Em outra aba: `/wms/inventario/<id>`. Expected:
- Header "Na party · 1 operador".
- 1 card com "Eryk" + locs_contadas + claim (após primeira loc).
- Sem placeholders OP2..OP5.

- [ ] **Step 5: Validar reentrada**

Na aba `/contar`, clique "Sair da party". Confirma. Volta pra `/wms/inventario/<id>` (router push).

Em seguida, clica "Continuar contando" (texto novo no botão do supervisor).

Expected:
- Tela do contar carrega.
- Toast "Voltou pra party — contagens preservadas".
- Header subtitle mostra "Eryk na party · blind · ↻ retomado" por ~5 segundos, depois some.
- `locs_contadas` exibido continua no número anterior (não zerou).

- [ ] **Step 6: Validar via SQL no Supabase MCP**

```sql
SELECT id, usuario_id, finalizado_em, ultima_reentrada_em, locs_contadas
FROM siso_inventario_operadores
WHERE sessao_id = '<sessao_id_do_teste>'
ORDER BY entrou_em;
```

Expected: 1 linha (não duas), com `finalizado_em: NULL` (reativada), `ultima_reentrada_em` preenchida, `locs_contadas > 0`.

- [ ] **Step 7: Validar empty state (party vazia)**

Crie outra sessão. **Não** abra o handheld. Vá direto pro painel `/wms/inventario/<novo_id>`.

Expected:
- Bloco "Na party" mostra empty state "Ninguém na party ainda. Aguardando o primeiro operador entrar."
- Não tem placeholders OP1..OP5.

- [ ] **Step 8: Sanity check de RPC (claim hierárquico continua funcionando)**

Volta pro handheld de uma sessão, clica "Próxima loc" 2-3 vezes. Expected:
- Cada clique entrega uma loc.
- Claim aparece no card do supervisor (rua/prédio/colisão).
- Sem erro "usuário não está na party desta sessão" (mensagem nova; só apareceria se algo desse muito errado).

- [ ] **Step 9: Documentar resultado**

Se tudo passar, atualiza checklist do plano (este arquivo) como concluído. Se algo falhar, registre no `erros-conhecidos.yaml` seguindo o formato do projeto.

---

## Task 14: Commit final do plano executado

**Files:** nenhum (operação git).

- [ ] **Step 1: Verificar status do git**

```bash
git status
git log --oneline -5
```

Expected: branch limpo, 3 commits novos (migration, feat-bundle, docs).

- [ ] **Step 2: Push pra remote (opcional, conforme política do projeto)**

Se a política do projeto for fazer PR: push pra branch do feature e abrir PR.

```bash
git push origin develop
```

(Confirma com usuário antes de pushar — não faz automático.)

---

## Self-Review

Spec coverage:

- ✅ Drop `siso_inventario_operadores.slot` → Task 1
- ✅ Drop `siso_inventario_sessoes.num_operadores` → Task 1
- ✅ Add `siso_inventario_operadores.ultima_reentrada_em` → Task 1
- ✅ RPC mensagem de erro atualizada → Task 1 (corpo completo reproduzido)
- ✅ Rename `entrarSlot`→`entrarParty` com retomada → Task 5
- ✅ Rename `sairSlot`→`sairParty` → Task 5
- ✅ Limpar `CriarSessaoInput` (remove `num_operadores`) → Task 6
- ✅ Limpar POST `/api/wms/inventario` body → Task 7
- ✅ Criar rota `/party` (POST + DELETE) → Task 8
- ✅ Deletar rotas `/slots/*` → Task 9
- ✅ Handheld: remove SlotPicker, auto-entrada, retomado flag → Task 10
- ✅ Supervisor: lista dinâmica, ParticipanteCard, empty state, "voltou às HH:MM" → Task 11
- ✅ Hook: type `Operador` atualizado → Task 3
- ✅ Testes da função pura → Task 4
- ✅ Docs (CLAUDE.md, api-reference, database-schema) → Task 12
- ✅ Validação E2E em staging → Task 13
- ✅ Critérios de sucesso (handheld sem picker, Maria reentra mantendo 12, 7 ops simultâneos, RPC continua, schema final limpo) → cobertos pelas tasks 10, 11, 13

Placeholder scan: nenhum "TBD", "TODO", "implement later". Code blocks completos.

Type consistency:
- `entrarParty` retorna `{ retomado: boolean }` (Task 5 + Task 8 consistentes)
- `decidirAcaoEntrada` aceita `{ id, finalizado_em } | null` (Task 4 testes + Task 5 uso consistentes)
- `Operador` ganha `ultima_reentrada_em: string | null` (Task 3 type + Task 11 ParticipanteCard consistente)
- `ParticipanteCard` recebe `op: Operador` (não opcional, vs `SlotCard` antigo) — coerente com `ativos.map(op => <ParticipanteCard op={op}>)` (Task 11)

Sem inconsistências. Plano completo.
