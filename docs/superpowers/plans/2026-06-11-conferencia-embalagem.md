# Conferência de Embalagem (bipar etiqueta de envio) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nova etapa `conferido` entre `embalado` e `expedido`. O embalador bipa a etiqueta de envio (ML/Shopee) ao embalar — fica registrado QUEM embalou cada pacote. Depois, um conferente bipa a mesma etiqueta: o sistema mostra os itens esperados, ele confere visualmente; bipar a próxima etiqueta = OK (zero clique no caminho feliz); achou erro = botão Divergência (tipo + obs), arruma fisicamente e segue. Gera métricas de taxa de acerto por embalador. Conferência NÃO bloqueia expedição.

**Architecture:** O barcode da etiqueta de envio já vive no sistema — `siso_pedidos.etiqueta_zpl` (cacheado em `agrupamento-service.ts:738` na separação e `etiqueta-service.ts:433` no fallback). Novo parser puro extrai os valores de barcode do ZPL e grava em `siso_pedidos.etiqueta_barcodes text[]` (GIN). Bip → lookup exato no array; fallbacks: `chave_acesso_nf` (DANFE 44 dígitos), `id_pedido_ecommerce`, e ILIKE no ZPL bruto com self-heal (persiste o barcode no hit). Estado novo mínimo: colunas em `siso_pedidos` + status `conferido`; bip do embalador NÃO muda status (só grava `embalado_real_por/em`).

**Tech Stack:** Next.js route handlers, Supabase (service role), Vitest (unit happy-dom + integration contra staging real), migration via Management API (MCP geralmente não conectado — ver memória `project_migration_via_management_api`).

---

## Decisões do usuário (entrevista 2026-06-11)

| # | Decisão |
|---|---|
| D1 | **Quem embalou:** embalador, logado, bipa a etiqueta de envio ao embalar → `embalado_real_por`. Conferência é uma 2ª bipagem (pode ser o próprio embalador — ver D5). |
| D2 | **Profundidade:** conferência VISUAL — bipa etiqueta, vê itens esperados (foto/SKU/qty), olha o pacote. SEM bipar produto por produto. Bipar a próxima etiqueta = OK automático da anterior já confirmada no scan. |
| D3 | **Não bloqueia:** expedir aceita `embalado` OU `conferido`. Métricas mostram % conferido. |
| D4 | **Divergência:** conferente arruma fisicamente na bancada (pacote não volta no fluxo); fica registrado quem embalou e quem conferiu + tipo de erro (conta contra o embalador). |
| D5 | **Auto-conferência permitida:** mesmo usuário PODE conferir pacote que ele próprio embalou (revisado 2026-06-11; sem bloqueio nem marcação especial). |
| D6 | **Status:** só `conferido` entra na máquina (`separado → embalado → conferido`). Bip do embalador = campos + evento, sem status próprio. |

## Contexto verificado (código, 2026-06-11)

| Fato | Onde |
|---|---|
| Fluxo hoje: checklist de embalagem bipa PRODUTOS (`bipar-embalagem`), todos `bipado_completo` → `status_separacao='embalado'` + imprime etiqueta. `embalagem_operador_id` = quem fechou o checklist (tirou etiquetas), NÃO quem embalou fisicamente | `src/app/api/wms/separacao/bipar-embalagem/route.ts`, `confirmar-item-embalagem/route.ts:138` |
| ZPL da etiqueta persistido em 2 pontos: pré-cache na separação e fallback na impressão. ZPL pode conter MÚLTIPLAS etiquetas (envio + DANFE) | `agrupamento-service.ts:738`, `etiqueta-service.ts:433` |
| `StatusSeparacao` não tem `conferido` nem `expedido` (expedido é escrito na coluna mas fora do type) | `src/types/index.ts:171` |
| `voltar-etapa` STATUS_ORDER termina em `embalado` | `voltar-etapa/route.ts:21-29` |
| Cutover `FORWARD_STATES = ["separado","embalado","expedido"]` — **adicionar `conferido` é OBRIGATÓRIO** senão `reverterCutoverSeRetrocedeu` trata `embalado→conferido` como saída do conjunto forward | `src/lib/wms/cutover.ts:36` |
| Expedir valida todos `status_separacao='embalado'`; guard = session + `userCan('sistema.usuarios')` | `expedir/route.ts:100-119` |
| Coluna do nº do pedido marketplace: `id_pedido_ecommerce` (snake no DB; `idPedidoEcommerce` é o campo TS) | `webhook-processor-wms.ts:553` |
| `bipar-embalagem` guard: só `getSessionUser` (sem userCan) — seguir o mesmo padrão nas rotas novas + `requireWarehouseAccess` se disponível | `bipar-embalagem/route.ts:22` |
| Eventos de pedido: union `EventoPedido` | `src/lib/historico-service.ts:44` |
| Scanner: input autofocus permanente + keydown redirect (padrão a copiar) | `src/app/wms/separacao/embalagem/page.tsx:200-210` |

