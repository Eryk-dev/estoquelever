# PRD — Compras v2 + Fix produto_id + Troca SKU

## 1. Introduction/Overview

O módulo de compras atual usa ordens de compra (OCs) formais que fragmentam a visão do comprador e dificultam o acompanhamento dos itens pendentes. Este PRD cobre três frentes interligadas:

1. **Fix do produto_id por empresa** — corrigir o armazenamento do ID do produto no Tiny para cada empresa, eliminando buscas por SKU que falham
2. **Compras v2** — reformular o módulo de compras para uma visão única por fornecedor, sem OCs formais, com recebimento inline e processamento automático pós-recebimento
3. **Troca de SKU** — permitir trocar o código de um produto por equivalente nas telas de Compras e SISO, com recalculo automático de fornecedor e estoque

Volume: ~500 pedidos/dia, taxa de ruptura estimada 15-20% = 50-100 itens em compra simultâneos de 6-8 fornecedores.

---

## 2. Goals

- Eliminar o erro "Produto não encontrado na empresa suporte" causado por busca por SKU em tempo real
- Reduzir o tempo do comprador para visualizar e agir sobre itens pendentes (de múltiplos cliques em OCs para uma tela única)
- Dar visibilidade imediata de quais pedidos de clientes estão travados por cada item de compra
- Permitir recebimento parcial com alocação automática por aging
- Automatizar o pipeline pós-recebimento (NF → etiqueta → oferta de embalagem)
- Permitir troca de SKU equivalente com recalculo de fornecedor e estoque

---

## 3. User Stories

### US-001: Fix produto_id por empresa (banco)
**Description:** Como sistema, preciso armazenar o ID do produto no Tiny para cada empresa separadamente, para não precisar buscar por SKU em tempo real quando operar no estoque de outra empresa.

**Acceptance Criteria:**
- [ ] Nova coluna `produto_id_na_empresa` (bigint, nullable) em `siso_pedido_item_estoques`
- [ ] Migration criada em `supabase/migrations/`
- [ ] Typecheck/lint passa

---

### US-002: Fix produto_id por empresa (webhook processor)
**Description:** Como sistema, ao processar um webhook de pedido, preciso gravar o `produtoIdNaEmpresa` correto na coluna `produto_id_na_empresa` de `siso_pedido_item_estoques`.

**Acceptance Criteria:**
- [ ] `webhook-processor.ts` grava `produtoIdNaEmpresa` (que já é resolvido via `buscarProdutoPorSku` ou ID direto) na nova coluna ao inserir em `siso_pedido_item_estoques`
- [ ] Para a empresa origem, `produto_id_na_empresa` = `produto_id` (ID do pedido)
- [ ] Para outras empresas, `produto_id_na_empresa` = ID retornado por `buscarProdutoPorSku`
- [ ] Log de warning se `produto_id_na_empresa` for null para alguma empresa
- [ ] Typecheck/lint passa

---

### US-003: Fix produto_id por empresa (execution worker)
**Description:** Como execution-worker, preciso usar o `produto_id_na_empresa` da tabela `siso_pedido_item_estoques` para deduzir estoque, em vez de buscar por SKU em tempo real.

**Acceptance Criteria:**
- [ ] `execution-worker.ts` na função de transferência consulta `produto_id_na_empresa` de `siso_pedido_item_estoques` para a empresa escolhida
- [ ] Se `produto_id_na_empresa` existe, usa direto (sem chamar `buscarProdutoPorSku`)
- [ ] Se `produto_id_na_empresa` é null, faz fallback para `buscarProdutoPorSku` (backwards compat)
- [ ] Erro "Produto não encontrado na empresa suporte" só acontece quando ambos os caminhos falham
- [ ] Typecheck/lint passa

---

### US-004: Backfill produto_id_na_empresa
**Description:** Como sistema, preciso preencher `produto_id_na_empresa` para registros existentes em `siso_pedido_item_estoques` que ainda não têm esse campo.

