# Fluxo de Separacao - Referencia Tiny ERP + Modelo SISO

## Objetivo

Documentar o fluxo completo de separacao do Tiny ERP (Olist) conforme screenshots de referencia, e mapear para o modelo SISO com o acrescimo do status "aguardando aprovacao da NF".

---

## 1. Fluxo do Tiny ERP (Referencia)

### 1.1 Tela Principal — Lista de Separacao

**URL:** `erp.olist.com/separacao`

**Abas (status):**
| Aba | Descricao |
|---|---|
| **Aguardando separacao** | Pedidos com NF autorizada, prontos para separar. Contagem: 162 |
| **Em separacao** | Operador abriu a lista e esta separando fisicamente |
| **Separadas** | Todos os itens conferidos, pronto para embalar. Contagem: 5 |
| **Embaladas checkout** | Pedidos embalados, prontos para expedicao. Contagem: 992 |

**Colunas da tabela:**
- Checkbox (selecao em lote)
- Identificacao (Nota N, N EC ecommerce, Pedido N)
- Destinatario (nome do cliente)
- UF / Cidade
- Forma de envio (Mercado Envios, Shopee Envios)
- Data do pedido
- Separacao % (progresso da separacao — 0% inicialmente)
- Data prevista de entrega
- Prazo maximo de despacho
- Marcadores (mercadoenvios coleta, 1a venda, etiqueta com data programada, cwb)
- Integracoes (icones de status: EX badge, bolinhas coloridas)

**Filtros disponíveis:**
- Busca por destinatario ou numero
- Envio para separacao: ultimos 7 dias
- Mais antigas (ordenacao)
- Por forma de envio
- Filtros avancados
- Limpar filtros

**Acoes em lote (topo direito):**
- "separar N pedidos" (CTRL+S) — disponivel na aba "Aguardando separacao"
- "embalar N pedidos" (CTRL+E) — disponivel na aba "Separadas"

---

### 1.2 Passo 1 — Iniciar Separacao (Aguardando → Em Separacao)

**Acao:** Operador clica em "separar N pedidos" (CTRL+S)

**Modal lateral "Separacao de mercadorias"** com 3 opcoes:

| Opcao | Descricao | Efeito no status |
|---|---|---|
| **Abrir lista de separacao** | Abre tela de checklist de produtos | → "em separacao" |
| **Imprimir lista de separacao** | Gera PDF impresso da lista | → "em separacao" |
| **Marcar como separado** | Pula a conferencia manual | → "separado" |

Botoes: "continuar" (CTRL+ENTER), "cancelar" (ESC)

**Comportamento:** Qualquer opcao escolhida move os pedidos selecionados de "aguardando separacao" para "em separacao" (exceto "marcar como separado" que pula direto).

---

### 1.3 Passo 2 — Separacao Fisica (Checklist de Produtos)

**URL:** `erp.olist.com/separacao` (tela de detalhe)

**Titulo:** "Separacao de mercadorias"

**Duas abas:**
- **produtos** (ativa por padrao) — lista consolidada de todos os itens
- **pedidos e notas** — visao agrupada por pedido/NF

**Tabela de produtos:**
| Coluna | Descricao |
|---|---|
| Checkbox | Operador marca ao encontrar o item na prateleira |
| Imagem | Foto do produto |
| Produto | Descricao do produto |
| Cod. (SKU/GTIN) | SKU principal + GTIN abaixo quando disponivel |
| Qtd | Quantidade pedida (ex: 1,0000 / 3,0000) |
| Un | Unidade (PC) |
| **Localizacao** | **Endereco fisico na prateleira (ex: E-20-7, B-13-4, B-09-1; G-04-3)** |

> **IMPORTANTE:** A coluna Localizacao e essencial para o operador encontrar o item no galpao. Formato tipico: CORREDOR-PRATELEIRA-POSICAO (ex: B-13-4 = Corredor B, Prateleira 13, Posicao 4). Alguns itens tem multiplas localizacoes separadas por ";" (ex: B-09-1; G-04-3).

**Fluxo do operador:**
1. Visualiza a lista de produtos no tablet
2. Vai fisicamente ate cada localizacao no galpao
3. Marca o checkbox de cada item conforme encontra
4. Os itens ficam com checkbox azul (marcado)

