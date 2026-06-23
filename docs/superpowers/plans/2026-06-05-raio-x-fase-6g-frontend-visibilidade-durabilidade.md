# Raio-X Fase 6g — Frontend idempotência/UX, Visibilidade, Durabilidade residual e Regressão won't-fix Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal:** Fechar a cauda residual da remediação raio-x: (1) idempotência/UX de frontend — chave estável na venda nova, botões disabled durante mutation, surfacing de body de erro, forms de operador com galpão obrigatório; (2) visibilidade — Reabrir + realtime de divergências de inventário, auditoria de edição de produto, contagem de kit no histórico, insight de operador inativo, limpeza de operador no estorno de embalagem; (3) durabilidade residual — persistência de token ML com retry+alerta, cleanup de locks órfãos >24h, `cancelOcIfEmpty` com retry+surfacing; (4) won't-fix/regressão — travar com teste o comportamento atual decidido pelo dono (P004 acerto, P041 unlink, P042 permite-cancelar, P092 defer sync marketplace).

**Architecture:** Next.js 16 (App Router, `output: "standalone"`) + Supabase (service role no server, RPC plpgsql pra atomicidade). Frontend `use client` com TanStack React Query + Sonner. O backend já é idempotente em vários pontos (criar venda, remover veículo) — boa parte desta fase é **surfacing** e **guards de UI**, não infra nova. Três migrations (idempotency_key no ledger pro retroativo; tabela de auditoria de produto; coluna `eh_kit_bipado` em contagens). Nenhuma toca o caminho quente de separação.

**Tech Stack:** TypeScript strict · React 19 · TanStack React Query · Sonner · Zod (onde já usado) · Supabase JS (service role) · vitest (happy-dom) pra unit, vitest contra staging pra integration, runner E2E HTTP (`scripts/wms/cenarios`) pra scenarios. Migrations aplicadas via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (staging).

> **Harness alvo (project staging `ehbxpbeijofxtsbezwxd`):**
> - Unit: `npm test -- <arquivo>` (arquivos `src/**/*.test.ts(x)`).
> - Integration: `npm run test:integration` (arquivos `test/integration/**/*.test.ts`, serializado, trunca tabelas operacionais).
> - Scenarios E2E HTTP: `npm run scenarios:only -- <NN>` (arquivos `scripts/wms/cenarios/catalogo/NN-*.ts`, export `default satisfies Cenario`).

---

## PR 1: Frontend idempotency / UX [P071, P043, P146, P185, P168, P163, P134, P137, P076]

Idempotência estável na venda nova; devolver idempotente no servidor; idempotency_key durável no lançamento retroativo (migration); botões disabled durante carregamento/conexão; surfacing do body de erro na remoção de veículo; forms de operador exigindo ≥1 galpão na criação e edição; vendedor inativo fora do dropdown.

> Decisões vinculantes (notas do dono): P071 op1 (gerar key ao abrir o form); P043 op2 (ID único no servidor, conditional UPDATE por estado); P146 op3 (código único durável, recusa repetição horas depois); P185/P168 op1 (desabilitar botão); P163 op1 (erro claro no 2º clique); P134/P137 op2 (exigir ≥1 galpão); P076 op2 (vendedor inativo nem aparece).

### Task 1.1: Idempotency key estável na venda nova [P071]

**Files:**
- Modify: `src/app/wms/vendas/nova/page.tsx:120-128` (declarar ref estável), `:183` (reusar a key), `:220-232` (regenerar após sucesso)
- Test: `src/app/wms/vendas/nova/idempotency-key.test.tsx`

Hoje a key é gerada **dentro** de `submit` (`idempotency_key: crypto.randomUUID()`, linha 183). Cada clique gera uma key nova → o backend (que dedupa por `payload_original->>'idempotency_key'`, índice `idx_pedidos_idempotency_key`) não reconhece a duplicata. O fix extrai a geração da key pra fora do submit e expõe uma função pura testável que monta o payload reusando a key do ref.

- [ ] **Step 1 — RED:** criar `src/app/wms/vendas/nova/idempotency-key.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { buildVendaPayload } from "./page";

describe("buildVendaPayload — idempotency key estável", () => {
  const base = {
    clienteNome: "Cliente X",
    clienteCpf: "",
    canal: "Balcão",
    empresaOrigemId: "11111111-1111-4111-8111-111111111111",
    galpaoId: "22222222-2222-4222-8222-222222222222",
    modo: "separacao" as const,
    items: [{ produtoId: "33333333-3333-4333-8333-333333333333", quantidade: 1 }],
  };

  it("dois cliques com a MESMA key produzem o mesmo idempotency_key", () => {
    const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const p1 = buildVendaPayload({ ...base, idempotencyKey: key });
    const p2 = buildVendaPayload({ ...base, idempotencyKey: key });
    expect(p1.idempotency_key).toBe(key);
    expect(p2.idempotency_key).toBe(key);
    expect(p1.idempotency_key).toBe(p2.idempotency_key);
  });

  it("mapeia items pra { produto_id, quantidade }", () => {
    const p = buildVendaPayload({ ...base, idempotencyKey: "k" });
    expect(p.items).toEqual([{ produto_id: base.items[0].produtoId, quantidade: 1 }]);
  });
});
```
- [ ] **Step 2 — RODAR e ver falhar:** `npm test -- src/app/wms/vendas/nova/idempotency-key.test.tsx`
  Expected: FAIL com `buildVendaPayload is not a function` / `does not provide an export named 'buildVendaPayload'`.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** em `src/app/wms/vendas/nova/page.tsx`, extrair o builder puro e usar um ref estável.

  Adicionar o import de `useRef` no topo (linha 3):
```tsx
import { Suspense, useMemo, useRef, useState } from "react";
```
  Exportar o builder puro (acima de `export default function NovaVendaPage`):
```tsx
export function buildVendaPayload(args: {
  clienteNome: string;
  clienteCpf: string;
  canal: string;
  empresaOrigemId: string;
  galpaoId: string;
  modo: ModoVendaDireta;
  items: { produtoId: string; quantidade: number }[];
  idempotencyKey: string;
}): CriarVendaDiretaRequest {
  return {
    cliente_nome: args.clienteNome.trim(),
    cliente_cpf_cnpj: args.clienteCpf.trim() || null,
    canal_venda: args.canal,
    empresa_origem_id: args.empresaOrigemId,
    galpao_id: args.galpaoId,
    modo: args.modo,
    items: args.items.map((it) => ({ produto_id: it.produtoId, quantidade: it.quantidade })),
    idempotency_key: args.idempotencyKey,
  };
}
```
  Dentro de `NovaVendaBody`, declarar o ref estável (após `const [enviando, setEnviando] = useState(false);`, ~linha 121):
```tsx
  // P071: key gerada UMA vez ao montar o form; reusada em todo clique
  // (backend dedupa por payload_original->>'idempotency_key'). Regenerada
  // só após uma criação não-idempotente bem-sucedida.
  const idempotencyKeyRef = useRef(crypto.randomUUID());
```
  No `submit`, trocar o objeto inline pelo builder (substituir o bloco `const payload ... };` nas linhas 170-184):
```tsx
      const payload: CriarVendaDiretaRequest & { vendedor_id_alvo?: string } =
        buildVendaPayload({
          clienteNome,
          clienteCpf,
          canal,
          empresaOrigemId,
          galpaoId,
          modo,
          items: items.map((it) => ({
            produtoId: it.produto!.id,
            quantidade: it.quantidade,
          })),
          idempotencyKey: idempotencyKeyRef.current,
        });
```
  Após a criação bem-sucedida (logo antes de `router.push(...)`, ~linha 232), regenerar a key:
```tsx
      // Sucesso não-idempotente: libera uma próxima venda nova com key fresca.
      idempotencyKeyRef.current = crypto.randomUUID();
      router.push(`/wms/vendas/${encodeURIComponent(data.pedido_id)}`);
```
- [ ] **Step 4 — RODAR e ver passar:** `npm test -- src/app/wms/vendas/nova/idempotency-key.test.tsx`
  Expected: PASS (2 testes verdes).
- [ ] **Step 5 — COMMIT:** `git add src/app/wms/vendas/nova/page.tsx src/app/wms/vendas/nova/idempotency-key.test.tsx && git commit -m "fix(wms): idempotency key estável na venda nova (gerada ao abrir o form) [P071]"`
- [ ] **Step 6 — erros-conhecidos.yaml:** adicionar entrada:
```yaml
  - id: venda-nova-idempotency-key-por-clique
    date: "2026-06-05"
    source: wms/vendas/nova
    category: business_logic
    message: "Duplo clique em 'Criar venda' criava 2 pedidos: idempotency_key era gerada DENTRO do submit, então cada clique mandava uma key nova e o backend não reconhecia a duplicata."
    cause: >
      `idempotency_key: crypto.randomUUID()` no corpo de submit (page.tsx:183) anulava
      a dedup do backend (idx_pedidos_idempotency_key) — a proteção só vale com a mesma
      key entre cliques.
    fix: >
      Gerar a key UMA vez ao montar o form (useRef), reusá-la em todo clique via builder
      puro buildVendaPayload, e regenerar só após criação bem-sucedida.
    files:
      - src/app/wms/vendas/nova/page.tsx
      - src/app/wms/vendas/nova/idempotency-key.test.tsx
    tags: [vendas, idempotency, frontend, duplo-clique]
```

### Task 1.2: Devolver item idempotente no servidor [P043]

**Files:**
- Modify: `src/app/api/wms/compras/itens/[itemId]/devolver/route.ts:44-60` (conditional UPDATE por estado devolvível + 409)
- Test: `scripts/wms/cenarios/catalogo/85-devolver-item-idempotente.ts`

Hoje o `UPDATE` (linha 44-56) seta `compra_status='aguardando_compra'` sem precondição de estado. Dois POSTs idênticos ambos "sucedem" e retornam `ok:true`, registrando 2 eventos `compra_item_devolvido`. O fix adiciona um WHERE de estado devolvível e trata 0 linhas como 409 (já devolvido), idiomático ao guard 409 de cancelamento/confirmar.

- [ ] **Step 1 — RED:** criar `scripts/wms/cenarios/catalogo/85-devolver-item-idempotente.ts`:
```ts
import type { Cenario, Ctx } from "../_harness/types";

type Setup = { sku: string; itemId: string; ordemId: string };

export default {
  nome: "85 — Devolver item é idempotente (2º POST → 409, não duplica evento)",
  descricao:
    "Item OC 'comprado'; 1º POST /devolver retorna 200 e vira aguardando_compra; " +
    "2º POST idêntico deve ser REJEITADO (409 'já devolvido'), não ok:true.",
  tags: ["compras", "devolver", "idempotencia"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("85");
    await ctx.criarProduto({ sku, descricao: "Devolver idempotente 85" });
    return { sku, itemId: "", ordemId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    await ctx.aguardarStatus(id, "pendente", undefined, { timeout_ms: 20000 });
    await ctx.aprovar(id, "oc");
    await ctx.aguardarStatusSeparacao(id, "validacao_oc");

    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens").select("id").eq("pedido_id", id).single();
    const itemId = String((itemRow as { id: string }).id);
    setup.itemId = itemId;

    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: [itemId], acao: "esgotado",
    });
    await ctx.aguardarStatusSeparacao(id, "aguardando_compra");
    const { ordem_id } = await ctx.comprar({ sku, qty: 2, pedido_id: id });
    setup.ordemId = ordem_id;

    // 1º devolver → 200
    const r1 = await ctx.http.post(`/api/wms/compras/itens/${itemId}/devolver`, {});
    if (r1.status !== 200) throw new Error(`1º devolver esperado 200, veio ${r1.status}`);

    // 2º devolver (idêntico) → deve ser 409
    const r2 = await ctx.http.post(`/api/wms/compras/itens/${itemId}/devolver`, {});
    setup.__r2status = r2.status;
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    if ((setup as any).__r2status !== 409) {
      throw new Error(
        `2º devolver deveria retornar 409 (já devolvido), veio ${(setup as any).__r2status}`,
      );
    }
    // Só 1 evento compra_item_devolvido
    const { data: pedItem } = await ctx.sb
      .from("siso_pedido_itens").select("pedido_id").eq("id", setup.itemId).single();
    const { data: eventos } = await ctx.sb
      .from("siso_pedido_historico")
      .select("id, evento")
      .eq("pedido_id", (pedItem as { pedido_id: string }).pedido_id)
      .eq("evento", "compra_item_devolvido");
    if ((eventos ?? []).length !== 1) {
      throw new Error(
        `Esperado 1 evento compra_item_devolvido, achei ${(eventos ?? []).length}`,
      );
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })();
}
```
  > Nota: confirmar o nome real da tabela de histórico (`siso_pedido_historico`) com `registrarEvento` em `src/lib/historico-service.ts` antes de rodar; ajustar o `.from(...)` se divergir.
- [ ] **Step 2 — RODAR e ver falhar:** `npm run scenarios:only -- 85`
  Expected: FAIL com `2º devolver deveria retornar 409 (já devolvido), veio 200`.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** em `devolver/route.ts`, adicionar precondição de estado devolvível e tratar 0 linhas como 409. Substituir o bloco `const { data: updated, error: updateError } = ...` (linhas 44-58) por:
```ts
    // P043: conditional UPDATE por estado — só estados devolvíveis (NÃO
    // 'aguardando_compra'/'cancelado'). 0 linhas = 2ª devolução = 409 idempotente.
    // Lista VERIFICADA contra os literais de compra_status no código (não há
    // CHECK no schema — compra_status é text livre): 'comprado' é o estado pós
    // ctx.comprar (comprar/route.ts:145); 'oc_pendente' (execution-worker.ts:682);
    // 'parcialmente_recebido' (dashboard-tarefas.ts:872); 'equivalente_pendente'/
    // 'cancelamento_pendente'/'indisponivel' são COMPRA_EXCEPTION_STATUSES
    // (compras-utils.ts:33).
    const ESTADOS_DEVOLVIVEIS = [
      "comprado",
      "oc_pendente",
      "parcialmente_recebido",
      "equivalente_pendente",
      "cancelamento_pendente",
      "indisponivel",
    ];
    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        ...buildCompraFieldReset(),
        compra_status: "aguardando_compra",
        ordem_compra_id: null,
        comprado_em: null,
        comprado_por: null,
        compra_solicitada_em: item.compra_solicitada_em ?? new Date().toISOString(),
      })
      .eq("id", itemId)
      .in("compra_status", ESTADOS_DEVOLVIVEIS)
      .select("id, sku, descricao, fornecedor_oc, compra_status")
      .maybeSingle();

    if (updateError) throw new Error(`Erro ao atualizar item: ${updateError.message}`);
    if (!updated) {
      return NextResponse.json({ error: "Item já devolvido" }, { status: 409 });
    }
```
  > Nota (ancoragem): a busca inicial do item (linha 28-32) usa `.single()` mas JÁ trata `PGRST116` → 404 (linha 35) ANTES do UPDATE — não lança 500 pra item inexistente, então NÃO precisa virar `.maybeSingle()`. A troca pra `.maybeSingle()` é SÓ no UPDATE condicional (acima). Os 6 valores de `ESTADOS_DEVOLVIVEIS` foram verificados contra os literais de `compra_status` no código (sem CHECK no schema) — `comprado` é o estado em que o item cai após `ctx.comprar` no scenario 85, garantindo que o 1º POST encontra 1 linha (200) e o 2º (já `aguardando_compra`, fora da lista) dá 0 linhas → 409.
- [ ] **Step 4 — RODAR e ver passar:** `npm run scenarios:only -- 85`
  Expected: PASS.
- [ ] **Step 5 — COMMIT:** `git add src/app/api/wms/compras/itens/[itemId]/devolver/route.ts scripts/wms/cenarios/catalogo/85-devolver-item-idempotente.ts && git commit -m "fix(wms): devolver item idempotente (conditional UPDATE por estado + 409) [P043]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: compras-devolver-nao-idempotente
    date: "2026-06-05"
    source: wms/compras/devolver
    category: business_logic
    message: "POST /devolver não era idempotente: UPDATE sem precondição de estado deixava 2º clique 'suceder' (ok:true) e registrar evento duplicado."
    cause: >
      O UPDATE setava compra_status='aguardando_compra' sem WHERE de estado; cliques
      duplicados/concorrentes ambos retornavam 200.
    fix: >
      Conditional UPDATE com .in('compra_status', ESTADOS_DEVOLVIVEIS) + .maybeSingle();
      0 linhas afetadas → 409 'Item já devolvido'.
    files:
      - src/app/api/wms/compras/itens/[itemId]/devolver/route.ts
      - scripts/wms/cenarios/catalogo/85-devolver-item-idempotente.ts
    tags: [compras, devolver, idempotencia, 409]
```

### Task 1.3: Idempotency key durável no lançamento retroativo [P146] [MIGRATION/RPC]

**Files:**
- Create: `supabase/migrations/20260605_retroativo_idempotency.sql`
- Modify: `src/lib/wms/ledger.ts:65-105` (input), `:179-202` (passar `p_idempotency_key`); `src/lib/wms/movimentacoes.ts:485-541` (`lancarRetroativo` aceita `idempotency_key`); `src/app/api/wms/lancamento-retroativo/route.ts:79-99` (ler body + 200 idempotente)
- Test: `scripts/wms/cenarios/catalogo/86-retroativo-idempotente.ts`

A nota é explícita (op3): código único durável que recusa repetição **mesmo horas depois** — coluna + índice unique no ledger. Mecanismo: coluna `idempotency_key text` em `siso_movimentacoes` + UNIQUE PARTIAL INDEX; `wms_inserir_movimentacao` recebe `p_idempotency_key` e, em colisão (23505), o caller retorna a mov existente.

> Nota: divergência do achado — o change_site `src/app/wms/retroativos/*` cita um "form de criação"; o `page.tsx` atual **só lista e reconcilia** (não tem form de POST). O caller real do POST não existe hoje no frontend versionado. A defesa durável (coluna+índice+RPC+route) cobre o cenário independentemente de quem chama. O teste exercita a rota direto.

