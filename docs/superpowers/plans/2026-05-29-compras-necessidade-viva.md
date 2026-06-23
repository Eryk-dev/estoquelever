# Necessidade de Compra Viva (sem travar parcial) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar a "quantidade a comprar" da tela de Compras um **número líquido vivo por SKU** — recalculado a cada leitura como `demanda em aberto − estoque livre atual − em-trânsito` — e mostrar **giro/cobertura** ao lado de cada SKU, sem nunca travar/reservar o estoque parcial.

**Architecture:** A regra fica numa função PURA (`calcularNecessidadeLiquida`) testável por unidade. A listagem de compras (`fetchComprar`) passa a reunir 3 entradas por SKU — demanda residual dos pedidos que ainda precisam do item (incluindo os que **já compraram**, pra não sub-comprar), estoque livre **ao vivo** de `siso_estoque`, e o que está em trânsito (`comprado` ainda não recebido) — e chama a função pura. Uma segunda peça anexa giro/cobertura da MV `siso_cobertura_estoque`. A regra de **reserva NÃO é tocada** (decisão de negócio: pedido parcial deixa o estoque livre; pedido com cobertura total já reserva e isso é neutro pro SLA porque ele sai na hora).

**Tech Stack:** Next.js 16 App Router (route handlers), TypeScript, Supabase (service client), Vitest (unit), React 19 (tela).

**Decisão de negócio que ancora o plano (firmada 2026-05-29):** nunca travar parcial; comprar só o déficit; necessidade viva por SKU; comprador decide folga ancorado em giro + aging. Validação de fluxo: `docs/superpowers/specs/2026-05-29-reservar-parcial-comprar-resto-fluxo.html`. Estado atual verificado por auditoria multi-agente (necessidade hoje é calculada UMA vez e congela; não desconta em-trânsito; giro existe mas fora da tela de compra).

---

## Contexto verificado (não re-investigar)

- **Listagem de compras:** `src/app/api/wms/compras/route.ts` → `fetchComprar` (linhas 222-332) hoje soma `getCompraQuantidadeSolicitada(item)` (valor **congelado**) em `quantidade_necessaria` por SKU.
- **Helpers:** `src/lib/compras-utils.ts` já tem `getCompraQuantidadeRestante` (= solicitada − recebida, pode ser negativo em over-receive) **pronta e sem uso na listagem**, `getCompraQuantidadeSolicitada` e `getAgingDays`.
- **Cobertura:** `src/lib/wms/cobertura.ts` define `StatusCobertura` e `LinhaCobertura`. MV `siso_cobertura_estoque` é keyed por `(produto_id uuid, galpao_id)` com `disponivel_total, giro_diario, dias_cobertura, lead_time_medio, status_cobertura`.
- **Chave de junção:** os itens de compra têm `sku` (texto). `siso_produtos.sku` é UNIQUE → resolve pro `siso_produtos.id` (uuid WMS) → `siso_estoque.produto_id`. **Usar SKU como chave evita o legado `siso_pedido_itens.produto_id = tiny_produto_id`.**
- **Estoque vivo:** `siso_estoque.disponivel` (GENERATED = saldo − reservado), por `(produto_id, galpao_id, localizacao_id)`. Somar `disponivel` por produto = livre total do SKU.
- **Colunas relevantes em `siso_pedido_itens`:** `sku, quantidade_pedida, quantidade_pega, compra_status, compra_quantidade_solicitada, compra_quantidade_recebida`.
- **Tela:** `src/app/wms/compras/page.tsx` — interface `ComprarItem` (linha 47), helper `agingClass` (125), render da linha do SKU (~643-734).
- **Convenção de teste:** Vitest, `import { describe, it, expect } from "vitest";`, arquivo `*.test.ts` ao lado do source. Rodar: `npm test`.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/lib/compras-necessidade.ts` | Funções PURAS: `calcularNecessidadeLiquida` + `piorStatusCobertura` | **Criar** |
| `src/lib/compras-necessidade.test.ts` | Testes unitários das funções puras | **Criar** |
| `src/app/api/wms/compras/route.ts` | `fetchComprar`: reunir entradas vivas + giro, computar necessidade líquida | **Modificar** |
| `src/app/wms/compras/page.tsx` | Mostrar quebra (precisa/livre/a caminho) + chip de giro/cobertura | **Modificar** |
| `docs/api-reference-complete.md` | Atualizar shape de resposta do `GET /api/wms/compras?tab=comprar` | **Modificar** |

---

### Task 1: Função pura `calcularNecessidadeLiquida`

**Files:**
- Create: `src/lib/compras-necessidade.ts`
- Test: `src/lib/compras-necessidade.test.ts`

A fórmula líquida é `max(0, demandaAberta − estoqueLivre − emTransito)`. O cuidado de corretude **não está na fórmula**, está no que alimenta `demandaAberta` (Task 2): tem que incluir os pedidos que já estão em `comprado`, senão subtrair o em-trânsito sub-compra. Aqui só testamos a fórmula e os clamps.

- [ ] **Step 1: Escrever o teste que falha**

Create `src/lib/compras-necessidade.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { calcularNecessidadeLiquida } from "./compras-necessidade";

