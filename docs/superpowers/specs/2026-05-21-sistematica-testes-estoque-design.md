# Sistemática de Testes de Estoque — Design

**Data:** 2026-05-21
**Branch alvo:** novo (a definir no plano de implementação)
**Status:** design aprovado, aguardando plano

---

## 1. Problema

O SISO tem uma rede densa de fluxos que escrevem em `siso_movimentacoes` (ledger 3D pós-2026-05-20): recebimento, guarda, separação com parcial e realocação cascateada, embalagem, expedição, transferência inter-galpão, replenishment intra-galpão, ajuste manual, lançamento retroativo, devoluções A/B/C/D, vendas diretas (modo separação + baixa direta + degradação), reservas atômicas com TTL, inventário com pull queue e claim hierárquico.

Hoje existem ~16 testes unitários (vitest) em `src/lib/wms/` e `src/lib/separacao/` cobrindo lógica pura (realocação resolver, custo médio, ledger, putaway, inventário reconciliação temporal, etc.). Não existe nenhuma sistemática que exercite **fluxos compostos ponta-a-ponta** — pedido aprovado → separação parcial → realocação cascateada → embalagem → expedição com baixa coerente no ledger; ou inventário rodando enquanto pickings acontecem; ou recebimento → guarda parcial → guarda restante no mesmo SKU.

Bugs nesses fluxos compostos são caros: ou geram divergência ledger↔cache que precisa reconciliação manual, ou geram pedido travado num status intermediário, ou geram saída/entrada não pareada quebrando custo médio. A maior parte só aparece quando duas operações coincidem no tempo.

## 2. Objetivo

Criar uma **pirâmide de testes** que cobre todas as funcionalidades relacionadas a estoque — saída por pedido, saída manual, entrada por recebimento/devolução, inventário com separação concorrente, reservas, transferências, ajustes — com asserts específicos por cenário e **invariantes globais** que pegam violações de propriedades fundamentais que ninguém pensou em testar.

A suite é **manual sob demanda** (sem orçamento rígido de tempo), roda contra o projeto Supabase **staging** (`ehbxpbeijofxtsbezwxd`), e exercita os fluxos via **HTTP contra `/api/wms/*`** com dependências externas (Tiny, PrintNode, ML) **stubadas**.

## 3. Não-objetivos

- **Não é CI gate hoje.** A suite roda quando o dev quiser. Pode evoluir pra CI depois.
- **Não testa UI.** Sem Playwright. Foco no contrato dos endpoints e na coerência do ledger.
- **Não cobre o módulo Cross** (catálogo OEM/veículos) — esse já tem testes próprios em `cross/`.
- **Não cobre auth/sessão** além do mínimo (login do `test-runner`).
- **Não testa rate limit** do Tiny — stub é instantâneo.
- **Não tenta carga/stress massiva.** Concorrência é simulada com 2-3 atores em momentos chave (inventário+picking), não com centenas.

## 4. Arquitetura — 3 camadas

```
┌──────────────────────────────────────────────────────────────────┐
│ Camada 1 — UNIT (puro, vitest existente)                         │
│   src/lib/wms/*.test.ts · src/lib/separacao/*.test.ts            │
│   Funções puras: realocacao-resolver, custo-medio, ledger,       │
│   inventario-reconciliacao, putaway, roteamento, devolucoes,     │
│   reservas, localizacoes, movimentacoes, etc.                    │
│   Sem DB, sem rede. Já existe. Mantém-se como está.              │
│   Roda: `npm test`                                               │
├──────────────────────────────────────────────────────────────────┤
│ Camada 2 — INTEGRATION (vitest + DB staging)                     │
│   test/integration/**/*.test.ts                                  │
│   Testa contratos de RPC e queries diretas contra staging:       │
│   wms_inserir_movimentacao, wms_inventario_proxima_loc,          │
│   wms_reservar_atomico, wms_detectar_divergencias_estoque,       │
│   wms_rebuild_linha_estoque, wms_inventario_sugerir.             │
│   `globalSetup` faz seed mínimo (produtos+locs+empresas).        │
│   Roda: `npm run test:integration`                               │
├──────────────────────────────────────────────────────────────────┤
│ Camada 3 — SCENARIOS (scripts TS + HTTP contra Next dev)         │
│   scripts/wms/cenarios/catalogo/{01..NN}-*.ts                    │
│   Fluxos compostos ponta-a-ponta via /api/wms/*.                 │
│   Runner mestre orquestra: truncate → reseed → dev-server →      │
│   login → roda cada script → invariantes → relatório md+json.    │
│   Roda: `npm run scenarios` (todos) ou `tsx <script.ts>` (1)     │
└──────────────────────────────────────────────────────────────────┘
```

