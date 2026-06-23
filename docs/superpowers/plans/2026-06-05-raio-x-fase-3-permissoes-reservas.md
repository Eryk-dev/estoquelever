# Raio-X Fase 3 — Permissões Backend + Wiring de Liberação de Reserva no Cancelamento Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal:** Fechar 10 falhas confirmadas (raio-x re-investigado contra HEAD `de205f2`) em duas classes: (1) **guards de permissão backend** — rotas que hoje aceitam qualquer logado/qualquer perm de armazém passam a exigir a permissão específica da ação, e o último admin não pode se auto-desativar (anti-lockout); (2) **wiring de liberação de reserva** — todo caminho de cancelamento (recusar pedido, cancelar item/pedido de compra, estornar pedido, cancelar separação parcial) libera a reserva `R` viva no ato (não espera TTL/cron) e cancela o job na fila, mais reserva all-or-nothing + dedup idempotente no webhook de auto-aprovação.

**Architecture:** Next.js 16 App Router (`/api/wms/**/route.ts`) + Supabase service-role. Estoque é um ledger imutável (`siso_movimentacoes`, tipos `E/S/R/L`) com cache materializado `siso_estoque` (`disponivel = saldo - reservado`). Reservas são movs `tipo='R'` com `origem_tipo='reserva_pedido'`, `origem_id=pedido_id` (text). Liberar uma reserva = inserir mov `tipo='L'` com `estorno_de=R.id` (idempotente, first-writer-wins). Os helpers já existem: `estornarReservaIndividual` (por-R, idempotente), `liberarReserva` (por-pedido, com short-circuit global). Permissões via registry `userCan/userCanAny` (`src/lib/permissions.ts`, 38 códigos). Worker de fila lê `siso_pedidos.status` (NÃO `status_separacao`) pra pular jobs de pedido cancelado.

**Tech Stack:** TypeScript strict, Next.js 16.1.6, Supabase JS (service role), vitest (unit + integration contra staging real), runner E2E HTTP `scripts/wms/cenarios` (catalogo `Cenario` + auth standalone). Sem migration/RPC nova nesta fase (P069/P116/P136/P008/P034/P038/P039/P007/P085/P003 são todos app-layer). Staging project `ehbxpbeijofxtsbezwxd`.

**Ordem dos PRs** (quick wins / sem-dep primeiro; respeita deps — todos os ids têm `deps: []`, então a ordem é por blast-radius crescente): PR1 (perm guard, low) → PR2 (anti-lockout, med) → PR3 (cancel job na fila, med) → PR4 (release de R nos cancels de operador/compra, low/med) → PR5 (separação parcial cancelamento, med — D1) → PR6 (webhook all-or-nothing + dedup, high).

> **Harness por PR:**
> - PR1/PR2: scenarios **auth** standalone (`scripts/wms/cenarios/auth/NN-*.ts`, raw `fetch`, login via `loginTestUser`/`loginTestRunner`), rodam com `npm run auth-matrix`. Dev server em `:3001` precisa estar up.
> - PR3/PR4/PR5: scenarios **catalogo** (`scripts/wms/cenarios/catalogo/NN-*.ts`, export default `Cenario`), rodam com `npm run scenarios -- --only NN` (alias `npm run scenarios:only NN`).
> - PR6: **integration** (`test/integration/*.test.ts`, contra staging, `npm run test:integration -- <arquivo>`).

> **Gotchas-âncora respeitados:** `siso_pedidos.id` é **text**; `siso_pedido_itens.produto_id` é **tiny_produto_id** (não uuid WMS); `wms_inserir_movimentacao` é o único write do ledger; `estornarReservaIndividual` é idempotente por `estorno_de`; `liberarReserva` é **pedido-scoped** com short-circuit global `temLiberacao` (pula tudo se há qualquer L no pedido) — por isso os caminhos novos usam `estornarReservaIndividual` por-R, exceto onde o precedente já usa `liberarReserva`.

---

## PR 1: Guard backend de permissão específica em /ajuste e /localizacoes/lote [P069, P116]

> **Decisão do dono (NOTA):** P069 — "validar permissão `operacoes.ajuste_manual` no backend, não só na tela (falha de segurança)". P116 — "validar permissão no backend ao criar prateleira (curl também rejeitado); família P069".
>
> **Estado atual (ancorado):** `src/app/api/wms/ajuste/route.ts:27` usa `requireWarehouseAccess` (auth.ts:62-88) que faz `userCanAny` sobre 11 perms amplas — um user SEM `operacoes.ajuste_manual` mas COM, p.ex., `inventario.executar` passa e ajusta via curl. `src/app/api/wms/localizacoes/lote/route.ts:41` usa só `requireAuth` (qualquer logado cria N prateleiras). Frontend é o único gate hoje. NÃO mexer no `localizacoes/route.ts` (criação única) — `requireAuth` ali é intencional (criação inline nos modais operacionais).

### Task 1.1: RED — cenário auth prova que user sem `operacoes.ajuste_manual` consegue ajustar via API

**Files:**
- Create: `scripts/wms/cenarios/auth/18-ajuste-permissao.ts`
- Test: o próprio arquivo (auth scenario standalone)

Espelha o estilo de `scripts/wms/cenarios/auth/17-vendas-cancelar-ownership.ts` (raw `fetch`, login ad-hoc). Cria um role customizado `ajuste-test-noperm` com SÓ `inventario.executar` (passa `requireWarehouseAccess`, mas NÃO tem `operacoes.ajuste_manual`), associa a um user de teste, loga, e faz `POST /api/wms/ajuste`.

- [ ] Step 1 — Escrever o teste que falha:

```typescript
// scripts/wms/cenarios/auth/18-ajuste-permissao.ts
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import { seedTestUsers } from "../_harness/seed-test-users";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

/**
 * Cenário 18 — POST /api/wms/ajuste exige operacoes.ajuste_manual no backend (P069).
 *
 * RED hoje: user com inventario.executar (passa requireWarehouseAccess) mas SEM
 * operacoes.ajuste_manual consegue ajustar via API (200). Esperado: 403.
 *
 * Casos:
 *  - noperm-user (só inventario.executar) → POST /ajuste → 403, nenhuma mov criada
 *  - op-runner (operador, tem operacoes.ajuste_manual) → POST /ajuste → 200
 */

async function ensureRoleComPerms(
  sb: ReturnType<typeof createServiceClient>,
  codigo: string,
  nome: string,
  perms: string[],
): Promise<string> {
  const { data: ex } = await sb.from("siso_roles").select("id").eq("codigo", codigo).maybeSingle();
  let roleId: string;
  if (ex) {
    roleId = (ex as { id: string }).id;
  } else {
    const { data, error } = await sb
      .from("siso_roles")
      .insert({ codigo, nome, descricao: nome, sistema: false })
      .select("id")
      .single();
    if (error) throw new Error(`criar role ${codigo}: ${error.message}`);
    roleId = (data as { id: string }).id;
  }
  await sb.from("siso_role_permissoes").delete().eq("role_id", roleId);
  await sb
    .from("siso_role_permissoes")
    .insert(perms.map((p) => ({ role_id: roleId, permissao_codigo: p })));
  return roleId;
}

async function ensureUserComRole(
  sb: ReturnType<typeof createServiceClient>,
  nome: string,
  pin: string,
  roleId: string,
): Promise<string> {
  const { data: ex } = await sb.from("siso_usuarios").select("id").eq("nome", nome).maybeSingle();
  let userId: string;
  if (ex) {
    userId = (ex as { id: string }).id;
    await sb.from("siso_usuarios").update({ pin, ativo: true }).eq("id", userId);
  } else {
    const { data, error } = await sb
      .from("siso_usuarios")
      .insert({ nome, pin, cargo: "operador", ativo: true })
      .select("id")
      .single();
    if (error) throw new Error(`criar user ${nome}: ${error.message}`);
    userId = (data as { id: string }).id;
  }
  await sb.from("siso_usuario_roles").delete().eq("usuario_id", userId);
  await sb.from("siso_usuario_roles").insert({ usuario_id: userId, role_id: roleId });
  return userId;
}

async function login(nome: string, pin: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome, pin }),
  });
  const j = (await r.json()) as { sessionId?: string };
  if (!j.sessionId) throw new Error(`login ${nome} sem sessionId: ${JSON.stringify(j)}`);
  return j.sessionId;
}

async function seedTripla(sb: ReturnType<typeof createServiceClient>) {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  const galpaoId = (g as { id: string }).id;
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("tipo", "picking")
    .limit(1)
    .single();
  const locId = (l as { id: string }).id;
  const sku = `AUTH-AJUSTE-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku, descricao: "auth ajuste test", ativo: true })
    .select("id")
    .single();
  return { produtoId: (p as { id: string }).id, galpaoId, locId };
}

async function postAjuste(sid: string, tripla: { produto_id: string; galpao_id: string; localizacao_id: string }) {
  const r = await fetch(`${baseUrl}/api/wms/ajuste`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sid },
    body: JSON.stringify({
      tripla,
      qty: 1,
      direcao: "entrada",
      motivo: "teste de permissao",
      motivo_categoria: "achado",
    }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

async function main() {
  const sb = createServiceClient();
  let failures = 0;

  // Seeda os runners do harness (op-runner/1002, vendor-runner/1003, etc.) — idempotente
  // (upsert). Garante que o login standalone funcione mesmo rodando `npx tsx 18-*.ts`
  // direto, sem depender de um seedInicial out-of-band.
  await seedTestUsers(sb);

  const roleId = await ensureRoleComPerms(
    sb,
    "ajuste-test-noperm",
    "Ajuste Test No-Perm",
    ["inventario.executar"], // passa requireWarehouseAccess, sem operacoes.ajuste_manual
  );
  await ensureUserComRole(sb, "ajuste-noperm-runner", "2010", roleId);

  const tripla = await seedTripla(sb);

  // Caso 1: noperm (só inventario.executar) → 403
  const sidNoperm = await login("ajuste-noperm-runner", "2010");
  const r1 = await postAjuste(sidNoperm, tripla);
  const ok1 = r1.status === 403;
  console.log(`[${ok1 ? "PASS" : "FAIL"}] noperm → POST /ajuste: ${r1.status} (expected 403) body=${r1.body}`);
  if (!ok1) failures++;

  // Caso 2: operador (tem operacoes.ajuste_manual) → 200
  // op-runner é seedado pelo harness P4 (PIN 1002, role operador).
  const sidOp = await login("op-runner", "1002");
  const r2 = await postAjuste(sidOp, tripla);
  const ok2 = r2.status === 200;
  console.log(`[${ok2 ? "PASS" : "FAIL"}] operador → POST /ajuste: ${r2.status} (expected 200) body=${r2.body}`);
  if (!ok2) failures++;

  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
```

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npm run dev` em outro terminal (server :3001), depois `npx tsx scripts/wms/cenarios/auth/18-ajuste-permissao.ts`
  - Expected: FAIL — `[FAIL] noperm → POST /ajuste: 200 (expected 403)` (o caso 2 já passa). Exit code 1.

- [ ] Step 3 — Implementação mínima:

Em `src/app/api/wms/ajuste/route.ts`, importar `userCan` e checar `operacoes.ajuste_manual` logo após o `requireWarehouseAccess`:

```typescript
// topo do arquivo — adicionar import:
import { userCan } from "@/lib/permissions";
```

```typescript
// substituir o bloco linhas 26-28:
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  if (!userCan(auth.user, "operacoes.ajuste_manual")) {
    return NextResponse.json(
      { error: "requer permissão operacoes.ajuste_manual" },
      { status: 403 },
    );
  }
```

E o mesmo guard na rota irmã `src/app/api/wms/ajuste/[id]/estornar/route.ts` (estorno é a operação inversa, mesmo gate). Importar `userCan` e adicionar após o `requireWarehouseAccess` (linhas 22-23):

```typescript
// topo:
import { userCan } from "@/lib/permissions";
```

```typescript
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  if (!userCan(auth.user, "operacoes.ajuste_manual")) {
    return NextResponse.json(
      { error: "requer permissão operacoes.ajuste_manual" },
      { status: 403 },
    );
  }
```

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npx tsx scripts/wms/cenarios/auth/18-ajuste-permissao.ts`
  - Expected: PASS — ambos os casos (403 noperm, 200 operador). Exit 0.

- [ ] Step 5 — Commit:
  - `git add src/app/api/wms/ajuste/route.ts src/app/api/wms/ajuste/[id]/estornar/route.ts scripts/wms/cenarios/auth/18-ajuste-permissao.ts`
  - `git commit -m "fix(wms): /ajuste e /ajuste/estornar exigem operacoes.ajuste_manual no backend (P069)"`

### Task 1.2: RED — cenário auth prova que user sem `localizacoes.editar` cria prateleiras em lote via API

**Files:**
- Create: `scripts/wms/cenarios/auth/19-localizacoes-lote-permissao.ts`
- Test: o próprio arquivo

- [ ] Step 1 — Escrever o teste que falha:

```typescript
// scripts/wms/cenarios/auth/19-localizacoes-lote-permissao.ts
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import { seedTestUsers } from "../_harness/seed-test-users";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

/**
 * Cenário 19 — POST /api/wms/localizacoes/lote exige localizacoes.editar (P116).
 *
 * RED hoje: rota usa só requireAuth — qualquer logado cria N prateleiras.
 * Esperado: user sem localizacoes.editar → 403 e nenhuma loc criada.
 *
 * Casos:
 *  - vendor-runner (vendedor, sem localizacoes.editar) → POST lote → 403, 0 criadas
 *  - op-runner (operador, tem localizacoes.editar) → POST lote → 200, cria
 */

async function login(nome: string, pin: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome, pin }),
  });
  const j = (await r.json()) as { sessionId?: string };
  if (!j.sessionId) throw new Error(`login ${nome} sem sessionId: ${JSON.stringify(j)}`);
  return j.sessionId;
}

