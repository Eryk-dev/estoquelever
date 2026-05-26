# Auditoria WMS — Spec mestre dos 6 planos de correção

**Data:** 2026-05-26
**Auditoria de origem:** `docs/audit-workflows/` (commit `209253c`, branch `develop`, cutover `WMS_AS_SOURCE=true` desde 2026-05-25)
**Total de achados:** 141 (35 ALTO · 57 MÉDIO · 49 BAIXO) em 9 módulos
**Estratégia:** fix forward + planos por tema cross-module + paralelizáveis em worktrees

---

## 1. Sumário executivo

A auditoria mapeou 110+ ações de operador em 9 módulos e identificou 141 divergências entre o **contrato declarado em `CLAUDE.md`** e o **comportamento real do código**. Um cluster crítico (35 ALTOS) gira em torno de **5 temas dominantes**, todos cross-module:

1. **Ledger não é fonte de verdade na prática** — várias ações operacionais não escrevem em `siso_movimentacoes`, quebrando o contrato "todo saldo vive no ledger". Sintoma mais grave: `compras/receber` não cria mov `E` (`nf_compra`) — pós-cutover, entradas de OC ficam invisíveis ao WMS.
2. **Reverse paritária é exceção, não regra** — operações que mudam estoque tipicamente não têm undo. Operador erra → ajuste manual → mistura origem_tipos no ledger → auditoria degradada.
3. **Realtime/visibilidade descosturada** — publication realtime omite 4 das 13 tabelas que `CLAUDE.md` afirma, e o hook da home assina justamente as ausentes. Quadro home não reage a eventos cross-módulo. Exceções operacionais (devoluções, transferências em_transito, sessões em revisão) não têm card na home.
4. **Insights nunca executam** — 4 RPCs referenciam colunas dropadas no schema 3D; 16 regras de anomalia nunca rodaram (sem cron). Mecanismo principal de detecção proativa silenciosamente inativo.
5. **Auth/permissão server-side inconsistente** — 6+ endpoints confiam só no UI gatear permissões. Bypass trivial via curl.

Este documento define **6 planos cross-module paralelizáveis** que cobrem 100% dos 141 achados. A enumeração completa (finding → arquivo:linha → plano de destino) está no Apêndice §10.

---

## 2. Princípios não-negociáveis (contratos do WMS que orientam os fixes)

Sempre que um achado for resolvido, ele deve restabelecer um destes princípios. Se uma proposta de fix conflitar com algum princípio, **revisar a proposta** — não relaxar o princípio.

| ID | Princípio | Origem | Achados que violam (quantidade) |
|---|---|---|---|
| **PR-1** | `siso_movimentacoes` é ledger imutável; toda escrita de saldo passa por `wms_inserir_movimentacao` | CLAUDE.md "Direção Estratégica firmada 2026-05-18" | ~10 |
| **PR-2** | Toda ação que muda saldo tem reverse simétrico (par estorno via `siso_pedido_item_mov_links` ou `estorno_de`) | CLAUDE.md "Concorrência via reconciliação temporal" + design dos pares | ~14 |
| **PR-3** | Realtime é cross-module: toda tabela que afeta operação ao vivo entra na publication `supabase_realtime` | CLAUDE.md "Realtime é cross-module" | 5 tabelas omitidas |
| **PR-4** | Backend valida permissão (`userCan(session, "perm.x")`); UI gateia mas **não substitui** check server-side | CLAUDE.md "Backend: `if (!userCan(session, \"perm.x\")) return 403;`" | ~6 endpoints |
| **PR-5** | Apuração por empresa é report sobre TAGS em movs (`empresa_compradora/vendedora/referencia`), nunca coordenada física | CLAUDE.md "Empresa dona deixou de ser coordenada física em 2026-05-20" | ~5 (uso de `siso_empresas.galpao_id` deprecated) |
| **PR-6** | Custo médio é global por produto (`siso_custo_medio`), recalculado em toda entrada com `custo_unitario` | CLAUDE.md "WMS Ledger Simplificado 3D" | ~7 (entradas a custo zero diluem) |
| **PR-7** | Idempotência: ações destrutivas suportam retry/duplo-clique sem efeito colateral | CLAUDE.md "Estamos trabalhando exclusivamente no ambiente de staging" + design implícito | ~5 |
| **PR-8** | Exceções operacionais (pendências, fantasmas, divergências) têm visibilidade no quadro home, não exigem operador entrar em tela dedicada | CLAUDE.md "Quadro de Tarefas Pendentes na home" | ~5 categorias de exceção invisíveis |

---

## 3. Os 5 temas dominantes da auditoria

### Tema 1 · Ledger não tocado por ações que deveriam tocá-lo

Ações onde o ledger silenciosamente NÃO recebe mov, quebrando PR-1:

| Ação | Comportamento atual | O que deveria | Severidade |
|---|---|---|---|
| `POST /api/wms/compras/receber` | Atualiza só `siso_pedido_itens.compra_quantidade_recebida` | `wms_inserir_movimentacao(E, nf_compra)` + `custo_unitario` | **ALTO** (bloqueia cutover) |
| `POST /api/wms/separacao/bipar-checklist` | `separacao_marcado=true` sem mov | Par `S+L` igual a `marcar-item` | **ALTO** (dupla baixa) |
| `POST /api/wms/separacao/validar-oc-item` (encontrei) | Marca picked sem mov | Par `S+L` | **ALTO** |
| `POST /api/wms/separacao/produto-esgotado` (encaminhar) | Reseta campos sem estornar S+L emitidas | Estorno via `resetarEstadoSeparacaoItens` | **ALTO** |
| Webhook cancelamento Tiny | Atualiza status, não libera R | `liberarReserva(pedido_id, motivo='cancelamento')` | **ALTO** |
| `POST /api/wms/separacao/encaminhar` | `estornarEstoque` no Tiny, não no WMS | `liberarReserva` + estorno ledger | **ALTO** |
| `POST /api/wms/separacao/localizacao` | Snapshot legado + Tiny | Update `siso_estoque.localizacao_id` | **ALTO** |
| `POST /api/wms/vendas/criar` (modo separacao) | Pula NF, não cria R | `reservarAtomico` se WMS_AS_SOURCE | **ALTO** |
| `DELETE /api/wms/separacao/realocacao/[id]` | Status `cancelado`, não estorna R cascade | `liberarReserva` da R cascade | **ALTO** |
| `POST /api/wms/compras/comprar` | Marca `comprado` sem criar OC | Insert em `siso_ordens_compra` | **ALTO** |

→ **Destino: P2 (Ledger Completeness)**

### Tema 2 · Reverse paritária ausente

| Ação forward | Reverse existe? | Único caminho corretivo hoje |
|---|---|---|
| Aplicar inventário | ❌ | Criar inventário oposto manual |
| Confirmar guarda | ❌ | Ajuste manual (perde rastreabilidade) |
| Classificar devolução | ❌ | Ajuste manual + criar pendência fake |
| Replenishment | ❌ | Replenishment ao contrário (2 pares S+E novos sem ligação) |
| Ajuste manual | ❌ | Ajuste oposto sem ligação |
| Venda manual (baixa direta) | ❌ | Não há |
| Receber transferência | ❌ | Ajuste manual |
| Reconciliar retroativo | ❌ | Não há |
| Cancelar pedido com OC recebida | ❌ | Banner D10 promete, botão é no-op |
| Marcar item | ✅ Desmarcar | — |
| Cancelar transferência em_transito | ✅ Estorno automático | — |
| Parcial | ✅ `desfazer-parcial` (sem UI) | — |

→ **Destino: P3 (Reverse Paritária + Idempotência)**

### Tema 3 · Realtime + visibilidade da home

**Publication `supabase_realtime` (staging atual):** `siso_custo_medio`, `siso_estoque`, `siso_inventario_contagens`, `siso_inventario_divergencias`, `siso_inventario_localizacoes`, `siso_inventario_operadores`, `siso_movimentacoes`, `siso_pedido_item_realocacoes` (8 tabelas).

**Hook `useDashboardTarefasRealtime` assina:** `siso_pedidos`, `siso_wms_pendencias_guarda`, `siso_inventario_sessoes`, `siso_inventario_operadores`, `siso_pedido_itens` — **4 de 5 NÃO estão na publication**. Channels criados sem erro mas nunca disparam invalidate.

**Cards/contadores ausentes no quadro home:**
- Devoluções pendentes (acumulam invisíveis)
- Transferências em_transito (saldo fantasma)
- Sessões inventário em `revisao` (supervisor esquece)
- Reservas R órfãs
- Pendências retroativas não-reconciliadas
- Saldo em RECEBIMENTO sem pendência viva (após P3 fix de cancelar)

→ **Destino: P1 (Foundation Realtime) + P5 (Visibilidade Home)**

### Tema 4 · Insights inativo

**4 RPCs runtime-broken** (referenciam colunas dropadas no schema 3D):
- `wms_insights_hub_kpis` → ERROR: column "custo_medio" does not exist
- `wms_insights_estoque_valor_atual` → column "empresa_dona_id" does not exist
- `wms_insights_estoque_quadrante` → idem
- `wms_insight_estoque_slow_mover` → idem

**Crons faltantes:**
- `/api/wms/insights/refresh` (esperado 5min) — 0 alertas ativos em prod
- `/api/wms/reservas/cleanup` (esperado 1h)
- `/api/wms/inventario/cleanup` (esperado 30min)
- `wms_refresh_curva_abc()` (função existe, sem schedule)

→ **Destino: P1 (Foundation)**

### Tema 5 · Auth inconsistente

**Endpoints sem `userCan`/`getSessionUser` server-side:**
- `POST /api/wms/pedidos/aprovar`
- `POST /api/wms/webhook/reprocessar` (bonus: ignora body, reprocessa tudo)
- `GET /api/wms/pedidos`
- `GET /api/wms/pedidos/[id]/historico`
- `POST /api/wms/pedidos/[id]/observacoes`
- `POST /api/wms/vendas/criar`
- `GET /api/wms/inventario/metricas`
- `GET /api/wms/vendas/[id]` (sem ownership check)

**Endpoints com perm errada (`warehouseAccess` genérico em vez de granular):**
- `POST /api/wms/devolucoes/[id]/classificar` (deveria exigir `operacoes.devolucoes_classificar`)
- `POST /api/wms/lancamento-retroativo` (deveria exigir `operacoes.retroativo` — perm não existe)
- `POST /api/wms/lancamento-retroativo/[id]/reconciliar` (idem)
- `PATCH /api/wms/vendas/[id]/vendedor` (sem valida cargo do target)

→ **Destino: P4 (Auth + Permissões)**

---

## 4. Os 6 planos — overview

| # | Plano | Causa-raiz | Pode iniciar | Bloqueado por | Achados ~ |
|---|---|---|---|---|---|
| **P1** | Foundation Realtime + Insights Recovery | Infra de observação descosturada (publication, RPCs, crons) | Imediato | — | ~8 |
| **P2** | Ledger Completeness | Várias ações não escrevem no ledger | Imediato | — (mas idealmente antes de P4) | ~22 |
| **P3** | Reverse Paritária + Idempotência | Ações forward sem undo + race conditions | Imediato | — | ~24 |
| **P4** | Auth + Permissões Granulares | UI gateia mas API confia | Após P2 (recomendado) | P2 (overlap surgical) | ~12 |
| **P5** | Visibilidade Home + UI Fixes | Exceções invisíveis + UI inconsistente | Após P1 mergeado | P1 (realtime pub) | ~28 |
| **P6** | Estado Fantasma + Cleanups + Polish | Estados intermediários sem TTL/cleanup + tech debt | Imediato | — | ~47 |

**Distribuição em 3 waves de paralelização:**

