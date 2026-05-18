# WMS Staging Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Constrói o pipeline `npm run staging:refresh` que espelha dados de prod em staging (Supabase `ehbxpbeijofxtsbezwxd`), popula o WMS via `snapshot-inicial`, desativa tokens Tiny pós-refresh, e fornece sanity check. Resultado: staging vira ambiente realista pra exercitar todas as ~30 telas do WMS sem risco em prod.

**Architecture:** Script local em TypeScript (executado via `tsx`) orquestra 4 etapas — (1) `pg_dump` read-only de prod, (2) `pg_restore --clean` em staging, (3) HTTP `POST /api/wms/snapshot-inicial` no deploy de staging, (4) sanitização SQL via `psql`. Lógica pura (validação de URLs, parsing de flags, construção de SQL) fica em `scripts/lib/staging-pipeline.ts` e é unit-testada com vitest. Orquestração e I/O ficam em `scripts/staging-refresh.ts` e são verificadas via `--dry-run` + smoke test manual.

**Tech Stack:** Node 20+ (fetch nativo), TypeScript strict, `tsx` (run-time), `vitest` (testes), PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`), `dotenv` (já no projeto).

**Spec de referência:** [docs/superpowers/specs/2026-05-11-wms-staging-playground-design.md](../specs/2026-05-11-wms-staging-playground-design.md)

**Out of scope (confirmado no spec §7):** automação CI (GitHub Actions), cutover do WMS em staging (Plano 6 adaptado), cutover em prod (Plano 7), feature flag `WMS_ENABLED`.

---

## Pré-requisitos (validar ANTES da Task 1)

Antes de qualquer código, garantir que o ambiente local consegue rodar o pipeline. Sem isso o resto do plano falha.

### Setup 0.1: Instalar PostgreSQL client tools

**Files:** N/A (operação local)

- [ ] **Step 1: Confirmar ausência das ferramentas**

Run: `which pg_dump psql pg_restore`
Expected: nada retornado (ou "not found") — confirma que precisa instalar.

- [ ] **Step 2: Instalar via Homebrew (macOS)**

Run: `brew install libpq && brew link --force libpq`

`libpq` é o client-only (não instala o servidor inteiro). `--force` cria os symlinks porque `libpq` é keg-only por padrão.

- [ ] **Step 3: Verificar versão**

Run: `pg_dump --version && psql --version && pg_restore --version`
Expected: três linhas, todas com versão >= 15 (Supabase usa Postgres 15).

Se versão < 15, o restore pode falhar com "unsupported version". Atualizar via `brew upgrade libpq`.

### Setup 0.2: Pegar connection strings + worker secret

**Files:** N/A (coleta de credenciais)

- [ ] **Step 1: Pegar PROD_DB_URL**

No Supabase Dashboard → projeto `wrbrbhuhsaaupqsimkqz` → Settings → Database → Connection string → URI mode → **direct connection** (não pooler).

Forma: `postgresql://postgres:<senha>@db.wrbrbhuhsaaupqsimkqz.supabase.co:5432/postgres`

Anotar localmente. Não commitar.

- [ ] **Step 2: Pegar STAGING_DB_URL**

Mesmo procedimento no projeto `ehbxpbeijofxtsbezwxd`.

Forma: `postgresql://postgres:<senha>@db.ehbxpbeijofxtsbezwxd.supabase.co:5432/postgres`

- [ ] **Step 3: Pegar STAGING_APP_URL e STAGING_WORKER_SECRET**

`STAGING_APP_URL`: URL do deploy de Preview do branch `develop` na Vercel. Forma: `https://siso-git-develop-<team>.vercel.app` ou domínio custom de staging se houver.

`STAGING_WORKER_SECRET`: Vercel Dashboard → projeto SISO → Settings → Environment Variables → filtro "Preview" → valor da variável `WORKER_SECRET`.

- [ ] **Step 4: Adicionar ao `.env.local`**

Abrir `/Users/eryk/Documents/ESTOQUE/.env.local` e adicionar (não substitui, só anexa):

```env
# Staging playground — uso APENAS por scripts/staging-refresh.ts
PROD_DB_URL=postgresql://postgres:<senha-prod>@db.wrbrbhuhsaaupqsimkqz.supabase.co:5432/postgres
STAGING_DB_URL=postgresql://postgres:<senha-staging>@db.ehbxpbeijofxtsbezwxd.supabase.co:5432/postgres
STAGING_APP_URL=https://<url-do-deploy-develop>.vercel.app
STAGING_WORKER_SECRET=<o-secret-do-preview-na-vercel>
```

Confirmar que `.env.local` está em `.gitignore` (já está — confirmado).

### Setup 0.3: Instalar deps (incluindo vitest)

**Files:** Modify `package.json` (devDependencies + scripts), `package-lock.json`

- [ ] **Step 1: Adicionar vitest como devDep**

Editar `package.json`, na seção `devDependencies`, adicionar:

```json
"vitest": "^2.1.4"
```

(Versão atual estável quando este plano foi escrito. Se quiser pegar a mais recente, ajustar.)

- [ ] **Step 2: Adicionar npm scripts pra teste**

Editar `package.json`, na seção `scripts`, adicionar:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Instalar**

Run: `npm install`
Expected: `package-lock.json` atualizado, `node_modules/.bin/vitest` existe.

- [ ] **Step 4: Smoke test do vitest**

Run: `npx vitest run --reporter=verbose --passWithNoTests`
Expected: `No test files found, exiting with code 0` (porque ainda não temos testes).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(wms): adiciona vitest pra testes do staging playground

Reinstala vitest (removido em algum merge anterior). Será usado para
unit tests das funções puras de scripts/lib/staging-pipeline.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## File Structure

| Path | Responsabilidade |
|---|---|
| `scripts/lib/staging-pipeline.ts` | **Pure logic.** Constantes (tabelas a incluir/trim/pular), validação de env, parsing de CLI args, construção de SQL de sanitização e trim. Sem I/O. |
| `scripts/lib/staging-pipeline.test.ts` | Unit tests vitest pras funções puras acima. |
| `scripts/staging-refresh.ts` | **Orquestração.** Carrega .env, faz sanity check, executa as 4 etapas (dump→restore→snapshot→sanitize), respeita flags `--dry-run`, `--skip-restore`, `--only-snapshot-inicial`, `--keep-dump`. Faz cleanup do dump file no fim. |
| `scripts/staging-sanity-check.ts` | **Verificação.** Read-only checks contra staging — conta tabelas, valida tokens desativados, marca de ambiente. Saída tabular ✅/❌. |
| `package.json` | npm scripts: `staging:refresh`, `staging:refresh:dry-run`, `staging:sanity-check`. |
| `docs/superpowers/plans/wms-staging-policy.md` | Append: seção "Operação do playground" com passos do primeiro uso e troubleshooting. |

**Decisões de design:**

1. **Por que separar `lib/`?** O orquestrador faz I/O (spawn de processos, fetch HTTP) que é hostil a testes unitários. A lib só tem strings e validação, que são triviais de testar. Mantém o orquestrador curto e óbvio.
2. **Por que `psql` ao invés do `pg` package?** Já vamos depender do PostgreSQL CLI pra `pg_dump`/`pg_restore`. Reutilizar `psql` evita adicionar mais uma dep e mantém consistência (mesma versão, mesmo handshake).
3. **Por que dump full de `siso_webhook_logs` + DELETE no trim?** `pg_dump` não tem flag `--where` (a spec menciona, mas é incorreto). Solução: dump full no passo 1, DELETE em staging no passo 4 (`criado_em < now() - interval '7 days'`).
4. **Por que sanity check no início + URLs explícitas em todas as escritas?** Defesa em camadas contra "rodar destrutivo na URL errada". Quem chamar `runRestore(stagingUrl)` não consegue passar `prodUrl` por engano — a função sabe o que é.