**Acoes no rodape:**
| Acao | Atalho | Descricao |
|---|---|---|
| **concluir** | CTRL+ENTER | Finaliza e move para "separadas" |
| **salvar para depois** | CTRL+E | Salva progresso parcial, mantem "em separacao" |
| **reiniciar progresso** | CTRL+M | Desmarca todos os itens |
| **cancelar** | ESC | Volta sem salvar |

---

### 1.4 Passo 3 — Concluir Separacao (Em Separacao → Separadas)

**Acao:** Operador clica "concluir"

**Modal lateral "Separacao":**
- Mensagem: "Apenas os pedidos e notas que possuem todos os itens marcados serao salvos como separados."
- Checkbox: "Marcar todos como separados"
- Botoes: "concluir", "cancelar"

**Regra:** So pedidos com TODOS os itens marcados sao movidos para "separadas". Pedidos com itens faltando permanecem "em separacao".

---

### 1.5 Passo 4 — Embalar (Separadas → Embaladas)

**Acao:** Na aba "separadas", operador clica "embalar N pedidos" (CTRL+E)

**Modal "Embalagem de mercadorias"** com 2 opcoes:

| Opcao | Descricao |
|---|---|
| **Embalar por pedido** | Conferencia pedido-a-pedido (manual) |
| **Embalar por produto** | Bipagem por SKU/GTIN — sistema identifica automaticamente qual pedido pertence |

Botoes: "continuar", "cancelar" (ESC)

---

### 1.6 Passo 4b — Embalagem por Produto (Bipagem)

**URL:** `erp.olist.com/separacao#list`
**Titulo:** "Embalagem de produtos"

**Interface:**
- Campo de busca: "Pesquise pela descricao, codigo (SKU) ou gtin" + campo Quantidade (opcional)
- Area "Ultimo item lido" — mostra foto e dados do ultimo item bipado
- Lista "Pedidos e notas fiscais" — mostra todos os pedidos com progresso

**Cada pedido na lista mostra:**
- Identificador (Nota N, N EC, Pedido N)
- Cliente
- Itens: "0/1" (progresso) + indicador de cor (amarelo = pendente, verde = completo)

**Quando o operador bipa um produto:**
- O sistema encontra o primeiro pedido que tem aquele item pendente
- Expande o pedido mostrando o item com: imagem, quantidade (-/+), descricao, codigo SKU
- O progresso atualiza (0/1 → 1/1)
- O indicador muda de amarelo para verde quando completo

**Acoes no topo:**
| Acao | Atalho | Descricao |
|---|---|---|
| **reiniciar progresso** | CTRL+V | Zera todas as bipagens |
| **salvar para depois** | CTRL+I | Salva parcial |
| **mais acoes** | — | Menu adicional |

---

### 1.7 Passo 5 — Expedicao (Embaladas → Expedidas)

**Acao:** Apos embalar, o sistema pergunta:

**Modal "Criar e concluir expedicoes":**
- Mensagem: "Deseja criar e concluir agrupamentos de expedicao para os pedidos a serem embalados?"
- Botoes: "continuar" (CTRL+ENTER), "deixar para depois" (ESC)

**O que acontece ao continuar:**
- O Tiny cria agrupamentos de expedicao (= gera etiquetas de envio)
- Pedidos movem para "embaladas checkout"
- Etiquetas ficam disponiveis para impressao

---

## 2. Modelo SISO — Fluxo Definitivo

### 2.1 Diferenca principal: Status "Aguardando NF"

No Tiny, o pedido ja chega na separacao com a NF autorizada. No SISO, o pedido chega ANTES da NF ser autorizada pelo SEFAZ, portanto temos um status extra no inicio.

### 2.2 Diagrama de Estados SISO

```
                    WEBHOOK TINY (pedido aprovado)
                           |
                           v
                   ┌───────────────┐
                   │ aguardando_nf │  NF emitida mas nao autorizada pelo SEFAZ
                   └───────┬───────┘
                           |
              (webhook NF autorizada, ou admin forca)
                           |
                           v
              ┌────────────────────────┐
              │ aguardando_separacao   │  NF emitida + autorizada
              │                        │  Pronto para separar fisicamente
              └────────────┬───────────┘
                           |
              (operador clica "Separar N pedidos" — abre checklist)
                           |
                           v
                   ┌───────────────┐
                   │ em_separacao   │  Operador com tablet no galpao
                   │                │  Marcando itens no checklist
                   │                │  Auto-save a cada checkbox
                   └───────┬───────┘
                           |
              (todos itens conferidos — concluir)
                           |
                           v
                   ┌───────────────┐
                   │   separado    │  Itens na bancada, pronto para embalar
                   └───────┬───────┘
                           |
              (bipagem/selecao manual — conferencia na bancada)
              (etiqueta impressa automaticamente ao completar pedido)
                           |
                           v
                   ┌───────────────┐
                   │   embalado    │  STATUS FINAL
                   │               │  Embalado + etiqueta impressa
                   └───────────────┘
```

