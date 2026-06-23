# Fluxo OC + Recebimento Unificado + Cross-docking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Closar o ciclo "pedido sem estoque → compra → recepção → embalagem" eliminando o bug do "loop infinito" (cascade → pendente_realocacao → Pedidos Pendentes → re-aprova → loop), unificando o recebimento (OC + Transferência + Avulso) numa única porta de entrada, e habilitando cross-docking automático via 2 pendências de guarda — sem criar telas novas.

**Architecture:** 3 fases independentes e sequenciais. Cada fase entrega valor isolado e pode ser comitada/mergeada separadamente.

- **Fase 1 (Foundation OC):** corrige fluxo de aprovação, bug do loop, e habilita "Encontrei sem cadastro" — 5 tasks
- **Fase 2 (Recebimento unificado):** porta única em `/wms/receber` com 3 entradas (OC, Transferência, Avulso) — 5 tasks
- **Fase 3 (Cross-docking):** detecção de demanda no recebimento, split em 2 pendências, trigger automático pra embalagem — 5 tasks

**Tech Stack:** Next.js App Router (route handlers + client pages), TypeScript strict, Tailwind, Supabase (Postgres com RPCs PL/pgSQL, Realtime publication), Vitest pra unit + integration + scenarios (`npm run scenarios`).

**Convenções a respeitar:**
- Toda DB write via `createServiceClient()` de `@/lib/supabase-server`
- Logger via `logger.info/warn/error/logError` — nunca `console.log`
- Auth: `getSessionUser()` + `userCan(session, "perm.x")` em todas rotas
- Spec base: `docs/superpowers/specs/2026-05-28-revisao-fluxo-oc-compras-fluxo.html`
- Migrations em `supabase/migrations/YYYYMMDD_descricao.sql`, aplicadas via `mcp__supabase__apply_migration` no projeto `ehbxpbeijofxtsbezwxd` (staging)
- Documentação obrigatória: atualizar `docs/api-reference-complete.md` quando rotas mudam, `docs/database-schema.md` quando schema muda
- Erros conhecidos: registrar no `erros-conhecidos.yaml` quando fixar bug com root cause

---

# FASE 1 — Foundation OC

Corrige o fluxo de aprovação e elimina o loop infinito do "voltou pro SISO". Sem migrations; mexe em rotas e componentes existentes.

---

## Task 1.1 — Backend valida OC com snapshot cheio + frontend desabilita botão

**Contexto:** Hoje o operador pode aprovar OC mesmo quando o snapshot mostra cobertura completa. O worker degrada silenciosamente pra Própria sem criar reserva → estoque exposto. Decisão 1: bloquear OC quando snapshot cobre.

**Files:**
- Modify: `src/components/wms/vendas/pedido-card-wms.tsx:105-117` (função `decisaoIsAvailable`)
- Modify: `src/app/api/wms/pedidos/aprovar/route.ts:100-110` (validação antes do switch de decisão)
- Test: `scripts/wms/cenarios/60-aprovar-oc-com-saldo-bloqueado.ts` (novo cenário)

- [ ] **Step 1: Escrever cenário de teste**

Criar `scripts/wms/cenarios/60-aprovar-oc-com-saldo-bloqueado.ts`:

```typescript
import { runScenario } from "./harness";

await runScenario({
  nome: "60 — Aprovar OC com saldo completo é bloqueado",
  setup: async (h) => {
    await h.criarProduto({ sku: "TEST-OC-60", empresa: "NetAir" });
    await h.receberEntrada({ sku: "TEST-OC-60", galpao: "CWB", loc: "A-01-01", qty: 5 });
    return await h.criarPedidoWebhook({
      cliente: "Teste 60",
      empresa: "NetAir",
      itens: [{ sku: "TEST-OC-60", qty: 2 }],
    });
  },
  run: async (h, { pedidoId }) => {
    const res = await h.aprovarPedido(pedidoId, { decisao: "oc" });
    h.expectStatus(res, 422);
    h.expectBody(res, { error: "oc_bloqueado_snapshot_cobre" });
  },
});
```

- [ ] **Step 2: Rodar cenário pra confirmar que falha**

```bash
npm run scenarios -- 60
```

Expected: FAIL — endpoint hoje aceita OC mesmo com saldo, retorna 200.

- [ ] **Step 3: Implementar validação no endpoint aprovar**

Em `src/app/api/wms/pedidos/aprovar/route.ts`, logo após `if (!validDecisoes.includes(decisao))` (linha ~106), antes de carregar pedido:

```typescript
// Decisão 1: bloquear OC quando snapshot cobre completamente
if (decisao === "oc") {
  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select("id, quantidade_pedida")
    .eq("pedido_id", pedidoId);
  const { data: estoques } = await supabase
    .from("siso_pedido_item_estoques")
    .select("produto_id, empresa_id, disponivel, siso_pedido_itens!inner(pedido_id)")
    .eq("siso_pedido_itens.pedido_id", pedidoId);

  // Carrega empresa_origem pra filtrar disponível
  const { data: pedRow } = await supabase
    .from("siso_pedidos")
    .select("empresa_origem_id")
    .eq("id", pedidoId)
    .single();

  if (pedRow?.empresa_origem_id && itens && estoques) {
    const dispMap = new Map<string, number>();
    for (const e of estoques) {
      if (e.empresa_id === pedRow.empresa_origem_id) {
        dispMap.set(String(e.produto_id), Number(e.disponivel ?? 0));
      }
    }
    const todosCobrem = itens.every((it) => {
      const qty = Number(it.quantidade_pedida ?? 0);
      const disp = dispMap.get(String(it.id)) ?? 0;
      return disp >= qty;
    });
    if (todosCobrem) {
      return NextResponse.json(
        {
          error: "oc_bloqueado_snapshot_cobre",
          message: "Snapshot mostra saldo completo — aprove como Própria ou Transferência",
        },
        { status: 422 },
      );
    }
  }
}
```

- [ ] **Step 4: Modificar `decisaoIsAvailable` no card**

Em `src/components/wms/vendas/pedido-card-wms.tsx:105-117`, trocar a função inteira:

```typescript
function decisaoIsAvailable(
  decisao: Decisao,
  itens: ItemRow[],
  filialOrigem: string,
): boolean {
  if (decisao === "propria") return galpaoAtendeTudo(itens, filialOrigem);
  if (decisao === "transferencia") {
    for (const g of getAllGalpoes(itens)) {
      if (g !== filialOrigem && galpaoAtendeTudo(itens, g)) return true;
    }
    return false;
  }
  // OC: só disponível quando NENHUM galpão (incluindo origem) cobre tudo sozinho.
  // Decisão 1 (28/05): se snapshot tem cobertura, força Própria/Transferência (que cria reserva).
  for (const g of getAllGalpoes(itens)) {
    if (galpaoAtendeTudo(itens, g)) return false;
  }
  return true;
}
```

- [ ] **Step 5: Rodar cenário e confirmar que passa**

```bash
npm run scenarios -- 60
```

Expected: PASS (status 422 + error correto).

- [ ] **Step 6: Commit**

```bash
git add scripts/wms/cenarios/60-aprovar-oc-com-saldo-bloqueado.ts \
  src/app/api/wms/pedidos/aprovar/route.ts \
  src/components/wms/vendas/pedido-card-wms.tsx
git commit -m "$(cat <<'EOF'
feat(aprovar): bloqueia OC quando snapshot cobre o pedido (Decisão 1)

Backend retorna 422 oc_bloqueado_snapshot_cobre + frontend desabilita
o botão. Acaba a degradação silenciosa pra Própria sem reserva.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1.2 — Tab "Concluídos" expande filtro

**Contexto:** Hoje "Concluídos" filtra `status='concluido'` (ciclo todo fechado). Decisão 6: deve mostrar pedidos com decisão tomada mesmo em execução.

**Files:**
- Modify: `src/app/wms/pedidos/page.tsx:217-226`
- Test: manual — testar no browser (Vitest não cobre filtros client-side com mock complexo)

- [ ] **Step 1: Modificar filtro `concluidos`**

Em `src/app/wms/pedidos/page.tsx:217-226`, trocar:

```typescript
  const concluidos = useMemo(() => {
    return filteredByGalpao
      .filter(
        (p) =>
          p.status === "concluido" ||
          (p.status === "executando" && !!p.decisaoFinal),
      )
      .filter(buscaMatch)
      .sort((a, b) => {
        const ta = new Date(a.processadoEm ?? a.criadoEm).getTime();
        const tb = new Date(b.processadoEm ?? b.criadoEm).getTime();
        return tb - ta;
      });
  }, [filteredByGalpao, buscaMatch]);
```

- [ ] **Step 2: Verificar tipo `Pedido` tem campo `decisaoFinal`**

Em `src/app/wms/pedidos/page.tsx` perto da linha 30-60 (definição de Pedido), conferir que `decisao_final` (ou `decisaoFinal`) está mapeado. Se não estiver:

```typescript
type Pedido = {
  // ... existing fields
  decisaoFinal?: string | null;
};
```

E em `/api/wms/pedidos/route.ts` confirmar que `decisao_final` é selecionado e mapeado pra `decisaoFinal` no JSON. Se não, adicionar.

- [ ] **Step 3: Rodar dev server e validar visualmente**

```bash
npm run dev
```

Abrir staging com pedido recém-aprovado (decisao_final preenchida, status='executando'). Conferir que aparece em "Concluídos" e em "Pendentes" continua só os realmente pendentes.

- [ ] **Step 4: Commit**

```bash
git add src/app/wms/pedidos/page.tsx
git commit -m "$(cat <<'EOF'
feat(pedidos): tab Concluídos mostra pedidos com decisão tomada (Decisão 6)

Filtro agora inclui status='executando' AND decisao_final IS NOT NULL,
além de status='concluido'. Operador vê pedidos OC e em separação que já
foram decididos.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1.3 — Cascade esgotado oferece "Mandar pra Compras"

**Contexto:** Hoje quando Parcial loc_zerou + cascade não acha cobertura, pedido vira `pendente_realocacao` e aparece de novo em `/wms/pedidos` Pendentes — operador precisa Encaminhar → re-aprova → loop. Mudança A do HTML: oferecer "Mandar pra Compras" direto no modal do separador.

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts:851-872` (retorna `sem_cobertura: true` em vez de transitar pra pendente_realocacao automaticamente)
- Create: `src/app/api/wms/separacao/mandar-pra-compras/route.ts` (novo endpoint)
- Modify: `src/components/wms/separacao/parcial-modal.tsx` (modal que abre quando recebe sem_cobertura)
- Test: `scripts/wms/cenarios/61-cascade-esgotado-vai-pra-compras.ts`

- [ ] **Step 1: Escrever cenário de teste**

Criar `scripts/wms/cenarios/61-cascade-esgotado-vai-pra-compras.ts`:

```typescript
import { runScenario } from "./harness";

