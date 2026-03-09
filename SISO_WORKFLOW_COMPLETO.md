# SISO - Sistema Inteligente de Separação de Ordens
## Documento de Referencia para LLM - Fluxo Completo do Workflow n8n

---

## VISAO GERAL

O workflow **NETAIR_PROC_pedidos_multi_filial_v2** e um sistema automatizado de processamento de pedidos multi-filial que roda no n8n. Ele recebe webhooks do Tiny ERP quando pedidos sao aprovados, verifica estoque entre duas filiais (Curitiba e Sao Paulo), e decide automaticamente qual filial atende o pedido, gerando nota fiscal e ajustando estoques conforme necessario.

### Empresas/Filiais Envolvidas

| Filial | CNPJ | Conta Tiny | Abreviacao |
|--------|------|------------|------------|
| Curitiba | 34857388000163 | Tiny NetAir | CWB |
| Sao Paulo | 34857388000244 | Tiny NetParts | SP |

### Sistemas Integrados
- **Tiny ERP** (api.tiny.com.br/public-api/v3) - ERP principal, duas contas separadas
- **Redis** - Fila de processamento de webhooks
- **Slack** - Notificacoes no canal #vendas (C07F6QL1T8Q)
- **Google Sheets** - Planilha "OC Automatica" para ordens de compra (atualmente desabilitado)

---

## FASE 1: INGESTAO DO WEBHOOK

### Trigger: Webhook do Tiny ERP
O Tiny ERP envia um POST quando um pedido e atualizado (tipo: `atualizacao_pedido`, situacao: `aprovado`).

**Payload recebido:**
```json
{
  "versao": "1.0.1",
  "cnpj": "34857388000163",       // Identifica qual filial gerou o pedido
  "tipo": "atualizacao_pedido",
  "dados": {
    "id": "1039996865",            // ID do pedido no Tiny
    "numero": "90892",
    "data": "26/06/2025",
    "idPedidoEcommerce": "S45078434921",
    "codigoSituacao": "aprovado",
    "descricaoSituacao": "Aprovado",
    "idContato": "1005868129",
    "nomeEcommerce": "Mercado Livre",
    "cliente": {
      "nome": "Leonardo Silva dos Santos",
      "cpfCnpj": "038.913.755-30"
    },
    "formaEnvio": {
      "id": "653744837",
      "descricao": "Mercado Envios"
    }
  }
}
```

### Fluxo de Ingestao:
```
Webhook (POST) → Add to Queue1 (Redis PUSH em "webhook_queue") → Webhook Response1 (responde "queued")
```

O webhook e imediatamente enfileirado no Redis e a resposta e retornada ao Tiny. Isso evita timeout e garante que o Tiny nao reenvie o webhook.

---

## FASE 2: PROCESSAMENTO DA FILA

### Polling a cada 15 segundos:
```
Queue Processor (Cron */15s) → Get from Queue1 (Redis POP) → Queue Not Empty?1 → Parse Webhook Data1
```

- O cron roda a cada 15 segundos
- Faz POP na fila Redis `webhook_queue`
- Se a fila estiver vazia, para aqui
- Se houver dados, faz parse do JSON e encaminha para roteamento

---

## FASE 3: ROTEAMENTO POR EMPRESA (CNPJ)

### Node: Route by Company1 (Switch)

Com base no campo `cnpj` do webhook:

| CNPJ | Saida | Filial | Proxima etapa |
|------|-------|--------|---------------|
| 34857388000163 | CWB | Curitiba / NetAir | Consulta pedido CWB1 |
| 34857388000244 | SP | Sao Paulo / NetParts | Consulta pedido SP1 |

---

## FASE 4A: FLUXO CWB (PEDIDO ENTROU NA NETAIR)

### Passo 1: Consultar detalhes do pedido
```
Consulta pedido CWB1 → GET /pedidos/{id} na conta Tiny NetAir
```
Retorna detalhes completos incluindo array `itens` com produtos, quantidades, SKUs.

### Passo 2: Separar itens do pedido
```
Split Out3 → Separa cada item do array "itens" em execucoes individuais
```

### Passo 3: Verificar estoque na propria filial CWB
```
Consulta estoque PD CWB1 → GET /estoque/{produto.id} na conta Tiny NetAir
```
Verifica `depositos[1].saldo` (deposito principal CWB).

### Passo 4: Decisao - Estoque CWB Atende?
Compara: `depositos[1].saldo >= quantidade pedida`

---

### CENARIO A: CWB TEM ESTOQUE (caminho feliz)

