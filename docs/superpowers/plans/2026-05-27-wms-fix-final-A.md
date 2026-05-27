# WMS Fix-Final A — Cobertura ledger (P0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os 8 itens P0 residuais da auditoria WMS 2026-05-26: re-aplicar gating `#2.15` sem quebrar NF, estornar `desfazer_encontrei`, tratar reservas em `/separacao/localizacao`, resolver loc por `separacao_galpao_id` em transferência, criar endpoints Banner D10 (`/estornar`) + D2 (`/liberar-reservas`), criar migration `siso_notas_fiscais` (R5), executar backfill R1.

**Architecture:**
- Backend Next.js App Router (`src/app/api/wms/*/route.ts`) + Supabase RPC (`wms_inserir_movimentacao`).
- TDD via suite de cenários `scripts/wms/cenarios/catalogo/NN-*.ts` — cada item ganha 1-2 cenários novos (26-32) com invariantes globais I1-I7 verdes.
- Toda escrita de saldo passa por `inserirMovimentacao` (PR-1). Toda ação destrutiva tem reverse simétrico via `criarEstorno` (PR-2). Backend valida `userCan(session, "perm.x")` (PR-4). Reuso de helpers existentes (`estornarReservaIndividual`, `resolverDisponibilidade`).
- Migration `siso_notas_fiscais` aplicada **só em staging** (`ehbxpbeijofxtsbezwxd`) via `mcp__supabase__apply_migration`.

**Tech Stack:** Next.js 16, TypeScript, Supabase (PostgREST + RPC), Tailwind 4, sonner toasts, suite vitest + tsx para cenários.

**Spec:** [`docs/superpowers/specs/2026-05-27-wms-fix-final-design.md`](../specs/2026-05-27-wms-fix-final-design.md) §2 (itens A1-A8).

**Auditoria mãe:** [`docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md`](../specs/2026-05-26-auditoria-wms-fixes-design.md).

---

## Arquivos afetados

**Criar:**
- `supabase/migrations/20260527_siso_notas_fiscais.sql`
- `supabase/migrations/20260527_perms_pedidos_estornar.sql` (opcional — perms ficam em registry TS)
- `src/app/api/wms/pedidos/[id]/estornar/route.ts`
- `src/app/api/wms/pedidos/[id]/liberar-reservas/route.ts`
- `scripts/wms/cenarios/catalogo/26-concluir-oc-aguarda-nf.ts`
- `scripts/wms/cenarios/catalogo/27-concluir-oc-nf-ja-emitida.ts`
- `scripts/wms/cenarios/catalogo/28-oc-encontrei-e-desfazer.ts`
- `scripts/wms/cenarios/catalogo/29-localizacao-com-reservas.ts`
- `scripts/wms/cenarios/catalogo/30-transferencia-marcar-item-galpao-destino.ts`
- `scripts/wms/cenarios/catalogo/31-estorno-manual-admin.ts`
- `scripts/wms/cenarios/catalogo/32-liberar-reservas-admin.ts`
- `docs/superpowers/backfill-r1-2026-05-27-staging.md`

**Modificar:**
- `src/lib/permissions.ts` — add `pedidos.estornar`, `pedidos.liberar_reservas`
- `src/lib/separacao/wms-mapping.ts` — add `resolveSeparacaoGalpao(pedido)`
- `src/app/api/wms/separacao/concluir-oc/route.ts` — re-aplicar gating split (NF check antes do cutover)
- `src/app/api/wms/separacao/validar-oc-item/route.ts` — `desfazer_encontrei` estorna mov
- `src/app/api/wms/separacao/localizacao/route.ts` — trata `reservado > 0` (libera R + reemite)
- `src/app/api/wms/separacao/marcar-item/route.ts` — usa `resolveSeparacaoGalpao`
- `src/app/api/wms/separacao/bipar-checklist/route.ts` — usa `resolveSeparacaoGalpao`
- `src/lib/wms/ledger.ts` — `inserirMovimentacao` valida `nota_fiscal_id` existe quando `origem_tipo` exige
- `src/lib/nf-webhook-handler.ts` — upsert `siso_notas_fiscais` antes de criar movs
- `src/lib/webhook-processor.ts` — popular `nota_fiscal_id` em movs de NF venda
- `src/app/wms/pedidos/[id]/page.tsx` — hookup Banner D10 + D2 override
- `scripts/wms/cenarios/catalogo/02-pedido-transferencia.ts` — remover patch SQL workaround (A4)
- `scripts/wms/cenarios/catalogo/03-pedido-oc-completo.ts` — remover patch SQL workaround (A4)
- `erros-conhecidos.yaml` — 8 entradas novas
- `docs/api-reference-complete.md` — 2 endpoints novos
- `docs/database-schema.md` — tabela `siso_notas_fiscais`
- `CLAUDE.md` — seção "Recently Fixed" (Fix-Final A)

---

## Phase 1 — Setup + baseline

### Task 1: Medir baseline (divergências + suite verde)

**Files:** none (somente leitura/registro)

- [ ] **Step 1: Confirmar suite atual está verde**

Run: `npm run scenarios -- --only=01`
Expected: 1/1 PASS, I1-I7 verde.

- [ ] **Step 2: Rodar suite completa e registrar baseline**

Run: `npm run scenarios`
Expected: 25/25 PASS.

- [ ] **Step 3: Capturar baseline de divergências em staging**

Via Bash + curl ou direto via MCP Supabase:

```bash
# Via MCP (preferido em staging):
# mcp__supabase__execute_sql(project_id="ehbxpbeijofxtsbezwxd",
#   query="SELECT COUNT(*) FROM wms_detectar_divergencias_estoque()")
```

Anotar resultado em `docs/superpowers/backfill-r1-2026-05-27-staging.md` (criar arquivo):

```markdown
# Backfill R1 — execução em staging

**Data:** 2026-05-27
**Project:** ehbxpbeijofxtsbezwxd (staging)

## Baselines pré-fix-final

- Cenários: 25/25 PASS
- Divergências (`wms_detectar_divergencias_estoque()`): N rows
- Movs com `nota_fiscal_id IS NULL` quando `origem_tipo IN ('nf_compra','nf_venda','devolucao_*')`: N rows
- OCs com `compras_status='recebida'` sem mov `nf_compra` correspondente: N rows
```

- [ ] **Step 4: Commit baseline doc**

```bash
git add docs/superpowers/backfill-r1-2026-05-27-staging.md
git commit -m "docs(fix-final-a): baseline pré-execução (T1)"
```

---

### Task 2: Criar branch + worktree

- [ ] **Step 1: Criar worktree isolada via skill `using-git-worktrees`**

Branch: `wms-fix-final-a`. Path: `.claude/worktrees/wms-fix-final-a/`.

```bash
git worktree add -b wms-fix-final-a .claude/worktrees/wms-fix-final-a/ develop
```

- [ ] **Step 2: `cd` pra worktree e validar**

```bash
cd .claude/worktrees/wms-fix-final-a
git status
# Expected: On branch wms-fix-final-a, nothing to commit, working tree clean
```

---

## Phase 2 — Perms + helper foundation

### Task 3: Adicionar perms `pedidos.estornar` + `pedidos.liberar_reservas`

**Files:**
- Modify: `src/lib/permissions.ts` (registry + role `admin`)
- Modify: `CLAUDE.md` (seção "Roles & Permissões")

- [ ] **Step 1: Ler registry atual**

Read: `src/lib/permissions.ts`. Identificar bloco `PERMISSIONS = { ... }` e mapas de roles padrão (especialmente `admin`).

- [ ] **Step 2: Adicionar 2 perms ao registry**

Edit `src/lib/permissions.ts`, dentro de `PERMISSIONS`:

