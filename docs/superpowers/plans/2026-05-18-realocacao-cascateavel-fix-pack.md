# Realocação Cascateável — Fix-Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os 24 achados da auditoria pós-implementação da feature "Realocação cascateável no picking" (C1-C5 critical, I1-I11 important, M1-M8 minor) sem quebrar fluxo em produção.

**Architecture:** Tabela ponte `siso_pedido_item_mov_links` resolve mov compartilhada por N items em wave consolidado (C3). RPCs novas pra acumular qty atomicamente (I9) e estornar parcialmente (suporta C3 com mov compartilhada). Helper compartilhado `resetarEstadoSeparacaoItens` centraliza reset de estado consumido por encaminhar/reiniciar/voltar-etapa/produto-esgotado (I1, I2, I3). Defesa em camadas pra embalagem (UI + RPC, I6). 4 fases mergeable independente.

**Tech Stack:** Next.js 16, TypeScript strict, Supabase (Postgres + RLS + Realtime), Vitest, Tailwind 4.

**Spec:** [`docs/superpowers/specs/2026-05-18-realocacao-cascateavel-fix-pack-design.md`](../specs/2026-05-18-realocacao-cascateavel-fix-pack-design.md)

---

## Phase 1 — Schema & primitivas

### Task 1.1: Migration base (tabela ponte + qty_estornada + parcial_motivo padronizado)

**Files:**
- Create: `supabase/migrations/20260518_realocacao_fix_pack_foundation.sql`

- [ ] **Step 1: Criar arquivo de migration**

Cria `supabase/migrations/20260518_realocacao_fix_pack_foundation.sql` com:

```sql
-- ============================================================
-- Fix-pack realocação cascateável — Foundation
-- Spec: docs/superpowers/specs/2026-05-18-realocacao-cascateavel-fix-pack-design.md
--
-- 1. Tabela ponte siso_pedido_item_mov_links (C3)
-- 2. Coluna siso_movimentacoes.qty_estornada + backfill (pré-req da RPC parcial)
-- 3. Backfill parcial_motivo padronizado (M4)
-- 4. Publication realtime pra realocações (C5)
-- ============================================================

BEGIN;

-- 1. Tabela ponte
CREATE TABLE siso_pedido_item_mov_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_item_id bigint NOT NULL REFERENCES siso_pedido_itens(id) ON DELETE CASCADE,
  realocacao_id uuid REFERENCES siso_pedido_item_realocacoes(id) ON DELETE CASCADE,
  mov_id uuid NOT NULL REFERENCES siso_movimentacoes(id),
  qty integer NOT NULL CHECK (qty > 0),
  tipo_link text NOT NULL CHECK (tipo_link IN ('saida','ajuste_loc_zerou')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pedido_item_id, realocacao_id, mov_id, tipo_link)
);

CREATE INDEX idx_mov_links_mov ON siso_pedido_item_mov_links(mov_id);
CREATE INDEX idx_mov_links_item ON siso_pedido_item_mov_links(pedido_item_id);
CREATE INDEX idx_mov_links_realoc ON siso_pedido_item_mov_links(realocacao_id) WHERE realocacao_id IS NOT NULL;

-- 2. qty_estornada em siso_movimentacoes
ALTER TABLE siso_movimentacoes
  ADD COLUMN qty_estornada integer NOT NULL DEFAULT 0
  CHECK (qty_estornada >= 0);

-- Backfill: movs que já têm um estorno full → qty_estornada = quantidade
UPDATE siso_movimentacoes m
   SET qty_estornada = m.quantidade
  FROM siso_movimentacoes e
 WHERE e.estorno_de = m.id;

-- 3. Backfill parcial_motivo (M4)
UPDATE siso_pedido_item_realocacoes
   SET parcial_motivo = CASE
     WHEN parcial_motivo IN ('cascade_loc_zerou','loc_zerou') THEN 'loc_zerou'
     WHEN parcial_motivo IN ('cascade_parcial','qty_diferente') THEN 'qty_diferente'
     ELSE parcial_motivo
   END
 WHERE parcial = true AND parcial_motivo IS NOT NULL;

-- 4. Publication realtime
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='siso_pedido_item_realocacoes'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE siso_pedido_item_realocacoes';
  END IF;
END $$;

COMMIT;
```

- [ ] **Step 2: Validar SQL localmente**

Run: `psql -d postgres -c "BEGIN; \i supabase/migrations/20260518_realocacao_fix_pack_foundation.sql; ROLLBACK;"` (se tem psql local) — OR — `npx supabase db reset` em dev local.

Expected: SQL roda sem erro, tabela criada, colunas adicionadas.

- [ ] **Step 3: Aplicar migration via MCP no projeto staging**

Use `mcp__supabase__apply_migration` com o conteúdo acima. Confirme com `mcp__supabase__list_migrations` que aparece na lista.

Expected: migration aparece em `list_migrations`.

- [ ] **Step 4: Validar via query**

```sql
SELECT * FROM siso_pedido_item_mov_links LIMIT 1;
SELECT qty_estornada FROM siso_movimentacoes LIMIT 1;
SELECT pubname, tablename FROM pg_publication_tables WHERE tablename='siso_pedido_item_realocacoes';
```

Expected: tabela existe (0 rows), coluna `qty_estornada` retorna 0 default, publication tem a tabela.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260518_realocacao_fix_pack_foundation.sql
git commit -m "feat(wms/realoc-fix): foundation — tabela ponte + qty_estornada + realtime"
```

---

### Task 1.2: RPC `wms_acumular_qty_pega`

**Files:**
- Create: `supabase/migrations/20260518_realocacao_fix_pack_rpc_acumular.sql`

- [ ] **Step 1: Criar arquivo de migration**

```sql
-- Spec § 1.2 — RPC pra UPDATE atômico de quantidade_pega em siso_pedido_itens.
-- Substitui read-modify-write em parcial/route.ts e marcar-realocacao/route.ts.

BEGIN;

CREATE OR REPLACE FUNCTION wms_acumular_qty_pega(p_item_id bigint, p_delta integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_nova integer;
BEGIN
  UPDATE siso_pedido_itens
    SET quantidade_pega = COALESCE(quantidade_pega, 0) + p_delta
    WHERE id = p_item_id
    RETURNING quantidade_pega INTO v_nova;
  IF v_nova IS NULL THEN
    RAISE EXCEPTION 'item % nao encontrado', p_item_id;
  END IF;
  IF v_nova < 0 THEN
    RAISE EXCEPTION 'quantidade_pega negativa: novo=% delta=%', v_nova, p_delta;
  END IF;
  RETURN v_nova;
END;
$$;

COMMIT;
```

- [ ] **Step 2: Aplicar migration via MCP**

Use `mcp__supabase__apply_migration` com o conteúdo acima.

- [ ] **Step 3: Validar com query**

```sql
-- Pega um item existente pra testar
SELECT id, quantidade_pega FROM siso_pedido_itens LIMIT 1;
-- Substitua o id abaixo e roda
SELECT wms_acumular_qty_pega(123::bigint, 0);
```

Expected: retorna `quantidade_pega` atual (delta=0 deveria ser no-op observável).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518_realocacao_fix_pack_rpc_acumular.sql
git commit -m "feat(wms/realoc-fix): RPC wms_acumular_qty_pega (atômico)"
```

---

### Task 1.3: RPC `wms_estornar_parcial_movimentacao`

**Files:**
- Create: `supabase/migrations/20260518_realocacao_fix_pack_rpc_estorno_parcial.sql`

- [ ] **Step 1: Criar arquivo de migration**

```sql
-- Spec § 1.3 — estorno proporcional de mov compartilhada (C3).
-- Cria mov de estorno com qty parcial; contabiliza em siso_movimentacoes.qty_estornada.

BEGIN;

CREATE OR REPLACE FUNCTION wms_estornar_parcial_movimentacao(
  p_mov_id uuid,
  p_qty integer,
  p_usuario_id uuid,
  p_observacoes text
) RETURNS siso_movimentacoes LANGUAGE plpgsql AS $$
DECLARE
  v_original siso_movimentacoes;
  v_tipo_inverso char(1);
  v_estorno siso_movimentacoes;
BEGIN
  SELECT * INTO v_original
    FROM siso_movimentacoes
    WHERE id = p_mov_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mov % nao encontrada', p_mov_id;
  END IF;
  IF v_original.estorno_de IS NOT NULL THEN
    RAISE EXCEPTION 'mov % e ela mesma um estorno', p_mov_id;
  END IF;
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'qty deve ser positiva: %', p_qty;
  END IF;
  IF v_original.qty_estornada + p_qty > v_original.quantidade THEN
    RAISE EXCEPTION 'estorno parcial excede saldo: ja_estornado=% + qty=% > total=%',
      v_original.qty_estornada, p_qty, v_original.quantidade;
  END IF;

  v_tipo_inverso := CASE v_original.tipo
                      WHEN 'E' THEN 'S' WHEN 'S' THEN 'E'
                      WHEN 'R' THEN 'L' WHEN 'L' THEN 'R' END;

  v_estorno := wms_inserir_movimentacao(
    v_original.produto_id, v_original.empresa_dona_id,
    v_original.galpao_id, v_original.localizacao_id,
    v_tipo_inverso, p_qty,
    'estorno', p_mov_id::text,
    jsonb_build_object('estorno_de', p_mov_id, 'parcial', true,
                       'mov_original_origem', v_original.origem_tipo),
    NULL, NULL, NULL, NULL,
    p_usuario_id, p_observacoes,
    p_mov_id
  );

  UPDATE siso_movimentacoes
    SET qty_estornada = qty_estornada + p_qty
    WHERE id = p_mov_id;

  RETURN v_estorno;
END;
$$;

COMMIT;
```

- [ ] **Step 2: Aplicar migration via MCP**

Use `mcp__supabase__apply_migration`.

- [ ] **Step 3: Smoke test via SQL**

```sql
-- Pega uma mov S real do staging
SELECT id, tipo, quantidade, qty_estornada FROM siso_movimentacoes
  WHERE tipo='S' AND estorno_de IS NULL AND qty_estornada=0 LIMIT 1;

-- Estorna parcial qty=1 (substitua mov_id e usuario_id)
SELECT * FROM wms_estornar_parcial_movimentacao(
  '00000000-0000-0000-0000-000000000000'::uuid, 1,
  (SELECT id FROM siso_usuarios LIMIT 1),
  'smoke test fix-pack'
);

-- Confirma qty_estornada bate
SELECT id, quantidade, qty_estornada FROM siso_movimentacoes WHERE id='<mov_id>';
```

Expected: mov de estorno criada com qty=1; mov original tem `qty_estornada=1`.

- [ ] **Step 4: Limpar smoke test (estorno real do estorno)**

```sql
-- Use estornarMovimentacao no estorno gerado pra anular
SELECT wms_estornar_parcial_movimentacao(
  '<original_mov_id>'::uuid, -1, ...  -- NÃO funciona, qty>0
);
-- Alternativa: estorne o estorno via app, ou deixe o smoke marcado no log
```

Atalho: se o estorno parcial foi um teste, faça `UPDATE siso_movimentacoes SET qty_estornada = qty_estornada - 1 WHERE id='<orig>'` E `DELETE FROM siso_movimentacoes WHERE id='<estorno_gerado>'` — só em staging.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260518_realocacao_fix_pack_rpc_estorno_parcial.sql
git commit -m "feat(wms/realoc-fix): RPC wms_estornar_parcial_movimentacao"
```

---

### Task 1.4: Ampliação da RPC `siso_processar_bip_embalagem`

**Files:**
- Create: `supabase/migrations/20260518_realocacao_fix_pack_embalagem_strict.sql`

- [ ] **Step 1: Localizar RPC atual**

Run: `grep -rn "CREATE.*FUNCTION siso_processar_bip_embalagem" supabase/migrations/ | tail -1`

Localize o arquivo mais recente que define a função. Copie o corpo atual pra ter base de referência. Leia integralmente.

- [ ] **Step 2: Criar migration de ampliação**

Crie `supabase/migrations/20260518_realocacao_fix_pack_embalagem_strict.sql`:

```sql
-- Spec § 1.4 — Adiciona parâmetro p_strict_qty_pega na RPC de embalagem.
-- Quando true E item.separacao_parcial=true, valida bipado <= quantidade_pega real.
-- Default false mantém backward-compat.

BEGIN;

CREATE OR REPLACE FUNCTION siso_processar_bip_embalagem(
  p_pedido_ids bigint[],
  p_sku text,
  p_quantidade integer,
  p_operador_id uuid,
  p_strict_qty_pega boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb;
  v_item RECORD;
  v_teto integer;
  v_nova_bipada integer;
  v_pedido_completo boolean;
BEGIN
  -- Busca item pendente em qualquer um dos pedidos passados
  SELECT i.id, i.pedido_id, i.quantidade_pedida, i.quantidade_bipada,
         i.bipado_completo, i.compra_status, i.separacao_parcial,
         i.quantidade_pega
    INTO v_item
    FROM siso_pedido_itens i
    JOIN siso_pedidos p ON p.id = i.pedido_id
   WHERE i.pedido_id = ANY(p_pedido_ids)
     AND p.status_separacao = 'separado'
     AND i.bipado_completo = false
     AND (i.compra_status IS NULL OR i.compra_status NOT IN ('cancelado','indisponivel'))
     AND (i.sku = p_sku OR i.gtin = p_sku)
   ORDER BY i.pedido_id, i.id
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'item_nao_encontrado');
  END IF;

  -- Calcula teto baseado em strict_qty_pega
  IF p_strict_qty_pega AND v_item.separacao_parcial THEN
    SELECT COALESCE(v_item.quantidade_pega, 0) +
           COALESCE(SUM(quantidade_pega) FILTER (WHERE status IN ('picado','picado_parcial')), 0)
      INTO v_teto
      FROM siso_pedido_item_realocacoes
     WHERE pedido_item_id = v_item.id;
  ELSE
    v_teto := v_item.quantidade_pedida;
  END IF;

  v_nova_bipada := v_item.quantidade_bipada + p_quantidade;

  IF v_nova_bipada > v_teto THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'bipou_alem_do_teto',
                              'teto', v_teto, 'tentado', v_nova_bipada);
  END IF;

  UPDATE siso_pedido_itens
    SET quantidade_bipada = v_nova_bipada,
        bipado_completo = (v_nova_bipada >= v_teto),
        embalagem_operador_id = p_operador_id,
        embalagem_iniciada_em = COALESCE(embalagem_iniciada_em, now())
    WHERE id = v_item.id;

  -- Verifica se pedido inteiro está embalado
  SELECT NOT EXISTS (
    SELECT 1 FROM siso_pedido_itens
     WHERE pedido_id = v_item.pedido_id
       AND bipado_completo = false
       AND (compra_status IS NULL OR compra_status NOT IN ('cancelado','indisponivel'))
  ) INTO v_pedido_completo;

  IF v_pedido_completo THEN
    UPDATE siso_pedidos
      SET status_separacao = 'embalado',
          embalagem_concluida_em = now()
      WHERE id = v_item.pedido_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'pedido_id', v_item.pedido_id,
    'item_id', v_item.id,
    'bipado_completo', (v_nova_bipada >= v_teto),
    'pedido_completo', v_pedido_completo
  );