- [ ] **Step 1 — RED (migration + scenario):** criar a migration `supabase/migrations/20260605_retroativo_idempotency.sql`:
```sql
-- P146: idempotency durável pra lançamento retroativo (e base pra P184).
-- Coluna + índice único parcial em siso_movimentacoes; param no inserir_mov.
BEGIN;

ALTER TABLE siso_movimentacoes
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mov_idempotency_key
  ON siso_movimentacoes(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Dropa o overload ATUAL de 22 args (com p_motivo_categoria, criado em
-- 20260527_wms_inserir_mov_motivo_categoria.sql). Sem este DROP, o CREATE
-- abaixo (23 args) coexistiria com o de 22 → 2 overloads de contagem
-- diferente → ledger.ts passa args por NOME e o PG escolhe ambíguo (ou o
-- velho sem p_idempotency_key). Padrão idêntico ao de 20260512/20260527.
-- A lista de tipos abaixo é EXATAMENTE a assinatura de 20260527.
DROP FUNCTION IF EXISTS public.wms_inserir_movimentacao(
  uuid, uuid, uuid, character, numeric, text, text, jsonb, uuid,
  timestamptz, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid, text,
  numeric, text
);

-- Recria wms_inserir_movimentacao PRESERVANDO p_motivo_categoria (param #21,
-- grava motivo_categoria::wms_motivo_categoria_enum) e adicionando
-- p_idempotency_key (param #22, default NULL). Mantém a assinatura text de
-- origem_id/pedido_id (20260526). Adicionar o novo param no FIM preserva os
-- call-sites por named args (ledger.ts:179-202 passa p_motivo_categoria +
-- p_idempotency_key por nome).
CREATE OR REPLACE FUNCTION public.wms_inserir_movimentacao(
  p_produto_id            uuid,
  p_galpao_id             uuid,
  p_localizacao_id        uuid,
  p_tipo                  character,
  p_quantidade            numeric,
  p_origem_tipo           text,
  p_origem_id             text DEFAULT NULL,
  p_origem_detalhes       jsonb DEFAULT NULL,
  p_usuario_id            uuid DEFAULT NULL,
  p_expira_em             timestamptz DEFAULT NULL,
  p_estorno_de            uuid DEFAULT NULL,
  p_empresa_compradora_id uuid DEFAULT NULL,
  p_empresa_vendedora_id  uuid DEFAULT NULL,
  p_empresa_referencia_id uuid DEFAULT NULL,
  p_fornecedor_id         uuid DEFAULT NULL,
  p_motivo                text DEFAULT NULL,
  p_cliente_nome          text DEFAULT NULL,
  p_pedido_id             text DEFAULT NULL,
  p_nota_fiscal_id        uuid DEFAULT NULL,
  p_chave_acesso_nf       text DEFAULT NULL,
  p_custo_unitario        numeric DEFAULT NULL,
  p_motivo_categoria      text DEFAULT NULL,
  p_idempotency_key       text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
  v_mov_id              uuid;
  v_saldo_anterior      numeric;
  v_saldo_posterior     numeric;
  v_reservado_anterior  numeric;
  v_reservado_posterior numeric;
  v_custo_medio_atual   numeric;
  v_custo_medio_novo    numeric;
  v_saldo_global        numeric;
  v_recalcula_custo     boolean;
BEGIN
  -- Curto-circuito idempotente: se a key já existe, devolve a mov existente
  -- sem mexer no saldo/custo (recusa repetição mesmo horas depois).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_mov_id FROM siso_movimentacoes
      WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_mov_id; END IF;
  END IF;

  IF p_tipo NOT IN ('E','S','R','L') THEN RAISE EXCEPTION 'tipo inválido: %', p_tipo; END IF;
  IF p_tipo = 'R' AND p_expira_em IS NULL THEN RAISE EXCEPTION 'reserva (tipo R) exige expira_em'; END IF;
  IF p_tipo <> 'R' AND p_expira_em IS NOT NULL THEN RAISE EXCEPTION 'expira_em só é válido pra tipo R'; END IF;

  SELECT saldo, reservado INTO v_saldo_anterior, v_reservado_anterior
    FROM siso_estoque
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_saldo_anterior := 0;
    v_reservado_anterior := 0;
    INSERT INTO siso_estoque (produto_id, galpao_id, localizacao_id, saldo, reservado)
    VALUES (p_produto_id, p_galpao_id, p_localizacao_id, 0, 0);
  END IF;

  v_saldo_posterior := v_saldo_anterior;
  v_reservado_posterior := v_reservado_anterior;
  IF p_tipo = 'E' THEN
    v_saldo_posterior := v_saldo_anterior + p_quantidade;
  ELSIF p_tipo = 'S' THEN
    v_saldo_posterior := v_saldo_anterior - p_quantidade;
    IF v_saldo_posterior < 0 THEN RAISE EXCEPTION 'saldo insuficiente: % - % < 0', v_saldo_anterior, p_quantidade; END IF;
  ELSIF p_tipo = 'R' THEN
    v_reservado_posterior := v_reservado_anterior + p_quantidade;
    IF v_reservado_posterior > v_saldo_anterior THEN RAISE EXCEPTION 'reserva excede saldo: % + % > %', v_reservado_anterior, p_quantidade, v_saldo_anterior; END IF;
  ELSIF p_tipo = 'L' THEN
    v_reservado_posterior := v_reservado_anterior - p_quantidade;
    IF v_reservado_posterior < 0 THEN RAISE EXCEPTION 'liberação excede reservado: % - % < 0', v_reservado_anterior, p_quantidade; END IF;
  END IF;

  -- WHITELIST idêntica à de 20260527 (inclui ajuste_manual + inventario_inicial;
  -- reduzir a lista silenciaria o custo médio dessas origens).
  v_recalcula_custo := (p_tipo = 'E' AND p_custo_unitario IS NOT NULL
                        AND p_origem_tipo IN (
                          'nf_compra',
                          'devolucao_cliente_integra',
                          'lancamento_retroativo',
                          'ajuste_manual',
                          'inventario_inicial'
                        ));

  SELECT COALESCE(custo_medio, 0) INTO v_custo_medio_atual
    FROM siso_custo_medio WHERE produto_id=p_produto_id FOR UPDATE;
  IF NOT FOUND THEN v_custo_medio_atual := 0; END IF;
  v_custo_medio_novo := v_custo_medio_atual;

  IF v_recalcula_custo THEN
    SELECT COALESCE(SUM(saldo),0) INTO v_saldo_global FROM siso_estoque WHERE produto_id=p_produto_id;
    IF v_saldo_global + p_quantidade > 0 THEN
      v_custo_medio_novo := (v_saldo_global * v_custo_medio_atual + p_quantidade * p_custo_unitario) / (v_saldo_global + p_quantidade);
    ELSE
      v_custo_medio_novo := p_custo_unitario;
    END IF;
  END IF;

  INSERT INTO siso_movimentacoes (
    produto_id, galpao_id, localizacao_id,
    tipo, quantidade,
    saldo_anterior, saldo_posterior,
    reservado_anterior, reservado_posterior,
    origem_tipo, origem_id, origem_detalhes,
    usuario_id, expira_em, estorno_de,
    empresa_compradora_id, empresa_vendedora_id, empresa_referencia_id,
    fornecedor_id, motivo, cliente_nome,
    pedido_id, nota_fiscal_id, chave_acesso_nf,
    custo_unitario, custo_medio_anterior, custo_medio_posterior,
    motivo_categoria, idempotency_key
  ) VALUES (
    p_produto_id, p_galpao_id, p_localizacao_id,
    p_tipo, p_quantidade,
    v_saldo_anterior, v_saldo_posterior,
    v_reservado_anterior, v_reservado_posterior,
    p_origem_tipo, p_origem_id, p_origem_detalhes,
    p_usuario_id, p_expira_em, p_estorno_de,
    p_empresa_compradora_id, p_empresa_vendedora_id, p_empresa_referencia_id,
    p_fornecedor_id, p_motivo, p_cliente_nome,
    p_pedido_id, p_nota_fiscal_id, p_chave_acesso_nf,
    p_custo_unitario, v_custo_medio_atual, v_custo_medio_novo,
    p_motivo_categoria::wms_motivo_categoria_enum, p_idempotency_key
  ) RETURNING id INTO v_mov_id;

  UPDATE siso_estoque
     SET saldo = v_saldo_posterior, reservado = v_reservado_posterior, atualizado_em = now()
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id;

  IF v_recalcula_custo THEN
    INSERT INTO siso_custo_medio (produto_id, custo_medio, ultima_movimentacao_id, atualizado_em)
    VALUES (p_produto_id, v_custo_medio_novo, v_mov_id, now())
    ON CONFLICT (produto_id) DO UPDATE
      SET custo_medio = EXCLUDED.custo_medio,
          ultima_movimentacao_id = EXCLUDED.ultima_movimentacao_id,
          atualizado_em = EXCLUDED.atualizado_em;
  END IF;

  RETURN v_mov_id;
END;
$function$;

COMMIT;
```
  Criar o scenario `scripts/wms/cenarios/catalogo/86-retroativo-idempotente.ts`:
```ts
import type { Cenario, Ctx } from "../_harness/types";

type Setup = { sku: string; produtoId: string; galpaoId: string; locId: string; key: string };

export default {
  nome: "86 — Lançamento retroativo é idempotente (mesma key → +100, não +200)",
  descricao:
    "Dois POSTs /lancamento-retroativo com a MESMA idempotency_key (qty 100) " +
    "resultam em UMA mov E e saldo +100; o 2º não cria segunda mov.",
  tags: ["retroativo", "idempotencia", "ledger"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("86");
    const produtoId = await ctx.criarProduto({ sku, descricao: "Retroativo idem 86" });
    const { data: g } = await ctx.sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const galpaoId = (g as { id: string }).id;
    const locId = await ctx.criarLocalizacao({ galpao: "CWB", codigo: `RETRO-86-${Date.now()}` });
    const key = crypto.randomUUID();
    return { sku, produtoId, galpaoId, locId, key };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const body = {
      tripla: { produto_id: setup.produtoId, galpao_id: setup.galpaoId, localizacao_id: setup.locId },
      qty: 100,
      motivo: "lançamento retroativo idempotente",
      idempotency_key: setup.key,
    };
    const r1 = await ctx.http.post("/api/wms/lancamento-retroativo", body);
    if (r1.status !== 200) throw new Error(`1º lançamento esperado 200, veio ${r1.status}`);
    const r2 = await ctx.http.post("/api/wms/lancamento-retroativo", body);
    if (r2.status !== 200) throw new Error(`2º lançamento (mesma key) esperado 200, veio ${r2.status}`);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: est } = await ctx.sb
      .from("siso_estoque").select("saldo")
      .eq("produto_id", setup.produtoId).eq("galpao_id", setup.galpaoId)
      .eq("localizacao_id", setup.locId).single();
    if (Number((est as { saldo: number }).saldo) !== 100) {
      throw new Error(`Saldo esperado 100 (idempotente), veio ${(est as { saldo: number }).saldo}`);
    }
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes").select("id")
      .eq("idempotency_key", setup.key);
    if ((movs ?? []).length !== 1) {
      throw new Error(`Esperado 1 mov com a key, achei ${(movs ?? []).length}`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })();
}
```
- [ ] **Step 2 — RODAR e ver falhar:** `npm run scenarios:only -- 86`
  Expected: FAIL — sem a migration aplicada nem o wiring TS, o 2º POST cria uma segunda mov e o saldo vira 200 (`Saldo esperado 100 (idempotente), veio 200`).
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:**
  1. Aplicar a migration via `mcp__supabase__apply_migration` (project `ehbxpbeijofxtsbezwxd`, name `20260605_retroativo_idempotency`, conteúdo do arquivo acima).
     **Verificar após aplicar** (via `mcp__supabase__execute_sql`) que existe EXATAMENTE 1 overload — o DROP do de 22 args evita ambiguidade:
     `SELECT pronargs FROM pg_proc WHERE proname='wms_inserir_movimentacao';` → deve retornar **uma única linha** com `pronargs = 23`. Se vier 2 linhas (22 e 23), o DROP FUNCTION não casou a assinatura — conferir a lista de tipos contra 20260527 e reaplicar.
  2. Em `src/lib/wms/ledger.ts`, adicionar o campo ao `InserirMovInput` (após `devolucao_id`, ~linha 104):
```ts
  /** Chave de idempotência durável (P146). Colisão 23505 → curto-circuito na RPC. */
  idempotency_key?: string | null;
```
  E adicionar SÓ o novo param na chamada `.rpc("wms_inserir_movimentacao", {...})`.
  A linha `p_motivo_categoria: input.motivo_categoria ?? null,` JÁ EXISTE (ledger.ts:201) —
  não duplicar; inserir `p_idempotency_key` logo abaixo dela:
```ts
    p_motivo_categoria: input.motivo_categoria ?? null,  // já existe — referência de âncora
    p_idempotency_key: input.idempotency_key ?? null,    // ADICIONAR esta linha
```
  3. Em `src/lib/wms/movimentacoes.ts`, adicionar `idempotency_key?: string` ao `LancamentoRetroativoInput` (perto de `data_recebimento?: string;`, ~linha 512) e repassar em `lancarRetroativo` (no objeto passado a `inserirMovimentacao`, ~linha 539):
```ts
    motivo: input.motivo.trim(),
    usuario_id: input.usuario_id,
    idempotency_key: input.idempotency_key ?? null,
```
  4. Em `src/app/api/wms/lancamento-retroativo/route.ts`, ler `body.idempotency_key` e repassar (dentro do `await lancarRetroativo({...})`, ~linha 89):
```ts
      data_recebimento: dataRecebimento,
      usuario_id: auth.user.id,
      idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : undefined,
```
- [ ] **Step 4 — RODAR e ver passar:** `npm run scenarios:only -- 86`
  Expected: PASS (saldo 100, 1 mov com a key).
- [ ] **Step 5 — COMMIT:** `git add supabase/migrations/20260605_retroativo_idempotency.sql src/lib/wms/ledger.ts src/lib/wms/movimentacoes.ts src/app/api/wms/lancamento-retroativo/route.ts scripts/wms/cenarios/catalogo/86-retroativo-idempotente.ts && git commit -m "fix(wms): idempotency_key durável no lançamento retroativo (coluna+índice+RPC) [P146]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: retroativo-sem-idempotency
    date: "2026-06-05"
    source: wms/lancamento-retroativo
    category: business_logic
    message: "Lançamento retroativo não tinha idempotency: duplo clique (rede lenta) criava 2 movs E, inflava saldo e recalculava custo médio errado."
    cause: >
      A rota e wms_inserir_movimentacao não aceitavam idempotency_key; nenhuma defesa
      contra repetição (mesmo horas depois).
    fix: >
      Coluna idempotency_key + UNIQUE PARTIAL INDEX em siso_movimentacoes; DROP do overload
      de 22 args + CREATE de 23 args PRESERVANDO p_motivo_categoria (#21) e adicionando
      p_idempotency_key (#22) com curto-circuito (devolve mov existente); lancarRetroativo
      e a rota propagam a key.
    files:
      - supabase/migrations/20260605_retroativo_idempotency.sql
      - src/lib/wms/ledger.ts
      - src/lib/wms/movimentacoes.ts
      - src/app/api/wms/lancamento-retroativo/route.ts
      - scripts/wms/cenarios/catalogo/86-retroativo-idempotente.ts
    tags: [retroativo, idempotency, ledger, custo-medio]
```

### Task 1.4: Botão de retry do ErrorBanner disabled durante refetch [P185]

**Files:**
- Modify: `src/components/ui/error-banner.tsx:3-27` (prop opcional `retrying`/`disabled`); `src/app/wms/dashboard/page.tsx:59-72` (passar `isFetching`)
- Test: `src/components/ui/error-banner.test.tsx`

Nota op1: desabilitar o botão enquanto carrega. `ErrorBanner` é genérico (vários consumidores) — adicionar prop opcional retrocompatível (default `false`).

- [ ] **Step 1 — RED:** criar `src/components/ui/error-banner.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ErrorBanner } from "./error-banner";

describe("ErrorBanner — retrying disabled", () => {
  it("desabilita o botão de retry quando retrying=true", () => {
    const { getByRole } = render(
      <ErrorBanner message="boom" onRetry={() => {}} retrying />,
    );
    expect((getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("mantém o botão habilitado por default (retrocompat)", () => {
    const { getByRole } = render(<ErrorBanner message="boom" onRetry={() => {}} />);
    expect((getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });
});
```
  > Nota: confirmar que `@testing-library/react` está nas devDependencies (outros `*.test.tsx` no repo usam render). Se ausente, substituir por checagem de `renderToStaticMarkup` contendo `disabled`.
- [ ] **Step 2 — RODAR e ver falhar:** `npm test -- src/components/ui/error-banner.test.tsx`
  Expected: FAIL — o componente não aceita `retrying` e o botão nunca fica `disabled`.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** em `src/components/ui/error-banner.tsx`:
```tsx
import { AlertTriangle } from "lucide-react";

interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
  /** Desabilita o botão enquanto um refetch está em voo (P185). */
  retrying?: boolean;
}

export function ErrorBanner({ message, onRetry, retrying = false }: ErrorBannerProps) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="flex-1 text-sm text-danger">
        <p className="font-medium">Não foi possível carregar.</p>
        <p className="mt-0.5 text-xs opacity-80">{message}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="text-xs font-semibold text-danger underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          {retrying ? "Recarregando…" : "Tentar de novo"}
        </button>
      )}
    </div>
  );
}
```
  Em `src/app/wms/dashboard/page.tsx`, extrair `isFetching` do useQuery (linha 59) e passar à banner (linha 67-71):
```tsx
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["wms-dashboard"],
    queryFn: () => wmsApi<DashboardGeralResult>("/api/wms/dashboard-geral"),
    refetchInterval: 30000,
  });

  if (isLoading) return <LoadingSpinner />;
  if (isError) {
    return (
      <ErrorBanner
        message={(error as Error).message}
        onRetry={() => refetch()}
        retrying={isFetching}
      />
    );
  }
```
- [ ] **Step 4 — RODAR e ver passar:** `npm test -- src/components/ui/error-banner.test.tsx`
  Expected: PASS (2 testes).
- [ ] **Step 5 — COMMIT:** `git add src/components/ui/error-banner.tsx src/components/ui/error-banner.test.tsx src/app/wms/dashboard/page.tsx && git commit -m "fix(wms): ErrorBanner desabilita retry durante refetch (dashboard) [P185]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: dashboard-retry-sem-disabled
    date: "2026-06-05"
    source: wms/dashboard
    category: business_logic
    message: "Botão 'Tentar de novo' do dashboard não desabilitava durante o refetch, permitindo N consultas consecutivas ao banco."
    cause: ErrorBanner não recebia o estado in-flight (isFetching).
    fix: >
      Prop opcional retrying no ErrorBanner (default false, retrocompat) que aplica
      disabled; dashboard passa isFetching.
    files:
      - src/components/ui/error-banner.tsx
      - src/app/wms/dashboard/page.tsx
    tags: [dashboard, ux, duplo-clique, error-banner]
```

### Task 1.5: Botões Conectar/Re-autorizar ML disabled durante conexão [P168]