**Acceptance Criteria:**
- [ ] Script ou migration que copia `produto_id` para `produto_id_na_empresa` nos registros da empresa origem (onde `empresa_id = empresa_origem_id` do pedido)
- [ ] Para registros de outras empresas, marca como null (será preenchido no próximo processamento ou pode ser feito via batch com buscarProdutoPorSku)
- [ ] Não quebra registros existentes

---

### US-005: API de Compras v2 — listagem por fornecedor
**Description:** Como comprador/operador, preciso de um endpoint que retorne itens de compra agrupados por fornecedor, com pedidos vinculados e contadores.

**Acceptance Criteria:**
- [ ] `GET /api/compras` retorna lista de fornecedores, cada um com:
  - `fornecedor`: nome do fornecedor
  - `galpao_sugerido`: galpão onde a compra seria feita
  - `para_comprar`: array de itens com `compra_status = 'aguardando_compra'`
  - `aguardando_entrega`: array de itens com `compra_status = 'comprado'` (parcialmente recebidos inclusos)
  - `pedidos_bloqueados`: contagem de pedidos distintos esperando itens deste fornecedor
  - `aging_dias`: dias desde o item mais antigo
- [ ] Cada item inclui array de `pedidos` vinculados (número, cliente_nome, quantidade necessária, aging em dias)
- [ ] Itens consolidados por SKU dentro do fornecedor (um SKU pode aparecer em vários pedidos)
- [ ] Qty a comprar preset = soma das quantidades de todos os pedidos para aquele SKU
- [ ] Fornecedores ordenados por `pedidos_bloqueados` desc
- [ ] Fornecedores com 0 itens pendentes e 0 aguardando não aparecem
- [ ] Suporta query param `?tab=pendentes` (default) e `?tab=recebidos` (histórico)
- [ ] Tab `recebidos` retorna itens com `compra_status = 'recebido'` agrupados por fornecedor + data
- [ ] Contagens para as tabs retornadas no response
- [ ] Typecheck/lint passa

---

### US-006: API de Compras v2 — marcar como comprado
**Description:** Como comprador, preciso marcar itens de um fornecedor como comprados, informando a quantidade efetivamente pedida.

**Acceptance Criteria:**
- [ ] `POST /api/compras/comprar` aceita array de `{ sku, quantidade_comprada }` e `fornecedor`
- [ ] Valida que o usuário tem cargo `comprador` ou `admin`
- [ ] A `quantidade_comprada` é consolidada por SKU (não por item de pedido)
- [ ] Distribui a `quantidade_comprada` pelos itens de pedido do mesmo SKU, por aging (mais antigo primeiro)
- [ ] Cada item de pedido recebe `compra_status = 'comprado'`, `comprado_em = now()`, `compra_quantidade_comprada` proporcional
- [ ] Se `quantidade_comprada` < soma dos pedidos, os itens mais novos ficam como `aguardando_compra` com a quantidade restante
- [ ] Se `quantidade_comprada` > soma dos pedidos, o excedente é registrado (campo ou observação) para controle
- [ ] Registra quem comprou (`comprado_por_id`, `comprado_por_nome`)
- [ ] Retorna os itens atualizados
- [ ] Typecheck/lint passa

---

### US-007: API de Compras v2 — confirmar recebimento
**Description:** Como operador/comprador, preciso confirmar o recebimento de itens de um fornecedor com suporte a recebimento parcial.