```ts
"pedidos.estornar":         { modulo: "vendas",        label: "Estornar pedido (Banner D10 admin)" },
"pedidos.liberar_reservas": { modulo: "vendas",        label: "Liberar reservas do pedido (D2 override admin)" },
```

Localizar role `admin` (deve ter spread `...PERMISSAO_CODIGOS`); confirmar que captura as 2 novas automaticamente. Se for lista hardcoded, adicionar as 2.

- [ ] **Step 3: Adicionar entradas no CLAUDE.md**

Edit `CLAUDE.md` na seção "### Roles & Permissões" — adicionar bullet:

```markdown
- 2 novas perms (Fix-Final A): `pedidos.estornar` + `pedidos.liberar_reservas` — só role `admin`.
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/permissions.ts CLAUDE.md
git commit -m "feat(perms): pedidos.estornar + pedidos.liberar_reservas (fix-final-A T3)"
```

---

### Task 4: Helper `resolveSeparacaoGalpao(pedido)` em `wms-mapping.ts`

**Files:**
- Modify: `src/lib/separacao/wms-mapping.ts`
- Test: `src/lib/separacao/wms-mapping.test.ts` (se ainda não existe, criar)

- [ ] **Step 1: Ler `wms-mapping.ts` atual**

Read `src/lib/separacao/wms-mapping.ts` pra entender padrões existentes e tipos de `pedido`.

- [ ] **Step 2: Escrever teste failing**

Edit `src/lib/separacao/wms-mapping.test.ts` (ou criar):

```ts
import { describe, it, expect } from "vitest";
import { resolveSeparacaoGalpao } from "./wms-mapping";

describe("resolveSeparacaoGalpao", () => {
  it("retorna separacao_galpao_id quando presente (fluxo transferência)", () => {
    const pedido = {
      empresa_origem_id: "emp-cwb-uuid",
      separacao_galpao_id: "gal-sp-uuid",
      sugestao: "transferencia",
    };
    expect(resolveSeparacaoGalpao(pedido as any)).toBe("gal-sp-uuid");
  });

  it("fallback pro galpão da empresa_origem quando separacao_galpao_id é NULL (própria)", () => {
    const pedido = {
      empresa_origem_id: "emp-cwb-uuid",
      separacao_galpao_id: null,
      sugestao: "propria",
      empresa_origem_galpao_id: "gal-cwb-uuid",  // resolvido upstream
    };
    expect(resolveSeparacaoGalpao(pedido as any)).toBe("gal-cwb-uuid");
  });

  it("lança erro quando ambos NULL", () => {
    const pedido = { empresa_origem_id: null, separacao_galpao_id: null };
    expect(() => resolveSeparacaoGalpao(pedido as any)).toThrow(/sem galpão resolvível/i);
  });
});
```

- [ ] **Step 3: Rodar teste — esperado FAIL**

```bash
npx vitest run src/lib/separacao/wms-mapping.test.ts
```
Expected: 3 failures (`resolveSeparacaoGalpao is not a function`).

- [ ] **Step 4: Implementar `resolveSeparacaoGalpao`**

Adicionar em `src/lib/separacao/wms-mapping.ts`:

```ts
type PedidoLike = {
  separacao_galpao_id?: string | null;
  empresa_origem_galpao_id?: string | null;
};

export function resolveSeparacaoGalpao(pedido: PedidoLike): string {
  if (pedido.separacao_galpao_id) return pedido.separacao_galpao_id;
  if (pedido.empresa_origem_galpao_id) return pedido.empresa_origem_galpao_id;
  throw new Error("resolveSeparacaoGalpao: pedido sem galpão resolvível (separacao_galpao_id e empresa_origem_galpao_id ambos null)");
}
```

- [ ] **Step 5: Rodar testes — esperado PASS**

```bash
npx vitest run src/lib/separacao/wms-mapping.test.ts
```
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/separacao/wms-mapping.ts src/lib/separacao/wms-mapping.test.ts
git commit -m "feat(separacao): resolveSeparacaoGalpao helper (fix-final-A T4 / #A4)"
```

---

## Phase 3 — A7: Migration `siso_notas_fiscais` (R5)

### Task 5: Criar migration `siso_notas_fiscais`

**Files:**
- Create: `supabase/migrations/20260527_siso_notas_fiscais.sql`

- [ ] **Step 1: Inspecionar uso atual de `nota_fiscal_id` em `siso_movimentacoes`**

```bash
grep -rn "nota_fiscal_id" src/ supabase/ | head -30
```

Confirmar coluna existe em `siso_movimentacoes` como UUID nullable (deve, ver `src/lib/wms/ledger.ts:85`).

- [ ] **Step 2: Escrever migration**

Create `supabase/migrations/20260527_siso_notas_fiscais.sql`:

```sql
-- Fix-Final A T5: Tabela siso_notas_fiscais (R5)
-- Resolve: devoluções e vendas/compras não tinham tabela canônica de NF;
--          siso_movimentacoes.nota_fiscal_id ficava NULL ou referenciava
--          bigint do Tiny via origem_detalhes.

BEGIN;

CREATE TABLE IF NOT EXISTS siso_notas_fiscais (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tiny_nota_fiscal_id  bigint  NULL,
  chave_acesso    text        UNIQUE,
  numero          text        NULL,
  serie           text        NULL,
  empresa_id      uuid        NULL REFERENCES siso_empresas(id) ON DELETE SET NULL,
  tipo            text        NOT NULL CHECK (tipo IN ('entrada','saida')),
  criada_em       timestamptz NOT NULL DEFAULT now(),
  raw_tiny        jsonb       NULL
);

CREATE INDEX IF NOT EXISTS ix_siso_notas_fiscais_tiny_id   ON siso_notas_fiscais(tiny_nota_fiscal_id) WHERE tiny_nota_fiscal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_siso_notas_fiscais_empresa   ON siso_notas_fiscais(empresa_id);
CREATE INDEX IF NOT EXISTS ix_siso_notas_fiscais_criada_em ON siso_notas_fiscais(criada_em DESC);

