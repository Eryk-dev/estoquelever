# Realocação cascateável no picking de separação

**Data:** 2026-05-18
**Módulo:** WMS · Separação
**Status:** Aprovado (workflow validado em [`2026-05-18-realocacao-cascateavel-workflow.html`](./2026-05-18-realocacao-cascateavel-workflow.html))

## Objetivo

Permitir que toda localização sugerida no picking — original ou realocada — se comporte de forma idêntica: aceita "parcial" (qty pega + loc zerou), e quando sobra residual, o sistema busca automaticamente a próxima loc no galpão sem travar o operador. Quando o galpão esgota cobertura, abre o modal de encaminhar/OC automaticamente.

Para visão de negócio completa com diagramas, cenários e mockups, ver o documento workflow.html.

## Mudanças

### Schema

```sql
ALTER TABLE siso_pedido_item_realocacoes
  ADD COLUMN parent_realocacao_id uuid REFERENCES siso_pedido_item_realocacoes(id),
  ADD COLUMN quantidade_pega int,
  ADD COLUMN parcial boolean NOT NULL DEFAULT false,
  ADD COLUMN parcial_motivo text,
  ADD COLUMN parcial_em timestamptz,
  ADD COLUMN parcial_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN mov_ajuste_loc_zerou_id uuid REFERENCES siso_movimentacoes(id);

ALTER TABLE siso_pedido_item_realocacoes
  DROP CONSTRAINT siso_pedido_item_realocacoes_status_check,
  ADD CONSTRAINT siso_pedido_item_realocacoes_status_check
  CHECK (status IN ('aguardando_picking','picado','picado_parcial','cancelado'));

CREATE INDEX idx_realoc_parent ON siso_pedido_item_realocacoes(parent_realocacao_id);
```

**Invariantes**

- `parent_realocacao_id IS NULL` → realocação raiz (criada direto do item pai).
- `parent_realocacao_id IS NOT NULL` → nó da chain de cascade.
- `status = 'picado_parcial'` implica `quantidade_pega < quantidade` E o sistema tentou cascade (criou descendente em `aguardando_picking` OU pedido foi marcado `pendente_realocacao` por sem cobertura). Em ambos os casos a realocação atual é terminal.
- `picado` (terminal): `quantidade_pega = quantidade` (cobriu integralmente) OU `quantidade_pega = NULL` no caso de fluxo antigo via `marcar-realocacao` (sem modal).
- O ledger (`siso_movimentacoes`) é a fonte de verdade do que saiu fisicamente. A árvore de realocações só rastreia a sequência de tentativas.
- Motivos permitidos: `loc_zerou` (raiz, fluxo atual), `cascade_parcial` (qty < pedida sem zerar), `cascade_loc_zerou` (loc zerou no meio do cascade).

### resolverRealocacao

Aceita parâmetro adicional `localizacoes_excluir: string[]` no lugar de `localizacao_id_original`. Frontend ou caller monta o array somando a loc original + todas as locs já visitadas na cadeia (via recursão por `parent_realocacao_id` ou query do item).

A ordenação preserva a regra atual: empresa origem > tipo (picking > overstock > recebimento > expedicao > quarentena) > maior disponível > código asc.

### API

**`POST /api/wms/separacao/parcial`** ganha um modo dual:

Body original (mantido):
```json
{ "pedido_item_id": "...", "quantidade_pega": 2, "loc_zerou": true }
```

Body novo:
```json
{ "realocacao_id": "...", "quantidade_pega": 2, "loc_zerou": true }
```

Resposta (idêntica nos dois modos):
```json
{ "status": "completo" }
{ "status": "realocado", "realocacoes": [...] }
{ "status": "sem_cobertura" }
```

**Lógica do modo realocação:**

