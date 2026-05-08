# Decisões do user — WMS Fase 0

Respostas dadas via Claude forms na revisão pré-implementação. Esse doc é referência cruzada pra todos os 5 planos.

---

## A) Acesso e pessoas

| Item | Decisão |
|---|---|
| Acesso staging | **Só você (admin)** testa pessoalmente |
| Cargo `supervisor_logistica` | **Só você** inicialmente |
| Treinamento do time | **Pessoalmente, cada operador** (você lidera) |
| URL staging | **Pública** (qualquer com link entra; badge STAGING basta) |

**Implicação prática:** menos pressão pra documentação massiva nas telas. Você valida sozinho na maior parte do tempo. Treinamento pessoal por operador acontece **depois** da Fase 0 validada por você.

---

## B) Cadastros iniciais

| Item | Decisão |
|---|---|
| Fornecedores (Plano 3) | **Auto-criar a partir de prefixos SKU** (`sku-fornecedor.ts` existente) |
| Curva ABC | **Calcular automaticamente pelo giro 30d** (top 20% = A, próximos 30% = B, resto = C) |
| Lead times | **Preencher manualmente conforme cadastra** (você tem na cabeça) |
| Localização quarentena | **Criar QUARENTENA em cada galpão** (Plano 1 setup) |

**Implicação:** Plano 1 cria QUARENTENA junto com DEFAULT-PICKING. Plano 3 ganha task extra de auto-seed de fornecedores baseado em `sku-fornecedor.ts`. Curva ABC calculada via materialized view com refresh diário.

---

## C) Defaults de inventário

| Item | Decisão |
|---|---|
| Tolerância % | **2%** (recomendado) |
| Aprovação por valor | **R$ 1.000** |
| Modo de contagem | **Blind** (operador não vê saldo esperado) |
| Operadores em paralelo | **4-6** |
| Janela de inventário completo | **Caso a caso** — sem regra fixa |

**Implicação:** valores default na migration de Plano 4 (`tolerancia_pct=2`, `exige_aprovacao_acima_valor=1000`, `modo_contagem='blind'`). UI da divisão de áreas dimensionada pra 4-6 operadores.

---

## D) Operação

| Item | Decisão |
|---|---|
| Etiquetas de localização | **Code 128 (1D barcode)** — scanner USB/Bluetooth |
| Notificações | **Sem em v1** — só dashboard |
| Snapshot inicial Tiny | **Sábado ou domingo** |
| Tempo de teste do time | **Conforme demanda — sem agenda fixa** |

**Implicação:** scanner input com handler de Enter (já é o padrão). Sem integração de email/Slack na Fase 0. Snapshot scheduled em fim de semana com você acompanhando.

---

## E) Empréstimos

| Item | Decisão |
|---|---|
| Limite máx por produto | **Tela simples em v1** (+0.5 sem ao Plano 3) |
| Custo médio em empréstimo | **Custo da credora** (mais correto contabilmente) |

**Implicação:** Plano 3 ganha task de UI simples pra `limite_max_por_produto` por par. Documentar que custo da NF da vendedora reflete custo médio da credora — falar com contador antes de Fase 3.

---

## F) Devoluções

| Item | Decisão |
|---|---|
| Custo médio em devolução | **Recalcular como entrada (média ponderada)** |

**Implicação:** Plano 5 task de devolução íntegra chama `recalcularCustoMedio` (helper do Plano 2).

---

## G) Validação e checkpoints

| Item | Decisão |
|---|---|
| SLA por plano | **Sem SLA — você sinaliza quando ok** |
| Critério "passou" | **Técnicos + 3-5 cenários funcionais por plano** |
| Critério go Fase 1 | **Time treinado e aprovou nas telas** |

**Implicação:** ao fim de cada plano eu paro e espero seu OK explícito. Eu defino lista curta de cenários funcionais por plano (vou inserir como "checklist de aceitação" no fim de cada um).

---

## H) Comunicação externa

| Item | Decisão |
|---|---|
| Marketplaces (ML, Shopee) | **Só quando virar problema** (Fase 3+, reativo) |

**Implicação:** sem trabalho de antecipação. Tiny saldo divergir é aceito; vamos lidar quando vier reclamação.

---

## I) Cutover pra produção (decidido em 2026-05-08, sessão pós-auditoria)

| Item | Decisão |
|---|---|
| Estilo de transição | **Big bang num fim de semana** — vira a chave de uma vez |
| Dual-write paralelo | **Não** — substituído pelo big bang |
| Por galpão | **Não** — ambos galpões cortam juntos |

**Implicação:** existe um **Plano 6** (`2026-06-12-wms-6-go-live.md`) com runbook completo do cutover (pré-flight, hora-zero, smoke tests, monitoramento, rollback). A "Fase 1 (dual-write)" mencionada nos planos 1-5 deixa de existir como originalmente prevista; o Plano 6 ocupa esse lugar.

---

## Consolidado: pontos a aplicar nos planos

### Plano 1 (Foundation)
- ✅ Setup staging com URL pública aceitável (badge STAGING crítico)
- ➕ Task: criar localização QUARENTENA em cada galpão na migration
- ➕ Política do snapshot: agendar pra fim de semana, anotar em wms-staging-policy.md

### Plano 2 (Movimentações)
- ✅ Sem mudanças estruturais (helpers já preparados pra recalcular custo médio)

### Plano 3 (Roteamento)
- ➕ Task: auto-seed de fornecedores baseado em `sku-fornecedor.ts`
- ➕ Task: tela simples de limite máximo por produto (campo `limite_max_por_produto`)
- 📝 Documentar regra: custo unit em mov de empréstimo = custo médio da linha da credora

### Plano 4 (Inventário)
- 🔧 Defaults na migration: `tolerancia_pct=2.0`, `modo_contagem='blind'`, `exige_aprovacao_acima_valor=1000`
- 🔧 UI da divisão de áreas: dimensionar pra 4-6 operadores
- 🔧 Scan input compatível com Code 128 USB scanner (já é, no Enter)
- ➕ View/cálculo de curva ABC via giro 30d (auto)

### Plano 5 (Exceções)
- 🔧 Task de devolução íntegra chama `recalcularCustoMedio`
- ✅ Sem notificações (já alinhado)

### Todos os planos
- ➕ Cada plano ganha "Checklist de aceitação funcional" no fim com 3-5 cenários executáveis
- ➕ Sem SLA fixo: cada plano termina com nota "aguardando OK do user antes de iniciar próximo plano"

---

**Última atualização:** sessão de revisão pré-implementação 2026-05-08.