```
Estoque CWB Atende? [SIM]
  → Wait (2s)
  → Inserir marcador CWB1          // POST marcador "CWB" no pedido
  → Wait4 (2s)
  → Gerar Produto com estoque CWB1 // POST /pedidos/{id}/gerar-nota-fiscal
  → Send a message (Slack)         // Notificacao: "Nova Venda NETAIR"
  → Get Queue Stats1 → Update Stats1 → Save Queue Stats1
```

**Mensagem Slack:**
```
> Nova Venda NETAIR:
> PRODUTO: {descricao}
> SKU: {sku}
> CONTA: {nomeEcommerce}
> VALOR: R${valorUnitario}
> ESTOQUE (CWB): {saldo}
```

---

### CENARIO B: CWB NAO TEM ESTOQUE → VERIFICAR SP

```
Estoque CWB Atende? [NAO]
  → Wait1 (2s)
  → Obtenção id filial1    // Busca o mesmo produto na conta Tiny NetParts (SP) pelo SKU
  → Consulta estoque SP Suporte1  // GET /estoque/{id} na conta NetParts
  → Filial SP atende o pedido?1   // depositos[0].saldo >= quantidade?
```

#### CENARIO B1: SP TEM ESTOQUE → TRANSFERENCIA INTER-FILIAL

```
Filial SP atende? [SIM]
  → Inserir marcador CWB Filial suporte atende1  // Marcador "CWB" no pedido NetAir
  → Gerar NF3                                      // Gera NF no pedido CWB (NetAir)
  → Estorno estoque em CWB1                        // Entrada (tipo "E") no estoque CWB
                                                    // Obs: "Estorno pedido X, Atendido por SP"
  → Saída estoque SP1                              // Saida (tipo "S") no estoque SP (NetParts)
                                                    // Obs: "Saída para atender pedido X, CWB"
  → Send a message1 (Slack)
```

**Logica de estoque na transferencia:**
1. O pedido entrou em CWB mas CWB nao tem estoque
2. Gera NF em CWB mesmo assim (a NF sai de CWB)
3. ESTORNA o estoque que o Tiny baixou automaticamente em CWB (entrada tipo "E")
4. BAIXA o estoque em SP que realmente tem o produto (saida tipo "S")

**Mensagem Slack:**
```
> Nova Venda NETAIR:
> PRODUTO: {descricao}
> SKU: {sku}
> CONTA: {nomeEcommerce}
> VALOR: R${valorUnitario}
> ESTOQUE (CWB): {saldo}
> ESTOQUE (SP): {saldo}
> ATENDIDO PELA FILIAL SAO PAULO
```

#### CENARIO B2: SP TAMBEM NAO TEM → ORDEM DE COMPRA

```
Filial SP atende? [NAO]
  → Inserir marcador CWB Sem estoque1  // Marcador de OC baseado no SKU
  → Gerar NF                           // Gera NF mesmo assim
  → Adicionar a Ordem de compra2       // Google Sheets (DESABILITADO)
  → Send a message2 (Slack)
```

**Mensagem Slack:**
```
> Nova Venda NETAIR:
> PRODUTO / SKU / CONTA / VALOR / ESTOQUE (CWB) / ESTOQUE (SP)
> CAIU PARA ORDEM DE COMPRA
```

---

## FASE 4B: FLUXO SP (PEDIDO ENTROU NA NETPARTS)

### Passo 1: Consultar detalhes do pedido
```
Consulta pedido SP1 → GET /pedidos/{id} na conta Tiny NetParts
```

### Passo 2: Separar itens
```
Split Out2 → Separa itens individualmente
```

### Passo 3: Verificar estoque na propria filial SP
```
Consulta estoque PD SP1 → GET /estoque/{produto.id} na conta Tiny NetParts
```
Verifica `depositos[0].saldo` (deposito principal SP).

### Passo 4: Decisao - Estoque SP Atende?
Compara: `depositos[0].saldo >= quantidade pedida`

---

### CENARIO A: SP TEM ESTOQUE (caminho feliz)

```
Estoque SP atende? [SIM]
  → Wait2 (2s)
  → Inserir marcador SP1              // POST marcador "SP" no pedido
  → Wait5 (2s)
  → Gerar Produto com estoque SP1     // POST /pedidos/{id}/gerar-nota-fiscal
  → Send a message5 (Slack)           // Notificacao: "Nova Venda NETPARTS"
  → Get Queue Stats1 → Update Stats1 → Save Queue Stats1
```

**Mensagem Slack:**
```
> Nova Venda NETPARTS:
> PRODUTO: {descricao}
> SKU: {sku}
> CONTA: {nomeEcommerce}
> VALOR: R${valorUnitario}
> ESTOQUE (CWB): {saldo}
```

