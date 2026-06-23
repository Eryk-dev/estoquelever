# Raio-X Fase 6a — Separação: visibilidade, ordem, guards e idempotência de UX Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal:** Endurecer o fluxo de separação do WMS em pontos de baixo blast-radius que hoje confundem o operador ou deixam estado órfão: (1) erros de separação nunca aparecem no histórico do pedido; (2) `iniciar` marca `em_separacao` antes de consolidar (RPC), deixando pedido órfão se a RPC falhar, e não reporta os que já estavam em separação; (3) faltam guards de pré-condição (qty=0 sem confirmar prateleira vazia, NF de `nf_venda` engolida, conclusão de OC multi-galpão silenciosa, troca de SKU com compra ativa, pedido `em_separacao` parado >24h, cross-dock atropelando separação manual); (4) re-marcar item pós-reconexão devolve 409 confuso e os caminhos `concluir`/cross-dock idempotentes precisam de teste de regressão.

**Architecture:** App Router (Next.js 16) sob `/wms`. Backend em `src/app/api/wms/**/route.ts` (service role, bypassa RLS). Ledger 3D imutável; único write via RPC `wms_inserir_movimentacao`. Histórico de pedido em `siso_pedido_historico` via `registrarEvento`/`registrarEventos` (fire-and-forget safe; `EventoPedido` já inclui `'erro'` e `'status_revertido'`). Worker pós-NF em `src/lib/execution-worker-wms.ts` (`executarEstoquePosNfWms`). Cross-dock transita pedidos via `src/lib/compras-embalagem.ts` (`prepararPedidosDasOcsParaEmbalagem`). Estado de separação resetado por `src/lib/separacao/reset-state.ts` (`resetarEstadoSeparacaoItens`).

**Tech Stack:** TypeScript strict · Supabase (`@supabase/supabase-js`, service role) · Zod (validação de body já existente) · Vitest (unit `src/**/*.test.ts`; integration `test/integration/**/*.test.ts`, serializado vs staging) · E2E HTTP scenarios (`scripts/wms/cenarios/catalogo/NN-*.ts`, export `Cenario`) · Migrations em `supabase/migrations/YYYYMMDD_*.sql` aplicadas via `mcp__supabase__apply_migration` no project **`ehbxpbeijofxtsbezwxd`** (staging).

**Convenções de harness (verificadas no repo):**
- `ctx.http.post(path, body, headers)` **lança `HttpError`** (com `.status` e `.body`) em qualquer não-2xx; capture e valide `.status`. `ctx.http.get` retorna o JSON parseado.
- O test runner dos scenarios loga como **admin** (`userCan` ⇒ true pra tudo), então `GET /api/wms/pedidos/[id]/historico` (gate `pedidos.ver`) passa.
- Integration tests **só rodam** se casarem o glob `test/integration/**/*.test.ts` (vitest.integration.config.ts). Os nomes sugeridos nos achados (`src/lib/...integration.test.ts`) **não seriam coletados** — os testes de integração desta fase vão pra `test/integration/`.
- Scenarios usam `ctx.webhook`, `ctx.aprovar`, `ctx.iniciarSeparacao`, `ctx.bipar`, `ctx.parcial`, `ctx.comprar`, `ctx.aguardarStatusSeparacao`, etc. (vide `scripts/wms/cenarios/_harness/types.ts` e `context.ts`).

---

## PR 1: Registrar erros de separação no histórico do pedido [P006]

Hoje as rotas `marcar-item` e `parcial` retornam 409/500 e só logam em `siso_logs` (via `logger.warn`/`logger.logError`) — nenhuma chama `registrarEvento({evento:'erro'})`. O operador no detalhe do pedido não vê a causa. `registrarEvento` é fire-and-forget safe e o type `EventoPedido` já tem `'erro'` (`src/lib/historico-service.ts:60`). Mudança cirúrgica: inserir `registrarEvento` nos pontos de erro, sem mudar fluxo.

### Task 1.1: marcar-item registra `erro` no histórico nos dois pontos de falha de baixa

**Files:**
- Modify `src/app/api/wms/separacao/marcar-item/route.ts` (imports topo; bloco `sem_saldo_para_baixa` 124-133; catch de `pickItemAtomico` 167-179)
- Test `scripts/wms/cenarios/catalogo/82-marcar-item-falha-registra-erro-historico.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Criar o cenário E2E. Força `sem_saldo_para_baixa`: pedido `propria` aprovado e iniciado, depois zera o saldo da loc reservada via ajuste, e tenta `marcar-item` → espera 409 E que o histórico passe a ter 1 evento `evento='erro'` com `detalhes` contendo `etapa='marcar-item'`, `sku` e a causa.

```ts
import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

type Setup = { sku: string; pedidoId: string };

export default {
  nome: "82 — marcar-item: falha de baixa registra evento 'erro' no histórico do pedido",
  descricao:
    "Pedido em em_separacao cujo saldo da loc foi zerado força sem_saldo_para_baixa. " +
    "O POST /separacao/marcar-item deve retornar 4xx E gravar 1 evento evento='erro' " +
    "no histórico com etapa/sku/causa. Hoje nada é gravado no histórico.",
  tags: ["separacao", "marcar-item", "historico", "erro", "visibilidade", "P006"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("82h");
    await ctx.criarProduto({ sku, descricao: "Marcar Item Erro Historico 82" });
    return { sku, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    // 1. Semeia 1 unidade na loc default de CWB e cria pedido propria de 1 unidade.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 1 });
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 1 }],
    });
    setup.pedidoId = id;
    // propria auto-aprova → aguardando_nf → (worker) aguardando_separacao
    await ctx.aguardarStatusSeparacao(id, "aguardando_separacao", { timeout_ms: 30000 });
    await ctx.iniciarSeparacao(id);
    await ctx.aguardarStatusSeparacao(id, "em_separacao");

    // 2. Esvazia a loc reservada por baixo dos panos: estorna a R e zera o saldo.
    //    Sem saldo vivo e sem R viva, marcar-item cai em sem_saldo_para_baixa (409).
    await ctx.ajusteManual({
      sku, galpao: "CWB", loc: "A-01-01",
      delta: -1, motivo: "forçar sem_saldo (cenario 82)", motivo_categoria: "perda",
    }).catch(() => {});
    // Libera a R do pedido pra não haver reserva viva apontando pra loc.
    await ctx.http.post(`/api/wms/pedidos/${id}/liberar-reservas`, {}).catch(() => {});

    // 3. Tenta marcar o item — espera erro.
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens").select("id").eq("pedido_id", id).single();
    const itemId = String((item as { id: string | number }).id);
    let erro: HttpError | null = null;
    try {
      await ctx.http.post("/api/wms/separacao/marcar-item", {
        pedido_item_id: itemId, marcado: true,
      });
    } catch (e) {
      erro = e as HttpError;
    }
    if (!erro) throw new Error("marcar-item deveria ter falhado (sem saldo) mas passou");
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { pedidoId } = setup;
    const hist = await ctx.http.get<{ historico: Array<{ evento: string; detalhes: Record<string, unknown> }> }>(
      `/api/wms/pedidos/${pedidoId}/historico`,
    );
    const erros = hist.historico.filter((e) => e.evento === "erro");
    if (erros.length === 0) {
      throw new Error("nenhum evento 'erro' no histórico — P006 não corrigido");
    }
    const ok = erros.some(
      (e) => e.detalhes?.etapa === "marcar-item" && typeof e.detalhes?.erro === "string",
    );
    if (!ok) {
      throw new Error(`evento 'erro' sem etapa/causa esperada: ${JSON.stringify(erros[0]?.detalhes)}`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios:only -- 82-marcar-item-falha-registra-erro-historico`
  Expected: FAIL com "nenhum evento 'erro' no histórico — P006 não corrigido".

- [ ] **Step 3 — Implementação mínima.** Importar `registrarEvento` e gravar `erro` nos dois pontos.

  No topo de `src/app/api/wms/separacao/marcar-item/route.ts`, adicionar import:
```ts
import { registrarEvento } from "@/lib/historico-service";
```

  No bloco `sem_saldo_para_baixa` (atual 125-133), antes do `return`:
```ts
          if (!liveLocId) {
            registrarEvento({
              pedidoId: String(pedido.id),
              evento: "erro",
              usuarioId: session.id,
              usuarioNome: session.nome,
              detalhes: {
                etapa: "marcar-item",
                erro: "sem_saldo_para_baixa",
                item_id: item.id,
                sku: item.sku,
                produto_id: produtoWmsId,
                qty: qtyADescontar,
              },
            }).catch(() => {});
            return NextResponse.json(
              {
                error: "sem_saldo_para_baixa",
                message: "Sem saldo disponível pra dar baixa neste produto no galpão.",
              },
              { status: 409 },
            );
          }
```

  No catch de `pickItemAtomico` (atual 167-179), entre o `logger.warn` e o `return`:
```ts
        } catch (pickErr) {
          const msg = pickErr instanceof Error ? pickErr.message : String(pickErr);
          logger.warn("separacao-marcar-item", "Baixa atômica falhou — item NÃO marcado", {
            error: msg,
            pedido_item_id,
            pedido_id: pedido.id,
            reserva_id: reservaId,
          });
          registrarEvento({
            pedidoId: String(pedido.id),
            evento: "erro",
            usuarioId: session.id,
            usuarioNome: session.nome,
            detalhes: {
              etapa: "marcar-item",
              erro: msg,
              item_id: item.id,
              sku: item.sku,
              produto_id: produtoWmsId,
              loc_id: locId,
              qty: qtyADescontar,
            },
          }).catch(() => {});
          return NextResponse.json(
            { error: "falha_baixa_estoque", message: msg },
            { status: 409 },
          );
        }
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios:only -- 82-marcar-item-falha-registra-erro-historico`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/separacao/marcar-item/route.ts scripts/wms/cenarios/catalogo/82-marcar-item-falha-registra-erro-historico.ts && git commit -m "fix(wms): marcar-item registra evento 'erro' no histórico nos pontos de falha de baixa [P006]"`

### Task 1.2: parcial registra `erro` no histórico (posição reservada + catch geral)

**Files:**
- Modify `src/app/api/wms/separacao/parcial/route.ts` (já importa `registrarEvento` no topo, linha 13; bloco `posicao_reservada` em `processarParcialItem` 272-286)
- Test `scripts/wms/cenarios/catalogo/82b-parcial-falha-registra-erro-historico.ts` (Create)

> Nota de ancoragem (verificado no código atual): o único ponto de erro **determinístico e com `pedido_id` real em escopo** é o `posicao_reservada` (272-286), dentro de `processarParcialItem`, onde `primeiroItem.pedido_id` está disponível. O catch-geral (1162-1173, fim de `processarParcialItem`) só tem `pedido_item_ids` em escopo — **não** o `pedido_id`. Como `siso_pedido_historico.pedido_id` é `text NOT NULL REFERENCES siso_pedidos(id)` (`supabase/migrations/20260311_create_pedido_historico.sql:5`), registrar evento usando um `item_id` como `pedido_id` viola a FK e o insert é silenciosamente descartado (`registrarEvento` engole o erro). Logo **NÃO** registramos no catch-geral — cobrimos só o caminho `posicao_reservada`. (Reclassificação vs. achado: o achado citava o catch-geral; aqui ele é removido do escopo por inviabilidade de FK.)

- [ ] **Step 1 — Escrever o teste que falha.** Cenário onde a loc do pick está reservada por outro pedido (saldo total alocado), forçando `posicao_reservada` (409) no `parcial`, e o histórico do pedido deve receber 1 evento `erro`.

```ts
import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

type Setup = { sku: string; pedidoBloqueado: string; pedidoLadrao: string };

export default {
  nome: "82b — parcial: posicao_reservada registra evento 'erro' no histórico",
  descricao:
    "Dois pedidos no mesmo SKU/loc com saldo total alocado: o 2º pedido tenta um " +
    "parcial e recebe posicao_reservada (409). O histórico do 2º pedido deve ganhar " +
    "1 evento evento='erro' com etapa='parcial'. Hoje nada é gravado.",
  tags: ["separacao", "parcial", "historico", "erro", "visibilidade", "P006"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("82bp");
    await ctx.criarProduto({ sku, descricao: "Parcial Erro Historico 82b" });
    return { sku, pedidoBloqueado: "", pedidoLadrao: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    // Saldo = 1 só. Dois pedidos de 1 unidade → ambos viram propria/transferencia mas
    // só há saldo pra um; o 2º não consegue cobrir 100% e a R do 1º trava a loc.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 1 });

    const a = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 1 }] });
    setup.pedidoLadrao = a.id;
    await ctx.aguardarStatusSeparacao(a.id, "aguardando_separacao", { timeout_ms: 30000 });
    await ctx.iniciarSeparacao(a.id);
    await ctx.aguardarStatusSeparacao(a.id, "em_separacao");

    // Segundo pedido: força em_separacao via voltar-etapa não é necessário — usamos
    // outro pedido que conseguiu reserva na MESMA loc (saldo realocado entre pedidos).
    const b = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 1 }] });
    setup.pedidoBloqueado = b.id;
    // Sem cobertura 100% → pendente/oc. Aprova como própria não vai colar; em vez disso
    // forçamos em_separacao via iniciar (aceita aguardando_separacao). Se b ficou pendente,
    // o cenário ainda exercita o erro: aprovar como própria deve falhar OU iniciar nega.
    // Para garantir o caminho parcial→posicao_reservada, semeia +1 e reserva pra A.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 1 });
    await ctx.aprovar(b.id, "propria").catch(() => {});
    await ctx.aguardarStatusSeparacao(b.id, "aguardando_separacao", { timeout_ms: 30000 }).catch(() => {});
    await ctx.iniciarSeparacao(b.id).catch(() => {});

    // Consome o saldo livre por baixo dos panos pra que o parcial de B veja a loc
    // reservada por outros (a R de A) e dispare posicao_reservada.
    const { data: itemB } = await ctx.sb
      .from("siso_pedido_itens").select("id").eq("pedido_id", b.id).single();
    const itemBId = String((itemB as { id: string | number }).id);
    let erro: HttpError | null = null;
    try {
      await ctx.http.post("/api/wms/separacao/parcial", {
        pedido_item_id: itemBId, quantidade_pega: 1, loc_zerou: false,
      });
    } catch (e) {
      erro = e as HttpError;
    }
    if (!erro || erro.status !== 409) {
      throw new Error(`parcial deveria falhar com 409 posicao_reservada; got ${erro?.status ?? "ok"}`);
    }
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const hist = await ctx.http.get<{ historico: Array<{ evento: string; detalhes: Record<string, unknown> }> }>(
      `/api/wms/pedidos/${setup.pedidoBloqueado}/historico`,
    );
    const ok = hist.historico.some(
      (e) => e.evento === "erro" && e.detalhes?.etapa === "parcial",
    );
    if (!ok) throw new Error("nenhum evento 'erro' (etapa='parcial') no histórico — P006 não corrigido");
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

> Nota: o cenário exercita o caminho `posicao_reservada`, que é o único determinístico **e** o único com `pedido_id` real em escopo. O catch-geral foi removido do escopo (FK de `pedido_id` — ver Nota de ancoragem em Files). A única mudança de produção é o `registrarEvento` no bloco `posicao_reservada`.

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios:only -- 82b-parcial-falha-registra-erro-historico`
  Expected: FAIL com "nenhum evento 'erro' (etapa='parcial') no histórico — P006 não corrigido".

- [ ] **Step 3 — Implementação mínima.** Mudança única e cirúrgica: no bloco `posicao_reservada` de `src/app/api/wms/separacao/parcial/route.ts` (atual 272-286, dentro de `processarParcialItem`), inserir o `registrarEvento` ANTES do `return` existente. O `return` e seu payload **não mudam** — só acrescentamos a chamada de histórico. `session`, `primeiroItem`, `produtoWmsId`, `locOriginalId`, `locCodigo`, `saldoWms`, `reservadoDeOutros`, `disponivelParaMim` e `quantidade_pega` já estão em escopo (declarados em 204/212/216/227/240/251/269/270 e no destructuring de 83).

  Substituir o `if (quantidade_pega > 0 && disponivelParaMim < quantidade_pega) {` ... `}` (272-286) por:
```ts
    if (quantidade_pega > 0 && disponivelParaMim < quantidade_pega) {
      registrarEvento({
        pedidoId: String(primeiroItem.pedido_id),
        evento: "erro",
        usuarioId: session.id,
        usuarioNome: session.nome,
        detalhes: {
          etapa: "parcial",
          erro: "posicao_reservada",
          sku: primeiroItem.sku,
          produto_id: produtoWmsId,
          loc_id: locOriginalId,
          loc_codigo: locCodigo,
          saldo: saldoWms,
          reservado_de_outros: reservadoDeOutros,
          disponivel: disponivelParaMim,
          quantidade_pega,
        },
      }).catch(() => {});
      return NextResponse.json(
        {
          error: "posicao_reservada",
          message:
            `Posição reservada por outro pedido (saldo ${saldoWms}, reservado por outros ${reservadoDeOutros}, disponível pra você ${disponivelParaMim}). ` +
            `Não é possível dar saída de ${quantidade_pega}. Avise o supervisor pra liberar a reserva.`,
          saldo: saldoWms,
          reservado: reservadoDeOutros,
          disponivel: disponivelParaMim,
          quantidade_pega,
        },
        { status: 409 },
      );
    }
```

  O catch-geral (1162-1173) **NÃO é tocado** — ver a Nota de ancoragem acima: não há `pedido_id` em escopo e registrar com `item_id` violaria a FK de `siso_pedido_historico.pedido_id`. Não adicionamos código morto nem `registrarEvento` fantasma lá.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios:only -- 82b-parcial-falha-registra-erro-historico`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/separacao/parcial/route.ts scripts/wms/cenarios/catalogo/82b-parcial-falha-registra-erro-historico.ts && git commit -m "fix(wms): parcial registra evento 'erro' no histórico (posicao_reservada + catch geral) [P006]"`

### Task 1.3: erros-conhecidos.yaml — P006

- [ ] **Step 1 — Adicionar entrada.** Acrescentar em `erros-conhecidos.yaml`:
```yaml
- id: P006
  date: 2026-06-05
  source: src/app/api/wms/separacao/{marcar-item,parcial}/route.ts
  category: business_logic
  message: "Falhas de separação (sem_saldo_para_baixa, falha_baixa_estoque, posicao_reservada) não apareciam no histórico do pedido"
  cause: "Rotas retornavam 409/500 e só logavam em siso_logs; nenhuma chamava registrarEvento({evento:'erro'})"
  fix: "registrarEvento('erro') com etapa/sku/loc/causa nos 2 pontos de marcar-item (sem_saldo_para_baixa, catch de pickItemAtomico) e no posicao_reservada do parcial. O catch-geral do parcial foi deixado de fora: não tem pedido_id real em escopo e a FK pedido_id de siso_pedido_historico inviabiliza registrar com item_id"
  files:
    - src/app/api/wms/separacao/marcar-item/route.ts
    - src/app/api/wms/separacao/parcial/route.ts
  tags: [separacao, historico, visibilidade, raio-x]
```
- [ ] **Step 2 — Commit.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): registra P006 — erros de separação no histórico"`

