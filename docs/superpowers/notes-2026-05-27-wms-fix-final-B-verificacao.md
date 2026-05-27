# WMS Fix-Final B — Verificação final

**Data:** 2026-05-27
**Plano:** [`docs/superpowers/plans/2026-05-27-wms-fix-final-B.md`](plans/2026-05-27-wms-fix-final-B.md)
**Spec:** [`docs/superpowers/specs/2026-05-27-wms-fix-final-design.md`](specs/2026-05-27-wms-fix-final-design.md) §3
**Branch:** `develop` (push em `bf40bd8`)
**Workflow:** `superpowers:subagent-driven-development` — implementer subagent + spec/quality review por task

## Resumo executivo

Os 11 itens P2 do Fix-Final B foram fechados em 15 commits diretos na `develop` (mesmo padrão Fix-A — sem worktree, sem PR separado, validação por diff + tsc + cenário individual em vez de full suite).

Dos 11 itens (B1–B11):
- **6 viraram no-op com documenting commit** (já estavam implementados em commits anteriores OU a premissa do plano era stale): B1, B2, B5, B6, B7, B11.
- **5 itens implementados de fato:** B3, B4, B8, B9, B10.
- 3 migrações leves aplicadas em staging (`ehbxpbeijofxtsbezwxd`), zero em prod.
- 3 cenários novos (50, 51, 52) validados individualmente via `--only`.

## Commits (cronológico)

| # | Commit | Task | Tipo | Resumo |
|---|---|---|---|---|
| 1 | `b48cb38` | T2/B1 | no-op | defer delete transferir-galpao (cenário 15 + harness consomem) |
| 2 | `400b49e` | T3/B2 | no-op | vendas-disponibilidade já 3D-clean (commit `ec7a9cf` antigo) |
| 3 | `903ce96` | T4/B3 | feat | movs_estornadas JSONB truncado a 50 + counter + flag |
| 4 | `8a5c9bd` | T5/B4 | fix | computarDivergencias guard contra re-execução |
| 5 | `c923a30` | T6/B5 | no-op | wms_inventario_sugerir já filtra quarentena (migration `20260527_...` aplicada) |
| 6 | `8dc6925` | T7/B6 | no-op | desfazer-parcial mensagens já corretas (rota existe, mensagens descritivas) |
| 7 | `69224fa` | T8/B7 | no-op | encaminhar OC já funciona via EsgotadoModal auto-open após `sem_cobertura` |
| 8 | `dabdc81` | T9/B8 | test | cenário 50 — replenishment cria mov par S+E |
| 9 | `1e5c0c9` | T10/B8 | feat | replenishment page subtitle action-oriented |
| 10 | `56b1f17` | T11/B9 | feat | devolucao_id em movs + cenário 52 (lookup determinístico) |
| 11 | `1407fae` | T12/B10 | feat | desfazer guarda parcial com qty + cenário 51 |
| 12 | `2865f1f` | T13/B11 | feat | tracking_origem_ids text[] scaffolding (population deferred) |
| 13 | `f02337e` | T14 | docs | 6 entradas erros-conhecidos.yaml (T4 T5 T9 T10 T11 T12) |
| 14 | `cf97217` | T15 | docs | schema + api + CLAUDE.md atualizados |
| 15 | `bf40bd8` | T15 | docs | fixup retrocompat claim em desclassificar |

## Migrations aplicadas em staging

1. `20260528_movs_devolucao_id.sql` — ADD COLUMN `devolucao_id uuid` em `siso_movimentacoes` + partial index. Verified via `information_schema`.
2. `20260528_pendencias_tracking_origem_ids.sql` — ADD COLUMN `tracking_origem_ids text[]` em `siso_wms_pendencias_guarda`. Verified.
3. `20260527_inventario_sugerir_excluir_quarentena.sql` — já estava aplicada (commit `e9201e9`); verificada via `pg_get_functiondef('wms_inventario_sugerir')` mostrando 3 CTEs com `loc.tipo <> 'quarentena'`.

## Cenários novos (validação individual)

| Cenário | Resultado | Tempo |
|---|---|---|
| 50 — Replenishment cria mov par S+E | ✅ PASS | 3.3s |
| 51 — Desfazer guarda parcial com qty configurável | ✅ PASS | 214s |
| 52 — Desclassificar via devolucao_id (lookup determinístico) | ✅ PASS | 206s |

Comando: `npm run scenarios -- --only <N>` (note: `--only` requer espaço, não `=`).

Cada cenário executa I1–I7 (invariantes globais property-based) ao fim — todas verdes nas 3 validações.

## tsc

```
$ npx tsc --noEmit 2>&1 | tail -5
.next/types/validator.ts(701,39): error TS2307: Cannot find module '../../src/app/api/wms/compras/conferir/route.js' …
.next/types/validator.ts(764,39): error TS2307: Cannot find module '../../src/app/api/wms/compras/itens/[itemId]/trocar-fornecedor/route.js' …
src/components/wms/home/exceptions/__tests__/cards.test.tsx(2,24): error TS2307: Cannot find module '@testing-library/react' …
```

3 erros pré-existentes (mesmos que Fix-A reportou):
- 2 stubs de rotas desativadas em `.next/types/validator.ts` (CLAUDE.md "Deprecated / To Remove")
- 1 missing `@testing-library/react` em arquivo de teste

Zero novos erros introduzidos por Fix-B.

## Suite full — diferida

Por orientação do user (mesmo padrão Fix-A documentado em commit `11ac6ad`): "Suite cenários: re-run completo deferido (flakiness conhecida)." A baseline `develop` pós-Fix-A não estava em 68/68 PASS — diversos cenários falhavam com `invariante` ou `assert` mesmo antes das mudanças de Fix-B. Validação foi feita por diff inspection + tsc + cenário individual.

## Concerns documentados

1. **T12 race condition**: `desfazerGuarda` faz 2 `inserirMovimentacao` sequenciais (S + E) sem transação atômica. Crash entre as duas leg deixaria saldo inconsistente. Mesma falha existia no fluxo anterior (estorno-based). Fix proper exige RPC wrapper PL/pgSQL — out of scope.

2. **T13 scaffolding**: coluna `tracking_origem_ids text[]` adicionada mas não populada — webhook handler não tem campo `tracking_ids` no payload Tiny hoje. Quando Tiny expuser, basta editar `nf-webhook-handler.ts` (entrada em `erros-conhecidos.yaml` documenta).

3. **T15 docs fixup**: edit inicial em `docs/api-reference-complete.md` mencionou "fallback ±60s" em desclassificar — não existe no código. Corrigido em commit `bf40bd8`.

## Próximos passos sugeridos (fora deste plano)

- **Fix-C**: itens P3 de QA + cleanups (deferido conforme spec §4). Roda só depois de Fix-A e Fix-B estáveis em `develop`.
- **Reservas/scripts**: investigar flakiness do baseline de cenários — diversos falham com `invariante` mesmo sem mudanças. Possivelmente staging tem dados poluídos ou timing race em truncate+reseed.
- **T12 atomicidade**: criar RPC `wms_desfazer_guarda_atomico` envolvendo S+E + UPDATE pendência numa transação.