---

### CENARIO B: SP NAO TEM ESTOQUE → VERIFICAR CWB

```
Estoque SP atende? [NAO]
  → Wait3 (2s)
  → Obtenção id CWB1           // Busca produto na conta Tiny NetAir (CWB) pelo SKU
  → Wait6 (2s)
  → Consulta estoque CWB Suporte1  // GET /estoque/{id} na conta NetAir
  → Filial CWB atende o pedido?1   // depositos[1].saldo >= quantidade?
```

#### CENARIO B1: CWB TEM ESTOQUE → TRANSFERENCIA INTER-FILIAL

```
Filial CWB atende? [SIM]
  → Inserir marcador SP Filial suporte atende1  // Marcador "CWB" no pedido NetParts
  → Gerar NF7                                    // Gera NF no pedido SP (NetParts)
  → Estorno estoque em SP1                       // Entrada (tipo "E") no estoque SP
                                                  // Obs: "Estorno pedido X, Atendido por CWB"
  → Saída estoque CWB1                           // Saida (tipo "S") no estoque CWB (NetAir)
                                                  // Obs: "Saída para atender pedido X, SP"
  → Send a message3 (Slack)
```

**Mensagem Slack:**
```
> Nova Venda NETPARTS:
> PRODUTO / SKU / CONTA / VALOR / ESTOQUE (CWB) / ESTOQUE (SP)
> ATENDIDO PELA FILIAL DE CURITIBA
```

#### CENARIO B2: CWB TAMBEM NAO TEM → ORDEM DE COMPRA

```
Filial CWB atende? [NAO]
  → Inserir marcador SP Sem estoque1  // Marcador de OC baseado no SKU
  → Gerar NF6                         // Gera NF mesmo assim
  → Adicionar a Ordem de compra3      // Google Sheets (DESABILITADO)
  → Send a message4 (Slack)
```

**Mensagem Slack:**
```
> Nova Venda NETPARTS:
> PRODUTO / SKU / CONTA / VALOR / ESTOQUE (CWB) / ESTOQUE (SP)
> CAIU PARA ORDEM DE COMPRA
```

---

## MAPEAMENTO SKU → FORNECEDOR (Marcadores de Ordem de Compra)

Quando nenhuma filial tem estoque, o sistema insere marcadores no pedido indicando o fornecedor para compra, baseado no prefixo do SKU:

| Prefixo SKU | Fornecedor | Marcador |
|-------------|------------|----------|
| `19*` | Diversos | `OC Diversos` |
| `LD*` | LDRU | `OC LDRU` + `SP` |
| `TH*` | Tiger | `OC Tiger` + `SP` |
| `L0*` | LEFS | `OC LEFS` + `SP` |
| 6 caracteres | ACA | `OC ACA` + `CWB` |
| `G*` | GAUSS | `OC GAUSS` + `CWB` |
| `M*` | MRMK | `OC MRMK` + `SP` |
| `CAK*` | Delphi | `OC Delphi` + `SP` |
| `CS*` | Delphi | `OC Delphi` + `SP` |
| Outro | - | `Verificar SKU` |

O segundo marcador (CWB ou SP) indica qual filial normalmente recebe mercadoria desse fornecedor.

---

## FASE 5: ESTATISTICAS DE PROCESSAMENTO

Apos cada notificacao Slack (sucesso ou erro):
```
Send a message* → Get Queue Stats1 (Redis GET "queue_stats")
  → Update Stats1 (incrementa processed ou errors)
  → Save Queue Stats1 (Redis SET "queue_stats")
```

Estrutura armazenada:
```json
{
  "processed": 123,
  "errors": 2,
  "lastProcessed": "2025-07-15T13:31:03.137Z"
}
```

---

## DIAGRAMA DE DECISAO SIMPLIFICADO