> **`embalado` e o status final.** Nao existe status `expedido` neste fluxo.

### 2.3 Mapeamento de Status: Tiny → SISO

| Tiny ERP | SISO (atual) | SISO (novo) | Descricao |
|---|---|---|---|
| — | `aguardando_nf` | `aguardando_nf` | NF emitida, nao autorizada (exclusivo SISO) |
| Aguardando separacao | `pendente` | **`aguardando_separacao`** | NF autorizada, pronto para separar |
| Em separacao | `em_separacao` | `em_separacao` | Operador com tablet no galpao |
| Separadas | — | **`separado`** | Na bancada, pronto para embalar |
| Embaladas checkout | `embalado` | `embalado` | **STATUS FINAL** — embalado + etiqueta |
| ~~Expedido~~ | ~~`expedido`~~ | **removido** | Nao faz parte do fluxo de separacao |

> **Mudancas no schema:**
> 1. Renomear `pendente` → `aguardando_separacao`
> 2. Adicionar status `separado`
> 3. Remover `expedido` do fluxo de separacao (pode manter no CHECK constraint para compatibilidade, mas nao sera usado)

---

## 3. Decisoes de Produto (Respostas Validadas)

### 3.1 Operacao Fisica

**P: Quem faz o que?**
R: **A mesma pessoa separa E embala.** A separacao serve para criar uma "onda" — o operador anda pelo estoque com o tablet, pega os itens, e depois volta para a bancada para a etapa de embalagem (conferencia).

**P: Como funciona na pratica?**
R: Operador usa **tablet** (nunca papel impresso). Ele visualiza a lista de produtos no tablet, caminha pelo galpao pegando os itens, marca no checklist, volta pra bancada e faz a conferencia com bipagem/selecao manual no PC.

**P: Quantos pedidos por vez?**
R: **Geralmente todos de uma vez**, mas filtros sao essenciais:
- **Filtro por empresa de origem** (NetAir vs NetParts)
- **Ordenacao (sort):** por SKU, por nome do produto, ou por **localizacao** (mais usado para separacao em onda)

### 3.2 Checklist de Separacao

**P: Checkbox manual ou bip?**
R: **Ambos implementados**, mas o **checkbox sera o mais usado**. O bip tambem deve ser suportado como alternativa no checklist.

**P: Lista consolidada ou por pedido?**
R: **Consolidada em onda de produtos.** Todos os produtos de todos os pedidos selecionados numa lista unica. Produtos repetidos em multiplos pedidos aparecem consolidados (somar quantidades). **O operador NAO precisa ver de quais pedidos sao — so precisa saber o total a pegar.**

**P: Item nao encontrado na prateleira?**
R: **Pula o pedido inteiro.** Se qualquer item de um pedido nao e encontrado, o pedido inteiro permanece em "em_separacao" (nao vai para "separado"). O operador simplesmente nao marca o item e segue adiante.

**P: Marcar como separado sem checklist?**
R: **Nao. Checklist e obrigatorio.** Todos os pedidos DEVEM passar pelo checklist de separacao.

**P: Cancelar a separacao?**
R: **Pedidos voltam para `aguardando_separacao`.** Se o operador cancela o checklist sem salvar, os pedidos retornam ao estado anterior.

**P: Auto-save no checklist?**
R: **Sim. Cada checkbox salva imediatamente no banco.** Mudanca de aba ou queda de internet nao perde progresso. Ao reabrir, o operador ve tudo que ja marcou.

**P: Retomar checklist salvo?**
R: Aba "Em Separacao" mostra os pedidos com progresso salvo. O operador **reabre o mesmo checklist** com os itens ja marcados. Nao precisa "criar nova sessao" — e o mesmo checklist persistido.

### 3.3 Sessoes Simultaneas

