# Compras Item-Cêntrico — Fase 1 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## ▶ STATUS (2026-06-18) — CONTINUAR DAQUI
> **Backend da Fase 1 COMPLETO e verde — Tasks 1.1–1.6 ✅.** Falta **1.7 (UI)** + **1.8 (docs)**.
> - **Feito:** puras `compras-sourcing.ts` (necessidade por galpão); `wms/fornecedores-sku.ts` (fornecedor do cadastro + fallback prefix); `compras/route.ts` `fetchComprar` neta em-trânsito **por galpão** + anexa `fornecedores`/`fornecedor_escolhido` por SKU; `compras-oc.ts` (`findOrCreateOcAberta` race-safe, usado por `comprar` + `validar-oc-item`); **migration `uq_oc_aberta_fornecedor_empresa` JÁ APLICADA** no staging `ehbxpbeijofxtsbezwxd`; rota `compras/redestinar` (G2); pegging `pedidos_cobertos` na aba Receber (`OcDoc`/`ReceberDoc`/`mergeReceberDocs`/`fetchReceberDocs`).
> - **Gaps fechados:** G1, G2, G3, G6, G10. **Decisão O-G4:** SEM MOQ/caixa — sugestão pura, comprador digita a qtd.
> - **Verde:** 18 testes novos passam (`npm test`). `tsc --noEmit` só com **3 erros PRÉ-EXISTENTES** (testes `realoc-fix-pack` exige DB staging + `validar-oc-item` já `M` antes da sessão — NÃO são meus). App segue funcionando (mudanças na API são aditivas).
> - **PRÓXIMO → Task 1.7:** reescrever `src/app/wms/compras/page.tsx` pra lista item-cêntrica (1 linha por SKU, dropdown fornecedor, "Quanto comprar" editável, galpão destino inline→`redestinar`, expandir pedidos, chip "destrava N pedidos"). Espelhar o protótipo APROVADO `docs/superpowers/specs/2026-06-18-compras-telas-prototipo.html`. Verificar com prints (servir via `http.server`, `file://` bloqueado no Playwright). Depois **1.8** (docs: api-reference, database-schema, erros-conhecidos, CLAUDE.md).
> - **Contexto/decisões:** `docs/estudo-redesenho-compras-transferencias.md` (§7 decisões travadas). **Trabalho EM STAGING, TDD (teste→falha→passa).**

**Goal:** Tornar a lista de compras **item-cêntrica de verdade** — 1 linha por SKU, com **fornecedor escolhível por linha lendo `siso_produto_fornecedores`** (preço/lead, multi-fornecedor, com fallback no prefix map), **quantidade sugerida = necessidade líquida pura, editável pelo comprador** (ele digita quantas unidades vai comprar; SEM caixa/mínimo/múltiplo), **em-trânsito netado por galpão**, criação de OC consolidada por (fornecedor, galpão) via **um helper único race-safe**, **destino editável até a mercadoria chegar**, e **pegging visível** (quais pedidos cada OC destrava).

**Estudo de base:** `docs/estudo-redesenho-compras-transferencias.md` (decisões travadas 2026-06-18). Esta é a Fase 1 (compras). Fase 2 = transferências+ruptura. Fase 3 = reposição proativa.

**Architecture:** Toda regra de negócio nova vive em funções **PURAS** testáveis (`compras-sourcing.ts`) + um service de leitura (`fornecedores-sku.ts`) + um helper único de OC (`compras-oc.ts`). A rota `compras/route.ts` (`fetchComprar`) passa a: (a) netar em-trânsito **por galpão** chamando a pura, (b) anexar opções de fornecedor por SKU, (c) sugerir a necessidade líquida pura — o comprador digita a quantidade final na tela (já suportado pelo fluxo de comprar via `quantidade_comprada`). A criação de OC é extraída dos 2 callers duplicados (`comprar`, `validar-oc-item`) pra um helper compartilhado race-safe + migration que fecha o buraco do índice único (galpão null). Nova rota `redestinar` re-aponta `separacao_galpao_id` + `OC.galpao_id` atômico (o reconciliador já casa por `separacao_galpao_id`). UI vira lista plana por SKU com dropdown de fornecedor + destino inline.

