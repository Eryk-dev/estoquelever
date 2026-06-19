# Cross — Núcleo da Camada de Equivalência (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar o Cross na fonte única de equivalência entre peças — um caderno (`siso_cross_equivalencias`) que cross e troca compartilham, com estoque sempre do ledger.

**Architecture:** Uma tabela nova de pares (a<b, status `sugestao|confirmado|bloqueado`) pendurada em `siso_produtos`. Um módulo puro (`equivalencias-core.ts`) com toda a lógica testável + um módulo de acesso a dados (`equivalencias.ts`). A troca passa a ler o caderno (mudança cirúrgica em `buscarParVerificacao`; `regraTroca` e o RPC atômico ficam intocados). Estoque sempre via `aggregateLiveStockBySku`. Telas no padrão `wms-*`, reaproveitando `ProdutoComparador`.

**Tech Stack:** Next.js 16 (App Router, route handlers), TypeScript strict, Supabase (service role via `createServiceClient`), Vitest (unit co-located `.test.ts`), TanStack React Query + `sisoFetch`, Sonner, Lucide.

**Spec:** `docs/superpowers/specs/2026-06-19-cross-redesign-design.md` · **Diagrama:** `docs/superpowers/specs/2026-06-19-cross-redesign-fluxo.html`

**Ambiente:** staging `ehbxpbeijofxtsbezwxd`, branch `develop`. Migrations: arquivo em `supabase/migrations/` + aplicar via `mcp__supabase__apply_migration` (fallback: Management API com `SUPABASE_ACCESS_TOKEN`).

---

## Decisões travadas (não rediscutir)

1. Opção C — caderno único pra cross + troca; aposentar tabelas/função antigas no fim.
2. `wms_aprovar_troca_atomico` intocado (não lê verificadas).
3. Zero auto-merge: tudo nasce `sugestao`; humano confirma.
4. Sem transitividade: equivalentes = pares **diretos** do caderno.
5. Mostrar tudo (sugestao+confirmado) no cross e na troca; troca **oculta** `bloqueado`.
6. Estoque sempre do ledger (`aggregateLiveStockBySku`); matar caminho Tiny.
7. Caderno começa vazio (sem importador no núcleo); seed só dos pares já validados na troca.
8. Permissão: ligar = `produtos.editar`; confirmar/bloquear/desfazer/decidir = `vendas.aprovar_troca`.

---

## File Structure

**Criar:**
- `supabase/migrations/20260619b_cross_equivalencias.sql` — tabela `siso_cross_equivalencias`.
- `supabase/migrations/20260619c_cross_seed_de_verificadas.sql` — seed dos pares validados.
- `supabase/migrations/20260619d_cross_drop_legado.sql` — drop das tabelas/função antigas (Fase 5).
- `src/lib/cross/equivalencias-core.ts` — lógica PURA (normalização, mapeamento, montagem).
- `src/lib/cross/equivalencias-core.test.ts` — unit tests da lógica pura.
- `src/lib/cross/equivalencias.ts` — acesso a dados (caderno + ledger).
- `src/app/api/wms/cross/ligar/route.ts` — POST criar palpite.
- `src/app/api/wms/cross/fila/route.ts` — GET fila de validação.
- `src/app/api/wms/cross/[id]/decidir/route.ts` — POST confirmar/bloquear/desfazer.
- `src/app/api/wms/cross/[id]/route.ts` — DELETE remover palpite.
- `src/app/api/wms/cross/produtos/[sku]/route.ts` — GET ficha (substitui o atual).
- `src/app/wms/cross/[sku]/page.tsx` — ficha da peça.
- `src/components/wms/cross/cross-secao-drawer.tsx` — seção Cross do produto-drawer.
- `src/components/wms/cross/cross-fila.tsx` — fila de validação (reusa ProdutoComparador).

**Modificar:**
- `src/lib/wms/trocas-equivalencia.ts` — `buscarParVerificacao`, `listarEquivalentesComEstoque`, `listarEquivalentesParaCompra` → caderno.
- `src/app/wms/cross/page.tsx` — rebuild (galeria + cartões + fila).
- `src/components/wms/produto-drawer.tsx` — nova aba "cross".
- `src/components/wms/cross/cross-popover-button.tsx` — repontar pro endpoint novo.
- `docs/api-reference-complete.md`, `docs/database-schema.md`, `docs/architecture-and-flows.md`, `erros-conhecidos.yaml`.

**Remover (Fase 5):**
- `src/app/api/wms/cross/produtos/[sku]/equivalentes-rapidos/route.ts`, `.../has-cross/route.ts`, `.../cross-ref/route.ts`, `.../verificacao/route.ts`, `.../verificacao/[skuAlvo]/route.ts`.
- `src/lib/cross/oem-extractor.ts`, `src/lib/cross/produto-fetcher.ts`; o caminho Tiny de `src/lib/cross/catalogo-queries.ts`.

---

# FASE 1 — Caderno + lógica pura + serviço de leitura

## Task 1.1: Migration da tabela `siso_cross_equivalencias`

**Files:**
- Create: `supabase/migrations/20260619b_cross_equivalencias.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Cross — caderno único de equivalência (cross + troca)
-- Spec: docs/superpowers/specs/2026-06-19-cross-redesign-design.md §3
-- Plano: docs/superpowers/plans/2026-06-19-cross-nucleo.md

BEGIN;

CREATE TABLE IF NOT EXISTS siso_cross_equivalencias (
  id          bigserial PRIMARY KEY,
  sku_a       text NOT NULL REFERENCES siso_produtos(sku) ON DELETE CASCADE,
  sku_b       text NOT NULL REFERENCES siso_produtos(sku) ON DELETE CASCADE,
  relacao     text NOT NULL DEFAULT 'equivalente' CHECK (relacao IN ('equivalente')),
  status      text NOT NULL DEFAULT 'sugestao' CHECK (status IN ('sugestao','confirmado','bloqueado')),
  fonte       text NOT NULL DEFAULT 'manual',
  observacao  text,
  criado_por  uuid REFERENCES siso_usuarios(id),
  criado_em   timestamptz NOT NULL DEFAULT now(),
  decidido_por uuid REFERENCES siso_usuarios(id),
  decidido_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (sku_a < sku_b),
  UNIQUE (sku_a, sku_b)
);

CREATE INDEX IF NOT EXISTS idx_cross_eq_sku_a  ON siso_cross_equivalencias(sku_a);
CREATE INDEX IF NOT EXISTS idx_cross_eq_sku_b  ON siso_cross_equivalencias(sku_b);
CREATE INDEX IF NOT EXISTS idx_cross_eq_status ON siso_cross_equivalencias(status);

COMMIT;
```

- [ ] **Step 2: Aplicar no staging**

Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (name: `20260619b_cross_equivalencias`). Fallback: Management API com `SUPABASE_ACCESS_TOKEN`.
Expected: sucesso; tabela existe.

- [ ] **Step 3: Verificar**

Run (via MCP `mcp__supabase__execute_sql` ou psql): `select count(*) from siso_cross_equivalencias;`
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260619b_cross_equivalencias.sql
git commit -m "feat(cross): tabela siso_cross_equivalencias (caderno único)"
```

---

## Task 1.2: Lógica pura — `equivalencias-core.ts`

**Files:**
- Create: `src/lib/cross/equivalencias-core.ts`
- Test: `src/lib/cross/equivalencias-core.test.ts`

- [ ] **Step 1: Escrever os testes que falham**

```typescript
import { describe, it, expect } from "vitest";
import {
  normalizarPar,
  saoLigaveis,
  outroLado,
  statusParaRegra,
  montarEquivalentes,
  type CrossPar,
  type ProdutoMin,
} from "./equivalencias-core";

describe("normalizarPar", () => {
  it("ordena a<b independente da ordem de entrada", () => {
    expect(normalizarPar("B", "A")).toEqual({ sku_a: "A", sku_b: "B" });
    expect(normalizarPar("A", "B")).toEqual({ sku_a: "A", sku_b: "B" });
  });
});

describe("saoLigaveis", () => {
  it("recusa ligar peça com ela mesma", () => {
    expect(saoLigaveis("A", "A")).toBe(false);
    expect(saoLigaveis("A", "B")).toBe(true);
  });
});

describe("outroLado", () => {
  it("devolve o lado oposto do par", () => {
    const par = { sku_a: "A", sku_b: "B" };
    expect(outroLado(par, "A")).toBe("B");
    expect(outroLado(par, "B")).toBe("A");
  });
});