describe("calcularNecessidadeLiquida", () => {
  it("déficit simples: precisa 5, tem 2 livre, nada a caminho → comprar 3", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 2, emTransito: 0 });
    expect(r.necessidadeLiquida).toBe(3);
  });

  it("estoque livre cai de 2 pra 1 (pedido de 1un consumiu) → necessidade sobe pra 4", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 1, emTransito: 0 });
    expect(r.necessidadeLiquida).toBe(4);
  });

  it("já comprou 3 e nada foi consumido (livre 2) → necessidade 0", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 2, emTransito: 3 });
    expect(r.necessidadeLiquida).toBe(0);
  });

  it("já comprou 3 mas 1 livre foi consumido → necessidade 1 reaparece", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 1, emTransito: 3 });
    expect(r.necessidadeLiquida).toBe(1);
  });

  it("dois pedidos (8) com 3 já a caminho, 0 livre → comprar 5 (não sub-compra)", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 8, estoqueLivre: 0, emTransito: 3 });
    expect(r.necessidadeLiquida).toBe(5);
  });

  it("clampa em 0 quando há excesso (livre+trânsito > demanda)", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 2, emTransito: 5 });
    expect(r.necessidadeLiquida).toBe(0);
  });

  it("over-receive (emTransito negativo) é tratado como 0, não aumenta a necessidade", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 0, emTransito: -2 });
    expect(r.necessidadeLiquida).toBe(5);
  });

  it("devolve a quebra usada (transparência pro comprador)", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 1, emTransito: 0 });
    expect(r).toEqual({ demandaAberta: 5, estoqueLivre: 1, emTransito: 0, necessidadeLiquida: 4 });
  });
});
```

- [ ] **Step 2: Rodar o teste pra confirmar que falha**

Run: `npm test -- compras-necessidade`
Expected: FAIL — "Failed to resolve import './compras-necessidade'" (módulo ainda não existe).

- [ ] **Step 3: Implementar a função pura**

Create `src/lib/compras-necessidade.ts`:

```ts
import type { StatusCobertura } from "@/lib/wms/cobertura";

export interface NecessidadeSkuInput {
  /** Σ(quantidade_pedida − quantidade_pega) dos pedidos que AINDA precisam do SKU
   *  (em `aguardando_compra` E em `comprado` — incluir os comprados evita sub-compra). */
  demandaAberta: number;
  /** Σ siso_estoque.disponivel (AO VIVO) do produto do SKU, somado entre galpões. */
  estoqueLivre: number;
  /** Σ max(0, solicitada − recebida) dos itens em `comprado` (mercadoria a caminho). */
  emTransito: number;
}

export interface NecessidadeSkuResult extends NecessidadeSkuInput {
  /** Quanto ainda falta comprar AGORA = max(0, demanda − livre − em-trânsito). */
  necessidadeLiquida: number;
}

export function calcularNecessidadeLiquida(input: NecessidadeSkuInput): NecessidadeSkuResult {
  const demandaAberta = Math.max(0, input.demandaAberta);
  const estoqueLivre = Math.max(0, input.estoqueLivre);
  const emTransito = Math.max(0, input.emTransito);
  const necessidadeLiquida = Math.max(0, demandaAberta - estoqueLivre - emTransito);
  return { demandaAberta, estoqueLivre, emTransito, necessidadeLiquida };
}

const SEVERIDADE: Record<StatusCobertura, number> = {
  critico: 4,
  lead_time_risco: 3,
  atencao: 2,
  ok: 1,
  sem_giro: 0,
};

