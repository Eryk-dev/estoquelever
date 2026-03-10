# PRD — Agregador de Separação por Galpão

## 1. Introdução / Visão Geral

O Tiny ERP gerencia separação por conta individual, mostrando a localização do produto cadastrada **naquela conta**. Quando um pedido de São Paulo precisa de estoque de Curitiba (transferência), o operador CWB precisa separar, mas a localização exibida no Tiny SP é a do depósito de SP — **errada para quem está fisicamente no galpão CWB**.

Este módulo cria um **Agregador de Separação por Galpão** dentro do SISO: uma tela única onde o operador vê **todos os pedidos que precisam ser fisicamente separados no SEU galpão**, com a **localização correta do SEU depósito**, independente de qual conta Tiny originou a venda.

A tela replica o comportamento do Tiny (agrupamento por pedido, scan de itens por SKU/GTIN, etiqueta ao completar todos os itens) mas com localização correta e impressão na impressora física certa via PrintNode.

### Problema que resolve

- Localização errada na separação de transferências
- Operador precisa alternar entre contas Tiny
- Etiqueta sai na impressora errada (galpão errado)

---

## 2. Goals

- Operador de cada galpão vê 100% dos pedidos que precisam ser separados fisicamente naquele galpão, em uma tela única
- Localização exibida é sempre a do galpão LOCAL (correta)
- Scan de itens por SKU ou GTIN com leitor de código de barras
- Etiqueta de envio imprime automaticamente na impressora do galpão correto ao completar todos os itens do pedido
- Zero duplicação de trabalho — o módulo de separação do Tiny NÃO é usado; o SISO é o sistema de separação
- O worker existente (NF + estoque) continua funcionando como hoje, sem alteração

---

## 3. User Stories

### US-001: Tela de separação por galpão

**Description:** Como operador de galpão, quero ver todos os pedidos pendentes de separação no meu galpão, para separar fisicamente os itens sem trocar de conta Tiny.

**Acceptance Criteria:**
- [ ] Nova página `/separacao` acessível via nav
- [ ] Lista filtra automaticamente pelo galpão do operador logado (cargo `operador_cwb` → CWB, `operador_sp` → SP, `admin` → todos com seletor)
- [ ] Aba principal mostra pedidos com `status_separacao = 'pendente'` ou `'em_separacao'` (prontos para bip)
- [ ] Cada pedido exibe: número, cliente, ecommerce, forma de envio, decisão (própria/transferência), quantidade de itens
- [ ] Pedidos ordenados por data (mais antigo primeiro)
- [ ] Contagem de pedidos pendentes visível
- [ ] Query de separação inclui filtro `AND status != 'cancelado'` para excluir pedidos cancelados

---

### US-002: Localização correta por galpão

**Description:** Como operador, quero ver a localização do produto no MEU galpão (não a do galpão de origem da venda), para encontrar o item no depósito correto.

**Acceptance Criteria:**
- [ ] Para decisão `propria`: mostra localização do galpão de origem (que é o galpão do operador)
- [ ] Para decisão `transferencia`: mostra localização do galpão que tem estoque (que é o galpão do operador, o outro galpão)
- [ ] Localização vem de `siso_pedido_item_estoques.localizacao` filtrado pelas empresas do galpão do operador (fonte escalável, não hardcoded CWB/SP)
- [ ] Fallback: `siso_pedido_itens.localizacao_cwb` ou `localizacao_sp` conforme o galpão do operador (legacy, até migração completa)
- [ ] Quando localização é `null`, exibe "Sem localização" com destaque visual

---

### US-003: Scan de itens por SKU/GTIN

**Description:** Como operador, quero bipar o código de barras (GTIN) ou digitar o SKU de cada item para confirmar que separei o produto correto, replicando o comportamento do Tiny.

**Acceptance Criteria:**
- [ ] Campo de scan no topo da tela de separação (auto-focus)
- [ ] Aceita GTIN (EAN-13, leitura por scanner) ou SKU (digitação manual)
- [ ] Ao bipar/digitar, o sistema identifica o item em um pedido pendente de separação
- [ ] Prioridade de match: primeiro pedido mais antigo que contém o produto e ainda não foi bipado
- [ ] Item bipado recebe visual de "conferido" (check verde)
- [ ] Se o SKU/GTIN não corresponde a nenhum item pendente, exibe erro sonoro + mensagem
- [ ] Se o item já foi bipado (quantidade já completa), exibe aviso com status HTTP 409 e feedback sonoro distinto
- [ ] Para itens com quantidade > 1, cada bip incrementa a contagem bipada até atingir a quantidade pedida
- [ ] Campo de scan limpa automaticamente após processar (ready para próximo scan)
- [ ] Feedback sonoro: bip de sucesso (item encontrado), erro (não encontrado), completo (pedido finalizado) — usando Web Audio API com AudioContext inicializado no primeiro scan do operador
- [ ] Typecheck/lint passes

---

### US-004: Completude por pedido e impressão automática de etiqueta

**Description:** Como operador, quero que a etiqueta de envio imprima automaticamente quando todos os itens de um pedido forem bipados, para não precisar clicar em mais nada.

**Acceptance Criteria:**
- [ ] Quando todos os itens de um pedido atingem quantidade bipada = quantidade pedida, o pedido muda para `status_separacao = 'embalado'`
- [ ] Automaticamente ao embalar: SISO busca URL da etiqueta do Tiny (via expedição) e envia para PrintNode
- [ ] Etiqueta sai na impressora correta (mapeada por galpão/usuário)
- [ ] Pedido embalado sai da lista de pendentes e vai para aba "Embalados" com timestamp
- [ ] Toast de sucesso com número do pedido e status da etiqueta (`etiqueta_status`)
- [ ] Se a etiqueta falhar (Tiny não tem ainda, expedição não existe), `etiqueta_status = 'falhou'` — badge visual claro + botão de retry
- [ ] Botão de reimpressão disponível para pedidos já embalados

---

### US-005: Integração PrintNode — impressora por galpão/usuário

**Description:** Como admin, quero configurar qual impressora PrintNode é usada em cada galpão, com possibilidade de override por usuário, para que a etiqueta saia sempre na impressora física correta.

**Acceptance Criteria:**
- [ ] Tela de configurações (existente) ganha seção "Impressão (PrintNode)"
- [ ] Campo para API Key do PrintNode (uma por conta SISO, não por galpão)
- [ ] Botão "Testar Conexão" que chama `GET /whoami` do PrintNode e exibe status
- [ ] Após conectar, lista impressoras disponíveis (`GET /printers`) para seleção
- [ ] Cada galpão tem campo "Impressora padrão etiqueta" (dropdown das impressoras PrintNode)
- [ ] Cada usuário pode ter "Impressora override" (opcional, sobrescreve a do galpão)
- [ ] Resolução: `usuario.printnode_printer_id ?? galpao.printnode_printer_id`
- [ ] Se nenhuma impressora configurada, botão de imprimir desabilitado com tooltip explicativo

