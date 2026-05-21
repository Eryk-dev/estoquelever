# Roles & Permissões — Design

**Status:** Approved — pending implementation plan
**Data:** 2026-05-21
**Autor:** brainstorm Eryk + Claude

## Contexto

Hoje o controle de acesso do SISO/WMS está espalhado em três lugares:

1. **Tipo `Cargo`** em `src/types/index.ts:509` — enum hardcoded com 6 valores (`admin`, `operador`, `operador_cwb`, `operador_sp`, `comprador`, `vendedor`).
2. **Sidebar** (`src/components/wms/wms-shell.tsx`) — cada `NavSection`/`NavItem` traz `visibleFor: Cargo[]`.
3. **APIs** (~50 rotas) — checks inline (`cargos.includes("admin")`, `session.cargo !== "admin"`, helper `hasComprasAccess`).

Não existe UI pra alterar o que cada role acessa — toda mudança exige edição de código e deploy. Em pleno crescimento operacional (vendedor adicionado em 2026-05-19, eventualmente vão aparecer "conferente", "supervisor_separacao", combinações ad-hoc), isso vira gargalo.

## Objetivo

Permitir que um admin **configure pelo UI** o que cada role pode acessar, e crie roles novas sem deploy, mantendo type-safety e auditabilidade no código.

## Decisões fundamentais (firmadas no brainstorm)

- **Granularidade:** módulo + ação-chave (`compras.ver`, `compras.executar`, `inventario.aprovar_divergencia`, …). ~27 permissões em 7 módulos. Não vamos descer a nível de endpoint.
- **Permissões vivem no código.** Roles e atribuições role→permissão vivem no DB. Admin não inventa permissão pelo UI — só compõe roles a partir do registry.
- **Cargo legado mantém sincronia.** Trigger reescreve `siso_usuarios.cargos[]` a partir de `siso_usuario_roles` por compat até remoção definitiva.
- **Defesa em camadas:** UI esconde, API valida.

## 1. Permission registry

Arquivo único `src/lib/permissions.ts`:

```ts
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
```

**Total: 30 permissões em 8 módulos** (vendas, visibilidade, operações, inventário, insights, relatórios, cadastros, sistema).

Refatorar o registry implica deploy — é intencional. Cada permissão é um contrato com algum check no código.

## 2. Modelo de dados (Supabase)

### Tabelas novas

```sql
create table siso_roles (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null unique,           -- 'admin', 'operador_cwb', 'conferente'
  nome          text not null,                  -- "Admin", "Conferente"
  descricao     text,
  sistema       boolean not null default false, -- true = não pode deletar nem renomear código
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
```

### Seed inicial (na migration)

6 roles `sistema=true` correspondendo aos cargos atuais, cada uma com permissões equivalentes ao que ela acessa hoje (mapeadas a partir do `wms-shell.tsx` + helpers de API):

| Role | Permissões |
|---|---|
| `admin` | TODAS as 30 |
| `operador` | vendas.* (exceto criar), estoque.*, cobertura.*, operacoes.*, inventario.ver/executar, insights.ver, relatorios.ver, produtos.editar, localizacoes.editar, fornecedores.editar |
| `operador_cwb` | igual `operador` (galpão filtra por outra dimensão, não por permissão) |
| `operador_sp` | igual `operador` |
| `comprador` | pedidos.ver, compras.ver, compras.executar, estoque.ver, cobertura.ver, relatorios.ver |
| `vendedor` | vendas.ver, vendas.criar |

### Backfill

```sql
INSERT INTO siso_usuario_roles (usuario_id, role_id)
SELECT u.id, r.id
FROM siso_usuarios u
JOIN LATERAL unnest(coalesce(u.cargos, ARRAY[u.cargo])) c ON true
JOIN siso_roles r ON r.codigo = c;
```

### Trigger de sincronia legado