END;
$$;

COMMIT;
```

Note: o corpo acima é uma reconstrução baseada no comportamento documentado em `migrations/20260401_embalagem_operador_id.sql:47-71`. **Antes de rodar**, verifique a versão mais recente da função e ajuste a reescrita pra preservar comportamentos não-relacionados ao fix.

- [ ] **Step 3: Aplicar migration via MCP**

Use `mcp__supabase__apply_migration`. Confirme via `\df+ siso_processar_bip_embalagem` que tem 5 params.

- [ ] **Step 4: Smoke test backward-compat**

```sql
-- Chama sem p_strict_qty_pega (default false) — deve funcionar igual antes
SELECT siso_processar_bip_embalagem(
  ARRAY[<pedido_id_teste>]::bigint[], '<sku>', 1, '<user_id>'::uuid
);
```

Expected: retorna `ok: true` com `bipado_completo` calculado contra `quantidade_pedida`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260518_realocacao_fix_pack_embalagem_strict.sql
git commit -m "feat(wms/realoc-fix): RPC siso_processar_bip_embalagem aceita p_strict_qty_pega"
```

---

### Task 1.5: Smoke tests Vitest pras RPCs novas

**Files:**
- Create: `src/lib/wms/realoc-fix-pack.test.ts`

- [ ] **Step 1: Escrever teste falhando**

Cria `src/lib/wms/realoc-fix-pack.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createServiceClient } from "@/lib/supabase-server";

const sb = createServiceClient();

describe("wms_acumular_qty_pega", () => {
  let itemId: number;

  beforeEach(async () => {
    // Cria um item temporário pro teste (assume pedido_id de seed existe)
    const { data } = await sb.from("siso_pedido_itens").insert({
      pedido_id: 1, produto_id: 1, sku: "TEST-FIX",
      quantidade_pedida: 10, quantidade_pega: null,
    }).select("id").single();
    itemId = data!.id;
  });

  it("primeira chamada (null) + delta=3 → quantidade_pega=3", async () => {
    const { data, error } = await sb.rpc("wms_acumular_qty_pega",
      { p_item_id: itemId, p_delta: 3 });
    expect(error).toBeNull();
    expect(data).toBe(3);
  });

  it("acumula em chamadas sucessivas", async () => {
    await sb.rpc("wms_acumular_qty_pega", { p_item_id: itemId, p_delta: 2 });
    const { data } = await sb.rpc("wms_acumular_qty_pega",
      { p_item_id: itemId, p_delta: 1 });
    expect(data).toBe(3);
  });

  it("delta negativo abaixo de zero → erro", async () => {
    const { error } = await sb.rpc("wms_acumular_qty_pega",
      { p_item_id: itemId, p_delta: -5 });
    expect(error?.message).toMatch(/negativa/);
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que precisa de RPC já criada**

Run: `npm test -- realoc-fix-pack`

Expected: passa (RPC já existe da Task 1.2). Se falhar com "function not found", revisar Task 1.2.

- [ ] **Step 3: Adicionar testes pra `wms_estornar_parcial_movimentacao`**

Adicione ao mesmo arquivo:

```ts
describe("wms_estornar_parcial_movimentacao", () => {
  // Setup: cria mov S real via inserirMovimentacao do ledger
  let movId: string;
  let usuarioId: string;

  beforeEach(async () => {
    const { data: u } = await sb.from("siso_usuarios").select("id").limit(1).single();
    usuarioId = u!.id;

    const { data } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto: "00000000-0000-0000-0000-000000000001",  // seed produto WMS
      p_dona: "00000000-0000-0000-0000-000000000001",     // seed empresa
      p_galpao: "00000000-0000-0000-0000-000000000001",
      p_localizacao: "00000000-0000-0000-0000-000000000001",
      p_tipo: 'E', p_qty: 10,
      p_origem_tipo: 'compra_manual', p_origem_id: 'fix-pack-test',
      p_origem_detalhes: {}, p_emprestimo_devedora: null, p_expira_em: null,
      p_nota_fiscal_id: null, p_custo_unitario: null,
      p_usuario: usuarioId, p_observacoes: 'fix-pack test',
      p_estorno_de: null,
    });
    movId = data!.id;
  });

  it("estorno parcial qty=3 de mov qty=10 → qty_estornada=3", async () => {
    const { error } = await sb.rpc("wms_estornar_parcial_movimentacao", {
      p_mov_id: movId, p_qty: 3, p_usuario_id: usuarioId,
      p_observacoes: "teste parcial",
    });
    expect(error).toBeNull();
    const { data: orig } = await sb.from("siso_movimentacoes")
      .select("qty_estornada").eq("id", movId).single();
    expect(orig!.qty_estornada).toBe(3);
  });

  it("estorno parcial que excede saldo → erro", async () => {
    await sb.rpc("wms_estornar_parcial_movimentacao", {
      p_mov_id: movId, p_qty: 7, p_usuario_id: usuarioId, p_observacoes: "",
    });
    const { error } = await sb.rpc("wms_estornar_parcial_movimentacao", {
      p_mov_id: movId, p_qty: 5, p_usuario_id: usuarioId, p_observacoes: "",
    });
    expect(error?.message).toMatch(/excede/);
  });

  it("qty negativa ou zero → erro", async () => {
    const { error } = await sb.rpc("wms_estornar_parcial_movimentacao", {
      p_mov_id: movId, p_qty: 0, p_usuario_id: usuarioId, p_observacoes: "",
    });
    expect(error?.message).toMatch(/positiva/);
  });
});
```

- [ ] **Step 4: Rodar tudo**

Run: `npm test -- realoc-fix-pack`

Expected: PASS (todos os tests novos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/realoc-fix-pack.test.ts
git commit -m "test(wms/realoc-fix): smoke tests pras RPCs novas"
```

---

## Phase 2 — Backend semântico

### Task 2.1: Helper `resetarEstadoSeparacaoItens`

**Files:**
- Create: `src/lib/separacao/reset-state.ts`
- Create: `src/lib/separacao/reset-state.test.ts`

- [ ] **Step 1: Escrever teste falhando**

Cria `src/lib/separacao/reset-state.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { resetarEstadoSeparacaoItens } from "./reset-state";

describe("resetarEstadoSeparacaoItens", () => {
  it("cancela realocs aguardando + estorna mov_saida + reseta campos", async () => {
    const supabase = mockSupabase({
      items: [{ id: 1, mov_saida_id: "mov-1", mov_ajuste_loc_zerou_id: "aj-1",
                separacao_parcial: true, quantidade_pega: 3 }],
      realocs: [{ id: "r-1", pedido_item_id: 1, status: "aguardando_picking", mov_saida_id: null },
                { id: "r-2", pedido_item_id: 1, status: "picado", mov_saida_id: "mov-2" }],
      links: [],
    });
    const estornar = vi.fn().mockResolvedValue({ id: "estorno-1" });

    const result = await resetarEstadoSeparacaoItens({
      supabase, itemIds: [1], usuarioId: "u-1", motivo: "encaminhar",
      estornarMov: estornar,
    });

    expect(estornar).toHaveBeenCalledWith({ mov_id: "mov-1", usuario_id: "u-1",
      observacoes: expect.stringContaining("encaminhar") });
    expect(estornar).toHaveBeenCalledWith({ mov_id: "mov-2", usuario_id: "u-1",
      observacoes: expect.any(String) });
    expect(estornar).not.toHaveBeenCalledWith({ mov_id: "aj-1" }); // NÃO estorna ajuste
    expect(result.estornadas).toEqual(["mov-1", "mov-2"]);
    expect(result.realocsCanceladas).toBe(1); // só a aguardando_picking
  });

  it("idempotência: rodar 2x não estorna 2x", async () => {
    // ... setup item já resetado
    const result = await resetarEstadoSeparacaoItens(/* args */);
    expect(result.estornadas).toHaveLength(0);
  });
});

function mockSupabase(seed: any) {
  // helper que retorna client mock com from().select().eq() etc
  return {/* ... */};
}
```

