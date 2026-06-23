# PRD: Pick OC — Separacao Direta de Pedidos Aguardando Compra

## 1. Introduction/Overview

Hoje, pedidos com decisao OC (ordem de compra) ficam travados na aba "Aguardando OC" da separacao ate que o fluxo completo de compras seja concluido manualmente: criar OC, marcar como comprado, conferir recebimento item a item, liberar pedido, aguardar NF, e so entao entrar na fila de separacao.

Na pratica, o operador muitas vezes ja tem o produto fisicamente em maos (comprou no balcao, recebeu de fornecedor rapido, etc.) mas precisa percorrer toda a burocracia no modulo de Compras antes de poder separar e expedir.

**Esta feature adiciona um botao "Separar" na aba "Aguardando OC"** que abre o checklist de separacao normal (com todos os itens do pedido), permitindo que o operador faca o pick fisico enquanto o backend automaticamente resolve toda a cadeia burocratica (marcar como recebido, determinar decisao, postar estoque, gerar NF).

Ao concluir, o pedido cai em "Separado" com a tag **PICK OC**, seguindo o fluxo normal de embalagem e expedicao.

---

## 2. Goals

- Eliminar a necessidade de navegar ao modulo de Compras para pedidos que o operador ja tem em maos
- Reduzir o tempo medio de processamento de pedidos OC de horas/dias para minutos
- Manter rastreabilidade total (tag "PICK OC" identifica pedidos que pularam o fluxo formal)
- Reutilizar ao maximo o fluxo de separacao existente (checklist, bipar, marcar, concluir)
- Nao quebrar o fluxo de compras formal (pedidos que nao forem "pickados" continuam no fluxo normal)

---

## 3. User Stories

### US-001: Iniciar separacao de pedidos OC
**Description:** Como operador, quero selecionar pedidos na aba "Aguardando OC" e clicar "Separar" para abrir o checklist de picking, assim como faco com pedidos normais.

**Acceptance Criteria:**
- [ ] Botao "Separar N pedido(s)" aparece na aba "Aguardando OC" (mesmo padrao das outras abas)
- [ ] Ao clicar, redireciona para `/separacao/checklist?pedidos=id1,id2&modo=pick-oc`
- [ ] API `/api/separacao/iniciar` aceita pedidos com `status_separacao = "aguardando_compra"`
- [ ] Pedidos transitam para `em_separacao` normalmente
- [ ] Operador pode selecionar pedidos individualmente ou usar "Selecionar todos"
- [ ] Typecheck passa

### US-002: Checklist com indicador de itens OC
**Description:** Como operador, quero ver no checklist quais itens sao OC e qual o status de compra atual, para saber o que estou separando.

**Acceptance Criteria:**
- [ ] API `/api/separacao/checklist-items` retorna `compra_status` para cada item
- [ ] Itens com `compra_status != null` exibem um badge/indicador visual (ex: "OC" em amber, ou o status especifico)
- [ ] Itens com estoque proprio (compra_status = null) nao mostram indicador — separacao normal
- [ ] O indicador mostra o status atual: "Aguardando", "Comprado", "Recebido"
- [ ] Todos os itens (OC + estoque) podem ser bipados/marcados normalmente
- [ ] O operador nao precisa alterar o compra_status manualmente — so separar
- [ ] Typecheck passa

### US-003: Concluir separacao OC com resolucao automatica
**Description:** Como operador, ao concluir a separacao de pedidos OC, quero que o sistema automaticamente resolva toda a parte burocratica (marcar como recebido, postar estoque, gerar NF) sem que eu precise ir no modulo de Compras.

**Acceptance Criteria:**
- [ ] Novo endpoint `POST /api/separacao/concluir-oc` criado
- [ ] Valida que todos os itens estao marcados como separados (`separacao_marcado = true`)
- [ ] Para itens OC (`compra_status` != null e != "recebido"/"cancelado"):
  - Marca `compra_status = "recebido"`
  - Seta `compra_quantidade_recebida = compra_quantidade_solicitada`
- [ ] Determina `decisao_final` (propria vs transferencia) usando logica do compras-release
- [ ] Seta `separacao_galpao_id` corretamente
- [ ] Insere job `lancar_estoque` em `siso_fila_execucao` para o execution-worker processar (estoque Tiny + NF)
- [ ] Transita pedido diretamente para `status_separacao = "separado"`, `status = "executando"`
- [ ] Seta `separacao_concluida_em = now()`
- [ ] Adiciona tag "pick oc" em `separacao_tags`
- [ ] Fire-and-forget: `preCriarAgrupamentosEmLote()` para gerar etiquetas
- [ ] Pedidos com itens pendentes (nao marcados) retornam em `pendentes[]` sem transitar
- [ ] Registra evento no historico (`registrarEvento`)
- [ ] Typecheck passa

### US-004: Checklist detecta modo OC e usa endpoint correto
**Description:** Como sistema, quando o checklist foi aberto a partir da aba "Aguardando OC", o botao "Concluir" deve chamar o endpoint `concluir-oc` em vez do `concluir` normal.

**Acceptance Criteria:**
- [ ] Checklist detecta modo OC via query param `modo=pick-oc`
- [ ] Botao "Concluir" chama `/api/separacao/concluir-oc` quando em modo OC
- [ ] Botao "Concluir" continua chamando `/api/separacao/concluir` no fluxo normal
- [ ] Toast de sucesso diferenciado: "Separacao OC concluida — pedidos liberados"
- [ ] Typecheck passa

---