-- FK nullable em siso_movimentacoes.nota_fiscal_id (a coluna já existe como UUID)
DO $$ BEGIN
  ALTER TABLE siso_movimentacoes
    ADD CONSTRAINT siso_movimentacoes_nota_fiscal_id_fkey
    FOREIGN KEY (nota_fiscal_id) REFERENCES siso_notas_fiscais(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Realtime publication (cobertura PR-3)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE siso_notas_fiscais;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
```

- [ ] **Step 3: Aplicar via MCP no staging**

```
mcp__supabase__apply_migration(
  project_id="ehbxpbeijofxtsbezwxd",
  name="20260527_siso_notas_fiscais",
  query="<SQL acima>"
)
```

Validar:
```
mcp__supabase__execute_sql(
  project_id="ehbxpbeijofxtsbezwxd",
  query="SELECT to_regclass('siso_notas_fiscais') AS exists, (SELECT COUNT(*) FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='siso_notas_fiscais') AS in_realtime"
)
```
Expected: `exists=siso_notas_fiscais`, `in_realtime=1`.

- [ ] **Step 4: Atualizar `docs/database-schema.md`**

Adicionar seção descrevendo a tabela (formato igual às existentes — id, colunas, FKs, índices).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260527_siso_notas_fiscais.sql docs/database-schema.md
git commit -m "feat(db): siso_notas_fiscais table + realtime (fix-final-A T5 / R5)"
```

---

### Task 6: Upsert NF de entrada no `nf-webhook-handler.ts`

**Files:**
- Modify: `src/lib/nf-webhook-handler.ts`

- [ ] **Step 1: Ler `nf-webhook-handler.ts` atual**

Identificar onde a NF entra (provavelmente em handler de `nota_fiscal` webhook).

- [ ] **Step 2: Adicionar helper `upsertNotaFiscal`**

Add ao arquivo (perto do topo, após imports):

```ts
type NfPayload = {
  tiny_nota_fiscal_id?: number | string;
  chave_acesso?: string | null;
  numero?: string | null;
  serie?: string | null;
  empresa_id?: string | null;
  tipo: "entrada" | "saida";
  raw?: unknown;
};

export async function upsertNotaFiscal(input: NfPayload): Promise<string> {
  const sb = createServiceClient();
  const chave = input.chave_acesso?.trim() || null;
  if (chave) {
    const { data: existing } = await sb
      .from("siso_notas_fiscais")
      .select("id")
      .eq("chave_acesso", chave)
      .maybeSingle();
    if (existing) return existing.id;
  }
  const { data, error } = await sb
    .from("siso_notas_fiscais")
    .insert({
      tiny_nota_fiscal_id: input.tiny_nota_fiscal_id ? Number(input.tiny_nota_fiscal_id) : null,
      chave_acesso: chave,
      numero: input.numero ?? null,
      serie: input.serie ?? null,
      empresa_id: input.empresa_id ?? null,
      tipo: input.tipo,
      raw_tiny: input.raw ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`upsertNotaFiscal falhou: ${error.message}`);
  return data.id;
}
```

- [ ] **Step 3: Chamar `upsertNotaFiscal` antes do primeiro `inserirMovimentacao` no handler**

No fluxo de devolução (handler que classifica A/B/C/D), antes de chamar `inserirMovimentacao`, pegar o `nota_fiscal_id` via upsert:

```ts
const nfId = await upsertNotaFiscal({
  tiny_nota_fiscal_id: nf.id,
  chave_acesso: nf.chaveAcesso,
  numero: nf.numero,
  serie: nf.serie,
  empresa_id: empresa.id,
  tipo: "entrada",
  raw: nf,
});
// ... e passar nfId em todas as movs:
await inserirMovimentacao({ ..., nota_fiscal_id: nfId });
```

- [ ] **Step 4: Smoke manual em staging**

Disparar webhook simulado de devolução (via Tiny ou via cenário 10). Confirmar via SQL que mov tem `nota_fiscal_id` populado e que aparece em `siso_notas_fiscais`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nf-webhook-handler.ts
git commit -m "feat(nf-webhook): upsert siso_notas_fiscais antes de movs (fix-final-A T6 / R5)"
```

---

### Task 7: Upsert NF de saída no `webhook-processor.ts` (NF venda)

**Files:**
- Modify: `src/lib/webhook-processor.ts` (ou onde NF venda gera movs S)

- [ ] **Step 1: Localizar handler de NF venda**

```bash
grep -rn "origem_tipo.*nf_venda\|inserirMovimentacao.*nf_venda" src/
```

- [ ] **Step 2: Chamar `upsertNotaFiscal` com `tipo: 'saida'` e popular `nota_fiscal_id`**

Mesmo padrão da Task 6, mas com `tipo: "saida"`.

- [ ] **Step 3: Smoke manual: aprovar 1 pedido completo (cenário 01) e validar SQL:**

```sql
SELECT COUNT(*) FROM siso_movimentacoes
WHERE origem_tipo = 'nf_venda'
  AND nota_fiscal_id IS NULL
  AND criado_em >= now() - interval '1 hour';
```
Expected: 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/webhook-processor.ts
git commit -m "feat(webhook): upsert NF saída + popula nota_fiscal_id (fix-final-A T7 / R5)"
```

---

### Task 8: `inserirMovimentacao` valida `nota_fiscal_id` quando `origem_tipo` exige

**Files:**
- Modify: `src/lib/wms/ledger.ts`
- Test: `src/lib/wms/ledger.test.ts`

- [ ] **Step 1: Escrever teste failing**

Edit `src/lib/wms/ledger.test.ts` — adicionar:

```ts
describe("nota_fiscal_id required for NF-derived origens", () => {
  it("rejeita nf_compra sem nota_fiscal_id", async () => {
    await expect(inserirMovimentacao({
      tipo: "E",
      origem_tipo: "nf_compra",
      origem_id: "00000000-0000-0000-0000-000000000001",
      produto_id: "...", galpao_id: "...", localizacao_id: "...",
      qty: 10,
      nota_fiscal_id: null,
    } as any)).rejects.toThrow(/nota_fiscal_id obrigatório/i);
  });

  it("aceita ajuste_manual sem nota_fiscal_id", async () => {
    // não deve lançar (use mock se inserirMovimentacao chama supabase real)
  });
});
```

- [ ] **Step 2: Rodar teste — FAIL esperado**

```bash
npx vitest run src/lib/wms/ledger.test.ts -t "nota_fiscal_id"
```

- [ ] **Step 3: Implementar validação**

Em `src/lib/wms/ledger.ts`, dentro de `inserirMovimentacao`, antes do RPC call:

```ts
const NF_REQUIRED = new Set([
  "nf_compra", "nf_venda",
  "devolucao_cliente_integra", "devolucao_cliente_avariada",
  "devolucao_fornecedor_recebida", "devolucao_fornecedor_enviada",
]);

if (NF_REQUIRED.has(input.origem_tipo) && !input.nota_fiscal_id) {
  throw new Error(`inserirMovimentacao: nota_fiscal_id obrigatório quando origem_tipo='${input.origem_tipo}'`);
}
```

- [ ] **Step 4: Rodar teste — PASS**

- [ ] **Step 5: Rodar cenários — confirma que nenhum quebra**

```bash
npm run scenarios
```
Expected: 25/25 PASS. Se algum cenário falhar (ex: 10/11 de devolução), é porque T6 não está populando `nota_fiscal_id` corretamente — voltar e corrigir antes de commitar.

- [ ] **Step 6: Commit**

```bash
git add src/lib/wms/ledger.ts src/lib/wms/ledger.test.ts
git commit -m "feat(ledger): exige nota_fiscal_id quando origem_tipo é NF (fix-final-A T8 / R5)"
```

---

### Task 9: Backfill retroativo de NFs históricas

**Files:**
- Create: `scripts/wms/backfill-notas-fiscais.ts`

- [ ] **Step 1: Escrever script de backfill (dry-run por default)**

Create `scripts/wms/backfill-notas-fiscais.ts`:

```ts
/**
 * Backfill retroativo de siso_notas_fiscais a partir de:
 * - siso_movimentacoes.origem_detalhes JSONB (chave_acesso, numero, serie)
 * - siso_devolucoes_pendentes.chave_acesso_nf
 *
 * Rodar: npx tsx scripts/wms/backfill-notas-fiscais.ts [--apply]
 * Default = dry-run (só conta, não escreve).
 */
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const apply = process.argv.includes("--apply");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log(apply ? "🚀 APPLY mode" : "🔍 DRY-RUN mode (use --apply pra gravar)");
  // 1. Movs com chave_acesso em origem_detalhes mas sem nota_fiscal_id
  const { data: movs, error } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_tipo, origem_detalhes, criado_em")
    .is("nota_fiscal_id", null)
    .in("origem_tipo", ["nf_compra","nf_venda","devolucao_cliente_integra","devolucao_cliente_avariada","devolucao_fornecedor_recebida","devolucao_fornecedor_enviada"])
    .limit(5000);
  if (error) throw error;
  console.log(`📊 Movs candidatas: ${movs?.length ?? 0}`);

  let created = 0, linked = 0, skipped = 0;
  for (const mov of movs ?? []) {
    const detalhes: any = mov.origem_detalhes ?? {};
    const chave = detalhes.chave_acesso ?? detalhes.chaveAcesso ?? null;
    if (!chave) { skipped++; continue; }

    if (!apply) { linked++; continue; }

    // upsert NF
    const tipo = mov.origem_tipo.startsWith("nf_compra") || mov.origem_tipo.startsWith("devolucao_fornecedor") ? "entrada" : "saida";
    const { data: existing } = await sb.from("siso_notas_fiscais").select("id").eq("chave_acesso", chave).maybeSingle();
    let nfId = existing?.id;
    if (!nfId) {
      const { data: ins } = await sb.from("siso_notas_fiscais").insert({
        chave_acesso: chave,
        numero: detalhes.numero ?? null,
        serie: detalhes.serie ?? null,
        tipo,
        raw_tiny: detalhes,
      }).select("id").single();
      nfId = ins?.id;
      created++;
    }
    await sb.from("siso_movimentacoes").update({ nota_fiscal_id: nfId }).eq("id", mov.id);
    linked++;
  }

  console.log(`✅ Backfill done. created=${created} linked=${linked} skipped=${skipped}`);
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Dry-run em staging**

```bash
npx tsx scripts/wms/backfill-notas-fiscais.ts
```

Anotar resultado em `docs/superpowers/backfill-r1-2026-05-27-staging.md` seção "Backfill NF (T9)":
```
created=N, linked=N, skipped=N
```

- [ ] **Step 3: Apply em staging**

```bash
npx tsx scripts/wms/backfill-notas-fiscais.ts --apply
```

Anotar resultado.

- [ ] **Step 4: Verificar via SQL**

```sql
SELECT origem_tipo, COUNT(*) AS total, COUNT(nota_fiscal_id) AS com_nf
FROM siso_movimentacoes
WHERE origem_tipo IN ('nf_compra','nf_venda','devolucao_cliente_integra','devolucao_cliente_avariada','devolucao_fornecedor_recebida','devolucao_fornecedor_enviada')
GROUP BY origem_tipo;
```

Expected: ratio `com_nf / total` próximo de 1 (movs muito antigas sem `chave_acesso` em `origem_detalhes` ficam NULL — aceitável).

- [ ] **Step 5: Commit**

```bash
git add scripts/wms/backfill-notas-fiscais.ts docs/superpowers/backfill-r1-2026-05-27-staging.md
git commit -m "chore(backfill): backfill retroativo siso_notas_fiscais executado em staging (fix-final-A T9 / R5)"
```

---

### Task 10: Smoke A7 — invariante NF completa

**Files:** none (validation only)

- [ ] **Step 1: Rodar cenário 01 (pedido próprio simples) e validar movs novas têm `nota_fiscal_id`**

```bash
npm run scenarios -- --only=01
```

Depois SQL:
```sql
SELECT COUNT(*) FROM siso_movimentacoes
WHERE origem_tipo IN ('nf_venda') AND criado_em > now() - interval '5 min' AND nota_fiscal_id IS NULL;
```
Expected: 0.

- [ ] **Step 2: Rodar cenários 10 + 11 (devoluções)**

```bash
npm run scenarios -- --only=10,11
```

SQL análogo pra `devolucao_*`. Expected: 0.

- [ ] **Step 3: Anotar em backfill doc seção "Smoke A7"**

```markdown
## Smoke A7 (T10)
- Cenário 01: movs com nota_fiscal_id NULL = 0 ✅
- Cenário 10: movs devolucao com nota_fiscal_id NULL = 0 ✅
- Cenário 11: movs devolucao com nota_fiscal_id NULL = 0 ✅
```

- [ ] **Step 4: Commit doc atualizado**

```bash
git add docs/superpowers/backfill-r1-2026-05-27-staging.md
git commit -m "docs(fix-final-a): smoke A7 OK em staging (T10)"
```

---

## Phase 4 — A1: Re-aplicar gating em `/concluir-oc`

### Task 11: Cenário 26 — concluir-oc aguarda NF

**Files:**
- Create: `scripts/wms/cenarios/catalogo/26-concluir-oc-aguarda-nf.ts`

- [ ] **Step 1: Copiar template de cenário existente (03 ou 25) como base**

```bash
cp scripts/wms/cenarios/catalogo/03-pedido-oc-completo.ts \
   scripts/wms/cenarios/catalogo/26-concluir-oc-aguarda-nf.ts
```

- [ ] **Step 2: Adaptar pra exercitar: NF NÃO emitida → concluir-oc → status='aguardando_nf' → zero movs S**

Editar o cenário pra:
1. Criar pedido OC.
2. Receber OC inteira (compras/receber).
3. Bipar embalagem completa.
4. Chamar `POST /api/wms/separacao/concluir-oc` com `pedido.nota_fiscal_id === null` (não simular NF).
5. Asserts:
   - `pedido.status_separacao === 'aguardando_nf'`
   - Zero movs novas em `siso_movimentacoes` com `origem_tipo='nf_venda'` pro pedido.
   - I1-I7 verde (invariantes globais).
6. Simular NF chegando (POST webhook NF de saída).
7. Asserts pós-NF:
   - Cutover dispara, movs S aparecem.
   - `pedido.status_separacao === 'embalado'` (ou `expedido` se webhook NF transita).

- [ ] **Step 3: Rodar cenário standalone — esperado FAIL (gating ainda não existe)**

Terminal 1: `PORT=3001 npm run dev`
Terminal 2: `npx tsx scripts/wms/cenarios/catalogo/26-concluir-oc-aguarda-nf.ts`

Expected: FAIL — concluir-oc gera movs mesmo sem NF (porque gating foi revertido em `c349ead`).

- [ ] **Step 4: Não commitar ainda — vai junto com a fix em T13**

---

### Task 12: Cenário 27 — concluir-oc com NF já emitida

**Files:**
- Create: `scripts/wms/cenarios/catalogo/27-concluir-oc-nf-ja-emitida.ts`

- [ ] **Step 1: Copiar base + adaptar**

Sequência inversa de T11:
1. Pedido OC.
2. Receber OC.
3. Bipar embalagem.
4. Simular NF de saída CHEGAR ANTES de concluir-oc (POST webhook NF).
5. `POST /api/wms/separacao/concluir-oc`.
6. Asserts:
   - Movs S criadas imediatamente.
   - `pedido.status_separacao === 'embalado'` (ou similar).
   - I1-I7 verde.
   - **Zero enqueue legacy** em `siso_fila_execucao` (gating skip funcional).

- [ ] **Step 2: Rodar standalone — esperado FAIL ou PASS dependendo do estado atual**

Esperado: PASS (porque sem o revert, esse era o caminho default). Se FAIL, há bug ortogonal a documentar.

- [ ] **Step 3: Não commitar ainda**

---

### Task 13: Implementar gating split em `/concluir-oc`

**Files:**
- Modify: `src/app/api/wms/separacao/concluir-oc/route.ts`

- [ ] **Step 1: Ler `concluir-oc/route.ts` atual + commit `c349ead` (revert) + commit `e020567` (versão revertida)**

```bash
git show c349ead
git show e020567
```

Entender por que o gating original quebrava NF. Geralmente: tentava transitar `aguardando_nf` mas algum check downstream esperava `embalado`.

- [ ] **Step 2: Implementar gating SPLIT (skip legacy + check NF antes do cutover)**

Edit `src/app/api/wms/separacao/concluir-oc/route.ts`:

```ts
// 1. Skip enqueue legacy quando WMS_AS_SOURCE (já está em e020567, manter)
if (!isWmsAsSource()) {
  await enqueueLancarEstoqueLegacy(pedido.id);
}

// 2. Cutover do ledger SÓ se NF já presente
const nfPresente = pedido.nota_fiscal_id !== null;
if (nfPresente) {
  await fazerCutoverWms(pedido); // gera movs S+L
  await sb.from("siso_pedidos").update({ status_separacao: "embalado" }).eq("id", pedido.id);
} else {
  // NF ainda não chegou: aguarda webhook NF disparar cutover via nf-webhook-handler
  await sb.from("siso_pedidos").update({ status_separacao: "aguardando_nf" }).eq("id", pedido.id);
}
```

Garantir que `nf-webhook-handler` quando recebe NF de saída chama `fazerCutoverWms(pedido)` se `pedido.status_separacao === 'aguardando_nf'`. Se já chama (mesmo caminho do `aguardando_separacao`), reuso. Senão, adicionar a branch.

- [ ] **Step 3: Rodar cenário 26 + 27 standalone — esperado PASS**

```bash
npx tsx scripts/wms/cenarios/catalogo/26-concluir-oc-aguarda-nf.ts
npx tsx scripts/wms/cenarios/catalogo/27-concluir-oc-nf-ja-emitida.ts
```

- [ ] **Step 4: Rodar suite completa pra garantir zero regressão**

```bash
npm run scenarios
```
Expected: 27/27 PASS (25 originais + 26 + 27).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/concluir-oc/route.ts \
        src/lib/nf-webhook-handler.ts \
        scripts/wms/cenarios/catalogo/26-concluir-oc-aguarda-nf.ts \
        scripts/wms/cenarios/catalogo/27-concluir-oc-nf-ja-emitida.ts
git commit -m "fix(separacao): re-aplica gating concluir-oc com split NF (fix-final-A T13 / #2.15)"
```

---

## Phase 5 — A2: `desfazer_encontrei` estorna mov

### Task 14: Cenário 28 — OC encontrei e desfazer

**Files:**
- Create: `scripts/wms/cenarios/catalogo/28-oc-encontrei-e-desfazer.ts`

- [ ] **Step 1: Copiar base (03) e adaptar**

Sequência:
1. Pedido OC.
2. `POST /api/wms/separacao/validar-oc-item` com `action='encontrei'` (gera mov S).
3. Capturar saldo após encontrei.
4. `POST /api/wms/separacao/validar-oc-item` com `action='desfazer_encontrei'`.
5. Asserts:
   - Mov de estorno (par S) existe em `siso_movimentacoes`.
   - `siso_pedido_itens.mov_saida_id IS NULL`.
   - `siso_pedido_itens.quantidade_pega = 0` (ou NULL).
   - Saldo voltou ao estado inicial.
   - I1-I7 verde.

- [ ] **Step 2: Rodar standalone — esperado FAIL**

Expected: saldo NÃO volta (TODO documentado em `validar-oc-item/route.ts:188`).

---

### Task 15: Implementar `desfazer_encontrei` estorno

**Files:**
- Modify: `src/app/api/wms/separacao/validar-oc-item/route.ts`

- [ ] **Step 1: Localizar branch `desfazer_encontrei`**

```bash
grep -n "desfazer_encontrei\|TODO.*#2.6" src/app/api/wms/separacao/validar-oc-item/route.ts
```

- [ ] **Step 2: Implementar estorno + reset campos**

Substituir a branch existente:

```ts
case "desfazer_encontrei": {
  if (!item.mov_saida_id) {
    return NextResponse.json({ error: "item sem mov_saida_id; nada pra desfazer" }, { status: 400 });
  }
  await criarEstorno({ mov_id: item.mov_saida_id, motivo: "desfazer_encontrei OC" });
  await sb.from("siso_pedido_itens").update({
    mov_saida_id: null,
    quantidade_pega: 0,
    separacao_parcial: false,
    parcial_motivo: null,
  }).eq("id", item.id);
  await registrarEvento(pedido_id, "desfazer_encontrei_oc", { item_id: item.id, mov_estornada: item.mov_saida_id });
  return NextResponse.json({ ok: true });
}
```

Remover o `TODO(#2.6-followup)` comment (linha 188).

- [ ] **Step 3: Rodar cenário 28 standalone — esperado PASS**

- [ ] **Step 4: Rodar suite — esperado 28/28 PASS**

```bash
npm run scenarios
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/validar-oc-item/route.ts \
        scripts/wms/cenarios/catalogo/28-oc-encontrei-e-desfazer.ts
git commit -m "fix(separacao): desfazer_encontrei estorna mov + limpa campos (fix-final-A T15 / #2.6)"
```

---

## Phase 6 — A3: `/separacao/localizacao` com reservado > 0

### Task 16: Cenário 29 — localização com reservas

**Files:**
- Create: `scripts/wms/cenarios/catalogo/29-localizacao-com-reservas.ts`

- [ ] **Step 1: Copiar base (qualquer cenário com reserva, ex: 18) e adaptar**

Sequência:
1. Receber estoque numa loc (R=0 inicial).
2. Criar pedido → reserva R automática na loc.
3. Confirmar `siso_estoque.reservado > 0` na loc origem.
4. `POST /api/wms/separacao/localizacao { item_id, nova_loc_id }` (mover saldo pra outra loc).
5. Asserts:
   - Par S (loc origem → loc destino) gerado.
   - R reemergida na loc destino (mesmo `ttl_horas`).
   - `siso_estoque.reservado` na loc origem voltou pra 0.
   - `siso_estoque.reservado` na loc destino = R esperada.
   - I1-I7 verde.

- [ ] **Step 2: Rodar standalone — esperado FAIL**

Expected: endpoint atual loga warning + não consegue mover (catch absorve falha de `validarCoerencia`).

---

### Task 17: Implementar `liberar Rs + mover + reemitir` em `/separacao/localizacao`

**Files:**
- Modify: `src/app/api/wms/separacao/localizacao/route.ts`

- [ ] **Step 1: Refatorar handler**

Substituir o catch silencioso + TODO por fluxo transacional:

```ts
// 1. Detecta Rs ativas na loc origem do item
const rsAtivas = await sb.from("siso_movimentacoes")
  .select("id, qty, expira_em")
  .eq("tipo", "R")
  .eq("produto_id", item.produto_id)
  .eq("galpao_id", item.galpao_id)
  .eq("localizacao_id", item.localizacao_id_origem)
  .is("estorno_de", null) // não-estornadas
  .gt("expira_em", new Date().toISOString());

// 2. Libera cada R
const rsEstornadas: { qty: number; expira_em: string }[] = [];
for (const r of rsAtivas.data ?? []) {
  await estornarReservaIndividual(r.id, "localizacao_move");
  rsEstornadas.push({ qty: r.qty, expira_em: r.expira_em });
}

// 3. Move saldo (par S+E na loc destino)
await inserirMovimentacao({ tipo: "S", origem_tipo: "transferencia_localizacao", ... });
await inserirMovimentacao({ tipo: "E", origem_tipo: "transferencia_localizacao", ... });

// 4. Re-emite Rs no destino preservando TTL
for (const r of rsEstornadas) {
  const ttlHoras = Math.max(1, Math.ceil((new Date(r.expira_em).getTime() - Date.now()) / 3600000));
  await sb.rpc("wms_reservar_atomico", { p_produto_id, p_galpao_id, p_localizacao_id: nova_loc_id, p_qty: r.qty, p_ttl_horas: ttlHoras, p_origem_id: pedido_id });
}
```

Manter ordem: liberar Rs ANTES da S (senão `validarCoerencia` falha como TODO descreve). Remover comentário `TODO(#2.7-followup)`.

- [ ] **Step 2: Rodar cenário 29 standalone — esperado PASS**

- [ ] **Step 3: Rodar suite — 29/29 PASS**

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/separacao/localizacao/route.ts \
        scripts/wms/cenarios/catalogo/29-localizacao-com-reservas.ts
git commit -m "fix(separacao): localizacao trata reservado>0 (libera+move+reemite) (fix-final-A T17 / #2.7)"
```

---

## Phase 7 — A4: `resolveSeparacaoGalpao` em transferência

### Task 18: Cenário 30 — transferência marcar-item galpão destino

**Files:**
- Create: `scripts/wms/cenarios/catalogo/30-transferencia-marcar-item-galpao-destino.ts`

- [ ] **Step 1: Criar cenário explícito**

Sequência:
1. Empresa NetAir (origem) tem produto X em CWB com saldo 0.
2. Empresa NetParts (SP) tem produto X em SP com saldo 10.
3. Pedido chega em NetAir, sugestão = `transferencia` (separa em SP, dona NetAir).
4. Aprovar → `pedido.separacao_galpao_id = SP_uuid`, `empresa_origem_id = NetAir_uuid`.
5. `POST /api/wms/separacao/marcar-item { item_id, loc_id }` — passa loc DE SP, não CWB.
6. Asserts:
   - Mov S criada em SP (não CWB).
   - `siso_estoque` em SP zerou (não CWB).
   - `siso_pedido_item_estoques.localizacao` aponta loc real de SP (sem patch SQL).
   - I1-I7 verde.

- [ ] **Step 2: Rodar standalone — esperado FAIL hoje**

Expected: endpoint resolve via `empresa_origem_id` (CWB) → mov criada na loc errada ou erro `loc não encontrada`.

---

### Task 19: Refatorar `marcar-item` + `bipar-checklist` pra usar `resolveSeparacaoGalpao`

**Files:**
- Modify: `src/app/api/wms/separacao/marcar-item/route.ts`
- Modify: `src/app/api/wms/separacao/bipar-checklist/route.ts`
- Modify: `src/app/api/wms/separacao/validar-oc-item/route.ts` (branch encontrei)

- [ ] **Step 1: Substituir resolução de galpão**

Em todos os 3 arquivos, onde aparece algo como:
```ts
const galpao = pedido.empresa_origem_galpao_id; // ou similar
```
Trocar por:
```ts
import { resolveSeparacaoGalpao } from "@/lib/separacao/wms-mapping";
const galpao = resolveSeparacaoGalpao(pedido);
```

- [ ] **Step 2: Rodar cenário 30 + suite — esperado 30/30 PASS**

- [ ] **Step 3: Commit (sem refatorar 02/03 ainda)**

```bash
git add src/app/api/wms/separacao/marcar-item/route.ts \
        src/app/api/wms/separacao/bipar-checklist/route.ts \
        src/app/api/wms/separacao/validar-oc-item/route.ts \
        scripts/wms/cenarios/catalogo/30-transferencia-marcar-item-galpao-destino.ts
git commit -m "fix(separacao): marcar-item/bipar-checklist usa separacao_galpao_id (fix-final-A T19 / #A4)"
```

---

### Task 20: Remover patches SQL workaround dos cenários 02 e 03

**Files:**
- Modify: `scripts/wms/cenarios/catalogo/02-pedido-transferencia.ts`
- Modify: `scripts/wms/cenarios/catalogo/03-pedido-oc-completo.ts`

- [ ] **Step 1: Localizar patches SQL workaround**

```bash
grep -n "UPDATE siso_pedido_item_estoques\|patch.*localizacao" \
  scripts/wms/cenarios/catalogo/02-pedido-transferencia.ts \
  scripts/wms/cenarios/catalogo/03-pedido-oc-completo.ts
```

- [ ] **Step 2: Remover patches + rodar cenários**

Deletar as linhas de UPDATE/RPC que patcham `siso_pedido_item_estoques.localizacao`. Adicionar comment `// patch SQL removido em fix-final-A T20 — endpoint resolve correto agora`.

- [ ] **Step 3: Rodar suite — 30/30 PASS sem patches**

```bash
npm run scenarios
```
Expected: 02 e 03 continuam verdes sem os patches.

- [ ] **Step 4: Commit**

```bash
git add scripts/wms/cenarios/catalogo/02-pedido-transferencia.ts \
        scripts/wms/cenarios/catalogo/03-pedido-oc-completo.ts
git commit -m "test(cenarios): remove patches SQL workaround 02/03 (fix-final-A T20 / #A4)"
```

---

## Phase 8 — A5: Endpoint `POST /api/wms/pedidos/[id]/estornar`

### Task 21: Cenário 31 — estorno manual admin

**Files:**
- Create: `scripts/wms/cenarios/catalogo/31-estorno-manual-admin.ts`

- [ ] **Step 1: Criar cenário**

Sequência:
1. Pedido completo aprovado e concluído (status=`embalado`, movs S em ledger).
2. Capturar saldo + qty Rs ativas.
3. Logar como admin (test-runner já é admin).
4. `POST /api/wms/pedidos/[id]/estornar { motivo: "teste estorno manual" }`.
5. Asserts:
   - Cada mov S do pedido tem par E (estorno).
   - Rs ativas: 0.
   - `pedido.status_separacao = 'cancelado_manual'` (ou `cancelado` + tag).
   - Saldo voltou ao estado pré-aprovação.
   - Evento `estorno_manual_admin` em `siso_pedido_historico`.
   - I1-I7 verde.

- [ ] **Step 2: Rodar standalone — esperado FAIL (endpoint não existe)**

---

### Task 22: Implementar endpoint `POST /pedidos/[id]/estornar`

**Files:**
- Create: `src/app/api/wms/pedidos/[id]/estornar/route.ts`

- [ ] **Step 1: Escrever endpoint**

Create:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser, userCan } from "@/lib/session";
import { criarEstorno } from "@/lib/wms/ledger";
import { estornarReservaIndividual } from "@/lib/wms/reservas";
import { registrarEvento } from "@/lib/historico-service";
import { logError } from "@/lib/logger";