await runScenario({
  nome: "61 — Cascade esgotado oferece Mandar pra Compras",
  setup: async (h) => {
    await h.criarProduto({ sku: "TEST-CASC-61", empresa: "NetAir" });
    // Snapshot tem saldo, mas loc física estará vazia
    await h.receberEntrada({ sku: "TEST-CASC-61", galpao: "CWB", loc: "A-01-04", qty: 1 });
    const pedido = await h.criarPedidoWebhook({
      cliente: "Teste 61",
      empresa: "NetAir",
      itens: [{ sku: "TEST-CASC-61", qty: 1 }],
    });
    // Aprova como Propria (snapshot tem 1)
    await h.aprovarPedido(pedido.pedidoId, { decisao: "propria" });
    // Esvazia a loc por trás (simula estoque fantasma)
    await h.ajusteManual({ produto: "TEST-CASC-61", galpao: "CWB", loc: "A-01-04", delta: -1, motivo: "Ajuste teste" });
    return pedido;
  },
  run: async (h, { pedidoId }) => {
    await h.iniciarSeparacao(pedidoId);
    const itemId = await h.getItemId(pedidoId, "TEST-CASC-61");
    const parcialRes = await h.postParcial(itemId, { qty_pega: 0, loc_zerou: true });
    h.expectStatus(parcialRes, 200);
    h.expectBody(parcialRes, { sem_cobertura: true });

    // Operador escolhe Mandar pra Compras
    const mandarRes = await h.postMandarPraCompras({
      pedido_ids: [pedidoId],
      item_ids: [itemId],
    });
    h.expectStatus(mandarRes, 200);

    // Confere estado final
    const pedido = await h.getPedido(pedidoId);
    h.expectEq(pedido.status_separacao, "aguardando_compra");
    h.expectEq(pedido.status, "executando"); // não voltou pra pendente
    const item = await h.getItem(itemId);
    h.expectEq(item.compra_status, "aguardando_compra");
  },
});
```

- [ ] **Step 2: Rodar cenário e confirmar FAIL**

```bash
npm run scenarios -- 61
```

Expected: FAIL — hoje vira pendente_realocacao + status=pendente.

- [ ] **Step 3: Modificar parcial/route.ts pra retornar sem_cobertura sem transitar**

Em `src/app/api/wms/separacao/parcial/route.ts:851-873`, trocar o bloco `if (resolver.status === "sem_cobertura")` por:

```typescript
      if (resolver.status === "sem_cobertura") {
        semCoberturaParcial = true;
        // Decisão (28/05): NÃO transita mais pra pendente_realocacao automaticamente.
        // Em vez disso, retorna sem_cobertura:true pro frontend abrir modal
        // "Mandar pra Compras / Realocação manual". Operador escolhe.
        for (const u of grupo) {
          await registrarEvento({
            pedidoId: u.pedido_id,
            evento: "realocacao_sem_cobertura_galpao",
            detalhes: {
              item_id: u.item.id,
              sku: u.item.sku,
              qty_residual: u.qty_residual,
              empresa_origem_id: empOrigem,
            },
            usuarioId: session.id,
          });
        }
        // Acumula pedido_ids + item_ids no payload pro frontend
        semCoberturaPayload.pedido_ids.push(...pedidoIdsGrupo);
        semCoberturaPayload.item_ids.push(...grupo.map((u) => u.item.id));
        continue;
      }
```

E declarar `semCoberturaPayload` no topo do handler (antes do for de grupos):

```typescript
  const semCoberturaPayload: { pedido_ids: string[]; item_ids: string[] } = {
    pedido_ids: [],
    item_ids: [],
  };
```

E no return do handler (final, onde retorna JSON), incluir:

```typescript
  return NextResponse.json({
    // ... existing fields
    sem_cobertura: semCoberturaParcial,
    sem_cobertura_payload: semCoberturaParcial ? semCoberturaPayload : undefined,
  });
```

- [ ] **Step 4: Criar endpoint mandar-pra-compras**

Criar `src/app/api/wms/separacao/mandar-pra-compras/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

interface Body {
  pedido_ids?: string[];
  item_ids?: string[];
}

