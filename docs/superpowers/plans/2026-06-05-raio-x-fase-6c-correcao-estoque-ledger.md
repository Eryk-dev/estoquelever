# Fase 6c — Correção de estoque consolidada no ledger (`/api/wms/ajuste`) Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal:** Consolidar TODA correção de estoque no caminho ledger-only auditável `/api/wms/ajuste` (D5: a rota `tiny/stock/ajustar` é dead-path, não tem caller no frontend — `ajuste/page.tsx` + `modals.tsx:554` chamam `/api/wms/ajuste`). Tornar a correção: (1) gravada SÓ no ledger com trilha completa e lock pessimista [P086/P089/P166], (2) auto-libera pedidos parados quando saldo 0→+ [P165], (3) idempotente por chave (frontend + banco) [P087/P184], (4) rejeita qty=0 [P164], (5) em over-reserve (saída que deixaria `reservado>saldo`) ACEITA o físico, LIBERA a R a descoberto, ALERTA e ENFILEIRA compra do excedente [D3/P090], (6) expõe o contexto de separação pra UI sinalizar correção pós-separação [P088], e (7) congela o depósito no pedido + valida depósito no backend de conexões [P091/P093].

**Architecture:** O caminho moderno já é `POST /api/wms/ajuste` (route) → `ajustarEstoque` (`src/lib/wms/movimentacoes.ts:431`) → `inserirMovimentacao` (`src/lib/wms/ledger.ts:114`, RPC `wms_inserir_movimentacao` com `SELECT FOR UPDATE`). Esse caminho **já** dá: trilha (saldo ant/post, autor, motivo, categoria), lock pessimista, e auto-varredura de pedidos parados em movs `E` (`ledger.ts:230-263` → `varrerPedidosAfetadosPorEntrada` + `reconciliarEntradaEstoque`). Logo P086/P089/P166/P165 são em grande parte **regressão + deprecação** da rota Tiny morta. O trabalho novo é: idempotency (coluna `idempotency_key` em `siso_movimentacoes` + UNIQUE parcial, reusada de P146), a estratégia de over-reserve do P090 (helper `aplicarCorrecaoSaida` que libera R a descoberto + alerta + enfileira compra), a visibilidade do P088, e o freeze de depósito + guard de conexões.

**Tech Stack:** Next.js 16 App Router (route handlers), TypeScript strict, Supabase (service role, RPC plpgsql para atomicidade), Vitest (unit `src/**/*.test.ts` + integration `test/integration/**/*.test.ts` contra staging `ehbxpbeijofxtsbezwxd`), Scenarios E2E HTTP (`scripts/wms/cenarios/catalogo/NN-*.ts`).

