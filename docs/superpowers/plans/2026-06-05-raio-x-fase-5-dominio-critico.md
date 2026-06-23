# Raio-X Fase 5 — Domínio Crítico (Ledger Central, Cutover, Vendas, Pick Parcial, Durabilidade) Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal:** Tornar atômicas (tudo-ou-nada) as operações de maior blast-radius do WMS — aplicar inventário, pick parcial de wave, desmarcar item, reversão de cutover, venda baixa-direta + cancelamento, enqueue da aprovação, reconciliação de lançamento retroativo — e dar durabilidade (retry/fila) ao reconciliador OC e à varredura pós-entrada, mais a resolução de pedido-fantasma (R viva sem saída). Todas essas operações hoje são sequências de chamadas independentes em JS contra `supabase-js` (que **não tem transação multi-statement**); uma queda no meio deixa o ledger parcialmente mutado e o status do pedido incoerente.

**Architecture:** Cada operação multi-mov vira **uma RPC plpgsql transacional** (primitiva B do mestre): `SELECT ... FOR UPDATE` da row-âncora → chama `wms_inserir_movimentacao` N vezes + os `UPDATE` de status na **mesma** transação → `RAISE` em qualquer falha rola back tudo. O TS vira wrapper fino `.rpc()`. Idempotência por lookup de estorno (`estorno_de`) ou por `idempotency_key` UNIQUE. Durabilidade via `siso_fila_execucao` (job durável com backoff custom 30s/5min/10min). Tudo espelha as RPCs já vivas: `wms_inserir_movimentacao` (único write do ledger), `wms_pick_item_atomico`, `wms_confirmar_guarda_atomico`.

**Tech Stack:** Next.js 16 (App Router) · TypeScript strict · Supabase Postgres (plpgsql RPC, service role bypass RLS) · vitest (unit happy-dom + integration serializado contra staging `ehbxpbeijofxtsbezwxd`) · scenarios E2E HTTP (`scripts/wms/cenarios/catalogo/`). Migrations: `supabase/migrations/YYYYMMDD_descricao.sql` aplicadas via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`.

**Decisões vinculantes (do mestre + notas do dono):**
- **D4 (P014/P015):** Estorno tolerante vence — clamp da R ao saldo livre + `status_alerta`, tudo na mesma tx atômica. `respeita_nota=false` de P015 é aceitável.
- **P082:** retry 30s → 5min → 10min (NÃO 1h, mesmo a opção 2 dizendo "1h" — a nota textual manda 10min) + alerta visível após esgotar.
- **P084:** ao detectar pedido embalado com R viva sem saída: gerente confere; (saiu) converte R→S; (cancelado) devolve à prateleira.
- **P147:** estorno parcial — avisar saldo disponível e estornar só o que tem.
- **P152:** cadeado de banco serializa por lançamento (advisory lock).

**Gotchas honrados:** `siso_pedidos.id` é **text** → `pedido_id`/`origem_id` em movs são text. `siso_pedido_itens.produto_id` é **tiny_produto_id** (não uuid WMS). `wms_inserir_movimentacao` é o único write do ledger. `siso_fila_execucao` tem CHECKs legados `chk_fila_tipo` (só `lancar_estoque`,`lancar_estoque_pos_nf`), `chk_fila_filial IN ('CWB','SP')` e `chk_fila_decisao IN ('propria','transferencia','oc')` + `pedido_id NOT NULL` + `filial_execucao NOT NULL` + `decisao NOT NULL` — jobs novos (PR8) precisam relaxar esses CHECKs.

**Ordem dos PRs:** quick wins / sem-dep primeiro. PR7 depende internamente (P150→P152→P147→P148); PR8 depende de P145 (Fase 1, já entregue). Cada bug-fix ganha entrada em `erros-conhecidos.yaml`.

---

## PR 1: RPC `wms_aplicar_sessao_inventario` (aplicar tudo-ou-nada) [P060]

> **Contexto (lido de `src/lib/wms/inventario.ts:973-1103`):** `aplicarSessao` itera as divergências `status='aprovada'` e chama `inserirMovimentacao` (uma RPC por divergência) num loop JS. Falha no meio deixa parte aplicada — não há tudo-ou-nada. Já há branch de idempotência (`status='aplicada'` conta movs existentes) que precisa ser preservado. Ganho (`E`) carrega `custo_unitario` = custo médio atual; perda (`S`) não. Origens são `inventario_ganho`/`inventario_perda`. Há um UNIQUE `uniq_movs_inventario_divergencia` por divergência.

### Task 1.1: Migration — RPC `wms_aplicar_sessao_inventario`

**Files:**
- Create: `supabase/migrations/20260607_rpc_aplicar_sessao_inventario.sql`
- Test: `test/integration/aplicar-sessao-inventario-rpc.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/aplicar-sessao-inventario-rpc.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let galpaoId: string;
let locId: string;
let prodOk: string;
let prodFail: string;
let userId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  userId = u!.id;
  const mk = async (sku: string) => {
    const { data } = await sb.from("siso_produtos").insert({ sku, descricao: sku, ativo: true }).select("id").single();
    return data!.id as string;
  };
  prodOk = await mk(`TEST-APL-OK-${Date.now()}`);
  prodFail = await mk(`TEST-APL-FAIL-${Date.now()}`);
});

async function criarSessaoComDivergencias(divs: Array<{ produto_id: string; delta: number }>) {
  const { data: sess } = await sb
    .from("siso_inventario_sessoes")
    .insert({
      galpao_id: galpaoId, tipo: "cycle_count", modo_contagem: "blind",
      status: "aprovada", tamanho_pool: divs.length, criada_por: userId,
    })
    .select("id").single();
  for (const d of divs) {
    await sb.from("siso_inventario_divergencias").insert({
      sessao_id: sess!.id, produto_id: d.produto_id, localizacao_id: locId,
      delta: d.delta, status: "aprovada",
    });
  }
  return sess!.id as string;
}

describe("wms_aplicar_sessao_inventario", () => {
  it("aplica todas as divergências tudo-ou-nada e transiciona sessão→'aplicada'", async () => {
    const sessaoId = await criarSessaoComDivergencias([{ produto_id: prodOk, delta: 7 }]);
    const { data, error } = await sb.rpc("wms_aplicar_sessao_inventario", {
      p_sessao: sessaoId, p_usuario: userId,
    });
    expect(error).toBeNull();
    expect((data as { movs_geradas: number }).movs_geradas).toBe(1);
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodOk).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(7);
    const { data: s2 } = await sb.from("siso_inventario_sessoes").select("status").eq("id", sessaoId).single();
    expect((s2 as { status: string }).status).toBe("aplicada");
  });

  it("aborta sem aplicar nada se uma divergência ficaria inviável (perda > saldo)", async () => {
    // prodFail tem saldo 0 → perda de 5 é inviável (saldo insuficiente). Junto com um ganho viável.
    const sessaoId = await criarSessaoComDivergencias([
      { produto_id: prodOk, delta: 3 },     // viável
      { produto_id: prodFail, delta: -5 },  // inviável (saldo 0)
    ]);
    const saldoOkAntes = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodOk).eq("galpao_id", galpaoId).eq("localizacao_id", locId).maybeSingle();
    const { error } = await sb.rpc("wms_aplicar_sessao_inventario", { p_sessao: sessaoId, p_usuario: userId });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/saldo|insuficiente|inviável/i);
    // rollback total: ganho do prodOk NÃO foi aplicado
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodOk).eq("galpao_id", galpaoId).eq("localizacao_id", locId).maybeSingle();
    expect(Number(est?.saldo ?? 0)).toBe(Number(saldoOkAntes.data?.saldo ?? 0));
    const { data: s2 } = await sb.from("siso_inventario_sessoes").select("status").eq("id", sessaoId).single();
    expect((s2 as { status: string }).status).toBe("aprovada"); // não transicionou
  });

  it("idempotente: 2ª chamada em sessão já 'aplicada' retorna movs existentes sem duplicar", async () => {
    const sessaoId = await criarSessaoComDivergencias([{ produto_id: prodOk, delta: 2 }]);
    const r1 = await sb.rpc("wms_aplicar_sessao_inventario", { p_sessao: sessaoId, p_usuario: userId });
    expect(r1.error).toBeNull();
    const r2 = await sb.rpc("wms_aplicar_sessao_inventario", { p_sessao: sessaoId, p_usuario: userId });
    expect(r2.error).toBeNull();
    expect((r2.data as { movs_geradas: number }).movs_geradas).toBe((r1.data as { movs_geradas: number }).movs_geradas);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- aplicar-sessao-inventario-rpc`. Expected: FAIL com `could not find function public.wms_aplicar_sessao_inventario` (RPC não existe).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607_rpc_aplicar_sessao_inventario.sql`:

```sql
-- Fase 5 (P060) — RPC wms_aplicar_sessao_inventario: aplica todas as
-- divergências aprovadas de uma sessão de inventário TUDO-OU-NADA. Num único
-- BEGIN: itera divergências status='aprovada', gera mov E (ganho, com custo
-- médio atual como custo_unitario) ou S (perda) via wms_inserir_movimentacao,
-- marca divergência 'aplicada'+mov_aplicada_id, e transiciona sessão→'aplicada'.
-- Qualquer RAISE (ex.: saldo insuficiente numa perda) faz rollback TOTAL —
-- nenhuma mov persiste, sessão fica 'aprovada'. Idempotente p/ sessão já
-- 'aplicada' (conta movs existentes, no-op). Espelha o loop TS de
-- src/lib/wms/inventario.ts:973-1103 movendo a atomicidade pro banco.
CREATE OR REPLACE FUNCTION public.wms_aplicar_sessao_inventario(
  p_sessao uuid,
  p_usuario uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_status      text;
  v_galpao      uuid;
  v_div         RECORD;
  v_tipo        char(1);
  v_qty         numeric;
  v_custo       numeric;
  v_mov_id      uuid;
  v_count       integer := 0;
BEGIN
  -- Lock pessimista da sessão — serializa duas aplicações concorrentes.
  SELECT status, galpao_id INTO v_status, v_galpao
    FROM siso_inventario_sessoes
   WHERE id = p_sessao
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sessão % não encontrada', p_sessao USING ERRCODE = 'P0002';
  END IF;

  -- Idempotência: já aplicada → conta movs existentes, no-op.
  IF v_status = 'aplicada' THEN
    SELECT count(*) INTO v_count
      FROM siso_movimentacoes
     WHERE origem_id = p_sessao::text
       AND origem_tipo IN ('inventario_ganho', 'inventario_perda');
    RETURN jsonb_build_object('movs_geradas', v_count, 'idempotente', true);
  END IF;

  IF v_status <> 'aprovada' THEN
    RAISE EXCEPTION 'sessão % não está aprovada (status=%)', p_sessao, v_status USING ERRCODE = '22023';
  END IF;

  FOR v_div IN
    SELECT id, produto_id, localizacao_id, delta, delta_pct
      FROM siso_inventario_divergencias
     WHERE sessao_id = p_sessao
       AND status = 'aprovada'
     ORDER BY id
  LOOP
    IF v_div.delta = 0 THEN CONTINUE; END IF;
    v_tipo := CASE WHEN v_div.delta > 0 THEN 'E' ELSE 'S' END;
    v_qty  := abs(v_div.delta);

    -- Ganho carrega custo médio atual (preserva valor do entrante no ledger).
    v_custo := NULL;
    IF v_tipo = 'E' THEN
      SELECT custo_medio INTO v_custo FROM siso_custo_medio WHERE produto_id = v_div.produto_id;
    END IF;

    -- wms_inserir_movimentacao valida saldo (perda > saldo → RAISE → rollback total).
    SELECT wms_inserir_movimentacao(
      p_produto_id := v_div.produto_id,
      p_galpao_id := v_galpao,
      p_localizacao_id := v_div.localizacao_id,
      p_tipo := v_tipo,
      p_quantidade := v_qty,
      p_origem_tipo := CASE WHEN v_tipo = 'E' THEN 'inventario_ganho' ELSE 'inventario_perda' END,
      p_origem_id := p_sessao::text,
      p_origem_detalhes := jsonb_build_object('divergencia_id', v_div.id, 'delta_pct', v_div.delta_pct),
      p_custo_unitario := v_custo,
      p_usuario_id := p_usuario,
      p_motivo := 'inventário sessão ' || p_sessao::text
    ) INTO v_mov_id;

    UPDATE siso_inventario_divergencias
       SET status = 'aplicada', mov_aplicada_id = v_mov_id
     WHERE id = v_div.id;
    v_count := v_count + 1;
  END LOOP;

  -- Libera locks externos da sessão (idempotente).
  UPDATE siso_localizacao_locks
     SET finalizado_em = now()
   WHERE finalizado_em IS NULL
     AND localizacao_id IN (
       SELECT localizacao_id FROM siso_inventario_localizacoes WHERE sessao_id = p_sessao
     );

  UPDATE siso_inventario_sessoes
     SET status = 'aplicada', aplicada_em = now()
   WHERE id = p_sessao;

  RETURN jsonb_build_object('movs_geradas', v_count, 'idempotente', false);
END;
$function$;
```

Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (name: `rpc_aplicar_sessao_inventario`).

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- aplicar-sessao-inventario-rpc`. Expected: PASS (3 testes).

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260607_rpc_aplicar_sessao_inventario.sql test/integration/aplicar-sessao-inventario-rpc.test.ts && git commit -m "feat(wms): RPC wms_aplicar_sessao_inventario — aplica divergências tudo-ou-nada (P060)"`

### Task 1.2: Wrapper TS `aplicarSessao` chama a RPC

**Files:**
- Modify: `src/lib/wms/inventario.ts:973-1103`
- Modify: `src/app/api/wms/inventario/[id]/aplicar/route.ts:19-28`

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Estender `test/integration/aplicar-sessao-inventario-rpc.test.ts` com um bloco que exercita o wrapper TS (não a RPC direto). O 1º caso é equivalência (não-regressão); o 2º caso é o **RED determinístico**: rollback total quando uma divergência é inviável — o loop TS antigo aplica o ganho do `prodOk` ANTES de falhar no `prodFail`, deixando a sessão num estado parcial (a 1ª mov persiste, a sessão não rola back), violando os dois asserts:

```typescript
import { aplicarSessao } from "../../src/lib/wms/inventario";

describe("aplicarSessao (wrapper TS → RPC)", () => {
  it("delega à RPC e retorna { movsGeradas }", async () => {
    const sessaoId = await criarSessaoComDivergencias([{ produto_id: prodOk, delta: 4 }]);
    const r = await aplicarSessao(sessaoId, userId);
    expect(r.movsGeradas).toBe(1);
    const { data: s2 } = await sb.from("siso_inventario_sessoes").select("status").eq("id", sessaoId).single();
    expect((s2 as { status: string }).status).toBe("aplicada");
  });

  // RED DETERMINÍSTICO: rollback total quando uma divergência é inviável.
  it("wrapper: rollback total quando uma divergência é inviável", async () => {
    const sessaoId = await criarSessaoComDivergencias([
      { produto_id: prodOk, delta: 6 },     // ganho viável (aplicado 1º pelo loop antigo)
      { produto_id: prodFail, delta: -9 },  // perda inviável (prodFail saldo 0)
    ]);
    // RPC nova: RAISE → wrapper rejeita E nenhuma mov do prodOk persiste.
    await expect(aplicarSessao(sessaoId, userId)).rejects.toThrow(/saldo|insuficiente|inviável/i);
    const { data: s2 } = await sb.from("siso_inventario_sessoes").select("status").eq("id", sessaoId).single();
    expect((s2 as { status: string }).status).toBe("aprovada"); // NÃO transicionou
    // E nenhuma mov de ganho do prodOk ficou para trás (rollback total).
    const { data: movs } = await sb.from("siso_movimentacoes").select("id")
      .eq("origem_id", sessaoId).eq("origem_tipo", "inventario_ganho");
    expect((movs ?? []).length).toBe(0);
  });
});
```

> Nota: divergência do achado — `aplicarSessao` antigo já tinha guard de idempotência via UNIQUE 23505, então o caso de duplicação NÃO é o RED desta task. O RED estrito é o **rollback total** acima, que o loop TS antigo NÃO garante (aplica o ganho do `prodOk`, depois falha no `prodFail`, sem desfazer o ganho).

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- aplicar-sessao-inventario-rpc`. Expected: o 1º caso (equivalência) passa contra o código antigo; o 2º caso (rollback total) **FALHA** — o loop TS antigo aplicou o ganho do `prodOk` (mov `inventario_ganho` persiste) e a sessão NÃO voltou a `aprovada`, violando `expect(movs.length).toBe(0)` e `expect(status).toBe("aprovada")`. Esse é o RED determinístico que só fica verde quando a Step 3 troca o loop pela RPC tudo-ou-nada.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Substituir o corpo de `aplicarSessao` em `src/lib/wms/inventario.ts:973-1103` (manter a assinatura `(sessaoId, usuarioId) → { movsGeradas }`):

```typescript
export async function aplicarSessao(
  sessaoId: string,
  usuarioId: string,
): Promise<{ movsGeradas: number }> {
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_aplicar_sessao_inventario", {
    p_sessao: sessaoId,
    p_usuario: usuarioId,
  });
  if (error) throw error;
  return { movsGeradas: Number((data as { movs_geradas: number }).movs_geradas) };
}
```

Remover os imports/helpers que ficaram órfãos por essa troca (apenas os criados por ela: o tipo `DivRow` local e as chamadas a `inserirMovimentacao` dentro de `aplicarSessao`). Em `src/app/api/wms/inventario/[id]/aplicar/route.ts:19-28`, mapear o erro de saldo pra 409 (mensagem clara):

```typescript
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isSaldo = /saldo|insuficiente|reservado|inviável/i.test(msg);
    return wmsErrorResponse({
      source: "wms.inventario.aplicar",
      error: e,
      status: isSaldo ? 409 : 400,
      requestPath: `/api/wms/inventario/${id}/aplicar`,
      requestMethod: "POST",
      metadata: { sessao_id: id },
    });
  }
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- aplicar-sessao-inventario-rpc` (Expected: PASS) + `npm run build` (Expected: typecheck OK, sem órfãos).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "refactor(wms): aplicarSessao delega à RPC atômica + 409 em saldo (P060)"`

### Task 1.3: erros-conhecidos.yaml

- [ ] Adicionar entrada:

```yaml
  - id: inventario-aplicar-nao-atomico
    date: "2026-06-07"
    source: wms/inventario/aplicar
    category: business_logic
    message: "Aplicar sessão de inventário era N RPCs independentes em loop JS — falha no meio deixava parte aplicada e sessão num estado parcial."
    cause: >
      aplicarSessao (inventario.ts:973-1103) iterava divergências chamando
      inserirMovimentacao uma a uma; uma perda inviável (saldo insuficiente) no
      meio aplicava os ganhos anteriores e travava o resto, sem rollback.
    fix: >
      RPC plpgsql wms_aplicar_sessao_inventario com FOR UPDATE da sessão + loop
      de movs + transição de status na MESMA transação; RAISE em qualquer mov
      inviável rola back tudo. Wrapper TS vira .rpc() fino; rota mapeia saldo→409.
    files:
      - supabase/migrations/20260607_rpc_aplicar_sessao_inventario.sql
      - src/lib/wms/inventario.ts
      - src/app/api/wms/inventario/[id]/aplicar/route.ts
    tags: [inventario, atomicidade, ledger, rpc]
```

- [ ] **COMMIT.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): inventario-aplicar-nao-atomico (P060)"`

---

## PR 2: RPC `wms_pick_parcial_atomico` (L+S+ajuste do wave) + idempotency token no pick sem-reserva [P019, P072]

> **Contexto (lido de `src/app/api/wms/separacao/parcial/route.ts:317-433` e `src/app/api/wms/separacao/marcar-item/route.ts:34-180`):** O parcial monta, por pedido do wave: `liberarReservaPicking` (L) → `inserirMovimentacao` (S total) → `inserirMovimentacao` (ajuste loc_zerou) como operações JS independentes. Já existe `wms_pick_item_atomico` (L+S atômico por pedido). Falta (a) atomicidade do **S do wave + ajuste loc_zerou** juntos e (b) no `marcar-item` sem reserva, o pick é S-only sem token de idempotência — dois requests concorrentes podem inserir 2 S (saldo dobra). P072 pede `idempotency_key` no ramo sem-reserva da RPC.

### Task 2.1: Migration — coluna `idempotency_key` + UNIQUE parcial em `siso_movimentacoes`

**Files:**
- Create: `supabase/migrations/20260607b_movimentacoes_idempotency_key.sql`
- Test: `test/integration/mov-idempotency-key.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/mov-idempotency-key.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-IDEMP-${Date.now()}`, descricao: "idemp", ativo: true }).select("id").single();
  prodId = p!.id;
  // saldo inicial
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 50, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
});