Cada camada usa a ferramenta que melhor se adequa. Unit/integration aproveita o vitest existente; scenarios viram scripts porque precisam orquestrar Next dev server (start/healthcheck/stop) e isso fica feio dentro de vitest workers.

## 5. Layout de arquivos

```
scripts/wms/cenarios/
  README.md                          # como rodar, como adicionar cenário, troubleshooting
  _harness/
    context.ts                       # createContext() — sb + http + session + helpers
    http.ts                          # sisoFetch wrapper (X-Session-Id + retry + timeout + assert status)
    seed.ts                          # truncateOperacional + seedInicial (idempotente)
    stubs.ts                         # registry de stubs (Tiny já existe; PrintNode + ML novos)
    invariantes.ts                   # rodarInvariantes(ctx) — 7 checks property-based
    asserts.ts                       # assertSaldo, assertMovsCount, assertPedidoStatus, assertCustoMedio...
    relatorio.ts                     # writeReport(results) → summary.md + detail.json
    dev-server.ts                    # startDevServer + waitForHealth + kill
    types.ts                         # Cenario<T>, Ctx, ScenarioResult, InvariantResult
  catalogo/
    01-pedido-auto-propria.ts
    02-pedido-transferencia.ts
    03-pedido-oc-completo.ts
    04-parcial-realocacao-cascateada.ts
    05-parcial-esgota-encaminhar.ts
    06-inventario-com-picking.ts
    07-reservas-ttl-expira.ts
    08-receber-guarda-parcial.ts
    09-entrada-direta.ts
    10-devolucao-A-recalc-custo.ts
    11-devolucao-BCD-quarentena.ts
    12-venda-direta-baixa.ts
    13-venda-direta-degradacao.ts
    14-replenishment-intra-galpao.ts
    15-transferencia-inter-galpao.ts
    16-lancamento-retroativo-reconcilia.ts
    17-ajuste-manual-com-motivo.ts
  run-all.ts                         # runner mestre
  reports/                           # gitignored
    YYYY-MM-DDTHHMMSS-summary.md
    YYYY-MM-DDTHHMMSS-detail.json

test/integration/
  ledger-rpc.test.ts                 # wms_inserir_movimentacao: locks, coerência, custo médio
  reservas-rpc.test.ts               # wms_reservar_atomico + cleanup TTL
  inventario-rpc.test.ts             # wms_inventario_proxima_loc claim hierárquico + sugerir
  reconciliacao-rpc.test.ts          # wms_detectar_divergencias_estoque + rebuild

vitest.integration.config.ts         # config separada com globalSetup pra seed mínimo

src/lib/
  printnode-stub.ts                  # novo — espelha printnode.ts quando PRINTNODE_DISABLED=true
  printnode-stub.test.ts             # contrato do stub
  ml-stub.ts                         # novo — espelha ml-api.ts quando ML_DISABLED=true
  ml-stub.test.ts                    # contrato do stub

supabase/migrations/
  YYYYMMDD_test_harness_rpc.sql      # cria wms_truncate_operacional

.env.test                            # variáveis dedicadas pra suite (commitada, secrets via local override)

package.json scripts:
  "test"              : vitest run                                       # (existente — Camada 1)
  "test:integration"  : vitest run -c vitest.integration.config.ts        # NOVO
  "scenarios"         : tsx scripts/wms/cenarios/run-all.ts               # NOVO
  "scenarios:only"    : tsx scripts/wms/cenarios/run-all.ts --only        # NOVO
```