**Gotcha ZPL/Code128:** o `^FD` de um `^BC` pode conter sequências de troca de subset (`>:`, `>5`, `>6`, `>;` etc.) que NÃO saem no scan do leitor. O parser precisa normalizar (strip `>` + caractere seguinte) antes de persistir. QR (`^BQ`) tem prefixo `LA,`/`QA,`/`H,` no `^FD`. Validar contra ZPL REAL de staging (Task 2, Step 1).

---

## File Structure

- **Migration:** `supabase/migrations/20260611b_conferencia_embalagem.sql`
- **Novo:** `src/lib/etiqueta-barcode.ts` (parser puro + persistência) · `src/lib/etiqueta-barcode.test.ts`
- **Novo:** `src/app/api/wms/separacao/conferencia/bipar/route.ts` · `conferencia/divergencia/route.ts`
- **Novo:** `src/app/api/wms/relatorios/conferencia/route.ts`
- **Novo:** `src/app/wms/separacao/conferencia/page.tsx` · `src/app/wms/relatorios/conferencia/page.tsx`
- **Modificar:** `src/types/index.ts` (StatusSeparacao, SeparacaoCounts) · `src/lib/historico-service.ts` (eventos) · `src/lib/wms/cutover.ts:36` · `voltar-etapa/route.ts` · `expedir/route.ts` · `agrupamento-service.ts` · `etiqueta-service.ts` · `wms-shell.tsx` (sidebar) + sweep de filtros/counts (Task 7)
- **Test (integration, TRUNCA STAGING):** `test/integration/conferencia-embalagem.integration.test.ts`
- **Docs (mesmo commit):** `docs/api-reference-complete.md`, `docs/database-schema.md`, `docs/architecture-and-flows.md`, `docs/fluxos-siso.md`, `CLAUDE.md` (linha do status flow)

> ⚠️ **Hazard de verificação:** `npm run test:integration` e `npm run scenarios` rodam contra o staging real e **truncam tabelas operacionais**. NÃO rodar com staging em uso. Gates seguros autônomos: `npm test` (unit), `npx tsc --noEmit`, `npm run lint`.

---

## FASE 1 — Fundações (migration + parser de barcode)

### Task 1: Migration

**Files:** Create `supabase/migrations/20260611b_conferencia_embalagem.sql`

- [ ] **Step 1: Escrever migration**

```sql
-- Conferência de embalagem: barcode da etiqueta + auditoria embalador/conferente
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS etiqueta_barcodes text[],
  ADD COLUMN IF NOT EXISTS embalado_real_por uuid REFERENCES siso_usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS embalado_real_em timestamptz,
  ADD COLUMN IF NOT EXISTS conferido_por uuid REFERENCES siso_usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS conferido_em timestamptz,
  ADD COLUMN IF NOT EXISTS divergencia_tipo text
    CHECK (divergencia_tipo IN ('produto_errado','faltou_item','sobrou_item','quantidade_errada')),
  ADD COLUMN IF NOT EXISTS divergencia_obs text;

-- Lookup do bip: contains no array
CREATE INDEX IF NOT EXISTS idx_pedidos_etiqueta_barcodes
  ON siso_pedidos USING gin (etiqueta_barcodes)
  WHERE etiqueta_barcodes IS NOT NULL;

-- Métricas por embalador (relatório filtra por período)
CREATE INDEX IF NOT EXISTS idx_pedidos_embalado_real
  ON siso_pedidos (embalado_real_por, embalado_real_em)
  WHERE embalado_real_por IS NOT NULL;
```

