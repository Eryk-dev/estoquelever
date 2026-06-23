# PRD: Validação de OC na Separação

## 1. Introdução/Overview

Atualmente, quando o SISO identifica que um pedido precisa de OC (Ordem de Compra), o pedido vai direto para a aba "Aguardando OC" e só aparece para separação depois que os itens são comprados e recebidos. O problema é que a sugestão de OC é baseada em estoque do sistema — que pode estar desatualizado. Itens marcados como "sem estoque" podem existir fisicamente no galpão.

Esta feature introduz uma **fase de validação física de OC** dentro do fluxo de separação. Após aprovação, o execution worker roda normalmente (marcadores + NF + agrupamento), mas ao invés de enviar itens direto para compras, marca-os como `oc_pendente`. O pedido entra em `status_separacao: "validacao_oc"` — um novo status dedicado. O operador então valida fisicamente cada item: se encontra no estoque, o item volta para separação normal; se confirma esgotado, vai para compras. Somente itens confirmados como esgotados pelo operador aparecem no módulo de Compras.

## 2. Goals

- Reduzir compras desnecessárias eliminando falsos-positivos de "sem estoque"
- Dar ao operador de separação a decisão final sobre disponibilidade física
- Manter o fluxo de compras limpo — comprador só vê itens que realmente precisam ser comprados
- Não quebrar o fluxo existente de separação para pedidos propria/transferencia
- Unificar a experiência: operador trabalha em uma única tela para conferência OC + separação normal

## 3. User Stories

### US-001: Pedido OC entra na separação com status "validacao_oc"

**Description:** Como operador de separação, quero que pedidos aprovados como OC apareçam para validação física na separação, para que eu possa conferir se os itens realmente estão esgotados antes de enviar para compras.

**Acceptance Criteria:**
- [ ] Ao aprovar um pedido com `decisao: "oc"`, o execution worker roda normalmente (marcadores + NF + agrupamento)
- [ ] O worker usa `resolveCompraItemIds` para identificar quais itens realmente não têm estoque — **apenas esses itens** recebem `compra_status: "oc_pendente"` (itens com estoque continuam com `compra_status: null`)
- [ ] O worker preenche `fornecedor_oc` via `getFornecedorBySku()` no loop de itens faltantes (campo não é setado hoje — precisa ser adicionado ao worker)
- [ ] O pedido recebe `status_separacao: "validacao_oc"` (novo status)
- [ ] Se o worker detecta que nenhum item está realmente em falta (`compraDemandas.length === 0`), o fluxo existente é mantido: pedido vira `propria` e segue para separação normal (sem mudança)
- [ ] A aba "Aguardando OC" na separação mostra pedidos em `validacao_oc` (tag "OC Pendente") e pedidos em `aguardando_compra` (tag "OC Confirmada")
- [ ] Pedido OC é visualmente distinguível na listagem (badge/tag "OC")

### US-002: Seção de Conferência OC na tela de separação

**Description:** Como operador de separação, ao iniciar a separação de pedidos que incluem itens OC, quero ver uma seção visualmente destacada no topo do checklist com os itens OC, usando a **mesma interface e interação** do checklist normal de separação.

**Acceptance Criteria:**
- [ ] Na tela de checklist (`/separacao/checklist`), quando há itens com `compra_status = "oc_pendente"`, aparece uma seção "Conferência OC" no topo
- [ ] A seção é visualmente delimitada (borda, background amber/diferente, título claro) mas usa o **mesmo componente de item** do checklist normal (`item-separacao-row` ou equivalente)
- [ ] Cada item OC mostra os mesmos dados do checklist normal: foto do produto, SKU, descrição, quantidade, localização, estoque
- [ ] Itens OC são listados consolidados por SKU, com ordenação própria por localização (independente da seção normal)
- [ ] A chave de consolidação deve ser `produto_id + is_oc` para evitar merge entre itens OC e normais do mesmo SKU em wave picking multi-pedido
- [ ] A seção de separação normal aparece logo abaixo, com seus itens e sua própria ordenação por localização
- [ ] Se não houver itens OC nos pedidos selecionados, a seção de conferência não aparece

### US-003: Marcar item OC como encontrado (clique = bipado)

**Description:** Como operador, quando encontro fisicamente um item OC no galpão, quero clicar nele (mesma interação do checklist normal) para marcá-lo como encontrado E separado em um único passo.