---

### US-006: Captura de GTIN no webhook processor

**Description:** Como sistema, preciso salvar o GTIN (código de barras EAN) de cada produto ao processar o webhook, para que o leitor de código de barras funcione na separação.

**Acceptance Criteria:**
- [ ] `webhook-processor.ts`: ao buscar detalhes do produto (`getProdutoDetalhe`), também captura o campo `gtin` — campo confirmado na spec Tiny v3 (`ObterProdutoModelResponse.gtin: string | null`)
- [ ] GTIN capturado na PRIMEIRA chamada de `getProdutoDetalhe` (que já ocorre para detectar kit), evitando chamada API adicional
- [ ] GTIN salvo em nova coluna `gtin` na tabela `siso_pedido_itens`
- [ ] `tiny-api.ts`: interface `TinyProdutoDetalhe` inclui `gtin: string | null`
- [ ] Para produtos de empresas suporte (busca por SKU), também captura GTIN
- [ ] Migration SQL adiciona coluna `gtin text` em `siso_pedido_itens`
- [ ] Pedidos já existentes (sem GTIN) continuam funcionando — scan por SKU como fallback

---

### US-007: Obter etiqueta de envio via Tiny Expedição

**Description:** Como sistema, preciso buscar a URL da etiqueta de envio do Tiny para enviar ao PrintNode.

**Acceptance Criteria:**
- [ ] `tiny-api.ts`: nova função `criarAgrupamento(token, idsPedidos)` → `POST /expedicao` com body `{ idsPedidos: number[] }` → retorna `{ id: number }` (o `idAgrupamento`)
- [ ] `tiny-api.ts`: nova função `obterEtiquetasAgrupamento(token, idAgrupamento)` → `GET /expedicao/{idAgrupamento}/etiquetas` → retorna `{ urls: string[] }`
- [ ] Primeira URL do array é cacheada em `siso_pedidos.etiqueta_url` para reimpressão rápida
- [ ] Se expedição ainda não existe, cria automaticamente com `idsPedidos` contendo o ID numérico (`integer`) do pedido Tiny
- [ ] Se Tiny retorna 404/400 (etiqueta não disponível), `etiqueta_status = 'falhou'` e erro tratado graciosamente
- [ ] Expedição criada usando o token da **empresa de origem** do pedido (onde a NF está)

**Nota terminológica:** O Tiny usa "agrupamento" (que pode conter múltiplas "expedições"). `POST /expedicao` cria um **agrupamento**. `GET /expedicao/{id}/etiquetas` busca etiquetas do **agrupamento**. No código do SISO usamos `agrupamento_tiny_id` (não `expedicao_tiny_id`) para refletir o modelo real.

---

### US-008: Enviar job de impressão ao PrintNode

**Description:** Como sistema, preciso enviar o PDF da etiqueta para o PrintNode na impressora correta.

**Acceptance Criteria:**
- [ ] Nova lib `src/lib/printnode.ts` com função `enviarImpressao({ apiKey, printerId, pdfUrl, titulo })`
- [ ] Usa `POST /printjobs` do PrintNode com `contentType: "pdf_uri"` e `content: URL`
- [ ] Auth via HTTP Basic (API key como username, password vazio)
- [ ] Retorna job ID do PrintNode para rastreabilidade
- [ ] Idempotência controlada pelo SISO: antes de enviar, verifica se `etiqueta_status = 'impresso'` no banco. PrintNode **não** suporta `X-Idempotency-Key`
- [ ] Timeout de 10s, retry 1x em caso de erro de rede
- [ ] Log da impressão em `siso_logs` com pedido_id, printer_id, job_id (sem logar URLs de etiqueta — contêm dados pessoais LGPD)

---

### US-009: Determinação do galpão de separação

**Description:** Como sistema, preciso determinar em qual galpão cada pedido será fisicamente separado, para mostrá-lo na tela correta.

**Acceptance Criteria:**
- [ ] Campo `separacao_galpao_id` em `siso_pedidos` (FK → siso_galpoes)
- [ ] Preenchido automaticamente no webhook-processor com base na **sugestão**:
  - `propria` → galpão da empresa de origem
  - `transferencia` → galpão da empresa suporte (onde o estoque está)
  - `oc` → galpão da empresa de origem (mesmo sem estoque, o pedido será despachado de lá)
- [ ] **CRÍTICO:** Ao aprovar pedido (`POST /api/pedidos/aprovar`), se a `decisao_final` diferir da `sugestao`, RECALCULAR e atualizar `separacao_galpao_id` de acordo. Exemplo: sugestão era `transferencia` (galpão CWB), operador aprova como `propria` → atualizar para galpão SP
- [ ] A tela de separação filtra por `separacao_galpao_id = galpão do operador`
- [ ] Pedidos OC aparecem na separação mas com badge visual "Aguardando Estoque" (não podem ser bipados até estoque chegar)

---

### US-010: Status de separação independente

**Description:** Como sistema, preciso rastrear o progresso da separação física independente do status de processamento (NF/estoque).

**Acceptance Criteria:**
- [ ] Nova coluna `status_separacao` em `siso_pedidos` com valores: `'aguardando_nf'`, `'pendente'`, `'em_separacao'`, `'embalado'`, `'expedido'`, `'cancelado'`
- [ ] Default: `'aguardando_nf'` (preenchido no webhook-processor para pedidos aprovados/auto-aprovados)
- [ ] Pedidos existentes (anteriores ao módulo) ficam com `status_separacao = NULL` — filtrados com `WHERE status_separacao IS NOT NULL` nas queries de separação
- [ ] Transições:
  - `aguardando_nf → pendente` (NF autorizada via webhook)
  - `pendente → em_separacao` (primeiro item bipado — feito atomicamente no mesmo UPDATE do bip)
  - `em_separacao → embalado` (todos itens bipados)
  - `embalado → expedido` (marcação manual ou automática)
  - `* → cancelado` (webhook de cancelamento — em qualquer estado anterior)
- [ ] `status_separacao` é independente de `status` (NF/estoque) — podem progredir em paralelo
- [ ] Colunas auxiliares: `separado_por` (UUID), `separado_em` (timestamp), `embalado_em` (timestamp)
- [ ] Colunas de NF: `url_danfe` (text), `chave_acesso_nf` (text) — preenchidos pelo webhook de NF
- [ ] Coluna `etiqueta_status` (text): `'pendente'`, `'imprimindo'`, `'impresso'`, `'falhou'` — rastreia status da impressão independente do status de separação

---

### US-011: Rastreio de bips por item

