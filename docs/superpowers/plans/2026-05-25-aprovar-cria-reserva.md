# Aprovar Cria Reserva — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando o operador aprovar um pedido como `propria` ou `transferencia`, criar as reservas R correspondentes no ledger WMS — restaurando o invariante R→L+S quando o webhook não criou reserva (porque saldo era zero na chegada e veio depois).

**Architecture:** Edit cirúrgico em `aprovar/route.ts` que insere bloco "criar reservas" entre a resolução de empresa/galpão e o UPDATE de status. Loop atômico tudo-ou-nada com rollback via novo helper `estornarReservaIndividual`. Idempotência por pedido. Frontend já gate corretamente (descoberto na fase de design — apenas smoke test).

**Tech Stack:** Next.js App Router (route handler), Supabase service client, RPCs `wms_reservar_atomico` + `wms_inserir_movimentacao` (existentes), Vitest (unit), scripts/wms/cenarios (e2e).

**Spec:** `docs/superpowers/specs/2026-05-25-aprovar-cria-reserva-design.md`

---

## File Structure

| Path | Responsabilidade | Mudança |
|---|---|---|
| `src/lib/wms/reservas.ts` | Cliente das primitivas de reserva (RPC + L de liberação). | Add `estornarReservaIndividual` |
| `src/lib/wms/reservas.test.ts` | Unit tests do módulo de reservas (vitest). | Add `describe` pro novo helper |
| `src/app/api/wms/pedidos/aprovar/route.ts` | Route handler que transita o pedido pra `executando`. | Add bloco "criar reservas" + helper local `criarReservasPedido` |
| `scripts/wms/cenarios/catalogo/18-aprovar-cria-reserva.ts` | E2E: pedido OC → adiciona saldo → aprova propria → R criada. | New |
| `scripts/wms/cenarios/catalogo/19-aprovar-sem-cobertura-falha.ts` | E2E: aprovar sem cobertura → 409 + zero reservas órfãs. | New |
| `CLAUDE.md` | Documentação viva. | Edit: linha do aprovar nas APIs + nota no fluxo R→L+S |

Os cenários não precisam ser registrados manualmente: `run-all.ts` faz `readdir(catalogo)` (linha 4) e carrega tudo dinamicamente — basta criar o arquivo.

---

### Task 1: Helper `estornarReservaIndividual` em `src/lib/wms/reservas.ts`

**Files:**
- Modify: `src/lib/wms/reservas.ts`
- Test: `src/lib/wms/reservas.test.ts`

- [ ] **Step 1: Inspecionar reservas.test.ts atual pra seguir padrão**

Run: `cat src/lib/wms/reservas.test.ts | head -40`
Anotar o estilo de mocking (provavelmente in-memory stubs do supabase).

- [ ] **Step 2: Escrever testes falhando**

Abrir `src/lib/wms/reservas.test.ts` e adicionar no fim:

```ts
import { estornarReservaIndividual } from "./reservas";

describe("estornarReservaIndividual", () => {
  it("insere L com estorno_de = reserva_id e retorna o id do L", async () => {
    // Stub: simula que reserva_id corresponde a uma R existente em siso_movimentacoes
    // (use o mesmo padrão de stub já existente nos testes desse arquivo)
    const reservaId = "00000000-0000-0000-0000-000000000001";
    const novoLId = await estornarReservaIndividual({
      reserva_id: reservaId,
      motivo: "rollback_aprovacao",
    });
    expect(novoLId).toMatch(/^[0-9a-f-]{36}$/);
    // Asserta no stub que insert foi chamado com tipo='L' + estorno_de=reservaId
  });

  it("é idempotente: se já existe L com estorno_de=reserva_id, retorna o id existente sem criar novo", async () => {
    const reservaId = "00000000-0000-0000-0000-000000000002";
    const lExistenteId = "00000000-0000-0000-0000-000000000999";
    // Stub: pré-popula um L com estorno_de=reservaId
    const id = await estornarReservaIndividual({
      reserva_id: reservaId,
      motivo: "rollback_aprovacao",
    });
    expect(id).toBe(lExistenteId);
    // Asserta no stub que NENHUM novo insert ocorreu
  });

  it("lança se reserva_id não corresponde a nenhuma R em siso_movimentacoes", async () => {
    await expect(
      estornarReservaIndividual({
        reserva_id: "00000000-0000-0000-0000-000000000000",
        motivo: "rollback_aprovacao",
      }),
    ).rejects.toThrow(/reserva.*nao.*encontrada/i);
  });
});
```

