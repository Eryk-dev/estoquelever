# PRD: Modulo de Compras (Ordens de Compra)

## 1. Introducao

Quando um pedido de venda chega e nenhum galpao tem estoque, o sistema sugere "OC" (Ordem de Compra). Hoje, esses pedidos sao aprovados e marcados como concluidos sem nenhum acompanhamento posterior — o operador precisa se organizar manualmente para saber o que falta comprar, o que ja foi pedido ao fornecedor, e quando a mercadoria chega.

O modulo de Compras cria um fluxo completo de acompanhamento: desde a aprovacao do pedido como OC ate a chegada da mercadoria, conferencia, entrada de estoque no Tiny e liberacao automatica do pedido para a separacao.

### Contexto operacional

- O principal fornecedor emite NF no final do dia, mas a mercadoria chega durante o dia (antes da NF).
- A entrada de estoque no Tiny precisa ser feita como movimentacao avulsa (tipo "E"), sem depender da NF fiscal.
- A NF fiscal e lancada separadamente no Tiny, fora do SISO.
- Volume: ~500 pedidos/dia, percentual de OC varia.
- **Ordens de compra sao por fornecedor, nao por pedido de venda.** Uma unica OC de um fornecedor pode atender itens de N pedidos de venda diferentes. O comprador faz uma compra consolidada por fornecedor.
- **Pode haver multiplas OCs abertas para o mesmo fornecedor simultaneamente** (ex: compra de segunda e compra de terca, antes da primeira entrega chegar).

## 2. Goals

- Eliminar o controle manual de compras (planilhas, memoria, WhatsApp)
- Dar visibilidade completa ao comprador sobre o que precisa ser comprado, agrupado por fornecedor
- Permitir ao operador de recebimento conferir mercadoria e dar entrada de estoque sem sair do SISO
- Liberar pedidos de venda automaticamente para separacao quando o estoque e recebido
- Suportar entregas parciais (fornecedor entrega parte dos itens)
- Permitir ao comprador lidar com itens indisponiveis no fornecedor (trocar fornecedor, devolver pra fila, marcar indisponivel)
- Manter historico completo do ciclo de compras

## 3. User Stories

### US-001: Operador aprova pedido como OC

**Descricao:** Como operador de estoque, quero aprovar um pedido pendente como OC para que ele va para o fluxo de compras e o comprador saiba que precisa agir.

**Acceptance Criteria:**
- [ ] Operador do galpao de origem pode aprovar pedido como OC no painel SISO (fluxo existente, sem mudanca na aprovacao)
- [ ] Worker insere marcadores no Tiny ("OC", galpaoOrigem) como ja faz
- [ ] Apos worker concluir, `status_separacao` do pedido muda para `aguardando_compra`
- [ ] Todos os itens do pedido recebem `compra_status = 'aguardando_compra'` e `fornecedor_oc` (mapeado pelo SKU via `sku-fornecedor.ts`)
- [ ] `produto_id_tiny` e salvo em cada item durante o enriquecimento do webhook (ja disponivel, sem busca adicional na conferencia)
- [ ] Pedido aparece na tela de Compras, agrupado pelo fornecedor de cada item
- [ ] Pedido NAO aparece na fila de separacao (so entra la quando estoque chegar)
- [ ] Typecheck/lint passa

### US-002: Comprador visualiza itens para comprar

**Descricao:** Como comprador, quero ver todos os itens que precisam ser comprados agrupados por fornecedor, para fazer pedidos de compra de forma eficiente.

**Acceptance Criteria:**
- [ ] Tela `/compras` mostra aba "Aguardando Compra" como padrao
- [ ] Itens sao agrupados por fornecedor (LDRU, ACA, Tiger, GAUSS, etc.)
- [ ] Cada card de fornecedor mostra: lista de SKUs, descricao, imagem, quantidade total, numero dos pedidos de venda vinculados
- [ ] Itens de pedidos diferentes com mesmo SKU/fornecedor sao consolidados (quantidade somada)
- [ ] Botao "Copiar SKUs" copia lista tabulada (SKU, descricao, quantidade) para area de transferencia
- [ ] Contadores mostram total de itens e fornecedores em cada aba
- [ ] Dados atualizam a cada 30s automaticamente
- [ ] Typecheck/lint passa

