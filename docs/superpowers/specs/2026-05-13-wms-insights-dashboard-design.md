# WMS Insights Dashboard — Design Spec

**Data:** 2026-05-13
**Branch:** `develop`
**Status:** Aprovado pra implementação
**Autor:** Eryk + Claude (brainstorming colaborativo)

## Resumo executivo

Suite de 6 páginas (`/wms/insights` + 5 leaf pages) que transforma dados operacionais do WMS em decisões: quem está performando, onde está o gargalo, qual SKU vai romper, quanto dinheiro está parado, por que estão devolvendo. Inclui motor de detecção de anomalia que escreve "insights ativos" em tabela própria, lidos como cards de ação no topo das páginas.

**Audiência:** dono/gestor (visão executiva diária) + supervisor de turno (gestão minuto-a-minuto) + RH/produtividade (avaliação semanal). Cada perfil tem peso em diferentes páginas, mas a suite é coesa.

**Escopo:** WMS apenas. Não toca o `/painel/operacao` e `/painel/gerencial` existentes (que são SISO-focados — pipeline de pedido). Estes continuam intactos.

**Diferencial:** não é só dashboard — tem motor de insight que detecta anomalias (queda de produtividade individual, SKU em risco, fornecedor furando lead time, etc.) e propõe ação.

## Estrutura

```
/wms/insights                         (HUB EXECUTIVO)
  ├─ Top: insights ativos (até 6 cards de anomalia/ação)
  ├─ KPI strip: throughput, lead time, acurácia, cobertura, capital, devol.
  ├─ Mini-sparklines por tema (7d/30d)
  └─ Atalhos pras 5 páginas

  ├─ /wms/insights/pessoas            (performance + retrabalho)
  ├─ /wms/insights/fluxo              (gargalo + throughput por etapa)
  ├─ /wms/insights/estoque            (ABC + cobertura + slow-mover)
  ├─ /wms/insights/financeiro         (valor, empréstimos, custo médio)
  ├─ /wms/insights/devolucoes         (A/B/C/D, motivos, fornecedores)
  └─ /wms/insights/regras             (admin: configurar motor de insight)
```

Filtros globais por página (em URL pra compartilhamento): galpão, empresa, período (Hoje/7d/30d/Custom).

## Permissões

| Cargo | Hub | Pessoas | Fluxo | Estoque | Financeiro | Devoluções | Regras |
|---|---|---|---|---|---|---|---|
| `admin` | ✅ tudo | ✅ todos | ✅ todos | ✅ todos | ✅ | ✅ | ✅ edita |
| `operador_*` | ✅ filtrado pelo galpão | ✅ só ele + agregado galpão | ✅ galpão dele | ✅ galpão dele | ❌ | ❌ | ❌ |
| `comprador` | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ |

## Camadas de dados

### Camada 1 — Live queries (React Query, refresh 30-60s)

Queries diretas em tabelas operacionais. Usadas só pra contadores do agora (operadores ativos, fila atual, insights ativos não-dispensados). Bancada existente: `siso_pedidos`, `siso_estoque`, `siso_movimentacoes`, `siso_inventario_*`, `siso_wms_pendencias_guarda`.

### Camada 2 — Materialized views

| Mat view | Status | Refresh | Conteúdo |
|---|---|---|---|
| `siso_curva_abc` | ✅ existente | diário (já implementado) | Ranking ABC por giro 30d |
| `siso_cobertura_estoque` | ✅ existente | hourly | Cobertura por giro + status |
| `siso_metricas_diarias` | ❌ **nova** | hourly | Throughput diário, lead time P50/P90 por galpão |
| `siso_performance_operador_diaria` | ❌ **nova** | hourly | Pedidos/h, locs/h, acuracidade por operador/dia |
| `siso_estoque_valor_diario` | ❌ **nova** | diário | Valor estoque (saldo×custo_medio) por dona/galpão/dia |
| `siso_devolucoes_diario` | ❌ **nova** | hourly | Devoluções por classif/motivo/SKU/dia |

### Camada 3 — Motor de insights

**Novas tabelas:**

