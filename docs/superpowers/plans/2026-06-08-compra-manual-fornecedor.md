# Compra Manual de Fornecedor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o operador crie uma compra proativa de qualquer fornecedor (sem pedido de cliente), receba (total/parcial) e dê entrada no estoque com custo médio atualizado.

**Architecture:** Aggregate dedicado novo (`siso_compras_manuais` + `siso_compras_manuais_itens`). O movimento de entrada reusa `inserirMovimentacao` com `origem_tipo='nf_compra'` (já na whitelist de custo médio — zero mudança na RPC) distinguido por `origem_detalhes.origem='compra_manual'`. Frontend reusa `ProdutoCombo`/`useGalpoes`. Fornecedor/produto podem ser criados inline via 2 rotas finas guardadas por `compras.executar`.

**Tech Stack:** Next.js 16 (App Router), TypeScript strict, Supabase (service role), Zod-less validação manual (padrão das rotas existentes), React Query + Sonner, Vitest (unit happy-dom + integration contra staging).

**Decisões fechadas (spec 2026-06-08):** ciclo completo; fornecedor/produto inline; empresa escolhida pelo operador (tag); reusar `nf_compra`; inline-create sob `compras.executar`; galpão default = ativo; custo no recebimento; cancelar só sem recebimento; aba "Manuais" separada.

**⚠ Working environment:** tudo em STAGING (`develop`, Supabase `ehbxpbeijofxtsbezwxd`). Migration aplicada via `mcp__supabase__apply_migration` (fallback: Management API com `$SUPABASE_ACCESS_TOKEN`). Integration roda contra staging real (`.env.test.local` com service-role real) e trunca tabelas operacionais.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20260611c_compra_manual.sql` | 2 tabelas novas + índices |
| `src/lib/wms/compras-manuais.ts` | domínio: types, `computeStatusCompra` (pura), `criarCompraManual`, `listarComprasManuais`, `receberCompraManual`, `cancelarCompraManual`, helper de mov |
| `src/lib/wms/compras-manuais.test.ts` | unit (pura) |
| `test/integration/compras-manuais.integration.test.ts` | lifecycle contra staging |
| `src/app/api/wms/compras-manuais/route.ts` | POST criar + GET listar |
| `src/app/api/wms/compras-manuais/[id]/receber/route.ts` | POST receber |
| `src/app/api/wms/compras-manuais/[id]/route.ts` | DELETE cancelar |
| `src/app/api/wms/compras-manuais/fornecedor/route.ts` | POST inline fornecedor (`compras.executar`) |
| `src/app/api/wms/compras-manuais/produto/route.ts` | POST inline produto (`compras.executar`) |
| `src/components/wms/compras/nova-compra-manual-modal.tsx` | modal de criação |
| `src/components/wms/compras/aba-manuais.tsx` | aba listar + receber |
| `src/app/wms/compras/page.tsx` | wire: Tab "manuais" + botão |
| `docs/api-reference-complete.md`, `docs/database-schema.md`, `CLAUDE.md` | docs |

---

## Task 1: Migration — 2 tabelas

**Files:**
- Create: `supabase/migrations/20260611c_compra_manual.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Compra manual de fornecedor (compra avulsa, sem pedido de cliente).
-- Aggregate dedicado: cabeçalho + itens. O movimento de entrada reusa
-- origem_tipo='nf_compra' (whitelist de custo médio) distinguido por
-- origem_detalhes.origem='compra_manual'. Acesso só via service role (sem RLS,
-- consistente com as demais tabelas operacionais siso_*).
BEGIN;

CREATE TABLE IF NOT EXISTS siso_compras_manuais (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id         uuid NOT NULL REFERENCES siso_fornecedores(id),
  empresa_compradora_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id             uuid NOT NULL REFERENCES siso_galpoes(id),
  status                text NOT NULL DEFAULT 'comprado'
                          CHECK (status IN ('comprado','parcial','recebido','cancelado')),
  observacao            text,
  criado_por            uuid REFERENCES siso_usuarios(id),
  criado_em             timestamptz NOT NULL DEFAULT now(),
  recebido_em           timestamptz
);

CREATE TABLE IF NOT EXISTS siso_compras_manuais_itens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id      uuid NOT NULL REFERENCES siso_compras_manuais(id) ON DELETE CASCADE,
  produto_id     uuid NOT NULL REFERENCES siso_produtos(id),
  qty_comprada   numeric NOT NULL CHECK (qty_comprada > 0),
  qty_recebida   numeric NOT NULL DEFAULT 0 CHECK (qty_recebida >= 0),
  custo_unitario numeric,
  CHECK (qty_recebida <= qty_comprada)
);

CREATE INDEX IF NOT EXISTS idx_compras_manuais_status ON siso_compras_manuais(status);
CREATE INDEX IF NOT EXISTS idx_compras_manuais_itens_compra ON siso_compras_manuais_itens(compra_id);
CREATE INDEX IF NOT EXISTS idx_compras_manuais_itens_produto ON siso_compras_manuais_itens(produto_id);

COMMIT;
```

- [ ] **Step 2: Aplicar no staging**

Aplicar via MCP (project `ehbxpbeijofxtsbezwxd`):
- `mcp__supabase__apply_migration` com `name="20260611c_compra_manual"` e `query=` (conteúdo SQL acima).
- Fallback (MCP não conectado): `POST https://api.supabase.com/v1/projects/ehbxpbeijofxtsbezwxd/database/query` com header `Authorization: Bearer $SUPABASE_ACCESS_TOKEN` e body `{"query": "<SQL>"}`.

- [ ] **Step 3: Verificar tabelas existem**

Run (via `mcp__supabase__execute_sql` no project `ehbxpbeijofxtsbezwxd`):
```sql
SELECT count(*) FROM siso_compras_manuais;
SELECT count(*) FROM siso_compras_manuais_itens;
```
Expected: ambas retornam `0` (tabelas vazias criadas).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260611c_compra_manual.sql
git commit -m "feat(compras): tabelas siso_compras_manuais + itens (compra manual)"
```

---

## Task 2: Domínio — types + `computeStatusCompra` (pura, TDD)

**Files:**
- Create: `src/lib/wms/compras-manuais.ts`
- Test: `src/lib/wms/compras-manuais.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/wms/compras-manuais.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeStatusCompra } from "./compras-manuais";

