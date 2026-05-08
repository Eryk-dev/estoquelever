# WMS — Decisões consolidadas (2026-05-08)

Decisões tomadas via formulário pré-implementação, organizadas por tema.
Onde aplicado em planos específicos, está marcado.

---

## A — Acesso e pessoas

| # | Decisão | Aplicado em |
|---|---|---|
| A1 | **Só admin (você) testa staging** durante construção. Time entra depois. | Plano 1 Setup 0.3 — só copiar usuários ativos do tipo admin |
| A2 | **Só você é supervisor_logistica** inicialmente. | Plano 1 Setup 0.3 — definir cargo manualmente |
| A3 | **Você treina cada operador pessoalmente** após Fase 0 completa. | Política operacional pós-Fase 0 |
| A4 | **URL staging pública** (qualquer um com link entra). | Plano 1 Setup 0.2 — sem restrições adicionais |

---

## B — Cadastros e dados iniciais

| # | Decisão | Aplicado em |
|---|---|---|
| B1 | **Auto-criar fornecedores a partir de prefixos SKU** (`sku-fornecedor.ts`). | Plano 3 Task 2 — ver atualização abaixo |
| B2 | **Sem curva ABC pré-existente; calcular auto via giro 30d.** Top 20% = A (mensal), 30% = B (trimestral), resto = C (semestral). | Plano 4 — métricas de cycle count |
| B3 | **Snapshot inicial sábado ou domingo** (zero interferência). | Plano 1 Task 11 / Setup operacional |
| D2 | **Lead times preenchidos manualmente** pelo user (não documentado em planilha). | Plano 3 Task 3 — UI permite cadastro item por item |

---

## C — Defaults de inventário

| # | Decisão | Aplicado em |
|---|---|---|
| C1 | **Tolerância default 2%** em sessões de cycle count. | Plano 4 Task 2 — `tolerancia_pct: 2` no UI ao criar |
| C2 | **R$ 1.000 valor financeiro** que força aprovação manual. | Plano 4 Task 2 — `exige_aprovacao_acima_valor: 1000` |
| C3 | **Modo "blind" como default.** Operador não vê saldo esperado. | Plano 4 Task 2 — `modo_contagem: "blind"` |
| C4 | **4-6 operadores em paralelo** em inventário completo. | Plano 4 Task 6 — UI suporta dividir em até 6 áreas |
| C5 | **Janela de inventário completo: caso a caso.** Sem janela fixa. | Política operacional |

---

## D — Operação

| # | Decisão | Aplicado em |
|---|---|---|
| D1 | **Etiquetas Code 128 (barcode 1D)** + scanner USB/Bluetooth. | Tudo que envolve scan: Plano 1 receber, Plano 4 contar, Plano 5 troca SKU |
| D3 | **Sem notificações em v1.** Só dashboard, refresh 30s. | Plano 5 Task 9 — sem email/push em v1 |
| F2 | **Criar localização "QUARENTENA" em cada galpão** automaticamente. | Plano 5 Task 1 — adicionar à migration |

---

## E — Empréstimos e custos

| # | Decisão | Aplicado em |
|---|---|---|
| E1 | **Tela simples de limite por produto+par** em v1 (+0.5 sem ao Plano 3). | Plano 3 Task 6 — adicionar UI |
| E2 | **Custo médio na NF de empréstimo = custo médio da credora** (estoque que está saindo). | Plano 3 documentação + execution-worker quando integrar |
| F1 | **Devolução íntegra recalcula custo médio** como entrada nova (média ponderada). | Plano 5 Task 2 — chamar `recalcularCustoMedio` em classificação A |

---

## G — Validação e checkpoints

| # | Decisão | Aplicado em |
|---|---|---|
| G1 | **3-5 dias entre fim de um plano e aprovação do próximo.** | Política operacional |
| G2 | **Critério funcional decidido conforme cada plano termina** (sem checklist fixo agora). | Cada checkpoint definido in-flight |
| G3 | **Sem agenda fixa de testes**; conforme demanda. | Política operacional |
| G4 | **Critério "go" pra Fase 1: a decidir** quando Fase 0 estiver completa. | Pendente — revisitar pós Plano 5 |

---

## H — Comunicação externa

| # | Decisão | Aplicado em |
|---|---|---|
| H1 | **Marketplaces: a decidir** quando chegar perto da Fase 3. | Pendente — revisitar pós Fase 0 |

---

## Pontos pendentes (a decidir depois)

Itens marcados "a decidir" — não bloqueiam Fase 0, são revisitados quando relevante:

1. **G4** — critério go/no-go pra Fase 1 (definir após Plano 5 entregue)
2. **H1** — comunicação com marketplaces (definir antes de Fase 3)
3. **Custo médio em empréstimo** — validar com contador antes de Fase 3 prod (E2 staging usa custo da credora; pode mudar)
4. **Fechamento contábil mensal SPED Bloco H** — ainda em v2; revisitar se compliance virar pressão

---

## Decisões com impacto direto nos planos

Decisões que alteram tarefas existentes nos planos. Mudanças aplicadas em commits separados.

### Plano 1 — Foundation
- **Sem mudança no schema**, mas Setup de staging atualizado pra refletir A1, A2, A4.
- Snapshot inicial agendado pra fim de semana (B3) — atualizar critério de saída.

### Plano 3 — Roteamento
- **Task 2 (Service de fornecedores)**: adicionar função `autoCriarFornecedoresDosPrefixosSku()` que lê `sku-fornecedor.ts` e popula `siso_fornecedores`.
- **Task 6 (APIs e tela de empréstimos)**: adicionar UI de limite por par+produto. +0.5 sem na estimativa.

### Plano 4 — Inventário
- **Task 6 (Tela criar sessão)**: defaults pré-preenchidos: `tolerancia_pct=2`, `exige_aprovacao_acima_valor=1000`, `modo_contagem="blind"`.
- **Métricas (Task 10)**: adicionar query de classificação ABC dinâmica via giro 30d.

### Plano 5 — Exceções
- **Task 1 (migration)**: adicionar criação automática de localização tipo `quarentena` em cada galpão.
- **Task 2 (devoluções)**: classificação `integro` chama `recalcularCustoMedio` (F1).

---

**Última atualização:** 2026-05-08 — todas as 22 perguntas decisórias respondidas.
