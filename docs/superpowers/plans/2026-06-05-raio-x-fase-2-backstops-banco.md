# Raio-X Fase 2 — Backstops estruturais no banco Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal:** Instalar os backstops estruturais de banco (UNIQUE/CHECK parciais, trigger de invariante, guard de custo na RPC do ledger, reversão de custo médio no estorno) e os fixes de aplicação que dependem deles, para que nenhuma corrida de duplo-clique/reenvio consiga duplicar estorno, recebimento, sessão de inventário, fornecedor preferencial ou fornecedor de prefixo; nenhuma entrada de custo zero zere o custo médio; nenhum estorno deixe o custo médio inflado; e o dashboard de cobertura volte a ler a MV no shape 3D. Cobre os 12 P-ids: P106, P124, P125, P055, P120, P099, P109, P108, P110, P104, P123, P128.

**Architecture:** SISO/WMS — Next.js 16 (App Router, `output: "standalone"`) + Supabase (service role, RLS bypass). Todo backend em `/api/wms/**`. Ledger 3D imutável: `wms_inserir_movimentacao(...)` é o único caminho de escrita (lock pessimista `FOR UPDATE`, recalcula `siso_custo_medio`, atualiza cache `siso_estoque`). Backstops estruturais são UNIQUE INDEX parciais e triggers em Postgres — defesa em profundidade sob a lógica de código existente (que é TOCTOU sob concorrência). supabase-js não tem transação multi-statement no cliente, então a atomicidade dos guards de custo vive dentro da própria RPC plpgsql. Erros `23505` (unique_violation) chegam ao TS como `error.code === "23505"` e devem ser tratados como no-op idempotente (recebimento/estorno) ou 409 amigável (fornecedor/sessão).

**Tech Stack:** TypeScript 5.9 strict · PostgreSQL (plpgsql RPCs + partial unique indexes + triggers) · Supabase JS · Vitest (unit `src/**/*.test.ts` + `.test.tsx`; integration `test/integration/**/*.test.ts` serializado contra staging via `vitest.integration.config.ts`, trunca operacionais no `globalSetup`) · Scenarios E2E HTTP (`scripts/wms/cenarios/catalogo/NN-*.ts`). Migrations: arquivo em `supabase/migrations/YYYYMMDD_descricao.sql` aplicado via `mcp__supabase__apply_migration` no project **`ehbxpbeijofxtsbezwxd`** (staging).

> **Ordem dos PRs:** quick wins sem deps primeiro (PR1 P106, PR3 P055, PR7 P123, PR8 P128, PR2 P124/P125), depois os de blast alto e deps (PR4 P120, PR5 P099/P109, PR6 P108→P110→P104). Deps internas: P125→P124 (mesma migration), P109→P099 (mesmo índice), P110→P108 (mesma RPC), P104→P108.

> **Convenções de teste anco­radas no repo:**
> - Integration usa `createServiceClient()`, resolve galpão `CWB` por `nome` e loc `A-01-01` por `codigo`, insere produto novo por SKU randômico (ver `test/integration/ledger-rpc.test.ts`). Arquivos vão em `test/integration/**/*.test.ts` (NÃO em `tests/integration/` nem `src/lib/wms/*.integration.test.ts` — esses paths citados nos achados não existem; o config inclui só `test/integration/**/*.test.ts`).
> - Unit `.test.ts`/`.test.tsx` em `src/**` (config inclui `src/**/*.test.tsx`; `@testing-library/react` e `happy-dom` instalados; ver `src/components/wms/home/exceptions/__tests__/cards.test.tsx`).
> - Scenarios: `export default { nome, descricao, tags, setup, run, assertEsperado } satisfies Cenario<Setup>` + bloco `runStandalone` no fim (ver `scripts/wms/cenarios/catalogo/81-receber-oc-destrava-pedido.ts`). Helpers em `Ctx` (`scripts/wms/cenarios/_harness/types.ts`): `criarProduto`, `semearSaldo`, `http.post`, `assertCustoMedio`, etc.

---

## PR 1: UNIQUE estorno único por estorno_de + 23505 idempotente [P106]

> Promove o índice não-único `idx_mov_estorno` (foundation `20260508_wms_foundation.sql:156`) a UNIQUE parcial, garantindo no banco que cada mov só pode ser estornada uma vez. O guard de código atual (`ledger.ts:379-384`) é TOCTOU sob concorrência. `estornarMovimentacao` passa a tratar `23505` como "já estornada" (idempotente).

### Task 1.1: Migration — promover idx_mov_estorno a UNIQUE parcial

**Files:**
- Create: `supabase/migrations/20260607_mov_estorno_unique.sql`
- Test: `test/integration/estorno-duplo-constraint.test.ts`

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/estorno-duplo-constraint.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let produtoId: string;
let galpaoId: string;
let locId: string;
let movEId: string;
const SKU = `TEST-ESTORNO-UQ-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "Estorno UNIQUE test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  // entrada base de 10 un
  const { data: mov } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
    p_origem_id: null, p_custo_unitario: 5, p_motivo: "base estorno",
  });
  movEId = mov as unknown as string;
});

describe("UNIQUE parcial uq_mov_estorno_unico", () => {
  it("aceita o 1º estorno e rejeita o 2º com 23505", async () => {
    // 1º estorno: S de 10 com estorno_de=movEId
    const { error: e1 } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 10, p_origem_tipo: "estorno",
      p_origem_id: movEId, p_custo_unitario: null, p_estorno_de: movEId,
      p_motivo: "estorno 1",
    });
    expect(e1).toBeNull();

    // 2º estorno do MESMO movEId — deve violar o unique parcial
    const { error: e2 } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 10, p_origem_tipo: "estorno",
      p_origem_id: movEId, p_custo_unitario: null, p_estorno_de: movEId,
      p_motivo: "estorno 2",
    });
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");

    // saldo anulou a entrada exatamente uma vez: 10 - 10 = 0
    const { data: est } = await sb
      .from("siso_estoque").select("saldo")
      .eq("produto_id", produtoId).eq("galpao_id", galpaoId).eq("localizacao_id", locId)
      .single();
    expect(Number(est?.saldo)).toBe(0);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm run test:integration -- estorno-duplo-constraint`
  Expected: FAIL com `expected null not to be null` (o 2º estorno hoje insere uma 2ª mov S porque o índice é só comum — `e2` vem `null`).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607_mov_estorno_unique.sql`:

```sql
-- P106 — promove idx_mov_estorno (não-único, foundation 20260508:156) a UNIQUE parcial.
-- Garante no banco que cada mov só pode ser estornada uma vez. O guard de código
-- em ledger.ts (estornarMovimentacao) é TOCTOU sob concorrência; este é o backstop.
--
-- Pré-condição: nenhum estorno_de duplicado já existente (cleanup retroativo é P6).
-- Se houver, o CREATE UNIQUE falha com "could not create unique index" — proteção, não bug.

BEGIN;

DROP INDEX IF EXISTS idx_mov_estorno;

CREATE UNIQUE INDEX uq_mov_estorno_unico
  ON siso_movimentacoes(estorno_de)
  WHERE estorno_de IS NOT NULL;

COMMENT ON INDEX uq_mov_estorno_unico IS
  'P106: cada movimentação só pode ser estornada uma vez (UNIQUE parcial em estorno_de).';

COMMIT;
```

- [ ] **Step 3b — Aplicar a migration.** Via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `mov_estorno_unique`, com o SQL acima.

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm run test:integration -- estorno-duplo-constraint`
  Expected: PASS (`e2.code === "23505"`, saldo final = 0).

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260607_mov_estorno_unique.sql test/integration/estorno-duplo-constraint.test.ts && git commit -m "feat(wms): UNIQUE parcial uq_mov_estorno_unico — estorno único por mov [P106]"`

### Task 1.2: estornarMovimentacao trata 23505 como idempotente

**Files:**
- Modify: `src/lib/wms/ledger.ts:399-416` (corpo de `estornarMovimentacao`)
- Test: `src/lib/wms/estorno-idempotente.test.ts`

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `src/lib/wms/estorno-idempotente.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock do supabase-server pra simular: original existe, nenhum estorno prévio
// detectado pelo SELECT (janela TOCTOU), mas o INSERT do estorno bate no 23505.
const movOriginal = {
  id: "11111111-1111-1111-1111-111111111111",
  produto_id: "22222222-2222-2222-2222-222222222222",
  galpao_id: "33333333-3333-3333-3333-333333333333",
  localizacao_id: "44444444-4444-4444-4444-444444444444",
  tipo: "E", quantidade: 10, estorno_de: null, qty_estornada: 0,
  origem_tipo: "inventario_inicial",
};
const estornoExistente = { id: "99999999-9999-9999-9999-999999999999", ...movOriginal, estorno_de: movOriginal.id };

let rpcShouldFail23505 = true;

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, val: string) => ({
          single: async () => ({ data: movOriginal }),
          maybeSingle: async () =>
            // 1ª chamada (guard pré-RPC) não acha estorno; 2ª (recovery pós-23505) acha
            ({ data: rpcShouldFail23505 ? null : estornoExistente }),
        }),
      }),
      update: () => ({ eq: async () => ({}) }),
    }),
    rpc: async () => {
      if (rpcShouldFail23505) {
        return { data: null, error: { code: "23505", message: "duplicate key uq_mov_estorno_unico" } };
      }
      return { data: estornoExistente.id, error: null };
    },
  };
  return { createServiceClient: () => client };
});

import { estornarMovimentacao } from "./ledger";