**Tech Stack:** Next.js 16 App Router (route handlers), TypeScript strict, Supabase (service client), Vitest (unit, happy-dom), React 19 + React Query (tela).

**Decisões do Eryk (2026-06-18):**
1. **1 linha por SKU**, expansível pros pedidos atrás (não por fornecedor).
2. Pedido multi-item sem 1 galpão cobrindo 100% → **mantém como hoje** (vira OC). Nada de auto-consolidar/split nesta fase.
3. Fornecedor/preço/lead vêm de `siso_produto_fornecedores`; prefix map (`sku-fornecedor.ts`) vira **fallback** quando não há cadastro.
4. Destino do recebimento **editável a qualquer momento até a mercadoria chegar**.
5. **Comprador digita quantas unidades vai comprar** — a sugestão (necessidade líquida) vem preenchida e editável. **Sem** caixa/mínimo/múltiplo (decisão 2026-06-18; G4 fica fora — não aplicar arredondamento).

---

## Contexto verificado (NÃO re-investigar — confirmado por scouts + leitura direta 2026-06-18)

- **`fetchComprar`** `src/app/api/wms/compras/route.ts:337-484`; helper `carregarContextoNecessidade:247-335`. `em_transito` hoje é **somado global por SKU** (`:264-282`) — bug G3. `estoqueLivre` lê `siso_estoque.disponivel` ao vivo por sku (`:284-309`). `galpao_sugerido_id` por fornecedor vem do **prefix map** `getFornecedorBySku(sku).filialOC` (`:460-463`) — G1. Necessidade final `:436-456` usa `calcularNecessidadeLiquida` (escalar).
- **Pura existente:** `src/lib/compras-necessidade.ts` `calcularNecessidadeLiquida({demandaAberta, estoqueLivre, emTransito}) = max(0, …)`. **Não aplica MOQ/múltiplo** (G4). Manter; adicionar peças novas ao lado.
- **`siso_produto_fornecedores`** (`src/lib/wms/fornecedores.ts:17-32`): campos `lead_time_dias_medio:number`, `custo_unitario:number|null`, `qty_minima_pedido:number`, `multiplo_compra:number`, `preferencial:boolean`, `ativo:boolean`, `codigo_fornecedor`. Já existe `listarProdutoFornecedores(produtoId)` (`:68-80`, join `fornecedor:siso_fornecedores(*)`, `order preferencial desc`) e `getFornecedorPreferencial` (`:277`). **Chave de junção: `sku` → `siso_produtos.id` (UNIQUE) → `produto_fornecedores.produto_id`.** (mesmo truque do necessidade-viva, evita o legado tiny_produto_id).
- **Prefix map (fallback):** `src/lib/sku-fornecedor.ts` `getFornecedorBySku(sku) → {fornecedor, filialOC}` (filialOC = NOME de galpão "CWB"/"SP", não id).
- **OC criada em 2 lugares (G6):** `comprar/route.ts:401-454` (`findOrCreateOC`, race-safe via 23505 re-select) e `validar-oc-item/route.ts:1234-1283` (galpão do **deprecado** `siso_empresas.galpao_id`, **sem** 23505). Índice único `uq_oc_aberta_fornecedor_galpao` (`20260611p_oc_unique_aberta.sql:64`) é **parcial**: `WHERE status='aguardando_compra' AND galpao_id IS NOT NULL` → OC com galpão null **desprotegida**.
- **`comprar/route.ts` já re-aponta** `separacao_galpao_id` pro galpão escolhido, mas só pra status `['aguardando_compra','validacao_oc','comprado']` (`:300-334`) e só no ato da compra (G2 = não dá pra trocar depois).
- **Reconciliador (pegging):** `src/lib/wms/reconciliador-oc.ts:93-101` casa entrada↔item por `(sku, siso_pedidos.separacao_galpao_id = galpaoId, status_separacao ∈ {validacao_oc,aguardando_compra,em_separacao}, compra_status ∈ {oc_pendente,aguardando_compra})`, FIFO por `criado_em`. **Logo: re-apontar `separacao_galpao_id` basta pra entrada pegar no galpão novo.**
- **OC**: `siso_ordens_compra` (`galpao_id` desde `20260319_oc_galpao_recebimento.sql`; status `aguardando_compra→comprado→…`). Link OC↔itens = `siso_pedido_itens.ordem_compra_id` (sem tabela de linha). `cancelOcIfEmpty` em `compras-utils.ts:207`.
- **Tela:** `src/app/wms/compras/page.tsx` — agrupa por fornecedor hoje (`fornecedores.map :871`); `ComprarItem` (`:53`); modal "Confirmar compra" com `<select> galpão destino` por item (`:1162-1278`, default = sugerido `:745`); `galpoesQuery` (`:343`).
- **Permissões:** `compras.ver` (`permissions.ts:24`), `compras.executar` (`:25`).
- **Teste:** Vitest, `import { describe, it, expect } from "vitest";`, `*.test.ts` ao lado do source, asserts em PT. Rodar: `npm test -- <nome>`. Route-handler tests mockam o supabase client.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/lib/compras-sourcing.ts` | Pura: `calcularNecessidadeSkuPorGalpao` (em-trânsito por galpão) | **Criar** |
| `src/lib/compras-sourcing.test.ts` | Unit das puras | **Criar** |
| `src/lib/wms/fornecedores-sku.ts` | `listarFornecedoresPorSkus(skus)` — PF por SKU + fallback prefix | **Criar** |
| `src/lib/wms/fornecedores-sku.test.ts` | Unit (supabase mockado) | **Criar** |
| `src/lib/compras-oc.ts` | `findOrCreateOcAberta` único race-safe | **Criar** |
| `src/lib/compras-oc.test.ts` | Unit (found/insert/23505) | **Criar** |
| `src/app/api/wms/compras/route.ts` | `fetchComprar`: em-trânsito por galpão + fornecedores + MOQ | **Modificar** |
| `src/app/api/wms/compras/comprar/route.ts` | usar `findOrCreateOcAberta` (remover dup) | **Modificar** |
| `src/app/api/wms/separacao/validar-oc-item/route.ts` | usar `findOrCreateOcAberta` (race-safe) | **Modificar** |
| `src/app/api/wms/compras/redestinar/route.ts` | POST re-aponta destino do pedido + OC | **Criar** |
| `src/app/api/wms/compras/redestinar/route.test.ts` | Route-handler test | **Criar** |
| `supabase/migrations/20260618_oc_unique_aberta_empresa_null.sql` | índice único 2 (galpão null) | **Criar** |
| `src/app/wms/compras/page.tsx` | lista por SKU + dropdown fornecedor + destino inline + expand pedidos | **Modificar** |
| `docs/api-reference-complete.md` · `docs/database-schema.md` | shape compras GET + redestinar + índice | **Modificar** |

---

### Task 1.1: Pura `calcularNecessidadeSkuPorGalpao` (em-trânsito por galpão)

**Files:** Create `src/lib/compras-sourcing.ts` + `src/lib/compras-sourcing.test.ts`

Uma regra pura: netar demanda/livre/trânsito **por galpão** e somar (G3 — OC chegando em CWB não pode reduzir a necessidade de SP). **Sem MOQ/múltiplo** (decisão: a sugestão é a necessidade pura; o comprador digita a quantidade final na tela).

- [x] **Step 1: teste que falha** — `compras-sourcing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { calcularNecessidadeSkuPorGalpao } from "./compras-sourcing";