### US-003: Comprador cria ordem de compra

**Descricao:** Como comprador, quero marcar itens de um fornecedor como "comprei" para criar uma ordem de compra no SISO que agrupa todos esses itens e permite rastreamento.

**Acceptance Criteria:**
- [ ] Botao "Marcar como Comprado" no card do fornecedor cria um registro em `siso_ordens_compra`
- [ ] Todos os itens daquele fornecedor na aba "Aguardando Compra" sao vinculados a essa OC (`ordem_compra_id`)
- [ ] Campo de texto livre para observacao na OC (ex: "pedido #4521, previsao dia 15")
- [ ] `compra_status` dos itens muda para `comprado`
- [ ] `comprado_em` e `comprado_por` sao registrados na OC
- [ ] Itens marcados movem da aba "Aguardando Compra" para aba "Comprado"
- [ ] Quando TODOS os itens de um pedido de venda estao como `comprado` ou `recebido`, `status_separacao` do pedido muda para `comprado`
- [ ] Evento registrado no historico do pedido
- [ ] Typecheck/lint passa

### US-004: Comprador visualiza OCs aguardando entrega

**Descricao:** Como comprador, quero ver as ordens de compra que ja fiz e estao esperando entrega, com as observacoes que fiz, para acompanhar o status.

**Acceptance Criteria:**
- [ ] Aba "Comprado" mostra OCs agrupadas por fornecedor
- [ ] Cada card de OC mostra: fornecedor, observacao, data/hora da compra, quem comprou, lista de itens com SKU/descricao/quantidade
- [ ] Mostra ha quantos dias a OC foi criada
- [ ] Botao "Conferir Recebimento" em cada card de OC leva para tela de conferencia daquela OC especifica
- [ ] Se ha multiplas OCs do mesmo fornecedor, cada uma aparece como card separado
- [ ] Typecheck/lint passa

### US-005: Operador confere mercadoria recebida

**Descricao:** Como operador de recebimento, quero conferir item por item o que chegou de uma OC, informando a quantidade real recebida, para garantir que o estoque sera lancado corretamente.

**Acceptance Criteria:**
- [ ] Tela de conferencia (`/compras/conferencia/[ordemCompraId]`) mostra todos os itens da OC com `compra_status = 'comprado'`
- [ ] Cada item mostra: SKU, descricao, imagem, quantidade esperada (restante = esperada - ja recebida), campo editavel de quantidade recebida
- [ ] Quantidade recebida pre-preenchida com o restante esperado (operador ajusta se necessario)
- [ ] Permite quantidade recebida MAIOR que esperada (fornecedor mandou a mais)
- [ ] Permite quantidade recebida = 0 (item nao veio)
- [ ] Campo pre-preenchido pode ser zerado/ajustado livremente
- [ ] Botao "Confirmar Recebimento" so ativa quando ao menos 1 item tem quantidade > 0
- [ ] Mostra numero do(s) pedido(s) de venda vinculados a cada item
- [ ] Tela de conferencia NAO faz auto-refresh (operador pode perder dados digitados)
- [ ] Typecheck/lint passa

### US-006: Entrada de estoque no Tiny via conferencia

**Descricao:** Como sistema, quero dar entrada de estoque no Tiny automaticamente quando o operador confirma o recebimento, para que o estoque fique atualizado sem precisar acessar o Tiny.

