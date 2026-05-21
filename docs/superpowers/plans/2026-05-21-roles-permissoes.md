# Roles & Permissões — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o sistema atual de cargos hardcoded por um RBAC dinâmico em que admin pode criar/editar roles pelo UI e atribuir permissões granulares, mantendo type-safety no código.

**Architecture:** Permission registry vive em `src/lib/permissions.ts` (30 permissões em 8 módulos, type-safe). 3 tabelas novas (`siso_roles`, `siso_role_permissoes`, `siso_usuario_roles`) guardam roles editáveis e atribuições. Helper `userCan(session, "perm")` substitui os ~50 checks de cargo espalhados. Trigger mantém `siso_usuarios.cargos[]` sincronizado por compat. UI de gestão em `/wms/configuracoes/roles`.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Supabase (PostgreSQL), Tailwind 4, Vitest, React Query.

**Spec:** `docs/superpowers/specs/2026-05-21-roles-permissoes-design.md`

**Rollout em 3 fases (cada fase = 1 commit deployável independente):**
- Fase 1 (Tasks 1-5): Infra — DB + lib + session. Comportamento idêntico.
- Fase 2 (Tasks 6-11): Migração mecânica dos checks de backend + sidebar. Comportamento ainda idêntico.
- Fase 3 (Tasks 12-20): UI de gestão + auditoria de botões de ação nas páginas. Habilita configuração dinâmica.

---

## File Structure

**Created:**
- `supabase/migrations/20260521_roles_permissoes.sql` — Schema + seed + backfill + trigger + RPC
- `src/lib/permissions.ts` — Registry + helpers `userCan`/`userCanAny`
- `src/lib/permissions.test.ts` — Unit tests do registry e helpers
- `src/app/api/wms/admin/roles/route.ts` — GET (list) + POST (create)
- `src/app/api/wms/admin/roles/[id]/route.ts` — GET (detail) + PATCH (edit) + DELETE
- `src/app/api/wms/admin/roles/[id]/permissoes/route.ts` — PUT (replace permissions)
- `src/app/api/wms/admin/permissoes/route.ts` — GET (catalog from registry)
- `src/app/api/wms/admin/usuarios/[id]/roles/route.ts` — PUT (replace user roles)
- `src/app/wms/configuracoes/roles/page.tsx` — Master/detail UI

**Modified:**
- `src/types/index.ts:509` — Atualiza `Cargo` (mantém como string), adiciona `Permissao`, `Role`, `RolePermissao` types
- `src/lib/session.ts` — `SessionUser` ganha `roles` + `permissoes: Set<string>`
- `src/lib/auth-context.tsx` — `AuthUser` ganha `permissoes`; novo hook `usePermissoes()` + `can()`
- `src/lib/compras-utils.ts:52` — `hasComprasAccess` vira wrapper deprecated de `userCan`
- `src/app/api/auth/login/route.ts` — Retorna `roles[]` e `permissoes[]` na resposta
- `src/app/api/auth/me/route.ts` — Retorna `roles[]` e `permissoes[]` na resposta
- `src/components/wms/wms-shell.tsx:78-162` — `NavItem.visibleFor: Cargo[]` → `requires: PermissaoCodigo[]`
- `src/app/api/wms/compras/**/*.ts` — ~15 rotas migram pra `userCan`
- `src/app/api/wms/insights/**/*.ts` — 4 rotas migram pra `userCan`
- `src/app/api/wms/admin/**/*.ts` — ~10 rotas migram pra `userCan`
- `src/app/api/wms/cross/**/*.ts` — 4 rotas migram pra `userCan`
- `src/app/api/wms/pedidos/**/*.ts` — 2 rotas migram pra `userCan`
- `src/app/api/wms/vendas/**/*.ts` — 3 rotas migram pra `userCan`
- `src/app/api/wms/separacao/**/*.ts` — ~10 rotas migram pra `userCan`
- `src/app/wms/configuracoes/page.tsx` — Link "Roles & Permissões"
- `src/app/wms/configuracoes/usuarios/[id]/page.tsx` (ou onde for) — Dropdown "Cargos" vira multi-select "Roles"
- `CLAUDE.md` — Seção "User Roles" reescrita
- `docs/database-schema.md` — Tabelas novas
- `docs/api-reference-complete.md` — 8 endpoints novos
- `docs/architecture-and-flows.md` — Seção "Roles & Permissões"

---

## FASE 1 — Infra (sem mudar comportamento)

### Task 1: Migration SQL — schema + seed + backfill + trigger + RPC

**Files:**
- Create: `supabase/migrations/20260521_roles_permissoes.sql`

- [ ] **Step 1: Criar o arquivo de migration com schema e seed**

```sql
-- ──────────────────────────────────────────────────────────────────────
-- Roles & Permissões — substitui controle de acesso baseado em cargos[]
-- ──────────────────────────────────────────────────────────────────────

-- 1. Schema
create table siso_roles (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null unique,
  nome          text not null,
  descricao     text,
  sistema       boolean not null default false,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table siso_role_permissoes (
  role_id          uuid not null references siso_roles(id) on delete cascade,
  permissao_codigo text not null,
  primary key (role_id, permissao_codigo)
);

create table siso_usuario_roles (
  usuario_id uuid not null references siso_usuarios(id) on delete cascade,
  role_id    uuid not null references siso_roles(id) on delete cascade,
  primary key (usuario_id, role_id)
);

create index siso_role_permissoes_codigo_idx on siso_role_permissoes(permissao_codigo);
create index siso_usuario_roles_role_idx on siso_usuario_roles(role_id);

-- 2. Seed das 6 roles sistema
insert into siso_roles (codigo, nome, descricao, sistema) values
  ('admin',        'Admin',        'Acesso completo ao sistema',                      true),
  ('operador',     'Operador',     'Operador genérico (todos galpões)',              true),
  ('operador_cwb', 'Operador CWB', 'Operador alocado em CWB',                         true),
  ('operador_sp',  'Operador SP',  'Operador alocado em SP',                          true),
  ('comprador',    'Comprador',    'Acesso ao módulo de compras e relatórios',       true),
  ('vendedor',     'Vendedor',     'Acesso a Vendas Diretas',                         true);

-- 3. Seed das permissões iniciais por role
-- admin: TODAS as 30
with all_perms(p) as (values
  ('vendas.ver'), ('vendas.criar'),
  ('pedidos.ver'), ('pedidos.aprovar'),
  ('separacao.ver'), ('separacao.executar'),
  ('compras.ver'), ('compras.executar'),
  ('estoque.ver'), ('cobertura.ver'),
  ('operacoes.transferir'), ('operacoes.replenishment'),
  ('operacoes.devolucoes'), ('operacoes.receber'),
  ('operacoes.guarda'), ('operacoes.ajuste_manual'),
  ('inventario.ver'), ('inventario.executar'), ('inventario.supervisionar'),
  ('insights.ver'), ('insights.financeiro'), ('insights.regras'),
  ('relatorios.ver'),
  ('produtos.editar'), ('localizacoes.editar'), ('fornecedores.editar'),
  ('sistema.usuarios'), ('sistema.roles'), ('sistema.conexoes'), ('sistema.galpoes_empresas')
)
insert into siso_role_permissoes (role_id, permissao_codigo)
select r.id, p from siso_roles r cross join all_perms where r.codigo = 'admin';

-- operador (todos galpões), operador_cwb, operador_sp — mesmo set
with op_perms(p) as (values
  ('vendas.ver'),
  ('pedidos.ver'), ('pedidos.aprovar'),
  ('separacao.ver'), ('separacao.executar'),
  ('compras.ver'),
  ('estoque.ver'), ('cobertura.ver'),
  ('operacoes.transferir'), ('operacoes.replenishment'),
  ('operacoes.devolucoes'), ('operacoes.receber'),
  ('operacoes.guarda'), ('operacoes.ajuste_manual'),
  ('inventario.ver'), ('inventario.executar'),
  ('insights.ver'),
  ('relatorios.ver'),
  ('produtos.editar'), ('localizacoes.editar'), ('fornecedores.editar')
)
insert into siso_role_permissoes (role_id, permissao_codigo)
select r.id, p
from siso_roles r cross join op_perms
where r.codigo in ('operador', 'operador_cwb', 'operador_sp');

-- comprador
with comp_perms(p) as (values
  ('pedidos.ver'),
  ('compras.ver'), ('compras.executar'),
  ('estoque.ver'), ('cobertura.ver'),
  ('relatorios.ver')
)
insert into siso_role_permissoes (role_id, permissao_codigo)
select r.id, p from siso_roles r cross join comp_perms where r.codigo = 'comprador';

-- vendedor
with vend_perms(p) as (values
  ('vendas.ver'), ('vendas.criar')
)
insert into siso_role_permissoes (role_id, permissao_codigo)
select r.id, p from siso_roles r cross join vend_perms where r.codigo = 'vendedor';

-- 4. Backfill siso_usuario_roles a partir de siso_usuarios.cargos[] (ou .cargo)
insert into siso_usuario_roles (usuario_id, role_id)
select u.id, r.id
from siso_usuarios u
cross join lateral unnest(coalesce(u.cargos, ARRAY[u.cargo])) c
join siso_roles r on r.codigo = c
on conflict do nothing;

-- 5. Trigger pra manter siso_usuarios.cargos[]/.cargo sincronizado
create or replace function wms_sync_cargos_from_roles() returns trigger as $$
declare v_usuario_id uuid;
begin
  v_usuario_id := coalesce(new.usuario_id, old.usuario_id);
  update siso_usuarios u set
    cargos = coalesce((
      select array_agg(r.codigo order by r.codigo)
      from siso_usuario_roles ur
      join siso_roles r on r.id = ur.role_id
      where ur.usuario_id = v_usuario_id
    ), ARRAY[]::text[]),
    cargo = coalesce((
      select r.codigo
      from siso_usuario_roles ur
      join siso_roles r on r.id = ur.role_id
      where ur.usuario_id = v_usuario_id
      order by case when r.codigo = 'admin' then 0 else 1 end, r.codigo
      limit 1
    ), u.cargo)
  where u.id = v_usuario_id;
  return null;
end; $$ language plpgsql;

create trigger trg_sync_cargos_after_roles
  after insert or delete on siso_usuario_roles
  for each row execute function wms_sync_cargos_from_roles();

-- 6. RPC pra proteção de delete
create or replace function wms_role_delete(p_role_id uuid) returns void as $$
declare v_sistema boolean; v_codigo text;
begin
  select sistema, codigo into v_sistema, v_codigo from siso_roles where id = p_role_id;
  if not found then
    raise exception 'Role não existe';
  end if;
  if v_sistema then
    raise exception 'Role de sistema não pode ser deletada (codigo=%)', v_codigo;
  end if;
  -- Bloqueia se algum usuário ficaria sem nenhuma role
  if exists (
    select 1 from siso_usuario_roles ur
    where ur.role_id = p_role_id
      and not exists (
        select 1 from siso_usuario_roles ur2
        where ur2.usuario_id = ur.usuario_id and ur2.role_id <> p_role_id
      )
  ) then
    raise exception 'Usuários ficariam sem nenhuma role — atribua outra role antes de deletar';
  end if;
  delete from siso_roles where id = p_role_id;
end; $$ language plpgsql;

-- 7. Trigger pra atualizar atualizado_em
create or replace function siso_roles_touch_atualizado_em() returns trigger as $$
begin new.atualizado_em := now(); return new; end;
$$ language plpgsql;

create trigger trg_siso_roles_touch
  before update on siso_roles
  for each row execute function siso_roles_touch_atualizado_em();
```

- [ ] **Step 2: Aplicar migration via mcp__supabase__apply_migration**

Use a ferramenta MCP do Supabase (não rode `psql` direto — projeto é hospedado).
- Project ID: `wrbrbhuhsaaupqsimkqz`
- Name: `20260521_roles_permissoes`
- Query: o conteúdo do arquivo SQL inteiro.

Expected: aplicação sem erros, todas DDLs commitadas.

- [ ] **Step 3: Validar seed e backfill**

Rode via `mcp__supabase__execute_sql`:
```sql
select codigo, sistema, ativo,
  (select count(*) from siso_role_permissoes rp where rp.role_id = r.id) as n_perms,
  (select count(*) from siso_usuario_roles ur where ur.role_id = r.id) as n_users
from siso_roles r order by codigo;
```
Expected: 6 linhas, `admin` com 30 permissões, `vendedor` com 2. `n_users` reflete o backfill.

- [ ] **Step 4: Validar trigger de sincronia**