> **Pré-condições conhecidas (gotchas):** `siso_pedidos.id` é text; `siso_pedido_itens.produto_id` é tiny_produto_id (não uuid WMS); `wms_inserir_movimentacao` é o único write do ledger; `siso_estoque` tem `CHECK(reservado <= saldo)` e `validarCoerencia` (`ledger.ts:58`) bloqueia `reservado>saldo` — o P090 contorna isso liberando R ANTES da saída, mantendo o invariante. Migrations: criar `supabase/migrations/YYYYMMDD_*.sql` + aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`.

> **Infra de teste (Task 1.0 cria ANTES dos cenários):** o `HttpClient` do harness (`scripts/wms/cenarios/_harness/http.ts` + `types.ts`) hoje só tem `get/post/patch/delete`, e `request()` LANÇA `HttpError` em qualquer non-2xx (`http.ts:71`) — não dá pra inspecionar 400/410/200. Os cenários desta fase precisam asserir status code, então **a Task 1.0 (real, com Files/Steps) adiciona `postRaw`/`putRaw`** à interface `HttpClient` (`types.ts:14-19`) e à factory `createHttp` (`http.ts:77-82`), devolvendo o `Response` cru (sem lançar). Helpers de Ctx reais (verificados em `_harness/context.ts` + `types.ts:30-33`): `criarProduto({sku,descricao})→Promise<string>` (uuid), `criarLocalizacao({galpao:"CWB"|"SP",codigo,tipo?})→Promise<string>` (uuid da loc), `semearSaldo({produto:SKU,galpao:"CWB"|"SP",loc:CODIGO,qty})→Promise<void>`. **NÃO existem** `ctx.locPicking` nem `ctx.darSaldo` — os cenários abaixo usam `ctx.criarLocalizacao(...)` + `ctx.semearSaldo(...)` (nomes reais). `staging.empresas.netair.{id,cnpj}` e `staging.galpoes.cwb.id` SÃO válidos. `runStandalone(cenario)` existe em `_harness/standalone.ts:12` (recebe o `Cenario` default).

> **Coluna `siso_pedidos.deposito_id` NÃO existe** (verificado: `20260309_add_deposito_columns.sql` adiciona `deposito_id`/`deposito_nome` SÓ em `siso_tiny_connections`; nenhuma migration toca `siso_pedidos`). A Task 1.4 cria a coluna via migration ANTES de escrever nela. As `deposito_id` que existem no schema são de `siso_tiny_connections` e do legado dropado.

> **Dependência cross-fase:** P184 declara `deps=[P146]` (coluna `idempotency_key` compartilhada). P146 (Fase 6 frontend idempotency) ainda não criou a coluna. Este plano cria a coluna `idempotency_key` em `siso_movimentacoes` na Task 1.5 (não em `siso_pedidos`, que é o escopo do P146). São colunas em tabelas diferentes — sem colisão. Se P146 for executado antes e criar uma coluna homônima em `siso_movimentacoes`, marcar a Task 1.5 como já-feita.

---

## PR 1: Correção de estoque ledger-only consolidada em `/api/wms/ajuste` [P086, P089, P166, P164, P165, P184, P087, P090, P091, P093, P088]

> **Ordem das tasks (quick-wins / sem-dep primeiro):**
> 1.0 Infra de harness (`postRaw`/`putRaw` no `HttpClient`) — pré-requisito de TODO cenário que checa status code (52/53/54/83/84/auth-09) →
> 1.1 P164 (rejeita qty=0 — já existe no `/api/wms/ajuste`, vira regressão) →
> 1.2 P086/P089/P166/P165 (deprecar rota Tiny morta + regressão ledger-only) →
> 1.3 P093 (guard backend de depósito em conexões: conexão já-ativa não fica sem depósito) →
> 1.4 P091 (criar coluna `siso_pedidos.deposito_id` + congelar depósito no pedido) →
> 1.5 P184/P087 (idempotency: coluna + RPC + route + frontend) →
> 1.6 P090 (over-reserve: aceita físico, libera R a descoberto, alerta, enfileira compra) →
> 1.7 P088 (visibilidade: expõe status_separacao no payload).

---

### Task 1.0: Infra de harness — `postRaw`/`putRaw` no `HttpClient` (devolvem `Response` cru, não lançam)

**Files**
- Modify: `scripts/wms/cenarios/_harness/types.ts:14-19` — adicionar `postRaw`/`putRaw` à interface `HttpClient`.
- Modify: `scripts/wms/cenarios/_harness/http.ts:27-83` — implementar `postRaw`/`putRaw` em `createHttp` (fazem `fetch` direto e devolvem o `Response`, sem o `request()` que lança em non-2xx).
- Test (Modify): `scripts/wms/cenarios/_harness/http.test.ts` — adicionar caso que prova que `postRaw` devolve `Response` com `.status` mesmo em 400 (não lança).

> **Por quê:** `request()` (`http.ts:71`) faz `if (!res.ok) throw new HttpError(...)`. Todo cenário desta fase precisa inspecionar status code (400/410/200) — logo precisa de uma variante que devolva o `Response` cru. `postRaw`/`putRaw` injetam os mesmos headers de sessão/correlação que `request()`, mas NÃO retêm a lógica de retry (4xx não é retryable mesmo; um teste de status não quer mascarar a resposta).

- [ ] **Step 1 — Escrever o teste que falha.** O arquivo `scripts/wms/cenarios/_harness/http.test.ts` JÁ existe (importa `createHttp` e usa o helper `http()` + `vi.stubGlobal("fetch", ...)`). Anexar um novo `describe` ao FINAL do arquivo (reusando o `http()` e o `afterEach` já presentes no topo — NÃO re-importar):

```ts
describe("postRaw/putRaw devolvem Response cru (não lançam em non-2xx)", () => {
  it("postRaw devolve Response com .status=400 e não lança", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "qty deve ser > 0" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await http().postRaw("/api/wms/ajuste", { qty: 0 });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toMatch(/qty deve ser > 0/);
  });

  it("putRaw injeta X-Session-Id e devolve Response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await http().putRaw("/api/wms/tiny/connections", { id: "1" });
    expect(r.status).toBe(200);
    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers["X-Session-Id"]).toBe("s");
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** Comando: `npm test -- scripts/wms/cenarios/_harness/http.test.ts`. Expected: **FAIL** — `http.postRaw is not a function` (e TS error: `postRaw`/`putRaw` não estão em `HttpClient`).

- [ ] **Step 3 — Implementação mínima.**

(a) Em `scripts/wms/cenarios/_harness/types.ts`, estender a interface `HttpClient` (após `delete`, linha 18):

```ts
export interface HttpClient {
  get<T = unknown>(path: string, headers?: Record<string, string>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  delete<T = unknown>(path: string, headers?: Record<string, string>): Promise<T>;
  /** POST cru: devolve o Response sem lançar em non-2xx (pra asserir status code). */
  postRaw(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** PUT cru: devolve o Response sem lançar em non-2xx (pra asserir status code). */
  putRaw(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}
```

(b) Em `scripts/wms/cenarios/_harness/http.ts`, dentro de `createHttp`, adicionar a função `raw` antes do `return` e incluir `postRaw`/`putRaw` no objeto retornado:

```ts
  async function raw(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = {
      "X-Session-Id": opts.sessionId,
      "X-Correlation-Id": opts.correlationId,
      ...(extraHeaders ?? {}),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${opts.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  return {
    get: (p, headers) => request("GET", p, undefined, headers),
    post: (p, b, headers) => request("POST", p, b, headers),
    patch: (p, b, headers) => request("PATCH", p, b, headers),
    delete: (p, headers) => request("DELETE", p, undefined, headers),
    postRaw: (p, b, headers) => raw("POST", p, b, headers),
    putRaw: (p, b, headers) => raw("PUT", p, b, headers),
  };
```

- [ ] **Step 4 — Rodar e ver passar.** Comando: `npm test -- scripts/wms/cenarios/_harness/http.test.ts`. Expected: **PASS** (postRaw devolve 400 sem lançar; putRaw injeta `X-Session-Id`).

- [ ] **Step 5 — Commit.** `git add scripts/wms/cenarios/_harness/types.ts scripts/wms/cenarios/_harness/http.ts scripts/wms/cenarios/_harness/http.test.ts && git commit -m "test(wms): postRaw/putRaw no harness HttpClient — devolvem Response cru pra asserir status code — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 1.1: [P164] Rejeitar `qty=0` na correção de estoque (regressão do guard já presente)

**Files**
- Test (Create): `scripts/wms/cenarios/catalogo/52-ajuste-rejeita-zero.ts`
- Modify: nenhum (o guard `qty <= 0` já existe em `src/app/api/wms/ajuste/route.ts:46-52`; esta task TRAVA o comportamento como regressão, conforme nota: "rejeitar quantidade zero; pra zerar usa ajuste de inventário").

> Nota: divergência do achado — o achado de P164 aponta `tiny/stock/ajustar/route.ts:42-47` (só barra `< 0`). Mas por D5 essa rota é dead-path; o caminho vivo `/api/wms/ajuste` JÁ rejeita `qty<=0` (`route.ts:46-52`). A regra ("rejeitar 0") permanece válida e fica travada por cenário aqui.

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/52-ajuste-rejeita-zero.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 52 — /api/wms/ajuste rejeita qty=0 (P164).
 * Pra zerar uma posição usa-se ajuste de inventário, não correção pontual.
 */
type Setup = { sku: string; produtoId: string; galpaoId: string; locId: string };

export default {
  nome: "52 — /api/wms/ajuste rejeita qty=0 (correção não zera)",
  descricao: "POST /api/wms/ajuste com qty=0 deve retornar 400 ('qty deve ser > 0').",
  tags: ["ajuste", "guard", "qty-zero", "P164"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("52");
    const produtoId = await ctx.criarProduto({ sku, descricao: "Ajuste rejeita zero 52" });
    const galpaoId = ctx.staging.galpoes.cwb.id;
    const locId = await ctx.criarLocalizacao({ galpao: "CWB", codigo: `PK-52-${Date.now()}`, tipo: "picking" });
    return { sku, produtoId, galpaoId, locId };
  },

  run: async (): Promise<void> => {
    // assertEsperado faz a chamada (precisa do status code).
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const r = await ctx.http.postRaw("/api/wms/ajuste", {
      tripla: {
        produto_id: setup.produtoId,
        galpao_id: setup.galpaoId,
        localizacao_id: setup.locId,
      },
      qty: 0,
      direcao: "entrada",
      motivo: "tentativa de zerar",
      motivo_categoria: "correcao_inventario",
    });
    if (r.status !== 400) {
      throw new Error(`esperava 400 pra qty=0, veio ${r.status}`);
    }
    const body = (await r.json()) as { error?: string };
    if (!/qty deve ser > 0/i.test(body.error ?? "")) {
      throw new Error(`mensagem inesperada: ${body.error}`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

> Nota: helpers reais usados — `ctx.http.postRaw` (criado na Task 1.0; retorna `Response` cru pra inspecionar o 400), `ctx.criarLocalizacao({galpao:"CWB",codigo,tipo:"picking"})→uuid`, `ctx.staging.galpoes.cwb.id`, `ctx.criarProduto({sku,descricao})→uuid`. NÃO usar `ctx.http.post` aqui (lança em non-2xx — não dá pra ler o 400). Task 1.0 é pré-requisito desta task.

- [ ] **Step 2 — Rodar e ver falhar.** Comando: `npm run scenarios -- :only 52` (ou `npx tsx scripts/wms/cenarios/catalogo/52-ajuste-rejeita-zero.ts`). Expected: como o guard `qty<=0` JÁ existe (`route.ts:46-52`), este cenário tende a PASSAR de primeira (regressão verde) — esse é o resultado esperado. O "RED" desta task está em garantir que o cenário compila e exercita o guard; se por algum motivo `0` passar (200 em vez de 400), aí sim há bug a endurecer no Step 3.

- [ ] **Step 3 — Implementação mínima.** Nenhuma mudança de produção: o guard `qty<=0` já está em `src/app/api/wms/ajuste/route.ts:46-52`. (Se o cenário revelar que `0` passa por algum motivo, então e só então endurecer o guard.)

- [ ] **Step 4 — Rodar e ver passar.** Comando: `npm run scenarios -- :only 52`. Expected: **PASS** (status 400, mensagem `qty deve ser > 0`).

- [ ] **Step 5 — Commit.** `git add scripts/wms/cenarios/catalogo/52-ajuste-rejeita-zero.ts && git commit -m "test(wms): cenário 52 — /api/wms/ajuste rejeita qty=0 (P164 regressão) — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 1.2: [P086, P089, P166, P165] Deprecar `tiny/stock/ajustar` (410) + regressão ledger-only auditável com auto-varredura

**Files**
- Modify: `src/app/api/wms/tiny/stock/ajustar/route.ts:1-176` — substituir o corpo do `POST` por um 410 Gone que aponta pra `/api/wms/ajuste` (D5: dead-path; remover as chamadas `movimentarEstoque`/`getEstoque` ao Tiny).
- Test (Create): `scripts/wms/cenarios/catalogo/53-correcao-ledger-only-libera-pedido.ts` — prova que a correção via `/api/wms/ajuste` (1) cria 1 mov `ajuste_manual` com saldo ant/post + autor + motivo, (2) atualiza `siso_estoque`, (3) NÃO chama Tiny (TINY_DISABLED), e (4) libera pedido parado quando saldo 0→+.
- Test (Create): `scripts/wms/cenarios/catalogo/54-tiny-ajustar-deprecada-410.ts` — prova que a rota legada responde 410.

- [ ] **Step 1 — Escrever o teste que falha.**

`scripts/wms/cenarios/catalogo/54-tiny-ajustar-deprecada-410.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 54 — rota legada tiny/stock/ajustar está deprecada (P086/P089/P166/D5).
 * A correção de estoque viva é /api/wms/ajuste (ledger-only). A rota Tiny morta
 * deve responder 410 Gone e NÃO escrever em lugar nenhum.
 */
export default {
  nome: "54 — tiny/stock/ajustar deprecada (410 Gone)",
  descricao: "POST /api/wms/tiny/stock/ajustar deve retornar 410 apontando pra /api/wms/ajuste.",
  tags: ["ajuste", "deprecada", "tiny-legado", "P086", "P089", "P166"],
  setup: async () => ({}),
  run: async () => {},
  assertEsperado: async (ctx: Ctx): Promise<void> => {
    const r = await ctx.http.postRaw("/api/wms/tiny/stock/ajustar", {
      pedidoId: "X", produtoId: 1, galpao: "CWB", quantidade: 3,
    });
    if (r.status !== 410) {
      throw new Error(`esperava 410 (deprecada), veio ${r.status}`);
    }
    const body = (await r.json()) as { error?: string };
    if (!/\/api\/wms\/ajuste/.test(body.error ?? "")) {
      throw new Error(`410 deve apontar pra /api/wms/ajuste; veio: ${body.error}`);
    }
  },
} satisfies Cenario<Record<string, never>>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

`scripts/wms/cenarios/catalogo/53-correcao-ledger-only-libera-pedido.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 53 — correção de estoque ledger-only via /api/wms/ajuste (P086/P089/P165).
 * Pedido parado por falta (aguardando_compra, saldo 0). Operador corrige o saldo
 * pra positivo via /api/wms/ajuste (entrada). Deve: 1) gravar 1 mov ajuste_manual
 * com saldo_anterior=0/posterior=N + usuario_id + motivo; 2) siso_estoque refletir N;
 * 3) liberar o pedido parado (status_separacao sai de aguardando_compra) sem refresh
 * manual — a auto-varredura dispara em toda mov E (ledger.ts:230-263).
 */
type Setup = { sku: string; produtoId: string; galpaoId: string; locId: string; pedidoId: string };