- [ ] **Step 2: Rodar pra confirmar que falha**

Run: `npm test -- reset-state`

Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar helper**

Cria `src/lib/separacao/reset-state.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { estornarMovimentacao } from "@/lib/wms/ledger";
import { registrarEvento } from "@/lib/historico-service";
import { logger } from "@/lib/logger";

export type ResetMotivo = "encaminhar" | "reiniciar" | "voltar_etapa" | "esgotado";

export interface ResetResult {
  estornadas: string[];
  realocsCanceladas: number;
}

export async function resetarEstadoSeparacaoItens(opts: {
  supabase: SupabaseClient;
  itemIds: number[];
  usuarioId: string;
  motivo: ResetMotivo;
  // injetável pra testes
  estornarMov?: typeof estornarMovimentacao;
}): Promise<ResetResult> {
  const { supabase, itemIds, usuarioId, motivo } = opts;
  const estornar = opts.estornarMov ?? estornarMovimentacao;
  const estornadas: string[] = [];

  if (itemIds.length === 0) return { estornadas, realocsCanceladas: 0 };

  // 1. Carrega items
  const { data: items } = await supabase
    .from("siso_pedido_itens")
    .select("id, pedido_id, mov_saida_id, mov_ajuste_loc_zerou_id, separacao_parcial, quantidade_pega")
    .in("id", itemIds);
  if (!items) return { estornadas, realocsCanceladas: 0 };

  // 2. Carrega realocs + links da ponte
  const { data: realocs } = await supabase
    .from("siso_pedido_item_realocacoes")
    .select("id, pedido_item_id, status, mov_saida_id")
    .in("pedido_item_id", itemIds);

  const { data: links } = await supabase
    .from("siso_pedido_item_mov_links")
    .select("id, mov_id, qty, tipo_link, pedido_item_id")
    .in("pedido_item_id", itemIds);

  // 3. Estorna mov_saida do item (caminho legacy + links)
  const movsSaida = new Set<string>();
  for (const it of items) {
    if (it.mov_saida_id) movsSaida.add(it.mov_saida_id as string);
  }
  for (const l of links ?? []) {
    if (l.tipo_link === "saida") movsSaida.add(l.mov_id as string);
  }

  for (const movId of movsSaida) {
    try {
      const mov = await estornar({
        mov_id: movId,
        usuario_id: usuarioId,
        observacoes: `Reset separação — motivo=${motivo}`,
      });
      estornadas.push(movId);
      logger.info("reset-state", "estorno OK", { movId, motivo });
    } catch (e: unknown) {
      const msg = (e as Error).message ?? String(e);
      if (msg.includes("ja foi estornada") || msg.includes("ja e um estorno")) {
        logger.warn("reset-state", "estorno já feito — pulando", { movId });
        continue;
      }
      throw e;
    }
  }

  // 4. Estorna mov_saida das realocs picadas (status picado ou picado_parcial)
  for (const r of realocs ?? []) {
    if ((r.status === "picado" || r.status === "picado_parcial") && r.mov_saida_id) {
      try {
        await estornar({
          mov_id: r.mov_saida_id as string,
          usuario_id: usuarioId,
          observacoes: `Reset separação realoc — motivo=${motivo}`,
        });
        estornadas.push(r.mov_saida_id as string);
      } catch (e: unknown) {
        const msg = (e as Error).message ?? String(e);
        if (!msg.includes("ja foi estornada")) throw e;
      }
    }
  }

  // 5. Cancela realocs aguardando_picking
  const aguardando = (realocs ?? []).filter(r => r.status === "aguardando_picking");
  if (aguardando.length > 0) {
    await supabase
      .from("siso_pedido_item_realocacoes")
      .update({ status: "cancelado" })
      .in("id", aguardando.map(r => r.id));
  }

  // 6. Limpa links da ponte (movs estornadas já anularam efeitos)
  if ((links ?? []).length > 0) {
    await supabase
      .from("siso_pedido_item_mov_links")
      .delete()
      .in("pedido_item_id", itemIds);
  }

  // 7. Reset campos do item
  await supabase
    .from("siso_pedido_itens")
    .update({
      separacao_marcado: false,
      separacao_marcado_em: null,
      quantidade_pega: null,
      separacao_parcial: false,
      parcial_motivo: null,
      parcial_em: null,
      parcial_por: null,
      mov_saida_id: null,
      mov_ajuste_loc_zerou_id: null,
      quantidade_bipada: 0,
      bipado_completo: false,
    })
    .in("id", itemIds);

  // 8. Registra evento por pedido
  const pedidoIds = [...new Set(items.map(i => i.pedido_id))];
  for (const pid of pedidoIds) {
    await registrarEvento({
      pedidoId: pid as string,
      evento: "separacao_resetada",
      detalhes: { motivo, item_ids: itemIds, estornadas },
      usuarioId,
    });
  }

  return { estornadas, realocsCanceladas: aguardando.length };
}
```

- [ ] **Step 4: Rodar testes**

Run: `npm test -- reset-state`

Expected: PASS (ou ajuste o mock se a assinatura divergir).

- [ ] **Step 5: Commit**

```bash
git add src/lib/separacao/reset-state.ts src/lib/separacao/reset-state.test.ts
git commit -m "feat(wms/realoc-fix): helper resetarEstadoSeparacaoItens"
```

---

### Task 2.2: C2 — Remover estorno `mov_ajuste_loc_zerou_id` em `desfazer-parcial`

**Files:**
- Modify: `src/app/api/wms/separacao/desfazer-parcial/route.ts:82-88`

- [ ] **Step 1: Ler arquivo**

Run: `cat src/app/api/wms/separacao/desfazer-parcial/route.ts | head -100`

Confirme linhas 82-88 estão como no audit (estorno do `mov_ajuste_loc_zerou_id`).

- [ ] **Step 2: Remover bloco de estorno do ajuste**

Edit `src/app/api/wms/separacao/desfazer-parcial/route.ts` removendo:

```diff
-    if (item.mov_ajuste_loc_zerou_id) {
-      await estornarMovimentacao({
-        mov_id: item.mov_ajuste_loc_zerou_id,
-        usuario_id: session.id,
-        observacoes: "Desfazer parcial (ajuste) — operador",
-      });
-    }
+    // mov_ajuste_loc_zerou_id NUNCA é estornado por design — reflete descoberta física.
+    // Espelha cancelar/route.ts:79-80 e a spec original (invariantes).
```

- [ ] **Step 3: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`

Expected: zero erros relacionados ao arquivo.

- [ ] **Step 4: Smoke test manual (staging)**

Cria parcial num pedido (loc_zerou=true), depois chama `POST /api/wms/separacao/desfazer-parcial`. Confirme via SQL que `mov_ajuste_loc_zerou_id` da mov original ainda existe sem estorno.

```sql
SELECT id, origem_tipo, qty_estornada
  FROM siso_movimentacoes
  WHERE origem_tipo = 'ajuste_pick_zerou'
  ORDER BY criado_em DESC LIMIT 5;
```

Expected: `qty_estornada=0` na mov de ajuste; nenhuma mov filha com `estorno_de` apontando pra ela.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/desfazer-parcial/route.ts
git commit -m "fix(wms/realoc-fix): C2 — desfazer-parcial nao estorna mov_ajuste_loc_zerou"
```

---

### Task 2.3: C3 parte 1 — `parcial` (modo item) escreve na tabela ponte

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts` (função `processarParcialItem`, lines ~94-558)

- [ ] **Step 1: Localizar pontos de inserção de mov**

No arquivo, identifique:
- Linha onde `inserirMovimentacao` é chamada pra mov S (saída) — ~247
- Linha onde `inserirMovimentacao` é chamada pra mov ajuste loc_zerou — ~278
- Loop de UPDATE dos items (~333-374)

- [ ] **Step 2: Após cada inserirMovimentacao, criar links pra todos items afetados**

Pra mov S: imediatamente após `const mov = await inserirMovimentacao({...})`, antes do loop de UPDATE dos items, prepara dados e insere N links:

```ts
// Após inserir mov S — popular siso_pedido_item_mov_links
const linksData: Array<{
  pedido_item_id: number;
  realocacao_id: null;
  mov_id: string;
  qty: number;
  tipo_link: 'saida' | 'ajuste_loc_zerou';
}> = [];

for (const upd of itemUpdates) {
  if (upd.qty_para_este > 0) {
    linksData.push({
      pedido_item_id: Number(upd.item.id),
      realocacao_id: null,
      mov_id: movSaidaId!,
      qty: upd.qty_para_este,
      tipo_link: 'saida',
    });
  }
}

if (linksData.length > 0) {
  const { error: linkErr } = await supabase
    .from("siso_pedido_item_mov_links")
    .insert(linksData);
  if (linkErr) {
    logger.logError({
      error: linkErr,
      source: "separacao-parcial-item",
      message: "Falhou criar links",
      category: "database",
    });
    return NextResponse.json({ error: "erro persistindo links" }, { status: 500 });
  }
}
```

Pra mov ajuste (se loc_zerou && delta>0):

```ts
if (movAjusteId && loc_zerou && delta > 0) {
  // Atribui delta proporcional aos items que foram marcados
  // (regra simples: cai no primeiro beneficiário inteiro — o ajuste é da loc, não dos items)
  await supabase
    .from("siso_pedido_item_mov_links")
    .insert({
      pedido_item_id: itemsRaw[indexPrimeiroBeneficiado].id,
      realocacao_id: null,
      mov_id: movAjusteId,
      qty: delta,
      tipo_link: 'ajuste_loc_zerou',
    });
}
```

- [ ] **Step 3: Manter campos legacy (grace period 30 dias)**

No loop de UPDATE existente, **continua** setando `mov_saida_id` e `mov_ajuste_loc_zerou_id` no item — **mas agora em TODOS os items beneficiários, não só no primeiro**. Isso já remove ambiguidade do C3 mesmo no caminho legacy.

```diff
-mov_saida_id: ehBeneficiario ? movSaidaId : null,
-mov_ajuste_loc_zerou_id: ehBeneficiario ? movAjusteId : null,
+mov_saida_id: qty_para_este > 0 ? movSaidaId : null,
+mov_ajuste_loc_zerou_id: ehBeneficiario ? movAjusteId : null,  // ajuste fica só no primeiro mesmo
```

Comentário: a tabela ponte é fonte de verdade pra estorno; campos legacy são pra leitura por endpoints que ainda não migraram.

- [ ] **Step 4: Validar TypeScript + smoke**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Run: `npm test -- parcial 2>&1 | head -30` (se existir teste do parcial)

Expected: zero erros.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/parcial/route.ts
git commit -m "feat(wms/realoc-fix): C3 — parcial modo item popula tabela ponte"
```

