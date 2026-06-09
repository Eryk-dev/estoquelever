# Refactor Compras + Recebimento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Destravar a troca de fornecedor por item (A), unificar compra manual + OC numa lista única por documento (B), e fazer OC/manual/transferência receberem na mesma page rica do avulso (C).

**Architecture:** Três fases ordenadas A→B→C sobre o módulo `/wms` (Next 16 App Router + Supabase service-role). Sem migration — `fornecedor_oc`, `siso_compras_manuais`, `siso_ordens_compra` já existem. A unificação é em camada de query (backend) e componente (frontend). Backends de recebimento ficam intactos (`receberEstoque`, `receberItensViaOC`, `receberTransferencia`, `receberCompraManual`); a Fase C só troca a UI por um componente compartilhado config-driven com adapters injetados por fluxo.

**Tech Stack:** Next.js 16 (App Router, async route params), React 19, TypeScript strict, TanStack React Query, Supabase JS (service role via `createServiceClient()`), Zod (onde já usado), vitest (happy-dom) pra unit, vitest integration contra staging, cenários E2E HTTP.

**Spec:** `docs/superpowers/specs/2026-06-09-refactor-compras-recebimento-design.md`

---

## Convenções de teste deste repo (LEIA antes de testar)

- **Unit** (`npm test` = `vitest run`, config `vitest.config.ts`, happy-dom, glob `src/**/*.test.ts(x)`): pura-função E route-handler. MOCKA tudo, sem DB.
  - Pura: arquivo `src/.../<nome>.test.ts` ao lado da fonte, `import { fn } from "./<nome>"`.
  - Route-handler: arquivo `src/app/api/wms/<feat>/<descritivo>.test.ts` ao lado da rota, `import { POST } from "./route"` ou `import { PATCH } from "./[id]/route"`. Nome é descritivo-do-comportamento (ex: `fornecedor-troca-200.test.ts`).
  - Mock recipe: `vi.mock("@/lib/wms/auth", ...)` OU `vi.mock("@/lib/session", ...)`/`vi.mock("@/lib/permissions", ...)` conforme a rota; spies em `vi.hoisted(() => ({ spy: vi.fn() }))`; `vi.mock("@/lib/supabase-server", () => ({ createServiceClient: () => (<chainable stub>) }))`; imports DEPOIS dos mocks.
  - Request: `new Request("http://x/...", { method, body: JSON.stringify(body), headers: {"content-type":"application/json"} })`, cast `as never` (ou `as unknown as NextRequest`).
  - Rota dinâmica Next 16: 2º arg `{ params: Promise.resolve({ id }) }`.
- **Integration** (`npm run test:integration`): arquivos `test/integration/*.test.ts`, SEM mocks, `createServiceClient()` real contra staging, `sb.rpc(...)` named params. Serializado.
- **Cenário E2E** (`npm run scenarios`): `scripts/wms/cenarios/catalogo/NN-slug.ts`, usa `ctx.*` helpers (nunca `fetch` direto), auth via X-Session-Id global. Append do bloco `runStandalone` no fim.
- Asserts em PT, `expect().toBe/.toEqual/.toMatch(/re/i)`. Erro de rota: `res.status` + `(await res.json()).error`. 401 tem shape inconsistente (`error`/`erro`/`sessao_invalida`) — não assumir chave única.
- **Logging:** nunca `console.*`; `logger.error/warn(source, msg, meta)`.

---

# FASE A — Fornecedor destravado (override por item)

**Decisões fixas:**
- `siso_pedido_itens.fornecedor_oc` é **string livre** (nome do fornecedor), nullable — NÃO é FK. Trocar = gravar string.
- Na aba "Comprar" um SKU (`ComprarItem`) agrega VÁRIAS linhas `siso_pedido_itens` (uma por pedido). O único handle pras linhas é `item.pedidos[].item_id`. Trocar fornecedor do SKU = atualizar **todas** as linhas → endpoint **bulk por `item_ids[]`**.
- Mirror das convenções do irmão `compras/itens/[itemId]/indisponivel/route.ts`: `getSessionUser` + `userCan("compras.executar")`, erros `NextResponse.json({error},{status})`, `registrarEvento`.

---

### Task A1: Novo evento de histórico `compra_fornecedor_alterado`

**Files:**
- Modify: `src/lib/historico-service.ts` (union `EventoPedido`, ~linha 84-92)

- [ ] **Step 1: Adicionar o literal ao union**

Em `src/lib/historico-service.ts`, no bloco do union `EventoPedido` (onde estão os `"compra_*"`), adicionar a linha após `"compra_sku_trocado"`:

```typescript
  | "compra_sku_trocado"
  | "compra_fornecedor_alterado"
  | "compra_pedido_cancelado"
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros novos (o literal é referenciado na Task A2; aqui só amplia o union).

- [ ] **Step 3: Commit**

```bash
git add src/lib/historico-service.ts
git commit -m "feat(compras): evento de histórico compra_fornecedor_alterado"
```

---

### Task A2: Rota bulk `PATCH /api/wms/compras/itens/fornecedor`

**Files:**
- Create: `src/app/api/wms/compras/itens/fornecedor/route.ts`
- Test: `src/app/api/wms/compras/itens/fornecedor/fornecedor-troca.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

`src/app/api/wms/compras/itens/fornecedor/fornecedor-troca.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// Sessão sempre válida com permissão compras.executar.
vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Tester" }),
}));
vi.mock("@/lib/permissions", () => ({
  userCan: (_s: unknown, code: string) => code === "compras.executar",
}));
const { registrarEventosSpy } = vi.hoisted(() => ({
  registrarEventosSpy: vi.fn(async () => {}),
}));
vi.mock("@/lib/historico-service", () => ({
  registrarEventos: registrarEventosSpy,
}));

// createServiceClient chainable: fornecedor existe + update retorna 2 linhas.
const updateInSpy = vi.fn();
vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === "siso_fornecedores") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: async () => ({ data: [{ id: "f1" }], error: null }),
              }),
            }),
          }),
        };
      }
      // siso_pedido_itens
      return {
        update: (patch: unknown) => ({
          in: (col: string, ids: string[]) => {
            updateInSpy(patch, col, ids);
            return {
              select: async () => ({
                data: [
                  { id: "i1", pedido_id: "p1" },
                  { id: "i2", pedido_id: "p2" },
                ],
                error: null,
              }),
            };
          },
        }),
      };
    },
  }),
}));

import { PATCH } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/compras/itens/fornecedor", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("PATCH /api/wms/compras/itens/fornecedor", () => {
  it("troca fornecedor_oc de todos os item_ids e responde 200", async () => {
    const res = await PATCH(
      makeReq({ item_ids: ["i1", "i2"], fornecedor_oc: "Delphi" }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.atualizados).toBe(2);
    expect(updateInSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fornecedor_oc: "Delphi" }),
      "id",
      ["i1", "i2"],
    );
    expect(registrarEventosSpy).toHaveBeenCalled();
  });

  it("rejeita item_ids vazio com 400", async () => {
    const res = await PATCH(makeReq({ item_ids: [], fornecedor_oc: "X" }) as never);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/app/api/wms/compras/itens/fornecedor/fornecedor-troca.test.ts`
Expected: FAIL — `Cannot find module "./route"`.

- [ ] **Step 3: Implementar a rota**

