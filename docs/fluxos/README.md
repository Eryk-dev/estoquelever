# Fluxos do SISO — Índice

Cada documento desta pasta detalha um fluxo de negócio completo: entrada → estado → decisão → side effects → estado final, com referências de código (arquivo:linha), diagramas Mermaid, contratos de API, e tratamento de exceções.

## Convenção de leitura

| Símbolo | Significado |
|---|---|
| `→` | Transição de estado |
| `⚡` | Operação assíncrona (fire-and-forget) |
| `🔒` | Requer autenticação/role específica |
| `📡` | Chamada externa (Tiny / PrintNode) |
| `📝` | Side effect em DB |

## Mapa dos fluxos

| # | Documento | Cobertura |
|---|-----------|-----------|
| 01 | [01-webhook-pedido.md](01-webhook-pedido.md) | Webhook Tiny → identifica empresa por CNPJ → enriquece estoque multi-empresa → calcula sugestão → salva pedido. **Ponto de entrada** do sistema. |
| 02 | [02-webhook-nota-fiscal.md](02-webhook-nota-fiscal.md) | Webhook NF → reconcilia com pedido → transição `aguardando_nf` → `aguardando_separacao`. Trata NF que chega antes ou depois do pedido. |
| 03 | [03-aprovacao-decisao.md](03-aprovacao-decisao.md) | Painel `/siso` → operador aprova → enfileira execução. Auto-aprovação para `propria`. Lógica de decisão `propria`/`transferencia`/`oc`. |
| 04 | [04-execucao-worker.md](04-execucao-worker.md) | Execution worker → deduz estoque seguindo ordem de tier no grupo → trata 3 caminhos (`propria`/`transferencia`/`oc`) → atualiza status. |
| 05 | [05-separacao-wave-picking.md](05-separacao-wave-picking.md) | Separação `/separacao` + checklist → bipagem por código de barras → marcar item → concluir. Inclui Pick OC, encaminhar, cancelar, reiniciar, voltar etapa, tags, produto esgotado. |
| 06 | [06-embalagem-expedicao-etiquetas.md](06-embalagem-expedicao-etiquetas.md) | Embalagem (bipagem + confirmação) → expedição → impressão de etiqueta via PrintNode. Inclui agrupamento Tiny, retry, reimpressão, etiquetas-endereco. |
| 07 | [07-compras-v2.md](07-compras-v2.md) | Módulo de compras `/compras` (Comprar/Receber) → consolidação por fornecedor → exceções (indisponível, equivalente, cancelamento, devolver) → preparar-embalagem → release de execução. |
| 08 | [08-inventario-transferencia.md](08-inventario-transferencia.md) | Sessões de inventário (`/inventario`) e transferência inter-galpão (`/transferencias`) → bipagem → processamento via Tiny → reverter. |
| 09 | [09-auth-configuracao-hierarquia.md](09-auth-configuracao-hierarquia.md) | Login PIN, sessões, roles, filtragem por role. CRUD de Galpão/Empresa/Grupo, OAuth2 Tiny, PrintNode, usuários. |
| 10 | [10-dashboards-tracking-observabilidade.md](10-dashboards-tracking-observabilidade.md) | Painel operacional (Torre de Controle) e gerencial, `/pedidos` universal tracking, detalhe de pedido, histórico, observações, reconciliação, logging estruturado, erros conhecidos. |

## Fluxo macro

```mermaid
graph LR
    W[Webhook Tiny] --> P[Pedido com sugestão]
    P -->|Auto| E[Execução]
    P -->|Manual| A[Aprovação] --> E
    E -->|Própria/Transferência| S[Separação]
    E -->|OC| C[Compras] --> S
    S --> EM[Embalagem] --> EX[Expedição]
```

## Termos transversais

- **Galpão**: local físico (CWB, SP).
- **Empresa**: conta Tiny com CNPJ próprio (NetAir, NetParts).
- **Grupo**: agrupamento de afinidade de negócio (Autopeças). Empresas no mesmo grupo compartilham consulta de estoque.
- **Tier**: prioridade de dedução de estoque dentro do grupo. A empresa que recebeu o pedido sempre tem tier 1 em runtime.
- **Decisão** (`decisao`): `propria` | `transferencia` | `oc`.
- **Status do pedido**: `pendente` | `executando` | `concluido` | `cancelado` | `erro`.
- **Status de separação**: `aguardando_compra` | `aguardando_nf` | `aguardando_separacao` | `em_separacao` | `separado` | `embalado` | `expedido`.