describe("calcularNecessidadeSkuPorGalpao", () => {
  it("neta por galpão e SOMA: CWB precisa 3 (0 livre, 0 trânsito), SP precisa 1 → 4", () => {
    const r = calcularNecessidadeSkuPorGalpao([
      { galpaoId: "cwb", demanda: 3, livre: 0, transito: 0 },
      { galpaoId: "sp", demanda: 1, livre: 0, transito: 0 },
    ]);
    expect(r.total).toBe(4);
  });
  it("OC de 3 chegando em CWB cobre CWB; SP segue precisando 1 → total 1 (NÃO zera SP)", () => {
    const r = calcularNecessidadeSkuPorGalpao([
      { galpaoId: "cwb", demanda: 3, livre: 0, transito: 3 },
      { galpaoId: "sp", demanda: 1, livre: 0, transito: 0 },
    ]);
    expect(r.total).toBe(1);
    expect(r.porGalpao).toContainEqual({ galpaoId: "cwb", necessidade: 0 });
    expect(r.porGalpao).toContainEqual({ galpaoId: "sp", necessidade: 1 });
  });
  it("excesso num galpão não compensa falta em outro (clamp por galpão)", () => {
    const r = calcularNecessidadeSkuPorGalpao([
      { galpaoId: "cwb", demanda: 1, livre: 5, transito: 0 }, // sobra 4, clampa 0
      { galpaoId: "sp", demanda: 3, livre: 0, transito: 0 },
    ]);
    expect(r.total).toBe(3);
  });
});
```

- [x] **Step 2: rodar e confirmar FAIL** — `npm test -- compras-sourcing` → "Failed to resolve import". ✓
- [x] **Step 3: implementar** — `compras-sourcing.ts`. `calcularNecessidadeSkuPorGalpao(rows)`: reusa `calcularNecessidadeLiquida` por galpão; retorna `{ total, porGalpao:[{galpaoId, necessidade}] }`. ✓
- [x] **Step 4: rodar e confirmar PASS** — 5/5 passam, lint limpo. ✓

---

### Task 1.2: Service `listarFornecedoresPorSkus(skus)`

**Files:** Create `src/lib/wms/fornecedores-sku.ts` + `.test.ts`

Resolve, por SKU, as opções de fornecedor do cadastro (`siso_produto_fornecedores`), com **fallback** no prefix map quando não há vínculo. Mata G1.

- [x] **Step 1: teste que falha** (supabase mockado — seguir o padrão de mock dos route-handler tests do repo). Casos:
  - SKU com 2 vínculos PF → retorna os 2, **preferencial primeiro**, com `{fornecedorId, nome, custo_unitario, lead_time_dias_medio, qty_minima_pedido, multiplo_compra, preferencial}` e `origem:"cadastro"`.
  - SKU sem PF → `origem:"prefixo"`, 1 opção do `getFornecedorBySku` (nome + galpão sugerido), `qty_minima_pedido:1, multiplo_compra:1`.
  - SKU inexistente em `siso_produtos` → cai no prefixo também (não quebra).

```ts
// esboço dos asserts-chave
const m = await listarFornecedoresPorSkus(["FILTRO-X", "SEM-CADASTRO"]);
expect(m.get("FILTRO-X")!.origem).toBe("cadastro");
expect(m.get("FILTRO-X")!.opcoes[0].preferencial).toBe(true);
expect(m.get("SEM-CADASTRO")!.origem).toBe("prefixo");
expect(m.get("SEM-CADASTRO")!.opcoes[0].multiplo_compra).toBe(1);
```

- [x] **Step 2: FAIL** — `npm test -- fornecedores-sku`. ✓
- [x] **Step 3: implementar** — `src/lib/wms/fornecedores-sku.ts`: `siso_produtos.in(sku)` → mapa sku→id; `siso_produto_fornecedores...in(produto_id).eq(ativo).order(preferencial desc)` → agrupa por sku; sku sem linha → `getFornecedorBySku`. Retorna `Map<sku,{origem,opcoes}>`. ✓
- [x] **Step 4: PASS** — 3/3 passam, lint limpo. ✓

---

### Task 1.3: `fetchComprar` usa em-trânsito por galpão + fornecedores

**Files:** Modify `src/app/api/wms/compras/route.ts`

Wire das Tasks 1.1/1.2 na listagem. Mantém 1 linha por SKU (decisão O1) mas com números corretos.

- [x] **Step 1: cobertura do G3** — o cenário "OC chegando em CWB NÃO zera SP" está testado na pura `compras-sourcing.test.ts` (Task 1.1). O wiring da rota é verificado por `tsc --noEmit` + eslint (opção A incremental; sem teste de rota dedicado). ✓
- [x] ~~Step 2: FAIL~~ — n/a (sem teste de rota novo; a pura já estava verde).
- [x] **Step 3: implementar** — `carregarContextoNecessidade` agora acumula em `ContextoSku.porGalpao` (`{demandaComprado,livre,transito}` por galpão, via `siso_pedidos.separacao_galpao_id` + `siso_estoque.galpao_id`) + `estoqueLivreTotal` p/ cobertura. `fetchComprar` neta por galpão com `calcularNecessidadeSkuPorGalpao` e anexa `fornecedores`/`fornecedor_escolhido` por SKU (de 1.2). `SEM_GALPAO` cobre destino nulo. ✓
- [x] **Step 4: PASS** — `compras/route.ts` typecheck limpo + eslint limpo; suíte unit verde exceto 6 falhas PRÉ-EXISTENTES (`validar-oc-item` já `M` antes da sessão; `realoc-fix-pack` exige DB staging) — nenhuma importa o código novo. ✓

> Nota: a resposta do GET muda de shape (linha agora carrega `fornecedores[]`, `fornecedor_escolhido`, `quantidade_necessaria` = sugestão pura editável, e `por_galpao[]` pra expandir). Atualizar `docs/api-reference-complete.md` (Task 1.8).

---

### Task 1.4: Helper único de OC race-safe + migration do índice

**Files:** Create `src/lib/compras-oc.ts` + `.test.ts`; Modify `comprar/route.ts`, `validar-oc-item/route.ts`; Create migration.

- [x] **Step 1: migration** `supabase/migrations/20260618_oc_unique_aberta_empresa_null.sql` — APLICADA no staging `ehbxpbeijofxtsbezwxd` (dup-check 0 antes; `uq_oc_aberta_fornecedor_empresa` confirmado em pg_indexes). ✓
```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_oc_aberta_fornecedor_empresa
  ON siso_ordens_compra (fornecedor, empresa_id)
  WHERE status = 'aguardando_compra' AND galpao_id IS NULL;
