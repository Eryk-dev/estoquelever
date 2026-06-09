# OC → Própria no clique SEPARAR (saldo que apareceu antes da separação) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando um item OC ganha saldo livre antes de ser separado, clicar SEPARAR deve rebaixá-lo automaticamente para separação normal (sair do balde "Itens OC — validar"), em vez de continuar exigindo o fluxo manual "Encontrei".

**Architecture:** Reusar o `reconciliarEntradaEstoque` (`reconciliador-oc.ts`) — único mecanismo já testado de conversão OC→própria (CLAIM atômico + reserva + transição). Duas mudanças cirúrgicas: (1) o reconciliador passa a processar pedidos em `em_separacao` (hoje só `validacao_oc`/`aguardando_compra`); (2) a rota `separacao/iniciar` dispara o reconciliador no clique SEPARAR, depois de promover a `em_separacao` e antes de consolidar o checklist. Fase 2 (opcional, maior risco) estende a detecção a saldo ainda em loc de RECEBIMENTO, coordenando com o put-away.

**Tech Stack:** Next.js route handlers, Supabase (service role), Vitest (unit happy-dom + integration contra staging real).

---

## Contexto verificado (staging `ehbxpbeijofxtsbezwxd`, 2026-06-09)

Caso real do usuário (SKU ACD003, galpão CWB):

| Fato | Valor |
|---|---|
| Loc `A-01-2` | `tipo='picking'`, saldo 18, reservado 1, **disponível 17** |
| 4 pedidos (938157244, 938163020, 938160966, 938152254) | `compra_status='oc_pendente'`, `decisao_final='oc'`, **`status_separacao='em_separacao'`**, qty 1 cada |

**Causa raiz:** o reconciliador só age em pedido `validacao_oc`/`aguardando_compra` (`STATUS_PEDIDO_OC`, `reconciliador-oc.ts:38`). Ao abrir o checklist, o pedido é promovido a `em_separacao` (`iniciar/route.ts:136` inclui `validacao_oc` no `toStart`; a blindagem das linhas 123-138 só barra `aguardando_compra`/`comprado`, deixa `oc_pendente` passar). Em `em_separacao` o reconciliador nunca mais seleciona o pedido → o item congela em OC apesar do saldo. O clique SEPARAR (`iniciar`) não re-rota nada hoje.

**Por que a correção é fiscalmente segura:** o `lancar_estoque` (gera NF + marcadores Tiny) de um pedido OC é enfileirado na ETAPA DE EMBALAGEM — `confirmar-item-embalagem/route.ts:234` (fluxo normal) e `bipar-embalagem-oc/route.ts:337` (fluxo OC), além do `reconciliador-oc.ts:316` e `compras-release.ts:210`. Logo, converter OC→própria em `em_separacao` SEM enfileirar `lancar_estoque` na separação não cria buraco fiscal: a NF sai downstream na embalagem de qualquer forma. O `transicionarPedidoSeReconciliado` já trata o estado avançado (`reconciliador-oc.ts:248-265`): só marca `decisao_final='propria'` e NÃO regride o status.

**Modelo escolhido (reconciliador, não "Encontrei"):** "cair pra separação normal" = virar uma LINHA NORMAL pra picar (com reserva), não auto-pegar. O reconciliador cria reserva e deixa o item pra picar; o "Encontrei" (`validar-oc-item`) PEGA na hora (mov S, marca bipado) — comportamento eager indesejado aqui.

---

## File Structure

- **Modificar:** `src/lib/wms/reconciliador-oc.ts` — adicionar `em_separacao` ao filtro de status; extrair helper puro de pares (produto,galpão).
- **Modificar:** `src/app/api/wms/separacao/iniciar/route.ts` — disparar o reconciliador no clique SEPARAR (depois do promote, antes do consolidar).
- **Test (unit, seguro):** `src/lib/wms/reconciliador-oc.test.ts` — testar o novo helper puro.
- **Test (integration, TRUNCA STAGING — rodar só com staging livre):** `test/integration/oc-reseparacao-saldo.integration.test.ts`.
- **Docs (mesmo commit):** `docs/architecture-and-flows.md` (fluxo separação/OC), `erros-conhecidos.yaml` (entrada nova).