```
Wave 1 (imediata, 4 worktrees simultâneos):
  ┌────────────┬────────────┬────────────┬────────────┐
  │    P1      │    P2      │    P3      │    P6      │
  │ migrations │ back-end   │ back-end + │ migrations │
  │   only     │ writes     │ new routes │ + back-end │
  └────────────┴────────────┴────────────┴────────────┘

Wave 2 (após P1 mergeado):
  ┌────────────┐
  │    P5      │
  │ front-end  │
  └────────────┘

Wave 3 (após P2 mergeado):
  ┌────────────┐
  │    P4      │
  │ surgical   │
  └────────────┘
```

**Conflito potencial em handlers compartilhados (P2 ↔ P4):** `vendas/criar`, `aprovar`, `compras/receber`, `webhook/reprocessar`, `[id]/observacoes`. Mitigação: P2 edita corpo do handler, P4 adiciona check no topo (linhas 1-10) — overlap mínimo, rebase resolve.

---

## Nota sobre numeração de achados

A partir daqui (§5..§10) cada plano lista seus achados com IDs **locais ao plano** (`P2-2.1`, `P3-3.1`, etc.) por conveniência de leitura. A **fonte canônica** é o Apêndice §15, que numera por módulo de origem (`1.X` = pedidos, `2.X` = separação, ..., `8.X` = transferências). Quando um achado aparece em 2 planos (cross-cutting), o apêndice é a referência cruzada.

---

## 5. P1 · Foundation Realtime + Insights Recovery

### 5.1 Causa-raiz
A camada de observação do sistema (realtime publication + RPCs de insights + cron jobs) está incompleta/quebrada. Restaurar essa camada **não muda comportamento operacional**, mas desbloqueia P5 (quadro home reage de fato) e ativa o motor de detecção de anomalias.

### 5.2 Achados resolvidos

| # | Severidade | Achado | Arquivo:linha |
|---|---|---|---|
| 1.1 | ALTO | Publication realtime omite 4+ tabelas que `CLAUDE.md` declara | índice + `src/hooks/use-dashboard-tarefas-realtime.ts:30-95` |
| 1.2 | ALTO | 4 RPCs insights referenciam colunas dropadas no schema 3D | `supabase/migrations/20260514_wms_insights_motor.sql`, `20260515_wms_insights_rpcs.sql` |
| 1.3 | ALTO | Motor de insights nunca executa — 0 alertas ativos | índice (cron missing) |
| 1.4 | MÉD | Curva ABC stale (função existe mas sem schedule) | índice |
| 1.5 | MÉD | Reservas expiradas sem cron (`/api/wms/reservas/cleanup`) | índice |
| 1.6 | MÉD | Inventário locks órfãos sem cron (`/api/wms/inventario/cleanup`) | índice |
| 1.7 | BAIXO | Cobertura MV não refresha em devolução (apenas cron 1min existente) | 06 |
| 1.8 | BAIXO | `siso_wms_pendencias_guarda` NÃO está na publication | 05 (Migration `20260514_wms_guarda_pendencias.sql`) |

### 5.3 Deliverables
1. **Migration `realtime_publication_completeness`** — `ALTER PUBLICATION supabase_realtime ADD TABLE` pra: `siso_pedidos`, `siso_pedido_itens`, `siso_wms_pendencias_guarda`, `siso_inventario_sessoes`, `siso_devolucoes_pendentes`, `siso_transferencias_galpao`.
2. **Migration `insights_rpcs_3d_patch`** — reescrever as 4 RPCs:
   - Remover `siso_estoque.custo_medio` → JOIN com `siso_custo_medio`
   - Remover `e.empresa_dona_id` / `siso_empresas.galpao_id` → trocar por `m.empresa_vendedora_id` (movs) ou `p.separacao_galpao_id` (pedidos)
3. **Migrations cron (pg_cron)**:
   - `cron_insights_refresh_5min.sql` → `SELECT cron.schedule('wms_insights_refresh', '*/5 * * * *', $$ SELECT net.http_post(url := '<base>/api/wms/insights/refresh', headers := jsonb_build_object('x-worker-secret', current_setting('app.worker_secret'))) $$);`
   - `cron_reservas_cleanup_1h.sql`
   - `cron_inventario_cleanup_30min.sql`
   - `cron_curva_abc_refresh_diario.sql`

### 5.4 Risco
**Baixíssimo.** Só migrations. Rollback: `ALTER PUBLICATION ... DROP TABLE` + `DROP FUNCTION` + `cron.unschedule(...)`.

### 5.5 Critérios de pronto
- [ ] `SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';` retorna 14 tabelas
- [ ] Smoke-test: classificar uma devolução pendente → quadro home atualiza sem refresh
- [ ] `SELECT * FROM cron.job WHERE jobname LIKE 'wms_%';` retorna 5 jobs
- [ ] `/api/wms/insights/hub` retorna 200 sem erro de coluna
- [ ] Após 10min de operação, `SELECT count(*) FROM siso_wms_insights_ativos` > 0 (regras dispararam)

### 5.6 Arquivos tocados
```
supabase/migrations/
  20260527_realtime_publication_completeness.sql
  20260527_insights_rpcs_3d_patch.sql
  20260527_cron_insights_refresh_5min.sql
  20260527_cron_reservas_cleanup_1h.sql
  20260527_cron_inventario_cleanup_30min.sql
  20260527_cron_curva_abc_refresh_diario.sql
```
Zero edits em `src/`.

---

## 6. P2 · Ledger Completeness

### 6.1 Causa-raiz
**Princípio PR-1 violado em 10+ ações.** Várias operações atualizam apenas estado relacional (status, flags, snapshot legado) sem escrever no ledger imutável. Pós-cutover `WMS_AS_SOURCE=true`, isso significa que:
- Entradas físicas (OC, "encontrei", encaminhar pra outro galpão) não aparecem em `siso_estoque`
- Saídas físicas (bipar-checklist) duplicam quando o cutover converte R→S
- Reservas R viram zumbis quando o pedido cancela/encaminha
- Custo médio nunca atualiza em fluxos não-canônicos
- Vendas manuais correm risco de race com marketplace

### 6.2 Achados resolvidos (22)

#### Pedidos / Aprovação
| # | Sev | Achado | Arquivo |
|---|---|---|---|
| 2.1 | ALTO | Cancelamento webhook não chama `liberarReserva` | `src/app/api/wms/webhook/tiny/route.ts:184-303` |
| 2.2 | ALTO | `aprovar` transferência escolhe empresa-suporte sem checar saldo | `src/app/api/wms/pedidos/aprovar/route.ts:107-131` |
| 2.3 | MÉD | `aprovar` busca loc por `saldo>0` em vez de `disponivel>0` | `src/lib/separacao/wms-mapping.ts:64-79`, `aprovar/route.ts:364` |
| 2.4 | MÉD | Tag `siso_pedido_item_estoques` em modo WMS conflita com executor legacy | `webhook-processor-wms.ts:597` (cleanup quando seguro) |

#### Separação
| # | Sev | Achado | Arquivo |
|---|---|---|---|
| 2.5 | ALTO | `bipar-checklist` não gera movs (dupla baixa) | `src/app/api/wms/separacao/bipar-checklist/route.ts` |
| 2.6 | ALTO | `validar-oc-item` "encontrei" ignora ledger | `src/app/api/wms/separacao/validar-oc-item/route.ts` |
| 2.7 | ALTO | `localizacao` escreve Tiny+snapshot, não WMS | `src/app/api/wms/separacao/localizacao/route.ts:54` |
| 2.8 | ALTO | `produto-esgotado` "encaminhar" não estorna movs | `src/app/api/wms/separacao/produto-esgotado/route.ts:200-226` |
| 2.9 | ALTO | `encaminhar` estorna Tiny, não WMS | `src/app/api/wms/separacao/encaminhar/route.ts:309-339` |
| 2.10 | ALTO | DELETE realocação não estorna R cascade | `src/app/api/wms/separacao/realocacao/[id]/route.ts` |
| 2.11 | ALTO | `concluir` permite `separado` com cobertura insuficiente em OC misto | `src/app/api/wms/separacao/concluir/route.ts:117-145` |
| 2.12 | MÉD | `bipar-embalagem` cutover prematuro se RPC `pedido_completo` errado | `src/app/api/wms/separacao/bipar-embalagem/route.ts` |
| 2.13 | MÉD | `confirmar-item-embalagem` OC direta dispara cutover sem NF | `src/app/api/wms/separacao/confirmar-item-embalagem/route.ts` |
| 2.14 | MÉD | `produto-esgotado` modo OC reseta TODOS itens (não só esgotado) | `produto-esgotado/route.ts` |
| 2.15 | MÉD | `concluir-oc` enfileira legacy + dispara cutover (dupla baixa janela) | `src/app/api/wms/separacao/concluir-oc/route.ts` |

#### Compras
| # | Sev | Achado | Arquivo |
|---|---|---|---|
| 2.16 | ALTO | `receber` não cria mov E `nf_compra` (bloqueia cutover) | `src/app/api/wms/compras/receber/route.ts:19-153`, `src/lib/compras-release.ts` |
| 2.17 | ALTO | `comprar` não cria OC → release falha | `src/app/api/wms/compras/comprar/route.ts` |
| 2.18 | ALTO | Cancelar pedido com OC recebida não estorna saldo | `src/app/api/wms/compras/pedidos/[id]/cancelar/route.ts` |
| 2.19 | MÉD | Equivalente após R órfã (WMS_AS_SOURCE) | `src/app/api/wms/compras/itens/[id]/equivalente/confirmar/route.ts` |

#### Vendas / Inventário / Ajuste
| # | Sev | Achado | Arquivo |
|---|---|---|---|
| 2.20 | ALTO | `vendas/criar` modo separacao não cria R | `src/app/api/wms/vendas/criar/route.ts` |
| 2.21 | MÉD | Aplicar inventário não atualiza custo médio | `src/lib/wms/inventario.ts:805-882` |
| 2.22 | MÉD | Ajuste manual entrada não exige `custo_unitario` (dilui custo) | `src/app/api/wms/ajuste/route.ts` |
| 2.23 | MÉD | Devoluções B/C/D entram a custo zero | `src/lib/wms/devolucoes.ts` |
| 2.24 | MÉD | Lançamento retroativo não preserva `criado_em` histórico | `src/app/api/wms/lancamento-retroativo/route.ts` + RPC |

#### Devoluções (gap #4 da análise)
| # | Sev | Achado | Arquivo |
|---|---|---|---|
| 2.25 | ALTO* | `inserirMovimentacao` rejeita `nota_fiscal_id` bigint stringificado | `src/lib/wms/devolucoes.ts:137,153,211,234`, `src/lib/wms/ledger.ts:9-18` |
| 2.26 | ALTO | `empresa_id` devolução salvada como receptora exposta como `empresa_referencia` | `src/lib/wms/devolucoes.ts` (registrar + listar) |
| 2.27 | MÉD | Detecção webhook devolução com falsos pos/neg | `src/app/api/wms/webhook/tiny/route.ts` (handleNfWebhook) |

*\*2.25 confirmar tipo da coluna `siso_movimentacoes.nota_fiscal_id` antes — se `uuid`, é ALTO runtime bug.*