**Acceptance Criteria:**
- [ ] Para cada item com quantidade recebida > 0, SISO chama `movimentarEstoque` no Tiny com `tipo: "E"` (entrada)
- [ ] Usa o `produto_id_tiny` ja salvo no item (sem busca por SKU na conferencia)
- [ ] Se `produto_id_tiny` nao existe no item (SKU nao encontrado no enriquecimento), item e marcado como "SKU nao encontrado" e pula a entrada — registra alerta
- [ ] Usa o `deposito_id` configurado na conexao Tiny da empresa
- [ ] Observacao da movimentacao inclui referencia ao SISO (ex: "Entrada OC via SISO - OC #uuid")
- [ ] Rate limiting respeitado (usa `waitForRateLimit` + `registerApiCall`)
- [ ] Sleep entre chamadas para nao sobrecarregar API
- [ ] Se um item falhar na entrada, os outros continuam (nao interrompe o lote)
- [ ] Erros sao logados e reportados ao operador (quais itens falharam)
- [ ] `compra_quantidade_recebida` e atualizado incrementalmente (soma com recepcoes anteriores)
- [ ] Se `compra_quantidade_recebida >= quantidade_pedida`: `compra_status = 'recebido'`
- [ ] Se `compra_quantidade_recebida < quantidade_pedida`: mantem `compra_status = 'comprado'` (espera proxima entrega)
- [ ] `recebido_em` e `recebido_por` registrados nos itens totalmente recebidos
- [ ] Status da OC atualizado: se todos itens `recebido` → OC `recebido`; se mix → `parcialmente_recebido`
- [ ] Typecheck/lint passa

### US-007: Liberacao automatica de pedidos apos recebimento

**Descricao:** Como sistema, quero liberar pedidos de venda automaticamente para o fluxo normal de separacao quando todos os itens forem recebidos (de todas as OCs/fornecedores), para que nao haja intervencao manual.

**Acceptance Criteria:**
- [ ] Apos conferencia, para cada pedido de venda cujos TODOS itens tem `compra_status = 'recebido'`: pedido e liberado
- [ ] Liberacao: `decisao_final` muda para `propria`, `status` volta para `executando`, `status_separacao` para `aguardando_nf`
- [ ] Novo job enfileirado em `siso_fila_execucao` com `tipo = 'lancar_estoque'`, `decisao = 'propria'`
- [ ] Worker processa: gera NF + lanca saida de estoque (fluxo `executarSaidaPropria` existente)
- [ ] Pedido aparece na separacao normalmente apos NF emitida
- [ ] Evento `compra_liberado` registrado no historico
- [ ] Se pedido tem itens de multiplos fornecedores/OCs e nem todos foram recebidos: pedido NAO e liberado (espera todos)
- [ ] Feedback visual ao operador: "X pedidos liberados para separacao"
- [ ] Typecheck/lint passa

### US-008: Entregas parciais (item nao veio completo)

**Descricao:** Como operador, quero poder registrar que apenas parte da quantidade esperada chegou, para que o sistema saiba que ainda falta mercadoria e mantenha o item na OC.

**Acceptance Criteria:**
- [ ] Na conferencia, operador pode informar quantidade menor que a esperada
- [ ] `compra_quantidade_recebida` e incrementado com a quantidade desta entrega
- [ ] Item permanece como `comprado` na OC se quantidade total ainda nao foi atingida
- [ ] Na proxima conferencia da mesma OC, mostra quantidade RESTANTE (esperada - ja recebida)
- [ ] Quando a quantidade total for atingida em entregas subsequentes, item muda para `recebido`
- [ ] OC permanece como `parcialmente_recebido` ate todos itens serem recebidos
- [ ] Typecheck/lint passa

### US-009: Liberacao de pedidos com itens de multiplos fornecedores

**Descricao:** Como sistema, quero liberar um pedido de venda quando TODOS os seus itens forem recebidos, mesmo que venham de OCs/fornecedores diferentes em momentos diferentes.

**Acceptance Criteria:**
- [ ] Apos cada conferencia de OC, sistema verifica todos os pedidos de venda vinculados aos itens recebidos
- [ ] Para cada pedido verificado: se TODOS os itens (de todas as OCs/fornecedores) tem `compra_status = 'recebido'`, pedido e liberado
- [ ] Se apenas parte dos itens foi recebida (outros fornecedores ainda pendentes), pedido NAO e liberado
- [ ] Pedido so e liberado quando o ultimo item pendente for recebido, independente de qual OC/fornecedor
- [ ] Typecheck/lint passa