## 6. Catálogo de cenários (17 inicial)

Cada cenário é um arquivo TS standalone que exporta `default` satisfazendo `Cenario`. Numerados pra ordem determinística. Pode adicionar mais sem mudar nada do harness.

| # | Cenário | Foco | Grupos cobertos |
|---|---|---|---|
| 01 | Pedido auto-aprovado própria | Webhook→enrich→auto→executar→separar→embalar→expedir | Pipeline |
| 02 | Pedido transferência | Aprovação manual + transferência inter-galpão (par S+E) + separação | Pipeline |
| 03 | Pedido OC completo | Aprovação OC + comprar + receber + guarda + status `aguardando_compra`→`aguardando_nf`→`aguardando_separacao` | Pipeline |
| 04 | Parcial + realocação cascateada | Bipe 3/5, loc zerou, cascade pega 2/2 em outra loc, finaliza | Pipeline |
| 05 | Parcial esgota → encaminhar/OC | Chain percorre 3 locs, esgota cobertura, modal encaminhar/OC dispara | Pipeline |
| 06 | Inventário com picking concorrente | Sessão inventário em locA, pedido bipa locA antes do bipe do inventário, reconciliação temporal (cutoff_em + saldo_no_bipe via ledger) zera divergência falsa | Concorrência |
| 07 | Reservas TTL + cleanup | Criar R com TTL real curto (2s), tentar exceder→falha, aguardar 3s + chamar cleanup→L gerado, `disponivel = saldo - reservado` em todo momento | Concorrência |
| 08 | Receber→Guarda parcial→Pendência | Receber 50 (dock RECEBIMENTO), guardar 30 (1ª loc), pendência fica com 20, guardar restante depois | Entrada |
| 09 | Entrada direta | `entrada_direta=true` pula RECEBIMENTO, 1 mov direto na loc destino | Entrada |
| 10 | Devolução cliente íntegra (A) | NF entrada categoria A→mov com `custo_unitario`→`siso_custo_medio` recalculado ponderado | Entrada |
| 11 | Devolução cliente avariada (B/C/D) | NF entrada→transfer pra QUARENTENA, saldo na picking fica intacto | Entrada |
| 12 | Venda Direta `baixa_direta` | Criar venda modo baixa_direta→1 mov S `origem_tipo='venda_manual'`, saldo cai imediato | Entrada |
| 13 | Venda Direta degradação | Pediu `baixa_direta` mas faltou saldo→degrada pra `aguardando_separacao`, response `degradado:true` | Entrada |
| 14 | Replenishment intra-galpão | Overstock→picking, par S+E mesma `origem_id`, custo médio inalterado | Pipeline |
| 15 | Transferência inter-galpão | CWB→SP, S no origem + E no destino, pedido transf coerente | Pipeline |
| 16 | Lançamento retroativo + reconcilia | Registrar pendência→mov real chega→`/lancamento-retroativo/[id]/reconciliar` zera pendência | Entrada |
| 17 | Ajuste manual com motivo | Mov A com `origem_tipo='ajuste_manual'` + `observacoes` preenchida (obrigatória) | Pipeline |

**Cada cenário roda em ordem alfabética por nome de arquivo.** Não há ordem implícita: cada cenário cria seus próprios SKUs com prefixo `TEST-NN-<random>` e não depende de estado deixado por outros. Isolamento por nomenclatura, não por database transaction.

## 7. Harness — DSL de cenários

### 7.1 Forma de um cenário