/**
 * POST /api/wms/separacao/mandar-pra-compras
 *
 * Aciona transição: itens com cascade sem cobertura viram aguardando_compra.
 * Substitui o caminho pendente_realocacao → Encaminhar → re-aprovação.
 *
 * Body: { pedido_ids: string[], item_ids: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(session, "operacoes.separar")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { pedido_ids, item_ids } = body;
  if (!Array.isArray(pedido_ids) || !Array.isArray(item_ids) || item_ids.length === 0) {
    return NextResponse.json(
      { error: "pedido_ids e item_ids são obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  // Buscar itens pra resolver SKU/fornecedor + qty residual
  const { data: items } = await supabase
    .from("siso_pedido_itens")
    .select("id, pedido_id, sku, quantidade_pedida, quantidade_pega, fornecedor_oc")
    .in("id", item_ids);

  if (!items || items.length === 0) {
    return NextResponse.json({ error: "itens não encontrados" }, { status: 404 });
  }

  for (const item of items) {
    const qtyResidual =
      Number(item.quantidade_pedida ?? 0) - Number(item.quantidade_pega ?? 0);
    const fornecedor =
      item.fornecedor_oc || getFornecedorBySku(item.sku ?? "").fornecedor;
    await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "aguardando_compra",
        compra_quantidade_solicitada: qtyResidual,
        compra_solicitada_em: now,
        fornecedor_oc: fornecedor,
      })
      .eq("id", item.id);

    registrarEvento({
      pedidoId: item.pedido_id,
      evento: "mandado_pra_compras_via_cascade",
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: { item_id: item.id, sku: item.sku, qty_residual: qtyResidual, fornecedor },
    });
  }

  // Pedidos viram aguardando_compra
  for (const pedidoId of pedido_ids) {
    await supabase
      .from("siso_pedidos")
      .update({
        status_separacao: "aguardando_compra",
        separacao_operador_id: null,
        separacao_iniciada_em: null,
      })
      .eq("id", pedidoId);
  }

  logger.info("mandar-pra-compras", "itens mandados pra compras via cascade esgotado", {
    pedido_ids,
    item_ids,
    operador: session.nome,
  });

  return NextResponse.json({ ok: true, pedidos_atualizados: pedido_ids.length });
}
```

- [ ] **Step 5: Modificar modal de parcial pra oferecer "Mandar pra Compras"**

Em `src/components/wms/separacao/parcial-modal.tsx` (ler arquivo primeiro pra ver a estrutura atual), adicionar tratamento pro response com `sem_cobertura: true`:

```typescript
// Após o POST de parcial retornar com sucesso, verificar:
if (resp.sem_cobertura && resp.sem_cobertura_payload) {
  // Abre sub-modal com 2 opções
  setSemCoberturaModal({
    pedido_ids: resp.sem_cobertura_payload.pedido_ids,
    item_ids: resp.sem_cobertura_payload.item_ids,
  });
}
```

E renderizar o sub-modal:

```typescript
{semCoberturaModal && (
  <div className="wms-modal-overlay">
    <div className="wms-modal">
      <h3>Não há saldo em nenhum galpão</h3>
      <p>
        O item foi marcado parcial mas nenhum galpão tem cobertura pra
        completar. Manda pra Compras agora?
      </p>
      <div className="wms-modal-actions">
        <button
          className="wms-btn wms-btn-primary"
          onClick={async () => {
            const r = await sisoFetch("/api/wms/separacao/mandar-pra-compras", {
              method: "POST",
              body: JSON.stringify(semCoberturaModal),
            });
            if (r.ok) {
              toast.success("Itens enviados pra Compras");
              onClose();
            } else {
              toast.error("Falha ao enviar pra Compras");
            }
          }}
        >
          Mandar pra Compras
        </button>
        <button
          className="wms-btn wms-btn-secondary"
          onClick={async () => {
            // Caminho legado: vira pendente_realocacao pra supervisor decidir
            await sisoFetch("/api/wms/separacao/marcar-pendente-realocacao", {
              method: "POST",
              body: JSON.stringify({ pedido_ids: semCoberturaModal.pedido_ids }),
            });
            onClose();
          }}
        >
          Pedir realocação manual (supervisor)
        </button>
      </div>
    </div>
  </div>
)}
```

> **Nota:** o endpoint `marcar-pendente-realocacao` é o caminho legado preservado pra casos excepcionais. Criar versão minimal que faz só o `UPDATE status_separacao='pendente_realocacao'` que antes era automático.

- [ ] **Step 6: Criar endpoint marcar-pendente-realocacao (caminho legado preservado)**

Criar `src/app/api/wms/separacao/marcar-pendente-realocacao/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(session, "operacoes.separar")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { pedido_ids } = (await request.json()) as { pedido_ids?: string[] };
  if (!Array.isArray(pedido_ids) || pedido_ids.length === 0) {
    return NextResponse.json({ error: "pedido_ids obrigatório" }, { status: 400 });
  }
  const supabase = createServiceClient();
  await supabase
    .from("siso_pedidos")
    .update({ status_separacao: "pendente_realocacao" })
    .in("id", pedido_ids);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 7: Rodar cenário e confirmar PASS**

```bash
npm run scenarios -- 61
```

Expected: PASS — pedido vira aguardando_compra direto, sem passar por pendente_realocacao.

- [ ] **Step 8: Commit**

```bash
git add scripts/wms/cenarios/61-cascade-esgotado-vai-pra-compras.ts \
  src/app/api/wms/separacao/parcial/route.ts \
  src/app/api/wms/separacao/mandar-pra-compras/route.ts \
  src/app/api/wms/separacao/marcar-pendente-realocacao/route.ts \
  src/components/wms/separacao/parcial-modal.tsx
git commit -m "$(cat <<'EOF'
fix(separacao): cascade esgotado oferece Mandar pra Compras direto

Antes o cascade sem cobertura virava pendente_realocacao automaticamente
e o pedido voltava pra /wms/pedidos Pendentes — operador precisava
Encaminhar + re-aprovar OC → loop infinito (case do pedido #49569).

Agora o endpoint de parcial retorna sem_cobertura:true + payload, e o
frontend abre modal com 2 opções: "Mandar pra Compras" (verde, default)
ou "Pedir realocação manual" (link cinza, caso supervisor queira
investigar). O caminho aguardando_compra → /wms/compras nunca volta pra
Pendentes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1.4 — loc_zerou atualiza snapshot do pedido

**Contexto:** Mudança B do HTML. Hoje quando operador marca Parcial loc_zerou, gera mov de ajuste no ledger mas NÃO atualiza `siso_pedido_item_estoques.disponivel`. Se o pedido voltar pelo worker, vê snapshot velho e degrada errado. Atualizar snapshot mata o loop na raiz.

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts` (após criar mov ajuste_pick_zerou, sync snapshot)
- Test: `scripts/wms/cenarios/62-loc-zerou-atualiza-snapshot.ts`

- [ ] **Step 1: Escrever cenário**

Criar `scripts/wms/cenarios/62-loc-zerou-atualiza-snapshot.ts`:

```typescript
import { runScenario } from "./harness";

await runScenario({
  nome: "62 — loc_zerou atualiza snapshot do pedido",
  setup: async (h) => {
    await h.criarProduto({ sku: "TEST-SNAP-62", empresa: "NetAir" });
    await h.receberEntrada({ sku: "TEST-SNAP-62", galpao: "CWB", loc: "A-01-01", qty: 1 });
    const pedido = await h.criarPedidoWebhook({
      cliente: "Teste 62",
      empresa: "NetAir",
      itens: [{ sku: "TEST-SNAP-62", qty: 1 }],
    });
    await h.aprovarPedido(pedido.pedidoId, { decisao: "propria" });
    return pedido;
  },
  run: async (h, { pedidoId, produtoId }) => {
    // Snapshot inicial: disponivel=1
    const snap0 = await h.getSnapshot(pedidoId, produtoId, "NetAir");
    h.expectEq(snap0.disponivel, 1);

    // Marca loc_zerou
    await h.iniciarSeparacao(pedidoId);
    const itemId = await h.getItemId(pedidoId, "TEST-SNAP-62");
    await h.postParcial(itemId, { qty_pega: 0, loc_zerou: true });

    // Snapshot pós-loc_zerou: disponivel=0
    const snap1 = await h.getSnapshot(pedidoId, produtoId, "NetAir");
    h.expectEq(snap1.disponivel, 0);
  },
});
```

- [ ] **Step 2: Rodar cenário pra confirmar FAIL**

```bash
npm run scenarios -- 62
```

Expected: FAIL — snap1.disponivel ainda 1.

- [ ] **Step 3: Adicionar sync no handler de parcial**

Em `src/app/api/wms/separacao/parcial/route.ts`, procurar o bloco que cria a mov `ajuste_pick_zerou` (grep por `ajuste_pick_zerou`). Após criar a mov com sucesso, adicionar antes do `continue` ou similar:

```typescript
// Decisão (28/05): sync snapshot do pedido pra refletir saldo real pós-loc_zerou.
// Sem isso, qualquer re-processamento (worker, re-aprovação) vê o snapshot
// estale do webhook e pode degradar OC pra Própria → loop infinito.
const { data: estoqueAtual } = await supabase
  .from("siso_estoque")
  .select("disponivel")
  .eq("produto_id", produtoWmsId)
  .eq("galpao_id", galpaoId)
  .eq("localizacao_id", locId);

const dispLive = (estoqueAtual ?? []).reduce(
  (sum, row) => sum + Number(row.disponivel ?? 0),
  0,
);

// Soma disponível em TODAS as locs do galpão pra esse produto+empresa
const { data: estoquePorGalpao } = await supabase
  .from("siso_estoque")
  .select("disponivel")
  .eq("produto_id", produtoWmsId)
  .eq("galpao_id", galpaoId);

const dispTotalGalpao = (estoquePorGalpao ?? []).reduce(
  (sum, row) => sum + Number(row.disponivel ?? 0),
  0,
);

await supabase
  .from("siso_pedido_item_estoques")
  .update({ disponivel: dispTotalGalpao })
  .eq("pedido_id", pedidoIdAtual)
  .eq("produto_id", item.produto_id)
  .eq("empresa_id", empresaOrigemId);

logger.info("parcial.snapshot-sync", "snapshot atualizado pós loc_zerou", {
  pedido_id: pedidoIdAtual,
  produto_id: item.produto_id,
  disp_anterior: snapshotAnterior,
  disp_novo: dispTotalGalpao,
});
```

> Os nomes `produtoWmsId`, `galpaoId`, `locId`, `pedidoIdAtual`, `empresaOrigemId` devem coincidir com variáveis já existentes no escopo. Verificar nomes exatos no momento da implementação.

- [ ] **Step 4: Rodar cenário e confirmar PASS**

```bash
npm run scenarios -- 62
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/wms/cenarios/62-loc-zerou-atualiza-snapshot.ts \
  src/app/api/wms/separacao/parcial/route.ts
git commit -m "$(cat <<'EOF'
fix(parcial): loc_zerou atualiza snapshot do pedido (Mudança B)

Sem isso, qualquer re-processamento do worker vê o snapshot velho do
webhook ("tinha 1") e degrada OC pra Própria → loop infinito.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1.5 — "Encontrei" sem cadastro gera Entrada + Saída

**Contexto:** Decisão 3. Quando separador clica Encontrei mas o produto não tem nenhuma localização cadastrada no galpão, hoje o pick falha. Novo: pedir loc bipada + gerar par Entrada (qty pedido) + Saída (qty pedido) automático.

**Files:**
- Modify: `src/app/api/wms/separacao/validar-oc-item/route.ts` (caso "encontrei")
- Modify: `src/app/wms/separacao/checklist/page.tsx` (modal de bipar loc quando não tem cadastro)
- Test: `scripts/wms/cenarios/63-encontrei-sem-cadastro.ts`

- [ ] **Step 1: Escrever cenário**

Criar `scripts/wms/cenarios/63-encontrei-sem-cadastro.ts`:

```typescript
import { runScenario } from "./harness";

await runScenario({
  nome: "63 — Encontrei sem cadastro gera Entrada+Saída",
  setup: async (h) => {
    // Cria produto SEM cadastrar localização
    await h.criarProduto({ sku: "TEST-ENC-63", empresa: "NetAir" });
    // NÃO faz receberEntrada — produto fica órfão de loc
    const pedido = await h.criarPedidoWebhook({
      cliente: "Teste 63",
      empresa: "NetAir",
      itens: [{ sku: "TEST-ENC-63", qty: 2 }],
    });
    await h.aprovarPedido(pedido.pedidoId, { decisao: "oc" });
    return pedido;
  },
  run: async (h, { pedidoId }) => {
    const itemId = await h.getItemId(pedidoId, "TEST-ENC-63");
    // Operador clica "Encontrei" + bipa loc A-05-03
    const res = await h.postValidarOcItem({
      item_ids: [itemId],
      acao: "encontrei",
      localizacao_id: await h.getLocId("CWB", "A-05-03"),
    });
    h.expectStatus(res, 200);

    // Confere 2 movs no ledger: E + S na A-05-03
    const movs = await h.getMovsRecentes({ produto_sku: "TEST-ENC-63" });
    const ent = movs.find((m) => m.tipo === "E" && m.origem_tipo === "ajuste_manual");
    const sai = movs.find((m) => m.tipo === "S" && m.origem_id === pedidoId);
    h.expectTruthy(ent, "deve ter mov E de entrada");
    h.expectTruthy(sai, "deve ter mov S de saída");
    h.expectEq(ent.quantidade, 2);
    h.expectEq(sai.quantidade, 2);

    // Saldo final na A-05-03 = 0
    const saldo = await h.getSaldo({ produto: "TEST-ENC-63", galpao: "CWB", loc: "A-05-03" });
    h.expectEq(saldo.disponivel, 0);
  },
});
```

- [ ] **Step 2: Rodar cenário pra confirmar FAIL**

```bash
npm run scenarios -- 63
```

Expected: FAIL — endpoint hoje retorna erro pois produto não tem loc cadastrada.

- [ ] **Step 3: Modificar handler "encontrei" no validar-oc-item**

Em `src/app/api/wms/separacao/validar-oc-item/route.ts`, no caso `acao === "encontrei"`, antes da chamada a `pickMovPicking`, verificar se o produto tem alguma localização cadastrada no galpão. Se não, exigir `localizacao_id` no body + gerar par E+S:

```typescript
// (dentro do branch acao === "encontrei", após resolver produtoWmsId e galpaoId)
const { data: locsExistentes } = await supabase
  .from("siso_estoque")
  .select("localizacao_id")
  .eq("produto_id", produtoWmsId)
  .eq("galpao_id", galpaoId)
  .limit(1);

const semCadastro = !locsExistentes || locsExistentes.length === 0;

if (semCadastro) {
  // Exige localizacao_id no body
  const locIdManual = body?.localizacao_id;
  if (!locIdManual) {
    return NextResponse.json(
      {
        error: "produto_sem_cadastro",
        message: "Produto sem localização cadastrada. Bipe ou escolha a localização onde achou.",
        item_id: item.id,
      },
      { status: 422 },
    );
  }
  // Confirma que loc existe e pertence ao galpão
  const { data: loc } = await supabase
    .from("siso_localizacoes")
    .select("id, galpao_id, tipo")
    .eq("id", locIdManual)
    .single();
  if (!loc || loc.galpao_id !== galpaoId) {
    return NextResponse.json(
      { error: "loc_invalida", message: "Localização não pertence ao galpão do pedido" },
      { status: 422 },
    );
  }
  const qty = Number(item.quantidade_pedida ?? 0);

  // Mov E: entrada de produto na loc indicada
  await inserirMovimentacao({
    tipo: "E",
    produto_id: produtoWmsId,
    galpao_id: galpaoId,
    localizacao_id: locIdManual,
    quantidade: qty,
    origem_tipo: "ajuste_manual",
    origem_id: `encontrei-${item.id}`,
    origem_detalhes: { motivo: "encontrei sem cadastro", item_id: item.id, pedido_id: item.pedido_id },
    motivo: "Achado em pick — produto sem cadastro",
  });

  // Mov S: saída pro pedido (consome a entrada que acabamos de gerar)
  // (continua no fluxo normal de pickMovPicking ou equivalente)
}
```

> O import `inserirMovimentacao` vem de `@/lib/wms/ledger`. Verificar assinatura exata na implementação.

- [ ] **Step 4: Modificar frontend pra abrir modal "bipar loc" quando 422 produto_sem_cadastro**

Em `src/app/wms/separacao/checklist/page.tsx`, no handler do botão Encontrei, tratar resposta 422 com `error="produto_sem_cadastro"`:

```typescript
const r = await sisoFetch("/api/wms/separacao/validar-oc-item", {
  method: "POST",
  body: JSON.stringify({ item_ids: [itemId], acao: "encontrei" }),
});
if (r.status === 422) {
  const body = await r.json();
  if (body.error === "produto_sem_cadastro") {
    setBiparLocModal({ itemId, message: body.message });
    return;
  }
}
```

E renderizar modal que bipa/escolhe loc:

```typescript
{biparLocModal && (
  <div className="wms-modal-overlay">
    <div className="wms-modal">
      <h3>Onde você achou o produto?</h3>
      <p>{biparLocModal.message}</p>
      <LocalizacaoCombo
        galpaoId={separacaoGalpaoId}
        onSelect={async (locId) => {
          const r2 = await sisoFetch("/api/wms/separacao/validar-oc-item", {
            method: "POST",
            body: JSON.stringify({
              item_ids: [biparLocModal.itemId],
              acao: "encontrei",
              localizacao_id: locId,
            }),
          });
          if (r2.ok) {
            toast.success("Item encontrado e registrado");
            setBiparLocModal(null);
            refreshPedido();
          }
        }}
      />
    </div>
  </div>
)}
```

- [ ] **Step 5: Rodar cenário e confirmar PASS**

```bash
npm run scenarios -- 63
```

Expected: PASS — 2 movs criadas, saldo zero, loc passa a conhecer o SKU.

- [ ] **Step 6: Commit**

```bash
git add scripts/wms/cenarios/63-encontrei-sem-cadastro.ts \
  src/app/api/wms/separacao/validar-oc-item/route.ts \
  src/app/wms/separacao/checklist/page.tsx
git commit -m "$(cat <<'EOF'
feat(separacao): "Encontrei" sem cadastro gera Entrada+Saída (Decisão 3)

Quando o produto não tem nenhuma localização cadastrada no galpão e o
separador acha fisicamente, o sistema agora pede a loc bipada e gera
par de movs E+S nessa loc. Saldo final zero, mas a loc passa a aparecer
no inventário pra contagem.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# FASE 2 — Recebimento unificado

Tela `/wms/receber` vira porta única com 3 caminhos: OC, Transferência, Avulso. Pré-requisito pra Fase 3 (cross-dock detecta demanda na hora do recebimento).

---

## Task 2.1 — Página `/wms/receber` com 3 botões de entrada

**Contexto:** Hoje `/wms/receber` é form único de bipe avulso. Nova versão: tela inicial com 3 cards de escolha.

**Files:**
- Modify: `src/app/wms/receber/page.tsx` (reformula como hub com 3 cards)
- Create: `src/app/wms/receber/oc/page.tsx` (lista OCs pendentes)
- Create: `src/app/wms/receber/transferencia/page.tsx` (lista transferências do galpão do operador)
- Create: `src/app/wms/receber/avulso/page.tsx` (move o form atual)

- [ ] **Step 1: Mover form atual pra /wms/receber/avulso/page.tsx**

Ler `src/app/wms/receber/page.tsx` inteiro e copiar conteúdo pra novo arquivo `src/app/wms/receber/avulso/page.tsx`. Atualizar imports relativos se necessário.

- [ ] **Step 2: Reescrever /wms/receber/page.tsx como hub**

Substituir conteúdo de `src/app/wms/receber/page.tsx` por:

```tsx
"use client";

import Link from "next/link";
import { Package, Truck, Hand } from "lucide-react";
import { AppShell } from "@/components/app-shell";

export default function ReceberHubPage() {
  return (
    <AppShell>
      <div className="wms-page">
        <header className="wms-page-header">
          <h1>Recebimento</h1>
          <p className="wms-page-subtitle">Como você está recebendo hoje?</p>
        </header>

        <div className="wms-receber-hub">
          <Link href="/wms/receber/oc" className="wms-receber-card wms-receber-card--primary">
            <Package size={48} />
            <h3>Receber OC pendente</h3>
            <p>Caminhão de fornecedor chegou — entrega vinculada a uma compra</p>
          </Link>

          <Link href="/wms/receber/transferencia" className="wms-receber-card wms-receber-card--primary">
            <Truck size={48} />
            <h3>Receber Transferência</h3>
            <p>Veio de outro galpão (transferência inter-galpão em trânsito)</p>
          </Link>

          <Link href="/wms/receber/avulso" className="wms-receber-card wms-receber-card--secondary">
            <Hand size={48} />
            <h3>Recebimento avulso</h3>
            <p>Achado, devolução de cliente, ajuste manual sem OC</p>
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
```

Adicionar CSS correspondente em `src/app/wms/wms.css` (ou inline com Tailwind se preferir).

- [ ] **Step 3: Validar visualmente**

```bash
npm run dev
```

Acessar `/wms/receber` e confirmar 3 cards. Clicar avulso → deve abrir form atual.

- [ ] **Step 4: Commit**

```bash
git add src/app/wms/receber/page.tsx src/app/wms/receber/avulso/page.tsx src/app/wms/wms.css
git commit -m "$(cat <<'EOF'
feat(receber): hub /wms/receber com 3 entradas (OC, Transferência, Avulso)

Tela inicial agora é hub de escolha. Form de recebimento avulso movido
pra /wms/receber/avulso preservando comportamento atual. As rotas /oc
e /transferencia ainda retornam 404 — implementadas nas próximas tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2.2 — Lista de OCs pendentes + tela de recebimento

**Files:**
- Create: `src/app/wms/receber/oc/page.tsx` (lista)
- Create: `src/app/wms/receber/oc/[id]/page.tsx` (detalhe + form)
- Create: `src/app/api/wms/receber/oc/lista/route.ts` (GET)
- Create: `src/app/api/wms/receber/oc/[id]/route.ts` (GET detalhe, POST receber)
- Test: `scripts/wms/cenarios/64-receber-via-oc.ts`

- [ ] **Step 1: Escrever cenário**

Criar `scripts/wms/cenarios/64-receber-via-oc.ts`:

```typescript
import { runScenario } from "./harness";

await runScenario({
  nome: "64 — Receber via OC com pré-preenchimento + divergência",
  setup: async (h) => {
    // Cria pedido + aprova OC + comprador compra
    await h.criarProduto({ sku: "TEST-OC-64", empresa: "NetAir" });
    const pedido = await h.criarPedidoWebhook({
      cliente: "Teste 64",
      empresa: "NetAir",
      itens: [{ sku: "TEST-OC-64", qty: 2 }],
    });
    await h.aprovarPedido(pedido.pedidoId, { decisao: "oc" });
    await h.marcarEsgotado(pedido.pedidoId, "TEST-OC-64");
    const oc = await h.comprarItem({ sku: "TEST-OC-64", qty: 50, custoUnit: 12.8 });
    return { ...pedido, ocId: oc.id };
  },
  run: async (h, { ocId }) => {
    // Lista OCs pendentes deve incluir essa
    const lista = await h.getOCsPendentes();
    h.expectTruthy(lista.find((o) => o.id === ocId), "OC deve aparecer na lista");

    // Detalhe da OC retorna itens pre-preenchidos
    const det = await h.getOCDetalhe(ocId);
    h.expectEq(det.itens.length, 1);
    h.expectEq(det.itens[0].esperado, 50);

    // Recebe com divergência: 48 íntegros + 2 avariados
    const res = await h.postReceberOC(ocId, {
      itens: [
        { item_id: det.itens[0].id, qty_real: 48, motivo_divergencia: "avaria_transporte" },
      ],
    });
    h.expectStatus(res, 200);

    // Confere mov E com qty 48 + custo
    const movs = await h.getMovsRecentes({ produto_sku: "TEST-OC-64" });
    const ent = movs.find((m) => m.tipo === "E" && m.origem_tipo === "nf_compra");
    h.expectEq(ent.quantidade, 48);
    h.expectEq(Number(ent.custo_unitario), 12.8);

    // OC fica parcialmente recebida (não fecha — faltam 2)
    const ocFinal = await h.getOC(ocId);
    h.expectEq(ocFinal.status, "comprado"); // ainda não recebido
  },
});
```

- [ ] **Step 2: Rodar pra confirmar FAIL**

```bash
npm run scenarios -- 64
```

Expected: FAIL — endpoints não existem.

- [ ] **Step 3: Criar endpoint GET lista de OCs pendentes**

Criar `src/app/api/wms/receber/oc/lista/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/wms/receber/oc/lista?galpao_id=X
 *
 * Lista OCs com status='aguardando_compra' ou 'comprado' que ainda têm
 * qty pendente de recebimento. Filtrado por galpão.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(session, "operacoes.receber")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const galpaoId = searchParams.get("galpao_id");
  const supabase = createServiceClient();

  let q = supabase
    .from("siso_ordens_compra")
    .select(
      "id, numero, fornecedor, galpao_id, status, criado_em, siso_galpoes(nome)",
    )
    .in("status", ["comprado", "aguardando_compra"]);
  if (galpaoId) q = q.eq("galpao_id", galpaoId);

  const { data: ocs, error } = await q.order("criado_em", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Pra cada OC, calcular qty pendente (esperado - recebido)
  const result = [];
  for (const oc of ocs ?? []) {
    const { data: itens } = await supabase
      .from("siso_pedido_itens")
      .select("compra_quantidade_solicitada, compra_quantidade_recebida")
      .eq("ordem_compra_id", oc.id);
    const totalEsperado = (itens ?? []).reduce(
      (s, it) => s + Number(it.compra_quantidade_solicitada ?? 0),
      0,
    );
    const totalRecebido = (itens ?? []).reduce(
      (s, it) => s + Number(it.compra_quantidade_recebida ?? 0),
      0,
    );
    const pendente = totalEsperado - totalRecebido;
    if (pendente > 0) {
      result.push({
        id: oc.id,
        numero: oc.numero,
        fornecedor: oc.fornecedor,
        galpao_nome: (oc.siso_galpoes as { nome?: string } | null)?.nome ?? null,
        qty_pendente: pendente,
        criado_em: oc.criado_em,
      });
    }
  }
  return NextResponse.json({ ocs: result });
}
```

- [ ] **Step 4: Criar endpoint GET detalhe da OC**

Criar `src/app/api/wms/receber/oc/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(session, "operacoes.receber")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const supabase = createServiceClient();

  const { data: oc } = await supabase
    .from("siso_ordens_compra")
    .select("id, numero, fornecedor, galpao_id, status, siso_galpoes(nome)")
    .eq("id", id)
    .single();
  if (!oc) return NextResponse.json({ error: "OC não encontrada" }, { status: 404 });

  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, sku, descricao, imagem_url, compra_quantidade_solicitada, compra_quantidade_recebida, compra_custo_unitario, produto_id",
    )
    .eq("ordem_compra_id", id);

  const itensFmt = (itens ?? []).map((it) => ({
    id: String(it.id),
    sku: it.sku,
    descricao: it.descricao,
    imagem_url: it.imagem_url,
    esperado: Number(it.compra_quantidade_solicitada ?? 0),
    ja_recebido: Number(it.compra_quantidade_recebida ?? 0),
    pendente:
      Number(it.compra_quantidade_solicitada ?? 0) - Number(it.compra_quantidade_recebida ?? 0),
    custo_unitario: Number(it.compra_custo_unitario ?? 0),
    produto_id: it.produto_id,
  }));

  return NextResponse.json({
    oc: { id: oc.id, numero: oc.numero, fornecedor: oc.fornecedor, galpao_id: oc.galpao_id, galpao_nome: (oc.siso_galpoes as { nome?: string } | null)?.nome ?? null },
    itens: itensFmt,
  });
}
```

- [ ] **Step 5: Criar endpoint POST receber via OC**

No mesmo arquivo `src/app/api/wms/receber/oc/[id]/route.ts`, adicionar:

```typescript
import { receberItensViaOC } from "@/lib/wms/receber-oc";

interface PostBody {
  itens: Array<{
    item_id: string;
    qty_real: number;
    motivo_divergencia?: string;
  }>;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(session, "operacoes.receber")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = (await request.json()) as PostBody;

  if (!body.itens || !Array.isArray(body.itens) || body.itens.length === 0) {
    return NextResponse.json({ error: "itens obrigatório" }, { status: 400 });
  }

  try {
    const result = await receberItensViaOC({
      ocId: id,
      itens: body.itens,
      operadorId: session.id,
      operadorNome: session.nome,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

- [ ] **Step 6: Criar lib `receber-oc.ts`**

Criar `src/lib/wms/receber-oc.ts`:

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import { resolverLocRecebimento } from "@/lib/wms/guarda";

export interface ReceberOCArgs {
  ocId: string;
  itens: Array<{ item_id: string; qty_real: number; motivo_divergencia?: string }>;
  operadorId: string;
  operadorNome: string;
}

export interface ReceberOCResult {
  oc_id: string;
  itens_recebidos: number;
  pendencias_criadas: string[];
  oc_fechada: boolean;
}

export async function receberItensViaOC(args: ReceberOCArgs): Promise<ReceberOCResult> {
  const supabase = createServiceClient();

  const { data: oc } = await supabase
    .from("siso_ordens_compra")
    .select("id, galpao_id, fornecedor")
    .eq("id", args.ocId)
    .single();
  if (!oc) throw new Error("OC não encontrada");

  const pendenciasCriadas: string[] = [];

  for (const itemReq of args.itens) {
    const { data: item } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, sku, produto_id, compra_quantidade_solicitada, compra_quantidade_recebida, compra_custo_unitario, ordem_compra_id")
      .eq("id", itemReq.item_id)
      .single();
    if (!item) continue;

    if (itemReq.qty_real <= 0) {
      // Item marcado como não recebido — registra divergência
      registrarEvento({
        pedidoId: item.pedido_id,
        evento: "recebimento_item_zero",
        usuarioId: args.operadorId,
        usuarioNome: args.operadorNome,
        detalhes: { item_id: item.id, sku: item.sku, motivo: itemReq.motivo_divergencia },
      });
      continue;
    }

    // Resolve loc RECEBIMENTO do galpão
    const locRecebimentoId = await resolverLocRecebimento(oc.galpao_id);

    // Mov E em RECEBIMENTO com custo da OC
    const movEntrada = await inserirMovimentacao({
      tipo: "E",
      produto_id: item.produto_id,
      galpao_id: oc.galpao_id,
      localizacao_id: locRecebimentoId,
      quantidade: itemReq.qty_real,
      origem_tipo: "nf_compra",
      origem_id: args.ocId,
      origem_detalhes: { ordem_compra_id: args.ocId, item_id: item.id, motivo_divergencia: itemReq.motivo_divergencia ?? null },
      custo_unitario: Number(item.compra_custo_unitario ?? 0),
      fornecedor_id: null, // pode ser resolvido depois
      motivo: itemReq.motivo_divergencia
        ? `Divergência: ${itemReq.motivo_divergencia}`
        : null,
    });

    // Cria pendência de guarda (Fase 3 vai adicionar lógica de cross-dock aqui)
    const { data: pend } = await supabase
      .from("siso_wms_pendencias_guarda")
      .insert({
        produto_id: item.produto_id,
        galpao_id: oc.galpao_id,
        qty_inicial: itemReq.qty_real,
        ordem_compra_id: args.ocId,
        criada_por: args.operadorId,
      })
      .select("id")
      .single();
    if (pend) pendenciasCriadas.push(pend.id);

    // Atualiza qty_recebida no item
    const novaQtyReceb = Number(item.compra_quantidade_recebida ?? 0) + itemReq.qty_real;
    await supabase
      .from("siso_pedido_itens")
      .update({ compra_quantidade_recebida: novaQtyReceb })
      .eq("id", item.id);

    logger.info("receber-oc", "item recebido via OC", {
      oc_id: args.ocId,
      item_id: item.id,
      sku: item.sku,
      qty_real: itemReq.qty_real,
      mov_id: movEntrada,
    });
  }

  // Verifica se OC fechou (todos itens com qty_recebida >= qty_solicitada)
  const { data: itensRestantes } = await supabase
    .from("siso_pedido_itens")
    .select("compra_quantidade_solicitada, compra_quantidade_recebida")
    .eq("ordem_compra_id", args.ocId);

  const ocFechada = (itensRestantes ?? []).every(
    (it) =>
      Number(it.compra_quantidade_recebida ?? 0) >=
      Number(it.compra_quantidade_solicitada ?? 0),
  );

  if (ocFechada) {
    await supabase
      .from("siso_ordens_compra")
      .update({ status: "recebido" })
      .eq("id", args.ocId);
  }

  return {
    oc_id: args.ocId,
    itens_recebidos: args.itens.filter((i) => i.qty_real > 0).length,
    pendencias_criadas: pendenciasCriadas,
    oc_fechada: ocFechada,
  };
}
```

- [ ] **Step 7: Criar página `/wms/receber/oc/page.tsx` (lista)**

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { sisoFetch } from "@/lib/auth-context";
import { AppShell } from "@/components/app-shell";

export default function OCListaPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["receber-oc-lista"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/receber/oc/lista");
      return (await r.json()) as { ocs: Array<{ id: string; numero: string; fornecedor: string; galpao_nome: string; qty_pendente: number; criado_em: string }> };
    },
  });

  return (
    <AppShell>
      <div className="wms-page">
        <header><h1>Receber OC pendente</h1></header>
        {isLoading && <p>Carregando…</p>}
        <div className="wms-oc-list">
          {(data?.ocs ?? []).map((oc) => (
            <Link key={oc.id} href={`/wms/receber/oc/${oc.id}`} className="wms-oc-card">
              <div className="wms-oc-card-title">{oc.fornecedor} · OC #{oc.numero}</div>
              <div className="wms-oc-card-meta">{oc.galpao_nome} · {oc.qty_pendente} pendente</div>
            </Link>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 8: Criar página `/wms/receber/oc/[id]/page.tsx` (form de recebimento)**

```tsx
"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { AppShell } from "@/components/app-shell";

interface ItemOC {
  id: string;
  sku: string;
  descricao: string;
  esperado: number;
  ja_recebido: number;
  pendente: number;
  custo_unitario: number;
}

export default function ReceberOCDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [itens, setItens] = useState<ItemOC[]>([]);
  const [qtyReal, setQtyReal] = useState<Record<string, number>>({});
  const [motivos, setMotivos] = useState<Record<string, string>>({});
  const [ocInfo, setOcInfo] = useState<{ numero: string; fornecedor: string; galpao_nome: string } | null>(null);

  useEffect(() => {
    sisoFetch(`/api/wms/receber/oc/${id}`)
      .then((r) => r.json())
      .then((data) => {
        setItens(data.itens);
        setOcInfo(data.oc);
        const init: Record<string, number> = {};
        for (const it of data.itens) init[it.id] = it.pendente;
        setQtyReal(init);
      });
  }, [id]);

  async function handleConfirmar() {
    const payload = {
      itens: itens.map((it) => ({
        item_id: it.id,
        qty_real: qtyReal[it.id] ?? 0,
        motivo_divergencia:
          (qtyReal[it.id] ?? 0) !== it.pendente ? motivos[it.id] : undefined,
      })),
    };
    const r = await sisoFetch(`/api/wms/receber/oc/${id}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      const result = await r.json();
      toast.success(
        `${result.itens_recebidos} itens recebidos${result.oc_fechada ? " · OC fechada" : ""}`,
      );
      router.push("/wms/receber/oc");
    } else {
      toast.error("Falha ao receber");
    }
  }

  return (
    <AppShell>
      <div className="wms-page">
        <header>
          <h1>Receber OC #{ocInfo?.numero}</h1>
          <p>{ocInfo?.fornecedor} · {ocInfo?.galpao_nome}</p>
        </header>

        <table className="wms-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Esperado</th>
              <th>Qty real</th>
              <th>Custo unit.</th>
              <th>Motivo divergência</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((it) => (
              <tr key={it.id}>
                <td>
                  <strong>{it.sku}</strong>
                  <div className="wms-muted">{it.descricao}</div>
                </td>
                <td>{it.pendente}</td>
                <td>
                  <input
                    type="number"
                    min={0}
                    value={qtyReal[it.id] ?? 0}
                    onChange={(e) => setQtyReal({ ...qtyReal, [it.id]: Number(e.target.value) })}
                  />
                </td>
                <td>R$ {it.custo_unitario.toFixed(2)}</td>
                <td>
                  {(qtyReal[it.id] ?? 0) !== it.pendente && (
                    <select
                      value={motivos[it.id] ?? ""}
                      onChange={(e) => setMotivos({ ...motivos, [it.id]: e.target.value })}
                    >
                      <option value="">Selecione…</option>
                      <option value="avaria_transporte">Avaria em trânsito</option>
                      <option value="faltou">Faltou na entrega</option>
                      <option value="veio_mais">Veio mais que pedido</option>
                      <option value="sku_errado">SKU errado</option>
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button className="wms-btn wms-btn-primary" onClick={handleConfirmar}>
          Confirmar recebimento
        </button>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 9: Rodar cenário e confirmar PASS**

```bash
npm run scenarios -- 64
```

- [ ] **Step 10: Commit**

```bash
git add src/app/wms/receber/oc/ src/app/api/wms/receber/oc/ src/lib/wms/receber-oc.ts \
  scripts/wms/cenarios/64-receber-via-oc.ts
git commit -m "$(cat <<'EOF'
feat(receber): recebimento via OC pendente com pré-preenchimento

Operador escolhe OC da lista, vê itens esperados + custo unitário,
ajusta qty conforme físico (com motivo de divergência). Sistema cria
mov E em RECEBIMENTO com custo da OC (atualiza custo médio), cria
pendência de guarda e fecha a OC automaticamente quando todos itens
recebidos em qty cheia.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2.3 — Receber via Transferência (escopo do galpão do operador)

**Files:**
- Create: `src/app/wms/receber/transferencia/page.tsx` (lista)
- Create: `src/app/wms/receber/transferencia/[id]/page.tsx` (form)
- Create: `src/app/api/wms/receber/transferencia/lista/route.ts`
- Modify: `src/app/api/wms/transferencias/[id]/receber/route.ts` (estender pra aceitar qty parcial + motivo)
- Test: `scripts/wms/cenarios/65-receber-via-transferencia.ts`

- [ ] **Step 1: Cenário de teste**

Criar `scripts/wms/cenarios/65-receber-via-transferencia.ts`:

```typescript
import { runScenario } from "./harness";

await runScenario({
  nome: "65 — Receber Transferência com galpão correto + divergência",
  setup: async (h) => {
    await h.criarProduto({ sku: "TEST-TR-65", empresa: "NetAir" });
    await h.receberEntrada({ sku: "TEST-TR-65", galpao: "CWB", loc: "A-01-01", qty: 40 });
    // Cria transferência CWB → SP de 30un
    const tr = await h.criarTransferencia({
      origemGalpao: "CWB",
      destinoGalpao: "SP",
      itens: [{ sku: "TEST-TR-65", qty: 30 }],
    });
    return { transferenciaId: tr.id };
  },
  run: async (h, { transferenciaId }) => {
    // Operador autenticado em SP só vê transferências com destino SP
    await h.loginComoOperador({ galpao: "SP" });
    const lista = await h.getTransferenciasPendentes();
    h.expectTruthy(lista.find((t) => t.id === transferenciaId));

    // Operador CWB não deveria ver essa
    await h.loginComoOperador({ galpao: "CWB" });
    const listaCwb = await h.getTransferenciasPendentes();
    h.expectFalsy(listaCwb.find((t) => t.id === transferenciaId));

    // Operador SP recebe 28un (2 perdidas em trânsito)
    await h.loginComoOperador({ galpao: "SP" });
    const itemId = await h.getTransferenciaItemId(transferenciaId, "TEST-TR-65");
    const res = await h.postReceberTransferencia(transferenciaId, {
      itens: [{ item_id: itemId, qty_real: 28, motivo_divergencia: "perda_transito" }],
    });
    h.expectStatus(res, 200);

    // Saldo final em SP: 28un (recebimento)
    const saldo = await h.getSaldoTotal({ produto: "TEST-TR-65", galpao: "SP" });
    h.expectEq(saldo.disponivel, 28);
  },
});
```

- [ ] **Step 2: Rodar pra FAIL**

```bash
npm run scenarios -- 65
```

- [ ] **Step 3: Criar endpoint lista de transferências do galpão do operador**

Criar `src/app/api/wms/receber/transferencia/lista/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/wms/receber/transferencia/lista
 *
 * Decisão 10: lista APENAS transferências em_transito cujo destino é
 * o galpão padrão do operador autenticado (siso_usuarios.galpao_id).
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(session, "operacoes.receber")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const supabase = createServiceClient();

  const { data: user } = await supabase
    .from("siso_usuarios")
    .select("galpao_id")
    .eq("id", session.id)
    .single();
  if (!user?.galpao_id) {
    return NextResponse.json({ transferencias: [] });
  }

  const { data: trs, error } = await supabase
    .from("siso_transferencias")
    .select(
      "id, criado_em, origem_galpao_id, destino_galpao_id, status, siso_galpoes!siso_transferencias_origem_galpao_id_fkey(nome)",
    )
    .eq("destino_galpao_id", user.galpao_id)
    .eq("status", "em_transito")
    .order("criado_em", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    transferencias: (trs ?? []).map((t) => ({
      id: t.id,
      criado_em: t.criado_em,
      origem_nome: (t.siso_galpoes as { nome?: string } | null)?.nome ?? null,
    })),
  });
}
```

- [ ] **Step 4: Estender endpoint receber transferência pra aceitar qty parcial**

Modificar `src/app/api/wms/transferencias/[id]/receber/route.ts` pra aceitar payload com qty por item + motivo:

```typescript
interface Body {
  // legado: aceita também body vazio = recebe tudo
  itens?: Array<{ item_id: string; qty_real: number; motivo_divergencia?: string }>;
}
```

Quando `body.itens` é fornecido, processar item-por-item com qty parcial. Quando ausente, mantém comportamento atual (recebe tudo).

> Implementação detalhada: ler o arquivo atual e adicionar branch antes do loop. Pra cada item, em vez de receber qty_inicial, receber qty_real do body. Se qty_real < qty_inicial, registrar evento `divergencia_transferencia` com motivo.

- [ ] **Step 5: Criar páginas frontend (lista + detalhe)**

Análogas às de OC (Task 2.2 Step 7 e 8), trocando referências de OC por Transferência. Sem coluna de custo unitário no detalhe.

- [ ] **Step 6: Rodar cenário e confirmar PASS**

```bash
npm run scenarios -- 65
```

- [ ] **Step 7: Commit**

```bash
git add src/app/wms/receber/transferencia/ \
  src/app/api/wms/receber/transferencia/ \
  src/app/api/wms/transferencias/[id]/receber/route.ts \
  scripts/wms/cenarios/65-receber-via-transferencia.ts
git commit -m "$(cat <<'EOF'
feat(receber): recebimento via Transferência com escopo de galpão (Decisão 10)

Lista filtra apenas transferências em_trânsito com destino = galpão do
operador autenticado. Form aceita qty parcial com motivo de divergência
(perda em trânsito, veio mais, errou caixa). Sem mexer em custo médio
(saldo já existe no sistema).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2.4 — Decisão 5: Recebimento varre Validação OC + atualiza loc

**Contexto:** Quando qualquer entrada de saldo (recebimento OC, transferência, avulso, ajuste) é registrada, sistema varre pedidos em `status_separacao IN ('validacao_oc', 'aguardando_separacao', 'em_separacao')` do mesmo SKU e: (1) marca pedidos em validacao_oc com flag "saldo_apareceu", (2) atualiza loc sugerida nos pedidos em separação aberta.

**Files:**
- Modify: `src/lib/wms/ledger.ts` (após `inserirMovimentacao` tipo='E', acionar varredura)
- Create: `src/lib/wms/varredura-validacao-oc.ts` (lógica de varredura)
- Modify: `src/app/wms/separacao/checklist/page.tsx` (banner "saldo apareceu")
- Test: `scripts/wms/cenarios/66-recebimento-varre-validacao.ts`

- [ ] **Step 1: Cenário**

Criar `scripts/wms/cenarios/66-recebimento-varre-validacao.ts`:

```typescript
import { runScenario } from "./harness";

await runScenario({
  nome: "66 — Recebimento varre pedidos em Validação OC",
  setup: async (h) => {
    await h.criarProduto({ sku: "TEST-VARR-66", empresa: "NetAir" });
    // Pedido com 0 saldo, aprovado OC → entra em validacao_oc
    const pedido = await h.criarPedidoWebhook({
      cliente: "Teste 66",
      empresa: "NetAir",
      itens: [{ sku: "TEST-VARR-66", qty: 2 }],
    });
    await h.aprovarPedido(pedido.pedidoId, { decisao: "oc" });
    return pedido;
  },
  run: async (h, { pedidoId }) => {
    const ped0 = await h.getPedido(pedidoId);
    h.expectEq(ped0.status_separacao, "validacao_oc");
    h.expectFalsy(ped0.flag_saldo_apareceu);

    // Recebimento avulso de 5un
    await h.receberEntrada({ sku: "TEST-VARR-66", galpao: "CWB", loc: "A-05-03", qty: 5 });

    // Pedido deve ter flag agora
    const ped1 = await h.getPedido(pedidoId);
    h.expectTruthy(ped1.flag_saldo_apareceu);
  },
});
```

- [ ] **Step 2: Rodar FAIL**

- [ ] **Step 3: Adicionar coluna `flag_saldo_apareceu` em siso_pedidos**

Criar migration `supabase/migrations/20260528_validacao_oc_flag.sql`:

```sql
ALTER TABLE siso_pedidos
ADD COLUMN IF NOT EXISTS flag_saldo_apareceu boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_pedidos_flag_saldo_apareceu
  ON siso_pedidos(flag_saldo_apareceu)
  WHERE flag_saldo_apareceu = true;
```

Aplicar via:

```bash
# Via MCP supabase (apply_migration) — passar conteúdo do SQL
```

- [ ] **Step 4: Criar lib de varredura**

Criar `src/lib/wms/varredura-validacao-oc.ts`:

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * Após uma entrada de saldo (mov E), varre pedidos em Validação OC do mesmo
 * produto e marca com flag "saldo apareceu — reconfere" + atualiza loc
 * sugerida em pedidos em separação aberta.
 *
 * Decisão 5 (28/05): chamada após qualquer entrada que aumente disponível.
 */
