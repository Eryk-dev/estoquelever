# WMS 3 — Decisões de roteamento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementa o motor de decisão de roteamento de pedidos baseado no novo schema 4D — fornecedores com lead time, matriz de empréstimos N×N, algoritmo de roteamento por galpão único com geo-priority, e reservas atômicas com TTL de 48h. Após esse plano, o WMS toma decisões de pedido (própria/empréstimo/OC) sem depender mais do Tiny pra consultar estoque. Habilita Fase 1 (dual-write).

**Architecture:** Algoritmo de roteamento puro como função TypeScript testável (fácil de validar com vitest). Reservas via `inserirMovimentacao` (helpers do Plano 1) com `expira_em`. Cron-friendly endpoint pra TTL cleanup. Integração com webhook de pedido fica em modo paralelo (escreve no novo schema mas decisão final ainda usa fluxo legado — Fase 1 vai virar a chave).

**Tech Stack:** mesmo dos planos anteriores.

**Spec de referência:** [docs/superpowers/specs/2026-05-07-wms-design.md](../specs/2026-05-07-wms-design.md) — §3.7, 3.8, 6, 7 + princípios 6, 7, 8, 9.

**Pré-requisitos:** Planos 1 e 2 concluídos **em staging** (Supabase branch `wms-fase0` + preview Vercel). Migrations e código deste plano operam **somente em staging**; produção não é tocada. O webhook do Tiny continua apontando pra prod, então o "shadow logging" da Task 11 só dispara quando webhook real chega na prod — em staging, dispara via testes manuais.

**Decisões aplicadas (do user, ver `wms-decisoes-do-user.md`):**
- Fornecedores são **auto-criados a partir de `sku-fornecedor.ts`** (Task 5.5 abaixo)
- Lead times preenchidos manualmente conforme cadastra
- Tela simples de **limite máximo por produto** em empréstimos faz parte de v1 (Task 6.5 abaixo)
- Custo unitário em mov `origem_tipo='emprestimo'` reflete o **custo médio da linha de estoque da credora** (não da vendedora). Documentado em código.

---

## File Structure

| Caminho | Responsabilidade |
|---|---|
| `supabase/migrations/20260522_wms_roteamento.sql` | Tabelas: fornecedores, produto_fornecedores, emprestimo_regras |
| `src/lib/wms/fornecedores.ts` | CRUD de fornecedores e relação produto-fornecedor |
| `src/lib/wms/emprestimos.ts` | Matriz de empréstimos: regras + saldo devedor |
| `src/lib/wms/roteamento.ts` | Algoritmo `rotearPedido` puro |
| `src/lib/wms/roteamento.test.ts` | Tests do algoritmo (mock estoque, várias situações) |
| `src/lib/wms/reservas.ts` | reservar / liberar / TTL cleanup |
| `src/lib/wms/reservas.test.ts` | Tests de cenários de reserva |
| `src/app/api/wms/fornecedores/route.ts` | GET, POST |
| `src/app/api/wms/fornecedores/[id]/route.ts` | PATCH, DELETE |
| `src/app/api/wms/produto-fornecedores/route.ts` | GET, POST |
| `src/app/api/wms/produto-fornecedores/[id]/route.ts` | PATCH, DELETE |
| `src/app/api/wms/emprestimo-regras/route.ts` | GET, POST |
| `src/app/api/wms/emprestimo-regras/[id]/route.ts` | PATCH, DELETE |
| `src/app/api/wms/emprestimos/saldos/route.ts` | GET — saldo devedor por par credora↔devedora |
| `src/app/api/wms/rotear/route.ts` | POST — testar roteamento (debug + integração) |
| `src/app/api/wms/reservas/cleanup/route.ts` | GET — cron de TTL cleanup |
| `src/app/wms/fornecedores/page.tsx` | CRUD de fornecedores |
| `src/app/wms/emprestimos/page.tsx` | Matriz N×N + saldos devedores |
| `src/lib/webhook-processor.ts` (modify) | Escrita paralela no novo schema (modo dual-write) |

---

### Task 1: Migration — fornecedores e empréstimos

**Files:**
- Create: `supabase/migrations/20260522_wms_roteamento.sql`

- [ ] **Step 1: Migration**

```sql
BEGIN;

-- 1. Fornecedores
CREATE TABLE siso_fornecedores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  cnpj text UNIQUE,
  prefixo_sku text,
  ativo boolean NOT NULL DEFAULT true,
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fornecedor_prefixo ON siso_fornecedores(prefixo_sku) WHERE ativo;
CREATE INDEX idx_fornecedor_cnpj ON siso_fornecedores(cnpj) WHERE cnpj IS NOT NULL;

-- 2. Produto x Fornecedor com lead time
CREATE TABLE siso_produto_fornecedores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id) ON DELETE CASCADE,
  fornecedor_id uuid NOT NULL REFERENCES siso_fornecedores(id) ON DELETE CASCADE,
  lead_time_dias_min int NOT NULL DEFAULT 7 CHECK (lead_time_dias_min >= 0),
  lead_time_dias_medio int NOT NULL DEFAULT 14 CHECK (lead_time_dias_medio >= 0),
  lead_time_dias_max int NOT NULL DEFAULT 30 CHECK (lead_time_dias_max >= 0),
  ultima_compra_em date,
  custo_unitario numeric(12,4),
  qty_minima_pedido numeric NOT NULL DEFAULT 1,
  multiplo_compra numeric NOT NULL DEFAULT 1,
  preferencial boolean NOT NULL DEFAULT false,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_id, fornecedor_id),
  CHECK (lead_time_dias_min <= lead_time_dias_medio),
  CHECK (lead_time_dias_medio <= lead_time_dias_max)
);

CREATE INDEX idx_pf_produto ON siso_produto_fornecedores(produto_id) WHERE ativo;
CREATE INDEX idx_pf_fornecedor ON siso_produto_fornecedores(fornecedor_id) WHERE ativo;
CREATE INDEX idx_pf_preferencial ON siso_produto_fornecedores(produto_id) WHERE preferencial AND ativo;

-- 3. Matriz de empréstimos N×N direcional
CREATE TABLE siso_emprestimo_regras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_credora_id uuid NOT NULL REFERENCES siso_empresas(id),
  empresa_devedora_id uuid NOT NULL REFERENCES siso_empresas(id),
  ativo boolean NOT NULL DEFAULT true,
  limite_max_por_produto numeric,
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_credora_id, empresa_devedora_id),
  CHECK (empresa_credora_id <> empresa_devedora_id)
);

CREATE INDEX idx_regra_devedora ON siso_emprestimo_regras(empresa_devedora_id) WHERE ativo;
CREATE INDEX idx_regra_credora ON siso_emprestimo_regras(empresa_credora_id) WHERE ativo;

-- 4. Função RPC pra reservar com lock pessimista (atomica)
CREATE OR REPLACE FUNCTION wms_reservar_atomico(
  p_produto uuid, p_dona uuid, p_galpao uuid, p_localizacao uuid,
  p_qty numeric, p_pedido text, p_ttl_horas int DEFAULT 48,
  p_usuario uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_saldo numeric;
  v_reservado numeric;
BEGIN
  -- Lock pessimista
  SELECT saldo, reservado INTO v_saldo, v_reservado
  FROM siso_estoque
  WHERE produto_id = p_produto AND empresa_dona_id = p_dona
    AND galpao_id = p_galpao AND localizacao_id = p_localizacao
  FOR UPDATE;

  IF v_saldo IS NULL THEN RAISE EXCEPTION 'estoque inexistente'; END IF;
  IF v_saldo - v_reservado < p_qty THEN
    RAISE EXCEPTION 'saldo insuficiente: disponível=% qty=%', v_saldo - v_reservado, p_qty;
  END IF;

  -- Insere mov R
  INSERT INTO siso_movimentacoes (
    produto_id, empresa_dona_id, galpao_id, localizacao_id,
    tipo, quantidade,
    saldo_anterior, saldo_posterior,
    reservado_anterior, reservado_posterior,
    origem_tipo, origem_id, expira_em, usuario_id
  ) VALUES (
    p_produto, p_dona, p_galpao, p_localizacao,
    'R', p_qty,
    v_saldo, v_saldo,
    v_reservado, v_reservado + p_qty,
    'reserva_pedido', p_pedido,
    now() + (p_ttl_horas || ' hours')::interval, p_usuario
  ) RETURNING id INTO v_id;

  UPDATE siso_estoque
  SET reservado = reservado + p_qty, atualizado_em = now()
  WHERE produto_id = p_produto AND empresa_dona_id = p_dona
    AND galpao_id = p_galpao AND localizacao_id = p_localizacao;

  RETURN v_id;
END;
$$;

-- 5. Lock de localização — usado no Plano 4 mas criado aqui pra antecipar (não bloqueia roteamento se não usado)
CREATE TABLE siso_localizacao_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  motivo text NOT NULL CHECK (motivo IN ('cycle_count','contagem_completa','manutencao')),
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  iniciado_por uuid NOT NULL REFERENCES siso_usuarios(id),
  finalizado_em timestamptz,
  observacoes text
);

CREATE UNIQUE INDEX uq_loc_lock_ativo ON siso_localizacao_locks(localizacao_id) WHERE finalizado_em IS NULL;
CREATE INDEX idx_loc_lock_ativos ON siso_localizacao_locks(iniciado_em) WHERE finalizado_em IS NULL;

COMMIT;
```