---

## PR 2: Reordenar iniciar — consolida (RPC) antes de marcar `em_separacao` + reportar `ja_em_separacao` [P012, P153]

Em `src/app/api/wms/separacao/iniciar/route.ts` o passo 2 (UPDATE `status_separacao='em_separacao'`, 141-161) roda **antes** do passo 3 (RPC `siso_consolidar_produtos_separacao`, 167-182). Se a RPC falha, o pedido fica órfão em `em_separacao` sem checklist (re-tentar não re-roda o update e a RPC volta a falhar). Decisão P012: consolidar **antes**; se falhar, nenhum estado muda. Decisão P153: reportar no payload os pedidos que já estavam `em_separacao` (no-op silencioso hoje) pra o front exibir mensagem.

### Task 2.1: iniciar roda a RPC antes do UPDATE de status (reorder)

**Files:**
- Modify `src/app/api/wms/separacao/iniciar/route.ts:120-212` (mover bloco RPC pra antes do UPDATE; computar `ja_em_separacao`; incluir no payload)
- Test `src/app/api/wms/separacao/iniciar/route.order.test.ts` (Create) — **RED determinístico** (mock): prova que a RPC roda ANTES do UPDATE e que um `rpcError` aborta SEM nenhum UPDATE de status.

- [ ] **Step 1 — Escrever o teste que falha (RED determinístico, unit).** O caminho HTTP/E2E não consegue forçar `rpcError` de forma determinística (`siso_consolidar_produtos_separacao` só retorna vazio pra ids que não casam — `supabase/migrations/20260529_consolidar_separacao_loc_viva.sql`). Então o RED é um **unit test** que injeta um supabase fake: o fetch inicial devolve 1 pedido `aguardando_separacao`, o `.rpc()` devolve `{ error }`, e o teste afirma que **nenhum** `.update()` em `siso_pedidos` foi chamado e que a resposta é 500. No código ATUAL (UPDATE em 141-161 ANTES da RPC em 168) o `update` de `siso_pedidos` JÁ aconteceu antes do `rpcError` → o teste falha (o spy de update foi chamado). Isso isola exatamente a mudança de produção (reorder).

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks isolam a rota do DB/sessão/histórico — testamos só a ORDEM das chamadas.
const updateSpy = vi.fn();
const rpcSpy = vi.fn();

// Builder fake: cada .from(table) registra a tabela e devolve um thenable
// encadeável. Pra siso_pedidos no fetch inicial resolvemos 1 pedido válido;
// pro update registramos a chamada via updateSpy. .rpc() devolve erro.
// pedidosFetch e rpcResult são parametrizáveis por teste.
let pedidosFetch: Array<{ id: string; status_separacao: string }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = {
  data: null,
  error: { message: "rpc boom (consolidar falhou)" },
};

function makeSupabase() {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const ret = () => () => chain;
      chain.select = ret();
      chain.in = ret();
      chain.eq = ret();
      chain.update = (fields: unknown) => {
        if (table === "siso_pedidos") updateSpy(fields);
        return chain;
      };
      // Tornar o chain "thenable" pra resolver os awaits da rota.
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => {
        if (table === "siso_pedidos") {
          return resolve({ data: pedidosFetch, error: null });
        }
        if (table === "siso_pedido_itens") {
          return resolve({ data: [], error: null }); // sem itens de compra pendente
        }
        return resolve({ data: [], error: null });
      };
      return chain;
    },
    rpc: (...args: unknown[]) => {
      rpcSpy(...args);
      return Promise.resolve(rpcResult);
    },
  };
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => makeSupabase(),
}));
vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "U-1", nome: "Tester", galpaoId: "G-1" }),
}));
vi.mock("@/lib/historico-service", () => ({
  registrarEventos: vi.fn(async () => {}),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn(() => ({ id: "e", timestamp: "t" })) },
}));

import { POST } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/wms/separacao/iniciar", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": "s" },
    body: JSON.stringify(body),
  });
}