describe("computeStatusCompra", () => {
  it("nada recebido → comprado", () => {
    expect(
      computeStatusCompra([
        { qty_comprada: 5, qty_recebida: 0 },
        { qty_comprada: 3, qty_recebida: 0 },
      ]),
    ).toBe("comprado");
  });

  it("parte recebida → parcial", () => {
    expect(
      computeStatusCompra([
        { qty_comprada: 5, qty_recebida: 2 },
        { qty_comprada: 3, qty_recebida: 0 },
      ]),
    ).toBe("parcial");
  });

  it("um item completo e outro pendente → parcial", () => {
    expect(
      computeStatusCompra([
        { qty_comprada: 5, qty_recebida: 5 },
        { qty_comprada: 3, qty_recebida: 0 },
      ]),
    ).toBe("parcial");
  });

  it("tudo recebido → recebido", () => {
    expect(
      computeStatusCompra([
        { qty_comprada: 5, qty_recebida: 5 },
        { qty_comprada: 3, qty_recebida: 3 },
      ]),
    ).toBe("recebido");
  });

  it("lista vazia → comprado (fallback defensivo)", () => {
    expect(computeStatusCompra([])).toBe("comprado");
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run src/lib/wms/compras-manuais.test.ts`
Expected: FAIL — `Failed to resolve import "./compras-manuais"` / `computeStatusCompra is not a function`.

- [ ] **Step 3: Implementação mínima**

`src/lib/wms/compras-manuais.ts`:
```ts
import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { resolverCustoEntrada } from "@/lib/wms/custo-fallback";
import { logger } from "@/lib/logger";

export type StatusCompraManual = "comprado" | "parcial" | "recebido" | "cancelado";

export interface CompraManualItemInput {
  produto_id: string;
  qty_comprada: number;
  custo_unitario?: number | null;
}

export interface CriarCompraManualInput {
  fornecedor_id: string;
  empresa_compradora_id: string;
  galpao_id: string;
  observacao?: string | null;
  itens: CompraManualItemInput[];
  criado_por: string;
}

/**
 * Status do cabeçalho derivado das quantidades dos itens.
 * Pura — não toca DB. (cancelado é setado explicitamente, nunca derivado aqui.)
 */
export function computeStatusCompra(
  itens: { qty_comprada: number; qty_recebida: number }[],
): "comprado" | "parcial" | "recebido" {
  if (itens.length === 0) return "comprado";
  const algoRecebido = itens.some((i) => Number(i.qty_recebida) > 0);
  const tudoRecebido = itens.every(
    (i) => Number(i.qty_recebida) >= Number(i.qty_comprada),
  );
  if (tudoRecebido) return "recebido";
  if (algoRecebido) return "parcial";
  return "comprado";
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx vitest run src/lib/wms/compras-manuais.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/compras-manuais.ts src/lib/wms/compras-manuais.test.ts
git commit -m "feat(compras): computeStatusCompra + types da compra manual"
```

---

## Task 3: Domínio — `criarCompraManual` + `listarComprasManuais`

**Files:**
- Modify: `src/lib/wms/compras-manuais.ts`

- [ ] **Step 1: Adicionar `criarCompraManual`**

Append em `src/lib/wms/compras-manuais.ts`:
```ts
export interface CriarCompraManualResult {
  compra_id: string;
  itens_criados: number;
}

/**
 * Cria o cabeçalho + itens de uma compra manual. Status inicial 'comprado'.
 * Valida fornecedor/empresa/galpão e produtos antes de inserir.
 */
export async function criarCompraManual(
  input: CriarCompraManualInput,
): Promise<CriarCompraManualResult> {
  const sb = createServiceClient();

  if (!input.itens || input.itens.length === 0) {
    throw new Error("envie ao menos 1 item");
  }
  for (const it of input.itens) {
    if (!it.produto_id) throw new Error("item sem produto_id");
    if (!(Number(it.qty_comprada) > 0)) {
      throw new Error("qty_comprada deve ser > 0");
    }
  }

  // Valida FKs com mensagens claras (em vez de erro cru de constraint).
  const { data: forn } = await sb
    .from("siso_fornecedores")
    .select("id")
    .eq("id", input.fornecedor_id)
    .maybeSingle();
  if (!forn) throw new Error(`fornecedor ${input.fornecedor_id} não encontrado`);

  const { data: emp } = await sb
    .from("siso_empresas")
    .select("id")
    .eq("id", input.empresa_compradora_id)
    .maybeSingle();
  if (!emp) throw new Error(`empresa ${input.empresa_compradora_id} não encontrada`);

  const { data: galp } = await sb
    .from("siso_galpoes")
    .select("id")
    .eq("id", input.galpao_id)
    .maybeSingle();
  if (!galp) throw new Error(`galpão ${input.galpao_id} não encontrado`);

  const { data: header, error: headerErr } = await sb
    .from("siso_compras_manuais")
    .insert({
      fornecedor_id: input.fornecedor_id,
      empresa_compradora_id: input.empresa_compradora_id,
      galpao_id: input.galpao_id,
      observacao: input.observacao ?? null,
      status: "comprado",
      criado_por: input.criado_por,
    })
    .select("id")
    .single();
  if (headerErr || !header) {
    throw new Error(`falha ao criar compra: ${headerErr?.message ?? "sem id"}`);
  }
  const compraId = (header as { id: string }).id;

  const linhas = input.itens.map((it) => ({
    compra_id: compraId,
    produto_id: it.produto_id,
    qty_comprada: Number(it.qty_comprada),
    qty_recebida: 0,
    custo_unitario:
      it.custo_unitario != null ? Number(it.custo_unitario) : null,
  }));
  const { error: itensErr } = await sb
    .from("siso_compras_manuais_itens")
    .insert(linhas);
  if (itensErr) {
    // Rollback best-effort do cabeçalho órfão.
    await sb.from("siso_compras_manuais").delete().eq("id", compraId);
    throw new Error(`falha ao criar itens: ${itensErr.message}`);
  }

  return { compra_id: compraId, itens_criados: linhas.length };
}
```

- [ ] **Step 2: Adicionar `listarComprasManuais`**

Append em `src/lib/wms/compras-manuais.ts`:
```ts
export interface CompraManualListItem {
  id: string;
  status: StatusCompraManual;
  observacao: string | null;
  criado_em: string;
  recebido_em: string | null;
  galpao_id: string;
  fornecedor: { id: string; nome: string } | null;
  empresa: { id: string; nome: string } | null;
  itens: Array<{
    id: string;
    produto_id: string;
    sku: string;
    descricao: string;
    qty_comprada: number;
    qty_recebida: number;
    custo_unitario: number | null;
  }>;
}

/** filtro: 'pendentes' = comprado+parcial; 'recebido'; 'cancelado'. */
export async function listarComprasManuais(
  filtro: "pendentes" | "recebido" | "cancelado",
): Promise<CompraManualListItem[]> {
  const sb = createServiceClient();
  let query = sb
    .from("siso_compras_manuais")
    .select(
      `id, status, observacao, criado_em, recebido_em, galpao_id,
       fornecedor:siso_fornecedores(id, nome),
       empresa:siso_empresas(id, nome),
       itens:siso_compras_manuais_itens(
         id, produto_id, qty_comprada, qty_recebida, custo_unitario,
         produto:siso_produtos(sku, descricao)
       )`,
    )
    .order("criado_em", { ascending: false });

  if (filtro === "pendentes") {
    query = query.in("status", ["comprado", "parcial"]);
  } else {
    query = query.eq("status", filtro);
  }

  const { data, error } = await query;
  if (error) throw error;

  type Row = {
    id: string;
    status: StatusCompraManual;
    observacao: string | null;
    criado_em: string;
    recebido_em: string | null;
    galpao_id: string;
    fornecedor: { id: string; nome: string } | null;
    empresa: { id: string; nome: string } | null;
    itens: Array<{
      id: string;
      produto_id: string;
      qty_comprada: number;
      qty_recebida: number;
      custo_unitario: number | null;
      produto: { sku: string; descricao: string } | null;
    }>;
  };

  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    status: r.status,
    observacao: r.observacao,
    criado_em: r.criado_em,
    recebido_em: r.recebido_em,
    galpao_id: r.galpao_id,
    fornecedor: r.fornecedor,
    empresa: r.empresa,
    itens: (r.itens ?? []).map((it) => ({
      id: it.id,
      produto_id: it.produto_id,
      sku: it.produto?.sku ?? "",
      descricao: it.produto?.descricao ?? "",
      qty_comprada: Number(it.qty_comprada),
      qty_recebida: Number(it.qty_recebida),
      custo_unitario: it.custo_unitario != null ? Number(it.custo_unitario) : null,
    })),
  }));
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros nos arquivos novos.

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/compras-manuais.ts
git commit -m "feat(compras): criarCompraManual + listarComprasManuais"
```

---

## Task 4: Domínio — `receberCompraManual` + mov de entrada (integration)

**Files:**
- Modify: `src/lib/wms/compras-manuais.ts`
- Test: `test/integration/compras-manuais.integration.test.ts`

- [ ] **Step 1: Adicionar helper de mov + `receberCompraManual`**

Append em `src/lib/wms/compras-manuais.ts`:
```ts
export interface ReceberCompraManualInput {
  compra_id: string;
  usuario_id: string;
  itens: Array<{
    item_id: string;
    qty_recebida: number;
    custo_unitario?: number | null;
  }>;
}

export interface ReceberCompraManualResult {
  movs_geradas: number;
  status: StatusCompraManual;
}

/**
 * Grava mov E (origem_tipo='nf_compra', sem NF) pra um item de compra manual.
 * Distingue manual via origem_detalhes.origem='compra_manual'. A loc é a
 * RECEBIMENTO do galpão. resolverCustoEntrada lança se não houver custo
 * informado nem histórico (produto novo sem custo) — guard P108.
 */
async function gravarMovEntradaCompraManual(args: {
  produto_id: string;
  galpao_id: string;
  fornecedor_id: string;
  empresa_compradora_id: string;
  qty: number;
  custo_unitario: number | null;
  compra_id: string;
  compra_item_id: string;
  usuario_id: string;
}): Promise<void> {
  const sb = createServiceClient();

  const { data: loc } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", args.galpao_id)
    .eq("tipo", "recebimento")
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();
  const locId = (loc as { id?: string } | null)?.id;
  if (!locId) {
    throw new Error(
      `galpão ${args.galpao_id} sem loc tipo='recebimento' ativa — semear DEFAULT-RECEBIMENTO`,
    );
  }

  const custoResolvido = await resolverCustoEntrada({
    produto_id: args.produto_id,
    custo_informado: args.custo_unitario ?? 0,
  });

  await inserirMovimentacao({
    tripla: {
      produto_id: args.produto_id,
      galpao_id: args.galpao_id,
      localizacao_id: locId,
    },
    tipo: "E",
    qty: args.qty,
    origem_tipo: "nf_compra",
    origem_id: args.compra_id,
    origem_detalhes: {
      origem: "compra_manual",
      compra_id: args.compra_id,
      compra_item_id: args.compra_item_id,
    },
    empresa_compradora_id: args.empresa_compradora_id,
    fornecedor_id: args.fornecedor_id,
    custo_unitario: custoResolvido,
    motivo: `Compra manual ${args.compra_id}`,
    usuario_id: args.usuario_id,
  });
}

/**
 * Recebe itens de uma compra manual. Por item:
 *  1. lock otimista no qty_recebida (detecta dupla-recepção concorrente),
 *  2. grava mov E; se falhar, REVERTE o qty bump e relança (consistência),
 *  3. recomputa status do cabeçalho.
 */
export async function receberCompraManual(
  input: ReceberCompraManualInput,
): Promise<ReceberCompraManualResult> {
  const sb = createServiceClient();

  const { data: compra } = await sb
    .from("siso_compras_manuais")
    .select("id, status, galpao_id, fornecedor_id, empresa_compradora_id")
    .eq("id", input.compra_id)
    .maybeSingle();
  if (!compra) throw new Error(`compra ${input.compra_id} não encontrada`);
  const c = compra as {
    id: string;
    status: StatusCompraManual;
    galpao_id: string;
    fornecedor_id: string;
    empresa_compradora_id: string;
  };
  if (c.status === "cancelado") {
    throw new Error("compra cancelada não pode receber");
  }

  let movsGeradas = 0;

  for (const reqItem of input.itens) {
    const qty = Number(reqItem.qty_recebida);
    if (!(qty > 0)) continue;

    const { data: item } = await sb
      .from("siso_compras_manuais_itens")
      .select("id, produto_id, qty_comprada, qty_recebida, custo_unitario")
      .eq("id", reqItem.item_id)
      .eq("compra_id", input.compra_id)
      .maybeSingle();
    if (!item) {
      throw new Error(`item ${reqItem.item_id} não pertence à compra`);
    }
    const it = item as {
      id: string;
      produto_id: string;
      qty_comprada: number;
      qty_recebida: number;
      custo_unitario: number | null;
    };
    const jaRecebido = Number(it.qty_recebida);
    const faltante = Number(it.qty_comprada) - jaRecebido;
    if (faltante <= 0) continue;
    if (qty > faltante) {
      throw new Error(
        `item ${it.id}: qty ${qty} excede faltante ${faltante}`,
      );
    }

    const novoRecebido = jaRecebido + qty;
    const custoItem = reqItem.custo_unitario ?? it.custo_unitario ?? null;

    // 1) lock otimista
    const { data: updated, error: updErr } = await sb
      .from("siso_compras_manuais_itens")
      .update({ qty_recebida: novoRecebido, custo_unitario: custoItem })
      .eq("id", it.id)
      .eq("qty_recebida", jaRecebido)
      .select("id");
    if (updErr) throw new Error(`falha ao atualizar item: ${updErr.message}`);
    if (!updated || updated.length === 0) {
      throw new Error(
        `item ${it.id}: recebimento concorrente detectado — recarregue e tente de novo`,
      );
    }

    // 2) mov E; se falhar, reverte o bump
    try {
      await gravarMovEntradaCompraManual({
        produto_id: it.produto_id,
        galpao_id: c.galpao_id,
        fornecedor_id: c.fornecedor_id,
        empresa_compradora_id: c.empresa_compradora_id,
        qty,
        custo_unitario: custoItem,
        compra_id: c.id,
        compra_item_id: it.id,
        usuario_id: input.usuario_id,
      });
      movsGeradas++;
    } catch (movErr) {
      await sb
        .from("siso_compras_manuais_itens")
        .update({ qty_recebida: jaRecebido })
        .eq("id", it.id);
      logger.error("compras-manuais", "falha mov E — bump revertido", {
        compra_id: c.id,
        item_id: it.id,
        error: movErr instanceof Error ? movErr.message : String(movErr),
      });
      throw movErr;
    }
  }

  // 3) recomputa status
  const { data: todos } = await sb
    .from("siso_compras_manuais_itens")
    .select("qty_comprada, qty_recebida")
    .eq("compra_id", input.compra_id);
  const novoStatus = computeStatusCompra(
    ((todos ?? []) as { qty_comprada: number; qty_recebida: number }[]).map((x) => ({
      qty_comprada: Number(x.qty_comprada),
      qty_recebida: Number(x.qty_recebida),
    })),
  );
  await sb
    .from("siso_compras_manuais")
    .update({
      status: novoStatus,
      recebido_em: novoStatus === "recebido" ? new Date().toISOString() : null,
    })
    .eq("id", input.compra_id);

  return { movs_geradas: movsGeradas, status: novoStatus };
}
```

- [ ] **Step 2: Escrever o teste de integração (lifecycle)**

`test/integration/compras-manuais.integration.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import {
  criarCompraManual,
  receberCompraManual,
} from "../../src/lib/wms/compras-manuais";

const sb = createServiceClient();
const RND = Math.random().toString(36).slice(2, 7);
let galpaoId: string, usuarioId: string, empresaId: string, fornecedorId: string, produtoId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = emp!.id;
  const { data: forn } = await sb
    .from("siso_fornecedores")
    .insert({ nome: `Forn Manual ${RND}` })
    .select("id")
    .single();
  fornecedorId = forn!.id;
  // produto novo COM custo informado depois no recebimento (evita guard P108).
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `CM-${RND}`, descricao: "compra manual test", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;
});

describe("compra manual — lifecycle", () => {
  it("criar → receber parcial → receber resto → estoque sobe e status=recebido", async () => {
    const { compra_id } = await criarCompraManual({
      fornecedor_id: fornecedorId,
      empresa_compradora_id: empresaId,
      galpao_id: galpaoId,
      criado_por: usuarioId,
      itens: [{ produto_id: produtoId, qty_comprada: 10 }],
    });

    // recebe 4 (parcial)
    const r1 = await receberCompraManual({
      compra_id,
      usuario_id: usuarioId,
      itens: [{ item_id: await primeiroItemId(compra_id), qty_recebida: 4, custo_unitario: 12 }],
    });
    expect(r1.status).toBe("parcial");

    // recebe 6 (completa)
    const r2 = await receberCompraManual({
      compra_id,
      usuario_id: usuarioId,
      itens: [{ item_id: await primeiroItemId(compra_id), qty_recebida: 6, custo_unitario: 12 }],
    });
    expect(r2.status).toBe("recebido");

    // estoque do produto no galpão = 10
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId);
    const total = (est ?? []).reduce((s, e) => s + Number((e as { saldo: number }).saldo), 0);
    expect(total).toBe(10);

    // custo médio = 12
    const { data: cm } = await sb
      .from("siso_custo_medio")
      .select("custo_medio")
      .eq("produto_id", produtoId)
      .maybeSingle();
    expect(Number((cm as { custo_medio: number } | null)?.custo_medio ?? 0)).toBe(12);
  });

  it("receber além do faltante lança", async () => {
    const { compra_id } = await criarCompraManual({
      fornecedor_id: fornecedorId,
      empresa_compradora_id: empresaId,
      galpao_id: galpaoId,
      criado_por: usuarioId,
      itens: [{ produto_id: produtoId, qty_comprada: 2 }],
    });
    await expect(
      receberCompraManual({
        compra_id,
        usuario_id: usuarioId,
        itens: [{ item_id: await primeiroItemId(compra_id), qty_recebida: 5, custo_unitario: 12 }],
      }),
    ).rejects.toThrow();
  });
});

