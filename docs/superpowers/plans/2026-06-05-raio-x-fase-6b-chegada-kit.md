# Raio-X Fase 6b — Validação na chegada do pedido + kit sem cadastro Tiny Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal**
Endurecer a porta de entrada do pedido (webhook → `processWebhookWms`) e a sincronização de kits para nunca aceitar quantidades inválidas nem perder componentes silenciosamente:

- **P001** — Rejeitar o pedido inteiro na CHEGADA quando qualquer item tem `quantidade <= 0`, nomeando o item errado no log e em `siso_webhook_logs` (status `rejeitado`), **sem** gravar `siso_pedidos` nem criar reservas. Hoje o item de qty=0 passa pela entrada e só estoura tarde, em `ledger.ts:46` (`qty deve ser > 0`), travando o pedido inteiro sem dizer qual item é o culpado.
- **P002** — Componente de kit sem mapeamento Tiny na empresa origem **não pode ser dropado** (`continue` em `webhook-processor-wms.ts:239-246`). Em vez disso o componente entra no pedido com `produto_id_wms` (uuid WMS), `produto_id_tiny=null` e flag `sem_cadastro_tiny=true`. Decisão custom do dono: **NÃO rejeitar** (a `nota` vence a `question`); mostrar TODOS os itens do kit; preferir baixa manual a enviar incompleto; **NÃO** tornar a chave única nullable.
- **P095** — Adicionar um filtro "Sem mapeamento Tiny" na aba de produtos (`listarProdutos`), para o operador achar e completar produtos sem nenhuma linha em `siso_produto_empresas`. Mesma família de P002; o comportamento de sync best-effort (cai todo mundo) já existe — o entregável central é o FILTRO.