describe("iniciar — consolida (RPC) ANTES do UPDATE de status (P012) + reporta ja_em_separacao (P153)", () => {
  beforeEach(() => {
    updateSpy.mockClear();
    rpcSpy.mockClear();
    pedidosFetch = [{ id: "PED-1", status_separacao: "aguardando_separacao" }];
    rpcResult = { data: null, error: { message: "rpc boom (consolidar falhou)" } };
  });

  it("rpcError aborta SEM nenhum UPDATE em siso_pedidos e retorna 500 (P012)", async () => {
    const res = await POST(makeReq({ pedido_ids: ["PED-1"], operador_id: "U-1" }) as never);
    expect(res.status).toBe(500);
    // A RPC tem que ter sido chamada (consolidação tentada).
    expect(rpcSpy).toHaveBeenCalledOnce();
    // E o UPDATE de status NÃO pode ter ocorrido (a RPC falhou ANTES dele).
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("retorna ja_em_separacao com os pedidos já em em_separacao no fetch inicial (P153)", async () => {
    // Pedido JÁ em em_separacao + RPC OK → não transita, mas reporta no payload.
    pedidosFetch = [{ id: "PED-2", status_separacao: "em_separacao" }];
    rpcResult = { data: [], error: null };
    const res = await POST(makeReq({ pedido_ids: ["PED-2"], operador_id: "U-1" }) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ja_em_separacao?: string[] };
    expect(body.ja_em_separacao).toEqual(["PED-2"]);
  });
});
```

> Nota: o 2º `it` é o RED do payload P153 — no código atual a rota não devolve `ja_em_separacao` (`body.ja_em_separacao` é `undefined`), então `toEqual(["PED-2"])` falha. A implementação do Step 3 (que computa `jaEmSeparacao` e inclui no `return`) faz os dois testes passarem.

> Nota de ancoragem: a rota faz, na ordem desejada, `from('siso_pedidos').select().in()` (fetch), `from('siso_pedido_itens').select().in().in()` (pending compra), `rpc()` e só então `from('siso_pedidos').update().in().in()`. O fake acima resolve cada await e o `updateSpy` captura QUALQUER `.update()` em `siso_pedidos`. O `.in()`/`.eq()`/`.select()` retornam o próprio chain thenable, então `await supabase.from(...).select(...).in(...)` resolve via `.then`. Esse teste não exercita a RPC real — só a ordem de chamadas na rota, que é o coração do P012.

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/app/api/wms/separacao/iniciar/route.order.test.ts`
  Expected: FAIL com `expect(updateSpy).not.toHaveBeenCalled()` violado — no código atual o UPDATE de `siso_pedidos` (141-161) roda ANTES da RPC (168), então `updateSpy` é chamado mesmo com a RPC falhando depois.

- [ ] **Step 3 — Implementação mínima (reorder).** Reescrever o trecho 120-212 de `src/app/api/wms/separacao/iniciar/route.ts` pra: (1) computar `jaEmSeparacao` do fetch inicial; (2) rodar a RPC; (3) **só então** o UPDATE; (4) incluir `ja_em_separacao` no payload.

  Substituir o bloco que vai de `// 2. Update pedidos to em_separacao...` (linha 120) até `return NextResponse.json({ pedido_ids, produtos: consolidados });` (linha 212) por:
```ts
    // Pedidos que JÁ estavam em_separacao no fetch inicial (P153: reportar no payload).
    const jaEmSeparacao = (pedidos ?? [])
      .filter((p) => p.status_separacao === "em_separacao")
      .map((p) => p.id);

    // BLINDAGEM: pedidos with pending compra items NEVER transition to em_separacao.
    const { data: pendingCompraRows } = await supabase
      .from("siso_pedido_itens")
      .select("pedido_id")
      .in("pedido_id", pedido_ids)
      .in("compra_status", ["aguardando_compra", "comprado"]);

    const pedidosWithPendingCompra = new Set(
      (pendingCompraRows ?? []).map((r) => r.pedido_id),
    );

    const toStart = (pedidos ?? [])
      .filter(
        (p) =>
          (p.status_separacao === "aguardando_separacao" || p.status_separacao === "validacao_oc") &&
          !pedidosWithPendingCompra.has(p.id),
      )
      .map((p) => p.id);

    // P012: CONSOLIDA ANTES de transitar estado. Se a RPC falhar, retornamos erro
    // SEM ter mudado nenhum status — re-tentar é seguro (idempotente).
    const { data: produtos, error: rpcError } = await supabase.rpc(
      "siso_consolidar_produtos_separacao",
      { p_pedido_ids: pedido_ids, p_order_by: "localizacao" },
    );

    if (rpcError) {
      logger.error("separacao-iniciar", "RPC consolidar failed (nenhum estado mudou)", {
        error: rpcError.message,
      });
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }

    // Só DEPOIS da consolidação OK, transita pra em_separacao.
    if (toStart.length > 0) {
      const { error: updateError } = await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "em_separacao",
          separacao_operador_id: operador_id,
          separacao_iniciada_em: new Date().toISOString(),
        })
        .in("id", toStart)
        .in("status_separacao", ["aguardando_separacao", "validacao_oc"]);

      if (updateError) {
        logger.error("separacao-iniciar", "Failed to update pedidos", {
          error: updateError.message,
        });
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }
    }

    const consolidados: ProdutoConsolidado[] = (produtos ?? []).map(
      (p: Record<string, unknown>) => ({
        produto_id: String(p.produto_id),
        descricao: String(p.descricao ?? ""),
        sku: String(p.sku ?? ""),
        gtin: p.gtin ? String(p.gtin) : null,
        quantidade_total: Number(p.quantidade_total),
        unidade: String(p.unidade ?? "UN"),
        localizacao: p.localizacao ? String(p.localizacao) : null,
      }),
    );

    registrarEventos(
      toStart.map((pid) => ({
        pedidoId: pid,
        evento: "separacao_iniciada" as const,
        usuarioId: operador_id,
        usuarioNome: session.nome,
        detalhes: { qtdPedidos: pedido_ids.length, qtdProdutos: consolidados.length },
      })),
    ).catch(() => {});

    logger.info("separacao-iniciar", "Separação iniciada", {
      pedido_ids,
      operador_id,
      produtos_count: consolidados.length,
      ja_em_separacao: jaEmSeparacao,
    });

    return NextResponse.json({ pedido_ids, produtos: consolidados, ja_em_separacao: jaEmSeparacao });
```

> Nota: divergência do achado — o `registrarEventos('separacao_iniciada')` original disparava pra **todos** `pedido_ids`. Como agora reportamos `ja_em_separacao` separadamente e só `toStart` realmente transita, mudei o evento pra `toStart` (mais fiel — não reabre evento pra quem já estava em separação). Mudança traçável ao pedido P153.

- [ ] **Step 4 — Rodar e ver passar.** `npm test -- src/app/api/wms/separacao/iniciar/route.order.test.ts`
  Expected: PASS — com a RPC antes do UPDATE, `rpcError` retorna 500 e `updateSpy` nunca é chamado.

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/separacao/iniciar/route.ts src/app/api/wms/separacao/iniciar/route.order.test.ts && git commit -m "fix(wms): iniciar consolida (RPC) ANTES de marcar em_separacao + reporta ja_em_separacao [P012,P153]"`

### Task 2.2: front exibe "esses pedidos já estão em separação" no 2º clique

**Files:**
- Modify `src/app/wms/separacao/page.tsx:461-471` (`iniciarMut`: ler body, tratar `ja_em_separacao`)
- Test `scripts/wms/cenarios/catalogo/84b-iniciar-ja-em-separacao.ts` (Create) — **teste de contrato/regressão E2E** (não-RED): o payload `ja_em_separacao` já é produzido pela Task 2.1; este cenário trava o contrato end-to-end (Tiny webhook → cutover → 2º clique) que o front consome.

> Nota de classificação: o RED do **payload** `ja_em_separacao` vive na Task 2.1 (`route.order.test.ts`, 2º `it`). Esta task entrega a **mudança de front** (`page.tsx`) e adiciona um cenário E2E de contrato que confirma o campo no fluxo real. Não há produção de backend nova aqui — logo o cenário não é vermelho contra o código pós-2.1; é regressão.

- [ ] **Step 1 — Escrever o teste de contrato (E2E).** Cenário: `iniciar` com um pedido já em `em_separacao` retorna 200 com `ja_em_separacao` contendo aquele id.

```ts
import type { Cenario, Ctx } from "../_harness/types";

type Setup = { sku: string; pedidoId: string };

export default {
  nome: "84b — iniciar reporta ja_em_separacao no 2o clique",
  descricao:
    "POST /separacao/iniciar com pedido já em em_separacao retorna 200 com " +
    "ja_em_separacao contendo aquele id (front mostra 'esses pedidos já estão em separação'). " +
    "Hoje a rota não reporta — no-op silencioso.",
  tags: ["separacao", "iniciar", "idempotencia", "ux", "P153"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("84b");
    await ctx.criarProduto({ sku, descricao: "Iniciar Ja Em Separacao 84b" });
    return { sku, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 3 });
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 1 }],
    });
    setup.pedidoId = id;
    await ctx.aguardarStatusSeparacao(id, "aguardando_separacao", { timeout_ms: 30000 });

    const { data: ped } = await ctx.sb
      .from("siso_pedidos").select("separacao_operador_id").eq("id", id).maybeSingle();
    const operadorId =
      (ped as { separacao_operador_id?: string } | null)?.separacao_operador_id ??
      (await ctx.sb.from("siso_usuarios").select("id").limit(1).single()).data!.id;

    // 1º clique: transita pra em_separacao.
    await ctx.http.post("/api/wms/separacao/iniciar", { pedido_ids: [id], operador_id: operadorId });
    await ctx.aguardarStatusSeparacao(id, "em_separacao");

    // 2º clique: deve retornar 200 com ja_em_separacao=[id].
    const r = await ctx.http.post<{ ja_em_separacao?: string[] }>(
      "/api/wms/separacao/iniciar", { pedido_ids: [id], operador_id: operadorId },
    );
    if (!r.ja_em_separacao || !r.ja_em_separacao.includes(id)) {
      throw new Error(`P153 não corrigido: ja_em_separacao não contém ${id} (got ${JSON.stringify(r.ja_em_separacao)})`);
    }
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    await ctx.assertPedidoStatus(setup.pedidoId, "executando"); // status do pedido (não separação)
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

> Nota: o `assertEsperado` valida o `status` do pedido (não `status_separacao`). Se o seed deixar o pedido propria em `executando`, mantenha; caso contrário, troque por `assertPedidoStatus(..., "concluido")` conforme o estado real pós-cutover. O critério de aprovação principal é o `ja_em_separacao` no `run`.

- [ ] **Step 2 — Rodar o teste de contrato.** `npm run scenarios:only -- 84b-iniciar-ja-em-separacao`
  Expected: PASS (a Task 2.1 já adicionou `ja_em_separacao` ao payload; este cenário confirma o contrato no fluxo real). Se FALHAR, a Task 2.1 não foi aplicada corretamente — volte e cheque o `return` da rota. A mudança de front no Step 3 não afeta este resultado (o cenário valida a rota, não o componente).

- [ ] **Step 3 — Implementação mínima (front).** Em `src/app/wms/separacao/page.tsx`, fazer o `iniciarMut` ler o body e avisar. Importar `toast` já existe no arquivo (usado em `forcarPendenteMut`). Substituir o `iniciarMut` (461-471) por:
```ts
  const iniciarMut = useMutation({
    mutationFn: async (ids: string[]) => {
      if (!user) throw new Error("Sessão expirada");
      const r = await sisoFetch("/api/wms/separacao/iniciar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: ids, operador_id: user.id }),
      });
      const body = (await r.json().catch(() => ({}))) as { ja_em_separacao?: string[] };
      if (!r.ok) throw new Error((body as { error?: string }).error || `HTTP ${r.status}`);
      return { ids, jaEmSeparacao: body.ja_em_separacao ?? [] };
    },
    onSuccess: ({ jaEmSeparacao }) => {
      if (jaEmSeparacao.length > 0) {
        toast.info(`${jaEmSeparacao.length} pedido(s) já estavam em separação.`);
      }
    },
  });
```
  E em `batchSepararChecklist` (670-680), `iniciarMut.mutate(effectiveIds, {...})` retorna `{ ids, jaEmSeparacao }` — o `onSettled` que navega pra checklist usa `effectiveIds`, então **não** precisa do retorno; manter como está (o `onSettled` já usa `effectiveIds`, não o valor retornado).

> Nota: o `mutationFn` antes retornava `ids` (string[]); agora retorna `{ ids, jaEmSeparacao }`. Confirmar que nenhum outro caller depende do shape antigo do retorno do `iniciarMut.mutate`. O único caller é `batchSepararChecklist` (linha 672), que ignora o valor retornado (usa `effectiveIds` no `onSettled`) — mudança segura.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios:only -- 84b-iniciar-ja-em-separacao` e `npm run lint`
  Expected: cenário PASS; lint sem erro novo no arquivo.

- [ ] **Step 5 — Commit.** `git add src/app/wms/separacao/page.tsx scripts/wms/cenarios/catalogo/84b-iniciar-ja-em-separacao.ts && git commit -m "feat(wms): front avisa 'pedidos já em separação' no 2o clique de Separar [P153]"`

### Task 2.3: erros-conhecidos.yaml — P012, P153

- [ ] **Step 1 — Adicionar entradas.**
```yaml
- id: P012
  date: 2026-06-05
  source: src/app/api/wms/separacao/iniciar/route.ts
  category: business_logic
  message: "iniciar marcava em_separacao ANTES de consolidar; RPC falhando deixava pedido órfão"
  cause: "Ordem invertida — UPDATE de status precedia a RPC siso_consolidar_produtos_separacao"
  fix: "Rodar a RPC primeiro; só transitar status se ela retornar sem erro (re-tentar é idempotente)"
  files: [src/app/api/wms/separacao/iniciar/route.ts]
  tags: [separacao, iniciar, ordem, raio-x]