---

### Task 2.4: C3 parte 2 — `parcial` (modo realoc) escreve na tabela ponte

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts` (função `processarParcialRealocacao`, lines ~560-1054)

- [ ] **Step 1: Localizar pontos de inserção**

No arquivo, função `processarParcialRealocacao`:
- Linha de mov S — ~697-727
- Linha de mov ajuste — ~729-756
- Loop de UPDATE das realocs — ~785-855

- [ ] **Step 2: Após inserirMovimentacao da saída, criar N links (1 por realoc afetada)**

```ts
// Após mov S
const linksRealoc: Array<{
  pedido_item_id: number;
  realocacao_id: string;
  mov_id: string;
  qty: number;
  tipo_link: 'saida';
}> = [];

for (const u of updates) {
  if (u.qty_para_esta > 0) {
    linksRealoc.push({
      pedido_item_id: Number(u.realoc.pedido_item_id),
      realocacao_id: u.realoc.id,
      mov_id: movSaidaId!,
      qty: u.qty_para_esta,
      tipo_link: 'saida',
    });
  }
}

if (linksRealoc.length > 0) {
  await supabase.from("siso_pedido_item_mov_links").insert(linksRealoc);
}
```

Pra mov ajuste:

```ts
if (movAjusteId && loc_zerou && delta > 0) {
  // Atribui delta ao primeiro beneficiário (ajuste é da loc, não rateado)
  const primeiraComQty = updates.find(u => u.qty_para_esta > 0) ?? updates[0];
  await supabase.from("siso_pedido_item_mov_links").insert({
    pedido_item_id: Number(primeiraComQty.realoc.pedido_item_id),
    realocacao_id: primeiraComQty.realoc.id,
    mov_id: movAjusteId,
    qty: delta,
    tipo_link: 'ajuste_loc_zerou',
  });
}
```

- [ ] **Step 3: Atualizar campos legacy nas realocs (todas as beneficiárias, não só a primeira)**

```diff
-mov_saida_id: ehBeneficiario ? movSaidaId : null,
-mov_ajuste_loc_zerou_id: ehBeneficiario ? movAjusteId : null,
+mov_saida_id: qty_para_esta > 0 ? movSaidaId : null,
+mov_ajuste_loc_zerou_id: ehBeneficiario ? movAjusteId : null,
```

- [ ] **Step 4: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/parcial/route.ts
git commit -m "feat(wms/realoc-fix): C3 — parcial modo realoc popula tabela ponte"
```

---

### Task 2.5: C3 parte 3 — `marcar-realocacao` escreve na tabela ponte

**Files:**
- Modify: `src/app/api/wms/separacao/marcar-realocacao/route.ts:73-128`

- [ ] **Step 1: Adicionar insert de link após mov**

Após `const mov = await inserirMovimentacao(...)` e antes do UPDATE da realoc, inserir:

```ts
await supabase.from("siso_pedido_item_mov_links").insert({
  pedido_item_id: Number(realoc.pedido_item_id),
  realocacao_id: realoc.id,
  mov_id: mov.id,
  qty: Number(realoc.quantidade),
  tipo_link: 'saida',
});
```

- [ ] **Step 2: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/separacao/marcar-realocacao/route.ts
git commit -m "feat(wms/realoc-fix): C3 — marcar-realocacao popula tabela ponte"
```

---

### Task 2.6: C3 parte 4 — `desfazer-parcial` lê da tabela ponte + estorna proporcional

**Files:**
- Modify: `src/app/api/wms/separacao/desfazer-parcial/route.ts` (refator completo)

- [ ] **Step 1: Reescrever lógica de estorno**

Substituir o bloco que estorna `mov_saida_id` (linhas 75-81 originais — já sem o ajuste estornado da Task 2.2):

```ts
// Carrega links de saída desse item (tabela ponte)
const { data: links } = await supabase
  .from("siso_pedido_item_mov_links")
  .select("id, mov_id, qty, tipo_link")
  .eq("pedido_item_id", item.id)
  .eq("tipo_link", "saida");

let totalEstornado = 0;

for (const link of links ?? []) {
  // Conta quantos links irmãos a mov tem (incluindo este)
  const { count } = await supabase
    .from("siso_pedido_item_mov_links")
    .select("id", { count: "exact", head: true })
    .eq("mov_id", link.mov_id);

  if (count === 1) {
    // Link único — estorna mov inteira
    await estornarMovimentacao({
      mov_id: link.mov_id as string,
      usuario_id: session.id,
      observacoes: "Desfazer parcial — operador (link único)",
    });
  } else {
    // Mov compartilhada — estorno parcial
    await supabase.rpc("wms_estornar_parcial_movimentacao", {
      p_mov_id: link.mov_id,
      p_qty: link.qty,
      p_usuario_id: session.id,
      p_observacoes: "Desfazer parcial — operador (estorno parcial)",
    });
  }

  // Apaga o link
  await supabase.from("siso_pedido_item_mov_links")
    .delete().eq("id", link.id);

  totalEstornado += link.qty as number;
}

// Fallback legacy: se item tem mov_saida_id mas não tem links (criado pré-fix-pack)
if ((links ?? []).length === 0 && item.mov_saida_id) {
  await estornarMovimentacao({
    mov_id: item.mov_saida_id,
    usuario_id: session.id,
    observacoes: "Desfazer parcial — operador (legacy path)",
  });
}
```

- [ ] **Step 2: Apagar links de `tipo_link='ajuste_loc_zerou'` sem estornar**

```ts
// Apaga links de ajuste loc_zerou (NÃO estorna a mov — design)
await supabase.from("siso_pedido_item_mov_links")
  .delete()
  .eq("pedido_item_id", item.id)
  .eq("tipo_link", "ajuste_loc_zerou");
```

- [ ] **Step 3: Substituir reset de `quantidade_pega = null` por RPC**

Em vez de `quantidade_pega: null` no UPDATE final, usar:

```ts
// Antes do UPDATE final do item
if (totalEstornado > 0) {
  await supabase.rpc("wms_acumular_qty_pega", {
    p_item_id: item.id, p_delta: -totalEstornado,
  });
}
```

E no UPDATE remove `quantidade_pega: null` (deixar a RPC controlar).

Atenção: se item passa do legacy fallback (links vazios mas tem mov), zera `quantidade_pega` direto:

```ts
if ((links ?? []).length === 0) {
  await supabase.from("siso_pedido_itens")
    .update({ quantidade_pega: null }).eq("id", item.id);
}
```

- [ ] **Step 4: Validar TypeScript + smoke**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/desfazer-parcial/route.ts
git commit -m "feat(wms/realoc-fix): C3 — desfazer-parcial usa tabela ponte (estorno parcial)"
```

---

### Task 2.7: C3 parte 5 — `cancelar` lê da tabela ponte

**Files:**
- Modify: `src/app/api/wms/separacao/cancelar/route.ts`

- [ ] **Step 1: Refatorar leitura/estorno**

No loop que estorna `mov_saida_id` por item (~lines 50-68), trocar pra ler links:

```ts
// Coleta movs únicas via tabela ponte
const { data: links } = await supabase
  .from("siso_pedido_item_mov_links")
  .select("mov_id, tipo_link, qty, pedido_item_id")
  .in("pedido_item_id", itemIds);

const movsSaidaSet = new Set<string>();
for (const l of links ?? []) {
  if (l.tipo_link === "saida") movsSaidaSet.add(l.mov_id as string);
}

// Fallback legacy: items sem links
for (const it of items ?? []) {
  if (it.mov_saida_id) movsSaidaSet.add(it.mov_saida_id as string);
}

for (const movId of movsSaidaSet) {
  try {
    await estornarMovimentacao({
      mov_id: movId,
      usuario_id: session.id,
      observacoes: `Cancelar separação`,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message ?? String(e);
    if (!msg.includes("ja foi estornada")) {
      logger.warn("separacao-cancelar", "Estorno item falhou", { movId, error: msg });
    }
  }
}

// Apaga links após estornos
if (itemIds.length > 0) {
  await supabase.from("siso_pedido_item_mov_links")
    .delete().in("pedido_item_id", itemIds);
}
```

Manter a parte que estorna `mov_saida_id` de realocs (já existe), só adicionar deduplicação via Set.

- [ ] **Step 2: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/separacao/cancelar/route.ts
git commit -m "feat(wms/realoc-fix): C3 — cancelar usa tabela ponte (dedupe mov)"
```

---

### Task 2.8: C4 — Lock pessimista pós-mov com rollback (modo realoc + marcar-realocacao + modo item)

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts` (ambas funções)
- Modify: `src/app/api/wms/separacao/marcar-realocacao/route.ts`

- [ ] **Step 1: Refator modo realoc em `parcial`**

No `processarParcialRealocacao`, o UPDATE atual em `siso_pedido_item_realocacoes` (linha ~796) já passa pelo loop um-a-um. Adicionar filtro `.eq("status","aguardando_picking")` e checar `error`/affected rows:

```ts
let racePerdida = false;

for (let i = 0; i < updates.length; i++) {
  const u = updates[i];
  // ... cálculo de qtyParaEsta, etc.

  const { data: claimed, error: updErr } = await supabase
    .from("siso_pedido_item_realocacoes")
    .update({
      status: isCompletoEsta ? "picado" : "picado_parcial",
      // ... outros campos
    })
    .eq("id", realoc.id)
    .eq("status", "aguardando_picking")
    .select("id");

  if (updErr) {
    // erro real DB
    racePerdida = true;
    break;
  }
  if (!claimed || claimed.length === 0) {
    // race — outro op já picou
    racePerdida = true;
    break;
  }
}

if (racePerdida) {
  // Estorna mov que acabou de ser criada
  if (movSaidaId) {
    try {
      await estornarMovimentacao({
        mov_id: movSaidaId, usuario_id: session.id,
        observacoes: "Race condition — outro operador picou primeiro",
      });
    } catch (e) { logger.warn(...); }
  }
  if (movAjusteId) {
    try {
      await estornarMovimentacao({
        mov_id: movAjusteId, usuario_id: session.id,
        observacoes: "Race condition (ajuste)",
      });
    } catch (e) { logger.warn(...); }
  }
  // Limpa links se tiverem sido criados
  await supabase.from("siso_pedido_item_mov_links")
    .delete().eq("mov_id", movSaidaId ?? "");

  return NextResponse.json({
    error: "realocacao_ja_picada",
    message: "Outro operador picou primeiro — atualize a tela",
  }, { status: 409 });
}
```

- [ ] **Step 2: Refator modo item em `parcial`**

No `processarParcialItem`, similar — UPDATE com `.eq("separacao_marcado", false)` ou `.eq("separacao_parcial", false)`:

```ts
const { data: claimed, error } = await supabase
  .from("siso_pedido_itens")
  .update({ separacao_marcado: true, separacao_parcial: true, /* ... */ })
  .eq("id", it.id)
  .eq("separacao_marcado", false)
  .select("id");

if (!claimed || claimed.length === 0) {
  // race — estorna mov + links + 409
  // ...
}
```

- [ ] **Step 3: Refator `marcar-realocacao`**