`src/app/api/wms/compras/itens/fornecedor/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { registrarEventos } from "@/lib/historico-service";

/**
 * PATCH /api/wms/compras/itens/fornecedor
 * Body: { item_ids: string[], fornecedor_oc: string | null }
 *
 * Troca o fornecedor_oc (string livre) de N linhas siso_pedido_itens de uma vez.
 * Um SKU na aba Comprar agrega várias linhas (uma por pedido); o front manda
 * todos os item_ids do grupo. Null/empty limpa o fornecedor ("Sem fornecedor").
 */
export async function PATCH(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    item_ids?: unknown;
    fornecedor_oc?: unknown;
  };
  const itemIds = Array.isArray(body.item_ids)
    ? body.item_ids.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (itemIds.length === 0) {
    return NextResponse.json({ error: "item_ids[] obrigatório" }, { status: 400 });
  }
  // Normaliza: string trimada; vazia → null (limpa o fornecedor).
  const raw = typeof body.fornecedor_oc === "string" ? body.fornecedor_oc.trim() : null;
  const fornecedorOc = raw && raw.length > 0 ? raw : null;

  const supabase = createServiceClient();

  try {
    // Valida que o fornecedor existe (quando não está limpando).
    if (fornecedorOc) {
      const { data: forn } = await supabase
        .from("siso_fornecedores")
        .select("id")
        .eq("nome", fornecedorOc)
        .eq("ativo", true)
        .limit(1);
      if (!forn || forn.length === 0) {
        return NextResponse.json(
          { error: `Fornecedor "${fornecedorOc}" não encontrado` },
          { status: 400 },
        );
      }
    }

    const { data: updated, error } = await supabase
      .from("siso_pedido_itens")
      .update({ fornecedor_oc: fornecedorOc })
      .in("id", itemIds)
      .select("id, pedido_id");
    if (error) throw new Error(`Erro ao atualizar fornecedor: ${error.message}`);

    const rows = updated ?? [];
    // Um evento por pedido distinto afetado (audit trail).
    const pedidoIds = [...new Set(rows.map((r) => String(r.pedido_id)))];
    await registrarEventos(
      pedidoIds.map((pedidoId) => ({
        pedidoId,
        evento: "compra_fornecedor_alterado" as const,
        usuarioId: session.id,
        usuarioNome: session.nome,
        detalhes: { fornecedor_oc: fornecedorOc, item_ids: itemIds },
      })),
    );

    return NextResponse.json({ ok: true, atualizados: rows.length });
  } catch (err) {
    logger.error("compras-trocar-fornecedor", "Erro ao trocar fornecedor", {
      error: err instanceof Error ? err.message : String(err),
      item_ids: itemIds,
    });
    return NextResponse.json(
      { error: "Erro interno ao trocar fornecedor" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/app/api/wms/compras/itens/fornecedor/fornecedor-troca.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros (confirma que `registrarEventos` existe — assinatura batch em `historico-service.ts`; se só existir `registrarEvento`, trocar pra um `Promise.all(pedidoIds.map(...))` de `registrarEvento`).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/wms/compras/itens/fornecedor/
git commit -m "feat(compras): PATCH bulk pra trocar fornecedor_oc por item"
```

---

### Task A3: UI — ação "Trocar fornecedor" no kebab do item

**Files:**
- Modify: `src/app/wms/compras/page.tsx` (ItemKebab ~904-982, render ~837-842, mutations ~434, handlers ~586-613)

- [ ] **Step 1: Estender `ItemKebab` com a ação**

Em `ItemKebab` (props e JSX), adicionar `onTrocarFornecedor`:

```typescript
function ItemKebab({
  onIndisponivel,
  onPropostaCancelamento,
  onTrocarFornecedor,
}: {
  onIndisponivel: () => void;
  onPropostaCancelamento: () => void;
  onTrocarFornecedor: () => void;
}) {
```

Dentro do painel do popover (depois do botão "Propor cancelamento"), adicionar:

```tsx
            <button
              className="wms-btn wms-btn-ghost wms-btn-sm"
              style={{ justifyContent: "flex-start" }}
              onClick={() => { setOpen(false); onTrocarFornecedor(); }}
              type="button"
            >
              <Icon name="edit" size={11} />
              Trocar fornecedor
            </button>
```

(Se `"edit"` não existir no `Icon`, usar `"alert"` como os outros.)

- [ ] **Step 2: Wire no render do item**

No ponto onde `<ItemKebab ... />` é renderizado (~837-842), adicionar a prop:

```tsx
                        <ItemKebab
                          onIndisponivel={() => onIndisponivel(item)}
                          onPropostaCancelamento={() => onPropostaCancelamento(item)}
                          onTrocarFornecedor={() => onTrocarFornecedor(item)}
                        />
```

- [ ] **Step 3: Query de fornecedores + mutation + handler + modal**

No corpo do componente da aba Comprar (onde vivem `indisponivelMut` etc.), adicionar:

```tsx
  // Lista de fornecedores pro picker (mesma fonte do modal de compra manual).
  const fornecedoresQuery = useQuery<{ rows: { id: string; nome: string }[] }>({
    queryKey: ["compras-manuais-fornecedores"],
    queryFn: () => wmsApi<{ rows: { id: string; nome: string }[] }>("/api/wms/fornecedores"),
    staleTime: 5 * 60_000,
  });

  const [trocaFornAlvo, setTrocaFornAlvo] = useState<ComprarItem | null>(null);
  const [trocaFornNome, setTrocaFornNome] = useState("");

  const trocarFornecedorMut = useMutation({
    mutationFn: async (args: { itemIds: string[]; fornecedor_oc: string }) => {
      const r = await sisoFetch("/api/wms/compras/itens/fornecedor", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_ids: args.itemIds, fornecedor_oc: args.fornecedor_oc }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Fornecedor atualizado");
      setTrocaFornAlvo(null);
      setTrocaFornNome("");
      onMutated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onTrocarFornecedor = useCallback((item: ComprarItem) => {
    setTrocaFornAlvo(item);
    setTrocaFornNome("");
  }, []);
```

E renderizar um Modal simples (usar o `Modal` de `@/components/wms/ui/wms-ui` se disponível, senão inline) no fim do JSX da aba:

```tsx
      {trocaFornAlvo && (
        <Modal
          title={`Trocar fornecedor — ${trocaFornAlvo.sku}`}
          onClose={() => setTrocaFornAlvo(null)}
        >
          <Field label="Novo fornecedor">
            <select
              className="wms-select"
              value={trocaFornNome}
              onChange={(e) => setTrocaFornNome(e.target.value)}
              autoFocus
            >
              <option value="">Escolha um fornecedor…</option>
              {(fornecedoresQuery.data?.rows ?? []).map((f) => (
                <option key={f.id} value={f.nome}>{f.nome}</option>
              ))}
            </select>
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button className="wms-btn wms-btn-ghost" onClick={() => setTrocaFornAlvo(null)} type="button">
              Cancelar
            </button>
            <button
              className="wms-btn wms-btn-primary"
              disabled={!trocaFornNome || trocarFornecedorMut.isPending}
              onClick={() => {
                const itemIds = trocaFornAlvo.pedidos.map((p) => p.item_id);
                if (itemIds.length === 0) return;
                trocarFornecedorMut.mutate({ itemIds, fornecedor_oc: trocaFornNome });
              }}
              type="button"
            >
              {trocarFornecedorMut.isPending ? "Salvando…" : "Trocar"}
            </button>
          </div>
        </Modal>
      )}
```

> Garantir os imports no topo: `Modal`, `Field`, `Icon` de `@/components/wms/ui/wms-ui`; `useQuery`, `useMutation` já importados; `wmsApi`, `sisoFetch`, `toast`, `useCallback`, `useState` já presentes. `PedidoVinc` tem `item_id` (confirmado).

- [ ] **Step 4: Lint + typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 5: Verificação manual (app)**

Run: `npm run dev` → abrir `/wms/compras` aba Comprar → kebab de um SKU → "Trocar fornecedor" → escolher outro → confirmar.
Expected: toast "Fornecedor atualizado"; o SKU some do card do fornecedor antigo e aparece no card do novo (lista invalida e reagrupa). Recarregar a página: a troca persiste.

- [ ] **Step 6: Commit**

```bash
git add src/app/wms/compras/page.tsx
git commit -m "feat(compras): UI pra trocar fornecedor do item no kebab"
```

---

### Task A4: Docs + erros-conhecidos (Fase A)

**Files:**
- Modify: `docs/api-reference-complete.md`
- Modify: `erros-conhecidos.yaml`

- [ ] **Step 1: Documentar a rota**

Adicionar em `docs/api-reference-complete.md` (seção compras) a entrada `PATCH /api/wms/compras/itens/fornecedor` — body `{ item_ids: string[], fornecedor_oc: string|null }`, perm `compras.executar`, efeito (regrava `fornecedor_oc` em N linhas + evento `compra_fornecedor_alterado`).

- [ ] **Step 2: Registrar o erro corrigido**

Adicionar entrada em `erros-conhecidos.yaml`:

```yaml
- id: COMPRAS-FORNECEDOR-IMUTAVEL
  date: 2026-06-09
  source: refactor-compras-recebimento
  category: business_logic
  message: "Comprador não conseguia trocar o fornecedor de um item quando o prefixo do SKU casava com fornecedor errado"
  cause: "fornecedor_oc setado 1x no intake do webhook (getFornecedorBySku, PREFIX_MAP hardcoded) sem endpoint de override"
  fix: "PATCH /api/wms/compras/itens/fornecedor (bulk por item_ids) + ação 'Trocar fornecedor' no kebab"
  files:
    - src/app/api/wms/compras/itens/fornecedor/route.ts
    - src/app/wms/compras/page.tsx
  tags: [compras, fornecedor, prefixo]
```

- [ ] **Step 3: Commit**

```bash
git add docs/api-reference-complete.md erros-conhecidos.yaml
git commit -m "docs(compras): rota trocar-fornecedor + erro conhecido"
```

---

# FASE B — Lista unificada por documento (manual + OC)

**Decisões fixas:**
- Aba **Receber** reestrutura de SKU-agregado → **cards por documento** (cada OC + cada compra manual), agrupados por fornecedor, badge `origem: 'oc' | 'manual'`, cada card linka pra page rica. **Sem qty inline.**
- OC docs vêm de `siso_ordens_compra` (status `comprado`, pendente>0) — reusa a lógica de `/api/wms/receber/oc/lista`. `fornecedor` é string na `siso_ordens_compra`. Pendente = soma de `siso_pedido_itens` por `ordem_compra_id`.
- Manual docs vêm de `listarComprasManuais("pendentes")`. Fornecedor via FK→nome.
- Remove a lista `/wms/receber/oc` (página + `/api/wms/receber/oc/lista`). Transferência fica em `/wms/receber/transferencia`.
- **Histórico** une OC `recebido` + manual `recebido`/`cancelado`.

---

### Task B1: Pure helper `mergeReceberDocs` + tipos

**Files:**
- Create: `src/lib/wms/compras-receber-merge.ts`
- Test: `src/lib/wms/compras-receber-merge.test.ts`

- [ ] **Step 1: Teste falhando (pura-função)**

`src/lib/wms/compras-receber-merge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mergeReceberDocs } from "./compras-receber-merge";

describe("mergeReceberDocs", () => {
  it("agrupa OC + manual por fornecedor, com origem e id do documento", () => {
    const grupos = mergeReceberDocs(
      [{ id: "oc1", fornecedor: "Delphi", galpao_nome: "CWB", qty_pendente: 5, criado_em: "2026-06-01T00:00:00Z" }],
      [{ id: "m1", fornecedor: "Delphi", galpao_nome: "CWB", qty_pendente: 3, criado_em: "2026-06-02T00:00:00Z", custo_total: 30 }],
    );
    expect(grupos).toHaveLength(1);
    const g = grupos[0];
    expect(g.fornecedor).toBe("Delphi");
    expect(g.documentos).toHaveLength(2);
    expect(g.documentos.map((d) => d.origem).sort()).toEqual(["manual", "oc"]);
    expect(g.documentos.find((d) => d.origem === "oc")!.id).toBe("oc1");
    expect(g.documentos.find((d) => d.origem === "manual")!.id).toBe("m1");
  });

  it("fornecedores distintos viram grupos distintos, ordenados por nome", () => {
    const grupos = mergeReceberDocs(
      [{ id: "oc1", fornecedor: "Zeta", galpao_nome: null, qty_pendente: 1, criado_em: "2026-06-01T00:00:00Z" }],
      [{ id: "m1", fornecedor: "Alpha", galpao_nome: null, qty_pendente: 1, criado_em: "2026-06-01T00:00:00Z", custo_total: 0 }],
    );
    expect(grupos.map((g) => g.fornecedor)).toEqual(["Alpha", "Zeta"]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/wms/compras-receber-merge.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

`src/lib/wms/compras-receber-merge.ts`:

```typescript
export interface OcDoc {
  id: string;
  fornecedor: string | null;
  galpao_nome: string | null;
  qty_pendente: number;
  criado_em: string | null;
}

export interface ManualDoc {
  id: string;
  fornecedor: string | null;
  galpao_nome: string | null;
  qty_pendente: number;
  criado_em: string | null;
  custo_total: number;
}

export type OrigemDoc = "oc" | "manual";

export interface ReceberDoc {
  origem: OrigemDoc;
  id: string;
  qty_pendente: number;
  criado_em: string | null;
  /** custo total do documento (só manual tem; OC vem da NF downstream) */
  custo_total: number | null;
  /** rota da page rica de recebimento */
  href: string;
}

export interface ReceberFornecedorGrupo {
  fornecedor: string;
  galpao_nome: string | null;
  documentos: ReceberDoc[];
}

/**
 * Une documentos de OC e de compra manual numa lista de grupos por fornecedor,
 * cada documento com origem + href pra page rica. Ordena grupos por fornecedor
 * (pt-BR) e documentos por criado_em asc (mais antigo primeiro = mais urgente).
 */
export function mergeReceberDocs(
  ocs: OcDoc[],
  manuais: ManualDoc[],
): ReceberFornecedorGrupo[] {
  const map = new Map<string, ReceberFornecedorGrupo>();

  function grupo(fornecedor: string | null, galpaoNome: string | null): ReceberFornecedorGrupo {
    const key = fornecedor ?? "Sem fornecedor";
    let g = map.get(key);
    if (!g) {
      g = { fornecedor: key, galpao_nome: galpaoNome, documentos: [] };
      map.set(key, g);
    }
    if (!g.galpao_nome && galpaoNome) g.galpao_nome = galpaoNome;
    return g;
  }

  for (const oc of ocs) {
    grupo(oc.fornecedor, oc.galpao_nome).documentos.push({
      origem: "oc",
      id: oc.id,
      qty_pendente: oc.qty_pendente,
      criado_em: oc.criado_em,
      custo_total: null,
      href: `/wms/receber/oc/${oc.id}`,
    });
  }
  for (const m of manuais) {
    grupo(m.fornecedor, m.galpao_nome).documentos.push({
      origem: "manual",
      id: m.id,
      qty_pendente: m.qty_pendente,
      criado_em: m.criado_em,
      custo_total: m.custo_total,
      href: `/wms/receber/manual/${m.id}`,
    });
  }

  const grupos = [...map.values()];
  for (const g of grupos) {
    g.documentos.sort((a, b) => (a.criado_em ?? "").localeCompare(b.criado_em ?? ""));
  }
  grupos.sort((a, b) => a.fornecedor.localeCompare(b.fornecedor, "pt-BR"));
  return grupos;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/wms/compras-receber-merge.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/compras-receber-merge.ts src/lib/wms/compras-receber-merge.test.ts
git commit -m "feat(compras): helper puro mergeReceberDocs (OC+manual por documento)"
```

---

### Task B2: `fetchReceber` por documento + `fetchHistorico`/`fetchCounts` com manuais

**Files:**
- Modify: `src/app/api/wms/compras/route.ts` (`fetchReceber` ~494-643, `fetchHistorico` ~684-766, `fetchCounts` ~196, GET dispatch ~127-192)
- Test: `src/app/api/wms/compras/compras-receber-merge.test.ts`

- [ ] **Step 1: Teste de rota (Receber inclui manual + origem)**

`src/app/api/wms/compras/compras-receber-merge.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "T" }),
}));
vi.mock("@/lib/permissions", () => ({ userCan: () => true }));
// getFornecedorBySku é usado no fetch antigo; stub neutro.
vi.mock("@/lib/sku-fornecedor", () => ({ getFornecedorBySku: () => null }));
// listarComprasManuais devolve 1 compra pendente da Delphi.
vi.mock("@/lib/wms/compras-manuais", () => ({
  listarComprasManuais: async () => [
    {
      id: "m1", status: "comprado", observacao: null,
      criado_em: "2026-06-02T00:00:00Z", recebido_em: null, galpao_id: "g1",
      fornecedor: { id: "f1", nome: "Delphi" }, empresa: { id: "e1", nome: "NetAir" },
      itens: [{ id: "mi1", produto_id: "p1", sku: "X", descricao: "x", qty_comprada: 3, qty_recebida: 0, custo_unitario: 10 }],
    },
  ],
}));

// Supabase: siso_ordens_compra (1 OC Delphi comprado) + siso_pedido_itens pendente + counts.
vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => buildSb(),
}));