---

## Task 1: Constantes — listas de tabelas

**Files:**
- Create: `scripts/lib/staging-pipeline.ts`
- Create: `scripts/lib/staging-pipeline.test.ts`

- [ ] **Step 1: Escrever o teste das constantes**

Criar `scripts/lib/staging-pipeline.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { TABLES_TO_DUMP, TABLES_TO_TRIM_AFTER_RESTORE, TABLES_INTENTIONALLY_SKIPPED } from './staging-pipeline'

describe('table lists', () => {
  it('TABLES_TO_DUMP includes core SISO tables', () => {
    expect(TABLES_TO_DUMP).toContain('public.siso_galpoes')
    expect(TABLES_TO_DUMP).toContain('public.siso_empresas')
    expect(TABLES_TO_DUMP).toContain('public.siso_pedidos')
    expect(TABLES_TO_DUMP).toContain('public.siso_pedido_itens')
    expect(TABLES_TO_DUMP).toContain('public.siso_pedido_item_estoques')
    expect(TABLES_TO_DUMP).toContain('public.siso_pedido_historico')
    expect(TABLES_TO_DUMP).toContain('public.siso_usuarios')
    expect(TABLES_TO_DUMP).toContain('public.siso_tiny_connections')
    expect(TABLES_TO_DUMP).toContain('public.siso_webhook_logs')
    expect(TABLES_TO_DUMP).toContain('public.siso_produtos_catalogo')
  })

  it('TABLES_TO_DUMP does not include WMS tables (only exist in staging)', () => {
    expect(TABLES_TO_DUMP).not.toContain('public.siso_estoque')
    expect(TABLES_TO_DUMP).not.toContain('public.siso_movimentacoes')
    expect(TABLES_TO_DUMP).not.toContain('public.siso_produtos')
    expect(TABLES_TO_DUMP).not.toContain('public.siso_fornecedores')
  })

  it('TABLES_TO_DUMP does not include logs/sessions (skipped intentionally)', () => {
    expect(TABLES_TO_DUMP).not.toContain('public.siso_logs')
    expect(TABLES_TO_DUMP).not.toContain('public.siso_erros')
    expect(TABLES_TO_DUMP).not.toContain('public.siso_api_calls')
    expect(TABLES_TO_DUMP).not.toContain('public.siso_sessoes')
  })

  it('TABLES_TO_TRIM_AFTER_RESTORE includes siso_webhook_logs', () => {
    expect(TABLES_TO_TRIM_AFTER_RESTORE).toEqual([
      { table: 'siso_webhook_logs', column: 'criado_em', interval: '7 days' },
    ])
  })

  it('TABLES_INTENTIONALLY_SKIPPED documents what is not dumped (for human reference)', () => {
    expect(TABLES_INTENTIONALLY_SKIPPED).toContain('siso_logs')
    expect(TABLES_INTENTIONALLY_SKIPPED).toContain('siso_erros')
    expect(TABLES_INTENTIONALLY_SKIPPED).toContain('siso_estoque')
  })
})
```

- [ ] **Step 2: Rodar teste, confirmar falha**

Run: `npx vitest run scripts/lib/staging-pipeline.test.ts`
Expected: FAIL — `Cannot find module './staging-pipeline'`.

- [ ] **Step 3: Implementar as constantes**

Criar `scripts/lib/staging-pipeline.ts`:

```ts
/**
 * Tabelas dumpadas de prod e restauradas em staging.
 * Lista derivada do spec §4.2.
 * Cada entrada tem o schema explícito (`public.`) pra usar com `pg_dump -t`.
 */
export const TABLES_TO_DUMP: readonly string[] = [
  // Hierarquia
  'public.siso_galpoes',
  'public.siso_empresas',
  'public.siso_grupos',
  'public.siso_grupo_empresas',

  // Pessoas
  'public.siso_usuarios',

  // Pedidos
  'public.siso_pedidos',
  'public.siso_pedido_itens',
  'public.siso_pedido_item_estoques',
  'public.siso_pedido_historico',

  // Compras
  'public.siso_ordens_compra',

  // Inventário e transferências (legado SISO, não WMS)
  'public.siso_inventarios',
  'public.siso_inventario_itens',
  'public.siso_transferencias',
  'public.siso_transferencia_itens',

  // Cross
  'public.siso_produtos_catalogo',
  'public.siso_produto_oems',
  'public.siso_produto_veiculos',

  // Infra
  'public.siso_tiny_connections',
  'public.siso_configuracoes',
  'public.siso_webhook_logs',
] as const

/**
 * Após o restore, alguns dumps trazem volumes grandes que queremos trimar.
 * Aqui em vez de filtrar no dump (pg_dump não tem --where), aplicamos
 * um DELETE em staging logo após.
 */
export const TABLES_TO_TRIM_AFTER_RESTORE: readonly {
  table: string
  column: string
  interval: string
}[] = [
  { table: 'siso_webhook_logs', column: 'criado_em', interval: '7 days' },
] as const

/**
 * Tabelas que NÃO estão no dump, listadas pra documentação.
 * Cada item tem uma razão registrada.
 */
export const TABLES_INTENTIONALLY_SKIPPED: readonly string[] = [
  // Volumosas, sem valor pra teste
  'siso_logs',
  'siso_erros',
  'siso_api_calls',
  'siso_cross_logs',
  // Sessões expiram, melhor pedir login novo
  'siso_sessoes',
  // WMS — não existem em prod, intactas em staging
  'siso_produtos',
  'siso_produto_empresas',
  'siso_localizacoes',
  'siso_estoque',
  'siso_movimentacoes',
  'siso_fornecedores',
  'siso_produto_fornecedores',
  'siso_emprestimo_regras',
  'siso_localizacao_locks',
  'siso_inventario_sessoes',
  'siso_inventario_areas',
  'siso_inventario_localizacoes',
  'siso_inventario_contagens',
  'siso_inventario_divergencias',
  'siso_devolucoes_pendentes',
] as const
```

- [ ] **Step 4: Rodar teste, confirmar passa**

Run: `npx vitest run scripts/lib/staging-pipeline.test.ts`
Expected: PASS — 5 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/staging-pipeline.ts scripts/lib/staging-pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(staging): constantes de tabelas pro pipeline de refresh

Define TABLES_TO_DUMP (21 tabelas SISO/Cross/infra), TABLES_TO_TRIM_AFTER_RESTORE
(trim de webhook_logs > 7d) e TABLES_INTENTIONALLY_SKIPPED (lista documental
de tabelas WMS e logs volumosos que ficam fora do dump).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Validação de URLs (sanity check)

**Files:**
- Modify: `scripts/lib/staging-pipeline.ts`
- Modify: `scripts/lib/staging-pipeline.test.ts`

- [ ] **Step 1: Escrever os testes**

Adicionar no fim de `scripts/lib/staging-pipeline.test.ts`:

```ts
import { validateUrls, UrlValidationError } from './staging-pipeline'

describe('validateUrls', () => {
  const PROD = 'postgresql://postgres:x@db.wrbrbhuhsaaupqsimkqz.supabase.co:5432/postgres'
  const STAGING = 'postgresql://postgres:x@db.ehbxpbeijofxtsbezwxd.supabase.co:5432/postgres'

  it('aceita URLs corretas', () => {
    expect(() => validateUrls(PROD, STAGING)).not.toThrow()
  })

  it('rejeita URLs idênticas', () => {
    expect(() => validateUrls(PROD, PROD)).toThrow(UrlValidationError)
    expect(() => validateUrls(PROD, PROD)).toThrow(/idênticas/i)
  })

  it('rejeita URLs invertidas (PROD onde devia ser STAGING)', () => {
    expect(() => validateUrls(STAGING, PROD)).toThrow(UrlValidationError)
    expect(() => validateUrls(STAGING, PROD)).toThrow(/invertidas|prod.*ref|staging.*ref/i)
  })

  it('rejeita PROD sem o project ref esperado', () => {
    const bogus = 'postgresql://postgres:x@db.someother.supabase.co:5432/postgres'
    expect(() => validateUrls(bogus, STAGING)).toThrow(UrlValidationError)
    expect(() => validateUrls(bogus, STAGING)).toThrow(/wrbrbhuhsaaupqsimkqz/)
  })

  it('rejeita STAGING sem o project ref esperado', () => {
    const bogus = 'postgresql://postgres:x@db.someother.supabase.co:5432/postgres'
    expect(() => validateUrls(PROD, bogus)).toThrow(UrlValidationError)
    expect(() => validateUrls(PROD, bogus)).toThrow(/ehbxpbeijofxtsbezwxd/)
  })

  it('rejeita strings vazias', () => {
    expect(() => validateUrls('', STAGING)).toThrow(UrlValidationError)
    expect(() => validateUrls(PROD, '')).toThrow(UrlValidationError)
  })
})
```

- [ ] **Step 2: Rodar, confirmar falha**

Run: `npx vitest run scripts/lib/staging-pipeline.test.ts`
Expected: FAIL — `validateUrls` não exportado.

- [ ] **Step 3: Implementar**

Adicionar em `scripts/lib/staging-pipeline.ts`:

```ts
export const PROD_PROJECT_REF = 'wrbrbhuhsaaupqsimkqz'
export const STAGING_PROJECT_REF = 'ehbxpbeijofxtsbezwxd'

export class UrlValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UrlValidationError'
  }
}

/**
 * Garante que PROD_DB_URL e STAGING_DB_URL apontam pros projetos certos
 * e não estão invertidas. Falha cedo (antes de qualquer ação destrutiva).
 */
export function validateUrls(prodUrl: string, stagingUrl: string): void {
  if (!prodUrl) throw new UrlValidationError('PROD_DB_URL vazia')
  if (!stagingUrl) throw new UrlValidationError('STAGING_DB_URL vazia')

  if (prodUrl === stagingUrl) {
    throw new UrlValidationError(
      'PROD_DB_URL e STAGING_DB_URL são idênticas. Abortando.'
    )
  }

  if (!prodUrl.includes(PROD_PROJECT_REF)) {
    throw new UrlValidationError(
      `PROD_DB_URL não contém o ref esperado "${PROD_PROJECT_REF}". ` +
      `URL atual aponta pra outro projeto. Abortando.`
    )
  }

  if (!stagingUrl.includes(STAGING_PROJECT_REF)) {
    throw new UrlValidationError(
      `STAGING_DB_URL não contém o ref esperado "${STAGING_PROJECT_REF}". ` +
      `URL atual aponta pra outro projeto. Abortando.`
    )
  }

  if (prodUrl.includes(STAGING_PROJECT_REF) || stagingUrl.includes(PROD_PROJECT_REF)) {
    throw new UrlValidationError(
      'URLs parecem invertidas (PROD com ref de staging ou vice-versa). Abortando.'
    )
  }
}
```

- [ ] **Step 4: Rodar, confirmar passa**

Run: `npx vitest run scripts/lib/staging-pipeline.test.ts`
Expected: PASS — todos os testes verdes.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/staging-pipeline.ts scripts/lib/staging-pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(staging): validateUrls com sanity check de project ref

Bloqueia execução do pipeline se URLs estiverem vazias, idênticas, invertidas,
ou apontando pra outro projeto Supabase. Primeira linha de defesa contra
escrever na prod por engano.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Parser de CLI args

**Files:**
- Modify: `scripts/lib/staging-pipeline.ts`
- Modify: `scripts/lib/staging-pipeline.test.ts`

- [ ] **Step 1: Escrever os testes**

Adicionar no fim de `scripts/lib/staging-pipeline.test.ts`:

```ts
import { parseArgs } from './staging-pipeline'

describe('parseArgs', () => {
  it('defaults: nenhuma flag = execução completa', () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      skipRestore: false,
      onlySnapshotInicial: false,
      keepDump: false,
    })
  })

  it('--dry-run liga o modo dry-run', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true)
  })

  it('--skip-restore pula dump+restore', () => {
    expect(parseArgs(['--skip-restore']).skipRestore).toBe(true)
  })

  it('--only-snapshot-inicial implica skipRestore', () => {
    const args = parseArgs(['--only-snapshot-inicial'])
    expect(args.onlySnapshotInicial).toBe(true)
    expect(args.skipRestore).toBe(true)
  })

  it('--keep-dump mantém o dump file', () => {
    expect(parseArgs(['--keep-dump']).keepDump).toBe(true)
  })

  it('múltiplas flags combinadas', () => {
    expect(parseArgs(['--dry-run', '--keep-dump'])).toEqual({
      dryRun: true,
      skipRestore: false,
      onlySnapshotInicial: false,
      keepDump: true,
    })
  })

  it('rejeita flag desconhecida', () => {
    expect(() => parseArgs(['--unknown'])).toThrow(/flag desconhecida/i)
  })
})
```

- [ ] **Step 2: Rodar, confirmar falha**

Run: `npx vitest run scripts/lib/staging-pipeline.test.ts`
Expected: FAIL — `parseArgs` não exportado.

- [ ] **Step 3: Implementar**

Adicionar em `scripts/lib/staging-pipeline.ts`:

```ts
export interface CliArgs {
  dryRun: boolean
  skipRestore: boolean
  onlySnapshotInicial: boolean
  keepDump: boolean
}

const KNOWN_FLAGS = new Set([
  '--dry-run',
  '--skip-restore',
  '--only-snapshot-inicial',
  '--keep-dump',
])

export function parseArgs(argv: string[]): CliArgs {
  const flags = new Set<string>()

  for (const arg of argv) {
    if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(
        `Flag desconhecida: ${arg}. Aceitas: ${Array.from(KNOWN_FLAGS).join(', ')}`
      )
    }
    flags.add(arg)
  }

  const onlySnapshotInicial = flags.has('--only-snapshot-inicial')

  return {
    dryRun: flags.has('--dry-run'),
    // --only-snapshot-inicial implica skip-restore
    skipRestore: flags.has('--skip-restore') || onlySnapshotInicial,
    onlySnapshotInicial,
    keepDump: flags.has('--keep-dump'),
  }
}
```

- [ ] **Step 4: Rodar, confirmar passa**

