# WMS Fix-Final C — QA + cleanups (P3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os 10 itens P3 residuais: 5 QA P5 deferidos pra manual (responsivo, lighthouse, error handling, smoke matrix UI, realtime browser) + 1 drop de tabela legada (`siso_pedido_item_estoques`) + 4 remoções de `@deprecated` (`getValidTokenByFilial`, helpers cargo em `compras-utils`, coluna `observacoes_old`, campo `localizacoes_excluir`).

**Architecture:**
- C1-C5: QA manual em browser staging (`estoquelever.vercel.app`). Cada QA produz 1 arquivo md em `docs/superpowers/qa-cN-*.md` com screenshots ou bullets de evidência.
- C6: drop tabela legada exige 2 passos — primeiro renomear pra `_archived`, depois drop após janela de 7 dias estável.
- C7-C10: remoção de `@deprecated` é grep + replace caller-a-caller + delete. Cada um vira 1 commit.
- **Pré-requisitos:** Fix-A e Fix-B merged em `develop`. Tabela `siso_pedido_item_estoques` em particular exige zero writes novos (Fix-A não introduziu nenhum).

**Tech Stack:** Lighthouse CLI, Chrome DevTools, npm test infra.

**Spec:** [`docs/superpowers/specs/2026-05-27-wms-fix-final-design.md`](../specs/2026-05-27-wms-fix-final-design.md) §4 (itens C1-C10).

---

## Arquivos afetados

**Criar:**
- `docs/superpowers/qa-c1-responsivo-2026-05-27.md`
- `docs/superpowers/qa-c2-lighthouse-2026-05-27.md`
- `docs/superpowers/qa-c3-error-handling-2026-05-27.md`
- `docs/superpowers/qa-c4-smoke-ui-2026-05-27.md`
- `docs/superpowers/qa-c5-realtime-browser-2026-05-27.md`
- `supabase/migrations/20260530_archive_siso_pedido_item_estoques.sql` (C6 fase 1)
- `supabase/migrations/20260606_drop_siso_pedido_item_estoques_archived.sql` (C6 fase 2, 7 dias depois)
- `supabase/migrations/20260530_drop_pedidos_observacoes_old.sql` (C9)

**Modificar:**
- `src/lib/tiny-oauth.ts` — remove `getValidTokenByFilial` (C7)
- `src/lib/compras-utils.ts` — remove cargo helpers (C8)
- `src/lib/separacao/realocacao-resolver.ts` — remove `localizacoes_excluir` (C10)
- Consumidores de `siso_pedido_item_estoques` (C6 migra leitura pra `siso_estoque` + ledger)
- `erros-conhecidos.yaml` — 10 entradas novas
- `CLAUDE.md` — remove itens "Deprecated / To Remove" + bullet "Recently Fixed: Fix-Final C"
- `docs/database-schema.md` — remove `siso_pedido_item_estoques`, `siso_pedidos.observacoes_old`

---

## Phase 1 — Setup

### Task 1: Branch + pré-requisitos

- [ ] **Step 1: Garantir Fix-A e Fix-B mergeados em develop**

```bash
git checkout develop && git pull
git log --oneline | grep "fix-final-a\|fix-final-b" | head -5
```
Expected: ambos presentes.

- [ ] **Step 2: Suite verde**

```bash
npm run scenarios
```
Expected: **35/35 PASS** (Fix-A+B combinados).

- [ ] **Step 3: Branch + worktree**

```bash
git worktree add -b wms-fix-final-c .claude/worktrees/wms-fix-final-c/ develop
cd .claude/worktrees/wms-fix-final-c
```

---

## Phase 2 — QA manual P5 (C1-C5)

### Task 2: C1 — Layout responsivo

**Files:**
- Create: `docs/superpowers/qa-c1-responsivo-2026-05-27.md`

- [ ] **Step 1: Abrir 6 telas em 3 breakpoints**

URL base: `https://estoquelever.vercel.app` (staging deploy da `develop`).