1. Valida `realoc.status === 'aguardando_picking'` (409 se não).
2. Valida `quantidade_pega <= realoc.quantidade` (400 se não).
3. Resolve quadrupla via `realoc.empresa_dona_id`, `realoc.galpao_id`, `realoc.localizacao_id`.
4. Gera mov S (`emprestimo` se `is_emprestimo`, senão `nf_venda`) com qty pega — se > 0.
5. Se `loc_zerou` e `saldo_atual > quantidade_pega`, gera mov S de ajuste (`ajuste_pick_zerou`) pro delta.
6. Atualiza realoc: `status = 'picado_parcial'` (se residual > 0) ou `'picado'` (se cobriu tudo), com `quantidade_pega`, `parcial`, `parcial_*`, `mov_saida_id`, `mov_ajuste_loc_zerou_id`.
7. Acumula `quantidade_pega` no item pai (`+=`).
8. Se residual > 0:
   - Monta `localizacoes_excluir` = loc original do item pai + locs de todas as realocações desse `pedido_item_id` (qualquer status, qualquer posição na chain). Query simples por `pedido_item_id`, sem precisar recursionar pela chain.
   - Chama `resolverRealocacao` com o residual + lista de exclusão.
   - `realocado` → cria nova(s) linhas em `siso_pedido_item_realocacoes` com `parent_realocacao_id = realoc.id`. Retorna `{ status: 'realocado', realocacoes: [...] }`.
   - `sem_cobertura` → marca pedido `pendente_realocacao`. Retorna `{ status: 'sem_cobertura' }`.

**`POST /api/wms/separacao/marcar-realocacao`** mantém — usado quando operador pegou exatamente a qty sugerida sem necessidade de modal.

**`DELETE /api/wms/separacao/realocacao/[id]`** mantém. Sem cascade automático aqui (operador cancelou explicitamente; não dispara busca).

### Frontend

`src/app/wms/separacao/checklist/page.tsx`:

- Remover botão "Esgotado" das `ItemRow` normais (handler `handleEsgotadoPreview` segue existindo, mas só é chamado pelo modal automático de sem_cobertura).
- Renderizar linhas de realocação com a mesma estrutura visual de `ItemRow` (mesma grid, mesmo checkbox, botão "Parcial").
- Adicionar handler `handleParcialRealocacao(realocacaoId, qty, locZerou)` que chama `/api/wms/separacao/parcial` com body `{ realocacao_id }`.
- Mostrar TODAS as realocações (não só `aguardando_picking`) com badges semânticos:
  - `aguardando_picking` → badge "Aguardando" (warn) + ações ativas
  - `picado` → badge "Picado" (ok) + read-only
  - `picado_parcial` → badge "Picado N/M" (muted) + read-only — N = `quantidade_pega` da realocação, M = `quantidade` sugerida originalmente
  - `cancelado` → badge "Cancelada" (muted) + read-only, opacity reduzida
- Quando API retorna `sem_cobertura`, frontend dispara `handleEsgotadoPreview(sku)` automaticamente (reusa modal existente).
- Tratar resposta da API: `completo` → toast OK; `realocado` → toast com locs novas; `sem_cobertura` → não mostra toast (modal já abre).

### Erros + casos limite

- Parcial em realoc não-aguardando_picking → 409.
- `quantidade_pega > realoc.quantidade` → 400.
- Posição reservada por outro pedido (`disponivel < quantidade_pega`) → 409 com payload `{ error: 'posicao_reservada', ... }` (lógica idêntica ao item pai).
- Pedido fica `pendente_realocacao` apenas se a UI não consegue ofertar alternativa (sem galpões alternativos E não cria OC pelo modal).
- Idempotência: chamar parcial 2x na mesma realocação dá 409 (status já é `picado*`).
- Compatibilidade: realocações criadas pelo fluxo antigo (sem `parent_realocacao_id`, sem `parcial`) continuam funcionando com `marcar-realocacao` (qty cheia, status `picado`).

### Histórico (`registrarEvento`)

Eventos novos:
- `realocacao_parcial` — quando uma realocação dá parcial mas cobre.
- `realocacao_parcial_cascade` — quando uma realocação dá parcial e gera novas realocações.
- `realocacao_sem_cobertura_cascade` — quando cascade falha após realocação.

Mantém: `parcial_loc_zerou`, `realocacao_picada`, `realocacao_cancelada`, `realocacao_sem_cobertura_galpao`.

## Testes

- `realocacao-resolver.test.ts` ganha cases pra `localizacoes_excluir` com 1+ items.
- Novo `parcial-cascade.test.ts` testando: cascade simples, cascade duplo, sem cobertura, empréstimo no cascade, idempotência.
- Manual: cenários A/B/C do workflow.html devem rodar end-to-end em staging.

## Out of scope

- Mudança no modelo de empréstimos (continua via `is_emprestimo + empresa_devedora_id`).
- Cascade entre galpões (só dentro do mesmo galpão; cross-galpão segue via modal encaminhar).
- Refator do `siso_pedido_itens` pra mover qty pega/parcial pra outra tabela.
- UX da tela de supervisor pra `pendente_realocacao` (continua como hoje).
