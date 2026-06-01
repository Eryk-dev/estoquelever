# Bateria Automática de Testes de Estoque (Ledger Guard) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar a suíte de cenários de estoque (82 cenários + invariantes globais) determinística e verde, fechar as lacunas de cobertura de maior risco, e fazê-la rodar sozinha toda noite contra staging com alerta no Slack/Discord quando algum fluxo de estoque quebrar.

**Architecture:** Quatro frentes em sequência — (1) estabilizar o harness (build de produção em vez de `next dev`, retry com backoff, recuperação de saúde do servidor, taxonomia de falha); (2) fortalecer invariantes (novo I8 de paridade de `reservado`, ajustar I2/I3); (3) rodar limpo e triar os bugs reais que emergirem; (4) adicionar cenários novos pros caminhos hoje sem cobertura; (5) automatizar via GitHub Actions agendado + webhook.

**Tech Stack:** Next.js 16.1.6, TypeScript, tsx, vitest, Supabase (Postgres RPC), GitHub Actions. Ambiente: staging `ehbxpbeijofxtsbezwxd` (somente).

**Spec:** `docs/superpowers/specs/2026-06-01-bateria-testes-estoque-design.md`

---

## Pré-condições (antes de começar)

- Branch dedicada `test/stock-ledger-suite` criada a partir de `develop` (ver Task 0.1).
- `.env.test.local` presente localmente com as chaves reais de staging (anon + service role). Sem isso, nada roda.
- Migrations aplicadas via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`.
- ⚠️ A suíte **trunca tabelas operacionais de staging**. Rodar só quando ninguém estiver usando staging manualmente.

---

## Mapa de arquivos

**Modificados:**
- `scripts/wms/cenarios/_harness/http.ts` — retry com backoff + `NetworkError`.
- `scripts/wms/cenarios/_harness/dev-server.ts` — modo prod (`next start`), `buildProd`, `isHealthy`.
- `scripts/wms/cenarios/_harness/types.ts` — `ScenarioResult.classe`.
- `scripts/wms/cenarios/run-all.ts` — taxonomia, recuperação de saúde, modo `--prod`, exit code por `product-fail`.
- `scripts/wms/cenarios/_harness/relatorio.ts` — contagem por classe no md + json.
- `scripts/wms/cenarios/_harness/invariantes.ts` — novo I8, ajuste I2/I3.
- `vitest.config.ts` — incluir testes do harness.
- `package.json` — scripts `scenarios:ci`, `notify:stock`.
- `CLAUDE.md` — atualizar status.

**Criados:**
- `scripts/wms/cenarios/_harness/http.test.ts` — testes do retry.
- `scripts/wms/cenarios/notify-slack.ts` + `notify-slack.test.ts` — alerta.
- `scripts/wms/cenarios/catalogo/71-estornar-pedido-d10.ts` — estorno admin de pedido inteiro.
- `scripts/wms/cenarios/catalogo/72-liberar-reservas-d2.ts` — override admin libera R.
- `scripts/wms/cenarios/catalogo/73-conversao-nf-rls.ts` — conversão NF R→L+S isolada.
- `scripts/wms/cenarios/catalogo/74-loc-move-com-reserva.ts` — mudança de loc com reservado>0.
- `scripts/wms/cenarios/catalogo/75-guarda-cancelar-motivo.ts` — cancelar pendência de guarda.
- `supabase/migrations/20260601_truncate_add_transferencias_galpao.sql`
- `supabase/migrations/20260601b_rpc_divergencias_reservado.sql`
- `test/integration/reconciliacao-reservado-rpc.test.ts`
- `.github/workflows/wms-stock-suite.yml`
- `docs/superpowers/runbook-bateria-estoque.md`

---

## Task 0: Setup da branch

### Task 0.1: Branch dedicada + commit do spec/plano

**Files:**
- (git) branch nova

- [ ] **Step 1: Garantir árvore limpa e criar branch a partir de develop**

> Se houver mudanças não-commitadas de outro trabalho (ex.: `perf/p0-floor-quickwins`), pare e confirme com o Eryk antes — não misturar. Assumindo árvore limpa ou apenas os docs deste trabalho:

```bash
git fetch origin
git checkout -b test/stock-ledger-suite origin/develop
```

- [ ] **Step 2: Trazer spec + plano pra branch e commitar**

```bash
git add docs/superpowers/specs/2026-06-01-bateria-testes-estoque-design.md \
        docs/superpowers/plans/2026-06-01-bateria-testes-estoque.md
git commit -m "docs(testes): spec + plano da bateria automática de estoque"
```

---

## Task 0.2: Baseline — capturar o estado atual da suíte

Antes de mudar qualquer coisa, registrar o ponto de partida (quantos passam/falham hoje).

**Files:** nenhum (apenas execução)

- [ ] **Step 1: Rodar a suíte como está (modo dev atual)**

Run: `npm run scenarios`
Expected: roda ~50-60 min, gera `scripts/wms/cenarios/reports/<ts>-summary.md`. Muitas falhas `run` (fetch failed) esperadas — é o baseline ruim que vamos consertar.

- [ ] **Step 2: Arquivar o relatório de baseline**

```bash
cp scripts/wms/cenarios/reports/$(ls -t scripts/wms/cenarios/reports/ | grep summary | head -1) \
   docs/superpowers/baseline-suite-2026-06-01.md
git add docs/superpowers/baseline-suite-2026-06-01.md
git commit -m "test(estoque): baseline da suíte antes da estabilização"
```

---

## Fase 1 — Estabilização do harness

### Task 1.1: Retry com backoff + `NetworkError` no HTTP client

Distingue blip de rede (servidor caiu → retry) de erro de negócio 4xx/5xx (sinal real → nunca retry).

**Files:**
- Modify: `scripts/wms/cenarios/_harness/http.ts`
- Modify: `vitest.config.ts`
- Test: `scripts/wms/cenarios/_harness/http.test.ts`

- [ ] **Step 1: Incluir os testes do harness no vitest**

Read `vitest.config.ts`. No array `test.include`, adicionar o glob do harness. Resultado esperado (merge com o existente):

```ts
// dentro de defineConfig({ test: { ... } })
include: [
  "src/**/*.test.{ts,tsx}",
  "scripts/wms/cenarios/**/*.test.ts",
],
```

- [ ] **Step 2: Escrever os testes (que falham) do retry**

Create `scripts/wms/cenarios/_harness/http.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttp, HttpError, NetworkError } from "./http";

afterEach(() => vi.restoreAllMocks());

function http() {
  return createHttp({ baseUrl: "http://x", sessionId: "s", correlationId: "c" });
}

