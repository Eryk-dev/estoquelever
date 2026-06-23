# Separação Parcial — linha "PEGO" + "PEGAR" e fix da reserva destruída — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Numa separação parcial de wave consolidado, parar de destruir a reserva dos pedidos não atendidos e exibir no checklist uma linha "PEGO" (✓) + uma linha "PEGAR" (restante, reservada).

**Architecture:** Fix cirúrgico no `parcial/route.ts` (caminho modo-item): alocação FCFS por pedido computada **antes** da liberação de reserva; com `loc_zerou=false`, só libera a R de pedidos que receberam unidade (picked>0) e recria a R do residual na mesma loc. Frontend deriva duas linhas (PEGO/PEGAR) do somatório de `quantidade_pega` — sem heurística frágil. Sem mudança de schema.

**Tech Stack:** Next.js 16 (App Router) · TypeScript strict · Supabase (service role) · ledger via `wms_inserir_movimentacao` / helpers de `reservas-picking.ts` · cenários E2E HTTP (`scripts/wms/cenarios`, vitest p/ unit).

**Spec:** `docs/superpowers/specs/2026-06-02-separacao-parcial-pego-pegar-design.md`

---

## Invariante central (o que o fix garante)

> Na parcial, `Σ liberações L = quantidade pega` (que vira S) — exceto `loc_zerou=true`, onde o residual é liberado **e** re-reservado em outra loc pelo cascade. **Nunca** uma reserva é liberada sem virar saída ou ser recriada.

Hoje (`loc_zerou=false`, wave multi-pedido): libera 100% da R de **todos** os pedidos e nunca recria → pedido não-atendido perde a reserva. É o bug.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `scripts/wms/cenarios/catalogo/70-parcial-wave-reserva.ts` | Cenário E2E que reproduz o bug wave multi-pedido (repro → guard) | **Criar** |
| `src/app/api/wms/separacao/parcial/route.ts` | Backend da parcial; alocação FCFS + liberação condicional + recriação do residual | **Modificar** (`processarParcialItem`) |
| `scripts/wms/cenarios/catalogo/69-parcial-fila-prateleira.ts` | Cenário single-pedido; apertar guarda de `reservado` | **Modificar** |
| `src/app/wms/separacao/checklist/page.tsx` | Render: derivar e exibir duas linhas (PEGO/PEGAR) | **Modificar** (`consolidar` + render da lista + `ItemRow`) |
| `erros-conhecidos.yaml` | Registrar o bug + fix | **Modificar** |
| (staging, runtime) `siso_movimentacoes` / `siso_estoque` | Reparo do estado corrompido de #50189 | **Reparo manual auditado** |

Ordem de execução: **Task 1 → 2 → 3 → 4 → 6** (código+testes), **Task 5** (reparo de dados) pode rodar antes pra desbloquear o operador (independente do código).

---

## Task 1: Cenário E2E que reproduz o bug (RED)

**Files:**
- Create: `scripts/wms/cenarios/catalogo/70-parcial-wave-reserva.ts`

Reproduz o caso real: 2 pedidos do mesmo SKU consolidados, pega 1 de 2 com `loc_zerou=false`. A asserção-chave (`assertReservado === 1`) **falha no código atual** (que libera as 2 reservas → reservado 0).

- [ ] **Step 1: Escrever o cenário (teste que falha)**

