# PRD: Módulos Inventário + Transferência de Estoque + Etiquetas de Endereço

## 1. Introdução

O SISO atualmente cobre pedidos (webhook → decisão → separação → expedição) e compras. Faltam 3 operações críticas do galpão que hoje dependem de uma planilha Google Sheets + API Tiny v2 legada:

1. **Inventário físico** — contagem de estoque + atualização de localização no Tiny ERP
2. **Transferência de estoque** — movimentar produtos entre galpões/empresas com saída na origem e entrada no destino
3. **Etiquetas de endereço** — impressão de etiquetas ZPL para prateleiras do galpão

Os 3 módulos usam a infraestrutura existente do SISO: API Tiny v3 (OAuth2), rate limiting (`runWithEmpresa`/`tinyQueue`), PrintNode, e o design system atual.

**Prioridade de implementação:** Inventário → Transferência → Etiquetas.

---

## 2. Goals

- Eliminar dependência da planilha Google Sheets e da API Tiny v2 legada
- Permitir inventário físico completo (localização + saldo) direto do celular via SISO
- Permitir transferência de estoque entre galpões com rastreabilidade
- Gerar e imprimir etiquetas de endereçamento de prateleira via PrintNode
- Manter a usabilidade "tipo caixa de supermercado" — mínimo de toques, máxima velocidade de scan
- Funcionar perfeitamente no primeiro deploy (servidor persistente VPS/Easypanel)

---

## 3. User Stories

### Módulo 1: Inventário

#### US-001: Criar sessão de inventário
**Descrição:** Como operador, quero criar uma sessão de inventário vinculada a uma empresa e galpão, escolhendo o modo de operação, para iniciar a contagem física.

**Acceptance Criteria:**
- [ ] Formulário com: empresa (auto se operador tem acesso a 1 só, select se >1), modo (toggle: "Localização + Estoque" default | "Apenas Localização"), tipo de registro de estoque (toggle: Balanço B | Entrada E | Saída S — visível só se modo = loc_estoque), opção "Manter localização antiga" (toggle: Substituir default | Merge), observações (textarea opcional)
- [ ] Galpão é resolvido automaticamente a partir da empresa selecionada
- [ ] `deposito_id` é resolvido automaticamente de `siso_tiny_connections.deposito_id` da empresa. Se não configurado → erro claro "Depósito não configurado para esta empresa"
- [ ] Inventário criado com status `em_andamento`, vinculado ao usuário logado
- [ ] Apenas empresas do galpão do operador são listadas (filtro por cargo/galpão)
- [ ] Após criar, navega direto para a tela de escaneamento
- [ ] Typecheck/lint passa

#### US-002: Escanear itens no inventário
**Descrição:** Como operador no galpão com celular + leitor Bluetooth, quero escanear localizações e produtos rapidamente para registrar o inventário físico.

**Acceptance Criteria:**
- [ ] Campo de localização "sticky" no topo — aceita digitação manual OU scan de barcode (a mesma etiqueta de endereço que o módulo de etiquetas gera). Formato livre (sem validação de formato). Campo monospace, fonte grande
- [ ] Campo de SKU/EAN com auto-focus permanente. Aceita scan Bluetooth (preenche + Enter automático) OU digitação manual (operador digita + Enter). `inputMode="none"` por padrão, mas com botão teclado (ícone) que alterna para `inputMode="text"` caso o operador precise digitar manualmente. Após submit, campo limpa e refoca automaticamente
- [ ] Ao submeter SKU (via scan ou digitação manual): `POST /api/inventario/[id]/coletar` busca no Tiny por SKU (`buscarProdutoPorSku`), se não encontrar tenta por EAN (`buscarProdutoPorGtin`). Se encontrar: insere item com qty 1. Se não encontrar: beep erro + toast "Produto não encontrado"
- [ ] Item aparece na lista imediatamente (mais recente no topo) com: SKU (monospace bold), nome do produto (truncado), localização, quantidade (editável — toque no número abre input numérico)
- [ ] Se o SKU já foi escaneado antes no mesmo inventário (em outra localização ou na mesma): beep duplo (atenção, não erro) + aviso visual "Também em: C-01-5 (×2)" no card do item
- [ ] Botão lixeira em cada item para deletar (`DELETE /api/inventario/[id]/itens/[itemId]`)
- [ ] Edição de quantidade inline: operador toca na qty do item → campo numérico abre → confirma → `PATCH /api/inventario/[id]/itens/[itemId]`
- [ ] Counter "N itens" no header, sempre atualizado (via COUNT real do banco)
- [ ] Botão "Processar Inventário" fixo no bottom com resumo (N itens · Balanço)
- [ ] Audio feedback: scan OK novo = beep agudo 880Hz 100ms; scan OK repetido = beep duplo 880Hz; scan não encontrado = beep grave duplo 220Hz
- [ ] Localização obrigatória — se vazia, não permite escanear (toast "Defina uma localização primeiro")
- [ ] Somente o criador do inventário pode adicionar/editar/deletar itens e processar
- [ ] Typecheck/lint passa

#### US-003: Processar inventário (enviar para Tiny)
**Descrição:** Como operador, quero processar o inventário para que as localizações e saldos sejam atualizados no Tiny ERP automaticamente.