```sql
create or replace function wms_sync_cargos_from_roles() returns trigger as $$
begin
  update siso_usuarios u
    set cargos = (
      select array_agg(r.codigo order by r.codigo)
      from siso_usuario_roles ur
      join siso_roles r on r.id = ur.role_id
      where ur.usuario_id = coalesce(new.usuario_id, old.usuario_id)
    ),
    cargo = (
      select r.codigo
      from siso_usuario_roles ur
      join siso_roles r on r.id = ur.role_id
      where ur.usuario_id = coalesce(new.usuario_id, old.usuario_id)
      order by case when r.codigo = 'admin' then 0 else 1 end, r.codigo
      limit 1
    )
    where u.id = coalesce(new.usuario_id, old.usuario_id);
  return null;
end; $$ language plpgsql;

create trigger trg_sync_cargos_after_roles
  after insert or delete on siso_usuario_roles
  for each row execute function wms_sync_cargos_from_roles();
```

### RPC de proteção

```sql
-- Bloqueia delete de role sistema ou que deixaria sistema sem admin
create or replace function wms_role_delete(p_role_id uuid) returns void as $$
declare v_sistema boolean; v_codigo text;
begin
  select sistema, codigo into v_sistema, v_codigo from siso_roles where id = p_role_id;
  if v_sistema then raise exception 'Role de sistema não pode ser deletada'; end if;
  -- usuários afetados ficariam órfãos?
  if exists (
    select 1 from siso_usuario_roles ur
    where ur.role_id = p_role_id
      and not exists (select 1 from siso_usuario_roles ur2 where ur2.usuario_id = ur.usuario_id and ur2.role_id <> p_role_id)
  ) then raise exception 'Usuários ficariam sem role — atribua outra antes de deletar'; end if;
  delete from siso_roles where id = p_role_id;
end; $$ language plpgsql;
```

### Deprecação gradual

- `siso_usuarios.cargo` e `siso_usuarios.cargos[]` ficam nullable, espelhados pelo trigger.
- Remoção definitiva fica como passo futuro depois que todos os checks tiverem migrado e estabilizado por ~1 mês.

## 3. Camada de checks no código

### 3.1 Helper canônico (`src/lib/permissions.ts`)

```ts
export function userCan(
  session: { permissoes: Set<string> } | null,
  ...required: PermissaoCodigo[]
): boolean {
  if (!session) return false;
  return required.every((p) => session.permissoes.has(p));
}

export function userCanAny(
  session: { permissoes: Set<string> } | null,
  ...required: PermissaoCodigo[]
): boolean {
  if (!session) return false;
  return required.some((p) => session.permissoes.has(p));
}
```

### 3.2 Session estendida (`src/lib/session.ts`)

```ts
type SessionUser = {
  id: string;
  nome: string;
  cargo: string;     // mantido por compat — primeira role.codigo
  cargos: string[];  // mantido por compat — roles[].codigo
  roles: Array<{ id: string; codigo: string; nome: string }>;
  permissoes: Set<string>;   // união de todas permissões das roles ativas
  galpao_id: string | null;
  galpoes: Array<{ id: string; nome: string }>;
};
```

`getSessionUser()` ganha 1 query extra (JOIN `siso_usuario_roles` → `siso_roles` ativo → `siso_role_permissoes`) e monta o Set em memória. Sem cache no server (sessão é resolvida 1×/request, custo é desprezível para uma única query JOIN). Client persiste via React Query, refetch automático já existente em `auth-context.tsx` continua funcionando.

### 3.3 Migração mecânica dos checks (~50 ocorrências)

| Antes | Depois |
|---|---|
| `cargos.includes("admin")` | `userCan(session, "<perm>")` (perm específica do contexto) |
| `session.cargo !== "admin"` | `!userCan(session, "<perm>")` |
| `hasComprasAccess(cargos)` | `userCan(session, "compras.executar")` |
| `cargos.includes("comprador")` | `userCan(session, "compras.executar")` |

**Princípio:** checks sempre por permissão, nunca por role. Role é só agrupamento — pode mudar a qualquer momento via UI.

Helpers compostos antigos (`hasComprasAccess`) ficam `@deprecated` mas viram wrappers de `userCan` pra não quebrar nada no commit da migração.

### 3.4 Filtro de sidebar (`wms-shell.tsx`)

```ts
type NavItem = { href: string; icon: string; label: string; requires?: PermissaoCodigo[] };
type NavSection = { id: string; label: string; itens: NavItem[]; requires?: PermissaoCodigo[] };
```