### US-010: Item indisponivel no fornecedor

**Descricao:** Como comprador, quero lidar com itens que o fornecedor nao tem disponivel, podendo trocar de fornecedor, devolver pra fila, ou marcar como indisponivel.

**Acceptance Criteria:**

#### Devolver pra fila
- [ ] Comprador pode remover um item de uma OC
- [ ] Item volta para aba "Aguardando Compra" com `compra_status = 'aguardando_compra'` e `ordem_compra_id = null`
- [ ] Fornecedor do item pode ser mantido ou alterado
- [ ] Se a OC ficar sem itens, OC e removida/cancelada

#### Marcar indisponivel
- [ ] Comprador pode marcar item como `compra_status = 'indisponivel'`
- [ ] Pedido de venda vinculado mostra alerta visivel de item indisponivel
- [ ] Item indisponivel aparece em aba/secao separada para visibilidade
- [ ] Cancelamento do pedido no marketplace e feito manualmente fora do SISO

#### Trocar fornecedor
- [ ] Comprador pode mover item de uma OC para outra OC de fornecedor diferente (existente ou nova)
- [ ] Item sai da OC atual e entra na OC destino com o novo fornecedor
- [ ] Quantidades e status sao preservados

- [ ] Typecheck/lint passa

### US-011: Historico e observacoes de compras

**Descricao:** Como comprador ou operador, quero ver o historico completo do ciclo de compras de um pedido, para rastreabilidade.

**Acceptance Criteria:**
- [ ] Eventos registrados no historico: `aguardando_compra`, `compra_realizada`, `compra_recebida`, `compra_liberado`, `item_devolvido_fila`, `item_indisponivel`, `item_trocou_fornecedor`
- [ ] Observacao do comprador (feita ao criar OC) aparece no historico e no card da OC
- [ ] Data/hora e usuario de cada acao registrados
- [ ] Historico acessivel pelo card do pedido
- [ ] Typecheck/lint passa

### US-012: Cancelamento de pedido remove itens de compras

**Descricao:** Como sistema, quero que quando um pedido de marketplace for cancelado (webhook de cancelamento), os itens sejam removidos automaticamente do fluxo de compras, para nao comprar mercadoria desnecessaria.

**Acceptance Criteria:**
- [ ] Webhook de cancelamento detecta pedidos com `status_separacao` em `aguardando_compra` ou `comprado`
- [ ] `compra_status` de todos os itens do pedido e limpo (setado para null)
- [ ] `ordem_compra_id` dos itens e limpo (desvincula da OC)
- [ ] Quantidades da OC sao recalculadas (itens cancelados saem da contagem)
- [ ] Se OC ficar sem itens, OC e cancelada
- [ ] `status_separacao` do pedido muda para `cancelado`
- [ ] Itens cancelados nao aparecem mais na tela de Compras nem na conferencia
- [ ] Se o item ja tinha sido recebido (entrada de estoque feita), estoque FICA no Tiny (sera consumido por pedidos futuros) e alerta visivel e mostrado na UI (nao so log)
- [ ] Evento `cancelado` registrado no historico do pedido
- [ ] Typecheck/lint passa

## 4. Functional Requirements

### Banco de dados

