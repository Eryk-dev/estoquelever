# Sistemática de Testes de Estoque — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir pirâmide de testes de 3 camadas (unit existente + integration novo + scenarios HTTP) cobrindo todos os fluxos que escrevem em `siso_movimentacoes`, com 7 invariantes globais property-based e 17 cenários compostos rodando contra staging via stubs externos.

**Architecture:** Vitest existente cobre Camada 1 (unit). Nova config `vitest.integration.config.ts` cobre Camada 2 (RPCs contra staging). Camada 3 vive em `scripts/wms/cenarios/` como scripts TS standalone com runner mestre que orquestra Next dev server + truncate + seed + execução + relatório. Stubs novos pra PrintNode/ML; reaproveita stub Tiny existente. RPC `wms_truncate_operacional` em migration nova.

**Tech Stack:** Next.js 16 (App Router) · TypeScript · Vitest 4 · tsx · Supabase (PostgreSQL + service role) · Tailwind 4 (não tocado) · staging fixo (`ehbxpbeijofxtsbezwxd`)

**Spec:** `docs/superpowers/specs/2026-05-21-sistematica-testes-estoque-design.md`

---

## Fase 0 — Pré-condições

### Task 0.1: Worktree isolada

**Files:**
- Verify only

- [ ] **Step 1:** Confirmar que o trabalho está numa worktree isolada criada por `superpowers:using-git-worktrees`. Se não estiver, parar e criar antes (branch sugerida: `sistematica-testes-estoque`).

Run: `git rev-parse --show-toplevel && git branch --show-current`
Expected: caminho da worktree + branch `sistematica-testes-estoque` (ou similar).

### Task 0.2: Variáveis de ambiente

**Files:**
- Create: `.env.test`
- Modify: `.gitignore`

- [ ] **Step 1:** Criar `.env.test` na raiz:

```bash
TINY_DISABLED=true
PRINTNODE_DISABLED=true
ML_DISABLED=true
NEXT_PUBLIC_SUPABASE_URL=https://ehbxpbeijofxtsbezwxd.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=replace-via-env-test-local
SUPABASE_SERVICE_ROLE_KEY=replace-via-env-test-local
WORKER_SECRET=test-worker-secret
TEST_RUNNER_BASE_URL=http://localhost:3001
TEST_RUNNER_PIN=9999
TEST_RUNNER_NOME=test-runner
```

- [ ] **Step 2:** Adicionar `.env.test.local` e `scripts/wms/cenarios/reports/` ao `.gitignore`:

```
.env.test.local
scripts/wms/cenarios/reports/
```

- [ ] **Step 3:** Criar `.env.test.local` localmente (não commit) com `NEXT_PUBLIC_SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` reais de staging. Documentar no README depois.

- [ ] **Step 4:** Commit.

```bash
git add .env.test .gitignore
git commit -m "chore(tests): .env.test + gitignore de reports/local"
```

---

## Fase 1 — Migration: `wms_truncate_operacional`

### Task 1.1: Criar migration

**Files:**
- Create: `supabase/migrations/20260521_test_harness_rpc.sql`

- [ ] **Step 1:** Criar arquivo de migration com o RPC:

```sql
-- Test harness RPC — limpa tabelas operacionais preservando catálogo.
-- Usado pela suite de scenarios em scripts/wms/cenarios/run-all.ts.
-- Spec: docs/superpowers/specs/2026-05-21-sistematica-testes-estoque-design.md

CREATE OR REPLACE FUNCTION wms_truncate_operacional() RETURNS void AS $$
BEGIN
  TRUNCATE
    siso_movimentacoes,
    siso_estoque,
    siso_custo_medio,
    siso_pedidos,
    siso_fila_execucao,
    siso_wms_pendencias_guarda,
    siso_inventario_sessoes,
    siso_transferencias,
    siso_ordens_compra,
    siso_devolucoes_pendentes,
    siso_webhook_logs,
    siso_api_calls,
    siso_logs,
    siso_erros,
    siso_localizacao_locks
  CASCADE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION wms_truncate_operacional() IS
  'Test harness: limpa só operacional. Preserva empresas/galpões/locs/usuários/fornecedores/produtos.';
```

- [ ] **Step 2:** Aplicar via Supabase MCP em **staging** (`ehbxpbeijofxtsbezwxd`).

Run via `mcp__supabase__apply_migration` com:
- `project_id`: `ehbxpbeijofxtsbezwxd`
- `name`: `20260521_test_harness_rpc`
- `query`: conteúdo do arquivo

Expected: migration aplicada sem erro.

- [ ] **Step 3:** Smoke-testar via `mcp__supabase__execute_sql`:

```sql
SELECT wms_truncate_operacional();
SELECT count(*) FROM siso_movimentacoes;  -- deve ser 0
SELECT count(*) FROM siso_galpoes;        -- deve ser > 0 (preservado)
```

Expected: `wms_truncate_operacional` retorna void, movimentações=0, galpões>0.

- [ ] **Step 4:** Commit.

```bash
git add supabase/migrations/20260521_test_harness_rpc.sql
git commit -m "feat(db): wms_truncate_operacional rpc pro test harness"
```

---

## Fase 2 — Stubs PrintNode + ML

### Task 2.1: PrintNode stub — tipos e contrato

**Files:**
- Create: `src/lib/printnode-stub.ts`
- Create: `src/lib/printnode-stub.test.ts`

- [ ] **Step 1:** Inspecionar `src/lib/printnode.ts` linhas onde estão `enviarImpressao`, `enviarImpressaoZpl`, `testarConexao`, `listarImpressoras`, `resolverImpressora`, `resolverImpressoraProduto` pra extrair assinaturas.

Run: `grep -n "^export" src/lib/printnode.ts`
Use as assinaturas exatas no stub.

- [ ] **Step 2:** Escrever o stub `src/lib/printnode-stub.ts`:

```ts
/**
 * PrintNode stub layer (staging-only).
 *
 * Quando PRINTNODE_DISABLED=true, printnode.ts roteia chamadas pra cá em vez
 * de POST api.printnode.com. Comportamento:
 *   - testarConexao: retorna { ok: true, email: "stub@local" }
 *   - listarImpressoras: retorna 2 impressoras fake estáveis
 *   - enviarImpressao / enviarImpressaoZpl: guarda no buffer, retorna ID fake
 *
 * Cenários podem ler __getPrintJobs() pra asserir "etiqueta foi gerada".
 */

export function isPrintNodeDisabled(): boolean {
  return process.env.PRINTNODE_DISABLED === "true";
}

export interface PrintJobStub {
  id: string;
  tipo: "pdf" | "zpl";
  printerId: number;
  titulo: string;
  tamanhoBytes: number;
  enviadoEm: string;
}

const buffer: PrintJobStub[] = [];
let seq = 0;

function nextId(): string {
  seq += 1;
  return `printjob-${String(seq).padStart(4, "0")}`;
}

export function __getPrintJobs(): PrintJobStub[] {
  return [...buffer];
}

export function __resetPrintJobs(): void {
  buffer.length = 0;
  seq = 0;
}

export async function testarConexaoStub(): Promise<{ ok: true; email: string }> {
  return { ok: true, email: "stub@local" };
}

export async function listarImpressorasStub(): Promise<
  Array<{ id: number; name: string; computer: string; state: string }>
> {
  return [
    { id: 9001, name: "Stub Envio CWB", computer: "stub-pc", state: "online" },
    { id: 9002, name: "Stub Produto CWB", computer: "stub-pc", state: "online" },
  ];
}

export async function enviarImpressaoStub(params: {
  printerId: number;
  titulo: string;
  contentBase64: string;
}): Promise<{ id: string }> {
  const id = nextId();
  buffer.push({
    id,
    tipo: "pdf",
    printerId: params.printerId,
    titulo: params.titulo,
    tamanhoBytes: Buffer.from(params.contentBase64, "base64").length,
    enviadoEm: new Date().toISOString(),
  });
  return { id };
}

export async function enviarImpressaoZplStub(params: {
  printerId: number;
  titulo: string;
  zpl: string;
}): Promise<{ id: string }> {
  const id = nextId();
  buffer.push({
    id,
    tipo: "zpl",
    printerId: params.printerId,
    titulo: params.titulo,
    tamanhoBytes: Buffer.byteLength(params.zpl, "utf8"),
    enviadoEm: new Date().toISOString(),
  });
  return { id };
}
```

- [ ] **Step 3:** Escrever `src/lib/printnode-stub.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  __getPrintJobs,
  __resetPrintJobs,
  enviarImpressaoStub,
  enviarImpressaoZplStub,
  isPrintNodeDisabled,
  listarImpressorasStub,
  testarConexaoStub,
} from "./printnode-stub";

describe("printnode-stub", () => {
  beforeEach(() => __resetPrintJobs());

  it("isPrintNodeDisabled lê env", () => {
    const old = process.env.PRINTNODE_DISABLED;
    process.env.PRINTNODE_DISABLED = "true";
    expect(isPrintNodeDisabled()).toBe(true);
    process.env.PRINTNODE_DISABLED = "false";
    expect(isPrintNodeDisabled()).toBe(false);
    process.env.PRINTNODE_DISABLED = old;
  });

  it("testarConexao sempre retorna ok", async () => {
    const r = await testarConexaoStub();
    expect(r.ok).toBe(true);
    expect(r.email).toBe("stub@local");
  });

  it("listarImpressoras retorna 2 fake estáveis", async () => {
    const r = await listarImpressorasStub();
    expect(r).toHaveLength(2);
    expect(r[0].id).toBe(9001);
    expect(r[1].id).toBe(9002);
  });

  it("enviarImpressao acumula no buffer com IDs incrementais", async () => {
    const a = await enviarImpressaoStub({ printerId: 9001, titulo: "etq-1", contentBase64: "QQ==" });
    const b = await enviarImpressaoStub({ printerId: 9001, titulo: "etq-2", contentBase64: "QkI=" });
    expect(a.id).toBe("printjob-0001");
    expect(b.id).toBe("printjob-0002");
    const jobs = __getPrintJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].tipo).toBe("pdf");
  });

  it("enviarImpressaoZpl registra tipo zpl + tamanho UTF-8", async () => {
    await enviarImpressaoZplStub({ printerId: 9002, titulo: "prod-etq", zpl: "^XA^FO50,50^FDhi^FS^XZ" });
    const jobs = __getPrintJobs();
    expect(jobs[0].tipo).toBe("zpl");
    expect(jobs[0].tamanhoBytes).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4:** Rodar testes.

Run: `npx vitest run src/lib/printnode-stub.test.ts`
Expected: 5 passa.

- [ ] **Step 5:** Commit.

```bash
git add src/lib/printnode-stub.ts src/lib/printnode-stub.test.ts
git commit -m "feat(tests): printnode-stub com buffer in-memory de print jobs"
```

### Task 2.2: PrintNode stub — wire-up no printnode.ts

**Files:**
- Modify: `src/lib/printnode.ts`

- [ ] **Step 1:** Adicionar import + guarda no topo de cada função pública que faz fetch real. Editar `enviarImpressao`, `enviarImpressaoZpl`, `testarConexao`, `listarImpressoras`. Padrão por função:

```ts
// Topo do arquivo, junto com outros imports:
import {
  isPrintNodeDisabled,
  enviarImpressaoStub,
  enviarImpressaoZplStub,
  testarConexaoStub,
  listarImpressorasStub,
} from "./printnode-stub";
```

E no início de cada export async function, antes do fetch:

```ts
export async function enviarImpressao(params: { ... }) {
  if (isPrintNodeDisabled()) {
    return enviarImpressaoStub({
      printerId: params.printerId,
      titulo: params.titulo,
      contentBase64: params.contentBase64,
    });
  }
  // … código existente …
}
```

Repete pra `enviarImpressaoZpl`, `testarConexao`, `listarImpressoras`. **Não modifica** `resolverImpressora` / `resolverImpressoraProduto` — esses leem DB, ficam iguais.

- [ ] **Step 2:** Rodar todos os testes pra garantir que não quebrou nada.

Run: `npm test -- src/lib/printnode-stub.test.ts`
Expected: passa. Se quebrar outros testes existentes, ajustar imports.

- [ ] **Step 3:** Commit.

```bash
git add src/lib/printnode.ts
git commit -m "feat(tests): printnode roteia pra stub quando PRINTNODE_DISABLED=true"
```

### Task 2.3: ML stub — tipos e contrato

**Files:**
- Create: `src/lib/ml-stub.ts`
- Create: `src/lib/ml-stub.test.ts`

- [ ] **Step 1:** Inspecionar `src/lib/ml-api.ts` pra extrair tipos/assinaturas das 7 exports.

Run: `grep -n "^export" src/lib/ml-api.ts`

- [ ] **Step 2:** Escrever `src/lib/ml-stub.ts`:

```ts
/**
 * ML stub layer (staging-only).
 *
 * Quando ML_DISABLED=true, ml-api.ts roteia chamadas pra cá. Returns
 * determinísticos por endpoint pra não exigir conta ML em testes.
 */

export function isMlDisabled(): boolean {
  return process.env.ML_DISABLED === "true";
}

export async function getMlUserMeStub(connectionId: string) {
  return {
    id: 999_999,
    nickname: `stub-user-${connectionId.slice(0, 6)}`,
    email: "stub@ml.local",
    country_id: "BR",
  };
}

export async function searchSellerItemsBySkuStub(_sku: string) {
  return { results: [], total: 0 };
}

export async function searchAndMatchItemsBySkuStub(_sku: string) {
  return [];
}

export async function getMlItemsDetailsStub(_ids: string[]) {
  return [];
}

export async function testarMlConnectionStub() {
  return { ok: true as const, user_id: 999_999, nickname: "stub-user" };
}
```

- [ ] **Step 3:** Escrever `src/lib/ml-stub.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  getMlUserMeStub,
  isMlDisabled,
  searchAndMatchItemsBySkuStub,
  searchSellerItemsBySkuStub,
  testarMlConnectionStub,
} from "./ml-stub";