**Files:**
- Modify: `src/app/wms/configuracoes/conexoes/page.tsx:1971-2004` (Conectar: estado `connecting` + `disabled`), `:2092-2163` (Re-autorizar: idem)
- Test: manual_only (componente depende de `window.location.href`)

Nota op1: desabilitar o botão durante a conexão (não multi-state no backend). `window.location.href` causa navegação full-page; o disable bloqueia o 2º clique na janela entre clique e navegação.

- [ ] **Step 1 — RED (manual):** documentar o caso comportamental — após o 1º clique em "Conectar conta ML", o botão deve ficar `disabled` antes da navegação, impedindo um 2º clique que geraria outro `state` OAuth → `state_mismatch`. Não há harness automatizado (depende de navegação real).
- [ ] **Step 2 — verificar estado atual:** inspeção visual — hoje o botão fica habilitado durante a janela de navegação (RED comportamental).
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:**
  Em `MlConnectionsSection`, adicionar estado e travar em `connect`. Importar `useState` se ainda não estiver no escopo (o arquivo já usa hooks). Substituir a função `connect` (linhas 1971-1977) e o componente para incluir o estado:
```tsx
function MlConnectionsSection({
  connections,
  loading,
  appConfigured,
  onChanged,
}: {
  connections: MlConnection[];
  loading: boolean;
  appConfigured: boolean;
  onChanged: () => void;
}) {
  const [connecting, setConnecting] = useState(false);

  function connect() {
    if (!appConfigured) {
      toast.error("Configure o App ML antes de conectar uma conta");
      return;
    }
    setConnecting(true);
    window.location.href = "/api/wms/ml/oauth";
  }
```
  E no botão (linhas 1992-2004), aplicar `disabled` e label dinâmico:
```tsx
        <button
          type="button"
          className="wms-btn wms-btn-primary wms-btn-sm"
          onClick={connect}
          disabled={!appConfigured || connecting}
          style={{ marginLeft: "auto" }}
          title={
            !appConfigured ? "Configure o App ML primeiro" : "Autorizar nova conta"
          }
        >
          <Icon name="plus" size={11} />
          {connecting ? "Conectando…" : "Conectar conta ML"}
        </button>
```
  Em `MlConnectionRow`, adicionar estado e travar em `reauthorize` (substituir a função na linha 2092-2094):
```tsx
  const [reauth, setReauth] = useState(false);

  function reauthorize() {
    setReauth(true);
    window.location.href = "/api/wms/ml/oauth";
  }
```
  E no botão Re-autorizar (linhas 2156-2163):
```tsx
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={reauthorize}
          disabled={reauth}
        >
          <Icon name="arrow-right" size={11} />
          {reauth ? "Redirecionando…" : "Re-autorizar"}
        </button>
```
- [ ] **Step 4 — verificar:** `npm run lint` + `npm run build` (typecheck). Verificação comportamental manual: clicar Conectar → botão fica cinza antes da navegação.
- [ ] **Step 5 — COMMIT:** `git add src/app/wms/configuracoes/conexoes/page.tsx && git commit -m "fix(wms): botões Conectar/Re-autorizar ML disabled durante conexão (evita state_mismatch) [P168]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: ml-conectar-sem-disabled-state-mismatch
    date: "2026-06-05"
    source: wms/configuracoes/conexoes
    category: external_api
    message: "Duplo clique em 'Conectar/Re-autorizar ML' gerava 2 states OAuth (Y sobrescreve X); o callback voltava com X mas o cookie tinha Y → state_mismatch."
    cause: Botão não desabilitava durante a janela entre clique e navegação full-page.
    fix: >
      Estado local connecting/reauth + disabled no botão (fix 100% frontend; backend
      intocado). Opção 1 da nota (não multi-state).
    files:
      - src/app/wms/configuracoes/conexoes/page.tsx
    tags: [ml, oauth, ux, duplo-clique, state-mismatch]
```

### Task 1.6: Surfacing do body de erro na remoção de veículo [P163]

**Files:**
- Modify: `src/app/wms/cross/[sku]/page.tsx:186-201` (ler JSON de erro no `removeVeicMut`); `src/app/api/wms/cross/produtos/[sku]/veiculos/[id]/route.ts:37` (mensagem alinhada à nota)
- Test: `src/app/wms/cross/__tests__/remover-veiculo-msg.test.ts`

Nota op1: erro claro "Esse veículo já foi removido" no 2º clique. O backend já retorna 404 + mensagem; falta o frontend ler `r.json().error` em vez de exibir `HTTP 404`.

- [ ] **Step 1 — RED:** criar `src/app/wms/cross/__tests__/remover-veiculo-msg.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { extractRemoveVeicError } from "../[sku]/page";

describe("extractRemoveVeicError", () => {
  it("usa a mensagem do body quando presente", async () => {
    const res = {
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({ error: "Esse veículo já foi removido" }),
    } as unknown as Response;
    await expect(extractRemoveVeicError(res)).resolves.toBe("Esse veículo já foi removido");
  });

  it("cai pra HTTP <status> quando o body não tem error", async () => {
    const res = {
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({}),
    } as unknown as Response;
    await expect(extractRemoveVeicError(res)).resolves.toBe("HTTP 500");
  });
});
```
- [ ] **Step 2 — RODAR e ver falhar:** `npm test -- src/app/wms/cross/__tests__/remover-veiculo-msg.test.ts`
  Expected: FAIL com `extractRemoveVeicError is not a function` / export ausente.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** em `src/app/wms/cross/[sku]/page.tsx`, exportar o helper e usá-lo no `removeVeicMut` (substituir o `mutationFn` das linhas 187-193):
```tsx
export async function extractRemoveVeicError(r: Response): Promise<string> {
  const json = (await r.json().catch(() => ({}))) as { error?: string };
  return json.error ?? `HTTP ${r.status}`;
}
```
```tsx
  const removeVeicMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await sisoFetch(
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/veiculos/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error(await extractRemoveVeicError(r));
    },
```
  Em `src/app/api/wms/cross/produtos/[sku]/veiculos/[id]/route.ts:37`, alinhar a mensagem à nota:
```ts
  if (!veiculo || veiculo.produto_sku !== sku) {
    return NextResponse.json({ error: "Esse veículo já foi removido" }, { status: 404 });
  }
```
- [ ] **Step 4 — RODAR e ver passar:** `npm test -- src/app/wms/cross/__tests__/remover-veiculo-msg.test.ts`
  Expected: PASS.
- [ ] **Step 5 — COMMIT:** `git add src/app/wms/cross/[sku]/page.tsx src/app/api/wms/cross/produtos/[sku]/veiculos/[id]/route.ts src/app/wms/cross/__tests__/remover-veiculo-msg.test.ts && git commit -m "fix(wms): surfacing do body de erro ao remover veículo ('Esse veículo já foi removido') [P163]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: cross-remover-veiculo-erro-cru
    date: "2026-06-05"
    source: wms/cross
    category: business_logic
    message: "2º clique em remover veículo mostrava 'HTTP 404' em vez da mensagem do body ('Esse veículo já foi removido')."
    cause: A mutation lançava `HTTP ${r.status}` sem ler o JSON de erro.
    fix: helper extractRemoveVeicError lê r.json().error; backend alinha a mensagem.
    files:
      - src/app/wms/cross/[sku]/page.tsx
      - src/app/api/wms/cross/produtos/[sku]/veiculos/[id]/route.ts
    tags: [cross, ux, surfacing-erro, 404]
```

### Task 1.7: Form de operador exige ≥1 galpão (criar + editar) [P134, P137]

**Files:**
- Create: `src/components/wms/configuracoes/calc-disabled.ts` (helper puro compartilhado)
- Modify: `src/components/wms/configuracoes/aba-funcionarios.tsx:604-608` (criar), `:990` (salvar)
- Test: `src/components/wms/configuracoes/aba-funcionarios.test.ts`

Nota P134 op2 (exigir ≥1 galpão ao criar; botão Criar só ativa com loja); P137 op2 (form de edição já carrega lojas atuais — JÁ FEITO; falta bloquear salvar vazio). Helper puro compartilhado entre criar e editar (conflito resolvido no mestre: `calcDisabled`).

- [ ] **Step 1 — RED:** criar `src/components/wms/configuracoes/aba-funcionarios.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { calcGalpaoBloqueado } from "./calc-disabled";

describe("calcGalpaoBloqueado", () => {
  it("bloqueia quando precisaGalpao=true e nenhum galpão marcado", () => {
    expect(calcGalpaoBloqueado({ precisaGalpao: true, galpaoIds: [] })).toBe(true);
  });
  it("libera quando precisaGalpao=true e ≥1 galpão marcado", () => {
    expect(calcGalpaoBloqueado({ precisaGalpao: true, galpaoIds: ["g1"] })).toBe(false);
  });
  it("não bloqueia quando precisaGalpao=false (role não-operador)", () => {
    expect(calcGalpaoBloqueado({ precisaGalpao: false, galpaoIds: [] })).toBe(false);
  });
});
```
- [ ] **Step 2 — RODAR e ver falhar:** `npm test -- src/components/wms/configuracoes/aba-funcionarios.test.ts`
  Expected: FAIL — módulo `./calc-disabled` inexistente.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** criar `src/components/wms/configuracoes/calc-disabled.ts`:
```ts
/**
 * P134/P137: roles operador* exigem ≥1 galpão. Helper puro compartilhado
 * entre o form de criação e o de edição de funcionário.
 */
export function calcGalpaoBloqueado(args: {
  precisaGalpao: boolean;
  galpaoIds: string[];
}): boolean {
  return args.precisaGalpao && args.galpaoIds.length === 0;
}
```
  Em `aba-funcionarios.tsx`, importar o helper (junto aos imports do topo do arquivo):
```tsx
import { calcGalpaoBloqueado } from "./calc-disabled";
```
  No form de **criação**, estender `desabilitado` (linhas 604-608):
```tsx
  const desabilitado =
    !nome.trim() ||
    pin.length !== 4 ||
    roleIds.length === 0 ||
    calcGalpaoBloqueado({ precisaGalpao, galpaoIds }) ||
    criar.isPending;
```
  No form de **edição**, estender o `disabled` do botão Salvar (linha 990):
```tsx
            disabled={
              salvar.isPending ||
              calcGalpaoBloqueado({ precisaGalpao, galpaoIds: form.galpaoIds })
            }
```
- [ ] **Step 4 — RODAR e ver passar:** `npm test -- src/components/wms/configuracoes/aba-funcionarios.test.ts`
  Expected: PASS (3 testes).
- [ ] **Step 5 — COMMIT:** `git add src/components/wms/configuracoes/calc-disabled.ts src/components/wms/configuracoes/aba-funcionarios.tsx src/components/wms/configuracoes/aba-funcionarios.test.ts && git commit -m "fix(wms): form de operador exige ≥1 galpão (criar+editar via calcGalpaoBloqueado) [P134,P137]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: operador-sem-galpao-criar-editar
    date: "2026-06-05"
    source: wms/configuracoes/funcionarios
    category: business_logic
    message: "Era possível criar/salvar operador sem galpão; o funcionário logava mas não conseguia trabalhar."
    cause: O disabled dos botões Criar/Salvar não considerava a regra precisaGalpao && galpaoIds vazio.
    fix: helper puro calcGalpaoBloqueado aplicado ao disabled de criar e editar.
    files:
      - src/components/wms/configuracoes/calc-disabled.ts
      - src/components/wms/configuracoes/aba-funcionarios.tsx
    tags: [funcionarios, galpao, validacao, frontend]
```

### Task 1.8: Vendedor inativo fora do dropdown de reatribuição [P076]

**Files:**
- Modify: `src/app/wms/vendas/[id]/page.tsx:52-56` (interface `UsuarioOpt` ganha `ativo`), `:378-386` (corrigir leitura array puro + filtro `ativo`)
- Test: `src/app/wms/vendas/[id]/page.test.ts`

Nota op2: vendedor inativo nem aparece no dropdown (decisão frontend). Bug colateral: a query lê `j.usuarios` (undefined) — a rota `/api/wms/admin/usuarios` retorna ARRAY puro; o dropdown provavelmente está vazio hoje. O fix corrige isso e adiciona o filtro `ativo`.

> **Ancoragem verificada (`/api/wms/admin/usuarios` GET, `route.ts:20-50`):** a rota faz `.select("id, nome, cargo, cargos, ativo, ...")` e retorna `NextResponse.json(normalized)` onde cada item é `{ ...u, cargos: u.cargos?.length ? u.cargos : [u.cargo], galpoes: [...] }`. Ou seja: o payload É um array puro e cada usuário JÁ traz `ativo` (boolean) e `cargos` (sempre populado, fallback `[u.cargo]`). Logo `filtrarVendedoresAtivos` pode confiar em `u.ativo && u.cargos?.includes("vendedor")` sem mudar a rota admin.

- [ ] **Step 1 — RED:** criar `src/app/wms/vendas/[id]/page.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { filtrarVendedoresAtivos, type UsuarioOpt } from "./page";

describe("filtrarVendedoresAtivos", () => {
  const lista: UsuarioOpt[] = [
    { id: "1", nome: "Carlos", ativo: false, cargos: ["vendedor"] },
    { id: "2", nome: "Ana", ativo: true, cargos: ["vendedor"] },
    { id: "3", nome: "Bob", ativo: true, cargos: ["operador"] },
  ];
  it("retorna só vendedores ativos", () => {
    const r = filtrarVendedoresAtivos(lista);
    expect(r.map((u) => u.nome)).toEqual(["Ana"]);
  });
  it("tolera entrada nula/vazia", () => {
    expect(filtrarVendedoresAtivos(undefined)).toEqual([]);
  });
});
```
- [ ] **Step 2 — RODAR e ver falhar:** `npm test -- src/app/wms/vendas/[id]/page.test.ts`
  Expected: FAIL — export `filtrarVendedoresAtivos`/`UsuarioOpt` ausente.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** em `src/app/wms/vendas/[id]/page.tsx`, estender a interface (linhas 52-56) e exportá-la + o helper:
```tsx
export interface UsuarioOpt {
  id: string;
  nome: string;
  ativo: boolean;
  cargos: string[];
}

export function filtrarVendedoresAtivos(arr: UsuarioOpt[] | undefined): UsuarioOpt[] {
  return (arr ?? []).filter((u) => u.ativo && u.cargos?.includes("vendedor"));
}
```
  Corrigir a query (linhas 378-386):
```tsx
  const { data: vendedores } = useQuery<UsuarioOpt[]>({
    queryKey: ["reassign-vendedores"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/admin/usuarios");
      if (!r.ok) return [];
      const arr = (await r.json()) as UsuarioOpt[];
      return filtrarVendedoresAtivos(arr);
    },
  });
```
- [ ] **Step 4 — RODAR e ver passar:** `npm test -- src/app/wms/vendas/[id]/page.test.ts`
  Expected: PASS (2 testes).
- [ ] **Step 5 — COMMIT:** `git add src/app/wms/vendas/[id]/page.tsx src/app/wms/vendas/[id]/page.test.ts && git commit -m "fix(wms): vendedor inativo fora do dropdown de reatribuição + corrige leitura array puro [P076]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: reatribuir-vendedor-inativo-e-leitura-quebrada
    date: "2026-06-05"
    source: wms/vendas/detalhe
    category: business_logic
    message: "Dropdown de reatribuição lia j.usuarios (undefined; rota retorna array puro) e não filtrava ativo — vendedor que saiu da empresa aparecia."
    cause: Query lia chave inexistente; UsuarioOpt não tinha ativo; sem filtro de ativo.
    fix: helper filtrarVendedoresAtivos sobre o array puro, filtrando ativo && cargo vendedor.
    files:
      - src/app/wms/vendas/[id]/page.tsx
    tags: [vendas, reatribuicao, vendedor-inativo, frontend]
```

---

## PR 2: Visibilidade [P161, P180, P175, P122, P132, P182] [MIGRATION/RPC]

Reabrir + realtime de divergências de inventário; auditoria de edição de produto + bloqueio de campos auto-sincronizados; contagem de kit no histórico (auditoria honesta); insight de operador inativo sem quebrar; limpeza de operador no estorno de embalagem.

### Task 2.1: Reabrir divergência de inventário sem admin [P161]

**Files:**
- Modify: `src/app/api/wms/inventario/[id]/divergencias/route.ts:60-99` (aceitar `acao='reabrir'` com guard de sessão-aplicada); `src/app/wms/inventario/[id]/divergencias/page.tsx:139-170` (mutation aceita reabrir), `:367-409` (botão Reabrir em linhas aprovada/rejeitada)
- Test: `scripts/wms/cenarios/catalogo/87-divergencia-reabrir.ts`

Nota: permitir Reabrir e refazer a decisão sem admin. Guard crítico: só permitir reabrir enquanto a sessão **não** está `aplicada` (aplicar gera movs no ledger; reabrir depois descasaria o saldo).