**Acceptance Criteria:**
- [ ] O operador clica no item OC da mesma forma que clica em qualquer item do checklist normal
- [ ] O item fica verde (mesmo visual de "marcado/bipado" do checklist normal)
- [ ] Em um único passo: o `compra_status` é setado para `null` (sai da lista OC), os campos `fornecedor_oc`/`compra_quantidade_solicitada`/`compra_solicitada_em` são limpos, E o item é marcado como `separacao_marcado = true` + `bipado_completo = true`
- [ ] O item permanece na seção de conferência OC (agora verde), **não** se move para a seção normal — já está concluído
- [ ] Se todos os itens OC do pedido forem marcados como encontrados, o pedido transiciona de `validacao_oc`/`em_separacao` e `decisao_final` atualiza de `"oc"` para `"propria"`
- [ ] Um registro é criado no histórico: `"oc_item_encontrado"` com SKU e operador
- [ ] O operador pode desfazer (desmarcar) enquanto estiver na mesma sessão e antes de concluir — item volta a amarelo/pendente

### US-004: Marcar item OC como esgotado

**Description:** Como operador, quando confirmo que um item OC realmente não existe no estoque físico, quero usar o botão de esgotado (mesmo botão que já existe no checklist normal) para enviá-lo para compras.

**Acceptance Criteria:**
- [ ] O item OC tem o **mesmo botão de esgotado** que já existe no checklist de separação normal
- [ ] Ao clicar em esgotado, o `compra_status` do item muda de `"oc_pendente"` para `"aguardando_compra"`
- [ ] O `fornecedor_oc`, `compra_quantidade_solicitada` e `compra_solicitada_em` são preenchidos (se não estiverem)
- [ ] Uma OC é criada/vinculada automaticamente (mesma lógica de `produto-esgotado/route.ts`)
- [ ] O item aparece na seção de conferência com visual de esgotado (cinza/riscado, mesmo visual que o checklist normal usa para esgotado)
- [ ] Um registro é criado no histórico: `"oc_item_confirmado"` com SKU e operador
- [ ] O item agora aparece no módulo de Compras para o comprador
- [ ] O operador pode desfazer enquanto estiver na mesma sessão e antes de concluir

### US-005: Resolução e transição do pedido após conferência OC

**Description:** Como sistema, preciso gerenciar corretamente as transições do pedido conforme os itens OC são validados pelo operador.

**Acceptance Criteria:**
- [ ] O pedido não pode ser concluído (`/api/separacao/concluir`) se houver itens com `compra_status = "oc_pendente"` (todos devem ser resolvidos como "encontrei" ou "esgotado")
- [ ] Os itens de separação normal (sem `compra_status`) podem ser bipados/marcados **em paralelo** enquanto os itens OC estão pendentes
- [ ] Após todos os itens OC resolvidos:
  - Se **nenhum** item ficou como `aguardando_compra` (todos encontrados): pedido transiciona para `aguardando_separacao` ou `em_separacao`, `decisao_final` atualiza para `"propria"`, e segue separação normal
  - Se **todos** os itens OC ficaram como `aguardando_compra` E não há itens normais: pedido transiciona automaticamente para `aguardando_compra` (sem precisar "concluir" formalmente)
  - Se **mix** (alguns encontrados, alguns esgotados) E há itens normais: itens normais continuam separação, pedido permanece em `em_separacao` enquanto operador bipa itens normais
- [ ] Ao concluir separação com itens `aguardando_compra` (via endpoint `concluir`):
  - O `concluir` deve **excluir** itens com `compra_status` em `["aguardando_compra", "comprado"]` da verificação de completude (`separacao_marcado`)
  - Se todos os itens restantes (normais) estão marcados: pedido transiciona para `"aguardando_compra"` (não `"separado"`)
  - Os itens normais já bipados **preservam** `separacao_marcado = true` e `bipado_completo = true` (NÃO resetar)
- [ ] Quando os itens OC são comprados e recebidos (fluxo `compras-release.ts`), o pedido volta para `aguardando_separacao` com itens normais preservando estado de separação anterior
- [ ] Na re-separação pós-compras, o operador só precisa bipar os itens recebidos (os normais já estão marcados)

### US-006: Aba "Aguardando OC" com sub-estados

**Description:** Como operador, quero ver na aba "Aguardando OC" da separação tanto pedidos pendentes de validação quanto pedidos confirmados aguardando compra, com tags visuais para distinguir.

**Acceptance Criteria:**
- [ ] A aba "Aguardando OC" mostra pedidos com `status_separacao` em `["validacao_oc", "aguardando_compra"]`
- [ ] Pedidos mostram tags visuais por `status_separacao`:
  - **"OC Pendente"** (amarelo/amber): `status_separacao = "validacao_oc"` — operador ainda não validou fisicamente
  - **"OC Confirmada"** (vermelho/red): `status_separacao = "aguardando_compra"` — todos os itens OC confirmados esgotados, aguardando compras
- [ ] Pedidos com tag "OC Pendente" podem ser selecionados para iniciar separação (abre checklist com seção de conferência)
- [ ] Pedidos com tag "OC Confirmada" mostram progresso de compras (barra de progresso existente: aguardando/comprado/recebido)
- [ ] Contadores da aba: total = `validacao_oc` + `aguardando_compra`, com sub-contadores para cada
- [ ] A contagem é eficiente: filtro por `status_separacao` (índice existente), sem necessidade de join em itens