`filterNavForUser(permissoes: Set<string>)` checa `permissoes.has(perm)` em vez de `cargoSet.has(cargo)`. Lógica idêntica.

### 3.5 Hook de página (client)

```ts
const { can } = usePermissoes();
if (!can("sistema.usuarios")) return <SemAcesso />;
```

Adicionado em `src/lib/auth-context.tsx` — usa `user.permissoes` do session já carregado.

## 4. UI de gestão (`/wms/configuracoes/roles`)

Tela nova dentro de Configurações, gated por `userCan("sistema.roles")`.

### Layout — master/detail

```
┌──────────────────────────────────────────────────────────────────────┐
│ Roles                                                  [+ Nova role] │
├─────────────────────────┬────────────────────────────────────────────┤
│  ▸ Admin       (sistema)│  Admin                                     │
│  ▸ Operador             │  Código: admin    (sistema — não editável) │
│  ▸ Operador CWB         │  Descrição: [Acesso completo ao sistema]   │
│  ▸ Operador SP          │  Ativo: ☑                                  │
│  ▸ Comprador            │                                            │
│  ▸ Vendedor             │  Permissões                                │
│                         │  (admin sempre tem todas — read-only)      │
│                         │                                            │
│                         │  ── Vendas ──                              │
│                         │  ☑ Ver Vendas Diretas (vendas.ver)         │
│                         │  ☑ Criar venda manual (vendas.criar)       │
│                         │  ...                                       │
│                         │                                            │
│                         │  Usuários nesta role (3)                   │
│                         │  • Eryk (também: Admin)                    │
│                         │  • João                                    │
│                         │  • Maria                                   │
│                         │                                            │
│                         │             [Cancelar]   [Salvar mudanças] │
└─────────────────────────┴────────────────────────────────────────────┘
```

### Comportamentos

- **Criar nova role:** modal com código (`^[a-z][a-z0-9_]*$`), nome, descrição. Salva sem permissões.
- **Editar permissões:** checkbox por permissão, agrupadas por módulo. Salvar faz `PUT /api/wms/admin/roles/[id]/permissoes` com array completo (replace).
- **Roles sistema (`sistema=true`):** código read-only com ícone de cadeado. Nome/descrição editáveis.
- **Admin role:** todas permissões marcadas e `disabled`. Texto: "A role admin sempre tem todas as permissões."
- **Deletar role:** botão só em `sistema=false`. Modal de confirmação lista usuários afetados; se algum ficaria sem role, bloqueia.
- **Inativar role:** toggle `ativo`. Usuários mantêm vínculo, role não aparece em dropdowns.
- **Lista de usuários da role:** click leva pra edição do usuário.

### Atribuição usuário→role

Não fica nesta tela — fica em `/wms/configuracoes/usuarios/[id]` (que já existe). Dropdown "Cargo" vira "Roles" multi-select listando roles ativas.

### Indicador no header da tela

Card resumo: "30 permissões disponíveis · 6 roles configuradas · 12 usuários ativos" (números ilustrativos).

### Endpoints novos

| Método | Rota | Propósito |
|---|---|---|
| `GET` | `/api/wms/admin/roles` | Lista roles (counts: n_permissoes, n_usuarios) |
| `POST` | `/api/wms/admin/roles` | Cria role `{ codigo, nome, descricao }` |
| `GET` | `/api/wms/admin/roles/[id]` | Role detalhada (permissoes + usuarios) |
| `PATCH` | `/api/wms/admin/roles/[id]` | Edita nome/descricao/ativo |
| `DELETE` | `/api/wms/admin/roles/[id]` | Deleta (chama RPC `wms_role_delete`) |
| `PUT` | `/api/wms/admin/roles/[id]/permissoes` | Replace permissões `{ permissoes: string[] }` |
| `GET` | `/api/wms/admin/permissoes` | Lista catálogo `PERMISSIONS` (do código) |
| `PUT` | `/api/wms/admin/usuarios/[id]/roles` | Replace roles do usuário `{ role_ids: string[] }` |

Todos gated por `userCan("sistema.roles")`, exceto `GET /permissoes` que só exige sessão autenticada.

## 5. Migração e edge cases