- [ ] **Step 2: Apply migration**

Via `mcp__supabase__apply_migration`, name=`wms_roteamento`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260522_wms_roteamento.sql
git commit -m "feat(wms): schema fornecedores + empréstimos + RPC reservar atomico"
```

---

### Task 2: Service de fornecedores

**Files:**
- Create: `src/lib/wms/fornecedores.ts`

- [ ] **Step 1: Service**

```typescript
import { createServiceClient } from "@/lib/supabase-server";

export interface Fornecedor {
  id: string;
  nome: string;
  cnpj: string | null;
  prefixo_sku: string | null;
  ativo: boolean;
  observacoes: string | null;
}

export interface ProdutoFornecedor {
  id: string;
  produto_id: string;
  fornecedor_id: string;
  lead_time_dias_min: number;
  lead_time_dias_medio: number;
  lead_time_dias_max: number;
  ultima_compra_em: string | null;
  custo_unitario: number | null;
  qty_minima_pedido: number;
  multiplo_compra: number;
  preferencial: boolean;
  ativo: boolean;
}

export async function listarFornecedores(): Promise<Fornecedor[]> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_fornecedores").select("*").eq("ativo", true).order("nome");
  if (error) throw error;
  return (data ?? []) as Fornecedor[];
}

export async function criarFornecedor(input: { nome: string; cnpj?: string; prefixo_sku?: string }): Promise<Fornecedor> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_fornecedores").insert(input).select().single();
  if (error) throw error;
  return data as Fornecedor;
}

export async function listarProdutoFornecedores(produtoId: string): Promise<ProdutoFornecedor[]> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_produto_fornecedores")
    .select("*").eq("produto_id", produtoId).eq("ativo", true).order("preferencial", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProdutoFornecedor[];
}

export async function vincularProdutoFornecedor(input: {
  produto_id: string; fornecedor_id: string;
  lead_time_dias_min?: number; lead_time_dias_medio?: number; lead_time_dias_max?: number;
  custo_unitario?: number; qty_minima_pedido?: number; multiplo_compra?: number;
  preferencial?: boolean;
}): Promise<ProdutoFornecedor> {
  const sb = createServiceClient();
  // Se preferencial=true, despreferencia outros
  if (input.preferencial) {
    await sb.from("siso_produto_fornecedores")
      .update({ preferencial: false })
      .eq("produto_id", input.produto_id);
  }
  const { data, error } = await sb.from("siso_produto_fornecedores").insert(input).select().single();
  if (error) throw error;
  return data as ProdutoFornecedor;
}

export async function getFornecedorPreferencial(produtoId: string): Promise<{ fornecedor: Fornecedor; pf: ProdutoFornecedor } | null> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_produto_fornecedores")
    .select("*, fornecedor:siso_fornecedores(*)")
    .eq("produto_id", produtoId).eq("ativo", true).eq("preferencial", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { fornecedor: data.fornecedor as Fornecedor, pf: data as any as ProdutoFornecedor };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/wms/fornecedores.ts
git commit -m "feat(wms): service de fornecedores e relação com produtos"
```

---

### Task 3: APIs de fornecedores

**Files:**
- Create: `src/app/api/wms/fornecedores/route.ts`
- Create: `src/app/api/wms/fornecedores/[id]/route.ts`
- Create: `src/app/api/wms/produto-fornecedores/route.ts`
- Create: `src/app/api/wms/produto-fornecedores/[id]/route.ts`

- [ ] **Step 1: Fornecedores list+create**

```typescript
// src/app/api/wms/fornecedores/route.ts
import { NextRequest, NextResponse } from "next/server";
import { listarFornecedores, criarFornecedor } from "@/lib/wms/fornecedores";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ rows: await listarFornecedores() });
}

export async function POST(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.nome) return NextResponse.json({ error: "nome obrigatório" }, { status: 400 });
  try { return NextResponse.json(await criarFornecedor(body), { status: 201 }); }
  catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}