describe("statusParaRegra", () => {
  it("mapeia confirmado→verificado, bloqueado→bloqueado, sugestao→null", () => {
    expect(statusParaRegra("confirmado")).toBe("verificado");
    expect(statusParaRegra("bloqueado")).toBe("bloqueado");
    expect(statusParaRegra("sugestao")).toBe(null);
  });
});

describe("montarEquivalentes", () => {
  const produtos: Record<string, ProdutoMin> = {
    A: { sku: "A", descricao: "Peça A", imagem_url: "a.jpg", imagens: ["a.jpg"], tier_qualidade: "original" },
    B: { sku: "B", descricao: "Peça B", imagem_url: "b.jpg", imagens: ["b.jpg"], tier_qualidade: "primeira_linha" },
    C: { sku: "C", descricao: "Peça C", imagem_url: null, imagens: null, tier_qualidade: null },
  };
  const pares: CrossPar[] = [
    { id: 1, sku_a: "A", sku_b: "B", relacao: "equivalente", status: "confirmado", fonte: "manual" },
    { id: 2, sku_a: "A", sku_b: "C", relacao: "equivalente", status: "sugestao", fonte: "manual" },
  ];
  const estoque = {
    B: { CWB: { saldo: 5, reservado: 1, disponivel: 4, localizacaoTop: "P1" } },
    C: {},
  };

  it("monta equivalentes diretos de A com produto + estoque + status", () => {
    const r = montarEquivalentes({ sku: "A", pares, produtosPorSku: produtos, estoquePorSku: estoque, incluirBloqueado: true });
    expect(r.sku).toBe("A");
    expect(r.equivalentes.map((e) => e.sku).sort()).toEqual(["B", "C"]);
    const b = r.equivalentes.find((e) => e.sku === "B")!;
    expect(b.status).toBe("confirmado");
    expect(b.descricao).toBe("Peça B");
    expect(b.estoquePorGalpao).toEqual({ CWB: { saldo: 5, reservado: 1, disponivel: 4, localizacaoTop: "P1" } });
  });

  it("oculta pares bloqueado quando incluirBloqueado=false", () => {
    const comBloq: CrossPar[] = [
      ...pares,
      { id: 3, sku_a: "A", sku_b: "D", relacao: "equivalente", status: "bloqueado", fonte: "manual" },
    ];
    const prod2 = { ...produtos, D: { sku: "D", descricao: "Peça D", imagem_url: null, imagens: null, tier_qualidade: null } };
    const r = montarEquivalentes({ sku: "A", pares: comBloq, produtosPorSku: prod2, estoquePorSku: estoque, incluirBloqueado: false });
    expect(r.equivalentes.find((e) => e.sku === "D")).toBeUndefined();
  });

  it("ignora pares sem produto carregado", () => {
    const r = montarEquivalentes({ sku: "A", pares, produtosPorSku: { A: produtos.A }, estoquePorSku: {}, incluirBloqueado: true });
    expect(r.equivalentes).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -- equivalencias-core`
Expected: FAIL ("Cannot find module './equivalencias-core'").

- [ ] **Step 3: Implementar o módulo puro**

```typescript
import type { LiveStockEntry } from "@/lib/wms/live-stock";

export type CrossStatus = "sugestao" | "confirmado" | "bloqueado";

export interface CrossPar {
  id: number;
  sku_a: string;
  sku_b: string;
  relacao: string;
  status: CrossStatus;
  fonte: string;
}

export interface ProdutoMin {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  imagens: string[] | null;
  tier_qualidade: string | null;
}

export interface CrossEquivalente extends ProdutoMin {
  relacao: string;
  status: CrossStatus;
  fonte: string;
  estoquePorGalpao: Record<string, LiveStockEntry>;
}

export interface EquivalentesDaPeca {
  sku: string;
  equivalentes: CrossEquivalente[];
}

/** Par sempre normalizado a<b pra não duplicar A↔B. */
export function normalizarPar(a: string, b: string): { sku_a: string; sku_b: string } {
  return a < b ? { sku_a: a, sku_b: b } : { sku_a: b, sku_b: a };
}

/** Recusa ligar uma peça com ela mesma. */
export function saoLigaveis(a: string, b: string): boolean {
  return a !== b;
}

export function outroLado(par: { sku_a: string; sku_b: string }, sku: string): string {
  return par.sku_a === sku ? par.sku_b : par.sku_a;
}

/**
 * Mapeia o status do caderno pro vocabulário que a regra de troca usa.
 * A regra (trocas-equivalencia-regra.ts) NÃO muda — só a fonte do dado.
 */
export function statusParaRegra(
  status: CrossStatus,
): "verificado" | "bloqueado" | null {
  if (status === "confirmado") return "verificado";
  if (status === "bloqueado") return "bloqueado";
  return null;
}

/**
 * Monta a lista de equivalentes DIRETOS de `sku` (sem corrente transitiva),
 * juntando produto + estoque (ledger) + status do par.
 */
export function montarEquivalentes(input: {
  sku: string;
  pares: CrossPar[];
  produtosPorSku: Record<string, ProdutoMin>;
  estoquePorSku: Record<string, Record<string, LiveStockEntry>>;
  incluirBloqueado: boolean;
}): EquivalentesDaPeca {
  const equivalentes: CrossEquivalente[] = [];
  for (const par of input.pares) {
    if (!input.incluirBloqueado && par.status === "bloqueado") continue;
    const outro = outroLado(par, input.sku);
    const prod = input.produtosPorSku[outro];
    if (!prod) continue;
    equivalentes.push({
      ...prod,
      relacao: par.relacao,
      status: par.status,
      fonte: par.fonte,
      estoquePorGalpao: input.estoquePorSku[outro] ?? {},
    });
  }
  return { sku: input.sku, equivalentes };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -- equivalencias-core`
Expected: PASS (todos os testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cross/equivalencias-core.ts src/lib/cross/equivalencias-core.test.ts
git commit -m "feat(cross): lógica pura de equivalência (core + testes)"
```

---

## Task 1.3: Serviço de acesso a dados — `equivalencias.ts`

**Files:**
- Create: `src/lib/cross/equivalencias.ts`

> Sem teste unitário próprio (é cola de DB; a lógica está no core já testado). Coberto por cenário na Fase 2.

- [ ] **Step 1: Implementar o serviço**

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase-server";
import { aggregateLiveStockBySku } from "@/lib/wms/live-stock";
import {
  normalizarPar,
  statusParaRegra,
  montarEquivalentes,
  type CrossPar,
  type CrossStatus,
  type ProdutoMin,
  type EquivalentesDaPeca,
} from "./equivalencias-core";

/** Pares do caderno que tocam `sku` (em qualquer dos lados). */
export async function paresDoSku(
  sb: SupabaseClient,
  sku: string,
): Promise<CrossPar[]> {
  const { data } = await sb
    .from("siso_cross_equivalencias")
    .select("id, sku_a, sku_b, relacao, status, fonte")
    .or(`sku_a.eq.${sku},sku_b.eq.${sku}`);
  return (data ?? []) as CrossPar[];
}

/** Status do par (a,b) no caderno, normalizado. null = não existe. */
export async function statusParCross(
  sb: SupabaseClient,
  a: string,
  b: string,
): Promise<CrossStatus | null> {
  const { sku_a, sku_b } = normalizarPar(a, b);
  const { data } = await sb
    .from("siso_cross_equivalencias")
    .select("status")
    .eq("sku_a", sku_a)
    .eq("sku_b", sku_b)
    .maybeSingle();
  return data ? (data.status as CrossStatus) : null;
}

/** Cria um palpite (sugestao). Idempotente: se o par já existe, devolve o existente. */
export async function criarLigacao(
  sb: SupabaseClient,
  args: { a: string; b: string; criadoPor: string | null; fonte?: string },
): Promise<{ id: number; criado: boolean }> {
  const { sku_a, sku_b } = normalizarPar(args.a, args.b);
  const { data, error } = await sb
    .from("siso_cross_equivalencias")
    .insert({ sku_a, sku_b, fonte: args.fonte ?? "manual", criado_por: args.criadoPor })
    .select("id")
    .single();
  if (!error && data) return { id: data.id as number, criado: true };
  // unique_violation → já existe
  const { data: existente } = await sb
    .from("siso_cross_equivalencias")
    .select("id")
    .eq("sku_a", sku_a)
    .eq("sku_b", sku_b)
    .maybeSingle();
  if (existente) return { id: existente.id as number, criado: false };
  throw error;
}

/** Decide o status de uma ligação (confirmar/bloquear/desfazer). */
export async function decidirLigacao(
  sb: SupabaseClient,
  args: { id: number; status: CrossStatus; decididoPor: string; observacao?: string },
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: args.status,
    atualizado_em: new Date().toISOString(),
  };
  if (args.status === "sugestao") {
    patch.decidido_por = null;
    patch.decidido_em = null;
  } else {
    patch.decidido_por = args.decididoPor;
    patch.decidido_em = new Date().toISOString();
    if (args.observacao !== undefined) patch.observacao = args.observacao;
  }
  const { error } = await sb.from("siso_cross_equivalencias").update(patch).eq("id", args.id);
  if (error) throw error;
}

export interface FilaItem {
  id: number;
  sku_a: string;
  sku_b: string;
  fonte: string;
  criado_em: string;
  a: ProdutoMin | null;
  b: ProdutoMin | null;
}

/** Fila de validação: palpites (sugestao) com dados das duas peças. */
export async function listarFila(sb: SupabaseClient): Promise<FilaItem[]> {
  const { data: rows } = await sb
    .from("siso_cross_equivalencias")
    .select("id, sku_a, sku_b, fonte, criado_em")
    .eq("status", "sugestao")
    .order("criado_em", { ascending: true });
  if (!rows || rows.length === 0) return [];
  const skus = [...new Set(rows.flatMap((r) => [r.sku_a as string, r.sku_b as string]))];
  const prod = await carregarProdutos(sb, skus);
  return rows.map((r) => ({
    id: r.id as number,
    sku_a: r.sku_a as string,
    sku_b: r.sku_b as string,
    fonte: r.fonte as string,
    criado_em: r.criado_em as string,
    a: prod[r.sku_a as string] ?? null,
    b: prod[r.sku_b as string] ?? null,
  }));
}

async function carregarProdutos(
  sb: SupabaseClient,
  skus: string[],
): Promise<Record<string, ProdutoMin>> {
  if (skus.length === 0) return {};
  const { data } = await sb
    .from("siso_produtos")
    .select("sku, descricao, imagem_url, imagens, tier_qualidade")
    .in("sku", skus);
  const out: Record<string, ProdutoMin> = {};
  for (const p of data ?? []) {
    out[p.sku as string] = {
      sku: p.sku as string,
      descricao: (p.descricao as string | null) ?? null,
      imagem_url: (p.imagem_url as string | null) ?? null,
      imagens: (p.imagens as string[] | null) ?? null,
      tier_qualidade: (p.tier_qualidade as string | null) ?? null,
    };
  }
  return out;
}

/**
 * Ficha de equivalência de uma peça: equivalentes diretos do caderno +
 * estoque SEMPRE do ledger. Nunca toca o Tiny.
 */
export async function equivalentesDaPeca(
  sku: string,
  opts?: { incluirBloqueado?: boolean },
): Promise<EquivalentesDaPeca> {
  const sb = createServiceClient();
  const pares = await paresDoSku(sb, sku);
  if (pares.length === 0) return { sku, equivalentes: [] };

  const outrosSkus = [...new Set(pares.map((p) => (p.sku_a === sku ? p.sku_b : p.sku_a)))];
  const produtosPorSku = await carregarProdutos(sb, outrosSkus);

  // Estoque do ledger (Map<sku, Map<galpaoNome, LiveStockEntry>>) → Record.
  const estoqueMap = await aggregateLiveStockBySku(sb, outrosSkus);
  const estoquePorSku: Record<string, Record<string, import("@/lib/wms/live-stock").LiveStockEntry>> = {};
  for (const [s, gmap] of estoqueMap.entries()) {
    estoquePorSku[s] = Object.fromEntries(gmap.entries());
  }

  return montarEquivalentes({
    sku,
    pares,
    produtosPorSku,
    estoquePorSku,
    incluirBloqueado: opts?.incluirBloqueado ?? true,
  });
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros novos em `src/lib/cross/equivalencias.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/cross/equivalencias.ts
git commit -m "feat(cross): serviço de equivalência (caderno + ledger)"
```

---

# FASE 2 — Endpoints + permissões

## Task 2.1: POST `/api/wms/cross/ligar` (criar palpite)

**Files:**
- Create: `src/app/api/wms/cross/ligar/route.ts`

- [ ] **Step 1: Implementar a rota**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase-server";
import { criarLigacao } from "@/lib/cross/equivalencias";
import { saoLigaveis } from "@/lib/cross/equivalencias-core";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/** POST /api/wms/cross/ligar { sku_a, sku_b } → cria palpite (sugestao). */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "produtos.editar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  let body: { sku_a?: string; sku_b?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const a = body.sku_a?.trim();
  const b = body.sku_b?.trim();
  if (!a || !b) return NextResponse.json({ error: "Envie sku_a e sku_b" }, { status: 400 });
  if (!saoLigaveis(a, b)) {
    return NextResponse.json({ error: "Não dá pra ligar uma peça com ela mesma" }, { status: 400 });
  }

  const sb = createServiceClient();
  // Garante que os dois SKUs existem no catálogo principal.
  const { data: existem } = await sb.from("siso_produtos").select("sku").in("sku", [a, b]);
  if (!existem || existem.length < 2) {
    return NextResponse.json({ error: "SKU não encontrado no catálogo" }, { status: 404 });
  }

  try {
    const r = await criarLigacao(sb, { a, b, criadoPor: session.id });
    return NextResponse.json({ ok: true, id: r.id, criado: r.criado }, { status: r.criado ? 201 : 200 });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.ligar", error, message: "erro criando ligação" });
  }
}
```

- [ ] **Step 2: Cenário manual de verificação**

Run (dev rodando, sessão de operador):
```bash
curl -s -X POST localhost:3000/api/wms/cross/ligar -H "X-Session-Id: $SID" -H "Content-Type: application/json" -d '{"sku_a":"<SKU1>","sku_b":"<SKU2>"}'
```
Expected: `{"ok":true,"id":<n>,"criado":true}`. Repetir → `criado:false`. SKU inexistente → 404. `sku_a==sku_b` → 400. Sem permissão → 403.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/cross/ligar/route.ts
git commit -m "feat(cross): POST /cross/ligar (criar palpite, produtos.editar)"
```

---

## Task 2.2: GET `/api/wms/cross/fila`

**Files:**
- Create: `src/app/api/wms/cross/fila/route.ts`

- [ ] **Step 1: Implementar a rota**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase-server";
import { listarFila } from "@/lib/cross/equivalencias";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/** GET /api/wms/cross/fila → palpites aguardando validação. */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  // Ver a fila exige a permissão de decisão (quem cura).
  if (!userCan(session, "vendas.aprovar_troca")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  try {
    const itens = await listarFila(createServiceClient());
    return NextResponse.json({ itens });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.fila", error, message: "erro listando fila" });
  }
}
```

- [ ] **Step 2: Verificar**

Run: `curl -s localhost:3000/api/wms/cross/fila -H "X-Session-Id: $SID_CURADOR"`
Expected: `{"itens":[{id,sku_a,sku_b,a:{...},b:{...}},...]}` com o palpite criado na 2.1. Sessão sem `vendas.aprovar_troca` → 403.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/cross/fila/route.ts
git commit -m "feat(cross): GET /cross/fila (validação, vendas.aprovar_troca)"
```

---

## Task 2.3: POST `/api/wms/cross/[id]/decidir` (confirmar/bloquear/desfazer)

**Files:**
- Create: `src/app/api/wms/cross/[id]/decidir/route.ts`

- [ ] **Step 1: Implementar a rota**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase-server";
import { decidirLigacao } from "@/lib/cross/equivalencias";
import type { CrossStatus } from "@/lib/cross/equivalencias-core";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

const ACOES: Record<string, CrossStatus> = {
  confirmar: "confirmado",
  bloquear: "bloqueado",
  desfazer: "sugestao",
};

/** POST /api/wms/cross/[id]/decidir { acao: confirmar|bloquear|desfazer, observacao? } */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "vendas.aprovar_troca")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id } = await params;
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  let body: { acao?: string; observacao?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const status = body.acao ? ACOES[body.acao] : undefined;
  if (!status) {
    return NextResponse.json({ error: "acao deve ser confirmar|bloquear|desfazer" }, { status: 400 });
  }

  try {
    await decidirLigacao(createServiceClient(), {
      id: idNum,
      status,
      decididoPor: session.id,
      observacao: body.observacao,
    });
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.decidir", error, message: "erro decidindo ligação" });
  }
}
```

- [ ] **Step 2: Verificar**

```bash
curl -s -X POST localhost:3000/api/wms/cross/<ID>/decidir -H "X-Session-Id: $SID_CURADOR" -H "Content-Type: application/json" -d '{"acao":"confirmar"}'
```
Expected: `{"ok":true,"status":"confirmado"}`. `desfazer` volta a `sugestao`. `bloquear` → `bloqueado`. Sem permissão → 403. acao inválida → 400.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/cross/[id]/decidir/route.ts
git commit -m "feat(cross): POST /cross/[id]/decidir (confirmar/bloquear/desfazer)"
```

---

## Task 2.4: DELETE `/api/wms/cross/[id]`

**Files:**
- Create: `src/app/api/wms/cross/[id]/route.ts`

- [ ] **Step 1: Implementar a rota**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase-server";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/** DELETE /api/wms/cross/[id] → remove a ligação. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  const { id } = await params;
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const sb = createServiceClient();
  const { data: row } = await sb
    .from("siso_cross_equivalencias")
    .select("id, status, criado_por")
    .eq("id", idNum)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "não encontrado" }, { status: 404 });

  // Palpite próprio: produtos.editar. Qualquer outro estado/dono: vendas.aprovar_troca.
  const ehPalpiteProprio = row.status === "sugestao" && row.criado_por === session.id;
  const permitido = ehPalpiteProprio
    ? userCan(session, "produtos.editar")
    : userCan(session, "vendas.aprovar_troca");
  if (!permitido) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  try {
    const { error } = await sb.from("siso_cross_equivalencias").delete().eq("id", idNum);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.delete", error, message: "erro removendo ligação" });
  }
}
```

- [ ] **Step 2: Verificar**

```bash
curl -s -X DELETE localhost:3000/api/wms/cross/<ID> -H "X-Session-Id: $SID"
```
Expected: dono do palpite com `produtos.editar` → `{"ok":true}`. Linha confirmada por outro → exige `vendas.aprovar_troca`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/cross/[id]/route.ts
git commit -m "feat(cross): DELETE /cross/[id]"
```