async function primeiroItemId(compraId: string): Promise<string> {
  const { data } = await sb
    .from("siso_compras_manuais_itens")
    .select("id")
    .eq("compra_id", compraId)
    .limit(1)
    .single();
  return (data as { id: string }).id;
}
```

- [ ] **Step 3: Rodar a integração**

Run: `npx vitest run -c vitest.integration.config.ts test/integration/compras-manuais.integration.test.ts`
Expected: PASS (2 testes). Pré-requisitos: `.env.test.local` com service-role real; galpão "CWB" e usuário "test-runner" semeados no staging (já existem — usados pelos outros integration tests).

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/compras-manuais.ts test/integration/compras-manuais.integration.test.ts
git commit -m "feat(compras): receberCompraManual + mov E (origem_tipo nf_compra)"
```

---

## Task 5: Domínio — `cancelarCompraManual`

**Files:**
- Modify: `src/lib/wms/compras-manuais.ts`

- [ ] **Step 1: Adicionar `cancelarCompraManual`**

Append em `src/lib/wms/compras-manuais.ts`:
```ts
export type CancelarResult =
  | { ok: true }
  | { ok: false; reason: "nao_encontrada" | "tem_recebimento" | "ja_cancelada" };

/** Cancela uma compra manual. Bloqueado se qualquer item já tem qty_recebida > 0. */
export async function cancelarCompraManual(
  compraId: string,
): Promise<CancelarResult> {
  const sb = createServiceClient();

  const { data: compra } = await sb
    .from("siso_compras_manuais")
    .select("id, status")
    .eq("id", compraId)
    .maybeSingle();
  if (!compra) return { ok: false, reason: "nao_encontrada" };
  if ((compra as { status: string }).status === "cancelado") {
    return { ok: false, reason: "ja_cancelada" };
  }

  const { data: itens } = await sb
    .from("siso_compras_manuais_itens")
    .select("qty_recebida")
    .eq("compra_id", compraId);
  const temRecebimento = ((itens ?? []) as { qty_recebida: number }[]).some(
    (i) => Number(i.qty_recebida) > 0,
  );
  if (temRecebimento) return { ok: false, reason: "tem_recebimento" };

  await sb
    .from("siso_compras_manuais")
    .update({ status: "cancelado" })
    .eq("id", compraId);
  return { ok: true };
}
```

