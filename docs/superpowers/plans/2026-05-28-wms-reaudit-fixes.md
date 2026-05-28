# WMS Re-audit Fixes (2026-05-28) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os 10 findings residuais (P0-P3) confirmados pela re-auditoria 2026-05-28 do HTML `docs/audit-workflows/reaudit-2026-05-28/00-index.html`.

**Architecture:** Fixes cirúrgicos em 3 frentes — (1) 3 migrações SQL (cron pattern fix, RPC guarda 1-line, 8 RPCs insights 3D), (2) 1 helper de auth novo + 4 endpoint patches, (3) 3 fixes de frontend/lib triviais. Princípio: cada fix segue o pattern já provado por outro fix recente (vault cron, P1 insights patch, `vendas/[id]/route.ts` ownership). Zero feature creep.

**Tech Stack:** PostgreSQL (plpgsql + pg_cron + vault), Next.js 16 route handlers, TypeScript, vitest cenários E2E em `scripts/wms/cenarios`.

---

## Pre-flight: verificações que rodei antes de escrever este plano

Cada finding listado abaixo foi verificado contra o código atual (não só lido do relatório):

| Finding | Verificação |
|---|---|
| P0#1 cron OOM | `mcp__supabase__execute_sql` em `cron.job_run_details` mostrou 5 últimas execuções `status=failed` ERROR Out of memory (2026-05-27 06:00, 12:00, 18:00 + 2026-05-28 00:00, 06:00) |
| P0#2 `guardada_por` NULL | `grep -rn "guardada_por" supabase/migrations/ src/` retornou só backfill + type def. Migrations `20260527_p3_rpc_*` e `20260528_p5_8_*` UPDATEam só `qty_guardada, status, guardada_em` |
| P0#3 vendedor cancel | `src/app/api/wms/vendas/[id]/cancelar/route.ts:26` confirma `requireWarehouseAccess`. Whitelist de `auth.ts:66-79` não inclui `vendas.*` |
| P1#1 vendedor_id mismatch | grep mostra `payload.vendedor_id_override` (frontend nova/page.tsx:188) vs `vendedor_id_alvo` (backend criar/route.ts:92) |
| P1#2 8 RPCs insights | SQL `pg_get_functiondef ILIKE '%e.galpao_id%'` retornou 8 RPCs marcadas `YES_DEPRECATED`, 2 OK_3D |
| P1#3 equivalente CWB/SP | `confirmar/route.ts:110-111` lê `estoques["CWB"]`/`["SP"]`, `:193-202` escreve 10 colunas hardcoded |
| P2#1 desclassificar umbrella | `desclassificar/route.ts:21` confirma `requireWarehouseAccess` |
| P2#2 webhook-processor-wms | `webhook-processor-wms.ts:482` é `pedidoPrev?.vendedor_id ?? null` (sem lookup system-marketplace). Path legacy em `webhook-processor.ts:371-384` tem o lookup |
| P3#1 Banner D10 commented | `pedidos/[id]/page.tsx:675-684` está em bloco `/* ... */` com TODO stale |
| P3#2 devolucoes alias | `devolucoes.ts:510` usa `empresa_referencia:siso_empresas!empresa_id(nome)` enquanto `:493` usa `empresa_receptora` |

**Out of scope deste plano (deferred):** P4 (LocalizacaoCombo allowCreate + recebimento_em_andamento_por timeout), P5 (idempotency rollback marcar failed + drop `siso_pedido_item_estoques`). Esses entram em Fix-Final E ou Fase 7. Os 13 LOW findings novos (não-críticos) ficam no Appendix A do relatório do audit pra serem priorizados depois.

---

## File Structure

**Migrations novas (em `supabase/migrations/`):**
- `20260528_cron_transferencias_vault.sql` — re-schedule cron `cron_transferencias_em_transito_cleanup` usando `vault.decrypted_secrets` + URL hardcoded
- `20260528_p7_guardada_por_no_rpc.sql` — adiciona `guardada_por = p_usuario_id` no UPDATE final de `wms_confirmar_guarda_atomico` (preserva resto)
- `20260528_insights_rpcs_3d_patch_v2.sql` — reescreve 8 RPCs insights pra schema 3D (mesmo padrão de `20260527_insights_rpcs_3d_patch.sql`)

**Código modificado:**
- `src/lib/wms/auth.ts` — adiciona helper `requireWarehouseAccessOrOwnVenda`
- `src/app/api/wms/vendas/[id]/cancelar/route.ts` — usa novo helper
- `src/app/wms/vendas/nova/page.tsx` — renomeia 3 ocorrências `vendedor_id_override` → `vendedor_id_alvo`
- `src/app/api/wms/devolucoes/[id]/desclassificar/route.ts` — substitui `requireWarehouseAccess` por `userCan("operacoes.devolucoes_classificar")`
- `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts` — loop dinâmico sobre `equivalente.estoques` em vez de CWB/SP hardcoded
- `src/lib/webhook-processor-wms.ts` — porta bloco 8d de `webhook-processor.ts:371-384` (lookup `system-marketplace`)
- `src/lib/wms/devolucoes.ts` — troca alias `empresa_referencia` por `empresa_receptora` na linha 510
- `src/app/wms/pedidos/[id]/page.tsx` — descomenta bloco `BannerEstornoManual` botão (linhas 675-684)

**Cenários (em `scripts/wms/cenarios/catalogo/`):**
- Adapt `38-criada-por-guarda.ts` — adiciona asserção de `guardada_por` populado após confirmar
- Novo `59-vendedor-cancela-propria-venda.ts` — cobre regressão P0#3
- Novo `60-criar-venda-em-nome-de-outro.ts` — cobre P1#1 (rename frontend)

---

## Task 1 (P0) — Cron transferências OOM: migrar pra vault pattern

**Why:** Cron quebra 100% das execuções com OOM. TTL `expira_em` + card home viram decorativos. Transferências esquecidas continuam fantasmas. Fix replica o pattern já usado em 4 crons funcionando.

**Files:**
- Create: `supabase/migrations/20260528_cron_transferencias_vault.sql`
- Reference: `supabase/migrations/20260527_cron_insights_refresh_5min.sql` (pattern)
- Reference: `supabase/migrations/20260527_cron_transferencias_em_transito_cleanup.sql` (defeito)

- [ ] **Step 1.1: Confirmar pré-condições no DB**

Run via `mcp__supabase__execute_sql` no project `ehbxpbeijofxtsbezwxd`:

```sql
SELECT
  (SELECT count(*) FROM vault.decrypted_secrets WHERE name = 'worker_secret') AS vault_secret_exists,
  (SELECT count(*) FROM cron.job WHERE jobname = 'cron_transferencias_em_transito_cleanup') AS old_job_exists,
  (SELECT count(*) FROM cron.job WHERE jobname = 'wms_insights_refresh') AS reference_job_exists;
```

Expected: `vault_secret_exists=1, old_job_exists=1, reference_job_exists=1`. Se `vault_secret_exists=0`, parar — a vault secret precisa existir (P1 já configurou). Se 0, ver `docs/superpowers/plans/2026-05-26-wms-fix-p1-foundation-realtime-insights.md` task 4.1.

- [ ] **Step 1.2: Escrever a migration**

```sql
-- supabase/migrations/20260528_cron_transferencias_vault.sql
-- Re-schedule cron_transferencias_em_transito_cleanup com vault pattern.
-- Substitui o pattern current_setting('app.base_url', true) que retorna NULL
-- em Supabase staging (ALTER DATABASE/ROLE bloqueado pra GUCs custom).
--
-- Causa raiz: concat(NULL, ...) -> net.http_get(NULL, ...) -> OOM.
-- Evidência: cron.job_run_details mostra 100% failed nas últimas 5 execuções.
--
-- Padrão herdado de 20260527_cron_insights_refresh_5min.sql.

DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'cron_transferencias_em_transito_cleanup'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'cron_transferencias_em_transito_cleanup',
  '0 */6 * * *',
  $cron$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/transferencias/cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      timeout_milliseconds := 60000
    );
  $cron$
);

-- Rollback:
--   SELECT cron.unschedule('cron_transferencias_em_transito_cleanup');
--   (e re-aplicar 20260527_cron_transferencias_em_transito_cleanup.sql só pra debug)
```

