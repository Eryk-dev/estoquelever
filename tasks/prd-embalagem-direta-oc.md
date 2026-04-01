# PRD: Embalagem Direta OC

## 1. Introduction / Overview

Pedidos com decisão OC que já estão "engatilhados" (NF emitida + agrupamento concluído) ficam parados na aba "Aguardando OC" esperando o fluxo completo de compras → separação → embalagem. Na prática, quando o item já está fisicamente disponível no galpão, o operador pode embalar direto sem passar por todas as etapas intermediárias.

Este módulo adiciona um botão "Embalar" ao lado do "Separar" existente na aba Aguardando OC. O operador bipa cada produto (igual ao checklist de embalagem atual), e ao completar o pedido a etiqueta é impressa automaticamente. O sistema auto-resolve os itens de compra, enfileira o lançamento de estoque, e transiciona direto para `embalado`.

**Diferença do Pick OC:** O Pick OC navega para a tela de checklist (separação item a item). A Embalagem Direta fica inline na própria aba, com foco apenas no bip → etiqueta, sem etapa intermediária de separação.

## 2. Goals

- Eliminar etapas intermediárias (compras → separação → embalagem) para pedidos OC já prontos
- Reduzir tempo de processamento de horas/dias para minutos
- Manter rastreabilidade com tag "embalagem direta"
- Reutilizar lógica de bip-embalagem existente (scan produto, completar pedido, imprimir etiqueta)
- Não quebrar fluxo formal de compras para pedidos não selecionados
- Garantir que só pedidos "engatilhados" (NF + agrupamento) possam usar este atalho

## 3. User Stories

### US-001: Botão "Embalar" na aba Aguardando OC

**Description:** Como operador, quero ver um botão "Embalar N pedidos" ao lado do "Separar" na aba Aguardando OC, para poder embalar direto os pedidos que já estão prontos.

**Acceptance Criteria:**
- [ ] Botão "Embalar" aparece ao lado de "Separar" na aba `aguardando_compra`
- [ ] Botão usa ícone `Package` (Lucide) para diferenciar do `Play` do Separar
- [ ] Botão só conta/habilita pedidos "engatilhados" (`nf_emitida && agrupamento_criado`)
- [ ] Label do botão: "Embalar N pedido(s)" onde N = count de engatilhados selecionados (ou total de engatilhados se nenhum selecionado)
- [ ] Botão disabled se nenhum pedido engatilhado disponível
- [ ] Se operador selecionou pedidos que não estão engatilhados, eles são ignorados no count
- [ ] Typecheck/lint passa

### US-002: Modo embalagem inline na aba

**Description:** Como operador, quero que ao clicar "Embalar" apareça um modo de scan inline dentro da própria aba, sem navegar para outra página.

**Acceptance Criteria:**
- [ ] Ao clicar "Embalar", aba entra em "modo embalagem" com input de scan visível no topo
- [ ] Cards dos pedidos selecionados mostram progresso de bip (itens bipados / total)
- [ ] Pedidos não selecionados ficam ocultos ou minimizados durante o modo embalagem
- [ ] Botão "Sair" ou "Cancelar" para voltar ao modo normal da aba
- [ ] Input de scan tem autofocus e aceita SKU ou GTIN (mesmo padrão da embalagem atual)
- [ ] Campo de quantidade opcional (default = 1)
- [ ] Último item bipado aparece destacado com feedback visual
- [ ] Typecheck/lint passa

### US-003: Bip de produto com resolução OC automática

**Description:** Como operador, quero bipar cada produto e o sistema encontrar automaticamente qual pedido OC contém aquele SKU, incrementar a quantidade bipada, e ao completar o pedido auto-resolver os itens de compra.

**Acceptance Criteria:**
- [ ] Novo endpoint `POST /api/separacao/bipar-embalagem-oc` aceita `{ sku, pedido_ids, quantidade? }`
- [ ] Endpoint encontra o pedido mais antigo entre os `pedido_ids` fornecidos que contenha o SKU
- [ ] Incrementa `quantidade_bipada` do item atomicamente
- [ ] Quando item completo: marca `bipado_completo = true`
- [ ] Quando pedido completo (todos itens bipados):
  - Auto-resolve compra items: `compra_status → "recebido"`, `compra_quantidade_recebida = compra_quantidade_solicitada`
  - Determina `decisao_final` (propria vs transferencia, baseado no galpão OC vs galpão empresa)
  - Adiciona tag "embalagem direta" em `separacao_tags`
  - Transiciona `status_separacao → "embalado"` + `status → "executando"`
  - Enfileira job `lancar_estoque` em `siso_fila_execucao`
  - Imprime etiqueta via PrintNode (fast path: ZPL cacheado, fallback: buscar do Tiny)
  - Registra evento `embalagem_direta_concluida` no histórico