- [ ] **Step 2: Adicionar teste de integração de cancelamento**

Append no `describe("compra manual — lifecycle", ...)` de `test/integration/compras-manuais.integration.test.ts`:
```ts
  it("cancela sem recebimento; bloqueia cancelar com recebimento", async () => {
    const { cancelarCompraManual } = await import("../../src/lib/wms/compras-manuais");
    // sem recebimento → ok
    const { compra_id: a } = await criarCompraManual({
      fornecedor_id: fornecedorId,
      empresa_compradora_id: empresaId,
      galpao_id: galpaoId,
      criado_por: usuarioId,
      itens: [{ produto_id: produtoId, qty_comprada: 1 }],
    });
    expect(await cancelarCompraManual(a)).toEqual({ ok: true });
    // com recebimento → bloqueia
    const { compra_id: b } = await criarCompraManual({
      fornecedor_id: fornecedorId,
      empresa_compradora_id: empresaId,
      galpao_id: galpaoId,
      criado_por: usuarioId,
      itens: [{ produto_id: produtoId, qty_comprada: 2 }],
    });
    await receberCompraManual({
      compra_id: b,
      usuario_id: usuarioId,
      itens: [{ item_id: await primeiroItemId(b), qty_recebida: 1, custo_unitario: 12 }],
    });
    expect(await cancelarCompraManual(b)).toEqual({ ok: false, reason: "tem_recebimento" });
  });
```