Run: `npx vitest run scripts/lib/staging-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/staging-pipeline.ts scripts/lib/staging-pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(staging): parseArgs aceita 4 flags do pipeline

Flags --dry-run, --skip-restore, --only-snapshot-inicial, --keep-dump.
--only-snapshot-inicial implica --skip-restore pra evitar refazer dump à toa.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Builders de SQL (sanitização + trim)

**Files:**
- Modify: `scripts/lib/staging-pipeline.ts`
- Modify: `scripts/lib/staging-pipeline.test.ts`

- [ ] **Step 1: Escrever os testes**

Adicionar no fim de `scripts/lib/staging-pipeline.test.ts`:

```ts
import { buildSanitizationSql, buildTrimSql } from './staging-pipeline'

describe('buildSanitizationSql', () => {
  it('desativa tokens Tiny', () => {
    const sql = buildSanitizationSql()
    expect(sql).toMatch(/UPDATE\s+siso_tiny_connections/i)
    expect(sql).toMatch(/access_token\s*=\s*'STAGING_DISABLED'/i)
    expect(sql).toMatch(/refresh_token\s*=\s*'STAGING_DISABLED'/i)
    expect(sql).toMatch(/ativo\s*=\s*false/i)
  })

  it('limpa sessões (forçar relogin)', () => {
    const sql = buildSanitizationSql()
    expect(sql).toMatch(/DELETE\s+FROM\s+siso_sessoes/i)
  })

  it('marca ambiente=staging em siso_configuracoes', () => {
    const sql = buildSanitizationSql()
    expect(sql).toMatch(/INSERT\s+INTO\s+siso_configuracoes/i)
    expect(sql).toMatch(/'ambiente'/i)
    expect(sql).toMatch(/'staging'/i)
    expect(sql).toMatch(/ON\s+CONFLICT/i)
  })
})

describe('buildTrimSql', () => {
  it('gera DELETE com interval', () => {
    const sql = buildTrimSql([
      { table: 'siso_webhook_logs', column: 'criado_em', interval: '7 days' },
    ])
    expect(sql).toMatch(/DELETE\s+FROM\s+siso_webhook_logs/i)
    expect(sql).toMatch(/criado_em\s*<\s*now\(\)\s*-\s*interval\s*'7 days'/i)
  })

  it('múltiplas tabelas geram múltiplos DELETEs', () => {
    const sql = buildTrimSql([
      { table: 'siso_webhook_logs', column: 'criado_em', interval: '7 days' },
      { table: 'siso_api_calls', column: 'criado_em', interval: '3 days' },
    ])
    expect(sql.match(/DELETE FROM/gi)?.length).toBe(2)
  })

  it('lista vazia retorna SQL vazia', () => {
    expect(buildTrimSql([]).trim()).toBe('')
  })
})
```

- [ ] **Step 2: Rodar, confirmar falha**

Run: `npx vitest run scripts/lib/staging-pipeline.test.ts`
Expected: FAIL — builders não exportados.

- [ ] **Step 3: Implementar**

Adicionar em `scripts/lib/staging-pipeline.ts`:

```ts
/**
 * SQL idempotente que roda em staging logo após restore + snapshot-inicial.
 * Desativa qualquer caminho que possa chamar Tiny e marca o ambiente.
 */
export function buildSanitizationSql(): string {
  return `
-- 1. Desativa tokens Tiny pra que nenhuma ação em staging acerte a API real
UPDATE siso_tiny_connections SET
  access_token = 'STAGING_DISABLED',
  refresh_token = 'STAGING_DISABLED',
  ativo = false;

-- 2. Limpa sessões (forçar relogin — sessões de prod não devem migrar)
DELETE FROM siso_sessoes;

-- 3. Marca ambiente como staging (futuramente: badge "STAGING" no header)
INSERT INTO siso_configuracoes (chave, valor)
  VALUES ('ambiente', 'staging')
  ON CONFLICT (chave) DO UPDATE SET valor = 'staging';
`.trim()
}

interface TrimSpec {
  table: string
  column: string
  interval: string  // ex: '7 days', '24 hours'
}

/**
 * Para tabelas que vieram do dump full mas queremos podar em staging.
 * Roda DEPOIS do restore (caso contrário não tem o que deletar).
 */
export function buildTrimSql(specs: readonly TrimSpec[]): string {
  if (specs.length === 0) return ''
  return specs
    .map(
      (s) =>
        `DELETE FROM ${s.table} WHERE ${s.column} < now() - interval '${s.interval}';`
    )
    .join('\n')
}
```

- [ ] **Step 4: Rodar, confirmar passa**

Run: `npx vitest run scripts/lib/staging-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/staging-pipeline.ts scripts/lib/staging-pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(staging): builders de SQL pra sanitização + trim

buildSanitizationSql: desativa tokens Tiny, limpa sessões, marca ambiente.
buildTrimSql: gera DELETE com interval pra cada spec (usado em webhook_logs).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wrappers de I/O (puro orquestração de processos)

**Files:**
- Modify: `scripts/lib/staging-pipeline.ts`

Esses wrappers fazem spawn de processos externos (`pg_dump`, `pg_restore`, `psql`) e fetch HTTP. Não dá pra unit-testá-los sem mock pesado, então o teste é o `--dry-run` + smoke real na Task 8.

- [ ] **Step 1: Implementar `runPgDump`**

Adicionar no fim de `scripts/lib/staging-pipeline.ts`:

```ts
import { spawnSync } from 'node:child_process'

export interface CommandResult {
  stdout: string
  stderr: string
  status: number
}

/**
 * Roda pg_dump pegando as tabelas listadas e gravando num arquivo .dump.
 * Em dry-run, só imprime o comando que rodaria.
 */
export function runPgDump(
  prodUrl: string,
  outFile: string,
  tables: readonly string[],
  options: { dryRun: boolean } = { dryRun: false }
): CommandResult {
  const args = [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--no-acl',
    '--file', outFile,
    ...tables.flatMap((t) => ['--table', t]),
    prodUrl,
  ]

  if (options.dryRun) {
    console.log('[dry-run] pg_dump', args.slice(0, -1).join(' '), '<PROD_URL>')
    return { stdout: '', stderr: '', status: 0 }
  }

  console.log(`[dump] iniciando — ${tables.length} tabelas, saída: ${outFile}`)
  const result = spawnSync('pg_dump', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  if (result.status !== 0) {
    throw new Error(`pg_dump falhou com status ${result.status}`)
  }

  return { stdout: '', stderr: '', status: 0 }
}
```

- [ ] **Step 2: Implementar `runPgRestore`**

Adicionar:

```ts
/**
 * Restaura o dump em staging com --clean (TRUNCATE antes de inserir).
 * Em dry-run, só imprime.
 */
export function runPgRestore(
  stagingUrl: string,
  dumpFile: string,
  options: { dryRun: boolean } = { dryRun: false }
): CommandResult {
  const args = [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--no-acl',
    '--single-transaction',
    '--dbname', stagingUrl,
    dumpFile,
  ]

  if (options.dryRun) {
    const masked = args.map((a) =>
      a.startsWith('postgresql://') ? '<STAGING_URL>' : a
    )
    console.log('[dry-run] pg_restore', masked.join(' '))
    return { stdout: '', stderr: '', status: 0 }
  }

  console.log(`[restore] aplicando ${dumpFile} em staging`)
  const result = spawnSync('pg_restore', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  if (result.status !== 0) {
    throw new Error(`pg_restore falhou com status ${result.status}`)
  }

  return { stdout: '', stderr: '', status: 0 }
}
```

- [ ] **Step 3: Implementar `runPsql`**

Adicionar:

```ts
/**
 * Roda um bloco SQL contra uma URL via psql (-c).
 * Usado pra sanitização e trim.
 * --single-transaction garante atomicidade (tudo ou nada).
 */
export function runPsql(
  url: string,
  sql: string,
  options: { dryRun: boolean; label?: string } = { dryRun: false }
): CommandResult {
  if (!sql.trim()) {
    console.log(`[psql${options.label ? ' ' + options.label : ''}] SQL vazia, pulando`)
    return { stdout: '', stderr: '', status: 0 }
  }

  if (options.dryRun) {
    console.log(`[dry-run psql${options.label ? ' ' + options.label : ''}]`)
    console.log(sql.split('\n').map((l) => '  ' + l).join('\n'))
    return { stdout: '', stderr: '', status: 0 }
  }

  console.log(`[psql${options.label ? ' ' + options.label : ''}] executando...`)
  const result = spawnSync(
    'psql',
    ['--single-transaction', '--quiet', '-v', 'ON_ERROR_STOP=1', '-c', sql, url],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  if (result.status !== 0) {
    console.error('[psql] stderr:', result.stderr)
    throw new Error(`psql falhou com status ${result.status}`)
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  }
}
```

- [ ] **Step 4: Implementar `callSnapshotInicial`**

Adicionar:

```ts
/**
 * Chama POST /api/wms/snapshot-inicial no deploy de staging.
 * O endpoint usa os tokens Tiny ainda válidos (vindos do dump) pra ler
 * estoque e popular siso_estoque via ledger.
 */
export async function callSnapshotInicial(
  appUrl: string,
  workerSecret: string,
  options: { dryRun: boolean } = { dryRun: false }
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${appUrl.replace(/\/$/, '')}/api/wms/snapshot-inicial`

  if (options.dryRun) {
    console.log(`[dry-run] POST ${url}  (x-worker-secret: ***)`)
    return { ok: true, status: 0, body: '<dry-run>' }
  }

  console.log(`[snapshot-inicial] POST ${url}`)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-worker-secret': workerSecret,
      'content-type': 'application/json',
    },
  })

  const body = await res.text()

  if (!res.ok) {
    console.error('[snapshot-inicial] falhou:', res.status, body)
    throw new Error(`snapshot-inicial retornou ${res.status}: ${body}`)
  }

  return { ok: true, status: res.status, body }
}
```

- [ ] **Step 5: Verificar que TypeScript compila**

Run: `npx tsc --noEmit scripts/lib/staging-pipeline.ts`
Expected: zero erros.

(Se houver erro de "Cannot find module 'node:child_process'", confirmar que `@types/node` está em devDeps — está.)

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/staging-pipeline.ts
git commit -m "$(cat <<'EOF'
feat(staging): wrappers de pg_dump, pg_restore, psql e fetch

runPgDump + runPgRestore + runPsql via spawnSync; callSnapshotInicial via
fetch. Todos respeitam { dryRun: true } imprimindo o comando sem executar.
URLs e secrets são mascarados nos logs de dry-run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Orquestração principal — `scripts/staging-refresh.ts`

**Files:**
- Create: `scripts/staging-refresh.ts`

- [ ] **Step 1: Criar o entry point**

Criar `scripts/staging-refresh.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Pipeline de refresh staging.
 *
 * Espelha dados de prod em staging, popula WMS via snapshot-inicial,
 * desativa tokens Tiny em staging.
 *
 * Veja docs/superpowers/specs/2026-05-11-wms-staging-playground-design.md
 */
import 'dotenv/config'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TABLES_TO_DUMP,
  TABLES_TO_TRIM_AFTER_RESTORE,
  validateUrls,
  parseArgs,
  buildSanitizationSql,
  buildTrimSql,
  runPgDump,
  runPgRestore,
  runPsql,
  callSnapshotInicial,
} from './lib/staging-pipeline'

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const PROD_DB_URL = process.env.PROD_DB_URL ?? ''
  const STAGING_DB_URL = process.env.STAGING_DB_URL ?? ''
  const STAGING_APP_URL = process.env.STAGING_APP_URL ?? ''
  const STAGING_WORKER_SECRET = process.env.STAGING_WORKER_SECRET ?? ''

  console.log('━'.repeat(60))
  console.log('WMS Staging Refresh')
  console.log('━'.repeat(60))
  console.log('Flags:', args)

  // ── Sanity check (sempre roda, mesmo em dry-run) ────────────────────
  validateUrls(PROD_DB_URL, STAGING_DB_URL)
  if (!STAGING_APP_URL.startsWith('https://')) {
    throw new Error('STAGING_APP_URL deve começar com https://')
  }
  if (!STAGING_WORKER_SECRET) {
    throw new Error('STAGING_WORKER_SECRET vazio')
  }
  console.log('✓ Sanity check passou')

  // ── Setup arquivo temporário ────────────────────────────────────────
  const tmpDir = mkdtempSync(join(tmpdir(), 'siso-staging-refresh-'))
  const dumpFile = join(tmpDir, 'prod.dump')
  console.log(`Dump file: ${dumpFile}`)

  try {
    // ── Passo 1+2: Dump + Restore ─────────────────────────────────────
    if (args.skipRestore) {
      console.log('⏭  Pulando dump + restore (--skip-restore ou --only-snapshot-inicial)')
    } else {
      console.log('\n▶ Passo 1/4: pg_dump de prod')
      runPgDump(PROD_DB_URL, dumpFile, TABLES_TO_DUMP, { dryRun: args.dryRun })

      console.log('\n▶ Passo 2/4: pg_restore em staging')
      runPgRestore(STAGING_DB_URL, dumpFile, { dryRun: args.dryRun })

      // Trim de tabelas grandes (DELETE em staging)
      const trimSql = buildTrimSql(TABLES_TO_TRIM_AFTER_RESTORE)
      if (trimSql) {
        console.log('\n▶ Trim de tabelas grandes pós-restore')
        runPsql(STAGING_DB_URL, trimSql, { dryRun: args.dryRun, label: 'trim' })
      }
    }

    // ── Passo 3: snapshot-inicial ─────────────────────────────────────
    console.log('\n▶ Passo 3/4: snapshot-inicial (lê Tiny, popula siso_estoque)')
    await callSnapshotInicial(STAGING_APP_URL, STAGING_WORKER_SECRET, {
      dryRun: args.dryRun,
    })

    // ── Passo 4: sanitização ──────────────────────────────────────────
    console.log('\n▶ Passo 4/4: sanitização (desativa tokens Tiny)')
    runPsql(STAGING_DB_URL, buildSanitizationSql(), {
      dryRun: args.dryRun,
      label: 'sanitize',
    })

    console.log('\n✅ Pipeline concluído com sucesso')
  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────
    if (args.keepDump) {
      console.log(`\n📂 Dump mantido em ${dumpFile} (--keep-dump)`)
    } else if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
      console.log(`\n🗑  Dump file removido (${tmpDir})`)
    }
  }
}