describe("estornarMovimentacao — 23505 idempotente", () => {
  beforeEach(() => { rpcShouldFail23505 = true; });

  it("quando o INSERT do estorno colide no unique, retorna a mov de estorno existente (não propaga erro)", async () => {
    const r = await estornarMovimentacao({ mov_id: movOriginal.id, usuario_id: "55555555-5555-5555-5555-555555555555" });
    expect(r.id).toBe(estornoExistente.id);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm test -- estorno-idempotente`
  Expected: FAIL — hoje `inserirMovimentacao` faz `throw error` no `23505` (ledger.ts:203-206), então a promise rejeita em vez de retornar a mov existente.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/wms/ledger.ts`, substituir o `return inserirMovimentacao({...})` final de `estornarMovimentacao` (linhas 399-416) por um bloco try/catch que reconhece o `23505`:

```ts
  try {
    return await inserirMovimentacao({
      tripla: {
        produto_id: original.produto_id,
        galpao_id: original.galpao_id,
        localizacao_id: original.localizacao_id,
      },
      tipo: tipoInverso,
      qty: Number(original.quantidade),
      origem_tipo: "estorno",
      origem_id: input.mov_id,
      origem_detalhes: {
        estorno_de: input.mov_id,
        mov_original_origem: original.origem_tipo,
      },
      motivo: input.motivo ?? `Estorno de mov ${input.mov_id}`,
      usuario_id: input.usuario_id,
      estorno_de: input.mov_id,
    });
  } catch (err) {
    // P106: o UNIQUE parcial uq_mov_estorno_unico rejeitou a 2ª tentativa de
    // estornar a mesma mov (corrida que venceu o guard SELECT acima). Tratamos
    // como idempotente: recarrega e devolve o estorno já existente.
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      const { data: jaEstornada } = await sb
        .from("siso_movimentacoes")
        .select("*")
        .eq("estorno_de", input.mov_id)
        .maybeSingle();
      if (jaEstornada) {
        logger.warn("wms.ledger", "estorno duplicado absorvido pelo UNIQUE (idempotente)", {
          mov_id: input.mov_id,
          estorno_id: (jaEstornada as { id: string }).id,
        });
        return jaEstornada as unknown as Movimentacao;
      }
    }
    throw err;
  }
```

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm test -- estorno-idempotente`
  Expected: PASS (retorna `estornoExistente.id`).

- [ ] **Step 5 — Adicionar entrada em `erros-conhecidos.yaml`.**

```yaml
  - id: wms-estorno-duplo-corrida
    date: "2026-06-05"
    source: wms.ledger.estornar
    category: database
    message: "2 estornos concorrentes da mesma mov criavam 2 movs S — saldo anulava 2x"
    cause: >
      Guard contra estorno duplo vivia só em estornarMovimentacao (SELECT estorno_de
      antes do INSERT) — TOCTOU sob concorrência. idx_mov_estorno era índice comum.
    fix: >
      Promovido a UNIQUE parcial (uq_mov_estorno_unico em estorno_de WHERE NOT NULL).
      estornarMovimentacao trata 23505 como idempotente: recarrega e devolve o estorno
      existente em vez de propagar erro.
    files:
      - supabase/migrations/20260607_mov_estorno_unique.sql
      - src/lib/wms/ledger.ts
    tags: [estorno, unique, idempotencia, ledger, concorrencia]
```

- [ ] **Step 6 — COMMIT.** `git add src/lib/wms/ledger.ts src/lib/wms/estorno-idempotente.test.ts erros-conhecidos.yaml && git commit -m "fix(wms): estornarMovimentacao absorve 23505 como idempotente [P106]"`

---

## PR 2: UNIQUE parcial fornecedor preferencial por produto + botão disabled [P124, P125]

> A migration do P124 (UNIQUE INDEX parcial `produto_id WHERE preferencial AND ativo`) é o backstop de banco; P125 deps=[P124] reusa a mesma migration e só adiciona `disabled` no botão "Tornar preferencial". A rota PATCH (`produto-fornecedores/[id]/route.ts:66-84`) já despromove-antes-de-promover (ordem correta pro unique parcial) e mapeia `23505` a 409 amigável.

### Task 2.1: Migration — UNIQUE parcial em produto_fornecedores preferencial

**Files:**
- Create: `supabase/migrations/20260607_pf_preferencial_unique.sql`
- Test: `test/integration/pf-preferencial-unique.test.ts`

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/pf-preferencial-unique.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let produtoId: string;
let f1Id: string;
let f2Id: string;
const SKU = `TEST-PF-UQ-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: p } = await sb
    .from("siso_produtos").insert({ sku: SKU, descricao: "PF UQ test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  const { data: f1 } = await sb
    .from("siso_fornecedores").insert({ nome: `FORN-A-${SKU}` }).select("id").single();
  f1Id = f1!.id;
  const { data: f2 } = await sb
    .from("siso_fornecedores").insert({ nome: `FORN-B-${SKU}` }).select("id").single();
  f2Id = f2!.id;
});

describe("UNIQUE parcial idx_pf_preferencial", () => {
  it("rejeita 2 vínculos preferencial+ativo do mesmo produto com 23505", async () => {
    const { error: e1 } = await sb.from("siso_produto_fornecedores").insert({
      produto_id: produtoId, fornecedor_id: f1Id, preferencial: true, ativo: true,
    });
    expect(e1).toBeNull();

    const { error: e2 } = await sb.from("siso_produto_fornecedores").insert({
      produto_id: produtoId, fornecedor_id: f2Id, preferencial: true, ativo: true,
    });
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm run test:integration -- pf-preferencial-unique`
  Expected: FAIL — hoje `idx_pf_preferencial` é índice comum (`20260522_wms_roteamento.sql:45`), então o 2º insert passa (`e2` vem `null`).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607_pf_preferencial_unique.sql`:

```sql
-- P124/P125 — converte idx_pf_preferencial (não-único, 20260522_wms_roteamento.sql:45)
-- em UNIQUE parcial: no máximo 1 fornecedor preferencial ativo por produto.
-- Backstop de banco contra a corrida da troca em 2 statements (PATCH despromove+promove).
--
-- Pré-dedup: se já existe produto com >1 preferencial ativo, o CREATE UNIQUE falha.
-- Limpa antes mantendo só o vínculo mais recente como preferencial.

BEGIN;

-- Dedup defensivo: para produtos com >1 preferencial ativo, mantém só o
-- mais recente (criado_em DESC) e despromove os demais.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY produto_id ORDER BY criado_em DESC, id DESC) AS rn
  FROM siso_produto_fornecedores
  WHERE preferencial = true AND ativo = true
)
UPDATE siso_produto_fornecedores pf
   SET preferencial = false
  FROM ranked r
 WHERE pf.id = r.id AND r.rn > 1;

DROP INDEX IF EXISTS idx_pf_preferencial;

CREATE UNIQUE INDEX idx_pf_preferencial
  ON siso_produto_fornecedores(produto_id)
  WHERE preferencial AND ativo;

COMMENT ON INDEX idx_pf_preferencial IS
  'P124: no máximo 1 fornecedor preferencial ativo por produto (UNIQUE parcial).';

COMMIT;
```

- [ ] **Step 3b — Aplicar a migration.** Via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `pf_preferencial_unique`.

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm run test:integration -- pf-preferencial-unique`
  Expected: PASS (`e2.code === "23505"`).

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260607_pf_preferencial_unique.sql test/integration/pf-preferencial-unique.test.ts && git commit -m "feat(wms): UNIQUE parcial idx_pf_preferencial — 1 preferencial por produto [P124]"`

### Task 2.2: PATCH mapeia 23505 a 409 amigável

**Files:**
- Modify: `src/app/api/wms/produto-fornecedores/[id]/route.ts:85-93` (bloco `if (error)`)
- Test: `src/app/api/wms/produto-fornecedores/produto-fornecedores-patch-409.test.ts`

> Nota: a rota hoje chama `wmsErrorResponse` no catch do `error` com status default 500 (e `wmsErrorResponse` mascara 5xx pra `internal_error`). O gap é a UX: um 23505 do `idx_pf_preferencial` (Task 2.1) vira 500 genérico em vez de 409 acionável. Mudança cirúrgica: detectar `23505` e responder 409 ANTES do `wmsErrorResponse`. O teste mocka `requireAdmin` (ok) + `createServiceClient` pra simular o `.update().eq().select().single()` retornando `error.code='23505'`, e verifica o status 409 da `Response`.

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `src/app/api/wms/produto-fornecedores/produto-fornecedores-patch-409.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// requireAdmin sempre ok (não testamos auth aqui).
vi.mock("@/lib/wms/auth", () => ({
  requireAdmin: async () => ({ ok: true, user: { id: "u1" } }),
}));

// Simula: SELECT do produto_id (despromove) OK; UPDATE final retorna 23505.
vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: () => ({
      // .select("produto_id").eq("id", id).single()  → despromove pre-step
      // .update(...).eq("id", id).select().single()  → update final (23505)
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { produto_id: "prod-1" }, error: null }),
        }),
      }),
      update: () => ({
        eq: () => ({
          // a 1ª update (despromove) NÃO tem .select() encadeado → resolve direto;
          // a 2ª (update final) tem .select().single() → 23505.
          select: () => ({
            single: async () => ({
              data: null,
              error: { code: "23505", message: "duplicate key idx_pf_preferencial" },
            }),
          }),
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        }),
      }),
    }),
  };
  return { createServiceClient: () => client };
});

import { PATCH } from "./[id]/route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/produto-fornecedores/pf-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("PATCH produto-fornecedores — 23505 vira 409", () => {
  it("responde 409 quando o update bate no unique idx_pf_preferencial", async () => {
    const res = await PATCH(makeReq({ preferencial: true }), {
      params: Promise.resolve({ id: "pf-1" }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(String(json.error)).toMatch(/preferencial/i);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm test -- produto-fornecedores-patch-409`
  Expected: FAIL — hoje o `if (error)` cai direto no `wmsErrorResponse`, que mascara o 23505 (5xx → `internal_error`) e responde **500**, não 409.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/app/api/wms/produto-fornecedores/[id]/route.ts`, no bloco `if (error) {` (linha 85), inserir o mapeamento antes do `wmsErrorResponse`:

```ts
  if (error) {
    // P125: violação do UNIQUE parcial idx_pf_preferencial (2 cliques marcando
    // preferenciais diferentes em corrida) → 409 amigável em vez de 500 genérico.
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "Já existe outro fornecedor preferencial ativo para este produto. Recarregue e tente de novo." },
        { status: 409 },
      );
    }
    return wmsErrorResponse({
      source: "wms.produto-fornecedores.patch",
      error,
      requestPath: `/api/wms/produto-fornecedores/${id}`,
      requestMethod: "PATCH",
      metadata: { id },
    });
  }
```

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm test -- produto-fornecedores-patch-409`
  Expected: PASS (status 409, mensagem com "preferencial"). Rodar também `npm run lint && npx tsc --noEmit` (sem erros de tipo; `error.code` é narrow-cast).

- [ ] **Step 5 — COMMIT.** `git add "src/app/api/wms/produto-fornecedores/[id]/route.ts" src/app/api/wms/produto-fornecedores/produto-fornecedores-patch-409.test.ts && git commit -m "fix(wms): PATCH produto-fornecedores mapeia 23505 a 409 amigável [P125]"`

### Task 2.3: Botão "Tornar preferencial" disabled durante mutation

**Files:**
- Modify: `src/components/wms/produto-drawer.tsx:1019` (passa `isPending` ao card), `:1121-1138` (props do `FornecedorEditCard`), `:1172-1180` (botão `disabled`)
- Test: `src/components/wms/__tests__/produto-drawer-preferencial.test.tsx`

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `src/components/wms/__tests__/produto-drawer-preferencial.test.tsx`. Como o componente real depende de muito contexto (React Query, drawer), o teste exercita só o `FornecedorEditCard` exportado. Primeiro, garantir que `FornecedorEditCard` seja exportável: ver Step 3. Teste:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FornecedorEditCard } from "../produto-drawer";

vi.mock("../ui/wms-ui", async (orig) => {
  const real = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...real, Icon: () => <span /> };
});

const row = {
  id: "f1",
  fornecedor: { nome: "Forn A", prefixo_sku: "AA" },
  preferencial: false,
  codigo_fornecedor: null,
  custo_unitario: null,
  qty_minima_pedido: 1,
  multiplo_compra: 1,
  lead_time_dias_medio: 14,
} as never;

describe("FornecedorEditCard — botão preferencial", () => {
  it("não dispara onPatch num 2º clique quando mutationPending=true", () => {
    const onPatch = vi.fn();
    render(<FornecedorEditCard row={row} onPatch={onPatch} onRemove={() => {}} mutationPending />);
    const btn = screen.getByTitle("Marcar como preferencial");
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("dispara onPatch quando mutationPending=false", () => {
    const onPatch = vi.fn();
    render(<FornecedorEditCard row={row} onPatch={onPatch} onRemove={() => {}} mutationPending={false} />);
    fireEvent.click(screen.getByTitle("Marcar como preferencial"));
    expect(onPatch).toHaveBeenCalledWith({ preferencial: true });
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm test -- produto-drawer-preferencial`
  Expected: FAIL — `FornecedorEditCard` não é exportado (import falha) e não aceita `mutationPending`; o botão não tem `disabled`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/components/wms/produto-drawer.tsx`:

  (a) Exportar o componente — trocar `function FornecedorEditCard({` (linha 1121) por `export function FornecedorEditCard({`.

  (b) Adicionar a prop `mutationPending` na assinatura (após `onRemove: () => void;`, dentro do objeto de props na linha ~1137):

```tsx
  onRemove: () => void;
  mutationPending?: boolean;
}) {
```

  (c) No botão "Tornar preferencial" (linha 1173-1179), adicionar `disabled`:

```tsx
            <button
              className="wms-btn wms-btn-sm wms-btn-ghost"
              onClick={() => onPatch({ preferencial: true })}
              disabled={mutationPending}
              title="Marcar como preferencial"
            >
              <Icon name="check" size={11} /> Tornar preferencial
            </button>
```

  (d) Passar `mutationPending` no call-site (linha 1016-1025):

```tsx
          <FornecedorEditCard
            key={f.id}
            row={f}
            onPatch={(patch) => atualizar.mutate({ id: f.id, patch })}
            mutationPending={atualizar.isPending}
            onRemove={() => {
              if (confirm(`Remover fornecedor ${f.fornecedor?.nome}?`)) {
                remover.mutate(f.id);
              }
            }}
          />
```

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm test -- produto-drawer-preferencial`
  Expected: PASS (botão `disabled` quando `mutationPending`, dispara quando não).

- [ ] **Step 5 — Adicionar entrada em `erros-conhecidos.yaml`.**

```yaml
  - id: wms-fornecedor-preferencial-duplo
    date: "2026-06-05"
    source: wms.produto-fornecedores
    category: business_logic
    message: "Marcar preferencial em corrida deixava 0 ou 2 preferenciais por produto"
    cause: >
      idx_pf_preferencial era índice comum; troca feita em 2 UPDATEs não-atômicos
      (despromove+promove) na rota PATCH; botão sem disabled permitia duplo-clique.
    fix: >
      idx_pf_preferencial vira UNIQUE parcial (backstop banco); PATCH mapeia 23505 a
      409; botão "Tornar preferencial" disabled durante a mutation.
    files:
      - supabase/migrations/20260607_pf_preferencial_unique.sql
      - src/app/api/wms/produto-fornecedores/[id]/route.ts
      - src/components/wms/produto-drawer.tsx
    tags: [fornecedor, preferencial, unique, frontend, idempotencia]
```

- [ ] **Step 6 — COMMIT.** `git add src/components/wms/produto-drawer.tsx src/components/wms/__tests__/produto-drawer-preferencial.test.tsx erros-conhecidos.yaml && git commit -m "fix(wms): botão Tornar preferencial disabled durante mutation [P125]"`

---

## PR 3: UNIQUE parcial sessão de inventário por (galpão, dia) + 409 amigável [P055]

> O frontend já desabilita o botão em `criar.isPending` (`inventario/page.tsx:338`); falta a parte VINCULANTE da nota: o banco rejeitar sessão duplicada por galpão+dia. `programada_para` nunca é populado (`criarSessao` não seta), então a data viável é `criado_em::date`. Índice parcial precisa excluir `cancelada` e `continua=true` (essa já tem seu `uniq_sessao_continua_galpao`).

### Task 3.1: Migration — UNIQUE parcial sessão por (galpao, criado_em::date)

**Files:**
- Create: `supabase/migrations/20260607_inv_sessao_unique_galpao_dia.sql`
- Test: `test/integration/inventario-sessao-unique.test.ts`

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/inventario-sessao-unique.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let galpaoId: string;
let userId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").limit(1).single();
  userId = u!.id;
});

describe("UNIQUE parcial uq_inv_sessao_galpao_dia", () => {
  it("rejeita 2ª sessão cycle_count no mesmo galpão+dia com 23505", async () => {
    const base = {
      tipo: "cycle_count", galpao_id: galpaoId, modo_contagem: "blind",
      criada_por: userId, continua: false, status: "planejada",
    };
    const { error: e1 } = await sb.from("siso_inventario_sessoes").insert(base);
    expect(e1).toBeNull();

    const { error: e2 } = await sb.from("siso_inventario_sessoes").insert(base);
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");
  });

  it("sessão cancelada anterior não bloqueia nova no mesmo dia", async () => {
    const { data: g2 } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
    const sp = g2!.id;
    await sb.from("siso_inventario_sessoes").insert({
      tipo: "cycle_count", galpao_id: sp, modo_contagem: "blind",
      criada_por: userId, continua: false, status: "cancelada",
    });
    const { error } = await sb.from("siso_inventario_sessoes").insert({
      tipo: "cycle_count", galpao_id: sp, modo_contagem: "blind",
      criada_por: userId, continua: false, status: "planejada",
    });
    expect(error).toBeNull();
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm run test:integration -- inventario-sessao-unique`
  Expected: FAIL — hoje `criarSessao` faz INSERT simples sem unique por (galpao, dia); `e2` vem `null`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607_inv_sessao_unique_galpao_dia.sql`:

```sql
-- P055 — no máximo 1 sessão de inventário por (galpão, dia), excluindo as
-- canceladas e a sessão operacional contínua (que já tem uniq_sessao_continua_galpao).
-- Data = criado_em::date (programada_para nunca é setado pelo fluxo atual).

BEGIN;

CREATE UNIQUE INDEX uq_inv_sessao_galpao_dia
  ON siso_inventario_sessoes (galpao_id, (criado_em::date))
  WHERE status <> 'cancelada' AND continua = false;

COMMENT ON INDEX uq_inv_sessao_galpao_dia IS
  'P055: 1 sessão de inventário (não-contínua, não-cancelada) por galpão por dia.';

COMMIT;
```

- [ ] **Step 3b — Aplicar a migration.** Via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `inv_sessao_unique_galpao_dia`.

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm run test:integration -- inventario-sessao-unique`
  Expected: PASS (`e2.code === "23505"`; cancelada não bloqueia).

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260607_inv_sessao_unique_galpao_dia.sql test/integration/inventario-sessao-unique.test.ts && git commit -m "feat(wms): UNIQUE parcial sessão de inventário por (galpão, dia) [P055]"`

### Task 3.2: criarSessao + rota traduzem 23505 em domínio/409

**Files:**
- Modify: `src/lib/wms/inventario.ts:66` (catch do INSERT da sessão), `src/app/api/wms/inventario/route.ts:81-90` (status 409)
- Test: `src/lib/wms/criar-sessao-duplicada.test.ts` (RED da lib) + `src/app/api/wms/inventario/inventario-sessao-409.test.ts` (RED da ROTA — asserta status 409 + mensagem revelada)

> **Nota (gap fechado nesta revisão):** a mudança de produção na ROTA (`route.ts:81-90`, novo branch `status: isDuplicada ? 409 : 400`) precisa do SEU próprio RED — análogo a PR2 Task 2.2 e PR6 Task 6.3, que assertam o `res.status` da `Response`. O unit de lib abaixo só prova que `criarSessao` LANÇA a Error de domínio; ele nunca exercita o mapeamento HTTP. Por isso o Step 1b cria um teste de rota que mocka `requireWarehouseAccess` (ok) + `criarSessao` lançando a Error de domínio, e asserta que a `Response` sai **409** (não 400/500). Como o branch passa `error: e` (a Error) ao `wmsErrorResponse` com status 409, e `wmsErrorResponse` revela `message` em qualquer 4xx (`api-errors.ts:53,69` — `isClientError` ⇒ `clientMessage = errMsg`), o mesmo teste confirma que o corpo expõe a mensagem de domínio (e não `internal_error`).

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA (RED da lib).** Criar `src/lib/wms/criar-sessao-duplicada.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({
            data: null,
            error: { code: "23505", message: "duplicate key uq_inv_sessao_galpao_dia" },
          }),
        }),
      }),
    }),
  };
  return { createServiceClient: () => client };
});

