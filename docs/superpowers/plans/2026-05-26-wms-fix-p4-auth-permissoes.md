# WMS Fix · P4 · Auth + Permissões Granulares — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore principle PR-4 (backend validates permissions; UI gating is defense-in-depth, not the only line). Add `userCan`/`getSessionUser` checks to 13 endpoints; add 3 granular permissions to the registry; fix `webhook/reprocessar` to read body + require admin; add ownership check in `vendas/[id]`; formalize `siso_pedido_observacoes` table via migration.

**Architecture:** Surgical insertions at the top of each route handler (3-8 lines). Zero changes to handler body logic. New permissions follow existing pattern in `src/lib/permissions.ts`. Tests use `sisoFetch` against staging with seeded users of different cargos.

**Tech Stack:** TypeScript, Next.js route handlers, existing session/perm helpers, test harness at `scripts/wms/cenarios/`.

**Worktree:** `.claude/worktrees/wms-fix-p4/`. Branch: `wms-fix-p4`.

**Staging only.**

**Dependency note:** P4 should merge AFTER P2 to avoid conflict on handler tops (P2 edits handler bodies, P4 edits handler tops; both touch `vendas/criar`, `aprovar`, `compras/receber`, etc.). P4 is the LAST merge in the wave.

---

## Spec traceability

This plan implements §8 (P4 · Auth + Permissões Granulares) of `docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md`. Findings covered (cross-reference §15 in the appendix):

| Finding (§15) | Severity | Resolved by task(s) | Endpoint(s) |
|---|---|---|---|
| 1.3 — "Reprocessar" ignora pedidoId + sem auth | ALTO | Task 8 | `webhook/reprocessar` |
| 1.7 — 5 endpoints sem auth/perm | MÉD | Tasks 5, 6, 7, 9, 10 | aprovar, pedidos, historico, observacoes, reprocessar |
| 1.10 — `/api/wms/pedidos` não filtra por perm de galpão | MÉD | Task 6 | `pedidos` (GET) |
| 1.13 — `siso_pedido_observacoes` sem migration | BAIXO | Task 17 | migration only |
| 1.14 — Dashboard realtime sem filtro server-side galpão | BAIXO | Task 18 | hook |
| 4.16 — `inventario/metricas` lê sem `requireWarehouseAccess` | BAIXO | Task 11 | `inventario/metricas` |
| 6.2 — Devoluções aceitam qualquer perm warehouse | ALTO | Tasks 4, 14 | `devolucoes/[id]/classificar` + permission |
| 7.1 — `vendas/criar` sem `vendas.criar` server-side | ALTO | Task 12 | `vendas/criar` |
| 7.3 — Vendedor pode ver detalhe de outro vendedor | ALTO | Task 13 | `vendas/[id]` (GET) |
| 7.4 — Re-assign permite usuário sem cargo | MÉD | Task 16 | `vendas/[id]/vendedor` (PATCH) |
| 8.9 — `operacoes.retroativo` permissão não existe | MÉD | Tasks 4, 15a, 15b | `lancamento-retroativo` (POST + reconciliar POST) |
| (extra) — `vendas.editar_vendedor` candidate perm | — | Task 4 (decision logged) | `vendas/[id]/vendedor` |

Princípios não-negociáveis restabelecidos (§2 spec):
- **PR-4** — "Backend valida permissão; UI gateia mas não substitui check server-side" — restaurado em **todos** os 13 endpoints abaixo.

---

## Setup

### Task 1: Create worktree and switch context

**Files:** none (git operation only)

- [ ] **Step 1.1:** From repo root `/Users/eryk/Documents/ESTOQUE`, create the worktree:
  ```bash
  git worktree add /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4 -b wms-fix-p4 origin/develop
  ```
- [ ] **Step 1.2:** Verify worktree exists and is on branch `wms-fix-p4`:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4 && git status && git branch --show-current
  ```
  Expected output: `On branch wms-fix-p4` and `wms-fix-p4`.
- [ ] **Step 1.3:** Confirm the relevant files exist in the worktree:
  ```bash
  ls /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4/src/lib/permissions.ts \
     /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4/src/lib/wms/auth.ts \
     /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4/src/lib/session.ts
  ```
  Expected: all three files listed without error.

All subsequent file paths in this plan are absolute under the worktree root `/Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4/`.

---

### Task 2: Verify test harness is functional

**Files:** none (verification only)

- [ ] **Step 2.1:** From the worktree root, run a quick smoke against the harness to confirm it boots without errors:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  npm run scenarios -- --only 01-pedido-auto-propria --keep-server=false
  ```
  Expected: scenario passes (1/1). If the dev server fails to start, fix env (`.env.test`/`.env.test.local`) before continuing — all P4 tests depend on this harness.