- [ ] Retorna `{ pedido_id, produto_id, quantidade_bipada, bipado_completo, pedido_completo, etiqueta_status?, etiqueta_erro? }`
- [ ] Itens com `compra_status` = `indisponivel` ou `cancelado` são ignorados na validação de conclusão
- [ ] Typecheck/lint passa

### US-004: Feedback visual e sonoro no scan

**Description:** Como operador, quero feedback imediato ao bipar — visual no card e sonoro — igual à embalagem atual.

**Acceptance Criteria:**
- [ ] Bip bem-sucedido: toast success + beep (reutilizar `audio-feedback.ts`)
- [ ] SKU não encontrado nos pedidos selecionados: toast warning "SKU não encontrado"
- [ ] Erro de rede/servidor: toast error com mensagem
- [ ] Pedido completado: toast success "Pedido XXXXX embalado — etiqueta impressa"
- [ ] Se etiqueta falhou: toast warning "Pedido embalado, etiqueta pendente"
- [ ] Card do pedido atualiza em tempo real (progresso itens bipados)
- [ ] Card do pedido completado sai da lista com animação (ou marca como concluído visualmente)
- [ ] Typecheck/lint passa

### US-005: Conclusão do modo embalagem

**Description:** Como operador, quero que ao terminar todos os pedidos selecionados o modo embalagem feche automaticamente, e a aba atualize mostrando os pedidos restantes.

**Acceptance Criteria:**
- [ ] Quando todos os pedidos selecionados estão embalados, modo embalagem fecha automaticamente
- [ ] Toast de resumo: "Embalagem concluída — N pedido(s) embalado(s)"
- [ ] Aba atualiza (refetch) mostrando apenas pedidos que continuam em `aguardando_compra`
- [ ] Se operador cancela antes de terminar: pedidos parcialmente bipados mantêm seu progresso (não reseta)
- [ ] Executar kick do worker de execução ao finalizar (fire-and-forget)
- [ ] Typecheck/lint passa

### US-006: Indicador visual de pedido "engatilhado"

**Description:** Como operador, quero identificar visualmente quais pedidos na aba Aguardando OC estão prontos para embalagem direta.

**Acceptance Criteria:**
- [ ] Cards de pedidos engatilhados (NF + agrupamento) mostram indicador visual (ex: borda verde ou badge "Pronto")
- [ ] Cards não-engatilhados mantêm aparência normal
- [ ] O indicador de etapas existente (N | A | E) já mostra NF e Agrupamento — pode ser suficiente, mas avaliar se precisa de destaque adicional
- [ ] Typecheck/lint passa

## 4. Functional Requirements

- **FR-1:** O sistema deve exibir botão "Embalar" ao lado do "Separar" na aba `aguardando_compra`, contando apenas pedidos engatilhados (`nf_emitida && agrupamento_criado`).
- **FR-2:** O sistema deve abrir um modo de scan inline (sem navegar para outra página) com input de barcode, campo de quantidade, e lista dos pedidos selecionados com progresso.
- **FR-3:** O endpoint `POST /api/separacao/bipar-embalagem-oc` deve aceitar `{ sku: string, pedido_ids: string[], quantidade?: number }` e processar o bip contra os pedidos fornecidos.
- **FR-4:** O bip deve encontrar o pedido mais antigo entre os `pedido_ids` que contenha o SKU escaneado e incrementar `quantidade_bipada` atomicamente.
- **FR-5:** Ao completar um pedido (todos itens bipados), o sistema deve automaticamente: (a) resolver compra items como recebidos, (b) determinar `decisao_final`, (c) transicionar para `embalado`, (d) enfileirar `lancar_estoque`, (e) imprimir etiqueta.
- **FR-6:** A etiqueta deve ser impressa via PrintNode usando ZPL cacheado (fast path) ou fallback via API Tiny, na impressora configurada do operador.
- **FR-7:** O sistema deve adicionar a tag "embalagem direta" ao pedido concluído.
- **FR-8:** O sistema deve registrar evento `embalagem_direta_concluida` no histórico do pedido.
- **FR-9:** Itens com `compra_status` = `indisponivel` ou `cancelado` devem ser excluídos da validação de conclusão.
- **FR-10:** O modo embalagem deve fechar automaticamente quando todos os pedidos selecionados forem concluídos.
- **FR-11:** Se o operador cancelar o modo embalagem, o progresso de bips parciais deve ser mantido (não resetar `quantidade_bipada`).

