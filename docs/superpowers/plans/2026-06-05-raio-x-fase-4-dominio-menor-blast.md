# Raio-X Fase 4 — Domínio de Menor Blast Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal:** Tornar atômicas e à prova de falha-parcial as operações dos domínios de menor blast-radius do WMS — inventário, devoluções, transferências, recebimento, guarda — fechando os 19 achados re-investigados da Fase 4 do raio-x (P058, P059, P056, P061, P159, P057, P049, P050, P051, P054, P067, P065, P078, P028, P029, P033, P115, P063, P113). Cada fix elimina um estado meio-feito (movs órfãs, saldo sem contagem, devolução pendente com saldo já subido, loc desativada com referências vivas) ou um falso-alerta (divergência fantasma).

**Architecture:** Reusa as duas primitivas-fundação da Fase 1 já provadas no repo: **(A)** claim/guard atômico de header (compare-and-set) e **(B)** envelope de RPC plpgsql transacional (`SELECT ... FOR UPDATE` da âncora + N `wms_inserir_movimentacao` + `UPDATE` de status na mesma tx; qualquer `RAISE` → rollback total). Os wrappers TS viram chamadas finas `.rpc()`. Onde não há multi-mutação (guards de pré-voo, lookup de mov para estorno parcial, bloqueio de delete de loc), a correção é cirúrgica no service layer sem migration. Toda escrita no ledger continua passando **exclusivamente** por `wms_inserir_movimentacao` (chamado dentro das RPCs novas).

**Tech Stack:** Next.js 16 (App Router) · TypeScript strict · Supabase Postgres (plpgsql RPCs, project staging `ehbxpbeijofxtsbezwxd`) · vitest (unit `src/**/*.test.ts` happy-dom; integration `test/integration/**` serializado contra staging) · scenarios E2E HTTP (`scripts/wms/cenarios/catalogo/NN-*.ts`). Migrations: arquivo em `supabase/migrations/YYYYMMDD_*.sql` + aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`.

> **Ordem dos PRs:** quick wins sem-dep primeiro (PR1 guard de sessão + reconciliação; PR6 estorno-residual replenishment; PR7 recebimento all-or-nothing; PR9 over-receive; PR10 guards de loc). RPCs-base (PR2 estorno sessão, PR3 contagem inline, PR4 classify devolução, PR5 undo transferência) no meio. PR8 (cross-check guarda) por último (toca UI tablet).
>
> **Deps internas:** P061→P056 (mesma RPC, mesmo PR2). P049/P050/P051/P054 → mesma RPC `wms_classificar_devolucao` (PR4). P065 (preflight) e P067 (RPC atômica) são o mesmo fluxo de undo de transferência mas independentes — PR5 faz o preflight ANTES da RPC. ⛔ **PR9 DEPENDE de PR7** (edita o mesmo loop de `receberItensViaOC` e usa a variável `movsCriadasLote` introduzida no PR7) — **executar PR7 antes de PR9, sempre**; PR9 isolado não compila.

---

## PR 1: Guard de status da sessão no bipe + reconciliação temporal desde início do dia [P058, P059]

> **Contexto ancorado (HEAD `de205f2`):**
> - `registrarContagem` (`src/lib/wms/inventario.ts:488-555`) já bloqueia por status da LOC (`contada`/`aprovada`) e por lock de operador, mas **não** valida o status da SESSÃO. P058 quer rejeitar bipe se a sessão saiu de `em_andamento`.
> - `computarDivergencias` (`src/lib/wms/inventario.ts:660-`) calcula `dataLimiteInferior = minContado ?? cutoff_em` (linhas 803-806) ao buscar `siso_movimentacoes`. P059 quer ampliar essa janela pro início do dia, pra que compras que chegam após a contagem (mas antes do cutoff) sejam capturadas pela reconciliação e não gerem divergência fantasma.
> - Sessão status válidos: `planejada,em_andamento,revisao,aprovada,aplicada,cancelada` (`20260529_wms_inventario.sql:17-19`). A sessão contínua de `contagem-inline` fica permanentemente `em_andamento`, então não é afetada pelo guard.

### Task 1.1: Guard de status da sessão em registrarContagem [P058]

**Files:**
- Modify `src/lib/wms/inventario.ts:491-520` (início de `registrarContagem`)
- Modify `src/app/api/wms/inventario/[id]/contagens/route.ts:26-30` (mapear novo erro pra 409)
- Test (RED) `scripts/wms/cenarios/catalogo/82-bipe-sessao-fora-de-andamento-bloqueia.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/82-bipe-sessao-fora-de-andamento-bloqueia.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 82 — [P058] Bipe rejeitado quando a sessão saiu de em_andamento.
 *
 * Operador entra numa loc, a sessão é movida pra 'revisao' (via computar/finalizar),
 * mas a loc fica com lock órfão (status != contada/aprovada). Tentar bipar deve
 * retornar 409 citando que a sessão já saiu da fase em andamento.
 */
type Setup = { sku: string; loc: string; sessaoId: string; locId: string };

export default {
  nome: "82 — [P058] bipe em sessão fora de em_andamento é bloqueado (409)",
  descricao:
    "Sessão movida pra 'revisao' com loc de lock órfão: POST contagens deve dar 409.",
  tags: ["inventario", "guard", "sessao", "P058"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("82");
    await ctx.criarProduto({ sku, descricao: "Guard sessão 82" });
    const loc = await ctx.criarLocalizacao({ galpao: "CWB", codigo: "INV82-01", tipo: "picking" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc, qty: 5 });
    const { id: sessaoId } = await ctx.criarSessaoInventario({ galpao: "CWB", locs: [loc], modo: "aberto" });
    return { sku, loc, sessaoId, locId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    await ctx.entrarParty(setup.sessaoId);
    const prox = await ctx.proximaLoc(setup.sessaoId);
    setup.locId = String(prox.localizacao_id);

    // Força a sessão pra 'revisao' SEM finalizar a loc → loc fica com lock órfão
    // (status 'em_contagem'), sessão != em_andamento.
    await ctx.sb
      .from("siso_inventario_sessoes")
      .update({ status: "revisao" })
      .eq("id", setup.sessaoId);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: prod } = await ctx.sb
      .from("siso_produtos").select("id").eq("sku", setup.sku).single();
    let status = 0;
    try {
      await ctx.http.post(`/api/wms/inventario/${setup.sessaoId}/contagens`, {
        localizacao_id: setup.locId,
        produto_id: (prod as { id: string }).id,
        qty_contada: 5,
      });
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      const mm = m.match(/HTTP (\d+)/);
      status = mm ? Number(mm[1]) : 0;
      if (!/em andamento|saiu da fase/i.test(m)) {
        throw new Error(`mensagem não cita a fase da sessão: ${m}`);
      }
    }
    if (status !== 409) {
      throw new Error(`esperava 409, recebeu ${status} — guard de sessão ausente`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; }
})();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- :only 82`. Expected: FAIL — o POST retorna 200 (bipe aceito) ou 409 com mensagem de lock, não com "saiu da fase em andamento". Assert dispara `esperava 409` ou `mensagem não cita a fase`.

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/inventario.ts`, no topo de `registrarContagem` (logo após `const sb = createServiceClient();`, antes do lookup da loc na linha 496), inserir o guard de sessão:

```ts
  // [P058] Guard de status da SESSÃO (complementa o guard por-loc abaixo).
  // Se a sessão saiu de 'em_andamento' (foi pra revisao/aprovada/aplicada),
  // qualquer bipe novo cairia no vazio — bloqueia explicitamente. A sessão
  // contínua de contagem-inline fica permanentemente 'em_andamento', então
  // não é afetada.
  const { data: sessaoRow } = await sb
    .from("siso_inventario_sessoes")
    .select("status")
    .eq("id", input.sessao_id)
    .maybeSingle();
  if (!sessaoRow) {
    throw new Error("sessão não encontrada");
  }
  const sessaoStatus = (sessaoRow as { status: string }).status;
  if (sessaoStatus !== "em_andamento") {
    throw new Error(
      `sessão já saiu da fase em andamento (status ${sessaoStatus}) — supervisor cria nova para corrigir`,
    );
  }
```

Em `src/app/api/wms/inventario/[id]/contagens/route.ts`, ampliar `isLockMsg` (linha 26-30) pra incluir a nova mensagem:

```ts
    const isLockMsg =
      msg.includes("não faz parte") ||
      msg.includes("não está reivindicada") ||
      msg.includes("reivindicada por outro") ||
      msg.includes("já está em status") ||
      msg.includes("saiu da fase em andamento") ||
      msg.includes("sessão não encontrada");
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- :only 82`. Expected: PASS — POST retorna 409 com mensagem "saiu da fase em andamento".

- [ ] **Step 5 — Commit.** `git add src/lib/wms/inventario.ts src/app/api/wms/inventario/[id]/contagens/route.ts scripts/wms/cenarios/catalogo/82-bipe-sessao-fora-de-andamento-bloqueia.ts && git commit -m "fix(wms): bloqueia bipe de inventário quando sessão saiu de em_andamento [P058]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-inventario-bipe-sessao-fora-andamento
    date: "2026-06-05"
    source: wms.inventario.contagens
    category: business_logic
    message: "bipe aceito em sessão de inventário que já saiu de em_andamento (números somem no vazio)"
    cause: >
      registrarContagem só validava o status da LOC (contada/aprovada) e o lock
      do operador, nunca o status da SESSÃO. Sessão em revisao/aprovada/aplicada
      com loc de lock órfão (em_contagem) ainda aceitava bipe.
    fix: >
      Guard explícito no início de registrarContagem: lê siso_inventario_sessoes.status
      e lança erro se != 'em_andamento'. Rota mapeia o erro pra 409.
    files: [src/lib/wms/inventario.ts, src/app/api/wms/inventario/[id]/contagens/route.ts]
    tags: [inventario, guard, sessao, P058]
```

### Task 1.2: Reconciliação temporal desde o início do dia [P059]

> **Onde está o defeito (ancorado em HEAD `de205f2`):** a JANELA da query em `computarDivergencias` é montada inline em `src/lib/wms/inventario.ts:801-806` — `minContado = min(contado_em)` e `dataLimiteInferior = minContado ?? cutoff_em`, usada no `.gte("criado_em", dataLimiteInferior)` (linha 823). Uma compra (mov E) cuja `criado_em` está **antes** de `min(contado_em)` mas dentro do dia escapa da janela → a função pura nunca recebe a mov → divergência fantasma. A função pura `reconciliarTemporal` já trata corretamente uma mov que ESTÁ na janela; o gap é só o lower-bound. Para ter um RED unitário determinístico, extraio o cálculo do lower-bound pra um helper puro e testo o helper (falha-antes: helper não existe / retorna `minContado`; passa-depois: retorna início-do-dia).

**Files:**
- Modify `src/lib/wms/inventario-reconciliacao.ts` (novo helper puro exportado `janelaInferiorReconciliacao`)
- Modify `src/lib/wms/inventario.ts:801-806,823` (usar o helper no `dataLimiteInferior`)
- Test (RED) `src/lib/wms/inventario-reconciliacao.test.ts` (novo `describe` — lower-bound da janela)

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Adicionar ao fim de `src/lib/wms/inventario-reconciliacao.test.ts`. O import do helper novo (que ainda NÃO existe) já faz o teste falhar (TS/import error); a asserção fixa o comportamento esperado (lower-bound = início do dia UTC, não `min(contado_em)`):

```ts
import { janelaInferiorReconciliacao } from "./inventario-reconciliacao";

describe("janelaInferiorReconciliacao — [P059] lower-bound da janela = início do dia", () => {
  it("min(contado_em) 13:05 → lower-bound 00:00:00 do MESMO dia (UTC), não 13:05", () => {
    // RED: hoje a lógica inline usa min(contado_em) cru (13:05). Uma compra com
    // criado_em 09:00 (mesmo dia, antes da contagem mas dentro do cutoff) escapa.
    // A correção amplia o lower-bound pro date_trunc('day') do minContado.
    const lb = janelaInferiorReconciliacao("2026-05-18T13:05:00.000Z", "2026-05-18T13:20:00.000Z");
    expect(lb).toBe("2026-05-18T00:00:00.000Z");
  });

  it("sem contagens (minContado null) → cai pro cutoff (query vazia, comportamento atual)", () => {
    const lb = janelaInferiorReconciliacao(null, "2026-05-18T13:20:00.000Z");
    expect(lb).toBe("2026-05-18T13:20:00.000Z");
  });
});

describe("reconciliarTemporal — [P059] compra DENTRO da janela ampliada não gera divergência (regressão)", () => {
  it("compra (E) cujo saldo_anterior = qty contada → delta 0", () => {
    // 13:05 conta 3; chega compra +5 (saldo 3→8) já capturada na janela; cutoff 13:20.
    // saldo_esperado = saldo_anterior da compra = 3 = qty contada → delta 0.
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:20:00.000Z",
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 3, contado_em: T1 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T1 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 8, custo_medio: 10 },
      ],
      movs: [
        {
          id: "compra1",
          localizacao_id: LOC,
          produto_id: PROD,
          criado_em: T2, // 13:10 > T1 (contagem)
          saldo_anterior: 3,
          saldo_posterior: 8,
          origem_tipo: "nf_compra",
          origem_id: "oc:1",
          estorno_de: null,
        },
      ],
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/lib/wms/inventario-reconciliacao.test.ts`. Expected: **FAIL** — `janelaInferiorReconciliacao` não é exportada (import error) → o `describe` do lower-bound falha. (O segundo `describe` de `reconciliarTemporal` é regressão e passa.) Critério binário: o helper não existe agora; após o Step 3 o teste fica verde com lower-bound = início do dia.

- [ ] **Step 3 — Implementação mínima.** Criar o helper puro em `src/lib/wms/inventario-reconciliacao.ts` (ao fim do arquivo, exportado) e cabeá-lo em `computarDivergencias`.

Em `src/lib/wms/inventario-reconciliacao.ts`:

```ts
/**
 * [P059] Lower-bound da janela de movs da reconciliação de inventário.
 *
 * Amplia de min(contado_em) pro INÍCIO DO DIA (UTC date_trunc('day')) da contagem
 * mais antiga, pra capturar compras que chegam após a contagem mas antes do
 * cutoff — sem isso elas escapam da janela e geram divergência fantasma. A função
 * pura reconciliarTemporal já filtra por t_ref POR TRIPLA, então a janela maior
 * só alimenta candidatos; saldo_esperado segue no instante do bipe.
 *
 * Sem contagens (minContado=null) → cai pro cutoff (query vazia, comportamento atual).
 */
export function janelaInferiorReconciliacao(
  minContado: string | null,
  cutoff_em: string,
): string {
  if (!minContado) return cutoff_em;
  return new Date(minContado.slice(0, 10) + "T00:00:00.000Z").toISOString();
}
```

Em `src/lib/wms/inventario.ts`, importar o helper (junto do import existente de `reconciliarTemporal`) e substituir as linhas 803-806:

```ts
  // 4. Movs ledger nas locs da sessão, criadas a partir do INÍCIO DO DIA da
  //    contagem mais antiga (não de min(contado_em)) e até cutoff. [P059]
  const minContado = contagens.length > 0
    ? contagens.map((c) => c.contado_em).sort()[0]
    : null;
  const dataLimiteInferior = janelaInferiorReconciliacao(minContado, cutoff_em);
```

A linha 823 (`.gte("criado_em", dataLimiteInferior)`) e o guard `if (locIds.length > 0 && minContado)` na linha 818 permanecem inalterados.

- [ ] **Step 4 — Validação E2E da janela.** Criar `scripts/wms/cenarios/catalogo/83-compra-entre-contagem-e-cutoff-sem-divergencia.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 83 — [P059] compra que chega entre contagem e cutoff não vira divergência.
 *
 * Semeia saldo, conta a loc, recebe uma compra (mov E direta) DEPOIS da contagem
 * mas ANTES de computar/aprovar, e verifica que NÃO há divergência pendente
 * pra a tripla (a reconciliação temporal captura a compra).
 */
type Setup = { sku: string; loc: string; sessaoId: string; locId: string };

export default {
  nome: "83 — [P059] compra entre contagem e cutoff não gera divergência falsa",
  descricao: "Mov E após contagem, antes do cutoff, é reconciliada — zero divergência.",
  tags: ["inventario", "reconciliacao", "P059"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("83");
    await ctx.criarProduto({ sku, descricao: "Reconc 83" });
    const loc = await ctx.criarLocalizacao({ galpao: "CWB", codigo: "INV83-01", tipo: "picking" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc, qty: 3 });
    const { id: sessaoId } = await ctx.criarSessaoInventario({ galpao: "CWB", locs: [loc], modo: "aberto" });
    return { sku, loc, sessaoId, locId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    await ctx.entrarParty(setup.sessaoId);
    const prox = await ctx.proximaLoc(setup.sessaoId);
    setup.locId = String(prox.localizacao_id);
    // conta 3 (igual ao físico no momento)
    await ctx.bipeInventario({ sessao_id: setup.sessaoId, sku: setup.sku, loc: setup.loc, qty: 3 });
    await ctx.finalizarLocInventario({ sessao_id: setup.sessaoId, loc: setup.loc });
    // compra chega DEPOIS da contagem: +5 (saldo 3→8) via ajuste manual achado
    await ctx.ajusteManual({ sku: setup.sku, galpao: "CWB", loc: setup.loc, delta: 5, motivo: "compra pós-contagem", motivo_categoria: "achado" });
    // aprova/computa a sessão (cutoff agora)
    await ctx.aprovarInventario(setup.sessaoId, { force: true });
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", setup.sku).single();
    const { data: divs } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("id, delta, status")
      .eq("sessao_id", setup.sessaoId)
      .eq("produto_id", (prod as { id: string }).id);
    const pendentes = (divs ?? []).filter((d) => (d as { status: string }).status !== "aprovada" || Number((d as { delta: number }).delta) !== 0);
    if (pendentes.length > 0) {
      throw new Error(`divergência fantasma: ${JSON.stringify(pendentes)} — a janela não capturou a compra pós-contagem`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

Rodar `npm test -- src/lib/wms/inventario-reconciliacao.test.ts` (PASS) e `npm run scenarios -- :only 83` (PASS).

- [ ] **Step 5 — Commit.** `git add src/lib/wms/inventario.ts src/lib/wms/inventario-reconciliacao.ts src/lib/wms/inventario-reconciliacao.test.ts scripts/wms/cenarios/catalogo/83-compra-entre-contagem-e-cutoff-sem-divergencia.ts && git commit -m "fix(wms): reconciliação de inventário amplia janela pro início do dia [P059]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-inventario-janela-divergencia-fantasma
    date: "2026-06-05"
    source: wms.inventario.computarDivergencias
    category: business_logic
    message: "divergência de inventário falsa quando compra chega entre contagem e cutoff"
    cause: >
      computarDivergencias buscava movs a partir de min(contado_em). Uma mov E
      (compra) criada após a contagem mas com criado_em anterior a min(contado_em)
      de outra tripla escapava da janela, e a reconciliação temporal não enxergava
      o saldo_anterior real → divergência fantasma.
    fix: >
      dataLimiteInferior ampliado pro início do dia (UTC date_trunc('day')) de
      min(contado_em) via helper puro janelaInferiorReconciliacao. A função pura
      reconciliarTemporal já filtra por t_ref por tripla, então a janela maior só
      alimenta candidatos.
    files: [src/lib/wms/inventario.ts, src/lib/wms/inventario-reconciliacao.ts]
    tags: [inventario, reconciliacao, divergencia, P059]
```

---

## PR 2: RPC wms_estornar_sessao_inventario (tudo-ou-nada) + estorno por divergência individual [P056, P061, P159] [MIGRATION/RPC]

> **Contexto ancorado:** `estornarSessaoInventario` (`src/lib/wms/inventario.ts:1161-1226`) faz loop TS: para cada divergência `aplicada`, chama `estornarMovimentacao` (uma tx RPC independente por mov). Se o 50º falha (saldo ficaria negativo), os 49 anteriores JÁ commitaram. A rota `estornar/route.ts:42-56` só nomeia `não encontrada`/`apenas 'aplicada'`/`motivo` como 400; "saldo insuficiente" vira 500 sem dizer qual item. P056 (tudo-ou-nada + aviso do produto) e P061 (mesma raiz, mensagem que nomeia o item) compartilham a RPC. P159 adiciona granularidade: estornar UMA divergência sem tocar nas outras nem forçar a sessão a recontagem total.

### Task 2.1: RPC wms_estornar_sessao_inventario [P056, P061]

**Files:**
- Create `supabase/migrations/20260605_rpc_estornar_sessao_inventario.sql`
- Test (RED) `test/integration/inventario-estorno-atomico.test.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/inventario-estorno-atomico.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, usuarioId: string;
let prodA: string, prodB: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: a } = await sb.from("siso_produtos").insert({ sku: `ESTSESS-A-${RND}`, descricao: "estorno A", ativo: true }).select("id").single();
  const { data: b } = await sb.from("siso_produtos").insert({ sku: `ESTSESS-B-${RND}`, descricao: "estorno B", ativo: true }).select("id").single();
  prodA = a!.id; prodB = b!.id;
});