> ⚠️ **Hazard de verificação:** `npm run test:integration` e `npm run scenarios` rodam contra o staging real e **truncam tabelas operacionais** antes de cada run. NÃO rodar em background / enquanto alguém usa o staging. Gates seguros autônomos: `npm test` (unit), `npx tsc --noEmit`, `npm run lint`.

---

## FASE 1 — Saldo em PICKING (cobre o caso real do usuário)

### Task 1: Reconciliador processa pedidos `em_separacao`

**Files:**
- Modify: `src/lib/wms/reconciliador-oc.ts:38`

- [ ] **Step 1: Ampliar `STATUS_PEDIDO_OC`**

De:
```ts
const STATUS_PEDIDO_OC = ["validacao_oc", "aguardando_compra"] as const;
```
Para:
```ts
// Inclui em_separacao: se o saldo aparece DEPOIS do pedido já estar na wave
// (operador abriu o checklist → promovido a em_separacao), o item OC tem que
// poder ser rebaixado a normal mesmo assim. transicionarPedidoSeReconciliado
// (linhas 248-265) já trata estado avançado: só marca decisao_final='propria',
// não regride status. A NF sai depois, na embalagem (confirmar-item-embalagem /
// bipar-embalagem-oc enfileiram lancar_estoque).
const STATUS_PEDIDO_OC = ["validacao_oc", "aguardando_compra", "em_separacao"] as const;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (sem novos erros).

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/reconciliador-oc.ts
git commit -m "fix(wms): reconciliador OC processa pedidos em_separacao (saldo tardio)"
```

> Nota: este passo, sozinho, já faz a ENTRADA DE ESTOQUE automática (gancho de mov E em `ledger.ts`) converter OC→normal em pedidos `em_separacao`. O Task 3 cobre o gatilho do clique SEPARAR para o caso em que o saldo já existe e nenhuma mov E nova vem.

---

### Task 2: Helper puro `paresProdutoGalpao` (testável)

**Files:**
- Modify: `src/lib/wms/reconciliador-oc.ts` (adicionar export de função pura, perto de `selecionarLiberaveisFifo`)
- Test: `src/lib/wms/reconciliador-oc.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

Adicionar ao fim de `src/lib/wms/reconciliador-oc.test.ts`:
```ts
import { paresProdutoGalpao } from "./reconciliador-oc";

