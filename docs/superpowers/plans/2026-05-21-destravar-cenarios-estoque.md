# Destravar Cenários de Estoque — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar o mapping `siso_produto_empresas` no harness pra cenários terem estoque visível pelo `tiny-stub`, validar smoke ponta-a-ponta, e iterar nos primeiros cenários até passarem.

**Architecture:** O `tiny-stub` resolve `tiny_produto_id` → `produto_id` interno via `siso_produto_empresas` ao atender `GET /estoque/{tinyProdutoId}`. O harness hoje cria só `siso_produtos` (sem o mapping) e usa `fakeId * 100 + i` como `tiny_produto_id` no payload do webhook — duas falhas: o mapping não existe e o ID não é determinístico em relação ao SKU. Solução: helper puro `tinyProdutoIdFromSku(sku)` (hash determinístico), `criarProduto` insere mapping pras 2 empresas de teste com esse ID, `webhook` helper usa o mesmo ID no payload. Depois, smoke iterativo cenário-a-cenário ajusta gaps restantes.

**Tech Stack:** TypeScript · Supabase (PostgreSQL service role) · vitest · tsx · Next.js dev server

**Spec base:** `docs/superpowers/specs/2026-05-21-sistematica-testes-estoque-design.md`
**Plano anterior:** `docs/superpowers/plans/2026-05-21-sistematica-testes-estoque.md`

---

## Pré-condições

- Worktree `worktree-sistematica-testes-estoque` ativa (já criada no plano anterior).
- 42 commits do plano anterior aplicados.
- `.env.test.local` populado com `NEXT_PUBLIC_SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` de staging (`ehbxpbeijofxtsbezwxd`).
- Migration `wms_truncate_operacional` aplicada em staging.

---

## Fase 1 — Mapping `siso_produto_empresas` no harness

### Task 1.1: Helper puro `tinyProdutoIdFromSku`

**Files:**
- Modify: `scripts/wms/cenarios/_harness/context.ts` (adicionar função interna)

- [ ] **Step 1:** Logo após os imports no topo de `context.ts`, antes de `export function createContext`, adicionar:

```ts
/**
 * Deriva um tiny_produto_id determinístico a partir do SKU.
 * Range: 10_000_000_000 .. 99_999_999_999 (11 dígitos, fora do range Tiny real
 * que geralmente é 9-10 dígitos, e compatível com bigint).
 * Determinístico permite re-rodar cenários e cair sempre no mesmo ID.
 */
function tinyProdutoIdFromSku(sku: string): number {
  let h = 5381;
  for (let i = 0; i < sku.length; i++) {
    h = ((h << 5) + h + sku.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 90_000_000_000 + 10_000_000_000;
}
```

- [ ] **Step 2:** Verificar tsc clean.

Run: `npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --esModuleInterop --skipLibCheck scripts/wms/cenarios/_harness/context.ts`
Expected: nenhum erro.

- [ ] **Step 3:** Commit.

```bash
git add scripts/wms/cenarios/_harness/context.ts
git commit -m "feat(tests): tinyProdutoIdFromSku helper determinístico"
```

### Task 1.2: `criarProduto` insere mapping `siso_produto_empresas`

**Files:**
- Modify: `scripts/wms/cenarios/_harness/context.ts` (função `criarProduto`)

- [ ] **Step 1:** Localizar `async function criarProduto` em `context.ts` (na seção setup helpers). A versão atual é:

```ts
async function criarProduto(p: { sku: string; descricao: string; gtin?: string }): Promise<string> {
  const { data, error } = await sb.from("siso_produtos").insert({
    sku: p.sku,
    descricao: p.descricao,
    gtin: p.gtin ?? null,
    ativo: true,
  }).select("id").single();
  if (error) throw new Error(`criarProduto ${p.sku}: ${error.message}`);
  return p.sku; // identifica por SKU pra leitura no harness
}
```

Substituir por:

```ts
async function criarProduto(p: { sku: string; descricao: string; gtin?: string }): Promise<string> {
  const { data: produto, error } = await sb.from("siso_produtos").insert({
    sku: p.sku,
    descricao: p.descricao,
    gtin: p.gtin ?? null,
    ativo: true,
  }).select("id").single();
  if (error) throw new Error(`criarProduto ${p.sku}: ${error.message}`);

  // Mapping pras 2 empresas de teste — tiny-stub usa isso pra
  // resolver tiny_produto_id → produto_id interno em GET /estoque/{id}
  const tinyId = tinyProdutoIdFromSku(p.sku);
  const { error: mapErr } = await sb.from("siso_produto_empresas").upsert(
    [
      { produto_id: produto.id, empresa_id: staging.empresas.netair.id, tiny_produto_id: tinyId },
      { produto_id: produto.id, empresa_id: staging.empresas.netparts.id, tiny_produto_id: tinyId },
    ],
    { onConflict: "produto_id,empresa_id" },
  );
  if (mapErr) throw new Error(`criarProduto mapping ${p.sku}: ${mapErr.message}`);

  return p.sku;
}
```

- [ ] **Step 2:** Verificar tsc clean.

Run: `npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --esModuleInterop --skipLibCheck scripts/wms/cenarios/_harness/context.ts`
Expected: nenhum erro.

- [ ] **Step 3:** Commit.

```bash
git add scripts/wms/cenarios/_harness/context.ts
git commit -m "feat(tests): criarProduto insere mapping siso_produto_empresas (NetAir + NetParts)"
```

### Task 1.3: `webhook` helper usa `tinyProdutoIdFromSku` no payload

**Files:**
- Modify: `scripts/wms/cenarios/_harness/context.ts` (função `webhook`)

- [ ] **Step 1:** Localizar a função `webhook` em `context.ts`. Dentro do `try { ... }` que faz upsert em `siso_stub_pedidos`, o array `itens` está assim:

```ts
itens: p.items.map((it, i) => ({
  id: fakeId * 10 + i,
  produto: { id: fakeId * 100 + i, codigo: it.sku, descricao: `Produto teste ${it.sku}` },
  quantidade: it.qty,
  valorUnitario: 1,
})),
```

Substituir por:

```ts
itens: p.items.map((it, i) => ({
  id: fakeId * 10 + i,
  produto: { id: tinyProdutoIdFromSku(it.sku), codigo: it.sku, descricao: `Produto teste ${it.sku}` },
  quantidade: it.qty,
  valorUnitario: 1,
})),
```

- [ ] **Step 2:** No mesmo `webhook`, o segundo `itens.map` (no `body` do POST pro endpoint) está assim:

```ts
itens: p.items.map((it, i) => ({
  id: String(fakeId * 10 + i),
  produto: { codigo: it.sku, descricao: it.sku },
  quantidade: it.qty,
})),
```

Substituir por:

```ts
itens: p.items.map((it, i) => ({
  id: String(fakeId * 10 + i),
  produto: { id: String(tinyProdutoIdFromSku(it.sku)), codigo: it.sku, descricao: it.sku },
  quantidade: it.qty,
})),
```

(O `produto.id` no payload do webhook em si não é estritamente necessário — o processor refetch via `getPedido` — mas inclui pra consistência.)

- [ ] **Step 3:** Verificar tsc clean.

Run: `npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --esModuleInterop --skipLibCheck scripts/wms/cenarios/_harness/context.ts`
Expected: nenhum erro.

- [ ] **Step 4:** Commit.

```bash
git add scripts/wms/cenarios/_harness/context.ts
git commit -m "feat(tests): webhook usa tinyProdutoIdFromSku no payload (bate com criarProduto mapping)"
```

---

## Fase 2 — Validar cenário 01 end-to-end

### Task 2.1: Smoke do cenário 01

**Files:** nenhum — só execução

- [ ] **Step 1:** Garantir que nenhum dev server antigo está rodando na porta 3001:

```bash
pkill -f "next dev" 2>&1; sleep 1
```

- [ ] **Step 2:** Rodar cenário 01 isolado:

```bash
npm run scenarios -- --only "01" 2>&1 | tee /tmp/smoke-01.log
```