## 4. Functional Requirements

**FR-1:** O endpoint `POST /api/separacao/iniciar` deve aceitar `"aguardando_compra"` como status valido de partida, alem dos existentes (`"aguardando_separacao"`, `"em_separacao"`).

**FR-2:** O endpoint `GET /api/separacao/checklist-items` deve incluir o campo `compra_status` (string | null) no retorno de cada item.

**FR-3:** O novo endpoint `POST /api/separacao/concluir-oc` deve:
  - Receber `{ pedido_ids: string[], operador_id?: string }`
  - Validar que todos os itens de cada pedido estao `separacao_marcado = true`
  - Atualizar itens OC para `compra_status = "recebido"`
  - Resolver `decisao_final` e `separacao_galpao_id` (reutilizar logica de `compras-release.ts`)
  - Inserir job na fila de execucao
  - Transitar para `"separado"` com tag `"pick oc"`
  - Retornar `{ separados: string[], pendentes: string[] }`

**FR-4:** O checklist deve exibir badge visual para itens OC com cores por status:
  - `aguardando_compra` → amber "Aguardando"
  - `comprado` → blue "Comprado"
  - `recebido` → green "Recebido"
  - Sem `compra_status` → sem badge (item normal)

**FR-5:** A aba "Aguardando OC" deve exibir botao "Separar N pedido(s)" com o mesmo padrao visual das abas "Aguardando Separacao" e "Em Separacao".

**FR-6:** O fluxo de compras formal nao deve ser afetado — pedidos nao selecionados para pick OC continuam no fluxo normal via modulo Compras.

**FR-7:** O execution-worker processa os jobs inseridos pelo concluir-oc normalmente (postar marcadores + estoque no Tiny, gerar NF). O pedido ja esta em "separado" enquanto isso acontece em background.

---

## 5. Non-Goals (Out of Scope)

- **Nao** criar uma nova aba/tab — funcionalidade fica dentro da aba "Aguardando OC" existente
- **Nao** alterar o fluxo do modulo de Compras (Compras continua funcionando independente)
- **Nao** fazer entrada de estoque no Tiny durante o concluir-oc (isso fica para o execution-worker async)
- **Nao** exigir que o operador altere manualmente o compra_status dos itens
- **Nao** bloquear a separacao por status de compra — se o operador tem o item fisicamente, ele pode separar independente do status no sistema
- **Nao** implementar conferencia parcial (todos os itens do pedido devem ser marcados para concluir)

---

## 6. Technical Considerations

### Reutilizacao de codigo
- **`compras-release.ts`** — Reutilizar a logica de resolucao de `decisao_final` e `separacao_galpao_id` (extrair em funcao reutilizavel se necessario)
- **`agrupamento-service.ts`** — Reutilizar `preCriarAgrupamentosEmLote()` para geracao de etiquetas
- **`/api/separacao/iniciar`** — Apenas ampliar a lista de status permitidos
- **`/api/separacao/checklist-items`** — Apenas adicionar campo ao select + response

### Status transitions
```
aguardando_compra → (iniciar) → em_separacao → (concluir-oc) → separado → embalado
```

### Concorrencia com modulo Compras
- Ao transitar `aguardando_compra → em_separacao`, o compras-release nao interferira (ele verifica `status_separacao IN ("aguardando_compra", "comprado")`)
- Se um pedido ja teve items recebidos via Compras, o concluir-oc respeita: so atualiza itens que ainda nao estao "recebido"/"cancelado"

### Execution worker
- O job `lancar_estoque` inserido pelo concluir-oc sera processado normalmente
- O worker nao altera `status_separacao` — apenas faz chamadas Tiny (marcadores, estoque, NF)
- A NF webhook chegara depois, mas o pedido ja esta em "separado", entao o nf-webhook-handler deve tratar graciosamente

### Etiquetas
- Fire-and-forget `preCriarAgrupamentosEmLote()` pode falhar se NF ainda nao existir no Tiny
- Isso ja e tratado pelo retry existente — etiquetas serao recuperadas depois
- O pedido aparecera em "Separados" como "sem etiqueta" ate o worker+NF completarem

### Arquivos criticos
- `src/app/api/separacao/iniciar/route.ts` — ampliar status permitidos
- `src/app/api/separacao/checklist-items/route.ts` — adicionar compra_status
- `src/app/api/separacao/concluir-oc/route.ts` — **NOVO**
- `src/app/separacao/checklist/page.tsx` — indicador OC + modo pick-oc
- `src/app/separacao/page.tsx` — botao Separar na aba Aguardando OC
- `src/lib/compras-release.ts` — possivelmente extrair logica de resolucao de decisao

---

## 7. Success Metrics

- Operador consegue separar pedidos OC sem sair da pagina de Separacao
- Tempo entre "item em maos" e "pedido separado" reduz de horas para minutos
- Pedidos com tag "PICK OC" aparecem em "Separados" e seguem fluxo normal de embalagem/expedicao
- Zero regressao no fluxo formal de Compras
- Execution worker processa jobs do pick-oc sem erros

---

## 8. Open Questions

- **Q1:** Se o execution-worker falhar ao postar estoque/NF no Tiny, o pedido ja esta em "separado". O retry do worker e suficiente, ou precisamos de algum alerta/indicador na UI?
- **Q2:** Deve haver um limite de pedidos que podem ser selecionados para pick OC de uma vez (wave size)?
- **Q3:** O operador deve poder cancelar/desfazer um pick OC apos concluir (voltar para aguardando_compra)?