const Body = z.object({ motivo: z.string().min(3).max(500) });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userCan(session, "pedidos.estornar")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const sb = createServiceClient();
  const { data: pedido, error: ePedido } = await sb.from("siso_pedidos").select("id, status_separacao").eq("id", params.id).single();
  if (ePedido || !pedido) return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });

  // Listar movs S + Rs ativas do pedido
  const { data: movs } = await sb.from("siso_movimentacoes")
    .select("id, tipo, estorno_de")
    .eq("origem_id", params.id)
    .in("tipo", ["S","R"])
    .is("estorno_de", null);

  const estornadas: string[] = [];
  try {
    for (const m of movs ?? []) {
      if (m.tipo === "R") {
        await estornarReservaIndividual(m.id, `estorno_manual: ${parsed.data.motivo}`);
      } else {
        // S → criar par E (estorno)
        await criarEstorno({ mov_id: m.id, motivo: `estorno_manual: ${parsed.data.motivo}` });
      }
      estornadas.push(m.id);
    }

    await sb.from("siso_pedidos").update({
      status_separacao: "cancelado",
      cancelado_motivo: `estorno_manual_admin: ${parsed.data.motivo}`,
      cancelado_em: new Date().toISOString(),
      cancelado_por: session.id,
    }).eq("id", params.id);

    await registrarEvento(params.id, "estorno_manual_admin", {
      usuario_id: session.id,
      motivo: parsed.data.motivo,
      movs_estornadas_count: estornadas.length,
    });

    return NextResponse.json({ ok: true, movs_estornadas: estornadas.length });
  } catch (e: any) {
    await logError({
      source: "api/wms/pedidos/estornar",
      category: "business_logic",
      message: e?.message ?? "estorno falhou",
      meta: { pedido_id: params.id, estornadas_parciais: estornadas },
    });
    return NextResponse.json({ error: "estorno_parcial_falhou", estornadas }, { status: 500 });
  }
}
```

Nota: usar `status_separacao = 'cancelado'` + campos `cancelado_*` (já existem). Se schema não tem `cancelado_motivo`, adicionar via migration mínima ou usar `siso_pedido_historico` apenas.

- [ ] **Step 2: Rodar cenário 31 standalone — esperado PASS**

- [ ] **Step 3: Rodar suite — 31/31 PASS**

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/pedidos/[id]/estornar/route.ts \
        scripts/wms/cenarios/catalogo/31-estorno-manual-admin.ts
git commit -m "feat(api): POST /pedidos/[id]/estornar (Banner D10 admin) (fix-final-A T22 / #A5)"
```

