# WMS 5 — Exceções e dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fecha a Fase 0 do WMS — fluxos reversos (devoluções classificadas, troca SKU na separação) e visibilidade gerencial completa (dashboard de cobertura por giro, dashboard geral de eventos críticos). Após esse plano, todas as exceções operacionais têm fluxo formal e o time tem visão única dos sinais críticos.

**Architecture:** Devoluções entram em fila `siso_devolucoes_pendentes` quando NF webhook chega; operador classifica quando mercadoria chega fisicamente. Troca SKU usa novo `origem_tipo` (`troca_sku_in/out`) com mesma `origem_id` ligando 4 movs. Dashboard de cobertura via materialized view com refresh diário. Dashboard geral agrega de várias fontes em uma tela só.

**Tech Stack:** mesmo dos planos anteriores.

**Spec de referência:** [docs/superpowers/specs/2026-05-07-wms-design.md](../specs/2026-05-07-wms-design.md) — §5.4, 5.8, 8.

**Pré-requisitos:** Planos 1-4 concluídos.

---

## File Structure

| Caminho | Responsabilidade |
|---|---|
| `supabase/migrations/20260605_wms_excecoes_dashboards.sql` | siso_devolucoes_pendentes + materialized view siso_cobertura_estoque |
| `src/lib/wms/devolucoes.ts` | Fluxo de classificação A/B/C/D |
| `src/lib/wms/devolucoes.test.ts` | Tests |
| `src/lib/wms/troca-sku.ts` | Lógica de troca de SKU na separação |
| `src/lib/wms/troca-sku.test.ts` | Tests |
| `src/lib/wms/cobertura.ts` | Service de cálculo e refresh |
| `src/lib/wms/dashboard-geral.ts` | Agrega contadores pra dashboard |
| `src/app/api/webhook/tiny/route.ts` (modify) | Captura webhook NF devolução |
| `src/app/api/wms/devolucoes/route.ts` | GET (fila pendente) |
| `src/app/api/wms/devolucoes/[id]/classificar/route.ts` | POST (classifica) |
| `src/app/api/wms/troca-sku/route.ts` | POST (executa troca) |
| `src/app/api/wms/cobertura/route.ts` | GET (lista com filtros) |
| `src/app/api/wms/cobertura/refresh/route.ts` | GET (cron) |
| `src/app/api/wms/dashboard-geral/route.ts` | GET (contadores agregados) |
| `src/app/wms/devolucoes/page.tsx` | Fila de devoluções pendentes |
| `src/app/wms/devolucoes/[id]/page.tsx` | Tela de classificação |
| `src/app/wms/troca-sku/page.tsx` | Tela de troca de SKU |
| `src/app/wms/cobertura/page.tsx` | Dashboard de cobertura por giro |
| `src/app/wms/dashboard/page.tsx` | Dashboard geral de eventos críticos |

---

### Task 1: Migration — devoluções e cobertura

**Files:**
- Create: `supabase/migrations/20260605_wms_excecoes_dashboards.sql`

- [ ] **Step 1: Migration**

```sql
BEGIN;

-- 1. Fila de devoluções pendentes
CREATE TABLE siso_devolucoes_pendentes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nota_fiscal_id bigint,
  chave_acesso_nf text,
  pedido_origem_id text,                  -- id do pedido original (Tiny ou SISO)
  pedido_origem_mov_id uuid REFERENCES siso_movimentacoes(id),  -- mov de venda original (se identificada)
  empresa_id uuid REFERENCES siso_empresas(id),
  status text NOT NULL DEFAULT 'aguardando_classificacao' CHECK (status IN (
    'aguardando_classificacao','classificada','aplicada','cancelada'
  )),
  classificacao text CHECK (classificacao IN ('integro','avariado','garantia','troca_sku')),
  classificada_por uuid REFERENCES siso_usuarios(id),
  classificada_em timestamptz,
  payload_webhook jsonb NOT NULL DEFAULT '{}',
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dev_pend_status ON siso_devolucoes_pendentes(status);
CREATE INDEX idx_dev_pend_nf ON siso_devolucoes_pendentes(nota_fiscal_id) WHERE nota_fiscal_id IS NOT NULL;

-- 2. Materialized view de cobertura
CREATE MATERIALIZED VIEW siso_cobertura_estoque AS
WITH giro_30d AS (
  SELECT produto_id, empresa_dona_id, galpao_id,
         SUM(quantidade) / 30.0 AS giro_diario
  FROM siso_movimentacoes
  WHERE tipo = 'S'
    AND origem_tipo IN ('nf_venda','emprestimo')
    AND criado_em >= now() - interval '30 days'
    AND estorno_de IS NULL
  GROUP BY produto_id, empresa_dona_id, galpao_id
),
saldo_agregado AS (
  SELECT produto_id, empresa_dona_id, galpao_id,
         SUM(disponivel) AS disponivel_total
  FROM siso_estoque
  GROUP BY produto_id, empresa_dona_id, galpao_id
),
lead_pref AS (
  SELECT pf.produto_id, pf.lead_time_dias_medio
  FROM siso_produto_fornecedores pf
  WHERE pf.preferencial = true AND pf.ativo = true
)
SELECT
  s.produto_id,
  s.empresa_dona_id,
  s.galpao_id,
  s.disponivel_total,
  COALESCE(g.giro_diario, 0) AS giro_diario,
  CASE WHEN g.giro_diario > 0
       THEN s.disponivel_total / g.giro_diario
       ELSE NULL END AS dias_cobertura,
  lp.lead_time_dias_medio AS lead_time_medio,
  CASE
    WHEN g.giro_diario IS NULL OR g.giro_diario = 0 THEN 'sem_giro'
    WHEN s.disponivel_total / g.giro_diario < 7 THEN 'critico'
    WHEN s.disponivel_total / g.giro_diario < 14 THEN 'atencao'
    WHEN lp.lead_time_dias_medio IS NOT NULL
      AND s.disponivel_total / g.giro_diario < lp.lead_time_dias_medio THEN 'lead_time_risco'
    ELSE 'ok'
  END AS status_cobertura
FROM saldo_agregado s
LEFT JOIN giro_30d g USING (produto_id, empresa_dona_id, galpao_id)
LEFT JOIN lead_pref lp USING (produto_id);

CREATE UNIQUE INDEX uq_cobertura
  ON siso_cobertura_estoque(produto_id, empresa_dona_id, galpao_id);
CREATE INDEX idx_cobertura_status
  ON siso_cobertura_estoque(status_cobertura, dias_cobertura);

COMMIT;
```