Expected (sucesso): saída termina com `✅ 01 — Pedido auto-aprovado própria (Xms)` e relatório criado em `scripts/wms/cenarios/reports/<timestamp>-summary.md` com `Pass: 1 · Fail: 0 · Skip: 16`.

- [ ] **Step 3:** Se passou, ler relatório:

```bash
ls -1t scripts/wms/cenarios/reports/*-summary.md | head -1 | xargs cat
```

Confirmar `## Falhas` está vazio.

- [ ] **Step 4:** Se falhou, diagnosticar:
  - Capturar último relatório detalhado: `ls -1t scripts/wms/cenarios/reports/*-detail.json | head -1 | xargs cat | head -50`
  - Inspecionar logs em staging via Supabase MCP: `SELECT level, source, message FROM siso_logs ORDER BY created_at DESC LIMIT 15`
  - Inspecionar erros: `SELECT category, message, stack_trace FROM siso_erros ORDER BY created_at DESC LIMIT 5`

Comum: webhook-processor pode falhar em algum step downstream (ex: aprovação auto não dispara, ou execution worker não roda). Documentar o erro no próximo step.

- [ ] **Step 5:** Não commitar nada aqui — esta task é só validação. Se passar, marca como `[x]` e segue. Se falhar, escalar pro Step 4 ou abrir nova task de correção.

### Task 2.2: Se cenário 01 falhar, corrigir gap descoberto

**Files:** depende do gap

- [ ] **Step 1:** Identificar o ponto de falha pelo relatório + logs. Categorias prováveis:
  - **Endpoint shape mismatch**: payload/response de algum endpoint difere do que harness espera → corrigir helper em `context.ts`
  - **RPC signature mismatch**: RPC esperando outro param → corrigir chamada no helper afetado
  - **Worker não dispara**: `execution-worker` é cron-driven em prod; em dev, pode precisar trigger manual via `POST /api/wms/worker/processar` → adicionar `ctx.triggerWorker()` helper
  - **Status transition incomplete**: pedido fica em status intermediário → `aguardarStatus*` precisa olhar campo diferente

- [ ] **Step 2:** Aplicar correção mínima focada no gap real (não refatorar nada além disso).

- [ ] **Step 3:** Re-rodar Task 2.1 Step 2. Loop até passar ou identificar gap arquitetural (escalar).

- [ ] **Step 4:** Commit com mensagem específica do gap corrigido. Exemplo:

```bash
git add scripts/wms/cenarios/_harness/context.ts
git commit -m "fix(tests): aguardarStatus inclui execução automática do worker pra cenário 01"
```

---

## Fase 3 — Cenários simples (sem dep de webhook complexo)

Cenários que não dependem do pipeline de pedido completo. Devem ser os primeiros a passar após o mapping. Iterar 1 por vez.

### Task 3.1: Smoke cenário 09 (entrada direta)

**Files:** nenhum — só execução

O cenário 09 é o mais simples: `receber({ entrada_direta: true, items: [{ sku, qty: 12, loc_destino: 'A-01-07' }] })` → assert saldo. Não toca webhook nem worker.

- [ ] **Step 1:** Rodar:

```bash
pkill -f "next dev" 2>&1; sleep 1
npm run scenarios -- --only "09" 2>&1 | tee /tmp/smoke-09.log
```

Expected: `✅ 09 — Entrada direta`.

- [ ] **Step 2:** Se falhar, diagnosticar (provavelmente shape do POST `/api/wms/receber`). Ler relatório + corrigir helper `receber` em `context.ts`.

- [ ] **Step 3:** Se passar, sem commit. Senão commit com fix específico.

### Task 3.2: Smoke cenário 17 (ajuste manual)

**Files:** nenhum — só execução

Cenário 17: `ajusteManual({ delta: +3, motivo })` + `ajusteManual({ delta: -2, motivo })` → assert saldo + observações.

- [ ] **Step 1:** Rodar:

```bash
pkill -f "next dev" 2>&1; sleep 1
npm run scenarios -- --only "17" 2>&1 | tee /tmp/smoke-17.log
```