---

## Task 2.5: GET `/api/wms/cross/produtos/[sku]` (ficha via serviço)

**Files:**
- Create: `src/app/api/wms/cross/produtos/[sku]/route.ts`

> Substitui o GET atual desse caminho (que lia o catálogo sujo). O atual será removido na Fase 5; aqui criamos o novo handler no mesmo path — se já existir `route.ts` nesse diretório, sobrescrever o GET por este conteúdo.

- [ ] **Step 1: Implementar a rota**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import { aggregateLiveStockBySku } from "@/lib/wms/live-stock";
import { equivalentesDaPeca } from "@/lib/cross/equivalencias";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * GET /api/wms/cross/produtos/[sku]
 * Ficha: a peça (com NOSSO estoque do ledger) + equivalentes diretos.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sku: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  const { sku } = await params;

  try {
    const sb = createServiceClient();
    const { data: prod } = await sb
      .from("siso_produtos")
      .select("sku, descricao, imagem_url, imagens, tier_qualidade")
      .eq("sku", sku)
      .maybeSingle();
    if (!prod) return NextResponse.json({ error: "produto não encontrado" }, { status: 404 });

    const estoqueMap = await aggregateLiveStockBySku(sb, [sku]);
    const nossoEstoquePorGalpao = Object.fromEntries(estoqueMap.get(sku)?.entries() ?? []);

    const eq = await equivalentesDaPeca(sku, { incluirBloqueado: true });
    return NextResponse.json({ produto: prod, nossoEstoquePorGalpao, equivalentes: eq.equivalentes });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.ficha", error, message: "erro montando ficha" });
  }
}
```

- [ ] **Step 2: Verificar**

```bash
curl -s "localhost:3000/api/wms/cross/produtos/<SKU>" -H "X-Session-Id: $SID"
```
Expected: `{produto, nossoEstoquePorGalpao, equivalentes:[{sku,status,estoquePorGalpao,...}]}`. Estoque bate com `/api/wms/estoque` (ledger), não com Tiny.

- [ ] **Step 3: Adicionar cenário E2E**

**Files:** Create: `scripts/wms/cenarios/catalogo/70-cross-ligar-confirmar.ts` (seguir o estilo dos cenários existentes em `scripts/wms/cenarios/catalogo/`). Fluxo: criar 2 produtos → POST /cross/ligar → GET /cross/fila (aparece) → POST /cross/[id]/decidir confirmar → GET /cross/produtos/[sku] (equivalente confirmado presente, com estoque do ledger).

Run: `npm run scenarios:only -- 70-cross-ligar-confirmar` (conferir o nome do script no package.json; ajustar se necessário).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/cross/produtos/[sku]/route.ts scripts/wms/cenarios/catalogo/70-cross-ligar-confirmar.ts
git commit -m "feat(cross): GET /cross/produtos/[sku] (ficha via serviço) + cenário"
```