```typescript
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 70 — Parcial WAVE multi-pedido (mesmo SKU, 2 pedidos consolidados).
 * Pega 1 de 2 unidades (loc NÃO zerou). Repro do bug: o loop de liberação
 * soltava a R de TODOS os pedidos do wave (100% cada) sem recriar → o pedido
 * que não recebeu unidade perdia a reserva pra sempre (caso #50144/#50189).
 *
 * Esperado pós-parcial consolidado (pega=1, loc_zerou=false):
 *   - 1 saída S de 1 un (saldo 5→4)
 *   - reservado = 1 (só a R do pedido atendido foi liberada; o residual mantém R)
 *   - pedido atendido (FCFS = menor id): quantidade_pega=1, separacao_marcado=true
 *   - pedido residual: quantidade_pega=0/null, separacao_marcado=false, R viva
 * Depois completa o residual (parcial single qty=1 no pedido residual):
 *   - acha a R viva, fecha o item; saldo 4→3, reservado 0
 */
export default {
  nome: "70 — Parcial wave multi-pedido não destrói reserva do residual",
  descricao:
    "2 pedidos mesmo SKU consolidados; pega 1 de 2 loc_zerou=false → só a R do atendido é liberada, residual mantém reserva.",
  tags: ["separacao", "parcial", "wave", "reserva", "regressao"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("70");
    await ctx.criarProduto({ sku, descricao: "Parcial wave 70" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-04", qty: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Dois pedidos de 1 un cada (NetAir→CWB, auto-aprova própria).
    const p1 = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 1 }] });
    const p2 = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 1 }] });
    for (const p of [p1, p2]) {
      await ctx.aguardarStatus(p.id, "concluido");
      await ctx.aguardarStatusSeparacao(p.id, "aguardando_separacao");
      await ctx.iniciarSeparacao(p.id);
    }

    // Reserva inicial: 2 (1 por pedido) na A-01-04.
    await ctx.assertReservado(sku, "CWB", "A-01-04", 2);

    // Resolve os 2 item_ids (mesmo SKU em pedidos diferentes) + galpão p/ header.
    const itemIds = await itemIdsDoSku(ctx, [p1.id, p2.id], sku);
    const galpaoId = await galpaoDoPedido(ctx, p1.id);

    // Parcial CONSOLIDADO: manda os 2 item_ids numa chamada só (= o que o
    // checklist faz no wave). Pega 1, loc NÃO zerou.
    await ctx.http.post(
      "/api/wms/separacao/parcial",
      { pedido_item_ids: itemIds, quantidade_pega: 1, loc_zerou: false },
      galpaoId ? { "X-Galpao-Id": galpaoId } : {},
    );

    // ── Asserções do fix ──
    await ctx.assertSaldo(sku, "CWB", "A-01-04", 4); // 1 S de 1
    await ctx.assertReservado(sku, "CWB", "A-01-04", 1); // ← FALHA no código atual (libera as 2 → 0)

    const { atendido, residual } = await classificarItens(ctx, [p1.id, p2.id], sku);
    if (Number(atendido.quantidade_pega) !== 1 || atendido.separacao_marcado !== true) {
      throw new Error(`pedido atendido deveria ter pega=1 e marcado=true; real pega=${atendido.quantidade_pega} marcado=${atendido.separacao_marcado}`);
    }
    if (Number(residual.quantidade_pega ?? 0) !== 0 || residual.separacao_marcado === true) {
      throw new Error(`pedido residual deveria ter pega=0 e marcado=false; real pega=${residual.quantidade_pega} marcado=${residual.separacao_marcado}`);
    }

    // ── Completa o residual (single) — prova que a R viva foi encontrada ──
    await ctx.parcial({ pedido: residual.pedido_id, item: sku, qty: 1, loc_zerou: false });
    return { sku };
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-04", 3); // 5 - 1 - 1
    await ctx.assertReservado(sku, "CWB", "A-01-04", 0); // tudo separado
    await ctx.assertSemReservasOrfas();
  },
} satisfies Cenario<{ sku: string }>;

type ItemRow = {
  id: string | number;
  pedido_id: string;
  quantidade_pega: number | null;
  separacao_marcado: boolean | null;
};

async function itemIdsDoSku(ctx: Ctx, pedidoIds: string[], sku: string): Promise<(string | number)[]> {
  const { data } = await ctx.sb
    .from("siso_pedido_itens")
    .select("id, pedido_id, sku")
    .in("pedido_id", pedidoIds)
    .eq("sku", sku);
  const ids = (data ?? []).map((r) => (r as { id: string | number }).id);
  if (ids.length !== pedidoIds.length) throw new Error(`esperava ${pedidoIds.length} itens do sku ${sku}; achei ${ids.length}`);
  return ids;
}

async function galpaoDoPedido(ctx: Ctx, pedidoId: string): Promise<string | undefined> {
  const { data } = await ctx.sb
    .from("siso_pedidos")
    .select("separacao_galpao_id")
    .eq("id", pedidoId)
    .maybeSingle();
  return (data as { separacao_galpao_id?: string } | null)?.separacao_galpao_id;
}

async function classificarItens(ctx: Ctx, pedidoIds: string[], sku: string): Promise<{ atendido: ItemRow; residual: ItemRow }> {
  const { data } = await ctx.sb
    .from("siso_pedido_itens")
    .select("id, pedido_id, quantidade_pega, separacao_marcado, sku")
    .in("pedido_id", pedidoIds)
    .eq("sku", sku);
  const rows = (data ?? []) as ItemRow[];
  const atendido = rows.find((r) => Number(r.quantidade_pega ?? 0) > 0);
  const residual = rows.find((r) => Number(r.quantidade_pega ?? 0) === 0);
  if (!atendido || !residual) throw new Error(`não classifiquei itens: ${JSON.stringify(rows)}`);
  return { atendido, residual };
}

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

- [ ] **Step 2: Rodar o cenário e confirmar que FALHA no `assertReservado`**

Run: `npm run scenarios:only -- "70 — Parcial wave"`
Expected: FAIL — `assertReservado` espera 1, real 0 ("reservado A-01-04 esperado 1, real 0" ou similar). Confirma a repro: o código atual libera as 2 reservas.

- [ ] **Step 3: Commit (red)**

```bash
git add scripts/wms/cenarios/catalogo/70-parcial-wave-reserva.ts
git commit -m "test(wms): cenário 70 repro parcial wave destrói reserva do residual (RED)"
```

---

## Task 2: Backend fix — alocação FCFS antes da liberação + liberação condicional + recria residual (GREEN)

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts` (função `processarParcialItem`)