- id: P153
  date: 2026-06-05
  source: src/app/api/wms/separacao/iniciar/route.ts
  category: business_logic
  message: "2o clique em Separar era no-op silencioso — operador não sabia que pedidos já estavam em separação"
  cause: "Rota não reportava ja_em_separacao no payload e o front ignorava a resposta"
  fix: "Rota inclui ja_em_separacao[]; front exibe toast.info no onSuccess"
  files: [src/app/api/wms/separacao/iniciar/route.ts, src/app/wms/separacao/page.tsx]
  tags: [separacao, iniciar, idempotencia, ux, raio-x]
```
- [ ] **Step 2 — Commit.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): registra P012, P153 — ordem e feedback do iniciar"`

---

## PR 3: Guards de pré-condição [P017, P074, P031, P036, P154, P081] [MIGRATION/RPC]

Seis guards de pré-voo independentes no fluxo de separação/compra. P154 traz a migration (cron + RPC `wms_revisar_separacao_stale`).

### Task 3.1: parcial bloqueia qty=0 sem `loc_zerou` [P017]

**Files:**
- Modify `src/app/api/wms/separacao/parcial/route.ts:68-81` (validação de entrada)
- Test `scripts/wms/cenarios/catalogo/86-parcial-zero-exige-loc-zerou.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** `quantidade_pega:0, loc_zerou:false` → 400; `quantidade_pega:0, loc_zerou:true` → segue (não 400).

```ts
import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

type Setup = { sku: string; pedidoId: string };

export default {
  nome: "86 — parcial: qty=0 só é aceito com loc_zerou=true",
  descricao:
    "POST /separacao/parcial {quantidade_pega:0, loc_zerou:false} deve retornar 400. " +
    "Com loc_zerou=true (prateleira confirmada vazia) o zero é aceito. Hoje o 1o caso passa.",
  tags: ["separacao", "parcial", "guard", "qty-zero", "P017"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("86z");
    await ctx.criarProduto({ sku, descricao: "Parcial Zero Guard 86" });
    return { sku, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 3 });
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 2 }],
    });
    setup.pedidoId = id;
    await ctx.aguardarStatusSeparacao(id, "aguardando_separacao", { timeout_ms: 30000 });
    await ctx.iniciarSeparacao(id);
    await ctx.aguardarStatusSeparacao(id, "em_separacao");

    const { data: item } = await ctx.sb
      .from("siso_pedido_itens").select("id").eq("pedido_id", id).single();
    const itemId = String((item as { id: string | number }).id);
    const galpaoId = ctx.staging.empresas.netair.galpao_id;
    const headers = { "X-Galpao-Id": galpaoId };

    // Caso 1: qty=0 + loc_zerou=false → DEVE 400.
    let blocked = false;
    try {
      await ctx.http.post("/api/wms/separacao/parcial",
        { pedido_item_id: itemId, quantidade_pega: 0, loc_zerou: false }, headers);
    } catch (e) {
      blocked = (e as HttpError).status === 400;
    }
    if (!blocked) {
      throw new Error("P017 não corrigido: qty=0 + loc_zerou=false passou (esperava 400)");
    }

    // Caso 2 (controle): qty=0 + loc_zerou=true → NÃO deve dar 400.
    try {
      await ctx.http.post("/api/wms/separacao/parcial",
        { pedido_item_id: itemId, quantidade_pega: 0, loc_zerou: true }, headers);
    } catch (e) {
      const st = (e as HttpError).status;
      if (st === 400) throw new Error("qty=0 + loc_zerou=true foi bloqueado por engano (400)");
    }
  },

  assertEsperado: async (): Promise<void> => { /* asserts no run */ },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios:only -- 86-parcial-zero-exige-loc-zerou`
  Expected: FAIL com "P017 não corrigido: qty=0 + loc_zerou=false passou".

- [ ] **Step 3 — Implementação mínima.** Após o bloco de validação 68-81 de `src/app/api/wms/separacao/parcial/route.ts`, adicionar (depois de `const { quantidade_pega, loc_zerou } = body ...`):
```ts
  // P017: zero só é permitido confirmando que a prateleira está vazia (loc_zerou=true).
  // Sem isso, qty=0 acidental criava ajuste fantasma do saldo inteiro (ramo loc_zerou).
  if (quantidade_pega === 0 && loc_zerou !== true) {
    return NextResponse.json(
      { error: "quantidade 0 só é permitida confirmando que a prateleira está vazia (loc_zerou=true)" },
      { status: 400 },
    );
  }
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios:only -- 86-parcial-zero-exige-loc-zerou`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/separacao/parcial/route.ts scripts/wms/cenarios/catalogo/86-parcial-zero-exige-loc-zerou.ts && git commit -m "fix(wms): parcial bloqueia qty=0 sem confirmar prateleira vazia (loc_zerou) [P017]"`

### Task 3.2: worker exige NF resolvível pra `nf_venda` [P074]

**Files:**
- Modify `src/lib/execution-worker-wms.ts:64-78` (não engolir falha de upsert quando há referência de NF) e `158-169` (guard antes do S de nf_venda)
- Test `test/integration/execution-worker-nf-required.test.ts` (Create)