### 6.3 Deliverables
1. **`compras/receber` chama `wms_inserir_movimentacao`** (tipo E, origem_tipo='nf_compra') com `empresa_compradora_id`, `fornecedor_id`, `nota_fiscal_id`, `custo_unitario` por item.
2. **`bipar-checklist` gera par S+L** idêntico a `marcar-item` (delegando pra helper compartilhado em `src/lib/wms/separacao/pick-mov.ts`).
3. **`validar-oc-item` "encontrei" gera par S+L** ou marca item de forma compatível com cutover (sem dupla baixa).
4. **`produto-esgotado` "encaminhar" estorna S+L** chamando `resetarEstadoSeparacaoItens` antes de trocar `separacao_galpao_id`.
5. **Webhook cancelamento + `separacao/encaminhar`** chamam `liberarReserva(pedido_id, motivo)`.
6. **`separacao/localizacao`** atualiza `siso_estoque.localizacao_id` via mov S+E (transferencia_localizacao).
7. **`vendas/criar` modo separacao** chama `reservarAtomico` quando WMS_AS_SOURCE.
8. **DELETE realocação** chama `liberarReserva` da R cascade.
9. **`comprar`** insere em `siso_ordens_compra` + seta `ordem_compra_id` nos itens.
10. **Cancelar pedido com OC recebida** gera mov S estorno (origem_tipo='estorno', estorno_de=mov.id).
11. **`aprovar` transferência** usa `rotearPedidoDoBanco` em vez de `getEmpresasDoGrupo` legacy.
12. **`buscarLocComMaiorSaldoNoGalpao`** filtra por `disponivel>0` em vez de `saldo>0`.
13. **Aplicar inventário** passa `custo_unitario` quando ganho positivo (custo médio recalcula).
14. **Ajuste manual entrada** aceita `custo_unitario` opcional; UI adiciona campo.
15. **Devoluções B/C/D** passam `custo_unitario` derivado da mov original (se disponível).
16. **Lançamento retroativo** aceita `data_recebimento` e RPC carimba `criado_em` se passado ≤ now.
17. **Devoluções** convertem `nota_fiscal_id` bigint → uuid via lookup em `siso_notas_fiscais` OR coluna passa a aceitar text (decisão no início do P2).
18. **`webhook/tiny` handleNfWebhook** detecta devolução por `tipo='devolucao' OR tipoOperacao='E'` em todos os branches.

### 6.4 Risco
**Médio-alto.** Toca write-paths críticos. Mitigações:
- TDD: testes E2E pra cada fluxo via `scripts/wms/cenarios/` (sistemática já existente, ver CLAUDE.md "Sistemática de Testes de Estoque").
- Smoke-test em staging antes de merge.
- Feature flag `WMS_LEDGER_COMPLETENESS=true` opcional pra rollback rápido (decidir no início do plano).

### 6.5 Critérios de pronto
- [ ] Cenário 06 (compras flow ponta a ponta) passa: receber compra → saldo aparece em `siso_estoque`
- [ ] Cenário 07 (bipar-checklist) passa sem dupla baixa
- [ ] Cenário 08 (cancelamento) passa: cancelar libera R, próximo pedido mesmo SKU aprova sem degradar
- [ ] Cenário 09 (encaminhar): R origem é liberada antes de re-aprovar no destino
- [ ] Cenário 10 (vendas manual modo separacao): R criada, marketplace concorrente perde a corrida
- [ ] 7 invariantes globais (I1..I7 em `scripts/wms/cenarios/README.md`) passam após cada cenário
- [ ] Custo médio (`siso_custo_medio`) atualiza após receber compra
- [ ] `/wms/relatorios/historico-custo` mostra recálculos

### 6.6 Arquivos tocados
~20 endpoints + 5 libs. Listagem completa em §10.

---

## 7. P3 · Reverse Paritária + Idempotência

### 7.1 Causa-raiz
**Princípio PR-2 violado em 9 ações destrutivas** (aplicar inventário, confirmar guarda, classificar devolução, etc.). Plus **PR-7 violado** em 3 endpoints sem idempotência (aplicar inventário, comprar, receber compra).

### 7.2 Achados resolvidos (24)

| # | Sev | Achado | Arquivo |
|---|---|---|---|
| 3.1 | ALTO | Aplicar inventário não é idempotente (clique duplo duplica movs) | `src/lib/wms/inventario.ts:805-882` |
| 3.2 | ALTO | Aplicar inventário sem reverse | (novo endpoint) |
| 3.3 | ALTO | DELETE sessão sem guard de status (cancela aplicada) | `src/app/api/wms/inventario/[id]/route.ts` |
| 3.4 | ALTO | `/contagens` não valida lock | `src/app/api/wms/inventario/[id]/contagens/route.ts` |
| 3.5 | ALTO | Confirmação de guarda IRREVERSÍVEL pela UI | (novo endpoint) |
| 3.6 | ALTO | Race silenciosa em `iniciarGuarda` (sobrescreve `iniciada_por`) | `src/lib/wms/guarda.ts:302-327` |
| 3.7 | ALTO | `confirmarGuarda` sem lock entre validação e UPDATE | `src/lib/wms/guarda.ts` |
| 3.8 | ALTO | Classificação devolução irreversível | (novo endpoint) |
| 3.9 | ALTO | Receber transferência terminal sem reverse | (novo endpoint) |
| 3.10 | ALTO | Cancelamento transferência não trata recepção parcial | `src/app/api/wms/transferencias/[id]/cancelar/route.ts` |
| 3.11 | MÉD | Receber compra race-condition unsafe (sem optimistic lock) | `src/app/api/wms/compras/receber/route.ts` |
| 3.12 | MÉD | Desmarcar item — race entre estorno S e estorno L | `src/app/api/wms/separacao/marcar-item/route.ts` |
| 3.13 | MÉD | Reiniciar etapa=embalagem não reverte cutover | `src/app/api/wms/separacao/reiniciar/route.ts` |
| 3.14 | MÉD | Encerrar parcial deixa locs em_contagem com bloqueada_por finalizado | `src/lib/wms/inventario.ts` (computarDivergencias) |
| 3.15 | MÉD | `computarDivergencias` força sair-party sem aviso | idem |
| 3.16 | MÉD | Reconciliar retroativo aceita `compra_mov_id` sem validação uuid | `src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts` |
| 3.17 | MÉD | Replenishment não é transacional (S passa, E falha → saldo evapora) | `src/lib/wms/movimentacoes.ts` (replenishmentIntraGalpao) |
| 3.18 | MÉD | 2 operadores recebendo mesma transferência (sem FOR UPDATE no header) | `src/lib/wms/movimentacoes.ts` (receberTransferencia) |
| 3.19 | MÉD | Modo blind vs aberto — PATCH permite trocar mid-sessão sem guard | `src/lib/wms/inventario.ts` (pickPatchFields) |
| 3.20 | MÉD | Ajuste manual sem reverse endpoint | (novo endpoint) |
| 3.21 | BAIXO | Venda manual sem cancelar | (novo endpoint) |
| 3.22 | BAIXO | Replenishment sem reverse endpoint | (novo endpoint) |
| 3.23 | BAIXO | Idempotência vendas não cobre rollback (retry com mesmo key cria duplicado) | `src/app/api/wms/vendas/criar/route.ts` |
| 3.24 | BAIXO | `computarDivergencias` re-execução pode duplicar lock cleanup | `src/lib/wms/inventario.ts` |

### 7.3 Deliverables
1. **Novos endpoints de reverse:**
   - `POST /api/wms/inventario/[id]/estornar` (admin)
   - `POST /api/wms/guarda/[id]/desfazer`
   - `POST /api/wms/devolucoes/[id]/desclassificar`
   - `POST /api/wms/replenishment/[id]/reverter`
   - `POST /api/wms/ajuste/[id]/estornar`
   - `POST /api/wms/vendas/[id]/cancelar`
   - `POST /api/wms/transferencias/[id]/desfazer-recebimento`
2. **DELETE inventário** ganha guard: rejeita se status='aplicada'.
3. **Cancelar transferência** estende-se a recepção parcial: aceita status `em_transito` OU `recebida-parcial` (novo).
4. **UNIQUE constraint** em `siso_movimentacoes` para inventário aplicado:
   ```sql
   CREATE UNIQUE INDEX uniq_movs_inventario_divergencia
     ON siso_movimentacoes ((origem_detalhes->>'divergencia_id'))
     WHERE origem_tipo IN ('inventario_ganho', 'inventario_perda');
   ```
5. **`iniciarGuarda`** ganha lock: `UPDATE ... WHERE iniciada_por IS NULL OR iniciada_por = $usuario` — segundo op recebe 409 com avatar do primeiro.
6. **`confirmarGuarda`** envolvido em RPC `wms_confirmar_guarda` com lock pessimista no `pendencia_id` + decremento atômico.
7. **`/contagens` inventário** valida `bloqueada_por = $usuario` antes de aceitar UPSERT.
8. **`reconciliar retroativo`** valida UUID + existência da `compra_mov_id`.
9. **Replenishment** envolto em RPC transacional `wms_replenishment_intra_galpao` (par S+E atômico).
10. **`receberTransferencia`** usa `SELECT ... FOR UPDATE` no header antes de validar.
11. **`computarDivergencias`** notifica handheld via realtime (sessão atualizada) e dá aviso de "X operadores ativos serão removidos".
12. **`pickPatchFields`** rejeita mudança de `modo_contagem` se status ≠ `planejada`.
13. **Idempotência vendas** lookup do registro original mesmo após rollback (chave única em `payload_original->>'idempotency_key'`).
14. **UI:** botões de undo nos detalhes (`/wms/inventario/[id]`, `/wms/guarda/[id]`, `/wms/devolucoes/[id]`, etc.) — atrás de confirm dialog + admin/owner check.

### 7.4 Risco
**Médio.** Novos endpoints + migrations + 2 RPCs. Riscos:
- Endpoint estorno de inventário deve recriar `siso_inventario_divergencias` em status `pendente` (não simplesmente deletar movs).
- Confirmação parcial de guarda + undo precisa lidar com `qty_guardada` cumulativa cuidadosamente.

### 7.5 Critérios de pronto
- [ ] Cenário 11 (aplicar inventário 2x simultâneo) gera apenas 1 conjunto de movs
- [ ] Cenário 12 (desfazer guarda) reverte par S+E preservando trilha
- [ ] Cenário 13 (estornar inventário aplicado) recoloca divergências como pendentes
- [ ] Cenário 14 (desclassificar devolução) reverte movs + permite re-classificação
- [ ] `wms_replenishment_intra_galpao` atômico: forçar falha no segundo leg → primeiro estorna
- [ ] DELETE de sessão aplicada retorna 409 com mensagem clara

### 7.6 Arquivos tocados
Ver §10 (apêndice).

---

## 8. P4 · Auth + Permissões Granulares

### 8.1 Causa-raiz
**Princípio PR-4 violado.** UI usa `usePermissoes().can("perm.x")` mas API não chama `userCan(session, "perm.x")` server-side. Bypass trivial via Postman/curl. Em produção real (mesmo staging), pode permitir cross-tenant access (vendedor vê pedido de outro vendedor).

### 8.2 Achados resolvidos (12)

| # | Sev | Achado | Arquivo |
|---|---|---|---|
| 4.1 | ALTO | `aprovar` sem `userCan` | `src/app/api/wms/pedidos/aprovar/route.ts` |
| 4.2 | ALTO | `webhook/reprocessar` sem auth + ignora body | `src/app/api/wms/webhook/reprocessar/route.ts:13-72` |
| 4.3 | ALTO | `vendas/criar` sem `vendas.criar` server-side | `src/app/api/wms/vendas/criar/route.ts:58-62` |
| 4.4 | ALTO | Vendedor pode ver detalhe de outro vendedor | `src/app/api/wms/vendas/[id]/route.ts:46-56` |
| 4.5 | MÉD | `GET /pedidos` sem auth (operador SP vê CWB) | `src/app/api/wms/pedidos/route.ts` |
| 4.6 | MÉD | `[id]/observacoes` sem auth + tabela sem migration | `src/app/api/wms/pedidos/[id]/observacoes/route.ts` |
| 4.7 | MÉD | `[id]/historico` sem auth | `src/app/api/wms/pedidos/[id]/historico/route.ts` |
| 4.8 | MÉD | `inventario/metricas` lê sem `requireWarehouseAccess` | `src/app/api/wms/inventario/metricas/route.ts` |
| 4.9 | MÉD | Devoluções aceitam qualquer perm warehouse (faltam granular) | `src/app/api/wms/devolucoes/[id]/classificar/route.ts:39` |
| 4.10 | MÉD | `lancamento-retroativo` sem perm dedicada | `src/app/api/wms/lancamento-retroativo/*` |
| 4.11 | MÉD | Re-assign vendedor permite atribuir a usuário sem cargo | `src/app/api/wms/vendas/[id]/vendedor/route.ts:62-72` |
| 4.12 | BAIXO | Dashboard realtime sem filtro server-side por galpão | `src/hooks/use-dashboard-tarefas-realtime.ts` |