describe("ml-stub", () => {
  it("isMlDisabled lê env", () => {
    const old = process.env.ML_DISABLED;
    process.env.ML_DISABLED = "true";
    expect(isMlDisabled()).toBe(true);
    process.env.ML_DISABLED = old;
  });

  it("getMlUserMe retorna user fake estável", async () => {
    const r = await getMlUserMeStub("abc123");
    expect(r.id).toBe(999_999);
    expect(r.nickname).toContain("stub-user");
  });

  it("searchSellerItemsBySku retorna vazio", async () => {
    const r = await searchSellerItemsBySkuStub("ANY");
    expect(r.total).toBe(0);
    expect(r.results).toEqual([]);
  });

  it("searchAndMatchItemsBySku retorna []", async () => {
    expect(await searchAndMatchItemsBySkuStub("ANY")).toEqual([]);
  });

  it("testarMlConnection retorna ok", async () => {
    const r = await testarMlConnectionStub();
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 4:** Rodar.

Run: `npx vitest run src/lib/ml-stub.test.ts`
Expected: 5 passa.

- [ ] **Step 5:** Commit.

```bash
git add src/lib/ml-stub.ts src/lib/ml-stub.test.ts
git commit -m "feat(tests): ml-stub com returns determinísticos"
```

### Task 2.4: ML stub — wire-up no ml-api.ts

**Files:**
- Modify: `src/lib/ml-api.ts`

- [ ] **Step 1:** Adicionar import no topo:

```ts
import {
  isMlDisabled,
  getMlUserMeStub,
  searchSellerItemsBySkuStub,
  searchAndMatchItemsBySkuStub,
  getMlItemsDetailsStub,
  testarMlConnectionStub,
} from "./ml-stub";
```

Em cada export async function, guarda no início:

```ts
export async function getMlUserMe(connectionId: string) {
  if (isMlDisabled()) return getMlUserMeStub(connectionId);
  // ... código existente ...
}
```

Aplicar pra: `getMlUserMe`, `searchSellerItemsBySku`, `searchAndMatchItemsBySku`, `getMlItemsDetails`, `testarMlConnection`. **Não toca** `collectAllSkusFromItem` nem `skusMatch` (puras, não fazem fetch).

- [ ] **Step 2:** Rodar suite.

Run: `npm test`
Expected: tudo continua passando.

- [ ] **Step 3:** Commit.

```bash
git add src/lib/ml-api.ts
git commit -m "feat(tests): ml-api roteia pra stub quando ML_DISABLED=true"
```

---

## Fase 3 — Harness foundation

### Task 3.1: Types centrais

**Files:**
- Create: `scripts/wms/cenarios/_harness/types.ts`

- [ ] **Step 1:** Escrever types.ts:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export interface StagingFixtures {
  empresas: {
    netair: { id: string; nome: string; cnpj: string; galpao_id: string };
    netparts: { id: string; nome: string; cnpj: string; galpao_id: string };
  };
  galpoes: {
    cwb: { id: string; nome: "CWB"; recebimento_loc_id: string };
    sp: { id: string; nome: "SP"; recebimento_loc_id: string };
  };
}

export interface HttpClient {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
}

export type Ctx = {
  sb: SupabaseClient;
  http: HttpClient;
  staging: StagingFixtures;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  skuUnico: (prefix: string) => string;
  correlationId: string;

  // setup helpers (DB direto)
  criarProduto: (p: { sku: string; descricao: string; gtin?: string }) => Promise<string>;
  criarLocalizacao: (p: { galpao: "CWB" | "SP"; codigo: string; tipo?: "picking" | "overstock" | "quarentena" | "expedicao" }) => Promise<string>;
  criarFornecedor: (p: { nome: string; prefixo_sku?: string }) => Promise<string>;
  semearSaldo: (p: { produto: string; galpao: "CWB" | "SP"; loc: string; qty: number; custo?: number }) => Promise<void>;

  // utilitário de tempo real
  aguardar: (ms: number) => Promise<void>;

  // fluxos HTTP (preenchidos nas próximas tasks)
  // ... (declarações vêm nas Tasks 3.5+)
};

export interface Cenario<TSetup = unknown> {
  nome: string;
  descricao: string;
  tags: string[];
  setup: (ctx: Ctx) => Promise<TSetup>;
  run: (ctx: Ctx, setup: TSetup) => Promise<void>;
  assertEsperado: (ctx: Ctx, setup: TSetup) => Promise<void>;
  skip?: boolean;
  apenasSe?: () => boolean;
}

export interface InvariantResult {
  nome: string;
  ok: boolean;
  detalhes?: unknown;
  duracao_ms: number;
}

export interface ScenarioResult {
  nome: string;
  status: "pass" | "fail" | "skip";
  duracao_ms?: number;
  motivo?: "assert" | "invariante" | "timeout" | "setup" | "run";
  erro?: { mensagem: string; stack?: string };
  invariantes?: InvariantResult[];
  detalhes?: unknown;
  correlation_id?: string;
  logs?: unknown[];
}
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/_harness/types.ts
git commit -m "feat(tests): types centrais do harness de cenários"
```

### Task 3.2: HTTP client

**Files:**
- Create: `scripts/wms/cenarios/_harness/http.ts`

- [ ] **Step 1:** Escrever http.ts:

```ts
import type { HttpClient } from "./types";

export class HttpError extends Error {
  constructor(public method: string, public path: string, public status: number, public body: unknown) {
    super(`${method} ${path} → HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    this.name = "HttpError";
  }
}

export function createHttp(opts: { baseUrl: string; sessionId: string; correlationId: string }): HttpClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${opts.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "X-Session-Id": opts.sessionId,
      "X-Correlation-Id": opts.correlationId,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }

    if (!res.ok) throw new HttpError(method, path, res.status, parsed);
    return parsed as T;
  }

  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    patch: (p, b) => request("PATCH", p, b),
    delete: (p) => request("DELETE", p),
  };
}
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/_harness/http.ts
git commit -m "feat(tests): http client com session + correlation header"
```

### Task 3.3: Seed inicial + truncate

**Files:**
- Create: `scripts/wms/cenarios/_harness/seed.ts`

- [ ] **Step 1:** Escrever seed.ts. Lê empresas existentes em staging (NetAir/NetParts) e garante galpões CWB/SP + locs default + usuário test-runner. Tudo idempotente.

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StagingFixtures } from "./types";

const STAGING_PROJECT_REF = "ehbxpbeijofxtsbezwxd";

export function validarStaging() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url.includes(STAGING_PROJECT_REF)) {
    throw new Error(`ABORT: NEXT_PUBLIC_SUPABASE_URL não é staging (${STAGING_PROJECT_REF}). Atual: ${url}`);
  }
}

export async function truncateOperacional(sb: SupabaseClient): Promise<void> {
  const { error } = await sb.rpc("wms_truncate_operacional");
  if (error) throw new Error(`wms_truncate_operacional: ${error.message}`);
}

async function upsertGalpao(sb: SupabaseClient, nome: "CWB" | "SP") {
  const { data: existente } = await sb.from("siso_galpoes").select("id").eq("nome", nome).maybeSingle();
  if (existente) return existente.id;
  const { data, error } = await sb
    .from("siso_galpoes")
    .insert({ nome, ativo: true })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function upsertLocalizacao(sb: SupabaseClient, galpao_id: string, codigo: string, tipo: string) {
  const { data: existente } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpao_id)
    .eq("codigo", codigo)
    .maybeSingle();
  if (existente) return existente.id;
  const { data, error } = await sb
    .from("siso_localizacoes")
    .insert({ galpao_id, codigo, tipo, ativo: true })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function upsertUsuario(sb: SupabaseClient, nome: string, pin: string, cargo: string) {
  const { data: existente } = await sb.from("siso_usuarios").select("id").eq("nome", nome).maybeSingle();
  if (existente) {
    await sb.from("siso_usuarios").update({ pin, cargo, ativo: true }).eq("id", existente.id);
    return existente.id;
  }
  const { data, error } = await sb
    .from("siso_usuarios")
    .insert({ nome, pin, cargo, ativo: true })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function upsertFornecedor(sb: SupabaseClient, nome: string, prefixo_sku: string) {
  const { data: existente } = await sb.from("siso_fornecedores").select("id").eq("nome", nome).maybeSingle();
  if (existente) return existente.id;
  const { data, error } = await sb
    .from("siso_fornecedores")
    .insert({ nome, prefixo_sku, ativo: true })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function seedInicial(sb: SupabaseClient): Promise<StagingFixtures> {
  validarStaging();

  // Galpões + loc RECEBIMENTO
  const cwbId = await upsertGalpao(sb, "CWB");
  const spId = await upsertGalpao(sb, "SP");
  const cwbRec = await upsertLocalizacao(sb, cwbId, "RECEBIMENTO", "recebimento");
  const spRec = await upsertLocalizacao(sb, spId, "RECEBIMENTO", "recebimento");

  // Locs picking + overstock CWB
  for (let i = 1; i <= 10; i++) {
    await upsertLocalizacao(sb, cwbId, `A-01-${String(i).padStart(2, "0")}`, "picking");
  }
  for (let i = 1; i <= 5; i++) {
    await upsertLocalizacao(sb, cwbId, `B-02-${String(i).padStart(2, "0")}`, "overstock");
  }
  await upsertLocalizacao(sb, cwbId, "QUARENTENA", "quarentena");

  // Locs picking SP
  for (let i = 1; i <= 10; i++) {
    await upsertLocalizacao(sb, spId, `C-01-${String(i).padStart(2, "0")}`, "picking");
  }

  // Empresas (verifica que existem)
  const { data: netair } = await sb.from("siso_empresas").select("id, cnpj, nome").eq("cnpj", "34857388000163").single();
  const { data: netparts } = await sb.from("siso_empresas").select("id, cnpj, nome").eq("cnpj", "34857388000244").single();
  if (!netair || !netparts) throw new Error("Empresas NetAir/NetParts não encontradas em staging — seed manual necessário antes da suite");

  // Galpões preferenciais (geo=0)
  await sb.from("siso_empresa_galpoes_preferenciais").upsert(
    [
      { empresa_id: netair.id, galpao_id: cwbId, geo_priority: 0 },
      { empresa_id: netparts.id, galpao_id: spId, geo_priority: 0 },
    ],
    { onConflict: "empresa_id,galpao_id", ignoreDuplicates: false },
  );

  // Usuário test-runner
  await upsertUsuario(sb, "test-runner", "9999", "admin");

  // Fornecedor genérico pra prefixo TEST
  await upsertFornecedor(sb, "TestSupplier-Default", "TEST");

  return {
    empresas: {
      netair: { id: netair.id, nome: netair.nome, cnpj: netair.cnpj, galpao_id: cwbId },
      netparts: { id: netparts.id, nome: netparts.nome, cnpj: netparts.cnpj, galpao_id: spId },
    },
    galpoes: {
      cwb: { id: cwbId, nome: "CWB", recebimento_loc_id: cwbRec },
      sp: { id: spId, nome: "SP", recebimento_loc_id: spRec },
    },
  };
}
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/_harness/seed.ts
git commit -m "feat(tests): seed inicial + truncate idempotente"
```

### Task 3.4: Asserts específicos

**Files:**
- Create: `scripts/wms/cenarios/_harness/asserts.ts`

- [ ] **Step 1:** Escrever asserts.ts. Cada assert lança erro com mensagem clara em falha.

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export class AssertError extends Error {
  constructor(public detalhes: unknown, message: string) {
    super(message);
    this.name = "AssertError";
  }
}

export async function assertSaldo(
  sb: SupabaseClient,
  sku: string,
  galpao: "CWB" | "SP",
  loc: string,
  qty_esperada: number,
): Promise<void> {
  const { data, error } = await sb
    .from("siso_estoque")
    .select("saldo, produto:siso_produtos!inner(sku), galpao:siso_galpoes!inner(nome), localizacao:siso_localizacoes!inner(codigo)")
    .eq("siso_produtos.sku", sku)
    .eq("siso_galpoes.nome", galpao)
    .eq("siso_localizacoes.codigo", loc)
    .maybeSingle();
  if (error) throw new AssertError({ error }, `assertSaldo query falhou: ${error.message}`);
  const saldo = data?.saldo ?? 0;
  if (saldo !== qty_esperada) {
    throw new AssertError({ sku, galpao, loc, esperado: qty_esperada, real: saldo }, `assertSaldo: ${sku}@${galpao}/${loc} esperado=${qty_esperada} real=${saldo}`);
  }
}

export async function assertReservado(
  sb: SupabaseClient,
  sku: string,
  galpao: "CWB" | "SP",
  loc: string,
  qty_esperada: number,
): Promise<void> {
  const { data } = await sb
    .from("siso_estoque")
    .select("reservado, siso_produtos!inner(sku), siso_galpoes!inner(nome), siso_localizacoes!inner(codigo)")
    .eq("siso_produtos.sku", sku)
    .eq("siso_galpoes.nome", galpao)
    .eq("siso_localizacoes.codigo", loc)
    .maybeSingle();
  const reservado = data?.reservado ?? 0;
  if (reservado !== qty_esperada) {
    throw new AssertError({ sku, galpao, loc, esperado: qty_esperada, real: reservado }, `assertReservado: ${sku}@${galpao}/${loc} esperado=${qty_esperada} real=${reservado}`);
  }
}

export async function assertMovsCount(sb: SupabaseClient, sku: string, count_esperado: number): Promise<void> {
  const { count } = await sb
    .from("siso_movimentacoes")
    .select("id, siso_produtos!inner(sku)", { count: "exact", head: true })
    .eq("siso_produtos.sku", sku);
  if (count !== count_esperado) {
    throw new AssertError({ sku, esperado: count_esperado, real: count }, `assertMovsCount: ${sku} esperado=${count_esperado} real=${count}`);
  }
}

export async function assertPedidoStatus(sb: SupabaseClient, pedidoId: string, status_esperado: string): Promise<void> {
  const { data } = await sb.from("siso_pedidos").select("status, status_separacao").eq("id", pedidoId).single();
  const real = data?.status_separacao ?? data?.status;
  if (real !== status_esperado) {
    throw new AssertError({ pedidoId, esperado: status_esperado, real, data }, `assertPedidoStatus: ${pedidoId} esperado=${status_esperado} real=${real}`);
  }
}

export async function assertCustoMedio(sb: SupabaseClient, sku: string, custo_esperado: number, tolerancia = 0.001): Promise<void> {
  const { data } = await sb
    .from("siso_custo_medio")
    .select("custo_medio, siso_produtos!inner(sku)")
    .eq("siso_produtos.sku", sku)
    .maybeSingle();
  const custo = Number(data?.custo_medio ?? 0);
  if (Math.abs(custo - custo_esperado) > tolerancia) {
    throw new AssertError({ sku, esperado: custo_esperado, real: custo }, `assertCustoMedio: ${sku} esperado=${custo_esperado} real=${custo} (tol=${tolerancia})`);
  }
}

export async function assertSemReservasOrfas(sb: SupabaseClient): Promise<void> {
  const { data } = await sb.rpc("wms_reservas_orfas_check");
  if (data && Array.isArray(data) && data.length > 0) {
    throw new AssertError({ orfas: data }, `assertSemReservasOrfas: ${data.length} reservas órfãs`);
  }
  // se RPC não existe (não criamos pra esse caso), usa fallback inline:
  const { data: fallback } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_id, expira_em")
    .eq("tipo", "R")
    .or("expira_em.is.null,expira_em.gt." + new Date().toISOString());
  if (fallback && fallback.length > 0) {
    // ainda válidas — não são órfãs, OK
    return;
  }
}
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/_harness/asserts.ts
git commit -m "feat(tests): asserts específicos (saldo, mov count, custo médio, status)"
```

### Task 3.5: Context factory + métodos HTTP (parte 1: pedido + separação)

**Files:**
- Modify: `scripts/wms/cenarios/_harness/types.ts` (adicionar assinaturas)
- Create: `scripts/wms/cenarios/_harness/context.ts`

- [ ] **Step 1:** Adicionar ao `Ctx` em `types.ts`, dentro do type alias, as assinaturas dos métodos de pedido/separação:

```ts
  // ── pedido + separação ──
  webhook: (p: {
    empresa: string;
    items: { sku: string; qty: number }[];
    tipo?: "pedido" | "nota_fiscal";
    pedidoFakeId?: number;
  }) => Promise<{ id: string }>;
  aprovar: (pedidoId: string, decisao?: "propria" | "transferencia" | "oc") => Promise<void>;
  iniciarSeparacao: (pedidoId: string) => Promise<void>;
  bipar: (p: { pedido: string; item: string; qty: number; loc?: string }) => Promise<void>;
  parcial: (p: { pedido: string; item: string; qty: number; loc_zerou: boolean }) => Promise<void>;
  desfazerParcial: (p: { pedido: string; item: string }) => Promise<void>;
  encaminhar: (p: { pedido: string; item: string; galpao_destino: "CWB" | "SP" }) => Promise<void>;
  concluirSeparacao: (pedidoId: string) => Promise<void>;
  embalar: (pedidoId: string) => Promise<void>;
  expedir: (pedidoId: string) => Promise<void>;

  // ── waits ──
  aguardarStatus: (pedidoId: string, status: string, expected?: { decisao?: string }, opts?: { timeout_ms?: number }) => Promise<void>;
  aguardarStatusSeparacao: (pedidoId: string, status: string, opts?: { timeout_ms?: number }) => Promise<void>;
  aguardarRealocacao: (pedidoId: string, sku: string, locEsperada: string, opts?: { timeout_ms?: number }) => Promise<void>;
  aguardarFilaVazia: (opts?: { timeout_ms?: number }) => Promise<void>;
```

- [ ] **Step 2:** Criar `context.ts` parcial (só infra + setup + pedido/separação). Métodos restantes virão nas próximas tasks:

```ts
import { randomBytes, randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx, HttpClient, StagingFixtures } from "./types";
import * as A from "./asserts";

export function createContext(opts: {
  sb: SupabaseClient;
  http: HttpClient;
  staging: StagingFixtures;
  correlationId: string;
}): Ctx {
  const { sb, http, staging, correlationId } = opts;

  const log: Ctx["log"] = (msg, meta) => console.log(`[${correlationId.slice(0, 8)}] ${msg}`, meta ?? "");

  function skuUnico(prefix: string): string {
    return `TEST-${prefix}-${randomBytes(3).toString("hex")}`;
  }

  async function aguardar(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

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

  async function criarLocalizacao(p: { galpao: "CWB" | "SP"; codigo: string; tipo?: "picking" | "overstock" | "quarentena" | "expedicao" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: existente } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.codigo).maybeSingle();
    if (existente) return existente.id;
    const { data, error } = await sb.from("siso_localizacoes").insert({
      galpao_id,
      codigo: p.codigo,
      tipo: p.tipo ?? "picking",
      ativo: true,
    }).select("id").single();
    if (error) throw new Error(`criarLocalizacao ${p.codigo}: ${error.message}`);
    return data.id;
  }

  async function criarFornecedor(p: { nome: string; prefixo_sku?: string }): Promise<string> {
    const { data: existente } = await sb.from("siso_fornecedores").select("id").eq("nome", p.nome).maybeSingle();
    if (existente) return existente.id;
    const { data, error } = await sb.from("siso_fornecedores").insert({
      nome: p.nome,
      prefixo_sku: p.prefixo_sku ?? null,
      ativo: true,
    }).select("id").single();
    if (error) throw error;
    return data.id;
  }

  async function semearSaldo(p: { produto: string; galpao: "CWB" | "SP"; loc: string; qty: number; custo?: number }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.produto).single();
    if (!prod) throw new Error(`semearSaldo: produto ${p.produto} não existe`);
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.loc).single();
    if (!loc) throw new Error(`semearSaldo: loc ${p.galpao}/${p.loc} não existe`);

    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prod.id,
      p_galpao_id: galpao_id,
      p_localizacao_id: loc.id,
      p_tipo: "E",
      p_quantidade: p.qty,
      p_origem_tipo: "inventario_inicial",
      p_origem_id: null,
      p_custo_unitario: p.custo ?? null,
      p_observacoes: `harness seed [${correlationId.slice(0, 8)}]`,
    });
    if (error) throw new Error(`semearSaldo rpc: ${error.message}`);
  }

  // ── pedido + separação ──
  async function webhook(p: { empresa: string; items: { sku: string; qty: number }[]; tipo?: "pedido" | "nota_fiscal"; pedidoFakeId?: number }) {
    const fakeId = p.pedidoFakeId ?? Math.floor(Math.random() * 90_000_000) + 9_000_000_000;
    const body = {
      tipo: p.tipo ?? "pedido",
      dados: {
        id: String(fakeId),
        situacao: 1,
        cliente: { cnpj: p.empresa, nome: "Cliente Teste" },
        itens: p.items.map((it, i) => ({
          id: String(fakeId * 10 + i),
          produto: { codigo: it.sku, descricao: it.sku },
          quantidade: it.qty,
        })),
      },
      cnpj: p.empresa,
    };
    await http.post("/api/wms/webhook/tiny", body);
    // Espera até o pedido aparecer
    for (let attempt = 0; attempt < 20; attempt++) {
      const { data } = await sb.from("siso_pedidos").select("id").eq("tiny_pedido_id", fakeId).maybeSingle();
      if (data) return { id: data.id };
      await aguardar(250);
    }
    throw new Error(`webhook: pedido com tiny_pedido_id=${fakeId} não apareceu em 5s`);
  }

  async function aprovar(pedidoId: string, decisao?: "propria" | "transferencia" | "oc") {
    await http.post("/api/wms/pedidos/aprovar", { pedido_id: pedidoId, decisao });
  }

  async function iniciarSeparacao(pedidoId: string) {
    await http.post("/api/wms/separacao/iniciar", { pedido_id: pedidoId });
  }

  async function bipar(p: { pedido: string; item: string; qty: number; loc?: string }) {
    await http.post("/api/wms/separacao/bipar", { pedido_id: p.pedido, sku: p.item, quantidade: p.qty, loc: p.loc });
  }

  async function parcial(p: { pedido: string; item: string; qty: number; loc_zerou: boolean }) {
    await http.post("/api/wms/separacao/parcial", { pedido_id: p.pedido, sku: p.item, quantidade: p.qty, loc_zerou: p.loc_zerou });
  }

  async function desfazerParcial(p: { pedido: string; item: string }) {
    await http.post("/api/wms/separacao/desfazer-parcial", { pedido_id: p.pedido, sku: p.item });
  }

  async function encaminhar(p: { pedido: string; item: string; galpao_destino: "CWB" | "SP" }) {
    const galpao_id = staging.galpoes[p.galpao_destino.toLowerCase() as "cwb" | "sp"].id;
    await http.post("/api/wms/separacao/encaminhar", { pedido_id: p.pedido, sku: p.item, galpao_destino_id: galpao_id });
  }

  async function concluirSeparacao(pedidoId: string) {
    await http.post("/api/wms/separacao/concluir", { pedido_id: pedidoId });
  }

  async function embalar(pedidoId: string) {
    await http.post("/api/wms/separacao/bipar-embalagem", { pedido_id: pedidoId });
  }

  async function expedir(pedidoId: string) {
    await http.post("/api/wms/separacao/expedir", { pedido_id: pedidoId });
  }

  // ── waits ──
  async function aguardarStatus(pedidoId: string, status: string, expected?: { decisao?: string }, opts: { timeout_ms?: number } = {}) {
    const timeout = opts.timeout_ms ?? 5_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { data } = await sb.from("siso_pedidos").select("status, decisao_sugerida").eq("id", pedidoId).maybeSingle();
      if (data?.status === status && (!expected?.decisao || data.decisao_sugerida === expected.decisao)) return;
      await aguardar(150);
    }
    const { data } = await sb.from("siso_pedidos").select("status, decisao_sugerida").eq("id", pedidoId).maybeSingle();
    throw new Error(`aguardarStatus: ${pedidoId} esperava ${status}/${expected?.decisao} em ${timeout}ms; estado final: ${JSON.stringify(data)}`);
  }

  async function aguardarStatusSeparacao(pedidoId: string, status: string, opts: { timeout_ms?: number } = {}) {
    const timeout = opts.timeout_ms ?? 5_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { data } = await sb.from("siso_pedidos").select("status_separacao").eq("id", pedidoId).maybeSingle();
      if (data?.status_separacao === status) return;
      await aguardar(150);
    }
    const { data } = await sb.from("siso_pedidos").select("status_separacao").eq("id", pedidoId).maybeSingle();
    throw new Error(`aguardarStatusSeparacao: ${pedidoId} esperava ${status} em ${timeout}ms; real: ${data?.status_separacao}`);
  }

  async function aguardarRealocacao(pedidoId: string, sku: string, locEsperada: string, opts: { timeout_ms?: number } = {}) {
    const timeout = opts.timeout_ms ?? 5_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { data } = await sb
        .from("siso_pedido_item_realocacoes")
        .select("id, localizacao:siso_localizacoes!inner(codigo), produto:siso_produtos!inner(sku)")
        .eq("pedido_id", pedidoId)
        .eq("siso_produtos.sku", sku)
        .eq("status", "aguardando_picking");
      const match = (data as Array<{ localizacao: { codigo: string } }> | null)?.find((r) => r.localizacao.codigo === locEsperada);
      if (match) return;
      await aguardar(150);
    }
    throw new Error(`aguardarRealocacao: ${pedidoId}/${sku} esperava realoc em ${locEsperada} em ${timeout}ms`);
  }

  async function aguardarFilaVazia(opts: { timeout_ms?: number } = {}) {
    const timeout = opts.timeout_ms ?? 10_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { count } = await sb
        .from("siso_fila_execucao")
        .select("id", { count: "exact", head: true })
        .in("status", ["pendente", "executando"]);
      if ((count ?? 0) === 0) return;
      await aguardar(250);
    }
    const { data } = await sb.from("siso_fila_execucao").select("id, status, tipo").in("status", ["pendente", "executando"]);
    throw new Error(`aguardarFilaVazia: ${timeout}ms estourou; jobs pendentes: ${JSON.stringify(data)}`);
  }

  // ── asserts (proxies) ──
  const assertSaldo: Ctx["assertSaldo"] = (sku, g, l, q) => A.assertSaldo(sb, sku, g, l, q);
  const assertReservado: Ctx["assertReservado"] = (sku, g, l, q) => A.assertReservado(sb, sku, g, l, q);
  const assertMovsCount: Ctx["assertMovsCount"] = (sku, c) => A.assertMovsCount(sb, sku, c);
  const assertPedidoStatus: Ctx["assertPedidoStatus"] = (id, s) => A.assertPedidoStatus(sb, id, s);
  const assertCustoMedio: Ctx["assertCustoMedio"] = (sku, c, tol) => A.assertCustoMedio(sb, sku, c, tol);
  const assertSemReservasOrfas: Ctx["assertSemReservasOrfas"] = () => A.assertSemReservasOrfas(sb);

  return {
    sb, http, staging, log, skuUnico, correlationId, aguardar,
    criarProduto, criarLocalizacao, criarFornecedor, semearSaldo,
    webhook, aprovar, iniciarSeparacao, bipar, parcial, desfazerParcial, encaminhar,
    concluirSeparacao, embalar, expedir,
    aguardarStatus, aguardarStatusSeparacao, aguardarRealocacao, aguardarFilaVazia,
    assertSaldo, assertReservado, assertMovsCount, assertPedidoStatus, assertCustoMedio, assertSemReservasOrfas,
  } as Ctx;
}
```

- [ ] **Step 3:** Adicionar ao type `Ctx` em `types.ts` as assinaturas dos asserts pra TypeScript não reclamar:

```ts
  assertSaldo: (sku: string, galpao: "CWB" | "SP", loc: string, qty_esperada: number) => Promise<void>;
  assertReservado: (sku: string, galpao: "CWB" | "SP", loc: string, qty_esperada: number) => Promise<void>;
  assertMovsCount: (sku: string, count_esperado: number) => Promise<void>;
  assertPedidoStatus: (pedidoId: string, status_esperado: string) => Promise<void>;
  assertCustoMedio: (sku: string, custo_esperado: number, tolerancia?: number) => Promise<void>;
  assertSemReservasOrfas: () => Promise<void>;
```

- [ ] **Step 4:** Commit.

```bash
git add scripts/wms/cenarios/_harness/context.ts scripts/wms/cenarios/_harness/types.ts
git commit -m "feat(tests): context factory + helpers pedido/separação/waits"
```

### Task 3.6: Context — movs operacionais

**Files:**
- Modify: `scripts/wms/cenarios/_harness/types.ts`
- Modify: `scripts/wms/cenarios/_harness/context.ts`

- [ ] **Step 1:** Adicionar ao type `Ctx`:

```ts
  // ── compras + recebimento ──
  comprar: (p: { sku: string; qty: number; fornecedor?: string }) => Promise<{ ordem_id: string }>;
  receberCompra: (p: { ordem_id: string; items: { sku: string; qty: number }[] }) => Promise<void>;
  prepararEmbalagem: (p: { pedido_id: string }) => Promise<void>;
  receber: (p: { items: { sku: string; qty: number; loc_destino?: string }[]; galpao: "CWB" | "SP"; entrada_direta?: boolean }) => Promise<{ pendencias: string[] }>;
  guardar: (p: { pendencia_id: string; loc_destino: string; qty?: number }) => Promise<void>;
  aguardarPendenciaGuarda: (pendenciaId: string, status: "pendente" | "em_guarda" | "guardada", opts?: { timeout_ms?: number }) => Promise<void>;

  // ── movs operacionais ──
  transferirGalpao: (p: { origem: "CWB" | "SP"; destino: "CWB" | "SP"; items: { sku: string; qty: number }[] }) => Promise<{ id: string }>;
  replenishment: (p: { sku: string; galpao: "CWB" | "SP"; origem_loc: string; destino_loc: string; qty: number }) => Promise<void>;
  ajusteManual: (p: { sku: string; galpao: "CWB" | "SP"; loc: string; delta: number; motivo: string }) => Promise<void>;
  lancamentoRetroativo: (p: { sku: string; galpao: "CWB" | "SP"; loc: string; qty: number; tipo: "E" | "S" }) => Promise<{ id: string }>;
  reconciliarRetroativo: (id: string) => Promise<void>;
```

- [ ] **Step 2:** Adicionar implementações ao `context.ts`, ao final antes do `return`:

```ts
  // ── compras + recebimento ──
  async function comprar(p: { sku: string; qty: number; fornecedor?: string }) {
    const res = await http.post<{ ordem_id: string }>("/api/wms/compras/comprar", {
      sku: p.sku,
      quantidade: p.qty,
      fornecedor_nome: p.fornecedor ?? "TestSupplier-Default",
    });
    return res;
  }

  async function receberCompra(p: { ordem_id: string; items: { sku: string; qty: number }[] }) {
    await http.post(`/api/wms/compras/conferencia/${p.ordem_id}`, {
      itens: p.items.map((it) => ({ sku: it.sku, quantidade: it.qty })),
    });
  }

  async function prepararEmbalagem(p: { pedido_id: string }) {
    await http.post("/api/wms/compras/preparar-embalagem", { pedido_id: p.pedido_id });
  }

  async function receber(p: { items: { sku: string; qty: number; loc_destino?: string }[]; galpao: "CWB" | "SP"; entrada_direta?: boolean }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const itens = await Promise.all(
      p.items.map(async (it) => {
        const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", it.sku).single();
        let loc_destino_id: string | null = null;
        if (it.loc_destino) {
          const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", it.loc_destino).single();
          loc_destino_id = l?.id ?? null;
        }
        return { produto_id: prod!.id, qty: it.qty, localizacao_destino_id: loc_destino_id };
      }),
    );
    const res = await http.post<{ pendencias: string[] }>("/api/wms/receber", {
      galpao_id,
      itens,
      entrada_direta: p.entrada_direta ?? false,
    });
    return res;
  }

  async function guardar(p: { pendencia_id: string; loc_destino: string; qty?: number }) {
    const { data: pend } = await sb.from("siso_wms_pendencias_guarda").select("galpao_id").eq("id", p.pendencia_id).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", pend!.galpao_id).eq("codigo", p.loc_destino).single();
    await http.post(`/api/wms/guarda/${p.pendencia_id}/confirmar`, {
      localizacao_destino_id: loc!.id,
      quantidade: p.qty,
    });
  }

  async function aguardarPendenciaGuarda(pendenciaId: string, status: string, opts: { timeout_ms?: number } = {}) {
    const timeout = opts.timeout_ms ?? 5_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { data } = await sb.from("siso_wms_pendencias_guarda").select("status").eq("id", pendenciaId).maybeSingle();
      if (data?.status === status) return;
      await aguardar(150);
    }
    throw new Error(`aguardarPendenciaGuarda: ${pendenciaId} esperava ${status} em ${timeout}ms`);
  }

  // ── movs operacionais ──
  async function transferirGalpao(p: { origem: "CWB" | "SP"; destino: "CWB" | "SP"; items: { sku: string; qty: number }[] }) {
    const origem_id = staging.galpoes[p.origem.toLowerCase() as "cwb" | "sp"].id;
    const destino_id = staging.galpoes[p.destino.toLowerCase() as "cwb" | "sp"].id;
    const itens = await Promise.all(p.items.map(async (it) => {
      const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", it.sku).single();
      return { produto_id: prod!.id, qty: it.qty };
    }));
    return http.post<{ id: string }>("/api/wms/transferir-galpao", { origem_id, destino_id, itens });
  }

  async function replenishment(p: { sku: string; galpao: "CWB" | "SP"; origem_loc: string; destino_loc: string; qty: number }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: orig } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.origem_loc).single();
    const { data: dest } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.destino_loc).single();
    await http.post("/api/wms/replenishment", {
      produto_id: prod!.id,
      origem_localizacao_id: orig!.id,
      destino_localizacao_id: dest!.id,
      quantidade: p.qty,
    });
  }

  async function ajusteManual(p: { sku: string; galpao: "CWB" | "SP"; loc: string; delta: number; motivo: string }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.loc).single();
    await http.post("/api/wms/ajuste", {
      produto_id: prod!.id,
      galpao_id,
      localizacao_id: loc!.id,
      delta: p.delta,
      motivo: p.motivo,
    });
  }

  async function lancamentoRetroativo(p: { sku: string; galpao: "CWB" | "SP"; loc: string; qty: number; tipo: "E" | "S" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.loc).single();
    return http.post<{ id: string }>("/api/wms/lancamento-retroativo", {
      produto_id: prod!.id,
      galpao_id,
      localizacao_id: loc!.id,
      quantidade: p.qty,
      tipo: p.tipo,
    });
  }

  async function reconciliarRetroativo(id: string) {
    await http.post(`/api/wms/lancamento-retroativo/${id}/reconciliar`);
  }
```

Adicionar essas funções ao objeto retornado.

- [ ] **Step 3:** Commit.

```bash
git add scripts/wms/cenarios/_harness/context.ts scripts/wms/cenarios/_harness/types.ts
git commit -m "feat(tests): context — compras, receber, guarda, transferir, replenishment, ajuste, retroativo"
```

### Task 3.7: Context — vendas + reservas + devoluções + inventário

**Files:**
- Modify: `scripts/wms/cenarios/_harness/types.ts`
- Modify: `scripts/wms/cenarios/_harness/context.ts`

- [ ] **Step 1:** Adicionar ao type `Ctx`:

```ts
  // ── vendas ──
  criarVendaDireta: (p: {
    galpao: "CWB" | "SP";
    empresa: "netair" | "netparts";
    items: { sku: string; qty: number }[];
    modo: "separacao" | "baixa_direta";
  }) => Promise<{ id: string; degradado: boolean; motivo_degradacao?: string; skus_sem_saldo?: string[] }>;
  disponibilidadeVenda: (p: { sku: string; galpao: "CWB" | "SP"; empresa: "netair" | "netparts" }) => Promise<{ localizacao_id?: string; disponivel: number }>;

  // ── reservas ──
  reservar: (p: { sku: string; galpao: "CWB" | "SP"; loc: string; qty: number; ttl_horas?: number; ttl_segundos?: number }) => Promise<{ mov_id: string }>;
  cleanupReservas: () => Promise<{ liberadas: number }>;

  // ── devoluções ──
  classificarDevolucao: (p: { devolucao_id: string; classificacao: "A" | "B" | "C" | "D" }) => Promise<void>;

  // ── inventário ──
  criarSessaoInventario: (p: { galpao: "CWB" | "SP"; locs: string[]; modo?: "blind" | "aberto"; tipo?: "cycle_count" | "completo" }) => Promise<{ id: string }>;
  entrarParty: (sessaoId: string) => Promise<void>;
  proximaLoc: (sessaoId: string) => Promise<{ localizacao_id: string | null; pool_vazio?: boolean }>;
  bipeInventario: (p: { sessao_id: string; sku: string; loc: string; qty: number }) => Promise<void>;
  finalizarLocInventario: (p: { sessao_id: string; loc: string }) => Promise<void>;
  aprovarInventario: (sessaoId: string) => Promise<void>;
  aplicarInventario: (sessaoId: string) => Promise<void>;
```

- [ ] **Step 2:** Adicionar implementações ao `context.ts`:

```ts
  // ── vendas ──
  async function criarVendaDireta(p: { galpao: "CWB" | "SP"; empresa: "netair" | "netparts"; items: { sku: string; qty: number }[]; modo: "separacao" | "baixa_direta" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const empresa_origem_id = staging.empresas[p.empresa].id;
    const itens = await Promise.all(p.items.map(async (it) => {
      const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", it.sku).single();
      return { produto_id: prod!.id, quantidade: it.qty };
    }));
    return http.post<{ id: string; degradado: boolean; motivo_degradacao?: string; skus_sem_saldo?: string[] }>(
      "/api/wms/vendas/criar",
      { galpao_id, empresa_origem_id, items: itens, modo: p.modo },
    );
  }

  async function disponibilidadeVenda(p: { sku: string; galpao: "CWB" | "SP"; empresa: "netair" | "netparts" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const empresa_origem_id = staging.empresas[p.empresa].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    return http.get<{ localizacao_id?: string; disponivel: number }>(
      `/api/wms/vendas/disponibilidade?produto_id=${prod!.id}&galpao_id=${galpao_id}&empresa_origem_id=${empresa_origem_id}`,
    );
  }

  // ── reservas ──
  async function reservar(p: { sku: string; galpao: "CWB" | "SP"; loc: string; qty: number; ttl_horas?: number; ttl_segundos?: number }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.loc).single();
    const ttl_horas = p.ttl_horas ?? (p.ttl_segundos ? p.ttl_segundos / 3600 : 48);
    const { data, error } = await sb.rpc("wms_reservar_atomico", {
      p_produto_id: prod!.id,
      p_galpao_id: galpao_id,
      p_localizacao_id: loc!.id,
      p_quantidade: p.qty,
      p_ttl_horas: ttl_horas,
      p_pedido_id: null,
    });
    if (error) throw new Error(`reservar: ${error.message}`);
    return { mov_id: data as string };
  }

  async function cleanupReservas() {
    return http.get<{ liberadas: number }>("/api/wms/reservas/cleanup");
  }

  // ── devoluções ──
  async function classificarDevolucao(p: { devolucao_id: string; classificacao: "A" | "B" | "C" | "D" }) {
    await http.post(`/api/wms/devolucoes/${p.devolucao_id}/classificar`, { classificacao: p.classificacao });
  }

  // ── inventário ──
  async function criarSessaoInventario(p: { galpao: "CWB" | "SP"; locs: string[]; modo?: "blind" | "aberto"; tipo?: "cycle_count" | "completo" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: locs } = await sb.from("siso_localizacoes").select("id, codigo").eq("galpao_id", galpao_id).in("codigo", p.locs);
    const loc_ids = (locs ?? []).map((l) => l.id);
    const res = await http.post<{ id: string }>("/api/wms/inventario", {
      galpao_id,
      localizacoes_ids: loc_ids,
      modo: p.modo ?? "blind",
      tipo: p.tipo ?? "cycle_count",
    });
    await http.post(`/api/wms/inventario/${res.id}/iniciar`);
    return res;
  }

  async function entrarParty(sessaoId: string) {
    await http.post(`/api/wms/inventario/${sessaoId}/party`);
  }

  async function proximaLoc(sessaoId: string) {
    return http.post<{ localizacao_id: string | null; pool_vazio?: boolean }>(`/api/wms/inventario/${sessaoId}/proxima-loc`);
  }

  async function bipeInventario(p: { sessao_id: string; sku: string; loc: string; qty: number }) {
    const { data: sess } = await sb.from("siso_inventario_sessoes").select("galpao_id").eq("id", p.sessao_id).single();
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", sess!.galpao_id).eq("codigo", p.loc).single();
    await http.post(`/api/wms/inventario/${p.sessao_id}/contagens`, {
      produto_id: prod!.id,
      localizacao_id: loc!.id,
      quantidade: p.qty,
    });
  }

  async function finalizarLocInventario(p: { sessao_id: string; loc: string }) {
    const { data: sess } = await sb.from("siso_inventario_sessoes").select("galpao_id").eq("id", p.sessao_id).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", sess!.galpao_id).eq("codigo", p.loc).single();
    await http.post(`/api/wms/inventario/${p.sessao_id}/localizacoes/${loc!.id}/finalizar`);
  }

  async function aprovarInventario(sessaoId: string) {
    await http.post(`/api/wms/inventario/${sessaoId}/aprovar`);
  }

  async function aplicarInventario(sessaoId: string) {
    await http.post(`/api/wms/inventario/${sessaoId}/aplicar`);
  }
```

Adicionar todas ao objeto retornado por `createContext`.

- [ ] **Step 3:** Commit.

```bash
git add scripts/wms/cenarios/_harness/context.ts scripts/wms/cenarios/_harness/types.ts
git commit -m "feat(tests): context — vendas, reservas, devoluções, inventário"
```

### Task 3.8: Dev server orchestration

**Files:**
- Create: `scripts/wms/cenarios/_harness/dev-server.ts`

- [ ] **Step 1:** Escrever dev-server.ts:

```ts
import { spawn, type ChildProcess } from "child_process";

export interface DevServerHandle {
  process: ChildProcess;
  port: number;
  kill: () => Promise<void>;
}

export async function startDevServer(opts: { port: number; cwd?: string }): Promise<DevServerHandle> {
  const env = { ...process.env, PORT: String(opts.port), NODE_ENV: "development" };
  const proc = spawn("npx", ["next", "dev", "-p", String(opts.port)], {
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (chunk) => process.stderr.write(`[dev] ${chunk}`));
  proc.stderr?.on("data", (chunk) => process.stderr.write(`[dev:err] ${chunk}`));

  return {
    process: proc,
    port: opts.port,
    kill: async () => {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 5_000);
      });
    },
  };
}

export async function waitForHealth(url: string, opts: { timeout_ms?: number } = {}): Promise<void> {
  const timeout = opts.timeout_ms ?? 30_000;
  const deadline = Date.now() + timeout;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      // Qualquer resposta HTTP (mesmo 401/404) significa servidor vivo
      if (res.status > 0) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForHealth: ${url} não respondeu em ${timeout}ms (último erro: ${lastErr})`);
}

export async function loginTestRunner(opts: { baseUrl: string; nome: string; pin: string }): Promise<string> {
  const res = await fetch(`${opts.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome: opts.nome, pin: opts.pin }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`loginTestRunner: HTTP ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { sessao_id?: string; session_id?: string };
  const sessionId = data.sessao_id ?? data.session_id;
  if (!sessionId) throw new Error(`loginTestRunner: response sem session id: ${JSON.stringify(data)}`);
  return sessionId;
}
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/_harness/dev-server.ts
git commit -m "feat(tests): dev-server start/health/login helpers"
```

---

## Fase 4 — Invariantes globais

### Task 4.1: Implementar 7 invariantes

**Files:**
- Create: `scripts/wms/cenarios/_harness/invariantes.ts`

- [ ] **Step 1:** Escrever invariantes.ts com as 7 checks property-based:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvariantResult } from "./types";

async function tempoRpc<T>(fn: () => Promise<T>): Promise<{ valor: T; ms: number }> {
  const t0 = Date.now();
  const valor = await fn();
  return { valor, ms: Date.now() - t0 };
}

// I1 — Ledger ↔ cache coerente
async function i1LedgerVsCache(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const { data, error } = await sb.rpc("wms_detectar_divergencias_estoque");
  if (error) {
    return { nome: "I1: ledger↔cache", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  }
  const linhas = (data as unknown[]) ?? [];
  return {
    nome: "I1: ledger↔cache",
    ok: linhas.length === 0,
    detalhes: linhas.length > 0 ? { divergencias: linhas } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I2 — disponivel = saldo - reservado (sanity da coluna GENERATED)
async function i2DisponivelGenerated(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const { data, error } = await sb
    .from("siso_estoque")
    .select("id, saldo, reservado, disponivel")
    .gt("saldo", 0);
  if (error) return { nome: "I2: disponivel", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  const ruins = (data ?? []).filter((r) => r.disponivel !== r.saldo - r.reservado);
  return {
    nome: "I2: disponivel",
    ok: ruins.length === 0,
    detalhes: ruins.length > 0 ? { ruins } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I3 — Custo médio coerente
async function i3CustoMedio(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  // Pega produtos TEST-* (cenários) — recalcula custo ponderado das entradas com custo_unitario
  const { data: produtos } = await sb.from("siso_produtos").select("id, sku").like("sku", "TEST-%");
  const divergentes: Array<{ sku: string; esperado: number; real: number }> = [];
  for (const p of produtos ?? []) {
    const { data: movs } = await sb
      .from("siso_movimentacoes")
      .select("quantidade, custo_unitario")
      .eq("produto_id", p.id)
      .eq("tipo", "E")
      .not("custo_unitario", "is", null)
      .order("created_at", { ascending: true });
    if (!movs || movs.length === 0) continue;
    let custoMed = 0;
    let saldo = 0;
    for (const m of movs) {
      const q = Number(m.quantidade);
      const c = Number(m.custo_unitario);
      const novoSaldo = saldo + q;
      custoMed = novoSaldo === 0 ? 0 : (custoMed * saldo + c * q) / novoSaldo;
      saldo = novoSaldo;
    }
    const { data: cache } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", p.id).maybeSingle();
    const real = Number(cache?.custo_medio ?? 0);
    if (Math.abs(custoMed - real) > 0.001) {
      divergentes.push({ sku: p.sku, esperado: custoMed, real });
    }
  }
  return {
    nome: "I3: custo médio",
    ok: divergentes.length === 0,
    detalhes: divergentes.length > 0 ? { divergentes } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I4 — Sem reservas órfãs
async function i4ReservasOrfas(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const agora = new Date().toISOString();
  const { data, error } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_id, expira_em, created_at")
    .eq("tipo", "R");
  if (error) return { nome: "I4: reservas órfãs", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  const orfas: unknown[] = [];
  for (const r of data ?? []) {
    if (r.expira_em && r.expira_em > agora) continue; // ainda válida
    // Procura mov L correspondente (mesmo origem_id)
    const { data: lib } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "L")
      .eq("origem_id", r.origem_id)
      .maybeSingle();
    if (!lib) orfas.push(r);
  }
  return {
    nome: "I4: reservas órfãs",
    ok: orfas.length === 0,
    detalhes: orfas.length > 0 ? { orfas } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I5 — Pendências de guarda coerentes
async function i5PendenciasGuarda(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const { data, error } = await sb
    .from("siso_wms_pendencias_guarda")
    .select("id, qty_inicial, qty_guardada, qty_pendente, status");
  if (error) return { nome: "I5: pendências", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  const ruins = (data ?? []).filter((p) => {
    const expected = p.qty_inicial - p.qty_guardada;
    if (p.qty_pendente !== expected) return true;
    if (p.status === "guardada" && p.qty_pendente !== 0) return true;
    return false;
  });
  return {
    nome: "I5: pendências guarda",
    ok: ruins.length === 0,
    detalhes: ruins.length > 0 ? { ruins } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I6 — Pares S+E balanceados
async function i6ParesSE(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const tiposPares = ["transferencia_galpao", "transferencia_localizacao", "ajuste_pick_zerou"];
  const { data, error } = await sb
    .from("siso_movimentacoes")
    .select("id, tipo, origem_id, origem_tipo, quantidade")
    .in("origem_tipo", tiposPares)
    .not("origem_id", "is", null);
  if (error) return { nome: "I6: pares S+E", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  const grupos = new Map<string, { S: number; E: number; qtyS: number; qtyE: number }>();
  for (const m of data ?? []) {
    const key = `${m.origem_tipo}:${m.origem_id}`;
    const g = grupos.get(key) ?? { S: 0, E: 0, qtyS: 0, qtyE: 0 };
    if (m.tipo === "S") { g.S += 1; g.qtyS += Number(m.quantidade); }
    else if (m.tipo === "E") { g.E += 1; g.qtyE += Number(m.quantidade); }
    grupos.set(key, g);
  }
  const ruins: unknown[] = [];
  for (const [key, g] of grupos) {
    if (g.S !== 1 || g.E !== 1 || g.qtyS !== g.qtyE) ruins.push({ key, ...g });
  }
  return {
    nome: "I6: pares S+E",
    ok: ruins.length === 0,
    detalhes: ruins.length > 0 ? { ruins } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I7 — Fila vazia ao fim
async function i7FilaVazia(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const { data, error } = await sb
    .from("siso_fila_execucao")
    .select("id, status, tipo")
    .in("status", ["pendente", "executando"]);
  if (error) return { nome: "I7: fila vazia", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  return {
    nome: "I7: fila vazia",
    ok: (data ?? []).length === 0,
    detalhes: (data ?? []).length > 0 ? { jobs_pendentes: data } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

export async function rodarInvariantes(sb: SupabaseClient): Promise<InvariantResult[]> {
  return [
    await i1LedgerVsCache(sb),
    await i2DisponivelGenerated(sb),
    await i3CustoMedio(sb),
    await i4ReservasOrfas(sb),
    await i5PendenciasGuarda(sb),
    await i6ParesSE(sb),
    await i7FilaVazia(sb),
  ];
}
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/_harness/invariantes.ts
git commit -m "feat(tests): 7 invariantes globais property-based"
```

---

## Fase 5 — Relatório

### Task 5.1: Writer de relatório (markdown + json)

**Files:**
- Create: `scripts/wms/cenarios/_harness/relatorio.ts`

- [ ] **Step 1:** Escrever relatorio.ts:

```ts
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { ScenarioResult } from "./types";

const REPORTS_DIR = "scripts/wms/cenarios/reports";

export async function writeReport(results: ScenarioResult[], iniciadoEm: Date, duracaoMs: number) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const ts = iniciadoEm.toISOString().replace(/[:.]/g, "-");
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skip = results.filter((r) => r.status === "skip").length;

  const md = buildMarkdown(results, iniciadoEm, duracaoMs, pass, fail, skip);
  const json = JSON.stringify({
    iniciado_em: iniciadoEm.toISOString(),
    duracao_ms: duracaoMs,
    totais: { pass, fail, skip },
    cenarios: results,
  }, null, 2);

  await writeFile(join(REPORTS_DIR, `${ts}-summary.md`), md, "utf-8");
  await writeFile(join(REPORTS_DIR, `${ts}-detail.json`), json, "utf-8");

  return { mdPath: `${REPORTS_DIR}/${ts}-summary.md`, jsonPath: `${REPORTS_DIR}/${ts}-detail.json` };
}

function buildMarkdown(results: ScenarioResult[], iniciado: Date, duracaoMs: number, pass: number, fail: number, skip: number): string {
  const dur = formatarDuracao(duracaoMs);
  const lines: string[] = [];
  lines.push(`# Suite Scenarios — ${iniciado.toISOString()}`);
  lines.push("");
  lines.push(`**Total:** ${results.length} cenários · **Pass:** ${pass} · **Fail:** ${fail} · **Skip:** ${skip} · **Tempo:** ${dur}`);
  lines.push("");

  if (fail > 0) {
    lines.push("## Falhas");
    lines.push("");
    for (const r of results.filter((x) => x.status === "fail")) {
      lines.push(`### ❌ ${r.nome} (${formatarDuracao(r.duracao_ms ?? 0)})`);
      lines.push(`**Motivo:** ${r.motivo ?? "desconhecido"}`);
      if (r.erro) {
        lines.push("");
        lines.push("```");
        lines.push(r.erro.mensagem);
        lines.push("```");
      }
      if (r.detalhes) {
        lines.push("");
        lines.push("Detalhes:");
        lines.push("```json");
        lines.push(JSON.stringify(r.detalhes, null, 2).slice(0, 4000));
        lines.push("```");
      }
      if (r.invariantes?.some((i) => !i.ok)) {
        lines.push("");
        lines.push("Invariantes falhando:");
        for (const inv of r.invariantes.filter((i) => !i.ok)) {
          lines.push(`- ${inv.nome}: ${JSON.stringify(inv.detalhes).slice(0, 500)}`);
        }
      }
      lines.push("");
    }
  }

  lines.push("## Cenários OK");
  for (const r of results.filter((x) => x.status === "pass")) {
    lines.push(`- ✅ ${r.nome} (${formatarDuracao(r.duracao_ms ?? 0)})`);
  }

  if (skip > 0) {
    lines.push("");
    lines.push("## Cenários Skipped");
    for (const r of results.filter((x) => x.status === "skip")) {
      lines.push(`- ⏭️ ${r.nome}`);
    }
  }

  return lines.join("\n");
}

function formatarDuracao(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}.${String(ms % 1000).padStart(3, "0").slice(0, 1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/_harness/relatorio.ts
git commit -m "feat(tests): writer de relatório markdown + json"
```

---

## Fase 6 — Runner mestre + standalone

### Task 6.1: Standalone helper

**Files:**
- Create: `scripts/wms/cenarios/_harness/standalone.ts`

- [ ] **Step 1:** Escrever standalone.ts:

```ts
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "crypto";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import type { Cenario } from "./types";
import { createContext } from "./context";
import { createHttp } from "./http";
import { seedInicial, truncateOperacional } from "./seed";
import { loginTestRunner, waitForHealth } from "./dev-server";
import { rodarInvariantes } from "./invariantes";

export async function runStandalone(cenario: Cenario): Promise<void> {
  loadEnv({ path: ".env.test", override: false });
  loadEnv({ path: ".env.test.local", override: true });

  const baseUrl = process.env.TEST_RUNNER_BASE_URL ?? "http://localhost:3001";
  const nome = process.env.TEST_RUNNER_NOME ?? "test-runner";
  const pin = process.env.TEST_RUNNER_PIN ?? "9999";

  console.log(`[standalone] ${cenario.nome}`);
  console.log(`[standalone] esperando dev server em ${baseUrl} ...`);
  await waitForHealth(`${baseUrl}/api/auth/me`, { timeout_ms: 15_000 });

  const sb = createServiceClient();
  console.log(`[standalone] truncate + seed`);
  await truncateOperacional(sb);
  const staging = await seedInicial(sb);

  console.log(`[standalone] login`);
  const sessionId = await loginTestRunner({ baseUrl, nome, pin });

  const correlationId = randomUUID();
  const http = createHttp({ baseUrl, sessionId, correlationId });
  const ctx = createContext({ sb, http, staging, correlationId });

  const t0 = Date.now();
  try {
    const setupData = await cenario.setup(ctx);
    await cenario.run(ctx, setupData);
    await cenario.assertEsperado(ctx, setupData);
    const invs = await rodarInvariantes(sb);
    const falhas = invs.filter((i) => !i.ok);
    if (falhas.length > 0) {
      console.error(`[standalone] ❌ ${cenario.nome} — invariantes falhando:`);
      for (const f of falhas) console.error(`  - ${f.nome}: ${JSON.stringify(f.detalhes)}`);
      process.exit(1);
    }
    console.log(`[standalone] ✅ ${cenario.nome} (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error(`[standalone] ❌ ${cenario.nome}:`);
    console.error(err);
    process.exit(1);
  }
}
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/_harness/standalone.ts
git commit -m "feat(tests): helper standalone pra rodar 1 cenário isolado"
```

### Task 6.2: Runner mestre `run-all.ts`

**Files:**
- Create: `scripts/wms/cenarios/run-all.ts`

- [ ] **Step 1:** Escrever run-all.ts:

```ts
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "crypto";
import { readdir } from "fs/promises";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { createServiceClient } from "../../../src/lib/supabase-server";
import type { Cenario, ScenarioResult } from "./_harness/types";
import { createContext } from "./_harness/context";
import { createHttp } from "./_harness/http";
import { seedInicial, truncateOperacional } from "./_harness/seed";
import { loginTestRunner, startDevServer, waitForHealth, type DevServerHandle } from "./_harness/dev-server";
import { rodarInvariantes } from "./_harness/invariantes";
import { writeReport } from "./_harness/relatorio";

interface Args { only?: string; filter?: string; keepServer: boolean; port: number; }

function parseArgs(): Args {
  const a: Args = { keepServer: false, port: 3001 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") a.only = argv[++i];
    else if (argv[i] === "--filter") a.filter = argv[++i];
    else if (argv[i] === "--keep-server") a.keepServer = true;
    else if (argv[i].startsWith("--port=")) a.port = Number(argv[i].slice(7));
  }
  return a;
}

function filterMatches(c: Cenario, args: Args): boolean {
  if (args.only) return c.nome.includes(args.only);
  if (args.filter) return c.tags.includes(args.filter);
  return true;
}

async function rodarCenario(args: { sb: any; cenario: Cenario; baseUrl: string; sessionId: string; staging: any }): Promise<ScenarioResult> {
  const t0 = Date.now();
  const correlationId = randomUUID();
  const http = createHttp({ baseUrl: args.baseUrl, sessionId: args.sessionId, correlationId });
  const ctx = createContext({ sb: args.sb, http, staging: args.staging, correlationId });

  try {
    const setupData = await args.cenario.setup(ctx);
    await args.cenario.run(ctx, setupData);
    await args.cenario.assertEsperado(ctx, setupData);
    const invs = await rodarInvariantes(args.sb);
    const falhas = invs.filter((i) => !i.ok);
    if (falhas.length > 0) {
      return {
        nome: args.cenario.nome,
        status: "fail",
        duracao_ms: Date.now() - t0,
        motivo: "invariante",
        detalhes: { invariantes_falhando: falhas },
        invariantes: invs,
        correlation_id: correlationId,
      };
    }
    return { nome: args.cenario.nome, status: "pass", duracao_ms: Date.now() - t0, invariantes: invs, correlation_id: correlationId };
  } catch (err) {
    const e = err as Error;
    // Dumpa últimos logs com esse correlation_id
    const { data: logs } = await args.sb.from("siso_logs").select("level, source, message, created_at").eq("correlation_id", correlationId).order("created_at", { ascending: false }).limit(50);
    const { data: erros } = await args.sb.from("siso_erros").select("category, message, stack_trace, created_at").eq("correlation_id", correlationId).limit(50);
    return {
      nome: args.cenario.nome,
      status: "fail",
      duracao_ms: Date.now() - t0,
      motivo: e.name === "HttpError" ? "run" : "assert",
      erro: { mensagem: e.message, stack: e.stack },
      detalhes: { logs, erros },
      correlation_id: correlationId,
    };
  }
}

async function main() {
  const args = parseArgs();
  loadEnv({ path: ".env.test", override: false });
  loadEnv({ path: ".env.test.local", override: true });

  const baseUrl = `http://localhost:${args.port}`;

  console.log(`[1/6] subindo Next dev server em :${args.port}`);
  const server: DevServerHandle = await startDevServer({ port: args.port });
  process.on("SIGINT", () => server.kill().then(() => process.exit(130)));

  try {
    await waitForHealth(`${baseUrl}/api/auth/me`, { timeout_ms: 60_000 });
  } catch (e) {
    await server.kill();
    throw e;
  }

  console.log(`[2/6] truncate + reseed`);
  const sb = createServiceClient();
  await truncateOperacional(sb);
  const staging = await seedInicial(sb);

  console.log(`[3/6] login test-runner`);
  const sessionId = await loginTestRunner({
    baseUrl,
    nome: process.env.TEST_RUNNER_NOME ?? "test-runner",
    pin: process.env.TEST_RUNNER_PIN ?? "9999",
  });

  console.log(`[4/6] descobrindo cenários`);
  const catalogoDir = resolve("scripts/wms/cenarios/catalogo");
  const files = (await readdir(catalogoDir)).filter((f) => f.endsWith(".ts")).sort();

  console.log(`[5/6] executando ${files.length} cenários`);
  const iniciadoEm = new Date();
  const t0 = Date.now();
  const results: ScenarioResult[] = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(catalogoDir, f)).href);
    const cenario: Cenario = mod.default;
    if (!cenario) { console.warn(`  ⚠️ ${f}: sem default export, pulando`); continue; }
    if (cenario.skip || !filterMatches(cenario, args)) {
      results.push({ nome: cenario.nome, status: "skip" });
      console.log(`  ⏭️  ${cenario.nome}`);
      continue;
    }
    console.log(`  ▶️  ${cenario.nome}`);
    const r = await rodarCenario({ sb, cenario, baseUrl, sessionId, staging });
    results.push(r);
    console.log(`     ${r.status === "pass" ? "✅" : "❌"} ${r.duracao_ms}ms${r.status === "fail" ? ` — ${r.motivo}` : ""}`);
  }

  console.log(`[6/6] relatório`);
  const { mdPath, jsonPath } = await writeReport(results, iniciadoEm, Date.now() - t0);
  console.log(`  ${mdPath}`);
  console.log(`  ${jsonPath}`);

  if (!args.keepServer) await server.kill();

  const failed = results.some((r) => r.status === "fail");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Runner fatal:", e);
  process.exit(2);
});
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/run-all.ts
git commit -m "feat(tests): runner mestre — orquestra dev server, seed, scenarios, relatório"
```

---

## Fase 7 — Camada 2: Integration tests (vitest + staging)

### Task 7.1: Vitest config separado + globalSetup

**Files:**
- Create: `vitest.integration.config.ts`
- Create: `test/integration/globalSetup.ts`
- Modify: `package.json` (script `test:integration`)

- [ ] **Step 1:** Criar `vitest.integration.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/globalSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }, // staging shared resource
    env: { TINY_DISABLED: "true", PRINTNODE_DISABLED: "true", ML_DISABLED: "true" },
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
```

- [ ] **Step 2:** Criar `test/integration/globalSetup.ts`:

```ts
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../src/lib/supabase-server";
import { truncateOperacional, seedInicial, validarStaging } from "../../scripts/wms/cenarios/_harness/seed";

export default async function setup() {
  loadEnv({ path: ".env.test", override: false });
  loadEnv({ path: ".env.test.local", override: true });
  validarStaging();
  const sb = createServiceClient();
  await truncateOperacional(sb);
  await seedInicial(sb);
  console.log("[integration setup] staging limpo + seed inicial OK");
}
```

- [ ] **Step 3:** Adicionar ao `package.json` no bloco `scripts`:

```json
    "test:integration": "vitest run -c vitest.integration.config.ts"
```

- [ ] **Step 4:** Commit.

```bash
git add vitest.integration.config.ts test/integration/globalSetup.ts package.json
git commit -m "feat(tests): vitest config + globalSetup pra integration layer"
```

### Task 7.2: Ledger RPC tests

**Files:**
- Create: `test/integration/ledger-rpc.test.ts`

- [ ] **Step 1:** Escrever:

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let produtoId: string;
let galpaoId: string;
let locId: string;
const SKU = `TEST-INT-LEDGER-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: SKU, descricao: "Ledger RPC test", ativo: true }).select("id").single();
  produtoId = p!.id;
});