```ts
// scripts/wms/cenarios/catalogo/04-parcial-realocacao-cascateada.ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "04 — Parcial + realocação cascateada",
  descricao: "Bipa 3/5 com loc zerando; cascade pega 2/2 em outra loc do mesmo galpão",
  tags: ["separacao", "realocacao", "parcial"],

  setup: async (ctx: Ctx) => {
    const sku = await ctx.criarProduto({ sku: ctx.skuUnico("04"), descricao: "Filtro teste 04" });
    const empresa = ctx.staging.empresas.netair;
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 3 });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 2 });
    return { sku, empresa };
  },

  run: async (ctx, { sku, empresa }) => {
    const pedido = await ctx.webhook({
      empresa: empresa.cnpj,
      items: [{ sku, qty: 5 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: "propria" });
    await ctx.aprovar(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");

    await ctx.iniciarSeparacao(pedido.id);
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 3, loc_zerou: true });
    await ctx.aguardarRealocacao(pedido.id, sku, "A-01-02");
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 2 });
    await ctx.concluirSeparacao(pedido.id);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 0);
    await ctx.assertMovsCount(sku, 2);
    await ctx.assertPedidoStatus(undefined, "separado");
  },
} satisfies Cenario;
```

O runner injeta `ctx` (criado uma vez por bateria), chama `setup → run → assertEsperado → invariantes`, e captura erros estruturados.

### 7.2 Interface `Ctx`

Métodos agrupados por responsabilidade. Setup helpers usam DB/lib direto (sem cerimônia HTTP). Fluxos de negócio passam por HTTP. Waits e asserts são pure utilities.

**Infra:** `sb` (service role), `http`, `staging` (fixtures de empresas/galpões/locs default de `scripts/wms/cenarios.ts`), `log`, `skuUnico(prefix)`.

**Setup (DB direto):** `criarProduto`, `criarLocalizacao`, `criarFornecedor`, `semearSaldo`.

**Fluxos HTTP:**
- Pedido: `webhook`, `aprovar`, `iniciarSeparacao`, `bipar`, `parcial`, `desfazerParcial`, `encaminhar`, `concluirSeparacao`, `embalar`, `expedir`
- Compras: `comprar`, `receberCompra`, `prepararEmbalagem`
- Recebimento físico: `receber`, `guardar`
- Movs operacionais: `transferirGalpao`, `replenishment`, `ajusteManual`, `lancamentoRetroativo`, `reconciliarRetroativo`
- Vendas: `criarVendaDireta`, `disponibilidadeVenda`
- Reservas: `reservar`, `cleanupReservas`
- Devoluções: `classificarDevolucao`
- Inventário: `criarSessaoInventario`, `entrarParty`, `proximaLoc`, `bipeInventario`, `finalizarLocInventario`, `aprovarInventario`, `aplicarInventario`

**Waits (polling com timeout):** `aguardarStatus`, `aguardarStatusSeparacao`, `aguardarRealocacao`, `aguardarFilaVazia`, `aguardarPendenciaGuarda`. Cada wait tem `timeout_ms` default conservador (5-10s) com possibilidade de override.

**Asserts específicos:** `assertSaldo`, `assertReservado`, `assertMovsCount`, `assertPedidoStatus`, `assertCustoMedio`, `assertPendenciaQuitada`, `assertSemReservasOrfas`.

**Espera real (cenários que dependem de TTL):** `ctx.aguardar(ms)` é um `setTimeout` puro. Cenário 07 usa TTL real de 2 segundos e `await ctx.aguardar(3000)` antes do cleanup. Não há fake clock — a suite é manual e segundos a mais não importam. Evita complexidade de overriding `now()` que não sobreviveria entre transações HTTP.

### 7.3 Tipos centrais

