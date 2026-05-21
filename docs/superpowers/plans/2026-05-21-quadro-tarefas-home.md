# Quadro de Tarefas Pendentes na home `/wms` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um quadro de 6 cards no topo da home `/wms` mostrando, ao vivo, quantas tarefas estão pendentes em cada fila operacional do galpão ativo, e quem está executando o quê.

**Architecture:** Service puro `montarDashboardTarefas` agrega 6 contadores via `Promise.all` na Supabase + hidrata avatares dos executores via uma query única em `siso_usuarios`. Endpoint REST único alimenta o componente `<QuadroTarefas>` na home. Hook `useDashboardTarefasRealtime` subscreve às tabelas relevantes e invalida o React Query a cada evento.

**Tech Stack:** Next.js 16 App Router, TypeScript estrito, Supabase (queries + Realtime), React Query, Tailwind, Vitest pros testes puros.

**Spec:** `docs/superpowers/specs/2026-05-21-quadro-tarefas-home-design.md`

---

## File Structure

**Criados:**

- `src/lib/wms/dashboard-tarefas.ts` — tipos, helpers puros (`dedupNonNullIds`, `hidratarExecutores`) e service `montarDashboardTarefas(sb, galpao_id | null)`.
- `src/lib/wms/dashboard-tarefas.test.ts` — testes Vitest dos helpers puros.
- `src/app/api/wms/dashboard-tarefas/route.ts` — endpoint `GET` que valida sessão e delega ao service.
- `src/hooks/use-dashboard-tarefas-realtime.ts` — hook que cria 5 channels Supabase e invalida o React Query.
- `src/components/wms/home/card-tarefa.tsx` — card genérico com duas variantes (`simples`, `dupla`).
- `src/components/wms/home/quadro-tarefas.tsx` — wrapper com header + 2 linhas (Pipeline + Adjacentes).

**Modificados:**

- `src/app/wms/page.tsx` — insere `<QuadroTarefas />` antes dos `GROUPS` existentes.
- `src/app/wms/wms.css` — classes novas (`wms-quadro`, `wms-card-tarefa`, `wms-card-tarefa-empty`).
- `docs/api-reference-complete.md` — documentar `GET /api/wms/dashboard-tarefas`.
- `CLAUDE.md` — entrada em "Recently Added" pra registrar a feature.

**Por que esses arquivos:** o service é puro (sem React) → testes Vitest dos helpers, fácil reuso. Os componentes vivem em `src/components/wms/home/` (novo subdiretório) pra não poluir o root de `components/wms`. O hook fica em `src/hooks/` seguindo o padrão dos outros realtime hooks. O endpoint segue o mesmo padrão minimalista do `/api/wms/dashboard-geral/route.ts`.

---

## Task 1: Criar o arquivo de tipos + scaffold do service

**Files:**
- Create: `src/lib/wms/dashboard-tarefas.ts`

- [ ] **Step 1: Criar o arquivo com tipos e função stub**

```ts
// src/lib/wms/dashboard-tarefas.ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type Executor = {
  id: string;
  nome: string;
  foto_url: string | null;
};

export type DashboardTarefasResult = {
  galpao_id: string | null;
  aprovacao: { count: number };
  separacao: { count: number; executores: Executor[] };
  embalagem: { count: number; executores: Executor[] };
  guarda: { count: number; executores: Executor[] };
  compras: { aComprar: number; aReceber: number };
  inventario: { sessoesAtivas: number; executores: Executor[] };
};

/**
 * Monta o payload do quadro de tarefas pendentes da home /wms.
 *
 * Quando `galpao_id` é null, agrega de todos os galpões (modo "Todos").
 * Quando é um uuid, filtra por `separacao_galpao_id` (em pedidos),
 * `galpao_id` (em guarda/inventário). Compras é sempre global.
 */
export async function montarDashboardTarefas(
  _sb: SupabaseClient,
  galpao_id: string | null,
): Promise<DashboardTarefasResult> {
  return {
    galpao_id,
    aprovacao: { count: 0 },
    separacao: { count: 0, executores: [] },
    embalagem: { count: 0, executores: [] },
    guarda: { count: 0, executores: [] },
    compras: { aComprar: 0, aReceber: 0 },
    inventario: { sessoesAtivas: 0, executores: [] },
  };
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (sem erros).

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/dashboard-tarefas.ts
git commit -m "feat(wms/home): scaffold service dashboard-tarefas com tipos + stub"
```

---

## Task 2: Helper puro `dedupNonNullIds` (TDD)

**Files:**
- Modify: `src/lib/wms/dashboard-tarefas.ts` (adicionar função exportada)
- Create: `src/lib/wms/dashboard-tarefas.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

Create `src/lib/wms/dashboard-tarefas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { dedupNonNullIds } from "./dashboard-tarefas";