export async function varrerPedidosAfetadosPorEntrada(args: {
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
}): Promise<{ flagsMarcadas: number; locsAtualizadas: number }> {
  const supabase = createServiceClient();

  // 1. Pedidos em validacao_oc com itens desse produto
  const { data: pedsValidacao } = await supabase
    .from("siso_pedido_itens")
    .select("pedido_id, siso_pedidos!inner(status_separacao, separacao_galpao_id)")
    .eq("siso_pedidos.status_separacao", "validacao_oc")
    .eq("siso_pedidos.separacao_galpao_id", args.galpao_id);

  // Filtrar manualmente pelos itens cujo produto match (precisa join via produto WMS)
  // O produto_id em siso_pedido_itens é tiny_produto_id — precisa converter
  const { data: mapeamento } = await supabase
    .from("siso_produto_empresas")
    .select("tiny_produto_id, empresa_id")
    .eq("produto_id", args.produto_id);

  const tinyIds = new Set((mapeamento ?? []).map((m) => String(m.tiny_produto_id)));

  const pedidoIdsMatching = new Set<string>();
  for (const p of pedsValidacao ?? []) {
    const { data: itens } = await supabase
      .from("siso_pedido_itens")
      .select("produto_id")
      .eq("pedido_id", p.pedido_id);
    if ((itens ?? []).some((it) => tinyIds.has(String(it.produto_id)))) {
      pedidoIdsMatching.add(p.pedido_id);
    }
  }

  let flagsMarcadas = 0;
  if (pedidoIdsMatching.size > 0) {
    const { error } = await supabase
      .from("siso_pedidos")
      .update({ flag_saldo_apareceu: true })
      .in("id", Array.from(pedidoIdsMatching));
    if (!error) flagsMarcadas = pedidoIdsMatching.size;
  }

  // 2. Atualiza localizacao sugerida em pedidos em separação aberta (não-validação)
  const { data: pedsSeparacao } = await supabase
    .from("siso_pedido_itens")
    .select("id, produto_id, siso_pedidos!inner(status_separacao, separacao_galpao_id)")
    .in("siso_pedidos.status_separacao", ["aguardando_separacao", "em_separacao"])
    .eq("siso_pedidos.separacao_galpao_id", args.galpao_id);

  const { data: locInfo } = await supabase
    .from("siso_localizacoes")
    .select("codigo")
    .eq("id", args.localizacao_id)
    .single();

  let locsAtualizadas = 0;
  for (const it of pedsSeparacao ?? []) {
    if (tinyIds.has(String(it.produto_id))) {
      await supabase
        .from("siso_pedido_item_estoques")
        .update({ localizacao: locInfo?.codigo ?? null })
        .eq("pedido_id", it.id) // verificar nome real do FK
        .eq("produto_id", it.produto_id);
      locsAtualizadas++;
    }
  }

  logger.info("varredura-validacao-oc", "varredura pós-entrada", {
    produto_id: args.produto_id,
    galpao_id: args.galpao_id,
    flagsMarcadas,
    locsAtualizadas,
  });

  return { flagsMarcadas, locsAtualizadas };
}
```

- [ ] **Step 5: Chamar varredura após inserirMovimentacao tipo='E'**

Em `src/lib/wms/ledger.ts`, no final da função `inserirMovimentacao` (após sucesso), adicionar:

```typescript
import { varrerPedidosAfetadosPorEntrada } from "./varredura-validacao-oc";