---

### Task 23: Hookup frontend Banner D10

**Files:**
- Modify: `src/app/wms/pedidos/[id]/page.tsx`

- [ ] **Step 1: Localizar TODO Banner D10**

```bash
grep -n "TODO.*D10\|não implementado.*estornar" src/app/wms/pedidos/[id]/page.tsx
```

Deve estar perto da linha 423.

- [ ] **Step 2: Substituir `toast.error` por mutation real**

```tsx
// ANTES:
onClick={() => toast.error("não implementado — abrir ticket")}

// DEPOIS:
const estornarMutation = useMutation({
  mutationFn: async () => {
    const motivo = prompt("Motivo do estorno manual (mín 3 chars):");
    if (!motivo || motivo.length < 3) throw new Error("motivo obrigatório");
    return sisoFetch(`/api/wms/pedidos/${pedido.id}/estornar`, {
      method: "POST",
      body: JSON.stringify({ motivo }),
    });
  },
  onSuccess: () => {
    toast.success("Pedido estornado");
    queryClient.invalidateQueries({ queryKey: ["pedido", pedido.id] });
  },
  onError: (e: any) => toast.error(e.message ?? "estorno falhou"),
});
// ...
onClick={() => { if (confirm("Confirma estornar pedido?")) estornarMutation.mutate(); }}
disabled={estornarMutation.isPending}
```

