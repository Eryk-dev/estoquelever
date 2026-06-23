# Raio-X Fase 6d — Guards de compra e devolução Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal:** Fechar os 8 buracos de **guard / estorno / status** nos fluxos de **compra de fornecedor** e **devolução** do WMS. Hoje a rota de devolução de item de compra desvincula o item **sem estornar a saída** (saldo fica menor que o físico) e **sem checar se o pedido já foi lançado** (pedido "pronto" com item solto); o cancelamento de item de compra **zera a separação cega** mesmo com quantidade já picada; o status da OC fica **estale** ao devolver um item; confirmar equivalente **muta a identidade do item in-place** (histórico ambíguo); cancelar a compra **mata o pedido pra sempre** mesmo quando a OC só foi cancelada (não esgotada); desfazer um ajuste já consumido **retorna 500 críptico**; e desclassificar devolução **antiga (pré-FK)** não acha as movs (estoque não volta pro monte). Cada fix é um **guard de pré-voo**, um **estorno-via-ledger correto**, ou um **recálculo de status** — nada de infra nova.

**Architecture:** Todas as correções são cirúrgicas em rotas Next.js (App Router) `/api/wms/compras/**` e em libs puras-ish (`compras-utils.ts`, `devolucoes.ts`, `movimentacoes.ts`). O write de ledger continua passando **exclusivamente** por `inserirMovimentacao`/`estornarMovimentacao` (`src/lib/wms/ledger.ts`). Guards são `SELECT` antes de mutar → `409`/`400` quando o estado não permite. Ordem dura: **P047 (bloqueio se lançado) roda ANTES de P046 (estorno) na mesma rota `devolver`**. Nenhuma migration nesta fase (todos os achados têm `needs_migration:false`).

**Tech Stack:** Next.js 16 (App Router, route handlers) · TypeScript strict · Supabase service role (`createServiceClient()`) · ledger 3D via `wms_inserir_movimentacao` (RPC única de write) · testes: **vitest unit** (`src/**/*.test.ts`), **integration** contra staging (`test/integration/**`), **scenarios E2E HTTP** (`scripts/wms/cenarios/catalogo/NN-*.ts`). Project Supabase staging: `ehbxpbeijofxtsbezwxd`.

---

## PR 1: Guards de compra/devolução [P040, P047, P046, P045, P035, P155, P053, P070]

> **Ordem interna das tasks** segue dependências e blast: quick wins puros primeiro (P045 unit, P070 scenario, P040 scenario), depois a rota `devolver` onde **P047 precede P046** (Task 1.4 → 1.5, mesma rota), depois P035 (cancelamento de compra → reentrada), P155 (equivalente cria item novo), e P053 (fallback de desclassificação legada).
>
> **Decisão vinculante D2** (mestre §Decisões): pedido volta a `pendente` **só** quando a OC foi **cancelada** (re-roteável); se o item é genuinamente **indisponível/esgotado**, o pedido **não** reentra (terminal). Aplicada em P035.

---

### Task 1.1: P045 — status da OC volta pra `comprado` quando nenhum item remanescente foi recebido

**Files**
- Modify `src/lib/compras-utils.ts:198-214` (dentro de `cancelOcIfEmpty`, o ramo final que hoje faz `return` mudo)
- Test (Create) `src/lib/compras-utils.test.ts`

Estado atual confirmado: `cancelOcIfEmpty` (linhas 178-234) já trata `sem itens → 'cancelado'`, `allRecebido → 'recebido'`, `someRecebido → 'parcialmente_recebido'`, mas o **else** (linha 213) faz `return` mantendo o status estale da OC. A nota (op2) exige: **nenhum item recebido entre os remanescentes → `'comprado'` (= "em compra"/esperando)**. O enum da CHECK (migration `20260311`) usa o literal `'comprado'` (não existe `'em_compra'`).

- [ ] **Step 1 — Escrever o teste que falha.** Criar `src/lib/compras-utils.test.ts`. Mockar o supabase client (mesmo padrão dos demais testes puros do repo: objeto encadeável `from().select().eq()` → `{ data, error }` e `from().update().eq()` capturando o payload). O teste cobre os 4 ramos, com foco no novo (`comprado`):

```ts
import { describe, it, expect, vi } from "vitest";
import { cancelOcIfEmpty } from "./compras-utils";

/**
 * Stub mínimo do supabase client usado por cancelOcIfEmpty:
 * - .from("siso_pedido_itens").select(...).eq(...) → { data: itens, error: null }
 * - .from("siso_ordens_compra").update({status}).eq(...) → captura o status
 */
function makeSupabaseStub(itens: Array<Record<string, unknown>>) {
  const captured: { status?: string } = {};
  const client = {
    from(table: string) {
      if (table === "siso_pedido_itens") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: itens, error: null }),
          }),
        };
      }
      // siso_ordens_compra
      return {
        update: (payload: { status: string }) => {
          captured.status = payload.status;
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
  };
  return { client: client as never, captured };
}

describe("cancelOcIfEmpty — recálculo de status da OC ao devolver item", () => {
  it("itens remanescentes, NENHUM recebido → status volta pra 'comprado' (em compra)", async () => {
    const { client, captured } = makeSupabaseStub([
      { id: "i1", compra_status: "comprado", compra_quantidade_recebida: 0 },
      { id: "i2", compra_status: "comprado", compra_quantidade_recebida: null },
    ]);
    await cancelOcIfEmpty(client, "oc-1", "test");
    expect(captured.status).toBe("comprado");
  });

  it("algum item recebido (qty>0) → 'parcialmente_recebido'", async () => {
    const { client, captured } = makeSupabaseStub([
      { id: "i1", compra_status: "comprado", compra_quantidade_recebida: 0 },
      { id: "i2", compra_status: "recebido", compra_quantidade_recebida: 3 },
    ]);
    await cancelOcIfEmpty(client, "oc-1", "test");
    expect(captured.status).toBe("parcialmente_recebido");
  });

  it("todos recebido → 'recebido'", async () => {
    const { client, captured } = makeSupabaseStub([
      { id: "i1", compra_status: "recebido", compra_quantidade_recebida: 2 },
      { id: "i2", compra_status: "recebido", compra_quantidade_recebida: 1 },
    ]);
    await cancelOcIfEmpty(client, "oc-1", "test");
    expect(captured.status).toBe("recebido");
  });

  it("sem itens remanescentes → 'cancelado'", async () => {
    const { client, captured } = makeSupabaseStub([]);
    await cancelOcIfEmpty(client, "oc-1", "test");
    expect(captured.status).toBe("cancelado");
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/lib/compras-utils.test.ts`
  Expected: **FAIL** no caso 1 (`itens remanescentes, NENHUM recebido`) — `captured.status` fica `undefined` porque o ramo `else` faz `return` sem chamar o `update` (os outros 3 casos passam).

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/compras-utils.ts`, trocar o `return` mudo (linha 213) por `newStatus = "comprado"`:

```ts
    if (allRecebido) {
      newStatus = "recebido";
    } else if (someRecebido) {
      newStatus = "parcialmente_recebido";
    } else {
      // P045: itens remanescentes mas NENHUM recebido → OC volta a "em compra"
      // (literal 'comprado' do enum). Status estale anterior (ex.: parcialmente_recebido)
      // não descreve a realidade ("esperando"). Nota op2.
      newStatus = "comprado";
    }
```

- [ ] **Step 4 — Rodar e ver passar.** `npm test -- src/lib/compras-utils.test.ts`
  Expected: **PASS** (4/4).

- [ ] **Step 5 — Commit.**
```bash
git add src/lib/compras-utils.ts src/lib/compras-utils.test.ts
git commit -m "fix(wms): P045 — OC volta a 'comprado' quando nenhum remanescente foi recebido

cancelOcIfEmpty deixava o status estale (return mudo) quando sobravam
itens não-recebidos ao devolver um item. Agora reseta pra 'comprado'
(em compra/esperando), distinguindo de 'parcialmente_recebido'.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: p045-oc-status-estale-ao-devolver
    date: "2026-06-05"
    source: wms/compras/devolver
    category: business_logic
    message: "Devolver 1 de N itens deixava o status da OC estale ('parcialmente_recebido') quando nenhum item remanescente havia sido recebido."
    cause: >
      cancelOcIfEmpty (compras-utils.ts) tinha um ramo else com return mudo quando
      restavam itens não-recebidos — mantinha o status anterior em vez de resetar pra
      'comprado' (em compra/esperando). Atrapalhava relatório/cobrança/reorder.
    fix: >
      Trocar o return pelo set newStatus='comprado' no ramo (remainingItems>0,
      !allRecebido, !someRecebido). Garantir que o UPDATE de status sempre roda.
    files:
      - src/lib/compras-utils.ts
      - src/lib/compras-utils.test.ts
    tags: [compras, oc, status, devolver]
```

---

### Task 1.2: P070 — rejeitar desfazer ajuste já consumido (409 amigável, não 500)

**Files**
- Modify `src/lib/wms/movimentacoes.ts:466-491` (`estornarAjuste` — adicionar preflight de disponibilidade antes de delegar)
- Modify `src/app/api/wms/ajuste/[id]/estornar/route.ts:42-47` (incluir o novo código na lista `isClient` → 409)
- Test (Create) `scripts/wms/cenarios/catalogo/82-desfazer-ajuste-consumido-bloqueia.ts`

Estado atual confirmado: `estornarAjuste` valida `origem_tipo='ajuste_manual'` e delega pra `estornarMovimentacao`, que cria a contra-mov (E→S) via `inserirMovimentacao` → `validarCoerencia` → lança `saldo insuficiente: ...` quando a parte já foi consumida em saídas. A rota lista mensagens-cliente (linhas 43-47) mas **não** inclui `saldo insuficiente`, então retorna **500 críptico**. A nota (op1) pede preflight + mensagem clara + **409**.

- [ ] **Step 1 — Escrever o teste que falha.** Criar o cenário E2E HTTP. Ele cria um produto, ajusta `+20` (saldo=20), vende/separa 15 (saída direta via venda manual → saldo=5), e então tenta desfazer o ajuste de +20 — deve receber **409** com mensagem clara, e o saldo **não** pode ficar negativo:

```ts
import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

/**
 * Cenário 82 — P070: desfazer ajuste de entrada já consumido por saídas
 * deve ser BLOQUEADO com 409 amigável (não 500 críptico), sem deixar saldo negativo.
 *
 * ACD-003: ajuste +20 → saída direta consome 15 (saldo=5) → desfazer (-20) falharia
 * com saldo -15. Hoje a rota responde 500. Esperado: 409 com aviso claro.
 *
 * Nota: NÃO executado — apenas typecheck.
 */