**P: Multiplos operadores ao mesmo tempo?**
R: **Sim, deve suportar separacao simultanea.** Quando operador A seleciona pedidos e inicia separacao, esses pedidos movem para `em_separacao` e saem da lista de `aguardando_separacao`. Operador B so ve os pedidos restantes. Isso funciona naturalmente pelo status — pedidos em `em_separacao` nao aparecem na aba "Aguardando Separacao".

### 3.4 Embalagem

**P: Modo de embalagem?**
R: **Somente "embalar por produto".** Nao implementar "embalar por pedido".

**P: Bipagem ou selecao manual?**
R: **Ambos na mesma tela.** O operador pode bipar o codigo de barras OU clicar/selecionar manualmente o item na tela (botoes +/- de quantidade).

**P: Selecao de pedidos para embalar?**
R: **Padrao = embalar TODOS os separados.** Se o operador marcar checkboxes em pedidos especificos na aba "Separados", o botao muda para "Embalar X pedidos" (so os selecionados). Mesmo comportamento do Tiny.

**P: Comportamento do bip na embalagem?**
R: Ao bipar um SKU:
1. Sistema encontra o **pedido mais antigo** com aquele item pendente
2. Se o pedido tem **somente aquele item** → marca completo → **imprime etiqueta automaticamente**
3. Se o pedido tem **mais itens** → expande o pedido mostrando os itens faltantes
4. O operador pode **continuar bipando outros SKUs de outros pedidos** sem completar — o pedido fica como "parcialmente conferido"
5. Quando eventualmente TODOS os itens de um pedido ficam conferidos → **imprime etiqueta automaticamente**

**P: Status durante embalagem parcial?**
R: **Pedidos continuam como `separado` durante a embalagem.** Nao existe status intermediario `em_embalagem`. O progresso de bipagem e rastreado nos itens (`quantidade_bipada`), mas o status do pedido so muda para `embalado` quando 100% conferido.

**P: Intercalar pedidos?**
R: **Sim.** O operador nao precisa completar um pedido antes de bipar itens de outro. Pode intercalar livremente.

### 3.5 Etiqueta e NF

**P: O que imprime automaticamente?**
R: **Somente a etiqueta de envio.** DANFE nao imprime automaticamente.

**P: A NF ja esta emitida nesse ponto?**
R: **Sim.** A NF ja foi emitida E autorizada pelo SEFAZ. Se nao estivesse autorizada, o pedido estaria na aba "Aguardando NF".

### 3.6 Localizacao

**P: De onde vem o dado de localizacao?**
R: Coluna `localizacao` em `siso_pedido_item_estoques`, preenchida pelo webhook-processor a partir da API do Tiny.

### 3.7 Impressao de Lista

**P: Imprimir lista de separacao?**
R: **Nao.** Sempre tablet.

### 3.8 Integracao com Fluxo Existente

**P: O fluxo de aprovacao ja aconteceu?**
R: **Sim.** A separacao so trabalha com pedidos ja aprovados:
```
Webhook → Decisao (auto/manual) → Aprovado → [entra na separacao como aguardando_nf]
```

### 3.9 Status Final

**P: O fluxo termina em qual status?**
R: **`embalado` e o status final.** Nao existe etapa de expedicao no fluxo de separacao. O pedido esta embalado com etiqueta impressa — pronto para coleta da transportadora.

---

## 4. Telas SISO Definitivas

### 4.1 Lista Principal (`/separacao`)

**5 abas com contadores:**

| Aba | Status filtrados | Descricao |
|---|---|---|
| Aguardando NF | `aguardando_nf` | NF pendente autorizacao SEFAZ |
| Aguardando Separacao | `aguardando_separacao` | NF autorizada, pronto para separar |
| Em Separacao | `em_separacao` | Operador com tablet no galpao |
| Separados | `separado` | Na bancada, pronto para embalar |
| Embalados | `embalado` | **Status final** — embalado + etiqueta |

**Filtros (na aba Aguardando Separacao):**
- Filtro por empresa de origem (NetAir / NetParts)
- Ordenacao: por SKU, por nome, por localizacao
- Busca por destinatario ou numero

**Acoes por aba:**

| Aba | Acao principal |
|---|---|
| Aguardando NF | "Forcar pendente" (admin only) |
| Aguardando Separacao | **"Separar N pedidos"** → abre checklist |
| Em Separacao | Operador clica para retomar checklist salvo |
| Separados | **"Embalar N pedidos"** (todos ou selecionados) |
| Embalados | Somente visualizacao (status final) |

