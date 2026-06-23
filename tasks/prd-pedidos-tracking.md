# PRD: Pedidos Tracking - Rastreamento Universal de Pedidos

## 1. Introduction/Overview

Criar uma página centralizada de rastreamento de pedidos (`/pedidos`) que permita localizar, filtrar e inspecionar qualquer pedido da plataforma — independente do módulo em que se encontra (SISO pendente, separação, compras, expedido, cancelado). Hoje, para acompanhar um pedido, o operador precisa navegar entre 3-4 telas diferentes (SISO, Separação, Compras). Esta página resolve isso com uma visão unificada.

**Público:** Todos os cargos (admin, operador_cwb, operador_sp, comprador), com filtragem por galpão conforme cargo.

**Propósito dual:**
- **Operacional:** encontrar rapidamente qualquer pedido e ver onde está no fluxo
- **Auditoria/diagnóstico:** investigar problemas, ver timeline completa de eventos, observações e dados de estoque/compra

---

## 2. Goals

- Permitir localizar qualquer pedido em < 5 segundos via busca textual ou filtros
- Consolidar todas as informações de um pedido (dados básicos, itens, estoque, compras, histórico, observações, etiquetas, NF) em uma única tela de detalhe
- Dar visibilidade ao status real do pedido combinando `status` (processamento) + `status_separacao` (fulfillment)
- Permitir ações rápidas sem sair da página (reimprimir etiqueta, reprocessar, ver NF)
- Respeitar controle de acesso por galpão/cargo

---

## 3. User Stories

### US-001: Busca rápida por pedido
**Description:** Como operador, quero buscar um pedido por número (Tiny, ML/Shopee), nome do cliente ou SKU para encontrá-lo instantaneamente sem navegar entre módulos.

**Acceptance Criteria:**
- [ ] Campo de busca no topo da página aceita: número do pedido Tiny, ID e-commerce, nome do cliente, SKU de item
- [ ] Busca é case-insensitive e funciona com match parcial
- [ ] Resultados aparecem em < 500ms (debounce de 300ms no input)
- [ ] Busca por SKU retorna todos os pedidos que contêm aquele SKU nos itens
- [ ] Campo de busca tem atalho de foco (ex: `/` ou `Ctrl+K`)

### US-002: Filtros avançados combinados
**Description:** Como admin, quero filtrar pedidos por status, data, empresa de origem, decisão, status de separação e marketplace para encontrar subconjuntos específicos.

**Acceptance Criteria:**
- [ ] Filtros disponíveis: status (multi-select), status_separacao (multi-select), decisão final (propria/transferencia/oc), empresa de origem, marketplace, período (data início/fim), tags/marcadores
- [ ] Filtros são combináveis (AND entre filtros diferentes)
- [ ] Contadores mostram quantos pedidos por status/filtro ativo
- [ ] Filtros persistem na URL (query params) para compartilhar/bookmark
- [ ] Botão "Limpar filtros" reseta tudo
- [ ] Operadores não-admin veem apenas pedidos do seu galpão

### US-003: Lista de pedidos com status combinado
**Description:** Como operador, quero ver uma lista de pedidos com indicação clara de onde cada um está no fluxo (pendente no SISO? em separação? embalado?) para ter visão geral.

**Acceptance Criteria:**
- [ ] Lista exibe: número do pedido, número e-commerce, cliente, marketplace, data, empresa origem, status combinado (processamento + separação), decisão
- [ ] Status combinado é exibido como badge colorido (ex: "Pendente", "Executando > Em Separação", "Concluído > Embalado")
- [ ] Lista é paginada (50 pedidos por página) com scroll infinito ou paginação numérica
- [ ] Ordenação padrão: mais recente primeiro. Permitir ordenar por data, status, número
- [ ] Clicar no pedido abre a tela de detalhe
- [ ] Lista carrega em < 1s com até 500 pedidos

### US-004: Detalhe do pedido - Dados gerais
**Description:** Como operador, quero ver todos os dados de um pedido em uma única tela para não precisar navegar entre módulos.

**Acceptance Criteria:**
- [ ] Header mostra: número pedido, número e-commerce, marketplace (com ícone), cliente (nome + CPF/CNPJ), data do pedido, forma de envio
- [ ] Seção de status mostra: status de processamento, decisão (sugestão + final), tipo resolução (auto/manual), operador que aprovou, status de separação atual
- [ ] Seção de empresa: empresa de origem (nome), galpão, se foi encaminhado (de onde)
- [ ] Marcadores (Tiny) e tags (SISO) exibidos como badges
- [ ] URL direta para o detalhe: `/pedidos/[id]` (compartilhável)

### US-005: Detalhe do pedido - Itens com estoque
**Description:** Como operador, quero ver os itens do pedido com dados de estoque (snapshot do momento da consulta) para entender a decisão que foi tomada.