Esconder botão se `!can("pedidos.estornar")`.

- [ ] **Step 3: Smoke manual em staging**

Abrir `/wms/pedidos/<id concluído>`, clicar Banner D10 "Estornar agora", inserir motivo → confirma → toast success + página re-renderiza com status cancelado.

- [ ] **Step 4: Commit**

```bash
git add src/app/wms/pedidos/[id]/page.tsx
git commit -m "feat(ui): Banner D10 estornar agora (mutation real) (fix-final-A T23 / #A5)"
```

---

## Phase 9 — A6: Endpoint `POST /api/wms/pedidos/[id]/liberar-reservas`

### Task 24: Cenário 32 — liberar reservas admin

**Files:**
- Create: `scripts/wms/cenarios/catalogo/32-liberar-reservas-admin.ts`

- [ ] **Step 1: Criar cenário**

Sequência:
1. Pedido aprovado (status=`aguardando_separacao`, 5 Rs ativas).
2. Capturar Rs ativas (esperado 5).
3. `POST /api/wms/pedidos/[id]/liberar-reservas { motivo: "teste D2" }`.
4. Asserts:
   - 5 Rs estornadas (mov L correspondente existe).
   - `disponivel` na loc aumenta proporcionalmente.
   - `pedido.status_separacao` permanece igual (não cancela pedido).
   - Evento `liberar_reservas_admin` em histórico.
   - I1-I7 verde.