### 5.1 Plano de rollout — 3 commits

**Commit 1 — Infra (sem mudar comportamento):**
- Migration: cria 3 tabelas + seeds 6 roles sistema + permissões iniciais + backfill `siso_usuario_roles` + trigger sync + RPC `wms_role_delete`
- `src/lib/permissions.ts` (registry + `userCan` + `userCanAny`)
- `src/lib/session.ts` carrega `permissoes` no SessionUser
- Nenhum check muda — código existente continua usando `cargos`

**Commit 2 — Migração mecânica:**
- `wms-shell.tsx`: `visibleFor` → `requires`
- ~50 rotas: `cargos.includes("X")` → `userCan(session, "perm")`
- `hasComprasAccess` → wrapper de `userCan` (`@deprecated`)
- Resultado: comportamento idêntico ao anterior (permissões espelham cargos via seed)

**Commit 3 — UI de gestão:**
- `/wms/configuracoes/roles` (lista + detail)
- Atribuição usuário→roles em `/configuracoes/usuarios/[id]`
- 8 endpoints novos

Cada commit é deployável independente. Rollback de Commit 2/3 não exige rollback de Commit 1.

### 5.2 Edge cases

| Caso | Comportamento |
|---|---|
| Usuário sem nenhuma role | Login funciona, `permissoes` é Set vazio → vê só `/wms` redirect + 403 em tudo. Mensagem: "Usuário sem acesso configurado — contate o admin." |
| Deletar última role admin do último admin | RPC `wms_role_delete` bloqueia com erro: "Sistema precisa de pelo menos 1 admin." |
| Deletar role `sistema=true` | Bloqueado no UI + RPC `wms_role_delete` |
| Admin desmarca todas perms da própria role admin | UI não deixa (read-only). Backend: endpoint força `permissoes = todas` quando `role.codigo='admin'`. |
| Permissão removida do código mas ainda no DB | `siso_role_permissoes` tem código órfão. Tela `/configuracoes/roles` mostra warning "1 permissão obsoleta — clique pra remover". Checks ignoram códigos órfãos naturalmente (Set não tem o código novo que ninguém pede). |
| Mudança de role enquanto usuário logado | Próxima request resolve session nova → permissões atualizadas. Auto-refresh já existente em `auth-context.tsx` (1×/sessão tab) propaga. |
| Cargos[] legado vs roles | Trigger AFTER INSERT/DELETE em `siso_usuario_roles` reescreve `siso_usuarios.cargos[]` e `.cargo` |
| Performance | Permissões carregadas 1× por session resolve. ~30 strings num Set → check O(1). Sem impacto observável. |

### 5.3 Removal futuro (não nesta entrega)

Depois de ~1 mês estável pós-Commit 3:
- Remover trigger `wms_sync_cargos_from_roles`
- Remover colunas `siso_usuarios.cargo` e `siso_usuarios.cargos[]`
- Remover wrapper `hasComprasAccess`
- Considerar remover flag `sistema=true` (admin pode editar nome de qualquer role; código `admin` continua especial via constraint)

Task futura, não bloqueia esta entrega.

## Impacto em documentação

Updates obrigatórios no mesmo commit do rollout:

- `CLAUDE.md` — seção "User Roles (Cargos)" reescrita pra mencionar roles dinâmicas + registry
- `docs/database-schema.md` — 3 tabelas novas + trigger + RPC
- `docs/api-reference-complete.md` — 8 endpoints novos
- `docs/architecture-and-flows.md` — seção nova "Roles & Permissões" descrevendo o fluxo de check

## Critérios de sucesso

- Admin loga, abre `/wms/configuracoes/roles`, cria role nova "Conferente", marca `inventario.ver` + `inventario.executar`, atribui a um usuário, e o usuário só vê `/wms/inventario` no menu — sem deploy.
- Todos os ~50 checks de cargo existentes continuam comportando-se igual antes do rollout (testado por smoke test manual de cada role após seed).
- Tentar deletar a última role admin do último usuário admin retorna 4xx com mensagem clara.
- Lighthouse / TTI da home `/wms` sem regressão (≤ +20ms na sessão resolve por causa do JOIN extra).
