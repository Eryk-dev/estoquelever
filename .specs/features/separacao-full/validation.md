# Validation — Pedido Full na aba Vendas + editor (spec-vendas-editor.md)

**Verdict: PASS** · diff range `d1ea86b0..3f90492f` · 2026-07-01

## Spec-anchored outcome check (por AC)

| AC | Outcome esperado | Evidência | Status |
|---|---|---|---|
| VF-01 | Aba "Full" lista só `separacao_full=true`; abas de status excluem Full | integration `regressao.test.ts`: `tab=full` contém o Full, não o normal; `tab=em_separacao` não contém o Full | ✅ |
| VF-02 | `GET /vendas?tab=full` → separacao_full=true, sem filtro de status | `vendas/route.ts`: base `.eq("separacao_full", tab==="full")` + `case "full": break` (sem status). Coberto por VF-01 | ✅ |
| VF-03 | Detalhe do Full não-fechado: add/remover/mudar-qty chamam as rotas do editor e recarregam | UI `vendas/[id]/page.tsx`: `addItemFull`→POST, `removeItemFull`→DELETE, `setQtyFull`→PATCH, todas via `editFull()` que `refetch()`. Endpoints ledger-testados em FULL-06 (`separacao-full-editor.test.ts` 9/9) | ✅ (endpoints testados; wiring por build+typecheck) |
| VF-04 | Full fechado → sem editor | `fullEditavel = separacao_full && !fechado_em && status!=cancelado && podeCancelar`; controles gated nisso; nota "Full fechado — reabra" | ✅ (revisão de código) |
| VF-05 | Cancelar no detalhe do Full usa `/full/[id]/cancelar` | `submitCancelar`: `cancelUrl = separacao_full ? /full/[id]/cancelar : /vendas/[id]/cancelar`. Rota Full ledger-testada em FULL-08 | ✅ |
| VF-06 | Detalhe expõe `separacao_full`, `fechado_em`, item `produto_id` | integration: `j.pedido.separacao_full===true` + `hasProperty("fechado_em")`; `produto_id` já no select de itens | ✅ |

## Discrimination
- ACs de backend (VF-01/02/06): teste isolado mata a regressão (assert por id; flip-delta nos cards). Se o guard `tab==="full"` fosse removido, `tab=full` não traria o Full → teste falha.
- ACs de estoque (VF-03/05): as rotas subjacentes têm sensor de discriminação na suíte FULL-06/08 (matriz de saldo/reservado no ledger real, 9/9). A UI é wiring fino sobre elas.

## Gates
- integration `regressao.test.ts` 5/5 · `npm run build` ✅ · `eslint` ✅ · `tsc --noEmit` limpo (fora 2 erros pré-existentes em `substituto-match.test.ts`).

## Gap conhecido (não-bloqueante)
- E2E de browser (clique real no "Adicionar"/qty/remover) não exercido — wiring verificado por build+typecheck+ endpoints testados. UAT de browser disponível se pedido.