**Acceptance Criteria:**
- [ ] Botão "Processar" mostra confirmação inline ("Tem certeza? N itens serão enviados ao Tiny")
- [ ] `POST /api/inventario/[id]/processar` — fire-and-forget (retorna 200 imediato, processa em background no servidor VPS)
- [ ] Frontend transiciona para tela de progresso com poll a cada 2 segundos (`GET /api/inventario/[id]/progresso`)
- [ ] Processamento consolida itens: agrupa por SKU, soma quantidades, merge localizações únicas com "; " (deduplica)
- [ ] Para cada produto consolidado (dentro de `runWithEmpresa` para rate limiting):
  - Chama `getProdutoDetalhe(token, produtoId)` para detectar tipo do produto
  - Se produto tipo Kit (K): pula movimentação de estoque, apenas atualiza localização
  - Se modo `loc_estoque`: chama `movimentarEstoque(token, produtoId, {tipo, quantidade, deposito: {id}})` com observação "Inventário SISO - {data} - {nome operador} - {observação do inventário}"
  - Se opção "Manter localização antiga" = Merge: busca localização atual do Tiny (via GET no `atualizarLocalizacaoProduto`), verifica se a nova localização já está contida na antiga, se não → concatena `{antiga}; {nova}`
  - Se opção = Substituir: seta localização diretamente para o valor consolidado do inventário
  - Chama `atualizarLocalizacaoProduto(token, produtoId, localizacaoFinal)`
  - Atualiza status do item (sucesso/erro com mensagem) + counters no inventário
- [ ] Tela de progresso mostra: barra de progresso (%, X de Y), counters (sucesso/erro), lista consolidada com status por item (sucesso verde, erro vermelho com mensagem, pendente cinza)
- [ ] Se TODAS as operações falharem: status → `erro`
- [ ] Se processamento crashar (deploy, restart): operador pode clicar "Reprocessar" — reprocessa apenas itens com status `pendente`. Itens `sucesso` não são tocados
- [ ] Ao concluir: status → `concluido`, banner "Inventário Concluído — X ok · Y erros · Zmim"
- [ ] Typecheck/lint passa

#### US-004: Reverter processamento de inventário
**Descrição:** Como operador, quero poder reverter um inventário processado incorretamente para restaurar o estado anterior no Tiny.

**Acceptance Criteria:**
- [ ] Botão "Reverter" visível apenas em inventários com status `concluido` e somente para o criador
- [ ] Confirmação inline: "Reverter restaurará localizações e saldos anteriores no Tiny. Continuar?"
- [ ] `POST /api/inventario/[id]/reverter` — fire-and-forget como o processar
- [ ] Para reverter localização: precisa ter salvo a localização antiga do Tiny antes de atualizar. Adicionar campo `localizacao_antiga_tiny` em `siso_inventario_itens` (preenchido durante processamento, antes de atualizar)
- [ ] Para reverter estoque (se modo `loc_estoque`): aplica movimento inverso:
  - Se tipo original foi Balanço (B): precisa saber o saldo anterior → salvar `saldo_anterior_tiny` em `siso_inventario_itens`
  - Se tipo original foi Entrada (E): fazer Saída (S) da mesma quantidade
  - Se tipo original foi Saída (S): fazer Entrada (E) da mesma quantidade
- [ ] Status → `revertendo` → `revertido` (ou `erro` se falhar)
- [ ] Tela de progresso idêntica ao processamento (poll, barra, status por item)
- [ ] Typecheck/lint passa

#### US-005: Listar e gerenciar inventários
**Descrição:** Como operador, quero ver meus inventários em andamento e concluídos, filtrados pelo meu galpão.

**Acceptance Criteria:**
- [ ] Página `/inventario` com AppShell + 2 tabs: "Em Andamento" | "Concluídos"
- [ ] Visibilidade filtrada por galpão do operador (operador_cwb só vê inventários de empresas CWB)
- [ ] Admin vê tudo
- [ ] Tab "Em Andamento": cards com empresa, galpão, modo, total itens, usuário, data. Botão "Continuar" navega para tela de scan
- [ ] Tab "Concluídos": cards compactos expansíveis com resumo (X sucesso, Y erro, duração, data). Inventários com status `revertido` mostram badge
- [ ] Botão "+ Novo Inventário" no header
- [ ] Card no dashboard home (`/`) com count de inventários em_andamento do galpão do operador
- [ ] PATCH para cancelar inventário (apenas criador ou admin)
- [ ] Empty state quando não há inventários
- [ ] Typecheck/lint passa

---

### Módulo 2: Transferência de Estoque

#### US-006: Criar transferência de estoque
**Descrição:** Como operador, quero criar uma sessão de transferência selecionando empresa de origem e empresa de destino para movimentar produtos entre galpões.

**Acceptance Criteria:**
- [ ] Formulário com: empresa origem (auto se operador tem 1 só, select se >1), empresa destino (select — todas as empresas ativas EXCETO a de origem), observações (opcional)
- [ ] Galpão de origem/destino resolvidos automaticamente a partir das empresas
- [ ] `deposito_id` origem e destino resolvidos de `siso_tiny_connections`
- [ ] Transferência criada com status `em_andamento`
- [ ] Apenas empresas do galpão do operador na origem (filtro por cargo). Destino = qualquer empresa de outro galpão
- [ ] Typecheck/lint passa

#### US-007: Escanear itens para transferência
**Descrição:** Como operador, quero escanear os produtos que estou enviando para outro galpão, com a mesma agilidade do inventário.

**Acceptance Criteria:**
- [ ] Interface de scan idêntica ao inventário (campo SKU auto-focus, Bluetooth ou digitação manual, toggle teclado, beeps), mas SEM campo de localização (transferência não precisa de endereço)
- [ ] Ao escanear SKU: busca produto na empresa de ORIGEM por SKU (`buscarProdutoPorSku`), se não encontrar tenta EAN (`buscarProdutoPorGtin`)
- [ ] Se encontrar na origem: insere item com produto_id_tiny da origem, nome, SKU, EAN. Destino é resolvido no processamento
- [ ] Item aparece na lista com: SKU, nome, qty (editável)
- [ ] Mesmas operações: editar qty, deletar item
- [ ] Somente o criador pode modificar
- [ ] Typecheck/lint passa

#### US-008: Processar transferência
**Descrição:** Como operador, quero processar a transferência para que o estoque seja debitado da origem e creditado no destino no Tiny.

