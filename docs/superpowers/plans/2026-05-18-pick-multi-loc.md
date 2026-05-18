# Picking Multi-Loc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capturar quantidade real pega e posição esvaziada na separação via novo botão "Parcial"; gerar movs no ledger WMS (saída + ajuste); re-buscar saldo residual no mesmo galpão (mesma empresa, depois empréstimo entre empresas do grupo); re-injetar linha realocada no fim da onda OU mover pedido pra `pendente_realocacao` quando re-busca falha.

**Architecture:** Endpoint `POST /api/separacao/parcial` orquestra: (1) gera mov de saída em <code>nf_venda</code> + mov de ajuste em <code>ajuste_pick_zerou</code> via `inserirMovimentacao` existente; (2) lib `realocacao-resolver` consulta `siso_estoque` filtrado por grupo+galpão, prioriza por cascade documentada; (3) cria rows em nova tabela `siso_pedido_item_realocacoes` ou transita pedido pra novo status `pendente_realocacao`. Frontend ganha modal compacto + badges visuais. Painel SISO mostra fila de realocação pendente.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Supabase (PostgreSQL), vitest (testes lib), Tailwind 4 (UI), Sonner (toasts), Lucide (ícones). RPC `wms_inserir_movimentacao` já existe (Plano 1 WMS).

**Escopo:** staging only (`develop` branch, Supabase `ehbxpbeijofxtsbezwxd`). Não toca prod até o Plano 6 cutover.

**Spec:** [`../specs/2026-05-18-pick-multi-loc-design.md`](../specs/2026-05-18-pick-multi-loc-design.md) — referenciado pelos §X em cada task.

---

## File Structure

**Novos:**
- `supabase/migrations/20260518_pick_multi_loc.sql` — schema (origem_tipo + tabela + colunas + status)
- `src/lib/separacao/wms-mapping.ts` — resolve Tiny IDs (produto/loc) → uuids WMS
- `src/lib/separacao/wms-mapping.test.ts`
- `src/lib/separacao/realocacao-resolver.ts` — algoritmo de re-busca cascade
- `src/lib/separacao/realocacao-resolver.test.ts`
- `src/app/api/separacao/parcial/route.ts` — POST: orquestra parcial + re-busca
- `src/app/api/separacao/marcar-realocacao/route.ts` — POST: completa realocação
- `src/app/api/separacao/realocacao/[id]/route.ts` — DELETE: cancela realocação pendente
- `src/app/api/separacao/desfazer-parcial/route.ts` — POST: estorna parcial
- `src/components/separacao/parcial-modal.tsx` — modal de qty + loc zerou

**Modificados:**
- `src/lib/wms/types.ts` — adiciona `ajuste_pick_zerou` em OrigemTipo
- `src/app/api/separacao/marcar-item/route.ts` — passa a gerar mov no ledger
- `src/app/api/separacao/checklist-items/route.ts` — inclui realocações na resposta
- `src/app/api/separacao/cancelar/route.ts` — estorna movs do parcial + cancela realocações
- `src/app/separacao/checklist/page.tsx` — botão Parcial + badges + render realocações
- `src/app/siso/page.tsx` — badge "Realocação" pra `pendente_realocacao`
- `src/components/pedido/pedido-card.tsx` — detalhe da realocação pendente
- `docs/api-reference-complete.md`, `docs/database-schema.md`, `docs/architecture-and-flows.md`, `docs/fluxos-siso.md`, `CLAUDE.md`

---

## Task 1: Migration — schema changes

**Files:**
- Create: `supabase/migrations/20260518_pick_multi_loc.sql`

Refere a §5 do spec.

- [ ] **Step 1: Write the migration file**

Conteúdo de `supabase/migrations/20260518_pick_multi_loc.sql`:

```sql
-- 20260518_pick_multi_loc.sql
-- Picking multi-loc — captura de qty real e posição esvaziada na separação.
-- Spec: docs/superpowers/specs/2026-05-18-pick-multi-loc-design.md

BEGIN;

-- 1. Novo origem_tipo no ledger: ajuste_pick_zerou
ALTER TABLE siso_movimentacoes
  DROP CONSTRAINT siso_movimentacoes_origem_tipo_check;

ALTER TABLE siso_movimentacoes
  ADD CONSTRAINT siso_movimentacoes_origem_tipo_check
  CHECK (origem_tipo IN (
    'compra_manual','lancamento_retroativo','nf_venda','nf_devolucao_cliente',
    'nf_devolucao_avariada','nf_devolucao_fornecedor','transferencia_galpao',
    'transferencia_localizacao','emprestimo','reserva_pedido','liberacao_reserva',
    'troca_sku_in','troca_sku_out','ajuste_manual','inventario','inventario_inicial',
    'estorno','cancelamento_nf',
    'ajuste_pick_zerou'
  ));

-- 2. Nova tabela: realocações pendentes por item de pedido
CREATE TABLE siso_pedido_item_realocacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_item_id uuid NOT NULL REFERENCES siso_pedido_itens(id) ON DELETE CASCADE,
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  quantidade integer NOT NULL CHECK (quantidade > 0),
  is_emprestimo boolean NOT NULL DEFAULT false,
  empresa_devedora_id uuid REFERENCES siso_empresas(id),
  status text NOT NULL DEFAULT 'aguardando_picking'
    CHECK (status IN ('aguardando_picking','picado','cancelado')),
  motivo text NOT NULL DEFAULT 'loc_zerou',
  criado_em timestamptz NOT NULL DEFAULT now(),
  criado_por uuid REFERENCES siso_usuarios(id),
  picado_em timestamptz,
  picado_por uuid REFERENCES siso_usuarios(id),
  mov_saida_id uuid REFERENCES siso_movimentacoes(id),
  CHECK (
    (is_emprestimo = true AND empresa_devedora_id IS NOT NULL)
    OR (is_emprestimo = false AND empresa_devedora_id IS NULL)
  )
);

CREATE INDEX idx_realoc_pedido_item ON siso_pedido_item_realocacoes(pedido_item_id);
CREATE INDEX idx_realoc_status_aguardando
  ON siso_pedido_item_realocacoes(pedido_item_id, status)
  WHERE status = 'aguardando_picking';

-- 3. Novas colunas em siso_pedido_itens
ALTER TABLE siso_pedido_itens
  ADD COLUMN quantidade_pega integer,
  ADD COLUMN separacao_parcial boolean NOT NULL DEFAULT false,
  ADD COLUMN parcial_motivo text,
  ADD COLUMN parcial_em timestamptz,
  ADD COLUMN parcial_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN mov_saida_id uuid REFERENCES siso_movimentacoes(id),
  ADD COLUMN mov_ajuste_loc_zerou_id uuid REFERENCES siso_movimentacoes(id);

-- 4. Novo status em siso_pedidos.status_separacao: pendente_realocacao
ALTER TABLE siso_pedidos
  DROP CONSTRAINT IF EXISTS siso_pedidos_status_separacao_check;

ALTER TABLE siso_pedidos
  ADD CONSTRAINT siso_pedidos_status_separacao_check
  CHECK (status_separacao IS NULL OR status_separacao IN (
    'aguardando_compra','aguardando_nf','aguardando_separacao',
    'em_separacao','separado','embalado','expedido',
    'pendente_realocacao'
  ));

COMMIT;
```

- [ ] **Step 2: Apply migration to staging**

Aplicar via Supabase MCP (project_id `ehbxpbeijofxtsbezwxd`) ou via `supabase db push`. Comando:

```bash
# Via MCP (preferred): use mcp__supabase__apply_migration tool with project_id and name=pick_multi_loc
# Ou via CLI:
supabase db push --project-ref ehbxpbeijofxtsbezwxd
```

- [ ] **Step 3: Validate migration applied correctly**

Run via Supabase SQL editor ou `mcp__supabase__execute_sql`:

```sql
-- Verificar origem_tipo aceita o novo valor
SELECT 'ajuste_pick_zerou' = ANY(
  SELECT unnest(string_to_array(
    regexp_replace(
      pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conname = 'siso_movimentacoes_origem_tipo_check')),
      '[^a-z_,]', '', 'g'
    ),
    ','
  ))
) AS contains_new_origem;
-- Expected: t

-- Verificar tabela criada
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'siso_pedido_item_realocacoes' ORDER BY ordinal_position;
-- Expected: 14 colunas

-- Verificar novas colunas
SELECT column_name FROM information_schema.columns
WHERE table_name = 'siso_pedido_itens'
  AND column_name IN ('quantidade_pega','separacao_parcial','parcial_motivo',
                      'parcial_em','parcial_por','mov_saida_id','mov_ajuste_loc_zerou_id');
-- Expected: 7 rows

-- Verificar novo status aceito
INSERT INTO siso_pedidos (id, numero, status_separacao) VALUES (gen_random_uuid(), 99999, 'pendente_realocacao');
ROLLBACK;
-- Expected: INSERT 0 1 sem erro (rollback evita poluir dados)
```

- [ ] **Step 4: Commit migration**

```bash
git add supabase/migrations/20260518_pick_multi_loc.sql
git commit -m "feat(wms): migration pick multi-loc — origem ajuste_pick_zerou + realocações + pendente_realocacao

Adiciona infra de schema pra captura de qty real e posição esvaziada
na separação. Refere a docs/superpowers/specs/2026-05-18-pick-multi-loc-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Estender tipos (OrigemTipo + EventoPedido)

**Files:**
- Modify: `src/lib/wms/types.ts`
- Modify: `src/lib/historico-service.ts`

- [ ] **Step 1: Adicionar `ajuste_pick_zerou` à union `OrigemTipo`**

Em `src/lib/wms/types.ts`, localizar `export type OrigemTipo` (linha ~13) e adicionar `"ajuste_pick_zerou"`:

```typescript
export type OrigemTipo =
  | "compra_manual"
  | "lancamento_retroativo"
  | "nf_venda"
  | "nf_devolucao_cliente"
  | "nf_devolucao_avariada"
  | "nf_devolucao_fornecedor"
  | "transferencia_galpao"
  | "transferencia_localizacao"
  | "emprestimo"
  | "reserva_pedido"
  | "liberacao_reserva"
  | "troca_sku_in"
  | "troca_sku_out"
  | "ajuste_manual"
  | "inventario"
  | "inventario_inicial"
  | "estorno"
  | "cancelamento_nf"
  | "ajuste_pick_zerou";
```

- [ ] **Step 2: Adicionar novos eventos à union `EventoPedido`**

Em `src/lib/historico-service.ts`, localizar `export type EventoPedido` e adicionar 5 novos eventos no final:

```typescript
export type EventoPedido =
  | "recebido"
  | "auto_aprovado"
  // ... (mantém todos os existentes) ...
  | "oc_item_confirmado"
  // NOVOS — picking multi-loc:
  | "parcial_loc_zerou"
  | "realocacao_picada"
  | "realocacao_cancelada"
  | "realocacao_sem_cobertura_galpao"
  | "parcial_desfeito";
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: build passa sem erros TS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/types.ts src/lib/historico-service.ts
git commit -m "feat: estende tipos — OrigemTipo (ajuste_pick_zerou) + EventoPedido (5 eventos)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Lib `wms-mapping.ts` — resolve Tiny IDs → uuids WMS

**Files:**
- Create: `src/lib/separacao/wms-mapping.ts`
- Test: `src/lib/separacao/wms-mapping.test.ts`