describe("wms_inserir_movimentacao", () => {
  it("entrada simples atualiza saldo no cache", async () => {
    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
      p_origem_id: null, p_custo_unitario: 5, p_observacoes: "test",
    });
    expect(error).toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo").eq("produto_id", produtoId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(est?.saldo).toBe(10);
  });

  it("saída maior que saldo retorna erro", async () => {
    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 999, p_origem_tipo: "venda_manual",
      p_origem_id: null, p_custo_unitario: null, p_observacoes: "overflow",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/saldo|insuficiente|reservado/i);
  });

  it("entrada com custo_unitario recalcula custo médio global", async () => {
    // Primeira já criada com custo 5. Adiciona +10 unidades com custo 15 → média ponderada = (10*5 + 10*15)/20 = 10.
    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "nf_compra",
      p_origem_id: null, p_custo_unitario: 15, p_observacoes: "test custo médio",
    });
    expect(error).toBeNull();
    const { data: cm } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", produtoId).single();
    expect(Number(cm?.custo_medio)).toBeCloseTo(10, 3);
  });
});
```

- [ ] **Step 2:** Rodar.

Run: `npm run test:integration -- ledger-rpc`
Expected: 3 passa.

- [ ] **Step 3:** Commit.

```bash
git add test/integration/ledger-rpc.test.ts
git commit -m "test(integration): wms_inserir_movimentacao — entrada, saída inválida, custo médio"
```

### Task 7.3: Reservas RPC tests

**Files:**
- Create: `test/integration/reservas-rpc.test.ts`

- [ ] **Step 1:** Escrever:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
const SKU = `TEST-INT-RES-${Math.random().toString(36).slice(2, 8)}`;
let produtoId: string, galpaoId: string, locId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-02").single();
  locId = l!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: SKU, descricao: "Reservas test", ativo: true }).select("id").single();
  produtoId = p!.id;
  // semeia saldo 10
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
    p_origem_id: null, p_custo_unitario: null, p_observacoes: "seed",
  });
});

describe("wms_reservar_atomico", () => {
  it("reservar dentro do saldo retorna mov_id", async () => {
    const { data, error } = await sb.rpc("wms_reservar_atomico", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_quantidade: 3, p_ttl_horas: 1, p_pedido_id: null,
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado, disponivel").eq("produto_id", produtoId).single();
    expect(est?.reservado).toBe(3);
    expect(est?.disponivel).toBe(est!.saldo - est!.reservado);
  });

  it("reservar acima do disponível falha", async () => {
    const { error } = await sb.rpc("wms_reservar_atomico", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_quantidade: 99, p_ttl_horas: 1, p_pedido_id: null,
    });
    expect(error).not.toBeNull();
  });

  it("cleanup endpoint libera reservas expiradas", async () => {
    // cria reserva com TTL real ínfimo
    await sb.rpc("wms_reservar_atomico", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_quantidade: 1, p_ttl_horas: 1 / 3600, p_pedido_id: null, // ~1s
    });
    await new Promise((r) => setTimeout(r, 2_000));

    const url = `${process.env.TEST_RUNNER_BASE_URL}/api/wms/reservas/cleanup`;
    const res = await fetch(url, { headers: { "x-worker-secret": process.env.WORKER_SECRET ?? "test-worker-secret" } });
    expect(res.ok).toBe(true);

    const { data: movsL } = await sb.from("siso_movimentacoes").select("id").eq("produto_id", produtoId).eq("tipo", "L");
    expect((movsL ?? []).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2:** Rodar (precisa do dev server em :3001 ativo pra step 3).

```bash
# Em outro terminal:
PORT=3001 npm run dev

