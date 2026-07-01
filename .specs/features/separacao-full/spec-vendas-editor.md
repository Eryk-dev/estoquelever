# Separação Full — Pedido na aba Vendas + editor de itens (addendum)

**Contexto:** revisão de produto (2026-07-01). O usuário quer gerenciar o pedido Full de onde ele nasce (aba Vendas), não só na lane dedicada. A decisão FULL-07 (Full ausente de Vendas) foi revertida PARCIALMENTE: as abas de STATUS (Pendentes/Em separação/Baixados/Concluídos) seguem excluindo Full (zero-regressão), mas uma aba nova **"Full"** o mostra, e o detalhe do pedido ganha o editor de itens.

Backend do editor já existe e testado (ver `spec.md` FULL-06): `POST/DELETE/PATCH /api/wms/full/[id]/itens` + `POST /api/wms/full/[id]/cancelar` + `src/lib/wms/full-editor.ts`. Este addendum é só a UI + o ponto de entrada em Vendas.

## Decisão de UX (travada)
Aba separada **"Full"** na lista `/wms/vendas` (consistente com as abas atuais; mantém as abas de status limpas). Editor mora no **detalhe** `/wms/vendas/[id]` (já mostra itens + já tem fluxo Cancelar) — reusa `ProdutoCombo` de `@/components/wms/ui/modals` pro add.

## Acceptance Criteria

- **VF-01** — WHEN o operador abre `/wms/vendas` e seleciona a aba **"Full"** THEN a lista SHALL mostrar só pedidos `separacao_full=true` (qualquer status). As abas Pendentes/Em separação/Baixados/Concluídos SHALL continuar EXCLUINDO Full (`.eq("separacao_full", false)`).
- **VF-02** — WHEN `GET /api/wms/vendas?tab=full` THEN SHALL retornar `separacao_full=true` (sem o filtro de status das outras abas). Demais tabs inalteradas.
- **VF-03** — WHEN o detalhe `/wms/vendas/[id]` é de um Full com `fechado_em IS NULL` THEN SHALL exibir um editor: (a) **adicionar** item (`ProdutoCombo` + qty → `POST /full/[id]/itens`); (b) por item **remover** (`DELETE …/itens/[itemId]`) e **mudar qty** (`PATCH …/itens/[itemId]`). Cada ação recarrega o detalhe.
- **VF-04** — WHEN o detalhe é de um Full FECHADO (`fechado_em` setado) THEN o editor SHALL ficar oculto/read-only (reabrir é fora deste escopo — feito na lane).
- **VF-05** — WHEN o operador cancela um Full no detalhe THEN SHALL chamar `POST /full/[id]/cancelar` (estorna S de `nf_venda` + libera R), NÃO o `/vendas/[id]/cancelar` (que só estorna `venda_manual`).
- **VF-06** — WHEN a rota de detalhe `/api/wms/vendas/[id]` responde THEN SHALL incluir `pedido.separacao_full`, `pedido.fechado_em` e `item.produto_id` (já selecionado) no shape.

## Fora de escopo
- Reabrir Full fechado pela tela de Vendas (fica na lane).
- Picking pela tela de Vendas (é na lane `/wms/separacao-full`).
- Mudar a lane dedicada `/wms/separacao-full` (continua).

## Traceability
| ID | Story | Status |
|---|---|---|
| VF-01..02 | Aba Full em Vendas | Pending |
| VF-03..04 | Editor de itens no detalhe | Pending |
| VF-05 | Cancelar via rota Full | Pending |
| VF-06 | Detalhe expõe campos Full | Pending |
