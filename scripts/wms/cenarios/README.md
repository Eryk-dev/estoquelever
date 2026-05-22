# Cenários de Estoque — Camada 3 da Pirâmide

Sistemática de testes ponta-a-ponta exercitando todos os fluxos que escrevem em
`siso_movimentacoes`. Roda contra **staging fixo** (`ehbxpbeijofxtsbezwxd`) via
HTTP em `/api/wms/*` com dependências externas (Tiny, PrintNode, ML) stubadas.

**Spec:** `docs/superpowers/specs/2026-05-21-sistematica-testes-estoque-design.md`
**Plano:** `docs/superpowers/plans/2026-05-21-sistematica-testes-estoque.md`

## Pré-requisitos

1. Migration `wms_truncate_operacional` aplicada em staging.
2. `.env.test` (commitado) configurado.
3. `.env.test.local` (gitignored) com as chaves reais de staging:
   ```bash
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging anon>
   SUPABASE_SERVICE_ROLE_KEY=<staging service role>
   ```

## Rodar a suite completa

```bash
npm run scenarios
```

O runner:
1. Sobe Next dev server em `:3001`
2. Trunca tabelas operacionais via `wms_truncate_operacional` (preserva catálogo)
3. Faz seed inicial (empresas/galpões/locs/usuário `test-runner`)
4. Loga como `test-runner` (PIN 9999)
5. Executa todos os cenários em `catalogo/` (ordem alfabética)
6. Aplica os 7 invariantes globais ao fim de cada cenário
7. Escreve relatório markdown + JSON em `reports/`

## Rodar 1 cenário pra debug

Terminal 1:
```bash
PORT=3001 npm run dev
```

Terminal 2 (após o dev server estar pronto):
```bash
npx tsx scripts/wms/cenarios/catalogo/04-parcial-realocacao-cascateada.ts
```

O script standalone reusa o `npm run dev`, faz truncate+seed, loga, e roda só
esse cenário com os invariantes globais.

## Adicionar cenário novo

1. Criar `catalogo/NN-nome-curto.ts` (próximo número disponível).
2. Default export satisfazendo `Cenario` em `_harness/types.ts`.
3. Usar `ctx.skuUnico("NN")` pra evitar colisão de SKU.
4. Terminar com o trailer standalone (copie de qualquer cenário existente).
5. Runner descobre automaticamente — sem registro manual.

## Filtros

```bash
# Só cenário cujo nome contém "04"
npm run scenarios -- --only 04

# Só cenários com tag "realocacao"
npm run scenarios -- --filter realocacao

# Manter dev server vivo após (pra inspecionar staging no browser)
npm run scenarios -- --keep-server

# Porta alternativa
npm run scenarios -- --port=3010
```

## Invariantes globais (oráculo de correção)

Rodam **automaticamente** ao fim de todo cenário. Falha em qualquer um marca o
cenário como FAIL mesmo que `assertEsperado` tenha passado.

| # | Invariante | Bug que pega |
|---|---|---|
| I1 | Ledger ↔ cache coerente | Cache desincronizado do ledger (rpc esqueceu de atualizar) |
| I2 | `disponivel = saldo - reservado` | Drift de coluna GENERATED |
| I3 | Custo médio coerente | Recalc errado em entrada com `custo_unitario` |
| I4 | Sem reservas órfãs | Cleanup esqueceu de liberar; reserva sem TTL |
| I5 | Pendências guarda coerentes | `qty_pendente` ≠ `qty_inicial - qty_guardada` |
| I6 | Pares S+E balanceados | Realocação/transferência perdeu 1 lado |
| I7 | Fila vazia ao fim | Worker travado ou pedido em loop |

## Troubleshooting

**`waitForHealth: ... não respondeu em 60s`**
→ Dev server não subiu. Cheque logs em `[dev]`/`[dev:err]`. Geralmente porta
ocupada — use `--port=N`.

**`loginTestRunner: HTTP 401`**
→ Usuário `test-runner` não existe ou PIN mudou. Re-rode o `seedInicial`
manualmente.

**`aguardarStatus: ... timeout`**
→ Webhook é fire-and-forget. Cheque `siso_logs`/`siso_erros` filtradas pelo
`correlation_id` (presente no `detail.json` do relatório).

**Cenário passou mas invariante I1 falhou**
→ Algum endpoint escreveu em `siso_estoque` fora do RPC
`wms_inserir_movimentacao`. Cheque o diff no `detail.json`.

**Suite poluiu staging e operadores estão com problemas**
→ Era pra ter avisado. Rode `seedInicial` pra restaurar fixtures.

## Premissa: não compartilhar staging

A suite faz `wms_truncate_operacional` ao iniciar — operadores em staging
perdem qualquer trabalho em andamento. **Não rodar a suite enquanto alguém
testa em staging manualmente.**

## Layout de arquivos

```
scripts/wms/cenarios/
  README.md                # este arquivo
  run-all.ts               # runner mestre (npm run scenarios)
  _harness/
    types.ts               # Ctx, Cenario, Results
    http.ts                # sisoFetch wrapper
    seed.ts                # truncate + seed idempotente
    asserts.ts             # assertSaldo, assertMovsCount, etc.
    context.ts             # createContext (Ctx factory)
    dev-server.ts          # start/health/login
    invariantes.ts         # 7 invariantes globais
    relatorio.ts           # writeReport (md + json)
    standalone.ts          # runStandalone (1 cenário isolado)
  catalogo/
    01-pedido-auto-propria.ts
    02-pedido-transferencia.ts
    ... (17 arquivos)
  reports/                 # gitignored, criado em runtime
```
