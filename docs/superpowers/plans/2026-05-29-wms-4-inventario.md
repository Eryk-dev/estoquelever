# WMS 4 — Inventário robusto multi-operador Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementa o módulo robusto de inventário do WMS — cycle count rotativo + inventário completo com múltiplos operadores em paralelo, blind/duplo blind, re-contagem, workflow de aprovação por tolerância e atualização realtime via Supabase. Operadores em handhelds/tablets contam simultaneamente em diferentes áreas; admin vê progresso global e divergências em tempo real. Ao aprovar, sistema gera movs de inventário no ledger.

**Architecture:** Sessão master orquestra áreas → localizações → contagens. Lock por localização (`siso_localizacao_locks`) isola contagem do roteamento (Plano 3). Realtime via Supabase channel `inventario:{sessao_id}`. Anti-colisão entre operadores via UPDATE atômico em `bloqueada_por IS NULL`. Cron de cleanup pra sessões e bloqueios órfãos.

**Tech Stack:** mesmo dos planos anteriores. Supabase Realtime (já usado em separação atual).

**Spec de referência:** [docs/superpowers/specs/2026-05-07-wms-design.md](../specs/2026-05-07-wms-design.md) — §3.10-3.14, 5.7, princípios 12-13.

**Pré-requisitos:** Planos 1-3 concluídos **em staging** (Plano 3 já cria `siso_localizacao_locks`). Migrations e código deste plano operam **somente em staging**; produção não é tocada. Realtime via Supabase Realtime funciona normal em staging (cada branch tem sua própria publication).

---

## File Structure

| Caminho | Responsabilidade |
|---|---|
| `supabase/migrations/20260529_wms_inventario.sql` | Tabelas: sessões, áreas, localizações da sessão, contagens, divergências |
| `src/lib/wms/inventario.ts` | Helpers: criar sessão, iniciar, registrar contagem, computar divergências, aplicar |
| `src/lib/wms/inventario.test.ts` | Tests |
| `src/lib/wms/inventario-recovery.ts` | Cron de cleanup de sessões/bloqueios órfãos |
| `src/app/api/wms/inventario/route.ts` | GET (lista), POST (criar) |
| `src/app/api/wms/inventario/[id]/route.ts` | GET, PATCH (status), DELETE (cancelar) |
| `src/app/api/wms/inventario/[id]/iniciar/route.ts` | POST — cria locks |
| `src/app/api/wms/inventario/[id]/aprovar/route.ts` | POST — aplica divergências |
| `src/app/api/wms/inventario/[id]/aplicar/route.ts` | POST — gera movs |
| `src/app/api/wms/inventario/[id]/areas/route.ts` | GET, POST |
| `src/app/api/wms/inventario/[id]/localizacoes/[locId]/bloquear/route.ts` | POST — anti-colisão |
| `src/app/api/wms/inventario/[id]/contagens/route.ts` | POST — registra contagem |
| `src/app/api/wms/inventario/[id]/divergencias/route.ts` | GET, PATCH (aprovar/rejeitar/recontar) |
| `src/app/api/wms/inventario/cleanup/route.ts` | GET — cron de recovery |
| `src/app/wms/inventario/page.tsx` | Lista + criar sessão |
| `src/app/wms/inventario/[id]/page.tsx` | Painel realtime do supervisor |
| `src/app/wms/inventario/[id]/contar/page.tsx` | Tela do operador (handheld) |
| `src/app/wms/inventario/[id]/divergencias/page.tsx` | Dashboard de divergências |
| `src/app/wms/inventario/metricas/page.tsx` | Métricas de acuracidade |
| `src/components/wms/scan-contagem.tsx` | Input de bipe pra contagem |
| `src/hooks/use-inventario-realtime.ts` | Hook Supabase Realtime |

---

### Task 1: Migration — schema de inventário

**Files:**
- Create: `supabase/migrations/20260529_wms_inventario.sql`

- [ ] **Step 1: Migration**

```sql
BEGIN;

-- 1. Sessões
CREATE TABLE siso_inventario_sessoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('cycle_count','completo')),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  empresa_dona_id uuid REFERENCES siso_empresas(id),
  -- Defaults definidos pelo user na revisão pré-implementação:
  -- modo blind (anti-fraude), tolerância 2%, aprovação acima de R$ 1.000
  modo_contagem text NOT NULL DEFAULT 'blind' CHECK (modo_contagem IN ('aberto','blind','duplo_blind')),
  tolerancia_pct numeric NOT NULL DEFAULT 2.0 CHECK (tolerancia_pct >= 0),
  tolerancia_qty_min numeric NOT NULL DEFAULT 0 CHECK (tolerancia_qty_min >= 0),
  exige_aprovacao_acima_valor numeric DEFAULT 1000,
  status text NOT NULL DEFAULT 'planejada' CHECK (status IN (
    'planejada','em_andamento','revisao','aprovada','aplicada','cancelada'
  )),
  programada_para date,
  iniciada_em timestamptz,
  finalizada_em timestamptz,
  aplicada_em timestamptz,
  criada_por uuid NOT NULL REFERENCES siso_usuarios(id),
  aprovada_por uuid REFERENCES siso_usuarios(id),
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inv_sessoes_status ON siso_inventario_sessoes(status, galpao_id);
CREATE INDEX idx_inv_sessoes_galpao ON siso_inventario_sessoes(galpao_id, criado_em DESC);
CREATE INDEX idx_inv_sessoes_ativas ON siso_inventario_sessoes(galpao_id) WHERE status = 'em_andamento';

-- 2. Áreas
CREATE TABLE siso_inventario_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  nome text NOT NULL,
  operador_id uuid REFERENCES siso_usuarios(id),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','em_andamento','concluida')),
  iniciada_em timestamptz,
  finalizada_em timestamptz,
  UNIQUE(sessao_id, nome)
);

CREATE INDEX idx_inv_areas_sessao ON siso_inventario_areas(sessao_id, status);
CREATE INDEX idx_inv_areas_operador ON siso_inventario_areas(operador_id) WHERE status = 'em_andamento';

-- 3. Localizações da sessão
CREATE TABLE siso_inventario_localizacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  area_id uuid NOT NULL REFERENCES siso_inventario_areas(id) ON DELETE CASCADE,
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente','em_contagem','contada','divergente','recontagem','aprovada'
  )),
  bloqueada_por uuid REFERENCES siso_usuarios(id),
  bloqueada_em timestamptz,
  UNIQUE(sessao_id, localizacao_id)
);

CREATE INDEX idx_inv_loc_sessao ON siso_inventario_localizacoes(sessao_id, status);
CREATE INDEX idx_inv_loc_area ON siso_inventario_localizacoes(area_id, status);
CREATE INDEX idx_inv_loc_bloqueada
  ON siso_inventario_localizacoes(bloqueada_por, bloqueada_em)
  WHERE bloqueada_em IS NOT NULL;

-- 4. Contagens individuais
CREATE TABLE siso_inventario_contagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  qty_contada numeric NOT NULL CHECK (qty_contada >= 0),
  rodada smallint NOT NULL DEFAULT 1 CHECK (rodada >= 1),
  contada_por uuid NOT NULL REFERENCES siso_usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inv_cont_sessao ON siso_inventario_contagens(sessao_id, criado_em DESC);
CREATE INDEX idx_inv_cont_loc ON siso_inventario_contagens(sessao_id, localizacao_id, rodada);
CREATE INDEX idx_inv_cont_operador ON siso_inventario_contagens(contada_por, criado_em DESC);
CREATE INDEX idx_inv_cont_quadrupla
  ON siso_inventario_contagens(sessao_id, localizacao_id, produto_id, empresa_dona_id, rodada);

-- 5. Divergências
CREATE TABLE siso_inventario_divergencias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  saldo_sistema numeric NOT NULL,
  qty_contada_final numeric NOT NULL,
  delta numeric GENERATED ALWAYS AS (qty_contada_final - saldo_sistema) STORED,
  delta_pct numeric GENERATED ALWAYS AS (
    CASE WHEN saldo_sistema = 0 THEN NULL
         ELSE ROUND((qty_contada_final - saldo_sistema) / saldo_sistema * 100, 4)
    END
  ) STORED,
  valor_financeiro numeric,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente','recontagem_solicitada','aprovada','rejeitada','aplicada'
  )),
  resolucao_por uuid REFERENCES siso_usuarios(id),
  resolucao_em timestamptz,
  observacoes_resolucao text,
  mov_aplicada_id uuid REFERENCES siso_movimentacoes(id),
  UNIQUE(sessao_id, localizacao_id, produto_id, empresa_dona_id)
);

CREATE INDEX idx_inv_div_sessao ON siso_inventario_divergencias(sessao_id, status);
CREATE INDEX idx_inv_div_status ON siso_inventario_divergencias(status, sessao_id);
CREATE INDEX idx_inv_div_aprovacao ON siso_inventario_divergencias(sessao_id) WHERE status = 'pendente';

-- 6. RPC: pega próxima localização atomicamente (anti-colisão)
CREATE OR REPLACE FUNCTION wms_inventario_pegar_localizacao(
  p_sessao uuid, p_localizacao uuid, p_user uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE siso_inventario_localizacoes
  SET bloqueada_por = p_user, bloqueada_em = now(), status = 'em_contagem'
  WHERE sessao_id = p_sessao
    AND localizacao_id = p_localizacao
    AND bloqueada_por IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'localização já está sendo contada por outro operador ou status inválido';
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- 7. Habilita realtime
ALTER PUBLICATION supabase_realtime ADD TABLE siso_inventario_contagens;
ALTER PUBLICATION supabase_realtime ADD TABLE siso_inventario_localizacoes;
ALTER PUBLICATION supabase_realtime ADD TABLE siso_inventario_areas;
ALTER PUBLICATION supabase_realtime ADD TABLE siso_inventario_divergencias;

COMMIT;
```