**Description:** Como sistema, preciso rastrear quais itens foram bipados em cada pedido.

**Acceptance Criteria:**
- [ ] Novas colunas em `siso_pedido_itens`:
  - `quantidade_bipada` (integer, default 0) — incrementa a cada scan
  - `bipado_completo` (boolean, default false) — true quando `quantidade_bipada >= quantidade_pedida`
  - `bipado_em` (timestamp) — quando completou
  - `bipado_por` (UUID FK → siso_usuarios) — quem bipou
- [ ] API `POST /api/separacao/bipar` recebe `{ codigo }` (usuario_id e galpao_id derivados da sessão server-side — ver US-016) e:
  1. Encontra o item pendente mais antigo que corresponde (via função PostgreSQL atômica com `FOR UPDATE SKIP LOCKED`)
  2. Incrementa `quantidade_bipada`
  3. Se pedido estava `pendente`, transiciona atomicamente para `em_separacao` e seta `separado_por` + `separado_em`
  4. Se atingiu quantidade, marca `bipado_completo = true`
  5. Se todos itens do pedido estão completos, marca `status_separacao = 'embalado'` e dispara impressão
  6. Retorna: pedido_id, item_id, status atualizado, se pedido completou
- [ ] API idempotente para bips exatos (não permite bipar mais que a quantidade pedida)

---

### US-012: Aba "Embalados" na tela de separação

**Description:** Como operador, quero ver os pedidos já embalados (que já saíram da fila de bip) com opção de reimprimir etiqueta.

**Acceptance Criteria:**
- [ ] Tabs na tela de separação: "Aguardando NF" | "Pendentes" (pendente + em_separacao) | "Embalados" | "Expedidos"
- [ ] Aba "Embalados" lista pedidos com `status_separacao = 'embalado'`
- [ ] Cada pedido embalado mostra: número, hora que embalou, quem embalou, `etiqueta_status`, botão "Reimprimir Etiqueta"
- [ ] Pedidos com `etiqueta_status = 'falhou'` exibem badge visual e botão "Tentar Novamente"
- [ ] Botão "Marcar como Expedido" (individual ou em lote) move para status `expedido`

---

### US-013: Webhook de NF autorizada como gatilho de separação

**Description:** Como sistema, preciso receber o webhook `tipo: "nota_fiscal"` do Tiny e usar a autorização da NF como gatilho para mover o pedido de "Aguardando NF" para "Pendente" na separação.

**Acceptance Criteria:**
- [ ] `route.ts` do webhook estendido para aceitar `tipo: "nota_fiscal"` além dos tipos existentes. O discriminador por `tipo` deve ocorrer ANTES da validação de `codigoSituacao` (que não existe em webhooks de NF)
- [ ] **PRÉ-REQUISITO:** Antes de implementar, capturar um payload REAL do webhook de NF do Tiny e validar os nomes dos campos. O formato abaixo é **assumido** e deve ser confirmado:
  - Payload assumido: `{ cnpj, tipo: "nota_fiscal", dados: { idNotaFiscalTiny, numero, serie, urlDanfe, chaveAcesso, dataEmissao, valorNota } }`
- [ ] Match NF → Pedido: fast-path via `siso_pedidos.nota_fiscal_id = dados.idNotaFiscalTiny` (atenção ao cast: `nota_fiscal_id` é `bigint` no banco, garantir comparação numérica)
- [ ] Fallback match: `GET /notas/{idNotaFiscalTiny}` → retorna `origem: { id, tipo }` (confirmado no modelo `ObterNotaFiscalModelResponse` do Tiny v3) — se `tipo = "venda"`, usa `origem.id` como pedido_id Tiny
- [ ] Fallback se NF webhook chega ANTES do pedido ser salvo pelo `processWebhook` (race condition de timing): salvar evento em `siso_webhook_logs` com `status = 'aguardando_pedido'` e reprocessar em 30 segundos via retry
- [ ] Se pedido encontrado e `status_separacao = 'aguardando_nf'`: transiciona para `'pendente'`
- [ ] Salva `url_danfe` e `chave_acesso_nf` no pedido
- [ ] Se pedido NÃO encontrado (NF de outro tipo, devolução, etc): log info e ignora silenciosamente (200 OK). Verificar `origem.tipo` — só processar se `tipo = "venda"`
- [ ] Se pedido já está além de `aguardando_nf` (ex: já `pendente` por reprocessamento): ignora (idempotente)
- [ ] Dedup por `idNotaFiscalTiny` no `siso_webhook_logs` (usa `dedup_key = "nf_{idNotaFiscalTiny}"`)
- [ ] Typecheck/lint passes

---

### US-014: Aba "Aguardando NF" na tela de separação

**Description:** Como operador, quero ver os pedidos que já foram aprovados mas ainda aguardam NF autorizada, para ter visibilidade do pipeline completo.

**Acceptance Criteria:**
- [ ] Nova aba "Aguardando NF" na tela de separação (antes de "Pendentes")
- [ ] Lista pedidos com `status_separacao = 'aguardando_nf'` do galpão do operador
- [ ] Cada pedido mostra: número, cliente, ecommerce, decisão, quantidade de itens
- [ ] Pedidos com mais de 2h em `aguardando_nf` exibem badge "Atenção" para admin investigar
- [ ] Pedidos são somente-leitura (sem ação de bip ou impressão)
- [ ] Admin pode usar botão "Forçar Pendente" para mover manualmente de `aguardando_nf` para `pendente` (fallback se webhook falhar)
- [ ] Contagem visível na aba
- [ ] Pedido transiciona automaticamente para "Pendentes" quando NF webhook chega (polling com TanStack Query `refetchInterval: 10000`)

---

### US-015: Desfazer bip (undo)

**Description:** Como operador, quero desfazer um bip errado (item separado incorretamente), para corrigir sem precisar chamar admin.

**Acceptance Criteria:**
- [ ] Após cada bip bem-sucedido, toast exibe "Bip registrado" com botão "Desfazer" ativo por 10 segundos
- [ ] Clicando "Desfazer": chama `POST /api/separacao/desfazer-bip { pedido_id, produto_id }`
- [ ] API decrementa `quantidade_bipada` (mínimo 0), reverte `bipado_completo` se necessário
- [ ] Se pedido estava `em_separacao` e todos bips foram desfeitos, reverte para `pendente`
- [ ] Se pedido estava `embalado` e bip é desfeito, reverte para `em_separacao` e cancela impressão pendente
- [ ] Após 10 segundos, botão "Desfazer" desaparece — correção posterior requer selecionar o pedido e usar botão dedicado

---

### US-016: Sessão server-side para separação

**Description:** Como sistema, preciso validar a identidade do operador no servidor para garantir integridade da trilha de auditoria e isolamento por galpão.

