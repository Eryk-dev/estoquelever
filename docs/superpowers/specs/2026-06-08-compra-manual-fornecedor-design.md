# Compra Manual de Fornecedor (compra avulsa) — Design

**Data:** 2026-06-08
**Branch:** `feat/compra-manual-fornecedor`
**Status:** aprovado (brainstorming)

## Problema

O módulo de compras hoje é 100% puxado por pedido de cliente: itens de pedidos com
`decisao_final='oc'` entram em `siso_pedido_itens.compra_status='aguardando_compra'`, aparecem
na aba *Comprar* agrupados por fornecedor (inferido pelo prefixo do SKU), e seguem
*Comprar → Receber → estoque*.

Não há como o operador **iniciar uma compra por conta própria** — comprar estoque de forma
proativa (reposição, compra oportunista, compra que não nasceu de um pedido). E o fornecedor
nunca é escolhido; é sempre inferido do SKU.

## Objetivo

Operador cria uma **compra manual** de **qualquer fornecedor**, com ciclo completo:

> escolhe/cria fornecedor + empresa + galpão + SKUs/qty → compra fica "pendente de receber"
> → quando a mercadoria chega, recebe (parcial permitido) → gera movimento `E` no ledger
> (custo médio atualiza) → put-away normal leva à picking → estoque vira fungível e o
> reconciliador de OC já existente puxa pra pedidos OC parados, sem fiação nova.

### Critérios de sucesso (verificáveis)

1. Operador cria compra manual via UI e ela aparece como pendente de receber.
2. Fornecedor inexistente pode ser criado inline (vira registro em `siso_fornecedores`).
3. SKU inexistente pode virar produto mínimo inline (vira registro em `siso_produtos`).
4. Receber (total ou parcial) gera movimento `E` em `siso_movimentacoes`
   (`origem_tipo='nf_compra_manual'`), atualiza `siso_estoque` e recalcula custo médio.
5. Receber 2x a mesma quantidade não duplica o movimento `E` (idempotência por lock otimista).
6. Cancelar uma compra com qualquer item já recebido retorna erro (409); cancelar sem
   recebimento marca `status='cancelado'`.

## Fora de escopo (YAGNI)

- NF de entrada fiscal / integração Tiny da compra manual.
- Aprovação / workflow de OC, cotação ou comparação multi-fornecedor.
- Preço de tabela, lead time, ponto de pedido automático.
- Edição da compra após criada (cria nova / cancela; sem update de linhas nesta versão).

## Decisões (brainstorming)

| Tema | Decisão |
|---|---|
| Ciclo | Completo: comprar → receber → estoque |
| Fornecedor | Escolhe da lista **ou cria inline** → `siso_fornecedores` |
| SKU | Busca no catálogo **ou cria produto mínimo inline** → `siso_produtos` |
| Empresa | Operador escolhe → tag `empresa_compradora_id` no movimento |
| Arquitetura | Aggregate dedicado novo: `siso_compras_manuais` + `siso_compras_manuais_itens` |
| Galpão destino | Operador escolhe; default = galpão ativo (`X-Galpao-Id`) |
| Custo unitário | Informado no recebimento; opcional, cai no fallback `resolverCustoEntrada` |
| Cancelar | Só permitido enquanto nada foi recebido |
| UI | Botão "Nova compra manual" + aba "Manuais" (stream separado do pedido-driven) |
| Permissões | Reusa `compras.ver` / `compras.executar`; inline-create sob `compras.executar` |

## Modelo de dados

### Tabela: `siso_compras_manuais` (cabeçalho)

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `fornecedor_id` | uuid | FK → `siso_fornecedores(id)`, NOT NULL |
| `empresa_compradora_id` | uuid | FK → `siso_empresas(id)`, NOT NULL |
| `galpao_id` | uuid | FK → `siso_galpoes(id)`, NOT NULL |
| `status` | text | `comprado \| parcial \| recebido \| cancelado`, default `comprado`, CHECK |
| `observacao` | text | nullable |
| `criado_por` | uuid | FK → `siso_usuarios(id)` |
| `criado_em` | timestamptz | default `now()` |
| `recebido_em` | timestamptz | nullable; setado quando `status='recebido'` |

