# Mini-Swap Intra-Galpão Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Antes de iniciar uma wave de picking, rearranjar contábilmente o estoque das empresas no mesmo galpão pra consolidar cada SKU em 1 loc canônica via swap (zero dívida) + empréstimo (limitado ao planejado pelo roteamento).

**Architecture:** Algoritmo de planejamento puro em TypeScript (`src/lib/wms/mini-swap.ts`, testável com vitest) + RPC PL/pgSQL `wms_executar_mini_swap` que recebe plano jsonb, re-valida sob lock pessimista (`FOR UPDATE`) e aplica todas as movs numa transação atômica. Orchestrator TS chama RPC de dentro de `/api/separacao/iniciar` com graceful degradation (qualquer falha → wave continua sem otimização). Configurável on/off por galpão em `/wms/configuracoes/otimizacoes`.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Supabase (PostgreSQL + PL/pgSQL), vitest, tailwind. Spec: `docs/superpowers/specs/2026-05-14-mini-swap-intra-galpao-design.md`.

**Sub-projeto pendente após esta:** Cycle count oportunista — vai ficar trivial uma vez que mini-swap garante 1 loc canônica por (empresa, galpão, SKU) na hora do bipe.

---

## File Structure

| Arquivo | Responsabilidade | Status |
|---|---|---|
| `supabase/migrations/20260514_wms_mini_swap.sql` | Tabela config + RPC `wms_executar_mini_swap` + seed inicial | NOVO |
| `src/lib/wms/mini-swap-types.ts` | Tipos compartilhados (`PlanoMiniSwap`, `EstadoSnapshot`, `Demanda`) | NOVO |
| `src/lib/wms/mini-swap.ts` | Algoritmo puro `planejarMiniSwap()` + orchestrator `executarMiniSwap()` | NOVO |
| `src/lib/wms/mini-swap.test.ts` | Unit tests vitest do algoritmo (≥10 cenários) | NOVO |
| `src/app/api/separacao/iniciar/route.ts` | Adiciona chamada do `executarMiniSwap()` pós-transição | MODIFICAR |
| `src/app/api/wms/mini-swap/config/route.ts` | GET — lista config por galpão | NOVO |
| `src/app/api/wms/mini-swap/config/[galpaoId]/route.ts` | PATCH — toggle (admin) | NOVO |
| `src/app/api/wms/mini-swap/simular/route.ts` | POST — dry-run (chama só `planejarMiniSwap`, não executa) | NOVO |
| `src/app/wms/configuracoes/otimizacoes/page.tsx` | UI: tabela galpão × toggle | NOVO |
| `src/app/wms/configuracoes/page.tsx` | Adiciona link "Otimizações" | MODIFICAR |
| `src/components/pedido/observacoes-timeline.tsx` (ou similar) | Renderiza `mini_swap_executado` na timeline | MODIFICAR (mínimo) |
| `scripts/wms/stress-mini-swap.ts` | E2E em staging — valida algoritmo + atomicidade + concorrência | NOVO |
| `CLAUDE.md` | Atualiza Project Structure, Database Tables, Current Status | MODIFICAR |
| `docs/api-reference-complete.md` | 3 endpoints novos + mudança em `/api/separacao/iniciar` | MODIFICAR |
| `docs/database-schema.md` | Tabela `siso_wms_mini_swap_config` + RPC `wms_executar_mini_swap` | MODIFICAR |
| `docs/architecture-and-flows.md` | Diagrama do fluxo da wave + mini-swap | MODIFICAR |
| `erros-conhecidos.yaml` | (atualizar conforme erros forem descobertos) | MODIFICAR |

---

## Pre-flight (uma vez antes de começar)

- [ ] Cria worktree isolado pra essa feature (skill `superpowers:using-git-worktrees`)
- [ ] Confirma que branch base é `develop` (atual)
- [ ] Confirma `.env.local` aponta pra Supabase staging (`ehbxpbeijofxtsbezwxd`) NÃO produção
- [ ] Roda `npm install` se houver mudanças no lockfile
- [ ] Lê `docs/superpowers/specs/2026-05-14-mini-swap-intra-galpao-design.md` inteiro

---

## Task 1: Migration esqueleto

**Files:**
- Create: `supabase/migrations/20260514_wms_mini_swap.sql`

- [ ] **Step 1: Criar arquivo de migration com tabela + seed + RPC stub**

```sql
-- WMS Mini-Swap Intra-Galpão — schema de configuração + RPC stub
-- Spec: docs/superpowers/specs/2026-05-14-mini-swap-intra-galpao-design.md

BEGIN;

-- 1. Tabela de configuração por galpão
CREATE TABLE IF NOT EXISTS siso_wms_mini_swap_config (
  galpao_id      uuid PRIMARY KEY REFERENCES siso_galpoes(id) ON DELETE CASCADE,
  ativo          boolean NOT NULL DEFAULT true,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_por uuid REFERENCES siso_usuarios(id)
);

COMMENT ON TABLE siso_wms_mini_swap_config IS
  'Mini-swap intra-galpão: toggle on/off por galpão. Default ON pra galpões ativos no seed.';

-- 2. Seed: todos os galpões ativos
INSERT INTO siso_wms_mini_swap_config (galpao_id, ativo)
SELECT id, true FROM siso_galpoes WHERE ativo = true
ON CONFLICT (galpao_id) DO NOTHING;

-- 3. RPC stub — implementação real vem na Task 4
-- Recebe um plano jsonb pré-computado pelo TS, valida sob lock, aplica.
-- Stub retorna [] pra não quebrar quem chama (graceful degradation).
CREATE OR REPLACE FUNCTION wms_executar_mini_swap(
  p_plano       jsonb,
  p_pedido_ids  uuid[],
  p_galpao_id   uuid,
  p_usuario_id  uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  -- TODO Task 4: implementar algoritmo
  RETURN '[]'::jsonb;
END;
$$;

COMMENT ON FUNCTION wms_executar_mini_swap IS
  'Mini-swap intra-galpão: aplica plano pré-computado atomicamente sob lock pessimista. Retorna jsonb com movs criadas.';

COMMIT;
```

- [ ] **Step 2: Aplicar migration via Supabase MCP**

Carregue a tool `mcp__supabase__apply_migration` (`ToolSearch query="select:mcp__supabase__apply_migration"`) e aplique:

```
project_id: ehbxpbeijofxtsbezwxd
name: 20260514_wms_mini_swap
query: <conteúdo da migration acima>
```

Expected: `{ success: true }` ou similar.

- [ ] **Step 3: Verificar tabela criada**

```sql
SELECT galpao_id, ativo FROM siso_wms_mini_swap_config;
```

Via `mcp__supabase__execute_sql`. Expected: ≥1 row (galpões staging).

- [ ] **Step 4: Verificar RPC stub callable**

```sql
SELECT wms_executar_mini_swap(
  '[]'::jsonb,
  ARRAY[]::uuid[],
  (SELECT id FROM siso_galpoes WHERE ativo = true LIMIT 1)
);
```

Expected: `[]`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260514_wms_mini_swap.sql
git commit -m "feat(wms): migration mini-swap config + RPC stub"
```

---

## Task 2: Tipos compartilhados

**Files:**
- Create: `src/lib/wms/mini-swap-types.ts`

- [ ] **Step 1: Criar tipos**

```typescript
/**
 * Mini-swap intra-galpão — tipos compartilhados entre algoritmo, orchestrator e RPC.
 *
 * Spec: docs/superpowers/specs/2026-05-14-mini-swap-intra-galpao-design.md
 */

/** Saldo de uma empresa em uma loc específica de um galpão pra um SKU. */
export interface SaldoLinha {
  empresa_dona_id: string;
  localizacao_id: string;
  localizacao_codigo: string;
  saldo: number;
  reservado: number;
}

/** Snapshot de estoque do galpão pra um SKU específico. */
export interface EstadoEstoqueSku {
  produto_id: string;
  galpao_id: string;
  linhas: SaldoLinha[];
}

/** Demanda de picking de uma wave: empresa picadora precisa de qty_total do SKU. */
export interface Demanda {
  empresa_picadora_id: string;
  produto_id: string;
  qty_total: number;
  /**
   * Qty que outras empresas vão emprestar pra cobrir esse pedido (decisão do roteamento).
   * Mini-swap NÃO pode exceder esse valor na parte de empréstimo.
   */
  qty_emprestimo_planejada: number;
  /** IDs das reservas existentes (movs origem='reserva_pedido') que precisam ser canceladas/recriadas. */
  reservas_existentes_ids: string[];
}