- [ ] **Step 2: Apply migration**

Via `mcp__supabase__apply_migration` name=`wms_excecoes_dashboards`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260605_wms_excecoes_dashboards.sql
git commit -m "feat(wms): tabelas de devoluções e materialized view de cobertura"
```

---

### Task 2: Service de devoluções

**Files:**
- Create: `src/lib/wms/devolucoes.ts`
- Create: `src/lib/wms/devolucoes.test.ts`

- [ ] **Step 1: Tests**

```typescript
import { describe, it, expect } from "vitest";
import { resolverDonaDestino } from "./devolucoes";

describe("resolverDonaDestino", () => {
  it("venda própria: dona = empresa vendedora", () => {
    const r = resolverDonaDestino({ origem_tipo: "nf_venda", empresa_dona_id: "v1", emprestimo_devedora_id: null });
    expect(r).toEqual({ dona_id: "v1", quita_emprestimo: false });
  });

  it("empréstimo: dona = credora original (auto-quita)", () => {
    const r = resolverDonaDestino({ origem_tipo: "emprestimo", empresa_dona_id: "credora", emprestimo_devedora_id: "vendedora" });
    expect(r).toEqual({ dona_id: "credora", quita_emprestimo: true });
  });
});
```

- [ ] **Step 2: Implement**

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import { logger } from "@/lib/logger";

export type Classificacao = "integro" | "avariado" | "garantia" | "troca_sku";

export interface MovOrigemVenda {
  origem_tipo: string;
  empresa_dona_id: string;
  emprestimo_devedora_id: string | null;
}

export function resolverDonaDestino(mov: MovOrigemVenda): { dona_id: string; quita_emprestimo: boolean } {
  const quita = mov.origem_tipo === "emprestimo";
  return { dona_id: mov.empresa_dona_id, quita_emprestimo: quita };
}

export async function registrarDevolucaoPendente(input: {
  nota_fiscal_id?: number;
  chave_acesso_nf?: string;
  pedido_origem_id?: string;
  empresa_id?: string;
  payload_webhook: any;
}): Promise<string> {
  const sb = createServiceClient();

  // Tenta identificar mov de venda original
  let pedidoOrigemMovId: string | null = null;
  if (input.nota_fiscal_id) {
    const { data: mov } = await sb.from("siso_movimentacoes")
      .select("id").eq("nota_fiscal_id", input.nota_fiscal_id).eq("tipo", "S").maybeSingle();
    pedidoOrigemMovId = mov?.id ?? null;
  }

  const { data, error } = await sb.from("siso_devolucoes_pendentes")
    .insert({
      nota_fiscal_id: input.nota_fiscal_id,
      chave_acesso_nf: input.chave_acesso_nf,
      pedido_origem_id: input.pedido_origem_id,
      pedido_origem_mov_id: pedidoOrigemMovId,
      empresa_id: input.empresa_id,
      payload_webhook: input.payload_webhook,
    }).select().single();
  if (error) throw error;
  return data.id;
}

export interface ClassificarInput {
  devolucao_id: string;
  classificacao: Classificacao;
  galpao_id: string;
  localizacao_id: string;
  produto_id: string;
  empresa_dona_destino_id?: string;  // override; senão usa resolução automática
  qty: number;
  observacoes?: string;
  usuario_id: string;
}

export async function classificarDevolucao(input: ClassificarInput): Promise<void> {
  const sb = createServiceClient();
  const { data: dev, error } = await sb.from("siso_devolucoes_pendentes")
    .select("*").eq("id", input.devolucao_id).single();
  if (error || !dev) throw new Error("devolução não encontrada");
  if (dev.status !== "aguardando_classificacao") throw new Error("já classificada");

  // Resolve dona destino
  let donaId = input.empresa_dona_destino_id;
  if (!donaId && dev.pedido_origem_mov_id) {
    const { data: mov } = await sb.from("siso_movimentacoes").select("origem_tipo, empresa_dona_id, emprestimo_devedora_id").eq("id", dev.pedido_origem_mov_id).single();
    if (mov) donaId = resolverDonaDestino(mov as any).dona_id;
  }
  if (!donaId) throw new Error("não foi possível resolver dona destino; informe empresa_dona_destino_id");

  const quadrupla = {
    produto_id: input.produto_id,
    empresa_dona_id: donaId,
    galpao_id: input.galpao_id,
    localizacao_id: input.localizacao_id,
  };

  switch (input.classificacao) {
    case "integro":
      await inserirMovimentacao({
        quadrupla, tipo: "E", qty: input.qty,
        origem_tipo: "nf_devolucao_cliente",
        nota_fiscal_id: dev.nota_fiscal_id ?? undefined,
        usuario_id: input.usuario_id,
        observacoes: input.observacoes,
      });
      break;
    case "avariado":
      // Par atômico: entra fiscalmente + sai pra quarentena (origem ajuste_manual com motivo='avaria')
      await inserirMovimentacao({
        quadrupla, tipo: "E", qty: input.qty,
        origem_tipo: "nf_devolucao_avariada",
        nota_fiscal_id: dev.nota_fiscal_id ?? undefined,
        usuario_id: input.usuario_id,
      });
      // Localização de quarentena: se existe; senão usa a mesma e marca observação
      const { data: quarentena } = await sb.from("siso_localizacoes")
        .select("id").match({ galpao_id: input.galpao_id, tipo: "quarentena", ativo: true }).limit(1).maybeSingle();
      const locDestinoQuarentena = quarentena?.id ?? input.localizacao_id;
      // Transferência interna pra quarentena (ou ajuste se mesma loc)
      if (quarentena) {
        await inserirMovimentacao({
          quadrupla, tipo: "S", qty: input.qty,
          origem_tipo: "transferencia_localizacao",
          usuario_id: input.usuario_id,
          observacoes: `avaria → quarentena: ${input.observacoes ?? ""}`,
        });
        await inserirMovimentacao({
          quadrupla: { ...quadrupla, localizacao_id: locDestinoQuarentena },
          tipo: "E", qty: input.qty,
          origem_tipo: "transferencia_localizacao",
          usuario_id: input.usuario_id,
        });
      } else {
        await inserirMovimentacao({
          quadrupla, tipo: "S", qty: input.qty,
          origem_tipo: "ajuste_manual",
          origem_detalhes: { motivo: "avaria_devolucao_sem_quarentena" },
          usuario_id: input.usuario_id,
        });
      }
      break;
    case "garantia":
      // Entra na quarentena, sai pra fornecedor (RMA — fluxo manual)
      await inserirMovimentacao({
        quadrupla, tipo: "E", qty: input.qty,
        origem_tipo: "nf_devolucao_cliente",
        usuario_id: input.usuario_id,
      });
      await inserirMovimentacao({
        quadrupla, tipo: "S", qty: input.qty,
        origem_tipo: "nf_devolucao_fornecedor",
        usuario_id: input.usuario_id,
        observacoes: `garantia: ${input.observacoes ?? ""}`,
      });
      break;
    case "troca_sku":
      // Trata via fluxo de troca em separado (Plano de troca-sku); registra entrada normal aqui
      await inserirMovimentacao({
        quadrupla, tipo: "E", qty: input.qty,
        origem_tipo: "nf_devolucao_cliente",
        usuario_id: input.usuario_id,
        observacoes: `troca SKU: ${input.observacoes ?? ""}`,
      });
      break;
  }

  await sb.from("siso_devolucoes_pendentes").update({
    status: "classificada",
    classificacao: input.classificacao,
    classificada_por: input.usuario_id,
    classificada_em: new Date().toISOString(),
    observacoes: input.observacoes,
  }).eq("id", input.devolucao_id);

  logger.info("wms.devolucoes", "classificada", { devolucao_id: input.devolucao_id, classificacao: input.classificacao });
}

export async function listarDevolucoesPendentes(): Promise<any[]> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_devolucoes_pendentes")
    .select("*, empresa:siso_empresas(nome)")
    .eq("status", "aguardando_classificacao")
    .order("criado_em", { ascending: false });
  if (error) throw error;
  return data ?? [];
}
```