describe("paresProdutoGalpao — dedup de (produto_uuid, galpão) a reconciliar", () => {
  const skuToUuid = new Map([
    ["ACD003", "uuid-acd003"],
    ["XYZ", "uuid-xyz"],
  ]);

  it("dedup por par e ignora sku sem uuid / sem galpão", () => {
    const r = paresProdutoGalpao(
      [
        { sku: "ACD003", galpao_id: "g1" },
        { sku: "ACD003", galpao_id: "g1" }, // dup
        { sku: "ACD003", galpao_id: "g2" },
        { sku: "XYZ", galpao_id: "g1" },
        { sku: "SEM_UUID", galpao_id: "g1" }, // sem uuid → ignora
        { sku: "ACD003", galpao_id: null }, // sem galpão → ignora
      ],
      skuToUuid,
    );
    expect(r).toEqual(
      expect.arrayContaining([
        { produtoId: "uuid-acd003", galpaoId: "g1" },
        { produtoId: "uuid-acd003", galpaoId: "g2" },
        { produtoId: "uuid-xyz", galpaoId: "g1" },
      ]),
    );
    expect(r).toHaveLength(3);
  });

  it("lista vazia → []", () => {
    expect(paresProdutoGalpao([], skuToUuid)).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -- reconciliador-oc`
Expected: FAIL — `paresProdutoGalpao is not a function` / import não resolve.

- [ ] **Step 3: Implementar o helper puro**

Adicionar em `src/lib/wms/reconciliador-oc.ts` (logo após `selecionarLiberaveisFifo`):
```ts
/**
 * A partir de itens OC (com sku + galpão) e um mapa sku→produto_uuid, devolve
 * os pares (produtoId, galpaoId) ÚNICOS que precisam ser reconciliados. Ignora
 * itens sem uuid mapeado ou sem galpão. Pura — testável sem IO.
 */
export function paresProdutoGalpao(
  itens: Array<{ sku: string | null; galpao_id: string | null }>,
  skuToUuid: Map<string, string>,
): Array<{ produtoId: string; galpaoId: string }> {
  const vistos = new Set<string>();
  const out: Array<{ produtoId: string; galpaoId: string }> = [];
  for (const it of itens) {
    if (!it.sku || !it.galpao_id) continue;
    const produtoId = skuToUuid.get(it.sku);
    if (!produtoId) continue;
    const chave = `${produtoId}|${it.galpao_id}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push({ produtoId, galpaoId: it.galpao_id });
  }
  return out;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -- reconciliador-oc`
Expected: PASS (todos, incluindo os antigos de `selecionarLiberaveisFifo`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/reconciliador-oc.ts src/lib/wms/reconciliador-oc.test.ts
git commit -m "feat(wms): helper puro paresProdutoGalpao p/ reconciliar no clique separar"
```

---

### Task 3: `iniciar` dispara o reconciliador no clique SEPARAR

**Files:**
- Modify: `src/app/api/wms/separacao/iniciar/route.ts` (entre o bloco "2. Update pedidos to em_separacao" e o "3. Call RPC to get consolidated product list", ou seja, depois da linha 161 e antes da linha 168)

**Design:** rodar DEPOIS do promote (linha 141-161) e ANTES do consolidar (linha 168). Assim, pedidos `validacao_oc` recém-promovidos a `em_separacao` e pedidos já `em_separacao` são tratados pelo MESMO caminho (Task 1 garante que o reconciliador enxerga `em_separacao`): o item vira normal na wave atual, sem desvio por `aguardando_nf`. O consolidar (RPC) roda depois → o checklist já reflete o item rebaixado.

- [ ] **Step 1: Escrever o teste de integração falhando** (ver Task 4 — escrito primeiro, mas rodado só com staging livre). Para o fluxo TDD local seguro, validar Task 3 via typecheck + lint + revisão; o teste comportamental é o de integração da Task 4.

- [ ] **Step 2: Implementar a chamada ao reconciliador**

Inserir após o fechamento do bloco `if (toStart.length > 0) { ... }` (depois da linha 161), antes do comentário "3D (Fase 3)":
```ts
    // 2.5 Re-rota OC→própria no clique SEPARAR: se entrou saldo PICKÁVEL desde
    // que o item virou OC, o reconciliador limpa compra_status, cria reserva e
    // marca decisao_final='propria' — o item some do balde "Itens OC" e vira
    // linha normal na wave atual. Roda DEPOIS do promote (acima) pra tratar
    // tanto pedidos recém-promovidos quanto os já em_separacao pelo mesmo
    // caminho (reconciliador agora enxerga em_separacao — Task 1). Idempotente
    // e atômico (CLAIM compare-and-swap dentro do reconciliador); no-op se não
    // houver item OC ou saldo livre. Best-effort: falha não bloqueia o iniciar.
    try {
      const { data: ocItems } = await supabase
        .from("siso_pedido_itens")
        .select("sku, siso_pedidos!inner(separacao_galpao_id)")
        .in("pedido_id", pedido_ids)
        .in("compra_status", ["oc_pendente", "aguardando_compra"]);

      if (ocItems && ocItems.length > 0) {
        const { reconciliarEntradaEstoque, paresProdutoGalpao } = await import(
          "@/lib/wms/reconciliador-oc"
        );
        // sku → produto_uuid (siso_produtos.id); o reconciliador recebe UUID,
        // NÃO o tiny_produto_id de siso_pedido_itens.produto_id.
        const skus = [
          ...new Set(
            ocItems.map((i) => i.sku as string | null).filter((s): s is string => !!s),
          ),
        ];
        const { data: prods } = await supabase
          .from("siso_produtos")
          .select("id, sku")
          .in("sku", skus);
        const skuToUuid = new Map<string, string>(
          (prods ?? []).map((p) => [p.sku as string, p.id as string]),
        );
        const itensNorm = ocItems.map((i) => {
          const pedRaw = i.siso_pedidos as unknown;
          const ped = Array.isArray(pedRaw)
            ? (pedRaw[0] as { separacao_galpao_id?: string | null } | undefined)
            : (pedRaw as { separacao_galpao_id?: string | null } | null);
          return {
            sku: (i.sku as string | null) ?? null,
            galpao_id: ped?.separacao_galpao_id ?? null,
          };
        });
        for (const { produtoId, galpaoId } of paresProdutoGalpao(itensNorm, skuToUuid)) {
          try {
            await reconciliarEntradaEstoque({ produtoId, galpaoId });
          } catch (recErr) {
            logger.warn("separacao-iniciar", "reconciliar OC no clique separar falhou", {
              produtoId,
              galpaoId,
              error: recErr instanceof Error ? recErr.message : String(recErr),
            });
          }
        }
      }
    } catch (ocErr) {
      logger.warn("separacao-iniciar", "varredura OC no iniciar falhou (não-fatal)", {
        error: ocErr instanceof Error ? ocErr.message : String(ocErr),
      });
    }
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/separacao/iniciar/route.ts
git commit -m "feat(wms): clique SEPARAR re-rota item OC com saldo p/ separação normal"
```

---

### Task 4: Teste de integração (rodar SÓ com staging livre)

**Files:**
- Create: `test/integration/oc-reseparacao-saldo.integration.test.ts`

> Espelhar o setup dos testes existentes em `test/integration/` (helpers de seed + `wms_truncate_operacional`). Conferir `test/integration/receber-oc-all-or-nothing.integration.test.ts` para o padrão de client/seed.

- [ ] **Step 1: Escrever o teste**

Esqueleto (ajustar aos helpers reais do diretório):
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createServiceClient } from "@/lib/supabase-server";
import { reconciliarEntradaEstoque } from "@/lib/wms/reconciliador-oc";
// + helpers de seed do diretório (produto, galpão, loc picking, pedido OC, item)

describe("OC re-separação por saldo em em_separacao", () => {
  beforeEach(async () => {
    const sb = createServiceClient();
    await sb.rpc("wms_truncate_operacional"); // limpa tabelas operacionais
  });

  it("item OC em em_separacao com saldo livre em picking → vira normal", async () => {
    const sb = createServiceClient();
    // 1. seed: produto ACD-TST, galpão, loc picking com saldo 5 (mov E)
    // 2. seed: pedido OC (decisao_final='oc', status_separacao='em_separacao'),
    //          item compra_status='oc_pendente', qty 1
    // 3. act: await reconciliarEntradaEstoque({ produtoId, galpaoId })
    // 4. assert:
    //    - item.compra_status === null
    //    - pedido.decisao_final === 'propria'
    //    - pedido.status_separacao === 'em_separacao' (NÃO regrediu)
    //    - existe reserva R (siso_movimentacoes tipo='R') pro pedido na loc picking
    expect(true).toBe(true); // substituir pelos asserts reais
  });

  it("FIFO: saldo cobre só o mais antigo dos dois pedidos OC", async () => {
    // 2 pedidos OC em_separacao, saldo livre = 1 → só o mais antigo vira normal
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar com staging livre (coordenar com o usuário)**

Run: `npm run test:integration -- oc-reseparacao-saldo`
Expected: PASS. ⚠️ Trunca tabelas operacionais do staging — confirmar que ninguém está usando antes.

- [ ] **Step 3: Commit**

```bash
git add test/integration/oc-reseparacao-saldo.integration.test.ts
git commit -m "test(wms): integração — OC vira normal por saldo em em_separacao"
```

---

### Task 5: Docs + erros-conhecidos + destravar os 4 pedidos atuais

**Files:**
- Modify: `docs/architecture-and-flows.md` (seção separação/OC)
- Modify: `erros-conhecidos.yaml`

- [ ] **Step 1: Atualizar `docs/architecture-and-flows.md`** — documentar que (a) o reconciliador agora processa `em_separacao`; (b) o clique SEPARAR (`iniciar`) re-rota itens OC com saldo.

- [ ] **Step 2: Adicionar entrada em `erros-conhecidos.yaml`**:
```yaml
- id: WMS-OC-SALDO-EM-SEPARACAO
  date: 2026-06-09
  source: usuario (checklist separação)
  category: business_logic
  message: "Item OC continua no balde 'Itens OC — validar' mesmo com saldo livre que cobre."
  cause: "reconciliador-oc só processava pedidos validacao_oc/aguardando_compra; ao abrir o checklist o pedido é promovido a em_separacao e nunca mais era reconciliado. Clique SEPARAR não re-rotava."
  fix: "STATUS_PEDIDO_OC inclui em_separacao + separacao/iniciar dispara reconciliarEntradaEstoque no clique SEPARAR (após promote, antes do consolidar)."
  files:
    - src/lib/wms/reconciliador-oc.ts
    - src/app/api/wms/separacao/iniciar/route.ts
  tags: [oc, reconciliador, separacao, em_separacao]
```

- [ ] **Step 3: Destravar os 4 pedidos ACD003 já presos** — após o deploy da Fase 1, basta o usuário reabrir o checklist (dispara `iniciar` → reconcilia) OU rodar `reconciliarEntradaEstoque({ produtoId: 'f546e03e-0f96-471a-9538-faa2be39ab29', galpaoId: '14e22fe9-8dae-4950-b1e8-f38cffa60646' })` uma vez. NÃO mutar via SQL cru (perderia o CLAIM atômico + a reserva). Confirmar com o usuário antes.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture-and-flows.md erros-conhecidos.yaml
git commit -m "docs(wms): re-separação OC por saldo + entrada erros-conhecidos"
```

---

## FASE 2 — Saldo em RECEBIMENTO (B2, opcional, MAIOR RISCO — aprovar antes)

**Por que separada:** o reconciliador só conta saldo em loc `tipo='picking'` (`reconciliador-oc.ts:118-145`) DE PROPÓSITO. Reservar em loc de RECEBIMENTO colide com o put-away: quando a guarda faz a perna S (recebimento→picking), a reserva criada aqui consome o saldo e viola o CHECK `reservado<=saldo` do ledger (comentário em `reconciliador-oc.ts:112-117`).

**Decisão do usuário (2026-06-09):** quer que saldo ainda não-guardado (em recebimento) também rebaixe OC→própria no clique separar.

**Design proposto (precisa detalhar + aprovar):**
1. Estender `saldoLivre`/`melhorLocPicking` para considerar `tipo IN ('picking','recebimento')`.
2. AO reservar numa loc de RECEBIMENTO, ENCERRAR/cancelar a pendência de put-away concorrente daquele saldo (a peça passa a ser do pedido, não vai mais ser guardada) usando a RPC `wms_cancelar_pendencia_guarda_atomico` (libera a reserva forte `reserva_guarda` da FASE 6 antes de reservar pro pedido) — senão duas reservas competem pelo mesmo saldo.
3. Tratar parciais (pendência de guarda parcialmente feita) e a corrida com `wms_confirmar_guarda_atomico` (auto-encerrar em `saldo=0`).

**Riscos:** quebra de invariante do ledger se a coordenação com a guarda falhar; corrida guarda × reconciliador. **Exige testes de integração dedicados cobrindo: reservar em recebimento sem pendência de guarda; com pendência `pendente`; com pendência `em_guarda` (reserva forte viva); confirmação de guarda concorrente.**

> ⛔ Não implementar a Fase 2 sem detalhar estas tarefas em passos TDD próprios e obter OK explícito — o risco é de invariante de estoque, não cosmético.

---

## Self-Review

- **Cobertura do spec:** "clicar separar atualiza e item com saldo cai pra normal" → Tasks 1+3 (picking) cobrem o caso real (saldo em picking, pedidos em_separacao). B2 (recebimento) → Fase 2.
- **Placeholders:** o teste de integração (Task 4) tem esqueleto com asserts a preencher contra os helpers reais do diretório — marcado explicitamente; não é placeholder de lógica de produção.
- **Consistência de tipos:** `paresProdutoGalpao(itens, skuToUuid) → {produtoId, galpaoId}[]` usado igual no Task 2 (def) e Task 3 (uso). `reconciliarEntradaEstoque({produtoId, galpaoId})` — assinatura existente (`reconciliador-oc.ts:46`).
- **Gate seguro vs hazard:** unit/typecheck/lint são autônomos; integração trunca staging → rodar só com staging livre.