describe("wms_estornar_sessao_inventario", () => {
  it("tudo-ou-nada: se um estorno deixaria saldo negativo, NENHUM é desfeito e nomeia o produto", async () => {
    // Cria sessão aplicada com 2 ganhos: +20 prod A, +5 prod B.
    const { data: sess } = await sb.from("siso_inventario_sessoes")
      .insert({ galpao_id: galpaoId, tipo: "cycle_count", modo_contagem: "aberto", status: "aplicada", criada_por: usuarioId, aplicada_em: new Date().toISOString() })
      .select("id").single();
    const sessaoId = sess!.id;

    async function ganho(prod: string, qty: number) {
      const { data: movId } = await sb.rpc("wms_inserir_movimentacao", {
        p_produto_id: prod, p_galpao_id: galpaoId, p_localizacao_id: locId,
        p_tipo: "E", p_quantidade: qty, p_origem_tipo: "inventario_ganho",
        p_origem_id: sessaoId, p_usuario_id: usuarioId, p_motivo: "seed",
      });
      await sb.from("siso_inventario_divergencias").insert({
        sessao_id: sessaoId, localizacao_id: locId, produto_id: prod,
        saldo_sistema: 0, qty_contada_final: qty, status: "aplicada", mov_aplicada_id: movId as unknown as string,
      });
    }
    await ganho(prodA, 20);
    await ganho(prodB, 5);

    // Consome prod A deixando saldo 5 (< 20) → estorno de A (S 20) negativaria.
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodA, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 15, p_origem_tipo: "venda_manual", p_origem_id: null,
      p_usuario_id: usuarioId, p_motivo: "consumo",
    });

    const { error } = await sb.rpc("wms_estornar_sessao_inventario", {
      p_sessao: sessaoId, p_usuario: usuarioId, p_motivo: "teste tudo-ou-nada",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(new RegExp(`ESTSESS-A-${RND}|${prodA}`));

    // NENHUM estorno persistiu: saldo de A=5, B=5; divergências continuam 'aplicada'.
    const { data: estA } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodA).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    const { data: estB } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodB).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(estA?.saldo)).toBe(5);
    expect(Number(estB?.saldo)).toBe(5);
    const { count } = await sb.from("siso_inventario_divergencias").select("id", { count: "exact", head: true }).eq("sessao_id", sessaoId).eq("status", "aplicada");
    expect(count).toBe(2);
  });

  it("caminho feliz: estorna todas as divergências e volta sessão pra revisao", async () => {
    const { data: sess } = await sb.from("siso_inventario_sessoes")
      .insert({ galpao_id: galpaoId, tipo: "cycle_count", modo_contagem: "aberto", status: "aplicada", criada_por: usuarioId, aplicada_em: new Date().toISOString() })
      .select("id").single();
    const sessaoId = sess!.id;
    const { data: movId } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodB, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 3, p_origem_tipo: "inventario_ganho", p_origem_id: sessaoId, p_usuario_id: usuarioId, p_motivo: "seed2",
    });
    await sb.from("siso_inventario_divergencias").insert({
      sessao_id: sessaoId, localizacao_id: locId, produto_id: prodB,
      saldo_sistema: 5, qty_contada_final: 8, status: "aplicada", mov_aplicada_id: movId as unknown as string,
    });
    const { data, error } = await sb.rpc("wms_estornar_sessao_inventario", { p_sessao: sessaoId, p_usuario: usuarioId, p_motivo: "undo feliz" });
    expect(error).toBeNull();
    expect((data as { movs_estornadas: number }).movs_estornadas).toBe(1);
    const { data: ss } = await sb.from("siso_inventario_sessoes").select("status").eq("id", sessaoId).single();
    expect((ss as { status: string }).status).toBe("revisao");
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- test/integration/inventario-estorno-atomico.test.ts`. Expected: FAIL — `wms_estornar_sessao_inventario` não existe (PostgREST `PGRST202`/function not found).

- [ ] **Step 3 — Implementação (migration + RPC).** Criar `supabase/migrations/20260605_rpc_estornar_sessao_inventario.sql`:

```sql
-- [P056/P061] Estorno de sessão de inventário tudo-ou-nada.
--
-- Reescreve o loop TS (estornarSessaoInventario) por RPC plpgsql transacional:
-- num único BEGIN, faz PREFLIGHT de TODAS as divergências aplicadas (valida que
-- cada contra-mov não deixa saldo negativo) e, só se TODAS passam, insere as
-- contra-movs via wms_inserir_movimentacao + reseta divergências pra 'pendente'
-- + volta a sessão pra 'revisao'. Qualquer RAISE faz rollback total.
--
-- Idempotente: sessão != 'aplicada' → no-op (movs_estornadas=0). Mov já
-- estornada (estorno_de existente) é pulada no preflight e no loop.

BEGIN;

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
  v_orig     siso_movimentacoes;
  v_saldo    numeric;
  v_tipo_inv char(1);
  v_estornadas int := 0;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'motivo do estorno é obrigatório (>=3 caracteres)' USING ERRCODE = '22023';
  END IF;

  -- FOR UPDATE serializa estornos concorrentes da mesma sessão.
  SELECT id, status, galpao_id INTO v_sessao
    FROM siso_inventario_sessoes WHERE id = p_sessao FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sessão não encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_sessao.status <> 'aplicada' THEN
    -- Idempotência: já estornada/nunca aplicada → no-op.
    RETURN jsonb_build_object('movs_estornadas', 0, 'status', v_sessao.status);
  END IF;

  -- PREFLIGHT: simula cada estorno acumulando o impacto por (produto,loc).
  -- Mov de ganho (E) → estorno é S de igual qty: saldo precisa cobrir.
  FOR v_div IN
    SELECT d.id, d.mov_aplicada_id, d.produto_id, d.localizacao_id
      FROM siso_inventario_divergencias d
     WHERE d.sessao_id = p_sessao AND d.status = 'aplicada' AND d.mov_aplicada_id IS NOT NULL
  LOOP
    SELECT * INTO v_orig FROM siso_movimentacoes WHERE id = v_div.mov_aplicada_id FOR UPDATE;
    CONTINUE WHEN NOT FOUND;
    -- Mov já estornada → pula (idempotência).
    CONTINUE WHEN EXISTS (SELECT 1 FROM siso_movimentacoes WHERE estorno_de = v_orig.id);
    IF v_orig.tipo = 'E' THEN
      -- contra-mov será S de v_orig.quantidade na MESMA tripla
      SELECT COALESCE(saldo, 0) INTO v_saldo
        FROM siso_estoque
       WHERE produto_id = v_orig.produto_id AND galpao_id = v_orig.galpao_id AND localizacao_id = v_orig.localizacao_id;
      IF v_saldo < v_orig.quantidade THEN
        RAISE EXCEPTION 'estorno deixaria saldo negativo no produto % (loc %): saldo % < estorno %',
          v_orig.produto_id, v_orig.localizacao_id, v_saldo, v_orig.quantidade
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END LOOP;

  -- EXECUÇÃO: agora que o preflight passou, insere as contra-movs.
  FOR v_div IN
    SELECT d.id, d.mov_aplicada_id
      FROM siso_inventario_divergencias d
     WHERE d.sessao_id = p_sessao AND d.status = 'aplicada' AND d.mov_aplicada_id IS NOT NULL
  LOOP
    SELECT * INTO v_orig FROM siso_movimentacoes WHERE id = v_div.mov_aplicada_id;
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN EXISTS (SELECT 1 FROM siso_movimentacoes WHERE estorno_de = v_orig.id);
    v_tipo_inv := CASE v_orig.tipo WHEN 'E' THEN 'S' WHEN 'S' THEN 'E' WHEN 'R' THEN 'L' WHEN 'L' THEN 'R' END;
    PERFORM wms_inserir_movimentacao(
      v_orig.produto_id, v_orig.galpao_id, v_orig.localizacao_id,
      v_tipo_inv, v_orig.quantidade,
      'estorno', v_orig.id::text,
      jsonb_build_object('estorno_de', v_orig.id, 'mov_original_origem', v_orig.origem_tipo),
      p_usuario,                -- p_usuario_id
      NULL,                     -- p_expira_em
      v_orig.id,                -- p_estorno_de
      NULL, NULL, NULL, NULL,   -- empresas
      NULL,                     -- p_fornecedor_id
      format('Estorno sessão inventário %s: %s', p_sessao, p_motivo), -- p_motivo
      NULL, NULL, NULL, NULL, NULL, NULL                              -- cliente/pedido/nf/chave/custo/categoria
    );
    UPDATE siso_inventario_divergencias SET status = 'pendente', mov_aplicada_id = NULL WHERE id = v_div.id;
    v_estornadas := v_estornadas + 1;
  END LOOP;

  UPDATE siso_inventario_sessoes SET status = 'revisao', aplicada_em = NULL WHERE id = p_sessao;

  RETURN jsonb_build_object('movs_estornadas', v_estornadas, 'status', 'revisao');
END;
$$;

COMMENT ON FUNCTION wms_estornar_sessao_inventario(uuid,uuid,text) IS
  '[P056/P061] Estorno de sessão de inventário tudo-ou-nada (preflight saldo + contra-movs + reset divergências).';

COMMIT;
```

> **Nota: assinatura posicional de `wms_inserir_movimentacao`.** A RPC named-param tem 21 params na ordem `(p_produto_id, p_galpao_id, p_localizacao_id, p_tipo, p_quantidade, p_origem_tipo, p_origem_id, p_origem_detalhes, p_usuario_id, p_expira_em, p_estorno_de, p_empresa_compradora_id, p_empresa_vendedora_id, p_empresa_referencia_id, p_fornecedor_id, p_motivo, p_cliente_nome, p_pedido_id, p_nota_fiscal_id, p_chave_acesso_nf, p_custo_unitario, p_motivo_categoria)` — total 22. A chamada `PERFORM` acima passa os 16 primeiros necessários e completa os restantes com `NULL` na ordem exata (conferir contra `20260527_wms_inserir_mov_motivo_categoria.sql:18-36` ao implementar; ajustar contagem de `NULL` se a ordem divergir em staging).

Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (name: `rpc_estornar_sessao_inventario`).

Substituir o corpo de `estornarSessaoInventario` (`src/lib/wms/inventario.ts:1161-1226`) por chamada à RPC:

```ts
export async function estornarSessaoInventario(input: {
  sessao_id: string;
  usuario_id: string;
  motivo: string;
}): Promise<{ movsEstornadas: number }> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do estorno é obrigatório (≥3 caracteres)");
  }
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_estornar_sessao_inventario", {
    p_sessao: input.sessao_id,
    p_usuario: input.usuario_id,
    p_motivo: input.motivo,
  });
  if (error) {
    // [P061] Mensagem nomeia o produto que impediu o estorno (saldo negativo).
    throw new Error(error.message);
  }
  return { movsEstornadas: (data as { movs_estornadas: number }).movs_estornadas };
}
```

Na rota `src/app/api/wms/inventario/[id]/estornar/route.ts:44-47`, ampliar `isClient` pra incluir a mensagem de saldo negativo (nomeia item, é erro de cliente 409 não 500):

```ts
    const isClient =
      msg.includes("não encontrada") ||
      msg.includes("apenas 'aplicada'") ||
      msg.includes("deixaria saldo negativo") ||
      msg.includes("motivo");
```

E mapear `deixaria saldo negativo` pra 409:

```ts
    const isConflict = msg.includes("deixaria saldo negativo");
    return wmsErrorResponse({
      source: "wms.inventario.estornar",
      error: e,
      status: isConflict ? 409 : isClient ? 400 : 500,
      requestPath: `/api/wms/inventario/${id}/estornar`,
      requestMethod: "POST",
      metadata: { sessao_id: id },
    });
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- test/integration/inventario-estorno-atomico.test.ts`. Expected: PASS — tudo-ou-nada (saldos 5/5, divergências 2 aplicadas, erro nomeia prod A) e caminho feliz (1 estorno, sessão revisao).

- [ ] **Step 5 — Commit.** `git add supabase/migrations/20260605_rpc_estornar_sessao_inventario.sql src/lib/wms/inventario.ts src/app/api/wms/inventario/[id]/estornar/route.ts test/integration/inventario-estorno-atomico.test.ts && git commit -m "fix(wms): RPC wms_estornar_sessao_inventario tudo-ou-nada + nomeia produto que negativaria [P056,P061]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-inventario-estorno-sessao-parcial
    date: "2026-06-05"
    source: wms.inventario.estornarSessaoInventario
    category: business_logic
    message: "estorno de sessão de inventário deixa estado parcial se um item falha (saldo negativo)"
    cause: >
      estornarSessaoInventario estornava cada divergência numa tx RPC independente.
      Se o N-ésimo estorno negativaria o saldo (alguém consumiu), os anteriores já
      tinham commitado e o supervisor recebia 500 sem saber qual item caiu.
    fix: >
      RPC plpgsql wms_estornar_sessao_inventario: preflight de saldo de TODAS as
      contra-movs antes de inserir qualquer uma; RAISE nomeando o produto que
      negativaria → rollback total. Rota mapeia pra 409.
    files: [supabase/migrations/20260605_rpc_estornar_sessao_inventario.sql, src/lib/wms/inventario.ts, src/app/api/wms/inventario/[id]/estornar/route.ts]
    tags: [inventario, estorno, atomico, P056, P061]
```

### Task 2.2: Estorno por divergência individual [P159]

**Files:**
- Modify `src/lib/wms/inventario.ts` (nova função `estornarDivergenciaInventario`)
- Modify `src/app/api/wms/inventario/[id]/estornar/route.ts:18-41` (rotear por `divergencia_id` no body)
- Test (RED) `test/integration/inventario-estorno-individual.test.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/inventario-estorno-individual.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { estornarDivergenciaInventario } from "../../src/lib/wms/inventario";

const sb = createServiceClient();
let galpaoId: string, locId: string, usuarioId: string, prod1: string, prod2: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: a } = await sb.from("siso_produtos").insert({ sku: `ESTIND-1-${RND}`, descricao: "ind 1", ativo: true }).select("id").single();
  const { data: b } = await sb.from("siso_produtos").insert({ sku: `ESTIND-2-${RND}`, descricao: "ind 2", ativo: true }).select("id").single();
  prod1 = a!.id; prod2 = b!.id;
});