**Architecture**
- O caminho de entrada real é `src/lib/webhook-processor.ts → processWebhook()` que delega para `src/lib/webhook-processor-wms.ts → processWebhookWms()`. `processWebhook` engole qualquer `throw` em `siso_webhook_logs.status='erro'`. P001 NÃO pode usar `throw` (viraria `erro` genérico + retry); usa **early-return com rejeição explícita** (status `rejeitado` + `erro` nomeando o item) antes de qualquer escrita de `siso_pedidos`.
- `siso_pedido_itens` carrega a semântica legada onde `produto_id = tiny_produto_id` (gotcha #1) e o upsert usa `onConflict: "pedido_id,produto_id"`. Para tolerar componente sem tiny sem tornar `produto_id` nullable, a migration adiciona `produto_id_wms uuid` + `sem_cadastro_tiny boolean` e um índice único parcial `(pedido_id, produto_id_wms)` para os itens flagueados; o caminho normal continua usando `(pedido_id, produto_id)`. A migration troca `produto_id` de `bigint` → `text` (carrega tiny id como texto OU uuid WMS) — gotcha #2: uma troca de tipo nessa família já quebrou callers antes, então a Task 1.2 Step 0 audita TODOS os consumidores de `siso_pedido_itens.produto_id` e a Task 1.3 corrige o único caller quebrado (`aprovar/route.ts:235`, que fazia `Number(produto_id)` → `NaN` com o uuid e dropava o componente sem-tiny no roteamento de transferência).
- A expansão de kit em `expandirKits()` é DB-pesada (lê `siso_produto_kits` + `siso_produto_empresas`). A decisão "flag em vez de drop" é extraída para uma função **pura** `montarLinhaComponente()` testável por unit, e `expandirKits` passa a chamá-la (sem mais `continue`).
- `listarProdutos` ganha um filtro `sem_mapeamento` via `NOT EXISTS (siso_produto_empresas)`. Rota e página repassam o novo parâmetro.

**Tech Stack**
- Next.js 16 (App Router) · TypeScript strict · Supabase (`createServiceClient`, service role).
- Testes: vitest unit (`npm test -- <arquivo>`, `src/**/*.test.ts`), scenarios E2E HTTP (`npm run scenarios`, `scripts/wms/cenarios/catalogo/NN-*.ts`).
- Migration: arquivo em `supabase/migrations/YYYYMMDD_*.sql` + aplicar via `mcp__supabase__apply_migration` no project **`ehbxpbeijofxtsbezwxd`** (staging).

> Ordem de tasks: P001 (sem dep, quick, isola a porta de entrada) → migration P002 → código P002 (depende da migration + P095 da família) → frontend P002 → P095 (sem dep, fecha a família). P002 declara `deps:["P095"]` no achado mas a dependência real é conceitual (mesma família "todos caem"); a migration de P002 não depende de P095, então P095 fica por último como fecho independente.

---

## PR 1: Validar pedido na chegada (qty=0 rejeita) + kit sem cadastro Tiny (flag, não dropar) [P001, P002, P095]

### Task 1.1: Rejeitar pedido na chegada quando algum item tem quantidade <= 0 (P001)

**Files**
- Modify `src/lib/webhook-processor-wms.ts:375-392` — widen return type + guard qty<=0 após `resolverItensWms()`.
- Test (Create) `scripts/wms/cenarios/catalogo/82-webhook-rejeita-item-qty-zero.ts`

**Contexto ancorado (código atual):**
- `processWebhookWms` (linha 375) declara retorno `Promise<{ ok: boolean; pedidoId: string; status: string; sugestao: LegacyDecisao }>`.
- Linha 385: `const itensResolvidos = await resolverItensWms(pedido, empresaOrigemId);`
- Linhas 386-392 já contêm um bloco que filtra `semMapeamento` e loga warn — a guarda de qty entra **logo após** esse bloco, antes do roteamento (linha 394).
- `resolverItensWms` preserva `quantidade: item.quantidade` cru do Tiny (linha 93); nenhuma checagem de qty hoje.
- `LegacyDecisao = "propria" | "transferencia" | "oc"` (linha 33). A rejeição não tem sugestão real; o tipo de retorno passa a aceitar `sugestao: LegacyDecisao | null`.
- O helper de cenário `ctx.webhook(...)` (em `scripts/wms/cenarios/_harness/types.ts`) aceita `items: { sku: string; qty: number }[]` — passar `qty: 0` no item.

**Steps**

- [ ] **Step 1 — Escrever o teste que FALHA.** Criar `scripts/wms/cenarios/catalogo/82-webhook-rejeita-item-qty-zero.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 82 — P001: webhook com item qty=0 é rejeitado na CHEGADA.
 *
 * Pedido com um item de quantidade 0 (vindo do Tiny) NÃO pode ser gravado em
 * siso_pedidos nem gerar reservas. O webhook_log deve ficar status='rejeitado'
 * e o campo `erro` deve nomear o sku/item com qty inválida.
 *
 * Hoje falha: o pedido é aceito, roteado e só estoura em ledger.ts:46
 * (qty deve ser > 0), travando o pedido inteiro sem identificar o item.
 */

type Setup = {
  sku: string;
  pedidoFakeId: number;
};

export default {
  nome: "82 — P001: webhook rejeita item com quantidade=0 na chegada",
  descricao:
    "Pedido com item qty=0 deve ser rejeitado na entrada (processWebhookWms): " +
    "siso_pedidos NÃO gravado, sem reservas, webhook_log status='rejeitado' " +
    "com erro nomeando o sku.",
  tags: ["webhook", "validacao", "qty-zero", "p001", "chegada"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("82");
    await ctx.criarProduto({ sku, descricao: "Item qty zero 82" });
    return { sku, pedidoFakeId: 82_000_000 + Math.floor(Date.now() / 1000) % 999_999 };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku, pedidoFakeId } = setup;
    await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 0 }],
      pedidoFakeId,
    });
    // Dá tempo do processamento async correr e gravar o webhook_log.
    await ctx.aguardar(3000);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku, pedidoFakeId } = setup;
    const pedidoId = String(pedidoFakeId);

    // 1. siso_pedidos NÃO foi gravado.
    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("id")
      .eq("id", pedidoId)
      .maybeSingle();
    if (pedido) {
      throw new Error(
        `P001 falhou: pedido ${pedidoId} foi gravado em siso_pedidos apesar do item qty=0.`,
      );
    }

    // 2. Nenhuma reserva R viva para o pedido.
    const { data: reservas } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("pedido_id", pedidoId)
      .eq("tipo", "R");
    if ((reservas ?? []).length > 0) {
      throw new Error(`P001 falhou: ${reservas!.length} reserva(s) criada(s) para item qty=0.`);
    }

    // 3. webhook_log com status='rejeitado' e erro nomeando o sku.
    //    A coluna de referência do pedido no siso_webhook_logs é `tiny_pedido_id`
    //    (ver insert em src/app/api/wms/webhook/tiny/route.ts:154).
    const { data: logs } = await ctx.sb
      .from("siso_webhook_logs")
      .select("status, erro")
      .eq("tiny_pedido_id", pedidoId);
    const log = (logs ?? []).find((l) => (l as { status: string }).status === "rejeitado")
      ?? (logs ?? [])[0];
    if (!log) throw new Error(`P001 falhou: nenhum webhook_log para pedido ${pedidoId}.`);
    if ((log as { status: string }).status !== "rejeitado") {
      throw new Error(
        `P001 falhou: webhook_log.status='${(log as { status: string }).status}', esperado 'rejeitado'.`,
      );
    }
    if (!(log as { erro: string | null }).erro?.includes(sku)) {
      throw new Error(
        `P001 falhou: webhook_log.erro não nomeia o sku '${sku}'. erro='${(log as { erro: string | null }).erro}'`,
      );
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
const _isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

> Nota de padrão (verificado): este bloco `runStandalone`/`_isMain` APÓS o `export default {...} satisfies Cenario<Setup>` é **idêntico** ao que `80-reconciliador-saldo-oc.ts` e `81-receber-oc-destrava-pedido.ts` já trazem no fim do arquivo (mesmo comentário, mesmo `import(import.meta.url)`). NÃO é divergência de padrão — o runner (`run-all.ts:153-154`) importa `mod.default` normalmente; o `import(import.meta.url)` só serve ao modo standalone `tsx <arquivo>` (não usado pelo `npm run scenarios`, que descobre via `readdir`). Mantido por consistência com 80/81.

> Nota (verificado no código): a coluna de referência do pedido em `siso_webhook_logs` é `tiny_pedido_id` (insert em `src/app/api/wms/webhook/tiny/route.ts:154`). O assert usa essa coluna.
>
> Nota (verificado — `status` aceita `'rejeitado'`): `siso_webhook_logs.status` é `text NOT NULL DEFAULT 'pendente'` **sem CHECK constraint**. Grep em `supabase/migrations/` por CHECK na coluna `status` só acha constraints de OUTRAS tabelas (`siso_inventario_sessoes`, `siso_fila_execucao` em `20260309_create_execution_queue.sql:27` e `20260323_modulo_inventario_transferencia.sql`); nenhuma toca `siso_webhook_logs`. A tabela nasce do schema inicial (pré-migrations) e o código já grava valores livres na coluna: `processWebhookWms` escreve `status:"concluido"` (webhook-processor-wms.ts:641) e `webhook-processor.ts` escreve `"processando"` (:41), `"ignorado"` (:82) e `"erro"` (:103). Logo `'rejeitado'` é um novo valor textual seguro — não há constraint que o rejeite.

- [ ] **Step 2 — RODAR e ver FALHAR.**
  ```
  npm run scenarios:only 82
  ```
  > ⚠️ Flag correta verificada no runner: `scripts/wms/cenarios/run-all.ts:22` parseia **`--only`** (e `filterMatches` na :32 faz `c.nome.includes(args.only)`). `:only` (rótulo citado no CLAUDE.md) **não** existe no código — `npm run scenarios -- :only 82` deixaria `args.only` undefined e rodaria a SUITE INTEIRA sem isolar o 82. Use `npm run scenarios:only 82` (alias em `package.json:20` = `run-all.ts --only`) ou, equivalente, `npm run scenarios -- --only 82`.
  >
  > Expected: **FAIL** — hoje o pedido qty=0 é gravado em `siso_pedidos` (assert 1 dispara) OU o webhook_log fica `erro`/`concluido` em vez de `rejeitado`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/webhook-processor-wms.ts`:

  3a. Widen o tipo de retorno (linha 375-380):
  ```ts
  export async function processWebhookWms(input: ProcessWebhookWmsInput): Promise<{
    ok: boolean;
    pedidoId: string;
    status: string;
    sugestao: LegacyDecisao | null;
  }> {
  ```

  3b. Inserir a guarda logo após o bloco `semMapeamento` (depois da linha 392, antes do comentário `// 3. Roteamento`):
  ```ts
    // 2b. [P001] Guarda de pré-voo: rejeitar o pedido INTEIRO na chegada se
    //     qualquer item tem quantidade <= 0 (vinda do Tiny). Nada de gravar
    //     siso_pedidos nem reservar — o operador precisa saber QUAL item está
    //     errado. ledger.ts:46 só pegaria isso tarde, travando o pedido sem
    //     identificar o culpado.
    const itensQtyInvalida = itensResolvidos.filter((i) => !(i.quantidade > 0));
    if (itensQtyInvalida.length > 0) {
      const detalhe = itensQtyInvalida
        .map((i) => `${i.sku || `tiny:${i.tinyProdutoId}`} (qty=${i.quantidade})`)
        .join(", ");
      const msg = `Pedido rejeitado: item(ns) com quantidade inválida — ${detalhe}`;
      logger.warn("processor.wms", "pedido rejeitado na chegada — item com qty<=0", {
        pedidoId: pedido.id,
        itens: itensQtyInvalida.map((i) => ({ sku: i.sku, tinyProdutoId: i.tinyProdutoId, qty: i.quantidade })),
      });
      await sb
        .from("siso_webhook_logs")
        .update({
          status: "rejeitado",
          empresa_id: empresaOrigemId,
          erro: msg,
          processado_em: new Date().toISOString(),
        })
        .eq("id", webhookLogId);
      return { ok: false, pedidoId: pedido.id, status: "rejeitado", sugestao: null };
    }
  ```

- [ ] **Step 4 — RODAR e ver PASSAR.**
  ```
  npm run scenarios:only 82
  ```
  Expected: **PASS** — pedido não gravado, sem reservas, webhook_log `rejeitado` nomeando o sku.
  Rodar typecheck do harness: `npx tsc --noEmit` (garante que o widen do retorno não quebra callers).

- [ ] **Step 5 — COMMIT.**
  ```
  git add src/lib/webhook-processor-wms.ts scripts/wms/cenarios/catalogo/82-webhook-rejeita-item-qty-zero.ts
  git commit -m "fix(wms): rejeita pedido na chegada quando item tem qty<=0 (P001)

  Guarda de pré-voo em processWebhookWms: se qualquer item vem com
  quantidade<=0 do Tiny, rejeita o pedido inteiro (webhook_log status
  rejeitado nomeando o sku), sem gravar siso_pedidos nem reservar.
  Antes só estourava tarde em ledger.ts:46 sem identificar o item.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 6 — erros-conhecidos.yaml.** Grep `qty=0` / `quantidade inválida` antes; adicionar entrada:
  ```yaml
  - id: P001
    date: 2026-06-05
    source: raio-x fase 6b
    category: validation
    message: "Pedido com item de quantidade 0 entrava e só travava tarde no ledger"
    cause: "processWebhookWms não validava quantidade na chegada; item qty=0 era roteado e só estourava em ledger.ts:46 (qty deve ser > 0), travando o pedido inteiro sem nomear o item"
    fix: "Guarda de pré-voo após resolverItensWms: rejeita o pedido inteiro (webhook_log status=rejeitado + erro nomeando sku), sem gravar siso_pedidos nem reservar"
    files:
      - src/lib/webhook-processor-wms.ts
      - scripts/wms/cenarios/catalogo/82-webhook-rejeita-item-qty-zero.ts
    tags: [webhook, validacao, chegada, qty-zero, preflight]
  ```

---

### Task 1.2: Migration — colunas produto_id_wms + sem_cadastro_tiny em siso_pedido_itens (P002)

**Files**
- Create `supabase/migrations/20260605_pedido_itens_produto_wms_sem_cadastro.sql`
- Aplicar via `mcp__supabase__apply_migration` (project `ehbxpbeijofxtsbezwxd`).
- Test (a corretude do índice parcial como **backstop** é exercitada pela Task 1.3 via integration test `test/integration/pedido-itens-sem-tiny.test.ts`, que grava o componente sem-tiny 2x e prova idempotência por `(pedido_id, produto_id_wms)`).

**Contexto ancorado (código atual):**
- `siso_pedido_itens` tem hoje `produto_id` (NOT NULL, = `tiny_produto_id`) e `produto_id_tiny`; o upsert em `webhook-processor-wms.ts:540-560` usa `onConflict: "pedido_id,produto_id"`.
- O grep nas migrations não acha o índice único `(pedido_id, produto_id)` — ele vem do schema inicial pré-migrations. A migration NÃO mexe nesse índice; só ADICIONA colunas + um índice único parcial novo para os itens flagueados (`produto_id_tiny IS NULL`).
- `siso_produtos.id` é o uuid WMS alvo do FK.

> ⚠️ **O índice único parcial é BACKSTOP de banco, NÃO o conflict-target do upsert.** PostgREST/supabase-js mapeia `onConflict=cols` para `ON CONFLICT (cols)` e **não suporta o predicado de índice parcial** (`WHERE …`) — usar o índice parcial como `onConflict` falharia com `there is no unique or exclusion constraint matching the ON CONFLICT specification`. Verificado: **todos** os 15 `onConflict` do repo (grep) apontam para índices/constraints TOTAIS, nunca parciais. Por isso a Task 1.3 grava o componente sem-tiny via **delete-then-insert** por `(pedido_id, produto_id_wms)` (idempotente sem depender de inferência de índice parcial); o índice parcial só garante, no nível do banco, que uma re-entrega concorrente não duplique o componente (23505 = corrida perdida, tratada como no-op). Itens COM tiny continuam no caminho `onConflict: "pedido_id,produto_id"` (índice total legado, funciona hoje).

**Steps**

- [ ] **Step 0 — Auditar TODOS os callers de `siso_pedido_itens.produto_id` antes de trocar o tipo (gotcha #2).** O CLAUDE.md (gotcha #2) avisa: uma troca de tipo nessa família já quebrou todos os callers de `wms_reservar_atomico`. `bigint → text` é tolerante na LEITURA (supabase-js já serializa bigint como string; o TS `PedidoItem.produto_id` já é `string`), mas QUEBRA qualquer caller que faça `Number(produto_id)` ou casteie pra inteiro — pior ainda depois da Task 1.3, que grava um **uuid** em `produto_id` pros itens sem-tiny (`Number(uuid) = NaN`). Varrer e classificar:
  ```bash
  # 1. Casts numéricos sobre produto_id (os que QUEBRAM com uuid):
  grep -rnE "Number\([^)]*produto_id|parseInt\([^)]*produto_id|::bigint|::int" src/ scripts/
  # 2. Joins/filtros SQL que assumem inteiro:
  grep -rnE "produto_id::int|produto_id::bigint" src/ scripts/ supabase/
  ```
  Resultado verificado nesta auditoria (snapshot 2026-06-05):
  - `src/app/api/wms/pedidos/aprovar/route.ts:235` → `.eq("tiny_produto_id", Number(it.produto_id))` sobre `siso_pedido_itens.produto_id`. **QUEBRA** com o uuid sem-tiny (`Number(uuid)=NaN` → lookup vazio → componente sem-tiny silenciosamente dropado do array `itens` em `rotearPedidoDoBanco` na aprovação OC/transferência). **Corrigido na Task 1.3 Step 3f** (mesma classe do gotcha #2; é consequência direta desta migration + da Task 1.3).
  - `src/app/api/wms/pedidos/aprovar/route.ts:521-524` (`criarReservasPedido`) → usa `String(item.produto_id)` (linha 523). **Seguro** (passa a string crua pro resolver; tiny continua resolvendo, sem-tiny não tem mapeamento e cai no rollback `sem_saldo`/`mapeamento_ausente` — comportamento esperado, sem NaN).
  - `src/app/wms/separacao/checklist/page.tsx:629` → `Number(produto.produto_id)` mas no fluxo de **localização de item OC** (o `produto` vem sempre com mapeamento Tiny; itens sem-tiny são componentes de kit, não itens OC). **Não afetado** pela troca; mencionar, não tocar (mudança cirúrgica — fora do escopo de P002).
  - Demais hits de `Number(...produto_id)` (`vendas/criar:206`, `webhook-processor-wms:74/211`, `sync-tiny:151`, `varredura-validacao-oc:32`) operam sobre `tiny_produto_id` de `siso_produto_empresas`, **não** sobre `siso_pedido_itens.produto_id`. **Seguros.**
  > Se a varredura achar um caller NOVO (commits posteriores ao snapshot) que casteie `siso_pedido_itens.produto_id` pra inteiro, tratá-lo na Task 1.3 (mesmo padrão do 3f) ANTES de aplicar a migration — não deixar passar.

- [ ] **Step 1 — Escrever a migration (SQL completo).** Criar `supabase/migrations/20260605_pedido_itens_produto_wms_sem_cadastro.sql`:

> ⚠️ **`siso_pedido_itens.produto_id` é `bigint NOT NULL` (VERIFICADO), não text.** Evidências: a migration `20260530_wms_detectar_pedidos_inconsistentes.sql:31` faz `i.produto_id::text` (só se casta `::text` se a coluna NÃO for text já); o upsert atual grava `produto_id: item.tinyProdutoId` (number JS); o doc `database-schema.md` lista `produto_id | bigint | NO`. O TS `PedidoItem.produto_id: string` é só a serialização de bigint pelo supabase-js na leitura. Um **uuid não cabe em bigint** — por isso, pra carregar o uuid WMS no componente sem-tiny SEM tornar `produto_id` nullable (a nota proíbe: *"NÃO tornar a chave nullable"*), a migration **altera `produto_id` de `bigint` para `text`** (preserva NOT NULL). Assim ele carrega o tiny id como texto quando existe, e o uuid WMS quando não há tiny. Baixo risco: a coluna já é LIDA como string no TS e há `::text` espalhado no código; a unique `(pedido_id, produto_id)` é rebuildada automaticamente na troca de tipo.

```sql
-- [P002] Componente de kit sem mapeamento Tiny na empresa origem não pode ser
-- dropado. Para gravá-lo precisamos de um id interno estável (uuid WMS) e de
-- uma flag visível. NÃO tornamos produto_id nullable (decisão do dono): ele
-- continua NOT NULL — passa a ser TEXT pra carregar o tiny id (como texto)
-- quando existe, ou o uuid WMS quando o componente não tem mapeamento Tiny.

-- 1. produto_id bigint → text (mantém NOT NULL; a unique (pedido_id, produto_id)
--    é recriada automaticamente pelo Postgres na troca de tipo).
ALTER TABLE siso_pedido_itens
  ALTER COLUMN produto_id TYPE text USING produto_id::text;

-- 2. Colunas novas: uuid WMS interno + flag de visibilidade.
ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS produto_id_wms uuid REFERENCES siso_produtos(id),
  ADD COLUMN IF NOT EXISTS sem_cadastro_tiny boolean NOT NULL DEFAULT false;

-- 3. Acesso por uuid WMS (UI / resolução reversa do componente).
CREATE INDEX IF NOT EXISTS idx_pedido_itens_produto_wms
  ON siso_pedido_itens (produto_id_wms)
  WHERE produto_id_wms IS NOT NULL;

-- 4. Chave única (BACKSTOP) para itens SEM tiny (componente flagueado): impede
--    duplicar o componente numa re-entrega concorrente de webhook. NÃO é o
--    conflict-target do upsert (PostgREST não infere predicado de índice
--    parcial) — o caminho de gravação usa delete-then-insert (Task 1.3). O
--    caminho normal (com tiny) continua usando a unique legada (pedido_id, produto_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedido_itens_pedido_produto_wms_sem_tiny
  ON siso_pedido_itens (pedido_id, produto_id_wms)
  WHERE produto_id_tiny IS NULL AND produto_id_wms IS NOT NULL;

COMMENT ON COLUMN siso_pedido_itens.produto_id IS
  'Id do item. TEXT: carrega o tiny_produto_id (como texto) quando há mapeamento; carrega o uuid WMS (produto_id_wms) quando o componente não tem cadastro Tiny. NOT NULL — nunca nullable.';
COMMENT ON COLUMN siso_pedido_itens.produto_id_wms IS
  'uuid de siso_produtos. Preenchido sempre que o produto WMS é conhecido. Usado como chave de desambiguação quando produto_id_tiny é null (componente sem cadastro Tiny).';
COMMENT ON COLUMN siso_pedido_itens.sem_cadastro_tiny IS
  'true quando o item (tipicamente componente de kit) não tem mapeamento em siso_produto_empresas na empresa origem. Item entra mesmo assim — baixa manual preferida a enviar incompleto (P002).';
```

- [ ] **Step 2 — Aplicar a migration.** Via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`:
  - `name`: `20260605_pedido_itens_produto_wms_sem_cadastro`
  - `query`: conteúdo do arquivo acima.
  Verificar com `mcp__supabase__execute_sql`:
  ```sql
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name='siso_pedido_itens'
    AND column_name IN ('produto_id','produto_id_wms','sem_cadastro_tiny');
  ```
  Expected: 3 linhas — `produto_id text NO`, `produto_id_wms uuid YES`, `sem_cadastro_tiny boolean NO DEFAULT false`.
  Confirmar que a unique legada sobreviveu à troca de tipo:
  ```sql
  SELECT indexname FROM pg_indexes
  WHERE tablename='siso_pedido_itens' AND indexdef ILIKE '%(pedido_id, produto_id)%';
  ```
  Expected: 1 linha (o índice único legado `(pedido_id, produto_id)` continua existindo).

- [ ] **Step 3 — Atualizar docs.** Adicionar as 2 colunas em `docs/database-schema.md` (seção `siso_pedido_itens`) no mesmo commit.

- [ ] **Step 4 — COMMIT.**
  ```
  git add supabase/migrations/20260605_pedido_itens_produto_wms_sem_cadastro.sql docs/database-schema.md
  git commit -m "feat(wms): produto_id→text + colunas produto_id_wms/sem_cadastro_tiny em siso_pedido_itens (P002)

  Permite gravar componente de kit sem mapeamento Tiny sem dropar nem tornar
  produto_id nullable. produto_id vira text (carrega tiny id como texto ou uuid
  WMS); índice único parcial é backstop pra desambiguar (pedido_id, produto_id_wms)
  nos itens sem tiny. unique legada (pedido_id, produto_id) sobrevive à troca de tipo.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 1.3: Não dropar componente sem Tiny — flag sem_cadastro_tiny (P002)

**Files**
- Modify `src/lib/webhook-processor-wms.ts:43-56` (ResolvedItem: adicionar `semCadastroTiny`), `:114-261` (expandirKits: extrair helper puro + parar de dropar), `:538-576` (upsert: gravar novas colunas + delete-then-insert do sem-tiny + ajuste de órfãos).
- Modify `src/app/api/wms/pedidos/aprovar/route.ts:229-244` (loop de roteamento de transferência: o `Number(it.produto_id)` quebra com o uuid sem-tiny — pular itens com `produto_id` não-numérico e usar `produto_id_wms` direto. Change_site da Step 0/auditoria da Task 1.2).
- Test (Create) `src/lib/__tests__/webhook-processor-wms-kit-sem-tiny.test.ts` (unit puro do helper).
- Test (Create) `test/integration/pedido-itens-sem-tiny.test.ts` (integration vs staging: grava componente sem-tiny 2x e prova idempotência por `(pedido_id, produto_id_wms)` contra o índice parcial).
- Test (Create) `test/integration/aprovar-transferencia-kit-sem-tiny.test.ts` (integration vs staging: pedido com item sem-tiny + `produto_id_wms` é roteado SEM perder o componente — o caller resolve por `produto_id_wms`, não por `Number(produto_id)`).

**Contexto ancorado (código atual):**
- `ResolvedItem` (linhas 43-56) tem `tinyProdutoId: number`, `produtoIdWms: string | null`, `sku`, `descricao`, `quantidade`, `imagemUrl`, `gtin`, `ehKit`.
- `expandirKits` (linhas 214-258): o loop final monta cada componente; linhas 237-246 fazem `const tinyId = tinyIdByComponente.get(c.componente_id); if (!tinyId) { logger.warn(...); continue; }` — esse `continue` é o drop a remover.
- O upsert de itens (linhas 540-560) grava `produto_id: item.tinyProdutoId`, `produto_id_tiny: item.tinyProdutoId` e usa `onConflict: "pedido_id,produto_id"`. `produto_id` é coluna **text** (carrega o `tiny_produto_id` numérico hoje).
- A limpeza de órfãos (linhas 564-576) usa `tinyIdsNovos = itensResolvidos.map((i) => i.tinyProdutoId)` e `.not("produto_id", "in", ...)` — itens sem tiny não entram nessa lista; precisa ajustar para não apagar componentes flagueados.

**Decisão técnica (estrutura do helper puro):** extrair de `expandirKits` a montagem de UMA linha de componente para uma função pura `montarLinhaComponente(componente, tinyId, qtyKit)` que recebe o componente já resolvido + o tinyId (ou `undefined`) + a qty do kit, e devolve um `ResolvedItem` com `semCadastroTiny` setado. Isso é unit-testável sem DB.

**Steps**

- [ ] **Step 1 — Escrever o teste que FALHA.** Criar `src/lib/__tests__/webhook-processor-wms-kit-sem-tiny.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { montarLinhaComponente } from "../webhook-processor-wms";

const compC1 = {
  componente_id: "00000000-0000-4000-8000-0000000000c1",
  sku: "C1-SEM-TINY",
  descricao: "Componente 1 sem mapeamento",
  gtin: null as string | null,
  imagem_url: null as string | null,
  quantidade: 2, // qty do componente por kit
};
const compC2 = {
  componente_id: "00000000-0000-4000-8000-0000000000c2",
  sku: "C2-OK",
  descricao: "Componente 2 mapeado",
  gtin: null as string | null,
  imagem_url: null as string | null,
  quantidade: 1,
};

describe("montarLinhaComponente (P002)", () => {
  it("componente SEM tinyId: não dropa — entra flagueado sem_cadastro_tiny=true, tinyProdutoId=null", () => {
    const linha = montarLinhaComponente(compC1, undefined, 3); // 3 kits pedidos
    expect(linha.produtoIdWms).toBe(compC1.componente_id);
    expect(linha.tinyProdutoId).toBeNull();
    expect(linha.semCadastroTiny).toBe(true);
    expect(linha.quantidade).toBe(6); // 2 × 3
    expect(linha.sku).toBe("C1-SEM-TINY");
    expect(linha.ehKit).toBe(false);
  });

  it("componente COM tinyId: linha normal — sem_cadastro_tiny=false, tinyProdutoId preenchido", () => {
    const linha = montarLinhaComponente(compC2, 555111, 3);
    expect(linha.tinyProdutoId).toBe(555111);
    expect(linha.produtoIdWms).toBe(compC2.componente_id);
    expect(linha.semCadastroTiny).toBe(false);
    expect(linha.quantidade).toBe(3); // 1 × 3
  });
});
```

- [ ] **Step 2 — RODAR e ver FALHAR.**
  ```
  npm test -- src/lib/__tests__/webhook-processor-wms-kit-sem-tiny.test.ts
  ```
  Expected: **FAIL** — `montarLinhaComponente` não existe / não é exportado.

- [ ] **Step 1b — Escrever o teste de integração que FALHA (upsert sem-tiny idempotente contra o índice parcial).** Criar `test/integration/pedido-itens-sem-tiny.test.ts`. Este teste roda contra o staging real (trunca tabelas via globalSetup), grava um componente sem-tiny via a MESMA lógica delete-then-insert do Step 3d, repete a gravação e assevera que existe **exatamente 1** linha — provando que `(pedido_id, produto_id_wms)` é idempotente contra `idx_pedido_itens_pedido_produto_wms_sem_tiny` e que o índice parcial impede duplicata. Espelha o padrão de `test/integration/ledger-rpc.test.ts` (usa `createServiceClient`, `beforeAll` cria fixtures via `sb`):

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

const PEDIDO_ID = `TEST-SEMTINY-${Math.random().toString(36).slice(2, 8)}`;
let componenteId = ""; // uuid WMS do componente sem tiny

beforeAll(async () => {
  // Produto WMS do componente (uuid alvo de produto_id_wms). NÃO criamos
  // mapeamento em siso_produto_empresas — é exatamente o caso "sem cadastro Tiny".
  const { data: p, error } = await sb
    .from("siso_produtos")
    .insert({ sku: `${PEDIDO_ID}-COMP`, descricao: "Componente sem tiny", ativo: true })
    .select("id")
    .single();
  if (error) throw error;
  componenteId = (p as { id: string }).id;

  // Pedido-pai mínimo (siso_pedidos.id é text). FK de siso_pedido_itens.pedido_id
  // → siso_pedidos.id exige a linha existir. numero/data/filial_origem são
  // NOT NULL sem default (ver docs/database-schema.md).
  const { error: pedErr } = await sb.from("siso_pedidos").insert({
    id: PEDIDO_ID,
    numero: PEDIDO_ID,
    data: new Date().toISOString(),
    filial_origem: "CWB",
    status: "pendente",
    origem_pedido: "webhook",
  });
  if (pedErr) throw pedErr;
});

// Helper: replica EXATAMENTE o caminho de gravação do componente sem-tiny do
// Step 3d (delete-then-insert por (pedido_id, produto_id_wms)).
async function gravarComponenteSemTiny() {
  await sb
    .from("siso_pedido_itens")
    .delete()
    .eq("pedido_id", PEDIDO_ID)
    .eq("produto_id_wms", componenteId);
  const { error } = await sb.from("siso_pedido_itens").insert({
    pedido_id: PEDIDO_ID,
    produto_id: componenteId, // sem tiny → produto_id (text) recebe o uuid WMS
    produto_id_tiny: null,
    produto_id_wms: componenteId,
    sem_cadastro_tiny: true,
    sku: `${PEDIDO_ID}-COMP`,
    descricao: "Componente sem tiny",
    quantidade_pedida: 2,
  });
  if (error) throw error;
}

describe("siso_pedido_itens — componente sem cadastro Tiny (P002)", () => {
  it("grava o componente sem-tiny com sem_cadastro_tiny=true e produto_id_wms preenchido", async () => {
    await gravarComponenteSemTiny();
    const { data } = await sb
      .from("siso_pedido_itens")
      .select("produto_id_wms, produto_id_tiny, sem_cadastro_tiny")
      .eq("pedido_id", PEDIDO_ID)
      .eq("produto_id_wms", componenteId);
    expect((data ?? []).length).toBe(1);
    const row = (data ?? [])[0] as {
      produto_id_wms: string;
      produto_id_tiny: number | null;
      sem_cadastro_tiny: boolean;
    };
    expect(row.produto_id_wms).toBe(componenteId);
    expect(row.produto_id_tiny).toBeNull();
    expect(row.sem_cadastro_tiny).toBe(true);
  });

  it("re-gravar (re-entrega de webhook) NÃO duplica — fica exatamente 1 linha", async () => {
    await gravarComponenteSemTiny();
    await gravarComponenteSemTiny(); // segunda entrega
    const { data } = await sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", PEDIDO_ID)
      .eq("produto_id_wms", componenteId);
    expect((data ?? []).length).toBe(1);
  });

  it("o índice parcial idx_pedido_itens_pedido_produto_wms_sem_tiny rejeita INSERT duplicado direto (23505)", async () => {
    // Garante 1 linha existente.
    await gravarComponenteSemTiny();
    // INSERT direto SEM o delete prévio: o índice parcial deve barrar com 23505.
    const { error } = await sb.from("siso_pedido_itens").insert({
      pedido_id: PEDIDO_ID,
      produto_id: componenteId,
      produto_id_tiny: null,
      produto_id_wms: componenteId,
      sem_cadastro_tiny: true,
      sku: `${PEDIDO_ID}-COMP`,
      descricao: "Componente sem tiny (dup)",
      quantidade_pedida: 2,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23505");
  });
});
```

- [ ] **Step 2b — RODAR o integration e ver FALHAR.**
  ```
  npm run test:integration -- test/integration/pedido-itens-sem-tiny.test.ts
  ```
  Expected: **FAIL** — as colunas `produto_id_wms`/`sem_cadastro_tiny` precisam existir (Task 1.2 já as criou; se 1.2 não foi aplicada, o insert falha com coluna inexistente). Com 1.2 aplicada mas SEM o índice parcial, o 3º teste (23505) falha porque o INSERT duplicado é aceito. O teste GREEN passa só com a migration 1.2 completa (colunas + índice parcial) aplicada.

> Nota de ordem: Step 1b/2b dependem da migration da Task 1.2 já aplicada em staging. Como a Task 1.2 vem ANTES da 1.3 no plano, rodar o integration aqui valida a migration de fato (era a lacuna apontada: a 1.2 só checava `information_schema`; agora o índice parcial é exercitado com DB real).

- [ ] **Step 1c — Escrever o teste de integração que FALHA (aprovação de transferência NÃO perde o componente sem-tiny).** Criar `test/integration/aprovar-transferencia-kit-sem-tiny.test.ts`. Este teste prova que o caller `aprovar/route.ts:229-244` resolve o item sem-tiny por `produto_id_wms` (e não por `Number(produto_id)`, que viraria `NaN` com o uuid). Monta um pedido `pendente` com DOIS itens — um normal (com tiny+saldo) e um componente sem-tiny (`produto_id` = uuid, `produto_id_tiny` = null, `produto_id_wms` = uuid) — cria saldo em UM galpão não-casa pra forçar transferência, aprova como `transferencia`, e assevera que o array `itens` montado pro roteamento incluiu o componente sem-tiny (via o número de reservas/itens roteados). Espelha o padrão de `test/integration/ledger-rpc.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { createServiceClient } from "../../src/lib/supabase-server";
import { POST } from "../../src/app/api/wms/pedidos/aprovar/route";

const sb = createServiceClient();

const STAGING_PROJECT_REF = "ehbxpbeijofxtsbezwxd";
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes(STAGING_PROJECT_REF)) {
  throw new Error("refusing to run outside staging");
}

const TAG = `TEST-APRV-SEMTINY-${Math.random().toString(36).slice(2, 8)}`;
let componenteId = ""; // uuid WMS do componente sem-tiny
let empresaId = "";
let sessionId = "";

beforeAll(async () => {
  // Empresa origem qualquer.
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = (emp as { id: string }).id;

  // Produto WMS do componente — SEM mapeamento Tiny (o caso flagueado).
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `${TAG}-COMP`, descricao: "Comp sem tiny", ativo: true })
    .select("id")
    .single();
  componenteId = (p as { id: string }).id;

  // Pedido PENDENTE (pré-condição da aprovação) com empresa_origem_id setado.
  await sb.from("siso_pedidos").insert({
    id: TAG,
    numero: TAG,
    data: new Date().toISOString(),
    filial_origem: "CWB",
    status: "pendente",
    empresa_origem_id: empresaId,
    origem_pedido: "webhook",
  });

  // Item flagueado: produto_id = uuid WMS (não numérico), produto_id_tiny = null,
  // produto_id_wms = uuid, sem_cadastro_tiny = true.
  await sb.from("siso_pedido_itens").insert({
    pedido_id: TAG,
    produto_id: componenteId,
    produto_id_tiny: null,
    produto_id_wms: componenteId,
    sem_cadastro_tiny: true,
    sku: `${TAG}-COMP`,
    descricao: "Comp sem tiny",
    quantidade_pedida: 1,
  });

  // Sessão admin (seed cria test-runner).
  const { data: u } = await sb
    .from("siso_usuarios")
    .select("id")
    .eq("nome", "test-runner")
    .single();
  const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: sess } = await sb
    .from("siso_sessoes")
    .insert({ usuario_id: (u as { id: string }).id, expira_em: expira })
    .select("id")
    .single();
  sessionId = (sess as { id: string }).id;
});

describe("aprovar transferência — componente sem-tiny não some no roteamento (P002)", () => {
  it("o item sem-tiny é resolvido por produto_id_wms (não Number(produto_id)=NaN)", async () => {
    const req = new NextRequest("http://localhost/api/wms/pedidos/aprovar", {
      method: "POST",
      headers: { "X-Session-Id": sessionId, "Content-Type": "application/json" },
      body: JSON.stringify({ pedidoId: TAG, decisao: "transferencia" }),
    });
    const res = await POST(req);
    // Pré-fix: o componente sem-tiny é dropado (Number(uuid)=NaN → lookup vazio),
    // o array `itens` fica vazio, rotearPedidoDoBanco devolve oc/sem_cobertura e
    // o handler cai no fallback origem (warn "Roteamento sem cobertura"). Verificamos
    // que NÃO houve esse fallback: o log warn de fallback fica ausente, e o item
    // sem-tiny aparece como roteado (sem reserva-orphan vazia).
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; decisao?: string };
    // O assert duro: pré-fix, o item sem-tiny NUNCA entra no array `itens` (o Number
    // dropa), então buscamos no log de roteamento o produto_id_wms do componente.
    const { data: logs } = await sb
      .from("siso_logs")
      .select("message, meta")
      .eq("source", "aprovar")
      .order("created_at", { ascending: false })
      .limit(20);
    const houveFallbackSemCobertura = (logs ?? []).some(
      (l) => (l as { message: string }).message?.includes("sem cobertura"),
    );
    // Pré-fix → houveFallbackSemCobertura === true (componente sumiu). Pós-fix → false.
    expect(houveFallbackSemCobertura).toBe(false);
    expect(body.ok).toBe(true);
  });
});
```

> Nota (anti-flake): o teste não cria saldo, então `rotearPedidoDoBanco` legitimamente devolve `oc`/`sem_cobertura` MESMO pós-fix se o componente entrar mas não houver estoque. O sinal discriminante é se o componente ENTRA no array `itens` (logado em `aprovar`), não a decisão final. Se o agente preferir um sinal mais robusto, criar 1 linha de `siso_estoque` (saldo=1) num galpão não-casa pro `componenteId` no `beforeAll` (via `wms_inserir_movimentacao` tipo `E`) e assertar `body.decisao === "transferencia"` — isso prova que o componente foi roteado. Escolher UM dos dois e remover a ambiguidade antes de commitar.

- [ ] **Step 2c — RODAR o integration e ver FALHAR.**
  ```
  npm run test:integration -- test/integration/aprovar-transferencia-kit-sem-tiny.test.ts
  ```
  Expected: **FAIL** — `aprovar/route.ts:235` faz `Number(it.produto_id)` = `Number(uuid)` = `NaN`; o lookup em `siso_produto_empresas` por `tiny_produto_id = NaN` não acha nada, o componente é dropado do array `itens`, `rotearPedidoDoBanco` devolve `sem_cobertura` e o handler loga o warn de fallback → `houveFallbackSemCobertura === true`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/webhook-processor-wms.ts`:

  3a. Adicionar `semCadastroTiny` e tornar `tinyProdutoId` aceitar null no `ResolvedItem` (linhas 43-56):
  ```ts
  interface ResolvedItem {
    /** Tiny produto_id na empresa origem (null se não tem mapeamento Tiny). */
    tinyProdutoId: number | null;
    /** UUID do produto no catálogo WMS */
    produtoIdWms: string | null;
    sku: string;
    descricao: string;
    quantidade: number;
    imagemUrl: string | null;
    gtin: string | null;
    /** true se o produto é cabeçalho de kit. */
    ehKit: boolean;
    /** [P002] true quando o item não tem mapeamento Tiny na empresa origem
     *  (tipicamente componente de kit). Entra mesmo assim — baixa manual. */
    semCadastroTiny: boolean;
  }
  ```
  > Os 3 sites que constroem `ResolvedItem` precisam setar `semCadastroTiny`:
  > - `resolverItensWms` map (linhas 85-97): adicionar `semCadastroTiny: produtoIdWms == null ? false : false` — itens top-level mapeados não usam a flag (mantém `false`; o sem-mapeamento top-level já é tratado/filtrado em `processWebhookWms`). Setar `semCadastroTiny: false`.
  > - O ramo `expandido.push(item)` para não-kit / kit-sem-composição reusa o `item` já existente (já tem a flag).

  3b. Adicionar a função pura exportada (logo acima de `expandirKits`, antes da linha 114):
  ```ts
  /**
   * [P002] Monta UMA linha de componente expandido de kit.
   * Pura (sem DB) pra ser unit-testável. NÃO dropa o componente quando falta
   * tinyId: marca sem_cadastro_tiny=true e mantém o uuid WMS como id interno.
   */
  export function montarLinhaComponente(
    componente: {
      componente_id: string;
      sku: string;
      descricao: string;
      gtin: string | null;
      imagem_url: string | null;
      quantidade: number; // qty do componente por kit
    },
    tinyId: number | undefined,
    qtyKit: number,
  ): ResolvedItem {
    return {
      tinyProdutoId: tinyId ?? null,
      produtoIdWms: componente.componente_id,
      sku: componente.sku,
      descricao: componente.descricao,
      quantidade: componente.quantidade * qtyKit,
      imagemUrl: componente.imagem_url,
      gtin: componente.gtin,
      ehKit: false,
      semCadastroTiny: tinyId == null,
    };
  }
  ```

  3c. Substituir o loop que dropa (linhas 237-256) por uso do helper, com warn mantido (visibilidade) mas SEM `continue`:
  ```ts
      for (const c of comps) {
        const tinyId = tinyIdByComponente.get(c.componente_id);
        if (tinyId == null) {
          logger.warn("processor.wms", "componente sem mapeamento na empresa origem — entra flagueado (não dropado)", {
            kitSku: item.sku,
            componenteSku: c.sku,
            empresaId: empresaOrigemId,
          });
        }
        expandido.push(montarLinhaComponente(c, tinyId, item.quantidade));
      }
  ```

  3d. Gravar as novas colunas no upsert de itens. Substituir o bloco do `for (const item of itensResolvidos)` (linhas 540-560). **Itens COM tiny** continuam no `upsert(..., onConflict: "pedido_id,produto_id")` (índice total legado). **Itens SEM tiny** vão por **delete-then-insert** por `(pedido_id, produto_id_wms)` — NÃO usar `onConflict` no índice parcial (PostgREST não infere o predicado `WHERE`; ver Task 1.2). O índice parcial fica como backstop (uma corrida concorrente perde com 23505):
  ```ts
    for (const item of itensResolvidos) {
      const fornecedor = getFornecedorBySku(item.sku);
      const row = {
        pedido_id: pedido.id,
        // produto_id (text) continua = tiny quando existe; pra item sem tiny
        // recebe o uuid WMS como id estável.
        produto_id: item.tinyProdutoId != null ? String(item.tinyProdutoId) : item.produtoIdWms,
        produto_id_tiny: item.tinyProdutoId,
        produto_id_wms: item.produtoIdWms,
        sem_cadastro_tiny: item.semCadastroTiny,
        sku: item.sku,
        descricao: item.descricao,
        quantidade_pedida: item.quantidade,
        fornecedor_oc: fornecedor?.fornecedor ?? null,
        imagem_url: item.imagemUrl,
        gtin: item.gtin,
      };

      if (item.tinyProdutoId != null) {
        // Caminho normal: upsert pelo índice TOTAL (pedido_id, produto_id).
        const { error: itemErr } = await sb
          .from("siso_pedido_itens")
          .upsert(row, { onConflict: "pedido_id,produto_id" });
        if (itemErr) throw itemErr;
      } else {
        // [P002] Componente sem tiny: delete-then-insert por (pedido_id,
        // produto_id_wms). NÃO usa onConflict no índice parcial (não suportado
        // por PostgREST). Idempotente em re-entrega; o índice parcial é só
        // backstop pra corrida (23505 = no-op).
        await sb
          .from("siso_pedido_itens")
          .delete()
          .eq("pedido_id", pedido.id)
          .eq("produto_id_wms", item.produtoIdWms);
        const { error: insErr } = await sb.from("siso_pedido_itens").insert(row);
        // 23505 = outra entrega concorrente já inseriu — trata como no-op.
        if (insErr && insErr.code !== "23505") throw insErr;
      }
    }
  ```

  3e. Ajustar a limpeza de órfãos (linhas 564-576). Com `produto_id` agora **text**, os ids tiny (como texto) E os uuid WMS dos componentes sem-tiny convivem na MESMA coluna. Então a lista de "ids válidos" é só o `produto_id` (string) de cada item resolvido — apaga qualquer linha do pedido cujo `produto_id` não esteja nessa lista (preserva tanto tiny quanto sem-tiny):
  ```ts
    // Todos os produto_id (text) que devem permanecer: tiny (como texto) quando
    // existe; uuid WMS quando o componente é sem-tiny. Mesma coluna, mesma lista.
    const produtoIdsNovos = itensResolvidos
      .map((i) => (i.tinyProdutoId != null ? String(i.tinyProdutoId) : i.produtoIdWms))
      .filter((id): id is string => id != null);
    if (produtoIdsNovos.length > 0) {
      // Quoting: produto_id é text → cada valor entra entre aspas no filtro in().
      const inList = produtoIdsNovos.map((id) => `"${id}"`).join(",");
      const { error: delItErr } = await sb
        .from("siso_pedido_itens")
        .delete()
        .eq("pedido_id", pedido.id)
        .not("produto_id", "in", `(${inList})`);
      if (delItErr) {
        logger.warn("processor.wms", "falha ao remover itens órfãos do pedido", {
          pedidoId: pedido.id,
          err: delItErr.message,
        });
      }
    }
  ```
  > Nota: divergência do achado — (a) `onConflict` no índice parcial não é suportado por PostgREST, então o sem-tiny grava via delete-then-insert; (b) o achado não detalhava a limpeza de órfãos, mas com `produto_id` virando text (Task 1.2) o filtro precisa quotar os valores e incluir os uuid WMS dos sem-tiny, senão o componente flagueado seria apagado logo após gravado.

  3f. **[caller quebrado pela migration] Corrigir `src/app/api/wms/pedidos/aprovar/route.ts:229-244`.** Esse é o change_site da Step 0/auditoria da Task 1.2: o loop monta o array `itens` pro `rotearPedidoDoBanco` (transferência) resolvendo `tiny_produto_id` via `Number(it.produto_id)`. Com `produto_id` agora text e carregando o uuid WMS nos itens sem-tiny, `Number(uuid) = NaN` → o lookup não acha mapeamento → o componente sem-tiny some silenciosamente do roteamento na aprovação. Carregar `produto_id_wms` no select e, pra item sem-tiny (com `produto_id_wms` e sem `produto_id_tiny`), usar o uuid direto sem passar pelo lookup. Trocar o bloco (linhas 222-243):
  ```ts
      // Carrega itens pra alimentar roteamento (precisa quantidade).
      // Inclui produto_id_wms/produto_id_tiny: componente sem cadastro Tiny
      // (P002) carrega o uuid WMS direto em produto_id_wms — resolver por
      // Number(produto_id) daria NaN (uuid) e dropava o item do roteamento.
      const { data: itensParaRotear } = await supabase
        .from("siso_pedido_itens")
        .select("produto_id, produto_id_tiny, produto_id_wms, quantidade_pedida")
        .eq("pedido_id", pedidoId);

      // Map Tiny produto_id → WMS uuid via empresa origem (que é a dona
      // do tiny_produto_id armazenado em siso_pedido_itens.produto_id).
      const itens: Array<{ produto_id: string; qty: number }> = [];
      for (const it of itensParaRotear ?? []) {
        const qty = Number(it.quantidade_pedida ?? 0);
        // [P002] Item sem cadastro Tiny: o uuid WMS já está em produto_id_wms.
        // Usar direto, sem lookup (Number(produto_id) seria NaN).
        if (it.produto_id_tiny == null && it.produto_id_wms) {
          itens.push({ produto_id: it.produto_id_wms as string, qty });
          continue;
        }
        // Caminho normal: resolve tiny_produto_id → uuid WMS.
        const tinyId = it.produto_id_tiny ?? Number(it.produto_id);
        if (!Number.isFinite(tinyId)) continue; // produto_id não-numérico sem wms: ignora (não rotearia mesmo)
        const { data: map } = await supabase
          .from("siso_produto_empresas")
          .select("produto_id")
          .eq("empresa_id", pedido.empresa_origem_id)
          .eq("tiny_produto_id", tinyId)
          .maybeSingle();
        if (map?.produto_id) {
          itens.push({ produto_id: map.produto_id as string, qty });
        } else if (it.produto_id_wms) {
          // fallback: tem uuid WMS mesmo com tiny → usa o uuid (não perde o item).
          itens.push({ produto_id: it.produto_id_wms as string, qty });
        }
      }
  ```
  > Nota: prefere `produto_id_tiny` (coluna dedicada) a re-parsear `produto_id`; só cai no `Number(it.produto_id)` por compatibilidade com pedidos antigos cujo `produto_id_tiny` não foi preenchido. `rotearPedidoDoBanco(empresaVendedoraId, itens: { produto_id: string (uuid WMS); qty }[])` — assinatura verificada em `src/lib/wms/roteamento.ts:198-201` (`ItemPedido = { produto_id: string; qty: number }`, :24-27).

- [ ] **Step 4 — RODAR e ver PASSAR.**
  ```
  npm test -- src/lib/__tests__/webhook-processor-wms-kit-sem-tiny.test.ts
  npm run test:integration -- test/integration/pedido-itens-sem-tiny.test.ts test/integration/aprovar-transferencia-kit-sem-tiny.test.ts
  npx tsc --noEmit
  ```
  Expected: **PASS** nos 2 testes unit + nos 3 do integration de `pedido-itens-sem-tiny` + no integration de `aprovar-transferencia` (componente sem-tiny não some no roteamento); typecheck limpo (atenção aos sites de `ResolvedItem` e `tinyProdutoId` agora `number | null` — `tinyIdsNovos` já filtrado).

- [ ] **Step 5 — COMMIT.**
  ```
  git add src/lib/webhook-processor-wms.ts src/app/api/wms/pedidos/aprovar/route.ts src/lib/__tests__/webhook-processor-wms-kit-sem-tiny.test.ts test/integration/pedido-itens-sem-tiny.test.ts test/integration/aprovar-transferencia-kit-sem-tiny.test.ts
  git commit -m "fix(wms): componente de kit sem cadastro Tiny entra flagueado, não dropado (P002)

  expandirKits para de fazer continue no componente sem tinyId. Helper puro
  montarLinhaComponente marca sem_cadastro_tiny=true + mantém uuid WMS. Item sem
  tiny grava via delete-then-insert por (pedido_id, produto_id_wms) — o índice
  parcial é backstop (PostgREST não infere onConflict parcial). Limpeza de
  órfãos preserva os flagueados. aprovar/route.ts resolve o item sem-tiny por
  produto_id_wms (Number(produto_id) daria NaN com o uuid e dropava o componente
  no roteamento de transferência).

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 6 — erros-conhecidos.yaml.** Adicionar:
  ```yaml
  - id: P002
    date: 2026-06-05
    source: raio-x fase 6b
    category: business_logic
    message: "Componente de kit sem mapeamento Tiny na empresa origem era dropado — kit saía incompleto"
    cause: "expandirKits fazia continue quando tinyIdByComponente não tinha o componente; o item nunca entrava em siso_pedido_itens e o cliente recebia kit incompleto. Além disso, com produto_id virando text+uuid, o caller aprovar/route.ts:235 (Number(produto_id)=NaN) dropava o componente sem-tiny no roteamento de transferência"
    fix: "Não dropar: montarLinhaComponente marca sem_cadastro_tiny=true e usa produto_id_wms (uuid WMS) como id interno; migration adiciona as colunas + índice único parcial sem tornar produto_id nullable; aprovar/route.ts resolve item sem-tiny por produto_id_wms direto (não Number(produto_id))"
    files:
      - src/lib/webhook-processor-wms.ts
      - src/app/api/wms/pedidos/aprovar/route.ts
      - supabase/migrations/20260605_pedido_itens_produto_wms_sem_cadastro.sql
    tags: [kit, cadastro, tiny, sem-mapeamento, visibilidade, caller-quebrado, gotcha-2]
  ```

---

### Task 1.4: Surfacing fim-a-fim do `sem_cadastro_tiny` — route → tipo → badge (P002)

**Files**
- Modify `src/app/api/wms/separacao/checklist-items/route.ts:51-54` (`.select` explícito: adicionar `produto_id_wms, sem_cadastro_tiny`) e `:290-314` (objeto de resposta: adicionar os 2 campos).
- Modify `src/app/wms/separacao/page.tsx:1888-1907` (interface `ChecklistItem`: adicionar `produto_id_wms`, `sem_cadastro_tiny`) e `:2011-2013` (linha do item: badge quando `sem_cadastro_tiny`).
- Modify `src/types/index.ts:249-250` (`PedidoItem`: adicionar `produto_id_wms`, `sem_cadastro_tiny` — fidelidade do tipo da row do banco).
- Test (Create) `test/integration/checklist-items-sem-tiny.test.ts` (chama o handler GET da rota e assevera `sem_cadastro_tiny: true` no payload).

**Contexto ancorado (código atual — VERIFICADO, a route NÃO é `select("*")`):**
- A route faz `.select(...)` **explícito** (route.ts:51-54) com a lista de colunas — `produto_id_wms`/`sem_cadastro_tiny` **não** estão lá hoje, então a row carregada não os tem.
- A resposta é montada **campo-a-campo** num objeto literal (route.ts:290-314), **sem spread** — `produto_id_wms`/`sem_cadastro_tiny` não estão lá, então o payload nunca os entrega.
- O frontend renderiza por `it.sem_cadastro_tiny`, que seria **sempre `undefined`** sem os 2 ajustes acima. O badge nunca apareceria. (Esta era a lacuna apontada na revisão: a nota condicional "se for select(\*) já vem" estava factualmente errada — removida.)
- A interface do item da separação é a `ChecklistItem` LOCAL em `separacao/page.tsx:1888-1907` (não `PedidoItem`). O render dos itens está em `items.map((it) => ...)` (linha 1978); a célula da descrição é `<td><span title={it.descricao ?? ""}>{it.descricao ?? "—"}</span></td>` (linha 2011-2013).
- `getSessionUser` (session.ts:83-107) valida só uma row em `siso_sessoes` (id + `expira_em` futuro) ligada a `siso_usuarios`; o seed cria o user `test-runner` (admin). O integration test cria uma sessão pra ele e chama o handler `GET` direto.

**Steps**

- [ ] **Step 1 — Escrever o teste de integração que FALHA (payload da route carrega `sem_cadastro_tiny`).** Criar `test/integration/checklist-items-sem-tiny.test.ts`. Cria um pedido + item flagueado direto no banco, monta uma sessão válida pro `test-runner`, chama o handler `GET` da route com `X-Session-Id`, e assevera que o item no payload tem `sem_cadastro_tiny: true` e `produto_id_wms` preenchido. Prova o caminho fim-a-fim (route → payload) ANTES da implementação:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { createServiceClient } from "../../src/lib/supabase-server";
import { GET } from "../../src/app/api/wms/separacao/checklist-items/route";

const sb = createServiceClient();

const PEDIDO_ID = `TEST-CHK-SEMTINY-${Math.random().toString(36).slice(2, 8)}`;
let componenteId = "";
let sessionId = "";

beforeAll(async () => {
  // Galpão de separação (seed cria CWB).
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  const galpaoId = (g as { id: string }).id;

  // Produto WMS do componente — sem mapeamento Tiny (o caso flagueado).
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `${PEDIDO_ID}-COMP`, descricao: "Comp sem tiny", ativo: true })
    .select("id")
    .single();
  componenteId = (p as { id: string }).id;

  // Pedido em separação no galpão (status_separacao = aguardando_separacao pra
  // não cair no filtro de aguardando_compra que esconde itens). numero/data/
  // filial_origem são NOT NULL sem default (ver docs/database-schema.md).
  await sb.from("siso_pedidos").insert({
    id: PEDIDO_ID,
    numero: PEDIDO_ID,
    data: new Date().toISOString(),
    filial_origem: "CWB",
    status: "executando",
    status_separacao: "aguardando_separacao",
    separacao_galpao_id: galpaoId,
    origem_pedido: "webhook",
  });

  // Item flagueado (sem tiny).
  await sb.from("siso_pedido_itens").insert({
    pedido_id: PEDIDO_ID,
    produto_id: componenteId,
    produto_id_tiny: null,
    produto_id_wms: componenteId,
    sem_cadastro_tiny: true,
    sku: `${PEDIDO_ID}-COMP`,
    descricao: "Comp sem tiny",
    quantidade_pedida: 2,
  });

  // Sessão válida pro test-runner (seed cria esse usuário admin).
  const { data: u } = await sb
    .from("siso_usuarios")
    .select("id")
    .eq("nome", "test-runner")
    .single();
  const usuarioId = (u as { id: string }).id;
  const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: sess } = await sb
    .from("siso_sessoes")
    .insert({ usuario_id: usuarioId, expira_em: expira })
    .select("id")
    .single();
  sessionId = (sess as { id: string }).id;
});