- [ ] **Step 3: Rodar a integração**

Run: `npx vitest run -c vitest.integration.config.ts test/integration/compras-manuais.integration.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/compras-manuais.ts test/integration/compras-manuais.integration.test.ts
git commit -m "feat(compras): cancelarCompraManual (bloqueia com recebimento)"
```

---

## Task 6: Rota — `POST` criar + `GET` listar

**Files:**
- Create: `src/app/api/wms/compras-manuais/route.ts`

- [ ] **Step 1: Escrever a rota**

`src/app/api/wms/compras-manuais/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import {
  criarCompraManual,
  listarComprasManuais,
} from "@/lib/wms/compras-manuais";

export async function GET(req: NextRequest) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.ver")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const status = req.nextUrl.searchParams.get("status");
  const filtro =
    status === "recebido" || status === "cancelado" ? status : "pendentes";
  try {
    return NextResponse.json({ rows: await listarComprasManuais(filtro) });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.listar",
      error: e,
      requestPath: "/api/wms/compras-manuais",
      requestMethod: "GET",
    });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const body = await req.json();
  if (!body.fornecedor_id || !body.empresa_compradora_id || !body.galpao_id) {
    return NextResponse.json(
      { error: "fornecedor_id, empresa_compradora_id e galpao_id são obrigatórios" },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.itens) || body.itens.length === 0) {
    return NextResponse.json(
      { error: "envie { itens: [{ produto_id, qty_comprada }] }" },
      { status: 400 },
    );
  }
  try {
    const r = await criarCompraManual({
      fornecedor_id: body.fornecedor_id,
      empresa_compradora_id: body.empresa_compradora_id,
      galpao_id: body.galpao_id,
      observacao: body.observacao ?? null,
      criado_por: session.id,
      itens: body.itens.map((it: { produto_id: string; qty_comprada: number; custo_unitario?: number }) => ({
        produto_id: it.produto_id,
        qty_comprada: Number(it.qty_comprada),
        custo_unitario: it.custo_unitario != null ? Number(it.custo_unitario) : null,
      })),
    });
    return NextResponse.json({ ok: true, ...r }, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.criar",
      error: e,
      status: 400,
      requestPath: "/api/wms/compras-manuais",
      requestMethod: "POST",
    });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/compras-manuais/route.ts
git commit -m "feat(compras): rota POST/GET /api/wms/compras-manuais"
```

---

## Task 7: Rota — `POST [id]/receber`

**Files:**
- Create: `src/app/api/wms/compras-manuais/[id]/receber/route.ts`

- [ ] **Step 1: Escrever a rota**

`src/app/api/wms/compras-manuais/[id]/receber/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { receberCompraManual } from "@/lib/wms/compras-manuais";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json();
  if (!Array.isArray(body.itens) || body.itens.length === 0) {
    return NextResponse.json(
      { error: "envie { itens: [{ item_id, qty_recebida }] }" },
      { status: 400 },
    );
  }
  try {
    const r = await receberCompraManual({
      compra_id: id,
      usuario_id: session.id,
      itens: body.itens.map((it: { item_id: string; qty_recebida: number; custo_unitario?: number }) => ({
        item_id: it.item_id,
        qty_recebida: Number(it.qty_recebida),
        custo_unitario: it.custo_unitario != null ? Number(it.custo_unitario) : null,
      })),
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.receber",
      error: e,
      status: 400,
      requestPath: `/api/wms/compras-manuais/${id}/receber`,
      requestMethod: "POST",
    });
  }
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` (Expected: sem erros)
```bash
git add src/app/api/wms/compras-manuais/[id]/receber/route.ts
git commit -m "feat(compras): rota POST receber da compra manual"
```

---

## Task 8: Rota — `DELETE [id]` cancelar

**Files:**
- Create: `src/app/api/wms/compras-manuais/[id]/route.ts`

- [ ] **Step 1: Escrever a rota**

`src/app/api/wms/compras-manuais/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { cancelarCompraManual } from "@/lib/wms/compras-manuais";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const { id } = await params;
  try {
    const r = await cancelarCompraManual(id);
    if (r.ok) return NextResponse.json({ ok: true });
    const statusMap: Record<string, number> = {
      nao_encontrada: 404,
      tem_recebimento: 409,
      ja_cancelada: 409,
    };
    return NextResponse.json({ error: r.reason }, { status: statusMap[r.reason] ?? 400 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.cancelar",
      error: e,
      requestPath: `/api/wms/compras-manuais/${id}`,
      requestMethod: "DELETE",
    });
  }
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` (Expected: sem erros)
```bash
git add src/app/api/wms/compras-manuais/[id]/route.ts
git commit -m "feat(compras): rota DELETE cancelar compra manual"
```

---

## Task 9: Rotas inline-create — fornecedor + produto (`compras.executar`)

**Files:**
- Create: `src/app/api/wms/compras-manuais/fornecedor/route.ts`
- Create: `src/app/api/wms/compras-manuais/produto/route.ts`

- [ ] **Step 1: Rota fornecedor inline**

`src/app/api/wms/compras-manuais/fornecedor/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { criarFornecedor } from "@/lib/wms/fornecedores";

// Criação inline de fornecedor a partir do modal de compra manual.
// Guard compras.executar (operador), não requireAdmin como /api/wms/fornecedores.
export async function POST(req: NextRequest) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const body = await req.json();
  if (!body.nome || typeof body.nome !== "string") {
    return NextResponse.json({ error: "nome obrigatório" }, { status: 400 });
  }
  try {
    const f = await criarFornecedor({
      nome: body.nome,
      cnpj: typeof body.cnpj === "string" && body.cnpj ? body.cnpj : undefined,
    });
    return NextResponse.json(f, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.fornecedor",
      error: e,
      status: 400,
      requestPath: "/api/wms/compras-manuais/fornecedor",
      requestMethod: "POST",
    });
  }
}
```

- [ ] **Step 2: Rota produto inline**

`src/app/api/wms/compras-manuais/produto/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { criarProduto } from "@/lib/wms/produtos";

// Criação inline de produto mínimo (sku+descrição) a partir do modal de compra
// manual. Sem dados fiscais — Tiny é a camada fiscal. Guard compras.executar.
export async function POST(req: NextRequest) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const body = await req.json();
  if (!body.sku || !body.descricao) {
    return NextResponse.json({ error: "sku e descricao obrigatórios" }, { status: 400 });
  }
  try {
    const p = await criarProduto({ sku: body.sku, descricao: body.descricao });
    return NextResponse.json(p, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.produto",
      error: e,
      status: 400,
      requestPath: "/api/wms/compras-manuais/produto",
      requestMethod: "POST",
    });
  }
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit` (Expected: sem erros)
```bash
git add src/app/api/wms/compras-manuais/fornecedor/route.ts src/app/api/wms/compras-manuais/produto/route.ts
git commit -m "feat(compras): rotas inline-create fornecedor/produto (compras.executar)"
```

---

## Task 10: Frontend — modal de criação

**Files:**
- Create: `src/components/wms/compras/nova-compra-manual-modal.tsx`