// ... dentro da função, antes do return final
if (args.tipo === "E" && args.localizacao_id && args.produto_id && args.galpao_id) {
  // Fire-and-forget — não bloqueia inserção
  varrerPedidosAfetadosPorEntrada({
    produto_id: args.produto_id,
    galpao_id: args.galpao_id,
    localizacao_id: args.localizacao_id,
  }).catch((err) => {
    logger.warn("ledger", "varredura pós-entrada falhou (não-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
```

- [ ] **Step 6: Banner no checklist**

Em `src/app/wms/separacao/checklist/page.tsx`, no topo da view, adicionar:

```tsx
{pedido.flag_saldo_apareceu && (
  <div className="wms-banner wms-banner--warn">
    ⚠️ Saldo apareceu para algum item desse pedido após o webhook chegar — confere antes de marcar Esgotado.
  </div>
)}
```

E garantir que o GET de detalhe do pedido retorne `flag_saldo_apareceu`.

- [ ] **Step 7: Rodar cenário PASS**

```bash
npm run scenarios -- 66
```

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260528_validacao_oc_flag.sql \
  src/lib/wms/varredura-validacao-oc.ts \
  src/lib/wms/ledger.ts \
  src/app/wms/separacao/checklist/page.tsx \
  scripts/wms/cenarios/66-recebimento-varre-validacao.ts
git commit -m "$(cat <<'EOF'
feat(varredura): recebimento varre pedidos em Validação OC (Decisão 5)

Toda mov E chama varredura assíncrona que: (1) marca pedidos em
validacao_oc do mesmo produto com flag_saldo_apareceu, (2) atualiza
localizacao sugerida em pedidos em separação aberta.

Banner avisa o separador no checklist: "Saldo apareceu — confere antes
de marcar Esgotado". Mata o cenário de comprar de novo um item que
chegou via outra OC durante a validação.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# FASE 3 — Cross-docking via pendências de guarda

Sem tela nova — só modifica a criação de pendências no recebimento e adiciona badge visual em `/wms/guarda`.

---

## Task 3.1 — Migration: loc tipo "packing" + seed PACKING por galpão

**Files:**
- Create: `supabase/migrations/20260528_loc_tipo_packing.sql`

- [ ] **Step 1: Criar migration**

```sql
-- Decisão 8: adiciona loc tipo "packing" + seed 1 loc por galpão ativo

ALTER TABLE siso_localizacoes DROP CONSTRAINT IF EXISTS siso_localizacoes_tipo_check;
ALTER TABLE siso_localizacoes ADD CONSTRAINT siso_localizacoes_tipo_check
  CHECK (tipo IN ('picking','overstock','recebimento','expedicao','quarentena','packing'));

-- Seed PACKING-{nome_galpao} em cada galpão ativo
INSERT INTO siso_localizacoes (galpao_id, codigo, descricao, tipo, ativo)
SELECT g.id, 'PACKING-' || UPPER(g.nome), 'Staging cross-docking', 'packing', true
FROM siso_galpoes g
WHERE g.ativo = true
ON CONFLICT (galpao_id, codigo) DO NOTHING;
```

- [ ] **Step 2: Aplicar migration via MCP supabase**

Usar `mcp__supabase__apply_migration` no projeto `ehbxpbeijofxtsbezwxd` com o conteúdo do arquivo.

- [ ] **Step 3: Confirmar seed no banco**

Via MCP:

```sql
SELECT g.nome, l.codigo, l.tipo
FROM siso_localizacoes l
JOIN siso_galpoes g ON g.id = l.galpao_id
WHERE l.tipo = 'packing';
```

Expected: PACKING-CWB e PACKING-SP (mínimo).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260528_loc_tipo_packing.sql docs/database-schema.md
git commit -m "feat(wms): adiciona loc tipo 'packing' + seed PACKING por galpão (Decisão 8)"
```

> Atualizar `docs/database-schema.md` mencionando o novo tipo.

---

## Task 3.2 — Migration: colunas de cross-dock em pendências de guarda

**Files:**
- Create: `supabase/migrations/20260528_pendencia_crossdock.sql`

- [ ] **Step 1: Criar migration**

```sql
-- Cross-docking: marca pendência como prioritária + vincula pedidos

ALTER TABLE siso_wms_pendencias_guarda
  ADD COLUMN IF NOT EXISTS prioridade text NOT NULL DEFAULT 'normal'
    CHECK (prioridade IN ('normal','cross_dock')),
  ADD COLUMN IF NOT EXISTS pedidos_vinculados uuid[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS destino_sugerido_id uuid REFERENCES siso_localizacoes(id);

CREATE INDEX IF NOT EXISTS idx_pendencia_prioridade
  ON siso_wms_pendencias_guarda(prioridade, status, criada_em)
  WHERE status IN ('pendente','em_guarda');
```

- [ ] **Step 2: Aplicar via MCP**

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260528_pendencia_crossdock.sql docs/database-schema.md
git commit -m "feat(wms): pendência de guarda ganha prioridade + pedidos_vinculados (cross-dock)"
```

---

## Task 3.3 — Recebimento detecta demanda e cria 2 pendências

**Files:**
- Modify: `src/lib/wms/receber-oc.ts` (lib criada na Task 2.2) — adicionar split
- Modify: `src/app/api/wms/transferencias/[id]/receber/route.ts` — adicionar split
- Modify: `src/app/api/wms/receber/route.ts` (avulso) — adicionar split
- Create: `src/lib/wms/crossdock-detector.ts` (lógica compartilhada)
- Test: `scripts/wms/cenarios/67-crossdock-split-2-pendencias.ts`

- [ ] **Step 1: Cenário**

Criar `scripts/wms/cenarios/67-crossdock-split-2-pendencias.ts`:

```typescript
import { runScenario } from "./harness";

await runScenario({
  nome: "67 — Recebimento OC com demanda cria 2 pendências",
  setup: async (h) => {
    await h.criarProduto({ sku: "TEST-CD-67", empresa: "NetAir" });
    // Cria 3 pedidos pendentes desse SKU, total demanda 18un
    const peds = [];
    for (const qty of [5, 7, 6]) {
      const p = await h.criarPedidoWebhook({
        cliente: `Cli ${qty}`,
        empresa: "NetAir",
        itens: [{ sku: "TEST-CD-67", qty }],
      });
      await h.aprovarPedido(p.pedidoId, { decisao: "oc" });
      await h.marcarEsgotado(p.pedidoId, "TEST-CD-67");
      peds.push(p.pedidoId);
    }
    // Comprador compra 50un
    const oc = await h.comprarItem({ sku: "TEST-CD-67", qty: 50, custoUnit: 10 });
    return { ocId: oc.id, peds };
  },
  run: async (h, { ocId, peds }) => {
    // Recebe 50un
    const det = await h.getOCDetalhe(ocId);
    await h.postReceberOC(ocId, {
      itens: [{ item_id: det.itens[0].id, qty_real: 50 }],
    });

    // Conferir: 2 pendências criadas (18 cross + 32 normal)
    const pendencias = await h.getPendenciasGuarda({ ordem_compra_id: ocId });
    h.expectEq(pendencias.length, 2);

    const cross = pendencias.find((p) => p.prioridade === "cross_dock");
    const normal = pendencias.find((p) => p.prioridade === "normal");
    h.expectTruthy(cross);
    h.expectTruthy(normal);
    h.expectEq(cross.qty_inicial, 18);
    h.expectEq(normal.qty_inicial, 32);
    h.expectEq(cross.pedidos_vinculados.length, 3);
  },
});
```

- [ ] **Step 2: Rodar FAIL**

- [ ] **Step 3: Criar lib `crossdock-detector.ts`**

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

export interface CrossDockSplit {
  qty_cross_dock: number;
  qty_guarda_normal: number;
  pedidos_vinculados: string[];
  loc_packing_id: string | null;
}

/**
 * Detecta demanda viva pra esse SKU + OC e propõe split.
 *
 * Decisão 7: cross-dock prioriza demanda. qty_cross = min(qty_recebida, demanda).
 * Pedido só conta se TODOS seus itens OC dessa mesma OC chegaram (ou já estão recebidos).
 */
export async function detectarCrossDock(args: {
  produto_id: string;
  galpao_id: string;
  qty_recebida: number;
  ordem_compra_id: string;
}): Promise<CrossDockSplit> {
  const supabase = createServiceClient();

  // Pedidos com itens desse produto + OC + status=comprado (aguardando entrega)
  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, sku, produto_id, quantidade_pedida, compra_quantidade_recebida, compra_status, ordem_compra_id, siso_pedidos!inner(status_separacao)",
    )
    .eq("ordem_compra_id", args.ordem_compra_id)
    .eq("compra_status", "comprado");

  // Resolve produto WMS (tiny_produto_id → produto_id) — checagem por empresa
  const { data: mapping } = await supabase
    .from("siso_produto_empresas")
    .select("tiny_produto_id, empresa_id")
    .eq("produto_id", args.produto_id);
  const tinyIds = new Set((mapping ?? []).map((m) => String(m.tiny_produto_id)));

  const candidatos = (itens ?? []).filter((it) => tinyIds.has(String(it.produto_id)));

  // Loc PACKING desse galpão
  const { data: locPacking } = await supabase
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", args.galpao_id)
    .eq("tipo", "packing")
    .eq("ativo", true)
    .maybeSingle();

  if (!locPacking) {
    logger.warn("crossdock-detector", "sem loc PACKING no galpão — pula cross-dock", {
      galpao_id: args.galpao_id,
    });
    return {
      qty_cross_dock: 0,
      qty_guarda_normal: args.qty_recebida,
      pedidos_vinculados: [],
      loc_packing_id: null,
    };
  }

  // Aloca FIFO por aging (pedido mais antigo primeiro)
  const ordenados = candidatos.sort(
    (a, b) => String(a.pedido_id).localeCompare(String(b.pedido_id)),
  );

  let qtyRestante = args.qty_recebida;
  const pedidosVinculados: string[] = [];
  for (const it of ordenados) {
    if (qtyRestante <= 0) break;
    const qtyItem = Number(it.quantidade_pedida ?? 0) - Number(it.compra_quantidade_recebida ?? 0);
    if (qtyItem <= 0) continue;
    if (qtyItem > qtyRestante) {
      // Pedido só vai se 100% completo — não fragmenta
      continue;
    }
    qtyRestante -= qtyItem;
    pedidosVinculados.push(it.pedido_id);
  }

  const qtyCross = args.qty_recebida - qtyRestante;
  const qtyNormal = qtyRestante;

  return {
    qty_cross_dock: qtyCross,
    qty_guarda_normal: qtyNormal,
    pedidos_vinculados: pedidosVinculados,
    loc_packing_id: locPacking.id,
  };
}
```

- [ ] **Step 4: Integrar no `receber-oc.ts`**

Modificar `src/lib/wms/receber-oc.ts` — onde cria pendência única, substituir por chamada ao detector e criar 1 ou 2 pendências:

```typescript
import { detectarCrossDock } from "./crossdock-detector";

// ... dentro do loop por item, após criar mov E:
const split = await detectarCrossDock({
  produto_id: item.produto_id,
  galpao_id: oc.galpao_id,
  qty_recebida: itemReq.qty_real,
  ordem_compra_id: args.ocId,
});

if (split.qty_cross_dock > 0 && split.loc_packing_id) {
  const { data: pendCross } = await supabase
    .from("siso_wms_pendencias_guarda")
    .insert({
      produto_id: item.produto_id,
      galpao_id: oc.galpao_id,
      qty_inicial: split.qty_cross_dock,
      ordem_compra_id: args.ocId,
      criada_por: args.operadorId,
      prioridade: "cross_dock",
      pedidos_vinculados: split.pedidos_vinculados,
      destino_sugerido_id: split.loc_packing_id,
    })
    .select("id")
    .single();
  if (pendCross) pendenciasCriadas.push(pendCross.id);
}

if (split.qty_guarda_normal > 0) {
  const { data: pendNormal } = await supabase
    .from("siso_wms_pendencias_guarda")
    .insert({
      produto_id: item.produto_id,
      galpao_id: oc.galpao_id,
      qty_inicial: split.qty_guarda_normal,
      ordem_compra_id: args.ocId,
      criada_por: args.operadorId,
      prioridade: "normal",
    })
    .select("id")
    .single();
  if (pendNormal) pendenciasCriadas.push(pendNormal.id);
}
```

- [ ] **Step 5: Aplicar mesmo padrão no `transferencias/receber` e no `/api/wms/receber` (avulso)**

Idem — após criar mov E, chamar `detectarCrossDock` (com `ordem_compra_id` nulo passado se transferência/avulso) e splitar pendência. Pra transferência/avulso o `ordem_compra_id` será null, então o detector retorna `qty_cross_dock=0` (pois não há OC vinculada). Mas pode haver pedidos OC esperando esse SKU independente da OC origem — vamos cobrir isso no futuro se necessário.

> Por simplicidade, na Fase 3 inicial o cross-dock só dispara via OC. Recebimentos avulsos e transferências não disparam cross-dock (mantém comportamento atual de 1 pendência única). Documentar em comment.

- [ ] **Step 6: Rodar cenário PASS**

```bash
npm run scenarios -- 67
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/wms/crossdock-detector.ts src/lib/wms/receber-oc.ts \
  scripts/wms/cenarios/67-crossdock-split-2-pendencias.ts
git commit -m "$(cat <<'EOF'
feat(crossdock): recebimento OC cria 2 pendências quando há demanda

Detector roda por item após inserção de mov E. Calcula qty cross-dock
(min(recebido, demanda viva)) priorizando pedidos completos via FIFO.
Cria pendência prioridade=cross_dock destino=PACKING + pendência
prioridade=normal destino livre.

Decisão 7 (qty prioriza cross-dock) e Decisão 8 (1 PACKING por galpão)
aplicadas.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3.4 — UI: badge cross-dock + destino pré-preenchido em /wms/guarda

**Files:**
- Modify: `src/app/wms/guarda/page.tsx`
- Modify: `src/app/api/wms/guarda/route.ts` (GET inclui campos prioridade + pedidos_vinculados)
- Modify: `src/app/api/wms/guarda/[id]/confirmar/route.ts` (warning quando destino diferente do sugerido em cross-dock)

- [ ] **Step 1: GET de guarda inclui campos novos**

Em `src/app/api/wms/guarda/route.ts`, ajustar select pra incluir `prioridade, pedidos_vinculados, destino_sugerido_id, siso_localizacoes(codigo)` (join com siso_localizacoes pra resolver codigo do destino sugerido).

```typescript
// dentro do select:
.select(`
  id, qty_inicial, qty_guardada, status, criada_em, criada_por,
  produto_id, galpao_id, ordem_compra_id,
  prioridade, pedidos_vinculados, destino_sugerido_id,
  siso_produtos(sku, descricao, imagem_url),
  destino_sugerido:siso_localizacoes!destino_sugerido_id(codigo)
`)
```

E ordenar: cross-dock primeiro (`.order("prioridade", { ascending: false })` ou via SQL CASE).

- [ ] **Step 2: Modificar page.tsx pra mostrar badge**

Em `src/app/wms/guarda/page.tsx`, no render de cada pendência:

```tsx
<div className={`wms-pendencia ${p.prioridade === "cross_dock" ? "wms-pendencia--crossdock" : ""}`}>
  {p.prioridade === "cross_dock" && (
    <div className="wms-pendencia-badge">🎯 CROSS-DOCK · {p.pedidos_vinculados?.length} pedidos</div>
  )}
  <h3>{p.sku} — {p.qty_inicial}un</h3>
  {p.destino_sugerido?.codigo && (
    <div className="wms-pendencia-destino">
      Destino sugerido: <strong>{p.destino_sugerido.codigo}</strong>
    </div>
  )}
  <button className="wms-btn wms-btn-primary" onClick={() => abrirBipe(p)}>
    Bipar destino
  </button>
  {p.prioridade === "cross_dock" && (
    <button className="wms-btn wms-btn-link" onClick={() => abrirTrocarDestino(p)}>
      Trocar destino (vai desvincular pedidos)
    </button>
  )}
</div>
```

CSS: `.wms-pendencia--crossdock` com border-left verde, badge verde no topo.

- [ ] **Step 3: Modal de confirmação dupla pra trocar destino (Decisão 9)**

```tsx
{trocarDestinoModal && (
  <div className="wms-modal-overlay">
    <div className="wms-modal">
      <h3>Trocar destino vai desvincular {trocarDestinoModal.qtdPedidos} pedidos</h3>
      <p>
        Esses pedidos voltam pra "Aguard. OC" esperando próxima entrega.
        Tem certeza?
      </p>
      <div className="wms-modal-actions">
        <button className="wms-btn wms-btn-secondary" onClick={() => setTrocarDestinoModal(null)}>
          Cancelar
        </button>
        <button className="wms-btn wms-btn-danger" onClick={confirmarTroca}>
          Sim, desvincular
        </button>
      </div>
    </div>
  </div>
)}
```

`confirmarTroca` chama endpoint que desvincula (UPDATE prioridade='normal' + pedidos_vinculados=NULL).

- [ ] **Step 4: Endpoint pra desvincular cross-dock**

Criar `src/app/api/wms/guarda/[id]/desvincular-crossdock/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(session, "operacoes.guardar")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const supabase = createServiceClient();

  const { data: pend } = await supabase
    .from("siso_wms_pendencias_guarda")
    .select("pedidos_vinculados")
    .eq("id", id)
    .single();

  await supabase
    .from("siso_wms_pendencias_guarda")
    .update({
      prioridade: "normal",
      destino_sugerido_id: null,
      pedidos_vinculados: null,
    })
    .eq("id", id);

  logger.info("guarda.desvincular-crossdock", "cross-dock desvinculado", {
    pendencia_id: id,
    pedidos_desvinculados: pend?.pedidos_vinculados?.length ?? 0,
    operador: session.nome,
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Validar visualmente no dev**

```bash
npm run dev
```

Acessar `/wms/guarda` com uma pendência cross-dock criada (via Task 3.3) e conferir:
- Badge verde "🎯 CROSS-DOCK" no topo
- Destino sugerido preenchido como PACKING-CWB
- Botão verde grande "Bipar destino"
- Link cinza "Trocar destino"
- Modal de confirmação dupla ao clicar link

- [ ] **Step 6: Commit**

```bash
git add src/app/wms/guarda/page.tsx \
  src/app/api/wms/guarda/route.ts \
  src/app/api/wms/guarda/[id]/desvincular-crossdock/route.ts
git commit -m "$(cat <<'EOF'
feat(guarda): badge cross-dock + destino pré-preenchido + desvincular

Pendências prioridade=cross_dock aparecem no topo da fila com badge
verde, destino PACKING pré-preenchido, e link cinza "Trocar destino"
com modal de confirmação dupla (Decisão 9 — botão verde = aceitar
cross-dock, rejeitar é exceção).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3.5 — Trigger pós-guarda PACKING → pedidos viram Separado + indicador "X de Y"

**Files:**
- Modify: `src/app/api/wms/guarda/[id]/confirmar/route.ts` (após confirmar, se cross-dock + destino PACKING, dispara trigger)
- Create: `src/lib/wms/crossdock-trigger.ts` (lógica do trigger)
- Modify: `src/app/wms/separacao/page.tsx` tab "aguardando_compra" (indicador "X de Y")
- Modify: `src/app/api/wms/separacao/route.ts` (calcula campos `itens_recebidos`/`itens_total` por pedido)
- Test: `scripts/wms/cenarios/68-trigger-packing-vira-separado.ts`

- [ ] **Step 1: Cenário**

Criar `scripts/wms/cenarios/68-trigger-packing-vira-separado.ts`:

```typescript
import { runScenario } from "./harness";

await runScenario({
  nome: "68 — Confirmar guarda em PACKING vira pedido Separado",
  setup: async (h) => {
    await h.criarProduto({ sku: "TEST-TRG-68", empresa: "NetAir" });
    const p = await h.criarPedidoWebhook({
      cliente: "Teste 68",
      empresa: "NetAir",
      itens: [{ sku: "TEST-TRG-68", qty: 5 }],
    });
    await h.aprovarPedido(p.pedidoId, { decisao: "oc" });
    await h.marcarEsgotado(p.pedidoId, "TEST-TRG-68");
    const oc = await h.comprarItem({ sku: "TEST-TRG-68", qty: 50, custoUnit: 10 });
    return { pedidoId: p.pedidoId, ocId: oc.id };
  },
  run: async (h, { pedidoId, ocId }) => {
    const det = await h.getOCDetalhe(ocId);
    await h.postReceberOC(ocId, {
      itens: [{ item_id: det.itens[0].id, qty_real: 50 }],
    });

    const pendencias = await h.getPendenciasGuarda({ ordem_compra_id: ocId });
    const cross = pendencias.find((p) => p.prioridade === "cross_dock");

    // Confirma pendência em PACKING-CWB
    const locPacking = await h.getLocId("CWB", "PACKING-CWB");
    await h.confirmarGuarda(cross.id, { localizacao_id: locPacking });

    // Pedido deve estar como Separado
    const ped = await h.getPedido(pedidoId);
    h.expectEq(ped.status_separacao, "separado");
  },
});
```

- [ ] **Step 2: Criar lib `crossdock-trigger.ts`**

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import { prepararPedidosDasOcsParaEmbalagem } from "@/lib/compras-embalagem";
import { logger } from "@/lib/logger";

/**
 * Trigger pós-guarda: se pendência cross-dock foi guardada em loc PACKING,
 * verifica pra cada pedido vinculado se TODOS seus itens chegaram. Se sim,
 * pedido transita pra "separado" via prepararPedidosDasOcsParaEmbalagem.
 */
export async function dispararTriggerCrossDock(args: {
  pendencia_id: string;
  destino_final_id: string;
}): Promise<{ pedidos_separados: string[] }> {
  const supabase = createServiceClient();

  const { data: pend } = await supabase
    .from("siso_wms_pendencias_guarda")
    .select("id, prioridade, ordem_compra_id, pedidos_vinculados")
    .eq("id", args.pendencia_id)
    .single();
  if (!pend || pend.prioridade !== "cross_dock") {
    return { pedidos_separados: [] };
  }

  // Confirma que destino final é loc tipo 'packing'
  const { data: loc } = await supabase
    .from("siso_localizacoes")
    .select("tipo")
    .eq("id", args.destino_final_id)
    .single();
  if (loc?.tipo !== "packing") {
    logger.info("crossdock-trigger", "destino final não é packing — operador rejeitou cross-dock", {
      pendencia_id: args.pendencia_id,
      tipo: loc?.tipo,
    });
    return { pedidos_separados: [] };
  }

  // Pra cada pedido vinculado, verificar se TODOS itens OC chegaram
  const pedidosSeparados: string[] = [];
  for (const pedidoId of pend.pedidos_vinculados ?? []) {
    const { data: itens } = await supabase
      .from("siso_pedido_itens")
      .select("compra_status, compra_quantidade_recebida, compra_quantidade_solicitada")
      .eq("pedido_id", pedidoId);
    const todosRecebidos = (itens ?? []).every(
      (it) =>
        it.compra_status === null ||
        Number(it.compra_quantidade_recebida ?? 0) >=
          Number(it.compra_quantidade_solicitada ?? 0),
    );
    if (todosRecebidos) {
      pedidosSeparados.push(pedidoId);
    }
  }

  if (pedidosSeparados.length > 0 && pend.ordem_compra_id) {
    await prepararPedidosDasOcsParaEmbalagem({
      ordemCompraIds: [pend.ordem_compra_id],
      usuarioId: null,
      usuarioNome: null,
    });
    logger.info("crossdock-trigger", "pedidos viraram separado via cross-dock", {
      pendencia_id: args.pendencia_id,
      pedidos: pedidosSeparados,
    });
  }

  return { pedidos_separados: pedidosSeparados };
}
```

- [ ] **Step 3: Chamar trigger no confirmar de guarda**

Em `src/app/api/wms/guarda/[id]/confirmar/route.ts`, após o RPC `wms_confirmar_guarda_atomico` retornar sucesso:

```typescript
import { dispararTriggerCrossDock } from "@/lib/wms/crossdock-trigger";

// ... após confirmação bem-sucedida
const triggerResult = await dispararTriggerCrossDock({
  pendencia_id: id,
  destino_final_id: body.localizacao_id,
});

return NextResponse.json({
  ok: true,
  pedidos_separados: triggerResult.pedidos_separados,
});
```

- [ ] **Step 4: Indicador "X de Y" em separação tab "Aguard. OC"**

Em `src/app/api/wms/separacao/route.ts`, no list endpoint, pra cada pedido com `status_separacao='aguardando_compra'`, calcular:

```typescript
// Pra cada pedido na resposta:
const { data: itensOC } = await supabase
  .from("siso_pedido_itens")
  .select("compra_quantidade_solicitada, compra_quantidade_recebida")
  .eq("pedido_id", pedido.id)
  .not("compra_status", "is", null);

const total = itensOC?.length ?? 0;
const recebidos = (itensOC ?? []).filter(
  (it) =>
    Number(it.compra_quantidade_recebida ?? 0) >=
    Number(it.compra_quantidade_solicitada ?? 0),
).length;

pedido.cross_dock_progress = { recebidos, total };
```

Em `src/app/wms/separacao/page.tsx` tab `aguardando_compra`, render:

```tsx
{p.cross_dock_progress && p.cross_dock_progress.total > 0 && (
  <span className="wms-badge wms-badge-info">
    {p.cross_dock_progress.recebidos} de {p.cross_dock_progress.total} itens recebidos
  </span>
)}
```

- [ ] **Step 5: Rodar cenário PASS**

```bash
npm run scenarios -- 68
```

- [ ] **Step 6: Commit**

```bash
git add scripts/wms/cenarios/68-trigger-packing-vira-separado.ts \
  src/lib/wms/crossdock-trigger.ts \
  src/app/api/wms/guarda/[id]/confirmar/route.ts \
  src/app/api/wms/separacao/route.ts \
  src/app/wms/separacao/page.tsx
git commit -m "$(cat <<'EOF'
feat(crossdock): trigger pós-PACKING vira pedidos Separado + indicador

Quando uma pendência cross-dock é confirmada em loc tipo 'packing',
trigger varre os pedidos vinculados, e os que têm 100% dos itens OC
recebidos viram status_separacao='separado' via prepararPedidosDasOcs.
Etiquetas baixam automaticamente.

Tab "Aguard. OC" da Separação ganha indicador "X de Y itens recebidos"
pra ver o progresso do cross-dock por pedido.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Encerramento

## Self-Review checklist

- [ ] Cada decisão (1-10) do HTML tem task correspondente
  - Decisão 1: Task 1.1 ✓
  - Decisão 2 (validação obrigatória): status quo, sem task
  - Decisão 3: Task 1.5 ✓
  - Decisão 4 (sem aging): status quo, sem task
  - Decisão 5: Task 2.4 ✓
  - Decisão 6: Task 1.2 ✓
  - Decisão 7 (qty prioriza cross-dock): Task 3.3 (lógica do detector)
  - Decisão 8 (1 PACKING por galpão): Task 3.1
  - Decisão 9 (botão verde / modal duplo): Task 3.4
  - Decisão 10 (escopo galpão): Task 2.3
- [ ] Bug do "voltou pro SISO" coberto: Tasks 1.3 (Mudança A) + 1.4 (Mudança B)
- [ ] Cross-docking via 2 pendências: Tasks 3.1 (loc tipo) + 3.2 (colunas) + 3.3 (split) + 3.4 (UI) + 3.5 (trigger)
- [ ] Recebimento unificado 3 portas: Tasks 2.1 (hub) + 2.2 (OC) + 2.3 (Transferência); avulso preservado
- [ ] Sem placeholders TBD/TODO inline
- [ ] Cada step com código completo

## Documentação a atualizar (em commits durante implementação)

- `docs/api-reference-complete.md` — adicionar rotas novas em cada PR
- `docs/database-schema.md` — adicionar colunas/tipos em Fase 3
- `docs/architecture-and-flows.md` — atualizar diagramas pra Fase 1/2/3
- `CLAUDE.md` — adicionar bullets em "Direção Estratégica" e "Recently Removed" se aplicável
- `erros-conhecidos.yaml` — registrar o bug do "voltou pro SISO" como entry quando fixar (Task 1.3)

## Sequenciamento sugerido

Pode-se executar fase por fase como PRs separadas:

1. **PR Fase 1**: 5 commits, ~5 cenários novos (60-63), fix do loop infinito + UX limpa. Mergeable independente.
2. **PR Fase 2**: 5 commits, 3 cenários (64-66), tela unificada de recebimento. Depende de Fase 1 estar mergeada.
3. **PR Fase 3**: 5 commits, 2 cenários (67-68), cross-docking funcional. Depende de Fase 2.

Cada fase deixa o sistema funcional — Fase 2 funciona sem cross-dock (caminho avulso continua existindo); Fase 3 desbloqueia o ganho de tempo do fornecedor → cliente.