### Tabela: `siso_compras_manuais_itens` (linhas)

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `compra_id` | uuid | FK → `siso_compras_manuais(id)` ON DELETE CASCADE, NOT NULL |
| `produto_id` | uuid | FK → `siso_produtos(id)`, NOT NULL |
| `qty_comprada` | numeric | CHECK `> 0` |
| `qty_recebida` | numeric | default `0`, CHECK `>= 0` |
| `custo_unitario` | numeric | nullable (informado no recebimento) |
| | | CHECK `qty_recebida <= qty_comprada` |

Índice: `(compra_id)` e `(produto_id)` para as queries de listagem/recebimento.

### Ledger

- Nova `OrigemTipo`: **`'nf_compra_manual'`**.
  - Adicionar ao CHECK de `siso_movimentacoes.origem_tipo`.
  - Adicionar à whitelist de recálculo de custo médio (hoje: `nf_compra`,
    `devolucao_cliente_integra`, `lancamento_retroativo`). **Sem isso o custo médio não
    atualiza na compra manual** — localizar a whitelist (RPC `wms_inserir_movimentacao`
    e/ou `src/lib/wms/custo-medio.ts`) e incluir o novo valor.
- Idempotência de recebimento: **sem** NF, logo não usa a unique constraint
  `uq_mov_recebimento_nf_chave`. Usa lock otimista em `siso_compras_manuais_itens.qty_recebida`
  (mesmo padrão do `/api/wms/compras/receber` atual: `.eq("qty_recebida", jaRecebido)` detecta
  corrida e evita dupla baixa).

## Lifecycle (status do cabeçalho)

```
comprado ──(recebe parte)──> parcial ──(recebe resto)──> recebido
   │                            │
   └──(cancela, 0 recebido)─────┴──> cancelado   [bloqueado se qty_recebida > 0 em qualquer item]
```

- `recebido` quando, para todos os itens, `qty_recebida == qty_comprada`.
- `parcial` quando algum item tem `0 < qty_recebida < qty_comprada` (ou itens em estados mistos).
- `cancelado` só a partir de `comprado` (nenhum item recebido).

## API — `/api/wms/compras-manuais`

Todas as respostas de erro via `wmsErrorResponse({...})`. Auth via `getSessionUser(req)`.

### `POST /api/wms/compras-manuais`
- Guard: `userCan(session, "compras.executar")`.
- Body:
  ```ts
  {
    fornecedor_id: string,            // uuid
    empresa_compradora_id: string,    // uuid
    galpao_id: string,                // uuid
    observacao?: string,
    itens: { produto_id: string, qty_comprada: number, custo_unitario?: number }[]
  }
  ```
- Validação (Zod): fornecedor/empresa/galpão existem; `itens` não vazio; `qty_comprada > 0`.
- Cria cabeçalho (`status='comprado'`, `criado_por=session.userId`) + itens. Atômico.
- Retorna `{ ok: true, compra_id, itens_criados }`.

### `GET /api/wms/compras-manuais?status=`
- Guard: `userCan(session, "compras.ver")`.
- `status` opcional: `pendentes` (comprado+parcial) | `recebido` | `cancelado`. Default `pendentes`.
- Retorna compras com itens (sku/descrição via JOIN `siso_produtos`) e nome do fornecedor,
  agrupado/ordenado por fornecedor + `criado_em`.

### `POST /api/wms/compras-manuais/[id]/receber`
- Guard: `userCan(session, "compras.executar")`.
- Body:
  ```ts
  { itens: { item_id: string, qty_recebida: number, custo_unitario?: number }[] }
  ```
- Para cada item:
  1. Lê `qty_recebida` atual (lock otimista).
  2. Resolve loc `tipo='recebimento'` do `galpao_id` da compra.
  3. Chama `gravarMovEntradaCompra()` reusado:
     - `origem_tipo = 'nf_compra_manual'`, `origem_id = null` (sem pedido),
       `origem_detalhes = { compra_id, compra_item_id, sku }`,
       `empresa_compradora_id = compra.empresa_compradora_id`,
       `fornecedor_id = compra.fornecedor_id`, `custo_unitario`.
  4. Update `qty_recebida += qty` com `.eq("qty_recebida", jaRecebido)`; recompute `status`.
- **Não** chama `checkAndReleasePedidos` (não há pedido). A liberação de pedidos OC parados
  acontece via reconciliador-oc, disparado pelo próprio movimento `E` após put-away.
- Retorna `{ ok: true, movs_criadas, status }`.