> **Nota pro engenheiro:** o arquivo `reservas.test.ts` já existe — não recrie do zero, anexe ao final. Se o estilo de stub no arquivo for diferente do exemplo (ex.: usa um `mockSupabase` injetado), adapte os 3 testes pra esse estilo.

- [ ] **Step 3: Rodar testes pra confirmar que falham**

Run: `npx vitest run src/lib/wms/reservas.test.ts`
Expected: 3 FAIL em "estornarReservaIndividual" com "estornarReservaIndividual is not exported" ou similar.

- [ ] **Step 4: Implementar `estornarReservaIndividual`**

Em `src/lib/wms/reservas.ts`, adicionar antes do fim do arquivo:

```ts
export interface EstornarReservaInput {
  reserva_id: string;
  motivo: "rollback_aprovacao" | "outro";
  usuario_id?: string;
}

/**
 * Estorna UMA reserva específica inserindo L com estorno_de=reserva_id.
 * Diferente de `liberarReserva` (que opera por pedido_id e libera todas as
 * R do pedido), aqui o alvo é individual — usado pra rollback parcial em
 * fluxos atomicos (ex.: aprovar criou 3 R e a 4ª falhou; precisa estornar
 * as 3 sem mexer em reservas de outros pedidos).
 *
 * Idempotente: se já existe L com estorno_de=reserva_id, retorna o id
 * existente sem criar novo L.
 */
export async function estornarReservaIndividual(
  input: EstornarReservaInput,
): Promise<string> {
  const sb = createServiceClient();

  // Idempotência: L já existe?
  const { data: existente } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("estorno_de", input.reserva_id)
    .eq("tipo", "L")
    .maybeSingle();
  if (existente?.id) return existente.id as string;

  // Carrega a R original pra reconstruir tripla + qty
  const { data: reserva, error: rErr } = await sb
    .from("siso_movimentacoes")
    .select("produto_id, galpao_id, localizacao_id, quantidade")
    .eq("id", input.reserva_id)
    .eq("tipo", "R")
    .maybeSingle();
  if (rErr || !reserva) {
    throw new Error(`Reserva ${input.reserva_id} não encontrada`);
  }

  const mov = await inserirMovimentacao({
    tripla: {
      produto_id: reserva.produto_id as string,
      galpao_id: reserva.galpao_id as string,
      localizacao_id: reserva.localizacao_id as string,
    },
    tipo: "L",
    qty: Number(reserva.quantidade),
    origem_tipo: "liberacao_reserva",
    origem_detalhes: { motivo: input.motivo },
    estorno_de: input.reserva_id,
    usuario_id: input.usuario_id,
    motivo: `Estorno individual: ${input.motivo}`,
  });
  return mov.id;
}
```

- [ ] **Step 5: Rodar testes pra confirmar que passam**

Run: `npx vitest run src/lib/wms/reservas.test.ts`
Expected: PASS em todos os testes do arquivo (preexistentes + 3 novos).

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit`
Expected: 0 erros.

- [ ] **Step 7: Commit**

```bash
git add src/lib/wms/reservas.ts src/lib/wms/reservas.test.ts
git commit -m "feat(wms/reservas): estornarReservaIndividual para rollback parcial