---

# FASE 3 — Religar troca + compras ao caderno + seed

## Task 3.1: Migration de seed (verificadas → caderno)

**Files:**
- Create: `supabase/migrations/20260619c_cross_seed_de_verificadas.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Cross — seed: migra pares já validados na troca pro caderno novo.
-- Só pares cujos DOIS skus existem em siso_produtos (FK do caderno).
-- Plano: docs/superpowers/plans/2026-06-19-cross-nucleo.md (Fase 3)

BEGIN;

INSERT INTO siso_cross_equivalencias
  (sku_a, sku_b, relacao, status, fonte, observacao, decidido_por, decidido_em, criado_em)
SELECT
  v.sku_a,
  v.sku_b,
  'equivalente',
  CASE v.status WHEN 'verificado' THEN 'confirmado' ELSE 'bloqueado' END,
  'migracao_troca',
  v.observacao,
  v.verificado_por,
  v.verificado_em,
  v.verificado_em
FROM siso_equivalencias_verificadas v
WHERE EXISTS (SELECT 1 FROM siso_produtos p WHERE p.sku = v.sku_a)
  AND EXISTS (SELECT 1 FROM siso_produtos p WHERE p.sku = v.sku_b)
ON CONFLICT (sku_a, sku_b) DO NOTHING;

COMMIT;
```

- [ ] **Step 2: Aplicar no staging**

Aplicar via `mcp__supabase__apply_migration` (name: `20260619c_cross_seed_de_verificadas`).

- [ ] **Step 3: Verificar**