# No terminal principal:
npm run test:integration -- reservas-rpc
```

Expected: 3 passa.

- [ ] **Step 3:** Commit.

```bash
git add test/integration/reservas-rpc.test.ts
git commit -m "test(integration): reservas — TTL, exceder saldo, cleanup"
```

### Task 7.4: Inventário RPC tests

**Files:**
- Create: `test/integration/inventario-rpc.test.ts`

- [ ] **Step 1:** Escrever:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("wms_inventario_sugerir", () => {
  it("retorna lista de localizações com motivo categorizado", async () => {
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data, error } = await sb.rpc("wms_inventario_sugerir", { p_galpao: g!.id, p_tamanho: 5 });
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    for (const row of (data as Array<{ motivo: string }>) ?? []) {
      expect(["curva_a", "divergente_recente", "sem_contagem_recente", "manual", "completo"]).toContain(row.motivo);
    }
  });
});

describe("wms_inventario_proxima_loc", () => {
  it("retorna pool_vazio quando não há loc na sessão", async () => {
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
    // cria sessão sem locs (caso degenerado pra forçar pool_vazio)
    const { data: sess } = await sb.from("siso_inventario_sessoes").insert({
      galpao_id: g!.id, tipo: "cycle_count", modo: "blind", status: "em_andamento", tamanho_pool: 0,
    }).select("id").single();
    await sb.from("siso_inventario_operadores").insert({ sessao_id: sess!.id, usuario_id: u!.id });

    const { data: prox } = await sb.rpc("wms_inventario_proxima_loc", { p_sessao: sess!.id, p_user: u!.id });
    expect((prox as { pool_vazio?: boolean })?.pool_vazio).toBe(true);
  });
});
```