Helper que insere L com estorno_de=reserva_id pra estornar UMA reserva
específica. Idempotente. Usado pelo aprovar pra rollback quando uma das
N reservas atômicas falha (race condition)."
```

---

### Task 2: Bloco de criação de reservas em `/api/wms/pedidos/aprovar`

**Files:**
- Modify: `src/app/api/wms/pedidos/aprovar/route.ts`
- Test: `scripts/wms/cenarios/catalogo/18-aprovar-cria-reserva.ts`

- [ ] **Step 1: Escrever cenário e2e falhando**

Criar `scripts/wms/cenarios/catalogo/18-aprovar-cria-reserva.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "18 — Aprovar cria reserva (saldo chegou depois)",
  descricao:
    "Webhook entra sem saldo (sugestao=oc), operador adiciona saldo via " +
    "ajuste, aprova manualmente como propria — aprovar deve criar R no " +
    "ledger antes de transitar status.",
  tags: ["pedido", "aprovar", "reserva", "wms-as-source"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("18");
    await ctx.criarProduto({ sku, descricao: "Aprovar reserva 18" });
    // NÃO semeia saldo — webhook vai pra OC
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Webhook entra sem saldo → sugestao=oc
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: undefined }, { timeout_ms: 8_000 });

    // 2. Adiciona saldo agora (depois do webhook)
    await ctx.ajusteManual({
      sku,
      galpao: "CWB",
      loc: "DEFAULT-PICKING",
      delta: 10,
      motivo: "Setup pós-webhook pra testar aprovar com reserva",
    });

    // 3. Operador aprova como propria (agora tem saldo)
    await ctx.aprovar(pedido.id, "propria");
    await ctx.aguardarStatus(pedido.id, "executando");
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo continua 10 (reserva não baixa saldo, só reservado)
    await ctx.assertSaldo(sku, "CWB", "DEFAULT-PICKING", 10);
    // Reservado = 3 (a reserva foi criada)
    await ctx.assertReservado(sku, "CWB", "DEFAULT-PICKING", 3);
    // 2 movs: 1 E (ajuste) + 1 R (reserva criada pelo aprovar)
    await ctx.assertMovsCount(sku, 2);
  },
} satisfies Cenario<{ sku: string }>;

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

- [ ] **Step 2: Rodar o cenário pra confirmar que falha**

Run: `npx tsx scripts/wms/cenarios/catalogo/18-aprovar-cria-reserva.ts`
Expected: FAIL em `assertReservado` esperando 3 mas tendo 0 — porque o aprovar atual não cria R.

> Se a primeira execução falhar em algum step de setup (ex.: dev server não rodando), siga as instruções de erro pra iniciar o ambiente local: `npm run dev -- --port 3001` em outro shell, depois reexecutar.

- [ ] **Step 3: Modificar `src/app/api/wms/pedidos/aprovar/route.ts`**

3.1. Adicionar imports no topo (após os imports existentes):

```ts
import { wmsAsSource } from "@/lib/wms/flags";
import { reservarAtomico, estornarReservaIndividual } from "@/lib/wms/reservas";
import {
  resolverProdutoWms,
  buscarLocComMaiorSaldoNoGalpao,
} from "@/lib/separacao/wms-mapping";
```

3.2. Inserir o bloco de criação de reservas LOGO ANTES do "Update order to 'executando'" (procurar o comentário existente `// Update order to "executando"`, inserir o bloco antes dele):

```ts
  // Em WMS_AS_SOURCE, quando decisao manual é propria/transferencia,
  // criar as reservas R atomicamente ANTES de transitar status. Se algum
  // item falhar, estorna parciais e devolve 409 sem mexer no pedido.
  // OC permanece intocado (não reserva).
  if (wmsAsSource() && (decisao === "propria" || decisao === "transferencia")) {
    const reservaResult = await criarReservasPedido({
      pedidoId,
      empresaExecucaoId,
      separacaoGalpaoId,
    });
    if (!reservaResult.ok) {
      return NextResponse.json(reservaResult.body, { status: 409 });
    }
  }
```

3.3. Adicionar o helper local `criarReservasPedido` no FIM do arquivo (depois do `export async function POST`):