```ts
export interface Cenario<TSetup = unknown> {
  nome: string;                   // ex: "04 — Parcial + realocação cascateada"
  descricao: string;
  tags: string[];                 // ["separacao", "realocacao", "parcial"]
  setup: (ctx: Ctx) => Promise<TSetup>;
  run: (ctx: Ctx, setup: TSetup) => Promise<void>;
  assertEsperado: (ctx: Ctx, setup: TSetup) => Promise<void>;
  skip?: boolean;
  apenasSe?: () => boolean;
}

export interface ScenarioResult {
  nome: string;
  status: "pass" | "fail" | "skip";
  duracao_ms?: number;
  motivo?: "assert" | "invariante" | "timeout" | "setup" | "run";
  erro?: { mensagem: string; stack?: string };
  invariantes?: InvariantResult[];
  detalhes?: unknown;
}

export interface InvariantResult {
  nome: string;
  ok: boolean;
  detalhes?: unknown;             // diff quando falha
  duracao_ms: number;
}
```

## 8. Invariantes globais (oráculo de correção)

Rodam **automaticamente** ao fim de **todo** cenário — sem o autor precisar pedir. Se qualquer uma falhar, cenário é marcado FAIL mesmo que `assertEsperado` tenha passado. Esses são os checks property-based que pegam bugs sutis.

| # | Invariante | Como checa | Bug que pega |
|---|---|---|---|
| I1 | **Ledger ↔ cache coerente** | `SELECT * FROM wms_detectar_divergencias_estoque()` retorna vazio | RPC esqueceu de atualizar `siso_estoque` ou caminho legado escreveu fora do ledger |
| I2 | **`disponivel = saldo - reservado`** | Query check em `siso_estoque`: linha onde `disponivel ≠ saldo - reservado` | Drift do coluna GENERATED (não deveria acontecer, mas sanity) |
| I3 | **Custo médio coerente** | Recalcula custo médio ponderado das movs de entrada por SKU + compara com `siso_custo_medio.custo_medio` (tolerância 0.001) | RPC não recalculou em devolução A; ou recalculou com fórmula errada |
| I4 | **Sem reservas órfãs** | Toda mov 'R' tem mov 'L' correspondente OU `expira_em > now()` | Cleanup esqueceu de liberar; reserva criada sem TTL |
| I5 | **Pendências de guarda coerentes** | `qty_pendente = qty_inicial - qty_guardada` em todas linhas; status='guardada' implica qty_pendente=0 | Bug no trigger ou na guarda parcial |
| I6 | **Pares S+E balanceados** | Pra `origem_tipo IN (transferencia_galpao, transferencia_localizacao, ajuste_pick_zerou)` toda `origem_id` tem exatamente 1 S + 1 E com qty iguais | Realocação só escreveu 1 lado; transferência perdeu 1 mov |
| I7 | **Fila vazia ao fim** | `siso_fila_execucao` sem linhas em status `pendente` ou `executando` | Worker travou; cenário não esperou conclusão; pedido em loop |

**Asserts específicos** (autor decide, dentro de `assertEsperado`) pegam regressões de comportamento esperado. **Invariantes** (harness, automático) pegam violações de propriedades fundamentais. Os dois são complementares.

## 9. Setup/Teardown

### 9.1 Truncate operacional

RPC novo `wms_truncate_operacional` em migration nova. Limpa só tabelas operacionais — preserva catálogo (empresas, galpões, locs, usuários, fornecedores, produtos do catálogo).