Expected: `✅ 17 — Ajuste manual com motivo`.

- [ ] **Step 2:** Se falhar, provável gap: endpoint `/api/wms/ajuste` espera body diferente (`motivo` vs `observacoes`, ou parâmetro adicional). Corrigir helper `ajusteManual` em `context.ts`.

- [ ] **Step 3:** Se passar, sem commit. Senão commit do fix.

### Task 3.3: Smoke cenário 14 (replenishment)

**Files:** nenhum — só execução

Cenário 14: `replenishment({ origem_loc, destino_loc, qty })` → assert saldo dividido + par S+E + custo médio inalterado (invariantes pegam).

- [ ] **Step 1:** Rodar:

```bash
pkill -f "next dev" 2>&1; sleep 1
npm run scenarios -- --only "14" 2>&1 | tee /tmp/smoke-14.log
```

Expected: `✅ 14 — Replenishment intra-galpão`.

- [ ] **Step 2:** Se falhar, gap provável em `/api/wms/replenishment` payload shape. Corrigir helper.

- [ ] **Step 3:** Se passar, sem commit.

### Task 3.4: Smoke cenário 07 (reservas TTL)

**Files:** nenhum — só execução

Cenário 07: reserva atômica + tentativa de exceder (deve falhar) + esperar 3s + cleanup → `assertReservado=0`. Exercita RPC direto e endpoint de cleanup.

- [ ] **Step 1:** Rodar:

```bash
pkill -f "next dev" 2>&1; sleep 1
npm run scenarios -- --only "07" 2>&1 | tee /tmp/smoke-07.log
```

Expected: `✅ 07 — Reservas TTL + cleanup`.

- [ ] **Step 2:** Se falhar, gap provável:
  - Cleanup endpoint exige header `x-worker-secret` (já em `.env.test`) — se não funciona, helper `cleanupReservas` precisa enviar via http client com header explícito.
  - TTL=2s pode ter floor pra 0 inteiro no RPC. Aumentar pra ttl_horas=0.01 (~36s) e `aguardar(2000)` no cenário.

- [ ] **Step 3:** Corrigir se necessário, commit do fix.

### Task 3.5: Commit consolidado dos fixes da Fase 3

**Files:** depende dos fixes

- [ ] **Step 1:** Se acumulou múltiplas correções pequenas, consolidar em um único commit explicativo. Exemplo:

```bash
git add scripts/wms/cenarios/_harness/context.ts
git commit -m "fix(tests): ajusta payload shape de /api/wms/{ajuste,replenishment,reservas}"
```

(Pular esta task se cada smoke da Fase 3 já gerou seu próprio commit ou se nenhum precisou de fix.)

---

## Fase 4 — Suite completa e relatório consolidado

### Task 4.1: Suite completa

**Files:** nenhum — só execução

- [ ] **Step 1:** Garantir dev server limpo:

```bash
pkill -f "next dev" 2>&1; sleep 1
```

- [ ] **Step 2:** Rodar todos os 17 cenários:

```bash
npm run scenarios 2>&1 | tee /tmp/smoke-completo.log
```

Expected: relatório markdown criado em `scripts/wms/cenarios/reports/<timestamp>-summary.md` com totais.

- [ ] **Step 3:** Inspecionar relatório:

```bash
ls -1t scripts/wms/cenarios/reports/*-summary.md | head -1 | xargs cat
```

Anotar: quantos pass / fail / skip; quais cenários falharam e por qual motivo (assert vs invariante).

- [ ] **Step 4:** Não commitar nada. Resultado da suite vai no smoke report (Task 4.2).

### Task 4.2: Smoke report consolidado

**Files:**
- Create: `docs/superpowers/smoke-2026-05-21-cenarios-estoque.md`

- [ ] **Step 1:** Criar arquivo com este formato:

