# Raio-X Fase 6e — Sync Tiny: surfacing de erro + filtros + kit Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal:** Tornar a sincronização de produto com o Tiny (`sincronizarProduto`) honesta e robusta. Hoje ela mente: quando falta mapeamento, faz `return` silencioso e a rota responde `{ok:true}` ("Sincronizado") mesmo sem nada ter acontecido (P117/P118/P171/P098). Além disso: kit vazio (tipo=K, `kit:[]`) entra como `eh_kit=true` sem composição — kit fantasma (P097); kit→não-kit deixa composição órfã suja em `siso_produto_kits` (P169); com 2+ mapeamentos a empresa escolhida é não-determinística (P170); e duplo-clique roda duas syncs em paralelo que se corrompem no delete+insert da composição de kit (P176). Esta fase fecha esses sete buracos com guards de pré-voo, surfacing de erro, limpeza de derivados, escolha determinística persistida e claim atômico de header.

**Architecture:** Tudo gira em torno de `src/lib/wms/sync-tiny.ts` (`sincronizarProduto`) e seu único caller-de-operador `src/app/api/wms/produtos/[id]/sync/route.ts` (que já tem `try/catch` + `wmsErrorResponse`). O frontend `src/app/wms/produtos/page.tsx` já tem `toast.error(e.message)` no `onError` e `disabled={sync.isPending}` no botão — então o surfacing pro operador funciona assim que a lib **lança** em vez de retornar void. Para P170 e P176 entram colunas novas (`sync_preferida` em `siso_produto_empresas`; `sincronizando_em` em `siso_produtos`) via migration aplicada em staging (`ehbxpbeijofxtsbezwxd`). Para determinismo, a query de mapeamento ganha `ORDER BY sync_preferida DESC, empresa_id ASC`. Para concorrência, um claim compare-and-set com lease de 5min serializa a sync por produto.

**Tech Stack:** Next.js 16 App Router · TypeScript strict · Supabase (`createServiceClient`, service role) · vitest (unit, `vi.mock` no boundary supabase/tiny-api) · vitest integration (`test/integration/**`, serializado vs staging, stubs Tiny on) · migrations SQL aplicadas via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`.

> **Decisões vinculantes (notas do dono):** P117/P118/P171 = **só avisar** com erro claro (não bloquear botão, não auto-criar mapeamento). P097 = **bloquear** sync de kit vazio e avisar. P169 = **apagar** composição antiga ao virar não-kit. P170 = operador **escolhe** a empresa e sempre usa aquela (determinístico). P176 = marcar produto **sincronizando** e recusar nova sync (1 por vez, lease 5min).

> **Ordem interna do PR (quick-wins primeiro, sem-migration antes de com-migration):** Task 1 (P097, guard puro) → Task 2 (P169, delete condicional) → Task 3 (P117/P118/P171/P098, throw + surfacing) → Task 4 (P170, migration + ORDER BY determinístico) → Task 5 (P176, migration + claim atômico).

---

## PR 1: Sync-tiny — surfacing de erro, kit vazio/órfão, empresa determinística e claim anti-duplo-clique [P097, P169, P117, P118, P171, P098, P170, P176]

### Estado atual ancorado (HEAD)

`src/lib/wms/sync-tiny.ts` — `sincronizarProduto(produtoId: string, opts: SincronizarOptions = {}): Promise<void>`:
- linhas 42–60: monta `mapeamentoQuery` (`.eq("produto_id").eq("ativo", true)` [+ `.eq("empresa_id", opts.preferEmpresaId)` se setado] `.limit(1).maybeSingle()`), e quando `!mapeamento` faz `logger.warn(...) + return;` (void silencioso).
- linha 85: `patch.eh_kit = full.tipo === "K";` (incondicional).
- linhas 121–124: só chama `sincronizarComposicaoKit` quando `full.tipo === "K" && full.kit.length > 0`.
- `sincronizarComposicaoKit` (132–205): delete em `siso_produto_kits WHERE kit_produto_id` (158–161) seguido de insert (198).

`src/app/api/wms/produtos/[id]/sync/route.ts:14–26` — `try { await sincronizarProduto(id); return NextResponse.json({ ok: true }); } catch (e) { return wmsErrorResponse({ source:"wms.produtos.sync", error:e, category:"external_api", ... }); }`.

`src/app/wms/produtos/page.tsx` — mutation `sync` (95–103): `onError:(e)=>toast.error(e.message)`; botão (261–272): `disabled={sync.isPending || !podeEditar}`. **Já cobre o surfacing de erro e o disabled de duplo-clique no frontend** — nenhuma mudança de página é necessária.

`src/app/api/wms/produtos/backfill-imagens/route.ts:71–91` — envolve cada `sincronizarProduto(p.id)` em `try/catch` e empurra `{ ok:false, error:msg }` por SKU. **Absorve o novo throw sem quebrar o batch** — nenhuma mudança necessária; só confirmar no teste de regressão (Task 3).

Schema: `siso_produto_empresas` (PK `(produto_id, empresa_id)`, `tiny_produto_id bigint`, `ativo`) em `20260508_wms_foundation.sql:36–44`. `siso_produtos` tem `sincronizado_em timestamptz` (linha 25) mas **não** `sincronizando_em`. `siso_produto_kits` (`kit_produto_id`, `componente_produto_id`, `quantidade`, `UNIQUE(kit,componente)`) em `20260512_wms_kits.sql:17`.

---

### Task 1.1: Guard de kit vazio (P097) — `eh_kit=true` exige ≥1 componente

Decisão: bloquear/avisar — produto Tiny `tipo=K` com `kit:[]` **não** vira `eh_kit=true`; lança aviso. Extrai a regra pura `decidirEhKit` pra testar sem DB.

**Files**
- Modify `src/lib/wms/sync-tiny.ts:84-85` (substitui `patch.eh_kit = full.tipo === "K"`) e `:121-124` (guard de chamada)
- Test `src/lib/wms/sync-tiny.test.ts` (Create)

**Steps**

- [ ] **Step 1 — Escrever o teste que falha.** Criar `src/lib/wms/sync-tiny.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decidirEhKit } from "./sync-tiny";