describe("siso_movimentacoes.idempotency_key UNIQUE parcial", () => {
  it("rejeita 2ª mov com mesmo idempotency_key (23505)", async () => {
    const key = crypto.randomUUID();
    const ins1 = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 50, saldo_posterior: 49, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: key,
    });
    expect(ins1.error).toBeNull();
    const ins2 = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 49, saldo_posterior: 48, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: key,
    });
    expect(ins2.error?.code).toBe("23505");
  });

  it("permite múltiplas movs com idempotency_key NULL (legado)", async () => {
    const a = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 48, saldo_posterior: 47, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: null,
    });
    const b = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 47, saldo_posterior: 46, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: null,
    });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- mov-idempotency-key`. Expected: FAIL com `column "idempotency_key" of relation "siso_movimentacoes" does not exist`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607b_movimentacoes_idempotency_key.sql`:

```sql
-- Fase 5 (P072) — token de idempotência no ledger. Coluna nullable +
-- UNIQUE parcial (só quando não-nulo) pra não afetar movs legadas. O 2º INSERT
-- com a mesma key estoura 23505 → o caller trata como já-processado (no-op).
ALTER TABLE siso_movimentacoes
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mov_idempotency_key
  ON siso_movimentacoes (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN siso_movimentacoes.idempotency_key IS
  'Token client-gerado pra deduplicar picks sem reserva (P072). UNIQUE parcial.';
```

Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (name: `movimentacoes_idempotency_key`).

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- mov-idempotency-key`. Expected: PASS.

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260607b_movimentacoes_idempotency_key.sql test/integration/mov-idempotency-key.test.ts && git commit -m "feat(wms): coluna idempotency_key + UNIQUE parcial em siso_movimentacoes (P072)"`

### Task 2.2: `wms_inserir_movimentacao` aceita `p_idempotency_key`

**Files:**
- Create: `supabase/migrations/20260607c_inserir_mov_idempotency_param.sql`
- Test: estender `test/integration/mov-idempotency-key.test.ts`

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Adicionar ao `mov-idempotency-key.test.ts`:

```typescript
describe("wms_inserir_movimentacao p_idempotency_key", () => {
  it("2ª chamada com mesma key é no-op (retorna a mesma mov, saldo não dobra)", async () => {
    const key = crypto.randomUUID();
    const { data: estA } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    const mov1 = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 2, p_origem_tipo: "nf_venda", p_idempotency_key: key, p_motivo: "idemp",
    });
    expect(mov1.error).toBeNull();
    const mov2 = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 2, p_origem_tipo: "nf_venda", p_idempotency_key: key, p_motivo: "idemp",
    });
    expect(mov2.error).toBeNull();
    expect(mov2.data).toBe(mov1.data); // mesma mov id
    const { data: estB } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(estB?.saldo)).toBe(Number(estA?.saldo) - 2); // baixou só 1 vez
  });

  // REGRESSÃO DE FIDELIDADE: a recriação da RPC NÃO pode alterar o custo médio.
  // Produto novo, custo médio começa do zero; duas entradas nf_compra com custos
  // distintos devem dar a média ponderada EXATA da fórmula original
  // (v_saldo_global * atual + qty * custo) / (v_saldo_global + qty).
  it("preserva o cálculo de custo médio ponderado (fidelidade coluna-a-coluna)", async () => {
    const { data: prodCusto } = await sb.from("siso_produtos")
      .insert({ sku: `TEST-CUSTO-${Date.now()}`, descricao: "custo", ativo: true }).select("id").single();
    const pc = prodCusto!.id as string;
    // NF de compra exige nota_fiscal_id — cria uma NF mínima.
    const chave = String(Date.now()).padEnd(44, "0").slice(0, 44);
    const { data: nf } = await sb.from("siso_notas_fiscais")
      .insert({ chave_acesso: chave, numero: "1", serie: "1", tipo: "entrada" }).select("id").single();
    const nfId = nf!.id as string;
    // 1ª entrada: 10 un @ R$ 5,00 → custo médio = 5,00
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: pc, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "nf_compra",
      p_custo_unitario: 5, p_nota_fiscal_id: nfId, p_motivo: "c1",
    });
    // 2ª entrada: 10 un @ R$ 7,00 → custo médio ponderado = (10*5 + 10*7)/20 = 6,00
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: pc, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "nf_compra",
      p_custo_unitario: 7, p_nota_fiscal_id: nfId, p_motivo: "c2",
    });
    const { data: cm } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", pc).single();
    expect(Number(cm?.custo_medio)).toBeCloseTo(6, 4);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- mov-idempotency-key`. Expected: FAIL — a RPC atual não tem `p_idempotency_key` (PostgREST: função não encontrada com esse arg), então o 1º teste (e a chamada com `p_idempotency_key`) falha já no PostgREST. (O teste de custo médio, isoladamente, passaria contra a RPC atual — ele é o guard de regressão que DEVE continuar verde após a recriação; se a recriação divergir da whitelist/fórmula, ele vira RED.)

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607c_inserir_mov_idempotency_param.sql` — recriar `wms_inserir_movimentacao` adicionando `p_idempotency_key uuid DEFAULT NULL` (último arg, preserva compat) com early no-op:

> **FIDELIDADE COLUNA-A-COLUNA (obrigatório).** O corpo abaixo NÃO é um esboço — é o corpo EXATO de `supabase/migrations/20260527_wms_inserir_mov_motivo_categoria.sql` (linhas 18-146, lido por inteiro), com APENAS três adições marcadas `-- +P072`: (1) o param `p_idempotency_key uuid DEFAULT NULL` no fim da assinatura; (2) o `DECLARE v_existente uuid` + o early-return no topo do `BEGIN`; (3) a coluna `idempotency_key` no INSERT (lista + VALUES). **Nada mais muda** — a whitelist de custo (`nf_compra, devolucao_cliente_integra, lancamento_retroativo, ajuste_manual, inventario_inicial`), o cast `::wms_motivo_categoria_enum`, as colunas `custo_medio_anterior/custo_medio_posterior`, o `FOR UPDATE` do custo médio e a fórmula `(v_saldo_global * v_custo_medio_atual + p_quantidade * p_custo_unitario) / (v_saldo_global + p_quantidade)` são copiados verbatim. Antes de `apply_migration`, o subagent DEVE rodar `diff <(extrai o corpo desta migration entre CREATE..$function$) <(extrai o corpo de 20260527)` e confirmar que a ÚNICA diferença são as 3 adições `-- +P072` — qualquer outra divergência regride custo médio e deve abortar.

```sql
-- Fase 5 (P072) — wms_inserir_movimentacao aceita p_idempotency_key.
-- Corpo IDÊNTICO a 20260527_wms_inserir_mov_motivo_categoria.sql + 3 adições
-- marcadas '-- +P072'. ANTES de qualquer mutação: se já existe mov com essa
-- key, retorna a mov existente (no-op idempotente) — fecha o duplo-pick
-- sem-reserva sob concorrência.
BEGIN;

-- Dropa o overload de 22 args (com p_motivo_categoria, SEM p_idempotency_key)
-- pra evitar ambiguidade no PostgREST. Assinatura idêntica à criada em
-- 20260527 (21 args + p_motivo_categoria text).
DROP FUNCTION IF EXISTS public.wms_inserir_movimentacao(
  uuid, uuid, uuid, character, numeric, text, text, jsonb, uuid,
  timestamptz, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid, text, numeric, text
);

CREATE OR REPLACE FUNCTION public.wms_inserir_movimentacao(
  p_produto_id uuid, p_galpao_id uuid, p_localizacao_id uuid,
  p_tipo character, p_quantidade numeric,
  p_origem_tipo text, p_origem_id text DEFAULT NULL::text,
  p_origem_detalhes jsonb DEFAULT NULL::jsonb,
  p_usuario_id uuid DEFAULT NULL::uuid,
  p_expira_em timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_estorno_de uuid DEFAULT NULL::uuid,
  p_empresa_compradora_id uuid DEFAULT NULL::uuid,
  p_empresa_vendedora_id uuid DEFAULT NULL::uuid,
  p_empresa_referencia_id uuid DEFAULT NULL::uuid,
  p_fornecedor_id uuid DEFAULT NULL::uuid,
  p_motivo text DEFAULT NULL::text,
  p_cliente_nome text DEFAULT NULL::text,
  p_pedido_id text DEFAULT NULL::text,
  p_nota_fiscal_id uuid DEFAULT NULL::uuid,
  p_chave_acesso_nf text DEFAULT NULL::text,
  p_custo_unitario numeric DEFAULT NULL::numeric,
  p_motivo_categoria text DEFAULT NULL::text,
  p_idempotency_key uuid DEFAULT NULL::uuid   -- +P072
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
  v_existente           uuid;   -- +P072
BEGIN
  -- +P072: no-op idempotente. Token já consumido → retorna a mov existente.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existente FROM siso_movimentacoes WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_existente; END IF;
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

  -- WHITELIST: origens de entrada que compõem custo médio quando custo_unitario é informado.
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
    motivo_categoria,
    idempotency_key   -- +P072
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
    p_motivo_categoria::wms_motivo_categoria_enum,
    p_idempotency_key   -- +P072
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

> **Nota crítica (verificação obrigatória antes do apply):** O corpo acima foi copiado verbatim de `20260527_wms_inserir_mov_motivo_categoria.sql` lido por INTEIRO (não parcial). As ÚNICAS 3 diferenças são as linhas marcadas `-- +P072`. O subagent DEVE confirmar diff coluna-a-coluna (whitelist de custo, cast do enum, colunas `custo_medio_anterior/posterior`, fórmula `(v_saldo_global * v_custo_medio_atual + ...) / (v_saldo_global + p_quantidade)`) antes de aplicar — divergência ≠ as 3 adições regride custo médio e DEVE abortar. Aplicar via `mcp__supabase__apply_migration` no `ehbxpbeijofxtsbezwxd` (name: `inserir_mov_idempotency_param`).

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- mov-idempotency-key` (Expected: PASS) + `npm run test:integration -- ledger-rpc` (regressão — Expected: PASS, custo médio e saldo intactos).

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260607c_inserir_mov_idempotency_param.sql test/integration/mov-idempotency-key.test.ts && git commit -m "feat(wms): wms_inserir_movimentacao aceita p_idempotency_key (no-op idempotente) (P072)"`

### Task 2.3: `marcar-item` sem reserva passa `idempotency_key` (P072)

**Files:**
- Modify: `src/app/api/wms/separacao/marcar-item/route.ts:34-37, 140-166`
- Modify: `src/lib/wms/reservas-picking.ts:177-206` (`pickItemAtomico` aceita `idempotency_key`)
- Modify: `supabase/migrations/20260528_wms_pick_item_atomico.sql` → nova migration que recria a RPC com `p_idempotency_key`
- Create: `supabase/migrations/20260607d_pick_item_atomico_idempotency.sql`

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/pick-item-idempotency.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-PICK-IDEMP-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
});