- [ ] **Step 1 — RED:** criar `scripts/wms/cenarios/catalogo/87-divergencia-reabrir.ts`. Como criar uma sessão de inventário completa via HTTP é trabalhoso, este scenario monta o estado mínimo no banco via `ctx.sb` e exercita só o PATCH da rota.
```ts
import type { Cenario, Ctx } from "../_harness/types";

type Setup = { sessaoId: string; divId: string; produtoId: string; galpaoId: string; locId: string };

export default {
  nome: "87 — Reabrir divergência aprovada volta a pendente (bloqueia se sessão aplicada)",
  descricao:
    "Aprovar uma divergência, PATCH acao='reabrir' volta status pra 'pendente' " +
    "limpando resolucao_por/em; reabrir é bloqueado (409) se a sessão está 'aplicada'.",
  tags: ["inventario", "divergencia", "reabrir"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("87");
    const produtoId = await ctx.criarProduto({ sku, descricao: "Reabrir div 87" });
    const { data: g } = await ctx.sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const galpaoId = (g as { id: string }).id;
    const locId = await ctx.criarLocalizacao({ galpao: "CWB", codigo: `DIV-87-${Date.now()}` });
    // sessão em status 'revisao' (não aplicada)
    const { data: ses } = await ctx.sb
      .from("siso_inventario_sessoes")
      .insert({ galpao_id: galpaoId, status: "revisao", tipo: "ciclica", criado_por: ctx.staging.usuarios.admin.id })
      .select("id").single();
    const sessaoId = (ses as { id: string }).id;
    const { data: div } = await ctx.sb
      .from("siso_inventario_divergencias")
      .insert({
        sessao_id: sessaoId, produto_id: produtoId, localizacao_id: locId,
        qty_sistema: 10, qty_contada_final: 7, delta: -3, status: "pendente",
      })
      .select("id").single();
    return { sessaoId, divId: (div as { id: string }).id, produtoId, galpaoId, locId };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // aprovar
    await ctx.http.patch(`/api/wms/inventario/${setup.sessaoId}/divergencias`, {
      divergencia_ids: [setup.divId], acao: "aprovar",
    });
    // reabrir
    const rOpen = await ctx.http.patch(`/api/wms/inventario/${setup.sessaoId}/divergencias`, {
      divergencia_ids: [setup.divId], acao: "reabrir",
    });
    (setup as any).__reabrirStatus = rOpen.status;
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    if ((setup as any).__reabrirStatus !== 200) {
      throw new Error(`Reabrir esperado 200, veio ${(setup as any).__reabrirStatus}`);
    }
    const { data: div } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("status, resolucao_por, resolucao_em").eq("id", setup.divId).single();
    const d = div as { status: string; resolucao_por: string | null; resolucao_em: string | null };
    if (d.status !== "pendente") throw new Error(`Esperado status pendente, veio ${d.status}`);
    if (d.resolucao_por !== null || d.resolucao_em !== null) {
      throw new Error("Reabrir deveria limpar resolucao_por/resolucao_em");
    }
    // Guard: sessão aplicada bloqueia reabrir
    await ctx.sb.from("siso_inventario_sessoes").update({ status: "aplicada", aplicada_em: new Date().toISOString() }).eq("id", setup.sessaoId);
    await ctx.http.patch(`/api/wms/inventario/${setup.sessaoId}/divergencias`, {
      divergencia_ids: [setup.divId], acao: "aprovar",
    });
    const rBlock = await ctx.http.patch(`/api/wms/inventario/${setup.sessaoId}/divergencias`, {
      divergencia_ids: [setup.divId], acao: "reabrir",
    });
    if (rBlock.status !== 409) {
      throw new Error(`Reabrir com sessão aplicada deveria ser 409, veio ${rBlock.status}`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })();
}
```
  > Nota: confirmar (a) colunas obrigatórias de `siso_inventario_sessoes` (`tipo`, `criado_por`) e de `siso_inventario_divergencias` (`qty_sistema`, `qty_contada_final`, `delta`) no schema antes de rodar — ajustar os inserts se divergir; (b) que `ctx.http` expõe `.patch` (senão usar `ctx.http.request('PATCH', ...)` conforme o harness); (c) `ctx.staging.usuarios.admin.id` existe nas fixtures.
- [ ] **Step 2 — RODAR e ver falhar:** `npm run scenarios:only -- 87`
  Expected: FAIL — `acao='reabrir'` cai em "acao inválida" (400), então o PATCH não volta a pendente.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** no PATCH de `divergencias/route.ts`, tratar `reabrir` separadamente. Substituir o bloco de `novoStatus` + UPDATE (linhas 60-99) por:
```ts
  const sb = createServiceClient();

  // P161: Reabrir volta a divergência pra 'pendente' — só se a sessão NÃO
  // foi aplicada no ledger (senão descasaria o saldo já lançado).
  if (body.acao === "reabrir") {
    const { data: ses } = await sb
      .from("siso_inventario_sessoes")
      .select("status")
      .eq("id", sessaoId)
      .maybeSingle();
    if ((ses as { status?: string } | null)?.status === "aplicada") {
      return NextResponse.json(
        { error: "Sessão já aplicada no ledger — não dá pra reabrir divergência" },
        { status: 409 },
      );
    }
    const { data, error } = await sb
      .from("siso_inventario_divergencias")
      .update({
        status: "pendente",
        resolucao_por: null,
        resolucao_em: null,
        observacoes_resolucao: null,
      })
      .in("id", ids)
      .eq("sessao_id", sessaoId)
      .in("status", ["aprovada", "rejeitada"])
      .select("id");
    if (error) {
      return wmsErrorResponse({
        source: "wms.inventario.divergencias",
        error,
        requestPath: `/api/wms/inventario/${sessaoId}/divergencias`,
        requestMethod: "PATCH",
        metadata: { sessao_id: sessaoId, acao: "reabrir", ids_count: ids.length },
      });
    }
    return NextResponse.json({ ok: true, atualizadas: data?.length ?? 0 });
  }

  const novoStatus =
    body.acao === "aprovar"
      ? "aprovada"
      : body.acao === "rejeitar"
        ? "rejeitada"
        : null;
  if (!novoStatus) {
    return NextResponse.json(
      { error: "acao inválida (use 'aprovar', 'rejeitar' ou 'reabrir')" },
      { status: 400 },
    );
  }

  const { data, error } = await sb
    .from("siso_inventario_divergencias")
    .update({
      status: novoStatus,
      resolucao_por: auth.user.id,
      resolucao_em: new Date().toISOString(),
      observacoes_resolucao: body.observacoes ?? null,
    })
    .in("id", ids)
    .eq("sessao_id", sessaoId)
    .eq("status", "pendente")
    .select("id");

  if (error) {
    return wmsErrorResponse({
      source: "wms.inventario.divergencias",
      error,
      requestPath: `/api/wms/inventario/${sessaoId}/divergencias`,
      requestMethod: "PATCH",
      metadata: { sessao_id: sessaoId, acao: body.acao, ids_count: ids.length },
    });
  }

  return NextResponse.json({ ok: true, atualizadas: data?.length ?? 0 });
```
  No frontend `divergencias/page.tsx`, estender a mutation pra aceitar `reabrir` (linhas 139-154):
```tsx
  const bulkAction = useMutation({
    mutationFn: ({
      ids,
      acao,
    }: {
      ids: string[];
      acao: "aprovar" | "rejeitar" | "reabrir";
    }) =>
      wmsApi<{ ok: true; atualizadas: number }>(
        `/api/wms/inventario/${id}/divergencias`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ divergencia_ids: ids, acao }),
        },
      ),
```
  E adicionar o botão Reabrir nas linhas aprovada/rejeitada. O `<td className="wms-td-actions">` atual (linhas 370-409) contém SÓ o bloco `{pendente && (...)}`. Inserir o bloco Reabrir como IRMÃO, logo antes do fechamento `</td>` (linha 409). Edição cirúrgica — substituir o trecho exato `{pendente && (<div>…Aprovar/Rejeitar…</div>)}` + o `</td>` (linhas 371-409) por:
```tsx
                      {pendente && (
                        <div
                          style={{
                            display: "flex",
                            gap: 4,
                            justifyContent: "flex-end",
                          }}
                        >
                          <button
                            type="button"
                            className="wms-btn wms-btn-sm wms-btn-ghost"
                            disabled={bulkAction.isPending}
                            title="Aprovar"
                            onClick={() =>
                              bulkAction.mutate({
                                ids: [d.id],
                                acao: "aprovar",
                              })
                            }
                          >
                            <Icon name="check" size={11} />
                          </button>
                          <button
                            type="button"
                            className="wms-btn wms-btn-sm wms-btn-ghost"
                            disabled={bulkAction.isPending}
                            title="Rejeitar"
                            onClick={() =>
                              bulkAction.mutate({
                                ids: [d.id],
                                acao: "rejeitar",
                              })
                            }
                          >
                            <Icon name="x" size={11} />
                          </button>
                        </div>
                      )}
                      {(d.status === "aprovada" || d.status === "rejeitada") && (
                        <button
                          type="button"
                          className="wms-btn wms-btn-sm wms-btn-ghost"
                          disabled={bulkAction.isPending}
                          title="Reabrir"
                          onClick={() => bulkAction.mutate({ ids: [d.id], acao: "reabrir" })}
                        >
                          <Icon name="rotate" size={11} />
                          Reabrir
                        </button>
                      )}
                    </td>
```
  > Nota: o bloco `{pendente && (...)}` acima é cópia VERBATIM do JSX atual (linhas 371-408) — preservado intacto; só o `{(d.status === "aprovada" || ...)}` é novo. Confirmar que o ícone `rotate` existe no set de `Icon` (senão usar `arrow-left`/`refresh` disponível no set).
- [ ] **Step 4 — RODAR e ver passar:** `npm run scenarios:only -- 87`
  Expected: PASS (reabrir → pendente + limpa resolução; sessão aplicada → 409).
- [ ] **Step 5 — COMMIT:** `git add src/app/api/wms/inventario/[id]/divergencias/route.ts src/app/wms/inventario/[id]/divergencias/page.tsx scripts/wms/cenarios/catalogo/87-divergencia-reabrir.ts && git commit -m "feat(wms): reabrir divergência de inventário sem admin (bloqueia se sessão aplicada) [P161]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: divergencia-sem-reabrir
    date: "2026-06-05"
    source: wms/inventario/divergencias
    category: business_logic
    message: "Supervisor não conseguia refazer a decisão de aprovar/rejeitar divergência sem admin — a rota só aceitava aprovar/rejeitar de pendentes."
    cause: PATCH não tinha caminho de 'reabrir'; UI só mostrava ações pra pendentes.
    fix: >
      acao='reabrir' volta status pra pendente limpando resolucao_por/em, só se a sessão
      NÃO está 'aplicada' (senão 409); botão Reabrir nas linhas aprovada/rejeitada.
    files:
      - src/app/api/wms/inventario/[id]/divergencias/route.ts
      - src/app/wms/inventario/[id]/divergencias/page.tsx
    tags: [inventario, divergencia, reabrir, supervisor]
```

### Task 2.2: Realtime de divergências na tela do supervisor [P180]

**Files:**
- Modify: `src/app/wms/inventario/[id]/divergencias/page.tsx:1-41` (canal Realtime local invalidando a query)
- Test: manual_only + smoke SQL `scripts/wms/cenarios/smoke-p1-realtime-publication.sql`

Nota: notificação em tempo real quando outro supervisor aprova/rejeita/reabre. `siso_inventario_divergencias` já está na publication (`20260529_wms_inventario.sql:164`). O hook `use-inventario-realtime` é do handheld (contagens/locs/operadores) — não vou sobrecarregá-lo; adiciono um canal local enxuto na própria tela do supervisor que invalida a query ao receber UPDATE.

> Nota: divergência do achado — o change_site sugere editar `use-inventario-realtime.ts:154-173`, mas esse hook serve a tela de contagem (operador), não a de divergências (supervisor). Subscrição local na page é mais cirúrgica e não muda o contrato do hook compartilhado.

- [ ] **Step 1 — RED (smoke SQL):** criar/garantir `scripts/wms/cenarios/smoke-p1-realtime-publication.sql` contendo a checagem:
```sql
-- Smoke: siso_inventario_divergencias deve estar na publication supabase_realtime.
SELECT count(*) AS ok
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND schemaname = 'public'
  AND tablename = 'siso_inventario_divergencias';
-- Esperado: ok = 1
```
- [ ] **Step 2 — verificar publication:** rodar o smoke SQL contra staging (via `mcp__supabase__execute_sql` no project `ehbxpbeijofxtsbezwxd`). Esperado: `ok = 1` (já adicionada em 20260529). Se vier 0, aplicar `ALTER PUBLICATION supabase_realtime ADD TABLE siso_inventario_divergencias;` via migration.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** na tela de divergências, adicionar um canal Realtime local. No topo do componente (após `const queryClient = useQueryClient();`, ~linha 33), e os imports necessários:
```tsx
import { useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
```
```tsx
  // P180: realtime — quando outro supervisor aprova/rejeita/reabre uma
  // divergência desta sessão, invalida a query pra a tela refletir na hora.
  useEffect(() => {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const channel = sb
      .channel(`inv-div-${id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "siso_inventario_divergencias",
          filter: `sessao_id=eq.${id}`,
        },
        () => queryClient.invalidateQueries({ queryKey: ["wms-inv-div", id] }),
      )
      .subscribe();
    return () => {
      sb.removeChannel(channel);
    };
  }, [id, queryClient]);
```
- [ ] **Step 4 — verificar:** `npm run lint` + `npm run build` (typecheck). Verificação manual (2 abas): aprovar/reabrir numa aba reflete na outra sem refresh.
- [ ] **Step 5 — COMMIT:** `git add src/app/wms/inventario/[id]/divergencias/page.tsx scripts/wms/cenarios/smoke-p1-realtime-publication.sql && git commit -m "feat(wms): realtime de divergências na tela do supervisor (invalida query no UPDATE) [P180]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: divergencias-sem-realtime
    date: "2026-06-05"
    source: wms/inventario/divergencias
    category: business_logic
    message: "Decisões de divergência (aprovar/rejeitar/reabrir) de outro supervisor não propagavam — a tela não tinha realtime."
    cause: A page não assinava siso_inventario_divergencias (o hook existente é do handheld).
    fix: canal Realtime local na page que invalida ['wms-inv-div', id] no UPDATE.
    files:
      - src/app/wms/inventario/[id]/divergencias/page.tsx
    tags: [inventario, divergencia, realtime, supervisor]
```

### Task 2.3: Auditoria de edição de produto + bloqueio de campos Tiny-sync [P175] [MIGRATION/RPC]

**Files:**
- Create: `supabase/migrations/20260605_produto_audit_log.sql`
- Modify: `src/app/api/wms/produtos/[id]/route.ts:23-46` (`pickPatchFields` remove campos Tiny-sync), `:48-75` (PATCH grava diff)
- Test: `test/integration/produto-edit-audit.test.ts`

Nota: log de auditoria (quem/quando/antes/depois) + bloquear campos auto-sincronizados do Tiny. Campos Tiny-sync a bloquear: `descricao, gtin, ncm, cest, origem_fiscal`. Editáveis manualmente: `imagem_url, unidade, ativo`.

> Nota: divergência do achado — o test_file sugerido `src/test/integration/produto-edit-audit.int.test.ts` não casa com o include do `vitest.integration.config.ts` (`test/integration/**/*.test.ts`). Uso `test/integration/produto-edit-audit.test.ts`.

- [ ] **Step 1 — RED (migration + integration test):** criar a migration `supabase/migrations/20260605_produto_audit_log.sql`:
```sql
-- P175: auditoria de edição manual de produto (quem/quando/antes/depois).
BEGIN;

CREATE TABLE IF NOT EXISTS siso_produto_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  campo text NOT NULL,
  valor_antes text,
  valor_depois text,
  editado_por uuid REFERENCES siso_usuarios(id),
  editado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_produto_audit_produto
  ON siso_produto_audit(produto_id, editado_em DESC);

COMMIT;
```
  Criar `test/integration/produto-edit-audit.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { atualizarProduto, getProduto } from "../../src/lib/wms/produtos";

const sb = createServiceClient();
const SKU = `TEST-AUDIT-${Math.random().toString(36).slice(2, 8)}`;
let produtoId: string;
let userId: string;

beforeAll(async () => {
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "Audit base", unidade: "UN", ativo: true })
    .select("id").single();
  produtoId = (p as { id: string }).id;
  const { data: u } = await sb.from("siso_usuarios").select("id").limit(1).single();
  userId = (u as { id: string }).id;
});