```sql
CREATE TABLE siso_wms_insights_regras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text UNIQUE NOT NULL,
  nome text NOT NULL,
  categoria text NOT NULL CHECK (categoria IN ('pessoas','fluxo','estoque','financeiro','devolucoes')),
  ativa boolean NOT NULL DEFAULT true,
  severidade text NOT NULL CHECK (severidade IN ('critico','alerta','info')),
  threshold jsonb NOT NULL,                 -- { sigma: 2.0, days: 14, min_sample: 20 }
  query_sql text NOT NULL,                  -- SQL que retorna { entidade_id, titulo, descricao, dados }
  cooldown_min int NOT NULL DEFAULT 360,
  criada_em timestamptz NOT NULL DEFAULT now(),
  atualizada_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE siso_wms_insights_ativos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regra_id uuid NOT NULL REFERENCES siso_wms_insights_regras(id),
  categoria text NOT NULL,
  severidade text NOT NULL,
  entidade_tipo text,                       -- 'operador'|'sku'|'fornecedor'|'galpao'
  entidade_id text,
  titulo text NOT NULL,
  descricao text NOT NULL,
  dados jsonb,
  galpao_id uuid REFERENCES siso_galpoes(id),
  link text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  dispensado_em timestamptz,                -- snooze global: qualquer user dispensa, some pra todos
  dispensado_por uuid REFERENCES siso_usuarios(id)
);

-- Lookups rápidos pra strip de insights ativos (filtra dispensado + expirado)
CREATE INDEX idx_insights_categoria_ativa
  ON siso_wms_insights_ativos(categoria, severidade, criado_em DESC)
  WHERE dispensado_em IS NULL AND expira_em > now();

-- Garante 1 insight ativo por (regra, entidade) — upsert respeita isso
CREATE UNIQUE INDEX idx_insights_unique_ativos
  ON siso_wms_insights_ativos(regra_id, entidade_tipo, entidade_id)
  WHERE dispensado_em IS NULL AND expira_em > now();
```

**Cron worker:** `GET /api/wms/insights/refresh` (protegido por `WORKER_SECRET`), chamado a cada 5min. Itera regras ativas, executa SQL, upserts em `siso_wms_insights_ativos`, expira insights antigos. Roda no Vercel cron ou pg_cron.

## 15 regras iniciais

### Pessoas (5)

| Código | Severidade | Lógica | Cooldown |
|---|---|---|---|
| `op_queda_produtividade` | alerta | produtividade < (média_pessoal_14d − 2σ), min 20 pedidos no histórico | 12h |
| `op_alta_divergencia` | alerta | divergências do op > 2× mediana do galpão (30d) | 12h |
| `op_especializacao` | info | 80%+ horas em 1 função em 7d | 7d |
| `op_alto_ajuste` | alerta | ajustes manuais > 3 em 7d | 12h |
| `op_baixo_sample` | info | operador novo (<5 dias trabalhados) | 7d |

### Fluxo (4)

| Código | Severidade | Lógica | Cooldown |
|---|---|---|---|
| `fluxo_lead_time_p90` | crítico | P90 24h > 1.5× P90 30d | 4h |
| `fluxo_fila_etapa` | alerta | fila qualquer etapa > 2× média 30d | 4h |
| `fluxo_ritmo_baixo` | alerta | throughput acumulado até agora < 0.7× esperado | 6h |
| `fluxo_aging_outlier` | crítico | pedido em etapa > P95 histórico | 1h (instantâneo) |

### Estoque (3)

| Código | Severidade | Lógica | Cooldown |
|---|---|---|---|
| `estoque_ruptura_iminente` | crítico | cobertura < lead_time_min E sem OC pendente | 12h |
| `estoque_slow_mover` | info | sem saída 60+ dias E valor > R$ 500 | 7d |
| `estoque_mudanca_curva` | info | mudou de curva ABC em 30d | 7d |

### Financeiro (1)

| Código | Severidade | Lógica | Cooldown |
|---|---|---|---|
| `fin_custo_medio_pulou` | alerta | custo_medio_atual > 1.15× custo_medio_30d_atrás | 24h |

### Devoluções (2)