**Acceptance Criteria:**
- [ ] `POST /api/compras/receber` aceita array de `{ sku, quantidade_recebida, observacao? }`
- [ ] Aloca unidades recebidas por aging (pedidos mais antigos primeiro)
- [ ] Atualiza `compra_quantidade_recebida` em cada item de pedido proporcionalmente
- [ ] Se qty recebida = qty comprada para aquele SKU → itens ficam `compra_status = 'recebido'`
- [ ] Se qty recebida < qty comprada → itens parcialmente recebidos continuam como `comprado`, qty restante atualizada
- [ ] Identifica pedidos desbloqueados (todos os itens de compra do pedido com status `recebido`)
- [ ] Para pedidos desbloqueados: cria job prioritário na `siso_fila_execucao` (flag de prioridade)
- [ ] Retorna `{ pedidos_desbloqueados: string[], itens_atualizados: [...] }`
- [ ] Registra observação de divergência se fornecida (nunca trava o fluxo)
- [ ] Typecheck/lint passa

---

### US-008: Worker prioritário pós-recebimento
**Description:** Como sistema, preciso processar pedidos desbloqueados por recebimento de compra com prioridade alta no execution-worker.

**Acceptance Criteria:**
- [ ] `siso_fila_execucao` aceita flag `prioridade` (ou campo `tipo = 'compra_recebimento'`)
- [ ] Execution-worker processa jobs prioritários antes dos normais
- [ ] Pipeline do job: lançar estoque no Tiny → gerar NF → obter etiqueta de envio
- [ ] Pedidos que completam com sucesso: `status_separacao = 'separado'`
- [ ] Pedidos que falham (NF ou etiqueta): `status_separacao = 'aguardando_nf'`, seguem fila normal
- [ ] Typecheck/lint passa

---

### US-009: API de progresso pós-recebimento
**Description:** Como operador, preciso acompanhar em tempo real o progresso do processamento dos pedidos desbloqueados.

**Acceptance Criteria:**
- [ ] `GET /api/compras/progresso?pedidos=id1,id2,id3` retorna status de cada pedido
- [ ] Cada pedido retorna: `{ pedido_id, numero, status: 'processando' | 'pronto' | 'erro', etapa?: string }`
- [ ] Endpoint é leve (polling a cada 2-3s)
- [ ] Quando todos terminaram (pronto ou erro), retorna `{ concluido: true, prontos: [...], erros: [...] }`
- [ ] Typecheck/lint passa

---

### US-010: Tela de Compras v2 — visão por fornecedor
**Description:** Como comprador/operador, preciso de uma tela única que mostre todos os fornecedores com itens pendentes, expandíveis inline.

**Acceptance Criteria:**
- [ ] Tela `/compras` mostra lista de cards por fornecedor
- [ ] Cada card mostra: nome do fornecedor, contadores (para comprar, aguardando entrega, pedidos bloqueados)
- [ ] Card é expandível/colapsável
- [ ] Expandido mostra duas seções: "Para Comprar" e "Aguardando Entrega"
- [ ] Seção "Para Comprar": cada SKU com checkbox, qty editável (input numérico, preset = soma pedidos), lista de pedidos vinculados (número, cliente, qty, aging em dias)
- [ ] Seção "Aguardando Entrega": cada SKU com qty comprada, qty recebida (X/Y), aging desde compra, lista de pedidos vinculados
- [ ] Fornecedores sem pendências não aparecem
- [ ] Fornecedores ordenados por pedidos bloqueados (desc)
- [ ] Tabs: "Pendentes" (default) e "Recebidos" (histórico)
- [ ] Mobile-first (max-w-3xl), Tailwind 4, sem component library
- [ ] Typecheck/lint passa

---

### US-011: Tela de Compras v2 — ação de comprar
**Description:** Como comprador, preciso selecionar itens de um fornecedor e marcar como comprado com confirmação de quantidade.

**Acceptance Criteria:**
- [ ] Checkboxes nos itens "Para Comprar"
- [ ] Botão "Marcar como comprado" aparece quando há itens selecionados
- [ ] Botão só visível para cargo `comprador` ou `admin`
- [ ] Qty de cada item é editável (pra cima ou pra baixo) antes de confirmar
- [ ] Ao confirmar, chama `POST /api/compras/comprar`
- [ ] Itens comprados movem pra seção "Aguardando Entrega" (otimistic update ou refetch)
- [ ] Toast de sucesso com resumo
- [ ] Typecheck/lint passa