describe("GET /api/wms/separacao/checklist-items — sem_cadastro_tiny no payload (P002)", () => {
  it("o item flagueado vem com sem_cadastro_tiny=true e produto_id_wms no payload", async () => {
    const url = `http://localhost/api/wms/separacao/checklist-items?pedidos=${PEDIDO_ID}`;
    const req = new NextRequest(url, { headers: { "X-Session-Id": sessionId } });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; sem_cadastro_tiny?: boolean; produto_id_wms?: string | null }>;
    };
    const item = body.items.find((i) => i.produto_id_wms === componenteId);
    expect(item).toBeDefined();
    expect(item!.sem_cadastro_tiny).toBe(true);
    expect(item!.produto_id_wms).toBe(componenteId);
  });
});
```

- [ ] **Step 2 — RODAR o integration e ver FALHAR.**
  ```
  npm run test:integration -- test/integration/checklist-items-sem-tiny.test.ts
  ```
  Expected: **FAIL** — `item.sem_cadastro_tiny` é `undefined` (a route não seleciona nem retorna o campo) e/ou `item.produto_id_wms` é `undefined`; o `find` por `produto_id_wms` retorna `undefined` e o `expect(item).toBeDefined()` dispara.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.**

  3a. Em `src/app/api/wms/separacao/checklist-items/route.ts`, adicionar as 2 colunas ao `.select` explícito (linha 51-54). Trocar a string do select para incluir `produto_id_wms, sem_cadastro_tiny`:
  ```ts
      .select(
        "id, pedido_id, produto_id, produto_id_wms, sem_cadastro_tiny, sku, gtin, descricao, quantidade_pedida, separacao_marcado, separacao_marcado_em, quantidade_bipada, bipado_completo, imagem_url, compra_status, quantidade_pega, separacao_parcial, parcial_motivo, parcial_em",
      )
  ```

  3b. Na montagem do objeto de resposta (route.ts:290-314), adicionar os 2 campos (ex.: logo após `produto_id: item.produto_id,` na linha 293):
  ```ts
        produto_id_wms: item.produto_id_wms ?? null,
        sem_cadastro_tiny: item.sem_cadastro_tiny ?? false,
  ```

  3c. Em `src/app/wms/separacao/page.tsx`, dentro da interface `ChecklistItem` (linhas 1888-1907), após `gtin: string | null;` (linha 1892), adicionar:
  ```ts
    produto_id_wms: string | null;
    sem_cadastro_tiny: boolean;
  ```

  3d. No render do item (`separacao/page.tsx`), na célula da descrição (linha 2011-2013), adicionar o badge condicional ao lado da descrição:
  ```tsx
                    <td style={{ padding: "4px 6px", fontSize: 12 }}>
                      <span title={it.descricao ?? ""}>{it.descricao ?? "—"}</span>
                      {it.sem_cadastro_tiny && (
                        <span
                          className="wms-badge wms-badge-warn"
                          style={{ marginLeft: 6 }}
                          title="Componente sem cadastro Tiny na empresa — baixa manual"
                        >
                          sem cadastro Tiny
                        </span>
                      )}
                    </td>
  ```
  > Nota: divergência do achado — o achado citava `produto-drawer.tsx`/"página do pedido"; o render real dos itens de separação está em `separacao/page.tsx` (interface `ChecklistItem` local, alimentada pela route `checklist-items`).

  3e. Em `src/types/index.ts`, dentro de `PedidoItem`, após `produto_id_tiny` (linha 250) — fidelidade do tipo da row do banco:
  ```ts
    /** [P002] uuid WMS do produto (siso_produtos.id). Sempre preenchido quando
     *  o produto WMS é conhecido — inclusive para componentes sem cadastro Tiny. */
    produto_id_wms: string | null;
    /** [P002] true quando o item não tem mapeamento Tiny na empresa origem
     *  (componente de kit flagueado). Mostrar badge; preferir baixa manual. */
    sem_cadastro_tiny: boolean;
  ```

- [ ] **Step 4 — RODAR e ver PASSAR.**
  ```
  npm run test:integration -- test/integration/checklist-items-sem-tiny.test.ts
  npx tsc --noEmit
  npm run lint
  ```
  Expected: **PASS** no integration (payload entrega `sem_cadastro_tiny: true`); typecheck/lint limpos.

- [ ] **Step 5 — COMMIT.**
  ```
  git add src/app/api/wms/separacao/checklist-items/route.ts src/app/wms/separacao/page.tsx src/types/index.ts test/integration/checklist-items-sem-tiny.test.ts
  git commit -m "feat(wms): surfacing fim-a-fim do sem_cadastro_tiny — route + badge na separação (P002)

  checklist-items/route passa a selecionar e retornar produto_id_wms/sem_cadastro_tiny;
  interface ChecklistItem e PedidoItem ganham os campos; badge 'sem cadastro Tiny'
  renderiza no item flagueado. Sem isso o badge nunca aparecia (route fazia select
  explícito + resposta campo-a-campo, sem os campos).

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 1.5: Filtro "Sem mapeamento Tiny" na aba de produtos (P095)