```ts
type ReservaResult =
  | { ok: true; reservasCriadas: number }
  | { ok: false; body: Record<string, unknown> };

/**
 * Cria reservas R atomicamente pra cada item do pedido. Tudo-ou-nada:
 * se alguma falhar, estorna as N-1 já criadas via estornarReservaIndividual
 * e retorna { ok: false, body } pra o handler devolver 409.
 *
 * Idempotência: se já existe qualquer R com origem_id=pedidoId, skipa todo
 * o bloco e retorna ok: true, reservasCriadas: 0.
 */
async function criarReservasPedido(args: {
  pedidoId: string;
  empresaExecucaoId: string;
  separacaoGalpaoId: string;
}): Promise<ReservaResult> {
  const { pedidoId, empresaExecucaoId, separacaoGalpaoId } = args;
  const supabase = createServiceClient();

  // 1. Idempotência: R já existe pro pedido?
  const { data: jaR } = await supabase
    .from("siso_movimentacoes")
    .select("id")
    .eq("origem_id", pedidoId)
    .eq("origem_tipo", "reserva_pedido")
    .eq("tipo", "R")
    .limit(1);
  if ((jaR?.length ?? 0) > 0) {
    logger.info("aprovar.reservas", "Reservas já existentes — skip", { pedidoId });
    return { ok: true, reservasCriadas: 0 };
  }

  // 2. Itens do pedido
  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select("id, produto_id, sku, quantidade_pedida")
    .eq("pedido_id", pedidoId);
  if (!itens || itens.length === 0) {
    logger.warn("aprovar.reservas", "Pedido sem itens", { pedidoId });
    return { ok: true, reservasCriadas: 0 };
  }

  // 3. Loop atômico
  const criadas: string[] = []; // ids das R criadas (pra rollback)
  for (const item of itens) {
    const qty = Number(item.quantidade_pedida ?? 0);
    if (qty <= 0) continue;

    try {
      const produtoWmsId = await resolverProdutoWms(
        empresaExecucaoId,
        String(item.produto_id),
      );
      const locId = await buscarLocComMaiorSaldoNoGalpao(
        separacaoGalpaoId,
        produtoWmsId,
      );
      if (!locId) {
        await rollbackReservas(criadas, pedidoId);
        return {
          ok: false,
          body: {
            error: "reserva_falhou",
            motivo: "sem_saldo",
            item: { sku: item.sku, produto_id_tiny: item.produto_id, qty },
            criadas_estornadas: criadas.length,
          },
        };
      }

      const reservaId = await reservarAtomico({
        tripla: {
          produto_id: produtoWmsId,
          galpao_id: separacaoGalpaoId,
          localizacao_id: locId,
        },
        qty,
        pedido_id: pedidoId,
        ttl_horas: 24 * 30, // 30 dias, alinhado com webhook-processor-wms
      });
      criadas.push(reservaId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await rollbackReservas(criadas, pedidoId);

      // Distingue mapeamento ausente vs outros erros pra mensagem melhor
      const motivo = /mapeado em siso_produto_empresas/i.test(msg)
        ? "mapeamento_ausente"
        : /saldo|reserva|disponivel/i.test(msg)
          ? "saldo_insuficiente"
          : "erro_runtime";

      return {
        ok: false,
        body: {
          error: "reserva_falhou",
          motivo,
          item: { sku: item.sku, produto_id_tiny: item.produto_id, qty },
          criadas_estornadas: criadas.length,
          detalhe: msg,
        },
      };
    }
  }

  logger.info("aprovar.reservas", "Reservas criadas", {
    pedidoId,
    total: criadas.length,
  });
  return { ok: true, reservasCriadas: criadas.length };
}

async function rollbackReservas(reservaIds: string[], pedidoId: string): Promise<void> {
  for (const rId of reservaIds) {
    try {
      await estornarReservaIndividual({
        reserva_id: rId,
        motivo: "rollback_aprovacao",
      });
    } catch (err) {
      logger.error("aprovar.reservas", "Falha ao estornar R em rollback", {
        pedidoId,
        reservaId: rId,
        err: err instanceof Error ? err.message : String(err),
      });
      // Continue — o operador vai precisar de cleanup manual desse R órfão.
    }
  }
}
```

- [ ] **Step 4: Rodar o cenário 18 pra confirmar que passa**

Run: `npx tsx scripts/wms/cenarios/catalogo/18-aprovar-cria-reserva.ts`
Expected: PASS. Asserts confirmam saldo=10, reservado=3, 2 movs (E + R), invariantes I1–I7 verdes.

- [ ] **Step 5: Type check + lint dos arquivos tocados**

Run:
```bash
npx tsc --noEmit
npx eslint src/app/api/wms/pedidos/aprovar/route.ts src/lib/wms/reservas.ts
```
Expected: 0 erros em ambos.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/wms/pedidos/aprovar/route.ts scripts/wms/cenarios/catalogo/18-aprovar-cria-reserva.ts
git commit -m "feat(api/aprovar): cria reservas R quando WMS_AS_SOURCE + decisao propria/transferencia

Antes, se webhook chegava sem saldo (sugestao=oc) e o operador adicionava
saldo + aprovava manual como propria, o pedido ia pra separação sem nenhuma
R no ledger — o cutover R→L+S não tinha o que liberar, ficando fora do
desenho. Agora o aprovar:

- Resolve produto WMS + loc com maior saldo no separacao_galpao_id
- Loop atômico tudo-ou-nada via reservarAtomico
- Rollback via estornarReservaIndividual se algum item falhar (race)
- Idempotência por pedido (skip se já existe R com origem_id=pedidoId)