**Acceptance Criteria:**
- [ ] Nova tabela `siso_sessoes` com `id (UUID)`, `usuario_id (FK)`, `criado_em`, `expira_em` (12h)
- [ ] Login (`POST /api/auth/login`) gera `sessionId` e salva na tabela. Retorna `sessionId` ao client
- [ ] Client envia `sessionId` como header `X-Session-Id` em toda requisição
- [ ] Helper `getSessionUser(request)` valida sessão e retorna `{ id, nome, cargo, galpaoId }`
- [ ] `POST /api/separacao/bipar` recebe apenas `{ codigo }` — `usuario_id` e `galpao_id` derivados da sessão validada
- [ ] Operador `operador_cwb` só pode bipar pedidos com `separacao_galpao_id` do galpão CWB (e vice-versa para SP)
- [ ] Rate limiting no endpoint de bip: máximo 2 bips/segundo por sessão (scanner físico não bipa mais rápido)

---

## 4. Functional Requirements

**Separação**
- FR-1: O sistema deve exibir na tela de separação SOMENTE pedidos cujo `separacao_galpao_id` corresponde ao galpão do operador logado E `status != 'cancelado'`
- FR-2: O sistema deve mostrar a localização do item no galpão do operador, buscando de `siso_pedido_item_estoques.localizacao` (por empresa do galpão do operador)
- FR-3: O sistema deve aceitar input de SKU (texto) ou GTIN (EAN-13 via leitor) no campo de scan
- FR-4: O sistema deve fazer match do scan com o pedido pendente mais antigo que contém o produto, usando query atômica com `FOR UPDATE SKIP LOCKED` para evitar race conditions entre operadores simultâneos
- FR-5: O sistema deve tratar itens com quantidade > 1, incrementando bip a cada scan até atingir a quantidade
- FR-6: O sistema deve emitir feedback sonoro: bip de sucesso (item encontrado), erro (não encontrado), completo (pedido finalizado), já bipado (aviso)
- FR-7: O sistema deve transicionar automaticamente o `status_separacao` conforme itens são bipados, incluindo `pendente → em_separacao` no primeiro bip
- FR-8: Pedidos com decisão `oc` aparecem na separação mas com estado "Aguardando Estoque" — bip desabilitado

**Etiquetas**
- FR-9: Ao completar todos os itens de um pedido, o sistema deve automaticamente buscar a etiqueta do Tiny e enviar para impressão, atualizando `etiqueta_status` em cada etapa
- FR-10: A etiqueta é obtida criando um agrupamento no Tiny (`POST /expedicao` com `{ idsPedidos: [int] }`) e depois buscando as URLs (`GET /expedicao/{idAgrupamento}/etiquetas`)
- FR-11: O agrupamento é criado na conta Tiny da **empresa de origem** do pedido (onde a NF está)
- FR-12: Primeira URL do array é cacheada em `siso_pedidos.etiqueta_url` para reimpressões. URLs de etiqueta nunca são expostas ao frontend — reimpressão sempre via server

**PrintNode**
- FR-13: A impressão usa PrintNode API: `POST /printjobs` com `contentType: pdf_uri`
- FR-14: A impressora é resolvida por: `usuario.printnode_printer_id ?? galpao.printnode_printer_id`
- FR-15: API Key do PrintNode armazenada em variável de ambiente `PRINTNODE_API_KEY` (não no banco — decisão consciente de simplicidade para app interno)
- FR-16: Lista de impressoras é obtida via `GET /printers` do PrintNode usando a API Key configurada

**Dados**
- FR-17: GTIN de cada produto deve ser capturado no webhook-processor e salvo em `siso_pedido_itens.gtin`
- FR-18: Campo `separacao_galpao_id` deve ser preenchido no webhook-processor (baseado na sugestão) E ATUALIZADO no endpoint de aprovação (se decisão final diferir da sugestão)
- FR-19: Bips são persistidos imediatamente no banco via função PostgreSQL atômica (`supabase.rpc`) — não apenas em memória do client
- FR-20: Localização por empresa deve ser salva em `siso_pedido_item_estoques.localizacao` para suportar N galpões sem hardcode

**Nota Fiscal → Separação**
- FR-21: Pedidos recém-aprovados entram com `status_separacao = 'aguardando_nf'` (NÃO `'pendente'`)
- FR-22: Webhook `tipo: "nota_fiscal"` do Tiny dispara transição `aguardando_nf → pendente` — só então o pedido aparece na tela de separação
- FR-23: O handler de NF webhook faz match via `siso_pedidos.nota_fiscal_id` (fast-path) ou `GET /notas/{id}` → `origem.id` (fallback confirmado na spec Tiny v3: `ObterNotaFiscalModelResponse.origem: { id: string, tipo: enum }`)
- FR-24: `url_danfe` e `chave_acesso_nf` são salvos no pedido ao receber o webhook de NF
- FR-25: Aba "Aguardando NF" na tela de separação mostra pedidos com `status_separacao = 'aguardando_nf'` (visibilidade, sem ação)

**Autenticação**
- FR-26: Endpoints de separação (`/api/separacao/*`) exigem sessão server-side válida via header `X-Session-Id`
- FR-27: `usuario_id` e `galpao_id` são derivados da sessão — nunca enviados pelo client no body
- FR-28: Cancelamento de pedido (webhook) atualiza `status_separacao = 'cancelado'` além de `status = 'cancelado'`

---

## 5. Non-Goals (Out of Scope)

- **Não** substituir o fluxo de NF/estoque do worker — continua como está
- **Não** integrar diretamente com Mercado Livre API — etiquetas vêm do Tiny
- **Não** gerenciar a separação no Tiny — o módulo de separação do Tiny não é usado/atualizado
- **Não** implementar lista de picking impressa (agrupada por produto para coleta física) — pode ser fase 2
- **Não** implementar contagem de volumes ou peso na embalagem
- **Não** implementar expedição completa (PLP, coleta, rastreio) — só impressão de etiqueta
- **Não** implementar impressão de DANFE (pode ser adicionada depois com mesmo mecanismo PrintNode)
- **Não** implementar scan por número de série

---

## 6. Technical Considerations

### 6.1 Database Schema Changes