describe("decidirEhKit (P097)", () => {
  it("tipo=K com componentes → eh_kit=true", () => {
    expect(decidirEhKit({ tipo: "K", kitLen: 3 })).toEqual({ eh_kit: true, aviso: null });
  });

  it("tipo=K com kit vazio → NÃO marca eh_kit + aviso de kit vazio", () => {
    const r = decidirEhKit({ tipo: "K", kitLen: 0 });
    expect(r.eh_kit).toBe(false);
    expect(r.aviso).toMatch(/kit.*pe[çc]a|pelo menos 1|sem componente/i);
  });

  it("tipo=S → eh_kit=false, sem aviso", () => {
    expect(decidirEhKit({ tipo: "S", kitLen: 0 })).toEqual({ eh_kit: false, aviso: null });
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/lib/wms/sync-tiny.test.ts`
      Expected: FAIL com `does not provide an export named 'decidirEhKit'` (a função ainda não existe).

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/sync-tiny.ts`, adicionar a função pura exportada (logo após os imports / antes de `sincronizarProduto`):

```ts
/**
 * Regra pura: produto Tiny vira kit no WMS só se tipo=K E tiver ≥1 componente.
 * Tiny tipo=K com kit vazio é kit fantasma — não marca eh_kit e avisa (P097).
 */
export function decidirEhKit(input: { tipo: string; kitLen: number }): {
  eh_kit: boolean;
  aviso: string | null;
} {
  if (input.tipo !== "K") return { eh_kit: false, aviso: null };
  if (input.kitLen === 0) {
    return {
      eh_kit: false,
      aviso:
        "Kit sem peças no Tiny — adicione pelo menos 1 componente antes de sincronizar.",
    };
  }
  return { eh_kit: true, aviso: null };
}
```

Trocar o uso no corpo de `sincronizarProduto`. Substituir a linha 85:

```ts
  patch.eh_kit = full.tipo === "K";
```

por:

```ts
  const decisaoKit = decidirEhKit({ tipo: full.tipo, kitLen: full.kit.length });
  patch.eh_kit = decisaoKit.eh_kit;
  if (decisaoKit.aviso) {
    logger.warn("wms.sync.kit", decisaoKit.aviso, { produtoId });
  }
```

e o guard de chamada da composição (linhas 121–124) já usa `full.tipo === "K" && full.kit.length > 0`, que coincide com `decisaoKit.eh_kit` — **manter como está** (não há kit a sincronizar quando vazio).

- [ ] **Step 4 — Rodar e ver passar.** `npm test -- src/lib/wms/sync-tiny.test.ts`
      Expected: PASS (3 testes de `decidirEhKit`).

- [ ] **Step 5 — Commit.**
```bash
git add src/lib/wms/sync-tiny.ts src/lib/wms/sync-tiny.test.ts
git commit -m "fix(wms): sync não marca eh_kit pra kit vazio do Tiny (P097)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em erros-conhecidos.yaml** (grep `P097` antes; se ausente, append):
```yaml
- id: P097
  date: 2026-06-05
  source: raio-x-fase-6e
  category: business_logic
  message: "Kit Tiny tipo=K com composição vazia entrava como eh_kit=true sem componentes (kit fantasma)"
  cause: "patch.eh_kit = (full.tipo === 'K') sem exigir kit.length >= 1"
  fix: "decidirEhKit() só marca eh_kit quando tipo=K e kitLen>0; senão eh_kit=false + aviso"
  files: [src/lib/wms/sync-tiny.ts]
  tags: [sync-tiny, kit, preflight]
```

---

### Task 1.2: Limpar composição órfã ao virar não-kit (P169)

Decisão: quando o produto deixa de ser kit (`eh_kit` decidido = false), apagar as linhas antigas em `siso_produto_kits` desse `kit_produto_id`.

**Files**
- Modify `src/lib/wms/sync-tiny.ts` — logo após o `update(patch)` (linhas 87–91), antes do bloco de fornecedores
- Test `src/lib/wms/sync-tiny.test.ts` (adiciona suite com `vi.mock`)

**Steps**

- [ ] **Step 1 — Escrever o teste que falha.** Acrescentar ao topo de `src/lib/wms/sync-tiny.test.ts` os mocks de boundary e uma suite que verifica o delete na transição K→não-K. Adicionar antes do `describe` existente:

```ts
import { vi, beforeEach } from "vitest";

// ── Mock do boundary supabase + tiny-api ──────────────────────────────────
const fullStub = {
  id: 555,
  descricao: "Produto X",
  sku: "SKU-X",
  precos: { precoCusto: 10 },
  gtin: null,
  unidade: "UN",
  ncm: null,
  origem: null,
  tipo: "S", // não-kit por default; cada teste sobrescreve
  imagens: [] as string[],
  imagemUrl: null,
  descricaoComplementar: null,
  fornecedores: [] as Array<{ id: number; nome: string; codigoProdutoNoFornecedor: string | null }>,
  kit: [] as Array<{ produto: { id: number; sku: string | null; descricao: string | null }; quantidade: number }>,
};

vi.mock("@/lib/tiny-api", () => ({
  getProdutoFull: vi.fn(async () => fullStub),
}));
vi.mock("@/lib/tiny-oauth", () => ({
  getValidTokenByEmpresa: vi.fn(async () => ({ token: "tok" })),
}));
vi.mock("@/lib/tiny-queue", () => ({
  runWithEmpresa: vi.fn(async (_e: string, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/wms/fornecedores", () => ({
  ensureFornecedorTiny: vi.fn(async () => ({ id: "forn-1" })),
  upsertProdutoFornecedor: vi.fn(async () => undefined),
}));

// Builder de um cliente supabase fake encadeável. `tables` mapeia nome→handler.
type Handlers = Record<string, (op: string, args: unknown) => unknown>;
function makeSb(handlers: Handlers, sink: { deletes: string[] }) {
  return {
    from(table: string) {
      const ctx: { filters: Record<string, unknown> } = { filters: {} };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          ctx.filters[col] = val;
          return chain;
        },
        in: () => chain,
        limit: () => chain,
        maybeSingle: async () => handlers[table]?.("maybeSingle", ctx.filters) ?? { data: null, error: null },
        update: () => ({
          eq: async () => handlers[table]?.("update", ctx.filters) ?? { error: null },
        }),
        delete: () => ({
          eq: async (col: string, val: unknown) => {
            if (table === "siso_produto_kits") sink.deletes.push(String(val));
            return { error: null };
          },
        }),
        insert: async () => ({ error: null }),
        order: () => chain,
      };
      return chain;
    },
  };
}

let sbSink: { deletes: string[] };
let sbHandlers: Handlers;
vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => makeSb(sbHandlers, sbSink),
}));
```

E a suite nova (após o `describe("decidirEhKit"...)`):

```ts
describe("sincronizarProduto · limpeza de composição K→não-K (P169)", () => {
  beforeEach(() => {
    sbSink = { deletes: [] };
    sbHandlers = {
      siso_produtos: (op, f) =>
        op === "maybeSingle"
          ? { data: { sku: "SKU-X" }, error: null }
          : { error: null },
      siso_produto_empresas: () => ({
        data: { empresa_id: "emp-1", tiny_produto_id: 555 },
        error: null,
      }),
    };
    fullStub.tipo = "S";
    fullStub.kit = [];
  });

  it("produto que virou não-kit dispara delete em siso_produto_kits do seu id", async () => {
    const { sincronizarProduto } = await import("./sync-tiny");
    await sincronizarProduto("prod-1");
    expect(sbSink.deletes).toContain("prod-1");
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/lib/wms/sync-tiny.test.ts`
      Expected: FAIL com `expected [ ] to contain 'prod-1'` (hoje não há delete quando tipo≠K).

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/sync-tiny.ts`, logo após o bloco `update(patch)` (depois de `if (errUpdate) throw errUpdate;`, antes do comentário `// ── Fornecedores ──`), inserir:

```ts
  // Virou não-kit: apaga composição antiga pra não deixar dados órfãos (P169).
  if (!decisaoKit.eh_kit) {
    const { error: errLimpaKit } = await sb
      .from("siso_produto_kits")
      .delete()
      .eq("kit_produto_id", produtoId);
    if (errLimpaKit) {
      logger.warn("wms.sync.kit", "falha ao limpar composição órfã", {
        produtoId,
        erro: errLimpaKit.message,
      });
    }
  }
```

> Nota: `decisaoKit` foi introduzido na Task 1.1 e está em escopo aqui.

- [ ] **Step 4 — Rodar e ver passar.** `npm test -- src/lib/wms/sync-tiny.test.ts`
      Expected: PASS (suites `decidirEhKit` + `K→não-K`).

- [ ] **Step 5 — Commit.**
```bash
git add src/lib/wms/sync-tiny.ts src/lib/wms/sync-tiny.test.ts
git commit -m "fix(wms): sync apaga composição órfã ao produto virar não-kit (P169)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — erros-conhecidos.yaml** (grep `P169`):
```yaml
- id: P169
  date: 2026-06-05
  source: raio-x-fase-6e
  category: business_logic
  message: "Produto que mudou de kit para não-kit no Tiny deixava composição antiga órfã em siso_produto_kits"
  cause: "delete da composição só rodava dentro de sincronizarComposicaoKit (chamada só quando tipo continua K)"
  fix: "ao decidir eh_kit=false, deletar siso_produto_kits WHERE kit_produto_id=produtoId"
  files: [src/lib/wms/sync-tiny.ts]
  tags: [sync-tiny, kit, cache-invalidation]
```

---

### Task 1.3: Surfacing de erro sem mapeamento (P117/P118/P171/P098) — `throw` em vez de `return` void

Decisão (3 notas idênticas + P098): sem mapeamento ativo, **lançar** erro claro. A rota já tem `try/catch` + `wmsErrorResponse` e o frontend já mostra `toast.error(e.message)` — só falta a lib parar de engolir.

**Files**
- Modify `src/lib/wms/sync-tiny.ts:54-60` (troca `logger.warn + return` por `throw`)
- Modify `src/app/api/wms/produtos/[id]/sync/route.ts:18-25` (sem-mapeamento é 4xx do usuário, não `internal_error` 5xx)
- Test `src/lib/wms/sync-tiny.test.ts` (unit, novo describe)
- Test `scripts/wms/cenarios/catalogo/98-sync-sem-mapeamento.ts` (Create — E2E HTTP)

**Steps**

- [ ] **Step 1 — Escrever o teste que falha.** Acrescentar a `src/lib/wms/sync-tiny.test.ts`:

```ts
describe("sincronizarProduto · sem mapeamento (P117/P118/P171/P098)", () => {
  beforeEach(() => {
    sbSink = { deletes: [] };
    sbHandlers = {
      siso_produtos: () => ({ data: { sku: "SKU-X" }, error: null }),
      // mapeamento ausente → maybeSingle retorna data:null
      siso_produto_empresas: () => ({ data: null, error: null }),
    };
  });

  it("produto sem siso_produto_empresas ativo → REJEITA com mensagem de vínculo", async () => {
    const { sincronizarProduto } = await import("./sync-tiny");
    await expect(sincronizarProduto("prod-1")).rejects.toThrow(
      /mapeamento|v[íi]nculo|fornecedor\/Tiny/i,
    );
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/lib/wms/sync-tiny.test.ts`
      Expected: FAIL — `sincronizarProduto` resolve (void) em vez de rejeitar; `rejects.toThrow` falha com "promise resolved instead of rejecting".

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/sync-tiny.ts`, substituir o bloco das linhas 54–60:

```ts
  if (!mapeamento) {
    logger.warn("wms.sync", "produto sem mapeamento Tiny ativo", {
      produtoId,
      preferEmpresaId: opts.preferEmpresaId,
    });
    return;
  }
```

por:

```ts
  if (!mapeamento) {
    throw new SyncSemMapeamentoError(
      "Não achei o mapeamento desse produto com o fornecedor/Tiny. Crie o vínculo manualmente antes de sincronizar.",
    );
  }
```

E declarar a classe de erro tipada no topo do arquivo (após os imports), pra a rota poder distinguir 4xx de 5xx:

```ts
/** Falta de vínculo produto↔Tiny — erro do usuário (4xx), não falha de infra. */
export class SyncSemMapeamentoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncSemMapeamentoError";
  }
}
```

Na rota `src/app/api/wms/produtos/[id]/sync/route.ts`, importar a classe e tratar como 4xx antes do `wmsErrorResponse` genérico:

```ts
import { sincronizarProduto, SyncSemMapeamentoError } from "@/lib/wms/sync-tiny";
```

e o `catch` (linhas 17–26) vira:

```ts
  } catch (e) {
    if (e instanceof SyncSemMapeamentoError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    return wmsErrorResponse({
      source: "wms.produtos.sync",
      error: e,
      category: "external_api",
      requestPath: `/api/wms/produtos/${id}/sync`,
      requestMethod: "POST",
      metadata: { produto_id: id },
    });
  }
```

- [ ] **Step 4 — Rodar e ver passar.** `npm test -- src/lib/wms/sync-tiny.test.ts`
      Expected: PASS (todas as suites unit do arquivo).

- [ ] **Step 5 — Escrever o cenário E2E.** Criar `scripts/wms/cenarios/catalogo/98-sync-sem-mapeamento.ts`, espelhando o shape REAL de `81-receber-oc-destrava-pedido.ts`: `export default { nome, descricao, tags, setup(ctx)→Setup, run(ctx, setup), assertEsperado(ctx, setup) }`. O `ctx.http.post` **lança `HttpError`** (`.status`, `.body`) em não-2xx — então o critério "rota retorna não-2xx com `{error}`" é capturado no `catch`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * P117/P118/P171/P098 — POST /api/wms/produtos/[id]/sync para produto SEM
 * mapeamento ativo (nenhuma siso_produto_empresas) deve responder não-2xx
 * com { error }, não { ok:true }. ctx.http.post lança HttpError em não-2xx.
 *
 * Nota: NÃO executado por padrão — typecheck + roda via :only.
 */
type Setup = { produtoId: string };

export default {
  nome: "98 — Sync de produto sem mapeamento Tiny retorna erro claro",
  descricao:
    "Produto sem siso_produto_empresas ativo: POST /produtos/[id]/sync deve " +
    "responder não-2xx com { error }, nunca { ok:true } (P117/P118/P171/P098).",
  tags: ["sync-tiny", "surfacing", "mapeamento"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("98");
    const produtoId = await ctx.criarProduto({
      sku,
      descricao: "Sync sem mapeamento 98",
    });
    // Propositalmente NÃO cria siso_produto_empresas → mapeamento ausente.
    return { produtoId };
  },

  run: async (_ctx: Ctx, _setup: Setup): Promise<void> => {
    // A chamada acontece no assert pra capturar o HttpError lançado em não-2xx.
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    let status = 0;
    let body: unknown = null;
    try {
      await ctx.http.post(`/api/wms/produtos/${setup.produtoId}/sync`);
    } catch (e) {
      const err = e as { status?: number; body?: unknown };
      status = err.status ?? 0;
      body = err.body ?? null;
    }
    if (status >= 200 && status < 300) {
      throw new Error(
        `esperava não-2xx, veio ${status} com ${JSON.stringify(body)}`,
      );
    }
    if (!(body && typeof body === "object" && "error" in (body as object))) {
      throw new Error(`esperava { error } no corpo, veio ${JSON.stringify(body)}`);
    }
  },
} satisfies Cenario<Setup>;
```

> Nota de fidelidade: o `Cenario` real é `export default { nome, descricao, tags, setup, run, assertEsperado }` com `Setup` tipado (não `export const cenario` nem `ctx.set/get`). `ctx.http.post` lança `HttpError` (com `.status`/`.body`) em não-2xx — por isso a chamada vai no `assertEsperado` dentro de `try/catch`. Helpers usados (`ctx.skuUnico`, `ctx.criarProduto`, `ctx.http`, `ctx.sb`) existem em `_harness/types.ts`.

      Rodar só este cenário: `npm run scenarios -- :only 98`
      Expected: PASS (HttpError com status 409 + `error` no body). Antes do fix da lib (Task 1.3) a rota responderia `{ ok:true }` 200 → o assert falharia.

- [ ] **Step 6 — Regressão do backfill (P098).** Verificar que o batch não quebra com o novo throw. Adicionar ao `src/lib/wms/sync-tiny.test.ts` (não precisa de novo arquivo — o backfill já trata por SKU):

```ts
describe("backfill absorve throw sem mapeamento (P098 regressão)", () => {
  it("SyncSemMapeamentoError é instância de Error (catch do backfill captura)", async () => {
    const { SyncSemMapeamentoError } = await import("./sync-tiny");
    const e = new SyncSemMapeamentoError("x");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("x");
  });
});
```
      `npm test -- src/lib/wms/sync-tiny.test.ts` → Expected: PASS.

- [ ] **Step 7 — Commit.**
```bash
git add src/lib/wms/sync-tiny.ts src/app/api/wms/produtos/[id]/sync/route.ts \
        src/lib/wms/sync-tiny.test.ts scripts/wms/cenarios/catalogo/98-sync-sem-mapeamento.ts
git commit -m "fix(wms): sync lança erro claro quando falta mapeamento Tiny (P117/P118/P171/P098)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8 — erros-conhecidos.yaml** (grep `P117`):
```yaml
- id: P117
  date: 2026-06-05
  source: raio-x-fase-6e
  category: business_logic
  message: "sincronizarProduto fazia return void silencioso sem mapeamento; rota respondia {ok:true} (operador via 'Sincronizado' sem nada ter sincronizado). Cobre P118/P171/P098 (mesmo defeito-raiz)"
  cause: "early-return em sync-tiny.ts:54-60 + rota sempre retornando {ok:true}"
  fix: "lib lança SyncSemMapeamentoError; rota responde 409 {error}; frontend já mostra toast.error(e.message)"
  files: [src/lib/wms/sync-tiny.ts, src/app/api/wms/produtos/[id]/sync/route.ts]
  tags: [sync-tiny, surfacing, data-visibility, P118, P171, P098]
```

---

### Task 1.4: Empresa de sync determinística (P170) — migration + ORDER BY estável

Decisão: com 2+ mapeamentos, o operador escolhe a empresa e o sistema **sempre** usa aquela. Persistir a escolha em `siso_produto_empresas.sync_preferida` (≤1 por produto) e, na ausência de escolha, usar tie-break estável `empresa_id ASC` — matando a imprevisibilidade.

**Files**
- Create `supabase/migrations/20260607_produto_empresa_sync_pref.sql`
- Modify `src/lib/wms/sync-tiny.ts:42-52` (ORDER BY determinístico na `mapeamentoQuery`)
- Test `test/integration/sync-tiny-determinismo.test.ts` (Create — integration vs staging)

**Steps**

- [ ] **Step 1 — Escrever o teste que falha (integration).** Criar `test/integration/sync-tiny-determinismo.test.ts`. O alvo verificável é: **a query de mapeamento sempre escolhe o mesmo registro** entre 2 mapeamentos ativos — checável diretamente contra staging sem chamar o Tiny (que o stub não modela com 2 empresas). Reproduzimos a query do `sincronizarProduto` e asseveramos estabilidade + respeito a `sync_preferida`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
const SKU = `TEST-INT-SYNCPREF-${Math.random().toString(36).slice(2, 8)}`;
let produtoId: string;
let empA: string;
let empB: string;

beforeAll(async () => {
  const { data: emps } = await sb.from("siso_empresas").select("id").limit(2);
  empA = emps![0].id;
  empB = emps![1].id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "sync pref test", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;
  await sb.from("siso_produto_empresas").insert([
    { produto_id: produtoId, empresa_id: empA, tiny_produto_id: 7770001, ativo: true },
    { produto_id: produtoId, empresa_id: empB, tiny_produto_id: 7770002, ativo: true },
  ]);
});

afterAll(async () => {
  await sb.from("siso_produto_empresas").delete().eq("produto_id", produtoId);
  await sb.from("siso_produtos").delete().eq("id", produtoId);
});

// Espelha a query determinística do sincronizarProduto.
async function escolherMapeamento() {
  const { data } = await sb
    .from("siso_produto_empresas")
    .select("empresa_id, tiny_produto_id")
    .eq("produto_id", produtoId)
    .eq("ativo", true)
    .order("sync_preferida", { ascending: false })
    .order("empresa_id", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

describe("sync-tiny determinismo (P170)", () => {
  it("sem preferida: escolhe sempre o mesmo (tie-break empresa_id ASC) em 5 execuções", async () => {
    const escolhas = [];
    for (let i = 0; i < 5; i++) escolhas.push((await escolherMapeamento())!.empresa_id);
    expect(new Set(escolhas).size).toBe(1);
  });

  it("marcar sync_preferida=true numa empresa força essa empresa", async () => {
    await sb
      .from("siso_produto_empresas")
      .update({ sync_preferida: true })
      .eq("produto_id", produtoId)
      .eq("empresa_id", empB);
    const escolha = await escolherMapeamento();
    expect(escolha!.empresa_id).toBe(empB);
  });

  it("partial unique index recusa 2ª preferida no mesmo produto", async () => {
    const { error } = await sb
      .from("siso_produto_empresas")
      .update({ sync_preferida: true })
      .eq("produto_id", produtoId)
      .eq("empresa_id", empA);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23505");
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration`
      Expected: FAIL — coluna `sync_preferida` não existe (`column siso_produto_empresas.sync_preferida does not exist`); `.order("sync_preferida")` quebra.

- [ ] **Step 3a — Criar a migration.** Criar `supabase/migrations/20260607_produto_empresa_sync_pref.sql`:

```sql
-- P170: escolha determinística da empresa de sync.
-- Coluna persistente + ≤1 preferida por produto. Backfill: produto com
-- mapeamento único vira preferida (no-op de comportamento); com múltiplos
-- fica false (operador escolhe; sync usa tie-break empresa_id ASC até lá).

ALTER TABLE siso_produto_empresas
  ADD COLUMN IF NOT EXISTS sync_preferida boolean NOT NULL DEFAULT false;

-- No máximo uma preferida por produto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_emp_sync_pref
  ON siso_produto_empresas(produto_id)
  WHERE sync_preferida;

-- Backfill: produtos com exatamente 1 mapeamento ativo → marca como preferida.
UPDATE siso_produto_empresas pe
SET sync_preferida = true
WHERE pe.ativo
  AND (
    SELECT count(*) FROM siso_produto_empresas pe2
    WHERE pe2.produto_id = pe.produto_id AND pe2.ativo
  ) = 1;

COMMENT ON COLUMN siso_produto_empresas.sync_preferida IS
  'P170: empresa escolhida para sync determinística. <=1 true por produto (idx_prod_emp_sync_pref).';
```

- [ ] **Step 3b — Aplicar a migration em staging.** Via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `20260607_produto_empresa_sync_pref`, com o SQL acima.

- [ ] **Step 3c — Implementação mínima na lib.** Em `src/lib/wms/sync-tiny.ts`, atualizar a `mapeamentoQuery` (linhas 42–52) para ordenar deterministicamente quando `preferEmpresaId` não é passado. Substituir:

```ts
  const { data: mapeamento, error } = await mapeamentoQuery
    .limit(1)
    .maybeSingle();
```

por:

```ts
  const { data: mapeamento, error } = await mapeamentoQuery
    .order("sync_preferida", { ascending: false })
    .order("empresa_id", { ascending: true })
    .limit(1)
    .maybeSingle();
```

> Nota: o `.select("empresa_id, tiny_produto_id")` da linha 44 já basta — não precisamos selecionar `sync_preferida` pra ordenar por ela. `preferEmpresaId` continua filtrando antes do order (caminho do backfill por empresa intacto).

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration`
      Expected: PASS (3 testes de determinismo: estabilidade, preferida força, 23505 na 2ª preferida).

- [ ] **Step 5 — Commit.**
```bash
git add supabase/migrations/20260607_produto_empresa_sync_pref.sql \
        src/lib/wms/sync-tiny.ts test/integration/sync-tiny-determinismo.test.ts
git commit -m "fix(wms): empresa de sync determinística via sync_preferida + ORDER BY estável (P170)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — erros-conhecidos.yaml** (grep `P170`):
```yaml
- id: P170
  date: 2026-06-05
  source: raio-x-fase-6e
  category: database
  message: "Com 2+ mapeamentos Tiny, sync escolhia empresa não-deterministicamente (query sem ORDER BY)"
  cause: ".limit(1).maybeSingle() sem ORDER BY → Postgres sem garantia de ordem"
  fix: "coluna sync_preferida (<=1 por produto via partial unique) + ORDER BY sync_preferida DESC, empresa_id ASC"
  files: [src/lib/wms/sync-tiny.ts, supabase/migrations/20260607_produto_empresa_sync_pref.sql]
  tags: [sync-tiny, determinismo, migration]
```

> **Open question pra UI (fora do mínimo):** persistir a escolha do operador exige um endpoint PATCH `siso_produto_empresas.sync_preferida` + seletor no drawer quando há 2+ mapeamentos (citado no achado P170 como change_sites de UI). O fix mínimo aqui entrega o **backstop determinístico** (tie-break estável + coluna + constraint); a UI de escolha explícita é incremento de escopo maior — confirmar com o dono se entra agora ou em PR de frontend (Fase 6 "Frontend idempotency/UX").

---

### Task 1.5: Claim atômico anti-duplo-clique (P176) — migration + lease 5min

Decisão: marcar o produto como `sincronizando` no início; segunda sync concorrente é recusada com "já tá sincronizando". Claim compare-and-set com lease de 5min (auto-libera trava órfã se a sync crashar). Release em `finally`.

**Files**
- Create `supabase/migrations/20260607b_produto_sincronizando_em.sql`
- Modify `src/lib/wms/sync-tiny.ts` — claim no início do `sincronizarProduto` + `try/finally` com release; nova classe de erro `SyncJaEmAndamentoError`
- Modify `src/app/api/wms/produtos/[id]/sync/route.ts` — mapear `SyncJaEmAndamentoError` → 409
- Test `test/integration/sync-tiny-claim.test.ts` (Create — integration vs staging)

**Steps**

- [ ] **Step 1 — Escrever o teste que falha (integration).** Criar `test/integration/sync-tiny-claim.test.ts`. Como o stub Tiny retorna `tipo:"S"`/`kit:[]` (não chama Tiny real), seedamos um mapeamento real e disparamos duas syncs concorrentes; exatamente uma deve completar e a outra ser recusada:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { sincronizarProduto } from "../../src/lib/wms/sync-tiny";

const sb = createServiceClient();
const SKU = `TEST-INT-CLAIM-${Math.random().toString(36).slice(2, 8)}`;
let produtoId: string;
let empresaId: string;
const TINY_ID = 7780000 + (Math.floor(Date.now() / 1000) % 99999);

beforeAll(async () => {
  // Stubs Tiny ligados no harness de integração; getProdutoFull resolve via siso_produto_empresas.
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = emp!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "claim test", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;
  await sb.from("siso_produto_empresas").insert({
    produto_id: produtoId,
    empresa_id: empresaId,
    tiny_produto_id: TINY_ID,
    ativo: true,
    sync_preferida: true,
  });
});

afterAll(async () => {
  await sb.from("siso_produto_empresas").delete().eq("produto_id", produtoId);
  await sb.from("siso_produtos").delete().eq("id", produtoId);
});

describe("sincronizarProduto claim (P176)", () => {
  it("duas syncs concorrentes: 1 completa, 1 recusada com 'já sincronizando'", async () => {
    const results = await Promise.allSettled([
      sincronizarProduto(produtoId),
      sincronizarProduto(produtoId),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason?.message)).toMatch(
      /sincroniz/i,
    );
  });

  it("após terminar, sincronizando_em volta a null (release)", async () => {
    const { data } = await sb
      .from("siso_produtos")
      .select("sincronizando_em")
      .eq("id", produtoId)
      .single();
    expect(data!.sincronizando_em).toBeNull();
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration`
      Expected: FAIL — coluna `sincronizando_em` não existe; o claim ainda não existe, então ambas as syncs completam (`fulfilled.length` = 2, não 1).

- [ ] **Step 3a — Criar a migration.** Criar `supabase/migrations/20260607b_produto_sincronizando_em.sql`:

```sql
-- P176: lease de sincronização por produto. Claim compare-and-set com
-- staleness de 5min (auto-libera trava órfã se a sync crashar antes do release).
ALTER TABLE siso_produtos
  ADD COLUMN IF NOT EXISTS sincronizando_em timestamptz NULL;

COMMENT ON COLUMN siso_produtos.sincronizando_em IS
  'P176: lease de sync em andamento. Setado no claim; limpo no release/finally. Stale > 5min é reclamável.';
```

- [ ] **Step 3b — Aplicar a migration em staging.** Via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `20260607b_produto_sincronizando_em`, com o SQL acima.

- [ ] **Step 3c — Implementação mínima na lib.** Em `src/lib/wms/sync-tiny.ts`:

Declarar a classe de erro (junto da `SyncSemMapeamentoError` da Task 1.3):

```ts
/** Sync já em andamento pro mesmo produto — recusa nova sync (P176). */
export class SyncJaEmAndamentoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncJaEmAndamentoError";
  }
}
```

No início de `sincronizarProduto`, logo após buscar `produto` (depois de `if (!produto) throw new Error("produto não encontrado");`), inserir o claim atômico via RPC-livre (UPDATE compare-and-set). `supabase-js` não suporta `WHERE ... < now()-interval` direto no `.update().eq()`, então usamos `.rpc` não é necessário: fazemos o compare-and-set com filtro `.or()` por timestamp. Implementar com uma RPC mínima dedicada é mais limpo e atômico — adicionar à mesma migration:

Atualizar `supabase/migrations/20260607b_produto_sincronizando_em.sql` para incluir a RPC de claim (append ao final do arquivo, antes de aplicar):

```sql
-- Claim atômico: marca sincronizando_em=now() se livre ou lease vencido (>5min).
-- Retorna true se reclamou, false se já há sync ativa.
CREATE OR REPLACE FUNCTION wms_claim_sync_produto(p_produto_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_claimed boolean;
BEGIN
  UPDATE siso_produtos
  SET sincronizando_em = now()
  WHERE id = p_produto_id
    AND (sincronizando_em IS NULL OR sincronizando_em < now() - interval '5 minutes')
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$$;

CREATE OR REPLACE FUNCTION wms_release_sync_produto(p_produto_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE siso_produtos SET sincronizando_em = NULL WHERE id = p_produto_id;
END;
$$;
```

No corpo de `sincronizarProduto`, depois do `if (!produto) ...`:

```ts
  const { data: reclamou, error: errClaim } = await sb.rpc("wms_claim_sync_produto", {
    p_produto_id: produtoId,
  });
  if (errClaim) throw errClaim;
  if (!reclamou) {
    throw new SyncJaEmAndamentoError(
      "Esse produto já está sincronizando. Espere terminar antes de tentar de novo.",
    );
  }
```

Envolver o restante do corpo (da query de mapeamento até o fim) num `try { ... } finally { await sb.rpc("wms_release_sync_produto", { p_produto_id: produtoId }); }`. Concretamente: após o claim, abrir `try {` antes da `let mapeamentoQuery = ...`, e fechar com:

```ts
  } finally {
    const { error: errRel } = await sb.rpc("wms_release_sync_produto", {
      p_produto_id: produtoId,
    });
    if (errRel) {
      logger.warn("wms.sync", "falha ao liberar lease de sync", {
        produtoId,
        erro: errRel.message,
      });
    }
  }
```

> Nota: o `throw` de `SyncSemMapeamentoError` (Task 1.3) agora cai dentro do `try` — o `finally` libera o lease, correto. A recusa por `SyncJaEmAndamentoError` acontece **antes** do `try`, então **não** libera o lease da sync que está rodando (correto — quem reclamou é que libera).

Na rota `src/app/api/wms/produtos/[id]/sync/route.ts`, importar e mapear:

```ts
import {
  sincronizarProduto,
  SyncSemMapeamentoError,
  SyncJaEmAndamentoError,
} from "@/lib/wms/sync-tiny";
```

e no `catch`, antes do `wmsErrorResponse`:

```ts
    if (e instanceof SyncSemMapeamentoError || e instanceof SyncJaEmAndamentoError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
```

(substitui o `if (e instanceof SyncSemMapeamentoError)` da Task 1.3 por este `||`.)

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration`
      Expected: PASS (`fulfilled=1`, `rejected=1` com /sincroniz/i; `sincronizando_em` null após release). Re-rodar a suite de determinismo (Task 1.4) e a `npm test -- src/lib/wms/sync-tiny.test.ts` pra garantir no-regress.

> Nota: os mocks unit da Task 1.2/1.3 precisam stubbar `sb.rpc`. Adicionar `rpc: async () => ({ data: true, error: null })` ao objeto retornado por `makeSb` em `src/lib/wms/sync-tiny.test.ts` (claim sempre concede, release no-op) — caso contrário os testes unit quebram com `sb.rpc is not a function`. Aplicar este ajuste no `makeSb` ao implementar a Task 1.5.

- [ ] **Step 5 — Commit.**
```bash
git add supabase/migrations/20260607b_produto_sincronizando_em.sql \
        src/lib/wms/sync-tiny.ts src/app/api/wms/produtos/[id]/sync/route.ts \
        src/lib/wms/sync-tiny.test.ts test/integration/sync-tiny-claim.test.ts
git commit -m "fix(wms): claim atômico anti-duplo-clique na sync de produto (P176)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — erros-conhecidos.yaml** (grep `P176`):
```yaml
- id: P176
  date: 2026-06-05
  source: raio-x-fase-6e
  category: infrastructure
  message: "Duplo-clique no botão sincronizar rodava 2 syncs em paralelo; delete+insert da composição de kit corrompia componentes"
  cause: "sincronizarProduto sem serialização por produto; sem coluna/flag de claim"
  fix: "coluna sincronizando_em + RPC wms_claim_sync_produto (lease 5min) / wms_release_sync_produto; 2ª sync recusada com 409"
  files: [src/lib/wms/sync-tiny.ts, src/app/api/wms/produtos/[id]/sync/route.ts, supabase/migrations/20260607b_produto_sincronizando_em.sql]
  tags: [sync-tiny, atomic-claim, concurrency, kit]
```

---

## Verificação final do PR

- [ ] `npm test -- src/lib/wms/sync-tiny.test.ts` → todas as suites unit PASS.
- [ ] `npm run test:integration` → `sync-tiny-determinismo` + `sync-tiny-claim` PASS (serializado vs staging).
- [ ] `npm run scenarios -- :only 98-sync-sem-mapeamento` → PASS.
- [ ] `npm run lint` → sem erros novos.
- [ ] Atualizar `docs/database-schema.md` (colunas `siso_produto_empresas.sync_preferida`, `siso_produtos.sincronizando_em`) e `docs/api-reference-complete.md` (POST `/produtos/[id]/sync` agora retorna 409 `{error}` em falta de mapeamento / sync em andamento) no mesmo commit final.
- [ ] Confirmar as 8 entradas em `erros-conhecidos.yaml` (P097, P169, P117 [cobrindo P118/P171/P098], P170, P176).