export default {
  nome: "53 — correção ledger-only via /api/wms/ajuste libera pedido parado",
  descricao: "Saldo 0→4 via /api/wms/ajuste: 1 mov ajuste_manual auditável + pedido sai de aguardando_compra.",
  tags: ["ajuste", "ledger", "varredura", "P086", "P089", "P165"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("53");
    const produtoId = await ctx.criarProduto({ sku, descricao: "Correção libera pedido 53" });
    const galpaoId = ctx.staging.galpoes.cwb.id;
    const locId = await ctx.criarLocalizacao({ galpao: "CWB", codigo: `PK-53-${Date.now()}`, tipo: "picking" });
    return { sku, produtoId, galpaoId, locId, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Pedido sem estoque → OC → esgotado → aguardando_compra.
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku: setup.sku, qty: 4 }],
    });
    setup.pedidoId = id;
    await ctx.aguardarStatus(id, "pendente", undefined, { timeout_ms: 20000 });
    await ctx.aprovar(id, "oc");
    await ctx.aguardarStatusSeparacao(id, "validacao_oc");
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens").select("id").eq("pedido_id", id).single();
    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: [String((itemRow as { id: string | number }).id)],
      acao: "esgotado",
    });
    await ctx.aguardarStatusSeparacao(id, "aguardando_compra");

    // Correção: saldo 0 → 4 via /api/wms/ajuste (entrada).
    await ctx.http.post("/api/wms/ajuste", {
      tripla: { produto_id: setup.produtoId, galpao_id: setup.galpaoId, localizacao_id: setup.locId },
      qty: 4,
      direcao: "entrada",
      motivo: "correção de inventário — saldo apareceu",
      motivo_categoria: "correcao_inventario",
    });
    await ctx.aguardar(2500); // varredura fire-and-forget
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // 1) trilha: 1 mov ajuste_manual com saldo ant/post + autor + motivo.
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("tipo, origem_tipo, saldo_anterior, saldo_posterior, usuario_id, motivo")
      .eq("produto_id", setup.produtoId)
      .eq("origem_tipo", "ajuste_manual");
    const ajustes = (movs ?? []) as Array<{
      tipo: string; saldo_anterior: number; saldo_posterior: number; usuario_id: string | null; motivo: string | null;
    }>;
    if (ajustes.length !== 1) throw new Error(`esperava 1 mov ajuste_manual, veio ${ajustes.length}`);
    const a = ajustes[0];
    if (a.tipo !== "E") throw new Error(`esperava tipo E, veio ${a.tipo}`);
    if (Number(a.saldo_anterior) !== 0) throw new Error(`saldo_anterior esperado 0, veio ${a.saldo_anterior}`);
    if (Number(a.saldo_posterior) !== 4) throw new Error(`saldo_posterior esperado 4, veio ${a.saldo_posterior}`);
    if (!a.usuario_id) throw new Error("usuario_id vazio — trilha de autor faltando");
    if (!a.motivo) throw new Error("motivo vazio — trilha de motivo faltando");

    // 2) siso_estoque reflete 4.
    const { data: est } = await ctx.sb
      .from("siso_estoque").select("saldo")
      .eq("produto_id", setup.produtoId).eq("galpao_id", setup.galpaoId).eq("localizacao_id", setup.locId).single();
    if (Number((est as { saldo: number }).saldo) !== 4) {
      throw new Error(`siso_estoque.saldo esperado 4, veio ${(est as { saldo: number }).saldo}`);
    }

    // 3) pedido saiu de aguardando_compra (auto-varredura).
    const { data: ped } = await ctx.sb
      .from("siso_pedidos").select("status_separacao").eq("id", setup.pedidoId).single();
    if ((ped as { status_separacao: string }).status_separacao === "aguardando_compra") {
      throw new Error("pedido ainda em aguardando_compra — auto-varredura não disparou na correção 0→+");
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

- [ ] **Step 2 — Rodar e ver falhar.** Comando: `npm run scenarios -- :only 54` (o 410 ainda não existe → rota responde 200/500). Expected: **FAIL** com `esperava 410 (deprecada), veio 200` (ou 500). Cenário 53 deve PASSAR já (caminho ledger pré-existe) — rodar `npm run scenarios -- :only 53` pra confirmar que a baseline ledger-only + varredura funciona; se falhar, é bug separado a investigar antes.

- [ ] **Step 3 — Implementação mínima.** Substituir o corpo de `src/app/api/wms/tiny/stock/ajustar/route.ts` por:

```ts
import { NextResponse } from "next/server";

/**
 * POST /api/wms/tiny/stock/ajustar — DEPRECADA (Fase 6c / D5).
 *
 * A correção de estoque foi consolidada no ledger-only `/api/wms/ajuste`
 * (auditável: saldo ant/post, autor, motivo, categoria; lock pessimista via
 * wms_inserir_movimentacao; auto-varredura de pedidos parados em mov E).
 *
 * Esta rota escrevia balanço NO TINY (camada fiscal legada) sem trilha no WMS
 * e não tinha caller no frontend (dead-path). Mantida só como 410 Gone pra
 * sinalizar callers externos remanescentes.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "rota deprecada — use POST /api/wms/ajuste (correção de estoque ledger-only, auditável)",
    },
    { status: 410 },
  );
}
```

- [ ] **Step 4 — Rodar e ver passar.** Comandos: `npm run scenarios -- :only 54` e `npm run scenarios -- :only 53`. Expected: **PASS** nos dois (54: 410; 53: 1 mov ajuste_manual auditável + estoque 4 + pedido liberado).

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/tiny/stock/ajustar/route.ts scripts/wms/cenarios/catalogo/53-correcao-ledger-only-libera-pedido.ts scripts/wms/cenarios/catalogo/54-tiny-ajustar-deprecada-410.ts && git commit -m "feat(wms): deprecar tiny/stock/ajustar (410) — correção de estoque consolidada no ledger /api/wms/ajuste (P086/P089/P166/P165) — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 1.3: [P093] Guard backend: conexão Tiny ativa não salva sem `deposito_id`

**Files**
- Modify: `src/app/api/wms/tiny/connections/route.ts:149-204` (`PUT`) — rejeitar 400 quando o PUT seta `deposito_id=null` (ou `undefined`/string vazia) numa conexão que JÁ está ativa (`ativo=true` no banco). O frontend já bloqueia (`conexoes/page.tsx:807` tem `disabled`); falta a "dupla segurança" do backend (nota P093).
- Test (Create): `scripts/wms/cenarios/auth/09-connection-sem-deposito-bloqueia.ts`

> **Premissa real (verificado em `route.ts:150-204`):** o body do PUT tem APENAS `id`/`client_id`/`client_secret`/`deposito_id`/`deposito_nome` — **NÃO existe campo `ativo`** e a rota NÃO lê/grava `ativo`. Logo o guard NÃO pode "ativar via PUT": o único toggle efetivo é "conexão JÁ ativa não pode ficar sem depósito". O guard lê o `ativo` ATUAL do banco e, se a conexão é ativa e o `deposito_id` resultante seria null, rejeita 400. (Marcar uma conexão como ativa é responsabilidade de outra rota/fluxo — fora do escopo deste PUT.)

> Nota: divergência do achado — o achado também cita o fallback `depositos[0]` em `tiny/stock/ajustar` como ponto de risco. Como a Task 1.2 deprecou essa rota (410), o fallback inseguro deixou de existir. Resta o guard de PUT connections, que é o ponto que ainda importa (nota: "o ponto que ainda IMPORTA é o PUT connections não deixar gravar conexão ativa sem depósito").

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/auth/09-connection-sem-deposito-bloqueia.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário auth/09 — PUT /api/wms/tiny/connections não persiste conexão ATIVA
 * sem deposito_id (P093, dupla segurança backend).
 */
type Setup = { connId: string };

export default {
  nome: "auth/09 — conexão Tiny ativa não salva sem depósito",
  descricao: "PUT connections com deposito_id=null numa conexão ativa deve retornar 400.",
  tags: ["conexoes", "guard", "deposito", "P093"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    // Pega uma conexão ativa qualquer do seed.
    const { data: conn } = await ctx.sb
      .from("siso_tiny_connections")
      .select("id")
      .eq("ativo", true)
      .limit(1)
      .single();
    return { connId: String((conn as { id: string }).id) };
  },

  run: async () => {},

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const r = await ctx.http.putRaw("/api/wms/tiny/connections", {
      id: setup.connId,
      deposito_id: null,
    });
    if (r.status !== 400) {
      throw new Error(`esperava 400 (ativa sem depósito), veio ${r.status}`);
    }
    const body = (await r.json()) as { error?: string };
    if (!/dep[oó]sito/i.test(body.error ?? "")) {
      throw new Error(`mensagem deve citar depósito; veio: ${body.error}`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

> Nota: usa `ctx.http.putRaw` (criado na Task 1.0 — PUT que devolve `Response` cru). A pasta `scripts/wms/cenarios/auth/` existe (a auth-matrix vive lá; `npm run auth-matrix`). Como o cenário roda via `runStandalone`, dá pra rodar isolado com `npx tsx`.

- [ ] **Step 2 — Rodar e ver falhar.** Comando: `npx tsx scripts/wms/cenarios/auth/09-connection-sem-deposito-bloqueia.ts` (ou via `npm run auth-matrix` se ele varre a pasta). Expected: **FAIL** com `esperava 400 (ativa sem depósito), veio 200` (hoje o PUT aceita `deposito_id:null`).

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/tiny/connections/route.ts`, inserir o guard logo após o bloco `// Deposit selection` (linha ~187), antes do `if (Object.keys(updates).length === 0)`. NÃO mexer no tipo do body (não existe `ativo` no body — o `ativo` vem do BANCO):

```ts
  // P093 — dupla segurança: conexão JÁ ATIVA não pode ficar sem depósito.
  // O body NÃO tem `ativo` (a rota não ativa conexão) — lemos o `ativo` atual do
  // banco. Se o PUT está limpando o deposito_id (null/"") numa conexão ativa, 400.
  if (body.deposito_id === null || body.deposito_id === undefined) {
    const supabaseGuard = createServiceClient();
    const { data: atual } = await supabaseGuard
      .from("siso_tiny_connections")
      .select("ativo, deposito_id")
      .eq("id", body.id)
      .maybeSingle();
    const atualRow = atual as { ativo?: boolean; deposito_id?: number | null } | null;
    // deposito_id resultante após este PUT: se o body o setou, é o do body;
    // senão preserva o atual do banco.
    const depositoResultante =
      body.deposito_id !== undefined ? body.deposito_id : atualRow?.deposito_id ?? null;
    if (atualRow?.ativo === true && (depositoResultante === null || depositoResultante === undefined)) {
      return NextResponse.json(
        { error: "selecione um depósito antes de salvar a conexão ativa" },
        { status: 400 },
      );
    }
  }
```

> Observação: o guard só dispara quando `deposito_id` está sendo zerado (`null`) OU está ausente do body numa conexão ativa que já estava sem depósito. Um PUT que SETA um `deposito_id` válido passa direto. Um PUT que só troca credenciais (sem `deposito_id`) numa conexão ativa SEM depósito também é barrado — correto: a conexão ativa não pode persistir sem depósito.

- [ ] **Step 4 — Rodar e ver passar.** Comando: `npx tsx scripts/wms/cenarios/auth/09-connection-sem-deposito-bloqueia.ts`. Expected: **PASS** (400 com mensagem citando depósito).

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/tiny/connections/route.ts scripts/wms/cenarios/auth/09-connection-sem-deposito-bloqueia.ts && git commit -m "fix(wms): PUT tiny/connections rejeita conexão ativa sem depósito (P093 dupla segurança backend) — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 1.4: [P091] Congelar `deposito_id` no pedido ao rotear

**Files**
- Modify: `src/lib/webhook-processor-wms.ts:502-535` — no upsert de `siso_pedidos`, gravar `deposito_id` resolvido (uma vez, no roteamento) da conexão Tiny ativa da empresa de origem. Coluna `siso_pedidos.deposito_id` já existe (migration `20260309_add_deposito_columns.sql`) — só passa a ser escrita.
- Test (Create): `scripts/wms/cenarios/catalogo/83-deposito-congelado-no-pedido.ts`

> Nota: divergência do achado — o achado pedia também ler o depósito congelado em `tiny/stock/ajustar`. Como aquela rota foi deprecada (Task 1.2), o consumo do depósito congelado fica disponível pra futura sync marketplace↔WMS (P092, deferido). Aqui congelamos o valor no pedido (a parte verificável agora). A correção de estoque viva (`/api/wms/ajuste`) é 3D (não usa depósito Tiny), então o freeze não muda o caminho de ajuste — é pra consistência fiscal futura, conforme a nota.

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/83-deposito-congelado-no-pedido.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 83 — depósito é congelado no pedido ao rotear (P091).
 * Após o webhook criar o pedido, siso_pedidos.deposito_id deve refletir o
 * deposito_id da conexão Tiny ativa da empresa de origem NO MOMENTO da rota,
 * imune a mudança posterior da config (siso_tiny_connections.deposito_id).
 */
type Setup = { sku: string; pedidoId: string; depositoEsperado: number | null };

export default {
  nome: "83 — depósito congelado no pedido ao rotear",
  descricao: "siso_pedidos.deposito_id é gravado no roteamento (snapshot da conexão Tiny da empresa).",
  tags: ["roteamento", "deposito", "snapshot", "P091"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("83");
    const produtoId = await ctx.criarProduto({ sku, descricao: "Depósito congelado 83" });
    // Garante estoque pra rota = própria (não importa pro snapshot, mas evita OC).
    const locCodigo = `PK-83-${Date.now()}`;
    await ctx.criarLocalizacao({ galpao: "CWB", codigo: locCodigo, tipo: "picking" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: locCodigo, qty: 10 });
    // Garante que a conexão ativa da NetAir tem um deposito_id determinístico
    // (o seed pode não ter um). Sem isso o snapshot seria null e o teste viraria no-op.
    const depositoEsperado = 999;
    await ctx.sb
      .from("siso_tiny_connections")
      .update({ deposito_id: depositoEsperado, deposito_nome: "Depósito teste 83" })
      .eq("empresa_id", ctx.staging.empresas.netair.id)
      .eq("ativo", true);
    return { sku, pedidoId: "", depositoEsperado };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku: setup.sku, qty: 1 }],
    });
    setup.pedidoId = id;
    await ctx.aguardar(1500);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .select("deposito_id")
      .eq("id", setup.pedidoId)
      .single();
    const got = (ped as { deposito_id: number | null }).deposito_id;
    if (got === null) {
      throw new Error("deposito_id não foi congelado no pedido (ficou null)");
    }
    if (got !== setup.depositoEsperado) {
      throw new Error(`deposito_id congelado esperado ${setup.depositoEsperado}, veio ${got}`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

> Nota: helpers reais — `ctx.criarLocalizacao` + `ctx.semearSaldo({produto:SKU,galpao,loc:CODIGO,qty})` (NÃO existe `ctx.darSaldo`), `ctx.staging.empresas.netair.{id,cnpj}`, `ctx.webhook`. O setup força `deposito_id=999` na conexão ativa da NetAir (o seed pode não trazer um), tornando o snapshot determinístico — sem isso o teste viraria no-op.

- [ ] **Step 2 — Rodar e ver falhar.** Comando: `npm run scenarios -- :only 83`. Expected: **FAIL** com `deposito_id não foi congelado no pedido (ficou null)` (o upsert atual não grava `deposito_id`).

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/webhook-processor-wms.ts`, antes do upsert (linha ~502), resolver o depósito da conexão da empresa de origem:

```ts
  // P091 — congelar o depósito Tiny da empresa de origem no pedido (snapshot
  // imune a mudança posterior da config de conexão).
  const { data: connOrigem } = await sb
    .from("siso_tiny_connections")
    .select("deposito_id")
    .eq("empresa_id", empresaOrigemId)
    .eq("ativo", true)
    .maybeSingle();
  const depositoCongelado =
    (connOrigem as { deposito_id: number | null } | null)?.deposito_id ?? null;
```

E adicionar `deposito_id: depositoCongelado,` ao objeto do `.upsert(...)` (junto de `separacao_galpao_id`, linha ~524).

- [ ] **Step 4 — Rodar e ver passar.** Comando: `npm run scenarios -- :only 83`. Expected: **PASS** (`siso_pedidos.deposito_id` = depósito da conexão da NetAir).

- [ ] **Step 5 — Commit.** `git add src/lib/webhook-processor-wms.ts scripts/wms/cenarios/catalogo/83-deposito-congelado-no-pedido.ts && git commit -m "fix(wms): congelar deposito_id no pedido ao rotear — snapshot imune a mudança de config (P091) — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 1.5: [P184, P087] Idempotency da correção: coluna + UNIQUE parcial + RPC + route + frontend

**Files**
- Migration (Create): `supabase/migrations/20260605_movimentacoes_idempotency_key.sql` — coluna `idempotency_key text` em `siso_movimentacoes` + índice UNIQUE parcial. Recriar `wms_inserir_movimentacao` com `p_idempotency_key` + dedup 23505→no-op (retorna mov existente).
- Modify: `src/lib/wms/ledger.ts:65-266` — `InserirMovInput.idempotency_key?: string` + passar `p_idempotency_key` à RPC + tratar 23505 (unique violation) buscando a mov existente por `idempotency_key`.
- Modify: `src/lib/wms/movimentacoes.ts:405-453` — `AjusteManualInput.idempotency_key?: string` + propagar pra `inserirMovimentacao`.
- Modify: `src/app/api/wms/ajuste/route.ts:26-113` — aceitar `idempotency_key` do body (ou header `X-Idempotency-Key`) e propagar.
- Modify: `src/app/wms/ajuste/page.tsx:54-78` — gerar `idempotency_key` (uuid) estável por submissão e enviar no body; botão já tem `disabled={... submit.isPending ...}` (linha 201) — P087 frontend OK.
- Modify: `src/components/wms/ui/modals.tsx:552-589` — gerar `idempotency_key` estável por abertura do form e enviar no body do `/api/wms/ajuste`.
- Test (Create): `test/integration/ajuste-idempotency.test.ts`

> Nota: P146 (`siso_pedidos` idempotency) é tabela diferente — sem colisão. Esta migration cria `idempotency_key` em `siso_movimentacoes`, reusável por toda mov idempotente futura.

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/ajuste-idempotency.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { ajustarEstoque } from "../../src/lib/wms/movimentacoes";

const sb = createServiceClient();

describe("ajuste idempotente por idempotency_key (P184/P087)", () => {
  it("dois ajustes com a MESMA idempotency_key geram UMA única mov", async () => {
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: loc } = await sb
      .from("siso_localizacoes").select("id")
      .eq("galpao_id", g!.id).eq("tipo", "picking").limit(1).single();
    const { data: prod } = await sb
      .from("siso_produtos")
      .insert({ sku: `IDEMP-${Date.now()}`, descricao: "idemp test", unidade: "UN" })
      .select("id").single();
    const { data: u } = await sb.from("siso_usuarios").select("id").limit(1).single();

    const tripla = { produto_id: prod!.id, galpao_id: g!.id, localizacao_id: loc!.id };
    const key = crypto.randomUUID();
    const base = {
      tripla, qty: 3, direcao: "entrada" as const,
      motivo: "teste idempotência", motivo_categoria: "correcao_inventario" as const,
      usuario_id: u!.id, idempotency_key: key,
    };

    const r1 = await ajustarEstoque(base);
    const r2 = await ajustarEstoque(base); // mesma key → no-op idempotente

    expect(r1.mov_id).toBe(r2.mov_id);

    const { data: movs } = await sb
      .from("siso_movimentacoes").select("id")
      .eq("produto_id", prod!.id).eq("origem_tipo", "ajuste_manual");
    expect((movs ?? []).length).toBe(1);

    const { data: est } = await sb
      .from("siso_estoque").select("saldo")
      .eq("produto_id", prod!.id).eq("galpao_id", g!.id).eq("localizacao_id", loc!.id).single();
    expect(Number((est as { saldo: number }).saldo)).toBe(3); // não dobrou
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** Comando: `npm run test:integration -- ajuste-idempotency`. Expected: **FAIL** — `ajustarEstoque` ainda não aceita `idempotency_key` (TS error) e/ou gera 2 movs (saldo=6).

- [ ] **Step 3 — Implementação mínima.**

(a) Migration `supabase/migrations/20260605_movimentacoes_idempotency_key.sql`:

O SQL abaixo é o corpo REAL da RPC vigente (`20260527_wms_inserir_mov_motivo_categoria.sql`, copiado fielmente — `p_tipo character`, validações R/expira_em, whitelist de custo com `ajuste_manual`/`inventario_inicial`, custo médio GLOBAL via `SUM(saldo)`, cast `::wms_motivo_categoria_enum`, `siso_custo_medio.ultima_movimentacao_id`, INSERT-then-UPDATE em `siso_estoque`). As ÚNICAS mudanças vs. a vigente: (1) novo parâmetro `p_idempotency_key text DEFAULT NULL` ao final, (2) o branch de short-circuit por chave no topo, (3) a coluna `idempotency_key` no INSERT, (4) o handler `unique_violation`. **Não há esqueleto a substituir — este é o corpo real.**

```sql
BEGIN;

-- P184/P087 — chave de idempotência no banco local pra correções de estoque.
ALTER TABLE siso_movimentacoes ADD COLUMN IF NOT EXISTS idempotency_key text;

-- UNIQUE parcial: cada idempotency_key gera no máximo 1 mov. Parcial evita
-- inflar o índice com os NULLs (maioria das movs não usa a chave).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mov_idempotency_key
  ON siso_movimentacoes (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Dropa a overload VIGENTE (22 args, COM p_motivo_categoria — assinatura de
-- 20260527). Atenção: p_tipo é `character`, NÃO `text` (igual à vigente).
DROP FUNCTION IF EXISTS public.wms_inserir_movimentacao(
  uuid, uuid, uuid, character, numeric, text, text, jsonb, uuid,
  timestamptz, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid, text, numeric, text
);

CREATE OR REPLACE FUNCTION public.wms_inserir_movimentacao(
  p_produto_id uuid, p_galpao_id uuid, p_localizacao_id uuid,
  p_tipo character, p_quantidade numeric,
  p_origem_tipo text, p_origem_id text DEFAULT NULL::text,
  p_origem_detalhes jsonb DEFAULT NULL::jsonb,
  p_usuario_id uuid DEFAULT NULL::uuid,
  p_expira_em timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_estorno_de uuid DEFAULT NULL::uuid,
  p_empresa_compradora_id uuid DEFAULT NULL::uuid,
  p_empresa_vendedora_id uuid DEFAULT NULL::uuid,
  p_empresa_referencia_id uuid DEFAULT NULL::uuid,
  p_fornecedor_id uuid DEFAULT NULL::uuid,
  p_motivo text DEFAULT NULL::text,
  p_cliente_nome text DEFAULT NULL::text,
  p_pedido_id text DEFAULT NULL::text,
  p_nota_fiscal_id uuid DEFAULT NULL::uuid,
  p_chave_acesso_nf text DEFAULT NULL::text,
  p_custo_unitario numeric DEFAULT NULL::numeric,
  p_motivo_categoria text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
) RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
  v_mov_id              uuid;
  v_saldo_anterior      numeric;
  v_saldo_posterior     numeric;
  v_reservado_anterior  numeric;
  v_reservado_posterior numeric;
  v_custo_medio_atual   numeric;
  v_custo_medio_novo    numeric;
  v_saldo_global        numeric;
  v_recalcula_custo     boolean;
  v_existente           uuid;
BEGIN
  -- P184/P087 — idempotência: se a chave já existe, retorna a mov anterior (no-op).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existente
      FROM siso_movimentacoes WHERE idempotency_key = p_idempotency_key LIMIT 1;
    IF v_existente IS NOT NULL THEN RETURN v_existente; END IF;
  END IF;

  IF p_tipo NOT IN ('E','S','R','L') THEN RAISE EXCEPTION 'tipo inválido: %', p_tipo; END IF;
  IF p_tipo = 'R' AND p_expira_em IS NULL THEN RAISE EXCEPTION 'reserva (tipo R) exige expira_em'; END IF;
  IF p_tipo <> 'R' AND p_expira_em IS NOT NULL THEN RAISE EXCEPTION 'expira_em só é válido pra tipo R'; END IF;

  SELECT saldo, reservado INTO v_saldo_anterior, v_reservado_anterior
    FROM siso_estoque
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_saldo_anterior := 0;
    v_reservado_anterior := 0;
    INSERT INTO siso_estoque (produto_id, galpao_id, localizacao_id, saldo, reservado)
    VALUES (p_produto_id, p_galpao_id, p_localizacao_id, 0, 0);
  END IF;

  v_saldo_posterior := v_saldo_anterior;
  v_reservado_posterior := v_reservado_anterior;
  IF p_tipo = 'E' THEN
    v_saldo_posterior := v_saldo_anterior + p_quantidade;
  ELSIF p_tipo = 'S' THEN
    v_saldo_posterior := v_saldo_anterior - p_quantidade;
    IF v_saldo_posterior < 0 THEN RAISE EXCEPTION 'saldo insuficiente: % - % < 0', v_saldo_anterior, p_quantidade; END IF;
  ELSIF p_tipo = 'R' THEN
    v_reservado_posterior := v_reservado_anterior + p_quantidade;
    IF v_reservado_posterior > v_saldo_anterior THEN RAISE EXCEPTION 'reserva excede saldo: % + % > %', v_reservado_anterior, p_quantidade, v_saldo_anterior; END IF;
  ELSIF p_tipo = 'L' THEN
    v_reservado_posterior := v_reservado_anterior - p_quantidade;
    IF v_reservado_posterior < 0 THEN RAISE EXCEPTION 'liberação excede reservado: % - % < 0', v_reservado_anterior, p_quantidade; END IF;
  END IF;

  -- WHITELIST: origens de entrada que compõem custo médio quando custo_unitario é informado.
  v_recalcula_custo := (p_tipo = 'E' AND p_custo_unitario IS NOT NULL
                        AND p_origem_tipo IN (
                          'nf_compra',
                          'devolucao_cliente_integra',
                          'lancamento_retroativo',
                          'ajuste_manual',
                          'inventario_inicial'
                        ));

  SELECT COALESCE(custo_medio, 0) INTO v_custo_medio_atual
    FROM siso_custo_medio WHERE produto_id=p_produto_id FOR UPDATE;
  IF NOT FOUND THEN v_custo_medio_atual := 0; END IF;
  v_custo_medio_novo := v_custo_medio_atual;

  IF v_recalcula_custo THEN
    SELECT COALESCE(SUM(saldo),0) INTO v_saldo_global FROM siso_estoque WHERE produto_id=p_produto_id;
    IF v_saldo_global + p_quantidade > 0 THEN
      v_custo_medio_novo := (v_saldo_global * v_custo_medio_atual + p_quantidade * p_custo_unitario) / (v_saldo_global + p_quantidade);
    ELSE
      v_custo_medio_novo := p_custo_unitario;
    END IF;
  END IF;

  INSERT INTO siso_movimentacoes (
    produto_id, galpao_id, localizacao_id,
    tipo, quantidade,
    saldo_anterior, saldo_posterior,
    reservado_anterior, reservado_posterior,
    origem_tipo, origem_id, origem_detalhes,
    usuario_id, expira_em, estorno_de,
    empresa_compradora_id, empresa_vendedora_id, empresa_referencia_id,
    fornecedor_id, motivo, cliente_nome,
    pedido_id, nota_fiscal_id, chave_acesso_nf,
    custo_unitario, custo_medio_anterior, custo_medio_posterior,
    motivo_categoria, idempotency_key
  ) VALUES (
    p_produto_id, p_galpao_id, p_localizacao_id,
    p_tipo, p_quantidade,
    v_saldo_anterior, v_saldo_posterior,
    v_reservado_anterior, v_reservado_posterior,
    p_origem_tipo, p_origem_id, p_origem_detalhes,
    p_usuario_id, p_expira_em, p_estorno_de,
    p_empresa_compradora_id, p_empresa_vendedora_id, p_empresa_referencia_id,
    p_fornecedor_id, p_motivo, p_cliente_nome,
    p_pedido_id, p_nota_fiscal_id, p_chave_acesso_nf,
    p_custo_unitario, v_custo_medio_atual, v_custo_medio_novo,
    p_motivo_categoria::wms_motivo_categoria_enum, p_idempotency_key
  ) RETURNING id INTO v_mov_id;

  UPDATE siso_estoque
     SET saldo = v_saldo_posterior, reservado = v_reservado_posterior, atualizado_em = now()
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id;

  IF v_recalcula_custo THEN
    INSERT INTO siso_custo_medio (produto_id, custo_medio, ultima_movimentacao_id, atualizado_em)
    VALUES (p_produto_id, v_custo_medio_novo, v_mov_id, now())
    ON CONFLICT (produto_id) DO UPDATE
      SET custo_medio = EXCLUDED.custo_medio,
          ultima_movimentacao_id = EXCLUDED.ultima_movimentacao_id,
          atualizado_em = EXCLUDED.atualizado_em;
  END IF;

  RETURN v_mov_id;
EXCEPTION
  WHEN unique_violation THEN
    -- Corrida com outra submissão da mesma idempotency_key: retorna a existente.
    IF p_idempotency_key IS NOT NULL THEN
      SELECT id INTO v_existente FROM siso_movimentacoes WHERE idempotency_key = p_idempotency_key LIMIT 1;
      IF v_existente IS NOT NULL THEN RETURN v_existente; END IF;
    END IF;
    RAISE;
END;
$function$;

COMMIT;

-- DOWN: recriar a versão de 20260527_wms_inserir_mov_motivo_categoria.sql (22 args, sem
--       p_idempotency_key); DROP INDEX IF EXISTS uq_mov_idempotency_key;
--       ALTER TABLE siso_movimentacoes DROP COLUMN IF EXISTS idempotency_key.
```

> **ANCORAGEM OBRIGATÓRIA antes de aplicar (verificada neste plano):** o corpo acima foi copiado de `supabase/migrations/20260527_wms_inserir_mov_motivo_categoria.sql` (linhas 18-146 — assinatura, validações, custo médio global, INSERT, casts). Confirme com um `git show` / leitura do arquivo que NADA mudou além das 4 adições de idempotência listadas. **Pontos que NÃO podem regredir:** (a) `p_tipo character` (não `text`); (b) `tipo='R'` exige `p_expira_em` e os outros tipos PROÍBEM `p_expira_em`; (c) whitelist de custo inclui `ajuste_manual` e `inventario_inicial`; (d) custo médio usa `SUM(saldo)` GLOBAL do produto, não o saldo local da posição; (e) cast `p_motivo_categoria::wms_motivo_categoria_enum`; (f) `siso_custo_medio.ultima_movimentacao_id`; (g) INSERT-da-linha-zero-then-UPDATE em `siso_estoque` (NÃO upsert ON CONFLICT). Se a RPC vigente no banco divergir do arquivo (rodar `mcp__supabase__execute_sql` com `SELECT pg_get_functiondef('public.wms_inserir_movimentacao'::regproc)` ANTES — pode haver overload mais novo), reconciliar contra o banco, não contra o arquivo.

Aplicar via `mcp__supabase__apply_migration` (project `ehbxpbeijofxtsbezwxd`, name `20260605_movimentacoes_idempotency_key`).

(b) `src/lib/wms/ledger.ts` — adicionar ao `InserirMovInput` (após linha 104):
```ts
  /** Chave de idempotência (uuid client). Duplicata (23505) vira no-op idempotente. */
  idempotency_key?: string | null;
```
E passar à RPC (no objeto `.rpc("wms_inserir_movimentacao", {...})`, após `p_motivo_categoria`):
```ts
    p_idempotency_key: input.idempotency_key ?? null,
```
E tratar o caso de dedup: se a mov retornada pela RPC já existia (mesma key), o fluxo segue normal (RPC retorna o id existente). Nenhum tratamento extra de erro necessário no TS — a RPC já resolve o no-op.

(c) `src/lib/wms/movimentacoes.ts` — adicionar `idempotency_key?: string` ao `AjusteManualInput` (após `custo_unitario?`, linha ~420) e propagar no `inserirMovimentacao` dentro de `ajustarEstoque` (linha ~451): `idempotency_key: input.idempotency_key,`.

(d) `src/app/api/wms/ajuste/route.ts` — após validar o body, ler a chave:
```ts
  const idempotencyKey =
    (typeof body.idempotency_key === "string" && body.idempotency_key) ||
    req.headers.get("x-idempotency-key") ||
    undefined;
```
E passar `idempotency_key: idempotencyKey,` ao `ajustarEstoque({...})`.

(e) `src/app/wms/ajuste/page.tsx` — gerar uma key estável por submissão. No `submit` mutation, antes do body, montar a key e resetar no `onSuccess`. Adicionar estado:
```ts
  const [idemKey] = useState(() => crypto.randomUUID());
```
e incluir `idempotency_key: idemKey,` no `body` do `wmsApi`. (O botão já tem `disabled={... submit.isPending ...}` — P087 frontend OK.)

(f) `src/components/wms/ui/modals.tsx` — mesma coisa no form do ajuste: `const [idemKey] = useState(() => crypto.randomUUID());` e incluir `idempotency_key: idemKey,` no body do `/api/wms/ajuste` (linha ~557).

- [ ] **Step 4 — Rodar e ver passar.** Comando: `npm run test:integration -- ajuste-idempotency`. Expected: **PASS** (mesma key → 1 mov, saldo=3, `r1.mov_id===r2.mov_id`). Rodar também `npm run test:integration -- ledger-rpc` pra garantir que a recriação da RPC não regrediu o ledger base.

- [ ] **Step 5 — Commit.** `git add supabase/migrations/20260605_movimentacoes_idempotency_key.sql src/lib/wms/ledger.ts src/lib/wms/movimentacoes.ts src/app/api/wms/ajuste/route.ts src/app/wms/ajuste/page.tsx src/components/wms/ui/modals.tsx test/integration/ajuste-idempotency.test.ts && git commit -m "feat(wms): idempotency_key na correção de estoque (coluna+UNIQUE+RPC+route+frontend) — aplica uma só vez (P087/P184) — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 1.6: [P090] Over-reserve na saída: aceitar físico, liberar R a descoberto, alertar + enfileirar compra

**Files**
- Modify: `src/lib/wms/movimentacoes.ts:431-453` — em `ajustarEstoque`, quando `direcao='saida'` e a saída deixaria `reservado > saldo` na tripla, NÃO bloquear: liberar a R a descoberto (L mov nos pedidos cujas R perdem lastro, FIFO), aplicar a saída, e retornar o relatório de reservas a descoberto. Extrair helper puro `planejarLiberacaoDescoberto` (unit-testável) que decide quanto liberar por pedido.
- Modify: `src/app/api/wms/ajuste/route.ts:92-113` — propagar o relatório de over-reserve na resposta + enfileirar compra dos itens afetados via `mandarItensParaCompras` + `registrarEvento('erro')` por pedido afetado (alerta).
- Test (Create): caso `planejarLiberacaoDescoberto` em `src/lib/wms/movimentacoes.test.ts` (vitest unit, conforme `test_harness=vitest_unit`).
- Test (Create): `test/integration/ajuste-over-reserve.test.ts` (atomicidade real contra staging).

> **D3 (vinculante):** aceitar o físico (verdade), liberar (R→prateleira) a parte da reserva sem lastro mantendo `reservado<=saldo` intacto, gerar alerta de reserva a descoberto, e enfileirar a compra da quantidade faltante. Não bloquear, não esconder.

- [ ] **Step 1 — Escrever o teste que falha.**

(unit) Em `src/lib/wms/movimentacoes.test.ts`, adicionar:

```ts
import { planejarLiberacaoDescoberto } from "./movimentacoes";

describe("planejarLiberacaoDescoberto (P090 — over-reserve)", () => {
  it("libera só o excedente, FIFO por pedido (mais antigo descoberto por último)", () => {
    // saldo físico vira 5; reservado total = 8 (pedido A=5 antigo, B=3 novo).
    // precisa liberar 3 (8-5). FIFO: libera dos mais NOVOS primeiro (preserva
    // o pedido mais antigo). Logo B perde 3 (todo), A intacto.
    const r = planejarLiberacaoDescoberto({
      saldoFisico: 5,
      reservas: [
        { pedido_id: "A", qty: 5, criado_em: "2026-06-01T00:00:00Z" },
        { pedido_id: "B", qty: 3, criado_em: "2026-06-03T00:00:00Z" },
      ],
    });
    expect(r.totalLiberar).toBe(3);
    expect(r.porPedido).toEqual([{ pedido_id: "B", qty: 3 }]);
  });

  it("não libera nada quando saldo físico cobre as reservas", () => {
    const r = planejarLiberacaoDescoberto({
      saldoFisico: 10,
      reservas: [{ pedido_id: "A", qty: 4, criado_em: "2026-06-01T00:00:00Z" }],
    });
    expect(r.totalLiberar).toBe(0);
    expect(r.porPedido).toEqual([]);
  });

  it("libera parcial do pedido quando o excedente cai no meio dele", () => {
    // saldo 4, reservado 6 (A=2 antigo, B=4 novo). liberar 2 → tira 2 do B.
    const r = planejarLiberacaoDescoberto({
      saldoFisico: 4,
      reservas: [
        { pedido_id: "A", qty: 2, criado_em: "2026-06-01T00:00:00Z" },
        { pedido_id: "B", qty: 4, criado_em: "2026-06-03T00:00:00Z" },
      ],
    });
    expect(r.totalLiberar).toBe(2);
    expect(r.porPedido).toEqual([{ pedido_id: "B", qty: 2 }]);
  });
});
```

(integration) `test/integration/ajuste-over-reserve.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { ajustarEstoque } from "../../src/lib/wms/movimentacoes";
import { inserirMovimentacao } from "../../src/lib/wms/ledger";
import { reservarAtomico } from "../../src/lib/wms/reservas";

const sb = createServiceClient();

describe("ajuste over-reserve aceita físico e libera R a descoberto (P090/D3)", () => {
  it("saída que deixaria reservado>saldo: aceita, libera o excedente, retorna alerta", async () => {
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: loc } = await sb
      .from("siso_localizacoes").select("id")
      .eq("galpao_id", g!.id).eq("tipo", "picking").limit(1).single();
    const { data: prod } = await sb
      .from("siso_produtos")
      .insert({ sku: `OVR-${Date.now()}`, descricao: "over-reserve", unidade: "UN" })
      .select("id").single();
    const { data: u } = await sb.from("siso_usuarios").select("id").limit(1).single();
    const tripla = { produto_id: prod!.id, galpao_id: g!.id, localizacao_id: loc!.id };

    // saldo 8.
    await inserirMovimentacao({
      tripla, tipo: "E", qty: 8, origem_tipo: "ajuste_manual",
      motivo: "seed", motivo_categoria: "achado", usuario_id: u!.id,
    });
    // reserva 8 (pedido A).
    await reservarAtomico({ tripla, qty: 8, pedido_id: "OVR-PED-A", usuario_id: u!.id });

    // Correção física: saída de 3 (saldo vai pra 5, reservado=8 → descoberto 3).
    const r = await ajustarEstoque({
      tripla, qty: 3, direcao: "saida",
      motivo: "perda física confirmada na prateleira", motivo_categoria: "perda",
      usuario_id: u!.id,
    });

    // Aceito (não lançou). Reservas a descoberto reportadas.
    expect(r.reservasDescoberto).toBeDefined();
    expect(r.reservasDescoberto!.some((d) => d.pedido_id === "OVR-PED-A")).toBe(true);

    // Invariante intacto: reservado <= saldo (5 e 5).
    const { data: est } = await sb
      .from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prod!.id).eq("galpao_id", g!.id).eq("localizacao_id", loc!.id).single();
    const e = est as { saldo: number; reservado: number };
    expect(Number(e.saldo)).toBe(5);
    expect(Number(e.reservado)).toBe(5);
    expect(Number(e.reservado)).toBeLessThanOrEqual(Number(e.saldo));
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** Comandos: `npm test -- src/lib/wms/movimentacoes.test.ts` (FAIL: `planejarLiberacaoDescoberto` não existe) e `npm run test:integration -- ajuste-over-reserve` (FAIL: hoje `ajustarEstoque` saída lança `reservado (8) excederia saldo (5)` via `validarCoerencia`).

- [ ] **Step 3 — Implementação mínima.**

(a) Em `src/lib/wms/movimentacoes.ts`, adicionar o helper puro (próximo ao `ajustarEstoque`):

```ts
export interface ReservaDescobertoInput {
  saldoFisico: number;
  reservas: Array<{ pedido_id: string; qty: number; criado_em: string }>;
}
export interface ReservaDescobertoPlano {
  totalLiberar: number;
  porPedido: Array<{ pedido_id: string; qty: number }>;
}

/**
 * P090/D3 — quando o saldo físico corrigido fica abaixo do reservado, decide
 * QUANTO liberar de cada pedido (R→prateleira) pra manter reservado<=saldo.
 * FIFO inverso: libera dos pedidos MAIS NOVOS primeiro (preserva o mais antigo,
 * que tem prioridade de fila). Não muta nada — só planeja.
 */
export function planejarLiberacaoDescoberto(
  input: ReservaDescobertoInput,
): ReservaDescobertoPlano {
  const reservadoTotal = input.reservas.reduce((s, r) => s + r.qty, 0);
  let excedente = Math.max(0, reservadoTotal - Math.max(0, input.saldoFisico));
  if (excedente === 0) return { totalLiberar: 0, porPedido: [] };
  // Mais novo primeiro (criado_em desc).
  const ordenadas = [...input.reservas].sort(
    (a, b) => (a.criado_em < b.criado_em ? 1 : a.criado_em > b.criado_em ? -1 : 0),
  );
  const porPedido: Array<{ pedido_id: string; qty: number }> = [];
  for (const r of ordenadas) {
    if (excedente <= 0) break;
    const liberar = Math.min(r.qty, excedente);
    if (liberar > 0) {
      porPedido.push({ pedido_id: r.pedido_id, qty: liberar });
      excedente -= liberar;
    }
  }
  return { totalLiberar: reservadoTotal - Math.max(0, input.saldoFisico), porPedido };
}
```

(b) Estender o retorno e a lógica de `ajustarEstoque`. Mudar a assinatura de retorno pra `Promise<{ mov_id: string; reservasDescoberto?: Array<{ pedido_id: string; qty: number }> }>`. No caso `direcao='saida'`, ANTES de chamar `inserirMovimentacao`, checar se a saída deixaria `reservado>saldo`; se sim, planejar e liberar:

```ts
  // P090/D3 — over-reserve: saída que deixaria reservado>saldo não bloqueia.
  // Libera a R a descoberto (R→prateleira) ANTES da saída, mantendo o invariante.
  let reservasDescoberto: Array<{ pedido_id: string; qty: number }> | undefined;
  if (input.direcao === "saida") {
    const sb = createServiceClient();
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo, reservado")
      .match(input.tripla)
      .maybeSingle();
    const saldoAtual = Number((est as { saldo?: number } | null)?.saldo ?? 0);
    const reservadoAtual = Number((est as { reservado?: number } | null)?.reservado ?? 0);
    const saldoFisico = saldoAtual - input.qty;
    if (reservadoAtual > saldoFisico) {
      // Reservas vivas (R sem L) da tripla, por pedido.
      const { data: rRows } = await sb
        .from("siso_movimentacoes")
        .select("origem_id, quantidade, criado_em")
        .match(input.tripla)
        .eq("tipo", "R")
        .eq("origem_tipo", "reserva_pedido")
        .order("criado_em", { ascending: true });
      const reservas = ((rRows ?? []) as Array<{ origem_id: string; quantidade: number; criado_em: string }>)
        .map((r) => ({ pedido_id: r.origem_id, qty: Number(r.quantidade), criado_em: r.criado_em }));
      const plano = planejarLiberacaoDescoberto({ saldoFisico, reservas });
      for (const p of plano.porPedido) {
        await inserirMovimentacao({
          tripla: input.tripla,
          tipo: "L",
          qty: p.qty,
          origem_tipo: "liberacao_reserva",
          origem_id: p.pedido_id,
          origem_detalhes: { motivo: "reserva_a_descoberto_por_correcao" },
          usuario_id: input.usuario_id,
          motivo: `liberada por correção de estoque (reserva a descoberto): ${input.motivo.trim()}`,
        });
      }
      reservasDescoberto = plano.porPedido;
    }
  }
```

E no `return`: `return { mov_id: mov.id, reservasDescoberto };`. (O `inserirMovimentacao` da saída segue após esse bloco — agora `reservado<=saldo`, então não lança.)

(c) Em `src/app/api/wms/ajuste/route.ts`, no `try`, após o `ajustarEstoque`, se houver `reservasDescoberto`: alertar + enfileirar compra. Importar `mandarItensParaCompras` (`@/lib/wms/mandar-compras`), `registrarEvento` (`@/lib/historico-service`) e `createServiceClient`:

```ts
    if (r.reservasDescoberto && r.reservasDescoberto.length > 0) {
      const sb = createServiceClient();
      const pedidoIds = r.reservasDescoberto.map((d) => d.pedido_id);
      // Alerta no histórico de cada pedido afetado.
      // registrarEvento (historico-service.ts:109) tem assinatura
      // { pedidoId, evento, usuarioId?, usuarioNome?, detalhes? } — NÃO existe
      // campo de texto livre; a mensagem vai em detalhes{}. 'erro' está no enum
      // EventoPedido (historico-service.ts:60).
      for (const d of r.reservasDescoberto) {
        await registrarEvento({
          pedidoId: d.pedido_id,
          evento: "erro",
          usuarioId: auth.user.id,
          usuarioNome: auth.user.nome,
          detalhes: {
            motivo_alerta: "reserva_a_descoberto_por_correcao",
            qty_liberada: d.qty,
            motivo_correcao: motivo,
            acao_sugerida: "recompra/realocação/cancelamento",
          },
        });
      }
      // Enfileira a compra do excedente: itens dos pedidos afetados desse produto
      // voltam pra aguardando_compra (sinal canônico de necessidade).
      const { data: itensAfetados } = await sb
        .from("siso_pedido_itens")
        .select("id")
        .in("pedido_id", pedidoIds);
      const itemIds = ((itensAfetados ?? []) as Array<{ id: string | number }>).map((i) => String(i.id));
      if (itemIds.length > 0) {
        await mandarItensParaCompras({
          supabase: sb,
          pedido_ids: pedidoIds,
          item_ids: itemIds,
          usuario_id: auth.user.id,
          usuario_nome: auth.user.nome ?? null,
        });
      }
    }
    return NextResponse.json({
      ok: true,
      mov_id: r.mov_id,
      reservas_descoberto: r.reservasDescoberto ?? [],
    });
```

> **ANCORAGEM (verificado):** `registrarEvento` (`src/lib/historico-service.ts:109`) tem a assinatura `{ pedidoId, evento: EventoPedido, usuarioId?, usuarioNome?, detalhes? }` (camelCase; `evento` é enum, `'erro'` está em `EventoPedido` na linha 60). NÃO existe `tipo`/`descricao`/`pedido_id`/`usuario_id` nem campo de texto livre — a mensagem vai em `detalhes{}` (como acima). `mandarItensParaCompras` (`src/lib/wms/mandar-compras.ts:32`) recebe `MandarComprasArgs = { supabase, pedido_ids, item_ids, usuario_id, usuario_nome }` — o objeto acima já bate. `auth.user` é `SessionUser` (`src/lib/session.ts:5`): `id: string`, `nome: string` (ambos não-nulos) — por isso `auth.user.nome` é seguro; o `?? null` em `usuario_nome` é defensivo e ok.

- [ ] **Step 4 — Rodar e ver passar.** Comandos: `npm test -- src/lib/wms/movimentacoes.test.ts` (PASS: 3 casos do helper) e `npm run test:integration -- ajuste-over-reserve` (PASS: saída aceita, saldo=5, reservado=5, alerta reportado).

- [ ] **Step 5 — Commit.** `git add src/lib/wms/movimentacoes.ts src/app/api/wms/ajuste/route.ts src/lib/wms/movimentacoes.test.ts test/integration/ajuste-over-reserve.test.ts && git commit -m "feat(wms): correção over-reserve aceita físico + libera R a descoberto + alerta + enfileira compra (P090/D3) — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 1.7: [P088] Visibilidade: expor `status_separacao` no payload da correção (correção pós-separação)

**Files**
- Modify: `src/app/api/wms/ajuste/route.ts:103-113` — incluir na resposta o `status_separacao` dos pedidos com reserva viva na tripla ajustada (a UI sinaliza "correção DEPOIS do início da separação"). A nota P088 mantém "corrigir em qualquer etapa" (não bloqueia) — é puramente visibilidade.
- Test (Create): `scripts/wms/cenarios/catalogo/84-ajuste-expoe-contexto-separacao.ts`

> Nota: a parte visual (badge "antes/depois da separação") é `manual_only` por design (achado). O verificável é o payload da API expor o contexto. Frontend (`ajuste/page.tsx` / `modals.tsx`) pode consumir o campo `pedidos_contexto` depois — fora do escopo automatizável aqui.

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/84-ajuste-expoe-contexto-separacao.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 84 — a resposta de /api/wms/ajuste expõe o contexto de separação
 * dos pedidos com reserva viva na tripla (P088). Não bloqueia; só informa.
 */
type Setup = { sku: string; produtoId: string; galpaoId: string; locId: string; pedidoId: string };

export default {
  nome: "84 — /api/wms/ajuste expõe contexto de separação (P088)",
  descricao: "Ajuste numa tripla com pedido em separação retorna pedidos_contexto[].status_separacao.",
  tags: ["ajuste", "visibilidade", "separacao", "P088"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("84");
    const produtoId = await ctx.criarProduto({ sku, descricao: "Contexto separação 84" });
    const galpaoId = ctx.staging.galpoes.cwb.id;
    const locId = await ctx.criarLocalizacao({ galpao: "CWB", codigo: `PK-84-${Date.now()}`, tipo: "picking" });
    return { sku, produtoId, galpaoId, locId, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Dá saldo e cria pedido próprio (gera reserva viva na tripla).
    await ctx.http.post("/api/wms/ajuste", {
      tripla: { produto_id: setup.produtoId, galpao_id: setup.galpaoId, localizacao_id: setup.locId },
      qty: 10, direcao: "entrada", motivo: "seed contexto 84", motivo_categoria: "achado",
    });
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku: setup.sku, qty: 2 }],
    });
    setup.pedidoId = id;
    await ctx.aguardar(2000); // auto-aprovação própria cria reserva
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const r = await ctx.http.postRaw("/api/wms/ajuste", {
      tripla: { produto_id: setup.produtoId, galpao_id: setup.galpaoId, localizacao_id: setup.locId },
      qty: 1, direcao: "entrada", motivo: "correção durante separação", motivo_categoria: "achado",
    });
    if (r.status !== 200) throw new Error(`esperava 200, veio ${r.status}`);
    const body = (await r.json()) as { pedidos_contexto?: Array<{ pedido_id: string; status_separacao: string | null }> };
    if (!Array.isArray(body.pedidos_contexto)) {
      throw new Error("payload deve incluir pedidos_contexto[]");
    }
    if (!body.pedidos_contexto.some((p) => p.pedido_id === setup.pedidoId)) {
      throw new Error(`pedidos_contexto deve conter o pedido ${setup.pedidoId} com reserva viva na tripla`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

- [ ] **Step 2 — Rodar e ver falhar.** Comando: `npm run scenarios -- :only 84`. Expected: **FAIL** com `payload deve incluir pedidos_contexto[]` (a resposta atual não traz o contexto).

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/ajuste/route.ts`, antes do `return NextResponse.json(...)` final, montar o contexto (pedidos com R viva na tripla):

```ts
    // P088 — visibilidade: pedidos com reserva viva nesta tripla + seu status
    // de separação, pra UI sinalizar "correção antes/depois do início da separação".
    const sbCtx = createServiceClient();
    const { data: rViva } = await sbCtx
      .from("siso_movimentacoes")
      .select("origem_id")
      .match(tripla)
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido");
    const pedidoIdsCtx = Array.from(
      new Set(((rViva ?? []) as Array<{ origem_id: string }>).map((m) => m.origem_id)),
    );
    let pedidosContexto: Array<{ pedido_id: string; status_separacao: string | null }> = [];
    if (pedidoIdsCtx.length > 0) {
      const { data: peds } = await sbCtx
        .from("siso_pedidos")
        .select("id, status_separacao")
        .in("id", pedidoIdsCtx);
      pedidosContexto = ((peds ?? []) as Array<{ id: string; status_separacao: string | null }>).map((p) => ({
        pedido_id: p.id,
        status_separacao: p.status_separacao,
      }));
    }
```

E incluir `pedidos_contexto: pedidosContexto,` no objeto de resposta de sucesso (o mesmo `NextResponse.json` que já retorna `ok`, `mov_id`, `reservas_descoberto`).

> Nota: a query lê R vivas (tipo R sem distinguir L) — pra precisão total seria preciso descontar L emitidas, mas pro contexto de UI ("há pedido em separação tocando essa tripla?") a presença de R basta. Se o caso de teste exigir excluir pedidos já totalmente liberados, refinar com um anti-join por `origem_id` em movs `L` — só se o teste falhar por isso.

- [ ] **Step 4 — Rodar e ver passar.** Comando: `npm run scenarios -- :only 84`. Expected: **PASS** (200 + `pedidos_contexto` contém o pedido com reserva viva).

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/ajuste/route.ts scripts/wms/cenarios/catalogo/84-ajuste-expoe-contexto-separacao.ts && git commit -m "feat(wms): /api/wms/ajuste expõe pedidos_contexto[] (status_separacao) pra UI sinalizar correção pós-separação (P088) — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 1.8: Registrar correções em `erros-conhecidos.yaml`

**Files**
- Modify: `erros-conhecidos.yaml` (raiz) — adicionar uma entrada por fix.

- [ ] **Step 1 — Grep antes.** `grep -n "P086\|P090\|stock/ajustar\|over-reserve\|idempotency" erros-conhecidos.yaml` (confirmar que ainda não há entradas).

- [ ] **Step 2 — Adicionar entradas.** Anexar ao `erros-conhecidos.yaml`:

```yaml
- id: raio-x-P086-P089-P166-P165
  date: 2026-06-05
  source: raio-x Fase 6c
  category: business_logic
  message: "Correção de estoque escrevia só no Tiny (sem trilha no WMS, sem lock, sem auto-varredura)"
  cause: "Rota legada tiny/stock/ajustar fazia balanço no Tiny (camada fiscal) e os writes locais foram removidos — zero trilha auditável, two-phase write com janela de desync, e a auto-varredura de pedidos parados (que dispara em mov E no ledger) nunca rodava"
  fix: "Deprecar tiny/stock/ajustar (410). Correção consolidada em /api/wms/ajuste (ledger-only: saldo ant/post, autor, motivo, categoria; lock pessimista via wms_inserir_movimentacao; auto-varredura em mov E)"
  files:
    - src/app/api/wms/tiny/stock/ajustar/route.ts
    - src/app/api/wms/ajuste/route.ts
  tags: [estoque, ledger, ajuste, tiny-legado, varredura]

- id: raio-x-P087-P184
  date: 2026-06-05
  source: raio-x Fase 6c
  category: business_logic
  message: "Duplo Enter na correção de estoque podia aplicar o ajuste duas vezes (sem idempotência no banco local)"
  cause: "Sem idempotency_key no ledger; duplo-clique/retry de rede geraria 2 movs de ajuste (delta aplicado 2x)"
  fix: "Coluna idempotency_key + UNIQUE parcial em siso_movimentacoes; wms_inserir_movimentacao trata 23505 como no-op (retorna mov existente); route aceita idempotency_key (body/header); frontend gera uuid estável por submissão + botão disabled"
  files:
    - supabase/migrations/20260605_movimentacoes_idempotency_key.sql
    - src/lib/wms/ledger.ts
    - src/app/api/wms/ajuste/route.ts
    - src/app/wms/ajuste/page.tsx
    - src/components/wms/ui/modals.tsx
  tags: [idempotencia, ajuste, ledger]

- id: raio-x-P090
  date: 2026-06-05
  source: raio-x Fase 6c
  category: business_logic
  message: "Correção de saldo abaixo do reservado bloqueava (validarCoerencia) em vez de aceitar o físico e alertar"
  cause: "Saída de ajuste que deixaria reservado>saldo era barrada pelo invariante; operador não conseguia registrar a verdade física da prateleira"
  fix: "D3: aceitar o físico, liberar a R a descoberto (R→prateleira, FIFO dos pedidos mais novos) mantendo reservado<=saldo, registrar alerta no histórico de cada pedido afetado e enfileirar compra do excedente via mandarItensParaCompras. Helper puro planejarLiberacaoDescoberto"
  files:
    - src/lib/wms/movimentacoes.ts
    - src/app/api/wms/ajuste/route.ts
  tags: [estoque, reservas, ajuste, over-reserve, compras]

- id: raio-x-P091-P093
  date: 2026-06-05
  source: raio-x Fase 6c
  category: business_logic
  message: "Depósito Tiny lido da config viva (não congelado no pedido); conexão ativa salvava sem depósito"
  cause: "siso_pedidos.deposito_id existia mas não era escrito no roteamento; PUT connections aceitava deposito_id=null em conexão ativa (fallback inseguro pro 1º depósito)"
  fix: "Congelar deposito_id no pedido ao rotear (snapshot da conexão da empresa origem); PUT tiny/connections rejeita 400 quando conexão ativa fica sem depósito"
  files:
    - src/lib/webhook-processor-wms.ts
    - src/app/api/wms/tiny/connections/route.ts
  tags: [deposito, tiny, conexoes, snapshot]

- id: raio-x-P088-P164
  date: 2026-06-05
  source: raio-x Fase 6c
  category: business_logic
  message: "Correção aceitava qty=0; e não sinalizava se a correção ocorria após o início da separação"
  cause: "qty=0 zerava posição sem trilha; payload de correção não expunha status_separacao dos pedidos com reserva viva na tripla"
  fix: "/api/wms/ajuste já rejeita qty<=0 (regressão travada por cenário); payload passa a incluir pedidos_contexto[] com status_separacao pra UI sinalizar correção pós-separação"
  files:
    - src/app/api/wms/ajuste/route.ts
  tags: [ajuste, guard, visibilidade, separacao]
```

- [ ] **Step 3 — Commit.** `git add erros-conhecidos.yaml && git commit -m "docs(wms): registrar correções da Fase 6c em erros-conhecidos.yaml (P086-P093) — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Verificação final do PR

- [ ] `npm run lint` — sem erros novos.
- [ ] `npm test -- scripts/wms/cenarios/_harness/http.test.ts` — verde (postRaw/putRaw da Task 1.0).
- [ ] `npm test -- src/lib/wms/movimentacoes.test.ts` — verde (helper P090 + regressões).
- [ ] `npm run test:integration -- ajuste-idempotency ajuste-over-reserve ledger-rpc` — verde (atomicidade/idempotência/ledger base).
- [ ] `npm run scenarios -- :only 52 53 54 83 84` + `npx tsx scripts/wms/cenarios/auth/09-connection-sem-deposito-bloqueia.ts` — verdes.
- [ ] Atualizar `docs/api-reference-complete.md` (rota `tiny/stock/ajustar` → deprecada 410; `/api/wms/ajuste` aceita `idempotency_key`, retorna `reservas_descoberto` + `pedidos_contexto`) e `docs/database-schema.md` (coluna `siso_movimentacoes.idempotency_key` + UNIQUE parcial; `siso_pedidos.deposito_id` passa a ser escrito) no mesmo commit das mudanças.