**Files**
- Modify `src/lib/wms/produtos.ts:10-111` (listarProdutos: filtro `sem_mapeamento`).
- Modify `src/app/api/wms/produtos/route.ts:14-40` (ler query param).
- Modify `src/app/wms/produtos/page.tsx:18,84,135-144` (opção no seletor de tipo).
- Test (Create) `src/lib/wms/__tests__/produtos-sem-mapeamento.test.ts`

**Contexto ancorado (código atual):**
- `listarProdutos(filtros)` (linhas 10-111) monta `q = sb.from("siso_produtos").select("*", { count: "exact" })...`; aplica `eh_kit`, `ativo`, `q`. Retorna `{ rows, total }`.
- Não há filtro por mapeamento. `siso_produto_empresas.produto_id` é o uuid WMS de `siso_produtos.id`.
- A rota GET (linhas 10-50) já lê `q/ativo/limit/offset/incluir_kits_por_componente/eh_kit/ordem`.
- A página (`page.tsx`) tem `TipoFiltro = "todos" | "kit" | "simples"` (linha 18) e o `<select>` de tipo nas linhas 135-144.

**Decisão técnica:** `supabase-js` não tem `NOT EXISTS` direto. Implementar buscando os `produto_id` que TÊM mapeamento (`siso_produto_empresas` distinct) e excluindo via `.not("id", "in", (...))`. Para volumes grandes isso pode estourar o tamanho do `in(...)`; como a aba é uma ferramenta de cadastro (uso pontual) e o catálogo é finito, a abordagem é aceitável e simples (YAGNI — não criar RPC/MV).