- [ ] **Step 2: Rodar standalone — FAIL**

---

### Task 25: Implementar endpoint `POST /pedidos/[id]/liberar-reservas`

**Files:**
- Create: `src/app/api/wms/pedidos/[id]/liberar-reservas/route.ts`

- [ ] **Step 1: Escrever endpoint**

Estrutura igual ao T22 mas só estorna Rs (não cancela pedido):

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser, userCan } from "@/lib/session";
import { estornarReservaIndividual } from "@/lib/wms/reservas";
import { registrarEvento } from "@/lib/historico-service";

const Body = z.object({ motivo: z.string().min(3).max(500) });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userCan(session, "pedidos.liberar_reservas")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const sb = createServiceClient();
  const { data: rs } = await sb.from("siso_movimentacoes")
    .select("id")
    .eq("origem_id", params.id)
    .eq("tipo", "R")
    .is("estorno_de", null);

  const liberadas: string[] = [];
  for (const r of rs ?? []) {
    await estornarReservaIndividual(r.id, `liberar_reservas_admin: ${parsed.data.motivo}`);
    liberadas.push(r.id);
  }

  await registrarEvento(params.id, "liberar_reservas_admin", {
    usuario_id: session.id,
    motivo: parsed.data.motivo,
    rs_liberadas_count: liberadas.length,
  });

  return NextResponse.json({ ok: true, rs_liberadas: liberadas.length });
}
```

- [ ] **Step 2: Rodar cenário 32 + suite — esperado 32/32 PASS**

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/pedidos/[id]/liberar-reservas/route.ts \
        scripts/wms/cenarios/catalogo/32-liberar-reservas-admin.ts
git commit -m "feat(api): POST /pedidos/[id]/liberar-reservas (D2 override admin) (fix-final-A T25 / #A6)"
```

---

### Task 26: Hookup frontend D2 override + remover TODO checklist

**Files:**
- Modify: `src/app/wms/pedidos/[id]/page.tsx` (linha ~1014)
- Modify: `src/app/wms/separacao/checklist/page.tsx` (linha ~528)

- [ ] **Step 1: Hookup botão D2 override em `pedidos/[id]/page.tsx`**

Substituir TODO por mutation análoga ao T23 chamando `/liberar-reservas`.

- [ ] **Step 2: Remover TODO em `checklist/page.tsx:528`**

Esse TODO ("criar reserva atômica em wms_inserir_movimentacao com origem_tipo=reserva_pedido_encontrei") na verdade pertence ao fluxo de `encontrei` no checklist — confirmar se já é resolvido pelo A2 (T15) ou se exige fix separado. Se já resolve, deletar o TODO. Se não, criar issue separada (fora do escopo deste plano).

- [ ] **Step 3: Smoke manual em staging**

Pedido com Rs ativas → botão D2 override → 5 Rs zeradas, página re-renderiza.

- [ ] **Step 4: Commit**

```bash
git add src/app/wms/pedidos/[id]/page.tsx src/app/wms/separacao/checklist/page.tsx
git commit -m "feat(ui): D2 override libera reservas + remove TODOs (fix-final-A T26 / #A6)"
```

---

## Phase 10 — A8: Backfill R1 em staging

### Task 27: Dry-run backfill R1

**Files:**
- Use existing: `scripts/wms/backfill-compras-recebidas.ts` (criado em commit `b12a4ef`)

- [ ] **Step 1: Verificar script existe**

```bash
ls -la scripts/wms/backfill-compras-recebidas.ts
```

Se não existe, criar baseado no commit `b12a4ef`. Se existe, ler header pra entender args.

- [ ] **Step 2: Dry-run**

```bash
npx tsx scripts/wms/backfill-compras-recebidas.ts
```

Esperado: lista de OCs candidatas + contagem de movs a criar, sem escrever nada.

- [ ] **Step 3: Anotar no doc**

Adicionar em `docs/superpowers/backfill-r1-2026-05-27-staging.md`:

```markdown
## Backfill R1 — Dry-run (T27)

- OCs candidatas: N
- Movs a criar: N
- Empresas afetadas: [...]
- Galpões afetados: [...]
```

---

### Task 28: Run backfill R1 + verificar divergências

- [ ] **Step 1: Snapshot pré-backfill de divergências**

Via MCP:
```sql
SELECT COUNT(*) AS divergencias_pre FROM wms_detectar_divergencias_estoque();
```
Anotar resultado.

- [ ] **Step 2: Run real**

```bash
npx tsx scripts/wms/backfill-compras-recebidas.ts --apply
```

Anotar output completo no doc.

- [ ] **Step 3: Snapshot pós-backfill**

Mesmo SQL. Anotar.

- [ ] **Step 4: Esperado: `pós ≤ pré` (backfill reduz ou mantém divergências, nunca aumenta)**

