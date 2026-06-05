# Handoff — Bateria Automática de Estoque (2026-06-01)

Branch: `test/stock-ledger-suite` (criada a partir de `develop`/HEAD perf).
Spec: `docs/superpowers/specs/2026-06-01-bateria-testes-estoque-design.md`
Plano: `docs/superpowers/plans/2026-06-01-bateria-testes-estoque.md`

## TL;DR
A **estabilização funcionou** — a cascata de "fetch failed" que mascarava tudo
foi eliminada. Numa run parcial (12 cenários antes de matar): **8 passou / 4
falhou, ZERO infra-fail**. As 4 falhas são `assert` = bugs reais de estoque (o
sinal que queríamos). **Mas** cada cenário que passa leva ~4 min → os 82 dariam
~5h, inviável pro cron de 90 min. Paramos aqui (decisão do Eryk) com a infra
pronta e verificada; triagem, cenários novos e o fix de performance ficam pra
próxima sessão.

## Estado por fase

| Fase | Status | Commits |
|---|---|---|
| 1 — Harness estabilizado (retry+NetworkError, taxonomia product/infra-fail, modo prod `--prod`/`scenarios:ci`, health-recovery) | ✅ feito + 8 unit tests + revisado | 35073e9, 8a16040, 9b99a79, 49f0b4b |
| 2 — I8 reservado (RPC `wms_detectar_divergencias_reservado`) + truncate `siso_transferencias_galpao` + I2/I3 + teste integração | ✅ feito; **migrations aplicadas em staging** | fc02cd7, 3007e2b, a8a5cb9 |
| 5 — Alerta Slack/Discord (`notify:stock`) + workflow GH Actions + runbook | ✅ escrito + 3 unit tests; **cron ainda não ligado** (precisa secrets + merge na branch default) | 24b538b, a8a5cb9 |
| 3 — Triagem | ⏳ **pendente** — 4 falhas reais isoladas (ver abaixo) |
| 4 — 5 cenários novos (71–75) | ⏳ **pendente** (melhor escrever+validar com a suíte ao vivo) |
| Perf do harness (~4min/cenário) | ⏳ **pendente** — bloqueador do cron |

## Achado de validação (run parcial em modo prod, 2026-06-01 ~13:00)
Comando: `npm run scenarios:ci` (build prod + next start + cenários contra staging).
Morta manualmente no cenário 13. Resultado dos 12 que rodaram:

```
01 — Pedido auto-aprovado própria        ❌ assert  (28s)
02 — Pedido transferência                ✅        (247s)
03 — Pedido OC completo                  ❌ assert  (39s)
04 — Parcial + realocação cascateada     ❌ assert  (14s)
05 — Parcial esgota → encaminhar         ✅        (263s)
06 — Inventário com picking concorrente  ❌ assert  (22s)
07 — Reservas TTL + cleanup              ✅        (233s)
08 — Receber → Guarda parcial            ✅        (237s)
09 — Entrada direta                      ✅        (224s)
10 — Devolução cliente íntegra (A)       ✅        (234s)
11 — Devolução cliente avariada (B/C/D)  ✅        (241s)
12 — Venda Direta baixa_direta           ✅        (237s)
```
- **0 infra-fail / 0 "fetch failed"** — a estabilização (Fase 1) está provada.
- Cenários historicamente flaky (09) agora passam.

## Pendência 1 — Triagem dos 4 bugs reais (Fase 3)
Reproduzir isolado com `npm run scenarios:only -- "NN"` (modo dev, rápido) e
decidir: bug de produto (corrige) vs expectativa de cenário desatualizada (ajusta
assert). Os 4:
- **01** — Pedido auto-aprovado própria (falha rápida, 28s — assert no fluxo
  webhook→auto-aprova→separa→expede).
- **03** — Pedido OC completo (comprar→receber→guarda→separa).
- **04** — Parcial + realocação cascateada.
- **06** — Inventário com picking concorrente (reconciliação temporal).

> Nota: como são `assert` (não invariante), pode ser tanto bug real quanto o
> cenário esperando um contrato que mudou. A triagem decide caso a caso.

## Pendência 2 — Performance (~4 min/cenário) — bloqueador do cron
Cenários que completam o pipeline assíncrono têm um **piso de ~230s**, uniforme
entre tipos diferentes (transferência, TTL, guarda, devolução, venda). Uniformidade
→ espera fixa, não trabalho variável. Hipóteses a investigar (em ordem):
1. **Gatilho do worker** — quem chama `/api/wms/worker/processar` no harness? Se a
   `siso_fila_execucao` só drena por retry com **backoff exponencial**, cada job
   custa minutos. Ver `src/lib/execution-worker*.ts` + como `aprovar`/webhook
   disparam o worker.
2. **Helpers `aguardar*`** em `scripts/wms/cenarios/_harness/context.ts`
   (`aguardarStatus`, `aguardarStatusSeparacao`, `aguardarFilaVazia`) — intervalo
   de polling + timeout. Se pollam devagar com timeout alto, aproximam do teto.
3. **Backoff da fila** em test env — reduzir/zerar pra test.
Caminho sugerido: instrumentar UM cenário lento (ex.: 02) com timestamps pra ver
ONDE os 230s vão; depois cortar (worker síncrono em test, polling mais rápido, ou
backoff curto). Meta: suíte completa < ~30-40 min.

## Pendência 3 — Cenários novos 71–75 (Fase 4)
Scaffolds prontos no plano (`docs/superpowers/plans/2026-06-01-bateria-testes-estoque.md`,
Tasks 4.1–4.5): 71 estorno D10, 72 liberar-reservas D2, 73 conversão NF R→L+S,
74 loc-move com reserva, 75 cancelar guarda. Escrever + validar com a suíte ao
vivo (cada um lê a rota pra confirmar contrato primeiro).

## Pra LIGAR o cron noturno (quando a suíte estiver verde + rápida)
1. O workflow `.github/workflows/wms-stock-suite.yml` precisa estar na **branch
   default** do repo (cron só dispara de lá).
2. 5 GitHub Secrets (ver `docs/superpowers/runbook-bateria-estoque.md`):
   `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`,
   `STAGING_SUPABASE_SERVICE_ROLE_KEY`, `STAGING_WORKER_SECRET`,
   `STOCK_SUITE_WEBHOOK_URL`.

## Como rodar local (sem `.env.test.local`)
O `.env` da raiz já tem as chaves de staging (prod comentado), e o harness o
carrega via `dotenv/config` antes do `.env.test` (override:false), então as chaves
reais vencem os placeholders. Comandos:
- Completa modo prod: `npm run scenarios:ci`
- 1 cenário modo dev (rápido, pra triagem): `npm run scenarios:only -- "01"`
- ⚠️ Antes de rodar, limpar lock órfão se um run anterior foi morto:
  `pkill -f "next dev"; pkill -f "next start"; rm -f .next/dev/lock`
- ⚠️ Trunca dados operacionais de staging a cada run.

## Higiene
- Arquivos de perf do Eryk (`logger.ts`, `marcar-item`, `parcial`,
  `validar-oc-item`, `checklist`) ficaram **intactos** (não commitados, disjuntos
  dos meus).
- Migrations 1.5 + 2.1 já aplicadas em staging `ehbxpbeijofxtsbezwxd` (aditivas,
  seguras: nova RPC + update do truncate).
- Nenhum processo/servidor de teste rodando (limpos).