describe("dedupNonNullIds", () => {
  it("retorna [] quando entrada é vazia", () => {
    expect(dedupNonNullIds([])).toEqual([]);
  });

  it("remove nulls e undefined", () => {
    expect(dedupNonNullIds([null, "a", undefined, "b"])).toEqual(["a", "b"]);
  });

  it("dedupa mantendo ordem de primeira aparição", () => {
    expect(dedupNonNullIds(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("trata todos null/undefined como vazio", () => {
    expect(dedupNonNullIds([null, null, undefined])).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

Run: `npx vitest run src/lib/wms/dashboard-tarefas.test.ts`
Expected: FAIL com "dedupNonNullIds is not a function" (ou export missing).

- [ ] **Step 3: Implementar o helper**

Acrescentar em `src/lib/wms/dashboard-tarefas.ts` (no topo, antes de `montarDashboardTarefas`):

```ts
/**
 * Recebe lista possivelmente com nulls/undefined e duplicatas; retorna
 * apenas IDs únicos, em ordem de primeira aparição.
 */
export function dedupNonNullIds(
  ids: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
```

- [ ] **Step 4: Rodar pra confirmar que passa**

Run: `npx vitest run src/lib/wms/dashboard-tarefas.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/dashboard-tarefas.ts src/lib/wms/dashboard-tarefas.test.ts
git commit -m "feat(wms/home): helper dedupNonNullIds com testes"
```

---

## Task 3: Helper puro `hidratarExecutores` (TDD)

**Files:**
- Modify: `src/lib/wms/dashboard-tarefas.ts`
- Modify: `src/lib/wms/dashboard-tarefas.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

Acrescentar em `src/lib/wms/dashboard-tarefas.test.ts`:

```ts
import { hidratarExecutores } from "./dashboard-tarefas";

describe("hidratarExecutores", () => {
  const usuarios = new Map([
    ["u1", { id: "u1", nome: "Ana", foto_url: "https://x/a.jpg" }],
    ["u2", { id: "u2", nome: "Bruno", foto_url: null }],
    ["u3", { id: "u3", nome: "Carla", foto_url: null }],
  ]);

  it("retorna [] quando ids está vazio", () => {
    expect(hidratarExecutores([], usuarios)).toEqual([]);
  });

  it("preserva ordem dos ids fornecidos", () => {
    const out = hidratarExecutores(["u2", "u1"], usuarios);
    expect(out.map((e) => e.id)).toEqual(["u2", "u1"]);
  });

  it("ignora ids ausentes no map (usuário deletado ou desconhecido)", () => {
    const out = hidratarExecutores(["u1", "ghost", "u2"], usuarios);
    expect(out.map((e) => e.id)).toEqual(["u1", "u2"]);
  });

  it("propaga foto_url null sem mexer", () => {
    const out = hidratarExecutores(["u2"], usuarios);
    expect(out).toEqual([{ id: "u2", nome: "Bruno", foto_url: null }]);
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

Run: `npx vitest run src/lib/wms/dashboard-tarefas.test.ts`
Expected: FAIL com "hidratarExecutores is not exported".

- [ ] **Step 3: Implementar o helper**

Acrescentar em `src/lib/wms/dashboard-tarefas.ts` (logo após `dedupNonNullIds`):

```ts
/**
 * Hidrata uma lista de IDs com os dados do usuário, ignorando IDs que
 * não estão no map (usuário deletado ou inacessível). Preserva a ordem
 * de entrada.
 */
export function hidratarExecutores(
  ids: string[],
  usuarios: Map<string, Executor>,
): Executor[] {
  const out: Executor[] = [];
  for (const id of ids) {
    const u = usuarios.get(id);
    if (u) out.push(u);
  }
  return out;
}
```

- [ ] **Step 4: Rodar pra confirmar que passa**

Run: `npx vitest run src/lib/wms/dashboard-tarefas.test.ts`
Expected: PASS — 8 tests passed (4 do dedup + 4 do hidratar).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/dashboard-tarefas.ts src/lib/wms/dashboard-tarefas.test.ts
git commit -m "feat(wms/home): helper hidratarExecutores com testes"
```

---

## Task 4: Implementar `montarDashboardTarefas` com as 6 queries

**Files:**
- Modify: `src/lib/wms/dashboard-tarefas.ts`

> **Por que sem TDD aqui:** seguindo o padrão de `dashboard-geral.ts` (sem testes unitários — acoplado ao Supabase). Os helpers puros já foram cobertos. Verificação manual via curl no Task 6.

- [ ] **Step 1: Substituir o stub pela implementação real**

Trocar a função `montarDashboardTarefas` por:

```ts
export async function montarDashboardTarefas(
  sb: SupabaseClient,
  galpao_id: string | null,
): Promise<DashboardTarefasResult> {
  // 6 queries em paralelo. Cada uma retorna { count } e/ou ids de executores.
  const [
    aprovacaoQ,
    separacaoQ,
    embalagemQ,
    guardaQ,
    invSessoesQ,
    invOperadoresQ,
    comprasComprarQ,
    comprasReceberQ,
  ] = await Promise.all([
    // Aprovação pendente — pedidos esperando decisão humana
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id", { count: "exact", head: true })
        .eq("status", "pendente");
      if (galpao_id) q = q.eq("separacao_galpao_id", galpao_id);
      return q;
    })(),
    // Separação — todos status ativos no pipeline
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id, status_separacao, separacao_operador_id")
        .in("status_separacao", [
          "aguardando_separacao",
          "em_separacao",
          "pendente_realocacao",
          "validacao_oc",
        ]);
      if (galpao_id) q = q.eq("separacao_galpao_id", galpao_id);
      return q;
    })(),
    // Embalagem — status_separacao = 'separado'
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id, embalagem_operador_id")
        .eq("status_separacao", "separado");
      if (galpao_id) q = q.eq("separacao_galpao_id", galpao_id);
      return q;
    })(),
    // Guarda — pendências em pendente ou em_guarda
    (() => {
      let q = sb
        .from("siso_wms_pendencias_guarda")
        .select("id, status, iniciada_por")
        .in("status", ["pendente", "em_guarda"]);
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),
    // Inventário — sessões em andamento
    (() => {
      let q = sb
        .from("siso_inventario_sessoes")
        .select("id")
        .eq("status", "em_andamento");
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),
    // Inventário — operadores ativos (party). Filtrar por sessões do galpão.
    (() => {
      let q = sb
        .from("siso_inventario_operadores")
        .select(
          "usuario_id, sessao:siso_inventario_sessoes!inner(id, galpao_id, status)",
        )
        .is("finalizado_em", null)
        .eq("sessao.status", "em_andamento");
      if (galpao_id) q = q.eq("sessao.galpao_id", galpao_id);
      return q;
    })(),
    // Compras — itens a comprar (cross-galpão, sem filtro)
    sb
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .eq("compra_status", "aguardando_compra"),
    // Compras — OCs abertas pra recebimento (cross-galpão)
    sb
      .from("siso_ordens_compra")
      .select("id", { count: "exact", head: true })
      .eq("status", "aguardando_recebimento"),
  ]);

  // Tipagem das linhas retornadas
  type SepRow = {
    id: string;
    status_separacao: string;
    separacao_operador_id: string | null;
  };
  type EmbRow = { id: string; embalagem_operador_id: string | null };
  type GuardaRow = {
    id: string;
    status: string;
    iniciada_por: string | null;
  };
  type InvOpRow = { usuario_id: string };

  const sepRows = (separacaoQ.data ?? []) as SepRow[];
  const embRows = (embalagemQ.data ?? []) as EmbRow[];
  const guardaRows = (guardaQ.data ?? []) as GuardaRow[];
  const invOpRows = (invOperadoresQ.data ?? []) as InvOpRow[];

  // Coleta IDs de executores ativos por fila
  const sepIds = dedupNonNullIds(
    sepRows
      .filter((r) => r.status_separacao === "em_separacao")
      .map((r) => r.separacao_operador_id),
  );
  const embIds = dedupNonNullIds(embRows.map((r) => r.embalagem_operador_id));
  const guardaIds = dedupNonNullIds(
    guardaRows
      .filter((r) => r.status === "em_guarda")
      .map((r) => r.iniciada_por),
  );
  const invIds = dedupNonNullIds(invOpRows.map((r) => r.usuario_id));

  // Hidrata avatares em uma única query
  const allIds = dedupNonNullIds([
    ...sepIds,
    ...embIds,
    ...guardaIds,
    ...invIds,
  ]);
  const usuariosMap = new Map<string, Executor>();
  if (allIds.length > 0) {
    const { data: usuarios } = await sb
      .from("siso_usuarios")
      .select("id, nome, foto_url")
      .in("id", allIds);
    for (const u of (usuarios ?? []) as Executor[]) {
      usuariosMap.set(u.id, u);
    }
  }

  return {
    galpao_id,
    aprovacao: { count: aprovacaoQ.count ?? 0 },
    separacao: {
      count: sepRows.length,
      executores: hidratarExecutores(sepIds, usuariosMap),
    },
    embalagem: {
      count: embRows.length,
      executores: hidratarExecutores(embIds, usuariosMap),
    },
    guarda: {
      count: guardaRows.length,
      executores: hidratarExecutores(guardaIds, usuariosMap),
    },
    compras: {
      aComprar: comprasComprarQ.count ?? 0,
      aReceber: comprasReceberQ.count ?? 0,
    },
    inventario: {
      sessoesAtivas: (invSessoesQ.data ?? []).length,
      executores: hidratarExecutores(invIds, usuariosMap),
    },
  };
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Verificar que os testes dos helpers ainda passam**

Run: `npx vitest run src/lib/wms/dashboard-tarefas.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/dashboard-tarefas.ts
git commit -m "feat(wms/home): montarDashboardTarefas com 6 queries paralelas"
```

---

## Task 5: Endpoint REST `GET /api/wms/dashboard-tarefas`

**Files:**
- Create: `src/app/api/wms/dashboard-tarefas/route.ts`

- [ ] **Step 1: Criar o endpoint**

```ts
// src/app/api/wms/dashboard-tarefas/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { montarDashboardTarefas } from "@/lib/wms/dashboard-tarefas";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const galpao_id = req.nextUrl.searchParams.get("galpao_id");
  const sb = createServiceClient();
  const result = await montarDashboardTarefas(sb, galpao_id || null);
  return NextResponse.json(result);
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/dashboard-tarefas/route.ts
git commit -m "feat(wms/home): endpoint GET /api/wms/dashboard-tarefas"
```

---

## Task 6: Smoke test do endpoint via curl

**Files:** nenhum (verificação manual)

- [ ] **Step 1: Subir o dev server**

Run: `npm run dev` (em outro terminal ou em background).
Aguarde aparecer `Ready in …ms`.

- [ ] **Step 2: Pegar uma session id válida**

```bash
# Faz login com o usuário seed (Eryk / 1234) e captura o session id da resposta
SESSION=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"nome":"Eryk","pin":"1234"}' | jq -r .session_id)
echo "session=$SESSION"
```

- [ ] **Step 3: Chamar sem filtro de galpão (modo "Todos")**

```bash
curl -s "http://localhost:3000/api/wms/dashboard-tarefas" \
  -H "X-Session-Id: $SESSION" | jq
```

Expected: JSON com a shape `DashboardTarefasResult`. `galpao_id` deve ser `null`. Todos os contadores são números ≥ 0. Os arrays `executores` podem estar vazios ou conter `{id, nome, foto_url}`.

- [ ] **Step 4: Chamar com filtro de galpão**

Pegue um galpão real:

```bash
GALPAO=$(curl -s "http://localhost:3000/api/wms/admin/galpoes" \
  -H "X-Session-Id: $SESSION" | jq -r '.galpoes[0].id')
curl -s "http://localhost:3000/api/wms/dashboard-tarefas?galpao_id=$GALPAO" \
  -H "X-Session-Id: $SESSION" | jq
```

Expected: `galpao_id` ecoa o uuid passado. Contadores podem ser menores que na chamada sem filtro.

- [ ] **Step 5: Verificar não-autenticado**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:3000/api/wms/dashboard-tarefas"
```

Expected: `401`.

- [ ] **Step 6: Parar o dev server e seguir**

Sem commit nesse task (foi só verificação).

---

## Task 7: Hook `useDashboardTarefasRealtime`

**Files:**
- Create: `src/hooks/use-dashboard-tarefas-realtime.ts`

- [ ] **Step 1: Criar o hook**

```ts
// src/hooks/use-dashboard-tarefas-realtime.ts
"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Subscreve às tabelas que afetam o quadro de tarefas da home /wms e
 * invalida o React Query a cada evento, forçando refetch.
 *
 * Quando `galpaoId` é null, subscreve sem filtros server-side (modo
 * "todos os galpões"). Quando muda, fecha os channels antigos e
 * reabre com novos filtros.
 */
export function useDashboardTarefasRealtime(galpaoId: string | null) {
  const queryClient = useQueryClient();
  const channelsRef = useRef<RealtimeChannel[]>([]);

  useEffect(() => {
    const invalidate = () => {
      queryClient.invalidateQueries({
        queryKey: ["wms-tarefas-pendentes", galpaoId],
      });
    };

    const suffix = galpaoId ?? "all";

    const ch1 = supabase
      .channel(`dt-pedidos-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_pedidos",
        },
        invalidate,
      )
      .subscribe();

    const ch2 = supabase
      .channel(`dt-guarda-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_wms_pendencias_guarda",
        },
        invalidate,
      )
      .subscribe();

    const ch3 = supabase
      .channel(`dt-inv-sess-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_inventario_sessoes",
        },
        invalidate,
      )
      .subscribe();

    const ch4 = supabase
      .channel(`dt-inv-op-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_inventario_operadores",
        },
        invalidate,
      )
      .subscribe();

    const ch5 = supabase
      .channel(`dt-pedido-itens-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_pedido_itens",
        },
        invalidate,
      )
      .subscribe();

    channelsRef.current = [ch1, ch2, ch3, ch4, ch5];

    return () => {
      for (const ch of channelsRef.current) {
        supabase.removeChannel(ch);
      }
      channelsRef.current = [];
    };
  }, [galpaoId, queryClient]);
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-dashboard-tarefas-realtime.ts
git commit -m "feat(wms/home): hook useDashboardTarefasRealtime"
```

---

## Task 8: Component `<CardTarefa>` (variantes simples + dupla)

**Files:**
- Create: `src/components/wms/home/card-tarefa.tsx`

- [ ] **Step 1: Criar o componente**

```tsx
// src/components/wms/home/card-tarefa.tsx
"use client";

import Link from "next/link";
import { Avatar } from "@/components/wms/ui/avatar";
import type { Executor } from "@/lib/wms/dashboard-tarefas";

const MAX_AVATARES_VISIVEIS = 5;

type Variante =
  | {
      variante: "simples";
      titulo: string;
      contador: number;
      legenda?: string;
      executores?: Executor[];
    }
  | {
      variante: "dupla";
      titulo: string;
      contadores: [number, number];
      legendas: [string, string];
    };

export type CardTarefaProps = Variante & {
  href: string;
};

export function CardTarefa(props: CardTarefaProps) {
  const totalContador =
    props.variante === "simples"
      ? props.contador
      : props.contadores[0] + props.contadores[1];
  const empty = totalContador === 0;

  return (
    <Link
      href={props.href}
      className={`wms-card-tarefa ${empty ? "wms-card-tarefa-empty" : ""}`}
    >
      <div className="wms-card-tarefa-titulo">{props.titulo}</div>

      {props.variante === "simples" ? (
        <>
          <div className="wms-card-tarefa-contador">{props.contador}</div>
          {props.legenda ? (
            <div className="wms-card-tarefa-legenda">{props.legenda}</div>
          ) : null}
        </>
      ) : (
        <div className="wms-card-tarefa-dupla">
          <div>
            <div className="wms-card-tarefa-contador">
              {props.contadores[0]}
            </div>
            <div className="wms-card-tarefa-legenda">{props.legendas[0]}</div>
          </div>
          <div className="wms-card-tarefa-sep">/</div>
          <div>
            <div className="wms-card-tarefa-contador">
              {props.contadores[1]}
            </div>
            <div className="wms-card-tarefa-legenda">{props.legendas[1]}</div>
          </div>
        </div>
      )}

      {props.variante === "simples" && props.executores && props.executores.length > 0 ? (
        <div className="wms-card-tarefa-avatares">
          {props.executores
            .slice(0, MAX_AVATARES_VISIVEIS)
            .map((e) => (
              <Avatar
                key={e.id}
                size="sm"
                nome={e.nome}
                fotoUrl={e.foto_url}
              />
            ))}
          {props.executores.length > MAX_AVATARES_VISIVEIS ? (
            <div className="wms-card-tarefa-overflow">
              +{props.executores.length - MAX_AVATARES_VISIVEIS}
            </div>
          ) : null}
        </div>
      ) : null}

      {empty ? (
        <div className="wms-card-tarefa-empty-label">Tudo em dia</div>
      ) : null}
    </Link>
  );
}
```

- [ ] **Step 2: Conferir o contrato de `<Avatar>`**

Run: `grep -n "export" src/components/wms/ui/avatar.tsx | head -5`
Expected: confirma `nome`, `fotoUrl`, `size` como props. Se o nome da prop divergir (ex.: `nome` vs `name`), ajustar o uso no componente acima.

- [ ] **Step 3: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/wms/home/card-tarefa.tsx
git commit -m "feat(wms/home): componente CardTarefa (simples + dupla)"
```

---

## Task 9: Component `<QuadroTarefas>` (wrapper com 2 linhas)

**Files:**
- Create: `src/components/wms/home/quadro-tarefas.tsx`

- [ ] **Step 1: Criar o componente**

```tsx
// src/components/wms/home/quadro-tarefas.tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import type { DashboardTarefasResult } from "@/lib/wms/dashboard-tarefas";
import { useDashboardTarefasRealtime } from "@/hooks/use-dashboard-tarefas-realtime";
import { CardTarefa } from "./card-tarefa";

export function QuadroTarefas() {
  const { user, activeGalpaoId } = useAuth();
  const galpaoNome =
    (user?.galpoes ?? []).find((g) => g.id === activeGalpaoId)?.nome ??
    "Todos os galpões";

  const query = useQuery<DashboardTarefasResult>({
    queryKey: ["wms-tarefas-pendentes", activeGalpaoId],
    queryFn: () =>
      wmsApi<DashboardTarefasResult>(
        activeGalpaoId
          ? `/api/wms/dashboard-tarefas?galpao_id=${activeGalpaoId}`
          : `/api/wms/dashboard-tarefas`,
      ),
  });

  useDashboardTarefasRealtime(activeGalpaoId ?? null);

  const data = query.data;

  return (
    <section className="wms-quadro">
      <div className="wms-quadro-head">
        <h2 className="wms-quadro-title">Tarefas pendentes</h2>
        <div className="wms-quadro-meta">
          <span>galpão: {galpaoNome}</span>
          <span className="wms-quadro-live">● ao vivo</span>
        </div>
      </div>

      {query.isError ? (
        <div className="wms-quadro-error">
          Não foi possível carregar o quadro.{" "}
          <button onClick={() => query.refetch()}>Tentar novamente</button>
        </div>
      ) : null}

      <div className="wms-quadro-sub">Pipeline do pedido</div>
      <div className="wms-quadro-row">
        <CardTarefa
          variante="simples"
          titulo="Aprovação"
          contador={data?.aprovacao.count ?? 0}
          legenda="aguardando"
          href="/wms/pedidos"
        />
        <CardTarefa
          variante="simples"
          titulo="Separação"
          contador={data?.separacao.count ?? 0}
          executores={data?.separacao.executores}
          href="/wms/separacao"
        />
        <CardTarefa
          variante="simples"
          titulo="Embalagem"
          contador={data?.embalagem.count ?? 0}
          executores={data?.embalagem.executores}
          href="/wms/separacao"
        />
      </div>

      <div className="wms-quadro-sub">Tarefas adjacentes</div>
      <div className="wms-quadro-row">
        <CardTarefa
          variante="simples"
          titulo="Guarda"
          contador={data?.guarda.count ?? 0}
          executores={data?.guarda.executores}
          href="/wms/guarda"
        />
        <CardTarefa
          variante="dupla"
          titulo="Compras"
          contadores={[
            data?.compras.aComprar ?? 0,
            data?.compras.aReceber ?? 0,
          ]}
          legendas={["a comprar", "a receber"]}
          href="/wms/compras"
        />
        <CardTarefa
          variante="simples"
          titulo="Inventário"
          contador={data?.inventario.sessoesAtivas ?? 0}
          legenda="sessões ativas"
          executores={data?.inventario.executores}
          href="/wms/inventario"
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Confirmar a forma de `useAuth().user.galpoes`**

Run: `grep -n "galpoes\|activeGalpaoId" src/lib/auth-context.tsx | head -10`
Expected: confirma que `user.galpoes` é `Array<{id, nome}>`. Se não for, ajustar a lookup acima.

- [ ] **Step 3: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/wms/home/quadro-tarefas.tsx
git commit -m "feat(wms/home): componente QuadroTarefas com 6 cards"
```

---

## Task 10: Classes CSS do quadro e dos cards

**Files:**
- Modify: `src/app/wms/wms.css`

- [ ] **Step 1: Conferir o que já existe pra reaproveitar tokens**

Run: `grep -n "wms-home-card\|wms-sec-h\|wms-card" src/app/wms/wms.css | head -20`
Expected: lista padrões existentes. As classes `wms-card-tarefa-*` reusam tokens visuais (paddings, radius, bordas) compatíveis com `wms-home-card`.

- [ ] **Step 2: Acrescentar classes no fim de `src/app/wms/wms.css`**

```css
/* ─── Quadro de tarefas pendentes (home) ──────────────────────────── */

.wms-quadro {
  margin-bottom: 32px;
}

.wms-quadro-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 16px;
}

.wms-quadro-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--ink);
}

.wms-quadro-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--ink-muted);
}

.wms-quadro-live {
  color: var(--success, #16a34a);
}

.wms-quadro-sub {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-muted);
  margin: 16px 0 8px;
}

.wms-quadro-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

@media (max-width: 720px) {
  .wms-quadro-row {
    grid-template-columns: 1fr;
  }
}

.wms-card-tarefa {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--paper);
  text-decoration: none;
  color: inherit;
  min-height: 120px;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    opacity 120ms ease;
}

.wms-card-tarefa:hover {
  background: var(--surface);
}

.wms-card-tarefa-empty {
  opacity: 0.5;
}

.wms-card-tarefa-titulo {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.wms-card-tarefa-contador {
  font-size: 30px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--ink);
}

.wms-card-tarefa-legenda {
  font-size: 11px;
  color: var(--ink-muted);
}

.wms-card-tarefa-dupla {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

.wms-card-tarefa-sep {
  font-size: 22px;
  color: var(--ink-muted);
  align-self: center;
}

.wms-card-tarefa-avatares {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
}

.wms-card-tarefa-overflow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  min-width: 28px;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink-muted);
}

.wms-card-tarefa-empty-label {
  font-size: 11px;
  color: var(--ink-muted);
  font-style: italic;
}

.wms-quadro-error {
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid var(--danger, #b91c1c);
  background: color-mix(in srgb, var(--danger, #b91c1c) 8%, transparent);
  margin-bottom: 12px;
}

.wms-quadro-error button {
  margin-left: 8px;
  text-decoration: underline;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/wms.css
git commit -m "style(wms/home): classes do quadro de tarefas e cards"
```

---

## Task 11: Inserir `<QuadroTarefas>` na home `/wms`

**Files:**
- Modify: `src/app/wms/page.tsx`

- [ ] **Step 1: Acrescentar o import e renderizar antes dos GROUPS**

Editar `src/app/wms/page.tsx`:

```tsx
// no topo (após os outros imports do mesmo bloco):
import { QuadroTarefas } from "@/components/wms/home/quadro-tarefas";
```

E dentro do JSX retornado, entre o `<PageHeader>` e o `{GROUPS.map(...)}`, adicionar:

```tsx
<QuadroTarefas />
```

A estrutura final do `return` deve ficar:

```tsx
return (
  <>
    <PageHeader …>…</PageHeader>

    <QuadroTarefas />

    {GROUPS.map((g) => (
      <section key={g.titulo} style={{ marginBottom: 24 }}>
        …
      </section>
    ))}
  </>
);
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/page.tsx
git commit -m "feat(wms/home): insere QuadroTarefas no topo da home"
```

---

## Task 12: Verificação manual no navegador

**Files:** nenhum (verificação manual)

- [ ] **Step 1: Subir o dev server**

Run: `npm run dev`

- [ ] **Step 2: Abrir `/wms` no navegador**

Esperado:
- O quadro aparece no topo, antes dos grupos de navegação.
- Header mostra "Tarefas pendentes" + "galpão: {nome}" + "● ao vivo".
- Linha 1 (Pipeline): Aprovação, Separação, Embalagem.
- Linha 2 (Adjacentes): Guarda, Compras, Inventário.
- Cards com zero pendentes aparecem esmaecidos com "Tudo em dia".
- Cards com pendências mostram o número grande.
- Cards de Separação/Embalagem/Guarda/Inventário com executores ativos mostram avatares circulares.
- Card de Compras mostra `N / M` com legenda "a comprar / a receber".

- [ ] **Step 3: Testar troca de galpão**

Pelo `SidebarGalpaoSwitcher` (canto superior da sidebar) troque o galpão. O quadro deve atualizar (cards podem mudar de contador) sem refresh manual.

- [ ] **Step 4: Testar realtime**

Em outra aba, abra um pedido e mude algum status (ex.: aprovar, iniciar separação, ou criar uma pendência de guarda).
- Volte pra `/wms` e confirme que o contador do card relevante mudou em menos de 5 segundos sem F5.

- [ ] **Step 5: Testar mobile**

Diminua a viewport pra <720px. Esperado: cards empilham 1 por linha; layout segue legível.

- [ ] **Step 6: Parar o dev server**

Sem commit nesse task.

---

## Task 13: Documentar o endpoint em `docs/api-reference-complete.md`

**Files:**
- Modify: `docs/api-reference-complete.md`

- [ ] **Step 1: Encontrar a seção certa**

Run: `grep -n "dashboard-geral\|GET /api/wms/dashboard" docs/api-reference-complete.md | head -5`
Expected: localiza a entrada do `dashboard-geral`. Vamos adicionar logo abaixo.

- [ ] **Step 2: Acrescentar a entrada nova**

Inserir logo após a entrada de `GET /api/wms/dashboard-geral`:

````markdown
### `GET /api/wms/dashboard-tarefas`

Retorna o estado das 6 filas operacionais que o quadro de tarefas pendentes da home `/wms` exibe.

**Auth:** sessão válida (`X-Session-Id`).

**Query string:**

| Param | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `galpao_id` | uuid | não | Quando ausente, agrega todos os galpões. Quando presente, filtra pedidos (`separacao_galpao_id`), guarda (`galpao_id`) e inventário (`galpao_id`). Compras é cross-galpão sempre. |

**Resposta 200:**

```json
{
  "galpao_id": "uuid-or-null",
  "aprovacao":  { "count": 0 },
  "separacao":  { "count": 0, "executores": [{ "id": "uuid", "nome": "…", "foto_url": "…|null" }] },
  "embalagem":  { "count": 0, "executores": [] },
  "guarda":     { "count": 0, "executores": [] },
  "compras":    { "aComprar": 0, "aReceber": 0 },
  "inventario": { "sessoesAtivas": 0, "executores": [] }
}
```

**Side effects:** nenhum (read-only).

**Notas:**
- `executores` em Separação = `separacao_operador_id` de pedidos em `em_separacao`.
- `executores` em Embalagem = `embalagem_operador_id` quando setado.
- `executores` em Guarda = `iniciada_por` de pendências em `em_guarda`.
- `executores` em Inventário = `siso_inventario_operadores` ativos (party) das sessões em andamento.
- Aprovação e Compras não têm executor (são filas de espera).
````

- [ ] **Step 3: Commit**

```bash
git add docs/api-reference-complete.md
git commit -m "docs(api): documenta GET /api/wms/dashboard-tarefas"
```

---

## Task 14: Atualizar `CLAUDE.md` — Recently Added

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Encontrar a seção "Recently Added" ou equivalente**

Run: `grep -n "Recently Added\|Recently Removed\|In Progress" CLAUDE.md | head -5`
Expected: identifica onde adicionar.

- [ ] **Step 2: Acrescentar a entrada**

Inserir uma bullet nova na seção "In Progress / Minor" (ou criar uma "Recently Added" se for o lugar usado pelo projeto), por exemplo:

```markdown
- **Quadro de Tarefas Pendentes na home `/wms` — implementado em 2026-05-21.** Bloco no topo da home com 6 cards (Aprovação · Separação · Embalagem · Guarda · Compras · Inventário) com contadores ao vivo + avatares de quem está executando. Respeita o `activeGalpaoId` do `useAuth()`; quando null, agrega todos os galpões. Realtime via Supabase em 5 tabelas (`siso_pedidos`, `siso_wms_pendencias_guarda`, `siso_inventario_sessoes`, `siso_inventario_operadores`, `siso_pedido_itens`). Endpoint: `GET /api/wms/dashboard-tarefas?galpao_id?`. Spec: `docs/superpowers/specs/2026-05-21-quadro-tarefas-home-design.md`. Plano: `docs/superpowers/plans/2026-05-21-quadro-tarefas-home.md`.
```

E acrescentar a rota correspondente na lista de rotas WMS (procurar a seção `# ── WMS exceções + dashboards + insights ──` em CLAUDE.md):

```
        dashboard-tarefas/route.ts         # GET — 6 cards da home /wms (contadores + executores)
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): registra quadro de tarefas pendentes na home"
```

---

## Task 15: Review final e check de fechamento

**Files:** nenhum (verificação)

- [ ] **Step 1: Rodar todos os checks**

```bash
npx tsc --noEmit
npx vitest run src/lib/wms/dashboard-tarefas.test.ts
npm run lint
```

Expected: tudo PASS.

- [ ] **Step 2: Verificar a árvore de commits**

Run: `git log --oneline -20`
Expected: ~13 commits novos no tópico, mensagens consistentes (`feat(wms/home)`, `style(wms/home)`, `docs(...)`).

- [ ] **Step 3: Checar diff total**

Run: `git diff --stat origin/develop...HEAD`
Expected: arquivos esperados (6 criados + 4 modificados), sem surpresas. Nenhuma migration. Nenhum arquivo fora do escopo.

- [ ] **Step 4: Verificar a documentação `erros-conhecidos.yaml`**

Não houve erros pra registrar — feature nova, sem bug resolvido. Skip.

---

## Notas pro implementador

- **Sem migrations.** Todas as colunas usadas (`siso_pedidos.status`, `status_separacao`, `separacao_galpao_id`, `separacao_operador_id`, `embalagem_operador_id`, `siso_wms_pendencias_guarda.status`, `iniciada_por`, `galpao_id`, `siso_inventario_sessoes.status`, `galpao_id`, `siso_inventario_operadores.usuario_id`, `finalizado_em`, `siso_pedido_itens.compra_status`, `siso_ordens_compra.status`, `siso_usuarios.id`, `nome`, `foto_url`) já existem.
- **Sem alteração no schema realtime.** As 5 tabelas subscritas já estão na publication `supabase_realtime` (mencionado no CLAUDE.md como "Realtime é cross-module").
- **YAGNI guardado:** sem idade de fila, sem badges de urgência, sem expedição/devoluções/retroativos no quadro. Esses ficam pra um plano futuro se houver demanda.
- **Componentes em `src/components/wms/home/`:** subdiretório novo. Se o repositório tiver convenção diferente, mover pra `src/components/wms/` direto e ajustar imports. Inspecionar o padrão antes do Task 8.
- **Status da OC pra recebimento:** o plano assume `siso_ordens_compra.status='aguardando_recebimento'`. Se o valor real for outro (ex.: `'aberta'`), ajustar a query do Task 4 pra refletir. Confirmar com `grep "status.*ordem\|status.*aguardando" supabase/migrations/*.sql` no início do Task 4 caso haja dúvida.
- **`embalagem_operador_id`** pode estar nullable mesmo durante embalagem em andamento (operador só é setado em `confirmar-item-embalagem`). É esperado — o card mostra avatares só de quem chegou a confirmar pelo menos um item.