```sql
-- Migration: add separation tracking to siso_pedidos
ALTER TABLE siso_pedidos
  ADD COLUMN status_separacao text DEFAULT NULL
    CHECK (status_separacao IS NULL OR status_separacao IN ('aguardando_nf', 'pendente', 'em_separacao', 'embalado', 'expedido', 'cancelado')),
  ADD COLUMN separacao_galpao_id uuid REFERENCES siso_galpoes(id),
  ADD COLUMN separado_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN separado_em timestamptz,
  ADD COLUMN embalado_em timestamptz,
  ADD COLUMN agrupamento_tiny_id bigint,
  ADD COLUMN etiqueta_url text,
  ADD COLUMN etiqueta_status text DEFAULT NULL
    CHECK (etiqueta_status IS NULL OR etiqueta_status IN ('pendente', 'imprimindo', 'impresso', 'falhou')),
  ADD COLUMN url_danfe text,
  ADD COLUMN chave_acesso_nf text;

-- Migration: add scan tracking to siso_pedido_itens
ALTER TABLE siso_pedido_itens
  ADD COLUMN gtin text,
  ADD COLUMN quantidade_bipada integer DEFAULT 0,
  ADD COLUMN bipado_completo boolean DEFAULT false,
  ADD COLUMN bipado_em timestamptz,
  ADD COLUMN bipado_por uuid REFERENCES siso_usuarios(id);

-- Migration: add localizacao to normalized stock table (escalável, não hardcoded CWB/SP)
ALTER TABLE siso_pedido_item_estoques
  ADD COLUMN localizacao text;

-- Migration: add PrintNode config to galpoes and usuarios
ALTER TABLE siso_galpoes
  ADD COLUMN printnode_printer_id bigint,
  ADD COLUMN printnode_printer_nome text;

ALTER TABLE siso_usuarios
  ADD COLUMN printnode_printer_id bigint,
  ADD COLUMN printnode_printer_nome text;

-- Migration: server-side sessions
CREATE TABLE siso_sessoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES siso_usuarios(id),
  criado_em timestamptz DEFAULT now(),
  expira_em timestamptz DEFAULT now() + interval '12 hours'
);

CREATE INDEX idx_sessoes_expira ON siso_sessoes (expira_em) WHERE expira_em > now();

-- Indexes for separation queries
CREATE INDEX idx_pedidos_separacao_galpao
  ON siso_pedidos (separacao_galpao_id, status_separacao)
  WHERE status_separacao IN ('pendente', 'em_separacao');

CREATE INDEX idx_pedidos_separacao_aguardando
  ON siso_pedidos (separacao_galpao_id)
  WHERE status_separacao = 'aguardando_nf';

CREATE INDEX idx_pedidos_separacao_embalado
  ON siso_pedidos (separacao_galpao_id)
  WHERE status_separacao = 'embalado';

-- Indexes for bip query (GTIN and SKU lookup)
CREATE INDEX idx_pedido_itens_gtin ON siso_pedido_itens (gtin)
  WHERE gtin IS NOT NULL AND bipado_completo = false;

CREATE INDEX idx_pedido_itens_sku ON siso_pedido_itens (sku)
  WHERE bipado_completo = false;

-- Index for ordering by date in bip query
CREATE INDEX idx_pedidos_separacao_data
  ON siso_pedidos (separacao_galpao_id, data ASC)
  WHERE status_separacao IN ('pendente', 'em_separacao');

-- PostgreSQL function for atomic bip processing (avoids race conditions)
CREATE OR REPLACE FUNCTION siso_processar_bip(
  p_codigo text,
  p_usuario_id uuid,
  p_galpao_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_item RECORD;
  v_pedido RECORD;
  v_itens_faltam integer;
BEGIN
  -- 1. Find and lock the oldest pending item atomically
  SELECT pi.pedido_id, pi.produto_id, pi.quantidade_bipada, pi.quantidade_pedida,
         pi.sku, p.numero AS pedido_numero, p.status_separacao
  INTO v_item
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  WHERE (pi.gtin = p_codigo OR pi.sku = p_codigo)
    AND pi.bipado_completo = false
    AND p.separacao_galpao_id = p_galpao_id
    AND p.status_separacao IN ('pendente', 'em_separacao')
    AND p.status != 'cancelado'
  ORDER BY p.data ASC
  LIMIT 1
  FOR UPDATE OF pi SKIP LOCKED;

  IF v_item IS NULL THEN
    RETURN jsonb_build_object('status', 'nao_encontrado', 'codigo', p_codigo);
  END IF;

  -- 2. Safety check
  IF v_item.quantidade_bipada >= v_item.quantidade_pedida THEN
    RETURN jsonb_build_object('status', 'ja_completo', 'pedido_id', v_item.pedido_id, 'sku', v_item.sku);
  END IF;

  -- 3. Increment bip
  UPDATE siso_pedido_itens SET
    quantidade_bipada = quantidade_bipada + 1,
    bipado_por = p_usuario_id,
    bipado_completo = (quantidade_bipada + 1 >= quantidade_pedida),
    bipado_em = CASE WHEN (quantidade_bipada + 1 >= quantidade_pedida) THEN now() ELSE bipado_em END
  WHERE pedido_id = v_item.pedido_id AND produto_id = v_item.produto_id;

  -- 4. Transition pendente → em_separacao on first bip
  IF v_item.status_separacao = 'pendente' THEN
    UPDATE siso_pedidos SET
      status_separacao = 'em_separacao',
      separado_por = p_usuario_id,
      separado_em = now()
    WHERE id = v_item.pedido_id AND status_separacao = 'pendente';
  END IF;

  -- 5. Check if all items are complete
  SELECT COUNT(*) FILTER (WHERE bipado_completo = false) INTO v_itens_faltam
  FROM siso_pedido_itens WHERE pedido_id = v_item.pedido_id;

  IF v_itens_faltam = 0 THEN
    UPDATE siso_pedidos SET
      status_separacao = 'embalado',
      embalado_em = now(),
      etiqueta_status = 'pendente'
    WHERE id = v_item.pedido_id;

    RETURN jsonb_build_object(
      'status', 'pedido_completo',
      'pedido_id', v_item.pedido_id,
      'pedido_numero', v_item.pedido_numero,
      'sku', v_item.sku,
      'bipados', v_item.quantidade_bipada + 1,
      'total', v_item.quantidade_pedida
    );
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN (v_item.quantidade_bipada + 1 >= v_item.quantidade_pedida) THEN 'item_completo' ELSE 'parcial' END,
    'pedido_id', v_item.pedido_id,
    'pedido_numero', v_item.pedido_numero,
    'sku', v_item.sku,
    'bipados', v_item.quantidade_bipada + 1,
    'total', v_item.quantidade_pedida,
    'itens_faltam', v_itens_faltam
  );
END;
$$ LANGUAGE plpgsql;
```