**Acceptance Criteria:**
- [ ] Fire-and-forget com poll de progresso (mesmo padrão do inventário)
- [ ] Para cada produto (dentro de `runWithEmpresa` — alternando entre origem e destino):
  - Busca produto no destino por SKU (`buscarProdutoPorSku`). Se não encontrar → clona: busca dados completos na origem (`getProduto`), cria produto no destino via `criarProduto` (API v3 POST /produtos), salva novo `produto_id_tiny_destino`
  - `movimentarEstoque(tokenOrigem, produtoIdOrigem, {tipo: "S", quantidade, deposito: {id: depositoOrigem}})` com observação "Transferência SISO para {galpão destino} - {operador}"
  - `movimentarEstoque(tokenDestino, produtoIdDestino, {tipo: "E", quantidade, deposito: {id: depositoDestino}})` com observação "Transferência SISO de {galpão origem} - {operador}"
- [ ] Checkpoint/retomada funciona (reprocessa itens pendentes)
- [ ] Barra de progresso + status por item
- [ ] Status final: `concluido` ou `erro`
- [ ] Typecheck/lint passa

#### US-009: Reverter transferência
**Descrição:** Como operador, quero reverter uma transferência processada incorretamente.

**Acceptance Criteria:**
- [ ] Reverter = Entrada na origem + Saída no destino (movimento inverso)
- [ ] Mesma UX de progresso/poll
- [ ] Status → `revertido`
- [ ] Typecheck/lint passa

#### US-010: Listar e gerenciar transferências
**Descrição:** Como operador, quero ver transferências em andamento e concluídas.

**Acceptance Criteria:**
- [ ] Página `/transferencias` com 2 tabs: "Em Andamento" | "Concluídas"
- [ ] Cards mostram: origem → destino (badge com seta), total itens, operador, data, status
- [ ] Visibilidade filtrada por galpão (operador_cwb vê transferências onde CWB é origem OU destino)
- [ ] Card no dashboard home com count de transferências em_andamento
- [ ] Typecheck/lint passa

---

### Módulo 3: Etiquetas de Endereço

#### US-011: Gerar e imprimir etiquetas pequenas (2 por label)
**Descrição:** Como operador, quero gerar etiquetas de endereçamento pequenas (2 por label) para colar nas prateleiras do galpão.

**Acceptance Criteria:**
- [ ] Tab "Pequena (2/label)" na página `/etiquetas`
- [ ] Formulário: corredor início/fim (texto livre, uppercase), horizontal início/fim (numérico), vertical início/fim (numérico)
- [ ] Range de corredores: se ambos iguais → 1 corredor; se letras únicas diferentes (C→E) → C,D,E; se multi-char (PE→PE) → só PE; se numéricos (1→3) → 1,2,3
- [ ] Botão "Gerar Preview" → `POST /api/etiquetas-endereco/preview` retorna lista de endereços + total + total de labels
- [ ] Preview: grid de badges monospace com endereços gerados (formato: CORREDOR-HH-V, horizontal zero-padded, vertical sem padding)
- [ ] Seletor de impressora: lista todas as impressoras PrintNode disponíveis, operador escolhe qual usar
- [ ] Botão "Imprimir N etiquetas (M labels)" → `POST /api/etiquetas-endereco/imprimir`
- [ ] Warning visual se >100 etiquetas: "Muitas etiquetas. Confirma impressão?"
- [ ] ZPL com `^PW812^LL184` (100mm × 23mm @203dpi) + template exato do script `GERARSEMFIXA()`: `^CF0,70`, barcode Code128 `^BCN,85`, QR code `^BQN,2,4`, 2 etiquetas lado a lado (x=10 e x=450), labels ímpares geram 1 sozinha
- [ ] ZPL enviado via `enviarImpressaoZpl(apiKey, printerId, zpl, titulo)`
- [ ] Toast sucesso com jobId
- [ ] Typecheck/lint passa

#### US-012: Gerar e imprimir etiquetas grandes (1 por label)
**Descrição:** Como operador, quero gerar etiquetas grandes rotacionadas para placas de corredor/prateleira.