Sem backfill de `etiqueta_barcodes`: o lookup tem fallback ILIKE no `etiqueta_zpl` que se auto-cura (Task 3).

- [ ] **Step 2: Aplicar no staging `ehbxpbeijofxtsbezwxd`** via `mcp__supabase__apply_migration` ou Management API (memória `project_migration_via_management_api`). Verificar: `SELECT column_name FROM information_schema.columns WHERE table_name='siso_pedidos' AND column_name LIKE '%conferido%';`

- [ ] **Step 3: Commit** `feat(wms): migration conferência de embalagem (etiqueta_barcodes + auditoria)`

---

### Task 2: Parser puro `extrairBarcodesDoZpl` (TDD)

**Files:** Create `src/lib/etiqueta-barcode.ts`, `src/lib/etiqueta-barcode.test.ts`

- [ ] **Step 1: Coletar fixtures REAIS do staging**

```sql
SELECT id, nome_ecommerce, etiqueta_zpl FROM siso_pedidos
WHERE etiqueta_zpl IS NOT NULL ORDER BY criado_em DESC LIMIT 6;
```

Pegar ≥1 ML e ≥1 Shopee. Inspecionar manualmente os comandos `^BC`/`^BQ`/`^B3` e seus `^FD`. Salvar trechos (anonimizados se necessário) como fixtures no teste. **Anotar no teste qual valor o leitor físico devolve** (o barcode de envio do ML normalmente é o shipment id; Shopee é o tracking number — confirmar nos fixtures).

- [ ] **Step 2: Teste falhando**

```ts
import { describe, it, expect } from "vitest";
import { extrairBarcodesDoZpl } from "./etiqueta-barcode";

describe("extrairBarcodesDoZpl", () => {
  it("extrai Code128 com troca de subset (>: etc) normalizada", () => {
    const zpl = "^XA^FO50,50^BCN,100,Y,N,N^FD>:4366231289>5012345678^FS^XZ";
    expect(extrairBarcodesDoZpl(zpl)).toContain("4366231289012345678");
  });
  it("extrai múltiplos barcodes (envio + DANFE) e dedup", () => { /* fixture real */ });
  it("extrai QR ^BQ removendo prefixo LA,/QA,/H,", () => { /* fixture real */ });
  it("ignora ^FD de texto (sem comando de barcode antes)", () => { /* ... */ });
  it("retorna [] pra ZPL sem barcode / null-ish", () => {
    expect(extrairBarcodesDoZpl("")).toEqual([]);
  });
});
```

- [ ] **Step 3: Implementar**

`extrairBarcodesDoZpl(zpl: string): string[]` — varre pares (comando de barcode `^B[CEQ3AOXU...]`) → próximo `^FD...^FS`; normaliza Code128 (`/>./g` strip), strip prefixo QR; trim; dedup; descarta vazios e strings <4 chars. Também exportar `salvarBarcodesEtiqueta(supabase, pedidoId, zpl)` — extrai e `UPDATE siso_pedidos SET etiqueta_barcodes = ...` (fire-and-forget safe, só loga warn em erro).