Helpers compartilhados pelos novos endpoints. Precisa mapear `siso_pedido_itens.produto_id` (Tiny ID, bigint como string) → `siso_produtos.id` (uuid WMS), e `siso_pedido_item_estoques.localizacao` (texto livre do Tiny) → `siso_localizacoes.id` (uuid).

- [ ] **Step 1: Write the failing test**

`src/lib/separacao/wms-mapping.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  resolverProdutoWms,
  resolverLocalizacaoWms,
  type MappingDeps,
} from "./wms-mapping";

function makeDeps(overrides: Partial<MappingDeps> = {}): MappingDeps {
  return {
    buscarProdutoId: vi.fn(async () => "uuid-prod-1"),
    buscarLocalizacaoId: vi.fn(async () => "uuid-loc-1"),
    criarLocalizacao: vi.fn(async () => "uuid-loc-novo"),
    ...overrides,
  };
}

describe("resolverProdutoWms", () => {
  it("retorna uuid quando produto existe em siso_produto_empresas", async () => {
    const deps = makeDeps();
    const r = await resolverProdutoWms("emp-1", "12345", deps);
    expect(r).toBe("uuid-prod-1");
    expect(deps.buscarProdutoId).toHaveBeenCalledWith("emp-1", "12345");
  });

  it("lança erro quando produto não está mapeado", async () => {
    const deps = makeDeps({ buscarProdutoId: vi.fn(async () => null) });
    await expect(resolverProdutoWms("emp-1", "99999", deps)).rejects.toThrow(
      /produto.*99999.*não mapeado/i,
    );
  });
});

describe("resolverLocalizacaoWms", () => {
  it("retorna uuid quando loc existe", async () => {
    const deps = makeDeps();
    const r = await resolverLocalizacaoWms("galp-1", "B-02-01", deps);
    expect(r).toBe("uuid-loc-1");
  });

  it("usa DEFAULT-PICKING quando codigo é null ou vazio", async () => {
    const deps = makeDeps();
    const r = await resolverLocalizacaoWms("galp-1", null, deps);
    expect(deps.buscarLocalizacaoId).toHaveBeenCalledWith("galp-1", "DEFAULT-PICKING");
    expect(r).toBe("uuid-loc-1");
  });

  it("cria nova loc (tipo picking) se não existe", async () => {
    const deps = makeDeps({ buscarLocalizacaoId: vi.fn(async () => null) });
    const r = await resolverLocalizacaoWms("galp-1", "C-99-99", deps);
    expect(deps.criarLocalizacao).toHaveBeenCalledWith("galp-1", "C-99-99");
    expect(r).toBe("uuid-loc-novo");
  });

  it("fallback final pra DEFAULT-PICKING se criação falhar", async () => {
    const deps = makeDeps({
      buscarLocalizacaoId: vi.fn(async (galp, cod) =>
        cod === "DEFAULT-PICKING" ? "uuid-default" : null,
      ),
      criarLocalizacao: vi.fn(async () => null),
    });
    const r = await resolverLocalizacaoWms("galp-1", "C-99-99", deps);
    expect(r).toBe("uuid-default");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test -- src/lib/separacao/wms-mapping.test.ts
```

Expected: FAIL (module não existe).

- [ ] **Step 3: Write the implementation**

`src/lib/separacao/wms-mapping.ts`:

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

export interface MappingDeps {
  buscarProdutoId: (empresaId: string, tinyProdutoId: string) => Promise<string | null>;
  buscarLocalizacaoId: (galpaoId: string, codigo: string) => Promise<string | null>;
  criarLocalizacao: (galpaoId: string, codigo: string) => Promise<string | null>;
}

export async function resolverProdutoWms(
  empresaId: string,
  tinyProdutoId: string,
  deps: MappingDeps = defaultDeps(),
): Promise<string> {
  const id = await deps.buscarProdutoId(empresaId, tinyProdutoId);
  if (!id) {
    throw new Error(
      `produto Tiny ${tinyProdutoId} (empresa ${empresaId}) não mapeado em siso_produto_empresas`,
    );
  }
  return id;
}

export async function resolverLocalizacaoWms(
  galpaoId: string,
  codigo: string | null | undefined,
  deps: MappingDeps = defaultDeps(),
): Promise<string> {
  const codigoNormalizado = (codigo ?? "").trim();
  const codigoBusca = codigoNormalizado || "DEFAULT-PICKING";

  const existente = await deps.buscarLocalizacaoId(galpaoId, codigoBusca);
  if (existente) return existente;

  // Não achou — se foi busca por DEFAULT-PICKING, erro fatal (todo galpão deveria ter).
  if (codigoBusca === "DEFAULT-PICKING") {
    throw new Error(
      `DEFAULT-PICKING não encontrada em galpão ${galpaoId} — schema corrompido`,
    );
  }

  // Tenta criar a loc (tipo picking, codigo do Tiny).
  const novoId = await deps.criarLocalizacao(galpaoId, codigoBusca);
  if (novoId) return novoId;

  // Falhou criação — fallback pra DEFAULT-PICKING.
  logger.warn("wms-mapping", "Falhou criar loc, fallback DEFAULT-PICKING", {
    galpaoId,
    codigo: codigoBusca,
  });
  const fallback = await deps.buscarLocalizacaoId(galpaoId, "DEFAULT-PICKING");
  if (!fallback) {
    throw new Error(
      `DEFAULT-PICKING não encontrada em galpão ${galpaoId} (fallback)`,
    );
  }
  return fallback;
}