- [ ] **Step 1.3: Aplicar via Supabase MCP**

Run via `mcp__supabase__apply_migration`:
- `project_id`: `ehbxpbeijofxtsbezwxd`
- `name`: `20260528_cron_transferencias_vault`
- `query`: conteúdo do arquivo

- [ ] **Step 1.4: Validar via run on-demand**

Run via `mcp__supabase__execute_sql`:

```sql
-- Trigger manual via cron.schedule (não esperar 6h)
SELECT cron.schedule_in_database(
  job_name := 'one_shot_test_transferencias',
  schedule := '* * * * *', -- a cada minuto
  command := $cron$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/transferencias/cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1)
      ),
      timeout_milliseconds := 60000
    );
  $cron$,
  database := current_database()
);
```

Espera 90 segundos. Depois:

```sql
SELECT status, return_message, start_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'one_shot_test_transferencias')
ORDER BY start_time DESC LIMIT 1;

SELECT cron.unschedule('one_shot_test_transferencias');
```

Expected: `status='succeeded'`. Se ainda OOM, conferir vault e URL.

Alternativa simples: trigger via shell `curl -H "x-worker-secret: $WORKER_SECRET" https://estoquelever.vercel.app/api/wms/transferencias/cleanup` e confirmar HTTP 200.

- [ ] **Step 1.5: Commit**