/** Uma operação de swap par S+E entre 2 empresas em 1 loc. */
export interface OperacaoSwap {
  loc_id: string;
  empresa_origem_id: string;  // perde qty
  empresa_destino_id: string; // ganha qty
  qty: number;
}

/** Operação de empréstimo (re-cria reserva na nova loc consolidada). */
export interface OperacaoEmprestimo {
  loc_id: string;
  empresa_credora_id: string;
  empresa_devedora_id: string;
  qty: number;
}

/** Plano executado pra uma demanda específica. */
export interface PlanoDemanda {
  produto_id: string;
  empresa_picadora_id: string;
  loc_destino_id: string;
  loc_destino_codigo: string;
  qty_swap: number;
  qty_emprestimo: number;
  swaps: OperacaoSwap[];
  emprestimos: OperacaoEmprestimo[];
  reservas_a_cancelar: string[];
}

/** Plano completo da wave (vários SKUs). */
export interface PlanoMiniSwap {
  galpao_id: string;
  pedido_ids: string[];
  demandas_planejadas: PlanoDemanda[];
  /** SKUs que entraram na wave mas foram skipados (1 loc só, inviável, etc). */
  demandas_skipadas: Array<{ produto_id: string; motivo: string }>;
}
```

- [ ] **Step 2: Validar compilação**

```bash
npx tsc --noEmit src/lib/wms/mini-swap-types.ts
```

Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/mini-swap-types.ts
git commit -m "feat(wms): tipos do mini-swap intra-galpão"
```

---

## Task 3: Algoritmo puro — caso base (skip 1 loc)

**Files:**
- Create: `src/lib/wms/mini-swap.ts`
- Create: `src/lib/wms/mini-swap.test.ts`

**Use o skill `superpowers:test-driven-development`.**

- [ ] **Step 1: Escrever teste falhando — caso "1 loc só → skip"**

`src/lib/wms/mini-swap.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { planejarMiniSwap } from "./mini-swap";
import type { EstadoEstoqueSku, Demanda } from "./mini-swap-types";

describe("planejarMiniSwap — caso base", () => {
  it("skipa SKU quando empresa picadora já está em 1 loc só", () => {
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "PROD1",
        galpao_id: "GAL_CWB",
        linhas: [
          { empresa_dona_id: "NETAIR", localizacao_id: "LOC_A", localizacao_codigo: "A-03-02", saldo: 5, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LOC_C", localizacao_codigo: "C-05-04", saldo: 8, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [
      { empresa_picadora_id: "NETAIR", produto_id: "PROD1", qty_total: 5, qty_emprestimo_planejada: 0, reservas_existentes_ids: [] },
    ];

    const plano = planejarMiniSwap({ galpao_id: "GAL_CWB", pedido_ids: ["PED1"], estado, demandas });

    expect(plano.demandas_planejadas).toHaveLength(0);
    expect(plano.demandas_skipadas).toEqual([{ produto_id: "PROD1", motivo: "ja_consolidado" }]);
  });
});
```

- [ ] **Step 2: Rodar teste — confirmar falha**

```bash
npm run test -- src/lib/wms/mini-swap.test.ts
```

Expected: FAIL com erro de import (`mini-swap.ts` não existe).

- [ ] **Step 3: Implementar mínimo pra passar**

`src/lib/wms/mini-swap.ts`:

```typescript
import type { EstadoEstoqueSku, Demanda, PlanoMiniSwap } from "./mini-swap-types";

export interface PlanejarInput {
  galpao_id: string;
  pedido_ids: string[];
  estado: EstadoEstoqueSku[];
  demandas: Demanda[];
}

export function planejarMiniSwap(input: PlanejarInput): PlanoMiniSwap {
  const plano: PlanoMiniSwap = {
    galpao_id: input.galpao_id,
    pedido_ids: input.pedido_ids,
    demandas_planejadas: [],
    demandas_skipadas: [],
  };

  for (const demanda of input.demandas) {
    const estadoSku = input.estado.find((e) => e.produto_id === demanda.produto_id);
    if (!estadoSku) {
      plano.demandas_skipadas.push({ produto_id: demanda.produto_id, motivo: "sem_estado" });
      continue;
    }
    const locsPicadora = estadoSku.linhas.filter(
      (l) => l.empresa_dona_id === demanda.empresa_picadora_id && l.saldo > 0,
    );
    if (locsPicadora.length <= 1) {
      plano.demandas_skipadas.push({ produto_id: demanda.produto_id, motivo: "ja_consolidado" });
      continue;
    }
    // TODO Tasks seguintes: lógica de planejamento real
    plano.demandas_skipadas.push({ produto_id: demanda.produto_id, motivo: "nao_implementado_ainda" });
  }

  return plano;
}
```

- [ ] **Step 4: Rodar teste — confirmar passa**

```bash
npm run test -- src/lib/wms/mini-swap.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/mini-swap.ts src/lib/wms/mini-swap.test.ts
git commit -m "feat(wms): mini-swap algoritmo - caso base (skip 1 loc)"
```

---

## Task 4: Algoritmo — encontrar loc candidata + caso swap puro

**Files:**
- Modify: `src/lib/wms/mini-swap.ts`
- Modify: `src/lib/wms/mini-swap.test.ts`

- [ ] **Step 1: Adicionar teste — swap puro viável**

Adicionar ao `mini-swap.test.ts`:

```typescript
describe("planejarMiniSwap — swap puro", () => {
  it("planeja swap puro quando picadora tem contrapartida total nas outras locs", () => {
    // NetAir: 3 em A, 2 em B. NetParts: 5 em C. Demanda NetAir = 5 (zero empréstimo).
    // Esperado: swap 5 unidades — NetAir entrega 5 (3 em A + 2 em B), NetParts entrega 5 em C.
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "PROD1",
        galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 3, reservado: 0 },
          { empresa_dona_id: "NETAIR",   localizacao_id: "LB", localizacao_codigo: "B", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 5, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [
      { empresa_picadora_id: "NETAIR", produto_id: "PROD1", qty_total: 5, qty_emprestimo_planejada: 0, reservas_existentes_ids: [] },
    ];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });

    expect(plano.demandas_planejadas).toHaveLength(1);
    const d = plano.demandas_planejadas[0];
    expect(d.loc_destino_id).toBe("LC");
    expect(d.qty_swap).toBe(5);
    expect(d.qty_emprestimo).toBe(0);
    // 3 swaps S+E: A↔C (qty 3), B↔C (qty 2) — 1 op por loc origem da picadora + 1 op consolidado em LC
    // Operações: NetAir saída em A (3), NetAir saída em B (2), NetParts entrada em A (3), NetParts entrada em B (2),
    //            NetParts saída em C (5), NetAir entrada em C (5)
    // Modelo Operação: 1 swap = 1 par S+E. 3 swaps neste caso (A↔C×3, B↔C×2 — agrupados por loc)
    expect(d.swaps).toHaveLength(3);
    const totalSwap = d.swaps.reduce((s, op) => s + op.qty, 0);
    expect(totalSwap).toBe(5);
  });
});
```

> **Modelo de Operação:** vamos representar swap como uma lista de "movimentações de propriedade". Pra cada loc envolvida onde a picadora tinha saldo, uma op `{ loc, qty, empresa_origem=picadora, empresa_destino=F }`. Pra a loc destino, uma op `{ loc=destino, qty=qty_swap_total, empresa_origem=F, empresa_destino=picadora }`. No total: N+1 ops onde N = locs origem da picadora.

- [ ] **Step 2: Rodar teste — confirmar falha**

Expected: FAIL.

- [ ] **Step 3: Implementar lógica de planejamento de swap puro**

Substituir o bloco TODO em `planejarMiniSwap`:

```typescript
// ─── Encontrar contrapartida F: empresa com mais saldo em alguma loc do galpão ───
type Candidata = { loc_id: string; loc_codigo: string; empresa_id: string; saldo: number };
const candidatas: Candidata[] = estadoSku.linhas
  .filter((l) => l.empresa_dona_id !== demanda.empresa_picadora_id && l.saldo > 0)
  .map((l) => ({ loc_id: l.localizacao_id, loc_codigo: l.localizacao_codigo, empresa_id: l.empresa_dona_id, saldo: l.saldo }))
  .sort((a, b) => b.saldo - a.saldo);

const saldoPicadoraOutras = locsPicadora.reduce((s, l) => s + l.saldo, 0);

let escolhida: { loc_id: string; loc_codigo: string; F: string; qty_swap: number; qty_emp: number } | null = null;
for (const cand of candidatas) {
  // V1: 1 contrapartida F = a com mais saldo na loc cand. Outras na mesma loc são ignoradas.
  const qtySwapMax = Math.min(saldoPicadoraOutras, cand.saldo);
  const qtyEmpMax = Math.min(demanda.qty_emprestimo_planejada, cand.saldo - qtySwapMax);
  const capacidade = qtySwapMax + qtyEmpMax;
  if (capacidade >= demanda.qty_total) {
    // Resolve qty exata: prioriza minimizar empréstimo
    const qtySwap = Math.min(qtySwapMax, demanda.qty_total);
    const qtyEmp = demanda.qty_total - qtySwap;
    escolhida = { loc_id: cand.loc_id, loc_codigo: cand.loc_codigo, F: cand.empresa_id, qty_swap: qtySwap, qty_emp: qtyEmp };
    break;
  }
}

if (!escolhida) {
  plano.demandas_skipadas.push({ produto_id: demanda.produto_id, motivo: "nenhuma_loc_viavel" });
  continue;
}

// ─── Construir ops de swap (proporcional ao saldo da picadora em cada loc origem) ───
const swaps: OperacaoSwap[] = [];
let restante = escolhida.qty_swap;
for (let i = 0; i < locsPicadora.length; i++) {
  const linha = locsPicadora[i];
  const isUltima = i === locsPicadora.length - 1;
  const qtyDessaLoc = isUltima
    ? restante
    : Math.min(linha.saldo, Math.floor((escolhida!.qty_swap * linha.saldo) / saldoPicadoraOutras));
  if (qtyDessaLoc <= 0) continue;
  // Op: picadora saída na loc origem → F entrada na loc origem
  swaps.push({
    loc_id: linha.localizacao_id,
    empresa_origem_id: demanda.empresa_picadora_id,
    empresa_destino_id: escolhida.F,
    qty: qtyDessaLoc,
  });
  restante -= qtyDessaLoc;
}
// Op consolidada: F saída na loc destino → picadora entrada na loc destino
if (escolhida.qty_swap > 0) {
  swaps.push({
    loc_id: escolhida.loc_id,
    empresa_origem_id: escolhida.F,
    empresa_destino_id: demanda.empresa_picadora_id,
    qty: escolhida.qty_swap,
  });
}

const emprestimos: OperacaoEmprestimo[] = [];
if (escolhida.qty_emp > 0) {
  emprestimos.push({
    loc_id: escolhida.loc_id,
    empresa_credora_id: escolhida.F,
    empresa_devedora_id: demanda.empresa_picadora_id,
    qty: escolhida.qty_emp,
  });
}

plano.demandas_planejadas.push({
  produto_id: demanda.produto_id,
  empresa_picadora_id: demanda.empresa_picadora_id,
  loc_destino_id: escolhida.loc_id,
  loc_destino_codigo: escolhida.loc_codigo,
  qty_swap: escolhida.qty_swap,
  qty_emprestimo: escolhida.qty_emp,
  swaps,
  emprestimos,
  reservas_a_cancelar: demanda.reservas_existentes_ids,
});
```

Não esquecer adicionar imports:

```typescript
import type {
  EstadoEstoqueSku, Demanda, PlanoMiniSwap, PlanoDemanda,
  OperacaoSwap, OperacaoEmprestimo,
} from "./mini-swap-types";
```

- [ ] **Step 4: Rodar testes — confirmar todos passam**

```bash
npm run test -- src/lib/wms/mini-swap.test.ts
```

Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/mini-swap.ts src/lib/wms/mini-swap.test.ts
git commit -m "feat(wms): mini-swap algoritmo - swap puro com contrapartida total"
```

---

## Task 5: Algoritmo — caso híbrido + casos inviáveis

**Files:**
- Modify: `src/lib/wms/mini-swap.test.ts`

- [ ] **Step 1: Adicionar 4 testes**

```typescript
describe("planejarMiniSwap — híbrido swap+empréstimo", () => {
  it("usa swap parcial + empréstimo quando picadora não tem contrapartida total", () => {
    // NetAir: 2 em A, 1 em B. NetParts: 5 em C. Demanda NetAir = 5, empréstimo planejado = 2.
    // Picadora tem contrapartida 3 (2+1). Cobertura: swap 3 + empréstimo 2 = 5 ✅
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "P1", galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETAIR",   localizacao_id: "LB", localizacao_codigo: "B", saldo: 1, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 5, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [{ empresa_picadora_id: "NETAIR", produto_id: "P1", qty_total: 5, qty_emprestimo_planejada: 2, reservas_existentes_ids: ["R1"] }];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });
    const d = plano.demandas_planejadas[0];
    expect(d.loc_destino_id).toBe("LC");
    expect(d.qty_swap).toBe(3);
    expect(d.qty_emprestimo).toBe(2);
    expect(d.emprestimos[0].qty).toBe(2);
    expect(d.reservas_a_cancelar).toEqual(["R1"]);
  });

  it("NÃO excede qty_emprestimo_planejada do roteamento", () => {
    // Cenário onde algoritmo poderia teoricamente pedir mais empréstimo, mas DEVE respeitar o limite.
    // NetAir: 1 em A. NetParts: 10 em C. Demanda NetAir = 5, empréstimo planejado = 2.
    // Sem mini-swap: picadora cobre 1 + empréstimo 2 = 3 (insuficiente!) — esse cenário não deveria existir
    // Isso significa que o roteamento errou — mini-swap NÃO conserta isso, skipa.
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "P1", galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 1, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 10, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [{ empresa_picadora_id: "NETAIR", produto_id: "P1", qty_total: 5, qty_emprestimo_planejada: 2, reservas_existentes_ids: [] }];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });
    expect(plano.demandas_planejadas).toHaveLength(0);
    expect(plano.demandas_skipadas[0].motivo).toBe("ja_consolidado");
    // (já está em 1 loc só — picadora tem só LA)
  });
});

describe("planejarMiniSwap — casos inviáveis", () => {
  it("skipa quando nenhuma loc cabe Q total via swap+empréstimo", () => {
    // NetAir: 2 em A, 2 em B. NetParts: 3 em C. Demanda 5, empréstimo planejado = 1.
    // Capacidade em C: swap_max=min(4, 3)=3 + emp_max=min(1, 3-3)=0 = 3 < 5 ✗
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "P1", galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETAIR",   localizacao_id: "LB", localizacao_codigo: "B", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 3, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [{ empresa_picadora_id: "NETAIR", produto_id: "P1", qty_total: 5, qty_emprestimo_planejada: 1, reservas_existentes_ids: [] }];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });
    expect(plano.demandas_planejadas).toHaveLength(0);
    expect(plano.demandas_skipadas[0].motivo).toBe("nenhuma_loc_viavel");
  });

  it("escolhe a loc candidata com maior capacidade quando há múltiplas viáveis", () => {
    // NetAir: 3 em A, 2 em B. NetParts: 5 em C. Multi: 5 em D.
    // Ambas C e D viáveis. Algoritmo prefere por maior saldo (ordem decrescente) → C primeiro.
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "P1", galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 3, reservado: 0 },
          { empresa_dona_id: "NETAIR",   localizacao_id: "LB", localizacao_codigo: "B", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 5, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LD", localizacao_codigo: "D", saldo: 6, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [{ empresa_picadora_id: "NETAIR", produto_id: "P1", qty_total: 5, qty_emprestimo_planejada: 0, reservas_existentes_ids: [] }];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });
    expect(plano.demandas_planejadas[0].loc_destino_id).toBe("LD"); // maior saldo (6)
  });
});
```

- [ ] **Step 2: Rodar testes — devem passar (algoritmo já cobre esses casos)**

```bash
npm run test -- src/lib/wms/mini-swap.test.ts
```

Expected: 5 PASS.

> Se algum falhar, ajustar algoritmo até passar. Não pular.

- [ ] **Step 3: Adicionar teste de conservação de saldo**

```typescript
describe("planejarMiniSwap — invariantes", () => {
  it("preserva saldo total por empresa após executar plano (simulação)", () => {
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "P1", galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETAIR",   localizacao_id: "LB", localizacao_codigo: "B", saldo: 1, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 5, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [{ empresa_picadora_id: "NETAIR", produto_id: "P1", qty_total: 5, qty_emprestimo_planejada: 2, reservas_existentes_ids: [] }];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });
    const d = plano.demandas_planejadas[0];

    // Simular aplicação dos swaps: cada op é S na origem + E no destino, qtys iguais
    const saldosFinais = new Map<string, number>();
    for (const linha of estado[0].linhas) {
      saldosFinais.set(linha.empresa_dona_id, (saldosFinais.get(linha.empresa_dona_id) ?? 0) + linha.saldo);
    }
    // Aplicar swaps: empresa_origem -qty, empresa_destino +qty (PURO swap, não conta empréstimo)
    for (const op of d.swaps) {
      saldosFinais.set(op.empresa_origem_id, saldosFinais.get(op.empresa_origem_id)! - op.qty);
      saldosFinais.set(op.empresa_destino_id, saldosFinais.get(op.empresa_destino_id)! + op.qty);
    }
    // Conservação: NetAir e NetParts mantêm saldo total
    expect(saldosFinais.get("NETAIR")).toBe(3); // 2+1+0
    expect(saldosFinais.get("NETPARTS")).toBe(5); // só na C
  });
});
```

- [ ] **Step 4: Rodar — confirmar passa**

Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/mini-swap.test.ts
git commit -m "test(wms): mini-swap - cenários híbrido, inviável, prefere maior saldo, conservação"
```

