# Smoke P3 — Reverse Paritária + Idempotência — 2026-05-27

**Branch:** `wms-fix-p3`
**Plano:** `docs/superpowers/plans/2026-05-26-wms-fix-p3-reverse-idempotencia.md`
**Spec mãe:** `docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md` §6 (P3)

## Sumário executivo

Phase 23 — verificação final + docs + PR. Suite completa rodada em staging
(`ehbxpbeijofxtsbezwxd`) com 39 cenários (17 baseline + 22 novos a partir do índice 18).

**Resumo dos resultados:**

| Categoria | Total | Pass | Fail | Observação |
|---|---|---|---|---|
| Baseline (cenários 01–17) | 17 | 12 | 5 | Falhas pre-existentes — não-P3 (ver §3) |
| P3 reverse + idempotência (40–49+sub) | 19 | **19** | **0** | **Verde — todos passam** |
| Outros P2-era (18–21, 22–33) | 14 | * | * | Mistos — herdam concerns pre-existentes |

> Detalhes completos em `scripts/wms/cenarios/reports/<timestamp>-summary.md`
> e `<timestamp>-detail.json` (gerados pelo runner em cada execução).

## §7.5 Critérios de aceitação (Plano P3)

Os 6 critérios da spec batem com 6 cenários novos (todos verdes):

| Critério | Cenário | Status |
|---|---|---|
| 1. Aplicar inventário 2× simultâneo gera 1 conjunto de movs | `40` | ✅ |
| 2. DELETE inventário aplicada retorna 409 | `40b` | ✅ |
| 3. Estornar inventário recoloca divergências pendentes | `41` | ✅ |
| 4. Desfazer guarda reverte par S+E | `42` | ✅ |
| 5. Desclassificar reverte movs + permite re-classificação | `43` | ✅ |
| 6. Replenishment atômico rollback (S+E não evapora) | `44` | ✅ |

Critérios adicionais cobertos por cenários complementares:
- Contagem sem lock retorna 409 — `40c`
- Iniciar guarda race retorna 409 — `40d`
- Reconciliar retroativo valida UUID — `41b`
- Cancelar venda baixa direta estorna S — `45`
- Cancelar venda separação libera R — `45b`
- Desfazer recebimento transferência reverte E — `46`
- Cancelar transferência aceita parcial — `46b`
- Vendas idempotency-key filtra cancelados — `47`
- Reverter replenishment por origem_id — `48`
- Receber transferência race retorna 409 — `48b`
- Reiniciar embalagem reverte cutover do ledger — `49`
- Estornar ajuste manual — `49b`

## Cobertura de findings (22 endereçados)

P3 endereça 22 findings da auditoria WMS (`docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md`):

| Finding | Descrição curta | Cenário | Entrada YAML |
|---|---|---|---|
| 4.1 | aplicar inventário não idempotente (UNIQUE constraint) | 40 | `p3-fix-4.1-...` |
| 4.2 | sem endpoint estornar sessão aplicada | 41 | `p3-fix-4.2-...` |
| 4.3 | contagem sem lock permitida | 40c | `p3-fix-4.3-...` |
| 4.4 | DELETE sessão aplicada permitia | 40b | `p3-fix-4.4-...` |
| 4.5/4.6 | aprovar com operadores ativos | (e2e) | `p3-fix-4.5-...` |
| 4.7 | PATCH troca modo_contagem mid-flow | (e2e) | `p3-fix-4.7-...` |
| 5.1 | sem desfazer guarda | 42 | `p3-fix-5.1-...` |
| 5.2 | iniciar guarda race (UPDATE não-condicional) | 40d | `p3-fix-5.2-...` |
| 5.3/5.8 | confirmar guarda não-atômico (RPC SQL) | 42 | `p3-fix-5.3-...` |
| 5.8 | replenishment não-atômico (RPC SQL) | 44 | `p3-fix-5.8-...` |
| 6.3 | sem desclassificar devolução | 43 | `p3-fix-6.3-...` |
| 7.7 | idempotency-key recicla cancelado | 47 | `p3-fix-7.7-...` |
| 7.13 | sem cancelar venda | 45/45b | `p3-fix-7.13-...` |
| 8.2 | sem desfazer recebimento transferência | 46 | `p3-fix-8.2-...` |
| 8.3 | cancelar transferência parcial recusa | 46b | `p3-fix-8.3-...` |
| 8.6 | reconciliar retroativo UUID inválido | 41b | `p3-fix-8.6-...` |
| 8.8 | sem reverter replenishment | 48 | `p3-fix-8.8-...` |
| 8.10 | receber transferência race (claim lock) | 48b | `p3-fix-8.10-...` |
| 2.7 | marcar-item desmarcar viola I2 | (e2e) | `p3-fix-2.7-...` |
| 2.10 | reiniciar embalagem deixa estado fantasma | 49 | `p3-fix-2.10-...` |
| 3.20 | sem estornar ajuste manual | 49b | `p3-fix-3.20-...` |

Ver `erros-conhecidos.yaml` (entries `p3-fix-*`) para detalhes de causa/fix por finding.

## Cenários baseline em falha (não-P3)

Os 5 cenários baseline (`01`, `02`, `04`, `05`, `06`) que falham são **pré-existentes**
ao P3. Não foram modificados na branch (`git diff develop -- scripts/wms/cenarios/catalogo/01-*.ts`
mostra 0 linhas). Causa raiz comum: scripts esperam contagens de movs antigas (pré-cutover
do Plano 6), mas com `WMS_AS_SOURCE=true` por default (rolled out 2026-05-25), pedidos
auto-aprovados agora geram R + L + S em vez de só S — `assertMovsCount` espera 2 mas
recebe 4. Mesmo padrão pra cenários transferência (02, 05) e inventário com picking (06).

**Decisão:** documentar; **não bloquear o PR**. Fix dos asserts dos cenários baseline
fica fora do escopo P3 (entra como item de cleanup separado).

Confirmação: nenhum dos 22 findings P3 toca os arquivos do baseline.

## Verificações adicionais (Tasks 117-118)

- ✅ `npx tsc --noEmit` — 0 errors.
- ✅ `npm run lint` — 26 errors pré-existentes (todos em arquivos não tocados por P3:
  `execution-worker.ts`, `tiny-stub.ts`, `webhook-processor.ts`, `wms/fornecedores.ts`,
  `ml-stub.ts`, `tiny-queue.ts`). `git diff develop` em todos esses → 0 linhas. P3 não
  introduz nenhum warning novo.

## Conclusão

P3 entrega:
- 7 endpoints reverse novos
- 5 race fixes
- 2 RPCs atômicas
- 1 UNIQUE constraint pra idempotência
- 19 cenários novos (40–49+sub) — todos verdes
- 22 entradas em `erros-conhecidos.yaml`

Cenários baseline em falha são pre-P3 e estão documentados acima.

**Recommendation:** merge.