```

- [ ] **Step 2: Fornecedor by id (PATCH/DELETE)**

```typescript
// src/app/api/wms/fornecedores/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_fornecedores")
    .update({ ...body, atualizado_em: new Date().toISOString() })
    .eq("id", id).select().single();
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const sb = createServiceClient();
  await sb.from("siso_fornecedores").update({ ativo: false }).eq("id", id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: produto-fornecedores APIs**

```typescript
// src/app/api/wms/produto-fornecedores/route.ts
import { NextRequest, NextResponse } from "next/server";
import { listarProdutoFornecedores, vincularProdutoFornecedor } from "@/lib/wms/fornecedores";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const produtoId = req.nextUrl.searchParams.get("produto_id");
  if (!produtoId) return NextResponse.json({ error: "produto_id obrigatório" }, { status: 400 });
  return NextResponse.json({ rows: await listarProdutoFornecedores(produtoId) });
}

export async function POST(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  try { return NextResponse.json(await vincularProdutoFornecedor(body), { status: 201 }); }
  catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}
```

```typescript
// src/app/api/wms/produto-fornecedores/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  const sb = createServiceClient();
  // Se vai virar preferencial, despreferencia outros do mesmo produto
  if (body.preferencial === true) {
    const { data: pf } = await sb.from("siso_produto_fornecedores").select("produto_id").eq("id", id).single();
    if (pf) {
      await sb.from("siso_produto_fornecedores").update({ preferencial: false }).eq("produto_id", pf.produto_id);
    }
  }
  const { data, error } = await sb.from("siso_produto_fornecedores")
    .update({ ...body, atualizado_em: new Date().toISOString() })
    .eq("id", id).select().single();
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const sb = createServiceClient();
  await sb.from("siso_produto_fornecedores").update({ ativo: false }).eq("id", id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/fornecedores/ src/app/api/wms/produto-fornecedores/
git commit -m "feat(wms): APIs de fornecedores e relacionamento com produtos"
```

---

### Task 4: Tela de fornecedores

**Files:**
- Create: `src/app/wms/fornecedores/page.tsx`

- [ ] **Step 1: CRUD page**

```tsx
"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { Plus } from "lucide-react";

export default function FornecedoresPage() {
  const queryClient = useQueryClient();
  const [novo, setNovo] = useState({ nome: "", cnpj: "", prefixo_sku: "" });

  const { data } = useQuery({
    queryKey: ["wms-fornecedores"],
    queryFn: async () => (await sisoFetch("/api/wms/fornecedores")).json() as Promise<{ rows: any[] }>,
  });

  const criar = useMutation({
    mutationFn: async () => sisoFetch("/api/wms/fornecedores", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(novo),
    }).then(r => r.json()),
    onSuccess: () => { toast.success("criado"); setNovo({ nome: "", cnpj: "", prefixo_sku: "" }); queryClient.invalidateQueries({ queryKey: ["wms-fornecedores"] }); },
  });

  return (
    <div className="space-y-3 max-w-3xl">
      <h1 className="text-lg font-medium">Fornecedores</h1>
      <div className="flex gap-2 p-3 rounded border border-zinc-200 dark:border-zinc-800">
        <input placeholder="Nome" value={novo.nome} onChange={e => setNovo({ ...novo, nome: e.target.value })}
          className="flex-1 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent" />
        <input placeholder="CNPJ" value={novo.cnpj} onChange={e => setNovo({ ...novo, cnpj: e.target.value })}
          className="w-40 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent" />
        <input placeholder="Prefixo SKU" value={novo.prefixo_sku} onChange={e => setNovo({ ...novo, prefixo_sku: e.target.value })}
          className="w-28 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono text-sm" />
        <button onClick={() => criar.mutate()} disabled={!novo.nome || criar.isPending}
          className="px-3 py-1 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
          <Plus className="inline w-4 h-4" /> criar
        </button>
      </div>
      <div className="space-y-1">
        {data?.rows.map(f => (
          <div key={f.id} className="flex gap-3 p-2 rounded border border-zinc-200 dark:border-zinc-800">
            <span className="font-medium flex-1">{f.nome}</span>
            <span className="text-sm text-zinc-500">{f.cnpj}</span>
            {f.prefixo_sku && <span className="font-mono text-xs px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">{f.prefixo_sku}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/wms/fornecedores/page.tsx
git commit -m "feat(wms): tela de cadastro de fornecedores"
```

---

### Task 5.5: Auto-seed de fornecedores a partir de `sku-fornecedor.ts`

**Files:**
- Create: `scripts/wms-seed-fornecedores.ts`

- [ ] **Step 1: Inspecionar mapeamento existente**

```bash
cat src/lib/sku-fornecedor.ts
```

Identifique a estrutura (mapeamento prefixo → fornecedor + galpão default). Esse arquivo já existe e o user confirmou ser fonte de verdade pra fornecedores em v1.

- [ ] **Step 2: Script de seed**

```typescript
// scripts/wms-seed-fornecedores.ts
import "dotenv/config";
import { createServiceClient } from "../src/lib/supabase-server";
// Importa mapeamento existente; nome real conforme sku-fornecedor.ts
import { MAPEAMENTO_PREFIXOS } from "../src/lib/sku-fornecedor";

async function main() {
  const sb = createServiceClient();

  // Extrai fornecedores únicos do mapeamento
  const fornecedoresUnicos = new Map<string, { nome: string; prefixos: string[] }>();
  for (const [prefixo, info] of Object.entries(MAPEAMENTO_PREFIXOS as any)) {
    const nome = (info as any).fornecedor;
    if (!fornecedoresUnicos.has(nome)) fornecedoresUnicos.set(nome, { nome, prefixos: [] });
    fornecedoresUnicos.get(nome)!.prefixos.push(prefixo);
  }

  for (const [nome, info] of fornecedoresUnicos) {
    // Cria 1 fornecedor por nome; usa primeiro prefixo como prefixo_sku padrão
    const { data, error } = await sb.from("siso_fornecedores")
      .upsert({ nome, prefixo_sku: info.prefixos[0] }, { onConflict: "nome" })
      .select("id, prefixo_sku").single();
    if (error) {
      console.error(`falha ${nome}:`, error.message);
      continue;
    }
    console.log(`✓ ${nome} (prefixo: ${data.prefixo_sku}, prefixos extras: ${info.prefixos.slice(1).join(", ") || "—"})`);
  }
  console.log(`\nTotal: ${fornecedoresUnicos.size} fornecedores cadastrados.`);
  console.log("Lead times: preencha manualmente em /wms/fornecedores depois.");
}

main().catch(console.error);
```

- [ ] **Step 3: Adicionar UNIQUE em `nome` no fornecedores**

Como o seed usa `upsert` com `onConflict: "nome"`, a tabela precisa ter UNIQUE. Adicionar à migration original (`20260522_wms_roteamento.sql`):

```sql
ALTER TABLE siso_fornecedores
  ADD CONSTRAINT siso_fornecedores_nome_unique UNIQUE (nome);
```

(Já está? Verifica antes de duplicar.)

- [ ] **Step 4: Executar seed**

```bash
npx tsx scripts/wms-seed-fornecedores.ts
```

Expected: ~14 fornecedores criados (Diversos, Tiger, LDRU, LEFS, ACA, GAUSS, MRMK, Delphi, Kintop, Multiqualita, etc).

- [ ] **Step 5: Commit**

```bash
git add scripts/wms-seed-fornecedores.ts supabase/migrations/20260522_wms_roteamento.sql
git commit -m "feat(wms): auto-seed de fornecedores baseado em sku-fornecedor.ts"
```

---

### Task 5: Service de empréstimos

**Files:**
- Create: `src/lib/wms/emprestimos.ts`

- [ ] **Step 1: Service**

```typescript
import { createServiceClient } from "@/lib/supabase-server";

export interface EmprestimoRegra {
  id: string;
  empresa_credora_id: string;
  empresa_devedora_id: string;
  ativo: boolean;
  limite_max_por_produto: number | null;
  observacoes: string | null;
}

export async function listarRegras(): Promise<EmprestimoRegra[]> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_emprestimo_regras")
    .select("*").eq("ativo", true);
  if (error) throw error;
  return (data ?? []) as EmprestimoRegra[];
}

export async function criarRegra(input: {
  empresa_credora_id: string; empresa_devedora_id: string;
  limite_max_por_produto?: number; observacoes?: string;
}): Promise<EmprestimoRegra> {
  const sb = createServiceClient();
  if (input.empresa_credora_id === input.empresa_devedora_id) {
    throw new Error("credora e devedora devem ser empresas diferentes");
  }
  const { data, error } = await sb.from("siso_emprestimo_regras").insert(input).select().single();
  if (error) throw error;
  return data as EmprestimoRegra;
}

export async function listarCredorasPara(empresaDevedoraId: string): Promise<string[]> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_emprestimo_regras")
    .select("empresa_credora_id")
    .eq("empresa_devedora_id", empresaDevedoraId).eq("ativo", true);
  if (error) throw error;
  return (data ?? []).map(r => r.empresa_credora_id);
}

/**
 * Saldo devedor por par (credora, devedora) por produto.
 * Saldo = empréstimos diretos − empréstimos reversos − estornos.
 */
export async function saldosDevedores(): Promise<{
  credora: string; devedora: string; produto_id: string; saldo_liquido: number;
}[]> {
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_saldos_devedores");
  if (error) throw error;
  return (data ?? []) as any;
}
```

- [ ] **Step 2: RPC pra saldos devedores**

Add to migration `20260522_wms_roteamento.sql` (ou criar nova `20260522_wms_saldos_rpc.sql`):

```sql
CREATE OR REPLACE FUNCTION wms_saldos_devedores()
RETURNS TABLE (
  credora uuid, devedora uuid, produto_id uuid, saldo_liquido numeric
) LANGUAGE sql AS $$
  WITH dividas AS (
    SELECT empresa_dona_id AS credora, emprestimo_devedora_id AS devedora, produto_id,
           SUM(CASE
             WHEN estorno_de IS NULL AND NOT EXISTS (
               SELECT 1 FROM siso_movimentacoes e2 WHERE e2.estorno_de = m.id
             ) THEN quantidade ELSE 0
           END) AS devido
    FROM siso_movimentacoes m
    WHERE origem_tipo = 'emprestimo'
    GROUP BY empresa_dona_id, emprestimo_devedora_id, produto_id
  )
  SELECT
    d1.credora, d1.devedora, d1.produto_id,
    d1.devido - COALESCE(d2.devido, 0)
  FROM dividas d1
  LEFT JOIN dividas d2
    ON d1.credora = d2.devedora AND d1.devedora = d2.credora
   AND d1.produto_id = d2.produto_id
  WHERE d1.devido > COALESCE(d2.devido, 0);
$$;
```

Apply migration.

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/emprestimos.ts supabase/migrations/
git commit -m "feat(wms): service de empréstimos com saldos devedores"
```

---

### Task 6: APIs de empréstimos + tela

**Files:**
- Create: `src/app/api/wms/emprestimo-regras/route.ts`
- Create: `src/app/api/wms/emprestimo-regras/[id]/route.ts`
- Create: `src/app/api/wms/emprestimos/saldos/route.ts`
- Create: `src/app/wms/emprestimos/page.tsx`

- [ ] **Step 1: APIs**

```typescript
// src/app/api/wms/emprestimo-regras/route.ts
import { NextRequest, NextResponse } from "next/server";
import { listarRegras, criarRegra } from "@/lib/wms/emprestimos";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ rows: await listarRegras() });
}