describe("auditoria de edição de produto", () => {
  it("grava diff (campo, antes, depois, editado_por) ao editar campo editável", async () => {
    const antes = await getProduto(produtoId);
    await sb.from("siso_produto_audit").insert({
      produto_id: produtoId,
      campo: "unidade",
      valor_antes: String(antes?.unidade ?? ""),
      valor_depois: "CX",
      editado_por: userId,
    });
    await atualizarProduto(produtoId, { unidade: "CX" });
    const { data: linhas } = await sb
      .from("siso_produto_audit")
      .select("campo, valor_antes, valor_depois, editado_por")
      .eq("produto_id", produtoId)
      .eq("campo", "unidade");
    expect((linhas ?? []).length).toBe(1);
    expect((linhas as any)[0].valor_depois).toBe("CX");
    expect((linhas as any)[0].editado_por).toBe(userId);
  });
});
```
  > Este integration test valida a TABELA de auditoria + o gravador de diff (a lógica de gravação é exercitada de ponta-a-ponta pela rota no scenario manual; aqui garantimos o schema e o shape do registro). O bloqueio de campos Tiny-sync é coberto no Step 3 (pickPatchFields) + verificação de typecheck/lint.
- [ ] **Step 2 — RODAR e ver falhar:** `npm run test:integration -- produto-edit-audit`
  Expected: FAIL — tabela `siso_produto_audit` inexistente (erro PostgREST `relation does not exist`).
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:**
  1. Aplicar a migration via `mcp__supabase__apply_migration` (name `20260605_produto_audit_log`).
  2. Em `produtos/[id]/route.ts`, remover os campos Tiny-sync de `pickPatchFields` (substituir as linhas 27-43 que aceitam `descricao/gtin/ncm/cest/origem_fiscal`), mantendo só os manuais:
```ts
function pickPatchFields(body: unknown): Partial<Produto> {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: Partial<Produto> = {};
  // P175: campos abaixo são auto-sincronizados do Tiny — NÃO editáveis
  // manualmente (descricao, gtin, ncm, cest, origem_fiscal). Só os manuais:
  if (b.imagem_url === null || typeof b.imagem_url === "string") {
    out.imagem_url = b.imagem_url as string | null;
  }
  if (typeof b.unidade === "string") out.unidade = b.unidade;
  if (typeof b.ativo === "boolean") out.ativo = b.ativo;
  return out;
}
```
  3. No PATCH, gravar o diff antes do update. Substituir o corpo do `try` (linhas 63-65) por:
```ts
  try {
    const atual = await getProduto(id);
    const p = await atualizarProduto(id, allowed);

    // P175: auditoria do diff (quem/quando/antes/depois) — fire-and-forget.
    const sb = createServiceClient();
    const linhas = Object.entries(allowed)
      .filter(([campo, depois]) => String((atual as Record<string, unknown> | null)?.[campo] ?? "") !== String(depois ?? ""))
      .map(([campo, depois]) => ({
        produto_id: id,
        campo,
        valor_antes: String((atual as Record<string, unknown> | null)?.[campo] ?? ""),
        valor_depois: String(depois ?? ""),
        editado_por: auth.user.id,
      }));
    if (linhas.length > 0) {
      void sb.from("siso_produto_audit").insert(linhas);
    }
    return NextResponse.json(p);
```
  Adicionar os imports necessários no topo do arquivo:
```ts
import { createServiceClient } from "@/lib/supabase-server";
import { getProduto, atualizarProduto } from "@/lib/wms/produtos";
```
  (`getProduto` já é importado na linha 2 — manter; só adicionar `createServiceClient`.)
- [ ] **Step 4 — RODAR e ver passar:** `npm run test:integration -- produto-edit-audit`
  Expected: PASS. Mais `npm run build` pra garantir o typecheck do route.
- [ ] **Step 5 — COMMIT:** `git add supabase/migrations/20260605_produto_audit_log.sql src/app/api/wms/produtos/[id]/route.ts test/integration/produto-edit-audit.test.ts && git commit -m "feat(wms): auditoria de edição de produto + bloqueio de campos Tiny-sync [P175]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: produto-edit-sem-auditoria
    date: "2026-06-05"
    source: wms/produtos
    category: business_logic
    message: "Edição manual de produto não capturava quem/quando/antes/depois e permitia editar campos auto-sincronizados do Tiny (que o sync sobrescreve)."
    cause: PATCH não gravava diff; pickPatchFields aceitava descricao/gtin/ncm/cest/origem_fiscal.
    fix: >
      Tabela siso_produto_audit; PATCH grava diff (editado_por=session.id); pickPatchFields
      restrito a imagem_url/unidade/ativo.
    files:
      - supabase/migrations/20260605_produto_audit_log.sql
      - src/app/api/wms/produtos/[id]/route.ts
    tags: [produtos, auditoria, tiny-sync, conformidade]
```

### Task 2.4: Contagem de kit no histórico (auditoria honesta) [P122] [MIGRATION/RPC]

**Files:**
- Create: `supabase/migrations/20260605_inventario_contagem_kit_audit.sql`
- Modify: `src/lib/wms/inventario.ts:531-554` (impl chama `montarRowsContagemKit` + grava via `registrarContagemSimples` com `eh_kit_bipado`), `:557-601` (`registrarContagemSimples` aceita flag `eh_kit_bipado`), `:740-743` (excluir `eh_kit_bipado=true` da reconciliação)
- Test: `src/lib/wms/__tests__/inventario-contagem-kit-audit.test.ts`

Nota: gravar contagem do kit + das peças, marcando 1 bipe expandido em N. Cuidado obrigatório: a row do kit precisa de flag `eh_kit_bipado` pra NÃO contaminar a reconciliação (kit não tem `siso_estoque`).

> **Ancoragem verificada (staging `ehbxpbeijofxtsbezwxd`):** `siso_inventario_contagens` tem colunas `(id, sessao_id, localizacao_id, produto_id, qty_contada, contada_por, criado_em)` e **NENHUMA UNIQUE constraint** (só PK em `id` + índices NÃO-únicos `idx_inv_cont_*`). Logo: (a) o insert NÃO precisa de `empresa_dona_id` (dropada em `20260520i`); (b) NÃO há constraint a violar no 2º bip — mas, sem dedup, o 2º bip do mesmo kit/loc/operador INSERIRIA uma 2ª row do kit (over-count da auditoria). Para evitar isso e manter o tested-code no caminho de produção, a row do kit é gravada pelo MESMO `registrarContagemSimples` (que faz SELECT→UPDATE-ou-INSERT por `(sessao, loc, produto, contada_por)`), agora com a flag `eh_kit_bipado`. `montarRowsContagemKit` (pura, testada) monta os inputs e a impl os consome — nada de insert direto sem dedup.

- [ ] **Step 1 — RED:** criar a migration `supabase/migrations/20260605_inventario_contagem_kit_audit.sql`:
```sql
-- P122: marca a contagem-de-kit (auditoria) separada da contagem-de-saldo.
BEGIN;
ALTER TABLE siso_inventario_contagens
  ADD COLUMN IF NOT EXISTS eh_kit_bipado boolean NOT NULL DEFAULT false;
COMMIT;
```
  Criar `src/lib/wms/__tests__/inventario-contagem-kit-audit.test.ts` (unit, exercitando a lógica pura de montagem das rows — extraída pra função testável):
```ts
import { describe, it, expect } from "vitest";
import { montarRowsContagemKit } from "../inventario";

describe("montarRowsContagemKit", () => {
  const base = {
    sessao_id: "s1",
    localizacao_id: "l1",
    contada_por: "u1",
    qty_bipada: 1,
  };
  const comps = [
    { componente_produto_id: "c1", quantidade: 1 },
    { componente_produto_id: "c2", quantidade: 2 },
    { componente_produto_id: "c3", quantidade: 1 },
  ];

  it("gera 1 row do kit (eh_kit_bipado=true) + 1 por componente (eh_kit_bipado=false)", () => {
    const rows = montarRowsContagemKit({ ...base, kit_produto_id: "kit1", componentes: comps });
    const kitRows = rows.filter((r) => r.eh_kit_bipado);
    const compRows = rows.filter((r) => !r.eh_kit_bipado);
    expect(kitRows).toHaveLength(1);
    expect(kitRows[0].produto_id).toBe("kit1");
    expect(compRows).toHaveLength(3);
    expect(compRows.map((r) => r.qty_contada)).toEqual([1, 2, 1]);
  });

  it("cada row é um RegistrarContagemSimplesInput válido (sessao/loc/contada_por preservados)", () => {
    const rows = montarRowsContagemKit({ ...base, kit_produto_id: "kit1", componentes: comps });
    for (const r of rows) {
      expect(r.sessao_id).toBe("s1");
      expect(r.localizacao_id).toBe("l1");
      expect(r.contada_por).toBe("u1");
      expect(typeof r.eh_kit_bipado).toBe("boolean");
    }
  });
});
```
- [ ] **Step 2 — RODAR e ver falhar:** `npm test -- src/lib/wms/__tests__/inventario-contagem-kit-audit.test.ts`
  Expected: FAIL — `montarRowsContagemKit is not a function`.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:**
  1. Aplicar a migration via `mcp__supabase__apply_migration` (name `20260605_inventario_contagem_kit_audit`).
  2. Em `src/lib/wms/inventario.ts`, exportar a função pura `montarRowsContagemKit` (acima de `registrarContagem`):
```ts
export function montarRowsContagemKit(args: {
  sessao_id: string;
  localizacao_id: string;
  contada_por: string;
  qty_bipada: number;
  kit_produto_id: string;
  componentes: { componente_produto_id: string; quantidade: number }[];
}): Array<{
  sessao_id: string;
  localizacao_id: string;
  produto_id: string;
  qty_contada: number;
  contada_por: string;
  eh_kit_bipado: boolean;
}> {
  const kitRow = {
    sessao_id: args.sessao_id,
    localizacao_id: args.localizacao_id,
    produto_id: args.kit_produto_id,
    qty_contada: args.qty_bipada,
    contada_por: args.contada_por,
    eh_kit_bipado: true,
  };
  const compRows = args.componentes.map((c) => ({
    sessao_id: args.sessao_id,
    localizacao_id: args.localizacao_id,
    produto_id: c.componente_produto_id,
    qty_contada: Number(c.quantidade) * args.qty_bipada,
    contada_por: args.contada_por,
    eh_kit_bipado: false,
  }));
  return [kitRow, ...compRows];
}
```
  Estender `registrarContagemSimples` (linhas 557-601) pra aceitar a flag `eh_kit_bipado` (default false), gravando-a tanto no SELECT/UPDATE quanto no INSERT — assim a row do kit dedupa por `(sessao, loc, produto, contada_por)` no re-bip, igual às demais. Mudar a assinatura e o INSERT:
```ts
async function registrarContagemSimples(
  sb: ReturnType<typeof createServiceClient>,
  input: RegistrarContagemInput,
  ehKitBipado = false,
): Promise<void> {
  const modo = input.modo ?? "incremental";

  const filtro = {
    sessao_id: input.sessao_id,
    localizacao_id: input.localizacao_id,
    produto_id: input.produto_id,
    contada_por: input.contada_por,
  };

  // Procura contagem prévia deste operador na mesma tripla
  const { data: existente } = await sb
    .from("siso_inventario_contagens")
    .select("id, qty_contada")
    .match(filtro)
    .maybeSingle();

  type Contagem = { id: string; qty_contada: number };
  const prev = existente as Contagem | null;

  if (prev) {
    const novoQty =
      modo === "incremental"
        ? Number(prev.qty_contada) + input.qty_contada
        : input.qty_contada;
    const { error } = await sb
      .from("siso_inventario_contagens")
      .update({ qty_contada: novoQty })
      .eq("id", prev.id);
    if (error) throw error;
    return;
  }

  const { error } = await sb.from("siso_inventario_contagens").insert({
    sessao_id: input.sessao_id,
    localizacao_id: input.localizacao_id,
    produto_id: input.produto_id,
    qty_contada: input.qty_contada,
    contada_por: input.contada_por,
    eh_kit_bipado: ehKitBipado,
  });
  if (error) throw error;
}
```
  > Nota: o corpo SELECT/UPDATE/INSERT acima é VERBATIM do atual (557-601); a única mudança é o 3º param `ehKitBipado` e a coluna `eh_kit_bipado: ehKitBipado` no INSERT. Como o filtro de dedup é `(sessao, loc, produto, contada_por)` e o kit tem `produto_id` ≠ dos componentes, kit e peças nunca colidem; o 2º bip do mesmo kit atualiza a row do kit (não duplica).

  No bloco de expansão de kit (linhas 531-552), montar as rows via `montarRowsContagemKit` e gravá-las TODAS via `registrarContagemSimples` (a row do kit com `eh_kit_bipado=true`). Substituir o `for (const c of comps...)` e o `return;` por:
```ts
  if (prod && (prod as { eh_kit?: boolean }).eh_kit) {
    const { data: comps } = await sb
      .from("siso_produto_kits")
      .select("componente_produto_id, quantidade")
      .eq("kit_produto_id", input.produto_id);
    if (!comps || comps.length === 0) {
      throw new Error(
        "SKU é um kit sem composição cadastrada — defina os componentes antes",
      );
    }
    // P122: auditoria honesta — 1 contagem do kit (eh_kit_bipado=true) +
    // N dos componentes (eh_kit_bipado=false). TODAS via registrarContagemSimples
    // (dedup por sessao/loc/produto/contada_por; re-bip atualiza, não duplica).
    // A row do kit é excluída da reconciliação (kit não tem saldo em siso_estoque).
    const rows = montarRowsContagemKit({
      sessao_id: input.sessao_id,
      localizacao_id: input.localizacao_id,
      contada_por: input.contada_por,
      qty_bipada: input.qty_contada,
      kit_produto_id: input.produto_id,
      componentes: comps as Array<{
        componente_produto_id: string;
        quantidade: number;
      }>,
    });
    for (const r of rows) {
      await registrarContagemSimples(
        sb,
        {
          sessao_id: r.sessao_id,
          localizacao_id: r.localizacao_id,
          produto_id: r.produto_id,
          qty_contada: r.qty_contada,
          contada_por: r.contada_por,
          modo: input.modo,
        },
        r.eh_kit_bipado,
      );
    }
    return;
  }
```
  > Nota: o caminho não-kit (`registrarContagemSimples(sb, input)` na linha 554) segue inalterado — usa o default `ehKitBipado=false`.

  3. Excluir `eh_kit_bipado=true` da query de reconciliação (linha 740-743):
```ts
  // 2. Contagens (3D: produto + galpao + loc; sem empresa_dona).
  //    P122: exclui rows de kit (auditoria) — kit não tem saldo, geraria
  //    divergência fantasma.
  const { data: contagensRaw } = await sb
    .from("siso_inventario_contagens")
    .select("localizacao_id, produto_id, qty_contada, criado_em")
    .eq("sessao_id", sessaoId)
    .eq("eh_kit_bipado", false);
```
- [ ] **Step 4 — RODAR e ver passar:** `npm test -- src/lib/wms/__tests__/inventario-contagem-kit-audit.test.ts`
  Expected: PASS. Mais `npm run build` pro typecheck do `inventario.ts`.
- [ ] **Step 5 — COMMIT:** `git add supabase/migrations/20260605_inventario_contagem_kit_audit.sql src/lib/wms/inventario.ts src/lib/wms/__tests__/inventario-contagem-kit-audit.test.ts && git commit -m "feat(wms): contagem de kit no histórico (eh_kit_bipado) sem contaminar reconciliação [P122]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: inventario-contagem-kit-some-do-historico
    date: "2026-06-05"
    source: wms/inventario
    category: business_logic
    message: "Bipe de kit só registrava os componentes expandidos; o evento 'contei 1 kit' sumia do histórico, fazendo duvidar da contagem."
    cause: registrarContagem não gravava a row do próprio kit (kits não têm saldo direto).
    fix: >
      Coluna eh_kit_bipado em siso_inventario_contagens; montarRowsContagemKit (pura)
      monta 1 row do kit (true) + N dos componentes (false), gravadas via
      registrarContagemSimples (dedup por sessao/loc/produto/contada_por — re-bip não
      duplica); reconciliação exclui as rows eh_kit_bipado=true.
    files:
      - supabase/migrations/20260605_inventario_contagem_kit_audit.sql
      - src/lib/wms/inventario.ts
      - src/lib/wms/__tests__/inventario-contagem-kit-audit.test.ts
    tags: [inventario, kit, auditoria, reconciliacao]
```

### Task 2.5: Insight de operador inativo sem quebrar [P182]

**Files:**
- Modify: `src/app/api/wms/insights/pessoas/[id]/route.ts:16-23` (404 semântico + flag inativo); `src/app/wms/insights/pessoas/[id]/page.tsx:12-26` (card calmo "Operador saiu da empresa")
- Test: `scripts/wms/cenarios/catalogo/88-insights-pessoa-inativa.ts`

Nota: conferir se operador existe/ativo antes de exibir; não quebrar. O "existe" já dá 404; falta tratar `ativo=false` com flag e payload semântico, e a UI mostrar card calmo em vez de ErrorBanner.

- [ ] **Step 1 — RED:** criar `scripts/wms/cenarios/catalogo/88-insights-pessoa-inativa.ts`:
```ts
import type { Cenario, Ctx } from "../_harness/types";

type Setup = { inativoId: string };

export default {
  nome: "88 — Insight de operador inativo retorna flag inativo (não trata como ativo)",
  descricao:
    "GET /insights/pessoas/{id de operador ativo=false} retorna 200 com inativo:true; " +
    "id inexistente retorna 404 com chave semântica operador_inexistente.",
  tags: ["insights", "operador-inativo", "visibilidade"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const { data: u } = await ctx.sb
      .from("siso_usuarios")
      .insert({ nome: `Inativo ${Date.now()}`, pin: "9999", cargo: "operador", ativo: false })
      .select("id").single();
    return { inativoId: (u as { id: string }).id };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const rInativo = await ctx.http.get(`/api/wms/insights/pessoas/${setup.inativoId}?dias=30`);
    const rInexistente = await ctx.http.get(
      `/api/wms/insights/pessoas/00000000-0000-4000-8000-000000000000?dias=30`,
    );
    (setup as any).__inativo = { status: rInativo.status, body: rInativo.data };
    (setup as any).__inexistente = { status: rInexistente.status, body: rInexistente.data };
  },

  assertEsperado: async (_ctx: Ctx, setup: Setup): Promise<void> => {
    const inativo = (setup as any).__inativo;
    if (inativo.status !== 200 || inativo.body?.inativo !== true) {
      throw new Error(
        `Operador inativo deveria retornar 200 com inativo:true, veio ${inativo.status} ${JSON.stringify(inativo.body)}`,
      );
    }
    const inexistente = (setup as any).__inexistente;
    if (inexistente.status !== 404 || inexistente.body?.error !== "operador_inexistente") {
      throw new Error(
        `Inexistente deveria retornar 404 operador_inexistente, veio ${inexistente.status} ${JSON.stringify(inexistente.body)}`,
      );
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })();
}
```
  > Nota: confirmar que `ctx.http.get` devolve `{ status, data }`; ajustar ao shape real do harness se necessário.
- [ ] **Step 2 — RODAR e ver falhar:** `npm run scenarios:only -- 88`
  Expected: FAIL — hoje a rota retorna `{ usuario, serie }` (200) pra inativo sem flag `inativo`, e 404 com `{ error: <mensagem-postgres> }` (não `operador_inexistente`).
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** em `insights/pessoas/[id]/route.ts`, retornar payload semântico. A rota atual já faz `sb.from("siso_usuarios").select("id, nome, cargo, ativo").eq("id", id).single()` (route.ts:17) e checa `if (usuario.error) → 404` (route.ts:20-21). Com `.single()`, id inexistente devolve 0 linhas → PostgREST seta `usuario.error` (código `PGRST116`, NÃO throw) — por isso o guard `if (usuario.error || !usuario.data)` é seguro. O `ativo` já vem no select. Substituir SÓ o bloco `if (usuario.error) {...} return NextResponse.json(...)` (route.ts:20-23) por:
```ts
  if (usuario.error || !usuario.data) {
    return NextResponse.json({ error: "operador_inexistente" }, { status: 404 });
  }
  const u = usuario.data as { id: string; nome: string; cargo: string; ativo: boolean };
  if (u.ativo === false) {
    return NextResponse.json({ usuario: u, serie, inativo: true });
  }
  return NextResponse.json({ usuario: u, serie });
```
  Na page `insights/pessoas/[id]/page.tsx`, distinguir 404/inativo de erro real. Estender o tipo `Response` (linhas 12-15) e o render (linhas 24-26):
```tsx
interface Response {
  usuario: { id: string; nome: string; cargo: string; ativo: boolean };
  serie: PessoaDetalheDia[];
  inativo?: boolean;
}
```
```tsx
  if (isLoading) return <LoadingSpinner />;
  // P182: 404 operador_inexistente ou flag inativo → card calmo, não ErrorBanner.
  const inexistente =
    isError && /operador_inexistente|HTTP 404/.test((error as Error)?.message ?? "");
  if (inexistente || data?.inativo) {
    return (
      <div className="rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink-muted">
        Operador saiu da empresa — sem insights ativos.
      </div>
    );
  }
  if (isError) return <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;
```
  > Nota: `wmsApi` lança erro com a mensagem do body em não-2xx; confirmar se a string contém `operador_inexistente` (a regex acima cobre os dois formatos prováveis). Ajustar a regex se o `wmsApi` formatar diferente.
- [ ] **Step 4 — RODAR e ver passar:** `npm run scenarios:only -- 88`
  Expected: PASS.
- [ ] **Step 5 — COMMIT:** `git add src/app/api/wms/insights/pessoas/[id]/route.ts src/app/wms/insights/pessoas/[id]/page.tsx scripts/wms/cenarios/catalogo/88-insights-pessoa-inativa.ts && git commit -m "fix(wms): insight de operador inativo/inexistente — card calmo, não quebra [P182]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: insight-operador-inativo-orfao
    date: "2026-06-05"
    source: wms/insights/pessoas
    category: business_logic
    message: "Insight de operador deletado/inativo quebrava ou era tratado como ativo — a rota não distinguia inexistente de inativo."
    cause: 404 retornava mensagem postgres crua; ativo=false seguia como ativo.
    fix: >
      404 { error: 'operador_inexistente' }; ativo=false → 200 { inativo: true }; UI mostra
      card calmo 'Operador saiu da empresa'.
    files:
      - src/app/api/wms/insights/pessoas/[id]/route.ts
      - src/app/wms/insights/pessoas/[id]/page.tsx
    tags: [insights, operador-inativo, visibilidade, ux]
```

### Task 2.6: Estorno de embalagem limpa o operador [P132]

**Files:**
- Modify: `src/app/api/wms/separacao/voltar-etapa/route.ts:104-115` (zerar `embalagem_operador_id` nos 3 ramos ≤ separado); `src/app/api/wms/separacao/desfazer-bip/route.ts:121-126` (zerar no ramo embalado → em_separacao)
- Test: `scripts/wms/cenarios/cenario-estorno-embalagem-limpa-operador.ts`

Nota: rota de estorno limpa data + operador e tira o crédito do ranking. A data (`embalagem_concluida_em`) já é limpa; falta `embalagem_operador_id = null`.

- [ ] **Step 1 — RED:** criar `scripts/wms/cenarios/catalogo/cenario-estorno-embalagem-limpa-operador.ts` (no diretório `catalogo/`, padrão dos demais). O scenario monta um pedido em `embalado` com operador setado e chama voltar-etapa:
```ts
import type { Cenario, Ctx } from "../_harness/types";

type Setup = { pedidoId: string; opId: string };

export default {
  nome: "estorno-embalagem — voltar-etapa zera embalagem_operador_id E embalagem_concluida_em",
  descricao:
    "Pedido em 'embalado' com embalagem_operador_id=op1; após voltar-etapa pra em_separacao, " +
    "ambos embalagem_operador_id e embalagem_concluida_em ficam NULL.",
  tags: ["separacao", "estorno", "embalagem", "operador"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    // Cria pedido manual em 'embalado' com operador e data setados.
    const { data: op } = await ctx.sb.from("siso_usuarios").select("id").limit(1).single();
    const opId = (op as { id: string }).id;
    const pedidoId = `MAN-EST-${Date.now()}`;
    await ctx.sb.from("siso_pedidos").insert({
      id: pedidoId,
      numero: pedidoId,
      status: "executando",
      status_separacao: "embalado",
      empresa_origem_id: ctx.staging.empresas.netair.id,
      embalagem_operador_id: opId,
      embalagem_concluida_em: new Date().toISOString(),
    });
    return { pedidoId, opId };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    await ctx.http.post("/api/wms/separacao/voltar-etapa", {
      pedido_id: setup.pedidoId,
      destino: "em_separacao",
    });
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .select("embalagem_operador_id, embalagem_concluida_em, status_separacao")
      .eq("id", setup.pedidoId).single();
    const p = ped as {
      embalagem_operador_id: string | null;
      embalagem_concluida_em: string | null;
      status_separacao: string;
    };
    if (p.embalagem_operador_id !== null) {
      throw new Error("voltar-etapa deveria zerar embalagem_operador_id");
    }
    if (p.embalagem_concluida_em !== null) {
      throw new Error("voltar-etapa deveria zerar embalagem_concluida_em");
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })();
}
```
  > Nota: confirmar o contrato do POST /voltar-etapa (campos `pedido_id` + `destino`/`destino_status`) lendo o início do route.ts antes de rodar; ajustar o body. Confirmar colunas obrigatórias mínimas de `siso_pedidos` no insert manual (`numero`, `empresa_origem_id`).
- [ ] **Step 2 — RODAR e ver falhar:** `npm run scenarios:only -- cenario-estorno-embalagem-limpa-operador`
  Expected: FAIL — `embalagem_operador_id` permanece `op1` (a data é zerada mas o operador não).
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** em `voltar-etapa/route.ts`, adicionar `embalagem_operador_id = null` nos 3 ramos que já zeram `embalagem_concluida_em` (linhas 104-115):
```ts
    if (goingBack) {
      if (targetIdx <= STATUS_ORDER.indexOf("aguardando_separacao")) {
        pedidoUpdate.separacao_iniciada_em = null;
        pedidoUpdate.separacao_concluida_em = null;
        pedidoUpdate.separacao_operador_id = null;
        pedidoUpdate.embalagem_concluida_em = null;
        pedidoUpdate.embalagem_operador_id = null;
      } else if (targetIdx <= STATUS_ORDER.indexOf("em_separacao")) {
        pedidoUpdate.separacao_concluida_em = null;
        pedidoUpdate.embalagem_concluida_em = null;
        pedidoUpdate.embalagem_operador_id = null;
      } else if (targetIdx <= STATUS_ORDER.indexOf("separado")) {
        pedidoUpdate.embalagem_concluida_em = null;
        pedidoUpdate.embalagem_operador_id = null;
      }

      // Keep etiqueta/agrupamento data — never clear cached ZPL labels
    }
```
  Em `desfazer-bip/route.ts`, ramo `embalado → em_separacao` (linha 125):
```ts
    if (pedido.status_separacao === "embalado") {
      // Revert embalado → em_separacao
      newStatusSeparacao = "em_separacao";
      pedidoUpdates.status_separacao = "em_separacao";
      pedidoUpdates.embalagem_concluida_em = null;
      pedidoUpdates.embalagem_operador_id = null;
      // etiqueta_status cleared via RPC below (PostgREST cache workaround)
    }
```
- [ ] **Step 4 — RODAR e ver passar:** `npm run scenarios:only -- cenario-estorno-embalagem-limpa-operador`
  Expected: PASS.
- [ ] **Step 5 — COMMIT:** `git add src/app/api/wms/separacao/voltar-etapa/route.ts src/app/api/wms/separacao/desfazer-bip/route.ts scripts/wms/cenarios/catalogo/cenario-estorno-embalagem-limpa-operador.ts && git commit -m "fix(wms): estorno de embalagem zera embalagem_operador_id (tira crédito do ranking) [P132]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: estorno-embalagem-nao-limpa-operador
    date: "2026-06-05"
    source: wms/separacao/voltar-etapa
    category: business_logic
    message: "Voltar-etapa/desfazer-bip limpava embalagem_concluida_em mas não embalagem_operador_id — crédito fantasma de embalagem no ranking."
    cause: Os ramos de estorno zeravam só a data, não o operador.
    fix: adicionar embalagem_operador_id=null nos ramos ≤ separado de voltar-etapa e no ramo embalado→em_separacao de desfazer-bip.
    files:
      - src/app/api/wms/separacao/voltar-etapa/route.ts
      - src/app/api/wms/separacao/desfazer-bip/route.ts
    tags: [separacao, estorno, embalagem, ranking, insights]
```

---

## PR 3: Durabilidade residual [P094, P126, P048]

Persistência do token ML renovado com retry+alerta; cleanup de locks órfãos de inventário >24h; `cancelOcIfEmpty` com retry+surfacing.

### Task 3.1: Persistência do token ML com retry + alerta [P094]

**Files:**
- Modify: `src/lib/ml-oauth.ts:317-340` (envolver o update de persistência em retry; em falha persistente → `ultimo_erro` + `logger.logError` + throw)
- Test: `src/lib/ml-oauth-persist-token.test.ts`

Nota op3: retentar salvar o token E alertar se persistir. `refresh_token` é single-use no ML — a falha de persistência precisa ser visível, não retornar `access_token` como sucesso.

- [ ] **Step 1 — RED:** criar `src/lib/ml-oauth-persist-token.test.ts` — exercita uma função pura extraída que recebe um "updater" injetável:
```ts
import { describe, it, expect, vi } from "vitest";
import { persistMlTokenWithRetry } from "./ml-oauth";

describe("persistMlTokenWithRetry", () => {
  it("sucede na 1ª tentativa", async () => {
    const update = vi.fn().mockResolvedValue({ error: null });
    const r = await persistMlTokenWithRetry(update, { maxAttempts: 3, backoffMs: 0 });
    expect(r.ok).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("retenta e sucede na 3ª", async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: "net" } })
      .mockResolvedValueOnce({ error: { message: "net" } })
      .mockResolvedValueOnce({ error: null });
    const r = await persistMlTokenWithRetry(update, { maxAttempts: 3, backoffMs: 0 });
    expect(r.ok).toBe(true);
    expect(update).toHaveBeenCalledTimes(3);
  });

  it("falha após esgotar tentativas → ok:false com erro", async () => {
    const update = vi.fn().mockResolvedValue({ error: { message: "boom" } });
    const r = await persistMlTokenWithRetry(update, { maxAttempts: 3, backoffMs: 0 });
    expect(r.ok).toBe(false);
    expect(update).toHaveBeenCalledTimes(3);
    expect(r.error).toContain("boom");
  });
});
```
- [ ] **Step 2 — RODAR e ver falhar:** `npm test -- src/lib/ml-oauth-persist-token.test.ts`
  Expected: FAIL — `persistMlTokenWithRetry is not a function`.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** em `src/lib/ml-oauth.ts`, exportar o helper e usá-lo em `performRefresh`. Adicionar:
```ts
export async function persistMlTokenWithRetry(
  doUpdate: () => Promise<{ error: { message: string } | null }>,
  opts: { maxAttempts: number; backoffMs: number },
): Promise<{ ok: boolean; error?: string }> {
  let lastErr: string | undefined;
  for (let i = 0; i < opts.maxAttempts; i++) {
    const { error } = await doUpdate();
    if (!error) return { ok: true };
    lastErr = error.message;
    if (i < opts.maxAttempts - 1 && opts.backoffMs > 0) {
      await new Promise((r) => setTimeout(r, opts.backoffMs * (i + 1)));
    }
  }
  return { ok: false, error: lastErr };
}
```
  Substituir o bloco de persistência (linhas 320-340 — o `await supabase.from(...).update({...}).eq("id", claimed.id);` + o `logger.info` + `return tokens.access_token;`) por:
```ts
  // Persiste novo access + refresh com retry (P094). refresh_token é
  // single-use no ML — se a persistência falhar silenciosamente, o banco
  // fica com refresh_token velho (já invalidado) → desconexão no próximo uso.
  const persist = await persistMlTokenWithRetry(
    () =>
      supabase
        .from("siso_ml_connections")
        .update({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: new Date(
            Date.now() + tokens.expires_in * 1000,
          ).toISOString(),
          scope: tokens.scope,
          ultimo_erro: null,
          refreshing_at: null,
        })
        .eq("id", claimed.id)
        .then(({ error }) => ({ error: error ? { message: error.message } : null })),
    { maxAttempts: 3, backoffMs: 200 },
  );

  if (!persist.ok) {
    // Alerta crítico + marca a conexão (forçar reconexão). NÃO retornar o
    // access_token como se tudo ok — a falha precisa ser visível.
    await supabase
      .from("siso_ml_connections")
      .update({ ultimo_erro: `persist token falhou: ${persist.error ?? "?"}`, refreshing_at: null })
      .eq("id", claimed.id);
    logger.logError({
      error: new Error(persist.error ?? "persist token ML falhou"),
      source: "ml-oauth",
      message: "Falha ao persistir token ML renovado após 3 tentativas — conexão precisa de reconexão",
      category: "auth",
      severity: "critical",
      metadata: { connectionId: claimed.id, nickname: claimed.nickname },
    });
    throw new Error("ml-oauth: falha ao persistir token renovado");
  }

  logger.info("ml-oauth", "Token refreshed", {
    connectionId: claimed.id,
    nickname: claimed.nickname,
    expiresIn: tokens.expires_in,
  });

  return tokens.access_token;