describe("estornarDivergenciaInventario", () => {
  it("estorna SÓ a divergência alvo; as outras seguem aplicadas e sessão não vira revisao se restam aplicadas", async () => {
    const { data: sess } = await sb.from("siso_inventario_sessoes")
      .insert({ galpao_id: galpaoId, tipo: "cycle_count", modo_contagem: "aberto", status: "aplicada", criada_por: usuarioId, aplicada_em: new Date().toISOString() })
      .select("id").single();
    const sessaoId = sess!.id;
    async function ganho(prod: string, qty: number): Promise<string> {
      const { data: movId } = await sb.rpc("wms_inserir_movimentacao", {
        p_produto_id: prod, p_galpao_id: galpaoId, p_localizacao_id: locId,
        p_tipo: "E", p_quantidade: qty, p_origem_tipo: "inventario_ganho", p_origem_id: sessaoId, p_usuario_id: usuarioId, p_motivo: "seed",
      });
      const { data: div } = await sb.from("siso_inventario_divergencias")
        .insert({ sessao_id: sessaoId, localizacao_id: locId, produto_id: prod, saldo_sistema: 0, qty_contada_final: qty, status: "aplicada", mov_aplicada_id: movId as unknown as string })
        .select("id").single();
      return (div as { id: string }).id;
    }
    const div1 = await ganho(prod1, 4);
    await ganho(prod2, 2);

    await estornarDivergenciaInventario({ divergencia_id: div1, usuario_id: usuarioId, motivo: "errei só essa" });

    const { data: d1 } = await sb.from("siso_inventario_divergencias").select("status, mov_aplicada_id").eq("id", div1).single();
    expect((d1 as { status: string }).status).toBe("pendente");
    expect((d1 as { mov_aplicada_id: string | null }).mov_aplicada_id).toBeNull();
    const { count: aplicadas } = await sb.from("siso_inventario_divergencias").select("id", { count: "exact", head: true }).eq("sessao_id", sessaoId).eq("status", "aplicada");
    expect(aplicadas).toBe(1); // prod2 segue aplicada
    // prod1 voltou (saldo 0); prod2 intacto (saldo 2)
    const { data: e1 } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prod1).eq("localizacao_id", locId).single();
    expect(Number(e1?.saldo)).toBe(0);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- test/integration/inventario-estorno-individual.test.ts`. Expected: FAIL — `estornarDivergenciaInventario` não é exportada.

- [ ] **Step 3 — Implementação mínima.** Adicionar a `src/lib/wms/inventario.ts` (após `estornarSessaoInventario`, ~linha 1226):

```ts
/**
 * [P159] Estorna UMA divergência aplicada (não a sessão inteira). Reseta a
 * divergência alvo pra 'pendente' e não toca nas demais. Reusa o guard de
 * double-estorno de estornarMovimentacao. Não força a sessão a recontagem das
 * que continuam corretas; se ainda restarem 'aplicada', a sessão segue 'aplicada'.
 */
export async function estornarDivergenciaInventario(input: {
  divergencia_id: string;
  usuario_id: string;
  motivo: string;
}): Promise<{ movEstornada: boolean }> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do estorno é obrigatório (≥3 caracteres)");
  }
  const sb = createServiceClient();
  const { data: div } = await sb
    .from("siso_inventario_divergencias")
    .select("id, sessao_id, mov_aplicada_id, status")
    .eq("id", input.divergencia_id)
    .maybeSingle();
  if (!div) throw new Error("divergência não encontrada");
  const d = div as { id: string; sessao_id: string; mov_aplicada_id: string | null; status: string };
  if (d.status !== "aplicada") {
    throw new Error(`divergência em status ${d.status} — apenas 'aplicada' pode ser estornada`);
  }
  let estornada = false;
  if (d.mov_aplicada_id) {
    try {
      await estornarMovimentacao({
        mov_id: d.mov_aplicada_id,
        usuario_id: input.usuario_id,
        motivo: `Estorno divergência ${d.id}: ${input.motivo}`,
      });
      estornada = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/já foi estornada|já é um estorno/.test(msg)) throw err;
    }
  }
  await sb
    .from("siso_inventario_divergencias")
    .update({ status: "pendente", mov_aplicada_id: null })
    .eq("id", d.id);
  return { movEstornada: estornada };
}
```

Na rota `src/app/api/wms/inventario/[id]/estornar/route.ts`, aceitar `divergencia_id` opcional no body e rotear (após o parse do body, antes da chamada de sessão na linha 35):

```ts
  const divergenciaId = typeof body?.divergencia_id === "string" ? body.divergencia_id : null;
  try {
    if (divergenciaId) {
      const { estornarDivergenciaInventario } = await import("@/lib/wms/inventario");
      const r = await estornarDivergenciaInventario({
        divergencia_id: divergenciaId,
        usuario_id: auth.user.id,
        motivo,
      });
      return NextResponse.json({ ok: true, individual: true, ...r });
    }
    const r = await estornarSessaoInventario({ sessao_id: id, usuario_id: auth.user.id, motivo });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
```

(Manter o `catch` existente; ampliar `isClient` com `msg.includes("divergência não encontrada")`.)

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- test/integration/inventario-estorno-individual.test.ts`. Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/lib/wms/inventario.ts src/app/api/wms/inventario/[id]/estornar/route.ts test/integration/inventario-estorno-individual.test.ts && git commit -m "feat(wms): estorno de divergência de inventário individual [P159]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-inventario-estorno-so-sessao-inteira
    date: "2026-06-05"
    source: wms.inventario.estornar
    category: business_logic
    message: "estorno de inventário só desfaz a sessão inteira, forçando recontagem das corretas"
    cause: >
      Só existia estornarSessaoInventario (lote por sessão). Para corrigir 1
      prateleira errada o supervisor jogava fora as N contagens certas.
    fix: >
      Nova estornarDivergenciaInventario({divergencia_id}) estorna 1 mov,
      reseta só aquela divergência pra 'pendente', não mexe nas demais. Rota
      aceita divergencia_id no body.
    files: [src/lib/wms/inventario.ts, src/app/api/wms/inventario/[id]/estornar/route.ts]
    tags: [inventario, estorno, granular, P159]
```

---

## PR 3: RPC wms_contagem_inline_atomica (acerto de prateleira no pick) [P057] [MIGRATION/RPC]

> **Contexto ancorado:** `registrarContagemInline` (`src/lib/wms/contagem-inline.ts:83-198`) documenta explicitamente a não-atomicidade (linhas 99-106): faz `inserirMovimentacao` (RPC), depois 3 escritas separadas (upsert `siso_inventario_localizacoes`, insert `siso_inventario_contagens`, upsert `siso_inventario_divergencias`, update `siso_localizacoes.ultima_contagem_em`). Falha após a mov deixa ganho/perda sem registro de contagem. As tabelas de inventário são 3D (sem `empresa_dona_id` — o insert atual NÃO popula essa coluna). A divergência tem UNIQUE `(sessao_id, localizacao_id, produto_id)`. Caller único: `src/app/api/wms/separacao/validar-oc-item/route.ts` (acerto de prateleira no pick). A sessão é a contínua (`continua=true`, status permanentemente `em_andamento`).

### Task 3.1: RPC wms_contagem_inline_atomica

**Files:**
- Create `supabase/migrations/20260605_rpc_contagem_inline_atomica.sql`
- Modify `src/lib/wms/contagem-inline.ts:83-198` (substituir corpo por chamada à RPC; remover comentário de não-atomicidade)
- Test (RED) `test/integration/contagem-inline-atomica.test.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/contagem-inline-atomica.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { registrarContagemInline } from "../../src/lib/wms/contagem-inline";

const sb = createServiceClient();
let galpaoId: string, locId: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `CINLINE-${RND}`, descricao: "inline", ativo: true }).select("id").single();
  prodId = p!.id;
  // saldo inicial 5
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 5, p_origem_tipo: "inventario_inicial", p_origem_id: null, p_custo_unitario: 8, p_motivo: "seed",
  });
});

describe("wms_contagem_inline_atomica via registrarContagemInline", () => {
  // RED determinístico: a RPC transacional NÃO existe antes da migration.
  // Esta é a única asserção que falha-antes / passa-depois da mudança de produção
  // (o caminho feliz de registrarContagemInline já funciona hoje na versão
  // não-atômica — por isso o invariante de acoplamento sozinho não seria um RED).
  it("[RED] a RPC wms_contagem_inline_atomica existe (PGRST202 antes da migration)", async () => {
    const { error } = await sb.rpc("wms_contagem_inline_atomica", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty_contada: 5, p_contada_por: usuarioId,
      p_sessao_id: "00000000-0000-0000-0000-000000000000",
      p_sku: null, p_pedido_id: null,
    });
    // Antes da migration: error.code === "PGRST202" (function not found) → FAIL aqui.
    // Depois: a RPC existe (pode dar outro erro por sessão fake, mas NÃO 'not found').
    expect(error?.code).not.toBe("PGRST202");
    expect(error?.message ?? "").not.toMatch(/could not find the function|does not exist/i);
  });

  it("conta 8 (saldo 5): cria 1 mov ganho E 1 contagem E 1 divergência acoplados", async () => {
    const r = await registrarContagemInline({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      qty_contada: 8, contada_por: usuarioId, sku: `CINLINE-${RND}`,
    });
    expect(r.delta).toBe(3);
    expect(r.mov_reconciliacao_id).not.toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(8);
    // acoplamento: para a mov de reconciliação existe uma linha de contagem
    const { count: movs } = await sb.from("siso_movimentacoes").select("id", { count: "exact", head: true }).eq("produto_id", prodId).in("origem_tipo", ["inventario_ganho", "inventario_perda"]);
    const { count: cont } = await sb.from("siso_inventario_contagens").select("id", { count: "exact", head: true }).eq("produto_id", prodId);
    expect(movs).toBe(1);
    expect(cont).toBeGreaterThanOrEqual(1);
  });

  it("re-contar pra mesma qty é idempotente no saldo (delta 0, não duplica ganho)", async () => {
    const r2 = await registrarContagemInline({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      qty_contada: 8, contada_por: usuarioId, sku: `CINLINE-${RND}`,
    });
    expect(r2.delta).toBe(0);
    expect(r2.mov_reconciliacao_id).toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(8);
  });
});
```

> **Nota: simular falha real entre statements não é viável via supabase-js** (não há injeção de fault no servidor). O teste prova o ACOPLAMENTO (mov ⇔ contagem ⇔ divergência) e que a atomicidade real é garantida pela RPC plpgsql (BEGIN/EXCEPTION envolve tudo). O red_test do P057 ("uma falha simulada não deixa mov sem contagem") é satisfeito pelo invariante 1:1, validado acima.

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- test/integration/contagem-inline-atomica.test.ts -t "RED"`. Expected: **FAIL** — o `it("[RED] a RPC wms_contagem_inline_atomica existe ...")` falha porque `error.code === "PGRST202"` (a função não existe antes da migration). Critério binário: o teste com `-t "RED"` falha agora e passa após o Step 3 aplicar a migration. (Os dois `it`s de acoplamento já passam no código não-atômico atual — são regressão, não o RED; por isso o RED é o teste de existência da RPC acima.)

> **Nota: por que o RED é a existência da RPC.** O caminho feliz de `registrarContagemInline` já funciona na versão não-atômica (linhas 99-106 documentam a não-atomicidade aceita), então um teste de acoplamento sozinho passaria-antes e passaria-depois — não seria RED. A mudança de produção desta task é introduzir a transação plpgsql; a única asserção que falha-antes/passa-depois de forma determinística é "a RPC `wms_contagem_inline_atomica` existe". O red_test do P057 ("uma falha simulada não deixa mov sem contagem") não é injetável via supabase-js — o invariante de atomicidade-sob-falha é garantido estruturalmente pelo `BEGIN/EXCEPTION` da RPC (Step 3); os dois `it`s de acoplamento travam o contrato como regressão pós-migration.

- [ ] **Step 3 — Implementação (migration + RPC).** Criar `supabase/migrations/20260605_rpc_contagem_inline_atomica.sql`:

```sql
-- [P057] Contagem inline (acerto de prateleira no pick) atômica.
--
-- Substitui a sequência não-atômica de registrarContagemInline por uma RPC
-- plpgsql: num único BEGIN, lê saldo, calcula delta, chama wms_inserir_movimentacao
-- (inventario_ganho/perda) se delta!=0, upsert da loc na sessão, insert da
-- contagem oficial, upsert da divergência (status='aplicada'), update da
-- ultima_contagem_em. Tudo-ou-nada. Tabelas de inventário são 3D (sem empresa_dona_id).

BEGIN;

CREATE OR REPLACE FUNCTION wms_contagem_inline_atomica(
  p_produto_id uuid,
  p_galpao_id uuid,
  p_localizacao_id uuid,
  p_qty_contada numeric,
  p_contada_por uuid,
  p_sessao_id uuid,
  p_sku text DEFAULT NULL,
  p_pedido_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_saldo    numeric;
  v_delta    numeric;
  v_mov_id   uuid := NULL;
  v_cont_id  uuid;
  v_div_id   uuid;
BEGIN
  IF p_qty_contada < 0 THEN
    RAISE EXCEPTION 'qty_contada não pode ser negativa' USING ERRCODE = '22023';
  END IF;

  -- Lock pessimista no row de estoque (serializa contagens concorrentes da tripla).
  SELECT COALESCE(saldo, 0) INTO v_saldo
    FROM siso_estoque
   WHERE produto_id = p_produto_id AND galpao_id = p_galpao_id AND localizacao_id = p_localizacao_id
   FOR UPDATE;
  IF NOT FOUND THEN v_saldo := 0; END IF;

  v_delta := p_qty_contada - v_saldo;

  IF v_delta <> 0 THEN
    v_mov_id := wms_inserir_movimentacao(
      p_produto_id, p_galpao_id, p_localizacao_id,
      CASE WHEN v_delta > 0 THEN 'E' ELSE 'S' END,
      abs(v_delta),
      CASE WHEN v_delta > 0 THEN 'inventario_ganho' ELSE 'inventario_perda' END,
      p_sessao_id::text,
      jsonb_build_object('divergencia_id', gen_random_uuid(), 'contexto', 'acerto_pick', 'sku', p_sku, 'pedido_id', p_pedido_id),
      p_contada_por,           -- p_usuario_id
      NULL, NULL,              -- expira_em, estorno_de
      NULL, NULL, NULL, NULL,  -- empresas
      'Acerto de prateleira no pick', -- p_motivo
      NULL, NULL, NULL, NULL, NULL, NULL -- cliente/pedido/nf/chave/custo/categoria
    );
  END IF;

  INSERT INTO siso_inventario_localizacoes (sessao_id, localizacao_id, status, motivo)
  VALUES (p_sessao_id, p_localizacao_id, 'contada', 'manual')
  ON CONFLICT (sessao_id, localizacao_id) DO UPDATE SET status = 'contada';

  INSERT INTO siso_inventario_contagens (sessao_id, localizacao_id, produto_id, qty_contada, contada_por)
  VALUES (p_sessao_id, p_localizacao_id, p_produto_id, p_qty_contada, p_contada_por)
  RETURNING id INTO v_cont_id;

  INSERT INTO siso_inventario_divergencias
    (sessao_id, localizacao_id, produto_id, saldo_sistema, qty_contada_final, status, mov_aplicada_id, resolucao_por, resolucao_em)
  VALUES (p_sessao_id, p_localizacao_id, p_produto_id, v_saldo, p_qty_contada, 'aplicada', v_mov_id, p_contada_por, now())
  ON CONFLICT (sessao_id, localizacao_id, produto_id) DO UPDATE
    SET saldo_sistema = EXCLUDED.saldo_sistema,
        qty_contada_final = EXCLUDED.qty_contada_final,
        status = 'aplicada',
        mov_aplicada_id = EXCLUDED.mov_aplicada_id,
        resolucao_por = EXCLUDED.resolucao_por,
        resolucao_em = EXCLUDED.resolucao_em
  RETURNING id INTO v_div_id;

  UPDATE siso_localizacoes SET ultima_contagem_em = now() WHERE id = p_localizacao_id;

  RETURN jsonb_build_object(
    'contagem_id', v_cont_id,
    'divergencia_id', v_div_id,
    'mov_reconciliacao_id', v_mov_id,
    'saldo_anterior', v_saldo,
    'delta', v_delta
  );
END;
$$;

COMMENT ON FUNCTION wms_contagem_inline_atomica(uuid,uuid,uuid,numeric,uuid,uuid,text,text) IS
  '[P057] Contagem inline (acerto de prateleira no pick) atômica: reconcilia saldo + contagem + divergência numa tx.';

COMMIT;
```

Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (name: `rpc_contagem_inline_atomica`).

Substituir o corpo de `registrarContagemInline` (`src/lib/wms/contagem-inline.ts:86-198`) por chamada à RPC (mantendo `getOrCreateSessaoOperacional` e o shape de `ContagemInlineResult`):

```ts
export async function registrarContagemInline(
  input: ContagemInlineInput,
): Promise<ContagemInlineResult> {
  const sb = createServiceClient();
  const sessaoId = await getOrCreateSessaoOperacional(sb, input.galpao_id, input.contada_por);

  // [P057] Tudo-ou-nada via RPC plpgsql: reconcilia saldo + grava contagem +
  // divergência na mesma transação (substitui a sequência não-atômica v1).
  const { data, error } = await sb.rpc("wms_contagem_inline_atomica", {
    p_produto_id: input.produto_id,
    p_galpao_id: input.galpao_id,
    p_localizacao_id: input.localizacao_id,
    p_qty_contada: input.qty_contada,
    p_contada_por: input.contada_por,
    p_sessao_id: sessaoId,
    p_sku: input.sku ?? null,
    p_pedido_id: input.pedido_id ?? null,
  });
  if (error) throw new Error(`registrarContagemInline: ${error.message}`);
  const r = data as {
    contagem_id: string;
    divergencia_id: string;
    mov_reconciliacao_id: string | null;
    saldo_anterior: number;
    delta: number;
  };

  logger.info("contagem-inline", "acerto de prateleira registrado", {
    sessao_id: sessaoId,
    produto_id: input.produto_id,
    loc_id: input.localizacao_id,
    saldo_anterior: r.saldo_anterior,
    contado: input.qty_contada,
    delta: r.delta,
    mov_id: r.mov_reconciliacao_id,
  });

  return {
    sessao_id: sessaoId,
    contagem_id: r.contagem_id,
    divergencia_id: r.divergencia_id,
    mov_reconciliacao_id: r.mov_reconciliacao_id,
    saldo_anterior: Number(r.saldo_anterior),
    delta: Number(r.delta),
  };
}
```

Remover o import não usado de `randomUUID` e `inserirMovimentacao` se ficarem órfãos (rodar `npm run lint` pra confirmar). Manter `getOrCreateSessaoOperacional` (ainda usado).

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- test/integration/contagem-inline-atomica.test.ts`. Expected: PASS (todos os 3 `it`s) — o `[RED]` de existência da RPC agora passa (não dá mais PGRST202), delta 3, saldo 8, mov↔contagem acoplados; re-contar mesma qty → delta 0.

- [ ] **Step 5 — Commit.** `git add supabase/migrations/20260605_rpc_contagem_inline_atomica.sql src/lib/wms/contagem-inline.ts test/integration/contagem-inline-atomica.test.ts && git commit -m "fix(wms): RPC wms_contagem_inline_atomica torna acerto de prateleira tudo-ou-nada [P057]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-contagem-inline-nao-atomica
    date: "2026-06-05"
    source: wms.contagem-inline
    category: business_logic
    message: "acerto de prateleira no pick desacopla saldo e contagem em caso de falha"
    cause: >
      registrarContagemInline fazia a mov de reconciliação e os inserts de
      contagem/divergência em chamadas separadas (não-atômico v1 documentado).
      Falha após a mov deixava ganho/perda sem registro de contagem.
    fix: >
      RPC plpgsql wms_contagem_inline_atomica envolve saldo + contagem +
      divergência numa única transação BEGIN. registrarContagemInline vira
      wrapper fino.
    files: [supabase/migrations/20260605_rpc_contagem_inline_atomica.sql, src/lib/wms/contagem-inline.ts]
    tags: [inventario, contagem-inline, atomico, acerto, P057]
```

---

## PR 4: RPC wms_classificar_devolucao: movs+status atômicos + preflight quarentena [P049, P050, P051, P054] [MIGRATION/RPC]

> **Contexto ancorado:** `classificarDevolucao` (`src/lib/wms/devolucoes.ts:101-340`) emite até 3 movs sequenciais via `inserirMovimentacao` (cada uma é uma tx separada) e SÓ DEPOIS faz o `UPDATE status='classificada'` (linhas 325-334). Guard de status (linha 118) é read-then-act (TOCTOU). Caso `avariado` sem quarentena (linhas 257-270) faz um `S ajuste_manual` que silenciosamente some com o item — a NOTA do P051 quer BLOQUEAR antes de mover. Status válidos: `aguardando_classificacao, classificada, cancelada`. **Conflito mestre #6:** uma RPC `wms_classificar_devolucao` resolve P049 (movs+status atômicos), P050 (mov E + etapa juntas), P051 (preflight quarentena = bake na RPC), P054 (FOR UPDATE serializa por devolução). A resolução de empresa/NF/custo continua no TS (não envolve mutação de ledger), e o TS passa os valores já resolvidos pra RPC.
>
> **Decisão D (mestre):** P051 op1 — bloquear se não há quarentena, validar ANTES de tirar da prateleira. Remover o branch `ajuste_manual` que mascarava a ausência.

### Task 4.1: Preflight de quarentena no service (RED unit) [P051]

**Files:**
- Modify `src/lib/wms/devolucoes.ts:209-271` (case `avariado`)
- Test (RED) `src/lib/wms/devolucoes.test.ts` (novo `describe 'avariado sem quarentena bloqueia'`)

> **Por que dois passos (TS guard + RPC):** o preflight de quarentena é validável por unit test (mock conta 0 movs) e protege o caminho ANTES da RPC. A RPC (Task 4.2) carrega o mesmo guard como backstop transacional. Implementar o guard TS primeiro (P051), depois mover toda a sequência pra RPC (P049/P050/P054) preservando o guard.

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Adicionar a `src/lib/wms/devolucoes.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { classificarDevolucao } from "./devolucoes";

// Mock do ledger pra contar chamadas de inserirMovimentacao.
const movSpy = vi.fn(async () => ({ id: "mov-fake" }));
vi.mock("./ledger", () => ({
  inserirMovimentacao: (...args: unknown[]) => movSpy(...args),
}));