import { criarSessao } from "./inventario";

describe("criarSessao — sessão duplicada por galpão+dia", () => {
  it("traduz 23505 em erro de domínio legível", async () => {
    await expect(
      criarSessao({
        tipo: "cycle_count", galpao_id: "g1", criada_por: "u1",
        localizacoes: [{ localizacao_id: "loc1" }],
      } as never),
    ).rejects.toThrow(/já existe sessão de inventário para este galpão hoje/i);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm test -- criar-sessao-duplicada`
  Expected: FAIL — hoje `criarSessao` faz `if (error) throw error` (inventario.ts:66), propagando o PostgrestError cru (mensagem "duplicate key...").

- [ ] **Step 1b — ESCREVER O TESTE QUE FALHA (RED da ROTA).** Criar `src/app/api/wms/inventario/inventario-sessao-409.test.ts` — mocka `requireWarehouseAccess` (ok) e `criarSessao` lançando a Error de domínio, e asserta que a rota POST devolve **409** com a mensagem de domínio revelada (não `internal_error`):

```ts
import { describe, it, expect, vi } from "vitest";

// A rota usa requireWarehouseAccess (verificado em inventario/route.ts:49); mockamos ok.
vi.mock("@/lib/wms/auth", () => ({
  requireAuth: async () => ({ ok: true, user: { id: "u1" } }),
  requireWarehouseAccess: async () => ({ ok: true, user: { id: "u1" } }),
}));

// criarSessao lança a MESMA Error de domínio que o Step 3 fará (P055).
vi.mock("@/lib/wms/inventario", () => ({
  criarSessao: vi.fn(async () => {
    throw new Error("Já existe sessão de inventário para este galpão hoje");
  }),
}));

import { POST } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/inventario", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/wms/inventario — sessão duplicada vira 409", () => {
  it("responde 409 (não 400/500) e REVELA a mensagem de domínio quando criarSessao lança o erro de duplicada", async () => {
    const res = await POST(
      makeReq({
        tipo: "cycle_count",
        galpao_id: "g1",
        localizacoes: [{ localizacao_id: "loc1" }],
      }) as never,
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    // wmsErrorResponse revela message em 4xx → não pode vir "internal_error".
    expect(String(json.error)).not.toBe("internal_error");
    expect(String(json.error)).toMatch(/já existe sessão de inventário para este galpão hoje/i);
  });
});
```

- [ ] **Step 2b — RODAR e ver falhar.** Comando: `npm test -- inventario-sessao-409`
  Expected: FAIL — hoje o catch do POST (`route.ts:81-90`) passa `status: 400` fixo, então `res.status === 400` (não 409). O `expect(res.status).toBe(409)` falha.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/wms/inventario.ts`, trocar `if (error) throw error;` (linha 66) por:

```ts
  if (error) {
    // P055: UNIQUE parcial uq_inv_sessao_galpao_dia — 2ª sessão no mesmo dia.
    if ((error as { code?: string }).code === "23505") {
      throw new Error("Já existe sessão de inventário para este galpão hoje");
    }
    throw error;
  }
```

  E em `src/app/api/wms/inventario/route.ts`, no catch do POST (linha 81-90), detectar a mensagem e responder 409:

```ts
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isDuplicada = /já existe sessão de inventário para este galpão hoje/i.test(msg);
    return wmsErrorResponse({
      source: "wms.inventario.criar",
      error: e,
      status: isDuplicada ? 409 : 400,
      requestPath: "/api/wms/inventario",
      requestMethod: "POST",
      metadata: { tipo: body.tipo, galpao_id: body.galpao_id },
    });
  }
```

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm test -- criar-sessao-duplicada` (RED da lib agora GREEN).
  Expected: PASS (mensagem de domínio).

- [ ] **Step 4b — RODAR o RED da ROTA e ver passar.** Comando: `npm test -- inventario-sessao-409`
  Expected: PASS (`res.status === 409`, corpo com "já existe sessão de inventário para este galpão hoje" — não `internal_error`). Confirma que o mapeamento 409 é exercitado end-to-end (não só a Error da lib).

- [ ] **Step 5 — Adicionar entrada em `erros-conhecidos.yaml`.**

```yaml
  - id: wms-inventario-sessao-duplicada
    date: "2026-06-05"
    source: wms.inventario.criar
    category: business_logic
    message: "Duplo clique / 2 requests criavam 2 sessões de inventário no mesmo galpão+dia"
    cause: >
      criarSessao fazia INSERT simples sem constraint de unicidade por (galpao, dia);
      o frontend só tinha o guard isPending (perdível em corrida).
    fix: >
      UNIQUE parcial uq_inv_sessao_galpao_dia (galpao_id, criado_em::date) excluindo
      cancelada e continua. criarSessao traduz 23505 em erro de domínio; rota responde 409.
    files:
      - supabase/migrations/20260607_inv_sessao_unique_galpao_dia.sql
      - src/lib/wms/inventario.ts
      - src/app/api/wms/inventario/route.ts
    tags: [inventario, sessao, unique, idempotencia, 409]
```

- [ ] **Step 6 — COMMIT.** `git add src/lib/wms/inventario.ts src/app/api/wms/inventario/route.ts src/lib/wms/criar-sessao-duplicada.test.ts src/app/api/wms/inventario/inventario-sessao-409.test.ts erros-conhecidos.yaml && git commit -m "fix(wms): criarSessao traduz 23505 em 409 amigável [P055]"`

---

## PR 4: Trigger kit→≥1 componente (cobre sync e escrita direta) [P120]

> A invariante "kit exige ≥1 componente" existe só no editor manual (`kits.ts`). O gap real é a invariante hard que cobre `sync-tiny.ts:85` (que seta `eh_kit=true` sem composição) e qualquer escrita direta. Trigger BEFORE em `siso_produtos` rejeita flip `eh_kit→true` sem nenhuma linha em `siso_produto_kits`. **Cuidado anco­rado:** `upsertComponente` (`kits.ts:234-249`) hoje seta `eh_kit=true` ANTES de inserir o componente (2 statements supabase-js separados → auto-commit) — um BEFORE trigger quebraria esse caminho. Reordenamos `upsertComponente` (insere componente primeiro, depois marca `eh_kit`).

### Task 4.1: Reordenar upsertComponente (componente antes de eh_kit)

**Files:**
- Modify: `src/lib/wms/kits.ts:234-249` (ordem: insert kit-row → update eh_kit)
- Test: `src/lib/wms/upsert-componente-ordem.test.ts`

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `src/lib/wms/upsert-componente-ordem.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const calls: string[] = [];

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { eh_kit: false, ativo: true } }) }),
      }),
      update: () => ({ eq: async () => { calls.push(`update:${table}`); return { error: null }; } }),
      upsert: async () => { calls.push(`upsert:${table}`); return { error: null }; },
    }),
  };
  return { createServiceClient: () => client };
});

import { upsertComponente } from "./kits";