- FR-01: Nova tabela `siso_ordens_compra` com colunas: `id` (uuid PK), `fornecedor` (text), `empresa_id` (FK siso_empresas), `status` (enum: aguardando_compra, comprado, parcialmente_recebido, recebido, cancelado), `observacao` (text nullable), `comprado_por` (uuid FK siso_usuarios), `comprado_em` (timestamptz), `created_at` (timestamptz)
- FR-02: `siso_pedido_itens` deve ter colunas adicionais: `produto_id_tiny` (bigint nullable), `fornecedor_oc` (text nullable), `ordem_compra_id` (uuid FK siso_ordens_compra nullable), `compra_status` (text nullable), `compra_quantidade_recebida` (int default 0), `comprado_em` (timestamptz nullable), `comprado_por` (uuid nullable), `recebido_em` (timestamptz nullable), `recebido_por` (uuid nullable)
- FR-03: `status_separacao` em `siso_pedidos` deve aceitar os valores `aguardando_compra` e `comprado` alem dos existentes
- FR-04: Indices devem existir em `compra_status`, `fornecedor_oc`, e `ordem_compra_id` para queries eficientes
- FR-05: Migration deve ser retrocompativel (colunas novas sao nullable/com default)

### Worker (execution-worker.ts)

- FR-06: `executarMarcadoresOnly` deve setar `status_separacao = 'aguardando_compra'` e `compra_status = 'aguardando_compra'` em todos os itens do pedido apos inserir marcadores
- FR-07: O `status` do pedido (campo principal) continua indo para `concluido` apos o job do worker — o ciclo de compras e trackeado via `status_separacao`

### API

- FR-08: `GET /api/compras` deve retornar itens agrupados por fornecedor com `compra_status` filtrado, contagens por status, OCs com seus itens, e lista de fornecedores distintos
- FR-09: `POST /api/compras/ordens` deve criar registro em `siso_ordens_compra` e vincular itens do fornecedor na aba "Aguardando Compra" a essa OC
- FR-10: `GET /api/compras/conferencia/[ordemCompraId]` deve retornar itens da OC com `compra_status = 'comprado'`, com quantidade restante calculada
- FR-11: `POST /api/compras/conferir` deve: validar dados, chamar `movimentarEstoque` tipo E no Tiny para cada item (usando `produto_id_tiny` salvo), atualizar `compra_quantidade_recebida`, atualizar status da OC, verificar completude dos pedidos de venda, e liberar pedidos quando todos os itens forem recebidos
- FR-12: `POST /api/compras/itens/[itemId]/devolver` deve desvincular item da OC e voltar pra fila
- FR-13: `POST /api/compras/itens/[itemId]/indisponivel` deve marcar item como indisponivel
- FR-14: `POST /api/compras/itens/[itemId]/trocar-fornecedor` deve mover item para outra OC
- FR-15: Liberacao de pedido deve: mudar `decisao_final` para `propria`, enfileirar job `lancar_estoque` com `decisao = 'propria'`, disparar worker

### Frontend

- FR-16: Pagina `/compras` deve ter 3 abas: "Aguardando Compra", "Comprado" (OCs aguardando entrega), e "Indisponiveis"
- FR-17: Aba "Aguardando Compra": itens agrupados por fornecedor com etiqueta visual
- FR-18: Aba "Comprado": cards de OCs individuais (nao agrupado por fornecedor — cada OC e um card)
- FR-19: Pagina de conferencia (`/compras/conferencia/[ordemCompraId]`) com inputs editaveis de quantidade, SEM auto-refresh
- FR-20: Feedback visual apos conferencia: itens processados, erros, pedidos liberados
- FR-21: Compras so deve ser acessivel por usuarios com cargo `admin` ou `comprador`
- FR-22: Acoes por item na OC: devolver pra fila, marcar indisponivel, trocar fornecedor

### Integracao Tiny

- FR-23: Entrada de estoque usa `movimentarEstoque` com `tipo: "E"`, respeitando rate limiting existente
- FR-24: `produto_id_tiny` e salvo no item durante o enriquecimento do webhook (fase de consulta de estoque). Conferencia usa esse ID direto, sem busca adicional.
- FR-25: Se `produto_id_tiny` nao existe (SKU nao encontrado no enriquecimento), item e marcado como "SKU nao encontrado" na conferencia e pula a entrada de estoque
- FR-26: Deposito usado e o `deposito_id` configurado em `siso_tiny_connections` da empresa

### Cancelamento