### US-007: Compras só recebe itens com OC confirmada

**Description:** Como comprador, quero ver no módulo de Compras apenas itens que o operador de separação confirmou como esgotados, para não comprar itens que podem ser encontrados no galpão.

**Acceptance Criteria:**
- [ ] API `/api/compras/route.ts` (tab "Comprar") filtra apenas itens com `compra_status = "aguardando_compra"` (já é assim)
- [ ] Itens com `compra_status = "oc_pendente"` **nunca** aparecem no módulo de compras (naturalmente excluídos pelo filtro existente)
- [ ] O fluxo de compras existente (comprar → receber → release) não é alterado
- [ ] Zero mudanças necessárias no módulo de compras

## 4. Functional Requirements

**FR-1:** Novo valor de `compra_status`: `"oc_pendente"` — representa item identificado como faltante pelo sistema mas ainda não validado fisicamente pelo operador. Adicionar ao tipo `CompraStatus` em `src/types/index.ts`.

**FR-2:** Novo valor de `status_separacao`: `"validacao_oc"` — representa pedido com itens OC aguardando validação física do operador. Adicionar ao tipo `StatusSeparacao` e ao interface `SeparacaoCounts` em `src/types/index.ts`.

**FR-3:** Modificar `executarMarcadoresOnly` em `execution-worker.ts`:
  - Itens faltantes: setar `compra_status: "oc_pendente"` (antes: `"aguardando_compra"`)
  - Itens faltantes: setar `fornecedor_oc` via `getFornecedorBySku(sku)` (novo — worker não setava antes)
  - **Expandir `resolveCompraItemIds`**: a função atualmente retorna `{ id, quantidadeSolicitada }`. Deve ser estendida para também retornar `sku` — mudar `.select("id, produto_id, quantidade_pedida")` para `.select("id, produto_id, quantidade_pedida, sku")` e o tipo de retorno para `{ id, sku, quantidadeSolicitada }`
  - Pedido: setar `status_separacao: "validacao_oc"` (antes: `"aguardando_compra"`)
  - O restante do worker (marcadores, NF, agrupamento, lógica de `resolveCompraItemIds`) permanece inalterado
  - O caso `compraDemandas.length === 0` (nenhum item faltante) continua como está (converte para `propria`)

**FR-4:** Modificar `aprovar/route.ts`: manter `status_separacao: null` quando `decisao === "oc"` — o worker sobrescreve para `"validacao_oc"` logo em seguida. A janela de invisibilidade é curta (segundos) e é o mesmo padrão já existente para OC. NÃO setar `"validacao_oc"` diretamente na aprovação para evitar que o pedido apareça na UI antes do worker completar (sem NF, sem marcadores).

**FR-5:** Modificar `iniciar/route.ts` (3 mudanças obrigatórias):
  - **Linha 74** — Adicionar `"validacao_oc"` ao `ALLOWED_STATUSES`
  - **Linhas 102-108** — Adicionar `"validacao_oc"` ao filtro `toStart`:
    ```typescript
    .filter(p =>
      (p.status_separacao === "aguardando_separacao" || p.status_separacao === "validacao_oc") &&
      !pedidosWithPendingCompra.has(p.id),
    )
    ```
  - **Linha 119** — Mudar o guard do DB update de `.eq("status_separacao", "aguardando_separacao")` para `.in("status_separacao", ["aguardando_separacao", "validacao_oc"])` — **sem isso, o update é silenciosamente ignorado para pedidos `validacao_oc`** (o filtro JS passa mas o WHERE do Supabase falha)
  - A blindagem para itens `aguardando_compra`/`comprado` permanece. Itens `oc_pendente` NÃO bloqueiam.

**FR-6:** Novo endpoint `POST /api/separacao/validar-oc-item`:
  - Autenticação: requer sessão válida (`X-Session-Id`)
  - Body: `{ item_ids: string[], acao: "encontrei" | "esgotado" }`
  - `encontrei`: seta `compra_status = null`, limpa `fornecedor_oc`/`compra_quantidade_solicitada`/`compra_solicitada_em`/`ordem_compra_id`, E seta `separacao_marcado = true` + `bipado_completo = true` + `quantidade_bipada = quantidade_pedida` (marcar como encontrado = bipado em um único passo)
  - `esgotado`: seta `compra_status = "aguardando_compra"`, preenche `compra_quantidade_solicitada` (= `quantidade_pedida`), `compra_solicitada_em`, cria/vincula OC (reutilizar lógica de `produto-esgotado/route.ts`)
  - Após processar itens, verificar **por pedido** se todos os itens `oc_pendente` foram resolvidos e executar transições automáticas (ver FR-8, FR-9)
  - Registrar evento no histórico (`"oc_item_encontrado"` ou `"oc_item_confirmado"`)
  - Response: `{ itens_atualizados: number, transicoes: Array<{ pedido_id, novo_status }> }`