```sql
CREATE OR REPLACE FUNCTION wms_truncate_operacional() RETURNS void AS $$
BEGIN
  TRUNCATE
    siso_movimentacoes,
    siso_estoque,
    siso_custo_medio,
    siso_pedidos,                  -- cascade: pedido_itens + realocacoes + estoques + historico
    siso_fila_execucao,
    siso_wms_pendencias_guarda,
    siso_inventario_sessoes,       -- cascade: operadores + localizacoes + contagens + divergencias
    siso_transferencias,           -- cascade: transferencia_itens
    siso_ordens_compra,
    siso_devolucoes_pendentes,
    siso_webhook_logs,
    siso_api_calls,
    siso_logs,
    siso_erros,
    siso_localizacao_locks
  CASCADE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

Roda **uma vez** no início de `npm run scenarios`. Não roda entre cenários (cenários usam SKUs únicos `TEST-NN-<random>` pra evitar colisão).

### 9.2 Seed inicial

Roda depois do truncate. Idempotente via upsert.

- Empresas NetAir/NetParts (já cadastradas em staging)
- Galpões CWB/SP — cada um com loc `tipo='recebimento' codigo='RECEBIMENTO'`
- Galpão CWB: `A-01-01..A-01-10` (picking), `B-02-01..B-02-05` (overstock)
- Galpão SP: `C-01-01..C-01-10` (picking)
- Usuário `test-runner` / PIN `9999` / cargo `admin` (pra sessão HTTP)
- Fornecedor `TestSupplier-Default` com `prefixo_sku='TEST'` (pra `sku-fornecedor.ts` resolver)
- Galpões preferenciais via `siso_empresa_galpoes_preferenciais` (NetAir→CWB geo=0, NetParts→SP geo=0)

### 9.3 Tempo real, não fake

Não há fake clock. Cenários que dependem de TTL (só o 07 hoje) usam intervalos curtos reais (TTL=2s) e `await ctx.aguardar(ms)` entre os passos. A suite é manual; poucos segundos adicionais não importam.

Tentar overriding `now()` via GUC ou similar não funciona porque cada chamada HTTP abre transação nova — uma session variable transaction-local do cenário não chega ao endpoint de cleanup. Tabela compartilhada com offset funcionaria mas adiciona complexidade desproporcional ao único cenário que precisa.

## 10. Stubs de integração

### 10.1 Tiny (existente)

`src/lib/tiny-stub.ts` já existe. Ativado por `TINY_DISABLED=true`. Suite reaproveita sem modificação.

### 10.2 PrintNode (novo)

`src/lib/printnode-stub.ts` — espelha a interface pública de `printnode.ts`. Ativo quando `PRINTNODE_DISABLED=true`. Comportamento:

- Não chama API real.
- Guarda jobs em buffer in-memory (`__printJobsBuffer: PrintJob[]`) exposto pra assertion (cenários podem ler "etiqueta foi gerada com payload X").
- Retorna IDs incrementais fake (`printjob-001`, `printjob-002`, ...).
- Imprimir ZPL e imprimir PDF têm comportamento idêntico (só logam tipo + tamanho).

`printnode-stub.test.ts` documenta o contrato esperado (mesmas funções, mesmos return types).

### 10.3 Mercado Livre (novo)

`src/lib/ml-stub.ts` — espelha `ml-api.ts`. Ativo quando `ML_DISABLED=true`. Returns determinísticos por endpoint (anúncios, OAuth refresh, etc.). Webhooks de ML pra entrar no pipeline são triggados via `ctx.webhook({ tipo: "nota_fiscal", ... })` direto na rota `/api/wms/webhook/tiny` — ML não precisa estar ativo pra suite.

### 10.4 Flag de ativação

`.env.test` na raiz, commitado, lido pelo runner antes de subir o dev server:

```bash
TINY_DISABLED=true
PRINTNODE_DISABLED=true
ML_DISABLED=true
NEXT_PUBLIC_SUPABASE_URL=https://ehbxpbeijofxtsbezwxd.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging anon — pode commitar>
SUPABASE_SERVICE_ROLE_KEY=<staging service — NÃO commitar, override via .env.test.local>
WORKER_SECRET=test-worker-secret
TEST_RUNNER_BASE_URL=http://localhost:3001
TEST_RUNNER_PIN=9999
TEST_RUNNER_NOME=test-runner
```

`.env.test.local` (gitignored) tem o `SUPABASE_SERVICE_ROLE_KEY` real.

## 11. Runner mestre

Pseudo-código de `scripts/wms/cenarios/run-all.ts`:

```
parse args (--filter <tag>, --only <name|num>, --keep-server, --report-only, --port=N)
loadEnv(".env.test")  → carrega .env.test.local por cima
log "1/6 subindo Next dev server em :3001"
server = startDevServer({ port: 3001 })
waitForHealth("http://localhost:3001/api/auth/me", timeout=30s)
  └─ /api/auth/me retorna 401 sem session; aceitamos qualquer resposta HTTP como "vivo"