**Acceptance Criteria:**
- [ ] Tabela de itens mostra: imagem (thumbnail), SKU, descrição, quantidade pedida
- [ ] Para cada item, estoque por galpão: saldo, reservado, disponível, localização
- [ ] Indicação visual se o item atendia ou não no momento (badge verde/vermelho)
- [ ] Se decisão = OC: mostra fornecedor OC, status da compra (aguardando/comprado/recebido), quantidades (solicitada/comprada/recebida)
- [ ] Se item tem exceção (indisponível, equivalente, cancelamento): mostra badge de exceção

### US-006: Detalhe do pedido - Timeline de eventos (histórico)
**Description:** Como admin, quero ver a timeline completa de tudo que aconteceu com o pedido para diagnosticar problemas.

**Acceptance Criteria:**
- [ ] Timeline vertical com todos os eventos do `siso_pedido_historico` em ordem cronológica
- [ ] Cada evento mostra: ícone por tipo, descrição legível do evento, quem fez (se aplicável), quando (data/hora), detalhes extras (se existirem)
- [ ] Eventos cobrem: recebido, auto_aprovado, aprovado, aguardando_nf, nf_autorizada, aguardando_separacao, separacao_iniciada, item_separado, separacao_concluida, embalagem_iniciada, item_embalado, embalagem_concluida, etiqueta_impressa, etiqueta_falhou, cancelado, erro
- [ ] Cores diferentes por categoria (sucesso=verde, erro=vermelho, info=azul, warning=amarelo)
- [ ] Timestamps formatados como "há X minutos" com tooltip mostrando data/hora exata

### US-007: Detalhe do pedido - Observações
**Description:** Como operador, quero ver e adicionar observações/comentários no pedido para comunicar contexto a outros operadores.

**Acceptance Criteria:**
- [ ] Seção de observações abaixo da timeline
- [ ] Exibe observações existentes com: autor, data/hora, texto
- [ ] Campo para adicionar nova observação (textarea + botão enviar)
- [ ] Nova observação aparece imediatamente na lista (optimistic update)

### US-008: Detalhe do pedido - Links e ações
**Description:** Como operador, quero ter links diretos para NF, etiqueta e agrupamento Tiny, além de ações rápidas como reimprimir etiqueta.

**Acceptance Criteria:**
- [ ] Link para NF (se existir `numero_nf`) abrindo no Tiny
- [ ] Link/preview da etiqueta de envio (se `etiqueta_url` existir)
- [ ] Link para agrupamento de expedição no Tiny (se `agrupamento_expedicao_id` existir)
- [ ] Botão "Reimprimir etiqueta" (chama `/api/separacao/reimprimir`)
- [ ] Botão "Reprocessar" para pedidos com erro (chama `/api/webhook/reprocessar`)
- [ ] Botão "Forçar pendente" para admin (chama `/api/separacao/forcar-pendente`)
- [ ] Ações protegidas por cargo (ex: reprocessar/forçar só admin)

### US-009: Indicadores visuais de status
**Description:** Como operador, quero que a página use cores e ícones consistentes para identificar rapidamente o estado dos pedidos.

**Acceptance Criteria:**
- [ ] Cada `status` tem cor definida: pendente=amarelo, executando=azul, concluido=verde, cancelado=cinza, erro=vermelho
- [ ] Cada `status_separacao` tem cor distinta: aguardando_compra=laranja, aguardando_nf=roxo, aguardando_separacao=azul, em_separacao=cyan, embalado=verde
- [ ] Decisões com cores: propria=verde, transferencia=azul, oc=laranja
- [ ] Marketplace com ícones/cores distintas (ML=amarelo, Shopee=laranja)
- [ ] Pedidos com erro destacados visualmente na lista

### US-010: Exportação e compartilhamento
**Description:** Como admin, quero copiar o link direto de um pedido para compartilhar com outro operador.

**Acceptance Criteria:**
- [ ] Botão "Copiar link" no detalhe do pedido que copia a URL `/pedidos/[id]`
- [ ] Toast de confirmação "Link copiado"
- [ ] URL do detalhe é estável e compartilhável

---

## 4. Functional Requirements

**Lista de Pedidos:**
- FR-01: O sistema deve exibir pedidos de todas as origens (SISO, separação, compras) em uma única lista unificada
- FR-02: A busca textual deve pesquisar nos campos: `numero`, `id_pedido_ecommerce`, `cliente_nome`, `item.sku`, `item.gtin`
- FR-03: A lista deve ser paginada com no mínimo 50 itens por página
- FR-04: Operadores devem ver apenas pedidos do seu galpão (filtro automático por `galpao_id` da sessão)
- FR-05: Admin deve ver pedidos de todos os galpões com seletor de galpão opcional