**Steps**

- [ ] **Step 1 — Escrever o teste que FALHA.** Criar `src/lib/wms/__tests__/produtos-sem-mapeamento.test.ts` (staging-touching, padrão de `realoc-fix-pack.test.ts`):

```ts
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "@/lib/supabase-server";
import { listarProdutos } from "../produtos";

const STAGING_PROJECT_REF = "ehbxpbeijofxtsbezwxd";
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes(STAGING_PROJECT_REF)) {
  throw new Error(
    `produtos-sem-mapeamento.test.ts: refusing to run outside staging (${STAGING_PROJECT_REF}).`,
  );
}

const sb = createServiceClient();
const TAG = `TEST-SEMMAP-${Date.now()}`;
let produtoSemMap = "";
let produtoComMap = "";
let empresaId = "";

describe("listarProdutos({ sem_mapeamento: true }) (P095)", () => {
  beforeAll(async () => {
    // empresa qualquer existente (NetAir) pra criar o mapeamento.
    const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
    empresaId = (emp as { id: string }).id;

    const { data: p1 } = await sb
      .from("siso_produtos")
      .insert({ sku: `${TAG}-SEM`, descricao: "Sem mapeamento", unidade: "UN" })
      .select("id")
      .single();
    produtoSemMap = (p1 as { id: string }).id;

    const { data: p2 } = await sb
      .from("siso_produtos")
      .insert({ sku: `${TAG}-COM`, descricao: "Com mapeamento", unidade: "UN" })
      .select("id")
      .single();
    produtoComMap = (p2 as { id: string }).id;

    await sb.from("siso_produto_empresas").insert({
      produto_id: produtoComMap,
      empresa_id: empresaId,
      tiny_produto_id: 990_000_000 + Math.floor(Date.now() / 1000) % 999_999,
    });
  });

  afterAll(async () => {
    await sb.from("siso_produto_empresas").delete().eq("produto_id", produtoComMap);
    await sb.from("siso_produtos").delete().in("id", [produtoSemMap, produtoComMap]);
  });

  it("retorna o produto SEM mapeamento e exclui o que TEM mapeamento", async () => {
    const { rows } = await listarProdutos({ sem_mapeamento: true, q: TAG, limit: 100 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(produtoSemMap);
    expect(ids).not.toContain(produtoComMap);
  });

  it("sem o filtro, ambos aparecem", async () => {
    const { rows } = await listarProdutos({ q: TAG, limit: 100 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(produtoSemMap);
    expect(ids).toContain(produtoComMap);
  });
});
```