Reusa `ProdutoCombo` e `useGalpoes` de `@/components/wms/ui/modals`. Galpão → empresas vêm aninhadas em `useGalpoes()`. Empresa: união deduplicada das empresas de todos os galpões.

- [ ] **Step 1: Escrever o componente**

`src/components/wms/compras/nova-compra-manual-modal.tsx`:
```tsx
"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { ProdutoCombo, useGalpoes } from "@/components/wms/ui/modals";
import type { Produto } from "@/lib/wms/types";

interface FornecedorLite {
  id: string;
  nome: string;
}
interface LinhaItem {
  produto: Produto | null;
  qty: string;
  custo: string;
}

export function NovaCompraManualModal({
  galpaoAtivo,
  onClose,
}: {
  galpaoAtivo: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: galpoes } = useGalpoes();

  const empresas = useMemo(() => {
    const map = new Map<string, { id: string; nome: string }>();
    (galpoes ?? []).forEach((g) =>
      g.empresas.forEach((e) => map.set(e.id, { id: e.id, nome: e.nome })),
    );
    return Array.from(map.values()).sort((a, b) => a.nome.localeCompare(b.nome));
  }, [galpoes]);

  const { data: fornData } = useQuery({
    queryKey: ["compras-manuais-fornecedores"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/fornecedores");
      if (!r.ok) throw new Error("falha ao listar fornecedores");
      return (await r.json()) as { rows: FornecedorLite[] };
    },
  });
  const fornecedores = fornData?.rows ?? [];

  const [galpaoId, setGalpaoId] = useState(galpaoAtivo ?? "");
  const [empresaId, setEmpresaId] = useState("");
  const [fornecedorId, setFornecedorId] = useState("");
  const [observacao, setObservacao] = useState("");
  const [linhas, setLinhas] = useState<LinhaItem[]>([{ produto: null, qty: "", custo: "" }]);

  // criar fornecedor inline
  const [novoForn, setNovoForn] = useState("");
  const criarFornMut = useMutation({
    mutationFn: async (nome: string) => {
      const r = await sisoFetch("/api/wms/compras-manuais/fornecedor", {
        method: "POST",
        body: JSON.stringify({ nome }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "falha");
      return (await r.json()) as FornecedorLite;
    },
    onSuccess: (f) => {
      toast.success(`Fornecedor "${f.nome}" criado`);
      qc.invalidateQueries({ queryKey: ["compras-manuais-fornecedores"] });
      setFornecedorId(f.id);
      setNovoForn("");
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  const criarMut = useMutation({
    mutationFn: async () => {
      const itens = linhas
        .filter((l) => l.produto && Number(l.qty) > 0)
        .map((l) => ({
          produto_id: l.produto!.id,
          qty_comprada: Number(l.qty),
          custo_unitario: l.custo ? Number(l.custo) : undefined,
        }));
      if (itens.length === 0) throw new Error("adicione ao menos 1 item com qty > 0");
      const r = await sisoFetch("/api/wms/compras-manuais", {
        method: "POST",
        body: JSON.stringify({
          fornecedor_id: fornecedorId,
          empresa_compradora_id: empresaId,
          galpao_id: galpaoId,
          observacao: observacao || undefined,
          itens,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "falha ao criar compra");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Compra manual criada");
      qc.invalidateQueries({ queryKey: ["compras-manuais"] });
      onClose();
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  const podeEnviar = galpaoId && empresaId && fornecedorId && !criarMut.isPending;

  return (
    <div className="wms-modal-overlay" onClick={onClose}>
      <div
        className="wms-modal"
        style={{ maxWidth: 640 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="wms-modal-title">Nova compra manual</h2>

        <div className="wms-form-row">
          <label>Galpão</label>
          <select value={galpaoId} onChange={(e) => setGalpaoId(e.target.value)}>
            <option value="">selecione…</option>
            {(galpoes ?? []).map((g) => (
              <option key={g.id} value={g.id}>{g.nome}</option>
            ))}
          </select>
        </div>

        <div className="wms-form-row">
          <label>Empresa compradora</label>
          <select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)}>
            <option value="">selecione…</option>
            {empresas.map((e) => (
              <option key={e.id} value={e.id}>{e.nome}</option>
            ))}
          </select>
        </div>

        <div className="wms-form-row">
          <label>Fornecedor</label>
          <select value={fornecedorId} onChange={(e) => setFornecedorId(e.target.value)}>
            <option value="">selecione…</option>
            {fornecedores.map((f) => (
              <option key={f.id} value={f.id}>{f.nome}</option>
            ))}
          </select>
        </div>
        <div className="wms-form-row" style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="ou criar fornecedor…"
            value={novoForn}
            onChange={(e) => setNovoForn(e.target.value)}
          />
          <button
            className="wms-btn wms-btn-ghost"
            disabled={!novoForn.trim() || criarFornMut.isPending}
            onClick={() => criarFornMut.mutate(novoForn.trim())}
          >
            Criar
          </button>
        </div>

        <div className="wms-form-section">
          <label>Itens</label>
          {linhas.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <ProdutoCombo
                  value={l.produto}
                  onChange={(p) =>
                    setLinhas((prev) => prev.map((x, j) => (j === i ? { ...x, produto: p } : x)))
                  }
                />
              </div>
              <input
                style={{ width: 64 }}
                placeholder="qty"
                inputMode="numeric"
                value={l.qty}
                onChange={(e) =>
                  setLinhas((prev) => prev.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))
                }
              />
              <input
                style={{ width: 80 }}
                placeholder="custo"
                inputMode="decimal"
                value={l.custo}
                onChange={(e) =>
                  setLinhas((prev) => prev.map((x, j) => (j === i ? { ...x, custo: e.target.value } : x)))
                }
              />
              <button
                className="wms-btn-icon"
                onClick={() => setLinhas((prev) => prev.filter((_, j) => j !== i))}
                aria-label="remover"
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="wms-btn wms-btn-ghost"
            onClick={() => setLinhas((prev) => [...prev, { produto: null, qty: "", custo: "" }])}
          >
            + item
          </button>
        </div>

        <div className="wms-form-row">
          <label>Observação</label>
          <input value={observacao} onChange={(e) => setObservacao(e.target.value)} />
        </div>

        <div className="wms-modal-actions">
          <button className="wms-btn wms-btn-ghost" onClick={onClose}>Cancelar</button>
          <button
            className="wms-btn wms-btn-primary"
            disabled={!podeEnviar}
            onClick={() => criarMut.mutate()}
          >
            {criarMut.isPending ? "Criando…" : "Criar compra"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 1b: Adicionar criação de produto inline**

`ProdutoCombo` só busca produtos existentes. Para "criar produto na hora", adicionar um mini-form dentro da seção Itens. Ao criar, o produto entra como uma nova linha já selecionada.

1. Adicionar estado e mutation no componente (junto dos outros `useState`/`useMutation`):
```tsx
const [novoProdSku, setNovoProdSku] = useState("");
const [novoProdDesc, setNovoProdDesc] = useState("");
const criarProdMut = useMutation({
  mutationFn: async (vars: { sku: string; descricao: string }) => {
    const r = await sisoFetch("/api/wms/compras-manuais/produto", {
      method: "POST",
      body: JSON.stringify(vars),
    });
    if (!r.ok) throw new Error((await r.json()).error ?? "falha");
    return (await r.json()) as Produto;
  },
  onSuccess: (p) => {
    toast.success(`Produto "${p.sku}" criado`);
    setLinhas((prev) => [...prev, { produto: p, qty: "", custo: "" }]);
    setNovoProdSku("");
    setNovoProdDesc("");
  },
  onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
});
```

2. Adicionar o mini-form logo após o botão "+ item" (dentro de `wms-form-section`):
```tsx
<div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
  <input
    style={{ width: 120 }}
    placeholder="novo SKU…"
    value={novoProdSku}
    onChange={(e) => setNovoProdSku(e.target.value)}
  />
  <input
    style={{ flex: 1 }}
    placeholder="descrição…"
    value={novoProdDesc}
    onChange={(e) => setNovoProdDesc(e.target.value)}
  />
  <button
    className="wms-btn wms-btn-ghost"
    disabled={
      !novoProdSku.trim() || !novoProdDesc.trim() || criarProdMut.isPending
    }
    onClick={() =>
      criarProdMut.mutate({
        sku: novoProdSku.trim(),
        descricao: novoProdDesc.trim(),
      })
    }
  >
    Criar produto
  </button>