/** Retorna o status MAIS severo entre dois (usado pra agregar cobertura entre galpões). */
export function piorStatusCobertura(a: StatusCobertura, b: StatusCobertura): StatusCobertura {
  return SEVERIDADE[a] >= SEVERIDADE[b] ? a : b;
}
```

- [ ] **Step 4: Rodar o teste pra confirmar que passa**

Run: `npm test -- compras-necessidade`
Expected: PASS — 8 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/compras-necessidade.ts src/lib/compras-necessidade.test.ts
git commit -m "feat(compras): função pura de necessidade líquida viva (déficit − livre − em-trânsito)"
```

---

### Task 2: Necessidade líquida viva na listagem de compras

**Files:**
- Modify: `src/app/api/wms/compras/route.ts` (imports, `RawItem`, `ComprarSkuEntry`, `fetchComprar`)

Reúne as 3 entradas por SKU e troca o `quantidade_necessaria` congelado pelo número vivo. **`demandaAberta` inclui itens `comprado`** (corretude anti-sub-compra do teste do Task 1).

- [ ] **Step 1: Adicionar imports**

Modify `src/app/api/wms/compras/route.ts:5-11` (bloco de imports). Trocar:

```ts
import {
  COMPRA_EXCEPTION_STATUSES,
  getAgingDays,
  getCompraQuantidadeSolicitada,
} from "@/lib/compras-utils";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { userCan } from "@/lib/permissions";
```

por:

```ts
import {
  COMPRA_EXCEPTION_STATUSES,
  getAgingDays,
  getCompraQuantidadeRestante,
  getCompraQuantidadeSolicitada,
} from "@/lib/compras-utils";
import { calcularNecessidadeLiquida } from "@/lib/compras-necessidade";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { userCan } from "@/lib/permissions";
```

- [ ] **Step 2: Estender os tipos `RawItem` e `ComprarSkuEntry`**

Modify `ComprarSkuEntry` (linhas 24-31). Trocar:

```ts
interface ComprarSkuEntry {
  sku: string;
  descricao: string;
  imagem_url: string | null;
  quantidade_necessaria: number;
  aging_dias: number;
  pedidos: PedidoRef[];
}
```

por:

```ts
interface ComprarSkuEntry {
  sku: string;
  descricao: string;
  imagem_url: string | null;
  /** Número VIVO: max(0, demanda_aberta − estoque_livre − em_transito). */
  quantidade_necessaria: number;
  // Quebra pra transparência do comprador (PR-necessidade-viva 2026-05-29):
  demanda_aberta: number;
  estoque_livre: number;
  em_transito: number;
  aging_dias: number;
  pedidos: PedidoRef[];
}
```

Modify `RawItem` (linhas 87-106) — adicionar `quantidade_pega` logo após `quantidade_pedida`:

```ts
  quantidade_pedida: number;
  quantidade_pega: number | null;
```

- [ ] **Step 3: Adicionar a função de carga de contexto vivo**

Modify `src/app/api/wms/compras/route.ts` — inserir esta função imediatamente ANTES de `async function fetchComprar(` (antes da linha 222):