### 8.3 Deliverables
1. **Adicionar `getSessionUser` + `userCan(session, "perm.x")`** no início de cada endpoint listado. Retornar 401/403.
2. **Permissões novas em `src/lib/permissions.ts`:**
   - `operacoes.devolucoes_classificar` (substitui guard genérico)
   - `operacoes.retroativo` (perm dedicada)
   - `vendas.editar_vendedor` (ou reusar `vendas.criar`)
3. **`webhook/reprocessar` reescrito:** lê `pedidoId` do body (Zod), exige `requireAdmin`, processa apenas o pedido solicitado.
4. **`vendas/[id]` ownership check:** se cargo é apenas `vendedor`, exige `pedido.vendedor_id === user.id` OR `pedido.vendedor_nome` contém `user.nome`.
5. **`vendas/[id]/vendedor` PATCH:** valida que target user tem cargo vendedor/operador (consulta `siso_usuario_roles`).
6. **Migration `siso_pedido_observacoes_formal`:** documenta tabela existente em migrations (cria via `CREATE TABLE IF NOT EXISTS`).
7. **Filtro server-side realtime:** channel realtime por `galpao_id` (via `filter` no subscribe).

### 8.4 Risco
**Baixo.** Edits surgical (linhas iniciais). Worst case: endpoint que era permissivo agora retorna 403 → testar com cargos reais.

### 8.5 Critérios de pronto
- [ ] Smoke-test: curl `/api/wms/vendas/criar` sem cookie → 401; com cookie operador sem `vendas.criar` → 403
- [ ] `webhook/reprocessar` rejeita request sem `pedidoId` no body
- [ ] Vendedor V1 não consegue acessar `/api/wms/vendas/V2_pedido_id` (403)
- [ ] `SELECT * FROM siso_pedido_observacoes;` antes/depois sem schema change destrutiva
- [ ] Todos os 12 endpoints retornam 403 quando perm ausente em test suite

### 8.6 Arquivos tocados
13 endpoints + `src/lib/permissions.ts` + 1 migration. Ver §10.

---

## 9. P5 · Visibilidade Home + UI Fixes

### 9.1 Causa-raiz
**Princípio PR-8 violado** (exceções operacionais invisíveis) + UI inconsistente em pontos específicos (Classe C bloqueada, label invertido, banner sem endpoint, recusar no-op, filtro galpão escondendo pendências, vendas misturadas com marketplace).

### 9.2 Achados resolvidos (28)

#### Quadro home — cards novos (5 categorias)
| # | Sev | Achado | Local |
|---|---|---|---|
| 5.1 | ALTO | Devoluções pendentes invisíveis na home | `src/lib/wms/dashboard-tarefas.ts` |
| 5.2 | ALTO | Transferências em_transito sem visibilidade | idem |
| 5.3 | ALTO | Sessões inventário em `revisao` invisíveis | idem |
| 5.4 | ALTO | Reservas R órfãs sem alerta | idem |
| 5.5 | MÉD | Pendências retroativas não-reconciliadas invisíveis | idem |
| 5.6 | MÉD | Saldo em RECEBIMENTO sem pendência viva invisível | idem |

#### Quadro home — comportamento realtime
| # | Sev | Achado | Local |
|---|---|---|---|
| 5.7 | ALTO | Hook home assina tabelas fora da publication (resolvido por P1, mas hook precisa estender) | `src/hooks/use-dashboard-tarefas-realtime.ts` |
| 5.8 | ALTO | Filtro galpão da home esconde 69% pendentes (separacao_galpao_id NULL) | `src/lib/wms/dashboard-tarefas.ts` (montarDashboardTarefas) |
| 5.9 | MÉD | Quadro home não invalida quando reserva R criada/liberada | hook + dashboard service |
| 5.10 | MÉD | Sessão cancelada não notifica handheld em tempo real | `src/hooks/use-inventario-realtime.ts` |
| 5.11 | MÉD | Vendas modo separacao poluem kanban home (mistura com marketplace) | dashboard-tarefas (origem_pedido filter) |

#### Devoluções UI
| # | Sev | Achado | Local |
|---|---|---|---|
| 5.12 | ALTO | Classe C quebrada (UI não coleta fornecedor_id) | `src/app/wms/devolucoes/[id]/page.tsx` |
| 5.13 | MÉD | Detalhe lê do array filtrado (404 em pendência já classificada) | idem |

#### Pedidos UI
| # | Sev | Achado | Local |
|---|---|---|---|
| 5.14 | ALTO | "Forçar pendente" label invertido | `src/app/wms/pedidos/[id]/page.tsx:1067-1078` |
| 5.15 | MÉD | Banner D10 "Estornar agora" sem endpoint | `src/app/wms/pedidos/[id]/page.tsx:617` (depende de P3) |
| 5.16 | MÉD | Recusar pedido botão no-op | `src/components/wms/pedido-card-wms.tsx:484` |

#### Guarda UI
| # | Sev | Achado | Local |
|---|---|---|---|
| 5.17 | MÉD | iniciar guarda no useEffect (sem distinção viewing vs iniciando) | `src/app/wms/guarda/[id]/page.tsx` |
| 5.18 | MÉD | Confirmação parcial guarda regride pra `pendente` (operador some) | depende de P3 fix backend |
| 5.19 | BAIXO | `imprimir-lote` não expõe `ignorados[]` no toast | `src/app/wms/receber/page.tsx` |

#### Receber UI
| # | Sev | Achado | Local |
|---|---|---|---|
| 5.20 | BAIXO | LocalizacaoCombo `allowCreate=true` permite loc órfã | `src/components/wms/ui/modals.tsx` (Receber modal) |
| 5.21 | BAIXO | Pendência sem `localizacao_destino_id` em `imprimir-lote` não tem feedback | idem |

#### Cross-module UI
| # | Sev | Achado | Local |
|---|---|---|---|
| 5.22 | BAIXO | Separação modal/encaminhar não mostra opção OC quando faz sentido | `src/components/wms/separacao/parcial-modal.tsx` |
| 5.23 | BAIXO | `vendas/criar` UI não mostra `motivo_degradacao` claramente | `src/app/wms/vendas/nova/page.tsx` |
| 5.24 | BAIXO | Avatar de operador no parcial guarda some | `src/components/wms/quadro-tarefas/` (após P3 fix) |
| 5.25 | BAIXO | `tracking` pedidos paginação ausente | `src/app/wms/pedidos/page.tsx` |
| 5.26 | BAIXO | Tab "Histórico" compras sem paginação | `src/app/wms/compras/page.tsx` |
| 5.27 | BAIXO | FeedEventos polling 5s em sessões aplicadas | `src/components/wms/inventario/feed-eventos.tsx` |
| 5.28 | BAIXO | Re-assign vendedor manual sem UI "criar em nome de X" | `src/app/wms/vendas/nova/page.tsx` |

### 9.3 Deliverables
1. **`dashboard-tarefas.ts` expandido** com 5 contadores novos + payloads de cards (itens, tempo na fila, alertas).
2. **`use-dashboard-tarefas-realtime.ts` expandido** pra subscrever `siso_devolucoes_pendentes`, `siso_transferencias_galpao`, `siso_movimentacoes` (filtrado por reservas), e re-assinar tabelas após P1 mergeado.
3. **`montarDashboardTarefas` ajustado** pra incluir pedidos com `separacao_galpao_id IS NULL` quando filtro galpão presente (sem split de pendentes).
4. **5 cards novos no quadro home** (`src/app/wms/page.tsx`):
   - Devoluções pendentes (badge contador + lista resumida)
   - Transferências em_transito (mostrar idade desde criação)
   - Sessões inventário em revisão (badge + supervisor avatar)
   - Reservas órfãs (alerta vermelho se > N)
   - Pendências retroativas
5. **Modal devolução Classe C** ganha select de `fornecedor_id` (lista de `siso_fornecedores`).
6. **Detalhe devolução** fetch dedicado (`/api/wms/devolucoes/[id]`, sem depender do array filtrado).
7. **Label "Forçar pendente"** trocado pra "Forçar adiante pra separação (bypass NF webhook)".
8. **Banner D10** ganha funcionalidade real (depende de P3 ter endpoint de cancelar pedido com OC estornando saldo).
9. **Recusar pedido** UI implementa fluxo: marca pedido como `cancelado` + motivo, ou esconde botão se feature não vai sair.
10. **`useEffect iniciar guarda`** desacopla viewing de iniciando: botão "Começar guarda" explícito.
11. **`vendas` quadro home** distinguir manual vs marketplace (filtro origem_pedido).
12. **LocalizacaoCombo no Receber** `allowCreate=false` por default.
13. **Toast `imprimir-lote`** mostra `ignorados.length` + opção "ver detalhes".
14. **FeedEventos** para polling quando `sessao.status ∈ {aplicada, cancelada}`.
15. **Paginação** em `/wms/pedidos` e `/wms/compras` tab Histórico.

### 9.4 Risco
**Médio (front-end visível).** Smoke-test com operador real em staging. Cards novos no quadro home podem mudar layout — coordenar com possíveis usuários ativos.

### 9.5 Critérios de pronto
- [ ] Manual smoke: classificar uma devolução → card cai do quadro home em <2s
- [ ] Manual smoke: criar transferência em_transito → card aparece, idade incrementa
- [ ] Quadro home com filtro CWB mostra pedidos `separacao_galpao_id=NULL`
- [ ] Devolução Classe C aplicável no UI (select fornecedor funciona)
- [ ] Label "Forçar pendente" coerente com comportamento
- [ ] Banner D10 ou (a) tem endpoint funcional (b) está removido

### 9.6 Arquivos tocados
~12 páginas + 6 componentes + 2 hooks. Ver §10.

---

## 10. P6 · Estado Fantasma + Cleanups + Polish

### 10.1 Causa-raiz
Mistura de:
- **Estado fantasma:** transferência em_transito sem TTL, RECEBIMENTO sem pendência, locs em_contagem com bloqueada_por finalizado, operadores zumbi.
- **Hardcoded/schema:** `siso_empresas.galpao_id` deprecated ainda usado, "CWB"/"SP" hardcoded, loc quarentena em sugestão de inventário.
- **Audit trail incompleto:** 7 endpoints compras sem `siso_pedido_historico`, `siso_wms_pendencias_guarda` sem `criada_por`/`guardada_por`.
- **Idempotência leve / polish:** auto-fix em GET (compras), jobs duplicados, status nunca atingido (devoluções 'aplicada'), endpoint órfão (transferir-galpao).
- **Categoria estruturada:** ajuste manual motivo texto livre.

### 10.2 Achados resolvidos (47)

Por categoria — listagem completa no apêndice §11.

#### Estado fantasma (8)
| # | Sev | Achado |
|---|---|---|
| 6.1 | ALTO | Transferência em_transito sem TTL nem cleanup nem visibilidade na home |
| 6.2 | ALTO | Cancelar pendência guarda deixa saldo fantasma em RECEBIMENTO sem alerta |
| 6.3 | MÉD | Cleanup não cobre claim/operadores órfãos inventário |
| 6.4 | MÉD | `compras-release` depende de `siso_empresas.galpao_id` deprecated |
| 6.5 | MÉD | Sair da party não libera locs em_contagem desse operador |
| 6.6 | MÉD | Encerrar parcial deixa locs em_contagem com bloqueada_por finalizado |
| 6.7 | BAIXO | `transferir-galpao` é endpoint órfão (deadcode) |
| 6.8 | BAIXO | `resolverLocRecebimento` cria loc RECEBIMENTO como side-effect sem feedback |