- [ ] **Step 2: Apply migration**

Via `mcp__supabase__apply_migration` name=`wms_inventario`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260529_wms_inventario.sql
git commit -m "feat(wms): schema de inventário robusto + RPC anti-colisão + realtime"
```

---

### Task 2: Service de inventário — criar sessão

**Files:**
- Create: `src/lib/wms/inventario.ts`

- [ ] **Step 1: Skeleton + criar sessão**

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import type { TipoMov, OrigemTipo } from "./types";

export type TipoSessao = "cycle_count" | "completo";
export type ModoContagem = "aberto" | "blind" | "duplo_blind";
export type StatusSessao = "planejada" | "em_andamento" | "revisao" | "aprovada" | "aplicada" | "cancelada";

export interface CriarSessaoInput {
  tipo: TipoSessao;
  galpao_id: string;
  empresa_dona_id?: string;
  modo_contagem?: ModoContagem;
  tolerancia_pct?: number;
  tolerancia_qty_min?: number;
  exige_aprovacao_acima_valor?: number;
  programada_para?: string;
  observacoes?: string;
  criada_por: string;
  // Áreas: cada uma com nome, operador opcional, e lista de localizações (ids)
  areas: { nome: string; operador_id?: string; localizacao_ids: string[] }[];
}

export async function criarSessaoInventario(input: CriarSessaoInput): Promise<string> {
  const sb = createServiceClient();
  const { data: sessao, error } = await sb.from("siso_inventario_sessoes")
    .insert({
      tipo: input.tipo,
      galpao_id: input.galpao_id,
      empresa_dona_id: input.empresa_dona_id,
      // Fallbacks alinhados com decisão C (wms-decisoes-do-user.md): blind / 2% / R$1000.
      // Se input vier undefined, esses valores casam com o DEFAULT da coluna; sem divergência.
      modo_contagem: input.modo_contagem ?? "blind",
      tolerancia_pct: input.tolerancia_pct ?? 2.0,
      tolerancia_qty_min: input.tolerancia_qty_min ?? 0,
      exige_aprovacao_acima_valor: input.exige_aprovacao_acima_valor ?? 1000,
      programada_para: input.programada_para,
      observacoes: input.observacoes,
      criada_por: input.criada_por,
    }).select().single();
  if (error) throw error;
  const sessaoId = sessao.id;

  for (const a of input.areas) {
    const { data: area, error: errA } = await sb.from("siso_inventario_areas")
      .insert({ sessao_id: sessaoId, nome: a.nome, operador_id: a.operador_id })
      .select().single();
    if (errA) throw errA;
    if (a.localizacao_ids.length > 0) {
      const rows = a.localizacao_ids.map(loc_id => ({
        sessao_id: sessaoId, area_id: area.id, localizacao_id: loc_id,
      }));
      const { error: errL } = await sb.from("siso_inventario_localizacoes").insert(rows);
      if (errL) throw errL;
    }
  }
  return sessaoId;
}
```

- [ ] **Step 2: Iniciar sessão (cria locks)**

```typescript
export async function iniciarSessao(sessaoId: string, usuarioId: string): Promise<void> {
  const sb = createServiceClient();

  const { data: sessao, error } = await sb.from("siso_inventario_sessoes")
    .select("status").eq("id", sessaoId).single();
  if (error || !sessao) throw new Error("sessão não encontrada");
  if (sessao.status !== "planejada") throw new Error(`sessão não está em status 'planejada' (atual: ${sessao.status})`);

  const { data: locs } = await sb.from("siso_inventario_localizacoes")
    .select("localizacao_id").eq("sessao_id", sessaoId);

  // Cria locks em massa
  const lockRows = (locs ?? []).map(l => ({
    localizacao_id: l.localizacao_id,
    motivo: "cycle_count",
    iniciado_por: usuarioId,
  }));
  if (lockRows.length > 0) {
    const { error: errLock } = await sb.from("siso_localizacao_locks").insert(lockRows);
    if (errLock) throw errLock;
  }

  await sb.from("siso_inventario_sessoes")
    .update({ status: "em_andamento", iniciada_em: new Date().toISOString() })
    .eq("id", sessaoId);
}
```

- [ ] **Step 3: Pegar localização (anti-colisão)**

```typescript
export async function pegarLocalizacao(sessaoId: string, localizacaoId: string, usuarioId: string): Promise<void> {
  const sb = createServiceClient();
  const { error } = await sb.rpc("wms_inventario_pegar_localizacao", {
    p_sessao: sessaoId, p_localizacao: localizacaoId, p_user: usuarioId,
  });
  if (error) throw error;
}

export async function liberarLocalizacao(sessaoId: string, localizacaoId: string): Promise<void> {
  const sb = createServiceClient();
  await sb.from("siso_inventario_localizacoes")
    .update({ bloqueada_por: null, bloqueada_em: null, status: "contada" })
    .eq("sessao_id", sessaoId)
    .eq("localizacao_id", localizacaoId);
}
```

- [ ] **Step 4: Registrar contagem**