## 5. Non-Goals (Out of Scope)

- **Não alterar** o fluxo de embalagem existente (tela `/separacao/embalagem`) — este módulo é um atalho paralelo
- **Não criar** nova página — tudo inline na aba
- **Não permitir** embalagem direta para pedidos sem NF ou sem agrupamento concluído
- **Não alterar** o endpoint `bipar-embalagem` existente — criar um endpoint novo dedicado
- **Não expedir** automaticamente — expedição continua como etapa separada no fluxo atual
- **Não reimprimir** etiquetas neste fluxo — usar o botão de reimpressão existente se necessário

## 6. Technical Considerations

### Backend

- **Novo endpoint** `POST /api/separacao/bipar-embalagem-oc`: combina lógica do `bipar-embalagem` (scan + incremento) com lógica do `concluir-oc` (auto-resolve compra + enqueue execution).
- **RPC vs inline:** Avaliar se cria uma nova RPC `siso_processar_bip_embalagem_oc` (atômica no Postgres) ou faz a lógica inline no route handler. RPC é preferível para atomicidade do incremento.
- **Diferença da RPC existente:** `siso_processar_bip_embalagem` filtra por `status_separacao = 'separado'`. A nova deve filtrar por `status_separacao = 'aguardando_compra'` E `pedido_id IN (pedido_ids)`.
- **Label printing:** Reutilizar `imprimirEtiquetaDireta()` e `buscarEImprimirEtiqueta()` de `etiqueta-service.ts`.
- **Execution worker:** Reutilizar enqueue de `concluir-oc` — inserir job `lancar_estoque` em `siso_fila_execucao`.
- **Decisão final:** Reutilizar lógica de `concluir-oc` para determinar propria vs transferencia.

### Frontend

- **Estado local:** O modo embalagem usa estado React local (não precisa de rota/URL).
- **`embalagemMode: boolean`** + **`embalagemPedidoIds: string[]`** + **`bipProgress: Map<string, { bipados: number, total: number }>`**.
- **Scan input:** Reutilizar padrão de `scan-input.tsx` ou da embalagem page.
- **Atualização de cards:** Atualizar progresso localmente após cada bip (otimistic update) + invalidar query ao fechar modo.

### Validação "Engatilhado"

Os campos já estão disponíveis na response de `GET /api/separacao`:
```typescript
const isEngatilhado = pedido.nf_emitida && pedido.agrupamento_criado;
```

### Transição de Status

```
aguardando_compra → (bipar itens um a um) → embalado → expedido
```

Pula: `em_separacao`, `separado`. O pedido vai direto de `aguardando_compra` para `embalado`.

## 7. Success Metrics

- Pedidos OC engatilhados processados em < 2 minutos (vs horas no fluxo completo)
- Zero pedidos embalados sem etiqueta impressa
- 100% dos pedidos embalados por este fluxo têm tag "embalagem direta" para rastreabilidade
- Operadores preferem este atalho ao fluxo Pick OC + Embalagem para pedidos já prontos

## 8. Open Questions

1. **Desfazer bip:** Se o operador bipar errado, deve haver um botão de desfazer (como o `desfazer-bip` da separação) ou os botões +/- são suficientes?
2. **Pedidos parciais:** Se o operador cancelar com bips parciais, deve haver uma forma de retomar depois? O progresso ficaria salvo mas o pedido continuaria em `aguardando_compra`.
3. **Conflito com compras:** Se um pedido está sendo trabalhado no módulo de compras simultaneamente, como resolver? Sugestão: o bip-embalagem-oc deve verificar que o pedido ainda está em `aguardando_compra` antes de processar.