---

### US-012: Tela de Compras v2 — recebimento
**Description:** Como operador, preciso informar as quantidades recebidas e confirmar o recebimento.

**Acceptance Criteria:**
- [ ] Itens "Aguardando Entrega" têm input de qty recebida (number picker)
- [ ] Botão "Confirmar recebimento" quando há qty > 0 informada
- [ ] Ao confirmar, chama `POST /api/compras/receber`
- [ ] Se há pedidos desbloqueados: mostra barra de progresso (polling `GET /api/compras/progresso`)
- [ ] Barra mostra cada pedido com status (processando/pronto/erro)
- [ ] Quando todos concluem: modal "X pedido(s) prontos para embalagem. Embalar agora?"
  - Sim → redireciona para `/separacao?tab=embalagem&pedidos=id1,id2`
  - Não → fecha modal, pedidos ficam como "separado" na fila normal
- [ ] Pedidos com erro: mensagem informativa, seguem fila normal
- [ ] Toast de sucesso com resumo do recebimento
- [ ] Typecheck/lint passa

---

### US-013: Tela de Compras v2 — histórico
**Description:** Como comprador/operador, preciso ver o histórico de itens já recebidos.

**Acceptance Criteria:**
- [ ] Tab "Recebidos" na tela `/compras`
- [ ] Lista de fornecedores com itens recebidos, agrupados por data de recebimento
- [ ] Cada item mostra: SKU, descrição, qty recebida, data, quem recebeu
- [ ] Fornecedores colapsáveis
- [ ] Mais recentes primeiro
- [ ] Typecheck/lint passa

---

### US-014: Ações por item — trocar SKU (Compras)
**Description:** Como operador/comprador, preciso trocar o SKU de um item pendente de compra por um equivalente.

**Acceptance Criteria:**
- [ ] Botão "Trocar SKU" em cada item (seção "Para Comprar")
- [ ] Abre input inline para digitar o novo SKU
- [ ] `POST /api/compras/trocar-sku` aceita `{ item_ids: string[], novo_sku: string }`
- [ ] Backend recalcula fornecedor pelo prefixo do novo SKU (`sku-fornecedor.ts`)
- [ ] Backend consulta estoque do novo SKU em todas as empresas do grupo
- [ ] Se tem estoque: item sai de compras, pedido vai pra `aguardando_nf`, resposta indica que pedido foi liberado
- [ ] Se não tem estoque: item atualiza SKU e fornecedor, migra pro card do novo fornecedor
- [ ] Atualiza `produto_id_na_empresa` em `siso_pedido_item_estoques` com os IDs do novo produto
- [ ] UI refaz fetch e mostra o item no card correto
- [ ] Typecheck/lint passa

---

### US-015: Ações por item — trocar SKU (SISO)
**Description:** Como operador, na tela de decisão de pedidos (/siso), preciso trocar o SKU de um item que não tem estoque por um equivalente.

**Acceptance Criteria:**
- [ ] Botão "Trocar SKU" aparece nos itens do pedido que têm sugestão `oc` (sem estoque)
- [ ] Mesmo endpoint `POST /api/compras/trocar-sku` (reutilizado)
- [ ] Se o novo SKU tem estoque, a sugestão do pedido é recalculada (pode mudar de `oc` para `propria` ou `transferencia`)
- [ ] UI do pedido card atualiza para refletir a nova sugestão
- [ ] Typecheck/lint passa

---

### US-016: Ações por item — marcar indisponível
**Description:** Como operador/comprador, preciso marcar um item como indisponível quando o fornecedor não tem o produto.

**Acceptance Criteria:**
- [ ] Botão "Indisponível" em cada item
- [ ] Pede motivo (input texto, obrigatório)
- [ ] `POST /api/compras/indisponivel` atualiza `compra_status = 'indisponivel'` com motivo
- [ ] Item sai da lista de pendentes
- [ ] Typecheck/lint passa