function buildSb() {
  return {
    from: (table: string) => {
      if (table === "siso_ordens_compra") {
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        chain.select = self; chain.in = self; chain.eq = self;
        chain.order = async () => ({
          data: [{ id: "oc1", fornecedor: "Delphi", galpao_id: "g1", status: "comprado", created_at: "2026-06-01T00:00:00Z", siso_galpoes: { nome: "CWB" } }],
          error: null,
        });
        return chain;
      }
      if (table === "siso_pedido_itens") {
        return {
          select: () => ({
            in: async () => ({
              data: [{ ordem_compra_id: "oc1", compra_quantidade_solicitada: 5, compra_quantidade_recebida: 0 }],
              error: null,
            }),
            eq: () => ({ /* fetchCounts path */ then: undefined }),
          }),
        };
      }
      return { select: () => ({ eq: async () => ({ count: 0, error: null }) }) };
    },
  };
}

import { GET } from "./route";

describe("GET /api/wms/compras?tab=receber (unificado por documento)", () => {
  it("retorna grupos por fornecedor com docs OC + manual e origem", async () => {
    const req = new Request("http://x/api/wms/compras?tab=receber") as never;
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    const delphi = json.fornecedores.find((f: { fornecedor: string }) => f.fornecedor === "Delphi");
    expect(delphi).toBeTruthy();
    const origens = delphi.documentos.map((d: { origem: string }) => d.origem).sort();
    expect(origens).toEqual(["manual", "oc"]);
  });
});
```

> Nota ao implementador: o mock chainable acima é ilustrativo do contrato; ajuste a cadeia exata de métodos pra casar com a implementação que você escrever no Step 2 (mesma técnica do `produto-fornecedores-patch-409.test.ts`). O ASSERT que importa é o shape de resposta: `fornecedores[].documentos[].origem`.

- [ ] **Step 2: Reescrever `fetchReceber` pra documentos**

Substituir o corpo de `fetchReceber` por: (a) buscar OCs via a mesma query de `/api/wms/receber/oc/lista` (siso_ordens_compra status `comprado` + pendente por `ordem_compra_id`); (b) buscar manuais via `listarComprasManuais("pendentes")` e mapear pra `ManualDoc` (qty_pendente = soma `qty_comprada - qty_recebida`; custo_total = soma `qty_comprada * (custo_unitario ?? 0)`; galpao_nome resolvido de `siso_galpoes` pelo `galpao_id` — ou null); (c) `return mergeReceberDocs(ocDocs, manualDocs)`.

```typescript
import { mergeReceberDocs, type OcDoc, type ManualDoc } from "@/lib/wms/compras-receber-merge";
import { listarComprasManuais } from "@/lib/wms/compras-manuais";

async function fetchReceber(supabase: SupabaseClient) {
  // OCs pendentes de recebimento (reusa lógica de receber/oc/lista)
  const { data: ocs, error: ocErr } = await supabase
    .from("siso_ordens_compra")
    .select("id, fornecedor, galpao_id, status, created_at, siso_galpoes(nome)")
    .eq("status", "comprado")
    .order("created_at", { ascending: true });
  if (ocErr) throw new Error(`Erro ao buscar OCs: ${ocErr.message}`);

  const ocIds = (ocs ?? []).map((o) => String(o.id));
  const pendenteByOC = new Map<string, number>();
  if (ocIds.length > 0) {
    const { data: itens } = await supabase
      .from("siso_pedido_itens")
      .select("ordem_compra_id, compra_quantidade_solicitada, compra_quantidade_recebida")
      .in("ordem_compra_id", ocIds);
    for (const it of itens ?? []) {
      const ocId = String(it.ordem_compra_id ?? "");
      if (!ocId) continue;
      const pend = Number(it.compra_quantidade_solicitada ?? 0) - Number(it.compra_quantidade_recebida ?? 0);
      if (pend > 0) pendenteByOC.set(ocId, (pendenteByOC.get(ocId) ?? 0) + pend);
    }
  }
  const ocDocs: OcDoc[] = (ocs ?? [])
    .map((oc) => ({
      id: String(oc.id),
      fornecedor: (oc.fornecedor as string | null) ?? null,
      galpao_nome: (oc.siso_galpoes as { nome?: string } | null)?.nome ?? null,
      qty_pendente: pendenteByOC.get(String(oc.id)) ?? 0,
      criado_em: (oc.created_at as string | null) ?? null,
    }))
    .filter((d) => d.qty_pendente > 0);

  // Compras manuais pendentes
  const manuais = await listarComprasManuais("pendentes");
  const manualDocs: ManualDoc[] = manuais.map((m) => {
    const pend = m.itens.reduce((s, it) => s + Math.max(it.qty_comprada - it.qty_recebida, 0), 0);
    const custoTotal = m.itens.reduce((s, it) => s + it.qty_comprada * (it.custo_unitario ?? 0), 0);
    return {
      id: m.id,
      fornecedor: m.fornecedor?.nome ?? null,
      galpao_nome: null, // opcional: resolver via lookup de galpão se quiser exibir
      qty_pendente: pend,
      criado_em: m.criado_em,
      custo_total: custoTotal,
    };
  });

  return mergeReceberDocs(ocDocs, manualDocs);
}
```

> A resposta de `GET ... tab=receber` passa a ser `{ counts, fornecedores: ReceberFornecedorGrupo[] }` (shape novo — o front muda na Task B3).

- [ ] **Step 3: `fetchHistorico` une manuais recebidos**

Em `fetchHistorico`, após montar os grupos de OC, buscar `listarComprasManuais("recebido")` e adicionar cada item recebido como linha nos grupos (chave `${fornecedor}||${data}` usando `recebido_em.substring(0,10)`). Manter a paginação por cursor SOMENTE sobre OC (`comprado_em`); manuais entram só na primeira página (documentar essa limitação com um `logger.info` ou comentário). Cada linha de manual ganha `origem: "manual"`; OC `origem: "oc"`.

- [ ] **Step 4: `fetchCounts` inclui manuais**

Em `fetchCounts`, somar a `receber` o nº de compras manuais com status em (`comprado`,`parcial`) e a `historico` as `recebido`/`cancelado`:

```typescript
  const manuaisPend = await listarComprasManuais("pendentes");
  const manuaisHist = await listarComprasManuais("recebido");
  // counts.receber += manuaisPend.length; counts.historico += manuaisHist.length;
```

(Adicionar ao objeto de counts existente.)

- [ ] **Step 5: Rodar testes + typecheck**

Run: `npx vitest run src/app/api/wms/compras/ && npx tsc --noEmit`
Expected: PASS; sem erros de tipo.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/wms/compras/route.ts src/app/api/wms/compras/compras-receber-merge.test.ts
git commit -m "feat(compras): Receber por documento (OC+manual) + counts/historico unificados"
```

---

### Task B3: Front — aba Receber por documento + remover aba Manuais

**Files:**
- Modify: `src/app/wms/compras/page.tsx` (tipos ~83-113, tab bar ~251-305, `TabReceber` ~986-1226)
- Reference (delete usage): `src/components/wms/compras/aba-manuais.tsx`

- [ ] **Step 1: Trocar os tipos de Receber**

Substituir `ReceberItem`/`ReceberFornecedor`/`ReceberResponse` por:

```typescript
type OrigemDoc = "oc" | "manual";
interface ReceberDoc {
  origem: OrigemDoc;
  id: string;
  qty_pendente: number;
  criado_em: string | null;
  custo_total: number | null;
  href: string;
}
interface ReceberFornecedorGrupo {
  fornecedor: string;
  galpao_nome: string | null;
  documentos: ReceberDoc[];
}
interface ReceberResponse {
  counts: Counts;
  fornecedores: ReceberFornecedorGrupo[];
}
```

- [ ] **Step 2: Reescrever `TabReceber` pra cards-por-documento que LINKAM**

`TabReceber` deixa de ter `receberMut`/inline-qty. Cada grupo de fornecedor lista seus `documentos`; cada documento é um card/linha clicável (`useRouter().push(doc.href)`), com badge origem ("OC" / "Manual"), `qty_pendente`, custo (se `custo_total != null`), aging via `criado_em`. Esqueleto:

```tsx
function TabReceber({ query }: { query: UseQueryResult<ReceberResponse> }) {
  const router = useRouter();
  const fornecedores = query.data?.fornecedores ?? [];
  if (query.isLoading) return <LoadingSpinner />;
  if (fornecedores.length === 0) return <div className="wms-empty">Nada pra receber.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {fornecedores.map((f) => (
        <article key={f.fornecedor} className="wms-frc">
          <div className="wms-frc-h">
            <div className="wms-frc-name">{f.fornecedor}</div>
            {f.galpao_nome && <span className="wms-pcard-chip is-galpao">{f.galpao_nome}</span>}
          </div>
          <div className="wms-frc-body">
            {f.documentos.map((d) => (
              <button
                key={`${d.origem}-${d.id}`}
                className="wms-frc-row"
                style={{ cursor: "pointer", width: "100%", textAlign: "left" }}
                onClick={() => router.push(d.href)}
                type="button"
              >
                <span className={`wms-badge ${d.origem === "manual" ? "is-manual" : "is-oc"}`}>
                  {d.origem === "manual" ? "Manual" : "OC"}
                </span>
                <span>{d.id.slice(0, 8)}</span>
                <span>{fmtNum(d.qty_pendente)} un pendente</span>
                {d.custo_total != null && <span>{fmtBRL(d.custo_total)}</span>}
                <Icon name="chevron-r" />
              </button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
```

> Remover `receberOverrides`/`setReceberOverrides`/`receberMut` e helpers de qty inline da aba Receber. `podeExecutar` não é mais usado aqui (o gate vai pra page rica). Imports: `useRouter`, `fmtNum`, `fmtBRL`, `Icon`, `LoadingSpinner`.

- [ ] **Step 3: Remover a aba Manuais**

- Tirar o import `import { AbaManuais } from "@/components/wms/compras/aba-manuais";` (~26).
- Tirar `"manuais"` do union `type Tab` (~30).
- Remover o `<button>` "Manuais" da tab bar (~282-287).
- Remover `{tab === "manuais" && <AbaManuais />}` (~305).
- **MANTER** o `NovaCompraManualModal` + botão "Nova compra manual" (~240-248).

- [ ] **Step 4: Lint + typecheck + build**

Run: `npm run lint && npx tsc --noEmit && npm run build`
Expected: sem erros. (Se `npm run build` falhar por binário SWC, reinstalar `@next/swc-darwin-arm64` — ver memória do projeto.)

- [ ] **Step 5: Verificação manual**

Run: `npm run dev` → `/wms/compras` aba Receber.
Expected: cards por fornecedor; dentro, um card por documento com badge OC/Manual; clicar abre a page de recebimento. Aba "Manuais" não existe. Criar uma compra manual pelo modal → ela aparece na aba Receber com badge "Manual".

- [ ] **Step 6: Commit**

```bash
git add src/app/wms/compras/page.tsx
git commit -m "feat(compras): aba Receber por documento (OC+manual) que linka pra page rica; remove aba Manuais"
```

---

### Task B4: Remover a lista redundante `/wms/receber/oc`

**Files:**
- Delete: `src/app/wms/receber/oc/page.tsx`
- Delete: `src/app/api/wms/receber/oc/lista/route.ts`
- Modify: qualquer link pra `/wms/receber/oc` (grep) → `/wms/compras?tab=receber`

- [ ] **Step 1: Achar referências**

Run: `grep -rn "receber/oc\b\|receber/oc\"\|receber/oc/lista\|/wms/receber/oc'" src/ --include=*.tsx --include=*.ts | grep -v "receber/oc/\[id\]"`
Expected: lista de usos (sidebar, home, links). Anotar cada um.

- [ ] **Step 2: Redirecionar/limpar links**

Trocar links de listagem `/wms/receber/oc` por `/wms/compras?tab=receber`. **NÃO** mexer em `/wms/receber/oc/[id]` (a page de detalhe — vira rica na Fase C). Remover item de sidebar "Receber OC" se houver (deixar o acesso via Compras).

- [ ] **Step 3: Deletar a lista + endpoint**

```bash
git rm src/app/wms/receber/oc/page.tsx src/app/api/wms/receber/oc/lista/route.ts
```

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: sem erros (nenhum import órfão de `receber/oc/lista`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(compras): remove lista /wms/receber/oc redundante (Receber unificado em compras)"
```

---

### Task B5: Docs + erros (Fase B)

**Files:**
- Modify: `docs/api-reference-complete.md`, `docs/architecture-and-flows.md`, `erros-conhecidos.yaml`

- [ ] **Step 1: Atualizar docs**

- `api-reference-complete.md`: novo shape de `GET /api/wms/compras?tab=receber` (`fornecedores: grupo[].documentos[]` com `origem`/`href`); remoção de `GET /api/wms/receber/oc/lista`; counts incluem manuais.
- `architecture-and-flows.md`: aba Receber agora unifica OC+manual por documento; transferência segue à parte.

- [ ] **Step 2: erros-conhecidos**

```yaml
- id: COMPRAS-MANUAL-OC-SEPARADOS
  date: 2026-06-09
  source: refactor-compras-recebimento
  category: business_logic
  message: "Compra manual ficava numa aba isolada, separada das OC pendentes de recebimento"
  cause: "siso_compras_manuais e siso_pedido_itens listados em telas diferentes"
  fix: "aba Receber unifica OC+manual por documento (flag origem) com link pra page rica; aba Manuais removida"
  files: [src/app/api/wms/compras/route.ts, src/app/wms/compras/page.tsx, src/lib/wms/compras-receber-merge.ts]
  tags: [compras, recebimento, manual, unificacao]
```

- [ ] **Step 3: Commit**

```bash
git add docs/ erros-conhecidos.yaml
git commit -m "docs(compras): Receber unificado por documento"
```

---

# FASE C — Recebimento unificado (componente rico `<ReceberLote>`)

**Decisões fixas:**
- **NÃO existe payload único.** Quatro fluxos, quatro endpoints, quatro shapes de item. O componente recebe **adapters injetados** (`loadItems()` / `submit()`), não um body fixo.
- Matriz de features por fluxo:

| flag | avulso | OC | manual | transferência |
|---|---|---|---|---|
| `canAddItems` (ProdutoCombo) | ✅ | — | — | — |
| `qtyEditable` | ✅ | ✅ (qty_real, default=pendente) | ✅ (qty_recebida, max=faltante) | — (fixa) |
| `custoVisible` | ✅ obrigatório | ✅ opcional | ✅ opcional (placeholder=salvo) | — |
| `locPickVisible` (putaway+combo) | ✅ | — (server→RECEBIMENTO) | — | ✅ (combo allowCreate=false, obrigatório) |
| `divergenciaVisible` | — | ✅ (motivo quando qty≠pendente) | — | — |
| `imprimirVisible` | ✅ | — | — | — |
| `mlBlockVisible` (anúncio) | ✅ | ✅ | ✅ | ✅ |
| `planoSidebarVisible` | ✅ | — | — | — |
| left config form (galpão/fornecedor/origem/data/…) | ✅ | — (chip read-only) | — (chip read-only) | — |

- Anúncio (`MlAnunciosBlock`) liga nos 4 (é o que o user pediu: "mostra se tem anúncio"). Custo NÃO em transferência.
- **Styling:** o componente é `wms-*` (design system do avulso). OC/manual/transferência hoje são Tailwind cru → serão re-estilizados pro `wms-*` (intencional — é o ponto do refactor).
- Backends INTACTOS. Adapters só montam o body de cada endpoint existente.

---

### Task C1: Adapters puros (payload builders) + tipos do componente

**Files:**
- Create: `src/components/wms/recebimento/receber-lote-types.ts`
- Create: `src/components/wms/recebimento/receber-lote-adapters.ts`
- Test: `src/components/wms/recebimento/receber-lote-adapters.test.ts`

- [ ] **Step 1: Tipos do componente**

`src/components/wms/recebimento/receber-lote-types.ts`:

```typescript
import type { Produto } from "@/types";

/** Item que o componente rico gerencia (superset dos 4 fluxos). */
export interface ReceberLoteItem {
  uid: string;
  /** produto resolvido (avulso) OU display-only (fluxos pré-definidos) */
  produto: Produto | null;
  /** display quando produto não é uuid-resolvível (OC usa tiny_produto_id) */
  sku: string;
  descricao: string;
  imagem_url: string | null;
  /** id da linha no backend do fluxo (item_id OC/manual, transferencia_item_id) */
  backendItemId: string | null;
  qty: string;
  /** qty esperada/pendente (read-only ref pra divergência e default) */
  qtyEsperada: number | null;
  custo: string;
  locIdOverride: string | null;
  locCodigoOverride: string | null;
  imprimir: boolean;
  motivoDivergencia: string | null;
}

export type FluxoReceber = "avulso" | "oc" | "manual" | "transferencia";

export interface ReceberLoteConfig {
  fluxo: FluxoReceber;
  canAddItems: boolean;
  productEditable: boolean;
  qtyEditable: boolean;
  custoVisible: boolean;
  custoObrigatorio: boolean;
  locPickVisible: boolean;
  locObrigatoria: boolean;
  divergenciaVisible: boolean;
  imprimirVisible: boolean;
  mlBlockVisible: boolean;
  planoSidebarVisible: boolean;
  leftFormVisible: boolean;
  /** código de permissão pra liberar o Confirmar (ex: 'operacoes.receber') */
  permissaoReceber: string;
  /** chip read-only do header (fornecedor/galpão) nos fluxos pré-definidos */
  headerChips?: { label: string; value: string }[];
}
```

- [ ] **Step 2: Teste falhando dos adapters**

`src/components/wms/recebimento/receber-lote-adapters.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildOcPayload, buildTransferenciaPayload, buildManualPayload } from "./receber-lote-adapters";
import type { ReceberLoteItem } from "./receber-lote-types";