Três edições. Antes de editar, **leia** `processarParcialItem` (linhas ~108-830) pra confirmar o contexto.

- [ ] **Step 1: Edição A — computar a distribuição FCFS por pedido ANTES do loop de liberação**

Hoje `itemUpdates` é computado em ~`:414` (depois da liberação). Mova pra antes do loop 7a. Logo **após** o bloco do gate de concorrência (a checagem `posicao_reservada`, termina em ~`:286`) e **antes** do comentário `// 7. Gera mov S única`, insira:

```typescript
    // Distribuição FCFS (movida pra ANTES da liberação): define, por pedido,
    // quanto foi pego (picked) e quanto sobra (residual). Isso governa QUAIS
    // reservas liberar (só de quem recebeu unidade) e qual residual re-reservar.
    const itemUpdates = distribuirQtyPega(itemsRaw, quantidade_pega).map((d) => ({
      item: d.item,
      qty_para_este: d.qty_para_este,
      qty_residual: d.qty_residual,
      pedido_id: d.item.pedido_id as string,
    }));
    const allocPorPedido = new Map<string, { picked: number; residual: number }>();
    for (const u of itemUpdates) {
      const cur = allocPorPedido.get(u.pedido_id) ?? { picked: 0, residual: 0 };
      cur.picked += u.qty_para_este;
      cur.residual += u.qty_residual;
      allocPorPedido.set(u.pedido_id, cur);
    }
```

Depois **remova** a declaração duplicada de `itemUpdates` em ~`:411-419` (o bloco `// 8. Distribui qty_pega ...` + `const itemUpdates = distribuirQtyPega(...)...`). Mantenha o `const nowIso = new Date().toISOString();` (ainda usado no Pass A/B) — apenas tire o `const itemUpdates = ...` redundante. O comentário "// 8." pode virar só `const nowIso = ...`.

- [ ] **Step 2: Edição B — no loop 7a, só liberar a R de quem recebeu unidade (quando loc não zerou)**

No loop `for (const pid of pedidoIds)` (~`:298`), logo no início do corpo do `for`, antes do `try`, insira o guard:

```typescript
    for (const pid of pedidoIds) {
      const alloc = allocPorPedido.get(pid) ?? { picked: 0, residual: 0 };
      // loc_zerou=false: NÃO liberar a R de pedido que não recebeu unidade
      // (FCFS deu tudo a outro do wave). Senão ele perde a reserva sem ter
      // sido separado — bug #50144/#50189. Com loc_zerou=true mantém o
      // comportamento antigo (libera todas; cascade recria em outra loc).
      if (!loc_zerou && alloc.picked === 0) continue;
      try {
```

(O resto do corpo do `for` — `buscarReservaPendente`, `liberarReservaPicking({ qty: Number(r.quantidade), ... })`, `liberacoesPorPedido.set(...)` — fica igual.)

- [ ] **Step 3: Edição C — recriar a R do residual na MESMA loc (loc_zerou=false)**

