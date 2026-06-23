# PRD: Módulo Segunda Venda

## 1. Introdução

Quando um vendedor realiza uma venda adicional (cross-sell/upsell) para um cliente que já tem um pedido no marketplace, muitas vezes o pedido original ainda não chegou ao SISO via webhook. Hoje não existe forma de registrar esses itens extras antecipadamente — o vendedor precisa esperar o pedido cair, localizar o operador, e pedir manualmente para incluir.

O módulo **Segunda Venda** permite que vendedores pré-registrem itens adicionais vinculados a um ID de pedido do marketplace. Quando o pedido entra no sistema via webhook, os itens são automaticamente incorporados. Se o pedido já existe mas ainda não entrou em separação, os itens são adicionados na hora. Se já está em separação ou adiante, o vendedor é orientado a contatar o operador.

---

## 2. Goals

- Eliminar a dependência de comunicação informal (WhatsApp/verbal) entre vendedor e operador para inclusão de itens adicionais
- Garantir que itens de segunda venda sejam incluídos automaticamente sem intervenção manual
- Dar visibilidade ao vendedor sobre o status dos seus registros (pendente, matched, expirado)
- Manter rastreabilidade completa no histórico do pedido

---

## 3. User Stories

### US-001: Registrar Segunda Venda
**Description:** Como vendedor, quero registrar itens adicionais para um pedido do marketplace que ainda não chegou no sistema, para que sejam incluídos automaticamente quando o pedido entrar.

**Acceptance Criteria:**
- [ ] Tela com campo para ID do pedido no marketplace (ex: `2000013659039448`)
- [ ] Campo para adicionar 1+ itens: SKU + quantidade
- [ ] Validação: SKU deve existir no Tiny (busca por SKU retorna produto válido)
- [ ] Validação: quantidade > 0
- [ ] Ao salvar, registro fica com status `pendente`
- [ ] Se o pedido já existe no SISO e `status_separacao` é NULL ou está em (`aguardando_compra`, `aguardando_nf`, `aguardando_separacao`): itens são adicionados imediatamente e status muda para `aplicado`
- [ ] Se o pedido já existe mas `status_separacao` é (`validacao_oc`, `em_separacao`, `separado`, `embalado`): mostra mensagem com o status atual e orienta o vendedor a falar com o operador
- [ ] Registro salvo com `usuario_id` de quem criou
- [ ] Typecheck/lint passes

### US-002: Listar Registros de Segunda Venda
**Description:** Como vendedor, quero ver todos os meus registros de segunda venda para acompanhar quais foram aplicados e quais ainda estão pendentes.

**Acceptance Criteria:**
- [ ] Listagem com filtros: status (`pendente`, `aplicado`, `expirado`, `cancelado`), data
- [ ] Cada registro mostra: ID marketplace, itens (SKU + qty), status, data de criação, data de match (se aplicado)
- [ ] Vendedor vê apenas seus próprios registros; admin vê todos
- [ ] Ordenação padrão: mais recente primeiro
- [ ] Typecheck/lint passes

### US-003: Editar Registro Pendente
**Description:** Como vendedor, quero editar um registro pendente (alterar SKU, quantidade, ou adicionar/remover itens) antes que ele seja aplicado.

**Acceptance Criteria:**
- [ ] Apenas registros com status `pendente` podem ser editados
- [ ] Pode alterar SKU, quantidade, adicionar novos itens, remover itens
- [ ] Mesmas validações de criação (SKU válido, qty > 0)
- [ ] Histórico registra a edição
- [ ] Typecheck/lint passes

### US-004: Cancelar Registro
**Description:** Como vendedor, quero cancelar um registro de segunda venda que criei por engano ou que não é mais necessário.

**Acceptance Criteria:**
- [ ] Apenas registros com status `pendente` podem ser cancelados
- [ ] Cancelamento pede confirmação
- [ ] Status muda para `cancelado`
- [ ] Typecheck/lint passes