Telas:
1. `/wms` (home)
2. `/wms/separacao`
3. `/wms/pedidos`
4. `/wms/pedidos/<id qualquer>`
5. `/wms/inventario/<id qualquer>`
6. `/wms/guarda/rota`

Breakpoints (Chrome DevTools):
- mobile: 375x667
- tablet: 768x1024
- desktop: 1440x900

- [ ] **Step 2: Capturar screenshot + anotar bugs**

Pra cada combinação tela×breakpoint:
- Screenshot (salvar em pasta `docs/superpowers/qa-c1-screenshots/`)
- Anotar bugs no doc:

```markdown
# QA C1 — Layout responsivo (2026-05-27)

## Telas testadas: 6 × Breakpoints: 3 = 18 capturas

### /wms (home)
- **mobile (375):** ✅ OK | 🐛 [descrição do bug]
- **tablet (768):** ✅
- **desktop (1440):** ✅

### /wms/separacao
...
```

- [ ] **Step 3: Classificar bugs encontrados**

Pra cada bug:
- **P0** (quebra funcionalidade): vira hotfix imediato (commit + push agora).
- **P1** (overflow/clip visível): vira task no próprio Fix-C.
- **P2** (alinhamento subótimo): vira entrada em backlog separado (não bloqueia Fix-C).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/qa-c1-responsivo-2026-05-27.md docs/superpowers/qa-c1-screenshots/
git commit -m "qa(c1): layout responsivo 6 telas × 3 breakpoints (fix-final-C T2)"
```

---

### Task 3: C2 — Lighthouse

**Files:**
- Create: `docs/superpowers/qa-c2-lighthouse-2026-05-27.md`

- [ ] **Step 1: Instalar lighthouse CLI se necessário**

```bash
which lighthouse || npm install -g lighthouse
```

- [ ] **Step 2: Rodar 3x em cada URL e tirar mediana**

```bash
for url in https://estoquelever.vercel.app/wms https://estoquelever.vercel.app/wms/separacao https://estoquelever.vercel.app/wms/pedidos; do
  for i in 1 2 3; do
    lighthouse "$url" --quiet --chrome-flags="--headless" --output=json --output-path="./lh-$(basename $url)-$i.json"
  done
done
```

- [ ] **Step 3: Calcular mediana + anotar**

```markdown
# QA C2 — Lighthouse (2026-05-27)

## Targets
- Performance ≥ 60
- Accessibility ≥ 90
- Best Practices ≥ 90

## Resultados (mediana de 3 runs)

| URL | Perf | A11y | BP | SEO |
|---|---|---|---|---|
| /wms | N | N | N | N |
| /wms/separacao | N | N | N | N |
| /wms/pedidos | N | N | N | N |
```

- [ ] **Step 4: Bugs abaixo do target → task no Fix-C (se quick win) ou backlog**

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/qa-c2-lighthouse-2026-05-27.md
git commit -m "qa(c2): lighthouse 3 URLs mediana de 3 runs (fix-final-C T3)"
```

---

### Task 4: C3 — Error handling

**Files:**
- Create: `docs/superpowers/qa-c3-error-handling-2026-05-27.md`

- [ ] **Step 1: Matriz 5 rotas × 3 erros (401/403/500)**

Rotas a testar:
1. `POST /api/wms/pedidos/aprovar`
2. `POST /api/wms/separacao/marcar-item`
3. `POST /api/wms/devolucoes/[id]/classificar`
4. `POST /api/wms/vendas/criar`
5. `POST /api/wms/inventario/[id]/aprovar`

Erros forçados:
- 401: logout + tentar endpoint
- 403: logar como user sem perm e tentar
- 500: forçar payload inválido que passa Zod mas quebra business logic (ex: pedido_id que não existe)

- [ ] **Step 2: Pra cada combinação, validar:**

1. UI mostra toast com mensagem útil (não silent fail).
2. Página não trava/quebra.
3. Estado UI consistente (loading vira off).

Anotar em md:

```markdown
# QA C3 — Error handling (2026-05-27)

| Rota | 401 | 403 | 500 |
|---|---|---|---|
| POST /pedidos/aprovar | ✅ toast "sessão expirada" | ✅ toast "sem permissão" | ✅ toast "erro: ..." |
...
```