```sql
-- Pega um usuário com role 'admin'
select u.id, u.cargo, u.cargos from siso_usuarios u
where exists (
  select 1 from siso_usuario_roles ur join siso_roles r on r.id = ur.role_id
  where ur.usuario_id = u.id and r.codigo = 'admin'
) limit 1;
```
Expected: `cargo='admin'`, `cargos` contém `'admin'`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260521_roles_permissoes.sql
git commit -m "feat(roles): cria tabelas siso_roles + seed + backfill + trigger"
```

---

### Task 2: Permission registry (`src/lib/permissions.ts`) + testes

**Files:**
- Create: `src/lib/permissions.ts`
- Create: `src/lib/permissions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/permissions.test.ts
import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  PERMISSAO_CODIGOS,
  userCan,
  userCanAny,
  type PermissaoCodigo,
} from "./permissions";

describe("PERMISSIONS registry", () => {
  it("tem exatamente 30 permissões em 8 módulos", () => {
    expect(PERMISSAO_CODIGOS).toHaveLength(30);
    const modulos = new Set(Object.values(PERMISSIONS).map((p) => p.modulo));
    expect(modulos.size).toBe(8);
  });

  it("toda permissão tem modulo e label não-vazios", () => {
    for (const codigo of PERMISSAO_CODIGOS) {
      const p = PERMISSIONS[codigo];
      expect(p.modulo).toMatch(/\S/);
      expect(p.label).toMatch(/\S/);
    }
  });

  it("códigos seguem padrão modulo.acao", () => {
    for (const codigo of PERMISSAO_CODIGOS) {
      expect(codigo).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});

describe("userCan", () => {
  const session = { permissoes: new Set(["compras.ver", "compras.executar"]) };

  it("retorna false quando session é null", () => {
    expect(userCan(null, "compras.ver")).toBe(false);
  });

  it("retorna true quando todas permissões estão no Set", () => {
    expect(userCan(session, "compras.ver")).toBe(true);
    expect(userCan(session, "compras.ver", "compras.executar")).toBe(true);
  });

  it("retorna false quando alguma permissão falta", () => {
    expect(userCan(session, "compras.ver", "pedidos.aprovar" as PermissaoCodigo)).toBe(false);
  });

  it("retorna true quando required é vazio (vacuosamente verdadeiro)", () => {
    expect(userCan(session)).toBe(true);
  });
});

describe("userCanAny", () => {
  const session = { permissoes: new Set(["compras.ver"]) };

  it("retorna true quando qualquer permissão está no Set", () => {
    expect(userCanAny(session, "compras.ver", "pedidos.aprovar" as PermissaoCodigo)).toBe(true);
  });

  it("retorna false quando nenhuma permissão está no Set", () => {
    expect(userCanAny(session, "pedidos.aprovar" as PermissaoCodigo)).toBe(false);
  });

  it("retorna false quando session é null", () => {
    expect(userCanAny(null, "compras.ver")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/permissions.test.ts`
Expected: FAIL — `Cannot find module './permissions'`.

- [ ] **Step 3: Write the registry and helpers**

```ts
// src/lib/permissions.ts
export const PERMISSIONS = {
  // ── Vendas ──
  "vendas.ver":           { modulo: "vendas",        label: "Ver Vendas Diretas" },
  "vendas.criar":         { modulo: "vendas",        label: "Criar venda manual" },
  "pedidos.ver":          { modulo: "vendas",        label: "Ver Pedidos (marketplace)" },
  "pedidos.aprovar":      { modulo: "vendas",        label: "Aprovar/rejeitar pedido" },
  "separacao.ver":        { modulo: "vendas",        label: "Ver Separação" },
  "separacao.executar":   { modulo: "vendas",        label: "Bipar/separar pedidos" },
  "compras.ver":          { modulo: "vendas",        label: "Ver Compras" },
  "compras.executar":     { modulo: "vendas",        label: "Comprar/receber/cancelar OC" },

  // ── Visibilidade ──
  "estoque.ver":          { modulo: "visibilidade",  label: "Ver Estoque" },
  "cobertura.ver":        { modulo: "visibilidade",  label: "Ver Cobertura" },

  // ── Operações ──
  "operacoes.transferir":     { modulo: "operacoes", label: "Transferir entre galpões" },
  "operacoes.replenishment":  { modulo: "operacoes", label: "Realocar intra-galpão" },
  "operacoes.devolucoes":     { modulo: "operacoes", label: "Classificar devoluções" },
  "operacoes.receber":        { modulo: "operacoes", label: "Receber NF (dock)" },
  "operacoes.guarda":         { modulo: "operacoes", label: "Put-away" },
  "operacoes.ajuste_manual":  { modulo: "operacoes", label: "Ajuste manual de saldo" },

  // ── Inventário ──
  "inventario.ver":            { modulo: "inventario", label: "Ver sessões" },
  "inventario.executar":       { modulo: "inventario", label: "Contar (handheld)" },
  "inventario.supervisionar":  { modulo: "inventario", label: "Criar/aprovar/aplicar sessão" },

  // ── Insights & Relatórios ──
  "insights.ver":          { modulo: "insights",    label: "Ver insights" },
  "insights.financeiro":   { modulo: "insights",    label: "Ver insights financeiros" },
  "insights.regras":       { modulo: "insights",    label: "Gerenciar regras" },
  "relatorios.ver":        { modulo: "relatorios",  label: "Ver relatórios" },

  // ── Cadastros ──
  "produtos.editar":       { modulo: "cadastros",   label: "Editar produtos/Cross" },
  "localizacoes.editar":   { modulo: "cadastros",   label: "Editar localizações" },
  "fornecedores.editar":   { modulo: "cadastros",   label: "Editar fornecedores" },

  // ── Sistema (sempre admin) ──
  "sistema.usuarios":         { modulo: "sistema",  label: "Gerenciar usuários" },
  "sistema.roles":            { modulo: "sistema",  label: "Gerenciar roles e permissões" },
  "sistema.conexoes":         { modulo: "sistema",  label: "Gerenciar conexões Tiny/ML/PrintNode" },
  "sistema.galpoes_empresas": { modulo: "sistema",  label: "Gerenciar galpões/empresas/grupos" },
} as const;

export type PermissaoCodigo = keyof typeof PERMISSIONS;
export const PERMISSAO_CODIGOS = Object.keys(PERMISSIONS) as PermissaoCodigo[];

export type PermissoesPort = { permissoes: Set<string> };

export function userCan(
  session: PermissoesPort | null,
  ...required: PermissaoCodigo[]
): boolean {
  if (!session) return false;
  return required.every((p) => session.permissoes.has(p));
}

export function userCanAny(
  session: PermissoesPort | null,
  ...required: PermissaoCodigo[]
): boolean {
  if (!session) return false;
  if (required.length === 0) return false;
  return required.some((p) => session.permissoes.has(p));
}

export const MODULOS_ORDEM = [
  "vendas",
  "visibilidade",
  "operacoes",
  "inventario",
  "insights",
  "relatorios",
  "cadastros",
  "sistema",
] as const;

export type ModuloId = (typeof MODULOS_ORDEM)[number];

export const MODULOS_LABEL: Record<ModuloId, string> = {
  vendas: "Vendas",
  visibilidade: "Visibilidade",
  operacoes: "Operações",
  inventario: "Inventário",
  insights: "Insights",
  relatorios: "Relatórios",
  cadastros: "Cadastros",
  sistema: "Sistema",
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/permissions.test.ts`
Expected: PASS, todos os 10 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/permissions.ts src/lib/permissions.test.ts
git commit -m "feat(roles): registry de permissões + userCan/userCanAny"
```

---

### Task 3: Estender `SessionUser` e carregar permissões

**Files:**
- Modify: `src/types/index.ts:509`
- Modify: `src/lib/session.ts:1-99`

- [ ] **Step 1: Adicionar tipos em `src/types/index.ts`**

Logo após a definição de `CARGO_LABELS` (depois da linha 528 — `cargo: Cargo;` já existe em `Usuario`), adicione:

```ts
// ── Roles & Permissões (dinâmico, vindo do DB) ──
export interface Role {
  id: string;
  codigo: string;          // 'admin', 'operador', 'conferente'
  nome: string;            // "Admin", "Conferente"
  descricao?: string | null;
  sistema: boolean;        // true = não pode deletar/renomear código
  ativo: boolean;
  criado_em?: string;
  atualizado_em?: string;
}

export interface RoleComContagens extends Role {
  n_permissoes: number;
  n_usuarios: number;
}

export interface RoleDetalhada extends Role {
  permissoes: string[];                                    // códigos
  usuarios: Array<{ id: string; nome: string; roles: string[] }>;
}
```

Comentário acima do tipo `Cargo` (linha 509):
```ts
/**
 * Cargo legado — mantido por compat. Substituído por Role no novo RBAC.
 * Strings dinâmicas (admin pode criar roles novas), tipo continua aceitando
 * as 6 originais como literais por completion-friendliness mas não bloqueia
 * códigos novos.
 */
```
(O tipo `Cargo` em si **não muda** nesta task — continua sendo a union dos 6 literais. A camada nova é `Role`/`Permissao`. Cargo só some na fase de removal futura.)

- [ ] **Step 2: Atualizar `SessionUser` em `src/lib/session.ts`**

Substitua a interface (linhas 4-10) por:
```ts
export interface SessionUser {
  id: string;
  nome: string;
  cargo: string;                  // mantido por compat — primeira role.codigo
  cargos: string[];               // mantido por compat — roles[].codigo
  roles: Array<{ id: string; codigo: string; nome: string }>;
  permissoes: Set<string>;        // união das permissões das roles ativas
  galpaoId: string | null;
}
```

- [ ] **Step 3: Atualizar `getSessionUser` pra carregar roles+permissões**

Substitua o corpo de `getSessionUser` (linhas 22-99) por:

```ts
export async function getSessionUser(
  request: Request,
): Promise<SessionUser | null> {
  const sessionId = request.headers.get("X-Session-Id");
  if (!sessionId) return null;

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("siso_sessoes")
    .select("usuario_id, siso_usuarios(id, nome, cargo, cargos)")
    .eq("id", sessionId)
    .gt("expira_em", new Date().toISOString())
    .single();

  if (error || !data) {
    logger.warn("session", "Session not found or expired", { sessionId });
    return null;
  }

  const usuario = data.siso_usuarios as unknown as {
    id: string;
    nome: string;
    cargo: string;
    cargos: string[];
  } | null;

  if (!usuario) return null;

  // Carrega roles ativas + permissões agregadas
  const { data: rolesRaw } = await supabase
    .from("siso_usuario_roles")
    .select("siso_roles(id, codigo, nome, ativo, siso_role_permissoes(permissao_codigo))")
    .eq("usuario_id", usuario.id);

  const rolesAtivas: Array<{ id: string; codigo: string; nome: string }> = [];
  const permissoesSet = new Set<string>();

  for (const row of rolesRaw ?? []) {
    const role = (row as unknown as {
      siso_roles: {
        id: string;
        codigo: string;
        nome: string;
        ativo: boolean;
        siso_role_permissoes: Array<{ permissao_codigo: string }>;
      } | null;
    }).siso_roles;
    if (!role || !role.ativo) continue;
    rolesAtivas.push({ id: role.id, codigo: role.codigo, nome: role.nome });
    for (const rp of role.siso_role_permissoes ?? []) {
      permissoesSet.add(rp.permissao_codigo);
    }
  }

  // Fallback de compat: se usuário não tiver siso_usuario_roles ainda,
  // usa cargos[] como nomes de role pra montar permissões via JOIN.
  if (rolesAtivas.length === 0 && (usuario.cargos?.length || usuario.cargo)) {
    const codigos = usuario.cargos?.length ? usuario.cargos : [usuario.cargo];
    const { data: fallback } = await supabase
      .from("siso_roles")
      .select("id, codigo, nome, ativo, siso_role_permissoes(permissao_codigo)")
      .in("codigo", codigos);

    for (const role of fallback ?? []) {
      if (!role.ativo) continue;
      rolesAtivas.push({ id: role.id, codigo: role.codigo, nome: role.nome });
      const rps = (role as unknown as { siso_role_permissoes: Array<{ permissao_codigo: string }> })
        .siso_role_permissoes;
      for (const rp of rps ?? []) permissoesSet.add(rp.permissao_codigo);
    }
  }

  const cargosOut = rolesAtivas.map((r) => r.codigo);
  const cargoOut = cargosOut[0] ?? usuario.cargo ?? "";

  // ── Galpão (lógica existente, sem mudanças funcionais) ──
  const galpaoIdHeader = request.headers.get("X-Galpao-Id");
  if (galpaoIdHeader) {
    const { data: valid } = await supabase
      .from("siso_usuario_galpoes")
      .select("galpao_id")
      .eq("usuario_id", usuario.id)
      .eq("galpao_id", galpaoIdHeader)
      .maybeSingle();

    if (valid) {
      return {
        id: usuario.id,
        nome: usuario.nome,
        cargo: cargoOut,
        cargos: cargosOut,
        roles: rolesAtivas,
        permissoes: permissoesSet,
        galpaoId: galpaoIdHeader,
      };
    }
  }

  let galpaoId: string | null = null;
  const operadorCargo = cargosOut.find((c) => c === "operador_cwb" || c === "operador_sp");
  if (operadorCargo) {
    const galpaoNome = operadorCargo === "operador_cwb" ? "CWB" : "SP";
    const { data: galpao } = await supabase
      .from("siso_galpoes")
      .select("id")
      .eq("nome", galpaoNome)
      .single();

    galpaoId = galpao?.id ?? null;
  }

  return {
    id: usuario.id,
    nome: usuario.nome,
    cargo: cargoOut,
    cargos: cargosOut,
    roles: rolesAtivas,
    permissoes: permissoesSet,
    galpaoId,
  };
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: 0 errors (a interface `SessionUser` ganhou campos novos não-opcionais que TODOS consumidores agora recebem corretamente; nenhum consumidor antigo lê `roles`/`permissoes` ainda).

- [ ] **Step 5: Smoke test manual**

Inicie `npm run dev`, faça login como admin, abra DevTools → Network → procure por uma request `GET /api/wms/produtos` ou similar. Não deve haver regressão (status 200, latência normal). Se houver 500, cheque logs do server pra ver erro do JOIN.

- [ ] **Step 6: Commit**

```bash
git add src/lib/session.ts src/types/index.ts
git commit -m "feat(roles): SessionUser carrega roles + permissoes do DB"
```

---

### Task 4: Atualizar `auth-context.tsx` (client) + endpoints `/api/auth/*`

**Files:**
- Modify: `src/lib/auth-context.tsx:16-23` (interface) e demais funções
- Modify: `src/app/api/auth/login/route.ts` (resposta)
- Modify: `src/app/api/auth/me/route.ts` (resposta)

- [ ] **Step 1: Atualizar resposta de `/api/auth/login`**

Leia `src/app/api/auth/login/route.ts` primeiro. Localize o ponto onde a resposta `{ ok, usuario, sessionId }` é montada. Adicione campos:

```ts
// (depois de buscar usuario do DB)
const { data: rolesRows } = await supabase
  .from("siso_usuario_roles")
  .select("siso_roles(id, codigo, nome, ativo, siso_role_permissoes(permissao_codigo))")
  .eq("usuario_id", usuario.id);

const roles: Array<{ id: string; codigo: string; nome: string }> = [];
const permsSet = new Set<string>();
for (const row of rolesRows ?? []) {
  const r = (row as { siso_roles: { id: string; codigo: string; nome: string; ativo: boolean; siso_role_permissoes: Array<{ permissao_codigo: string }> } | null }).siso_roles;
  if (!r || !r.ativo) continue;
  roles.push({ id: r.id, codigo: r.codigo, nome: r.nome });
  for (const rp of r.siso_role_permissoes ?? []) permsSet.add(rp.permissao_codigo);
}

return NextResponse.json({
  ok: true,
  usuario: {
    id: usuario.id,
    nome: usuario.nome,
    cargo: usuario.cargo,
    cargos: usuario.cargos ?? [usuario.cargo],
    roles,
    permissoes: Array.from(permsSet),
    galpoes: /* lista existente */,
  },
  sessionId,
});
```

(Se o handler atual já tem outro shape, mantenha a estrutura — só adicione `roles` e `permissoes`.)

- [ ] **Step 2: Atualizar resposta de `/api/auth/me`**

Mesma adição em `src/app/api/auth/me/route.ts`. Reaproveite a lógica de carregar roles (extraia helper local se quiser).

- [ ] **Step 3: Atualizar `AuthUser` em `src/lib/auth-context.tsx:16`**

```ts
interface AuthUser {
  id: string;
  nome: string;
  cargo: Cargo;
  cargos: Cargo[];
  roles: Array<{ id: string; codigo: string; nome: string }>;
  permissoes: string[];     // serializável (Set não é) — no hook viramos Set
  sessionId?: string;
  galpoes: UserGalpao[];
}
```

- [ ] **Step 4: Hidratar `roles`/`permissoes` em `login`, `refreshUser`, `getStoredUser`**

Em `login` (linha ~155) substitua:
```ts
const cargos: Cargo[] = data.usuario.cargos ?? [data.usuario.cargo];
const galpoes: UserGalpao[] = data.usuario.galpoes ?? [];
const authUser: AuthUser = {
  id: data.usuario.id,
  nome: data.usuario.nome,
  cargo: cargos[0],
  cargos,
  roles: data.usuario.roles ?? [],
  permissoes: data.usuario.permissoes ?? [],
  galpoes,
  ...(data.sessionId && { sessionId: data.sessionId }),
};
```

Em `refreshUser` (linha ~205) faça o mesmo. Em `getStoredUser` o cast continua: o JSON em localStorage já vai trazer os campos novos, type-cast cuida.

- [ ] **Step 5: Adicionar hook `usePermissoes`**

No final de `auth-context.tsx`, exporte:

```ts
import type { PermissaoCodigo } from "@/lib/permissions";

export function usePermissoes() {
  const { user } = useAuth();
  const set = useMemo(() => new Set(user?.permissoes ?? []), [user?.permissoes]);
  const can = useCallback(
    (...required: PermissaoCodigo[]) => required.every((p) => set.has(p)),
    [set],
  );
  const canAny = useCallback(
    (...required: PermissaoCodigo[]) =>
      required.length > 0 && required.some((p) => set.has(p)),
    [set],
  );
  return { can, canAny, permissoes: set };
}
```

Adicione `useMemo` ao import do React no topo.

- [ ] **Step 6: Smoke test manual**

`npm run dev` → login → console: `JSON.parse(localStorage.siso_user)` deve mostrar `roles[]` e `permissoes[]` populados.

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth-context.tsx src/app/api/auth/login/route.ts src/app/api/auth/me/route.ts
git commit -m "feat(roles): auth carrega roles+permissoes (server + client)"
```

---

### Task 5: Validar Fase 1 end-to-end

**Files:** _(nenhum — só validação)_

- [ ] **Step 1: Rodar todos os testes**

Run: `npm test`
Expected: PASS — todos os testes existentes + os 10 novos de `permissions.test.ts`.

- [ ] **Step 2: Type-check completo**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Build de produção**

Run: `npm run build`
Expected: PASS — sem warnings críticos.

- [ ] **Step 4: Smoke test multi-usuário**

Inicie `npm run dev`. Pra cada cargo legado (admin, comprador, vendedor — escolha 3), faça login e:
- Verifique que `localStorage.siso_user.roles[]` tem 1 entry com `codigo` igual ao cargo legado.
- Verifique que `permissoes[]` tem o set esperado (admin = 30, comprador = 6, vendedor = 2).
- Navegue na UI: deve ser idêntica ao antes do PR (Fase 1 não muda nada visual).

- [ ] **Step 5: Commit de checkpoint (sem mudanças, só marca)**

(Não há nada pra commitar — pule este step se não houver mudanças.) Se houver, commite. Fase 1 fechada.

---

## FASE 2 — Migração mecânica dos checks

### Task 6: Refatorar `wms-shell.tsx` — `visibleFor` → `requires`

**Files:**
- Modify: `src/components/wms/wms-shell.tsx:67-178`

- [ ] **Step 1: Substituir tipos e seções**

Substitua as linhas 67-77 e 78-162 (toda a array `NAV_SECTIONS` + tipos) por:

```ts
import { type PermissaoCodigo } from "@/lib/permissions";

interface NavItem {
  href: string;
  icon: string;
  label: string;
  requires?: PermissaoCodigo[];   // OR-set: tem qualquer uma → mostra
}

interface NavSection {
  id: string;
  label: string;
  itens: NavItem[];
  requires?: PermissaoCodigo[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    id: "vendas",
    label: "Vendas",
    itens: [
      { href: "/wms/vendas", icon: "handshake", label: "Vendas Diretas", requires: ["vendas.ver"] },
      { href: "/wms/pedidos", icon: "clipboard", label: "Pedidos", requires: ["pedidos.ver"] },
      { href: "/wms/separacao", icon: "list", label: "Separação", requires: ["separacao.ver"] },
      { href: "/wms/compras", icon: "truck", label: "Compras", requires: ["compras.ver"] },
    ],
  },
  {
    id: "principal",
    label: "Visibilidade",
    requires: ["estoque.ver", "cobertura.ver"],
    itens: [
      { href: "/wms/estoque", icon: "box", label: "Estoque", requires: ["estoque.ver"] },
      { href: "/wms/cobertura", icon: "gauge", label: "Cobertura", requires: ["cobertura.ver"] },
    ],
  },
  {
    id: "operacoes",
    label: "Operações",
    requires: ["operacoes.transferir", "operacoes.replenishment", "operacoes.devolucoes", "operacoes.receber", "operacoes.guarda"],
    itens: [
      { href: "/wms/transferir", icon: "arrows", label: "Transferências", requires: ["operacoes.transferir"] },
      { href: "/wms/replenishment", icon: "shuffle", label: "Realocar", requires: ["operacoes.replenishment"] },
      { href: "/wms/devolucoes", icon: "rotate", label: "Devoluções", requires: ["operacoes.devolucoes"] },
      { href: "/wms/receber", icon: "plus", label: "Receber", requires: ["operacoes.receber"] },
      { href: "/wms/guarda", icon: "box", label: "Guarda", requires: ["operacoes.guarda"] },
    ],
  },
  {
    id: "inventario",
    label: "Inventário",
    requires: ["inventario.ver"],
    itens: [
      { href: "/wms/inventario", icon: "clipboard", label: "Sessões", requires: ["inventario.ver"] },
      { href: "/wms/inventario/metricas", icon: "gauge", label: "Métricas", requires: ["inventario.ver"] },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    requires: ["insights.ver"],
    itens: [
      { href: "/wms/insights", icon: "sparkle", label: "Hub", requires: ["insights.ver"] },
      { href: "/wms/insights/pessoas", icon: "handshake", label: "Pessoas", requires: ["insights.ver"] },
      { href: "/wms/insights/fluxo", icon: "arrows", label: "Fluxo", requires: ["insights.ver"] },
      { href: "/wms/insights/estoque", icon: "gauge", label: "Estoque", requires: ["insights.ver"] },
      { href: "/wms/insights/financeiro", icon: "building", label: "Financeiro", requires: ["insights.financeiro"] },
      { href: "/wms/insights/devolucoes", icon: "rotate", label: "Devoluções", requires: ["insights.ver"] },
      { href: "/wms/insights/regras", icon: "sliders", label: "Regras", requires: ["insights.regras"] },
    ],
  },
  {
    id: "relatorios",
    label: "Relatórios",
    requires: ["relatorios.ver"],
    itens: [
      { href: "/wms/relatorios/movs-por-empresa", icon: "columns", label: "Movs por Empresa", requires: ["relatorios.ver"] },
      { href: "/wms/relatorios/historico-custo", icon: "history", label: "Histórico de Custo", requires: ["relatorios.ver"] },
      { href: "/wms/relatorios/saldos-por-empresa", icon: "box", label: "Saldos por Empresa", requires: ["relatorios.ver"] },
    ],
  },
  {
    id: "cadastros",
    label: "Cadastros",
    requires: ["produtos.editar", "localizacoes.editar", "fornecedores.editar"],
    itens: [
      { href: "/wms/produtos", icon: "tag", label: "Produtos", requires: ["produtos.editar"] },
      { href: "/wms/cross", icon: "sparkle", label: "Cross", requires: ["produtos.editar"] },
      { href: "/wms/localizacoes", icon: "pin", label: "Localizações", requires: ["localizacoes.editar"] },
      { href: "/wms/fornecedores", icon: "truck", label: "Fornecedores", requires: ["fornecedores.editar"] },
    ],
  },
  {
    id: "sistema",
    label: "Sistema",
    requires: ["sistema.usuarios", "sistema.roles", "sistema.conexoes", "sistema.galpoes_empresas"],
    itens: [
      { href: "/wms/configuracoes", icon: "building", label: "Configurações", requires: ["sistema.usuarios"] },
    ],
  },
];
```

- [ ] **Step 2: Substituir `filterNavForUser`**

Substitua a função (linhas 164-177) por:

```ts
function filterNavForUser(permissoes: Set<string>): NavSection[] {
  const hasAny = (req?: PermissaoCodigo[]) =>
    !req || req.length === 0 || req.some((p) => permissoes.has(p));

  return NAV_SECTIONS.flatMap<NavSection>((sec) => {
    if (!hasAny(sec.requires)) return [];
    const itens = sec.itens.filter((it) => hasAny(it.requires));
    if (itens.length === 0) return [];
    return [{ ...sec, itens }];
  });
}
```

- [ ] **Step 3: Atualizar a chamada (no componente que renderiza a sidebar)**

Procure por `filterNavForUser(cargos)` no arquivo (Ctrl+F). Substitua por:

```ts
const { permissoes } = usePermissoes();
const sections = filterNavForUser(permissoes);
```

Adicione `import { usePermissoes } from "@/lib/auth-context";` no topo.

Remova `getCargos` (linhas 181-184) e `ALL_NAV` se não mais usado.

- [ ] **Step 4: Smoke test manual**

`npm run dev` → login como vendedor → sidebar deve mostrar SÓ "Vendas" + sub-item "Vendas Diretas". Login como admin → sidebar igual ao antes. Login como comprador → "Vendas" (com Pedidos + Compras), "Visibilidade", "Relatórios".

- [ ] **Step 5: Commit**

```bash
git add src/components/wms/wms-shell.tsx
git commit -m "feat(roles): sidebar filtra por permissões em vez de cargo"
```

---

### Task 7: Tornar `hasComprasAccess` wrapper deprecated de `userCan`

**Files:**
- Modify: `src/lib/compras-utils.ts:52-58`

- [ ] **Step 1: Substituir a função**

Substitua linhas 52-58 por:

```ts
import { userCan, type PermissoesPort } from "@/lib/permissions";

/**
 * @deprecated Use `userCan(session, "compras.executar")` diretamente.
 * Wrapper mantido por compat durante a migração dos checks (Fase 2 do
 * RBAC dinâmico). Será removido após estabilização.
 */
export function hasComprasAccess(
  cargoOrSession?: string | string[] | PermissoesPort | null,
): boolean {
  if (!cargoOrSession) return false;
  // Caso 1: já recebemos uma session com permissões
  if (typeof cargoOrSession === "object" && !Array.isArray(cargoOrSession) && "permissoes" in cargoOrSession) {
    return userCan(cargoOrSession as PermissoesPort, "compras.executar");
  }
  // Caso 2: legado — cargo string ou array. Mantém comportamento antigo via fallback.
  const cargos = Array.isArray(cargoOrSession) ? cargoOrSession : [cargoOrSession];
  return cargos.some((c) => c === "admin" || c === "comprador");
}
```

Mantenha `COMPRAS_ALLOWED_CARGOS` (linha 4) por compat.

- [ ] **Step 2: Rodar testes**

Run: `npm test`
Expected: PASS (nenhuma quebra — assinatura compatível).

- [ ] **Step 3: Commit**

```bash
git add src/lib/compras-utils.ts
git commit -m "refactor(roles): hasComprasAccess vira wrapper deprecated de userCan"
```

---

### Task 8: Migrar checks em `/api/wms/compras/**` (15 rotas)

**Files:**
- Modify: `src/app/api/wms/compras/route.ts:115`
- Modify: `src/app/api/wms/compras/comprar/route.ts:24-25`
- Modify: `src/app/api/wms/compras/receber/route.ts:24`
- Modify: `src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts:21`
- Modify: `src/app/api/wms/compras/preparar-embalagem/route.ts:15`
- Modify: `src/app/api/wms/compras/conferencia/[ordemCompraId]/route.ts:34`
- Modify: `src/app/api/wms/compras/conferir/route.ts:43`
- Modify: `src/app/api/wms/compras/trocar-sku/route.ts:30`
- Modify: `src/app/api/wms/compras/ordens/route.ts:17`
- Modify: `src/app/api/wms/compras/itens/[itemId]/cancelamento/route.ts:18`
- Modify: `src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts:19`
- Modify: `src/app/api/wms/compras/itens/[itemId]/devolver/route.ts:19`
- Modify: `src/app/api/wms/compras/itens/[itemId]/equivalente/route.ts:23`
- Modify: `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts:20`
- Modify: `src/app/api/wms/compras/itens/[itemId]/indisponivel/route.ts:18`
- Modify: `src/app/api/wms/compras/itens/[itemId]/trocar-fornecedor/route.ts:22`

- [ ] **Step 1: Padrão de substituição**

Em cada arquivo, localize o check (todos seguem o mesmo padrão) e troque:

**De:**
```ts
if (!hasComprasAccess(session.cargos)) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
```

**Para:**
```ts
if (!userCan(session, "compras.executar")) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
```

Adicione `import { userCan } from "@/lib/permissions";` no topo de cada arquivo (caso ainda não exista).

Casos especiais:
- `compras/comprar/route.ts:24-25` tem duas linhas (`const cargos = session.cargos ?? []; if (!cargos.includes("admin") && !cargos.includes("comprador"))`) — substitua AS DUAS por um único `if (!userCan(session, "compras.executar"))`.
- `compras/route.ts:115` (GET listagem) — distinção: usar `userCan(session, "compras.ver")` em vez de `compras.executar`, porque é só leitura.
- `compras/conferencia/[ordemCompraId]/route.ts` tem GET + POST no mesmo arquivo. GET = `"compras.ver"`, POST = `"compras.executar"`.
- `compras/ordens/route.ts` GET = `"compras.ver"`, POST = `"compras.executar"`.

- [ ] **Step 2: Type-check + tests**

Run: `npx tsc --noEmit && npm test`
Expected: 0 errors, todos os testes verdes.

- [ ] **Step 3: Smoke test manual**

`npm run dev` → login como comprador → abrir `/wms/compras` → deve listar OCs normalmente. Tentar `POST /api/wms/compras/comprar` com payload válido via DevTools console → deve retornar 200. Login como vendedor → tentar mesma rota → deve retornar 403.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/compras
git commit -m "feat(roles): migra checks de /api/wms/compras pra userCan"
```

---

### Task 9: Migrar checks em `/api/wms/insights/**` (4 rotas)

**Files:**
- Modify: `src/app/api/wms/insights/financeiro/route.ts:13`
- Modify: `src/app/api/wms/insights/regras/route.ts:8`
- Modify: `src/app/api/wms/insights/regras/[id]/route.ts:11`
- Modify: `src/app/api/wms/insights/regras/[id]/test/route.ts:12`

- [ ] **Step 1: Substituir checks**

Em cada arquivo, substitua:

**De:**
```ts
if (user.cargo !== "admin") {
  return NextResponse.json({ error: "..." }, { status: 403 });
}
```

**Para (financeiro):**
```ts
if (!userCan(user, "insights.financeiro")) {
  return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
}
```

**Para (regras/*):**
```ts
if (!userCan(user, "insights.regras")) {
  return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
}
```

Adicione import.

- [ ] **Step 2: Type-check + tests**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/insights
git commit -m "feat(roles): migra checks de /api/wms/insights pra userCan"
```

---

### Task 10: Migrar checks em `/api/wms/admin/**`

**Files:**
- Modify: `src/app/api/wms/admin/backfill-agrupamentos/route.ts:26`
- Modify: `src/app/api/wms/admin/backfill-lvr/route.ts:28`
- Modify: `src/app/api/wms/admin/galpoes/route.ts:153-160`
- Modify: `src/app/api/wms/admin/usuarios/route.ts` (todas funções)
- Modify: `src/app/api/wms/admin/usuarios/foto/route.ts:48,137`
- Modify: `src/app/api/wms/admin/printnode/contas/route.ts:24-30,66-70`
- Modify: `src/app/api/wms/admin/printnode/contas/[id]/route.ts:24-30,107-111`
- Modify: `src/app/api/wms/admin/printnode/contas/[id]/test/route.ts:26-30`
- Modify: `src/app/api/wms/admin/printnode/printers/route.ts:34-38`

- [ ] **Step 1: Mapeamento de permissões**

| Categoria | Permissão |
|---|---|
| usuarios/* | `sistema.usuarios` |
| galpoes/empresas/grupos | `sistema.galpoes_empresas` |
| printnode/* | `sistema.conexoes` |
| backfill-* | `sistema.usuarios` (admin-only — usa essa por ser admin task) |

- [ ] **Step 2: Substituir checks**

Em cada arquivo, troque os checks `cargos.includes("admin")` ou `session.cargo !== "admin"` por:

```ts
if (!userCan(session, "sistema.usuarios")) {  // ou "sistema.conexoes", etc.
  return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
}
```

Para casos como `galpoes/route.ts:153-160` que fazem JOIN buscando usuários admin pra notificar, REVISAR antes de mudar — talvez não seja check de acesso e sim regra de negócio. Se for regra de negócio (notificar quem é admin), MANTER `cargos.includes("admin")` (não é check de acesso do request atual).

- [ ] **Step 3: Type-check + tests**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 4: Smoke test**

Login como admin → `/wms/configuracoes` → tudo carrega. Login como operador → `/wms/configuracoes` → não aparece no menu (Fase 6 já fez isso). API direta `GET /api/wms/admin/usuarios` → 403.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/admin
git commit -m "feat(roles): migra checks de /api/wms/admin pra userCan"
```

---

### Task 11: Migrar checks restantes (cross, pedidos, vendas, separacao)

**Files:**
- Modify: `src/app/api/wms/cross/produtos/[sku]/route.ts:28`
- Modify: `src/app/api/wms/cross/produtos/[sku]/veiculos/[id]/route.ts:19`
- Modify: `src/app/api/wms/cross/produtos/[sku]/oems/[codigo]/route.ts:19`
- Modify: `src/app/api/wms/cross/produtos/[sku]/links/[skuAlvo]/route.ts:28`
- Modify: `src/app/api/wms/pedidos/tracking/route.ts:58-59`
- Modify: `src/app/api/wms/pedidos/[id]/detalhe/route.ts:53-54`
- Modify: `src/app/api/wms/vendas/route.ts:53-54`
- Modify: `src/app/api/wms/vendas/[id]/route.ts:49`
- Modify: `src/app/api/wms/vendas/[id]/vendedor/route.ts:48`
- Modify: `src/app/api/wms/separacao/route.ts:67`
- Modify: `src/app/api/wms/separacao/expedir/route.ts:21`
- Modify: `src/app/api/wms/separacao/retry-etiqueta/route.ts:127`
- Modify: `src/app/api/wms/separacao/forcar-pendente/route.ts:29`
- Modify: `src/app/api/wms/separacao/reimprimir/route.ts:51`
- Modify: `src/app/api/wms/separacao/desfazer-bip/route.ts:23`
- Modify: `src/app/api/wms/separacao/tags/route.ts:19`
- Modify: `src/app/api/wms/separacao/voltar-etapa/route.ts:36`
- Modify: `src/app/api/wms/separacao/[pedidoId]/forcar-pendente/route.ts:29`

- [ ] **Step 1: Mapeamento de permissões**

| Padrão | Substituir por |
|---|---|
| `isAdmin = cargos.includes("admin")` para gating de delete/edit no cross | `userCan(session, "produtos.editar")` |
| `isAdmin = cargos.includes("admin")` + `isComprador = cargos.includes("comprador")` em pedidos (filtro de visibilidade) | `userCan(session, "pedidos.ver")` e ainda preservar `isComprador` se filtra mais rigoroso pra comprador. **MANTER** distinção `isAdmin`/`isComprador` por nome se a lógica usa pra escolher branches — só substitua o CHECK de acesso, não a lógica de branching. |
| `isVendedor = cargos.includes("vendedor")` em vendas | é filtro de visibilidade ("Meus pedidos"). **MANTER** comportamento — substitua só se for check de acesso 403, não de filtragem. |
| `cargos.includes("admin")` em separacao (forcar-pendente, voltar-etapa, tags edit) | `userCan(session, "separacao.executar")` ou `userCan(session, "sistema.usuarios")` dependendo do contexto. Para "forçar pendente", "voltar etapa", "tags edit": é ação operacional sensível → `"separacao.executar"`. |
| `wrongGalpao = !cargos.includes("admin") && pedido.separacao_galpao_id !== session.galpaoId` em retry-etiqueta/reimprimir | Esse check NÃO é de cargo puro, é multi-tenant (galpão). Substitua a primeira parte: `wrongGalpao = !userCan(session, "separacao.executar") && pedido.separacao_galpao_id !== session.galpaoId`. **Reavalie:** admin acima do galpão é vantagem operacional, não obrigatória. Aqui o mais correto seria `userCan(session, "sistema.usuarios")` pra cross-galpão. Decida no contexto. Se em dúvida, deixe `cargos.includes("admin")` e marque `TODO(roles): refinar`. |

- [ ] **Step 2: Substituir caso a caso**

Pra cada arquivo, leia o trecho ao redor do check antes de trocar. Identifique se é:
- **Acesso ao endpoint** (sim: troca por `userCan`)
- **Filtro de visibilidade** (filtra resultados — mantém check de cargo se a lógica é "comprador vê só compras dele")
- **Branching de lógica de negócio** (mantém check)

- [ ] **Step 3: Type-check + tests**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 4: Smoke test focado**

- Cross: admin edita OEM → 200. Operador edita OEM → 200 (não-admin pode editar Cross hoje). Cross delete: só admin → 200; operador → 403.
- Pedidos tracking: admin vê tudo, comprador vê só OC.
- Vendas: vendedor logado → vê só pedidos onde `vendedor_id = self`. Admin → vê todos.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/cross src/app/api/wms/pedidos src/app/api/wms/vendas src/app/api/wms/separacao
git commit -m "feat(roles): migra checks de cross/pedidos/vendas/separacao pra userCan"
```

---

## FASE 3 — UI de gestão

### Task 12: Endpoint `GET /api/wms/admin/permissoes`

**Files:**
- Create: `src/app/api/wms/admin/permissoes/route.ts`

- [ ] **Step 1: Implementar handler**

```ts
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { PERMISSIONS, MODULOS_ORDEM, MODULOS_LABEL } from "@/lib/permissions";

/**
 * GET /api/wms/admin/permissoes
 * Retorna catálogo de permissões do registry (do código), agrupado por módulo.
 * Auth: qualquer sessão válida (público pra usuários autenticados — UI precisa
 * pra listar opções; backend valida acesso real de cada permissão por outro caminho).
 */
export async function GET(request: Request) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const grouped: Record<string, Array<{ codigo: string; label: string }>> = {};
  for (const codigo of Object.keys(PERMISSIONS) as Array<keyof typeof PERMISSIONS>) {
    const p = PERMISSIONS[codigo];
    if (!grouped[p.modulo]) grouped[p.modulo] = [];
    grouped[p.modulo].push({ codigo, label: p.label });
  }

  const modulos = MODULOS_ORDEM.map((m) => ({
    id: m,
    label: MODULOS_LABEL[m],
    permissoes: grouped[m] ?? [],
  }));

  return NextResponse.json({ modulos, total: Object.keys(PERMISSIONS).length });
}
```

- [ ] **Step 2: Smoke test**

`npm run dev` → DevTools console: `fetch("/api/wms/admin/permissoes", { headers: { "X-Session-Id": JSON.parse(localStorage.siso_user).sessionId } }).then(r => r.json()).then(console.log)` → deve retornar 8 módulos, 30 permissões totais.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/admin/permissoes/route.ts
git commit -m "feat(roles): GET /api/wms/admin/permissoes (catálogo do registry)"
```

---

### Task 13: Endpoints `GET/POST /api/wms/admin/roles`

**Files:**
- Create: `src/app/api/wms/admin/roles/route.ts`

- [ ] **Step 1: Implementar GET (lista) e POST (cria)**

```ts
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

const CODIGO_RE = /^[a-z][a-z0-9_]*$/;

/**
 * GET /api/wms/admin/roles
 * Lista roles ativas + counts de permissões e usuários.
 * Auth: sistema.roles
 */
export async function GET(request: Request) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.roles")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_roles")
    .select("id, codigo, nome, descricao, sistema, ativo, criado_em, atualizado_em")
    .order("sistema", { ascending: false })
    .order("nome");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Counts por role
  const ids = (data ?? []).map((r) => r.id);
  const [{ data: perms }, { data: usuarios }] = await Promise.all([
    sb.from("siso_role_permissoes").select("role_id").in("role_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
    sb.from("siso_usuario_roles").select("role_id").in("role_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
  ]);

  const permsByRole = new Map<string, number>();
  for (const p of perms ?? []) permsByRole.set(p.role_id, (permsByRole.get(p.role_id) ?? 0) + 1);
  const usersByRole = new Map<string, number>();
  for (const u of usuarios ?? []) usersByRole.set(u.role_id, (usersByRole.get(u.role_id) ?? 0) + 1);

  const roles = (data ?? []).map((r) => ({
    ...r,
    n_permissoes: permsByRole.get(r.id) ?? 0,
    n_usuarios: usersByRole.get(r.id) ?? 0,
  }));

  return NextResponse.json({ roles });
}

/**
 * POST /api/wms/admin/roles
 * Body: { codigo, nome, descricao? }
 * Cria nova role sem permissões. Codigo deve seguir [a-z][a-z0-9_]*.
 * Auth: sistema.roles
 */
export async function POST(request: Request) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.roles")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  let body: { codigo?: string; nome?: string; descricao?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const codigo = (body.codigo ?? "").trim();
  const nome = (body.nome ?? "").trim();
  const descricao = (body.descricao ?? "").trim() || null;

  if (!codigo || !CODIGO_RE.test(codigo)) {
    return NextResponse.json({ error: "Código inválido (use [a-z][a-z0-9_]*)" }, { status: 400 });
  }
  if (!nome) {
    return NextResponse.json({ error: "Nome obrigatório" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_roles")
    .insert({ codigo, nome, descricao, sistema: false, ativo: true })
    .select("id, codigo, nome, descricao, sistema, ativo, criado_em")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Código já existe" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ role: data }, { status: 201 });
}
```

- [ ] **Step 2: Smoke test**

Login como admin → DevTools: `fetch("/api/wms/admin/roles", { headers: { "X-Session-Id": ... } })` → 200 com 6 roles. POST `{ codigo: "test_role", nome: "Test" }` → 201. POST de novo → 409.

- [ ] **Step 3: Cleanup do teste**

```sql
delete from siso_roles where codigo = 'test_role';
```
(Via mcp__supabase__execute_sql.)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/admin/roles/route.ts
git commit -m "feat(roles): GET/POST /api/wms/admin/roles"
```

---

### Task 14: Endpoints `GET/PATCH/DELETE /api/wms/admin/roles/[id]`

**Files:**
- Create: `src/app/api/wms/admin/roles/[id]/route.ts`

- [ ] **Step 1: Implementar handlers**

```ts
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

interface Ctx { params: Promise<{ id: string }> }

async function authz(request: Request) {
  const session = await getSessionUser(request);
  if (!session) return { error: NextResponse.json({ error: "Não autenticado" }, { status: 401 }) };
  if (!userCan(session, "sistema.roles")) {
    return { error: NextResponse.json({ error: "Acesso negado" }, { status: 403 }) };
  }
  return { session };
}

/** GET /api/wms/admin/roles/[id] — detalhe (permissoes + usuarios) */
export async function GET(request: Request, ctx: Ctx) {
  const a = await authz(request); if (a.error) return a.error;
  const { id } = await ctx.params;
  const sb = createServiceClient();

  const [{ data: role, error: re }, { data: perms }, { data: usuariosRows }] = await Promise.all([
    sb.from("siso_roles").select("id, codigo, nome, descricao, sistema, ativo, criado_em, atualizado_em").eq("id", id).maybeSingle(),
    sb.from("siso_role_permissoes").select("permissao_codigo").eq("role_id", id),
    sb.from("siso_usuario_roles").select("siso_usuarios(id, nome, cargos)").eq("role_id", id),
  ]);

  if (re) return NextResponse.json({ error: re.message }, { status: 500 });
  if (!role) return NextResponse.json({ error: "Role não encontrada" }, { status: 404 });

  const usuarios = (usuariosRows ?? []).map((row) => {
    const u = (row as unknown as { siso_usuarios: { id: string; nome: string; cargos: string[] } | null }).siso_usuarios;
    return u ? { id: u.id, nome: u.nome, roles: u.cargos ?? [] } : null;
  }).filter((u): u is NonNullable<typeof u> => u !== null);

  return NextResponse.json({
    role: {
      ...role,
      permissoes: (perms ?? []).map((p) => p.permissao_codigo),
      usuarios,
    },
  });
}

/** PATCH /api/wms/admin/roles/[id] — edita nome/descricao/ativo */
export async function PATCH(request: Request, ctx: Ctx) {
  const a = await authz(request); if (a.error) return a.error;
  const { id } = await ctx.params;

  let body: { nome?: string; descricao?: string | null; ativo?: boolean };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const sb = createServiceClient();
  const { data: existing } = await sb.from("siso_roles").select("codigo, sistema").eq("id", id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Role não encontrada" }, { status: 404 });

  const update: Record<string, unknown> = {};
  if (typeof body.nome === "string" && body.nome.trim()) update.nome = body.nome.trim();
  if (body.descricao !== undefined) update.descricao = body.descricao?.toString().trim() || null;
  if (typeof body.ativo === "boolean") {
    if (existing.sistema && body.ativo === false) {
      return NextResponse.json({ error: "Role de sistema não pode ser desativada" }, { status: 400 });
    }
    update.ativo = body.ativo;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nada pra atualizar" }, { status: 400 });
  }

  const { data, error } = await sb.from("siso_roles").update(update).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ role: data });
}

/** DELETE /api/wms/admin/roles/[id] — usa RPC wms_role_delete */
export async function DELETE(request: Request, ctx: Ctx) {
  const a = await authz(request); if (a.error) return a.error;
  const { id } = await ctx.params;

  const sb = createServiceClient();
  const { error } = await sb.rpc("wms_role_delete", { p_role_id: id });
  if (error) {
    const status = /sistema|admin|sem nenhuma role/i.test(error.message) ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Smoke test**

Admin: GET `/api/wms/admin/roles/{id_admin}` → 200 com permissoes (30) + usuarios. DELETE `/api/wms/admin/roles/{id_admin}` → 400 (role sistema). PATCH `{ nome: "Administrador" }` no admin → 200, nome muda.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/admin/roles/[id]/route.ts
git commit -m "feat(roles): GET/PATCH/DELETE /api/wms/admin/roles/[id]"
```

---

### Task 15: Endpoint `PUT /api/wms/admin/roles/[id]/permissoes`

**Files:**
- Create: `src/app/api/wms/admin/roles/[id]/permissoes/route.ts`

- [ ] **Step 1: Implementar handler**

```ts
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan, PERMISSAO_CODIGOS } from "@/lib/permissions";

interface Ctx { params: Promise<{ id: string }> }

/**
 * PUT /api/wms/admin/roles/[id]/permissoes
 * Body: { permissoes: string[] }   ← replace completo
 * Regras:
 *  - Role 'admin' sempre tem TODAS as permissões (request é ignorado pra ela)
 *  - Códigos não-existentes no registry são rejeitados (400)
 * Auth: sistema.roles
 */
export async function PUT(request: Request, ctx: Ctx) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.roles")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id } = await ctx.params;
  let body: { permissoes?: string[] };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  if (!Array.isArray(body.permissoes)) {
    return NextResponse.json({ error: "permissoes deve ser array" }, { status: 400 });
  }

  const validSet = new Set<string>(PERMISSAO_CODIGOS);
  const invalidos = body.permissoes.filter((p) => !validSet.has(p));
  if (invalidos.length > 0) {
    return NextResponse.json({ error: "Permissões inválidas", invalidos }, { status: 400 });
  }

  const sb = createServiceClient();
  const { data: role } = await sb.from("siso_roles").select("codigo").eq("id", id).maybeSingle();
  if (!role) return NextResponse.json({ error: "Role não encontrada" }, { status: 404 });

  // admin sempre tem todas as permissões — ignora payload, força all
  const finalSet = role.codigo === "admin" ? PERMISSAO_CODIGOS : Array.from(new Set(body.permissoes));

  // Replace: delete tudo + insert novo (em transação se possível; senão best-effort)
  const { error: delErr } = await sb.from("siso_role_permissoes").delete().eq("role_id", id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  if (finalSet.length > 0) {
    const rows = finalSet.map((p) => ({ role_id: id, permissao_codigo: p }));
    const { error: insErr } = await sb.from("siso_role_permissoes").insert(rows);
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, total: finalSet.length });
}
```

- [ ] **Step 2: Smoke test**

Admin: PUT `/api/wms/admin/roles/{id_vendedor}/permissoes` com body `{ "permissoes": ["vendas.ver", "vendas.criar", "pedidos.ver"] }` → 200 total=3. GET `/api/wms/admin/roles/{id_vendedor}` confirma. PUT com permissão inválida `["foo.bar"]` → 400 + lista. PUT na role admin com `[]` → 200 com `total: 30` (ignorado).

- [ ] **Step 3: Reverter mudança no vendedor**

```sql
delete from siso_role_permissoes where role_id = (select id from siso_roles where codigo = 'vendedor');
insert into siso_role_permissoes (role_id, permissao_codigo)
select id, p from siso_roles, unnest(ARRAY['vendas.ver', 'vendas.criar']) p where codigo = 'vendedor';
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/admin/roles/[id]/permissoes/route.ts
git commit -m "feat(roles): PUT /api/wms/admin/roles/[id]/permissoes (replace)"
```

---

### Task 16: Endpoint `PUT /api/wms/admin/usuarios/[id]/roles`

**Files:**
- Create: `src/app/api/wms/admin/usuarios/[id]/roles/route.ts`

- [ ] **Step 1: Implementar handler**

```ts
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

interface Ctx { params: Promise<{ id: string }> }

/**
 * PUT /api/wms/admin/usuarios/[id]/roles
 * Body: { role_ids: string[] }   ← replace completo
 * Regras:
 *  - Não pode deixar último usuário admin sem role admin
 *  - role_ids vazio é permitido (usuário fica sem acesso — mensagem clara no UI)
 * Auth: sistema.usuarios
 */
export async function PUT(request: Request, ctx: Ctx) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.usuarios")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id: usuarioId } = await ctx.params;
  let body: { role_ids?: string[] };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  if (!Array.isArray(body.role_ids)) {
    return NextResponse.json({ error: "role_ids deve ser array" }, { status: 400 });
  }

  const sb = createServiceClient();

  // Validar IDs existentes
  const { data: existingRoles } = await sb.from("siso_roles").select("id, codigo").in("id", body.role_ids.length ? body.role_ids : ["00000000-0000-0000-0000-000000000000"]);
  if ((existingRoles?.length ?? 0) !== body.role_ids.length) {
    return NextResponse.json({ error: "Uma ou mais roles não existem" }, { status: 400 });
  }

  // Anti-lockout: se este usuário é o último admin do sistema, e novas roles não incluem 'admin'
  const newCodigos = new Set((existingRoles ?? []).map((r) => r.codigo));
  if (!newCodigos.has("admin")) {
    const { data: outrosAdmins } = await sb
      .from("siso_usuario_roles")
      .select("usuario_id, siso_roles!inner(codigo)")
      .eq("siso_roles.codigo", "admin")
      .neq("usuario_id", usuarioId);
    if (!outrosAdmins || outrosAdmins.length === 0) {
      // checar se o próprio era admin
      const { data: eraAdmin } = await sb
        .from("siso_usuario_roles")
        .select("usuario_id, siso_roles!inner(codigo)")
        .eq("siso_roles.codigo", "admin")
        .eq("usuario_id", usuarioId)
        .maybeSingle();
      if (eraAdmin) {
        return NextResponse.json({ error: "Sistema precisa de pelo menos 1 admin" }, { status: 400 });
      }
    }
  }

  // Replace: delete + insert
  const { error: delErr } = await sb.from("siso_usuario_roles").delete().eq("usuario_id", usuarioId);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  if (body.role_ids.length > 0) {
    const rows = body.role_ids.map((rid) => ({ usuario_id: usuarioId, role_id: rid }));
    const { error: insErr } = await sb.from("siso_usuario_roles").insert(rows);
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, role_ids: body.role_ids });
}
```

- [ ] **Step 2: Smoke test**

PUT `/api/wms/admin/usuarios/{user_id}/roles` body `{ role_ids: ["..."] }` → 200. Tente remover admin do único admin → 400.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/admin/usuarios/[id]/roles/route.ts
git commit -m "feat(roles): PUT /api/wms/admin/usuarios/[id]/roles"
```

---

### Task 17: Página `/wms/configuracoes/roles` — lista (master)

**Files:**
- Create: `src/app/wms/configuracoes/roles/page.tsx`

- [ ] **Step 1: Implementar página**

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Lock, Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";

interface RoleRow {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  sistema: boolean;
  ativo: boolean;
  n_permissoes: number;
  n_usuarios: number;
}

export default function RolesPage() {
  const { can } = usePermissoes();

  const { data, isLoading, error } = useQuery({
    queryKey: ["roles"],
    queryFn: async () => {
      const res = await sisoFetch("/api/wms/admin/roles");
      if (!res.ok) throw new Error("Falha ao carregar roles");
      return res.json() as Promise<{ roles: RoleRow[] }>;
    },
    enabled: can("sistema.roles"),
  });

  if (!can("sistema.roles")) {
    return (
      <AppShell>
        <div className="p-6 text-zinc-400">Sem acesso a esta tela.</div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold">Roles & Permissões</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Gerencie roles e o que cada uma pode acessar.
            </p>
          </div>
          <Link
            href="/wms/configuracoes/roles/nova"
            className="inline-flex items-center gap-2 rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-cyan-400"
          >
            <Plus size={16} /> Nova role
          </Link>
        </div>

        {isLoading && <div className="text-zinc-400">Carregando...</div>}
        {error && <div className="text-red-400">Erro ao carregar.</div>}

        {data && (
          <div className="grid gap-2">
            {data.roles.map((r) => (
              <Link
                key={r.id}
                href={`/wms/configuracoes/roles/${r.id}`}
                className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 hover:border-zinc-700"
              >
                <div className="flex items-center gap-3">
                  {r.sistema && <Lock size={14} className="text-zinc-500" />}
                  <div>
                    <div className="font-medium">
                      {r.nome}
                      {!r.ativo && <span className="ml-2 text-xs text-zinc-500">(inativa)</span>}
                    </div>
                    <div className="text-xs text-zinc-500">{r.codigo}</div>
                  </div>
                </div>
                <div className="text-xs text-zinc-400">
                  {r.n_permissoes} permissões · {r.n_usuarios} usuários
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 2: Smoke test**

`/wms/configuracoes/roles` (logado como admin) → 6 cards. Click numa role → leva pra detail (404 ainda porque a página de detail não existe — próxima task).

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/configuracoes/roles/page.tsx
git commit -m "feat(roles): página de lista de roles (/wms/configuracoes/roles)"
```

---

### Task 18: Páginas detail (`/wms/configuracoes/roles/[id]` e `/nova`)

**Files:**
- Create: `src/app/wms/configuracoes/roles/[id]/page.tsx`
- Create: `src/app/wms/configuracoes/roles/nova/page.tsx`

- [ ] **Step 1: Página de criação (`/nova`)**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";

export default function NovaRolePage() {
  const router = useRouter();
  const { can } = usePermissoes();
  const [codigo, setCodigo] = useState("");
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [saving, setSaving] = useState(false);

  if (!can("sistema.roles")) {
    return <AppShell><div className="p-6 text-zinc-400">Sem acesso.</div></AppShell>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await sisoFetch("/api/wms/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo, nome, descricao: descricao || undefined }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      toast.error(data.error ?? "Erro ao criar role");
      return;
    }
    toast.success("Role criada");
    router.push(`/wms/configuracoes/roles/${data.role.id}`);
  }

  return (
    <AppShell>
      <div className="max-w-xl mx-auto p-6">
        <h1 className="text-2xl font-semibold mb-6">Nova role</h1>
        <form onSubmit={submit} className="grid gap-4">
          <label className="grid gap-1">
            <span className="text-sm text-zinc-400">Código</span>
            <input
              required
              pattern="[a-z][a-z0-9_]*"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              placeholder="conferente"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
            />
            <span className="text-xs text-zinc-500">apenas a-z, 0-9, _ — começa com letra</span>
          </label>
          <label className="grid gap-1">
            <span className="text-sm text-zinc-400">Nome</span>
            <input
              required
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Conferente"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-sm text-zinc-400">Descrição (opcional)</span>
            <textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={3}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => router.back()} className="rounded-md px-4 py-2 text-zinc-300 hover:bg-zinc-800">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="rounded-md bg-cyan-500 px-4 py-2 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50">
              {saving ? "Criando..." : "Criar role"}
            </button>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 2: Página de detail (`/[id]`)**

```tsx
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";

interface RoleDetalhada {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  sistema: boolean;
  ativo: boolean;
  permissoes: string[];
  usuarios: Array<{ id: string; nome: string; roles: string[] }>;
}

interface CatalogoModulo {
  id: string;
  label: string;
  permissoes: Array<{ codigo: string; label: string }>;
}

export default function RoleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { can } = usePermissoes();

  const role = useQuery({
    queryKey: ["role", id],
    queryFn: async () => {
      const res = await sisoFetch(`/api/wms/admin/roles/${id}`);
      if (!res.ok) throw new Error();
      return (await res.json()).role as RoleDetalhada;
    },
    enabled: can("sistema.roles"),
  });

  const catalogo = useQuery({
    queryKey: ["permissoes-catalogo"],
    queryFn: async () => {
      const res = await sisoFetch("/api/wms/admin/permissoes");
      if (!res.ok) throw new Error();
      return (await res.json()).modulos as CatalogoModulo[];
    },
    enabled: can("sistema.roles"),
  });

  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [ativo, setAtivo] = useState(true);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (role.data) {
      setNome(role.data.nome);
      setDescricao(role.data.descricao ?? "");
      setAtivo(role.data.ativo);
      setMarcadas(new Set(role.data.permissoes));
    }
  }, [role.data]);

  const isAdminRole = role.data?.codigo === "admin";

  const salvarMeta = useMutation({
    mutationFn: async () => {
      const res = await sisoFetch(`/api/wms/admin/roles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome, descricao, ativo }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Erro");
    },
    onSuccess: () => {
      toast.success("Dados atualizados");
      qc.invalidateQueries({ queryKey: ["role", id] });
      qc.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const salvarPerms = useMutation({
    mutationFn: async () => {
      const res = await sisoFetch(`/api/wms/admin/roles/${id}/permissoes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissoes: Array.from(marcadas) }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Erro");
    },
    onSuccess: () => {
      toast.success("Permissões salvas");
      qc.invalidateQueries({ queryKey: ["role", id] });
      qc.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const deletar = useMutation({
    mutationFn: async () => {
      const res = await sisoFetch(`/api/wms/admin/roles/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Erro");
    },
    onSuccess: () => {
      toast.success("Role deletada");
      qc.invalidateQueries({ queryKey: ["roles"] });
      router.push("/wms/configuracoes/roles");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!can("sistema.roles")) return <AppShell><div className="p-6 text-zinc-400">Sem acesso.</div></AppShell>;
  if (role.isLoading || catalogo.isLoading) return <AppShell><div className="p-6 text-zinc-400">Carregando...</div></AppShell>;
  if (!role.data) return <AppShell><div className="p-6 text-red-400">Role não encontrada.</div></AppShell>;

  function togglePerm(codigo: string) {
    if (isAdminRole) return;
    const next = new Set(marcadas);
    if (next.has(codigo)) next.delete(codigo); else next.add(codigo);
    setMarcadas(next);
  }

  return (
    <AppShell>
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            {role.data.sistema && <Lock size={14} className="text-zinc-500" />}
            <h1 className="text-2xl font-semibold">{role.data.nome}</h1>
          </div>
          <p className="text-sm text-zinc-500">
            Código: <code>{role.data.codigo}</code>
            {role.data.sistema && " (sistema — não editável)"}
          </p>
        </div>

        {/* Dados */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 grid gap-3">
          <label className="grid gap-1">
            <span className="text-sm text-zinc-400">Nome</span>
            <input value={nome} onChange={(e) => setNome(e.target.value)} className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2" />
          </label>
          <label className="grid gap-1">
            <span className="text-sm text-zinc-400">Descrição</span>
            <textarea value={descricao} onChange={(e) => setDescricao(e.target.value)} rows={2} className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2" />
          </label>
          {!role.data.sistema && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
              <span className="text-sm">Ativa</span>
            </label>
          )}
          <div>
            <button onClick={() => salvarMeta.mutate()} disabled={salvarMeta.isPending} className="rounded-md bg-cyan-500 px-4 py-2 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50">
              {salvarMeta.isPending ? "Salvando..." : "Salvar dados"}
            </button>
          </div>
        </section>

        {/* Permissões */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
          <h2 className="font-medium mb-3">Permissões</h2>
          {isAdminRole && (
            <p className="text-xs text-zinc-400 mb-3">
              A role admin sempre tem todas as permissões (read-only).
            </p>
          )}
          <div className="grid gap-4">
            {catalogo.data?.map((m) => (
              <div key={m.id}>
                <h3 className="text-sm font-medium text-zinc-300 mb-2">— {m.label} —</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {m.permissoes.map((p) => (
                    <label key={p.codigo} className={`flex items-center gap-2 rounded px-2 py-1 ${isAdminRole ? "opacity-60" : "hover:bg-zinc-800/50"}`}>
                      <input
                        type="checkbox"
                        checked={isAdminRole ? true : marcadas.has(p.codigo)}
                        disabled={isAdminRole}
                        onChange={() => togglePerm(p.codigo)}
                      />
                      <span className="text-sm">{p.label}</span>
                      <code className="text-xs text-zinc-500">{p.codigo}</code>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4">
            <button onClick={() => salvarPerms.mutate()} disabled={salvarPerms.isPending || isAdminRole} className="rounded-md bg-cyan-500 px-4 py-2 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50">
              {salvarPerms.isPending ? "Salvando..." : "Salvar permissões"}
            </button>
          </div>
        </section>

        {/* Usuários */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
          <h2 className="font-medium mb-3">Usuários ({role.data.usuarios.length})</h2>
          {role.data.usuarios.length === 0 ? (
            <p className="text-sm text-zinc-500">Nenhum usuário com esta role.</p>
          ) : (
            <ul className="grid gap-1">
              {role.data.usuarios.map((u) => (
                <li key={u.id} className="text-sm">
                  • {u.nome}
                  {u.roles.length > 1 && <span className="text-zinc-500"> (também: {u.roles.filter((r) => r !== role.data!.codigo).join(", ")})</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Deletar */}
        {!role.data.sistema && (
          <section className="rounded-lg border border-red-900/30 bg-red-950/10 p-4">
            <h2 className="font-medium text-red-300 mb-2">Zona de perigo</h2>
            <p className="text-sm text-zinc-400 mb-3">
              Deletar esta role remove-a de todos os usuários. Usuários que ficassem sem nenhuma role serão bloqueados.
            </p>
            <button
              onClick={() => {
                if (confirm(`Deletar role "${role.data!.nome}"?`)) deletar.mutate();
              }}
              disabled={deletar.isPending}
              className="rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-500 disabled:opacity-50"
            >
              {deletar.isPending ? "Deletando..." : "Deletar role"}
            </button>
          </section>
        )}
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 3: Smoke test full**

Admin: `/wms/configuracoes/roles` → click "Operador" → vê 21 permissões marcadas, agrupadas por 7 módulos. Marca "vendas.criar", salva → toast verde. F5 → ainda marcado. Volta lista → "Operador" agora mostra 22 permissões. Tenta deletar role sistema → botão nem aparece. Cria nova role "test" → entra na tela detail vazia. Marca 3 perms, salva. Volta, deleta "test" → confirm → vai pra lista.

- [ ] **Step 4: Commit**

```bash
git add src/app/wms/configuracoes/roles/[id]/page.tsx src/app/wms/configuracoes/roles/nova/page.tsx
git commit -m "feat(roles): páginas detail + criação de role"
```

---

### Task 19: Atribuição usuário→roles na edição de usuário

**Files:**
- Modify: a página de edição de usuário (procure por `/wms/configuracoes/usuarios/[id]/page.tsx` ou `/wms/configuracoes/page.tsx` se for tudo numa tela só)

- [ ] **Step 1: Localizar a tela de edição de usuário**

Run: `find src/app/wms/configuracoes -name "page.tsx" | xargs grep -l "cargo"`

Provavelmente é `src/app/wms/configuracoes/page.tsx` ou similar. Leia o arquivo pra entender como o cargo é editado hoje.

- [ ] **Step 2: Adicionar multi-select de roles**

Substitua o dropdown/input atual de `cargo`/`cargos` por:

```tsx
{/* No estado do componente */}
const [rolesSelecionadas, setRolesSelecionadas] = useState<string[]>(usuario.roles?.map((r) => r.id) ?? []);

{/* Carregar lista de roles ativas */}
const { data: rolesAtivas } = useQuery({
  queryKey: ["roles-ativas"],
  queryFn: async () => {
    const res = await sisoFetch("/api/wms/admin/roles");
    if (!res.ok) throw new Error();
    const { roles } = await res.json() as { roles: Array<{ id: string; codigo: string; nome: string; ativo: boolean }> };
    return roles.filter((r) => r.ativo);
  },
});

{/* No JSX */}
<div className="grid gap-2">
  <span className="text-sm font-medium">Roles</span>
  <div className="grid gap-1">
    {(rolesAtivas ?? []).map((r) => (
      <label key={r.id} className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={rolesSelecionadas.includes(r.id)}
          onChange={(e) => {
            setRolesSelecionadas((cur) =>
              e.target.checked ? [...cur, r.id] : cur.filter((id) => id !== r.id),
            );
          }}
        />
        {r.nome}
        <code className="text-xs text-zinc-500">{r.codigo}</code>
      </label>
    ))}
  </div>
</div>
```

- [ ] **Step 3: Salvar via novo endpoint**

No handler de salvar do form, ANTES do PUT/POST de usuário existente (que ainda envia `cargos[]`), adicione um PUT a `/api/wms/admin/usuarios/{id}/roles` com `{ role_ids: rolesSelecionadas }`. O trigger no DB sincroniza `cargos[]` automaticamente, mas pra evitar conflito no PUT do usuário, **NÃO** envie `cargos`/`cargo` nesse PUT a partir de agora — só os outros campos (nome, pin, galpoes, fotos, printnode_*).

Se o handler atual for um único PUT, separe em 2:

```ts
// 1. Atualiza dados do usuário (sem cargos)
const res1 = await sisoFetch(`/api/wms/admin/usuarios/${id}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ nome, pin, galpao_ids /* ... */ }),  // SEM cargos
});

// 2. Atualiza roles
const res2 = await sisoFetch(`/api/wms/admin/usuarios/${id}/roles`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ role_ids: rolesSelecionadas }),
});
```

Trate erros de ambos. Se `res2` falhar, mostre toast vermelho (`res1` já passou e cargos[] vai sair de sync — não tem como ser atômico via HTTP, mas o erro 400 do `roles` PUT geralmente é validação que o user pode corrigir).

- [ ] **Step 4: Smoke test**

Edita um usuário existente → adiciona role "Comprador" → salva → sidebar do usuário ganha "Compras" no próximo login dele.

- [ ] **Step 5: Commit**

```bash
git add src/app/wms/configuracoes  # (path correto da página)
git commit -m "feat(roles): edição de usuário usa multi-select de roles"
```

---

### Task 20: Link "Roles" na home de configurações + docs

**Files:**
- Modify: `src/app/wms/configuracoes/page.tsx`
- Modify: `CLAUDE.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/api-reference-complete.md`
- Modify: `docs/architecture-and-flows.md`

- [ ] **Step 1: Adicionar link na home de configurações**

Abra `src/app/wms/configuracoes/page.tsx`. Procure o grid/lista de cards de configuração. Adicione um card novo:

```tsx
<Link
  href="/wms/configuracoes/roles"
  className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 hover:border-zinc-700"
>
  <h3 className="font-medium">Roles & Permissões</h3>
  <p className="text-sm text-zinc-400 mt-1">
    Gerencie quem pode acessar o quê.
  </p>
</Link>
```

(Mantenha o estilo dos cards existentes.)

- [ ] **Step 2: Atualizar `CLAUDE.md`**

Localize a seção "User Roles (Cargos)" (procure no arquivo). Substitua todo o bloco por:

```markdown
### Roles & Permissões (dinâmico)

Acesso é controlado por **roles editáveis** no UI (`/wms/configuracoes/roles`). Cada role tem um conjunto de permissões (granularidade módulo + ação) do registry em `src/lib/permissions.ts` (30 permissões em 8 módulos).

**Roles padrão (sistema=true, não-deletáveis):**
- `admin` — todas 30 permissões
- `operador` — vendas (exceto criar), separação, compras.ver, estoque, cobertura, operações, inventário ver/executar, insights.ver, relatórios, cadastros
- `operador_cwb` / `operador_sp` — idem `operador` (galpão é dimensão à parte, não permissão)
- `comprador` — pedidos.ver, compras.*, estoque, cobertura, relatórios
- `vendedor` — vendas.ver, vendas.criar

**Cargo legado:** colunas `siso_usuarios.cargo` e `siso_usuarios.cargos[]` ficam nullable como espelho do `siso_usuario_roles` (trigger AFTER mantém sincronizado). Código novo **sempre** checa permissão (`userCan(session, "compras.executar")`), nunca cargo (`cargos.includes("comprador")`).

**Check de acesso no código:**
- Backend: `import { userCan } from "@/lib/permissions"; if (!userCan(session, "perm.x")) return 403;`
- Frontend: `const { can } = usePermissoes(); if (!can("perm.x")) return <SemAcesso />;`
- Sidebar: items em `wms-shell.tsx` têm `requires: PermissaoCodigo[]`.

**Spec/plan:** `docs/superpowers/specs/2026-05-21-roles-permissoes-design.md` + `docs/superpowers/plans/2026-05-21-roles-permissoes.md`.
```

- [ ] **Step 3: Atualizar `docs/database-schema.md`**

Adicione (na seção que lista tabelas, em ordem lexicográfica de prefixo):

```markdown
### Tabelas de Roles & Permissões (2026-05-21)

| Table | Purpose |
|---|---|
| `siso_roles` | Roles editáveis. `id, codigo unique, nome, descricao, sistema, ativo`. `sistema=true` impede delete/rename. Trigger atualiza `atualizado_em`. |
| `siso_role_permissoes` | N:N role↔permissão. PK (`role_id, permissao_codigo`). Códigos validados no app layer contra `PERMISSIONS` em `src/lib/permissions.ts`. |
| `siso_usuario_roles` | N:N usuário↔role. PK (`usuario_id, role_id`). Trigger AFTER sincroniza `siso_usuarios.cargos[]` e `.cargo`. |

**RPC `wms_role_delete(p_role_id)`** — bloqueia delete de role sistema ou que deixaria usuários sem nenhuma role.
```

- [ ] **Step 4: Atualizar `docs/api-reference-complete.md`**

Adicione (na seção `/api/wms/admin`):

```markdown
### `GET /api/wms/admin/roles`
Lista roles + counts (n_permissoes, n_usuarios). Auth: `sistema.roles`.

### `POST /api/wms/admin/roles`
Body: `{ codigo: string, nome: string, descricao?: string }`. Codigo: `[a-z][a-z0-9_]*`. 409 se duplicado. Auth: `sistema.roles`.

### `GET /api/wms/admin/roles/[id]`
Detalhe: role + permissoes[] + usuarios[]. Auth: `sistema.roles`.

### `PATCH /api/wms/admin/roles/[id]`
Body: `{ nome?, descricao?, ativo? }`. Role sistema não pode ser desativada. Auth: `sistema.roles`.

### `DELETE /api/wms/admin/roles/[id]`
Chama RPC `wms_role_delete`. 400 se role sistema ou se geraria órfãos. Auth: `sistema.roles`.

### `PUT /api/wms/admin/roles/[id]/permissoes`
Body: `{ permissoes: string[] }` (replace). Role admin sempre recebe todas. Auth: `sistema.roles`.

### `GET /api/wms/admin/permissoes`
Retorna catálogo do registry agrupado por módulo (30 perms / 8 módulos). Auth: sessão autenticada.

### `PUT /api/wms/admin/usuarios/[id]/roles`
Body: `{ role_ids: string[] }` (replace). 400 se geraria sistema sem admin. Auth: `sistema.usuarios`.
```

- [ ] **Step 5: Atualizar `docs/architecture-and-flows.md`**

Adicione seção nova "Roles & Permissões":

```markdown
## Roles & Permissões

Controle de acesso é via RBAC dinâmico desde 2026-05-21.

### Fluxo de check

1. **Registry (`src/lib/permissions.ts`):** lista canônica de 30 permissões em 8 módulos. Permissões são contratos com o código — cada `userCan(session, "X")` precisa ter X no registry.
2. **Roles (`siso_roles`):** agrupamentos editáveis pelo admin. 6 roles sistema (`admin`, `operador`, `operador_cwb`, `operador_sp`, `comprador`, `vendedor`) não-deletáveis; outras criadas dinamicamente.
3. **Atribuição (`siso_usuario_roles`):** usuário tem 1..N roles. Permissões efetivas = união dos `siso_role_permissoes` das roles ativas.
4. **Sessão:** `getSessionUser()` carrega `permissoes: Set<string>` em cada request (1 query JOIN, ~ms).
5. **Check:** `userCan(session, "compras.executar")` em backend; `usePermissoes().can(...)` em client.

### Defesa em camadas
- **UI esconde** items da sidebar e botões via `requires` / `can()`.
- **API valida** todo endpoint sensível com `userCan` antes de qualquer operação.
- **DB protege** anti-lockout via RPC `wms_role_delete` + validação no endpoint `/usuarios/[id]/roles`.

### Compat legado
`siso_usuarios.cargo` e `.cargos[]` continuam existindo (nullable, espelhados por trigger). Código novo nunca lê esses campos — só permissoes. Remoção definitiva planejada para ~1 mês após Fase 3.
```

- [ ] **Step 6: Commit final**

```bash
git add src/app/wms/configuracoes/page.tsx CLAUDE.md docs/database-schema.md docs/api-reference-complete.md docs/architecture-and-flows.md
git commit -m "docs(roles): atualiza CLAUDE.md + schema + api-ref + architecture"
```

---

### Task 20a: Auditoria de botões de ação por página (defesa em camadas no client)

**Por que esta task existe:** o backend já rejeita ação não-autorizada com 403 (Tasks 8-11), e a sidebar já esconde menus inteiros (Task 6). Mas dentro de páginas que o usuário **tem** acesso, ainda existem botões de ações específicas que só algumas permissões podem disparar. Se o botão fica visível e a API devolve 403, o usuário vê toast vermelho sem entender o porquê — má experiência. Esta task audita cada página e esconde (ou desabilita com tooltip) os botões que o usuário não pode usar.

**Files:**
- Modify (auditoria — pode envolver vários arquivos):
  - `src/app/wms/inventario/page.tsx` — botão "Nova sessão"
  - `src/app/wms/inventario/[id]/*` — botões "Aprovar", "Aplicar", "Cancelar sessão"
  - `src/app/wms/pedidos/page.tsx` e `[id]/page.tsx` — botões "Aprovar" / "Rejeitar"
  - `src/app/wms/separacao/**/*.tsx` — botões "Forçar pendente", "Voltar etapa", "Reimprimir" (admin-only)
  - `src/app/wms/compras/page.tsx` — botões "Comprar", "Receber", "Cancelar OC"
  - `src/app/wms/vendas/nova/page.tsx` — botão "Criar venda" (precisa `vendas.criar`)
  - `src/app/wms/transferir/page.tsx` — botão "Confirmar transferência"
  - `src/app/wms/replenishment/page.tsx` — botão "Confirmar realocação"
  - `src/app/wms/receber/page.tsx` — botão "Receber"
  - `src/app/wms/guarda/**/*.tsx` — botão "Confirmar guarda"
  - `src/app/wms/ajuste/page.tsx` — botão "Aplicar ajuste"
  - `src/app/wms/devolucoes/[id]/page.tsx` — botões de classificação A/B/C/D
  - `src/app/wms/insights/regras/**/*.tsx` — botão "Editar regra"
  - `src/app/wms/produtos/page.tsx` — botões "Editar" / "Sincronizar"
  - `src/app/wms/cross/[sku]/page.tsx` — botões "Adicionar OEM", "Remover OEM", "Adicionar veículo"
  - `src/app/wms/localizacoes/page.tsx` — botões "Nova localização", "Editar"
  - `src/app/wms/fornecedores/page.tsx` — botões "Novo fornecedor", "Editar"

- [ ] **Step 1: Mapear botão → permissão necessária**

Pra cada página listada, abra o arquivo, identifique cada `<button>` ou `<Link href="...">` que dispara uma ação sensível, e mapeie a permissão correspondente (usando a mesma permissão que a API daquele botão checa — consistência absoluta):

| Página | Botão / Ação | Permissão |
|---|---|---|
| `/wms/inventario` | "Nova sessão" | `inventario.supervisionar` |
| `/wms/inventario/[id]` | "Aprovar sessão", "Aplicar movs", "Cancelar sessão" | `inventario.supervisionar` |
| `/wms/inventario/[id]` (handheld) | "Próxima loc", "Confirmar contagem" | `inventario.executar` |
| `/wms/pedidos/[id]` | "Aprovar", "Rejeitar" | `pedidos.aprovar` |
| `/wms/separacao/*` | "Bipar", "Marcar item", "Concluir" | `separacao.executar` |
| `/wms/separacao` | "Forçar pendente", "Voltar etapa", "Reimprimir", "Tags" | `sistema.usuarios` (proxy pra admin) ou nova perm `separacao.admin` (decisão local) |
| `/wms/compras` | "Comprar", "Receber", "Cancelar", "Trocar SKU", "Devolver" | `compras.executar` |
| `/wms/vendas/nova` | "Criar venda" | `vendas.criar` |
| `/wms/transferir` | "Confirmar transferência" | `operacoes.transferir` |
| `/wms/replenishment` | "Confirmar realocação" | `operacoes.replenishment` |
| `/wms/receber` | "Receber" | `operacoes.receber` |
| `/wms/guarda/*` | "Iniciar guarda", "Confirmar guarda" | `operacoes.guarda` |
| `/wms/ajuste` | "Aplicar ajuste" | `operacoes.ajuste_manual` |
| `/wms/devolucoes/[id]` | "Classificar A/B/C/D" | `operacoes.devolucoes` |
| `/wms/insights/regras` | "Nova regra", "Editar", "Deletar", "Testar" | `insights.regras` |
| `/wms/produtos` | "Editar", "Sincronizar" | `produtos.editar` |
| `/wms/cross/[sku]` | "Adicionar/Remover OEM", "Adicionar/Remover veículo", "Adicionar/Remover link manual" | `produtos.editar` |
| `/wms/localizacoes` | "Nova", "Editar", "Substituir e excluir" | `localizacoes.editar` |
| `/wms/fornecedores` | "Novo", "Editar" | `fornecedores.editar` |

**Decisão sobre "separacao admin" (forçar pendente, voltar etapa, reimprimir):** essas ações hoje são gateadas por `cargos.includes("admin")`. São operações sensíveis (mudam status sem passar pelo fluxo normal). Sugestão: tratar como `userCan(session, "separacao.executar")` é fraco demais — qualquer operador teria. **Adicione permissão nova ao registry:** `separacao.administrar` ("Forçar status, voltar etapas, reimprimir etiqueta"). Esta task inclui o passo de adicionar essa permissão.

- [ ] **Step 2: Adicionar permissão `separacao.administrar` ao registry**

Em `src/lib/permissions.ts`, na seção Vendas, adicione:
```ts
"separacao.administrar": { modulo: "vendas", label: "Forçar status / voltar etapa / reimprimir" },
```

Atualize o teste `permissions.test.ts` pra esperar 31 permissões (de 30) e revalide.

Atualize a tabela de seed na migration **se ainda não foi aplicada** (Task 1). Se a migration já foi aplicada, crie migration nova `20260521b_add_separacao_administrar.sql`:
```sql
-- Adiciona permissão nova ao role admin (apenas admin tem por padrão)
insert into siso_role_permissoes (role_id, permissao_codigo)
select id, 'separacao.administrar' from siso_roles where codigo = 'admin'
on conflict do nothing;
```

Atualize Task 11 backend retroativamente (separacao/forcar-pendente/voltar-etapa/reimprimir/tags) pra usar `userCan(session, "separacao.administrar")` em vez do que tiver lá.

- [ ] **Step 3: Padrão de gateamento no client**

Pra cada arquivo da lista do Step 1, importe o hook e gateie o JSX:

```tsx
import { usePermissoes } from "@/lib/auth-context";

export default function InventarioPage() {
  const { can } = usePermissoes();
  // ... resto do componente ...

  return (
    <AppShell>
      {/* ...lista de sessões... */}
      {can("inventario.supervisionar") && (
        <Link href="/wms/inventario/nova" className="...">Nova sessão</Link>
      )}
    </AppShell>
  );
}
```

**Critério:** se o botão só faz sentido com a permissão, ESCONDA (use `{can(...) && <Button/>}`). Se o botão é útil de mostrar mesmo sem permissão (ex: "Editar" num card visualizado por leitura), **DESABILITE com tooltip**:

```tsx
<button
  disabled={!can("produtos.editar")}
  title={!can("produtos.editar") ? "Sem permissão pra editar produto" : ""}
  className="... disabled:opacity-40 disabled:cursor-not-allowed"
>
  Editar
</button>
```

Padrão por convenção neste codebase: **esconder** ações primárias (criar, deletar), **desabilitar** ações inline em listas/cards (editar, ajustar inline). Decida caso a caso. Quando em dúvida, esconda.

- [ ] **Step 4: Iterar página por página**

Pra cada linha da tabela do Step 1:
1. Abra o arquivo
2. Importe `usePermissoes` se ainda não importou
3. Adicione `const { can } = usePermissoes();` no topo do componente
4. Envolva cada botão/link da lista com `can("perm.x")`
5. `npm run dev` → login como operador com permissões restritas → verifica visualmente que o botão sumiu/desabilitou
6. Próxima página

Não precisa commitar entre páginas — pode commitar tudo no final da task. Se uma página tiver muita coisa (separação tem ~10 botões diferentes), commite só ela pra não inflar o diff.

- [ ] **Step 5: Validação visual sistemática**

Crie 5 usuários de teste no Supabase (via UI de admin, depois que Phase 3 estiver pronta), 1 pra cada role base não-admin:

- `teste_operador` → role Operador
- `teste_operador_cwb` → role Operador CWB
- `teste_comprador` → role Comprador
- `teste_vendedor` → role Vendedor
- `teste_conferente` → role customizada com só `inventario.ver` + `inventario.executar`

Pra cada um, faça login e navegue por TODAS as páginas que ele consegue ver. Anote em planilha simples:
| Página | Botão | Esperado | Observado |
|---|---|---|---|

Marque ✅ ou ❌. Conserte o que estiver errado.

- [ ] **Step 6: Commit**

```bash
git add src/lib/permissions.ts src/lib/permissions.test.ts src/app/wms supabase/migrations
git commit -m "feat(roles): esconde/desabilita botões de ação por permissão"
```

(Se foi necessário adicionar `separacao.administrar` retroativamente, inclua a migration nova nesse commit.)

---

## Validação final da Fase 3

### Task 21: Aceitação end-to-end

**Files:** _(só validação)_

- [ ] **Step 1: Build de produção**

Run: `npm run build`
Expected: PASS, sem warnings de tipo.

- [ ] **Step 2: Testes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Critério de aceitação principal**

Admin loga, abre `/wms/configuracoes/roles`, cria role "Conferente":
- código: `conferente`
- nome: `Conferente`

Marca `inventario.ver` + `inventario.executar`, salva. Volta na lista — vê 7 roles totais.

Vai em edição de usuário (algum operador existente), adiciona role "Conferente" pra ele, salva. Logout. Login como esse operador. Sidebar mostra "Inventário" mesmo se ele não tivesse antes (ou já mostrava — confira que não diminuiu).

Remove a role "Conferente" do usuário, deleta a role. Sistema continua íntegro.

- [ ] **Step 4: Anti-lockout**

Tenta retirar role admin do **único** usuário admin existente via UI → erro vermelho. Tenta deletar role `admin` → botão não existe (role sistema).

- [ ] **Step 5: Performance**

Lighthouse / DevTools Network: 1ª request após login carrega `/api/auth/me` em ≤ 200ms (com o JOIN extra). Não há regressão observável vs. baseline.

- [ ] **Step 6: Atualizar `erros-conhecidos.yaml`** (se algum bug foi encontrado durante a execução)

Acrescente uma entrada por bug fixado, conforme convenção do projeto.

---

## Self-Review

**Spec coverage:**
- Seção 1 (Permission registry) → Task 2 ✅ (+ Task 20a adiciona `separacao.administrar`, total 31)
- Seção 2 (Modelo de dados) → Task 1 ✅
- Seção 3 (Camada de checks) → Tasks 3, 4, 6, 7, 8, 9, 10, 11 ✅
- Seção 3.5 (Defesa em camadas no client — botões dentro de páginas) → Task 20a ✅
- Seção 4 (UI de gestão) → Tasks 12-19 ✅
- Seção 5 (Migração + edge cases) → Distribuído (Tasks 1, 5, 21) ✅
- Edge case "permissão removida do código mas no DB" → tratado naturalmente (Set não tem a perm, check falha; UI mostraria nas listas mas sem warning explícito ainda) → **gap conhecido, aceito**: warning UI fica como melhoria pós-MVP (não bloqueante)
- Edge case "usuário sem nenhuma role" → tratado (Set vazio, 403 em tudo)
- Critérios de sucesso → Task 21 ✅

**Placeholder scan:** Nenhum "TBD"/"TODO"/"implement later". Único "TODO(roles): refinar" mencionado é Task 11 step 1 como decisão consciente (multi-tenant cross-galpão) — está explícito que o engenheiro decide no contexto, não é placeholder cego.

**Type consistency:**
- `userCan(session, ...required)` — assinatura idêntica em registry (Task 2) e em todos usos (Tasks 6-11).
- `PermissaoCodigo` é o tipo exportado consistentemente.
- `SessionUser.permissoes: Set<string>` (server) vs `AuthUser.permissoes: string[]` (client, serializável) — diferença é intencional e documentada (hook `usePermissoes` converte pra Set).
- `siso_role_permissoes.permissao_codigo` é text, validado contra `PERMISSAO_CODIGOS` no app layer (PUT endpoint Task 15).

**Migração mecânica (Tasks 8-11):** ~50 checks divididos por área. Cada arquivo listado com linha exata. Padrão de substituição em uma única tabela. Casos especiais (filtro vs acesso) explicitados.

**Plano completo, salvo em `docs/superpowers/plans/2026-05-21-roles-permissoes.md`.**