function item(over: Partial<ReceberLoteItem>): ReceberLoteItem {
  return {
    uid: "u", produto: null, sku: "X", descricao: "x", imagem_url: null,
    backendItemId: "i1", qty: "3", qtyEsperada: 5, custo: "", locIdOverride: null,
    locCodigoOverride: null, imprimir: false, motivoDivergencia: null, ...over,
  };
}

describe("buildOcPayload", () => {
  it("manda item_id+qty_real; custo só se >0; motivo só se qty≠pendente", () => {
    const p = buildOcPayload([
      item({ backendItemId: "i1", qty: "3", qtyEsperada: 5, custo: "10", motivoDivergencia: "faltou" }),
    ]);
    expect(p.itens[0]).toEqual({
      item_id: "i1", qty_real: 3, custo_unitario: 10, motivo_divergencia: "faltou",
    });
  });
  it("sem divergência (qty=pendente) não manda motivo", () => {
    const p = buildOcPayload([item({ qty: "5", qtyEsperada: 5, motivoDivergencia: "faltou" })]);
    expect(p.itens[0].motivo_divergencia).toBeUndefined();
  });
});

describe("buildTransferenciaPayload", () => {
  it("manda transferencia_item_id + localizacao_destino_id, exige loc em todos", () => {
    const p = buildTransferenciaPayload([item({ backendItemId: "ti1", locIdOverride: "loc1" })]);
    expect(p.itens[0]).toEqual({ transferencia_item_id: "ti1", localizacao_destino_id: "loc1" });
    expect(() => buildTransferenciaPayload([item({ locIdOverride: null })])).toThrow(/loc/i);
  });
});