```bash
git add supabase/migrations/20260528_cron_transferencias_vault.sql
git commit -m "$(cat <<'EOF'
fix(cron): transferências cleanup usa vault pattern (P0 re-audit #8.1)

Cron quebrava 100% das execuções com Out of memory. Causa raiz:
current_setting('app.base_url', true) retorna NULL em Supabase staging
(GUCs custom bloqueados) → concat(NULL, ...) → net.http_get(NULL).

Padrão idêntico aos 4 crons funcionando (insights, reservas, inventário,
ABC, reconciliação Tiny). Vault secret 'worker_secret' já existe.

Sem vault válido o cron volta a falhar — mantém o fix simétrico aos outros.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 (P0) — Adicionar `guardada_por` na RPC `wms_confirmar_guarda_atomico`

**Why:** Regressão pós-P3. Coluna `guardada_por` existe + backfilled, mas RPC nunca seta no INSERT/UPDATE de runtime. Toda guarda confirmada após 2026-05-27 tem `guardada_por=NULL`. Métricas de produtividade quebradas. Cenário 38 deve estar falhando (sugerido validar antes do fix).

**Files:**
- Create: `supabase/migrations/20260528_p7_guardada_por_no_rpc.sql`
- Reference: `supabase/migrations/20260528_p5_8_pendencia_em_guarda_parcial.sql` (RPC atual)
- Edit: `scripts/wms/cenarios/catalogo/38-criada-por-guarda.ts` (se asserção fraca)

- [ ] **Step 2.1: Verificar se cenário 38 falha hoje (deve falhar)**

```bash
npm run scenarios -- 38
```

Expected: cenário falha em uma asserção `guardada_por != null` OU passa silenciosamente (asserção não existe — caso esperado). Capture o output.

- [ ] **Step 2.2: Ler `scripts/wms/cenarios/catalogo/38-criada-por-guarda.ts`**

Confirmar se já valida `guardada_por`. Se a asserção não existe, adicionar no Step 2.5 abaixo.

- [ ] **Step 2.3: Escrever a migration**

```sql
-- supabase/migrations/20260528_p7_guardada_por_no_rpc.sql
-- P0 (re-audit #5.10 regressão): RPC wms_confirmar_guarda_atomico não setava
-- guardada_por. Coluna existe + backfilled (20260527_pendencias_guarda_*),
-- mas o caminho JS antigo foi substituído pelo RPC plpgsql sem preservar
-- essa escrita.
--
-- Single change: incluir guardada_por no UPDATE final. Em parcial, seta
-- pra p_usuario_id pra rastrear "último operador que tocou"; em total,
-- igual pro mesmo usuário. iniciada_por permanece sendo "quem reivindicou
-- primeiro", então quando há trade-off mid-flow guardada_por != iniciada_por
-- captura a diferença pra métricas.

CREATE OR REPLACE FUNCTION wms_confirmar_guarda_atomico(
  p_pendencia_id uuid,
  p_qty numeric,
  p_localizacao_destino_id uuid,
  p_usuario_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_pend RECORD;
  v_loc_dest RECORD;
  v_repl_result jsonb;
  v_nova_qty_guardada numeric;
  v_totalmente boolean;
  v_novo_status text;
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

  IF v_pend.status = 'guardada' OR v_pend.status = 'cancelada' THEN
    RAISE EXCEPTION 'pendência em status terminal (%)', v_pend.status
      USING ERRCODE = '22023';
  END IF;

  IF p_qty > v_pend.qty_pendente THEN
    RAISE EXCEPTION 'qty (%) excede pendente (%)', p_qty, v_pend.qty_pendente
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

  -- [P7 re-audit #5.10] guardada_por setado também em parcial — rastreio
  -- de "último operador que tocou". Difere de iniciada_por (primeiro a
  -- reivindicar) pra capturar trade-offs mid-flow.
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
$$;

COMMENT ON FUNCTION wms_confirmar_guarda_atomico(uuid,numeric,uuid,uuid) IS
  'P3 #5.3 + #5.8 + P7 re-audit #5.10: confirmar guarda atômico com FOR UPDATE; parcial preserva em_guarda; seta guardada_por.';
```

- [ ] **Step 2.4: Aplicar via Supabase MCP**

Run via `mcp__supabase__apply_migration`:
- `project_id`: `ehbxpbeijofxtsbezwxd`
- `name`: `20260528_p7_guardada_por_no_rpc`
- `query`: conteúdo do arquivo

- [ ] **Step 2.5: Garantir asserção no cenário 38**

Ler `scripts/wms/cenarios/catalogo/38-criada-por-guarda.ts`. Se ainda não tem, adicionar (após a parte que confirma guarda):

```typescript
// Validar P0 re-audit #5.10 — guardada_por preservado após RPC P3
const { data: pend } = await sb
  .from("siso_wms_pendencias_guarda")
  .select("guardada_por, iniciada_por, status")
  .eq("id", pendenciaId)
  .single();

if (!pend?.guardada_por) {
  throw new Error(
    `[#5.10] guardada_por deve ser populado após confirmar; got=${pend?.guardada_por}`,
  );
}
console.log(`✓ guardada_por=${pend.guardada_por} (iniciada_por=${pend.iniciada_por})`);
```

(Adapte o nome da variável `pendenciaId` ao que o cenário usa.)

- [ ] **Step 2.6: Rodar cenário 38 — deve passar agora**

```bash
npm run scenarios -- 38
```

Expected: `PASS` com print `✓ guardada_por=<uuid>...`.

- [ ] **Step 2.7: Commit**

```bash
git add supabase/migrations/20260528_p7_guardada_por_no_rpc.sql scripts/wms/cenarios/catalogo/38-criada-por-guarda.ts
git commit -m "$(cat <<'EOF'
fix(wms/guarda): RPC seta guardada_por no UPDATE final (P0 re-audit #5.10)

Regressão pós-P3: caminho JS antigo setava guardada_por; novo RPC plpgsql
nunca tocou a coluna. Toda guarda confirmada após 2026-05-27 ficou com
guardada_por=NULL, degradando métricas de produtividade.

Em parcial setamos guardada_por = p_usuario_id pra rastrear "último
operador que tocou". Diferença vs iniciada_por captura trade-offs mid-flow.

Cenário 38 ganhou asserção de guardada_por populado.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 (P0) — Vendedor pode cancelar a própria venda

**Why:** Endpoint `/vendas/[id]/cancelar` (criado em P3 #7.13 explicitamente pra auto-serviço do vendedor) está gated por `requireWarehouseAccess` — que **exclui o cargo vendedor**. Persona-alvo segue chamando admin. Original LOW #3 marcado FIXED mas semântica quebrada.

**Files:**
- Modify: `src/lib/wms/auth.ts:88` (adicionar helper)
- Modify: `src/app/api/wms/vendas/[id]/cancelar/route.ts:26` (usar helper)
- Reference: `src/app/api/wms/vendas/[id]/route.ts:48-69` (pattern de ownership)
- Test: `scripts/wms/cenarios/catalogo/59-vendedor-cancela-propria-venda.ts` (novo)

- [ ] **Step 3.1: Adicionar helper em `src/lib/wms/auth.ts`**

Append ao fim do arquivo:

```typescript
import { createServiceClient } from "@/lib/supabase-server";

/**
 * Auth gate composto pra ações no pedido de venda manual:
 *  - PASS se: admin OR qualquer warehouse perm OR vendedor dono do pedido
 *  - FAIL caso contrário (403)
 *
 * "Dono" = vendedor_id == session.id OR vendedor_nome contém session.nome
 * (case-insensitive — pra cobrir auto-atribuição ML/Shopee onde nome é
 * `${ecomNome} ${empresaNome}` sem vendedor_id, ver vendas/[id]/route.ts:62-65).
 *
 * Use em endpoints de mutação do pedido onde o vendedor "puro" precisa
 * agir sobre o próprio pedido (cancelar, editar observação, etc).
 *
 * Pedido_id é validado: 404 se não existe; 400 se não é venda direta.
 */
export async function requireWarehouseAccessOrOwnVenda(
  req: Request,
  pedidoId: string,
): Promise<AuthResult> {
  const user = await getSessionUser(req);
  if (!user) return { ok: false, response: unauthorized() };

  // Fast-path: admin OR warehouse passa sem ler DB
  const hasWarehouse = userCanAny(
    user,
    "operacoes.transferir",
    "operacoes.replenishment",
    "operacoes.devolucoes",
    "operacoes.receber",
    "operacoes.guarda",
    "operacoes.ajuste_manual",
    "inventario.executar",
    "inventario.supervisionar",
    "produtos.editar",
    "localizacoes.editar",
    "fornecedores.editar",
  );
  if (hasWarehouse) return { ok: true, user };

  // Slow-path: vendedor verifica ownership do pedido
  if (!userCan(user, "vendas.criar")) {
    return { ok: false, response: forbidden("requer admin/operador ou vendedor dono") };
  }

  const sb = createServiceClient();
  const { data: pedido, error } = await sb
    .from("siso_pedidos")
    .select("id, vendedor_id, vendedor_nome, origem_pedido, nome_ecommerce")
    .eq("id", pedidoId)
    .maybeSingle();
  if (error || !pedido) {
    return { ok: false, response: NextResponse.json({ error: "pedido não encontrado" }, { status: 404 }) };
  }

  const isVendaDireta =
    pedido.origem_pedido === "manual" ||
    pedido.nome_ecommerce === "Mercado Livre" ||
    pedido.nome_ecommerce === "Shopee";
  if (!isVendaDireta) {
    return { ok: false, response: forbidden("ação restrita a vendas diretas") };
  }

  const ownedById = pedido.vendedor_id === user.id;
  const ownedByName = pedido.vendedor_nome
    ? pedido.vendedor_nome.toLowerCase().includes(user.nome.toLowerCase())
    : false;
  if (!ownedById && !ownedByName) {
    return { ok: false, response: forbidden("não é seu pedido") };
  }

  return { ok: true, user };
}
```

- [ ] **Step 3.2: Trocar gate em `vendas/[id]/cancelar/route.ts`**

Edit `src/app/api/wms/vendas/[id]/cancelar/route.ts` linhas 1-2 e 26:

old_string:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
```

new_string:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccessOrOwnVenda } from "@/lib/wms/auth";
```

old_string (linha 26):
```typescript
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
```

new_string:
```typescript
  const { id } = await ctx.params;
  const auth = await requireWarehouseAccessOrOwnVenda(req, id);
  if (!auth.ok) return auth.response;
```

(Nota: a ordem trocou pra resolver `id` antes — o helper precisa do `pedidoId`.)

- [ ] **Step 3.3: Escrever cenário 59 cobrindo o caso vendedor self-cancel**

Create `scripts/wms/cenarios/catalogo/59-vendedor-cancela-propria-venda.ts`:

```typescript
import type { CenarioContext } from "../runner";
import { invariantes } from "../invariantes";

/**
 * P0 re-audit #7.NEW1 — vendedor consegue cancelar a própria venda manual.
 *
 * Setup:
 *   - cria user vendedor V (role vendedor)
 *   - V cria venda manual modo separacao
 *   - V cancela a própria venda → 200 OK
 *   - tentar com OUTRO vendedor W → 403
 *   - admin sempre passa
 */
export const cenario = {
  id: 59,
  nome: "vendedor cancela própria venda",
  async run(ctx: CenarioContext) {
    const { fetchAs, sb, log } = ctx;

    // 1. Cria 2 vendedores via test harness
    const vend1 = await ctx.seedUser({ nome: "Vend1Test", roles: ["vendedor"] });
    const vend2 = await ctx.seedUser({ nome: "Vend2Test", roles: ["vendedor"] });
    const admin = await ctx.seedUser({ nome: "AdminTest59", roles: ["admin"] });

    // 2. Pega produto/empresa/galpão de teste
    const seed = await ctx.seedProdutoBasico({ sku: "TEST-59", saldo: 5 });

    // 3. Vend1 cria venda modo separacao
    const criar = await fetchAs(vend1, "/api/wms/vendas/criar", {
      method: "POST",
      body: {
        empresa_origem_id: seed.empresaId,
        galpao_id: seed.galpaoId,
        cliente_nome: "Cliente Test 59",
        modo: "separacao",
        items: [{ produto_id: seed.produtoUuid, quantidade: 1 }],
      },
    });
    if (criar.status !== 201) throw new Error(`expected 201, got ${criar.status} ${JSON.stringify(criar.body)}`);
    const pedidoId = criar.body.pedido_id as string;
    log(`✓ venda criada: ${pedidoId}`);

    // 4. Vend2 (outro vendedor) tenta cancelar → 403
    const wrongCancel = await fetchAs(vend2, `/api/wms/vendas/${pedidoId}/cancelar`, {
      method: "POST",
      body: { motivo: "tentativa indevida" },
    });
    if (wrongCancel.status !== 403) {
      throw new Error(`vend2 deveria receber 403, got ${wrongCancel.status}`);
    }
    log(`✓ vend2 bloqueado com 403`);

    // 5. Vend1 (dono) cancela → 200
    const ownCancel = await fetchAs(vend1, `/api/wms/vendas/${pedidoId}/cancelar`, {
      method: "POST",
      body: { motivo: "errei o cliente" },
    });
    if (ownCancel.status !== 200) {
      throw new Error(`vend1 deveria receber 200, got ${ownCancel.status} ${JSON.stringify(ownCancel.body)}`);
    }
    log(`✓ vend1 (dono) cancelou: ${JSON.stringify(ownCancel.body)}`);

    // 6. Validar status persistido
    const { data: pedido } = await sb
      .from("siso_pedidos")
      .select("status")
      .eq("id", pedidoId)
      .single();
    if (pedido?.status !== "cancelado") {
      throw new Error(`status esperado=cancelado, got=${pedido?.status}`);
    }
    log(`✓ status=cancelado`);

    // 7. Invariantes globais
    await invariantes.todasGlobais(ctx);
  },
};
```

> **Nota:** Se `ctx.seedUser` não existir no harness atual (foi deferred em Fix-Final D #54-58), simplifique pra: pular o cenário com mensagem `SKIP (precisa seedUser no harness — Fase 7)`. Não bloqueie o fix pela limitação de teste.

- [ ] **Step 3.4: Rodar cenário 59**

```bash
npm run scenarios -- 59
```

Expected: PASS, ou SKIP com mensagem clara se `seedUser` ausente.

- [ ] **Step 3.5: Smoke manual em staging**

Login com vendedor real (ex: existing seed `Eryk` se for admin, criar um vendedor temporário via `/wms/configuracoes/usuarios`). Criar venda → cancelar. Confirmar 200. Logout e tentar como outro user sem perms → 403.

- [ ] **Step 3.6: Commit**

```bash
git add src/lib/wms/auth.ts src/app/api/wms/vendas/\[id\]/cancelar/route.ts scripts/wms/cenarios/catalogo/59-vendedor-cancela-propria-venda.ts
git commit -m "$(cat <<'EOF'
fix(wms/vendas): vendedor pode cancelar a própria venda (P0 re-audit #7.NEW1)

Endpoint /cancelar (criado em P3 #7.13 pra auto-serviço do vendedor)
estava gated por requireWarehouseAccess, que exclui o cargo vendedor —
persona-alvo continuava ligando pro admin.

Novo helper requireWarehouseAccessOrOwnVenda compõe admin/operador OR
ownership (vendedor_id == session.id OR vendedor_nome contém session.nome,
case-insensitive — mesmo padrão de vendas/[id]/route.ts:54-69).

Cenário 59 cobre o cenário cross-vendedor (403) + self-cancel (200).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 (P1) — Rename frontend `vendedor_id_override` → `vendedor_id_alvo`

**Why:** Backend `vendas/criar` lê `vendedor_id_alvo` (commit `89577b5`). Frontend `nova/page.tsx` envia `vendedor_id_override`. Feature "criar em nome de X" silenciosamente dead code: pedido sempre fica com `vendedor_id=user.id`. Permissão `vendas.criar_em_nome_de` vira teatro de RBAC.

**Files:**
- Modify: `src/app/wms/vendas/nova/page.tsx` (3 ocorrências nas linhas 125, 171, 188, 326, 345 — todas o local var/state)
- Reference: `src/app/api/wms/vendas/criar/route.ts:92` (canonical name)
- Reference: `src/types/index.ts:147` (CriarVendaDiretaRequest define vendedor_id_alvo)

- [ ] **Step 4.1: Renomear `vendedorIdOverride` → `vendedorIdAlvo` no arquivo todo**

Edit `src/app/wms/vendas/nova/page.tsx`. Como há múltiplas ocorrências, usar `replace_all`:

old_string: `vendedorIdOverride`
new_string: `vendedorIdAlvo`
replace_all: true

old_string: `setVendedorIdOverride`
new_string: `setVendedorIdAlvo`
replace_all: true

old_string: `vendedor_id_override`
new_string: `vendedor_id_alvo`
replace_all: true

- [ ] **Step 4.2: Verificar tipo `CriarVendaDiretaRequest` em `src/types/index.ts`**

```bash
grep -n "vendedor_id_alvo\|vendedor_id_override" /Users/eryk/Documents/ESTOQUE/src/types/index.ts
```

Expected: só `vendedor_id_alvo`. Se houver type intersection `& { vendedor_id_override?: string }` no `nova/page.tsx`, removê-lo.

```bash
grep -n "vendedor_id_override\|vendedorIdOverride" /Users/eryk/Documents/ESTOQUE/src/
```

Expected: zero matches após o rename. Se algum persistir (talvez em comentário), revisar caso-a-caso.

- [ ] **Step 4.3: Type check**

```bash
npx tsc --noEmit
```

Expected: zero errors relacionados a `vendedor_id_*`. Se aparecer erro de prop type, ajustar a definição da page (provavelmente o `& { vendedor_id_override?: string }` que precisa virar `& { vendedor_id_alvo?: string }` ou ser removido se já está no tipo base).

- [ ] **Step 4.4: Smoke manual em staging**

1. Login como admin
2. `/wms/vendas/nova` → confirmar dropdown "Em nome de" aparece (perm `vendas.criar_em_nome_de` no admin)
3. Selecionar outro vendedor V no dropdown
4. Submit venda
5. Abrir `/wms/vendas` → confirmar venda aparece com `vendedor_nome = V.nome`
6. Confirmar no DB: `SELECT vendedor_id FROM siso_pedidos WHERE id = '<pedidoId>'` → deve ser V.id, não admin.id

- [ ] **Step 4.5: Commit**

```bash
git add src/app/wms/vendas/nova/page.tsx
git commit -m "$(cat <<'EOF'
fix(wms/vendas/nova): payload usa vendedor_id_alvo (P1 re-audit #7.NEW2)

Backend consumes vendedor_id_alvo desde commit 89577b5. Frontend enviava
vendedor_id_override — backend ignorava e gravava vendedor_id=user.id.
Feature "criar em nome de outro vendedor" era dead code silencioso.

Rename de 3 ocorrências (state, payload, type). Smoke validado em staging:
admin cria venda em nome de V → pedido fica com vendedor_id=V.id.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 (P1) — Patch 8 RPCs insights para schema 3D

**Why:** P1 só endereçou 4 das 12 RPCs (hub_kpis + 3 estoque). 8 RPCs componentes (`funil_etapas`, `lead_time_percentis`, `throughput_diario/hora`, `ranking_operadores`, `fluxo_aging_outlier/lead_time_p90/ritmo_baixo`) ainda fazem `JOIN siso_empresas e ON e.id = p.empresa_origem_id` + `WHERE e.galpao_id = p_galpao_id`. Quando o usuário filtra por galpão em `/wms/insights/fluxo`, `/pessoas`, `/financeiro`, números vêm errados (filtram pelo primeiro preferencial da empresa, não pelo galpão real do pedido).

**Files:**
- Create: `supabase/migrations/20260528_insights_rpcs_3d_patch_v2.sql`
- Reference: `supabase/migrations/20260527_insights_rpcs_3d_patch.sql` (pattern P1 usado em 4 RPCs)
- Reference: `supabase/migrations/20260514_wms_insights_motor.sql` + `20260515_wms_insights_rpcs.sql` (definições originais legadas pra base)

- [ ] **Step 5.1: Capturar definições atuais das 8 RPCs**

Run via `mcp__supabase__execute_sql`:

```sql
SELECT
  p.proname,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'wms_insights_funil_etapas',
    'wms_insights_lead_time_percentis',
    'wms_insights_throughput_diario',
    'wms_insights_throughput_hora',
    'wms_insights_ranking_operadores',
    'wms_insight_fluxo_aging_outlier',
    'wms_insight_fluxo_lead_time_p90',
    'wms_insight_fluxo_ritmo_baixo'
  )
ORDER BY p.proname;
```

Salvar output mentalmente / em scratchpad. Cada definição é o ponto de partida — modificar **só** o JOIN+WHERE de empresa→galpão.

- [ ] **Step 5.2: Escrever a migration (transformação canônica)**

A transformação é mecânica:

**Antes (padrão das 8 quebradas):**
```sql
FROM siso_pedidos p
JOIN siso_empresas e ON e.id = p.empresa_origem_id
WHERE ...
  AND e.galpao_id = p_galpao_id  -- ou: WHERE p_galpao_id IS NULL OR e.galpao_id = p_galpao_id
...
SELECT ..., e.galpao_id, ...
```

**Depois (padrão 3D):**
```sql
FROM siso_pedidos p
WHERE ...
  AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
...
SELECT ..., p.separacao_galpao_id, ...  -- ou COALESCE(p.separacao_galpao_id, NULL) se RPC retorna galpao_id
```

Crie `supabase/migrations/20260528_insights_rpcs_3d_patch_v2.sql`:

```sql
-- Migration: insights RPCs 3D patch v2
-- Date: 2026-05-28
-- Plan: 2026-05-28-wms-reaudit-fixes (Task 5, P1 re-audit cross-module #2)
-- Finding: P1 patch só cobriu 4 RPCs; ainda 8 referenciam siso_empresas.galpao_id
--
-- Transformação canônica (mesma de 20260527_insights_rpcs_3d_patch.sql):
--   - DROP JOIN siso_empresas e ON e.id = p.empresa_origem_id
--   - WHERE/SELECT trocam e.galpao_id por p.separacao_galpao_id
--   - Filter "todos os galpões" quando p_galpao_id IS NULL
--
-- Background: empresa deixou de ser coordenada física em 2026-05-20
-- (ledger 3D). siso_empresas.galpao_id ficou nullable como espelho do
-- primeiro preferencial — usar isso pra filtrar dá resultado errado
-- (esconde pedidos do galpão B se empresa origem tem A como primeiro).
-- siso_pedidos.separacao_galpao_id é o source-of-truth real.

-- ─── 1. wms_insights_funil_etapas ────────────────────────────────────────
CREATE OR REPLACE FUNCTION wms_insights_funil_etapas(
  p_galpao_id uuid DEFAULT NULL,
  p_dias int DEFAULT 30
)
RETURNS TABLE (
  etapa text,
  qty bigint,
  pct_para_prox numeric
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT p.id, p.status_separacao
    FROM siso_pedidos p
    WHERE p.criado_em >= now() - (p_dias || ' days')::interval
      AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
  ),
  contagem AS (
    SELECT
      COUNT(*) FILTER (WHERE status_separacao IN ('aguardando_compra','aguardando_nf','aguardando_separacao')) AS pendentes,
      COUNT(*) FILTER (WHERE status_separacao IN ('em_separacao','separado')) AS em_picking,
      COUNT(*) FILTER (WHERE status_separacao = 'embalado') AS embalados,
      COUNT(*) FILTER (WHERE status_separacao = 'expedido') AS expedidos
    FROM base
  )
  SELECT 'pendente'::text, c.pendentes, NULL::numeric FROM contagem c
  UNION ALL
  SELECT 'em_picking', c.em_picking, CASE WHEN c.pendentes>0 THEN ROUND(100.0*c.em_picking/c.pendentes,1) ELSE NULL END FROM contagem c
  UNION ALL
  SELECT 'embalado', c.embalados, CASE WHEN c.em_picking>0 THEN ROUND(100.0*c.embalados/c.em_picking,1) ELSE NULL END FROM contagem c
  UNION ALL
  SELECT 'expedido', c.expedidos, CASE WHEN c.embalados>0 THEN ROUND(100.0*c.expedidos/c.embalados,1) ELSE NULL END FROM contagem c;
END;
$$;

-- ─── 2. wms_insights_lead_time_percentis ─────────────────────────────────
-- NOTA: antes de reescrever, capturar definição atual via Step 5.1.
-- Aplicar transformação canônica: trocar `siso_empresas e` por sem JOIN
-- e usar `p.separacao_galpao_id` no filtro/SELECT.
-- [Engenheiro: copiar a definição capturada, fazer os 3 replaces, e colar aqui.]
-- ... (continuar pra todas as 8)

-- ─── 3. wms_insights_throughput_diario ──────────────────────────────────
-- [Mesma transformação]

-- ─── 4. wms_insights_throughput_hora ────────────────────────────────────
-- [Mesma transformação]

-- ─── 5. wms_insights_ranking_operadores ─────────────────────────────────
-- [Mesma transformação]

-- ─── 6. wms_insight_fluxo_aging_outlier ─────────────────────────────────
-- Definição atual capturada (Step 5.1):
--   FROM siso_pedidos p
--   JOIN siso_empresas e ON e.id = p.empresa_origem_id
--   WHERE p.status_separacao = 'em_separacao' AND p.separacao_iniciada_em < now() - ...
--   SELECT ..., e.galpao_id, ...
--
-- Pós-fix:
CREATE OR REPLACE FUNCTION wms_insight_fluxo_aging_outlier(
  p_threshold jsonb DEFAULT '{}'::jsonb
)
RETURNS SETOF wms_insight_resultado
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_min_min int := COALESCE((p_threshold->>'min_minutos')::int, 120);
BEGIN
  RETURN QUERY
  SELECT
    'pedido'::text, p.id::text,
    'Pedido em separação há muito tempo',
    'Pedido #' || p.id || ' está em separação há ' ||
      ROUND(EXTRACT(EPOCH FROM (now() - p.separacao_iniciada_em))/60)::text || ' min.',
    jsonb_build_object(
      'minutos', ROUND(EXTRACT(EPOCH FROM (now() - p.separacao_iniciada_em))/60),
      'operador_id', p.separacao_operador_id
    ),
    p.separacao_galpao_id,  -- [P1-v2 #2] era e.galpao_id
    '/wms/separacao'
  FROM siso_pedidos p
  WHERE p.status_separacao = 'em_separacao'
    AND p.separacao_iniciada_em IS NOT NULL
    AND p.separacao_iniciada_em < now() - (v_min_min || ' minutes')::interval;
END;
$$;

-- ─── 7. wms_insight_fluxo_lead_time_p90 ─────────────────────────────────
-- [Capturar e reescrever]

-- ─── 8. wms_insight_fluxo_ritmo_baixo ───────────────────────────────────
-- [Capturar e reescrever]
```

> **Decisão de implementação:** Como cada RPC tem corpo único, o engenheiro precisa **capturar a definição via Step 5.1** e reescrever cada uma com a transformação canônica acima. Não copiar-colar de memória — usar `pg_get_functiondef` como source-of-truth. O exemplo de `wms_insight_fluxo_aging_outlier` está completo acima como template.

- [ ] **Step 5.3: Aplicar via Supabase MCP**

Run via `mcp__supabase__apply_migration`:
- `project_id`: `ehbxpbeijofxtsbezwxd`
- `name`: `20260528_insights_rpcs_3d_patch_v2`
- `query`: conteúdo do arquivo (com as 8 RPCs reescritas)

- [ ] **Step 5.4: Validar via query — nenhuma RPC pode mais ter `e.galpao_id`**

Run via `mcp__supabase__execute_sql`:

```sql
SELECT
  p.proname,
  CASE
    WHEN pg_get_functiondef(p.oid) ILIKE '%e.galpao_id%' THEN 'STILL_DEPRECATED'
    WHEN pg_get_functiondef(p.oid) ILIKE '%siso_empresas e %' THEN 'STILL_REFERENCES_EMPRESAS'
    ELSE 'OK_3D'
  END AS schema_state
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname LIKE 'wms_insight%'
ORDER BY p.proname;
```

Expected: TODAS as 12 RPCs aparecem como `OK_3D`. Nenhuma `STILL_DEPRECATED`/`STILL_REFERENCES_EMPRESAS`.

- [ ] **Step 5.5: Smoke em staging**

1. Login admin
2. `/wms/insights/fluxo` sem filtro de galpão — confirmar números coerentes
3. Filtrar por CWB — números devem **mudar** (não eram afetados antes do patch, agora são)
4. Filtrar por SP — números diferentes de CWB

Comparar contra contagem manual:

```sql
SELECT separacao_galpao_id, status_separacao, COUNT(*)
FROM siso_pedidos
WHERE criado_em >= now() - interval '30 days'
GROUP BY 1, 2;
```

- [ ] **Step 5.6: Commit**

```bash
git add supabase/migrations/20260528_insights_rpcs_3d_patch_v2.sql
git commit -m "$(cat <<'EOF'
fix(insights): 8 RPCs componentes para schema 3D (P1 re-audit cross-module #2)

P1 patch (20260527) só cobriu 4 das 12 RPCs insights. Funil_etapas,
lead_time_percentis, throughput_diario/hora, ranking_operadores e
fluxo_aging_outlier/lead_time_p90/ritmo_baixo seguiam fazendo JOIN
siso_empresas + filter por e.galpao_id (deprecated desde 2026-05-20).

Drill-down de insights por galpão filtrava pelo primeiro preferencial
da empresa, não pelo galpão real do pedido. P1-v2 substitui pelo
JOIN-livre direto em siso_pedidos.separacao_galpao_id.

Validado: query pg_proc retorna OK_3D pras 12 RPCs insights.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 (P1) — Equivalente perde estoque dinâmico: CWB/SP hardcoded por nome

**Why:** `confirmar/route.ts:110-202` lê `estoques["CWB"]` / `estoques["SP"]` (hardcoded por nome de galpão) e escreve em 10 colunas hardcoded `estoque_cwb_*` / `estoque_sp_*`. Quebra suporte a 3º galpão. Fix-D T10 já removeu `cwb_atende/sp_atende` no MESMO arquivo (commit `31b6aab`) mas não tocou nessas colunas — inconsistência interna.

**Files:**
- Modify: `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts:108-204`
- Reference: `src/app/api/wms/tiny/stock/ajustar/route.ts:169` (idem fix Fix-D T10 — pode estar duplicando padrão)

- [ ] **Step 6.1: Ler o arquivo todo pra entender contexto**

```bash
wc -l /Users/eryk/Documents/ESTOQUE/src/app/api/wms/compras/itens/\[itemId\]/equivalente/confirmar/route.ts
```

Ler integralmente. Identificar:
- Onde `estoques["CWB"]` e `["SP"]` são lidos
- Quem consome as 10 colunas escritas (grep no codebase)
- Se há outro caller que depende dos nomes

```bash
grep -rn "estoque_cwb_saldo\|estoque_sp_saldo\|estoque_cwb_deposito\|estoque_sp_deposito" /Users/eryk/Documents/ESTOQUE/src/ 2>/dev/null
```

- [ ] **Step 6.2: Decidir entre 2 estratégias**

Baseado no que o grep revelar:

**Estratégia A (preferida):** Se as 10 colunas só são lidas pelos próprios componentes legacy (já marcados deprecated), **abandoná-las** (não escrever mais), seguindo a mesma decisão do Fix-D T10. Isto requer confirmar que o frontend `/wms/compras` lê de `siso_pedido_item_estoques` (tabela normalizada), não dessas colunas. Se sim, basta deletar o bloco `update` que escreve nelas.

**Estratégia B (defensiva):** Manter escrita mas dinamicamente. Iterar sobre todos os galpões de `equivalente.estoques`, escrever numa nova coluna JSONB `equivalente_estoques jsonb` em vez das 10 colunas. Exige migration adicionando coluna + drop das 10. Pesado pra fix incremental.

**Recomendação do plano:** Estratégia A se grep mostrar zero leitores ativos das 10 colunas. Senão, abrir issue separada pra migração da estrutura — não tentar em PR de fix.

- [ ] **Step 6.3: Aplicar Estratégia A (assumindo zero leitores)**

Read `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts` linhas 100-210 pra ver bloco completo.

Edit removendo as linhas 110-111 (read CWB/SP) e 193-202 (write 10 colunas). Substituir por comentário:

old_string (ajustar conforme arquivo real):
```typescript
    const estoqueCwb = equivalente.estoques["CWB"] ?? null;
    const estoqueSp = equivalente.estoques["SP"] ?? null;
```

new_string:
```typescript
    // [re-audit #3.BROKEN] estoque dinâmico por galpão vem de
    // siso_pedido_item_estoques (tabela normalizada). Colunas legacy
    // estoque_cwb_* / estoque_sp_* foram zero-readers — removidas no
    // mesmo PR do Fix-D T10 (cwb_atende/sp_atende).
```

E remover as linhas 193-202 do bloco update.

- [ ] **Step 6.4: Type check + build**

```bash
npx tsc --noEmit
npm run build
```

Expected: zero errors. Se algo ainda referencia as 10 colunas downstream, voltar pra Estratégia B (com issue separada).

- [ ] **Step 6.5: Rodar cenário de compras**

```bash
npm run scenarios -- 03   # OC completo
npm run scenarios -- 23   # comprar cria OC
```

Expected: ambos PASS. Equivalente não está nesses cenários, mas validamos que removemos sem regressão.

- [ ] **Step 6.6: Smoke manual em staging**

1. Criar pedido OC com SKU que tem equivalente (precisa Cross configurado)
2. `/wms/compras` → tab Comprar
3. Clicar "Equivalente" → escolher SKU equivalente → confirmar
4. Confirmar 200 OK, item troca SKU, telemetria normal

- [ ] **Step 6.7: Commit**

```bash
git add src/app/api/wms/compras/itens/\[itemId\]/equivalente/confirmar/route.ts
git commit -m "$(cat <<'EOF'
fix(compras/equivalente): remove escrita CWB/SP hardcoded (P1 re-audit #3.BROKEN)

Endpoint lia estoques["CWB"]/["SP"] e escrevia em 10 colunas hardcoded
estoque_cwb_*/estoque_sp_*. Quebrava 3º galpão e era inconsistente
com Fix-D T10 que removeu cwb_atende/sp_atende no MESMO arquivo.

Estratégia A: zero leitores ativos das 10 colunas (grep confirmou) —
abandona escrita, mesma decisão do Fix-D T10. Estoque dinâmico segue
disponível via siso_pedido_item_estoques (normalizado).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 (P2) — Desclassificar devolução exige perm granular

**Why:** Quando P4 introduziu `operacoes.devolucoes_classificar` pra granular write em classificar, o symmetric `desclassificar` foi missed. Qualquer sessão com QUALQUER warehouse perm (ex: operador-receber) pode reverter classificação. Quebra simetria de RBAC.

**Files:**
- Modify: `src/app/api/wms/devolucoes/[id]/desclassificar/route.ts:2,21`

- [ ] **Step 7.1: Ler arquivo atual**

```bash
cat /Users/eryk/Documents/ESTOQUE/src/app/api/wms/devolucoes/\[id\]/desclassificar/route.ts
```

Identificar imports (linha 2) e o gate (linha 21).

- [ ] **Step 7.2: Trocar gate por granular**

Edit `src/app/api/wms/devolucoes/[id]/desclassificar/route.ts`:

old_string:
```typescript
import { requireWarehouseAccess } from "@/lib/wms/auth";
```

new_string:
```typescript
import { requireAuth } from "@/lib/wms/auth";
import { userCan } from "@/lib/permissions";
```

Para a linha 21 (substituir o gate; ajustar o name da const conforme o arquivo):

old_string:
```typescript
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
```

new_string:
```typescript
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  if (!userCan(auth.user, "operacoes.devolucoes_classificar")) {
    return NextResponse.json(
      { error: "requer permissão operacoes.devolucoes_classificar" },
      { status: 403 },
    );
  }
```

(Se `NextResponse` já não estiver importado, adicionar no import do `next/server`.)

- [ ] **Step 7.3: Type check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 7.4: Smoke manual**

1. Login com cargo operador (não admin)
2. `/wms/devolucoes` → toggle "Ver classificadas"
3. Tentar desclassificar uma — confirmar comportamento esperado (depende de qual permissão o operador tem)
4. Login admin → desclassificar funciona

- [ ] **Step 7.5: Commit**

```bash
git add src/app/api/wms/devolucoes/\[id\]/desclassificar/route.ts
git commit -m "$(cat <<'EOF'
fix(devolucoes/desclassificar): exige operacoes.devolucoes_classificar (P2 re-audit #6.NEW2)

Quando P4 introduziu perm granular pra classificar, symmetric write
desclassificar foi missed — seguia gated por requireWarehouseAccess
(umbrella). Qualquer sessão com qualquer warehouse perm podia reverter
classificação.

Simetria restaurada: ambos (classificar + desclassificar) agora exigem
operacoes.devolucoes_classificar.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8 (P2) — Porta `system-marketplace` vendedor pra `webhook-processor-wms.ts`

**Why:** `WMS_AS_SOURCE=true` é o default desde 2026-05-25, então `webhook-processor-wms.ts` é o caminho **ativo** em prod. Esse caminho NÃO faz lookup do user sintético `system-marketplace` — `vendedor_id` fica NULL pra todo pedido ML/Shopee. Reports "vendas por vendedor" perdem marketplace. Fix legacy em `webhook-processor.ts:371-384` precisa ser portado.

**Files:**
- Modify: `src/lib/webhook-processor-wms.ts:478-485` (área que decide vendedorIdFinal)
- Reference: `src/lib/webhook-processor.ts:371-390` (versão legada já correta)

- [ ] **Step 8.1: Ler bloco no legacy pra capturar pattern**

```bash
sed -n '360,395p' /Users/eryk/Documents/ESTOQUE/src/lib/webhook-processor.ts
```

Esperado: bloco que (a) lê pedido existente preservando manual, (b) faz lookup `siso_usuarios WHERE nome='system-marketplace'` se ML/Shopee, (c) usa `?? sysUser?.id ?? null` na cadeia de fallback.

- [ ] **Step 8.2: Ler bloco atual no WMS-first**

```bash
sed -n '460,520p' /Users/eryk/Documents/ESTOQUE/src/lib/webhook-processor-wms.ts
```

Identificar onde `vendedorIdFinal` e `vendedorNomeFinal` são computados.

- [ ] **Step 8.3: Patch — adicionar lookup system-marketplace antes do vendedorIdFinal**

Edit. O padrão exato depende do código atual. Estrutura conceitual:

old_string:
```typescript
  const { data: pedidoPrev } = await sb
    .from("siso_pedidos")
    .select("vendedor_id, vendedor_nome")
    .eq("id", pedidoId)
    .maybeSingle();

  const vendedorIdFinal = pedidoPrev?.vendedor_id ?? null;
  const vendedorNomeFinal =
    pedidoPrev?.vendedor_id != null ? pedidoPrev.vendedor_nome : vendedorNomeAuto;
```

new_string:
```typescript
  const { data: pedidoPrev } = await sb
    .from("siso_pedidos")
    .select("vendedor_id, vendedor_nome")
    .eq("id", pedidoId)
    .maybeSingle();

  // [re-audit #7.M2 PARTIAL] auto-atribui pedidos ML/Shopee ao user sintético
  // system-marketplace (criado em migration 20260527_user_system_marketplace).
  // Preserva manual: se pedido já tem vendedor_id setado, não sobrescreve.
  // Espelha bloco 8d de webhook-processor.ts:371-384 (legacy path).
  let vendedorIdAuto: string | null = null;
  if (vendedorNomeAuto && !pedidoPrev?.vendedor_id) {
    const { data: sysUser } = await sb
      .from("siso_usuarios")
      .select("id")
      .eq("nome", "system-marketplace")
      .maybeSingle();
    vendedorIdAuto = sysUser?.id ?? null;
  }

  const vendedorIdFinal = pedidoPrev?.vendedor_id ?? vendedorIdAuto;
  const vendedorNomeFinal =
    pedidoPrev?.vendedor_id != null ? pedidoPrev.vendedor_nome : vendedorNomeAuto;
```

> **Verificar:** a variável `vendedorNomeAuto` precisa existir no scope (deve já estar lá — é o que dispara o lookup só pra marketplace). Se o nome for diferente no arquivo, ajustar.

- [ ] **Step 8.4: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 8.5: Smoke em staging**

Estratégia: criar pedido ML simulado via cenário existente, depois SQL pra verificar.

```bash
npm run scenarios -- 01  # pedido auto propria (simula webhook)
```

Confirmar via:

```sql
SELECT id, vendedor_id, vendedor_nome, nome_ecommerce
FROM siso_pedidos
WHERE nome_ecommerce IN ('Mercado Livre','Shopee')
ORDER BY criado_em DESC LIMIT 5;
```

Expected: novos pedidos ML têm `vendedor_id != NULL` (uuid do `system-marketplace`).

- [ ] **Step 8.6: Commit**

```bash
git add src/lib/webhook-processor-wms.ts
git commit -m "$(cat <<'EOF'
fix(webhook-wms): system-marketplace user no caminho ativo (P2 re-audit #7.M2)

webhook-processor.ts (legacy) já fazia lookup do user sintético, mas
WMS_AS_SOURCE=true é default desde 2026-05-25 — caminho ativo era o
webhook-processor-wms.ts onde vendedor_id ML/Shopee ficava NULL.

Reports "pedidos por vendedor" voltam a capturar marketplace. Bloco 8d
do legacy portado mantendo idempotência (preserva manual).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9 (P3) — `listarDevolucoesClassificadas` alias errado

**Why:** Helper usa alias `empresa_referencia` enquanto `listarDevolucoesPendentes` usa `empresa_receptora`. Frontend renderiza coluna `empresa_receptora` (esperando o segundo nome), mostra `—` em todas as rows da aba "Ver classificadas". 1 linha de fix.

**Files:**
- Modify: `src/lib/wms/devolucoes.ts:510`

- [ ] **Step 9.1: Edit**

old_string:
```typescript
    .select("*, empresa_referencia:siso_empresas!empresa_id(nome)")
```

new_string:
```typescript
    .select("*, empresa_receptora:siso_empresas!empresa_id(nome)")
```

- [ ] **Step 9.2: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 9.3: Smoke**

`/wms/devolucoes` → toggle "Ver classificadas" → confirmar coluna "Empresa receptora" populada nas rows.

- [ ] **Step 9.4: Commit**

```bash
git add src/lib/wms/devolucoes.ts
git commit -m "$(cat <<'EOF'
fix(devolucoes): alias empresa_receptora no helper classificadas (P3 re-audit #6.NEW1)

listarDevolucoesClassificadas usava alias empresa_referencia enquanto
listarDevolucoesPendentes (e frontend) usa empresa_receptora. UI mostrava
coluna empty em todas as rows da aba "Ver classificadas".

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10 (P3) — Descomenta botão Banner D10 Estornar

**Why:** Endpoint `/api/wms/pedidos/[id]/estornar` já existe (Fix-Final A T23). Plumbing/mutation já wired. Só o `<button>` JSX está em comentário com TODO stale apontando pra endpoint que já existe. 5 min de fix.

**Files:**
- Modify: `src/app/wms/pedidos/[id]/page.tsx:671-685`

- [ ] **Step 10.1: Edit**

old_string:
```typescript
      {/* TODO(P5+P3): wire quando P3 entregar /api/wms/pedidos/[id]/estornar-cancelado.
          Por ora, banner mostra apenas a mensagem — sem botão pra não dar false promise. */}
      {/* {isAdmin && (
        <button
          className="wms-btn wms-btn-danger"
          onClick={onEstornar}
          style={{ flexShrink: 0 }}
        >
          <Icon name="rotate" size={12} />
          Estornar agora
        </button>
      )} */}
```

new_string:
```typescript
      {isAdmin && (
        <button
          className="wms-btn wms-btn-danger"
          onClick={onEstornar}
          style={{ flexShrink: 0 }}
        >
          <Icon name="rotate" size={12} />
          Estornar agora
        </button>
      )}
```

- [ ] **Step 10.2: Procurar e remover `void isAdmin; void onEstornar;`**

Esses statements suprimiam warnings de unused vars enquanto o botão estava commented:

```bash
grep -n "void isAdmin\|void onEstornar" /Users/eryk/Documents/ESTOQUE/src/app/wms/pedidos/\[id\]/page.tsx
```

Se encontrados na função `BannerEstornoManual`, removê-los (Edit individual).

- [ ] **Step 10.3: Build**

```bash
npm run build
```

Expected: zero warnings sobre `isAdmin`/`onEstornar` unused, zero TS errors.

- [ ] **Step 10.4: Smoke em staging**

1. Login admin
2. Abrir pedido em status `cancelado` que tem mov posterior ao cancelamento (D10 condition)
3. Confirmar banner aparece
4. Confirmar botão "Estornar agora" visível
5. Clicar → confirmar 200 e movs estornadas

- [ ] **Step 10.5: Commit**

```bash
git add src/app/wms/pedidos/\[id\]/page.tsx
git commit -m "$(cat <<'EOF'
fix(pedidos): descomenta botão Estornar do Banner D10 (P3 re-audit #1.NEW2)

Endpoint /estornar foi entregue no Fix-Final A T23 (commit 1ac4a9f).
Mutation/onEstornar já estavam wired. Só o JSX do botão seguia em
comentário com TODO stale.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11 — Regressão check: rodar suite completa de cenários

**Why:** Validar que nenhum dos 10 fixes introduziu regressão nos 53 cenários existentes.

- [ ] **Step 11.1: Rodar suite completa**

```bash
npm run scenarios
```

Expected: TODOS os cenários passam. Se algum falhar, classificar:
- **(a) Pré-existente flake** (suite tem instabilidade documentada em Fix-A/B): re-rodar 2x, se passar é flake
- **(b) Regressão real**: identificar qual task introduziu, voltar e fixar

- [ ] **Step 11.2: Atualizar CLAUDE.md com summary do PR**

Append à seção "In Progress / Minor" do CLAUDE.md. Read primeiro pra ver pattern dos summaries de Fix-Final A/B/C/D.

Bloco a adicionar (após o último de Fix-Final D, ajustar caminhos conforme arquivo):

```markdown
- **WMS Re-audit Fixes (2026-05-28).** Fecha os 10 findings residuais
  (P0-P3) confirmados pela re-auditoria 2026-05-28
  (`docs/audit-workflows/reaudit-2026-05-28/`). 3 migrações + 7 patches
  de código. Highlights: cron transferências volta a rodar (vault pattern,
  era OOM 100%); guardada_por preservado nas confirmações (regressão pós-P3
  fechada); vendedor cancela própria venda (helper
  requireWarehouseAccessOrOwnVenda); 8 RPCs insights migradas pra schema
  3D (P1 só cobriu 4); 4 fixes de UI/lib triviais (rename vendedor_id_alvo,
  alias devolucoes, botão Banner D10, system-marketplace no caminho ativo).
  Plano: `docs/superpowers/plans/2026-05-28-wms-reaudit-fixes.md`.
  Out of scope (deferred): P4 (LocalizacaoCombo + auto-release lock), P5
  (idempotency rollback + drop siso_pedido_item_estoques).
```

- [ ] **Step 11.3: Append em `erros-conhecidos.yaml` por finding fixado**

Pra cada uma das 10 tasks, adicionar entrada (id sequencial, conforme convenção do arquivo). Exemplo pra a primeira:

```yaml
- id: 145
  date: 2026-05-28
  source: cron_transferencias_em_transito_cleanup
  category: infrastructure
  message: "ERROR: Out of memory em net.http_get"
  cause: |
    Migration original usou current_setting('app.base_url', true) e
    current_setting('app.worker_secret', true) — GUCs custom retornam
    NULL em Supabase staging (ALTER DATABASE/ROLE bloqueado).
    concat(NULL, ...) → net.http_get(NULL, ...) → OOM.
  fix: |
    Re-schedule do cron usando vault.decrypted_secrets + URL hardcoded
    (mesmo pattern dos 4 crons funcionando).
  files:
    - supabase/migrations/20260528_cron_transferencias_vault.sql
  tags: [cron, vault, pg_cron, oom, supabase, transferencias]
```

(Replicar pra cada uma das 10 tasks com ids consecutivos.)

- [ ] **Step 11.4: Commit consolidado**

```bash
git add CLAUDE.md erros-conhecidos.yaml docs/superpowers/plans/2026-05-28-wms-reaudit-fixes.md
git commit -m "$(cat <<'EOF'
docs(re-audit): summary + erros-conhecidos pros 10 fixes (2026-05-28)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Out of Scope (deferred)

Findings da re-auditoria NÃO endereçados aqui, por categoria:

### Deferred pra Fase 7 ou Fix-Final E
- **P4 LocalizacaoCombo `allowCreate=false` em Receber Transferência** (Módulo 8 #NEW) — 1 linha, mas exige decisão UX (operador deve poder criar loc nova durante recepção?). Pequeno; combinar com outros UI fixes de transferência.
- **P4 Auto-release `recebimento_em_andamento_por`** (Módulo 8) — exige cron novo ou heartbeat. Volume baixo (recepção raramente trava em crash); aceitar pendência operacional manual por agora.
- **P5 Idempotency: marcar pedido `falhou` em vez de DELETE** (Módulo 7) — exige novo enum value + UI tratando, ~30 linhas + migration. Volume baixo (vendas manuais).
- **P5 Drop `siso_pedido_item_estoques`** (Módulo 3, Fase 7) — 17 consumers leem como snapshot congelado. Decisão arquitetural maior; sai do escopo de fix incremental. Documentado em CLAUDE.md "Deprecated / To Remove".

### LOW novos descobertos (13 items)
Não-críticos, cosméticos ou trade-offs documentados. Itens 4.NEW2, 4.NEW3, 4.NEW4, 5.NEW2, 5.NEW3, 6.NEW3, 7.NEW3, 8.NEW2, 8.NEW3, 1.NEW1, 3.NEW1, 3.NEW2, 3.NEW3 ficam no Appendix A do relatório de re-audit pra serem priorizados em ciclo separado. Custo agregado: ~6h.

---

## Self-Review (já feito pelo autor do plano)

**Coverage:** Os 10 items P0-P3 do `00-index.html` §Bugs críticos restantes + §Priorização P0-P3 estão cobertos (Tasks 1-10). Items P4-P5 movidos pra Out of Scope com justificativa. Item "Sidebar devoluções badge contador" (P2) não está aqui — verifiquei: é UI cosmética isolada (~5 linhas), ficou junto ao bloco de LOWs novos.

**Placeholder scan:** Task 5 contém placeholders `[Capturar e reescrever]` em 5 das 8 RPCs — intencional. A migration exige `pg_get_functiondef` capturado em runtime (Step 5.1); colar definição inventada é mais arriscado que pedir captura. Template completo de uma RPC dada (`fluxo_aging_outlier`) serve de guia.

**Type consistency:** Helper `requireWarehouseAccessOrOwnVenda` (Task 3) tem assinatura `(req: Request, pedidoId: string) → Promise<AuthResult>` — `AuthResult` é importado do mesmo arquivo (`auth.ts:5`). `pedidoId` é resolvido antes da chamada no caller (Task 3 Step 3.2 ajusta ordem).