### 4.2 Checklist de Separacao em Onda (Tela Nova)

**Acesso:** Operador clica "Separar N pedidos" na aba "Aguardando Separacao"

**Comportamento:**
1. Pedidos selecionados movem para `em_separacao`
2. Abre tela de checklist com lista CONSOLIDADA de produtos

**Layout da lista consolidada:**
- Ordenacao padrao: por **localizacao** (operador caminha em sequencia)
- Opcoes de sort: localizacao, SKU, nome do produto
- Produtos repetidos em multiplos pedidos sao CONSOLIDADOS (quantidade total somada)
- O operador NAO ve de quais pedidos sao — so a quantidade total

| Coluna | Descricao |
|---|---|
| Checkbox | Marca ao encontrar na prateleira (checkbox ou bip) |
| Descricao | Nome do produto |
| SKU / GTIN | Codigo do produto + GTIN quando disponivel |
| Quantidade total | Soma de todas as quantidades pedidas daquele SKU |
| Localizacao | Endereco fisico no galpao |

**Campo de bip (opcional):** No topo, campo para escanear codigo de barras — marca automaticamente o item correspondente no checklist.

**Auto-save:** Cada checkbox salva imediatamente no banco. Sem botao "salvar" explicito. Queda de internet ou mudanca de aba nao perde progresso.

**Retomar:** Na aba "Em Separacao", operador reabre o mesmo checklist com itens ja marcados preservados.

**Acoes:**
- **Concluir** — Pedidos com 100% dos itens marcados → `separado`. Pedidos com QUALQUER item nao marcado ficam inteiros em `em_separacao`.
- **Reiniciar progresso** — Desmarca todos os checkboxes.
- **Cancelar** — **Pedidos voltam para `aguardando_separacao`.**

### 4.3 Embalagem por Produto (Tela Nova — conferencia na bancada)

**Acesso:** Na aba "Separados":
- **Padrao:** Clicar "Embalar N pedidos" → embala TODOS os separados do galpao
- **Seletivo:** Marcar checkboxes em pedidos especificos → botao muda para "Embalar X pedidos"

**Layout:**
- Campo de scan/busca: SKU, GTIN ou descricao
- Campo quantidade (opcional, default 1)
- "Ultimo item lido" — feedback visual
- Lista de pedidos com progresso individual

**Cada pedido mostra:**
- Nota N, N EC, N Pedido
- Cliente
- Progresso: "0/N itens" com indicador (amarelo = pendente, verde = completo)
- Expansivel: ao clicar ou bipar um item do pedido, expande mostrando detalhes + controles +/-

**Dois modos de conferencia (mesma tela):**
1. **Bipagem:** Escanear codigo de barras → sistema identifica pedido mais antigo com item pendente
2. **Selecao manual:** Clicar no pedido → expandir itens → usar botoes +/- para confirmar quantidade

**Comportamento detalhado do bip:**
1. Operador bipa SKU (ex: 001616)
2. Sistema encontra o **pedido mais antigo** que tem item 001616 pendente
3. **Se o pedido tem somente 1 item:** marca completo → `embalado` → **imprime etiqueta automaticamente**
4. **Se o pedido tem mais itens:** expande o pedido mostrando itens faltantes
5. Operador pode:
   - Bipar os outros itens do mesmo pedido para completa-lo
   - **OU bipar um SKU de OUTRO pedido** (intercalar) — o pedido anterior fica como "parcialmente conferido"
6. Quando TODOS os itens de qualquer pedido ficam completos → status `embalado` + **imprime etiqueta automaticamente** (fire-and-forget)

**Status durante embalagem:** Pedidos continuam como `separado`. So mudam para `embalado` quando 100% dos itens conferidos. Nao existe status intermediario.

**Impressao automatica:** Somente etiqueta de envio. DANFE nao imprime.

**Acoes:**
- **Salvar para depois** — Salva progresso parcial (pedidos continuam `separado`)
- **Reiniciar progresso** — Zera todas as bipagens/selecoes

---

## 5. Dados Essenciais por Etapa

### Aguardando NF
- Numero da NF, N EC, N Pedido
- Cliente, UF, Cidade
- Forma de envio
- Data do pedido
- Empresa origem
- DANFE pendente