- [ ] **Step 2.2:** Confirm `scripts/wms/cenarios/_harness/dev-server.ts` exposes `loginTestRunner` (we'll re-use it for our P4 auth-matrix tests):
  ```bash
  grep -n "loginTestRunner" /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4/scripts/wms/cenarios/_harness/dev-server.ts
  ```
  Expected: hit at lines ~50 (function definition) and ~52 (POST `/api/auth/login`).

- [ ] **Step 2.3:** Confirm the helper `createHttp` already injects `X-Session-Id`:
  ```bash
  grep -n "X-Session-Id" /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4/scripts/wms/cenarios/_harness/http.ts
  ```
  Expected: line 14 (`"X-Session-Id": opts.sessionId`).

---

### Task 3: Seed the four test users (admin, operador, vendedor, comprador)

**Files:** `scripts/wms/cenarios/_harness/seed-test-users.ts` (new)

We need four users with different roles so the auth tests can verify 401/403/200. The existing `seedInicial` only creates `test-runner` (admin). We add a new helper that idempotently upserts the other three.

- [ ] **Step 3.1:** Create the file `scripts/wms/cenarios/_harness/seed-test-users.ts` with content:
  ```ts
  import type { SupabaseClient } from "@supabase/supabase-js";

  /**
   * Seeded test users for P4 auth tests. PINs match TEST_USERS table:
   *   admin-runner / 1001 → role 'admin'
   *   op-runner    / 1002 → role 'operador'
   *   vendor-runner/ 1003 → role 'vendedor'
   *   buyer-runner / 1004 → role 'comprador'
   *
   * Idempotent — re-running upserts row + role mapping without duplicating.
   * Trigger `trg_sync_cargos_after_roles` keeps siso_usuarios.cargos[] in
   * sync after we insert siso_usuario_roles rows.
   */
  export interface TestUser {
    nome: string;
    pin: string;
    cargo: string; // legacy fallback; trigger overwrites from roles[]
    role_codigo: "admin" | "operador" | "vendedor" | "comprador";
  }

  export const TEST_USERS: TestUser[] = [
    { nome: "admin-runner",  pin: "1001", cargo: "admin",     role_codigo: "admin"     },
    { nome: "op-runner",     pin: "1002", cargo: "operador",  role_codigo: "operador"  },
    { nome: "vendor-runner", pin: "1003", cargo: "vendedor",  role_codigo: "vendedor"  },
    { nome: "buyer-runner",  pin: "1004", cargo: "comprador", role_codigo: "comprador" },
  ];

  export async function seedTestUsers(sb: SupabaseClient): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    for (const u of TEST_USERS) {
      // Upsert user
      const { data: existente } = await sb
        .from("siso_usuarios")
        .select("id")
        .eq("nome", u.nome)
        .maybeSingle();
      let id: string;
      if (existente) {
        await sb.from("siso_usuarios").update({ pin: u.pin, cargo: u.cargo, ativo: true }).eq("id", existente.id);
        id = (existente as { id: string }).id;
      } else {
        const { data, error } = await sb
          .from("siso_usuarios")
          .insert({ nome: u.nome, pin: u.pin, cargo: u.cargo, ativo: true })
          .select("id")
          .single();
        if (error) throw new Error(`seedTestUsers(${u.nome}): ${error.message}`);
        id = (data as { id: string }).id;
      }
      ids[u.nome] = id;

      // Resolve role_id
      const { data: role } = await sb
        .from("siso_roles")
        .select("id")
        .eq("codigo", u.role_codigo)
        .maybeSingle();
      if (!role) throw new Error(`seedTestUsers: role '${u.role_codigo}' não existe — rode migration 20260521_roles_permissoes.sql primeiro`);

      // Upsert user→role mapping (PK = usuario_id+role_id)
      await sb.from("siso_usuario_roles").upsert(
        { usuario_id: id, role_id: (role as { id: string }).id },
        { onConflict: "usuario_id,role_id" },
      );
    }
    return ids;
  }

  /**
   * Login helper for P4 tests. Returns sessionId for the given test user
   * by POSTing /api/auth/login with their PIN. Caller passes baseUrl from
   * the dev server.
   */
  export async function loginTestUser(opts: { baseUrl: string; nome: string }): Promise<string> {
    const user = TEST_USERS.find((u) => u.nome === opts.nome);
    if (!user) throw new Error(`loginTestUser: ${opts.nome} não está em TEST_USERS`);
    const res = await fetch(`${opts.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: user.nome, pin: user.pin }),
    });
    if (!res.ok) throw new Error(`loginTestUser ${opts.nome}: HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { sessionId?: string; sessao_id?: string; session_id?: string };
    const sid = data.sessionId ?? data.sessao_id ?? data.session_id;
    if (!sid) throw new Error(`loginTestUser ${opts.nome}: response sem session id`);
    return sid;
  }
  ```

- [ ] **Step 3.2:** Patch `scripts/wms/cenarios/_harness/seed.ts` to ALSO call `seedTestUsers` at the end of `seedInicial`. Edit:
  - Find the line `await upsertFornecedor(sb, "TestSupplier-Default", "TEST");` (~line 126).
  - After it, add:
    ```ts
    // P4 auth matrix users (admin/operador/vendedor/comprador)
    const { seedTestUsers } = await import("./seed-test-users");
    await seedTestUsers(sb);
    ```

- [ ] **Step 3.3:** Run the harness once to seed the four users:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  npm run scenarios -- --only 01-pedido-auto-propria --keep-server=false
  ```
  Then verify via `mcp__supabase__execute_sql` (project `ehbxpbeijofxtsbezwxd`):
  ```sql
  SELECT u.nome, u.pin, array_agg(r.codigo ORDER BY r.codigo) AS roles, u.ativo
  FROM siso_usuarios u
  LEFT JOIN siso_usuario_roles ur ON ur.usuario_id = u.id
  LEFT JOIN siso_roles r ON r.id = ur.role_id
  WHERE u.nome IN ('admin-runner', 'op-runner', 'vendor-runner', 'buyer-runner')
  GROUP BY u.nome, u.pin, u.ativo
  ORDER BY u.nome;
  ```
  Expected: 4 rows, each with the correct single role in `roles[]`, `pin` matching `1001..1004`, `ativo = true`.

- [ ] **Step 3.4:** Commit setup work:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  git add scripts/wms/cenarios/_harness/seed-test-users.ts scripts/wms/cenarios/_harness/seed.ts
  git commit -m "$(cat <<'EOF'
  test(p4): seed 4 test users for auth matrix (admin/operador/vendedor/comprador)

  Adds seedTestUsers helper + loginTestUser; wires into seedInicial so the
  harness re-creates them on every run. Required by all P4 auth tests.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Permissions registry update

### Task 4: Add 3 new granular permissions to `src/lib/permissions.ts`

**Files:** `src/lib/permissions.ts`, `supabase/migrations/20260527_p4_new_permissions.sql` (new)

**Decision log (re: spec §8.3 deliverable 2):**
- `operacoes.devolucoes_classificar` — **NEW** (granular fork of existing `operacoes.devolucoes`). We keep `operacoes.devolucoes` for backward compat in `requireWarehouseAccess`, but the classify endpoint will require the new granular one.
- `operacoes.retroativo` — **NEW** (8.9 says perm doesn't exist; we create it).
- `vendas.editar_vendedor` — **REUSE `vendas.criar`**. Decision: the existing `vendas/[id]/vendedor` handler already uses `userCan(user, "sistema.usuarios")` (admin) OR `userCan(user, "separacao.executar")` (operador) OR `isOwner`. Adding a third dedicated perm would explode the matrix without adding value — admin/operador already cover the "delegate to another vendedor" use case, and owners stay covered. We keep the gate as-is and instead enforce **target user cargo** (the actual finding 7.4 — "permite atribuir a usuário sem cargo"), which is a body validation, not a new perm.

- [ ] **Step 4.1:** Edit `src/lib/permissions.ts`. Find the `operacoes` block (~lines 33-38) and replace:
  ```ts
    "operacoes.transferir":     { modulo: "operacoes", label: "Transferir entre galpões" },
    "operacoes.replenishment":  { modulo: "operacoes", label: "Realocar intra-galpão" },
    "operacoes.devolucoes":     { modulo: "operacoes", label: "Classificar devoluções" },
    "operacoes.receber":        { modulo: "operacoes", label: "Receber NF (dock)" },
    "operacoes.guarda":         { modulo: "operacoes", label: "Put-away" },
    "operacoes.ajuste_manual":  { modulo: "operacoes", label: "Ajuste manual de saldo" },
  ```
  with:
  ```ts
    "operacoes.transferir":           { modulo: "operacoes", label: "Transferir entre galpões" },
    "operacoes.replenishment":        { modulo: "operacoes", label: "Realocar intra-galpão" },
    "operacoes.devolucoes":           { modulo: "operacoes", label: "Ver devoluções (read)" },
    "operacoes.devolucoes_classificar": { modulo: "operacoes", label: "Classificar devolução (escrita)" },
    "operacoes.receber":              { modulo: "operacoes", label: "Receber NF (dock)" },
    "operacoes.guarda":               { modulo: "operacoes", label: "Put-away" },
    "operacoes.ajuste_manual":        { modulo: "operacoes", label: "Ajuste manual de saldo" },
    "operacoes.retroativo":           { modulo: "operacoes", label: "Lançamento retroativo + reconciliar" },
  ```
  Note: the label for `operacoes.devolucoes` shifted from "Classificar devoluções" to "Ver devoluções (read)" to reflect the new split — the classify action now requires the granular perm.

- [ ] **Step 4.2:** Create the migration `supabase/migrations/20260527_p4_new_permissions.sql`:
  ```sql
  -- P4 finding 6.2 + 8.9: 2 new granular permissions
  --   operacoes.devolucoes_classificar — só admin + operador (vendedor/comprador FORA)
  --   operacoes.retroativo            — só admin + operador
  --
  -- A permissão `operacoes.devolucoes` continua existindo (label mudou pra
  -- "Ver devoluções (read)") — mantém compat com requireWarehouseAccess.

  -- 1. Grant operacoes.devolucoes_classificar pras roles admin + operador*
  INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
  SELECT r.id, 'operacoes.devolucoes_classificar'
  FROM siso_roles r
  WHERE r.codigo IN ('admin', 'operador', 'operador_cwb', 'operador_sp')
  ON CONFLICT (role_id, permissao_codigo) DO NOTHING;

  -- 2. Grant operacoes.retroativo pras mesmas roles
  INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
  SELECT r.id, 'operacoes.retroativo'
  FROM siso_roles r
  WHERE r.codigo IN ('admin', 'operador', 'operador_cwb', 'operador_sp')
  ON CONFLICT (role_id, permissao_codigo) DO NOTHING;

  -- 3. Verify (will fail loud if rows missing — okay for CI)
  DO $$
  DECLARE c int;
  BEGIN
    SELECT count(*) INTO c FROM siso_role_permissoes
    WHERE permissao_codigo IN ('operacoes.devolucoes_classificar', 'operacoes.retroativo');
    IF c < 8 THEN  -- 2 perms × 4 roles = 8
      RAISE EXCEPTION 'P4 perm seed incompleto: encontrado % grants (esperado ≥ 8)', c;
    END IF;
  END $$;
  ```

- [ ] **Step 4.3:** Apply the migration via `mcp__supabase__apply_migration` (project `ehbxpbeijofxtsbezwxd`):
  - `name`: `20260527_p4_new_permissions`
  - `query`: contents of the file above.

- [ ] **Step 4.4:** Verify via `mcp__supabase__execute_sql`:
  ```sql
  SELECT r.codigo AS role, array_agg(rp.permissao_codigo ORDER BY rp.permissao_codigo) AS perms_p4
  FROM siso_roles r
  JOIN siso_role_permissoes rp ON rp.role_id = r.id
  WHERE rp.permissao_codigo IN ('operacoes.devolucoes_classificar', 'operacoes.retroativo')
  GROUP BY r.codigo
  ORDER BY r.codigo;
  ```
  Expected rows: `admin`, `operador`, `operador_cwb`, `operador_sp` — each with both perms. `vendedor` and `comprador` MUST NOT appear.

- [ ] **Step 4.5:** Type-check passes:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  npx tsc --noEmit
  ```
  Expected: zero errors. `PermissaoCodigo` union now includes the 2 new strings.

- [ ] **Step 4.6:** Commit:
  ```bash
  git add src/lib/permissions.ts supabase/migrations/20260527_p4_new_permissions.sql
  git commit -m "$(cat <<'EOF'
  feat(perms): add operacoes.devolucoes_classificar + operacoes.retroativo

  Splits operacoes.devolucoes into read (existing) vs classificar (new) so
  finding 6.2 can require the granular perm in /devolucoes/[id]/classificar.
  Adds operacoes.retroativo for finding 8.9 (perm did not exist).
  Migration seeds both into admin + operador roles. Vendedor/comprador
  remain locked out by design.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Test harness extension (auth matrix runner)

### Task 5: Add reusable auth-matrix test runner

**Files:** `scripts/wms/cenarios/auth/runner.ts` (new), `scripts/wms/cenarios/auth/README.md` (new)

The 13 per-endpoint tasks below follow the same pattern: three fetches (no session → 401, wrong-perm session → 403, right-perm session → 200/expected). Centralizing this avoids 13 copy-pasted test files.

- [ ] **Step 5.1:** Create `scripts/wms/cenarios/auth/runner.ts`:
  ```ts
  import { loginTestUser, TEST_USERS } from "../_harness/seed-test-users";

  export type AuthCase = {
    label: string;
    user: "admin-runner" | "op-runner" | "vendor-runner" | "buyer-runner" | null; // null = no session
    expectedStatus: number;
  };

  export interface AuthMatrixTest {
    name: string;
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    bodyFor?: (user: string | null) => unknown; // if body depends on caller
    extraHeaders?: Record<string, string>;
    cases: AuthCase[];
  }

  export interface AuthMatrixResult {
    name: string;
    pass: boolean;
    details: Array<{ label: string; expected: number; got: number; bodySnippet: string }>;
  }

  export async function runAuthMatrix(opts: {
    baseUrl: string;
    tests: AuthMatrixTest[];
  }): Promise<AuthMatrixResult[]> {
    // Resolve sessionIds once per user
    const sessionByUser: Record<string, string> = {};
    for (const u of TEST_USERS) {
      sessionByUser[u.nome] = await loginTestUser({ baseUrl: opts.baseUrl, nome: u.nome });
    }

    const results: AuthMatrixResult[] = [];
    for (const t of opts.tests) {
      const details: AuthMatrixResult["details"] = [];
      for (const c of t.cases) {
        const headers: Record<string, string> = { ...(t.extraHeaders ?? {}) };
        if (c.user) headers["X-Session-Id"] = sessionByUser[c.user];
        const body = t.bodyFor ? t.bodyFor(c.user) : t.body;
        if (body !== undefined) headers["Content-Type"] = "application/json";

        const res = await fetch(`${opts.baseUrl}${t.path}`, {
          method: t.method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        details.push({
          label: c.label,
          expected: c.expectedStatus,
          got: res.status,
          bodySnippet: text.slice(0, 160),
        });
      }
      const pass = details.every((d) => d.expected === d.got);
      results.push({ name: t.name, pass, details });
    }
    return results;
  }

  export function printAuthMatrixReport(results: AuthMatrixResult[]): boolean {
    let allPass = true;
    for (const r of results) {
      const tag = r.pass ? "PASS" : "FAIL";
      console.log(`[${tag}] ${r.name}`);
      for (const d of r.details) {
        const ok = d.expected === d.got ? "  ok " : "  X  ";
        console.log(`${ok} ${d.label}: expected ${d.expected}, got ${d.got}${d.expected !== d.got ? ` body=${d.bodySnippet}` : ""}`);
      }
      if (!r.pass) allPass = false;
    }
    return allPass;
  }
  ```

- [ ] **Step 5.2:** Create `scripts/wms/cenarios/auth/README.md` (terse, points to runner):
  ```md
  # P4 auth-matrix tests

  Each per-endpoint test file calls `runAuthMatrix` with 3+ cases:
   - no session (sessão `null`) → expected 401
   - session with wrong perm → expected 403
   - session with right perm → expected 200 (or 400/404 if body lacks data; the assertion is "NOT 401/403")

  Run a single file: `npx tsx scripts/wms/cenarios/auth/NN-<endpoint>.ts`
  Run all: `npx tsx scripts/wms/cenarios/auth/run-all-auth.ts`

  Requires: dev server on :3001 + seeded users (seedInicial calls seedTestUsers).
  ```

- [ ] **Step 5.3:** Verify it compiles:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  npx tsc --noEmit
  ```
  Expected: zero errors.

- [ ] **Step 5.4:** Commit:
  ```bash
  git add scripts/wms/cenarios/auth/
  git commit -m "$(cat <<'EOF'
  test(p4): add reusable auth-matrix runner for per-endpoint tests

  Each P4 endpoint task (12 of 13) reuses runAuthMatrix to assert
  401/403/200 across the 4 seeded test cargos. Centralizes the fetch
  boilerplate to avoid 12 copy-pasted test files.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Per-endpoint TDD tasks

> **Pattern for all tasks below:** write the test FIRST, observe it FAILS (the endpoint is currently permissive, so 200 returns where 403 should), insert the check at the top of the handler, observe the test PASSES, commit.

### Task 6: Endpoint `GET /api/wms/pedidos` (finding 1.7 + 1.10)

**Files:**
- Test: `scripts/wms/cenarios/auth/06-pedidos-list.ts` (new)
- Implementation: `src/app/api/wms/pedidos/route.ts` (insert before line 136)

The current handler reads all orders without filtering by cargo or galpão. We require `pedidos.ver` (admin, operador*, comprador have it; vendedor does NOT). Galpão filter is enforced via UI only — but per finding 1.10 we also filter server-side when `session.galpaoId` is set AND the caller does not have `pedidos.aprovar` (admin/operadores keep cross-galpão view; comprador/vendedor restricted).

- [ ] **Step 6.1:** Create test `scripts/wms/cenarios/auth/06-pedidos-list.ts`:
  ```ts
  import "dotenv/config";
  import { runAuthMatrix, printAuthMatrixReport } from "./runner";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

  async function main() {
    const results = await runAuthMatrix({
      baseUrl,
      tests: [
        {
          name: "GET /api/wms/pedidos requires pedidos.ver",
          method: "GET",
          path: "/api/wms/pedidos",
          cases: [
            { label: "no session",     user: null,             expectedStatus: 401 },
            { label: "vendedor (sem pedidos.ver)", user: "vendor-runner",  expectedStatus: 403 },
            { label: "comprador (com pedidos.ver)", user: "buyer-runner",  expectedStatus: 200 },
            { label: "operador (com pedidos.ver)",  user: "op-runner",     expectedStatus: 200 },
            { label: "admin (todas)",   user: "admin-runner",  expectedStatus: 200 },
          ],
        },
      ],
    });
    const ok = printAuthMatrixReport(results);
    process.exit(ok ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```

- [ ] **Step 6.2:** Run the test against current (unprotected) handler. Start dev server in another shell, then:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  npx tsx scripts/wms/cenarios/auth/06-pedidos-list.ts
  ```
  Expected: FAIL — "no session" gets 200 instead of 401, "vendedor" gets 200 instead of 403. Document the actual statuses observed.

- [ ] **Step 6.3:** Edit `src/app/api/wms/pedidos/route.ts`. Find line 1 (`import { NextResponse } from "next/server";`) and replace the import block with:
  ```ts
  import { NextResponse } from "next/server";
  import { createServiceClient } from "@/lib/supabase-server";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { GalpaoEstoque } from "@/types";
  import { aggregateLiveStockBySku } from "@/lib/wms/live-stock";
  import {
    recomputarSugestaoBatch,
    type PedidoInput,
  } from "@/lib/wms/sugestao-dinamica";
  import { getSessionUser } from "@/lib/session";
  import { userCan } from "@/lib/permissions";
  ```
  Then find `export async function GET(request: Request) {` (line 135) and insert immediately after the opening brace:
  ```ts
    // Auth + perm (finding 1.7 + 1.10)
    const session = await getSessionUser(request);
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!userCan(session, "pedidos.ver")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  ```

- [ ] **Step 6.4:** Re-run the test (Step 6.2 command). Expected: PASS — all 5 cases match.

- [ ] **Step 6.5:** Commit:
  ```bash
  git add src/app/api/wms/pedidos/route.ts scripts/wms/cenarios/auth/06-pedidos-list.ts
  git commit -m "$(cat <<'EOF'
  feat(api): require pedidos.ver on GET /api/wms/pedidos (finding 1.7+1.10)

  Backend was trusting UI gating; vendedor could fetch all marketplace
  pedidos via direct curl. Adds getSessionUser + userCan check at handler
  top + integration test covering 4 cargos.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 7: Endpoint `GET /api/wms/pedidos/[id]/historico` (finding 1.7)

**Files:**
- Test: `scripts/wms/cenarios/auth/07-pedido-historico.ts` (new)
- Implementation: `src/app/api/wms/pedidos/[id]/historico/route.ts` (insert before line 11)

- [ ] **Step 7.1:** Create test `scripts/wms/cenarios/auth/07-pedido-historico.ts`:
  ```ts
  import "dotenv/config";
  import { runAuthMatrix, printAuthMatrixReport } from "./runner";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

  // Use a stable fake UUID — the handler returns 200 with empty array for
  // unknown pedidoIds, which is fine for the auth assertion (we only care
  // about 401/403 vs anything else).
  const FAKE_PEDIDO_ID = "00000000-0000-0000-0000-000000000000";

  async function main() {
    const results = await runAuthMatrix({
      baseUrl,
      tests: [{
        name: "GET /api/wms/pedidos/[id]/historico requires pedidos.ver",
        method: "GET",
        path: `/api/wms/pedidos/${FAKE_PEDIDO_ID}/historico`,
        cases: [
          { label: "no session",     user: null,            expectedStatus: 401 },
          { label: "vendedor",       user: "vendor-runner", expectedStatus: 403 },
          { label: "comprador",      user: "buyer-runner",  expectedStatus: 200 },
          { label: "operador",       user: "op-runner",     expectedStatus: 200 },
          { label: "admin",          user: "admin-runner",  expectedStatus: 200 },
        ],
      }],
    });
    const ok = printAuthMatrixReport(results);
    process.exit(ok ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```

- [ ] **Step 7.2:** Run the test, expect FAIL (no-session returns 200, vendedor returns 200).

- [ ] **Step 7.3:** Edit `src/app/api/wms/pedidos/[id]/historico/route.ts`. Replace imports (lines 1-3) with:
  ```ts
  import { NextRequest, NextResponse } from "next/server";
  import { createServiceClient } from "@/lib/supabase-server";
  import { logger } from "@/lib/logger";
  import { getSessionUser } from "@/lib/session";
  import { userCan } from "@/lib/permissions";
  ```
  Then find the handler `export async function GET(` (line 10). Inside the function, immediately after `const { id: pedidoId } = await params;` (line 14), insert:
  ```ts
    // Auth + perm (finding 1.7)
    const session = await getSessionUser(_request);
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!userCan(session, "pedidos.ver")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  ```
  Also rename the first parameter from `_request` to `request` (since we now use it):
  ```ts
  export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
  ```
  And update the `getSessionUser(_request)` to `getSessionUser(request)`.

- [ ] **Step 7.4:** Re-run test. Expected: PASS.

- [ ] **Step 7.5:** Commit:
  ```bash
  git add src/app/api/wms/pedidos/[id]/historico/route.ts scripts/wms/cenarios/auth/07-pedido-historico.ts
  git commit -m "$(cat <<'EOF'
  feat(api): require pedidos.ver on GET /pedidos/[id]/historico (finding 1.7)

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 8: Endpoint `webhook/reprocessar` (finding 1.3) — bigger fix

**Files:**
- Test: `scripts/wms/cenarios/auth/08-webhook-reprocessar.ts` (new)
- Implementation: `src/app/api/wms/webhook/reprocessar/route.ts` (full rewrite — Zod body schema + requireAdmin + targeted reprocess)

The current handler accepts POST with NO body and reprocesses **every** pending webhook log. Finding 1.3 says: (a) no auth, (b) ignores body, (c) reprocesses everything. We must: require admin via `requireAdmin`, parse body via Zod, and process **only** the `pedidoId` requested. Other webhooks MUST NOT be touched.

- [ ] **Step 8.1:** Create test `scripts/wms/cenarios/auth/08-webhook-reprocessar.ts`:
  ```ts
  import "dotenv/config";
  import { createServiceClient } from "../../../src/lib/supabase-server";
  import { loginTestUser } from "../_harness/seed-test-users";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

  async function fetchJson(method: string, path: string, opts: { sessionId?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (opts.sessionId) headers["X-Session-Id"] = opts.sessionId;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${path}`, {
      method, headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, body: await res.text() };
  }

  async function main() {
    const sb = createServiceClient();
    let failures = 0;

    // ── Case 1: no session → 401 ──
    {
      const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", { body: { pedidoId: "X" } });
      const ok = r.status === 401;
      console.log(`[${ok ? "PASS" : "FAIL"}] no session → ${r.status} (expected 401)`);
      if (!ok) failures++;
    }

    // ── Case 2: vendedor session → 403 (not admin) ──
    {
      const sid = await loginTestUser({ baseUrl, nome: "vendor-runner" });
      const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", { sessionId: sid, body: { pedidoId: "X" } });
      const ok = r.status === 403;
      console.log(`[${ok ? "PASS" : "FAIL"}] vendedor → ${r.status} (expected 403)`);
      if (!ok) failures++;
    }

    // ── Case 3: operador → 403 (admin only — requireAdmin) ──
    {
      const sid = await loginTestUser({ baseUrl, nome: "op-runner" });
      const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", { sessionId: sid, body: { pedidoId: "X" } });
      const ok = r.status === 403;
      console.log(`[${ok ? "PASS" : "FAIL"}] operador → ${r.status} (expected 403; admin-only)`);
      if (!ok) failures++;
    }

    // ── Case 4: admin sem body → 400 (Zod) ──
    {
      const sid = await loginTestUser({ baseUrl, nome: "admin-runner" });
      const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", { sessionId: sid });
      const ok = r.status === 400;
      console.log(`[${ok ? "PASS" : "FAIL"}] admin sem body → ${r.status} (expected 400)`);
      if (!ok) failures++;
    }

    // ── Case 5: admin com pedidoId desconhecido → 404 ──
    {
      const sid = await loginTestUser({ baseUrl, nome: "admin-runner" });
      const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", {
        sessionId: sid,
        body: { pedidoId: "9999999999" },
      });
      const ok = r.status === 404;
      console.log(`[${ok ? "PASS" : "FAIL"}] admin pedidoId desconhecido → ${r.status} (expected 404)`);
      if (!ok) failures++;
    }

    // ── Case 6: isolation — outras rows pendentes NÃO são reprocessadas ──
    // Setup: insere 2 rows pendentes em siso_webhook_logs com IDs distintos.
    // Chama o endpoint passando só o ID 1. Asserta que o ID 2 ainda está
    // status='pendente' depois (não foi tocado).
    {
      const sid = await loginTestUser({ baseUrl, nome: "admin-runner" });
      const id1 = `p4-isolation-${Date.now()}-1`;
      const id2 = `p4-isolation-${Date.now()}-2`;
      const { data: emp } = await sb.from("siso_empresas").select("id, cnpj").limit(1).single();
      const cnpj = (emp as { cnpj: string }).cnpj;

      // Reset/insert 2 logs
      await sb.from("siso_webhook_logs").insert([
        { tiny_pedido_id: id1, cnpj, codigo_situacao: "aprovado", status: "pendente", dedup_key: `dk-${id1}`, payload: { iso_test: true } },
        { tiny_pedido_id: id2, cnpj, codigo_situacao: "aprovado", status: "pendente", dedup_key: `dk-${id2}`, payload: { iso_test: true } },
      ]);

      const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", { sessionId: sid, body: { pedidoId: id1 } });
      // Status pode ser 200 ou 500 (depende se webhook-processor consegue resolver empresa);
      // o ponto da isolation é: id2 não foi mexido.
      const { data: row2 } = await sb.from("siso_webhook_logs").select("status").eq("tiny_pedido_id", id2).maybeSingle();
      const ok = (row2 as { status?: string } | null)?.status === "pendente";
      console.log(`[${ok ? "PASS" : "FAIL"}] isolation: id2 still pendente (got status=${(row2 as { status?: string } | null)?.status}) — endpoint reply status=${r.status}`);
      if (!ok) failures++;

      // Cleanup
      await sb.from("siso_webhook_logs").delete().in("tiny_pedido_id", [id1, id2]);
    }

    if (failures) process.exit(1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```

- [ ] **Step 8.2:** Run the test. Expected: all 6 cases FAIL (current handler is permissive AND reprocesses all rows).

- [ ] **Step 8.3:** Rewrite `src/app/api/wms/webhook/reprocessar/route.ts` in full:
  ```ts
  import { NextRequest, NextResponse } from "next/server";
  import { z } from "zod";
  import { createServiceClient } from "@/lib/supabase-server";
  import { processWebhook } from "@/lib/webhook-processor";
  import { getEmpresaByCnpj, getEmpresaById } from "@/lib/empresa-lookup";
  import { logger } from "@/lib/logger";
  import { requireAdmin } from "@/lib/wms/auth";

  /**
   * POST /api/wms/webhook/reprocessar
   *
   * Reprocesses a SINGLE failed webhook log identified by `pedidoId` (the
   * `tiny_pedido_id` text column in siso_webhook_logs). Admin-only.
   *
   * Body schema: { pedidoId: string }
   *
   * Returns 404 if no matching log exists. Other pending webhooks are NOT
   * touched.
   */
  const Body = z.object({
    pedidoId: z.string().min(1, "pedidoId obrigatório"),
  });

  export async function POST(req: NextRequest) {
    // Auth (finding 1.3 — admin only)
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    let parsed: z.infer<typeof Body>;
    try {
      const raw = await req.json();
      parsed = Body.parse(raw);
    } catch (e) {
      const msg = e instanceof z.ZodError
        ? e.errors.map((er) => `${er.path.join(".")}: ${er.message}`).join("; ")
        : "body inválido";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const { pedidoId } = parsed;
    const supabase = createServiceClient();

    const { data: log, error } = await supabase
      .from("siso_webhook_logs")
      .select("id, tiny_pedido_id, cnpj, empresa_id")
      .eq("tiny_pedido_id", pedidoId)
      .eq("codigo_situacao", "aprovado")
      .order("criado_em", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!log) {
      return NextResponse.json(
        { error: `Nenhum webhook log encontrado pra pedidoId=${pedidoId}` },
        { status: 404 },
      );
    }

    logger.info("reprocessar", `Reprocessando 1 webhook`, { pedidoId, logId: log.id });

    try {
      let empresaId = log.empresa_id as string | null;
      let galpaoId: string | null = null;
      let grupoId: string | null = null;

      if (!empresaId && log.cnpj) {
        const empresa = await getEmpresaByCnpj(log.cnpj);
        if (empresa) {
          empresaId = empresa.empresaId;
          galpaoId = empresa.galpaoId;
          grupoId = empresa.grupoId;
        }
      }
      if (!empresaId) {
        return NextResponse.json(
          { error: "Empresa não encontrada", pedidoId },
          { status: 422 },
        );
      }
      if (!galpaoId) {
        const emp = await getEmpresaById(empresaId);
        galpaoId = emp?.galpaoId ?? null;
        grupoId = emp?.grupoId ?? null;
      }

      await processWebhook(log.id, log.tiny_pedido_id, empresaId, galpaoId!, grupoId);
      return NextResponse.json({ ok: true, pedidoId, logId: log.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message
        : (typeof err === "object" && err !== null && "message" in err)
          ? String((err as { message: unknown }).message)
          : JSON.stringify(err);
      logger.error("reprocessar", `Reprocessamento falhou`, { pedidoId, err: msg });
      return NextResponse.json({ ok: false, pedidoId, error: msg }, { status: 500 });
    }
  }
  ```

- [ ] **Step 8.4:** Re-run test. Expected: all 6 cases PASS.

- [ ] **Step 8.5:** Verify `zod` is in package.json:
  ```bash
  grep '"zod":' /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4/package.json
  ```
  Expected: hit. If missing, add via `npm install zod` (but it's almost certainly already installed — used elsewhere).

- [ ] **Step 8.6:** Commit:
  ```bash
  git add src/app/api/wms/webhook/reprocessar/route.ts scripts/wms/cenarios/auth/08-webhook-reprocessar.ts
  git commit -m "$(cat <<'EOF'
  fix(api): webhook/reprocessar admin-only + Zod body + targeted (finding 1.3)

  Endpoint previously accepted unauthenticated POST and reprocessed EVERY
  pending row. Now requires admin, validates {pedidoId} via Zod, fetches
  the single matching log (404 if missing), and processes only that one.
  Isolation test verifies other pending rows are not touched.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 9: Endpoint `POST /api/wms/pedidos/[id]/observacoes` (finding 1.7 + 4.6)

**Files:**
- Test: `scripts/wms/cenarios/auth/09-observacoes.ts` (new)
- Implementation: `src/app/api/wms/pedidos/[id]/observacoes/route.ts` (insert before line 9 and 42)

Both GET (read observations) and POST (create) currently lack auth. We require `pedidos.ver` for GET and POST. Body MUST still have `usuarioId/usuarioNome/texto`, but now `usuarioId` MUST match the session user id (avoid impersonation).

- [ ] **Step 9.1:** Create test `scripts/wms/cenarios/auth/09-observacoes.ts`:
  ```ts
  import "dotenv/config";
  import { runAuthMatrix, printAuthMatrixReport } from "./runner";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";
  const FAKE = "00000000-0000-0000-0000-000000000000";

  async function main() {
    const results = await runAuthMatrix({
      baseUrl,
      tests: [
        {
          name: "GET observações requires pedidos.ver",
          method: "GET",
          path: `/api/wms/pedidos/${FAKE}/observacoes`,
          cases: [
            { label: "no session", user: null,            expectedStatus: 401 },
            { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
            { label: "comprador",  user: "buyer-runner",  expectedStatus: 200 },
            { label: "admin",      user: "admin-runner",  expectedStatus: 200 },
          ],
        },
        {
          name: "POST observações requires pedidos.ver",
          method: "POST",
          path: `/api/wms/pedidos/${FAKE}/observacoes`,
          // Body uses the session user's own id+nome — server should ignore
          // body usuarioId mismatch (we'll add that check in the impl).
          bodyFor: (user) => ({
            usuarioId: "irrelevant", // server overrides with session.user.id
            usuarioNome: "irrelevant",
            texto: `auth test ${user ?? "anon"} ${Date.now()}`,
          }),
          cases: [
            { label: "no session", user: null,            expectedStatus: 401 },
            { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
            // Admin com pedido fake → row tem que ser criada (FK pedido_id é
            // text? No — é uuid. UUID fake é válido pelo formato; insert
            // tentará FK lookup que pode 500. Esperamos 500 OU 200 (não 401/403).
            // O assertion da matrix só cobre status estrito; pra esse caso
            // usamos 500 (insert fails on FK).
            { label: "admin (fake pedidoId → FK fails)", user: "admin-runner",  expectedStatus: 500 },
          ],
        },
      ],
    });
    const ok = printAuthMatrixReport(results);
    process.exit(ok ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```

- [ ] **Step 9.2:** Run test, expect FAIL on all cases (handler is fully permissive).

- [ ] **Step 9.3:** Edit `src/app/api/wms/pedidos/[id]/observacoes/route.ts`. Replace the full file with:
  ```ts
  import { NextRequest, NextResponse } from "next/server";
  import { createServiceClient } from "@/lib/supabase-server";
  import { logger } from "@/lib/logger";
  import { getSessionUser } from "@/lib/session";
  import { userCan } from "@/lib/permissions";

  /**
   * GET /api/wms/pedidos/[id]/observacoes
   * Returns all observations for a given order, newest last.
   */
  export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
    // Auth + perm (finding 1.7)
    const session = await getSessionUser(request);
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!userCan(session, "pedidos.ver")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { id: pedidoId } = await params;
    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("siso_pedido_observacoes")
      .select("*")
      .eq("pedido_id", pedidoId)
      .order("criado_em", { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const result = (data ?? []).map((row) => ({
      id: row.id,
      pedidoId: row.pedido_id,
      usuarioId: row.usuario_id,
      usuarioNome: row.usuario_nome,
      texto: row.texto,
      criadoEm: row.criado_em,
    }));

    return NextResponse.json(result);
  }

  /**
   * POST /api/wms/pedidos/[id]/observacoes
   * Create a new observation. Body: { texto } — usuarioId/usuarioNome are
   * derived from the session (impersonation protection).
   */
  export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
    // Auth + perm (finding 1.7)
    const session = await getSessionUser(request);
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!userCan(session, "pedidos.ver")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { id: pedidoId } = await params;
    const body = await request.json();
    const { texto } = body as { texto?: string };

    if (!texto?.trim()) {
      return NextResponse.json({ error: "texto é obrigatório" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("siso_pedido_observacoes")
      .insert({
        pedido_id: pedidoId,
        usuario_id: session.id,     // from session — ignore body
        usuario_nome: session.nome, // from session — ignore body
        texto: texto.trim(),
      })
      .select()
      .single();

    if (error) {
      logger.error("observacoes", "Failed to create observation", {
        pedidoId,
        usuarioId: session.id,
        error: error.message,
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      id: data.id,
      pedidoId: data.pedido_id,
      usuarioId: data.usuario_id,
      usuarioNome: data.usuario_nome,
      texto: data.texto,
      criadoEm: data.criado_em,
    });
  }
  ```

- [ ] **Step 9.4:** Re-run test. Expected: PASS on GET cases + POST 401/403 + POST 500 (FK fails since fake pedido_id has no row in siso_pedidos).

- [ ] **Step 9.5:** Check that `src/app/api/wms/pedidos/[id]/detalhe/route.ts` still works (it reads `siso_pedido_observacoes` via service client — unaffected by this change). No code change needed.

- [ ] **Step 9.6:** Audit existing UI callers that POST to this endpoint — they currently send `usuarioId/usuarioNome` in the body. The server now **ignores** those fields and uses session. UI does not need to change (extra body fields are silently dropped), but verify nothing breaks:
  ```bash
  grep -rn "observacoes" /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4/src/app/wms/ --include="*.tsx" | head
  ```
  If any caller is found that expects 200 specifically based on `usuarioId`, leave a note in the commit but do not modify UI (P5 covers UI).

- [ ] **Step 9.7:** Commit:
  ```bash
  git add src/app/api/wms/pedidos/[id]/observacoes/route.ts scripts/wms/cenarios/auth/09-observacoes.ts
  git commit -m "$(cat <<'EOF'
  feat(api): require pedidos.ver on observações GET+POST (findings 1.7+4.6)

  - GET requires pedidos.ver
  - POST requires pedidos.ver AND derives usuario_id/usuario_nome from
    session (was reading from body, allowing impersonation)

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 10: Endpoint `POST /api/wms/pedidos/aprovar` (finding 1.7 + 4.1)

**Files:**
- Test: `scripts/wms/cenarios/auth/10-aprovar.ts` (new)
- Implementation: `src/app/api/wms/pedidos/aprovar/route.ts` (insert before line 27)

Require `pedidos.aprovar` (admin + operador*). Comprador/vendedor explicitly excluded per CLAUDE.md role matrix.

- [ ] **Step 10.1:** Create test `scripts/wms/cenarios/auth/10-aprovar.ts`:
  ```ts
  import "dotenv/config";
  import { runAuthMatrix, printAuthMatrixReport } from "./runner";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

  async function main() {
    const results = await runAuthMatrix({
      baseUrl,
      tests: [{
        name: "POST aprovar requires pedidos.aprovar",
        method: "POST",
        path: "/api/wms/pedidos/aprovar",
        // Pass body with missing pedidoId — server reaches the perm check
        // before validating body, so 401/403 fires first; the "right perm"
        // case falls through to body validation (400).
        body: { pedidoId: "00000000-0000-0000-0000-000000000000", decisao: "propria" },
        cases: [
          { label: "no session", user: null,            expectedStatus: 401 },
          { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
          { label: "comprador",  user: "buyer-runner",  expectedStatus: 403 },
          // operador + admin têm pedidos.aprovar → pass perm gate; pedido
          // fake → handler retorna 404 (não encontrado). Esperamos 404,
          // NÃO 401/403.
          { label: "operador (passa perm; pedido fake)", user: "op-runner",     expectedStatus: 404 },
          { label: "admin (passa perm; pedido fake)",    user: "admin-runner",  expectedStatus: 404 },
        ],
      }],
    });
    const ok = printAuthMatrixReport(results);
    process.exit(ok ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```
  > Note: if `aprovar` currently returns 500 instead of 404 for fake IDs, adjust the expected status accordingly. Verify with a one-shot fetch before committing the test.

- [ ] **Step 10.2:** Run test, expect FAIL (current handler bypasses auth).

- [ ] **Step 10.3:** Edit `src/app/api/wms/pedidos/aprovar/route.ts`. Replace import block (lines 1-14) with:
  ```ts
  import { NextRequest, NextResponse } from "next/server";
  import { after } from "next/server";
  import { createServiceClient } from "@/lib/supabase-server";
  import { getEmpresaById } from "@/lib/empresa-lookup";
  import { getEmpresasDoGrupo } from "@/lib/grupo-resolver";
  import { kickWorker } from "@/lib/execution-worker";
  import { logger } from "@/lib/logger";
  import { registrarEvento } from "@/lib/historico-service";
  import { wmsAsSource } from "@/lib/wms/flags";
  import { reservarAtomico, estornarReservaIndividual } from "@/lib/wms/reservas";
  import {
    resolverProdutoWms,
    buscarLocComMaiorSaldoNoGalpao,
  } from "@/lib/separacao/wms-mapping";
  import { getSessionUser } from "@/lib/session";
  import { userCan } from "@/lib/permissions";
  ```
  Find `export async function POST(request: NextRequest) {` (line 26). Immediately after the opening brace, before the existing `let body: { ... };` block (line 27), insert:
  ```ts
    // Auth + perm (finding 4.1 — pedidos.aprovar)
    const session = await getSessionUser(request);
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!userCan(session, "pedidos.aprovar")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  ```

- [ ] **Step 10.4:** Re-run test. Expected: PASS.

- [ ] **Step 10.5:** Commit:
  ```bash
  git add src/app/api/wms/pedidos/aprovar/route.ts scripts/wms/cenarios/auth/10-aprovar.ts
  git commit -m "$(cat <<'EOF'
  feat(api): require pedidos.aprovar on POST /pedidos/aprovar (finding 4.1)

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 11: Endpoint `GET /api/wms/inventario/metricas` (finding 4.16)

**Files:**
- Test: `scripts/wms/cenarios/auth/11-inventario-metricas.ts` (new)
- Implementation: `src/app/api/wms/inventario/metricas/route.ts` (replace getSessionUser check with `requireWarehouseAccess`)

Currently uses `getSessionUser` (just "any logged-in user"). Spec says it should use `requireWarehouseAccess` (warehouse perms only — vendedor/comprador out).

- [ ] **Step 11.1:** Create test `scripts/wms/cenarios/auth/11-inventario-metricas.ts`:
  ```ts
  import "dotenv/config";
  import { runAuthMatrix, printAuthMatrixReport } from "./runner";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

  async function main() {
    const results = await runAuthMatrix({
      baseUrl,
      tests: [{
        name: "GET inventario/metricas requires warehouse access",
        method: "GET",
        path: "/api/wms/inventario/metricas",
        cases: [
          { label: "no session", user: null,            expectedStatus: 401 },
          { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
          { label: "comprador",  user: "buyer-runner",  expectedStatus: 403 },
          { label: "operador",   user: "op-runner",     expectedStatus: 200 },
          { label: "admin",      user: "admin-runner",  expectedStatus: 200 },
        ],
      }],
    });
    const ok = printAuthMatrixReport(results);
    process.exit(ok ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```

- [ ] **Step 11.2:** Run test. Expected: FAIL — vendedor and comprador currently get 200 (handler only requires "any session").

- [ ] **Step 11.3:** Replace `src/app/api/wms/inventario/metricas/route.ts` with:
  ```ts
  import { NextRequest, NextResponse } from "next/server";
  import { createServiceClient } from "@/lib/supabase-server";
  import { requireWarehouseAccess } from "@/lib/wms/auth";

  export async function GET(req: NextRequest) {
    // Auth + perm (finding 4.16)
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;

    const sb = createServiceClient();

    const [op, loc] = await Promise.all([
      sb.rpc("wms_metricas_operador"),
      sb.rpc("wms_metricas_localizacao"),
    ]);

    return NextResponse.json({
      porOperador: op.data ?? [],
      porLocalizacao: loc.data ?? [],
    });
  }
  ```

- [ ] **Step 11.4:** Re-run test. Expected: PASS.

- [ ] **Step 11.5:** Commit:
  ```bash
  git add src/app/api/wms/inventario/metricas/route.ts scripts/wms/cenarios/auth/11-inventario-metricas.ts
  git commit -m "$(cat <<'EOF'
  fix(api): inventario/metricas requires warehouse access (finding 4.16)

  Was accepting any logged-in user; vendedor/comprador could see operator
  accuracy stats. Now uses requireWarehouseAccess (same as other inventário
  endpoints).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 12: Endpoint `POST /api/wms/vendas/criar` (finding 7.1)

**Files:**
- Test: `scripts/wms/cenarios/auth/12-vendas-criar.ts` (new)
- Implementation: `src/app/api/wms/vendas/criar/route.ts` (insert after line 62)

Handler currently checks `getSessionUser` only (any logged-in user). Must require `vendas.criar` (admin + vendedor; operador also has it per CLAUDE.md? — check spec). CLAUDE.md role table says: `operador` does NOT get `vendas.criar`. Only `admin` and `vendedor` do.

- [ ] **Step 12.1:** Create test `scripts/wms/cenarios/auth/12-vendas-criar.ts`:
  ```ts
  import "dotenv/config";
  import { runAuthMatrix, printAuthMatrixReport } from "./runner";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

  async function main() {
    const results = await runAuthMatrix({
      baseUrl,
      tests: [{
        name: "POST vendas/criar requires vendas.criar",
        method: "POST",
        path: "/api/wms/vendas/criar",
        // minimal body: server will likely 400 on missing fields, which
        // is fine — we only assert 401/403 are blocked, and 400 means
        // perm gate passed.
        body: {
          cliente_nome: "Auth Test",
          cliente_cpf_cnpj: null,
          canal_venda: "balcao",
          empresa_origem_id: "00000000-0000-0000-0000-000000000000",
          galpao_id: "00000000-0000-0000-0000-000000000000",
          modo: "separacao",
          items: [],
        },
        cases: [
          { label: "no session", user: null,            expectedStatus: 401 },
          { label: "operador (sem vendas.criar)",  user: "op-runner",     expectedStatus: 403 },
          { label: "comprador (sem vendas.criar)", user: "buyer-runner",  expectedStatus: 403 },
          // vendedor + admin têm vendas.criar → passa perm gate; body
          // inválido (items vazio) → 400.
          { label: "vendedor (passa perm; body inválido)", user: "vendor-runner", expectedStatus: 400 },
          { label: "admin (passa perm; body inválido)",    user: "admin-runner",  expectedStatus: 400 },
        ],
      }],
    });
    const ok = printAuthMatrixReport(results);
    process.exit(ok ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```
  > Note: confirm the actual response status from current handler for "items: []" — if it's 500 instead of 400, adjust. The expected "right perm" is "NOT 401/403".

- [ ] **Step 12.2:** Run test, expect FAIL on operador/comprador (they get 400/500 instead of 403).

- [ ] **Step 12.3:** Edit `src/app/api/wms/vendas/criar/route.ts`. Find existing import block. Already imports `getSessionUser`. Add at top of imports (after line 35):
  ```ts
  import { userCan } from "@/lib/permissions";
  ```
  Then find lines 58-62:
  ```ts
  export async function POST(request: NextRequest) {
    const user = await getSessionUser(request);
    if (!user) {
      return NextResponse.json({ erro: "Sessão inválida ou expirada" }, { status: 401 });
    }
  ```
  Replace with:
  ```ts
  export async function POST(request: NextRequest) {
    // Auth + perm (finding 7.1)
    const user = await getSessionUser(request);
    if (!user) {
      return NextResponse.json({ erro: "Sessão inválida ou expirada" }, { status: 401 });
    }
    if (!userCan(user, "vendas.criar")) {
      return NextResponse.json({ erro: "forbidden — requer vendas.criar" }, { status: 403 });
    }
  ```

- [ ] **Step 12.4:** Re-run test. Expected: PASS.

- [ ] **Step 12.5:** Commit:
  ```bash
  git add src/app/api/wms/vendas/criar/route.ts scripts/wms/cenarios/auth/12-vendas-criar.ts
  git commit -m "$(cat <<'EOF'
  feat(api): require vendas.criar on POST /vendas/criar (finding 7.1)

  Backend was trusting UI gating; operador/comprador could create vendas
  via direct curl, sidestepping role-based UI hiding. Now backend matches
  the role contract in CLAUDE.md.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 13: Endpoint `GET /api/wms/vendas/[id]` — ownership (finding 7.3)

**Files:**
- Test: `scripts/wms/cenarios/auth/13-vendas-detalhe-ownership.ts` (new)
- Implementation: `src/app/api/wms/vendas/[id]/route.ts` (extend existing block at lines 46-56)

Handler already has perm check (vendedor only sees venda direta types). But finding 7.3 says: vendedor V1 should not see vendedor V2's pedido even if it's a venda direta. Add ownership check that compares `pedido.vendedor_id === user.id` OR `pedido.vendedor_nome LIKE %user.nome%` (case-insensitive — handles auto-attribution like "MLusername NetAir"). Admin / operador bypass.

- [ ] **Step 13.1:** Create test `scripts/wms/cenarios/auth/13-vendas-detalhe-ownership.ts`:
  ```ts
  import "dotenv/config";
  import { createServiceClient } from "../../../src/lib/supabase-server";
  import { loginTestUser } from "../_harness/seed-test-users";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

  async function fetchStatus(path: string, sessionId?: string) {
    const headers: Record<string, string> = {};
    if (sessionId) headers["X-Session-Id"] = sessionId;
    const r = await fetch(`${baseUrl}${path}`, { headers });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  }

  async function main() {
    const sb = createServiceClient();

    // Seed extra vendedor V2 (P4 standard vendor-runner is V1; we need a
    // second vendedor with their own pedido).
    const v2nome = "vendor2-runner";
    const v2pin = "1005";
    const { data: ex } = await sb.from("siso_usuarios").select("id").eq("nome", v2nome).maybeSingle();
    let v2Id: string;
    if (ex) {
      v2Id = (ex as { id: string }).id;
      await sb.from("siso_usuarios").update({ pin: v2pin, ativo: true, cargo: "vendedor" }).eq("id", v2Id);
    } else {
      const { data } = await sb.from("siso_usuarios").insert({ nome: v2nome, pin: v2pin, cargo: "vendedor", ativo: true }).select("id").single();
      v2Id = (data as { id: string }).id;
    }
    const { data: roleV } = await sb.from("siso_roles").select("id").eq("codigo", "vendedor").single();
    await sb.from("siso_usuario_roles").upsert(
      { usuario_id: v2Id, role_id: (roleV as { id: string }).id },
      { onConflict: "usuario_id,role_id" },
    );

    // Login V2 ad hoc
    const loginV2 = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: v2nome, pin: v2pin }),
    });
    const v2Session = (await loginV2.json() as { sessionId?: string }).sessionId!;

    // Get vendor-runner (V1) id
    const { data: v1Row } = await sb.from("siso_usuarios").select("id").eq("nome", "vendor-runner").single();
    const v1Id = (v1Row as { id: string }).id;

    // Insert a pedido owned by V2 (origem_pedido='manual' so it's a venda
    // direta and the existing vendedor check passes; ownership is the
    // additional gate).
    const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
    const empresaId = (emp as { id: string }).id;
    const pedidoFakeId = `auth-test-${Date.now()}`;
    const { data: pedidoRow } = await sb.from("siso_pedidos").insert({
      id: pedidoFakeId,
      numero: pedidoFakeId,
      empresa_origem_id: empresaId,
      cliente_nome: "Auth Test",
      origem_pedido: "manual",
      status: "concluido",
      vendedor_id: v2Id,
      vendedor_nome: v2nome,
      data: new Date().toISOString().slice(0, 10),
      processado_em: new Date().toISOString(),
      criado_em: new Date().toISOString(),
    }).select("id").single();
    const pedidoId = (pedidoRow as { id: string }).id;

    let failures = 0;

    // V1 trying to access V2's pedido → 403
    const sidV1 = await loginTestUser({ baseUrl, nome: "vendor-runner" });
    const r1 = await fetchStatus(`/api/wms/vendas/${pedidoId}`, sidV1);
    const ok1 = r1.status === 403;
    console.log(`[${ok1 ? "PASS" : "FAIL"}] vendedor V1 → V2 pedido: ${r1.status} (expected 403)`);
    if (!ok1) failures++;

    // V2 acessando o próprio → 200
    const r2 = await fetchStatus(`/api/wms/vendas/${pedidoId}`, v2Session);
    const ok2 = r2.status === 200;
    console.log(`[${ok2 ? "PASS" : "FAIL"}] vendedor V2 → V2 pedido: ${r2.status} (expected 200)`);
    if (!ok2) failures++;

    // Admin acessando o pedido → 200 (bypass)
    const sidAdmin = await loginTestUser({ baseUrl, nome: "admin-runner" });
    const r3 = await fetchStatus(`/api/wms/vendas/${pedidoId}`, sidAdmin);
    const ok3 = r3.status === 200;
    console.log(`[${ok3 ? "PASS" : "FAIL"}] admin → V2 pedido: ${r3.status} (expected 200)`);
    if (!ok3) failures++;

    // Operador acessando → 200 (separacao.executar bypass)
    const sidOp = await loginTestUser({ baseUrl, nome: "op-runner" });
    const r4 = await fetchStatus(`/api/wms/vendas/${pedidoId}`, sidOp);
    const ok4 = r4.status === 200;
    console.log(`[${ok4 ? "PASS" : "FAIL"}] operador → V2 pedido: ${r4.status} (expected 200)`);
    if (!ok4) failures++;

    // Cleanup
    await sb.from("siso_pedidos").delete().eq("id", pedidoId);

    if (failures) process.exit(1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```

- [ ] **Step 13.2:** Run test. Expected: FAIL on case 1 (V1 currently gets 200 — handler only blocks non-venda-direta, not cross-vendedor).

- [ ] **Step 13.3:** Edit `src/app/api/wms/vendas/[id]/route.ts`. Find the existing perm block (lines 45-56). Replace it with:
  ```ts
    // Permissão: vendedor "puro" (sem perms de admin/operador) só pode ver
    // pedidos da aba Vendas (manual OR ML/Shopee) E que sejam seus
    // (vendedor_id == session.id OR vendedor_nome contém session.nome).
    const isVendaDireta =
      pedido.origem_pedido === "manual" ||
      pedido.nome_ecommerce === "Mercado Livre" ||
      pedido.nome_ecommerce === "Shopee";
    const isAdmin = userCan(user, "sistema.usuarios");
    const isOperador = userCan(user, "separacao.executar");
    const isVendedor = !isAdmin && !isOperador && userCan(user, "vendas.criar");
    if (isVendedor) {
      if (!isVendaDireta) {
        return NextResponse.json({ erro: "Sem permissão" }, { status: 403 });
      }
      // Ownership: vendedor_id match OR auto-atribuição via vendedor_nome
      // (webhook-processor seta vendedor_nome = `${ecomNome} ${empresaNome}`
      // — chequeamos com case-insensitive contains pra cobrir esse caso).
      const ownedById = pedido.vendedor_id === user.id;
      const ownedByName = pedido.vendedor_nome
        ? pedido.vendedor_nome.toLowerCase().includes(user.nome.toLowerCase())
        : false;
      if (!ownedById && !ownedByName) {
        return NextResponse.json({ erro: "Sem permissão (não é seu pedido)" }, { status: 403 });
      }
    }
  ```

- [ ] **Step 13.4:** Re-run test. Expected: PASS.

- [ ] **Step 13.5:** Commit:
  ```bash
  git add src/app/api/wms/vendas/[id]/route.ts scripts/wms/cenarios/auth/13-vendas-detalhe-ownership.ts
  git commit -m "$(cat <<'EOF'
  feat(api): vendas/[id] ownership check for vendedor (finding 7.3)

  Vendedor V1 could fetch V2's pedido detail via direct curl. Now blocks
  unless pedido.vendedor_id === session.id OR pedido.vendedor_nome
  contains session.nome (covers auto-attribution like "MLuser NetAir").
  Admin/operador bypass via existing perm checks.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 14: Endpoint `POST /api/wms/devolucoes/[id]/classificar` — granular perm (finding 6.2)

**Files:**
- Test: `scripts/wms/cenarios/auth/14-devolucoes-classificar.ts` (new)
- Implementation: `src/app/api/wms/devolucoes/[id]/classificar/route.ts` (replace `requireWarehouseAccess` with granular perm)

Today the handler uses `requireWarehouseAccess` — which lets ANY warehouse perm in (including `produtos.editar`). Per spec we need a granular `operacoes.devolucoes_classificar` (created in Task 4).

- [ ] **Step 14.1:** Create test `scripts/wms/cenarios/auth/14-devolucoes-classificar.ts`:
  ```ts
  import "dotenv/config";
  import { runAuthMatrix, printAuthMatrixReport } from "./runner";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";
  const FAKE = "00000000-0000-0000-0000-000000000000";

  async function main() {
    const results = await runAuthMatrix({
      baseUrl,
      tests: [{
        name: "POST devolucoes/classificar requires operacoes.devolucoes_classificar",
        method: "POST",
        path: `/api/wms/devolucoes/${FAKE}/classificar`,
        body: {
          classificacao: "integro",
          produto_id: FAKE,
          galpao_id: FAKE,
          localizacao_id: FAKE,
          qty: 1,
        },
        cases: [
          { label: "no session", user: null,            expectedStatus: 401 },
          { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
          { label: "comprador",  user: "buyer-runner",  expectedStatus: 403 },
          // operador + admin têm operacoes.devolucoes_classificar →
          // perm gate passes, body referencia fake ids → 400 (lib rejeita).
          { label: "operador (passa perm; ids fake)", user: "op-runner",     expectedStatus: 400 },
          { label: "admin (passa perm; ids fake)",    user: "admin-runner",  expectedStatus: 400 },
        ],
      }],
    });
    const ok = printAuthMatrixReport(results);
    process.exit(ok ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```

- [ ] **Step 14.2:** Run test. Expected: FAIL on comprador (today it would pass through `requireWarehouseAccess` since comprador might inherit some perm via custom roles — actually CLAUDE.md says comprador has only `pedidos.ver/compras.*/estoque.ver/cobertura.ver/relatorios.ver`, none of which are in `requireWarehouseAccess` whitelist; so comprador today already returns 403. But if a custom role adds `produtos.editar` to comprador, they'd get in. The test is still valid — it verifies the granular requirement going forward).

- [ ] **Step 14.3:** Edit `src/app/api/wms/devolucoes/[id]/classificar/route.ts`. Replace import line 3 (`requireWarehouseAccess`) with both:
  ```ts
  import { getSessionUser } from "@/lib/session";
  import { userCan } from "@/lib/permissions";
  ```
  And remove the existing line:
  ```ts
  import { requireWarehouseAccess } from "@/lib/wms/auth";
  ```
  Then find the auth block (lines 39-40):
  ```ts
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;
  ```
  Replace with:
  ```ts
    // Auth + perm granular (finding 6.2)
    const session = await getSessionUser(req);
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!userCan(session, "operacoes.devolucoes_classificar")) {
      return NextResponse.json({ error: "forbidden — requer operacoes.devolucoes_classificar" }, { status: 403 });
    }
    const auth = { user: session };
  ```
  > The trailing `const auth = { user: session };` keeps the body downstream (`auth.user.id`) working without further edits.

- [ ] **Step 14.4:** Re-run test. Expected: PASS.

- [ ] **Step 14.5:** Commit:
  ```bash
  git add src/app/api/wms/devolucoes/[id]/classificar/route.ts scripts/wms/cenarios/auth/14-devolucoes-classificar.ts
  git commit -m "$(cat <<'EOF'
  fix(api): devolucoes/classificar requires granular perm (finding 6.2)

  Was using requireWarehouseAccess (any warehouse perm). Now requires the
  dedicated operacoes.devolucoes_classificar, locking out custom roles
  that have e.g. produtos.editar but no business reason to write devolução
  classifications.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 15a: Endpoint `POST /api/wms/lancamento-retroativo` (finding 8.9)

**Files:**
- Test: `scripts/wms/cenarios/auth/15a-retroativo-criar.ts` (new)
- Implementation: `src/app/api/wms/lancamento-retroativo/route.ts` (swap `requireWarehouseAccess` for granular perm)

- [ ] **Step 15a.1:** Create test `scripts/wms/cenarios/auth/15a-retroativo-criar.ts`:
  ```ts
  import "dotenv/config";
  import { runAuthMatrix, printAuthMatrixReport } from "./runner";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";
  const FAKE = "00000000-0000-0000-0000-000000000000";

  async function main() {
    const results = await runAuthMatrix({
      baseUrl,
      tests: [{
        name: "POST lancamento-retroativo requires operacoes.retroativo",
        method: "POST",
        path: "/api/wms/lancamento-retroativo",
        body: {
          tripla: { produto_id: FAKE, galpao_id: FAKE, localizacao_id: FAKE },
          qty: 1,
          motivo: "auth test",
        },
        cases: [
          { label: "no session", user: null,            expectedStatus: 401 },
          { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
          { label: "comprador",  user: "buyer-runner",  expectedStatus: 403 },
          // operador + admin têm operacoes.retroativo (seed em Task 4) →
          // passa perm gate, body referencia fake ids → 400/500 (lib quebra
          // ao inserir mov com produto/galpao/loc inexistente).
          { label: "operador (passa perm; ids fake)", user: "op-runner",     expectedStatus: 500 },
          { label: "admin (passa perm; ids fake)",    user: "admin-runner",  expectedStatus: 500 },
        ],
      }],
    });
    const ok = printAuthMatrixReport(results);
    process.exit(ok ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```
  > Note: confirm actual error code from `lancarRetroativo` with fake ids — may be 400 (validation) or 500 (RPC). Adjust expected accordingly.

- [ ] **Step 15a.2:** Run test, expect FAIL (comprador and vendedor today pass through `requireWarehouseAccess` only if they have a whitelisted perm — vendedor doesn't, but the assertion is that the new granular gate is enforced).

- [ ] **Step 15a.3:** Edit `src/app/api/wms/lancamento-retroativo/route.ts`. Find import line 2:
  ```ts
  import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
  ```
  Replace with:
  ```ts
  import { requireAuth } from "@/lib/wms/auth";
  import { getSessionUser } from "@/lib/session";
  import { userCan } from "@/lib/permissions";
  ```
  Find lines 22-23 (inside POST):
  ```ts
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;
  ```
  Replace with:
  ```ts
    // Auth + perm granular (finding 8.9)
    const session = await getSessionUser(req);
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!userCan(session, "operacoes.retroativo")) {
      return NextResponse.json({ error: "forbidden — requer operacoes.retroativo" }, { status: 403 });
    }
    const auth = { user: session };
  ```
  Leave the GET handler alone — it just uses `requireAuth` (any logged-in user), which is fine for a read.

- [ ] **Step 15a.4:** Re-run test. Expected: PASS.

- [ ] **Step 15a.5:** Commit:
  ```bash
  git add src/app/api/wms/lancamento-retroativo/route.ts scripts/wms/cenarios/auth/15a-retroativo-criar.ts
  git commit -m "$(cat <<'EOF'
  feat(api): lancamento-retroativo POST requires operacoes.retroativo (finding 8.9)

  Was using requireWarehouseAccess (any warehouse perm). Now requires the
  dedicated perm created in Task 4. GET stays on requireAuth (read-only).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 15b: Endpoint `POST /api/wms/lancamento-retroativo/[id]/reconciliar` (finding 8.9)

**Files:**
- Test: `scripts/wms/cenarios/auth/15b-retroativo-reconciliar.ts` (new)
- Implementation: `src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts` (swap to granular perm)

- [ ] **Step 15b.1:** Create test `scripts/wms/cenarios/auth/15b-retroativo-reconciliar.ts`:
  ```ts
  import "dotenv/config";
  import { runAuthMatrix, printAuthMatrixReport } from "./runner";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";
  const FAKE = "00000000-0000-0000-0000-000000000000";

  async function main() {
    const results = await runAuthMatrix({
      baseUrl,
      tests: [{
        name: "POST retroativo/reconciliar requires operacoes.retroativo",
        method: "POST",
        path: `/api/wms/lancamento-retroativo/${FAKE}/reconciliar`,
        body: { compra_mov_id: FAKE },
        cases: [
          { label: "no session", user: null,            expectedStatus: 401 },
          { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
          { label: "comprador",  user: "buyer-runner",  expectedStatus: 403 },
          // operador + admin → perm gate passa; fake ids → 400 (rpc rejeita).
          { label: "operador (passa; ids fake)", user: "op-runner",     expectedStatus: 400 },
          { label: "admin (passa; ids fake)",    user: "admin-runner",  expectedStatus: 400 },
        ],
      }],
    });
    const ok = printAuthMatrixReport(results);
    process.exit(ok ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```

- [ ] **Step 15b.2:** Run test. Expect FAIL.

- [ ] **Step 15b.3:** Edit `src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts`. Replace import line 2:
  ```ts
  import { requireWarehouseAccess } from "@/lib/wms/auth";
  ```
  with:
  ```ts
  import { getSessionUser } from "@/lib/session";
  import { userCan } from "@/lib/permissions";
  ```
  Find lines 10-11:
  ```ts
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;
  ```
  Replace with:
  ```ts
    // Auth + perm granular (finding 8.9)
    const session = await getSessionUser(req);
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!userCan(session, "operacoes.retroativo")) {
      return NextResponse.json({ error: "forbidden — requer operacoes.retroativo" }, { status: 403 });
    }
    const auth = { user: session };
  ```

- [ ] **Step 15b.4:** Re-run test. Expect PASS.

- [ ] **Step 15b.5:** Commit:
  ```bash
  git add src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts scripts/wms/cenarios/auth/15b-retroativo-reconciliar.ts
  git commit -m "$(cat <<'EOF'
  feat(api): retroativo/reconciliar requires operacoes.retroativo (finding 8.9)

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 16: Endpoint `PATCH /api/wms/vendas/[id]/vendedor` — target cargo validation (finding 7.4)

**Files:**
- Test: `scripts/wms/cenarios/auth/16-vendas-vendedor-target.ts` (new)
- Implementation: `src/app/api/wms/vendas/[id]/vendedor/route.ts` (extend body validation block at lines 62-72)

Per spec deliverable 5 and finding 7.4, when admin/operador attempts to reassign vendedor to user X, the server must verify X has cargo `vendedor` or `operador*` (via `siso_usuario_roles` JOIN). Today the only check is that the user exists at all.

- [ ] **Step 16.1:** Create test `scripts/wms/cenarios/auth/16-vendas-vendedor-target.ts`:
  ```ts
  import "dotenv/config";
  import { createServiceClient } from "../../../src/lib/supabase-server";
  import { loginTestUser } from "../_harness/seed-test-users";

  const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

  async function patch(path: string, body: unknown, sessionId: string) {
    const r = await fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  }

  async function main() {
    const sb = createServiceClient();
    const adminSid = await loginTestUser({ baseUrl, nome: "admin-runner" });

    // Setup: criar pedido manual sem vendedor
    const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
    const pedidoFakeId = `auth-target-${Date.now()}`;
    await sb.from("siso_pedidos").insert({
      id: pedidoFakeId,
      numero: pedidoFakeId,
      empresa_origem_id: (emp as { id: string }).id,
      cliente_nome: "Auth Test",
      origem_pedido: "manual",
      status: "concluido",
      data: new Date().toISOString().slice(0, 10),
      processado_em: new Date().toISOString(),
      criado_em: new Date().toISOString(),
    });

    // IDs dos test users seeded
    const { data: vendor } = await sb.from("siso_usuarios").select("id").eq("nome", "vendor-runner").single();
    const { data: comprador } = await sb.from("siso_usuarios").select("id").eq("nome", "buyer-runner").single();
    const { data: admin } = await sb.from("siso_usuarios").select("id").eq("nome", "admin-runner").single();
    const vendorId = (vendor as { id: string }).id;
    const compradorId = (comprador as { id: string }).id;
    const adminId = (admin as { id: string }).id;

    let failures = 0;

    // Case 1: target = vendor (has cargo vendedor) → 200
    {
      const r = await patch(`/api/wms/vendas/${pedidoFakeId}/vendedor`, { vendedor_id: vendorId }, adminSid);
      const ok = r.status === 200;
      console.log(`[${ok ? "PASS" : "FAIL"}] target vendedor → ${r.status} (expected 200)`);
      if (!ok) failures++;
    }

    // Case 2: target = comprador (no vendedor/operador role) → 400
    {
      const r = await patch(`/api/wms/vendas/${pedidoFakeId}/vendedor`, { vendedor_id: compradorId }, adminSid);
      const ok = r.status === 400;
      console.log(`[${ok ? "PASS" : "FAIL"}] target comprador → ${r.status} (expected 400; comprador não tem cargo vendedor/operador)`);
      if (!ok) failures++;
    }

    // Case 3: target = admin (admin role doesn't have vendedor/operador*; we
    // still allow because admin sometimes acts as vendedor; documenting:
    // admin should be valid). We accept either 200 OR 400 — this case is
    // about documenting intent, not strict assertion. Default: 200 if admin
    // is whitelisted, 400 if strict.
    //
    // Decision: admin IS whitelisted (it's effectively a super-role). Expect 200.
    {
      const r = await patch(`/api/wms/vendas/${pedidoFakeId}/vendedor`, { vendedor_id: adminId }, adminSid);
      const ok = r.status === 200;
      console.log(`[${ok ? "PASS" : "FAIL"}] target admin → ${r.status} (expected 200; admin é super-role)`);
      if (!ok) failures++;
    }

    // Case 4: target = null (desatribuir) → 200
    {
      const r = await patch(`/api/wms/vendas/${pedidoFakeId}/vendedor`, { vendedor_id: null }, adminSid);
      const ok = r.status === 200;
      console.log(`[${ok ? "PASS" : "FAIL"}] target null → ${r.status} (expected 200)`);
      if (!ok) failures++;
    }

    // Cleanup
    await sb.from("siso_pedidos").delete().eq("id", pedidoFakeId);

    if (failures) process.exit(1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```

- [ ] **Step 16.2:** Run test. Expected: case 2 FAILS (comprador today gets 200).

- [ ] **Step 16.3:** Edit `src/app/api/wms/vendas/[id]/vendedor/route.ts`. Find lines 60-73:
  ```ts
    // Resolve nome do novo vendedor
    let novoNome: string | null = null;
    if (body.vendedor_id) {
      const { data: u } = await supabase
        .from("siso_usuarios")
        .select("id, nome")
        .eq("id", body.vendedor_id)
        .maybeSingle();
      if (!u) {
        return NextResponse.json({ erro: "vendedor_id inválido" }, { status: 400 });
      }
      novoNome = u.nome;
    }
  ```
  Replace with:
  ```ts
    // Resolve nome do novo vendedor + valida cargo (finding 7.4)
    // Target precisa ter role vendedor OR operador* OR admin. Comprador NÃO
    // pode receber atribuição (não faz sentido — comprador não faz pedidos
    // de cliente).
    let novoNome: string | null = null;
    if (body.vendedor_id) {
      const { data: u } = await supabase
        .from("siso_usuarios")
        .select("id, nome, siso_usuario_roles(siso_roles(codigo))")
        .eq("id", body.vendedor_id)
        .maybeSingle();
      if (!u) {
        return NextResponse.json({ erro: "vendedor_id inválido" }, { status: 400 });
      }
      // Extract role codes from nested join shape
      const targetRoleCodes = ((u as unknown as {
        siso_usuario_roles: Array<{ siso_roles: { codigo: string } | null }>;
      }).siso_usuario_roles ?? [])
        .map((r) => r.siso_roles?.codigo)
        .filter((c): c is string => !!c);
      const allowedTarget = targetRoleCodes.some((c) =>
        c === "vendedor" || c === "admin" || c === "operador" || c === "operador_cwb" || c === "operador_sp",
      );
      if (!allowedTarget) {
        return NextResponse.json(
          {
            erro: `vendedor_id alvo não tem cargo vendedor/operador/admin (roles: ${targetRoleCodes.join(",") || "nenhuma"})`,
          },
          { status: 400 },
        );
      }
      novoNome = (u as { nome: string }).nome;
    }
  ```

- [ ] **Step 16.4:** Re-run test. Expected: all 4 cases PASS.

- [ ] **Step 16.5:** Commit:
  ```bash
  git add src/app/api/wms/vendas/[id]/vendedor/route.ts scripts/wms/cenarios/auth/16-vendas-vendedor-target.ts
  git commit -m "$(cat <<'EOF'
  fix(api): vendas/[id]/vendedor validates target cargo (finding 7.4)

  PATCH used to accept any usuario_id existing in DB. Now requires target
  to have one of vendedor/operador*/admin roles via siso_usuario_roles
  JOIN. Prevents accidental assignment to comprador or other custom roles.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Migration + hook tasks

### Task 17: Formalize `siso_pedido_observacoes` table via migration (finding 1.13)

**Files:** `supabase/migrations/20260527_siso_pedido_observacoes_formal.sql` (new)

The table currently exists in prod (created via direct SQL); the migration is missing. We create it `IF NOT EXISTS` so it's a no-op on existing DBs and reproducible on fresh ones.

- [ ] **Step 17.1:** Discover the existing prod schema via `mcp__supabase__execute_sql` (project `ehbxpbeijofxtsbezwxd`):
  ```sql
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name = 'siso_pedido_observacoes'
  ORDER BY ordinal_position;
  ```
  Record the columns (expected: `id uuid PK default gen_random_uuid()`, `pedido_id text NOT NULL`, `usuario_id uuid NOT NULL`, `usuario_nome text NOT NULL`, `texto text NOT NULL`, `criado_em timestamptz NOT NULL default now()`).

- [ ] **Step 17.2:** Verify indexes:
  ```sql
  SELECT indexname, indexdef FROM pg_indexes
  WHERE tablename = 'siso_pedido_observacoes';
  ```

- [ ] **Step 17.3:** Create `supabase/migrations/20260527_siso_pedido_observacoes_formal.sql`. Use `IF NOT EXISTS` so the migration is idempotent against existing prod schema:
  ```sql
  -- Finding 1.13: siso_pedido_observacoes existia em prod via SQL direto.
  -- Formalizamos com CREATE TABLE IF NOT EXISTS. Schema espelha o que já
  -- está em staging (project_id ehbxpbeijofxtsbezwxd). Idempotente.

  CREATE TABLE IF NOT EXISTS siso_pedido_observacoes (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id    text        NOT NULL REFERENCES siso_pedidos(id) ON DELETE CASCADE,
    usuario_id   uuid        NOT NULL REFERENCES siso_usuarios(id) ON DELETE RESTRICT,
    usuario_nome text        NOT NULL,
    texto        text        NOT NULL,
    criado_em    timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS siso_pedido_observacoes_pedido_idx
    ON siso_pedido_observacoes (pedido_id, criado_em);

  CREATE INDEX IF NOT EXISTS siso_pedido_observacoes_usuario_idx
    ON siso_pedido_observacoes (usuario_id);

  -- Comment para futuras gerações de docs
  COMMENT ON TABLE siso_pedido_observacoes IS
    'Comentários livres por pedido (formalizado via migration 20260527 — finding 1.13)';
  ```
  > **CRITICAL:** If the discovery in Step 17.1 reveals different columns or types (e.g., `pedido_id uuid` instead of `text`), adjust the migration to match exactly. The point is to never destructively change existing data — `IF NOT EXISTS` skips the CREATE entirely on prod.

- [ ] **Step 17.4:** Apply via `mcp__supabase__apply_migration`:
  - `name`: `20260527_siso_pedido_observacoes_formal`
  - `query`: contents of the file.

- [ ] **Step 17.5:** Verify migration record:
  ```sql
  SELECT version, name FROM supabase_migrations.schema_migrations
  WHERE name = '20260527_siso_pedido_observacoes_formal';
  ```
  Expected: 1 row.

- [ ] **Step 17.6:** Verify table is unchanged structurally:
  ```sql
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'siso_pedido_observacoes'
  ORDER BY ordinal_position;
  ```
  Expected: identical to Step 17.1 output (no destructive change).

- [ ] **Step 17.7:** Commit:
  ```bash
  git add supabase/migrations/20260527_siso_pedido_observacoes_formal.sql
  git commit -m "$(cat <<'EOF'
  migration: formalize siso_pedido_observacoes table (finding 1.13)

  Table was created via direct SQL — no migration existed. Adds idempotent
  CREATE TABLE IF NOT EXISTS so fresh environments can recreate it.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 18: Add server-side galpão filter to dashboard realtime hook (finding 1.14)

**Files:** `src/hooks/use-dashboard-tarefas-realtime.ts` (edit channels at lines 30-95)

The hook subscribes to 5 tables without `filter: 'galpao_id=eq.X'`. When galpão filter is active, the hook still receives events for ALL galpões. We add server-side filter per channel — only when `galpaoId` is non-null.

> Note: not all 5 tables have `galpao_id` directly. We need to check:
> - `siso_pedidos` — yes (`separacao_galpao_id`)
> - `siso_wms_pendencias_guarda` — yes (`galpao_id`)
> - `siso_inventario_sessoes` — yes (`galpao_id`)
> - `siso_inventario_operadores` — NO direct galpao_id (linked via sessao_id) — skip filter, accept over-fetch
> - `siso_pedido_itens` — NO direct galpao_id (linked via pedido_id) — skip filter

- [ ] **Step 18.1:** Verify column names via `mcp__supabase__execute_sql`:
  ```sql
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_name IN ('siso_pedidos', 'siso_wms_pendencias_guarda', 'siso_inventario_sessoes')
    AND column_name LIKE '%galpao%'
  ORDER BY table_name, column_name;
  ```
  Expected rows: `siso_pedidos.separacao_galpao_id`, `siso_wms_pendencias_guarda.galpao_id`, `siso_inventario_sessoes.galpao_id`.

- [ ] **Step 18.2:** Replace the body of `useDashboardTarefasRealtime` in `src/hooks/use-dashboard-tarefas-realtime.ts` with:
  ```ts
    useEffect(() => {
      const invalidate = () => {
        queryClient.invalidateQueries({
          queryKey: ["wms-tarefas-pendentes", galpaoId],
        });
      };

      const suffix = galpaoId ?? "all";

      // Server-side filter: only when galpaoId is set AND the table has a
      // direct galpao column (finding 1.14). siso_pedido_itens and
      // siso_inventario_operadores are linked via fk and can't filter
      // server-side without a denormalization — they fall back to global
      // subscribe + client-side invalidate (no data leak; pure perf).
      const pedidosFilter = galpaoId
        ? { event: "*" as const, schema: "public", table: "siso_pedidos", filter: `separacao_galpao_id=eq.${galpaoId}` }
        : { event: "*" as const, schema: "public", table: "siso_pedidos" };

      const guardaFilter = galpaoId
        ? { event: "*" as const, schema: "public", table: "siso_wms_pendencias_guarda", filter: `galpao_id=eq.${galpaoId}` }
        : { event: "*" as const, schema: "public", table: "siso_wms_pendencias_guarda" };

      const sessaoFilter = galpaoId
        ? { event: "*" as const, schema: "public", table: "siso_inventario_sessoes", filter: `galpao_id=eq.${galpaoId}` }
        : { event: "*" as const, schema: "public", table: "siso_inventario_sessoes" };

      const ch1 = supabase
        .channel(`dt-pedidos-${suffix}`)
        .on("postgres_changes", pedidosFilter, invalidate)
        .subscribe();

      const ch2 = supabase
        .channel(`dt-guarda-${suffix}`)
        .on("postgres_changes", guardaFilter, invalidate)
        .subscribe();

      const ch3 = supabase
        .channel(`dt-inv-sess-${suffix}`)
        .on("postgres_changes", sessaoFilter, invalidate)
        .subscribe();

      // Operadores e itens — sem filtro (linked via FK)
      const ch4 = supabase
        .channel(`dt-inv-op-${suffix}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "siso_inventario_operadores" },
          invalidate,
        )
        .subscribe();

      const ch5 = supabase
        .channel(`dt-pedido-itens-${suffix}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "siso_pedido_itens" },
          invalidate,
        )
        .subscribe();

      channelsRef.current = [ch1, ch2, ch3, ch4, ch5];

      return () => {
        for (const ch of channelsRef.current) {
          supabase.removeChannel(ch);
        }
        channelsRef.current = [];
      };
    }, [galpaoId, queryClient]);
  ```

- [ ] **Step 18.3:** Type-check:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  npx tsc --noEmit
  ```
  Expected: zero errors.

- [ ] **Step 18.4:** Manual smoke (no automatable test for realtime filter — verify in browser): open `/wms` on staging with galpão CWB selected, then via SQL update a `siso_pedidos` row with `separacao_galpao_id = <SP-galpao-id>`. The home should NOT invalidate. Then update a CWB row — invalidate should fire. Document the observation in the commit message.

- [ ] **Step 18.5:** Commit:
  ```bash
  git add src/hooks/use-dashboard-tarefas-realtime.ts
  git commit -m "$(cat <<'EOF'
  perf(realtime): server-side galpao filter on dashboard hook (finding 1.14)

  3 of 5 channels now use postgres_changes filter when galpaoId is set:
   - siso_pedidos: separacao_galpao_id=eq.X
   - siso_wms_pendencias_guarda: galpao_id=eq.X
   - siso_inventario_sessoes: galpao_id=eq.X
  Other 2 (operadores, pedido_itens) stay unfiltered (no direct galpao
  column; cost is acceptable invalidation noise, not data leak).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Cross-endpoint verification + final wrap-up

### Task 19: Build the full cargo × endpoint smoke matrix script

**Files:** `scripts/wms/cenarios/auth/run-all-auth.ts` (new)

This script runs all 13 per-endpoint tests + outputs a one-table summary. Used as final P4 verification gate.

- [ ] **Step 19.1:** Create `scripts/wms/cenarios/auth/run-all-auth.ts`:
  ```ts
  import "dotenv/config";
  import { readdir } from "fs/promises";
  import { join, resolve, dirname } from "path";
  import { fileURLToPath } from "url";
  import { spawn } from "child_process";

  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Match files like NN-...ts but exclude runner.ts and this file.
  function isAuthCenario(name: string): boolean {
    if (!name.endsWith(".ts")) return false;
    if (name === "runner.ts" || name === "run-all-auth.ts") return false;
    return /^\d+[a-z]?-/.test(name);
  }

  async function runOne(file: string): Promise<{ file: string; code: number; output: string }> {
    return new Promise((resolveP) => {
      let buf = "";
      const child = spawn("npx", ["tsx", file], { cwd: process.cwd(), env: process.env });
      child.stdout?.on("data", (c) => { buf += c.toString(); });
      child.stderr?.on("data", (c) => { buf += c.toString(); });
      child.on("exit", (code) => {
        resolveP({ file, code: code ?? 1, output: buf });
      });
    });
  }

  async function main() {
    const dir = __dirname;
    const entries = (await readdir(dir)).filter(isAuthCenario).sort();
    if (entries.length === 0) {
      console.error("Nenhum cenário de auth encontrado.");
      process.exit(2);
    }
    console.log(`Executando ${entries.length} cenários de auth...\n`);
    const results: Array<{ file: string; code: number; output: string }> = [];
    for (const e of entries) {
      const full = resolve(dir, e);
      const r = await runOne(full);
      results.push(r);
      const tag = r.code === 0 ? "PASS" : "FAIL";
      console.log(`[${tag}] ${e}`);
      if (r.code !== 0) {
        console.log(r.output.split("\n").map((l) => `    ${l}`).join("\n"));
      }
    }
    const failed = results.filter((r) => r.code !== 0);
    console.log(`\nResumo: ${results.length - failed.length}/${results.length} cenários passaram.`);
    process.exit(failed.length === 0 ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(2); });
  ```

- [ ] **Step 19.2:** Add an npm script for ease:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  # Edit package.json — add to "scripts":
  #   "auth-matrix": "tsx scripts/wms/cenarios/auth/run-all-auth.ts"
  ```
  Use Edit tool to insert the line in the `scripts` block. The exact insertion:

  Find in `package.json`:
  ```json
      "scenarios": "tsx scripts/wms/cenarios/run-all.ts",
  ```
  Append after it (same indentation):
  ```json
      "auth-matrix": "tsx scripts/wms/cenarios/auth/run-all-auth.ts",
  ```

- [ ] **Step 19.3:** Run the full matrix against the dev server:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  # In one shell:
  npm run dev
  # In another shell:
  npm run auth-matrix
  ```
  Expected: 13 scenarios pass (06, 07, 08, 09, 10, 11, 12, 13, 14, 15a, 15b, 16 — plus any others added). If any fails, debug that specific finding.

- [ ] **Step 19.4:** Commit:
  ```bash
  git add scripts/wms/cenarios/auth/run-all-auth.ts package.json
  git commit -m "$(cat <<'EOF'
  test(p4): add npm run auth-matrix to run all 13 auth cenários

  Final gate for P4 — verifies the full cargo × endpoint matrix in one
  command. Used in §8.5 critérios de pronto.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 20: Update CLAUDE.md role table to reflect new perms

**Files:** `CLAUDE.md` (edit "Roles & Permissões (dinâmico)" section)

Document the 2 new perms in the project-level instructions.

- [ ] **Step 20.1:** Find in `CLAUDE.md` the bullet that lists default `operador` perms (around line 425):
  ```md
  - `operador` — vendas (exceto criar), separação, compras.ver, estoque, cobertura, operações, inventário ver/executar, insights.ver, relatórios, cadastros
  ```
  Update to:
  ```md
  - `operador` — vendas (exceto criar), separação, compras.ver, estoque, cobertura, operações (incl. devolucoes_classificar, retroativo), inventário ver/executar, insights.ver, relatórios, cadastros
  ```

- [ ] **Step 20.2:** Find the bullet that documents `vendedor`:
  ```md
  - `vendedor` — vendas.ver, vendas.criar
  ```
  Leave unchanged — vendedor explicitly does NOT get the 2 new perms (already enforced in migration in Task 4).

- [ ] **Step 20.3:** Add a one-line callout at the end of the "Roles & Permissões" section noting the registry now has 33 perms (was 31):
  ```md
  > **Updated 2026-05-27 (P4):** Permissions registry now has 33 perms in 8 modules (added `operacoes.devolucoes_classificar` and `operacoes.retroativo` to split granular write actions from `requireWarehouseAccess` umbrella).
  ```

- [ ] **Step 20.4:** Commit:
  ```bash
  git add CLAUDE.md
  git commit -m "$(cat <<'EOF'
  docs(claude): document 2 new perms added in P4

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 21: Add P4 entries to error knowledge base

**Files:** `erros-conhecidos.yaml` (append)

Per CLAUDE.md "Error Knowledge Base" convention, every fix gets a yaml entry. We add one entry per finding fixed (13 endpoints + 1 hook + 1 migration = ~15 entries). Use a single batch entry per closely-related cluster to keep it concise.

- [ ] **Step 21.1:** Read the current `erros-conhecidos.yaml`:
  ```bash
  cat /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4/erros-conhecidos.yaml | tail -30
  ```
  Note the latest entry's `id` to continue numbering.

- [ ] **Step 21.2:** Append (use Edit tool — find the last `- id:` block and add new entries after it). Template:
  ```yaml
  - id: <next-numeric-id>
    date: 2026-05-27
    source: api.wms.pedidos
    category: auth
    message: "Backend não validava perm (vários endpoints WMS pós-cutover)"
    cause: |
      Spec §8 (P4) — 13 endpoints confiavam apenas em UI gating
      (usePermissoes() no frontend) sem chamar userCan no backend.
      Bypass trivial via curl/Postman: vendedor podia ver pedidos de outro
      vendedor, comprador podia aprovar pedidos, etc.
    fix: |
      Inseridos getSessionUser + userCan no topo de cada handler. Para
      retroativo + devoluções, criadas 2 perms granulares novas
      (operacoes.retroativo, operacoes.devolucoes_classificar) seedadas
      em admin + operador*. webhook/reprocessar virou admin-only com Zod
      body e processa apenas o pedidoId enviado.
    files:
      - src/lib/permissions.ts
      - src/lib/wms/auth.ts
      - src/app/api/wms/pedidos/route.ts
      - src/app/api/wms/pedidos/aprovar/route.ts
      - src/app/api/wms/pedidos/[id]/historico/route.ts
      - src/app/api/wms/pedidos/[id]/observacoes/route.ts
      - src/app/api/wms/webhook/reprocessar/route.ts
      - src/app/api/wms/vendas/criar/route.ts
      - src/app/api/wms/vendas/[id]/route.ts
      - src/app/api/wms/vendas/[id]/vendedor/route.ts
      - src/app/api/wms/inventario/metricas/route.ts
      - src/app/api/wms/devolucoes/[id]/classificar/route.ts
      - src/app/api/wms/lancamento-retroativo/route.ts
      - src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts
      - src/hooks/use-dashboard-tarefas-realtime.ts
      - supabase/migrations/20260527_p4_new_permissions.sql
      - supabase/migrations/20260527_siso_pedido_observacoes_formal.sql
    tags:
      - auth
      - rbac
      - userCan
      - permissions
      - p4
      - wms-fix
      - cutover
  ```

- [ ] **Step 21.3:** Commit:
  ```bash
  git add erros-conhecidos.yaml
  git commit -m "$(cat <<'EOF'
  docs(errors): record P4 auth backend gating cluster

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 22: Final verification — run all critérios de pronto from spec §8.5

**Files:** none (verification + final commit)

- [ ] **Step 22.1:** `curl /api/wms/vendas/criar` without cookie → 401:
  ```bash
  curl -i -X POST http://localhost:3001/api/wms/vendas/criar \
       -H "Content-Type: application/json" -d '{}'
  ```
  Expected: `HTTP/1.1 401`.

- [ ] **Step 22.2:** Same endpoint with operador (no `vendas.criar`) → 403:
  ```bash
  # Get session
  SID=$(curl -s -X POST http://localhost:3001/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"nome":"op-runner","pin":"1002"}' | jq -r .sessionId)
  curl -i -X POST http://localhost:3001/api/wms/vendas/criar \
       -H "Content-Type: application/json" \
       -H "X-Session-Id: $SID" \
       -d '{"items":[]}'
  ```
  Expected: `HTTP/1.1 403`.

- [ ] **Step 22.3:** `webhook/reprocessar` rejects empty body:
  ```bash
  SID=$(curl -s -X POST http://localhost:3001/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"nome":"admin-runner","pin":"1001"}' | jq -r .sessionId)
  curl -i -X POST http://localhost:3001/api/wms/webhook/reprocessar \
       -H "Content-Type: application/json" \
       -H "X-Session-Id: $SID" \
       -d '{}'
  ```
  Expected: `HTTP/1.1 400` and body mentions `pedidoId obrigatório`.

- [ ] **Step 22.4:** Vendedor V1 cannot access V2's pedido detail (re-run Task 13 test):
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  npx tsx scripts/wms/cenarios/auth/13-vendas-detalhe-ownership.ts
  ```
  Expected: exit 0.

- [ ] **Step 22.5:** Verify `SELECT * FROM siso_pedido_observacoes LIMIT 1;` works (table still exists, no destructive change):
  ```sql
  SELECT count(*) FROM siso_pedido_observacoes;
  ```
  Expected: a row count (likely 0 in fresh staging, or N from prior runs).

- [ ] **Step 22.6:** Run the full matrix and confirm 13/13 pass:
  ```bash
  npm run auth-matrix
  ```
  Expected: `Resumo: N/N cenários passaram.` (where N ≥ 13).

- [ ] **Step 22.7:** Also run the full WMS scenarios suite to verify P4 didn't break existing flows:
  ```bash
  npm run scenarios
  ```
  Expected: no regressions vs baseline (same pass count as before P4 branch).

- [ ] **Step 22.8:** Final commit (if any leftover changes):
  ```bash
  git status
  # If clean, no commit needed. Otherwise:
  git add -A && git commit -m "$(cat <<'EOF'
  test(p4): final verification — all critérios §8.5 confirmed

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 22.9:** Push branch:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  git push -u origin wms-fix-p4
  ```

---

## Merge gate (after P2 mergeado)

> **DO NOT MERGE P4 BEFORE P2.** Per spec §11 paralelização note, P2 edits handler bodies and P4 edits handler tops — both touch `vendas/criar`, `aprovar`, `compras/receber`, `webhook/reprocessar` (P4 rewrites), and observações. Rebasing P4 onto P2 is trivial because the changes don't textually overlap (P4 inserts before line 30, P2 modifies after line 50+), but if P4 lands first, P2's rebase becomes nontrivial.

### Task 23: Rebase onto develop (post-P2 merge)

- [ ] **Step 23.1:** Wait for P2 merge confirmation. Then:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p4
  git fetch origin
  git rebase origin/develop
  ```

- [ ] **Step 23.2:** If conflicts arise (almost certainly in `vendas/criar`, `aprovar`, `webhook/reprocessar`):
  - Resolve by keeping BOTH the new perm check at the top (P4) AND the body changes from P2.
  - For `webhook/reprocessar`: P4 rewrote it fully, so P2 edits to that file (if any) need to be re-applied INSIDE the new structure.
  - Run `npm run auth-matrix` + `npm run scenarios` after each conflict resolution.

- [ ] **Step 23.3:** Force-push the rebased branch:
  ```bash
  git push --force-with-lease origin wms-fix-p4
  ```
  (`--force-with-lease` is safer than `--force` — fails if remote was updated unexpectedly.)

- [ ] **Step 23.4:** Open PR via `gh pr create`:
  ```bash
  gh pr create --title "wms-fix p4: auth + permissões granulares (13 endpoints)" --body "$(cat <<'EOF'
  ## Summary
  - Adds backend permission checks to 13 WMS endpoints (PR-4 restored)
  - Creates 2 granular perms (`operacoes.devolucoes_classificar`, `operacoes.retroativo`)
  - Rewrites `webhook/reprocessar` to require admin + Zod body + targeted pedidoId processing
  - Adds vendedor ownership check to `GET /vendas/[id]`
  - Adds target-cargo validation to `PATCH /vendas/[id]/vendedor`
  - Adds server-side galpão filter to dashboard realtime hook
  - Formalizes `siso_pedido_observacoes` table via migration
  - 13 fetch-based integration tests; one-command `npm run auth-matrix`

  ## Test plan
  - [ ] `npm run auth-matrix` — 13/13 cenários passam
  - [ ] `npm run scenarios` — sem regressões vs baseline pré-P4
  - [ ] Smoke: curl `/api/wms/vendas/criar` sem session → 401
  - [ ] Smoke: curl `/api/wms/vendas/criar` com operador → 403
  - [ ] Smoke: curl `/api/wms/webhook/reprocessar` admin + body vazio → 400
  - [ ] Vendedor V1 não vê pedido de V2 (cenário 13)
  - [ ] `SELECT count(*) FROM siso_pedido_observacoes` ainda funciona após migration
  - [ ] PATCH `vendedor` com target=comprador → 400

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

- [ ] **Step 23.5:** Wait for review + CI green, then merge via squash. Comment on merge: "rebase clean — P2 conflicts resolved" if applicable.

---

## Appendix A — Files touched (full list)

```
src/lib/permissions.ts                                              (+ 2 perms)
src/hooks/use-dashboard-tarefas-realtime.ts                         (server filter)

src/app/api/wms/pedidos/route.ts                                    (GET auth)
src/app/api/wms/pedidos/aprovar/route.ts                            (POST auth)
src/app/api/wms/pedidos/[id]/historico/route.ts                     (GET auth)
src/app/api/wms/pedidos/[id]/observacoes/route.ts                   (GET+POST auth + impersonation fix)
src/app/api/wms/webhook/reprocessar/route.ts                        (full rewrite: admin + Zod + targeted)
src/app/api/wms/vendas/criar/route.ts                               (POST auth)
src/app/api/wms/vendas/[id]/route.ts                                (GET ownership)
src/app/api/wms/vendas/[id]/vendedor/route.ts                       (PATCH target cargo)
src/app/api/wms/inventario/metricas/route.ts                        (GET requireWarehouseAccess)
src/app/api/wms/devolucoes/[id]/classificar/route.ts                (POST granular perm)
src/app/api/wms/lancamento-retroativo/route.ts                      (POST granular perm)
src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts     (POST granular perm)

supabase/migrations/20260527_p4_new_permissions.sql                 (seed 2 perms)
supabase/migrations/20260527_siso_pedido_observacoes_formal.sql     (formalize table)

scripts/wms/cenarios/_harness/seed.ts                               (call seedTestUsers)
scripts/wms/cenarios/_harness/seed-test-users.ts                    (new — 4 test users)
scripts/wms/cenarios/auth/runner.ts                                 (new — matrix runner)
scripts/wms/cenarios/auth/README.md                                 (new)
scripts/wms/cenarios/auth/06-pedidos-list.ts                        (new)
scripts/wms/cenarios/auth/07-pedido-historico.ts                    (new)
scripts/wms/cenarios/auth/08-webhook-reprocessar.ts                 (new)
scripts/wms/cenarios/auth/09-observacoes.ts                         (new)
scripts/wms/cenarios/auth/10-aprovar.ts                             (new)
scripts/wms/cenarios/auth/11-inventario-metricas.ts                 (new)
scripts/wms/cenarios/auth/12-vendas-criar.ts                        (new)
scripts/wms/cenarios/auth/13-vendas-detalhe-ownership.ts            (new)
scripts/wms/cenarios/auth/14-devolucoes-classificar.ts              (new)
scripts/wms/cenarios/auth/15a-retroativo-criar.ts                   (new)
scripts/wms/cenarios/auth/15b-retroativo-reconciliar.ts             (new)
scripts/wms/cenarios/auth/16-vendas-vendedor-target.ts              (new)
scripts/wms/cenarios/auth/run-all-auth.ts                           (new)

package.json                                                        (+ "auth-matrix" script)
CLAUDE.md                                                           (role table updated)
erros-conhecidos.yaml                                               (+ P4 cluster entry)
```

---

## Appendix B — Decision log (re: spec deliverable 2)

**Q:** Should `vendas.editar_vendedor` be a new perm?

**A:** NO — reuse existing checks. The endpoint `PATCH /vendas/[id]/vendedor` already gates on:
- `sistema.usuarios` (admin)
- `separacao.executar` (operador*)
- `vendedor_id === user.id` (ownership)

Adding a 4th perm would explode the admin matrix and not solve any reported issue. The actual finding (7.4) is about validating the **target** user has cargo vendedor/operador — which we do in Task 16 via body validation, not a perm.

**Q:** Should `requireWarehouseAccess` be updated to include the 2 new perms?

**A:** Adding `operacoes.devolucoes_classificar` and `operacoes.retroativo` to the whitelist in `auth.ts` is **optional** — currently all roles that get the new perms (admin + operador*) also have existing perms in the whitelist. Adding them is defensive and improves future custom-role flexibility. We DO add them to keep the umbrella semantically complete:

```ts
// src/lib/wms/auth.ts — add to userCanAny list (Task 4.x or post-rebase)
"operacoes.devolucoes_classificar",
"operacoes.retroativo",
```

This is **NOT a required step** for P4 to ship; documented here as a follow-up consideration for future custom roles.

---

## Appendix C — Cargo × endpoint matrix (cheat sheet)

After P4, the matrix is:

| Endpoint | admin | operador* | comprador | vendedor | anônimo |
|---|---|---|---|---|---|
| `GET /pedidos` | 200 | 200 | 200 | 403 | 401 |
| `GET /pedidos/[id]/historico` | 200 | 200 | 200 | 403 | 401 |
| `GET /pedidos/[id]/observacoes` | 200 | 200 | 200 | 403 | 401 |
| `POST /pedidos/[id]/observacoes` | 200 | 200 | 200 | 403 | 401 |
| `POST /pedidos/aprovar` | 200 | 200 | 403 | 403 | 401 |
| `POST /webhook/reprocessar` | 200 | 403 | 403 | 403 | 401 |
| `POST /vendas/criar` | 200 | 403 | 403 | 200 | 401 |
| `GET /vendas/[id]` (venda direta) | 200 | 200 | 200 | 200 (próprio) / 403 (outro) | 401 |
| `GET /vendas/[id]` (marketplace) | 200 | 200 | 200 | 403 | 401 |
| `PATCH /vendas/[id]/vendedor` | 200 | 200 | 403 | 200 (próprio) / 403 (outro) | 401 |
| `GET /inventario/metricas` | 200 | 200 | 403 | 403 | 401 |
| `POST /devolucoes/[id]/classificar` | 200 | 200 | 403 | 403 | 401 |
| `POST /lancamento-retroativo` | 200 | 200 | 403 | 403 | 401 |
| `POST /lancamento-retroativo/[id]/reconciliar` | 200 | 200 | 403 | 403 | 401 |

(`operador*` = `operador`, `operador_cwb`, `operador_sp` — all identical in perms.)

---