---

### US-017: Migração de dados das OCs existentes
**Description:** Como sistema, preciso migrar os dados das OCs abertas para o novo modelo, preservando o estado dos itens.

**Acceptance Criteria:**
- [ ] Migration script que para cada item em OC com status `comprado` ou `parcialmente_recebido`:
  - Garante que `compra_status` em `siso_pedido_itens` reflete o estado correto
  - Preenche `compra_quantidade_comprada` com base na qty da OC
  - Preserva `comprado_em` e `compra_quantidade_recebida`
- [ ] Tabela `siso_ordens_compra` mantida como read-only (sem deletes)
- [ ] Novo fluxo não lê nem escreve em `siso_ordens_compra`
- [ ] Typecheck/lint passa

---

### US-018: Campo compra_quantidade_comprada
**Description:** Como sistema, preciso de um campo para armazenar a quantidade efetivamente comprada pelo comprador, que pode diferir da quantidade necessária.

**Acceptance Criteria:**
- [ ] Nova coluna `compra_quantidade_comprada` (integer, nullable) em `siso_pedido_itens`
- [ ] Migration criada
- [ ] Valor preenchido no fluxo de "marcar como comprado" (US-006)
- [ ] Typecheck/lint passa

---

## 4. Functional Requirements

**Produto ID:**
- FR-1: O sistema deve armazenar o ID do produto no Tiny para cada empresa em `siso_pedido_item_estoques.produto_id_na_empresa`
- FR-2: O webhook processor deve gravar `produtoIdNaEmpresa` ao inserir estoques por empresa
- FR-3: O execution-worker deve usar `produto_id_na_empresa` como fonte primária, com fallback para busca por SKU

**Compras — visão:**
- FR-4: A tela de compras deve agrupar itens por fornecedor (calculado via prefixo do SKU)
- FR-5: Itens do mesmo SKU de pedidos diferentes devem ser consolidados no mesmo card com qty somada
- FR-6: Cada item deve mostrar a lista de pedidos de clientes bloqueados por aquele item
- FR-7: Fornecedores devem ser ordenados por quantidade de pedidos bloqueados (desc)
- FR-8: Fornecedores sem itens pendentes e sem itens aguardando não aparecem na lista principal

**Compras — ações:**
- FR-9: Apenas usuários com cargo `comprador` ou `admin` podem marcar itens como comprado
- FR-10: A quantidade a comprar deve vir preenchida com a soma dos pedidos, editável pra cima ou pra baixo
- FR-11: A quantidade comprada é consolidada por SKU no fornecedor, não por item de pedido
- FR-12: Ao marcar como comprado com qty menor que a necessária, os pedidos mais novos ficam como `aguardando_compra`
- FR-13: Todos os perfis (exceto restrito por galpão sem acesso) podem confirmar recebimento
- FR-14: Recebimento parcial é suportado — unidades recebidas são alocadas por aging (mais antigo primeiro)
- FR-15: Divergência no recebimento é registrada como observação mas nunca trava o fluxo

**Compras — pós-recebimento:**
- FR-16: Pedidos desbloqueados geram jobs prioritários na fila de execução
- FR-17: O execution-worker processa jobs prioritários antes dos normais
- FR-18: Pipeline do job prioritário: lançar estoque → gerar NF → obter etiqueta
- FR-19: Pedidos processados com sucesso ficam como `separado`
- FR-20: Pedidos que falharam ficam como `aguardando_nf` e seguem fila normal
- FR-21: Operador vê barra de progresso em tempo real
- FR-22: Ao concluir, modal oferece "Embalar agora?" com redirect para separação