- [ ] **Step 2 — RODAR e ver FALHAR.**
  ```
  npm test -- src/lib/wms/__tests__/produtos-sem-mapeamento.test.ts
  ```
  Expected: **FAIL** — `listarProdutos` não aceita `sem_mapeamento`; o produto com mapeamento ainda aparece (assert 1 dispara).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.**

  3a. Em `src/lib/wms/produtos.ts`, adicionar `sem_mapeamento` à assinatura de filtros (após `eh_kit`, dentro do objeto na linha 16-22):
  ```ts
      /** Quando true, retorna só produtos SEM nenhuma linha em
       *  siso_produto_empresas (sem mapeamento Tiny). */
      sem_mapeamento?: boolean;
  ```

  3b. Antes de montar a query principal (após a resolução de `extraIds`, antes de `let q = sb.from("siso_produtos")...` na linha 58), resolver os ids COM mapeamento e aplicar exclusão:
  ```ts
    let semMapExclui: string[] | null = null;
    if (filtros.sem_mapeamento) {
      const comMap = new Set<string>();
      const PAGE = 1000;
      let from = 0;
      // pagina siso_produto_empresas pra coletar todos os produto_id mapeados
      for (;;) {
        const { data: maps } = await sb
          .from("siso_produto_empresas")
          .select("produto_id")
          .range(from, from + PAGE - 1);
        const batch = (maps ?? []) as Array<{ produto_id: string }>;
        for (const m of batch) comMap.add(m.produto_id);
        if (batch.length < PAGE) break;
        from += PAGE;
      }
      semMapExclui = Array.from(comMap);
    }
  ```

  3c. Aplicar a exclusão na query `q` (logo após `if (filtros.eh_kit !== undefined) q = q.eq("eh_kit", filtros.eh_kit);` na linha 86):
  ```ts
    if (semMapExclui && semMapExclui.length > 0) {
      q = q.not("id", "in", `(${semMapExclui.map((id) => `"${id}"`).join(",")})`);
    }
  ```

  3d. Em `src/app/api/wms/produtos/route.ts`, ler o param e repassar (dentro do `listarProdutos({...})` da linha 26-40, após `eh_kit`):
  ```ts
        sem_mapeamento: sp.get("sem_mapeamento") === "true" || sp.get("sem_mapeamento") === "1",
  ```

  3e. Em `src/app/wms/produtos/page.tsx`:
  - Linha 18: estender o type — `type TipoFiltro = "todos" | "kit" | "simples" | "sem_mapeamento";`
  - No `queryFn` (linhas 83-86), após o tratamento de `eh_kit`, adicionar:
    ```ts
          if (tipoFiltro === "sem_mapeamento") params.set("sem_mapeamento", "true");
    ```
  - No `<select>` de tipo (linhas 141-143), adicionar a opção:
    ```tsx
            <option value="sem_mapeamento">Sem mapeamento Tiny</option>
    ```