| Código | Severidade | Lógica | Cooldown |
|---|---|---|---|
| `dev_taxa_alta` | alerta | taxa 30d > 1.3× média 90d | 24h |
| `dev_motivo_subindo` | alerta | motivo cresceu > 50% week-over-week | 7d |

## Página 1 — Hub `/wms/insights`

```
┌─ Top: insights ativos críticos (até 6 cards) ──────────────────────┐
│ Cada card: ícone severidade · título · descrição curta · botão Ver │
│ Snooze 24h por card (escreve dispensado_em)                         │
└────────────────────────────────────────────────────────────────────┘

┌─ KPI strip executivo (6 KPIs com delta vs 7d) ─────────────────────┐
│ Throughput · Lead time · Acurácia · Cobertura · Capital · Devol.%  │
└────────────────────────────────────────────────────────────────────┘

┌─ Mini-sparklines (4-6 por tema, toggle 7d/30d) ────────────────────┐
│ Produtividade média · Throughput diário · SKUs em ruptura · Devol. │
└────────────────────────────────────────────────────────────────────┘

┌─ Atalhos pras 5 páginas + admin de regras ─────────────────────────┐
└────────────────────────────────────────────────────────────────────┘
```

## Página 2 — Pessoas `/wms/insights/pessoas`

### Métricas por etapa

| Etapa | Fonte | KPIs primários |
|---|---|---|
| **Separação** | `siso_pedidos.separacao_operador_id`, `separacao_iniciada_em`, `separado_em` + `siso_pedido_historico` | pedidos/h, tempo médio, % refeitos, bipes errados |
| **Embalagem** | `siso_pedidos.embalagem_operador_id`, `embalado_em` | pedidos/h, tempo médio |
| **Guarda** | `siso_wms_pendencias_guarda.iniciada_por/iniciada_em/guardada_em` | pendências/h, tempo médio, % parciais, % canceladas |
| **Contagem (invent.)** | `siso_inventario_localizacoes` (bloqueada_por, contagem_iniciada_em, contagem_finalizada_em) + `siso_inventario_divergencias` | locs/h, tempo médio/loc, acuracidade (RPC `wms_metricas_operador` existente) |
| **Outras WMS** | `siso_movimentacoes.usuario_id` agrupado por `origem_tipo` | transferências, replenishments, ajustes, recebimentos |

### Layout

- Cards de insights ativos da categoria "pessoas" no topo
- Filtros: galpão, período, função, operador
- KPI strip do agregado
- Tabela ranking ordenável (operador × função × pedidos/h × tempo/loc × acurácia × ações/h × drill-down)
- Heatmap horário (hora × operador, cor = atividade)
- Drill-down `/wms/insights/pessoas/[id]`:
  1. Header (nome, função detectada por uso, galpão home, dias trabalhados/30d)
  2. Sparkline 30d por métrica primária
  3. Heatmap horário pessoal
  4. Breakdown por etapa (% tempo)
  5. Comparativo com pares (boxplot)
  6. Eventos recentes de erro (10 últimos)
  7. Lista de tarefas do turno com link

### Regras de fairness

- **Dificuldade ajustada:** `dificuldade_pedido = n_itens + 1.5 * n_locs_distintas`. Velocidade reportada = pedidos / (horas × dificuldade média).
- **Só horas ativas:** "hora ativa" = ≥1 ação registrada naquela hora pro operador. Horas vazias não diluem.
- **Sample mínimo no ranking:** ≥20 pedidos OU ≥50 locs OU ≥30 contagens no período. Abaixo disso fica em "amostra pequena" (visível mas não rankeia).
- **Função efetiva detectada por uso:** 80%+ horas em 1 função = especialista; senão "multi".

## Página 3 — Fluxo `/wms/insights/fluxo`

### Conteúdo

- Cards de insights ativos categoria "fluxo"
- Filtros: galpão, período, comparar com período anterior (toggle)
- Lead time end-to-end: média / P50 / P90 / P95, hoje vs período anterior, linha 30d
- **Funil por etapa** (largura = tempo médio, cor = saúde):
  - Recebido → Guardado
  - Pedido criado → NF chegou
  - NF → Separação iniciada
  - Separação iniciada → Separado
  - Separado → Embalado
  - Embalado → Expedido