function defaultDeps(): MappingDeps {
  return {
    buscarProdutoId: async (empresaId, tinyProdutoId) => {
      const supabase = createServiceClient();
      const { data } = await supabase
        .from("siso_produto_empresas")
        .select("produto_id")
        .eq("empresa_id", empresaId)
        .eq("tiny_produto_id", Number(tinyProdutoId))
        .maybeSingle();
      return data?.produto_id ?? null;
    },
    buscarLocalizacaoId: async (galpaoId, codigo) => {
      const supabase = createServiceClient();
      const { data } = await supabase
        .from("siso_localizacoes")
        .select("id")
        .eq("galpao_id", galpaoId)
        .eq("codigo", codigo)
        .eq("ativo", true)
        .maybeSingle();
      return data?.id ?? null;
    },
    criarLocalizacao: async (galpaoId, codigo) => {
      const supabase = createServiceClient();
      const { data, error } = await supabase
        .from("siso_localizacoes")
        .insert({
          galpao_id: galpaoId,
          codigo,
          tipo: "picking",
          descricao: `Auto-criada (origem Tiny)`,
          ativo: true,
        })
        .select("id")
        .single();
      if (error) {
        logger.error("wms-mapping", "Falhou criar loc", {
          error: error.message,
          galpaoId,
          codigo,
        });
        return null;
      }
      return data.id;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test -- src/lib/separacao/wms-mapping.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/separacao/wms-mapping.ts src/lib/separacao/wms-mapping.test.ts
git commit -m "feat(separacao): lib wms-mapping pra resolver Tiny IDs em uuids WMS

Helpers resolverProdutoWms + resolverLocalizacaoWms com testes unit
(deps injection). Suporta auto-criação de loc picking e fallback pra
DEFAULT-PICKING.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Lib `realocacao-resolver.ts` — algoritmo de re-busca

**Files:**
- Create: `src/lib/separacao/realocacao-resolver.ts`
- Test: `src/lib/separacao/realocacao-resolver.test.ts`

Refere §6.1 step 7 do spec (re-busca residual, ordem de prioridade).

- [ ] **Step 1: Write the failing test**

`src/lib/separacao/realocacao-resolver.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  resolverRealocacao,
  type ResolverDeps,
  type EstoqueCandidato,
} from "./realocacao-resolver";

const empresaOrigem = "empA";
const empresaOutra = "empB";
const galpao = "galp1";
const locOriginal = "loc-original";

function makeDeps(estoque: EstoqueCandidato[]): ResolverDeps {
  return {
    listarEmpresasDoGrupoMesmoGalpao: vi.fn(async () => [empresaOrigem, empresaOutra]),
    listarSaldoCandidato: vi.fn(async () => estoque),
  };
}

describe("resolverRealocacao", () => {
  it("retorna realocacao na mesma empresa quando há saldo suficiente", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-A",
        localizacao_codigo: "A-01-02",
        localizacao_tipo: "picking",
        disponivel: 5,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 2,
      },
      deps,
    );

    expect(r.status).toBe("realocado");
    expect(r.realocacoes).toHaveLength(1);
    expect(r.realocacoes[0]).toMatchObject({
      empresa_dona_id: empresaOrigem,
      localizacao_id: "loc-A",
      quantidade: 2,
      is_emprestimo: false,
    });
  });

  it("prioriza mesma empresa > outra empresa do grupo", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOutra,
        localizacao_id: "loc-X",
        localizacao_codigo: "X",
        localizacao_tipo: "picking",
        disponivel: 10,
      },
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-Y",
        localizacao_codigo: "Y",
        localizacao_tipo: "picking",
        disponivel: 5,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 3,
      },
      deps,
    );

    expect(r.status).toBe("realocado");
    expect(r.realocacoes[0].empresa_dona_id).toBe(empresaOrigem);
    expect(r.realocacoes[0].is_emprestimo).toBe(false);
  });

  it("prioriza picking > overstock dentro da mesma empresa", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-OS",
        localizacao_codigo: "OVER",
        localizacao_tipo: "overstock",
        disponivel: 10,
      },
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-P",
        localizacao_codigo: "P",
        localizacao_tipo: "picking",
        disponivel: 3,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 2,
      },
      deps,
    );

    expect(r.realocacoes[0].localizacao_id).toBe("loc-P");
  });

  it("fragmenta em múltiplas realocações quando uma loc não cobre", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-A",
        localizacao_codigo: "A",
        localizacao_tipo: "picking",
        disponivel: 2,
      },
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-B",
        localizacao_codigo: "B",
        localizacao_tipo: "overstock",
        disponivel: 5,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 4,
      },
      deps,
    );

    expect(r.status).toBe("realocado");
    expect(r.realocacoes).toHaveLength(2);
    expect(r.realocacoes[0]).toMatchObject({ localizacao_id: "loc-A", quantidade: 2 });
    expect(r.realocacoes[1]).toMatchObject({ localizacao_id: "loc-B", quantidade: 2 });
  });

  it("marca is_emprestimo quando empresa diferente", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOutra,
        localizacao_id: "loc-A",
        localizacao_codigo: "A",
        localizacao_tipo: "picking",
        disponivel: 5,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 2,
      },
      deps,
    );

    expect(r.realocacoes[0].is_emprestimo).toBe(true);
    expect(r.realocacoes[0].empresa_devedora_id).toBe(empresaOrigem);
  });

  it("retorna sem_cobertura quando residual > soma de todos os saldos", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-A",
        localizacao_codigo: "A",
        localizacao_tipo: "picking",
        disponivel: 1,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 5,
      },
      deps,
    );

    expect(r.status).toBe("sem_cobertura");
    expect(r.realocacoes).toHaveLength(0);
  });

  it("retorna sem_cobertura quando lista de candidatos vazia", async () => {
    const deps = makeDeps([]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 1,
      },
      deps,
    );

    expect(r.status).toBe("sem_cobertura");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test -- src/lib/separacao/realocacao-resolver.test.ts
```

Expected: FAIL (module não existe).

- [ ] **Step 3: Write the implementation**

`src/lib/separacao/realocacao-resolver.ts`:

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import type { TipoLocalizacao } from "@/lib/wms/types";

export interface EstoqueCandidato {
  empresa_dona_id: string;
  localizacao_id: string;
  localizacao_codigo: string;
  localizacao_tipo: TipoLocalizacao;
  disponivel: number;
}

export interface ResolverInput {
  produto_id: string;            // uuid WMS (já resolvido)
  empresa_origem_id: string;     // empresa origem do pedido
  galpao_id: string;             // galpao da separação
  localizacao_id_original: string; // loc que zerou (excluir da busca)
  qty_residual: number;
}

export interface RealocacaoSugerida {
  empresa_dona_id: string;
  localizacao_id: string;
  localizacao_codigo: string;
  quantidade: number;
  is_emprestimo: boolean;
  empresa_devedora_id: string | null;
}

export interface ResolverResult {
  status: "realocado" | "sem_cobertura";
  realocacoes: RealocacaoSugerida[];
}

export interface ResolverDeps {
  listarEmpresasDoGrupoMesmoGalpao: (empresaOrigemId: string, galpaoId: string) => Promise<string[]>;
  listarSaldoCandidato: (input: {
    produto_id: string;
    galpao_id: string;
    empresas_grupo: string[];
    localizacao_id_excluir: string;
  }) => Promise<EstoqueCandidato[]>;
}

const TIPO_PRIORIDADE: Record<TipoLocalizacao, number> = {
  picking: 1,
  overstock: 2,
  recebimento: 3,
  expedicao: 4, // não deve aparecer mas pra completude
  quarentena: 5,
};

export async function resolverRealocacao(
  input: ResolverInput,
  deps: ResolverDeps = defaultDeps(),
): Promise<ResolverResult> {
  const empresas = await deps.listarEmpresasDoGrupoMesmoGalpao(
    input.empresa_origem_id,
    input.galpao_id,
  );

  const candidatos = await deps.listarSaldoCandidato({
    produto_id: input.produto_id,
    galpao_id: input.galpao_id,
    empresas_grupo: empresas,
    localizacao_id_excluir: input.localizacao_id_original,
  });

  if (candidatos.length === 0) {
    return { status: "sem_cobertura", realocacoes: [] };
  }

  // Ordena: mesma empresa primeiro, depois tipo loc, depois maior disponivel, depois codigo ASC
  const ordenado = [...candidatos].sort((a, b) => {
    const aMesma = a.empresa_dona_id === input.empresa_origem_id ? 0 : 1;
    const bMesma = b.empresa_dona_id === input.empresa_origem_id ? 0 : 1;
    if (aMesma !== bMesma) return aMesma - bMesma;

    const aTipo = TIPO_PRIORIDADE[a.localizacao_tipo] ?? 99;
    const bTipo = TIPO_PRIORIDADE[b.localizacao_tipo] ?? 99;
    if (aTipo !== bTipo) return aTipo - bTipo;

    if (a.disponivel !== b.disponivel) return b.disponivel - a.disponivel;

    return a.localizacao_codigo.localeCompare(b.localizacao_codigo);
  });

  // Pega em ordem até cobrir qty_residual
  const realocacoes: RealocacaoSugerida[] = [];
  let faltando = input.qty_residual;
  for (const c of ordenado) {
    if (faltando <= 0) break;
    const qty = Math.min(c.disponivel, faltando);
    realocacoes.push({
      empresa_dona_id: c.empresa_dona_id,
      localizacao_id: c.localizacao_id,
      localizacao_codigo: c.localizacao_codigo,
      quantidade: qty,
      is_emprestimo: c.empresa_dona_id !== input.empresa_origem_id,
      empresa_devedora_id:
        c.empresa_dona_id !== input.empresa_origem_id ? input.empresa_origem_id : null,
    });
    faltando -= qty;
  }

  if (faltando > 0) {
    // Cobertura parcial: descarta — spec exige cobertura total no galpão pra inline
    return { status: "sem_cobertura", realocacoes: [] };
  }

  return { status: "realocado", realocacoes };
}

function defaultDeps(): ResolverDeps {
  return {
    listarEmpresasDoGrupoMesmoGalpao: async (empresaOrigemId, galpaoId) => {
      const supabase = createServiceClient();
      // Resolve grupo da empresa
      const { data: ge } = await supabase
        .from("siso_grupo_empresas")
        .select("grupo_id")
        .eq("empresa_id", empresaOrigemId)
        .maybeSingle();
      if (!ge?.grupo_id) return [empresaOrigemId];

      // Lista todas empresas do grupo no mesmo galpão
      const { data: empresas } = await supabase
        .from("siso_grupo_empresas")
        .select("empresa_id, siso_empresas!inner(galpao_id, ativo)")
        .eq("grupo_id", ge.grupo_id);

      const filtradas = (empresas ?? []).filter((e) => {
        const emp = e.siso_empresas as unknown as { galpao_id: string; ativo: boolean };
        return emp.galpao_id === galpaoId && emp.ativo;
      }).map((e) => e.empresa_id);

      return filtradas.length > 0 ? filtradas : [empresaOrigemId];
    },
    listarSaldoCandidato: async ({ produto_id, galpao_id, empresas_grupo, localizacao_id_excluir }) => {
      const supabase = createServiceClient();
      const { data } = await supabase
        .from("siso_estoque")
        .select(`
          empresa_dona_id,
          localizacao_id,
          disponivel,
          siso_localizacoes!inner(codigo, tipo)
        `)
        .eq("produto_id", produto_id)
        .eq("galpao_id", galpao_id)
        .in("empresa_dona_id", empresas_grupo)
        .neq("localizacao_id", localizacao_id_excluir)
        .gt("disponivel", 0);

      return (data ?? []).map((row) => {
        const loc = row.siso_localizacoes as unknown as { codigo: string; tipo: TipoLocalizacao };
        return {
          empresa_dona_id: row.empresa_dona_id as string,
          localizacao_id: row.localizacao_id as string,
          localizacao_codigo: loc.codigo,
          localizacao_tipo: loc.tipo,
          disponivel: Number(row.disponivel),
        };
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test -- src/lib/separacao/realocacao-resolver.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/separacao/realocacao-resolver.ts src/lib/separacao/realocacao-resolver.test.ts
git commit -m "feat(separacao): lib realocacao-resolver — cascade de re-busca

Algoritmo de prioridade: mesma empresa > tipo loc (picking>overstock>...)
> maior disponivel > codigo ASC. Suporta fragmentação em N locs.
Tests unit com dependency injection (sem DB real).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: API `POST /api/separacao/parcial`

**Files:**
- Create: `src/app/api/separacao/parcial/route.ts`

Refere §6.1 do spec.

- [ ] **Step 1: Write the endpoint**

`src/app/api/separacao/parcial/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { registrarEvento } from "@/lib/historico-service";
import { resolverProdutoWms, resolverLocalizacaoWms } from "@/lib/separacao/wms-mapping";
import { resolverRealocacao } from "@/lib/separacao/realocacao-resolver";

/**
 * POST /api/separacao/parcial
 *
 * Operador marca um item como "peguei parte" + opcional "loc zerou".
 * Gera mov de saída (qty pega) + mov de ajuste (delta loc zerou) no ledger,
 * e tenta re-buscar o residual no mesmo galpão (mesma empresa ou empréstimo).
 *
 * Headers: X-Session-Id
 * Body: { pedido_item_id, quantidade_pega: int, loc_zerou: bool }
 * Response: { status: 'completo' | 'realocado' | 'aguardando_supervisor',
 *             realocacoes?: [...], motivo?: 'apenas_cross_galpao' | 'sem_cobertura_total' }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!session.galpaoId) {
    return NextResponse.json(
      { error: "admin não pode fazer parcial" },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_item_id ||
    typeof body.quantidade_pega !== "number" ||
    body.quantidade_pega < 0 ||
    !Number.isInteger(body.quantidade_pega) ||
    typeof body.loc_zerou !== "boolean"
  ) {
    return NextResponse.json(
      {
        error:
          "campos 'pedido_item_id', 'quantidade_pega' (int>=0), 'loc_zerou' (bool) obrigatórios",
      },
      { status: 400 },
    );
  }

  const { pedido_item_id, quantidade_pega, loc_zerou } = body as {
    pedido_item_id: string;
    quantidade_pega: number;
    loc_zerou: boolean;
  };

  const supabase = createServiceClient();

  try {
    // 1. Carrega item + pedido + empresa origem + loc do estoque do pedido
    const { data: item, error: itemErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, quantidade_pedida, separacao_marcado, separacao_parcial",
      )
      .eq("id", pedido_item_id)
      .single();

    if (itemErr || !item) {
      return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
    }

    if (item.separacao_marcado || item.separacao_parcial) {
      return NextResponse.json(
        { error: "item já processado (marcado ou parcial)" },
        { status: 409 },
      );
    }

    if (quantidade_pega > item.quantidade_pedida) {
      return NextResponse.json(
        { error: `quantidade_pega não pode exceder quantidade_pedida (${item.quantidade_pedida})` },
        { status: 400 },
      );
    }

    const { data: pedido, error: pedidoErr } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id, separacao_galpao_id, status_separacao")
      .eq("id", item.pedido_id)
      .single();

    if (pedidoErr || !pedido) {
      return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });
    }
    if (pedido.status_separacao !== "em_separacao") {
      return NextResponse.json(
        { error: `pedido não está em_separacao (atual: ${pedido.status_separacao})` },
        { status: 400 },
      );
    }

    const empresaOrigemId = pedido.empresa_origem_id;
    const galpaoId = pedido.separacao_galpao_id ?? session.galpaoId;
    if (!empresaOrigemId || !galpaoId) {
      return NextResponse.json({ error: "pedido sem empresa/galpão" }, { status: 400 });
    }

    // 2. Resolve produto WMS uuid
    const produtoWmsId = await resolverProdutoWms(empresaOrigemId, String(item.produto_id));

    // 3. Resolve loc original via siso_pedido_item_estoques
    const { data: estoque } = await supabase
      .from("siso_pedido_item_estoques")
      .select("localizacao, saldo")
      .eq("pedido_id", item.pedido_id)
      .eq("produto_id", item.produto_id)
      .eq("empresa_id", empresaOrigemId)
      .maybeSingle();

    const locCodigo = estoque?.localizacao ?? null;
    const locOriginalId = await resolverLocalizacaoWms(galpaoId, locCodigo);

    // 4. Saldo atual no cache WMS (pra calcular delta de ajuste)
    const { data: estoqueWms } = await supabase
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoWmsId)
      .eq("empresa_dona_id", empresaOrigemId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locOriginalId)
      .maybeSingle();

    const saldoWms = Number(estoqueWms?.saldo ?? 0);

    // 5. Mov 1: saída do que foi pego (origem nf_venda)
    let movSaidaId: string | null = null;
    if (quantidade_pega > 0) {
      const mov = await inserirMovimentacao({
        quadrupla: {
          produto_id: produtoWmsId,
          empresa_dona_id: empresaOrigemId,
          galpao_id: galpaoId,
          localizacao_id: locOriginalId,
        },
        tipo: "S",
        qty: quantidade_pega,
        origem_tipo: "nf_venda",
        origem_id: `pedido:${pedido.id}`,
        origem_detalhes: {
          pedido_numero: pedido.numero,
          pedido_item_id: item.id,
          sku: item.sku,
          contexto: "parcial",
        },
        observacoes: `Picking parcial pedido #${pedido.numero}`,
        usuario_id: session.id,
      });
      movSaidaId = mov.id;
    }

    // 6. Mov 2: ajuste se loc zerou
    let movAjusteId: string | null = null;
    if (loc_zerou) {
      const delta = saldoWms - quantidade_pega;
      if (delta > 0) {
        const movAj = await inserirMovimentacao({
          quadrupla: {
            produto_id: produtoWmsId,
            empresa_dona_id: empresaOrigemId,
            galpao_id: galpaoId,
            localizacao_id: locOriginalId,
          },
          tipo: "S",
          qty: delta,
          origem_tipo: "ajuste_pick_zerou",
          origem_id: `pedido:${pedido.id}`,
          origem_detalhes: {
            pedido_numero: pedido.numero,
            pedido_item_id: item.id,
            saldo_anterior: saldoWms,
            qty_pega: quantidade_pega,
          },
          observacoes: `Loc zerou no picking — ajuste ${delta} (sistema dizia ${saldoWms}, real ${quantidade_pega})`,
          usuario_id: session.id,
        });
        movAjusteId = movAj.id;
      }
    }

    // 7. Update item: marca parcial, registra qty e movs
    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        quantidade_pega,
        separacao_parcial: true,
        parcial_motivo: loc_zerou ? "loc_zerou" : "qty_diferente",
        parcial_em: nowIso,
        parcial_por: session.id,
        separacao_marcado: true,
        separacao_marcado_em: nowIso,
        mov_saida_id: movSaidaId,
        mov_ajuste_loc_zerou_id: movAjusteId,
      })
      .eq("id", item.id);

    if (updErr) {
      logger.logError({
        error: updErr,
        source: "separacao-parcial",
        message: "Falhou update pedido_itens após movs",
        category: "database",
        requestPath: "/api/separacao/parcial",
        requestMethod: "POST",
        metadata: { pedido_item_id, movSaidaId, movAjusteId },
      });
      return NextResponse.json({ error: "erro persistindo parcial" }, { status: 500 });
    }

    // 8. Histórico
    await registrarEvento({
      pedidoId: pedido.id,
      evento: "parcial_loc_zerou",
      detalhes: {
        item_id: item.id,
        sku: item.sku,
        quantidade_pega,
        quantidade_pedida: item.quantidade_pedida,
        loc_codigo: locCodigo,
        loc_zerou,
        delta_ajuste: movAjusteId ? saldoWms - quantidade_pega : 0,
      },
      usuarioId: session.id,
    });

    // 9. Re-busca residual
    const qtyResidual = item.quantidade_pedida - quantidade_pega;
    if (qtyResidual <= 0) {
      return NextResponse.json({ status: "completo" });
    }

    const resolver = await resolverRealocacao({
      produto_id: produtoWmsId,
      empresa_origem_id: empresaOrigemId,
      galpao_id: galpaoId,
      localizacao_id_original: locOriginalId,
      qty_residual: qtyResidual,
    });

    if (resolver.status === "sem_cobertura") {
      // Pedido sai da onda → pendente_realocacao
      await supabase
        .from("siso_pedidos")
        .update({ status_separacao: "pendente_realocacao" })
        .eq("id", pedido.id);

      await registrarEvento({
        pedidoId: pedido.id,
        evento: "realocacao_sem_cobertura_galpao",
        detalhes: { item_id: item.id, sku: item.sku, qty_residual: qtyResidual },
        usuarioId: session.id,
      });

      return NextResponse.json({
        status: "aguardando_supervisor",
        motivo: "sem_cobertura_total",
      });
    }

    // 10. Cria realocações
    const rows = resolver.realocacoes.map((r) => ({
      pedido_item_id: item.id,
      empresa_dona_id: r.empresa_dona_id,
      galpao_id: galpaoId,
      localizacao_id: r.localizacao_id,
      quantidade: r.quantidade,
      is_emprestimo: r.is_emprestimo,
      empresa_devedora_id: r.empresa_devedora_id,
      motivo: "loc_zerou",
      criado_por: session.id,
    }));

    const { data: criadas, error: insErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .insert(rows)
      .select("id, empresa_dona_id, localizacao_id, quantidade, is_emprestimo");

    if (insErr) {
      logger.logError({
        error: insErr,
        source: "separacao-parcial",
        message: "Falhou criar realocações",
        category: "database",
        requestPath: "/api/separacao/parcial",
        requestMethod: "POST",
        metadata: { pedido_item_id, rows },
      });
      return NextResponse.json({ error: "erro criando realocações" }, { status: 500 });
    }

    return NextResponse.json({
      status: "realocado",
      realocacoes: (criadas ?? []).map((c, i) => ({
        id: c.id,
        empresa_dona_id: c.empresa_dona_id,
        localizacao_id: c.localizacao_id,
        localizacao_codigo: resolver.realocacoes[i].localizacao_codigo,
        quantidade: c.quantidade,
        is_emprestimo: c.is_emprestimo,
      })),
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-parcial",
      message: "Erro inesperado em parcial",
      category: "unknown",
      requestPath: "/api/separacao/parcial",
      requestMethod: "POST",
      metadata: { pedido_item_id, quantidade_pega, loc_zerou },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Test manualmente em staging via curl**

Pré-requisitos: ter um pedido em `em_separacao` com SKU presente em múltiplas locs no WMS. Documentar o `pedido_item_id` e `X-Session-Id`.

```bash
curl -X POST http://localhost:3000/api/separacao/parcial \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: <session>" \
  -d '{"pedido_item_id":"<uuid>","quantidade_pega":3,"loc_zerou":true}' | jq
```

Expected: `{ "status": "realocado", "realocacoes": [...] }` ou `aguardando_supervisor`.

Verificar via SQL:
```sql
SELECT * FROM siso_movimentacoes ORDER BY criado_em DESC LIMIT 5;
SELECT * FROM siso_pedido_item_realocacoes WHERE pedido_item_id = '<uuid>';
SELECT separacao_parcial, quantidade_pega, mov_saida_id, mov_ajuste_loc_zerou_id
FROM siso_pedido_itens WHERE id = '<uuid>';
```

- [ ] **Step 3: Build check**

```bash
npm run build
```

Expected: passa.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/separacao/parcial/route.ts
git commit -m "feat(separacao): endpoint POST /parcial — mov ledger + re-busca

Gera 2 movs no ledger (saída nf_venda + ajuste ajuste_pick_zerou),
atualiza siso_pedido_itens com qty pega e flags, dispara re-busca via
realocacao-resolver, cria rows em siso_pedido_item_realocacoes ou
transita pedido pra pendente_realocacao.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: API `POST /api/separacao/marcar-realocacao`

**Files:**
- Create: `src/app/api/separacao/marcar-realocacao/route.ts`

Refere §6.3 do spec.

- [ ] **Step 1: Write the endpoint**

`src/app/api/separacao/marcar-realocacao/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { registrarEvento } from "@/lib/historico-service";
import { resolverProdutoWms } from "@/lib/separacao/wms-mapping";

/**
 * POST /api/separacao/marcar-realocacao
 *
 * Operador marca uma realocação como "peguei". Gera mov de saída
 * (origem nf_venda ou emprestimo) e marca status='picado'.
 *
 * Body: { realocacao_id }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!session.galpaoId) {
    return NextResponse.json({ error: "admin não pode marcar realocação" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.realocacao_id) {
    return NextResponse.json(
      { error: "'realocacao_id' obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // 1. Carrega realocação + item + pedido
    const { data: realoc, error: realocErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select(`
        id, pedido_item_id, empresa_dona_id, galpao_id, localizacao_id,
        quantidade, is_emprestimo, empresa_devedora_id, status
      `)
      .eq("id", body.realocacao_id)
      .single();

    if (realocErr || !realoc) {
      return NextResponse.json({ error: "realocação não encontrada" }, { status: 404 });
    }
    if (realoc.status !== "aguardando_picking") {
      return NextResponse.json(
        { error: `realocação não está aguardando picking (atual: ${realoc.status})` },
        { status: 409 },
      );
    }

    const { data: item } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, quantidade_pedida, quantidade_pega")
      .eq("id", realoc.pedido_item_id)
      .single();
    if (!item) {
      return NextResponse.json({ error: "item pai não encontrado" }, { status: 404 });
    }

    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id")
      .eq("id", item.pedido_id)
      .single();
    if (!pedido) {
      return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });
    }

    // 2. Resolve produto WMS uuid (usa empresa dona da realocação, não a origem)
    const produtoWmsId = await resolverProdutoWms(
      realoc.empresa_dona_id,
      String(item.produto_id),
    );

    // 3. Gera mov de saída
    const mov = await inserirMovimentacao({
      quadrupla: {
        produto_id: produtoWmsId,
        empresa_dona_id: realoc.empresa_dona_id,
        galpao_id: realoc.galpao_id,
        localizacao_id: realoc.localizacao_id,
      },
      tipo: "S",
      qty: realoc.quantidade,
      origem_tipo: realoc.is_emprestimo ? "emprestimo" : "nf_venda",
      origem_id: `pedido:${pedido.id}`,
      origem_detalhes: {
        pedido_numero: pedido.numero,
        pedido_item_id: item.id,
        realocacao_id: realoc.id,
        sku: item.sku,
        contexto: "realocacao",
      },
      emprestimo_devedora_id: realoc.is_emprestimo
        ? realoc.empresa_devedora_id ?? undefined
        : undefined,
      observacoes: realoc.is_emprestimo
        ? `Picking pedido #${pedido.numero} — empréstimo`
        : `Picking pedido #${pedido.numero} — realocação`,
      usuario_id: session.id,
    });

    // 4. Marca realocação como picada
    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .update({
        status: "picado",
        picado_em: nowIso,
        picado_por: session.id,
        mov_saida_id: mov.id,
      })
      .eq("id", realoc.id);

    if (updErr) {
      logger.logError({
        error: updErr,
        source: "separacao-marcar-realocacao",
        message: "Falhou update realocação após mov",
        category: "database",
        requestPath: "/api/separacao/marcar-realocacao",
        requestMethod: "POST",
        metadata: { realocacao_id: realoc.id, mov_id: mov.id },
      });
      return NextResponse.json({ error: "erro persistindo realocação" }, { status: 500 });
    }

    // 5. Atualiza quantidade_pega do item (soma a realocação picada)
    const novaQty = (item.quantidade_pega ?? 0) + realoc.quantidade;
    await supabase
      .from("siso_pedido_itens")
      .update({ quantidade_pega: novaQty })
      .eq("id", item.id);

    // 6. Histórico
    await registrarEvento({
      pedidoId: pedido.id,
      evento: "realocacao_picada",
      detalhes: {
        item_id: item.id,
        realocacao_id: realoc.id,
        sku: item.sku,
        quantidade: realoc.quantidade,
        is_emprestimo: realoc.is_emprestimo,
      },
      usuarioId: session.id,
    });

    return NextResponse.json({ status: "picado", mov_id: mov.id });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-marcar-realocacao",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: "/api/separacao/marcar-realocacao",
      requestMethod: "POST",
      metadata: { realocacao_id: body?.realocacao_id },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Build check**

```bash
npm run build
```

Expected: passa.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/separacao/marcar-realocacao/route.ts
git commit -m "feat(separacao): endpoint POST /marcar-realocacao

Gera mov de saída (nf_venda ou emprestimo) ao confirmar pick da
realocação. Atualiza quantidade_pega do item pai.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: API `DELETE /api/separacao/realocacao/[id]`

**Files:**
- Create: `src/app/api/separacao/realocacao/[id]/route.ts`

Refere §6.4 do spec.

- [ ] **Step 1: Write the endpoint**

`src/app/api/separacao/realocacao/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";

/**
 * DELETE /api/separacao/realocacao/[id]
 *
 * Cancela uma realocação que ainda não foi picada. Não gera estorno
 * (não houve mov). Marca status='cancelado'.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  try {
    const { data: realoc, error: realocErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("id, pedido_item_id, status")
      .eq("id", id)
      .single();
    if (realocErr || !realoc) {
      return NextResponse.json({ error: "realocação não encontrada" }, { status: 404 });
    }
    if (realoc.status !== "aguardando_picking") {
      return NextResponse.json(
        { error: `só pode cancelar realocação aguardando_picking (atual: ${realoc.status})` },
        { status: 409 },
      );
    }

    const { error: updErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .update({ status: "cancelado" })
      .eq("id", id);
    if (updErr) {
      logger.logError({
        error: updErr,
        source: "separacao-realocacao-cancel",
        message: "Falhou cancelar realocação",
        category: "database",
        requestPath: `/api/separacao/realocacao/${id}`,
        requestMethod: "DELETE",
      });
      return NextResponse.json({ error: "erro" }, { status: 500 });
    }

    // Pega pedido_id pra histórico
    const { data: item } = await supabase
      .from("siso_pedido_itens")
      .select("pedido_id, sku")
      .eq("id", realoc.pedido_item_id)
      .single();

    if (item) {
      await registrarEvento({
        pedidoId: item.pedido_id,
        evento: "realocacao_cancelada",
        detalhes: { realocacao_id: id, sku: item.sku },
        usuarioId: session.id,
      });
    }

    return NextResponse.json({ status: "cancelado" });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-realocacao-cancel",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: `/api/separacao/realocacao/${id}`,
      requestMethod: "DELETE",
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Build check**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/separacao/realocacao/
git commit -m "feat(separacao): endpoint DELETE /realocacao/[id] — cancelar pendente

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: API `POST /api/separacao/desfazer-parcial`

**Files:**
- Create: `src/app/api/separacao/desfazer-parcial/route.ts`

Refere §6.5 do spec.

- [ ] **Step 1: Write the endpoint**

`src/app/api/separacao/desfazer-parcial/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { estornarMovimentacao } from "@/lib/wms/ledger";
import { registrarEvento } from "@/lib/historico-service";

/**
 * POST /api/separacao/desfazer-parcial
 *
 * Reverte o estado parcial de um item: estorna mov_saida e mov_ajuste,
 * cancela realocações aguardando_picking. Falha se alguma realocação
 * já foi picada (precisa intervenção manual nesse caso).
 *
 * Body: { pedido_item_id }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.pedido_item_id) {
    return NextResponse.json(
      { error: "'pedido_item_id' obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, sku, separacao_parcial, mov_saida_id, mov_ajuste_loc_zerou_id",
      )
      .eq("id", body.pedido_item_id)
      .single();
    if (itemErr || !item) {
      return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
    }
    if (!item.separacao_parcial) {
      return NextResponse.json(
        { error: "item não está em estado parcial" },
        { status: 409 },
      );
    }

    // Verifica se alguma realocação foi picada
    const { data: realocs } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("id, status")
      .eq("pedido_item_id", item.id);
    const algumaPicada = (realocs ?? []).some((r) => r.status === "picado");
    if (algumaPicada) {
      return NextResponse.json(
        { error: "não pode desfazer — alguma realocação já foi picada" },
        { status: 409 },
      );
    }

    // Estorna movs no ledger
    if (item.mov_saida_id) {
      await estornarMovimentacao({
        mov_id: item.mov_saida_id,
        usuario_id: session.id,
        observacoes: "Desfazer parcial — operador",
      });
    }
    if (item.mov_ajuste_loc_zerou_id) {
      await estornarMovimentacao({
        mov_id: item.mov_ajuste_loc_zerou_id,
        usuario_id: session.id,
        observacoes: "Desfazer parcial (ajuste) — operador",
      });
    }

    // Cancela realocações aguardando
    await supabase
      .from("siso_pedido_item_realocacoes")
      .update({ status: "cancelado" })
      .eq("pedido_item_id", item.id)
      .eq("status", "aguardando_picking");

    // Reset item
    await supabase
      .from("siso_pedido_itens")
      .update({
        separacao_parcial: false,
        parcial_motivo: null,
        parcial_em: null,
        parcial_por: null,
        quantidade_pega: null,
        separacao_marcado: false,
        separacao_marcado_em: null,
        mov_saida_id: null,
        mov_ajuste_loc_zerou_id: null,
      })
      .eq("id", item.id);

    // Se pedido tava em pendente_realocacao, volta pra em_separacao
    await supabase
      .from("siso_pedidos")
      .update({ status_separacao: "em_separacao" })
      .eq("id", item.pedido_id)
      .eq("status_separacao", "pendente_realocacao");

    await registrarEvento({
      pedidoId: item.pedido_id,
      evento: "parcial_desfeito",
      detalhes: { item_id: item.id, sku: item.sku },
      usuarioId: session.id,
    });

    return NextResponse.json({ status: "desfeito" });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-desfazer-parcial",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: "/api/separacao/desfazer-parcial",
      requestMethod: "POST",
      metadata: { pedido_item_id: body?.pedido_item_id },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verificar que `estornarMovimentacao` existe em `src/lib/wms/ledger.ts`**

```bash
grep -n "estornarMovimentacao" src/lib/wms/ledger.ts
```

Expected: encontra export. Se NÃO encontrar, criar:

```typescript
// Em src/lib/wms/ledger.ts, após inserirMovimentacao:
export async function estornarMovimentacao(input: {
  mov_id: string;
  usuario_id: string;
  observacoes?: string;
}): Promise<Movimentacao> {
  const supabase = createServiceClient();
  const { data: original } = await supabase
    .from("siso_movimentacoes")
    .select("*")
    .eq("id", input.mov_id)
    .single();
  if (!original) throw new Error(`mov ${input.mov_id} não encontrada`);
  if (original.estorno_de) throw new Error(`mov ${input.mov_id} já é um estorno`);

  // Verifica se já foi estornada
  const { data: existente } = await supabase
    .from("siso_movimentacoes")
    .select("id")
    .eq("estorno_de", input.mov_id)
    .maybeSingle();
  if (existente) throw new Error(`mov ${input.mov_id} já foi estornada`);

  const tipoInverso = original.tipo === "S" ? "E"
    : original.tipo === "E" ? "S"
    : original.tipo === "R" ? "L"
    : "R";

  return inserirMovimentacao({
    quadrupla: {
      produto_id: original.produto_id,
      empresa_dona_id: original.empresa_dona_id,
      galpao_id: original.galpao_id,
      localizacao_id: original.localizacao_id,
    },
    tipo: tipoInverso as "E" | "S" | "R" | "L",
    qty: Number(original.quantidade),
    origem_tipo: "estorno",
    origem_id: input.mov_id,
    origem_detalhes: { estorno_de: input.mov_id, mov_original_origem: original.origem_tipo },
    observacoes: input.observacoes ?? `Estorno de mov ${input.mov_id}`,
    usuario_id: input.usuario_id,
    estorno_de: input.mov_id,
  });
}
```

(Verificar a interface real de `inserirMovimentacao` em `src/lib/wms/ledger.ts` antes — ajustar nomes de campos se diferente.)

- [ ] **Step 3: Build check**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/separacao/desfazer-parcial/route.ts src/lib/wms/ledger.ts
git commit -m "feat(separacao): endpoint POST /desfazer-parcial + estornarMovimentacao

Reverte estado parcial: estorna movs no ledger, cancela realocações
pendentes, reseta flags do item. Falha se alguma realocação já foi
picada. Adiciona helper estornarMovimentacao em wms/ledger.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Modificar `POST /api/separacao/marcar-item` — gerar mov no ledger

**Files:**
- Modify: `src/app/api/separacao/marcar-item/route.ts`

Refere §6.2 do spec. **Decisão de design:** se WMS tables não existirem (prod), o endpoint segue funcionando sem o lado do ledger. Em staging, gera mov. Detect via try/catch no insert da mov.

- [ ] **Step 1: Read existing implementation**

Já lido (ver Task 4 do brainstorm). Endpoint atual só toggle `separacao_marcado` e atualiza timestamp.

- [ ] **Step 2: Rewrite com geração de mov**

`src/app/api/separacao/marcar-item/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao, estornarMovimentacao } from "@/lib/wms/ledger";
import { resolverProdutoWms, resolverLocalizacaoWms } from "@/lib/separacao/wms-mapping";

/**
 * POST /api/separacao/marcar-item
 *
 * Toggle separacao_marcado. Quando marcado=true E item não é parcial,
 * gera mov de saída no ledger (origem nf_venda). Quando marcado=false,
 * estorna a mov anterior.
 *
 * Body: { pedido_item_id, marcado: boolean }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.pedido_item_id || typeof body.marcado !== "boolean") {
    return NextResponse.json(
      { error: "'pedido_item_id' e 'marcado' obrigatórios" },
      { status: 400 },
    );
  }

  const { pedido_item_id, marcado } = body as {
    pedido_item_id: string;
    marcado: boolean;
  };

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, quantidade_pedida, separacao_parcial, mov_saida_id",
      )
      .eq("id", pedido_item_id)
      .single();
    if (itemErr || !item) {
      return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
    }
    if (item.separacao_parcial) {
      return NextResponse.json(
        { error: "item está em parcial — use /desfazer-parcial antes" },
        { status: 409 },
      );
    }

    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id, separacao_galpao_id, status_separacao")
      .eq("id", item.pedido_id)
      .single();
    if (!pedido) {
      return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });
    }
    const ALLOWED = ["em_separacao", "aguardando_separacao", "aguardando_compra"];
    if (!ALLOWED.includes(pedido.status_separacao ?? "")) {
      return NextResponse.json(
        { error: `pedido status ${pedido.status_separacao} não permite marcar` },
        { status: 400 },
      );
    }

    const empresaOrigemId = pedido.empresa_origem_id;
    const galpaoId = pedido.separacao_galpao_id;
    const nowIso = new Date().toISOString();

    if (marcado) {
      // Gera mov de saída se WMS configurado
      let movSaidaId: string | null = null;
      if (empresaOrigemId && galpaoId) {
        try {
          const produtoWmsId = await resolverProdutoWms(
            empresaOrigemId,
            String(item.produto_id),
          );
          const { data: estoque } = await supabase
            .from("siso_pedido_item_estoques")
            .select("localizacao")
            .eq("pedido_id", pedido.id)
            .eq("produto_id", item.produto_id)
            .eq("empresa_id", empresaOrigemId)
            .maybeSingle();
          const locId = await resolverLocalizacaoWms(galpaoId, estoque?.localizacao ?? null);

          const mov = await inserirMovimentacao({
            quadrupla: {
              produto_id: produtoWmsId,
              empresa_dona_id: empresaOrigemId,
              galpao_id: galpaoId,
              localizacao_id: locId,
            },
            tipo: "S",
            qty: item.quantidade_pedida,
            origem_tipo: "nf_venda",
            origem_id: `pedido:${pedido.id}`,
            origem_detalhes: {
              pedido_numero: pedido.numero,
              pedido_item_id: item.id,
              sku: item.sku,
              contexto: "checkbox",
            },
            observacoes: `Picking pedido #${pedido.numero} — checkbox completo`,
            usuario_id: session.id,
          });
          movSaidaId = mov.id;
        } catch (wmsErr) {
          // WMS não disponível (prod sem tabelas, ou mapping faltando)
          // Log e segue sem mov — toggle do checkbox funciona mesmo assim.
          logger.warn("separacao-marcar-item", "Mov WMS skipped", {
            error: wmsErr instanceof Error ? wmsErr.message : String(wmsErr),
            pedido_item_id,
          });
        }
      }

      const { error: updErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          separacao_marcado: true,
          separacao_marcado_em: nowIso,
          quantidade_pega: item.quantidade_pedida,
          mov_saida_id: movSaidaId,
        })
        .eq("id", item.id);
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 });
      }
    } else {
      // Desmarcar: estorna mov se houver
      if (item.mov_saida_id) {
        try {
          await estornarMovimentacao({
            mov_id: item.mov_saida_id,
            usuario_id: session.id,
            observacoes: "Desmarcar checkbox",
          });
        } catch (estornoErr) {
          logger.warn("separacao-marcar-item", "Estorno WMS falhou", {
            error: estornoErr instanceof Error ? estornoErr.message : String(estornoErr),
            mov_id: item.mov_saida_id,
          });
        }
      }
      const { error: updErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          separacao_marcado: false,
          separacao_marcado_em: null,
          quantidade_pega: null,
          mov_saida_id: null,
        })
        .eq("id", item.id);
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true, marcado });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-marcar-item",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: "/api/separacao/marcar-item",
      requestMethod: "POST",
      metadata: { pedido_item_id, marcado },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Test manualmente — toggle deve funcionar**

```bash
curl -X POST http://localhost:3000/api/separacao/marcar-item \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: <session>" \
  -d '{"pedido_item_id":"<uuid>","marcado":true}' | jq

# Verificar mov criada
psql -c "SELECT id, tipo, qty, origem_tipo, observacoes FROM siso_movimentacoes
WHERE origem_id = 'pedido:<pedido_id>' ORDER BY criado_em DESC LIMIT 3;"

# Desmarcar
curl -X POST http://localhost:3000/api/separacao/marcar-item \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: <session>" \
  -d '{"pedido_item_id":"<uuid>","marcado":false}' | jq

# Conferir estorno
psql -c "SELECT id, tipo, qty, origem_tipo FROM siso_movimentacoes
WHERE estorno_de = '<mov_id>';"
```

Expected: marcar gera mov de saída, desmarcar gera mov de entrada (estorno).

- [ ] **Step 4: Build check**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/separacao/marcar-item/route.ts
git commit -m "feat(separacao): marcar-item gera mov no ledger (saida/estorno)

Marcar checkbox gera mov de saída origem nf_venda; desmarcar gera
estorno. Falha graciosa se WMS não disponível (prod). Bloqueia toggle
se item está em estado parcial (precisa desfazer-parcial antes).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Modificar `GET /api/separacao/checklist-items` — incluir realocações

**Files:**
- Modify: `src/app/api/separacao/checklist-items/route.ts`

Spec menciona em §13: "checklist-items retorna realocações junto com itens".

- [ ] **Step 1: Adicionar query de realocações ao endpoint**

Localizar o ponto após o fetch de `items` (linha ~45) e adicionar:

```typescript
// 1b. Fetch realocações aguardando_picking dos itens
const itemIds = (items ?? []).map((i) => i.id);
const { data: realocacoes } = itemIds.length > 0
  ? await supabase
      .from("siso_pedido_item_realocacoes")
      .select(`
        id, pedido_item_id, empresa_dona_id, galpao_id, localizacao_id,
        quantidade, is_emprestimo, empresa_devedora_id, status, criado_em,
        siso_localizacoes!inner(codigo),
        siso_empresas!siso_pedido_item_realocacoes_empresa_dona_id_fkey(nome)
      `)
      .in("pedido_item_id", itemIds)
      .eq("status", "aguardando_picking")
  : { data: [] };
```

- [ ] **Step 2: Estender campos retornados de cada item**

No `select()` da query principal de `siso_pedido_itens` (linha ~43), adicionar:

```typescript
.select(
  "id, pedido_id, produto_id, sku, gtin, descricao, quantidade_pedida, " +
  "separacao_marcado, separacao_marcado_em, quantidade_bipada, bipado_completo, " +
  "imagem_url, compra_status, " +
  "quantidade_pega, separacao_parcial, parcial_motivo, parcial_em",
)
```

- [ ] **Step 3: Incluir realocações no result final**

No `.map()` final (linha ~161), adicionar:

```typescript
const realocacoesPorItem = new Map<string, any[]>();
for (const r of realocacoes ?? []) {
  const arr = realocacoesPorItem.get(r.pedido_item_id) ?? [];
  const loc = (r.siso_localizacoes as unknown as { codigo: string });
  const empresa = (r.siso_empresas as unknown as { nome: string } | null);
  arr.push({
    id: r.id,
    empresa_dona_id: r.empresa_dona_id,
    empresa_nome: empresa?.nome ?? null,
    localizacao_id: r.localizacao_id,
    localizacao_codigo: loc.codigo,
    quantidade: r.quantidade,
    is_emprestimo: r.is_emprestimo,
    empresa_devedora_id: r.empresa_devedora_id,
    status: r.status,
    criado_em: r.criado_em,
  });
  realocacoesPorItem.set(r.pedido_item_id, arr);
}

const result = visibleItems.map((item) => {
  // ... mantém campos existentes ...
  return {
    // ... campos existentes ...
    quantidade_pega: item.quantidade_pega ?? null,
    separacao_parcial: item.separacao_parcial ?? false,
    parcial_motivo: item.parcial_motivo ?? null,
    parcial_em: item.parcial_em ?? null,
    realocacoes: realocacoesPorItem.get(item.id) ?? [],
  };
});
```

- [ ] **Step 4: Test endpoint**

```bash
curl "http://localhost:3000/api/separacao/checklist-items?pedidos=<id>" \
  -H "X-Session-Id: <session>" | jq '.items[] | {sku, separacao_parcial, realocacoes}'
```

Expected: itens com `separacao_parcial: true` mostram array de realocações com codigo, qty, etc.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/separacao/checklist-items/route.ts
git commit -m "feat(separacao): checklist-items retorna realocacoes + campos parcial

Inclui no response: quantidade_pega, separacao_parcial, parcial_motivo,
parcial_em, e array realocacoes[] (aguardando_picking) com codigo da
loc, empresa nome, is_emprestimo.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Modificar `POST /api/separacao/cancelar` — cuidar de parcial + realocações

**Files:**
- Modify: `src/app/api/separacao/cancelar/route.ts`

Edge case do §8 do spec.

- [ ] **Step 1: Read existing**

```bash
cat src/app/api/separacao/cancelar/route.ts
```

- [ ] **Step 2: Estender lógica de cancelar**

No mesmo arquivo, antes de atualizar `siso_pedido_itens` pra resetar `separacao_marcado`, adicionar:

```typescript
import { estornarMovimentacao } from "@/lib/wms/ledger";

// ... dentro do handler, antes de update de pedido_itens:

// 1. Carrega itens com mov_saida_id ou mov_ajuste_loc_zerou_id
const { data: itensComMovs } = await supabase
  .from("siso_pedido_itens")
  .select("id, mov_saida_id, mov_ajuste_loc_zerou_id, separacao_parcial")
  .in("pedido_id", pedidoIds);

// 2. Estorna movs (mov_saida_id) — NÃO estorna mov_ajuste_loc_zerou_id por design
//    (ajuste reflete descoberta física, vale independentemente).
for (const it of itensComMovs ?? []) {
  if (it.mov_saida_id) {
    try {
      await estornarMovimentacao({
        mov_id: it.mov_saida_id,
        usuario_id: session.id,
        observacoes: "Cancelar separação — estorno automático",
      });
    } catch (e) {
      logger.warn("separacao-cancelar", "Estorno mov_saida falhou", {
        mov_id: it.mov_saida_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// 3. Cancela realocações aguardando_picking
//    Para realocações JÁ picadas, também estorna a mov (operação está sendo cancelada).
const { data: realocs } = await supabase
  .from("siso_pedido_item_realocacoes")
  .select("id, status, mov_saida_id, pedido_item_id")
  .in("pedido_item_id", (itensComMovs ?? []).map((i) => i.id));

for (const r of realocs ?? []) {
  if (r.status === "picado" && r.mov_saida_id) {
    try {
      await estornarMovimentacao({
        mov_id: r.mov_saida_id,
        usuario_id: session.id,
        observacoes: "Cancelar separação — estorno realocação picada",
      });
    } catch (e) {
      logger.warn("separacao-cancelar", "Estorno realocação falhou", {
        realocacao_id: r.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

await supabase
  .from("siso_pedido_item_realocacoes")
  .update({ status: "cancelado" })
  .in("pedido_item_id", (itensComMovs ?? []).map((i) => i.id))
  .neq("status", "cancelado");
```

E no `.update()` existente de `siso_pedido_itens`, adicionar reset dos campos novos:

```typescript
.update({
  separacao_marcado: false,
  separacao_marcado_em: null,
  bipado_completo: false,
  quantidade_bipada: 0,
  // NOVOS:
  separacao_parcial: false,
  parcial_motivo: null,
  parcial_em: null,
  parcial_por: null,
  quantidade_pega: null,
  mov_saida_id: null,
  mov_ajuste_loc_zerou_id: null,
})
```

- [ ] **Step 3: Build check**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/separacao/cancelar/route.ts
git commit -m "feat(separacao): cancelar trata parcial + realocações (estorno movs)

Ao cancelar onda, estorna mov_saida (mantém ajuste_pick_zerou — reflete
descoberta física), estorna realocações picadas, cancela
aguardando_picking, reseta campos novos de pedido_itens.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Componente `parcial-modal.tsx`

**Files:**
- Create: `src/components/separacao/parcial-modal.tsx`

Refere §4.2 do spec.

- [ ] **Step 1: Write the component**

`src/components/separacao/parcial-modal.tsx`:

```typescript
"use client";

import { useState, useEffect } from "react";
import { X, Plus, Minus, Loader2 } from "lucide-react";

interface ParcialModalProps {
  open: boolean;
  sku: string;
  localizacao: string | null;
  quantidadePedida: number;
  loading: boolean;
  onConfirm: (qtyPega: number, locZerou: boolean) => void;
  onCancel: () => void;
}

export function ParcialModal({
  open,
  sku,
  localizacao,
  quantidadePedida,
  loading,
  onConfirm,
  onCancel,
}: ParcialModalProps) {
  const [qty, setQty] = useState(quantidadePedida);
  const [locZerou, setLocZerou] = useState(false);

  useEffect(() => {
    if (open) {
      setQty(quantidadePedida);
      setLocZerou(false);
    }
  }, [open, quantidadePedida]);

  useEffect(() => {
    // Auto-marca loc zerou se qty < esperada
    if (qty < quantidadePedida) {
      setLocZerou(true);
    }
  }, [qty, quantidadePedida]);

  if (!open) return null;

  const handleQtyChange = (delta: number) => {
    setQty((prev) => Math.max(0, Math.min(quantidadePedida, prev + delta)));
  };

  const handleManualQty = (val: string) => {
    const n = parseInt(val, 10);
    if (isNaN(n)) return;
    setQty(Math.max(0, Math.min(quantidadePedida, n)));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {sku}
            </h2>
            {localizacao && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Loc: {localizacao}
              </p>
            )}
          </div>
          <button
            onClick={onCancel}
            disabled={loading}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Quantas unidades você conseguiu pegar?
        </p>

        <div className="mb-4 flex items-center justify-center gap-3">
          <button
            onClick={() => handleQtyChange(-1)}
            disabled={loading || qty <= 0}
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 hover:bg-zinc-200 disabled:opacity-40 dark:bg-zinc-800 dark:text-zinc-300"
          >
            <Minus className="h-5 w-5" />
          </button>
          <input
            type="number"
            value={qty}
            min={0}
            max={quantidadePedida}
            onChange={(e) => handleManualQty(e.target.value)}
            disabled={loading}
            className="w-24 rounded-xl border border-zinc-200 bg-white py-3 text-center text-3xl font-bold text-zinc-900 focus:border-amber-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <button
            onClick={() => handleQtyChange(1)}
            disabled={loading || qty >= quantidadePedida}
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 hover:bg-zinc-200 disabled:opacity-40 dark:bg-zinc-800 dark:text-zinc-300"
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
          de <strong>{quantidadePedida}</strong> esperadas
        </p>

        <label className="mb-4 flex items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 cursor-pointer dark:border-zinc-700 dark:bg-zinc-800/50">
          <input
            type="checkbox"
            checked={locZerou}
            onChange={(e) => setLocZerou(e.target.checked)}
            disabled={loading}
            className="h-4 w-4 rounded border-zinc-300"
          />
          <span className="text-sm text-zinc-700 dark:text-zinc-300">
            {qty === 0
              ? "Esta loc estava vazia"
              : "Esta loc zerou (não tem mais)"}
          </span>
        </label>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 rounded-xl border border-zinc-200 py-3 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancelar
          </button>
          <button
            onClick={() => onConfirm(qty, locZerou)}
            disabled={loading}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-amber-600 py-3 font-medium text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build check**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/separacao/parcial-modal.tsx
git commit -m "feat(separacao): componente ParcialModal — qty + loc zerou

Modal compacto com stepper +/- de quantidade (range 0..qty_pedida),
checkbox 'loc zerou' (auto-marca se qty < esperada), Cancelar e
Confirmar. Cor amarela (amber) pra distinguir de Esgotado (vermelho).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Integrar Parcial no checklist + renderizar realocações

**Files:**
- Modify: `src/app/separacao/checklist/page.tsx`

Refere §4.1 e §4.3 do spec.

- [ ] **Step 1: Adicionar tipo Realocacao + estender ChecklistItem**

No topo do arquivo, perto dos types existentes (linha ~35):

```typescript
interface Realocacao {
  id: string;
  empresa_dona_id: string;
  empresa_nome: string | null;
  localizacao_id: string;
  localizacao_codigo: string;
  quantidade: number;
  is_emprestimo: boolean;
  empresa_devedora_id: string | null;
  status: string;
  criado_em: string;
}

interface ChecklistItem {
  id: string;
  pedido_id: string;
  produto_id: string;
  sku: string;
  gtin: string | null;
  descricao: string;
  quantidade: number;
  separacao_marcado: boolean;
  separacao_marcado_em: string | null;
  localizacao: string | null;
  imagem_url: string | null;
  empresa_origem_id: string | null;
  saldo: number;
  disponivel: number;
  galpao_nome: string | null;
  compra_status: string | null;
  // NOVOS:
  quantidade_pega: number | null;
  separacao_parcial: boolean;
  parcial_motivo: string | null;
  parcial_em: string | null;
  realocacoes: Realocacao[];
}
```

- [ ] **Step 2: Importar ParcialModal e adicionar estado**

```typescript
import { ParcialModal } from "@/components/separacao/parcial-modal";

// Dentro do componente:
const [parcialModal, setParcialModal] = useState<{
  itemId: string;
  sku: string;
  localizacao: string | null;
  quantidade: number;
  loading: boolean;
} | null>(null);
```

- [ ] **Step 3: Handler de Parcial**

```typescript
async function handleParcialConfirm(qtyPega: number, locZerou: boolean) {
  if (!parcialModal) return;
  setParcialModal((prev) => prev ? { ...prev, loading: true } : null);

  try {
    const res = await sisoFetch("/api/separacao/parcial", {
      method: "POST",
      body: JSON.stringify({
        pedido_item_id: parcialModal.itemId,
        quantidade_pega: qtyPega,
        loc_zerou: locZerou,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      toast.error(data.error ?? "Erro ao processar parcial");
      setParcialModal(null);
      return;
    }

    if (data.status === "completo") {
      toast.success("Item marcado como completo");
    } else if (data.status === "realocado") {
      const locs = data.realocacoes.map((r: any) => r.localizacao_codigo).join(", ");
      toast.success(`Achei ${data.realocacoes.length} loc(s): ${locs} — adicionado ao fim`);
    } else if (data.status === "aguardando_supervisor") {
      toast.warning("Sem cobertura — pedido voltou pro painel SISO", { duration: 6000 });
    }

    setParcialModal(null);
    queryClient.invalidateQueries({ queryKey: ["checklist-items"] });
  } catch (err) {
    toast.error("Erro de rede");
    setParcialModal(null);
  }
}

async function handleMarcarRealocacao(realocacaoId: string) {
  try {
    const res = await sisoFetch("/api/separacao/marcar-realocacao", {
      method: "POST",
      body: JSON.stringify({ realocacao_id: realocacaoId }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Erro");
      return;
    }
    toast.success("Realocação picada");
    queryClient.invalidateQueries({ queryKey: ["checklist-items"] });
  } catch {
    toast.error("Erro de rede");
  }
}
```

- [ ] **Step 4: Construir lista combinada (itens + realocações no fim)**

Localizar o `useMemo` de `consolidatedProducts` (provavelmente linha 200~) e estender pra incluir realocações:

```typescript
const itemsERealocacoes = useMemo(() => {
  if (!items) return [];

  // Items normais (mantém ordenação atual)
  const normaisOrdenados = [...items];
  if (sort === "localizacao") {
    normaisOrdenados.sort((a, b) =>
      naturalLocCompare(a.localizacao ?? "ZZ", b.localizacao ?? "ZZ"),
    );
  }
  // (manter outros sorts do código atual)

  // Realocações aguardando_picking — sempre vão no FIM, sem reordenar
  type LinhaRealocacao = {
    _kind: "realocacao";
    id: string;
    parent_item: ChecklistItem;
    realocacao: Realocacao;
  };
  type LinhaItem = { _kind: "item"; item: ChecklistItem };
  type Linha = LinhaItem | LinhaRealocacao;

  const linhas: Linha[] = normaisOrdenados.map((i) => ({ _kind: "item" as const, item: i }));

  for (const item of normaisOrdenados) {
    for (const r of item.realocacoes ?? []) {
      if (r.status === "aguardando_picking") {
        linhas.push({ _kind: "realocacao" as const, id: r.id, parent_item: item, realocacao: r });
      }
    }
  }

  return linhas;
}, [items, sort]);
```

- [ ] **Step 5: Renderizar card com botão Parcial + badges**

Na renderização da lista, atualizar o card pra adicionar botão Parcial e badges:

```typescript
{itemsERealocacoes.map((linha) => {
  if (linha._kind === "realocacao") {
    const r = linha.realocacao;
    const item = linha.parent_item;
    return (
      <div
        key={`realoc-${r.id}`}
        className="rounded-xl border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900/40 dark:bg-amber-950/20"
      >
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            onChange={() => handleMarcarRealocacao(r.id)}
            className="h-5 w-5 rounded border-zinc-300"
          />
          <ProductImageZoom src={item.imagem_url} alt={item.sku} />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{item.sku}</span>
              <span className="rounded-md bg-amber-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900">
                Realocada
              </span>
              {r.is_emprestimo && (
                <span className="rounded-md bg-cyan-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-900">
                  Empréstimo
                </span>
              )}
            </div>
            <div className="text-sm text-zinc-600 dark:text-zinc-400">
              {r.localizacao_codigo}
              {r.empresa_nome && r.is_emprestimo && (
                <span className="ml-1">({r.empresa_nome})</span>
              )}
              <span className="ml-2 text-xs">originada de {item.localizacao}</span>
            </div>
          </div>
          <div className="text-xl font-bold">{r.quantidade}</div>
        </div>
      </div>
    );
  }

  const item = linha.item;
  const isParcial = item.separacao_parcial;
  return (
    <div
      key={item.id}
      className={cn(
        "rounded-xl border p-3",
        item.separacao_marcado && "opacity-60",
        isParcial && "border-amber-300 bg-amber-50/30",
      )}
    >
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={item.separacao_marcado}
          onChange={(e) => handleCheckboxToggle(item.id, e.target.checked)}
          disabled={isParcial}
          className="h-5 w-5 rounded border-zinc-300"
        />
        <ProductImageZoom src={item.imagem_url} alt={item.sku} />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{item.sku}</span>
            {isParcial && (
              <span className="rounded-md bg-amber-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900">
                Parcial {item.quantidade_pega}/{item.quantidade}
              </span>
            )}
          </div>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            {item.descricao}
          </div>
          <div className="text-xs text-zinc-500">
            {item.localizacao}{" "}
            {isParcial
              ? `· loc zerada às ${item.parcial_em && new Date(item.parcial_em).toLocaleTimeString()}`
              : `· saldo ${item.saldo}`}
          </div>
        </div>
        <div className="text-xl font-bold mr-3">
          {isParcial ? item.quantidade_pega : item.quantidade}
        </div>
        {!item.separacao_marcado && !isParcial && (
          <>
            <button
              onClick={() =>
                setParcialModal({
                  itemId: item.id,
                  sku: item.sku,
                  localizacao: item.localizacao,
                  quantidade: item.quantidade,
                  loading: false,
                })
              }
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              Parcial
            </button>
            <button
              onClick={() => handleEsgotado(item.sku)}
              className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
            >
              Esgotado
            </button>
          </>
        )}
      </div>
    </div>
  );
})}

{/* Modal */}
{parcialModal && (
  <ParcialModal
    open
    sku={parcialModal.sku}
    localizacao={parcialModal.localizacao}
    quantidadePedida={parcialModal.quantidade}
    loading={parcialModal.loading}
    onConfirm={handleParcialConfirm}
    onCancel={() => setParcialModal(null)}
  />
)}
```

(Os nomes exatos de helpers como `handleCheckboxToggle`, `handleEsgotado`, `naturalLocCompare`, `ProductImageZoom` devem corresponder ao que já existe na page. Adaptar onde divergir.)

- [ ] **Step 6: Test manual no browser**

```bash
npm run dev
```

Abrir `http://localhost:3000/separacao/checklist?pedidos=<id>` e validar:
1. Card mostra botões Parcial + Esgotado.
2. Clicar Parcial abre o modal com stepper.
3. Diminuir qty marca checkbox "loc zerou" automaticamente.
4. Confirmar dispara API; toast aparece; lista re-renderiza.
5. Linha original fica com badge "Parcial 3/5" + opacity reduzida.
6. Nova linha "Realocada" aparece no FIM da lista com badge.
7. Clicar checkbox da realocada dispara `marcar-realocacao`.

- [ ] **Step 7: Commit**

```bash
git add src/app/separacao/checklist/page.tsx
git commit -m "feat(separacao): UI Parcial — botão, modal, badges, realocações

Adiciona botão Parcial ao card (amarelo, ao lado de Esgotado). Renderiza
realocações no fim da lista com badge Realocada + Empréstimo quando
aplicável. Item parcial fica com badge Parcial X/Y. Integra ParcialModal.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Painel SISO — badge "Realocação" pra `pendente_realocacao`

**Files:**
- Modify: `src/app/siso/page.tsx`
- Modify: `src/components/pedido/pedido-card.tsx`

Refere §5.4 do spec.

- [ ] **Step 1: Estender query do painel SISO**

Localizar onde `/siso` fetcha pedidos pra a aba "Pendente" e garantir que inclui `status_separacao = 'pendente_realocacao'`. Provavelmente em `src/app/siso/page.tsx` ou via `/api/pedidos` — verificar:

```bash
grep -rn "pendente_realocacao\|status_separacao" src/app/siso/ src/app/api/pedidos/ 2>/dev/null
```

Se não tem suporte, adicionar:

```typescript
// Em src/app/api/pedidos/route.ts ou no SQL filter da aba Pendente:
// Pedidos a exibir na aba Pendente: status='pendente' OR status_separacao='pendente_realocacao'
```

- [ ] **Step 2: Badge no card do pedido**

Em `src/components/pedido/pedido-card.tsx`, perto de onde outros badges aparecem (decisão, transferência, etc.):

```typescript
{pedido.status_separacao === "pendente_realocacao" && (
  <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
    Realocação
  </span>
)}
```

- [ ] **Step 3: Detalhe da realocação na expansão (opcional, low priority)**

Adicionar componente em `src/components/pedido/pedido-card.tsx` mostrando o que falta cobrir (qty residual, item, onde sistema procurou). Pode reusar `siso_pedido_item_realocacoes` joins ou criar endpoint dedicado `/api/pedidos/[id]/realocacao-pending`:

```typescript
// Pseudo:
const { data: itensComResidual } = useQuery(...) // busca itens com separacao_parcial=true
// Renderiza: "SKU-X precisa de N unidades — sistema procurou no galpão Y e [não achou | só achou em CWB]"
```

Esta visualização é "nice to have" — pode ficar pra um follow-up se prazo apertar. O badge "Realocação" no card já indica e supervisor pode clicar pra ver detalhes do pedido.

- [ ] **Step 4: Test manual**

Criar um cenário onde uma re-busca falha (não tem SKU em nenhuma outra loc do galpão). Confirmar:
1. Após Parcial, pedido transita pra `pendente_realocacao`.
2. Pedido aparece em `/siso` na aba Pendente com badge "Realocação".

- [ ] **Step 5: Commit**

```bash
git add src/app/siso/page.tsx src/components/pedido/pedido-card.tsx
git commit -m "feat(siso): badge 'Realocação' pra pedidos em pendente_realocacao

Pedidos que saíram da onda após short pick sem cobertura aparecem na
aba Pendente com badge amarelo identificador.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Atualizar documentação

**Files:**
- Modify: `docs/api-reference-complete.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/architecture-and-flows.md`
- Modify: `docs/fluxos-siso.md`
- Modify: `CLAUDE.md`

CLAUDE.md exige doc updates pra qualquer mudança de API/schema/flow.

- [ ] **Step 1: Adicionar 4 novos endpoints em api-reference-complete.md**

Endpoints a documentar:
- `POST /api/separacao/parcial` — body, response, errors, side effects (movs, realocações, histórico)
- `POST /api/separacao/marcar-realocacao` — body, response, mov gerada
- `DELETE /api/separacao/realocacao/[id]` — params, cancelamento
- `POST /api/separacao/desfazer-parcial` — body, estorno automático

E atualizar:
- `POST /api/separacao/marcar-item` — agora gera mov de saída no ledger
- `GET /api/separacao/checklist-items` — agora retorna `realocacoes[]` e campos parcial

- [ ] **Step 2: Atualizar database-schema.md**

Adicionar:
- Nova tabela `siso_pedido_item_realocacoes` (colunas, FKs, constraints, indexes).
- Novas colunas em `siso_pedido_itens` (7 colunas).
- Novo `origem_tipo`: `ajuste_pick_zerou` em `siso_movimentacoes`.
- Novo status: `pendente_realocacao` em `siso_pedidos.status_separacao`.
- ER diagram (se houver) atualizado.

- [ ] **Step 3: Atualizar architecture-and-flows.md**

Adicionar seção "Short pick + re-alocação por loc" com fluxograma + descrição do algoritmo de re-busca.

- [ ] **Step 4: Atualizar fluxos-siso.md**

Atualizar o diagrama Mermaid de status do pedido pra incluir `pendente_realocacao`.

- [ ] **Step 5: Atualizar CLAUDE.md**

Na seção "Project Structure":
```
src/lib/separacao/
  wms-mapping.ts                 # Resolve Tiny produto/loc → uuids WMS
  realocacao-resolver.ts         # Algoritmo de re-busca cascade
src/components/separacao/
  parcial-modal.tsx              # Modal de qty + loc zerou (Parcial)
```

Adicionar `siso_pedido_item_realocacoes` na lista de tabelas.

- [ ] **Step 6: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: pick multi-loc — endpoints, schema, fluxos, project structure

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Validação E2E em staging

**Files:** N/A — apenas validação manual

- [ ] **Step 1: Deploy ao staging**

```bash
git push origin develop
# Vercel auto-deploy do `develop` aponta pra Supabase staging (ehbxpbeijofxtsbezwxd)
```

- [ ] **Step 2: Preparar dados de teste**

Em staging, garantir que existe:
- Um pedido em `em_separacao` com SKU presente em múltiplas locs WMS (mesma empresa).
- Um pedido com SKU em locs de empresas DIFERENTES do mesmo grupo (testar empréstimo).
- Um pedido com SKU em apenas uma loc (testar cenário sem cobertura).

Comando pra explorar:
```sql
-- Pedidos em em_separacao
SELECT id, numero, empresa_origem_id, separacao_galpao_id
FROM siso_pedidos WHERE status_separacao = 'em_separacao' LIMIT 5;

-- Itens com SKU em múltiplas locs
SELECT pi.id, pi.sku, pi.quantidade_pedida,
  COUNT(DISTINCT e.localizacao_id) AS num_locs
FROM siso_pedido_itens pi
JOIN siso_pedido_item_estoques pe ON pe.produto_id = pi.produto_id AND pe.pedido_id = pi.pedido_id
JOIN siso_produto_empresas pem ON pem.tiny_produto_id::text = pi.produto_id::text
JOIN siso_estoque e ON e.produto_id = pem.produto_id AND e.disponivel > 0
WHERE pi.separacao_marcado = false
GROUP BY pi.id, pi.sku, pi.quantidade_pedida
HAVING COUNT(DISTINCT e.localizacao_id) > 1
LIMIT 5;
```

Se faltar cenário, criar manualmente via UI `/wms/receber` (mover estoque entre locs).

- [ ] **Step 3: Executar os 4 cenários**

Cenário 1 — pegou parte, achou na mesma empresa:
- Abrir checklist do pedido, clicar Parcial num SKU, qty < esperada, confirmar.
- Validar toast "Achei N em LOC".
- Validar linha original com badge "Parcial".
- Validar nova linha "Realocada" no fim.
- Conferir ledger:
  ```sql
  SELECT tipo, qty, empresa_dona_id, localizacao_id, origem_tipo, observacoes
  FROM siso_movimentacoes WHERE origem_id = 'pedido:<id>' ORDER BY criado_em;
  ```
  Expected: 2 movs (saída nf_venda + ajuste ajuste_pick_zerou). Saldo da loc original = 0.
- Marcar checkbox da realocada → +1 mov. Saldo da loc nova decrementado.

Cenário 2 — pegou parte, empréstimo entre empresas:
- Mesmo fluxo. Linha realocada deve mostrar badge "Empréstimo".
- Conferir mov:
  ```sql
  SELECT origem_tipo, emprestimo_devedora_id FROM siso_movimentacoes
  WHERE origem_id = 'pedido:<id>' AND emprestimo_devedora_id IS NOT NULL;
  ```
  Expected: 1 row com origem `emprestimo` + empresa devedora.
- Conferir saldo devedor:
  ```sql
  SELECT * FROM wms_saldos_devedores();
  ```

Cenário 3 — sem cobertura no galpão:
- Pedido com SKU em loc única, sem outras locs.
- Clicar Parcial qty=0, loc_zerou=true.
- Toast "Sem cobertura — pedido voltou pro painel SISO".
- Pedido some da onda.
- Validar em `/siso`:
  ```sql
  SELECT id, numero, status_separacao FROM siso_pedidos WHERE id = '<id>';
  ```
  Expected: status_separacao = `pendente_realocacao`. Badge no card.

Cenário 4 — desfazer parcial:
- Após cenário 1 (antes de marcar realocação), clicar desfazer (via UI ou curl).
- Conferir:
  - Item volta pra `separacao_marcado=false, separacao_parcial=false, quantidade_pega=null`.
  - 2 estornos no ledger (entrada origem `estorno`).
  - Realocações em `cancelado`.

- [ ] **Step 4: Documentar resultado em PR description ou erros-conhecidos.yaml se houver bug**

Anotar em `erros-conhecidos.yaml` qualquer bug encontrado e fix aplicado.

- [ ] **Step 5: Final commit (se algum fix surgiu)**

```bash
git add .
git commit -m "fix(separacao): ajustes pós-E2E em staging

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin develop
```

---

## Resumo: ordem de execução e dependências

```
Task 1 (migration) ── Task 2 (tipo) ── Task 3 (wms-mapping) ┐
                                                              ├─→ Task 5 (parcial) ──┐
                                       Task 4 (resolver) ────┤                       │
                                                              │                       ├─→ Task 9 (marcar-item) ─→ Task 11 (cancelar)
                                                              │   Task 6 (marcar-r) ─┤
                                                              │   Task 7 (delete-r) ─┤
                                                              │   Task 8 (desfazer) ─┘
                                                              │
                                                              └─→ Task 10 (checklist-items) ─→ Task 12 (modal) ─→ Task 13 (checklist UI)
                                                                                                                 │
                                                                                                                 └─→ Task 14 (painel) ─→ Task 15 (docs) ─→ Task 16 (E2E)
```

Tasks 5/6/7/8 são independentes entre si após task 3+4. Podem rodar em paralelo se com agentes diferentes. Tasks de docs (15) podem ser feitas progressivamente após cada implementação.

**Crítico:** Task 1 (migration) precisa rodar antes de QUALQUER outra task. Tasks 2-4 antes de qualquer API. Tasks 12 (modal) antes de 13 (page integration).

---

## Limitações conhecidas (out of scope desta release)

1. **Parcial recursivo numa realocação.** Se a loc da realocação também zerar (spec §8 edge case), o operador não tem botão Parcial na linha da realocada — só checkbox e cancelar. Workaround: cancelar a realocação via DELETE; supervisor decide manualmente no painel SISO (qty residual fica descoberta). Plano de follow-up: novo endpoint `POST /api/separacao/realocacao/[id]/parcial` que aceita qty parcial sobre uma realocação, gera mov de ajuste no ledger e dispara nova re-busca.

2. **Detalhe rico no painel SISO pra `pendente_realocacao`** (Task 14 step 3 — opcional). Mostra apenas badge identificador. Listagem do que faltou + onde sistema procurou + onde tem saldo em outros galpões fica como follow-up.

3. **Métricas/dashboard de short pick.** Spec §3 decidiu "só histórico padrão". Sem dashboard. Se volume de Parciais virar dor, criar card em `/painel/gerencial` em iteração futura.

4. **Audit de empréstimos cumulativos.** O Plano 3 (`wms_saldos_devedores`) já mostra a dívida líquida, mas não há trigger automático pra zerar (cobrança/transferência reversa). Fora de escopo dessa feature.

5. **Resolução de loc em prod (sem WMS).** Task 9 (marcar-item modificado) tem try/catch que silencia falha de WMS — em prod o checkbox segue funcionando mas sem mov no ledger. Comportamento esperado durante a transição (Plano 6 cutover resolve).
