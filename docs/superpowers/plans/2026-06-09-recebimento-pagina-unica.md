# Recebimento Página Única Rica — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir a Fase C do refactor anterior: recebimento de OC/manual/transferência deve ser a **exata mesma página do receber avulso** (loc por item + sugestão putaway, plano de guarda, etiquetas, anúncio, entrada direta), com infos pré-preenchidas — e criação de compra vira **página** (`/wms/compras/nova`), matando o modal.

**Decisões do Eryk (2026-06-09):**
1. OC: igual avulso, mas cada linha mostra **quanto era pra vir** (esperado) e o operador digita **quanto realmente veio**. Estoque entra na loc que ele escolher (entrada direta) ou dock+pendência com destino planejado (igual avulso).
2. Pode **adicionar linha extra** na tela da OC (item que veio na caixa sem estar na OC) — entra como entrada avulsa no mesmo lote, sem vincular à OC.

**Architecture:** Estende os 2 backends que hoje cravam a loc RECEBIMENTO (`receberItensViaOC`, `receberCompraManual`) pra aceitar `localizacao_destino_id` por item + `entrada_direta` — espelhando a semântica EXISTENTE de `receberEstoque` (`movimentacoes.ts:109-201`: direta → E na loc do item, sem pendência; dock → E em RECEBIMENTO + pendência com `localizacao_destino_id` planejado). Transferência já entra direto na loc (`transferencias.ts:361-373`) — só UI. O componente `<ReceberLote>` ganha: lock de produto POR LINHA (`backendItemId != null`), display do esperado, `produtoWmsId` pra sugestão em linhas pré-definidas, `confirmLabel`, `guardaTogglesVisible`. Itens extras saem num **segundo POST** pro `/api/wms/receber` com `origem_tipo='ajuste_manual'` (não contamina custo médio — mesmo racional do "achado" de excedente em `receber-oc.ts:189-191`). Criação de compra reusa o próprio `<ReceberLote>` com config de compra.

**Tech Stack:** igual ao repo (Next 16, React 19, TS strict, React Query, vitest happy-dom).