type Setup = {
  sku: string;
  loc: string;
  movAjusteId: string;
};

export default {
  nome: "82 — P070: desfazer ajuste consumido bloqueia com 409 (não 500)",
  descricao:
    "Ajuste +20 na tripla, saída direta de 15 (saldo=5). POST /ajuste/{movId}/estornar " +
    "deve responder 409 com mensagem clara de que o ajuste já foi usado em saídas; saldo NÃO negativo.",
  tags: ["ajuste", "estorno", "preflight", "p070"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("82");
    await ctx.criarProduto({ sku, descricao: "Desfazer ajuste consumido 82" });
    return { sku, loc: "", movAjusteId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    // 1. Loc de picking determinística no CWB (default seedada A-01-01 existe).
    setup.loc = "A-01-01";

    // 2. Ajuste de entrada +20 → ctx.ajusteManual devolve o mov_id da rota /ajuste.
    //    (ajusteManual resolve a tripla a partir de sku/galpao/loc e usa o body
    //     real { tripla, qty, direcao, motivo, motivo_categoria }.)
    const ajuste = await ctx.ajusteManual({
      sku,
      galpao: "CWB",
      loc: setup.loc,
      delta: 20,
      motivo: "setup cenario 82 — entrada de 20",
      motivo_categoria: "achado",
    });
    setup.movAjusteId = String(ajuste.mov_id);

    // 3. Consome 15 via saída direta (delta negativo) → saldo cai pra 5.
    await ctx.ajusteManual({
      sku,
      galpao: "CWB",
      loc: setup.loc,
      delta: -15,
      motivo: "setup cenario 82 — saída de 15 (simula consumo)",
      motivo_categoria: "perda",
    });
    await ctx.assertSaldo(sku, "CWB", setup.loc, 5);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // 4. Tentar desfazer o ajuste +20 (contra-mov S de 20 deixaria saldo -15).
    //    O harness LANÇA HttpError em qualquer 4xx/5xx não-retryable — capturar
    //    e inspecionar .status / .body (que carrega { error }).
    let erro: HttpError | null = null;
    try {
      await ctx.http.post(`/api/wms/ajuste/${setup.movAjusteId}/estornar`, {
        motivo: "tentativa de desfazer ajuste já consumido",
      });
    } catch (e) {
      if (e instanceof HttpError) erro = e;
      else throw e;
    }

    if (!erro) {
      throw new Error("P070: desfazer ajuste consumido devia ter falhado, mas passou");
    }
    if (erro.status !== 409) {
      throw new Error(
        `P070: esperava 409 ao desfazer ajuste consumido, recebeu ${erro.status} — ` +
          `body=${JSON.stringify(erro.body)}`,
      );
    }
    const body = erro.body as { error?: string };
    if (!body.error || !/já consumido|já foi usado|saída|outro ajuste/i.test(body.error)) {
      throw new Error(
        `P070: mensagem 409 não é clara o suficiente: ${JSON.stringify(body)}`,
      );
    }

    // 5. Saldo permanece em 5 (não ficou negativo, não estornou).
    await ctx.assertSaldo(setup.sku, "CWB", setup.loc, 5);
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";

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

> Nota: divergência do achado — o achado sugeria `red_test` via `/api/wms/ajuste` e separação de pedido pra consumir. Pra um RED determinístico e barato, o consumo é via **saída direta** (`ctx.ajusteManual` com `delta` negativo, que faz `direcao: 'saida'`), mesmo efeito no saldo da tripla. Usa-se `ctx.ajusteManual` (não `ctx.http.post` cru) porque o body real de `/api/wms/ajuste` é `{ tripla, qty, direcao, motivo, motivo_categoria }` — **não** `{ sku, galpao, loc, tipo, categoria }`. O assert de erro segue o padrão canônico do cenário 19: `HttpError` capturado em try/catch + inspeção de `.status` (409) e `.body.error`.

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- :only 82`
  Expected: **FAIL** — a rota responde **500** (não 409) porque `saldo insuficiente` cai no `else` de `isClient` (linhas 42-47). O assert de status 409 quebra.

- [ ] **Step 3 — Implementação mínima.**

  (a) Em `src/lib/wms/movimentacoes.ts`, adicionar preflight em `estornarAjuste` **antes** de chamar `estornarMovimentacao`. Ler saldo atual da tripla da mov original e checar se a contra-mov (S do qty original) deixaria saldo<0:

```ts
export async function estornarAjuste(input: {
  mov_id: string;
  usuario_id: string;
  motivo: string;
}): Promise<void> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo é obrigatório (≥3 caracteres)");
  }
  const sb = createServiceClient();
  const { data: mov } = await sb
    .from("siso_movimentacoes")
    .select("origem_tipo, tipo, quantidade, produto_id, galpao_id, localizacao_id")
    .eq("id", input.mov_id)
    .maybeSingle();
  if (!mov) throw new Error("mov não encontrada");
  const m = mov as {
    origem_tipo: string;
    tipo: string;
    quantidade: number;
    produto_id: string;
    galpao_id: string;
    localizacao_id: string;
  };
  if (m.origem_tipo !== "ajuste_manual") {
    throw new Error(`mov não é ajuste_manual (origem_tipo=${m.origem_tipo})`);
  }

  // P070: preflight — desfazer um ajuste de ENTRADA já parcialmente consumido
  // por saídas deixaria o saldo negativo. O ledger barra (correto), mas o erro
  // vira 500 críptico. Aqui antecipamos com 409 + mensagem clara (op1).
  if (m.tipo === "E") {
    const qtyOriginal = Number(m.quantidade);
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", m.produto_id)
      .eq("galpao_id", m.galpao_id)
      .eq("localizacao_id", m.localizacao_id)
      .maybeSingle();
    const saldoAtual = Number((est as { saldo: number } | null)?.saldo ?? 0);
    if (saldoAtual < qtyOriginal) {
      const consumido = qtyOriginal - saldoAtual;
      throw new Error(
        `ajuste já consumido: não dá pra desfazer este ajuste — já foi usado em ` +
          `${consumido} saída(s) (separação de pedido). Para corrigir o saldo, faça outro ajuste.`,
      );
    }
  }

  await estornarMovimentacao({
    mov_id: input.mov_id,
    usuario_id: input.usuario_id,
    motivo: `Estorno ajuste manual: ${input.motivo}`,
  });
}
```

  (b) Em `src/app/api/wms/ajuste/[id]/estornar/route.ts`, incluir o novo código na lista `isClient` → responde **409** (não 500):

```ts
    const msg = e instanceof Error ? e.message : String(e);
    const isStateConflict = msg.includes("ajuste já consumido");
    const isClient =
      isStateConflict ||
      msg.includes("mov não encontrada") ||
      msg.includes("não é ajuste_manual") ||
      msg.includes("já foi estornada") ||
      msg.includes("já é um estorno") ||
      msg.includes("motivo");
    return wmsErrorResponse({
      source: "wms.ajuste.estornar",
      error: e,
      status: isStateConflict ? 409 : isClient ? 400 : 500,
      requestPath: `/api/wms/ajuste/${id}/estornar`,
      requestMethod: "POST",
      metadata: { mov_id: id },
    });
```

> Nota: `wmsErrorResponse` desempacota o `error` e usa `status` como dado. A mensagem `ajuste já consumido: ...` é 4xx (revelada ao cliente). Conferir que `wmsErrorResponse` não mascara mensagens 4xx — pelo CLAUDE.md ele "revela só 4xx", então a string passa pro body.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- :only 82`
  Expected: **PASS** — 409 com mensagem `já foi usado em 15 saída(s)`, saldo permanece 5.

- [ ] **Step 5 — Commit.**
```bash
git add src/lib/wms/movimentacoes.ts src/app/api/wms/ajuste/[id]/estornar/route.ts scripts/wms/cenarios/catalogo/82-desfazer-ajuste-consumido-bloqueia.ts
git commit -m "fix(wms): P070 — preflight 409 ao desfazer ajuste já consumido

estornarAjuste lê o saldo atual da tripla; se a contra-mov deixaria
saldo<0 (ajuste de entrada já usado em saídas), lança erro de domínio
com mensagem clara e a rota responde 409 (não 500 críptico). Saldo
nunca fica negativo.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: p070-desfazer-ajuste-consumido-500
    date: "2026-06-05"
    source: wms/ajuste/estornar
    category: business_logic
    message: "Desfazer um ajuste de entrada já consumido por saídas retornava 500 críptico (saldo insuficiente do ledger), confundindo o operador."
    cause: >
      estornarAjuste delegava direto pra estornarMovimentacao; a contra-mov S do qty
      original disparava 'saldo insuficiente' no ledger, e a rota /ajuste/[id]/estornar
      não listava essa mensagem em isClient → caía em 500.
    fix: >
      Preflight em estornarAjuste: ler saldo atual da tripla; se saldoAtual<qtyOriginal
      (ajuste E já consumido), lançar 'ajuste já consumido: ...' com qty de saídas. Rota
      mapeia esse código pra 409. Ledger continua barrando o saldo negativo.
    files:
      - src/lib/wms/movimentacoes.ts
      - src/app/api/wms/ajuste/[id]/estornar/route.ts
      - scripts/wms/cenarios/catalogo/82-desfazer-ajuste-consumido-bloqueia.ts
    tags: [ajuste, estorno, preflight, inventario]
```

---

### Task 1.3: P040 — bloquear cancelamento de item de compra já separado

**Files**
- Modify `src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts:27-67` (select + guard + remover zeramento cego)
- Test (Create) `scripts/wms/cenarios/catalogo/83-cancelar-item-com-separacao-bloqueia.ts`

Estado atual confirmado: a rota valida só `compra_status==='cancelamento_pendente'` (linha 40) e então zera `separacao_marcado/quantidade_bipada/bipado_completo` (linhas 58-63, dentro do `.update({...})` 53-64) **sem checar** se há quantidade já separada (`quantidade_pega` / `mov_saida_id`). A nota (op2) exige **bloquear** com 409 instruindo a desfazer a separação antes.

- [ ] **Step 1 — Escrever o teste que falha.** Criar o cenário. Ele leva um item de compra a `cancelamento_pendente` com `quantidade_pega>0` (separação iniciada) e tenta confirmar o cancelamento — deve receber **409** e o item permanece intacto:

```ts
import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

/**
 * Cenário 83 — P040: confirmar cancelamento de item de compra com separação
 * iniciada (quantidade_pega>0) deve ser BLOQUEADO com 409, sem zerar a separação.
 *
 * Nota: NÃO executado — apenas typecheck.
 */

type Setup = {
  itemId: string;
};

export default {
  nome: "83 — P040: cancelar item de compra já separado bloqueia (409)",
  descricao:
    "Item em cancelamento_pendente com quantidade_pega>0. POST /cancelamento/confirmar " +
    "deve responder 409 e manter compra_status='cancelamento_pendente' + quantidade_pega intacta.",
  tags: ["compras", "cancelamento", "guard", "p040"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    // Cria um pedido_item diretamente em cancelamento_pendente com separação parcial.
    // (escopo do guard é a rota; não precisamos do pipeline completo de compra.)
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .insert({
        id: `CEN83-${Date.now()}`,
        // Colunas NOT NULL sem default em siso_pedidos (sem trigger que as preencha):
        // numero (text), data (date), filial_origem (enum siso_filial CWB/SP), cliente_nome (text).
        numero: `CEN83-${Date.now()}`,
        data: new Date().toISOString().slice(0, 10),
        filial_origem: "CWB",
        cliente_nome: "Cenário 83",
        status: "executando",
        status_separacao: "aguardando_compra",
        empresa_origem_id: ctx.staging.empresas.netair.id,
      })
      .select("id")
      .single();
    const pedidoId = (ped as { id: string }).id;

    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .insert({
        pedido_id: pedidoId,
        produto_id: "999999",
        sku: ctx.skuUnico("83"),
        descricao: "Item cancelamento bloqueio 83",
        quantidade_pedida: 3,
        compra_status: "cancelamento_pendente",
        compra_cancelamento_motivo: "teste",
        quantidade_pega: 2,
      })
      .select("id")
      .single();
    return { itemId: String((item as { id: string }).id) };
  },

  run: async (): Promise<void> => {
    // assertEsperado faz a chamada; run vazio (estado já montado no setup).
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // O harness LANÇA HttpError em qualquer 4xx — capturar e inspecionar .status.
    let erro: HttpError | null = null;
    try {
      await ctx.http.post(
        `/api/wms/compras/itens/${setup.itemId}/cancelamento/confirmar`,
        {},
      );
    } catch (e) {
      if (e instanceof HttpError) erro = e;
      else throw e;
    }
    if (!erro) {
      throw new Error("P040: cancelar item já separado devia ter falhado, mas passou (200)");
    }
    if (erro.status !== 409) {
      throw new Error(
        `P040: esperava 409 (item separado), recebeu ${erro.status} — ${JSON.stringify(erro.body)}`,
      );
    }
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .select("compra_status, quantidade_pega")
      .eq("id", setup.itemId)
      .single();
    const it = item as { compra_status: string; quantidade_pega: number | null };
    if (it.compra_status !== "cancelamento_pendente") {
      throw new Error(`P040: compra_status mudou pra ${it.compra_status} (devia ficar cancelamento_pendente)`);
    }
    if (Number(it.quantidade_pega ?? 0) !== 2) {
      throw new Error(`P040: quantidade_pega foi alterada (=${it.quantidade_pega}, devia ser 2)`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";

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

> Nota: divergência do achado — o `red_test` original assumia `compra_status='cancelamento_pendente'` chegando via pipeline. Aqui montamos o estado direto no banco (insert) porque o guard é uma checagem de rota independente do caminho de chegada; isso dá o RED mais barato e determinístico. `ctx.staging.empresas.netair.id` existe no fixture (ver `_harness/types.ts` `StagingFixtures.empresas.netair`). O assert de erro usa `HttpError` (try/catch + `.status`/`.body`), não `{aceitarErro}`/`.status`/`.data` — esses **não** existem no `HttpClient` (3º arg de `post` é `headers?: Record<string,string>` e sucesso retorna o body parseado, 4xx lança).

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- :only 83`
  Expected: **FAIL** — a rota responde **200** (cancela e zera a separação cega), `compra_status` vira `cancelado`. O assert de 409 quebra.

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts`: (a) incluir `quantidade_pega, mov_saida_id` no select; (b) guard 409 antes de mutar; (c) remover o zeramento cego (inalcançável após o guard, e o `buildCompraFieldReset` não é usado aqui):

```ts
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, compra_status, compra_cancelamento_motivo, quantidade_pega, mov_saida_id",
      )
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    if (item.compra_status !== "cancelamento_pendente") {
      return NextResponse.json(
        { error: "O item não está aguardando confirmação de cancelamento" },
        { status: 409 },
      );
    }

    // P040: bloqueia se a separação já foi iniciada (quantidade pega ou mov de saída).
    // Cancelar zerando os campos cegamente perderia rastreabilidade do picking.
    if (Number(item.quantidade_pega ?? 0) > 0 || item.mov_saida_id != null) {
      return NextResponse.json(
        {
          error:
            "Este item já teve separação iniciada. Desfaça a separação antes de cancelar o item.",
        },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "cancelado",
        ordem_compra_id: null,
        compra_cancelado_em: now,
        compra_cancelado_por: session.id,
      })
      .eq("id", itemId)
      .select("id, sku, descricao, compra_status, compra_cancelamento_motivo")
      .single();