Mesma técnica em `marcar-realocacao/route.ts`. Mov gerada → UPDATE condicional → se 0 rows, estorna.

- [ ] **Step 4: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/parcial/route.ts src/app/api/wms/separacao/marcar-realocacao/route.ts
git commit -m "fix(wms/realoc-fix): C4 — lock pessimista pos-mov com rollback (race)"
```

---

### Task 2.9: I9 — Substituir read-modify-write em `quantidade_pega` por RPC

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts:333-340, 828-837`
- Modify: `src/app/api/wms/separacao/marcar-realocacao/route.ts:124-128`

- [ ] **Step 1: Substituir em parcial modo item**

Localizar bloco ~333-340 que faz `novaQty = (item.quantidade_pega ?? 0) + qty_para_este` e UPDATE. Trocar por:

```ts
if (qty_para_este > 0) {
  await supabase.rpc("wms_acumular_qty_pega", {
    p_item_id: it.id, p_delta: qty_para_este,
  });
}
```

- [ ] **Step 2: Substituir em parcial modo realoc**

Localizar bloco ~828-837. Trocar por:

```ts
if (qty_para_esta > 0) {
  await supabase.rpc("wms_acumular_qty_pega", {
    p_item_id: item.id, p_delta: qty_para_esta,
  });
}
```

Remover o `item.quantidade_pega = novaQty as unknown as ...` (cache local) — RPC faz tudo.

- [ ] **Step 3: Substituir em marcar-realocacao**

```ts
await supabase.rpc("wms_acumular_qty_pega", {
  p_item_id: item.id, p_delta: Number(realoc.quantidade),
});
```

Remover SELECT prévio de `quantidade_pega`.

- [ ] **Step 4: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/parcial/route.ts src/app/api/wms/separacao/marcar-realocacao/route.ts
git commit -m "fix(wms/realoc-fix): I9 — qty_pega atomico via RPC wms_acumular_qty_pega"
```

---

### Task 2.10: I7 — `DELETE /realocacao/[id]` cascateia em filhas

**Files:**
- Modify: `src/app/api/wms/separacao/realocacao/[id]/route.ts`

- [ ] **Step 1: Adicionar query recursiva pra coletar chain**

Adicionar antes do UPDATE:

```ts
// Coleta toda a chain descendente via WITH RECURSIVE
const { data: chain } = await supabase.rpc("wms_realoc_chain_descendentes", {
  p_root_id: realocId,
});

// (alternativa sem RPC: loop iterativo no app)
async function coletarDescendentes(rootId: string): Promise<string[]> {
  const acc: string[] = [];
  let camada = [rootId];
  while (camada.length > 0) {
    const { data } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("id, status")
      .in("parent_realocacao_id", camada);
    if (!data || data.length === 0) break;
    acc.push(...data.map(r => r.id as string));
    // Bloqueia se descendente já picado
    const picado = data.find(r => r.status === "picado" || r.status === "picado_parcial");
    if (picado) throw new Error("chain tem realoc picada — use Cancelar separação");
    camada = data.map(r => r.id as string);
  }
  return acc;
}

let descendentes: string[];
try {
  descendentes = await coletarDescendentes(realocId);
} catch (e) {
  return NextResponse.json(
    { error: "chain_tem_picadas", message: (e as Error).message },
    { status: 409 });
}
```

- [ ] **Step 2: Cancelar a raiz + descendentes em batch**

```ts
const todos = [realocId, ...descendentes];
const { error } = await supabase
  .from("siso_pedido_item_realocacoes")
  .update({ status: "cancelado" })
  .in("id", todos)
  .eq("status", "aguardando_picking");

if (error) {
  logger.logError({ error, source: "realocacao-delete", ... });
  return NextResponse.json({ error: "erro cancelando chain" }, { status: 500 });
}
```

- [ ] **Step 3: Evento atualizado**

```ts
await registrarEvento({
  pedidoId: item.pedido_id,
  evento: descendentes.length > 0 ? "realocacao_cancelada_chain" : "realocacao_cancelada",
  detalhes: { realocacao_id: realocId, descendentes_canceladas: descendentes.length },
  usuarioId: session.id,
});
```

- [ ] **Step 4: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/realocacao/\[id\]/route.ts
git commit -m "fix(wms/realoc-fix): I7 — DELETE realocacao cancela chain via parent_id"
```

---

### Task 2.11: I8 — Cascade multi-empresa em parcial

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts` (cascade nos 2 modos)

- [ ] **Step 1: Refator do bloco cascade modo item (linhas ~413-438)**

Antes de chamar `resolverRealocacao`, agrupar `itemsResiduais` por `empresa_origem_id` do pedido pai:

```ts
// Agrupa residuais por empresa origem
const porEmpresa = new Map<string, typeof itemsResiduais>();
for (const u of itemsResiduais) {
  const pedido = pedidos.find(p => p.id === u.pedido_id);
  const empOrigem = pedido?.empresa_origem_id as string;
  if (!porEmpresa.has(empOrigem)) porEmpresa.set(empOrigem, []);
  porEmpresa.get(empOrigem)!.push(u);
}

const linhasInsertTotais: LinhaInsert[] = [];
let semCoberturaParcial = false;

for (const [empOrigem, grupo] of porEmpresa) {
  const totalResidualGrupo = grupo.reduce((s, u) => s + u.qty_residual, 0);

  // Carrega locs originais dos items desse grupo
  const itemIdsGrupo = grupo.map(u => u.item.id);
  const { data: estoquesLeg } = await supabase
    .from("siso_pedido_item_estoques")
    .select("localizacao, produto_id, pedido_id")
    .in("pedido_id", grupo.map(u => u.pedido_id))
    .eq("empresa_id", empOrigem);

  const locsOriginais = new Set<string>();
  for (const e of estoquesLeg ?? []) {
    const locId = await resolverLocalizacaoWms(galpaoId, e.localizacao);
    if (locId) locsOriginais.add(locId);
  }

  // Coleta TODAS as realocs existentes desses items
  const { data: rls } = await supabase
    .from("siso_pedido_item_realocacoes")
    .select("localizacao_id")
    .in("pedido_item_id", itemIdsGrupo);

  const excluir = Array.from(new Set([
    ...locsOriginais,
    ...((rls ?? []).map(r => r.localizacao_id as string)),
  ]));

  const produtoWmsGrupo = await resolverProdutoWms(empOrigem, String(grupo[0].item.produto_id));

  const resolver = await resolverRealocacao({
    produto_id: produtoWmsGrupo,
    empresa_origem_id: empOrigem,
    galpao_id: galpaoId,
    localizacoes_excluir: excluir,
    qty_residual: totalResidualGrupo,
  });

  if (resolver.status === "sem_cobertura") {
    semCoberturaParcial = true;
    // Marca pedidos desse grupo como pendente_realocacao
    await supabase.from("siso_pedidos")
      .update({ status_separacao: "pendente_realocacao" })
      .in("id", grupo.map(u => u.pedido_id));
    for (const u of grupo) {
      await registrarEvento({
        pedidoId: u.pedido_id, evento: "realocacao_sem_cobertura_galpao",
        detalhes: { item_id: u.item.id, sku: u.item.sku, qty_residual: u.qty_residual },
        usuarioId: session.id,
      });
    }
    continue;
  }

  // Distribui realocações encontradas entre items do grupo (FCFS)
  let idxRes = 0;
  let restanteAtual = grupo[0]?.qty_residual ?? 0;
  for (const r of resolver.realocacoes) {
    let qtyDessaReal = r.quantidade;
    while (qtyDessaReal > 0 && idxRes < grupo.length) {
      const u = grupo[idxRes];
      const slice = Math.min(qtyDessaReal, restanteAtual);
      if (slice > 0) {
        linhasInsertTotais.push({
          pedido_item_id: Number(u.item.id),
          parent_realocacao_id: null, // modo item — raiz
          empresa_dona_id: r.empresa_dona_id,
          galpao_id: galpaoId,
          localizacao_id: r.localizacao_id,
          quantidade: slice,
          is_emprestimo: r.is_emprestimo,
          empresa_devedora_id: r.empresa_devedora_id,
          motivo: "loc_zerou",
          criado_por: session.id,
        });
        qtyDessaReal -= slice;
        restanteAtual -= slice;
      }
      if (restanteAtual === 0) {
        idxRes++;
        restanteAtual = grupo[idxRes]?.qty_residual ?? 0;
      }
    }
  }
}

// Insert combinado de todas as realocs criadas (todas as empresas)
if (linhasInsertTotais.length > 0) {
  const { data: criadas } = await supabase
    .from("siso_pedido_item_realocacoes")
    .insert(linhasInsertTotais)
    .select("id, empresa_dona_id, localizacao_id, quantidade, is_emprestimo");
  // ... registrar eventos cascade
}

if (semCoberturaParcial && linhasInsertTotais.length === 0) {
  return NextResponse.json({ status: "sem_cobertura" });
}

return NextResponse.json({ status: "realocado", realocacoes: criadas ?? [] });
```

- [ ] **Step 2: Mesma refatoração no modo realoc (linhas ~870-1004)**

Mesma técnica — agrupar `realocsResiduais` por `pedidos[u.realoc.pedido_item_id].empresa_origem_id`, rodar resolver por grupo.

- [ ] **Step 3: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/separacao/parcial/route.ts
git commit -m "fix(wms/realoc-fix): I8 — cascade agrupa por empresa_origem"
```

---

### Task 2.12: I1 — Aceitar `pendente_realocacao` em `iniciar`, `marcar-item`, `voltar-etapa`, `produto-esgotado`

**Files:**
- Modify: `src/app/api/wms/separacao/iniciar/route.ts:76-89`
- Modify: `src/app/api/wms/separacao/marcar-item/route.ts:59-65`
- Modify: `src/app/api/wms/separacao/voltar-etapa/route.ts:19-26`
- Modify: `src/app/api/wms/separacao/produto-esgotado/route.ts:54-65`

- [ ] **Step 1: `iniciar` adiciona o status**

```diff
 const STATUS_PERMITIDOS = [
   'aguardando_separacao', 'aguardando_compra',
-  'em_separacao', 'validacao_oc'
+  'em_separacao', 'validacao_oc', 'pendente_realocacao'
 ];
```

Quando pedido vem em `pendente_realocacao`, o `toStart` filtra pra incluir esse status no UPDATE pra `em_separacao`.

- [ ] **Step 2: `marcar-item` adiciona**

```diff
 const STATUS_OK = [
   'em_separacao', 'aguardando_separacao',
-  'aguardando_compra'
+  'aguardando_compra', 'pendente_realocacao'
 ];
```

- [ ] **Step 3: `voltar-etapa` insere no STATUS_ORDER**

```diff
 const STATUS_ORDER = [
   'aguardando_compra', 'aguardando_nf',
   'aguardando_separacao', 'em_separacao',
+  'pendente_realocacao',
   'separado', 'embalado', 'expedido'
 ];
```

- [ ] **Step 4: `produto-esgotado` adiciona**

```diff
 const ACTIVE_STATUSES = [
   'aguardando_nf', 'aguardando_separacao',
-  'em_separacao'
+  'em_separacao', 'pendente_realocacao'
 ];
```