**Fatos verificados (NÃO re-derivar):**
- `receberEstoque` (`movimentacoes.ts:94-248`): `entrada_direta=true` → valida loc em TODOS (113-117), E direto na loc (125), `pendencia_ids: []`. `false` → E em RECEBIMENTO (177), pendência com `localizacao_destino_id: item.localizacao_destino_id ?? null` (201).
- `receberItensViaOC` (`receber-oc.ts:45-435`): E sempre em `locRecebId` (163); cross-dock via `detectarCrossDock` (224-245) cria pendCross com `destino_sugerido_id`; excedente vira mov `ajuste_manual` "achado" SEM custo (189-191); optimistic lock em `compra_quantidade_recebida` (288-297); rollback completo (376-382).
- `receberCompraManual` (`compras-manuais.ts:367-494`): E em RECEBIMENTO (290), pendência sem destino (313-322).
- `receberTransferencia` (`transferencias.ts:261-407`): E direto na `localizacao_destino_id` (365). SEM pendência.
- Sugestão putaway: `GET /api/wms/receber?produto_id=<uuid WMS>&galpao_id=` (route.ts:145-184). NÃO aceita sku.
- `GET /api/wms/receber/oc/[id]`: `itens[].produto_id` é **tiny_produto_id** (gotcha #1). `oc.fornecedor` é STRING.
- `POST /api/wms/receber` exige `fornecedor_id` sempre (route:39) e `empresa_compradora_id` só se `origem_tipo==='nf_compra'` (route:46). Aceita `origem_tipo` no body (default nf_compra).
- Componente: putaway query usa `it.produto!.id` (receber-lote.tsx:177); lock por `config.productEditable` (745); botão `Confirmar lote (${n})` (630); chips só quando `!leftFormVisible` (352-386); qtyEsperada só gateia divergência (706), não é exibida.
- `NovaCompraManualModal`: galpão/empresa/fornecedor (+criar fornecedor inline via `POST /api/wms/compras-manuais/fornecedor`)/obs/itens(ProdutoCombo,qty,custo opcional) → `POST /api/wms/compras-manuais`. Botão em `compras/page.tsx:238`.
- `POST /api/wms/compras-manuais` body: `{fornecedor_id, empresa_compradora_id, galpao_id, observacao?, itens:[{produto_id (uuid WMS), qty_comprada>0, custo_unitario?}]}` → `{ok, compra_id, itens_criados}`.
- Permissão OC: rotas GET/POST oc/[id] usam `userCanAny("operacoes.receber","compras.executar")` (commit ae1ea34).

**Convenções de teste:** ver bloco "Convenções de teste deste repo" no plano `2026-06-09-refactor-compras-recebimento.md` (mesmo repo, mesmas regras: unit mocka tudo; route-handler test ao lado da rota; asserts PT).

---

### Task D1: Adapters v2 (loc/entrada/qty0/extras) + `buildCompraPayload`

**Files:**
- Modify: `src/components/wms/recebimento/receber-lote-adapters.ts`
- Modify: `src/components/wms/recebimento/receber-lote-adapters.test.ts`
- Modify: `src/components/wms/recebimento/receber-lote-types.ts` (campo `produtoWmsId`)

- [ ] **Step 1: Tipos** — em `receber-lote-types.ts`, adicionar a `ReceberLoteItem`:
```typescript
  /** uuid WMS do produto pra sugestão de putaway em linhas pré-definidas (OC/manual/transf) */
  produtoWmsId: string | null;
```
(Todos os construtores de item nos wrappers e em `emptyReceberLoteItem` no componente ganham `produtoWmsId: null` — o componente é Task D5; aqui só o tipo + ajustar o factory `item()` do teste de adapters.)

- [ ] **Step 2: Testes novos (falhando)** — em `receber-lote-adapters.test.ts`, atualizar o factory `item()` com `produtoWmsId: null` e adicionar:
```typescript
describe("buildOcPayload v2", () => {
  it("filtra qty<=0 (item da OC que não veio) e inclui loc por item", () => {
    const p = buildOcPayload(
      [
        item({ backendItemId: "i1", qty: "3", qtyEsperada: 5, locIdOverride: "loc1" }),
        item({ backendItemId: "i2", qty: "0", qtyEsperada: 2 }),
      ],
      { entradaDireta: true, nfReferencia: "NF-123" },
    );
    expect(p.itens).toHaveLength(1);
    expect(p.itens[0]).toEqual(
      expect.objectContaining({ item_id: "i1", qty_real: 3, localizacao_destino_id: "loc1" }),
    );
    expect(p.entrada_direta).toBe(true);
    expect(p.nf_referencia).toBe("NF-123");
  });
});

describe("buildManualPayload v2", () => {
  it("inclui loc por item e flag entrada_direta", () => {
    const p = buildManualPayload(
      [item({ backendItemId: "mi1", qty: "2", locIdOverride: "loc9" })],
      { entradaDireta: false },
    );
    expect(p.itens[0]).toEqual(
      expect.objectContaining({ item_id: "mi1", qty_recebida: 2, localizacao_destino_id: "loc9" }),
    );
    expect(p.entrada_direta).toBe(false);
  });
});

describe("buildCompraPayload", () => {
  it("monta body de criação de compra a partir de linhas com produto resolvido", () => {
    const prod = { id: "uuid-p1", sku: "ABC", descricao: "x" } as never;
    const p = buildCompraPayload(
      [item({ produto: prod, qty: "4", custo: "12.5", backendItemId: null })],
      { fornecedorId: "f1", empresaId: "e1", galpaoId: "g1", observacao: "obs" },
    );
    expect(p).toEqual({
      fornecedor_id: "f1", empresa_compradora_id: "e1", galpao_id: "g1", observacao: "obs",
      itens: [{ produto_id: "uuid-p1", qty_comprada: 4, custo_unitario: 12.5 }],
    });
  });
  it("custo vazio vira undefined (opcional no endpoint)", () => {
    const prod = { id: "uuid-p1" } as never;
    const p = buildCompraPayload([item({ produto: prod, qty: "1", custo: "" })],
      { fornecedorId: "f1", empresaId: "e1", galpaoId: "g1", observacao: null });
    expect(p.itens[0].custo_unitario).toBeUndefined();
  });
});

describe("splitOcExtras", () => {
  it("separa linhas da OC (backendItemId) das extras (produto sem backendItemId)", () => {
    const prod = { id: "uuid-p9" } as never;
    const { ocItens, extras } = splitOcExtras([
      item({ backendItemId: "i1" }),
      item({ backendItemId: null, produto: prod, qty: "2" }),
      item({ backendItemId: null, produto: null }), // linha vazia ignorada
    ]);
    expect(ocItens).toHaveLength(1);
    expect(extras).toHaveLength(1);
  });
});
```
Assinaturas mudam: `buildOcPayload(itens, opts: { entradaDireta: boolean; nfReferencia?: string | null })`, `buildManualPayload(itens, opts: { entradaDireta: boolean })`. Ajustar os testes v1 existentes pra nova assinatura (passar `{ entradaDireta: false }`), mantendo seus asserts (custo só se >0; motivo só se divergiu; filtra qty<=0 no manual).

- [ ] **Step 3: Rodar e ver falhar** — `npx vitest run src/components/wms/recebimento/receber-lote-adapters.test.ts` → FAIL.

- [ ] **Step 4: Implementar**
```typescript
export function buildOcPayload(
  itens: ReceberLoteItem[],
  opts: { entradaDireta: boolean; nfReferencia?: string | null },
) {
  return {
    itens: itens
      .filter((it) => Number(it.qty || "0") > 0)
      .map((it) => {
        const qty = Number(it.qty || "0");
        const custo = Number(it.custo || "0");
        const divergiu = it.qtyEsperada != null && qty !== it.qtyEsperada;
        return {
          item_id: it.backendItemId!,
          qty_real: qty,
          custo_unitario: custo > 0 ? custo : undefined,
          motivo_divergencia: divergiu && it.motivoDivergencia ? it.motivoDivergencia : undefined,
          localizacao_destino_id: it.locIdOverride ?? undefined,
        };
      }),
    entrada_direta: opts.entradaDireta,
    nf_referencia: opts.nfReferencia ?? undefined,
  };
}

export function buildManualPayload(
  itens: ReceberLoteItem[],
  opts: { entradaDireta: boolean },
) {
  return {
    itens: itens
      .map((it) => ({
        item_id: it.backendItemId!,
        qty_recebida: Number(it.qty || "0"),
        ...(it.custo ? { custo_unitario: Number(it.custo) } : {}),
        ...(it.locIdOverride ? { localizacao_destino_id: it.locIdOverride } : {}),
      }))
      .filter((x) => x.qty_recebida > 0),
    entrada_direta: opts.entradaDireta,
  };
}

export function buildCompraPayload(
  itens: ReceberLoteItem[],
  opts: { fornecedorId: string; empresaId: string; galpaoId: string; observacao: string | null },
) {
  return {
    fornecedor_id: opts.fornecedorId,
    empresa_compradora_id: opts.empresaId,
    galpao_id: opts.galpaoId,
    observacao: opts.observacao,
    itens: itens
      .filter((it) => it.produto && Number(it.qty || "0") > 0)
      .map((it) => ({
        produto_id: it.produto!.id,
        qty_comprada: Number(it.qty),
        ...(it.custo && Number(it.custo) > 0 ? { custo_unitario: Number(it.custo) } : {}),
      })),
  };
}

/** Separa linhas pré-definidas do documento das linhas extras adicionadas na tela. */
export function splitOcExtras(itens: ReceberLoteItem[]) {
  const ocItens = itens.filter((it) => it.backendItemId != null);
  const extras = itens.filter((it) => it.backendItemId == null && it.produto != null);
  return { ocItens, extras };
}
```
`buildTransferenciaPayload` fica como está.

- [ ] **Step 5: Rodar e ver passar** + `npx tsc --noEmit` (callers atuais dos adapters — wrappers OC/manual — quebram com a assinatura nova: ajustar as 2 chamadas pra `{ entradaDireta: false }` TEMPORARIAMENTE; os wrappers são reescritos em D6/D7).

- [ ] **Step 6: Commit** — `feat(recebimento): adapters v2 (loc/entrada_direta/extras) + buildCompraPayload`

---

### Task D2: Backend `receberItensViaOC` aceita loc por item + entrada direta + NF

**Files:**
- Modify: `src/lib/wms/receber-oc.ts`
- Modify: `src/app/api/wms/receber/oc/[id]/route.ts` (PostBody + repasse)
- Test: `src/app/api/wms/receber/oc/[id]/receber-oc-loc.test.ts` (route-handler, mocka `receberItensViaOC` e asserta repasse dos campos novos) — TDD.

**Contrato novo (espelha `receberEstoque`):**
```typescript
export interface ReceberOCItemInput {
  item_id: string;
  qty_real: number;
  custo_unitario?: number;
  motivo_divergencia?: string;
  /** NOVO: loc final (entrada direta) ou destino planejado da pendência (dock) */
  localizacao_destino_id?: string | null;
}
export interface ReceberOCArgs {
  oc_id: string;
  usuario_id: string;
  itens: ReceberOCItemInput[];
  /** NOVO: true = E direto na loc do item (exige loc em todos), sem pendência, sem cross-dock */
  entrada_direta?: boolean;
  /** NOVO: NF que chegou com a caixa (opcional). Com valor → upsertNotaFiscal → nota_fiscal_id nas movs E */
  nf_referencia?: string | null;
  chave_acesso_nf?: string | null;
}
```

- [ ] **Step 1: Teste de rota (falhando)** — mock de `@/lib/wms/receber-oc` com spy; POST com body `{itens:[{item_id,qty_real,localizacao_destino_id}], entrada_direta:true, nf_referencia:"NF1"}`; assert que o spy recebeu `entrada_direta:true`, `nf_referencia:"NF1"` e o item com `localizacao_destino_id`. (Mock de session/permissions como nos testes irmãos.)
- [ ] **Step 2: Ver falhar.**
- [ ] **Step 3: Implementar em `receber-oc.ts`:**
  - `entrada_direta===true`: ANTES do loop, validar `localizacao_destino_id` presente em todo item com qty>0 → senão `throw new Error("entrada direta exige localizacao_destino_id em todos os itens")`. No loop: mov E vai pra `itemReq.localizacao_destino_id` em vez de `locRecebId`; **pular** `detectarCrossDock` e a criação de pendências (nem pendCross nem pendNormal); `pendencias_criadas` fica `[]` pros itens diretos. O resto (excedente "achado", optimistic lock, OC close, release, rollback) INTACTO — o rollback já estorna por mov_ids acumulados, conferir que cobre o caminho novo.
  - `entrada_direta` falsy: comportamento atual + a pendência normal (linhas ~269-274) ganha `localizacao_destino_id: itemReq.localizacao_destino_id ?? null` (destino planejado, igual `movimentacoes.ts:201`). Cross-dock intacto (pendCross tem prioridade e consome a fração cross; o destino planejado aplica só à pendNormal).
  - NF: no início, se `nf_referencia || chave_acesso_nf` → `upsertNotaFiscal(...)` (mesmo helper/uso que `receberEstoque` faz em `movimentacoes.ts` — copiar o padrão de chamada de lá, MESMOS campos) e passar `nota_fiscal_id` nas movs E de compra (NÃO na mov "achado" de excedente). Sem NF → warn atual continua.
  - Na route: estender `PostBody` e repassar os 3 campos novos.
- [ ] **Step 4: Testes passam** (`npx vitest run "src/app/api/wms/receber/oc/[id]/"`) + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(receber-oc): loc por item + entrada direta + NF opcional (espelha receberEstoque)`

---

### Task D3: Backend `receberCompraManual` aceita loc por item + entrada direta

**Files:**
- Modify: `src/lib/wms/compras-manuais.ts` (`ReceberCompraManualInput`, `gravarMovEntradaCompraManual`, pendência)
- Modify: `src/app/api/wms/compras-manuais/[id]/receber/route.ts` (repasse)
- Test: `src/app/api/wms/compras-manuais/[id]/receber/receber-manual-loc.test.ts` (route, mocka lib, asserta repasse) — TDD.

Mesma semântica de D2 (sem NF — compra manual não tem NF por definição):
- item ganha `localizacao_destino_id?: string | null`; input ganha `entrada_direta?: boolean`.
- direta → valida loc em todos qty>0, E direto na loc, SEM pendência.
- dock → E em RECEBIMENTO (como hoje), pendência ganha `localizacao_destino_id` planejado (hoje é null fixo em ~313-322).
- Route repassa.

Steps: teste falhando → implementar → passar → `npx tsc --noEmit` → commit `feat(compras-manuais): receber com loc por item + entrada direta`.

---

### Task D4: `GET /api/wms/receber/oc/[id]` resolve uuid WMS + fornecedor_id

**Files:**
- Modify: `src/app/api/wms/receber/oc/[id]/route.ts` (só o GET)
- Test: ampliar um teste existente da rota OU criar `oc-detalhe-wms-id.test.ts` (mock supabase chainable; asserta `produto_wms_id` e `fornecedor_id` na resposta).

- [ ] **Step 1: Teste falhando** — GET responde `itens[].produto_wms_id` e `oc.fornecedor_id`.
- [ ] **Step 2: Implementar:**
  - Depois de buscar os itens, coletar `skus = [...new Set(itens.map(i=>i.sku))]`, query `siso_produtos.select("id, sku").in("sku", skus)` → map sku→uuid; cada item ganha `produto_wms_id: map.get(sku) ?? null`.
  - `oc.fornecedor_id`: se `oc.fornecedor` string → `siso_fornecedores.select("id").ilike("nome", oc.fornecedor).eq("ativo", true).limit(1)` → `fornecedor_id: data?.[0]?.id ?? null`.
- [ ] **Step 3: Passar + tsc + commit** — `feat(receber-oc): GET expõe produto_wms_id (sugestão putaway) e fornecedor_id`

---

### Task D5: Componente `<ReceberLote>` — capacidades pra página única

**Files:**
- Modify: `src/components/wms/recebimento/receber-lote.tsx`
- Modify: `src/components/wms/recebimento/receber-lote-types.ts`
- Modify: `src/app/wms/receber/avulso/page.tsx` (só se algum default mudar — NÃO deve; avulso fica intacto)

Mudanças (todas aditivas, avulso preservado):

- [ ] **Step 1: `produtoWmsId` na sugestão.** `emptyReceberLoteItem()` ganha `produtoWmsId: null`. Na putaway query (~177): `const prodId = it.produto?.id ?? it.produtoWmsId;` → usar `prodId` no queryKey, na URL e no `enabled` (`putawaySuggest && !!(prodId && galpaoId)`).
- [ ] **Step 2: Lock de produto POR LINHA.** Em `ItemLoteRow` (~745): `const productLocked = !config.productEditable || item.backendItemId != null;` e trocar o gate `config.productEditable` por `!productLocked`. Linhas com `backendItemId` também NÃO mostram botão remover (gate do botão remove: `config.canAddItems && item.backendItemId == null`).
- [ ] **Step 3: Display do esperado.** Ao lado do input de qty, quando `item.qtyEsperada != null && config.qtyEditable`:
```tsx
<span className="wms-td-mute" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
  era pra vir {fmtNum(item.qtyEsperada)}
</span>
```
(estilizar coerente com a linha; `fmtNum` já importado).
- [ ] **Step 4: `confirmLabel`.** Config ganha `confirmLabel?: string`; os 2 botões Confirmar usam `` `${config.confirmLabel ?? "Confirmar lote"} (${itensValidos.length})` ``.
- [ ] **Step 5: `guardaTogglesVisible`.** Config ganha `guardaTogglesVisible?: boolean` (default true). Quando `false`, esconder os checkboxes entrada-direta e iniciar-rota da sidebar (transferência: entrada é sempre direta no backend e não há pendência/rota).
- [ ] **Step 6: Validade com linhas qty 0.** Linha com `backendItemId != null` e qty `0` é VÁLIDA (significa "não veio") — não bloqueia o Confirmar; mas o lote exige ≥1 linha com qty>0. Ajustar `itensValidos`/`valid`: itens backendItemId aceitam `Number(qty) >= 0`; `valid` adicionalmente exige `itens.some(it => Number(it.qty) > 0)`. Entrada direta: a validação "todos com loc" considera SÓ linhas qty>0.
- [ ] **Step 7: Regressão avulso.** `npx tsc --noEmit && npm run build` + revisar diff: nenhum comportamento do avulso muda (configs default preservam tudo). Rodar `npx vitest run src/components/wms/recebimento/`.
- [ ] **Step 8: Commit** — `feat(recebimento): ReceberLote pronto pra página única (lock por linha, esperado, produtoWmsId, confirmLabel, toggles)`

---

### Task D6: Wrapper OC = página completa

**Files:**
- Modify: `src/app/wms/receber/oc/[id]/page.tsx`

- [ ] **Step 1: Mapear itens** com os campos novos: `produtoWmsId: it.produto_wms_id ?? null`, `qty: String(it.pendente)`, `qtyEsperada: it.pendente`, resto como hoje.
- [ ] **Step 2: CONFIG_OC v2:**
```typescript
{
  fluxo: "oc", canAddItems: true, productEditable: true, qtyEditable: true,
  custoVisible: true, custoObrigatorio: false, locPickVisible: true, locObrigatoria: false,
  putawaySuggest: true, divergenciaVisible: true, imprimirVisible: true, mlBlockVisible: true,
  planoSidebarVisible: true, leftFormVisible: true, guardaTogglesVisible: true,
  locAllowCreate: true, permissaoReceber: ["operacoes.receber", "compras.executar"],
  confirmLabel: "Confirmar recebimento",
}
```
- [ ] **Step 3: Left form travado** via `renderLeftFormExtra`: Fornecedor (input disabled, valor `oc.fornecedor`), Galpão (disabled, `oc.galpao_nome`), Origem (texto fixo "Compra (OC)"), **NF** (input editável, estado no wrapper), Observação (editável). Mesmas classes `wms-*` do left form do avulso.
- [ ] **Step 4: Submit com split:**
```typescript
async function submit(itens, ctx) {
  const { ocItens, extras } = splitOcExtras(itens);
  const r1 = await sisoFetch(`/api/wms/receber/oc/${id}`, { method: "POST", headers: JSONH,
    body: JSON.stringify(buildOcPayload(ocItens, { entradaDireta: ctx.entradaDireta, nfReferencia: nf || null })) });
  if (!r1.ok) throw new Error((await r1.json().catch(() => ({}))).error || `HTTP ${r1.status}`);
  const ocResp = await r1.json();
  let extrasResp: unknown = null;
  if (extras.length > 0) {
    if (!oc.fornecedor_id) throw new Error("Fornecedor da OC não cadastrado — receba o item extra pelo avulso");
    const r2 = await sisoFetch("/api/wms/receber", { method: "POST", headers: JSONH,
      body: JSON.stringify({
        galpao_id: oc.galpao_id, fornecedor_id: oc.fornecedor_id,
        origem_tipo: "ajuste_manual",
        motivo: `Item extra no recebimento da OC ${String(id).slice(0, 8)}`,
        entrada_direta: ctx.entradaDireta,
        itens: extras.map((it) => ({
          produto_id: it.produto!.id, qty: Number(it.qty),
          custo_unitario: it.custo ? Number(it.custo) : undefined,
          localizacao_destino_id: it.locIdOverride ?? undefined,
        })),
      }) });
    if (!r2.ok) throw new Error((await r2.json().catch(() => ({}))).error || `HTTP ${r2.status}`);
    extrasResp = await r2.json();
  }
  return { ocResp, extrasResp };
}
```
(`origem_tipo:"ajuste_manual"` não exige `empresa_compradora_id` — route:46 — e não contamina custo médio. Falha no r2 após r1 ok: estado real é "OC recebida, extra não" — toast do erro deixa claro; aceitável e documentado.)
- [ ] **Step 5: onSuccess: prints + navegação.** Mirror do bloco de print do avulso (`avulso/page.tsx`, busca por `imprimir-lote`): pros itens marcados `imprimir`, em modo guarda usa `pendencia_ids` (do `ocResp.pendencias_criadas` + `extrasResp.pendencia_ids`); em entrada direta usa `linhas`. Depois toast rico (`itens_recebidos`/`oc_fechada`) + invalidate `["wms-compras"]` + `router.push("/wms/compras?tab=receber")`.
- [ ] **Step 6: tsc + build + commit** — `feat(recebimento): OC com página completa do avulso (loc, etiqueta, plano, extras, NF)`

---

### Task D7: Wrapper manual = página completa

**Files:**
- Modify: `src/app/wms/receber/manual/[id]/page.tsx`

Igual D6, com as alterações pertinentes:
- Itens: `produtoWmsId: it.produto_id` (compra manual JÁ guarda uuid WMS), `qtyEsperada = qty_comprada - qty_recebida`, custo pré-preenchido do salvo.
- Config: igual CONFIG_OC v2, exceto `divergenciaVisible: false` (backend manual não tem motivo_divergencia) e `permissaoReceber: "compras.executar"`, `fluxo: "manual"`.
- Left form travado: Fornecedor, Empresa, Galpão (disabled) + Observação (read-only se houver). SEM campo NF.
- Submit: split igual; manual lines → `buildManualPayload(ocItens, { entradaDireta: ctx.entradaDireta })` → `POST /api/wms/compras-manuais/${id}/receber`; extras → mesmo POST avulso `ajuste_manual` (fornecedor_id da compra JÁ é FK — `compra.fornecedor.id`).
- onSuccess: prints (a lib retorna `{movs_geradas,status}` — SEM pendencia_ids; **estender o retorno de `receberCompraManual` pra incluir `pendencia_ids: string[]` e `mov_ids: string[]`** igual OC/avulso — pequena adição na lib em D3, incluir lá) + toast + invalidate + push `/wms/compras?tab=receber`.

> ⚠ Ajuste em D3: incluir `pendencia_ids`/`mov_ids` no `ReceberCompraManualResult` (necessário pro print daqui). Se D3 já commitou sem isso, fazer aqui como follow-up no mesmo commit de D7.

Steps: implementar → tsc + build → commit `feat(recebimento): manual com página completa do avulso`.

---

### Task D8: Wrapper transferência = página completa

**Files:**
- Modify: `src/app/wms/receber/transferencia/[id]/page.tsx`

- Itens: `produtoWmsId: it.produto_id` (uuid WMS no ledger 3D), qty fixa.
- Config v2: `fluxo:"transferencia", canAddItems:false, productEditable:false, qtyEditable:false, custoVisible:false, custoObrigatorio:false, locPickVisible:true, locObrigatoria:true, locAllowCreate:false, putawaySuggest:true, divergenciaVisible:false, imprimirVisible:true, mlBlockVisible:true, planoSidebarVisible:true, leftFormVisible:true, guardaTogglesVisible:false, permissaoReceber:"operacoes.receber", confirmLabel:"Confirmar recebimento"`.
- Left form travado: Origem, Destino (disabled), criada em.
- Submit: igual hoje (`buildTransferenciaPayload`); 409 surfaced.
- onSuccess: print por `linhas` (transferência é E direto, sem pendência — mirror do ramo entrada-direta do avulso; a lib `receberTransferencia` retorna void hoje: **estender pra retornar `mov_ids`/dados das linhas** OU montar `linhas` no front com sku/qty/loc dos próprios itens — PREFERIR montar no front, zero mudança de backend) + toast + push `/wms/receber/transferencia`.

Steps: implementar → tsc + build → commit `feat(recebimento): transferência com página completa (sugestão, etiqueta, plano)`.

---

### Task D9: Página `/wms/compras/nova` + matar o modal

**Files:**
- Create: `src/app/wms/compras/nova/page.tsx`
- Modify: `src/app/wms/compras/page.tsx` (botão vira navegação; remove modal)
- Delete: `src/components/wms/compras/nova-compra-manual-modal.tsx` (após grep confirmar zero outros usos)

- [ ] **Step 1: Página** — wrapper de `<ReceberLote>` com:
```typescript
const CONFIG_COMPRA: ReceberLoteConfig = {
  fluxo: "manual", canAddItems: true, productEditable: true, qtyEditable: true,
  custoVisible: true, custoObrigatorio: false, locPickVisible: false, locObrigatoria: false,
  divergenciaVisible: false, imprimirVisible: false, mlBlockVisible: true,
  planoSidebarVisible: false, leftFormVisible: true, guardaTogglesVisible: false,
  permissaoReceber: "compras.executar", confirmLabel: "Criar compra",
};
```
`renderLeftFormExtra`: Galpão (select, fonte `POST /api/wms/compras-manuais/contexto` igual o modal usava), Empresa compradora (select), Fornecedor (select + input inline de criação via `POST /api/wms/compras-manuais/fornecedor` — MESMO fluxo do modal), Observação. `validarExtra: () => !!(galpaoId && empresaId && fornecedorId)`. `submit` → `POST /api/wms/compras-manuais` com `buildCompraPayload(itens, {...})`. `onSuccess` → toast `Compra criada` + invalidate `["wms-compras"]` + `router.push("/wms/compras?tab=receber")`.
- [ ] **Step 2: page.tsx** — botão "Nova compra manual" (linha ~238) vira `onClick={() => router.push("/wms/compras/nova")}`; remover `modalManualAberto` state + render do `NovaCompraManualModal` + import.
- [ ] **Step 3:** `grep -rn "NovaCompraManualModal" src/` → só o arquivo do componente → `git rm src/components/wms/compras/nova-compra-manual-modal.tsx`. (Se houver outro uso, NÃO deletar; reportar.)
- [ ] **Step 4: tsc + build + commit** — `feat(compras): página /wms/compras/nova substitui modal de compra manual`

---

### Task D10: Docs + erros + suite

**Files:** `docs/api-reference-complete.md`, `docs/architecture-and-flows.md`, `CLAUDE.md`, `erros-conhecidos.yaml`

- api-reference: campos novos de `POST /api/wms/receber/oc/[id]` (`localizacao_destino_id`, `entrada_direta`, `nf_referencia`) e `POST /api/wms/compras-manuais/[id]/receber`; `GET receber/oc/[id]` += `produto_wms_id`/`fornecedor_id`; UI `/wms/compras/nova`.
- architecture: recebimento = página única rica em TODOS os fluxos; extras viram `ajuste_manual`.
- CLAUDE.md: nota na seção recebimento/ReceberLote (página única; criação de compra em `/wms/compras/nova`).
- erros-conhecidos:
```yaml
- id: RECEBIMENTO-CONFIG-DESPIDO
  date: 2026-06-09
  source: recebimento-pagina-unica
  category: business_logic
  message: "Fase C v1 escondeu features por fluxo (OC/transf sem loc/etiqueta/plano) — usuário esperava a página inteira do avulso pré-preenchida"
  cause: "matriz de flags do plano anterior despiu a página em vez de pré-preencher"
  fix: "backends aceitam loc/entrada_direta; configs full-ON; extras via ajuste_manual; criação de compra em página"
  files: [src/lib/wms/receber-oc.ts, src/lib/wms/compras-manuais.ts, src/components/wms/recebimento/receber-lote.tsx]
  tags: [recebimento, ux, pagina-unica]
```
- Suite: `npm test` (5 falhas pré-existentes de realoc-fix-pack são conhecidas) + `npx tsc --noEmit` + `npm run build`.
- Commit `docs(recebimento): página única rica + criação de compra em página`.

---

## Self-review

- Q1 do Eryk (igual avulso + esperado visível + qty real): D2 (backend loc/direta), D5 Step 3 (esperado), D6 (página full). ✅
- Q2 (linha extra): D1 `splitOcExtras` + D6 Step 4 (`ajuste_manual`). ✅
- Criação como página: D9. Modal morre. ✅
- Transferência/manual mesma página: D7/D8. ✅
- Avulso intocado: D5 aditivo + Step 7 regressão. ✅
- Sem placeholder; tipos consistentes (`produtoWmsId`, `confirmLabel`, `guardaTogglesVisible` definidos em D1/D5 e usados em D6-D9). ✅

## Riscos
- **D2 é a task crítica** (mexe em receber-oc com cross-dock/rollback). Mitigação: entrada direta PULA cross-dock (sem interação); rollback já é por mov_ids.
- Falha do POST de extras após OC ok: estado real, toast explica. Documentado.
- Print da transferência montado no front (linhas) — zero backend.