### US-005: Match Automático no Webhook
**Description:** Como sistema, quando um pedido entra via webhook, devo verificar se existem registros de segunda venda pendentes para aquele `id_pedido_ecommerce` e incluir os itens automaticamente.

**Acceptance Criteria:**
- [ ] Após salvar o pedido no `siso_pedidos`, o webhook processor consulta `siso_segunda_venda` por `id_pedido_ecommerce` com status `pendente`
- [ ] Para cada registro encontrado, insere os itens em `siso_pedido_itens` vinculados ao pedido
- [ ] Itens inseridos recebem flag `origem = 'segunda_venda'` para rastreabilidade
- [ ] Status do registro muda de `pendente` para `aplicado` com timestamp
- [ ] Evento registrado no `siso_pedido_historico`: "Itens de segunda venda incluídos automaticamente"
- [ ] Se o registro tem itens com SKU que já existe no pedido, soma a quantidade
- [ ] Processo é silencioso (sem notificação ao operador)
- [ ] Typecheck/lint passes

### US-006: Expiração de Registros
**Description:** Como sistema, registros pendentes que não tiveram match após um período devem ser marcados como expirados para manter a base limpa.

**Acceptance Criteria:**
- [ ] Registros `pendente` criados há mais de 7 dias sem match são marcados como `expirado`
- [ ] Expiração pode ser executada via cron ou checada no momento da listagem
- [ ] Vendedor pode ver registros expirados na listagem (filtro de status)
- [ ] Typecheck/lint passes

### US-007: Histórico no Pedido
**Description:** Como operador/admin, quero ver no detalhe do pedido quais itens vieram de segunda venda para ter rastreabilidade completa.

**Acceptance Criteria:**
- [ ] Na tela de detalhe do pedido (`/pedidos/[id]`), itens vindos de segunda venda têm indicador visual (badge/tag)
- [ ] Timeline do pedido mostra evento de inclusão de segunda venda com link para o registro original
- [ ] Typecheck/lint passes

---

## 4. Functional Requirements

**FR-1:** O sistema deve criar uma nova tabela `siso_segunda_venda` com campos: `id`, `id_pedido_ecommerce` (text, not null), `pedido_id` (FK nullable — preenchido no match), `usuario_id` (FK), `status` (enum: pendente/aplicado/expirado/cancelado), `created_at`, `matched_at`, `cancelled_at`.

**FR-2:** O sistema deve criar uma tabela `siso_segunda_venda_itens` com campos: `id`, `segunda_venda_id` (FK), `sku` (text), `produto_id` (text nullable — resolvido no match), `quantidade` (int), `descricao` (text — snapshot do nome do produto no momento do registro).

**FR-3:** O webhook processor (`webhook-processor.ts`) deve, após o upsert do pedido, consultar registros pendentes em `siso_segunda_venda` pelo `id_pedido_ecommerce` e aplicar os itens.

**FR-4:** Ao aplicar itens de segunda venda, o sistema deve resolver o `produto_id` a partir do SKU via Tiny API (busca produto por SKU), obter dados completos (descrição, GTIN, unidade) e inserir em `siso_pedido_itens`.

**FR-5:** Se um item de segunda venda tem o mesmo SKU de um item já existente no pedido, o sistema deve somar as quantidades em vez de duplicar a linha.

**FR-6:** A tela de segunda venda deve estar acessível em `/segunda-venda` e no menu principal para usuários com cargo `vendedor`.

**FR-7:** O campo de busca de SKU deve validar contra o Tiny em tempo real (debounce 500ms) e mostrar descrição + imagem thumbnail se disponível.

**FR-8:** Ao tentar registrar para um pedido que já existe no SISO:
  - Se `status_separacao` é NULL, `aguardando_compra`, `aguardando_nf`, ou `aguardando_separacao`: aplica imediatamente.
  - Se `status_separacao` é `validacao_oc`, `em_separacao`, `separado`, ou `embalado`: exibe mensagem "Este pedido já está em **[status legível]**. Fale com o operador para incluir os itens."