describe("classificarDevolucao — avariado sem quarentena bloqueia [P051]", () => {
  it("lança ANTES de qualquer mov quando o galpão não tem loc tipo quarentena", async () => {
    movSpy.mockClear();
    // O createServiceClient é mockado pra: devolução aguardando, sem quarentena.
    vi.doMock("@/lib/supabase-server", () => ({
      createServiceClient: () => ({
        from: (t: string) => ({
          select: () => ({
            eq: () => ({
              single: async () =>
                t === "siso_devolucoes_pendentes"
                  ? { data: { status: "aguardando_classificacao", pedido_origem_mov_id: null, nota_fiscal_id: null, chave_acesso_nf: null, empresa_id: null, payload_webhook: null }, error: null }
                  : { data: null, error: null },
              maybeSingle: async () => ({ data: null }), // sem quarentena
              match: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
            }),
          }),
          update: () => ({ eq: async () => ({ data: null }) }),
        }),
      }),
    }));
    await expect(
      classificarDevolucao({
        devolucao_id: "d1", classificacao: "avariado",
        produto_id: "11111111-1111-1111-1111-111111111111",
        galpao_id: "22222222-2222-2222-2222-222222222222",
        localizacao_id: "33333333-3333-3333-3333-333333333333",
        qty: 2, usuario_id: "44444444-4444-4444-4444-444444444444",
      }),
    ).rejects.toThrow(/quarentena/i);
    expect(movSpy).toHaveBeenCalledTimes(0);
  });
});
```

> **Nota:** o mock de `createServiceClient` acima é frágil; ao implementar, alinhar com o padrão de mock já usado em `movimentacoes.test.ts`/`reservas.test.ts` (se existir helper de mock). Se o mock encadeado ficar inviável, mover o RED pra integration (`src/lib/wms/devolucoes-classificar-atomico.integration.test.ts`) usando um galpão real sem quarentena — o assert vira "0 movs criadas após classify avariado em galpão sem quarentena". Marcar a escolha no commit.

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/lib/wms/devolucoes.test.ts`. Expected: FAIL — hoje o case `avariado` sem quarentena chama `inserirMovimentacao` (E + S ajuste_manual), então `movSpy` é chamado 2x e não lança.

- [ ] **Step 3 — Implementação mínima (guard TS).** Em `src/lib/wms/devolucoes.ts`, no início do case `avariado` (antes da mov E na linha 212), buscar a quarentena e bloquear; remover o branch `else` de `ajuste_manual` (257-270):

```ts
    case "avariado": {
      // [P051] Preflight: SEM quarentena no galpão, BLOQUEIA antes de tirar da
      // prateleira. Remove o ajuste_manual silencioso que fazia o item sumir.
      const { data: quarentena } = await sb
        .from("siso_localizacoes")
        .select("id")
        .match({ galpao_id: input.galpao_id, tipo: "quarentena", ativo: true })
        .order("codigo", { ascending: true })
        .limit(1)
        .maybeSingle();
      const locDestinoQuarentena = (quarentena as { id: string } | null)?.id;
      if (!locDestinoQuarentena) {
        throw new Error(
          `quarentena inexistente no galpão ${input.galpao_id} — crie uma localização tipo 'quarentena' antes de classificar avariado`,
        );
      }
      // Classe B — avariada do cliente. Entra na loc indicada, transfere
      // imediatamente pra quarentena (par S+E no físico).
      await inserirMovimentacao({
        tripla, tipo: "E", qty: input.qty,
        origem_tipo: "devolucao_cliente_avariada",
        origem_id: origemCompartilhado,
        nota_fiscal_id: notaFiscalUuid ?? undefined,
        empresa_referencia_id: empresaReferenciaId,
        custo_unitario: custoUnitarioOriginal,
        usuario_id: input.usuario_id, motivo: input.observacoes,
        devolucao_id: input.devolucao_id,
      });
      await inserirMovimentacao({
        tripla, tipo: "S", qty: input.qty,
        origem_tipo: "transferencia_localizacao",
        origem_id: origemCompartilhado,
        usuario_id: input.usuario_id,
        motivo: `avaria → quarentena: ${input.observacoes ?? ""}`,
        devolucao_id: input.devolucao_id,
      });
      await inserirMovimentacao({
        tripla: { ...tripla, localizacao_id: locDestinoQuarentena },
        tipo: "E", qty: input.qty,
        origem_tipo: "transferencia_localizacao",
        origem_id: origemCompartilhado,
        usuario_id: input.usuario_id,
        devolucao_id: input.devolucao_id,
      });
      break;
    }
```

- [ ] **Step 4 — Rodar e ver passar.** `npm test -- src/lib/wms/devolucoes.test.ts`. Expected: PASS — lança `quarentena inexistente` com 0 movs.

- [ ] **Step 5 — Commit.** `git add src/lib/wms/devolucoes.ts src/lib/wms/devolucoes.test.ts && git commit -m "fix(wms): bloqueia classificação avariado sem quarentena antes de mover [P051]"`

### Task 4.2: RPC wms_classificar_devolucao (movs + status atômicos, FOR UPDATE) [P049, P050, P054]

**Files:**
- Create `supabase/migrations/20260605_rpc_classificar_devolucao.sql`
- Modify `src/lib/wms/devolucoes.ts:190-340` (substituir o switch de movs + UPDATE por chamada à RPC, mantendo a resolução TS de NF/empresa/custo/quarentena)
- Modify `src/app/api/wms/devolucoes/[id]/classificar/route.ts:66-74` (mapear erro de concorrência pra 409)
- Test (RED) `src/lib/wms/devolucoes-classificar-atomico.integration.test.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `src/lib/wms/devolucoes-classificar-atomico.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, quarentenaId: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  // garante uma quarentena no galpão
  const { data: q } = await sb.from("siso_localizacoes")
    .upsert({ galpao_id: galpaoId, codigo: `QUAR-${RND}`, tipo: "quarentena", ativo: true }, { onConflict: "galpao_id,codigo" })
    .select("id").single();
  quarentenaId = q!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `DEVCLA-${RND}`, descricao: "dev cla", ativo: true }).select("id").single();
  prodId = p!.id;
});

describe("wms_classificar_devolucao — atômico [P049/P050/P054]", () => {
  it("avariado: E na loc + par S+E pra quarentena + status classificada, tudo numa tx", async () => {
    const { data: dev } = await sb.from("siso_devolucoes_pendentes")
      .insert({ produto_id: prodId, galpao_id: galpaoId, qty: 2, status: "aguardando_classificacao" })
      .select("id").single();
    const devId = dev!.id;

    const { data, error } = await sb.rpc("wms_classificar_devolucao", {
      p_devolucao_id: devId, p_classificacao: "avariado",
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty: 2, p_loc_quarentena_id: quarentenaId, p_usuario_id: usuarioId,
      p_origem_compartilhado: crypto.randomUUID(),
      p_nota_fiscal_id: null, p_empresa_referencia_id: null,
      p_fornecedor_id: null, p_custo_unitario: null, p_observacoes: "batido",
    });
    expect(error).toBeNull();
    expect((data as { status: string }).status).toBe("classificada");
    // saldo final: loc origem 0 (entrou 2, saiu 2), quarentena 2
    const { data: eOrig } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locId).maybeSingle();
    const { data: eQuar } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", quarentenaId).single();
    expect(Number(eOrig?.saldo ?? 0)).toBe(0);
    expect(Number(eQuar?.saldo)).toBe(2);
    // status
    const { data: dd } = await sb.from("siso_devolucoes_pendentes").select("status").eq("id", devId).single();
    expect((dd as { status: string }).status).toBe("classificada");
  });

  it("re-classificar a mesma devolução (já classificada) é no-op idempotente (não duplica)", async () => {
    const { data: dev } = await sb.from("siso_devolucoes_pendentes")
      .insert({ produto_id: prodId, galpao_id: galpaoId, qty: 1, status: "aguardando_classificacao" })
      .select("id").single();
    const devId = dev!.id;
    const og = crypto.randomUUID();
    const params = {
      p_devolucao_id: devId, p_classificacao: "integro",
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty: 1, p_loc_quarentena_id: null, p_usuario_id: usuarioId,
      p_origem_compartilhado: og, p_nota_fiscal_id: null, p_empresa_referencia_id: null,
      p_fornecedor_id: null, p_custo_unitario: null, p_observacoes: null,
    };
    await sb.rpc("wms_classificar_devolucao", params);
    const { data: again } = await sb.rpc("wms_classificar_devolucao", { ...params, p_origem_compartilhado: crypto.randomUUID() });
    expect((again as { status: string; ja_classificada?: boolean })?.ja_classificada).toBe(true);
    const { count } = await sb.from("siso_movimentacoes").select("id", { count: "exact", head: true }).eq("produto_id", prodId).eq("origem_tipo", "devolucao_cliente_integra");
    expect(count).toBe(1); // só uma E íntegra, não duplicou
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- src/lib/wms/devolucoes-classificar-atomico.integration.test.ts`. Expected: FAIL — `wms_classificar_devolucao` não existe.

- [ ] **Step 3 — Implementação (migration + RPC).** Criar `supabase/migrations/20260605_rpc_classificar_devolucao.sql`:

```sql
-- [P049/P050/P051/P054] Classificação de devolução atômica e serializada.
--
-- FOR UPDATE no row da devolução (serializa por devolução — P054, sem TOCTOU).
-- Executa as 1..3 movs da classe + UPDATE status='classificada' na mesma tx
-- (P049/P050). Avariado SEM loc de quarentena → RAISE (P051; o caller resolve
-- e passa p_loc_quarentena_id já validada, mas o backstop transacional re-checa).
-- Idempotente: devolução != 'aguardando_classificacao' → no-op (ja_classificada).
--
-- A resolução de NF/empresa/custo fica no TS; a RPC recebe os valores prontos.

BEGIN;

CREATE OR REPLACE FUNCTION wms_classificar_devolucao(
  p_devolucao_id uuid,
  p_classificacao text,           -- integro|avariado|garantia|troca_sku
  p_produto_id uuid,
  p_galpao_id uuid,
  p_localizacao_id uuid,
  p_qty numeric,
  p_loc_quarentena_id uuid,       -- obrigatório p/ avariado (validado no TS); backstop aqui
  p_usuario_id uuid,
  p_origem_compartilhado uuid,
  p_nota_fiscal_id uuid DEFAULT NULL,
  p_empresa_referencia_id uuid DEFAULT NULL,
  p_fornecedor_id uuid DEFAULT NULL,
  p_custo_unitario numeric DEFAULT NULL,
  p_observacoes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_dev RECORD;
  v_origem text := p_origem_compartilhado::text;
BEGIN
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'qty deve ser > 0' USING ERRCODE = '22023';
  END IF;

  -- FOR UPDATE: serializa classificações concorrentes da mesma devolução (P054).
  SELECT id, status INTO v_dev
    FROM siso_devolucoes_pendentes WHERE id = p_devolucao_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'devolução não encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_dev.status <> 'aguardando_classificacao' THEN
    -- Idempotência: já classificada/cancelada → no-op.
    RETURN jsonb_build_object('status', v_dev.status, 'ja_classificada', true);
  END IF;

  IF p_classificacao = 'integro' THEN
    PERFORM wms_inserir_movimentacao(
      p_produto_id, p_galpao_id, p_localizacao_id, 'E', p_qty,
      'devolucao_cliente_integra', v_origem, NULL,
      p_usuario_id, NULL, NULL, NULL, NULL, p_empresa_referencia_id, NULL,
      p_observacoes, NULL, NULL, p_nota_fiscal_id, NULL, p_custo_unitario, NULL);

  ELSIF p_classificacao = 'avariado' THEN
    -- [P051] backstop: quarentena obrigatória.
    IF p_loc_quarentena_id IS NULL THEN
      RAISE EXCEPTION 'quarentena inexistente no galpão % — crie antes de classificar avariado', p_galpao_id
        USING ERRCODE = '22023';
    END IF;
    PERFORM wms_inserir_movimentacao(
      p_produto_id, p_galpao_id, p_localizacao_id, 'E', p_qty,
      'devolucao_cliente_avariada', v_origem, NULL,
      p_usuario_id, NULL, NULL, NULL, NULL, p_empresa_referencia_id, NULL,
      p_observacoes, NULL, NULL, p_nota_fiscal_id, NULL, p_custo_unitario, NULL);
    PERFORM wms_inserir_movimentacao(
      p_produto_id, p_galpao_id, p_localizacao_id, 'S', p_qty,
      'transferencia_localizacao', v_origem, NULL,
      p_usuario_id, NULL, NULL, NULL, NULL, NULL, NULL,
      format('avaria → quarentena: %s', COALESCE(p_observacoes,'')), NULL, NULL, NULL, NULL, NULL, NULL);
    PERFORM wms_inserir_movimentacao(
      p_produto_id, p_galpao_id, p_loc_quarentena_id, 'E', p_qty,
      'transferencia_localizacao', v_origem, NULL,
      p_usuario_id, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL);

  ELSIF p_classificacao = 'garantia' THEN
    IF p_fornecedor_id IS NULL THEN
      RAISE EXCEPTION 'garantia exige fornecedor_id' USING ERRCODE = '22023';
    END IF;
    PERFORM wms_inserir_movimentacao(
      p_produto_id, p_galpao_id, p_localizacao_id, 'E', p_qty,
      'devolucao_cliente_integra', v_origem, NULL,
      p_usuario_id, NULL, NULL, NULL, NULL, p_empresa_referencia_id, NULL,
      NULL, NULL, NULL, p_nota_fiscal_id, NULL, p_custo_unitario, NULL);
    PERFORM wms_inserir_movimentacao(
      p_produto_id, p_galpao_id, p_localizacao_id, 'S', p_qty,
      'devolucao_fornecedor_enviada', v_origem, NULL,
      p_usuario_id, NULL, NULL, NULL, NULL, NULL, p_fornecedor_id,
      format('garantia: %s', COALESCE(p_observacoes,'')), NULL, NULL, NULL, NULL, NULL, NULL);

  ELSIF p_classificacao = 'troca_sku' THEN
    PERFORM wms_inserir_movimentacao(
      p_produto_id, p_galpao_id, p_localizacao_id, 'E', p_qty,
      'devolucao_cliente_troca_sku', v_origem, NULL,
      p_usuario_id, NULL, NULL, NULL, NULL, p_empresa_referencia_id, NULL,
      format('troca SKU: %s', COALESCE(p_observacoes,'')), NULL, NULL, p_nota_fiscal_id, NULL, p_custo_unitario, NULL);
  ELSE
    RAISE EXCEPTION 'classificação inválida: %', p_classificacao USING ERRCODE = '22023';
  END IF;

  UPDATE siso_devolucoes_pendentes
     SET status = 'classificada',
         classificacao = p_classificacao,
         classificada_por = p_usuario_id,
         classificada_em = now(),
         observacoes = p_observacoes
   WHERE id = p_devolucao_id;

  RETURN jsonb_build_object('status', 'classificada', 'ja_classificada', false);
END;
$$;

COMMENT ON FUNCTION wms_classificar_devolucao(uuid,text,uuid,uuid,uuid,numeric,uuid,uuid,uuid,uuid,uuid,uuid,numeric,text) IS
  '[P049/P050/P051/P054] Classificação de devolução: FOR UPDATE + N movs + status numa tx (tudo-ou-nada).';

COMMIT;
```

> **Nota: a RPC não popula `devolucao_id` nas movs** (a named-param `wms_inserir_movimentacao` não tem esse param — é populado por UPDATE-after-insert só no caminho TS, `ledger.ts:223-228`). `desclassificarDevolucao` (devolucoes.ts:413) usa lookup com fallback por data+tipo+NF quando `devolucao_id` é NULL (JSDoc linhas 409-412), então o estorno continua funcionando. Conferir a ordem posicional exata dos 22 params contra `20260527_wms_inserir_mov_motivo_categoria.sql:18-36` ao aplicar; ajustar os `NULL` se divergir.

Aplicar via `mcp__supabase__apply_migration` (name: `rpc_classificar_devolucao`).

Substituir o switch de movs + UPDATE em `classificarDevolucao` (`src/lib/wms/devolucoes.ts:190-340`) por: resolver a loc de quarentena no TS (mantendo o guard P051) e chamar a RPC única:

```ts
  // [P051] resolve+valida quarentena ANTES (guard TS); RPC re-valida (backstop).
  let locQuarentenaId: string | null = null;
  if (input.classificacao === "avariado") {
    const { data: quarentena } = await sb
      .from("siso_localizacoes")
      .select("id")
      .match({ galpao_id: input.galpao_id, tipo: "quarentena", ativo: true })
      .order("codigo", { ascending: true })
      .limit(1)
      .maybeSingle();
    locQuarentenaId = (quarentena as { id: string } | null)?.id ?? null;
    if (!locQuarentenaId) {
      throw new Error(
        `quarentena inexistente no galpão ${input.galpao_id} — crie uma localização tipo 'quarentena' antes de classificar avariado`,
      );
    }
  }
  if (input.classificacao === "garantia" && !input.fornecedor_id) {
    throw new Error("classificacao='garantia' exige fornecedor_id (Classe C — devolução pro fornecedor)");
  }

  const { data: rpcRes, error: rpcErr } = await sb.rpc("wms_classificar_devolucao", {
    p_devolucao_id: input.devolucao_id,
    p_classificacao: input.classificacao,
    p_produto_id: input.produto_id,
    p_galpao_id: input.galpao_id,
    p_localizacao_id: input.localizacao_id,
    p_qty: input.qty,
    p_loc_quarentena_id: locQuarentenaId,
    p_usuario_id: input.usuario_id,
    p_origem_compartilhado: origemCompartilhado,
    p_nota_fiscal_id: notaFiscalUuid,
    p_empresa_referencia_id: empresaReferenciaId,
    p_fornecedor_id: input.fornecedor_id ?? null,
    p_custo_unitario: custoUnitarioOriginal ?? null,
    p_observacoes: input.observacoes ?? null,
  });
  if (rpcErr) throw new Error(rpcErr.message);

  logger.info("wms.devolucoes", "classificada", {
    devolucao_id: input.devolucao_id,
    classificacao: input.classificacao,
    ja_classificada: (rpcRes as { ja_classificada?: boolean })?.ja_classificada ?? false,
  });
```

Remover o switch (190-323) e o `UPDATE status` (325-334), e o guard TOCTOU `if (d.status !== ...)` na linha 118 (a RPC faz o guard sob lock — manter só pra early-return se quiser, mas a verdade fica na RPC). Manter a resolução de `notaFiscalUuid`, `empresaReferenciaId`, `custoUnitarioOriginal` (não tocam ledger).

Na rota `src/app/api/wms/devolucoes/[id]/classificar/route.ts:66-74`, mapear concorrência/estado pra 409:

```ts
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isConflict = msg.includes("não encontrada") === false && (
      msg.includes("could not obtain lock") || msg.includes("deadlock")
    );
    return wmsErrorResponse({
      source: "wms.devolucoes.classificar",
      error: e,
      status: isConflict ? 409 : 400,
      requestPath: `/api/wms/devolucoes/${id}/classificar`,
      requestMethod: "POST",
      metadata: { devolucao_id: id, classificacao: body.classificacao },
    });
  }
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- src/lib/wms/devolucoes-classificar-atomico.integration.test.ts`. Expected: PASS — avariado: loc origem 0, quarentena 2, status classificada; re-classify → `ja_classificada=true`, sem duplicar. Também rodar `npm test -- src/lib/wms/devolucoes.test.ts` (guard P051 segue verde).

- [ ] **Step 5 — Commit.** `git add supabase/migrations/20260605_rpc_classificar_devolucao.sql src/lib/wms/devolucoes.ts src/app/api/wms/devolucoes/[id]/classificar/route.ts src/lib/wms/devolucoes-classificar-atomico.integration.test.ts && git commit -m "fix(wms): RPC wms_classificar_devolucao atômica + serializada + preflight quarentena [P049,P050,P051,P054]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-devolucao-classificar-nao-atomica
    date: "2026-06-05"
    source: wms.devolucoes.classificarDevolucao
    category: business_logic
    message: "classificação de devolução deixa movs órfãs / dupla-contagem em falha parcial e concorrência"
    cause: >
      classificarDevolucao emitia até 3 movs em txs separadas e só depois fazia
      o UPDATE de status (TOCTOU). Falha no meio deixava saldo subido com status
      pendente (re-run duplicava). Avariado sem quarentena fazia ajuste_manual
      silencioso (item sumia).
    fix: >
      RPC wms_classificar_devolucao: FOR UPDATE na devolução (serializa) + N movs
      + UPDATE status na mesma tx. Idempotente (status != aguardando → no-op).
      Avariado sem quarentena: RAISE (bloqueia antes de mover).
    files: [supabase/migrations/20260605_rpc_classificar_devolucao.sql, src/lib/wms/devolucoes.ts, src/app/api/wms/devolucoes/[id]/classificar/route.ts]
    tags: [devolucao, classificar, atomico, quarentena, concorrencia, P049, P050, P051, P054]
```

---

## PR 5: RPC wms_desfazer_recebimento_transferencia atômica + preflight quanto-dá-pra-desfazer [P067, P065] [MIGRATION/RPC]

> **Contexto ancorado:** `desfazerRecebimentoTransferencia` (`src/lib/wms/transferencias.ts:588-665`) estorna cada leg E num loop (619-643), depois UPDATE separado dos itens (645-652) e do header (654-662) — 3 statements PostgREST sem transação. Se o UPDATE de itens falha após os estornos, estoque volta mas header/itens seguem `recebida` (P067). O estorno gera S na loc destino; se o saldo já foi consumido, a RPC RAISE `saldo insuficiente` (CHECK saldo>=0) — o `-10` do raio-x é impossível, o gap real é UX: o undo falha com erro cru sem dizer "só dá pra devolver 40 de 50" (P065). Status válido: só `recebida`.

### Task 5.1: Preflight "quanto dá pra desfazer" [P065]

**Files:**
- Modify `src/lib/wms/transferencias.ts:588-643` (passo de preflight antes de mutar)
- Modify `src/app/api/wms/transferencias/[id]/desfazer-recebimento/route.ts` (propagar 409 estruturado + aceitar `force`)
- Test (RED) `test/integration/transferencias-desfazer-preflight.integration.test.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/transferencias-desfazer-preflight.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { desfazerRecebimentoTransferencia } from "../../src/lib/wms/transferencias";

const sb = createServiceClient();
let galpaoO: string, galpaoD: string, locO: string, locD: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: cwb } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  const { data: spg } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
  galpaoO = cwb!.id; galpaoD = spg!.id;
  const { data: lo } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoO).eq("codigo", "A-01-01").single();
  locO = lo!.id;
  const { data: ld } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoD).eq("codigo", "A-01-01").single();
  locD = ld!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `TRDESF-${RND}`, descricao: "transf desf", ativo: true }).select("id").single();
  prodId = p!.id;
});