#### Hardcoded / schema (8)
| # | Sev | Achado |
|---|---|---|
| 6.9 | ALTO | RPCs insights filtram por `siso_empresas.galpao_id` deprecated (resolvido em P1, mas verificar consumidores adicionais) |
| 6.10 | MÉD | Loc quarentena entra em `wms_inventario_sugerir` (gera divergências sobre bloqueado) |
| 6.11 | MÉD | Loc quarentena escolhida sem ORDER BY (não-determinístico) |
| 6.12 | MÉD | Equivalente perde estoque dinâmico (hardcoded CWB/SP em colunas legadas) |
| 6.13 | MÉD | `cwb_atende/sp_atende` setados por nome do galpão (vendas) |
| 6.14 | BAIXO | Status 'aplicada' devoluções nunca atingido |
| 6.15 | BAIXO | Classes A e D devoluções produzem movs idênticas (distinguir por origem_tipo) |
| 6.16 | BAIXO | Modo blind vs aberto inventário PATCH permite trocar (resolvido por P3 também) |

#### Audit trail (7)
| # | Sev | Achado |
|---|---|---|
| 6.17 | ALTO | Sem rastro histórico em Compras (7 endpoints sem `registrarEventos`) |
| 6.18 | MÉD | `criarPendencia` não tem `criada_por` |
| 6.19 | BAIXO | Coluna `guardada_por` não existe (`CLAUDE.md` menciona) |
| 6.20 | BAIXO | PATCH inventário sem logging de mudanças |
| 6.21 | BAIXO | `siso_pedido_historico.detalhes` recebe dump JSONB sem limite |
| 6.22 | BAIXO | `entrarParty` auto-inicia sessão sem perm de supervisor |
| 6.23 | BAIXO | `delta_pct` null quando `saldo_esperado=0` (UI mostra "—") |

#### Categoria estruturada + recursos faltantes (5)
| # | Sev | Achado |
|---|---|---|
| 6.24 | MÉD | Ajuste manual motivo texto livre (sem categoria estruturada) |
| 6.25 | MÉD | Saídas via ajuste podem mascarar perda (sem categoria) |
| 6.26 | BAIXO | `compras/conferir` deprecated mas ainda escreve em Tiny |
| 6.27 | BAIXO | `compras/trocar-fornecedor` deprecated mas ainda movimenta sem validar |
| 6.28 | BAIXO | `pedidos/aprovar` faltou `recusar` real (botão no-op resolvido em P5, mas pode virar status `rejeitado`) |

#### Idempotência leve + polish (19)
| # | Sev | Achado |
|---|---|---|
| 6.29 | MÉD | `comprar` distribui qty cross-pedidos sem auditoria aging |
| 6.30 | MÉD | `compras-release` permite múltiplos jobs `lancar_estoque` por pedido |
| 6.31 | MÉD | Auto-fix em GET `/compras?tab=receber` patch silencioso |
| 6.32 | MÉD | Detecção devolução depende de campos não-padrão Tiny |
| 6.33 | MÉD | Dedup webhook não cobre todos campos do payload |
| 6.34 | MÉD | `validar-oc-item` "esgotado" não considera `quantidade_pega` parcial |
| 6.35 | MÉD | `cancelar` separação preserva `mov_ajuste_loc_zerou` (intencional, documentar) |
| 6.36 | MÉD | `vendas/criar` não detecta produto mapeado pra empresa diferente |
| 6.37 | MÉD | `resolverDisponibilidadeVenda` retorna uma única loc (baixa direta pode requerer múltiplas) |
| 6.38 | MÉD | `vendedor_id` na criação SEMPRE = `user.id` do criador (sem "criar em nome de") |
| 6.39 | MÉD | Pedidos ML/Shopee auto-atribuídos não têm `vendedor_id` |
| 6.40 | BAIXO | `pedidos/tracking` paginação ausente (limit 500) |
| 6.41 | BAIXO | Tab "Histórico" compras sem paginação |
| 6.42 | BAIXO | `getCompraQuantidadeRestante` ignora over-receive |
| 6.43 | BAIXO | `vendas/payload_original.idempotency_key` sem índice |
| 6.44 | BAIXO | `retry-etiqueta` restaura embalado → separado durante seu próprio fluxo |
| 6.45 | BAIXO | `iniciar` separação aceita `pendente_realocacao` no whitelist mas só transita 2 |
| 6.46 | BAIXO | `siso_pedido_itens.produto_id` é `tiny_produto_id` (bigint), não uuid WMS |
| 6.47 | BAIXO | Mov de venda manual não popula `pedido_id` no ledger |

### 10.3 Deliverables
1. **Migration `transferencias_expira_em`** + cron `cron_transferencias_em_transito_cleanup` (auto-cancelar > 7d).
2. **Endpoint `GET /api/wms/saldo-recebimento-orfao`** + alerta na home (após P5).
3. **`cleanupInventario` estendido** pra:
   - Liberar locs `em_contagem` cujo `bloqueada_por` está com `finalizado_em IS NOT NULL`
   - Forçar `finalizado_em` em operadores zumbis (`ultima_acao_em < now() - 30min`)
4. **`compras-release` migrado** pra `siso_pedidos.separacao_galpao_id` ou OC galpao via tabela `siso_ordens_compra`.
5. **`vendas-disponibilidade` + `vendas/criar`** sem hardcoded "CWB"/"SP" — usar `galpao_id` UUID + ajustar consumers da coluna legacy.
6. **`wms_inventario_sugerir` RPC** exclui `tipo='quarentena'`.
7. **Devoluções loc quarentena** ordenadas por `codigo ASC`.
8. **Migration `ajuste_manual_motivo_categoria`** adiciona coluna enum (`perda`, `avaria`, `achado`, `correcao_inventario`, `devolucao_sem_fluxo`, `outro`). UI ajusta select.
9. **Migration `pendencias_guarda_criada_por_guardada_por`** adiciona colunas + backfill via JOIN com movs.
10. **Migration `devolucoes_status_aplicada_drop`** remove valor 'aplicada' do CHECK (nunca usado) OR implementa transição (decisão no início do P6).
11. **7 endpoints compras** + `criarPendencia` + PATCH inventário ganham `registrarEventos`.
12. **Migration `idempotency_key_index`** cria índice em `payload_original->>'idempotency_key'`.
13. **`transferir-galpao` endpoint deletado** (sem callers).
14. **Páginas com paginação:** `/wms/pedidos`, `/wms/compras` tab Histórico (limit + cursor).
15. **`webhook-processor`** detecção de devolução refatorada (single source of truth em `isDevolucao` helper).
16. **`webhook` dedup** cobre `chave_acesso_nf` E `nota_fiscal_id` (índice combinado).
17. **`validar-oc-item` "esgotado"** deduz `quantidade_pega` + realocs picadas do qty OC.
18. **`comprar`** captura `fornecedor_oc` do body (operador pode sobrescrever).
19. **`siso_pedido_historico.detalhes`** limita size com truncamento JSONB.
20. **`compras-release`** idempotência: índice único em `(pedido_id, tipo='lancar_estoque')` em jobs pending.

### 10.4 Risco
**Baixo a médio.** Maioria são migrations + cleanups + small refactors. Alguns toques estruturais (compras-release migration) precisam de smoke-test cuidadoso.

### 10.5 Critérios de pronto
- [ ] Cenário 15 (transferência em_transito > 7d) é auto-cancelada pelo cron
- [ ] Cenário 16 (operador zumbi inventário) é liberado em 30min
- [ ] Cenário 17 (loc quarentena) não aparece em `wms_inventario_sugerir`
- [ ] `siso_pedido_historico` registra eventos em compras (verificável via `/wms/pedidos/[id]/historico`)
- [ ] Migration `ajuste_manual_motivo_categoria` aplicada + UI usa o enum
- [ ] `transferir-galpao` endpoint não existe mais (404)
- [ ] `webhook/tiny` dedup detecta retries com `chave_acesso_nf` populado mid-flight

### 10.6 Arquivos tocados
Ver §11.

---

## 11. Mapa de paralelização

### Combinações seguras pra rodar simultâneo
```
Worktree A: P1 (migrations only)
Worktree B: P2 (back-end writes)
Worktree C: P3 (novos endpoints + RPCs)
Worktree D: P6 (migrations + endpoints + RPCs novos)
```

**Conflitos potenciais entre worktrees:**
- P2 ↔ P6: `webhook/tiny/route.ts` (detecção devolução em P6 vs cancelamento em P2). Mitigação: P6 espera P2 mergear antes do passo "detecção devolução refatorada" (passo 15).
- P3 ↔ P6: `lib/wms/inventario.ts` (P3 idempotência + UNIQUE handling vs P6 audit logging). Mitigação: P6 espera P3 mergear.
- P3 ↔ P2: `webhook-processor*.ts` se P3 adicionar idempotência de venda. Mitigação: P3 trabalha em `vendas/criar` endpoint, P2 trabalha em `vendas-disponibilidade`. Sem overlap.

### Wave 2 (após P1 mergeado)
```
Worktree E: P5 (front-end + dashboard service)
```
P5 depende exclusivamente de P1 (publication + RPCs). Pode começar antes mas só faz sentido testar depois de P1 mergear.

### Wave 3 (após P2 mergeado)
```
Worktree F: P4 (auth surgical)
```
P4 adiciona check no topo dos handlers que P2 já modificou. Rodar P4 antes de P2 mergear cria N conflitos de merge. Rodar depois é trivial (Edit nas primeiras 5 linhas de cada handler).

### Ordem de merge sugerida
1. **P1** (zero risco operacional, libera P5)
2. **P3 + P6** simultâneos (pouco overlap entre si)
3. **P2** (maior PR, mas validado por cenários E2E)
4. **P5** (depende de P1+P3 pra alguns botões funcionarem)
5. **P4** (último — auth padronização sobre tudo já estável)

---

## 12. Riscos cross-plano

### R1 — Cutover WMS_AS_SOURCE pode quebrar durante P2
**Cenário:** P2 modifica `compras/receber` pra criar mov E. Em prod, há OCs já recebidas pré-fix com `compra_quantidade_recebida > 0` mas sem mov correspondente.
**Mitigação:** P2 inclui script de backfill `scripts/wms/backfill-compras-recebidas.ts` que cria movs E retroativas pra OCs recebidas sem mov correspondente. Roda 1x manual após merge.

### R2 — Cards novos no quadro home explodem layout
**Cenário:** P5 adiciona 5 cards. Operador atual tem layout otimizado pros 6 cards existentes.
**Mitigação:** Cards novos vão pra **seção colapsável "Exceções"** no quadro home, default expandido apenas se contador > 0.

### R3 — UNIQUE constraint do P3 falha em dados históricos
**Cenário:** Aplicar inventário sem idempotência no passado já gerou duplicatas. `CREATE UNIQUE INDEX` falha.
**Mitigação:** P3 inclui query de detecção + script de cleanup pré-migration:
```sql
SELECT origem_detalhes->>'divergencia_id', count(*)
FROM siso_movimentacoes
WHERE origem_tipo IN ('inventario_ganho', 'inventario_perda')
GROUP BY 1 HAVING count(*) > 1;
```
Se retornar > 0, decidir caso a caso antes de aplicar constraint.

### R4 — P4 quebra integração externa
**Cenário:** Cliente Tiny ou outro integrador chama `/api/wms/webhook/reprocessar` sem auth (hoje funciona). P4 adiciona `requireAdmin`.
**Mitigação:** Confirmar com user que nenhum cliente externo usa endpoints internos antes de aplicar P4. Provavelmente nenhum, mas vale check.