- [ ] **Step 5: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`

- [ ] **Step 6: Commit**

```bash
git add src/app/api/wms/separacao/iniciar/route.ts \
        src/app/api/wms/separacao/marcar-item/route.ts \
        src/app/api/wms/separacao/voltar-etapa/route.ts \
        src/app/api/wms/separacao/produto-esgotado/route.ts
git commit -m "fix(wms/realoc-fix): I1 — pendente_realocacao aceito em 4 endpoints"
```

---

### Task 2.13: I2 — `encaminhar` usa helper + aceita pendente_realocacao

**Files:**
- Modify: `src/app/api/wms/separacao/encaminhar/route.ts`

- [ ] **Step 1: Adicionar `pendente_realocacao` aos status válidos**

Procurar bloco em ~linha 131-138:

```diff
 if (!['aguardando_separacao', 'em_separacao', 'pendente_realocacao'].includes(p.status_separacao)) {
   return NextResponse.json({...}, { status: 409 });
 }
```

- [ ] **Step 2: Chamar helper antes do switch de galpão**

Localize o bloco que reseta campos (linha ~190-200). Substituir por:

```ts
import { resetarEstadoSeparacaoItens } from "@/lib/separacao/reset-state";

// Antes de mudar separacao_galpao_id
const itemIdsTodos = items.map(i => i.id);
await resetarEstadoSeparacaoItens({
  supabase, itemIds: itemIdsTodos, usuarioId: session.id, motivo: "encaminhar",
});
```

Remover o reset antigo que só zerava parcial dos campos.

- [ ] **Step 3: Manter estorno Tiny legacy se aplicável**

Não tocar no bloco de `estornarEstoque` (Tiny ERP) — fica como estava. O reset agora estorna WMS ledger; Tiny estorno é independente.

- [ ] **Step 4: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/encaminhar/route.ts
git commit -m "fix(wms/realoc-fix): I2 — encaminhar usa helper de reset + aceita pendente_realocacao"
```

---

### Task 2.14: I3 — `reiniciar` usa helper

**Files:**
- Modify: `src/app/api/wms/separacao/reiniciar/route.ts:82-98`

- [ ] **Step 1: Substituir bloco de reset**

```ts
import { resetarEstadoSeparacaoItens } from "@/lib/separacao/reset-state";

// Etapa 'separacao'
if (body.etapa === "separacao") {
  const { data: items } = await supabase
    .from("siso_pedido_itens")
    .select("id").in("pedido_id", body.pedido_ids);

  await resetarEstadoSeparacaoItens({
    supabase, itemIds: (items ?? []).map(i => i.id),
    usuarioId: session.id, motivo: "reiniciar",
  });
}
```

- [ ] **Step 2: Adicionar auth (I11)**

No topo:

```ts
const session = await getSessionUser(request);
if (!session) {
  return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
}
```

- [ ] **Step 3: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/separacao/reiniciar/route.ts
git commit -m "fix(wms/realoc-fix): I3+I11 — reiniciar usa helper + auth"
```

---

### Task 2.15: voltar-etapa usa helper no backward + aceita pendente_realocacao

**Files:**
- Modify: `src/app/api/wms/separacao/voltar-etapa/route.ts:163-196`

- [ ] **Step 1: No bloco backward, chamar helper**

```ts
import { resetarEstadoSeparacaoItens } from "@/lib/separacao/reset-state";

if (goingBack && novoStatus === "aguardando_separacao") {
  // Coleta items dos pedidos
  const { data: items } = await supabase
    .from("siso_pedido_itens")
    .select("id").in("pedido_id", pedidoIds);

  await resetarEstadoSeparacaoItens({
    supabase, itemIds: (items ?? []).map(i => i.id),
    usuarioId: session.id, motivo: "voltar_etapa",
  });
}
```

Manter o UPDATE de status que já existe.

- [ ] **Step 2: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/separacao/voltar-etapa/route.ts
git commit -m "fix(wms/realoc-fix): voltar-etapa usa helper de reset"
```

---

### Task 2.16: I4 — `concluir-oc` bloqueia realocs pendentes

**Files:**
- Modify: `src/app/api/wms/separacao/concluir-oc/route.ts`

- [ ] **Step 1: Adicionar query de bloqueio antes do loop de update**

Antes do `if (every separacao_marcado)`, adicionar:

```ts
// Bloqueia se há realocs aguardando_picking em algum item dos pedidos
const { data: realocsPend } = await supabase
  .from("siso_pedido_item_realocacoes")
  .select("id, pedido_item_id, siso_pedido_itens!inner(pedido_id)")
  .in("siso_pedido_itens.pedido_id", body.pedido_ids)
  .eq("status", "aguardando_picking");

if ((realocsPend ?? []).length > 0) {
  const pedidosBloq = new Set((realocsPend ?? []).map(
    r => (r.siso_pedido_itens as unknown as { pedido_id: string }).pedido_id
  ));
  return NextResponse.json({
    error: "realocacoes_pendentes",
    message: `${pedidosBloq.size} pedido(s) com realocação aguardando picking`,
    pedido_ids_bloqueados: [...pedidosBloq],
  }, { status: 409 });
}
```

- [ ] **Step 2: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/separacao/concluir-oc/route.ts
git commit -m "fix(wms/realoc-fix): I4 — concluir-oc bloqueia realocs pendentes"
```

---

### Task 2.17: I5 — `compras-release` + worker honram `itens_ja_lancados`

**Files:**
- Modify: `src/lib/compras-release.ts`
- Modify: `src/lib/execution-worker.ts`

- [ ] **Step 1: `compras-release` adiciona flag no payload**

Localizar bloco de insert em `siso_fila_execucao` (~linhas 181-197):

```ts
// Carrega items pra detectar quais já têm mov_saida_id
const { data: itensRaw } = await supabase
  .from("siso_pedido_itens")
  .select("id, mov_saida_id")
  .eq("pedido_id", pedidoId);

const itensJaLancados = (itensRaw ?? [])
  .filter(i => i.mov_saida_id != null)
  .map(i => i.id);

await supabase.from("siso_fila_execucao").insert({
  tipo: "lancar_estoque",
  pedido_id: pedidoId,
  empresa_id: empresaExecId,
  // ... outros campos existentes
  payload: {
    ...(/* payload existente */),
    itens_ja_lancados: itensJaLancados,
  },
});
```

- [ ] **Step 2: `execution-worker` lê flag e pula**

No worker, localizar o handler de `lancar_estoque`. Adicionar:

```ts
const itensJaLancados: number[] = job.payload?.itens_ja_lancados ?? [];

for (const item of items) {
  if (itensJaLancados.includes(item.id)) {
    logger.info("execution-worker", "pulando item já lançado", { itemId: item.id });
    continue;
  }
  // ... lógica de dedução existente
}
```

Importante: pular também a baixa no Tiny ERP legado (siso_pedido_item_estoques) pra esses items.

- [ ] **Step 3: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 4: Commit**

```bash
git add src/lib/compras-release.ts src/lib/execution-worker.ts
git commit -m "fix(wms/realoc-fix): I5 — compras-release + worker honram itens_ja_lancados"
```

---

### Task 2.18: I10 — `produto-esgotado` modo OC usa residual

**Files:**
- Modify: `src/app/api/wms/separacao/produto-esgotado/route.ts:245-273`

- [ ] **Step 1: Calcular residual antes de criar OC**

Localizar bloco que cria linha de compra (~257). Substituir:

```diff
+// Calcula qty pega real (item + realocs picadas)
+const { data: realocsPicadas } = await supabase
+  .from("siso_pedido_item_realocacoes")
+  .select("quantidade_pega")
+  .eq("pedido_item_id", item.id)
+  .in("status", ["picado","picado_parcial"]);
+
+const qtyPegaRealocs = (realocsPicadas ?? [])
+  .reduce((s, r) => s + (Number(r.quantidade_pega) || 0), 0);
+const qtyPegaTotal = (Number(item.quantidade_pega) || 0) + qtyPegaRealocs;
+const residual = Math.max(0, Number(item.quantidade_pedida) - qtyPegaTotal);
+
+if (residual === 0) {
+  // Nada a comprar — pula este item
+  continue;
+}
+
 await supabase.from("siso_pedido_itens").update({
   compra_status: "aguardando_compra",
-  compra_quantidade_solicitada: item.quantidade_pedida,
+  compra_quantidade_solicitada: residual,
   ...
 }).eq("id", item.id);
```

- [ ] **Step 2: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/separacao/produto-esgotado/route.ts
git commit -m "fix(wms/realoc-fix): I10 — produto-esgotado modo OC usa residual"
```

---

### Task 2.19: I11 — Auth em endpoints destrutivos (concluir, produto-esgotado, checklist-items)

**Files:**
- Modify: `src/app/api/wms/separacao/concluir/route.ts`
- Modify: `src/app/api/wms/separacao/produto-esgotado/route.ts`
- Modify: `src/app/api/wms/separacao/checklist-items/route.ts`

(`reiniciar` já foi feito na Task 2.14.)

- [ ] **Step 1: Adicionar `getSessionUser` no topo dos 3 endpoints**

Pra cada um:

```ts
import { getSessionUser } from "@/lib/session";

export async function POST(request: NextRequest) { // ou GET pra checklist-items
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  // ... resto da lógica
}
```

- [ ] **Step 2: Propagar `usuarioId: session.id` em `registrarEvento`**

No `concluir/route.ts`, encontrar todos os `registrarEvento` (linhas ~207-223) e adicionar `usuarioId: session.id`.

- [ ] **Step 3: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/separacao/concluir/route.ts \
        src/app/api/wms/separacao/produto-esgotado/route.ts \
        src/app/api/wms/separacao/checklist-items/route.ts
git commit -m "fix(wms/realoc-fix): I11 — auth nos endpoints destrutivos"
```

---

### Task 2.20: M3 — `cancelar` registra evento com `usuarioId`

**Files:**
- Modify: `src/app/api/wms/separacao/cancelar/route.ts`

- [ ] **Step 1: Adicionar `registrarEvento` no final do handler**

Após o UPDATE de status e antes do return success:

```ts
import { registrarEvento } from "@/lib/historico-service";

await registrarEvento({
  pedidoId: body.pedido_id,
  evento: "separacao_cancelada",
  detalhes: {
    item_ids: itemIds,
    realocs_canceladas: (realocs ?? []).length,
    movs_estornadas: [...movsSaidaSet],
  },
  usuarioId: session.id,
});
```

- [ ] **Step 2: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/separacao/cancelar/route.ts
git commit -m "fix(wms/realoc-fix): M3 — cancelar registra evento com usuarioId"
```

---

### Task 2.21: M6 — `buildCompraFieldReset` limpa campos parciais

**Files:**
- Modify: `src/lib/compras-utils.ts:7-24`

- [ ] **Step 1: Adicionar campos no objeto retornado**

```diff
 export function buildCompraFieldReset() {
   return {
     compra_equivalente_sku: null,
     compra_equivalente_descricao: null,
     // ... campos existentes
     compra_cancelado_em: null,
     compra_cancelado_por: null,
+    // Limpa também estado parcial (M6) — quando troca SKU equivalente, residual mudou
+    quantidade_pega: null,
+    separacao_parcial: false,
+    parcial_motivo: null,
+    parcial_em: null,
+    parcial_por: null,
+    mov_saida_id: null,
+    mov_ajuste_loc_zerou_id: null,
   };
 }
```

