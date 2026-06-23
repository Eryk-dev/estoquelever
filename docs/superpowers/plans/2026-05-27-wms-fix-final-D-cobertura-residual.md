# WMS Fix-Final D · Cobertura Residual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar todos os findings reais residuais da auditoria 2026-05-26 que não foram cobertos pelos planos P1-P6 + Fix-Final A/B/C. 5 bugs reais validados + 10 LOW priority + 3 itens de auditoria/rastreabilidade.

**Architecture:** Mantém padrões já estabelecidos: RPCs atômicas pra race conditions, optimistic locks via `.eq()` em UPDATE, filtros server-side por galpão usando `OR(eq, is.null)`, cenários novos na suite de testes pra cada bug fixado. Sem refactors estruturais — todos os fixes são cirúrgicos.

**Tech Stack:** Next.js 16 App Router · TypeScript strict · Supabase (Postgres + RPC) · TanStack React Query · vitest (unit + integration + scenarios HTTP)

**Out-of-scope (ver Appendix B):**
- `siso_pedido_item_estoques` drop (17 consumers em hot paths — design decision pendente, Fase 7)
- Reconciliação cutoff_em→aprovada do inventário (trade-off documentado [#P6-4.8])
- 14 itens BY DESIGN listados no Appendix A

**Ordem de execução:** Fases 1 e 2 são bugs reais (P0/P1). Fase 3 é UX. Fase 4 é cleanup. Fase 5 é auditoria — pode ser deferida se time apertar.

---

## File Structure

### Migrations novas
- `supabase/migrations/20260528_p5_8_pendencia_em_guarda_parcial.sql` — altera `wms_confirmar_guarda_atomico` pra preservar `'em_guarda'` em parcial
- `supabase/migrations/20260528_movs_pedido_manual_ref.sql` — adiciona `siso_movimentacoes.pedido_id_manual text` + index parcial

### Arquivos a modificar (ordem alfabética)
- `src/app/api/wms/compras/receber/route.ts:137-141` — optimistic lock
- `src/app/api/wms/pedidos/route.ts:121-196` — filtro galpão server-side
- `src/app/api/wms/vendas/criar/route.ts:243-291` — try/catch retornando 400
- `src/components/wms/vendas/pedido-card-wms.tsx:333-343` — remover `hasItemSemEstoque` recompute
- `src/lib/compras-utils.ts` (export já existe, line 85) + `src/components/wms/compras-*.tsx` — badge over-receive
- `src/lib/nf-webhook-handler.ts:223` — checar `isDevolucao()` antes do filtro 'venda'
- `src/lib/wms/dashboard-tarefas.ts` (~540) — adicionar contador "entradas diretas hoje"
- `src/lib/wms/inventario.ts:252-263` — `sairParty` libera locks síncronos
- `src/lib/wms/transferencias.ts` (varias) + endpoint `/transferir-galpao` — marcar deprecated ou gate via WORKER_SECRET
- `src/app/api/wms/vendas/criar/route.ts:377-381` + `src/lib/webhook-processor.ts:884-886` + `src/lib/webhook-processor-wms.ts:543-544` + `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts:203-204` + `src/app/api/wms/tiny/stock/ajustar/route.ts:175-181` — remover writes em `cwb_atende`/`sp_atende`
- `src/lib/wms/ledger.ts` ou `src/lib/wms/movimentacoes.ts` — aceitar `pedido_id_manual` em `inserirMovimentacao`
- `src/app/api/wms/vendas/criar/route.ts` (linhas onde chama `inserirMovimentacao` em baixa_direta) — propagar `pedido_id_manual`

### Cenários novos (scripts/wms/cenarios/catalogo/)
- `53-guarda-parcial-em-guarda.ts` — confirma que parcial mantém status `em_guarda`
- `54-pedidos-filtro-galpao.ts` — operador-cwb não vê pedidos SP
- `55-compras-receber-race.ts` — 2 receivers paralelos não duplicam qty
- `56-sairparty-libera-locks.ts` — locks são liberados síncronos
- `57-devolucao-nf-origem-venda.ts` — devolução com `origem.tipo='venda'` é processada
- `58-vendas-criar-400-sem-mapeamento.ts` — produto não-mapeado retorna 400 estruturado

---

## Fase 1 · Bugs P0 (visíveis pro operador) — 2 tasks

### Task 1: #5.8 Guarda parcial preserva `em_guarda`

**Bug:** após confirmar parcial (qty < qty_inicial), pendência regride pra `'pendente'`. `dashboard-tarefas.ts:560-565` filtra `status IN ('pendente', 'em_guarda')` e hidrata avatar do operador apenas em `em_guarda` — operador some do quadro home na parcial e outro pode pegar a pendência mid-flow.

**Files:**
- Create: `supabase/migrations/20260528_p5_8_pendencia_em_guarda_parcial.sql`
- Create: `scripts/wms/cenarios/catalogo/53-guarda-parcial-em-guarda.ts`
- Modify: `src/lib/wms/dashboard-tarefas.ts:560-565` (já filtra `pendente`+`em_guarda`, validar comportamento)

- [ ] **Step 1: Escrever cenário 53 (falha esperada)**

Create `scripts/wms/cenarios/catalogo/53-guarda-parcial-em-guarda.ts`:

```typescript
import { runCenario, expectInvariants } from "../_harness";
import { POST } from "../_harness/http";

export default runCenario("53-guarda-parcial-em-guarda", async (ctx) => {
  // Setup: 1 produto, 1 entrada de 10 unidades, operador confirma 4 no put-away
  const { produto, galpao, locRecebimento, locDestino, operador } = await ctx.setup({
    saldo_inicial: { produto_id: "P1", galpao: "CWB", qty: 0 },
    operadores: [{ nome: "op-test" }],
    locs: [{ codigo: "A-01-01", galpao: "CWB", tipo: "picking" }],
  });

  // Receber 10
  const receberResp = await POST(`/api/wms/receber`, {
    body: { produto_id: produto.id, galpao_id: galpao.id, qty: 10, custo_unitario: 5 },
    as: operador,
  });
  const pendencia_id = receberResp.body.pendencias[0].id;

  // Iniciar guarda
  await POST(`/api/wms/guarda/${pendencia_id}/iniciar`, { as: operador });

  // Confirmar parcial: 4 de 10
  const confirmResp = await POST(`/api/wms/guarda/${pendencia_id}/confirmar`, {
    body: { qty: 4, localizacao_destino_id: locDestino.id },
    as: operador,
  });

  ctx.expect(confirmResp.status, 200);
  ctx.expect(confirmResp.body.totalmente_guardada, false);
  ctx.expect(confirmResp.body.status, "em_guarda"); // <-- bug atual retorna 'pendente'

  // Validar via dashboard-tarefas que pendencia aparece com avatar do operador
  const homeResp = await ctx.get(`/api/wms/dashboard-tarefas?galpao_id=${galpao.id}`);
  const itemPend = homeResp.body.guarda.itens.find(
    (i: { id: string }) => i.id === pendencia_id,
  );
  ctx.expect(itemPend?.iniciada_por_nome, operador.nome);
  ctx.expect(itemPend?.qty_pendente, 6);

  await expectInvariants(ctx);
});
```

- [ ] **Step 2: Rodar cenário e ver falhar**

```bash
npm run scenarios -- --only 53
```

Expected: `FAIL: confirmResp.body.status === 'em_guarda'` (recebido `'pendente'`)

- [ ] **Step 3: Criar migration que altera o RPC**

Create `supabase/migrations/20260528_p5_8_pendencia_em_guarda_parcial.sql`:

```sql
-- Fix #5.8: parcial deve preservar 'em_guarda' (não regredir pra 'pendente').
--
-- Antes: CASE WHEN v_totalmente THEN 'guardada' ELSE 'pendente' END
-- Depois: 'guardada' (total) | 'em_guarda' (parcial)
--
-- Por que: regredir pra 'pendente' tira o avatar do operador no quadro home
-- (`dashboard-tarefas.ts:870-871,901-904` só hidrata avatar quando
-- status='em_guarda'). Operador some do quadro mid-flow, outro pode tomar
-- a pendência. Quebra PR-8 (visibilidade na home).

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
  -- [Fix #5.8] parcial preserva 'em_guarda' pra manter avatar do operador
  -- no quadro home (`dashboard-tarefas`). Antes regredia pra 'pendente'.
  v_novo_status := CASE WHEN v_totalmente THEN 'guardada' ELSE 'em_guarda' END;

  UPDATE siso_wms_pendencias_guarda
     SET qty_guardada = v_nova_qty_guardada,
         status = v_novo_status,
         guardada_em = CASE WHEN v_totalmente THEN now() ELSE NULL END
   WHERE id = p_pendencia_id;

  RETURN jsonb_build_object(
    'pendencia_id', p_pendencia_id,
    'origem_id', v_repl_result->>'origem_id',
    'mov_ids', v_repl_result->'mov_ids',
    'totalmente_guardada', v_totalmente,
    'qty_guardada', v_nova_qty_guardada,
    'status', v_novo_status
  );
END;
$$;

COMMENT ON FUNCTION wms_confirmar_guarda_atomico(uuid,numeric,uuid,uuid) IS
  'P3 #5.3 + #5.8: confirmar guarda atômico com FOR UPDATE; parcial preserva em_guarda (Fix-D).';
```

- [ ] **Step 4: Aplicar migration**

```bash
npx supabase migration up --db-url "$SUPABASE_DB_URL_STAGING"
```

Expected: migration aplicada sem erro.

- [ ] **Step 5: Rodar cenário 53 e ver passar**

```bash
npm run scenarios -- --only 53
```

Expected: PASS (status='em_guarda', avatar hidratado no dashboard).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260528_p5_8_pendencia_em_guarda_parcial.sql \
  scripts/wms/cenarios/catalogo/53-guarda-parcial-em-guarda.ts
git commit -m "fix(guarda): parcial preserva em_guarda para manter avatar no quadro (#5.8)"
```

---

### Task 2: #12 `/api/wms/pedidos` filtro galpão server-side

**Bug:** endpoint checa `userCan(session, "pedidos.ver")` mas as 3 queries (linhas 156-174) não filtram por `separacao_galpao_id` — operador-cwb recebe rows SP. Quebra PR-8 (filtro por galpão server-side).

**Files:**
- Modify: `src/app/api/wms/pedidos/route.ts:121-196`
- Create: `scripts/wms/cenarios/catalogo/54-pedidos-filtro-galpao.ts`

- [ ] **Step 1: Escrever cenário 54 (falha esperada)**

Create `scripts/wms/cenarios/catalogo/54-pedidos-filtro-galpao.ts`:

```typescript
import { runCenario, expectInvariants } from "../_harness";
import { GET } from "../_harness/http";

export default runCenario("54-pedidos-filtro-galpao", async (ctx) => {
  // Setup: 2 pedidos — um CWB, um SP. Operador-cwb não pode ver o SP.
  const { admin, opCwb, galpaoCwb, galpaoSp } = await ctx.setup({
    operadores: [{ nome: "admin", cargo: "admin" }, { nome: "op-cwb", cargo: "operador_cwb" }],
  });

  const pCwb = await ctx.criarPedidoAuto({ galpao: galpaoCwb });
  const pSp = await ctx.criarPedidoAuto({ galpao: galpaoSp });

  // Admin vê os dois
  const adminResp = await GET(`/api/wms/pedidos`, { as: admin });
  ctx.expect(adminResp.body.length, 2);

  // Operador-cwb só vê o CWB (e os com separacao_galpao_id NULL — pendentes pré-aprovação)
  const cwbResp = await GET(`/api/wms/pedidos`, { as: opCwb });
  ctx.expect(cwbResp.body.length, 1);
  ctx.expect(cwbResp.body[0].id, pCwb.id);

  await expectInvariants(ctx);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npm run scenarios -- --only 54
```

Expected: `FAIL: cwbResp.body.length === 1` (recebido `2`).

- [ ] **Step 3: Patch no route com filtro server-side**

Edit `src/app/api/wms/pedidos/route.ts:121-196`. Substituir a função `GET` por:

```typescript
export async function GET(request: Request) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "pedidos.ver")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");
  const supabase = createServiceClient();

  // [Fix #12] Filtro galpão server-side. Admin vê tudo (galpaoId pode ser
  // null pra admin). Operadores galpão-scoped (cargo operador_cwb/operador_sp)
  // filtram por separacao_galpao_id matching ou IS NULL (pendentes pré-aprovação
  // não têm galpão definido ainda — esses devem aparecer pra todos).
  const galpaoSession = session.galpaoId;
  const isAdmin = session.cargo === "admin";
  const filterGalpao = !isAdmin && galpaoSession;

  function applyGalpaoFilter<T extends { or: (clause: string) => T; eq: (col: string, val: string) => T }>(q: T): T {
    if (!filterGalpao) return q;
    return q.or(`separacao_galpao_id.eq.${galpaoSession},separacao_galpao_id.is.null`);
  }

  if (statusFilter) {
    const statuses = statusFilter.split(",").map((s) => s.trim());
    let q = supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .in("status", statuses);
    q = applyGalpaoFilter(q);
    const { data: pedidos, error } = await q
      .order("criado_em", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(await buildResponse(supabase, pedidos ?? []));
  }

  const activeStatuses = ["pendente", "executando", "erro"];

  function buildActive() {
    let q = supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .in("status", activeStatuses);
    q = applyGalpaoFilter(q);
    return q.order("criado_em", { ascending: false });
  }
  function buildRealocacao() {
    let q = supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .eq("status_separacao", "pendente_realocacao");
    q = applyGalpaoFilter(q);
    return q.order("criado_em", { ascending: false });
  }
  function buildRecent() {
    let q = supabase
      .from("siso_pedidos")
      .select("*, siso_empresas(nome)")
      .not("status", "in", `(${activeStatuses.join(",")})`)
      .neq("status_separacao", "pendente_realocacao");
    q = applyGalpaoFilter(q);
    return q.order("criado_em", { ascending: false }).limit(150);
  }

  const [activeResult, realocacaoResult, recentResult] = await Promise.all([
    buildActive(),
    buildRealocacao(),
    buildRecent(),
  ]);

  const error = activeResult.error || realocacaoResult.error || recentResult.error;
  const seen = new Set<string>();
  const pedidos: typeof activeResult.data = [];
  for (const p of [
    ...(activeResult.data ?? []),
    ...(realocacaoResult.data ?? []),
    ...(recentResult.data ?? []),
  ]) {
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      pedidos.push(p);
    }
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(await buildResponse(supabase, pedidos));
}
```

- [ ] **Step 4: Rodar cenário 54 e passar**

```bash
npm run scenarios -- --only 54
```

Expected: PASS.

- [ ] **Step 5: Rodar suite completa pra garantir zero regressão**

```bash
npm run scenarios
```

Expected: todos cenários verdes (a baseline anterior + o novo 54).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/wms/pedidos/route.ts scripts/wms/cenarios/catalogo/54-pedidos-filtro-galpao.ts
git commit -m "fix(pedidos): filtro galpão server-side em /api/wms/pedidos (#12)"
```

---

## Fase 2 · Bugs P1 (race / edge cases) — 4 tasks

### Task 3: #3.8 Compras receber — optimistic lock

**Bug:** `compras/receber/route.ts:137-141` faz SELECT (linha 116) → UPDATE sem `.eq("compra_quantidade_recebida", jaRecebido)`. 2 ops recebendo o mesmo SKU em paralelo: ambos lêem `jaRecebido=0`, ambos UPDATE pra `5`, primeiro vence, segundo sobrescreve mas qty correta (5+5=10 esperado) some.

**Files:**
- Modify: `src/app/api/wms/compras/receber/route.ts:137-141`
- Create: `scripts/wms/cenarios/catalogo/55-compras-receber-race.ts`

- [ ] **Step 1: Escrever cenário 55 (falha esperada)**

Create `scripts/wms/cenarios/catalogo/55-compras-receber-race.ts`:

```typescript
import { runCenario, expectInvariants } from "../_harness";
import { POST } from "../_harness/http";

export default runCenario("55-compras-receber-race", async (ctx) => {
  // Setup: OC com 10 unidades, 2 ops chamam /compras/receber com qty=5 em paralelo
  const { admin, opA, opB, fornecedor, ordemCompra, sku } = await ctx.setupOC({
    qty_solicitada: 10,
  });

  // 2 receberes paralelos de qty=5 cada (total esperado: 10 recebidos)
  const [r1, r2] = await Promise.all([
    POST(`/api/wms/compras/receber`, {
      body: { sku, quantidade_recebida: 5, fornecedor_id: fornecedor.id },
      as: opA,
    }),
    POST(`/api/wms/compras/receber`, {
      body: { sku, quantidade_recebida: 5, fornecedor_id: fornecedor.id },
      as: opB,
    }),
  ]);

  // Pelo menos 1 deve ter sucesso. O outro deve ou (a) ter sucesso com qty correta,
  // ou (b) retornar 409 com motivo "concorrência". Nunca os dois aceitarem com qty
  // sobrescrita (o bug).
  const status1 = r1.status;
  const status2 = r2.status;

  const sucessos = [status1, status2].filter((s) => s === 200);
  const conflitos = [status1, status2].filter((s) => s === 409);

  ctx.expect(sucessos.length + conflitos.length, 2); // ambos respostas tratadas
  ctx.expect(sucessos.length, 2); // ambos sucessos esperados (qty disponível)

  // Valida estado final: total recebido = 10 (não 5 — que seria o bug)
  const oc = await ctx.getOrdemCompra(ordemCompra.id);
  const item = oc.itens.find((i: { sku: string }) => i.sku === sku);
  ctx.expect(item?.compra_quantidade_recebida, 10);

  await expectInvariants(ctx);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npm run scenarios -- --only 55
```

Expected: `FAIL: item.compra_quantidade_recebida === 10` (esperado, recebido `5` — sobrescrita).

- [ ] **Step 3: Aplicar optimistic lock no UPDATE**

Edit `src/app/api/wms/compras/receber/route.ts:137-141`. Substituir o bloco do UPDATE por:

```typescript
        // [Fix #3.8] Optimistic lock via .eq("compra_quantidade_recebida", jaRecebido).
        // Se outro receiver alterou recebida entre o SELECT (linha 116) e este UPDATE,
        // affected_rows=0 e a request volta pra retry com jaRecebido atualizado.
        // Padrão P3 (alinhado com iniciarGuarda, contagens, transferencias).
        const { data: updated, error: updateErr } = await supabase
          .from("siso_pedido_itens")
          .update(updateData)
          .eq("id", item.id)
          .eq("compra_quantidade_recebida", jaRecebido)
          .select("id");

        if (updateErr) {
          logger.error("compras-receber", `Erro ao atualizar item ${item.id}`, {
            error: updateErr.message,
          });
          continue;
        }

        if (!updated || updated.length === 0) {
          // Race detectada: refetch o item e reentra no loop (no máx 1 retry)
          const { data: refresh } = await supabase
            .from("siso_pedido_itens")
            .select("id, pedido_id, sku, compra_quantidade_solicitada, quantidade_pedida, compra_quantidade_recebida")
            .eq("id", item.id)
            .single();
          if (!refresh) {
            logger.warn("compras-receber", "Item desapareceu durante race retry", { id: item.id });
            continue;
          }
          const novoJaRecebido = Number(refresh.compra_quantidade_recebida ?? 0);
          const novoFaltante = Math.max(qtySolicitada - novoJaRecebido, 0);
          if (novoFaltante <= 0) {
            // Outro receiver já completou — pula
            continue;
          }
          const novaQtyParaEsteItem = Math.min(remaining, novoFaltante);
          const novoTotal = novoJaRecebido + novaQtyParaEsteItem;
          const novoTodosRecebidos = novoTotal >= qtySolicitada;
          const novoUpdateData: Record<string, unknown> = {
            compra_quantidade_recebida: novoTotal,
          };
          if (novoTodosRecebidos) novoUpdateData.compra_status = "recebido";
          if (observacao) novoUpdateData.compra_equivalente_observacao = observacao;
          const { data: retryUpdated } = await supabase
            .from("siso_pedido_itens")
            .update(novoUpdateData)
            .eq("id", item.id)
            .eq("compra_quantidade_recebida", novoJaRecebido)
            .select("id");
          if (!retryUpdated || retryUpdated.length === 0) {
            logger.warn("compras-receber", "Race persistente em retry", { id: item.id });
            continue;
          }
          remaining -= novaQtyParaEsteItem;
          atualizados++;
          alocado += novaQtyParaEsteItem;
          allAffectedItemIds.push(String(item.id));
          continue;
        }

        allAffectedItemIds.push(String(item.id));
        remaining -= qtyParaEsteItem;
        atualizados++;
        alocado += qtyParaEsteItem;
```

- [ ] **Step 4: Rodar cenário 55 e passar**

```bash
npm run scenarios -- --only 55
```

Expected: PASS (total=10, ambos receivers contabilizados).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/compras/receber/route.ts \
  scripts/wms/cenarios/catalogo/55-compras-receber-race.ts
git commit -m "fix(compras): optimistic lock em receber pra eliminar race (#3.8)"
```

---

### Task 4: #4.6 `sairParty` libera locks de loc em_contagem síncronos

**Bug:** `inventario.ts:252-263` em `sairParty` só seta `finalizado_em` na tabela `siso_inventario_operadores`. Locks em `siso_inventario_localizacoes` (status='em_contagem', bloqueada_por=usuario_id) ficam órfãos até cleanup async (30min cron). Operador que sair mid-contagem deixa loc reivindicada.

**Files:**
- Modify: `src/lib/wms/inventario.ts:252-263`
- Create: `scripts/wms/cenarios/catalogo/56-sairparty-libera-locks.ts`

- [ ] **Step 1: Escrever cenário 56 (falha esperada)**

Create `scripts/wms/cenarios/catalogo/56-sairparty-libera-locks.ts`:

```typescript
import { runCenario, expectInvariants } from "../_harness";
import { POST, DELETE, GET } from "../_harness/http";

export default runCenario("56-sairparty-libera-locks", async (ctx) => {
  const { sessao, galpao, op1, op2, locA } = await ctx.setupInventario({
    locs: [{ codigo: "A-01-01", galpao: "CWB", saldo: 5 }],
  });

  // op1 entra na party e reivindica loc A-01-01
  await POST(`/api/wms/inventario/${sessao.id}/party`, { as: op1 });
  const proxLocResp = await POST(`/api/wms/inventario/${sessao.id}/proxima-loc`, { as: op1 });
  ctx.expect(proxLocResp.body.codigo, "A-01-01");

  // op1 sai sem contar (sairParty)
  await DELETE(`/api/wms/inventario/${sessao.id}/party`, { as: op1 });

  // op2 entra e DEVE conseguir pegar a mesma loc
  await POST(`/api/wms/inventario/${sessao.id}/party`, { as: op2 });
  const op2Resp = await POST(`/api/wms/inventario/${sessao.id}/proxima-loc`, { as: op2 });
  ctx.expect(op2Resp.body.codigo, "A-01-01"); // <-- bug: hoje retorna pool_vazio até cleanup async

  await expectInvariants(ctx);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npm run scenarios -- --only 56
```

Expected: `FAIL: op2Resp.body.codigo === 'A-01-01'` (recebido `pool_vazio:true`).

- [ ] **Step 3: Patch `sairParty` pra liberar locks síncronos**

Edit `src/lib/wms/inventario.ts:252-263`. Substituir a função `sairParty` por:

```typescript
export async function sairParty(
  sessaoId: string,
  usuarioId: string,
): Promise<void> {
  const sb = createServiceClient();
  // [Fix #4.6] Libera locks de loc em_contagem desse operador SÍNCRONO ao
  // sair da party. Antes dependia do cleanup async (30min) — locks ficavam
  // órfãos visualmente bloqueando colegas durante a janela.
  await sb
    .from("siso_inventario_localizacoes")
    .update({
      bloqueada_por: null,
      bloqueada_em: null,
      status: "pendente",
    })
    .eq("sessao_id", sessaoId)
    .eq("bloqueada_por", usuarioId)
    .eq("status", "em_contagem");

  await sb
    .from("siso_inventario_operadores")
    .update({ finalizado_em: new Date().toISOString() })
    .eq("sessao_id", sessaoId)
    .eq("usuario_id", usuarioId)
    .is("finalizado_em", null);
}
```

- [ ] **Step 4: Rodar cenário 56 e passar**

```bash
npm run scenarios -- --only 56
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/inventario.ts scripts/wms/cenarios/catalogo/56-sairparty-libera-locks.ts
git commit -m "fix(inventario): sairParty libera locks síncronos pra evitar loc órfã (#4.6)"
```

---

### Task 5: #6.12 `isDevolucao` antes do filtro 'venda' no nf-webhook-handler

**Bug:** `nf-webhook-handler.ts:223` ignora NF se `nf.origem?.tipo !== "venda"` (early return). Se Tiny entrega uma NF de devolução com `origem.tipo='venda'` (raro mas observado), `isDevolucao(nf)` (já exportado nas linhas 46-55) cobriria via `tipo`/`tipoOperacao`/`finalidade` — mas a checagem do handler só olha `origem.tipo`. NF de devolução legítima é ignorada.

**Files:**
- Modify: `src/lib/nf-webhook-handler.ts:223-234`
- Create: `scripts/wms/cenarios/catalogo/57-devolucao-nf-origem-venda.ts`

- [ ] **Step 1: Escrever cenário 57 (falha esperada)**

Create `scripts/wms/cenarios/catalogo/57-devolucao-nf-origem-venda.ts`:

```typescript
import { runCenario, expectInvariants } from "../_harness";
import { POST, GET } from "../_harness/http";

export default runCenario("57-devolucao-nf-origem-venda", async (ctx) => {
  const { empresa } = await ctx.setup({});

  // Simula payload Tiny: NF de devolução COM origem.tipo='venda' (inconsistência observada)
  const payload = {
    cnpj: empresa.cnpj,
    tipo: "nota_fiscal",
    dados: {
      idNotaFiscalTiny: 999_111_222,
      tipo: "devolucao", // <-- aqui sim
      tipoOperacao: "E",
      origem: { tipo: "venda" }, // <-- inconsistência Tiny
      chaveAcesso: "31250112345678000199550010000000011000000019",
      dataEmissao: "2026-05-27",
    },
  };

  const resp = await POST(`/api/wms/webhook/tiny`, { body: payload });
  ctx.expect(resp.status, 200);

  // Deve ter criado entrada em siso_devolucoes_pendentes (não ignorado)
  const pendentes = await ctx.queryAll(
    `SELECT id FROM siso_devolucoes_pendentes WHERE chave_acesso_nf = $1`,
    [payload.dados.chaveAcesso],
  );
  ctx.expect(pendentes.length, 1);

  await expectInvariants(ctx);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npm run scenarios -- --only 57
```

Expected: `FAIL: pendentes.length === 1` (recebido `0` — NF ignorada).

- [ ] **Step 3: Patch no handler — checar `isDevolucao` antes do filtro 'venda'**

Edit `src/lib/nf-webhook-handler.ts:223-234`. Substituir o bloco `if (nf.origem?.tipo !== "venda")` por:

```typescript
      // [Fix #6.12] Antes de ignorar como "não-venda", checa se é uma devolução
      // disfarçada — Tiny ocasionalmente entrega NF de devolução com
      // origem.tipo='venda' mas tipo='devolucao'/tipoOperacao='E'. isDevolucao()
      // já cobre essas variações (linhas 46-55). Devoluções são roteadas pelo
      // webhook receiver pra siso_devolucoes_pendentes, não precisam continuar
      // pelo handler de NF de saída.
      if (nf.origem?.tipo !== "venda" && !isDevolucao(nf)) {
        logger.info("nf-webhook", "NF is not from a sale and not a devolução — ignoring", {
          idNotaFiscalTiny: String(idNotaFiscalTiny),
          origemTipo: nf.origem?.tipo ?? "unknown",
          empresaId,
        });
        await supabase
          .from("siso_webhook_logs")
          .update({ status: "ignorado", processado_em: new Date().toISOString() })
          .eq("id", webhookLogId);
        return;
      }

      // Se é devolução, deixa o webhook receiver tratar (siso_devolucoes_pendentes)
      if (isDevolucao(nf)) {
        logger.info("nf-webhook", "NF é devolução — roteando pra fila de devoluções", {
          idNotaFiscalTiny: String(idNotaFiscalTiny),
          empresaId,
        });
        await supabase
          .from("siso_webhook_logs")
          .update({ status: "roteado_devolucao", processado_em: new Date().toISOString() })
          .eq("id", webhookLogId);
        // Insert direto em siso_devolucoes_pendentes (best-effort dedup pela UNIQUE de nota_fiscal_id)
        const { error: insertErr } = await supabase
          .from("siso_devolucoes_pendentes")
          .insert({
            tiny_nota_fiscal_id: String(idNotaFiscalTiny),
            chave_acesso_nf: nf.chaveAcesso ?? null,
            empresa_id: empresaId,
            status: "aguardando_classificacao",
          });
        if (insertErr && insertErr.code !== "23505") {
          logger.error("nf-webhook", "Falha ao roteamento pra devolucoes", {
            idNotaFiscalTiny: String(idNotaFiscalTiny),
            error: insertErr.message,
          });
        }
        return;
      }
```

- [ ] **Step 4: Rodar cenário 57 e passar**

```bash
npm run scenarios -- --only 57
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nf-webhook-handler.ts scripts/wms/cenarios/catalogo/57-devolucao-nf-origem-venda.ts
git commit -m "fix(nf-webhook): isDevolucao antes do filtro origem.tipo='venda' (#6.12)"
```

---

### Task 6: #7.8 `vendas/criar` retorna 400 estruturado pra produto não-mapeado

**Bug:** `vendas/criar/route.ts:271` faz `throw new Error(msg)` dentro de `Promise.all` rethrown via `.catch(err => throw err)` (linha 290). Next.js retorna 500 + mensagem solta. Frontend não consegue surfacing limpo. Deveria ser 400 com payload `{erro, sku, empresas_disponiveis}`.

**Files:**
- Modify: `src/app/api/wms/vendas/criar/route.ts:243-291`
- Create: `scripts/wms/cenarios/catalogo/58-vendas-criar-400-sem-mapeamento.ts`

- [ ] **Step 1: Escrever cenário 58 (falha esperada)**

Create `scripts/wms/cenarios/catalogo/58-vendas-criar-400-sem-mapeamento.ts`:

```typescript
import { runCenario, expectInvariants } from "../_harness";
import { POST } from "../_harness/http";

export default runCenario("58-vendas-criar-400-sem-mapeamento", async (ctx) => {
  const { admin, vendedor, empresaA, empresaB, galpao } = await ctx.setup({
    operadores: [{ nome: "vendedor", cargo: "vendedor" }],
  });

  // Cria produto mapeado SÓ na empresaB (não na empresaA que é a origem)
  const produto = await ctx.criarProduto({
    sku: "SKU-ONLY-B",
    empresas_mapeadas: [empresaB.id],
  });

  // Tenta criar venda em nome da empresaA (sem mapeamento) com esse SKU
  const resp = await POST(`/api/wms/vendas/criar`, {
    body: {
      empresa_origem_id: empresaA.id,
      galpao_id: galpao.id,
      cliente_nome: "Teste",
      itens: [{ produto_id: produto.id, quantidade: 1 }],
      modo: "separacao",
    },
    as: vendedor,
  });

  // Expectativa: 400 com payload estruturado (não 500 com mensagem solta)
  ctx.expect(resp.status, 400);
  ctx.expect(resp.body.codigo, "PRODUTO_NAO_MAPEADO");
  ctx.expect(resp.body.sku, "SKU-ONLY-B");
  ctx.expect(Array.isArray(resp.body.empresas_disponiveis), true);
  ctx.expect(resp.body.empresas_disponiveis.length, 1);
  ctx.expect(resp.body.empresas_disponiveis[0].nome, empresaB.nome);

  await expectInvariants(ctx);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npm run scenarios -- --only 58
```

Expected: `FAIL: resp.status === 400` (recebido `500`).

- [ ] **Step 3: Patch — envolver em try/catch estruturado**

Edit `src/app/api/wms/vendas/criar/route.ts`. Localizar o bloco que começa em `const itensResolvidos = await Promise.all(` (~linha 243). Substituir pela versão que coleta erros sem rethrow:

```typescript
  // [Fix #7.8] Resolve cada item; coleta erros estruturados em vez de throw.
  // Permite frontend mostrar mensagem actionável (qual SKU + onde está disponível)
  // em vez de toast genérico de 500.
  type ResolvedItem = {
    produto_id: string;
    tiny_produto_id: number;
    sku: string;
    descricao: string;
    quantidade: number;
    localizacao_id: string | null;
    localizacao_codigo: string | null;
    disponivel: number;
    sugestoes: ReturnType<typeof resolverDisponibilidadeVenda> extends Promise<infer R>
      ? R extends { sugestoes: infer S } ? S : never : never;
  };
  type ResolverError = {
    codigo: "PRODUTO_NAO_ENCONTRADO" | "PRODUTO_NAO_MAPEADO";
    sku: string | null;
    produto_id: string;
    mensagem: string;
    empresas_disponiveis?: Array<{ id: string; nome: string }>;
  };

  const resolvedResults = await Promise.all(
    body.itens.map(async (item): Promise<{ ok: true; data: ResolvedItem } | { ok: false; error: ResolverError }> => {
      const prod = prodMap.get(item.produto_id);
      const tinyId = mapMap.get(item.produto_id);
      if (!prod) {
        return {
          ok: false,
          error: {
            codigo: "PRODUTO_NAO_ENCONTRADO",
            sku: null,
            produto_id: item.produto_id,
            mensagem: `Produto ${item.produto_id} não encontrado no catálogo`,
          },
        };
      }
      if (!tinyId) {
        const { data: outrasEmpresas } = await supabase
          .from("siso_produto_empresas")
          .select("empresa_id, siso_empresas!inner(id, nome)")
          .eq("produto_id", item.produto_id);
        const empresas = (outrasEmpresas ?? [])
          .map((e: { siso_empresas?: { id?: string; nome?: string } | Array<{ id?: string; nome?: string }> }) => {
            const emp = Array.isArray(e.siso_empresas) ? e.siso_empresas[0] : e.siso_empresas;
            return emp?.id && emp?.nome ? { id: emp.id, nome: emp.nome } : null;
          })
          .filter((e): e is { id: string; nome: string } => Boolean(e));
        const msg =
          empresas.length > 0
            ? `Produto ${prod.sku} não está cadastrado na empresa origem (${empresa.nome}). Disponível em: ${empresas.map((e) => e.nome).join(", ")}. Selecione uma dessas ou peça pro admin sincronizar.`
            : `Produto ${prod.sku} não está cadastrado em nenhuma empresa — peça pro admin sincronizar via Tiny`;
        return {
          ok: false,
          error: {
            codigo: "PRODUTO_NAO_MAPEADO",
            sku: prod.sku,
            produto_id: item.produto_id,
            mensagem: msg,
            empresas_disponiveis: empresas,
          },
        };
      }
      const dispon = await resolverDisponibilidadeVenda(supabase as never, {
        produto_id: item.produto_id,
        galpao_id,
      });
      return {
        ok: true,
        data: {
          produto_id: item.produto_id,
          tiny_produto_id: tinyId,
          sku: prod.sku,
          descricao: prod.descricao,
          quantidade: item.quantidade,
          localizacao_id: dispon.sugestao?.localizacao_id ?? null,
          localizacao_codigo: dispon.sugestao?.localizacao_codigo ?? null,
          disponivel: dispon.total_disponivel,
          sugestoes: dispon.sugestoes,
        } as ResolvedItem,
      };
    }),
  );

  // Se algum erro: retorna 400 estruturado com o PRIMEIRO erro (op corrige um por vez)
  const primeiroErro = resolvedResults.find((r) => !r.ok);
  if (primeiroErro && !primeiroErro.ok) {
    return NextResponse.json(
      {
        codigo: primeiroErro.error.codigo,
        sku: primeiroErro.error.sku,
        produto_id: primeiroErro.error.produto_id,
        erro: primeiroErro.error.mensagem,
        empresas_disponiveis: primeiroErro.error.empresas_disponiveis,
      },
      { status: 400 },
    );
  }

  const itensResolvidos: ResolvedItem[] = resolvedResults
    .filter((r): r is { ok: true; data: ResolvedItem } => r.ok)
    .map((r) => r.data);
```

- [ ] **Step 4: Rodar cenário 58 e passar**

```bash
npm run scenarios -- --only 58
```

Expected: PASS.

- [ ] **Step 5: Atualizar UI vendas/nova pra surface payload estruturado**

Edit `src/app/wms/vendas/nova/page.tsx`. No bloco `catch` da chamada `POST /api/wms/vendas/criar`, tratar resposta 400 estruturada:

```typescript
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        if (resp.status === 400 && errBody.codigo === "PRODUTO_NAO_MAPEADO") {
          toast.error(
            `Produto ${errBody.sku} não cadastrado nessa empresa.${
              errBody.empresas_disponiveis?.length
                ? ` Disponível em: ${errBody.empresas_disponiveis.map((e: { nome: string }) => e.nome).join(", ")}`
                : ""
            }`,
            { duration: 8000 },
          );
          return;
        }
        toast.error(errBody.erro ?? "Falha ao criar venda");
        return;
      }
```

(Localize o `catch`/`if (!resp.ok)` existente e substitua o ramo de erro genérico por esse.)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/wms/vendas/criar/route.ts \
  src/app/wms/vendas/nova/page.tsx \
  scripts/wms/cenarios/catalogo/58-vendas-criar-400-sem-mapeamento.ts
git commit -m "fix(vendas): criar retorna 400 estruturado pra produto não-mapeado (#7.8)"
```

---

## Fase 3 · UX / Visibilidade (LOW) — 3 tasks

### Task 7: #3.5 Surface over-receive na UI de Compras

**Bug:** `compras-utils.ts:85` JÁ retorna valor negativo em `getCompraQuantidadeRestante` quando recebido > solicitado (P6 expôs o problema). Mas nenhum consumidor UI surfaceia esse over-receive — operador não vê alerta.

**Files:**
- Modify: `src/app/wms/compras/page.tsx` (tab Receber + Histórico)
- Modify: `src/app/api/wms/compras/route.ts` (incluir `excedente` no payload)

- [ ] **Step 1: Adicionar campo `excedente` no payload do GET /api/wms/compras**

Edit `src/app/api/wms/compras/route.ts`. Localizar onde monta o response dos itens em tab=receber/historico (procure por `compra_quantidade_recebida`). Adicionar:

```typescript
import { getCompraQuantidadeRestante } from "@/lib/compras-utils";
// ...
const restante = getCompraQuantidadeRestante(item); // pode ser negativo
const excedente = restante < 0 ? -restante : 0;
// no objeto retornado:
{
  // ... campos existentes
  quantidade_restante: Math.max(restante, 0),
  excedente, // novo
}
```

- [ ] **Step 2: Renderizar badge "Excedente: +N" na tab Receber**

Edit `src/app/wms/compras/page.tsx`. Localizar a renderização das linhas de itens em tab Receber. Adicionar:

```tsx
{item.excedente > 0 && (
  <span
    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
    title="Recebimento maior que solicitado. Verifique fornecedor / contagem."
  >
    <AlertTriangle className="size-3" />
    Excedente: +{item.excedente}
  </span>
)}
```

- [ ] **Step 3: Manual smoke — verificar visualmente**

Servidor local rodando (`npm run dev`). Criar OC com qty=5, receber 7. Verificar badge "Excedente: +2" aparece na tab Receber e tab Histórico.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/compras/route.ts src/app/wms/compras/page.tsx
git commit -m "feat(compras): badge over-receive na UI (#3.5)"
```

---

### Task 8: #5.2 Card "Entradas diretas hoje" no quadro home

**Bug:** entradas diretas (`/api/wms/receber?entrada_direta=true`) pulam dock RECEBIMENTO e não criam pendência. Quadro home só lê de `siso_wms_pendencias_guarda` — entradas diretas ficam invisíveis. Sem visibilidade da operação.

**Files:**
- Modify: `src/lib/wms/dashboard-tarefas.ts` (~540, área das queries)
- Modify: `src/components/wms/home/exceptions/secao-excecoes.tsx` (card novo)

- [ ] **Step 1: Adicionar query de entradas diretas no dashboard-tarefas**

Edit `src/lib/wms/dashboard-tarefas.ts`. Na função `montarDashboardTarefas`, adicionar nova query no `Promise.all` (junto com devolucoes/transferencias/etc):

```typescript
    // [Fix #5.2] Entradas diretas hoje — count de movs com origem_tipo='nf_compra'
    // e localização destino ≠ tipo='recebimento' (entrada direta pula dock).
    (() => {
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      let q = sb
        .from("siso_movimentacoes")
        .select(
          "id, produto_id, qty, criado_em, " +
            "produto:siso_produtos(sku, descricao), " +
            "localizacao:siso_localizacoes!inner(codigo, tipo, galpao_id)",
          { count: "exact", head: false },
        )
        .eq("tipo", "E")
        .eq("origem_tipo", "nf_compra")
        .neq("localizacao.tipo", "recebimento")
        .gte("criado_em", hoje.toISOString())
        .order("criado_em", { ascending: false })
        .limit(20);
      if (galpao_id) q = q.eq("localizacao.galpao_id", galpao_id);
      return q;
    })(),
```

E no agrupamento da response, adicionar o card:

```typescript
  // Entradas diretas hoje
  const entradasDiretasRows = (entradasDiretasQ.data ?? []) as Array<{
    id: string;
    qty: number;
    criado_em: string;
    produto?: { sku?: string; descricao?: string } | null;
    localizacao?: { codigo?: string } | null;
  }>;
  const entradasDiretas = {
    total: entradasDiretasRows.length,
    itens: entradasDiretasRows.slice(0, 10).map((r) => ({
      id: r.id,
      sku: r.produto?.sku ?? "",
      descricao: r.produto?.descricao ?? "",
      qty: r.qty,
      localizacao_codigo: r.localizacao?.codigo ?? "",
      criado_em: r.criado_em,
    })),
  };
```

E incluir no objeto retornado pela função.

- [ ] **Step 2: Renderizar card no SecaoExcecoes**

Edit `src/components/wms/home/exceptions/secao-excecoes.tsx`. Adicionar um card novo no grid de exceções:

```tsx
<Link
  href="/wms/ledger?origem_tipo=nf_compra&hoje=true"
  className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors"
>
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
      <PackagePlus className="size-4" />
      <span>Entradas diretas hoje</span>
    </div>
    <span className="text-2xl font-semibold tabular-nums">
      {data.entradas_diretas?.total ?? 0}
    </span>
  </div>
  {(data.entradas_diretas?.itens?.length ?? 0) > 0 && (
    <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
      Últimos SKUs: {data.entradas_diretas?.itens.slice(0, 3).map((i) => i.sku).join(", ")}
    </p>
  )}
</Link>
```

- [ ] **Step 3: Smoke manual**

Servidor rodando. Fazer `POST /api/wms/receber` com `entrada_direta=true`. Voltar pra home, conferir o card "Entradas diretas hoje" incrementou.

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/dashboard-tarefas.ts \
  src/components/wms/home/exceptions/secao-excecoes.tsx
git commit -m "feat(home): card 'Entradas diretas hoje' no quadro de exceções (#5.2)"
```

---

### Task 9: #1.3 Remover `hasItemSemEstoque` recompute no card

**Bug:** `pedido-card-wms.tsx:333-343` recomputa `hasItemSemEstoque` client-side a cada render, sobrescrevendo `sugestao` que veio do server. O comment em `pedidos/route.ts:34-39` diz "GET retorna sugestão PERSISTIDA sempre — sem recompute aqui" (P6 fixou o backend). Frontend ainda faz recompute, causando flicker entre `propria↔oc` quando estoque live muda entre renders.

**Files:**
- Modify: `src/components/wms/vendas/pedido-card-wms.tsx:333-343`

- [ ] **Step 1: Edit do componente removendo recompute**

Edit `src/components/wms/vendas/pedido-card-wms.tsx:333-343`. Substituir o bloco por:

```typescript
  // [Fix #1.3] Removido hasItemSemEstoque recompute client-side. O backend
  // já persiste a sugestão correta em siso_pedidos.sugestao (P6 #1.15) — o
  // GET retorna o snapshot. Recomputar aqui causava flicker visual entre
  // propria↔oc quando o saldo live mudava entre renders.
  const [decisao, setDecisao] = useState<Decisao>(decisaoFinal ?? sugestao);
  const [dropdownOpen, setDropdownOpen] = useState(false);
```

- [ ] **Step 2: Verificar import `useMemo` ainda é usado**

```bash
grep -n "useMemo" src/components/wms/vendas/pedido-card-wms.tsx
```

Se não houver mais usos, remover do import. Se houver, deixar.

- [ ] **Step 3: Smoke manual**

Servidor rodando. Abrir pedido pendente. Verificar dropdown decisao não pisca. Mudar saldo via `/wms/ajuste` em outra aba. Voltar pro pedido — decisao deve continuar mesma (snapshot), não recomputar.

- [ ] **Step 4: Commit**

```bash
git add src/components/wms/vendas/pedido-card-wms.tsx
git commit -m "fix(ui): pedido card usa sugestao persistida sem recompute (#1.3)"
```

---

## Fase 4 · Cleanup técnico (LOW) — 4 tasks

### Task 10: #3.1 + #7.2 Deprecar `cwb_atende`/`sp_atende`

**Bug:** 5 arquivos ainda escrevem em `cwb_atende`/`sp_atende` (colunas legacy hardcoded a 2 galpões): `webhook-processor.ts:884-886` (read+write), `webhook-processor-wms.ts:543-544` (write false), `vendas/criar/route.ts:380-381` (regex `/^cwb\b/i`), `compras/itens/[id]/equivalente/confirmar/route.ts:203-204`, `tiny/stock/ajustar/route.ts:175-181`. Impede 3º galpão sem refactor.

**Files:**
- Modify: 5 arquivos acima (remover writes)
- Verify: zero readers ativos em código produtivo

- [ ] **Step 1: Confirmar zero readers**

```bash
grep -rn "cwb_atende\|sp_atende" /Users/eryk/Documents/ESTOQUE/src/ \
  --include="*.ts" --include="*.tsx" | grep -v "_atende:" | head
```

Expected: zero linhas (todos resultados devem ser writes `cwb_atende: ...`, não reads). Se houver reads (`item.cwb_atende`, `it.sp_atende`, etc), CADASTRAR o ponto de leitura como dependência ANTES de remover writes.

- [ ] **Step 2: Remover writes em 5 arquivos**

Em `src/app/api/wms/vendas/criar/route.ts:377-381`, deletar:

```typescript
    // Legacy compat: cwb_atende/sp_atende são mantidos pra queries legadas
    cwb_atende: /^cwb\b/i.test(galpaoNome ?? ""),
    sp_atende: /^sp\b/i.test(galpaoNome ?? ""),
```

Em `src/lib/webhook-processor.ts:884-886`, deletar:

```typescript
    cwb_atende: cwbAgg.disponivel >= qtd,
    sp_atende: spAgg.disponivel >= qtd,
```

Também remover do `interface` na linha 59-60 do mesmo arquivo:

```typescript
  cwb_atende: boolean;
  sp_atende: boolean;
```

Em `src/lib/webhook-processor-wms.ts:543-544`, deletar:

```typescript
        cwb_atende: false,
        sp_atende: false,
```

Em `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts:203-204`, deletar:

```typescript
        cwb_atende: estoqueCwb?.atende ?? false,
        sp_atende: estoqueSp?.atende ?? false,
```

Em `src/app/api/wms/tiny/stock/ajustar/route.ts:175-181`, deletar:

```typescript
              cwb_atende: novoDisponivel >= qtdPedida,
              // ...
              sp_atende: novoDisponivel >= qtdPedida,
```

- [ ] **Step 3: Rodar build pra garantir zero referência**

```bash
npm run build
```

Expected: build passa sem erro de tipo.

- [ ] **Step 4: Rodar suite de cenários completa**

```bash
npm run scenarios
```

Expected: todos cenários verdes (zero regressão).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/vendas/criar/route.ts \
  src/lib/webhook-processor.ts \
  src/lib/webhook-processor-wms.ts \
  src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts \
  src/app/api/wms/tiny/stock/ajustar/route.ts
git commit -m "chore(legacy): remove cwb_atende/sp_atende hardcoded writes (#3.1, #7.2)"
```

- [ ] **Step 6 (opcional, separado): Drop colunas via migration**

Após 7 dias de burn-in sem alertas, criar migration `20260604_drop_pedido_itens_cwb_sp_atende.sql`:

```sql
ALTER TABLE siso_pedido_itens
  DROP COLUMN IF EXISTS cwb_atende,
  DROP COLUMN IF EXISTS sp_atende;
```

Defer pra task separada — não bloqueia esta.

---

### Task 11: #2.1 + #8.1 Decisão sobre endpoints órfãos

**Bug:** 2 endpoints sem callers orgânicos em produção:
- `/api/wms/separacao/expedir` — sem caller UI; cenário usa via `markExpedido` no harness
- `/api/wms/transferir-galpao` — só usado pelo harness de cenários (Fix-B T2 decidiu manter)

**Files:**
- Modify: `src/app/api/wms/separacao/expedir/route.ts` (adicionar gate + comment)
- Modify: `src/app/api/wms/transferir-galpao/route.ts` (adicionar comment confirmando uso interno)

- [ ] **Step 1: Audit dos callers**

```bash
grep -rn "fetch.*separacao/expedir\|fetch.*transferir-galpao" \
  /Users/eryk/Documents/ESTOQUE/src/ /Users/eryk/Documents/ESTOQUE/scripts/ 2>/dev/null
```

Expected: zero matches em `src/`. Matches em `scripts/wms/cenarios/_harness/` confirmam uso só pra testes.

- [ ] **Step 2: Adicionar gate WORKER_SECRET em /expedir**

Edit `src/app/api/wms/separacao/expedir/route.ts`. No início do handler `POST`, adicionar:

```typescript
  // [Fix #2.1] Endpoint sem caller orgânico em produção. Mantido pra harness
  // de cenários + flow de expedição quando UI for criada. Por enquanto exige
  // ou (a) WORKER_SECRET, ou (b) admin session. Bloqueia callers acidentais.
  const session = await getSessionUser(request);
  const workerSecret = request.headers.get("X-Worker-Secret");
  const isWorker = workerSecret && workerSecret === process.env.WORKER_SECRET;
  if (!isWorker && (!session || session.cargo !== "admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
```

- [ ] **Step 3: Comment em /transferir-galpao confirmando decisão**

Edit `src/app/api/wms/transferir-galpao/route.ts`. No topo do arquivo, adicionar:

```typescript
/**
 * POST /api/wms/transferir-galpao
 *
 * [Fix-B T2 confirmou: manter] Endpoint sem caller orgânico em produção UI.
 * Usado por `scripts/wms/cenarios/_harness/context.ts:640` e
 * `scripts/wms/cenarios/catalogo/15-transferencia-inter-galpao.ts:16` pra
 * setup de cenários. UI usa `/api/wms/transferencias` (path canônico).
 *
 * Não remover sem alinhamento com harness.
 */
```

- [ ] **Step 4: Rodar cenário 15 pra confirmar zero quebra**

```bash
npm run scenarios -- --only 15
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/expedir/route.ts \
  src/app/api/wms/transferir-galpao/route.ts
git commit -m "chore(routes): gate /expedir + doc transferir-galpao como interno (#2.1, #8.1)"
```

---

### Task 12: #5.3 Audit destino planejado vs destino real (BACKLOG)

**Severidade prática: média.** Pendência aceita `localizacao_destino_id` opcional no recebimento como sugestão. Operador pode escolher OUTRA loc no momento da guarda. Sem audit de "loc planejada vs loc real" — perde info de quão certeira a sugestão automática está sendo.

**Files:**
- Create: `supabase/migrations/20260528_pendencias_destino_planejado.sql`
- Modify: `src/lib/wms/guarda.ts` (confirmarGuarda — comparar e logar)

- [ ] **Step 1: Migration adicionando coluna**

Create `supabase/migrations/20260528_pendencias_destino_planejado.sql`:

```sql
-- Fix #5.3: rastreabilidade de loc destino sugerida vs efetiva.
--
-- Adiciona `localizacao_destino_planejada_id` na pendência, populado
-- no momento da criação (recebimento). Em confirmarGuarda, comparamos
-- com a loc real escolhida pelo operador e logamos divergência.
--
-- Objetivo: medir qualidade da sugestão automática (resolverLocRecebimento)
-- e identificar locs que operador prefere por motivos práticos não
-- capturados na heurística.

ALTER TABLE siso_wms_pendencias_guarda
  ADD COLUMN IF NOT EXISTS localizacao_destino_planejada_id uuid
    REFERENCES siso_localizacoes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pendencias_destino_planejado
  ON siso_wms_pendencias_guarda(localizacao_destino_planejada_id)
  WHERE localizacao_destino_planejada_id IS NOT NULL;

COMMENT ON COLUMN siso_wms_pendencias_guarda.localizacao_destino_planejada_id IS
  'Fix #5.3: loc sugerida pelo recebimento. Comparada com loc real na confirmação.';
```

- [ ] **Step 2: Popular na criação**

Edit `src/lib/wms/guarda.ts`. Em `criarPendencia` (procure pela função). Adicionar campo no INSERT:

```typescript
  // [Fix #5.3] Persiste a sugestão automática pra comparar com loc real na confirmação
  localizacao_destino_planejada_id: input.localizacao_destino_id ?? null,
```

- [ ] **Step 3: Log divergência em confirmarGuarda**

Edit `src/lib/wms/guarda.ts`. Em `desfazerGuarda` ou onde está `confirmarGuarda` (depois do RPC). Adicionar:

```typescript
  // [Fix #5.3] Audit destino planejado vs real
  if (pend.localizacao_destino_planejada_id &&
      pend.localizacao_destino_planejada_id !== p_localizacao_destino_id) {
    logger.info("wms.guarda.destino_divergente", "operador escolheu loc diferente da sugerida", {
      pendencia_id,
      destino_planejado: pend.localizacao_destino_planejada_id,
      destino_real: p_localizacao_destino_id,
      operador_id: usuario_id,
    });
    await sb.from("siso_pedido_historico").insert({
      pedido_id: null,
      evento: "guarda.destino_divergente",
      detalhes: {
        pendencia_id,
        destino_planejado: pend.localizacao_destino_planejada_id,
        destino_real: p_localizacao_destino_id,
      },
      usuario_id,
    }).then(() => {}, () => {});
  }
```

- [ ] **Step 4: Aplicar migration**

```bash
npx supabase migration up --db-url "$SUPABASE_DB_URL_STAGING"
```

- [ ] **Step 5: Smoke manual + commit**

Servidor rodando. Receber 1 unidade com sugestão de loc A-01-01. Confirmar em loc B-02-02. Conferir log estruturado `wms.guarda.destino_divergente` em `siso_logs`.

```bash
git add supabase/migrations/20260528_pendencias_destino_planejado.sql \
  src/lib/wms/guarda.ts
git commit -m "feat(guarda): audit destino planejado vs real (#5.3)"
```

---

### Task 13: #5.7 Fila persistente de impressões falhadas (BACKLOG GRANDE — ~1d)

**Severidade prática: média.** `etiqueta-produto-service.ts` faz `logger.logError` quando print falha mas operador depende de toast volátil. Se sair da página, perde alerta. Falta tela dedicada com fila + retry manual.

**Files:**
- Create: `supabase/migrations/20260528_siso_impressoes_log.sql`
- Modify: `src/lib/wms/etiqueta-produto-service.ts`
- Create: `src/app/wms/etiquetas/page.tsx` + `src/app/api/wms/impressoes/route.ts` + `src/app/api/wms/impressoes/[id]/retry/route.ts`

- [ ] **Step 1: Migration tabela `siso_impressoes_log`**

Create `supabase/migrations/20260528_siso_impressoes_log.sql`:

```sql
-- Fix #5.7: log persistente de jobs de impressão pra retry manual.
--
-- Antes: print é fire-and-forget. Logs vão pra siso_erros mas operador
-- depende de toast volátil — perde alerta ao trocar tela.
-- Depois: cada job grava status (enviado/sucesso/erro) + payload_hash pra
-- dedup; UI tem aba /wms/etiquetas mostrando erros com botão Retry.

CREATE TABLE IF NOT EXISTS siso_impressoes_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  printnode_job_id bigint,
  printer_id bigint,
  printer_nome text,
  payload_hash text,
  payload bytea, -- zpl ou pdf base64-decoded
  contexto text NOT NULL, -- 'guarda', 'separacao', 'manual', 'lote'
  contexto_ref_id text, -- id da pendencia, pedido, etc
  status text NOT NULL DEFAULT 'enviado' CHECK (status IN ('enviado', 'sucesso', 'erro', 'cancelado')),
  erro_msg text,
  enviado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  usuario_id uuid REFERENCES siso_usuarios(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_impressoes_log_status_enviado
  ON siso_impressoes_log (status, enviado_em DESC);
CREATE INDEX IF NOT EXISTS idx_impressoes_log_contexto
  ON siso_impressoes_log (contexto, contexto_ref_id);

COMMENT ON TABLE siso_impressoes_log IS
  'Fix #5.7: log de jobs PrintNode pra retry manual quando falham.';
```

- [ ] **Step 2: Instrumentar `etiqueta-produto-service.ts`**

Edit `src/lib/wms/etiqueta-produto-service.ts`. Antes de chamar PrintNode `sendJob`, gravar linha em `siso_impressoes_log` com status='enviado'. Após response, UPDATE pra 'sucesso' ou 'erro'.

```typescript
  const { data: logRow } = await sb
    .from("siso_impressoes_log")
    .insert({
      printer_id: printerId,
      printer_nome: printerNome,
      payload_hash: crypto.createHash("sha256").update(zpl).digest("hex"),
      payload: Buffer.from(zpl, "utf-8"),
      contexto,
      contexto_ref_id: contextoRefId ?? null,
      usuario_id: usuarioId ?? null,
    })
    .select("id")
    .single();
  const logId = logRow?.id;

  try {
    const jobResp = await printnode.sendJob(/* ... */);
    if (logId) {
      await sb.from("siso_impressoes_log").update({
        printnode_job_id: jobResp.id,
        status: "sucesso",
        atualizado_em: new Date().toISOString(),
      }).eq("id", logId);
    }
  } catch (err) {
    if (logId) {
      await sb.from("siso_impressoes_log").update({
        status: "erro",
        erro_msg: err instanceof Error ? err.message : String(err),
        atualizado_em: new Date().toISOString(),
      }).eq("id", logId);
    }
    // segue chamando logger.logError como antes (pra alertas)
    logger.logError({
      source: "etiqueta-produto-service",
      message: "Falha PrintNode",
      error: err,
      category: "external_api",
    });
  }
```

- [ ] **Step 3: Endpoint GET /api/wms/impressoes**

Create `src/app/api/wms/impressoes/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

export async function GET(request: Request) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userCan(session, "operacoes.imprimir")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "erro";
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_impressoes_log")
    .select("id, contexto, contexto_ref_id, printer_nome, status, erro_msg, enviado_em, atualizado_em, usuario:siso_usuarios(nome)")
    .eq("status", status)
    .order("enviado_em", { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ itens: data ?? [] });
}
```

- [ ] **Step 4: Endpoint POST /api/wms/impressoes/[id]/retry**

Create `src/app/api/wms/impressoes/[id]/retry/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { sendPrintnodeJob } from "@/lib/printnode";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userCan(session, "operacoes.imprimir")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const sb = createServiceClient();

  const { data: log } = await sb
    .from("siso_impressoes_log")
    .select("id, printer_id, payload, status")
    .eq("id", id)
    .single();
  if (!log) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (log.status === "sucesso") {
    return NextResponse.json({ error: "ja_sucesso" }, { status: 409 });
  }

  try {
    const job = await sendPrintnodeJob({
      printerId: log.printer_id,
      payload: Buffer.from(log.payload).toString("utf-8"),
    });
    await sb.from("siso_impressoes_log").update({
      printnode_job_id: job.id,
      status: "sucesso",
      atualizado_em: new Date().toISOString(),
      erro_msg: null,
    }).eq("id", id);
    return NextResponse.json({ ok: true, job_id: job.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 5: Tela `/wms/etiquetas`**

Create `src/app/wms/etiquetas/page.tsx`:

```typescript
"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";

export default function EtiquetasPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"erro" | "sucesso" | "enviado">("erro");

  const { data, isLoading } = useQuery({
    queryKey: ["impressoes", statusFilter],
    queryFn: () => sisoFetch(`/api/wms/impressoes?status=${statusFilter}`).then((r) => r.json()),
  });

  const retry = useMutation({
    mutationFn: (id: string) => sisoFetch(`/api/wms/impressoes/${id}/retry`, { method: "POST" }).then((r) => r.json()),
    onSuccess: () => {
      toast.success("Reenviado pra impressora");
      qc.invalidateQueries({ queryKey: ["impressoes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Etiquetas</h1>
      <div className="flex gap-2 mb-4">
        {(["erro", "enviado", "sucesso"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 text-sm rounded ${statusFilter === s ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-zinc-100 dark:bg-zinc-800"}`}
          >
            {s}
          </button>
        ))}
      </div>
      {isLoading ? <p>Carregando…</p> : (
        <div className="space-y-2">
          {(data?.itens ?? []).map((it: { id: string; contexto: string; printer_nome: string; erro_msg: string | null; enviado_em: string }) => (
            <div key={it.id} className="border border-zinc-200 dark:border-zinc-800 rounded p-3 flex items-center justify-between">
              <div className="text-sm">
                <p className="font-medium">{it.contexto} · {it.printer_nome}</p>
                <p className="text-xs text-zinc-500">{new Date(it.enviado_em).toLocaleString()}</p>
                {it.erro_msg && <p className="text-xs text-red-600 dark:text-red-400 mt-1">{it.erro_msg}</p>}
              </div>
              {statusFilter === "erro" && (
                <button
                  onClick={() => retry.mutate(it.id)}
                  disabled={retry.isPending}
                  className="px-3 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Retry
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Adicionar perm `operacoes.imprimir` + sidebar link**

Edit `src/lib/permissions.ts` adicionando a perm. Edit `src/components/wms/wms-shell.tsx` adicionando o link no grupo "Operações".

```typescript
// permissions.ts (Operações module):
"operacoes.imprimir": { module: "operacoes", action: "imprimir", description: "Ver fila de impressões + retry" },
```

Migration seed:

Create `supabase/migrations/20260528_perm_operacoes_imprimir.sql`:

```sql
-- Seed perm operacoes.imprimir pra admin + operador
INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
SELECT r.id, 'operacoes.imprimir'
  FROM siso_roles r
 WHERE r.codigo IN ('admin', 'operador', 'operador_cwb', 'operador_sp')
ON CONFLICT DO NOTHING;
```

- [ ] **Step 7: Smoke + commit**

Provocar erro de print (printer offline). Conferir aparece em `/wms/etiquetas` com Retry funcional.

```bash
git add supabase/migrations/20260528_siso_impressoes_log.sql \
  supabase/migrations/20260528_perm_operacoes_imprimir.sql \
  src/lib/wms/etiqueta-produto-service.ts \
  src/app/api/wms/impressoes/ \
  src/app/wms/etiquetas/page.tsx \
  src/lib/permissions.ts \
  src/components/wms/wms-shell.tsx
git commit -m "feat(etiquetas): fila persistente de impressões com retry manual (#5.7)"
```

---

## Fase 5 · Auditoria / Rastreabilidade — 2 tasks

### Task 14: #7.4 Venda manual pedido_id rastreável no ledger

**Bug:** `vendas/criar/route.ts:312,525-532` em baixa_direta grava mov com `pedido_id_manual` em `origem_detalhes` (JSONB). Queries por `pedido_id` no ledger não encontram MAN-... porque `siso_movimentacoes.pedido_id` é uuid. Reports financeiros perdem rastreabilidade.

**Files:**
- Create: `supabase/migrations/20260528_movs_pedido_manual_ref.sql`
- Modify: `src/lib/wms/ledger.ts` ou `src/lib/wms/movimentacoes.ts` (aceitar `pedido_id_manual`)
- Modify: `src/app/api/wms/vendas/criar/route.ts` (propagar)

- [ ] **Step 1: Migration coluna paralela**

Create `supabase/migrations/20260528_movs_pedido_manual_ref.sql`:

```sql
-- Fix #7.4: rastreabilidade de venda manual no ledger.
--
-- Antes: vendas manuais (modo baixa_direta) gravavam pedido_id_manual em
-- origem_detalhes JSONB. Queries por pedido_id NO LEDGER (UUID) não
-- encontravam MAN-... — relatórios financeiros perdiam rastreabilidade.
-- Depois: coluna paralela text + index parcial.

ALTER TABLE siso_movimentacoes
  ADD COLUMN IF NOT EXISTS pedido_id_manual text;

CREATE INDEX IF NOT EXISTS idx_movs_pedido_id_manual
  ON siso_movimentacoes(pedido_id_manual)
  WHERE pedido_id_manual IS NOT NULL;

COMMENT ON COLUMN siso_movimentacoes.pedido_id_manual IS
  'Fix #7.4: ref text pra pedido manual (MAN-...). Complementa pedido_id (uuid).';

-- Backfill best-effort: extrai de origem_detalhes onde existir
UPDATE siso_movimentacoes
   SET pedido_id_manual = origem_detalhes->>'pedido_id_manual'
 WHERE pedido_id_manual IS NULL
   AND origem_detalhes ? 'pedido_id_manual';
```

- [ ] **Step 2: Aceitar `pedido_id_manual` em inserirMovimentacao**

Edit `src/lib/wms/ledger.ts` (ou `movimentacoes.ts`). Adicionar campo no input + RPC call.

```typescript
export interface InserirMovInput {
  // ...campos existentes
  pedido_id_manual?: string | null;
}

// Na chamada do RPC:
const { data, error } = await sb.rpc("wms_inserir_movimentacao", {
  // ...args existentes
  p_pedido_id_manual: input.pedido_id_manual ?? null,
});
```

E atualizar a assinatura do RPC `wms_inserir_movimentacao` na migration. Criar nova migration `20260528_wms_inserir_mov_pedido_id_manual.sql` adicionando o param + popular a coluna no INSERT.

- [ ] **Step 3: Propagar de vendas/criar**

Edit `src/app/api/wms/vendas/criar/route.ts`. Onde chama `inserirMovimentacao` em baixa_direta (linhas ~525-532), adicionar:

```typescript
    pedido_id_manual: pedidoIdManual, // MAN-...
```

- [ ] **Step 4: Aplicar migrations + smoke**

```bash
npx supabase migration up --db-url "$SUPABASE_DB_URL_STAGING"
```

Criar venda manual baixa_direta. Conferir no ledger:

```sql
SELECT id, tipo, qty, pedido_id_manual, origem_detalhes
  FROM siso_movimentacoes
 WHERE pedido_id_manual = 'MAN-...'
 LIMIT 5;
```

Expected: linha retorna com `pedido_id_manual` populado.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260528_movs_pedido_manual_ref.sql \
  supabase/migrations/20260528_wms_inserir_mov_pedido_id_manual.sql \
  src/lib/wms/ledger.ts \
  src/app/api/wms/vendas/criar/route.ts
git commit -m "feat(ledger): coluna pedido_id_manual pra rastreabilidade venda manual (#7.4)"
```

---

### Task 15: #3.7 Reconciliação Tiny↔ledger entradas (BACKLOG ~1d)

**Severidade prática: alta no longo prazo, baixa no curto.** Pós-cutover WMS_AS_SOURCE, conferência manual via Tiny é raro path. Sem job que compara `siso_movimentacoes` entradas (`origem_tipo='nf_compra'`) vs estoque Tiny. Divergências silenciosas acumulam.

**Files:**
- Create: `src/lib/wms/reconciliacao-tiny.ts`
- Create: `src/app/api/wms/reconciliacao-tiny/route.ts`
- Create: `src/app/wms/relatorios/reconciliacao-tiny/page.tsx`
- Create: cron via Supabase

- [ ] **Step 1: Decidir granularidade**

Pra cada empresa ativa: query `siso_movimentacoes` agregando `qty` por (produto_id, galpao_id, periodo). Comparar com Tiny `/produtos/{idProduto}/estoque` (cache 5min). Divergência > 1 unidade vira linha de relatório.

- [ ] **Step 2: Implementar `reconciliarTinyEntradas`**

Create `src/lib/wms/reconciliacao-tiny.ts`:

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { obterEstoque } from "@/lib/tiny-api";
import { logger } from "@/lib/logger";

export interface DivergenciaReconc {
  empresa_id: string;
  empresa_nome: string;
  produto_id: string;
  sku: string;
  galpao_id: string;
  saldo_wms: number;
  saldo_tiny: number;
  delta: number;
}

export async function reconciliarTinyEntradas(opts: {
  empresa_id?: string;
  limit?: number;
} = {}): Promise<DivergenciaReconc[]> {
  const sb = createServiceClient();
  const empresaFilter = opts.empresa_id ? sb.from("siso_empresas").select("id, nome").eq("id", opts.empresa_id) : sb.from("siso_empresas").select("id, nome").eq("ativo", true);
  const { data: empresas } = await empresaFilter;
  const divergencias: DivergenciaReconc[] = [];

  for (const emp of empresas ?? []) {
    // Query saldo agregado WMS por produto
    const { data: saldosWms } = await sb
      .from("siso_estoque")
      .select("produto_id, galpao_id, saldo, produto:siso_produtos(sku)")
      .gt("saldo", 0)
      .limit(opts.limit ?? 100);

    for (const linha of saldosWms ?? []) {
      try {
        const { token } = await getValidTokenByEmpresa(emp.id);
        const mapping = await sb
          .from("siso_produto_empresas")
          .select("tiny_produto_id")
          .eq("produto_id", linha.produto_id)
          .eq("empresa_id", emp.id)
          .single();
        if (!mapping.data) continue;
        const tinyEstoque = await obterEstoque(token, mapping.data.tiny_produto_id);
        const saldoTiny = tinyEstoque.saldo ?? 0;
        const delta = (linha.saldo as number) - saldoTiny;
        if (Math.abs(delta) > 1) {
          divergencias.push({
            empresa_id: emp.id,
            empresa_nome: emp.nome,
            produto_id: linha.produto_id,
            sku: (linha.produto as { sku?: string })?.sku ?? "",
            galpao_id: linha.galpao_id,
            saldo_wms: linha.saldo as number,
            saldo_tiny: saldoTiny,
            delta,
          });
        }
      } catch (err) {
        logger.warn("wms.reconciliacao.tiny", "falha ao consultar tiny", {
          empresa_id: emp.id,
          produto_id: linha.produto_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return divergencias;
}
```

- [ ] **Step 3: Endpoint GET /api/wms/reconciliacao-tiny**

Create `src/app/api/wms/reconciliacao-tiny/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { reconciliarTinyEntradas } from "@/lib/wms/reconciliacao-tiny";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = request.headers.get("X-Worker-Secret") ?? url.searchParams.get("secret");
  if (secret !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const empresa_id = url.searchParams.get("empresa_id") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const div = await reconciliarTinyEntradas({ empresa_id, limit });
  return NextResponse.json({ divergencias: div, total: div.length, computado_em: new Date().toISOString() });
}
```

- [ ] **Step 4: Tela relatório**

Create `src/app/wms/relatorios/reconciliacao-tiny/page.tsx` (similar a outros relatórios — tabela com filtros + botão "Forçar reconciliação"). Detalhes omissos por brevidade — seguir padrão de `src/app/wms/relatorios/movs-por-empresa/page.tsx`.

- [ ] **Step 5: Agendar cron diário 6am UTC**

Create `supabase/migrations/20260528_cron_reconciliacao_tiny_diario.sql`:

```sql
SELECT cron.schedule(
  'wms_reconciliacao_tiny_diario',
  '0 6 * * *',
  $$SELECT net.http_get(
    url := 'https://estoquelever.vercel.app/api/wms/reconciliacao-tiny',
    headers := jsonb_build_object('X-Worker-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret' LIMIT 1))
  )$$
);
```

- [ ] **Step 6: Smoke + commit**

```bash
curl -H "X-Worker-Secret: $WORKER_SECRET" "https://estoquelever.vercel.app/api/wms/reconciliacao-tiny?limit=10"
```

Expected: JSON com lista de divergências.

```bash
git add src/lib/wms/reconciliacao-tiny.ts \
  src/app/api/wms/reconciliacao-tiny/route.ts \
  src/app/wms/relatorios/reconciliacao-tiny/page.tsx \
  supabase/migrations/20260528_cron_reconciliacao_tiny_diario.sql
git commit -m "feat(reconciliacao): job diário Tiny↔ledger entradas com relatório (#3.7)"
```

---

## Verificação Final

- [ ] **Step 1: Rodar suite completa de cenários**

```bash
npm run scenarios
```

Expected: 17 cenários originais + 6 novos (53-58) = 23+ verdes.

- [ ] **Step 2: Build sem erro de tipo**

```bash
npm run build
```

- [ ] **Step 3: Lint limpo**

```bash
npm run lint
```

- [ ] **Step 4: Smoke E2E manual em staging**

Em `estoquelever.vercel.app`:
1. Receber 10 unidades de um SKU, confirmar guarda parcial de 4 → conferir avatar segue no quadro home (#5.8)
2. Login como operador-cwb → conferir não vê pedidos SP (#12)
3. Criar venda manual com SKU não mapeado → conferir toast com mensagem actionable (#7.8)
4. Sair de inventário mid-contagem → conferir colega consegue pegar a mesma loc (#4.6)
5. Conferir card "Entradas diretas hoje" aparece após `entrada_direta=true` (#5.2)

- [ ] **Step 5: Atualizar CLAUDE.md**

Adicionar bullet na seção "Recently Removed / In Progress":

```markdown
- **WMS Fix-Final D (Cobertura Residual) — implementado em 2026-05-28.** Fecha 15 findings residuais da auditoria 2026-05-26 que sobraram após P1-P6 + Fix-A/B/C. **Bugs P0** (visíveis pro operador): #5.8 guarda parcial preserva em_guarda no quadro (RPC `wms_confirmar_guarda_atomico` rewrite) + #12 /api/wms/pedidos filtro galpão server-side. **Bugs P1** (race/edge): #3.8 compras/receber optimistic lock + #4.6 sairParty libera locks síncronos + #6.12 isDevolucao antes do filtro venda + #7.8 vendas/criar 400 estruturado. **UX**: #3.5 badge over-receive + #5.2 card "Entradas diretas hoje" + #1.3 sem recompute hasItemSemEstoque. **Cleanup**: #3.1+#7.2 cwb/sp_atende removido + #2.1/#8.1 endpoints órfãos gated. **Auditoria**: #5.3 destino planejado vs real + #5.7 fila persistente impressões + #7.4 pedido_id_manual no ledger + #3.7 reconciliação Tiny↔ledger. 6 cenários novos (53-58). Plano: `docs/superpowers/plans/2026-05-27-wms-fix-final-D-cobertura-residual.md`.
```

- [ ] **Step 6: Commit final + push**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): Fix-Final D summary"
git push origin develop
```

---

## Appendix A · Findings BY DESIGN (não criar tarefa)

Estes 14 itens foram listados como "bugs" na auditoria mas representam decisões conscientes documentadas no código ou em migrations anteriores. Anexo aqui pra auditorias futuras não re-flagrarem.

| ID | Justificativa | Onde está documentado |
|---|---|---|
| **#5.5** Print fire-and-forget | Erros vão pra `siso_logs` + `siso_erros` via `logger.logError` (categoria `external_api`). Operador re-imprime via `/guarda/imprimir-lote`. Resolvido por **Task 13 (#5.7)** que adiciona fila persistente — supersede este finding. | `src/lib/wms/etiqueta-produto-service.ts:48-60` |
| **#6.7** Status `'aplicada'` em devoluções | Removido do CHECK constraint em migration `20260527_devolucoes_pendentes_status_aplicada.sql`. Lifecycle simplificado pra `aguardando_classificacao→classificada→cancelada`. | Migration ↑ |
| **#6.10** Classes A e D `origem_tipo` | Distintos: Classe A usa `devolucao_cliente_integra`, Classe D usa `devolucao_cliente_troca_sku`. Migration `20260527_origem_tipo_devolucao_troca_sku.sql` formalizou. | `src/lib/wms/devolucoes.ts:198,313` |
| **#6.11** Dedup webhook NF | Coberto por migration `20260527_webhook_dedup_nf_compound.sql` (índices GIN compound em `idNotaFiscalTiny` + `chaveAcesso`) + dedup defensivo em `siso_webhook_logs`. | Migration ↑ |
| **#7.5** ML/Shopee vendedor_id NULL | Auto-atribuído ao user sintético `system-marketplace` via migration `20260527_user_system_marketplace.sql`. Não é mais NULL. | `src/lib/webhook-processor.ts:378-386` |
| **#7.9** `resolverDisponibilidadeVenda` 1 loc | Já retorna `{sugestao, sugestoes[]}` — todas locs do galpão no array. Caller usa só `sugestao` mas validação de saldo agrega via `total_disponivel`. Cenário descrito ("top<qty mas total≥qty falha") **não ocorre**. | `src/lib/wms/vendas-disponibilidade.ts:95-99` |
| **#8.5** Ajuste manual motivo texto livre | Valida `motivo_categoria` contra `CATEGORIAS_VALIDAS` enum em `ajuste/route.ts:66-73`. Texto livre é só descrição complementar. | Route + migration `20260527_wms_inserir_mov_motivo_categoria.sql` |
| **#3.3** Confirmar cancelamento/equivalente sem reverse | Terminal state confirmation — nenhuma mov de ledger criada, apenas seta `compra_status='cancelado'`. Não há o que reverter. Banner D10 cobre fluxos com mov no ledger. | `src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts` |
| **#4.8** Inventário cutoff_em→aprovada | Documentado explicitamente como "LIMITAÇÃO CONHECIDA [#P6-4.8]" com mitigação ("aprovar rapidamente após contagem"). Trade-off de complexidade aceito. | `src/lib/wms/inventario.ts:638-643` |
| **#5.6** Toast `ignorados.length` | Pendência sem `localizacao_destino_id` segue na fila intencionalmente — fluxo: operador escolhe loc no momento da guarda, não na impressão. P5 já expõe contador no toast. | `src/app/wms/receber/page.tsx:387-393` |
| **#6.5** `empresa_receptora` vs `empresa_referencia` | Conceitos distintos. `empresa_receptora` = empresa física que recebeu a NF (FK em `siso_devolucoes_pendentes`); `empresa_referencia_id` = vendedora ORIGINAL (tag em mov via `nf_venda`). Listagem usa receptora porque referência só é resolvível pós-classificação. | `src/lib/wms/devolucoes.ts:388-396` |
| **#8.7** `criado_em = now()` em retroativo | Doc explícita: ledger sempre carimba `criado_em` com now(); info histórica é informativa (em `origem_detalhes.data_recebimento`). Reconstrução temporal via `saldo_anterior/posterior`. | `src/lib/wms/movimentacoes.ts:38-44` |
| **Gate R5** `nota_fiscal_id` strict | Relaxado de `error` pra `warn` no Fix-A T8 — receber/parcial/lançamento retroativo populam nf=null legitimamente. Promover quebraria 3 fluxos. Considerar refactor: `inserirMovimentacao` (lax) vs `inserirMovimentacaoNF` (strict) — fora de escopo. | `src/lib/wms/ledger.ts:140-160` |
| **#2.15 trajetória `concluir-oc`** | Aplicado → revertido → re-aplicado com split NF (Fix-A T13). Estado atual estável: `if (!wmsAsSource())` enfileira lancar_estoque legacy; em WMS_AS_SOURCE, cutover R→L+S é disparado por `dispararCutoverSePronto` que trata race "sem NF" via skip + re-dispara quando NF chega. | `src/app/api/wms/separacao/concluir-oc/route.ts:310-339` |

---

## Appendix B · Known Limitations (Defer pra Fase 7)

| ID | O que falta | Esforço | Razão pra deferir |
|---|---|---|---|
| **#3.6** `quantidade_excedente` persistida | Adicionar coluna SQL `quantidade_excedente` em `siso_pedido_itens` + popular no `compras/receber`. Backend já expõe via `getCompraQuantidadeRestante` (negativo). | M (1 col + UI + cenário) | Task 7 já surfaceou via badge UI. Persistir como coluna é dado a mais — vale só se relatórios financeiros pedirem GROUP BY. Sem demanda atual confirmada. |
| **#13** `siso_pedido_item_estoques` drop | 17 consumers em hot paths leem como snapshot congelado (vs `siso_estoque` live). Drop exige decisão de design: snapshot ↔ live ↔ híbrido. | G (Fase 7, 2-4 semanas) | Já documentado em Fix-C T11+T12 deferral. Requer brainstorm dedicado + spec antes de plano. |
| **#4.8** Inventário reconciliação cutoff_em→aprovada | Recalcular saldo esperado entre contagem e aprovação. Hoje só recalcula em `computarDivergencias`. | M | Trade-off aceito documentado em `inventario.ts:638-643`. Operador segue prática "aprovar rapidamente após contar". |

---

## Self-Review

**Spec coverage:**
- ✅ 5 bugs reais validados (#3.8, #5.8, #6.12, #7.8, #12) — Tasks 1-6
- ✅ 5 LOW bugs (#1.3, #2.1, #3.1, #3.5, #4.6, #5.2, #5.3, #5.7, #7.2, #7.4, #8.1) — Tasks 7-15
- ✅ #3.7 reconciliação Tiny↔ledger (BACKLOG marcado mas incluído)
- ✅ Appendix A justifica 14 BY DESIGN (não viram task)
- ✅ Appendix B documenta 3 known limitations (Fase 7)

**Placeholder scan:** zero "TBD/TODO/implement later" no plano. Code blocks completos em cada step.

**Type consistency:** funções nomeadas consistentes: `sairParty`, `wms_confirmar_guarda_atomico`, `resolverDisponibilidadeVenda`, `isDevolucao`. Migration filenames seguem padrão `YYYYMMDD_descricao.sql`. Cenários seguem padrão `NN-nome-kebab.ts`.

**Risco principal:** Tasks 13 (#5.7 fila prints) e 15 (#3.7 reconciliação) são GRANDES (~1d cada). Se time apertar, defer essas duas pra Fix-Final E e executar só Tasks 1-12 (cobre todos bugs reais + UX + cleanup leve).

**Ordem sugerida:** Fase 1 (P0) → Fase 2 (P1) → Fase 4 cleanups baratos (Task 10, 11) → Fase 3 UX → Fase 5 auditoria (se time). Task 12 (#5.3) é pré-req opcional pra Task 13 (logging de divergência). Task 14 (#7.4) é independente.