```markdown
# Smoke da Sistemática de Testes de Estoque — 2026-05-21

**Branch:** `worktree-sistematica-testes-estoque`
**Plano:** `docs/superpowers/plans/2026-05-21-destravar-cenarios-estoque.md`

## Resultado da suite completa

(copiar/colar conteúdo de `scripts/wms/cenarios/reports/<timestamp>-summary.md` que foi gerado)

## Cenários passando

(lista dos ✅)

## Cenários falhando — triagem

Pra cada ❌, anotar:

### NN — nome do cenário
- **Motivo:** assert | invariante | timeout
- **Erro:** mensagem exata
- **Hipótese de causa:** endpoint shape mismatch / lógica de aprovação automática / etc.
- **Próximo passo sugerido:** "corrigir helper X" ou "ajustar API Y" ou "remover do catálogo (cenário inviável)"

## Conclusão

(parágrafo curto: percentual de cobertura alcançada, próximos gaps prioritários, decisão sobre merge da branch)
```

- [ ] **Step 2:** Preencher com dados reais da Task 4.1.

- [ ] **Step 3:** Commit.

```bash
git add docs/superpowers/smoke-2026-05-21-cenarios-estoque.md
git commit -m "docs(tests): smoke report 2026-05-21 — cenários da pirâmide de testes"
```

---

## Fase 5 — Decisão final

### Task 5.1: Decidir merge vs follow-up

**Files:** nenhum — só decisão

- [ ] **Step 1:** Com base no smoke report, avaliar:
  - **≥80% dos cenários passando**: branch está pronta pra merge em `develop`. Abrir PR (ou merge direto se autônomo).
  - **50-80%**: branch é mergeável mas com follow-ups documentados no smoke report. Abrir PR com checklist dos próximos gaps.
  - **<50%**: parar e escalar. A arquitetura do harness pode precisar de revisão (provavelmente algum endpoint chave precisa adaptador).

- [ ] **Step 2:** Atualizar `CLAUDE.md` (já tem bullet sobre a sistemática) com status real:
  - Substituir "implementada" por "implementada — X/17 cenários passando, follow-ups em smoke-2026-05-21".
  - Apontar pro smoke report.

- [ ] **Step 3:** Commit final.

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md reflete status do smoke (X/17 cenários)"
```

- [ ] **Step 4:** Se merge: abrir PR pro `develop`.

```bash
gh pr create --base develop --title "Sistemática de testes de estoque (3 camadas + 17 cenários)" --body "$(cat <<'PR_BODY'
## Summary
- Pirâmide de testes 3 camadas (unit + integration + scenarios)
- 17 cenários ponta-a-ponta via HTTP em `/api/wms/*`
- 7 invariantes globais property-based ao fim de cada cenário
- Stubs PrintNode + ML (Tiny reaproveita existente)
- Migration `wms_truncate_operacional`
- Smoke report: ver `docs/superpowers/smoke-2026-05-21-cenarios-estoque.md`

## Test plan
- [x] Camada 1 (unit): `npm test` — 125 passa, 1 falha pré-existente
- [x] Camada 2 (integration): `npm run test:integration` — 9/10 passa
- [x] Camada 3 (scenarios): `npm run scenarios` — X/17 passa (ver smoke report)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PR_BODY
)"
```

---

## Self-Review

**Spec coverage:** O plano cobre o gap identificado no smoke do plano anterior (mapping `siso_produto_empresas`) e prevê iteração pra cenários simples + relatório final. Nenhuma seção do design spec original fica sem cobertura — o que falta é especificamente a camada de runtime adjustment que sempre aparece em primeira execução.

**Placeholder scan:** Nenhum "TBD", "TODO", "implement later". Cada task ou tem código completo ou descreve uma decisão concreta (Task 5.1 Step 1 tem critérios numéricos pra escolha).

**Type consistency:** `tinyProdutoIdFromSku` retorna `number`; consumidores (`criarProduto`, `webhook`) usam o número direto. `siso_produto_empresas.tiny_produto_id` é `bigint` no schema, JS `number` é compatível até 2^53-1 — meu range de 11 dígitos (até ~10^11) está bem dentro.

**Scope:** Plano é focado e curto. Sem decomposição necessária — é um único objetivo (destravar cenários) com fases lógicas (mapping → smoke individual → smoke completo → decisão).