**FR-7:** Modificar `concluir/route.ts`:
  - Adicionar `compra_status` ao `select` de itens (atualmente só busca `id, pedido_id, separacao_marcado`)
  - **Bloquear** com erro 400 se houver itens com `compra_status = "oc_pendente"` (mensagem: "Há itens OC não validados")
  - **Excluir** itens com `compra_status` em `["aguardando_compra", "comprado"]` da verificação de completude (`separacao_marcado`) — esses itens estão em compras e não precisam ser bipados
  - Se todos os itens restantes (normais) estão marcados E há itens `aguardando_compra`/`comprado`: transicionar para `"aguardando_compra"` ao invés de `"separado"`
  - **NÃO setar** `separacao_concluida_em` neste branch (não é uma separação concluída, é uma pausa parcial para compras; o timestamp será setado na conclusão final após compras)
  - **NÃO resetar** `separacao_marcado`/`bipado_completo`/`quantidade_bipada` nos itens normais

**FR-8:** Transição automática quando todos os itens OC de um pedido são confirmados esgotados E o pedido não tem itens normais (pedido 100% OC): transicionar automaticamente para `status_separacao: "aguardando_compra"` sem necessidade de "concluir". Deve também limpar `separacao_operador_id` e `separacao_iniciada_em` (a sessão de separação acabou para este pedido). **NÃO setar** `separacao_concluida_em`. Executada dentro do endpoint `validar-oc-item` (FR-6).

**FR-9:** Transição automática quando todos os itens OC de um pedido são marcados como "encontrei": transicionar pedido de `validacao_oc` para `aguardando_separacao` (se não iniciado) ou manter em `em_separacao` (se já iniciado). Se `decisao_final` era `"oc"`, atualizar para `"propria"`. Executada dentro do endpoint `validar-oc-item` (FR-6).

**FR-10:** O endpoint `GET /api/separacao/checklist-items` já retorna `compra_status` por item. Verificar que itens `oc_pendente` são incluídos no resultado (não filtrados). Verificado: o filtro de `aguardando_compra` em linha 153 só se aplica quando `pedidoStatus === "aguardando_compra"`, não para `em_separacao`.

**FR-11:** Modificar `GET /api/separacao/route.ts` (lista de separação):
  - Adicionar `"validacao_oc"` a `VALID_STATUSES` e `COUNT_STATUSES`
  - Adicionar `validacao_oc: number` a `SeparacaoCounts` (contagem separada no backend)
  - **Estratégia de query** (frontend-side): a aba "Aguardando OC" no frontend soma `counts.validacao_oc + counts.aguardando_compra` para o badge total. Para listar pedidos, o frontend faz a query com `?status_separacao=validacao_oc` ou `?status_separacao=aguardando_compra` dependendo do sub-filtro ativo (ou ambas em sequência). **NÃO** sobrecarregar o backend para retornar dois status em uma query — manter a API pura (1 filtro = 1 status)
  - Desacoplar `VisibleSeparacaoTab` de `StatusSeparacao` em `separacao/page.tsx` — a aba "Aguardando OC" (ID: `aguardando_compra`) mapeia para dois status (`aguardando_compra` + `validacao_oc`)
  - Adicionar `"oc_pendente"` como categoria no cálculo de `compraStats` (novo campo `oc_pendente: number`) para que o progresso seja preciso
  - Badge do módulo Compras em `dashboard/counts/route.ts` **NÃO** inclui `validacao_oc` (apenas `aguardando_compra`) — consistente com US-007

**FR-12:** Ao voltar de compras (`compras-release.ts`): o pedido transiciona de `aguardando_compra` para `aguardando_separacao`. Os itens normais preservam `separacao_marcado = true`. Nenhuma mudança necessária no `compras-release.ts` — ele já faz `update status_separacao = 'aguardando_separacao'` sem tocar nos itens. Verificado.

## 5. Propagação do `validacao_oc` — Todos os Arquivos Impactados

Adicionar `"validacao_oc"` requer mudanças em múltiplos arquivos além dos FRs acima:

### Obrigatórios (sem isso, comportamento quebra)