describe("http retry", () => {
  it("retenta em throw de rede e sucede na 2ª tentativa", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await http().get<{ ok: boolean }>("/x");
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lança NetworkError após esgotar retries de rede", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(http().get("/x")).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("NÃO retenta num 400 de negócio — lança HttpError na hora", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(http().post("/x", {})).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retenta em 503 e sucede quando estabiliza", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await http().get<{ ok: number }>("/x");
    expect(r.ok).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Rodar e verificar que falham**

Run: `npx vitest run scripts/wms/cenarios/_harness/http.test.ts`
Expected: FAIL — `NetworkError` não existe ainda; retries não acontecem.

- [ ] **Step 4: Implementar retry + `NetworkError`**

Replace o conteúdo de `scripts/wms/cenarios/_harness/http.ts`:

```ts
import type { HttpClient } from "./types";

export class HttpError extends Error {
  constructor(public method: string, public path: string, public status: number, public body: unknown) {
    super(`${method} ${path} → HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    this.name = "HttpError";
  }
}

// Erro de rede/infra (servidor caiu, ECONNRESET) — distinto de um 4xx/5xx de
// negócio. Usado pra classificar a falha como "infra-fail" e nunca mascarar bug
// de estoque como se fosse instabilidade.
export class NetworkError extends Error {
  constructor(public method: string, public path: string, public causa: unknown) {
    super(`${method} ${path} → erro de rede após retries: ${causa instanceof Error ? causa.message : String(causa)}`);
    this.name = "NetworkError";
  }
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_TENTATIVAS = 3;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function createHttp(opts: { baseUrl: string; sessionId: string; correlationId: string }): HttpClient {
  async function request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const url = `${opts.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "X-Session-Id": opts.sessionId,
      "X-Correlation-Id": opts.correlationId,
      ...(extraHeaders ?? {}),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let ultimoErroRede: unknown = null;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        // throw de rede (fetch failed / ECONNRESET / ECONNREFUSED) → retry com backoff
        ultimoErroRede = e;
        if (tentativa < MAX_TENTATIVAS) {
          await sleep(250 * 2 ** (tentativa - 1));
          continue;
        }
        throw new NetworkError(method, path, e);
      }

      // 502/503/504 = servidor instável → retry. Outros 4xx/5xx = erro de
      // negócio (o sinal que estamos testando) → NÃO retry.
      if (RETRYABLE_STATUS.has(res.status) && tentativa < MAX_TENTATIVAS) {
        await sleep(250 * 2 ** (tentativa - 1));
        continue;
      }

      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }

      if (!res.ok) throw new HttpError(method, path, res.status, parsed);
      return parsed as T;
    }
    throw new NetworkError(method, path, ultimoErroRede);
  }

  return {
    get: (p, headers) => request("GET", p, undefined, headers),
    post: (p, b, headers) => request("POST", p, b, headers),
    patch: (p, b, headers) => request("PATCH", p, b, headers),
    delete: (p, headers) => request("DELETE", p, undefined, headers),
  };
}
```

- [ ] **Step 5: Rodar e verificar que passam**

Run: `npx vitest run scripts/wms/cenarios/_harness/http.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 6: Commit**

```bash
git add scripts/wms/cenarios/_harness/http.ts scripts/wms/cenarios/_harness/http.test.ts vitest.config.ts
git commit -m "test(harness): retry com backoff + NetworkError no http client"
```

---

### Task 1.2: Taxonomia de falha (`pass` / `product-fail` / `infra-fail`)

O alerta e o exit code disparam só em `product-fail`. `infra-fail` (rede/servidor após retries) é sinalizado à parte e nunca se disfarça de bug de estoque.

**Files:**
- Modify: `scripts/wms/cenarios/_harness/types.ts:151-161`
- Modify: `scripts/wms/cenarios/run-all.ts:36-75,144-145`
- Modify: `scripts/wms/cenarios/_harness/relatorio.ts`

- [ ] **Step 1: Adicionar `classe` ao `ScenarioResult`**

Modify `scripts/wms/cenarios/_harness/types.ts` — no interface `ScenarioResult`, adicionar o campo `classe` e ampliar `motivo` com `"infra"`:

```ts
export interface ScenarioResult {
  nome: string;
  status: "pass" | "fail" | "skip";
  classe?: "pass" | "product-fail" | "infra-fail";
  duracao_ms?: number;
  motivo?: "assert" | "invariante" | "timeout" | "setup" | "run" | "infra";
  erro?: { mensagem: string; stack?: string };
  invariantes?: InvariantResult[];
  detalhes?: unknown;
  correlation_id?: string;
  logs?: unknown[];
}
```

- [ ] **Step 2: Classificar no `rodarCenario`**

Modify `scripts/wms/cenarios/run-all.ts`. No `rodarCenario`, setar `classe` nos três caminhos. Substituir o bloco `try`/`catch` (linhas ~42-74) por:

```ts
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
        classe: "product-fail",
        duracao_ms: Date.now() - t0,
        motivo: "invariante",
        detalhes: { invariantes_falhando: falhas },
        invariantes: invs,
        correlation_id: correlationId,
      };
    }
    return { nome: args.cenario.nome, status: "pass", classe: "pass", duracao_ms: Date.now() - t0, invariantes: invs, correlation_id: correlationId };
  } catch (err) {
    const e = err as Error;
    const ehInfra = e.name === "NetworkError";
    const { data: logs } = await args.sb.from("siso_logs").select("level, source, message, created_at").eq("correlation_id", correlationId).order("created_at", { ascending: false }).limit(50);
    const { data: erros } = await args.sb.from("siso_erros").select("category, message, stack_trace, created_at").eq("correlation_id", correlationId).limit(50);
    return {
      nome: args.cenario.nome,
      status: "fail",
      classe: ehInfra ? "infra-fail" : "product-fail",
      duracao_ms: Date.now() - t0,
      motivo: e.name === "HttpError" ? "run" : ehInfra ? "infra" : "assert",
      erro: { mensagem: e.message, stack: e.stack },
      detalhes: { logs, erros },
      correlation_id: correlationId,
    };
  }
```

- [ ] **Step 3: Exit code por `product-fail`**

Modify `scripts/wms/cenarios/run-all.ts` — substituir as linhas finais (`const failed = ...` + `process.exit(failed ? 1 : 0)`, ~144-145) por:

```ts
  const productFail = results.filter((r) => r.classe === "product-fail").length;
  const infraFail = results.filter((r) => r.classe === "infra-fail").length;
  console.log(`  product-fail: ${productFail} · infra-fail: ${infraFail}`);
  // Só product-fail derruba o build (alerta de bug de estoque). infra-fail é
  // inconclusivo — sinalizado no relatório/alerta, mas não vira "bug".
  process.exit(productFail > 0 ? 1 : 0);
```

- [ ] **Step 4: Contagem por classe no relatório**

Modify `scripts/wms/cenarios/_harness/relatorio.ts`. No `writeReport`, calcular as classes e injetar no JSON `totais`; e no `buildMarkdown` mostrar a linha de classes. Substituir o cálculo + JSON (linhas ~10-20) por:

```ts
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skip = results.filter((r) => r.status === "skip").length;
  const productFail = results.filter((r) => r.classe === "product-fail").length;
  const infraFail = results.filter((r) => r.classe === "infra-fail").length;

  const md = buildMarkdown(results, iniciadoEm, duracaoMs, pass, fail, skip, productFail, infraFail);
  const json = JSON.stringify({
    iniciado_em: iniciadoEm.toISOString(),
    duracao_ms: duracaoMs,
    totais: { pass, fail, skip, product_fail: productFail, infra_fail: infraFail },
    cenarios: results,
  }, null, 2);