```ts
// ─── Contexto vivo por SKU (necessidade líquida) ──────────────────────────────

interface ContextoSku {
  demandaComprado: number; // Σ(pedida − pega) dos itens já 'comprado' (ainda precisam do SKU)
  emTransito: number; // Σ max(0, solicitada − recebida) dos itens 'comprado'
  estoqueLivre: number; // Σ siso_estoque.disponivel (ao vivo) do produto
}

/**
 * Carrega, por SKU, os números VIVOS usados pra calcular a necessidade líquida:
 * demanda dos pedidos já comprados (ainda não recebidos), o que está em trânsito,
 * e o estoque livre atual lido direto de siso_estoque (não a MV de cobertura,
 * que é defasada). Chave = sku (UNIQUE em siso_produtos), evitando o legado
 * produto_id=tiny_produto_id em siso_pedido_itens.
 */
async function carregarContextoNecessidade(
  supabase: SupabaseClient,
  skus: string[],
): Promise<Map<string, ContextoSku>> {
  const ctx = new Map<string, ContextoSku>();
  for (const sku of skus) {
    ctx.set(sku, { demandaComprado: 0, emTransito: 0, estoqueLivre: 0 });
  }
  if (skus.length === 0) return ctx;

  // 1) Itens já COMPRADOS (a caminho): contam como demanda E como em-trânsito.
  const { data: comprados } = await supabase
    .from("siso_pedido_itens")
    .select(
      "sku, quantidade_pedida, quantidade_pega, compra_quantidade_solicitada, compra_quantidade_recebida, compra_status",
    )
    .eq("compra_status", "comprado")
    .in("sku", skus);

  for (const it of comprados ?? []) {
    const c = ctx.get(it.sku as string);
    if (!c) continue;
    const residual = Math.max(
      0,
      Number(it.quantidade_pedida ?? 0) - Number(it.quantidade_pega ?? 0),
    );
    c.demandaComprado += residual;
    c.emTransito += Math.max(0, getCompraQuantidadeRestante(it));
  }

  // 2) Estoque livre AO VIVO por SKU: sku → siso_produtos.id → Σ siso_estoque.disponivel.
  const { data: produtos } = await supabase
    .from("siso_produtos")
    .select("id, sku")
    .in("sku", skus);

  const skuPorUuid = new Map<string, string>();
  const uuids: string[] = [];
  for (const p of produtos ?? []) {
    skuPorUuid.set(p.id as string, p.sku as string);
    uuids.push(p.id as string);
  }

  if (uuids.length > 0) {
    const { data: saldos } = await supabase
      .from("siso_estoque")
      .select("produto_id, disponivel")
      .in("produto_id", uuids);

    for (const s of saldos ?? []) {
      const sku = skuPorUuid.get(s.produto_id as string);
      if (!sku) continue;
      const c = ctx.get(sku);
      if (c) c.estoqueLivre += Number(s.disponivel ?? 0);
    }
  }

  return ctx;
}
```

- [ ] **Step 4: Reescrever o miolo de `fetchComprar`**

Modify `fetchComprar`. Adicionar `quantidade_pega` no SELECT (linha 226):

```ts
    .select(
      "id, sku, descricao, quantidade_pedida, quantidade_pega, compra_status, compra_quantidade_solicitada, compra_solicitada_em, fornecedor_oc, imagem_url, pedido_id, siso_pedidos(numero, cliente_nome, criado_em)",
    )
```

Logo após `const galpaoByNome = await loadGalpaoMap(supabase);` (linha 234), adicionar os acumuladores de demanda em aberto e o set de SKUs:

```ts
  // Demanda residual dos itens AINDA em aguardando_compra (pedida − pega), por SKU.
  const demandaAgPorSku = new Map<string, number>();
  const todosSkus = new Set<string>();
```

Dentro do loop `for (const item of rawItems)`, logo após `const itemAging = getAgingDays(agingBase);` (linha 252), acumular:

```ts
    todosSkus.add(item.sku);
    const residualAg = Math.max(
      0,
      Number(item.quantidade_pedida ?? 0) - Number(item.quantidade_pega ?? 0),
    );
    demandaAgPorSku.set(item.sku, (demandaAgPorSku.get(item.sku) ?? 0) + residualAg);
```

Ainda dentro do loop, no objeto literal do `entry` (linhas 277-284), adicionar os 3 campos de quebra com 0 inicial:

```ts
        entry: {
          sku: item.sku,
          descricao: item.descricao,
          imagem_url: item.imagem_url,
          quantidade_necessaria: 0,
          demanda_aberta: 0,
          estoque_livre: 0,
          em_transito: 0,
          aging_dias: 0,
          pedidos: [],
        },
```

Logo APÓS o fim do loop `for (const item of rawItems)` e ANTES de `const result: FornecedorComprarGroup[] = [];` (linha 296), carregar o contexto vivo:

```ts
  const ctx = await carregarContextoNecessidade(supabase, [...todosSkus]);
```

No loop final, dentro de `for (const [, { entry }] of group.skuMap)` (linhas 301-304), trocar:

```ts
    for (const [, { entry }] of group.skuMap) {
      entry.pedidos.sort((a, b) => b.aging_dias - a.aging_dias);
      itens.push(entry);
    }
```

por:

```ts
    for (const [, { entry }] of group.skuMap) {
      entry.pedidos.sort((a, b) => b.aging_dias - a.aging_dias);
      const c = ctx.get(entry.sku);
      const demandaAberta =
        (demandaAgPorSku.get(entry.sku) ?? 0) + (c?.demandaComprado ?? 0);
      const res = calcularNecessidadeLiquida({
        demandaAberta,
        estoqueLivre: c?.estoqueLivre ?? 0,
        emTransito: c?.emTransito ?? 0,
      });
      entry.quantidade_necessaria = res.necessidadeLiquida;
      entry.demanda_aberta = res.demandaAberta;
      entry.estoque_livre = res.estoqueLivre;
      entry.em_transito = res.emTransito;
      itens.push(entry);
    }
```