| Arquivo | Mudança | Razão |
|---|---|---|
| `src/types/index.ts` | Adicionar `"validacao_oc"` a `StatusSeparacao` e `SeparacaoCounts` | Tipo e contagem |
| `src/app/api/separacao/route.ts` | `VALID_STATUSES`, `COUNT_STATUSES`, `emptyCounts` | Tab filtering e contagem |
| `src/app/api/separacao/iniciar/route.ts` | `ALLOWED_STATUSES` + filtro `toStart` | Sem isso pedidos ficam travados |
| `src/app/api/separacao/concluir/route.ts` | Guard `oc_pendente` + branch `aguardando_compra` | FR-7 |
| `src/app/api/separacao/cancelar/route.ts` | Ao cancelar, se itens são `oc_pendente` (não `aguardando_compra`), voltar para `validacao_oc` (não `aguardando_compra`) | Sem isso, cancelar envia pedido pro status errado |
| `src/app/api/separacao/voltar-etapa/route.ts` | Adicionar `"validacao_oc"` ao `STATUS_ORDER` (entre `aguardando_nf` e `aguardando_separacao`) | Sem isso, admin não consegue mover pedidos |
| `src/app/api/dashboard/counts/route.ts` | Incluir `validacao_oc` na contagem do badge de separação | Sem isso, pedidos ficam invisíveis no home |
| `src/app/separacao/page.tsx` | `TAB_CONFIG`, `EMPTY_COUNTS`, `MOVE_TARGETS` | Tab OC deve incluir `validacao_oc` |
| `src/lib/execution-worker.ts` | `oc_pendente` + `validacao_oc` + `fornecedor_oc` | FR-3 (core da feature) |

### Cosméticos (sem isso, renderiza string crua mas não quebra)

| Arquivo | Mudança | Razão |
|---|---|---|
| `src/components/separacao/separacao-card.tsx` | `isAguardandoOC` check deve incluir `validacao_oc`. Adicionar `oc_pendente` ao `compraStats`. | Card rendering correto |
| `src/app/pedidos/page.tsx` | `STATUS_SEPARACAO_COLORS`, `STATUS_SEPARACAO_LABELS`, filtros | Label e cor corretos |
| `src/app/pedidos/[id]/page.tsx` | `STATUS_SEPARACAO_COLORS`, `STATUS_SEPARACAO_LABELS` | Label e cor na tela de detalhe |

### Verificados sem impacto (não precisa mudar)

| Arquivo | Razão |
|---|---|
| `src/lib/nf-webhook-handler.ts` | Só transiciona `aguardando_nf` → `aguardando_separacao`. Pedido já tem NF quando chega em `validacao_oc`. |
| `src/app/api/separacao/reiniciar/route.ts` | Só aceita `em_separacao`/`separado`. Não impactado. |
| `src/app/api/separacao/forcar-pendente/route.ts` | Só opera em `aguardando_nf`. Não impactado. |
| `src/app/api/separacao/encaminhar/route.ts` | Só aceita `aguardando_separacao`/`em_separacao`. Intencional não encaminhar OC. |
| `src/app/api/separacao/marcar-item/route.ts` | Requer `em_separacao`. Pedido já transitou via `iniciar`. OK. |
| `src/app/api/separacao/checklist-items/route.ts` | Filtro de OC items só aplica para `aguardando_compra`. `em_separacao` mostra tudo. OK. |
| `src/hooks/use-realtime-separacao.ts` | Status-agnostic. Não impactado. |
| `src/lib/compras-release.ts` | Só opera em `aguardando_compra`/`comprado`. Não impactado. |

## 6. Non-Goals (Out of Scope)

- **Não alterar** o fluxo de compras (comprar/receber/equivalente/cancelamento) — apenas mudar quando itens entram nesse fluxo
- **Não alterar** a lógica de `resolveCompraItemIds` no worker — ela já identifica corretamente quais itens faltam; a mudança é no status que recebem
- **Não criar** componente novo para a conferência OC — reutilizar o mesmo componente de item do checklist normal
- **Não alterar** o fluxo de pedidos `propria` ou `transferencia`
- **Não alterar** o endpoint `produto-esgotado` existente — ele continua funcionando para itens que são descobertos esgotados DURANTE a separação normal (caso diferente da validação OC pré-separação)
- **Não alterar** auto-aprovação — pedidos OC nunca são auto-aprovados (o webhook processor só auto-aprova `propria`); isso não muda
- **Não gerar** NF em momento diferente — o worker continua gerando NF na aprovação (cria reserva no Tiny); isso não muda

## 7. Technical Considerations

### Novo CompraStatus e StatusSeparacao

Adicionar a `src/types/index.ts`:
- `"oc_pendente"` ao tipo `CompraStatus`
- `"validacao_oc"` ao tipo `StatusSeparacao`
- `validacao_oc: number` ao interface `SeparacaoCounts`

### State Machine do Pedido OC (novo fluxo)