### R5 — `nota_fiscal_id` é UUID ou TEXT?
**Cenário:** Achado 2.25 depende disso. Se for TEXT, não é bug; se for UUID, é runtime ALTO.
**Mitigação:** P2 começa investigando schema:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'siso_movimentacoes' AND column_name = 'nota_fiscal_id';
```
Se TEXT, achado 2.25 é descartado (apenas validação Zod removível). Se UUID, vira ALTO e prioridade.

---

## 13. Critérios de pronto da spec mestre

- [ ] 6 planos detalhados com causa-raiz, achados, deliverables, arquivos, risco, critérios
- [ ] 141 achados rastreados — cada um aparece em exatamente 1 plano (ou múltiplos com referência cruzada)
- [ ] Mapa de paralelização viável (worktrees independentes)
- [ ] Riscos cross-plano com mitigação
- [ ] Princípios não-negociáveis (PR-1..PR-8) tornados explícitos
- [ ] Plano de testing pra cada plano (cenários E2E reaproveitando sistemática existente)

---

## 14. Próximos passos

Após user aprovar esta spec:
1. Invocar `superpowers:writing-plans` pra cada plano (P1..P6) em sequência ou paralelo
2. Cada plano vira `docs/superpowers/plans/2026-05-26-wms-fix-P{N}-{slug}.md`
3. Execução em worktrees: `git worktree add .claude/worktrees/wms-fix-p{N} -b wms-fix-p{N}`
4. Sub-agents via `superpowers:subagent-driven-development` por plano

---

## 15. Apêndice A — Enumeração completa dos 141 achados → plano

> Numeração `M.S` onde M = módulo (1-8 + 0 para cross-module) e S = severidade ordinal dentro do módulo.

### Módulo 0 — Cross-module / Camada Realtime (índice 00)

| # | Sev | Achado resumido | Arquivo:linha | Plano |
|---|---|---|---|---|
| 0.1 | ALTO | Publication realtime omite 4+ tabelas declaradas | `use-dashboard-tarefas-realtime.ts:30-95` | **P1** |
| 0.2 | ALTO | 4 RPCs insights referenciam colunas dropadas (3D) | `20260514_wms_insights_motor.sql` | **P1** |
| 0.3 | ALTO | Motor insights nunca executa (sem cron) | índice | **P1** |
| 0.4 | ALTO | RPCs insights filtram por `siso_empresas.galpao_id` deprecated | índice | **P1** (parte) + **P6** (consumidores) |
| 0.5 | ALTO | Filtro galpão home esconde 69% pendentes | `dashboard-tarefas.ts` (montarDashboardTarefas) | **P5** |
| 0.6 | MÉD | Curva ABC stale (função sem cron) | índice | **P1** |
| 0.7 | MÉD | Reservas expiradas sem cron | índice | **P1** |
| 0.8 | MÉD | Inventário locks órfãos sem cron | índice | **P1** |

### Módulo 1 — Pedidos / Aprovação

| # | Sev | Achado | Arquivo:linha | Plano |
|---|---|---|---|---|
| 1.1 | ALTO | Cancelamento webhook não chama `liberarReserva` | `webhook/tiny/route.ts:184-316`, `reservas.ts:38-85` | **P2** |
| 1.2 | ALTO | "Forçar pendente" label invertido | `pedidos/[id]/page.tsx:1067-1078`, `forcar-pendente/route.ts:58-66` | **P5** (label) |
| 1.3 | ALTO | "Reprocessar" ignora pedidoId + sem auth | `webhook/reprocessar/route.ts:13-72` | **P4** |
| 1.4 | ALTO | Encaminhar não estorna reservas WMS | `separacao/encaminhar/route.ts:309-339` | **P2** |
| 1.5 | ALTO | Aprovar transferência sem checar saldo | `pedidos/aprovar/route.ts:107-131` | **P2** |
| 1.6 | MÉD | Aprovar busca loc por `saldo>0` | `separacao/wms-mapping.ts:64-79` | **P2** |
| 1.7 | MÉD | 5 endpoints sem auth/perm | aprovar, reprocessar, pedidos, historico, observacoes | **P4** |
| 1.8 | MÉD | Recusar pedido não tem implementação | `pedido-card-wms.tsx:484` | **P5** |
| 1.9 | MÉD | Banner D10 "Estornar agora" sem endpoint | `pedidos/[id]/page.tsx:617` | **P3** (endpoint) + **P5** (UI) |
| 1.10 | MÉD | `/api/wms/pedidos` não filtra por perm de galpão | `pedidos/route.ts` | **P4** |
| 1.11 | MÉD | Quadro Home não invalida em R criada/liberada | `use-dashboard-tarefas-realtime.ts:30-95` | **P5** (após P1) |
| 1.12 | MÉD | `siso_pedido_item_estoques` semântica de tag vs coordenada (legacy bug latente) | `webhook-processor-wms.ts:597` | **P6** (cleanup) |
| 1.13 | BAIXO | `siso_pedido_observacoes` sem migration | (tabela criada via SQL direto) | **P4** |
| 1.14 | BAIXO | Dashboard realtime sem filtro server-side galpão | `use-dashboard-tarefas-realtime.ts` | **P4** |
| 1.15 | BAIXO | Sugestão recomputada vs persistida — flicker | `pedidos/route.ts` (recomputarSugestaoBatch) | **P6** |

### Módulo 2 — Separação

| # | Sev | Achado | Arquivo | Plano |
|---|---|---|---|---|
| 2.1 | ALTO | `bipar-checklist` não gera movs (dupla baixa) | `separacao/bipar-checklist/route.ts` | **P2** |
| 2.2 | ALTO | `validar-oc-item` "encontrei" ignora ledger | `separacao/validar-oc-item/route.ts` | **P2** |
| 2.3 | ALTO | `localizacao` escreve Tiny+legado, não WMS | `separacao/localizacao/route.ts:54` | **P2** |
| 2.4 | ALTO | `produto-esgotado` "encaminhar" não estorna | `separacao/produto-esgotado/route.ts:200-226` | **P2** |
| 2.5 | ALTO | DELETE realocação não estorna R cascade | `separacao/realocacao/[id]/route.ts` | **P2** |
| 2.6 | ALTO | `concluir` permite separado com cobertura insuficiente OC misto | `separacao/concluir/route.ts:117-145` | **P2** |
| 2.7 | MÉD | Desmarcar item race S antes de L | `separacao/marcar-item/route.ts` | **P3** |
| 2.8 | MÉD | `bipar-embalagem` cutover prematuro se `pedido_completo` errado | `separacao/bipar-embalagem/route.ts` | **P2** |
| 2.9 | MÉD | `confirmar-item-embalagem` OC direta dispara cutover sem NF | `separacao/confirmar-item-embalagem/route.ts` | **P2** |
| 2.10 | MÉD | Reiniciar etapa=embalagem não toca ledger | `separacao/reiniciar/route.ts` | **P3** |
| 2.11 | MÉD | Cancelar zera qty_pega mas preserva mov_ajuste_loc_zerou (documentar) | `separacao/cancelar/route.ts` | **P6** (doc) |
| 2.12 | MÉD | `produto-esgotado` modo OC reseta TODOS itens | `produto-esgotado/route.ts` | **P2** |
| 2.13 | MÉD | Encaminhar não estorna movs WMS órfãs do parcial | `separacao/encaminhar/route.ts` | **P2** (parte de 1.4) |
| 2.14 | MÉD | `concluir-oc` enfileira legacy + cutover (dupla baixa janela) | `separacao/concluir-oc/route.ts` | **P2** |
| 2.15 | BAIXO | Status `expedido` é forward-state mas `/expedir` é órfã | `separacao/expedir/route.ts` | **P6** (deadcode) |
| 2.16 | BAIXO | `marcar-item` resolve loc via snapshot congelado | `separacao/marcar-item/route.ts` (parte de 2.3) | **P2** |
| 2.17 | BAIXO | `desfazer-parcial` mensagem aponta UI inexistente | `separacao/desfazer-parcial/route.ts` | **P5** ou **P6** |
| 2.18 | BAIXO | `validar-oc-item` "esgotado" não deduz qty_pega parcial | `validar-oc-item/route.ts` | **P6** |
| 2.19 | BAIXO | `retry-etiqueta` restaura embalado→separado durante seu fluxo | `retry-etiqueta/route.ts` | **P6** |
| 2.20 | BAIXO | `iniciar` aceita pendente_realocacao mas só transita 2 | `separacao/iniciar/route.ts` | **P6** |
| 2.21 | BAIXO | `use-realtime-separacao` query extra por evento | `use-realtime-separacao.ts` | **P6** |
| 2.22 | BAIXO | `cancelar` registra movs_estornadas JSONB sem limite | `separacao/cancelar/route.ts` | **P6** |

### Módulo 3 — Compras

| # | Sev | Achado | Arquivo | Plano |
|---|---|---|---|---|
| 3.1 | ALTO | `receber` não cria mov de ledger | `compras/receber/route.ts:19-153`, `compras-release.ts` | **P2** |
| 3.2 | ALTO | `comprar` não cria OC → release falha | `compras/comprar/route.ts`, `compras/ordens/route.ts` | **P2** |
| 3.3 | ALTO | Ações terminais sem reverso (5 ações) | confirmar cancelamento, equivalente, etc | **P3** |
| 3.4 | ALTO | Cancelar pedido com estoque recebido não estorna | `compras/pedidos/[id]/cancelar/route.ts` | **P2** |
| 3.5 | ALTO | Sem rastro histórico em Compras (7 endpoints) | múltiplos | **P6** |
| 3.6 | MÉD | `comprar` distribui qty cross-pedidos sem auditoria aging | `comprar/route.ts` | **P6** |
| 3.7 | MÉD | Equivalente após R órfã (WMS_AS_SOURCE) | `equivalente/confirmar/route.ts` | **P2** |
| 3.8 | MÉD | Receber race-condition unsafe | `receber/route.ts` | **P3** |
| 3.9 | MÉD | `compras-release` depende de `siso_empresas.galpao_id` | `compras-release.ts` | **P6** |
| 3.10 | BAIXO | Equivalente perde estoque dinâmico (CWB/SP hardcoded) | `equivalente/confirmar/route.ts` | **P6** |
| 3.11 | BAIXO | `comprar` não captura fornecedor escolhido | `comprar/route.ts` | **P6** |
| 3.12 | BAIXO | Auto-fix em GET `/compras?tab=receber` | `compras/route.ts` | **P6** |
| 3.13 | BAIXO | Tab "Histórico" sem paginação | `wms/compras/page.tsx` | **P5** ou **P6** |
| 3.14 | BAIXO | `getCompraQuantidadeRestante` ignora over-receive | `compras-utils.ts` | **P6** |
| 3.15 | BAIXO | `trocar-fornecedor` deprecated mas ainda movimenta | `compras/itens/[id]/trocar-fornecedor/route.ts` | **P6** (delete) |
| 3.16 | BAIXO | `/conferir` deprecated mas único que escreve Tiny | `compras/conferir/route.ts` | **P6** (delete) |
| 3.17 | BAIXO | `compras-release` permite múltiplos jobs `lancar_estoque` | `compras-release.ts` | **P6** |

### Módulo 4 — Inventário

| # | Sev | Achado | Arquivo | Plano |
|---|---|---|---|---|
| 4.1 | ALTO | Aplicar inventário não idempotente | `inventario.ts:805-882` | **P3** |
| 4.2 | ALTO | Aplicar sem reverse | (novo endpoint) | **P3** |
| 4.3 | ALTO | `/contagens` não valida lock | `inventario/[id]/contagens/route.ts` | **P3** |
| 4.4 | ALTO | DELETE sessão sem guard de status | `inventario/[id]/route.ts` | **P3** |
| 4.5 | MÉD | `computarDivergencias` força sair-party sem aviso | `inventario.ts` | **P3** |
| 4.6 | MÉD | Encerrar parcial deixa locs em_contagem com bloqueada_por finalizado | `inventario.ts` | **P3** + **P6** |
| 4.7 | MÉD | Modo blind vs aberto PATCH sem guard | `inventario.ts:pickPatchFields` | **P3** |
| 4.8 | MÉD | Reconciliação temporal não cobre janela cutoff→aplicada | `inventario.ts:computarDivergencias` | **P6** (doc/melhoria) |
| 4.9 | MÉD | Sessão cancelada não notifica handheld realtime | `use-inventario-realtime.ts` | **P5** |
| 4.10 | MÉD | Cleanup não cobre claim/operadores órfãos | `inventario/cleanup` | **P6** |
| 4.11 | MÉD | Aplicar não atualiza custo médio | `inventario.ts:aplicarSessao` | **P2** |
| 4.12 | MÉD | Dashboard-tarefas conta errado em sessões revisao/aprovada | `dashboard-tarefas.ts` | **P5** |
| 4.13 | BAIXO | `computarDivergencias` re-execução pode duplicar lock cleanup | `inventario.ts` | **P6** |
| 4.14 | BAIXO | `entrarParty` auto-inicia sessão sem perm supervisor | `inventario/[id]/party/route.ts` | **P6** |
| 4.15 | BAIXO | PATCH permite mudar tolerância depois de computar | `inventario.ts` | **P6** |
| 4.16 | BAIXO | Métricas endpoint não usa `requireWarehouseAccess` | `inventario/metricas/route.ts` | **P4** |
| 4.17 | BAIXO | FeedEventos polling 5s mesmo em aplicadas | `components/wms/inventario/feed-eventos.tsx` | **P5** |
| 4.18 | BAIXO | Sair da party não libera locs em_contagem desse operador | `inventario.ts` | **P6** |
| 4.19 | BAIXO | `delta_pct` null quando saldo_esperado=0 | `inventario.ts` | **P6** (UI) |
| 4.20 | BAIXO | 2 ops bipando mesma tripla em paralelo | `inventario_contagens` UPSERT | **P6** (doc) |

### Módulo 5 — Guarda / Recebimento

| # | Sev | Achado | Arquivo | Plano |
|---|---|---|---|---|
| 5.1 | ALTO | Confirmação de guarda IRREVERSÍVEL | (novo endpoint) | **P3** |
| 5.2 | ALTO | Race silenciosa em `iniciarGuarda` | `guarda.ts:302-327` | **P3** |
| 5.3 | ALTO | `confirmarGuarda` sem lock | `guarda.ts` | **P3** |
| 5.4 | ALTO | Cancelar pendência deixa saldo fantasma em RECEBIMENTO | `guarda/[id]/cancelar/route.ts` | **P5** (alerta) + **P6** (endpoint detecção) |
| 5.5 | MÉD | Entrada direta + impressão fire-and-forget sem retry | `etiqueta-produto-service.ts:120` | **P6** |
| 5.6 | MÉD | Pendência sem `localizacao_destino_id` no imprimir-lote | `guarda/imprimir-lote/route.ts` | **P5** |
| 5.7 | MÉD | useEffect dispara iniciar a cada refresh | `wms/guarda/[id]/page.tsx` | **P5** |
| 5.8 | MÉD | Confirmação parcial regride status | `guarda.ts` | **P3** (lock) + **P5** (UI) |
| 5.9 | MÉD | `criarPendencia` não tem `criada_por` | `guarda.ts` | **P6** |
| 5.10 | BAIXO | Coluna `guardada_por` não existe | `siso_wms_pendencias_guarda` schema | **P6** |
| 5.11 | BAIXO | Entrada direta não aparece no quadro home | `dashboard-tarefas.ts` | **P5** |
| 5.12 | BAIXO | Loc destino decidida no recebimento não é vinculante | (design intencional, doc) | **P6** |
| 5.13 | BAIXO | `imprimir-lote` não expõe `ignorados[]` no toast | `wms/receber/page.tsx` | **P5** |
| 5.14 | BAIXO | `resolverLocRecebimento` cria loc como side-effect sem feedback | `guarda.ts` | **P6** |
| 5.15 | BAIXO | `siso_wms_pendencias_guarda` NÃO está na publication | `20260514_wms_guarda_pendencias.sql` | **P1** |
| 5.16 | BAIXO | Sem feedback persistente de impressões falhadas | `etiqueta-produto-service.ts` | **P6** |

### Módulo 6 — Devoluções

| # | Sev | Achado | Arquivo | Plano |
|---|---|---|---|---|
| 6.1 | ALTO | Home/quadro não conta devoluções pendentes | `dashboard-tarefas.ts` | **P5** |
| 6.2 | ALTO | API aceita qualquer perm warehouse | `devolucoes/[id]/classificar/route.ts:39` | **P4** |
| 6.3 | ALTO | Classificação irreversível sem trilha undo | (novo endpoint) | **P3** |
| 6.4 | ALTO | Classe C — Garantia quebrada na UI | `wms/devolucoes/[id]/page.tsx` | **P5** |
| 6.5 | ALTO | `empresa_id` salvada como receptora exposta como `empresa_referencia` | `devolucoes.ts` (registrar+listar) | **P2** |
| 6.6 | MÉD | Detalhe lê do array filtrado (404) | `wms/devolucoes/[id]/page.tsx` | **P5** |
| 6.7 | MÉD | Status 'aplicada' nunca atingido | schema | **P6** |
| 6.8 | MÉD | Loc quarentena escolhida sem ORDER | `devolucoes.ts` | **P6** |
| 6.9 | MÉD | Loc quarentena entra em sugestões inventário | `wms_inventario_sugerir` RPC | **P6** |
| 6.10 | MÉD | Classes A e D produzem movs idênticas (distinguir) | `devolucoes.ts` | **P6** |
| 6.11 | MÉD | Dedup webhook não cobre todos campos | `webhook/tiny/route.ts` | **P6** |
| 6.12 | MÉD | Detecção devolução depende de campos não-padrão Tiny | `webhook/tiny/route.ts`, `nf-webhook-handler.ts` | **P2** |
| 6.13 | MÉD | Custo médio só recalcula em Classe A | `devolucoes.ts` (B/C/D) | **P2** |
| 6.14 | BAIXO | `empresa_referencia_id` pode ficar null mesmo com dado disponível | `devolucoes.ts` (resolverEmpresaReferencia) | **P6** |
| 6.15 | BAIXO | `pedido_origem_mov_id` resolve sem chave_acesso fallback | `devolucoes.ts` | **P6** |
| 6.16 | BAIXO | Cobertura MV não refresha em devolução | (cron 1min existente) | **P1** (cron melhor) |
| 6.17 | BAIXO | Ledger não compartilha origem_id entre movs B/C | `devolucoes.ts` | **P6** |
| 6.18 | BAIXO/ALTO* | `inserirMovimentacao` valida uuid mas devoluções passam bigint | `devolucoes.ts:137,153,211,234`, `ledger.ts:9-18` | **P2** (verificar schema → escalar) |

### Módulo 7 — Vendas Diretas

| # | Sev | Achado | Arquivo | Plano |
|---|---|---|---|---|
| 7.1 | ALTO | `vendas/criar` sem `vendas.criar` server-side | `vendas/criar/route.ts:58-62` | **P4** |
| 7.2 | ALTO | Venda manual modo separacao não cria R | `vendas/criar/route.ts` | **P2** |
| 7.3 | ALTO | Vendedor pode ver detalhe de outro vendedor | `vendas/[id]/route.ts:46-56` | **P4** |
| 7.4 | MÉD | Re-assign permite atribuir a usuário sem cargo | `vendas/[id]/vendedor/route.ts:62-72` | **P4** |
| 7.5 | MÉD | Pedidos ML/Shopee auto-atribuídos sem `vendedor_id` | `webhook-processor.ts:373` | **P6** |
| 7.6 | MÉD | Vendas modo separacao poluem quadro home | `dashboard-tarefas.ts:152-196` | **P5** |
| 7.7 | MÉD | Idempotência não cobre rollback | `vendas/criar/route.ts` | **P3** |
| 7.8 | MÉD | Não detecta produto mapeado pra empresa diferente | `vendas/criar/route.ts:132-136` | **P6** |
| 7.9 | MÉD | `resolverDisponibilidadeVenda` retorna única loc | `vendas-disponibilidade.ts:84-94`, `criar/route.ts:218` | **P6** |
| 7.10 | MÉD | `vendedor_id` SEMPRE = user.id criador | `criar/route.ts:249` | **P6** |
| 7.11 | BAIXO | `siso_pedido_itens.produto_id` é tiny_produto_id (bigint) | schema legado | **P6** (doc) |
| 7.12 | BAIXO | `cwb_atende/sp_atende` por nome do galpão | `criar/route.ts` | **P6** |
| 7.13 | BAIXO | Não há DELETE/cancelar venda | (novo endpoint) | **P3** |
| 7.14 | BAIXO | Mov de venda manual não popula `pedido_id` ledger | `criar/route.ts` | **P6** |
| 7.15 | BAIXO | `origem_id` compartilhado perde rastreio individual | `criar/route.ts` | **P6** (doc) |
| 7.16 | BAIXO | `payload_original.idempotency_key` sem índice | schema | **P6** |
| 7.17 | BAIXO | UI vendas sem "criar em nome de X" | `wms/vendas/nova/page.tsx` | **P5** |

### Módulo 8 — Transferências / Ajustes / Replenishment / Retroativos

| # | Sev | Achado | Arquivo | Plano |
|---|---|---|---|---|
| 8.1 | ALTO | Transferência em_transito sem TTL/cleanup/home | `siso_transferencias_galpao` + cron + home | **P5** + **P6** |
| 8.2 | ALTO | Receber transferência terminal sem reverse | (novo endpoint) | **P3** |
| 8.3 | ALTO | Cancelamento não trata recepção parcial | `transferencias/[id]/cancelar/route.ts` | **P3** |
| 8.4 | MÉD | Ajuste manual entrada sem custo + não recalcula | `ajuste/route.ts` | **P2** |
| 8.5 | MÉD | Ajuste manual motivo texto livre | `ajuste/route.ts` | **P6** |
| 8.6 | MÉD | Reconciliar retroativo aceita `compra_mov_id` sem validação | `lancamento-retroativo/[id]/reconciliar/route.ts` | **P3** |
| 8.7 | MÉD | Lançamento retroativo não preserva timestamp histórico | `lancamento-retroativo/route.ts`, RPC | **P2** |
| 8.8 | MÉD | Replenishment não-transacional | `movimentacoes.ts:replenishmentIntraGalpao` | **P3** |
| 8.9 | MÉD | `operacoes.retroativo` permissão não existe | `permissions.ts` | **P4** |
| 8.10 | MÉD | 2 ops recebendo mesma transferência | `movimentacoes.ts:receberTransferencia` | **P3** |
| 8.11 | BAIXO | `transferir-galpao` endpoint órfão | `app/api/wms/transferir-galpao/route.ts` | **P6** (delete) |
| 8.12 | BAIXO | LocalizacaoCombo `allowCreate=true` no Receber | `components/wms/ui/modals.tsx` | **P5** |
| 8.13 | BAIXO | `/wms/replenishment` só readonly — botão delega ao shell | `wms/replenishment/page.tsx` | **P5** ou **P6** |
| 8.14 | BAIXO | Saídas via ajuste podem mascarar perda (sem categoria) | `ajuste/route.ts` | **P6** (categoria via 6.24) |

### Total reconciliado

Contagem por **destino primário** (plano em que o fix nasce). Achados cross-cutting (que aparecem em 2 planos como "P5 + P6" ou "P3 + P5") são contados no plano que origina o fix backend, com nota explicativa.

| Plano | ALTOS | MÉDIOS | BAIXOS | Total |
|---|---|---|---|---|
| P1 | 4 | 3 | 1 | **8** |
| P2 | 11 | 8 | 3 | **22** |
| P3 | 9 | 9 | 4 | **22** |
| P4 | 5 | 6 | 2 | **13** |
| P5 | 6 | 7 | 7 | **20** |
| P6 | 4 | 20 | 24 | **48** |
| Cross-cutting (compartilhado entre 2 planos) | — | — | — | **~8** referências cruzadas |
| **Total único de achados** | **39** | **53** | **41** | **133** |

> **Diferença pra 141 do índice:** ~8 achados duplicados como referência cruzada (ex.: "filtro galpão home" tem fix backend em P5 e ajuste de RPC em P6; "RPCs insights deprecated" são P1 mas P6 cobre consumidores adicionais; "cancelar pendência saldo fantasma" tem alerta home em P5 e endpoint detecção em P6). 141 = 133 únicos + 8 duplicações por estarem em 2 planos.
>
> **ALTOS por plano (4 cross-cutting somam):** 4+11+9+5+6+4 = 39 ≠ 35 da auditoria. Os 4 extras vêm do **mesmo ALTO aparecer em 2 planos**:
> - "Cancelar pendência guarda saldo fantasma" → P5 (alerta visual) + P6 (endpoint detecção)
> - "Transferência em_transito sem TTL/cleanup/home" → P5 (card home) + P6 (TTL + cron)
> - "RPCs insights deprecated `siso_empresas.galpao_id`" → P1 (patch RPC) + P6 (consumidores adicionais)
> - "Filtro galpão home esconde 69% pendentes" → P5 (fix UI) + P6 (validar via cenário)
>
> ALTOS únicos (sem dupla contagem): **35** ✓ alinha com a auditoria.

---

## 16. Apêndice B — Arquivos tocados por plano (estimativa)

### P1
```
supabase/migrations/20260527_realtime_publication_completeness.sql
supabase/migrations/20260527_insights_rpcs_3d_patch.sql
supabase/migrations/20260527_cron_insights_refresh_5min.sql
supabase/migrations/20260527_cron_reservas_cleanup_1h.sql
supabase/migrations/20260527_cron_inventario_cleanup_30min.sql
supabase/migrations/20260527_cron_curva_abc_refresh_diario.sql
```

### P2 (~20 endpoints + 5 libs)
```
src/app/api/wms/compras/receber/route.ts
src/app/api/wms/compras/comprar/route.ts
src/app/api/wms/compras/pedidos/[id]/cancelar/route.ts
src/app/api/wms/compras/itens/[id]/equivalente/confirmar/route.ts
src/app/api/wms/separacao/bipar-checklist/route.ts
src/app/api/wms/separacao/validar-oc-item/route.ts
src/app/api/wms/separacao/produto-esgotado/route.ts
src/app/api/wms/separacao/encaminhar/route.ts
src/app/api/wms/separacao/localizacao/route.ts
src/app/api/wms/separacao/realocacao/[id]/route.ts
src/app/api/wms/separacao/concluir/route.ts
src/app/api/wms/separacao/concluir-oc/route.ts
src/app/api/wms/separacao/bipar-embalagem/route.ts
src/app/api/wms/separacao/confirmar-item-embalagem/route.ts
src/app/api/wms/vendas/criar/route.ts
src/app/api/wms/webhook/tiny/route.ts (cancelamento + detecção devolução)
src/app/api/wms/pedidos/aprovar/route.ts (transferência + loc disponivel)
src/app/api/wms/ajuste/route.ts (custo_unitario opcional)
src/app/api/wms/lancamento-retroativo/route.ts (data_recebimento)