**Troca de SKU:**
- FR-23: Troca de SKU disponível em Compras e SISO
- FR-24: No SISO, troca de SKU aparece apenas em itens com sugestão `oc` (sem estoque)
- FR-25: Ao trocar SKU, sistema recalcula fornecedor pelo prefixo
- FR-26: Ao trocar SKU, sistema consulta estoque do novo SKU em todas as empresas do grupo
- FR-27: Se novo SKU tem estoque, item sai de compras e pedido entra no pipeline normal
- FR-28: Se novo SKU não tem estoque, item migra para o card do novo fornecedor
- FR-29: `produto_id_na_empresa` é atualizado com os IDs do novo produto

---

## 5. Non-Goals (Out of Scope)

- **Devolução ao fornecedor** — item chegou com defeito (v2.1)
- **Cancelamento pós-compra** — cliente cancelou mas item já foi encomendado (v2.1)
- **Compra preventiva** — comprar estoque sem pedido por trás (v2.1)
- **Métricas de fornecedor** — tempo médio de entrega, taxa de parcial (v2.1)
- **Notificações push** — avisar comprador quando novos itens entram na fila (v2.1)
- **Rastreabilidade financeira** — valor da compra, NF do fornecedor, conciliação (v2.1)
- **Remoção da tabela siso_ordens_compra** — mantida como read-only para histórico

---

## 6. Technical Considerations

### Banco de dados
- Nova coluna `produto_id_na_empresa` em `siso_pedido_item_estoques` (bigint, nullable)
- Nova coluna `compra_quantidade_comprada` em `siso_pedido_itens` (integer, nullable)
- Flag de prioridade em `siso_fila_execucao` (boolean ou enum)
- Tabela `siso_ordens_compra` mantida read-only, sem novos inserts

### Alocação por aging
Quando a qty comprada ou recebida é menor que o total necessário, o sistema distribui por data de criação do pedido (mais antigo primeiro). Itens do mesmo SKU em pedidos diferentes são tratados como demanda separada.

### Rate limiting Tiny API
O worker prioritário usa a mesma fila de rate limiting por empresa. Com 10-15 pedidos desbloqueados simultâneos, o processamento pode levar minutos. A UI deve comunicar isso claramente via barra de progresso.

### Backwards compatibility
- O webhook processor continua gravando os campos legados (`produto_id`, `produto_id_suporte`, `produto_id_tiny`)
- O execution-worker faz fallback para `buscarProdutoPorSku` se `produto_id_na_empresa` é null
- A tabela `siso_ordens_compra` não é deletada

### Consolidação por SKU
Na API, itens de pedidos diferentes com o mesmo SKU são consolidados num único registro visual com qty somada. A `compra_quantidade_comprada` é por SKU no fornecedor (distribuída proporcionalmente pelos itens de pedido).

---

## 7. Success Metrics

- Erro "Produto não encontrado na empresa suporte" cai para zero em pedidos novos
- Tempo médio do comprador para visualizar e agir sobre pendências reduz (de navegar por OCs para tela única)
- 100% dos recebimentos parciais alocam corretamente por aging
- Pedidos desbloqueados por recebimento são processados automaticamente sem intervenção manual

---

## 8. Open Questions

- **Batch size no worker prioritário:** processar todos os pedidos desbloqueados em paralelo (mais rápido, mais carga na API Tiny) ou sequencial (mais lento, mais seguro)?
- **Histórico de recebidos:** quanto tempo manter visível? 30 dias? Sem limite?
- **Excedente de compra:** quando o comprador compra mais que o necessário, como registrar? Campo separado ou observação?

---

## Ordem de implementação sugerida

1. US-001 → US-002 → US-003 → US-004 (fix produto_id — resolve bug existente)
2. US-018 → US-017 (banco + migração de dados)
3. US-005 → US-006 → US-007 (APIs do novo fluxo)
4. US-008 → US-009 (worker prioritário + progresso)
5. US-010 → US-011 → US-012 → US-013 (frontend)
6. US-014 → US-015 (troca SKU)
7. US-016 (indisponível)