```
WEBHOOK RECEBIDO
  │
  ▼
ENFILEIRAR NO REDIS → RESPONDER "queued"
  │
  ▼
CRON (15s) → POP DA FILA
  │
  ▼
IDENTIFICAR FILIAL POR CNPJ
  │
  ├── CWB (NetAir) ──────────────────────── SP (NetParts)
  │      │                                       │
  ▼      ▼                                       ▼
  Consultar pedido CWB                   Consultar pedido SP
  Separar itens                          Separar itens
  Verificar estoque CWB                  Verificar estoque SP
  │                                       │
  ├── TEM ESTOQUE?                       ├── TEM ESTOQUE?
  │   │                                   │   │
  │   SIM → Marcador CWB                 │   SIM → Marcador SP
  │         Gerar NF                      │         Gerar NF
  │         Slack: "Venda CWB"            │         Slack: "Venda SP"
  │                                       │
  │   NAO → Buscar produto em SP          │   NAO → Buscar produto em CWB
  │         Verificar estoque SP           │         Verificar estoque CWB
  │         │                              │         │
  │         ├── SP TEM?                    │         ├── CWB TEM?
  │         │   SIM → Gerar NF CWB        │         │   SIM → Gerar NF SP
  │         │         Estornar CWB         │         │         Estornar SP
  │         │         Baixar SP            │         │         Baixar CWB
  │         │         Slack: "Atend. SP"   │         │         Slack: "Atend. CWB"
  │         │                              │         │
  │         │   NAO → Marcador OC          │         │   NAO → Marcador OC
  │         │         Gerar NF             │         │         Gerar NF
  │         │         Slack: "Ord.Compra"  │         │         Slack: "Ord.Compra"
```

---

## DETALHES TECNICOS IMPORTANTES

### Waits (2 segundos)
Ha nodes `Wait` de 2 segundos entre chamadas API consecutivas. Isso e necessario para respeitar rate limits da API do Tiny ERP e garantir que operacoes sequenciais (como marcar + gerar NF) nao conflitem.

### Indices de Deposito
- **CWB**: O saldo principal esta em `depositos[1]` (indice 1)
- **SP**: O saldo principal esta em `depositos[0]` (indice 0)

Isso e critico - os indices sao diferentes entre as filiais.

### Logica de Estorno/Transferencia
Quando uma filial atende pedido da outra:
1. A NF e gerada na filial onde o pedido entrou (porque o cliente comprou daquela empresa)
2. O Tiny automaticamente baixa estoque ao gerar NF
3. O sistema ESTORNA essa baixa (entrada "E") na filial que nao tem o produto
4. O sistema BAIXA o estoque (saida "S") na filial que realmente tem o produto
5. Resultado: o estoque fisico fica correto em ambas as filiais

### Marcadores
Marcadores sao tags visuais no Tiny ERP que indicam:
- `CWB` - Pedido atendido/processado por Curitiba
- `SP` - Pedido atendido/processado por Sao Paulo
- `OC {Fornecedor}` - Pedido sem estoque, necessita ordem de compra do fornecedor indicado

### Google Sheets (Desabilitado)
Os nodes "Adicionar a Ordem de compra" estao **desabilitados** (`disabled: true`). Quando ativados, registram na planilha "OC Automatica":
- ID Pedido, Nome Produto, SKU, Quantidade, Filial NF, ID Produto SP, ID Produto CWB, Fornecedor

### Batch Size
Todas as chamadas HTTP usam `batchSize: 1` para garantir processamento sequencial e evitar sobrecarga na API.

### Error Handling
- Slack messages tem `onError: "continueErrorOutput"` - erros nao travam o fluxo
- `Error Handler` node loga erros e respostas do Slack
- Existe um `errorWorkflow` configurado (ID: bpe1Vt20AiJmOYE2)

---

## APIS DO TINY UTILIZADAS

| Operacao | Metodo | Endpoint | Conta |
|----------|--------|----------|-------|
| Consultar pedido | GET | `/pedidos/{id}` | Varia |
| Consultar estoque | GET | `/estoque/{produtoId}` | Varia |
| Buscar produto por SKU | GET | `/produtos?codigo={sku}&situacao=A` | Varia |
| Gerar nota fiscal | POST | `/pedidos/{id}/gerar-nota-fiscal` | Varia |
| Inserir marcadores | POST | `/pedidos/{id}/marcadores` | Varia |
| Movimentar estoque | POST | `/estoque/{produtoId}` | Varia |

### Movimentacao de Estoque - Body:
```json
{
  "deposito": { "id": 123 },
  "tipo": "E",              // "E" = Entrada, "S" = Saida
  "quantidade": 1,
  "precoUnitario": 0,
  "observacoes": "Estorno pedido 90892, Atendido por SP"
}
```

---

## RESUMO DOS 3 DESFECHOS POSSIVEIS

1. **ATENDIDO PELA PROPRIA FILIAL** - Estoque disponivel na filial do pedido. Marcador da filial + NF gerada. Caminho mais simples.

2. **ATENDIDO PELA FILIAL DE SUPORTE** - Estoque indisponivel na filial do pedido, mas disponivel na outra. NF gerada na filial original, estoque ajustado entre filiais (estorno + saida). Marcador indica filial que realmente enviou.

3. **ORDEM DE COMPRA** - Nenhuma filial tem estoque. NF gerada mesmo assim, marcador indica fornecedor para reposicao baseado no SKU. Produto precisa ser comprado.