- [ ] **Step 3: Bugs → P0 hotfix, P1 task, P2 backlog**

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/qa-c3-error-handling-2026-05-27.md
git commit -m "qa(c3): error handling 5 rotas × 3 erros (fix-final-C T4)"
```

---

### Task 5: C4 — Smoke matrix UI

**Files:**
- Create: `docs/superpowers/qa-c4-smoke-ui-2026-05-27.md`

- [ ] **Step 1: Executar 12 fluxos do P5 §5.16**

Ler `docs/superpowers/plans/2026-05-26-wms-fix-p5-visibilidade-home-ui-fixes.md` §5.16 pra lista exata. Esperado: ~12 fluxos curtos (cada um 5-10 min em browser).

- [ ] **Step 2: Checklist por fluxo**

```markdown
# QA C4 — Smoke UI matrix (2026-05-27)

## Fluxos testados

- [x] §5.1: ...
- [x] §5.2: ...
- [x] §5.3: ...
...
- [x] §5.12: ...

## Bugs encontrados

- [P1] §5.X: ...
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/qa-c4-smoke-ui-2026-05-27.md
git commit -m "qa(c4): smoke matrix UI 12 fluxos (fix-final-C T5)"
```

---

### Task 6: C5 — Realtime browser

**Files:**
- Create: `docs/superpowers/qa-c5-realtime-browser-2026-05-27.md`

- [ ] **Step 1: Abrir 2 abas em `/wms`**

Mesmo navegador, 2 abas com `/wms`.

- [ ] **Step 2: Disparar eventos na aba 1, validar aba 2 reage < 3s**

Eventos:
1. Criar pedido novo (POST manual) → aba 2 contador "Aprovação" +1 em <3s.
2. Aprovar pedido → aba 2 contador "Separação" +1.
3. Cancelar pedido → aba 2 contador "Aprovação" -1.
4. Criar pendência de guarda → aba 2 coluna "Guarda" ganha card.
5. Concluir inventário → aba 2 coluna "Inventário" perde card.
6. Receber NF compra → aba 2 coluna "Compras" muda contador fornecedor.

- [ ] **Step 3: Cronometrar cada evento**

```markdown
# QA C5 — Realtime browser (2026-05-27)

| Evento | Latência (s) | OK |
|---|---|---|
| pedido criado | 1.2 | ✅ |
| pedido aprovado | 1.8 | ✅ |
...
```

- [ ] **Step 4: Bugs (latência > 5s ou não-update) → P0 (realtime quebrado é regressão crítica)**

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/qa-c5-realtime-browser-2026-05-27.md
git commit -m "qa(c5): realtime browser 6 eventos (fix-final-C T6)"
```

---

## Phase 3 — C7-C10: Remoção de `@deprecated`

### Task 7: C7 — Remove `getValidTokenByFilial`

**Files:**
- Modify: `src/lib/tiny-oauth.ts`

- [ ] **Step 1: Listar consumidores**

```bash
grep -rn "getValidTokenByFilial" src/ scripts/ --include="*.ts" --include="*.tsx"
```

- [ ] **Step 2: Substituir caller por caller**

Cada caller que recebe `filial` precisa virar `empresa_id`. Padrão:
```ts
// ANTES:
const token = await getValidTokenByFilial(filial);

// DEPOIS:
const empresa = await getEmpresaByFilial(filial); // ou já ter empresa_id em scope
const token = await getValidTokenByEmpresa(empresa.id);
```

- [ ] **Step 3: Deletar função `getValidTokenByFilial`**

Edit `src/lib/tiny-oauth.ts:216` — remover função inteira (incluindo @deprecated comment).

- [ ] **Step 4: Build + suite**