describe("buildManualPayload", () => {
  it("manda item_id+qty_recebida; custo só se preenchido; filtra qty<=0", () => {
    const p = buildManualPayload([
      item({ backendItemId: "mi1", qty: "2", custo: "7" }),
      item({ backendItemId: "mi2", qty: "0" }),
    ]);
    expect(p.itens).toEqual([{ item_id: "mi1", qty_recebida: 2, custo_unitario: 7 }]);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run src/components/wms/recebimento/receber-lote-adapters.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 4: Implementar os adapters**

`src/components/wms/recebimento/receber-lote-adapters.ts`:

```typescript
import type { ReceberLoteItem } from "./receber-lote-types";

export function buildOcPayload(itens: ReceberLoteItem[]) {
  return {
    itens: itens.map((it) => {
      const qty = Number(it.qty || "0");
      const custo = Number(it.custo || "0");
      const divergiu = it.qtyEsperada != null && qty !== it.qtyEsperada;
      return {
        item_id: it.backendItemId!,
        qty_real: qty,
        custo_unitario: custo > 0 ? custo : undefined,
        motivo_divergencia: divergiu && it.motivoDivergencia ? it.motivoDivergencia : undefined,
      };
    }),
  };
}

export function buildTransferenciaPayload(itens: ReceberLoteItem[]) {
  const out = itens.map((it) => ({
    transferencia_item_id: it.backendItemId!,
    localizacao_destino_id: it.locIdOverride ?? "",
  }));
  if (out.some((o) => !o.localizacao_destino_id)) {
    throw new Error("Defina a loc destino em todos os itens");
  }
  return { itens: out };
}

export function buildManualPayload(itens: ReceberLoteItem[]) {
  return {
    itens: itens
      .map((it) => {
        const qty = Number(it.qty || "0");
        const custo = it.custo ? Number(it.custo) : undefined;
        return {
          item_id: it.backendItemId!,
          qty_recebida: qty,
          ...(custo ? { custo_unitario: custo } : {}),
        };
      })
      .filter((x) => x.qty_recebida > 0),
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run src/components/wms/recebimento/receber-lote-adapters.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 6: Commit**

```bash
git add src/components/wms/recebimento/receber-lote-types.ts src/components/wms/recebimento/receber-lote-adapters.ts src/components/wms/recebimento/receber-lote-adapters.test.ts
git commit -m "feat(recebimento): tipos + adapters puros de payload por fluxo"
```

---

### Task C2: Componente `<ReceberLote>` + refactor do avulso (regressão)

**Files:**
- Create: `src/components/wms/recebimento/receber-lote.tsx`
- Modify: `src/app/wms/receber/avulso/page.tsx` (vira wrapper fino)

> **Estratégia de extração:** MOVER (não reescrever) o JSX existente do avulso pro componente, gateando cada sub-controle pelos flags de `ReceberLoteConfig`. Origem dos blocos (verbatim no avulso hoje): item state `ItemLote` (52-89), putaway `useQueries` (182-192), `submit` builder (269-330), validade (431-451), grid 2-col + left form (453-499), lista de itens (576-645), sidebar plano de guarda (647-865), `ItemLoteRow` (879-1108). Renomeie `ItemLote`→`ReceberLoteItem` (campos novos: `sku`/`descricao`/`imagem_url`/`backendItemId`/`qtyEsperada`/`motivoDivergencia`).

- [ ] **Step 1: Criar `<ReceberLote>` com a API de props**

`src/components/wms/recebimento/receber-lote.tsx` — assinatura:

```tsx
"use client";
import type { ReceberLoteItem, ReceberLoteConfig } from "./receber-lote-types";

export interface ReceberLoteProps {
  config: ReceberLoteConfig;
  /** galpão fixo (fluxos pré-definidos) ou inicial (avulso permite trocar) */
  galpaoId: string;
  galpaoEditavel: boolean;
  /** itens iniciais (pré-definidos) ou [] (avulso começa vazio/1-linha) */
  itensIniciais: ReceberLoteItem[];
  /** monta o body e faz o POST; resolve com o resultado pra onSuccess */
  submit: (itens: ReceberLoteItem[], ctx: ReceberLoteSubmitCtx) => Promise<unknown>;
  /** invalidação + navegação pós-sucesso (cada fluxo tem o seu) */
  onSuccess: (resp: unknown, itens: ReceberLoteItem[]) => void;
  /** elementos extras do left-form do avulso (origem/empresa/data/…); undefined nos outros */
  renderLeftFormExtra?: () => React.ReactNode;
}

export interface ReceberLoteSubmitCtx {
  galpaoId: string;
  entradaDireta: boolean;
}
```

O corpo do componente é o JSX do avulso movido, com cada bloco condicionado:
- `config.leftFormVisible && (...)` → galpão/fornecedor/origem/etc. (ou `config.headerChips` read-only quando false).
- `config.canAddItems && (...)` → botão "Adicionar item"; `config.productEditable` decide `ProdutoCombo` vs display locked (sku/desc/thumb).
- `config.qtyEditable` → input qty (senão mostra qty fixa).
- `config.custoVisible` → input custo.
- `config.locPickVisible` → bloco putaway + chips + `LocalizacaoCombo` (transferência usa `allowCreate={false}` e loc obrigatória).
- `config.divergenciaVisible` → dropdown `MOTIVOS_DIVERGENCIA` quando `Number(qty) !== qtyEsperada`.
- `config.imprimirVisible` → checkbox imprimir.
- `config.mlBlockVisible && item.sku` → `<MlAnunciosBlock sku={item.sku} />`.
- `config.planoSidebarVisible` → aside plano de guarda; senão o Confirmar fica num rodapé simples.
- Botão Confirmar: `disabled={!valid || !podeReceber}`, `podeReceber = usePermissoes().can(config.permissaoReceber)`, `onClick={() => submit(itens, {galpaoId, entradaDireta}).then((r)=>onSuccess(r, itens))}`.
- `valid`: derivado dos flags — qtyEditable→qty>0; custoObrigatorio→custo>0; locObrigatoria→loc em todos; canAddItems→pelo menos 1 item válido.

> Putaway `useQueries` (182-192) só roda quando `config.locPickVisible` (enabled gate). Mantém o resto inalterado.

- [ ] **Step 2: Avulso vira wrapper fino**

`src/app/wms/receber/avulso/page.tsx` mantém: o left-form extra (origem/empresa/data/motivo/obs via `renderLeftFormExtra`), o seed via `?produto_id=`, e o `submit`/`onSuccess` do avulso (POST `/api/wms/receber` builder das linhas 269-330 + print fire-and-forget + invalidação `['wms-estoque']`,`['wms-ledger']`,… + `iniciarRota`). Config avulso:

```typescript
const CONFIG_AVULSO: ReceberLoteConfig = {
  fluxo: "avulso", canAddItems: true, productEditable: true, qtyEditable: true,
  custoVisible: true, custoObrigatorio: true, locPickVisible: true, locObrigatoria: false,
  divergenciaVisible: false, imprimirVisible: true, mlBlockVisible: true,
  planoSidebarVisible: true, leftFormVisible: true, permissaoReceber: "operacoes.receber",
};
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: sem erros.

- [ ] **Step 4: Regressão do avulso (verificação manual)**

Run: `npm run dev` → `/wms/receber/avulso`.
Expected: comportamento idêntico ao de antes — adicionar SKU por busca, custo obrigatório, anúncio, sugestão de loc, plano de guarda, imprimir, entrada direta, confirmar gera entrada + pendência. (Sem regressão visual/funcional.)

- [ ] **Step 5: Cenário E2E do avulso (se existir) ainda passa**

Run: `grep -rl "receber" scripts/wms/cenarios/catalogo/ | head` e rodar `npm run scenarios:only` no(s) cenário(s) de recebimento avulso, se houver.
Expected: PASS (backend não mudou).

- [ ] **Step 6: Commit**

```bash
git add src/components/wms/recebimento/receber-lote.tsx src/app/wms/receber/avulso/page.tsx
git commit -m "feat(recebimento): componente rico ReceberLote + avulso como wrapper"
```

---

### Task C3: OC usa `<ReceberLote>`

**Files:**
- Modify: `src/app/wms/receber/oc/[id]/page.tsx`

- [ ] **Step 1: Reescrever a page de detalhe da OC como wrapper**

Carrega via `GET /api/wms/receber/oc/[id]` (shape inalterado: `{oc, itens:[{id,sku,descricao,imagem_url,esperado,ja_recebido,pendente,produto_id}]}`), mapeia pra `ReceberLoteItem[]` (`backendItemId=it.id`, `qty=String(it.pendente)`, `qtyEsperada=it.pendente`, `sku/descricao/imagem_url` display, `produto=null`). Config:

```typescript
const CONFIG_OC: ReceberLoteConfig = {
  fluxo: "oc", canAddItems: false, productEditable: false, qtyEditable: true,
  custoVisible: true, custoObrigatorio: false, locPickVisible: false, locObrigatoria: false,
  divergenciaVisible: true, imprimirVisible: false, mlBlockVisible: true,
  planoSidebarVisible: false, leftFormVisible: false, permissaoReceber: "operacoes.receber",
  headerChips: [{ label: "Fornecedor", value: oc.fornecedor ?? "—" }, { label: "Galpão", value: oc.galpao_nome ?? "—" }],
};
```

`submit = (itens) => sisoFetch POST /api/wms/receber/oc/${id} com buildOcPayload(itens)`. `onSuccess` → toast `${itens_recebidos} recebido(s)${oc_fechada?' · OC fechada':''}` + `router.push("/wms/compras?tab=receber")` (a lista voltou pra compras).

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: sem erros.

- [ ] **Step 3: Verificação manual**

Run: `npm run dev` → `/wms/compras?tab=receber` → clicar uma OC.
Expected: page rica — itens travados, qty editável com default=pendente, custo opcional, dropdown de divergência quando qty≠pendente, badge de anúncio por SKU, chips fornecedor/galpão read-only. Confirmar recebe (mov E + pendência, split de excedente preservado no backend) e volta pra `/wms/compras?tab=receber`.

- [ ] **Step 4: Commit**

```bash
git add src/app/wms/receber/oc/[id]/page.tsx
git commit -m "feat(recebimento): OC usa ReceberLote (anúncio, custo, divergência)"
```

---

### Task C4: Recebimento manual — nova page + detalhe

**Files:**
- Create: `src/app/api/wms/compras-manuais/[id]/route.ts` (adicionar `GET` de detalhe; o arquivo hoje só tem `DELETE`)
- Create: `src/app/wms/receber/manual/[id]/page.tsx`
- Test: `src/app/api/wms/compras-manuais/[id]/compra-manual-detalhe.test.ts`

- [ ] **Step 1: Teste do GET de detalhe**

`src/app/api/wms/compras-manuais/[id]/compra-manual-detalhe.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/session", () => ({ getSessionUser: async () => ({ id: "u1", nome: "T" }) }));
vi.mock("@/lib/permissions", () => ({ userCan: () => true }));
const { listarSpy } = vi.hoisted(() => ({
  listarSpy: vi.fn(async () => [
    { id: "m1", status: "comprado", observacao: null, criado_em: "2026-06-02T00:00:00Z", recebido_em: null,
      galpao_id: "g1", fornecedor: { id: "f1", nome: "Delphi" }, empresa: { id: "e1", nome: "NetAir" },
      itens: [{ id: "mi1", produto_id: "p1", sku: "X", descricao: "x", qty_comprada: 3, qty_recebida: 0, custo_unitario: 10 }] },
  ]),
}));
vi.mock("@/lib/wms/compras-manuais", () => ({ listarComprasManuais: listarSpy }));

import { GET } from "./route";

describe("GET /api/wms/compras-manuais/[id]", () => {
  it("retorna a compra manual pelo id", async () => {
    const res = await GET(new Request("http://x/api/wms/compras-manuais/m1") as never, {
      params: Promise.resolve({ id: "m1" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.compra.id).toBe("m1");
    expect(json.compra.itens[0].sku).toBe("X");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/app/api/wms/compras-manuais/[id]/compra-manual-detalhe.test.ts`
Expected: FAIL — `GET` não exportado.

- [ ] **Step 3: Adicionar `GET` ao route existente**

Em `src/app/api/wms/compras-manuais/[id]/route.ts` (mantendo o `DELETE`), adicionar:

```typescript
import { listarComprasManuais } from "@/lib/wms/compras-manuais";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "operacoes.receber", "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const { id } = await params;
  // reusa o list (pendentes) e filtra; barato no volume atual.
  const todas = await listarComprasManuais("pendentes");
  const compra = todas.find((c) => c.id === id);
  if (!compra) return NextResponse.json({ error: "Compra não encontrada" }, { status: 404 });
  return NextResponse.json({ compra });
}
```

> `userCan(session, a, b)` exige TODAS por padrão; se quiser "qualquer uma", usar `userCanAny`. Aqui a intenção é "receber"; usar `userCan(session, "operacoes.receber")` e simplificar se preferir.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/app/api/wms/compras-manuais/[id]/compra-manual-detalhe.test.ts`
Expected: PASS.

- [ ] **Step 5: Page de recebimento manual (wrapper)**

`src/app/wms/receber/manual/[id]/page.tsx`: carrega `GET /api/wms/compras-manuais/${id}`, mapeia itens pendentes pra `ReceberLoteItem` (`backendItemId=it.id`, `qty=String(qty_comprada-qty_recebida)`, `qtyEsperada=qty_comprada-qty_recebida`, `custo=it.custo_unitario?String:""`). Config:

```typescript
const CONFIG_MANUAL: ReceberLoteConfig = {
  fluxo: "manual", canAddItems: false, productEditable: false, qtyEditable: true,
  custoVisible: true, custoObrigatorio: false, locPickVisible: false, locObrigatoria: false,
  divergenciaVisible: false, imprimirVisible: false, mlBlockVisible: true,
  planoSidebarVisible: false, leftFormVisible: false, permissaoReceber: "compras.executar",
  headerChips: [{ label: "Fornecedor", value: compra.fornecedor?.nome ?? "—" }, { label: "Empresa", value: compra.empresa?.nome ?? "—" }],
};
```

`submit = (itens) => sisoFetch POST /api/wms/compras-manuais/${id}/receber com buildManualPayload(itens)`. `onSuccess` → toast "Recebimento registrado" + `qc.invalidateQueries(['wms-compras'])` + `router.push("/wms/compras?tab=receber")`.

- [ ] **Step 6: Typecheck + build + verificação manual**

Run: `npx tsc --noEmit && npm run build` → depois `npm run dev` → `/wms/compras?tab=receber` → clicar uma compra Manual.
Expected: page rica; itens travados com custo pré-preenchido (placeholder do salvo), badge de anúncio, sem loc/divergência/imprimir. Confirmar recebe (mov E + put-away via `receberCompraManual`) e volta.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/wms/compras-manuais/[id]/route.ts src/app/api/wms/compras-manuais/[id]/compra-manual-detalhe.test.ts src/app/wms/receber/manual/[id]/page.tsx
git commit -m "feat(recebimento): page rica de compra manual (/wms/receber/manual/[id]) + GET detalhe"
```

---

### Task C5: Transferência usa `<ReceberLote>`

**Files:**
- Modify: `src/app/wms/receber/transferencia/[id]/page.tsx`

- [ ] **Step 1: Reescrever como wrapper**

Carrega `GET /api/wms/receber/transferencia/[id]` (`{transferencia:{id,galpao_destino_id,…,itens:[{id,sku,qty,produto_id,mov_entrada_id}]}}`), filtra itens com `mov_entrada_id == null`, mapeia pra `ReceberLoteItem` (`backendItemId=it.id`, `qty=String(it.qty)`, `qtyEsperada=it.qty`, `sku=it.sku??''`). Config:

```typescript
const CONFIG_TRANSF: ReceberLoteConfig = {
  fluxo: "transferencia", canAddItems: false, productEditable: false, qtyEditable: false,
  custoVisible: false, custoObrigatorio: false, locPickVisible: true, locObrigatoria: true,
  divergenciaVisible: false, imprimirVisible: false, mlBlockVisible: true,
  planoSidebarVisible: false, leftFormVisible: false, permissaoReceber: "operacoes.receber",
  headerChips: [{ label: "Origem", value: info.galpao_origem_nome ?? "—" }, { label: "Destino", value: info.galpao_destino_nome ?? "—" }],
};
```

`galpaoId = info.galpao_destino_id` (loc do destino; `LocalizacaoCombo allowCreate=false`). `submit = (itens) => sisoFetch POST /api/wms/transferencias/${id}/receber com buildTransferenciaPayload(itens)`. `onSuccess` → toast + `router.push("/wms/receber/transferencia")`. Tolerar 409 `TRANSFERENCIA_OUTRO_RECEBIMENTO` (mostra `body.error`).

> Em transferência, o `locPickVisible` mostra o combo de loc MAS sem a sugestão de putaway (a sugestão é avulso-only). Garantir no componente que o bloco putaway (`useQueries`) só liga em `config.fluxo === "avulso"` OU usar um flag `putawaySuggest` separado = só avulso. Ajustar `ReceberLoteConfig` com `putawaySuggest: boolean` se necessário (avulso=true, transferência=false), pra não chamar `/api/wms/receber?produto_id=` em transferência.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: sem erros.

- [ ] **Step 3: Verificação manual**

Run: `npm run dev` → `/wms/receber/transferencia` → clicar uma transferência em trânsito.
Expected: page rica; itens travados, qty fixa, só combo de loc destino (obrigatório em todos), badge de anúncio, sem custo/fornecedor/divergência. Confirmar gera as entradas E e marca recebida.

- [ ] **Step 4: Commit**

```bash
git add src/app/wms/receber/transferencia/[id]/page.tsx
git commit -m "feat(recebimento): transferência usa ReceberLote (anúncio + loc obrigatória)"
```

---

### Task C6: Docs + erros + integração (Fase C)

**Files:**
- Modify: `docs/api-reference-complete.md`, `docs/architecture-and-flows.md`, `CLAUDE.md` (seção Estrutura — novo componente), `erros-conhecidos.yaml`

- [ ] **Step 1: Docs**

- `api-reference-complete.md`: novo `GET /api/wms/compras-manuais/[id]` (detalhe); nova rota de UI `/wms/receber/manual/[id]`.
- `architecture-and-flows.md`: os 4 fluxos de recebimento convergem na UI `<ReceberLote>` (backends inalterados).
- `CLAUDE.md` → "Estrutura do Projeto": adicionar `components/wms/recebimento/{receber-lote,receber-lote-types,receber-lote-adapters}.tsx` (UI rica compartilhada de recebimento).

- [ ] **Step 2: erros-conhecidos**

```yaml
- id: RECEBIMENTO-OC-TRANSF-POBRE
  date: 2026-06-09
  source: refactor-compras-recebimento
  category: business_logic
  message: "Recebimento de OC/transferência era tabela seca (sem anúncio, etiqueta, putaway) vs avulso rico"
  cause: "cada fluxo tinha sua page própria; só avulso tinha a UI rica"
  fix: "componente compartilhado ReceberLote config-driven; OC/manual/transferência/avulso renderizam o mesmo componente com adapters por fluxo"
  files: [src/components/wms/recebimento/receber-lote.tsx, src/app/wms/receber/oc/[id]/page.tsx, src/app/wms/receber/manual/[id]/page.tsx, src/app/wms/receber/transferencia/[id]/page.tsx]
  tags: [recebimento, oc, transferencia, manual, ui]
```

- [ ] **Step 3: Suite completa**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: unit verde, sem erros de tipo, build OK.

- [ ] **Step 4: (Opcional, se .env.test.local presente) cenários + integração**

Run: `npm run scenarios` (e `npm run test:integration` se houver teste novo de RPC — não há nesta fase).
Expected: cenários de recebimento (avulso/OC/transferência) verdes — backends inalterados garantem isso.

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md erros-conhecidos.yaml
git commit -m "docs(recebimento): ReceberLote compartilhado + erro conhecido"
```

---

## Self-review (cobertura do spec)

- **A (fornecedor override):** Task A1-A4 → endpoint bulk + UI no kebab + evento + docs. ✅
- **B (lista unificada por documento):** B1 helper puro + B2 backend (Receber/Histórico/counts) + B3 front (cards por doc + remove Manuais) + B4 remove lista redundante + B5 docs. ✅
- **C (recebimento rico):** C1 adapters/tipos + C2 componente+avulso + C3 OC + C4 manual (page+GET) + C5 transferência + C6 docs/suite. ✅
- **Sem migration:** confirmado — nenhuma task cria SQL. ✅
- **Anúncio nos 4 fluxos:** `mlBlockVisible:true` em todas as configs. ✅
- **Transferência sem custo:** `custoVisible:false` em CONFIG_TRANSF. ✅

## Riscos / pontos de atenção

- **Putaway em transferência:** garantir `putawaySuggest`/gate por fluxo pra NÃO chamar `/api/wms/receber?produto_id=` fora do avulso (Task C5 Step 1).
- **`registrarEventos` (batch):** se não existir, usar `Promise.all` de `registrarEvento` (Task A2 Step 5).
- **Paginação do Histórico unificado:** manuais entram só na 1ª página (cursor é sobre `comprado_em` da OC) — limitação documentada (Task B2 Step 3). Aceitável no volume atual.
- **Re-estilização:** OC/manual/transferência passam de Tailwind cru → `wms-*`. Visual muda (intencional). Verificação manual em cada page (C3/C4/C5).
- **Links órfãos pra `/wms/receber/oc`:** Task B4 Step 1 grep cobre.

---

## Execução

Plano salvo. Escolha de execução vem a seguir (subagent-driven recomendado).