- Throughput por hora (heatmap dia × hora, comparando hoje vs média 14d)
- Capacidade vs demanda + projeção 4 semanas

### Definição de gargalo

**Etapa com maior `tempo_médio_atual / tempo_médio_30d`.** Não é fila absoluta — é etapa que ficou mais lenta vs ela mesma. Card "Gargalo dinâmico" mostra etapa pior + sugestão (alocar op, abrir NF, etc.).

## Página 4 — Estoque `/wms/insights/estoque`

### Conteúdo

- Cards de insights ativos categoria "estoque"
- Filtros: galpão, empresa dona, curva ABC, status cobertura, fornecedor
- KPI strip: SKUs ativos, cobertura média, % ruptura, capital parado, giro/dia
- **Análise ABC** (treemap por curva, drill por clique)
- **Mapa de cobertura** (quadrante 2D: giro × cobertura, dots = SKUs, tamanho = valor, cor = curva)
- **Top 20 SKUs em risco de ruptura** (tabela com saldo, giro, cobertura, lead-time, OC pendente, status)
- **Slow-movers** (sem saída 60d+, valor, ação sugerida)
- **Performance de fornecedor** (lead time prometido × efetivo, OCs no período)

Usa as mat views existentes `siso_curva_abc` e `siso_cobertura_estoque`. Lead time efetivo do fornecedor = derivado de `siso_movimentacoes` origem `compra_manual` + datas OC.

## Página 5 — Financeiro `/wms/insights/financeiro`

### Conteúdo

- Cards de insights ativos categoria "financeiro"
- Filtros: galpão, empresa dona, período
- **Valor do estoque:** por empresa dona, por galpão, por curva ABC, tendência 30d (usa nova mat view `siso_estoque_valor_diario`)
- **Empréstimos N×N:** matriz devedora × credora com saldo R$ e qty + top 3 SKUs por par, saldo líquido (NetAir↔NetParts), linha histórica 30d. Usa RPC `wms_saldos_devedores()` existente.
- **Variação de custo médio** (tabela de anomalias: SKU + custo 30d atrás + custo atual + Δ%)
- **Ajustes manuais** (perdas/ganhos por período, top motivos)

## Página 6 — Devoluções `/wms/insights/devolucoes`

### Conteúdo

- Cards de insights ativos categoria "devolucoes"
- Filtros: galpão, empresa, período, classificação A/B/C/D, motivo, SKU
- KPI strip: devoluções, valor R$, taxa %, pendentes classificar, médio R$
- **Distribuição por classificação A/B/C/D** com valor e ação por bucket
- **Top 10 SKUs com mais devolução** + % do vendido + motivo dominante
- **Pareto por motivo** (visualizar onde concentra)
- **Por fornecedor** (volumes, devoluções, taxa, custo) — qualidade upstream

## Página 7 — Admin de regras `/wms/insights/regras` (admin only)

Tabela das 15 regras com:
- Toggle ativar/desativar
- Edit threshold (jsonb)
- Edit cooldown
- Test-run (executa regra agora, mostra resultado sem persistir)
- Log de últimas execuções por regra

## API routes novas

```
GET  /api/wms/insights/hub                  — KPIs + sparklines + insights ativos
GET  /api/wms/insights/pessoas              — ranking + filtros
GET  /api/wms/insights/pessoas/[id]         — drill-down
GET  /api/wms/insights/fluxo                — lead time + funil + throughput
GET  /api/wms/insights/estoque              — ABC + cobertura + ruptura + slow + forn.
GET  /api/wms/insights/financeiro           — valor + empréstimos + custo + ajustes
GET  /api/wms/insights/devolucoes           — classif + SKU + motivo + fornecedor
GET  /api/wms/insights/regras               — admin: lista regras
PATCH /api/wms/insights/regras/[id]         — admin: editar regra
POST /api/wms/insights/regras/[id]/test     — admin: test-run
POST /api/wms/insights/ativos/[id]/dispensar — snooze 24h
GET  /api/wms/insights/refresh              — worker secret: cron 5min
```

## Componentes compartilhados (em `src/components/wms/insights/`)