```
Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (staging).
- [x] **Step 2/3: teste que falha** — `compras-oc.test.ts` (4 casos: existe / cria / corrida 23505 / fornecedor vazio). FAIL confirmado (módulo ausente). ✓
- [x] **Step 4: implementar** — `src/lib/compras-oc.ts` `findOrCreateOcAberta(sb, {fornecedor, galpaoId, empresaId, observacao?})`, com branch 23505 race-safe. ✓
- [x] **Step 5: refatorar callers** — `comprar/route.ts` removeu o `findOrCreateOC` local e usa o helper; `validar-oc-item/route.ts` idem (ganha race-safety). ⚠ Galpão do validar-oc-item ficou como estava (`siso_empresas.galpao_id`) — fix p/ `separacao_galpao_id` é **follow-up** (arquivo já `M`+teste falhando pré-sessão; evitei entrelaçar). ✓
- [x] **Step 6: PASS** — compras-oc 4/4; `tsc --noEmit` 0 erros nos meus arquivos; eslint limpo; suíte sem NOVA falha (mesmas 6 pré-existentes). ✓

---

### Task 1.5: Rota `redestinar` — destino editável até receber (G2)

**Files:** Create `src/app/api/wms/compras/redestinar/route.ts` + `.test.ts`

`POST /api/wms/compras/redestinar` body `{ pedido_ids: string[], galpao_id: string }`, perm `compras.executar`. Re-aponta o(s) pedido(s) e move a(s) OC(s) pro galpão novo, atômico por pedido.

- [x] **Step 1/2: teste que falha** (route-handler, supabase mockado) — 4 casos: status redestinável re-aponta; status `separado` pulado; já-no-galpão pulado; body inválido 400. FAIL confirmado (rota ausente). ✓
- [x] **Step 3: implementar** — `src/app/api/wms/compras/redestinar/route.ts` (perm `compras.executar`): guard `STATUS_REDESTINAVEL`, re-aponta `separacao_galpao_id`, move OCs dos itens comprados via `findOrCreateOcAberta` + `cancelOcIfEmpty`. NÃO mexe em reservas. Retorna `{ ok, redestinados, pulados }`. ✓
- [x] **Step 4: PASS** — 4/4; tsc + eslint limpos. ⚠ Teste cobre o gating + re-aponta (núcleo do G2); o move-de-OC é verificado por typecheck + cenário E2E manual (comprar CWB → redestinar SP → entrada SP destrava em SP). ✓

---

### Task 1.6: Pegging visível (G10)

**Files:** Modify a rota de detalhe de OC (`compras/ordens/route.ts` e/ou `receber/oc/[id]/route.ts`)

- [x] **Step 1/2: teste que falha** — estendi `compras-receber-merge.test.ts` (route): doc de OC carrega `pedidos_cobertos:[{pedido_id,numero}]`, manual vem `[]`. FAIL confirmado. ✓
- [x] **Step 3/4: implementar + PASS** — `OcDoc`/`ReceberDoc` ganharam `pedidos_cobertos`; `fetchReceberDocs` coleta `ocId→pedido_id→numero` (via `siso_pedido_itens.pedido_id + siso_pedidos(numero)`); `mergeReceberDocs` propaga (manual `[]`). 4/4 verde, tsc + lint limpos. (Optei pela LISTA, não pelo detalhe — chip sem clique, como no protótipo.) ✓
- [ ] **Step 5 (UI):** chip "destrava N pedidos" no card — vai junto na Task 1.7.

---

### Task 1.7: UI lista item-cêntrica (manual verify)

**Files:** Modify `src/app/wms/compras/page.tsx`

Decisão O1: **1 linha por SKU** (hoje agrupa por fornecedor `:871`). Mudanças:
- Lista plana por SKU: SKU+desc+imagem, **campo "Quanto comprar" editável** (vem preenchido com a sugestão = necessidade líquida pura; comprador digita a quantidade final; SEM caixa/mínimo/múltiplo), **dropdown Fornecedor** (opções de 1.2, preferencial pré-selecionado, mostra preço/lead), **Galpão destino** inline (editável → chama 1.5 quando o item já tem OC; senão só seta a escolha pro "Gerar OC"), chip de urgência (giro/cobertura), chip "N pedidos · mais antigo Xd". Protótipo aprovado: `docs/superpowers/specs/2026-06-18-compras-telas-prototipo.html`.
- **Expandir a linha** → lista os pedidos atrás (numero + galpão atual + qtd) — o pegging de 1.6.
- Botão **"Gerar OC"** nas linhas marcadas → consolida por (fornecedor, galpão) via `comprar` (que já usa o helper de 1.4).
- Tratar estado degradado: se `galpoesQuery`/fornecedores falham, desabilitar com mensagem (não travar silencioso) — espelhar `:1170`.

- [ ] **Verificação (preferência do Eryk):** servir via `npm run dev`, abrir `/wms/compras`, tirar prints do fluxo (lista → escolher fornecedor → trocar destino → gerar OC → redestinar depois) e validar com o Eryk. (Playwright: `http.server`, não `file://`.)