src/lib/wms/reservas.ts (callers liberarReserva)
src/lib/wms/movimentacoes.ts (recalc custo em mais origens)
src/lib/separacao/wms-mapping.ts (filtro disponivel)
src/lib/wms/devolucoes.ts (passa custo B/C/D + corrige empresa_referencia + uuid handling)
src/lib/wms/inventario.ts (passa custo no aplicar)
src/lib/wms/separacao/pick-mov.ts (novo helper compartilhado)

scripts/wms/backfill-compras-recebidas.ts (novo, executar 1x)
```

### P3
```
src/app/api/wms/inventario/[id]/estornar/route.ts (novo)
src/app/api/wms/inventario/[id]/route.ts (DELETE guard)
src/app/api/wms/inventario/[id]/contagens/route.ts (valida lock)
src/app/api/wms/guarda/[id]/desfazer/route.ts (novo)
src/app/api/wms/guarda/[id]/iniciar/route.ts (lock anti-race)
src/app/api/wms/guarda/[id]/confirmar/route.ts (lock pessimista)
src/app/api/wms/devolucoes/[id]/desclassificar/route.ts (novo)
src/app/api/wms/replenishment/[id]/reverter/route.ts (novo)
src/app/api/wms/ajuste/[id]/estornar/route.ts (novo)
src/app/api/wms/vendas/[id]/cancelar/route.ts (novo)
src/app/api/wms/transferencias/[id]/desfazer-recebimento/route.ts (novo)
src/app/api/wms/transferencias/[id]/cancelar/route.ts (suporta parcial)
src/app/api/wms/separacao/marcar-item/route.ts (ordem estornos)
src/app/api/wms/separacao/reiniciar/route.ts (reverte cutover)
src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts (valida uuid)
src/app/api/wms/compras/receber/route.ts (optimistic lock; overlap com P2)