No bloco `if (!loc_zerou) { ... return parcial_em_progresso }` (~`:799-821`), **antes** da linha `const beneficiariosResiduais = ...`, insira a recriação do residual:

```typescript
    if (!loc_zerou) {
      // (comentário existente sobre item ficar aberto permanece)
      //
      // RE-RESERVA do residual na MESMA loc: a R original foi liberada 100% no
      // passo 7a (só pra quem pegou unidade). Recriamos uma R do que falta na
      // própria prateleira pra (a) a linha "PEGAR" continuar protegida (ninguém
      // rouba o saldo) e (b) o próximo parcial/marcar-item achar a R viva.
      // Pedido com picked=0 manteve a R original intacta (Edição B) → nada a fazer.
      for (const u of itemUpdates) {
        if (u.qty_residual <= 0 || u.qty_para_este <= 0) continue;
        const pedidoDoItem = pedidoById.get(u.pedido_id);
        try {
          await criarReservaCascade({
            tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: locOriginalId },
            qty: u.qty_residual,
            pedido_id: String(u.pedido_id),
            usuario_id: session.id,
            motivo: `Re-reserva residual mesma loc — parcial pedido #${pedidoDoItem?.numero ?? "?"}`,
            origem_detalhes: { contexto: "residual_mesma_loc", sku: u.item.sku, loc_id: locOriginalId },
          });
        } catch (e) {
          logger.warn("separacao-parcial", "Falhou re-reservar residual mesma loc (continua)", {
            pedido_id: u.pedido_id,
            qty_residual: u.qty_residual,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const beneficiariosResiduais = itemsResiduais.filter((u) => u.qty_para_este > 0);
      return NextResponse.json({
        status: "parcial_em_progresso",
        items_parciais: beneficiariosResiduais.length,
        items_residuais_a_fazer: itemsResiduais.length,
      });
    }
```

(`criarReservaCascade` já está importado no topo do arquivo — confirme; é o mesmo helper usado pelo cascade `loc_zerou=true`.)

- [ ] **Step 4: Rodar o cenário 70 e confirmar GREEN**

Run: `npm run scenarios:only -- "70 — Parcial wave"`
Expected: PASS (reservado=1 pós-parcial; residual completado; saldo final 3, reservado 0, sem reservas órfãs).

- [ ] **Step 5: Rodar lint + typecheck**

Run: `npm run lint`
Expected: sem erros novos no `parcial/route.ts`.

- [ ] **Step 6: Commit (green)**

```bash
git add src/app/api/wms/separacao/parcial/route.ts
git commit -m "fix(wms): parcial só libera reserva de quem pegou + re-reserva residual na mesma loc"
```

---

## Task 3: Apertar a guarda do cenário 69 (single-pedido) com `reservado`

**Files:**
- Modify: `scripts/wms/cenarios/catalogo/69-parcial-fila-prateleira.ts`

O 69 só assertava `saldo`. Agora que o residual fica reservado, adicione asserções de `reservado` (que falhariam no código antigo: residual era 0) e corrija o comentário stale "a R foi totalmente liberada".

- [ ] **Step 1: Atualizar comentário do header (linha ~16)**

Trocar:
```
 *   - saldo CWB cai 10→7 (S de 3); a R foi totalmente liberada
```
Por:
```
 *   - saldo CWB cai 10→7 (S de 3); a R original é liberada e o residual (2) é
 *     re-reservado na MESMA loc (reservado=2) — a linha "PEGAR" fica protegida
```

- [ ] **Step 2: Adicionar `assertReservado=2` após o 1º parcial**

Depois de `await ctx.assertSaldo(sku, "CWB", "A-01-03", 7);` (linha ~69), inserir:
```typescript
    await ctx.assertReservado(sku, "CWB", "A-01-03", 2); // residual re-reservado na mesma loc
```

- [ ] **Step 3: Adicionar `assertReservado=0` no `assertEsperado`**

No fim de `assertEsperado`, após `await ctx.assertSaldo(sku, "CWB", "A-01-03", 5);`, inserir:
```typescript
    await ctx.assertReservado(sku, "CWB", "A-01-03", 0); // tudo separado, sem reserva sobrando
```

- [ ] **Step 4: Rodar o 69 e confirmar PASS com o fix**

Run: `npm run scenarios:only -- "69 — Parcial"`
Expected: PASS (reservado=2 no meio, 0 no fim, saldo 5).

- [ ] **Step 5: Commit**

```bash
git add scripts/wms/cenarios/catalogo/69-parcial-fila-prateleira.ts
git commit -m "test(wms): 69 garante residual re-reservado na mesma loc (reservado)"
```

---

## Task 4: Frontend — duas linhas no checklist (PEGO ✓ + PEGAR)

**Files:**
- Modify: `src/app/wms/separacao/checklist/page.tsx` (tipo `ConsolidatedProduct`, `consolidar`, render da lista, `ItemRow`)

Hoje o bucket vira 1 linha e `qtyExibida = isParcial ? restante : total`, com `isParcial` numa heurística frágil que volta a mostrar o total. Substituir por: derivar `quantidade_pega` no bucket e renderizar **duas** linhas quando `0 < pega` e `restante > 0`.

- [ ] **Step 1: Adicionar `quantidade_pega` ao tipo `ConsolidatedProduct`**

Localize a interface (grep): `grep -n "interface ConsolidatedProduct" src/app/wms/separacao/checklist/page.tsx`. Adicione o campo:
```typescript
  quantidade_pega: number; // Σ quantidade_pega do bucket (derivado) — base da linha "PEGO"
```

- [ ] **Step 2: Popular `quantidade_pega` em `consolidar` (linhas 172-218)**

No ramo `existing` (após `existing.quantidade_restante += ...`):
```typescript
      existing.quantidade_pega += Number(it.quantidade_pega ?? 0);
```
No ramo `else` (objeto inicial, junto de `quantidade_restante`):
```typescript
        quantidade_pega: Number(it.quantidade_pega ?? 0),
```

- [ ] **Step 3: Escrever helper de expansão das linhas + render**

Antes do `return` da lista de itens normais, expanda cada produto em 1 ou 2 entradas de render. Adicione o tipo e o helper perto do topo do componente (fora do JSX):

```typescript
type LinhaRender = { produto: ConsolidatedProduct; modo: "normal" | "pego" | "pegar" };

function expandirLinhas(produtos: ConsolidatedProduct[]): LinhaRender[] {
  const out: LinhaRender[] = [];
  for (const p of produtos) {
    const pego = p.quantidade_pega;
    const restante = p.quantidade_restante;
    // Parcial em progresso: pegou algo E ainda falta → duas linhas (PEGO ✓ + PEGAR).
    if (pego > 0 && restante > 0) {
      out.push({ produto: p, modo: "pego" });
      out.push({ produto: p, modo: "pegar" });
    } else {
      out.push({ produto: p, modo: "normal" });
    }
  }
  return out;
}
```

No JSX onde hoje se faz `rows.map((p) => <ItemRow ... key={p.key} produto={p} .../>)`, troque por:
```tsx
{expandirLinhas(rows).map((linha) => (
  <ItemRow
    key={`${linha.produto.key}__${linha.modo}`}
    produto={linha.produto}
    modo={linha.modo}
    /* ...demais props existentes... */
  />
))}
```

- [ ] **Step 4: Ajustar `ItemRow` pra honrar `modo`**

Leia o componente `ItemRow` (região ~1040-1430) antes de editar. Adicione a prop `modo: "normal" | "pego" | "pegar"` (default `"normal"`) e aplique estas regras:

- **`modo === "pego"`**: linha de confirmação do que já foi pego.
  - Checkbox **marcado** e desabilitado (`checked`, sem ação de clique).
  - Quantidade exibida = `produto.quantidade_pega`. Rótulo `PEGO {qtd}` (badge verde "concluído").
  - **Esconder** os botões de ação (Parcial / marcar) — esta linha é só registro visual.
- **`modo === "pegar"`**: linha acionável do que falta.
  - Checkbox **aberto**. Quantidade exibida = `produto.quantidade_restante`. Rótulo `PEGAR {qtd}` + "reservado".
  - Botões de ação (Parcial / marcar/bipar) **ativos** — operam no `produto.item_ids` (mesmos do bucket).
- **`modo === "normal"`** (default): comportamento atual, MAS troque a fonte da quantidade exibida para não depender mais da heurística frágil:
  ```typescript
  // Antes: const qtyExibida = isParcial ? produto.quantidade_restante : produto.quantidade_total;
  // Depois: restante < total ⇒ algo já foi pego ⇒ mostra o restante.
  const qtyExibida =
    produto.quantidade_restante < produto.quantidade_total
      ? produto.quantidade_restante
      : produto.quantidade_total;
  ```
  (No caminho de duas linhas, `modo` nunca é "normal" pra bucket parcial; este ajuste só protege o caso de uma linha só.)

> Mantenha o badge "Parcial X/Y" existente apenas na linha `pegar` (ou remova-o, já que PEGO/PEGAR já comunicam). Não dependa de `separacao_parcial`/`isParcial` pra decidir as quantidades — use `quantidade_pega`/`quantidade_restante`.

- [ ] **Step 5: Verificar build/typecheck do front**

Run: `npm run lint`
Expected: sem erros de tipo (prop `modo`, campo `quantidade_pega`).

- [ ] **Step 6: Verificação visual manual (dev server)**

Run: `npm run dev` e abra o checklist de uma wave com SKU em 2 pedidos; faça um Parcial de 1 de 2.
Expected: aparece `☑ PEGO 1` + `☐ PEGAR 1` (e não "2"). Pegar o restante fecha as duas.

- [ ] **Step 7: Commit**

```bash
git add src/app/wms/separacao/checklist/page.tsx
git commit -m "feat(wms): checklist mostra linha PEGO (✓) + linha PEGAR no parcial em progresso"
```

---

## Task 5: Reparo do estado corrompido em staging (#50144 / #50189)

**Files:** (runtime, staging `ehbxpbeijofxtsbezwxd`) `siso_movimentacoes`, `siso_estoque`

O #50189 perdeu a R (liberada sem saída). Restaurar via o helper canônico idempotente `estornarLiberacaoReserva` (ressuscita a R a partir da L de `liberacao_reserva`). **Independente** do fix de código — pode rodar antes pra desbloquear a separação.

> ⚠️ Só em staging. Auditar com SELECT antes/depois. Nunca prod.

- [ ] **Step 1: Localizar a L de liberação órfã do #50189 (SELECT, auditoria)**

Via Supabase MCP (`execute_sql`, project `ehbxpbeijofxtsbezwxd`):
```sql
-- pedido_id text do #50189 + a L liberacao_reserva do ACD003 sem S correspondente
select m.id as liberacao_mov_id, m.origem_id as pedido_id, m.quantidade,
       m.localizacao_id, m.criado_em
from siso_movimentacoes m
join siso_produtos pr on pr.id = m.produto_id
where pr.sku ilike '%ACD003%'
  and m.tipo = 'L' and m.origem_tipo = 'liberacao_reserva'
  and m.origem_id in (
    select id from siso_pedidos where numero in ('50189') or id ilike '%50189%'
  )
order by m.criado_em desc;
```
Anote `liberacao_mov_id` e `pedido_id`.

- [ ] **Step 2: Conferir que NÃO há R viva pro #50189 (confirma corrupção)**

```sql
select m.id, m.tipo, m.quantidade
from siso_movimentacoes m
where m.origem_id = '<pedido_id #50189>' and m.origem_tipo = 'reserva_pedido' and m.tipo = 'R'
  and not exists (select 1 from siso_movimentacoes l where l.estorno_de = m.id and l.tipo = 'L');
```
Expected: 0 linhas (R foi destruída).

- [ ] **Step 3: Ressuscitar a R via script throwaway (helper idempotente)**

Criar `/Users/eryk/.claude/jobs/9e2a4df9/tmp/reparar-50189.ts`:
```typescript
import { estornarLiberacaoReserva } from "@/lib/wms/reservas-picking";

const LIBERACAO_MOV_ID = "<liberacao_mov_id do step 1>";
const PEDIDO_ID = "<pedido_id #50189>";
const USUARIO_ID = "<um siso_usuarios.id válido, ex.: o admin Eryk>";

const r = await estornarLiberacaoReserva({
  liberacao_mov_id: LIBERACAO_MOV_ID,
  pedido_id: PEDIDO_ID,
  usuario_id: USUARIO_ID,
  motivo: "Reparo bug parcial wave — ressuscita R do #50189 (liberada sem saída)",
});
console.log("R recriada:", r.id, "qty", r.quantidade);
```
Run: `npx tsx --env-file=.env /Users/eryk/.claude/jobs/9e2a4df9/tmp/reparar-50189.ts`
Expected: imprime o id da R nova (qty 1). Idempotente — se já existir, retorna a existente.

- [ ] **Step 4: Verificar reservado e a linha do checklist**

```sql
select e.saldo, e.reservado, e.disponivel
from siso_estoque e join siso_produtos pr on pr.id = e.produto_id
where pr.sku ilike '%ACD003%' and e.localizacao_id = '<loc A-01-1 do step 1>';
```
Expected: `reservado` voltou a refletir a 1 un do #50189. No checklist da wave, a linha agora mostra `PEGAR 1` (após Task 4) e a R protege o saldo.

> Não há commit (mudança de dado em staging, não de código). Registrar o que foi feito no relatório/handoff.

---

## Task 6: Documentação — `erros-conhecidos.yaml`

**Files:**
- Modify: `erros-conhecidos.yaml`

- [ ] **Step 1: Adicionar entrada do bug (grep antes pra não duplicar)**

Run: `grep -n "parcial" erros-conhecidos.yaml`

Adicionar:
```yaml
- id: parcial-wave-libera-reserva-residual
  date: 2026-06-02
  source: wms/separacao/parcial
  category: business_logic
  message: "Parcial de wave consolidado destruía a reserva dos pedidos não atendidos (liberava 100% da R de TODOS os pedidos, sem recriar quando loc_zerou=false)."
  cause: "Loop 7a em parcial/route.ts liberava Number(r.quantidade) pra cada pedido_id do wave incondicionalmente; cascade que recria R só roda em loc_zerou=true, então o residual de loc_zerou=false ficava sem reserva (e o checklist voltava a pedir a qty cheia)."
  fix: "Computar alocação FCFS por pedido antes da liberação; com loc_zerou=false, só liberar a R de pedidos com picked>0 e re-reservar o residual na mesma loc via criarReservaCascade. Frontend deriva linha PEGO (Σ quantidade_pega) + linha PEGAR (Σ restante)."
  files:
    - src/app/api/wms/separacao/parcial/route.ts
    - src/app/wms/separacao/checklist/page.tsx
    - scripts/wms/cenarios/catalogo/70-parcial-wave-reserva.ts
  tags: [separacao, parcial, reserva, wave, checklist]
```

- [ ] **Step 2: Commit**

```bash
git add erros-conhecidos.yaml
git commit -m "docs(wms): registra bug parcial wave libera reserva do residual"
```

---

## Self-Review (rodado contra a spec)

**1. Cobertura da spec:**
- §2 comportamento PEGO/PEGAR → Task 4. ✓
- §3 invariante (Σ L = pega; residual reservado) → Task 2 (edições B+C) + guardas Task 1/3. ✓
- §4.1 backend libera só o pego + residual reservado → Task 2. ✓
- §4.2 frontend deriva duas linhas, sem heurística frágil → Task 4 (steps 3-4). ✓
- §4.3 sem schema → nenhuma migration. ✓
- §5 reparo de dados → Task 5. ✓
- §6 testes (cenário wave + regressão loc_zerou=true + 69) → Task 1 + Task 3. Regressão `loc_zerou=true`: o caminho do cascade não foi tocado (Edição B só pula liberação quando `!loc_zerou`); o 69 e demais cenários de cascade cobrem. ✓
- §7 fora de escopo (sem linha-filha, sem UI de escolha, FCFS) → respeitado. ✓

**2. Placeholder scan:** sem "TBD/TODO"; todo step com código/comando reais. Os `<...>` no Task 5 são valores de runtime de staging (ids), colhidos por SELECT no próprio step — não placeholders de design.

**3. Consistência de tipos/nomes:** `itemUpdates` (movido, mesma shape `{item, qty_para_este, qty_residual, pedido_id}`), `allocPorPedido` (Edição A→B→C), `criarReservaCascade` (assinatura de `reservas-picking.ts:255`), `quantidade_pega`/`quantidade_restante`/`quantidade_total` (consistentes consolidar↔ItemRow), `estornarLiberacaoReserva` (`reservas-picking.ts:318`). ✓

**4. Ambiguidade:** alocação FCFS por id asc (determinística); residual reservado na mesma loc; PEGO acumulativo (não histórico). ✓