---

### Task 1.8: Docs + erros-conhecidos

- [ ] `docs/api-reference-complete.md`: novo shape de `GET /api/wms/compras?tab=comprar` (fornecedores[]/por_galpao[]/qtd arredondada) + `POST /api/wms/compras/redestinar`.
- [ ] `docs/database-schema.md`: novo índice `uq_oc_aberta_fornecedor_empresa`.
- [ ] `erros-conhecidos.yaml`: 1 entrada por bug corrigido (G3 em-trânsito global; G6 OC duplicada/índice parcial) — `id,date,source,category,message,cause,fix,files,tags`.
- [ ] Atualizar a seção "Estrutura do Projeto" do `CLAUDE.md` com os 3 libs novos (`compras-sourcing`, `fornecedores-sku`, `compras-oc`).

---

## Critérios de aceite da Fase 1 (todos verdes = fase fechada)

1. SKU com 2 fornecedores cadastrados mostra os 2 (preferencial primeiro) com preço/lead/MOQ; sem cadastro cai no prefix map. *(1.2)*
2. OC chegando em CWB **não** reduz a necessidade de SP. *(1.1/1.3)*
3. Sugestão = necessidade líquida pura; o comprador edita a quantidade antes de gerar a compra (sem arredondar por caixa/mínimo). *(1.3 / UI)*
4. 2 requests concorrentes (mesmo fornecedor+galpão) = 1 OC; índice cobre galpão null. *(1.4)*
5. Trocar destino re-aponta `separacao_galpao_id` + move a OC; entrada destrava no galpão novo. *(1.5)*
6. OC mostra os pedidos que cobre. *(1.6)*

Tudo TDD (teste-que-reproduz → passa), em **staging** (`ehbxpbeijofxtsbezwxd`). Nada toca prod.