### `DELETE /api/wms/compras-manuais/[id]`
- Guard: `userCan(session, "compras.executar")`.
- Se algum item tem `qty_recebida > 0` → 409 (`conflict`, não cancelável).
- Senão: `status='cancelado'`. Retorna `{ ok: true }`.

### Inline-create (reuso, sem rota nova)
- Fornecedor: o modal chama `POST /api/wms/fornecedores` existente antes do POST da compra.
- Produto mínimo: o modal chama o endpoint de criação de produto existente
  (`/api/wms/produtos`) com sku + descrição; campos fiscais ficam default/null.

## UI/UX — `src/app/wms/compras/page.tsx`

- **Botão "Nova compra manual"** no header → modal:
  - Empresa (dropdown `siso_empresas`).
  - Galpão (dropdown `siso_galpoes`, default = galpão ativo do header).
  - Fornecedor: busca em `siso_fornecedores` + ação "criar fornecedor" inline.
  - Linhas: SKU (busca em `siso_produtos` + ação "criar produto" inline) + qty + custo opcional.
- **Nova aba "Manuais"**: lista compras manuais (pendentes de receber + recebidas), com o
  recebimento inline na mesma aba (qty por item + custo). Stream separado do pedido-driven
  — consistente com o aggregate dedicado.

## Recebimento → estoque → reconciliação (emergente)

O movimento `E` cai na localização `tipo='recebimento'` do galpão (mesma resolução do
`gravarMovEntradaCompra`). O fluxo de guarda/put-away existente leva o saldo pra `picking`.
O `reconciliador-oc` já dispara em qualquer `E` que chega na picking e puxa, FIFO, pra
pedidos OC parados (`validacao_oc`/`aguardando_compra`). **Nenhuma fiação nova** — a compra
manual só injeta saldo; o resto do sistema já reage.

## Permissões

Reusa `compras.ver` (listar) e `compras.executar` (criar / receber / cancelar). Criação inline
de fornecedor/produto também sob `compras.executar` (evita fricção operacional). Sem código
de permissão novo.

## Estratégia de testes (TDD)

- **Unit** (`vitest`): função pura de cálculo de `status` (parcial/total/cancelável); guard de
  cancelar-com-recebido.
- **Integration** (staging real, `npm run test:integration`):
  - criar → receber total → assert `E` no ledger + `siso_estoque.saldo` sobe + custo médio recalcula.
  - receber parcial 2x → `status` transita `comprado → parcial → recebido`.
  - cancelar pós-recebimento → 409.
  - receber 2x mesma qty → não duplica `E` (idempotência).

## Arquivos afetados (estimativa)

- **Migration:** `supabase/migrations/2026MMDD_compra_manual.sql` (2 tabelas + CHECK do
  `origem_tipo` + whitelist custo médio).
- **Backend:** `src/app/api/wms/compras-manuais/route.ts`,
  `src/app/api/wms/compras-manuais/[id]/receber/route.ts`,
  `src/app/api/wms/compras-manuais/[id]/route.ts`,
  `src/lib/wms/compras-manuais.ts` (lógica de domínio + reuso de `gravarMovEntradaCompra`),
  `src/lib/wms/types.ts` (`OrigemTipo`).
- **Frontend:** `src/app/wms/compras/page.tsx` (botão + aba + modal).
- **Docs:** `docs/api-reference-complete.md`, `docs/database-schema.md`, `erros-conhecidos.yaml`
  (se surgir bug), `CLAUDE.md` (nova lib + tabelas).

## Riscos / pontos de atenção

1. **Whitelist de custo médio** — se esquecer de incluir `nf_compra_manual`, custo médio não
   atualiza e ninguém percebe (degrada silencioso). É o risco nº 1.
2. **Reuso de `gravarMovEntradaCompra`** — hoje a função assume contexto de `pedido_item`
   (resolve galpão via `pedido.separacao_galpao_id`). Precisa de um caminho que aceite
   `galpao_id` direto + `pedido_id = null`. Pode exigir refatorar a assinatura ou extrair o
   núcleo de "inserir E de compra" pra `src/lib/wms/compras-manuais.ts`.
3. **Criação de produto inline sem fiscal** — produto nasce sem dados fiscais; ok pra WMS
   (Tiny é a camada fiscal), mas validar que não quebra telas que assumem fiscal preenchido.