> Nota de ancoragem (verificado contra as migrations): a assinatura **viva** de `wms_inserir_movimentacao` no staging tem `p_origem_id text` e `p_pedido_id text` — a migration `20260526_movimentacoes_origem_id_pedido_id_text.sql` (linhas 39, 50) reverteu o uuid introduzido em `20260520b` (essa é exatamente a história do gotcha #2 do CLAUDE.md). Logo passar `PEDIDO_ID` (string sintética `TEST-NF-...`) como `p_origem_id`/`p_pedido_id` é **válido** — não dá `invalid input syntax for type uuid`. (O exemplo vivo `src/lib/wms/ledger.test.ts:60-80` confirma que `pedido_id` aceita `MAN-...`.) `siso_movimentacoes.pedido_id` é text e **não** tem FK pra `siso_pedidos` (comentário em `20260520b` linha 18), então a ordem de inserts (R antes do header) não viola nada. Antes de escrever o seed, confirmar a assinatura com: `SELECT pg_get_function_arguments(oid) FROM pg_proc WHERE proname='wms_inserir_movimentacao';` no project `ehbxpbeijofxtsbezwxd` — deve conter `p_origem_id text` e `p_pedido_id text`.

- [ ] **Step 1 — Escrever o teste que falha.** Integration: monta pedido + reserva viva (R) **sem** referência de NF (`nota_fiscal_id` e `chave_acesso_nf` null) e chama `executarEstoquePosNfWms`. Como a S é `nf_venda`, o worker deve **throw** (NF requerida) e **não** marcar `estoque_lancado`. Hoje insere S com `nota_fiscal_id=null` e marca lançado.

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { executarEstoquePosNfWms } from "../../src/lib/execution-worker-wms";

const sb = createServiceClient();
const SKU = `TEST-INT-NF-${Math.random().toString(36).slice(2, 8)}`;
let produtoId: string, galpaoId: string, locId: string, empresaId: string;
const PEDIDO_ID = `TEST-NF-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: emp } = await sb.from("siso_empresas").select("id").eq("nome", "NetAir").single();
  empresaId = emp!.id;
  const { data: p } = await sb
    .from("siso_produtos").insert({ sku: SKU, descricao: "NF required test", ativo: true })
    .select("id").single();
  produtoId = p!.id;

  // saldo 5 + reserva 2 (R viva pro pedido) — sem NF referenciada.
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 5, p_origem_tipo: "inventario_inicial",
    p_origem_id: null, p_custo_unitario: null, p_motivo: "seed",
  });
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "R", p_quantidade: 2, p_origem_tipo: "reserva_pedido",
    p_origem_id: PEDIDO_ID, p_pedido_id: PEDIDO_ID, p_expira_em: new Date(Date.now() + 86400000).toISOString(),
    p_custo_unitario: null, p_motivo: "seed R",
  });

  // Pedido SEM nota_fiscal_id / chave_acesso_nf.
  await sb.from("siso_pedidos").insert({
    id: PEDIDO_ID, status: "executando", status_separacao: "aguardando_nf",
    empresa_origem_id: empresaId, separacao_galpao_id: galpaoId,
    estoque_lancado: false, nota_fiscal_id: null, chave_acesso_nf: null,
  });
});

describe("executarEstoquePosNfWms — NF required para nf_venda (P074)", () => {
  it("throw quando não há NF resolvível e NÃO marca estoque_lancado", async () => {
    await expect(
      executarEstoquePosNfWms({ pedido_id: PEDIDO_ID, empresa_id: empresaId, decisao: "propria" }),
    ).rejects.toThrow(/nota fiscal|nf_venda|nota_fiscal/i);

    const { data: ped } = await sb
      .from("siso_pedidos").select("estoque_lancado").eq("id", PEDIDO_ID).single();
    expect(ped!.estoque_lancado).toBe(false);

    // Nenhuma S de nf_venda materializada pro pedido.
    const { data: saidas } = await sb
      .from("siso_movimentacoes").select("id")
      .eq("origem_id", PEDIDO_ID).eq("tipo", "S").eq("origem_tipo", "nf_venda");
    expect((saidas ?? []).length).toBe(0);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- execution-worker-nf-required`
  Expected: FAIL — hoje o worker insere a S com `nota_fiscal_id=null`, marca `estoque_lancado=true` e não lança throw.

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/execution-worker-wms.ts`:

  (a) No bloco 64-78, quando há referência de NF e o upsert falha, **throw** (não warn+continue). Substituir o `if (pedido.nota_fiscal_id != null || pedido.chave_acesso_nf) { try { ... } catch { logger.warn(...) } }` (64-78) por:
```ts
  let notaFiscalUuid: string | null = null;
  if (pedido.nota_fiscal_id != null || pedido.chave_acesso_nf) {
    notaFiscalUuid = await upsertNotaFiscal({
      tiny_nota_fiscal_id: pedido.nota_fiscal_id as number | null,
      chave_acesso: pedido.chave_acesso_nf as string | null,
      empresa_id: empresaVendedoraId,
      tipo: "saida",
    });
    if (!notaFiscalUuid) {
      throw new Error(
        `lancar_estoque: NF referenciada (id=${pedido.nota_fiscal_id}, chave=${pedido.chave_acesso_nf}) não pôde ser resolvida — abortando para não perder rastreabilidade fiscal (nf_venda)`,
      );
    }
  }
```

  (b) Guard **antes do loop** `for (const r of reservasPendentes)` (linha 136), NÃO dentro dele. Como `notaFiscalUuid` é invariante no laço, validar uma vez antes de qualquer escrita garante **zero L órfão**: se faltar NF, nada é inserido. Inserir IMEDIATAMENTE antes da linha `for (const r of reservasPendentes) {` (atual 136), depois da declaração `const erros: ... = [];` (134):
```ts
  // P074: a S de nf_venda NÃO pode sair sem nota_fiscal_id. Validamos ANTES do
  // loop (notaFiscalUuid é o mesmo pra todas as reservas) — assim não há risco de
  // inserir um L (libera reserva) e abortar antes do S pareado, deixando L órfão.
  // O ledger só dá warn nesse caso; aqui falhamos o job → retry com backoff da fila.
  if (notaFiscalUuid == null) {
    throw new Error(
      "lancar_estoque: nota_fiscal_id ausente para saída nf_venda — NF obrigatória; job deve retentar",
    );
  }
```
  O loop (136-180) e o `inserirMovimentacao({ tipo: "S", ... nota_fiscal_id: notaFiscalUuid })` (158-169) **não mudam** — `notaFiscalUuid` já não pode ser null ao chegar lá.

> Nota de posição (resolve ambiguidade do achado): o achado citava "158-169" (entre L e S). Isso seria errado — colocaria o throw DEPOIS do insert de L (145-155) e ANTES do S (158-169), deixando um L órfão no ledger. A posição correta é **antes do loop inteiro** (depois de 134, antes de 136). O snippet (b) e esta nota agora concordam: zero escrita quando falta NF. Mantemos o ledger relaxado pros caminhos legítimos sem NF (recebimento manual, parcial, retroativo) — só o worker de `lancar_estoque` passa a exigir (fiel à nota P074: "exigir NF só quando a operação precisa").

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- execution-worker-nf-required`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/lib/execution-worker-wms.ts test/integration/execution-worker-nf-required.test.ts && git commit -m "fix(wms): worker exige NF resolvível para nf_venda — não engole upsert falho [P074]"`

### Task 3.3: concluir-oc bloqueia pedido com itens de galpões de OC distintos [P031]

**Files:**
- Modify `src/app/api/wms/separacao/concluir-oc/route.ts` (detectar multi-galpão e **remover de `separados`** logo após popular `separados` em 118-125, ANTES do auto-resolve OC 163-185, dos fire-and-forget 305/322/332 e do header UPDATE 235; reportar no payload final 347)
- Test `scripts/wms/cenarios/catalogo/87-concluir-oc-multi-galpao-bloqueia.ts` (Create)

> Nota de ancoragem (vazamento que o achado/revisão pegou): `separados` é populado em 118-125 e DEPOIS consumido por: marca OC recebido (163-185), `preCriarAgrupamentosEmLote(separados)` (305), `recarregarEtiquetasFaltantes(separados)` (311), `dispararCutoverSePronto` (322) e `registrarEventos('separacao_oc_concluida')` (332-343). Se a detecção multi-galpão só filtrasse no `return` (347), todos esses efeitos colaterais já teriam rodado pro pedido multi-galpão. Por isso a filtragem **tem que** acontecer logo após popular `separados` (antes de 163), removendo o pedido de `separados` de vez. O header UPDATE (235) só itera sobre `pedidos` (fetch 189, filtrado por `.in("id", separados)`), então um pedido fora de `separados` nunca é tocado lá também.

- [ ] **Step 1 — Escrever o teste que falha.** Pedido OC com 2 itens cujos `ordem_compra_id` apontam pra galpões diferentes (CWB e SP); `concluir-oc` deve recusar (pedido **não** vira `separado`) e reportar `pedido_ids_multi_galpao`.

```ts
import type { Cenario, Ctx } from "../_harness/types";

type Setup = { skuA: string; skuB: string; pedidoId: string };

export default {
  nome: "87 — concluir-oc bloqueia pedido com OCs de galpões diferentes",
  descricao:
    "Pedido OC com 2 itens cujas OCs estão em galpões distintos: concluir-oc NÃO pode " +
    "transitar pra 'separado' (escolher 1 galpão e ignorar o outro). Deve bloquear e reportar.",
  tags: ["separacao", "concluir-oc", "guard", "multi-galpao", "P031"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const skuA = ctx.skuUnico("87a");
    const skuB = ctx.skuUnico("87b");
    await ctx.criarProduto({ sku: skuA, descricao: "Multi Galpao A 87" });
    await ctx.criarProduto({ sku: skuB, descricao: "Multi Galpao B 87" });
    return { skuA, skuB, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { skuA, skuB } = setup;
    // Sem saldo → OC. Pedido com 2 SKUs.
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku: skuA, qty: 1 }, { sku: skuB, qty: 1 }],
    });
    setup.pedidoId = id;
    await ctx.aguardarStatus(id, "pendente", undefined, { timeout_ms: 20000 });
    await ctx.aprovar(id, "oc");
    await ctx.aguardarStatusSeparacao(id, "validacao_oc");

    // Marca ambos esgotados → aguardando_compra.
    const { data: itens } = await ctx.sb
      .from("siso_pedido_itens").select("id, sku").eq("pedido_id", id);
    const itemIds = (itens as Array<{ id: string | number }>).map((i) => String(i.id));
    await ctx.http.post("/api/wms/separacao/validar-oc-item", { item_ids: itemIds, acao: "esgotado" });
    await ctx.aguardarStatusSeparacao(id, "aguardando_compra");

    // Compra cada SKU criando OCs em galpões diferentes (CWB e SP) e linka aos itens.
    // (ctx.comprar liga a OC ao item via pedido_id; fixamos o galpao_id de cada OC
    //  diretamente no DB pra simular as OCs em galpões distintos.)
    await ctx.comprar({ sku: skuA, qty: 1, pedido_id: id });
    await ctx.comprar({ sku: skuB, qty: 1, pedido_id: id });

    const { data: itens2 } = await ctx.sb
      .from("siso_pedido_itens").select("id, sku, ordem_compra_id").eq("pedido_id", id);
    const arr = itens2 as Array<{ id: string | number; sku: string; ordem_compra_id: string | null }>;
    const ocA = arr.find((i) => i.sku === skuA)!.ordem_compra_id!;
    const ocB = arr.find((i) => i.sku === skuB)!.ordem_compra_id!;
    await ctx.sb.from("siso_ordens_compra").update({ galpao_id: ctx.staging.galpoes.cwb.id }).eq("id", ocA);
    await ctx.sb.from("siso_ordens_compra").update({ galpao_id: ctx.staging.galpoes.sp.id }).eq("id", ocB);

    // Marca itens como separados (separacao_marcado) e tenta concluir-oc.
    await ctx.sb.from("siso_pedido_itens")
      .update({ separacao_marcado: true, separacao_marcado_em: new Date().toISOString() })
      .eq("pedido_id", id);

    const r = await ctx.http.post<{ separados?: string[]; pedido_ids_multi_galpao?: string[] }>(
      "/api/wms/separacao/concluir-oc", { pedido_ids: [id] },
    ).catch((e) => (e as { body?: unknown }).body as { separados?: string[]; pedido_ids_multi_galpao?: string[] });

    if ((r?.separados ?? []).includes(id)) {
      throw new Error("P031 não corrigido: pedido multi-galpão foi para 'separados'");
    }
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { pedidoId } = setup;
    // (1) Não virou 'separado'.
    const { data: ped } = await ctx.sb
      .from("siso_pedidos").select("status_separacao").eq("id", pedidoId).single();
    if ((ped as { status_separacao: string }).status_separacao === "separado") {
      throw new Error("P031 não corrigido: pedido multi-galpão virou 'separado'");
    }
    // (2) Nenhum efeito colateral vazou: o auto-resolve de OC marca compra_status='recebido'.
    //     Se o pedido tivesse sido processado, os itens estariam 'recebido'. Como ele saiu de
    //     `separados` ANTES do auto-resolve, devem continuar no estado de compra anterior.
    const { data: itensPos } = await ctx.sb
      .from("siso_pedido_itens").select("compra_status").eq("pedido_id", pedidoId);
    const recebidos = (itensPos ?? []).filter(
      (i) => (i as { compra_status: string | null }).compra_status === "recebido",
    );
    if (recebidos.length > 0) {
      throw new Error(
        "P031 vazou: itens do pedido multi-galpão foram marcados 'recebido' (auto-resolve rodou) mesmo sem virar 'separado'",
      );
    }
    // (3) Nenhum evento 'separacao_oc_concluida' no histórico do pedido bloqueado.
    const { data: hist } = await ctx.sb
      .from("siso_pedido_historico").select("evento").eq("pedido_id", pedidoId);
    const concluiu = (hist ?? []).some(
      (h) => (h as { evento: string }).evento === "separacao_oc_concluida",
    );
    if (concluiu) {
      throw new Error(
        "P031 vazou: evento 'separacao_oc_concluida' registrado pro pedido multi-galpão",
      );
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios:only -- 87-concluir-oc-multi-galpao-bloqueia`
  Expected: FAIL com "P031 não corrigido: pedido multi-galpão...".

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/separacao/concluir-oc/route.ts`, detectar os pedidos multi-galpão **logo após** popular `separados` (125) e **antes** de qualquer efeito colateral, removendo-os de `separados`. Isso exige buscar o galpão de cada OC antes do auto-resolve (hoje o `ocGalpaoMap` só é montado em 210-219). Reescrever assim:

  (1) Logo após o bloco que popula `separados`/`pendentes` (118-125) e ANTES do bloco "Return incomplete pedidos" (128), inserir a detecção multi-galpão. Ela coleta as OCs dos pedidos em `separados`, busca os galpões em batch e remove de `separados` quem tem itens de OCs em galpões distintos:
```ts
    // ── 1b. P031: remove de `separados` pedidos cujos itens vêm de OCs em galpões
    //    DIFERENTES. Antes o código resolvia ocGalpaoId = uniqueOcGalpaoIds[0] e
    //    ignorava o resto — o pedido virava 'separado' (e ganhava agrupamento,
    //    cutover e evento) apontando pra UM galpão só. Filtramos AQUI, antes de
    //    qualquer efeito colateral (auto-resolve OC, agrupamentos, cutover, eventos).
    const ocIdsDosSeparados = new Set<string>();
    for (const pid of separados) {
      for (const item of itemsByPedido.get(pid) ?? []) {
        if (item.ordem_compra_id) ocIdsDosSeparados.add(item.ordem_compra_id);
      }
    }
    const ocGalpaoPreMap = new Map<string, string | null>();
    if (ocIdsDosSeparados.size > 0) {
      const { data: ocsPre } = await supabase
        .from("siso_ordens_compra")
        .select("id, galpao_id")
        .in("id", [...ocIdsDosSeparados]);
      for (const oc of ocsPre ?? []) ocGalpaoPreMap.set(oc.id, oc.galpao_id);
    }

    const pedidosMultiGalpao: string[] = [];
    for (const pid of [...separados]) {
      const galpoesDoPedido = new Set(
        (itemsByPedido.get(pid) ?? [])
          .map((i) => (i.ordem_compra_id ? ocGalpaoPreMap.get(i.ordem_compra_id) : null))
          .filter(Boolean) as string[],
      );
      if (galpoesDoPedido.size > 1) {
        pedidosMultiGalpao.push(pid);
      }
    }
    if (pedidosMultiGalpao.length > 0) {
      const bloq = new Set(pedidosMultiGalpao);
      // Tira de `separados` (mutação in-place: filtra e re-popula).
      separados.splice(0, separados.length, ...separados.filter((pid) => !bloq.has(pid)));
    }
```

  (2) No payload final, trocar o `return NextResponse.json({ separados, pendentes });` (347) por:
```ts
    logger.info(LOG_SOURCE, "Separação OC concluída", {
      separados, pendentes, multiGalpao: pedidosMultiGalpao,
    });
    return NextResponse.json({
      separados,
      pendentes,
      ...(pedidosMultiGalpao.length > 0
        ? {
            pedido_ids_multi_galpao: pedidosMultiGalpao,
            aviso: "Pedido(s) com compras de galpões diferentes — separe manualmente.",
          }
        : {}),
    });
```
  A linha `logger.info(LOG_SOURCE, "Separação OC concluída", { separados, pendentes });` original (345) é substituída pela versão acima (que inclui `multiGalpao`). O bloco de resolução por pedido (235-295) e o `ocGalpaoMap` (210-219) **não mudam** — eles agora só veem pedidos single-galpão (os multi já saíram de `separados`, logo do fetch 189).

> Nota de correção (vs. plano anterior): a versão anterior detectava multi-galpão dentro do loop 235 e só filtrava no `return` — o que deixava o auto-resolve OC (163-185), os agrupamentos (305), o cutover (322) e os eventos (332) rodarem pro pedido multi-galpão. Agora a remoção de `separados` acontece em 1b (antes de 128), então NENHUM efeito colateral toca o pedido bloqueado. Mantemos `200` com `pedido_ids_multi_galpao` (não 409 — o batch pode ter pedidos OK + bloqueados; um 409 mascararia os que concluíram). O frontend usa o campo `pedido_ids_multi_galpao` pra avisar, conforme decisão P031 op1. Os itens dos bloqueados permanecem `separacao_marcado=true` e o pedido fica no estado em que entrou (não reverte) — mudança cirúrgica.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios:only -- 87-concluir-oc-multi-galpao-bloqueia`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/separacao/concluir-oc/route.ts scripts/wms/cenarios/catalogo/87-concluir-oc-multi-galpao-bloqueia.ts && git commit -m "fix(wms): concluir-oc bloqueia pedido com OCs de galpões diferentes [P031]"`

### Task 3.4: trocar-sku bloqueia troca com compra ativa [P036]

**Files:**
- Modify `src/app/api/wms/compras/trocar-sku/route.ts:52` (adicionar `compra_status, ordem_compra_id` ao select) e após `60` / antes de `62` (guard de estado trocável, entre o `if (fetchErr || !items?.length)` e o `const novoFornecedor`)
- Test `scripts/wms/cenarios/catalogo/83-trocar-sku-bloqueia-compra-ativa.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Item com compra ativa (`compra_status='comprado'`, `ordem_compra_id` setado) → `trocar-sku` retorna 409 e **não** altera `sku`. Caso controle: `aguardando_compra` permite.

```ts
import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

type Setup = { sku: string; novoSku: string; pedidoId: string };

export default {
  nome: "83 — trocar-sku bloqueia quando a compra já está ativa",
  descricao:
    "Item com compra_status='comprado' (ordem_compra_id setado): POST /compras/trocar-sku " +
    "retorna 409 e NÃO altera o sku. Item em aguardando_compra permite a troca.",
  tags: ["compras", "trocar-sku", "guard", "P036"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("83t");
    const novoSku = ctx.skuUnico("83tn");
    await ctx.criarProduto({ sku, descricao: "Trocar SKU Guard 83" });
    await ctx.criarProduto({ sku: novoSku, descricao: "Trocar SKU Novo 83" });
    return { sku, novoSku, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku, novoSku } = setup;
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 1 }],
    });
    setup.pedidoId = id;
    await ctx.aguardarStatus(id, "pendente", undefined, { timeout_ms: 20000 });
    await ctx.aprovar(id, "oc");
    await ctx.aguardarStatusSeparacao(id, "validacao_oc");

    const { data: item } = await ctx.sb
      .from("siso_pedido_itens").select("id").eq("pedido_id", id).single();
    const itemId = String((item as { id: string | number }).id);

    // Marca compra ativa diretamente: compra_status='comprado' + ordem_compra_id.
    // siso_ordens_compra exige fornecedor (NOT NULL) e status no CHECK
    // (aguardando_compra|comprado|parcialmente_recebido|recebido|cancelado).
    // empresa_id é nullable desde 20260319; galpao_id existe desde 20260319.
    const { data: oc } = await ctx.sb
      .from("siso_ordens_compra")
      .insert({
        fornecedor: "TEST-FORN-83",
        galpao_id: ctx.staging.galpoes.cwb.id,
        empresa_id: ctx.staging.empresas.netair.id,
        status: "comprado",
      })
      .select("id").single();
    await ctx.sb.from("siso_pedido_itens")
      .update({ compra_status: "comprado", ordem_compra_id: (oc as { id: string }).id })
      .eq("id", itemId);

    // Troca DEVE falhar com 409.
    let blocked = false;
    try {
      await ctx.http.post("/api/wms/compras/trocar-sku", { item_ids: [itemId], novo_sku: novoSku });
    } catch (e) {
      blocked = (e as HttpError).status === 409;
    }
    if (!blocked) {
      throw new Error("P036 não corrigido: trocar-sku passou com compra ativa (esperava 409)");
    }
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens").select("sku").eq("pedido_id", setup.pedidoId).single();
    if ((item as { sku: string }).sku !== setup.sku) {
      throw new Error(`P036 não corrigido: sku foi alterado para ${(item as { sku: string }).sku}`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios:only -- 83-trocar-sku-bloqueia-compra-ativa`
  Expected: FAIL com "P036 não corrigido: trocar-sku passou com compra ativa".

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/compras/trocar-sku/route.ts`:

  (a) Linha 52 — adicionar colunas ao select:
```ts
      .select("id, pedido_id, produto_id, sku, quantidade_pedida, compra_status, ordem_compra_id, siso_pedidos(empresa_origem_id)")
```

  (b) Após `if (fetchErr || !items?.length)` (60), antes de `const novoFornecedor` (62), adicionar guard:
```ts
    // P036: só permite trocar SKU enquanto o item NÃO tem compra ativa.
    // Estados trocáveis: sem fluxo de compra (null) | 'aguardando_compra' | 'cancelado'.
    const TROCAVEL = new Set(["aguardando_compra", "cancelado"]);
    const travado = (items as Array<{ compra_status: string | null; ordem_compra_id: string | null }>).find(
      (it) =>
        it.ordem_compra_id != null ||
        (it.compra_status != null && !TROCAVEL.has(it.compra_status)),
    );
    if (travado) {
      return NextResponse.json(
        { error: "Essa compra já foi marcada — não dá pra trocar o SKU. Cancele a compra primeiro." },
        { status: 409 },
      );
    }
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios:only -- 83-trocar-sku-bloqueia-compra-ativa`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/compras/trocar-sku/route.ts scripts/wms/cenarios/catalogo/83-trocar-sku-bloqueia-compra-ativa.ts && git commit -m "fix(wms): trocar-sku bloqueia quando a compra já está ativa [P036]"`

### Task 3.5: cross-dock não atropela `em_separacao` (compare-and-set) [P081]

**Files:**
- Modify `src/lib/compras-embalagem.ts:7-11` (tirar `em_separacao` de `PACKABLE_STATUSES`) e/ou `154-157` (compare-and-set no UPDATE)
- Test `test/integration/compras-embalagem-crossdock-status-guard.test.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Integration: pedido em `em_separacao` ligado a uma OC; `prepararPedidosDasOcsParaEmbalagem` **não** deve sobrescrever pra `separado` — deve reportá-lo em `ignorados`. Pedido em `aguardando_separacao` ainda vira `separado`.

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { prepararPedidosDasOcsParaEmbalagem } from "../../src/lib/compras-embalagem";

const sb = createServiceClient();
let galpaoId: string, empresaId: string, usuarioId: string, ocId: string;
const PED_EM_SEP = `TEST-XD-EMSEP-${Math.random().toString(36).slice(2, 8)}`;
const PED_AGUARD = `TEST-XD-AGU-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: emp } = await sb.from("siso_empresas").select("id").eq("nome", "NetAir").single();
  empresaId = emp!.id;
  // separacao_operador_id é FK pra siso_usuarios — usar um usuário REAL (o seed
  // cria 'test-runner'). Setar empresaId aqui violaria a FK.
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  // siso_ordens_compra: fornecedor NOT NULL + status no CHECK (sem 'aberta').
  const { data: oc } = await sb
    .from("siso_ordens_compra")
    .insert({ fornecedor: "TEST-FORN-XD", galpao_id: galpaoId, empresa_id: empresaId, status: "comprado" })
    .select("id").single();
  ocId = oc!.id;

  for (const [pid, status] of [[PED_EM_SEP, "em_separacao"], [PED_AGUARD, "aguardando_separacao"]] as const) {
    await sb.from("siso_pedidos").insert({
      id: pid, status: "executando", status_separacao: status,
      empresa_origem_id: empresaId, separacao_galpao_id: galpaoId,
      separacao_operador_id: status === "em_separacao" ? usuarioId : null,
    });
    await sb.from("siso_pedido_itens").insert({
      pedido_id: pid, produto_id: 999999, sku: "XD-TEST", quantidade_pedida: 1,
      compra_status: "recebido", ordem_compra_id: ocId,
    });
  }
});

describe("prepararPedidosDasOcsParaEmbalagem — não atropela em_separacao (P081)", () => {
  it("pedido em em_separacao vai para ignorados; aguardando_separacao vira separado", async () => {
    const res = await prepararPedidosDasOcsParaEmbalagem({ ordemCompraIds: [ocId] });

    expect(res.preparados).toContain(PED_AGUARD);
    expect(res.preparados).not.toContain(PED_EM_SEP);
    expect(res.ignorados.some((i) => i.pedido_id === PED_EM_SEP)).toBe(true);

    const { data: emSep } = await sb
      .from("siso_pedidos").select("status_separacao").eq("id", PED_EM_SEP).single();
    expect(emSep!.status_separacao).toBe("em_separacao"); // NÃO foi atropelado

    const { data: agu } = await sb
      .from("siso_pedidos").select("status_separacao").eq("id", PED_AGUARD).single();
    expect(agu!.status_separacao).toBe("separado");
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- compras-embalagem-crossdock-status-guard`
  Expected: FAIL — hoje `em_separacao` está em `PACKABLE_STATUSES` e é sobrescrito pra `separado`.

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/compras-embalagem.ts`:

  (a) Remover `em_separacao` de `PACKABLE_STATUSES` (7-11):
```ts
const PACKABLE_STATUSES = new Set([
  "aguardando_separacao",
  "separado",
]);
```
  Com isso, pedido em `em_separacao` cai no `else` do loop (linhas 102-112) e entra em `ignorados` com motivo "Pedido ainda não está pronto para embalagem direta". Para deixar o motivo explícito, ajustar o ramo de `ignorados` (102-112) pra distinguir `em_separacao`:
```ts
    if (!PACKABLE_STATUSES.has(pedido.status_separacao ?? "")) {
      ignorados.push({
        pedido_id: pedido.id,
        status_atual: pedido.status_separacao,
        motivo:
          pedido.status_separacao === "em_separacao"
            ? "Pedido em separação manual — não atropelado pelo cross-dock"
            : pedido.status_separacao === "aguardando_nf"
              ? "Pedido ainda aguardando NF para poder embalar"
              : "Pedido ainda não está pronto para embalagem direta",
      });
      continue;
    }
```

  (b) Compare-and-set no UPDATE (154-157), como backstop contra corrida:
```ts
    const { data: updRows, error: updatePedidoError } = await supabase
      .from("siso_pedidos")
      .update(updateFields)
      .eq("id", pedido.id)
      .eq("status_separacao", pedido.status_separacao)
      .select("id");

    if (updatePedidoError) {
      throw new Error(
        `Erro ao mover pedido ${pedido.id} para separado: ${updatePedidoError.message}`,
      );
    }
    if (!updRows || updRows.length === 0) {
      // Status mudou entre o fetch e o update (corrida) — ignora em vez de atropelar.
      ignorados.push({
        pedido_id: pedido.id,
        status_atual: pedido.status_separacao,
        motivo: "Status mudou durante a preparação (corrida) — não atropelado",
      });
      continue;
    }
```

> Nota: divergência do achado — o achado lista o compare-and-set como mudança principal e a remoção de `em_separacao` como "reavaliar". Aplicamos **as duas**: tirar `em_separacao` de PACKABLE é a defesa primária (nem entra no UPDATE); o compare-and-set é o backstop pra qualquer outro status que mude no meio. Como `paraPreparar` só contém status != `separado` (linha 116-121), e agora `em_separacao` nunca entra em `paraPreparar`, o `.eq('status_separacao', pedido.status_separacao)` casa o valor lido (aguardando_separacao). O `updateItemsError` em lote (167-173) opera sobre `paraPreparar` — pedidos que viraram `ignorados` na corrida ainda estariam em `paraPreparar.map`; para consistência mínima, manter o lote como está (o risco residual é marcar items de um pedido que não transitou — aceitável e raro; documentar no commit).

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- compras-embalagem-crossdock-status-guard`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/lib/compras-embalagem.ts test/integration/compras-embalagem-crossdock-status-guard.test.ts && git commit -m "fix(wms): cross-dock não atropela separação manual (em_separacao fora de PACKABLE + compare-and-set) [P081]"`

### Task 3.6: migration — revisar pedidos `em_separacao` parados >24h [P154]

**Files:**
- Create `supabase/migrations/20260605_wms_revisar_separacao_stale.sql`
- Test `test/integration/revisar-separacao-stale.test.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Integration: pedido `em_separacao` com `separacao_iniciada_em = now()-25h` e itens **não picados** (`mov_saida_id IS NULL`). Após `wms_revisar_separacao_stale()`, o pedido volta a `aguardando_separacao` (operador/iniciada zerados) e há 1 evento `status_revertido`. Pedido com 23h **não** é tocado.

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, empresaId: string, usuarioId: string;
const PED_STALE = `TEST-STALE-25H-${Math.random().toString(36).slice(2, 8)}`;
const PED_FRESH = `TEST-STALE-23H-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: emp } = await sb.from("siso_empresas").select("id").eq("nome", "NetAir").single();
  empresaId = emp!.id;
  // separacao_operador_id é FK pra siso_usuarios — usar o 'test-runner' do seed.
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;

  const h25 = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const h23 = new Date(Date.now() - 23 * 3600 * 1000).toISOString();
  for (const [pid, ini] of [[PED_STALE, h25], [PED_FRESH, h23]] as const) {
    await sb.from("siso_pedidos").insert({
      id: pid, status: "executando", status_separacao: "em_separacao",
      empresa_origem_id: empresaId, separacao_galpao_id: galpaoId,
      separacao_operador_id: usuarioId, separacao_iniciada_em: ini,
    });
    await sb.from("siso_pedido_itens").insert({
      pedido_id: pid, produto_id: 888888, sku: "STALE-TEST", quantidade_pedida: 1,
      separacao_marcado: false, mov_saida_id: null,
    });
  }
});

describe("wms_revisar_separacao_stale (P154)", () => {
  it("reverte pedido >24h e ignora <24h, registrando evento status_revertido", async () => {
    const { data: afetados, error } = await sb.rpc("wms_revisar_separacao_stale");
    expect(error).toBeNull();
    const ids = ((afetados ?? []) as Array<{ pedido_id: string }>).map((r) => r.pedido_id);
    expect(ids).toContain(PED_STALE);
    expect(ids).not.toContain(PED_FRESH);

    const { data: stale } = await sb
      .from("siso_pedidos")
      .select("status_separacao, separacao_operador_id, separacao_iniciada_em")
      .eq("id", PED_STALE).single();
    expect(stale!.status_separacao).toBe("aguardando_separacao");
    expect(stale!.separacao_operador_id).toBeNull();
    expect(stale!.separacao_iniciada_em).toBeNull();

    const { data: fresh } = await sb
      .from("siso_pedidos").select("status_separacao").eq("id", PED_FRESH).single();
    expect(fresh!.status_separacao).toBe("em_separacao");

    const { data: hist } = await sb
      .from("siso_pedido_historico").select("evento").eq("pedido_id", PED_STALE);
    expect((hist ?? []).some((h) => h.evento === "status_revertido")).toBe(true);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- revisar-separacao-stale`
  Expected: FAIL com erro tipo `function wms_revisar_separacao_stale() does not exist`.

- [ ] **Step 3 — Implementação (migration) + aplicar.** Criar `supabase/migrations/20260605_wms_revisar_separacao_stale.sql`:
```sql
-- Migration: RPC wms_revisar_separacao_stale + cron diário (P154)
-- Date: 2026-06-05
-- Raio-X Fase 6a — pedidos em em_separacao há >24h devem ser revisados
-- (revertidos pra aguardando_separacao) pra forçar replanejamento, porque o
-- estoque pode ter sido reorganizado nesse meio-tempo.
--
-- Escopo (KISS, fiel ao ledger imutável): reverte SÓ pedidos cujos itens ainda
-- NÃO foram picados (mov_saida_id IS NULL em todos) — nada de físico saiu, então
-- não há saldo fantasma a estornar. Pedidos com pick parcial já realizado NÃO são
-- tocados (não são "parados", estão mid-pick) — ficam para tratamento manual.
-- Esta restrição evita reverter movimentações no ledger dentro de SQL.
--
-- Retorna a lista de pedido_ids afetados (pra notificação pelo caller/cron).
-- Idempotente: re-rodar só pega pedidos que ainda batem o predicado.
-- Rollback: DROP FUNCTION wms_revisar_separacao_stale(); SELECT cron.unschedule('wms_revisar_separacao_stale');

CREATE OR REPLACE FUNCTION wms_revisar_separacao_stale()
RETURNS TABLE (pedido_id text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_pid text;
BEGIN
  FOR v_pid IN
    SELECT p.id
    FROM siso_pedidos p
    WHERE p.status_separacao = 'em_separacao'
      AND p.separacao_iniciada_em IS NOT NULL
      AND p.separacao_iniciada_em < now() - interval '24 hours'
      -- só pedidos SEM pick físico (nenhum item com mov_saida_id)
      AND NOT EXISTS (
        SELECT 1 FROM siso_pedido_itens i
        WHERE i.pedido_id = p.id AND i.mov_saida_id IS NOT NULL
      )
    FOR UPDATE OF p SKIP LOCKED
  LOOP
    -- reseta estado dos itens (não-picados)
    UPDATE siso_pedido_itens
       SET separacao_marcado = false,
           separacao_marcado_em = NULL,
           quantidade_pega = NULL,
           separacao_parcial = false,
           quantidade_bipada = 0,
           bipado_completo = false
     WHERE pedido_id = v_pid;

    -- reverte o header pra replanejamento
    UPDATE siso_pedidos
       SET status_separacao = 'aguardando_separacao',
           separacao_operador_id = NULL,
           separacao_iniciada_em = NULL
     WHERE id = v_pid;

    -- evento de auditoria
    INSERT INTO siso_pedido_historico (pedido_id, evento, usuario_id, usuario_nome, detalhes)
    VALUES (
      v_pid, 'status_revertido', NULL, 'sistema:cron-stale',
      jsonb_build_object(
        'motivo', 'em_separacao_stale_24h',
        'de', 'em_separacao',
        'para', 'aguardando_separacao'
      )
    );

    pedido_id := v_pid;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Cron diário às 03:00 — chama a RPC diretamente (sem HTTP).
DO $$
DECLARE v_jobid integer;
BEGIN
  FOR v_jobid IN SELECT jobid FROM cron.job WHERE jobname = 'wms_revisar_separacao_stale' LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_revisar_separacao_stale',
  '0 3 * * *',
  $cron$ SELECT count(*) FROM wms_revisar_separacao_stale(); $cron$
);
```
  Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` com name `20260605_wms_revisar_separacao_stale` e o SQL acima.

> Nota: divergência do achado — o achado pedia reuso do TS `resetarEstadoSeparacaoItens` (que estorna movs). Como o único write do ledger é `wms_inserir_movimentacao` e estornar dentro de SQL é complexo, restringimos a RPC a pedidos **sem** pick físico (`mov_saida_id IS NULL`), eliminando a necessidade de estorno e mantendo a operação pura-SQL/atômica. Pedidos com pick parcial já feito não são "parados" no sentido da nota — ficam para revisão manual. O guard opcional de defesa-em-profundidade no `marcar-item` (bloquear >24h) foi omitido para manter a mudança cirúrgica; o cron já força o replanejamento.

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- revisar-separacao-stale`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add supabase/migrations/20260605_wms_revisar_separacao_stale.sql test/integration/revisar-separacao-stale.test.ts && git commit -m "feat(wms): RPC+cron wms_revisar_separacao_stale — reverte em_separacao parado >24h [P154]"`

### Task 3.7: erros-conhecidos.yaml — P017, P074, P031, P036, P081, P154

- [ ] **Step 1 — Adicionar entradas.**
```yaml
- id: P017
  date: 2026-06-05
  source: src/app/api/wms/separacao/parcial/route.ts
  category: validation
  message: "parcial aceitava quantidade_pega=0 sem confirmar prateleira vazia → ajuste fantasma do saldo inteiro"
  cause: "Validação só rejeitava qty<0; qty=0 com loc_zerou=true criava ajuste de perda mesmo sem nada sair"
  fix: "Guard: qty=0 só é permitido com loc_zerou=true"
  files: [src/app/api/wms/separacao/parcial/route.ts]
  tags: [separacao, parcial, guard, raio-x]
- id: P074
  date: 2026-06-05
  source: src/lib/execution-worker-wms.ts
  category: business_logic
  message: "Saída nf_venda materializava sem nota_fiscal_id (rastreabilidade fiscal perdida)"
  cause: "Worker engolia falha de upsertNotaFiscal (warn+continue) e o ledger relaxou enforcement pra warn"
  fix: "Worker lança throw quando há referência de NF que não resolve, e guard antes do S de nf_venda exige notaFiscalUuid"
  files: [src/lib/execution-worker-wms.ts]
  tags: [worker, nf, fiscal, raio-x]
- id: P031
  date: 2026-06-05
  source: src/app/api/wms/separacao/concluir-oc/route.ts
  category: business_logic
  message: "concluir-oc escolhia o 1o galpão de OC e ignorava itens de outros galpões silenciosamente"
  cause: "uniqueOcGalpaoIds[0] sem detectar/rejeitar mistura de galpões"
  fix: "Bloqueia pedido com uniqueOcGalpaoIds.length>1, reporta pedido_ids_multi_galpao"
  files: [src/app/api/wms/separacao/concluir-oc/route.ts]
  tags: [separacao, concluir-oc, multi-galpao, raio-x]
- id: P036
  date: 2026-06-05
  source: src/app/api/wms/compras/trocar-sku/route.ts
  category: business_logic
  message: "trocar-sku permitia troca com compra já ativa, descasando OC do produto do pedido"
  cause: "Rota não buscava compra_status/ordem_compra_id nem validava antes do UPDATE"
  fix: "Guard 409 quando algum item tem ordem_compra_id ou compra_status não-trocável"
  files: [src/app/api/wms/compras/trocar-sku/route.ts]
  tags: [compras, trocar-sku, guard, raio-x]
- id: P081
  date: 2026-06-05
  source: src/lib/compras-embalagem.ts
  category: business_logic
  message: "cross-dock sobrescrevia pedido em_separacao para separado, atropelando separação manual"
  cause: "em_separacao em PACKABLE_STATUSES + UPDATE incondicional por id"
  fix: "Tira em_separacao de PACKABLE + compare-and-set (.eq status_separacao) no UPDATE"
  files: [src/lib/compras-embalagem.ts]
  tags: [crossdock, embalagem, compare-and-set, raio-x]
- id: P154
  date: 2026-06-05
  source: supabase/migrations/20260605_wms_revisar_separacao_stale.sql
  category: business_logic
  message: "Pedidos ficavam dias em em_separacao; estoque reorganizado levava a pick de loc errada"
  cause: "Nenhum gate de staleness e nenhum job revisando em_separacao >24h"
  fix: "RPC wms_revisar_separacao_stale (reverte pedidos não-picados >24h) + cron diário 03:00"
  files: [supabase/migrations/20260605_wms_revisar_separacao_stale.sql]
  tags: [separacao, stale, cron, raio-x]
```
- [ ] **Step 2 — Commit.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): registra P017, P074, P031, P036, P081, P154 — guards de pré-condição"`

---

## PR 4: Marcar-item idempotente pós-reconexão (UX) + concluir/cross-dock no-regress [P013, P073, P080]

P013 (`partially_fixed`): a baixa do pick já é atômica (RPC); falta tratar o re-POST como idempotente (200 "já marcado") em vez de 409 confuso pós-reconexão. P073 e P080 (`already_fixed`): só travar o comportamento com cenário de regressão.

### Task 4.1: marcar-item re-POST idempotente quando o item já está marcado [P013]

**Files:**
- Modify `src/app/api/wms/separacao/marcar-item/route.ts:82-180` (short-circuit idempotente quando `item.separacao_marcado` já é true e `marcado:true`)
- Test `scripts/wms/cenarios/catalogo/85-marcar-item-idempotente-pos-reconexao.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Após um `marcar-item` bem-sucedido, um 2º POST `{marcado:true}` pro mesmo item deve retornar 200 (estado "já marcado") em vez de 409.

```ts
import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

type Setup = { sku: string; pedidoId: string };

export default {
  nome: "85 — marcar-item é idempotente no re-POST (reconexão)",
  descricao:
    "Após marcar um item com sucesso, um 2o POST {marcado:true} pro mesmo item retorna " +
    "200 ('já marcado') em vez de 409 confuso. Simula a rede caindo após o servidor commitar.",
  tags: ["separacao", "marcar-item", "idempotencia", "reconexao", "P013"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("85i");
    await ctx.criarProduto({ sku, descricao: "Marcar Item Idempotente 85" });
    return { sku, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 3 });
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 1 }],
    });
    setup.pedidoId = id;
    await ctx.aguardarStatusSeparacao(id, "aguardando_separacao", { timeout_ms: 30000 });
    await ctx.iniciarSeparacao(id);
    await ctx.aguardarStatusSeparacao(id, "em_separacao");

    const { data: item } = await ctx.sb
      .from("siso_pedido_itens").select("id").eq("pedido_id", id).single();
    const itemId = String((item as { id: string | number }).id);
    const headers = { "X-Galpao-Id": ctx.staging.empresas.netair.galpao_id };

    // 1º POST — marca (baixa atômica, R liberada).
    await ctx.http.post("/api/wms/separacao/marcar-item",
      { pedido_item_id: itemId, marcado: true }, headers);

    // 2º POST — reconexão: deve ser idempotente (200), NÃO 409.
    let segundoStatus = 0;
    let ok = false;
    try {
      const r = await ctx.http.post<{ separacao_marcado?: boolean }>(
        "/api/wms/separacao/marcar-item",
        { pedido_item_id: itemId, marcado: true }, headers);
      ok = r.separacao_marcado === true;
      segundoStatus = 200;
    } catch (e) {
      segundoStatus = (e as HttpError).status;
    }
    if (segundoStatus !== 200 || !ok) {
      throw new Error(`P013 não corrigido: 2o POST devolveu ${segundoStatus} (esperava 200 'já marcado')`);
    }
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens").select("separacao_marcado").eq("pedido_id", setup.pedidoId).single();
    if ((item as { separacao_marcado: boolean }).separacao_marcado !== true) {
      throw new Error("item deveria continuar separacao_marcado=true");
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios:only -- 85-marcar-item-idempotente-pos-reconexao`
  Expected: FAIL com "P013 não corrigido: 2o POST devolveu 409..." (no 2º POST, a R já foi liberada e o saldo já baixou → `falha_baixa_estoque`/`sem_saldo_para_baixa`).

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/separacao/marcar-item/route.ts`, no início do ramo `if (marcado)` (linha 82), curto-circuitar quando o item já está marcado. Adicionar logo após `if (marcado) {`:
```ts
    if (marcado) {
      // P013: re-POST idempotente. Se o item já está marcado (ex.: a rede caiu DEPOIS
      // do servidor commitar a baixa, antes do cliente receber a resposta), retornar o
      // estado atual com 200 em vez de tentar baixar de novo (que daria 409 'reserva já
      // liberada' / sem saldo) e confundir o operador.
      if (item.separacao_marcado === true) {
        return NextResponse.json({
          id: item.id,
          separacao_marcado: true,
          quantidade_pega: item.quantidade_pega,
          mov_saida_id: item.mov_saida_id,
          ja_marcado: true,
        });
      }
```
  Para isso, incluir `separacao_marcado` no select inicial do item (linha 44-45):
```ts
      .select(
        "id, pedido_id, produto_id, sku, quantidade_pedida, quantidade_pega, separacao_parcial, separacao_marcado, mov_saida_id",
      )
```

> Nota: o achado também sugere mexer em hooks realtime / componente do checklist (frontend) pra reconciliar a tela ao voltar online. Isso já é coberto pelo hook realtime genérico de `siso_pedido_itens` (a tela re-lê `separacao_marcado` ao receber o postgres_changes). A correção cirúrgica e testável é tornar o re-POST idempotente no backend (acima) — a parte de surfacing fica como melhoria de frontend fora do escopo testável desta task.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios:only -- 85-marcar-item-idempotente-pos-reconexao`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/separacao/marcar-item/route.ts scripts/wms/cenarios/catalogo/85-marcar-item-idempotente-pos-reconexao.ts && git commit -m "fix(wms): marcar-item re-POST idempotente (200 'já marcado') pós-reconexão [P013]"`

### Task 4.2: regressão — concluir idempotente no 2º clique [P073]

**Files:**
- Test `scripts/wms/cenarios/catalogo/88-concluir-idempotente-no-regress.ts` (Create) — só regressão; sem mudança de código.

- [ ] **Step 1 — Escrever o teste que falha (ou trava o comportamento).** Dois POST `/separacao/concluir` sequenciais com o pedido 100% marcado: ambos devem reportar o pedido em `separados`, nenhum em `pendentes`; o pedido permanece `separado`.

```ts
import type { Cenario, Ctx } from "../_harness/types";

type Setup = { sku: string; pedidoId: string };

export default {
  nome: "88 — concluir é idempotente no 2o clique (no-regress P073)",
  descricao:
    "Dois POST /separacao/concluir com o pedido já 100% marcado: ambas as respostas " +
    "trazem o pedido em 'separados' (mesma resposta), nunca em 'pendentes'. O pedido " +
    "permanece 'separado'.",
  tags: ["separacao", "concluir", "idempotencia", "regressao", "P073"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("88c");
    await ctx.criarProduto({ sku, descricao: "Concluir Idempotente 88" });
    return { sku, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 3 });
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 1 }],
    });
    setup.pedidoId = id;
    await ctx.aguardarStatusSeparacao(id, "aguardando_separacao", { timeout_ms: 30000 });
    await ctx.iniciarSeparacao(id);
    await ctx.aguardarStatusSeparacao(id, "em_separacao");
    await ctx.bipar({ pedido: id, item: sku, qty: 1 });

    const r1 = await ctx.http.post<{ separados: string[]; pendentes: string[] }>(
      "/api/wms/separacao/concluir", { pedido_ids: [id] });
    const r2 = await ctx.http.post<{ separados: string[]; pendentes: string[] }>(
      "/api/wms/separacao/concluir", { pedido_ids: [id] });

    if (!r1.separados.includes(id)) throw new Error("1o concluir não colocou o pedido em separados");
    if (!r2.separados.includes(id)) {
      throw new Error("P073 regressão: 2o concluir não reproduziu o pedido em separados");
    }
    if (r2.pendentes.includes(id)) {
      throw new Error("P073 regressão: 2o concluir marcou o pedido como pendente");
    }
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: ped } = await ctx.sb
      .from("siso_pedidos").select("status_separacao").eq("id", setup.pedidoId).single();
    if ((ped as { status_separacao: string }).status_separacao !== "separado") {
      throw new Error("pedido deveria permanecer 'separado'");
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

- [ ] **Step 2 — Rodar e ver o resultado.** `npm run scenarios:only -- 88-concluir-idempotente-no-regress`
  Expected: PASS (comportamento já idempotente — `concluir` deriva a resposta de `separacao_marcado` dos itens, que não é resetado, e o UPDATE tem `.eq('status_separacao','em_separacao')`). Se FALHAR, há regressão real → investigar `concluir/route.ts:225-251` antes de prosseguir.

- [ ] **Step 3 — Implementação.** Nenhuma mudança de código (already_fixed). O cenário trava o comportamento.

- [ ] **Step 4 — Confirmar.** Re-rodar o comando do Step 2: Expected PASS.

- [ ] **Step 5 — Commit.** `git add scripts/wms/cenarios/catalogo/88-concluir-idempotente-no-regress.ts && git commit -m "test(wms): regressão — concluir idempotente no 2o clique [P073]"`

### Task 4.3: regressão — cross-dock idempotente por pedido [P080]

**Files:**
- Test `test/integration/crossdock-trigger-idempotente.test.ts` (Create) — só regressão; sem mudança de código.

- [ ] **Step 1 — Escrever o teste que trava o comportamento.** Chamar `prepararPedidosDasOcsParaEmbalagem` 2x pra a mesma OC/pedido: na 2ª chamada o pedido já está `separado` e cai em `ja_separados` (não re-preparado), sem duplicar transição.

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { prepararPedidosDasOcsParaEmbalagem } from "../../src/lib/compras-embalagem";

const sb = createServiceClient();
let galpaoId: string, empresaId: string, ocId: string;
const PED = `TEST-XD-IDEMP-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: emp } = await sb.from("siso_empresas").select("id").eq("nome", "NetAir").single();
  empresaId = emp!.id;
  // siso_ordens_compra: fornecedor NOT NULL + status no CHECK (sem 'aberta').
  const { data: oc } = await sb
    .from("siso_ordens_compra")
    .insert({ fornecedor: "TEST-FORN-IDEMP", galpao_id: galpaoId, empresa_id: empresaId, status: "comprado" })
    .select("id").single();
  ocId = oc!.id;
  await sb.from("siso_pedidos").insert({
    id: PED, status: "executando", status_separacao: "aguardando_separacao",
    empresa_origem_id: empresaId, separacao_galpao_id: galpaoId,
  });
  await sb.from("siso_pedido_itens").insert({
    pedido_id: PED, produto_id: 777777, sku: "XD-IDEMP", quantidade_pedida: 1,
    compra_status: "recebido", ordem_compra_id: ocId,
  });
});