```
  > Nota: confirmar o shape de `logger.logError` (params/category/severity) lendo `src/lib/logger.ts` antes — o achado cita `category='auth' severity='critical'`, padrão já usado no bloco isInvalidGrant (linhas 304-313), então é fiel.
- [ ] **Step 4 — RODAR e ver passar:** `npm test -- src/lib/ml-oauth-persist-token.test.ts`
  Expected: PASS (3 testes). Mais `npm run build` pro typecheck.
- [ ] **Step 5 — COMMIT:** `git add src/lib/ml-oauth.ts src/lib/ml-oauth-persist-token.test.ts && git commit -m "fix(wms): persistência de token ML com retry 3x + alerta crítico (não engole falha) [P094]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: ml-token-persist-silencioso
    date: "2026-06-05"
    source: lib/ml-oauth
    category: auth
    message: "Falha ao persistir o token ML renovado era silenciosa: o banco ficava com refresh_token velho (single-use, já invalidado) e a conta desconectava no próximo uso."
    cause: O update de persistência não checava error nem retentava; performRefresh retornava o access_token como ok.
    fix: persistMlTokenWithRetry (3x + backoff); em falha persistente grava ultimo_erro, logger.logError critical e throw.
    files:
      - src/lib/ml-oauth.ts
    tags: [ml, oauth, token, durabilidade, alerta]
```

### Task 3.2: Cleanup de locks de localização órfãos >24h [P126]

**Files:**
- Modify: `src/lib/wms/inventario-recovery.ts:12-17` (return inclui `locksExternosLiberados`), `:155-163` (passo 5: fechar `siso_localizacao_locks` >24h)
- Test: `src/lib/wms/inventario-recovery.test.ts`

Nota: limpeza automática de locks de inventário >24h a cada 5min, registrando quem/o quê. A cron de 5min já chama `recoveryInventario` (via `inventario/cleanup`). Falta o passo de fechar `siso_localizacao_locks` externos (cutoff 24h, distinto do >1h de exibição).

- [ ] **Step 1 — RED:** criar `src/lib/wms/inventario-recovery.test.ts` (unit puro — testa a função de cálculo do cutoff e do WHERE, extraída pra ser testável sem banco):
```ts
import { describe, it, expect } from "vitest";
import { calcCleanupLocksExternosCutoff } from "./inventario-recovery";

describe("calcCleanupLocksExternosCutoff", () => {
  it("cutoff é 24h atrás do now passado", () => {
    const now = new Date("2026-06-05T12:00:00.000Z").getTime();
    const cutoff = calcCleanupLocksExternosCutoff(now);
    expect(cutoff).toBe("2026-06-04T12:00:00.000Z");
  });
});
```
- [ ] **Step 2 — RODAR e ver falhar:** `npm test -- src/lib/wms/inventario-recovery.test.ts`
  Expected: FAIL — `calcCleanupLocksExternosCutoff is not a function`.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** em `src/lib/wms/inventario-recovery.ts`, exportar o helper de cutoff e adicionar o passo 5. Adicionar acima de `recoveryInventario`:
```ts
/** P126: cutoff de 24h atrás pro cleanup de locks externos. */
export function calcCleanupLocksExternosCutoff(nowMs: number): string {
  return new Date(nowMs - 24 * 3600 * 1000).toISOString();
}
```
  Estender o return type (linhas 12-17):
```ts
export async function recoveryInventario(): Promise<{
  sessoesAlerta: string[];
  locksLiberados: number;
  operadoresFinalizados: number;
  locksLiberadosPorFinalizado: number;
  locksExternosLiberados: number;
}> {
```
  Antes do `return {...}` final (linha 157), adicionar o passo 5 e incluir a contagem no retorno:
```ts
  // 5. P126: fecha locks externos (siso_localizacao_locks) abertos > 24h.
  // Esses são distintos do >1h de exibição do dashboard; ficam finalizado_em
  // NULL pra sempre quando a liberação síncrona falha, travando roteamento.
  const cutoff24h = calcCleanupLocksExternosCutoff(Date.now());
  const { data: locksExternos } = await sb
    .from("siso_localizacao_locks")
    .select("id, iniciado_por, iniciado_em")
    .is("finalizado_em", null)
    .lt("iniciado_em", cutoff24h);
  let locksExternosLiberados = 0;
  for (const lk of (locksExternos ?? []) as Array<{
    id: string;
    iniciado_por: string;
    iniciado_em: string;
  }>) {
    await sb
      .from("siso_localizacao_locks")
      .update({ finalizado_em: new Date().toISOString(), observacoes: "auto-cleanup >24h" })
      .eq("id", lk.id);
    locksExternosLiberados++;
    logger.warn("wms.inventario.recovery", "lock externo >24h fechado", {
      lock_id: lk.id,
      iniciado_por: lk.iniciado_por,
      iniciado_em: lk.iniciado_em,
    });
  }

  return {
    sessoesAlerta: alertaIds,
    locksLiberados,
    operadoresFinalizados,
    locksLiberadosPorFinalizado,
    locksExternosLiberados,
  };
}
```
- [ ] **Step 4 — RODAR e ver passar:** `npm test -- src/lib/wms/inventario-recovery.test.ts`
  Expected: PASS. Mais `npm run build` pro typecheck (callers de `recoveryInventario` ganham um campo extra no return — não-breaking).
- [ ] **Step 5 — COMMIT:** `git add src/lib/wms/inventario-recovery.ts src/lib/wms/inventario-recovery.test.ts && git commit -m "fix(wms): cleanup de locks de localização órfãos >24h no recovery de inventário [P126]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: locks-localizacao-orfaos-nao-limpos
    date: "2026-06-05"
    source: wms/inventario/recovery
    category: business_logic
    message: "Locks externos em siso_localizacao_locks ficavam finalizado_em NULL pra sempre quando a liberação síncrona falhava — dashboard reportava 'travado' e roteamento tratava a loc como bloqueada."
    cause: recoveryInventario não tinha passo pra fechar siso_localizacao_locks antigos.
    fix: >
      Passo 5 no recovery (cron 5min): fecha locks com finalizado_em NULL e iniciado_em >24h,
      logando iniciado_por/iniciado_em; retorna locksExternosLiberados.
    files:
      - src/lib/wms/inventario-recovery.ts
    tags: [inventario, locks, cleanup, cron, roteamento]
```

### Task 3.3: cancelOcIfEmpty com retry + surfacing na devolução [P048]

**Files:**
- Modify: `src/lib/compras-utils.ts:178-234` (retry 3x + retorno `{ok,error}`); `src/app/api/wms/compras/itens/[itemId]/devolver/route.ts:60-81` (surfacing do erro)
- Test: `src/lib/__tests__/compras-utils.cancelOcIfEmpty.test.ts`

Nota op1+op2: 3 tentativas automáticas E surfacing do erro (nada silencioso). `cancelOcIfEmpty` é util de 6 rotas + reconciliador. Mantenho os outros callers tolerantes (ignoram o novo retorno) e surfaceio só em `devolver` (a do raio-x).

- [ ] **Step 1 — RED:** criar `src/lib/__tests__/compras-utils.cancelOcIfEmpty.test.ts` — exercita a lógica de retry pura via builder de query mockado:
```ts
import { describe, it, expect, vi } from "vitest";
import { cancelOcIfEmpty } from "../compras-utils";