```
webhook → sugestao: "oc" → status: "pendente", status_separacao: null
    ↓
operador aprova (decisao: "oc") → status: "executando", status_separacao: null
    ↓
execution worker roda:
  ├─ marcadores no Tiny ✓
  ├─ gera NF (cria reserva Tiny, sem deduzir saldo) ✓
  ├─ agrupamento fase-1 ✓
  └─ resolveCompraItemIds:
       ├─ nenhum item faltante → decisao_final: "propria", status_separacao: "aguardando_nf"/"aguardando_separacao" (sem mudança)
       └─ itens faltantes → compra_status: "oc_pendente" + fornecedor_oc, status_separacao: "validacao_oc"
    ↓
aba "Aguardando OC" mostra pedido com tag "OC Pendente"
    ↓
operador inicia separação → status_separacao: "em_separacao"
    ↓
tela de checklist: seção "Conferência OC" (top) + seção separação normal (bottom)
    ↓
para cada item OC (mesma interface do checklist normal):
    ├─ clique no item (verde) → compra_status: null + separacao_marcado: true (encontrado + bipado em 1 passo)
    └─ botão esgotado → compra_status: "aguardando_compra" → cria/vincula OC → item fica cinza
    ↓
todos os itens OC resolvidos:
    ├─ todos encontrados → decisao_final: "propria" → separação normal → concluir → separado
    ├─ todos esgotados + sem itens normais → auto-transição → "aguardando_compra" (sem concluir)
    └─ mix → operador conclui separação dos normais → concluir → "aguardando_compra" (preservando separacao_marcado)
         ↓
         compras: comprar → receber → compras-release
         ↓
         pedido volta para "aguardando_separacao" (itens normais já marcados)
         ↓
         operador re-separa apenas itens recebidos → concluir → separado
```

### Cancelamento de separação OC

Quando operador cancela uma separação que veio de `validacao_oc`:
- Se itens têm `compra_status = "oc_pendente"` → pedido volta para `validacao_oc` (não `aguardando_compra`)
- Se itens têm `compra_status = "aguardando_compra"` (já confirmados) → pedido vai para `aguardando_compra`
- Lógica no `cancelar/route.ts`: distinguir `oc_pendente` de `aguardando_compra` ao decidir o status de retorno

### Fluxo de Status do Item OC

```
worker identifica item sem estoque
    ↓
compra_status = "oc_pendente" + fornecedor_oc preenchido
    ↓
operador valida fisicamente (mesma interface do checklist):
    ├─ clique (verde) → compra_status = null + separacao_marcado = true (encontrado + bipado)
    └─ esgotado       → compra_status = "aguardando_compra" (vai pra compras)
                          ↓
                     compra → comprado → recebido → pedido volta pra separação
```

### Mudanças no Execution Worker (`execution-worker.ts`)

A função `executarMarcadoresOnly` é o ponto central de mudança:

**Linha ~673** — Mudar status do pedido:
```typescript
// ANTES:
.update({ status_separacao: "aguardando_compra" })
// DEPOIS:
.update({ status_separacao: "validacao_oc" })
```

**Linha ~680** — Mudar status do item + adicionar `fornecedor_oc`:
```typescript
// ANTES:
compra_status: "aguardando_compra",
compra_quantidade_solicitada: demanda.quantidadeSolicitada,

// DEPOIS:
compra_status: "oc_pendente",
compra_quantidade_solicitada: demanda.quantidadeSolicitada,
fornecedor_oc: getFornecedorBySku(demanda.sku).fornecedor,  // NOVO — import getFornecedorBySku
```

> **Pré-requisito:** `resolveCompraItemIds` (linhas 467-557) atualmente retorna `{ id, quantidadeSolicitada }` sem SKU. A função deve ser expandida:
> - `.select("id, produto_id, quantidade_pedida")` → `.select("id, produto_id, quantidade_pedida, sku")`
> - Tipo de retorno: `Array<{ id: string; sku: string; quantidadeSolicitada: number }>`
> - No loop de montagem de `demandas` (linha 548): incluir `sku: String(item.sku ?? "")`

O restante da função (marcadores, NF, agrupamento, `resolveCompraItemIds`) permanece 100% inalterado. O caso `compraDemandas.length === 0` (linhas 609-666) continua como está.

### Mudanças no `aprovar/route.ts`

Manter `status_separacao: null` quando `decisao === "oc"` (linha 143-148). O worker sobrescreve para `"validacao_oc"` logo em seguida. NÃO setar `"validacao_oc"` diretamente na aprovação — isso faria o pedido aparecer na UI antes do worker completar (sem NF, sem marcadores, sem `oc_pendente` nos itens). A janela de invisibilidade (`null`) é curta (segundos) e é o mesmo padrão já existente.

### Mudanças no `concluir/route.ts`

O endpoint atual:
1. Busca itens com `select("id, pedido_id, separacao_marcado")` — **expandir** para incluir `compra_status`
2. Verifica `marks.every(Boolean)` — **excluir** itens com `compra_status` em `["aguardando_compra", "comprado"]` desta verificação
3. Transiciona para `"separado"` — **adicionar branch**: se itens `aguardando_compra`/`comprado` existem, transicionar para `"aguardando_compra"` ao invés de `"separado"`
4. **Adicionar** guard: se itens `oc_pendente` existem, retornar erro 400

### Mudanças no `cancelar/route.ts`