> **Nota de comportamento (documentar no commit):** `quantidade_necessaria` passa a poder ser **0** (quando o estoque livre + em-trânsito já cobrem a demanda). O SKU continua aparecendo na lista enquanto tiver item em `aguardando_compra`; o "0 a comprar" é sinal pro comprador de que aquilo já está coberto. Liberar o pedido de volta pra separação é fluxo separado (fora deste plano). SKUs que ficaram SÓ em `comprado` não aparecem nesta tab (limitação conhecida — não há linha `aguardando_compra` pra ancorar).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS — sem erros de tipo (os campos novos de `ComprarSkuEntry` estão todos preenchidos; `getCompraQuantidadeRestante` aceita o shape do item `comprado`).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/wms/compras/route.ts
git commit -m "feat(compras): necessidade de compra viva por SKU (demanda − livre − em-trânsito)"
```

---

### Task 3: Anexar giro/cobertura à listagem de compras

**Files:**
- Modify: `src/app/api/wms/compras/route.ts` (`ComprarSkuEntry`, `ContextoSku`, `carregarContextoNecessidade`, loop final, import)

Reaproveita os `uuids` já resolvidos no Task 2 pra ler a MV `siso_cobertura_estoque` e dar ao comprador a âncora de giro **dentro da tela**.

- [ ] **Step 1: Importar o helper de severidade e o tipo de status**

Modify o import de `compras-necessidade` (criado no Task 2) e adicionar o tipo de cobertura. Trocar:

```ts
import { calcularNecessidadeLiquida } from "@/lib/compras-necessidade";
```

por:

```ts
import { calcularNecessidadeLiquida, piorStatusCobertura } from "@/lib/compras-necessidade";
import type { StatusCobertura } from "@/lib/wms/cobertura";
```

- [ ] **Step 2: Estender `ComprarSkuEntry` com os campos de giro/cobertura**

Modify `ComprarSkuEntry` — adicionar após `em_transito: number;`:

```ts
  giro_diario: number;
  dias_cobertura: number | null;
  status_cobertura: StatusCobertura;
  lead_time_medio: number | null;
```

- [ ] **Step 3: Estender `ContextoSku` e a carga de contexto**

Modify a interface `ContextoSku` (criada no Task 2) — adicionar:

```ts
interface ContextoSku {
  demandaComprado: number;
  emTransito: number;
  estoqueLivre: number;
  giroDiario: number;
  statusCobertura: StatusCobertura;
  leadTimeMedio: number | null;
}
```

Modify a inicialização dentro de `carregarContextoNecessidade` (o `ctx.set` do início). Trocar:

```ts
    ctx.set(sku, { demandaComprado: 0, emTransito: 0, estoqueLivre: 0 });
```

por:

```ts
    ctx.set(sku, {
      demandaComprado: 0,
      emTransito: 0,
      estoqueLivre: 0,
      giroDiario: 0,
      statusCobertura: "sem_giro",
      leadTimeMedio: null,
    });
```

Modify `carregarContextoNecessidade` — adicionar, logo ANTES do `return ctx;`, a leitura da MV reusando `uuids`/`skuPorUuid`:

```ts
  // 3) Giro/cobertura da MV (defasada, mas giro muda devagar — ok pra âncora).
  if (uuids.length > 0) {
    const { data: cob } = await supabase
      .from("siso_cobertura_estoque")
      .select("produto_id, giro_diario, lead_time_medio, status_cobertura")
      .in("produto_id", uuids);

    for (const r of cob ?? []) {
      const sku = skuPorUuid.get(r.produto_id as string);
      if (!sku) continue;
      const c = ctx.get(sku);
      if (!c) continue;
      c.giroDiario += Number(r.giro_diario ?? 0);
      c.statusCobertura = piorStatusCobertura(
        c.statusCobertura,
        (r.status_cobertura ?? "sem_giro") as StatusCobertura,
      );
      if (r.lead_time_medio != null) {
        c.leadTimeMedio = Math.max(c.leadTimeMedio ?? 0, Number(r.lead_time_medio));
      }
    }
  }