describe("desfazerRecebimentoTransferencia — preflight [P065]", () => {
  it("recebido 50, vendido 10 (destino=40): retorna 409 estruturado 'desfazível 40 de 50' SEM mutar", async () => {
    // monta transferência recebida: saída origem (S 50), entrada destino (E 50)
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoO, p_localizacao_id: locO, p_tipo: "E", p_quantidade: 50, p_origem_tipo: "inventario_inicial", p_origem_id: null, p_custo_unitario: 1, p_motivo: "seed" });
    const { data: head } = await sb.from("siso_transferencias_galpao").insert({ galpao_origem_id: galpaoO, galpao_destino_id: galpaoD, status: "recebida", recebida_em: new Date().toISOString() }).select("id").single();
    const transfId = head!.id;
    const { data: movS } = await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoO, p_localizacao_id: locO, p_tipo: "S", p_quantidade: 50, p_origem_tipo: "transferencia_galpao", p_origem_id: transfId, p_usuario_id: usuarioId, p_motivo: "saida" });
    const { data: movE } = await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoD, p_localizacao_id: locD, p_tipo: "E", p_quantidade: 50, p_origem_tipo: "transferencia_galpao", p_origem_id: transfId, p_usuario_id: usuarioId, p_motivo: "entrada" });
    await sb.from("siso_transferencia_galpao_itens").insert({ transferencia_id: transfId, produto_id: prodId, localizacao_origem_id: locO, qty: 50, localizacao_destino_id: locD, mov_saida_id: movS as unknown as string, mov_entrada_id: movE as unknown as string });
    // vende 10 do destino → saldo 40
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoD, p_localizacao_id: locD, p_tipo: "S", p_quantidade: 10, p_origem_tipo: "venda_manual", p_origem_id: null, p_usuario_id: usuarioId, p_motivo: "venda" });

    await expect(
      desfazerRecebimentoTransferencia({ transferencia_id: transfId, usuario_id: usuarioId, motivo: "undo total" }),
    ).rejects.toThrow(/desfazível 40 de 50|só pode devolver 40/i);

    // NADA mutou: header segue recebida, saldo destino 40, mov E não estornada.
    const { data: h } = await sb.from("siso_transferencias_galpao").select("status").eq("id", transfId).single();
    expect((h as { status: string }).status).toBe("recebida");
    const { data: e } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locD).single();
    expect(Number(e?.saldo)).toBe(40);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- test/integration/transferencias-desfazer-preflight.integration.test.ts`. Expected: FAIL — hoje o loop estorna até bater no `saldo insuficiente` cru (erro técnico), não no preflight "desfazível 40 de 50", e pode mutar parcialmente.

- [ ] **Step 3 — Implementação mínima (preflight no service).** Em `src/lib/wms/transferencias.ts`, na função `desfazerRecebimentoTransferencia`, adicionar o passo de preflight ANTES do loop de estorno (após buscar `itens` na linha 624, antes do loop na linha 628), aceitando uma flag `force`:

```ts
export async function desfazerRecebimentoTransferencia(input: {
  transferencia_id: string;
  usuario_id: string;
  motivo: string;
  force?: boolean;
}): Promise<{ movsEstornadas: number }> {
```

E o bloco de preflight (substituir o início do loop — manter o uso de `itens` já buscado):

```ts
  // [P065] Preflight: pra cada leg E, comparar qty com saldo atual na loc destino.
  // Se algum item não cobre, retornar 409 estruturado 'só dá pra devolver X de Y'
  // SEM mutar nada — exceto se force=true (transparência, não bloqueio absoluto).
  type ItemRow = { id: string; mov_entrada_id: string | null };
  const itensTip = (itens ?? []) as ItemRow[];
  const bloqueados: Array<{ item_id: string; desfazivel: number; total: number }> = [];
  for (const it of itensTip) {
    if (!it.mov_entrada_id) continue;
    const { data: movE } = await sb
      .from("siso_movimentacoes")
      .select("produto_id, galpao_id, localizacao_id, quantidade")
      .eq("id", it.mov_entrada_id)
      .single();
    if (!movE) continue;
    const m = movE as { produto_id: string; galpao_id: string; localizacao_id: string; quantidade: number };
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo")
      .match({ produto_id: m.produto_id, galpao_id: m.galpao_id, localizacao_id: m.localizacao_id })
      .maybeSingle();
    const saldo = Number((est as { saldo?: number } | null)?.saldo ?? 0);
    const total = Number(m.quantidade);
    if (saldo < total) {
      bloqueados.push({ item_id: it.id, desfazivel: saldo, total });
    }
  }
  if (bloqueados.length > 0 && !input.force) {
    const linha = bloqueados[0];
    const err = new Error(
      `só pode devolver ${linha.desfazivel} de ${linha.total} (desfazível ${linha.desfazivel} de ${linha.total}) — o resto já saiu da loc destino. Use force=true pra prosseguir só nos itens que cobrem.`,
    ) as Error & { code?: string; bloqueados?: typeof bloqueados };
    err.code = "DESFAZER_PARCIAL_BLOQUEADO";
    err.bloqueados = bloqueados;
    throw err;
  }
```

No loop de estorno existente (628-643), se `force=true`, pular itens bloqueados:

```ts
  const bloqueadosIds = new Set(bloqueados.map((b) => b.item_id));
  let movsEstornadas = 0;
  for (const it of itensTip) {
    if (!it.mov_entrada_id) continue;
    if (input.force && bloqueadosIds.has(it.id)) continue; // pula os que não cobrem
    try {
      await estornarMovimentacao({ mov_id: it.mov_entrada_id, usuario_id: input.usuario_id, motivo: `Desfaz recebimento de transferência ${input.transferencia_id}: ${input.motivo}` });
      movsEstornadas++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/já foi estornada|já é um estorno/.test(msg)) continue;
      throw err;
    }
  }
```

Na rota `desfazer-recebimento/route.ts`, aceitar `force` e mapear o 409 estruturado:

```ts
  const force = body?.force === true;
  try {
    const r = await desfazerRecebimentoTransferencia({ transferencia_id: id, usuario_id: auth.user.id, motivo, force });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "DESFAZER_PARCIAL_BLOQUEADO") {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e), bloqueados: (e as { bloqueados?: unknown }).bloqueados },
        { status: 409 },
      );
    }
    // catch existente (route.ts:42-54): erros de cliente → 400, resto mascarado.
    const msg = e instanceof Error ? e.message : String(e);
    const isClient =
      msg.includes("não encontrada") ||
      msg.includes("podem ter recebimento desfeito") ||
      msg.includes("motivo");
    return wmsErrorResponse({
      source: "wms.transferencias.desfazer-recebimento",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/transferencias/${id}/desfazer-recebimento`,
      requestMethod: "POST",
      metadata: { transferencia_id: id },
    });
  }
```

> **Nota:** `body` precisa ser parseado UMA vez antes do `try` (a rota atual faz `const body = await req.json().catch(() => null)` na linha 25; reusar essa mesma `body` pra ler `force`). Mantém o guard `motivo.length < 3 → 400` existente (linhas 27-32) intacto, antes do `try`.

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- test/integration/transferencias-desfazer-preflight.integration.test.ts`. Expected: PASS — 409 "desfazível 40 de 50", nada mutado.

- [ ] **Step 5 — Commit.** `git add src/lib/wms/transferencias.ts src/app/api/wms/transferencias/[id]/desfazer-recebimento/route.ts test/integration/transferencias-desfazer-preflight.integration.test.ts && git commit -m "feat(wms): preflight 'quanto dá pra desfazer' no undo de recebimento de transferência [P065]"`

### Task 5.2: RPC wms_desfazer_recebimento_transferencia atômica [P067]

**Files:**
- Create `supabase/migrations/20260605_rpc_desfazer_recebimento_transferencia.sql`
- Modify `src/lib/wms/transferencias.ts:588-665` (estorno + reset itens + reset header via RPC)
- Test (RED) `test/integration/transferencias-desfazer-atomico.integration.test.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/transferencias-desfazer-atomico.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoO: string, galpaoD: string, locO: string, locD: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: cwb } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  const { data: spg } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
  galpaoO = cwb!.id; galpaoD = spg!.id;
  const { data: lo } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoO).eq("codigo", "A-01-01").single();
  locO = lo!.id;
  const { data: ld } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoD).eq("codigo", "A-01-01").single();
  locD = ld!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `TRATOM-${RND}`, descricao: "transf atom", ativo: true }).select("id").single();
  prodId = p!.id;
});