```bash
npm run build && npm run scenarios
```
Expected: build OK, suite 35/35 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tiny-oauth.ts # + outros tocados
git commit -m "chore(tiny): remove getValidTokenByFilial deprecated (fix-final-C T7)"
```

---

### Task 8: C8 — Remove cargo helpers em `compras-utils.ts`

**Files:**
- Modify: `src/lib/compras-utils.ts`

- [ ] **Step 1: Localizar funções deprecated**

```bash
grep -n "@deprecated\|cargo" src/lib/compras-utils.ts
```

- [ ] **Step 2: Listar consumidores**

```bash
grep -rn "from.*compras-utils\|require.*compras-utils" src/ | head -20
```

Pra cada caller que usa cargo helper, substituir por `userCan(session, "perm.x")`.

- [ ] **Step 3: Deletar funções deprecated**

Remover comments `@deprecated` + corpo das funções.

- [ ] **Step 4: Build + suite**

```bash
npm run build && npm run scenarios
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/compras-utils.ts # + callers tocados
git commit -m "chore(compras): remove cargo helpers deprecated (fix-final-C T8)"
```

---

### Task 9: C9 — Drop coluna `siso_pedidos.observacoes_old`

**Files:**
- Create: `supabase/migrations/20260530_drop_pedidos_observacoes_old.sql`

- [ ] **Step 1: Confirmar zero consumidores**

```bash
grep -rn "observacoes_old" src/ scripts/ supabase/ --include="*.ts" --include="*.tsx" --include="*.sql"
```
Expected: 0 hits (ou só comments). Se algum endpoint ainda lê, primeiro migrar.

- [ ] **Step 2: Migration**

```sql
-- Fix-Final C T9: drop coluna deprecated observacoes_old
BEGIN;
ALTER TABLE siso_pedidos DROP COLUMN IF EXISTS observacoes_old;
COMMIT;
```

- [ ] **Step 3: Aplicar em staging via MCP**

```
mcp__supabase__apply_migration(
  project_id="ehbxpbeijofxtsbezwxd",
  name="20260530_drop_pedidos_observacoes_old",
  query="<SQL>"
)
```

- [ ] **Step 4: Validar via SQL**

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='siso_pedidos' AND column_name='observacoes_old';
```
Expected: 0 rows.

- [ ] **Step 5: Suite verde + commit**

```bash
npm run scenarios
git add supabase/migrations/20260530_drop_pedidos_observacoes_old.sql
git commit -m "chore(db): drop siso_pedidos.observacoes_old (fix-final-C T9)"
```

---

### Task 10: C10 — Remove `localizacoes_excluir` em `realocacao-resolver.ts`

**Files:**
- Modify: `src/lib/separacao/realocacao-resolver.ts`

- [ ] **Step 1: Confirmar callers usam `localizacoes_tentadas`**

```bash
grep -rn "localizacoes_excluir\|localizacoes_tentadas" src/ | head -20
```

Expected: callers já usam `localizacoes_tentadas` (P3 ou anterior migrou). `localizacoes_excluir` só fica como alias compat.

- [ ] **Step 2: Deletar campo**

Edit `src/lib/separacao/realocacao-resolver.ts:42` — remover branch que aceita `localizacoes_excluir` como alias.

- [ ] **Step 3: Build + suite (cenários 04/05 exercitam realocação)**

```bash
npm run build && npm run scenarios -- --only=04,05
```
Expected: ambos PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/separacao/realocacao-resolver.ts
git commit -m "chore(separacao): remove localizacoes_excluir alias deprecated (fix-final-C T10)"
```

---

## Phase 4 — C6: Dropar `siso_pedido_item_estoques` (fase 1: rename)

### Task 11: Migrar consumidores que ainda leem

**Files:**
- Identificar e modificar consumidores que leem `siso_pedido_item_estoques`

- [ ] **Step 1: Listar consumidores**

```bash
grep -rn "siso_pedido_item_estoques" src/ --include="*.ts" --include="*.tsx" | head -30
```

- [ ] **Step 2: Pra cada read, migrar pra `siso_estoque` + ledger**

Padrão geral:
```ts
// ANTES: lê estoque por pedido+empresa
const { data } = await sb.from("siso_pedido_item_estoques")
  .select("...")
  .eq("pedido_id", pedidoId)
  .eq("empresa_id", empresaId);