Run: `select status, count(*) from siso_cross_equivalencias group by status;`
Expected: contagem de `confirmado`/`bloqueado` = pares validados de `siso_equivalencias_verificadas` (cujos skus existem em `siso_produtos`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260619c_cross_seed_de_verificadas.sql
git commit -m "feat(cross): seed do caderno a partir dos pares validados da troca"
```

---

## Task 3.2: Repontar `buscarParVerificacao` pro caderno

**Files:**
- Modify: `src/lib/wms/trocas-equivalencia.ts` (função `buscarParVerificacao`, ~linha 105-114)

- [ ] **Step 1: Substituir o corpo da função**

Função atual (lê `siso_equivalencias_verificadas`):

```typescript
async function buscarParVerificacao(a: string, b: string): Promise<ParVerificacao> {
  const sb = createServiceClient();
  const { data } = await sb
    .from("siso_equivalencias_verificadas")
    .select("status")
    .eq("sku_a", a)
    .eq("sku_b", b)
    .maybeSingle();
  // ... (mapeamento existente)
}
```

Substituir por (lê o caderno, mapeia via core; preserva o tipo de retorno `ParVerificacao`):

```typescript
async function buscarParVerificacao(a: string, b: string): Promise<ParVerificacao> {
  const sb = createServiceClient();
  const status = await statusParCross(sb, a, b);
  return status ? statusParaRegra(status) : null;
}
```

Adicionar imports no topo do arquivo:

```typescript
import { statusParCross } from "@/lib/cross/equivalencias";
import { statusParaRegra } from "@/lib/cross/equivalencias-core";
```

> `ParVerificacao` (de `trocas-equivalencia-regra.ts`) = `"verificado" | "bloqueado" | null`, exatamente o retorno de `statusParaRegra`. A regra não muda.

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros. (Se a função antiga normalizava a<b antes da query, `statusParCross` já normaliza internamente — remover normalização duplicada se houver.)

- [ ] **Step 3: Verificar regra ainda passa**

Run: `npm test -- trocas-equivalencia-regra`
Expected: PASS (regra pura inalterada).

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/trocas-equivalencia.ts
git commit -m "refactor(troca): buscarParVerificacao lê o caderno do cross"
```

---

## Task 3.3: Religar `listarEquivalentesComEstoque` e `listarEquivalentesParaCompra` ao caderno

**Files:**
- Modify: `src/lib/wms/trocas-equivalencia.ts` (`listarEquivalentesComEstoque` ~784, `listarEquivalentesParaCompra` ~872)

> Objetivo: trocar a fonte de equivalentes de `siso_cross_cluster_skus` (corrente transitiva sobre o catálogo sujo) pelos **pares diretos do caderno**, preservando os tipos de retorno `EquivalenteComEstoque[]` / `EquivalenteParaCompra[]` (UI e callers não mudam). `par_verificacao` passa a vir do status do caderno (sugestao→null, confirmado→"verificado", bloqueado→"bloqueado").

- [ ] **Step 1: Reescrever `listarEquivalentesComEstoque`**

```typescript
export async function listarEquivalentesComEstoque(args: {
  sku: string;
  galpaoId: string;
}): Promise<EquivalenteComEstoque[]> {
  const sb = createServiceClient();

  // Pares DIRETOS do caderno (sem corrente).
  const pares = await paresDoSku(sb, args.sku);
  if (pares.length === 0) return [];
  const skusEq = pares.map((p) => (p.sku_a === args.sku ? p.sku_b : p.sku_a));
  const statusPorSku = new Map<string, ParVerificacao>();
  for (const p of pares) {
    const outro = p.sku_a === args.sku ? p.sku_b : p.sku_a;
    statusPorSku.set(outro, statusParaRegra(p.status));
  }

  const { data: produtos } = await sb
    .from("siso_produtos")
    .select("id, sku, descricao, imagem_url, imagens, tier_qualidade")
    .in("sku", skusEq)
    .eq("ativo", true);
  if (!produtos || produtos.length === 0) return [];

  const produtoIds = produtos.map((p) => p.id as string);
  const { data: estoque } = await sb
    .from("siso_estoque")
    .select("produto_id, disponivel, siso_localizacoes!inner(tipo)")
    .eq("galpao_id", args.galpaoId)
    .in("produto_id", produtoIds)
    .in("siso_localizacoes.tipo", ["picking", "overstock"])
    .gt("disponivel", 0);
  const dispPorProduto = new Map<string, number>();
  for (const e of estoque ?? []) {
    const pid = e.produto_id as string;
    dispPorProduto.set(pid, (dispPorProduto.get(pid) ?? 0) + Number(e.disponivel));
  }

  return produtos
    .map((p) => ({
      produto_id: p.id as string,
      sku: p.sku as string,
      descricao: (p.descricao as string | null) ?? null,
      imagem_url: (p.imagem_url as string | null) ?? null,
      imagens: (p.imagens as string[] | null) ?? null,
      tier_qualidade: (p.tier_qualidade as TierQualidade | null) ?? null,
      par_verificacao: statusPorSku.get(p.sku as string) ?? null,
      disponivel_galpao: dispPorProduto.get(p.id as string) ?? 0,
    }))
    .sort((a, b) => b.disponivel_galpao - a.disponivel_galpao);
}
```

- [ ] **Step 2: Reescrever `listarEquivalentesParaCompra`** (mesma troca de fonte; mantém saldo por galpão)

```typescript
export async function listarEquivalentesParaCompra(args: {
  sku: string;
}): Promise<EquivalenteParaCompra[]> {
  const sb = createServiceClient();

  const pares = await paresDoSku(sb, args.sku);
  if (pares.length === 0) return [];
  const skusEq = pares.map((p) => (p.sku_a === args.sku ? p.sku_b : p.sku_a));
  const statusPorSku = new Map<string, ParVerificacao>();
  for (const p of pares) {
    const outro = p.sku_a === args.sku ? p.sku_b : p.sku_a;
    statusPorSku.set(outro, statusParaRegra(p.status));
  }

  const { data: produtos } = await sb
    .from("siso_produtos")
    .select("id, sku, descricao, imagem_url, tier_qualidade")
    .in("sku", skusEq)
    .eq("ativo", true);
  if (!produtos || produtos.length === 0) return [];

  const produtoIds = produtos.map((p) => p.id as string);
  const { data: estoque } = await sb
    .from("siso_estoque")
    .select("produto_id, galpao_id, disponivel, siso_localizacoes!inner(tipo)")
    .in("produto_id", produtoIds)
    .in("siso_localizacoes.tipo", ["picking", "overstock"])
    .gt("disponivel", 0);

  const porProduto = new Map<string, Map<string, number>>();
  const galpaoIds = new Set<string>();
  for (const e of estoque ?? []) {
    const pid = e.produto_id as string;
    const gid = e.galpao_id as string;
    galpaoIds.add(gid);
    if (!porProduto.has(pid)) porProduto.set(pid, new Map());
    const m = porProduto.get(pid)!;
    m.set(gid, (m.get(gid) ?? 0) + Number(e.disponivel ?? 0));
  }

  const nomePorGalpao = new Map<string, string>();
  if (galpaoIds.size > 0) {
    const { data: galpoes } = await sb.from("siso_galpoes").select("id, nome").in("id", [...galpaoIds]);
    for (const g of galpoes ?? []) nomePorGalpao.set(g.id as string, g.nome as string);
  }

  return produtos.map((p) => {
    const m = porProduto.get(p.id as string) ?? new Map<string, number>();
    const saldo_por_galpao: SaldoGalpaoEquivalente[] = [...m.entries()].map(([galpao_id, disponivel]) => ({
      galpao_id,
      galpao_nome: nomePorGalpao.get(galpao_id) ?? "",
      disponivel,
    }));
    return {
      produto_id: p.id as string,
      sku: p.sku as string,
      descricao: (p.descricao as string | null) ?? null,
      imagem_url: (p.imagem_url as string | null) ?? null,
      tier_qualidade: (p.tier_qualidade as TierQualidade | null) ?? null,
      par_verificacao: statusPorSku.get(p.sku as string) ?? null,
      saldo_por_galpao,
    };
  });
}
```

> Ajustar os campos do objeto retornado pra casar EXATAMENTE com os tipos `EquivalenteComEstoque` / `EquivalenteParaCompra` já definidos no arquivo (conferir nomes; o trecho acima espelha o shape atual).

- [ ] **Step 3: Adicionar import**

No topo de `trocas-equivalencia.ts` (se ainda não houver da Task 3.2):

```typescript
import { paresDoSku } from "@/lib/cross/equivalencias";
import { statusParaRegra } from "@/lib/cross/equivalencias-core";
```

- [ ] **Step 4: Verificar typecheck + cenários de troca**

Run: `npx tsc --noEmit`
Expected: sem erros.
Run: `npm run scenarios:only -- troca` (rodar os cenários de troca existentes; conferir nomes)
Expected: PASS — troca enxerga equivalentes pelo caderno; par confirmado = livre, sugestao = aprovação.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/trocas-equivalencia.ts
git commit -m "refactor(troca): equivalentes vêm do caderno (sem corrente transitiva)"
```

---

# FASE 4 — Telas

> UI sem harness de teste de componente: cada task = escrever o componente (código completo) + verificar rodando o app (`npm run dev`) e/ou `npm run build`. Padrão `wms-*`, `sisoFetch`, React Query, Sonner, Lucide.

## Task 4.1: Seção Cross no produto-drawer

**Files:**
- Create: `src/components/wms/cross/cross-secao-drawer.tsx`
- Modify: `src/components/wms/produto-drawer.tsx` (TabId, lista de abas, render)

- [ ] **Step 1: Criar o componente da seção**

```typescript
"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import { StatusBadge, fmtNum } from "@/components/wms/ui/wms-ui";

interface EquivalenteFicha {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  status: "sugestao" | "confirmado" | "bloqueado";
  estoquePorGalpao: Record<string, { disponivel: number }>;
}

interface FichaResp {
  produto: { sku: string; descricao: string | null };
  equivalentes: EquivalenteFicha[];
}

export function CrossSecaoDrawer({ sku }: { sku: string }) {
  const { can } = usePermissoes();
  const q = useQuery<FichaResp>({
    queryKey: ["wms-cross-ficha", sku],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/cross/produtos/${encodeURIComponent(sku)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  if (q.isLoading) return <div className="wms-exp-empty" style={{ padding: 24 }}>Carregando…</div>;
  const eqs = q.data?.equivalentes ?? [];

  return (
    <div className="wms-cross-secao" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong>Equivalentes ({eqs.length})</strong>
        <div style={{ display: "flex", gap: 8 }}>
          <Link className="wms-btn wms-btn-ghost" href={`/wms/cross/${encodeURIComponent(sku)}`}>
            Abrir ficha →
          </Link>
        </div>
      </div>

      {eqs.length === 0 ? (
        <div className="wms-exp-empty">Sem cross. {can("produtos.editar") && "Ligue uma peça na ficha."}</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {eqs.map((e) => {
            const total = Object.values(e.estoquePorGalpao).reduce((s, g) => s + (g.disponivel ?? 0), 0);
            return (
              <div key={e.sku} className="wms-card" style={{ display: "flex", gap: 12, alignItems: "center", padding: 8 }}>
                {e.imagem_url && <img src={e.imagem_url} alt="" width={40} height={40} style={{ objectFit: "cover", borderRadius: 6 }} />}
                <div style={{ flex: 1 }}>
                  <div className="wms-mono">{e.sku}</div>
                  <div style={{ fontSize: 12, color: "var(--wms-c-muted)" }}>{e.descricao}</div>
                </div>
                <StatusBadge status={e.status} />
                <div className="wms-mono" title="nosso disponível (ledger)">{fmtNum(total)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Plugar a aba no produto-drawer**

Em `src/components/wms/produto-drawer.tsx`:

(a) Estender `TabId` (linha ~30):
```typescript
type TabId =
  | "overview"
  | "estoque"
  | "movs"
  | "cobertura"
  | "fornec"
  | "kit"
  | "fotos"
  | "cross";
```

(b) Adicionar à lista de abas (no array dentro de `wms-pd-tabs`, depois de `fornec`):
```typescript
      { id: "cross", label: "Cross" },
```

(c) Importar no topo:
```typescript
import { CrossSecaoDrawer } from "@/components/wms/cross/cross-secao-drawer";
```

(d) Renderizar a aba (junto dos outros `{tab === "..." && ...}`):
```typescript
{tab === "cross" && <CrossSecaoDrawer sku={produto.sku} />}
```

> `produto.sku` está disponível no drawer (usado nas outras abas). Conferir o nome exato do campo no objeto `produto`.

- [ ] **Step 3: Verificar**

Run: `npm run build`
Expected: build OK.
Manual: abrir um produto em `/wms/estoque` ou `/wms/produtos` → aba "Cross" mostra os equivalentes (ou "Sem cross") com estoque do ledger.

- [ ] **Step 4: Commit**

```bash
git add src/components/wms/cross/cross-secao-drawer.tsx src/components/wms/produto-drawer.tsx
git commit -m "feat(cross): aba Cross no produto-drawer"
```

---

## Task 4.2: Ficha da peça `/wms/cross/[sku]`

**Files:**
- Create: `src/app/wms/cross/[sku]/page.tsx`

> Se já existir `src/app/wms/cross/[sku]/page.tsx` (do cross antigo), substituir por este conteúdo.

- [ ] **Step 1: Escrever a página**

```typescript
"use client";

import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader, StatusBadge, fmtNum } from "@/components/wms/ui/wms-ui";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";

interface Equivalente {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  status: "sugestao" | "confirmado" | "bloqueado";
  estoquePorGalpao: Record<string, { saldo: number; reservado: number; disponivel: number }>;
}
interface Ficha {
  produto: { sku: string; descricao: string | null; imagem_url: string | null };
  nossoEstoquePorGalpao: Record<string, { saldo: number; reservado: number; disponivel: number }>;
  equivalentes: Equivalente[];
}

export default function CrossFichaPage({ params }: { params: Promise<{ sku: string }> }) {
  const { sku } = use(params);
  const skuDec = decodeURIComponent(sku);
  const { can } = usePermissoes();
  const qc = useQueryClient();
  const [novoSku, setNovoSku] = useState("");

  const q = useQuery<Ficha>({
    queryKey: ["wms-cross-ficha", skuDec],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/cross/produtos/${encodeURIComponent(skuDec)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const ligar = useMutation({
    mutationFn: async (alvo: string) => {
      const r = await sisoFetch(`/api/wms/cross/ligar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku_a: skuDec, sku_b: alvo }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Palpite criado — entra na fila de validação");
      setNovoSku("");
      qc.invalidateQueries({ queryKey: ["wms-cross-ficha", skuDec] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ledgerTotal = (m: Record<string, { disponivel: number }>) =>
    Object.values(m).reduce((s, g) => s + (g.disponivel ?? 0), 0);

  return (
    <>
      <PageHeader
        title={`Cross · ${skuDec}`}
        subtitle={q.data?.produto.descricao ?? ""}
        backHref="/wms/cross"
        backLabel="Cross"
      />

      {/* NOSSO ESTOQUE — bloco próprio */}
      <section className="wms-card" style={{ padding: 16, marginBottom: 16 }}>
        <strong>Nosso estoque (ledger)</strong>
        <div className="wms-mono" style={{ fontSize: 22 }}>
          {q.data ? fmtNum(ledgerTotal(q.data.nossoEstoquePorGalpao)) : "—"} disponível
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          {Object.entries(q.data?.nossoEstoquePorGalpao ?? {}).map(([g, v]) => (
            <span key={g} className="wms-chip">{g}: {fmtNum(v.disponivel)}</span>
          ))}
        </div>
      </section>

      {can("produtos.editar") && (
        <section className="wms-card" style={{ padding: 16, marginBottom: 16 }}>
          <strong>Ligar peça</strong>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              className="wms-input"
              placeholder="SKU equivalente"
              value={novoSku}
              onChange={(e) => setNovoSku(e.target.value)}
            />
            <button className="wms-btn wms-btn-primary" disabled={!novoSku.trim() || ligar.isPending} onClick={() => ligar.mutate(novoSku.trim())}>
              Ligar
            </button>
          </div>
        </section>
      )}

      <section>
        <strong>Equivalentes ({q.data?.equivalentes.length ?? 0})</strong>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          {(q.data?.equivalentes ?? []).map((e) => (
            <div key={e.sku} className="wms-card" style={{ display: "flex", gap: 12, alignItems: "center", padding: 10 }}>
              {e.imagem_url && <img src={e.imagem_url} alt="" width={48} height={48} style={{ objectFit: "cover", borderRadius: 6 }} />}
              <div style={{ flex: 1 }}>
                <div className="wms-mono">{e.sku}</div>
                <div style={{ fontSize: 12, color: "var(--wms-c-muted)" }}>{e.descricao}</div>
              </div>
              <StatusBadge status={e.status} />
              <div className="wms-mono" title="nosso disponível (ledger)">{fmtNum(ledgerTotal(e.estoquePorGalpao))}</div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
```

> Conferir classes utilitárias (`wms-chip`, `wms-input`, `wms-btn-*`) contra `src/app/wms/wms.css`; ajustar nomes pros existentes.

- [ ] **Step 2: Verificar**

Run: `npm run build` → OK. Manual: `/wms/cross/<SKU>` mostra nosso estoque (bloco próprio), "Ligar peça" (se `produtos.editar`), e equivalentes com selo + disponível do ledger. Ligar cria palpite (toast).

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/cross/[sku]/page.tsx
git commit -m "feat(cross): ficha da peça /wms/cross/[sku]"
```

---

## Task 4.3: Fila de validação (reusa ProdutoComparador)

**Files:**
- Create: `src/components/wms/cross/cross-fila.tsx`

- [ ] **Step 1: Escrever o componente**

```typescript
"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ProdutoComparador } from "@/components/wms/produto-lightbox";
import { sisoFetch } from "@/lib/auth-context";

interface ProdLado { sku: string; descricao: string | null; imagens: string[] | null; imagem_url: string | null; }
interface FilaItem { id: number; sku_a: string; sku_b: string; fonte: string; a: ProdLado | null; b: ProdLado | null; }

function imgs(p: ProdLado | null): string[] {
  if (!p) return [];
  if (p.imagens && p.imagens.length) return p.imagens;
  return p.imagem_url ? [p.imagem_url] : [];
}

export function CrossFila() {
  const qc = useQueryClient();
  const [i, setI] = useState(0);

  const q = useQuery<{ itens: FilaItem[] }>({
    queryKey: ["wms-cross-fila"],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/cross/fila`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const itens = q.data?.itens ?? [];
  const atual = itens[i];

  const decidir = useMutation({
    mutationFn: async (acao: "confirmar" | "bloquear") => {
      if (!atual) return;
      const r = await sisoFetch(`/api/wms/cross/${atual.id}/decidir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: (_d, acao) => {
      toast.success(acao === "confirmar" ? "Confirmado ✓" : "Bloqueado 🚫");
      qc.invalidateQueries({ queryKey: ["wms-cross-fila"] });
      qc.invalidateQueries({ queryKey: ["wms-cross-ficha"] });
      setI((n) => n); // mantém índice; a lista encolhe
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pular = () => setI((n) => Math.min(n + 1, itens.length - 1));

  // Atalhos de teclado: ✓ = seta direita / Enter; ✗ = seta esquerda; pular = espaço.
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      if (!atual || decidir.isPending) return;
      if (ev.key === "ArrowRight" || ev.key === "Enter") decidir.mutate("confirmar");
      else if (ev.key === "ArrowLeft") decidir.mutate("bloquear");
      else if (ev.key === " ") { ev.preventDefault(); pular(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [atual, decidir.isPending]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <div className="wms-exp-empty" style={{ padding: 24 }}>Carregando…</div>;
  if (itens.length === 0) return <div className="wms-exp-empty" style={{ padding: 24 }}>Fila vazia — nada pra validar.</div>;
  if (!atual) return <div className="wms-exp-empty" style={{ padding: 24 }}>Fim da fila.</div>;

  return (
    <div className="wms-cross-fila">
      <div style={{ marginBottom: 8, color: "var(--wms-c-muted)" }}>
        {i + 1} / {itens.length} · ligado por: {atual.fonte}
      </div>
      <ProdutoComparador
        esquerda={{ rotulo: "Peça A", sku: atual.sku_a, descricao: atual.a?.descricao ?? "", imagens: imgs(atual.a) }}
        direita={{ rotulo: "Peça B", sku: atual.sku_b, descricao: atual.b?.descricao ?? "", imagens: imgs(atual.b) }}
        onClose={pular}
      />
      <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 16 }}>
        <button className="wms-btn wms-btn-danger" disabled={decidir.isPending} onClick={() => decidir.mutate("bloquear")}>✗ Não (←)</button>
        <button className="wms-btn wms-btn-ghost" onClick={pular}>Pular (espaço)</button>
        <button className="wms-btn wms-btn-primary" disabled={decidir.isPending} onClick={() => decidir.mutate("confirmar")}>✓ É a mesma (→)</button>
      </div>
    </div>
  );
}
```

> `ProdutoComparador` é um overlay com `onClose`; aqui usamos como painel de comparação. Se o overlay não couber inline, renderizar as duas fotos com `ProdutoLightbox`/`<img>` lado a lado seguindo o mesmo shape `LadoComparacao`. Conferir no `produto-lightbox.tsx` se há export de um sub-painel não-overlay; senão, usar `<img>` direto com `imgs()`.

- [ ] **Step 2: Verificar**

Manual: montar a fila com 2+ palpites (Task 2.1), abrir a fila, confirmar/bloquear com teclado, ver a lista encolher e a ficha atualizar.

- [ ] **Step 3: Commit**

```bash
git add src/components/wms/cross/cross-fila.tsx
git commit -m "feat(cross): fila de validação (comparador + atalhos)"
```

---

## Task 4.4: Rebuild da página `/wms/cross`

**Files:**
- Modify: `src/app/wms/cross/page.tsx`

- [ ] **Step 1: Reescrever a página** (busca + galeria com selo + cartões + entrada pra fila)

```typescript
"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { PageHeader, StatusBadge } from "@/components/wms/ui/wms-ui";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import { CrossFila } from "@/components/wms/cross/cross-fila";

type Aba = "buscar" | "fila";

interface ResultadoBusca {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  status_cross: "confirmado" | "sugestao" | "sem_cross";
}

export default function CrossPage() {
  const { can } = usePermissoes();
  const [aba, setAba] = useState<Aba>("buscar");
  const [q, setQ] = useState("");
  const debounced = useDebounce(q, 300);

  const busca = useQuery<{ resultados: ResultadoBusca[] }>({
    queryKey: ["wms-cross-busca", debounced],
    queryFn: async ({ signal }) => {
      const r = await sisoFetch(`/api/wms/cross/search?q=${encodeURIComponent(debounced)}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: debounced.trim().length >= 2,
  });

  const resultados = busca.data?.resultados ?? [];
  const contadores = useMemo(() => {
    const c = { confirmado: 0, sugestao: 0, sem_cross: 0 };
    for (const r of resultados) c[r.status_cross]++;
    return c;
  }, [resultados]);

  return (
    <>
      <PageHeader title="Cross" subtitle="Dicionário de peças equivalentes">
        <div style={{ display: "flex", gap: 8 }}>
          <button className={`wms-btn ${aba === "buscar" ? "wms-btn-primary" : "wms-btn-ghost"}`} onClick={() => setAba("buscar")}>Buscar</button>
          {can("vendas.aprovar_troca") && (
            <button className={`wms-btn ${aba === "fila" ? "wms-btn-primary" : "wms-btn-ghost"}`} onClick={() => setAba("fila")}>Fila de validação</button>
          )}
        </div>
      </PageHeader>

      {aba === "fila" ? (
        <CrossFila />
      ) : (
        <>
          <input className="wms-input" placeholder="SKU, OEM ou nome…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", marginBottom: 12 }} />
          {debounced.trim().length >= 2 && (
            <div style={{ display: "flex", gap: 12, marginBottom: 12, color: "var(--wms-c-muted)" }}>
              <span>✓ confirmadas: {contadores.confirmado}</span>
              <span>● aguardando: {contadores.sugestao}</span>
              <span>○ sem cross: {contadores.sem_cross}</span>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
            {resultados.map((r) => (
              <Link key={r.sku} href={`/wms/cross/${encodeURIComponent(r.sku)}`} className="wms-card" style={{ padding: 10, textDecoration: "none" }}>
                {r.imagem_url && <img src={r.imagem_url} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6 }} />}
                <div className="wms-mono" style={{ marginTop: 6 }}>{r.sku}</div>
                <div style={{ fontSize: 12, color: "var(--wms-c-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.descricao}</div>
                <div style={{ marginTop: 6 }}>
                  <StatusBadge status={r.status_cross === "sem_cross" ? "sem cross" : r.status_cross} />
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function useDebounce<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
```

> A busca usa `/api/wms/cross/search`. Esse endpoint hoje calcula `cross_count` via `catalogo-queries.ts` (corrente + catálogo sujo). **Na Task 5.x** ele é reescrito pra buscar em `siso_produtos` e derivar `status_cross` do caderno (confirmado se há par confirmado; sugestao se só palpite; sem_cross caso contrário). Até lá, a galeria pode renderizar sem o selo correto — aceitável durante a fase.

- [ ] **Step 2: Verificar**

Run: `npm run build` → OK. Manual: `/wms/cross` busca, mostra galeria + contadores; aba "Fila" (curador) abre o comparador.

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/cross/page.tsx
git commit -m "feat(cross): rebuild da página /wms/cross (galeria + fila)"
```

---

# FASE 5 — Reescrever busca, matar Tiny, aposentar legado

## Task 5.1: Reescrever `/api/wms/cross/search` (siso_produtos + status do caderno)

**Files:**
- Modify: `src/app/api/wms/cross/search/route.ts` (conferir path real do endpoint de busca)
- Modify/retire: `src/lib/cross/catalogo-queries.ts`

- [ ] **Step 1: Reescrever a busca** pra ler `siso_produtos` (sku/descricao/ncm/oem se houver) e derivar `status_cross` do caderno:

```typescript
// pseudo-shape do handler — adaptar imports/auth ao padrão das outras rotas cross
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";

export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ resultados: [] });

  const sb = createServiceClient();
  const { data: prods } = await sb
    .from("siso_produtos")
    .select("sku, descricao, imagem_url")
    .or(`sku.ilike.%${q}%,descricao.ilike.%${q}%`)
    .eq("ativo", true)
    .limit(60);
  const skus = (prods ?? []).map((p) => p.sku as string);

  const { data: pares } = skus.length
    ? await sb.from("siso_cross_equivalencias").select("sku_a, sku_b, status").or(skus.map((s) => `sku_a.eq.${s},sku_b.eq.${s}`).join(","))
    : { data: [] as { sku_a: string; sku_b: string; status: string }[] };

  const melhor = new Map<string, "confirmado" | "sugestao">();
  for (const p of pares ?? []) {
    for (const s of [p.sku_a, p.sku_b]) {
      const cur = melhor.get(s);
      if (p.status === "confirmado") melhor.set(s, "confirmado");
      else if (!cur) melhor.set(s, "sugestao");
    }
  }

  const resultados = (prods ?? []).map((p) => ({
    sku: p.sku,
    descricao: p.descricao,
    imagem_url: p.imagem_url,
    status_cross: melhor.get(p.sku as string) ?? "sem_cross",
  }));
  return NextResponse.json({ resultados });
}
```

> Ajustar ao shape real esperado pela page (Task 4.4). Se a busca por OEM for desejada agora, fica pra floreio (sem dados de OEM limpos). O `.or` com muitos skus pode ficar grande; se necessário, fazer 2 queries (`in('sku_a', skus)` + `in('sku_b', skus)`).

- [ ] **Step 2: Remover o caminho Tiny de `catalogo-queries.ts`**

Deletar `loadEstoquePorGalpao`, `getEstoquePorGalpaoParaSku` e o que importa `@/lib/tiny-api` nesse arquivo. Se o arquivo ficar sem uso, deletá-lo inteiro (conferir importadores com grep antes).

- [ ] **Step 3: Verificar build + ausência de Tiny no cross**

Run: `grep -rn "tiny-api" src/lib/cross src/app/api/wms/cross || echo "OK sem tiny"`
Expected: `OK sem tiny`.
Run: `npm run build` → OK.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/cross/search/route.ts src/lib/cross/catalogo-queries.ts
git commit -m "feat(cross): busca via siso_produtos + caderno; mata caminho Tiny"
```

---

## Task 5.2: Repontar cross-popover + remover endpoints/arquivos legados

**Files:**
- Modify: `src/components/wms/cross/cross-popover-button.tsx`
- Remove: `src/app/api/wms/cross/produtos/[sku]/equivalentes-rapidos/route.ts`, `.../has-cross/route.ts`, `.../cross-ref/route.ts`, `.../verificacao/route.ts`, `.../verificacao/[skuAlvo]/route.ts`
- Remove: `src/lib/cross/oem-extractor.ts`, `src/lib/cross/produto-fetcher.ts`

- [ ] **Step 1: Repontar o popover** pra usar só `/api/wms/cross/produtos/[sku]` (já traz produto + equivalentes + estoque do ledger). Remover as chamadas a `/estoque` e `/equivalentes-rapidos`; mapear `equivalentes` do novo shape (sku, descricao, imagem_url, status, estoquePorGalpao). Atualizar `use-has-cross.ts` pra checar via o novo endpoint (ex.: equivalentes.length>0) ou remover o gate de "has-cross" e sempre mostrar o botão.

- [ ] **Step 2: Deletar os arquivos legados** listados acima.

- [ ] **Step 3: Verificar nada quebrou**

Run: `grep -rn "equivalentes-rapidos\|has-cross\|cross-ref\|/verificacao\|oem-extractor\|produto-fetcher\|siso_cross_cluster_skus" src | grep -v "\.test\." || echo "OK sem refs"`
Expected: `OK sem refs` (ou só refs em cenários a ajustar).
Run: `npm run build` → OK.

- [ ] **Step 4: Ajustar o cenário de teste**

`scripts/wms/cenarios/catalogo/60-troca-remota-inter-galpao.ts:46` usa UPSERT em `siso_equivalencias_verificadas`. Trocar por INSERT em `siso_cross_equivalencias` (status `confirmado`).

- [ ] **Step 5: Commit**

```bash
git add -A src/components/wms/cross src/lib/cross src/hooks/use-has-cross.ts src/app/api/wms/cross scripts/wms/cenarios
git commit -m "refactor(cross): popover no endpoint novo; remove legado (oem-extractor, produto-fetcher, endpoints)"
```

---

## Task 5.3: Drop das tabelas/função antigas

**Files:**
- Create: `supabase/migrations/20260619d_cross_drop_legado.sql`

- [ ] **Step 1: Confirmar zero referências em código** (repetir grep da 5.2 incluindo `siso_produtos_catalogo`, `siso_produto_oems`, `siso_produto_veiculos`, `siso_produto_links`, `siso_equivalencias_verificadas`).
Run: `grep -rn "siso_produtos_catalogo\|siso_produto_oems\|siso_produto_veiculos\|siso_produto_links\|siso_equivalencias_verificadas\|siso_cross_cluster_skus" src scripts | grep -v "\.test\." || echo "OK"`
Expected: `OK`.

- [ ] **Step 2: Escrever a migration de drop**

```sql
-- Cross — aposenta o legado (após rewire completo + seed).
-- Plano: docs/superpowers/plans/2026-06-19-cross-nucleo.md (Fase 5)

BEGIN;

DROP FUNCTION IF EXISTS public.siso_cross_cluster_skus(text);
DROP TABLE IF EXISTS siso_equivalencias_verificadas;
DROP TABLE IF EXISTS siso_produto_links;
DROP TABLE IF EXISTS siso_produto_oems;
DROP TABLE IF EXISTS siso_produto_veiculos;
DROP TABLE IF EXISTS siso_produtos_catalogo;

COMMIT;
```

> Ordem respeita FKs (oems/veiculos/links/verificadas referenciam catalogo → dropar antes do catalogo).

- [ ] **Step 3: Aplicar no staging** via `mcp__supabase__apply_migration` (name: `20260619d_cross_drop_legado`).

- [ ] **Step 4: Verificar**

Run: `select to_regclass('siso_produtos_catalogo');` → Expected: `null`.
Run: `npm run build` → OK.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260619d_cross_drop_legado.sql
git commit -m "feat(cross): drop do legado (catalogo/oems/veiculos/links/verificadas/cluster fn)"
```

---

## Task 5.4: Docs + erros-conhecidos

**Files:**
- Modify: `docs/database-schema.md`, `docs/api-reference-complete.md`, `docs/architecture-and-flows.md`, `erros-conhecidos.yaml`

- [ ] **Step 1: database-schema.md** — adicionar `siso_cross_equivalencias` (colunas/constraints da Task 1.1); remover as 5 tabelas dropadas e a função `siso_cross_cluster_skus`.

- [ ] **Step 2: api-reference-complete.md** — adicionar `POST /cross/ligar`, `GET /cross/fila`, `POST /cross/[id]/decidir`, `DELETE /cross/[id]`, `GET /cross/produtos/[sku]` (novo shape); marcar removidos `equivalentes-rapidos`, `has-cross`, `cross-ref`, `verificacao*`.

- [ ] **Step 3: architecture-and-flows.md** — descrever o cross como camada de equivalência única; a troca lê o caderno (`buscarParVerificacao`→`siso_cross_equivalencias`); estoque do cross = ledger.

- [ ] **Step 4: erros-conhecidos.yaml** — adicionar entradas pros 6 problemas corrigidos:

```yaml
- id: cross-estoque-tiny
  date: 2026-06-19
  source: src/lib/cross/catalogo-queries.ts
  category: business_logic
  message: Cross mostrava estoque do Tiny (mentia zero quando Tiny caía)
  cause: loadEstoquePorGalpao chamava getEstoque/buscarProdutoPorSku; catch→continue→vazio
  fix: estoque do cross passa a vir do ledger via aggregateLiveStockBySku
  files: [src/lib/cross/equivalencias.ts, src/app/api/wms/cross/produtos/[sku]/route.ts]
  tags: [cross, estoque, ledger]
- id: cross-oem-overmerge
  date: 2026-06-19
  source: src/lib/cross/oem-extractor.ts
  category: business_logic
  message: OEM por regex aceitava 'ORIGINAL'/'1000' e fundia peças não-relacionadas
  cause: Estratégia 1 pulava looksLikeOemCode; insert append-only (ignoreDuplicates)
  fix: equivalência agora é par humano-confirmado no caderno; oem-extractor removido
  files: [src/lib/cross/equivalencias-core.ts]
  tags: [cross, oem]
- id: cross-cluster-transitivo
  date: 2026-06-19
  source: supabase/migrations/20260610e_rpc_siso_cross_cluster_skus.sql
  category: business_logic
  message: Equivalência por corrente cega (A=C via ponte) sem cap de profundidade
  cause: CTE recursiva siso_cross_cluster_skus sobre oem && oem
  fix: leitura passa a usar pares diretos do caderno; função dropada
  files: [src/lib/cross/equivalencias.ts, src/lib/wms/trocas-equivalencia.ts]
  tags: [cross, equivalencia]
```

- [ ] **Step 5: Commit**

```bash
git add docs/ erros-conhecidos.yaml
git commit -m "docs(cross): schema/api/flows + erros-conhecidos do redesign"
```

---

## Verificação final (rodar antes de fechar a branch)

- [ ] `npm test` → verde (inclui `equivalencias-core`, `trocas-equivalencia-regra`).
- [ ] `npm run lint` → sem erros novos.
- [ ] `npm run build` → OK.
- [ ] `npm run scenarios:only -- 70-cross-ligar-confirmar` + cenários de troca → PASS.
- [ ] `grep` final: nenhuma referência viva às tabelas/função/arquivos dropados.
- [ ] Fluxo manual ponta-a-ponta: ligar (operador) → fila (curador) → confirmar → ficha do produto mostra equivalente → troca trata o par como livre → desfazer reverte.