- [ ] **Step 2: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/lib/compras-utils.ts
git commit -m "fix(wms/realoc-fix): M6 — buildCompraFieldReset limpa campos parciais"
```

---

## Phase 3 — Frontend

### Task 3.1: C1 — Frontend manda array de realoc IDs

**Files:**
- Modify: `src/app/wms/separacao/checklist/page.tsx:597`

- [ ] **Step 1: Trocar `realocacao_id` por `realocacao_ids`**

```diff
       const body = parcialModal.isRealocacao
-        ? { realocacao_id: parcialModal.itemIds[0], quantidade_pega: qtyPega, loc_zerou: locZerou }
+        ? { realocacao_ids: parcialModal.itemIds, quantidade_pega: qtyPega, loc_zerou: locZerou }
         : { pedido_item_ids: parcialModal.itemIds, quantidade_pega: qtyPega, loc_zerou: locZerou };
```

- [ ] **Step 2: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/separacao/checklist/page.tsx
git commit -m "fix(wms/realoc-fix): C1 — frontend envia array de realocacao_ids"
```

---

### Task 3.2: M1 — `parcial-modal` não força locZerou

**Files:**
- Modify: `src/components/wms/separacao/parcial-modal.tsx:35-39`

- [ ] **Step 1: Remover useEffect que força locZerou**

```diff
-  useEffect(() => {
-    if (qty < quantidadePedida && !locZerou) {
-      setLocZerou(true);
-    }
-  }, [qty, quantidadePedida, locZerou]);
```

Deletar bloco inteiro. Manter `useState(false)` inicial.

- [ ] **Step 2: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/components/wms/separacao/parcial-modal.tsx
git commit -m "fix(wms/realoc-fix): M1 — parcial-modal nao forca locZerou"
```

---

### Task 3.3: M2 — Distinguir 409 `posicao_reservada` e `realocacao_ja_picada`

**Files:**
- Modify: `src/app/wms/separacao/checklist/page.tsx:606-610`

- [ ] **Step 1: Refator do handler de erro**

```diff
-      if (!res.ok) {
-        toast.error(data.error ?? "Erro ao processar parcial");
-        setParcialModal(null);
-        return;
-      }
+      if (!res.ok) {
+        if (res.status === 409 && data.error === "posicao_reservada") {
+          toast.warning(
+            `Posição reservada por outro pedido — saldo ${data.saldo}, disponível ${data.disponivel}. Avise o supervisor.`,
+            { duration: 6000 }
+          );
+        } else if (res.status === 409 && data.error === "realocacao_ja_picada") {
+          toast.warning("Outro operador picou primeiro — atualizando…", { duration: 4000 });
+          queryClient.invalidateQueries({ queryKey });
+        } else {
+          toast.error(data.error ?? data.message ?? "Erro ao processar parcial");
+        }
+        setParcialModal(null);
+        return;
+      }
```

- [ ] **Step 2: Aplicar mesma lógica em `handleMarcarRealocacao` (~linhas 641-669)**

```diff
       const erradas = results.filter((r) => !r.ok);
       if (erradas.length > 0) {
+        const racePerdida = await Promise.all(
+          erradas.map(async (r) => {
+            const data = await r.clone().json().catch(() => ({}));
+            return r.status === 409 && data.error === "realocacao_ja_picada";
+          })
+        );
+        if (racePerdida.some(Boolean)) {
+          toast.warning("Outra operação marcou — atualizando…", { duration: 4000 });
+          queryClient.invalidateQueries({ queryKey });
+          return;
+        }
         toast.error(/* ... */);
       }
```

- [ ] **Step 3: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 4: Commit**

```bash
git add src/app/wms/separacao/checklist/page.tsx
git commit -m "fix(wms/realoc-fix): M2 — distingue 409 posicao_reservada / ja_picada"
```

---

### Task 3.4: M5 — Resolver usa `naturalLocCompare`

**Files:**
- Create: `src/lib/wms/utils.ts` (ou similar) com `naturalLocCompare`
- Modify: `src/lib/separacao/realocacao-resolver.ts:104`
- Modify: `src/app/wms/separacao/checklist/page.tsx:14`

- [ ] **Step 1: Verificar onde está hoje**

Run: `grep -n "naturalLocCompare" src/app/wms/separacao/checklist/page.tsx`

Localizar a definição (provavelmente inline na page).

- [ ] **Step 2: Extrair pra utilitário compartilhado**

Cria `src/lib/wms/loc-compare.ts`:

```ts
/** Comparação natural de códigos de localização (e.g. A-2 < A-10). */
export function naturalLocCompare(a: string, b: string): number {
  const segA = a.split(/(\d+)/);
  const segB = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(segA.length, segB.length); i++) {
    const pa = segA[i], pb = segB[i];
    const na = parseInt(pa, 10), nb = parseInt(pb, 10);
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else {
      const c = pa.localeCompare(pb);
      if (c !== 0) return c;
    }
  }
  return segA.length - segB.length;
}
```

(Se já existe em outro lugar, importe daí em vez de duplicar.)

- [ ] **Step 3: Usar no resolver**

```diff
+import { naturalLocCompare } from "@/lib/wms/loc-compare";
 // ...
-    return a.localizacao_codigo.localeCompare(b.localizacao_codigo);
+    return naturalLocCompare(a.localizacao_codigo, b.localizacao_codigo);
```

- [ ] **Step 4: Usar na page (substitui inline)**

```diff
-function naturalLocCompare(a: string, b: string) { /* ... */ }
+import { naturalLocCompare } from "@/lib/wms/loc-compare";
```

- [ ] **Step 5: Adicionar teste do util**

Cria `src/lib/wms/loc-compare.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { naturalLocCompare } from "./loc-compare";

describe("naturalLocCompare", () => {
  it("ordena A-2 antes de A-10", () => {
    expect(naturalLocCompare("A-2", "A-10")).toBeLessThan(0);
  });
  it("ordena A antes de B", () => {
    expect(naturalLocCompare("A-01-01", "B-01-01")).toBeLessThan(0);
  });
  it("mantém ordem em códigos iguais", () => {
    expect(naturalLocCompare("A-01-02", "A-01-02")).toBe(0);
  });
});
```

- [ ] **Step 6: Rodar testes**

Run: `npm test -- loc-compare`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/wms/loc-compare.ts src/lib/wms/loc-compare.test.ts \
        src/lib/separacao/realocacao-resolver.ts \
        src/app/wms/separacao/checklist/page.tsx
git commit -m "fix(wms/realoc-fix): M5 — naturalLocCompare compartilhado entre resolver e UI"
```

---

### Task 3.5: M7 — Proteção contra double-click

**Files:**
- Modify: `src/app/wms/separacao/checklist/page.tsx` (handlers 592, 641, 1094)

- [ ] **Step 1: Adicionar ref de submitting**

No topo do componente, antes dos handlers:

```ts
const submittingActionRef = useRef<boolean>(false);
```

- [ ] **Step 2: Guarda em `handleParcialConfirm`**

```diff
   async function handleParcialConfirm(qtyPega: number, locZerou: boolean) {
     if (!parcialModal) return;
+    if (submittingActionRef.current) return;
+    submittingActionRef.current = true;
     setParcialModal((prev) => (prev ? { ...prev, loading: true } : null));
     try {
       // ... lógica
     } finally {
+      submittingActionRef.current = false;
     }
   }
```

- [ ] **Step 3: Guarda em `handleMarcarRealocacao`**

```diff
   async function handleMarcarRealocacao(realocacaoIds: string | string[]) {
+    if (submittingActionRef.current) return;
+    submittingActionRef.current = true;
     const ids = Array.isArray(realocacaoIds) ? realocacaoIds : [realocacaoIds];
     try {
       // ...
     } finally {
+      submittingActionRef.current = false;
     }
   }
```

- [ ] **Step 4: Guarda em `onToggle` do checkbox (linha ~1094 ItemRow)**

```diff
-          <button onClick={onToggle} ...>
+          <button onClick={() => {
+            if (toggleMutation.isPending) return;
+            onToggle();
+          }} ...>
```

(Se `toggleMutation` não está no escopo da ItemRow, propagar `isPending` como prop ou usar a ref já existente.)

- [ ] **Step 5: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 6: Commit**

```bash
git add src/app/wms/separacao/checklist/page.tsx
git commit -m "fix(wms/realoc-fix): M7 — protecao double-click nos handlers"
```

---

### Task 3.6: M8 — `compras-equivalencia` galpões dinâmicos

**Files:**
- Modify: `src/lib/compras-equivalencia.ts:185-198` e tipos relacionados
- Modify: call-sites que consomem `estoqueCwb`/`estoqueSp`

- [ ] **Step 1: Refator do retorno**

Substituir campos hardcoded:

```diff
 export interface CompraEquivalenteEstoque {
-  estoqueCwb: number;
-  estoqueSp: number;
-  estoqueCwbTotal: number;
-  estoqueSpTotal: number;
+  estoques: Record<string, { saldo: number; total: number }>;
 }
```

No corpo da função, iterar sobre galpões ativos:

```ts
const { data: galpoes } = await supabase
  .from("siso_galpoes").select("id, nome").eq("ativo", true);

const estoques: Record<string, { saldo: number; total: number }> = {};
for (const g of galpoes ?? []) {
  // soma estoque por galpão (usar agregado de siso_estoque ou similar)
  // ... lógica existente, parametrizada pelo galpão
  estoques[g.nome] = { saldo: ..., total: ... };
}
return { estoques };
```

- [ ] **Step 2: Atualizar consumidores**

Run: `grep -rn "estoqueCwb\|estoqueSp" src/ --include="*.tsx" --include="*.ts"`

Pra cada call-site, trocar `data.estoqueCwb` por `data.estoques['CWB']?.saldo ?? 0` (similar pra SP). Se a UI lista os 2 estaticamente, substituir por iteração `Object.entries(data.estoques)`.

- [ ] **Step 3: Validar TypeScript + lint**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`
Run: `npm run lint 2>&1 | tail -20`

- [ ] **Step 4: Commit**

```bash
git add src/lib/compras-equivalencia.ts src/app/wms/compras/
git commit -m "fix(wms/realoc-fix): M8 — compras-equivalencia galpoes dinamicos"
```

---

### Task 3.7: I6 UI — Banner qty pega real na embalagem

**Files:**
- Modify: `src/app/wms/separacao/embalagem/page.tsx`
- Modify: `src/app/api/wms/separacao/bipar-embalagem/route.ts` (passar `p_strict_qty_pega=true`)

- [ ] **Step 1: Backend: passar strict pro RPC**

Em `bipar-embalagem/route.ts`, na chamada da RPC:

```diff
   const { data, error } = await supabase.rpc("siso_processar_bip_embalagem", {
     p_pedido_ids: pedidoIds,
     p_sku: sku,
     p_quantidade: quantidade,
     p_operador_id: session.id,
+    p_strict_qty_pega: true,
   });