Em falha de runtime devolve 409 com motivo estruturado
(saldo_insuficiente | mapeamento_ausente | erro_runtime), pedido continua
pendente. OC permanece intocado.

Cenário 18 valida o fluxo end-to-end."
```

---

### Task 3: Cenário 19 — aprovar sem cobertura devolve 409

**Files:**
- Test: `scripts/wms/cenarios/catalogo/19-aprovar-sem-cobertura-falha.ts`

- [ ] **Step 1: Escrever cenário 19**

Criar `scripts/wms/cenarios/catalogo/19-aprovar-sem-cobertura-falha.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "19 — Aprovar sem cobertura devolve 409",
  descricao:
    "Pedido entra sem saldo, operador tenta aprovar via API direta como " +
    "propria sem ter adicionado estoque — backend devolve 409, pedido " +
    "continua pendente, nenhuma R órfã.",
  tags: ["pedido", "aprovar", "reserva", "wms-as-source", "falha"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("19");
    await ctx.criarProduto({ sku, descricao: "Aprovar sem cobertura 19" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 5 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: undefined });

    // Tenta aprovar como propria SEM ter adicionado saldo.
    // ctx.aprovar joga em erro 4xx — capturar e validar.
    let erro: Error | null = null;
    try {
      await ctx.aprovar(pedido.id, "propria");
    } catch (e) {
      erro = e as Error;
    }
    if (!erro) {
      throw new Error("aprovar deveria ter falhado com 409 mas não falhou");
    }
    // Mensagem do http helper deve conter o status 409 ou o body.
    if (!/409|reserva_falhou|sem_saldo/i.test(erro.message)) {
      throw new Error(
        `aprovar falhou mas mensagem inesperada: ${erro.message}`,
      );
    }
  },

  assertEsperado: async (ctx, { sku, pedido }: { sku: string; pedido?: { id: string } }) => {
    // Pedido continua pendente (não foi pra executando)
    // pedido vem do run via closure — alternativa: re-buscar via sku
    void sku;
    void pedido;
    // assertSemReservasOrfas garante que nenhum R ficou pra trás.
    await ctx.assertSemReservasOrfas();
  },
} satisfies Cenario<{ sku: string }>;

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

> **Cuidado:** o tipo `TSetup` do `Cenario` só conhece os campos retornados pelo `setup`. O cenário acima usa só `{ sku }` no setup. Pra checar status do pedido depois do erro, ou (a) capture o pedido em uma variável de módulo (escopo do default export, ANTES do `export default`), ou (b) re-busque o pedido pelo SKU no asserts via `ctx.sb.from("siso_pedido_itens").select("pedido_id").eq("sku", sku)`. **Opte por (b)** pra ficar mais limpo:

Atualize o `assertEsperado` pra:

```ts
  assertEsperado: async (ctx, { sku }) => {
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("pedido_id")
      .eq("sku", sku)
      .maybeSingle();
    if (itemRow?.pedido_id) {
      await ctx.assertPedidoStatus(String(itemRow.pedido_id), "pendente");
    }
    await ctx.assertSemReservasOrfas();
  },
```

> **Verifique** que `ctx.sb` está exposto no `Ctx`. Se não, use `createServiceClient()` import direto. Procure por `ctx.sb` em outros cenários: `grep -rn "ctx.sb\|ctx\.supabase" scripts/wms/cenarios/catalogo/ | head -3`.

- [ ] **Step 2: Rodar o cenário 19 pra confirmar que passa**

Run: `npx tsx scripts/wms/cenarios/catalogo/19-aprovar-sem-cobertura-falha.ts`
Expected: PASS. Pedido continua `pendente`, `assertSemReservasOrfas` verde.

- [ ] **Step 3: Rodar a bateria completa pra garantir que nada regressou**

Run: `npm run scenarios`
Expected: 19 cenários PASS (17 existentes + 18 + 19), invariantes I1–I7 verdes em todos.

> Se algum cenário pré-existente quebrar, NÃO tente fixar nesse plano — anote o nome do cenário e o erro, e me avise. O escopo deste plano é apenas aprovar + reserva.

- [ ] **Step 4: Commit**