```

  > Nota: removidos `separacao_marcado/_em`, `quantidade_bipada`, `bipado_completo/_em/_por` do update — eram o zeramento cego (linhas 58-63), agora inalcançável (só chega aqui quem não tem separação). O resto da rota (`checkAndCancelPedidoIfAllTerminal`, `registrarEvento`, retorno) fica intacto.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- :only 83`
  Expected: **PASS** — 409, `compra_status` segue `cancelamento_pendente`, `quantidade_pega=2`.

- [ ] **Step 5 — Commit.**
```bash
git add src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts scripts/wms/cenarios/catalogo/83-cancelar-item-com-separacao-bloqueia.ts
git commit -m "fix(wms): P040 — bloquear cancelamento de item de compra já separado

A confirmação de cancelamento zerava a separação cegamente (quantidade
pega, bipagem) mesmo com picking iniciado, deixando movs órfãs sem
estorno. Agora 409 quando quantidade_pega>0 ou mov_saida_id!=null,
instruindo a desfazer a separação antes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: p040-cancelar-item-separado-zera-cego
    date: "2026-06-05"
    source: wms/compras/cancelamento/confirmar
    category: business_logic
    message: "Confirmar cancelamento de item de compra zerava a separação cegamente (quantidade_pega/bipagem) mesmo com picking iniciado, deixando movs órfãs sem estorno."
    cause: >
      A rota validava só compra_status='cancelamento_pendente' e então zerava
      separacao_marcado/quantidade_bipada/bipado_completo sem checar quantidade_pega
      nem mov_saida_id. Auditoria quebrava (peças movidas sem compensação).
    fix: >
      Guard de pré-voo: 409 quando quantidade_pega>0 ou mov_saida_id!=null, com
      instrução de desfazer a separação primeiro. Remover o zeramento cego.
    files:
      - src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts
      - scripts/wms/cenarios/catalogo/83-cancelar-item-com-separacao-bloqueia.ts
    tags: [compras, cancelamento, guard, separacao, auditoria]
```

---

### Task 1.4: P047 — bloquear devolução de item quando o pedido já foi lançado (precede P046)

**Files**
- Modify `src/app/api/wms/compras/itens/[itemId]/devolver/route.ts:26-58` (lookup do pedido + guard `estoque_lancado` ANTES de qualquer mutação)
- Test (Create) `scripts/wms/cenarios/catalogo/84-devolver-item-pedido-lancado-bloqueia.ts`

Estado atual confirmado: `devolver/route.ts` desvincula o item da OC e reseta os campos (espalha `buildCompraFieldReset()`, linha 47) **sem checar** `siso_pedidos.estoque_lancado`. A nota é explícita: **impedir devolução se já lançado** + **PRECEDÊNCIA sobre o estorno do P046 na mesma rota** (P047 roda primeiro). `cutover.ts` confirma que `siso_pedidos.estoque_lancado` existe.

- [ ] **Step 1 — Escrever o teste que falha.** Cenário: item de compra de um pedido com `estoque_lancado=true`; `POST .../devolver` deve responder **409** e o item permanecer vinculado à OC com `compra_status` inalterado:

```ts
import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

/**
 * Cenário 84 — P047: devolver item de pedido já lançado (estoque_lancado=true)
 * deve ser BLOQUEADO com 409. Item permanece vinculado à OC.
 *
 * Nota: NÃO executado — apenas typecheck.
 */

type Setup = {
  itemId: string;
  ordemCompraId: string;
};

export default {
  nome: "84 — P047: devolver item de pedido lançado bloqueia (409)",
  descricao:
    "Pedido com estoque_lancado=true e item OC. POST /compras/itens/[id]/devolver deve " +
    "responder 409; item segue vinculado (ordem_compra_id inalterado, compra_status != aguardando_compra).",
  tags: ["compras", "devolver", "guard", "lancado", "p047"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const { data: oc } = await ctx.sb
      .from("siso_ordens_compra")
      // Coluna real é 'fornecedor' (text, NOT NULL) — NÃO existe 'fornecedor_nome'.
      // 'status' tem default 'comprado'; demais NOT NULL têm default.
      .insert({ status: "comprado", fornecedor: "Fornecedor 84" })
      .select("id")
      .single();
    const ordemCompraId = String((oc as { id: string }).id);

    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .insert({
        id: `CEN84-${Date.now()}`,
        // NOT NULL sem default em siso_pedidos (sem trigger): numero, data,
        // filial_origem (enum CWB/SP), cliente_nome.
        numero: `CEN84-${Date.now()}`,
        data: new Date().toISOString().slice(0, 10),
        filial_origem: "CWB",
        cliente_nome: "Cenário 84",
        status: "executando",
        status_separacao: "aguardando_separacao",
        estoque_lancado: true,
        empresa_origem_id: ctx.staging.empresas.netair.id,
      })
      .select("id")
      .single();
    const pedidoId = (ped as { id: string }).id;

    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .insert({
        pedido_id: pedidoId,
        produto_id: "999847",
        sku: ctx.skuUnico("84"),
        descricao: "Item devolver lançado 84",
        quantidade_pedida: 1,
        compra_status: "comprado",
        ordem_compra_id: ordemCompraId,
      })
      .select("id")
      .single();
    return { itemId: String((item as { id: string }).id), ordemCompraId };
  },

  run: async (): Promise<void> => {},

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // O harness LANÇA HttpError em qualquer 4xx — capturar e inspecionar .status.
    let erro: HttpError | null = null;
    try {
      await ctx.http.post(`/api/wms/compras/itens/${setup.itemId}/devolver`, {});
    } catch (e) {
      if (e instanceof HttpError) erro = e;
      else throw e;
    }
    if (!erro) {
      throw new Error("P047: devolver item de pedido lançado devia ter falhado, mas passou (200)");
    }
    if (erro.status !== 409) {
      throw new Error(
        `P047: esperava 409 (pedido lançado), recebeu ${erro.status} — ${JSON.stringify(erro.body)}`,
      );
    }
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .select("compra_status, ordem_compra_id")
      .eq("id", setup.itemId)
      .single();
    const it = item as { compra_status: string; ordem_compra_id: string | null };
    if (it.compra_status === "aguardando_compra") {
      throw new Error("P047: compra_status virou aguardando_compra (devolução não foi bloqueada)");
    }
    if (it.ordem_compra_id !== setup.ordemCompraId) {
      throw new Error("P047: item foi desvinculado da OC (devolução não foi bloqueada)");
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";

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

> Nota: colunas reais conferidas no schema de staging (`ehbxpbeijofxtsbezwxd`). `siso_ordens_compra`: a coluna do fornecedor é **`fornecedor`** (text, NOT NULL) — **não** existe `fornecedor_nome`; `status` tem default `'comprado'` e as demais NOT NULL têm default, então `{ status, fornecedor }` basta. `siso_pedidos`: NOT NULL **sem default e sem trigger** → `numero` (text), `data` (date), `filial_origem` (enum `siso_filial` ∈ CWB/SP), `cliente_nome` (text) — todos preenchidos acima, senão o insert do setup aborta por NOT NULL antes do assert RED. O ponto do teste é só ter uma OC válida e um pedido com `estoque_lancado=true`.

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- :only 84`
  Expected: **FAIL** — a rota responde **200** (desvincula apesar de lançado), `compra_status` vira `aguardando_compra`, `ordem_compra_id` vira null. Os asserts quebram.

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/compras/itens/[itemId]/devolver/route.ts`, após buscar o item e **antes** de qualquer update, fazer o lookup do pedido e bloquear se lançado. Incluir também `mov_saida_id` no select do item (consumido pelo P046, Task 1.5):

```ts
    // Fetch item
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, sku, ordem_compra_id, compra_status, fornecedor_oc, compra_solicitada_em, mov_saida_id",
      )
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    // P047: NÃO devolver item de pedido já lançado (estoque já saiu).
    // Precede o estorno do P046 — este guard roda ANTES de mutar/estornar.
    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select("estoque_lancado")
      .eq("id", item.pedido_id)
      .single();
    if (pedidoError) {
      throw new Error(`Erro ao buscar pedido do item: ${pedidoError.message}`);
    }
    if ((pedido as { estoque_lancado: boolean } | null)?.estoque_lancado) {
      return NextResponse.json(
        {
          error:
            "Este pedido já foi lançado (estoque já saiu). Não dá pra devolver o item — " +
            "reverta o lançamento do pedido antes.",
        },
        { status: 409 },
      );
    }

    const ordemCompraId = item.ordem_compra_id;
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- :only 84`
  Expected: **PASS** — 409; item segue vinculado.

- [ ] **Step 5 — Commit.**
```bash
git add src/app/api/wms/compras/itens/[itemId]/devolver/route.ts scripts/wms/cenarios/catalogo/84-devolver-item-pedido-lancado-bloqueia.ts
git commit -m "fix(wms): P047 — bloquear devolução de item de pedido já lançado

A rota /devolver desvinculava o item da OC mesmo com o pedido já
lançado (estoque saiu), deixando pedido 'pronto' com item solto. Agora
faz lookup de siso_pedidos.estoque_lancado e responde 409 ANTES de
qualquer mutação (precede o estorno do P046 na mesma rota).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: p047-devolver-item-pedido-lancado
    date: "2026-06-05"
    source: wms/compras/devolver
    category: business_logic
    message: "Devolver item de compra de um pedido já lançado deixava o pedido 'pronto' com item solto (estoque_lancado=true mas item em aguardando_compra)."
    cause: >
      A rota /compras/itens/[id]/devolver desvinculava o item da OC sem checar
      siso_pedidos.estoque_lancado. Pedido podia sair incompleto ou ficar parado.
    fix: >
      Lookup de siso_pedidos.estoque_lancado via item.pedido_id; 409 se true, ANTES
      de qualquer mutação (precede o estorno do P046). Incluir mov_saida_id no select
      pro estorno do P046.
    files:
      - src/app/api/wms/compras/itens/[itemId]/devolver/route.ts
      - scripts/wms/cenarios/catalogo/84-devolver-item-pedido-lancado-bloqueia.ts
    tags: [compras, devolver, guard, lancado, cutover]
```

---

### Task 1.5: P046 — estornar a saída quando o item de compra é devolvido (pedido NÃO lançado)

**Files**
- Modify `src/app/api/wms/compras/itens/[itemId]/devolver/route.ts` (entre o guard do P047 e o `buildCompraFieldReset`: estornar `mov_saida_id` se não-null)
- Test (Create) `scripts/wms/cenarios/catalogo/85-devolver-item-estorna-saida.ts`

Estado atual confirmado: `buildCompraFieldReset()` seta `mov_saida_id: null` (compras-utils.ts:28) **sem estornar** a mov S. A rota espalha esse reset (linha 47), então se o item foi picado, o saldo **não volta**: vínculo apagado, saldo permanece deduzido. O precedente correto é `estornarMovimentacao` (ledger.ts:363). A nota: gravar a entrada que desfaz a saída **só quando pedido NÃO lançado** (lançado → ganha o bloqueio do P047, que **já roda primeiro** após Task 1.4).

- [ ] **Step 1 — Escrever o teste que falha.** Cenário: item de pedido **não lançado** com `mov_saida_id` setado (estoque já saiu de uma loc). `POST .../devolver` deve (1) criar nova mov **E** (estorno) devolvendo a qty à loc origem, (2) `siso_estoque` volta ao saldo pré-pick, (3) `mov_saida_id` do item fica null:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 85 — P046: devolver item de pedido NÃO lançado com mov_saida_id setado
 * deve estornar a saída (nova mov E), devolver o saldo à loc e zerar mov_saida_id.
 *
 * Nota: NÃO executado — apenas typecheck.
 */

type Setup = {
  sku: string;
  loc: string;
  itemId: string;
  movSaidaId: string;
};

export default {
  nome: "85 — P046: devolver item (não lançado) estorna a saída",
  descricao:
    "Item de pedido NÃO lançado com mov_saida_id (estoque já saiu). POST /devolver: nova mov E " +
    "devolve a qty à loc origem, saldo volta ao pré-pick, mov_saida_id fica null.",
  tags: ["compras", "devolver", "estorno", "p046"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("85");
    const loc = "A-01-01";
    await ctx.criarProduto({ sku, descricao: "Devolver estorna saída 85" });
    // Entra 10 (saldo=10), depois sai 4 via saída direta → gera a mov S cujo id
    // simula o mov_saida_id do pick. ctx.ajusteManual usa o body real de /ajuste.
    await ctx.ajusteManual({
      sku, galpao: "CWB", loc, delta: 10, motivo: "setup 85 entrada", motivo_categoria: "achado",
    });
    const saida = await ctx.ajusteManual({
      sku, galpao: "CWB", loc, delta: -4, motivo: "setup 85 saída (pick)", motivo_categoria: "perda",
    });
    const movSaidaId = String(saida.mov_id);
    await ctx.assertSaldo(sku, "CWB", loc, 6);

    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .insert({
        id: `CEN85-${Date.now()}`,
        // NOT NULL sem default em siso_pedidos (sem trigger): numero, data,
        // filial_origem (enum CWB/SP), cliente_nome.
        numero: `CEN85-${Date.now()}`,
        data: new Date().toISOString().slice(0, 10),
        filial_origem: "CWB",
        cliente_nome: "Cenário 85",
        status: "executando",
        status_separacao: "aguardando_compra",
        estoque_lancado: false,
        empresa_origem_id: ctx.staging.empresas.netair.id,
      })
      .select("id")
      .single();
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .insert({
        pedido_id: (ped as { id: string }).id,
        produto_id: "999985",
        sku,
        descricao: "Item devolver estorna 85",
        quantidade_pedida: 4,
        compra_status: "comprado",
        mov_saida_id: movSaidaId,
      })
      .select("id")
      .single();
    return { sku, loc, itemId: String((item as { id: string }).id), movSaidaId };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Caminho feliz: 2xx retorna o body parseado direto (sem .status). Em 4xx/5xx
    // o harness LANÇA HttpError, o que estoura o cenário com a mensagem do erro —
    // exatamente o sinal de falha desejado, sem precisar checar status manualmente.
    await ctx.http.post(`/api/wms/compras/itens/${setup.itemId}/devolver`, {});
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // 1. Saldo voltou ao pré-pick (6 + 4 estornado = 10).
    await ctx.assertSaldo(setup.sku, "CWB", setup.loc, 10);

    // 2. Existe uma mov E de estorno apontando pra mov de saída original.
    const { data: estorno } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id, tipo, estorno_de")
      .eq("estorno_de", setup.movSaidaId)
      .maybeSingle();
    if (!estorno) {
      throw new Error("P046: nenhuma mov de estorno (estorno_de=mov_saida) foi criada");
    }
    if ((estorno as { tipo: string }).tipo !== "E") {
      throw new Error(`P046: estorno tem tipo ${(estorno as { tipo: string }).tipo} (devia ser E)`);
    }

    // 3. mov_saida_id do item ficou null.
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .select("mov_saida_id, compra_status")
      .eq("id", setup.itemId)
      .single();
    if ((item as { mov_saida_id: string | null }).mov_saida_id != null) {
      throw new Error("P046: mov_saida_id não foi zerado");
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";

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

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- :only 85`
  Expected: **FAIL** — saldo permanece **6** (estorno não roda); nenhuma mov com `estorno_de=movSaidaId` existe. O assert de saldo=10 quebra.

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/compras/itens/[itemId]/devolver/route.ts`, importar `estornarMovimentacao` e, **após** o guard do P047 (pedido não lançado garantido nesse ponto) e **antes** do update com `buildCompraFieldReset`, estornar a saída se houver:

```ts
import { estornarMovimentacao } from "@/lib/wms/ledger";
```

```ts
    // P046: se o item teve estoque baixado (mov_saida_id), gravar o estorno (E)
    // que devolve a qty à loc origem ANTES de zerar mov_saida_id. Pedido NÃO
    // lançado é garantido pelo guard do P047 acima (lançado já retornou 409).
    if (item.mov_saida_id) {
      try {
        await estornarMovimentacao({
          mov_id: String(item.mov_saida_id),
          usuario_id: session.id,
          motivo: `Devolução de item de compra ${itemId} — estorno da saída`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Idempotência: se já estornado, segue (reset zera o vínculo).
        if (!/já foi estornada|já é um estorno/.test(msg)) {
          throw e;
        }
      }
    }

    const ordemCompraId = item.ordem_compra_id;

    // Update item: back to aguardando_compra, unlink from OC
    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        ...buildCompraFieldReset(),
        compra_status: "aguardando_compra",
        ordem_compra_id: null,
        comprado_em: null,
        comprado_por: null,
        compra_solicitada_em: item.compra_solicitada_em ?? new Date().toISOString(),
      })
      .eq("id", itemId)
      .select("id, sku, descricao, fornecedor_oc, compra_status")
      .single();