- [ ] **Step 4: Run** `npx vitest run src/lib/etiqueta-barcode.test.ts` → PASS · `npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit** `feat(wms): parser de barcodes do ZPL da etiqueta de envio`

---

### Task 3: Hooks de persistência + resolução do bip

**Files:** Modify `src/lib/agrupamento-service.ts` (~738), `src/lib/etiqueta-service.ts` (~433) · Create `src/lib/wms/conferencia.ts` + teste unit da parte pura

- [ ] **Step 1:** Nos 2 pontos onde `etiqueta_zpl` é persistido, chamar `salvarBarcodesEtiqueta` com o mesmo ZPL (no `agrupamento-service`, incluir `etiqueta_barcodes` no próprio `updateData` — evita roundtrip extra; no fallback do `etiqueta-service`, idem no update da linha 433).

- [ ] **Step 2:** `src/lib/wms/conferencia.ts` — `resolverPedidoPorBarcode(supabase, codigo)`:
  1. `etiqueta_barcodes @> ARRAY[codigo]` (`.contains()`)
  2. se 44 dígitos numéricos → `chave_acesso_nf = codigo`
  3. `id_pedido_ecommerce = codigo` (escopo: `status_separacao IN ('embalado','conferido')` pra não casar pedido antigo do mesmo comprador; se >1 hit → retorna ambíguo)
  4. fallback: `etiqueta_zpl ILIKE '%' || codigo || '%'` limitado a `status_separacao IN ('separado','embalado','conferido')` e `criado_em > now()-30d`; no hit, **self-heal**: `salvarBarcodesEtiqueta`
  Retorna `{ pedido, via } | { erro: 'nao_encontrado' | 'ambiguo' }`. Teste unit pra parte pura (ex: classificação 44 dígitos / normalização do código bipado — trim, sem case-fold em chave).

- [ ] **Step 3:** `npx tsc --noEmit` + `npm test` → PASS · **Commit** `feat(wms): persiste barcodes da etiqueta + resolver de bip`

---

## FASE 2 — Máquina de status

### Task 4: Status `conferido` no domínio

**Files:** Modify `src/types/index.ts:171,210` · `src/lib/historico-service.ts:44` · `src/lib/wms/cutover.ts:36` · `voltar-etapa/route.ts` · `expedir/route.ts`

- [ ] **Step 1:** `StatusSeparacao` += `"conferido"` · `SeparacaoCounts` += `conferido: number` · `EventoPedido` += `"embalagem_fisica_registrada" | "conferencia_ok" | "conferencia_divergencia"`.

- [ ] **Step 2:** `cutover.ts:36` → `FORWARD_STATES = ["separado","embalado","conferido","expedido"]` (comentar o porquê: `embalado→conferido` não pode reverter cutover).

- [ ] **Step 3:** `voltar-etapa/route.ts`: `STATUS_ORDER` += `"conferido"` (após `embalado`). Backward com `targetIdx <= embalado`: limpar `conferido_por/em`, `divergencia_tipo/obs`; `targetIdx <= separado` (já limpa embalagem): limpar também `embalado_real_por/em`. Forward com `targetIdx >= conferido`: setar `conferido_em=now`, `conferido_por=session.id`.

- [ ] **Step 4:** `expedir/route.ts:100-119`: validar `status_separacao IN ('embalado','conferido')` (mensagem de erro atualizada).

- [ ] **Step 5:** `npx tsc --noEmit` — vai apontar todos os switch/record exaustivos que precisam do novo status (consertar cada um; é o guia do sweep). `npm test` → PASS.

- [ ] **Step 6: Commit** `feat(wms): status conferido na máquina de separação`

---

### Task 5: Rotas de bip e divergência (TDD integration)

**Files:** Create `src/app/api/wms/separacao/conferencia/bipar/route.ts`, `conferencia/divergencia/route.ts` · Create `test/integration/conferencia-embalagem.integration.test.ts`

- [ ] **Step 1: Teste integration falhando** (padrão dos testes existentes em `test/integration/`; seed: pedido `embalado` com `etiqueta_zpl` fake contendo barcode conhecido, 2 usuários):
  - embalar: bip grava `embalado_real_por/em`, status segue `embalado`; re-bip mesmo user = idempotente; re-bip outro user = 200 com `aviso:'ja_embalado'` sem sobrescrever
  - conferir: bip → `status='conferido'` + `conferido_por/em`; mesmo user que embalou também pode conferir (auto-conferência permitida, D5); pedido já conferido → 200 `aviso:'ja_conferido'` (com quem/quando); pedido em `separado` → 422 `status_invalido`
  - resolução: bip por barcode do array, por chave NF 44 dígitos, fallback ILIKE com self-heal (assert `etiqueta_barcodes` preenchido depois)
  - divergência: grava tipo+obs, evento registrado; tipo inválido → 400
  - voltar-etapa `conferido→embalado` limpa conferência; expedir aceita `conferido`

- [ ] **Step 2: Implementar `POST /api/wms/separacao/conferencia/bipar`**

Body `{ codigo: string, modo: 'embalar' | 'conferir' }`. Guard: `getSessionUser` + `requireWarehouseAccess` (mesmo padrão das rotas de separação; conferente/embalador são operadores). Fluxo: `resolverPedidoPorBarcode` → valida status (`embalado` pros dois modos; `conferido` só pro aviso de já-conferido) →
- `embalar`: `UPDATE ... SET embalado_real_por, embalado_real_em WHERE id=? AND embalado_real_por IS NULL` (atômico); evento `embalagem_fisica_registrada`.
- `conferir`: `UPDATE ... SET status_separacao='conferido', conferido_por, conferido_em WHERE id=? AND status_separacao='embalado'` (claim atômico contra bip concorrente); evento `conferencia_ok`; chamar `dispararCutoverSePronto` (no-op se já rodou — coerência com voltar-etapa). Auto-conferência permitida (D5) — sem checagem de `embalado_real_por`.
Resposta: `{ pedido: {id, numero, nome_ecommerce, status_separacao, embalado_real_por_nome?, conferido_por_nome?}, itens: [{sku, descricao, quantidade_pedida, imagem_url?}], via, aviso? }` (itens via mesmo join do checklist — `siso_pedido_itens` é fonte; resolver imagem como `checklist-items` faz).

- [ ] **Step 3: Implementar `POST /api/wms/separacao/conferencia/divergencia`**

Body `{ pedido_id, tipo, observacao? }`. Valida `status_separacao='conferido'` e tipo no CHECK. `UPDATE divergencia_tipo/obs` + evento `conferencia_divergencia` `{tipo, observacao, embalado_real_por}`. Idempotente (re-clique sobrescreve).

- [ ] **Step 4:** Rodar integration (staging livre): `npm run test:integration -- conferencia-embalagem` → PASS · `npx tsc --noEmit` + `npm run lint` → PASS

- [ ] **Step 5: Commit** `feat(wms): rotas de conferência de embalagem (bipar + divergência)`

---

## FASE 3 — Frontend

### Task 6: Page `/wms/separacao/conferencia`

**Files:** Create `src/app/wms/separacao/conferencia/page.tsx` · Modify `src/components/wms/wms-shell.tsx` (item na sidebar, grupo Separação, mesmas perms da embalagem)

- [ ] **Step 1:** Page "use client", copiar o padrão de scan da embalagem (`embalagem/page.tsx:200-210`: input autofocus permanente + keydown redirect). Toggle **Embalar / Conferir** (persistir em localStorage; default Conferir). Ao bipar:
  - card grande do pedido: número, marketplace, badge "embalado por {nome}"; itens com foto, SKU, descrição, qty (layout dos itens da embalagem)
  - feedback visual forte: verde (ok), amarelo (`ja_embalado`/`ja_conferido`), vermelho (erro/`nao_encontrado`/`status_invalido`) + som/toast (Sonner)
  - **botão "Divergência"** no card do ÚLTIMO pedido conferido → mini-modal: 4 chips de tipo + obs opcional + confirmar
  - lista da sessão (últimos ~20 bipes com hora/resultado) — some no reload, sem persistência
- [ ] **Step 2:** Verificação manual: `npm run dev`, bipar (digitar+Enter simula scanner) um pedido `embalado` de staging nos 2 modos; testar divergência e auto-conferência (mesmo usuário embala e confere — deve passar).
- [ ] **Step 3:** `npx tsc --noEmit` + `npm run lint` → PASS · **Commit** `feat(wms): page de conferência de embalagem`

---

### Task 7: Sweep de visibilidade do status novo

**Files:** grep-driven — `grep -rn '"embalado"' src/ | grep -v test`

- [ ] **Step 1:** Cada hit que lista/filtra/conta status decide: precisa enxergar `conferido`? Mínimo obrigatório:
  - `GET /api/wms/separacao` (counts + filtro) → contar `conferido`
  - page `/wms/separacao` (tabs/badges de status) → tab `conferido`
  - page de expedição (lista embalados pra expedir) → incluir `conferido` + badge "✓ conferido" vs "não conferido"
  - `quadro-tarefas.tsx` (pipeline home) → estágio `conferido`
  - `StatusBadge`/formatters em `wms-ui.tsx` → label/cor pra `conferido`
  - timeline de histórico (mapa evento→label) → 3 eventos novos
  - dashboards/insights queries que enumeram status (`dashboard-{geral,tarefas}.ts`, `insights/queries.ts`) → revisar um a um; onde "embalado" significa "pronto pra expedir", incluir `conferido`
- [ ] **Step 2:** `npx tsc --noEmit` + `npm test` → PASS · **Commit** `feat(wms): status conferido visível em painéis, expedição e home`

---

## FASE 4 — Métricas

### Task 8: Relatório de conferência

**Files:** Create `src/app/api/wms/relatorios/conferencia/route.ts`, `src/app/wms/relatorios/conferencia/page.tsx`

- [ ] **Step 1:** `GET /api/wms/relatorios/conferencia?de=&ate=&galpao_id=` (guard: padrão das rotas de `relatorios/` existentes; checar `userCan` usado em `saldos-por-empresa`). Agregação sobre `siso_pedidos` no período (`embalado_real_em`/`conferido_em`):
  - **por embalador:** pacotes embalados (`embalado_real_por`), conferidos (`conferido_em IS NOT NULL`), % conferido, divergências (`divergencia_tipo IS NOT NULL`), **taxa de acerto** = 1 − divergências/conferidos, breakdown por `divergencia_tipo`
  - **por conferente:** total conferido, divergências encontradas
  - **gerais:** % dos pacotes expedidos que foram conferidos; % com embalador rastreado
- [ ] **Step 2:** Page: filtro de período (presets 7/30 dias), 2 tabelas (embalador/conferente) + cards de totais. Sidebar: grupo Relatórios.
- [ ] **Step 3:** Verificação manual com dados gerados no Task 6 · `npx tsc --noEmit` + `npm run lint` → PASS
- [ ] **Step 4: Commit** `feat(wms): relatório de conferência de embalagem`

---

## FASE 5 — Docs (mesmo PR)

### Task 9: Documentação

- [ ] `docs/database-schema.md`: colunas novas + linha no migration log (20260611b)
- [ ] `docs/api-reference-complete.md`: 3 rotas novas + mudança do `expedir` e `voltar-etapa`
- [ ] `docs/architecture-and-flows.md` + `docs/fluxos-siso.md`: pipeline com `conferido`
- [ ] `CLAUDE.md`: linha do StatusSeparacao/ordem canônica (`...separado → embalado → conferido → expedido`) + contagem de rotas se citada
- [ ] **Commit** `docs: conferência de embalagem`

---

## Riscos & edge cases cobertos

| Caso | Tratamento |
|---|---|
| Etiqueta reimpressa / re-bip | mesmo barcode → idempotente (claims atômicos com WHERE) |
| Barcode não casa (ZPL antigo sem `etiqueta_barcodes`) | fallback ILIKE + self-heal |
| Código bipado casa 2 pedidos | resposta `ambiguo` — UI manda usar outro código da etiqueta (ex: chave NF) |
| Bip de pedido ainda não embalado (checklist aberto) | 422 `status_invalido` com status atual na mensagem |
| Conferente = embalador | permitido (D5) — registro fica igual: `embalado_real_por` e `conferido_por` apontam pro mesmo usuário |
| Pedido sem `embalado_real_por` conferido | permitido (adoção gradual); relatório mostra % rastreado |
| `embalado→conferido` revertendo cutover | impedido — `conferido` entra em `FORWARD_STATES` (Task 4 Step 2) |
| Dois conferentes bipam simultâneo | claim atômico `WHERE status='embalado'` — 2º recebe `ja_conferido` |