- FR-27: Webhook de cancelamento deve detectar pedidos em `aguardando_compra` ou `comprado` e limpar `compra_status` e `ordem_compra_id` dos itens
- FR-28: Pedido cancelado em compras deve ter `status_separacao = 'cancelado'`
- FR-29: Se item ja teve entrada de estoque lancada (compra_quantidade_recebida > 0) e depois e cancelado: estoque FICA no Tiny (consumido por pedidos futuros) + alerta visivel na UI

### Race condition de estoque (V1)

- FR-30: Na V1, aceitar o risco de race condition entre entrada de estoque (tipo E) e liberacao do pedido. O volume de OC e baixo e a janela de risco e pequena. Se um novo pedido consumir estoque destinado a um pedido OC, resolver manualmente.

## 5. Non-Goals (Out of Scope)

- **Nao e um modulo de compras/PO do ERP** — nao cria pedidos de compra no Tiny, nao gerencia fornecedores, nao controla precos
- **Nao faz entrada fiscal** — a NF de compra do fornecedor e lancada separadamente no Tiny, fora do SISO
- **Nao gerencia fornecedores** — o mapeamento SKU-fornecedor e fixo no codigo (`sku-fornecedor.ts`), nao e editavel pela UI
- **Nao tem notificacoes push** — o comprador precisa abrir a tela para ver novos itens
- **Nao migra pedidos OC antigos** — pedidos aprovados como OC antes desta implementacao permanecem como estao
- **Nao torna mapeamento SKU-fornecedor editavel pela UI** — fica fixo no codigo nesta versao (futuro PRD separado)
- **Nao implementa reserva de estoque** — na V1, aceita-se o risco de race condition (ver FR-30)

## 6. Technical Considerations

### Banco de dados
- Nova tabela `siso_ordens_compra` para entidade OC propria
- Estende `siso_pedido_itens` com colunas de compra + FK para `siso_ordens_compra`
- `produto_id_tiny` salvo durante enriquecimento — elimina necessidade de busca por SKU na conferencia
- Migration deve ser retrocompativel (colunas novas sao nullable/com default)

### Tiny API
- `movimentarEstoque` tipo "E" ja existe no client (`tiny-api.ts`)
- Rate limiting: conferencia de 10+ itens pode fazer muitas chamadas sequenciais — usar sleep entre chamadas como o worker ja faz
- `produto_id_tiny` ja disponivel no item — conferencia nao faz busca por SKU

### Fluxo de liberacao
- Quando o pedido e liberado, ele re-entra no fluxo como `decisao = 'propria'`
- O worker executa `executarSaidaPropria`: marcadores + NF + saida de estoque
- Marcadores "OC" ja foram inseridos na primeira passagem — o worker trata duplicata como idempotente
- A entrada (tipo E) e a saida (via NF) sao movimentacoes distintas e ambas necessarias

### Concorrencia
- Dois operadores podem tentar conferir a mesma OC simultaneamente — usar update condicional (`eq compra_status = 'comprado'`) para evitar dupla entrada

### Race condition (V1)
- Entre a entrada de estoque (tipo E) no recebimento e a liberacao do pedido, o estoque fica disponivel no Tiny e pode ser consumido por outro pedido via webhook. Na V1 este risco e aceito dado o baixo volume de OC. Versao futura pode implementar reserva de estoque no SISO.

## 7. Success Metrics

- Comprador consegue visualizar e marcar compras sem sair do SISO
- Operador consegue conferir recebimento e dar entrada de estoque sem acessar o Tiny
- Pedidos OC sao liberados automaticamente para separacao apos recebimento completo
- Zero pedidos "perdidos" no limbo (todos os OC tem visibilidade no modulo de compras)
- Entregas parciais sao rastreadas corretamente sem perda de dados
- Comprador consegue lidar com itens indisponiveis sem sair do SISO

## 8. Decisoes Tomadas