A lógica atual (linhas 52-58) verifica `compra_status != null` para decidir entre `aguardando_compra` e `aguardando_separacao`. Com `oc_pendente`:
- Se ALGUM item tem `compra_status = "oc_pendente"` → voltar para `validacao_oc`
- Se itens têm `compra_status = "aguardando_compra"` (sem `oc_pendente`) → voltar para `aguardando_compra`
- Se nenhum item tem `compra_status` → voltar para `aguardando_separacao`

### Impacto na Blindagem (`iniciar/route.ts`)

Duas mudanças necessárias:

**1. Linha 74** — Adicionar `"validacao_oc"` ao `ALLOWED_STATUSES`:
```typescript
const ALLOWED_STATUSES = ["aguardando_separacao", "aguardando_compra", "validacao_oc", "em_separacao"];
```

**2. Linhas 102-108** — Adicionar `"validacao_oc"` ao filtro `toStart`:
```typescript
const toStart = (pedidos ?? [])
  .filter(
    (p) =>
      (p.status_separacao === "aguardando_separacao" || p.status_separacao === "validacao_oc") &&
      !pedidosWithPendingCompra.has(p.id),
  )
  .map((p) => p.id);
```

**3. Linha 119** — Mudar o guard do DB update:
```typescript
// ANTES:
.eq("status_separacao", "aguardando_separacao");
// DEPOIS:
.in("status_separacao", ["aguardando_separacao", "validacao_oc"]);
```
Sem esta mudança, o filtro JS inclui `validacao_oc` mas o WHERE do Supabase ignora silenciosamente — o pedido nunca transiciona para `em_separacao`.

A blindagem de itens `aguardando_compra`/`comprado` (linhas 90-100) continua. Itens `oc_pendente` NÃO estão na lista de bloqueio.

### Mudanças no Banco

- Nenhuma migration necessária para `compra_status` — campo `text` aceita qualquer valor
- Nenhuma migration necessária para `status_separacao` — campo `text` aceita qualquer valor
- **Migration opcional** (recomendada): adicionar `oc_validado_por uuid` e `oc_validado_em timestamptz` em `siso_pedido_itens` para auditoria

### Preservação de Estado (Crítico)

O novo endpoint `validar-oc-item` **NÃO deve resetar** `separacao_marcado`, `bipado_completo` ou `quantidade_bipada` em itens normais do pedido. Isso é diferente do `produto-esgotado/route.ts` que reseta tudo (linhas 274-282). O padrão de reset do `produto-esgotado` existe porque ele muda o galpão de separação — no novo fluxo, o galpão não muda, então o reset não é necessário.

### UI: Seção de Conferência no Checklist

Na checklist page (`/separacao/checklist`), a consolidação atual usa `produto_id` como chave. Deve ser dividida em dois grupos:

```typescript
const { ocItems, normalItems } = useMemo(() => {
  const oc = new Map<string, ConsolidatedProduct>();
  const normal = new Map<string, ConsolidatedProduct>();
  for (const item of items) {
    const target = item.compra_status === 'oc_pendente' ? oc : normal;
    // chave: produto_id (itens do mesmo SKU mas em grupos diferentes nunca se misturam)
    // ... consolidação existente ...
  }
  return {
    ocItems: [...oc.values()].sort(naturalLocCompare),      // ordenação própria por localização
    normalItems: [...normal.values()].sort(naturalLocCompare), // ordenação própria por localização
  };
}, [items, sort]);
```

**Interação dos itens OC:** Usa o **mesmo componente** (`item-separacao-row` ou equivalente) do checklist normal. O clique no item marca como encontrado + bipado em um passo (verde). O botão de esgotado é o mesmo já existente. A diferença é apenas visual: a seção OC é delimitada com borda/background amber e título "Conferência OC". Itens OC marcados como encontrados ficam verdes na seção OC (não se movem para a seção normal). Itens marcados como esgotados ficam com visual de esgotado (cinza/riscado).

### Compatibilidade com Pedidos Existentes

Pedidos já em `aguardando_compra` com itens `aguardando_compra` continuam inalterados — eles já passaram pelo worker e estão no fluxo de compras. A mudança afeta apenas pedidos **novos** aprovados como OC após o deploy.

### `concluir-oc` existente

O endpoint `POST /api/separacao/concluir-oc` continua existindo para o fluxo "pick OC" (operadores que separam da aba Aguardando OC). Pode ser deprecado no futuro, mas não precisa ser alterado agora.

### Interação com `produto-esgotado`

Se durante a separação normal de um item que foi "encontrei" o operador descobre que está realmente esgotado, ele pode usar o botão de esgotado da separação normal (endpoint `produto-esgotado` existente). Este é um fluxo diferente e independente da validação OC.

## 8. Success Metrics

- **Redução de OCs desnecessárias**: medir % de itens `oc_pendente` que são resolvidos como "encontrei" (target: >10%)
- **Tempo de conferência OC**: tempo médio entre iniciar separação e resolver todos itens OC (target: <2min por pedido)
- **Zero itens `oc_pendente` no módulo de compras**: comprador nunca vê itens não validados
- **Preservação da taxa de separação**: tempo de separação de pedidos propria/transferencia não deve aumentar