### Aguardando Separacao
- Tudo acima +
- URL DANFE, chave de acesso NF
- Prazo maximo de despacho
- Marcadores (galpao, marketplace, etc.)

### Em Separacao
- Itens com: descricao, SKU, GTIN, quantidade, unidade, **localizacao**
- % progresso (itens marcados / total)
- Operador responsavel
- Timestamp inicio
- Progresso auto-saved a cada checkbox

### Separado
- Todos itens conferidos (100%)
- Timestamp conclusao separacao
- Pronto para embalagem

### Embalado (STATUS FINAL)
- Bipagem/selecao conferida (100%)
- Agrupamento de expedicao criado (Tiny)
- Etiqueta impressa automaticamente
- Timestamp embalagem

---

## 6. Integracao com Tiny API

### Acoes que disparam chamadas Tiny:

| Momento | Acao Tiny | Endpoint |
|---|---|---|
| Pedido completo na embalagem | Criar agrupamento de expedicao | `POST /expedicao/agrupamentos` |
| Apos criar agrupamento | Obter etiquetas | `GET /expedicao/agrupamentos/{id}/etiquetas` |
| Apos obter URL etiqueta | Enviar para PrintNode | (interno) |

### Acoes que NAO precisam de chamada Tiny:
- Transicao aguardando_nf → aguardando_separacao (via webhook NF)
- Checklist de separacao (dados ja no DB)
- Bipagem/selecao de embalagem (dados ja no DB)

---

## 7. Resumo das Mudancas Necessarias no SISO

### Schema (banco de dados)
1. Alterar CHECK constraint de `status_separacao`: adicionar `aguardando_separacao` e `separado`, remover `expedido`, renomear `pendente`
2. Valores validos: `aguardando_nf`, `aguardando_separacao`, `em_separacao`, `separado`, `embalado`, `cancelado`
3. Adicionar colunas no `siso_pedido_itens` para checklist de separacao:
   - `separacao_marcado` (boolean default false) — item marcado no checklist
   - `separacao_marcado_em` (timestamptz) — quando foi marcado
4. Reutilizar colunas de bipagem existentes (`quantidade_bipada`, `bipado_completo`, etc.) para etapa de EMBALAGEM
5. Resetar `quantidade_bipada` e `bipado_completo` ao iniciar embalagem (dados da separacao ficam em `separacao_marcado`)

### Backend (API)
1. **Novo:** `POST /api/separacao/iniciar` — recebe pedido_ids, move para em_separacao, retorna lista consolidada
2. **Novo:** `POST /api/separacao/marcar-item` — auto-save checkbox (marca/desmarca item no checklist)
3. **Novo:** `POST /api/separacao/bipar-checklist` — bip no checklist (marca automaticamente)
4. **Novo:** `POST /api/separacao/concluir-separacao` — move pedidos 100% marcados para separado
5. **Novo:** `POST /api/separacao/cancelar-separacao` — volta pedidos para aguardando_separacao
6. **Novo:** `POST /api/separacao/iniciar-embalagem` — recebe pedido_ids (ou todos separados do galpao)
7. **Refatorar:** `/api/separacao/bipar` — so funciona na EMBALAGEM (status = separado)
8. **Refatorar:** `/api/separacao/route.ts` — novos status + filtro por empresa + sort
9. **Remover:** `/api/separacao/expedir` — nao existe mais no fluxo

### Frontend
1. **5 abas** (Aguardando NF, Aguardando Separacao, Em Separacao, Separados, Embalados)
2. **Filtro por empresa de origem** na aba Aguardando Separacao
3. **Sort por localizacao/SKU/nome**
4. **Nova tela:** Checklist de separacao em onda (lista consolidada + checkbox + bip opcional + auto-save)
5. **Nova tela:** Embalagem por produto (bip + selecao manual com +/-, auto-print etiqueta, intercalar pedidos)
6. **Logica de selecao** na aba Separados: padrao embalar tudo, checkbox muda para seletivo
7. **Remover:** Aba Expedidos, endpoint/tela de expedicao

### PL/pgSQL
1. **Nova function:** `siso_consolidar_produtos_separacao` — consolida produtos de N pedidos, soma quantidades por SKU, retorna com localizacao
2. **Nova function:** `siso_processar_bip_embalagem` — versao do bip para embalagem (so aceita pedidos `separado`, imprime etiqueta ao completar)
3. **Deprecar:** `siso_processar_bip` atual (substituida pela nova)