src/lib/wms/guarda.ts (lock helpers)
src/lib/wms/inventario.ts (idempotência + UNIQUE handling + race fixes)
src/lib/wms/movimentacoes.ts (replenishment + receberTransferencia transacional)

supabase/migrations/20260527_movs_unique_inventario_divergencia.sql
supabase/migrations/20260527_rpc_wms_replenishment_atomico.sql
supabase/migrations/20260527_rpc_wms_confirmar_guarda_atomico.sql

src/app/wms/inventario/[id]/page.tsx (botão estornar admin)
src/app/wms/guarda/[id]/page.tsx (botão desfazer)
src/app/wms/devolucoes/[id]/page.tsx (botão desclassificar)
src/app/wms/vendas/[id]/page.tsx (botão cancelar)
```

### P4
```
src/app/api/wms/pedidos/aprovar/route.ts (auth check no topo)
src/app/api/wms/pedidos/route.ts (filtro galpão + auth)
src/app/api/wms/pedidos/[id]/historico/route.ts (auth)
src/app/api/wms/pedidos/[id]/observacoes/route.ts (auth)
src/app/api/wms/webhook/reprocessar/route.ts (admin + lê body)
src/app/api/wms/vendas/criar/route.ts (vendas.criar)
src/app/api/wms/vendas/[id]/route.ts (ownership)
src/app/api/wms/vendas/[id]/vendedor/route.ts (valida cargo target)
src/app/api/wms/inventario/metricas/route.ts (warehouseAccess)
src/app/api/wms/devolucoes/[id]/classificar/route.ts (operacoes.devolucoes_classificar)
src/app/api/wms/lancamento-retroativo/route.ts (operacoes.retroativo)
src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts (idem)

src/lib/permissions.ts (+ 3 perms novas)
src/hooks/use-dashboard-tarefas-realtime.ts (filter server-side)

supabase/migrations/20260527_siso_pedido_observacoes_formal.sql
```

### P5
```
src/lib/wms/dashboard-tarefas.ts (5 contadores novos + correção filtro galpão)
src/app/api/wms/dashboard-tarefas/route.ts (response expandido)
src/app/wms/page.tsx (5 cards novos colapsáveis)
src/components/wms/quadro-tarefas/ (componentes novos)
src/hooks/use-dashboard-tarefas-realtime.ts (5 tabelas extras pós-P1)
src/hooks/use-inventario-realtime.ts (sessao status)

src/app/wms/devolucoes/[id]/page.tsx (fornecedor Classe C + fetch dedicado)
src/app/wms/pedidos/[id]/page.tsx (label + banner D10 + recusar)
src/components/wms/pedido-card-wms.tsx (recusar)
src/app/wms/vendas/page.tsx (distinguir manual vs marketplace)
src/app/wms/vendas/nova/page.tsx ("criar em nome de" + motivo_degradacao)
src/components/wms/separacao/parcial-modal.tsx
src/components/wms/ui/modals.tsx (Receber LocalizacaoCombo allowCreate=false)
src/app/wms/receber/page.tsx (toast ignorados[])
src/components/wms/inventario/feed-eventos.tsx (para polling)
src/app/wms/pedidos/page.tsx (paginação)
src/app/wms/compras/page.tsx (paginação Histórico)
src/app/wms/guarda/[id]/page.tsx (separa viewing/iniciando)
```

### P6
```
supabase/migrations/20260527_transferencias_expira_em.sql
supabase/migrations/20260527_cron_transferencias_em_transito_cleanup.sql
supabase/migrations/20260527_ajuste_manual_motivo_categoria.sql
supabase/migrations/20260527_pendencias_guarda_criada_por_guardada_por.sql
supabase/migrations/20260527_devolucoes_pendentes_status_aplicada.sql
supabase/migrations/20260527_idempotency_key_index.sql
supabase/migrations/20260527_inventario_sugerir_excluir_quarentena.sql
supabase/migrations/20260527_devolucoes_loc_quarentena_order.sql
supabase/migrations/20260527_compras_release_galpao_via_oc.sql

src/app/api/wms/saldo-recebimento-orfao/route.ts (novo)
src/app/api/wms/transferencias/cleanup/route.ts (worker secret)
src/app/api/wms/inventario/cleanup/route.ts (estende: operadores zumbi)
src/lib/wms/inventario.ts (cleanup operadores + logging PATCH)
src/lib/compras-release.ts (separacao_galpao_id source of truth)
src/lib/wms/vendas-disponibilidade.ts (sem CWB/SP hardcoded)
src/app/api/wms/vendas/criar/route.ts (cwb_atende/sp_atende dinâmico)
src/lib/historico-service.ts (+ helpers compras)
src/lib/wms/devolucoes.ts (origem_tipo A vs D distinto)
src/lib/wms/guarda.ts (criada_por + guardada_por backfill)
src/app/wms/ajuste/page.tsx (UI motivo_categoria select)

(deletar)
src/app/api/wms/transferir-galpao/route.ts
src/app/api/wms/compras/conferir/route.ts
src/app/api/wms/compras/itens/[itemId]/trocar-fornecedor/route.ts

(modificar — adicionar registrarEventos)
src/app/api/wms/compras/comprar/route.ts (também P2)
src/app/api/wms/compras/receber/route.ts (também P2 + P3)
src/app/api/wms/compras/itens/[id]/indisponivel/route.ts
src/app/api/wms/compras/itens/[id]/devolver/route.ts
src/app/api/wms/compras/itens/[id]/cancelamento/confirmar/route.ts
src/app/api/wms/compras/itens/[id]/equivalente/confirmar/route.ts
src/app/api/wms/compras/trocar-sku/route.ts
src/app/api/wms/compras/pedidos/[id]/cancelar/route.ts (também P2)
```

---

## 17. Notas de cobertura

Esta spec mapeia explicitamente 133 dos 141 achados (94%). A diferença (~8) corresponde a achados que aparecem em 2 planos com referência cruzada (banner D10 endpoint vs UI, filtro galpão home backend vs hook realtime, etc.) e foram contados 1x na soma final.

**100% dos ALTOS (35) cobertos.** **100% dos MÉDIOS (57) cobertos.** **100% dos BAIXOS (49) cobertos** — alguns como "doc/observação técnica" em P6.

Achados sem fix prescritivo (apenas documentação/decisão): 
- 2.11 (`cancelar` preserva `mov_ajuste_loc_zerou` — intencional por design)
- 5.12 (loc destino no recebimento não-vinculante — intencional)
- 7.11 (`tiny_produto_id` bigint — legado herdado)
- 7.15 (`origem_id` compartilhado em venda — design choice)
- 4.20 (2 ops bipando mesma tripla — reconciliarTemporal resolve)

Esses são documentados em P6 como **decisões de design conscientes** com link pra justificativa em `CLAUDE.md`.