main().catch((err) => {
  console.error('\n❌ Erro:', err instanceof Error ? err.message : err)
  process.exit(1)
})
```

- [ ] **Step 2: Verificar que TypeScript compila**

Run: `npx tsc --noEmit scripts/staging-refresh.ts`
Expected: zero erros.

- [ ] **Step 3: Testar `--dry-run` (sem credenciais reais necessárias pra ver flow)**

Confirmar que `.env.local` já tem as 4 variáveis preenchidas (Setup 0.2).

Run: `npx tsx scripts/staging-refresh.ts --dry-run`

Expected output (resumido):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WMS Staging Refresh
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Flags: { dryRun: true, skipRestore: false, ... }
✓ Sanity check passou
Dump file: /tmp/siso-staging-refresh-XXXX/prod.dump

▶ Passo 1/4: pg_dump de prod
[dry-run] pg_dump --format=custom ... --table public.siso_galpoes ... <PROD_URL>

▶ Passo 2/4: pg_restore em staging
[dry-run] pg_restore --clean ... --dbname <STAGING_URL> /tmp/.../prod.dump

▶ Trim de tabelas grandes pós-restore
[dry-run psql trim]
  DELETE FROM siso_webhook_logs WHERE criado_em < now() - interval '7 days';

▶ Passo 3/4: snapshot-inicial (...)
[dry-run] POST https://<staging>.vercel.app/api/wms/snapshot-inicial  (x-worker-secret: ***)

▶ Passo 4/4: sanitização (desativa tokens Tiny)
[dry-run psql sanitize]
  UPDATE siso_tiny_connections SET ...
  DELETE FROM siso_sessoes;
  INSERT INTO siso_configuracoes ...

✅ Pipeline concluído com sucesso
🗑  Dump file removido (/tmp/siso-staging-refresh-XXXX)
```

Se qualquer passo imprimir uma URL real (com senha) em vez do placeholder, abrir um defect no script e mascarar antes de continuar.

- [ ] **Step 4: Testar sanity check rejeitando URL errada**

Temporariamente, editar `.env.local` invertendo `PROD_DB_URL` e `STAGING_DB_URL`. Rodar:

Run: `npx tsx scripts/staging-refresh.ts --dry-run`
Expected: `❌ Erro: URLs parecem invertidas ...` e exit code 1.

Restaurar `.env.local` correto antes de continuar.

- [ ] **Step 5: Commit**

```bash
git add scripts/staging-refresh.ts
git commit -m "$(cat <<'EOF'
feat(staging): orquestrador staging-refresh.ts

Pipeline em 4 etapas (dump→restore→snapshot-inicial→sanitize) com
sanity check inicial, dump file em /tmp, cleanup garantido via try/finally.
Respeita flags --dry-run, --skip-restore, --only-snapshot-inicial, --keep-dump.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Sanity check pós-refresh

**Files:**
- Create: `scripts/staging-sanity-check.ts`

- [ ] **Step 1: Criar o script**

Criar `scripts/staging-sanity-check.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Verifica que staging está num estado coerente pós-refresh.
 * Read-only: nenhuma escrita acontece aqui.
 */
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { STAGING_PROJECT_REF } from './lib/staging-pipeline'

interface Check {
  label: string
  query: string
  validate: (rows: Record<string, unknown>[]) => { ok: boolean; detail?: string }
}

const checks: Check[] = [
  {
    label: 'Conexão e identidade do banco',
    query: `SELECT current_database() AS db, inet_server_addr()::text AS host;`,
    validate: () => ({ ok: true }),  // só queremos que a conexão funcione
  },
  {
    label: 'Pedidos populados (siso_pedidos)',
    query: `SELECT count(*)::int AS n FROM siso_pedidos;`,
    validate: (rows) => {
      const n = Number((rows[0] as { n: number }).n)
      return { ok: n > 0, detail: `${n} pedidos` }
    },
  },
  {
    label: 'Catálogo Cross populado (siso_produtos_catalogo)',
    query: `SELECT count(*)::int AS n FROM siso_produtos_catalogo;`,
    validate: (rows) => {
      const n = Number((rows[0] as { n: number }).n)
      return { ok: n > 0, detail: `${n} produtos no catálogo` }
    },
  },
  {
    label: 'WMS: estoque populado (siso_estoque)',
    query: `SELECT count(*)::int AS n, count(DISTINCT produto_id)::int AS skus FROM siso_estoque WHERE saldo > 0;`,
    validate: (rows) => {
      const r = rows[0] as { n: number; skus: number }
      const n = Number(r.n)
      const skus = Number(r.skus)
      return {
        ok: skus >= 100,
        detail: `${n} linhas, ${skus} SKUs com saldo > 0 (critério: ≥100)`,
      }
    },
  },
  {
    label: 'WMS: ledger populado (siso_movimentacoes)',
    query: `SELECT count(*)::int AS n FROM siso_movimentacoes;`,
    validate: (rows) => {
      const n = Number((rows[0] as { n: number }).n)
      return { ok: n > 0, detail: `${n} movimentações` }
    },
  },
  {
    label: 'Tokens Tiny desativados',
    query: `SELECT count(*)::int AS total, count(*) FILTER (WHERE ativo = false AND access_token = 'STAGING_DISABLED')::int AS desativados FROM siso_tiny_connections;`,
    validate: (rows) => {
      const r = rows[0] as { total: number; desativados: number }
      return {
        ok: r.total > 0 && r.total === r.desativados,
        detail: `${r.desativados}/${r.total} desativados`,
      }
    },
  },
  {
    label: 'Marca de ambiente = staging',
    query: `SELECT valor FROM siso_configuracoes WHERE chave = 'ambiente';`,
    validate: (rows) => {
      const v = (rows[0] as { valor?: string } | undefined)?.valor
      return { ok: v === 'staging', detail: v ?? '<não encontrado>' }
    },
  },
  {
    label: 'Webhook logs trimados (≤ 7 dias)',
    query: `SELECT count(*)::int AS antigos FROM siso_webhook_logs WHERE criado_em < now() - interval '7 days';`,
    validate: (rows) => {
      const n = Number((rows[0] as { antigos: number }).antigos)
      return { ok: n === 0, detail: `${n} registros mais antigos que 7d` }
    },
  },
]