describe("wms_pick_item_atomico ramo sem-reserva + p_idempotency_key", () => {
  it("2 chamadas com mesma key baixam só 1 vez (saldo não dobra)", async () => {
    const key = crypto.randomUUID();
    const args = {
      p_reserva_id: null, p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty: 3, p_pedido_id: "999000111", p_empresa_vendedora_id: empresaId,
      p_idempotency_key: key,
    };
    const r1 = await sb.rpc("wms_pick_item_atomico", args);
    expect(r1.error).toBeNull();
    const r2 = await sb.rpc("wms_pick_item_atomico", args);
    expect(r2.error).toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(7); // 10 - 3 (só uma vez)
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- pick-item-idempotency`. Expected: FAIL — RPC não tem `p_idempotency_key` ou baixa 2×.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607d_pick_item_atomico_idempotency.sql` recriando `wms_pick_item_atomico` (copiar EXATO de `20260528_wms_pick_item_atomico.sql`, que li inteiro) com `p_idempotency_key uuid DEFAULT NULL` adicionado ao final da assinatura e propagado pra S no ramo sem-reserva:

```sql
-- Fase 5 (P072) — wms_pick_item_atomico aceita p_idempotency_key.
-- No ramo SEM reserva (p_reserva_id IS NULL), propaga o token pra S; a 2ª
-- chamada concorrente vê a key consumida (UNIQUE/no-op em wms_inserir_movimentacao)
-- e retorna a mesma S em vez de inserir outra (fecha o duplo-pick).
CREATE OR REPLACE FUNCTION public.wms_pick_item_atomico(
  p_reserva_id uuid, p_produto_id uuid, p_galpao_id uuid, p_localizacao_id uuid,
  p_qty numeric, p_pedido_id text, p_empresa_vendedora_id uuid, p_usuario_id uuid DEFAULT NULL,
  p_nota_fiscal_id uuid DEFAULT NULL, p_motivo text DEFAULT NULL, p_origem_detalhes jsonb DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_r RECORD; v_ja_liberada boolean; v_l_id uuid; v_s_id uuid;
  v_prod uuid; v_galp uuid; v_loc uuid; v_det jsonb;
BEGIN
  IF p_qty <= 0 THEN RAISE EXCEPTION 'qty deve ser > 0' USING ERRCODE = '22023'; END IF;

  IF p_reserva_id IS NOT NULL THEN
    SELECT id, produto_id, galpao_id, localizacao_id, quantidade, tipo, origem_tipo
      INTO v_r FROM siso_movimentacoes WHERE id = p_reserva_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'reserva % não encontrada', p_reserva_id USING ERRCODE = 'P0002'; END IF;
    IF v_r.tipo <> 'R' OR v_r.origem_tipo <> 'reserva_pedido' THEN
      RAISE EXCEPTION 'mov % não é R reserva_pedido (tipo=%, origem=%)', p_reserva_id, v_r.tipo, v_r.origem_tipo USING ERRCODE = '22023';
    END IF;
    SELECT EXISTS(SELECT 1 FROM siso_movimentacoes WHERE tipo = 'L' AND estorno_de = p_reserva_id) INTO v_ja_liberada;
    IF v_ja_liberada THEN RAISE EXCEPTION 'reserva % já liberada — pick já realizado', p_reserva_id USING ERRCODE = '22023'; END IF;
    v_prod := v_r.produto_id; v_galp := v_r.galpao_id; v_loc := v_r.localizacao_id;
    v_det := COALESCE(p_origem_detalhes, '{}'::jsonb) || jsonb_build_object('reserva_origem', p_reserva_id, 'contexto', 'pick_atomico');
    SELECT wms_inserir_movimentacao(
      p_produto_id := v_prod, p_galpao_id := v_galp, p_localizacao_id := v_loc,
      p_tipo := 'L', p_quantidade := p_qty, p_origem_tipo := 'liberacao_reserva', p_origem_id := p_pedido_id,
      p_origem_detalhes := v_det, p_estorno_de := p_reserva_id, p_usuario_id := p_usuario_id,
      p_pedido_id := p_pedido_id, p_motivo := COALESCE(p_motivo, 'Pick atômico — libera reserva')
    ) INTO v_l_id;
  ELSE
    v_prod := p_produto_id; v_galp := p_galpao_id; v_loc := p_localizacao_id;
    v_det := COALESCE(p_origem_detalhes, '{}'::jsonb) || jsonb_build_object('contexto', 'pick_atomico_sem_reserva');
  END IF;

  SELECT wms_inserir_movimentacao(
    p_produto_id := v_prod, p_galpao_id := v_galp, p_localizacao_id := v_loc,
    p_tipo := 'S', p_quantidade := p_qty, p_origem_tipo := 'nf_venda', p_origem_id := p_pedido_id,
    p_origem_detalhes := v_det, p_empresa_vendedora_id := p_empresa_vendedora_id, p_usuario_id := p_usuario_id,
    p_pedido_id := p_pedido_id, p_nota_fiscal_id := p_nota_fiscal_id,
    p_motivo := COALESCE(p_motivo, 'Pick atômico — saída'),
    -- P072: token só no ramo SEM reserva (com reserva, a R FOR UPDATE já serializa).
    p_idempotency_key := CASE WHEN p_reserva_id IS NULL THEN p_idempotency_key ELSE NULL END
  ) INTO v_s_id;

  RETURN jsonb_build_object('mov_l_id', v_l_id, 'mov_s_id', v_s_id,
    'produto_id', v_prod, 'galpao_id', v_galp, 'localizacao_id', v_loc, 'qty', p_qty);
END;
$function$;
```

Aplicar via `mcp__supabase__apply_migration` (name: `pick_item_atomico_idempotency`). Em `src/lib/wms/reservas-picking.ts:177-206`, adicionar `idempotency_key?: string` ao opts de `pickItemAtomico` e passar `p_idempotency_key: opts.idempotency_key ?? null`. Em `src/app/api/wms/separacao/marcar-item/route.ts`: aceitar `idempotency_key` do body (linhas 34-37) e passar pro `pickItemAtomico` (linha 141-164):

```typescript
  const { pedido_item_id, marcado, idempotency_key } = body as {
    pedido_item_id: number | string;
    marcado: boolean;
    idempotency_key?: string;
  };
```
A chamada já existe (route.ts:141-164); a ÚNICA mudança é inserir a linha `idempotency_key: reservaId ? undefined : idempotency_key,` ANTES de `origem_detalhes`. `origem_detalhes` e `motivo` permanecem EXATAMENTE como no arquivo (reproduzidos aqui na íntegra pra ancoragem — NÃO reescrever):

```typescript
          const pick = await pickItemAtomico({
            reserva_id: reservaId,
            tripla: {
              produto_id: produtoWmsId,
              galpao_id: galpaoId,
              localizacao_id: locId,
            },
            qty: qtyADescontar,
            pedido_id: String(pedido.id),
            empresa_vendedora_id: empresaOrigemId,
            usuario_id: session.id,
            // ÚNICA linha nova (P072): token só no ramo sem-reserva.
            idempotency_key: reservaId ? undefined : idempotency_key,
            origem_detalhes: {
              pedido_id_tiny: pedido.id,
              pedido_numero: pedido.numero,
              pedido_item_id: item.id,
              sku: item.sku,
              contexto: qtyJaPega > 0 ? "checkbox_completa_parcial" : "checkbox",
              qty_ja_pega: qtyJaPega,
            },
            motivo:
              qtyJaPega > 0
                ? `Picking pedido #${pedido.numero} — completa parcial (${qtyADescontar}+${qtyJaPega})`
                : `Picking pedido #${pedido.numero} — checkbox completo`,
          });
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- pick-item-idempotency` (Expected: PASS) + `npm run build` (Expected: typecheck OK).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "feat(wms): idempotency_key no pick sem-reserva do marcar-item (P072)"`

### Task 2.4: RPC `wms_pick_parcial_atomico` (S do wave + ajuste loc_zerou)

**Files:**
- Create: `supabase/migrations/20260607e_rpc_pick_parcial_atomico.sql`
- Modify: `src/app/api/wms/separacao/parcial/route.ts:362-433`
- Test: `test/integration/pick-parcial-atomico-rpc.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/pick-parcial-atomico-rpc.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-PARC-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 20, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
});

describe("wms_pick_parcial_atomico", () => {
  it("S(qty) + ajuste(delta) atômicos: rollback total se o ajuste estourar", async () => {
    // saldo 20, qty_pega 5, delta_ajuste enorme (25) que deixaria saldo negativo → rollback.
    const { error } = await sb.rpc("wms_pick_parcial_atomico", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty_pega: 5, p_delta_ajuste: 25, p_pedido_id: "888000222",
      p_empresa_vendedora_id: empresaId, p_origem_detalhes: { contexto: "test" },
    });
    expect(error).not.toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(20); // nenhuma S/ajuste persistiu
  });

  it("aplica S(5) + ajuste(3) numa tx (saldo 20→12)", async () => {
    const { data, error } = await sb.rpc("wms_pick_parcial_atomico", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty_pega: 5, p_delta_ajuste: 3, p_pedido_id: "888000333",
      p_empresa_vendedora_id: empresaId, p_origem_detalhes: { contexto: "test" },
    });
    expect(error).toBeNull();
    expect((data as { mov_s_id: string }).mov_s_id).toBeTruthy();
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(12);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- pick-parcial-atomico-rpc`. Expected: FAIL com função não encontrada.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260607e_rpc_pick_parcial_atomico.sql`:

```sql
-- Fase 5 (P019) — RPC wms_pick_parcial_atomico: S(qty_pega) + ajuste(delta)
-- da loc esgotada na MESMA transação. A liberação das R por pedido do wave
-- continua via wms_pick_item_atomico (já atômico, 1 por pedido); esta RPC
-- garante que a saída do wave + o ajuste loc_zerou comitem juntos ou revertam
-- juntos (queda de rede entre os dois não deixa saída sem ajuste).
CREATE OR REPLACE FUNCTION public.wms_pick_parcial_atomico(
  p_produto_id uuid, p_galpao_id uuid, p_localizacao_id uuid,
  p_qty_pega numeric, p_delta_ajuste numeric, p_pedido_id text,
  p_empresa_vendedora_id uuid, p_usuario_id uuid DEFAULT NULL,
  p_origem_detalhes jsonb DEFAULT NULL, p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE v_s_id uuid; v_aj_id uuid;
BEGIN
  IF p_qty_pega > 0 THEN
    SELECT wms_inserir_movimentacao(
      p_produto_id := p_produto_id, p_galpao_id := p_galpao_id, p_localizacao_id := p_localizacao_id,
      p_tipo := 'S', p_quantidade := p_qty_pega, p_origem_tipo := 'nf_venda', p_origem_id := p_pedido_id,
      p_origem_detalhes := p_origem_detalhes, p_empresa_vendedora_id := p_empresa_vendedora_id,
      p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := COALESCE(p_motivo, 'Picking parcial — saída')
    ) INTO v_s_id;
  END IF;

  IF p_delta_ajuste > 0 THEN
    SELECT wms_inserir_movimentacao(
      p_produto_id := p_produto_id, p_galpao_id := p_galpao_id, p_localizacao_id := p_localizacao_id,
      p_tipo := 'S', p_quantidade := p_delta_ajuste, p_origem_tipo := 'ajuste_pick_zerou',
      p_origem_id := p_pedido_id, p_origem_detalhes := p_origem_detalhes, p_usuario_id := p_usuario_id,
      p_motivo := 'loc zerou no bipe'
    ) INTO v_aj_id;
  END IF;

  RETURN jsonb_build_object('mov_s_id', v_s_id, 'mov_ajuste_id', v_aj_id);
END;
$function$;
```

Aplicar via `mcp__supabase__apply_migration` (name: `rpc_pick_parcial_atomico`). Em `src/app/api/wms/separacao/parcial/route.ts:362-433`, substituir os dois `inserirMovimentacao` (S em 364-387 + ajuste em 407-426) por **uma** chamada à RPC (manter o cálculo de `deltaAjuste` em 401-403 inalterado, só consolidar a escrita):

```typescript
    // 7b. S(qty_pega) + ajuste(loc_zerou) atômicos via RPC (P019).
    const deltaAjuste = loc_zerou
      ? Math.max(0, saldoWms - quantidade_pega - reservadoRestanteLoc)
      : 0;
    let movSaidaId: string | null = null;
    let movAjusteId: string | null = null;
    if (quantidade_pega > 0 || deltaAjuste > 0) {
      const { data: pk, error: pkErr } = await supabase.rpc("wms_pick_parcial_atomico", {
        p_produto_id: produtoWmsId,
        p_galpao_id: galpaoId,
        p_localizacao_id: locOriginalId,
        p_qty_pega: quantidade_pega,
        p_delta_ajuste: deltaAjuste,
        p_pedido_id: String(primeiroPedido.id),
        p_empresa_vendedora_id: empresaOrigemId,
        p_usuario_id: session.id,
        p_origem_detalhes: {
          pedido_id_tiny: primeiroPedido.id,
          pedido_numero: primeiroPedido.numero,
          pedido_item_ids: itemIdsList,
          sku: primeiroItem.sku,
          saldo_anterior: saldoWms,
          qty_pega: quantidade_pega,
          contexto: itemsRaw.length > 1 ? "parcial_consolidado" : "parcial",
        },
        p_motivo:
          itemsRaw.length > 1
            ? `Picking parcial wave — ${itemsRaw.length} items (pedido #${primeiroPedido.numero}…)`
            : `Picking parcial pedido #${primeiroPedido.numero}`,
      });
      if (pkErr) {
        return NextResponse.json(
          { error: "falha_pick_parcial", message: pkErr.message },
          { status: 409 },
        );
      }
      movSaidaId = (pk as { mov_s_id: string | null }).mov_s_id;
      movAjusteId = (pk as { mov_ajuste_id: string | null }).mov_ajuste_id;
    }
```

Remover o bloco antigo de `inserirMovimentacao` da S (362-388) e o `if (loc_zerou) { ... inserirMovimentacao ajuste ... }` (404-433), preservando o comentário "Fase 1.4 REMOVIDO". Ajustar `deltaAjuste` pra não ser recomputado em dobro (já calculado acima).

> Nota: divergência do achado — o achado sugeria a RPC aceitar "múltiplos pedidos do wave"; na prática a S é **única** (já era, vinculada ao primeiro pedido com lista em origem_detalhes), e as L por pedido continuam via `wms_pick_item_atomico`/`liberarReservaPicking` no loop 7a. A RPC só consolida S+ajuste. Isso respeita a nota (tudo-ou-nada na saída) sem reescrever o pareamento R↔L por pedido.

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- pick-parcial-atomico-rpc` (Expected: PASS) + `npm run build` (Expected: OK) + `npm run scenarios -- :only 70` (regressão do cenário parcial-wave, Expected: PASS).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "feat(wms): RPC wms_pick_parcial_atomico — S+ajuste loc_zerou atômicos (P019)"`

### Task 2.5: erros-conhecidos.yaml

- [ ] Adicionar 2 entradas (P019, P072):

```yaml
  - id: pick-parcial-saida-ajuste-nao-atomico
    date: "2026-06-07"
    source: wms/separacao/parcial
    category: business_logic
    message: "Pick parcial montava S(qty) e ajuste(loc_zerou) como inserirMovimentacao independentes — queda entre eles deixava saída sem ajuste."
    cause: >
      parcial/route.ts gravava a S do wave (364-387) e o ajuste loc_zerou
      (407-426) em chamadas JS separadas; supabase-js não tem tx multi-statement.
    fix: >
      RPC wms_pick_parcial_atomico consolida S+ajuste numa transação; RAISE em
      qualquer uma rola back tudo. As L por pedido continuam via pick atômico.
    files:
      - supabase/migrations/20260607e_rpc_pick_parcial_atomico.sql
      - src/app/api/wms/separacao/parcial/route.ts
    tags: [separacao, parcial, atomicidade, ledger, rpc]
  - id: pick-sem-reserva-sem-idempotencia
    date: "2026-06-07"
    source: wms/separacao/marcar-item
    category: business_logic
    message: "Pick sem reserva (completar parcial / item OC) não tinha token de idempotência — dois requests concorrentes inseriam 2 S e o saldo dobrava."
    cause: >
      No ramo p_reserva_id IS NULL de wms_pick_item_atomico não havia FOR UPDATE
      de R serializando; quantidade_pega lida antes do commit não bloqueava o 2º.
    fix: >
      Coluna idempotency_key (UNIQUE parcial) + p_idempotency_key em
      wms_inserir_movimentacao (no-op se key consumida) propagado pelo pick
      sem-reserva; marcar-item gera/passa a key do client.
    files:
      - supabase/migrations/20260607b_movimentacoes_idempotency_key.sql
      - supabase/migrations/20260607c_inserir_mov_idempotency_param.sql
      - supabase/migrations/20260607d_pick_item_atomico_idempotency.sql
      - src/app/api/wms/separacao/marcar-item/route.ts
      - src/lib/wms/reservas-picking.ts
    tags: [separacao, pick, idempotencia, concorrencia, ledger]
```

- [ ] **COMMIT.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): pick parcial atômico + idempotência sem-reserva (P019, P072)"`

---

## PR 3: [D4] RPC `wms_desmarcar_item_atomico` + estorno tolerante (clamp R + status_alerta) [P014, P015]

> **Contexto (lido de `src/app/api/wms/separacao/marcar-item/route.ts:236-332` e `src/lib/wms/reservas-picking.ts:318-375`):** O desmarcar percorre `siso_pedido_item_mov_links` estornando S antes de L (ordem `P3 #2.7`), engole falhas (`warn+continue`), e SEMPRE roda o delete dos links + update do item. Não é tudo-ou-nada. **D4:** estorno tolerante — quando recriar a R violaria `reservado<=saldo` (terceiros consumiram saldo no intervalo), recriar a R **clampada ao saldo livre** + setar `status_alerta`, tudo na mesma tx. P015 `respeita_nota=false` aceito.

### Task 3.1: Migration — RPC `wms_desmarcar_item_atomico`

**Files:**
- Create: `supabase/migrations/20260608_rpc_desmarcar_item_atomico.sql`
- Test: `test/integration/desmarcar-item-atomico-rpc.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/desmarcar-item-atomico-rpc.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-DESM-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
});

// Helper: cria pedido + item + R, faz pick (L+S) e devolve os ids.
async function prepararPickado(pedidoId: string, qty: number, saldoInicial: number) {
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: saldoInicial, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
  const expira = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  const { data: rId } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "R", p_quantidade: qty, p_origem_tipo: "reserva_pedido", p_origem_id: pedidoId,
    p_expira_em: expira, p_motivo: "reserva",
  });
  const pick = await sb.rpc("wms_pick_item_atomico", {
    p_reserva_id: rId.data ?? rId, p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_qty: qty, p_pedido_id: pedidoId, p_empresa_vendedora_id: empresaId,
  });
  return pick.data as { mov_l_id: string; mov_s_id: string };
}

describe("wms_desmarcar_item_atomico", () => {
  it("estorna S+L atômico: saldo e reservado voltam ao estado pré-pick (sem clamp)", async () => {
    const pedidoId = "700000001";
    const { mov_l_id, mov_s_id } = await prepararPickado(pedidoId, 4, 10);
    // pós-pick: saldo 6, reservado 0
    const { data, error } = await sb.rpc("wms_desmarcar_item_atomico", {
      p_mov_s_id: mov_s_id, p_mov_l_id: mov_l_id, p_pedido_id: pedidoId, p_usuario_id: null,
      p_motivo: "desmarca",
    });
    expect(error).toBeNull();
    expect((data as { status_alerta: string | null }).status_alerta).toBeNull(); // S==L → sem clamp
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(10);     // E counter recuperou
    expect(Number(est?.reservado)).toBe(4);  // R recriada cheia
  });

  // D4 — CLAMP DETERMINÍSTICO. Para o clamp reduzir a R, a qty a recriar (lida
  // do L via p_mov_l_id) precisa EXCEDER o que o estorno-S restaura. Como a RPC
  // lê v_l.quantidade pra R e v_s.quantidade pro estorno INDEPENDENTEMENTE,
  // construímos um L(8) e um S(5) distintos numa loc apertada: pós-estorno-S o
  // saldo livre fica 5 < qty_R 8 → clamp pra 5 + status_alerta.
  // (Quando S.qty == L.qty no mesmo loc, livre_pós_estorno = saldo - reservado +
  // qty_S >= qty_R sempre, pelo invariante reservado<=saldo — clamp não dispara;
  // por isso o teste usa qty distintas, o caso real do desmarcar de completa-parcial.)
  it("D4 tolerante: recriar a R excede o saldo livre → clampa + status_alerta", async () => {
    const pedidoId = "700000002";
    // Seed E 8 → saldo 8.
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 8, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
    });
    const expira = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    // R 8 → reservado 8, depois L 8 → reservado 0 (L mov quantidade=8).
    const { data: rId } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "R", p_quantidade: 8, p_origem_tipo: "reserva_pedido", p_origem_id: pedidoId,
      p_expira_em: expira, p_pedido_id: pedidoId, p_motivo: "reserva original",
    });
    const { data: lId } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "L", p_quantidade: 8, p_origem_tipo: "liberacao_reserva", p_origem_id: pedidoId,
      p_estorno_de: (rId.data ?? rId) as string, p_pedido_id: pedidoId, p_motivo: "libera",
    });
    // S 5 → saldo 3 (S mov quantidade=5, < L).
    const { data: sId } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 5, p_origem_tipo: "nf_venda", p_origem_id: pedidoId,
      p_empresa_vendedora_id: empresaId, p_pedido_id: pedidoId, p_motivo: "saida parcial",
    });
    // Terceiro consome os 3 livres → saldo 0.
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 3, p_origem_tipo: "venda_manual", p_motivo: "terceiro consome livre",
    });
    // Desmarcar: estorno-S(5) → saldo 5, reservado 0, livre 5. Recriar R(8): 5 < 8
    // → CLAMP pra 5 + status_alerta='reserva_clampada_pos_desmarca'.
    const { data, error } = await sb.rpc("wms_desmarcar_item_atomico", {
      p_mov_s_id: (sId.data ?? sId) as string, p_mov_l_id: (lId.data ?? lId) as string,
      p_pedido_id: pedidoId, p_usuario_id: null, p_motivo: "desmarca tardia",
    });
    expect(error).toBeNull();
    const res = data as { status_alerta: string | null };
    expect(res.status_alerta).toBe("reserva_clampada_pos_desmarca");
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est!.saldo)).toBe(5);            // estorno-S restaurou +5
    expect(Number(est!.reservado)).toBe(5);        // R clampada a 5 (não 8)
    expect(Number(est!.reservado)).toBeLessThanOrEqual(Number(est!.saldo)); // invariante
  });
});
```

> **Divergência de design (registrar, não fabricar):** o clamp da RPC só REDUZ a R quando a qty a recriar (lida do L em `p_mov_l_id`) excede o saldo livre pós-estorno-S. No fluxo real do desmarcar, S e L de um MESMO pick têm `quantidade` IGUAL (ambos = `qtyADescontar`) e na mesma loc, caso em que `livre_pós_estorno = saldo - reservado + qty_S >= qty_R` SEMPRE (pelo invariante `reservado<=saldo` do cache) — o clamp NÃO dispara e `status_alerta=null`. O ramo de clamp fica reachable só quando `qty_L > qty_S` (desmarcar de completa-parcial onde a liberação cobre mais que a saída registrada) OU sob consumo externo entre pick e desmarcar que o estorno não restaura. O teste acima constrói exatamente esse caso (L=8, S=5, loc zerada por terceiro). O 1º teste (S==L==4) cobre o caminho normal sem clamp (`status_alerta` deve ser `null`). Se o dono quiser que o clamp dispare também no caso S==L (recriando a reserva ORIGINAL, não a liberação), isso é mudança de design da RPC — confirmar antes; o plano honra D4 com a semântica atual (recria `v_l.quantidade`).

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- desmarcar-item-atomico-rpc`. Expected: FAIL com função não encontrada.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260608_rpc_desmarcar_item_atomico.sql`:

```sql
-- Fase 5 (P014/P015 — D4) — RPC wms_desmarcar_item_atomico: estorna o par
-- S+L de um pick numa única transação (tudo-ou-nada). Ordem S-antes-de-L
-- (fix p3-2.7): a E do estorno-S recupera o saldo antes de recriar a R.
-- D4 tolerante: se recriar a R cheia violaria reservado<=saldo (terceiros
-- consumiram saldo), recria CLAMPADA ao saldo livre e retorna status_alerta
-- em vez de travar o operador. Idempotente: se a S já tem E counter, no-op.
CREATE OR REPLACE FUNCTION public.wms_desmarcar_item_atomico(
  p_mov_s_id uuid,
  p_mov_l_id uuid,
  p_pedido_id text,
  p_usuario_id uuid DEFAULT NULL,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_s RECORD; v_l RECORD;
  v_ja_estornada boolean;
  v_saldo_livre numeric;
  v_qty_r numeric;
  v_qty_clamp numeric;
  v_status_alerta text := NULL;
  v_e_id uuid; v_r_id uuid;
  v_expira timestamptz := now() + interval '30 days';
BEGIN
  -- Lock + valida S
  SELECT id, produto_id, galpao_id, localizacao_id, quantidade, tipo, estorno_de
    INTO v_s FROM siso_movimentacoes WHERE id = p_mov_s_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mov S % não encontrada', p_mov_s_id USING ERRCODE = 'P0002'; END IF;

  -- Idempotência: S já estornada (existe E com estorno_de=S)?
  SELECT EXISTS(SELECT 1 FROM siso_movimentacoes WHERE tipo='E' AND estorno_de=p_mov_s_id) INTO v_ja_estornada;
  IF v_ja_estornada THEN
    RETURN jsonb_build_object('estornado', false, 'idempotente', true, 'status_alerta', NULL);
  END IF;

  -- 1) Estorno da S → E counter (saldo += qty). Recupera saldo ANTES de recriar R.
  SELECT wms_inserir_movimentacao(
    p_produto_id := v_s.produto_id, p_galpao_id := v_s.galpao_id, p_localizacao_id := v_s.localizacao_id,
    p_tipo := 'E', p_quantidade := v_s.quantidade, p_origem_tipo := 'estorno', p_origem_id := p_pedido_id,
    p_origem_detalhes := jsonb_build_object('motivo', COALESCE(p_motivo,'desmarca'), 'reversal', true),
    p_estorno_de := p_mov_s_id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
    p_motivo := COALESCE(p_motivo, 'Desmarcar — estorno S')
  ) INTO v_e_id;

  -- 2) Recria a R (ressuscita reserva). Clampa ao saldo livre se preciso (D4).
  IF p_mov_l_id IS NOT NULL THEN
    SELECT id, produto_id, galpao_id, localizacao_id, quantidade
      INTO v_l FROM siso_movimentacoes WHERE id = p_mov_l_id AND tipo='L' FOR UPDATE;
    IF FOUND THEN
      v_qty_r := v_l.quantidade;
      SELECT saldo - reservado INTO v_saldo_livre FROM siso_estoque
        WHERE produto_id=v_l.produto_id AND galpao_id=v_l.galpao_id AND localizacao_id=v_l.localizacao_id FOR UPDATE;
      v_qty_clamp := LEAST(v_qty_r, GREATEST(v_saldo_livre, 0));
      IF v_qty_clamp < v_qty_r THEN
        v_status_alerta := 'reserva_clampada_pos_desmarca';
      END IF;
      IF v_qty_clamp > 0 THEN
        SELECT wms_inserir_movimentacao(
          p_produto_id := v_l.produto_id, p_galpao_id := v_l.galpao_id, p_localizacao_id := v_l.localizacao_id,
          p_tipo := 'R', p_quantidade := v_qty_clamp, p_origem_tipo := 'reserva_pedido', p_origem_id := p_pedido_id,
          p_origem_detalhes := jsonb_build_object('contexto','estorno_liberacao','estorno_de_L', p_mov_l_id,
                                                  'qty_original', v_qty_r, 'clampada', (v_qty_clamp < v_qty_r)),
          p_expira_em := v_expira, p_estorno_de := p_mov_l_id, p_usuario_id := p_usuario_id,
          p_pedido_id := p_pedido_id, p_motivo := COALESCE(p_motivo,'Desmarcar — ressuscita reserva')
        ) INTO v_r_id;
      ELSE
        v_status_alerta := 'reserva_nao_recriada_sem_saldo';
      END IF;
    END IF;
  END IF;

  -- 3) Status alerta no pedido (best-effort, schema pode não ter a coluna)
  IF v_status_alerta IS NOT NULL THEN
    BEGIN
      UPDATE siso_pedidos SET status_alerta = v_status_alerta WHERE id = p_pedido_id;
    EXCEPTION WHEN undefined_column THEN NULL; END;
  END IF;

  RETURN jsonb_build_object('estornado', true, 'mov_e_id', v_e_id, 'mov_r_id', v_r_id, 'status_alerta', v_status_alerta);
END;
$function$;
```

Aplicar via `mcp__supabase__apply_migration` (name: `rpc_desmarcar_item_atomico`).

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- desmarcar-item-atomico-rpc`. Expected: PASS.

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260608_rpc_desmarcar_item_atomico.sql test/integration/desmarcar-item-atomico-rpc.test.ts && git commit -m "feat(wms): RPC wms_desmarcar_item_atomico — estorno S+L tolerante (clamp R) [D4] (P014, P015)"`

### Task 3.2: `marcar-item` (desmarcar) chama a RPC atômica

**Files:**
- Modify: `src/app/api/wms/separacao/marcar-item/route.ts:236-332`

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar cenário E2E `scripts/wms/cenarios/catalogo/82-desmarcar-item-atomico.ts` (estrutura espelhando o cenário 81): aprova pedido próprio, marca item via `/api/wms/separacao/marcar-item {marcado:true}`, depois desmarca `{marcado:false}` e assert que saldo voltou + reservado voltou (sem item travado). Bloco `assertEsperado`:

```typescript
  assertEsperado: async (ctx, setup) => {
    const { data: item } = await ctx.sb.from("siso_pedido_itens")
      .select("separacao_marcado, quantidade_pega, mov_saida_id")
      .eq("id", setup.itemId).single();
    if ((item as any).separacao_marcado !== false) throw new Error("item não desmarcou");
    if ((item as any).mov_saida_id !== null) throw new Error("mov_saida_id não limpou");
    // reservado voltou: existe R viva pós-desmarca
    const { data: rs } = await ctx.sb.from("siso_movimentacoes")
      .select("id").eq("origem_id", setup.pedidoId).eq("tipo", "R").eq("origem_tipo", "reserva_pedido");
    if (!rs || rs.length === 0) throw new Error("R não ressuscitou após desmarca");
  },
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run scenarios -- :only 82`. Expected: FAIL inicialmente só se o caminho antigo deixar inconsistência sob o cenário; senão o RED real é garantir que o **delete de links + update do item só acontecem se a RPC não lançou**. Para forçar RED determinístico, o subagent deve primeiro rodar o cenário contra o código antigo e confirmar o comportamento, então a Step 3 troca a implementação e re-roda.

> Nota: o caminho antigo "engole falha (warn+continue) e sempre deleta links/atualiza item" — o RED forte é um teste de unidade/integração que injeta falha no estorno e verifica que o item NÃO é desmarcado. Como o estorno via RPC agora é tudo-ou-nada, adicionar ao `desmarcar-item-atomico-rpc.test.ts` um caso onde `p_mov_s_id` aponta pra uma S já estornada manualmente externamente — a RPC retorna `idempotente:true` (no-op) e a rota não deve duplicar E. Esse já é coberto na Task 3.1.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Substituir o bloco `else` (desmarcar) em `marcar-item/route.ts:236-332` por: buscar os links (já feito), para cada par S+L do item chamar `wms_desmarcar_item_atomico` (uma chamada por par; o item normalmente tem 1 S + 1 L), só deletar links e atualizar o item se TODAS as chamadas retornarem sem erro:

```typescript
    } else {
      const { data: links } = await supabase
        .from("siso_pedido_item_mov_links")
        .select("id, mov_id, tipo_link")
        .eq("pedido_item_id", item.id)
        .in("tipo_link", ["saida", "liberacao_reserva"]);

      const movS = (links ?? []).find((l) => l.tipo_link === "saida");
      const movL = (links ?? []).find((l) => l.tipo_link === "liberacao_reserva");

      if (movS) {
        const { error: rpcErr } = await supabase.rpc("wms_desmarcar_item_atomico", {
          p_mov_s_id: movS.mov_id,
          p_mov_l_id: movL?.mov_id ?? null,
          p_pedido_id: String(pedido.id),
          p_usuario_id: session.id,
          p_motivo: `Desmarcar checkbox pedido #${pedido.numero}`,
        });
        if (rpcErr) {
          // Tudo-ou-nada: a RPC rolou back. Item permanece marcado intacto.
          logger.warn("separacao-marcar-item", "Desmarcar atômico falhou — item NÃO desmarcado", {
            error: rpcErr.message, pedido_item_id, pedido_id: pedido.id,
          });
          return NextResponse.json(
            { error: "falha_desmarcar", message: rpcErr.message },
            { status: 409 },
          );
        }
        await supabase
          .from("siso_pedido_item_mov_links")
          .delete()
          .in("id", (links ?? []).map((l) => l.id as string));
      } else if (item.mov_saida_id) {
        // Legacy fallback (item sem entrada na tabela ponte)
        const { error: rpcErr } = await supabase.rpc("wms_desmarcar_item_atomico", {
          p_mov_s_id: item.mov_saida_id, p_mov_l_id: null,
          p_pedido_id: String(pedido.id), p_usuario_id: session.id,
          p_motivo: "Desmarcar checkbox (legacy path)",
        });
        if (rpcErr) {
          return NextResponse.json({ error: "falha_desmarcar", message: rpcErr.message }, { status: 409 });
        }
      }

      const { data: updated, error: updErr } = await supabase
        .from("siso_pedido_itens")
        .update({ separacao_marcado: false, separacao_marcado_em: null, quantidade_pega: null, mov_saida_id: null })
        .eq("id", item.id).select().single();
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
      return NextResponse.json(updated);
    }