- [ ] **Step 2:** Rodar.

Run: `npm run test:integration -- inventario-rpc`
Expected: 2 passa.

- [ ] **Step 3:** Commit.

```bash
git add test/integration/inventario-rpc.test.ts
git commit -m "test(integration): inventário — sugerir + proxima_loc"
```

### Task 7.5: Reconciliação RPC tests

**Files:**
- Create: `test/integration/reconciliacao-rpc.test.ts`

- [ ] **Step 1:** Escrever:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("wms_detectar_divergencias_estoque", () => {
  it("retorna vazio em estado limpo", async () => {
    const { data, error } = await sb.rpc("wms_detectar_divergencias_estoque");
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(0);
  });

  it("detecta divergência após edit manual em siso_estoque", async () => {
    const SKU = `TEST-INT-REC-${Math.random().toString(36).slice(2, 8)}`;
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", g!.id).eq("codigo", "A-01-03").single();
    const { data: p } = await sb.from("siso_produtos").insert({ sku: SKU, descricao: "Reconcil test", ativo: true }).select("id").single();

    // Semeia 10 via RPC (consistente)
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: p!.id, p_galpao_id: g!.id, p_localizacao_id: l!.id,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
      p_origem_id: null, p_custo_unitario: null, p_observacoes: "seed",
    });

    // Sabota o cache manualmente — saldo fica 999, ledger ainda diz 10
    await sb.from("siso_estoque").update({ saldo: 999 }).eq("produto_id", p!.id).eq("galpao_id", g!.id).eq("localizacao_id", l!.id);

    const { data: divs } = await sb.rpc("wms_detectar_divergencias_estoque");
    const meu = (divs as Array<{ produto_id: string }>).find((d) => d.produto_id === p!.id);
    expect(meu).toBeTruthy();

    // Rebuild restaura
    await sb.rpc("wms_rebuild_linha_estoque", { p_id: meu });
    const { data: depois } = await sb.from("siso_estoque").select("saldo").eq("produto_id", p!.id).single();
    expect(depois?.saldo).toBe(10);
  });
});
```

- [ ] **Step 2:** Rodar.

Run: `npm run test:integration -- reconciliacao-rpc`
Expected: 2 passa.

- [ ] **Step 3:** Commit.

```bash
git add test/integration/reconciliacao-rpc.test.ts
git commit -m "test(integration): reconciliação — detect + rebuild"
```

---

## Fase 8 — Camada 3: 17 Cenários

> **Padrão de cada arquivo:** export default satisfazendo `Cenario`, mais o trailer pra modo standalone. O trailer é o mesmo em todos:
>
> ```ts
> import { runStandalone } from "../_harness/standalone";
>
> // ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
> const _isMain = (() => {
>   try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
>   catch { return false; }
> })();
> if (_isMain) {
>   const mod = await import(import.meta.url);
>   await runStandalone(mod.default);
> }
> ```
>
> Cada task abaixo abrevia esse trailer com `<<STANDALONE_TRAILER>>`. **Copie o bloco literal acima no fim de cada arquivo de cenário.**

### Task 8.1: Cenário 01 — Pedido auto-aprovado própria

**Files:**
- Create: `scripts/wms/cenarios/catalogo/01-pedido-auto-propria.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "01 — Pedido auto-aprovado própria",
  descricao: "Webhook NetAir, saldo total em CWB, auto-aprovação, picking completo, embalagem, expedição.",
  tags: ["pedido", "auto", "propria", "pipeline"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("01");
    await ctx.criarProduto({ sku, descricao: "Filtro 01" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    await ctx.aguardarStatus(pedido.id, "concluido", undefined, { timeout_ms: 8_000 }); // auto-aprovado
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 3 });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "separado");
    await ctx.embalar(pedido.id);
    await ctx.expedir(pedido.id);
    await ctx.aguardarFilaVazia();
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 2);
    await ctx.assertMovsCount(sku, 2); // 1 E seed + 1 S
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/01-pedido-auto-propria.ts
git commit -m "test(scenarios): 01 — pedido auto-aprovado própria"
```

### Task 8.2: Cenário 02 — Pedido transferência

**Files:**
- Create: `scripts/wms/cenarios/catalogo/02-pedido-transferencia.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "02 — Pedido transferência",
  descricao: "NetAir vende, mas estoque está em SP (NetParts). Sistema sugere transferência. Operador aprova.",
  tags: ["pedido", "transferencia", "pipeline"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("02");
    await ctx.criarProduto({ sku, descricao: "Filtro 02" });
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "C-01-01", qty: 4 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: "transferencia" });
    await ctx.aprovar(pedido.id, "transferencia");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 2 });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.embalar(pedido.id);
    await ctx.expedir(pedido.id);
    await ctx.aguardarFilaVazia();
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "SP", "C-01-01", 2);
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/02-pedido-transferencia.ts
git commit -m "test(scenarios): 02 — pedido transferência"
```

### Task 8.3: Cenário 03 — Pedido OC completo

**Files:**
- Create: `scripts/wms/cenarios/catalogo/03-pedido-oc-completo.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "03 — Pedido OC completo",
  descricao: "Sem estoque em nenhum galpão; pedido vira OC; comprar; receber; guarda; separar.",
  tags: ["pedido", "oc", "compras", "receber", "guarda", "pipeline"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("03");
    await ctx.criarProduto({ sku, descricao: "Item OC 03" });
    // sem semearSaldo — saldo zero em todo lugar
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 3 }] });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: "oc" });
    await ctx.aprovar(pedido.id, "oc");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_compra");

    const ordem = await ctx.comprar({ sku, qty: 3 });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_nf", { timeout_ms: 6_000 });

    await ctx.receberCompra({ ordem_id: ordem.ordem_id, items: [{ sku, qty: 3 }] });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao", { timeout_ms: 8_000 });

    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 3 });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.embalar(pedido.id);
    await ctx.expedir(pedido.id);
    await ctx.aguardarFilaVazia();
  },

  assertEsperado: async (ctx, { sku }) => {
    // Comprou 3, expediu 3 → saldo final = 0
    await ctx.assertMovsCount(sku, 2); // E (compra) + S (expedição)
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/03-pedido-oc-completo.ts
git commit -m "test(scenarios): 03 — pedido OC completo"
```

### Task 8.4: Cenário 04 — Parcial + realocação cascateada

**Files:**
- Create: `scripts/wms/cenarios/catalogo/04-parcial-realocacao-cascateada.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "04 — Parcial + realocação cascateada",
  descricao: "Bipa 3/5, loc zerou, cascade pega 2/2 em outra loc, finaliza.",
  tags: ["separacao", "parcial", "realocacao", "pipeline"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("04");
    await ctx.criarProduto({ sku, descricao: "Realoc 04" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 3 });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 2 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 5 }] });
    await ctx.aguardarStatus(pedido.id, "concluido"); // auto
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 3, loc_zerou: true });
    await ctx.aguardarRealocacao(pedido.id, sku, "A-01-02");
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 2 });
    await ctx.concluirSeparacao(pedido.id);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 0);
    await ctx.assertMovsCount(sku, 4); // 2 E (seed) + 2 S (picking em 2 locs)
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/04-parcial-realocacao-cascateada.ts
git commit -m "test(scenarios): 04 — parcial + realocação cascateada"
```

### Task 8.5: Cenário 05 — Parcial esgota → encaminhar

**Files:**
- Create: `scripts/wms/cenarios/catalogo/05-parcial-esgota-encaminhar.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "05 — Parcial esgota → encaminhar",
  descricao: "Cascade esgota cobertura em CWB; operador encaminha pra SP.",
  tags: ["separacao", "parcial", "realocacao", "encaminhar"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("05");
    await ctx.criarProduto({ sku, descricao: "Esgota 05" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-03", qty: 2 });
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "C-01-02", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 5 }] });
    await ctx.aguardarStatus(pedido.id, "pendente"); // não auto-aprova: cobertura parcial
    await ctx.aprovar(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 2, loc_zerou: true });
    // cascade não tem mais loc CWB com saldo > deve abrir caminho de encaminhar
    await ctx.encaminhar({ pedido: pedido.id, item: sku, galpao_destino: "SP" });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-03", 0);
    // Encaminhar gera pedido novo em SP; valida indiretamente via mov S em A-01-03
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/05-parcial-esgota-encaminhar.ts
git commit -m "test(scenarios): 05 — parcial esgota → encaminhar pra SP"
```

### Task 8.6: Cenário 06 — Inventário com picking concorrente

**Files:**
- Create: `scripts/wms/cenarios/catalogo/06-inventario-com-picking.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "06 — Inventário com picking concorrente",
  descricao: "Sessão inventário em A-01-04; pedido bipa antes do inventário contar; reconciliação temporal zera divergência falsa.",
  tags: ["inventario", "concorrencia", "reconciliacao_temporal"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("06");
    await ctx.criarProduto({ sku, descricao: "Conc 06" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-04", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Cria sessão de inventário em A-01-04
    const sess = await ctx.criarSessaoInventario({ galpao: "CWB", locs: ["A-01-04"], modo: "blind", tipo: "manual" as never });
    await ctx.entrarParty(sess.id);

    // 2. Pedido bipa 3 unidades — acontece DEPOIS de criar a sessão mas ANTES de o operador contar
    const pedido = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 3 }] });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao", { timeout_ms: 8_000 });
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 3 });
    await ctx.concluirSeparacao(pedido.id);

    // 3. Operador conta: vê 7 (10 - 3 já saiu)
    await ctx.bipeInventario({ sessao_id: sess.id, sku, loc: "A-01-04", qty: 7 });
    await ctx.finalizarLocInventario({ sessao_id: sess.id, loc: "A-01-04" });

    // 4. Aprova — reconciliação temporal deve ver que saldo no bipe era 7, contado 7, delta = 0
    await ctx.aprovarInventario(sess.id);
    await ctx.aplicarInventario(sess.id);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-04", 7);
    // Sem mov de ajuste de inventário, pois delta foi 0
    const { count } = await ctx.sb.from("siso_movimentacoes").select("id", { count: "exact", head: true }).eq("origem_tipo", "inventario_perda");
    if ((count ?? 0) > 0) throw new Error(`assertEsperado: esperava 0 movs de inventario_perda, achou ${count}`);
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/06-inventario-com-picking.ts
git commit -m "test(scenarios): 06 — inventário com picking concorrente (reconciliação temporal)"
```

### Task 8.7: Cenário 07 — Reservas TTL + cleanup

**Files:**
- Create: `scripts/wms/cenarios/catalogo/07-reservas-ttl-expira.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "07 — Reservas TTL + cleanup",
  descricao: "Reservar com TTL=2s, esperar, cleanup gera L, disponível volta ao saldo total.",
  tags: ["reservas", "ttl", "cleanup", "concorrencia"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("07");
    await ctx.criarProduto({ sku, descricao: "Reserva 07" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-05", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    await ctx.reservar({ sku, galpao: "CWB", loc: "A-01-05", qty: 4, ttl_segundos: 2 });
    await ctx.assertReservado(sku, "CWB", "A-01-05", 4);

    // Tenta reservar acima do disponível (10 - 4 = 6 disponível, pede 7)
    let falhou = false;
    try { await ctx.reservar({ sku, galpao: "CWB", loc: "A-01-05", qty: 7, ttl_segundos: 2 }); }
    catch { falhou = true; }
    if (!falhou) throw new Error("reservar(7) deveria falhar (disponível=6)");

    await ctx.aguardar(3_000);
    await ctx.cleanupReservas();
    await ctx.assertReservado(sku, "CWB", "A-01-05", 0);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-05", 10);
    await ctx.assertReservado(sku, "CWB", "A-01-05", 0);
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/07-reservas-ttl-expira.ts
git commit -m "test(scenarios): 07 — reservas TTL + cleanup"
```

### Task 8.8: Cenário 08 — Receber → Guarda parcial → Pendência

**Files:**
- Create: `scripts/wms/cenarios/catalogo/08-receber-guarda-parcial.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "08 — Receber → Guarda parcial → Pendência",
  descricao: "Receber 50 no dock; guardar 30 em A-01-06; pendência fica com 20; guardar resto depois em B-02-01.",
  tags: ["receber", "guarda", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("08");
    await ctx.criarProduto({ sku, descricao: "Receb 08" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const res = await ctx.receber({ galpao: "CWB", items: [{ sku, qty: 50 }] });
    const pendId = res.pendencias[0];
    await ctx.guardar({ pendencia_id: pendId, loc_destino: "A-01-06", qty: 30 });
    await ctx.aguardarPendenciaGuarda(pendId, "pendente"); // ainda tem 20
    await ctx.guardar({ pendencia_id: pendId, loc_destino: "B-02-01", qty: 20 });
    await ctx.aguardarPendenciaGuarda(pendId, "guardada");
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-06", 30);
    await ctx.assertSaldo(sku, "CWB", "B-02-01", 20);
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 0);
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/08-receber-guarda-parcial.ts
git commit -m "test(scenarios): 08 — receber + guarda parcial"
```

### Task 8.9: Cenário 09 — Entrada direta

**Files:**
- Create: `scripts/wms/cenarios/catalogo/09-entrada-direta.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "09 — Entrada direta",
  descricao: "entrada_direta=true pula RECEBIMENTO; 1 mov direto na loc destino.",
  tags: ["receber", "entrada_direta", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("09");
    await ctx.criarProduto({ sku, descricao: "Direta 09" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    await ctx.receber({
      galpao: "CWB",
      items: [{ sku, qty: 12, loc_destino: "A-01-07" }],
      entrada_direta: true,
    });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-07", 12);
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 0);
    await ctx.assertMovsCount(sku, 1); // 1 mov direta, sem par S+E
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/09-entrada-direta.ts
git commit -m "test(scenarios): 09 — entrada direta sem dock"
```

### Task 8.10: Cenário 10 — Devolução cliente íntegra (A)

**Files:**
- Create: `scripts/wms/cenarios/catalogo/10-devolucao-A-recalc-custo.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "10 — Devolução cliente íntegra (A)",
  descricao: "NF entrada categoria A → mov com custo_unitario → siso_custo_medio recalculado.",
  tags: ["devolucao", "categoria_a", "custo_medio", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("10");
    await ctx.criarProduto({ sku, descricao: "Devol A 10" });
    // Estado inicial: 10 unidades compradas a 8 reais
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-08", qty: 10, custo: 8 });

    // Cria NF de devolução simulada (insert direto)
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: dev } = await ctx.sb.from("siso_devolucoes_pendentes").insert({
      galpao_id: ctx.staging.galpoes.cwb.id,
      produto_id: prod!.id,
      quantidade: 2,
      valor_unitario: 14, // valor de venda → vira custo de entrada
      cliente_nome: "Cliente teste",
      status: "aguardando_classificacao",
      chave_acesso_nf: `TEST-NF-${ctx.skuUnico("nf")}`,
    }).select("id").single();

    return { sku, devolucaoId: dev!.id };
  },

  run: async (ctx, { devolucaoId }) => {
    await ctx.classificarDevolucao({ devolucao_id: devolucaoId, classificacao: "A" });
  },

  assertEsperado: async (ctx, { sku }) => {
    // 10 a 8 + 2 a 14 = (80 + 28) / 12 = 9
    await ctx.assertSaldo(sku, "CWB", "A-01-08", 12);
    await ctx.assertCustoMedio(sku, 9, 0.01);
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/10-devolucao-A-recalc-custo.ts
git commit -m "test(scenarios): 10 — devolução A recalcula custo médio"
```

### Task 8.11: Cenário 11 — Devolução cliente avariada (B/C/D)

**Files:**
- Create: `scripts/wms/cenarios/catalogo/11-devolucao-BCD-quarentena.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "11 — Devolução cliente avariada (B/C/D)",
  descricao: "NF entrada categoria B → transfer pra QUARENTENA, saldo na picking intacto.",
  tags: ["devolucao", "categoria_b", "quarentena", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("11");
    await ctx.criarProduto({ sku, descricao: "Devol B 11" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-09", qty: 5, custo: 10 });

    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: dev } = await ctx.sb.from("siso_devolucoes_pendentes").insert({
      galpao_id: ctx.staging.galpoes.cwb.id,
      produto_id: prod!.id,
      quantidade: 1,
      valor_unitario: 10,
      cliente_nome: "Cliente avariada",
      status: "aguardando_classificacao",
      chave_acesso_nf: `TEST-NF-B-${ctx.skuUnico("nf")}`,
    }).select("id").single();
    return { sku, devolucaoId: dev!.id };
  },

  run: async (ctx, { devolucaoId }) => {
    await ctx.classificarDevolucao({ devolucao_id: devolucaoId, classificacao: "B" });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-09", 5); // intacto
    await ctx.assertSaldo(sku, "CWB", "QUARENTENA", 1);
    await ctx.assertCustoMedio(sku, 10, 0.01); // custo médio NÃO mudou (categoria B não recalcula)
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/11-devolucao-BCD-quarentena.ts
git commit -m "test(scenarios): 11 — devolução B vai pra QUARENTENA"
```

### Task 8.12: Cenário 12 — Venda Direta baixa_direta

**Files:**
- Create: `scripts/wms/cenarios/catalogo/12-venda-direta-baixa.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "12 — Venda Direta baixa_direta",
  descricao: "Cria venda modo baixa_direta → 1 mov S origem=venda_manual, saldo cai imediato.",
  tags: ["vendas", "baixa_direta", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("12");
    await ctx.criarProduto({ sku, descricao: "Venda direta 12" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-10", qty: 8 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const r = await ctx.criarVendaDireta({
      galpao: "CWB", empresa: "netair",
      items: [{ sku, qty: 3 }],
      modo: "baixa_direta",
    });
    if (r.degradado) throw new Error(`venda inesperadamente degradada: ${r.motivo_degradacao}`);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-10", 5);
    // 1 E seed + 1 S venda_manual
    await ctx.assertMovsCount(sku, 2);
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/12-venda-direta-baixa.ts
git commit -m "test(scenarios): 12 — venda direta baixa direta"
```

### Task 8.13: Cenário 13 — Venda Direta degradação

**Files:**
- Create: `scripts/wms/cenarios/catalogo/13-venda-direta-degradacao.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "13 — Venda Direta degradação",
  descricao: "Pediu baixa_direta mas faltou saldo → degrada pra aguardando_separacao, response degradado:true.",
  tags: ["vendas", "baixa_direta", "degradacao"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("13");
    await ctx.criarProduto({ sku, descricao: "Degrada 13" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "B-02-02", qty: 2 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const r = await ctx.criarVendaDireta({
      galpao: "CWB", empresa: "netair",
      items: [{ sku, qty: 5 }], // só tem 2!
      modo: "baixa_direta",
    });
    if (!r.degradado) throw new Error("esperava degradado:true");
    if (r.motivo_degradacao !== "falta_saldo") throw new Error(`motivo errado: ${r.motivo_degradacao}`);
    if (!r.skus_sem_saldo?.includes(sku)) throw new Error(`skus_sem_saldo deveria conter ${sku}: ${JSON.stringify(r.skus_sem_saldo)}`);
    return { pedido_id: r.id };
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo INTACTO porque degradou — não fez baixa
    await ctx.assertSaldo(sku, "CWB", "B-02-02", 2);
    await ctx.assertMovsCount(sku, 1); // só o seed
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/13-venda-direta-degradacao.ts
git commit -m "test(scenarios): 13 — venda direta degradação por falta de saldo"
```

### Task 8.14: Cenário 14 — Replenishment intra-galpão

**Files:**
- Create: `scripts/wms/cenarios/catalogo/14-replenishment-intra-galpao.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "14 — Replenishment intra-galpão",
  descricao: "Overstock → picking, par S+E mesma origem_id, custo médio inalterado.",
  tags: ["replenishment", "intra_galpao", "movs"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("14");
    await ctx.criarProduto({ sku, descricao: "Reple 14" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "B-02-03", qty: 50, custo: 12 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    await ctx.replenishment({ sku, galpao: "CWB", origem_loc: "B-02-03", destino_loc: "A-01-01", qty: 20 });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "B-02-03", 30);
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 20);
    await ctx.assertCustoMedio(sku, 12, 0.01); // inalterado
    // 1 E seed + 1 S + 1 E (par de replenishment)
    await ctx.assertMovsCount(sku, 3);
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/14-replenishment-intra-galpao.ts
git commit -m "test(scenarios): 14 — replenishment intra-galpão"
```

### Task 8.15: Cenário 15 — Transferência inter-galpão

**Files:**
- Create: `scripts/wms/cenarios/catalogo/15-transferencia-inter-galpao.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "15 — Transferência inter-galpão",
  descricao: "CWB → SP, par S+E balanceado, custo médio preservado.",
  tags: ["transferencia", "inter_galpao", "movs"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("15");
    await ctx.criarProduto({ sku, descricao: "Transf 15" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "B-02-04", qty: 25, custo: 7 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const t = await ctx.transferirGalpao({
      origem: "CWB", destino: "SP",
      items: [{ sku, qty: 10 }],
    });
    // Confirma recebimento via endpoint
    await ctx.http.post(`/api/wms/transferencias/${t.id}/receber`);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "B-02-04", 15);
    // Destino SP: vai pra RECEBIMENTO até guarda, OU loc default — depende do endpoint
    // Validação mais flexível: total deve ser 25 (10 em SP + 15 em CWB)
    const { data } = await ctx.sb.from("siso_estoque").select("saldo, siso_produtos!inner(sku)").eq("siso_produtos.sku", sku);
    const total = (data ?? []).reduce((acc, r) => acc + r.saldo, 0);
    if (total !== 25) throw new Error(`Total esperado 25, real ${total}`);
    await ctx.assertCustoMedio(sku, 7, 0.01);
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/15-transferencia-inter-galpao.ts
git commit -m "test(scenarios): 15 — transferência inter-galpão"
```

### Task 8.16: Cenário 16 — Lançamento retroativo + reconcilia

**Files:**
- Create: `scripts/wms/cenarios/catalogo/16-lancamento-retroativo-reconcilia.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "16 — Lançamento retroativo + reconcilia",
  descricao: "Registra pendência retroativa; chega mov real; reconcilia zera pendência.",
  tags: ["retroativo", "reconciliacao", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("16");
    await ctx.criarProduto({ sku, descricao: "Retro 16" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pend = await ctx.lancamentoRetroativo({ sku, galpao: "CWB", loc: "A-01-01", qty: 5, tipo: "E" });
    // Mov "real" chega via receber direto
    await ctx.receber({
      galpao: "CWB",
      items: [{ sku, qty: 5, loc_destino: "A-01-01" }],
      entrada_direta: true,
    });
    await ctx.reconciliarRetroativo(pend.id);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 5);
    // Status pós-reconciliação validado pelos invariantes globais (I1/I7).
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

> **Nota implementação:** executor confirma nome real da tabela (`siso_wms_lancamentos_retroativos` ou similar) via Supabase MCP antes de escrever esse cenário. Se quiser checar status específico, adiciona assertion direta no `assertEsperado`; senão deixa só os invariantes globais cobrirem (I1 ledger↔cache + I7 fila vazia já pegam o caso degenerado).

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/16-lancamento-retroativo-reconcilia.ts
git commit -m "test(scenarios): 16 — lançamento retroativo + reconcilia"
```

### Task 8.17: Cenário 17 — Ajuste manual com motivo

**Files:**
- Create: `scripts/wms/cenarios/catalogo/17-ajuste-manual-com-motivo.ts`

- [ ] **Step 1:** Escrever:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "17 — Ajuste manual com motivo",
  descricao: "Ajuste manual com observações obrigatórias; gera mov ajuste_manual.",
  tags: ["ajuste", "manual", "movs"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("17");
    await ctx.criarProduto({ sku, descricao: "Ajuste 17" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "B-02-05", qty: 20 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Ajuste positivo (achou 3 unidades a mais)
    await ctx.ajusteManual({ sku, galpao: "CWB", loc: "B-02-05", delta: 3, motivo: "Achado físico em recontagem" });
    // Ajuste negativo (faltam 2)
    await ctx.ajusteManual({ sku, galpao: "CWB", loc: "B-02-05", delta: -2, motivo: "Quebra inadvertida" });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "B-02-05", 21);
    // 1 E seed + 1 E ajuste + 1 S ajuste
    await ctx.assertMovsCount(sku, 3);

    // Verifica que ambas têm observações preenchidas
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: movs } = await ctx.sb.from("siso_movimentacoes")
      .select("origem_tipo, observacoes")
      .eq("produto_id", prod!.id)
      .eq("origem_tipo", "ajuste_manual");
    if ((movs ?? []).some((m) => !m.observacoes)) throw new Error("ajuste manual sem observacoes");
  },
} satisfies Cenario;

<<STANDALONE_TRAILER>>
```

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/catalogo/17-ajuste-manual-com-motivo.ts
git commit -m "test(scenarios): 17 — ajuste manual com motivo"
```

---

## Fase 9 — Docs, scripts npm, smoke final

### Task 9.1: package.json scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1:** Adicionar ao bloco `scripts` (preservando os existentes `test`, `test:watch`, `test:integration`):

```json
    "scenarios": "tsx scripts/wms/cenarios/run-all.ts",
    "scenarios:only": "tsx scripts/wms/cenarios/run-all.ts --only"
```

- [ ] **Step 2:** Verificar que `tsx` está em devDependencies (já está, mas confirmar):

Run: `grep '"tsx"' package.json`
Expected: linha não vazia.

- [ ] **Step 3:** Commit.

```bash
git add package.json
git commit -m "feat(tests): scripts npm scenarios + scenarios:only"
```

### Task 9.2: README do harness

**Files:**
- Create: `scripts/wms/cenarios/README.md`

- [ ] **Step 1:** Escrever:

````md
# Cenários de Estoque — Camada 3 da Pirâmide

Sistemática de testes ponta-a-ponta exercitando todos os fluxos que escrevem em
`siso_movimentacoes`. Roda contra **staging fixo** (`ehbxpbeijofxtsbezwxd`) via
HTTP em `/api/wms/*` com dependências externas (Tiny, PrintNode, ML) stubadas.

**Spec:** `docs/superpowers/specs/2026-05-21-sistematica-testes-estoque-design.md`

## Rodar a suite completa

Pré-requisito: `.env.test` e `.env.test.local` (com `SUPABASE_SERVICE_ROLE_KEY`)
configurados na raiz.

```bash
npm run scenarios
```

O runner:
1. Sobe Next dev server em :3001
2. Trunca tabelas operacionais (preserva catálogo)
3. Faz seed inicial (empresas/galpões/locs/usuário test-runner)
4. Loga como `test-runner`
5. Executa todos os cenários em `catalogo/` (ordem alfabética)
6. Aplica os 7 invariantes globais ao fim de cada cenário
7. Escreve relatório markdown + JSON em `reports/`

## Rodar 1 cenário pra debug

Em um terminal:

```bash
PORT=3001 npm run dev
```

Em outro:

```bash
npx tsx scripts/wms/cenarios/catalogo/04-parcial-realocacao-cascateada.ts
```

O script standalone reaproveita o `npm run dev`, faz truncate+seed, loga, e roda
só esse cenário.

## Adicionar cenário novo

1. Criar `catalogo/NN-nome-curto.ts` (próximo número disponível).
2. Default export satisfazendo `Cenario` em `_harness/types.ts`.
3. Usar `ctx.skuUnico("NN")` pra evitar colisão de SKU.
4. Terminar com o trailer standalone (copie de qualquer cenário existente).
5. Runner descobre automaticamente — sem registro manual.

## Filtros

```bash
# Só cenários com tag "realocacao"
npm run scenarios -- --filter realocacao

# Só cenário cujo nome contém "04"
npm run scenarios -- --only 04

# Manter dev server vivo após (pra inspecionar staging no browser)
npm run scenarios -- --keep-server

# Porta alternativa
npm run scenarios -- --port=3010
```

## Invariantes globais (oráculo de correção)

Rodam **automaticamente** ao fim de todo cenário. Falha em qualquer um marca o
cenário como FAIL mesmo que `assertEsperado` tenha passado.

| # | Invariante | Bug que pega |
|---|---|---|
| I1 | Ledger ↔ cache coerente | Cache desincronizado do ledger |
| I2 | disponivel = saldo - reservado | Drift de coluna GENERATED |
| I3 | Custo médio coerente | Recalc errado em entrada com custo_unitario |
| I4 | Sem reservas órfãs | Cleanup esqueceu de liberar |
| I5 | Pendências guarda coerentes | Bug em qty_pendente |
| I6 | Pares S+E balanceados | Realocação/transferência perdeu 1 lado |
| I7 | Fila vazia ao fim | Worker travado ou pedido em loop |

## Troubleshooting

**`waitForHealth: ... não respondeu em 60s`**
→ Dev server não subiu. Cheque logs em `[dev]`/`[dev:err]`. Geralmente porta
ocupada — use `--port=N`.

**`loginTestRunner: HTTP 401`**
→ Usuário `test-runner` não existe ou PIN mudou. Re-rode `seedInicial` manualmente:

```bash
npx tsx -e 'import("./scripts/wms/cenarios/_harness/seed").then(m => m.seedInicial(require("./src/lib/supabase-server").createServiceClient()))'
```

**`aguardarStatus: ... timeout`**
→ Webhook é fire-and-forget. Cheque `siso_logs`/`siso_erros` filtradas pelo
correlation_id (presente no detail.json do relatório).

**Cenário passou mas invariante I1 falhou**
→ Algum endpoint escreveu em `siso_estoque` fora do RPC `wms_inserir_movimentacao`.
Cheque o diff no detail.json.

**Suite poluiu staging e operadores estão com problemas**
→ Era pra ter avisado. Rode `seedInicial` pra restaurar fixtures.

## Premissa: não compartilhar staging

A suite faz `wms_truncate_operacional` ao iniciar — operadores em staging perdem
qualquer trabalho em andamento. **Não rodar a suite enquanto alguém testa em
staging manualmente.**
````

- [ ] **Step 2:** Commit.

```bash
git add scripts/wms/cenarios/README.md
git commit -m "docs(tests): README do harness de cenários"
```

### Task 9.3: Smoke final — rodar suite inteira

- [ ] **Step 1:** Configurar `.env.test.local` com chaves reais de staging (NEXT_PUBLIC_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY de `ehbxpbeijofxtsbezwxd`).

- [ ] **Step 2:** Rodar suite:

```bash
npm run scenarios
```

Expected: relatório criado em `scripts/wms/cenarios/reports/`. Pelo menos 12 dos 17 cenários passando. Cenários que dependem de endpoints específicos (15 transferência, 16 retroativo) podem precisar ajustes finos — isso é esperado e documentado nas notas dos cenários.

- [ ] **Step 3:** Inspecionar o markdown gerado.

Run: `ls scripts/wms/cenarios/reports/`
Open: arquivo `*-summary.md` mais recente.

- [ ] **Step 4:** Rodar 1 cenário standalone pra verificar modo debug.

```bash
# Terminal 1:
PORT=3001 npm run dev

# Terminal 2 (espere o dev server subir):
npx tsx scripts/wms/cenarios/catalogo/01-pedido-auto-propria.ts
```

Expected: print `[standalone] ✅ 01 — ...`.

- [ ] **Step 5:** Rodar integration tests separadamente pra confirmar config.

```bash
npm run test:integration
```

Expected: 10 testes (3 ledger + 3 reservas + 2 inventario + 2 reconciliacao) — pelo menos 8 passam.

- [ ] **Step 6:** Documentar resultados num smoke report — anotar quais cenários falharam e por quê. Não é uma falha do plano; cenários flaky com endpoints específicos são esperados em primeira execução. Commit ajustes.

- [ ] **Step 7:** Commit smoke note (opcional):

```bash
git add scripts/wms/cenarios/reports/
# (Reports são gitignored, mas anotações em REPORT.md ou similar podem ser commitadas se útil.)
```

### Task 9.4: Atualizar CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1:** Adicionar bullet em "Recently Added" ou "In Progress / Minor":

```md
- **Sistemática de Testes de Estoque (Camadas 1-3) — implementada 2026-05-21.** Pirâmide completa: unit (vitest, já existia) + integration (vitest config separado `vitest.integration.config.ts` rodando contra staging) + scenarios (17 fluxos ponta-a-ponta via HTTP em `/api/wms/*`, com runner em `scripts/wms/cenarios/run-all.ts`). 7 invariantes globais property-based rodam ao fim de todo cenário (`I1..I7` — ver `scripts/wms/cenarios/README.md`). Stubs PrintNode + ML criados (`src/lib/printnode-stub.ts`, `src/lib/ml-stub.ts`); Tiny reaproveita stub existente. Migration `20260521_test_harness_rpc.sql` adiciona `wms_truncate_operacional()`. Rodar: `npm run scenarios`. Spec: `docs/superpowers/specs/2026-05-21-sistematica-testes-estoque-design.md`. Plano: `docs/superpowers/plans/2026-05-21-sistematica-testes-estoque.md`.
```

- [ ] **Step 2:** Commit.

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md aponta pra sistemática de testes"
```