- [ ] **Step 3: Run tests, expect pass**

```bash
npm test -- devolucoes
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/devolucoes.ts src/lib/wms/devolucoes.test.ts
git commit -m "feat(wms): service de devoluções com classificação A/B/C/D"
```

---

### Task 3: Webhook NF devolução

**Files:**
- Modify: `src/app/api/webhook/tiny/route.ts`

- [ ] **Step 1: Detectar webhook de devolução**

Inspecionar `/api/webhook/tiny/route.ts` e identificar onde NFs entrantes são processadas. Adicionar branch:

```typescript
import { registrarDevolucaoPendente } from "@/lib/wms/devolucoes";

// dentro do handler, após decodificar payload:
if (payload?.dados?.tipo_nota === "devolucao" || payload?.tipo === "nota_fiscal" && payload?.dados?.tipo_operacao === "E") {
  try {
    await registrarDevolucaoPendente({
      nota_fiscal_id: payload?.dados?.id ?? undefined,
      chave_acesso_nf: payload?.dados?.chave_acesso ?? undefined,
      pedido_origem_id: payload?.dados?.numero_pedido ?? undefined,
      empresa_id: empresaIdResolvida,  // já resolvido em fluxo prévio
      payload_webhook: payload,
    });
    logger.info("webhook.tiny", "devolução registrada na fila WMS", {});
  } catch (e) {
    logger.error("webhook.tiny", "falha ao registrar devolução", { e: String(e) });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/webhook/tiny/route.ts
git commit -m "feat(wms): webhook detecta NF de devolução e cria fila pendente"
```

---

### Task 4: APIs de devoluções

**Files:**
- Create: `src/app/api/wms/devolucoes/route.ts`
- Create: `src/app/api/wms/devolucoes/[id]/classificar/route.ts`

- [ ] **Step 1: GET pendentes**

```typescript
// src/app/api/wms/devolucoes/route.ts
import { NextRequest, NextResponse } from "next/server";
import { listarDevolucoesPendentes } from "@/lib/wms/devolucoes";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ rows: await listarDevolucoesPendentes() });
}
```

- [ ] **Step 2: POST classificar**