```

Remover os imports órfãos criados por essa troca: `estornarMovimentacao` e `estornarLiberacaoReserva` (linhas 5-10) **se** não forem mais usados no arquivo após a mudança (verificar — o ramo `marcado:true` não os usa; eram só do desmarcar). Confirmar com grep antes de remover.

- [ ] **Step 4 — RODAR e ver passar.** `npm run scenarios -- :only 82` (Expected: PASS) + `npm run build` (Expected: typecheck OK, sem imports órfãos).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "refactor(wms): desmarcar item via RPC atômica tolerante — falha não deixa item travado (P014, P015)"`

### Task 3.3: erros-conhecidos.yaml

- [ ] Adicionar entrada:

```yaml
  - id: desmarcar-item-nao-atomico
    date: "2026-06-08"
    source: wms/separacao/marcar-item
    category: business_logic
    message: "Desmarcar item engolia falhas de estorno (warn+continue) e sempre deletava links + atualizava o item — desfazimento parcial deixava ledger incoerente; recriar R podia violar reservado<=saldo e travar o operador."
    cause: >
      O ramo else de marcar-item/route.ts:236-332 percorria os links estornando
      S e L em chamadas JS independentes; falha era logada e ignorada, e o
      delete+update rodava incondicionalmente.
    fix: >
      RPC wms_desmarcar_item_atomico estorna S+L na MESMA tx (S antes de L) com
      D4: clampa a R ressuscitada ao saldo livre + status_alerta quando terceiros
      consumiram saldo. Rota só deleta links/atualiza item se a RPC não lançou.
    files:
      - supabase/migrations/20260608_rpc_desmarcar_item_atomico.sql
      - src/app/api/wms/separacao/marcar-item/route.ts
    tags: [separacao, desmarcar, atomicidade, ledger, rpc, estorno-tolerante]
```

- [ ] **COMMIT.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): desmarcar-item-nao-atomico [D4] (P014, P015)"`

---

## PR 4: RPC `wms_reverter_cutover_atomico` (reversão tudo-ou-nada) [P023]

> **Contexto (lido de `src/lib/wms/cutover.ts:165-375` e `desfazer-bip/route.ts:175-185`):** `reverterCutoverSeRetrocedeu` busca todas as S do pedido (via `origem_id+origem_tipo='nf_venda'` UNION `siso_pedido_itens.mov_saida_id`), pula as já estornadas (E com `estorno_de=S.id`), e para cada uma faz `inserirMovimentacao(E)` (estorno) + `reservarAtomico(R)` + no fim `UPDATE estoque_lancado/nf_estoque_lancado=false`. São 2N chamadas independentes + o UPDATE — queda no meio deixa saldo parcialmente revertido com `estoque_lancado=true`. O caller (`desfazer-bip`) chama com `.catch(warn)`.

### Task 4.1: Migration — RPC `wms_reverter_cutover_atomico`

**Files:**
- Create: `supabase/migrations/20260608b_rpc_reverter_cutover_atomico.sql`
- Test: `test/integration/reverter-cutover-rpc.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/reverter-cutover-rpc.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-REVCUT-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
});

async function pedidoComSaidaLancada(pedidoId: string, qty: number, saldoInicial: number) {
  await sb.from("siso_pedidos").insert({
    id: pedidoId, status: "executando", estoque_lancado: true, nf_estoque_lancado: true,
  });
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: saldoInicial, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
  // S nf_venda ligada ao pedido (origem_id=pedidoId)
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "S", p_quantidade: qty, p_origem_tipo: "nf_venda", p_origem_id: pedidoId,
    p_empresa_vendedora_id: empresaId, p_pedido_id: pedidoId, p_motivo: "cutover S",
  });
}

describe("wms_reverter_cutover_atomico", () => {
  it("estorna todas as S + recria R + flip da flag numa tx; idempotente na 2ª", async () => {
    const pedidoId = "710000001";
    await pedidoComSaidaLancada(pedidoId, 4, 10); // pós-S: saldo 6
    const { data, error } = await sb.rpc("wms_reverter_cutover_atomico", {
      p_pedido_id: pedidoId, p_motivo: "desfazer_bip", p_usuario_id: null,
    });
    expect(error).toBeNull();
    expect((data as { reverted: boolean }).reverted).toBe(true);
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(10);    // E counter recuperou
    expect(Number(est?.reservado)).toBe(4); // R recriada
    const { data: ped } = await sb.from("siso_pedidos").select("estoque_lancado").eq("id", pedidoId).single();
    expect((ped as { estoque_lancado: boolean }).estoque_lancado).toBe(false);
    // 2ª chamada: idempotente (S já estornadas → nenhuma nova E)
    const r2 = await sb.rpc("wms_reverter_cutover_atomico", { p_pedido_id: pedidoId, p_motivo: "desfazer_bip", p_usuario_id: null });
    expect(r2.error).toBeNull();
    expect((r2.data as { saidas_estornadas: number }).saidas_estornadas).toBe(0);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- reverter-cutover-rpc`. Expected: FAIL com função não encontrada.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260608b_rpc_reverter_cutover_atomico.sql`:

```sql
-- Fase 5 (P023) — RPC wms_reverter_cutover_atomico: numa transação, para cada
-- S do pedido (nf_venda, sem E counter), insere E (estorno_de=S) + recria R, e
-- flipa estoque_lancado/nf_estoque_lancado=false. RAISE em qualquer falha rola
-- back tudo (nenhuma S estornada, flag permanece true coerente). Idempotente:
-- pula S que já têm E counter. Espelha o loop TS de cutover.ts:290-346.
CREATE OR REPLACE FUNCTION public.wms_reverter_cutover_atomico(
  p_pedido_id text,
  p_motivo text,
  p_usuario_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_s RECORD;
  v_e_id uuid;
  v_estornadas integer := 0;
  v_recriadas integer := 0;
  v_expira timestamptz := now() + interval '30 days';
BEGIN
  -- Trava o pedido (serializa reversões concorrentes do mesmo pedido).
  PERFORM 1 FROM siso_pedidos WHERE id = p_pedido_id FOR UPDATE;

  FOR v_s IN
    -- Caminho 1: S com origem_id=pedido. Caminho 2: S via mov_saida_id dos itens.
    SELECT DISTINCT m.id, m.produto_id, m.galpao_id, m.localizacao_id, m.quantidade
      FROM siso_movimentacoes m
     WHERE m.tipo = 'S'
       AND (
         (m.origem_id = p_pedido_id AND m.origem_tipo = 'nf_venda')
         OR m.id IN (SELECT mov_saida_id FROM siso_pedido_itens WHERE pedido_id = p_pedido_id AND mov_saida_id IS NOT NULL)
       )
       AND NOT EXISTS (SELECT 1 FROM siso_movimentacoes e WHERE e.tipo='E' AND e.estorno_de = m.id)
     FOR UPDATE
  LOOP
    SELECT wms_inserir_movimentacao(
      p_produto_id := v_s.produto_id, p_galpao_id := v_s.galpao_id, p_localizacao_id := v_s.localizacao_id,
      p_tipo := 'E', p_quantidade := v_s.quantidade, p_origem_tipo := 'estorno', p_origem_id := p_pedido_id,
      -- marker 'reversal_cutover_rpc' prova que o estorno saiu por ESTA RPC (não
      -- pelo loop TS antigo) — assert distintivo no wrapper (RED da Task 4.2).
      p_origem_detalhes := jsonb_build_object('motivo', p_motivo, 'reversal', true, 'reversal_cutover_rpc', true),
      p_estorno_de := v_s.id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := 'Reversal por ' || p_motivo
    ) INTO v_e_id;
    v_estornadas := v_estornadas + 1;

    -- Recria R (reserva volta). Na mesma tx — se exceder saldo, RAISE → rollback total.
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_s.produto_id, p_galpao_id := v_s.galpao_id, p_localizacao_id := v_s.localizacao_id,
      p_tipo := 'R', p_quantidade := v_s.quantidade, p_origem_tipo := 'reserva_pedido', p_origem_id := p_pedido_id,
      p_origem_detalhes := jsonb_build_object('contexto','reversal_cutover'),
      p_expira_em := v_expira, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := 'Recria reserva no reversal'
    );
    v_recriadas := v_recriadas + 1;
  END LOOP;

  UPDATE siso_pedidos SET estoque_lancado = false, nf_estoque_lancado = false WHERE id = p_pedido_id;

  RETURN jsonb_build_object('reverted', true, 'saidas_estornadas', v_estornadas, 'reservas_recriadas', v_recriadas);
END;
$function$;
```

Aplicar via `mcp__supabase__apply_migration` (name: `rpc_reverter_cutover_atomico`).

> Nota: divergência do achado — o TS antigo tolerava falha de recriação de R (contava `reservasFalhadas` + `status_alerta`). Na RPC tudo-ou-nada (nota do dono = opção 1 estrita), uma R que excede saldo faz **rollback total**. Isso é o comportamento pedido por P023 ("volta pro estado anterior se cai no meio"). O caso tolerante de reserva é tratado no PR3 (desmarcar), não aqui.

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- reverter-cutover-rpc`. Expected: PASS.

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260608b_rpc_reverter_cutover_atomico.sql test/integration/reverter-cutover-rpc.test.ts && git commit -m "feat(wms): RPC wms_reverter_cutover_atomico — reversão tudo-ou-nada (P023)"`

### Task 4.2: `reverterCutoverSeRetrocedeu` delega à RPC

**Files:**
- Modify: `src/lib/wms/cutover.ts:194-375` (substituir o corpo pós-guards pela chamada RPC)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Estender `test/integration/reverter-cutover-rpc.test.ts` exercitando o wrapper TS. O 3º caso é o **RED determinístico via marker**: o estorno-E da reversão carrega `origem_detalhes.reversal_cutover_rpc=true` SÓ quando sai pela RPC (Task 4.1) — o loop TS antigo grava o estorno sem esse marker, então o assert só fica verde quando o caller delega à RPC. (A atomicidade tudo-ou-nada já é provada no nível da RPC na Task 4.1; ver a divergência de design abaixo sobre por que o RAISE da recriação de R é inalcançável via saldo no mesmo loc.)

```typescript
import { reverterCutoverSeRetrocedeu } from "../../src/lib/wms/cutover";

describe("reverterCutoverSeRetrocedeu (wrapper → RPC)", () => {
  it("reverte quando saiu do forward e estoque_lancado=true", async () => {
    const pedidoId = "710000010";
    await pedidoComSaidaLancada(pedidoId, 3, 8);
    const r = await reverterCutoverSeRetrocedeu(pedidoId, "em_separacao", "desfazer_bip", undefined);
    expect(r.reverted).toBe(true);
    const { data: ped } = await sb.from("siso_pedidos").select("estoque_lancado").eq("id", pedidoId).single();
    expect((ped as { estoque_lancado: boolean }).estoque_lancado).toBe(false);
  });

  it("no-op quando ainda forward (separado)", async () => {
    const pedidoId = "710000011";
    await pedidoComSaidaLancada(pedidoId, 2, 8);
    const r = await reverterCutoverSeRetrocedeu(pedidoId, "separado", "desfazer_bip", undefined);
    expect(r.reverted).toBe(false);
    expect(r.motivo).toBe("ainda_forward");
  });

  // RED DETERMINÍSTICO via marker: o estorno-E da reversão carrega
  // 'reversal_cutover_rpc' SÓ quando sai pela RPC. O loop TS antigo grava o
  // estorno via inserirMovimentacao SEM esse marker → o assert falha contra ele.
  it("reverte via RPC: estorno-E carrega o marker distintivo", async () => {
    const pedidoId = "710000012";
    await pedidoComSaidaLancada(pedidoId, 4, 10);
    const r = await reverterCutoverSeRetrocedeu(pedidoId, "em_separacao", "desfazer_bip", undefined);
    expect(r.reverted).toBe(true);
    const { data: estornos } = await sb.from("siso_movimentacoes")
      .select("origem_detalhes")
      .eq("tipo", "E").eq("origem_tipo", "estorno").eq("origem_id", pedidoId);
    expect((estornos ?? []).length).toBe(1);
    expect((estornos![0] as { origem_detalhes: Record<string, unknown> }).origem_detalhes.reversal_cutover_rpc).toBe(true);
  });
});
```

> **Divergência de design (registrar, não fabricar):** a RPC recria a R no MESMO loc e na MESMA qty da S estornada. Como o estorno-S devolve `+qty` ao saldo ANTES de recriar a R(qty), e o invariante `reservado<=saldo` do cache vale, `saldo_livre_pós_estorno = (saldo - reservado) + qty >= qty` SEMPRE — ou seja, **o RAISE na recriação da R é inalcançável com saldo no mesmo loc** (igual ao clamp do PR3 quando S==L). A atomicidade tudo-ou-nada da RPC continua correta e provada no nível da RPC (Task 4.1: o rollback acontece se QUALQUER `wms_inserir_movimentacao` interno falhar — ex.: um estorno-S com saldo corrompido), mas NÃO há um caminho de falha trivial via saldo a injetar pelo wrapper. Por isso o RED do wrapper é o **marker distintivo** (`reversal_cutover_rpc`), que prova que o caller passou a usar a RPC — determinístico e suficiente para o ciclo TDD do refactor. Os 2 primeiros casos cobrem o caminho feliz (reverte / no-op forward) sem regressão.

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- reverter-cutover-rpc`. Expected: os 2 primeiros casos passam contra o código antigo (happy path equivalente); o 3º caso **FALHA** — o loop TS antigo grava o estorno-E sem o marker `reversal_cutover_rpc`, então `origem_detalhes.reversal_cutover_rpc).toBe(true)` lança. Esse é o RED determinístico que só fica verde quando a Step 3 troca o loop pela RPC da Task 4.1 (que estampa o marker).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/wms/cutover.ts`, manter os guards de `reverterCutoverSeRetrocedeu` (165-193: `isForwardStatus`, busca pedido, `estoque_lancado`) e substituir TODO o corpo de 194-374 (busca de S + loop de estornos/recriações + UPDATE) por:

```typescript
  const { data: rpcRes, error: rpcErr } = await sb.rpc("wms_reverter_cutover_atomico", {
    p_pedido_id: pedidoId,
    p_motivo: motivo,
    p_usuario_id: usuarioId ?? null,
  });
  if (rpcErr) {
    logger.error("wms.cutover", "RPC reverter cutover falhou", {
      pedidoId, motivo, err: rpcErr.message,
    });
    return { reverted: false, motivo: "rpc_error" };
  }
  const res = rpcRes as { reverted: boolean; saidas_estornadas: number; reservas_recriadas: number };
  logger.info("wms.cutover", "Cutover revertido (RPC)", {
    pedidoId, motivo, novoStatus,
    saidasEstornadas: res.saidas_estornadas, reservasRecriadas: res.reservas_recriadas,
  });
  return {
    reverted: res.reverted,
    motivo: "ok",
    saidasEstornadas: res.saidas_estornadas,
    reservasRecriadas: res.reservas_recriadas,
    reservasFalhadas: 0,
  };
}
```

Remover imports que ficaram órfãos por essa troca (verificar com grep antes): `reservarAtomico` se não usado em outro ponto de `cutover.ts`. Manter `inserirMovimentacao` se usado em `dispararCutoverSePronto`. O `ReverterResult` type deve seguir aceitando os campos retornados.

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- reverter-cutover-rpc` (Expected: PASS) + `npm run build` (Expected: OK).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "refactor(wms): reverterCutoverSeRetrocedeu delega à RPC atômica (P023)"`

### Task 4.3: erros-conhecidos.yaml

- [ ] Adicionar entrada:

```yaml
  - id: reverter-cutover-nao-atomico
    date: "2026-06-08"
    source: wms/cutover
    category: business_logic
    message: "Reversão do cutover (estorno de N S + recriação de N R + flip da flag) eram 2N+1 operações independentes — queda deixava saldo parcialmente revertido com estoque_lancado=true."
    cause: >
      cutover.ts:290-346 iterava as S chamando inserirMovimentacao(E) +
      reservarAtomico(R) e só no fim atualizava estoque_lancado=false; sem tx.
    fix: >
      RPC wms_reverter_cutover_atomico faz FOR UPDATE do pedido + loop de
      estorno+recriação + flip da flag na MESMA tx; RAISE rola back tudo.
      Idempotente (pula S com E counter). Wrapper TS vira .rpc() fino.
    files:
      - supabase/migrations/20260608b_rpc_reverter_cutover_atomico.sql
      - src/lib/wms/cutover.ts
    tags: [cutover, reversao, atomicidade, ledger, rpc]
```

- [ ] **COMMIT.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): reverter-cutover-nao-atomico (P023)"`

---

## PR 5: RPCs `wms_vender_baixa_direta_atomico` + `wms_cancelar_venda_atomico` [P075, P077]

> **Contexto (lido de `src/app/api/wms/vendas/criar/route.ts:507-660` e `src/lib/wms/vendas-cancelamento.ts:91-148`):** Na venda `baixa_direta`, cada item é dividido em N movs S (uma por loc/sugestão) gravadas em loop JS; o `rollbackBaixaDireta` estorna best-effort e **segue deletando pedido/itens mesmo com estorno incompleto** (linha 536-537). Todas as movs compartilham `origem_id=origemVendaId` (uuid) + `origem_detalhes.pedido_id_manual=MAN-...`. P075: trancar as triplas (advisory lock) + tudo-ou-nada nas N S. P077: o cancelamento estorna as N S uma a uma sem atomicidade — falha no meio deixa parte devolvida e pedido não-cancelado; precisa das N devoluções como bloco indivisível.