```

- [ ] **Step 4: Preencher os campos no loop final de `fetchComprar`**

Modify o bloco do loop final editado no Task 2 — adicionar, logo após `entry.em_transito = res.emTransito;`:

```ts
      entry.giro_diario = c?.giroDiario ?? 0;
      entry.dias_cobertura =
        c && c.giroDiario > 0 ? Math.round(c.estoqueLivre / c.giroDiario) : null;
      entry.status_cobertura = c?.statusCobertura ?? "sem_giro";
      entry.lead_time_medio = c?.leadTimeMedio ?? null;
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS — sem erros (todos os campos novos de `ComprarSkuEntry` preenchidos).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/wms/compras/route.ts
git commit -m "feat(compras): anexa giro/cobertura por SKU na tela de compra (âncora de decisão)"
```

---

### Task 4: Mostrar quebra viva + giro/cobertura na tela

**Files:**
- Modify: `src/app/wms/compras/page.tsx` (`ComprarItem`, helper de cor, render da linha do SKU)

- [ ] **Step 1: Estender a interface `ComprarItem`**

Modify `src/app/wms/compras/page.tsx:47-54`. Trocar:

```ts
interface ComprarItem {
  sku: string;
  descricao: string;
  imagem_url: string | null;
  quantidade_necessaria: number;
  aging_dias: number;
  pedidos: PedidoVinc[];
}
```

por:

```ts
type StatusCobertura = "critico" | "atencao" | "ok" | "sem_giro" | "lead_time_risco";

interface ComprarItem {
  sku: string;
  descricao: string;
  imagem_url: string | null;
  quantidade_necessaria: number;
  demanda_aberta: number;
  estoque_livre: number;
  em_transito: number;
  giro_diario: number;
  dias_cobertura: number | null;
  status_cobertura: StatusCobertura;
  lead_time_medio: number | null;
  aging_dias: number;
  pedidos: PedidoVinc[];
}
```

- [ ] **Step 2: Adicionar helper de cor de cobertura**

Modify `src/app/wms/compras/page.tsx` — logo após a função `agingClass` (linha 129), adicionar:

```ts
function coberturaLabel(s: StatusCobertura): { txt: string; color: string } {
  switch (s) {
    case "critico":
      return { txt: "crítico", color: "#dc2626" };
    case "lead_time_risco":
      return { txt: "risco lead time", color: "#d97706" };
    case "atencao":
      return { txt: "atenção", color: "#d97706" };
    case "ok":
      return { txt: "ok", color: "#16a34a" };
    default:
      return { txt: "sem giro", color: "#71717a" };
  }
}
```

- [ ] **Step 3: Renderizar a quebra + chip de giro**

Modify `src/app/wms/compras/page.tsx` — dentro do render da linha do SKU, logo APÓS o bloco `<div className="wms-pcard-item-desc">{item.descricao}</div>` (fecha na linha 722), e ANTES do `<div className="wms-td-mute" ...>` dos pedidos (linha 723), inserir:

```tsx
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 8,
                              alignItems: "center",
                              fontSize: 11,
                              marginTop: 3,
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>
                              precisa {item.quantidade_necessaria}
                            </span>
                            <span className="wms-td-mute">
                              demanda {item.demanda_aberta} · livre {item.estoque_livre} · a
                              caminho {item.em_transito}
                            </span>
                            {item.giro_diario > 0 ? (
                              <span
                                style={{ color: coberturaLabel(item.status_cobertura).color }}
                              >
                                gira {item.giro_diario.toFixed(1)}/d
                                {item.dias_cobertura != null
                                  ? ` · ${item.dias_cobertura}d cob`
                                  : ""}{" "}
                                · {coberturaLabel(item.status_cobertura).txt}
                              </span>
                            ) : (
                              <span className="wms-td-mute">sem giro</span>
                            )}
                          </div>
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS — `ComprarItem` agora bate com o shape retornado pela API.

- [ ] **Step 5: Verificação visual (dev server)**

Run: `npm run dev` e abrir `http://localhost:3000/wms/compras` (login Eryk / 1234), aba "Comprar", expandir um fornecedor.
Expected: cada SKU mostra `precisa N`, a linha `demanda X · livre Y · a caminho Z`, e (se houver giro) `gira N/d · Wd cob · status` colorido. O número "precisa N" deve bater com `demanda − livre − a caminho` (clampado em 0).

- [ ] **Step 6: Commit**