log "2/6 truncate + reseed staging"
sb = createServiceClient()
await sb.rpc("wms_truncate_operacional")
await seedInicial(sb)
log "3/6 login test-runner"
sessionId = await login(sb, "test-runner", "9999")
log "4/6 criando contexto"
ctx = createContext({ sb, baseUrl: "http://localhost:3001", sessionId })
log "5/6 executando cenários"
arquivos = glob("scripts/wms/cenarios/catalogo/*.ts").sort()
results = []
for arq in arquivos:
  cenario = (await import(arq)).default
  if cenario.skip or !filterMatches(cenario, args):
    results.push({ nome, status: "skip" })
    continue
  result = await rodarCenario(ctx, cenario)
  results.push(result)
  log result
log "6/6 relatório"
await writeReport(results)
if !args.keepServer: await server.kill()
exit(results.some(r => r.status === "fail") ? 1 : 0)
```

`rodarCenario` envolve `setup → run → assertEsperado → invariantes` em try/catch com serialização estruturada de erros.

## 12. Relatório

Dois outputs em `scripts/wms/cenarios/reports/` (gitignored), timestamped:

**`<timestamp>-summary.md`** — humano, focado em falhas. Exemplo:

```markdown
# Suite Scenarios — 2026-05-21T14:30:22

**Total:** 17 cenários · **Pass:** 16 · **Fail:** 1 · **Skip:** 0 · **Tempo:** 3m 42s

## Falhas

### ❌ 06 — Inventário com picking concorrente (1.2s)
**Motivo:** invariante I1 (`invLedgerVsCache`) falhou após `assertEsperado` passar.

Linha divergente:
| produto | galpao | loc | saldo_cache | sigma_movs | delta |
|---|---|---|---|---|---|
| TEST-06-a7c | CWB | A-01-03 | 5 | 4 | +1 |

Provável causa: reconciliação temporal não descontou bipe que aconteceu depois do `cutoff_em`.