```typescript
// src/app/api/wms/devolucoes/[id]/classificar/route.ts
import { NextRequest, NextResponse } from "next/server";
import { classificarDevolucao } from "@/lib/wms/devolucoes";
import { getSessionUser } from "@/lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  try {
    await classificarDevolucao({ ...body, devolucao_id: id, usuario_id: user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/devolucoes/
git commit -m "feat(wms): APIs de fila e classificação de devoluções"
```

---

### Task 5: Telas de devoluções

**Files:**
- Create: `src/app/wms/devolucoes/page.tsx`
- Create: `src/app/wms/devolucoes/[id]/page.tsx`

- [ ] **Step 1: Listagem**

```tsx
"use client";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import Link from "next/link";

export default function DevolucoesPage() {
  const { data } = useQuery({
    queryKey: ["wms-devolucoes"],
    queryFn: async () => (await sisoFetch("/api/wms/devolucoes")).json() as Promise<{ rows: any[] }>,
  });

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-medium">Devoluções pendentes</h1>
      <p className="text-sm text-zinc-500">Aguardando chegada física e classificação pelo operador.</p>
      <div className="space-y-2">
        {data?.rows.map(d => (
          <Link key={d.id} href={`/wms/devolucoes/${d.id}`}
            className="block p-3 rounded border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-xs">NF {d.nota_fiscal_id ?? "—"}</span>
                <span className="ml-2 text-sm">{d.empresa?.nome}</span>
              </div>
              <div className="text-xs text-zinc-500">{new Date(d.criado_em).toLocaleString("pt-BR")}</div>
            </div>
          </Link>
        ))}
        {data?.rows.length === 0 && <div className="text-zinc-500 text-sm">nenhuma devolução pendente</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Tela de classificação**

```tsx
"use client";
import { use, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";

export default function ClassificarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [classificacao, setClassificacao] = useState<"integro" | "avariado" | "garantia" | "troca_sku">("integro");
  const [produto_id, setProduto] = useState<string>();
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState(1);
  const [q, setQ] = useState<{ empresa_id?: string; galpao_id?: string; localizacao_id?: string }>({});
  const [observacoes, setObservacoes] = useState("");

  const { data: devs } = useQuery({ queryKey: ["wms-devolucoes"], queryFn: async () => (await sisoFetch("/api/wms/devolucoes")).json() });
  const dev = devs?.rows?.find((x: any) => x.id === id);

  async function buscar(s: string) {
    const r = await (await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`)).json();
    if (r.rows?.[0]) { setProduto(r.rows[0].id); setSku(r.rows[0].sku); } else toast.error("SKU não encontrado");
  }

  const submit = useMutation({
    mutationFn: async () => sisoFetch(`/api/wms/devolucoes/${id}/classificar`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classificacao, produto_id, qty,
        galpao_id: q.galpao_id, localizacao_id: q.localizacao_id,
        empresa_dona_destino_id: q.empresa_id,
        observacoes,
      }),
    }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: () => { toast.success("classificada"); router.push("/wms/devolucoes"); },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-3 max-w-xl">
      <h1 className="text-lg font-medium">Classificar devolução</h1>
      {dev && <div className="text-sm text-zinc-500">NF {dev.nota_fiscal_id ?? "—"} · {dev.empresa?.nome}</div>}

      <select value={classificacao} onChange={e => setClassificacao(e.target.value as any)}
        className="px-3 py-2 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent w-full">
        <option value="integro">A — Íntegro (volta ao estoque)</option>
        <option value="avariado">B — Avariado (vai pra quarentena)</option>
        <option value="garantia">C — Garantia (RMA fornecedor)</option>
        <option value="troca_sku">D — Troca SKU pelo cliente</option>
      </select>

      <QuadruplaPicker value={q} onChange={setQ} />

      <div className="flex gap-2">
        <input value={sku} onChange={e => setSku(e.target.value)} onBlur={e => e.target.value && buscar(e.target.value)}
          placeholder="SKU" className="flex-1 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono" />
        <input type="number" min={1} value={qty} onChange={e => setQty(Number(e.target.value))}
          className="w-24 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent" />
      </div>

      <textarea value={observacoes} onChange={e => setObservacoes(e.target.value)} placeholder="observações"
        className="w-full px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent" rows={3} />

      <button onClick={() => submit.mutate()} disabled={!produto_id || !q.localizacao_id || submit.isPending}
        className="px-4 py-2 rounded bg-zinc-900 text-white">classificar</button>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/devolucoes/
git commit -m "feat(wms): telas de fila e classificação de devoluções"
```

---

### Task 6: Service e API de troca SKU

**Files:**
- Create: `src/lib/wms/troca-sku.ts`
- Create: `src/lib/wms/troca-sku.test.ts`
- Create: `src/app/api/wms/troca-sku/route.ts`

- [ ] **Step 1: Tests + service**

```typescript
// src/lib/wms/troca-sku.test.ts
import { describe, it, expect } from "vitest";
import { validarTroca } from "./troca-sku";

describe("validarTroca", () => {
  it("rejeita troca pelo mesmo SKU", () => {
    expect(() => validarTroca({ produto_original_id: "x", produto_substituto_id: "x" })).toThrow(/mesmo SKU/i);
  });
  it("aceita SKUs diferentes", () => {
    expect(() => validarTroca({ produto_original_id: "a", produto_substituto_id: "b" })).not.toThrow();
  });
});
```

```typescript
// src/lib/wms/troca-sku.ts
import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import type { Quadrupla } from "./types";
import { logger } from "@/lib/logger";

export function validarTroca(input: { produto_original_id: string; produto_substituto_id: string }): void {
  if (input.produto_original_id === input.produto_substituto_id) {
    throw new Error("não é possível trocar pelo mesmo SKU");
  }
}

export interface TrocaSkuInput {
  pedido_id: string;
  quadrupla_original: Quadrupla;            // X reservado (atual)
  quadrupla_substituto: Quadrupla;          // Y a reservar
  qty: number;
  ttl_horas?: number;
  motivo?: string;
  usuario_id: string;
  validar_equivalencia_cross?: boolean;     // default true: chama Cross pra validar
}

export async function trocarSku(input: TrocaSkuInput): Promise<void> {
  validarTroca({
    produto_original_id: input.quadrupla_original.produto_id,
    produto_substituto_id: input.quadrupla_substituto.produto_id,
  });

  // Validação Cross (equivalência registrada via SKU em siso_produto_links sku_a/sku_b)
  if (input.validar_equivalencia_cross !== false) {
    const sb = createServiceClient();
    // Resolve SKUs dos produtos
    const { data: produtos } = await sb.from("siso_produtos")
      .select("id, sku")
      .in("id", [input.quadrupla_original.produto_id, input.quadrupla_substituto.produto_id]);
    const skuOriginal = produtos?.find(p => p.id === input.quadrupla_original.produto_id)?.sku;
    const skuSubstituto = produtos?.find(p => p.id === input.quadrupla_substituto.produto_id)?.sku;
    if (skuOriginal && skuSubstituto) {
      const { data: equiv } = await sb.from("siso_produto_links")
        .select("id")
        .or(`and(sku_a.eq.${skuOriginal},sku_b.eq.${skuSubstituto}),and(sku_a.eq.${skuSubstituto},sku_b.eq.${skuOriginal})`)
        .limit(1).maybeSingle();
      if (!equiv) {
        logger.warn("wms.troca", "equivalência não registrada no Cross", { skuOriginal, skuSubstituto });
        // Em v1 não bloqueamos, mas o aviso fica logado. Time pode endurecer depois.
      }
    }
  }

  const expira = new Date(Date.now() + (input.ttl_horas ?? 48) * 3600 * 1000).toISOString();

  // 1. Libera reserva do original (mov L tipo origem='troca_sku_out')
  await inserirMovimentacao({
    quadrupla: input.quadrupla_original,
    tipo: "L", qty: input.qty,
    origem_tipo: "troca_sku_out",
    origem_id: input.pedido_id,
    origem_detalhes: { motivo: input.motivo, substituto_produto_id: input.quadrupla_substituto.produto_id },
    usuario_id: input.usuario_id,
    observacoes: `trocado por outro SKU, pedido ${input.pedido_id}`,
  });

  // 2. Reserva substituto (mov R tipo origem='troca_sku_in')
  await inserirMovimentacao({
    quadrupla: input.quadrupla_substituto,
    tipo: "R", qty: input.qty,
    origem_tipo: "troca_sku_in",
    origem_id: input.pedido_id,
    expira_em: expira,
    origem_detalhes: { motivo: input.motivo, original_produto_id: input.quadrupla_original.produto_id },
    usuario_id: input.usuario_id,
    observacoes: `substitui SKU original no pedido ${input.pedido_id}`,
  });
}
```

- [ ] **Step 2: API**

```typescript
// src/app/api/wms/troca-sku/route.ts
import { NextRequest, NextResponse } from "next/server";
import { trocarSku } from "@/lib/wms/troca-sku";
import { getSessionUser } from "@/lib/session";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.pedido_id || !body.quadrupla_original || !body.quadrupla_substituto || !body.qty) {
    return NextResponse.json({ error: "campos obrigatórios faltando" }, { status: 400 });
  }
  try {
    await trocarSku({ ...body, usuario_id: user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

- [ ] **Step 3: Tela**

```tsx
// src/app/wms/troca-sku/page.tsx
"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";
import { ArrowDown } from "lucide-react";

export default function TrocaSkuPage() {
  const [pedidoId, setPedidoId] = useState("");
  const [original, setOriginal] = useState<any>({});
  const [substituto, setSubstituto] = useState<any>({});
  const [qty, setQty] = useState(1);
  const [motivo, setMotivo] = useState("");

  async function buscarSku(sku: string, set: (id: string) => void) {
    const r = await (await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(sku)}&limit=1`)).json();
    if (r.rows?.[0]) set(r.rows[0].id); else toast.error("SKU não encontrado");
  }

  const submit = useMutation({
    mutationFn: async () => sisoFetch("/api/wms/troca-sku", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pedido_id: pedidoId, qty, motivo,
        quadrupla_original: original,
        quadrupla_substituto: substituto,
      }),
    }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: () => toast.success("troca registrada"),
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-3 max-w-2xl">
      <h1 className="text-lg font-medium">Troca de SKU na separação</h1>
      <input value={pedidoId} onChange={e => setPedidoId(e.target.value)} placeholder="ID do pedido"
        className="w-full px-2 py-1 rounded border bg-transparent" />

      <div>
        <h3 className="text-sm font-medium">SKU original (estorna reserva)</h3>
        <input placeholder="SKU original" onBlur={e => e.target.value && buscarSku(e.target.value, id => setOriginal({ ...original, produto_id: id }))}
          className="w-40 px-2 py-1 rounded border bg-transparent font-mono mb-2" />
        <QuadruplaPicker value={original} onChange={v => setOriginal({ ...original, ...v })} />
      </div>

      <ArrowDown className="w-4 h-4 mx-auto" />

      <div>
        <h3 className="text-sm font-medium">SKU substituto (cria reserva)</h3>
        <input placeholder="SKU substituto" onBlur={e => e.target.value && buscarSku(e.target.value, id => setSubstituto({ ...substituto, produto_id: id }))}
          className="w-40 px-2 py-1 rounded border bg-transparent font-mono mb-2" />
        <QuadruplaPicker value={substituto} onChange={v => setSubstituto({ ...substituto, ...v })} />
      </div>

      <div className="flex gap-2">
        <input type="number" min={1} value={qty} onChange={e => setQty(Number(e.target.value))}
          className="w-24 px-2 py-1 rounded border bg-transparent" />
        <input value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="motivo"
          className="flex-1 px-2 py-1 rounded border bg-transparent" />
      </div>

      <button onClick={() => submit.mutate()} disabled={!pedidoId || !original.produto_id || !substituto.produto_id}
        className="px-4 py-2 rounded bg-zinc-900 text-white">trocar</button>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/troca-sku.ts src/lib/wms/troca-sku.test.ts src/app/api/wms/troca-sku/ src/app/wms/troca-sku/
git commit -m "feat(wms): troca de SKU na separação com integração Cross"
```

---

### Task 7: Cobertura — service + API + refresh

**Files:**
- Create: `src/lib/wms/cobertura.ts`
- Create: `src/app/api/wms/cobertura/route.ts`
- Create: `src/app/api/wms/cobertura/refresh/route.ts`

- [ ] **Step 1: Service**

```typescript
import { createServiceClient } from "@/lib/supabase-server";

export interface LinhaCobertura {
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  disponivel_total: number;
  giro_diario: number;
  dias_cobertura: number | null;
  lead_time_medio: number | null;
  status_cobertura: "critico" | "atencao" | "ok" | "sem_giro" | "lead_time_risco";
}

export async function listarCobertura(filtros: { status?: string; galpao_id?: string } = {}): Promise<LinhaCobertura[]> {
  const sb = createServiceClient();
  let q = sb.from("siso_cobertura_estoque" as any)
    .select(`*, produto:siso_produtos(sku, descricao), galpao:siso_galpoes(nome), empresa:siso_empresas(nome)`)
    .order("dias_cobertura", { ascending: true, nullsLast: true })
    .limit(500);
  if (filtros.status) q = q.eq("status_cobertura", filtros.status);
  if (filtros.galpao_id) q = q.eq("galpao_id", filtros.galpao_id);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as any;
}

export async function refreshCobertura(): Promise<void> {
  const sb = createServiceClient();
  const { error } = await sb.rpc("refresh_materialized_view" as any, { view_name: "siso_cobertura_estoque" });
  if (error) {
    // Fallback via SQL direto se RPC não existir
    await sb.rpc("wms_refresh_cobertura" as any);
  }
}
```

Adicionar RPC pra refresh em migration nova:

```sql
-- supabase/migrations/20260605_wms_cobertura_refresh_rpc.sql
CREATE OR REPLACE FUNCTION wms_refresh_cobertura()
RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW siso_cobertura_estoque;
$$;
```

- [ ] **Step 2: APIs**

```typescript
// src/app/api/wms/cobertura/route.ts
import { NextRequest, NextResponse } from "next/server";
import { listarCobertura } from "@/lib/wms/cobertura";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  return NextResponse.json({
    rows: await listarCobertura({
      status: sp.get("status") ?? undefined,
      galpao_id: sp.get("galpao_id") ?? undefined,
    })
  });
}
```

```typescript
// src/app/api/wms/cobertura/refresh/route.ts
import { NextRequest, NextResponse } from "next/server";
import { refreshCobertura } from "@/lib/wms/cobertura";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await refreshCobertura();
  return NextResponse.json({ ok: true });
}
```

Configure cron diário 03h chamando `GET /api/wms/cobertura/refresh`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/cobertura.ts src/app/api/wms/cobertura/ supabase/migrations/20260605_wms_cobertura_refresh_rpc.sql
git commit -m "feat(wms): service e API de cobertura com refresh diário"
```

---

### Task 8: Tela de cobertura

**Files:**
- Create: `src/app/wms/cobertura/page.tsx`

- [ ] **Step 1: Page**

```tsx
"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  critico: { label: "🔴 Crítico", color: "bg-red-100 text-red-900" },
  lead_time_risco: { label: "🟠 Risco vs lead time", color: "bg-orange-100 text-orange-900" },
  atencao: { label: "🟡 Atenção", color: "bg-yellow-100 text-yellow-900" },
  ok: { label: "🟢 Ok", color: "bg-green-100 text-green-900" },
  sem_giro: { label: "⚫ Sem giro", color: "bg-zinc-200 text-zinc-700" },
};

export default function CoberturaPage() {
  const [status, setStatus] = useState("");
  const { data } = useQuery({
    queryKey: ["wms-cobertura", status],
    queryFn: async () => (await sisoFetch(`/api/wms/cobertura${status ? `?status=${status}` : ""}`)).json(),
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="px-2 py-1 rounded border bg-transparent">
          <option value="">todos</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-zinc-500"><th>SKU</th><th>galpão</th><th>empresa</th><th className="text-right">disponível</th><th className="text-right">giro/dia</th><th className="text-right">dias</th><th className="text-right">lead</th><th>status</th></tr></thead>
        <tbody>
          {data?.rows.map((r: any, i: number) => (
            <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="font-mono text-xs">{r.produto?.sku}</td>
              <td>{r.galpao?.nome}</td>
              <td>{r.empresa?.nome}</td>
              <td className="text-right tabular-nums">{Number(r.disponivel_total).toLocaleString("pt-BR")}</td>
              <td className="text-right tabular-nums">{Number(r.giro_diario).toFixed(2)}</td>
              <td className="text-right tabular-nums">{r.dias_cobertura ? Number(r.dias_cobertura).toFixed(1) : "—"}</td>
              <td className="text-right tabular-nums">{r.lead_time_medio ?? "—"}</td>
              <td><span className={`text-xs px-2 py-0.5 rounded ${STATUS_LABELS[r.status_cobertura]?.color}`}>{STATUS_LABELS[r.status_cobertura]?.label}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/wms/cobertura/
git commit -m "feat(wms): dashboard de cobertura por giro com cross de lead time"
```

---

### Task 9: Dashboard geral

**Files:**
- Create: `src/lib/wms/dashboard-geral.ts`
- Create: `src/app/api/wms/dashboard-geral/route.ts`
- Create: `src/app/wms/dashboard/page.tsx`

- [ ] **Step 1: Service de agregação**

```typescript
import { createServiceClient } from "@/lib/supabase-server";

export async function dashboardGeral() {
  const sb = createServiceClient();
  const [cobertura, sessoesAtivas, divergenciasPend, reservasExp, retroativosPend, locks, saldosDevedores] = await Promise.all([
    // Cobertura por status
    sb.from("siso_cobertura_estoque" as any).select("status_cobertura"),
    // Sessões inventário em andamento
    sb.from("siso_inventario_sessoes").select("id").eq("status", "em_andamento"),
    // Divergências pendentes
    sb.from("siso_inventario_divergencias").select("id").eq("status", "pendente"),
    // Reservas expirando em 6h
    sb.from("siso_movimentacoes").select("id")
      .eq("tipo", "R").eq("origem_tipo", "reserva_pedido")
      .lte("expira_em", new Date(Date.now() + 6 * 3600 * 1000).toISOString())
      .gt("expira_em", new Date().toISOString()),
    // Lançamentos retroativos não reconciliados
    sb.from("siso_movimentacoes").select("id, criado_em")
      .eq("origem_tipo", "lancamento_retroativo"),
    // Locks > 1h
    sb.from("siso_localizacao_locks").select("id, iniciado_em")
      .is("finalizado_em", null)
      .lt("iniciado_em", new Date(Date.now() - 3600 * 1000).toISOString()),
    // Saldos devedores agregados
    sb.rpc("wms_saldos_devedores"),
  ]);

  const cobByStatus = (cobertura.data ?? []).reduce((acc: Record<string, number>, r: any) => {
    acc[r.status_cobertura] = (acc[r.status_cobertura] ?? 0) + 1;
    return acc;
  }, {});

  // Filtra retroativos não reconciliados (sem mov de estorno apontando)
  const retroativosIds = (retroativosPend.data ?? []).map(r => r.id);
  const { data: estornos } = await sb.from("siso_movimentacoes").select("estorno_de").in("estorno_de", retroativosIds);
  const reconciliados = new Set((estornos ?? []).map(e => e.estorno_de));
  const retroativosOrfaos = retroativosIds.filter(id => !reconciliados.has(id)).length;

  return {
    cobertura: cobByStatus,
    inventario: {
      sessoesAtivas: sessoesAtivas.data?.length ?? 0,
      divergenciasPend: divergenciasPend.data?.length ?? 0,
      locksAntigos: locks.data?.length ?? 0,
    },
    reservas: {
      expiraEm6h: reservasExp.data?.length ?? 0,
    },
    retroativosOrfaos,
    emprestimos: {
      paresComSaldo: (saldosDevedores.data ?? []).length,
    },
  };
}
```

- [ ] **Step 2: API**

```typescript
// src/app/api/wms/dashboard-geral/route.ts
import { NextRequest, NextResponse } from "next/server";
import { dashboardGeral } from "@/lib/wms/dashboard-geral";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await dashboardGeral());
}
```

- [ ] **Step 3: Tela**

```tsx
// src/app/wms/dashboard/page.tsx
"use client";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import Link from "next/link";

function Card({ titulo, items, href }: { titulo: string; items: { label: string; valor: number | string; emoji?: string }[]; href?: string }) {
  const Wrapper: any = href ? Link : "div";
  return (
    <Wrapper href={href} className="block p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900">
      <div className="text-sm font-medium mb-2">{titulo}</div>
      <div className="space-y-1">
        {items.map((it, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span className="text-zinc-500">{it.emoji} {it.label}</span>
            <span className="tabular-nums font-medium">{it.valor}</span>
          </div>
        ))}
      </div>
    </Wrapper>
  );
}

export default function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["wms-dashboard"],
    queryFn: async () => (await sisoFetch("/api/wms/dashboard-geral")).json() as Promise<any>,
    refetchInterval: 30000,
  });

  if (isLoading) return <div className="text-zinc-500">carregando...</div>;
  if (!data) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      <Card titulo="Cobertura" href="/wms/cobertura" items={[
        { label: "Crítico (<7d)", valor: data.cobertura.critico ?? 0, emoji: "🔴" },
        { label: "Risco vs lead time", valor: data.cobertura.lead_time_risco ?? 0, emoji: "🟠" },
        { label: "Atenção (<14d)", valor: data.cobertura.atencao ?? 0, emoji: "🟡" },
        { label: "Sem giro 30d", valor: data.cobertura.sem_giro ?? 0, emoji: "⚫" },
      ]} />
      <Card titulo="Inventário" href="/wms/inventario" items={[
        { label: "Sessões ativas", valor: data.inventario.sessoesAtivas },
        { label: "Divergências pendentes", valor: data.inventario.divergenciasPend },
        { label: "Locks > 1h", valor: data.inventario.locksAntigos, emoji: data.inventario.locksAntigos > 0 ? "⚠️" : "" },
      ]} />
      <Card titulo="Reservas" items={[
        { label: "Expirando em 6h", valor: data.reservas.expiraEm6h },
        { label: "Lançamentos retroativos órfãos", valor: data.retroativosOrfaos, emoji: data.retroativosOrfaos > 0 ? "⚠️" : "" },
      ]} />
      <Card titulo="Empréstimos" href="/wms/emprestimos" items={[
        { label: "Pares com saldo devedor", valor: data.emprestimos.paresComSaldo },
      ]} />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/dashboard-geral.ts src/app/api/wms/dashboard-geral/ src/app/wms/dashboard/
git commit -m "feat(wms): dashboard geral de eventos críticos"
```

---

### Task 10: Atualiza shell e home

**Files:**
- Modify: `src/components/wms/wms-shell.tsx`
- Modify: `src/app/wms/page.tsx`

- [ ] **Step 1: Adicionar links pra novos módulos**

Adicionar no `WmsShell` links pra: `/wms/dashboard` (com badge "geral"), `/wms/cobertura`, `/wms/devolucoes`, `/wms/troca-sku`. Reorganizar nav em grupos: "Operação" / "Inventário" / "Cadastros" / "Visibilidade".

Adicionar cards em `/wms/page.tsx` referenciando todas as telas dos 5 planos.

- [ ] **Step 2: Commit**

```bash
git add src/components/wms/wms-shell.tsx src/app/wms/page.tsx
git commit -m "feat(wms): shell e home consolidados com todos os módulos"
```

---

### Task 11: Documentação final + checklist Fase 0

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/api-reference-complete.md`
- Modify: `docs/superpowers/specs/2026-05-07-wms-design.md`

- [ ] **Step 1: Documentar tudo**

Adicionar todas tabelas e endpoints ainda faltantes. Atualizar status do spec pra "Fase 0 implementada — pendente Fase 1 (dual-write)".

- [ ] **Step 2: Checklist Fase 0**

Adicionar arquivo `docs/superpowers/plans/wms-fase0-checklist.md` com:

```markdown
# Checklist Fase 0 — WMS

## Schema
- [ ] siso_produtos, siso_produto_empresas, siso_localizacoes, siso_estoque, siso_movimentacoes
- [ ] siso_fornecedores, siso_produto_fornecedores
- [ ] siso_emprestimo_regras, siso_localizacao_locks
- [ ] siso_inventario_sessoes/areas/localizacoes/contagens/divergencias
- [ ] siso_devolucoes_pendentes
- [ ] siso_cobertura_estoque (matview)

## APIs (`/api/wms/*`)
- [ ] produtos, localizacoes, estoque, ledger
- [ ] receber, transferir-galpao, replenishment, ajuste, lancamento-retroativo
- [ ] fornecedores, produto-fornecedores, emprestimo-regras, emprestimos/saldos
- [ ] rotear, reservas/cleanup
- [ ] inventario (CRUD + iniciar/aprovar/aplicar + contagens + bloquear + divergencias + cleanup)
- [ ] devolucoes (fila + classificar)
- [ ] troca-sku
- [ ] cobertura, dashboard-geral

## Telas (`/wms/*`)
- [ ] home, produtos, localizacoes, estoque, ledger
- [ ] receber, transferir, replenishment, ajuste, retroativos
- [ ] fornecedores, emprestimos
- [ ] inventario, inventario/[id], inventario/[id]/contar, inventario/[id]/divergencias, inventario/metricas
- [ ] devolucoes, devolucoes/[id], troca-sku
- [ ] cobertura, dashboard

## Crons
- [ ] reservas/cleanup (1h)
- [ ] reconciliacao (1h)
- [ ] cobertura/refresh (diário 03h)
- [ ] inventario/cleanup (10min locks, 4h sessões)

## Validação
- [ ] Snapshot inicial Tiny dry-run sem erro
- [ ] Snapshot real aplicado
- [ ] 1 cycle count completo end-to-end
- [ ] 1 inventário completo multi-operador end-to-end
- [ ] 1 devolução classificada
- [ ] 1 troca SKU registrada
- [ ] Reconciliação contínua sem divergências
- [ ] Dashboard geral mostra dados consistentes

## Sai pra Fase 1 quando
- [ ] Todos os checks acima ✅
- [ ] Time treinado nas novas telas
- [ ] Estoque saneado via inventário físico (Plano 4)
```

- [ ] **Step 3: Commit final**

```bash
git add CLAUDE.md docs/api-reference-complete.md docs/superpowers/specs/2026-05-07-wms-design.md docs/superpowers/plans/wms-fase0-checklist.md
git commit -m "docs(wms): finaliza documentação da Fase 0 + checklist de saída"
```

---

## Critério de saída do Plano 5

✅ Devoluções entram em fila quando webhook NF chega.
✅ Operador consegue classificar (íntegro/avariado/garantia/troca SKU) com fluxo correto pra cada caso.
✅ Troca SKU gera 4 movs auditáveis com mesma `origem_id`.
✅ Validação Cross alerta (não bloqueia em v1) se SKU substituto não está registrado como equivalente.
✅ Dashboard de cobertura mostra status correto (critico < 7d, atenção < 14d, lead_time_risco < lead, sem_giro = 0 saídas, ok).
✅ Dashboard geral agrega todos os indicadores em uma tela com refresh 30s.
✅ Materialized view de cobertura tem refresh diário via cron.
✅ Documentação atualizada e checklist Fase 0 publicado.

**Após este plano:** Fase 0 do WMS está completa. Próximo passo: **Plano 6 (não incluído neste pacote)** será Fase 1 (dual-write) → Fase 2 (shadow comparison) → Fase 3 (switch parcial) → Fase 4 (switch completo). Esses planos virão depois que Fase 0 estiver validada em produção.