### 6.2 API Routes (novas)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/separacao` | Lista pedidos para separação do galpão do operador (derivado da sessão) |
| `POST` | `/api/separacao/bipar` | Processa scan de item (SKU ou GTIN) — via `supabase.rpc('siso_processar_bip')` |
| `POST` | `/api/separacao/desfazer-bip` | Desfaz último bip de um item `{ pedido_id, produto_id }` |
| `POST` | `/api/separacao/reimprimir` | Reimprime etiqueta de pedido já embalado `{ pedido_id }` |
| `POST` | `/api/separacao/expedir` | Marca pedidos como expedidos `{ pedido_ids: string[] }` |
| `GET` | `/api/separacao/{pedidoId}` | Detalhe de um pedido na separação |
| `PATCH` | `/api/separacao/{pedidoId}/forcar-pendente` | Admin: força transição `aguardando_nf → pendente` |
| `GET` | `/api/admin/printnode/printers` | Lista impressoras do PrintNode |
| `POST` | `/api/admin/printnode/test` | Testa conexão PrintNode |
| `POST` | `/api/webhook/tiny` | **(existente, estendido)** — aceita `tipo: "nota_fiscal"` para gatilho de separação |

### 6.3 Libs (novos)

| File | Purpose |
|---|---|
| `src/lib/printnode.ts` | Client PrintNode API (enviarImpressao, listarImpressoras, testarConexao) |
| `src/lib/separacao.ts` | Lógica de domínio (resolverGalpaoSeparacao, calcularStatusSeparacao) |
| `src/lib/etiqueta-service.ts` | Busca de etiqueta (ensureAgrupamento, buscarEtiqueta, cachearUrl) |
| `src/lib/nf-webhook-handler.ts` | Handler do webhook de NF (match NF→pedido, transição aguardando_nf→pendente) |
| `src/lib/session.ts` | Validação de sessão server-side (getSessionUser) |

**Funções novas em `tiny-api.ts`:**
| Função | Endpoint | Modelo Tiny v3 |
|---|---|---|
| `obterNotaFiscal(token, notaId)` | `GET /notas/{id}` | `ObterNotaFiscalModelResponse` — retorna `origem: { id: string, tipo: "pedido_compra" \| "venda" \| "notafiscal" \| ... }` |
| `criarAgrupamento(token, idsPedidos)` | `POST /expedicao` | Request: `CriarAgrupamentoRequestModel { idsPedidos: number[] }` → Response: `CriarAgrupamentoResponseModel { id: number }` |
| `obterEtiquetasAgrupamento(token, idAgrupamento)` | `GET /expedicao/{idAgrupamento}/etiquetas` | `ObterEtiquetasResponseModel { urls: string[] }` |

### 6.4 Fluxo Detalhado do Bip

```
Operador bipa "7891234567890" (GTIN)
     │
     ▼
POST /api/separacao/bipar { codigo: "7891234567890" }
Headers: X-Session-Id: <sessionId>
     │
     ▼
0. Valida sessão → obtém usuario_id, galpao_id do servidor
     │
     ▼
1. Chama supabase.rpc('siso_processar_bip', { p_codigo, p_usuario_id, p_galpao_id })
   (busca + lock + increment + transição — tudo atômico, sem race condition)
     │
     ├── { status: "nao_encontrado" } → 404 { error: "Item não encontrado", codigo }
     │                                   → feedback sonoro de ERRO no frontend
     │
     ├── { status: "ja_completo" } → 409 { error: "Item já completado", pedido_id, sku }
     │                               → feedback sonoro de AVISO
     │
     ├── { status: "parcial" } → 200 { status: "parcial", pedido_numero, sku, bipados, total, itens_faltam }
     │                           → feedback sonoro de SUCESSO
     │
     ├── { status: "item_completo" } → 200 { status: "item_completo", pedido_numero, sku, itens_faltam }
     │                                 → feedback sonoro de SUCESSO
     │
     └── { status: "pedido_completo" } → 200 { status: "pedido_completo", pedido_numero, etiqueta_status: "pendente" }
                                         → feedback sonoro de COMPLETO (diferente do bip normal)
                                         → toast: "Pedido #8832 embalado! Etiqueta sendo processada."
                                         → dispara busca de etiqueta async (não bloqueia resposta)
```

### 6.5 Fluxo da Etiqueta (detalhe)

```
buscarEtiqueta(pedido)
     │
     ▼
1. Já tem etiqueta_url cacheada?
   ├── SIM → retorna URL, etiqueta_status = 'imprimindo'
   │
   ▼
2. Já tem agrupamento_tiny_id?
   ├── SIM → GET /expedicao/{idAgrupamento}/etiquetas
   │         ├── retorna { urls: [...] } → salva urls[0], retorna
   │         └── 404 → etiqueta não disponível ainda (raro)
   │
   ▼
3. Criar agrupamento:
   a. Pega token da empresa ORIGEM do pedido
   b. POST /expedicao { idsPedidos: [pedido.id_numerico] }
      ├── 200 → salva agrupamento_tiny_id no DB
      └── 400 → etiqueta_status = 'falhou', log erro
   c. GET /expedicao/{idAgrupamento}/etiquetas
      ├── retorna { urls: [...] } → salva etiqueta_url (urls[0]), retorna
      └── vazio/404 → etiqueta_status = 'falhou' (marketplace pode não ter gerado ainda)

4. Atualiza etiqueta_status:
   ├── sucesso → 'imprimindo' → envia PrintNode → 'impresso'
   └── falha   → 'falhou' (visível no frontend, botão retry disponível)

NOTA: A NF já está autorizada quando o pedido chega à separação (garantido
pelo webhook tipo=nota_fiscal). Isso elimina o risco de etiqueta indisponível
por NF pendente. O único caso de falha é o marketplace não ter gerado a
etiqueta ainda — tratado pelo retry e botão de reimprimir.
```

### 6.6 Fluxo PrintNode (detalhe)

```
enviarImpressao({ printerId, pdfUrl, titulo, pedidoId })
     │
     ▼
0. Verifica etiqueta_status do pedido no banco
   ├── 'impresso' → skip (idempotência controlada pelo SISO)
   │
   ▼
1. Atualiza etiqueta_status = 'imprimindo'
     │
     ▼
2. POST https://api.printnode.com/printjobs
   Headers:
     Authorization: Basic base64(PRINTNODE_API_KEY + ":")
   Body: {
     printerId: 48291,
     contentType: "pdf_uri",
     content: "https://tiny.../etiqueta.pdf",
     title: "SISO Etiqueta #8832",
     source: "SISO Separacao"
   }
     │
     ├── 201 → { id: jobId } → etiqueta_status = 'impresso', log sucesso
     ├── 401 → API key inválida → etiqueta_status = 'falhou', erro para admin
     └── 400/5xx → retry 1x → se falhar, etiqueta_status = 'falhou', log erro + toast para operador
```

### 6.7 Resolução de Impressora