```bash
git add src/app/wms/compras/page.tsx
git commit -m "feat(compras): mostra quebra viva (precisa/livre/a caminho) + giro/cobertura por SKU"
```

---

### Task 5: Verificação fim-a-fim + docs

**Files:**
- Modify: `docs/api-reference-complete.md` (shape de resposta de `GET /api/wms/compras?tab=comprar`)

- [ ] **Step 1: Rodar a suite unitária inteira**

Run: `npm test`
Expected: PASS — incluindo `compras-necessidade.test.ts` (8 testes), sem regressão nos demais.

- [ ] **Step 2: Sanidade dos números num SKU real (staging)**

Via Supabase MCP no projeto `ehbxpbeijofxtsbezwxd`, escolher 1 SKU que esteja em `aguardando_compra` e conferir manualmente:
- `demanda_aberta` = Σ(`quantidade_pedida` − `quantidade_pega`) dos itens desse SKU em `aguardando_compra` + `comprado`.
- `estoque_livre` = Σ `disponivel` em `siso_estoque` (via `siso_produtos.id` do SKU).
- `em_transito` = Σ max(0, `compra_quantidade_solicitada` − `compra_quantidade_recebida`) dos itens `comprado`.
- `quantidade_necessaria` = max(0, demanda − livre − em-trânsito).

Expected: o valor exibido na tela bate com o cálculo manual.

- [ ] **Step 3: Atualizar a doc da API**

Modify `docs/api-reference-complete.md` — na entrada de `GET /api/wms/compras?tab=comprar`, atualizar o shape de cada item de `itens[]` pra incluir os campos novos:

```
quantidade_necessaria  // VIVO: max(0, demanda_aberta − estoque_livre − em_transito)
demanda_aberta         // Σ(pedida − pega) dos pedidos em aguardando_compra + comprado
estoque_livre          // Σ siso_estoque.disponivel ao vivo do SKU
em_transito            // Σ max(0, solicitada − recebida) dos itens 'comprado'
giro_diario            // giro 30d agregado (MV siso_cobertura_estoque)
dias_cobertura         // estoque_livre / giro_diario (null se giro=0)
status_cobertura       // pior status entre galpões: critico|lead_time_risco|atencao|ok|sem_giro
lead_time_medio        // maior lead time entre galpões (dias) ou null
```

Acrescentar 1 linha na descrição do endpoint: "A `quantidade_necessaria` é recalculada na leitura (necessidade líquida viva), não um valor congelado."

- [ ] **Step 4: Commit**

```bash
git add docs/api-reference-complete.md
git commit -m "docs(compras): documenta necessidade viva + campos de giro/cobertura na listagem"
```

---

## Self-Review

**Spec coverage (vs decisão de negócio firmada 2026-05-29):**
- "Necessidade viva por SKU, recalculada na leitura" → Task 1 (fórmula) + Task 2 (recálculo a cada GET). ✅
- "Descontar em-trânsito (sem compra dupla)" → Task 2 (`emTransito` + demanda incluindo `comprado` pra não sub-comprar). ✅
- "Comprar só o déficit" → preservado (a necessidade É o déficit líquido; nada de comprar a qty cheia). ✅
- "Nunca travar parcial" → regra de reserva **não tocada** (decisão: parcial já fica livre; cobertura total reserva e é neutro pro SLA). ✅
- "Comprador ancorado em giro + aging" → aging já existia; Task 3 + Task 4 trazem giro/cobertura pra dentro da tela. ✅

**Placeholder scan:** sem TODO/"add error handling"/"similar to Task N" — todos os steps têm código real e comandos com expected output. ✅

**Type consistency:** `calcularNecessidadeLiquida` (Task 1) ↔ chamada no loop final (Task 2); `NecessidadeSkuInput.{demandaAberta,estoqueLivre,emTransito}` batem; `ContextoSku` ganha `giroDiario/statusCobertura/leadTimeMedio` (Task 3) consumidos no mesmo loop; `ComprarSkuEntry` (API) ↔ `ComprarItem` (tela) com os mesmos 7 campos novos + `StatusCobertura`; `piorStatusCobertura`/`StatusCobertura` importados onde usados. ✅

**Limitações conhecidas documentadas:** `quantidade_necessaria` pode ser 0 (coberto); SKU só em `comprado` não aparece na tab Comprar; `siso_cobertura_estoque` é defasada (giro), mas o estoque livre da necessidade vem AO VIVO de `siso_estoque`.