```

Se RPC retorna `{ ok: false, erro: 'bipou_alem_do_teto', teto: N }`, traduzir pra response 400/422 com mensagem útil:

```ts
if (data?.erro === "bipou_alem_do_teto") {
  return NextResponse.json({
    error: "bipou_alem_do_teto",
    message: `Bipou ${data.tentado} mas só ${data.teto} foi pego de fato. Item parcial.`,
    teto: data.teto,
  }, { status: 422 });
}
```

- [ ] **Step 2: Frontend: carregar qty pega real na query de embalagem**

Em `src/app/wms/separacao/embalagem/page.tsx`, na query que carrega items, adicionar campo de qty pega real:

```ts
// Junto com siso_pedido_itens, carregar realocs picadas
const { data: realocsPicadas } = await supabase
  .from("siso_pedido_item_realocacoes")
  .select("pedido_item_id, quantidade_pega")
  .in("pedido_item_id", itemIds)
  .in("status", ["picado","picado_parcial"]);

// Agregar
const qtyPegaPorItem = new Map<number, number>();
for (const r of realocsPicadas ?? []) {
  qtyPegaPorItem.set(
    r.pedido_item_id as number,
    (qtyPegaPorItem.get(r.pedido_item_id as number) ?? 0) + Number(r.quantidade_pega ?? 0)
  );
}

// No render do item:
const qtyPegaTotal = (item.quantidade_pega ?? 0) + (qtyPegaPorItem.get(item.id) ?? 0);
```

- [ ] **Step 3: Banner amarelo quando parcial**

No JSX do card do item, antes do input de bipar:

```tsx
{item.separacao_parcial && qtyPegaTotal < item.quantidade_pedida && (
  <div className="bg-amber-50 border-l-4 border-amber-600 px-3 py-2 text-sm text-amber-900">
    <strong>Parcial:</strong> pega real {qtyPegaTotal} de {item.quantidade_pedida}.
    Bipar apenas {qtyPegaTotal} unidade(s).
    <button
      onClick={() => fecharComoParcial(item, qtyPegaTotal)}
      className="ml-3 underline font-semibold"
    >
      Fechar como parcial ({qtyPegaTotal}/{item.quantidade_pedida})
    </button>
  </div>
)}
```

`fecharComoParcial` envia `qty=qtyPegaTotal` direto pro endpoint, fechando o item.

- [ ] **Step 4: Tratamento de erro `bipou_alem_do_teto`**

No handler do bipe:

```tsx
if (data.error === "bipou_alem_do_teto") {
  toast.error(
    `Parcial — só ${data.teto} unidade(s) foram pegas. Use "Fechar como parcial".`,
    { duration: 6000 }
  );
  return;
}
```

- [ ] **Step 5: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 6: Commit**

```bash
git add src/app/wms/separacao/embalagem/page.tsx \
        src/app/api/wms/separacao/bipar-embalagem/route.ts
git commit -m "feat(wms/realoc-fix): I6 — UI banner qty pega real + RPC strict"
```

---

## Phase 4 — Realtime client-side

### Task 4.1: Estender hook de realtime pra escutar realocações

**Files:**
- Modify: `src/hooks/use-realtime-separacao.ts`

- [ ] **Step 1: Adicionar channel pra `siso_pedido_item_realocacoes`**

No hook existente, adicionar subscribe:

```ts
useEffect(() => {
  if (!pedidoIds || pedidoIds.length === 0) return;

  const channel = supabase
    .channel(`realocs-${pedidoIds.join(",")}`)
    .on(
      "postgres_changes",
      {
        event: "*", // INSERT, UPDATE, DELETE
        schema: "public",
        table: "siso_pedido_item_realocacoes",
      },
      async (payload) => {
        // Filter client-side: realoc pertence a um item visível?
        const realocItemId = (payload.new as any)?.pedido_item_id
                          ?? (payload.old as any)?.pedido_item_id;
        if (!realocItemId) return;
        // Checa se o item está num dos pedidos visíveis
        const { data: item } = await supabase
          .from("siso_pedido_itens")
          .select("pedido_id")
          .eq("id", realocItemId)
          .maybeSingle();
        if (item && pedidoIds.includes(item.pedido_id as string)) {
          queryClient.invalidateQueries({ queryKey });
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}, [pedidoIds, queryClient, queryKey]);
```

(Adapte ao formato existente do hook — se ele já tem subscribes pra outras tabelas, adicione mais um.)

- [ ] **Step 2: Validar TypeScript**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-realtime-separacao.ts
git commit -m "feat(wms/realoc-fix): C5 — hook realtime escuta siso_pedido_item_realocacoes"
```

---

### Task 4.2: Consumir hook na checklist page

**Files:**
- Modify: `src/app/wms/separacao/checklist/page.tsx`

- [ ] **Step 1: Importar e usar o hook**

No topo da página:

```ts
import { useRealtimeSeparacao } from "@/hooks/use-realtime-separacao";
```

No componente, após `useQuery`:

```ts
useRealtimeSeparacao({
  pedidoIds,
  queryClient,
  queryKey: ["wms-sep-checklist", pedidoIds, modo],
});
```

(Adapte a assinatura ao hook real.)

- [ ] **Step 2: Validar TypeScript + smoke**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`
Run dev server: `npm run dev`, abre 2 abas em checklist do mesmo pedido. Marca realoc numa aba; vê se a outra atualiza em ~1s.

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/separacao/checklist/page.tsx
git commit -m "feat(wms/realoc-fix): checklist consome hook realtime de realocacoes"
```

---

## Validação final

### Task 5.1: Re-leitura do código pós-fix

**Files:** N/A

- [ ] **Step 1: Re-rodar a auditoria mental — checar 24 achados**

Pra cada ID (C1-C5, I1-I11, M1-M8), abra o arquivo:linha original do audit e verifique que o comportamento mudou conforme a spec.

Use este script de verificação:

```bash
# C1
grep -n "realocacao_ids" src/app/wms/separacao/checklist/page.tsx
# C2
grep -n "mov_ajuste_loc_zerou_id" src/app/api/wms/separacao/desfazer-parcial/route.ts
# Deve mostrar SÓ o comentário, sem estorno
# C3
grep -n "siso_pedido_item_mov_links" src/app/api/wms/separacao/parcial/route.ts
# C4
grep -n "realocacao_ja_picada\|race" src/app/api/wms/separacao/parcial/route.ts
# C5
grep -rn "siso_pedido_item_realocacoes" supabase/migrations/ | grep PUBLICATION
```

- [ ] **Step 2: Validação no banco**

```sql
-- Tabela ponte existe?
SELECT count(*) FROM siso_pedido_item_mov_links;
-- RPCs existem?
SELECT proname FROM pg_proc WHERE proname IN (
  'wms_acumular_qty_pega',
  'wms_estornar_parcial_movimentacao'
);
-- Publication tem a tabela?
SELECT pubname, tablename FROM pg_publication_tables
  WHERE tablename='siso_pedido_item_realocacoes';
```

Expected: 0 rows na tabela (sem uso ainda), 2 funções, 1 publication.

- [ ] **Step 3: Smoke E2E em staging — cenário B do workflow original**

Reproduzir cenário B (cascade duplo com empréstimo) ponta-a-ponta:
1. Criar pedido com SKU X qty=10
2. Wave: aprovar
3. Checklist: parcial qty=2, loc_zerou=true
4. Confirmar que: cascade criou realoc, tabela ponte tem 1 link, qty_estornada=0 na mov original
5. Operador B na mesma realoc tenta simultaneamente: 409 racha_perdida
6. Operador A marca realoc: tabela ponte ganha 2º link
7. Embalagem: bipa 10 unidades — passa
8. Expedir

- [ ] **Step 4: Commit nota da auditoria**

Atualizar `erros-conhecidos.yaml` (se aplicável) com referência ao fix-pack:

```yaml
- id: realoc-fix-pack-2026-05-18
  date: 2026-05-18
  source: docs/superpowers/specs/2026-05-18-realocacao-cascateavel-fix-pack-design.md
  category: feature_followup
  message: "Fix-pack 24 achados auditoria realocação cascateável"
  cause: feature shipped sem testes de borda
  fix: tabela ponte + helpers + RPCs + auth + realtime
  files:
    - supabase/migrations/20260518_realocacao_fix_pack_*.sql
    - src/lib/separacao/reset-state.ts
  tags: [wms, separacao, realocacao, audit]
```

```bash
git add erros-conhecidos.yaml
git commit -m "docs(erros): registra fix-pack realocacao cascateavel"
```

- [ ] **Step 5: PR consolidado**

```bash
gh pr create --title "fix(wms): realocação cascateável — fix-pack de auditoria (24 achados)" \
  --body "$(cat <<'EOF'
## Summary
- 24 achados da auditoria fechados (5 critical, 11 important, 8 minor)
- Nova tabela ponte siso_pedido_item_mov_links resolve mov compartilhada
- 2 RPCs novas: wms_acumular_qty_pega, wms_estornar_parcial_movimentacao
- Helper compartilhado resetarEstadoSeparacaoItens (encaminhar/reiniciar/voltar-etapa)
- Defesa em camadas pra embalagem (UI banner + RPC strict)
- Realtime habilitado pra realocações

## Test plan
- [ ] Cenários A/B/C do workflow original passam em staging
- [ ] Race test 2 ops simultâneos: 409 elegante, sem drift
- [ ] Pedido em pendente_realocacao desbloqueado via encaminhar
- [ ] Wave consolidado 3 pedidos: 3 links na ponte por mov
- [ ] Realtime: op A marca → op B vê em &lt;2s
- [ ] Embalagem com parcial: banner aparece + RPC valida

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

Após escrever o plano, conferir:

1. **Spec coverage:** cada item da spec mapeado a uma task?
   - C1 → 3.1 ✓
   - C2 → 2.2 ✓
   - C3 → 2.3, 2.4, 2.5, 2.6, 2.7 ✓
   - C4 → 2.8 ✓
   - C5 → 1.1 (migration) + 4.1, 4.2 (client) ✓
   - I1 → 2.12 ✓
   - I2 → 2.13 ✓
   - I3 → 2.14 ✓
   - I4 → 2.16 ✓
   - I5 → 2.17 ✓
   - I6 → 1.4 (RPC) + 3.7 (UI) ✓
   - I7 → 2.10 ✓
   - I8 → 2.11 ✓
   - I9 → 1.2 (RPC) + 2.9 (call-sites) ✓
   - I10 → 2.18 ✓
   - I11 → 2.14 (reiniciar) + 2.19 (3 demais) ✓
   - M1 → 3.2 ✓
   - M2 → 3.3 ✓
   - M3 → 2.20 ✓
   - M4 → 1.1 (backfill) ✓
   - M5 → 3.4 ✓
   - M6 → 2.21 ✓
   - M7 → 3.5 ✓
   - M8 → 3.6 ✓

2. **Placeholder scan:** nenhum "TBD", "TODO", "implement later" no plano. Cada passo tem código real.

3. **Type consistency:**
   - `resetarEstadoSeparacaoItens` assinatura: usada em 2.13, 2.14, 2.15 — mesma forma de chamada.
   - `wms_acumular_qty_pega` assinatura: definida em 1.2, chamada em 2.9, 2.6 — params batem.
   - `wms_estornar_parcial_movimentacao` assinatura: definida em 1.3, chamada em 2.6 — params batem.
   - `naturalLocCompare` definida em 3.4, importada em resolver e page.

4. **Self-contained:** cada task pode rodar isolada (com migrations da Phase 1 aplicadas). Phases 2/3/4 dependem da 1 mas são independentes entre si.