- `<InsightsAtivosStrip>` — top cards de anomalia, recebe categoria
- `<KpiStrip>` — strip de 4-6 KPIs com delta
- `<Sparkline>` — gráfico mini (linha ou barra)
- `<RankingTable>` — tabela ordenável + paginada
- `<HeatmapHorario>` — heatmap hora × dia ou hora × pessoa
- `<FunilEtapas>` — barras horizontais com tempo médio + acumulado
- `<MapaCobertura>` — scatter plot giro × cobertura
- `<DistribuicaoBuckets>` — distribuição em A/B/C/D ou tiers
- `<ParetoChart>` — pareto bar + linha cumulativa
- `<DrillDownPessoa>` — header + sparkline + heatmap + breakdown + boxplot + erros

## Migrations necessárias

1. `20260514_wms_insights_metricas_diarias.sql` — mat views `siso_metricas_diarias`, `siso_performance_operador_diaria`, `siso_devolucoes_diario`
2. `20260515_wms_insights_estoque_valor_diario.sql` — mat view `siso_estoque_valor_diario` + função refresh
3. `20260516_wms_insights_motor.sql` — tabelas `siso_wms_insights_regras` + `siso_wms_insights_ativos` + índices + 15 regras seed
4. `20260517_wms_insights_rpcs.sql` — RPCs auxiliares: `wms_insights_executar_regra(p_regra_id)`, `wms_insights_ranking_operadores(p_galpao, p_periodo, p_funcao)`, `wms_insights_funil_etapas(p_galpao, p_periodo)`

## Estimativa de complexidade

- **Migrations** (4 arquivos): ~600 linhas SQL
- **Lib** (`src/lib/wms/insights/`): ~1200 linhas (queries por página + motor)
- **API routes** (12 endpoints): ~800 linhas
- **Páginas + componentes** (7 páginas + 10 componentes): ~3500 linhas
- **Testes**: ~500 linhas (queries, motor)
- **Total estimado:** ~6600 linhas

Suficiente pra ser quebrado em ~10-12 tasks sequenciais no plano de execução.

## Decisões deliberadas

1. **Não fundimos com `/painel/operacao`/`/painel/gerencial`** — eles são SISO-focados (pedido pipeline), o novo é WMS-focado. Mantém separação clara de responsabilidade.
2. **Motor de insight é tabular (regras em DB), não código** — admin pode tunar threshold sem deploy. UI admin pra editar.
3. **Cooldown por regra** — evita spam de alerta. Mesma regra na mesma entidade só re-dispara após cooldown_min.
4. **Snooze global (qualquer user dispensa, some pra todos)** — simplifica MVP. Quando admin dispensa um insight, some pra todo mundo. Quem dispensou fica logado em `dispensado_por`. Per-user pode vir depois com tabela auxiliar `siso_wms_insights_dispensados_por_user`.
5. **Fairness primeiro** — métricas de pessoas SEMPRE têm sample mínimo + ajuste por dificuldade. Reduz risco de gestão por número errado.
6. **Mat views > queries ao vivo** — 500 pedidos/dia × 30d = 15k rows manageable, mas agregações com janela móvel ficam pesadas em vivo. Refresh hourly é mais que suficiente pra essa cadência.

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Motor de insight vira spam (muitos alertas) | Cooldown longo (≥4h alertas, ≥7d info) + threshold conservador no MVP (2σ). Tunar com uso. |
| Performance de matview refresh trava prod | Mat views com `CONCURRENTLY` + cron em horário de baixa (madrugada pras pesadas) |
| Operador novo aparece "lento" injustamente | Regra `op_baixo_sample` flagga; ranking principal exige sample mínimo |
| Insight com SQL bugado mata o cron | Try/catch por regra; log de erro; regra com >3 falhas seguidas é auto-desativada |
| Custo médio histórico não existe pré-snapshot | Snapshot diário começa do dia da migration; histórico 30d só fica disponível após D+30. Comunicar isso no UI ("dados disponíveis a partir de X") |

## Próximo passo

Invocar skill `writing-plans` pra detalhar plano de implementação executável em N tasks sequenciais.