**FR-9:** O cargo `vendedor` deve ser adicionado ao sistema de auth. Vendedores só têm acesso ao módulo `/segunda-venda` e à tela de login.

**FR-10:** Admin pode ver todos os registros de segunda venda de todos os vendedores. Vendedor vê apenas os seus.

**FR-11:** Registros `pendente` com mais de 7 dias devem ser automaticamente marcados como `expirado`.

**FR-12:** Toda aplicação de segunda venda deve gerar evento em `siso_pedido_historico` com `evento: 'segunda_venda_aplicada'` e `detalhes` contendo os itens adicionados.

---

## 5. Non-Goals (Out of Scope)

- **Notificações push/WhatsApp** para o vendedor quando o match acontecer (v1 usa listagem com status)
- **Remoção de itens** do pedido original via segunda venda (apenas adição)
- **Alteração de preço** — os itens entram com preço zero/sem preço; o ajuste financeiro é feito fora do SISO
- **Integração com marketplace** — não altera o pedido no Mercado Livre/Shopee, apenas no SISO
- **Workflow de aprovação** — itens são incluídos automaticamente sem aprovação do operador
- **Estoque** — os itens de segunda venda não passam pela lógica de sugestão de decisão (propria/transferencia/oc); assumem o mesmo fluxo do pedido pai

---

## 6. Technical Considerations

### Database
- Nova tabela `siso_segunda_venda` + `siso_segunda_venda_itens`
- Index em `id_pedido_ecommerce` + `status` para busca rápida no webhook
- FK para `siso_usuarios` (quem registrou) e `siso_pedidos` (após match)

### Webhook Processor
- A consulta de segunda venda deve acontecer **após** o upsert do pedido em `siso_pedidos` e **antes** do cálculo de sugestão de decisão, pois os itens adicionais afetam o estoque necessário
- Importante: se itens de segunda venda forem adicionados, a verificação de estoque e sugestão devem considerar TODOS os itens (originais + segunda venda)

### Auth
- Novo cargo `vendedor` no `siso_usuarios`
- `filtrar-pedidos.ts` e `session.ts` devem reconhecer o cargo
- `AppShell` deve mostrar apenas `/segunda-venda` para vendedores

### Tiny API
- Busca de produto por SKU: `GET /produtos?pesquisa={sku}` — pode retornar múltiplos, filtrar por match exato no campo `codigo`
- Rate limiting: usa `tiny-queue.ts` existente, precisa de `empresa_id` — a empresa padrão pode ser a primeira do grupo ou configurável

### Concorrência
- Possível race condition: vendedor registra enquanto webhook está processando. Usar transaction ou check-and-set para evitar duplicação.

---

## 7. Success Metrics

| Métrica | Target |
|---|---|
| % de segundas vendas aplicadas automaticamente (sem intervenção manual) | > 90% |
| Tempo médio entre registro e match | < 2 horas |
| Registros expirados sem match (indica erro de ID) | < 5% |
| Redução de comunicações informais vendedor→operador para inclusão de itens | Qualitativo — feedback da equipe |

---

## 8. Open Questions

1. **Preço dos itens:** Os itens de segunda venda entram com preço zero? Ou o vendedor informa o preço de venda? (impacta NF e financeiro)
2. **Empresa:** Quando o vendedor registra, ele precisa selecionar a empresa ou usa a mesma do pedido original? Se o pedido ainda não existe, qual empresa usar para validar SKU no Tiny?
3. **Múltiplas segundas vendas:** Um mesmo `id_pedido_ecommerce` pode ter mais de um registro de segunda venda? (ex: vendedor registra 2x em momentos diferentes)
4. **Desfazer match:** Se um match foi feito incorretamente (SKU errado), é possível desfazer? Ou o operador resolve manualmente?
5. **Impacto na decisão:** Se os itens adicionais mudam a sugestão de decisão (ex: de `propria` para `oc`), isso deve ser recalculado automaticamente?