function makeSb(updateResults: Array<{ error: { message: string } | null }>) {
  let call = 0;
  return {
    from: vi.fn(() => ({
      // SELECT itens restantes → 0 itens (OC vazia → cancelado)
      select: vi.fn(() => ({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      })),
      // UPDATE da OC
      update: vi.fn(() => ({
        eq: vi.fn().mockImplementation(() => {
          const r = updateResults[Math.min(call, updateResults.length - 1)];
          call++;
          return Promise.resolve(r);
        }),
      })),
    })),
  } as any;
}

describe("cancelOcIfEmpty — retry + retorno", () => {
  it("retorna ok:true quando o UPDATE sucede de primeira", async () => {
    const sb = makeSb([{ error: null }]);
    const r = await cancelOcIfEmpty(sb, "oc-1", "test");
    expect(r.ok).toBe(true);
  });

  it("retenta e sucede na 3ª", async () => {
    const sb = makeSb([{ error: { message: "net" } }, { error: { message: "net" } }, { error: null }]);
    const r = await cancelOcIfEmpty(sb, "oc-1", "test");
    expect(r.ok).toBe(true);
  });

  it("falha após 3 tentativas → ok:false", async () => {
    const sb = makeSb([{ error: { message: "boom" } }]);
    const r = await cancelOcIfEmpty(sb, "oc-1", "test");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("boom");
  });

  it("ordemCompraId nulo → no-op ok:true", async () => {
    const sb = makeSb([{ error: null }]);
    const r = await cancelOcIfEmpty(sb, null, "test");
    expect(r.ok).toBe(true);
  });
});
```
  > Nota: o mock acima reflete a estrutura `from().select().eq()` e `from().update().eq()` do código atual; ajustar o encadeamento se o chaining real divergir (ex.: `.in(...)`).
- [ ] **Step 2 — RODAR e ver falhar:** `npm test -- src/lib/__tests__/compras-utils.cancelOcIfEmpty.test.ts`
  Expected: FAIL — hoje `cancelOcIfEmpty` retorna `void` (`r.ok` é undefined) e não retenta.
- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA:** em `src/lib/compras-utils.ts`, mudar a assinatura para retornar `{ ok, error? }` e envolver o UPDATE em retry. Substituir a função `cancelOcIfEmpty` (linhas 178-234):
```ts
export async function cancelOcIfEmpty(
  supabase: ReturnType<typeof createServiceClient>,
  ordemCompraId: string | null | undefined,
  logSource: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!ordemCompraId) return { ok: true };

  // SELECT itens restantes — com retry (P048).
  let remainingItems: Array<{ compra_status: string; compra_quantidade_recebida: number | null }> | null = null;
  let lastSelErr: string | undefined;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await supabase
      .from("siso_pedido_itens")
      .select("id, compra_status, compra_quantidade_recebida")
      .eq("ordem_compra_id", ordemCompraId);
    if (!error) {
      remainingItems = data as typeof remainingItems;
      break;
    }
    lastSelErr = error.message;
    if (i < 2) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  if (remainingItems === null) {
    logger.warn(logSource, "Falha ao verificar itens restantes da OC (3x)", {
      ordemCompraId,
      error: lastSelErr,
    });
    return { ok: false, error: lastSelErr };
  }

  let newStatus: string;
  if (remainingItems.length === 0) {
    newStatus = "cancelado";
  } else {
    const allRecebido = remainingItems.every((item) => item.compra_status === "recebido");
    const someRecebido = remainingItems.some(
      (item) => Number(item.compra_quantidade_recebida ?? 0) > 0,
    );
    if (allRecebido) {
      newStatus = "recebido";
    } else if (someRecebido) {
      newStatus = "parcialmente_recebido";
    } else {
      return { ok: true }; // OC ainda tem itens não resolvidos, mantém status
    }
  }

  // UPDATE da OC — com retry.
  let lastUpdErr: string | undefined;
  for (let i = 0; i < 3; i++) {
    const { error: updateError } = await supabase
      .from("siso_ordens_compra")
      .update({ status: newStatus })
      .eq("id", ordemCompraId);
    if (!updateError) {
      logger.info(logSource, `OC atualizada para ${newStatus}`, {
        ordemCompraId,
        remainingCount: remainingItems.length,
      });
      return { ok: true };
    }
    lastUpdErr = updateError.message;
    if (i < 2) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  logger.warn(logSource, `Falha ao atualizar OC para ${newStatus} (3x)`, {
    ordemCompraId,
    error: lastUpdErr,
  });
  return { ok: false, error: lastUpdErr };
}
```
  Em `devolver/route.ts`, checar o retorno e surfacear o erro. Substituir a linha 60 (`await cancelOcIfEmpty(...)`) por:
```ts
    const ocResult = await cancelOcIfEmpty(supabase, ordemCompraId, "compras-devolver");
    if (!ocResult.ok) {
      return NextResponse.json(
        { error: "Item devolvido, mas a OC não pôde ser atualizada — tente de novo" },
        { status: 409 },
      );
    }
```
  Os demais callers (`cancelamento/route.ts:67`, `indisponivel/route.ts:60`, `equivalente/route.ts:158`, `pedidos/[pedidoId]/cancelar/route.ts:140`, `reconciliador-oc.ts:202`) já fazem `await cancelOcIfEmpty(...)` sem usar o retorno — continuam tolerantes (o novo retorno é ignorado, sem quebra de tipo).
- [ ] **Step 4 — RODAR e ver passar:** `npm test -- src/lib/__tests__/compras-utils.cancelOcIfEmpty.test.ts`
  Expected: PASS (4 testes). Mais `npm run build` pro typecheck dos callers.
- [ ] **Step 5 — COMMIT:** `git add src/lib/compras-utils.ts src/app/api/wms/compras/itens/[itemId]/devolver/route.ts src/lib/__tests__/compras-utils.cancelOcIfEmpty.test.ts && git commit -m "fix(wms): cancelOcIfEmpty com retry 3x + surfacing do erro na devolução [P048]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: cancelOcIfEmpty-engole-erro
    date: "2026-06-05"
    source: lib/compras-utils
    category: business_logic
    message: "cancelOcIfEmpty engolia erros de banco (logger.warn + return void); a rota /devolver respondia ok mesmo com a OC desatualizada."
    cause: SELECT/UPDATE sem retry; assinatura Promise<void> não propagava falha.
    fix: >
      Retry 3x (backoff) no SELECT e no UPDATE; retorno { ok, error? }; rota /devolver
      surfacea 409 quando ok=false. Demais callers seguem tolerantes (ignoram o retorno).
    files:
      - src/lib/compras-utils.ts
      - src/app/api/wms/compras/itens/[itemId]/devolver/route.ts
    tags: [compras, devolver, retry, durabilidade, surfacing-erro]
```

---

## PR 4: Won't-fix / regressão [P004, P041, P042, P092, P119, P135, P177]

Travar com teste o comportamento atual decidido pelo dono — sem mudança de código de produção. Cada teste documenta a decisão vinculante (won't-fix) pra evitar regressão acidental no futuro.

> **Soft-delete already-fixed (Tasks 4.5-4.7):** P135 (usuário), P177 (localização) e P119 (produto) JÁ são soft-delete no código — o comportamento correto existe hoje. O mestre os reclassifica de "fix" pra **teste de regressão**: travam o soft-delete pra impedir reintrodução de hard-delete. Não seguem RED-first (o Step 2 já PASSA como lock; só FALHA se alguém reintroduzir `.delete()` da linha ou um export `DELETE` de produto).

> Decisões vinculantes (notas): P004 op3 (mercadoria do pedido não muda — deixar como está, contar com acerto de saldo); P041 op1 (cancelar item zera ordem_compra_id — manter unlink); P042 op1 (permite cancelar item já recebido na íntegra); P092 custom (defere estorno no Tiny pra quando a sync marketplace↔WMS existir). Nenhuma muda código de produção.

### Task 4.1: Regressão — aprovação não re-checa composição do pedido [P004]

**Files:**
- Read-only: `src/app/api/wms/pedidos/aprovar/route.ts:495-588`
- Test: `src/app/api/wms/pedidos/__tests__/aprovar-sem-recheck.regress.test.ts`

Won't-fix: a nota diz "mercadoria do pedido não vai mudar — deixar como está". O teste de regressão documenta que `aprovar/route.ts` **não** contém um re-check de composição (guard de re-leitura da origem) — se alguém adicionar um, o teste falha e força revisão da decisão.

- [ ] **Step 1 — RED (na verdade já-verde — trava o comportamento):** criar `src/app/api/wms/pedidos/__tests__/aprovar-sem-recheck.regress.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// [P004] Won't-fix vinculante: a aprovação NÃO re-checa se a composição do
// pedido mudou na origem durante o processamento (decisão do dono: contar com
// a rotina de acerto de saldo). Este teste trava esse comportamento — se
// alguém adicionar um re-check, ele falha e força reabrir a decisão.
const SRC = readFileSync(
  resolve(__dirname, "../route.ts"),
  "utf8",
);

describe("[P004] aprovar não re-checa composição (won't-fix)", () => {
  it("não há marcador de re-check de composição na aprovação", () => {
    expect(SRC).not.toMatch(/re-?check.*composi|recheck_composicao|revalidar_itens_origem/i);
  });
});
```
- [ ] **Step 2 — RODAR e ver passar (lock):** `npm test -- src/app/api/wms/pedidos/__tests__/aprovar-sem-recheck.regress.test.ts`
  Expected: PASS — confirma que o comportamento won't-fix está intacto (sem re-check).
- [ ] **Step 3 — IMPLEMENTAÇÃO:** nenhuma — won't-fix por decisão.
- [ ] **Step 4 — re-rodar:** mesmo comando, PASS.
- [ ] **Step 5 — COMMIT:** `git add src/app/api/wms/pedidos/__tests__/aprovar-sem-recheck.regress.test.ts && git commit -m "test(wms): regressão trava won't-fix — aprovar não re-checa composição [P004]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: aprovar-sem-recheck-composicao-wontfix
    date: "2026-06-05"
    source: wms/pedidos/aprovar
    category: business_logic
    message: "[Won't-fix] Aprovação não re-checa se a composição do pedido mudou na origem — decisão do dono: contar com a rotina de acerto de saldo."
    cause: Decisão de negócio (op3) — 'mercadoria do pedido não vai mudar'.
    fix: Sem mudança de código; teste de regressão trava a ausência do re-check.
    files:
      - src/app/api/wms/pedidos/__tests__/aprovar-sem-recheck.regress.test.ts
    tags: [aprovar, wont-fix, regressao, acerto-saldo]
```

### Task 4.2: Regressão — cancelar item zera ordem_compra_id (unlink mantido) [P041]

**Files:**
- Read-only: `src/app/api/wms/compras/itens/[itemId]/cancelamento/route.ts:54`
- Test: `scripts/wms/cenarios/catalogo/cenario-cancelar-item-unlink.ts`

Won't-fix (op1): manter o unlink (cancelar item zera `ordem_compra_id`). O teste de regressão garante que o comportamento atual persiste.

- [ ] **Step 1 — RED (lock):** criar `scripts/wms/cenarios/catalogo/cenario-cancelar-item-unlink.ts`:
```ts
import type { Cenario, Ctx } from "../_harness/types";

type Setup = { sku: string; itemId: string };

export default {
  nome: "regress P041 — cancelar item zera ordem_compra_id (unlink mantido)",
  descricao:
    "[Won't-fix] cancelar item de compra desvincula a OC (ordem_compra_id=null). " +
    "Trava o comportamento atual decidido pelo dono.",
  tags: ["compras", "cancelamento", "wont-fix", "regressao"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("p041");
    await ctx.criarProduto({ sku, descricao: "Cancelar unlink P041" });
    return { sku, itemId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku: setup.sku, qty: 2 }],
    });
    await ctx.aguardarStatus(id, "pendente", undefined, { timeout_ms: 20000 });
    await ctx.aprovar(id, "oc");
    await ctx.aguardarStatusSeparacao(id, "validacao_oc");
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens").select("id").eq("pedido_id", id).single();
    const itemId = String((itemRow as { id: string }).id);
    setup.itemId = itemId;
    await ctx.http.post("/api/wms/separacao/validar-oc-item", { item_ids: [itemId], acao: "esgotado" });
    await ctx.aguardarStatusSeparacao(id, "aguardando_compra");
    await ctx.comprar({ sku: setup.sku, qty: 2, pedido_id: id });
    await ctx.http.post(`/api/wms/compras/itens/${itemId}/cancelamento`, { motivo: "regress P041" });
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens").select("ordem_compra_id").eq("id", setup.itemId).single();
    if ((item as { ordem_compra_id: string | null }).ordem_compra_id !== null) {
      throw new Error("[P041] cancelar item deveria zerar ordem_compra_id (unlink mantido)");
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })();
}
```
- [ ] **Step 2 — RODAR e ver passar (lock):** `npm run scenarios:only -- cenario-cancelar-item-unlink`
  Expected: PASS — confirma o unlink atual.
- [ ] **Step 3 — IMPLEMENTAÇÃO:** nenhuma — won't-fix.
- [ ] **Step 4 — re-rodar:** PASS.
- [ ] **Step 5 — COMMIT:** `git add scripts/wms/cenarios/catalogo/cenario-cancelar-item-unlink.ts && git commit -m "test(wms): regressão trava won't-fix — cancelar item mantém unlink da OC [P041]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: cancelar-item-unlink-oc-wontfix
    date: "2026-06-05"
    source: wms/compras/cancelamento
    category: business_logic
    message: "[Won't-fix] Cancelar item de compra zera ordem_compra_id (unlink) — decisão do dono (op1) de manter o comportamento atual."
    cause: Decisão de negócio; trade-off do estoque tardio órfão aceito.
    fix: Sem mudança; scenario de regressão trava o unlink.
    files:
      - scripts/wms/cenarios/catalogo/cenario-cancelar-item-unlink.ts
    tags: [compras, cancelamento, unlink, wont-fix, regressao]
```

### Task 4.3: Regressão — permite cancelar item já recebido na íntegra [P042]

**Files:**
- Read-only: `src/app/api/wms/compras/itens/[itemId]/cancelamento/route.ts:33-44`
- Test: `scripts/wms/cenarios/catalogo/cenario-cancelar-item-recebido-permitido.ts`

Won't-fix (op1): permitir cancelar tudo, sem validação (mesmo item já recebido na íntegra). O teste trava que a rota responde 200 (não bloqueia).

- [ ] **Step 1 — RED (lock):** criar `scripts/wms/cenarios/catalogo/cenario-cancelar-item-recebido-permitido.ts`. Cria item com `compra_status='recebido'` e cancela.
```ts
import type { Cenario, Ctx } from "../_harness/types";

type Setup = { itemId: string; statusCancelamento: number };

export default {
  nome: "regress P042 — cancelar item já 'recebido' é permitido (200)",
  descricao:
    "[Won't-fix] cancelar item com compra_status='recebido' NÃO é bloqueado — " +
    "decisão do dono (op1, permissivo). Trava o comportamento atual.",
  tags: ["compras", "cancelamento", "wont-fix", "regressao"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("p042");
    await ctx.criarProduto({ sku, descricao: "Cancelar recebido P042" });
    const pedidoId = `MAN-P042-${Date.now()}`;
    await ctx.sb.from("siso_pedidos").insert({
      id: pedidoId, numero: pedidoId, status: "executando",
      status_separacao: "aguardando_compra",
      empresa_origem_id: ctx.staging.empresas.netair.id,
    });
    const { data: oc } = await ctx.sb
      .from("siso_ordens_compra")
      .insert({ status: "recebido", fornecedor_nome: "F P042" })
      .select("id").single();
    const { data: tinyMap } = await ctx.sb
      .from("siso_produto_empresas").select("tiny_produto_id")
      .eq("empresa_id", ctx.staging.empresas.netair.id).limit(1).maybeSingle();
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .insert({
        pedido_id: pedidoId,
        produto_id: (tinyMap as { tiny_produto_id: string } | null)?.tiny_produto_id ?? "1",
        sku, descricao: "Cancelar recebido P042", quantidade: 2,
        compra_status: "recebido",
        ordem_compra_id: (oc as { id: string }).id,
      })
      .select("id").single();
    return { itemId: String((item as { id: string }).id), statusCancelamento: 0 };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const r = await ctx.http.post(`/api/wms/compras/itens/${setup.itemId}/cancelamento`, {
      motivo: "regress P042",
    });
    setup.statusCancelamento = r.status;
  },

  assertEsperado: async (_ctx: Ctx, setup: Setup): Promise<void> => {
    if (setup.statusCancelamento !== 200) {
      throw new Error(
        `[P042] cancelar item recebido deveria ser permitido (200), veio ${setup.statusCancelamento}`,
      );
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })();
}
```
  > Nota: confirmar colunas obrigatórias de `siso_ordens_compra` (`fornecedor_nome` ou equivalente) e de `siso_pedido_itens` (`produto_id` é tiny_produto_id — gotcha #1) no schema antes de rodar; ajustar os inserts. Se montar o item via insert direto for frágil, alternativa: usar o fluxo `comprar()` + `receberCompra()` do harness pra chegar a `compra_status='recebido'`.
- [ ] **Step 2 — RODAR e ver passar (lock):** `npm run scenarios:only -- cenario-cancelar-item-recebido-permitido`
  Expected: PASS — confirma 200 (permissivo).
- [ ] **Step 3 — IMPLEMENTAÇÃO:** nenhuma — won't-fix.
- [ ] **Step 4 — re-rodar:** PASS.
- [ ] **Step 5 — COMMIT:** `git add scripts/wms/cenarios/catalogo/cenario-cancelar-item-recebido-permitido.ts && git commit -m "test(wms): regressão trava won't-fix — permite cancelar item já recebido [P042]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: cancelar-item-recebido-permitido-wontfix
    date: "2026-06-05"
    source: wms/compras/cancelamento
    category: business_logic
    message: "[Won't-fix] Cancelar item já recebido na íntegra é permitido (sem validação) — decisão do dono (op1, permissivo)."
    cause: Decisão de negócio; risco de contagem divergente aceito explicitamente.
    fix: Sem mudança; scenario de regressão trava o 200.
    files:
      - scripts/wms/cenarios/catalogo/cenario-cancelar-item-recebido-permitido.ts
    tags: [compras, cancelamento, wont-fix, regressao]