```typescript
export interface RegistrarContagemInput {
  sessao_id: string;
  localizacao_id: string;
  produto_id: string;
  empresa_dona_id: string;
  qty_contada: number;
  contada_por: string;
  /**
   * - "incremental" (default): cada bipe soma +qty na contagem atual do operador na quádrupla.
   *   Persiste a cada bipe → seguro contra perda se aba fechar.
   * - "absoluto": substitui qualquer contagem prévia do operador por qty_contada.
   *   Use ao corrigir manualmente.
   */
  modo?: "incremental" | "absoluto";
}

export async function registrarContagem(input: RegistrarContagemInput): Promise<void> {
  const sb = createServiceClient();
  const modo = input.modo ?? "incremental";

  const filtro = {
    sessao_id: input.sessao_id,
    localizacao_id: input.localizacao_id,
    produto_id: input.produto_id,
    empresa_dona_id: input.empresa_dona_id,
  };

  // Determina rodada: outros operadores na mesma quádrupla geram nova rodada (duplo_blind);
  // mesmo operador re-conta na rodada existente dele.
  const { data: existentes } = await sb.from("siso_inventario_contagens")
    .select("id, qty_contada, rodada, contada_por").match(filtro);

  const minhaContagem = existentes?.find(e => e.contada_por === input.contada_por);
  const rodada = minhaContagem
    ? minhaContagem.rodada
    : ((existentes && existentes.length > 0) ? Math.max(...existentes.map(e => e.rodada)) + 1 : 1);

  if (modo === "incremental" && minhaContagem) {
    // Soma +qty na contagem existente do operador
    const { error } = await sb.from("siso_inventario_contagens")
      .update({ qty_contada: Number(minhaContagem.qty_contada) + input.qty_contada })
      .eq("id", minhaContagem.id);
    if (error) throw error;
    return;
  }

  // Modo absoluto OU primeira contagem do operador: insere nova
  if (modo === "absoluto" && minhaContagem) {
    const { error } = await sb.from("siso_inventario_contagens")
      .update({ qty_contada: input.qty_contada })
      .eq("id", minhaContagem.id);
    if (error) throw error;
    return;
  }

  const { error } = await sb.from("siso_inventario_contagens")
    .insert({ ...filtro, qty_contada: input.qty_contada, contada_por: input.contada_por, rodada });
  if (error) throw error;
}
```

- [ ] **Step 5: Computar divergências**

```typescript
export async function computarDivergencias(sessaoId: string): Promise<void> {
  const sb = createServiceClient();
  // Pra cada (localizacao, produto, empresa) com contagens, computa qty_final = mais recente da maior rodada
  const { data: contagens } = await sb.from("siso_inventario_contagens")
    .select("localizacao_id, produto_id, empresa_dona_id, qty_contada, rodada, criado_em")
    .eq("sessao_id", sessaoId)
    .order("rodada", { ascending: false })
    .order("criado_em", { ascending: false });

  if (!contagens) return;

  const map = new Map<string, { localizacao_id: string; produto_id: string; empresa_dona_id: string; qty: number }>();
  for (const c of contagens) {
    const k = `${c.localizacao_id}|${c.produto_id}|${c.empresa_dona_id}`;
    if (!map.has(k)) {
      map.set(k, {
        localizacao_id: c.localizacao_id,
        produto_id: c.produto_id,
        empresa_dona_id: c.empresa_dona_id,
        qty: Number(c.qty_contada),
      });
    }
  }

  // Sessão para tolerância
  const { data: sessao } = await sb.from("siso_inventario_sessoes")
    .select("tolerancia_pct, tolerancia_qty_min, exige_aprovacao_acima_valor")
    .eq("id", sessaoId).single();

  for (const v of map.values()) {
    // Saldo sistema
    const { data: estoque } = await sb.from("siso_estoque")
      .select("saldo, custo_medio").match({
        produto_id: v.produto_id,
        empresa_dona_id: v.empresa_dona_id,
        localizacao_id: v.localizacao_id,
      }).maybeSingle();
    const saldo_sistema = Number(estoque?.saldo ?? 0);
    const delta = v.qty - saldo_sistema;
    const delta_pct = saldo_sistema === 0 ? null : Math.abs(delta / saldo_sistema * 100);
    const valor_financeiro = Number(estoque?.custo_medio ?? 0) * delta;

    let status: "aprovada" | "pendente" = "aprovada";
    if (delta !== 0) {
      const dentroTol = (sessao?.tolerancia_pct ?? 0) > 0 && delta_pct !== null
        ? delta_pct <= sessao.tolerancia_pct
        : Math.abs(delta) <= (sessao?.tolerancia_qty_min ?? 0);
      const acimaValor = sessao?.exige_aprovacao_acima_valor !== null
        && sessao?.exige_aprovacao_acima_valor !== undefined
        && Math.abs(valor_financeiro) > Number(sessao.exige_aprovacao_acima_valor);
      status = dentroTol && !acimaValor ? "aprovada" : "pendente";
    }

    await sb.from("siso_inventario_divergencias").upsert({
      sessao_id: sessaoId,
      localizacao_id: v.localizacao_id,
      produto_id: v.produto_id,
      empresa_dona_id: v.empresa_dona_id,
      saldo_sistema,
      qty_contada_final: v.qty,
      valor_financeiro,
      status,
    }, { onConflict: "sessao_id,localizacao_id,produto_id,empresa_dona_id" });
  }

  // Atualiza status sessão pra revisao
  await sb.from("siso_inventario_sessoes")
    .update({ status: "revisao", finalizada_em: new Date().toISOString() })
    .eq("id", sessaoId);
}
```

- [ ] **Step 6: Aplicar sessão (gera movs)**

```typescript
import { inserirMovimentacao } from "./ledger";

export async function aplicarSessao(sessaoId: string, usuarioId: string): Promise<{
  movsGeradas: number;
}> {
  const sb = createServiceClient();
  const { data: sessao } = await sb.from("siso_inventario_sessoes")
    .select("status, galpao_id").eq("id", sessaoId).single();
  if (!sessao) throw new Error("sessão não encontrada");
  if (sessao.status !== "aprovada") throw new Error("sessão não está aprovada");

  const { data: divergencias } = await sb.from("siso_inventario_divergencias")
    .select("*").eq("sessao_id", sessaoId).eq("status", "aprovada");

  let movsGeradas = 0;
  for (const d of divergencias ?? []) {
    if (Number(d.delta) === 0) continue;
    const tipo: TipoMov = Number(d.delta) > 0 ? "E" : "S";
    const qty = Math.abs(Number(d.delta));
    const mov = await inserirMovimentacao({
      quadrupla: {
        produto_id: d.produto_id,
        empresa_dona_id: d.empresa_dona_id,
        galpao_id: sessao.galpao_id,
        localizacao_id: d.localizacao_id,
      },
      tipo, qty,
      origem_tipo: "inventario",
      origem_id: sessaoId,
      origem_detalhes: { divergencia_id: d.id, delta_pct: d.delta_pct },
      usuario_id: usuarioId,
      observacoes: `inventário sessão ${sessaoId}`,
    });
    await sb.from("siso_inventario_divergencias")
      .update({ status: "aplicada", mov_aplicada_id: mov.id })
      .eq("id", d.id);
    movsGeradas++;
  }

  // Libera locks
  const { data: locs } = await sb.from("siso_inventario_localizacoes")
    .select("localizacao_id").eq("sessao_id", sessaoId);
  if (locs && locs.length > 0) {
    await sb.from("siso_localizacao_locks")
      .update({ finalizado_em: new Date().toISOString() })
      .in("localizacao_id", locs.map(l => l.localizacao_id))
      .is("finalizado_em", null);
  }

  await sb.from("siso_inventario_sessoes")
    .update({ status: "aplicada", aplicada_em: new Date().toISOString() })
    .eq("id", sessaoId);

  return { movsGeradas };
}

export async function aprovarSessao(sessaoId: string, aprovadaPor: string): Promise<void> {
  const sb = createServiceClient();
  // Pré-condição: nenhuma divergência pendente
  const { data: pendentes } = await sb.from("siso_inventario_divergencias")
    .select("id").eq("sessao_id", sessaoId).eq("status", "pendente").limit(1);
  if (pendentes && pendentes.length > 0) {
    throw new Error("ainda há divergências pendentes; resolva antes de aprovar");
  }
  await sb.from("siso_inventario_sessoes")
    .update({ status: "aprovada", aprovada_por: aprovadaPor })
    .eq("id", sessaoId);
}
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/wms/inventario.ts
git commit -m "feat(wms): service de inventário (criar/iniciar/contar/aplicar)"
```