export async function POST(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  try { return NextResponse.json(await criarRegra(body), { status: 201 }); }
  catch (e) { return NextResponse.json({ error: String(e) }, { status: 400 }); }
}
```

```typescript
// src/app/api/wms/emprestimo-regras/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_emprestimo_regras")
    .update({ ...await req.json(), atualizado_em: new Date().toISOString() })
    .eq("id", id).select().single();
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const sb = createServiceClient();
  await sb.from("siso_emprestimo_regras").update({ ativo: false }).eq("id", id);
  return NextResponse.json({ ok: true });
}
```

```typescript
// src/app/api/wms/emprestimos/saldos/route.ts
import { NextRequest, NextResponse } from "next/server";
import { saldosDevedores } from "@/lib/wms/emprestimos";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ rows: await saldosDevedores() });
}
```

- [ ] **Step 2: Tela de matriz N×N + saldos**

```tsx
// src/app/wms/emprestimos/page.tsx
"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";

export default function EmprestimosPage() {
  const queryClient = useQueryClient();
  const [credora, setCredora] = useState<string>("");
  const [devedora, setDevedora] = useState<string>("");

  const { data: galpoes } = useQuery({ queryKey: ["galpoes"], queryFn: async () => (await sisoFetch("/api/admin/galpoes")).json() });
  const empresas = (galpoes?.galpoes ?? []).flatMap((g: any) => g.empresas ?? []);

  const { data: regras } = useQuery({
    queryKey: ["wms-regras"],
    queryFn: async () => (await sisoFetch("/api/wms/emprestimo-regras")).json() as Promise<{ rows: any[] }>,
  });

  const { data: saldos } = useQuery({
    queryKey: ["wms-saldos-devedores"],
    queryFn: async () => (await sisoFetch("/api/wms/emprestimos/saldos")).json() as Promise<{ rows: any[] }>,
  });

  const criar = useMutation({
    mutationFn: async () => sisoFetch("/api/wms/emprestimo-regras", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ empresa_credora_id: credora, empresa_devedora_id: devedora }),
    }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: () => { toast.success("regra criada"); queryClient.invalidateQueries({ queryKey: ["wms-regras"] }); },
    onError: (e) => toast.error(String(e)),
  });

  const empresaNome = (id: string) => empresas.find((e: any) => e.id === id)?.nome ?? id;

  return (
    <div className="space-y-4 max-w-4xl">
      <section>
        <h2 className="text-lg font-medium mb-2">Matriz de empréstimos</h2>
        <div className="flex gap-2 mb-3 items-center">
          <select value={credora} onChange={e => setCredora(e.target.value)} className="px-2 py-1 rounded border bg-transparent">
            <option value="">— credora —</option>
            {empresas.map((e: any) => <option key={e.id} value={e.id}>{e.nome}</option>)}
          </select>
          <span>→ empresta para →</span>
          <select value={devedora} onChange={e => setDevedora(e.target.value)} className="px-2 py-1 rounded border bg-transparent">
            <option value="">— devedora —</option>
            {empresas.map((e: any) => <option key={e.id} value={e.id}>{e.nome}</option>)}
          </select>
          <button onClick={() => criar.mutate()} disabled={!credora || !devedora || credora === devedora}
            className="px-3 py-1 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm">criar</button>
        </div>
        <div className="space-y-1">
          {regras?.rows.map(r => (
            <div key={r.id} className="text-sm p-2 rounded border border-zinc-200 dark:border-zinc-800">
              {empresaNome(r.empresa_credora_id)} → {empresaNome(r.empresa_devedora_id)}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Saldos devedores</h2>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-zinc-500"><th>credora</th><th>devedora</th><th>produto</th><th className="text-right">saldo</th></tr></thead>
          <tbody>
            {saldos?.rows.map((s: any, i: number) => (
              <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
                <td>{empresaNome(s.credora)}</td>
                <td>{empresaNome(s.devedora)}</td>
                <td className="font-mono text-xs">{s.produto_id}</td>
                <td className="text-right tabular-nums">{Number(s.saldo_liquido).toLocaleString("pt-BR")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/emprestimo-regras/ src/app/api/wms/emprestimos/ src/app/wms/emprestimos/
git commit -m "feat(wms): APIs e tela de matriz de empréstimos com saldos devedores"
```

---

### Task 6.5: Tela de limite máximo por produto em empréstimo

**Files:**
- Create: `src/app/api/wms/emprestimo-regras/[id]/limites/route.ts`
- Modify: `src/app/wms/emprestimos/page.tsx`

- [ ] **Step 1: API de limite por par+produto**

`limite_max_por_produto` na tabela `siso_emprestimo_regras` é um valor único por par (não por produto). Pra "limite por produto" precisamos de tabela auxiliar OU campo jsonb. Decisão: campo jsonb simples no v1.

Migration extra (adicionar à `20260522_wms_roteamento.sql`):

```sql
ALTER TABLE siso_emprestimo_regras
  ADD COLUMN IF NOT EXISTS limites_por_produto jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Estrutura: { "<produto_id>": <numero qty máxima>, ... }
-- Validação: aplicada no algoritmo de roteamento (Task 7)
```

API:

```typescript
// src/app/api/wms/emprestimo-regras/[id]/limites/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const sb = createServiceClient();
  const { data } = await sb.from("siso_emprestimo_regras").select("limites_por_produto").eq("id", id).single();
  return NextResponse.json({ limites: data?.limites_por_produto ?? {} });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  if (!body.produto_id || body.qty === undefined) {
    return NextResponse.json({ error: "produto_id e qty obrigatórios" }, { status: 400 });
  }
  const sb = createServiceClient();
  const { data: regra } = await sb.from("siso_emprestimo_regras").select("limites_por_produto").eq("id", id).single();
  const limites = (regra?.limites_por_produto ?? {}) as Record<string, number>;
  if (body.qty === null) delete limites[body.produto_id];
  else limites[body.produto_id] = Number(body.qty);
  const { error } = await sb.from("siso_emprestimo_regras").update({ limites_por_produto: limites }).eq("id", id);
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ ok: true, limites });
}
```

- [ ] **Step 2: UI extensão na tela de empréstimos**

Em `src/app/wms/emprestimos/page.tsx`, adicionar seção expandable por regra mostrando limites por produto + botão "configurar limites". Inputs simples: SKU + qty.

```tsx
// Adicionar após o map de regras
{regras?.rows.map(r => (
  <details key={r.id} className="rounded border border-zinc-200 dark:border-zinc-800">
    <summary className="p-2 cursor-pointer text-sm">
      {empresaNome(r.empresa_credora_id)} → {empresaNome(r.empresa_devedora_id)}
    </summary>
    <LimitesEditor regraId={r.id} />
  </details>
))}
```

`LimitesEditor` é componente novo: lê limites via `GET /api/wms/emprestimo-regras/[id]/limites`, lista em tabela; tem input pra adicionar SKU + qty (chama PATCH). Implementação trivial seguindo padrão das telas anteriores.

- [ ] **Step 3: Aplicar limite no algoritmo de roteamento (Task 7)**

Em `roteamento.ts` Task 7, na busca de empréstimo, verificar `limites_por_produto[produto_id]` e abater do disponível. Se `qty > limite`, ignora aquela credora pra esse produto.

```typescript
// Na função buscarLinha, ao buscar empréstimo:
// Antes de retornar, verifica limite_por_produto da regra
const { data: regra } = await sb.from("siso_emprestimo_regras")
  .select("limites_por_produto")
  .eq("empresa_credora_id", q.empresa_dona_id)
  .eq("empresa_devedora_id", empresaVendedoraId)
  .single();
const limite = (regra?.limites_por_produto as Record<string, number>)?.[q.produto_id];
if (limite !== undefined && q.qty > limite) return null;
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/emprestimo-regras/[id]/limites/ src/app/wms/emprestimos/page.tsx supabase/migrations/20260522_wms_roteamento.sql src/lib/wms/roteamento.ts
git commit -m "feat(wms): tela e validação de limite máximo por produto em empréstimos"
```

---

### Task 7: Algoritmo de roteamento (testado)

**Files:**
- Create: `src/lib/wms/roteamento.ts`
- Create: `src/lib/wms/roteamento.test.ts`

- [ ] **Step 1: Tests primeiro**

```typescript
// src/lib/wms/roteamento.test.ts
import { describe, it, expect } from "vitest";
import { rotearPedido, geoPriority } from "./roteamento";

describe("geoPriority", () => {
  it("home tem prioridade 0", () => {
    expect(geoPriority({ id: "h", cidade: "CWB", estado: "PR" }, { id: "h", cidade: "CWB", estado: "PR" })).toBe(0);
  });
  it("mesma cidade vira 1", () => {
    expect(geoPriority({ id: "x", cidade: "CWB", estado: "PR" }, { id: "h", cidade: "CWB", estado: "PR" })).toBe(1);
  });
  it("mesmo estado vira 2", () => {
    expect(geoPriority({ id: "x", cidade: "FOZ", estado: "PR" }, { id: "h", cidade: "CWB", estado: "PR" })).toBe(2);
  });
  it("estado diferente vira 3", () => {
    expect(geoPriority({ id: "x", cidade: "SP", estado: "SP" }, { id: "h", cidade: "CWB", estado: "PR" })).toBe(3);
  });
});

const galpaoCwb = { id: "g-cwb", cidade: "CWB", estado: "PR" };
const galpaoSp = { id: "g-sp", cidade: "SP", estado: "SP" };
const empresaA = { id: "a", galpao_id: "g-cwb" }; // home CWB
const empresaB = { id: "b", galpao_id: "g-sp" };  // home SP

describe("rotearPedido", () => {
  it("auto-aprova quando vendedora tem todos os itens no galpão home", async () => {
    const ctx = {
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      itens: [{ produto_id: "p1", qty: 2 }],
      buscarLinha: async ({ produto_id, empresa_dona_id, galpao_id, qty }: any) => {
        if (produto_id === "p1" && empresa_dona_id === "a" && galpao_id === "g-cwb")
          return { id: "loc-cwb", produto_id, empresa_dona_id, galpao_id, localizacao_id: "lc1", disponivel: 5 };
        return null;
      },
    };
    const r = await rotearPedido(ctx as any);
    expect(r.decisao).toBe("propria");
    expect(r.rotas).toHaveLength(1);
    expect(r.rotas?.[0].galpao_id).toBe("g-cwb");
  });

  it("vai pra OC quando vendedora não tem e nenhuma credora autorizada cobre", async () => {
    const ctx = {
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      itens: [{ produto_id: "p1", qty: 2 }],
      buscarLinha: async () => null,
    };
    const r = await rotearPedido(ctx as any);
    expect(r.decisao).toBe("oc");
    expect((r as any).motivo).toBe("sem_cobertura");
  });

  it("usa empréstimo quando próprio falha mas credora cobre tudo num galpão", async () => {
    const ctx = {
      vendedora: empresaA,
      galpoes: [galpaoCwb],
      credoras: ["b"],  // empresa B emprestaria
      itens: [{ produto_id: "p1", qty: 1 }],
      buscarLinha: async ({ empresa_dona_id, galpao_id }: any) => {
        if (empresa_dona_id === "b" && galpao_id === "g-cwb") {
          return { id: "x", empresa_dona_id, galpao_id, localizacao_id: "lc-x", disponivel: 5 };
        }
        return null;
      },
    };
    const r = await rotearPedido(ctx as any);
    expect(r.decisao).toBe("emprestimo");
  });

  it("vai pra OC com motivo split_galpoes quando cobertura exigiria 2 galpões", async () => {
    const ctx = {
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      itens: [
        { produto_id: "p1", qty: 1 },
        { produto_id: "p2", qty: 1 },
      ],
      buscarLinha: async ({ produto_id, galpao_id }: any) => {
        // p1 só em CWB; p2 só em SP
        if (produto_id === "p1" && galpao_id === "g-cwb") return { id: "1", localizacao_id: "lc1", disponivel: 5 };
        if (produto_id === "p2" && galpao_id === "g-sp") return { id: "2", localizacao_id: "lc2", disponivel: 5 };
        return null;
      },
    };
    const r = await rotearPedido(ctx as any);
    expect(r.decisao).toBe("oc");
    expect((r as any).motivo).toBe("split_galpoes");
  });

  it("prefere galpão home da vendedora quando há múltiplos candidatos", async () => {
    const ctx = {
      vendedora: empresaA,  // home CWB
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      itens: [{ produto_id: "p1", qty: 1 }],
      buscarLinha: async ({ galpao_id }: any) => ({ id: galpao_id, localizacao_id: "x", disponivel: 5 }),
    };
    const r = await rotearPedido(ctx as any);
    expect(r.rotas?.[0].galpao_id).toBe("g-cwb");
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npm test -- roteamento
```
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/wms/roteamento.ts
import { createServiceClient } from "@/lib/supabase-server";

export interface GalpaoLite { id: string; cidade: string | null; estado: string | null; }
export interface EmpresaLite { id: string; galpao_id: string; }
export interface ItemPedido { produto_id: string; qty: number; }
export interface LinhaCandidata {
  id: string;
  localizacao_id: string;
  disponivel: number;
}
export interface RotaItem extends ItemPedido {
  empresa_dona_id: string;
  galpao_id: string;
  localizacao_id: string;
  tipo: "propria" | "emprestimo";
}
export type RotaResult =
  | { decisao: "propria" | "emprestimo"; rotas: RotaItem[]; galpao_id: string }
  | { decisao: "oc"; motivo: "sem_cobertura" | "split_galpoes" };

export interface RotearContext {
  vendedora: EmpresaLite;
  galpoes: GalpaoLite[];
  credoras: string[];
  itens: ItemPedido[];
  buscarLinha: (q: {
    produto_id: string;
    empresa_dona_id: string;
    galpao_id: string;
    qty: number;
  }) => Promise<LinhaCandidata | null>;
}

export function geoPriority(galpao: GalpaoLite, home: GalpaoLite): number {
  if (galpao.id === home.id) return 0;
  if (galpao.cidade && galpao.cidade === home.cidade && galpao.estado === home.estado) return 1;
  if (galpao.estado && galpao.estado === home.estado) return 2;
  return 3;
}

export async function rotearPedido(ctx: RotearContext): Promise<RotaResult> {
  const home = ctx.galpoes.find(g => g.id === ctx.vendedora.galpao_id);
  if (!home) return { decisao: "oc", motivo: "sem_cobertura" };

  type Candidato = { galpao: GalpaoLite; rotas: RotaItem[]; tudoProprio: boolean };
  const candidatos: Candidato[] = [];

  for (const galpao of ctx.galpoes) {
    const rotas: RotaItem[] = [];
    let cobreTudo = true;
    let tudoProprio = true;

    for (const item of ctx.itens) {
      // 1. Próprio nesse galpão
      const proprio = await ctx.buscarLinha({
        produto_id: item.produto_id,
        empresa_dona_id: ctx.vendedora.id,
        galpao_id: galpao.id,
        qty: item.qty,
      });
      if (proprio) {
        rotas.push({
          ...item,
          empresa_dona_id: ctx.vendedora.id,
          galpao_id: galpao.id,
          localizacao_id: proprio.localizacao_id,
          tipo: "propria",
        });
        continue;
      }

      // 2. Empréstimo nesse galpão
      let emprestimo: { donaId: string; linha: LinhaCandidata } | null = null;
      for (const credoraId of ctx.credoras) {
        const linha = await ctx.buscarLinha({
          produto_id: item.produto_id,
          empresa_dona_id: credoraId,
          galpao_id: galpao.id,
          qty: item.qty,
        });
        if (linha) { emprestimo = { donaId: credoraId, linha }; break; }
      }
      if (emprestimo) {
        rotas.push({
          ...item,
          empresa_dona_id: emprestimo.donaId,
          galpao_id: galpao.id,
          localizacao_id: emprestimo.linha.localizacao_id,
          tipo: "emprestimo",
        });
        tudoProprio = false;
        continue;
      }

      cobreTudo = false;
      break;
    }

    if (cobreTudo) candidatos.push({ galpao, rotas, tudoProprio });
  }

  if (candidatos.length === 0) {
    // Verifica se algum galpão tem alguma cobertura (split_galpoes vs sem_cobertura)
    let algumaCobertura = false;
    for (const g of ctx.galpoes) {
      for (const item of ctx.itens) {
        const linha = await ctx.buscarLinha({
          produto_id: item.produto_id,
          empresa_dona_id: ctx.vendedora.id,
          galpao_id: g.id,
          qty: item.qty,
        });
        if (linha) { algumaCobertura = true; break; }
      }
      if (algumaCobertura) break;
    }
    return { decisao: "oc", motivo: algumaCobertura ? "split_galpoes" : "sem_cobertura" };
  }

  candidatos.sort((a, b) => geoPriority(a.galpao, home) - geoPriority(b.galpao, home));
  const escolhido = candidatos[0];
  return {
    decisao: escolhido.tudoProprio ? "propria" : "emprestimo",
    rotas: escolhido.rotas,
    galpao_id: escolhido.galpao.id,
  };
}

/**
 * Wrapper de produção: monta contexto a partir do banco e chama rotearPedido.
 */
export async function rotearPedidoDoBanco(
  empresaVendedoraId: string,
  itens: ItemPedido[],
): Promise<RotaResult> {
  const sb = createServiceClient();

  const { data: vendedora } = await sb.from("siso_empresas").select("id, galpao_id").eq("id", empresaVendedoraId).single();
  if (!vendedora) return { decisao: "oc", motivo: "sem_cobertura" };

  const { data: galpoes } = await sb.from("siso_galpoes").select("id, cidade, estado").eq("ativo", true);
  const { data: regras } = await sb.from("siso_emprestimo_regras")
    .select("empresa_credora_id").eq("empresa_devedora_id", empresaVendedoraId).eq("ativo", true);

  return rotearPedido({
    vendedora,
    galpoes: galpoes ?? [],
    credoras: (regras ?? []).map(r => r.empresa_credora_id),
    itens,
    buscarLinha: async (q) => {
      const { data } = await sb.from("siso_estoque")
        .select("id, localizacao_id, disponivel, localizacao:siso_localizacoes(tipo)")
        .match({
          produto_id: q.produto_id,
          empresa_dona_id: q.empresa_dona_id,
          galpao_id: q.galpao_id,
        })
        .gte("disponivel", q.qty)
        .order("disponivel", { ascending: false })
        .limit(20);
      if (!data || data.length === 0) return null;
      // Filtra locks de localização ativos
      const locsBloqueadas = await sb.from("siso_localizacao_locks")
        .select("localizacao_id").is("finalizado_em", null);
      const blocked = new Set((locsBloqueadas.data ?? []).map(l => l.localizacao_id));
      const livres = data.filter(d => !blocked.has(d.localizacao_id));
      // Prefere picking
      const sorted = livres.sort((a: any, b: any) => {
        const ap = (a.localizacao?.tipo === "picking") ? 0 : 1;
        const bp = (b.localizacao?.tipo === "picking") ? 0 : 1;
        return ap - bp;
      });
      return sorted[0] ? { id: sorted[0].id, localizacao_id: sorted[0].localizacao_id, disponivel: Number(sorted[0].disponivel) } : null;
    },
  });
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm test -- roteamento
```
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/roteamento.ts src/lib/wms/roteamento.test.ts
git commit -m "feat(wms): algoritmo de roteamento por galpão único com geo-priority"
```

---

### Task 8: API de roteamento (debug + integração)

**Files:**
- Create: `src/app/api/wms/rotear/route.ts`

- [ ] **Step 1: API**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { rotearPedidoDoBanco } from "@/lib/wms/roteamento";

export async function POST(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.empresa_vendedora_id || !Array.isArray(body.itens)) {
    return NextResponse.json({ error: "campos obrigatórios" }, { status: 400 });
  }
  try {
    const r = await rotearPedidoDoBanco(body.empresa_vendedora_id, body.itens);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Manual smoke test**

```bash
curl -X POST -H "X-Session-Id: $S" -H "Content-Type: application/json" \
  -d '{"empresa_vendedora_id":"<id>","itens":[{"produto_id":"<id>","qty":1}]}' \
  http://localhost:3000/api/wms/rotear
```

Expected: JSON com `decisao: "propria" | "emprestimo" | "oc"`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/rotear/
git commit -m "feat(wms): endpoint de roteamento (debug + integração)"
```

---

### Task 9: Reservas com TTL — service e tests

**Files:**
- Create: `src/lib/wms/reservas.ts`
- Create: `src/lib/wms/reservas.test.ts`

- [ ] **Step 1: Tests**

```typescript
import { describe, it, expect } from "vitest";
import { calcularExpiraEm } from "./reservas";

describe("calcularExpiraEm", () => {
  it("default 48h adiciona 48h ao now", () => {
    const now = new Date("2026-01-01T10:00:00Z");
    const r = calcularExpiraEm({ now, horas: 48 });
    expect(r.toISOString()).toBe("2026-01-03T10:00:00.000Z");
  });

  it("ttl custom 12h", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(calcularExpiraEm({ now, horas: 12 }).toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/lib/wms/reservas.ts
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import type { Quadrupla } from "./types";

export function calcularExpiraEm(opts: { now?: Date; horas?: number } = {}): Date {
  const now = opts.now ?? new Date();
  const horas = opts.horas ?? 48;
  return new Date(now.getTime() + horas * 3600 * 1000);
}

export interface ReservarInput {
  quadrupla: Quadrupla;
  qty: number;
  pedido_id: string;
  ttl_horas?: number;
  usuario_id?: string;
}

export async function reservarAtomico(input: ReservarInput): Promise<string> {
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_reservar_atomico", {
    p_produto: input.quadrupla.produto_id,
    p_dona: input.quadrupla.empresa_dona_id,
    p_galpao: input.quadrupla.galpao_id,
    p_localizacao: input.quadrupla.localizacao_id,
    p_qty: input.qty,
    p_pedido: input.pedido_id,
    p_ttl_horas: input.ttl_horas ?? 48,
    p_usuario: input.usuario_id ?? null,
  });
  if (error) {
    logger.error("wms.reservas", "falha ao reservar", { error, input });
    throw error;
  }
  return data as string;
}

export async function liberarReserva(input: {
  pedido_id: string;
  motivo: "nf_emitida" | "cancelamento" | "expirado" | "troca_sku";
  usuario_id?: string;
}): Promise<number> {
  const sb = createServiceClient();
  // Pra cada mov R desse pedido sem L posterior, insere L
  const { data: reservas, error } = await sb.from("siso_movimentacoes")
    .select("id, produto_id, empresa_dona_id, galpao_id, localizacao_id, quantidade, saldo_posterior, reservado_posterior")
    .eq("origem_id", input.pedido_id).eq("origem_tipo", "reserva_pedido").eq("tipo", "R");
  if (error) throw error;

  let liberados = 0;
  for (const r of reservas ?? []) {
    // Skip se já tem L
    const { data: jaLiberada } = await sb.from("siso_movimentacoes")
      .select("id").eq("origem_id", input.pedido_id).eq("tipo", "L")
      .gt("criado_em", new Date(0).toISOString())
      .limit(1);
    if (jaLiberada && jaLiberada.length > 0) continue;

    const { inserirMovimentacao } = await import("./ledger");
    await inserirMovimentacao({
      quadrupla: {
        produto_id: r.produto_id,
        empresa_dona_id: r.empresa_dona_id,
        galpao_id: r.galpao_id,
        localizacao_id: r.localizacao_id,
      },
      tipo: "L",
      qty: Number(r.quantidade),
      origem_tipo: "liberacao_reserva",
      origem_id: input.pedido_id,
      origem_detalhes: { motivo: input.motivo },
      usuario_id: input.usuario_id,
      observacoes: `liberada por ${input.motivo}`,
    });
    liberados++;
  }
  return liberados;
}

/**
 * Cron de cleanup: libera reservas expiradas que ainda não foram liberadas.
 */
export async function cleanupReservasExpiradas(): Promise<{
  total: number; liberadas: number; erros: number;
}> {
  const sb = createServiceClient();
  const { data: expiradas, error } = await sb.from("siso_movimentacoes")
    .select(`id, origem_id, produto_id, empresa_dona_id, galpao_id, localizacao_id, quantidade`)
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .lt("expira_em", new Date().toISOString());
  if (error) throw error;

  let liberadas = 0, erros = 0;
  for (const r of expiradas ?? []) {
    try {
      // Verifica se já foi liberada
      const { data: jaL } = await sb.from("siso_movimentacoes")
        .select("id").eq("origem_id", r.origem_id).eq("tipo", "L").limit(1);
      if (jaL && jaL.length > 0) continue;

      const { inserirMovimentacao } = await import("./ledger");
      await inserirMovimentacao({
        quadrupla: {
          produto_id: r.produto_id,
          empresa_dona_id: r.empresa_dona_id,
          galpao_id: r.galpao_id,
          localizacao_id: r.localizacao_id,
        },
        tipo: "L",
        qty: Number(r.quantidade),
        origem_tipo: "liberacao_reserva",
        origem_id: r.origem_id ?? undefined,
        origem_detalhes: { motivo: "expirado" },
        observacoes: `expirado: reserva sem NF/cancelamento, pedido ${r.origem_id}`,
      });
      // Marca pedido com status_alerta (se existir tabela siso_pedidos)
      await sb.from("siso_pedidos")
        .update({ status_alerta: "reserva_expirada" })
        .eq("id", r.origem_id)
        .then(() => {})
        .catch(() => {}); // não bloqueia se schema legado
      liberadas++;
    } catch (e) {
      logger.error("wms.reservas", "falha ao liberar expirada", { reserva: r.id, e });
      erros++;
    }
  }
  return { total: expiradas?.length ?? 0, liberadas, erros };
}
```

- [ ] **Step 3: Run tests, expect pass**

```bash
npm test -- reservas
```
Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/reservas.ts src/lib/wms/reservas.test.ts
git commit -m "feat(wms): reservas atômicas com TTL e cleanup"
```

---

### Task 10: API de cleanup de reservas

**Files:**
- Create: `src/app/api/wms/reservas/cleanup/route.ts`

- [ ] **Step 1: Endpoint cron-friendly**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { cleanupReservasExpiradas } from "@/lib/wms/reservas";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const result = await cleanupReservasExpiradas();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Configure cron (Supabase pg_cron ou Vercel Cron)**

Documentar no CLAUDE.md: chamar `GET /api/wms/reservas/cleanup` com header `x-worker-secret` a cada hora. Sugestão: criar pg_cron job:

```sql
SELECT cron.schedule(
  'wms-cleanup-reservas-expiradas',
  '0 * * * *',  -- a cada hora
  $$ SELECT net.http_get(
       'https://wrbrbhuhsaaupqsimkqz.supabase.co/api/wms/reservas/cleanup',
       headers => '{"x-worker-secret":"<secret>"}'::jsonb
     ); $$
);
```

(Ajustar URL pra produção real.)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/reservas/cleanup/
git commit -m "feat(wms): endpoint de cleanup de reservas expiradas"
```

---

### Task 11: Integração com webhook (escrita paralela)

**Files:**
- Modify: `src/lib/webhook-processor.ts`

- [ ] **Step 1: Identificar pontos de extensão**

Inspecione o fluxo atual: quando pedido é processado, em algum momento decide-se rota e cria-se itens. Antes de Fase 1 (dual-write completa), apenas **logamos** o que o novo schema decidiria, sem mudar o comportamento.

- [ ] **Step 2: Adicionar shadow log**

Em `webhook-processor.ts`, após o cálculo da decisão atual, antes de retornar:

```typescript
import { rotearPedidoDoBanco } from "./wms/roteamento";
import { logger } from "./logger";

// ... no fim do processamento, antes do retorno:
try {
  const novaDecisao = await rotearPedidoDoBanco(
    empresaVendedoraId,
    itensDoPedido.map(i => ({ produto_id: i.produto_id, qty: i.quantidade }))
  );
  logger.info("wms.shadow", "comparativo de decisão", {
    pedido: pedidoId,
    legado: decisaoLegada,  // referência à decisão atual
    novo: novaDecisao.decisao,
    match: decisaoLegada === novaDecisao.decisao,
  });
} catch (e) {
  logger.warn("wms.shadow", "falha em roteamento novo (shadow)", { e: String(e), pedidoId });
}
```

- [ ] **Step 3: Smoke test**

Em ambiente dev, dispare webhook fake e verifique logs.

- [ ] **Step 4: Commit**

```bash
git add src/lib/webhook-processor.ts
git commit -m "feat(wms): shadow logging compara roteamento novo vs legado"
```

---

### Task 12: Documentação

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/api-reference-complete.md`

- [ ] **Step 1: Atualizar CLAUDE.md**

- Adicionar `siso_fornecedores`, `siso_produto_fornecedores`, `siso_emprestimo_regras`, `siso_localizacao_locks` em "Database Tables"
- Adicionar arquivos novos em "Project Structure"
- Adicionar nota sobre cron `wms-cleanup-reservas-expiradas` na seção de cron jobs

- [ ] **Step 2: Documentar endpoints**

- `GET/POST /api/wms/fornecedores`, `PATCH/DELETE /api/wms/fornecedores/[id]`
- `GET/POST /api/wms/produto-fornecedores`, `PATCH/DELETE /api/wms/produto-fornecedores/[id]`
- `GET/POST /api/wms/emprestimo-regras`, `PATCH/DELETE /api/wms/emprestimo-regras/[id]`
- `GET /api/wms/emprestimos/saldos`
- `POST /api/wms/rotear`
- `GET /api/wms/reservas/cleanup` (worker secret)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/api-reference-complete.md
git commit -m "docs(wms): documenta roteamento, empréstimos e reservas"
```

---

## Critério de saída do Plano 3

### Critérios técnicos
- ✅ Algoritmo passa em todos os tests (geo-priority, próprio/empréstimo/OC, split detection).
- ✅ Reservas atômicas funcionam com lock pessimista (nenhum oversell em teste de concorrência).
- ✅ TTL cleanup libera reservas expiradas e não toca em ativas.
- ✅ Webhook escreve shadow log com decisão nova vs legada.
- ✅ Telas de fornecedores e empréstimos funcionam.
- ✅ Auto-seed criou ~14 fornecedores baseado em prefixos SKU.
- ✅ Documentação atualizada.

### Cenários funcionais de aceitação

1. **Fornecedor + lead time:** abrir `/wms/fornecedores`, ver lista pré-populada. Vincular um fornecedor a 1 produto com `lead_time_dias_medio=21`. Confirmar vínculo aparece.
2. **Matriz de empréstimo:** criar regra NetAir → NetParts em `/wms/emprestimos`. Definir `limite_max_por_produto = 50` pra um SKU. Ver na lista expandida.
3. **Roteamento próprio (auto-aprovação):** disparar `POST /api/wms/rotear` com SKU que tem saldo na vendedora. Resposta `decisao: 'propria'` com galpão home priorizado.
4. **Roteamento com empréstimo:** disparar com SKU sem saldo na vendedora mas com saldo na credora. Resposta `decisao: 'emprestimo'`. Na rota, `empresa_dona_id` ≠ vendedora.
5. **Roteamento OC (split):** pedido com 2 SKUs onde nenhum galpão único cobre ambos. Resposta `decisao: 'oc'` com motivo `split_galpoes`.
6. **Reserva + TTL:** criar reserva manualmente, esperar 48h+1min (ou ajustar `expira_em` direto no DB pra simular), rodar cron de cleanup, confirmar que mov de liberação foi gerada e `reservado` da linha caiu.

**SLA:** sem prazo fixo.

**Próximo:** Plano 4 — só após seu OK explícito.
