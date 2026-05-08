# WMS 2 — Movimentações operacionais Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementa todas as operações manuais de estoque do WMS — entrada manual com putaway sugerido, transferências (inter-galpão e intra-galpão), ajuste manual, e lançamento retroativo com reconciliação. Após esse plano, o operador opera o estoque inteiro manualmente, **saneando o saldo** sem depender mais do Tiny pra isso.

**Architecture:** Cada operação é uma API route que orquestra 1+ chamadas a `inserirMovimentacao` (Plano 1) em transação atômica. UI segue padrão do SISO (`/wms/<operacao>` com formulário + scanner GTIN reutilizado da separação). Lançamento retroativo é fluxo de exceção exposto via modal a partir de qualquer fluxo onde saldo está zerado (em Plano 2 já implementamos a UI standalone; nos Planos 3+ outros fluxos invocam o mesmo endpoint).

**Tech Stack:** mesmo do Plano 1. Reuso de `scan-input.tsx` e `audio-feedback.ts` da separação atual.

**Spec de referência:** [docs/superpowers/specs/2026-05-07-wms-design.md](../specs/2026-05-07-wms-design.md) — §5.1, 5.5, 5.6, 5.11 + princípios 18-19.

**Pré-requisito:** Plano 1 (Foundation) concluído e em produção.

---

## File Structure

| Caminho | Responsabilidade |
|---|---|
| `src/lib/wms/putaway.ts` | Heurística de sugestão de localização |
| `src/lib/wms/putaway.test.ts` | Tests da heurística |
| `src/lib/wms/movimentacoes.ts` | Helpers de orquestração: receber, transferir, replenish, ajustar, retroativo |
| `src/lib/wms/movimentacoes.test.ts` | Tests de regras de negócio |
| `src/app/api/wms/receber/route.ts` | POST receber estoque (entrada manual) |
| `src/app/api/wms/transferir-galpao/route.ts` | POST transferência inter-galpão |
| `src/app/api/wms/replenishment/route.ts` | POST replenishment intra-galpão |
| `src/app/api/wms/ajuste/route.ts` | POST ajuste manual |
| `src/app/api/wms/lancamento-retroativo/route.ts` | POST lançamento retroativo + GET pendentes |
| `src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts` | POST reconciliar com mov posterior |
| `src/app/wms/receber/page.tsx` | Tela de recebimento |
| `src/app/wms/transferir/page.tsx` | Tela de transferência inter-galpão |
| `src/app/wms/replenishment/page.tsx` | Tela de replenishment intra-galpão |
| `src/app/wms/ajuste/page.tsx` | Tela de ajuste manual |
| `src/app/wms/retroativos/page.tsx` | Tela de pendências de reconciliação |
| `src/components/wms/scan-sku-input.tsx` | Input de scanner reutilizável |
| `src/components/wms/quadrupla-picker.tsx` | Seletor de empresa/galpão/localização |

---

### Task 1: Helper de sugestão de putaway

**Files:**
- Create: `src/lib/wms/putaway.ts`
- Create: `src/lib/wms/putaway.test.ts`

- [ ] **Step 1: Test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { sugerirLocalizacaoPutaway } from "./putaway";

const mockSb = (rows: { localizacao_id: string; saldo: number; tipo: string }[]) => ({
  from: () => ({
    select: () => ({
      match: () => ({
        order: () => Promise.resolve({ data: rows, error: null }),
      }),
    }),
  }),
});