```typescript
async function resolverImpressora(
  usuarioId: string,
  galpaoId: string
): Promise<{ printerId: number; printerNome: string } | null> {
  const supabase = createServiceClient();

  // 1. Override por usuário?
  const { data: user } = await supabase
    .from("siso_usuarios")
    .select("printnode_printer_id, printnode_printer_nome")
    .eq("id", usuarioId)
    .single();

  if (user?.printnode_printer_id) {
    return {
      printerId: user.printnode_printer_id,
      printerNome: user.printnode_printer_nome ?? "Impressora do usuário",
    };
  }

  // 2. Padrão do galpão
  const { data: galpao } = await supabase
    .from("siso_galpoes")
    .select("printnode_printer_id, printnode_printer_nome")
    .eq("id", galpaoId)
    .single();

  if (galpao?.printnode_printer_id) {
    return {
      printerId: galpao.printnode_printer_id,
      printerNome: galpao.printnode_printer_nome ?? "Impressora do galpão",
    };
  }

  return null; // Nenhuma impressora configurada
}
```

### 6.8 Timing / Dependências entre Fluxos

```
                              TEMPO →

Pedido aprovado ──┬── Worker: marcadores → gera NF → lança estoque (EXISTENTE, sem alteração)
(webhook)         │                            │
                  │                            └── salva nota_fiscal_id no siso_pedidos
                  │
                  └── SISO: status_separacao = 'aguardando_nf'  (NOVO)
                                    │
                                    │  (espera webhook do Tiny)
                                    │
NF autorizada ────────────────────► │  webhook tipo="nota_fiscal" chega
(webhook Tiny)                      │  match: idNotaFiscalTiny → pedido
                                    │  salva url_danfe, chave_acesso_nf
                                    ▼
                         status_separacao = 'pendente'
                                    │
                                    ▼  (operador começa a separar)
                         pendente → em_separacao → embalado → etiqueta → expedido
```

**Risco de timing — NF webhook antes do pedido ser salvo:**

O `processWebhook` é async e pode levar vários segundos (múltiplas chamadas Tiny API + sleeps de 500ms). Se o Tiny enviar o webhook de NF antes do `processWebhook` terminar de salvar o pedido em `siso_pedidos`, o handler de NF não encontra o pedido.

**Mitigação:** Se o match NF→pedido falhar (fast-path e fallback), salvar o evento em `siso_webhook_logs` com `status = 'aguardando_pedido'`. Um job de reconciliação (ou o próprio `processWebhook` ao salvar o pedido) verifica se já existe um webhook de NF pendente e faz a transição imediatamente.

**Risco de timing ELIMINADO para fluxo normal:** Na maioria dos casos, o worker gera a NF e salva `nota_fiscal_id` antes do Tiny autorizar e enviar o webhook de NF. O cenário de NF antes do pedido é raro mas tratado pelo retry.

### 6.9 Segurança

**PrintNode:**
- API Key armazenada em variável de ambiente `PRINTNODE_API_KEY` (não no banco)
- Nunca exposta ao frontend
- Todas as chamadas PrintNode são feitas server-side nas API routes
- PrintNode rate limit: 10 req/s (irrelevante para nosso volume)

**Sessões:**
- Sessão server-side obrigatória para `/api/separacao/*`
- `usuario_id` e `galpao_id` derivados da sessão, nunca do body
- Rate limiting: 2 bips/segundo por sessão

**URLs de etiqueta:**
- Contêm dados pessoais (nome, endereço do cliente) — protegidas pela LGPD
- Nunca expostas ao frontend — reimpressão sempre via `POST /api/separacao/reimprimir`
- Não logadas em `siso_logs`
- URLs do marketplace podem expirar — se `etiqueta_url` expirou, refazer `GET /expedicao/{id}/etiquetas`

**Webhook:**
- Webhook de NF: validar `origem.tipo = "venda"` via `GET /notas/{id}` para confirmar que é NF de venda (não devolução/serviço)

### 6.10 Alterações no webhook-processor.ts

Mínimas:
1. Capturar GTIN do produto na PRIMEIRA chamada de `getProdutoDetalhe` (já faz para detectar kit, adicionar campo `gtin`)
2. Salvar `localizacao` em `siso_pedido_item_estoques` (já disponível na variável `estoquesPorEmpresa`)
3. Calcular `separacao_galpao_id` ao salvar o pedido (baseado na sugestão: propria → origem, transferencia → suporte)
4. Definir `status_separacao = 'aguardando_nf'` para pedidos aprovados/auto-aprovados
5. Ao salvar pedido, verificar se já existe webhook de NF pendente (`siso_webhook_logs` com `status = 'aguardando_pedido'`) e fazer transição imediatamente

### 6.11 Alterações no POST /api/pedidos/aprovar

Adicionar ao update do pedido:
1. Se `decisao_final != sugestao`, recalcular `separacao_galpao_id`:
   - `propria` ou `oc` → `empresaOrigem.galpaoId`
   - `transferencia` → `empresaSuporte.galpaoId` (já resolvido no endpoint como `empresaExecucaoId`)
2. O endpoint já resolve `empresaExecucaoId` e seu galpão — basta derivar `separacao_galpao_id` da mesma lógica

### 6.12 Novo handler de NF webhook (route.ts)

```
POST /api/webhook/tiny  (tipo: "nota_fiscal")
     │
     ▼
0. Discriminar por tipo ANTES de validar codigoSituacao:
   if (tipo === "nota_fiscal") → nfWebhookHandler(...)
   else → validar codigoSituacao e processar como antes
     │
     ▼
1. Valida payload: cnpj, tipo = "nota_fiscal", dados.idNotaFiscalTiny
     │
     ▼
2. Dedup: siso_webhook_logs com dedup_key = "nf_{idNotaFiscalTiny}"
     │
     ├── Já processado → 200 OK (idempotente)
     │
     ▼
3. Identifica empresa pelo CNPJ (empresa-lookup existente)
     │
     ▼
4. Match NF → Pedido:
   a. Fast-path: SELECT FROM siso_pedidos WHERE nota_fiscal_id = CAST(idNotaFiscalTiny AS bigint)
   b. Fallback: GET /notas/{idNotaFiscalTiny} → se origem.tipo = "venda", buscar pedido por origem.id
   c. Não encontrou e pedido pode ainda não existir → salvar com status = 'aguardando_pedido', retry em 30s
   d. Não encontrou após retry → log info, 200 OK (NF de devolução, serviço, etc)
     │
     ▼
5. Pedido encontrado:
   UPDATE siso_pedidos SET
     status_separacao = 'pendente',
     url_danfe = dados.urlDanfe,
     chave_acesso_nf = dados.chaveAcesso
   WHERE id = pedido_id AND status_separacao = 'aguardando_nf'
     │
     ▼
6. Log + 200 OK
```

### 6.13 Contrato de Resposta do Bip