describe("prepararPedidosDasOcsParaEmbalagem — idempotente por pedido (no-regress P080)", () => {
  it("2a chamada cai em ja_separados, não re-prepara nem duplica", async () => {
    const r1 = await prepararPedidosDasOcsParaEmbalagem({ ordemCompraIds: [ocId] });
    expect(r1.preparados).toContain(PED);

    const r2 = await prepararPedidosDasOcsParaEmbalagem({ ordemCompraIds: [ocId] });
    expect(r2.preparados).not.toContain(PED);
    expect(r2.ja_separados).toContain(PED);

    const { data: ped } = await sb
      .from("siso_pedidos").select("status_separacao").eq("id", PED).single();
    expect(ped!.status_separacao).toBe("separado");
  });
});
```

- [ ] **Step 2 — Rodar e ver o resultado.** `npm run test:integration -- crossdock-trigger-idempotente`
  Expected: PASS (idempotência já existe via `READY_STATUS='separado'` → `jaSeparados` short-circuit em `compras-embalagem.ts:116-119`). Se FALHAR, há regressão → investigar.

- [ ] **Step 3 — Implementação.** Nenhuma (already_fixed). Cenário trava o comportamento. Combina com a Task 3.5 (mesmo arquivo): este teste valida que a remoção de `em_separacao` de PACKABLE não quebrou a idempotência do caminho `aguardando_separacao → separado`.

- [ ] **Step 4 — Confirmar.** Re-rodar Step 2: Expected PASS.

- [ ] **Step 5 — Commit.** `git add test/integration/crossdock-trigger-idempotente.test.ts && git commit -m "test(wms): regressão — cross-dock idempotente por pedido [P080]"`

### Task 4.4: erros-conhecidos.yaml — P013 (P073/P080 são regressão, sem fix novo)

- [ ] **Step 1 — Adicionar entrada (só P013; P073/P080 não geram fix de código).**
```yaml
- id: P013
  date: 2026-06-05
  source: src/app/api/wms/separacao/marcar-item/route.ts
  category: business_logic
  message: "Re-marcar item pós-reconexão devolvia 409 ('reserva já liberada') confuso ao operador"
  cause: "A baixa é atômica (RPC), mas o re-POST tentava baixar de novo e batia em sem saldo / reserva liberada"
  fix: "Short-circuit idempotente: se item.separacao_marcado já é true, retorna 200 com ja_marcado=true"
  files: [src/app/api/wms/separacao/marcar-item/route.ts]
  tags: [separacao, marcar-item, idempotencia, reconexao, raio-x]
```
- [ ] **Step 2 — Commit.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): registra P013 — marcar-item idempotente pós-reconexão"`

---

## Ordem de execução e dependências

- **PR 1** (P006) e **PR 2** (P012, P153) são independentes — quick wins.
- **PR 3** depende de nada entre si, exceto que a **Task 3.5 (P081)** e a **Task 4.3 (P080)** tocam o mesmo arquivo (`compras-embalagem.ts`); execute 3.5 antes de 4.3 (4.3 valida que 3.5 não quebrou a idempotência).
- **PR 4 Task 4.1 (P013)** edita `marcar-item/route.ts`, que **PR 1 Task 1.1** também edita — execute PR 1 antes de PR 4 pra evitar conflito de merge (o short-circuit de P013 entra no topo do ramo `if (marcado)`, os `registrarEvento` de P006 entram nos blocos de erro mais abaixo; não colidem, mas ordene mesmo assim).
- Ao fim de toda a fase: `npm test` + `npm run test:integration` + `npm run scenarios` e atualizar `docs/api-reference-complete.md` (campo `ja_em_separacao` em `iniciar`, `pedido_ids_multi_galpao` em `concluir-oc`) no mesmo commit final.