- **DT-1 (Modelo de dados OC):** Ordem de compra e entidade propria (tabela `siso_ordens_compra`), nao agrupamento logico. OC e por fornecedor e atende N pedidos de venda. Pode haver multiplas OCs abertas para o mesmo fornecedor.
- **DT-2 (Produto ID no Tiny):** `produto_id_tiny` e salvo durante o enriquecimento do webhook em `siso_pedido_itens`. Conferencia usa esse ID direto. Se nao encontrou no enriquecimento, item fica como "SKU nao encontrado" e pula na conferencia. Elimina a necessidade de entrada manual de ID (antiga US-012).
- **DT-3 (Cancelamento pos-recebimento):** Estoque que ja entrou no Tiny FICA (sera consumido por pedidos futuros). Alerta visivel na UI informa o operador. Nao faz reversao automatica.
- **DT-4 (Race condition):** Na V1, aceitar o risco. Volume de OC e baixo e a janela entre entrada e liberacao e pequena. Versao futura pode implementar reserva de estoque.
- **DT-5 (Liberacao parcial):** Mantida na V1. A liberacao acontece por pedido de venda: so libera quando TODOS os itens do pedido estao recebidos, independente de quantas OCs/fornecedores estejam envolvidos. Nao ha envio parcial.
- **DT-6 (Item indisponivel):** Tres acoes na V1: devolver pra fila (volta pra "Aguardando Compra"), marcar indisponivel (alerta no pedido, cancelamento manual no marketplace), trocar fornecedor (move item para outra OC).
- **DT-7 (Mapeamento SKU-fornecedor editavel):** Sera necessario no futuro, mas NAO faz parte deste PRD. Manter fixo no codigo por ora.

## 9. Fluxo Completo

### Fase 1: Pedido vira OC
```
Webhook Tiny → pedido chega → webhook-processor enriquece estoque
  → nenhum galpao tem estoque → sugestao "OC" → painel Pendente
  → Operador aprova como OC
  → Worker: marcadores no Tiny + status_separacao = 'aguardando_compra'
  → Cada item: compra_status = 'aguardando_compra', fornecedor_oc mapeado pelo SKU
  → Pedido aparece na tela /compras
```

### Fase 2: Comprador cria OC
```
Tela /compras → aba "Aguardando Compra"
  → Itens consolidados por fornecedor (N pedidos de venda → 1 card por fornecedor)
  → Comprador clica "Marcar como Comprado" no card do fornecedor
  → Sistema cria siso_ordens_compra (fornecedor, observacao, empresa)
  → Itens vinculados a OC (ordem_compra_id)
  → compra_status → 'comprado'
  → Card move pra aba "Comprado"
```

### Fase 3: Recebimento
```
Tela /compras → aba "Comprado" → card da OC → "Conferir Recebimento"
  → Tela /compras/conferencia/[ordemCompraId]
  → Operador informa quantidade recebida por item
  → "Confirmar Recebimento"
  → Para cada item com qty > 0: movimentarEstoque tipo E no Tiny
  → compra_quantidade_recebida incrementado
  → Se qty total atingida: compra_status = 'recebido'
  → Se parcial: mantem 'comprado', proxima conferencia mostra restante
  → Status OC atualizado (parcialmente_recebido ou recebido)
```

### Fase 4: Liberacao
```
Apos conferencia, para cada pedido de venda vinculado:
  → Verifica: TODOS os itens do pedido tem compra_status = 'recebido'?
  → Se sim: libera pedido (decisao_final = 'propria', enfileira worker)
  → Worker faz NF + saida de estoque (fluxo existente)
  → Pedido aparece na separacao
  → Se nao: espera demais fornecedores/OCs
```

### Fase 5: Cancelamento
```
Webhook de cancelamento chega:
  → Se itens em 'aguardando_compra': limpa compra_status, desvincula de OC
  → Se itens em 'comprado': limpa compra_status, desvincula de OC, recalcula OC
  → Se itens ja 'recebido': estoque FICA no Tiny + alerta visivel na UI
  → status_separacao = 'cancelado'
```