async function run() {
  const url = process.env.STAGING_DB_URL ?? ''
  if (!url.includes(STAGING_PROJECT_REF)) {
    throw new Error(
      `STAGING_DB_URL não contém o ref esperado "${STAGING_PROJECT_REF}". Abortando.`
    )
  }

  console.log('━'.repeat(60))
  console.log('WMS Staging Sanity Check')
  console.log('━'.repeat(60))

  let allOk = true

  for (const check of checks) {
    const result = spawnSync(
      'psql',
      ['--no-align', '--field-separator=|', '--quiet', '-t', '-c', check.query, url],
      { encoding: 'utf8' }
    )

    if (result.status !== 0) {
      console.log(`❌ ${check.label}`)
      console.log(`   ${result.stderr?.split('\n')[0] ?? '(sem stderr)'}`)
      allOk = false
      continue
    }

    // Parse simples do output de psql -t (linhas, campos separados por |)
    const lines = result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)

    const rows = lines.map((line) => {
      const fields = line.split('|').map((f) => f.trim())
      const obj: Record<string, string> = {}
      // Sem header em -t mode; usar índices nomeados das colunas via query
      // Quick hack: query usa AS, então pegamos só a primeira coluna como single value
      // Para queries com múltiplas colunas, usar split + nomes na ordem da query
      // Pra simplicidade, validate() acessa por posição quando precisa
      fields.forEach((v, i) => {
        obj[String(i)] = v
      })
      return obj
    })

    // Converter o shape pra algo que validate() entende.
    // Como -t não retorna header, mapeamos manualmente as colunas comuns:
    const enriched = rows.map((r) => {
      const vals = Object.values(r)
      return {
        n: Number(vals[0]),
        skus: vals[1] !== undefined ? Number(vals[1]) : undefined,
        antigos: Number(vals[0]),
        valor: vals[0],
        total: Number(vals[0]),
        desativados: vals[1] !== undefined ? Number(vals[1]) : undefined,
      }
    })

    const { ok, detail } = check.validate(enriched)
    console.log(`${ok ? '✅' : '❌'} ${check.label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) allOk = false
  }

  console.log('━'.repeat(60))
  console.log(allOk ? '✅ Tudo verde' : '❌ Algum check falhou')
  if (!allOk) process.exit(1)
}

run().catch((err) => {
  console.error('Erro:', err instanceof Error ? err.message : err)
  process.exit(1)
})
```

- [ ] **Step 2: Verificar que TypeScript compila**

Run: `npx tsc --noEmit scripts/staging-sanity-check.ts`
Expected: zero erros.

- [ ] **Step 3: Rodar contra staging (mesmo sem refresh ainda — algum check vai falhar, esperado)**

Run: `npx tsx scripts/staging-sanity-check.ts`

Expected: alguns ✅ (conexão OK, marca ambiente talvez ❌) e alguns ❌ (pedidos vazio, etc). Output deve ser legível, sem crash.

- [ ] **Step 4: Commit**

```bash
git add scripts/staging-sanity-check.ts
git commit -m "$(cat <<'EOF'
feat(staging): script staging-sanity-check.ts

Checks read-only contra STAGING_DB_URL: pedidos, catálogo Cross, estoque
WMS (≥100 SKUs), ledger, tokens desativados, marca de ambiente, trim de
webhook_logs. Exit code 1 se algum falhar.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: npm scripts e documentação

**Files:**
- Modify: `package.json`
- Modify: `docs/superpowers/plans/wms-staging-policy.md`

- [ ] **Step 1: Adicionar npm scripts**

Editar `package.json`, na seção `scripts`, adicionar (mantendo os existentes):

```json
"staging:refresh": "tsx scripts/staging-refresh.ts",
"staging:refresh:dry-run": "tsx scripts/staging-refresh.ts --dry-run",
"staging:sanity-check": "tsx scripts/staging-sanity-check.ts"
```

Resultado final da seção `scripts`:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "test": "vitest run",
  "test:watch": "vitest",
  "seed:cross": "tsx scripts/seed-cross-catalogo.ts",
  "staging:refresh": "tsx scripts/staging-refresh.ts",
  "staging:refresh:dry-run": "tsx scripts/staging-refresh.ts --dry-run",
  "staging:sanity-check": "tsx scripts/staging-sanity-check.ts"
}
```

- [ ] **Step 2: Smoke test dos scripts**

Run: `npm run staging:refresh:dry-run`
Expected: mesmo output da Task 6 Step 3.

Run: `npm run staging:sanity-check`
Expected: tabela de checks (pode ter falhas se ainda não refreshou).

- [ ] **Step 3: Adicionar seção operacional em `wms-staging-policy.md`**

Ler `docs/superpowers/plans/wms-staging-policy.md` para entender o que já existe, e adicionar **no fim do arquivo** (criar o arquivo se não existir) uma nova seção:

```markdown
---

## Operação do playground (a partir de 2026-05-18)

Pipeline completo no `scripts/staging-refresh.ts`. Spec: [`docs/superpowers/specs/2026-05-11-wms-staging-playground-design.md`](../specs/2026-05-11-wms-staging-playground-design.md).

### Pré-requisitos (uma vez)

1. PostgreSQL client tools instalados: `brew install libpq && brew link --force libpq`
2. `.env.local` com as 4 variáveis: `PROD_DB_URL`, `STAGING_DB_URL`, `STAGING_APP_URL`, `STAGING_WORKER_SECRET`
3. `npm install` executado

### Primeiro uso

```bash
# 1. Dry-run pra ver o que vai acontecer (sem executar nada)
npm run staging:refresh:dry-run

# 2. (Opcional) Backup manual do staging atual, paranoia primeira vez
pg_dump --format=custom "$STAGING_DB_URL" > /tmp/staging-pre-refresh-$(date +%Y%m%d).dump

# 3. Refresh real (5-10 min)
npm run staging:refresh

# 4. Conferir
npm run staging:sanity-check
```

Depois disso, abrir `${STAGING_APP_URL}` no browser, logar com `Eryk / 1234`, conferir que `/siso` tem pedidos e `/wms/estoque` tem saldos.

### Refresh recorrente

Toda vez que quiser dados frescos:

```bash
npm run staging:refresh
```

### Flags úteis

- `--dry-run`: imprime tudo sem executar destrutivo
- `--skip-restore`: pula dump+restore (usa o que já tem em staging, só roda snapshot+sanitize)
- `--only-snapshot-inicial`: implica `--skip-restore`. Só roda o passo 3 (re-popula `siso_estoque` lendo Tiny). Útil pra debugar problema do WMS sem refazer o dump full.
- `--keep-dump`: mantém o `/tmp/.../prod.dump` ao invés de deletar (debug)

### Troubleshooting

| Sintoma | Causa provável | Ação |
|---|---|---|
| `UrlValidationError: URLs parecem invertidas` | `.env.local` com URLs trocadas | Conferir e corrigir |
| `pg_dump: command not found` | libpq não instalado/linked | `brew link --force libpq` ou reinstalar |
| `pg_restore: error: unsupported version` | Cliente mais velho que servidor | Atualizar libpq |
| `snapshot-inicial` 401 | `STAGING_WORKER_SECRET` errado | Conferir env vars na Vercel (Preview) |
| `snapshot-inicial` 500 com erro Tiny | Tokens vieram inválidos no dump | Rodar refresh full de novo |
| `/wms/estoque` vazio após refresh | Vercel `develop` apontando pra prod | Conferir env vars do Preview |

### Salvaguardas implementadas

- Sanity check no início aborta se URLs invertidas/iguais/erradas
- Toda escrita usa `STAGING_DB_URL` explicitamente; prod só recebe `pg_dump` (read-only)
- Após sanitize, tokens Tiny em staging viram `STAGING_DISABLED` + `ativo=false`
- `siso_configuracoes.ambiente = 'staging'` permite badge "STAGING" futuro
- Dump file em `/tmp` é deletado no `finally` (a menos que `--keep-dump`)
```

- [ ] **Step 4: Commit**

```bash
git add package.json docs/superpowers/plans/wms-staging-policy.md
git commit -m "$(cat <<'EOF'
feat(staging): npm scripts + docs operacionais do playground

Adiciona staging:refresh, staging:refresh:dry-run e staging:sanity-check
em package.json. Documenta primeiro uso, refresh recorrente, flags e
troubleshooting em wms-staging-policy.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Smoke test end-to-end (gate manual antes de declarar done)

**Files:** N/A (validação)

Esse task não escreve código — é o gate de validação que confirma os critérios de sucesso do spec §8.

- [ ] **Step 1: Backup defensivo de staging**

Run:
```bash
source .env.local
pg_dump --format=custom "$STAGING_DB_URL" > /tmp/staging-pre-refresh-$(date +%Y%m%d).dump
ls -lh /tmp/staging-pre-refresh-*.dump
```
Expected: arquivo > 0 bytes.

- [ ] **Step 2: Dry-run final**

Run: `npm run staging:refresh:dry-run`
Expected: termina com `✅ Pipeline concluído com sucesso`. Nenhuma URL real impressa.

- [ ] **Step 3: Refresh real**

Run: `npm run staging:refresh`
Expected: termina em <15 min com `✅ Pipeline concluído com sucesso`.

Acompanhar tempo de cada passo (dump, restore, snapshot, sanitize). Se algum passar de 10 min, anotar.

- [ ] **Step 4: Sanity check**

Run: `npm run staging:sanity-check`
Expected: todos os ✅. Se `siso_estoque` tiver <100 SKUs, rodar `--only-snapshot-inicial`.

- [ ] **Step 5: Validação UI — `/siso`**

Abrir `$STAGING_APP_URL` no browser, logar como `Eryk / 1234`, ir em `/siso`.
Expected: tab "Pendentes" tem pedidos reais (não vazio).

- [ ] **Step 6: Validação UI — WMS**

Em `/wms/produtos`: catálogo populado.
Em `/wms/estoque`: ao menos 100 linhas com saldo > 0.
Em `/wms/ledger`: ao menos as movs do snapshot-inicial.

- [ ] **Step 7: Validação de isolamento Tiny**

Em `/siso`, tentar "Aprovar" um pedido de teste.
Expected: erro controlado tipo "token Tiny inválido". A chamada NÃO sai pra prod.

Conferir no painel Tiny (prod) → logs de API → confirmar zero chamadas vindas do IP da Vercel Preview no horário do teste. Se houver chamadas, **stop everything** — investigar antes de mais nada.

- [ ] **Step 8: Cenário end-to-end no WMS**

Em staging:
1. `/wms/receber` → receber 50 unidades de algum SKU X no galpão CWB
2. `/wms/transferir` → transferir 10 unidades pra SP
3. `/wms/ajuste` → ajustar -2 unidades com motivo
4. `/wms/estoque` → conferir: 38 em CWB (galpão origem), 10 em SP (destino)
5. `/wms/ledger` → conferir 4 movimentações novas (E 50 + S 10 + E 10 par + S 2)

Se qualquer passo falhar, isso é bug pré-existente do WMS (não do playground) — anotar mas não bloquear o playground.

- [ ] **Step 9: Atualizar CLAUDE.md (status do playground)**

Editar `CLAUDE.md`, na seção "In Progress / Minor", trocar a linha do WMS Plano 5 por:

```markdown
- **WMS Staging Playground — implementado, validado em 2026-05-18.** Pipeline `npm run staging:refresh` espelha dados de prod em staging (Supabase `ehbxpbeijofx…`) e popula WMS via `snapshot-inicial`. Tokens Tiny desativados pós-refresh. Spec: `docs/superpowers/specs/2026-05-11-wms-staging-playground-design.md`. Operação documentada em `docs/superpowers/plans/wms-staging-policy.md`.
```

- [ ] **Step 10: Commit final**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(wms): registra staging playground como entregue

Pipeline validado em 2026-05-18 com todos os critérios do spec §8.
- Dump+restore <15 min
- Sanity check todo verde
- /siso e /wms povoados em staging
- Isolamento Tiny confirmado (zero chamadas em prod no teste)
- Cenário receber/transferir/ajustar funciona end-to-end

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Tarefa opcional: usuário Postgres read-only pra prod

Defesa em profundidade extra. Se você quiser **garantia adicional** de que nem um bug grosseiro no script consegue escrever em prod, crie um role Postgres com permissão só de leitura e use as credenciais dele em `PROD_DB_URL`.

### Opt-Task A: Criar role read-only em prod

**Files:** N/A (operação no Supabase Dashboard)

- [ ] **Step 1: Conectar como superuser em prod via SQL Editor do Dashboard**

- [ ] **Step 2: Executar (substitua a senha)**

```sql
CREATE ROLE staging_refresh_readonly LOGIN PASSWORD '<gerar-senha-forte-e-guardar>';

-- Acesso ao schema
GRANT USAGE ON SCHEMA public TO staging_refresh_readonly;

-- Apenas SELECT nas tabelas que vamos dumpar
GRANT SELECT ON ALL TABLES IN SCHEMA public TO staging_refresh_readonly;

-- Para tabelas futuras
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO staging_refresh_readonly;

-- Verificar que NÃO tem nenhum INSERT/UPDATE/DELETE
SELECT grantee, privilege_type, count(*)
FROM information_schema.role_table_grants
WHERE grantee = 'staging_refresh_readonly'
GROUP BY 1, 2;
-- Expected: só SELECT
```

- [ ] **Step 3: Substituir `PROD_DB_URL` em `.env.local`**

```env
# Antes:
# PROD_DB_URL=postgresql://postgres:<senha-master>@db.wrbrbhuhsaaupqsimkqz.supabase.co:5432/postgres

# Depois:
PROD_DB_URL=postgresql://staging_refresh_readonly:<senha-readonly>@db.wrbrbhuhsaaupqsimkqz.supabase.co:5432/postgres
```

- [ ] **Step 4: Re-rodar refresh e confirmar que dump ainda funciona**

Run: `npm run staging:refresh`
Expected: completa normalmente. Se reclamar de permissões em alguma tabela, adicionar `GRANT SELECT` específico.

- [ ] **Step 5: Não commitar nada** — é só operacional, fora do código.

---

## Self-Review

Conferi o plano contra o spec §1-9:

**Cobertura:**
- §3.1 Arquitetura (2 ambientes, env vars Vercel) — Setup 0.2 documenta as 4 vars
- §3.2 Dois mundos em staging — Task 9 valida ambos via UI
- §3.3 Fluxo do refresh — Tasks 1-6 implementam exatamente a sequência dump→restore→snapshot→sanitize
- §4.1 `scripts/staging-refresh.ts` — Task 6
- §4.2 Tabelas no dump — Task 1 (lista + trim spec). Ajuste: webhook_logs entra inteiro no dump + trim via SQL após restore (pg_dump não tem `--where`)
- §4.3 `scripts/staging-sanity-check.ts` — Task 7
- §4.4 Variáveis de ambiente — Setup 0.2
- §4.5 Comandos no `package.json` — Task 8
- §5 Salvaguardas — todas presentes (sanity, URLs explícitas, sanitize, cleanup) + opcional read-only role (Opt-Task A)
- §6 Operação no dia a dia — documentado em `wms-staging-policy.md` na Task 8 Step 3
- §8 Critério de sucesso — Task 9 valida 1 a 1

**Placeholders:** zero. Todos os steps têm código, comando, ou critério.

**Type consistency:** revisei — `runPgDump`, `runPgRestore`, `runPsql`, `callSnapshotInicial` têm assinaturas estáveis através das tasks. `CliArgs` tem 4 campos consistentes. `validateUrls`, `parseArgs`, `buildSanitizationSql`, `buildTrimSql` exportadas e usadas com os mesmos nomes em Task 6.

**Ajuste sobre o spec:** o spec menciona `pg_dump --where` (§4.2), que não existe. Plano implementa via dump full + DELETE pós-restore — equivalente em resultado, robusto a versões.

---

## Risk Notes (não-bloqueante)

1. **`siso_ordens_compra` pode ter tabelas filhas não listadas.** Verificar em Task 9 Step 4 se o sanity check acusa estranheza. Se houver FK violation no restore, adicionar `siso_ordens_compra_itens` (ou o nome real) em TABLES_TO_DUMP e refazer.
2. **Foreign keys cross-schema.** Se alguma das tabelas tem FK pra algo fora de `public.*`, restore pode quebrar. Detectável só com a primeira execução real.
3. **Tempo de snapshot-inicial.** Spec estima ~3-5k chamadas Tiny (~5min). Se demorar mais, considerar `--only-snapshot-inicial` em refreshes subsequentes pra evitar refazer dump.