## Cenários OK
- ✅ 01 — Pedido auto-aprovado própria (12.3s)
- ✅ 02 — Pedido transferência (18.7s)
...
```

**`<timestamp>-detail.json`** — máquina, pra grep/jq/CI futuro:

```json
{
  "iniciado_em": "2026-05-21T14:30:22Z",
  "duracao_ms": 222000,
  "totais": { "pass": 16, "fail": 1, "skip": 0 },
  "cenarios": [
    { "nome": "01 — ...", "status": "pass", "duracao_ms": 12300, "invariantes": [...] },
    { "nome": "06 — ...", "status": "fail", "motivo": "invariante", "detalhes": {...} }
  ]
}
```

## 13. Como adicionar cenário novo

1. Criar arquivo em `scripts/wms/cenarios/catalogo/NN-nome-curto.ts` com próximo número.
2. Exportar default que satisfaz `Cenario`.
3. Usar `ctx.skuUnico("NN")` pra evitar colisão com SKUs de outros cenários.
4. Não precisa registrar em lugar nenhum — runner descobre por glob.

### Debug standalone (um cenário só)

Pra debugar um cenário sem rodar a suite inteira, todo arquivo em `catalogo/` termina com:

```ts
import { runStandalone } from "../_harness/standalone";
if (import.meta.url === `file://${process.argv[1]}`) {
  runStandalone(module.exports.default);
}
```

`runStandalone(cenario)`:
1. Carrega `.env.test`.
2. **Assume `npm run dev` já está rodando** em `TEST_RUNNER_BASE_URL` (não sobe dev server).
3. Faz truncate + reseed (igual runner mestre).
4. Login do `test-runner`.
5. Roda só esse cenário + invariantes.
6. Imprime resultado no stdout.

Comando: `npx tsx scripts/wms/cenarios/catalogo/04-parcial-realocacao-cascateada.ts`

Útil pra ciclar rápido: edita cenário → re-roda → inspeciona via `npm run dev` aberto no browser.

## 14. Trade-offs e riscos aceitos

| Risco | Mitigação |
|---|---|
| Suite suja staging (operadores humanos coincidentes) | RPC `wms_truncate_operacional` no início — operadores em staging perdem trabalho em andamento. Doc avisa: **não rodar suite enquanto alguém testa em staging manualmente.** |
| Webhook é fire-and-forget — `ctx.aguardarStatus` pode ter race | Polling com timeout (5s default) + log de cada tentativa. Estourou timeout → falha com último estado conhecido + dump de `siso_logs` + `siso_erros` relevantes. |
| Custo médio drift acumulado entre cenários | Truncate roda 1× por bateria, não entre cenários. Cada cenário usa SKU único → custo médio é específico do SKU criado. Sem drift cross-scenario. |
| `siso_fila_execucao` com job lento pendurando o runner | `aguardarFilaVazia` tem timeout (10s default). Estourou → cenário falha com lista de jobs pendentes (`SELECT * FROM siso_fila_execucao WHERE status IN ('pendente','executando')`). |
| Dev server na porta 3001 ocupado | Healthcheck no start checa porta livre; se ocupada, runner aborta com mensagem clara. Flag `--port=N` permite override. |
| Cenário 06 precisa timing real entre bipes | Usa `ctx.aguardarStatusSeparacao` entre passos pra determinismo. Pra TTL de reserva (cenário 07), usa TTL real curto (2s) + `ctx.aguardar(3000)` antes do cleanup. Sem fake clock. |
| Stubs (PrintNode/ML) divergem do real | Cada stub vem com 1 teste unitário em `*-stub.test.ts` que documenta o contrato esperado. Mudanças no `ml-api.ts` ou `printnode.ts` reais exigem update no stub. Risco residual: aceitável, dado que suite roda manual e divergência aparece no primeiro use real. |
| Suite serial (não paralelizável) | Staging é shared resource. 17 cenários sequenciais em ~5 min são aceitáveis dada cadência manual. Migração futura pra CI exige Supabase branches efêmeros — fora deste design. |
| Lossy info quando cenário falha | Em todo `fail`, runner dumpa últimas 50 linhas de `siso_logs` + `siso_erros` filtradas pelo `correlation_id` do cenário (gerado no início de `setup`) no detail.json. |

## 15. Critérios de aceitação do design

- [ ] Camada 1 (unit) continua passando sem mudanças (`npm test`).
- [ ] Camada 2 (integration) tem 4 arquivos cobrindo RPCs centrais e roda contra staging (`npm run test:integration`).
- [ ] Camada 3 (scenarios) tem 17 cenários no catálogo, runner mestre orquestra dev server + truncate + reseed + login + execução + relatório.
- [ ] 7 invariantes globais rodam ao fim de todo cenário automaticamente.
- [ ] Stubs PrintNode + ML criados em `src/lib/` espelhando a interface dos clientes reais.
- [ ] RPC `wms_truncate_operacional` aplicada em staging via migration.
- [ ] Relatório markdown + JSON gerados em `reports/` ao fim da bateria.
- [ ] `npm run scenarios -- --only 04` roda só o cenário 04. `tsx catalogo/04-*.ts` direto também funciona.
- [ ] README em `scripts/wms/cenarios/` explica como rodar, como adicionar cenário, como debugar falha.

## 16. O que fica fora deste design (próximos passos)

- Migração pra CI (exige Supabase branches efêmeros)
- Testes de UI (Playwright)
- Stress/carga (N operadores simultâneos)
- Property-based testing com fast-check (geradores aleatórios de cenários)
- Métricas históricas de duração por cenário (regressão de performance)
- Hook do PrintNode real opcional (`PRINTNODE_DISABLED=false` em alguns cenários pra validar geração ZPL)

Esses são extensões naturais quando a base estiver firmada.