**Detalhe do Pedido:**
- FR-06: A página de detalhe deve carregar dados do pedido, itens com estoque, histórico e observações em uma única chamada (ou chamadas paralelas)
- FR-07: O histórico deve ser exibido como timeline vertical ordenada cronologicamente
- FR-08: Estoque por galpão deve ser exibido de forma dinâmica (sem hardcode CWB/SP)
- FR-09: Dados de compra (OC) devem ser exibidos inline nos itens quando aplicável
- FR-10: Links externos (NF, etiqueta, agrupamento) devem abrir em nova aba

**API:**
- FR-11: Criar endpoint `GET /api/pedidos/tracking` que retorne lista unificada com filtros, busca e paginação
- FR-12: Criar endpoint `GET /api/pedidos/[id]/detalhe` que retorne dados consolidados do pedido (dados + itens + estoque + compra stats + histórico + observações)
- FR-13: Ambos endpoints devem respeitar controle de acesso por cargo/galpão
- FR-14: Busca por SKU deve fazer JOIN em `siso_pedido_itens` e retornar pedidos que contenham o SKU

**Ações:**
- FR-15: Reimprimir etiqueta deve ser permitido apenas para pedidos com `etiqueta_status` existente
- FR-16: Reprocessar deve ser permitido apenas para pedidos com `status = 'erro'`
- FR-17: Forçar pendente deve ser permitido apenas para admin
- FR-18: Todas as ações devem registrar evento no histórico

---

## 5. Non-Goals (Out of Scope)

- **Edição de pedidos:** Esta página é somente visualização + ações pontuais. Não substitui o fluxo de aprovação do SISO nem o picking da separação
- **Dashboard/analytics:** Não é uma página de métricas. Sem gráficos ou KPIs — isso fica em `/painel/gerencial`
- **Exportação para Excel/CSV:** Fora do escopo inicial
- **Notificações/alertas:** Sem push notifications ou alertas em tempo real nesta página
- **Busca full-text avançada:** Busca simples por campos específicos, sem Elasticsearch
- **Histórico de alterações de estoque:** Mostra snapshot do estoque no momento da consulta, não evolução temporal

---

## 6. Technical Considerations

### API
- **Endpoint de listagem (`/api/pedidos/tracking`):** Query com JOINs em `siso_pedidos`, `siso_pedido_itens` (para busca por SKU), `siso_empresas`, `siso_galpoes`. Usar `COUNT` para contadores de filtro. Paginação via `offset/limit` ou cursor.
- **Endpoint de detalhe (`/api/pedidos/[id]/detalhe`):** Consolidar dados de `siso_pedidos`, `siso_pedido_itens`, `siso_pedido_item_estoques`, `siso_pedido_historico`, `siso_pedido_observacoes`, `siso_ordens_compra`. Pode fazer chamadas paralelas no frontend via React Query.

### Frontend
- Reutilizar componentes existentes: `pedido-card.tsx`, `pedido-timeline.tsx`, `observacoes-timeline.tsx`
- Nova rota: `src/app/pedidos/page.tsx` (lista) + `src/app/pedidos/[id]/page.tsx` (detalhe)
- Filtros na URL via `useSearchParams` para persistência
- React Query com keys compostas para cache granular
- Layout: seguir padrão existente (max-w-3xl, zinc palette, mobile-first)

### Performance
- Índices necessários: `siso_pedido_itens(sku)` para busca por SKU (verificar se já existe)
- Considerar view materializada se a query unificada ficar lenta com volume
- Paginação obrigatória — nunca carregar todos os pedidos de uma vez
- Debounce na busca textual (300ms)

### Acesso
- Usar `getSessionUser()` para validar sessão
- Cargo `operador_cwb` / `operador_sp` → filtrar por `galpao_id` da sessão
- Cargo `comprador` → filtrar por `decisao_final = 'oc'`
- Cargo `admin` → sem filtro (seletor de galpão opcional)

---

## 7. Success Metrics

- Operadores conseguem localizar qualquer pedido em < 10 segundos
- Redução de navegação entre módulos: operadores não precisam abrir SISO + Separação + Compras para rastrear um pedido
- Página de detalhe carrega todas as informações em < 2 segundos
- Zero pedidos "perdidos" — todos os pedidos do sistema são visíveis nesta página

---

## 8. Decisões (Resolvidas)

1. **Retenção de dados:** Filtro de data dinâmico — padrão últimos 30 dias, expansível pelo usuário sem limite
2. **Pedidos expedidos:** Aba separada "Expedidos" na lista
3. **Link para Tiny:** Não necessário por agora
4. **Destaque embalados parados:** Sim, destacar visualmente pedidos embalados há > 24h sem expedir
5. **Menu de navegação:** No header principal, ao lado de SISO e Separação