---

## Task 6: RPC PL/pgSQL `wms_executar_mini_swap` (real)

**Files:**
- Create: `supabase/migrations/20260514_wms_mini_swap_rpc.sql`

> Migration separada pra deixar o algoritmo isolado da Task 1 (que era só esqueleto).

- [ ] **Step 1: Escrever RPC que recebe plano jsonb, valida sob lock, aplica**

```sql
-- WMS Mini-Swap — implementação real do RPC executar
-- Recebe plano pré-computado pelo TS, re-valida sob lock pessimista, aplica.

BEGIN;

CREATE OR REPLACE FUNCTION wms_executar_mini_swap(
  p_plano       jsonb,
  p_pedido_ids  uuid[],
  p_galpao_id   uuid,
  p_usuario_id  uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_demanda      jsonb;
  v_swap_op      jsonb;
  v_emp_op       jsonb;
  v_reserva_id   uuid;
  v_executado    jsonb := '[]'::jsonb;
  v_demanda_exec jsonb;
  v_movs         jsonb;
  v_mov          jsonb;
  v_saldo_check  numeric;
  v_reservado_check numeric;
  v_reserva_mov  siso_movimentacoes;
  v_mov_sai      siso_movimentacoes;
  v_mov_ent      siso_movimentacoes;
  v_mov_estorno  siso_movimentacoes;
  v_produto      uuid;
BEGIN
  IF p_plano IS NULL OR jsonb_typeof(p_plano) <> 'object' THEN
    RAISE EXCEPTION 'p_plano deve ser jsonb object';
  END IF;
  IF NOT (p_plano ? 'demandas_planejadas') THEN
    RETURN '[]'::jsonb;
  END IF;

  -- Lock pessimista: trava todas as rows de siso_estoque do galpão pros SKUs do plano
  PERFORM 1 FROM siso_estoque
  WHERE galpao_id = p_galpao_id
    AND produto_id IN (
      SELECT DISTINCT (d->>'produto_id')::uuid
      FROM jsonb_array_elements(p_plano->'demandas_planejadas') d
    )
  FOR UPDATE;

  -- Itera sobre cada demanda planejada
  FOR v_demanda IN SELECT * FROM jsonb_array_elements(p_plano->'demandas_planejadas')
  LOOP
    v_produto := (v_demanda->>'produto_id')::uuid;
    v_movs := '[]'::jsonb;

    -- 1. Cancela reservas existentes (mov L = liberacao_reserva)
    FOR v_reserva_id IN SELECT (jsonb_array_elements_text(v_demanda->'reservas_a_cancelar'))::uuid
    LOOP
      SELECT * INTO v_reserva_mov FROM siso_movimentacoes WHERE id = v_reserva_id;
      IF v_reserva_mov IS NULL THEN CONTINUE; END IF;
      -- Defesa: já estornada?
      PERFORM 1 FROM siso_movimentacoes WHERE estorno_de = v_reserva_id;
      IF FOUND THEN CONTINUE; END IF;

      v_mov_estorno := wms_inserir_movimentacao(
        v_reserva_mov.produto_id, v_reserva_mov.empresa_dona_id,
        v_reserva_mov.galpao_id, v_reserva_mov.localizacao_id,
        'L', v_reserva_mov.quantidade,
        'liberacao_reserva', v_reserva_mov.origem_id,
        jsonb_build_object('motivo', 'mini_swap_relocate'),
        NULL, NULL, NULL, NULL,
        p_usuario_id, 'cancelada por mini-swap', v_reserva_id
      );
      v_movs := v_movs || jsonb_build_object('tipo', 'L', 'mov_id', v_mov_estorno.id);
    END LOOP;

    -- 2. Executa swaps (cada op = par S+E entre 2 empresas na mesma loc)
    FOR v_swap_op IN SELECT * FROM jsonb_array_elements(v_demanda->'swaps')
    LOOP
      -- S na origem
      v_mov_sai := wms_inserir_movimentacao(
        v_produto,
        (v_swap_op->>'empresa_origem_id')::uuid,
        p_galpao_id,
        (v_swap_op->>'loc_id')::uuid,
        'S', (v_swap_op->>'qty')::numeric,
        'swap', NULL,
        jsonb_build_object('etapa', 'saida', 'mini_swap', true),
        NULL, NULL, NULL, NULL,
        p_usuario_id, 'mini-swap', NULL
      );
      -- E no destino (mesma loc, empresa diferente)
      v_mov_ent := wms_inserir_movimentacao(
        v_produto,
        (v_swap_op->>'empresa_destino_id')::uuid,
        p_galpao_id,
        (v_swap_op->>'loc_id')::uuid,
        'E', (v_swap_op->>'qty')::numeric,
        'swap', NULL,
        jsonb_build_object('etapa', 'entrada', 'mini_swap', true, 'par_de', v_mov_sai.id),
        NULL, NULL, NULL, NULL,
        p_usuario_id, 'mini-swap', NULL
      );
      v_movs := v_movs || jsonb_build_object('tipo', 'swap_pair', 'mov_s', v_mov_sai.id, 'mov_e', v_mov_ent.id);
    END LOOP;

    -- 3. Recria reservas de empréstimo na nova loc consolidada
    FOR v_emp_op IN SELECT * FROM jsonb_array_elements(v_demanda->'emprestimos')
    LOOP
      v_mov_ent := wms_inserir_movimentacao(
        v_produto,
        (v_emp_op->>'empresa_credora_id')::uuid,
        p_galpao_id,
        (v_emp_op->>'loc_id')::uuid,
        'R', (v_emp_op->>'qty')::numeric,
        'reserva_pedido',
        (SELECT pedido_id FROM siso_pedidos WHERE id = ANY(p_pedido_ids) LIMIT 1)::text,
        jsonb_build_object('mini_swap', true, 'devedora', v_emp_op->>'empresa_devedora_id'),
        (v_emp_op->>'empresa_devedora_id')::uuid,
        (now() + interval '48 hours')::timestamptz,
        NULL, NULL,
        p_usuario_id, 'reserva recriada por mini-swap', NULL
      );
      v_movs := v_movs || jsonb_build_object('tipo', 'R_recriada', 'mov_id', v_mov_ent.id);
    END LOOP;

    v_demanda_exec := jsonb_build_object(
      'produto_id', v_produto,
      'loc_destino_id', v_demanda->'loc_destino_id',
      'qty_swap', v_demanda->'qty_swap',
      'qty_emprestimo', v_demanda->'qty_emprestimo',
      'movs', v_movs
    );
    v_executado := v_executado || jsonb_build_array(v_demanda_exec);
  END LOOP;

  RETURN v_executado;
END;
$$;

COMMIT;
```