</div>
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros. Se `wms-modal-overlay`/`wms-modal`/`wms-form-row` não existirem em `wms.css`, usar as classes equivalentes já presentes (verificar `src/app/wms/wms.css` — procurar por `wms-modal`). Se não houver, adicionar estilos mínimos no `wms.css`.

- [ ] **Step 3: Commit**

```bash
git add src/components/wms/compras/nova-compra-manual-modal.tsx
git commit -m "feat(compras): modal Nova compra manual (reusa ProdutoCombo/useGalpoes)"
```

---

## Task 11: Frontend — aba "Manuais" (listar + receber)

**Files:**
- Create: `src/components/wms/compras/aba-manuais.tsx`

- [ ] **Step 1: Escrever o componente**

`src/components/wms/compras/aba-manuais.tsx`:
```tsx
"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { fmtDateTime, fmtNum } from "@/components/wms/ui/wms-ui";

interface CompraItem {
  id: string;
  sku: string;
  descricao: string;
  qty_comprada: number;
  qty_recebida: number;
  custo_unitario: number | null;
}
interface Compra {
  id: string;
  status: string;
  observacao: string | null;
  criado_em: string;
  fornecedor: { id: string; nome: string } | null;
  empresa: { id: string; nome: string } | null;
  itens: CompraItem[];
}

export function AbaManuais() {
  const qc = useQueryClient();
  const [filtro, setFiltro] = useState<"pendentes" | "recebido" | "cancelado">("pendentes");
  const { data, isLoading } = useQuery({
    queryKey: ["compras-manuais", filtro],
    queryFn: () => wmsApi<{ rows: Compra[] }>(`/api/wms/compras-manuais?status=${filtro}`),
  });

  const [recebendo, setRecebendo] = useState<Record<string, string>>({}); // item_id → qty

  const receberMut = useMutation({
    mutationFn: async (compra: Compra) => {
      const itens = compra.itens
        .map((it) => ({ item_id: it.id, qty_recebida: Number(recebendo[it.id] ?? 0) }))
        .filter((x) => x.qty_recebida > 0);
      if (itens.length === 0) throw new Error("informe a qty recebida em ao menos 1 item");
      const r = await sisoFetch(`/api/wms/compras-manuais/${compra.id}/receber`, {
        method: "POST",
        body: JSON.stringify({ itens }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "falha ao receber");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Recebimento registrado");
      setRecebendo({});
      qc.invalidateQueries({ queryKey: ["compras-manuais"] });
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  const cancelarMut = useMutation({
    mutationFn: async (compraId: string) => {
      const r = await sisoFetch(`/api/wms/compras-manuais/${compraId}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error ?? "falha ao cancelar");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Compra cancelada");
      qc.invalidateQueries({ queryKey: ["compras-manuais"] });
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  const compras = data?.rows ?? [];

  return (
    <div className="wms-aba-manuais">
      <div className="wms-tabs" style={{ marginBottom: 12 }}>
        {(["pendentes", "recebido", "cancelado"] as const).map((f) => (
          <button
            key={f}
            className={`wms-tab ${filtro === f ? "is-active" : ""}`}
            onClick={() => setFiltro(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {isLoading && <div className="wms-td-mute">carregando…</div>}
      {!isLoading && compras.length === 0 && (
        <div className="wms-empty">nenhuma compra manual</div>
      )}

      {compras.map((c) => (
        <div key={c.id} className="wms-card" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>{c.fornecedor?.nome ?? "—"}</strong>{" "}
              <span className="wms-td-mute">· {c.empresa?.nome ?? "—"}</span>{" "}
              <span className="wms-badge">{c.status}</span>
            </div>
            <span className="wms-td-mute" style={{ fontSize: 12 }}>{fmtDateTime(c.criado_em)}</span>
          </div>

          <table className="wms-table" style={{ marginTop: 8 }}>
            <thead>
              <tr><th>SKU</th><th>Comprado</th><th>Recebido</th><th>Receber</th></tr>
            </thead>
            <tbody>
              {c.itens.map((it) => {
                const faltante = it.qty_comprada - it.qty_recebida;
                return (
                  <tr key={it.id}>
                    <td className="wms-mono">{it.sku}</td>
                    <td>{fmtNum(it.qty_comprada)}</td>
                    <td>{fmtNum(it.qty_recebida)}</td>
                    <td>
                      {c.status !== "recebido" && c.status !== "cancelado" && faltante > 0 ? (
                        <input
                          style={{ width: 64 }}
                          inputMode="numeric"
                          placeholder={`máx ${faltante}`}
                          value={recebendo[it.id] ?? ""}
                          onChange={(e) =>
                            setRecebendo((prev) => ({ ...prev, [it.id]: e.target.value }))
                          }
                        />
                      ) : (
                        <span className="wms-td-mute">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {c.status !== "recebido" && c.status !== "cancelado" && (
            <div className="wms-card-actions" style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button
                className="wms-btn wms-btn-primary"
                disabled={receberMut.isPending}
                onClick={() => receberMut.mutate(c)}
              >
                Receber
              </button>
              {c.status === "comprado" && (
                <button
                  className="wms-btn wms-btn-ghost"
                  disabled={cancelarMut.isPending}
                  onClick={() => cancelarMut.mutate(c.id)}
                >
                  Cancelar
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` (Expected: sem erros)
```bash
git add src/components/wms/compras/aba-manuais.tsx
git commit -m "feat(compras): aba Manuais (listar + receber + cancelar)"
```

---

## Task 12: Frontend — wire na página de compras

**Files:**
- Modify: `src/app/wms/compras/page.tsx`

- [ ] **Step 1: Imports + tipo Tab + estado do modal**

Em `src/app/wms/compras/page.tsx`:

1. Adicionar import (após a linha 24, junto dos outros imports):
```tsx
import { NovaCompraManualModal } from "@/components/wms/compras/nova-compra-manual-modal";
import { AbaManuais } from "@/components/wms/compras/aba-manuais";
```

2. Trocar a linha 28:
```tsx
type Tab = "comprar" | "receber" | "historico";
```
por:
```tsx
type Tab = "comprar" | "receber" | "historico" | "manuais";
```

- [ ] **Step 2: Estado do modal + galpão ativo**

No corpo do componente de página (junto dos outros `useState`), adicionar:
```tsx
const [modalManualAberto, setModalManualAberto] = useState(false);
```
O galpão ativo vem do header `X-Galpao-Id` já injetado pelo `sisoFetch`; para o default do modal, ler do localStorage (padrão do app):
```tsx
const galpaoAtivo =
  typeof window !== "undefined" ? localStorage.getItem("siso_galpao_id") : null;
```

- [ ] **Step 3: Botão no header + aba**

1. No `PageHeader` (ou na barra de ações ao lado das tabs), adicionar o botão:
```tsx
<button className="wms-btn wms-btn-primary" onClick={() => setModalManualAberto(true)}>
  Nova compra manual
</button>
```

2. Na barra de tabs (onde "comprar"/"receber"/"historico" são renderizadas — procurar o map/JSX das tabs), adicionar a tab `manuais`. Se as tabs são renderizadas a partir de um array literal, incluir `"manuais"`; se hardcoded, adicionar o botão análogo:
```tsx
<button
  className={`wms-tab ${tab === "manuais" ? "is-active" : ""}`}
  onClick={() => setTab("manuais")}
>
  Manuais
</button>
```

3. No corpo que renderiza por `tab` (onde está `{tab === "receber" && ...}`), adicionar:
```tsx
{tab === "manuais" && <AbaManuais />}
```

4. Antes do fechamento do componente, renderizar o modal:
```tsx
{modalManualAberto && (
  <NovaCompraManualModal
    galpaoAtivo={galpaoAtivo}
    onClose={() => setModalManualAberto(false)}
  />
)}
```

- [ ] **Step 4: Verificar visualmente + typecheck**

Run: `npx tsc --noEmit` (Expected: sem erros)
Run: `npm run dev` e abrir `/wms/compras` — a aba "Manuais" aparece, o botão "Nova compra manual" abre o modal. (porta alternativa se 3000 ocupada: `npm run dev -- -p 3001`.)

- [ ] **Step 5: Commit**

```bash
git add src/app/wms/compras/page.tsx
git commit -m "feat(compras): aba Manuais + botão Nova compra manual na página"
```

---

## Task 13: Docs

**Files:**
- Modify: `docs/api-reference-complete.md`
- Modify: `docs/database-schema.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: api-reference-complete.md**

Adicionar a seção do grupo `compras-manuais` documentando as rotas:
- `POST /api/wms/compras-manuais` — cria compra manual. Guard `compras.executar`. Body `{ fornecedor_id, empresa_compradora_id, galpao_id, observacao?, itens:[{produto_id, qty_comprada, custo_unitario?}] }`.
- `GET /api/wms/compras-manuais?status=pendentes|recebido|cancelado` — lista. Guard `compras.ver`.
- `POST /api/wms/compras-manuais/[id]/receber` — recebe. Guard `compras.executar`. Body `{ itens:[{item_id, qty_recebida, custo_unitario?}] }`.
- `DELETE /api/wms/compras-manuais/[id]` — cancela (409 se houver recebimento). Guard `compras.executar`.
- `POST /api/wms/compras-manuais/fornecedor` e `POST /api/wms/compras-manuais/produto` — inline-create sob `compras.executar`.

- [ ] **Step 2: database-schema.md**

Adicionar `siso_compras_manuais` e `siso_compras_manuais_itens` com as colunas da Task 1. Nota: o movimento de entrada usa `origem_tipo='nf_compra'` + `origem_detalhes.origem='compra_manual'`.

- [ ] **Step 3: CLAUDE.md**

- Em "Estrutura do Projeto" → `lib/wms/`: adicionar `compras-manuais.ts`.
- Em "API — grupos por domínio": somar o grupo `compras-manuais` (5 rotas) à contagem.
- Em "Database — tabelas principais": adicionar `siso_compras_manuais (+itens)`.

- [ ] **Step 4: Commit**

```bash
git add docs/api-reference-complete.md docs/database-schema.md CLAUDE.md
git commit -m "docs(compras): documenta compra manual (rotas, schema, CLAUDE.md)"
```

---

## Task 14: Verificação final

- [ ] **Step 1: Lint + typecheck + unit**

Run:
```bash
npm run lint
npx tsc --noEmit
npm test
```
Expected: lint sem erros novos; tsc limpo; unit (incl. `computeStatusCompra`) PASS.

- [ ] **Step 2: Integração**

Run: `npx vitest run -c vitest.integration.config.ts test/integration/compras-manuais.integration.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build OK (`output: standalone`). Se faltar binário SWC `@next/swc-darwin-arm64`, reinstalar (ver memória project_test_harness_setup).

- [ ] **Step 4: erros-conhecidos.yaml (se algum bug surgiu)**

Se durante a implementação algum bug foi corrigido, adicionar entrada em `erros-conhecidos.yaml` (`id, date, source, category, message, cause, fix, files, tags`).

- [ ] **Step 5: Commit final (se houve ajustes)**

```bash
git add -A
git commit -m "chore(compras): ajustes finais da compra manual"
```

---

## Riscos / pontos de atenção

1. **Custo de produto novo:** `resolverCustoEntrada` LANÇA se o produto não tem custo informado nem histórico. Compra manual de produto recém-criado SEM custo no recebimento → recebimento falha com erro claro. Comportamento desejado (força custo), mas a UI deve deixar claro. Solução de UX: marcar o campo custo como recomendado quando o produto é novo.
2. **Atomicidade item-a-item:** a mov (`inserirMovimentacao`) e o bump de `qty_recebida` são tx separadas. Mitigado: bump primeiro (lock otimista) e reversão do bump se a mov falhar. Falha entre a mov OK e a reversão (improvável) deixaria estoque entrado + qty não-bumpada — operador re-recebe e a 2ª mov é nova (sem dedup por NF). Aceitável pro volume; documentar.
3. **Classes CSS do modal:** confirmar `wms-modal*`/`wms-form-row` em `src/app/wms/wms.css`. Se ausentes, adicionar estilos mínimos (não inventar design novo — seguir os tokens `wms-*`).
4. **`siso_empresas` no dropdown:** empresas derivadas de `useGalpoes()` (preferenciais). Empresa sem galpão preferencial não apareceria. Hoje todas têm preferencial (seed). Se surgir empresa órfã, trocar por fetch direto de `/api/wms/admin/empresas`.
5. **Truncate de integração:** `wms_truncate_operacional` pode não conhecer as 2 tabelas novas. O teste limpa via FK CASCADE no produto/fornecedor de teste? Não — usa rows próprias (RND). Se o harness truncar `siso_movimentacoes`/`siso_estoque` entre runs, ok. Se acumular lixo nas tabelas novas, adicionar as 2 tabelas ao `wms_truncate_operacional` numa migration de follow-up.