```

### Task 4.4: Regressão — cancelamento não estorna saldo no Tiny (defer sync) [P092]

**Files:**
- Read-only: `src/app/api/wms/webhook/tiny/route.ts:191-245`
- Test: `src/app/api/wms/webhook/__tests__/cancelamento-nao-estorna-tiny.regress.test.ts`

Won't-fix custom: deferir o estorno no Tiny pra quando a sync marketplace↔WMS existir. O teste trava que o cancelamento via webhook **não** chama um ajuste de estoque no Tiny (libera só as Rs locais).

- [ ] **Step 1 — RED (lock):** criar `src/app/api/wms/webhook/__tests__/cancelamento-nao-estorna-tiny.regress.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// [P092] Won't-fix custom vinculante: cancelamento via webhook libera só as
// reservas locais; NÃO estorna saldo no Tiny (defer pra quando a sync
// marketplace<->WMS existir). Este teste trava a ausência de um ajuste de
// estoque no Tiny no caminho de cancelamento.
const SRC = readFileSync(resolve(__dirname, "../tiny/route.ts"), "utf8");

describe("[P092] cancelamento não estorna no Tiny (won't-fix/defer)", () => {
  it("não há chamada de ajuste de estoque no Tiny no caminho de cancelamento", () => {
    expect(SRC).not.toMatch(/ajustarEstoqueTiny|atualizarEstoqueTiny|tiny.*stock.*ajustar/i);
  });
});
```
- [ ] **Step 2 — RODAR e ver passar (lock):** `npm test -- src/app/api/wms/webhook/__tests__/cancelamento-nao-estorna-tiny.regress.test.ts`
  Expected: PASS — confirma o defer (sem estorno no Tiny).
- [ ] **Step 3 — IMPLEMENTAÇÃO:** nenhuma — defer por decisão custom.
- [ ] **Step 4 — re-rodar:** PASS.
- [ ] **Step 5 — COMMIT:** `git add src/app/api/wms/webhook/__tests__/cancelamento-nao-estorna-tiny.regress.test.ts && git commit -m "test(wms): regressão trava defer — cancelamento não estorna no Tiny (aguarda sync marketplace) [P092]"`
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: cancelamento-nao-estorna-tiny-defer
    date: "2026-06-05"
    source: wms/webhook/tiny
    category: business_logic
    message: "[Defer] Cancelamento de pedido libera só as reservas locais; não estorna saldo no Tiny — resolver quando a sync marketplace<->WMS existir."
    cause: Decisão custom do dono; Tiny é só camada fiscal, efeito minimizado.
    fix: Sem mudança; teste de regressão trava a ausência do ajuste de estoque no Tiny.
    files:
      - src/app/api/wms/webhook/__tests__/cancelamento-nao-estorna-tiny.regress.test.ts
    tags: [webhook, cancelamento, tiny, defer, wont-fix]
```

### Task 4.5: Regressão — DELETE de usuário é soft-delete (preserva auditoria) [P135]

**Files:**
- Read-only: `src/app/api/wms/admin/usuarios/route.ts:215-260` (handler `DELETE`)
- Test (Create): `test/integration/usuario-soft-delete.regress.test.ts`

Already-fixed: o `DELETE /api/admin/usuarios?id=<uuid>` JÁ é soft-delete — marca `ativo=false`, renomeia o nome com sufixo `_excluido_<epoch>` (libera o `UNIQUE(nome)`) e remove só os vínculos de `siso_usuario_galpoes`. Não há `.delete()` da linha de `siso_usuarios` (`usuario_id` é FK sem `ON DELETE` em `siso_movimentacoes`/inventário/pedidos — hard-delete quebraria). É **idempotente** (2º DELETE não re-renomeia). Este teste trava o soft-delete: se alguém trocar por `.delete()`, a linha some e o assert de "linha ainda existe (ativo=false)" falha. Harness escolhido: **integration** (assert do estado real da linha no staging — o auth-matrix runner só checa status HTTP, não distingue soft de hard).

- [ ] **Step 1 — Lock (já-verde):** criar `test/integration/usuario-soft-delete.regress.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createServiceClient } from "../../src/lib/supabase-server";
import { DELETE } from "../../src/app/api/wms/admin/usuarios/route";

const sb = createServiceClient();

// [P135] Already-fixed → regressão vinculante: DELETE de usuário é SOFT-delete
// (ativo=false + rename pra liberar UNIQUE(nome)), nunca hard-delete (FK
// usuario_id em siso_movimentacoes etc. sem ON DELETE). Trava o comportamento:
// se alguém trocar por .delete(), a linha some e o 1º assert falha.
async function adminSessionId(): Promise<string> {
  // Sessão de um admin (permissão sistema.usuarios) pra passar requireAuth/userCan.
  const { data: admin } = await sb
    .from("siso_usuarios")
    .insert({ nome: `regress-admin-p135-${Date.now()}`, pin: "9135", cargo: "admin", ativo: true })
    .select("id")
    .single();
  const { data: role } = await sb.from("siso_roles").select("id").eq("codigo", "admin").single();
  await sb.from("siso_usuario_roles").upsert(
    { usuario_id: (admin as { id: string }).id, role_id: (role as { id: string }).id },
    { onConflict: "usuario_id,role_id" },
  );
  const { data: sess } = await sb
    .from("siso_sessoes")
    .insert({ usuario_id: (admin as { id: string }).id })
    .select("id")
    .single();
  return (sess as { id: string }).id;
}

describe("[P135] DELETE de usuário é soft-delete (regressão)", () => {
  it("soft-delete: a linha PERMANECE com ativo=false e nome renomeado", async () => {
    const sessionId = await adminSessionId();
    const nome = `regress-alvo-p135-${Date.now()}`;
    const { data: alvo } = await sb
      .from("siso_usuarios")
      .insert({ nome, pin: "1135", cargo: "operador", ativo: true })
      .select("id")
      .single();
    const alvoId = (alvo as { id: string }).id;

    const req = new NextRequest(
      `http://localhost/api/wms/admin/usuarios?id=${alvoId}`,
      { method: "DELETE", headers: { "X-Session-Id": sessionId } },
    );
    const res = await DELETE(req);
    expect(res.status).toBe(200);

    // Soft-delete: a linha NÃO sumiu (hard-delete deixaria row=null).
    const { data: row } = await sb
      .from("siso_usuarios")
      .select("id, nome, ativo")
      .eq("id", alvoId)
      .maybeSingle();
    expect(row).not.toBeNull();
    expect((row as { ativo: boolean }).ativo).toBe(false);
    expect((row as { nome: string }).nome).toContain("_excluido_");
  });

  it("idempotente: 2º DELETE mantém soft-deleted (não 500)", async () => {
    const sessionId = await adminSessionId();
    const nome = `regress-idem-p135-${Date.now()}`;
    const { data: alvo } = await sb
      .from("siso_usuarios")
      .insert({ nome, pin: "1136", cargo: "operador", ativo: true })
      .select("id")
      .single();
    const alvoId = (alvo as { id: string }).id;
    const mk = () =>
      new NextRequest(`http://localhost/api/wms/admin/usuarios?id=${alvoId}`, {
        method: "DELETE",
        headers: { "X-Session-Id": sessionId },
      });

    expect((await DELETE(mk())).status).toBe(200);
    expect((await DELETE(mk())).status).toBe(200);

    const { data: row } = await sb
      .from("siso_usuarios")
      .select("nome, ativo")
      .eq("id", alvoId)
      .single();
    expect((row as { ativo: boolean }).ativo).toBe(false);
    // Idempotente: o sufixo _excluido_ não foi duplicado.
    const ocorrencias = ((row as { nome: string }).nome.match(/_excluido_/g) ?? []).length;
    expect(ocorrencias).toBe(1);
  });
});
```
- [ ] **Step 2 — RODAR e ver PASSAR (lock):** `npm run test:integration -- test/integration/usuario-soft-delete.regress.test.ts`
  Expected: PASS (lock) — a linha permanece com `ativo=false` + nome renomeado, e o 2º DELETE é idempotente. (Se FALHAR com `row` nulo, alguém reintroduziu hard-delete de usuário.)
- [ ] **Step 3 — IMPLEMENTAÇÃO:** nenhuma — comportamento já existe (soft-delete na rota).
- [ ] **Step 4 — re-rodar:** mesmo comando, PASS.
- [ ] **Step 5 — COMMIT:** `git add test/integration/usuario-soft-delete.regress.test.ts && git commit -m "test(wms): regressão trava soft-delete de usuário (preserva auditoria, não hard-delete) [P135]"`

  Mensagem termina com:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: usuario-delete-soft-delete-regress
    date: "2026-06-05"
    source: wms/admin/usuarios
    category: business_logic
    message: "[Regressão] DELETE de usuário é soft-delete (ativo=false + rename pra liberar UNIQUE(nome)); hard-delete quebraria FKs de auditoria (usuario_id em siso_movimentacoes/inventário/pedidos, sem ON DELETE)."
    cause: Comportamento já correto no código; faltava teste travando contra reintrodução de hard-delete.
    fix: Teste de integração que confirma que a linha permanece (ativo=false, nome renomeado) e que o 2º DELETE é idempotente.
    files:
      - src/app/api/wms/admin/usuarios/route.ts
      - test/integration/usuario-soft-delete.regress.test.ts
    tags: [usuarios, soft-delete, auditoria, regressao, already-fixed]
```

### Task 4.6: Regressão — desativar localização é soft-delete (mantém contagem prévia) [P177]

**Files:**
- Read-only: `src/lib/wms/localizacoes.ts:121-133` (`desativarLocalizacao`), `src/app/api/wms/localizacoes/[id]/route.ts:71` (caller `DELETE`)
- Test (Create): `test/integration/localizacao-soft-delete.regress.test.ts`

Already-fixed: `desativarLocalizacao(id)` faz `update({ ativo: false })` — **não** `.delete()` da linha. A linha persistir (`ativo=false`) é o que mantém a localização referenciável por `wms_produto_ultimas_contagens` (histórico de contagem prévia retornável). Há também o guard "tem saldo → não desativa". Este teste trava o soft-delete: se virar `.delete()`, a linha some e o assert de "linha ainda existe (ativo=false)" falha. Harness escolhido: **integration** (`desativarLocalizacao` chama `createServiceClient()` → não roda em unit happy-dom; o assert é do estado real da linha no staging).

- [ ] **Step 1 — Lock (já-verde):** criar `test/integration/localizacao-soft-delete.regress.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { criarLocalizacao, desativarLocalizacao } from "../../src/lib/wms/localizacoes";

const sb = createServiceClient();

// [P177] Already-fixed → regressão vinculante: desativarLocalizacao faz
// update({ativo:false}), NÃO deleta a linha. A linha permanecer é o que mantém
// a contagem prévia retornável por wms_produto_ultimas_contagens. Trava: se
// virar .delete(), a linha some e o assert "linha ainda existe" falha.
describe("[P177] desativar localização é soft-delete (regressão)", () => {
  it("soft-delete: a linha PERMANECE com ativo=false (não some)", async () => {
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const galpaoId = (g as { id: string }).id;
    const loc = await criarLocalizacao({
      galpao_id: galpaoId,
      codigo: `REGRESS-P177-${Date.now()}`,
      tipo: "picking",
    });

    await desativarLocalizacao(loc.id);

    const { data: row } = await sb
      .from("siso_localizacoes")
      .select("id, ativo")
      .eq("id", loc.id)
      .maybeSingle();
    // Hard-delete deixaria row=null; soft-delete mantém a linha desativada.
    expect(row).not.toBeNull();
    expect((row as { ativo: boolean }).ativo).toBe(false);
  });

  it("guard preservado: localização com saldo NÃO é desativável", async () => {
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const galpaoId = (g as { id: string }).id;
    const { data: prod } = await sb
      .from("siso_produtos")
      .insert({ sku: `REGRESS-P177-PROD-${Date.now()}`, descricao: "loc com saldo", ativo: true })
      .select("id")
      .single();
    const loc = await criarLocalizacao({
      galpao_id: galpaoId,
      codigo: `REGRESS-P177-SALDO-${Date.now()}`,
      tipo: "picking",
    });
    await sb.from("siso_estoque").insert({
      produto_id: (prod as { id: string }).id,
      galpao_id: galpaoId,
      localizacao_id: loc.id,
      saldo: 3,
      reservado: 0,
    });

    await expect(desativarLocalizacao(loc.id)).rejects.toThrow(/saldo/i);

    // Com o guard barrando, a linha continua ATIVA (intacta).
    const { data: row } = await sb
      .from("siso_localizacoes")
      .select("ativo")
      .eq("id", loc.id)
      .single();
    expect((row as { ativo: boolean }).ativo).toBe(true);
  });
});
```
- [ ] **Step 2 — RODAR e ver PASSAR (lock):** `npm run test:integration -- test/integration/localizacao-soft-delete.regress.test.ts`
  Expected: PASS (lock) — a linha permanece com `ativo=false`; o guard de saldo continua barrando. (Se FALHAR com `row` nulo, alguém trocou o `update({ativo:false})` por `.delete()`.)
- [ ] **Step 3 — IMPLEMENTAÇÃO:** nenhuma — comportamento já existe (`desativarLocalizacao` faz update).
- [ ] **Step 4 — re-rodar:** mesmo comando, PASS.
- [ ] **Step 5 — COMMIT:** `git add test/integration/localizacao-soft-delete.regress.test.ts && git commit -m "test(wms): regressão trava soft-delete de localização (mantém contagem prévia, não hard-delete) [P177]"`

  Mensagem termina com:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: localizacao-desativar-soft-delete-regress
    date: "2026-06-05"
    source: wms/localizacoes
    category: business_logic
    message: "[Regressão] desativarLocalizacao faz update({ativo:false}), nunca .delete() — a linha permanecer (ativo=false) é o que mantém a contagem prévia retornável por wms_produto_ultimas_contagens."
    cause: Comportamento já correto no código; faltava teste travando contra reintrodução de hard-delete da localização.
    fix: Teste de integração que confirma que a linha permanece desativada (ativo=false) e que o guard de saldo segue barrando.
    files:
      - src/lib/wms/localizacoes.ts
      - src/app/api/wms/localizacoes/[id]/route.ts
      - test/integration/localizacao-soft-delete.regress.test.ts
    tags: [localizacoes, soft-delete, contagem, regressao, already-fixed]
```

### Task 4.7: Regressão — rota de produto não exporta DELETE (sem hard-delete) [P119]

**Files:**
- Read-only: `src/app/api/wms/produtos/[id]/route.ts` (exporta só `GET` + `PATCH`)
- Test (Create): `src/app/api/wms/produtos/[id]/__tests__/produto-sem-delete.regress.test.ts`

Already-fixed: a rota `produtos/[id]` exporta **só** `GET` e `PATCH` — **não existe** `DELETE` (não há hard-delete de produto). A desativação é via `PATCH { ativo: false }`. Este teste importa o módulo da rota e trava que o export `DELETE` é `undefined`: se alguém adicionar uma rota `DELETE` (hard-delete), o assert falha e força reabrir a decisão. Harness escolhido: **unit** (`npm test`, happy-dom) — assert puro de export do módulo, sem banco.

- [ ] **Step 1 — Lock (já-verde):** criar `src/app/api/wms/produtos/[id]/__tests__/produto-sem-delete.regress.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import * as produtoRoute from "../route";

// [P119] Already-fixed → regressão vinculante: a rota produtos/[id] exporta só
// GET + PATCH. NÃO existe DELETE (hard-delete de produto). A desativação é via
// PATCH { ativo: false }. Trava: se alguém exportar um DELETE, o assert falha.
describe("[P119] produtos/[id] não exporta DELETE (regressão)", () => {
  it("o módulo da rota NÃO tem export DELETE (sem hard-delete)", () => {
    expect((produtoRoute as Record<string, unknown>).DELETE).toBeUndefined();
  });

  it("os verbos suportados são exatamente GET + PATCH", () => {
    const verbos = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter(
      (v) => typeof (produtoRoute as Record<string, unknown>)[v] === "function",
    );
    expect(verbos.sort()).toEqual(["GET", "PATCH"]);
  });
});
```
- [ ] **Step 2 — RODAR e ver PASSAR (lock):** `npm test -- src/app/api/wms/produtos/[id]/__tests__/produto-sem-delete.regress.test.ts`
  Expected: PASS (lock) — `DELETE` é `undefined`; verbos exatamente `GET` + `PATCH`. (Se FALHAR, alguém adicionou um handler `DELETE` à rota de produto — hard-delete.)
- [ ] **Step 3 — IMPLEMENTAÇÃO:** nenhuma — comportamento já existe (rota sem DELETE; desativa via PATCH).
- [ ] **Step 4 — re-rodar:** mesmo comando, PASS.
- [ ] **Step 5 — COMMIT:** `git add "src/app/api/wms/produtos/[id]/__tests__/produto-sem-delete.regress.test.ts" && git commit -m "test(wms): regressão trava ausência de DELETE em produtos/[id] (sem hard-delete, desativa via PATCH) [P119]"`

  Mensagem termina com:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- [ ] **Step 6 — erros-conhecidos.yaml:**
```yaml
  - id: produto-sem-delete-regress
    date: "2026-06-05"
    source: wms/produtos
    category: business_logic
    message: "[Regressão] A rota produtos/[id] exporta só GET + PATCH; não há DELETE (hard-delete de produto). Desativação é via PATCH { ativo: false }."
    cause: Comportamento já correto no código; faltava teste travando contra reintrodução de um handler DELETE (hard-delete).
    fix: Teste unit que importa o módulo da rota e asserta que o export DELETE é undefined (verbos = GET + PATCH).
    files:
      - src/app/api/wms/produtos/[id]/route.ts
      - src/app/api/wms/produtos/[id]/__tests__/produto-sem-delete.regress.test.ts
    tags: [produtos, soft-delete, hard-delete, regressao, already-fixed]
```

---

## Verificação final da fase 6g

- [ ] Rodar a suíte completa: `npm test` (unit) + `npm run test:integration` (RPC/banco vs staging) + `npm run scenarios` (E2E HTTP).
- [ ] `npm run lint` + `npm run build` (typecheck strict) limpos.
- [ ] Confirmar que as 3 migrations foram aplicadas no project `ehbxpbeijofxtsbezwxd` (`20260605_retroativo_idempotency`, `20260605_produto_audit_log`, `20260605_inventario_contagem_kit_audit`).
- [ ] `docs/database-schema.md` atualizado (novas colunas `siso_movimentacoes.idempotency_key`, `siso_inventario_contagens.eh_kit_bipado`, nova tabela `siso_produto_audit`); `docs/api-reference-complete.md` atualizado (PATCH divergencias aceita `acao='reabrir'`; insights/pessoas payload semântico; devolver 409). Mesmo commit que as mudanças.
- [ ] Os 3 testes de regressão de soft-delete passam como lock (already-fixed, sem mudança de produção): `usuario-soft-delete.regress` [P135] + `localizacao-soft-delete.regress` [P177] (integration) e `produto-sem-delete.regress` [P119] (unit).
- [ ] Todas as entradas de `erros-conhecidos.yaml` adicionadas.