## 9. Implementation Order

### Fase 1 — Data Layer (seguro, sem impacto visual)
1. Adicionar `"oc_pendente"` a `CompraStatus`, `"validacao_oc"` a `StatusSeparacao`, `validacao_oc` a `SeparacaoCounts` em `types/index.ts`
2. Adicionar `oc_pendente` ao `COMPRA_STATUS_MAP` em `separacao-card.tsx`
3. Adicionar labels/colors para `validacao_oc` em `pedidos/page.tsx`, `pedidos/[id]/page.tsx`, `separacao-card.tsx`
4. (Opcional) Migration: `oc_validado_por`, `oc_validado_em` em `siso_pedido_itens`
5. Criar endpoint `POST /api/separacao/validar-oc-item`

### Fase 2 — Backend Flow (preparação — seguro, sem efeito até Fase 3)
6. Modificar `iniciar/route.ts`: `ALLOWED_STATUSES` + filtro `toStart`
7. Modificar `concluir/route.ts`: guard `oc_pendente` + branch `aguardando_compra` + exclusão de itens compra da completude
8. Modificar `cancelar/route.ts`: distinguir `oc_pendente` de `aguardando_compra` no retorno
9. Modificar `voltar-etapa/route.ts`: adicionar `validacao_oc` ao `STATUS_ORDER`
10. Modificar `separacao/route.ts`: `VALID_STATUSES`, `COUNT_STATUSES`, `emptyCounts`
11. Modificar `dashboard/counts/route.ts`: incluir `validacao_oc` no badge de separação

### Fase 3 — UI
12. Atualizar `separacao/page.tsx`: `TAB_CONFIG`, `EMPTY_COUNTS`, `MOVE_TARGETS` para incluir `validacao_oc` na aba OC
13. Atualizar checklist page: dividir em seção OC + seção normal
14. Atualizar `separacao-card.tsx`: tags "OC Pendente" / "OC Confirmada", `isAguardandoOC` check
15. Botões "Encontrei" / "Esgotado" na seção de conferência

### Fase 4 — Ativação (ÚLTIMA — só após Fases 1-3 estarem deployadas)
16. Modificar `executarMarcadoresOnly` em `execution-worker.ts`: `oc_pendente` + `validacao_oc` + `fornecedor_oc`

> **CRÍTICO:** A Fase 4 (mudança no worker) é o ponto de ativação e **DEVE ser a última coisa deployada**. Se o worker começar a gerar `validacao_oc` antes da UI existir, pedidos ficarão travados sem forma de resolver. Para rollback, basta reverter a mudança no worker.

## 10. Open Questions (Resolvidos)

1. ~~Conferência OC em lote~~ → **Sim**, consolidação por SKU mantendo separação OC/normal via chave `produto_id + is_oc`
2. ~~Desfazer conferência~~ → **Sim**, operador pode desfazer "encontrei" ↔ "esgotado" enquanto estiver na mesma sessão e antes de concluir
3. ~~Notificação ao comprador~~ → **Escopo futuro**, não bloqueia MVP
4. ~~Pedidos 100% OC confirmados esgotado~~ → **Transição automática** para `aguardando_compra` (FR-8)
5. ~~Marcar todos itens como oc_pendente~~ → **Não**, apenas itens que `resolveCompraItemIds` identifica como faltantes
6. ~~Execution worker colide com novo fluxo~~ → **Resolvido**: worker continua rodando, apenas muda o status final que aplica
7. ~~NF gerada reserva estoque~~ → **Não é problema**: a NF cria reserva no Tiny (saldo continua, disponível diminui), o que é o comportamento desejado
8. ~~fornecedor_oc não setado pelo worker~~ → **Resolvido**: worker agora seta via `getFornecedorBySku()` no loop de itens faltantes
9. ~~Deploy parcial trava pedidos~~ → **Resolvido**: worker change é Fase 4, última a ser deployada
10. ~~`resolveCompraItemIds` não retorna SKU~~ → **Resolvido**: expandir `.select()` e tipo de retorno para incluir `sku`
11. ~~`iniciar` line 119 WHERE guard~~ → **Resolvido**: mudar `.eq()` para `.in()` incluindo `validacao_oc`
12. ~~`separacao_concluida_em` no branch aguardando_compra~~ → **Resolvido**: NÃO setar (é pausa parcial, não conclusão)
13. ~~FR-8 auto-transição não limpa operador/timestamp~~ → **Resolvido**: limpar `separacao_operador_id` e `separacao_iniciada_em`
14. ~~Query strategy tab OC~~ → **Resolvido**: frontend soma counts e faz queries separadas por status (API pura, 1 filtro = 1 status)