### Task 5.1: Migration — RPC `wms_vender_baixa_direta_atomico`

**Files:**
- Create: `supabase/migrations/20260609_rpc_vender_baixa_direta_atomico.sql`
- Test: `test/integration/vender-baixa-direta-rpc.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/vender-baixa-direta-rpc.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locA: string, locB: string, prodId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: la } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locA = la!.id;
  const { data: lb } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-02").single();
  locB = lb!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-BD-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
  for (const loc of [locA, locB]) {
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: loc,
      p_tipo: "E", p_quantidade: 5, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
    });
  }
});

describe("wms_vender_baixa_direta_atomico", () => {
  it("baixa N movs S em locs distintas numa tx; rollback total se uma exceder saldo", async () => {
    const origemId = crypto.randomUUID();
    // pede 5 de locA (ok) + 8 de locB (só tem 5 → falha) → rollback total.
    const { error } = await sb.rpc("wms_vender_baixa_direta_atomico", {
      p_origem_venda_id: origemId, p_pedido_id_manual: "MAN-fail-1",
      p_empresa_vendedora_id: empresaId, p_cliente_nome: "Cli", p_usuario_id: null,
      p_movs: [
        { produto_id: prodId, galpao_id: galpaoId, localizacao_id: locA, qty: 5, sku: "x" },
        { produto_id: prodId, galpao_id: galpaoId, localizacao_id: locB, qty: 8, sku: "x" },
      ],
    });
    expect(error).not.toBeNull();
    // nenhuma S persistiu: saldos intactos
    const { data: ea } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("localizacao_id", locA).single();
    expect(Number(ea?.saldo)).toBe(5);
  });

  it("baixa 5+3 com sucesso (saldos 0 e 2)", async () => {
    const origemId = crypto.randomUUID();
    const { data, error } = await sb.rpc("wms_vender_baixa_direta_atomico", {
      p_origem_venda_id: origemId, p_pedido_id_manual: "MAN-ok-1",
      p_empresa_vendedora_id: empresaId, p_cliente_nome: "Cli", p_usuario_id: null,
      p_movs: [
        { produto_id: prodId, galpao_id: galpaoId, localizacao_id: locA, qty: 5, sku: "x" },
        { produto_id: prodId, galpao_id: galpaoId, localizacao_id: locB, qty: 3, sku: "x" },
      ],
    });
    expect(error).toBeNull();
    expect((data as { mov_ids: string[] }).mov_ids.length).toBe(2);
    const { data: ea } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locA).single();
    const { data: eb } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locB).single();
    expect(Number(ea?.saldo)).toBe(0);
    expect(Number(eb?.saldo)).toBe(2);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- vender-baixa-direta-rpc`. Expected: FAIL com função não encontrada.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260609_rpc_vender_baixa_direta_atomico.sql`:

```sql
-- Fase 5 (P075) — RPC wms_vender_baixa_direta_atomico: baixa N movs S de uma
-- venda manual numa ÚNICA transação. Tranca as triplas via pg_advisory_xact_lock
-- (auto-libera no fim da tx) e insere cada S; qualquer falha (saldo insuficiente)
-- faz RAISE → rollback total (nenhuma S persiste). Substitui o loop JS +
-- rollback best-effort de vendas/criar/route.ts:540-634.
CREATE OR REPLACE FUNCTION public.wms_vender_baixa_direta_atomico(
  p_origem_venda_id uuid,
  p_pedido_id_manual text,
  p_empresa_vendedora_id uuid,
  p_cliente_nome text,
  p_movs jsonb,            -- array de {produto_id, galpao_id, localizacao_id, qty, sku, ...}
  p_usuario_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_mov jsonb;
  v_mov_id uuid;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_lock_key bigint;
BEGIN
  FOR v_mov IN SELECT * FROM jsonb_array_elements(p_movs)
  LOOP
    -- Advisory lock por tripla (hashtext determinístico) — serializa baixas
    -- concorrentes na mesma prateleira. Auto-libera no commit/rollback.
    v_lock_key := hashtextextended(
      (v_mov->>'produto_id') || (v_mov->>'galpao_id') || (v_mov->>'localizacao_id'), 0
    );
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT wms_inserir_movimentacao(
      p_produto_id := (v_mov->>'produto_id')::uuid,
      p_galpao_id := (v_mov->>'galpao_id')::uuid,
      p_localizacao_id := (v_mov->>'localizacao_id')::uuid,
      p_tipo := 'S', p_quantidade := (v_mov->>'qty')::numeric,
      p_origem_tipo := 'venda_manual', p_origem_id := p_origem_venda_id::text,
      -- marker 'baixa_direta_rpc' prova que a S saiu por ESTA RPC (não pelo loop
      -- JS antigo) — assert distintivo no cenário 83 (RED do wrapper Task 5.2).
      p_origem_detalhes := v_mov || jsonb_build_object('pedido_id_manual', p_pedido_id_manual, 'baixa_direta_rpc', true),
      p_empresa_vendedora_id := p_empresa_vendedora_id, p_cliente_nome := p_cliente_nome,
      p_pedido_id := p_pedido_id_manual, p_usuario_id := p_usuario_id,
      p_motivo := 'Venda manual ' || p_pedido_id_manual || ' — ' || COALESCE(p_cliente_nome,'')
    ) INTO v_mov_id;
    v_ids := array_append(v_ids, v_mov_id);
  END LOOP;

  RETURN jsonb_build_object('mov_ids', to_jsonb(v_ids));
END;
$function$;
```

Aplicar via `mcp__supabase__apply_migration` (name: `rpc_vender_baixa_direta_atomico`).

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- vender-baixa-direta-rpc`. Expected: PASS.

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260609_rpc_vender_baixa_direta_atomico.sql test/integration/vender-baixa-direta-rpc.test.ts && git commit -m "feat(wms): RPC wms_vender_baixa_direta_atomico — N saídas tudo-ou-nada + advisory lock (P075)"`

### Task 5.2: `vendas/criar` usa a RPC (sem deletar pedido com estorno incompleto)

**Files:**
- Modify: `src/app/api/wms/vendas/criar/route.ts:507-660`

Steps:

> **Por que a falha parcial NÃO é reproduzível via HTTP (verificado):** o route auto-degrada pra modo `separacao` quando `!todasComSaldo` (linha 357: `if (modo === "baixa_direta" && !todasComSaldo) { modoEfetivo = "separacao"; ... }`), então uma `baixa_direta` com cobertura insuficiente NUNCA chega ao loop de S — não há como uma S falhar no meio via um único POST. A atomicidade tudo-ou-nada sob falha parcial é, portanto, exercida no nível da RPC (Task 5.1, teste `rollback total se uma exceder saldo`). Para o WRAPPER (route), o RED determinístico é um **marker distintivo** que SÓ a RPC grava (`origem_detalhes->>'baixa_direta_rpc'`), provando que a baixa saiu pela RPC e não pelo loop JS antigo.

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar cenário E2E `scripts/wms/cenarios/catalogo/83-venda-baixa-direta-atomica.ts`: cria produto com saldo dividido em 2 locs, dispara `POST /api/wms/vendas/criar` em modo baixa_direta cobrindo as 2 locs. Asserts no `assertEsperado`:

```typescript
  assertEsperado: async (ctx, setup) => {
    // (a) saldo baixou nas 2 locs
    const { data: ests } = await ctx.sb.from("siso_estoque").select("localizacao_id, saldo")
      .eq("produto_id", setup.prodId).eq("galpao_id", setup.galpaoId)
      .in("localizacao_id", [setup.locA, setup.locB]);
    const byLoc = Object.fromEntries((ests ?? []).map((e: any) => [e.localizacao_id, Number(e.saldo)]));
    if (byLoc[setup.locA] !== setup.esperadoA) throw new Error(`saldo locA ${byLoc[setup.locA]} != ${setup.esperadoA}`);
    if (byLoc[setup.locB] !== setup.esperadoB) throw new Error(`saldo locB ${byLoc[setup.locB]} != ${setup.esperadoB}`);
    // (b) RED DISTINTIVO: toda S da venda carrega o marker que SÓ a RPC grava.
    //     O loop JS antigo NÃO seta 'baixa_direta_rpc' → este assert falha contra ele.
    const { data: movsS } = await ctx.sb.from("siso_movimentacoes")
      .select("origem_detalhes")
      .eq("tipo", "S").eq("origem_tipo", "venda_manual")
      .filter("origem_detalhes->>pedido_id_manual", "eq", setup.pedidoId);
    if (!movsS || movsS.length < 2) throw new Error(`esperava >=2 S da venda, achou ${movsS?.length ?? 0}`);
    for (const m of movsS as any[]) {
      if (m.origem_detalhes?.baixa_direta_rpc !== true) {
        throw new Error("S sem marker baixa_direta_rpc — não passou pela RPC (loop JS antigo)");
      }
    }
    // (c) o pedido MAN-... existe (não foi deletado pelo rollback best-effort)
    const { data: ped } = await ctx.sb.from("siso_pedidos").select("id, status")
      .eq("id", setup.pedidoId).maybeSingle();
    if (!ped) throw new Error("pedido foi deletado (rollback best-effort do caminho antigo)");
    // (d) nenhum estorno-E órfão (a RPC não estorna no caminho feliz)
    const { data: estornos } = await ctx.sb.from("siso_movimentacoes")
      .select("id").eq("tipo", "E").eq("origem_tipo", "estorno").eq("pedido_id", setup.pedidoId);
    if ((estornos ?? []).length !== 0) throw new Error("estorno-E órfão no caminho feliz");
  },
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run scenarios -- :only 83`. Expected: **FALHA** contra o código antigo no assert (b) — o loop JS de `vendas/criar` grava as S via `inserirMovimentacao` SEM o marker `baixa_direta_rpc`, então `m.origem_detalhes?.baixa_direta_rpc !== true` lança. Esse é o RED determinístico que SÓ fica verde quando a Step 3 troca o loop pela RPC `wms_vender_baixa_direta_atomico` (que estampa o marker). Os asserts (a)/(c)/(d) garantem não-regressão do caminho feliz (saldo correto, pedido não-deletado, sem estorno órfão).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `vendas/criar/route.ts`, no bloco `if (modoEfetivo === "baixa_direta")` (540-660), montar o array `p_movs` (distribuindo qty entre `item.sugestoes` como hoje, mas sem inserir) e chamar a RPC uma vez:

```typescript
  if (modoEfetivo === "baixa_direta") {
    const origemVendaId = crypto.randomUUID();
    const movsPayload: Array<Record<string, unknown>> = [];
    for (const item of itensResolvidos) {
      if (!item.sugestoes || item.sugestoes.length === 0) {
        await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
        await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
        return NextResponse.json({ erro: `Falha interna: nenhuma loc resolvida pra ${item.sku}` }, { status: 500 });
      }
      let restante = item.quantidade;
      for (const sug of item.sugestoes) {
        if (restante <= 0) break;
        const qtyDestaLoc = Math.min(restante, sug.disponivel);
        if (qtyDestaLoc <= 0) continue;
        movsPayload.push({
          produto_id: item.produto_id, galpao_id, localizacao_id: sug.localizacao_id,
          qty: qtyDestaLoc, sku: item.sku, vendedor_id: vendedorIdEfetivo, vendedor_nome: vendedorNomeEfetivo,
          canal_venda: canal_venda ?? null, loc_codigo: sug.localizacao_codigo,
          qty_item_total: item.quantidade, qty_desta_loc: qtyDestaLoc,
          ...(emNomeDe ? { criado_por_id: user.id, criado_por_nome: user.nome } : {}),
        });
        restante -= qtyDestaLoc;
      }
      if (restante > 0) {
        await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
        await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
        return NextResponse.json({ erro: `Falha interna: cobertura insuficiente pra ${item.sku}`, sku: item.sku }, { status: 500 });
      }
    }

    const { error: bdErr } = await supabase.rpc("wms_vender_baixa_direta_atomico", {
      p_origem_venda_id: origemVendaId,
      p_pedido_id_manual: pedidoId,
      p_empresa_vendedora_id: empresa_origem_id,
      p_cliente_nome: cliente_nome,
      p_movs: movsPayload,
      p_usuario_id: user.id,
    });
    if (bdErr) {
      // Tudo-ou-nada: a RPC rolou back as movs. Limpa o cabeçalho de pedido
      // criado antes (sem movs órfãs no ledger).
      await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
      await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
      return NextResponse.json({ erro: `Falha ao baixar venda: ${bdErr.message}` }, { status: 409 });
    }
  }
```

Remover o `rollbackBaixaDireta` helper (514-538) e o array `movsCriadas` (512) — ficaram órfãos (a RPC faz o rollback no banco). Remover import órfão `estornarMovimentacao` em `vendas/criar/route.ts` SE não usado em outro ponto (verificar com grep).

- [ ] **Step 4 — RODAR e ver passar.** `npm run scenarios -- :only 83` (Expected: PASS) + `npm run build` (Expected: OK).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "refactor(wms): vendas/criar baixa_direta via RPC atômica — não deleta pedido com estorno incompleto (P075)"`

### Task 5.3: Migration — RPC `wms_cancelar_venda_atomico`

**Files:**
- Create: `supabase/migrations/20260609b_rpc_cancelar_venda_atomico.sql`
- Test: `test/integration/cancelar-venda-rpc.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/cancelar-venda-rpc.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-CANC-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
});

describe("wms_cancelar_venda_atomico", () => {
  it("estorna todas as S da venda + marca pedido cancelado numa tx; idempotente", async () => {
    const pedidoId = "MAN-cancel-1";
    const origemId = crypto.randomUUID();
    await sb.from("siso_pedidos").insert({ id: pedidoId, status: "concluido" });
    // 2 S da mesma venda (origem_detalhes.pedido_id_manual)
    for (const q of [3, 2]) {
      await sb.rpc("wms_inserir_movimentacao", {
        p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
        p_tipo: "S", p_quantidade: q, p_origem_tipo: "venda_manual", p_origem_id: origemId,
        p_origem_detalhes: { pedido_id_manual: pedidoId }, p_empresa_vendedora_id: empresaId,
        p_pedido_id: pedidoId, p_motivo: "venda",
      });
    }
    // pós-vendas: saldo 5
    const { data, error } = await sb.rpc("wms_cancelar_venda_atomico", {
      p_pedido_id: pedidoId, p_usuario_id: null, p_motivo: "cancelamento teste",
    });
    expect(error).toBeNull();
    expect((data as { movs_estornadas: number }).movs_estornadas).toBe(2);
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(10); // devolvido
    const { data: ped } = await sb.from("siso_pedidos").select("status").eq("id", pedidoId).single();
    expect((ped as { status: string }).status).toBe("cancelado");
    // 2ª chamada: idempotente
    const r2 = await sb.rpc("wms_cancelar_venda_atomico", { p_pedido_id: pedidoId, p_usuario_id: null, p_motivo: "x" });
    expect((r2.data as { movs_estornadas: number }).movs_estornadas).toBe(0);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- cancelar-venda-rpc`. Expected: FAIL com função não encontrada.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260609b_rpc_cancelar_venda_atomico.sql`:

```sql
-- Fase 5 (P077) — RPC wms_cancelar_venda_atomico: estorna todas as S de uma
-- venda baixa_direta (match por origem_detalhes->>'pedido_id_manual') + marca
-- pedido cancelado na MESMA transação. As N devoluções são bloco indivisível:
-- só marca cancelado se todas estornarem; falha rola back tudo. Idempotente:
-- pula S que já têm E counter (re-cancelamento → movs_estornadas=0).
CREATE OR REPLACE FUNCTION public.wms_cancelar_venda_atomico(
  p_pedido_id text,
  p_usuario_id uuid DEFAULT NULL,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_s RECORD;
  v_estornadas integer := 0;
  v_status text;
BEGIN
  SELECT status INTO v_status FROM siso_pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pedido % não encontrado', p_pedido_id USING ERRCODE = 'P0002'; END IF;
  IF v_status = 'cancelado' THEN
    RETURN jsonb_build_object('movs_estornadas', 0, 'idempotente', true);
  END IF;

  FOR v_s IN
    SELECT id, produto_id, galpao_id, localizacao_id, quantidade
      FROM siso_movimentacoes
     WHERE tipo = 'S' AND origem_tipo = 'venda_manual'
       AND origem_detalhes->>'pedido_id_manual' = p_pedido_id
       AND NOT EXISTS (SELECT 1 FROM siso_movimentacoes e WHERE e.tipo='E' AND e.estorno_de = siso_movimentacoes.id)
     FOR UPDATE
  LOOP
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_s.produto_id, p_galpao_id := v_s.galpao_id, p_localizacao_id := v_s.localizacao_id,
      p_tipo := 'E', p_quantidade := v_s.quantidade, p_origem_tipo := 'estorno', p_origem_id := p_pedido_id,
      -- marker 'cancelamento_rpc' prova que o estorno saiu por ESTA RPC (não pelo
      -- loop JS antigo) — assert distintivo no wrapper (RED da Task 5.4).
      p_origem_detalhes := jsonb_build_object('motivo', COALESCE(p_motivo,'cancelamento'), 'reversal', true, 'cancelamento_rpc', true),
      p_estorno_de := v_s.id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := 'Cancelamento venda manual: ' || COALESCE(p_motivo,'')
    );
    v_estornadas := v_estornadas + 1;
  END LOOP;

  UPDATE siso_pedidos SET status = 'cancelado' WHERE id = p_pedido_id;
  RETURN jsonb_build_object('movs_estornadas', v_estornadas, 'idempotente', false);
END;
$function$;
```

Aplicar via `mcp__supabase__apply_migration` (name: `rpc_cancelar_venda_atomico`).

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- cancelar-venda-rpc`. Expected: PASS.

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260609b_rpc_cancelar_venda_atomico.sql test/integration/cancelar-venda-rpc.test.ts && git commit -m "feat(wms): RPC wms_cancelar_venda_atomico — N devoluções indivisíveis + status (P077)"`

### Task 5.4: `cancelarVendaManual` (caminho baixa_direta) delega à RPC

**Files:**
- Modify: `src/lib/wms/vendas-cancelamento.ts:91-148`

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Estender `test/integration/cancelar-venda-rpc.test.ts` exercitando o wrapper. O assert do marker `cancelamento_rpc` é o **RED determinístico**: o loop JS antigo estorna via `estornarMovimentacao` (que NÃO grava esse marker no `origem_detalhes`), então o assert só fica verde quando o wrapper delega à RPC:

```typescript
import { cancelarVendaManual } from "../../src/lib/wms/vendas-cancelamento";

// uuid de usuário real pro p_usuario_id (não reusar empresaId).
let userId: string;
beforeAll(async () => {
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  userId = u!.id;
});

describe("cancelarVendaManual baixa_direta (wrapper → RPC)", () => {
  it("estorna via RPC (marker distintivo) + marca cancelado", async () => {
    const pedidoId = "MAN-cancel-w1";
    const origemId = crypto.randomUUID();
    await sb.from("siso_pedidos").insert({ id: pedidoId, status: "concluido" });
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 4, p_origem_tipo: "venda_manual", p_origem_id: origemId,
      p_origem_detalhes: { pedido_id_manual: pedidoId }, p_empresa_vendedora_id: empresaId,
      p_pedido_id: pedidoId, p_motivo: "venda",
    });
    const r = await cancelarVendaManual({ pedido_id: pedidoId, usuario_id: userId, motivo: "cancela wrapper" });
    expect(r.movsEstornadas).toBe(1); // 1 mov S estornada
    const { data: ped } = await sb.from("siso_pedidos").select("status").eq("id", pedidoId).single();
    expect((ped as { status: string }).status).toBe("cancelado");
    // RED DISTINTIVO: o estorno-E carrega o marker que SÓ a RPC grava.
    const { data: estornos } = await sb.from("siso_movimentacoes")
      .select("origem_detalhes")
      .eq("tipo", "E").eq("origem_tipo", "estorno").eq("pedido_id", pedidoId);
    expect((estornos ?? []).length).toBe(1);
    expect((estornos![0] as { origem_detalhes: Record<string, unknown> }).origem_detalhes.cancelamento_rpc).toBe(true);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- cancelar-venda-rpc`. Expected: **FALHA** contra o código antigo — o loop JS de `cancelarVendaManual` estorna via `estornarMovimentacao`, cujo `origem_detalhes` NÃO contém `cancelamento_rpc`, então `origem_detalhes.cancelamento_rpc).toBe(true)` falha. Esse é o RED determinístico que SÓ fica verde quando a Step 3 troca o loop pela RPC `wms_cancelar_venda_atomico` (que estampa o marker e marca cancelado na mesma tx).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `vendas-cancelamento.ts`, manter o caminho 1 (libera R em `aguardando_separacao/aguardando_compra`, 70-89) e substituir o caminho 2 (95-130: busca movs + loop de estorno + update status) por uma única chamada à RPC. Reproduzir o `registrarEvento` EXATO do arquivo atual (linhas 132-145), sem elisão:

```typescript
  // Caminho 2: baixa direta — estorno das N S + status na MESMA tx via RPC.
  const { data: rpcRes, error: rpcErr } = await sb.rpc("wms_cancelar_venda_atomico", {
    p_pedido_id: input.pedido_id,
    p_usuario_id: input.usuario_id,
    p_motivo: input.motivo,
  });
  if (rpcErr) throw new Error(`falha ao cancelar venda: ${rpcErr.message}`);
  movsEstornadas = Number((rpcRes as { movs_estornadas: number }).movs_estornadas);

  // Audit fire-and-forget (idêntico ao bloco original 132-145).
  registrarEvento({
    pedidoId: input.pedido_id,
    evento: "cancelado",
    usuarioId: input.usuario_id,
    detalhes: {
      motivo: input.motivo,
      movs_estornadas: movsEstornadas,
      reservas_liberadas: reservasLiberadas,
      origem: "cancelarVendaManual",
    },
  }).catch(() => {
    /* fire-and-forget */
  });

  return { movsEstornadas, reservasLiberadas };
```

Remover o `UPDATE status='cancelado'` JS (123-130) — a RPC já faz. No caminho 1 (só reservas), ainda é preciso marcar cancelado: manter o UPDATE somente nesse ramo, ou chamar a RPC também (ela só estorna S de venda_manual; em caminho 1 não há S, então `movs_estornadas=0` e marca cancelado igual). Simplificar: SEMPRE chamar a RPC após o caminho 1 (ela marca cancelado e estorna 0 quando não há S). Remover import órfão `estornarMovimentacao` se não usado.

> Nota: divergência do achado — o achado falava em "atomicidade entre liberarReserva e update no caminho R". A liberação de R já é idempotente (`estornarReservaIndividual`); marcar cancelado via a mesma RPC unifica os dois caminhos sob um único UPDATE de status, simplificando sem RPC adicional.

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- cancelar-venda-rpc` (Expected: PASS) + `npm run build` (Expected: OK).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "refactor(wms): cancelarVendaManual baixa_direta via RPC atômica (P077)"`

### Task 5.5: erros-conhecidos.yaml

- [ ] Adicionar 2 entradas:

```yaml
  - id: venda-baixa-direta-rollback-best-effort
    date: "2026-06-09"
    source: wms/vendas/criar
    category: business_logic
    message: "Venda baixa_direta inseria N movs S em loop JS e, na falha, fazia rollback best-effort que SEGUIA deletando pedido/itens mesmo com estorno incompleto — estoque meio-revertido."
    cause: >
      vendas/criar/route.ts:514-634 estornava movsCriadas uma a uma e deletava o
      pedido incondicionalmente (536-537); sem advisory lock nem tx.
    fix: >
      RPC wms_vender_baixa_direta_atomico: advisory lock por tripla + N S na
      mesma tx; falha rola back tudo no banco. Rota monta o payload e só limpa o
      cabeçalho de pedido se a RPC lançou.
    files:
      - supabase/migrations/20260609_rpc_vender_baixa_direta_atomico.sql
      - src/app/api/wms/vendas/criar/route.ts
    tags: [vendas, baixa-direta, atomicidade, advisory-lock, ledger, rpc]
  - id: cancelar-venda-nao-atomico
    date: "2026-06-09"
    source: wms/vendas-cancelamento
    category: business_logic
    message: "Cancelamento de venda baixa_direta estornava as N S uma a uma e marcava cancelado mesmo com estorno parcial — devolução incompleta + pedido cancelado incoerente."
    cause: >
      vendas-cancelamento.ts:95-130 iterava as movs estornando em loop JS; o
      update status='cancelado' rodava no fim independente do resultado.
    fix: >
      RPC wms_cancelar_venda_atomico estorna todas as S + marca cancelado na
      MESMA tx (bloco indivisível); idempotente (pula S com E counter).
    files:
      - supabase/migrations/20260609b_rpc_cancelar_venda_atomico.sql
      - src/lib/wms/vendas-cancelamento.ts
    tags: [vendas, cancelamento, atomicidade, ledger, rpc]
```

- [ ] **COMMIT.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): venda baixa-direta + cancelamento atômicos (P075, P077)"`

---

## PR 6: Enqueue durável + atômico da aprovação (RPC `wms_aprovar_e_enfileirar`) com retry [P005]

> **Contexto (lido de `src/app/api/wms/pedidos/aprovar/route.ts:308-359`):** O `UPDATE status='executando'` do pedido e o `INSERT` na `siso_fila_execucao` são duas operações independentes; em `queueError` o código só loga e segue ("Don't fail — order status já atualizado") → estado fantasma "aprovado sem job". A nota pede: repetir automaticamente se falhar + sistema tolerante a duplicatas. O worker (`execution-worker-wms.ts:103-130`) já é idempotente por reserva (`estorno_de`).

### Task 6.1: Migration — RPC `wms_aprovar_e_enfileirar`

**Files:**
- Create: `supabase/migrations/20260610_rpc_aprovar_e_enfileirar.sql`
- Test: `test/integration/aprovar-enfileirar-rpc.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/aprovar-enfileirar-rpc.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let empresaId: string;

beforeAll(async () => {
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
});

describe("wms_aprovar_e_enfileirar", () => {
  it("atualiza pedido + insere job na MESMA tx", async () => {
    const pedidoId = "720000001";
    await sb.from("siso_pedidos").insert({ id: pedidoId, status: "pendente" });
    const { error } = await sb.rpc("wms_aprovar_e_enfileirar", {
      p_pedido_id: pedidoId, p_decisao: "propria", p_status_separacao: "aguardando_nf",
      p_empresa_id: empresaId, p_filial_execucao: "CWB",
      p_operador_id: null, p_operador_nome: null, p_marcadores: null,
      p_separacao_galpao_id: null,
    });
    expect(error).toBeNull();
    const { data: ped } = await sb.from("siso_pedidos").select("status, decisao_final").eq("id", pedidoId).single();
    expect((ped as { status: string }).status).toBe("executando");
    expect((ped as { decisao_final: string }).decisao_final).toBe("propria");
    const { data: jobs } = await sb.from("siso_fila_execucao").select("id, tipo, status").eq("pedido_id", pedidoId);
    expect(jobs!.length).toBe(1);
    expect((jobs![0] as { tipo: string }).tipo).toBe("lancar_estoque");
  });

  it("idempotente: 2ª chamada não duplica job (status já executando)", async () => {
    const pedidoId = "720000002";
    await sb.from("siso_pedidos").insert({ id: pedidoId, status: "pendente" });
    const args = {
      p_pedido_id: pedidoId, p_decisao: "propria", p_status_separacao: "aguardando_nf",
      p_empresa_id: empresaId, p_filial_execucao: "CWB",
      p_operador_id: null, p_operador_nome: null, p_marcadores: null, p_separacao_galpao_id: null,
    };
    await sb.rpc("wms_aprovar_e_enfileirar", args);
    await sb.rpc("wms_aprovar_e_enfileirar", args);
    const { data: jobs } = await sb.from("siso_fila_execucao").select("id").eq("pedido_id", pedidoId).eq("tipo", "lancar_estoque");
    expect(jobs!.length).toBe(1);
  });

  // ATOMICIDADE (cura do estado-fantasma): se o INSERT da fila falha, o UPDATE
  // de status TAMBÉM rola back. Injeta a falha via p_filial_execucao inválido
  // (viola chk_fila_filial IN ('CWB','SP')) e prova que o pedido NÃO ficou
  // 'executando' sem job — o estado fantasma do código antigo.
  it("atômico: INSERT da fila falha → status NÃO muda (sem aprovado-sem-job)", async () => {
    const pedidoId = "720000003";
    await sb.from("siso_pedidos").insert({ id: pedidoId, status: "pendente" });
    const { error } = await sb.rpc("wms_aprovar_e_enfileirar", {
      p_pedido_id: pedidoId, p_decisao: "propria", p_status_separacao: "aguardando_nf",
      p_empresa_id: empresaId, p_filial_execucao: "FILIAL_INVALIDA", // viola chk_fila_filial
      p_operador_id: null, p_operador_nome: null, p_marcadores: null, p_separacao_galpao_id: null,
    });
    expect(error).not.toBeNull(); // a tx inteira aborta (CHECK violation)
    const { data: ped } = await sb.from("siso_pedidos").select("status, decisao_final").eq("id", pedidoId).single();
    expect((ped as { status: string }).status).toBe("pendente"); // UPDATE rolou back junto
    expect((ped as { decisao_final: string | null }).decisao_final).toBeNull();
    const { data: jobs } = await sb.from("siso_fila_execucao").select("id").eq("pedido_id", pedidoId);
    expect((jobs ?? []).length).toBe(0); // nenhum job (nem o que falhou)
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- aprovar-enfileirar-rpc`. Expected: FAIL com função não encontrada (`could not find function public.wms_aprovar_e_enfileirar`) nos 3 casos. O caso de atomicidade depende da migration relaxar `chk_fila_filial`? NÃO — ele PROVA que a violação do CHECK aborta a tx; o CHECK `IN ('CWB','SP')` continua valendo na Task 6.1 (o relaxamento pra jobs de manutenção é só PR8, tipo/filial diferentes). Logo `FILIAL_INVALIDA` viola o CHECK e a tx inteira (UPDATE+INSERT) rola back — exatamente o que o caso assere.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260610_rpc_aprovar_e_enfileirar.sql`:

```sql
-- Fase 5 (P005) — RPC wms_aprovar_e_enfileirar: transição de status do pedido +
-- INSERT do job lancar_estoque na MESMA transação. Mata o estado fantasma
-- "aprovado sem job" (o INSERT da fila era best-effort). Idempotente: só
-- enfileira se não há job pendente/executando do mesmo pedido (dedup por
-- pedido+tipo). O UPDATE é condicional ao status atual pra não regredir.
CREATE OR REPLACE FUNCTION public.wms_aprovar_e_enfileirar(
  p_pedido_id text,
  p_decisao text,
  p_status_separacao text,
  p_empresa_id uuid,
  p_filial_execucao text,
  p_operador_id text DEFAULT NULL,
  p_operador_nome text DEFAULT NULL,
  p_marcadores jsonb DEFAULT NULL,
  p_separacao_galpao_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_existe boolean;
  v_job_id uuid;
BEGIN
  PERFORM 1 FROM siso_pedidos WHERE id = p_pedido_id FOR UPDATE;

  UPDATE siso_pedidos
     SET status = 'executando',
         decisao_final = p_decisao,
         operador_id = p_operador_id,
         operador_nome = p_operador_nome,
         tipo_resolucao = 'manual',
         marcadores = COALESCE(p_marcadores, marcadores),
         separacao_galpao_id = p_separacao_galpao_id,
         status_separacao = p_status_separacao
   WHERE id = p_pedido_id;

  -- Dedup: já há job vivo pro pedido?
  SELECT EXISTS(
    SELECT 1 FROM siso_fila_execucao
     WHERE pedido_id = p_pedido_id AND tipo = 'lancar_estoque'
       AND status IN ('pendente','executando')
  ) INTO v_existe;

  IF NOT v_existe THEN
    INSERT INTO siso_fila_execucao (pedido_id, tipo, filial_execucao, empresa_id, decisao, operador_id, operador_nome)
    VALUES (p_pedido_id, 'lancar_estoque', p_filial_execucao, p_empresa_id, p_decisao, p_operador_id, p_operador_nome)
    RETURNING id INTO v_job_id;
  END IF;

  RETURN jsonb_build_object('enfileirado', (v_job_id IS NOT NULL), 'job_id', v_job_id);
END;
$function$;
```

Aplicar via `mcp__supabase__apply_migration` (name: `rpc_aprovar_e_enfileirar`).

> Nota: a RPC só cobre o caso `decisao != 'oc'` (que enfileira `lancar_estoque`). Para `decisao='oc'`, a rota `aprovar` seta `status_separacao=null` e NÃO enfileira — o caller passa `p_status_separacao=null` e a RPC ainda insere job? Sim, o caller só chama a RPC quando há job a enfileirar; para OC, manter o UPDATE direto (ver Task 6.2). A RPC é específica do caminho que enfileira.

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- aprovar-enfileirar-rpc`. Expected: PASS.

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260610_rpc_aprovar_e_enfileirar.sql test/integration/aprovar-enfileirar-rpc.test.ts && git commit -m "feat(wms): RPC wms_aprovar_e_enfileirar — status + job na mesma tx (P005)"`

### Task 6.2: `aprovar/route.ts` usa a RPC + retry no caminho que enfileira

**Files:**
- Modify: `src/app/api/wms/pedidos/aprovar/route.ts:308-359`

Steps:

> **Onde mora o RED da atomicidade (verificado):** o estado-fantasma "aprovado sem job" do código antigo é exatamente o que a Task 6.1 prova no nível da RPC (caso `atômico: INSERT da fila falha → status NÃO muda`). Via HTTP isso NÃO é injetável determinísticamente — o route computa `filialExecucao` internamente (sempre 'CWB'/'SP' válidos), então não há como forçar o INSERT da fila a falhar por um único POST. **Importante:** já existe `uq_fila_release_pedido` UNIQUE `(pedido_id) WHERE tipo='lancar_estoque' AND status='pendente'` (migration `20260527_fila_execucao_release_unique.sql`), então o duplo-clique no código ANTIGO **não** duplica silenciosamente — o 2º INSERT estoura 23505 (engolido como `queueError`, "Don't fail"). Logo "se duplicar é RED" estava errado. O RED determinístico do route é a **mudança de durabilidade**: a 2ª aprovação (duplo-clique) deve responder **200 com 1 job** (a RPC dedupa graciosamente, sem 23505), enquanto o caminho antigo loga `queueError` (23505) na 2ª — o cenário assere o nº de jobs E o status, e o caso de durabilidade (falha de enqueue → 500, não 200 cego) é coberto pela Task 6.1.

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar cenário E2E `scripts/wms/cenarios/catalogo/84-aprovar-enfileira-duravel.ts`: dispara webhook de transferência (vai pra `pendente`), aprova via `POST /api/wms/pedidos/aprovar {decisao:"transferencia"}`. Asserts:

```typescript
  assertEsperado: async (ctx, setup) => {
    // (a) pedido transicionou pra executando
    const { data: ped } = await ctx.sb.from("siso_pedidos").select("status, decisao_final")
      .eq("id", setup.pedidoId).single();
    if ((ped as any).status !== "executando") throw new Error(`status ${(ped as any).status} != executando`);
    if ((ped as any).decisao_final !== "transferencia") throw new Error("decisao_final != transferencia");
    // (b) EXATAMENTE 1 job lancar_estoque (não 0 = sem estado-fantasma, não 2)
    const { data: jobs } = await ctx.sb.from("siso_fila_execucao")
      .select("id, tipo, status").eq("pedido_id", setup.pedidoId).eq("tipo", "lancar_estoque");
    if ((jobs ?? []).length !== 1) throw new Error(`esperava 1 job, achou ${(jobs ?? []).length}`);
    // (c) duplo-clique: 2ª aprovação responde 200 (NÃO erro) e NÃO cria 2º job.
    const resp2 = await ctx.post(`/api/wms/pedidos/aprovar`, { pedido_id: setup.pedidoId, decisao: "transferencia" });
    if (resp2.status !== 200) throw new Error(`2ª aprovação retornou ${resp2.status} (esperava 200 — RPC dedupa)`);
    const { data: jobs2 } = await ctx.sb.from("siso_fila_execucao")
      .select("id").eq("pedido_id", setup.pedidoId).eq("tipo", "lancar_estoque");
    if ((jobs2 ?? []).length !== 1) throw new Error(`duplo-clique criou ${(jobs2 ?? []).length} jobs`);
  },
```

- [ ] **Step 2 — RODAR e ver falhar.** Esta task é um **wrapper de refactor cujo RED de atomicidade está, por construção, na Task 6.1** (caso `INSERT da fila falha → status NÃO muda` — a única prova determinística da cura do estado-fantasma, não injetável via HTTP porque o route só usa filiais válidas). O cenário 84 aqui é **não-regressão do caminho feliz + idempotência de duplo-clique**. Rodar `npm run scenarios -- :only 84` PRIMEIRO contra o código atual e registrar (no PR) o comportamento observado da 2ª aprovação (status HTTP + nº de jobs): com `uq_fila_release_pedido` já existente, a 2ª aprovação no código antigo estoura 23505 internamente (engolido como `queueError`). Após a Step 3 (RPC com dedup explícito `EXISTS pending job`), a 2ª aprovação NÃO tenta o INSERT — responde 200/1-job sem 23505. Critério verificável da Step 4: assert (c) verde (200 + 1 job) só passa com a RPC; antes dela, o caminho depende do 23505 engolido (frágil). Pré-requisito do GREEN: a Task 6.1 (e seu caso de atomicidade) já aplicada e verde.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `aprovar/route.ts`, no caminho que enfileira (`decisao != 'oc'`), substituir o par UPDATE (309-326) + INSERT fila (340-359) por uma chamada à RPC com retry curto:

```typescript
  if (decisao !== "oc") {
    let enfErr: { message: string } | null = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const { error } = await supabase.rpc("wms_aprovar_e_enfileirar", {
        p_pedido_id: pedidoId,
        p_decisao: decisao,
        p_status_separacao:
          pedido.nota_fiscal_id && pedido.chave_acesso_nf ? "aguardando_separacao" : "aguardando_nf",
        p_empresa_id: empresaExecucaoId,
        p_filial_execucao: filialExecucao,
        p_operador_id: operadorId ?? null,
        p_operador_nome: operadorNome ?? null,
        p_marcadores: marcadores ?? null,
        p_separacao_galpao_id: separacaoGalpaoId,
      });
      if (!error) { enfErr = null; break; }
      enfErr = error;
      logger.warn("aprovar", `Falha enfileirar (tentativa ${tentativa}/3)`, { pedidoId, error: error.message });
      await new Promise((r) => setTimeout(r, 200 * tentativa));
    }
    if (enfErr) {
      // Durabilidade: não respondemos ok cego. O pedido NÃO ficou aprovado-sem-job
      // (a RPC é tudo-ou-nada — se falhou, o status não mudou).
      logger.logError({
        error: new Error(enfErr.message), source: "aprovar",
        message: "Falha durável ao aprovar+enfileirar após 3 tentativas",
        category: "database", requestPath: "/api/wms/pedidos/aprovar", requestMethod: "POST",
        metadata: { pedidoId, decisao },
      });
      return NextResponse.json({ error: "falha_enfileirar", message: enfErr.message }, { status: 500 });
    }
  } else {
    // OC: não enfileira lancar_estoque. UPDATE direto (status_separacao=null).
    const { error: updErr } = await supabase
      .from("siso_pedidos")
      .update({
        status: "executando", decisao_final: decisao,
        operador_id: operadorId ?? null, operador_nome: operadorNome ?? null,
        tipo_resolucao: "manual", marcadores,
        separacao_galpao_id: separacaoGalpaoId, status_separacao: null,
      })
      .eq("id", pedidoId);
    if (updErr) {
      logger.error("aprovar", "Failed to update order (oc)", { pedidoId, supabaseError: updErr.message });
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
  }

  registrarEvento({ pedidoId, evento: "aprovado", usuarioId: operadorId, usuarioNome: operadorNome,
    detalhes: { decisao, filialExecucao, empresaExecucaoId } }).catch(() => {});
```

Remover o bloco antigo de UPDATE (309-337) e INSERT fila (340-359) substituídos. Após o enqueue durável, manter o `kickWorker()` se existia no arquivo (verificar — se a aprovação dependia do worker drenar; o reconciliador já faz kick. Se `aprovar` não kickava, não adicionar — fora de escopo).

- [ ] **Step 4 — RODAR e ver passar.** `npm run scenarios -- :only 84` (Expected: PASS) + `npm run build` (Expected: OK).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "feat(wms): aprovar enfileira via RPC durável com retry 3x — sem estado fantasma (P005)"`

### Task 6.3: erros-conhecidos.yaml

- [ ] Adicionar entrada:

```yaml
  - id: aprovar-enqueue-best-effort
    date: "2026-06-10"
    source: wms/pedidos/aprovar
    category: business_logic
    message: "Aprovar atualizava status do pedido e inseria o job de lancar_estoque separadamente; falha no INSERT só logava ('Don't fail') → pedido aprovado sem tarefa (estado fantasma)."
    cause: >
      aprovar/route.ts:308-359 fazia UPDATE status + INSERT fila como duas
      operações; queueError era engolido.
    fix: >
      RPC wms_aprovar_e_enfileirar faz status + job na MESMA tx (idempotente por
      dedup pedido+tipo). Rota chama com retry 3x e retorna 500 se persistir —
      nunca responde ok cego. Worker já tolera duplicatas por reserva.
    files:
      - supabase/migrations/20260610_rpc_aprovar_e_enfileirar.sql
      - src/app/api/wms/pedidos/aprovar/route.ts
    tags: [aprovacao, fila, durabilidade, atomicidade, rpc]
```

- [ ] **COMMIT.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): aprovar-enqueue-best-effort (P005)"`

---

## PR 7: RPC `wms_reconciliar_retroativo` (lock + idempotência + estorno parcial) — unifica 5 [P152, P150, P151, P147, P148]

> **Contexto (lido de `src/lib/wms/movimentacoes.ts:599-633` e `lancamento-retroativo/[id]/reconciliar/route.ts`):** `reconciliarRetroativo` lê a mov retroativo e SEMPRE insere uma S de estorno da qty total — sem checar estorno pré-existente (P150/P148/P151: duplo-clique e reclique tardio criam 2 estornos), sem saldo disponível atual (P147: estorno parcial quando parte já vendeu), e sem lock (P152: 2 operadores em corrida). **Conflito resolvido no mestre (#7):** 1 RPC `wms_reconciliar_retroativo` com `SELECT ... FOR UPDATE` da mov retroativo (serializa P152) + checagem de estorno existente (P150/P148/P151) + estorno parcial clampado ao disponível (P147).

### Task 7.1: Migration — RPC `wms_reconciliar_retroativo`

**Files:**
- Create: `supabase/migrations/20260610b_rpc_reconciliar_retroativo.sql`
- Test: `test/integration/reconciliar-retroativo-rpc.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/reconciliar-retroativo-rpc.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-RETRO-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
});

async function lancamentoRetroativo(qty: number) {
  const { data: movId } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: qty, p_origem_tipo: "lancamento_retroativo", p_custo_unitario: 10, p_motivo: "retro",
  });
  return (movId.data ?? movId) as string;
}

describe("wms_reconciliar_retroativo", () => {
  it("estorna a qty total quando saldo cobre (idempotente na 2ª = no-op)", async () => {
    const retroId = await lancamentoRetroativo(100);
    // p_compra_mov_id é só tag de rastreio (motivo/origem_detalhes); a RPC NÃO
    // valida existência da compra (isso fica na rota). Reusar retroId é seguro.
    const r1 = await sb.rpc("wms_reconciliar_retroativo", {
      p_retroativo_mov_id: retroId, p_compra_mov_id: retroId, p_usuario_id: null, p_qty_estorno: null,
    });
    expect(r1.error).toBeNull();
    expect((r1.data as { qty_estornada: number }).qty_estornada).toBe(100);
    // 2ª chamada (duplo-clique/reclique tardio): no-op idempotente
    const r2 = await sb.rpc("wms_reconciliar_retroativo", {
      p_retroativo_mov_id: retroId, p_compra_mov_id: retroId, p_usuario_id: null, p_qty_estorno: null,
    });
    expect(r2.error).toBeNull();
    expect((r2.data as { idempotente: boolean }).idempotente).toBe(true);
  });

  it("estorno PARCIAL: parte já vendida → estorna só o disponível (P147)", async () => {
    const retroId = await lancamentoRetroativo(70);
    // vende 50 do saldo → disponível 20
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 50, p_origem_tipo: "venda_manual", p_motivo: "vendeu",
    });
    const r = await sb.rpc("wms_reconciliar_retroativo", {
      p_retroativo_mov_id: retroId, p_compra_mov_id: retroId, p_usuario_id: null, p_qty_estorno: 20,
    });
    expect(r.error).toBeNull();
    expect((r.data as { qty_estornada: number }).qty_estornada).toBe(20);
  });

  // PROVA O CLAMP (não o pass-through do arg): p_qty_estorno=null e o que
  // decide a qty é o disponível atual. Retroativo 70, vende 50 → disponível 20.
  // Com arg null, qty_estornada SÓ pode ser 20 se o clamp ao disponível agir
  // (LEAST(COALESCE(null,70), 70, 20) = 20). Marca parcial=true.
  it("estorno PARCIAL com p_qty_estorno=null → clampa ao disponível (não ao arg)", async () => {
    const retroId = await lancamentoRetroativo(70);
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 50, p_origem_tipo: "venda_manual", p_motivo: "vendeu antes da reconciliação",
    });
    const r = await sb.rpc("wms_reconciliar_retroativo", {
      p_retroativo_mov_id: retroId, p_compra_mov_id: retroId, p_usuario_id: null, p_qty_estorno: null,
    });
    expect(r.error).toBeNull();
    const d = r.data as { qty_estornada: number; qty_original: number; parcial: boolean };
    expect(d.qty_estornada).toBe(20);   // o disponível (20) decidiu, não o arg (null→70)
    expect(d.qty_original).toBe(70);
    expect(d.parcial).toBe(true);
  });
});
```

> Nota: `p_compra_mov_id` na RPC é usado APENAS como tag de rastreio (entra no `motivo` e em `origem_detalhes.compra_mov_id`) — a RPC NÃO valida existência da compra (essa validação fica na ROTA `reconciliar/route.ts`, que resolve a mov de compra real antes de chamar o wrapper). Por isso reusar `retroId` nos testes da RPC é seguro e determinístico; não é um placeholder a "consertar".

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- reconciliar-retroativo-rpc`. Expected: FAIL com função não encontrada.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260610b_rpc_reconciliar_retroativo.sql`:

```sql
-- Fase 5 (P152/P150/P151/P147/P148) — RPC wms_reconciliar_retroativo unifica:
--   P152: FOR UPDATE da mov retroativo serializa 2 operadores concorrentes.
--   P150/P148/P151: checa estorno pré-existente (estorno_de=retro) → no-op
--          idempotente (duplo-clique e reclique tardio respondem sucesso).
--   P147: estorno PARCIAL clampado ao disponível atual; aceita p_qty_estorno;
--          default = min(qty_original, disponível). Grava qty_original vs
--          qty_estornada em origem_detalhes.
CREATE OR REPLACE FUNCTION public.wms_reconciliar_retroativo(
  p_retroativo_mov_id uuid,
  p_compra_mov_id uuid,
  p_usuario_id uuid DEFAULT NULL,
  p_qty_estorno numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_retro RECORD;
  v_ja_estornado boolean;
  v_disponivel numeric;
  v_qty numeric;
BEGIN
  -- P152: trava a mov retroativo (serializa concorrência).
  SELECT id, produto_id, galpao_id, localizacao_id, quantidade, origem_tipo
    INTO v_retro FROM siso_movimentacoes WHERE id = p_retroativo_mov_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lançamento retroativo % não encontrado', p_retroativo_mov_id USING ERRCODE='P0002'; END IF;
  IF v_retro.origem_tipo <> 'lancamento_retroativo' THEN
    RAISE EXCEPTION 'mov % não é um lançamento retroativo', p_retroativo_mov_id USING ERRCODE='22023';
  END IF;

  -- P150/P148/P151: já reconciliado? (existe estorno ligado a este lançamento)
  SELECT EXISTS(
    SELECT 1 FROM siso_movimentacoes WHERE estorno_de = p_retroativo_mov_id AND tipo = 'S'
  ) INTO v_ja_estornado;
  IF v_ja_estornado THEN
    RETURN jsonb_build_object('idempotente', true, 'qty_estornada', 0, 'mensagem', 'lançamento já reconciliado');
  END IF;

  -- P147: estorno parcial clampado ao disponível atual.
  SELECT COALESCE(saldo - reservado, 0) INTO v_disponivel FROM siso_estoque
    WHERE produto_id = v_retro.produto_id AND galpao_id = v_retro.galpao_id AND localizacao_id = v_retro.localizacao_id;
  v_qty := LEAST(COALESCE(p_qty_estorno, v_retro.quantidade), v_retro.quantidade, GREATEST(v_disponivel, 0));
  IF v_qty <= 0 THEN
    RAISE EXCEPTION 'sem saldo disponível para estornar (disponível=%)', v_disponivel USING ERRCODE='22023';
  END IF;

  PERFORM wms_inserir_movimentacao(
    p_produto_id := v_retro.produto_id, p_galpao_id := v_retro.galpao_id, p_localizacao_id := v_retro.localizacao_id,
    p_tipo := 'S', p_quantidade := v_qty, p_origem_tipo := 'estorno', p_estorno_de := p_retroativo_mov_id,
    p_usuario_id := p_usuario_id, p_motivo := 'reconciliado com mov ' || p_compra_mov_id::text,
    p_origem_detalhes := jsonb_build_object('compra_mov_id', p_compra_mov_id,
      'qty_original', v_retro.quantidade, 'qty_estornada', v_qty, 'parcial', (v_qty < v_retro.quantidade))
  );

  RETURN jsonb_build_object('idempotente', false, 'qty_estornada', v_qty,
    'qty_original', v_retro.quantidade, 'parcial', (v_qty < v_retro.quantidade));
END;
$function$;
```

Aplicar via `mcp__supabase__apply_migration` (name: `rpc_reconciliar_retroativo`).

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- reconciliar-retroativo-rpc`. Expected: PASS.

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260610b_rpc_reconciliar_retroativo.sql test/integration/reconciliar-retroativo-rpc.test.ts && git commit -m "feat(wms): RPC wms_reconciliar_retroativo — lock + idempotência + estorno parcial (P152, P150, P151, P147, P148)"`

### Task 7.2: `reconciliarRetroativo` delega à RPC + rota aceita qty_estorno e mapeia no-op

**Files:**
- Modify: `src/lib/wms/movimentacoes.ts:593-633`
- Modify: `src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts:26-79`

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Estender `test/integration/reconciliar-retroativo-rpc.test.ts` exercitando o wrapper:

```typescript
import { reconciliarRetroativo } from "../../src/lib/wms/movimentacoes";

describe("reconciliarRetroativo (wrapper → RPC)", () => {
  it("retorna { idempotente, qtyEstornada } e é no-op na 2ª chamada", async () => {
    const retroId = await lancamentoRetroativo(30);
    const r1 = await reconciliarRetroativo({ retroativo_mov_id: retroId, compra_mov_id: retroId, usuario_id: "00000000-0000-4000-8000-000000000001" });
    expect(r1.qtyEstornada).toBe(30);
    const r2 = await reconciliarRetroativo({ retroativo_mov_id: retroId, compra_mov_id: retroId, usuario_id: "00000000-0000-4000-8000-000000000001" });
    expect(r2.idempotente).toBe(true);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- reconciliar-retroativo-rpc`. Expected: FAIL — `reconciliarRetroativo` retorna `void` (não `{idempotente, qtyEstornada}`) e não é idempotente (2ª chamada lança/duplica).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `movimentacoes.ts`, trocar a assinatura e o corpo de `reconciliarRetroativo`:

```typescript
export interface ReconciliarRetroativoInput {
  retroativo_mov_id: string;
  compra_mov_id: string;
  usuario_id: string;
  qty_estorno?: number;
}

export async function reconciliarRetroativo(
  input: ReconciliarRetroativoInput,
): Promise<{ idempotente: boolean; qtyEstornada: number; parcial?: boolean }> {
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_reconciliar_retroativo", {
    p_retroativo_mov_id: input.retroativo_mov_id,
    p_compra_mov_id: input.compra_mov_id,
    p_usuario_id: input.usuario_id,
    p_qty_estorno: input.qty_estorno ?? null,
  });
  if (error) throw error;
  const r = data as { idempotente: boolean; qty_estornada: number; parcial?: boolean };
  logger.info("wms.movs", "lançamento retroativo reconciliado", {
    retro: input.retroativo_mov_id, compra: input.compra_mov_id,
    idempotente: r.idempotente, qty: r.qty_estornada,
  });
  return { idempotente: r.idempotente, qtyEstornada: r.qty_estornada, parcial: r.parcial };
}
```

Em `reconciliar/route.ts`, aceitar `body.qty_estorno` (opcional) e mapear o no-op idempotente pra 200 com mensagem clara (em vez de 400 "saldo insuficiente"):

```typescript
  try {
    const r = await reconciliarRetroativo({
      retroativo_mov_id: id,
      compra_mov_id: compraMovId,
      usuario_id: auth.user.id,
      qty_estorno: body.qty_estorno != null ? Number(body.qty_estorno) : undefined,
    });
    if (r.idempotente) {
      return NextResponse.json({ ok: true, idempotente: true, mensagem: "lançamento já reconciliado" });
    }
    return NextResponse.json({ ok: true, qty_estornada: r.qtyEstornada, parcial: r.parcial });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isSemSaldo = /sem saldo disponível/i.test(msg);
    return wmsErrorResponse({
      source: "wms.lancamento-retroativo.reconciliar",
      error: e,
      status: isSemSaldo ? 409 : 400,
      requestPath: `/api/wms/lancamento-retroativo/${id}/reconciliar`,
      requestMethod: "POST",
      metadata: { retroativo_mov_id: id, compra_mov_id: compraMovId },
    });
  }
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- reconciliar-retroativo-rpc` (Expected: PASS) + `npm run build` (Expected: OK — verificar callers de `reconciliarRetroativo` que esperavam `void`; ajustar se houver).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "refactor(wms): reconciliarRetroativo via RPC — idempotente + parcial + 409 sem-saldo (P152, P150, P151, P147, P148)"`

### Task 7.3: erros-conhecidos.yaml

- [ ] Adicionar entrada (unificada):

```yaml
  - id: reconciliar-retroativo-nao-idempotente-sem-lock
    date: "2026-06-10"
    source: wms/movimentacoes/reconciliarRetroativo
    category: business_logic
    message: "Reconciliar lançamento retroativo sempre estornava a qty total sem checar estorno prévio (duplo-clique/reclique dobrava a baixa), sem saldo disponível (estorno parcial impossível) e sem lock (2 operadores em corrida)."
    cause: >
      movimentacoes.ts:599-633 lia a mov e inseria a S de estorno direto; nenhum
      guard de estorno existente, nenhum FOR UPDATE, nenhum clamp ao disponível.
    fix: >
      RPC wms_reconciliar_retroativo: FOR UPDATE da mov (P152) + checagem de
      estorno existente → no-op idempotente (P150/P148/P151) + estorno parcial
      clampado ao disponível com p_qty_estorno (P147). Rota mapeia no-op→200 e
      sem-saldo→409.
    files:
      - supabase/migrations/20260610b_rpc_reconciliar_retroativo.sql
      - src/lib/wms/movimentacoes.ts
      - src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts
    tags: [retroativo, reconciliacao, idempotencia, lock, estorno-parcial, rpc]
```

- [ ] **COMMIT.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): reconciliar-retroativo idempotente+lock+parcial (P152, P150, P151, P147, P148)"`

---

## PR 8: Durabilidade do reconciliador OC + varredura pós-entrada (jobs com retry 30s/5min/10min) [P082, P149]

> **Contexto (lido de `src/lib/wms/reconciliador-oc.ts:268-336`, `src/lib/wms/ledger.ts:230-263`, `src/lib/execution-worker.ts:112-316`):** A transição do reconciliador (`validacao_oc → aguardando_nf`) roda fire-and-forget dentro do write do ledger; em erro de banco só loga e desiste (P082). A varredura pós-entrada (`varrerPedidosAfetadosPorEntrada` + `reconciliarEntradaEstoque`) também roda inline com try/catch+warn (P149) — falha transitória = pedidos em `validacao_oc` nunca recebem `flag_saldo_apareceu`. A nota pede: enfileirar job durável com retry 3x e backoff custom (30s/5min/10min, NÃO 1h) + alerta visível. O `siso_fila_execucao` tem CHECKs legados que precisam ser relaxados pra novos tipos (`pedido_id NOT NULL`, `filial_execucao NOT NULL`, `chk_fila_tipo`, `chk_fila_decisao`). O worker (`processQueue`) ao concluir faz `UPDATE siso_pedidos status='concluido'` — jobs sem pedido real não podem disparar isso.

### Task 8.1: Migration — relaxar constraints da fila para jobs de manutenção

**Files:**
- Create: `supabase/migrations/20260611_fila_jobs_manutencao.sql`
- Test: `test/integration/fila-jobs-manutencao.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/fila-jobs-manutencao.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("siso_fila_execucao aceita jobs de manutenção", () => {
  it("insere varredura_pos_entrada sem pedido/filial/decisao reais", async () => {
    const { data, error } = await sb.from("siso_fila_execucao").insert({
      pedido_id: "MAINT", tipo: "varredura_pos_entrada", filial_execucao: "MAINT",
      decisao: "manutencao", status: "pendente",
      payload: { produto_id: "00000000-0000-4000-8000-000000000001", galpao_id: "00000000-0000-4000-8000-000000000002", localizacao_id: "00000000-0000-4000-8000-000000000003" },
    }).select("id").single();
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
    await sb.from("siso_fila_execucao").delete().eq("id", data!.id);
  });

  it("insere reconciliar_oc_retry", async () => {
    const { error } = await sb.from("siso_fila_execucao").insert({
      pedido_id: "999111000", tipo: "reconciliar_oc_retry", filial_execucao: "MAINT",
      decisao: "manutencao", status: "pendente",
      payload: { produto_id: "00000000-0000-4000-8000-000000000001", galpao_id: "00000000-0000-4000-8000-000000000002" },
    });
    expect(error).toBeNull();
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- fila-jobs-manutencao`. Expected: FAIL com violação de CHECK (`chk_fila_tipo`/`chk_fila_filial`/`chk_fila_decisao`).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260611_fila_jobs_manutencao.sql`:

```sql
-- Fase 5 (P082/P149) — permite jobs de manutenção na fila (durabilidade do
-- reconciliador OC + varredura pós-entrada). Relaxa os CHECKs legados pra
-- aceitar tipos novos e os valores-sentinela 'MAINT'/'manutencao' nas colunas
-- legadas (filial/decisao) que esses jobs não usam (a info real vai em payload).
ALTER TABLE siso_fila_execucao DROP CONSTRAINT IF EXISTS chk_fila_tipo;
ALTER TABLE siso_fila_execucao ADD CONSTRAINT chk_fila_tipo
  CHECK (tipo IN ('lancar_estoque','lancar_estoque_pos_nf','varredura_pos_entrada','reconciliar_oc_retry'));

ALTER TABLE siso_fila_execucao DROP CONSTRAINT IF EXISTS chk_fila_filial;
ALTER TABLE siso_fila_execucao ADD CONSTRAINT chk_fila_filial
  CHECK (filial_execucao IN ('CWB','SP','MAINT'));

ALTER TABLE siso_fila_execucao DROP CONSTRAINT IF EXISTS chk_fila_decisao;
ALTER TABLE siso_fila_execucao ADD CONSTRAINT chk_fila_decisao
  CHECK (decisao IN ('propria','transferencia','oc','manutencao'));
```

Aplicar via `mcp__supabase__apply_migration` (name: `fila_jobs_manutencao`).

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- fila-jobs-manutencao`. Expected: PASS.

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260611_fila_jobs_manutencao.sql test/integration/fila-jobs-manutencao.test.ts && git commit -m "feat(wms): fila aceita jobs de manutenção (varredura/reconciliar) (P082, P149)"`

### Task 8.2: Handler dos jobs de manutenção no worker + backoff custom

**Files:**
- Modify: `src/lib/execution-worker.ts:138-316` (skip do flip de pedido pra jobs MAINT + dispatch dos novos tipos + backoff custom)
- Modify: `src/lib/wms/varredura-validacao-oc.ts` (expor varredura por payload — já exporta `varrerPedidosAfetadosPorEntrada`)
- Create: `src/lib/wms/jobs-manutencao.ts` (helpers de enqueue durável)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `src/lib/wms/jobs-manutencao.test.ts` (unit — testa o cálculo de backoff custom puro):

```typescript
import { describe, it, expect } from "vitest";
import { backoffManutencao } from "./jobs-manutencao";

describe("backoffManutencao — 30s / 5min / 10min (NÃO 1h)", () => {
  it("tentativa 1 → 30s", () => expect(backoffManutencao(1)).toBe(30_000));
  it("tentativa 2 → 5min", () => expect(backoffManutencao(2)).toBe(300_000));
  it("tentativa 3 → 10min", () => expect(backoffManutencao(3)).toBe(600_000));
  it("além de 3 → mantém 10min (não escala pra 1h)", () => expect(backoffManutencao(4)).toBe(600_000));
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm test -- jobs-manutencao`. Expected: FAIL — `backoffManutencao` não existe.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `src/lib/wms/jobs-manutencao.ts`:

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/** Backoff custom dos jobs de manutenção: 30s → 5min → 10min (nota P082). */
export function backoffManutencao(tentativa: number): number {
  if (tentativa <= 1) return 30_000;
  if (tentativa === 2) return 300_000;
  return 600_000; // 3+ → 10min (NÃO escala pra 1h)
}

/** Enfileira um job durável de manutenção (varredura/reconciliar) com 1ª execução imediata. */
export async function enfileirarJobManutencao(input: {
  tipo: "varredura_pos_entrada" | "reconciliar_oc_retry";
  pedido_id?: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const sb = createServiceClient();
  const { error } = await sb.from("siso_fila_execucao").insert({
    pedido_id: input.pedido_id ?? "MAINT",
    tipo: input.tipo,
    filial_execucao: "MAINT",
    decisao: "manutencao",
    status: "pendente",
    max_tentativas: 3,
    payload: input.payload,
  });
  if (error) {
    logger.warn("jobs-manutencao", "falha ao enfileirar job de manutenção", {
      tipo: input.tipo, error: error.message,
    });
  }
}
```

Em `src/lib/execution-worker.ts`:
- (a) No `processQueue`, após `executeJob(job)` com sucesso, **não** rodar o `UPDATE siso_pedidos status='concluido'` pra jobs de manutenção. Envolver as linhas 185-192 em `if (job.tipo === "lancar_estoque" || job.tipo === "lancar_estoque_pos_nf") { ...flip pedido... }`.
- (b) No catch (211-230), usar `backoffManutencao(tentativas)` quando `job.tipo` ∈ manutenção (em vez do `30_000 * 2^(n-1)` exponencial), importando de `./wms/jobs-manutencao`.
- (c) Em `executeJob` (278-316), adicionar dispatch antes do `throw`:

```typescript
  if (job.tipo === "varredura_pos_entrada") {
    const { varrerPedidosAfetadosPorEntrada } = await import("./wms/varredura-validacao-oc");
    const { reconciliarEntradaEstoque } = await import("./wms/reconciliador-oc");
    const p = (job.payload ?? {}) as { produto_id: string; galpao_id: string; localizacao_id?: string };
    await varrerPedidosAfetadosPorEntrada({
      produto_id: p.produto_id, galpao_id: p.galpao_id, localizacao_id: p.localizacao_id ?? "",
    });
    await reconciliarEntradaEstoque({ produtoId: p.produto_id, galpaoId: p.galpao_id });
    return;
  }
  if (job.tipo === "reconciliar_oc_retry") {
    const { reconciliarEntradaEstoque } = await import("./wms/reconciliador-oc");
    const p = (job.payload ?? {}) as { produto_id: string; galpao_id: string };
    await reconciliarEntradaEstoque({ produtoId: p.produto_id, galpaoId: p.galpao_id });
    return;
  }
```

Garantir que `FilaJob` inclui `payload` (o select de `processQueue:126` já traz `payload`; adicionar `payload?: Record<string, unknown>` ao type se faltar).

- [ ] **Step 4 — RODAR e ver passar.** `npm test -- jobs-manutencao` (Expected: PASS) + `npm run build` (Expected: OK).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "feat(wms): worker dispatch + backoff custom 30s/5min/10min p/ jobs de manutenção (P082, P149)"`

### Task 8.3: ledger e reconciliador enfileiram job durável após esgotar inline + alerta

**Files:**
- Modify: `src/lib/wms/ledger.ts:230-263` (varredura inline com fallback durável)
- Modify: `src/lib/wms/reconciliador-oc.ts:278-336` (em pedidoUpdErr → enfileira retry + alerta após esgotar)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar cenário E2E `scripts/wms/cenarios/catalogo/85-varredura-pos-entrada-duravel.ts`: cria pedido OC parado em `validacao_oc` (sem saldo), depois injeta entrada de estoque via `POST /api/wms/ajuste` (mov E). Assert: após a entrada, ou o pedido recebe `flag_saldo_apareceu`/é destravado, OU existe um job `varredura_pos_entrada` na fila (durabilidade). O cenário valida que a varredura não some silenciosamente.

- [ ] **Step 2 — RODAR e ver falhar.** `npm run scenarios -- :only 85`. Expected: contra o código atual, a varredura inline roda mas sem durabilidade — se ela falhar (transitório), nada reexecuta e nenhum job é criado. O RED determinístico: o cenário verifica a EXISTÊNCIA do mecanismo durável (job enfileirado no caminho de fallback) que ainda não existe.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `ledger.ts:240-262`, manter a tentativa inline mas, no `catch`, enfileirar o job durável:

```typescript
    void (async () => {
      try {
        const { varrerPedidosAfetadosPorEntrada } = await import("./varredura-validacao-oc");
        await varrerPedidosAfetadosPorEntrada({
          produto_id: tripla.produto_id, galpao_id: tripla.galpao_id, localizacao_id: tripla.localizacao_id,
        });
        const { reconciliarEntradaEstoque } = await import("./reconciliador-oc");
        await reconciliarEntradaEstoque({ produtoId: tripla.produto_id, galpaoId: tripla.galpao_id });
      } catch (err) {
        logger.warn("ledger", "varredura pós-entrada falhou inline — enfileirando job durável", {
          error: err instanceof Error ? err.message : String(err),
        });
        const { enfileirarJobManutencao } = await import("./jobs-manutencao");
        await enfileirarJobManutencao({
          tipo: "varredura_pos_entrada",
          payload: { produto_id: tripla.produto_id, galpao_id: tripla.galpao_id, localizacao_id: tripla.localizacao_id },
        });
      }
    })();
```

Em `reconciliador-oc.ts`, no `pedidoUpdErr` (278-286), enfileirar retry durável em vez de só logar; e após o job esgotar (3 tentativas), o worker já marca `status='erro'` — adicionar `registrarEvento` de alerta visível quando o retry é criado:

```typescript
  if (pedidoUpdErr) {
    logger.logError({
      error: pedidoUpdErr, source: "reconciliador-oc",
      message: `Falha ao transicionar pedido ${pedidoId} — enfileirando retry durável`,
      category: "database",
    });
    const { enfileirarJobManutencao } = await import("./jobs-manutencao");
    await enfileirarJobManutencao({
      tipo: "reconciliar_oc_retry", pedido_id: pedidoId,
      payload: { produto_id: produtoId, galpao_id: galpaoId },
    });
    const { registrarEvento } = await import("@/lib/historico-service");
    registrarEvento({
      pedidoId, evento: "erro",
      detalhes: { motivo: "reconciliacao_oc_falhou", retry_enfileirado: true },
    }).catch(() => {});
    return;
  }
```

> Nota: `reconciliarEntradaEstoque` recebe `{ produtoId, galpaoId }` (camelCase); confirmar a assinatura ao abrir o arquivo. As variáveis `produtoId`/`galpaoId` precisam estar em escopo no ponto do `pedidoUpdErr` — se a função interna só tem `pedidoId`, passar produto/galpão via closure do caller `reconciliarEntradaEstoque` (subagent ajusta o escopo).

- [ ] **Step 4 — RODAR e ver passar.** `npm run scenarios -- :only 85` (Expected: PASS) + `npm run build` (Expected: OK).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "feat(wms): varredura/reconciliador enfileiram retry durável + alerta após falha (P082, P149)"`

### Task 8.4: erros-conhecidos.yaml

- [ ] Adicionar entrada:

```yaml
  - id: reconciliador-varredura-sem-durabilidade
    date: "2026-06-11"
    source: wms/reconciliador-oc + wms/ledger
    category: infrastructure
    message: "Transição do reconciliador OC e varredura pós-entrada rodavam fire-and-forget no write do ledger; falha transitória só logava e desistia — pedido OC preso e banner 'saldo apareceu' nunca surgia, sem ninguém avisado."
    cause: >
      ledger.ts:230-263 e reconciliador-oc.ts:278-336 chamavam a varredura/transição
      inline com try/catch+warn; nenhum retry, nenhuma fila, nenhum alerta.
    fix: >
      Jobs duráveis na siso_fila_execucao (varredura_pos_entrada,
      reconciliar_oc_retry) com backoff custom 30s/5min/10min + handler no worker
      que NÃO flipa status de pedido; em falha inline, enfileira o job + alerta
      visível via registrarEvento('erro').
    files:
      - supabase/migrations/20260611_fila_jobs_manutencao.sql
      - src/lib/wms/jobs-manutencao.ts
      - src/lib/execution-worker.ts
      - src/lib/wms/ledger.ts
      - src/lib/wms/reconciliador-oc.ts
    tags: [reconciliador, varredura, durabilidade, fila, retry, alerta]
```

- [ ] **COMMIT.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): reconciliador/varredura sem durabilidade (P082, P149)"`

---

## PR 9: Resolução de pedido-fantasma (R→S se saiu, R→prateleira se cancelado) [P084]

> **Contexto (lido de `src/app/api/wms/reconciliacao-pedidos/route.ts` e `supabase/migrations/20260530_wms_detectar_pedidos_inconsistentes.sql`):** O safety-net (GET `/api/wms/reconciliacao-pedidos`) só DETECTA o padrão C (pedido forward — separado/embalado/expedido — com reserva R viva sem L estornando). Não há ação de resolução: as unidades ficam congeladas (nem em saída, nem livres). A nota (P084): o gerente confere a NF e (saiu) converte R→S; (cancelado) devolve à prateleira. O padrão de conversão R→L+S vive em `execution-worker-wms.ts:145-170`; a devolução à prateleira é `estornarReservaIndividual` (`reservas.ts:135`, idempotente). `partially_fixed` — falta só a ação.

### Task 9.1: Migration — RPC `wms_resolver_pedido_fantasma`

**Files:**
- Create: `supabase/migrations/20260611b_rpc_resolver_pedido_fantasma.sql`
- Test: `test/integration/resolver-fantasma-rpc.test.ts` (Create)

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar `test/integration/resolver-fantasma-rpc.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-FANT-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
});

async function pedidoComReservaViva(pedidoId: string, qty: number, statusSep: string) {
  await sb.from("siso_pedidos").insert({ id: pedidoId, status: "executando", status_separacao: statusSep });
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: qty + 5, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
  const expira = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "R", p_quantidade: qty, p_origem_tipo: "reserva_pedido", p_origem_id: pedidoId,
    p_expira_em: expira, p_pedido_id: pedidoId, p_motivo: "reserva",
  });
}

describe("wms_resolver_pedido_fantasma", () => {
  it("acao='saiu': converte R→L+S (reservado zera, saldo baixa)", async () => {
    const pedidoId = "730000001";
    await pedidoComReservaViva(pedidoId, 4, "embalado");
    const { error } = await sb.rpc("wms_resolver_pedido_fantasma", {
      p_pedido_id: pedidoId, p_acao: "saiu", p_empresa_vendedora_id: empresaId, p_usuario_id: null,
    });
    expect(error).toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.reservado)).toBe(0);
    expect(Number(est?.saldo)).toBe(5); // 9 - 4
  });

  it("acao='cancelado': devolve à prateleira (R→L, reservado zera, saldo intacto)", async () => {
    const pedidoId = "730000002";
    await pedidoComReservaViva(pedidoId, 3, "separado");
    const { error } = await sb.rpc("wms_resolver_pedido_fantasma", {
      p_pedido_id: pedidoId, p_acao: "cancelado", p_empresa_vendedora_id: empresaId, p_usuario_id: null,
    });
    expect(error).toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.reservado)).toBe(0);
    expect(Number(est?.saldo)).toBe(8); // 8 - 0 (não saiu)
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- resolver-fantasma-rpc`. Expected: FAIL com função não encontrada.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `supabase/migrations/20260611b_rpc_resolver_pedido_fantasma.sql`:

```sql
-- Fase 5 (P084) — RPC wms_resolver_pedido_fantasma: resolve as R vivas de um
-- pedido forward sem saída (padrão C do safety-net). Numa transação, para cada
-- R viva (sem L estornando):
--   acao='saiu'      → L (estorno_de=R) + S (nf_venda): converte R→saída final.
--   acao='cancelado' → L (estorno_de=R): devolve à prateleira (reservado zera,
--                      saldo intacto). Idempotente (pula R já liberada).
CREATE OR REPLACE FUNCTION public.wms_resolver_pedido_fantasma(
  p_pedido_id text,
  p_acao text,                 -- 'saiu' | 'cancelado'
  p_empresa_vendedora_id uuid DEFAULT NULL,
  p_usuario_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_r RECORD;
  v_resolvidas integer := 0;
BEGIN
  IF p_acao NOT IN ('saiu','cancelado') THEN
    RAISE EXCEPTION 'acao inválida: % (use saiu|cancelado)', p_acao USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM siso_pedidos WHERE id = p_pedido_id FOR UPDATE;

  FOR v_r IN
    SELECT id, produto_id, galpao_id, localizacao_id, quantidade
      FROM siso_movimentacoes
     WHERE tipo='R' AND origem_tipo='reserva_pedido' AND origem_id = p_pedido_id
       AND NOT EXISTS (SELECT 1 FROM siso_movimentacoes l WHERE l.tipo='L' AND l.estorno_de = siso_movimentacoes.id)
     FOR UPDATE
  LOOP
    -- L: libera a reserva (estorno_de=R marca idempotência/conversão).
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_r.produto_id, p_galpao_id := v_r.galpao_id, p_localizacao_id := v_r.localizacao_id,
      p_tipo := 'L', p_quantidade := v_r.quantidade, p_origem_tipo := 'liberacao_reserva', p_origem_id := p_pedido_id,
      p_origem_detalhes := jsonb_build_object('contexto','resolver_fantasma','acao', p_acao),
      p_estorno_de := v_r.id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := 'Resolver fantasma (' || p_acao || ') — libera reserva'
    );

    IF p_acao = 'saiu' THEN
      PERFORM wms_inserir_movimentacao(
        p_produto_id := v_r.produto_id, p_galpao_id := v_r.galpao_id, p_localizacao_id := v_r.localizacao_id,
        p_tipo := 'S', p_quantidade := v_r.quantidade, p_origem_tipo := 'nf_venda', p_origem_id := p_pedido_id,
        p_origem_detalhes := jsonb_build_object('reserva_origem', v_r.id, 'contexto','resolver_fantasma'),
        p_empresa_vendedora_id := p_empresa_vendedora_id, p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
        p_motivo := 'Resolver fantasma — confirma saída'
      );
    END IF;
    v_resolvidas := v_resolvidas + 1;
  END LOOP;

  -- 'cancelado' marca o pedido cancelado (saída não houve). 'saiu' deixa o forward.
  IF p_acao = 'cancelado' THEN
    UPDATE siso_pedidos SET status = 'cancelado' WHERE id = p_pedido_id;
  END IF;

  RETURN jsonb_build_object('reservas_resolvidas', v_resolvidas, 'acao', p_acao);
END;
$function$;
```

Aplicar via `mcp__supabase__apply_migration` (name: `rpc_resolver_pedido_fantasma`).

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- resolver-fantasma-rpc`. Expected: PASS.

- [ ] **Step 5 — COMMIT.** `git add supabase/migrations/20260611b_rpc_resolver_pedido_fantasma.sql test/integration/resolver-fantasma-rpc.test.ts && git commit -m "feat(wms): RPC wms_resolver_pedido_fantasma — R→S (saiu) ou R→prateleira (cancelado) (P084)"`

### Task 9.2: Rota POST de resolução (gate admin + perm visibilidade)

**Files:**
- Create: `src/app/api/wms/reconciliacao-pedidos/[pedidoId]/resolver/route.ts`

Steps:

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Criar cenário E2E `scripts/wms/cenarios/catalogo/86-resolver-pedido-fantasma.ts`: monta um pedido forward com R viva (via SQL no setup), chama `POST /api/wms/reconciliacao-pedidos/{pedidoId}/resolver {acao:"cancelado"}` autenticado como admin, assert que a R foi liberada (reservado zera) e o pedido virou `cancelado`. Inclui um caso negativo: sem header de sessão → 401/403.

- [ ] **Step 2 — RODAR e ver falhar.** `npm run scenarios -- :only 86`. Expected: FAIL com 404 (rota não existe).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Criar `src/app/api/wms/reconciliacao-pedidos/[pedidoId]/resolver/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * POST /api/wms/reconciliacao-pedidos/[pedidoId]/resolver  (P084)
 * Body: { acao: "saiu" | "cancelado" }
 * Resolve o pedido-fantasma (padrão C): R viva sem saída num pedido forward.
 *   saiu      → converte R→L+S (saída final).
 *   cancelado → devolve à prateleira (R→L) + marca pedido cancelado.
 * Gate: admin (mexe no ledger + status).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ pedidoId: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { pedidoId } = await params;
  const body = await req.json().catch(() => null);
  const acao = body?.acao as string | undefined;
  if (acao !== "saiu" && acao !== "cancelado") {
    return NextResponse.json({ error: "acao deve ser 'saiu' ou 'cancelado'" }, { status: 400 });
  }

  const sb = createServiceClient();
  // Empresa vendedora pra tag da S (caso 'saiu'): empresa_origem do pedido.
  const { data: ped } = await sb.from("siso_pedidos").select("empresa_origem_id").eq("id", pedidoId).maybeSingle();
  if (!ped) return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });

  try {
    const { data, error } = await sb.rpc("wms_resolver_pedido_fantasma", {
      p_pedido_id: pedidoId,
      p_acao: acao,
      p_empresa_vendedora_id: (ped as { empresa_origem_id: string | null }).empresa_origem_id,
      p_usuario_id: auth.user.id,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.reconciliacao-pedidos.resolver",
      error: e,
      status: 400,
      requestPath: `/api/wms/reconciliacao-pedidos/${pedidoId}/resolver`,
      requestMethod: "POST",
      metadata: { pedido_id: pedidoId, acao },
    });
  }
}
```

> Nota: divergência do achado — o achado mencionava "gate por permissão admin + perm de visibilidade". `requireAdmin` (proxy de `userCan('sistema.usuarios')`) cobre o gate forte; adicionar checagem extra de visibilidade é opcional e foi simplificado pra só admin (operação rara, de gerente). A UI listando o padrão C consome o GET existente; criar a página é fora do escopo desta unidade (a nota P084 foca na AÇÃO de resolução; a página é incremento de UX da Fase 6 se necessário).

- [ ] **Step 4 — RODAR e ver passar.** `npm run scenarios -- :only 86` (Expected: PASS) + `npm run build` (Expected: OK).

- [ ] **Step 5 — COMMIT.** `git add -A && git commit -m "feat(wms): rota resolver pedido-fantasma (R→S saiu / R→prateleira cancelado) (P084)"`

### Task 9.3: erros-conhecidos.yaml

- [ ] Adicionar entrada:

```yaml
  - id: pedido-fantasma-sem-resolucao
    date: "2026-06-11"
    source: wms/reconciliacao-pedidos
    category: business_logic
    message: "Safety-net detectava pedido forward com reserva R viva sem saída (padrão C) mas não tinha ação — as unidades ficavam congeladas (nem em saída, nem livres) até intervenção manual fora do sistema."
    cause: >
      reconciliacao-pedidos/route.ts só expunha o GET de detecção (RPC
      wms_detectar_pedidos_inconsistentes); faltava o caminho de resolução.
    fix: >
      RPC wms_resolver_pedido_fantasma (R→L+S se 'saiu', R→L + cancelado se
      'cancelado', atômica) + rota POST /[pedidoId]/resolver gate admin.
    files:
      - supabase/migrations/20260611b_rpc_resolver_pedido_fantasma.sql
      - src/app/api/wms/reconciliacao-pedidos/[pedidoId]/resolver/route.ts
    tags: [reconciliacao, pedido-fantasma, reserva, ledger, rpc]
```

- [ ] **COMMIT.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): pedido-fantasma-sem-resolucao (P084)"`

---

## Encerramento da fase

Ao concluir os 9 PRs:

- [ ] Rodar a suíte completa: `npm test` + `npm run test:integration` + `npm run scenarios`. Expected: tudo PASS.
- [ ] Atualizar `docs/database-schema.md` (novas colunas: `siso_movimentacoes.idempotency_key`; novos tipos de `siso_fila_execucao.tipo`) e `docs/api-reference-complete.md` (nova rota `POST /api/wms/reconciliacao-pedidos/[pedidoId]/resolver`; novos parâmetros `idempotency_key` em marcar-item, `qty_estorno` em reconciliar) no mesmo commit.
- [ ] Registrar as 13 RPCs/migrations novas na seção "RPCs-chave" do `CLAUDE.md` se relevante.
- [ ] Confirmar que `erros-conhecidos.yaml` tem as 11 entradas desta fase (P060, P019+P072, P014+P015, P023, P075+P077, P005, P152+P150+P151+P147+P148, P082+P149, P084).