```

  > Nota: `buildCompraFieldReset()` continua setando `mov_saida_id: null` (o estorno é responsabilidade do caller, conforme finding). A ordem é: guard P047 → estorno P046 → reset. `ordemCompraId` foi movido pra logo antes do update (era declarado na linha 41 antes; mover é cirúrgico e mantém o `cancelOcIfEmpty` na linha 60 funcionando).

  > Nota (tratamento de erro): o `catch` só engole as mensagens de **idempotência** (`/já foi estornada|já é um estorno/`) — qualquer outro throw de `estornarMovimentacao` (ex.: `saldo insuficiente`, falha de FK de NF) é **re-lançado** e cai no `catch` externo da rota (linhas 82-91), que já responde `500 { error: "Erro interno ao devolver item" }`. Isso é o comportamento desejado: uma falha inesperada de estorno **não** deve continuar pro reset (que apagaria o vínculo sem o saldo ter voltado). O cenário 85 é **caminho feliz (2xx)** e **não** depende de nenhuma mensagem 4xx vinda desta rota — ele só verifica saldo, mov de estorno e `mov_saida_id` null; portanto o 500 genérico do catch não afeta o teste.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- :only 85`
  Expected: **PASS** — saldo volta a 10, mov E com `estorno_de=movSaidaId` existe, `mov_saida_id` null.

- [ ] **Step 5 — Commit.**
```bash
git add src/app/api/wms/compras/itens/[itemId]/devolver/route.ts scripts/wms/cenarios/catalogo/85-devolver-item-estorna-saida.ts
git commit -m "fix(wms): P046 — estornar a saída ao devolver item (pedido não lançado)

A rota /devolver zerava mov_saida_id sem estornar a mov S, deixando o
saldo menor que o físico. Agora, após o guard do P047 (pedido não
lançado), chama estornarMovimentacao(mov_saida_id) para gravar o E que
devolve a qty à loc; só então reseta os campos. Idempotente.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: p046-devolver-item-nao-estorna-saida
    date: "2026-06-05"
    source: wms/compras/devolver
    category: business_logic
    message: "Devolver item de compra que já tinha estoque baixado (mov_saida_id) zerava o vínculo sem estornar a mov S — saldo do sistema ficava menor que o físico."
    cause: >
      buildCompraFieldReset setava mov_saida_id=null sem gravar o estorno; a rota
      /devolver espalhava esse reset. O estorno correto (estornarMovimentacao) existia
      no precedente de validar-oc-item mas não fora replicado.
    fix: >
      Na rota /devolver, após o guard do P047 (pedido não lançado garantido), chamar
      estornarMovimentacao(mov_saida_id) ANTES do reset. Idempotente (tolera duplo
      estorno). Saldo volta ao pré-pick.
    files:
      - src/app/api/wms/compras/itens/[itemId]/devolver/route.ts
      - scripts/wms/cenarios/catalogo/85-devolver-item-estorna-saida.ts
    tags: [compras, devolver, estorno, ledger, saldo]
```

---

### Task 1.6: P035 — pedido reentra como `pendente` quando a OC foi cancelada (não quando indisponível)

**Files**
- Modify `src/lib/compras-utils.ts:125-170` (`checkAndCancelPedidoIfAllTerminal`: distinguir terminal-por-cancelamento de terminal-por-indisponível; retornar `pedidoReentrou`)
- Modify `src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts:73-82` (desestruturar `pedidoReentrou` e **pular** `checkAndReleasePedidos` na reentrada — evita que o release sobrescreva o `status='pendente'` recém-setado)
- Test (Create) `scripts/wms/cenarios/catalogo/86-compra-cancelada-pedido-reentra.ts`

Estado atual confirmado: `checkAndCancelPedidoIfAllTerminal` (linhas 125-170) trata **todos terminais → cancela o pedido** (`status='cancelado'`, `status_separacao=null`). `TERMINAL_COMPRA_STATUSES = {indisponivel, cancelado}`. O reconciliador (`reconciliador-oc.ts:38`) só varre `status_separacao IN ('validacao_oc','aguardando_compra')`, então pedido cancelado nunca religa. **D2 (vinculante):** se TODOS os terminais são por **cancelamento** → pedido **reentra** (`status='pendente'`, `status_separacao=null`, limpar campos de compra); se houver pelo menos um **indisponível** → **cancela** (terminal real, evita loop de re-roteamento).

- [ ] **Step 1 — Escrever o teste que falha.** Cenário E2E: pedido OC em `aguardando_compra`, compra criada, item cancelado (`compra_status='cancelado'`). Depois entra estoque (mov E) que cobre o item. Assert: pedido **não** fica preso em `cancelado` — volta a `pendente` e (com saldo) avança:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 86 — P035/D2: pedido OC cujo item teve a COMPRA cancelada deve voltar
 * a 'pendente' (re-roteável), não cancelado. Distingue de 'indisponivel' (terminal).
 *
 * Nota: NÃO executado — apenas typecheck.
 */

type Setup = {
  sku: string;
  pedidoId: string;
  itemId: string;
};