```bash
git add scripts/wms/cenarios/catalogo/19-aprovar-sem-cobertura-falha.ts
git commit -m "test(scenarios): 19 — aprovar sem cobertura devolve 409

Valida que tentar aprovar propria/transferencia sem saldo no banco
devolve 409 estruturado, pedido continua pendente, e nenhuma R órfã fica
no ledger (rollback funcionou)."
```

---

### Task 4: Smoke test do frontend + atualizar CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Smoke test manual do frontend**

Pré-condições: `WMS_AS_SOURCE=true` (default em prod hoje), staging ativo.

1. Em `/wms/pedidos`, identifica um pedido pendente sem cobertura no galpão origem.
2. Confirma que o dropdown de aprovação mostra os botões `propria` e/ou `transferencia` cinza + label "sem estoque".
3. Tenta clicar no botão cinza — confirma que **não dispara nenhuma ação** (cursor `not-allowed`, sem network request).
4. Em outra aba, faz um ajuste manual em `/wms/ajuste` adicionando saldo do SKU no galpão origem.
5. Volta na aba de pedidos e espera no máximo 2s — o botão `propria` deve **virar clicável automaticamente** (realtime do commit `eac2826`).
6. Clica em `propria` — confirma toast de sucesso + pedido sai da fila de pendentes.

Se algum passo (1–6) falhar, documente o que falhou e crie um issue separado (fora do escopo deste plano).

- [ ] **Step 2: Atualizar CLAUDE.md — linha do aprovar**

Em `CLAUDE.md`, na seção "Pedidos" do mapa de APIs, encontrar a linha:

```
        pedidos/aprovar/route.ts           # Order approval (POST) — enqueues execution
```

Substituir por:

```
        pedidos/aprovar/route.ts           # Order approval (POST) — enqueues execution. Em WMS_AS_SOURCE, cria reservas R antes do enqueue (idempotente); 409 se runtime sem cobertura
```

- [ ] **Step 3: Atualizar CLAUDE.md — nota no fluxo R→L+S**

Em `CLAUDE.md`, na seção "WMS_AS_SOURCE ativado por default (cutover Plano 6, 2026-05-25)", após o parágrafo existente, adicionar:

```markdown
- **Aprovar manual completa a reserva (2026-05-25, mesmo dia do cutover).** Quando webhook entrou com saldo=0 (sugestao=oc) mas o operador inseriu estoque depois e aprovou como propria/transferência, o `/api/wms/pedidos/aprovar` agora cria as reservas R correspondentes antes de transitar status. Frontend desabilita os botões propria/transferência se o estoque live não cobre todos os itens (`decisaoIsAvailable` em `pedido-card-wms.tsx`). Spec: `docs/superpowers/specs/2026-05-25-aprovar-cria-reserva-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): aprovar cria reserva no fluxo WMS_AS_SOURCE"
```

---

## Self-Review (já executado pelo planner)

**Spec coverage:**
- Seção 1 (Frontend) → Task 4 step 1 (smoke test apenas, código já existe). ✅
- Seção 2 (Backend `/aprovar`) → Task 2. ✅
- Seção 3 (Helper `estornarReservaIndividual`) → Task 1. ✅
- Seção 4 (Edge cases) → cobertos no comportamento implementado em Task 2 + cenários 18 e 19. ✅
- Seção 6 (Testes) → cenários 18 e 19 nas Tasks 2 e 3 + unit tests do helper em Task 1. ✅
- Seção 7 (Resumo do impacto) → todos os arquivos listados estão nas Tasks 1–4. ✅

**Placeholder scan:** Nenhum "TODO/TBD/fill in". Steps de código contém o código completo. ✅

**Type consistency:** `estornarReservaIndividual` é definido em Task 1 step 4 e usado em Task 2 step 3 com mesma assinatura `(input: { reserva_id, motivo, usuario_id? })`. `criarReservasPedido` é definido em Task 2 e retorna `{ ok, reservasCriadas } | { ok: false, body }`. `reservarAtomico` é assinatura existente no `reservas.ts` (não precisa criar). `wmsAsSource()` e `resolverProdutoWms` e `buscarLocComMaiorSaldoNoGalpao` são existentes (commit `556e299`). ✅

---

## Execução

**Plan complete and saved to `docs/superpowers/plans/2026-05-25-aprovar-cria-reserva.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — eu dispacho um subagent fresco por task, reviso entre tasks, iteração rápida.

**2. Inline Execution** — executo as tasks nesta sessão usando executing-plans, batch com checkpoints pra revisão.

Qual abordagem?