**Acceptance Criteria:**
- [ ] Tab "Grande (1/label)" na página `/etiquetas`
- [ ] Mesmo formulário de ranges
- [ ] Mesma lógica de preview
- [ ] Impressora: usa a impressora padrão do galpão do operador (mesma lógica da etiqueta de envio, via `resolverImpressora(userId, galpaoId)`). Se não configurada → seletor manual como fallback
- [ ] ZPL gerado com template exato do script `GERARZPL_VERTICAL()`: `^FWR` (rotação 90°), `^CF0,250` (font 250), barcode `^BCR,200`, QR `^BQN,2,10`, 1 label por etiqueta
- [ ] Label = 100mm × 150mm (mesmo label de envio 4×6")
- [ ] Typecheck/lint passa

#### US-013: Qualquer usuário pode gerar etiquetas
**Descrição:** Como qualquer usuário logado, quero acessar o módulo de etiquetas sem restrição de empresa ou galpão.

**Acceptance Criteria:**
- [ ] Sem filtro de empresa/galpão — qualquer usuário logado acessa
- [ ] Sem banco de dados — geração 100% stateless
- [ ] Card no dashboard home (sem counter — estático)
- [ ] Typecheck/lint passa

---

## 4. Functional Requirements

### Database

**FR-1:** Criar tabela `siso_inventarios` com campos: id (uuid PK), empresa_id (FK), galpao_id (FK), usuario_id (FK), deposito_id (int), modo (loc_only | loc_estoque), tipo_estoque (B | E | S | null), manter_localizacao_antiga (boolean default false), status (em_andamento | processando | concluido | cancelado | erro | revertendo | revertido), total_itens (int), itens_processados (int), itens_sucesso (int), itens_erro (int), observacoes (text), created_at, processado_em, concluido_em.

**FR-2:** Criar tabela `siso_inventario_itens` com campos: id (uuid PK), inventario_id (FK com CASCADE), produto_id_tiny (int), sku (text NOT NULL), nome_produto (text), ean (text), localizacao (text NOT NULL), quantidade (int default 1), status (pendente | processando | sucesso | erro), erro_msg (text), localizacao_antiga_tiny (text — preenchido durante processamento, para reversão), saldo_anterior_tiny (numeric — preenchido durante processamento, para reversão de balanço), created_at. SEM unique constraint em (inventario_id, sku, localizacao) — intencional.

**FR-3:** Criar tabela `siso_transferencias` com campos: id (uuid PK), empresa_origem_id (FK), empresa_destino_id (FK), galpao_origem_id (FK), galpao_destino_id (FK), usuario_id (FK), deposito_origem_id (int), deposito_destino_id (int), status (em_andamento | processando | concluido | cancelado | erro | revertendo | revertido), total_itens (int), itens_processados (int), itens_sucesso (int), itens_erro (int), observacoes (text), created_at, processado_em, concluido_em.

**FR-4:** Criar tabela `siso_transferencia_itens` com campos: id (uuid PK), transferencia_id (FK com CASCADE), produto_id_tiny_origem (int NOT NULL), produto_id_tiny_destino (int — preenchido no processamento: busca por SKU no destino, clona se necessário), sku (text NOT NULL), nome_produto (text), ean (text), quantidade (int default 1), clonado (boolean default false — true se produto foi criado no destino), status (pendente | processando | sucesso | erro), erro_msg (text), created_at.

### Tiny API

**FR-5:** Implementar `buscarProdutoPorGtin(token, gtin)` em `tiny-api.ts` — `GET /produtos?gtin={gtin}&situacao=A`, retorna primeiro resultado ou null.

**FR-6:** Implementar `criarProduto(token, dados)` em `tiny-api.ts` para clonagem na transferência — `POST /produtos` com dados do produto de origem (sem estoque). Usado quando o SKU não existe ainda na empresa de destino (o sistema garante que passe a existir).

**FR-7:** Toda chamada API Tiny deve estar dentro de `runWithEmpresa()` para rate limiting automático (55 req/min por empresa).

**FR-8:** `getProdutoDetalhe(token, produtoId)` chamado para cada produto no processamento do inventário para detectar tipo Kit (K). Kits: apenas atualizar localização, pular movimentação de estoque.

### Inventário — Backend

**FR-9:** `POST /api/inventario` — criar sessão. Resolve galpao_id de `siso_empresas.galpao_id`, deposito_id de `siso_tiny_connections.deposito_id`. Retorna 400 se depósito não configurado.

**FR-10:** `POST /api/inventario/[id]/coletar` — buscar produto no Tiny (SKU → EAN fallback), inserir item, verificar se SKU já existe no inventário e retornar `ja_escaneado: true` com `localizacoes_anteriores`. Retorna 404 se não encontrar. Retorna 403 se usuário não é o criador.

**FR-11:** `POST /api/inventario/[id]/processar` — fire-and-forget. Consolida itens (agrupa por SKU, soma qty, merge locs). Para cada produto consolidado: getProdutoDetalhe → movimentarEstoque (se não kit e modo loc_estoque) → atualizarLocalizacaoProduto (com merge ou substituição conforme config). Salva localizacao_antiga_tiny e saldo_anterior_tiny antes de atualizar (para reversão). Atualiza counters.

**FR-12:** `POST /api/inventario/[id]/reverter` — fire-and-forget. Para cada item com status `sucesso`: restaurar localização antiga, aplicar movimento inverso de estoque.

**FR-13:** `GET /api/inventario/[id]/progresso` — retorna counters + lista consolidada com status por item.

**FR-14:** Contadores (total_itens etc.) sempre calculados com COUNT/SUM do banco (nunca incrementais) para garantir correção.

### Transferência — Backend

**FR-15:** `POST /api/transferencia` — criar sessão com empresa_origem_id e empresa_destino_id. Resolve galpões e depósitos.

**FR-16:** `POST /api/transferencia/[id]/coletar` — buscar produto na empresa ORIGEM por SKU (fallback EAN). Salva produto_id_tiny da origem, nome, SKU, EAN. O destino é resolvido no processamento: busca por SKU na empresa destino; se não existir, clona automaticamente.

**FR-17:** `POST /api/transferencia/[id]/processar` — fire-and-forget. Para cada item: busca SKU no destino → se não existir, clona produto da origem → Saída (S) na origem → Entrada (E) no destino. Observações incluem contexto e nome do operador.

**FR-18:** `POST /api/transferencia/[id]/reverter` — Entrada na origem + Saída no destino (inverso).

### Etiquetas — Backend

**FR-19:** `POST /api/etiquetas-endereco/preview` — recebe EnderecoRange, retorna lista de endereços + total + total de labels.

**FR-20:** `POST /api/etiquetas-endereco/imprimir` — recebe EnderecoRange + tipo (pequena|grande) + printerId. Gera ZPL com templates exatos dos scripts originais, envia para PrintNode.

**FR-21:** Rota `/api/etiquetas-endereco/imprimir` para etiqueta grande: se printerId não fornecido, usa `resolverImpressora(userId, galpaoId)`.

### Frontend

**FR-22:** Todas as páginas usam `AppShell` com `backHref` para navegação. Mobile-first (max-w-3xl).

**FR-23:** Módulo inventário em `/inventario`, transferência em `/transferencias`, etiquetas em `/etiquetas`.

**FR-24:** Cards no dashboard home para os 3 módulos. Inventário e Transferência mostram count de sessões em_andamento. Etiquetas sem count (estático).

**FR-25:** Tabs com componente `Tabs` existente. Empty states com componente `EmptyState` existente.

**FR-26:** Audio feedback reusa `audio-feedback.ts` existente + adiciona `playDuplicate()` (beep duplo 880Hz).

**FR-27:** Scan input segue padrão exato de `scan-input.tsx`: `inputMode="none"`, auto-focus, form submit, clear after scan.

---

## 5. Non-Goals (Out of Scope)

- **Catálogo local de produtos:** Não criar tabela de produtos no Supabase. Buscar sempre no Tiny em tempo real
- **Inventário offline:** Se perder conexão, scan não funciona (cada scan é POST). Sem buffer local
- **Nota fiscal de transferência:** Transferência é apenas movimentação de estoque, sem NF
- **Deletar produtos clonados na reversão:** Se produto foi clonado no destino, reversão não deleta (pode já ter sido usado)
- **Auto-cancelamento de inventários abandonados:** Não auto-cancela. Fica visível na listagem para cancelamento manual
- **Inventário por área/zona:** Sem conceito de "zona de contagem". Inventário é livre, operador escaneia o que quiser
- **Aprovação de transferência no destino:** O destino não "aceita" a transferência. É responsabilidade do operador que criou
- **Batch API do Tiny:** Não existe endpoint de batch na v3. Processamento é produto a produto
- **Etiqueta com logo ou imagem:** Apenas texto, barcode Code128 e QR code

---

## 6. Technical Considerations

### Infraestrutura existente reutilizada

| Componente | Arquivo | Uso |
|---|---|---|
| Token OAuth2 | `tiny-oauth.ts` → `getValidTokenByEmpresa(empresaId)` | Todas as chamadas Tiny |
| Rate limiting | `tiny-queue.ts` → `runWithEmpresa(empresaId, fn)` | 55 req/min auto por empresa |
| Busca produto | `tiny-api.ts` → `buscarProdutoPorSku(token, sku)` | Scan de SKU |
| Tipo produto | `tiny-api.ts` → `getProdutoDetalhe(token, id)` | Detectar Kit (K) |
| Ajuste estoque | `tiny-api.ts` → `movimentarEstoque(token, id, params)` | B/E/S com depósito |
| Atualizar loc | `tiny-api.ts` → `atualizarLocalizacaoProduto(token, id, loc)` | 2 calls: GET desc + PUT |
| Imprimir ZPL | `printnode.ts` → `enviarImpressaoZpl(params)` | Labels de endereço |
| Resolver printer | `printnode.ts` → `resolverImpressora(userId, galpaoId)` | Etiqueta grande |
| Config | `config.ts` → `getConfig("printnode_api_key")` | API key PrintNode |
| Auth | `session.ts` → `getSessionUser(request)` | Todas as rotas |
| Log | `logger.ts` → `logger.logError(opts)` | Erros com categoria + correlation |
| Audio | `audio-feedback.ts` | Beeps de scan |
| UI | `tabs.tsx`, `empty-state.tsx`, `loading-spinner.tsx`, `app-shell.tsx` | Layout |

### Funções novas necessárias em tiny-api.ts

```typescript
// Busca por GTIN/EAN
export async function buscarProdutoPorGtin(token: string, gtin: string): Promise<TinyProdutoBusca | null>
// GET /produtos?gtin={gtin}&situacao=A

// Criar produto (clone para transferência — quando SKU não existe no destino)
export async function criarProduto(token: string, dados: TinyProdutoCriacao): Promise<{ id: number }>
// POST /produtos — copia dados da origem (SKU, nome, unidade, NCM, preço, etc.) sem estoque
```

### Custo de API por operação

| Operação | Calls por produto | 500 produtos a 55/min |
|---|---|---|
| Inventário loc_only | 3 (search + getProdutoDetalhe + PUT loc = GET desc + PUT) | ~27 min |
| Inventário loc_estoque | 4 (search + getProdutoDetalhe + POST estoque + PUT loc) | ~36 min |
| Transferência (SKU existe no destino) | 3 (search destino + Saída origem + Entrada destino) | ~27 min |
| Transferência (SKU clonado) | 5 (+ GET detalhe origem + POST criar no destino) | ~45 min |

**Nota:** Estimativas para pior caso. Rate limiting é por empresa, e transferência alterna entre duas empresas (efetivamente 2× o throughput). Na prática a maioria dos SKUs já existe no destino, clonagem é exceção.

### Schema de banco — novos campos para reversão

`siso_inventario_itens` precisa de:
- `localizacao_antiga_tiny text` — localização no Tiny ANTES da atualização
- `saldo_anterior_tiny numeric` — saldo no Tiny ANTES da movimentação (tipo B)

Esses campos são preenchidos DURANTE o processamento (antes de chamar a API), não durante o scan.

### Fire-and-forget no servidor persistente

O servidor é VPS/Easypanel (não serverless). Processamento de 27-54 min roda em background na mesma instância Node.js. Riscos:
- Deploy durante processamento → processo morre → checkpoint resolve (reprocessar itens pendentes)
- Operador fecha aba → sem problema, processamento é server-side
- Dois inventários processando ao mesmo tempo → rate limiting garante que não estoura

### ZPL — Templates exatos

**Pequena (2/label, 100mm × 23mm = ~812 × 184 dots @203dpi):**
```zpl
^XA
^PW812
^LL184
^CF0,70
^LH0,0^FS
^FO10,30^FB400,1,,C^FD{addr1}^FS
^BY2,2,70
^FO20,120^BCN,85,N,N,N^FD{addr1}^FS
^FO300,50^BQN,2,4^FDQA,{addr1}^FS
^FO450,30^FB400,1,,C^FD{addr2}^FS
^BY2,2,70
^FO460,120^BCN,85,N,N,N^FD{addr2}^FS
^FO750,50^BQN,2,4^FDQA,{addr2}^FS
^XZ
```
**Nota:** Label físico = 100mm largura × 23mm altura. Duas colunas lado a lado (~50mm cada). Texto 70pt + barcode Code128 85u + QR code compacto.

**Grande (1/label, 4×6"):**
```zpl
^XA
^FWR
^CF0,250
^LH0,0^FS
^FO450,0^FB1300,0,,C^FD{addr}^FS
^BY6,3,200
^FO50,100^BCR,200,N,N,N^FD{addr}^FS
^FO50,700^BQN,2,10^FDQA,{addr}^FS
^XZ
```

---

## 7. Success Metrics

- Inventário de 500 itens processado com 0 erros não-esperados no primeiro uso
- Tempo de scan < 3 segundos (desde beep até item aparecer na lista)
- Operador consegue fazer inventário completo de corredor sem precisar de treinamento além de "bipa a localização, bipa os itens"
- Transferência de 50 itens entre CWB→SP processada corretamente (saldos corretos em ambas as empresas)
- Etiquetas impressas com barcode + QR code legíveis pelo scanner Bluetooth
- `npm run build` sem erros

---

## 8. Open Questions — TODAS RESOLVIDAS

- [x] **Etiqueta pequena:** 100mm × 23mm (2 colunas). ZPL com `^PW812^LL184` @203dpi
- [x] **Clonagem na transferência:** Se SKU não existe no destino → clonar automaticamente (GET origem + POST destino). Campos: `nome` (obrigatório), `preco` (obrigatório), `sku`, `gtin`, `descricao`, `ncm`, `unidade`, `origem`, `tipo`, `precoCusto`, `localizacao`, `estoqueMinimo`, `estoqueMaximo`
- [x] **Reversão de Balanço:** Sim, se saldo anterior era 0, reversão seta para 0. Campo `saldo_anterior_tiny` salvo durante processamento
- [x] **Depósitos:** Cada empresa usa apenas o `deposito_id` configurado em `siso_tiny_connections`. Sem seletor de depósito

---

## 9. Detalhes de Implementação

### 9.1 Migration SQL Completa

**Arquivo:** `supabase/migrations/20260323_modulo_inventario_transferencia.sql`

```sql
-- =============================================
-- Módulo Inventário
-- =============================================

CREATE TABLE siso_inventarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id       uuid NOT NULL REFERENCES siso_galpoes(id),
  usuario_id      uuid NOT NULL REFERENCES siso_usuarios(id),
  deposito_id     int,
  modo            text NOT NULL CHECK (modo IN ('loc_only', 'loc_estoque')),
  tipo_estoque    text CHECK (tipo_estoque IN ('B', 'E', 'S')),
  manter_localizacao_antiga boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'em_andamento'
                  CHECK (status IN ('em_andamento', 'processando', 'concluido', 'cancelado', 'erro', 'revertendo', 'revertido')),
  observacoes     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processado_em   timestamptz,
  concluido_em    timestamptz
);

CREATE TABLE siso_inventario_itens (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventario_id           uuid NOT NULL REFERENCES siso_inventarios(id) ON DELETE CASCADE,
  produto_id_tiny         int,
  sku                     text NOT NULL,
  nome_produto            text,
  ean                     text,
  localizacao             text NOT NULL,
  quantidade              int NOT NULL DEFAULT 1,
  status                  text NOT NULL DEFAULT 'pendente'
                          CHECK (status IN ('pendente', 'processando', 'sucesso', 'erro')),
  erro_msg                text,
  localizacao_antiga_tiny text,       -- preenchido no processamento, antes de atualizar
  saldo_anterior_tiny     numeric,    -- preenchido no processamento, antes de movimentar (tipo B)
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventarios_status ON siso_inventarios(status);
CREATE INDEX idx_inventarios_empresa ON siso_inventarios(empresa_id);
CREATE INDEX idx_inventarios_usuario ON siso_inventarios(usuario_id);
CREATE INDEX idx_inventario_itens_inv ON siso_inventario_itens(inventario_id);
CREATE INDEX idx_inventario_itens_sku ON siso_inventario_itens(inventario_id, sku);

-- =============================================
-- Módulo Transferência de Estoque
-- =============================================

CREATE TABLE siso_transferencias (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_origem_id   uuid NOT NULL REFERENCES siso_empresas(id),
  empresa_destino_id  uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_origem_id    uuid NOT NULL REFERENCES siso_galpoes(id),
  galpao_destino_id   uuid NOT NULL REFERENCES siso_galpoes(id),
  usuario_id          uuid NOT NULL REFERENCES siso_usuarios(id),
  deposito_origem_id  int,
  deposito_destino_id int,
  status              text NOT NULL DEFAULT 'em_andamento'
                      CHECK (status IN ('em_andamento', 'processando', 'concluido', 'cancelado', 'erro', 'revertendo', 'revertido')),
  observacoes         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  processado_em       timestamptz,
  concluido_em        timestamptz
);

CREATE TABLE siso_transferencia_itens (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transferencia_id        uuid NOT NULL REFERENCES siso_transferencias(id) ON DELETE CASCADE,
  produto_id_tiny_origem  int NOT NULL,
  produto_id_tiny_destino int,           -- preenchido no processamento
  sku                     text NOT NULL,
  nome_produto            text,
  ean                     text,
  quantidade              int NOT NULL DEFAULT 1,
  clonado                 boolean NOT NULL DEFAULT false,
  status                  text NOT NULL DEFAULT 'pendente'
                          CHECK (status IN ('pendente', 'processando', 'sucesso', 'erro')),
  erro_msg                text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transferencias_status ON siso_transferencias(status);
CREATE INDEX idx_transferencias_empresa_o ON siso_transferencias(empresa_origem_id);
CREATE INDEX idx_transferencias_empresa_d ON siso_transferencias(empresa_destino_id);
CREATE INDEX idx_transferencias_usuario ON siso_transferencias(usuario_id);
CREATE INDEX idx_transferencia_itens_tr ON siso_transferencia_itens(transferencia_id);
```

### 9.2 Contratos de API — Request/Response Exatos

#### POST /api/inventario (criar sessão)
```typescript
// Request
{ empresa_id: string, modo: "loc_only" | "loc_estoque", tipo_estoque?: "B" | "E" | "S", manter_localizacao_antiga?: boolean, observacoes?: string }

// Response 201
{ id: string, empresa_id: string, galpao_id: string, deposito_id: number, modo: string, status: "em_andamento" }

// Response 400
{ error: "Depósito não configurado para esta empresa" }
{ error: "empresa_id é obrigatório" }
{ error: "modo é obrigatório" }
{ error: "tipo_estoque obrigatório quando modo = loc_estoque" }
```

#### GET /api/inventario (listar)
```typescript
// Query params: ?status=em_andamento|concluido (opcional)
// Response 200
{ inventarios: Array<{
  id: string, empresa_id: string, galpao_id: string, usuario_id: string,
  modo: string, tipo_estoque: string | null, status: string,
  total_itens: number,   // COUNT(*) de siso_inventario_itens
  itens_sucesso: number, // COUNT(*) WHERE status='sucesso'
  itens_erro: number,    // COUNT(*) WHERE status='erro'
  observacoes: string | null, created_at: string, concluido_em: string | null,
  empresa: { nome: string }, galpao: { nome: string }, usuario: { nome: string }
}> }
```

#### POST /api/inventario/[id]/coletar
```typescript
// Request
{ codigo: string, localizacao: string, quantidade?: number }

// Response 201 (produto encontrado)
{
  item: { id: string, sku: string, nome_produto: string, ean: string | null, localizacao: string, quantidade: number, produto_id_tiny: number },
  ja_escaneado: boolean,
  localizacoes_anteriores: string[] | null,  // ["C-01-5 (×2)", "D-03-1 (×1)"]
  total_itens: number  // contagem atualizada
}

// Response 404
{ error: "Produto não encontrado no Tiny" }
// Response 403
{ error: "Apenas o criador pode modificar este inventário" }
// Response 400
{ error: "Inventário não está em andamento" }
{ error: "Localização é obrigatória" }
```

#### PATCH /api/inventario/[id]/itens/[itemId]
```typescript
// Request
{ quantidade: number }
// Response 200
{ item: { id: string, quantidade: number }, total_itens: number }
// Response 403
{ error: "Apenas o criador pode modificar este inventário" }
```

#### DELETE /api/inventario/[id]/itens/[itemId]
```typescript
// Response 200
{ ok: true, total_itens: number }
// Response 403
{ error: "Apenas o criador pode modificar este inventário" }
```

#### POST /api/inventario/[id]/processar
```typescript
// Request: vazio
// Response 200 (imediato, fire-and-forget)
{ ok: true, message: "Processamento iniciado" }
// Response 400
{ error: "Inventário não tem itens para processar" }
{ error: "Inventário não está em andamento" }
```

#### GET /api/inventario/[id]/progresso
```typescript
// Response 200
{
  status: string,  // "processando" | "concluido" | "erro" | "revertendo" | "revertido"
  total: number,
  processados: number,
  sucesso: number,
  erro: number,
  itens: Array<{
    sku: string,
    nome_produto: string | null,
    quantidade_total: number,
    localizacoes: string,
    status: "pendente" | "processando" | "sucesso" | "erro",
    erro_msg: string | null
  }>
}
```

#### POST /api/inventario/[id]/reverter
```typescript
// Response 200 (imediato, fire-and-forget)
{ ok: true, message: "Reversão iniciada" }
// Response 400
{ error: "Inventário não está concluído" }
```

#### POST /api/transferencia/[id]/coletar
```typescript
// Request
{ codigo: string, quantidade?: number }
// Response 201
{
  item: { id: string, sku: string, nome_produto: string, ean: string | null, quantidade: number, produto_id_tiny_origem: number },
  total_itens: number
}
// Response 404
{ error: "Produto não encontrado na empresa de origem" }
```

#### POST /api/etiquetas-endereco/preview
```typescript
// Request
{ corredor_inicio: string, corredor_fim: string, horizontal_inicio: number, horizontal_fim: number, vertical_inicio: number, vertical_fim: number }
// Response 200
{ enderecos: string[], total: number, total_labels: number }
```

#### POST /api/etiquetas-endereco/imprimir
```typescript
// Request
{ corredor_inicio: string, corredor_fim: string, horizontal_inicio: number, horizontal_fim: number, vertical_inicio: number, vertical_fim: number, tipo: "pequena" | "grande", printer_id?: number }
// Response 200
{ ok: true, job_id: number, total_labels: number }
// Response 400
{ error: "Nenhuma impressora configurada" }
```

### 9.3 Algoritmos Críticos

#### Consolidação de itens (inventário → processamento)
```
Input:  itens[] com {sku, quantidade, localizacao, produto_id_tiny}
Output: consolidados[] com {sku, quantidade_total, localizacoes, produto_id_tiny, itens_ids[]}

1. Agrupar itens por SKU (case-insensitive: UPPER(sku))
2. Para cada grupo:
   - quantidade_total = SUM(quantidade)
   - localizacoes = UNIQUE(localizacao).sort().join("; ")
   - produto_id_tiny = primeiro item do grupo (todos devem ser iguais)
   - itens_ids = todos os IDs do grupo
```

#### Merge de localização (opção "Manter localização antiga")
```
Input:  localizacao_nova (do inventário), localizacao_antiga (do Tiny)
Output: localizacao_final

1. Se manter_localizacao_antiga = false: return localizacao_nova
2. Se localizacao_antiga é null/vazia: return localizacao_nova
3. Split ambas por "; " → arrays
4. Merge: [...locs_antigas, ...locs_novas]
5. Deduplica (Set)
6. Sort naturalmente
7. Join com "; "
```

#### Obter saldo anterior (para reversão de Balanço)
```
Antes de chamar movimentarEstoque(tipo:"B"):
1. getEstoque(token, produtoId) → depositos[]
2. Encontrar depósito com id === deposito_id do inventário
3. saldo_anterior = deposito.saldo (ou 0 se não encontrar)
4. Salvar em siso_inventario_itens.saldo_anterior_tiny
```

#### Clonagem de produto (transferência)
```
1. Na empresa ORIGEM, buscar dados completos:
   - buscarProdutoPorSku(tokenOrigem, sku) → {id, codigo, descricao}
   - getProdutoDetalhe(tokenOrigem, id) → {tipo, gtin}
   - GET /produtos/{id} → dados completos (nome, preco, unidade, ncm, etc.)

2. Na empresa DESTINO, criar:
   criarProduto(tokenDestino, {
     nome: produto.descricao,   // campo 'nome' é obrigatório
     preco: produto.preco || 0.01,
     sku: produto.codigo,
     gtin: detalhe.gtin,
     unidade: produto.unidade || "UN",
     ncm: produto.ncm,
     origem: produto.origem,
     tipo: "produto",
   })

3. Retorno: {id: number} → salvar como produto_id_tiny_destino
```

### 9.4 Arquivos a Criar (completo)

```
supabase/migrations/20260323_modulo_inventario_transferencia.sql

src/lib/inventario-processor.ts       # consolidarItens() + processarInventario() + reverterInventario()
src/lib/transferencia-processor.ts    # processarTransferencia() + reverterTransferencia()
src/lib/zpl-endereco.ts               # gerarEnderecos() + gerarZplPequena() + gerarZplGrande() + getCorridorRange()

src/app/inventario/page.tsx
src/app/transferencias/page.tsx
src/app/etiquetas/page.tsx

src/app/api/inventario/route.ts                           # GET lista + POST criar
src/app/api/inventario/[id]/route.ts                      # GET detalhe + PATCH cancelar
src/app/api/inventario/[id]/coletar/route.ts              # POST escanear
src/app/api/inventario/[id]/itens/[itemId]/route.ts       # PATCH qty + DELETE
src/app/api/inventario/[id]/processar/route.ts            # POST fire-and-forget
src/app/api/inventario/[id]/progresso/route.ts            # GET poll
src/app/api/inventario/[id]/reverter/route.ts             # POST fire-and-forget

src/app/api/transferencia/route.ts                        # GET lista + POST criar
src/app/api/transferencia/[id]/route.ts                   # GET detalhe + PATCH cancelar
src/app/api/transferencia/[id]/coletar/route.ts           # POST escanear
src/app/api/transferencia/[id]/itens/[itemId]/route.ts    # PATCH qty + DELETE
src/app/api/transferencia/[id]/processar/route.ts         # POST fire-and-forget
src/app/api/transferencia/[id]/progresso/route.ts         # GET poll
src/app/api/transferencia/[id]/reverter/route.ts          # POST fire-and-forget

src/app/api/etiquetas-endereco/preview/route.ts           # POST preview
src/app/api/etiquetas-endereco/imprimir/route.ts          # POST imprimir

src/components/inventario/criar-inventario-form.tsx
src/components/inventario/scan-inventario.tsx
src/components/inventario/inventario-card.tsx
src/components/inventario/progresso-processamento.tsx

src/components/transferencia/criar-transferencia-form.tsx
src/components/transferencia/scan-transferencia.tsx
src/components/transferencia/transferencia-card.tsx

src/components/etiquetas/etiqueta-endereco-form.tsx
src/components/etiquetas/endereco-preview.tsx
```

### 9.5 Arquivos a Modificar

| Arquivo | Mudança exata |
|---|---|
| `src/types/index.ts` | Adicionar: `InventarioModo`, `TipoEstoque`, `InventarioStatus`, `InventarioItemStatus`, `Inventario`, `InventarioItem`, `InventarioItemConsolidado`, `TransferenciaStatus`, `Transferencia`, `TransferenciaItem` |
| `src/lib/tiny-api.ts` | Adicionar: `buscarProdutoPorGtin()`, `criarProduto()`, tipo `TinyProdutoCriacao` |
| `src/components/separacao/audio-feedback.ts` | Adicionar: `playDuplicate()` — dois beeps 880Hz 100ms com 150ms gap |
| `src/app/page.tsx` | Adicionar 3 entries no array `MODULES`: inventario, transferencias, etiquetas |
| `src/app/api/dashboard/counts/route.ts` | Adicionar queries COUNT para inventarios e transferencias em_andamento |
| `docs/api-reference.md` | Documentar todas as rotas novas |
| `CLAUDE.md` | Atualizar Project Structure + Database Tables |
| `erros-conhecidos.yaml` | Adicionar entries para erros encontrados durante implementação |

### 9.6 Padrões de Código a Seguir

**React Query keys:**
```typescript
["inventarios", galpaoId ?? "all"]           // lista
["inventario", id]                           // detalhe
["inventario-progresso", id]                 // poll
["transferencias", galpaoId ?? "all"]        // lista
["transferencia", id]                        // detalhe
```

**sisoFetch (não fetch direto):**
```typescript
const res = await sisoFetch("/api/inventario", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ empresa_id, modo, tipo_estoque }),
});
```

**Polling no progresso (useQuery):**
```typescript
const { data } = useQuery({
  queryKey: ["inventario-progresso", inventarioId],
  queryFn: () => sisoFetch(`/api/inventario/${inventarioId}/progresso`).then(r => r.json()),
  refetchInterval: status === "processando" || status === "revertendo" ? 2000 : false,
  enabled: !!inventarioId,
});
```

**Logger nas API routes:**
```typescript
logger.info("inventario", `Inventário ${id} criado`, { empresaId, modo });
logger.logError({ error, source: "inventario", message: "Falha ao processar", category: "external_api", empresaId });
```

## 10. Non-Goals (atualizado)

- **Deletar produtos clonados na reversão:** Se produto foi clonado no destino durante transferência, reversão NÃO deleta o produto (pode já ter sido usado em pedidos), apenas reverte o saldo