export default {
  nome: "86 — P035/D2: compra cancelada → pedido volta a pendente (reentra)",
  descricao:
    "Pedido 100%-OC, item em aguardando_compra. Item cancelado (compra cancelada, não " +
    "indisponível) deve transicionar o pedido pra 'pendente' (status_separacao=null) e " +
    "limpar campos de compra do item — não cancelar o pedido.",
  tags: ["compras", "cancelamento", "reentrada", "reconciliador", "p035", "d2"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("86");
    await ctx.criarProduto({ sku, descricao: "Compra cancelada reentra 86" });
    return { sku, pedidoId: "", itemId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    // 1. Pedido sem estoque → OC.
    const { id } = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 2 }] });
    setup.pedidoId = id;
    await ctx.aguardarStatus(id, "pendente", undefined, { timeout_ms: 20000 });
    await ctx.aprovar(id, "oc");
    await ctx.aguardarStatusSeparacao(id, "validacao_oc");

    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens").select("id").eq("pedido_id", id).single();
    setup.itemId = String((itemRow as { id: string }).id);

    // 2. Marcar esgotado → aguardando_compra, depois comprar.
    await ctx.http.post("/api/wms/separacao/validar-oc-item", { item_ids: [setup.itemId], acao: "esgotado" });
    await ctx.aguardarStatusSeparacao(id, "aguardando_compra");
    await ctx.comprar({ sku, qty: 2, pedido_id: id });

    // 3. Cancelar a compra do item: marca compra_status='cancelado' e roda o
    //    checkAndCancelPedidoIfAllTerminal. (Solicita + confirma o cancelamento.)
    await ctx.sb
      .from("siso_pedido_itens")
      .update({ compra_status: "cancelamento_pendente", compra_cancelamento_motivo: "fornecedor cancelou" })
      .eq("id", setup.itemId);
    await ctx.http.post(`/api/wms/compras/itens/${setup.itemId}/cancelamento/confirmar`, {});
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("status, status_separacao")
      .eq("id", setup.pedidoId)
      .single();
    const p = pedido as { status: string; status_separacao: string | null };
    if (p.status === "cancelado") {
      throw new Error("P035/D2: pedido ficou cancelado (devia reentrar como pendente após compra cancelada)");
    }
    if (p.status !== "pendente") {
      throw new Error(`P035/D2: status do pedido é '${p.status}' (esperado 'pendente')`);
    }
    // status_separacao zerado: o release NÃO pode tê-lo reescrito pra
    // aguardando_nf/aguardando_separacao (prova que checkAndReleasePedidos
    // foi pulado na reentrada).
    if (p.status_separacao !== null) {
      throw new Error(
        `P035/D2: status_separacao é '${p.status_separacao}' (esperado null — release sobrescreveu a reentrada?)`,
      );
    }
    // Item deve ter os campos de compra limpos pra re-roteamento.
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .select("compra_status, ordem_compra_id")
      .eq("id", setup.itemId)
      .single();
    const it = item as { compra_status: string | null; ordem_compra_id: string | null };
    if (it.compra_status !== null) {
      throw new Error(`P035/D2: compra_status do item é '${it.compra_status}' (esperado null na reentrada)`);
    }
    if (it.ordem_compra_id != null) {
      throw new Error("P035/D2: ordem_compra_id do item não foi limpa na reentrada");
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";

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

> Nota: divergência do achado — o `red_test` original menciona "entrar estoque (mov E) e reconciliar". Como a decisão D2 é fazer o pedido **reentrar como `pendente`** já no momento do cancelamento (e o reconciliador OC só varre `validacao_oc`/`aguardando_compra`), o teste valida diretamente a transição `cancelado→pendente` na confirmação do cancelamento, que é o ponto de mudança. O caminho "estoque chega e reconcilia" segue pelo roteamento normal de pedido `pendente` (fora do escopo desta task).

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- :only 86`
  Expected: **FAIL** — `checkAndCancelPedidoIfAllTerminal` cancela o pedido (`status='cancelado'`), o assert `status !== 'cancelado'` quebra.

- [ ] **Step 3 — Implementação mínima.**

  (a) Em `src/lib/compras-utils.ts`, reescrever `checkAndCancelPedidoIfAllTerminal` pra distinguir o motivo. Buscar também `ordem_compra_id` dos itens pra poder limpar na reentrada:

```ts
const TERMINAL_COMPRA_STATUSES = new Set(["indisponivel", "cancelado"]);

/**
 * Checks if ALL compra items of a pedido are in terminal states.
 * - Todos terminais e NENHUM indisponível (só cancelados) → P035/D2: pedido
 *   REENTRA como 'pendente' (re-roteável); campos de compra dos itens limpos.
 * - Algum indisponível (esgotado de verdade) → pedido cancelado (terminal).
 */
export async function checkAndCancelPedidoIfAllTerminal(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
  logSource: string,
): Promise<{ pedidoCancelado: boolean; pedidoReentrou?: boolean }> {
  const { data: allItems, error } = await supabase
    .from("siso_pedido_itens")
    .select("id, compra_status")
    .eq("pedido_id", pedidoId);

  if (error || !allItems || allItems.length === 0) {
    return { pedidoCancelado: false };
  }

  const hasActiveItem = allItems.some((item) => {
    if (item.compra_status === null) return true;
    return !TERMINAL_COMPRA_STATUSES.has(item.compra_status);
  });

  if (hasActiveItem) return { pedidoCancelado: false };

  const now = new Date().toISOString();
  // P035/D2: se NENHUM terminal é 'indisponivel' (todos por cancelamento),
  // o pedido volta pro começo da fila pra re-roteamento. Indisponível morre.
  const algumIndisponivel = allItems.some((item) => item.compra_status === "indisponivel");

  if (!algumIndisponivel) {
    await supabase
      .from("siso_pedidos")
      .update({ status: "pendente", status_separacao: null, processado_em: now })
      .eq("id", pedidoId);

    // Limpa campos de compra dos itens pra roteamento/reconciliador re-avaliar.
    await supabase
      .from("siso_pedido_itens")
      .update({ compra_status: null, ordem_compra_id: null })
      .eq("pedido_id", pedidoId);

    await supabase
      .from("siso_fila_execucao")
      .update({ status: "cancelado", atualizado_em: now })
      .eq("pedido_id", pedidoId)
      .eq("status", "pendente");

    logger.warn(logSource, "Pedido reentrou — compra cancelada (D2), volta a pendente", {
      pedidoId,
      totalItens: allItems.length,
    });
    return { pedidoCancelado: false, pedidoReentrou: true };
  }

  await supabase
    .from("siso_pedidos")
    .update({ status: "cancelado", status_separacao: null, processado_em: now })
    .eq("id", pedidoId);

  await supabase
    .from("siso_fila_execucao")
    .update({ status: "cancelado", atualizado_em: now })
    .eq("pedido_id", pedidoId)
    .eq("status", "pendente");

  logger.warn(logSource, "Pedido cancelado — algum item indisponível (terminal)", {
    pedidoId,
    totalItens: allItems.length,
  });

  return { pedidoCancelado: true };
}
```

  (b) Em `src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts`, a chamada hoje (linhas 73-82, após a Task 1.3) é:

```ts
    const { pedidoCancelado } = await checkAndCancelPedidoIfAllTerminal(
      supabase,
      item.pedido_id,
      "compras-cancelamento-confirmar",
    );

    let pedidosLiberados: string[] = [];
    if (!pedidoCancelado) {
      pedidosLiberados = await checkAndReleasePedidos([itemId]);
    }
```

  Trocar por (desestruturar `pedidoReentrou` e pular o release na reentrada):

```ts
    const { pedidoCancelado, pedidoReentrou } = await checkAndCancelPedidoIfAllTerminal(
      supabase,
      item.pedido_id,
      "compras-cancelamento-confirmar",
    );

    let pedidosLiberados: string[] = [];
    // Na reentrada (D2) o pedido já voltou a 'pendente' e os campos de compra dos
    // itens foram zerados. NÃO chamar checkAndReleasePedidos: além de ser no-op
    // (ele filtra itens com compra_status IS NOT NULL → 0 itens), pular deixa o
    // invariante explícito e impede qualquer regressão de release sobre 'pendente'.
    if (!pedidoCancelado && !pedidoReentrou) {
      pedidosLiberados = await checkAndReleasePedidos([itemId]);
    }
```

  > Nota (prova de segurança do risco apontado): mesmo sem o guard `!pedidoReentrou`, `checkAndReleasePedidos([itemId])` seria **no-op** na reentrada — ele consulta `siso_pedido_itens WHERE compra_status IS NOT NULL` (`compras-release.ts:49-53`) e, como o passo (a) acima setou `compra_status=null` em **todos** os itens do pedido, `allCompraItems.length === 0` → `continue` (`compras-release.ts:63`) antes de qualquer `update` em `siso_pedidos`. Nenhum caminho de `checkAndReleasePedidos` escreve em `siso_pedidos` quando não há itens com `compra_status` setado. O guard `!pedidoReentrou` torna isso uma garantia de contrato (não dependente da ordem das duas escritas em (a)) — é a mudança cirúrgica mínima que fecha o risco. O `registrarEvento`, `logger.warn` e o retorno da rota ficam intactos.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- :only 86`
  Expected: **PASS** — pedido vira `pendente`, `ordem_compra_id` limpa.

- [ ] **Step 5 — Commit.**
```bash
git add src/lib/compras-utils.ts "src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts" scripts/wms/cenarios/catalogo/86-compra-cancelada-pedido-reentra.ts
git commit -m "fix(wms): P035/D2 — pedido reentra como pendente quando a compra é cancelada

checkAndCancelPedidoIfAllTerminal cancelava o pedido pra sempre quando
todos os itens viravam terminais. Agora distingue o motivo: só
'indisponivel' é terminal (cancela); se todos os terminais são por
cancelamento, o pedido volta a 'pendente' e os campos de compra dos
itens são limpos pra re-roteamento (D2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: p035-pedido-preso-apos-compra-cancelada
    date: "2026-06-05"
    source: wms/compras/cancelamento
    category: business_logic
    message: "Cancelar a compra de um pedido OC cancelava o pedido pra sempre (status_separacao=null), e o reconciliador só varre validacao_oc/aguardando_compra — pedido + estoque ficavam travados sem se encontrar."
    cause: >
      checkAndCancelPedidoIfAllTerminal tratava todos os terminais igualmente (cancela).
      Não distinguia cancelamento (re-roteável) de indisponível (esgotado, terminal).
    fix: >
      D2: se nenhum terminal é 'indisponivel' (todos por cancelamento), pedido reentra
      como 'pendente' (status_separacao=null) e os campos de compra dos itens são
      limpos (compra_status=null, ordem_compra_id=null). Indisponível segue cancelando.
      A rota cancelamento/confirmar pula checkAndReleasePedidos na reentrada
      (pedidoReentrou=true) pra não sobrescrever o status='pendente'.
    files:
      - src/lib/compras-utils.ts
      - src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts
      - scripts/wms/cenarios/catalogo/86-compra-cancelada-pedido-reentra.ts
    tags: [compras, cancelamento, reentrada, roteamento, reconciliador]
```

---

### Task 1.7: P155 — confirmar equivalente cancela o item A e cria item novo de B (histórico limpo)

**Files**
- Modify `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts:155-201` (trocar UPDATE in-place por: cancelar A terminal + INSERT do item B + registrarEvento ligando A→B)
- Test (Create) `scripts/wms/cenarios/catalogo/87-equivalente-cria-item-novo.ts`

Estado atual confirmado: a rota **muta in-place** o mesmo `siso_pedido_itens` (linhas 155-183): troca `produto_id/produto_id_tiny/sku/descricao/fornecedor_oc` de A pra B, reseta `compra_status='aguardando_compra'`, zera campos de OC. Não cancela A nem cria linha nova (cenário ambíguo do "today"). Há um bloqueio de fusão (113-129) quando já existe item com o `produto_id` de B. A nota (op1): **cancela A e cria pedido novo de B (histórico limpo)**. Interpretação cirúrgica (notes do finding): "pedido novo" = **nova LINHA no MESMO `siso_pedidos`** (id do pedido é text/Tiny — não dá pra inventar id novo). A liberação da R (linhas 134-149) já existe e fica válida.

- [ ] **Step 1 — Escrever o teste que falha.** Cenário E2E: item A em `equivalente_pendente` com `compra_equivalente_sku=B`. Após `POST .../equivalente/confirmar`: o item A original continua existindo em estado **terminal** (`compra_status='cancelado'`, **não** mutado — `sku` segue A), E existe uma **nova linha** de `pedido_item` com o produto B em `aguardando_compra`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 87 — P155: confirmar equivalente CANCELA o item A (estado terminal,
 * sku preservado) e CRIA uma nova linha de pedido_item com o produto B.
 *
 * Nota: NÃO executado — apenas typecheck.
 */

type Setup = {
  skuA: string;
  skuB: string;
  pedidoId: string;
  itemAId: string;
};

export default {
  nome: "87 — P155: equivalente cancela A e cria item novo de B (histórico limpo)",
  descricao:
    "Item A em equivalente_pendente com equivalente_sku=B. Após confirmar: A continua " +
    "existindo em estado terminal (cancelado, sku=A NÃO mutado) E há nova linha com produto B " +
    "em aguardando_compra.",
  tags: ["compras", "equivalente", "historico", "p155"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const skuA = ctx.skuUnico("87A");
    const skuB = ctx.skuUnico("87B");
    // Produto B precisa existir e ter saldo pra carregarDadosEquivalentePorSku
    // resolver o produto de origem (qtdMinimaAtende). Semear B no CWB.
    await ctx.criarProduto({ sku: skuA, descricao: "Equivalente A 87" });
    await ctx.criarProduto({ sku: skuB, descricao: "Equivalente B 87" });
    await ctx.semearSaldo({ produto: skuB, galpao: "CWB", loc: "A-01-01", qty: 5 });

    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .insert({
        id: `CEN87-${Date.now()}`,
        // NOT NULL sem default em siso_pedidos (sem trigger): numero, data,
        // filial_origem (enum CWB/SP), cliente_nome.
        numero: `CEN87-${Date.now()}`,
        data: new Date().toISOString().slice(0, 10),
        filial_origem: "CWB",
        cliente_nome: "Cenário 87",
        status: "executando",
        status_separacao: "aguardando_compra",
        empresa_origem_id: ctx.staging.empresas.netair.id,
      })
      .select("id")
      .single();
    const pedidoId = (ped as { id: string }).id;

    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .insert({
        pedido_id: pedidoId,
        produto_id: "999187",
        sku: skuA,
        descricao: "Item A 87",
        quantidade_pedida: 2,
        compra_quantidade_solicitada: 2,
        compra_status: "equivalente_pendente",
        compra_equivalente_sku: skuB,
      })
      .select("id")
      .single();
    return { skuA, skuB, pedidoId, itemAId: String((item as { id: string }).id) };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Caminho feliz: 2xx retorna o body direto; 4xx/5xx LANÇA HttpError (que
    // estoura o cenário com a mensagem do erro). Sem checagem manual de status.
    await ctx.http.post(
      `/api/wms/compras/itens/${setup.itemAId}/equivalente/confirmar`,
      {},
    );
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // 1. Item A continua existindo, terminal, sku=A NÃO mutado.
    const { data: itemA } = await ctx.sb
      .from("siso_pedido_itens")
      .select("sku, compra_status")
      .eq("id", setup.itemAId)
      .single();
    const a = itemA as { sku: string; compra_status: string };
    if (a.sku !== setup.skuA) {
      throw new Error(`P155: item A foi mutado (sku=${a.sku}, devia continuar ${setup.skuA})`);
    }
    if (a.compra_status === "aguardando_compra") {
      throw new Error("P155: item A virou aguardando_compra (devia ficar terminal/cancelado)");
    }

    // 2. Existe uma NOVA linha com o produto B em aguardando_compra.
    const { data: itensB } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, sku, compra_status")
      .eq("pedido_id", setup.pedidoId)
      .eq("sku", setup.skuB);
    const novos = (itensB ?? []) as Array<{ id: string; sku: string; compra_status: string }>;
    const novoB = novos.find((r) => r.id !== setup.itemAId);
    if (!novoB) {
      throw new Error("P155: nenhuma NOVA linha com o produto B foi criada");
    }
    if (novoB.compra_status !== "aguardando_compra") {
      throw new Error(`P155: novo item B está em '${novoB.compra_status}' (esperado aguardando_compra)`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";

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

> Nota: divergência do achado — o cenário sugerido era `scripts/wms/cenarios/equivalente-troca-real.ts` (fora do `catalogo/`). Mantido em `catalogo/87-*` pra rodar via `npm run scenarios`. O teste depende de `carregarDadosEquivalentePorSku` resolver B — por isso B é semeado com saldo. `ctx.semearSaldo` existe no harness.

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- :only 87`
  Expected: **FAIL** — a rota muta o item A in-place (`sku` vira B); o assert `a.sku !== skuA` falha (item A foi mutado) e/ou nenhuma nova linha B existe.

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts`, substituir o bloco do UPDATE in-place (linhas 155-201) por: (a) marcar A como `cancelado` com motivo `substituido_por_equivalente`; (b) INSERT do novo item B; (c) `registrarEvento` ligando A→B:

```ts
    // (Fase 1.4) REMOVIDO: sync de siso_pedido_item_estoques no swap de SKU
    // equivalente. A tabela foi dropada — estoque do novo SKU é lido vivo de
    // siso_estoque quando o pedido for separado.

    const now = new Date().toISOString();

    // P155: NÃO muta a identidade do item A in-place. Cancela A (terminal,
    // preservando o histórico) e cria uma NOVA linha de pedido_item pra B no
    // MESMO pedido. Histórico limpo, sem ambiguidade de identidade.
    const { error: cancelError } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "cancelado",
        compra_cancelamento_motivo: "substituido_por_equivalente",
        compra_cancelado_em: now,
        compra_cancelado_por: session.id,
        ordem_compra_id: null,
      })
      .eq("id", itemId);

    if (cancelError) {
      throw new Error(`Erro ao cancelar item original: ${cancelError.message}`);
    }

    const { data: novoItem, error: insertError } = await supabase
      .from("siso_pedido_itens")
      .insert({
        pedido_id: item.pedido_id,
        produto_id: equivalente.produtoIdOrigem,
        produto_id_suporte: equivalente.produtoIdSuporte,
        produto_id_tiny: equivalente.produtoIdOrigem,
        sku: equivalente.sku,
        descricao: equivalente.descricao,
        quantidade_pedida: quantidadeNecessariaCompra,
        fornecedor_oc: item.compra_equivalente_fornecedor ?? equivalente.fornecedor,
        imagem_url: equivalente.imagemUrl,
        gtin: equivalente.gtin,
        compra_status: "aguardando_compra",
        compra_quantidade_solicitada: quantidadeNecessariaCompra,
        compra_solicitada_em: item.compra_solicitada_em ?? now,
      })
      .select("id, sku, descricao, compra_status, fornecedor_oc")
      .single();

    if (insertError) {
      throw new Error(`Erro ao criar item equivalente: ${insertError.message}`);
    }

    const updated = novoItem;

    await registrarEvento({
      pedidoId: item.pedido_id,
      evento: "compra_item_equivalente_aplicado",
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: {
        item_original_id: itemId,
        item_novo_id: (novoItem as { id: string }).id,
        sku_original: item.sku,
        sku_equivalente: equivalente.sku,
        qty: quantidadeNecessariaCompra,
        fornecedor: item.compra_equivalente_fornecedor ?? equivalente.fornecedor,
      },
    });
```

  > Nota: o `registrarEvento` original (linhas 189-201) é substituído por este (agora liga `item_original_id`→`item_novo_id`). O `logger.info` e o `return NextResponse.json({ ok: true, item: updated })` finais ficam intactos (`updated` aponta pro novo item B). A liberação da R (linhas 134-149) e o bloqueio de fusão (113-129) permanecem inalterados.

  > Nota: o achado pede "confirmar que filtros por compra_status terminal escondem A". `cancelado` já está em `TERMINAL_COMPRA_STATUSES` (compras-utils.ts:119) e em `RESOLVED_RELEASE_STATUSES` (linha 39), então leitores de fila de compras filtram A corretamente. O novo item B (`aguardando_compra`) aparece na fila — comportamento desejado.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- :only 87`
  Expected: **PASS** — A continua `sku=skuA` terminal; nova linha B `aguardando_compra` existe.

- [ ] **Step 5 — Commit.**
```bash
git add src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts scripts/wms/cenarios/catalogo/87-equivalente-cria-item-novo.ts
git commit -m "fix(wms): P155 — equivalente cancela A e cria item novo de B

A confirmação de equivalente mutava a identidade do item A in-place
(A→B), deixando histórico ambíguo. Agora cancela A (terminal,
substituido_por_equivalente) e cria uma nova linha de pedido_item pra
B no mesmo pedido, com registrarEvento ligando A→B.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: p155-equivalente-muta-identidade-inplace
    date: "2026-06-05"
    source: wms/compras/equivalente/confirmar
    category: business_logic
    message: "Confirmar produto equivalente reescrevia a identidade do item (A→B) na mesma linha, deixando histórico ambíguo (recebimento gravava um SKU, histórico outro)."
    cause: >
      A rota fazia UPDATE in-place de produto_id/sku/descricao/fornecedor do item A pro
      equivalente B. A mesma linha mudava de identidade.
    fix: >
      Cancelar A (compra_status=cancelado, motivo substituido_por_equivalente) e INSERT
      de uma nova linha de pedido_item pra B (aguardando_compra) no MESMO pedido.
      registrarEvento liga item_original_id→item_novo_id. cancelado já é terminal, então
      A some das filas de compra.
    files:
      - src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts
      - scripts/wms/cenarios/catalogo/87-equivalente-cria-item-novo.ts
    tags: [compras, equivalente, historico, pedido_itens]
```

---

### Task 1.8: P053 — desclassificar devolução antiga (sem `devolucao_id`) via fallback data+tipo

**Files**
- Modify `src/lib/wms/devolucoes.ts:444-485` (`desclassificarDevolucao`: fallback por `nota_fiscal_id` + origem_tipo de devolução + janela temporal quando o lookup por `devolucao_id` retorna 0)
- Test (Create) `test/integration/devolucoes-desclassificar-legado.test.ts`

> Nota: o `vitest.integration.config.ts` tem `include: ["test/integration/**/*.test.ts"]` (verificado) — **não** casa `src/**/*.integration.test.ts`. Por isso o arquivo de teste vive em `test/integration/` (não em `src/`), e os imports usam o alias `@/` (o config tem `resolve.alias["@"] = src`, igual ao `vitest.config.ts`). O `globalSetup.ts` trunca tabelas operacionais antes do run.

Estado atual confirmado: `desclassificarDevolucao` (linhas 413-485) faz lookup das movs **somente** por FK `devolucao_id` (linha 450). O doc-comment (408-411) admite que devoluções classificadas antes do FK não terão `devolucao_id` (era NULL) → `desclassificar` retorna 0 movs. A nota (op1): **procurar por data da transação + tipo, não só por ID**, ativando o fallback **só quando o lookup por FK falha** (preserva determinismo das novas). Anchoring seguro (notes do finding): `nota_fiscal_id` da devolução → uuid de `siso_notas_fiscais` → movs com esse `nota_fiscal_id` + origem_tipo de devolução + `estorno_de IS NULL`, dentro da janela `classificada_em ± margem`.

Origem_tipos de classificação confirmados em `devolucoes.ts`: `devolucao_cliente_integra`, `devolucao_cliente_avariada`, `devolucao_cliente_troca_sku`, `devolucao_fornecedor_enviada`, `devolucao_fornecedor_recebida`, `transferencia_localizacao`, `ajuste_manual`. Para o fallback, restringimos às classes de devolução **que entram saldo** (E) ancoradas por `nota_fiscal_id`.

- [ ] **Step 1 — Escrever o teste que falha.** Integration (contra staging). Montar uma devolução **classificada com movs SEM `devolucao_id`** (simular legado: NULL) mas com `nota_fiscal_id`/`classificada_em` conhecidos; `desclassificarDevolucao` deve achar e estornar via fallback (`movsEstornadas>0`) e o saldo da loc volta ao pré-classificação. Devolução nova (com `devolucao_id`) continua usando o FK:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { desclassificarDevolucao } from "@/lib/wms/devolucoes";
import { upsertNotaFiscal } from "@/lib/nf-webhook-handler";

const sb = createServiceClient();
const SKU = `TEST-DESCL-LEGADO-${Math.random().toString(36).slice(2, 8)}`;
let produtoId: string;
let galpaoId: string;
let locId: string;
let usuarioId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("codigo", "A-01-01")
    .single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "Desclassificar legado", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").limit(1).single();
  usuarioId = u!.id;
});

describe("desclassificarDevolucao — fallback legado (sem devolucao_id)", () => {
  it("encontra e estorna movs antigas via nota_fiscal_id + data quando devolucao_id está NULL", async () => {
    const tinyNfId = Math.floor(Math.random() * 1_000_000_000);
    const nfUuid = await upsertNotaFiscal({
      tiny_nota_fiscal_id: tinyNfId,
      empresa_id: null,
      tipo: "entrada",
      raw: {},
    });

    // Cria a devolução classificada (legado): SEM movs com devolucao_id.
    const classificadaEm = new Date().toISOString();
    const { data: dev } = await sb
      .from("siso_devolucoes_pendentes")
      .insert({
        nota_fiscal_id: tinyNfId,
        empresa_id: null,
        status: "classificada",
        classificacao: "integro",
        classificada_em: classificadaEm,
        payload_webhook: {},
      })
      .select("id")
      .single();
    const devId = (dev as { id: string }).id;

    // Mov de devolução íntegra (entrada) tipada como NF, SEM devolucao_id (legado).
    const saldoAntes = await getSaldo();
    await inserirMovimentacao({
      tripla: { produto_id: produtoId, galpao_id: galpaoId, localizacao_id: locId },
      tipo: "E",
      qty: 3,
      origem_tipo: "devolucao_cliente_integra",
      nota_fiscal_id: nfUuid,
      usuario_id: usuarioId,
      motivo: "legado sem devolucao_id",
      // devolucao_id OMITIDO de propósito → coluna fica NULL.
    });
    const saldoClassificada = await getSaldo();
    expect(saldoClassificada).toBe(saldoAntes + 3);

    const { movsEstornadas } = await desclassificarDevolucao({
      devolucao_id: devId,
      usuario_id: usuarioId,
      motivo: "teste fallback legado",
    });

    expect(movsEstornadas).toBeGreaterThan(0);
    const saldoDesclassificada = await getSaldo();
    expect(saldoDesclassificada).toBe(saldoAntes);
  });
});

async function getSaldo(): Promise<number> {
  const { data } = await sb
    .from("siso_estoque")
    .select("saldo")
    .eq("produto_id", produtoId)
    .eq("galpao_id", galpaoId)
    .eq("localizacao_id", locId)
    .maybeSingle();
  return Number((data as { saldo: number } | null)?.saldo ?? 0);
}
```

> Nota: divergência do achado — o `test_file` sugerido era `src/lib/wms/devolucoes-desclassificar-legado.integration.test.ts`, mas o `vitest.integration.config.ts` tem `include: ["test/integration/**/*.test.ts"]` (verificado), que **não** casa `src/**`. Por isso o arquivo fica em `test/integration/devolucoes-desclassificar-legado.test.ts` e os imports usam o alias `@/` (config tem `resolve.alias["@"]=src`). O `globalSetup.ts` trunca tabelas operacionais antes do run. O insert de test em `siso_devolucoes_pendentes` usa as colunas reais: `nota_fiscal_id` (bigint), `chave_acesso_nf` (text), `classificacao IN ('integro','avariado','garantia','troca_sku')`, `payload_webhook` (jsonb), `classificada_em` (timestamptz) — conferido em `supabase/migrations/20260605_wms_excecoes_dashboards.sql`.

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- devolucoes-desclassificar-legado`
  Expected: **FAIL** — `movsEstornadas` é **0** (lookup por `devolucao_id` retorna vazio, sem fallback); `saldoDesclassificada` continua `saldoAntes + 3`.

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/devolucoes.ts`, dentro de `desclassificarDevolucao`, após o lookup por `devolucao_id` (linha 451), adicionar o fallback quando 0 movs: resolver o uuid da NF da devolução e buscar movs originais por `nota_fiscal_id` + origem_tipo de devolução + janela `classificada_em ± 5min`. Ler `nota_fiscal_id`/`chave_acesso_nf` do row `dev` (o `select("*")` na linha 424 já traz tudo):

```ts
  // Lookup determinístico via FK devolucao_id (fix-final-B T11).
  const { data: movs } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("devolucao_id", input.devolucao_id)
    .is("estorno_de", null);

  let movsParaEstornar = (movs ?? []) as Array<{ id: string }>;

  // P053: fallback pra devoluções legadas (classificadas antes do FK
  // devolucao_id) — lookup por nota_fiscal_id + origem_tipo de devolução +
  // janela temporal em torno de classificada_em. Só ativa se o FK retornou 0,
  // preservando o determinismo das devoluções novas.
  if (movsParaEstornar.length === 0) {
    const devRow = dev as {
      nota_fiscal_id: number | null;
      chave_acesso_nf: string | null;
    };
    let nfUuid: string | null = null;
    if (devRow.nota_fiscal_id != null) {
      const { data: nf } = await sb
        .from("siso_notas_fiscais")
        .select("id")
        .eq("tiny_nota_fiscal_id", devRow.nota_fiscal_id)
        .maybeSingle();
      nfUuid = (nf as { id: string } | null)?.id ?? null;
    }
    if (!nfUuid && devRow.chave_acesso_nf) {
      const { data: nf } = await sb
        .from("siso_notas_fiscais")
        .select("id")
        .eq("chave_acesso", devRow.chave_acesso_nf)
        .maybeSingle();
      nfUuid = (nf as { id: string } | null)?.id ?? null;
    }

    if (nfUuid) {
      const base = new Date(d.classificada_em).getTime();
      const ini = new Date(base - 5 * 60 * 1000).toISOString();
      const fim = new Date(base + 5 * 60 * 1000).toISOString();
      const ORIGENS_DEVOLUCAO = [
        "devolucao_cliente_integra",
        "devolucao_cliente_avariada",
        "devolucao_cliente_troca_sku",
        "devolucao_fornecedor_enviada",
        "devolucao_fornecedor_recebida",
      ];
      const { data: legado } = await sb
        .from("siso_movimentacoes")
        .select("id")
        .eq("nota_fiscal_id", nfUuid)
        .in("origem_tipo", ORIGENS_DEVOLUCAO)
        .is("estorno_de", null)
        .is("devolucao_id", null)
        .gte("criado_em", ini)
        .lte("criado_em", fim);
      movsParaEstornar = (legado ?? []) as Array<{ id: string }>;
      if (movsParaEstornar.length > 0) {
        logger.warn("wms.devolucoes", "desclassificar via fallback legado (nota_fiscal_id+data)", {
          devolucao_id: input.devolucao_id,
          nota_fiscal_id: nfUuid,
          candidatas: movsParaEstornar.length,
        });
      }
    }
  }

  let movsEstornadas = 0;
  for (const m of movsParaEstornar) {
    try {
      await estornarMovimentacao({
        mov_id: m.id,
        usuario_id: input.usuario_id,
        motivo: `Desclassifica devolução ${input.devolucao_id}: ${input.motivo}`,
      });
      movsEstornadas++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/já foi estornada|já é um estorno/.test(msg)) continue;
      throw err;
    }
  }
```

  > Nota: o objeto `d` (linhas 428-434) só tipa `status/classificacao/classificada_em/classificada_por`. O fallback lê `nota_fiscal_id`/`chave_acesso_nf` direto do row cru `dev` (que veio de `select("*")`). A coluna de timestamp da mov é `criado_em` (confirmado no schema — **não** `criada_em`). A janela ±5min ancorada por `nota_fiscal_id` + `devolucao_id IS NULL` evita estornar movs de outra devolução do mesmo produto.

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- devolucoes-desclassificar-legado`
  Expected: **PASS** — `movsEstornadas > 0`, saldo volta ao pré-classificação.

- [ ] **Step 5 — Commit.**
```bash
git add src/lib/wms/devolucoes.ts test/integration/devolucoes-desclassificar-legado.test.ts
git commit -m "fix(wms): P053 — fallback de desclassificação de devolução legada (sem devolucao_id)

desclassificarDevolucao só achava movs via FK devolucao_id; devoluções
classificadas antes do FK retornavam 0 movs — estoque não voltava pro
monte. Agora, quando o FK retorna vazio, busca por nota_fiscal_id +
origem_tipo de devolução + janela ±5min de classificada_em (só movs com
devolucao_id NULL), preservando o determinismo das novas.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: p053-desclassificar-devolucao-legada-sem-fk
    date: "2026-06-05"
    source: wms/devolucoes
    category: business_logic
    message: "Desclassificar uma devolução classificada antes do FK devolucao_id não achava as movs (lookup só por FK) — estoque que entrou nunca voltava pro monte."
    cause: >
      desclassificarDevolucao buscava movs apenas via .eq('devolucao_id', id). Devoluções
      pré-fix-final-B-T11 têm devolucao_id NULL nas movs → 0 estornadas.
    fix: >
      Fallback quando o FK retorna 0: resolver o uuid da NF (tiny_nota_fiscal_id ou
      chave_acesso) e buscar movs originais (estorno_de NULL, devolucao_id NULL) por
      nota_fiscal_id + origem_tipo de devolução + janela criado_em ±5min de
      classificada_em. Ativa só no caso legado.
    files:
      - src/lib/wms/devolucoes.ts
      - test/integration/devolucoes-desclassificar-legado.test.ts
    tags: [devolucoes, desclassificar, estorno, legado, ledger]
```

---

## Verificação final da fase (após todas as tasks)

- [ ] `npm test -- src/lib/compras-utils.test.ts` — PASS (P045)
- [ ] `npm run scenarios -- :only 82` `:only 83` `:only 84` `:only 85` `:only 86` `:only 87` — todos PASS (P070, P040, P047, P046, P035, P155)
- [ ] **Setup dos cenários 83/84/85/87 não aborta por NOT NULL.** Os inserts diretos em `siso_pedidos` incluem `numero`, `data`, `filial_origem` ('CWB'), `cliente_nome` (NOT NULL sem default e sem trigger no schema de staging), e o insert em `siso_ordens_compra` (cenário 84) usa a coluna real **`fornecedor`** (não `fornecedor_nome`). No Step 2 de cada um, confirmar que o **FAIL é o assert RED** (200 onde se esperava 409, ou saldo errado) — **não** um erro de setup `null value in column ... violates not-null constraint` / `column "fornecedor_nome" ... does not exist`. Se o setup quebrar, o RED não roda.
- [ ] `npm run test:integration -- devolucoes-desclassificar-legado` — PASS (P053)
- [ ] `npm run lint` — sem erros novos
- [ ] `npm run build` — typecheck limpo. Os cenários novos usam só o contrato real do harness: `ctx.http.post(path, body?, headers?: Record<string,string>)` (sucesso → body parseado; 4xx/5xx → `throw HttpError`), `ctx.ajusteManual({ sku, galpao, loc, delta, motivo, motivo_categoria }) → { mov_id }`, e `import { HttpError } from "../_harness/http"` nos cenários de erro (82/83/84). Sem `.status`/`.data`/`{aceitarErro}` (não existem no `HttpClient`).
- [ ] `erros-conhecidos.yaml` — 8 entradas novas (P045, P070, P040, P047, P046, P035, P155, P053)
- [ ] Atualizar `docs/architecture-and-flows.md` / `docs/fluxos-siso.md` se a transição de status da OC (P045) ou a reentrada de pedido (P035) mudar o diagrama de estados documentado.