```typescript
// Sucesso parcial (item bipado mas pedido incompleto)
200 { status: "parcial", pedido_id, pedido_numero, sku, bipados: N, total: M, itens_faltam: K }

// Item completo, pedido ainda incompleto
200 { status: "item_completo", pedido_id, pedido_numero, sku, itens_faltam: K }

// Pedido completo, etiqueta iniciando
200 { status: "pedido_completo", pedido_id, pedido_numero, etiqueta_status: "pendente" }

// Item não encontrado
404 { error: "item_nao_encontrado", codigo }

// Item já completamente bipado
409 { error: "item_ja_completo", pedido_id, sku }
```

### 6.14 Edge Cases

| Caso | Tratamento |
|---|---|
| Produto sem GTIN cadastrado | Scan por SKU funciona como fallback |
| Mesmo SKU em dois pedidos pendentes | Match no pedido mais antigo (`FOR UPDATE SKIP LOCKED` garante que operadores simultâneos pegam pedidos diferentes) |
| Operador bipa item errado | Erro com feedback sonoro, nada é salvo. Botão "Desfazer" disponível por 10s após bip correto |
| Operador bipa a mais (qty excedida) | Bloqueado na função PL/pgSQL (safety check), retorna `409 { error: "ja_completo" }` |
| Etiqueta não disponível ao embalar | `etiqueta_status = 'falhou'`, badge visual no pedido, botão retry disponível |
| PrintNode offline | Job fica na fila do PrintNode, imprime quando voltar. SISO mostra `etiqueta_status = 'impresso'` (job enviado) |
| Pedido cancelado durante separação | Webhook de cancelamento seta `status = 'cancelado'` E `status_separacao = 'cancelado'`, some da tela |
| Kit expandido em componentes | Cada componente é um item separado — bip individual |
| Pedido OC sem estoque | Aparece na tela com badge "Aguardando Estoque", bip desabilitado |
| Sem impressora configurada | Botão de imprimir desabilitado, tooltip indica configuração |
| NF webhook chega antes do worker salvar `nota_fiscal_id` | Fallback via `GET /notas/{id}` → `origem.id` (campo confirmado na spec Tiny v3) |
| NF webhook chega antes do pedido existir em siso_pedidos | Salvar com `status = 'aguardando_pedido'`, retry em 30s |
| NF webhook de devolução/serviço (sem pedido de venda) | Verificar `origem.tipo` — só processar se `"venda"`. Log info, ignora silenciosamente (200 OK) |
| NF webhook duplicado | Dedup por `dedup_key = "nf_{idNotaFiscalTiny}"` no `siso_webhook_logs` |
| Worker falha antes de gerar NF | Pedido fica em `aguardando_nf` indefinidamente — visível na aba "Aguardando NF" com badge "Atenção" após 2h. Admin pode "Forçar Pendente" |
| `etiqueta_url` expirada na reimpressão | Refazer `GET /expedicao/{agrupamento_tiny_id}/etiquetas` para obter URL fresca |
| Decisão final diferente da sugestão | `separacao_galpao_id` recalculado no endpoint de aprovação |
| Pedidos existentes (anteriores ao módulo) | `status_separacao = NULL`, ignorados pelas queries de separação |
| Cast de tipo: `nota_fiscal_id` é bigint | Garantir `CAST(idNotaFiscalTiny AS bigint)` na comparação |

---

## 7. Success Metrics

- Operadores usam 100% o SISO para separação (não abrem mais separação no Tiny) — meta: 95%+ em 30 dias
- Zero erros de localização (item sempre encontrado na primeira tentativa)
- Tempo médio de separação por pedido reduz vs baseline atual (medir antes/depois)
- Etiqueta impressa em < 10s após último bip do pedido (inclui latência Tiny + PrintNode)
- Zero etiquetas na impressora errada
- Taxa de bip "não encontrado": < 2%
- Etiquetas impressas com sucesso na primeira tentativa: > 95%

---

## 8. Ordem de Implementação Sugerida

| Fase | User Stories | Entregável |
|---|---|---|
| **0. Auth** | US-016 | Sessão server-side (`siso_sessoes`, `getSessionUser`), rate limiting no bip |
| **1. Schema + Dados** | US-006, US-009, US-010, US-011 | Migrations (incluindo `siso_processar_bip` function, `localizacao` em item_estoques, índices), webhook-processor captura GTIN e `separacao_galpao_id`, salva `localizacao` em `siso_pedido_item_estoques`, status default `aguardando_nf`. Atualizar endpoint de aprovação para recalcular `separacao_galpao_id` |
| **2. NF Webhook** | US-013 | Handler `tipo: "nota_fiscal"` em route.ts (discriminador antes de `codigoSituacao`), match NF→pedido (fast-path + fallback `origem.id`), transição `aguardando_nf → pendente`, retry para timing race |
| **3. API de Separação** | US-001, US-002, US-003, US-011, US-015 | `GET /api/separacao` + `POST /api/separacao/bipar` (via rpc) + `POST /api/separacao/desfazer-bip` + `POST /api/separacao/expedir` |
| **4. Frontend Separação** | US-001, US-002, US-003, US-012, US-014 | Página `/separacao` com scan + 4 tabs (Aguardando NF, Pendentes, Embalados, Expedidos), polling TanStack Query 10s, feedback sonoro |
| **5. PrintNode** | US-005, US-008 | `printnode.ts`, config UI (API key via env var) |
| **6. Etiqueta** | US-004, US-007 | `etiqueta-service.ts`, agrupamento Tiny + auto-print + `etiqueta_status` tracking + reimprimir |
| **7. Polish** | — | Sons, animações, testes, edge cases, badge "Atenção" para pedidos presos |

---

## 9. Decisões Tomadas (ex-Open Questions)

1. **Pedidos OC**: Aparecem na separação com badge "Aguardando Estoque" e bip desabilitado. Dá visibilidade ao operador sem poluir a fila.

2. **Desfazer bip**: Incluído no MVP (US-015). Toast com botão "Desfazer" por 10 segundos após cada bip. Essencial para adoção — sem undo, operador precisa chamar admin para corrigir no banco.

3. **Múltiplas etiquetas**: MVP assume 1 etiqueta por pedido (primeira URL do array `urls[]`). Schema suporta expansão futura (campo `etiqueta_url text` pode virar `text[]` se necessário).

4. **Impressão de DANFE**: Fora do escopo. Pode ser adicionada com mesmo mecanismo PrintNode via `url_danfe` já salva.

5. **Pedidos antigos**: Não fazer backfill. `status_separacao = NULL` para pedidos existentes, filtrados pelas queries. Scan por SKU funciona como fallback para pedidos sem GTIN.

6. **Formato do webhook de NF**: Payload assumido precisa ser validado contra webhook real do Tiny ANTES da implementação da Fase 2. Configurar webhook de NF no Tiny → capturar payload → confirmar nomes dos campos.