> Atenção: a assinatura de `wms_inserir_movimentacao` precisa bater com a do projeto. **Antes de aplicar**, abra `supabase/migrations/` e procure a definição mais recente (`grep -r "CREATE OR REPLACE FUNCTION wms_inserir_movimentacao" supabase/migrations/`) — ajustar a chamada acima se a ordem dos parâmetros divergir.

- [ ] **Step 2: Aplicar migration via `mcp__supabase__apply_migration`**

Name: `20260514_wms_mini_swap_rpc`. Espera sucesso.

- [ ] **Step 3: Smoke test direto da RPC com plano fake**

Via `mcp__supabase__execute_sql`:

```sql
-- Plano vazio: deve retornar []
SELECT wms_executar_mini_swap('{"demandas_planejadas":[]}'::jsonb, ARRAY[]::uuid[], (SELECT id FROM siso_galpoes LIMIT 1));
```

Expected: `[]`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260514_wms_mini_swap_rpc.sql
git commit -m "feat(wms): RPC wms_executar_mini_swap - aplica plano sob lock pessimista"
```

---

## Task 7: Orchestrator TS — `executarMiniSwap()` que liga algoritmo + RPC

**Files:**
- Modify: `src/lib/wms/mini-swap.ts`

- [ ] **Step 1: Adicionar função orchestrator que lê estado, planeja, chama RPC**

Append em `src/lib/wms/mini-swap.ts`:

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

export interface ExecutarInput {
  pedido_ids: string[];
  galpao_id: string;
  usuario_id?: string;
}

export interface ExecutarResultado {
  ok: boolean;
  plano: PlanoMiniSwap;
  executado: unknown[];
  motivo_falha?: string;
}

/**
 * Lê estado de estoque + reservas + decisões do roteamento, computa plano via
 * `planejarMiniSwap`, chama RPC `wms_executar_mini_swap` pra aplicar atomicamente.
 *
 * Graceful: qualquer erro retorna `{ ok: false, plano: vazio }` SEM lançar.
 * Caller deve continuar fluxo normal.
 */
export async function executarMiniSwap(input: ExecutarInput): Promise<ExecutarResultado> {
  const sb = createServiceClient();

  try {
    // 1. Buscar itens dos pedidos da wave (qty agregada por empresa+sku)
    const { data: itens, error: errItens } = await sb
      .from("siso_pedido_itens")
      .select("pedido_id, produto_id, quantidade, pedido:siso_pedidos!inner(empresa_origem_id)")
      .in("pedido_id", input.pedido_ids);
    if (errItens) throw errItens;

    type Aggregate = { empresa_picadora_id: string; produto_id: string; qty_total: number };
    const aggMap = new Map<string, Aggregate>();
    for (const it of (itens ?? []) as unknown as Array<{
      produto_id: string;
      quantidade: number;
      pedido: { empresa_origem_id: string };
    }>) {
      const key = `${it.pedido.empresa_origem_id}::${it.produto_id}`;
      const existing = aggMap.get(key);
      if (existing) {
        existing.qty_total += Number(it.quantidade);
      } else {
        aggMap.set(key, {
          empresa_picadora_id: it.pedido.empresa_origem_id,
          produto_id: it.produto_id,
          qty_total: Number(it.quantidade),
        });
      }
    }

    if (aggMap.size === 0) {
      return { ok: true, plano: { galpao_id: input.galpao_id, pedido_ids: input.pedido_ids, demandas_planejadas: [], demandas_skipadas: [] }, executado: [] };
    }

    const produtoIds = [...new Set([...aggMap.values()].map((a) => a.produto_id))];

    // 2. Buscar saldo atual de cada SKU no galpão
    const { data: estoqueRows, error: errEstoque } = await sb
      .from("siso_estoque")
      .select("produto_id, empresa_dona_id, localizacao_id, saldo, reservado, localizacao:siso_localizacoes!inner(codigo)")
      .eq("galpao_id", input.galpao_id)
      .in("produto_id", produtoIds);
    if (errEstoque) throw errEstoque;

    const estado: EstadoEstoqueSku[] = produtoIds.map((pid) => ({
      produto_id: pid,
      galpao_id: input.galpao_id,
      linhas: ((estoqueRows ?? []) as unknown as Array<{
        produto_id: string; empresa_dona_id: string; localizacao_id: string;
        saldo: number; reservado: number; localizacao: { codigo: string };
      }>)
        .filter((r) => r.produto_id === pid)
        .map((r) => ({
          empresa_dona_id: r.empresa_dona_id,
          localizacao_id: r.localizacao_id,
          localizacao_codigo: r.localizacao.codigo,
          saldo: Number(r.saldo),
          reservado: Number(r.reservado),
        })),
    }));

    // 3. Buscar reservas existentes + qty empréstimo planejada por demanda
    const demandas: Demanda[] = [];
    for (const agg of aggMap.values()) {
      const { data: reservas } = await sb
        .from("siso_movimentacoes")
        .select("id, quantidade, empresa_dona_id")
        .in("origem_id", input.pedido_ids)
        .eq("origem_tipo", "reserva_pedido")
        .eq("tipo", "R")
        .eq("produto_id", agg.produto_id);

      // qty_emprestimo_planejada = soma das reservas onde empresa_dona ≠ picadora
      let qtyEmp = 0;
      const reservasIds: string[] = [];
      for (const r of (reservas ?? []) as Array<{ id: string; quantidade: number; empresa_dona_id: string }>) {
        // Filtra apenas reservas não-estornadas
        const { data: estornoExiste } = await sb
          .from("siso_movimentacoes")
          .select("id")
          .eq("estorno_de", r.id)
          .maybeSingle();
        if (estornoExiste) continue;

        if (r.empresa_dona_id !== agg.empresa_picadora_id) {
          qtyEmp += Number(r.quantidade);
        }
        reservasIds.push(r.id);
      }

      demandas.push({
        empresa_picadora_id: agg.empresa_picadora_id,
        produto_id: agg.produto_id,
        qty_total: agg.qty_total,
        qty_emprestimo_planejada: qtyEmp,
        reservas_existentes_ids: reservasIds,
      });
    }

    // 4. Computa plano puro
    const plano = planejarMiniSwap({
      galpao_id: input.galpao_id,
      pedido_ids: input.pedido_ids,
      estado,
      demandas,
    });

    if (plano.demandas_planejadas.length === 0) {
      return { ok: true, plano, executado: [] };
    }

    // 5. Chama RPC pra aplicar atomicamente
    const { data: executado, error: errRpc } = await sb.rpc("wms_executar_mini_swap", {
      p_plano: plano as unknown as object,
      p_pedido_ids: input.pedido_ids,
      p_galpao_id: input.galpao_id,
      p_usuario_id: input.usuario_id ?? null,
    });
    if (errRpc) throw errRpc;

    return { ok: true, plano, executado: (executado as unknown[]) ?? [] };
  } catch (err) {
    logger.logError({
      source: "wms.mini-swap",
      message: "executarMiniSwap falhou — wave segue sem otimização",
      category: "database",
      error: err,
      metadata: { pedido_ids: input.pedido_ids, galpao_id: input.galpao_id },
    });
    return {
      ok: false,
      plano: { galpao_id: input.galpao_id, pedido_ids: input.pedido_ids, demandas_planejadas: [], demandas_skipadas: [] },
      executado: [],
      motivo_falha: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 2: Validar TypeScript compila**

```bash
npx tsc --noEmit
```

Expected: sem erros relacionados a `mini-swap.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/mini-swap.ts
git commit -m "feat(wms): orchestrator executarMiniSwap - lê estado + planeja + chama RPC"
```

---

## Task 8: Endpoint config GET + PATCH

**Files:**
- Create: `src/app/api/wms/mini-swap/config/route.ts`
- Create: `src/app/api/wms/mini-swap/config/[galpaoId]/route.ts`

- [ ] **Step 1: Criar GET /api/wms/mini-swap/config**

`src/app/api/wms/mini-swap/config/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/wms/mini-swap/config
 * Lista config de mini-swap pra todos os galpões.
 * Headers: X-Session-Id
 * Retorno: [{ galpao_id, galpao_nome, ativo, atualizado_em, atualizado_por_nome }]
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_wms_mini_swap_config")
    .select("galpao_id, ativo, atualizado_em, galpao:siso_galpoes!inner(nome), usuario:siso_usuarios(nome)")
    .order("atualizado_em", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = { galpao_id: string; ativo: boolean; atualizado_em: string; galpao: { nome: string }; usuario: { nome: string } | null };
  const result = (data as unknown as Row[]).map((r) => ({
    galpao_id: r.galpao_id,
    galpao_nome: r.galpao.nome,
    ativo: r.ativo,
    atualizado_em: r.atualizado_em,
    atualizado_por_nome: r.usuario?.nome ?? null,
  }));
  return NextResponse.json(result);
}
```

- [ ] **Step 2: Criar PATCH /api/wms/mini-swap/config/[galpaoId]**

`src/app/api/wms/mini-swap/config/[galpaoId]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ galpaoId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (session.cargo !== "admin") return NextResponse.json({ error: "apenas admin" }, { status: 403 });

  const { galpaoId } = await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.ativo !== "boolean") {
    return NextResponse.json({ error: "campo 'ativo' (boolean) obrigatório" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { error } = await sb
    .from("siso_wms_mini_swap_config")
    .upsert({
      galpao_id: galpaoId,
      ativo: body.ativo,
      atualizado_em: new Date().toISOString(),
      atualizado_por: session.id,
    });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Smoke test via curl**

```bash
# Pegue session ID válido em localStorage do navegador
SESSION="<session-id>"
curl -s -H "X-Session-Id: $SESSION" http://localhost:3000/api/wms/mini-swap/config | jq
```

Expected: array com galpões + ativo true.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/mini-swap/config/
git commit -m "feat(wms): endpoints GET/PATCH config mini-swap por galpão"
```

---

## Task 9: Endpoint simular (dry-run)

**Files:**
- Create: `src/app/api/wms/mini-swap/simular/route.ts`

- [ ] **Step 1: Criar POST simular**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import { planejarMiniSwap } from "@/lib/wms/mini-swap";
import type { EstadoEstoqueSku, Demanda } from "@/lib/wms/mini-swap-types";

/**
 * POST /api/wms/mini-swap/simular
 * Body: { pedido_ids: string[], galpao_id: string }
 * Dry-run: roda apenas o planejador, NÃO chama a RPC. Útil pra debug.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.pedido_ids) || typeof body?.galpao_id !== "string") {
    return NextResponse.json({ error: "pedido_ids[] e galpao_id obrigatórios" }, { status: 400 });
  }

  // Reaproveita a lógica de leitura do orchestrator: extraímos via re-export ou copiamos
  // Pra simplicidade da v1, copiamos lookup mínimo aqui (refactor futuro)
  const sb = createServiceClient();

  const { data: itens } = await sb
    .from("siso_pedido_itens")
    .select("produto_id, quantidade, pedido:siso_pedidos!inner(empresa_origem_id)")
    .in("pedido_id", body.pedido_ids);

  type ItemRow = { produto_id: string; quantidade: number; pedido: { empresa_origem_id: string } };
  const aggMap = new Map<string, { empresa_picadora_id: string; produto_id: string; qty_total: number }>();
  for (const it of (itens ?? []) as unknown as ItemRow[]) {
    const key = `${it.pedido.empresa_origem_id}::${it.produto_id}`;
    const existing = aggMap.get(key);
    if (existing) existing.qty_total += Number(it.quantidade);
    else aggMap.set(key, {
      empresa_picadora_id: it.pedido.empresa_origem_id,
      produto_id: it.produto_id,
      qty_total: Number(it.quantidade),
    });
  }

  const produtoIds = [...new Set([...aggMap.values()].map((a) => a.produto_id))];
  const { data: estoqueRows } = await sb
    .from("siso_estoque")
    .select("produto_id, empresa_dona_id, localizacao_id, saldo, reservado, localizacao:siso_localizacoes!inner(codigo)")
    .eq("galpao_id", body.galpao_id)
    .in("produto_id", produtoIds);

  type EstoqueRow = { produto_id: string; empresa_dona_id: string; localizacao_id: string; saldo: number; reservado: number; localizacao: { codigo: string } };
  const estado: EstadoEstoqueSku[] = produtoIds.map((pid) => ({
    produto_id: pid,
    galpao_id: body.galpao_id,
    linhas: ((estoqueRows ?? []) as unknown as EstoqueRow[])
      .filter((r) => r.produto_id === pid)
      .map((r) => ({
        empresa_dona_id: r.empresa_dona_id,
        localizacao_id: r.localizacao_id,
        localizacao_codigo: r.localizacao.codigo,
        saldo: Number(r.saldo),
        reservado: Number(r.reservado),
      })),
  }));

  const demandas: Demanda[] = [...aggMap.values()].map((a) => ({
    empresa_picadora_id: a.empresa_picadora_id,
    produto_id: a.produto_id,
    qty_total: a.qty_total,
    qty_emprestimo_planejada: 0, // dry-run não busca reservas reais — assume 0
    reservas_existentes_ids: [],
  }));

  const plano = planejarMiniSwap({
    galpao_id: body.galpao_id,
    pedido_ids: body.pedido_ids,
    estado,
    demandas,
  });

  return NextResponse.json({ plano });
}
```

- [ ] **Step 2: Smoke test**

```bash
curl -s -X POST -H "X-Session-Id: $SESSION" -H "Content-Type: application/json" \
  -d '{"pedido_ids":["<id-real>"],"galpao_id":"<gal-id>"}' \
  http://localhost:3000/api/wms/mini-swap/simular | jq
```

Expected: objeto `{ plano: { ... } }`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/mini-swap/simular/
git commit -m "feat(wms): endpoint dry-run /simular - planeja sem aplicar"
```

---

## Task 10: Mudança em /api/separacao/iniciar

**Files:**
- Modify: `src/app/api/separacao/iniciar/route.ts`

- [ ] **Step 1: Localizar o ponto exato pra inserir**

```bash
grep -n "em_separacao" src/app/api/separacao/iniciar/route.ts
```

Procurar o `await supabase.from("siso_pedidos").update(...)` que faz a transição. O mini-swap entra **logo após** esse update e **antes** do build da checklist.

- [ ] **Step 2: Adicionar imports + chamada do mini-swap**

No topo do arquivo, adicionar:

```typescript
import { executarMiniSwap } from "@/lib/wms/mini-swap";
```

Logo após o `update` que transiciona pra `em_separacao`, adicionar (substitua `<linha exata>` pelo lugar identificado no Step 1):

```typescript
// ─── NOVO: mini-swap intra-galpão (opt-in por galpão) ───
try {
  const { data: cfg } = await supabase
    .from("siso_wms_mini_swap_config")
    .select("ativo")
    .eq("galpao_id", session.galpaoId)
    .maybeSingle();

  if (cfg?.ativo) {
    const resultado = await executarMiniSwap({
      pedido_ids,
      galpao_id: session.galpaoId,
      usuario_id: session.id,
    });

    if (resultado.ok && resultado.plano.demandas_planejadas.length > 0) {
      const eventos = pedido_ids.map((pid) => ({
        pedido_id: pid,
        evento: "mini_swap_executado",
        detalhes: {
          demandas: resultado.plano.demandas_planejadas.map((d) => ({
            produto_id: d.produto_id,
            loc_destino_codigo: d.loc_destino_codigo,
            qty_swap: d.qty_swap,
            qty_emprestimo: d.qty_emprestimo,
          })),
        },
        usuario_id: session.id,
      }));
      await registrarEventos(eventos).catch(() => { /* fire-and-forget */ });
    }
  }
} catch (err) {
  logger.logError({
    source: "separacao-iniciar.mini-swap",
    message: "Falha não-fatal no mini-swap — wave segue sem otimização",
    category: "infrastructure",
    error: err,
    metadata: { pedido_ids, galpao_id: session.galpaoId },
  });
  // Continua o fluxo — wave NUNCA trava por mini-swap
}
// ─── FIM mini-swap ───
```

- [ ] **Step 3: Verificar TypeScript compila**

```bash
npx tsc --noEmit
```

Expected: sem erros.

- [ ] **Step 4: Smoke test manual em dev**

```bash
npm run dev
```

Iniciar uma wave pelo `/separacao` UI com pedido real. Validar:
- Wave inicia (não trava)
- Se mini-swap rodar, log no console mostra
- Se tabela tiver `ativo=false` pro galpão, mini-swap pula

- [ ] **Step 5: Commit**

```bash
git add src/app/api/separacao/iniciar/route.ts
git commit -m "feat(separacao): integra mini-swap no início da wave (opt-in por galpão)"
```

---

## Task 11: Página /wms/configuracoes/otimizacoes

**Files:**
- Create: `src/app/wms/configuracoes/otimizacoes/page.tsx`
- Modify: `src/app/wms/configuracoes/page.tsx` (adicionar link)

- [ ] **Step 1: Criar página com toggle por galpão**

`src/app/wms/configuracoes/otimizacoes/page.tsx`:

```typescript
"use client";

import { useState, useEffect } from "react";
import { sisoFetch, useAuth } from "@/lib/auth-context";
import { toast } from "sonner";

interface ConfigRow {
  galpao_id: string;
  galpao_nome: string;
  ativo: boolean;
  atualizado_em: string;
  atualizado_por_nome: string | null;
}

export default function MiniSwapConfigPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    sisoFetch("/api/wms/mini-swap/config")
      .then((r) => r.json())
      .then((data: ConfigRow[]) => {
        setRows(data);
        setLoading(false);
      });
  }, []);

  async function toggleAtivo(galpaoId: string, novoValor: boolean) {
    if (user?.cargo !== "admin") {
      toast.error("Apenas admin pode alterar");
      return;
    }
    setSaving(galpaoId);
    const res = await sisoFetch(`/api/wms/mini-swap/config/${galpaoId}`, {
      method: "PATCH",
      body: JSON.stringify({ ativo: novoValor }),
    });
    if (res.ok) {
      setRows((prev) => prev.map((r) =>
        r.galpao_id === galpaoId
          ? { ...r, ativo: novoValor, atualizado_em: new Date().toISOString(), atualizado_por_nome: user.nome }
          : r,
      ));
      toast.success(`Mini-swap ${novoValor ? "ativado" : "desativado"}`);
    } else {
      toast.error("Falha ao salvar");
    }
    setSaving(null);
  }

  if (loading) return <div className="p-6 text-zinc-500">Carregando...</div>;

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-2">Otimizações de WMS</h1>
      <p className="text-zinc-600 text-sm mb-6">
        Mini-swap intra-galpão consolida produtos com múltiplas locs em 1 loc canônica antes da wave começar.
        Sem custo contábil. Liga/desliga por galpão.
      </p>

      <div className="border border-zinc-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50">
            <tr>
              <th className="text-left p-3">Galpão</th>
              <th className="text-left p-3">Mini-swap</th>
              <th className="text-left p-3">Última alteração</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.galpao_id} className="border-t border-zinc-200">
                <td className="p-3 font-medium">{r.galpao_nome}</td>
                <td className="p-3">
                  <button
                    type="button"
                    onClick={() => toggleAtivo(r.galpao_id, !r.ativo)}
                    disabled={saving === r.galpao_id || user?.cargo !== "admin"}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${r.ativo ? "bg-teal-600" : "bg-zinc-300"} disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${r.ativo ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                  <span className="ml-3 text-xs text-zinc-500">{r.ativo ? "Ativo" : "Inativo"}</span>
                </td>
                <td className="p-3 text-zinc-600 text-xs">
                  {new Date(r.atualizado_em).toLocaleString("pt-BR")}
                  {r.atualizado_por_nome && ` por ${r.atualizado_por_nome}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Adicionar link em /wms/configuracoes**

Editar `src/app/wms/configuracoes/page.tsx` — adicionar um card/link novo apontando pra `/wms/configuracoes/otimizacoes`. Use o padrão existente da página (cards de aba ou links). Texto sugerido: "Otimizações — mini-swap, cycle count futuro".

- [ ] **Step 3: Smoke test no navegador**

Acessar `/wms/configuracoes/otimizacoes`. Validar:
- Lista galpões com toggle
- Admin consegue ativar/desativar; operador vê tudo mas botão desabilitado
- Toast de sucesso ao mudar

- [ ] **Step 4: Commit**

```bash
git add src/app/wms/configuracoes/
git commit -m "feat(wms): página configuração mini-swap por galpão"
```

---

## Task 12: Linha de timeline `mini_swap_executado` em /pedidos/[id]

**Files:**
- Modify: arquivo do componente que renderiza a timeline. Procurar:

```bash
grep -rn "siso_pedido_historico\|evento\|historico" src/components/pedido/ | head -20
```

- [ ] **Step 1: Localizar componente de timeline**

Provavelmente `src/components/pedido/observacoes-timeline.tsx` ou similar. Identificar onde os eventos são renderizados (switch/case ou map por `evento`).

- [ ] **Step 2: Adicionar case pra `mini_swap_executado`**

Adicionar bloco que renderize:

```tsx
case "mini_swap_executado": {
  const detalhes = ev.detalhes as { demandas?: Array<{ produto_id: string; loc_destino_codigo: string; qty_swap: number; qty_emprestimo: number }> } | undefined;
  const demandas = detalhes?.demandas ?? [];
  return (
    <div className="text-sm">
      <div className="font-medium text-teal-700">Mini-swap executado</div>
      {demandas.length > 0 && (
        <ul className="mt-1 ml-4 list-disc text-zinc-600 space-y-0.5">
          {demandas.map((d) => (
            <li key={d.produto_id}>
              SKU {d.produto_id.slice(0, 8)}… consolidado em <b>{d.loc_destino_codigo}</b>
              {" "}(swap: {d.qty_swap}, empréstimo: {d.qty_emprestimo})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

> Adapte ao formato/estilo dos outros casos do switch.

- [ ] **Step 3: Smoke test em pedido real**

Iniciar uma wave que dispare mini-swap. Abrir `/pedidos/[id]` desse pedido e ver a timeline.

- [ ] **Step 4: Commit**

```bash
git add src/components/pedido/
git commit -m "feat(pedidos): renderiza mini_swap_executado na timeline"
```

---

## Task 13: Stress test E2E em staging

**Files:**
- Create: `scripts/wms/stress-mini-swap.ts`

- [ ] **Step 1: Criar script E2E que monta cenário, dispara wave, valida resultado**

```typescript
/**
 * E2E mini-swap intra-galpão.
 *
 * Setup: 2 pedidos NetAir + NetParts em CWB, SKU comum espalhado em 3 locs.
 * Dispara: POST /api/separacao/iniciar
 * Valida:
 *   1. Resposta da API contém pedido_ids em em_separacao
 *   2. siso_estoque após: SKU do pedido NetAir consolidado em 1 loc
 *   3. siso_movimentacoes contém movs origem='swap' (par S+E iguais)
 *   4. Saldo total por empresa preservado
 *
 * Pré-requisito: `npm run seed:staging` + `npm run dev` em outra aba.
 *
 * Uso: `tsx scripts/wms/stress-mini-swap.ts`
 */

import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";

const BASE = process.env.WEBHOOK_BASE_URL ?? "http://localhost:3000";
const SKU_TESTE = "19MINISWAP-01";
const GALPAO_CWB_ID = process.env.GALPAO_CWB_ID;
const SESSION_ID = process.env.STRESS_SESSION_ID;

if (!GALPAO_CWB_ID || !SESSION_ID) {
  throw new Error("Setar GALPAO_CWB_ID e STRESS_SESSION_ID no env");
}

async function main() {
  const sb = createServiceClient();

  // ... setup do cenário (espelhar stress-swap.ts pra padrão)
  // 1. Garantir produto SKU_TESTE existe em siso_produtos
  // 2. Garantir 2 locs no CWB (LA, LB pra NetAir; LC pra NetParts)
  // 3. Resetar saldo via inserirMovimentacao (NetAir 3+1, NetParts 5)
  // 4. Criar 1 pedido na NetAir com qty=5 (status=em_separacao)
  // 5. Buscar pedido_id

  // 6. POST /api/separacao/iniciar
  const res = await fetch(`${BASE}/api/separacao/iniciar`, {
    method: "POST",
    headers: { "X-Session-Id": SESSION_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ pedido_ids: ["<id-do-pedido>"], operador_id: "<id-operador>" }),
  });
  const result = await res.json();
  console.log("Iniciar response:", result);

  // 7. Verifica saldo após
  const { data: saldosDepois } = await sb
    .from("siso_estoque")
    .select("empresa_dona_id, localizacao_id, saldo")
    .eq("galpao_id", GALPAO_CWB_ID)
    .gt("saldo", 0);
  console.log("Saldos após mini-swap:", saldosDepois);

  // 8. Verifica movs swap criadas
  const { data: movs } = await sb
    .from("siso_movimentacoes")
    .select("tipo, quantidade, empresa_dona_id, localizacao_id, origem_tipo")
    .eq("origem_tipo", "swap")
    .order("criado_em", { ascending: false })
    .limit(20);
  console.log("Movs swap recentes:", movs);

  // 9. Asserts
  // ... (par S+E mesma qty, NetAir consolidada em 1 loc, etc)
}

main().catch((err) => {
  console.error("Falhou:", err);
  process.exit(1);
});
```

> Esse arquivo é template — engenheiro deve completar as partes `// ...` espelhando `scripts/wms/stress-swap.ts` e `scripts/wms/seed-cenarios.ts`.

- [ ] **Step 2: Rodar e iterar até validar**

```bash
tsx scripts/wms/stress-mini-swap.ts
```

Verificar visualmente os outputs. Se mini-swap consolidou: SKU teste deve aparecer em 1 loc só pra NetAir. Movs swap devem existir em pares S+E.

- [ ] **Step 3: Validar conservação manualmente**

Via SQL direto:

```sql
-- Saldo total por empresa pra SKU_TESTE no galpão CWB
SELECT empresa_dona_id, SUM(saldo) total
FROM siso_estoque
WHERE produto_id = (SELECT id FROM siso_produtos WHERE sku = '19MINISWAP-01')
  AND galpao_id = '<galpao-cwb-id>'
GROUP BY empresa_dona_id;
```

Antes vs depois: total por empresa deve ser igual.

- [ ] **Step 4: Commit**

```bash
git add scripts/wms/stress-mini-swap.ts
git commit -m "test(wms): script E2E stress-mini-swap em staging"
```

---

## Task 14: Atualizar documentação

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/api-reference-complete.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/architecture-and-flows.md`

- [ ] **Step 1: CLAUDE.md — adicionar 4 entradas**

1. Em **Project Structure** (sob `src/lib/wms/`):
   ```
   mini-swap-types.ts            # Tipos do mini-swap intra-galpão
   mini-swap.ts                  # Algoritmo puro + orchestrator (planejarMiniSwap, executarMiniSwap)
   ```

2. Em **Project Structure** (sob `src/app/api/wms/`):
   ```
   mini-swap/config/route.ts                # GET — lista config por galpão
   mini-swap/config/[galpaoId]/route.ts     # PATCH — toggle (admin)
   mini-swap/simular/route.ts               # POST — dry-run
   ```

3. Em **Project Structure** (sob `src/app/wms/`):
   ```
   configuracoes/otimizacoes/page.tsx       # Toggle mini-swap por galpão
   ```

4. Em **WMS Tables** — adicionar `siso_wms_mini_swap_config` na lista.

5. Em **Current Status > In Progress / Minor**:
   ```markdown
   - **WMS Mini-Swap Intra-Galpão — implementado em staging, 2026-05-14.** Antes de iniciar wave de picking, consolida estoque das empresas no mesmo galpão em 1 loc canônica via swap (zero dívida) + empréstimo (limitado ao planejado pelo roteamento). Algoritmo puro em `src/lib/wms/mini-swap.ts` + RPC `wms_executar_mini_swap` aplica plano sob lock pessimista. Toggle on/off por galpão em `/wms/configuracoes/otimizacoes`. Graceful: qualquer falha → wave segue sem otimização. Foundation pra cycle count oportunista (próximo). Migration: `supabase/migrations/20260514_wms_mini_swap*.sql`. Spec: `docs/superpowers/specs/2026-05-14-mini-swap-intra-galpao-design.md`.
   ```

- [ ] **Step 2: docs/api-reference-complete.md — adicionar 3 endpoints**

Documentar:
- `GET /api/wms/mini-swap/config` — método, auth, retorno
- `PATCH /api/wms/mini-swap/config/[galpaoId]` — método, auth (admin), body, retorno
- `POST /api/wms/mini-swap/simular` — método, auth, body, retorno

E atualizar `POST /api/separacao/iniciar` com:
- "Side effects: chama mini-swap intra-galpão se ativo no galpão (graceful, ver `executarMiniSwap`)"
- "Histórico: registra evento `mini_swap_executado` por pedido afetado"

- [ ] **Step 3: docs/database-schema.md — adicionar tabela + RPC**

Documentar:
- Tabela `siso_wms_mini_swap_config` (colunas, FK, default)
- RPC `wms_executar_mini_swap` (signature, comportamento, transação)

- [ ] **Step 4: docs/architecture-and-flows.md — adicionar fluxo**

Adicionar seção "Wave Picking + Mini-Swap" com diagrama Mermaid:

```
sequenceDiagram
  participant Op as Operador
  participant API as /api/separacao/iniciar
  participant MS as executarMiniSwap (TS)
  participant RPC as wms_executar_mini_swap
  participant DB as siso_estoque

  Op->>API: POST { pedido_ids }
  API->>API: transição em_separacao
  API->>MS: executarMiniSwap()
  MS->>DB: lê estoque + reservas
  MS->>MS: planejarMiniSwap (puro)
  alt plano vazio
    MS-->>API: ok=true, demandas=[]
  else plano não-vazio
    MS->>RPC: wms_executar_mini_swap(plano)
    RPC->>DB: SELECT FOR UPDATE
    RPC->>DB: insere movs swap + R recriadas
    RPC-->>MS: executado
    MS-->>API: ok=true, demandas=[...]
  end
  API->>DB: registra mini_swap_executado em historico
  API-->>Op: checklist consolidada
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: mini-swap intra-galpão (CLAUDE.md, api-ref, schema, flows)"
```

---

## Task 15: Smoke final + merge

- [ ] **Step 1: Rodar suite completa de testes**

```bash
npm run test
```

Expected: tudo passa. Especialmente `mini-swap.test.ts`.

- [ ] **Step 2: Lint + typecheck**

```bash
npm run lint
npx tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 3: Smoke manual em dev server**

```bash
npm run dev
```

Validar 3 fluxos:
1. Wave que aciona mini-swap (estoque espalhado) → operador vê 1 loc, timeline mostra evento
2. Wave que NÃO aciona (1 loc só) → comportamento idêntico ao atual, sem evento histórico
3. Toggle off no galpão → wave começa sem chamar mini-swap

- [ ] **Step 4: Verificar `erros-conhecidos.yaml`**

Se descobriu erros durante implementação que valeram registro, adicionar entrada conforme convenção do arquivo.

- [ ] **Step 5: Use skill `superpowers:finishing-a-development-branch`**

Decidir entre merge direto pra `develop` ou abrir PR.

- [ ] **Step 6: Atualizar Task 9 do brainstorm**

Marcar como completed em qualquer tracking. Task 9 era "Spec cycle count oportunista (depende do mini-swap)" — agora desbloqueada.

---

## Self-Review (executado durante a escrita do plano)

**Spec coverage:**
- ✅ Decisões 3.1-3.7 da spec → Tasks 1-13
- ✅ Schema (seção 6) → Task 1, Task 6
- ✅ APIs (seção 7) → Tasks 8, 9, 10
- ✅ UI (seção 8) → Tasks 11, 12
- ✅ Edge cases (seção 9) → cobertos no algoritmo (Tasks 3-5) + try/catch (Task 7, 10)
- ✅ Testes (seção 10) → Tasks 3-5 (unit) + Task 13 (E2E)
- ✅ Não-objetivos (seção 11) → respeitados (sem mini-swap parcial, sem multi-contrapartida v1)
- ✅ Roadmap (seção 14) → Tasks 1-15

**Type consistency:** `planejarMiniSwap()` retorna `PlanoMiniSwap` (definido em mini-swap-types.ts) e é o mesmo tipo aceito pelo `executarMiniSwap()` e enviado ao RPC `wms_executar_mini_swap` como jsonb. Operações `OperacaoSwap` / `OperacaoEmprestimo` usadas tanto na geração quanto no payload da RPC.

**Placeholder scan:** Steps com `<id-real>` / `<session-id>` / `<galpao-cwb-id>` são variáveis runtime que o engenheiro preenche na hora de testar — esperado, não placeholder. Stress test (Task 13) tem `// ...` explicitamente marcado como template a completar espelhando script existente.

**Risco identificado:** Step 1 da Task 6 (assinatura de `wms_inserir_movimentacao`) tem nota explícita pra engenheiro validar contra o código real antes de aplicar. Sem isso, a chamada falharia silenciosamente. Mantido como warning explícito.