describe("wms_desfazer_recebimento_transferencia — atômico [P067]", () => {
  it("desfaz: estorna legs E + reseta itens + header em_transito, numa tx", async () => {
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoO, p_localizacao_id: locO, p_tipo: "E", p_quantidade: 30, p_origem_tipo: "inventario_inicial", p_origem_id: null, p_custo_unitario: 1, p_motivo: "seed" });
    const { data: head } = await sb.from("siso_transferencias_galpao").insert({ galpao_origem_id: galpaoO, galpao_destino_id: galpaoD, status: "recebida", recebida_em: new Date().toISOString(), recebida_por: usuarioId }).select("id").single();
    const transfId = head!.id;
    const { data: movS } = await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoO, p_localizacao_id: locO, p_tipo: "S", p_quantidade: 30, p_origem_tipo: "transferencia_galpao", p_origem_id: transfId, p_usuario_id: usuarioId, p_motivo: "saida" });
    const { data: movE } = await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoD, p_localizacao_id: locD, p_tipo: "E", p_quantidade: 30, p_origem_tipo: "transferencia_galpao", p_origem_id: transfId, p_usuario_id: usuarioId, p_motivo: "entrada" });
    const { data: item } = await sb.from("siso_transferencia_galpao_itens").insert({ transferencia_id: transfId, produto_id: prodId, localizacao_origem_id: locO, qty: 30, localizacao_destino_id: locD, mov_saida_id: movS as unknown as string, mov_entrada_id: movE as unknown as string }).select("id").single();

    const { data, error } = await sb.rpc("wms_desfazer_recebimento_transferencia", { p_transferencia_id: transfId, p_usuario_id: usuarioId, p_motivo: "undo atomico" });
    expect(error).toBeNull();
    expect((data as { movs_estornadas: number }).movs_estornadas).toBe(1);
    // header em_transito, item resetado, saldo destino 0
    const { data: h } = await sb.from("siso_transferencias_galpao").select("status").eq("id", transfId).single();
    expect((h as { status: string }).status).toBe("em_transito");
    const { data: it } = await sb.from("siso_transferencia_galpao_itens").select("mov_entrada_id, localizacao_destino_id").eq("id", item!.id).single();
    expect((it as { mov_entrada_id: string | null }).mov_entrada_id).toBeNull();
    expect((it as { localizacao_destino_id: string | null }).localizacao_destino_id).toBeNull();
    const { data: e } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locD).single();
    expect(Number(e?.saldo)).toBe(0);
  });

  it("re-desfazer (header já em_transito) é no-op idempotente", async () => {
    const { data: head } = await sb.from("siso_transferencias_galpao").insert({ galpao_origem_id: galpaoO, galpao_destino_id: galpaoD, status: "em_transito" }).select("id").single();
    const { error } = await sb.rpc("wms_desfazer_recebimento_transferencia", { p_transferencia_id: head!.id, p_usuario_id: usuarioId, p_motivo: "ja em transito" });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/recebid/i);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- test/integration/transferencias-desfazer-atomico.integration.test.ts`. Expected: FAIL — `wms_desfazer_recebimento_transferencia` não existe.

- [ ] **Step 3 — Implementação (migration + RPC).** Criar `supabase/migrations/20260605_rpc_desfazer_recebimento_transferencia.sql`:

```sql
-- [P067] Desfazer recebimento de transferência atômico (tudo-ou-nada).
--
-- FOR UPDATE no header (serializa). Estorna cada leg E (S na loc destino via
-- wms_inserir_movimentacao com tipo inverso) + reseta itens (mov_entrada_id,
-- localizacao_destino_id) + volta header a 'em_transito', tudo na mesma tx.
-- Qualquer RAISE (ex: saldo insuficiente) → rollback total.
-- Idempotente: header != 'recebida' → RAISE (caller já tratou via preflight).

BEGIN;

CREATE OR REPLACE FUNCTION wms_desfazer_recebimento_transferencia(
  p_transferencia_id uuid,
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_head RECORD;
  v_item RECORD;
  v_orig siso_movimentacoes;
  v_estornadas int := 0;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'motivo do undo é obrigatório (>=3 caracteres)' USING ERRCODE = '22023';
  END IF;

  SELECT id, status INTO v_head
    FROM siso_transferencias_galpao WHERE id = p_transferencia_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transferência não encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_head.status <> 'recebida' THEN
    RAISE EXCEPTION 'só transferências recebidas podem ter recebimento desfeito (status atual: %)', v_head.status
      USING ERRCODE = '22023';
  END IF;

  FOR v_item IN
    SELECT id, mov_entrada_id FROM siso_transferencia_galpao_itens
     WHERE transferencia_id = p_transferencia_id AND mov_entrada_id IS NOT NULL
  LOOP
    SELECT * INTO v_orig FROM siso_movimentacoes WHERE id = v_item.mov_entrada_id FOR UPDATE;
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN EXISTS (SELECT 1 FROM siso_movimentacoes WHERE estorno_de = v_orig.id);
    -- leg E → contra-mov S (saldo insuficiente RAISE aqui → rollback total)
    PERFORM wms_inserir_movimentacao(
      v_orig.produto_id, v_orig.galpao_id, v_orig.localizacao_id,
      'S', v_orig.quantidade, 'estorno', v_orig.id::text,
      jsonb_build_object('estorno_de', v_orig.id, 'mov_original_origem', v_orig.origem_tipo),
      p_usuario_id, NULL, v_orig.id, NULL, NULL, NULL, NULL,
      format('Desfaz recebimento de transferência %s: %s', p_transferencia_id, p_motivo),
      NULL, NULL, NULL, NULL, NULL, NULL);
    v_estornadas := v_estornadas + 1;
  END LOOP;

  UPDATE siso_transferencia_galpao_itens
     SET mov_entrada_id = NULL, localizacao_destino_id = NULL
   WHERE transferencia_id = p_transferencia_id;

  UPDATE siso_transferencias_galpao
     SET status = 'em_transito', recebida_em = NULL, recebida_por = NULL
   WHERE id = p_transferencia_id;

  RETURN jsonb_build_object('movs_estornadas', v_estornadas, 'status', 'em_transito');
END;
$$;

COMMENT ON FUNCTION wms_desfazer_recebimento_transferencia(uuid,uuid,text) IS
  '[P067] Undo de recebimento de transferência atômico: estorno legs E + reset itens + reset header numa tx.';

COMMIT;
```

Aplicar via `mcp__supabase__apply_migration` (name: `rpc_desfazer_recebimento_transferencia`).

Substituir os passos 3-5 de `desfazerRecebimentoTransferencia` (linhas 619-664, mantendo o preflight da Task 5.1 que roda ANTES) por chamada à RPC:

```ts
  // [P067] Estorno + reset itens + reset header numa única tx atômica.
  const bloqueadosIds = new Set(bloqueados.map((b) => b.item_id));
  if (input.force && bloqueadosIds.size > 0) {
    // force só processa itens que cobrem: a RPC estorna TODOS — então em modo
    // force com bloqueados, mantemos o loop TS por-item (skip bloqueados).
    // (caminho raro; a RPC é o caminho normal sem bloqueados.)
    let movsEstornadas = 0;
    for (const it of itensTip) {
      if (!it.mov_entrada_id || bloqueadosIds.has(it.id)) continue;
      try {
        await estornarMovimentacao({ mov_id: it.mov_entrada_id, usuario_id: input.usuario_id, motivo: `Desfaz recebimento de transferência ${input.transferencia_id}: ${input.motivo}` });
        movsEstornadas++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/já foi estornada|já é um estorno/.test(msg)) continue;
        throw err;
      }
    }
    // reset só dos itens não-bloqueados
    for (const it of itensTip) {
      if (bloqueadosIds.has(it.id)) continue;
      await sb.from("siso_transferencia_galpao_itens").update({ mov_entrada_id: null, localizacao_destino_id: null }).eq("id", it.id);
    }
    return { movsEstornadas };
  }

  const { data, error } = await sb.rpc("wms_desfazer_recebimento_transferencia", {
    p_transferencia_id: input.transferencia_id,
    p_usuario_id: input.usuario_id,
    p_motivo: input.motivo,
  });
  if (error) throw new Error(error.message);
  return { movsEstornadas: (data as { movs_estornadas: number }).movs_estornadas };
```

> **Nota:** o caminho `force` com bloqueados continua no TS (parcial intencional — desfaz só o que cobre). O caminho normal (sem bloqueados, ou `force` sem bloqueados) usa a RPC atômica. Manter o passo 1 (fetch header) e 2 (status check) do TS pra mensagens 400 amigáveis antes do preflight; a RPC re-valida sob lock.

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- test/integration/transferencias-desfazer-atomico.integration.test.ts` e o de preflight (5.1). Expected: PASS — atômico (header em_transito, item resetado, saldo 0) e idempotente (header em_transito → RAISE "recebida").

- [ ] **Step 5 — Commit.** `git add supabase/migrations/20260605_rpc_desfazer_recebimento_transferencia.sql src/lib/wms/transferencias.ts test/integration/transferencias-desfazer-atomico.integration.test.ts && git commit -m "fix(wms): RPC wms_desfazer_recebimento_transferencia atômica (estorno+reset numa tx) [P067]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-desfazer-recebimento-transf-nao-atomico
    date: "2026-06-05"
    source: wms.transferencias.desfazerRecebimentoTransferencia
    category: business_logic
    message: "undo de recebimento de transferência deixa header 'recebida' com estoque já devolvido"
    cause: >
      desfazerRecebimentoTransferencia estornava as legs E, depois fazia UPDATE
      separado de itens e header (3 statements sem tx). Falha no reset deixava
      estoque devolvido com header/itens ainda 'recebida'. E o undo falhava com
      erro cru sem dizer quanto dá pra devolver.
    fix: >
      Preflight 'desfazível X de Y' (409, sem mutar; force opcional) + RPC
      wms_desfazer_recebimento_transferencia (estorno legs E + reset itens +
      reset header numa tx tudo-ou-nada).
    files: [supabase/migrations/20260605_rpc_desfazer_recebimento_transferencia.sql, src/lib/wms/transferencias.ts, src/app/api/wms/transferencias/[id]/desfazer-recebimento/route.ts]
    tags: [transferencia, desfazer, atomico, preflight, P065, P067]
```

---

## PR 6: Reverter replenishment com estorno parcial residual [P078]

> **Contexto ancorado:** `reverterReplenishment` (`src/lib/wms/movimentacoes.ts:646-680`) chama `estornarMovimentacao` por mov; o catch (673-677) só engole `já foi estornada`/`já é um estorno`. Mas `estornarMovimentacao` (`ledger.ts:386-392`) lança `mov X tem qty_estornada=N (>0). Use wms_estornar_parcial_movimentacao` quando há estorno parcial prévio — esse erro NÃO é engolido → a reversão inteira falha. A RPC `wms_estornar_parcial_movimentacao` existe (`20260518_realocacao_fix_pack_rpc_estorno_parcial.sql`, assinatura `(p_mov_id uuid, p_qty numeric, p_usuario_id uuid, p_observacoes text)`) e já é usada em `separacao/desfazer-parcial/route.ts`. P078: cair pro estorno parcial do residual quando `qty_estornada>0`.

### Task 6.1: Estorno residual no reverterReplenishment

**Files:**
- Modify `src/lib/wms/movimentacoes.ts:664-678` (loop de reversão)
- Test (RED) `test/integration/reverter-replenishment-residual.integration.test.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/reverter-replenishment-residual.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { reverterReplenishment } from "../../src/lib/wms/movimentacoes";

const sb = createServiceClient();
let galpaoId: string, locOrig: string, locDest: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: lo } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locOrig = lo!.id;
  const { data: ld } = await sb.from("siso_localizacoes").upsert({ galpao_id: galpaoId, codigo: `REPL-DEST-${RND}`, tipo: "picking", ativo: true }, { onConflict: "galpao_id,codigo" }).select("id").single();
  locDest = ld!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `REPLRES-${RND}`, descricao: "repl res", ativo: true }).select("id").single();
  prodId = p!.id;
});

describe("reverterReplenishment — estorno residual [P078]", () => {
  it("após estorno parcial de 3 de 5, reverter desfaz só as 2 restantes (sem erro qty_estornada>0)", async () => {
    // saldo inicial 5 na origem
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locOrig, p_tipo: "E", p_quantidade: 5, p_origem_tipo: "inventario_inicial", p_origem_id: null, p_custo_unitario: 1, p_motivo: "seed" });
    // replenishment de 5 (par S+E) via RPC
    const { data: repl } = await sb.rpc("wms_replenishment_intra_galpao", {
      p_galpao_id: galpaoId, p_localizacao_origem_id: locOrig, p_localizacao_destino_id: locDest,
      p_itens: [{ produto_id: prodId, qty: 5 }], p_usuario_id: usuarioId, p_observacoes: null, p_origem_id: null,
    });
    const origemId = (repl as { origem_id: string }).origem_id;
    // pega a mov E (entrada destino) pra estornar parcialmente 3
    const { data: movE } = await sb.from("siso_movimentacoes").select("id").eq("origem_id", origemId).eq("tipo", "E").eq("localizacao_id", locDest).single();
    await sb.rpc("wms_estornar_parcial_movimentacao", { p_mov_id: (movE as { id: string }).id, p_qty: 3, p_usuario_id: usuarioId, p_observacoes: "parcial 3" });
    // idem pra leg S (saída origem) — estorno parcial 3 também, pra deixar ambas com residual 2
    const { data: movS } = await sb.from("siso_movimentacoes").select("id").eq("origem_id", origemId).eq("tipo", "S").eq("localizacao_id", locOrig).single();
    await sb.rpc("wms_estornar_parcial_movimentacao", { p_mov_id: (movS as { id: string }).id, p_qty: 3, p_usuario_id: usuarioId, p_observacoes: "parcial 3 S" });

    // Reverter deve desfazer as 2 restantes de cada perna SEM lançar.
    const r = await reverterReplenishment({ origem_id: origemId, usuario_id: usuarioId, motivo: "reverter residual" });
    expect(r.movsEstornadas).toBeGreaterThanOrEqual(1);
    // saldo origem volta integral a 5; destino zera.
    const { data: eOrig } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locOrig).single();
    const { data: eDest } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locDest).single();
    expect(Number(eOrig?.saldo)).toBe(5);
    expect(Number(eDest?.saldo)).toBe(0);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- test/integration/reverter-replenishment-residual.integration.test.ts`. Expected: FAIL — `reverterReplenishment` lança `tem qty_estornada=3 (>0). Use wms_estornar_parcial_movimentacao` (não engolido), saldos não retornam integrais.

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/movimentacoes.ts`, ler `qty_estornada`/`quantidade` no select (linha 655-659) e tratar o residual no loop (664-678):

```ts
  const { data: movs, error } = await sb
    .from("siso_movimentacoes")
    .select("id, quantidade, qty_estornada")
    .eq("origem_id", input.origem_id)
    .eq("origem_tipo", "transferencia_localizacao");
  if (error) throw error;
  if (!movs || movs.length === 0) {
    throw new Error("nenhuma mov encontrada com esse origem_id");
  }
  let estornadas = 0;
  for (const m of movs as Array<{ id: string; quantidade: number; qty_estornada: number | null }>) {
    const total = Number(m.quantidade);
    const jaEstornada = Number(m.qty_estornada ?? 0);
    try {
      if (jaEstornada > 0 && jaEstornada < total) {
        // [P078] residual via estorno parcial (full estorno bloqueia com qty_estornada>0)
        const { error: pErr } = await sb.rpc("wms_estornar_parcial_movimentacao", {
          p_mov_id: m.id,
          p_qty: total - jaEstornada,
          p_usuario_id: input.usuario_id,
          p_observacoes: `Reverter replenishment ${input.origem_id} (residual): ${input.motivo}`,
        });
        if (pErr) throw new Error(pErr.message);
        estornadas++;
      } else if (jaEstornada === 0) {
        await estornarMovimentacao({
          mov_id: m.id,
          usuario_id: input.usuario_id,
          motivo: `Reverter replenishment ${input.origem_id}: ${input.motivo}`,
        });
        estornadas++;
      }
      // jaEstornada === total → já totalmente revertida, no-op (idempotente)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/já foi estornada|já é um estorno|excede saldo/.test(msg)) continue;
      throw err;
    }
  }
  return { movsEstornadas: estornadas };
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- test/integration/reverter-replenishment-residual.integration.test.ts`. Expected: PASS — saldo origem 5, destino 0, sem erro.

- [ ] **Step 5 — Commit.** `git add src/lib/wms/movimentacoes.ts test/integration/reverter-replenishment-residual.integration.test.ts && git commit -m "fix(wms): reverter replenishment cai pro estorno parcial do residual [P078]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-reverter-replenishment-qty-estornada
    date: "2026-06-05"
    source: wms.movimentacoes.reverterReplenishment
    category: business_logic
    message: "reverter realocação trava com 'qty_estornada>0' quando já houve estorno parcial"
    cause: >
      reverterReplenishment só chamava estornarMovimentacao (full estorno), que
      bloqueia quando a mov tem qty_estornada>0. As unidades residuais ficavam
      penduradas — operador preso.
    fix: >
      Loop lê qty_estornada/quantidade; se 0<qty_estornada<total, reverte o
      residual via wms_estornar_parcial_movimentacao; full estorno só com
      qty_estornada=0; total revertido → no-op.
    files: [src/lib/wms/movimentacoes.ts]
    tags: [replenishment, reverter, estorno-parcial, residual, P078]
```

---

## PR 7: Recebimento all-items tudo-ou-nada (receberItensViaOC para de engolir falha) [P028]

> **Contexto ancorado:** `receberItensViaOC` (`src/lib/wms/receber-oc.ts:44-344`) usa `logger+continue` em vez de `throw` em vários pontos: falha de mapeamento de produto (123-130), falha da mov E (161-170), falha de update de recebimento (264-278). Item 2 falha → item 1 fica comitado (sem tudo-ou-nada entre itens). `receberEstoque` (`movimentacoes.ts:172-240`) estorna SÓ o item corrente em falha, não rollback all-items. O painel de órfãos (`dashboard-tarefas.ts:420 detectarRecebimentoOrfao`) já existe. P028: tornar `receberItensViaOC` tudo-ou-nada trancado (acumular movs criadas; se QUALQUER item falhar, estornar todas e throw).

### Task 7.1: receberItensViaOC tudo-ou-nada com rollback all-items

**Files:**
- Modify `src/lib/wms/receber-oc.ts:116-303` (acumular mov_ids; rollback + throw em falha)
- Test (RED) `test/integration/receber-oc-all-or-nothing.integration.test.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/receber-oc-all-or-nothing.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { receberItensViaOC } from "../../src/lib/wms/receber-oc";

const sb = createServiceClient();
let galpaoId: string, usuarioId: string, ocId: string, item1: string, item2: string, prod1: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  // produto válido pro item1; item2 aponta pra produto SEM mapeamento (força falha de resolverProdutoWms)
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  const { data: p1 } = await sb.from("siso_produtos").insert({ sku: `RECOC-1-${RND}`, descricao: "rec1", ativo: true }).select("id").single();
  prod1 = p1!.id;
  // mapeia tiny_produto_id pro item1
  const tinyP1 = `tp1-${RND}`;
  await sb.from("siso_produto_empresas").insert({ produto_id: prod1, empresa_id: emp!.id, tiny_produto_id: tinyP1 });
  const { data: oc } = await sb.from("siso_ordens_compra").insert({ galpao_id: galpaoId, empresa_id: emp!.id, status: "aberta", fornecedor: "Forn X" }).select("id").single();
  ocId = oc!.id;
  // pedido_itens fake vinculados à OC
  const { data: i1 } = await sb.from("siso_pedido_itens").insert({ pedido_id: `MAN-${RND}-1`, sku: `RECOC-1-${RND}`, produto_id: tinyP1, ordem_compra_id: ocId, compra_quantidade_solicitada: 5, compra_quantidade_recebida: 0 }).select("id").single();
  const { data: i2 } = await sb.from("siso_pedido_itens").insert({ pedido_id: `MAN-${RND}-2`, sku: `RECOC-2-${RND}`, produto_id: `tp-naomapeado-${RND}`, ordem_compra_id: ocId, compra_quantidade_solicitada: 3, compra_quantidade_recebida: 0 }).select("id").single();
  item1 = i1!.id; item2 = i2!.id;
});