describe("sugerirLocalizacaoPutaway", () => {
  it("retorna localização com saldo do mesmo SKU se existir", async () => {
    const ctx = { produto_id: "p1", empresa_id: "e1", galpao_id: "g1" };
    const sb: any = mockSb([{ localizacao_id: "loc-A12", saldo: 50, tipo: "picking" }]);
    const r = await sugerirLocalizacaoPutaway(sb, ctx);
    expect(r.localizacao_id).toBe("loc-A12");
    expect(r.razao).toMatch(/SKU já está/i);
  });

  it("retorna localização recebimento default quando galpão não tem nada do SKU", async () => {
    const sb: any = {
      from: (table: string) => {
        if (table === "siso_estoque") return { select: () => ({ match: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) };
        if (table === "siso_localizacoes") return {
          select: () => ({
            match: () => ({ limit: () => Promise.resolve({ data: [{ id: "loc-recv", codigo: "RECEBIMENTO" }], error: null }) }),
          }),
        };
        return {} as any;
      },
    };
    const r = await sugerirLocalizacaoPutaway(sb, { produto_id: "p2", empresa_id: "e1", galpao_id: "g1" });
    expect(r.localizacao_id).toBe("loc-recv");
    expect(r.razao).toMatch(/recebimento/i);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npm test -- putaway
```
Expected: FAIL — `sugerirLocalizacaoPutaway` not exported.

- [ ] **Step 3: Implement**

```typescript
// src/lib/wms/putaway.ts
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PutawayContext {
  produto_id: string;
  empresa_id: string;
  galpao_id: string;
}

export interface PutawaySugestao {
  localizacao_id: string;
  codigo?: string;
  razao: string;
}

/**
 * Heurística:
 * 1. Se SKU já tem saldo nesse galpão+empresa, sugere essa localização (preferindo picking sobre overstock)
 * 2. Senão, retorna localização tipo='recebimento' do galpão (criando se não existe é responsabilidade do CRUD)
 * 3. Fallback: DEFAULT-PICKING
 */
export async function sugerirLocalizacaoPutaway(
  sb: SupabaseClient,
  ctx: PutawayContext,
): Promise<PutawaySugestao> {
  // 1. Linha de estoque existente
  const { data: existentes } = await sb
    .from("siso_estoque")
    .select("localizacao_id, saldo, localizacao:siso_localizacoes(codigo, tipo)")
    .match({ produto_id: ctx.produto_id, empresa_dona_id: ctx.empresa_id, galpao_id: ctx.galpao_id })
    .order("saldo", { ascending: false });

  const candidato = (existentes ?? []).find((e: any) => e.localizacao?.tipo === "picking")
    ?? (existentes ?? [])[0];
  if (candidato) {
    return {
      localizacao_id: candidato.localizacao_id,
      codigo: (candidato as any).localizacao?.codigo,
      razao: "SKU já está nessa localização",
    };
  }

  // 2. Recebimento do galpão
  const { data: recebs } = await sb
    .from("siso_localizacoes")
    .select("id, codigo")
    .match({ galpao_id: ctx.galpao_id, tipo: "recebimento", ativo: true })
    .limit(1);
  if (recebs && recebs.length > 0) {
    return { localizacao_id: recebs[0].id, codigo: recebs[0].codigo, razao: "área de recebimento do galpão" };
  }

  // 3. Default
  const { data: def } = await sb
    .from("siso_localizacoes")
    .select("id, codigo")
    .match({ galpao_id: ctx.galpao_id, codigo: "DEFAULT-PICKING" })
    .limit(1);
  if (def && def.length > 0) {
    return { localizacao_id: def[0].id, codigo: def[0].codigo, razao: "localização padrão (DEFAULT-PICKING)" };
  }

  throw new Error("nenhuma localização disponível no galpão");
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm test -- putaway
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/putaway.ts src/lib/wms/putaway.test.ts
git commit -m "feat(wms): heurística de sugestão automática de putaway"
```

---

### Task 2: Helper de movimentações operacionais

**Files:**
- Create: `src/lib/wms/movimentacoes.ts`
- Create: `src/lib/wms/movimentacoes.test.ts`

- [ ] **Step 1: Test (recebimento + transferência)**

```typescript
import { describe, it, expect, vi } from "vitest";
import { validarTransferenciaIntraGalpao } from "./movimentacoes";

describe("validarTransferenciaIntraGalpao", () => {
  it("rejeita quando origem == destino", () => {
    expect(() => validarTransferenciaIntraGalpao({ localizacao_origem_id: "X", localizacao_destino_id: "X" }))
      .toThrow(/origem.*destino/i);
  });

  it("aceita origem != destino", () => {
    expect(() => validarTransferenciaIntraGalpao({ localizacao_origem_id: "A", localizacao_destino_id: "B" }))
      .not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement**

```typescript
// src/lib/wms/movimentacoes.ts
import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import type { Quadrupla } from "./types";
import { logger } from "@/lib/logger";

interface ItemRecebimento {
  produto_id: string;
  qty: number;
  custo_unitario?: number;
  localizacao_id: string;
}

export interface ReceberInput {
  empresa_dona_id: string;
  galpao_id: string;
  itens: ItemRecebimento[];
  nf_referencia?: string;
  usuario_id: string;
}

export async function receberEstoque(input: ReceberInput) {
  for (const item of input.itens) {
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_dona_id,
        galpao_id: input.galpao_id,
        localizacao_id: item.localizacao_id,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: "compra_manual",
      origem_detalhes: { nf_referencia: input.nf_referencia },
      custo_unitario: item.custo_unitario,
      usuario_id: input.usuario_id,
      observacoes: input.nf_referencia ? `recebimento NF ${input.nf_referencia}` : "recebimento sem NF",
    });
    // recalcula custo_medio (média ponderada)
    if (item.custo_unitario !== undefined) {
      await recalcularCustoMedio({
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_dona_id,
        galpao_id: input.galpao_id,
        localizacao_id: item.localizacao_id,
      }, item.qty, item.custo_unitario);
    }
  }
}

async function recalcularCustoMedio(
  q: Quadrupla,
  qtyEntrada: number,
  custoNovo: number,
) {
  const sb = createServiceClient();
  const { data: e } = await sb.from("siso_estoque").select("saldo, custo_medio").match(q).single();
  if (!e) return;
  const saldoAnterior = Number(e.saldo) - qtyEntrada;
  if (saldoAnterior < 0) return;
  const custoAnterior = Number(e.custo_medio);
  const novoCusto = saldoAnterior > 0
    ? (saldoAnterior * custoAnterior + qtyEntrada * custoNovo) / (saldoAnterior + qtyEntrada)
    : custoNovo;
  await sb.from("siso_estoque").update({ custo_medio: novoCusto }).match(q);
}

export interface TransferirGalpaoInput {
  empresa_id: string;
  galpao_origem_id: string;
  localizacao_origem_id: string;
  galpao_destino_id: string;
  localizacao_destino_id: string;
  itens: { produto_id: string; qty: number }[];
  usuario_id: string;
  observacoes?: string;
}

export async function transferirInterGalpao(input: TransferirGalpaoInput) {
  if (input.galpao_origem_id === input.galpao_destino_id) {
    throw new Error("transferência inter-galpão exige galpões diferentes (use replenishment)");
  }
  const origem_id = crypto.randomUUID();
  for (const item of input.itens) {
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_origem_id,
        localizacao_id: input.localizacao_origem_id,
      },
      tipo: "S", qty: item.qty,
      origem_tipo: "transferencia_galpao",
      origem_id,
      usuario_id: input.usuario_id,
      observacoes: input.observacoes,
    });
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_destino_id,
        localizacao_id: input.localizacao_destino_id,
      },
      tipo: "E", qty: item.qty,
      origem_tipo: "transferencia_galpao",
      origem_id,
      usuario_id: input.usuario_id,
      observacoes: input.observacoes,
    });
  }
  return { origem_id };
}

export interface ReplenishmentInput {
  empresa_id: string;
  galpao_id: string;
  localizacao_origem_id: string;
  localizacao_destino_id: string;
  itens: { produto_id: string; qty: number }[];
  usuario_id: string;
}

export function validarTransferenciaIntraGalpao(input: { localizacao_origem_id: string; localizacao_destino_id: string }) {
  if (input.localizacao_origem_id === input.localizacao_destino_id) {
    throw new Error("origem e destino não podem ser a mesma localização");
  }
}

export async function replenishmentIntraGalpao(input: ReplenishmentInput) {
  validarTransferenciaIntraGalpao(input);
  const origem_id = crypto.randomUUID();
  for (const item of input.itens) {
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_id,
        localizacao_id: input.localizacao_origem_id,
      },
      tipo: "S", qty: item.qty,
      origem_tipo: "transferencia_localizacao",
      origem_id,
      usuario_id: input.usuario_id,
    });
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_id,
        localizacao_id: input.localizacao_destino_id,
      },
      tipo: "E", qty: item.qty,
      origem_tipo: "transferencia_localizacao",
      origem_id,
      usuario_id: input.usuario_id,
    });
  }
  return { origem_id };
}

export interface AjusteManualInput {
  quadrupla: Quadrupla;
  qty: number;
  motivo: string;
  direcao: "entrada" | "saida";
  usuario_id: string;
}

export async function ajustarEstoque(input: AjusteManualInput) {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do ajuste é obrigatório (≥3 caracteres)");
  }
  await inserirMovimentacao({
    quadrupla: input.quadrupla,
    tipo: input.direcao === "entrada" ? "E" : "S",
    qty: input.qty,
    origem_tipo: "ajuste_manual",
    origem_detalhes: { motivo: input.motivo, direcao: input.direcao },
    usuario_id: input.usuario_id,
    observacoes: input.motivo,
  });
}

export interface LancamentoRetroativoInput {
  quadrupla: Quadrupla;
  qty: number;
  fornecedor_id?: string;
  pedido_id?: string;
  motivo: string;
  usuario_id: string;
}

export async function lancarRetroativo(input: LancamentoRetroativoInput) {
  await inserirMovimentacao({
    quadrupla: input.quadrupla,
    tipo: "E",
    qty: input.qty,
    origem_tipo: "lancamento_retroativo",
    origem_id: input.pedido_id,
    origem_detalhes: { motivo: input.motivo, fornecedor_id: input.fornecedor_id },
    usuario_id: input.usuario_id,
    observacoes: `emergência: ${input.motivo}`,
  });
}

export async function listarRetroativosPendentes(): Promise<any[]> {
  const sb = createServiceClient();
  // Sem reconciliação registrada (mov de estorno apontando pra ela)
  const { data, error } = await sb
    .from("siso_movimentacoes")
    .select(`
      id, criado_em, quantidade, observacoes, origem_detalhes,
      produto:siso_produtos(sku, descricao),
      empresa:siso_empresas(nome),
      galpao:siso_galpoes(nome),
      localizacao:siso_localizacoes(codigo)
    `)
    .eq("origem_tipo", "lancamento_retroativo")
    .order("criado_em", { ascending: false })
    .limit(200);
  if (error) throw error;
  // Filtra os que não têm estorno
  const ids = (data ?? []).map(d => d.id);
  if (ids.length === 0) return [];
  const { data: estornos } = await sb
    .from("siso_movimentacoes")
    .select("estorno_de")
    .in("estorno_de", ids);
  const estornados = new Set((estornos ?? []).map(e => e.estorno_de));
  return (data ?? []).filter(d => !estornados.has(d.id));
}

export interface ReconciliarRetroativoInput {
  retroativo_mov_id: string;
  compra_mov_id: string;
  usuario_id: string;
}

export async function reconciliarRetroativo(input: ReconciliarRetroativoInput) {
  const sb = createServiceClient();
  const { data: retro, error } = await sb.from("siso_movimentacoes").select("*").eq("id", input.retroativo_mov_id).single();
  if (error || !retro) throw new Error("lançamento retroativo não encontrado");
  if (retro.origem_tipo !== "lancamento_retroativo") {
    throw new Error("mov não é um lançamento retroativo");
  }
  // Insere estorno do retroativo (cancela contábil): saída qty
  await inserirMovimentacao({
    quadrupla: {
      produto_id: retro.produto_id,
      empresa_dona_id: retro.empresa_dona_id,
      galpao_id: retro.galpao_id,
      localizacao_id: retro.localizacao_id,
    },
    tipo: "S",
    qty: Number(retro.quantidade),
    origem_tipo: "estorno",
    estorno_de: retro.id,
    usuario_id: input.usuario_id,
    observacoes: `reconciliado com mov ${input.compra_mov_id}`,
  });
  logger.info("wms.movs", "lançamento retroativo reconciliado", { retro: retro.id, compra: input.compra_mov_id });
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm test -- movimentacoes
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/movimentacoes.ts src/lib/wms/movimentacoes.test.ts
git commit -m "feat(wms): helpers de movimentação operacional"
```

---

### Task 3: API receber estoque

**Files:**
- Create: `src/app/api/wms/receber/route.ts`

- [ ] **Step 1: Implement**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { receberEstoque } from "@/lib/wms/movimentacoes";
import { sugerirLocalizacaoPutaway } from "@/lib/wms/putaway";
import { createServiceClient } from "@/lib/supabase-server";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.empresa_dona_id || !body.galpao_id || !Array.isArray(body.itens)) {
    return NextResponse.json({ error: "campos obrigatórios faltando" }, { status: 400 });
  }
  try {
    await receberEstoque({ ...body, usuario_id: user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// GET: dado um produto, sugere localização
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const ctx = {
    produto_id: sp.get("produto_id")!,
    empresa_id: sp.get("empresa_id")!,
    galpao_id: sp.get("galpao_id")!,
  };
  if (!ctx.produto_id || !ctx.empresa_id || !ctx.galpao_id) {
    return NextResponse.json({ error: "produto_id, empresa_id, galpao_id obrigatórios" }, { status: 400 });
  }
  try {
    const sb = createServiceClient();
    const sugestao = await sugerirLocalizacaoPutaway(sb, ctx);
    return NextResponse.json(sugestao);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/wms/receber/
git commit -m "feat(wms): API de recebimento com sugestão automática de putaway"
```

---

### Task 4: APIs transferir / replenishment / ajuste

**Files:**
- Create: `src/app/api/wms/transferir-galpao/route.ts`
- Create: `src/app/api/wms/replenishment/route.ts`
- Create: `src/app/api/wms/ajuste/route.ts`

- [ ] **Step 1: Transferir inter-galpão**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { transferirInterGalpao } from "@/lib/wms/movimentacoes";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  try {
    const r = await transferirInterGalpao({ ...body, usuario_id: user.id });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

- [ ] **Step 2: Replenishment**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { replenishmentIntraGalpao } from "@/lib/wms/movimentacoes";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  try {
    const r = await replenishmentIntraGalpao({ ...body, usuario_id: user.id });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

- [ ] **Step 3: Ajuste**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { ajustarEstoque } from "@/lib/wms/movimentacoes";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  try {
    await ajustarEstoque({ ...body, usuario_id: user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/transferir-galpao/ src/app/api/wms/replenishment/ src/app/api/wms/ajuste/
git commit -m "feat(wms): APIs de transferência inter/intra-galpão e ajuste manual"
```

---

### Task 5: API lançamento retroativo + reconciliação

**Files:**
- Create: `src/app/api/wms/lancamento-retroativo/route.ts`
- Create: `src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts`

- [ ] **Step 1: Implement POST + GET**

```typescript
// src/app/api/wms/lancamento-retroativo/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { lancarRetroativo, listarRetroativosPendentes } from "@/lib/wms/movimentacoes";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.motivo || body.motivo.length < 3) {
    return NextResponse.json({ error: "motivo obrigatório" }, { status: 400 });
  }
  try {
    await lancarRetroativo({ ...body, usuario_id: user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const rows = await listarRetroativosPendentes();
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Reconciliar by id**

```typescript
// src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { reconciliarRetroativo } from "@/lib/wms/movimentacoes";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  if (!body.compra_mov_id) {
    return NextResponse.json({ error: "compra_mov_id obrigatório" }, { status: 400 });
  }
  try {
    await reconciliarRetroativo({
      retroativo_mov_id: id,
      compra_mov_id: body.compra_mov_id,
      usuario_id: user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/lancamento-retroativo/
git commit -m "feat(wms): API de lançamento retroativo com reconciliação"
```

---

### Task 6: Componente seletor de quádrupla

**Files:**
- Create: `src/components/wms/quadrupla-picker.tsx`

- [ ] **Step 1: Component reutilizável**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";

interface Props {
  value: { empresa_id?: string; galpao_id?: string; localizacao_id?: string };
  onChange: (v: { empresa_id?: string; galpao_id?: string; localizacao_id?: string }) => void;
  showLocalizacao?: boolean;
  filtroTipoLocalizacao?: string;
}

export function QuadruplaPicker({ value, onChange, showLocalizacao = true, filtroTipoLocalizacao }: Props) {
  const { data: empresas } = useQuery({
    queryKey: ["empresas"],
    queryFn: async () => (await sisoFetch("/api/admin/galpoes")).json(),
  });

  const galpoes = empresas?.galpoes ?? [];
  const empresasAtivas = galpoes.flatMap((g: any) => g.empresas ?? []);
  const empresaSel = empresasAtivas.find((e: any) => e.id === value.empresa_id);
  const galpaoId = empresaSel?.galpao_id;

  const { data: locs } = useQuery({
    queryKey: ["wms-locs", galpaoId],
    queryFn: async () => galpaoId ? (await sisoFetch(`/api/wms/localizacoes?galpao_id=${galpaoId}`)).json() : { rows: [] },
    enabled: !!galpaoId && showLocalizacao,
  });

  const locsFiltradas = filtroTipoLocalizacao
    ? (locs?.rows ?? []).filter((l: any) => l.tipo === filtroTipoLocalizacao)
    : (locs?.rows ?? []);

  return (
    <div className="flex flex-col sm:flex-row gap-2">
      <select value={value.empresa_id ?? ""} onChange={e => onChange({ empresa_id: e.target.value || undefined, galpao_id: undefined, localizacao_id: undefined })}
        className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm">
        <option value="">— empresa —</option>
        {empresasAtivas.map((e: any) => (
          <option key={e.id} value={e.id}>{e.nome}</option>
        ))}
      </select>

      {showLocalizacao && galpaoId && (
        <select value={value.localizacao_id ?? ""} onChange={e => onChange({ ...value, galpao_id: galpaoId, localizacao_id: e.target.value || undefined })}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm">
          <option value="">— localização —</option>
          {locsFiltradas.map((l: any) => (
            <option key={l.id} value={l.id}>{l.codigo} ({l.tipo})</option>
          ))}
        </select>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/wms/quadrupla-picker.tsx
git commit -m "feat(wms): seletor reutilizável de empresa/galpão/localização"
```

---

### Task 7: Tela de receber estoque

**Files:**
- Create: `src/app/wms/receber/page.tsx`

- [ ] **Step 1: Page com adicionar item + sugestão de putaway**

```tsx
"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";
import { Plus, Trash2 } from "lucide-react";

interface Item {
  produto_id?: string;
  sku?: string;
  qty: number;
  custo_unitario?: number;
  localizacao_id?: string;
  localizacao_codigo?: string;
  putawayRazao?: string;
}

export default function ReceberPage() {
  const [base, setBase] = useState<{ empresa_id?: string; galpao_id?: string }>({});
  const [nf, setNf] = useState("");
  const [itens, setItens] = useState<Item[]>([]);

  // helper: ao mudar SKU, busca produto e sugere localização
  async function resolverProdutoESugestao(skuOuGtin: string, idx: number) {
    const r = await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(skuOuGtin)}&limit=1`);
    const json = await r.json();
    const p = json.rows?.[0];
    if (!p) { toast.error(`SKU não encontrado: ${skuOuGtin}`); return; }
    if (!base.empresa_id || !base.galpao_id) { toast.error("escolha empresa+galpão antes"); return; }

    const sug = await (await sisoFetch(`/api/wms/receber?produto_id=${p.id}&empresa_id=${base.empresa_id}&galpao_id=${base.galpao_id}`)).json();

    setItens(prev => prev.map((it, i) => i === idx ? {
      ...it, produto_id: p.id, sku: p.sku,
      localizacao_id: sug.localizacao_id, localizacao_codigo: sug.codigo, putawayRazao: sug.razao,
    } : it));
  }

  const submit = useMutation({
    mutationFn: async () => sisoFetch("/api/wms/receber", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        empresa_dona_id: base.empresa_id,
        galpao_id: base.galpao_id,
        nf_referencia: nf || undefined,
        itens: itens.map(i => ({
          produto_id: i.produto_id, qty: i.qty,
          custo_unitario: i.custo_unitario, localizacao_id: i.localizacao_id,
        })),
      }),
    }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: () => { toast.success("estoque recebido"); setItens([]); setNf(""); },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-lg font-medium">Receber estoque</h1>
      <QuadruplaPicker value={base} onChange={setBase} showLocalizacao={false} />
      <input value={nf} onChange={e => setNf(e.target.value)} placeholder="NF de referência (opcional)"
        className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent w-64" />

      <div className="space-y-1">
        {itens.map((it, idx) => (
          <div key={idx} className="flex gap-2 items-center p-2 rounded border border-zinc-200 dark:border-zinc-800">
            <input placeholder="bipe SKU/GTIN" defaultValue={it.sku ?? ""}
              onBlur={e => e.target.value && !it.produto_id && resolverProdutoESugestao(e.target.value, idx)}
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono text-sm flex-1" />
            <input type="number" min={1} value={it.qty} onChange={e => setItens(p => p.map((x, i) => i === idx ? { ...x, qty: Number(e.target.value) } : x))}
              className="w-20 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm" />
            <input type="number" step="0.01" placeholder="custo" value={it.custo_unitario ?? ""}
              onChange={e => setItens(p => p.map((x, i) => i === idx ? { ...x, custo_unitario: e.target.value ? Number(e.target.value) : undefined } : x))}
              className="w-24 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm" />
            {it.localizacao_codigo && (
              <span className="text-xs text-zinc-500">→ {it.localizacao_codigo} ({it.putawayRazao})</span>
            )}
            <button onClick={() => setItens(p => p.filter((_, i) => i !== idx))} className="p-1">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}

        <button onClick={() => setItens(p => [...p, { qty: 1 }])}
          className="flex items-center gap-1 text-sm px-3 py-1 rounded border border-dashed border-zinc-400">
          <Plus className="w-4 h-4" /> adicionar item
        </button>
      </div>

      <button onClick={() => submit.mutate()} disabled={!base.empresa_id || itens.length === 0 || submit.isPending}
        className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
        {submit.isPending ? "salvando..." : "registrar recebimento"}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/wms/receber/
git commit -m "feat(wms): tela de recebimento com sugestão automática de putaway"
```

---

### Task 8: Tela de transferência inter-galpão

**Files:**
- Create: `src/app/wms/transferir/page.tsx`

- [ ] **Step 1: Page com origem/destino + itens**

```tsx
"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";
import { ArrowRight, Plus, Trash2 } from "lucide-react";

interface Item { produto_id?: string; sku?: string; qty: number; }

export default function TransferirPage() {
  const [empresa_id, setEmpresa] = useState<string>();
  const [origem, setOrigem] = useState<{ galpao_id?: string; localizacao_id?: string }>({});
  const [destino, setDestino] = useState<{ galpao_id?: string; localizacao_id?: string }>({});
  const [itens, setItens] = useState<Item[]>([]);

  async function resolverSku(s: string, idx: number) {
    const json = await (await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`)).json();
    if (!json.rows?.[0]) { toast.error(`SKU não encontrado`); return; }
    setItens(p => p.map((x, i) => i === idx ? { ...x, produto_id: json.rows[0].id, sku: json.rows[0].sku } : x));
  }

  const submit = useMutation({
    mutationFn: async () => sisoFetch("/api/wms/transferir-galpao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        empresa_id,
        galpao_origem_id: origem.galpao_id,
        localizacao_origem_id: origem.localizacao_id,
        galpao_destino_id: destino.galpao_id,
        localizacao_destino_id: destino.localizacao_id,
        itens: itens.map(i => ({ produto_id: i.produto_id, qty: i.qty })),
      }),
    }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: () => { toast.success("transferência registrada"); setItens([]); },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-lg font-medium">Transferir entre galpões</h1>
      <QuadruplaPicker value={{ empresa_id, ...origem }} onChange={v => { setEmpresa(v.empresa_id); setOrigem({ galpao_id: v.galpao_id, localizacao_id: v.localizacao_id }); }} />
      <ArrowRight className="w-4 h-4 mx-auto" />
      <QuadruplaPicker value={{ empresa_id, ...destino }} onChange={v => { setEmpresa(v.empresa_id); setDestino({ galpao_id: v.galpao_id, localizacao_id: v.localizacao_id }); }} />

      <div className="space-y-1">
        {itens.map((it, idx) => (
          <div key={idx} className="flex gap-2 items-center p-2 rounded border border-zinc-200 dark:border-zinc-800">
            <input placeholder="SKU" defaultValue={it.sku ?? ""}
              onBlur={e => e.target.value && !it.produto_id && resolverSku(e.target.value, idx)}
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono text-sm flex-1" />
            <input type="number" min={1} value={it.qty} onChange={e => setItens(p => p.map((x, i) => i === idx ? { ...x, qty: Number(e.target.value) } : x))}
              className="w-20 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm" />
            <button onClick={() => setItens(p => p.filter((_, i) => i !== idx))} className="p-1">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button onClick={() => setItens(p => [...p, { qty: 1 }])} className="flex items-center gap-1 text-sm px-3 py-1 rounded border border-dashed border-zinc-400">
          <Plus className="w-4 h-4" /> adicionar
        </button>
      </div>

      <button onClick={() => submit.mutate()} disabled={!empresa_id || !origem.localizacao_id || !destino.localizacao_id || itens.length === 0 || submit.isPending}
        className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
        {submit.isPending ? "salvando..." : "registrar transferência"}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/wms/transferir/
git commit -m "feat(wms): tela de transferência inter-galpão"
```

---

### Task 9: Telas de replenishment + ajuste

**Files:**
- Create: `src/app/wms/replenishment/page.tsx`
- Create: `src/app/wms/ajuste/page.tsx`

- [ ] **Step 1: Replenishment**

Duplica padrão da Task 8 mas com galpão único — operador escolhe **um** galpão+empresa, depois **localização origem** e **localização destino**, dentro do mesmo galpão. Body do POST aponta pra `/api/wms/replenishment` com campos `localizacao_origem_id` e `localizacao_destino_id`.

```tsx
"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { ArrowDown, Plus, Trash2 } from "lucide-react";

interface Item { produto_id?: string; sku?: string; qty: number; }

export default function ReplenishmentPage() {
  const [empresa_id, setEmpresa] = useState<string>();
  const [galpao_id, setGalpao] = useState<string>();
  const [origem_loc, setOrigem] = useState<string>();
  const [destino_loc, setDestino] = useState<string>();
  const [itens, setItens] = useState<Item[]>([]);

  const { data: galpoes } = useQuery({ queryKey: ["galpoes"], queryFn: async () => (await sisoFetch("/api/admin/galpoes")).json() });
  const { data: locs } = useQuery({
    queryKey: ["wms-locs", galpao_id],
    queryFn: async () => galpao_id ? (await sisoFetch(`/api/wms/localizacoes?galpao_id=${galpao_id}`)).json() : { rows: [] },
    enabled: !!galpao_id,
  });

  const empresas = (galpoes?.galpoes ?? []).flatMap((g: any) => (g.empresas ?? []).map((e: any) => ({ ...e, galpao_id: g.id })));

  async function resolverSku(s: string, idx: number) {
    const json = await (await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`)).json();
    if (!json.rows?.[0]) { toast.error("SKU não encontrado"); return; }
    setItens(p => p.map((x, i) => i === idx ? { ...x, produto_id: json.rows[0].id, sku: json.rows[0].sku } : x));
  }

  const submit = useMutation({
    mutationFn: async () => sisoFetch("/api/wms/replenishment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        empresa_id, galpao_id, localizacao_origem_id: origem_loc, localizacao_destino_id: destino_loc,
        itens: itens.map(i => ({ produto_id: i.produto_id, qty: i.qty })),
      }),
    }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: () => { toast.success("replenishment ok"); setItens([]); },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-lg font-medium">Replenishment intra-galpão</h1>
      <div className="flex gap-2">
        <select value={empresa_id ?? ""} onChange={e => { const sel = empresas.find((x: any) => x.id === e.target.value); setEmpresa(sel?.id); setGalpao(sel?.galpao_id); setOrigem(undefined); setDestino(undefined); }}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm">
          <option value="">— empresa —</option>
          {empresas.map((e: any) => <option key={e.id} value={e.id}>{e.nome}</option>)}
        </select>
        <select value={origem_loc ?? ""} onChange={e => setOrigem(e.target.value)}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm">
          <option value="">— origem —</option>
          {locs?.rows?.map((l: any) => <option key={l.id} value={l.id}>{l.codigo} ({l.tipo})</option>)}
        </select>
        <ArrowDown className="w-4 h-4 self-center" />
        <select value={destino_loc ?? ""} onChange={e => setDestino(e.target.value)}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm">
          <option value="">— destino —</option>
          {locs?.rows?.filter((l: any) => l.id !== origem_loc).map((l: any) => <option key={l.id} value={l.id}>{l.codigo} ({l.tipo})</option>)}
        </select>
      </div>

      <div className="space-y-1">
        {itens.map((it, idx) => (
          <div key={idx} className="flex gap-2 items-center p-2 rounded border border-zinc-200 dark:border-zinc-800">
            <input placeholder="SKU" defaultValue={it.sku ?? ""}
              onBlur={e => e.target.value && !it.produto_id && resolverSku(e.target.value, idx)}
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono text-sm flex-1" />
            <input type="number" min={1} value={it.qty} onChange={e => setItens(p => p.map((x, i) => i === idx ? { ...x, qty: Number(e.target.value) } : x))}
              className="w-20 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm" />
            <button onClick={() => setItens(p => p.filter((_, i) => i !== idx))} className="p-1"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        <button onClick={() => setItens(p => [...p, { qty: 1 }])} className="flex items-center gap-1 text-sm px-3 py-1 rounded border border-dashed border-zinc-400">
          <Plus className="w-4 h-4" /> adicionar
        </button>
      </div>

      <button onClick={() => submit.mutate()} disabled={!empresa_id || !origem_loc || !destino_loc || itens.length === 0 || submit.isPending}
        className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
        {submit.isPending ? "salvando..." : "registrar"}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Tela de ajuste manual**

```tsx
"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";

export default function AjustePage() {
  const [q, setQ] = useState<{ empresa_id?: string; galpao_id?: string; localizacao_id?: string }>({});
  const [produto_id, setProduto] = useState<string>();
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState(1);
  const [direcao, setDirecao] = useState<"entrada" | "saida">("saida");
  const [motivo, setMotivo] = useState("");

  async function buscar(s: string) {
    const r = await (await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`)).json();
    if (r.rows?.[0]) { setProduto(r.rows[0].id); setSku(r.rows[0].sku); } else toast.error("SKU não encontrado");
  }

  const submit = useMutation({
    mutationFn: async () => sisoFetch("/api/wms/ajuste", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quadrupla: { produto_id, ...q },
        qty, direcao, motivo,
      }),
    }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: () => { toast.success("ajuste registrado"); setQty(1); setMotivo(""); },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-3 max-w-2xl">
      <h1 className="text-lg font-medium">Ajuste manual de estoque</h1>
      <QuadruplaPicker value={q} onChange={setQ} />
      <div className="flex gap-2">
        <input value={sku} onChange={e => setSku(e.target.value)} onBlur={e => e.target.value && buscar(e.target.value)}
          placeholder="SKU/GTIN" className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono" />
        <select value={direcao} onChange={e => setDirecao(e.target.value as any)}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent">
          <option value="entrada">+ entrada</option>
          <option value="saida">− saída</option>
        </select>
        <input type="number" min={1} value={qty} onChange={e => setQty(Number(e.target.value))}
          className="w-24 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent" />
      </div>
      <textarea value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="motivo (avaria, perda, encontro, erro de contagem...)"
        className="w-full px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent" rows={3} />
      <button onClick={() => submit.mutate()} disabled={!produto_id || !q.localizacao_id || motivo.length < 3 || submit.isPending}
        className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
        registrar ajuste
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/replenishment/ src/app/wms/ajuste/
git commit -m "feat(wms): telas de replenishment e ajuste manual"
```

---

### Task 10: Tela de pendências de reconciliação

**Files:**
- Create: `src/app/wms/retroativos/page.tsx`

- [ ] **Step 1: Page**

```tsx
"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";

export default function RetroativosPage() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["wms-retroativos"],
    queryFn: async () => (await sisoFetch("/api/wms/lancamento-retroativo")).json() as Promise<{ rows: any[] }>,
  });

  const reconciliar = useMutation({
    mutationFn: async ({ id, compraId }: { id: string; compraId: string }) =>
      sisoFetch(`/api/wms/lancamento-retroativo/${id}/reconciliar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compra_mov_id: compraId }),
      }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: () => {
      toast.success("reconciliado");
      queryClient.invalidateQueries({ queryKey: ["wms-retroativos"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-medium">Lançamentos retroativos pendentes</h1>
      <p className="text-sm text-zinc-500">Entradas registradas em emergência aguardando match com NF formal de entrada.</p>
      <div className="space-y-2">
        {data?.rows.map((r: any) => (
          <div key={r.id} className="p-3 rounded border border-zinc-200 dark:border-zinc-800 space-y-1">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-sm">{r.produto?.sku}</span>
                <span className="ml-2 text-zinc-500">{r.produto?.descricao}</span>
              </div>
              <div className="text-sm tabular-nums">{Number(r.quantidade).toLocaleString("pt-BR")} un</div>
            </div>
            <div className="text-xs text-zinc-500">
              {r.empresa?.nome} · {r.galpao?.nome} · {r.localizacao?.codigo} · {new Date(r.criado_em).toLocaleString("pt-BR")}
            </div>
            <div className="text-xs">{r.observacoes}</div>
            <input placeholder="ID da mov de compra (uuid)"
              onBlur={e => e.target.value && reconciliar.mutate({ id: r.id, compraId: e.target.value })}
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-xs font-mono w-full" />
          </div>
        ))}
        {data?.rows.length === 0 && <div className="text-zinc-500 text-sm">nenhuma pendência</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Adicionar links no shell**

Modify `src/components/wms/wms-shell.tsx` pra incluir links: `/wms/receber`, `/wms/transferir`, `/wms/replenishment`, `/wms/ajuste`, `/wms/retroativos`.

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/retroativos/ src/components/wms/wms-shell.tsx
git commit -m "feat(wms): tela de reconciliação de lançamentos retroativos + nav update"
```

---

### Task 11: Integration test end-to-end

**Files:**
- Create: `scripts/wms-test-movimentacoes.ts`

- [ ] **Step 1: Script**

```typescript
import "dotenv/config";
import { createServiceClient } from "../src/lib/supabase-server";
import { receberEstoque, transferirInterGalpao, replenishmentIntraGalpao, ajustarEstoque, lancarRetroativo } from "../src/lib/wms/movimentacoes";

async function main() {
  const sb = createServiceClient();
  const { data: empresa } = await sb.from("siso_empresas").select("id, galpao_id").limit(1).single();
  const { data: produto } = await sb.from("siso_produtos").select("id").limit(1).single();
  const { data: loc } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", empresa!.galpao_id).eq("codigo", "DEFAULT-PICKING").single();

  const userId = (await sb.from("siso_usuarios").select("id").limit(1).single()).data!.id;

  console.log("recebimento:");
  await receberEstoque({
    empresa_dona_id: empresa!.id, galpao_id: empresa!.galpao_id,
    itens: [{ produto_id: produto!.id, qty: 50, custo_unitario: 10, localizacao_id: loc!.id }],
    nf_referencia: "TEST-001", usuario_id: userId,
  });
  console.log("ajuste -10:");
  await ajustarEstoque({
    quadrupla: { produto_id: produto!.id, empresa_dona_id: empresa!.id, galpao_id: empresa!.galpao_id, localizacao_id: loc!.id },
    qty: 10, direcao: "saida", motivo: "teste", usuario_id: userId,
  });

  const { data: final } = await sb.from("siso_estoque").select("saldo")
    .match({ produto_id: produto!.id, empresa_dona_id: empresa!.id, galpao_id: empresa!.galpao_id, localizacao_id: loc!.id }).single();
  console.log("saldo final:", final?.saldo, "(esperado: 40)");
}

main().catch(console.error);
```

- [ ] **Step 2: Run**

```bash
npx tsx scripts/wms-test-movimentacoes.ts
```

Expected: saldo final = 40.

- [ ] **Step 3: Commit**

```bash
git add scripts/wms-test-movimentacoes.ts
git commit -m "chore(wms): script de integração testa fluxos de movimentação"
```

---

### Task 12: Documentação

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/api-reference-complete.md`

- [ ] **Step 1: Atualizar CLAUDE.md**

Adicionar nas seções "Project Structure" os novos arquivos `src/app/wms/{receber,transferir,replenishment,ajuste,retroativos}/page.tsx`, `src/lib/wms/{movimentacoes,putaway}.ts`, `src/components/wms/quadrupla-picker.tsx`.

- [ ] **Step 2: Documentar endpoints**

Adicionar em api-reference: `POST /api/wms/receber`, `GET /api/wms/receber`, `POST /api/wms/transferir-galpao`, `POST /api/wms/replenishment`, `POST /api/wms/ajuste`, `POST/GET /api/wms/lancamento-retroativo`, `POST /api/wms/lancamento-retroativo/[id]/reconciliar`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/api-reference-complete.md
git commit -m "docs(wms): documenta movimentações operacionais"
```

---

## Critério de saída do Plano 2

✅ Operador consegue receber, transferir, fazer replenishment, ajustar manualmente.
✅ Lançamento retroativo + reconciliação funcionam.
✅ Sugestão automática de putaway responde em <500ms.
✅ Custo médio é recalculado em entradas com `custo_unitario`.
✅ Reconciliação ledger↔estoque (Plano 1) continua retornando vazio após N operações.
✅ Documentação atualizada.

**Próximo:** Plano 3 (roteamento + empréstimos + reservas).