Se aumentou: investigar antes de commitar. Caso crítico: rollback via `BEGIN; DELETE FROM siso_movimentacoes WHERE origem_tipo='nf_compra' AND criado_em > '<timestamp do run>' ... ROLLBACK;` (cuidado: ledger é imutável, dropar movs requer permissão especial; preferir gerar estornos via `criarEstorno` se necessário).

- [ ] **Step 5: Commit doc**

```bash
git add docs/superpowers/backfill-r1-2026-05-27-staging.md
git commit -m "chore(backfill): execute R1 backfill em staging (fix-final-A T28 / #A8)"
```

---

## Phase 11 — Closure

### Task 29: Atualizar `erros-conhecidos.yaml` (8 entradas)

**Files:**
- Modify: `erros-conhecidos.yaml`

- [ ] **Step 1: Adicionar 1 entrada por item A1-A8**

Formato (espelhar entradas existentes):

```yaml
- id: wms-fix-final-a-2.15-gating-concluir-oc
  date: 2026-05-27
  source: src/app/api/wms/separacao/concluir-oc/route.ts
  category: business_logic
  message: "Gating dupla baixa OC foi revertido em c349ead pq quebrava NF; janela de bug voltou"
  cause: "Gating misturava skip enqueue legacy + cutover ledger; quando NF não chegou ainda, cutover falhava"
  fix: "Split: skip enqueue legacy sempre em WMS_AS_SOURCE; cutover só executa se nota_fiscal_id presente, senão transita aguardando_nf"
  files:
    - src/app/api/wms/separacao/concluir-oc/route.ts
    - src/lib/nf-webhook-handler.ts
  tags: [concluir-oc, nf, cutover, dupla-baixa, fix-final-a]

- id: wms-fix-final-a-2.6-desfazer-encontrei
  date: 2026-05-27
  ...
```

Repetir pros 8 itens (A1-A8).

- [ ] **Step 2: Commit**

```bash
git add erros-conhecidos.yaml
git commit -m "docs(errors): 8 entradas fix-final-A em erros-conhecidos (T29)"
```

---

### Task 30: Atualizar `docs/api-reference-complete.md` + `CLAUDE.md`

**Files:**
- Modify: `docs/api-reference-complete.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: api-reference — 2 endpoints novos**

Adicionar `POST /api/wms/pedidos/[id]/estornar` e `POST /api/wms/pedidos/[id]/liberar-reservas` no formato existente (method, path, auth, request, response, side effects).

- [ ] **Step 2: CLAUDE.md — seção "Recently Fixed (Fix-Final A 2026-05-27)"**

Adicionar bullet abaixo do último PR-merge:

```markdown
- **Fix-Final A — Cobertura ledger (2026-05-27).** 8 itens P0 residuais da auditoria 05-26 fechados: re-aplica gating concluir-oc com split NF (#2.15), desfazer_encontrei estorna mov (#2.6), localizacao trata reservado>0 (#2.7), marcar-item usa separacao_galpao_id em transferência (#A4), endpoints Banner D10 /estornar + D2 /liberar-reservas (#A5+#A6), migration siso_notas_fiscais + backfill retroativo (R5), backfill OCs pré-P2 executado em staging (R1). 7 cenários novos (26-32). Plano: `docs/superpowers/plans/2026-05-27-wms-fix-final-A.md`.
```

- [ ] **Step 3: CLAUDE.md — remover itens fechados da seção "Deprecated / To Remove"**

Nenhum item de fix-final-A vai pra deprecated. Confirmar que nada precisa sair.

- [ ] **Step 4: Commit**

```bash
git add docs/api-reference-complete.md CLAUDE.md
git commit -m "docs: api-reference + CLAUDE.md atualizados pro fix-final-A (T30)"
```

---

### Task 31: Verificação final §5 critérios

**Files:** none (validation only)

- [ ] **Step 1: Rodar suite completa**

```bash
npm run scenarios
```
Expected: **32/32 PASS** (25 antigos + 7 novos 26-32). Tempo ≤ 5min.

- [ ] **Step 2: Divergências em staging ≤ baseline (T28)**

Comparar com snapshot pós-backfill.

- [ ] **Step 3: Smoke staging manual**

1. Logar como admin.
2. Criar pedido novo (cenário 01 manual via UI).
3. Aprovar → separar → embalar → expedir.
4. Validar sem erros UI.
5. Estornar pedido via Banner D10 → saldo volta.
6. Criar outro pedido → aprovar → liberar Rs via D2 → Rs zeram.

- [ ] **Step 4: Anotar resultado em `docs/superpowers/backfill-r1-2026-05-27-staging.md` seção "Verificação final"**

```markdown
## Verificação final (T31)
- Suite: 32/32 PASS ✅
- Divergências: pre=N, pos=M (M ≤ N) ✅
- Smoke manual: 6/6 OK ✅
```

- [ ] **Step 5: Commit doc**

```bash
git add docs/superpowers/backfill-r1-2026-05-27-staging.md
git commit -m "docs(fix-final-a): verificação final §5 OK (T31)"
```

---

### Task 32: Criar PR + handoff Fix-B/C

**Files:** none (git/gh)

- [ ] **Step 1: Push branch**

```bash
git push -u origin wms-fix-final-a
```

- [ ] **Step 2: Criar PR**

```bash
gh pr create --title "WMS Fix-Final A — Cobertura ledger (8 itens P0)" --body "$(cat <<'EOF'
## Summary
- Fecha 8 itens P0 residuais da auditoria WMS 2026-05-26 que sobraram após P1-P6.
- Re-aplica gating #2.15 (concluir-oc) com split NF; desfazer_encontrei estorna mov (#2.6); localizacao trata reservado>0 (#2.7); marcar-item usa separacao_galpao_id em transferência (#A4); novos endpoints Banner D10 /estornar + D2 /liberar-reservas (#A5+#A6); migration siso_notas_fiscais + backfill retroativo (R5); backfill OCs pré-P2 executado em staging (R1).
- 7 cenários novos (26-32), suite 32/32 PASS. Migration aplicada **só em staging** (`ehbxpbeijofxtsbezwxd`); nada em prod.

## Spec + plano
- Spec: `docs/superpowers/specs/2026-05-27-wms-fix-final-design.md`
- Plano: `docs/superpowers/plans/2026-05-27-wms-fix-final-A.md`
- Próximos: Fix-B (11 itens P2) + Fix-C (10 itens P3)

## Test plan
- [x] `npm run scenarios` → 32/32 PASS
- [x] Divergências staging ≤ baseline pré-fix
- [x] Smoke manual: aprovar/separar/embalar/expedir + estornar + liberar Rs
- [x] Backfill R1 doc em `docs/superpowers/backfill-r1-2026-05-27-staging.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Retornar URL pro user + sugerir próximos**

> Fix-A merged. Próximo: invocar `writing-plans` pra criar `2026-05-27-wms-fix-final-B.md` (11 itens P2) e `2026-05-27-wms-fix-final-C.md` (10 itens P3).

---

## Apêndice — checklist final (correlato com spec §5)

- [ ] PR aberto contra `develop` com 32 commits
- [ ] `erros-conhecidos.yaml` ganhou 8 entradas (1 por item A1-A8)
- [ ] `docs/api-reference-complete.md` documenta 2 endpoints novos
- [ ] `docs/database-schema.md` documenta `siso_notas_fiscais`
- [ ] `CLAUDE.md` ganha bullet "Recently Fixed: Fix-Final A"
- [ ] Suite `npm run scenarios` 32/32 verde
- [ ] `wms_detectar_divergencias_estoque()` retorna ≤ baseline (T28)
- [ ] Smoke staging: pedido completo + estornar + liberar Rs OK
- [ ] Migration `siso_notas_fiscais` aplicada **só** em `ehbxpbeijofxtsbezwxd`
- [ ] `docs/superpowers/backfill-r1-2026-05-27-staging.md` documenta T1/T9/T27/T28/T31