async function postLote(sid: string, galpaoId: string, prefixo: string) {
  const r = await fetch(`${baseUrl}/api/wms/localizacoes/lote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sid },
    body: JSON.stringify({
      galpao_id: galpaoId,
      prefixo,
      h_inicio: 1,
      h_fim: 2,
      v_inicio: 1,
      v_fim: 2,
      tipo: "picking",
      preview: false,
    }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

async function main() {
  const sb = createServiceClient();
  // Seeda os runners do harness (op-runner/1002, vendor-runner/1003, etc.) — idempotente
  // (upsert). Garante o login standalone sem depender de seedInicial out-of-band.
  await seedTestUsers(sb);
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  const galpaoId = (g as { id: string }).id;
  let failures = 0;

  // Caso 1: vendedor (sem localizacoes.editar) → 403, nenhuma loc criada
  const prefixoV = `AUTHV-${Date.now()}`;
  const sidV = await login("vendor-runner", "1003");
  const r1 = await postLote(sidV, galpaoId, prefixoV);
  const ok1Status = r1.status === 403;
  const { count: criadasV } = await sb
    .from("siso_localizacoes")
    .select("id", { count: "exact", head: true })
    .eq("galpao_id", galpaoId)
    .like("codigo", `${prefixoV}%`);
  const ok1 = ok1Status && (criadasV ?? 0) === 0;
  console.log(`[${ok1 ? "PASS" : "FAIL"}] vendedor → lote: ${r1.status} (expected 403), criadas=${criadasV} (expected 0) body=${r1.body}`);
  if (!ok1) failures++;

  // Caso 2: operador (tem localizacoes.editar) → 200, cria
  const prefixoO = `AUTHO-${Date.now()}`;
  const sidO = await login("op-runner", "1002");
  const r2 = await postLote(sidO, galpaoId, prefixoO);
  const ok2Status = r2.status === 200;
  const { count: criadasO } = await sb
    .from("siso_localizacoes")
    .select("id", { count: "exact", head: true })
    .eq("galpao_id", galpaoId)
    .like("codigo", `${prefixoO}%`);
  const ok2 = ok2Status && (criadasO ?? 0) > 0;
  console.log(`[${ok2 ? "PASS" : "FAIL"}] operador → lote: ${r2.status} (expected 200), criadas=${criadasO} (expected >0) body=${r2.body}`);
  if (!ok2) failures++;

  // cleanup
  await sb.from("siso_localizacoes").delete().eq("galpao_id", galpaoId).like("codigo", `${prefixoO}%`);

  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
```

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npx tsx scripts/wms/cenarios/auth/19-localizacoes-lote-permissao.ts`
  - Expected: FAIL — `[FAIL] vendedor → lote: 200 (expected 403), criadas=4 (expected 0)`. Exit 1.

- [ ] Step 3 — Implementação mínima:

Em `src/app/api/wms/localizacoes/lote/route.ts`, importar `userCan` e checar `localizacoes.editar` logo após o `requireAuth` (mantém `requireAuth` — é o mais cirúrgico):

```typescript
// topo — adicionar import:
import { userCan } from "@/lib/permissions";
```

```typescript
// substituir o bloco linhas 40-42:
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  if (!userCan(auth.user, "localizacoes.editar")) {
    return NextResponse.json(
      { error: "requer permissão localizacoes.editar" },
      { status: 403 },
    );
  }
```

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npx tsx scripts/wms/cenarios/auth/19-localizacoes-lote-permissao.ts`
  - Expected: PASS — 403/0 criadas (vendedor), 200/>0 criadas (operador). Exit 0.

- [ ] Step 5 — Commit:
  - `git add src/app/api/wms/localizacoes/lote/route.ts scripts/wms/cenarios/auth/19-localizacoes-lote-permissao.ts`
  - `git commit -m "fix(wms): /localizacoes/lote exige localizacoes.editar no backend (P116)"`

### Task 1.3: Registrar P069/P116 em erros-conhecidos.yaml

- [ ] Step 1 — Adicionar entrada em `erros-conhecidos.yaml` (sob `erros:`):

```yaml
  - id: ajuste-lote-sem-guard-perm-backend
    date: "2026-06-05"
    source: wms/ajuste, wms/localizacoes/lote
    category: auth
    message: "Ajuste de estoque (/api/wms/ajuste) e import de prateleiras em lote (/api/wms/localizacoes/lote) eram protegidos só na tela — via curl qualquer user de armazém (ou qualquer logado) burlava."
    cause: >
      /ajuste usava requireWarehouseAccess (userCanAny sobre 11 perms amplas), aceitando
      users sem operacoes.ajuste_manual mas com outra perm (ex.: inventario.executar).
      /localizacoes/lote usava só requireAuth (qualquer logado). O frontend era o único
      gate da permissão correta.
    fix: >
      Adicionado userCan(auth.user,'operacoes.ajuste_manual') em /ajuste e /ajuste/[id]/estornar
      (403 quando falso); userCan(auth.user,'localizacoes.editar') em /localizacoes/lote.
      NÃO mexido em /localizacoes/route.ts (criação única) — requireAuth ali é intencional.
    files:
      - src/app/api/wms/ajuste/route.ts
      - src/app/api/wms/ajuste/[id]/estornar/route.ts
      - src/app/api/wms/localizacoes/lote/route.ts
      - scripts/wms/cenarios/auth/18-ajuste-permissao.ts
      - scripts/wms/cenarios/auth/19-localizacoes-lote-permissao.ts
    tags: [auth, permissao, ajuste, localizacoes, backend-guard, P069, P116]
```

- [ ] Step 2 — Commit:
  - `git add erros-conhecidos.yaml`
  - `git commit -m "docs: registra ajuste-lote-sem-guard-perm-backend (P069, P116)"`

---

## PR 2: Anti-lockout: recusar desativação do último admin ativo [P136]

> **Decisão do dono (NOTA):** "recusar desativação do último admin (anti-lockout)".
>
> **Estado atual (ancorado):** `src/app/api/wms/admin/usuarios/route.ts` PUT (124-207) aplica `ativo` direto via `updates={...rest}` (linha 166) SEM guard. O frontend `aba-funcionarios.tsx:791-808` (`toggleAtivo`) envia `{ id, ativo: !ativo }` pra `/api/wms/admin/usuarios`. A proteção anti-lockout existente só cobre **remover a role admin** (`[id]/roles/route.ts:55-82`); **desativar** (`ativo=false`) o último admin não é coberto. Definição de "admin" = role `codigo='admin'` (RBAC), não cargo legado. Guard deve disparar SÓ quando `ativo===false` (o PUT genérico também serve printnode/galpoes/cargos).

### Task 2.1: RED — cenário auth prova que o último admin ativo consegue se desativar

**Files:**
- Create: `scripts/wms/cenarios/auth/21-ultimo-admin-desativar.ts`
- Test: o próprio arquivo

- [ ] Step 1 — Escrever o teste que falha:

```typescript
// scripts/wms/cenarios/auth/21-ultimo-admin-desativar.ts
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import { seedTestUsers } from "../_harness/seed-test-users";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

/**
 * Cenário 21 — PUT /api/wms/admin/usuarios não pode desativar o último admin ativo (P136).
 *
 * RED hoje: PUT { id, ativo:false } no único admin retorna 200 e desativa → lockout.
 * Esperado: 4xx + admin permanece ativo. Com 2 admins, desativar 1 → 200.
 */

async function login(nome: string, pin: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome, pin }),
  });
  const j = (await r.json()) as { sessionId?: string };
  if (!j.sessionId) throw new Error(`login ${nome} sem sessionId: ${JSON.stringify(j)}`);
  return j.sessionId;
}

async function adminRoleId(sb: ReturnType<typeof createServiceClient>): Promise<string> {
  const { data } = await sb.from("siso_roles").select("id").eq("codigo", "admin").single();
  return (data as { id: string }).id;
}

async function ensureAdmin(sb: ReturnType<typeof createServiceClient>, nome: string, pin: string, roleId: string): Promise<string> {
  const { data: ex } = await sb.from("siso_usuarios").select("id").eq("nome", nome).maybeSingle();
  let id: string;
  if (ex) {
    id = (ex as { id: string }).id;
    await sb.from("siso_usuarios").update({ pin, ativo: true }).eq("id", id);
  } else {
    const { data } = await sb.from("siso_usuarios").insert({ nome, pin, cargo: "admin", ativo: true }).select("id").single();
    id = (data as { id: string }).id;
  }
  await sb.from("siso_usuario_roles").upsert({ usuario_id: id, role_id: roleId }, { onConflict: "usuario_id,role_id" });
  return id;
}

async function putAtivo(sid: string, id: string, ativo: boolean) {
  const r = await fetch(`${baseUrl}/api/wms/admin/usuarios`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Session-Id": sid },
    body: JSON.stringify({ id, ativo }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

async function isAtivo(sb: ReturnType<typeof createServiceClient>, id: string): Promise<boolean> {
  const { data } = await sb.from("siso_usuarios").select("ativo").eq("id", id).single();
  return (data as { ativo: boolean }).ativo;
}

async function main() {
  const sb = createServiceClient();
  // Idempotente; garante baseline de runners do harness (e que a role 'admin' exista,
  // mesma precondição de adminRoleId). Permite rodar `npx tsx 21-*.ts` standalone.
  await seedTestUsers(sb);
  const roleId = await adminRoleId(sb);
  let failures = 0;

  // Estado controlado: desativa TODOS os admins exceto o nosso "soloAdmin".
  // (Soft-reset: marca ativo=false em qualquer admin pré-existente; ao final
  //  o harness re-seeda admin-runner via seedTestUsers em outras runs.)
  const soloAdmin = await ensureAdmin(sb, "solo-admin-runner", "2099", roleId);
  const { data: todosAdmins } = await sb
    .from("siso_usuario_roles")
    .select("usuario_id, siso_roles!inner(codigo)")
    .eq("siso_roles.codigo", "admin");
  for (const a of (todosAdmins ?? []) as Array<{ usuario_id: string }>) {
    if (a.usuario_id !== soloAdmin) {
      await sb.from("siso_usuarios").update({ ativo: false }).eq("id", a.usuario_id);
    }
  }

  const sid = await login("solo-admin-runner", "2099");

  // Caso 1: único admin ativo tenta se desativar → 4xx + permanece ativo
  const r1 = await putAtivo(sid, soloAdmin, false);
  const ainda1 = await isAtivo(sb, soloAdmin);
  const ok1 = r1.status >= 400 && r1.status < 500 && ainda1 === true;
  console.log(`[${ok1 ? "PASS" : "FAIL"}] desativar último admin: ${r1.status} (expected 4xx), ativo=${ainda1} (expected true) body=${r1.body}`);
  if (!ok1) failures++;

  // Caso 2: cria 2º admin ativo, agora desativar o solo → 200
  const segundo = await ensureAdmin(sb, "segundo-admin-runner", "2098", roleId);
  const r2 = await putAtivo(sid, soloAdmin, false);
  const ainda2 = await isAtivo(sb, soloAdmin);
  const ok2 = r2.status === 200 && ainda2 === false;
  console.log(`[${ok2 ? "PASS" : "FAIL"}] desativar 1 de 2 admins: ${r2.status} (expected 200), ativo=${ainda2} (expected false) body=${r2.body}`);
  if (!ok2) failures++;

  // cleanup: reativa solo + remove 2º (não deixa lixo de admins)
  await sb.from("siso_usuarios").update({ ativo: true }).eq("id", soloAdmin);
  await sb.from("siso_usuario_roles").delete().eq("usuario_id", segundo);
  await sb.from("siso_usuarios").update({ ativo: false }).eq("id", segundo);

  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
```

> Nota: o caso 2 desativa o solo via a sessão dele mesmo (já autenticado antes); o guard só checa "é o último admin?" — não exige sessão diferente.

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npx tsx scripts/wms/cenarios/auth/21-ultimo-admin-desativar.ts`
  - Expected: FAIL — `[FAIL] desativar último admin: 200 (expected 4xx), ativo=false (expected true)`. Exit 1.

- [ ] Step 3 — Implementação mínima:

Em `src/app/api/wms/admin/usuarios/route.ts`, no PUT, ANTES de aplicar o update (após o bloco de validação de cargos, antes de `const supabase = createServiceClient();` na linha 183), inserir o guard anti-lockout. Espelha `[id]/roles/route.ts:55-82`. Note que `supabase` ainda não foi criado nesse ponto — o guard precisa de um client; cria-se logo acima:

```typescript
// substituir o trecho que vai da linha 181 (fim do bloco `if (newCargos)`) até
// a linha 183 (`const supabase = createServiceClient();`) por:

  const supabase = createServiceClient();

  // Anti-lockout (P136): não desativar o último admin ativo. Só dispara quando
  // ativo===false explicitamente (o PUT genérico também serve printnode/galpoes/cargos).
  if (rest.ativo === false) {
    const { data: alvoEhAdmin } = await supabase
      .from("siso_usuario_roles")
      .select("usuario_id, siso_roles!inner(codigo)")
      .eq("usuario_id", id)
      .eq("siso_roles.codigo", "admin")
      .maybeSingle();

    if (alvoEhAdmin) {
      const { data: outrosAdmins } = await supabase
        .from("siso_usuario_roles")
        .select("usuario_id, siso_usuarios!inner(ativo), siso_roles!inner(codigo)")
        .eq("siso_roles.codigo", "admin")
        .eq("siso_usuarios.ativo", true)
        .neq("usuario_id", id);

      if (!outrosAdmins || outrosAdmins.length === 0) {
        return NextResponse.json(
          { erro: "Sistema precisa de pelo menos 1 admin ativo" },
          { status: 409 },
        );
      }
    }
  }
```

> Nota de ancoragem: `rest` é o objeto desestruturado em `const { id, cargos: rawCargos, cargo: rawCargo, galpao_ids, ...rest } = body;` (linha 153 — note que `cargos`/`cargo` são RENOMEADOS pra `rawCargos`/`rawCargo`, então NÃO caem em `rest`; `ativo` cai). `rest.ativo` é o booleano enviado pelo frontend. O `updates` (linha 166) é construído de `...rest`, e `const supabase = createServiceClient();` está na linha 183 — então o guard (que cria o `supabase` mais cedo) roda antes de qualquer escrita.

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npx tsx scripts/wms/cenarios/auth/21-ultimo-admin-desativar.ts`
  - Expected: PASS — caso 1 (409, ativo permanece true), caso 2 (200, desativa). Exit 0.

- [ ] Step 5 — Commit:
  - `git add src/app/api/wms/admin/usuarios/route.ts scripts/wms/cenarios/auth/21-ultimo-admin-desativar.ts`
  - `git commit -m "fix(wms): recusa desativar último admin ativo (anti-lockout) (P136)"`

### Task 2.2: Registrar P136 em erros-conhecidos.yaml

- [ ] Step 1 — Adicionar entrada:

```yaml
  - id: desativar-ultimo-admin-lockout
    date: "2026-06-05"
    source: wms/admin/usuarios
    category: auth
    message: "Desativar (ativo=false) o último admin ativo travava o sistema — ninguém mais acessava Configurações/usuários (lockout)."
    cause: >
      PUT /api/wms/admin/usuarios aplicava ativo direto sem guard. A proteção anti-lockout
      existente só cobria REMOVER a role admin ([id]/roles), não DESATIVAR o usuário.
    fix: >
      Guard no PUT: quando rest.ativo===false e o alvo é admin (role codigo='admin'), checa
      se existe OUTRO usuário ativo com role admin; se não, 409 "Sistema precisa de pelo
      menos 1 admin ativo". Dispara só em ativo===false (não afeta updates de printnode/galpoes/cargos).
    files:
      - src/app/api/wms/admin/usuarios/route.ts
      - scripts/wms/cenarios/auth/21-ultimo-admin-desativar.ts
    tags: [auth, anti-lockout, admin, usuarios, P136]
```

- [ ] Step 2 — Commit:
  - `git add erros-conhecidos.yaml`
  - `git commit -m "docs: registra desativar-ultimo-admin-lockout (P136)"`

---

## PR 3: Cancelar job na fila ao estornar pedido + alinhar status/status_separacao [P008]

> **Decisão do dono (NOTA):** opção 1 — "cancelar a tarefa na fila quando o pedido é cancelado".
>
> **Estado atual (ancorado):** `src/app/api/wms/pedidos/[id]/estornar/route.ts:91-94` seta `status_separacao='cancelado'` (NÃO `status`) e NUNCA toca `siso_fila_execucao`. O guard do worker (`execution-worker.ts:163`) checa `siso_pedidos.status === 'cancelado'` — coluna DIFERENTE — então o job `lancar_estoque` enfileirado NÃO é pulado por esse guard. O worker-wms tem idempotência por `estorno_de` (`execution-worker-wms.ts:103-130`) que **mitiga** o double-release das MESMAS reservas, mas a nota é vinculante: cancelar o job na fila explicitamente E alinhar `status`. `siso_fila_execucao` já tem 'cancelado' no CHECK (`20260309_create_execution_queue.sql:27`).

### Task 3.1: RED — cenário catalogo prova que o job sobrevive ao estorno e o worker não o pula

**Files:**
- Create: `scripts/wms/cenarios/catalogo/85-cancelar-job-fila-estorno.ts`
- Test: o próprio arquivo (`Cenario`)

Estratégia: aprovar um pedido `propria` via webhook auto-aprovação NÃO serve (já enfileira e o worker drena rápido). Usamos aprovação manual (`/pedidos/aprovar` decisao=`propria`) que enfileira `lancar_estoque`, depois chamamos `/pedidos/[id]/estornar` ANTES do worker drenar, e asseveramos: (a) job em `siso_fila_execucao` ficou `status='cancelado'`; (b) `siso_pedidos.status='cancelado'`.

> Nota de ancoragem: `ctx.aprovar(id, "propria")` chama `/api/wms/pedidos/aprovar` e dispara `kickWorker` via `after()`. Pra evitar corrida com o worker, o cenário lê o job logo após o estorno e tolera tanto `cancelado` (esperado) quanto verifica que o pedido não ganhou novas S além do esperado. O sinal forte é `status='cancelado'` + job `cancelado`.

- [ ] Step 1 — Escrever o teste que falha:

```typescript
// scripts/wms/cenarios/catalogo/85-cancelar-job-fila-estorno.ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 85 — estornar pedido cancela o job na fila e alinha status (P008).
 *
 * Aprova manualmente um pedido propria (enfileira lancar_estoque), estorna,
 * e assevera: job na fila → 'cancelado' E siso_pedidos.status → 'cancelado'.
 * RED hoje: estornar seta só status_separacao='cancelado' e deixa o job vivo.
 */
type Setup = { sku: string; pedidoId: string; jobId: string };

export default {
  nome: "85 — estornar pedido cancela job na fila + alinha status (P008)",
  descricao:
    "Aprova propria (gera job lancar_estoque pendente), estorna o pedido. " +
    "Espera: job → cancelado E siso_pedidos.status → cancelado.",
  tags: ["estorno", "fila", "cancelamento", "P008"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("85");
    const produtoId = await ctx.criarProduto({ sku, descricao: "Cancel job fila 85" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 10 });
    return { sku, pedidoId: "", jobId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;

    // Pedido propria 1 unidade.
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 1 }],
    });
    setup.pedidoId = id;
    // Webhook propria auto-aprova → executando; o job já é drenado pelo worker.
    // Pra ter um job FRESCO pendente sob nosso controle, forçamos o pedido de
    // volta a 'pendente' e re-aprovamos manualmente.
    await ctx.aguardarStatus(id, "executando", undefined, { timeout_ms: 20000 });

    // Reset controlado pra 'pendente' + limpa fila pra recriar job pendente.
    await ctx.sb.from("siso_pedidos").update({ status: "pendente", decisao_final: null, status_separacao: null }).eq("id", id);
    await ctx.sb.from("siso_fila_execucao").update({ status: "cancelado" }).eq("pedido_id", id).neq("status", "concluido");

    // Aprova manual → enfileira lancar_estoque novo (pendente).
    await ctx.aprovar(id, "propria");

    // Captura o job recém-enfileirado (pendente ou executando).
    const { data: jobRow } = await ctx.sb
      .from("siso_fila_execucao")
      .select("id, status")
      .eq("pedido_id", id)
      .in("status", ["pendente", "executando"])
      .order("criado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    setup.jobId = jobRow ? String((jobRow as { id: string }).id) : "";

    // Estorna o pedido (admin) — deve cancelar o job e alinhar status.
    await ctx.http.post(`/api/wms/pedidos/${id}/estornar`, { motivo: "teste cancelamento job fila" });
    await ctx.aguardar(1500);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { pedidoId, jobId } = setup;

    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("status")
      .eq("id", pedidoId)
      .single();
    if ((pedido as { status: string }).status !== "cancelado") {
      throw new Error(`P008: esperava siso_pedidos.status='cancelado', got '${(pedido as { status: string }).status}'`);
    }

    if (jobId) {
      const { data: job } = await ctx.sb
        .from("siso_fila_execucao")
        .select("status")
        .eq("id", jobId)
        .single();
      const st = (job as { status: string }).status;
      if (st !== "cancelado" && st !== "concluido") {
        throw new Error(`P008: job ${jobId} ficou '${st}', esperava 'cancelado' (worker pode ter drenado antes → 'concluido' aceito)`);
      }
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

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npm run scenarios -- --only 85` (server :3001 up, ou o runner sobe sozinho)
  - Expected: FAIL — `P008: esperava siso_pedidos.status='cancelado', got 'executando'` (estornar só toca status_separacao).

- [ ] Step 3 — Implementação mínima:

Em `src/app/api/wms/pedidos/[id]/estornar/route.ts`, no bloco de update pós-estorno (linhas 91-94), alinhar `status` + cancelar o job na fila:

```typescript
// substituir o update das linhas 91-94:
    await sb
      .from("siso_pedidos")
      .update({ status: "cancelado", status_separacao: "cancelado" })
      .eq("id", pedidoId);

    // P008: cancela o job lancar_estoque enfileirado pra que o worker não
    // re-processe (double-release). O worker-wms já é idempotente por estorno_de,
    // mas a nota é vinculante: desativar o job explicitamente.
    await sb
      .from("siso_fila_execucao")
      .update({ status: "cancelado", atualizado_em: new Date().toISOString() })
      .eq("pedido_id", pedidoId)
      .in("status", ["pendente", "executando", "erro"]);
```

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npm run scenarios -- --only 85`
  - Expected: PASS — `status='cancelado'` + job `cancelado`. Invariantes do runner (sem reservas órfãs) também passam.

- [ ] Step 5 — Commit:
  - `git add src/app/api/wms/pedidos/[id]/estornar/route.ts scripts/wms/cenarios/catalogo/85-cancelar-job-fila-estorno.ts`
  - `git commit -m "fix(wms): estornar pedido cancela job na fila + alinha status=cancelado (P008)"`

### Task 3.2: Registrar P008 em erros-conhecidos.yaml

- [ ] Step 1 — Adicionar entrada:

```yaml
  - id: estornar-pedido-deixa-job-vivo
    date: "2026-06-05"
    source: wms/pedidos/estornar
    category: business_logic
    message: "Estornar pedido deixava o job lancar_estoque vivo na fila; worker re-processava (potencial double-release de estoque)."
    cause: >
      /pedidos/[id]/estornar setava status_separacao='cancelado' (não status) e nunca
      tocava siso_fila_execucao. O guard do worker lê siso_pedidos.status — coluna
      diferente — então o job não era pulado.
    fix: >
      Estornar agora seta status='cancelado' (além de status_separacao) e UPDATE
      siso_fila_execucao SET status='cancelado' WHERE pedido_id=... AND status IN
      ('pendente','executando','erro').
    files:
      - src/app/api/wms/pedidos/[id]/estornar/route.ts
      - scripts/wms/cenarios/catalogo/85-cancelar-job-fila-estorno.ts
    tags: [estorno, fila, worker, double-release, status, P008]
```

- [ ] Step 2 — Commit:
  - `git add erros-conhecidos.yaml`
  - `git commit -m "docs: registra estornar-pedido-deixa-job-vivo (P008)"`

---

## PR 4: Liberar reserva R nos caminhos de cancelamento (recusar pedido, cancelar item/pedido de compra) [P034, P038, P039]

> **Decisão do dono (NOTA):** P034 op1 ("devolver automático: ao cancelar, libera a reserva na mesma hora"); P038 op1 ("corrigir o código pra liberar automaticamente no ato do cancelamento"); P039 op2 ("liberar estoque automaticamente quando confirma cancelamento").
>
> **Estado atual (ancorado):**
> - **P034 (recusar pedido):** `pedidos/aprovar/route.ts:68-98` bloco `decisao==='rejeitado'` marca `status='cancelado'` SEM liberar R. Um pedido transferencia/propria em `pendente` já tem R criada pelo webhook (`webhook-processor-wms.ts:587`, TTL 30d). R fica presa até morrer por TTL.
> - **P038 (cancelar compra — todos itens terminais):** `compras-utils.ts:149-167` (`checkAndCancelPedidoIfAllTerminal`) marca pedido `cancelado` + cancela fila, mas NÃO libera R.
> - **P039 (confirmar cancelamento de item de compra):** `compras/itens/[itemId]/cancelamento/confirmar/route.ts:50-71` marca item `cancelado` mas não libera a R viva (criada pelo reconciliador-oc quando estoque chegou). Precedente: `equivalente/confirmar/route.ts:134-149` já chama `liberarReserva({motivo:'cancelamento'})`.
>
> **Coordenação P038×P039:** a confirmação de item (P039) chama `checkAndCancelPedidoIfAllTerminal` (P038). Pra não duplicar liberação: a liberação por-pedido vai DENTRO de `checkAndCancelPedidoIfAllTerminal` (P038) — quando ela cancela o pedido inteiro; e a rota de confirmar item (P039) só libera quando o pedido NÃO foi cancelado pela função (caso multi-item). Como `estornarReservaIndividual` é idempotente por `estorno_de`, dupla chamada é segura — mas evitamos com a ordem. Usamos `estornarReservaIndividual` por-R (não `liberarReserva`) em P034/P038, espelhando `webhook/tiny/route.ts:210-245`; em P039 seguimos o precedente `liberarReserva` por simetria com `equivalente/confirmar`.

### Task 4.1: RED — cenário catalogo prova que Recusar pedido não libera a R (P034)

**Files:**
- Create: `scripts/wms/cenarios/catalogo/34-recusar-pedido-libera-r.ts`
- Test: o próprio arquivo

- [ ] Step 1 — Escrever o teste que falha:

```typescript
// scripts/wms/cenarios/catalogo/34-recusar-pedido-libera-r.ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 34 — Recusar pedido (decisao=rejeitado) libera a reserva R (P034).
 *
 * Pedido transferencia em 'pendente' com R viva. Operador recusa.
 * Espera: status='cancelado' E reservado volta a 0 imediatamente (R estornada).
 * RED hoje: rejeitado marca cancelado mas deixa R presa até TTL (30d).
 */
type Setup = { sku: string; pedidoId: string };

export default {
  nome: "34 — Recusar pedido libera reserva R imediatamente (P034)",
  descricao:
    "Pedido com R viva, decisao=rejeitado → status cancelado + reservado=0 (sem esperar TTL).",
  tags: ["cancelamento", "reserva", "recusar", "P034"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("34r");
    await ctx.criarProduto({ sku, descricao: "Recusar libera R 34" });
    // Saldo só em SP → pedido da NetAir (casa CWB) cai em transferencia, que reserva.
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "A-01-02", qty: 5 });
    return { sku, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    setup.pedidoId = id;
    // transferencia → fica pendente com R viva.
    await ctx.aguardarStatus(id, "pendente", undefined, { timeout_ms: 20000 });
    // sanity: reservado=2 em SP
    await ctx.assertReservado(sku, "SP", "A-01-02", 2);

    // Recusa.
    await ctx.http.post("/api/wms/pedidos/aprovar", { pedidoId: id, decisao: "rejeitado", motivo: "teste recusa" });
    await ctx.aguardar(1500);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku, pedidoId } = setup;
    const { data: pedido } = await ctx.sb.from("siso_pedidos").select("status").eq("id", pedidoId).single();
    if ((pedido as { status: string }).status !== "cancelado") {
      throw new Error(`P034: status esperado 'cancelado', got '${(pedido as { status: string }).status}'`);
    }
    // R liberada → reservado volta a 0.
    await ctx.assertReservado(sku, "SP", "A-01-02", 0);
    await ctx.assertSemReservasOrfas();
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

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npm run scenarios -- --only 34-recusar`
  - Expected: FAIL — `assertReservado` espera 0 mas got 2 (R presa). Ou invariante de reserva órfã dispara.

- [ ] Step 3 — Implementação mínima:

Em `src/app/api/wms/pedidos/aprovar/route.ts`, no bloco `decisao==='rejeitado'` (68-98), liberar as R vivas via `estornarReservaIndividual` ANTES do update de status. `estornarReservaIndividual` já está importado (linha 8).

```typescript
// dentro do bloco `if (decisao === "rejeitado") {`, após `const supabase = createServiceClient();`
// (linha 69) e ANTES do update (linha 70):

    // P034: libera as R vivas do pedido no ato do Recusar (não espera TTL 30d).
    // Espelha webhook/tiny:210-245 — estornarReservaIndividual é idempotente por estorno_de.
    const { data: reservasAbertas } = await supabase
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("origem_id", String(pedidoId));
    for (const r of (reservasAbertas ?? []) as Array<{ id: string }>) {
      try {
        await estornarReservaIndividual({ reserva_id: r.id, motivo: "outro", usuario_id: operadorId });
      } catch (e) {
        logger.warn("aprovar", "falha estornando R no recusar (segue)", {
          pedidoId,
          reserva_id: r.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
```

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npm run scenarios -- --only 34-recusar`
  - Expected: PASS — status cancelado, reservado=0, sem reservas órfãs.

- [ ] Step 5 — Commit:
  - `git add src/app/api/wms/pedidos/aprovar/route.ts scripts/wms/cenarios/catalogo/34-recusar-pedido-libera-r.ts`
  - `git commit -m "fix(wms): Recusar pedido (rejeitado) libera reserva R imediatamente (P034)"`

### Task 4.2: RED — cenário catalogo prova que confirmar cancelamento de item de compra não libera a R (P039 + P038)

**Files:**
- Create: `scripts/wms/cenarios/catalogo/84-cancelar-item-libera-reserva.ts`
- Test: o próprio arquivo

Cenário: pedido OC reconciliado (entrou estoque E → reconciliador-oc cria R viva). Marcar item pra cancelamento + confirmar. Após confirmar: reservado da tripla volta a 0.

> Nota de ancoragem do fluxo: reproduzir o caminho exato OC→reconciliação→R-viva é longo. Usamos o helper `ctx.comprar({ pedido_id })` (cria OC + linka item) e então `ctx.receber/receberCompra` pra disparar a entrada E e o reconciliador (que cria a R). O caminho mais determinístico no harness: webhook sem saldo → aprovar OC → marcar esgotado → comprar → receber via OC (cenário 81 mostra o passo a passo). Após o reconciliador criar a R (pedido volta a propria/aguardando_nf), marcamos o item de compra como `cancelamento_pendente` e confirmamos.
>
> **Simplificação determinística (sem depender do timing do reconciliador):** semeamos diretamente a R viva via `wms_reservar_atomico` ligada ao pedido, depois exercitamos o endpoint de confirmar cancelamento — o que isola o SINAL (a rota libera a R?) do timing do reconciliador. O caminho real do reconciliador já é coberto pelos cenários 80/81.

- [ ] Step 1 — Escrever o teste que falha:

```typescript
// scripts/wms/cenarios/catalogo/84-cancelar-item-libera-reserva.ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 84 — confirmar cancelamento de item de compra libera a R viva (P039/P038).
 *
 * Semeia um pedido com 1 item OC e uma R viva (origem_id=pedido, reserva_pedido)
 * apontando pra (produto, galpão, loc). Marca o item p/ cancelamento e confirma.
 * Espera: após confirmar, reservado da tripla volta a 0 (R liberada via L).
 * RED hoje: a rota confirma o cancelamento mas deixa a R presa.
 */
type Setup = { sku: string; pedidoId: string; itemId: string; produtoId: string; galpaoId: string; locId: string };

export default {
  nome: "84 — cancelar item de compra libera reserva R (P039/P038)",
  descricao:
    "Pedido OC com R viva. Confirmar cancelamento do item → reservado volta a 0.",
  tags: ["cancelamento", "compra", "reserva", "P038", "P039"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("84");
    const produtoId = await ctx.criarProduto({ sku, descricao: "Cancelar item libera R 84" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 5 });
    const { data: g } = await ctx.sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const galpaoId = (g as { id: string }).id;
    const { data: l } = await ctx.sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-02").single();
    const locId = (l as { id: string }).id;
    return { sku, pedidoId: "", itemId: "", produtoId, galpaoId, locId };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku, produtoId, galpaoId, locId } = setup;
    const empresaId = ctx.staging.empresas.netair.id;
    const pedidoId = `cancel-item-84-${Date.now()}`;
    setup.pedidoId = pedidoId;

    // Pedido sintético em fluxo de compra (espelha estado pós-reconciliação).
    await ctx.sb.from("siso_pedidos").insert({
      id: pedidoId,
      numero: pedidoId,
      empresa_origem_id: empresaId,
      filial_origem: "CWB",
      cliente_nome: "Cancel Item 84",
      origem_pedido: "webhook",
      status: "executando",
      status_separacao: "aguardando_compra",
      data: new Date().toISOString().slice(0, 10),
      criado_em: new Date().toISOString(),
    });

    // Item de compra em cancelamento_pendente (estado que o confirmar exige).
    // produto_id é o tiny_produto_id (gotcha) — usamos um placeholder válido do mapeamento.
    const { data: mapRow } = await ctx.sb
      .from("siso_produto_empresas")
      .select("tiny_produto_id")
      .eq("empresa_id", empresaId)
      .eq("produto_id", produtoId)
      .maybeSingle();
    const tinyId = mapRow ? Number((mapRow as { tiny_produto_id: number }).tiny_produto_id) : 999999;

    const { data: item } = await ctx.sb.from("siso_pedido_itens").insert({
      pedido_id: pedidoId,
      produto_id: tinyId,
      produto_id_tiny: tinyId,
      sku,
      descricao: "Cancel Item 84",
      quantidade_pedida: 2,
      compra_status: "cancelamento_pendente",
      compra_cancelamento_motivo: "teste",
    }).select("id").single();
    setup.itemId = String((item as { id: string }).id);

    // R viva pra (produto, galpão, loc) ligada ao pedido (espelha reconciliador-oc).
    await ctx.sb.rpc("wms_reservar_atomico", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_quantidade: 2,
      p_pedido_id: pedidoId,
      p_ttl_horas: 24 * 30,
      p_usuario_id: null,
    });
    await ctx.assertReservado(sku, "CWB", "A-01-02", 2);

    // Confirma cancelamento do item.
    await ctx.http.post(`/api/wms/compras/itens/${setup.itemId}/cancelamento/confirmar`, {});
    await ctx.aguardar(1200);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    // R liberada → reservado volta a 0.
    await ctx.assertReservado(sku, "CWB", "A-01-02", 0);
    await ctx.assertSemReservasOrfas();
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

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npm run scenarios -- --only 84-cancelar-item`
  - Expected: FAIL — `assertReservado` espera 0, got 2 (R presa).

- [ ] Step 3 — Implementação mínima:

**(a) P038** — em `src/lib/compras-utils.ts`, dentro de `checkAndCancelPedidoIfAllTerminal`, após cancelar a fila (linha 162) e antes do log/return, liberar as R vivas do pedido. Importar o helper no topo:

```typescript
// topo de compras-utils.ts — adicionar:
import { estornarReservaIndividual } from "@/lib/wms/reservas";
```

```typescript
// dentro de checkAndCancelPedidoIfAllTerminal, após o UPDATE da fila (linha 162),
// antes do logger.warn (linha 164):

  // P038: libera as R vivas do pedido cancelado no ato (não espera cron de expiração).
  // estornarReservaIndividual é idempotente por estorno_de → seguro chamar pra todas.
  const { data: reservasAbertas } = await supabase
    .from("siso_movimentacoes")
    .select("id")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("origem_id", String(pedidoId));
  let reservasLiberadas = 0;
  for (const r of (reservasAbertas ?? []) as Array<{ id: string }>) {
    try {
      await estornarReservaIndividual({ reserva_id: r.id, motivo: "outro" });
      reservasLiberadas++;
    } catch (e) {
      logger.warn(logSource, "falha estornando R no cancelamento (segue)", {
        pedidoId,
        reserva_id: r.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
```

E incluir `reservasLiberadas` no log existente (linha 164-167):

```typescript
  logger.warn(logSource, "Pedido cancelado — todos itens de compra terminais", {
    pedidoId,
    totalItens: allItems.length,
    reservasLiberadas,
  });
```

**(b) P039** — em `src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts`, quando o pedido NÃO foi cancelado pela função P038 (caso multi-item), liberar a R do pedido via `liberarReserva` (precedente `equivalente/confirmar:134-149`). Importar:

```typescript
// topo — adicionar:
import { liberarReserva } from "@/lib/wms/reservas";
```

```typescript
// substituir o bloco linhas 73-82 (checkAndCancelPedidoIfAllTerminal + checkAndReleasePedidos):
    const { pedidoCancelado } = await checkAndCancelPedidoIfAllTerminal(
      supabase,
      item.pedido_id,
      "compras-cancelamento-confirmar",
    );

    let pedidosLiberados: string[] = [];
    if (!pedidoCancelado) {
      pedidosLiberados = await checkAndReleasePedidos([itemId]);
      // P039: o pedido segue vivo (multi-item) mas a R criada pra ESTE item
      // (via reconciliador-oc) fica órfã. liberarReserva é pedido-scoped (libera
      // todas as Rs do pedido) — mesma limitação aceita em equivalente/confirmar.
      try {
        const liberadas = await liberarReserva({
          pedido_id: String(item.pedido_id),
          motivo: "cancelamento",
          usuario_id: session.id,
        });
        logger.info("compras-cancelamento-confirmar", "Rs liberadas no cancelamento de item", {
          pedido_id: item.pedido_id,
          item_id: itemId,
          liberadas,
        });
      } catch (e) {
        logger.warn("compras-cancelamento-confirmar", "falha liberando R (segue)", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
```

> Nota de divergência do achado: o achado P039 sugeriu também tocar `compras/pedidos/[pedidoId]/cancelar/route.ts:130-160`. Esse caminho já cancela a fila e estorna movs E, mas NÃO libera R. Adicionamos a liberação lá também (Task 4.2 step 3c) pra fechar o caminho irmão de cancelar pedido inteiro pela aba compras.

**(c) P039 correlato** — em `src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts`, após cancelar a fila (linha 153-160) e antes do `registrarEvento`, liberar a R do pedido. Importar:

```typescript
// topo — adicionar:
import { estornarReservaIndividual } from "@/lib/wms/reservas";
```

```typescript
// após o UPDATE da fila (linha 160), antes do registrarEvento (linha 162):
    {
      const { data: reservasAbertas } = await supabase
        .from("siso_movimentacoes")
        .select("id")
        .eq("tipo", "R")
        .eq("origem_tipo", "reserva_pedido")
        .eq("origem_id", String(pedidoId));
      for (const r of (reservasAbertas ?? []) as Array<{ id: string }>) {
        try {
          await estornarReservaIndividual({ reserva_id: r.id, motivo: "outro", usuario_id: session.id });
        } catch (e) {
          logger.warn("compras-cancelar-pedido", "falha estornando R no cancelamento (segue)", {
            pedidoId,
            reserva_id: r.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
```

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npm run scenarios -- --only 84-cancelar-item`
  - Expected: PASS — reservado=0, sem reservas órfãs.

- [ ] Step 5 — Commit:
  - `git add src/lib/compras-utils.ts "src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts" "src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts" scripts/wms/cenarios/catalogo/84-cancelar-item-libera-reserva.ts`
  - `git commit -m "fix(wms): cancelamento de compra (item/pedido/all-terminal) libera reserva R no ato (P038, P039)"`

### Task 4.3: Registrar P034/P038/P039 em erros-conhecidos.yaml

- [ ] Step 1 — Adicionar entrada:

```yaml
  - id: cancelamento-nao-libera-reserva-operador
    date: "2026-06-05"
    source: wms/pedidos/aprovar, wms/compras-utils, wms/compras/itens/cancelamento, wms/compras/pedidos/cancelar
    category: business_logic
    message: "Caminhos de cancelamento acionados pelo operador (Recusar pedido, cancelar item/pedido de compra) cancelavam o pedido sem liberar a reserva R viva — estoque ficava preso até TTL 30d ou cron 1h."
    cause: >
      Só os caminhos admin (/pedidos/[id]/estornar) e webhook (webhook/tiny) liberavam R.
      O bloco 'rejeitado' de /pedidos/aprovar, checkAndCancelPedidoIfAllTerminal e
      cancelamento/confirmar não chamavam estornarReservaIndividual/liberarReserva.
    fix: >
      'rejeitado' de aprovar e checkAndCancelPedidoIfAllTerminal e compras/pedidos/cancelar
      passam a estornar cada R viva via estornarReservaIndividual (idempotente por estorno_de).
      cancelamento/confirmar libera via liberarReserva (pedido-scoped) quando o pedido não foi
      cancelado pela função (caso multi-item) — mesma limitação aceita em equivalente/confirmar.
    files:
      - src/app/api/wms/pedidos/aprovar/route.ts
      - src/lib/compras-utils.ts
      - src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts
      - src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts
      - scripts/wms/cenarios/catalogo/34-recusar-pedido-libera-r.ts
      - scripts/wms/cenarios/catalogo/84-cancelar-item-libera-reserva.ts
    tags: [cancelamento, reserva, liberar, compras, recusar, P034, P038, P039]
```

- [ ] Step 2 — Commit:
  - `git add erros-conhecidos.yaml`
  - `git commit -m "docs: registra cancelamento-nao-libera-reserva-operador (P034, P038, P039)"`

---

## PR 5: [D1] Cancelar pedido em separação parcial: libera só não-pego, pego vira pendência de devolução manual [P007]

> **Decisão do dono (D1, VINCULANTE):** "Cancelar só o que não foi pego: liberar estoque do item NÃO pego e devolver o item já pego de forma manual (operador refaz a entrada)". **Estender ao marketplace também** — aplicar tanto na venda manual (`cancelarVendaManual`) QUANTO no fluxo `/separacao/cancelar` dos pedidos de marketplace. Blast maior — toca o caminho quente de separação; tratar com cuidado.
>
> **Estado atual (ancorado):** `vendas-cancelamento.ts:61-65` HOJE BLOQUEIA (`throw 'pedido em separação ativa'`) quando `status_separacao ∈ {em_separacao, separado, embalado}` — isso é a OPÇÃO 1, não a decisão. Único caller: `vendas/[id]/cancelar/route.ts` (vendas manuais MAN-*). O fluxo de marketplace cancela via `/separacao/cancelar` (que hoje estorna TODAS as movs S e volta o pedido pra `aguardando_separacao`/`aguardando_compra` — NÃO marca cancelado nem trata pego×não-pego). A decisão D1 redefine: em `em_separacao`, item com `mov_saida_id` (pego) NÃO é estornado (mov S permanece, auditoria preservada) e vira pendência de devolução manual; item sem pick tem a R liberada; pedido marcado cancelado.
>
> **Escopo desta PR:** sem migration/RPC (finding `needs_migration:false` na re-investigação — o conflito-mestre marcou MIGRATION/RPC mas a re-investigação confirmou que a implementação atual é app-layer; a atomicidade é por-pedido sequencial com idempotência por `estorno_de`, suficiente pro volume). Implementamos a função pura de classificação pego×não-pego (unit-testável) + o wiring em `cancelarVendaManual` + um flag de modo no `/separacao/cancelar` pra o caminho marketplace.

> **Nota de divergência do conflito-mestre:** o mestre rotulou P007 como `[MIGRATION/RPC]`. A re-investigação (`_reinvest_findings.json`) marcou `needs_migration:false` e ancorou a mudança em `vendas-cancelamento.ts`. Seguimos a re-investigação (autoridade sobre o código ATUAL): SEM RPC. Atomicidade garantida por idempotência de `estornarReservaIndividual`/estorno (re-execução não duplica). Marcado como open question abaixo pra confirmação.

### Task 5.1: RED unit — função pura `classificarItensParaCancelamento` (pego×não-pego)

**Files:**
- Create: `src/lib/wms/cancelamento-parcial.ts`
- Test: `src/lib/wms/cancelamento-parcial.test.ts`

- [ ] Step 1 — Escrever o teste que falha:

```typescript
// src/lib/wms/cancelamento-parcial.test.ts
import { describe, it, expect } from "vitest";
import { classificarItensParaCancelamento } from "./cancelamento-parcial";

describe("classificarItensParaCancelamento", () => {
  it("separa pego (mov_saida_id != null) de não-pego", () => {
    const r = classificarItensParaCancelamento([
      { id: "i1", sku: "SKU-A", mov_saida_id: "mov-1", quantidade_pega: 1 },
      { id: "i2", sku: "SKU-B", mov_saida_id: null, quantidade_pega: null },
    ]);
    expect(r.pegos.map((i) => i.id)).toEqual(["i1"]);
    expect(r.naoPegos.map((i) => i.id)).toEqual(["i2"]);
  });

  it("item com quantidade_pega>0 mas sem mov_saida_id ainda conta como pego (parcial em curso)", () => {
    const r = classificarItensParaCancelamento([
      { id: "i3", sku: "SKU-C", mov_saida_id: null, quantidade_pega: 2 },
    ]);
    expect(r.pegos.map((i) => i.id)).toEqual(["i3"]);
    expect(r.naoPegos).toEqual([]);
  });

  it("lista vazia → ambos vazios", () => {
    const r = classificarItensParaCancelamento([]);
    expect(r.pegos).toEqual([]);
    expect(r.naoPegos).toEqual([]);
  });
});
```

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npm test -- src/lib/wms/cancelamento-parcial.test.ts`
  - Expected: FAIL — `Cannot find module './cancelamento-parcial'`.

- [ ] Step 3 — Implementação mínima:

```typescript
// src/lib/wms/cancelamento-parcial.ts

export interface ItemCancelavel {
  id: string;
  sku: string | null;
  mov_saida_id: string | null;
  quantidade_pega: number | null;
}

export interface ClassificacaoCancelamento {
  /** Itens já picados/em-pick: NÃO estornar (auditoria); viram pendência de devolução manual. */
  pegos: ItemCancelavel[];
  /** Itens sem pick: liberar a reserva R. */
  naoPegos: ItemCancelavel[];
}

/**
 * D1 (P007): classifica itens de um pedido em separação parcial.
 * Pego = tem mov_saida_id OU quantidade_pega>0 (saída física já ocorreu).
 * Não-pego = nenhum dos dois (só reserva R viva).
 */
export function classificarItensParaCancelamento(
  itens: ItemCancelavel[],
): ClassificacaoCancelamento {
  const pegos: ItemCancelavel[] = [];
  const naoPegos: ItemCancelavel[] = [];
  for (const it of itens) {
    const pego = !!it.mov_saida_id || Number(it.quantidade_pega ?? 0) > 0;
    if (pego) pegos.push(it);
    else naoPegos.push(it);
  }
  return { pegos, naoPegos };
}
```

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npm test -- src/lib/wms/cancelamento-parcial.test.ts`
  - Expected: PASS — 3 testes verdes.

- [ ] Step 5 — Commit:
  - `git add src/lib/wms/cancelamento-parcial.ts src/lib/wms/cancelamento-parcial.test.ts`
  - `git commit -m "feat(wms): classificarItensParaCancelamento (pego×não-pego) — base D1 (P007)"`

### Task 5.2: RED scenario — cancelar venda manual em em_separacao parcial libera só não-pego

**Files:**
- Modify: `src/lib/wms/vendas-cancelamento.ts:60-89`
- Modify: `src/app/api/wms/vendas/[id]/cancelar/route.ts:48-51`
- Create: `scripts/wms/cenarios/catalogo/83-cancelar-pedido-em-separacao-parcial.ts`
- Test: o cenário catalogo

- [ ] Step 1 — Escrever o teste que falha:

```typescript
// scripts/wms/cenarios/catalogo/83-cancelar-pedido-em-separacao-parcial.ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 83 — D1: cancelar venda manual em em_separacao parcial (P007).
 *
 * Pedido com 2 itens em em_separacao: item1 já picado (mov_saida_id != null),
 * item2 sem pick. POST cancelar:
 *  - reserva R do item2 liberada (reservado baixa)
 *  - item1 NÃO estornado (mov S permanece, auditoria)
 *  - response lista item1 como pendente_devolucao_manual
 *  - pedido marcado cancelado
 * RED hoje: endpoint retorna 400 bloqueando tudo.
 */
type Setup = { skuA: string; skuB: string; pedidoId: string };

export default {
  nome: "83 — D1: cancelar venda manual em separação parcial (P007)",
  descricao: "em_separacao com 1 item pego e 1 não-pego → libera só não-pego, pego vira devolução manual.",
  tags: ["cancelamento", "separacao", "parcial", "venda-manual", "D1", "P007"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const skuA = ctx.skuUnico("83a");
    const skuB = ctx.skuUnico("83b");
    await ctx.criarProduto({ sku: skuA, descricao: "Parcial cancel A" });
    await ctx.criarProduto({ sku: skuB, descricao: "Parcial cancel B" });
    await ctx.semearSaldo({ produto: skuA, galpao: "CWB", loc: "A-01-02", qty: 5 });
    await ctx.semearSaldo({ produto: skuB, galpao: "CWB", loc: "A-01-03", qty: 5 });
    return { skuA, skuB, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { skuA, skuB } = setup;
    // Venda manual em modo separação (cria R pros dois itens).
    const venda = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku: skuA, qty: 1 }, { sku: skuB, qty: 1 }],
      modo: "separacao",
    });
    const pedidoId = String(venda.pedido_id ?? venda.id);
    setup.pedidoId = pedidoId;

    // Força em_separacao e pica SÓ o item A (mov_saida_id != null) via S direto.
    const { data: itens } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, sku")
      .eq("pedido_id", pedidoId);
    const itemA = (itens ?? []).find((i) => (i as { sku: string }).sku === skuA) as { id: string };

    await ctx.sb.from("siso_pedidos").update({ status_separacao: "em_separacao" }).eq("id", pedidoId);
    // Marca item A como pego: seta mov_saida_id (placeholder) + quantidade_pega.
    // (No fluxo real o pick insere S + grava mov_saida_id; aqui isolamos o sinal.)
    const { data: gA } = await ctx.sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: lA } = await ctx.sb.from("siso_localizacoes").select("id").eq("galpao_id", (gA as { id: string }).id).eq("codigo", "A-01-02").single();
    const { data: pA } = await ctx.sb.from("siso_produtos").select("id").eq("sku", skuA).single();
    // S real pra refletir saída física do item A.
    const { data: movS } = await ctx.sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: (pA as { id: string }).id,
      p_galpao_id: (gA as { id: string }).id,
      p_localizacao_id: (lA as { id: string }).id,
      p_tipo: "S",
      p_quantidade: 1,
      p_origem_tipo: "venda_manual",
      p_origem_id: pedidoId,
      p_custo_unitario: null,
      p_motivo: "pick item A (cenário 83)",
    });
    await ctx.sb.from("siso_pedido_itens").update({ mov_saida_id: String(movS as unknown as string), quantidade_pega: 1 }).eq("id", itemA.id);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { skuA, skuB, pedidoId } = setup;

    // POST cancelar.
    const resp = await ctx.http.post<{ itens_para_devolver_manual?: Array<{ id: string; sku: string }> }>(
      `/api/wms/vendas/${pedidoId}/cancelar`,
      { motivo: "cancelamento em separação parcial" },
    );

    // item B (não-pego) → reserva liberada.
    await ctx.assertReservado(skuB, "CWB", "A-01-03", 0);
    // item A (pego) → mov S permanece (auditoria): saldo de A baixou 1 e NÃO foi estornado.
    await ctx.assertSaldo(skuA, "CWB", "A-01-02", 4);
    // response lista A como devolução manual.
    const lista = resp.itens_para_devolver_manual ?? [];
    if (!lista.some((i) => i.sku === skuA)) {
      throw new Error(`P007: esperava ${skuA} em itens_para_devolver_manual, got ${JSON.stringify(lista)}`);
    }
    // pedido cancelado.
    const { data: pedido } = await ctx.sb.from("siso_pedidos").select("status").eq("id", pedidoId).single();
    if ((pedido as { status: string }).status !== "cancelado") {
      throw new Error(`P007: status esperado 'cancelado', got '${(pedido as { status: string }).status}'`);
    }
    await ctx.assertSemReservasOrfas();
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

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npm run scenarios -- --only 83-cancelar-pedido`
  - Expected: FAIL — o endpoint retorna 400 (`separação ativa`) → `ctx.http.post` lança `HttpError`, cenário falha em run/assert.

- [ ] Step 3 — Implementação mínima:

**(a)** Em `src/lib/wms/vendas-cancelamento.ts`, substituir o bloco de bloqueio (60-65) por um caminho que trata `em_separacao` parcial; e estender o retorno com `itensParaDevolverManual`. Importar a função pura + `estornarReservaIndividual`:

```typescript
// topo de vendas-cancelamento.ts — adicionar:
import { estornarReservaIndividual } from "./reservas";
import { classificarItensParaCancelamento } from "./cancelamento-parcial";
```

Mudar a assinatura de retorno e o corpo:

```typescript
// substituir a assinatura de retorno (linha 31):
): Promise<{ movsEstornadas: number; reservasLiberadas: number; itensParaDevolverManual: Array<{ id: string; sku: string | null }> }> {
```

```typescript
// substituir o bloco 60-65 (o throw de "separação ativa") por:

  let itensParaDevolverManual: Array<{ id: string; sku: string | null }> = [];

  // D1 (P007): em separação parcial, libera SÓ o não-pego; o pego (mov_saida_id)
  // NÃO é estornado (auditoria preservada) e vira pendência de devolução manual.
  if (["em_separacao", "separado", "embalado"].includes(p.status_separacao ?? "")) {
    const { data: itensRaw } = await sb
      .from("siso_pedido_itens")
      .select("id, sku, mov_saida_id, quantidade_pega")
      .eq("pedido_id", input.pedido_id);
    const { pegos, naoPegos } = classificarItensParaCancelamento(
      (itensRaw ?? []).map((i) => ({
        id: String(i.id),
        sku: (i.sku as string) ?? null,
        mov_saida_id: (i.mov_saida_id as string) ?? null,
        quantidade_pega: (i.quantidade_pega as number) ?? null,
      })),
    );
    itensParaDevolverManual = pegos.map((i) => ({ id: i.id, sku: i.sku }));

    // Libera a R viva do pedido SÓ pra itens não-pegos. estornarReservaIndividual
    // é por-R; buscamos as R vivas e estornamos cada uma (o cache reservado baixa).
    // Como a R é por (produto, galpão, loc), e o item pego já consumiu a sua R no
    // pick (virou S), só restam R vivas dos não-pegos — estornar todas é seguro.
    const { data: reservasAbertas } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("origem_id", input.pedido_id);
    for (const r of (reservasAbertas ?? []) as Array<{ id: string }>) {
      try {
        await estornarReservaIndividual({ reserva_id: r.id, motivo: "outro", usuario_id: input.usuario_id });
        reservasLiberadas++;
      } catch (e) {
        logger.warn("wms.vendas.cancelar", "falha estornando R não-pego (segue)", {
          pedido_id: input.pedido_id,
          reserva_id: r.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Marca cancelado. NÃO estorna as S dos pegos (operador refaz entrada).
    const { error: updErr } = await sb
      .from("siso_pedidos")
      .update({ status: "cancelado" })
      .eq("id", input.pedido_id);
    if (updErr) throw new Error(`falha ao atualizar status: ${updErr.message}`);

    registrarEvento({
      pedidoId: input.pedido_id,
      evento: "cancelado",
      usuarioId: input.usuario_id,
      detalhes: {
        motivo: input.motivo,
        modo: "separacao_parcial",
        reservas_liberadas: reservasLiberadas,
        itens_devolucao_manual: itensParaDevolverManual,
        origem: "cancelarVendaManual",
      },
    }).catch(() => {});

    return { movsEstornadas: 0, reservasLiberadas, itensParaDevolverManual };
  }
```

> Nota: `reservasLiberadas` já é declarado na linha 68 (`let reservasLiberadas = 0;`). O bloco D1 acima é inserido logo após essa declaração (mover a declaração de `movsEstornadas`/`reservasLiberadas` pra ANTES deste bloco, ou inserir o bloco depois delas). A âncora atual é: linhas 67-68 declaram `movsEstornadas`/`reservasLiberadas`; o bloco D1 entra no lugar do antigo throw (que ficava ANTES delas, em 60-65) — portanto **mover a declaração de `movsEstornadas`/`reservasLiberadas` (67-68) pra cima** (antes do bloco D1) e declarar `itensParaDevolverManual` junto.

E no `return` final (linha 147), incluir `itensParaDevolverManual`:

```typescript
  return { movsEstornadas, reservasLiberadas, itensParaDevolverManual };
```

**(b)** Em `src/app/api/wms/vendas/[id]/cancelar/route.ts`, remover `"separação ativa"` da classificação 400 (já não bloqueamos) e propagar o payload. Substituir linhas 39-51:

```typescript
  try {
    const r = await cancelarVendaManual({
      pedido_id: id,
      usuario_id: auth.user.id,
      motivo,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient =
      msg.includes("não encontrado") ||
      msg.includes("motivo");
```

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npm run scenarios -- --only 83-cancelar-pedido`
  - Expected: PASS — item B reservado=0, item A saldo=4 (S preservada), A em `itens_para_devolver_manual`, pedido cancelado, sem órfãs. E `npm test -- src/lib/wms/cancelamento-parcial.test.ts` continua verde.

- [ ] Step 5 — Commit:
  - `git add src/lib/wms/vendas-cancelamento.ts "src/app/api/wms/vendas/[id]/cancelar/route.ts" scripts/wms/cenarios/catalogo/83-cancelar-pedido-em-separacao-parcial.ts`
  - `git commit -m "feat(wms): D1 — cancelar venda manual em separação parcial libera só não-pego, pego vira devolução manual (P007)"`

### Task 5.3: Estender D1 ao marketplace via `/separacao/cancelar` (modo cancelar-pedido)

**Files:**
- Modify: `src/app/api/wms/separacao/cancelar/route.ts`
- Modify: `scripts/wms/cenarios/catalogo/83-cancelar-pedido-em-separacao-parcial.ts` (adicionar caso marketplace) OU criar `83b-cancelar-marketplace-parcial.ts`
- Test: cenário catalogo

D1 exige cobrir o caminho de marketplace. `/separacao/cancelar` hoje SEMPRE "volta etapa" (estorna todas as S e devolve pra aguardando_separacao). Adicionamos um modo opcional `cancelar_pedido: boolean` no body: quando `true`, aplica a semântica D1 (libera só não-pego, preserva S dos pegos, marca pedido `cancelado`, retorna `itens_para_devolver_manual`). Default (`false`/ausente) mantém o comportamento atual de voltar-etapa.

- [ ] Step 1 — Escrever o teste que falha (caso marketplace):

```typescript
// scripts/wms/cenarios/catalogo/83b-cancelar-marketplace-parcial.ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 83b — D1 marketplace: /separacao/cancelar com cancelar_pedido=true (P007).
 *
 * Pedido marketplace em em_separacao, item1 pego (mov S real) e item2 não-pego.
 * POST /separacao/cancelar { pedido_ids, cancelar_pedido:true }:
 *  - item2 reserva liberada; item1 S preservada (não estornada)
 *  - pedido status='cancelado'; response itens_para_devolver_manual contém item1
 */
type Setup = { skuA: string; skuB: string; pedidoId: string };

export default {
  nome: "83b — D1 marketplace: /separacao/cancelar cancelar_pedido (P007)",
  descricao: "marketplace em_separacao parcial → libera só não-pego via /separacao/cancelar.",
  tags: ["cancelamento", "separacao", "parcial", "marketplace", "D1", "P007"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const skuA = ctx.skuUnico("83ba");
    const skuB = ctx.skuUnico("83bb");
    await ctx.criarProduto({ sku: skuA, descricao: "MP parcial A" });
    await ctx.criarProduto({ sku: skuB, descricao: "MP parcial B" });
    await ctx.semearSaldo({ produto: skuA, galpao: "CWB", loc: "A-01-02", qty: 5 });
    await ctx.semearSaldo({ produto: skuB, galpao: "CWB", loc: "A-01-03", qty: 5 });
    return { skuA, skuB, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { skuA, skuB } = setup;
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku: skuA, qty: 1 }, { sku: skuB, qty: 1 }],
    });
    setup.pedidoId = id;
    await ctx.aguardarStatus(id, "executando", undefined, { timeout_ms: 20000 });
    await ctx.sb.from("siso_pedidos").update({ status_separacao: "em_separacao" }).eq("id", id);

    // Pica item A: S real + mov_saida_id.
    const { data: itens } = await ctx.sb.from("siso_pedido_itens").select("id, sku").eq("pedido_id", id);
    const itemA = (itens ?? []).find((i) => (i as { sku: string }).sku === skuA) as { id: string };
    const { data: gA } = await ctx.sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: lA } = await ctx.sb.from("siso_localizacoes").select("id").eq("galpao_id", (gA as { id: string }).id).eq("codigo", "A-01-02").single();
    const { data: pA } = await ctx.sb.from("siso_produtos").select("id").eq("sku", skuA).single();
    const { data: movS } = await ctx.sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: (pA as { id: string }).id,
      p_galpao_id: (gA as { id: string }).id,
      p_localizacao_id: (lA as { id: string }).id,
      p_tipo: "S",
      p_quantidade: 1,
      // 'venda_manual' é valor válido do CHECK siso_movimentacoes_origem_tipo_check
      // (20260527_origem_tipo_devolucao_troca_sku.sql) e espelha o seed do cenário 83
      // (linha p_origem_tipo: "venda_manual"). NÃO usar 'separacao' — não existe no CHECK
      // e o seed estouraria CHECK violation antes do assert. (O pick real usa 'nf_venda',
      // também válido; aqui usamos 'venda_manual' por simetria com o cenário 83.)
      p_origem_tipo: "venda_manual",
      p_origem_id: id,
      p_custo_unitario: null,
      p_motivo: "pick item A (cenário 83b)",
    });
    await ctx.sb.from("siso_pedido_itens").update({ mov_saida_id: String(movS as unknown as string), quantidade_pega: 1 }).eq("id", itemA.id);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { skuA, skuB, pedidoId } = setup;
    const resp = await ctx.http.post<{ itens_para_devolver_manual?: Array<{ id: string; sku: string }> }>(
      "/api/wms/separacao/cancelar",
      { pedido_ids: [pedidoId], cancelar_pedido: true },
    );
    await ctx.assertReservado(skuB, "CWB", "A-01-03", 0);
    await ctx.assertSaldo(skuA, "CWB", "A-01-02", 4); // S preservada
    const lista = resp.itens_para_devolver_manual ?? [];
    if (!lista.some((i) => i.sku === skuA)) {
      throw new Error(`P007 mp: esperava ${skuA} em itens_para_devolver_manual`);
    }
    const { data: pedido } = await ctx.sb.from("siso_pedidos").select("status").eq("id", pedidoId).single();
    if ((pedido as { status: string }).status !== "cancelado") {
      throw new Error(`P007 mp: status esperado 'cancelado', got '${(pedido as { status: string }).status}'`);
    }
    await ctx.assertSemReservasOrfas();
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

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npm run scenarios -- --only 83b-cancelar-marketplace`
  - Expected: FAIL — sem o modo `cancelar_pedido`, a rota estorna a S de A (saldo volta a 5) e devolve pra `aguardando_separacao` (não cancela). Asserts de saldo=4/status=cancelado falham.

- [ ] Step 3 — Implementação mínima:

Em `src/app/api/wms/separacao/cancelar/route.ts`, adicionar o branch D1 no topo do `try` (após validar `pedido_ids`). Importar os helpers:

```typescript
// topo — adicionar:
import { classificarItensParaCancelamento } from "@/lib/wms/cancelamento-parcial";
import { estornarReservaIndividual } from "@/lib/wms/reservas";
```

Logo após `const { pedido_ids } = body as ...` (linha 45) e antes do `const supabase = createServiceClient();` (linha 46) NÃO — o supabase precisa existir. Inserir o branch logo após `const supabase = createServiceClient();` (linha 46) e antes do `try` da linha 48, OU dentro do try no início. Inserir no INÍCIO do `try` (após linha 48):

```typescript
  const cancelarPedido = body.cancelar_pedido === true;

  // D1 (P007): modo cancelar-pedido em separação parcial. Libera só o não-pego;
  // o pego (mov_saida_id) NÃO é estornado (auditoria), vira devolução manual;
  // pedido vira 'cancelado'. Não passa pelo fluxo de voltar-etapa abaixo.
  if (cancelarPedido) {
    try {
      const { data: itensRaw } = await supabase
        .from("siso_pedido_itens")
        .select("id, sku, mov_saida_id, quantidade_pega")
        .in("pedido_id", pedido_ids);
      const { pegos } = classificarItensParaCancelamento(
        (itensRaw ?? []).map((i) => ({
          id: String(i.id),
          sku: (i.sku as string) ?? null,
          mov_saida_id: (i.mov_saida_id as string) ?? null,
          quantidade_pega: (i.quantidade_pega as number) ?? null,
        })),
      );
      const itensParaDevolverManual = pegos.map((i) => ({ id: i.id, sku: i.sku }));

      // Libera R vivas (só restam as dos não-pegos — pego já consumiu a R no pick).
      const { data: reservasAbertas } = await supabase
        .from("siso_movimentacoes")
        .select("id")
        .eq("tipo", "R")
        .eq("origem_tipo", "reserva_pedido")
        .in("origem_id", pedido_ids);
      let reservasLiberadas = 0;
      for (const r of (reservasAbertas ?? []) as Array<{ id: string }>) {
        try {
          await estornarReservaIndividual({ reserva_id: r.id, motivo: "outro", usuario_id: session.id });
          reservasLiberadas++;
        } catch (e) {
          logger.warn("separacao-cancelar", "falha estornando R não-pego (segue)", {
            reserva_id: r.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      await supabase
        .from("siso_pedidos")
        .update({ status: "cancelado", status_separacao: "cancelado" })
        .in("id", pedido_ids);

      await supabase
        .from("siso_fila_execucao")
        .update({ status: "cancelado", atualizado_em: new Date().toISOString() })
        .in("pedido_id", pedido_ids)
        .in("status", ["pendente", "executando", "erro"]);

      logger.warn("separacao-cancelar", "Pedido(s) cancelado(s) em separação parcial (D1)", {
        pedido_ids,
        reservas_liberadas: reservasLiberadas,
        itens_devolucao_manual: itensParaDevolverManual.length,
      });

      return NextResponse.json({
        ok: true,
        pedido_ids,
        cancelado: true,
        reservas_liberadas: reservasLiberadas,
        itens_para_devolver_manual: itensParaDevolverManual,
      });
    } catch (err) {
      logger.error("separacao-cancelar", "Erro no cancelar-pedido D1", {
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "Erro interno" }, { status: 500 });
    }
  }
```

E adicionar `cancelar_pedido?: boolean` ao type do body inferido (o body é lido como `any` via `await request.json()`; já há `const { pedido_ids } = body as { pedido_ids: string[] };` — basta ler `body.cancelar_pedido`).

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npm run scenarios -- --only 83b-cancelar-marketplace` (e re-rodar `--only 83-cancelar-pedido` pra garantir no-regress)
  - Expected: PASS — item B reservado=0, item A saldo=4, A em devolução manual, status cancelado, sem órfãs.

- [ ] Step 5 — Commit:
  - `git add "src/app/api/wms/separacao/cancelar/route.ts" scripts/wms/cenarios/catalogo/83b-cancelar-marketplace-parcial.ts`
  - `git commit -m "feat(wms): D1 — /separacao/cancelar modo cancelar_pedido estende cancelamento parcial ao marketplace (P007)"`

### Task 5.4: Registrar P007 em erros-conhecidos.yaml

- [ ] Step 1 — Adicionar entrada:

```yaml
  - id: cancelar-em-separacao-parcial-bloqueava-tudo
    date: "2026-06-05"
    source: wms/vendas-cancelamento, wms/separacao/cancelar
    category: business_logic
    message: "Cancelar pedido em separação parcial bloqueava 100% (venda manual: throw 'separação ativa') OU estornava tudo (marketplace: /separacao/cancelar) — não tratava pego×não-pego."
    cause: >
      cancelarVendaManual adotava a OPÇÃO 1 (bloquear) — contra a decisão D1 (OPÇÃO 2).
      /separacao/cancelar sempre fazia voltar-etapa (estornava todas as S).
    fix: >
      classificarItensParaCancelamento (pura) separa pego (mov_saida_id || quantidade_pega>0)
      de não-pego. cancelarVendaManual e /separacao/cancelar (modo cancelar_pedido:true) liberam
      só a R dos não-pegos, preservam a S dos pegos (auditoria), marcam pedido cancelado e
      retornam itens_para_devolver_manual. Estendido ao marketplace via /separacao/cancelar (D1).
    files:
      - src/lib/wms/cancelamento-parcial.ts
      - src/lib/wms/vendas-cancelamento.ts
      - src/app/api/wms/vendas/[id]/cancelar/route.ts
      - src/app/api/wms/separacao/cancelar/route.ts
      - scripts/wms/cenarios/catalogo/83-cancelar-pedido-em-separacao-parcial.ts
      - scripts/wms/cenarios/catalogo/83b-cancelar-marketplace-parcial.ts
    tags: [cancelamento, separacao, parcial, devolucao-manual, D1, P007]
```

- [ ] Step 2 — Commit:
  - `git add erros-conhecidos.yaml`
  - `git commit -m "docs: registra cancelar-em-separacao-parcial-bloqueava-tudo (P007)"`

---

## PR 6: Reserva all-or-nothing no webhook auto-aprovação + dedup R viva por (pedido,produto) [P085, P003]

> **Decisão do dono (NOTA):** P085 — "rejeitar TODA a aprovação se qualquer item falhar ao apartar; loja retenta" (opção 1, explicitamente acima da opção 2). P003 — "RESOLVIDO: dedup idempotente — antes de reservar, checar mov R viva por (pedido,produto) e pular. SEM advisory lock (infra nova descartada)."
>
> **Estado atual (ancorado):**
> - **P085:** `webhook-processor-wms.ts:597-604` — cada `reservarAtomico` está num try/catch que só faz `logger.warn` e CONTINUA. Depois (615-636) `isAuto` enfileira `lancar_estoque` como se 100% aprovado. Pedido segue com SKU-B sem reserva.
> - **P003:** `reservas.ts:20-36` (`reservarAtomico`) só chama a RPC; a RPC `wms_reservar_atomico` NÃO é idempotente — sempre insere nova R. Dois reprocessos rápidos → duas R por (pedido,produto) → reservado dobrado. O early-return por `estoque_lancado===true` (webhook 437-456) não cobre pedido não-lançado reprocessado.
>
> **Coordenação P085×P003:** P003 (dedup em `reservarAtomico`) é a base — torna a re-reserva idempotente, o que P085 precisa pro `throw→retry` não duplicar R. Implementar P003 PRIMEIRO (Task 6.1), depois P085 (Task 6.2).

### Task 6.1: RED integration — `reservarAtomico` não dedupa R viva por (pedido,produto) (P003)

**Files:**
- Modify: `src/lib/wms/reservas.ts:20-36`
- Create: `test/integration/reservas-idempotente.integration.test.ts`
- Test: integration

- [ ] Step 1 — Escrever o teste que falha:

```typescript
// test/integration/reservas-idempotente.integration.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { reservarAtomico } from "../../src/lib/wms/reservas";

const sb = createServiceClient();
const SKU = `TEST-INT-RES-IDEMP-${Math.random().toString(36).slice(2, 8)}`;
const PEDIDO = `int-res-idemp-${Date.now()}`;
let produtoId: string, galpaoId: string, locId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("codigo", "A-01-02")
    .single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "Reservas idemp test", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: locId,
    p_tipo: "E",
    p_quantidade: 10,
    p_origem_tipo: "inventario_inicial",
    p_origem_id: null,
    p_custo_unitario: null,
    p_motivo: "seed",
  });
});

describe("reservarAtomico — dedup R viva por (pedido,produto) (P003)", () => {
  it("duas chamadas pro mesmo (pedido,produto,tripla) → 1 R viva, reservado não dobra", async () => {
    const tripla = { produto_id: produtoId, galpao_id: galpaoId, localizacao_id: locId };

    const id1 = await reservarAtomico({ tripla, qty: 5, pedido_id: PEDIDO, ttl_horas: 1 });
    const id2 = await reservarAtomico({ tripla, qty: 5, pedido_id: PEDIDO, ttl_horas: 1 });

    // Idempotente: a 2ª chamada retorna o id da R existente (mesmo id) e NÃO cria outra.
    expect(id2).toBe(id1);

    const { count } = await sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("origem_id", PEDIDO)
      .eq("produto_id", produtoId);
    expect(count).toBe(1);

    const { data: est } = await sb
      .from("siso_estoque")
      .select("reservado")
      .eq("produto_id", produtoId)
      .single();
    expect(Number(est?.reservado)).toBe(5); // não 10
  });
});
```

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npm run test:integration -- test/integration/reservas-idempotente.integration.test.ts`
  - Expected: FAIL — `expect(id2).toBe(id1)` falha (ids diferentes), `count` é 2, `reservado` é 10.

- [ ] Step 3 — Implementação mínima:

Em `src/lib/wms/reservas.ts`, em `reservarAtomico`, ANTES de chamar a RPC, checar se já existe uma R viva (sem L estornando) por (pedido, produto, tripla); se existir, retornar o id existente (skip). SEM advisory lock (decisão D vinculante).

```typescript
// substituir reservarAtomico (linhas 20-36):
export async function reservarAtomico(input: ReservarInput): Promise<string> {
  const sb = createServiceClient();

  // P003: dedup idempotente — se já existe R viva por (pedido,produto,tripla),
  // retorna o id existente sem inserir nova R. Evita reservado dobrado em
  // reprocessamento/duplo-clique. SEM advisory lock (infra nova descartada).
  const { data: rsExistentes } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("origem_id", input.pedido_id)
    .eq("produto_id", input.tripla.produto_id)
    .eq("galpao_id", input.tripla.galpao_id)
    .eq("localizacao_id", input.tripla.localizacao_id);
  const ids = (rsExistentes ?? []).map((r) => r.id as string);
  if (ids.length > 0) {
    // R é "viva" se não tem L (estorno_de) apontando pra ela.
    const { data: ls } = await sb
      .from("siso_movimentacoes")
      .select("estorno_de")
      .in("estorno_de", ids)
      .eq("tipo", "L");
    const liberadas = new Set(
      (ls ?? []).map((l) => l.estorno_de as string | null).filter((x): x is string => !!x),
    );
    const viva = ids.find((id) => !liberadas.has(id));
    if (viva) {
      logger.info("wms.reservas", "R viva já existe — skip idempotente", {
        pedido_id: input.pedido_id,
        produto_id: input.tripla.produto_id,
        reserva_id: viva,
      });
      return viva;
    }
  }

  const { data, error } = await sb.rpc("wms_reservar_atomico", {
    p_produto_id: input.tripla.produto_id,
    p_galpao_id: input.tripla.galpao_id,
    p_localizacao_id: input.tripla.localizacao_id,
    p_quantidade: input.qty,
    p_pedido_id: input.pedido_id,
    p_ttl_horas: input.ttl_horas ?? 48,
    p_usuario_id: input.usuario_id ?? null,
  });
  if (error) {
    logger.error("wms.reservas", "falha ao reservar", { error, input });
    throw error;
  }
  return data as unknown as string;
}
```

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npm run test:integration -- test/integration/reservas-idempotente.integration.test.ts`
  - Expected: PASS — `id2===id1`, `count===1`, `reservado===5`. Também re-rodar `npm run test:integration -- test/integration/reservas-rpc.test.ts` pra confirmar no-regress.

- [ ] Step 5 — Commit:
  - `git add src/lib/wms/reservas.ts test/integration/reservas-idempotente.integration.test.ts`
  - `git commit -m "fix(wms): reservarAtomico dedupa R viva por (pedido,produto,tripla) — idempotente (P003)"`

### Task 6.2: RED integration — webhook auto-aprovação engole falha de reserva parcial (P085)

**Files:**
- Modify: `src/lib/webhook-processor-wms.ts:582-636`
- Create: `test/integration/webhook-reserva-all-or-nothing.integration.test.ts`
- Test: integration

> Estratégia do teste: invocar `processWebhookWms` diretamente não é trivial (depende de payload Tiny + dedup). O sinal isolável é a **subfunção do loop de reserva** — refatoramos o loop pra coletar falhas e, se houver qualquer falha, NÃO enfileirar + sinalizar erro. O teste integration exercita o comportamento via a função pública mais próxima. Como o achado pede `processWebhookWms`, e isso exige um stub Tiny completo, **testamos o invariante observável**: forçar a 2ª reserva a falhar (loc sem saldo) e assegurar que (a) o pedido NÃO ganha job `lancar_estoque` e (b) NÃO fica meio-aprovado (1 R só). Fazemos isso reproduzindo o loop num helper exportado `criarReservasRotaAtomico` testável.

- [ ] Step 1 — Escrever o teste que falha:

```typescript
// test/integration/webhook-reserva-all-or-nothing.integration.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { criarReservasRotaAtomico } from "../../src/lib/webhook-processor-wms";

const sb = createServiceClient();
const SKU_A = `TEST-INT-AON-A-${Math.random().toString(36).slice(2, 6)}`;
const SKU_B = `TEST-INT-AON-B-${Math.random().toString(36).slice(2, 6)}`;
const PEDIDO = `int-aon-${Date.now()}`;
let prodA: string, prodB: string, galpaoId: string, locId: string, locVazia: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-02").single();
  locId = l!.id;
  const { data: lv } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-03").single();
  locVazia = lv!.id;
  const mk = async (sku: string) => {
    const { data } = await sb.from("siso_produtos").insert({ sku, descricao: sku, ativo: true }).select("id").single();
    return data!.id as string;
  };
  prodA = await mk(SKU_A);
  prodB = await mk(SKU_B);
  // Só A tem saldo na loc com estoque; B vai reservar numa loc VAZIA → falha.
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodA, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
    p_origem_id: null, p_custo_unitario: null, p_motivo: "seed",
  });
});

describe("criarReservasRotaAtomico — all-or-nothing (P085)", () => {
  it("falha da 2ª reserva → throw e nenhuma R sobrevive (rollback)", async () => {
    const rotas = [
      { produto_id: prodA, galpao_id: galpaoId, localizacao_id: locId, qty: 1 },
      // B numa loc sem saldo → reservarAtomico/RPC falha.
      { produto_id: prodB, galpao_id: galpaoId, localizacao_id: locVazia, qty: 1 },
    ];

    await expect(
      criarReservasRotaAtomico({ pedidoId: PEDIDO, rotas }),
    ).rejects.toThrow();

    // Nenhuma R viva sobrevive (a R de A foi estornada no rollback).
    const { data: rs } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("origem_id", PEDIDO);
    const ids = (rs ?? []).map((r) => r.id as string);
    if (ids.length > 0) {
      const { data: ls } = await sb.from("siso_movimentacoes").select("estorno_de").in("estorno_de", ids).eq("tipo", "L");
      const liberadas = new Set((ls ?? []).map((l) => l.estorno_de));
      const vivas = ids.filter((id) => !liberadas.has(id));
      expect(vivas).toEqual([]); // todas estornadas
    }

    // reservado de A volta a 0.
    const { data: estA } = await sb.from("siso_estoque").select("reservado").eq("produto_id", prodA).single();
    expect(Number(estA?.reservado)).toBe(0);
  });
});
```

- [ ] Step 2 — Rodar e ver falhar:
  - Comando: `npm run test:integration -- test/integration/webhook-reserva-all-or-nothing.integration.test.ts`
  - Expected: FAIL — `Cannot find module / criarReservasRotaAtomico is not a function` (ainda não existe).

- [ ] Step 3 — Implementação mínima:

Em `src/lib/webhook-processor-wms.ts`, extrair o loop de reserva (582-606) numa função exportada all-or-nothing e usá-la; só enfileirar `isAuto` se as reservas tiverem sucesso.

> Nota de ancoragem: a linha 27 JÁ importa `reservarAtomico` da path **relativa** `"./wms/reservas"` (`import { reservarAtomico } from "./wms/reservas";`). NÃO re-importar `reservarAtomico` (e nem da path `@/lib/wms/reservas` — duplicaria o símbolo = erro TS). Só ADICIONAR `estornarReservaIndividual` ao import existente, mantendo a path relativa:

```typescript
// linha 27 — editar o import existente para incluir estornarReservaIndividual:
// ANTES: import { reservarAtomico } from "./wms/reservas";
// DEPOIS:
import { reservarAtomico, estornarReservaIndividual } from "./wms/reservas";
```

Adicionar a função exportada (perto do fim do arquivo, fora de `processWebhookWms`):

```typescript
/**
 * P085: cria as reservas R da rota de forma all-or-nothing. Se qualquer item
 * falhar, estorna as já criadas (rollback) e RE-LANÇA o erro pra o caller
 * sinalizar 'erro' no webhook (Tiny retenta). reservarAtomico é idempotente
 * por (pedido,produto,tripla) (P003), então o retry não duplica a R do item
 * que já tinha dado certo.
 */
export async function criarReservasRotaAtomico(args: {
  pedidoId: string;
  rotas: Array<{ produto_id: string; galpao_id: string; localizacao_id: string; qty: number }>;
}): Promise<{ reservasCriadas: number }> {
  const { pedidoId, rotas } = args;
  const criadas: string[] = [];
  for (const r of rotas) {
    try {
      const id = await reservarAtomico({
        tripla: { produto_id: r.produto_id, galpao_id: r.galpao_id, localizacao_id: r.localizacao_id },
        qty: r.qty,
        pedido_id: pedidoId,
        ttl_horas: 24 * 30,
      });
      criadas.push(id);
    } catch (err) {
      // Rollback das já criadas (idempotente por estorno_de).
      for (const rid of criadas) {
        try {
          await estornarReservaIndividual({ reserva_id: rid, motivo: "rollback_aprovacao" });
        } catch (e) {
          logger.warn("processor.wms", "falha no rollback de R (segue)", {
            pedidoId, reserva_id: rid, error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      throw new Error(
        `reserva_falhou: item produto=${r.produto_id} qty=${r.qty} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { reservasCriadas: criadas.length };
}
```

Substituir o bloco de reserva inline (582-606) + o enqueue (615-636) por uso da função, fazendo o `isAuto` depender do sucesso:

```typescript
// substituir o bloco linhas 582-606:
  // 8. Criar reservas all-or-nothing (apenas propria/transferencia — OC não reserva).
  //    P085: se qualquer item falhar, throw → webhook vira 'erro' (Tiny retenta);
  //    NÃO enfileira lancar_estoque com pedido meio-aprovado.
  if (rota.decisao === "propria" || rota.decisao === "transferencia") {
    await criarReservasRotaAtomico({
      pedidoId: pedido.id,
      rotas: rota.rotas.map((r) => ({
        produto_id: r.produto_id,
        galpao_id: r.galpao_id,
        localizacao_id: r.localizacao_id,
        qty: r.qty,
      })),
    });
  }
```

O bloco 615-636 (`if (isAuto) { ... enqueue ... }`) permanece como está — agora ele só é alcançado se `criarReservasRotaAtomico` não lançou (o `throw` propaga pra cima de `processWebhookWms`, marcando o webhook como erro; ver o handler do webhook que captura e seta `status='erro'`).

> Nota de ancoragem: `processWebhookWms` já propaga erros (ex.: linha 536 `if (pedidoErr) throw pedidoErr;` e 559 `if (itemErr) throw itemErr;`) — o caller (`webhook-processor.ts`/rota webhook) já trata throw como erro→retry. O `throw` de `criarReservasRotaAtomico` segue o mesmo caminho.

- [ ] Step 4 — Rodar e ver passar:
  - Comando: `npm run test:integration -- test/integration/webhook-reserva-all-or-nothing.integration.test.ts`
  - Expected: PASS — throw acontece, nenhuma R viva sobrevive, reservado de A volta a 0. Re-rodar o cenário catalogo `01-pedido-auto-propria` (`npm run scenarios -- --only 01-pedido-auto`) pra garantir que o caminho feliz (todas reservas ok) ainda enfileira e auto-aprova.

- [ ] Step 5 — Commit:
  - `git add src/lib/webhook-processor-wms.ts test/integration/webhook-reserva-all-or-nothing.integration.test.ts`
  - `git commit -m "fix(wms): webhook auto-aprovação é all-or-nothing nas reservas — falha parcial rejeita tudo (P085)"`

### Task 6.3: Registrar P085/P003 em erros-conhecidos.yaml

- [ ] Step 1 — Adicionar entrada:

```yaml
  - id: webhook-reserva-parcial-e-dedup
    date: "2026-06-05"
    source: wms/webhook-processor, wms/reservas
    category: business_logic
    message: "Auto-aprovação no webhook engolia falha de reserva parcial (pedido seguia meio-aprovado) e reservarAtomico duplicava R em reprocessamento (reservado dobrado)."
    cause: >
      O loop de reserva em webhook-processor-wms.ts:597-604 só logava warn+continue e
      enfileirava lancar_estoque mesmo com item não-reservado. reservarAtomico só chamava a
      RPC (não idempotente) — 2 reprocessos rápidos criavam 2 R por (pedido,produto).
    fix: >
      criarReservasRotaAtomico: all-or-nothing — se qualquer item falha, estorna as criadas
      (rollback) e RE-LANÇA (webhook vira 'erro', Tiny retenta); só enfileira se 100% reservado.
      reservarAtomico passa a checar R viva por (pedido,produto,tripla) e retornar o id existente
      (dedup idempotente, sem advisory lock) — torna o retry seguro.
    files:
      - src/lib/webhook-processor-wms.ts
      - src/lib/wms/reservas.ts
      - test/integration/webhook-reserva-all-or-nothing.integration.test.ts
      - test/integration/reservas-idempotente.integration.test.ts
    tags: [webhook, reserva, all-or-nothing, idempotencia, dedup, P085, P003]
```

- [ ] Step 2 — Commit:
  - `git add erros-conhecidos.yaml`
  - `git commit -m "docs: registra webhook-reserva-parcial-e-dedup (P085, P003)"`

---

## Verificação final da fase

- [ ] `npm test` (unit — inclui `cancelamento-parcial.test.ts`) → tudo verde.
- [ ] `npm run test:integration -- test/integration/reservas-idempotente.integration.test.ts test/integration/webhook-reserva-all-or-nothing.integration.test.ts` → verde.
- [ ] `npm run auth-matrix` (sobe contra :3001) → cenários 18, 19, 21 PASS; nenhum regrediu.
- [ ] `npm run scenarios -- --only 34-recusar` · `--only 84-cancelar-item` · `--only 85-cancelar-job` · `--only 83-cancelar-pedido` · `--only 83b-cancelar-marketplace` → PASS, invariantes (sem reservas órfãs) verdes.
- [ ] `npm run scenarios` completo (ou ao menos `01`, `02`, `03`) sem regressão no caminho feliz de auto-aprovação/transferência/OC.
- [ ] `erros-conhecidos.yaml` tem as 5 entradas novas.
- [ ] `npm run lint` limpo nos arquivos tocados.