describe("upsertComponente — ordem componente antes de eh_kit", () => {
  it("insere a linha de componente ANTES de marcar eh_kit=true", async () => {
    calls.length = 0;
    await upsertComponente({ kit_produto_id: "k1", componente_produto_id: "c1", quantidade: 2 });
    const idxUpsert = calls.indexOf("upsert:siso_produto_kits");
    const idxUpdate = calls.indexOf("update:siso_produtos");
    expect(idxUpsert).toBeGreaterThanOrEqual(0);
    expect(idxUpdate).toBeGreaterThan(idxUpsert);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm test -- upsert-componente-ordem`
  Expected: FAIL — hoje `kits.ts` faz `update siso_produtos eh_kit=true` (234-238) ANTES do `upsert siso_produto_kits` (240-249), então `idxUpdate < idxUpsert`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/wms/kits.ts`, inverter os dois blocos (linhas 234-249) — primeiro o `upsert` da composição, depois o `update eh_kit`:

```ts
  const { error } = await sb.from("siso_produto_kits").upsert(
    {
      kit_produto_id: input.kit_produto_id,
      componente_produto_id: input.componente_produto_id,
      quantidade: input.quantidade,
      atualizado_em: new Date().toISOString(),
    },
    { onConflict: "kit_produto_id,componente_produto_id" },
  );
  if (error) throw error;

  // Marca como kit DEPOIS de existir ≥1 componente — o trigger
  // wms_kit_exige_componente (P120) só permite eh_kit=true com composição.
  const { error: errKit } = await sb
    .from("siso_produtos")
    .update({ eh_kit: true })
    .eq("id", input.kit_produto_id);
  if (errKit) throw errKit;
```

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm test -- upsert-componente-ordem`
  Expected: PASS (`idxUpdate > idxUpsert`).

- [ ] **Step 5 — COMMIT.** `git add src/lib/wms/kits.ts src/lib/wms/upsert-componente-ordem.test.ts && git commit -m "refactor(wms): upsertComponente insere composição antes de marcar eh_kit [P120]"`

### Task 4.2: sync-tiny só marca eh_kit quando há composição

**Files:**
- Modify: `src/lib/wms/sync-tiny.ts:85` (chama o helper); novo helper exportado `resolverEhKitSync` no mesmo arquivo
- Test: `src/lib/wms/sync-tiny-eh-kit.test.ts`

> Nota: divergência leve do achado — o achado cita "alinhar com P097". **P097 NÃO fica órfão entre unidades:** está alocado na Fase 6e (sync-tiny), PR1 Task 1.1 — `docs/superpowers/plans/2026-06-05-raio-x-fase-6e-sync-tiny.md:37` (guard `decidirEhKit` que **bloqueia e avisa** sync de kit vazio do Tiny, decisão do dono "P097 = bloquear sync de kit vazio"). Esta Task 4.2 resolve só o **mínimo local** desta unidade (helper `resolverEhKitSync` para o sync não bater no trigger do P120); a UX completa de surfacing do kit-fantasma é de P097/Fase 6e. As duas mudanças são compatíveis (ambas deixam `eh_kit=false` sem composição); a Fase 6e refina por cima. Mudança de comportamento de produção aqui (`eh_kit` agora condicional ao count de `siso_produto_kits`), então tem RED: extraímos a decisão num helper puro-testável `resolverEhKitSync(sb, produtoId, tinyTipo)` e mockamos o supabase. O integration da Task 4.3 cobre o trigger; este unit cobre a lógica nova do sync (que o integration NÃO exercita — ele faz UPDATE direto em `siso_produtos`).

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `src/lib/wms/sync-tiny-eh-kit.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

let kitCount = 0;

// Mock do supabase pra controlar o count de siso_produto_kits por produto.
const sbMock = {
  from: () => ({
    select: () => ({
      eq: async () => ({ count: kitCount, error: null }),
    }),
  }),
} as never;

// Mocka as deps pesadas de sync-tiny (Tiny API/oauth/queue) pra o import não puxar env.
vi.mock("@/lib/tiny-api", () => ({ getProdutoFull: vi.fn() }));
vi.mock("@/lib/tiny-oauth", () => ({ getValidTokenByEmpresa: vi.fn() }));
vi.mock("@/lib/tiny-queue", () => ({ runWithEmpresa: vi.fn() }));

import { resolverEhKitSync } from "./sync-tiny";

describe("resolverEhKitSync — eh_kit condicional à composição", () => {
  it("tipo K sem composição (count=0) → false", async () => {
    kitCount = 0;
    expect(await resolverEhKitSync(sbMock, "p1", "K")).toBe(false);
  });

  it("tipo K com composição (count>0) → true", async () => {
    kitCount = 2;
    expect(await resolverEhKitSync(sbMock, "p1", "K")).toBe(true);
  });

  it("tipo não-K → false (independe do count)", async () => {
    kitCount = 5;
    expect(await resolverEhKitSync(sbMock, "p1", "S")).toBe(false);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm test -- sync-tiny-eh-kit`
  Expected: FAIL — `resolverEhKitSync` não é exportado por `sync-tiny.ts` (import falha).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/wms/sync-tiny.ts`, adicionar o helper exportado (acima de `sincronizarProduto`) e trocar a linha 85.

  (a) Novo helper (usa o tipo `SupabaseClient` já disponível via `createServiceClient`; tipamos como `ReturnType<typeof createServiceClient>`):

```ts
/**
 * P120: decide eh_kit pro sync. Tiny tipo=K só vira eh_kit=true se já houver
 * composição cadastrada em siso_produto_kits — o trigger wms_kit_exige_componente
 * rejeita kit sem componente. Sem composição, fica false até alguém cadastrar.
 */
export async function resolverEhKitSync(
  sb: ReturnType<typeof createServiceClient>,
  produtoId: string,
  tinyTipo: string | null | undefined,
): Promise<boolean> {
  if (tinyTipo !== "K") return false;
  const { count } = await sb
    .from("siso_produto_kits")
    .select("id", { count: "exact", head: true })
    .eq("kit_produto_id", produtoId);
  return (count ?? 0) > 0;
}
```

  (b) Trocar a linha 85 (`patch.eh_kit = full.tipo === "K";`) por:

```ts
  patch.eh_kit = await resolverEhKitSync(sb, produtoId, full.tipo);
```

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm test -- sync-tiny-eh-kit`
  Expected: PASS (3 casos). Rodar também `npm run lint && npx tsc --noEmit` (sem erro de tipo no helper).

- [ ] **Step 5 — COMMIT.** `git add src/lib/wms/sync-tiny.ts src/lib/wms/sync-tiny-eh-kit.test.ts && git commit -m "fix(wms): sync-tiny só marca eh_kit com composição existente [P120]"`

### Task 4.3: Migration — trigger wms_kit_exige_componente

**Files:**
- Create: `supabase/migrations/20260607_kit_exige_componente.sql`
- Test: `test/integration/kit-exige-componente.test.ts`

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/kit-exige-componente.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let kitId: string;
let compId: string;
const SKU = `TEST-KIT-INV-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: k } = await sb
    .from("siso_produtos").insert({ sku: `${SKU}-K`, descricao: "Kit inv test", ativo: true })
    .select("id").single();
  kitId = k!.id;
  const { data: c } = await sb
    .from("siso_produtos").insert({ sku: `${SKU}-C`, descricao: "Componente test", ativo: true })
    .select("id").single();
  compId = c!.id;
});

describe("trigger wms_kit_exige_componente", () => {
  it("rejeita eh_kit=true sem nenhuma linha em siso_produto_kits", async () => {
    const { error } = await sb.from("siso_produtos").update({ eh_kit: true }).eq("id", kitId);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/kit.*componente/i);
  });

  it("aceita eh_kit=true depois de cadastrar ≥1 componente", async () => {
    const { error: ec } = await sb.from("siso_produto_kits").insert({
      kit_produto_id: kitId, componente_produto_id: compId, quantidade: 2,
    });
    expect(ec).toBeNull();
    const { error: ek } = await sb.from("siso_produtos").update({ eh_kit: true }).eq("id", kitId);
    expect(ek).toBeNull();
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm run test:integration -- kit-exige-componente`
  Expected: FAIL — hoje não há trigger; o 1º update `eh_kit=true` sem composição passa (`error` vem `null`).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607_kit_exige_componente.sql`:

```sql
-- P120 — invariante hard: siso_produtos.eh_kit=true só persiste com ≥1 linha
-- em siso_produto_kits. Cobre sync-tiny e escrita direta (o editor manual já
-- foi reordenado pra inserir o componente antes de marcar eh_kit).
--
-- BEFORE INSERT OR UPDATE em siso_produtos: dispara só quando eh_kit passa a true.

BEGIN;

CREATE OR REPLACE FUNCTION wms_kit_exige_componente()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Só valida quando eh_kit está sendo ligado (ou já é true num INSERT).
  IF NEW.eh_kit = true AND (TG_OP = 'INSERT' OR COALESCE(OLD.eh_kit, false) = false) THEN
    IF NOT EXISTS (
      SELECT 1 FROM siso_produto_kits WHERE kit_produto_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'kit % exige ≥1 componente em siso_produto_kits antes de eh_kit=true', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kit_exige_componente ON siso_produtos;
CREATE TRIGGER trg_kit_exige_componente
  BEFORE INSERT OR UPDATE ON siso_produtos
  FOR EACH ROW
  EXECUTE FUNCTION wms_kit_exige_componente();

COMMENT ON FUNCTION wms_kit_exige_componente() IS
  'P120: bloqueia eh_kit=true sem composição em siso_produto_kits (cobre sync e escrita direta).';

COMMIT;
```

- [ ] **Step 3b — Aplicar a migration.** Via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `kit_exige_componente`.

> **Pré-condição de dados:** se já existirem produtos `eh_kit=true` sem composição em staging, eles não derrubam o CREATE TRIGGER (o trigger só valida em INSERT/flip futuro, não nas linhas existentes). Mas qualquer UPDATE futuro nesses produtos que mantenha `eh_kit=true` passa (OLD.eh_kit já era true → guard não dispara). O sync (Task 4.2) corrige os `eh_kit` espúrios na próxima sincronização.

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm run test:integration -- kit-exige-componente`
  Expected: PASS (rejeita sem componente; aceita depois).

- [ ] **Step 5 — Adicionar entrada em `erros-conhecidos.yaml`.**

```yaml
  - id: wms-kit-sem-componente
    date: "2026-06-05"
    source: wms.kits
    category: business_logic
    message: "Kit com eh_kit=true e 0 componentes era roteado pra OC / não funcionava"
    cause: >
      Invariante "kit exige ≥1 componente" existia só no editor manual; sync-tiny
      setava eh_kit=true por tipo=K sem composição; escrita direta também escapava.
    fix: >
      Trigger BEFORE wms_kit_exige_componente em siso_produtos rejeita flip eh_kit→true
      sem composição. upsertComponente reordenado (componente antes de eh_kit).
      sync-tiny só marca eh_kit com composição existente.
    files:
      - supabase/migrations/20260607_kit_exige_componente.sql
      - src/lib/wms/kits.ts
      - src/lib/wms/sync-tiny.ts
    tags: [kit, trigger, invariante, sync-tiny]
```

- [ ] **Step 6 — COMMIT.** `git add supabase/migrations/20260607_kit_exige_componente.sql test/integration/kit-exige-componente.test.ts erros-conhecidos.yaml && git commit -m "feat(wms): trigger kit exige ≥1 componente [P120]"`

---

## PR 5: Dedup de recebimento por assinatura NF (UNIQUE parcial) — saldo/custo não dobram [P099, P109]

> P099 e P109 compartilham a MESMA primitiva: índice único parcial sobre a assinatura da NF de compra para `origem_tipo='nf_compra' AND estorno_de IS NULL`. Espelha `20260527_p3_movs_unique_inventario_divergencia.sql`. O 2º recebimento da mesma NF é rejeitado/idempotente: saldo sobe uma vez, custo médio recalcula uma vez.
>
> **⚠️ Cobertura dos caminhos REAIS de OC (gap fechado nesta revisão):** o achado P109 lista `compras/receber` e `receber-oc` como os caminhos de entrada do integrador. Verificado no código atual: `compras/receber/route.ts:447` propaga **só `nota_fiscal_id`** (uuid), e `receber-oc.ts` **não propaga nenhum campo de NF**. Um único índice keyed em `chave_acesso_nf` ficaria **INERTE** pra esses caminhos (só `/api/wms/receber` via `receberEstoque` propaga `chave_acesso_nf`, em `movimentacoes.ts:138,187`). Por isso a migration cria **DOIS** índices parciais complementares:
> - `uq_mov_recebimento_nf_chave` em `(chave_acesso_nf, produto_id, galpao_id)` — morde no caminho `/api/wms/receber` (manual com chave).
> - `uq_mov_recebimento_nf_id` em `(nota_fiscal_id, produto_id, galpao_id)` — morde no caminho `compras/receber` (integrador com `nota_fiscal_id`).
>
> **Limitação documentada e VINCULANTE:** `receber-oc.ts` recebe **sem NF** (nem `nota_fiscal_id` nem `chave_acesso_nf` — o recebimento de OC com divergência não carrega assinatura fiscal estável). Logo **o recebimento via `receber-oc` NÃO é dedupado por assinatura de NF** — não há assinatura. Isso é fiel à decisão "dedup por NF" (sem NF, sem dedup); a idempotência desse caminho fica coberta pelo claim atômico do recebimento de OC (fora desta fase). Registrado em `erros-conhecidos.yaml` (Task 5.2).

### Task 5.1: Migration — UNIQUE parcial por assinatura de NF de compra

**Files:**
- Create: `supabase/migrations/20260607_recebimento_nf_dedup.sql`
- Test: `test/integration/recebimento-nf-dedup.test.ts`

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/recebimento-nf-dedup.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let produtoId: string;
let galpaoId: string;
let locId: string;
let nfId: string;
const SKU = `TEST-NF-DEDUP-${Math.random().toString(36).slice(2, 8)}`;
const CHAVE = `35${Math.random().toString().slice(2, 44)}`.padEnd(44, "0").slice(0, 44);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos").insert({ sku: SKU, descricao: "NF dedup test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  // NF canônica pra exercitar o índice por nota_fiscal_id (caminho compras/receber).
  const { data: nf } = await sb
    .from("siso_notas_fiscais")
    .insert({ chave_acesso: CHAVE, tipo: "entrada" })
    .select("id").single();
  nfId = nf!.id;
});

function entradaNf(extra?: Record<string, unknown>) {
  return sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 5, p_origem_tipo: "nf_compra",
    p_origem_id: crypto.randomUUID(), p_chave_acesso_nf: CHAVE,
    p_custo_unitario: 8, p_motivo: "recebimento NF", ...extra,
  });
}

describe("UNIQUE parcial uq_mov_recebimento_nf_chave (caminho /api/wms/receber)", () => {
  it("aceita a 1ª entrada da NF e rejeita a 2ª (mesma chave+produto+galpão) com 23505", async () => {
    const { error: e1 } = await entradaNf();
    expect(e1).toBeNull();

    const { error: e2 } = await entradaNf();
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");

    // saldo subiu só uma vez (5), custo médio recalculou só uma vez (8)
    const { data: est } = await sb
      .from("siso_estoque").select("saldo")
      .eq("produto_id", produtoId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(5);
    const { data: cm } = await sb
      .from("siso_custo_medio").select("custo_medio").eq("produto_id", produtoId).single();
    expect(Number(cm?.custo_medio)).toBeCloseTo(8, 3);
  });
});

describe("UNIQUE parcial uq_mov_recebimento_nf_id (caminho compras/receber — só nota_fiscal_id)", () => {
  it("rejeita a 2ª entrada da MESMA nota_fiscal_id (sem chave) com 23505", async () => {
    // produto novo pra isolar do describe anterior; entradas SEM chave, SÓ nota_fiscal_id.
    const { data: p2 } = await sb
      .from("siso_produtos").insert({ sku: `${SKU}-NFID`, descricao: "NF id dedup", ativo: true })
      .select("id").single();
    const produto2 = p2!.id;
    const base = {
      p_produto_id: produto2, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 5, p_origem_tipo: "nf_compra",
      p_origem_id: crypto.randomUUID(), p_nota_fiscal_id: nfId,
      p_custo_unitario: 8, p_motivo: "recebimento via nota_fiscal_id",
    };
    const { error: e1 } = await sb.rpc("wms_inserir_movimentacao", base);
    expect(e1).toBeNull();
    const { error: e2 } = await sb.rpc("wms_inserir_movimentacao", {
      ...base, p_origem_id: crypto.randomUUID(),
    });
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm run test:integration -- recebimento-nf-dedup`
  Expected: FAIL — hoje não há índice anti-duplicata pra recebimento; o 2º insert passa em ambos os describes.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607_recebimento_nf_dedup.sql` com DOIS índices complementares (chave e nota_fiscal_id), cobrindo os dois caminhos reais de OC:

```sql
-- P099/P109 — dedup de recebimento por assinatura da NF de compra.
-- Espelha 20260527_p3_movs_unique_inventario_divergencia.sql.
--
-- DOIS índices parciais complementares (caminhos REAIS de entrada divergem na
-- assinatura disponível):
--   uq_mov_recebimento_nf_chave: (chave_acesso_nf, produto, galpão) — /api/wms/receber
--     (receberEstoque propaga chave_acesso_nf, movimentacoes.ts:138,187).
--   uq_mov_recebimento_nf_id:    (nota_fiscal_id, produto, galpão) — compras/receber
--     (gravarMovEntradaCompra propaga só nota_fiscal_id, route.ts:447).
-- 2º clique / reenvio do integrador bate em 23505 → tratado como idempotente no TS.
--
-- receber-oc.ts NÃO propaga NF (nem chave nem id) → NÃO é dedupado por NF (sem
-- assinatura estável); idempotência desse caminho fica no claim atômico de OC (fora desta fase).
--
-- Pré-condição: nenhuma duplicata viva já existente; senão o CREATE UNIQUE falha
-- (proteção). Cleanup retroativo de duplicatas históricas é P6.

BEGIN;

CREATE UNIQUE INDEX uq_mov_recebimento_nf_chave
  ON siso_movimentacoes(chave_acesso_nf, produto_id, galpao_id)
  WHERE origem_tipo = 'nf_compra'
    AND chave_acesso_nf IS NOT NULL
    AND estorno_de IS NULL;

CREATE UNIQUE INDEX uq_mov_recebimento_nf_id
  ON siso_movimentacoes(nota_fiscal_id, produto_id, galpao_id)
  WHERE origem_tipo = 'nf_compra'
    AND nota_fiscal_id IS NOT NULL
    AND estorno_de IS NULL;

COMMENT ON INDEX uq_mov_recebimento_nf_chave IS
  'P099/P109: dedup de recebimento por (chave_acesso_nf, produto, galpão) — caminho /api/wms/receber.';
COMMENT ON INDEX uq_mov_recebimento_nf_id IS
  'P099/P109: dedup de recebimento por (nota_fiscal_id, produto, galpão) — caminho compras/receber.';

COMMIT;
```

- [ ] **Step 3b — Aplicar a migration.** Via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `recebimento_nf_dedup`.

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm run test:integration -- recebimento-nf-dedup`
  Expected: PASS (ambos os describes: `e2.code === "23505"`, saldo=5, custo=8).

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260607_recebimento_nf_dedup.sql test/integration/recebimento-nf-dedup.test.ts && git commit -m "feat(wms): UNIQUE parcial dedup de recebimento por assinatura NF [P099,P109]"`

### Task 5.2: receberEstoque + ledger absorvem 23505 do recebimento como idempotente

**Files:**
- Modify: `src/lib/wms/ledger.ts:203-206` (catch da RPC reconhece dedup de recebimento NF por chave OU nota_fiscal_id — absorção centralizada no único write do ledger, cobre `/api/wms/receber` e `compras/receber` sem tocar os callers)
- Test: `src/lib/wms/receber-nf-idempotente.test.ts`

> **Decisão de design (anco­rada):** o ledger `inserirMovimentacao` é o ponto único de escrita (`sb` e `tripla` em escopo; bloco `if (error)` em `ledger.ts:203-206`). Em vez de espalhar o tratamento em cada caller, fazemos `inserirMovimentacao` reconhecer o `23505` de **qualquer um dos dois** índices de dedup (`uq_mov_recebimento_nf_chave` OU `uq_mov_recebimento_nf_id`) e, nos casos `origem='nf_compra'` com `chave_acesso_nf` **ou** `nota_fiscal_id` presente, recarregar e devolver a mov E já existente (idempotente) em vez de propagar. Isso cobre `/api/wms/receber` (chave) e `compras/receber` (nota_fiscal_id) de uma vez. `receber-oc` (sem NF) não bate nesses índices — não é dedupado por NF (documentado).

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `src/lib/wms/receber-nf-idempotente.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const movExistente = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  produto_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  galpao_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  localizacao_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  tipo: "E", quantidade: 5, origem_tipo: "nf_compra", chave_acesso_nf: "X".repeat(44),
};
const NF_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: (table: string) => ({
      select: () => ({
        match: () => ({ maybeSingle: async () => ({ data: { saldo: 0, reservado: 0 } }) }),
        // o recovery filtra por origem/produto/galpão + (chave OU nota_fiscal_id) e
        // termina em .maybeSingle(); o mock devolve a mov existente em qualquer chain de eq/is.
        eq: function () { return this; },
        is: function () { return this; },
        maybeSingle: async () => ({ data: movExistente }),
        single: async () => ({ data: movExistente }),
      }),
    }),
    rpc: async () => ({ data: null, error: { code: "23505", message: "duplicate key uq_mov_recebimento_nf_chave" } }),
  };
  return { createServiceClient: () => client };
});

import { inserirMovimentacao } from "./ledger";

describe("inserirMovimentacao — recebimento NF idempotente", () => {
  it("absorve 23505 pela assinatura chave_acesso_nf e devolve a mov E existente", async () => {
    const r = await inserirMovimentacao({
      tripla: { produto_id: movExistente.produto_id, galpao_id: movExistente.galpao_id, localizacao_id: movExistente.localizacao_id },
      tipo: "E", qty: 5, origem_tipo: "nf_compra",
      chave_acesso_nf: movExistente.chave_acesso_nf, custo_unitario: 8,
    });
    expect(r.id).toBe(movExistente.id);
  });

  it("absorve 23505 pela assinatura nota_fiscal_id (caminho compras/receber, sem chave)", async () => {
    const r = await inserirMovimentacao({
      tripla: { produto_id: movExistente.produto_id, galpao_id: movExistente.galpao_id, localizacao_id: movExistente.localizacao_id },
      tipo: "E", qty: 5, origem_tipo: "nf_compra",
      nota_fiscal_id: NF_ID, custo_unitario: 8,
    });
    expect(r.id).toBe(movExistente.id);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm test -- receber-nf-idempotente`
  Expected: FAIL — hoje `inserirMovimentacao` faz `throw error` no `23505` (ledger.ts:203-206) em ambos os casos.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/wms/ledger.ts`, no bloco `if (error) { ... throw error; }` (linhas 203-206), inserir o tratamento idempotente do recebimento NF antes do `throw`. Cobre as DUAS assinaturas (chave OU nota_fiscal_id):

```ts
  if (error) {
    // P099/P109: UNIQUE parcial uq_mov_recebimento_nf_chave / _id rejeitou a 2ª
    // entrada da mesma NF de compra (reenvio do integrador / duplo-clique).
    // Idempotente: recarrega e devolve a mov E que já lançou o saldo/custo desta NF.
    // Branch por assinatura disponível: chave_acesso_nf (/api/wms/receber) OU
    // nota_fiscal_id (compras/receber).
    if (
      (error as { code?: string }).code === "23505" &&
      input.origem_tipo === "nf_compra" &&
      (input.chave_acesso_nf || input.nota_fiscal_id)
    ) {
      let q = sb
        .from("siso_movimentacoes")
        .select("*")
        .eq("origem_tipo", "nf_compra")
        .eq("produto_id", tripla.produto_id)
        .eq("galpao_id", tripla.galpao_id)
        .is("estorno_de", null);
      if (input.chave_acesso_nf) {
        q = q.eq("chave_acesso_nf", input.chave_acesso_nf);
      } else if (input.nota_fiscal_id) {
        q = q.eq("nota_fiscal_id", input.nota_fiscal_id);
      }
      const { data: jaLancada } = await q.maybeSingle();
      if (jaLancada) {
        logger.warn("wms.ledger", "recebimento NF duplicado absorvido pelo UNIQUE (idempotente)", {
          chave_acesso_nf: input.chave_acesso_nf ?? null,
          nota_fiscal_id: input.nota_fiscal_id ?? null,
          produto_id: tripla.produto_id,
          mov_id: (jaLancada as { id: string }).id,
        });
        return jaLancada as unknown as Movimentacao;
      }
    }
    logger.error("wms.ledger", "falha ao inserir mov", { error, input });
    throw error;
  }
```

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm test -- receber-nf-idempotente`
  Expected: PASS (devolve `movExistente.id`).

- [ ] **Step 5 — RODAR a regressão do ledger existente.** Comando: `npm test -- ledger.test`
  Expected: PASS (nenhuma regressão nos testes de cálculo/coerência).

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**

```yaml
  - id: wms-recebimento-nf-dobra-saldo
    date: "2026-06-05"
    source: wms.ledger / wms.movimentacoes.receber
    category: database
    message: "Reenvio do integrador / duplo-clique no recebimento dobrava saldo e custo médio"
    cause: >
      receberEstoque/compras-receber não deduplicavam por assinatura da NF; não havia
      índice anti-duplicata pra nf_compra. compras/receber propaga só nota_fiscal_id e
      /api/wms/receber propaga chave_acesso_nf — um índice só-chave seria inerte pro
      caminho do integrador (compras/receber).
    fix: >
      DOIS índices parciais: uq_mov_recebimento_nf_chave (chave_acesso_nf, produto, galpão)
      e uq_mov_recebimento_nf_id (nota_fiscal_id, produto, galpão), ambos WHERE origem
      nf_compra e estorno_de IS NULL. inserirMovimentacao absorve 23505 de qualquer um
      (branch por chave OU nota_fiscal_id) como idempotente. LIMITAÇÃO: receber-oc não
      propaga NF (sem assinatura estável) — não é dedupado por NF nesta fase.
    files:
      - supabase/migrations/20260607_recebimento_nf_dedup.sql
      - src/lib/wms/ledger.ts
    tags: [recebimento, nf, dedup, unique, custo-medio, idempotencia]
```

- [ ] **Step 7 — COMMIT.** `git add src/lib/wms/ledger.ts src/lib/wms/receber-nf-idempotente.test.ts erros-conhecidos.yaml && git commit -m "fix(wms): inserirMovimentacao absorve 23505 de recebimento NF como idempotente [P099,P109]"`

---

## PR 6: Guard custo-zero + reversão de custo médio no estorno + fallback nas rotas [P108, P110, P104]

> **Ordem das deps:** P108 (guard de custo-zero na RPC) → P110 (reversão de custo médio no estorno, mesma RPC) → P104 (fallback de custo nas rotas de entrada). P108 e P110 recriam `wms_inserir_movimentacao` numa MIGRATION ÚNICA (conflito resolvido no mestre: "1 migration recria com os dois guards"). P104 não tem migration — endurece os routes de entrada com fallback ao `siso_custo_medio` histórico.

### Task 6.1: Migration — recria wms_inserir_movimentacao com guard custo-zero + reversão de estorno

**Files:**
- Create: `supabase/migrations/20260607_inserir_mov_custo_guards.sql`
- Test: `test/integration/rpc-custo-guards.test.ts`

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/rpc-custo-guards.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let galpaoId: string;
let locId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
});

async function novoProduto(label: string): Promise<string> {
  const sku = `TEST-CUSTO-${label}-${Math.random().toString(36).slice(2, 8)}`;
  const { data } = await sb
    .from("siso_produtos").insert({ sku, descricao: `custo guard ${label}`, ativo: true })
    .select("id").single();
  return data!.id;
}

describe("P108 — guard custo-zero", () => {
  it("rejeita entrada nf_compra com custo_unitario=0 e qty>0", async () => {
    const produtoId = await novoProduto("zero");
    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 5, p_origem_tipo: "nf_compra",
      p_origem_id: null, p_custo_unitario: 0, p_motivo: "custo zero",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/custo zero|custo.*0/i);
    // custo médio NÃO virou 0
    const { data: cm } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", produtoId).maybeSingle();
    expect(cm).toBeNull();
  });

  it("aceita mov S sem custo (operacional não afetado)", async () => {
    const produtoId = await novoProduto("op");
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
      p_origem_id: null, p_custo_unitario: 5, p_motivo: "base",
    });
    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 3, p_origem_tipo: "venda_manual",
      p_origem_id: null, p_custo_unitario: null, p_motivo: "saida sem custo",
    });
    expect(error).toBeNull();
  });
});

describe("P110 — estorno reverte custo médio", () => {
  it("custo 5 → entrada qty a custo 8 (vira 8) → estornar essa entrada → volta a 5", async () => {
    const produtoId = await novoProduto("estorno");
    // base: custo 5 com 10 un
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
      p_origem_id: null, p_custo_unitario: 5, p_motivo: "base 5",
    });
    // entrada que move pra 8: (10*5 + 10*15)/20 = 10 — usamos custo 15 pra média virar 10
    const { data: movE } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "nf_compra",
      p_origem_id: null, p_custo_unitario: 15, p_motivo: "entrada 15",
    });
    const { data: cmDepois } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", produtoId).single();
    expect(Number(cmDepois?.custo_medio)).toBeCloseTo(10, 3);

    // estorna a entrada de 15 → custo médio volta ao anterior (5)
    const { error: eEst } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 10, p_origem_tipo: "estorno",
      p_origem_id: movE as unknown as string, p_estorno_de: movE as unknown as string,
      p_custo_unitario: null, p_motivo: "estorno entrada 15",
    });
    expect(eEst).toBeNull();
    const { data: cmFinal } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", produtoId).single();
    expect(Number(cmFinal?.custo_medio)).toBeCloseTo(5, 3);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm run test:integration -- rpc-custo-guards`
  Expected: FAIL — (a) custo zero hoje passa e zera o custo médio; (b) estorno não reverte (custo fica 10).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607_inserir_mov_custo_guards.sql` recriando a RPC viva (`20260527_wms_inserir_mov_motivo_categoria.sql`) com os dois guards. Mudanças cirúrgicas sobre o corpo existente: (1) após `v_recalcula_custo`, bloqueia custo-zero; (2) quando `p_estorno_de` é de uma mov E que compôs custo, restaura `custo_medio` ao `custo_medio_anterior` da mov original.

```sql
-- P108 + P110 — recria wms_inserir_movimentacao (corpo de
-- 20260527_wms_inserir_mov_motivo_categoria.sql) com dois guards de custo:
--   P108: entrada (E) com qty>0 e custo 0 nas origens que compõem custo médio → RAISE.
--   P110: estorno (p_estorno_de) de uma entrada que compôs custo → reverte o custo
--         médio ao custo_medio_anterior da mov original (como se a entrada não tivesse existido).
-- Nenhuma outra lógica (saldo, reservado, recálculo ponderado) muda.

BEGIN;

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
  p_motivo_categoria text DEFAULT NULL::text
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
  v_orig_tipo           char(1);
  v_orig_origem         text;
  v_orig_cm_anterior    numeric;
BEGIN
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

  -- P108: entrada com qty>0 e custo 0 nas origens que compõem custo médio é
  -- bloqueada — evita custo médio R$0 com estoque físico presente.
  IF v_recalcula_custo AND p_quantidade > 0 AND COALESCE(p_custo_unitario, 0) = 0 THEN
    RAISE EXCEPTION 'entrada com custo zero não permitida quando há quantidade (origem %)', p_origem_tipo
      USING ERRCODE = 'check_violation';
  END IF;

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

  -- P110: estorno de uma entrada que compôs custo médio → reverte o efeito,
  -- restaurando o custo_medio ao custo_medio_anterior da mov original
  -- (correto quando o estorno é o último evento de custo do produto).
  IF p_estorno_de IS NOT NULL THEN
    SELECT tipo, origem_tipo, custo_medio_anterior
      INTO v_orig_tipo, v_orig_origem, v_orig_cm_anterior
      FROM siso_movimentacoes WHERE id = p_estorno_de;
    IF v_orig_tipo = 'E'
       AND v_orig_origem IN ('nf_compra','devolucao_cliente_integra','lancamento_retroativo','ajuste_manual','inventario_inicial')
       AND v_orig_cm_anterior IS NOT NULL THEN
      v_custo_medio_novo := v_orig_cm_anterior;
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
    motivo_categoria
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
    p_motivo_categoria::wms_motivo_categoria_enum
  ) RETURNING id INTO v_mov_id;

  UPDATE siso_estoque
     SET saldo = v_saldo_posterior, reservado = v_reservado_posterior, atualizado_em = now()
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id;

  -- Persiste o custo médio quando recalculou (P108) OU quando o estorno o reverteu (P110).
  IF v_recalcula_custo OR (p_estorno_de IS NOT NULL AND v_custo_medio_novo <> v_custo_medio_atual) THEN
    INSERT INTO siso_custo_medio (produto_id, custo_medio, ultima_movimentacao_id, atualizado_em)
    VALUES (p_produto_id, v_custo_medio_novo, v_mov_id, now())
    ON CONFLICT (produto_id) DO UPDATE
      SET custo_medio = EXCLUDED.custo_medio,
          ultima_movimentacao_id = EXCLUDED.ultima_movimentacao_id,
          atualizado_em = EXCLUDED.atualizado_em;
  END IF;

  RETURN v_mov_id;
END;
$function$;

COMMIT;
```

- [ ] **Step 3b — Aplicar a migration.** Via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `inserir_mov_custo_guards`.

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm run test:integration -- rpc-custo-guards`
  Expected: PASS (custo zero RAISE; estorno reverte a 5; mov S sem custo passa).

- [ ] **Step 4b — Regressão do ledger-rpc.** Comando: `npm run test:integration -- ledger-rpc`
  Expected: PASS (entrada/saída/custo-médio existentes continuam corretos).

- [ ] **Step 5 — Adicionar entrada em `erros-conhecidos.yaml`.**

```yaml
  - id: wms-custo-zero-e-estorno-inflado
    date: "2026-06-05"
    source: wms_inserir_movimentacao
    category: business_logic
    message: "Entrada custo 0 zerava custo médio; estorno de entrada deixava custo inflado"
    cause: >
      RPC só checava custo_unitario IS NOT NULL (0 passava e diluía o custo médio);
      estorno vira mov S origem 'estorno' fora da whitelist, então o efeito da entrada
      sobre o custo médio nunca era desfeito.
    fix: >
      RPC recriada com 2 guards: (P108) RAISE em E com qty>0 e custo 0 nas origens de
      custo; (P110) estorno de entrada de custo restaura custo_medio ao custo_medio_anterior
      da mov original.
    files:
      - supabase/migrations/20260607_inserir_mov_custo_guards.sql
    tags: [custo-medio, estorno, guard, ledger, rpc]
```

- [ ] **Step 6 — COMMIT.** `git add supabase/migrations/20260607_inserir_mov_custo_guards.sql test/integration/rpc-custo-guards.test.ts erros-conhecidos.yaml && git commit -m "feat(wms): RPC ledger — guard custo-zero + reversão de custo no estorno [P108,P110]"`

### Task 6.2: Fallback de custo nas rotas de entrada (siso_custo_medio histórico)

**Files:**
- Create: `src/lib/wms/custo-fallback.ts` (helper puro de resolução de custo)
- Modify: `src/app/api/wms/compras/receber/route.ts:429-451` (custo resolvido no `gravarMovEntradaCompra`); `src/lib/wms/receber-oc.ts:135-159` (custo da mov E); `src/app/api/wms/receber/route.ts:64-90` (rejeitar custo 0 com qty>0 — ver Task 6.3)
- Test: `src/lib/wms/custo-fallback.test.ts` (unit do helper) + `src/lib/wms/receber-oc-custo-wiring.test.ts` (unit do call-site real) + `scripts/wms/cenarios/catalogo/83-receber-custo-fallback.ts` (E2E smoke de regressão)

> **Anco­ragem (verificada no código atual):** `compras/receber/route.ts:448` passa `custo_unitario: custo_unitario > 0 ? custo_unitario : undefined`; `receber-oc.ts:152` passa `custo_unitario: itemReq.custo_unitario` (pode ser undefined). Ambas as rotas NÃO setam `chave_acesso_nf` — só `nota_fiscal_id` (compras) ou nenhum campo NF (receber-oc). Com o guard P108 ativo (Task 6.1), uma entrada `nf_compra` com custo 0 RAISE — então essas rotas PRECISAM resolver o custo via fallback no `siso_custo_medio` histórico ou rejeitar quando não há histórico. O helper centraliza isso.
> **⚠️ Escopo cirúrgico em `receber-oc.ts` (NÃO mexer em 192/222):** o achado P104 lista `receber-oc.ts:152, 192, 222`, mas **só a linha 152** alimenta o ledger (`inserirMovimentacao`, a mov E real — verificado: 135-159). As linhas **192 e 222** passam `custo_unitario: itemReq.custo_unitario ?? null` para `criarPendencia` — **metadados de put-away** da pendência de guarda, que NÃO compõem custo médio nem batem no guard P108 (não vão à RPC do ledger). Trocá-las pelo `custoResolvido` seria mudança fora do pedido e mudaria o que a pendência exibe. **O executor altera APENAS a linha 152.** Deixar 192/222 intactas.
> **Decisão de escopo VINCULANTE — `/api/wms/receber` (P104 + P108):** o achado P104 lista `src/app/api/wms/receber/route.ts:58-87` ("rejeitar custo 0 quando qty>0"). Com o guard P108 ativo, um `nf_compra` custo=0 via essa rota bate no RAISE da RPC e retorna **5xx mascarado** (`internal_error`) em vez de 400 acionável. Por isso esta unidade **endurece** `/api/wms/receber` na **Task 6.3** (rejeita custo 0 com qty>0, mensagem clara), em vez de divergir do achado. O fallback de custo médio NÃO se aplica lá (o operador manual sempre informa custo — a UX correta é exigir, não adivinhar); o fallback fica restrito a `compras/receber` e `receber-oc`, onde o custo pode vir ausente do integrador.

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `src/lib/wms/custo-fallback.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

let custoHistorico: number | null = null;

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: custoHistorico === null ? null : { custo_medio: custoHistorico } }) }),
      }),
    }),
  };
  return { createServiceClient: () => client };
});

import { resolverCustoEntrada } from "./custo-fallback";

describe("resolverCustoEntrada", () => {
  it("usa o custo informado quando > 0", async () => {
    custoHistorico = 99;
    expect(await resolverCustoEntrada({ produto_id: "p1", custo_informado: 12 })).toBe(12);
  });

  it("cai pro custo médio histórico quando o informado é 0/ausente", async () => {
    custoHistorico = 7.5;
    expect(await resolverCustoEntrada({ produto_id: "p1", custo_informado: 0 })).toBe(7.5);
    expect(await resolverCustoEntrada({ produto_id: "p1", custo_informado: undefined })).toBe(7.5);
  });

  it("lança erro quando não há custo informado nem histórico (produto novo)", async () => {
    custoHistorico = null;
    await expect(
      resolverCustoEntrada({ produto_id: "p1", custo_informado: 0 }),
    ).rejects.toThrow(/custo unitário obrigatório/i);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm test -- custo-fallback`
  Expected: FAIL — `src/lib/wms/custo-fallback.ts` não existe (import falha).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `src/lib/wms/custo-fallback.ts`:

```ts
import { createServiceClient } from "@/lib/supabase-server";

/**
 * Resolve o custo unitário de uma entrada (nf_compra / recebimento OC).
 * - Se `custo_informado > 0`, usa-o.
 * - Senão, cai pro custo médio histórico (`siso_custo_medio`) do produto.
 * - Se não houver nem informado nem histórico (produto novo), lança erro —
 *   a entrada NÃO pode ser gravada com custo 0 (guard P108 da RPC).
 */
export async function resolverCustoEntrada(input: {
  produto_id: string;
  custo_informado?: number | null;
}): Promise<number> {
  const informado = Number(input.custo_informado ?? 0);
  if (informado > 0) return informado;

  const sb = createServiceClient();
  const { data } = await sb
    .from("siso_custo_medio")
    .select("custo_medio")
    .eq("produto_id", input.produto_id)
    .maybeSingle();
  const historico = Number((data as { custo_medio?: number } | null)?.custo_medio ?? 0);
  if (historico > 0) return historico;

  throw new Error(
    `custo unitário obrigatório: produto ${input.produto_id} não tem custo informado nem histórico`,
  );
}
```

  E aplicar nos call-sites:

  (a) Em `src/app/api/wms/compras/receber/route.ts`, dentro de `gravarMovEntradaCompra` (logo após resolver `produtoId`, antes do `inserirMovimentacao` na linha 429), resolver o custo:

```ts
  const custoResolvido = await resolverCustoEntrada({
    produto_id: produtoId,
    custo_informado: custo_unitario,
  });
```

  e trocar a linha 448 `custo_unitario: custo_unitario > 0 ? custo_unitario : undefined,` por `custo_unitario: custoResolvido,`. Adicionar o import no topo do arquivo: `import { resolverCustoEntrada } from "@/lib/wms/custo-fallback";`.

  (b) Em `src/lib/wms/receber-oc.ts`, antes do `inserirMovimentacao` da mov E (linha 135), resolver:

```ts
      const custoResolvido = await resolverCustoEntrada({
        produto_id: produtoWmsId,
        custo_informado: itemReq.custo_unitario,
      });
```

  e trocar a linha 152 `custo_unitario: itemReq.custo_unitario,` por `custo_unitario: custoResolvido,`. Adicionar o import: `import { resolverCustoEntrada } from "./custo-fallback";`.

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm test -- custo-fallback`
  Expected: PASS (3 casos).

- [ ] **Step 4b — Lint/typecheck dos call-sites.** Comando: `npm run lint && npx tsc --noEmit`
  Expected: PASS.

- [ ] **Step 5 — ESCREVER O TESTE QUE FALHA (RED do call-site real).** O helper já tem RED (import). Mas a FIAÇÃO nos routes precisa de RED próprio (o reviewer apontou que lint+cenário-verde não provam que o route chama o helper). Criar `src/lib/wms/receber-oc-custo-wiring.test.ts` — unit do call-site real `receberItensViaOC` (exportado em `receber-oc.ts`), mockando `inserirMovimentacao` e o custo histórico, e asserindo que a mov E recebe o custo RESOLVIDO (fallback), não o `itemReq.custo_unitario` cru:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Captura os args de cada inserirMovimentacao pra inspecionar o custo_unitario gravado.
const movCalls: Array<{ custo_unitario?: number; tipo: string }> = [];

vi.mock("@/lib/wms/ledger", () => ({
  inserirMovimentacao: vi.fn(async (input: { custo_unitario?: number; tipo: string }) => {
    movCalls.push({ custo_unitario: input.custo_unitario, tipo: input.tipo });
    return { id: "mov-" + movCalls.length };
  }),
  estornarMovimentacao: vi.fn(),
}));

// guarda/crossdock/release/registrar não relevantes ao custo — stubs.
vi.mock("@/lib/wms/guarda", () => ({
  resolverLocRecebimento: vi.fn(async () => ({ id: "loc-receb" })),
  criarPendencia: vi.fn(async () => "pend-1"),
}));
vi.mock("@/lib/separacao/wms-mapping", () => ({ resolverProdutoWms: vi.fn(async () => "prod-uuid") }));
// split sem cross-dock: toda a qty vira guarda normal (1 pendência).
vi.mock("@/lib/wms/crossdock-detector", () => ({
  detectarCrossDock: vi.fn(async () => ({
    qty_cross_dock: 0, qty_guarda_normal: 5, loc_packing_id: null, pedidos_vinculados: [],
  })),
}));
vi.mock("@/lib/compras-release", () => ({ checkAndReleasePedidos: vi.fn(async () => ({})) }));
vi.mock("@/lib/historico-service", () => ({ registrarEvento: vi.fn(async () => {}) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), logError: vi.fn() } }));

// supabase: OC achada; item achado; custo médio histórico = 9; update otimista devolve 1 linha.
vi.mock("@/lib/supabase-server", () => {
  const oc = { id: "oc-1", galpao_id: "g1", fornecedor: null, empresa_id: "e1" };
  const item = {
    id: "item-1", pedido_id: "ped-1", sku: "SKU1", produto_id: "tiny-1",
    compra_quantidade_solicitada: 5, compra_quantidade_recebida: 0, ordem_compra_id: "oc-1",
  };
  // chain de SELECT: .select().eq()...; .single() devolve oc/item; .maybeSingle() devolve
  // custo médio (siso_custo_medio) ou null (fornecedor). Suporta N .eq() encadeados.
  function selectChain(table: string) {
    const node: Record<string, unknown> = {
      eq: () => node,
      is: () => node,
      single: async () => ({ data: table === "siso_ordens_compra" ? oc : item, error: null }),
      maybeSingle: async () =>
        table === "siso_custo_medio" ? { data: { custo_medio: 9 }, error: null } : { data: null, error: null },
      // update otimista termina em .select("id") → devolve 1 linha.
      select: async () => ({ data: [{ id: "item-1" }], error: null }),
    };
    return node;
  }
  const client = {
    from: (table: string) => ({
      select: () => selectChain(table),
      update: () => selectChain(table), // .update().eq().eq().select("id")
    }),
  };
  return { createServiceClient: () => client };
});

import { receberItensViaOC } from "./receber-oc";

describe("receber-oc — wiring do fallback de custo no call-site real", () => {
  beforeEach(() => { movCalls.length = 0; });

  it("grava a mov E com o custo RESOLVIDO (fallback histórico 9) quando o item vem SEM custo", async () => {
    await receberItensViaOC({
      ocId: "oc-1",
      itens: [{ item_id: "item-1", qty_real: 5 }], // custo_unitario ausente
      operadorId: "op-1",
      operadorNome: "Op",
    });
    const movE = movCalls.find((m) => m.tipo === "E");
    expect(movE).toBeDefined();
    // RED antes do fix: gravaria undefined (itemReq.custo_unitario). GREEN: fallback 9.
    expect(movE?.custo_unitario).toBe(9);
  });
});
```

- [ ] **Step 5b — RODAR e ver falhar/passar.** Comando: `npm test -- receber-oc-custo-wiring`
  Expected ANTES do Step 3(b): FAIL — `movE.custo_unitario` é `undefined` (o route passava `itemReq.custo_unitario` cru). DEPOIS do Step 3(b): PASS (`9`, o fallback). Este teste é o RED real da fiação que faltava.

- [ ] **Step 5c — ESCREVER O CENÁRIO E2E (regressão smoke).** Criar `scripts/wms/cenarios/catalogo/83-receber-custo-fallback.ts` (número **83** — o 82 fica reservado pro cenário de P006/Fase 6; ver "Coordenação de numeração" no encerramento):

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 83 — Fallback de custo no recebimento de compra (P104).
 *
 * Produto com custo médio histórico > 0 recebe via compras/receber SEM informar
 * custo_unitario: a entrada deve gravar custo = custo médio histórico (não 0).
 *
 * Papel: regressão smoke do caminho verde end-to-end. O RED da fiação vive no
 * unit src/lib/wms/receber-oc-custo-wiring.test.ts (Step 5). Aqui validamos que
 * o recebimento real não zera o custo médio.
 */

type Setup = { sku: string };

export default {
  nome: "83 — Recebimento de compra sem custo cai pro custo médio histórico (não 0)",
  descricao:
    "Produto com custo médio 10. Recebe via compras/receber sem custo_unitario. " +
    "A entrada usa fallback (10), custo médio não vira 0.",
  tags: ["recebimento", "compras", "custo-medio", "fallback", "P104"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("83");
    await ctx.criarProduto({ sku, descricao: "Custo fallback 83" });
    // Semear saldo com custo 10 → custo médio histórico = 10.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5, custo: 10 });
    return { sku };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Recebe via compras/receber SEM custo_unitario — depende do fallback.
    await ctx.http.post("/api/wms/compras/receber", {
      itens: [{ sku: setup.sku, quantidade_recebida: 5 }],
    });
    await ctx.aguardar(1500);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Custo médio deve permanecer 10 (entrada usou fallback, não 0).
    await ctx.assertCustoMedio(setup.sku, 10, 0.01);
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

- [ ] **Step 5d — RODAR o cenário (regressão verde).** Comando: `npm run scenarios:only -- 83`
  Expected: PASS (`assertCustoMedio` = 10). O RED da fiação já foi provado no unit do Step 5b; este cenário trava a regressão end-to-end.

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**

```yaml
  - id: wms-recebimento-custo-zero-relatorio
    date: "2026-06-05"
    source: wms.compras.receber / wms.receber-oc
    category: business_logic
    message: "Entradas de compra sem custo gravavam custo 0 — valor R$0,00 no relatório"
    cause: >
      compras/receber defaultava custo pra 0 e receber-oc passava custo possivelmente
      ausente; com o guard P108 ativo isso vira RAISE. Sem fallback, recebimento legítimo
      sem custo informado quebrava.
    fix: >
      Helper resolverCustoEntrada: usa custo informado >0, senão custo médio histórico
      (siso_custo_medio), senão rejeita pedindo custo (produto novo). Aplicado em
      compras/receber e receber-oc.
    files:
      - src/lib/wms/custo-fallback.ts
      - src/app/api/wms/compras/receber/route.ts
      - src/lib/wms/receber-oc.ts
    tags: [custo-medio, recebimento, compras, fallback, relatorio]
```

- [ ] **Step 7 — COMMIT.** `git add src/lib/wms/custo-fallback.ts src/lib/wms/custo-fallback.test.ts src/lib/wms/receber-oc-custo-wiring.test.ts src/app/api/wms/compras/receber/route.ts src/lib/wms/receber-oc.ts scripts/wms/cenarios/catalogo/83-receber-custo-fallback.ts erros-conhecidos.yaml && git commit -m "fix(wms): fallback de custo médio nas rotas de entrada de compra [P104]"`

### Task 6.3: `/api/wms/receber` rejeita custo 0 com qty>0 (P104 + P108 — evita 5xx mascarado)

**Files:**
- Modify: `src/app/api/wms/receber/route.ts:53-90` (validação de custo: hoje aceita `0`)
- Test: `src/app/api/wms/receber/receber-custo-zero-400.test.ts`

> **Anco­ragem (verificada):** `receber/route.ts:58` rejeita `custoBody < 0` mas **aceita 0**; `:76-87` exige custo presente por item mas aceita `0`. Com o guard P108 (Task 6.1) ativo, um item `nf_compra` custo=0/qty>0 chega na RPC e dispara o RAISE → `wmsErrorResponse` mascara 5xx pra `internal_error` (500). O achado P104 pede 400 acionável aqui. Mudança cirúrgica: trocar a condição de rejeição de `< 0` pra `<= 0` (custo 0 vira 400 amigável ANTES da RPC). NÃO aplica fallback — o operador manual sempre informa custo; a UX correta é exigir.

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `src/app/api/wms/receber/receber-custo-zero-400.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// requireWarehouseAccess sempre ok; receberEstoque NÃO deve nem ser chamado (rejeitamos antes).
// (a rota usa requireWarehouseAccess, não requireAuth — verificado em receber/route.ts:26).
vi.mock("@/lib/wms/auth", () => ({
  requireWarehouseAccess: async () => ({ ok: true, user: { id: "u1" } }),
  requireAuth: async () => ({ ok: true, user: { id: "u1" } }),
}));
const receberSpy = vi.fn(async () => ({ pendencia_ids: [], lote_id: "l1", mov_ids: [] }));
vi.mock("@/lib/wms/movimentacoes", () => ({ receberEstoque: receberSpy }));
// stubs leves pra o import do route não puxar deps pesadas de putaway/supabase.
vi.mock("@/lib/wms/putaway", () => ({
  sugerirLocalizacaoPutaway: vi.fn(),
  listarLocaisExistentesProduto: vi.fn(),
}));
vi.mock("@/lib/supabase-server", () => ({ createServiceClient: () => ({}) }));

import { POST } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/receber", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/wms/receber — custo 0 com qty>0", () => {
  it("rejeita custo_unitario=0 com 400 (não deixa chegar na RPC e virar 5xx)", async () => {
    const res = await POST(
      makeReq({
        galpao_id: "g1",
        origem_tipo: "nf_compra",
        empresa_compradora_id: "e1",
        fornecedor_id: "f1",
        itens: [{ produto_id: "p1", qty: 5, custo_unitario: 0 }],
      }) as never,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(String(json.error)).toMatch(/custo/i);
    expect(receberSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm test -- receber-custo-zero-400`
  Expected: FAIL — hoje custo 0 passa a validação (`custoItem < 0` é falso pra 0) e `receberEstoque` é chamado (spy invocado), então o status não é 400.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/app/api/wms/receber/route.ts`, endurecer as duas checagens de custo de `< 0` pra `<= 0` quando há qty:

  (a) Validação do body (linha 58): trocar `custoBody < 0` por `custoBody <= 0` e a mensagem:

```ts
  if (custoBody !== null && (!Number.isFinite(custoBody) || custoBody <= 0)) {
    return NextResponse.json(
      { error: "custo_unitario inválido (deve ser numérico > 0)" },
      { status: 400 },
    );
  }
```

  (b) Validação por item (linha 82): trocar `custoItem < 0` por `custoItem <= 0` e a mensagem:

```ts
    if (!Number.isFinite(custoItem) || custoItem <= 0) {
      return NextResponse.json(
        { error: `item ${i + 1}: custo_unitario deve ser > 0` },
        { status: 400 },
      );
    }
```

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm test -- receber-custo-zero-400`
  Expected: PASS (400, `receberEstoque` não chamado). Rodar `npm run lint && npx tsc --noEmit`.

- [ ] **Step 5 — Adicionar entrada em `erros-conhecidos.yaml`.**

```yaml
  - id: wms-receber-custo-zero-5xx
    date: "2026-06-05"
    source: wms.receber
    category: validation
    message: "/api/wms/receber aceitava custo 0; com guard P108 virava 500 mascarado"
    cause: >
      A validação de /api/wms/receber rejeitava custo < 0 mas aceitava 0. Com o guard
      P108 (RPC RAISE em custo 0 com qty>0), o item chegava na RPC e o erro era mascarado
      como internal_error (5xx) em vez de 400 acionável pro operador.
    fix: >
      Endurecer a validação do route pra rejeitar custo <= 0 com qty>0 (400 amigável
      antes da RPC). Não aplica fallback — operador manual sempre informa custo.
    files:
      - src/app/api/wms/receber/route.ts
    tags: [recebimento, custo, validacao, 400, p104, p108]
```

- [ ] **Step 6 — COMMIT.** `git add src/app/api/wms/receber/route.ts src/app/api/wms/receber/receber-custo-zero-400.test.ts erros-conhecidos.yaml && git commit -m "fix(wms): /api/wms/receber rejeita custo 0 com 400 (não 5xx mascarado) [P104]"`

---

## PR 7: Upsert no auto-cadastro de fornecedores por prefixo (contagem correta) [P123]

> `autoCriarFornecedoresDosPrefixosSku` (`fornecedores.ts:328-351`) usa check-then-insert (TOCTOU): sob concorrência ambos veem `jaExiste=null`, ambos inserem, um falha pelo `UNIQUE(nome)` (já existe em `20260522:10`), e a contagem fica errada. O fix é derivar a contagem de forma determinística: descobrir o conjunto pré-existente por nome ANTES, e usar upsert com `ignoreDuplicates`. Sem migration (UNIQUE já existe).

### Task 7.1: autoCriarFornecedoresDosPrefixosSku determinístico via upsert

**Files:**
- Modify: `src/lib/wms/fornecedores.ts:326-353` (loop check-then-insert → contagem prévia + upsert)
- Test: `src/lib/wms/fornecedores.test.ts` (anexar `describe`)

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Anexar ao final de `src/lib/wms/fornecedores.test.ts` (ou criar se inexistente) um `describe` que mocka o supabase pra simular um fornecedor pré-existente e verifica a contagem:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock: "Diversos" já existe; resto não. upsert com ignoreDuplicates não cria
// os que já existem. A contagem deve refletir isso deterministicamente.
const existentesPorNome = new Set<string>(["Diversos"]);

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: () => ({
      select: () => ({
        in: async (_col: string, nomes: string[]) => ({
          data: nomes.filter((n) => existentesPorNome.has(n)).map((nome) => ({ nome })),
        }),
      }),
      upsert: async (rows: Array<{ nome: string }>) => {
        for (const r of rows) existentesPorNome.add(r.nome);
        return { error: null };
      },
    }),
  };
  return { createServiceClient: () => client };
});

import { autoCriarFornecedoresDosPrefixosSku } from "./fornecedores";

describe("autoCriarFornecedoresDosPrefixosSku — contagem determinística", () => {
  beforeEach(() => { existentesPorNome.clear(); existentesPorNome.add("Diversos"); });

  it("conta o pré-existente como existente e o total bate com o PADRAO (12)", async () => {
    const r = await autoCriarFornecedoresDosPrefixosSku();
    expect(r.existentes).toBe(1);
    expect(r.criados).toBe(11);
    expect(r.criados + r.existentes).toBe(12);
  });

  it("2ª chamada não cria nada (todos já existem)", async () => {
    await autoCriarFornecedoresDosPrefixosSku();
    const r2 = await autoCriarFornecedoresDosPrefixosSku();
    expect(r2.criados).toBe(0);
    expect(r2.existentes).toBe(12);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm test -- fornecedores`
  Expected: FAIL — hoje a função faz SELECT por `eq("nome")` + INSERT individual; o mock não tem o método `eq().maybeSingle()` por nome no shape novo, e a contagem é não-determinística (depende do retorno do insert). O teste exige o novo padrão (select `.in()` + `upsert`).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/wms/fornecedores.ts`, substituir o loop (linhas 326-352) por contagem prévia determinística + upsert:

```ts
  // P123: descobre o conjunto pré-existente por nome ANTES (determinístico),
  // depois upserta tudo com ignoreDuplicates. Contagem não depende de corrida.
  const nomes = PADRAO.map((f) => f.nome);
  const { data: existentesRows } = await sb
    .from("siso_fornecedores")
    .select("nome")
    .in("nome", nomes);
  const jaExistem = new Set(
    ((existentesRows ?? []) as Array<{ nome: string }>).map((r) => r.nome),
  );

  const novos = PADRAO.filter((f) => !jaExistem.has(f.nome));
  if (novos.length > 0) {
    const rows = novos.map((f) => {
      const prefixoPrincipal = f.prefixos[0] ?? null;
      const observacoes =
        f.prefixos.length > 1
          ? `prefixos adicionais: ${f.prefixos.slice(1).join(", ")}`
          : f.prefixos.length === 0
            ? "ACA: SKU 6-dígitos numérico (sem prefixo simples)"
            : null;
      return { nome: f.nome, prefixo_sku: prefixoPrincipal, observacoes };
    });
    const { error } = await sb
      .from("siso_fornecedores")
      .upsert(rows, { onConflict: "nome", ignoreDuplicates: true });
    if (error) throw error;
  }

  return { criados: novos.length, existentes: jaExistem.size };
```

  Remover as declarações `let criados = 0;` e `let existentes = 0;` (linhas 326-327) que ficaram órfãs.

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm test -- fornecedores`
  Expected: PASS (existentes=1, criados=11; 2ª chamada criados=0).

- [ ] **Step 5 — Adicionar entrada em `erros-conhecidos.yaml`.**

```yaml
  - id: wms-fornecedores-prefixo-contagem
    date: "2026-06-05"
    source: wms.fornecedores.autoCriar
    category: business_logic
    message: "Duplo clique no auto-cadastro de fornecedores reportava contagem errada"
    cause: >
      autoCriarFornecedoresDosPrefixosSku usava check-then-insert (TOCTOU); a contagem
      só incrementava no insert sem erro, então corridas produziam totais inconsistentes.
    fix: >
      Descobre o conjunto pré-existente por nome (.in) antes, upserta os novos com
      ignoreDuplicates; criados/existentes derivados deterministicamente.
    files:
      - src/lib/wms/fornecedores.ts
    tags: [fornecedores, upsert, contagem, idempotencia, toctou]
```

- [ ] **Step 6 — COMMIT.** `git add src/lib/wms/fornecedores.ts src/lib/wms/fornecedores.test.ts erros-conhecidos.yaml && git commit -m "fix(wms): auto-cadastro de fornecedores via upsert determinístico [P123]"`

---

## PR 8: Recriar MV siso_cobertura_estoque no shape 3D (reverte regressão 20260605) [P128]

> Regressão de ordenação: `20260605_wms_excecoes_dashboards.sql:36-81` (cronologicamente APÓS `20260520f_mviews.sql`) recriou a MV referenciando `empresa_dona_id`, que foi dropado de `siso_estoque`/`siso_movimentacoes` em `20260520_ledger_simplificado.sql`. Num build-from-migrations a MV fica quebrada (coluna inexistente) → REFRESH falha → dashboard de cobertura lê vazio. O consumer (`cobertura.ts`, `insights/estoque/route.ts`) já é 3D. Nova migration DROP+recria a MV idêntica ao bloco 3D de `20260520f_mviews.sql:38-88`.

### Task 8.1: Migration — recriar MV cobertura no shape 3D

**Files:**
- Create: `supabase/migrations/20260607_fix_cobertura_3d.sql`
- Test: `test/integration/cobertura-mv-3d.test.ts`

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/cobertura-mv-3d.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("siso_cobertura_estoque — shape 3D", () => {
  it("wms_refresh_cobertura() roda sem erro", async () => {
    const { error } = await sb.rpc("wms_refresh_cobertura");
    expect(error).toBeNull();
  });

  it("a MV tem (produto_id, galpao_id, status_cobertura) e NÃO tem empresa_dona_id", async () => {
    // SELECT explícito das colunas 3D — falha se empresa_dona_id ainda fizer parte do shape
    const { error: e3d } = await sb
      .from("siso_cobertura_estoque")
      .select("produto_id, galpao_id, status_cobertura, dias_cobertura")
      .limit(1);
    expect(e3d).toBeNull();

    // Selecionar empresa_dona_id deve FALHAR (coluna não existe no shape 3D)
    const { error: eEmpresa } = await sb
      .from("siso_cobertura_estoque")
      .select("empresa_dona_id")
      .limit(1);
    expect(eEmpresa).not.toBeNull();
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** Comando: `npm run test:integration -- cobertura-mv-3d`
  Expected: FAIL se o staging tiver a MV regredida (REFRESH/SELECT 3D falha). > Nota de honestidade: se o staging vivo ainda for a MV 3D de `20260520f` (o `20260605` pode ter falhado ao aplicar), este teste já passa pré-migration — nesse caso, a migration ainda é OBRIGATÓRIA porque o ARQUIVO `20260605` quebra qualquer rebuild from-scratch; tratamos a migration como reforço idempotente.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607_fix_cobertura_3d.sql`:

```sql
-- P128 — recria siso_cobertura_estoque no shape 3D (produto+galpão, sem
-- empresa_dona_id), revertendo a regressão de 20260605_wms_excecoes_dashboards.sql
-- (que reintroduziu empresa_dona_id, dropado do ledger em 20260520_ledger_simplificado).
-- Réplica fiel de 20260520f_mviews.sql:38-88 — origem_tipo IN ('nf_venda','venda_manual').

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS siso_cobertura_estoque;

CREATE MATERIALIZED VIEW siso_cobertura_estoque AS
WITH giro_30d AS (
  SELECT produto_id, galpao_id,
         SUM(quantidade) / 30.0 AS giro_diario
  FROM siso_movimentacoes
  WHERE tipo = 'S'
    AND origem_tipo IN ('nf_venda','venda_manual')
    AND criado_em >= now() - interval '30 days'
    AND estorno_de IS NULL
  GROUP BY produto_id, galpao_id
),
saldo_agregado AS (
  SELECT produto_id, galpao_id,
         SUM(disponivel) AS disponivel_total
  FROM siso_estoque
  GROUP BY produto_id, galpao_id
),
lead_pref AS (
  SELECT pf.produto_id, pf.lead_time_dias_medio
  FROM siso_produto_fornecedores pf
  WHERE pf.preferencial = true AND pf.ativo = true
)
SELECT
  s.produto_id,
  s.galpao_id,
  s.disponivel_total,
  COALESCE(g.giro_diario, 0) AS giro_diario,
  CASE WHEN g.giro_diario > 0
       THEN s.disponivel_total / g.giro_diario
       ELSE NULL END AS dias_cobertura,
  lp.lead_time_dias_medio AS lead_time_medio,
  CASE
    WHEN g.giro_diario IS NULL OR g.giro_diario = 0 THEN 'sem_giro'
    WHEN s.disponivel_total / g.giro_diario < 7 THEN 'critico'
    WHEN s.disponivel_total / g.giro_diario < 14 THEN 'atencao'
    WHEN lp.lead_time_dias_medio IS NOT NULL
      AND s.disponivel_total / g.giro_diario < lp.lead_time_dias_medio THEN 'lead_time_risco'
    ELSE 'ok'
  END AS status_cobertura
FROM saldo_agregado s
LEFT JOIN giro_30d g USING (produto_id, galpao_id)
LEFT JOIN lead_pref lp USING (produto_id);

CREATE UNIQUE INDEX uq_cobertura
  ON siso_cobertura_estoque(produto_id, galpao_id);
CREATE INDEX idx_cobertura_status
  ON siso_cobertura_estoque(status_cobertura, dias_cobertura);

CREATE OR REPLACE FUNCTION wms_refresh_cobertura() RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW siso_cobertura_estoque;
$$;

COMMIT;
```

- [ ] **Step 3b — Aplicar a migration.** Via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `fix_cobertura_3d`.

- [ ] **Step 4 — RODAR e ver passar.** Comando: `npm run test:integration -- cobertura-mv-3d`
  Expected: PASS (refresh OK; colunas 3D presentes; `empresa_dona_id` ausente → select daquela coluna erra).

- [ ] **Step 5 — Adicionar entrada em `erros-conhecidos.yaml`.**

```yaml
  - id: wms-cobertura-mv-regressao-4d
    date: "2026-06-05"
    source: wms.cobertura
    category: database
    message: "Dashboard de cobertura zerado/quebrado — MV referenciava empresa_dona_id inexistente"
    cause: >
      20260605_wms_excecoes_dashboards.sql (commitado após 20260520f_mviews.sql) recriou
      siso_cobertura_estoque com empresa_dona_id, dropado do ledger em 20260520_ledger_simplificado.
      Em rebuild from-migrations a MV quebra (coluna inexistente) → REFRESH falha.
    fix: >
      Nova migration 20260607_fix_cobertura_3d.sql DROP+recria a MV no shape 3D
      (produto+galpão, origem nf_venda/venda_manual), espelhando 20260520f.
    files:
      - supabase/migrations/20260607_fix_cobertura_3d.sql
    tags: [cobertura, materialized-view, 3d, regressao, dashboard]
```

- [ ] **Step 6 — COMMIT.** `git add supabase/migrations/20260607_fix_cobertura_3d.sql test/integration/cobertura-mv-3d.test.ts erros-conhecidos.yaml && git commit -m "fix(wms): recria MV siso_cobertura_estoque no shape 3D [P128]"`

---

## Coordenação de numeração de cenários (entre fases)

> O catálogo `scripts/wms/cenarios/catalogo/NN-*.ts` é flat e compartilhado por TODAS as fases — números colidem se duas fases escolherem o mesmo NN. Highest atual = **81** (`81-receber-oc-destrava-pedido.ts`).
>
> **Reservas vinculantes:**
> - **82** — reservado pro cenário de **P006** (Fase 6: `82-marcar-item-falha-registra-erro-historico.ts`). **NÃO usar nesta fase.**
> - **83** — esta fase (P104): `83-receber-custo-fallback.ts`.
>
> Ao executar, se 82 ou 83 já existirem no working tree de outra branch/worktree, escolher o próximo NN livre e ajustar o nome do arquivo + o comando `scenarios:only` correspondente. O número é só rótulo de catálogo (não há FK).

---

## Encerramento da fase

- [ ] Rodar a suíte completa: `npm test && npm run test:integration` (e, se houver dev server, `npm run scenarios:only -- 83`).
- [ ] Atualizar `docs/database-schema.md` (novos índices `uq_mov_estorno_unico`, `idx_pf_preferencial` UNIQUE, `uq_inv_sessao_galpao_dia`, `uq_mov_recebimento_nf_chave` + `uq_mov_recebimento_nf_id`; trigger `wms_kit_exige_componente`; RPC `wms_inserir_movimentacao` recriada com guards; MV `siso_cobertura_estoque` 3D) no mesmo commit de encerramento.
- [ ] Confirmar que `erros-conhecidos.yaml` tem as 9 entradas novas (P106; P124/P125; P055; P120; P099/P109; P108/P110; P104 — fallback (compras/receber+receber-oc) E hardening (/api/wms/receber); P123; P128).