---

### Task 3: APIs de inventário — sessões

**Files:**
- Create: `src/app/api/wms/inventario/route.ts`
- Create: `src/app/api/wms/inventario/[id]/route.ts`
- Create: `src/app/api/wms/inventario/[id]/iniciar/route.ts`
- Create: `src/app/api/wms/inventario/[id]/aprovar/route.ts`
- Create: `src/app/api/wms/inventario/[id]/aplicar/route.ts`

- [ ] **Step 1: list/create**

```typescript
// src/app/api/wms/inventario/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { criarSessaoInventario } from "@/lib/wms/inventario";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = createServiceClient();
  const sp = req.nextUrl.searchParams;
  let q = sb.from("siso_inventario_sessoes").select("*, galpao:siso_galpoes(nome), criada_por_user:siso_usuarios!siso_inventario_sessoes_criada_por_fkey(nome)")
    .order("criado_em", { ascending: false }).limit(100);
  if (sp.get("status")) q = q.eq("status", sp.get("status"));
  if (sp.get("galpao_id")) q = q.eq("galpao_id", sp.get("galpao_id"));
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.tipo || !body.galpao_id || !Array.isArray(body.areas)) {
    return NextResponse.json({ error: "tipo, galpao_id, areas obrigatórios" }, { status: 400 });
  }
  try {
    const id = await criarSessaoInventario({ ...body, criada_por: user.id });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

- [ ] **Step 2: detail + cancelar**

```typescript
// src/app/api/wms/inventario/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const sb = createServiceClient();
  const [sessao, areas, locs, contagens, divergencias] = await Promise.all([
    sb.from("siso_inventario_sessoes").select("*").eq("id", id).single(),
    sb.from("siso_inventario_areas").select("*, operador:siso_usuarios(nome)").eq("sessao_id", id),
    sb.from("siso_inventario_localizacoes").select("*, localizacao:siso_localizacoes(codigo, tipo)").eq("sessao_id", id),
    sb.from("siso_inventario_contagens").select("*, contada_por_user:siso_usuarios(nome), produto:siso_produtos(sku)").eq("sessao_id", id),
    sb.from("siso_inventario_divergencias").select("*, produto:siso_produtos(sku, descricao), localizacao:siso_localizacoes(codigo)").eq("sessao_id", id),
  ]);
  return NextResponse.json({
    sessao: sessao.data, areas: areas.data, localizacoes: locs.data, contagens: contagens.data, divergencias: divergencias.data,
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  const sb = createServiceClient();
  const { error } = await sb.from("siso_inventario_sessoes").update(body).eq("id", id);
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const sb = createServiceClient();
  // Cancela: status='cancelada' e libera locks
  const { data: locs } = await sb.from("siso_inventario_localizacoes").select("localizacao_id").eq("sessao_id", id);
  if (locs?.length) {
    await sb.from("siso_localizacao_locks")
      .update({ finalizado_em: new Date().toISOString() })
      .in("localizacao_id", locs.map(l => l.localizacao_id))
      .is("finalizado_em", null);
  }
  await sb.from("siso_inventario_sessoes").update({ status: "cancelada" }).eq("id", id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: iniciar/aprovar/aplicar**

```typescript
// src/app/api/wms/inventario/[id]/iniciar/route.ts
import { NextRequest, NextResponse } from "next/server";
import { iniciarSessao } from "@/lib/wms/inventario";
import { getSessionUser } from "@/lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await iniciarSessao(id, user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

```typescript
// src/app/api/wms/inventario/[id]/aprovar/route.ts
import { NextRequest, NextResponse } from "next/server";
import { aprovarSessao, computarDivergencias } from "@/lib/wms/inventario";
import { getSessionUser } from "@/lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    // Garante que divergências estão computadas antes de aprovar
    await computarDivergencias(id);
    await aprovarSessao(id, user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

```typescript
// src/app/api/wms/inventario/[id]/aplicar/route.ts
import { NextRequest, NextResponse } from "next/server";
import { aplicarSessao } from "@/lib/wms/inventario";
import { getSessionUser } from "@/lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const r = await aplicarSessao(id, user.id);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/inventario/route.ts src/app/api/wms/inventario/[id]/
git commit -m "feat(wms): APIs de sessão de inventário"
```

---

### Task 4: APIs de contagem + bloqueio + divergências

**Files:**
- Create: `src/app/api/wms/inventario/[id]/contagens/route.ts`
- Create: `src/app/api/wms/inventario/[id]/localizacoes/[locId]/bloquear/route.ts`
- Create: `src/app/api/wms/inventario/[id]/divergencias/route.ts`

- [ ] **Step 1: contagens**

```typescript
// src/app/api/wms/inventario/[id]/contagens/route.ts
import { NextRequest, NextResponse } from "next/server";
import { registrarContagem } from "@/lib/wms/inventario";
import { getSessionUser } from "@/lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  try {
    await registrarContagem({ ...body, sessao_id: id, contada_por: user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

- [ ] **Step 2: bloquear/liberar**

```typescript
// src/app/api/wms/inventario/[id]/localizacoes/[locId]/bloquear/route.ts
import { NextRequest, NextResponse } from "next/server";
import { pegarLocalizacao, liberarLocalizacao } from "@/lib/wms/inventario";
import { getSessionUser } from "@/lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; locId: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, locId } = await params;
  try {
    await pegarLocalizacao(id, locId, user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 409 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; locId: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, locId } = await params;
  try {
    await liberarLocalizacao(id, locId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: divergências resolução**

```typescript
// src/app/api/wms/inventario/[id]/divergencias/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const sb = createServiceClient();
  const sp = req.nextUrl.searchParams;
  let q = sb.from("siso_inventario_divergencias")
    .select("*, produto:siso_produtos(sku, descricao), localizacao:siso_localizacoes(codigo)")
    .eq("sessao_id", id);
  if (sp.get("status")) q = q.eq("status", sp.get("status"));
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  if (!body.divergencia_id || !body.acao) {
    return NextResponse.json({ error: "divergencia_id e acao obrigatórios" }, { status: 400 });
  }
  const sb = createServiceClient();
  const novoStatus = body.acao === "aprovar" ? "aprovada"
    : body.acao === "rejeitar" ? "rejeitada"
    : body.acao === "recontar" ? "recontagem_solicitada" : null;
  if (!novoStatus) return NextResponse.json({ error: "acao inválida" }, { status: 400 });

  await sb.from("siso_inventario_divergencias")
    .update({
      status: novoStatus,
      resolucao_por: user.id,
      resolucao_em: new Date().toISOString(),
      observacoes_resolucao: body.observacoes,
    })
    .eq("id", body.divergencia_id);

  // Se recontar, atualiza status da localização
  if (body.acao === "recontar") {
    const { data: d } = await sb.from("siso_inventario_divergencias").select("localizacao_id, sessao_id").eq("id", body.divergencia_id).single();
    if (d) {
      await sb.from("siso_inventario_localizacoes")
        .update({ status: "recontagem", bloqueada_por: null, bloqueada_em: null })
        .eq("sessao_id", d.sessao_id).eq("localizacao_id", d.localizacao_id);
    }
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/inventario/[id]/contagens/ src/app/api/wms/inventario/[id]/localizacoes/ src/app/api/wms/inventario/[id]/divergencias/
git commit -m "feat(wms): APIs de contagem, bloqueio anti-colisão e divergências"
```

---

### Task 5: Hook Realtime

**Files:**
- Create: `src/hooks/use-inventario-realtime.ts`

- [ ] **Step 1: Hook**

```typescript
"use client";
import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export interface Contagem { id: string; localizacao_id: string; produto_id: string; qty_contada: number; rodada: number; criado_em: string; contada_por: string; }
export interface LocSessao { id: string; localizacao_id: string; status: string; bloqueada_por: string | null; }

export function useInventarioRealtime(sessaoId: string | null) {
  const [contagens, setContagens] = useState<Contagem[]>([]);
  const [locs, setLocs] = useState<LocSessao[]>([]);

  useEffect(() => {
    if (!sessaoId) return;
    let cancelled = false;

    // initial fetch
    (async () => {
      const [c, l] = await Promise.all([
        sb.from("siso_inventario_contagens").select("*").eq("sessao_id", sessaoId),
        sb.from("siso_inventario_localizacoes").select("*").eq("sessao_id", sessaoId),
      ]);
      if (cancelled) return;
      setContagens((c.data ?? []) as Contagem[]);
      setLocs((l.data ?? []) as LocSessao[]);
    })();

    const channel = sb.channel(`inventario:${sessaoId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "siso_inventario_contagens", filter: `sessao_id=eq.${sessaoId}` },
        ({ new: r }) => setContagens(prev => [...prev, r as Contagem]))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "siso_inventario_localizacoes", filter: `sessao_id=eq.${sessaoId}` },
        ({ new: r }) => setLocs(prev => prev.map(x => x.id === (r as any).id ? r as LocSessao : x)))
      .subscribe();

    return () => { cancelled = true; sb.removeChannel(channel); };
  }, [sessaoId]);

  return { contagens, locs };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/use-inventario-realtime.ts
git commit -m "feat(wms): hook de realtime pra sessão de inventário"
```

---

### Task 6: Tela de listagem + criar sessão

**Files:**
- Create: `src/app/wms/inventario/page.tsx`

- [ ] **Step 1: Page**

```tsx
"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import Link from "next/link";

export default function InventarioListaPage() {
  const queryClient = useQueryClient();
  // Defaults travados conforme decisões C1-C3 (wms-decisoes.md):
  // tolerancia_pct=2, modo_contagem="blind", exige_aprovacao_acima_valor=1000
  const [novo, setNovo] = useState<any>({
    tipo: "cycle_count",
    galpao_id: "",
    modo_contagem: "blind",
    tolerancia_pct: 2,
    exige_aprovacao_acima_valor: 1000,
    areas: [],
  });

  const { data: sessoes } = useQuery({ queryKey: ["wms-inv-sessoes"], queryFn: async () => (await sisoFetch("/api/wms/inventario")).json() });
  const { data: galpoes } = useQuery({ queryKey: ["galpoes"], queryFn: async () => (await sisoFetch("/api/admin/galpoes")).json() });
  const { data: locs } = useQuery({
    queryKey: ["wms-locs", novo.galpao_id],
    queryFn: async () => novo.galpao_id ? (await sisoFetch(`/api/wms/localizacoes?galpao_id=${novo.galpao_id}`)).json() : { rows: [] },
    enabled: !!novo.galpao_id,
  });

  const criar = useMutation({
    mutationFn: async () => sisoFetch("/api/wms/inventario", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(novo),
    }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: () => { toast.success("sessão criada"); queryClient.invalidateQueries({ queryKey: ["wms-inv-sessoes"] }); },
    onError: (e) => toast.error(String(e)),
  });

  function adicionarArea(localizacao_ids: string[]) {
    setNovo((p: any) => ({ ...p, areas: [...p.areas, { nome: `Área ${p.areas.length + 1}`, localizacao_ids }] }));
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-lg font-medium">Sessões de inventário</h1>

      <details className="rounded border border-zinc-200 dark:border-zinc-800">
        <summary className="p-3 cursor-pointer">Criar nova sessão</summary>
        <div className="p-3 space-y-3">
          <div className="flex gap-2">
            <select value={novo.tipo} onChange={e => setNovo({ ...novo, tipo: e.target.value })}
              className="px-2 py-1 rounded border bg-transparent">
              <option value="cycle_count">cycle count</option>
              <option value="completo">inventário completo</option>
            </select>
            <select value={novo.galpao_id} onChange={e => setNovo({ ...novo, galpao_id: e.target.value, areas: [] })}
              className="px-2 py-1 rounded border bg-transparent">
              <option value="">— galpão —</option>
              {galpoes?.galpoes?.map((g: any) => <option key={g.id} value={g.id}>{g.nome}</option>)}
            </select>
            <select value={novo.modo_contagem} onChange={e => setNovo({ ...novo, modo_contagem: e.target.value })}
              className="px-2 py-1 rounded border bg-transparent">
              <option value="aberto">aberto</option>
              <option value="blind">blind</option>
              <option value="duplo_blind">duplo blind</option>
            </select>
            <input type="number" step="0.5" value={novo.tolerancia_pct} onChange={e => setNovo({ ...novo, tolerancia_pct: Number(e.target.value) })}
              className="w-20 px-2 py-1 rounded border bg-transparent" placeholder="tol %" />
          </div>

          {novo.galpao_id && (
            <div>
              <button onClick={() => adicionarArea((locs?.rows ?? []).map((l: any) => l.id))}
                className="px-3 py-1 rounded border text-sm">adicionar todas localizações como Área 1</button>
              <div className="mt-2 text-sm">{novo.areas.length} área(s) configurada(s)</div>
            </div>
          )}

          <button onClick={() => criar.mutate()} disabled={!novo.galpao_id || novo.areas.length === 0}
            className="px-3 py-1 rounded bg-zinc-900 text-white">criar sessão</button>
        </div>
      </details>

      <div className="space-y-2">
        {sessoes?.rows?.map((s: any) => (
          <Link key={s.id} href={`/wms/inventario/${s.id}`}
            className="block p-3 rounded border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-xs text-zinc-500">{s.id.slice(0, 8)}</span>
                <span className="ml-2">{s.tipo} · {s.galpao?.nome}</span>
              </div>
              <div className="text-sm">
                <span className={`px-2 py-0.5 rounded text-xs ${s.status === "em_andamento" ? "bg-blue-100 text-blue-900" : s.status === "aplicada" ? "bg-green-100 text-green-900" : "bg-zinc-100"}`}>
                  {s.status}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/wms/inventario/page.tsx
git commit -m "feat(wms): tela de listagem e criação de sessão de inventário"
```

---

### Task 7: Painel realtime do supervisor

**Files:**
- Create: `src/app/wms/inventario/[id]/page.tsx`

- [ ] **Step 1: Page**

```tsx
"use client";
import { use, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { useInventarioRealtime } from "@/hooks/use-inventario-realtime";
import { toast } from "sonner";
import Link from "next/link";

export default function InventarioDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const { contagens, locs } = useInventarioRealtime(id);

  const { data } = useQuery({
    queryKey: ["wms-inv", id],
    queryFn: async () => (await sisoFetch(`/api/wms/inventario/${id}`)).json(),
  });

  const iniciar = useMutation({
    mutationFn: async () => sisoFetch(`/api/wms/inventario/${id}/iniciar`, { method: "POST" }).then(r => r.json()),
    onSuccess: () => { toast.success("iniciada"); queryClient.invalidateQueries({ queryKey: ["wms-inv", id] }); },
  });

  const aprovar = useMutation({
    mutationFn: async () => sisoFetch(`/api/wms/inventario/${id}/aprovar`, { method: "POST" }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: () => { toast.success("aprovada"); queryClient.invalidateQueries({ queryKey: ["wms-inv", id] }); },
    onError: (e) => toast.error(String(e)),
  });

  const aplicar = useMutation({
    mutationFn: async () => sisoFetch(`/api/wms/inventario/${id}/aplicar`, { method: "POST" }).then(r => r.json()),
    onSuccess: (r: any) => { toast.success(`${r.movsGeradas} movs geradas`); queryClient.invalidateQueries({ queryKey: ["wms-inv", id] }); },
  });

  const progresso = useMemo(() => {
    const total = locs.length;
    const concluidas = locs.filter(l => l.status === "contada" || l.status === "aprovada").length;
    return total > 0 ? concluidas / total : 0;
  }, [locs]);

  const totalContado = useMemo(() => contagens.reduce((s, c) => s + Number(c.qty_contada), 0), [contagens]);

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Inventário {id.slice(0, 8)}</h1>
        <span className="text-sm">status: <strong>{data?.sessao?.status}</strong></span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm">
        <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800">
          <div className="text-zinc-500">progresso</div>
          <div className="text-2xl tabular-nums">{(progresso * 100).toFixed(1)}%</div>
        </div>
        <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800">
          <div className="text-zinc-500">contagens registradas</div>
          <div className="text-2xl tabular-nums">{contagens.length}</div>
        </div>
        <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800">
          <div className="text-zinc-500">total qty contada</div>
          <div className="text-2xl tabular-nums">{totalContado.toLocaleString("pt-BR")}</div>
        </div>
      </div>

      <div className="flex gap-2">
        {data?.sessao?.status === "planejada" && <button onClick={() => iniciar.mutate()} className="px-3 py-1 rounded bg-zinc-900 text-white">iniciar</button>}
        {data?.sessao?.status === "em_andamento" && <button onClick={() => aprovar.mutate()} className="px-3 py-1 rounded bg-zinc-900 text-white">finalizar/aprovar</button>}
        {data?.sessao?.status === "aprovada" && <button onClick={() => aplicar.mutate()} className="px-3 py-1 rounded bg-green-700 text-white">aplicar no estoque</button>}
        <Link href={`/wms/inventario/${id}/contar`} className="px-3 py-1 rounded border">tela do operador</Link>
        <Link href={`/wms/inventario/${id}/divergencias`} className="px-3 py-1 rounded border">divergências</Link>
      </div>

      <details className="rounded border border-zinc-200 dark:border-zinc-800">
        <summary className="p-3 cursor-pointer">Áreas e localizações</summary>
        <div className="p-3 space-y-2">
          {data?.areas?.map((a: any) => (
            <div key={a.id} className="border-l-2 border-zinc-300 pl-3">
              <div className="font-medium">{a.nome} {a.operador?.nome && <span className="text-zinc-500 text-sm">— {a.operador.nome}</span>}</div>
              <div className="text-xs text-zinc-500">{locs.filter(l => (l as any).area_id === a.id).length} localizações</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/wms/inventario/[id]/page.tsx
git commit -m "feat(wms): painel realtime do supervisor com progresso global"
```

---

### Task 8: Tela do operador (handheld-friendly)

**Files:**
- Create: `src/components/wms/scan-contagem.tsx`
- Create: `src/app/wms/inventario/[id]/contar/page.tsx`

- [ ] **Step 1: Scan input**

```tsx
"use client";
import { useEffect, useRef } from "react";

export function ScanContagem({ onScan, autoFocus = true }: { onScan: (value: string) => void; autoFocus?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  return (
    <input ref={ref} placeholder="bipe SKU/GTIN"
      onKeyDown={e => {
        if (e.key === "Enter" && (e.target as HTMLInputElement).value) {
          onScan((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).value = "";
        }
      }}
      className="w-full px-3 py-3 text-lg rounded border-2 border-zinc-400 bg-transparent font-mono" />
  );
}
```

- [ ] **Step 2: Page (mobile-first)**

```tsx
"use client";
import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { ScanContagem } from "@/components/wms/scan-contagem";
import { toast } from "sonner";

export default function ContarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const [locId, setLocId] = useState<string>("");
  const [contagens, setContagens] = useState<{ sku: string; produto_id: string; qty: number }[]>([]);

  const { data } = useQuery({ queryKey: ["wms-inv", id], queryFn: async () => (await sisoFetch(`/api/wms/inventario/${id}`)).json() });
  const sessao = data?.sessao;
  const localizacoes = (data?.localizacoes ?? []).filter((l: any) => l.status === "pendente" || l.status === "recontagem");
  const blind = sessao?.modo_contagem === "blind" || sessao?.modo_contagem === "duplo_blind";

  const pegarLoc = useMutation({
    mutationFn: async (newLocId: string) => sisoFetch(`/api/wms/inventario/${id}/localizacoes/${newLocId}/bloquear`, { method: "POST" })
      .then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.error)); return r.json(); }),
    onSuccess: (_, newLocId) => { setLocId(newLocId); setContagens([]); toast.success("localização bloqueada"); queryClient.invalidateQueries({ queryKey: ["wms-inv", id] }); },
    onError: (e) => toast.error(String(e)),
  });

  // Cada bipe submete IMEDIATAMENTE ao DB; nada fica só em memória.
  // Estado local só pra mostrar contagens recentes na tela.
  async function handleScan(value: string) {
    const r = await (await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(value)}&limit=1`)).json();
    const p = r.rows?.[0];
    if (!p) return toast.error("SKU não encontrado");
    const empresaId = data.localizacoes?.find((l: any) => l.localizacao_id === locId)?.localizacao?.empresa_id ?? sessao.empresa_dona_id;
    // Submete +1 ao DB (cada bipe é atômico)
    const resp = await sisoFetch(`/api/wms/inventario/${id}/contagens`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localizacao_id: locId, produto_id: p.id, empresa_dona_id: empresaId, qty_contada: 1, modo: "incremental" }),
    });
    if (!resp.ok) {
      toast.error("falha ao registrar bipe");
      return;
    }
    setContagens(prev => {
      const existing = prev.find(c => c.produto_id === p.id);
      if (existing) return prev.map(c => c.produto_id === p.id ? { ...c, qty: c.qty + 1 } : c);
      return [...prev, { sku: p.sku, produto_id: p.id, qty: 1 }];
    });
  }

  // Cada bipe já foi submetido em handleScan; finalizar só libera o lock.
  const finalizar = useMutation({
    mutationFn: async () => {
      await sisoFetch(`/api/wms/inventario/${id}/localizacoes/${locId}/bloquear`, { method: "DELETE" });
    },
    onSuccess: () => { setLocId(""); setContagens([]); toast.success("localização concluída"); queryClient.invalidateQueries({ queryKey: ["wms-inv", id] }); },
  });

  return (
    <div className="space-y-3 max-w-md mx-auto">
      <h1 className="text-lg font-medium">Contar — {sessao?.tipo}</h1>
      {blind && <div className="text-xs px-2 py-1 rounded bg-yellow-100 text-yellow-900">modo blind: você não vê o saldo esperado</div>}

      {!locId ? (
        <div className="space-y-2">
          <div className="text-sm text-zinc-500">Escolha uma localização pendente:</div>
          {localizacoes.map((l: any) => (
            <button key={l.id} onClick={() => pegarLoc.mutate(l.localizacao_id)}
              className="block w-full p-3 rounded border border-zinc-300 text-left">
              <div className="font-mono">{l.localizacao?.codigo}</div>
              <div className="text-xs text-zinc-500">{l.localizacao?.tipo}</div>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="p-2 rounded bg-zinc-100 dark:bg-zinc-900 font-mono">localização: {locId.slice(0, 8)}</div>
          <ScanContagem onScan={handleScan} />
          <div className="space-y-1">
            {contagens.map(c => (
              <div key={c.produto_id} className="flex justify-between p-2 rounded border border-zinc-200 dark:border-zinc-800">
                <span className="font-mono">{c.sku}</span>
                <span className="text-lg tabular-nums">{c.qty}</span>
              </div>
            ))}
          </div>
          <button onClick={() => finalizar.mutate()} disabled={contagens.length === 0 || finalizar.isPending}
            className="w-full py-3 rounded bg-zinc-900 text-white">finalizar localização</button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/wms/scan-contagem.tsx src/app/wms/inventario/[id]/contar/
git commit -m "feat(wms): tela do operador (handheld) com scan e anti-colisão"
```

---

### Task 9: Tela de divergências

**Files:**
- Create: `src/app/wms/inventario/[id]/divergencias/page.tsx`

- [ ] **Step 1: Page**

```tsx
"use client";
import { use } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";

export default function DivergenciasPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["wms-inv-div", id],
    queryFn: async () => (await sisoFetch(`/api/wms/inventario/${id}/divergencias`)).json() as Promise<{ rows: any[] }>,
  });

  const resolver = useMutation({
    mutationFn: async ({ divergencia_id, acao }: { divergencia_id: string; acao: "aprovar" | "rejeitar" | "recontar" }) =>
      sisoFetch(`/api/wms/inventario/${id}/divergencias`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ divergencia_id, acao }),
      }).then(r => r.json()),
    onSuccess: () => { toast.success("ok"); queryClient.invalidateQueries({ queryKey: ["wms-inv-div", id] }); },
  });

  return (
    <div className="space-y-3 max-w-5xl">
      <h1 className="text-lg font-medium">Divergências</h1>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-zinc-500 text-xs"><th>SKU</th><th>localização</th><th className="text-right">esperado</th><th className="text-right">contado</th><th className="text-right">delta</th><th className="text-right">%</th><th>R$</th><th>status</th><th>ações</th></tr>
        </thead>
        <tbody>
          {data?.rows.map(d => (
            <tr key={d.id} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="font-mono text-xs">{d.produto?.sku}</td>
              <td>{d.localizacao?.codigo}</td>
              <td className="text-right tabular-nums">{d.saldo_sistema}</td>
              <td className="text-right tabular-nums">{d.qty_contada_final}</td>
              <td className={`text-right tabular-nums ${d.delta > 0 ? "text-green-700" : d.delta < 0 ? "text-red-700" : ""}`}>{d.delta}</td>
              <td className="text-right tabular-nums">{d.delta_pct}%</td>
              <td className="text-right tabular-nums">{d.valor_financeiro?.toFixed(2)}</td>
              <td><span className="text-xs px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">{d.status}</span></td>
              <td className="space-x-1">
                {d.status === "pendente" && (
                  <>
                    <button onClick={() => resolver.mutate({ divergencia_id: d.id, acao: "aprovar" })} className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-900">aprovar</button>
                    <button onClick={() => resolver.mutate({ divergencia_id: d.id, acao: "recontar" })} className="text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-900">recontar</button>
                    <button onClick={() => resolver.mutate({ divergencia_id: d.id, acao: "rejeitar" })} className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-900">rejeitar</button>
                  </>
                )}
              </td>
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
git add src/app/wms/inventario/[id]/divergencias/
git commit -m "feat(wms): dashboard de divergências com resolução em lote"
```

---

### Task 10: Métricas de acuracidade

**Files:**
- Create: `src/app/wms/inventario/metricas/page.tsx`
- Create: `src/app/api/wms/inventario/metricas/route.ts`

- [ ] **Step 1: API metricas**

```typescript
// src/app/api/wms/inventario/metricas/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!await getSessionUser(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = createServiceClient();

  // Acuracidade por operador (últimos 30d)
  const { data: porOperador } = await sb.rpc("wms_metricas_operador" as any).then(r => r).catch(() => ({ data: [] }));

  // Acuracidade por localização (últimos 6 meses) — query direta
  const { data: porLocalizacao } = await sb.rpc("wms_metricas_localizacao" as any).then(r => r).catch(() => ({ data: [] }));

  // Cobertura de cycle count
  const { data: cobertura } = await sb.from("siso_localizacoes").select("id, codigo").eq("ativo", true);
  return NextResponse.json({ porOperador: porOperador ?? [], porLocalizacao: porLocalizacao ?? [], cobertura });
}
```

Adicionar RPCs em `supabase/migrations/20260529_wms_metricas.sql`:

```sql
CREATE OR REPLACE FUNCTION wms_metricas_operador()
RETURNS TABLE (operador_id uuid, nome text, contagens int, erro_medio_pct numeric)
LANGUAGE sql AS $$
  SELECT u.id, u.nome,
         COUNT(DISTINCT c.id)::int AS contagens,
         AVG(ABS(d.delta_pct)) FILTER (WHERE d.id IS NOT NULL) AS erro_medio_pct
  FROM siso_inventario_contagens c
  JOIN siso_usuarios u ON u.id = c.contada_por
  LEFT JOIN siso_inventario_divergencias d
    ON d.sessao_id = c.sessao_id
   AND d.localizacao_id = c.localizacao_id
   AND d.produto_id = c.produto_id
   AND d.empresa_dona_id = c.empresa_dona_id
  WHERE c.criado_em >= now() - interval '30 days'
  GROUP BY u.id, u.nome
  ORDER BY erro_medio_pct DESC NULLS LAST;
$$;

CREATE OR REPLACE FUNCTION wms_metricas_localizacao()
RETURNS TABLE (localizacao_id uuid, codigo text, total int, sem_div int, erro_medio_pct numeric)
LANGUAGE sql AS $$
  SELECT l.id, l.codigo,
         COUNT(DISTINCT il.sessao_id)::int,
         COUNT(DISTINCT CASE WHEN d.delta = 0 OR d.id IS NULL THEN il.sessao_id END)::int,
         AVG(ABS(d.delta_pct)) FILTER (WHERE d.id IS NOT NULL)
  FROM siso_inventario_localizacoes il
  JOIN siso_localizacoes l ON l.id = il.localizacao_id
  LEFT JOIN siso_inventario_divergencias d
    ON d.localizacao_id = il.localizacao_id AND d.sessao_id = il.sessao_id
  WHERE il.id IN (SELECT id FROM siso_inventario_localizacoes ORDER BY id DESC LIMIT 5000)
  GROUP BY l.id, l.codigo
  ORDER BY erro_medio_pct DESC NULLS LAST;
$$;
```

Apply migration.

- [ ] **Step 2: Tela**

```tsx
"use client";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";

export default function MetricasPage() {
  const { data } = useQuery({ queryKey: ["wms-inv-metricas"], queryFn: async () => (await sisoFetch("/api/wms/inventario/metricas")).json() });

  return (
    <div className="space-y-4 max-w-4xl">
      <h2 className="text-lg font-medium">Acuracidade por operador (30d)</h2>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-zinc-500"><th>operador</th><th className="text-right">contagens</th><th className="text-right">erro médio %</th></tr></thead>
        <tbody>
          {data?.porOperador?.map((r: any) => (
            <tr key={r.operador_id} className="border-t border-zinc-200 dark:border-zinc-800">
              <td>{r.nome}</td>
              <td className="text-right tabular-nums">{r.contagens}</td>
              <td className="text-right tabular-nums">{r.erro_medio_pct?.toFixed(2) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="text-lg font-medium">Acuracidade por localização</h2>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-zinc-500"><th>código</th><th className="text-right">total</th><th className="text-right">s/ divergência</th><th className="text-right">erro médio %</th></tr></thead>
        <tbody>
          {data?.porLocalizacao?.map((r: any) => (
            <tr key={r.localizacao_id} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="font-mono">{r.codigo}</td>
              <td className="text-right tabular-nums">{r.total}</td>
              <td className="text-right tabular-nums">{r.sem_div}</td>
              <td className="text-right tabular-nums">{r.erro_medio_pct?.toFixed(2) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/inventario/metricas/ src/app/api/wms/inventario/metricas/ supabase/migrations/20260529_wms_metricas.sql
git commit -m "feat(wms): métricas de acuracidade por operador e localização"
```

---

### Task 10.5: Curva ABC automática (giro 30d)

**Files:**
- Create: migration `20260529_wms_curva_abc.sql`

User decidiu: classificar produtos em A/B/C automaticamente baseado em giro 30d. Top 20% = A (alto giro), próximos 30% = B, resto = C. Materialized view com refresh diário.

- [ ] **Step 1: Migration**

```sql
CREATE MATERIALIZED VIEW siso_curva_abc AS
WITH giro AS (
  SELECT produto_id,
         SUM(quantidade) AS qty_30d,
         COUNT(*) AS movs_30d
  FROM siso_movimentacoes
  WHERE tipo = 'S'
    AND origem_tipo IN ('nf_venda','emprestimo')
    AND criado_em >= now() - interval '30 days'
    AND estorno_de IS NULL
  GROUP BY produto_id
),
ranked AS (
  SELECT produto_id, qty_30d, movs_30d,
         PERCENT_RANK() OVER (ORDER BY qty_30d DESC) AS rank_pct
  FROM giro
)
SELECT
  produto_id, qty_30d, movs_30d, rank_pct,
  CASE
    WHEN rank_pct <= 0.20 THEN 'A'
    WHEN rank_pct <= 0.50 THEN 'B'
    ELSE 'C'
  END AS curva
FROM ranked;

CREATE UNIQUE INDEX uq_curva_abc ON siso_curva_abc(produto_id);
CREATE INDEX idx_curva_abc_categoria ON siso_curva_abc(curva);

CREATE OR REPLACE FUNCTION wms_refresh_curva_abc()
RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW siso_curva_abc;
$$;
```

- [ ] **Step 2: Apply migration**

Via `mcp__supabase__apply_migration` no branch_id `wms-fase0`.

- [ ] **Step 3: Cron job de refresh diário 03h30**

Adicionar pg_cron junto com os outros (cobertura). Documentar no CLAUDE.md.

- [ ] **Step 4: Exibir curva na UI de programação de cycle count**

Na tela `/wms/inventario` (Task 6), filtro adicional "filtrar localizações com produtos curva A" pra ajudar a montar sessões focadas em alto giro.

```tsx
// Na criação de sessão, opção:
<select onChange={...}>
  <option>Selecionar manualmente</option>
  <option value="A">Só localizações com produtos curva A</option>
  <option value="ABC-A20-B30-C50">Mix proporcional ABC</option>
</select>
```

A query de seleção busca de `siso_curva_abc` joinado com `siso_estoque`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260529_wms_curva_abc.sql src/app/wms/inventario/page.tsx
git commit -m "feat(wms): curva ABC automática via giro 30d + filtro em criação de sessão"
```

---

### Task 11: Recovery de sessões órfãs

**Files:**
- Create: `src/lib/wms/inventario-recovery.ts`
- Create: `src/app/api/wms/inventario/cleanup/route.ts`

- [ ] **Step 1: Service**

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * - Detecta sessões `em_andamento` sem contagens nas últimas 4h → marca alerta
 * - Detecta locks de localização > 30min sem contagem → libera
 */
export async function recoveryInventario(): Promise<{
  sessoesAlerta: string[]; locksLiberados: number;
}> {
  const sb = createServiceClient();
  const cutoff4h = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const cutoff30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  // 1. Sessões em andamento sem contagem recente
  const { data: ativas } = await sb.from("siso_inventario_sessoes")
    .select("id, iniciada_em").eq("status", "em_andamento");

  const alertaIds: string[] = [];
  for (const s of ativas ?? []) {
    const { data: ultima } = await sb.from("siso_inventario_contagens")
      .select("criado_em").eq("sessao_id", s.id).order("criado_em", { ascending: false }).limit(1).maybeSingle();
    const ultimaTs = ultima?.criado_em ?? s.iniciada_em;
    if (ultimaTs && ultimaTs < cutoff4h) {
      alertaIds.push(s.id);
      logger.warn("wms.inventario.recovery", "sessão sem atividade recente", { sessao_id: s.id, ultimaTs });
    }
  }

  // 2. Locks intra-sessão > 30min sem contagem
  const { data: locks } = await sb.from("siso_inventario_localizacoes")
    .select("id, sessao_id, localizacao_id, bloqueada_em, bloqueada_por")
    .eq("status", "em_contagem")
    .lt("bloqueada_em", cutoff30m);

  let locksLiberados = 0;
  for (const l of locks ?? []) {
    const { data: ultimaCont } = await sb.from("siso_inventario_contagens")
      .select("criado_em").eq("sessao_id", l.sessao_id).eq("localizacao_id", l.localizacao_id)
      .order("criado_em", { ascending: false }).limit(1).maybeSingle();
    const ts = ultimaCont?.criado_em ?? l.bloqueada_em;
    if (ts && ts < cutoff30m) {
      await sb.from("siso_inventario_localizacoes")
        .update({ bloqueada_por: null, bloqueada_em: null, status: "pendente" })
        .eq("id", l.id);
      locksLiberados++;
    }
  }

  return { sessoesAlerta: alertaIds, locksLiberados };
}
```

- [ ] **Step 2: Endpoint**

```typescript
// src/app/api/wms/inventario/cleanup/route.ts
import { NextRequest, NextResponse } from "next/server";
import { recoveryInventario } from "@/lib/wms/inventario-recovery";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(await recoveryInventario());
}
```

- [ ] **Step 3: Configurar cron**

Adicionar pg_cron job análogo ao do Plano 3, frequência 10 min pra locks e 4h pra sessões.

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/inventario-recovery.ts src/app/api/wms/inventario/cleanup/
git commit -m "feat(wms): recovery automático de sessões e locks órfãos"
```

---

### Task 12: Documentação

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/api-reference-complete.md`

- [ ] **Step 1: Atualizar docs**

Adicionar tabelas (`siso_inventario_*`), endpoints (`/api/wms/inventario/*`), e cron jobs novos.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md docs/api-reference-complete.md
git commit -m "docs(wms): documenta módulo de inventário"
```

---

## Critério de saída do Plano 4

### Critérios técnicos
- ✅ Sessão de cycle count com 1 operador funciona end-to-end (criar → iniciar → contar → aprovar → aplicar).
- ✅ Sessão completa com 4-6 operadores em paralelo: cada um conta sua área, supervisor vê progresso realtime.
- ✅ Anti-colisão impede 2 operadores na mesma localização.
- ✅ Modo blind oculta saldo esperado na UI do operador (default em sessões novas).
- ✅ Divergências > 2% ou > R$ 1.000 exigem aprovação manual (defaults aplicados).
- ✅ Cada bipe persiste imediatamente no DB (sem perda se aba fecha).
- ✅ Recovery libera locks órfãos.
- ✅ Métricas mostram acuracidade por operador e localização.
- ✅ Curva ABC populada via giro 30d.
- ✅ Documentação atualizada.

### Cenários funcionais de aceitação

1. **Cycle count solo:** criar sessão pra 1 localização (5 SKUs), iniciar (lock criado), contar 5 SKUs com scanner Code 128. Ver contagens aparecerem em tempo real no painel admin. Aprovar e aplicar — gera mov `inventario` no ledger.
2. **Inventário completo multi-operador:** criar sessão pra galpão inteiro com 4 áreas (4 operadores). Cada operador abre `/wms/inventario/[id]/contar` em sua máquina. Conta em paralelo. Painel admin mostra progresso global (X% concluído) atualizando em tempo real.
3. **Anti-colisão:** operador A pega localização "L1". Operador B tenta pegar a mesma — recebe erro "já está sendo contada". Pega outra, sem problema.
4. **Modo blind:** durante contagem, operador NÃO vê saldo esperado. Só após sessão fechar, divergências aparecem.
5. **Divergência fora de tolerância:** contagem 100, sistema espera 110 (diferença 10%). Vai pra `pendente`. Admin pode aprovar, rejeitar ou solicitar re-contagem (rodada 2).
6. **Recovery de lock órfão:** abre contagem, fecha aba sem finalizar. Após 30min cron libera o lock; outro operador pode pegar a mesma localização.
7. **Filtro curva A:** ao criar sessão de cycle count, filtrar "só localizações com produtos curva A". Ver lista reduzida pra ~20% das localizações.

**SLA:** sem prazo fixo.

**Próximo:** Plano 5 — só após seu OK explícito.