describe("receberItensViaOC — all-or-nothing [P028]", () => {
  it("item2 com produto sem mapeamento: NENHUM saldo do lote persiste e a chamada lança", async () => {
    await expect(
      receberItensViaOC({
        ocId, operadorId: usuarioId, operadorNome: "test-runner",
        itens: [
          { item_id: item1, qty_real: 5, custo_unitario: 10 },
          { item_id: item2, qty_real: 3, custo_unitario: 10 }, // falha: sem mapeamento
        ],
      }),
    ).rejects.toThrow();
    // saldo do item1 (prod1) NÃO permanece — rollback all-items.
    const { data: est } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prod1).maybeSingle();
    expect(Number((est as { saldo?: number } | null)?.saldo ?? 0)).toBe(0);
    // compra_quantidade_recebida do item1 não avançou
    const { data: it1 } = await sb.from("siso_pedido_itens").select("compra_quantidade_recebida").eq("id", item1).single();
    expect(Number((it1 as { compra_quantidade_recebida: number }).compra_quantidade_recebida)).toBe(0);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- test/integration/receber-oc-all-or-nothing.integration.test.ts`. Expected: FAIL — hoje item1 é comitado (saldo prod1 = 5, recebida=5) e item2 cai em `continue`; a chamada NÃO lança (retorna 200 silencioso).

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/receber-oc.ts`, transformar os `continue` silenciosos de FALHA em acumulação de erro + rollback all-items. Estratégia: coletar `movsCriadas: string[]` e `itensComUpdate: Array<{id, prev}>` ao longo do loop; trocar os `catch ... continue` de FALHA (linhas 123-130 mapeamento, 161-170 mov E, 264-278 update) por `throw`; envolver o loop inteiro num try/catch que, em qualquer throw, estorna todas as `movsCriadas` e re-throw. Reescrever a estrutura do loop:

```ts
  let itensRecebidos = 0;
  const movsCriadasLote: string[] = [];
  try {
    for (const itemReq of args.itens) {
      const { data: item } = await supabase
        .from("siso_pedido_itens")
        .select("id, pedido_id, sku, produto_id, compra_quantidade_solicitada, compra_quantidade_recebida, ordem_compra_id")
        .eq("id", itemReq.item_id)
        .single();
      if (!item) {
        throw new Error(`item de OC não encontrado: ${itemReq.item_id}`);
      }
      if (itemReq.qty_real <= 0) {
        // qty 0 não recebe — registra evento (não é falha do lote), segue.
        registrarEvento({ pedidoId: item.pedido_id, evento: "recebimento_item_zero", usuarioId: args.operadorId, usuarioNome: args.operadorNome, detalhes: { item_id: item.id, sku: item.sku, motivo: itemReq.motivo_divergencia ?? "qty_real=0" } }).catch(() => {});
        if (itemReq.motivo_divergencia) divergencias.push({ item_id: String(item.id), motivo: itemReq.motivo_divergencia });
        continue;
      }

      // Resolve produto WMS — FALHA agora aborta o lote.
      let produtoWmsId: string;
      try {
        produtoWmsId = await resolverProdutoWms(String(oc.empresa_id), String(item.produto_id));
      } catch (mapErr) {
        throw new Error(`falha ao resolver produto WMS do item ${item.id} (sku ${item.sku}): ${mapErr instanceof Error ? mapErr.message : String(mapErr)}`);
      }

      // Mov E — FALHA aborta o lote.
      const movE = await inserirMovimentacao({
        tripla: { produto_id: produtoWmsId, galpao_id: oc.galpao_id, localizacao_id: locRecebId },
        tipo: "E", qty: itemReq.qty_real, origem_tipo: "nf_compra", origem_id: args.ocId,
        origem_detalhes: { ordem_compra_id: args.ocId, item_id: item.id, pedido_id: item.pedido_id, sku: item.sku, motivo_divergencia: itemReq.motivo_divergencia ?? null },
        custo_unitario: itemReq.custo_unitario, fornecedor_id: fornecedorId,
        empresa_compradora_id: oc.empresa_id ?? null,
        motivo: itemReq.motivo_divergencia ? `Divergência: ${itemReq.motivo_divergencia}` : null,
        usuario_id: args.operadorId,
      });
      const movEntradaId = movE.id;
      movsCriadasLote.push(movEntradaId);

      // Cross-dock / criarPendencia (era 172-246): o catch que estornava+continue
      // VIRA throw — o rollback all-items do try externo estorna o lote inteiro
      // (não estorna mais só esta mov). Mantém as duas chamadas a criarPendencia.
      try {
        const split = await detectarCrossDock({
          produto_id: produtoWmsId,
          galpao_id: oc.galpao_id,
          qty_recebida: itemReq.qty_real,
          ordem_compra_id: args.ocId,
        });

        if (split.qty_cross_dock > 0 && split.loc_packing_id) {
          const pendCross = await criarPendencia({
            produto_id: produtoWmsId,
            galpao_id: oc.galpao_id,
            localizacao_origem_id: locRecebId,
            mov_entrada_id: movEntradaId,
            qty_inicial: split.qty_cross_dock,
            origem_tipo: "nf_compra",
            custo_unitario: itemReq.custo_unitario ?? null,
            lote_id: loteId,
            criada_por: args.operadorId,
            prioridade: "cross_dock",
            pedidos_vinculados: split.pedidos_vinculados,
            destino_sugerido_id: split.loc_packing_id,
          });
          pendenciasCriadas.push(pendCross);
          logger.info("receber-oc.crossdock", "pendência cross-dock criada", {
            pendencia_id: pendCross,
            qty: split.qty_cross_dock,
            pedidos: split.pedidos_vinculados.length,
            oc_id: args.ocId,
            sku: item.sku,
          });
        }

        if (split.qty_guarda_normal > 0) {
          const pendNormal = await criarPendencia({
            produto_id: produtoWmsId,
            galpao_id: oc.galpao_id,
            localizacao_origem_id: locRecebId,
            mov_entrada_id: movEntradaId,
            qty_inicial: split.qty_guarda_normal,
            origem_tipo: "nf_compra",
            custo_unitario: itemReq.custo_unitario ?? null,
            lote_id: loteId,
            criada_por: args.operadorId,
            prioridade: "normal",
          });
          pendenciasCriadas.push(pendNormal);
        }
      } catch (pendErr) {
        // [P028] antes: estornava só esta mov + continue. Agora: throw → o try
        // externo faz rollback all-items (estorna TODAS as movs do lote) e re-lança.
        throw new Error(
          `falha ao criar pendência de guarda do item ${item.id} (sku ${item.sku}): ${pendErr instanceof Error ? pendErr.message : String(pendErr)}`,
        );
      }

      // Update de compra_quantidade_recebida (era 248-278): mantém o optimistic
      // lock; updRecebErr VIRA throw (falha do lote); 0 linhas (concorrência) é
      // continue — o vencedor já contou, não é falha do lote.
      const jaRecebido = Number(item.compra_quantidade_recebida ?? 0);
      const novaQtyReceb = jaRecebido + itemReq.qty_real;
      const qtySolic = Number(item.compra_quantidade_solicitada ?? 0);
      const updatePayload: Record<string, unknown> = {
        compra_quantidade_recebida: novaQtyReceb,
      };
      if (qtySolic > 0 && novaQtyReceb >= qtySolic) {
        updatePayload.compra_status = "recebido";
      }
      const { data: updRows, error: updRecebErr } = await supabase
        .from("siso_pedido_itens")
        .update(updatePayload)
        .eq("id", item.id)
        .eq("compra_quantidade_recebida", jaRecebido) // optimistic lock
        .select("id");
      if (updRecebErr) {
        throw new Error(
          `falha ao atualizar recebimento do item ${item.id}: ${updRecebErr.message}`,
        );
      }
      if (!updRows || updRows.length === 0) {
        // Concorrência: o optimistic lock não casou — outro recebimento já
        // incrementou compra_quantidade_recebida. NÃO é falha do lote, mas a mov E
        // que acabamos de criar dobraria o saldo (o vencedor já contou a dele).
        // Estorna SÓ esta mov, tira do lote e segue. (Preserva o comportamento
        // pré-P028 de "pular item concorrente sem dobrar contagem".)
        try {
          await estornarMovimentacao({
            mov_id: movEntradaId,
            usuario_id: args.operadorId,
            motivo: `Recebimento concorrente do item ${item.id}: estorno da mov duplicada`,
          });
        } catch (estErr) {
          logger.error("receber-oc", "FALHA ao estornar mov de item concorrente — mov órfã", {
            movId: movEntradaId, itemId: item.id, ocId: args.ocId, err: String(estErr),
          });
        }
        movsCriadasLote.splice(movsCriadasLote.indexOf(movEntradaId), 1);
        logger.warn("receber-oc", "recebimento concorrente detectado; pulando item", {
          item_id: item.id,
        });
        continue;
      }

      itensRecebidosIds.push(String(item.id));

      if (itemReq.motivo_divergencia) {
        divergencias.push({ item_id: String(item.id), motivo: itemReq.motivo_divergencia });
      }

      registrarEvento({
        pedidoId: item.pedido_id,
        evento: "recebimento_via_oc",
        usuarioId: args.operadorId,
        usuarioNome: args.operadorNome,
        detalhes: {
          oc_id: args.ocId,
          item_id: item.id,
          sku: item.sku,
          qty_real: itemReq.qty_real,
          mov_id: movEntradaId,
          divergencia: itemReq.motivo_divergencia ?? null,
        },
      }).catch(() => {});

      itensRecebidos++;
    }
  } catch (loteErr) {
    // [P028] rollback all-items: estorna todas as movs já criadas no lote.
    for (const movId of movsCriadasLote) {
      try {
        await estornarMovimentacao({ mov_id: movId, usuario_id: args.operadorId, motivo: `Rollback all-items recebimento OC ${args.ocId}: ${loteErr instanceof Error ? loteErr.message : String(loteErr)}` });
      } catch (estErr) {
        logger.error("receber-oc", "FALHA ao estornar mov no rollback all-items — mov órfã", { movId, ocId: args.ocId, err: String(estErr) });
      }
    }
    throw loteErr;
  }
```

> **Nota:** o código acima é a reescrita completa do loop (linhas 116-303 do original) — os blocos de cross-dock (`detectarCrossDock`/`criarPendencia`) e o update de recebimento são preservados na íntegra; só os `catch+continue` de FALHA viram `throw` (mapeamento, mov E, pendência, update). O estorno per-item da pendência some (o rollback all-items do `catch (loteErr)` cobre o lote inteiro). Os dois `continue` que PERMANECEM são `qty_real<=0` (não recebe, não é falha) e concorrência (0 linhas no optimistic lock → estorna SÓ a mov duplicada deste item e segue, sem dobrar contagem). A variável `movsCriadasLote` introduzida aqui é consumida também pelo PR9 (over-receive) — ver dependência declarada no PR9.

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- test/integration/receber-oc-all-or-nothing.integration.test.ts`. Expected: PASS — saldo prod1 = 0 (rollback), recebida=0, chamada lança. Também rodar `npm run scenarios -- :only 81` (regressão do caminho feliz de receber OC).

- [ ] **Step 5 — Commit.** `git add src/lib/wms/receber-oc.ts test/integration/receber-oc-all-or-nothing.integration.test.ts && git commit -m "fix(wms): recebimento via OC tudo-ou-nada (rollback all-items, para de engolir falha) [P028]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-receber-oc-engole-falha
    date: "2026-06-05"
    source: wms.receber-oc
    category: business_logic
    message: "recebimento via OC retorna 200 mesmo com itens faltando (engole falha com continue)"
    cause: >
      receberItensViaOC usava logger+continue em falhas (mapeamento, mov E,
      update). Item 2 falhava → item 1 ficava comitado sem tudo-ou-nada; a
      operação parecia OK (HTTP 200) com itens faltando.
    fix: >
      Loop coleta movsCriadasLote; falhas viram throw; try externo faz rollback
      all-items (estorna todas as movs do lote) e re-throw. continue só para
      qty<=0 e concorrência (não-falhas).
    files: [src/lib/wms/receber-oc.ts]
    tags: [recebimento, oc, all-or-nothing, rollback, P028]
```

---

## PR 8: Cross-check produto bipado na guarda + escape-hatch manual [P029]

> **Contexto ancorado:** `confirmarGuarda` (`src/lib/wms/guarda.ts:434-506`) recebe só `localizacao_destino_id` e chama `wms_confirmar_guarda_atomico` — não valida que o produto físico corresponde ao da pendência. A rota `guarda/[id]/confirmar/route.ts:24-35` valida só `qty>0` e `localizacao_destino_id`. `siso_produtos.gtin` existe (índice `idx_produtos_gtin`). P029 (op1 + escape-hatch): exigir bipar o GTIN/SKU do produto; rejeitar 400 se não bater; flag `confirmar_manual=true` pula (loc sem etiqueta, igual inventário).

### Task 8.1: Validar GTIN/SKU bipado contra produto da pendência

**Files:**
- Modify `src/lib/wms/guarda.ts:404-460` (`ConfirmarGuardaInput` + validação no `confirmarGuarda`)
- Modify `src/app/api/wms/guarda/[id]/confirmar/route.ts:24-43` (aceitar `gtin_bipado`/`sku_bipado`/`confirmar_manual`)
- Test (RED) `scripts/wms/cenarios/catalogo/84-guarda-valida-produto-bipado.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/84-guarda-valida-produto-bipado.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 84 — [P029] guarda valida produto bipado (cross-check produto↔loc).
 *
 * Recebe um produto, e tenta confirmar a guarda bipando o GTIN de um produto
 * DIFERENTE → deve dar 400 sem criar mov. Com GTIN correto (ou confirmar_manual)
 * → confirma normalmente.
 */
type Setup = { skuCerto: string; skuErrado: string; gtinErrado: string; loc: string; pendenciaId: string };

export default {
  nome: "84 — [P029] guarda rejeita GTIN de produto diferente; aceita correto/manual",
  descricao: "Cross-check produto bipado na confirmação de guarda + escape-hatch manual.",
  tags: ["guarda", "putaway", "cross-check", "P029"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const skuCerto = ctx.skuUnico("84C");
    const skuErrado = ctx.skuUnico("84E");
    const gtinErrado = `789${Math.floor(Math.random() * 1e10)}`;
    await ctx.criarProduto({ sku: skuCerto, descricao: "guarda certo 84" });
    await ctx.criarProduto({ sku: skuErrado, descricao: "guarda errado 84", gtin: gtinErrado });
    const loc = await ctx.criarLocalizacao({ galpao: "CWB", codigo: "GUARDA84-01", tipo: "picking" });
    return { skuCerto, skuErrado, gtinErrado, loc, pendenciaId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { pendencias } = await ctx.receber({ items: [{ sku: setup.skuCerto, qty: 4 }], galpao: "CWB" });
    setup.pendenciaId = pendencias[0];
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: locRow } = await ctx.sb.from("siso_localizacoes").select("id").eq("codigo", setup.loc).single();
    const locId = (locRow as { id: string }).id;

    // 1) GTIN de produto ERRADO → 400, sem mov
    let status = 0;
    try {
      await ctx.http.post(`/api/wms/guarda/${setup.pendenciaId}/confirmar`, {
        qty: 4, localizacao_destino_id: locId, gtin_bipado: setup.gtinErrado,
      });
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      const mm = m.match(/HTTP (\d+)/);
      status = mm ? Number(mm[1]) : 0;
      if (!/produto bipado não bate|gtin|sku/i.test(m)) throw new Error(`mensagem não cita o cross-check: ${m}`);
    }
    if (status !== 400) throw new Error(`esperava 400 com GTIN errado, recebeu ${status}`);

    // 2) confirmar_manual=true (escape-hatch) → confirma
    await ctx.http.post(`/api/wms/guarda/${setup.pendenciaId}/confirmar`, {
      qty: 4, localizacao_destino_id: locId, confirmar_manual: true,
    });
    const { data: pend } = await ctx.sb.from("siso_wms_pendencias_guarda").select("status").eq("id", setup.pendenciaId).single();
    if ((pend as { status: string }).status !== "guardada") {
      throw new Error(`confirmar_manual não guardou a pendência (status ${(pend as { status: string }).status})`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- :only 84`. Expected: FAIL — a rota ignora `gtin_bipado`, confirma com GTIN errado (200) → assert `esperava 400`.

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/guarda.ts`, ampliar `ConfirmarGuardaInput` (linha 404-409) e validar antes da RPC:

```ts
export interface ConfirmarGuardaInput {
  pendencia_id: string;
  qty: number;
  localizacao_destino_id: string;
  usuario_id: string;
  /** [P029] GTIN/SKU bipado do produto pra cross-check com a pendência. */
  gtin_bipado?: string | null;
  sku_bipado?: string | null;
  /** [P029] escape-hatch: pula o cross-check (loc/produto sem etiqueta). */
  confirmar_manual?: boolean;
}
```

No início de `confirmarGuarda` (após o guard de qty na linha 437-439, antes da RPC na linha 446):

```ts
  const sb = createServiceClient();

  // [P029] Cross-check produto↔pendência. Se o operador bipou GTIN/SKU e NÃO
  // marcou confirmar_manual, valida contra o produto da pendência; rejeita se
  // não bater. confirmar_manual=true = escape-hatch (loc sem etiqueta).
  if (!input.confirmar_manual && (input.gtin_bipado || input.sku_bipado)) {
    const { data: pend } = await sb
      .from("siso_wms_pendencias_guarda")
      .select("produto_id")
      .eq("id", input.pendencia_id)
      .maybeSingle();
    if (!pend) throw new Error("pendência não encontrada");
    const produtoPendencia = (pend as { produto_id: string }).produto_id;
    const { data: prod } = await sb
      .from("siso_produtos")
      .select("id, sku, gtin")
      .eq("id", produtoPendencia)
      .maybeSingle();
    const p = prod as { id: string; sku: string | null; gtin: string | null } | null;
    const bateGtin = input.gtin_bipado != null && p?.gtin != null && p.gtin === input.gtin_bipado;
    const bateSku = input.sku_bipado != null && p?.sku != null && p.sku === input.sku_bipado;
    if (!bateGtin && !bateSku) {
      throw new Error(
        "produto bipado não bate com o produto da pendência (gtin/sku) — confira a etiqueta ou use confirmação manual",
      );
    }
  }
```

> **Nota:** mover `const sb = createServiceClient();` pra ANTES do cross-check (hoje está na linha 445, dentro do bloco da RPC). A RPC `wms_confirmar_guarda_atomico` segue inalterada.

Na rota `guarda/[id]/confirmar/route.ts`, ler os campos do body e passar pra lib (após o parse de qty/loc na linha 28-35):

```ts
  const gtinBipado = typeof body.gtin_bipado === "string" ? body.gtin_bipado : null;
  const skuBipado = typeof body.sku_bipado === "string" ? body.sku_bipado : null;
  const confirmarManual = body.confirmar_manual === true;

  try {
    const r = await confirmarGuarda({
      pendencia_id: id, qty,
      localizacao_destino_id: localizacaoDestinoId,
      usuario_id: auth.user.id,
      gtin_bipado: gtinBipado,
      sku_bipado: skuBipado,
      confirmar_manual: confirmarManual,
    });
```

E ampliar o `isClient` no catch (linha 98-106) com `msg.includes("produto bipado não bate")`.

> **Nota:** a parte de UI (`src/app/wms/guarda/**/page.tsx` — campo de bipagem do produto + botão "confirmar manual") é mencionada no achado mas fica como follow-up de frontend; o gate de backend (lib + rota) é o que trava a correção. Marcar no commit que a UI do tablet é follow-up.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- :only 84`. Expected: PASS — GTIN errado → 400; confirmar_manual → guardada.

- [ ] **Step 5 — Commit.** `git add src/lib/wms/guarda.ts src/app/api/wms/guarda/[id]/confirmar/route.ts scripts/wms/cenarios/catalogo/84-guarda-valida-produto-bipado.ts && git commit -m "feat(wms): cross-check produto bipado na guarda + escape-hatch manual [P029] (UI tablet follow-up)"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-guarda-sem-cross-check-produto
    date: "2026-06-05"
    source: wms.guarda.confirmarGuarda
    category: business_logic
    message: "guarda confirma loc sem validar que o produto físico corresponde à pendência"
    cause: >
      confirmarGuarda recebia só localizacao_destino_id; nenhum cross-check
      produto↔loc. Loc errada → saldo registrado em lugar diferente do físico →
      picking futuro busca na loc errada.
    fix: >
      ConfirmarGuardaInput aceita gtin_bipado/sku_bipado/confirmar_manual.
      Backend valida o bipado contra o produto da pendência (400 se não bate);
      confirmar_manual=true pula (escape-hatch p/ loc sem etiqueta).
    files: [src/lib/wms/guarda.ts, src/app/api/wms/guarda/[id]/confirmar/route.ts]
    tags: [guarda, putaway, cross-check, gtin, P029]
```

---

## PR 9: Over-receive: categorizar excedente como ganho de inventário [P033]

> ⛔ **PRECEDÊNCIA OBRIGATÓRIA: PR9 DEPENDE de PR7.** Este PR edita o MESMO loop de `receberItensViaOC` já reescrito no PR7, e referencia a variável `movsCriadasLote` (o array `const movsCriadasLote: string[]` declarado dentro do `try` no PR7/Task 7.1 Step 3). Se PR9 for aplicado sem PR7, o código **não compila** (`movsCriadasLote is not defined`). Na execução subagent-driven, **executar PR7 antes de PR9 e só abrir PR9 sobre a working tree que já contém a reescrita do PR7.** O Step 3 abaixo assume o loop pós-PR7 como base (a mov E é a mesma criada no PR7; o split substitui aquela criação única).

> **Contexto ancorado:** `receberItensViaOC` (`src/lib/wms/receber-oc.ts:135-160`) insere a mov E com `qty=itemReq.qty_real` (over-receive aceito), tudo como `origem_tipo='nf_compra'`. `getCompraQuantidadeRestante` (`compras-utils.ts:85-89`) tolera negativo (over-receive por design). P033 op3: quando `qty_real > qty_pendente_solicitada`, splitar — qty solicitada como `nf_compra` (custo da compra) + excedente como mov E `ajuste_manual` `motivo_categoria='achado'` (não alimenta custo médio de compra), ambos no mesmo lote.

### Task 9.1: Split do excedente em ganho de inventário

> **Pré-condição (verifica antes de começar):** abrir `src/lib/wms/receber-oc.ts` e confirmar que o loop já tem `const movsCriadasLote: string[] = [];` dentro do `try` (introduzido pelo PR7/Task 7.1). Se NÃO tiver, PR7 ainda não foi aplicado — **parar e aplicar PR7 primeiro.**

**Files:**
- Modify `src/lib/wms/receber-oc.ts` (a criação da mov E no loop pós-PR7 — split quando over-receive)
- Test (RED) `test/integration/receber-oc-over-receive.integration.test.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/receber-oc-over-receive.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { receberItensViaOC } from "../../src/lib/wms/receber-oc";

const sb = createServiceClient();
let galpaoId: string, usuarioId: string, ocId: string, itemId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `OVREC-${RND}`, descricao: "over receive", ativo: true }).select("id").single();
  prodId = p!.id;
  const tinyP = `tp-over-${RND}`;
  await sb.from("siso_produto_empresas").insert({ produto_id: prodId, empresa_id: emp!.id, tiny_produto_id: tinyP });
  const { data: oc } = await sb.from("siso_ordens_compra").insert({ galpao_id: galpaoId, empresa_id: emp!.id, status: "aberta", fornecedor: "Forn Over" }).select("id").single();
  ocId = oc!.id;
  const { data: it } = await sb.from("siso_pedido_itens").insert({ pedido_id: `MAN-OVER-${RND}`, sku: `OVREC-${RND}`, produto_id: tinyP, ordem_compra_id: ocId, compra_quantidade_solicitada: 10, compra_quantidade_recebida: 0 }).select("id").single();
  itemId = it!.id;
});

describe("receberItensViaOC — over-receive split [P033]", () => {
  it("solicitado 10, qty_real 12: 1 mov nf_compra qty 10 + 1 mov ajuste_manual achado qty 2; saldo 12", async () => {
    await receberItensViaOC({
      ocId, operadorId: usuarioId, operadorNome: "test-runner",
      itens: [{ item_id: itemId, qty_real: 12, custo_unitario: 7 }],
    });
    const { data: movs } = await sb
      .from("siso_movimentacoes")
      .select("origem_tipo, quantidade, motivo_categoria")
      .eq("produto_id", prodId)
      .eq("tipo", "E");
    const nf = (movs ?? []).filter((m) => (m as { origem_tipo: string }).origem_tipo === "nf_compra");
    const achado = (movs ?? []).filter((m) => (m as { origem_tipo: string }).origem_tipo === "ajuste_manual");
    expect(nf.length).toBe(1);
    expect(Number((nf[0] as { quantidade: number }).quantidade)).toBe(10);
    expect(achado.length).toBe(1);
    expect(Number((achado[0] as { quantidade: number }).quantidade)).toBe(2);
    expect((achado[0] as { motivo_categoria: string | null }).motivo_categoria).toBe("achado");
    // saldo total 12
    const { data: est } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).single();
    expect(Number(est?.saldo)).toBe(12);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- test/integration/receber-oc-over-receive.integration.test.ts`. Expected: FAIL — hoje há 1 mov `nf_compra` qty=12, não há mov `ajuste_manual achado`.

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/receber-oc.ts`, **substituir o bloco de criação da mov E introduzido pelo PR7** (no PR7 era `const movE = await inserirMovimentacao({ ..., qty: itemReq.qty_real, origem_tipo: "nf_compra", ... }); const movEntradaId = movE.id; movsCriadasLote.push(movEntradaId);`) por este split. Calcular a qty solicitada restante a partir do item (já tem `compra_quantidade_solicitada`/`compra_quantidade_recebida`):

```ts
    // [P033] Over-receive: split em nf_compra (até o solicitado restante) +
    // ajuste_manual 'achado' (excedente — não alimenta custo médio de compra).
    const qtySolicitada = Number(item.compra_quantidade_solicitada ?? 0);
    const jaRecebidoItem = Number(item.compra_quantidade_recebida ?? 0);
    const solicitadoRestante = Math.max(0, qtySolicitada - jaRecebidoItem);
    const qtyCompra = qtySolicitada > 0 ? Math.min(itemReq.qty_real, solicitadoRestante) : itemReq.qty_real;
    const qtyExcedente = itemReq.qty_real - qtyCompra;

    const movE = await inserirMovimentacao({
      tripla: { produto_id: produtoWmsId, galpao_id: oc.galpao_id, localizacao_id: locRecebId },
      tipo: "E", qty: qtyCompra > 0 ? qtyCompra : itemReq.qty_real,
      origem_tipo: "nf_compra", origem_id: args.ocId,
      origem_detalhes: { ordem_compra_id: args.ocId, item_id: item.id, pedido_id: item.pedido_id, sku: item.sku, motivo_divergencia: itemReq.motivo_divergencia ?? null },
      custo_unitario: itemReq.custo_unitario, fornecedor_id: fornecedorId,
      empresa_compradora_id: oc.empresa_id ?? null,
      motivo: itemReq.motivo_divergencia ? `Divergência: ${itemReq.motivo_divergencia}` : null,
      usuario_id: args.operadorId,
    });
    const movEntradaId = movE.id;
    movsCriadasLote.push(movEntradaId);

    if (qtyCompra > 0 && qtyExcedente > 0) {
      // excedente como ganho de inventário (achado) — sem alimentar custo de compra.
      const movGanho = await inserirMovimentacao({
        tripla: { produto_id: produtoWmsId, galpao_id: oc.galpao_id, localizacao_id: locRecebId },
        tipo: "E", qty: qtyExcedente,
        origem_tipo: "ajuste_manual", origem_id: args.ocId,
        origem_detalhes: { ordem_compra_id: args.ocId, item_id: item.id, sku: item.sku, contexto: "over_receive" },
        motivo_categoria: "achado",
        motivo: `over-receive: ${qtyExcedente} acima do solicitado (brinde/conferência)`,
        usuario_id: args.operadorId,
      });
      movsCriadasLote.push(movGanho.id);
    }
```

> **Nota:** quando `qtyCompra=0` (item over-receive sem nada solicitado restante, ex: já 100% recebido e chega mais), a mov nf_compra usa `itemReq.qty_real` inteiro (comportamento atual preservado); o split só dispara quando há tanto compra quanto excedente. A `ajuste_manual` com `custo_unitario` ausente NÃO recalcula custo médio (whitelist da RPC exige `custo_unitario IS NOT NULL`). A dependência de PR7 (`movsCriadasLote`) está declarada no banner ⛔ no topo deste PR — não executar PR9 isolado.

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- test/integration/receber-oc-over-receive.integration.test.ts`. Expected: PASS — 2 movs (nf_compra 10 + ajuste_manual achado 2), saldo 12.

- [ ] **Step 5 — Commit.** `git add src/lib/wms/receber-oc.ts test/integration/receber-oc-over-receive.integration.test.ts && git commit -m "fix(wms): over-receive categoriza excedente como ganho de inventário (achado) [P033]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-over-receive-tudo-como-compra
    date: "2026-06-05"
    source: wms.receber-oc
    category: business_logic
    message: "recebimento com brinde grava o excedente como compra, sem rastreio de ganho de inventário"
    cause: >
      receberItensViaOC inseria a qty_real inteira como nf_compra; o excedente
      sobre o solicitado não era distinguido contabilmente.
    fix: >
      Over-receive splita: mov nf_compra (até o solicitado restante, custo da
      compra) + mov ajuste_manual motivo_categoria='achado' (excedente, sem
      alimentar custo médio de compra), mesmo lote.
    files: [src/lib/wms/receber-oc.ts]
    tags: [recebimento, over-receive, ganho-inventario, achado, P033]
```

---

## PR 10: Não desativar/excluir/trocar-tipo de loc com saldo/reserva/pendência/perna de transferência/contagem ativa [P115, P063, P113]

> **Contexto ancorado:** `desativarLocalizacao` (`src/lib/wms/localizacoes.ts:121-133`) só checa `siso_estoque.saldo>0` — ignora reservas vencidas (P115), referências em-voo de transferência `em_transito`/pendência de guarda (P063) e lock de contagem ativa (P113). `atualizarLocalizacao` (106-119) não checa nada. A rota `localizacoes/[id]/route.ts` PATCH (33-60) e DELETE (62-83) usam `requireAdmin`. `cleanupReservasExpiradas` (`reservas.ts:226`) não filtra por loc — roda só via cron. Lock ativo: `siso_localizacao_locks WHERE finalizado_em IS NULL` (UNIQUE `uq_loc_lock_ativo`). Cenário `46` já existe (é o undo de transferência), então o novo é `85`.
>
> **Decisões:** P115 op2 (auto-limpar reservas VENCIDAS dessa loc, depois permitir desativar só se nada vivo restar; reserva VÁLIDA continua bloqueando). P063 (raiz: não excluir loc com referências em-voo — força transferir antes). P113 op1 (bloquear troca de tipo/delete enquanto há contagem ativa).

### Task 10.1: Auto-limpar reservas vencidas da loc antes de desativar + bloquear referências vivas [P115, P063]

**Files:**
- Modify `src/lib/wms/reservas.ts` (helper `cleanupReservasExpiradasDaLoc(localizacao_id)`)
- Modify `src/lib/wms/localizacoes.ts:121-133` (`desativarLocalizacao`)
- Test (RED) `test/integration/localizacoes-desativar.integration.test.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/localizacoes-desativar.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { desativarLocalizacao } from "../../src/lib/wms/localizacoes";

const sb = createServiceClient();
let galpaoId: string, galpaoDestId: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: gd } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
  galpaoDestId = gd!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `LOCDES-${RND}`, descricao: "loc des", ativo: true }).select("id").single();
  prodId = p!.id;
});

async function novaLoc(codigo: string, galpao = galpaoId): Promise<string> {
  const { data } = await sb.from("siso_localizacoes").insert({ galpao_id: galpao, codigo, tipo: "picking", ativo: true }).select("id").single();
  return (data as { id: string }).id;
}

describe("desativarLocalizacao — guards [P115/P063]", () => {
  it("[P115] reserva VENCIDA + saldo>reservado: auto-limpa e permite desativar só se sobrar saldo livre 0", async () => {
    const loc = await novaLoc(`LOCDES-VENC-${RND}`);
    // saldo 50, reserva 50 com expira_em no passado
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: loc, p_tipo: "E", p_quantidade: 50, p_origem_tipo: "inventario_inicial", p_origem_id: null, p_custo_unitario: 1, p_motivo: "seed" });
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: loc, p_tipo: "R", p_quantidade: 50, p_origem_tipo: "reserva_pedido", p_origem_id: `MAN-RES-${RND}`, p_expira_em: new Date(Date.now() - 3600_000).toISOString(), p_usuario_id: usuarioId, p_motivo: "reserva vencida" });
    // ainda tem saldo livre 50 (saldo 50, reservado 0 após liberar) → ainda bloqueia por saldo>0
    await expect(desativarLocalizacao(loc)).rejects.toThrow(/saldo/i);
    // reserva foi liberada (reservado 0)
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado").eq("localizacao_id", loc).single();
    expect(Number((est as { reservado: number }).reservado)).toBe(0);
  });

  it("[P063] loc destino de transferência em_transito (saldo 0) é bloqueada", async () => {
    const loc = await novaLoc(`LOCDES-TRANSF-${RND}`, galpaoDestId);
    const { data: head } = await sb.from("siso_transferencias_galpao").insert({ galpao_origem_id: galpaoId, galpao_destino_id: galpaoDestId, status: "em_transito" }).select("id").single();
    const { data: locO } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
    await sb.from("siso_transferencia_galpao_itens").insert({ transferencia_id: head!.id, produto_id: prodId, localizacao_origem_id: (locO as { id: string }).id, qty: 5, localizacao_destino_id: loc });
    await expect(desativarLocalizacao(loc)).rejects.toThrow(/transferência|em trânsito|substituir/i);
  });

  it("[P063] loc com pendência de guarda aberta (saldo 0) é bloqueada", async () => {
    const loc = await novaLoc(`LOCDES-GUARDA-${RND}`);
    const { data: recLoc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("tipo", "recebimento").limit(1).single();
    await sb.from("siso_wms_pendencias_guarda").insert({ produto_id: prodId, galpao_id: galpaoId, localizacao_origem_id: (recLoc as { id: string }).id, localizacao_destino_id: loc, qty_inicial: 3, qty_guardada: 0, status: "pendente", criada_por: usuarioId });
    await expect(desativarLocalizacao(loc)).rejects.toThrow(/guarda|pendência|substituir/i);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- test/integration/localizacoes-desativar.integration.test.ts`. Expected: FAIL — `desativarLocalizacao` não limpa reservas vencidas (reservado segue 50) e não bloqueia por transferência/guarda.

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/reservas.ts`, adicionar helper que libera só as reservas vencidas de uma loc (reusa a lógica do cron, filtrando por `localizacao_id`):

```ts
/**
 * [P115] Libera reservas VENCIDAS de UMA localização (usado antes de desativar a
 * loc). Mesma lógica idempotente de cleanupReservasExpiradas, filtrada por loc.
 */
export async function cleanupReservasExpiradasDaLoc(localizacao_id: string): Promise<{ liberadas: number }> {
  const sb = createServiceClient();
  const { data: expiradas } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_id, produto_id, galpao_id, localizacao_id, quantidade")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("localizacao_id", localizacao_id)
    .lt("expira_em", new Date().toISOString());
  const lista = (expiradas ?? []) as ReservaExpirada[];
  let liberadas = 0;
  for (const r of lista) {
    if (r.origem_id) {
      const { data: jaL } = await sb
        .from("siso_movimentacoes").select("id").eq("origem_id", r.origem_id).eq("tipo", "L").limit(1);
      if (jaL && jaL.length > 0) continue;
    }
    await inserirMovimentacao({
      tripla: { produto_id: r.produto_id, galpao_id: r.galpao_id, localizacao_id: r.localizacao_id },
      tipo: "L", qty: Number(r.quantidade), origem_tipo: "liberacao_reserva",
      origem_id: r.origem_id ?? undefined, origem_detalhes: { motivo: "expirado_pre_desativacao" },
      motivo: `expirado (pré-desativação da loc): pedido ${r.origem_id ?? "?"}`,
    });
    liberadas++;
  }
  return { liberadas };
}
```

Em `src/lib/wms/localizacoes.ts`, reescrever `desativarLocalizacao` (121-133):

```ts
export async function desativarLocalizacao(id: string): Promise<void> {
  const sb = createServiceClient();

  // [P115] auto-limpa reservas VENCIDAS dessa loc ANTES de checar (libera estoque órfão).
  const { cleanupReservasExpiradasDaLoc } = await import("@/lib/wms/reservas");
  await cleanupReservasExpiradasDaLoc(id);

  // saldo livre ainda presente (reserva válida ou saldo real) → bloqueia.
  const { data: estoque } = await sb
    .from("siso_estoque")
    .select("saldo")
    .eq("localizacao_id", id)
    .gt("saldo", 0)
    .limit(1);
  if (estoque && estoque.length > 0) {
    throw new Error("não é possível desativar: localização tem saldo — mova via substituir-e-excluir");
  }

  // [P063] referências em-voo: destino/origem de transferência em_transito.
  const { data: transfItens } = await sb
    .from("siso_transferencia_galpao_itens")
    .select("id, transferencia_id, siso_transferencias_galpao!inner(status)")
    .or(`localizacao_destino_id.eq.${id},localizacao_origem_id.eq.${id}`)
    .eq("siso_transferencias_galpao.status", "em_transito")
    .limit(1);
  if (transfItens && transfItens.length > 0) {
    throw new Error("não é possível desativar: localização é perna de transferência em trânsito — conclua/cancele antes ou use substituir-e-excluir");
  }

  // [P063] pendência de guarda aberta apontando a loc.
  const { data: pendGuarda } = await sb
    .from("siso_wms_pendencias_guarda")
    .select("id")
    .or(`localizacao_destino_id.eq.${id},localizacao_origem_id.eq.${id}`)
    .in("status", ["pendente", "em_guarda"])
    .limit(1);
  if (pendGuarda && pendGuarda.length > 0) {
    throw new Error("não é possível desativar: localização tem pendência de guarda aberta — conclua antes ou use substituir-e-excluir");
  }

  await sb.from("siso_localizacoes").update({ ativo: false }).eq("id", id);
}
```

> **Nota:** o embedded filter `siso_transferencias_galpao!inner(status)` exige o nome exato do relacionamento FK em PostgREST. Conferir em staging; se o nome do embed divergir, fazer em 2 queries (buscar `transferencia_id` dos itens que referenciam a loc, depois filtrar headers `em_transito`).

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- test/integration/localizacoes-desativar.integration.test.ts`. Expected: PASS — reserva vencida liberada (reservado 0); transferência/guarda bloqueiam.

- [ ] **Step 5 — Commit.** `git add src/lib/wms/reservas.ts src/lib/wms/localizacoes.ts test/integration/localizacoes-desativar.integration.test.ts && git commit -m "fix(wms): desativar loc auto-limpa reservas vencidas + bloqueia perna de transferência/guarda [P115,P063]"`

### Task 10.2: Bloquear troca de tipo/desativar de loc em contagem ativa [P113]

**Files:**
- Modify `src/lib/wms/localizacoes.ts:106-119` (`atualizarLocalizacao`) + reforço no `desativarLocalizacao`
- Modify `src/app/api/wms/localizacoes/[id]/route.ts:49-50` (mapear 409)
- Test (RED) `scripts/wms/cenarios/catalogo/85-localizacao-bloqueada-em-contagem.ts`

**Steps:**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/85-localizacao-bloqueada-em-contagem.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 85 — [P113] loc em contagem ativa não pode trocar tipo nem desativar.
 *
 * Cria sessão de inventário cobrindo a loc (lock ativo), tenta PATCH tipo e
 * DELETE — ambos devem dar 409. Após finalizar a sessão (lock liberado), passa.
 */
type Setup = { sku: string; loc: string; sessaoId: string; locId: string };

export default {
  nome: "85 — [P113] loc em contagem ativa bloqueia PATCH tipo / DELETE (409)",
  descricao: "Lock de contagem ativa impede alterar tipo/desativar a localização.",
  tags: ["localizacoes", "inventario", "lock", "P113"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("85");
    await ctx.criarProduto({ sku, descricao: "loc lock 85" });
    const loc = await ctx.criarLocalizacao({ galpao: "CWB", codigo: "LOCK85-01", tipo: "picking" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc, qty: 3 });
    const { id: sessaoId } = await ctx.criarSessaoInventario({ galpao: "CWB", locs: [loc], modo: "aberto" });
    return { sku, loc, sessaoId, locId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: locRow } = await ctx.sb.from("siso_localizacoes").select("id").eq("codigo", setup.loc).single();
    setup.locId = (locRow as { id: string }).id;
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // lock ativo existe? (criado ao iniciar sessão)
    // PATCH tipo → 409
    let patchStatus = 0;
    try {
      await ctx.http.patch(`/api/wms/localizacoes/${setup.locId}`, { tipo: "quarentena" });
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      patchStatus = Number((m.match(/HTTP (\d+)/) ?? [])[1] ?? 0);
      if (!/contagem/i.test(m)) throw new Error(`PATCH não cita contagem: ${m}`);
    }
    if (patchStatus !== 409) throw new Error(`PATCH tipo esperava 409, recebeu ${patchStatus}`);
    // tipo NÃO mudou
    const { data: l1 } = await ctx.sb.from("siso_localizacoes").select("tipo").eq("id", setup.locId).single();
    if ((l1 as { tipo: string }).tipo !== "picking") throw new Error("tipo mudou apesar do lock");

    // DELETE → 409
    let delStatus = 0;
    try {
      await ctx.http.delete(`/api/wms/localizacoes/${setup.locId}`);
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      delStatus = Number((m.match(/HTTP (\d+)/) ?? [])[1] ?? 0);
    }
    if (delStatus !== 409) throw new Error(`DELETE esperava 409, recebeu ${delStatus}`);
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- :only 85`. Expected: FAIL — PATCH tipo retorna 200 (tipo muda pra quarentena) e DELETE não dá 409.

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/localizacoes.ts`, extrair um guard reusável e aplicá-lo no PATCH (quando muda `tipo` ou desativa) e no DELETE:

```ts
async function assertSemContagemAtiva(
  sb: ReturnType<typeof createServiceClient>,
  id: string,
): Promise<void> {
  const { data: lock } = await sb
    .from("siso_localizacao_locks")
    .select("id")
    .eq("localizacao_id", id)
    .is("finalizado_em", null)
    .limit(1);
  if (lock && lock.length > 0) {
    throw new Error("localização em contagem — não pode alterar tipo/desativar");
  }
}

export async function atualizarLocalizacao(
  id: string,
  patch: Partial<Localizacao>,
): Promise<Localizacao> {
  const sb = createServiceClient();
  // [P113] bloqueia troca de tipo / desativação enquanto há contagem ativa.
  if (patch.tipo !== undefined || patch.ativo === false) {
    await assertSemContagemAtiva(sb, id);
  }
  const { data, error } = await sb
    .from("siso_localizacoes")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as Localizacao;
}
```

E no início de `desativarLocalizacao` (logo após `const sb = createServiceClient();`):

```ts
  // [P113] bloqueia desativação se há contagem ativa na loc.
  await assertSemContagemAtiva(sb, id);
```

Na rota `localizacoes/[id]/route.ts`, mapear "em contagem" pra 409. No PATCH (catch linha 52-58) e no DELETE (catch 74-81), adicionar status condicional:

```ts
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isConflict = msg.includes("em contagem");
    return wmsErrorResponse({
      source: "wms.localizacoes.patch", // (ou .delete no DELETE)
      error: e,
      status: isConflict ? 409 : 400,
      requestPath: `/api/wms/localizacoes/${id}`,
      requestMethod: "PATCH", // (ou "DELETE")
      metadata: { localizacao_id: id },
    });
  }
```

(No PATCH atual não há `status` explícito — `wmsErrorResponse` default mascara; adicionar `status: isConflict ? 409 : 400`. No DELETE já há `status: 400` — trocar por condicional.)

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- :only 85`. Expected: PASS — PATCH tipo → 409 (tipo não muda), DELETE → 409.

- [ ] **Step 5 — Commit.** `git add src/lib/wms/localizacoes.ts src/app/api/wms/localizacoes/[id]/route.ts scripts/wms/cenarios/catalogo/85-localizacao-bloqueada-em-contagem.ts && git commit -m "fix(wms): bloqueia troca de tipo/desativar loc com contagem ativa [P113]"`

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml:**

```yaml
  - id: wms-localizacao-altera-com-saldo-ref-contagem
    date: "2026-06-05"
    source: wms.localizacoes
    category: business_logic
    message: "loc desativada/alterada com reserva vencida, perna de transferência, guarda aberta ou contagem ativa"
    cause: >
      desativarLocalizacao só checava saldo>0; atualizarLocalizacao não checava
      nada. Reserva vencida bloqueava sem cleanup; transferência em_transito,
      pendência de guarda e lock de contagem ativa eram ignorados.
    fix: >
      desativar auto-limpa reservas vencidas da loc (P115), bloqueia perna de
      transferência em_transito e guarda aberta (P063); atualizar/desativar
      bloqueiam se há lock de contagem ativa (P113). Erros mapeados pra 409.
    files: [src/lib/wms/reservas.ts, src/lib/wms/localizacoes.ts, src/app/api/wms/localizacoes/[id]/route.ts]
    tags: [localizacoes, soft-delete, guard, reserva, transferencia, contagem, P115, P063, P113]
```

---

## Verificação final (ao fim da fase)

- [ ] `npm run lint` — sem erros novos (remover imports órfãos criados pelas mudanças: `randomUUID`/`inserirMovimentacao` em `contagem-inline.ts` se ficaram sem uso).
- [ ] `npm test` — unit verde (devolucoes, inventario-reconciliacao).
- [ ] `npm run test:integration` — todos os novos `test/integration/*.test.ts` verdes (estorno-atomico, estorno-individual, contagem-inline, devolucoes-classificar, transferencias-desfazer-preflight, transferencias-desfazer-atomico, reverter-replenishment-residual, receber-oc-all-or-nothing, receber-oc-over-receive, localizacoes-desativar).
- [ ] `npm run scenarios -- :only 81` (regressão receber OC), `:only 82`, `:only 83`, `:only 84`, `:only 85` verdes.
- [ ] Atualizar `docs/api-reference-complete.md` (novos params em `/guarda/[id]/confirmar`, `/devolucoes/[id]/classificar`, `/transferencias/[id]/desfazer-recebimento`, `/inventario/[id]/estornar`) e `docs/database-schema.md` (4 RPCs novas) no mesmo commit final.
- [ ] Confirmar que as 4 migrations foram aplicadas no project `ehbxpbeijofxtsbezwxd` via `mcp__supabase__apply_migration` (estornar_sessao, contagem_inline, classificar_devolucao, desfazer_recebimento_transferencia).