// DEPOIS: lê de siso_estoque (estado atual) ou siso_movimentacoes (histórico)
const { data } = await sb.from("siso_estoque")
  .select("produto_id, galpao_id, localizacao_id, saldo, disponivel")
  .eq("produto_id", item.produto_id)
  .eq("galpao_id", galpaoId);
// ... e pra empresa: filtrar via tags em movs do pedido
```

Cada migração de consumidor é 1 commit (pode dar 5-10 commits aqui dependendo do número de callers).

- [ ] **Step 3: Suite verde após cada commit**

- [ ] **Step 4: Commits agrupados por consumidor**

```bash
git add <consumidor1>
git commit -m "refactor(consumer): lê de siso_estoque em vez de siso_pedido_item_estoques (fix-final-C T11 part N)"
```

---

### Task 12: Migration rename pra `_archived`

**Files:**
- Create: `supabase/migrations/20260530_archive_siso_pedido_item_estoques.sql`

- [ ] **Step 1: Confirmar zero reads em código**

```bash
grep -rn "siso_pedido_item_estoques" src/ scripts/ --include="*.ts" --include="*.tsx"
```
Expected: 0 hits (depois das migrações).

- [ ] **Step 2: Migration**

```sql
-- Fix-Final C T12: rename siso_pedido_item_estoques pra _archived
-- (drop final em migration separada após 7 dias)
BEGIN;
ALTER TABLE siso_pedido_item_estoques RENAME TO siso_pedido_item_estoques_archived;
-- Remove triggers que escrevem (se houver)
DO $$ BEGIN
  ALTER TABLE siso_pedido_item_estoques_archived DISABLE TRIGGER ALL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
COMMIT;
```

- [ ] **Step 3: Aplicar em staging via MCP**

- [ ] **Step 4: Smoke staging — confirmar zero erros 24h**

Validar logs (`siso_logs` + `siso_erros`) por 24h após apply. Se zero erros relacionados a `siso_pedido_item_estoques`, prosseguir pra Task 13. Se houver erros, restaurar via `RENAME .._archived TO siso_pedido_item_estoques` e fixar consumidor restante.

- [ ] **Step 5: Commit migration**

```bash
git add supabase/migrations/20260530_archive_siso_pedido_item_estoques.sql
git commit -m "chore(db): archive siso_pedido_item_estoques (rename, drop em 7d) (fix-final-C T12)"
```

---

### Task 13: Migration drop final (programar +7 dias)

**Files:**
- Create: `supabase/migrations/20260606_drop_siso_pedido_item_estoques_archived.sql`

- [ ] **Step 1: Aguardar 7 dias OU confirmar staging estável**

Antes de aplicar este drop, validar:
- `siso_logs WHERE message LIKE '%siso_pedido_item_estoques%' AND criado_em > <archive_date>`: 0 rows.
- Suite 35/35 PASS em 3 runs separados.

- [ ] **Step 2: Migration drop**

```sql
-- Fix-Final C T13: drop final siso_pedido_item_estoques_archived
BEGIN;
DROP TABLE IF EXISTS siso_pedido_item_estoques_archived;
COMMIT;
```

- [ ] **Step 3: Aplicar em staging**

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260606_drop_siso_pedido_item_estoques_archived.sql
git commit -m "chore(db): DROP siso_pedido_item_estoques_archived (fix-final-C T13)"
```

---

## Phase 5 — Closure

### Task 14: `erros-conhecidos.yaml` (10 entradas)

**Files:**
- Modify: `erros-conhecidos.yaml`

- [ ] **Step 1: Adicionar 1 entrada por item C1-C10**

Pra QA (C1-C5), entrada com `category: qa` e `fix:` apontando pro doc gerado.

Pra cleanups (C6-C10), `category: cleanup` e `fix:` descrevendo remoção.

- [ ] **Step 2: Commit**

```bash
git add erros-conhecidos.yaml
git commit -m "docs(errors): 10 entradas fix-final-C em erros-conhecidos (T14)"
```

---