- [ ] **Step 4 — RODAR e ver PASSAR.**
  ```
  npm test -- src/lib/wms/__tests__/produtos-sem-mapeamento.test.ts
  npx tsc --noEmit
  npm run lint
  ```
  Expected: **PASS** nos 2 testes; typecheck/lint limpos.

- [ ] **Step 5 — COMMIT.**
  ```
  git add src/lib/wms/produtos.ts src/app/api/wms/produtos/route.ts src/app/wms/produtos/page.tsx src/lib/wms/__tests__/produtos-sem-mapeamento.test.ts
  git commit -m "feat(wms): filtro 'Sem mapeamento Tiny' na aba de produtos (P095)

  listarProdutos aceita sem_mapeamento: exclui produtos com qualquer linha em
  siso_produto_empresas. Rota lê o param; página adiciona a opção no seletor de
  tipo. Operador acha rápido o que falta cadastrar.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 6 — erros-conhecidos.yaml + docs.** Adicionar entrada P095 e atualizar `docs/api-reference-complete.md` (param `sem_mapeamento` em `GET /api/wms/produtos`):
  ```yaml
  - id: P095
    date: 2026-06-05
    source: raio-x fase 6b
    category: business_logic
    message: "Faltava ferramenta para listar produtos sem mapeamento Tiny"
    cause: "Sync de kit é best-effort e cai todo mundo, mas não havia filtro na aba de produtos para o operador achar quem está sem siso_produto_empresas e completar o cadastro"
    fix: "listarProdutos ganha filtro sem_mapeamento (exclui produtos com linha em siso_produto_empresas); rota + página expõem a opção"
    files:
      - src/lib/wms/produtos.ts
      - src/app/api/wms/produtos/route.ts
      - src/app/wms/produtos/page.tsx
    tags: [produtos, mapeamento, tiny, filtro, visibilidade]
  ```

---

## Verificação final do PR

- [ ] `npm test` (unit completo) verde.
- [ ] `npm run test:integration -- test/integration/pedido-itens-sem-tiny.test.ts test/integration/aprovar-transferencia-kit-sem-tiny.test.ts test/integration/checklist-items-sem-tiny.test.ts` verde (upsert sem-tiny idempotente + componente sem-tiny não some na aprovação de transferência + payload da route entrega `sem_cadastro_tiny`).
- [ ] `npm run scenarios:only 82` verde (flag `--only` real — ver Task 1.1 Step 2; `:only` é ignorado pelo runner e rodaria a suite toda).
- [ ] `npx tsc --noEmit` + `npm run lint` limpos.
- [ ] `docs/database-schema.md` e `docs/api-reference-complete.md` atualizados no mesmo PR.
- [ ] 3 entradas novas em `erros-conhecidos.yaml` (P001, P002, P095).