```

E atualizar a assinatura + cabeçalho do `buildMarkdown` (linhas ~28-34):

```ts
function buildMarkdown(results: ScenarioResult[], iniciado: Date, duracaoMs: number, pass: number, fail: number, skip: number, productFail: number, infraFail: number): string {
  const dur = formatarDuracao(duracaoMs);
  const lines: string[] = [];
  lines.push(`# Suite Scenarios — ${iniciado.toISOString()}`);
  lines.push("");
  lines.push(`**Total:** ${results.length} · **Pass:** ${pass} · **Fail:** ${fail} (🔴 ${productFail} bug · 🟡 ${infraFail} infra) · **Skip:** ${skip} · **Tempo:** ${dur}`);
  lines.push("");
```

- [ ] **Step 5: Verificar que compila**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros nos arquivos do harness. (Se o projeto não tiver `tsc` direto, usar `npx vitest run scripts/wms/cenarios/_harness/http.test.ts` como smoke de import.)

- [ ] **Step 6: Commit**

```bash
git add scripts/wms/cenarios/_harness/types.ts scripts/wms/cenarios/run-all.ts scripts/wms/cenarios/_harness/relatorio.ts
git commit -m "test(harness): taxonomia product-fail vs infra-fail no relatório e exit code"
```

---

### Task 1.3: Modo build de produção (`--prod`)

`next dev` (turbopack, compila sob demanda) é a fonte nº 1 de instabilidade e lentidão. Modo prod builda uma vez e roda `next start` — rápido e estável.

**Files:**
- Modify: `scripts/wms/cenarios/_harness/dev-server.ts`
- Modify: `scripts/wms/cenarios/run-all.ts:16-28,82-93`
- Modify: `package.json:18-21`

- [ ] **Step 1: `dev-server.ts` ganha modo prod + `buildProd`**

Modify `scripts/wms/cenarios/_harness/dev-server.ts` — trocar a assinatura de `startDevServer` e adicionar `buildProd` + `isHealthy`:

```ts
import { spawn, type ChildProcess } from "child_process";

export interface DevServerHandle {
  process: ChildProcess;
  port: number;
  kill: () => Promise<void>;
}

export async function buildProd(opts: { cwd?: string } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("npx", ["next", "build"], {
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    proc.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next build saiu com código ${code}`))));
  });
}

export async function startDevServer(opts: { port: number; cwd?: string; prod?: boolean }): Promise<DevServerHandle> {
  const env = { ...process.env, PORT: String(opts.port), NODE_ENV: opts.prod ? "production" : "development" };
  const cmd = opts.prod
    ? ["next", "start", "-p", String(opts.port)]
    : ["next", "dev", "-p", String(opts.port)];
  const proc = spawn("npx", cmd, {
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (chunk) => process.stderr.write(`[srv] ${chunk}`));
  proc.stderr?.on("data", (chunk) => process.stderr.write(`[srv:err] ${chunk}`));

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

export async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET" });
    return res.status > 0;
  } catch {
    return false;
  }
}
```

> Mantém `waitForHealth` e `loginTestRunner` como estão (não reescrever — apenas adicionar o que está acima e trocar a assinatura de `startDevServer`).

- [ ] **Step 2: `run-all.ts` aceita `--prod` e builda antes**

Modify `scripts/wms/cenarios/run-all.ts`:

(a) No `interface Args` e `parseArgs` (linhas 16-28), adicionar `prod`:

```ts
interface Args { only?: string; filter?: string; keepServer: boolean; port: number; prod: boolean; }

function parseArgs(): Args {
  const a: Args = { keepServer: false, port: 3001, prod: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") a.only = argv[++i];
    else if (argv[i] === "--filter") a.filter = argv[++i];
    else if (argv[i] === "--keep-server") a.keepServer = true;
    else if (argv[i] === "--prod") a.prod = true;
    else if (argv[i].startsWith("--port=")) a.port = Number(argv[i].slice(7));
  }
  return a;
}
```

(b) No `main` (linhas ~82-85), buildar quando `--prod` e subir o servidor no modo certo. Atualizar o import (linha 12) e o trecho de subida:

```ts
import { loginTestRunner, startDevServer, waitForHealth, buildProd, isHealthy, type DevServerHandle } from "./_harness/dev-server";
```

```ts
  const baseUrl = `http://localhost:${args.port}`;

  if (args.prod) {
    console.log(`[0/6] next build (modo prod)`);
    await buildProd();
  }

  console.log(`[1/6] subindo Next ${args.prod ? "start" : "dev"} server em :${args.port}`);
  let server: DevServerHandle = await startDevServer({ port: args.port, prod: args.prod });
  process.on("SIGINT", () => server.kill().then(() => process.exit(130)));
```

> Nota: `server` passa de `const` pra `let` (a recuperação de saúde da Task 1.4 reatribui). O `sessionId` (linha ~101) também vira `let` na Task 1.4.

- [ ] **Step 3: Script `scenarios:ci`**

Modify `package.json` — adicionar no bloco `scripts`:

```json
    "scenarios:ci": "tsx scripts/wms/cenarios/run-all.ts --prod",
```

- [ ] **Step 4: Smoke local do modo prod (1 cenário)**

Run: `npm run scenarios:ci -- --only "49b"`
Expected: faz `next build`, sobe `next start`, roda o cenário 49b, PASS. (Build leva alguns minutos.)

- [ ] **Step 5: Commit**

```bash
git add scripts/wms/cenarios/_harness/dev-server.ts scripts/wms/cenarios/run-all.ts package.json
git commit -m "test(harness): modo build de produção (--prod) + scenarios:ci"
```

---

### Task 1.4: Recuperação de saúde do servidor entre cenários

Se o servidor morre no meio, em vez de cascatear "fetch failed" no resto da run, reinicia uma vez + re-login. Se não recupera, aborta com veredicto infra claro.

**Files:**
- Modify: `scripts/wms/cenarios/run-all.ts:96-135`

- [ ] **Step 1: Tornar `sessionId` mutável e adicionar `garantirServidor`**

Modify `scripts/wms/cenarios/run-all.ts`. Logo após o login (linha ~101-105), trocar `const sessionId` por `let sessionId` e adicionar a função de garantia logo antes do loop de cenários (linha ~118):

```ts
  console.log(`[3/6] login test-runner`);
  let sessionId = await loginTestRunner({
    baseUrl,
    nome: process.env.TEST_RUNNER_NOME ?? "test-runner",
    pin: process.env.TEST_RUNNER_PIN ?? "9999",
  });

  // Recuperação de saúde: se o servidor caiu, reinicia uma vez e re-loga, em
  // vez de deixar todo cenário subsequente falhar com "fetch failed".
  async function garantirServidor(): Promise<boolean> {
    if (await isHealthy(`${baseUrl}/api/auth/me`)) return true;
    console.warn(`  ⚠️ servidor não responde — reiniciando`);
    try {
      await server.kill();
      server = await startDevServer({ port: args.port, prod: args.prod });
      await waitForHealth(`${baseUrl}/api/auth/me`, { timeout_ms: 60_000 });
      sessionId = await loginTestRunner({
        baseUrl,
        nome: process.env.TEST_RUNNER_NOME ?? "test-runner",
        pin: process.env.TEST_RUNNER_PIN ?? "9999",
      });
      console.warn(`  ✅ servidor reiniciado`);
      return true;
    } catch (e) {
      console.error(`  ❌ falha ao reiniciar servidor: ${(e as Error).message}`);
      return false;
    }
  }
```

- [ ] **Step 2: Chamar `garantirServidor` antes de cada cenário**

Modify o loop de execução (linhas ~122-135). Antes do `const r = await rodarCenario(...)`, inserir a checagem:

```ts
  for (const f of files) {
    const mod = await import(pathToFileURL(join(catalogoDir, f)).href);
    const cenario: Cenario = mod.default;
    if (!cenario) { console.warn(`  ⚠️ ${f}: sem default export, pulando`); continue; }
    if (cenario.skip || !filterMatches(cenario, args)) {
      results.push({ nome: cenario.nome, status: "skip" });
      console.log(`  ⏭️  ${cenario.nome}`);
      continue;
    }
    if (!(await garantirServidor())) {
      results.push({ nome: cenario.nome, status: "fail", classe: "infra-fail", motivo: "infra", duracao_ms: 0, erro: { mensagem: "servidor não recuperável" } });
      console.log(`  ❌ ${cenario.nome} — infra (servidor caiu)`);
      continue;
    }
    console.log(`  ▶️  ${cenario.nome}`);
    const r = await rodarCenario({ sb, cenario, baseUrl, sessionId, staging });
    results.push(r);
    console.log(`     ${r.status === "pass" ? "✅" : "❌"} ${r.duracao_ms}ms${r.status === "fail" ? ` — ${r.motivo}` : ""}`);
  }
```

- [ ] **Step 3: Smoke (2 cenários, modo prod)**

Run: `npm run scenarios:ci -- --filter p3`
Expected: roda os cenários com tag `p3`; nenhum cascata de fetch-failed; se o servidor cair, log de reinício aparece.

- [ ] **Step 4: Commit**

```bash
git add scripts/wms/cenarios/run-all.ts
git commit -m "test(harness): recuperação de saúde do servidor entre cenários (anti-cascata)"
```

---

### Task 1.5: Fechar vazamento de estado — truncar `siso_transferencias_galpao`

A tabela ativa de transferências inter-galpão nunca é truncada (vaza entre runs).

**Files:**
- Create: `supabase/migrations/20260601_truncate_add_transferencias_galpao.sql`

- [ ] **Step 1: Criar a migration (CREATE OR REPLACE do truncate)**

Create `supabase/migrations/20260601_truncate_add_transferencias_galpao.sql`:

```sql
-- Harness de testes: incluir siso_transferencias_galpao no TRUNCATE.
-- A tabela ativa de transferência inter-galpão nunca era truncada (vazava
-- entre runs da suíte). CASCADE cobre as tabelas-filhas via FK.
CREATE OR REPLACE FUNCTION public.wms_truncate_operacional()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  TRUNCATE
    siso_movimentacoes,
    siso_estoque,
    siso_custo_medio,
    siso_pedidos,
    siso_fila_execucao,
    siso_wms_pendencias_guarda,
    siso_inventario_sessoes,
    siso_transferencias_galpao,
    siso_ordens_compra,
    siso_devolucoes_pendentes,
    siso_webhook_logs,
    siso_api_calls,
    siso_logs,
    siso_erros,
    siso_localizacao_locks
  CASCADE;
END;
$function$;
```

- [ ] **Step 2: Aplicar a migration em staging**

Usar a ferramenta `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `20260601_truncate_add_transferencias_galpao`, com o SQL acima.
Expected: sucesso. (Se a tabela `siso_transferencias_galpao` não existir, o `CREATE OR REPLACE` falha — confirmar o nome via `mcp__supabase__list_tables` antes.)

- [ ] **Step 3: Verificar o truncate**

Run (via `mcp__supabase__execute_sql` no mesmo project): `SELECT wms_truncate_operacional();`
Expected: executa sem erro.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260601_truncate_add_transferencias_galpao.sql
git commit -m "test(harness): truncar siso_transferencias_galpao (fecha vazamento de estado)"
```

---

## Fase 2 — Fortalecer invariantes

### Task 2.1: RPC `wms_detectar_divergencias_reservado()`

Fecha o ponto-cego: a reconciliação atual checa só `saldo`. Esta espelha pra `reservado` (`Σ(R) − Σ(L)`, com `GREATEST(0,…)` igual ao rebuild).

**Files:**
- Create: `supabase/migrations/20260601b_rpc_divergencias_reservado.sql`

- [ ] **Step 1: Criar a migration**

Create `supabase/migrations/20260601b_rpc_divergencias_reservado.sql`:

```sql
-- Reconciliação de RESERVADO (complementa wms_detectar_divergencias_estoque,
-- que só checa saldo). Cache.reservado deve bater com GREATEST(0, Σ(R) − Σ(L))
-- do ledger — mesma fórmula usada por wms_rebuild_linha_estoque.
DROP FUNCTION IF EXISTS wms_detectar_divergencias_reservado() CASCADE;

CREATE OR REPLACE FUNCTION wms_detectar_divergencias_reservado()
RETURNS TABLE (
  estoque_id        uuid,
  produto_id        uuid,
  galpao_id         uuid,
  localizacao_id    uuid,
  reservado_cache   numeric,
  reservado_ledger  numeric,
  delta             numeric
)
LANGUAGE sql AS $$
  SELECT e.id, e.produto_id, e.galpao_id, e.localizacao_id,
         e.reservado,
         GREATEST(0, COALESCE(
           SUM(CASE m.tipo WHEN 'R' THEN m.quantidade WHEN 'L' THEN -m.quantidade ELSE 0 END),
           0
         )) AS reservado_ledger,
         e.reservado - GREATEST(0, COALESCE(
           SUM(CASE m.tipo WHEN 'R' THEN m.quantidade WHEN 'L' THEN -m.quantidade ELSE 0 END),
           0
         )) AS delta
    FROM siso_estoque e
    LEFT JOIN siso_movimentacoes m
      ON m.produto_id=e.produto_id
     AND m.galpao_id=e.galpao_id
     AND m.localizacao_id=e.localizacao_id
   GROUP BY e.id, e.produto_id, e.galpao_id, e.localizacao_id, e.reservado
  HAVING e.reservado <> GREATEST(0, COALESCE(
    SUM(CASE m.tipo WHEN 'R' THEN m.quantidade WHEN 'L' THEN -m.quantidade ELSE 0 END),
    0
  ));
$$;
```

- [ ] **Step 2: Aplicar em staging**

`mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`, name `20260601b_rpc_divergencias_reservado`.
Expected: sucesso.

- [ ] **Step 3: Smoke da RPC**

Run (via `mcp__supabase__execute_sql`): `SELECT * FROM wms_detectar_divergencias_reservado();`
Expected: roda (provavelmente 0 linhas se o cache está saudável).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260601b_rpc_divergencias_reservado.sql
git commit -m "feat(ledger): RPC wms_detectar_divergencias_reservado (reconciliação de reservado)"
```

---

### Task 2.2: Teste de integração da RPC de reservado

**Files:**
- Create: `test/integration/reconciliacao-reservado-rpc.test.ts`

- [ ] **Step 1: Escrever o teste (que falha se a RPC estiver errada)**

Create `test/integration/reconciliacao-reservado-rpc.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("wms_detectar_divergencias_reservado", () => {
  it("flagra cache.reservado divergente e ignora quando bate com o ledger", async () => {
    const sku = `TEST-RESV-${Date.now()}`;
    const { data: prod } = await sb.from("siso_produtos").insert({ sku, descricao: "test reservado", ativo: true }).select("id").single();
    const { data: galpao } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao!.id).eq("codigo", "A-01-01").single();

    try {
      // Cache divergente: saldo 10, reservado 5, SEM movs no ledger (ledger → 0).
      await sb.from("siso_estoque").insert({ produto_id: prod!.id, galpao_id: galpao!.id, localizacao_id: loc!.id, saldo: 10, reservado: 5 });

      const { data: divs, error } = await sb.rpc("wms_detectar_divergencias_reservado");
      expect(error).toBeNull();
      const minha = (divs as Array<{ produto_id: string; delta: number }>).find((d) => d.produto_id === prod!.id);
      expect(minha).toBeTruthy();
      expect(Number(minha!.delta)).toBe(5);

      // Corrige cache → reservado 0; não deve mais flagrar.
      await sb.from("siso_estoque").update({ reservado: 0 }).eq("produto_id", prod!.id);
      const { data: divs2 } = await sb.rpc("wms_detectar_divergencias_reservado");
      expect((divs2 as Array<{ produto_id: string }>).find((d) => d.produto_id === prod!.id)).toBeFalsy();
    } finally {
      await sb.from("siso_estoque").delete().eq("produto_id", prod!.id);
      await sb.from("siso_produtos").delete().eq("id", prod!.id);
    }
  });
});
```

- [ ] **Step 2: Rodar**

Run: `npm run test:integration -- reconciliacao-reservado-rpc`
Expected: PASS. (Exige `.env.test.local` com chaves de staging.)

- [ ] **Step 3: Commit**

```bash
git add test/integration/reconciliacao-reservado-rpc.test.ts
git commit -m "test(integration): cobre wms_detectar_divergencias_reservado"
```

---

### Task 2.3: Invariante I8 + ajustes em I2/I3

**Files:**
- Modify: `scripts/wms/cenarios/_harness/invariantes.ts`

- [ ] **Step 1: Adicionar I8 e registrá-lo**

Modify `scripts/wms/cenarios/_harness/invariantes.ts`. Adicionar a função I8 logo após `i1LedgerVsCache` (linha ~24):

```ts
// I8 — Reservado ↔ ledger coerente (fecha o ponto-cego do I1, que só checa saldo)
async function i8ReservadoVsLedger(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const { data, error } = await sb.rpc("wms_detectar_divergencias_reservado");
  if (error) {
    return { nome: "I8: reservado↔ledger", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  }
  const linhas = (data as unknown[]) ?? [];
  return {
    nome: "I8: reservado↔ledger",
    ok: linhas.length === 0,
    detalhes: linhas.length > 0 ? { divergencias: linhas } : undefined,
    duracao_ms: Date.now() - t0,
  };
}
```

E registrá-lo no `rodarInvariantes` (linhas ~179-189) — adicionar logo depois do I1:

```ts
export async function rodarInvariantes(sb: SupabaseClient): Promise<InvariantResult[]> {
  return [
    await i1LedgerVsCache(sb),
    await i8ReservadoVsLedger(sb),
    await i2DisponivelGenerated(sb),
    await i3CustoMedio(sb),
    await i4ReservasOrfas(sb),
    await i5PendenciasGuarda(sb),
    await i6ParesSE(sb),
    await i7FilaVazia(sb),
  ];
}
```

- [ ] **Step 2: Alargar I2 (incluir linhas `saldo=0`)**

Modify a função `i2DisponivelGenerated` — remover o filtro `.gt("saldo", 0)` (linha ~32):

```ts
  const { data, error } = await sb
    .from("siso_estoque")
    .select("id, saldo, reservado, disponivel");
```

- [ ] **Step 3: Alinhar I3 ao whitelist de 5 origens que a RPC recalcula**

Modify a query de movs do `i3CustoMedio` (linhas ~51-56) — filtrar `origem_tipo` no whitelist:

```ts
    const { data: movs } = await sb
      .from("siso_movimentacoes")
      .select("quantidade, custo_unitario")
      .eq("produto_id", p.id)
      .eq("tipo", "E")
      .not("custo_unitario", "is", null)
      .in("origem_tipo", ["nf_compra", "devolucao_cliente_integra", "lancamento_retroativo", "ajuste_manual", "inventario_inicial"])
      .order("criado_em", { ascending: true });
```

- [ ] **Step 4: Smoke — rodar um cenário e confirmar que I8 aparece verde**

Run: `npm run scenarios:ci -- --only "49b"`
Expected: PASS; no relatório `<ts>-detail.json` o cenário lista 8 invariantes incluindo `I8: reservado↔ledger` com `ok: true`.

- [ ] **Step 5: Commit**

```bash
git add scripts/wms/cenarios/_harness/invariantes.ts
git commit -m "test(invariantes): I8 paridade de reservado + alarga I2 + alinha I3 ao whitelist de custo"
```

---

## Fase 3 — Run limpa + triagem dos bugs reais

> **REQUIRED SUB-SKILL:** Use superpowers:systematic-debugging pra cada falha real. NÃO chutar correções.

### Task 3.1: Rodar a suíte completa estabilizada e classificar

**Files:** nenhum (execução)

- [ ] **Step 1: Run completa em modo prod**

Run: `npm run scenarios:ci`
Expected: ~20-30 min (modo prod é bem mais rápido que dev). Gera relatório com contagem `product-fail` / `infra-fail`.

- [ ] **Step 2: Confirmar que `infra-fail` ≈ 0**

Abrir o `<ts>-summary.md` mais recente. Se ainda houver `infra-fail` em volume, o servidor ainda está instável — voltar pra Task 1.3/1.4 e investigar o log `[srv:err]` (provável erro de build/start, não de cenário). **Critério de avanço:** `infra-fail == 0` (ou só falhas pontuais explicáveis).

- [ ] **Step 3: Listar os `product-fail` reais**

Extrair do `<ts>-detail.json` os cenários `classe == "product-fail"` com seu `motivo`, `erro.mensagem` e invariante violado. Esta é a lista de triagem.

- [ ] **Step 4: Commit do relatório de partida limpo**

```bash
cp scripts/wms/cenarios/reports/$(ls -t scripts/wms/cenarios/reports/ | grep summary | head -1) \
   docs/superpowers/suite-pos-estabilizacao-2026-06-01.md
git add docs/superpowers/suite-pos-estabilizacao-2026-06-01.md
git commit -m "test(estoque): relatório da suíte após estabilização (lista de triagem)"
```

### Task 3.2: Triar cada `product-fail` (loop)

**Files:** variável (correções de produto OU marcação de cenário)

Para CADA cenário em `product-fail` da Task 3.1:

- [ ] **Step 1: Reproduzir isolado**

Run: `npm run scenarios:only -- "<número do cenário>"` (modo dev pra iterar rápido; ex.: `npm run scenarios:only -- "24"`).
Expected: reproduz a falha de forma determinística.

- [ ] **Step 2: Diagnosticar via systematic-debugging**

Ler o `erro.mensagem`, os `logs`/`erros` por `correlation_id` no detail.json, e a rota/lib envolvida. Decidir a categoria:
- **(a) Bug real de produto** (ledger/cache divergem, invariante quebra): root-cause → corrigir o código de produto. Registrar em `erros-conhecidos.yaml` (formato do arquivo) e, se mexeu em rota/schema, atualizar `docs/api-reference-complete.md` / `docs/database-schema.md` no mesmo commit.
- **(b) Quirk de design aceito** (ex.: `ajuste_pick_zerou` nunca estornado — realidade física): NÃO é bug. Ajustar o assert do cenário pra refletir o comportamento correto, com comentário explicando.
- **(c) Cenário desatualizado** (contrato da rota mudou): atualizar o cenário pro contrato atual.

- [ ] **Step 3: Confirmar verde**

Run: `npm run scenarios:only -- "<número>"`
Expected: PASS + 8 invariantes OK.

- [ ] **Step 4: Commit (um por bug)**

```bash
git add <arquivos>
git commit -m "fix(estoque): <descrição do bug> (cenário NN)"   # ou test(estoque): ajusta assert do cenário NN
```

- [ ] **Step 5: Repetir até a lista zerar.** Ao fim, rodar `npm run scenarios:ci` inteira e confirmar `product-fail == 0` (baseline verde). Commitar o relatório verde como `docs/superpowers/suite-verde-2026-06-01.md`.

> Se algum bug for grande demais pra esta entrega, marcá-lo com `skip: true` no cenário + comentário com motivo e link, e listar no relatório final como dívida conhecida — NÃO deixar a suíte vermelha por um bug não-endereçável agora.

---

## Fase 4 — Cenários novos de maior risco

> Padrão: copiar a estrutura de `scripts/wms/cenarios/catalogo/49b-estornar-ajuste.ts` (default export `satisfies Cenario<…>` + bloco `runStandalone` no fim). Para endpoints sem helper no `Ctx`, usar `ctx.http.post(...)` direto. **Step 1 de cada task é SEMPRE ler a rota + `docs/api-reference-complete.md` pra confirmar o contrato exato** antes de escrever.

### Task 4.1: Cenário 71 — estorno admin de pedido inteiro (Banner D10)

**Files:**
- Read: `src/app/api/wms/pedidos/[id]/estornar/route.ts` + `docs/api-reference-complete.md`
- Create: `scripts/wms/cenarios/catalogo/71-estornar-pedido-d10.ts`

- [ ] **Step 1: Confirmar o contrato**

Ler a rota `estornar` e anotar: método (POST), body esperado (ex.: `{ motivo?: string }`), permissão (`pedidos.estornar` — o `test-runner` é admin, OK), e em que estado de pedido ele opera (provavelmente pós-reserva/pós-baixa).

- [ ] **Step 2: Escrever o cenário**

Create `scripts/wms/cenarios/catalogo/71-estornar-pedido-d10.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Risco #1 de estoque-fantasma — `POST /api/wms/pedidos/[id]/estornar`
 * (Banner D10, reversão admin do pedido inteiro). Sem cobertura até aqui.
 *
 * Cria pedido próprio com saldo (gera reserva R), captura saldo/reservado
 * originais, estorna o pedido e exige que o ledger volte 1:1: saldo restaurado,
 * reservado de volta a 0, sem reserva órfã. I1/I8 verdes cobrem divergência.
 */
export default {
  nome: "71 — Estornar pedido inteiro (Banner D10) reverte ledger 1:1",
  descricao:
    "Pedido próprio reserva R; estornar admin libera tudo: saldo restaurado, reservado=0, sem órfã.",
  tags: ["reverse", "pedido", "estorno", "d10", "risco-alto"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("71");
    await ctx.criarProduto({ sku, descricao: "71 estorno D10" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 10, custo: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Pedido próprio NetAir (CWB) por 4 — webhook cria reserva R.
    const pedido = await ctx.webhook({ empresa: "netair", items: [{ sku, qty: 4 }] });
    await ctx.aguardarStatus(pedido.id, "concluido", { decisao: "propria" });
    // Sanity: 4 reservados, 10 saldo.
    await ctx.assertReservado(sku, "CWB", "A-01-01", 4);
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);

    // Estorno admin (D10). Body conforme contrato confirmado no Step 1.
    await ctx.http.post(`/api/wms/pedidos/${pedido.id}/estornar`, { motivo: "cenário 71 — estorno D10" });
    ctx.log("pedido-estornado", { pedido: pedido.id });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Reservado de volta a 0, saldo intacto.
    await ctx.assertReservado(sku, "CWB", "A-01-01", 0);
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);
    // Sem reserva órfã (reforça I4/I8).
    await ctx.assertSemReservasOrfas();
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; }
})();
if (_isMain) {
  void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })();
}
```

> Se o Step 1 revelar que `estornar` só opera em pedido já baixado (R→L+S), estender o `run` com `iniciarSeparacao`/`bipar`/`concluir` antes do estorno e ajustar os asserts (saldo cai na baixa, volta no estorno). Usar os helpers do `Ctx`.

- [ ] **Step 3: Rodar isolado**

Run: `npm run scenarios:only -- "71"`
Expected: PASS + 8 invariantes OK.

- [ ] **Step 4: Commit**

```bash
git add scripts/wms/cenarios/catalogo/71-estornar-pedido-d10.ts
git commit -m "test(estoque): cenário 71 — estorno admin de pedido inteiro (D10)"
```

### Task 4.2: Cenário 72 — override admin libera reservas (D2)

**Files:**
- Read: `src/app/api/wms/pedidos/[id]/liberar-reservas/route.ts`
- Create: `scripts/wms/cenarios/catalogo/72-liberar-reservas-d2.ts`

- [ ] **Step 1: Confirmar contrato** (método/body/permissão `pedidos.liberar_reservas`).

- [ ] **Step 2: Escrever o cenário**

Create `scripts/wms/cenarios/catalogo/72-liberar-reservas-d2.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * `POST /api/wms/pedidos/[id]/liberar-reservas` (override D2 admin). Sem cobertura.
 * Pedido reserva R; override libera tudo via L; reservado→0, saldo intacto, sem órfã.
 */
export default {
  nome: "72 — Liberar reservas (override D2) zera reservado sem órfã",
  descricao: "Pedido reserva 3; liberar-reservas admin emite L; reservado=0, saldo intacto, I4/I8 ok.",
  tags: ["reverse", "pedido", "reserva", "d2", "risco-alto"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("72");
    await ctx.criarProduto({ sku, descricao: "72 liberar reservas D2" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 8, custo: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({ empresa: "netair", items: [{ sku, qty: 3 }] });
    await ctx.aguardarStatus(pedido.id, "concluido", { decisao: "propria" });
    await ctx.assertReservado(sku, "CWB", "A-01-01", 3);

    await ctx.http.post(`/api/wms/pedidos/${pedido.id}/liberar-reservas`, { motivo: "cenário 72 — override D2" });
    ctx.log("reservas-liberadas", { pedido: pedido.id });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertReservado(sku, "CWB", "A-01-01", 0);
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 8);
    await ctx.assertSemReservasOrfas();
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

- [ ] **Step 3: Rodar** — `npm run scenarios:only -- "72"` → PASS + invariantes OK.
- [ ] **Step 4: Commit** — `git add … && git commit -m "test(estoque): cenário 72 — liberar reservas override D2"`

### Task 4.3: Cenário 73 — conversão NF R→L+S isolada

**Files:**
- Read: `src/lib/execution-worker-wms.ts` + `docs/architecture-and-flows.md` (seção pós-NF)
- Create: `scripts/wms/cenarios/catalogo/73-conversao-nf-rls.ts`

- [ ] **Step 1: Confirmar o gatilho da conversão** — em que transição de `status_separacao` + emissão de NF a reserva R vira `L`(liberação) + `S`(saída `nf_venda`). Anotar quais helpers do `Ctx` levam o pedido até lá (`iniciarSeparacao` → `bipar` → `concluir` → `embalar` → `expedir`).

- [ ] **Step 2: Escrever o cenário** (asserta especificamente a conversão, não só o estado final):

Create `scripts/wms/cenarios/catalogo/73-conversao-nf-rls.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Coração do WMS-as-source: conversão da reserva R em L+S quando o pedido é
 * concluído/expedido (NF emitida). Hoje só coberto de forma indireta. Asserta
 * que após o ciclo: reservado→0 (R liberado via L), saldo cai pela qty (S
 * nf_venda), e o par L/S existe no ledger pro SKU. I1/I8 garantem coerência.
 */
export default {
  nome: "73 — Conversão NF R→L+S no ciclo completo do pedido",
  descricao: "Pedido próprio reserva 4; após expedir, reservado=0 e saldo=6 (10-4); ledger tem L + S nf_venda.",
  tags: ["pedido", "separacao", "nf", "conversao", "risco-alto", "wms-as-source"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("73");
    await ctx.criarProduto({ sku, descricao: "73 conversao NF" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 10, custo: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({ empresa: "netair", items: [{ sku, qty: 4 }] });
    await ctx.aguardarStatus(pedido.id, "concluido", { decisao: "propria" });
    await ctx.assertReservado(sku, "CWB", "A-01-01", 4);

    // Ciclo de separação até expedição (dispara a conversão R→L+S).
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 4, loc: "A-01-01" });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.embalar(pedido.id);
    await ctx.expedir(pedido.id);
    ctx.log("pedido-expedido", { pedido: pedido.id });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Reserva convertida: reservado=0, saldo caiu pela qty.
    await ctx.assertReservado(sku, "CWB", "A-01-01", 0);
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 6);
    await ctx.assertSemReservasOrfas();

    // Ledger tem a saída nf_venda e a liberação L.
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("tipo, origem_tipo")
      .eq("produto_id", prod!.id);
    const temS = (movs ?? []).some((m) => m.tipo === "S" && m.origem_tipo === "nf_venda");
    const temL = (movs ?? []).some((m) => m.tipo === "L" && m.origem_tipo === "liberacao_reserva");
    if (!temS) throw new Error("esperava mov S nf_venda (conversão da reserva)");
    if (!temL) throw new Error("esperava mov L liberacao_reserva (conversão da reserva)");
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

> O fluxo exato (passos/aguardas entre `concluir`/`embalar`/`expedir`) pode precisar de `aguardarStatusSeparacao`/`aguardarFilaVazia` — espelhar o que o cenário 01 (`01-pedido-auto-propria.ts`) já faz; ler esse arquivo no Step 1 e copiar o ritmo.

- [ ] **Step 3: Rodar** — `npm run scenarios:only -- "73"` → PASS + invariantes OK.
- [ ] **Step 4: Commit** — `test(estoque): cenário 73 — conversão NF R→L+S isolada`

### Task 4.4: Cenário 74 — mudança de loc com `reservado>0`

**Files:**
- Read: `src/app/api/wms/separacao/localizacao/route.ts`
- Create: `scripts/wms/cenarios/catalogo/74-loc-move-com-reserva.ts`

- [ ] **Step 1: Confirmar contrato** de `POST /api/wms/separacao/localizacao` (campos: pedido, item/sku, loc nova) e o comportamento Fix-A: libera R origem + move S+E + reemite R destino.

- [ ] **Step 2: Escrever o cenário**

Create `scripts/wms/cenarios/catalogo/74-loc-move-com-reserva.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * `POST /api/wms/separacao/localizacao` com reservado>0 (Fix-A): libera R na
 * origem + move S+E + reemite R no destino. Sem cenário dedicado. Asserta que
 * a reserva acompanha o produto pra loc nova, sem R órfã e com par S+E
 * balanceado (I6) + reservado coerente (I8).
 */
export default {
  nome: "74 — Mudar loc do item em separação com reserva move R junto",
  descricao: "Pedido reserva 3 em A-01-01; move pra A-01-02: reservado vai pra loc nova, origem zera, I6/I8 ok.",
  tags: ["separacao", "localizacao", "reserva", "risco-alto"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("74");
    await ctx.criarProduto({ sku, descricao: "74 loc move c/ reserva" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5, custo: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({ empresa: "netair", items: [{ sku, qty: 3 }] });
    await ctx.aguardarStatus(pedido.id, "concluido", { decisao: "propria" });
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 3);

    // Move o item pra A-01-02 (body conforme contrato confirmado no Step 1).
    await ctx.http.post(`/api/wms/separacao/localizacao`, {
      pedido_id: pedido.id,
      sku,
      galpao: "CWB",
      loc_nova: "A-01-02",
    });
    ctx.log("loc-movida", { pedido: pedido.id });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo + reserva migraram pra A-01-02; A-01-01 zerou.
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 2);   // 5 - 3 movidos
    await ctx.assertReservado(sku, "CWB", "A-01-01", 0);
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 3);
    await ctx.assertReservado(sku, "CWB", "A-01-02", 3);
    await ctx.assertSemReservasOrfas();
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

> Os números exatos (quanto move) dependem do contrato (move só a qty reservada ou o saldo todo?). Ajustar os asserts no Step 1 conforme a rota; manter a invariante central: reservado total conservado, sem órfã.

- [ ] **Step 3: Rodar** — `npm run scenarios:only -- "74"` → PASS + invariantes OK.
- [ ] **Step 4: Commit** — `test(estoque): cenário 74 — mudança de loc com reserva`

### Task 4.5: Cenário 75 — cancelar pendência de guarda (com motivo)

**Files:**
- Read: `src/app/api/wms/guarda/[id]/cancelar/route.ts`
- Create: `scripts/wms/cenarios/catalogo/75-guarda-cancelar-motivo.ts`

- [ ] **Step 1: Confirmar contrato + comportamento** — cancelar pendência NÃO escreve no ledger (saldo fica em RECEBIMENTO — o caso "saldo órfão" by-design). Anotar.

- [ ] **Step 2: Escrever o cenário** (asserta o comportamento by-design: saldo permanece em RECEBIMENTO, pendência vira `cancelada`, I1/I8 verdes — não há divergência):

Create `scripts/wms/cenarios/catalogo/75-guarda-cancelar-motivo.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * `POST /api/wms/guarda/[id]/cancelar` com motivo. Cancelar a pendência NÃO
 * estorna a entrada — o saldo fica parado em RECEBIMENTO (caso "saldo órfão"
 * by-design). Asserta exatamente isso: saldo em RECEBIMENTO intacto, pendência
 * cancelada, ledger coerente (sem divergência → I1/I8 verdes).
 */
export default {
  nome: "75 — Cancelar pendência de guarda mantém saldo em RECEBIMENTO",
  descricao: "Recebe 6 (entra em RECEBIMENTO + pendência); cancela pendência: saldo segue em RECEBIMENTO, pendência cancelada.",
  tags: ["guarda", "recebimento", "cancelar"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("75");
    await ctx.criarProduto({ sku, descricao: "75 cancelar guarda" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Recebe 6 no dock CWB → saldo entra em RECEBIMENTO + cria pendência.
    const rec = await ctx.receber({ items: [{ sku, qty: 6 }], galpao: "CWB" });
    const pendencia = rec.pendencias[0];
    if (!pendencia) throw new Error("recebimento não criou pendência");
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 6);

    // Cancela a pendência (body conforme contrato — provável { motivo }).
    await ctx.http.post(`/api/wms/guarda/${pendencia}/cancelar`, { motivo: "cenário 75 — caixa avariada, não guardar" });
    ctx.log("pendencia-cancelada", { pendencia });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo permanece em RECEBIMENTO (cancelar NÃO estorna a entrada).
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 6);
    // Pendência marcada como cancelada.
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: pend } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select("status")
      .eq("produto_id", prod!.id);
    const todasCanceladas = (pend ?? []).every((p) => p.status === "cancelada");
    if (!pend || pend.length === 0 || !todasCanceladas) {
      throw new Error(`esperava pendência(s) cancelada(s), achou ${JSON.stringify(pend)}`);
    }
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

- [ ] **Step 3: Rodar** — `npm run scenarios:only -- "75"` → PASS + invariantes OK.
- [ ] **Step 4: Commit** — `test(estoque): cenário 75 — cancelar pendência de guarda`

- [ ] **Step 5: Run completa com os 5 novos** — `npm run scenarios:ci` → confirmar `product-fail == 0` com 87 cenários.

---

## Fase 5 — Automação + alerta

### Task 5.1: Script de alerta Slack/Discord

**Files:**
- Create: `scripts/wms/cenarios/notify-slack.ts`
- Create: `scripts/wms/cenarios/notify-slack.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Escrever o teste (que falha) do `montarMensagem`**

Create `scripts/wms/cenarios/notify-slack.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { montarMensagem, type DetailReport } from "./notify-slack";

const base = (cenarios: DetailReport["cenarios"]): DetailReport => ({
  iniciado_em: "2026-06-01T06:00:00.000Z",
  duracao_ms: 1000,
  totais: { pass: 0, fail: 0, skip: 0, product_fail: 0, infra_fail: 0 },
  cenarios,
});

describe("montarMensagem", () => {
  it("sem problema quando tudo passa", () => {
    const { problema } = montarMensagem(base([{ nome: "01", status: "pass", classe: "pass" }]));
    expect(problema).toBe(false);
  });

  it("marca problema e lista fluxo quebrado com invariante", () => {
    const { problema, texto } = montarMensagem(base([
      { nome: "73 — Conversão NF", status: "fail", classe: "product-fail", invariantes: [{ nome: "I1: ledger↔cache", ok: false }, { nome: "I8: reservado↔ledger", ok: true }] },
    ]));
    expect(problema).toBe(true);
    expect(texto).toContain("73 — Conversão NF");
    expect(texto).toContain("I1: ledger↔cache");
  });

  it("infra-fail marca problema mas como inconclusivo", () => {
    const { problema, texto } = montarMensagem(base([
      { nome: "09 — Entrada direta", status: "fail", classe: "infra-fail" },
    ]));
    expect(problema).toBe(true);
    expect(texto).toContain("infra");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run scripts/wms/cenarios/notify-slack.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar o script**

Create `scripts/wms/cenarios/notify-slack.ts`:

```ts
import "dotenv/config";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

const REPORTS_DIR = "scripts/wms/cenarios/reports";

export interface DetailReport {
  iniciado_em: string;
  duracao_ms: number;
  totais: { pass: number; fail: number; skip: number; product_fail?: number; infra_fail?: number };
  cenarios: Array<{
    nome: string;
    status: string;
    classe?: string;
    motivo?: string;
    invariantes?: Array<{ nome: string; ok: boolean }>;
  }>;
}

async function ultimoRelatorio(): Promise<DetailReport | null> {
  let arquivos: string[];
  try {
    arquivos = (await readdir(REPORTS_DIR)).filter((f) => f.endsWith("-detail.json")).sort();
  } catch {
    return null;
  }
  if (arquivos.length === 0) return null;
  const ultimo = arquivos[arquivos.length - 1];
  return JSON.parse(await readFile(join(REPORTS_DIR, ultimo), "utf-8")) as DetailReport;
}

export function montarMensagem(rep: DetailReport): { texto: string; problema: boolean } {
  const productFail = rep.cenarios.filter((c) => c.classe === "product-fail");
  const infraFail = rep.cenarios.filter((c) => c.classe === "infra-fail");
  const pass = rep.cenarios.filter((c) => c.status === "pass").length;
  const problema = productFail.length > 0 || infraFail.length > 0;

  const icone = productFail.length > 0 ? "🔴" : infraFail.length > 0 ? "🟡" : "🟢";
  const linhas: string[] = [];
  linhas.push(`${icone} *Bateria de estoque* — ${rep.iniciado_em}`);
  linhas.push(`✅ ${pass} pass · 🔴 ${productFail.length} bug · 🟡 ${infraFail.length} infra`);

  if (productFail.length > 0) {
    linhas.push("");
    linhas.push("*Fluxos quebrados (bug de estoque):*");
    for (const c of productFail.slice(0, 20)) {
      const invs = (c.invariantes ?? []).filter((i) => !i.ok).map((i) => i.nome);
      const motivo = invs.length > 0 ? `invariante ${invs.join(", ")}` : (c.motivo ?? "assert/erro");
      linhas.push(`• ${c.nome} — ${motivo}`);
    }
  }
  if (infraFail.length > 0) {
    linhas.push("");
    linhas.push(`*Inconclusivos (infra instável):* ${infraFail.slice(0, 10).map((c) => c.nome).join(", ")}`);
  }
  return { texto: linhas.join("\n"), problema };
}

async function main() {
  const always = process.argv.includes("--always");
  const webhook = process.env.STOCK_SUITE_WEBHOOK_URL;
  if (!webhook) {
    console.error("STOCK_SUITE_WEBHOOK_URL ausente — pulando alerta");
    process.exit(0);
  }
  const rep = await ultimoRelatorio();
  if (!rep) {
    console.error("Nenhum relatório encontrado");
    process.exit(0);
  }
  const { texto, problema } = montarMensagem(rep);
  if (!problema && !always) {
    console.log("Suite verde — sem alerta (use --always pra heartbeat).");
    process.exit(0);
  }
  // Slack usa `text`; Discord usa `content`. Mandar os dois cobre ambos.
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: texto, content: texto }),
  });
  if (!res.ok) {
    console.error(`Webhook falhou: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log("Alerta enviado.");
}

// Só roda main() quando invocado direto (não em import de teste).
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; }
})();
if (_isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run scripts/wms/cenarios/notify-slack.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Script npm**

Modify `package.json` — adicionar no bloco `scripts`:

```json
    "notify:stock": "tsx scripts/wms/cenarios/notify-slack.ts",
```

- [ ] **Step 6: Commit**

```bash
git add scripts/wms/cenarios/notify-slack.ts scripts/wms/cenarios/notify-slack.test.ts package.json
git commit -m "feat(testes): alerta Slack/Discord do resultado da bateria"
```

### Task 5.2: Workflow agendado do GitHub Actions

**Files:**
- Create: `.github/workflows/wms-stock-suite.yml`

- [ ] **Step 1: Criar o workflow**

Create `.github/workflows/wms-stock-suite.yml`:

```yaml
name: WMS Stock Ledger Suite

on:
  schedule:
    - cron: "0 6 * * *"   # 06:00 UTC = 03:00 BRT (horário ocioso)
  workflow_dispatch: {}

concurrency:
  group: wms-stock-suite
  cancel-in-progress: false

jobs:
  scenarios:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.STAGING_SUPABASE_URL }}
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.STAGING_SUPABASE_ANON_KEY }}
      SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.STAGING_SUPABASE_SERVICE_ROLE_KEY }}
      WORKER_SECRET: ${{ secrets.STAGING_WORKER_SECRET }}
      STOCK_SUITE_WEBHOOK_URL: ${{ secrets.STOCK_SUITE_WEBHOOK_URL }}
      TINY_DISABLED: "true"
      PRINTNODE_DISABLED: "true"
      ML_DISABLED: "true"
      TEST_RUNNER_NOME: "test-runner"
      TEST_RUNNER_PIN: "9999"
      TEST_RUNNER_BASE_URL: "http://localhost:3001"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - name: Bateria de cenários de estoque (prod build)
        run: npm run scenarios:ci
      - name: Subir relatório
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: stock-suite-report
          path: scripts/wms/cenarios/reports/
          retention-days: 30
      - name: Alertar Slack/Discord
        if: always()
        run: npm run notify:stock
```

> O `if: always()` no alerta garante que ele rode mesmo quando a bateria sai non-zero (product-fail). O job fica vermelho pelo exit code da bateria; o alerta empurra o detalhe pro canal.

- [ ] **Step 2: Validar a sintaxe do YAML**

Run: `npx --yes js-yaml .github/workflows/wms-stock-suite.yml >/dev/null && echo OK`
Expected: `OK` (sem erro de parse). Se `js-yaml` não estiver disponível, validar visualmente a indentação.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/wms-stock-suite.yml
git commit -m "ci(estoque): workflow noturno da bateria de estoque + alerta"
```

### Task 5.3: Runbook + lista de secrets

**Files:**
- Create: `docs/superpowers/runbook-bateria-estoque.md`

- [ ] **Step 1: Escrever o runbook**

Create `docs/superpowers/runbook-bateria-estoque.md`:

```markdown
# Runbook — Bateria Automática de Estoque

## O que é
Suíte de ~87 cenários ponta-a-ponta + 8 invariantes globais que valida todo
fluxo que toca o ledger. Roda toda noite (03:00 BRT) via GitHub Actions contra
staging e alerta no Slack/Discord quando algum fluxo de estoque quebra.

## GitHub Secrets necessários (Settings → Secrets and variables → Actions)
| Secret | Valor |
|---|---|
| `STAGING_SUPABASE_URL` | `https://ehbxpbeijofxtsbezwxd.supabase.co` |
| `STAGING_SUPABASE_ANON_KEY` | anon key do projeto staging |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | service role key do staging |
| `STAGING_WORKER_SECRET` | mesmo `WORKER_SECRET` do Vercel staging |
| `STOCK_SUITE_WEBHOOK_URL` | incoming webhook do Slack ou Discord |

## Rodar na mão
- GitHub → Actions → "WMS Stock Ledger Suite" → Run workflow.
- Local (modo prod, igual ao CI): `npm run scenarios:ci`
- Local (debug rápido, modo dev, 1 cenário): `npm run scenarios:only -- "73"`
- Forçar heartbeat verde no Slack: `npm run notify:stock -- --always`

## Ler o resultado
- Artifact `stock-suite-report` (md + json) no run do Actions.
- 🔴 product-fail = bug de estoque (job vermelho). 🟡 infra-fail = run
  inconclusiva (servidor instável) — não é bug de estoque.

## ⚠️ Cuidados
- A suíte TRUNCA tabelas operacionais de staging. Não rodar enquanto alguém usa
  staging manualmente. O cron é 03:00 BRT por isso.
- `validarStaging()` aborta se a URL não for o projeto staging — nunca toca prod.

## Rollback
- Pausar o cron: comentar o bloco `schedule:` no workflow (mantém o
  `workflow_dispatch` pra rodar na mão).
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbook-bateria-estoque.md
git commit -m "docs(testes): runbook da bateria de estoque + secrets"
```

### Task 5.4: Atualizar CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (seção "Sistemática de Testes de Estoque" em Current Status)

- [ ] **Step 1: Atualizar o status**

Modify `CLAUDE.md` — no bullet "Sistemática de Testes de Estoque", anexar uma nota:

```markdown
- **Bateria automática (Ledger Guard) — 2026-06-01.** Harness estabilizado (build
  de produção em vez de `next dev`, retry com backoff + `NetworkError`, recuperação
  de saúde do servidor entre cenários, taxonomia product-fail vs infra-fail).
  Novo invariante **I8** (paridade de reservado via RPC `wms_detectar_divergencias_reservado`),
  I2 alargado, I3 alinhado ao whitelist de custo. 5 cenários novos de alto risco
  (71 estorno D10, 72 liberar-reservas D2, 73 conversão NF R→L+S, 74 loc-move com
  reserva, 75 cancelar guarda). Roda nightly via GitHub Actions
  (`.github/workflows/wms-stock-suite.yml`, 03:00 BRT) contra staging com alerta
  Slack/Discord. Rodar: `npm run scenarios:ci`. Runbook:
  `docs/superpowers/runbook-bateria-estoque.md`. Plano:
  `docs/superpowers/plans/2026-06-01-bateria-testes-estoque.md`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: registra bateria automática de estoque no CLAUDE.md"
```

---

## Fechamento

- [ ] **Run final completa verde** — `npm run scenarios:ci` → `product-fail == 0`.
- [ ] **Configurar os 5 GitHub Secrets** (Eryk — ver runbook).
- [ ] **Disparo manual de validação** — Actions → Run workflow → confirmar que roda, sobe artifact e (forçando um fail temporário ou `--always`) posta no Slack.
- [ ] **Abrir PR** `test/stock-ledger-suite` → `develop` quando o baseline estiver verde.

---

## Self-review (cobertura do spec)

- Spec §A (estabilização) → Tasks 1.1–1.5 ✅
- Spec §B (triagem) → Tasks 3.1–3.2 ✅
- Spec §C (cenários novos + I8/I2/I3) → Tasks 2.1–2.3, 4.1–4.5 ✅
- Spec §D (automação + alerta) → Tasks 5.1–5.4 ✅
- Pré-requisitos (secrets, webhook, ciência do truncate) → Task 5.3 runbook + Fechamento ✅
```