### Task 15: CLAUDE.md — remove "Deprecated" + bullet "Recently Fixed"

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/database-schema.md`

- [ ] **Step 1: Remover itens fechados de "Deprecated / To Remove"**

Da seção CLAUDE.md "### Deprecated / To Remove", deletar:
- `siso_pedido_item_estoques` (dropada em T13)
- `getValidTokenByFilial` (T7)
- helpers cargo `compras-utils` (T8)
- `observacoes_old` (T9)
- `localizacoes_excluir` (T10)

- [ ] **Step 2: Adicionar bullet "Recently Fixed"**

```markdown
- **Fix-Final C — QA + cleanups (2026-05-30 / 2026-06-06).** 10 itens P3 fechados: QA P5 manual deferido (responsivo/lighthouse/error handling/smoke UI/realtime browser — docs em `docs/superpowers/qa-c{1..5}-*.md`), drop `siso_pedido_item_estoques` (archive 2026-05-30, drop final 2026-06-06), remoção de 4 `@deprecated` (`getValidTokenByFilial`, helpers cargo, `observacoes_old`, `localizacoes_excluir`). Plano: `docs/superpowers/plans/2026-05-27-wms-fix-final-C.md`.
```

- [ ] **Step 3: `docs/database-schema.md` — remover entradas das tabelas/colunas dropadas**

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/database-schema.md
git commit -m "docs: CLAUDE + schema sem deprecated (fix-final-C T15)"
```

---

### Task 16: Verificação final + PR (Fase 1 — pré-drop final)

- [ ] **Step 1: Suite verde**

```bash
npm run scenarios
```
Expected: **35/35 PASS** (Fix-A+B+C exceto drop final).

- [ ] **Step 2: Push branch + PR fase 1**

```bash
git push -u origin wms-fix-final-c
gh pr create --title "WMS Fix-Final C (fase 1) — QA + cleanups + archive tabela" --body "$(cat <<'EOF'
## Summary
- Fecha 9 itens P3 (T2-T12): QA P5 manual documentado (5 arquivos md), drop 4 @deprecated, archive `siso_pedido_item_estoques` (rename pra _archived).
- T13 (drop final da tabela archived) entra em PR separado após janela de 7 dias estável em staging.

## Spec + plano
- Spec: `docs/superpowers/specs/2026-05-27-wms-fix-final-design.md` §4
- Plano: `docs/superpowers/plans/2026-05-27-wms-fix-final-C.md`
- Pré-req: Fix-A + Fix-B merged

## Test plan
- [x] `npm run scenarios` → 35/35 PASS
- [x] QA C1-C5 docs em `docs/superpowers/qa-c{1..5}-*.md`
- [x] Build OK pós-remoção dos @deprecated
- [x] Staging estável 24h pós-archive (`siso_pedido_item_estoques_archived` sem erros)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Agendar PR fase 2 (drop final) pra +7 dias**

Após PR fase 1 mergeado e 7 dias de staging estável, criar segundo PR só com T13 (migration `20260606_drop_siso_pedido_item_estoques_archived.sql`).

---

## Apêndice — checklist final

- [ ] QA C1-C5 documentados em 5 mds com evidência (screenshots / bullets)
- [ ] Bugs P0 encontrados em QA viraram hotfixes pré-commit; P1 viraram tasks; P2 viraram backlog
- [ ] 4 `@deprecated` removidos (T7/T8/T9/T10) com build e suite verdes
- [ ] `siso_pedido_item_estoques` archived (rename) em staging T12
- [ ] `siso_pedido_item_estoques_archived` dropada após janela de 7 dias (T13, PR separado)
- [ ] `erros-conhecidos.yaml` ganhou 10 entradas
- [ ] `CLAUDE.md` removeu 5 itens de "Deprecated / To Remove"
- [ ] `docs/database-schema.md` atualizado (tabela + colunas dropadas)
- [ ] 2 PRs criados (fase 1 + fase 2 drop)
- [ ] Migrations aplicadas só em staging (`ehbxpbeijofxtsbezwxd`), zero em prod
