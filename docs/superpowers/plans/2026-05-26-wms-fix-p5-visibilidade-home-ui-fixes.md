# WMS Fix · P5 · Visibilidade Home + UI Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore principle PR-3 (realtime cross-module) and PR-8 (exceptions visible on home). Add 5 new card categories to quadro home, fix galpão filter that hides 69% of pending orders, expand realtime hook to subscribe to 5 new tables (post-P1), fix 12 specific UI bugs (Classe C broken, label inverted, banner no-op, etc.).

**Architecture:** Dashboard service `montarDashboardTarefas` gains 5 new counters. Home page wraps existing 6 cards + new 5 in a collapsible "Exceções" section (default expanded if any counter > 0). Hook subscribes to: `siso_devolucoes_pendentes`, `siso_transferencias_galpao`, `siso_movimentacoes` (filtered for reservas), plus re-subscribes to existing 5 tables now that P1 added them to publication. UI fixes are surgical per-file.

**Tech Stack:** React 19, Tailwind 4, Lucide, Supabase Realtime client, TanStack Query, sonner.

**Worktree:** `.claude/worktrees/wms-fix-p5/`. Branch: `wms-fix-p5`.

**Staging only.**

**Dependency note:** P5 BLOCKED on P1 merge (needs publication). Independent of P2/P3/P4/P6 except: Banner D10 task depends on P3's `cancelar pedido com OC estornando saldo` endpoint; parcial guarda avatar task depends on P3's confirmar guarda lock fix.

---

## Índice por seção

| Seção | Tópico | Tasks |
|---|---|---|
| §0 | Setup + dependências (P1 verify) | 4 |
| §1 | Dashboard service — 6 novos contadores | 18 |
| §2 | Galpão filter fix (separacao_galpao_id NULL) | 5 |
| §3 | Realtime hook — 3 novas subscribes + 5 re-validate | 14 |
| §4 | Home page UI — 5 novos cards + collapsible | 18 |
| §5 | UI bug fixes individuais (12 fixes surgicais) | 28 |
| §6 | Realtime invalidate em mov R criada/liberada | 4 |
| §7 | Smoke matrix manual + verificação final | 8 |
| §8 | Documentação + PR | 4 |
| **Total** | | **~103** |

---

## §0. Setup + dependências (verificação P1)

### Task 0.1 — Criar worktree e branch

- [ ] Verificar que `develop` está atualizado (`git fetch origin develop && git log --oneline origin/develop -3`)
- [ ] Criar worktree: `git worktree add .claude/worktrees/wms-fix-p5 -b wms-fix-p5 origin/develop`
- [ ] `cd .claude/worktrees/wms-fix-p5/` (todos os comandos abaixo são executados aqui)
- [ ] `npm install` (vitest + react setup)
- [ ] Commit inicial vazio: `git commit --allow-empty -m "chore(p5): worktree setup"`

### Task 0.2 — Verificar que P1 foi mergeado

P5 depende de P1 ter expandido a publication realtime. Sem isso, as 5 subscribes do hook atual continuam não disparando.

- [ ] Verificar commit P1 no histórico: `git log --oneline origin/develop | grep -E "wms-fix-p1|realtime.publication" | head -5`
- [ ] Se P1 ainda não mergeado: **PARAR**. Notificar user pra mergear P1 primeiro e voltar.
- [ ] Confirmar via Supabase MCP que a publication contém as tabelas que P5 precisa:

```sql
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY tablename;
```

Lista esperada (após P1) deve conter no mínimo:
- `siso_custo_medio`
- `siso_devolucoes_pendentes` ← novo no P1
- `siso_estoque`
- `siso_inventario_contagens`
- `siso_inventario_divergencias`
- `siso_inventario_localizacoes`
- `siso_inventario_operadores`
- `siso_inventario_sessoes` ← novo no P1
- `siso_movimentacoes`
- `siso_pedido_item_realocacoes`
- `siso_pedido_itens` ← novo no P1
- `siso_pedidos` ← novo no P1
- `siso_transferencias_galpao` ← novo no P1
- `siso_wms_pendencias_guarda` ← novo no P1

- [ ] Se alguma das tabelas marcadas "novo no P1" está faltando: **PARAR** e abrir issue contra P1 antes de continuar.
- [ ] Documentar a lista observada em comentário no commit de setup pra rastreabilidade.

### Task 0.3 — Smoke test que P1 realmente liberou eventos

Verifica end-to-end que um INSERT na tabela nova dispara evento realtime no cliente. Sem isso, P5 builda em cima de premissa não-verificada.

- [ ] Criar `scripts/wms/cenarios/realtime-publication-smoke.ts` (rascunho dev, não vai pra PR):

```typescript
// scripts/wms/cenarios/realtime-publication-smoke.ts
// Smoke test manual: roda uma vez pra confirmar que P1 mergeou correto.
// NÃO é regressão automatizada — confirma premissa antes de implementar P5.
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

const tabelas = [
  "siso_pedidos",
  "siso_wms_pendencias_guarda",
  "siso_inventario_sessoes",
  "siso_devolucoes_pendentes",
  "siso_transferencias_galpao",
];

const recebidos = new Set<string>();
for (const tabela of tabelas) {
  sb.channel(`smoke-${tabela}`)
    .on("postgres_changes", { event: "*", schema: "public", table: tabela }, () => {
      recebidos.add(tabela);
      console.log(`[smoke] evento recebido em ${tabela}`);
    })
    .subscribe();
}
// Espera 5s, então loga resultado
setTimeout(() => {
  for (const t of tabelas) {
    console.log(`${recebidos.has(t) ? "OK" : "FAIL"}: ${t}`);
  }
  process.exit(0);
}, 60_000);
```

- [ ] Em outra aba, fazer um INSERT/UPDATE em cada tabela via Supabase MCP `execute_sql` (1 row temporária que pode ser deletada em seguida, ex: criar/cancelar uma pendência fake)
- [ ] Verificar que todos os 5 logam "evento recebido"
- [ ] Se algum falhar: **PARAR** e abrir issue contra P1
- [ ] Deletar `scripts/wms/cenarios/realtime-publication-smoke.ts` (não é regressão)
- [ ] Commit: `git commit -am "chore(p5): smoke verification of P1 publication"`

### Task 0.4 — Mapear arquivos que P5 vai tocar

Lista canônica pra evitar drift durante a implementação. Salva em comentário no commit.

Backend:
- `src/lib/wms/dashboard-tarefas.ts` — adiciona 6 contadores (§1) + galpão fix (§2)
- `src/app/api/wms/dashboard-tarefas/route.ts` — passa novo payload (§1)

Frontend hooks:
- `src/hooks/use-dashboard-tarefas-realtime.ts` — adiciona 3 subscribes + R invalidate (§3, §6)
- `src/hooks/use-inventario-realtime.ts` — notifica handheld de cancelamento (§5, finding 4.9)

Frontend cards (novos, em `src/components/wms/home/exceptions/`):
- `card-devolucoes-pendentes.tsx`
- `card-transferencias-em-transito.tsx`
- `card-inventario-revisao.tsx`
- `card-reservas-orfas.tsx`
- `card-retroativos.tsx`
- `card-recebimento-orfao.tsx`

Frontend container:
- `src/components/wms/home/quadro-tarefas.tsx` — encaixa seção "Exceções" colapsável

Frontend páginas (UI fixes surgicais):
- `src/app/wms/devolucoes/[id]/page.tsx` — finding 5.12 (Classe C fornecedor), 5.13 (fetch dedicado)
- `src/app/wms/devolucoes/page.tsx` — distinguir manual/marketplace via flag
- `src/app/wms/pedidos/[id]/page.tsx` — finding 5.14 (label), 5.15 (banner D10)
- `src/components/wms/vendas/pedido-card-wms.tsx` — finding 5.16 (recusar)
- `src/app/wms/guarda/[id]/page.tsx` — finding 5.17 (useEffect → botão)
- `src/components/wms/inventario/feed-eventos.tsx` — finding 5.27 (para polling)
- `src/components/wms/ui/modals.tsx` — finding 5.20 (allowCreate=false em Receber)
- `src/app/wms/receber/page.tsx` — finding 5.19/5.21 (toast ignorados[])
- `src/app/wms/pedidos/page.tsx` — finding 5.25 (paginação tabs não-expedidos)
- `src/app/wms/compras/page.tsx` — finding 5.26 (paginação tab Histórico)
- `src/app/wms/vendas/nova/page.tsx` — finding 5.28 (criar em nome de X)

API novos endpoints (mínimos):
- `src/app/api/wms/devolucoes/[id]/route.ts` (GET) — finding 5.13 fetch dedicado

Migrations: nenhuma (P5 é client-side + service expansion; schema já está completo após P0..P4).

- [ ] Salvar essa lista em arquivo `docs/superpowers/plans/2026-05-26-wms-fix-p5-files.md` (mantém no PR, ajuda revisor)
- [ ] Commit: `git add docs/superpowers/plans/2026-05-26-wms-fix-p5-files.md && git commit -m "docs(p5): mapa de arquivos tocados"`

---

## §1. Dashboard service — 6 novos contadores

Cada subseção segue padrão TDD estrito:
1. Atualizar `DashboardTarefasResult` type
2. Escrever teste unitário pra função pura agregadora (se existir)
3. Adicionar query no `montarDashboardTarefas`
4. Escrever teste integração contra staging
5. Verificar via `npm run test` que passa
6. Commit

### Task 1.1 — Estender o type `DashboardTarefasResult` com as 6 novas chaves

Mantém o type exportável e consumido por frontend + service.

- [ ] Editar `src/lib/wms/dashboard-tarefas.ts` linhas 79-95. Substituir o type por:

```typescript
/** 1 devolução aguardando classificação na fila. */
export type DevolucaoPendenteCard = {
  id: string;
  nota_fiscal_id: number | null;
  empresa_referencia_nome: string | null;
  criada_em: string;
};

/** 1 transferência inter-galpão em trânsito. */
export type TransferenciaTransitoCard = {
  id: string;
  origem_galpao_nome: string | null;
  destino_galpao_nome: string | null;
  criada_em: string;
  qty_itens: number;
};

/** 1 sessão de inventário em estado `revisao` (aguardando supervisor). */
export type InventarioRevisaoCard = {
  id: string;
  nome: string;
  galpao_nome: string | null;
  total_divergencias: number;
  criado_em: string;
};

/** 1 reserva R órfã = mov tipo R + origem_tipo='reserva_pedido' onde
 *  o pedido associado está cancelado e a R nunca foi liberada (estorno_de NULL
 *  E não existe mov L com mesmo pedido_id). */
export type ReservaOrfaCard = {
  id: string;
  pedido_id: string | null;
  pedido_numero: string | null;
  produto_sku: string;
  qty: number;
  criada_em: string;
};

/** Pendência de lançamento retroativo aguardando reconciliação. */
export type RetroativoPendenteCard = {
  id: string;
  produto_sku: string;
  qty: number;
  criado_em: string;
  motivo: string;
};

/** Saldo em RECEBIMENTO sem pendência viva (após cancelamento de guarda). */
export type RecebimentoOrfaoCard = {
  produto_id: string;
  produto_sku: string;
  galpao_id: string;
  galpao_nome: string | null;
  localizacao_codigo: string;
  saldo: number;
};

export type ExcecoesPayload = {
  devolucoes: { count: number; itens: DevolucaoPendenteCard[] };
  transferencias_transito: { count: number; itens: TransferenciaTransitoCard[] };
  inventario_revisao: { count: number; itens: InventarioRevisaoCard[] };
  reservas_orfas: { count: number; itens: ReservaOrfaCard[] };
  retroativos: { count: number; itens: RetroativoPendenteCard[] };
  recebimento_orfao: { count: number; itens: RecebimentoOrfaoCard[] };
};

export type DashboardTarefasResult = {
  galpao_id: string | null;
  aprovacao: { count: number };
  separacao: { count: number; executores: Executor[] };
  embalagem: { count: number; executores: Executor[] };
  guarda: { count: number; executores: Executor[]; itens: GuardaItem[] };
  compras: {
    aComprar: number;
    aReceber: number;
    fornecedores: FornecedorCompras[];
  };
  inventario: {
    sessoesAtivas: number;
    executores: Executor[];
    ciclos: CicloInventario[];
  };
  /** Cards novos do P5 — visibilidade de exceções operacionais. */
  excecoes: ExcecoesPayload;
};
```

- [ ] Adicionar exports correspondentes acima
- [ ] `npm run typecheck` (será adicionado se não houver — usar `tsc --noEmit -p .`) — esperar erro em `montarDashboardTarefas` que não popula `excecoes` (esperado, conserta nas próximas tasks)
- [ ] Commit: `git commit -am "feat(p5): expande DashboardTarefasResult com chave excecoes"`

### Task 1.2 — Devoluções pendentes — teste primeiro

- [ ] Adicionar ao final de `src/lib/wms/dashboard-tarefas.test.ts`:

```typescript
import { agruparDevolucoesPendentes } from "./dashboard-tarefas";

describe("agruparDevolucoesPendentes", () => {
  const linhas = [
    {
      id: "d1",
      nota_fiscal_id: 100,
      criado_em: "2026-05-26T10:00:00Z",
      empresa_referencia: { nome: "NetAir" },
    },
    {
      id: "d2",
      nota_fiscal_id: null,
      criado_em: "2026-05-26T11:00:00Z",
      empresa_referencia: null,
    },
  ];

  it("mapeia linhas pra cards", () => {
    const r = agruparDevolucoesPendentes(linhas);
    expect(r.count).toBe(2);
    expect(r.itens).toHaveLength(2);
    expect(r.itens[0]).toEqual({
      id: "d1",
      nota_fiscal_id: 100,
      empresa_referencia_nome: "NetAir",
      criada_em: "2026-05-26T10:00:00Z",
    });
    expect(r.itens[1].empresa_referencia_nome).toBeNull();
  });

  it("retorna count=0 e itens=[] quando vazio", () => {
    expect(agruparDevolucoesPendentes([])).toEqual({ count: 0, itens: [] });
  });

  it("trata empresa_referencia como array (relação 1 sem !inner)", () => {
    const r = agruparDevolucoesPendentes([
      {
        id: "d3",
        nota_fiscal_id: null,
        criado_em: "2026-05-26T12:00:00Z",
        empresa_referencia: [{ nome: "NetParts" }],
      },
    ]);
    expect(r.itens[0].empresa_referencia_nome).toBe("NetParts");
  });
});
```

- [ ] `npm test -- dashboard-tarefas` — esperar 3 falhas (função não existe ainda)
- [ ] Implementar no `src/lib/wms/dashboard-tarefas.ts` antes de `montarDashboardTarefas`:

```typescript
type DevolucaoLinha = {
  id: string;
  nota_fiscal_id: number | null;
  criado_em: string;
  empresa_referencia: { nome: string } | Array<{ nome: string }> | null;
};

export function agruparDevolucoesPendentes(
  linhas: DevolucaoLinha[],
): { count: number; itens: DevolucaoPendenteCard[] } {
  const itens: DevolucaoPendenteCard[] = linhas.map((l) => {
    const empresa = Array.isArray(l.empresa_referencia)
      ? l.empresa_referencia[0] ?? null
      : l.empresa_referencia;
    return {
      id: l.id,
      nota_fiscal_id: l.nota_fiscal_id,
      empresa_referencia_nome: empresa?.nome ?? null,
      criada_em: l.criado_em,
    };
  });
  return { count: itens.length, itens };
}
```

- [ ] `npm test -- dashboard-tarefas` — 3 OK
- [ ] Commit: `git commit -am "test(p5): agruparDevolucoesPendentes + impl"`

### Task 1.3 — Devoluções pendentes — query no `montarDashboardTarefas`

- [ ] Localizar `Promise.all([…])` em `montarDashboardTarefas` (linha ~152)
- [ ] Adicionar query no array (sempre cross-galpão — devolução pendente não tem galpão definido até classificar):

```typescript
    // Devoluções pendentes (P5 §1) — global, sem filtro de galpão (a devolução
    // só ganha galpão quando classificada).
    sb
      .from("siso_devolucoes_pendentes")
      .select(
        "id, nota_fiscal_id, criado_em, empresa_referencia:siso_empresas!empresa_id(nome)",
      )
      .eq("status", "aguardando_classificacao")
      .order("criado_em", { ascending: true })
      .limit(MAX_DETALHE_POR_SECAO + 1),
```

- [ ] Adicionar nome da var `devolucoesQ` na desestruturação do `Promise.all`
- [ ] Antes do `return` final, adicionar:

```typescript
  const devolucoesRows = (devolucoesQ.data ?? []) as DevolucaoLinha[];
  const devolucoes = agruparDevolucoesPendentes(devolucoesRows);
```

- [ ] No objeto `excecoes` do return (adicionar campo agora — outros serão zerados temporariamente até suas tasks):

```typescript
    excecoes: {
      devolucoes,
      transferencias_transito: { count: 0, itens: [] },
      inventario_revisao: { count: 0, itens: [] },
      reservas_orfas: { count: 0, itens: [] },
      retroativos: { count: 0, itens: [] },
      recebimento_orfao: { count: 0, itens: [] },
    },
```

- [ ] Smoke manual via Supabase MCP: INSERT em `siso_devolucoes_pendentes` com status=aguardando_classificacao e ver retorno do endpoint
- [ ] Commit: `git commit -am "feat(p5): dashboard service inclui devolucoes pendentes"`

### Task 1.4 — Transferências em_transito — função pura + teste

- [ ] Adicionar teste:

```typescript
import { agruparTransferenciasTransito } from "./dashboard-tarefas";

describe("agruparTransferenciasTransito", () => {
  const linhas = [
    {
      id: "t1",
      criada_em: "2026-05-26T08:00:00Z",
      origem_galpao: { nome: "CWB" },
      destino_galpao: { nome: "SP" },
      itens: [{ qty: 5 }, { qty: 3 }],
    },
    {
      id: "t2",
      criada_em: "2026-05-26T09:00:00Z",
      origem_galpao: null,
      destino_galpao: null,
      itens: [],
    },
  ];

  it("conta itens (soma de qty)", () => {
    const r = agruparTransferenciasTransito(linhas);
    expect(r.itens[0].qty_itens).toBe(8);
    expect(r.itens[1].qty_itens).toBe(0);
  });

  it("trata join como array ou objeto", () => {
    const r = agruparTransferenciasTransito([
      {
        id: "t3",
        criada_em: "2026-05-26T10:00:00Z",
        origem_galpao: [{ nome: "CWB" }],
        destino_galpao: { nome: "SP" },
        itens: [{ qty: 1 }],
      },
    ]);
    expect(r.itens[0].origem_galpao_nome).toBe("CWB");
    expect(r.itens[0].destino_galpao_nome).toBe("SP");
  });
});
```

- [ ] Implementar:

```typescript
type TransferenciaLinha = {
  id: string;
  criada_em: string;
  origem_galpao: { nome: string } | Array<{ nome: string }> | null;
  destino_galpao: { nome: string } | Array<{ nome: string }> | null;
  itens: Array<{ qty: number }> | null;
};

export function agruparTransferenciasTransito(
  linhas: TransferenciaLinha[],
): { count: number; itens: TransferenciaTransitoCard[] } {
  const itens: TransferenciaTransitoCard[] = linhas.map((l) => {
    const origem = Array.isArray(l.origem_galpao)
      ? l.origem_galpao[0] ?? null
      : l.origem_galpao;
    const destino = Array.isArray(l.destino_galpao)
      ? l.destino_galpao[0] ?? null
      : l.destino_galpao;
    const qty_itens = (l.itens ?? []).reduce(
      (acc, i) => acc + Number(i.qty || 0),
      0,
    );
    return {
      id: l.id,
      origem_galpao_nome: origem?.nome ?? null,
      destino_galpao_nome: destino?.nome ?? null,
      criada_em: l.criada_em,
      qty_itens,
    };
  });
  return { count: itens.length, itens };
}
```

- [ ] `npm test -- dashboard-tarefas` — passa
- [ ] Commit: `git commit -am "test(p5): agruparTransferenciasTransito + impl"`

### Task 1.5 — Transferências em_transito — query no service

> Schema de `siso_transferencias_galpao`: tem `origem_galpao_id`, `destino_galpao_id`, `status` ∈ {em_transito, recebida, cancelada}. Itens em `siso_transferencias_galpao_itens` (verificar nome real via Supabase MCP `list_tables`).

- [ ] Verificar nome exato da tabela de itens via `mcp__supabase__list_tables` (filtrar por `siso_transferencias_galpao`)
- [ ] Adicionar query (filtra por `destino_galpao_id` quando galpão setado — operador no destino é quem precisa ver):

```typescript
    // Transferências em trânsito (P5 §1) — operador no destino é quem precisa
    // de visibilidade. Quando galpao_id presente, filtra por destino_galpao_id.
    (() => {
      let q = sb
        .from("siso_transferencias_galpao")
        .select(
          "id, criada_em, origem_galpao:siso_galpoes!origem_galpao_id(nome), destino_galpao:siso_galpoes!destino_galpao_id(nome), itens:siso_transferencias_galpao_itens(qty)",
        )
        .eq("status", "em_transito")
        .order("criada_em", { ascending: true })
        .limit(MAX_DETALHE_POR_SECAO + 1);
      if (galpao_id) q = q.eq("destino_galpao_id", galpao_id);
      return q;
    })(),
```

- [ ] Capturar `transferenciasQ` na desestruturação
- [ ] Popular antes do return:

```typescript
  const transferenciasRows = (transferenciasQ.data ?? []) as TransferenciaLinha[];
  const transferencias = agruparTransferenciasTransito(transferenciasRows);
```

- [ ] Trocar `transferencias_transito: { count: 0, itens: [] }` por `transferencias_transito: transferencias` no objeto `excecoes`
- [ ] Smoke: INSERT 1 transferência em_transito via MCP, ver no GET do endpoint
- [ ] Commit: `git commit -am "feat(p5): dashboard service inclui transferencias em_transito"`

### Task 1.6 — Inventário em revisão — função pura + teste

Status `revisao` significa: contagens encerradas, supervisor não aprovou ainda. Operador precisa lembrar.

- [ ] Teste:

```typescript
import { agruparInventarioRevisao } from "./dashboard-tarefas";

describe("agruparInventarioRevisao", () => {
  it("mapeia sessões + conta divergências", () => {
    const r = agruparInventarioRevisao(
      [
        {
          id: "s1",
          nome: "Cycle inteligente · 26/05",
          criado_em: "2026-05-26T07:00:00Z",
          galpao: { nome: "CWB" },
        },
      ],
      // map sessao_id → count de divergências pendentes
      new Map([["s1", 4]]),
    );
    expect(r.itens[0].total_divergencias).toBe(4);
    expect(r.itens[0].galpao_nome).toBe("CWB");
  });

  it("usa fallback de nome quando vazio", () => {
    const r = agruparInventarioRevisao(
      [{ id: "s2", nome: null, criado_em: "2026-05-26T07:00:00Z", galpao: null }],
      new Map(),
    );
    expect(r.itens[0].nome).toMatch(/Inventário/);
    expect(r.itens[0].total_divergencias).toBe(0);
  });
});
```

- [ ] Implementar:

```typescript
type RevisaoLinha = {
  id: string;
  nome: string | null;
  criado_em: string;
  galpao: { nome: string } | Array<{ nome: string }> | null;
};

export function agruparInventarioRevisao(
  linhas: RevisaoLinha[],
  divergenciasPorSessao: Map<string, number>,
): { count: number; itens: InventarioRevisaoCard[] } {
  const itens: InventarioRevisaoCard[] = linhas.map((l) => {
    const galpao = Array.isArray(l.galpao) ? l.galpao[0] ?? null : l.galpao;
    return {
      id: l.id,
      nome:
        l.nome?.trim() ||
        `Inventário · ${new Date(l.criado_em).toLocaleDateString("pt-BR")}`,
      galpao_nome: galpao?.nome ?? null,
      total_divergencias: divergenciasPorSessao.get(l.id) ?? 0,
      criado_em: l.criado_em,
    };
  });
  return { count: itens.length, itens };
}
```

- [ ] `npm test -- dashboard-tarefas` — passa
- [ ] Commit: `git commit -am "test(p5): agruparInventarioRevisao + impl"`

### Task 1.7 — Inventário em revisão — query no service

- [ ] Adicionar 2 queries: uma de sessões + uma de divergências pendentes:

```typescript
    // Inventário em revisão (P5 §1) — sessão encerrou contagem mas supervisor
    // ainda não aprovou.
    (() => {
      let q = sb
        .from("siso_inventario_sessoes")
        .select("id, nome, criado_em, galpao_id, galpao:siso_galpoes(nome)")
        .eq("status", "revisao")
        .order("criado_em", { ascending: true })
        .limit(MAX_DETALHE_POR_SECAO + 1);
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),

    // Divergências pendentes agrupadas por sessão (popula contador do card)
    sb
      .from("siso_inventario_divergencias")
      .select("sessao_id", { count: "exact", head: false })
      .eq("status", "pendente"),
```

- [ ] Capturar `invRevisaoQ` e `invDivergenciasQ` na desestruturação
- [ ] Popular antes do return:

```typescript
  const revisaoRows = (invRevisaoQ.data ?? []) as RevisaoLinha[];
  const divergenciasRows = (invDivergenciasQ.data ?? []) as Array<{ sessao_id: string }>;
  const divergenciasPorSessao = new Map<string, number>();
  for (const d of divergenciasRows) {
    divergenciasPorSessao.set(
      d.sessao_id,
      (divergenciasPorSessao.get(d.sessao_id) ?? 0) + 1,
    );
  }
  const inventarioRevisao = agruparInventarioRevisao(revisaoRows, divergenciasPorSessao);
```

- [ ] Trocar `inventario_revisao: { count: 0, itens: [] }` por `inventario_revisao: inventarioRevisao`
- [ ] Smoke: UPDATE 1 sessão para status='revisao' e ver no GET
- [ ] Commit: `git commit -am "feat(p5): dashboard service inclui inventario em revisao"`

### Task 1.8 — Reservas órfãs — função pura + teste

> Definição precisa de reserva órfã (alinha com PR-1):
> Mov tipo='R' + origem_tipo='reserva_pedido' onde:
> - `estorno_de IS NULL` (a R não foi estornada por nenhuma outra mov)
> - O pedido associado (extraído de `origem_id` ou `origem_detalhes.pedido_id`) está com `status='cancelado'` ou `status_separacao='cancelado'`
> - Não existe mov tipo='L' OU tipo='S' com o mesmo pedido_id que efetive a baixa
>
> Implementação: vamos resolver no SQL via duas queries — (1) lista Rs candidatas, (2) lista pedidos cancelados, intersecta no app.

- [ ] Teste:

```typescript
import { detectarReservasOrfas } from "./dashboard-tarefas";

describe("detectarReservasOrfas", () => {
  const reservas = [
    {
      id: "m1",
      pedido_id: "p1",
      quantidade: 5,
      criado_em: "2026-05-26T08:00:00Z",
      produto: { sku: "SKU-A" },
      pedido: { numero: "111", status: "cancelado" },
    },
    {
      id: "m2",
      pedido_id: "p2",
      quantidade: 3,
      criado_em: "2026-05-26T09:00:00Z",
      produto: { sku: "SKU-B" },
      pedido: { numero: "222", status: "pendente" },
    },
    {
      id: "m3",
      pedido_id: null, // R sem pedido — não conta
      quantidade: 1,
      criado_em: "2026-05-26T10:00:00Z",
      produto: { sku: "SKU-C" },
      pedido: null,
    },
  ];

  it("filtra apenas Rs de pedidos cancelados", () => {
    const r = detectarReservasOrfas(reservas, new Set(["m4_estornada"]));
    expect(r.count).toBe(1);
    expect(r.itens[0].pedido_numero).toBe("111");
  });

  it("excluir movs que já foram estornadas", () => {
    const r = detectarReservasOrfas(reservas, new Set(["m1"]));
    expect(r.count).toBe(0);
  });
});
```

- [ ] Implementar:

```typescript
type ReservaCandidata = {
  id: string;
  pedido_id: string | null;
  quantidade: number;
  criado_em: string;
  produto: { sku: string } | Array<{ sku: string }> | null;
  pedido: { numero: string | null; status: string | null } | Array<{ numero: string | null; status: string | null }> | null;
};

export function detectarReservasOrfas(
  reservas: ReservaCandidata[],
  movsJaEstornadas: Set<string>,
): { count: number; itens: ReservaOrfaCard[] } {
  const itens: ReservaOrfaCard[] = [];
  for (const r of reservas) {
    if (movsJaEstornadas.has(r.id)) continue;
    if (!r.pedido_id) continue;
    const pedido = Array.isArray(r.pedido) ? r.pedido[0] ?? null : r.pedido;
    if (!pedido) continue;
    if (pedido.status !== "cancelado") continue;
    const produto = Array.isArray(r.produto) ? r.produto[0] ?? null : r.produto;
    itens.push({
      id: r.id,
      pedido_id: r.pedido_id,
      pedido_numero: pedido.numero ?? null,
      produto_sku: produto?.sku ?? "—",
      qty: Number(r.quantidade),
      criada_em: r.criado_em,
    });
  }
  return { count: itens.length, itens };
}
```

- [ ] `npm test -- dashboard-tarefas` — passa
- [ ] Commit: `git commit -am "test(p5): detectarReservasOrfas + impl"`

### Task 1.9 — Reservas órfãs — queries no service

> Limite: pega últimas 500 Rs (margem ampla pra cobrir backlog de pedidos cancelados nas últimas 48h sem virar query infinita).

- [ ] Adicionar duas queries:

```typescript
    // Reservas R pendentes (últimas 500). Filtramos depois pra ver quais
    // são órfãs (pedido cancelado + sem estorno).
    sb
      .from("siso_movimentacoes")
      .select(
        "id, pedido_id, quantidade, criado_em, produto:siso_produtos(sku), pedido:siso_pedidos(numero, status)",
      )
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .order("criado_em", { ascending: false })
      .limit(500),

    // Movs que estornam reservas (qualquer mov com estorno_de IS NOT NULL)
    sb
      .from("siso_movimentacoes")
      .select("estorno_de")
      .not("estorno_de", "is", null)
      .order("criado_em", { ascending: false })
      .limit(2000),
```

- [ ] Capturar `reservasQ` e `estornosQ` na desestruturação
- [ ] Popular antes do return:

```typescript
  const reservasRows = (reservasQ.data ?? []) as ReservaCandidata[];
  const estornosRows = (estornosQ.data ?? []) as Array<{ estorno_de: string | null }>;
  const movsJaEstornadas = new Set<string>();
  for (const e of estornosRows) {
    if (e.estorno_de) movsJaEstornadas.add(e.estorno_de);
  }
  const reservasOrfas = detectarReservasOrfas(reservasRows, movsJaEstornadas);
```

- [ ] Trocar entrada zerada por `reservas_orfas: reservasOrfas`
- [ ] Smoke: criar pedido fake + R + cancelar pedido + GET, ver card popular
- [ ] Commit: `git commit -am "feat(p5): dashboard service detecta reservas orfas"`

### Task 1.10 — Retroativos pendentes — função pura + teste

Reaproveita `listarRetroativosPendentes` de `src/lib/wms/movimentacoes.ts` (já existe), mas adapta pra retornar contagem agregada.

- [ ] Teste:

```typescript
import { mapearRetroativosPendentes } from "./dashboard-tarefas";

describe("mapearRetroativosPendentes", () => {
  it("converte linhas do listar pra cards", () => {
    const r = mapearRetroativosPendentes([
      {
        id: "r1",
        criado_em: "2026-05-26T07:00:00Z",
        quantidade: 10,
        motivo: "Recebimento esquecido 2026-05-20",
        produto: { sku: "SKU-X", descricao: "Produto X" },
      },
    ]);
    expect(r.itens[0].produto_sku).toBe("SKU-X");
    expect(r.itens[0].qty).toBe(10);
    expect(r.itens[0].motivo).toBe("Recebimento esquecido 2026-05-20");
  });

  it("trata produto como array", () => {
    const r = mapearRetroativosPendentes([
      {
        id: "r2",
        criado_em: "2026-05-26T08:00:00Z",
        quantidade: 5,
        motivo: "x",
        produto: [{ sku: "SKU-Y", descricao: null }],
      },
    ]);
    expect(r.itens[0].produto_sku).toBe("SKU-Y");
  });
});
```

- [ ] Implementar:

```typescript
type RetroativoLinha = {
  id: string;
  criado_em: string;
  quantidade: number;
  motivo: string | null;
  produto: { sku: string; descricao: string | null } | Array<{ sku: string; descricao: string | null }> | null;
};

export function mapearRetroativosPendentes(
  linhas: RetroativoLinha[],
): { count: number; itens: RetroativoPendenteCard[] } {
  const itens: RetroativoPendenteCard[] = linhas.map((l) => {
    const produto = Array.isArray(l.produto) ? l.produto[0] ?? null : l.produto;
    return {
      id: l.id,
      produto_sku: produto?.sku ?? "—",
      qty: Number(l.quantidade),
      criado_em: l.criado_em,
      motivo: l.motivo ?? "",
    };
  });
  return { count: itens.length, itens };
}
```

- [ ] `npm test -- dashboard-tarefas` — passa
- [ ] Commit: `git commit -am "test(p5): mapearRetroativosPendentes + impl"`

### Task 1.11 — Retroativos pendentes — query no service

> Reusa filtro de `listarRetroativosPendentes`: mov com `origem_tipo='lancamento_retroativo'` sem estorno. Aqui inline a query (não chama a função existente porque queremos limitar a `MAX_DETALHE` + filtro de galpão).

- [ ] Adicionar query:

```typescript
    // Lançamentos retroativos pendentes de reconciliação (P5 §1).
    // Filtra por galpão via FK localizacao→galpao quando aplicável.
    (() => {
      let q = sb
        .from("siso_movimentacoes")
        .select(
          "id, criado_em, quantidade, motivo, galpao_id, produto:siso_produtos(sku, descricao)",
        )
        .eq("origem_tipo", "lancamento_retroativo")
        .is("estorno_de", null)
        .order("criado_em", { ascending: false })
        .limit(MAX_DETALHE_POR_SECAO + 1);
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),
```

- [ ] Capturar `retroativosQ`
- [ ] Antes do return:

```typescript
  // Filtra retroativos: descarta os que já foram estornados (verifica em estornosQ
  // já carregado pra reservas órfãs).
  const retroativosRows = (retroativosQ.data ?? []) as RetroativoLinha[];
  const retroativosNaoEstornados = retroativosRows.filter(
    (r) => !movsJaEstornadas.has(r.id),
  );
  const retroativos = mapearRetroativosPendentes(retroativosNaoEstornados);
```

- [ ] Trocar entrada zerada por `retroativos`
- [ ] Smoke: criar mov retroativa via MCP, ver card popular
- [ ] Commit: `git commit -am "feat(p5): dashboard service inclui retroativos pendentes"`

### Task 1.12 — Saldo RECEBIMENTO órfão — função pura + teste

> Definição (alinha com finding 5.4 cancelar pendência guarda):
> Posição em `siso_estoque` onde `localizacao.tipo='recebimento'` e `saldo > 0` mas:
> - Não existe pendência viva (`pendente`/`em_guarda`) cobrindo essa tripla
>
> Implementação minimal: GET endpoint coleta posições + pendências vivas e detecta delta. Esta task implementa só a função pura.

> **Dependência cross-plano:** P6 vai adicionar endpoint dedicado de detecção (`/api/wms/wms/recebimento-orfao/detectar`) com lógica mais sofisticada (considerar idade, tolerância). P5 entrega só visibilidade do estado atual.

- [ ] Teste:

```typescript
import { detectarRecebimentoOrfao } from "./dashboard-tarefas";

describe("detectarRecebimentoOrfao", () => {
  const saldos = [
    {
      produto_id: "p1",
      galpao_id: "g1",
      saldo: 10,
      produto: { sku: "SKU-A" },
      galpao: { nome: "CWB" },
      localizacao: { codigo: "RECEBIMENTO" },
    },
    {
      produto_id: "p2",
      galpao_id: "g1",
      saldo: 5,
      produto: { sku: "SKU-B" },
      galpao: { nome: "CWB" },
      localizacao: { codigo: "RECEBIMENTO" },
    },
    {
      produto_id: "p3",
      galpao_id: "g1",
      saldo: 0, // ignora saldo=0
      produto: { sku: "SKU-C" },
      galpao: { nome: "CWB" },
      localizacao: { codigo: "RECEBIMENTO" },
    },
  ];

  it("retorna apenas posições sem pendência cobrindo", () => {
    // p1 tem pendência viva (em pendenciasVivas), p2 não.
    const pendenciasVivas = new Set(["p1::g1"]);
    const r = detectarRecebimentoOrfao(saldos, pendenciasVivas);
    expect(r.count).toBe(1);
    expect(r.itens[0].produto_sku).toBe("SKU-B");
  });

  it("ignora saldo zero", () => {
    const r = detectarRecebimentoOrfao(saldos, new Set());
    expect(r.itens.find((i) => i.produto_sku === "SKU-C")).toBeUndefined();
  });
});
```

- [ ] Implementar:

```typescript
type EstoqueRecebimentoLinha = {
  produto_id: string;
  galpao_id: string;
  saldo: number;
  produto: { sku: string } | Array<{ sku: string }> | null;
  galpao: { nome: string } | Array<{ nome: string }> | null;
  localizacao: { codigo: string } | Array<{ codigo: string }> | null;
};

export function detectarRecebimentoOrfao(
  saldos: EstoqueRecebimentoLinha[],
  pendenciasVivas: Set<string>,
): { count: number; itens: RecebimentoOrfaoCard[] } {
  const itens: RecebimentoOrfaoCard[] = [];
  for (const s of saldos) {
    if (Number(s.saldo) <= 0) continue;
    const key = `${s.produto_id}::${s.galpao_id}`;
    if (pendenciasVivas.has(key)) continue;
    const produto = Array.isArray(s.produto) ? s.produto[0] ?? null : s.produto;
    const galpao = Array.isArray(s.galpao) ? s.galpao[0] ?? null : s.galpao;
    const loc = Array.isArray(s.localizacao) ? s.localizacao[0] ?? null : s.localizacao;
    itens.push({
      produto_id: s.produto_id,
      produto_sku: produto?.sku ?? "—",
      galpao_id: s.galpao_id,
      galpao_nome: galpao?.nome ?? null,
      localizacao_codigo: loc?.codigo ?? "—",
      saldo: Number(s.saldo),
    });
  }
  return { count: itens.length, itens };
}
```

- [ ] `npm test -- dashboard-tarefas` — passa
- [ ] Commit: `git commit -am "test(p5): detectarRecebimentoOrfao + impl"`

### Task 1.13 — Saldo RECEBIMENTO órfão — query no service

- [ ] Adicionar 2 queries:

```typescript
    // Saldos em localização tipo='recebimento' com saldo > 0 (potenciais órfãos)
    (() => {
      let q = sb
        .from("siso_estoque")
        .select(
          "produto_id, galpao_id, saldo, produto:siso_produtos(sku), galpao:siso_galpoes(nome), localizacao:siso_localizacoes!inner(codigo, tipo)",
        )
        .gt("saldo", 0)
        .eq("localizacao.tipo", "recebimento");
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),

    // Pendências vivas — usadas pra excluir posições que ainda têm guarda pendente
    (() => {
      let q = sb
        .from("siso_wms_pendencias_guarda")
        .select("produto_id, galpao_id")
        .in("status", ["pendente", "em_guarda"]);
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),
```

- [ ] Capturar `saldosRecebQ` e `pendenciasVivasQ`
- [ ] Antes do return:

```typescript
  const saldosRecebRows = (saldosRecebQ.data ?? []) as EstoqueRecebimentoLinha[];
  const pendenciasVivasRows = (pendenciasVivasQ.data ?? []) as Array<{
    produto_id: string;
    galpao_id: string;
  }>;
  const pendenciasVivasKeys = new Set<string>();
  for (const p of pendenciasVivasRows) {
    pendenciasVivasKeys.add(`${p.produto_id}::${p.galpao_id}`);
  }
  const recebimentoOrfao = detectarRecebimentoOrfao(saldosRecebRows, pendenciasVivasKeys);
```

- [ ] Trocar entrada zerada por `recebimento_orfao: recebimentoOrfao`
- [ ] Smoke: cancelar 1 pendência guarda existente e ver card popular
- [ ] Commit: `git commit -am "feat(p5): dashboard service detecta saldo recebimento orfao"`

### Task 1.14 — Endpoint `/api/wms/dashboard-tarefas` propaga o novo payload

Como o type já está expandido, o endpoint só precisa não capar nada. Verifica que nada está sendo descartado.

- [ ] Ler `src/app/api/wms/dashboard-tarefas/route.ts`
- [ ] Confirmar que `return NextResponse.json(payload)` repassa o objeto inteiro (sem `.pick()`)
- [ ] Adicionar header `Cache-Control: no-store` se não tem (pra evitar cache no CDN do Vercel)
- [ ] Smoke via curl/HTTPie no staging:

```bash
curl https://estoquelever.vercel.app/api/wms/dashboard-tarefas \
  -H "X-Session-Id: $SISO_SESSION" | jq '.excecoes | keys'
```

Esperado: `["devolucoes", "transferencias_transito", "inventario_revisao", "reservas_orfas", "retroativos", "recebimento_orfao"]`

- [ ] Commit: `git commit -am "feat(p5): endpoint dashboard-tarefas inclui novo payload excecoes"`

### Task 1.15 — Distinguir vendas manual/marketplace no contador "aprovação"

Finding 5.11 / 7.6: vendas manuais em modo `separacao` entram no quadro home misturadas com pedidos de marketplace. Confunde priorização.

> Decisão de design: contar separado, sem mexer no card "Aprovação" existente. Adiciona contador no payload e o card mostra split "X marketplace · Y manual".

- [ ] Modificar a query de aprovação (linha ~165) pra incluir `origem_pedido`:

```typescript
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id, origem_pedido", { count: "exact" })
        .eq("status", "pendente");
      if (galpao_id) {
        q = q.or(`separacao_galpao_id.eq.${galpao_id},separacao_galpao_id.is.null`);
        // OBS: fix do filtro NULL será feito formalmente em §2 task 2.1.
      }
      return q;
    })(),
```

- [ ] Adicionar no type:

```typescript
  aprovacao: {
    count: number;
    /** Split por origem do pedido — útil pra distinguir prioridade. */
    marketplace: number;
    manual: number;
  };
```

- [ ] Computar antes do return:

```typescript
  const aprovacaoRows = (aprovacaoQ.data ?? []) as Array<{ origem_pedido: string | null }>;
  const aprovacaoMarketplace = aprovacaoRows.filter((r) => r.origem_pedido !== "manual").length;
  const aprovacaoManual = aprovacaoRows.filter((r) => r.origem_pedido === "manual").length;
```

- [ ] No return:

```typescript
    aprovacao: {
      count: aprovacaoRows.length,
      marketplace: aprovacaoMarketplace,
      manual: aprovacaoManual,
    },
```

- [ ] Atualizar `card-tarefa.tsx` (renderiza Aprovação) pra mostrar split (próxima task em §4)
- [ ] Smoke: criar 1 pedido manual via `/wms/vendas/nova` modo separacao, ver split no endpoint
- [ ] Commit: `git commit -am "feat(p5): aprovacao split marketplace vs manual"`

### Task 1.16 — Atualizar testes de unidade `montarDashboardTarefas`

Se não tem teste de integração ainda, criar um esqueleto. Se já tem (em `test/integration/`), expandir.

- [ ] Procurar: `find test/integration -name "dashboard*"`
- [ ] Se não existir, criar `test/integration/wms-dashboard-tarefas.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "@/lib/supabase-server";
import { montarDashboardTarefas } from "@/lib/wms/dashboard-tarefas";

describe("montarDashboardTarefas - excecoes", () => {
  let sb: ReturnType<typeof createServiceClient>;

  beforeAll(() => {
    sb = createServiceClient();
  });

  it("retorna chave excecoes com 6 contadores", async () => {
    const r = await montarDashboardTarefas(sb, null);
    expect(r.excecoes).toBeDefined();
    expect(r.excecoes).toMatchObject({
      devolucoes: expect.objectContaining({ count: expect.any(Number) }),
      transferencias_transito: expect.objectContaining({ count: expect.any(Number) }),
      inventario_revisao: expect.objectContaining({ count: expect.any(Number) }),
      reservas_orfas: expect.objectContaining({ count: expect.any(Number) }),
      retroativos: expect.objectContaining({ count: expect.any(Number) }),
      recebimento_orfao: expect.objectContaining({ count: expect.any(Number) }),
    });
  });

  it("split aprovacao marketplace + manual = total", async () => {
    const r = await montarDashboardTarefas(sb, null);
    expect(r.aprovacao.marketplace + r.aprovacao.manual).toBe(r.aprovacao.count);
  });
});
```

- [ ] Rodar: `npm run test:integration -- wms-dashboard-tarefas`
- [ ] Esperado: passa (mesmo que contadores sejam 0 em sandbox)
- [ ] Commit: `git commit -am "test(p5): integration test montarDashboardTarefas excecoes"`

### Task 1.17 — Refactor opcional: extrair queries em sub-helpers

Se `montarDashboardTarefas` ficou >300 linhas, considerar extrair `montarExcecoes(sb, galpao_id)` em função separada pra legibilidade.

- [ ] `wc -l src/lib/wms/dashboard-tarefas.ts`
- [ ] Se >450 linhas: extrair em `montarExcecoes(sb, galpao_id): Promise<ExcecoesPayload>` e chamar no main
- [ ] Se <450: skip task (não justifica refactor)
- [ ] Se extraído, rodar `npm test -- dashboard-tarefas` pra confirmar nada quebrou
- [ ] Commit (se extraído): `git commit -am "refactor(p5): extrai montarExcecoes em sub-helper"`

### Task 1.18 — Marca §1 como concluída

- [ ] Confirmar que TODOS os testes passam: `npm run test && npm run test:integration -- dashboard-tarefas`
- [ ] Confirmar que typecheck passa: `npx tsc --noEmit -p .`
- [ ] Tag git: `git tag p5-section-1-complete`

---

## §2. Galpão filter fix (separacao_galpao_id NULL)

Finding 0.5/5.8: filtro `galpao_id` aplica `eq('separacao_galpao_id', galpao_id)` em pendentes — mas pedidos NÃO aprovados ainda têm `separacao_galpao_id IS NULL`. Resultado: filtro CWB esconde 69% dos pendentes em prod.

Correção: para status='pendente', usar `OR(separacao_galpao_id.eq.X, separacao_galpao_id.is.null)`. Para status='separacao'/'embalagem', manter eq (esses já têm o galpão setado).

### Task 2.1 — Teste E2E que reproduz o bug

> Esse teste deve **falhar** inicialmente, depois passar após o fix.

- [ ] Criar `test/integration/wms-dashboard-galpao-filter.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServiceClient } from "@/lib/supabase-server";
import { montarDashboardTarefas } from "@/lib/wms/dashboard-tarefas";

const PEDIDO_PREFIX = "P5-TEST-GALPAO-FILTER";

describe("montarDashboardTarefas - galpão filter", () => {
  let sb: ReturnType<typeof createServiceClient>;
  let galpaoId: string;
  let empresaId: string;
  let createdPedidos: string[] = [];

  beforeEach(async () => {
    sb = createServiceClient();
    // Pega galpão CWB e uma empresa qualquer
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    galpaoId = (g as { id: string }).id;
    const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
    empresaId = (e as { id: string }).id;
  });

  afterEach(async () => {
    if (createdPedidos.length > 0) {
      await sb.from("siso_pedidos").delete().in("id", createdPedidos);
      createdPedidos = [];
    }
  });

  it("filtro de galpão inclui pendentes com separacao_galpao_id NULL", async () => {
    // Seed: 3 pendentes com separacao_galpao_id NULL + 2 com galpao_id setado
    const seed = [
      { numero: `${PEDIDO_PREFIX}-1`, status: "pendente", separacao_galpao_id: null, empresa_origem_id: empresaId },
      { numero: `${PEDIDO_PREFIX}-2`, status: "pendente", separacao_galpao_id: null, empresa_origem_id: empresaId },
      { numero: `${PEDIDO_PREFIX}-3`, status: "pendente", separacao_galpao_id: null, empresa_origem_id: empresaId },
      { numero: `${PEDIDO_PREFIX}-4`, status: "pendente", separacao_galpao_id: galpaoId, empresa_origem_id: empresaId },
      { numero: `${PEDIDO_PREFIX}-5`, status: "pendente", separacao_galpao_id: galpaoId, empresa_origem_id: empresaId },
    ];
    const { data, error } = await sb.from("siso_pedidos").insert(seed).select("id");
    if (error) throw error;
    createdPedidos = (data as Array<{ id: string }>).map((r) => r.id);

    // Filtrando por CWB, deve retornar TODOS os 5 (3 NULL + 2 setados)
    const r = await montarDashboardTarefas(sb, galpaoId);
    // baseline + 5 (assumindo nenhum outro NULL com mesma assinatura)
    expect(r.aprovacao.count).toBeGreaterThanOrEqual(5);

    // Sanity: rodar sem filtro deve dar ≥ ao com filtro
    const rSemFiltro = await montarDashboardTarefas(sb, null);
    expect(rSemFiltro.aprovacao.count).toBeGreaterThanOrEqual(r.aprovacao.count);
  });
});
```

- [ ] Rodar `npm run test:integration -- wms-dashboard-galpao-filter` — esperar FALHA (atualmente filtra só por eq)
- [ ] Commit: `git commit -am "test(p5): E2E test reproduce galpao filter bug"`

### Task 2.2 — Implementar o fix em `aprovacaoQ`

- [ ] Substituir o IIFE da query `aprovacaoQ` em `src/lib/wms/dashboard-tarefas.ts` (linha ~165):

```typescript
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id, origem_pedido")
        .eq("status", "pendente");
      if (galpao_id) {
        // Pedidos `pendente` podem ter separacao_galpao_id NULL (ainda não
        // aprovados). Incluir esses no filtro do galpão atual — operador
        // precisa ver pra decidir.
        q = q.or(
          `separacao_galpao_id.eq.${galpao_id},separacao_galpao_id.is.null`,
        );
      }
      return q;
    })(),
```

- [ ] Rodar `npm run test:integration -- wms-dashboard-galpao-filter` — esperar PASS
- [ ] Commit: `git commit -am "fix(p5): aprovacao inclui pendentes com galpao NULL (finding 0.5)"`

### Task 2.3 — Conferir se separação/embalagem precisam mesmo fix

> Análise: pedidos em `em_separacao`/`separado` JÁ têm `separacao_galpao_id` setado (acontece em `pedidos/aprovar`). Esses casos não precisam do fix.
>
> Exceção: `pendente_realocacao` pode estar com galpão preenchido (mesma sessão do em_separacao). Idem `validacao_oc`. Cobertos.

- [ ] Confirmar via Supabase MCP:

```sql
SELECT status_separacao, COUNT(*) AS total,
       COUNT(*) FILTER (WHERE separacao_galpao_id IS NULL) AS sem_galpao
FROM siso_pedidos
WHERE status_separacao IN ('aguardando_separacao', 'em_separacao', 'pendente_realocacao', 'validacao_oc', 'separado')
GROUP BY 1;
```

- [ ] Se `sem_galpao > 0` em qualquer linha não-pendente: aplicar mesmo fix nas queries `separacaoQ` e `embalagemQ`
- [ ] Se `sem_galpao = 0` em todas: documentar isso em comentário no dashboard-tarefas
- [ ] Commit: `git commit -am "docs(p5): documenta invariante separacao_galpao_id em fluxo aprovado"`

### Task 2.4 — Atualizar testes existentes que assumiam comportamento antigo

- [ ] `grep -rn "separacao_galpao_id" test/` — auditar
- [ ] Para cada teste que afirma "filtro galpão retorna N pedidos", reverificar se assume comportamento errado
- [ ] Atualizar conforme necessário
- [ ] Rodar `npm run test && npm run test:integration` — passa
- [ ] Commit: `git commit -am "test(p5): ajusta testes legados do filtro galpão"`

### Task 2.5 — Marca §2 como concluída

- [ ] Tag git: `git tag p5-section-2-complete`

---

## §3. Realtime hook — 3 novas subscribes + re-validate de 5 existentes

### Task 3.1 — Adicionar subscribe a `siso_devolucoes_pendentes`

- [ ] Editar `src/hooks/use-dashboard-tarefas-realtime.ts`
- [ ] Após `ch5` (linha ~93), adicionar:

```typescript
    const ch6 = supabase
      .channel(`dt-devolucoes-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_devolucoes_pendentes",
        },
        invalidate,
      )
      .subscribe();
```

- [ ] Adicionar `ch6` no array `channelsRef.current = [ch1, ch2, ch3, ch4, ch5, ch6]`
- [ ] Commit: `git commit -am "feat(p5): hook subscribes siso_devolucoes_pendentes"`

### Task 3.2 — Adicionar subscribe a `siso_transferencias_galpao`

- [ ] Após `ch6`, adicionar:

```typescript
    const ch7 = supabase
      .channel(`dt-transferencias-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_transferencias_galpao",
        },
        invalidate,
      )
      .subscribe();
```

- [ ] Atualizar array `channelsRef.current` pra incluir `ch7`
- [ ] Commit: `git commit -am "feat(p5): hook subscribes siso_transferencias_galpao"`

### Task 3.3 — Adicionar subscribe a `siso_movimentacoes` (filtrado por R)

> Eventos em ledger são frequentes. Filtra pelo tipo='R' pra reduzir ruído.

- [ ] Adicionar:

```typescript
    // Realtime de Rs (reservas) — afeta contador "reservas órfãs" + invalida
    // contadores de pedidos quando R criada/liberada.
    const ch8 = supabase
      .channel(`dt-movs-r-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "siso_movimentacoes",
          filter: "tipo=eq.R",
        },
        invalidate,
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "siso_movimentacoes",
          filter: "tipo=eq.R",
        },
        invalidate,
      )
      .subscribe();
```

- [ ] Atualizar array `channelsRef.current`
- [ ] Commit: `git commit -am "feat(p5): hook subscribes siso_movimentacoes tipo=R"`

### Task 3.4 — Smoke E2E: trigger eventos em cada uma das 5 tabelas P1 + 3 novas

> Antes de marcar pronto, confirmar empiricamente que invalidate dispara.

- [ ] Iniciar dev server: `npm run dev`
- [ ] Logar em /wms (browser)
- [ ] Abrir DevTools → Console
- [ ] Adicionar log temporário em `invalidate`:

```typescript
    const invalidate = () => {
      console.log("[dt-realtime] invalidate");
      queryClient.invalidateQueries({
        queryKey: ["wms-tarefas-pendentes", galpaoId],
      });
    };
```

- [ ] Tabela-por-tabela, executar via MCP execute_sql um INSERT/UPDATE/DELETE:

| Tabela | Comando SQL |
|---|---|
| `siso_pedidos` | `UPDATE siso_pedidos SET separacao_tags = '{}' WHERE id = (SELECT id FROM siso_pedidos LIMIT 1)` |
| `siso_wms_pendencias_guarda` | `UPDATE siso_wms_pendencias_guarda SET atualizada_em = NOW() WHERE id = (SELECT id FROM siso_wms_pendencias_guarda LIMIT 1)` |
| `siso_inventario_sessoes` | `UPDATE siso_inventario_sessoes SET nome = nome WHERE id = (SELECT id FROM siso_inventario_sessoes LIMIT 1)` |
| `siso_inventario_operadores` | `INSERT/DELETE numa sessão existente` |
| `siso_pedido_itens` | `UPDATE siso_pedido_itens SET marcado_em = NULL WHERE id = (SELECT id FROM siso_pedido_itens LIMIT 1)` |
| `siso_devolucoes_pendentes` | `INSERT 1 row aguardando_classificacao + DELETE` |
| `siso_transferencias_galpao` | `INSERT em_transito + DELETE` |
| `siso_movimentacoes` (R) | `INSERT R fake com origem_tipo='reserva_pedido' + DELETE — usar role admin ou bypass policy` |

- [ ] Para cada uma, verificar log `[dt-realtime] invalidate` no console
- [ ] Se alguma NÃO disparou: investigar (publication, RLS, policies)
- [ ] Remover log temporário antes do commit
- [ ] Commit: `git commit -am "verify(p5): realtime invalidate dispara em 8 tabelas"`

### Task 3.5 — Documentar a lista canônica de subscribes no comentário do hook

- [ ] No topo do `use-dashboard-tarefas-realtime.ts`, expandir docstring:

```typescript
/**
 * Subscreve às tabelas que afetam o quadro de tarefas da home /wms e
 * invalida o React Query a cada evento, forçando refetch.
 *
 * Tabelas assinadas (todas precisam estar em `supabase_realtime` publication —
 * verificar com SELECT * FROM pg_publication_tables):
 *
 *   1. siso_pedidos                  (status pendente/em_separacao)
 *   2. siso_wms_pendencias_guarda    (pendência criada/iniciada/confirmada/cancelada)
 *   3. siso_inventario_sessoes       (sessão revisao/aprovada/cancelada)
 *   4. siso_inventario_operadores    (party in/out)
 *   5. siso_pedido_itens             (compra_status, parcial, qty_pega)
 *   6. siso_devolucoes_pendentes     (P5) — nova devolução chegando
 *   7. siso_transferencias_galpao    (P5) — transferência em_transito
 *   8. siso_movimentacoes (tipo=R)   (P5) — reservas criadas/liberadas
 *
 * Quando `galpaoId` é null, subscreve sem filtros server-side (modo
 * "todos os galpões"). Quando muda, fecha os channels antigos e
 * reabre com novos filtros.
 */
```

- [ ] Commit: `git commit -am "docs(p5): documenta lista canonica de subscribes do hook"`

### Task 3.6 — Sessão cancelada notifica handheld (finding 4.9)

> Hook diferente — `use-inventario-realtime.ts`. Quando supervisor cancela sessão, operadores em handheld devem ser notificados (não ficar bipando em sessão morta).

- [ ] Ler `src/hooks/use-inventario-realtime.ts`
- [ ] Procurar onde subscribe `siso_inventario_sessoes`
- [ ] Adicionar handler que detecta UPDATE de status pra 'cancelada' e dispara toast + redirect:

```typescript
// Detecta cancelamento da sessão e avisa o operador em handheld
function handleSessaoUpdate(payload: { new: { id: string; status: string } | null }) {
  if (!payload.new) return;
  if (payload.new.status === "cancelada") {
    toast.error("Sessão de inventário foi cancelada pelo supervisor.");
    router.push("/wms/inventario");
  }
  qc.invalidateQueries({ queryKey: ["wms-inventario", payload.new.id] });
}
```

- [ ] Wire essa função no `.on('postgres_changes', ...)` do channel de sessões
- [ ] Smoke: abrir handheld em sessão X → supervisor cancela via SQL → operador vê toast + redirect
- [ ] Commit: `git commit -am "fix(p5): handheld notifica cancelamento sessao inventario (finding 4.9)"`

### Task 3.7 — Performance: dedup de invalidates rapid-fire

Se 10 INSERTs em `siso_movimentacoes` chegarem em 100ms, invalidate dispara 10x. Adiciona debounce de 250ms.

- [ ] No topo do hook, importar `useRef` + `useCallback`
- [ ] Substituir `const invalidate = () => {...}` por:

```typescript
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const invalidate = () => {
      if (pendingTimer) return; // já agendado
      pendingTimer = setTimeout(() => {
        queryClient.invalidateQueries({
          queryKey: ["wms-tarefas-pendentes", galpaoId],
        });
        pendingTimer = null;
      }, 250);
    };
```

- [ ] No cleanup do useEffect, limpar timer:

```typescript
    return () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      for (const ch of channelsRef.current) {
        supabase.removeChannel(ch);
      }
      channelsRef.current = [];
    };
```

- [ ] Commit: `git commit -am "perf(p5): debounce invalidates 250ms"`

### Task 3.8 — Marca §3 como concluída

- [ ] Tag git: `git tag p5-section-3-complete`

---

## §4. Home page UI — 5 novos cards + seção colapsável

Decisão visual: cards de exceções vão pra seção colapsável "Exceções" abaixo do kanban. Default expandido se qualquer contador > 0.

### Task 4.1 — Criar diretório `src/components/wms/home/exceptions/`

- [ ] `mkdir -p src/components/wms/home/exceptions`
- [ ] Não commitar ainda — só preparar estrutura

### Task 4.2 — Card `CardDevolucoesPendentes`

> Mostra contador grande + lista resumida (top 3 itens) + link "ver todas".

- [ ] Criar `src/components/wms/home/exceptions/card-devolucoes-pendentes.tsx`:

```typescript
"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { DevolucaoPendenteCard } from "@/lib/wms/dashboard-tarefas";

function formatarTempo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

interface Props {
  count: number;
  itens: DevolucaoPendenteCard[];
}

export function CardDevolucoesPendentes({ count, itens }: Props) {
  return (
    <Link href="/wms/devolucoes" className="wms-excecao-card">
      <div className="wms-excecao-card-head">
        <Icon name="package" size={14} />
        <span className="wms-excecao-card-titulo">Devoluções pendentes</span>
        <span
          className={
            count > 0
              ? "wms-excecao-card-count wms-excecao-card-count-warn"
              : "wms-excecao-card-count"
          }
        >
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="wms-excecao-card-vazio">
          Nada na fila — bom trabalho.
        </div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((d) => (
            <div key={d.id} className="wms-excecao-card-linha">
              <span className="wms-mono">
                NF {d.nota_fiscal_id ?? "—"}
              </span>
              <span className="wms-td-mute">
                {d.empresa_referencia_nome ?? "—"}
              </span>
              <span className="wms-td-mute">
                {formatarTempo(d.criada_em)}
              </span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">
              +{count - 3} pendência{count - 3 === 1 ? "" : "s"}
            </div>
          ) : null}
        </div>
      )}
    </Link>
  );
}
```

- [ ] Commit: `git commit -am "feat(p5): CardDevolucoesPendentes"`

### Task 4.3 — Card `CardTransferenciasEmTransito`

> Mostra idade desde criada (sinaliza vermelho se >48h sem chegar).

- [ ] Criar `src/components/wms/home/exceptions/card-transferencias-em-transito.tsx`:

```typescript
"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { TransferenciaTransitoCard } from "@/lib/wms/dashboard-tarefas";

function idadeHoras(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
}

function badgeTempo(iso: string): { label: string; tone: "ok" | "warn" | "alert" } {
  const h = idadeHoras(iso);
  if (h < 24) return { label: `${h}h`, tone: "ok" };
  const d = Math.floor(h / 24);
  if (h < 72) return { label: `${d}d`, tone: "warn" };
  return { label: `${d}d`, tone: "alert" };
}

interface Props {
  count: number;
  itens: TransferenciaTransitoCard[];
}

export function CardTransferenciasEmTransito({ count, itens }: Props) {
  return (
    <Link href="/wms/transferir" className="wms-excecao-card">
      <div className="wms-excecao-card-head">
        <Icon name="truck" size={14} />
        <span className="wms-excecao-card-titulo">
          Transferências em trânsito
        </span>
        <span
          className={
            count > 0
              ? "wms-excecao-card-count wms-excecao-card-count-info"
              : "wms-excecao-card-count"
          }
        >
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="wms-excecao-card-vazio">
          Nada em trânsito.
        </div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((t) => {
            const b = badgeTempo(t.criada_em);
            return (
              <div key={t.id} className="wms-excecao-card-linha">
                <span>
                  {t.origem_galpao_nome ?? "—"} → {t.destino_galpao_nome ?? "—"}
                </span>
                <span className="wms-td-mute">{t.qty_itens} itens</span>
                <span className={`wms-excecao-badge wms-excecao-badge-${b.tone}`}>
                  {b.label}
                </span>
              </div>
            );
          })}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">+{count - 3} transferências</div>
          ) : null}
        </div>
      )}
    </Link>
  );
}
```

- [ ] Commit: `git commit -am "feat(p5): CardTransferenciasEmTransito"`

### Task 4.4 — Card `CardInventarioRevisao`

> Mostra sessões aguardando aprovação supervisor + contador de divergências.

- [ ] Criar `src/components/wms/home/exceptions/card-inventario-revisao.tsx`:

```typescript
"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { InventarioRevisaoCard } from "@/lib/wms/dashboard-tarefas";

interface Props {
  count: number;
  itens: InventarioRevisaoCard[];
}

export function CardInventarioRevisao({ count, itens }: Props) {
  return (
    <Link href="/wms/inventario" className="wms-excecao-card">
      <div className="wms-excecao-card-head">
        <Icon name="clipboard-check" size={14} />
        <span className="wms-excecao-card-titulo">
          Inventário em revisão
        </span>
        <span
          className={
            count > 0
              ? "wms-excecao-card-count wms-excecao-card-count-warn"
              : "wms-excecao-card-count"
          }
        >
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="wms-excecao-card-vazio">Nenhum em revisão.</div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((s) => (
            <div key={s.id} className="wms-excecao-card-linha">
              <span>{s.nome}</span>
              {s.galpao_nome ? (
                <span className="wms-td-mute">{s.galpao_nome}</span>
              ) : null}
              <span
                className={
                  s.total_divergencias > 0
                    ? "wms-excecao-badge wms-excecao-badge-warn"
                    : "wms-excecao-badge wms-excecao-badge-ok"
                }
              >
                {s.total_divergencias} div.
              </span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">+{count - 3} sessões</div>
          ) : null}
        </div>
      )}
    </Link>
  );
}
```

- [ ] Commit: `git commit -am "feat(p5): CardInventarioRevisao"`

### Task 4.5 — Card `CardReservasOrfas`

> Alerta vermelho se contador > N (default N=5 — operador deveria notar logo).

- [ ] Criar `src/components/wms/home/exceptions/card-reservas-orfas.tsx`:

```typescript
"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { ReservaOrfaCard } from "@/lib/wms/dashboard-tarefas";

const LIMITE_ALERTA = 5;

interface Props {
  count: number;
  itens: ReservaOrfaCard[];
}

export function CardReservasOrfas({ count, itens }: Props) {
  const isAlerta = count > LIMITE_ALERTA;
  return (
    <Link href="/wms/ledger?tipo=R&orfas=true" className="wms-excecao-card">
      <div className="wms-excecao-card-head">
        <Icon name="alert" size={14} />
        <span className="wms-excecao-card-titulo">
          Reservas órfãs (pedidos cancelados)
        </span>
        <span
          className={
            isAlerta
              ? "wms-excecao-card-count wms-excecao-card-count-alert"
              : count > 0
                ? "wms-excecao-card-count wms-excecao-card-count-warn"
                : "wms-excecao-card-count"
          }
        >
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="wms-excecao-card-vazio">Sem Rs órfãs.</div>
      ) : (
        <div className="wms-excecao-card-lista">
          {isAlerta ? (
            <div className="wms-excecao-card-alerta">
              Acima de {LIMITE_ALERTA} — investigar webhook cancelamento.
            </div>
          ) : null}
          {itens.slice(0, 3).map((r) => (
            <div key={r.id} className="wms-excecao-card-linha">
              <span className="wms-mono">{r.produto_sku}</span>
              <span className="wms-td-mute">
                pedido {r.pedido_numero ?? r.pedido_id?.slice(0, 6)}
              </span>
              <span className="wms-mono">{r.qty}</span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">+{count - 3} Rs</div>
          ) : null}
        </div>
      )}
    </Link>
  );
}
```

- [ ] Commit: `git commit -am "feat(p5): CardReservasOrfas"`

### Task 4.6 — Card `CardRetroativos`

- [ ] Criar `src/components/wms/home/exceptions/card-retroativos.tsx`:

```typescript
"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { RetroativoPendenteCard } from "@/lib/wms/dashboard-tarefas";

interface Props {
  count: number;
  itens: RetroativoPendenteCard[];
}

export function CardRetroativos({ count, itens }: Props) {
  return (
    <Link href="/wms/retroativos" className="wms-excecao-card">
      <div className="wms-excecao-card-head">
        <Icon name="rewind" size={14} />
        <span className="wms-excecao-card-titulo">
          Retroativos pendentes
        </span>
        <span
          className={
            count > 0
              ? "wms-excecao-card-count wms-excecao-card-count-info"
              : "wms-excecao-card-count"
          }
        >
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="wms-excecao-card-vazio">Nenhum lançamento aberto.</div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((r) => (
            <div key={r.id} className="wms-excecao-card-linha">
              <span className="wms-mono">{r.produto_sku}</span>
              <span className="wms-mono">{r.qty}</span>
              <span className="wms-td-mute" title={r.motivo}>
                {r.motivo.length > 30
                  ? r.motivo.slice(0, 30) + "…"
                  : r.motivo}
              </span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">
              +{count - 3} lançamentos
            </div>
          ) : null}
        </div>
      )}
    </Link>
  );
}
```

- [ ] Commit: `git commit -am "feat(p5): CardRetroativos"`

### Task 4.7 — Card `CardRecebimentoOrfao`

> Vinculado a finding 5.4 — saldo em RECEBIMENTO sem pendência ativa.

- [ ] Criar `src/components/wms/home/exceptions/card-recebimento-orfao.tsx`:

```typescript
"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { RecebimentoOrfaoCard } from "@/lib/wms/dashboard-tarefas";

interface Props {
  count: number;
  itens: RecebimentoOrfaoCard[];
}

export function CardRecebimentoOrfao({ count, itens }: Props) {
  return (
    <Link href="/wms/estoque?perspectiva=localizacao&tipo=recebimento" className="wms-excecao-card">
      <div className="wms-excecao-card-head">
        <Icon name="box" size={14} />
        <span className="wms-excecao-card-titulo">
          Saldo órfão em RECEBIMENTO
        </span>
        <span
          className={
            count > 0
              ? "wms-excecao-card-count wms-excecao-card-count-warn"
              : "wms-excecao-card-count"
          }
        >
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="wms-excecao-card-vazio">Dock limpo.</div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((r) => (
            <div
              key={`${r.produto_id}::${r.galpao_id}`}
              className="wms-excecao-card-linha"
            >
              <span className="wms-mono">{r.produto_sku}</span>
              <span className="wms-td-mute">
                {r.galpao_nome ?? "—"} · {r.localizacao_codigo}
              </span>
              <span className="wms-mono">{r.saldo}</span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">+{count - 3} posições</div>
          ) : null}
        </div>
      )}
    </Link>
  );
}
```

- [ ] Commit: `git commit -am "feat(p5): CardRecebimentoOrfao"`

### Task 4.8 — Componente colapsável `SecaoExcecoes`

> Wrapper que controla expand/collapse, default expandido se qualquer count > 0.

- [ ] Criar `src/components/wms/home/exceptions/secao-excecoes.tsx`:

```typescript
"use client";

import { useState } from "react";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { ExcecoesPayload } from "@/lib/wms/dashboard-tarefas";
import { CardDevolucoesPendentes } from "./card-devolucoes-pendentes";
import { CardTransferenciasEmTransito } from "./card-transferencias-em-transito";
import { CardInventarioRevisao } from "./card-inventario-revisao";
import { CardReservasOrfas } from "./card-reservas-orfas";
import { CardRetroativos } from "./card-retroativos";
import { CardRecebimentoOrfao } from "./card-recebimento-orfao";

interface Props {
  excecoes: ExcecoesPayload;
}

export function SecaoExcecoes({ excecoes }: Props) {
  const totalExcecoes =
    excecoes.devolucoes.count +
    excecoes.transferencias_transito.count +
    excecoes.inventario_revisao.count +
    excecoes.reservas_orfas.count +
    excecoes.retroativos.count +
    excecoes.recebimento_orfao.count;

  // Default expandido se há qualquer exceção. Estado local — operador pode
  // colapsar manualmente, perde no F5 (intencional — primeira impressão importa).
  const [open, setOpen] = useState(totalExcecoes > 0);

  return (
    <section className="wms-excecoes-secao">
      <button
        type="button"
        className="wms-excecoes-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="wms-excecoes-grid"
      >
        <Icon name={open ? "chevron-d" : "chevron-r"} size={12} />
        <span className="wms-excecoes-toggle-label">Exceções</span>
        <span
          className={
            totalExcecoes > 0
              ? "wms-excecoes-toggle-count wms-excecoes-toggle-count-warn"
              : "wms-excecoes-toggle-count"
          }
        >
          {totalExcecoes}
        </span>
      </button>
      {open ? (
        <div id="wms-excecoes-grid" className="wms-excecoes-grid">
          <CardDevolucoesPendentes
            count={excecoes.devolucoes.count}
            itens={excecoes.devolucoes.itens}
          />
          <CardTransferenciasEmTransito
            count={excecoes.transferencias_transito.count}
            itens={excecoes.transferencias_transito.itens}
          />
          <CardInventarioRevisao
            count={excecoes.inventario_revisao.count}
            itens={excecoes.inventario_revisao.itens}
          />
          <CardReservasOrfas
            count={excecoes.reservas_orfas.count}
            itens={excecoes.reservas_orfas.itens}
          />
          <CardRetroativos
            count={excecoes.retroativos.count}
            itens={excecoes.retroativos.itens}
          />
          <CardRecebimentoOrfao
            count={excecoes.recebimento_orfao.count}
            itens={excecoes.recebimento_orfao.itens}
          />
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] Commit: `git commit -am "feat(p5): SecaoExcecoes wrapper colapsável"`

### Task 4.9 — Estilos CSS `wms-excecao-*` em `src/app/wms/wms.css`

> Não tem component library — todos os estilos são custom no wms.css.

- [ ] Adicionar ao final de `src/app/wms/wms.css`:

```css
/* ── Seção Exceções (P5) ─────────────────────────────────────────────── */
.wms-excecoes-secao {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--wms-c-border);
}

.wms-excecoes-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid var(--wms-c-border-2);
  border-radius: var(--wms-r-2);
  color: var(--wms-c-fg);
  cursor: pointer;
  transition: background 0.12s;
}
.wms-excecoes-toggle:hover {
  background: var(--wms-c-faint);
}

.wms-excecoes-toggle-label {
  font-weight: 600;
  font-size: 13px;
}
.wms-excecoes-toggle-count {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  background: var(--wms-c-panel);
  border-radius: 999px;
  min-width: 24px;
  text-align: center;
}
.wms-excecoes-toggle-count-warn {
  background: var(--wms-c-warn-soft);
  color: var(--wms-c-warn);
}

.wms-excecoes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.wms-excecao-card {
  display: block;
  padding: 12px;
  background: var(--wms-c-panel);
  border: 1px solid var(--wms-c-border);
  border-radius: var(--wms-r-2);
  text-decoration: none;
  color: inherit;
  transition: border-color 0.12s, transform 0.12s;
}
.wms-excecao-card:hover {
  border-color: var(--wms-c-fg);
  transform: translateY(-1px);
}

.wms-excecao-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.wms-excecao-card-titulo {
  font-size: 12px;
  font-weight: 600;
  flex: 1;
}
.wms-excecao-card-count {
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 700;
  background: var(--wms-c-faint);
  border-radius: 999px;
  min-width: 28px;
  text-align: center;
}
.wms-excecao-card-count-warn {
  background: var(--wms-c-warn-soft);
  color: var(--wms-c-warn);
}
.wms-excecao-card-count-alert {
  background: var(--wms-c-danger-soft);
  color: var(--wms-c-danger);
}
.wms-excecao-card-count-info {
  background: var(--wms-c-info-soft);
  color: var(--wms-c-info);
}

.wms-excecao-card-vazio {
  font-size: 12px;
  color: var(--wms-c-mute);
  padding: 8px 0;
}

.wms-excecao-card-lista {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wms-excecao-card-linha {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.wms-excecao-card-linha > :nth-child(2) {
  flex: 1;
}
.wms-excecao-card-mais {
  font-size: 11px;
  color: var(--wms-c-mute);
  padding-top: 4px;
  border-top: 1px dashed var(--wms-c-border);
}
.wms-excecao-card-alerta {
  font-size: 11px;
  color: var(--wms-c-danger);
  padding: 6px;
  background: var(--wms-c-danger-soft);
  border-radius: var(--wms-r-1);
  margin-bottom: 4px;
}

.wms-excecao-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
}
.wms-excecao-badge-ok {
  background: var(--wms-c-faint);
  color: var(--wms-c-mute);
}
.wms-excecao-badge-warn {
  background: var(--wms-c-warn-soft);
  color: var(--wms-c-warn);
}
.wms-excecao-badge-alert {
  background: var(--wms-c-danger-soft);
  color: var(--wms-c-danger);
}
.wms-excecao-badge-info {
  background: var(--wms-c-info-soft);
  color: var(--wms-c-info);
}
```

> Variáveis `--wms-c-warn-soft`, `--wms-c-danger-soft`, `--wms-c-info-soft` podem não existir no theme atual. Confirmar via grep.

- [ ] `grep -n "wms-c-warn-soft\|wms-c-danger-soft\|wms-c-info-soft" src/app/wms/wms.css`
- [ ] Se não existem, adicionar na seção `:root` do wms.css:

```css
  --wms-c-warn: #b45309;
  --wms-c-warn-soft: rgba(180, 83, 9, 0.12);
  --wms-c-danger: #b91c1c;
  --wms-c-danger-soft: rgba(185, 28, 28, 0.12);
  --wms-c-info: #1d4ed8;
  --wms-c-info-soft: rgba(29, 78, 216, 0.12);
```

E também na seção `:root[data-theme='dark']` (ou `@media prefers-color-scheme: dark`) com variações apropriadas pro dark mode.

- [ ] Commit: `git commit -am "style(p5): css das exceções na home"`

### Task 4.10 — Wire da `SecaoExcecoes` no `QuadroTarefas`

- [ ] Editar `src/components/wms/home/quadro-tarefas.tsx`
- [ ] Adicionar import:

```typescript
import { SecaoExcecoes } from "./exceptions/secao-excecoes";
```

- [ ] Antes do fechamento `</section>` (linha ~213), adicionar:

```typescript
      {data?.excecoes ? <SecaoExcecoes excecoes={data.excecoes} /> : null}
```

- [ ] Smoke manual: `npm run dev` → abrir /wms → verificar seção Exceções renderiza com contadores corretos
- [ ] Commit: `git commit -am "feat(p5): wire SecaoExcecoes no QuadroTarefas"`

### Task 4.11 — Atualizar `CardTarefa` para mostrar split de aprovação

- [ ] Ler `src/components/wms/home/card-tarefa.tsx`
- [ ] Adicionar prop opcional `legendaExtra?: string` na interface
- [ ] No render, se `legendaExtra` presente, mostrar abaixo da legenda principal em fonte menor
- [ ] No `quadro-tarefas.tsx`, popular legenda extra:

```typescript
        <CardTarefa
          variante="simples"
          titulo="Aprovação"
          contador={data?.aprovacao.count ?? 0}
          legenda="aguardando"
          legendaExtra={
            data?.aprovacao
              ? `${data.aprovacao.marketplace} marketplace · ${data.aprovacao.manual} manual`
              : undefined
          }
          href="/wms/pedidos"
        />
```

- [ ] Smoke manual: verificar split aparece
- [ ] Commit: `git commit -am "feat(p5): card Aprovação mostra split marketplace/manual"`

### Task 4.12 — Snapshot/visual test dos 6 cards

> Sem Playwright configurado pra snapshot — usar vitest+jsdom render rápido.

- [ ] Verificar se `@testing-library/react` está instalado: `cat package.json | grep testing-library`
- [ ] Se não, instalar: `npm install -D @testing-library/react @testing-library/jest-dom jsdom`
- [ ] Criar `src/components/wms/home/exceptions/__tests__/cards.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CardDevolucoesPendentes } from "../card-devolucoes-pendentes";
import { CardTransferenciasEmTransito } from "../card-transferencias-em-transito";
import { CardInventarioRevisao } from "../card-inventario-revisao";
import { CardReservasOrfas } from "../card-reservas-orfas";
import { CardRetroativos } from "../card-retroativos";
import { CardRecebimentoOrfao } from "../card-recebimento-orfao";

describe("Cards de exceções — vazios", () => {
  it("CardDevolucoesPendentes count=0 mostra placeholder", () => {
    const { getByText } = render(
      <CardDevolucoesPendentes count={0} itens={[]} />,
    );
    expect(getByText(/Nada na fila/i)).toBeTruthy();
  });
  it("CardReservasOrfas count=6 mostra alerta", () => {
    const itens = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      pedido_id: `p${i}`,
      pedido_numero: `${i}`,
      produto_sku: `SKU-${i}`,
      qty: 1,
      criada_em: new Date().toISOString(),
    }));
    const { getByText } = render(
      <CardReservasOrfas count={6} itens={itens} />,
    );
    expect(getByText(/Acima de 5/i)).toBeTruthy();
  });
  it("CardTransferenciasEmTransito count=2 mostra 2 linhas + idade", () => {
    const itens = [
      {
        id: "t1",
        origem_galpao_nome: "CWB",
        destino_galpao_nome: "SP",
        criada_em: new Date(Date.now() - 5 * 3_600_000).toISOString(),
        qty_itens: 8,
      },
      {
        id: "t2",
        origem_galpao_nome: "SP",
        destino_galpao_nome: "CWB",
        criada_em: new Date(Date.now() - 25 * 3_600_000).toISOString(),
        qty_itens: 3,
      },
    ];
    const { getByText } = render(
      <CardTransferenciasEmTransito count={2} itens={itens} />,
    );
    expect(getByText(/CWB → SP/)).toBeTruthy();
    expect(getByText(/1d/)).toBeTruthy(); // 25h → 1d
  });
});
```

- [ ] Adicionar `environment: 'jsdom'` em `vitest.config.ts` se ainda não tem
- [ ] Rodar `npm test -- exceptions` — passa
- [ ] Commit: `git commit -am "test(p5): render tests pros 6 cards de exceções"`

### Task 4.13 — Acessibilidade básica nos cards

- [ ] Verificar que cada `<Link>` no Card* tem `aria-label` descritivo (não só ícone+contador)
- [ ] Adicionar `role="region" aria-labelledby` na `SecaoExcecoes`
- [ ] Smoke manual: navegação por teclado via Tab — todos os cards focáveis
- [ ] Commit: `git commit -am "a11y(p5): aria-label nos cards de exceções"`

### Task 4.14 — Responsivo: grid colapsa em mobile

- [ ] No CSS, `wms-excecoes-grid` já usa `auto-fill, minmax(280px, 1fr)` — fica 1 coluna em <640px
- [ ] Confirmar em DevTools que em 375px (iPhone SE) os cards empilham sem overflow horizontal
- [ ] Se necessário, ajustar `min-width: 240px` para 1 coluna em telas muito estreitas
- [ ] Commit: `git commit -am "style(p5): grid responsivo das exceções"`

### Task 4.15 — Loading skeleton enquanto query carrega

> Hoje cards mostram count=0 antes da query resolver — fica "tudo limpo" enganoso por 200ms.

- [ ] No `quadro-tarefas.tsx`, condicional: se `query.isLoading && !data`, renderizar skeleton da seção exceções (6 cards cinzas)
- [ ] Adicionar componente `<SecaoExcecoesSkeleton />` em `secao-excecoes.tsx`:

```typescript
export function SecaoExcecoesSkeleton() {
  return (
    <section className="wms-excecoes-secao">
      <div className="wms-excecoes-toggle wms-excecoes-toggle-skeleton">
        <span className="wms-skeleton-line wms-skeleton-line-80" />
      </div>
      <div className="wms-excecoes-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="wms-excecao-card wms-excecao-card-skeleton">
            <span className="wms-skeleton-line wms-skeleton-line-60" />
            <span className="wms-skeleton-line wms-skeleton-line-40" />
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] CSS pro skeleton (reutiliza se já existir `wms-skeleton-line` no projeto, senão adiciona)
- [ ] Wire em quadro-tarefas:

```typescript
      {query.isLoading && !data ? (
        <SecaoExcecoesSkeleton />
      ) : data?.excecoes ? (
        <SecaoExcecoes excecoes={data.excecoes} />
      ) : null}
```

- [ ] Commit: `git commit -am "feat(p5): skeleton loading da seção exceções"`

### Task 4.16 — Validar layout em browser real

- [ ] `npm run dev` + abrir `/wms` no Chrome
- [ ] Verificar visualmente:
  - Cards do pipeline (Aprovação/Separação/Embalagem) renderizam bem em cima
  - Kanban (Guarda/Inventário/Compras) abaixo
  - Seção Exceções colapsável ao final, com 6 cards
  - Toggle expande/colapsa
  - Default expandido se algum > 0
  - Hover em cards muda border-color
- [ ] Screenshot do estado expandido + colapsado, anexar no PR depois
- [ ] Commit (vazio): `git commit --allow-empty -m "verify(p5): layout home validado em browser"`

### Task 4.17 — Performance: medir contagem de re-renders no quadro

> Adicionar 6 cards triplica DOM. Confirma que sem dados isso ainda renderiza em <16ms.

- [ ] Em DevTools React Profiler, gravar interação: load página → expand exceções → toggle galpão
- [ ] Confirmar que cada render do `QuadroTarefas` é <16ms
- [ ] Se ficar pesado: memoizar cada card com `React.memo`
- [ ] Commit (se memoizado): `git commit -am "perf(p5): memo cards de exceções"`

### Task 4.18 — Marca §4 como concluída

- [ ] Tag git: `git tag p5-section-4-complete`

---

## §5. UI bug fixes individuais (12 fixes cirúrgicos)

Cada fix tem: 1 task = 1 commit. Quando bug é cross-arquivo, sub-tarefas.

### Task 5.1 — Devolução Classe C: select de fornecedor_id (finding 5.12 / 6.4)

> Atualmente, escolher Classe C envia POST sem `fornecedor_id`. Backend retorna `400: classificacao='garantia' exige fornecedor_id`. UI quebra silenciosamente.

- [ ] Editar `src/app/wms/devolucoes/[id]/page.tsx`
- [ ] Adicionar import no topo:

```typescript
import { useQuery } from "@tanstack/react-query"; // já tá
// adicionar nada novo — useQuery já importado
```

- [ ] Adicionar query de fornecedores (depois de `useQuery({ queryKey: ["wms-devolucoes"]...})`, linha ~92):

```typescript
  const { data: fornecedoresResp } = useQuery({
    queryKey: ["wms-fornecedores"],
    queryFn: () => wmsApi<{ rows: Array<{ id: string; nome: string }> }>(
      "/api/wms/fornecedores",
    ),
    enabled: classificacao === "garantia",
  });
  const fornecedores = fornecedoresResp?.rows ?? [];
```

- [ ] Adicionar state pra fornecedor (próximo dos outros states ~linha 84):

```typescript
  const [fornecedorId, setFornecedorId] = useState<string>("");
```

- [ ] No `submit.mutationFn` (linha ~115), incluir `fornecedor_id`:

```typescript
        body: JSON.stringify({
          classificacao,
          produto_id,
          qty,
          galpao_id: q.galpao_id,
          localizacao_id: q.localizacao_id,
          fornecedor_id:
            classificacao === "garantia" ? fornecedorId : undefined,
          observacoes,
        }),
```

- [ ] Ajustar valid: agora exige fornecedorId quando garantia:

```typescript
  const valid =
    !!produto_id &&
    qty > 0 &&
    !!q.localizacao_id &&
    (classificacao !== "garantia" || !!fornecedorId);
```

- [ ] Renderizar select condicional dentro do JSX. Antes do `<Field label="Observações">` (linha ~266), adicionar:

```typescript
      {classificacao === "garantia" ? (
        <Field label="Fornecedor (RMA)" required>
          <select
            className="wms-select"
            value={fornecedorId}
            onChange={(e) => setFornecedorId(e.target.value)}
          >
            <option value="">— escolha o fornecedor —</option>
            {fornecedores.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nome}
              </option>
            ))}
          </select>
          <div className="wms-td-mute" style={{ fontSize: 11, marginTop: 4 }}>
            Classe C — devolução pro fornecedor exige identificar o RMA.
          </div>
        </Field>
      ) : null}
```

- [ ] Smoke manual:
  1. Abrir `/wms/devolucoes/X` (1 pendência existente)
  2. Escolher Classe C — Garantia
  3. Verificar select de fornecedor aparece
  4. Botão "Aplicar" disabled até escolher fornecedor
  5. Selecionar + aplicar → sucesso (sem 400)
- [ ] Commit: `git commit -am "fix(p5): devolução Classe C select fornecedor (finding 5.12)"`

### Task 5.2 — Devolução: detalhe fetch dedicado (finding 5.13 / 6.6)

> Atualmente lê do array `devs?.rows?.find(x => x.id === id)`. Se a devolução foi classificada (saiu do `aguardando_classificacao`), o array filtrado em `/api/wms/devolucoes` (que só retorna pendentes) não tem ela — 404 silencioso.

- [ ] Verificar se endpoint `/api/wms/devolucoes/[id]` (GET) existe: `ls src/app/api/wms/devolucoes/`
- [ ] Se não existir, criar `src/app/api/wms/devolucoes/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { createServiceClient } from "@/lib/supabase-server";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    const sb = createServiceClient();
    const { data, error } = await sb
      .from("siso_devolucoes_pendentes")
      .select(
        `
          id, status, nota_fiscal_id, chave_acesso_nf, criado_em,
          payload_webhook,
          empresa_referencia:siso_empresas!empresa_id(id, nome)
        `,
      )
      .eq("id", id)
      .single();
    if (error) {
      if (error.code === "PGRST116") {
        return NextResponse.json({ error: "não encontrada" }, { status: 404 });
      }
      throw error;
    }
    return NextResponse.json({ devolucao: data });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.devolucoes.detalhe",
      error: e,
      requestPath: `/api/wms/devolucoes/${id}`,
      requestMethod: "GET",
    });
  }
}
```

- [ ] No `src/app/wms/devolucoes/[id]/page.tsx`, substituir o useQuery + `find` por:

```typescript
  const { data: devResp } = useQuery({
    queryKey: ["wms-devolucao", id],
    queryFn: () =>
      wmsApi<{ devolucao: DevRow }>(`/api/wms/devolucoes/${id}`),
  });
  const dev = devResp?.devolucao;
```

- [ ] Smoke manual: abrir uma devolução já classificada (status != aguardando) — deve mostrar os dados ao invés de NF "—"
- [ ] Commit: `git commit -am "fix(p5): devolução detalhe fetch dedicado (finding 5.13)"`

### Task 5.3 — Pedidos: label "Forçar pendente" alinhado com comportamento (finding 1.2 / 5.14)

> Label atual diz "devolve o pedido pro estado pendente". Backend (verificar) bypassa NF e força status pra `aguardando_separacao`. Label inverte o sentido.

- [ ] Ler `src/app/api/wms/separacao/forcar-pendente/route.ts` linhas 58-66 pra confirmar o que o endpoint faz
- [ ] Verificar se o nome certo é "Forçar adiante (bypass NF)" ou "Forçar pra separação"
- [ ] Editar `src/app/wms/pedidos/[id]/page.tsx` linhas 1067-1083:

```typescript
        <AcaoAdminRow
          icone="arrow-right"
          titulo="Forçar pra separação (bypass NF)"
          descricao="Pula a espera da NF do Tiny e transita o pedido pra aguardando_separacao. Use quando a NF chegou mas o webhook não disparou (raro)."
          disponivel={podeForcarPendente}
          motivoIndisponivel="Pedido já está em separação ou status incompatível."
          actionLabel={
            forcarPendentePending ? "Forçando…" : "Forçar pra separação"
          }
          onClick={() =>
            confirmar(
              "Forçar este pedido pra aguardando_separacao, pulando a espera da NF?",
              forcarPendente,
            )
          }
          pending={forcarPendentePending}
          tone="primary"
        />
```

- [ ] Tone trocado pra `primary` (não é mais danger — adianta o fluxo, não regride)
- [ ] Smoke: ver botão na tela de admin → label coerente
- [ ] Commit: `git commit -am "fix(p5): label forçar pendente coerente com comportamento (finding 1.2)"`

### Task 5.4 — Banner D10 "Estornar agora" wire endpoint (finding 1.9 / 5.15)

> **DEPENDÊNCIA P3:** P3 cria endpoint `/api/wms/pedidos/[id]/estornar-cancelado` (cancelar pedido c/ OC já recebida, estornando saldo). Se P3 ainda não mergeado, esta task fica gated.

- [ ] Verificar se P3 mergeou esse endpoint: `git log origin/develop --oneline | grep -i "p3.*estornar\|estornar.*cancelado"`
- [ ] **Se P3 NÃO mergeou:** wire condicional — botão renderiza apenas se endpoint existir (HEAD check) OU esconde banner inteiro com TODO comentado:

```typescript
// TODO(P5+P3): wire quando P3 entregar /api/wms/pedidos/[id]/estornar-cancelado
// Por ora, esconder o botão pra não dar false promise.
{isAdmin && false && (
  <button ... />
)}
```

- [ ] **Se P3 mergeou:** implementar handler `onEstornar` (que hoje é prop sem implementação). Em `src/app/wms/pedidos/[id]/page.tsx`:

```typescript
  const estornarMut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch(
        `/api/wms/pedidos/${id}/estornar-cancelado`,
        { method: "POST" },
      );
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success("Saldo estornado, posição fechada");
      queryClient.invalidateQueries({ queryKey: ["wms-pedido", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Wire na prop onEstornar do BannerD10:
  <BannerD10 isAdmin={isAdmin} onEstornar={() => estornarMut.mutate()} />
```

- [ ] Smoke (se wired): seed pedido cancelado com mov L → ver banner → clicar estornar → ledger ganha mov estorno
- [ ] Commit: `git commit -am "fix(p5): wire banner D10 estornar agora (depende de P3)"`

### Task 5.5 — Recusar pedido: fluxo definido ou esconder (finding 1.8 / 5.16)

> Botão "Recusar" em `pedido-card-wms.tsx:484` chama `handleReject` que é prop opcional. Hoje a maioria das tabs não passa essa prop → botão visível mas no-op.

> **Decisão de produto:** confirmar com user antes — manter recusar como feature OU remover botão.

- [ ] Perguntar user (ou ler spec): "Recusar pedido deve marcá-lo cancelado + razão? OU é feature pra remover?"
- [ ] **Cenário A (manter):** implementar endpoint `/api/wms/pedidos/[id]/recusar` (POST {motivo}) que marca status='cancelado' + insere `siso_pedido_historico`. Wire no card.
- [ ] **Cenário B (remover):** deletar bloco `{interactive.onReject && (...)}` em `src/components/wms/vendas/pedido-card-wms.tsx:483-492` E remover prop `onReject` da interface

> **Default decisão:** Cenário B (remover). Recusar pedido sem fluxo definido é trapdoor pra inconsistência. Adiar pra spec dedicada se fizer sentido depois.

- [ ] Editar `src/components/wms/vendas/pedido-card-wms.tsx`:
  - Remover linhas 483-492 (bloco `{interactive.onReject && (...)}`)
  - Remover `onReject?: () => void` da interface `InteractiveProps`
  - Remover `handleReject` (function local)
- [ ] Buscar callers: `grep -rn "onReject" src/`
- [ ] Remover prop dos callers (provavelmente nenhum)
- [ ] Smoke: cards de pedido pendente não mostram mais botão Recusar
- [ ] Commit: `git commit -am "fix(p5): remove botão Recusar sem fluxo (finding 1.8)"`

### Task 5.6 — Guarda: substituir useEffect iniciar por botão explícito (finding 5.7 / 5.17)

> Hoje `useEffect` dispara `/iniciar` toda vez que a página renderiza com `status=pendente`. Refresh acidental cria evento duplicado no log.

- [ ] Editar `src/app/wms/guarda/[id]/page.tsx`
- [ ] Remover o `useEffect` das linhas 102-113
- [ ] Adicionar mutation `iniciarMut`:

```typescript
  const iniciarMut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch(`/api/wms/guarda/${id}/iniciar`, {
        method: "POST",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-guarda", id] });
      toast.success("Guarda iniciada — você é o operador responsável");
    },
    onError: (e: Error) => toast.error(e.message),
  });
```

- [ ] No JSX, no header da página, adicionar botão condicional quando `pend?.status === 'pendente'`:

```typescript
        {pend?.status === "pendente" ? (
          <button
            className="wms-btn wms-btn-primary"
            onClick={() => iniciarMut.mutate()}
            disabled={iniciarMut.isPending || !podeGuardar}
          >
            <Icon name="play" size={12} />
            {iniciarMut.isPending ? "Iniciando…" : "Começar guarda"}
          </button>
        ) : null}
```

- [ ] Smoke: abrir pendência `pendente` → ver botão → clicar → status muda → recarregar → não dispara novamente
- [ ] Commit: `git commit -am "fix(p5): guarda iniciar com botão explícito (finding 5.7)"`

### Task 5.7 — FeedEventos: para polling se sessão terminal (finding 4.17 / 5.27)

> Hoje polling roda 5s mesmo se sessão `aplicada`/`cancelada`. Drena bateria + tráfego desnecessário.

- [ ] Editar `src/components/wms/inventario/feed-eventos.tsx`
- [ ] Adicionar prop opcional `sessaoStatus`:

```typescript
interface Props {
  sessaoId: string;
  sessaoStatus?: "planejada" | "em_andamento" | "revisao" | "aprovada" | "aplicada" | "cancelada";
}
```

- [ ] No useEffect (linha 62), condicionar polling:

```typescript
  useEffect(() => {
    let cancelled = false;
    async function carregar() {
      try {
        const r = await wmsApi<{ eventos: Evento[] }>(
          `/api/wms/inventario/${sessaoId}/eventos?limit=50`,
        );
        if (!cancelled) setEventos(r.eventos);
      } catch {
        // silencioso
      }
    }
    carregar();
    // Para polling quando sessão atinge estado terminal — feed não muda mais.
    const terminal =
      sessaoStatus === "aplicada" || sessaoStatus === "cancelada";
    if (terminal) {
      return () => {
        cancelled = true;
      };
    }
    const t = setInterval(carregar, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sessaoId, sessaoStatus]);
```

- [ ] Buscar callers: `grep -rn "FeedEventos" src/`
- [ ] Atualizar caller(s) pra passar `sessaoStatus={sessao.status}`
- [ ] Smoke: abrir sessão aplicada → DevTools Network → confirmar não há request a `/eventos` recorrente
- [ ] Commit: `git commit -am "perf(p5): FeedEventos para polling em sessão terminal (finding 4.17)"`

### Task 5.8 — Distinguir manual/marketplace no card "Aprovação" (finding 5.11 / 7.6)

Já feito em §1 task 1.15. Aqui só validamos no UI.

- [ ] Smoke manual: criar 1 pedido manual via /wms/vendas/nova → ver no /wms split "0 marketplace · 1 manual"
- [ ] Se split não aparece: revisitar §4 task 4.11
- [ ] Commit (vazio): `git commit --allow-empty -m "verify(p5): split manual/marketplace no card aprovação"`

### Task 5.9 — LocalizacaoCombo `allowCreate=false` no modal Receber (finding 5.20 / 8.12)

> Loc órfã criada inline durante recebimento. Operador pode digitar "RECEB-001" e criar loc que ninguém valida.

- [ ] Editar `src/components/wms/ui/modals.tsx`
- [ ] Linha 670-676 (modal Receber):

```typescript
        <Field label="Localização" required>
          <LocalizacaoCombo
            galpaoId={galpaoId}
            value={locId}
            onChange={(v) => setLocIdUser(v)}
            allowCreate={false}
          />
        </Field>
```

- [ ] Verificar se o modal Replenishment (linha 1541) deveria ter mesma proteção
- [ ] No caso do Replenishment, manter `allowCreate=true` (operador às vezes cria loc nova destino legitimamente). Documentar em comentário inline.
- [ ] Smoke: abrir modal Receber → tentar digitar código novo → não aparece opção "criar"
- [ ] Commit: `git commit -am "fix(p5): LocalizacaoCombo Receber allowCreate=false (finding 5.20)"`

### Task 5.10 — Toast `imprimir-lote` expõe ignorados[] (finding 5.13 / 5.19 / 5.21)

> Quando algumas pendências não têm `localizacao_destino_id`, backend ignora silenciosamente. Operador acha que imprimiu tudo.

- [ ] Verificar resposta do endpoint via Supabase MCP ou Vercel logs: `/api/wms/guarda/imprimir-lote` retorna `{ ok, totalEtiquetas, totalFolhas, ignorados[] }`?
- [ ] Se não retorna `ignorados[]`, adicionar no endpoint:

```typescript
// Em src/app/api/wms/guarda/imprimir-lote/route.ts
return NextResponse.json({
  ok: true,
  totalEtiquetas,
  totalFolhas,
  fallbackEnvelope,
  ignorados: ignoradosArr, // [{ pendencia_id, motivo: "sem_loc_destino" }, ...]
});
```

- [ ] Em `src/app/wms/receber/page.tsx` linha ~382-390, atualizar toast:

```typescript
            const out = (await r.json()) as {
              ok: boolean;
              totalEtiquetas?: number;
              totalFolhas?: number;
              fallbackEnvelope?: boolean;
              ignorados?: Array<{ pendencia_id: string; motivo: string }>;
            };
            const ignoradosCount = out.ignorados?.length ?? 0;
            if (ignoradosCount > 0) {
              toast.warning(
                `${out.totalEtiquetas} impressas, ${ignoradosCount} pendência${ignoradosCount === 1 ? "" : "s"} ignorada${ignoradosCount === 1 ? "" : "s"} (sem loc destino). Configurar em /wms/guarda.`,
                { duration: 8000 },
              );
            } else {
              toast.success(
                `${out.totalEtiquetas} etiquetas em ${out.totalFolhas} folhas${out.fallbackEnvelope ? " (impressora de envio — configure uma de produto)" : ""}`,
              );
            }
```

- [ ] Smoke: criar 1 pendência sem loc destino + 1 com → toast deve mostrar 1 ignorada
- [ ] Commit: `git commit -am "fix(p5): toast imprimir-lote mostra ignorados (finding 5.13)"`

### Task 5.11 — Paginação `/wms/pedidos` tabs não-expedidos (finding 1.15 / 5.25)

> Hoje só `expedidos` tem paginação. Tabs `pendente`/`concluidos`/`auto` carregam tudo num GET (`/api/wms/pedidos`). Em volume alto fica lento.

- [ ] Verificar se endpoint `/api/wms/pedidos` suporta query `?page=X&limit=Y`. Se não, adicionar:

```typescript
// src/app/api/wms/pedidos/route.ts
const url = new URL(req.url);
const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
const limit = Math.min(200, Math.max(10, Number(url.searchParams.get("limit") ?? "50") || 50));
const offset = (page - 1) * limit;
// ...query.range(offset, offset + limit - 1)
// Retornar { pedidos, total, page, totalPages }
```

> **Atenção:** mudança de contrato de retorno (array → objeto) quebra callers. Compatibilizar:

```typescript
// Manter retrocompatibilidade: se ?paginated=true, retorna { pedidos, ... }; senão retorna array
const paginated = url.searchParams.get("paginated") === "true";
if (!paginated) {
  return NextResponse.json(pedidos); // legado — mantém array
}
return NextResponse.json({ pedidos, total, page, totalPages });
```

- [ ] No `src/app/wms/pedidos/page.tsx`, adicionar state `pageNaoExpedidos`:

```typescript
const pageNaoExpedidos = Math.max(1, Number(searchParams?.get("p") ?? "1") || 1);
```

- [ ] Modificar query (linha ~138):

```typescript
  const pedidosQuery = useQuery({
    queryKey: ["wms-pedidos", tab, pageNaoExpedidos, activeGalpaoId, buscaParam],
    queryFn: async () => {
      const qs = new URLSearchParams({
        paginated: "true",
        page: String(pageNaoExpedidos),
        limit: "50",
      });
      const r = await sisoFetch(`/api/wms/pedidos?${qs.toString()}`);
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      return (await r.json()) as { pedidos: Pedido[]; total: number; page: number; totalPages: number };
    },
    refetchInterval: 30_000,
    enabled: tab !== "expedidos",
  });

  const allPedidos = pedidosQuery.data?.pedidos ?? [];
  const totalPagesNaoExpedidos = pedidosQuery.data?.totalPages ?? 1;
```

- [ ] No JSX, adicionar componente `<Pagination>` no final de cada lista quando `tab !== "expedidos"`:

```typescript
      {tab !== "expedidos" && totalPagesNaoExpedidos > 1 ? (
        <Pagination
          page={pageNaoExpedidos}
          pageSize={50}
          total={pedidosQuery.data?.total ?? 0}
          onPageChange={(p) => {
            const params = new URLSearchParams(searchParams?.toString() ?? "");
            params.set("p", String(p));
            router.push(`?${params.toString()}`);
          }}
        />
      ) : null}
```

- [ ] Smoke: criar 60 pedidos seed → ver paginação aparece nas tabs
- [ ] Commit: `git commit -am "feat(p5): paginação tabs não-expedidos pedidos (finding 1.15)"`

### Task 5.12 — Paginação `/wms/compras` tab Histórico (finding 3.13 / 5.26)

- [ ] Identificar endpoint que alimenta tab Histórico em `/wms/compras/page.tsx`
- [ ] Verificar se `/api/wms/compras/ordens` ou `/api/wms/compras` suporta paginação
- [ ] Se não, adicionar mesma estrutura cursor/limit
- [ ] Wire `<Pagination>` no UI
- [ ] Smoke: tab Histórico com >50 ordens mostra paginador
- [ ] Commit: `git commit -am "feat(p5): paginação compras tab Histórico (finding 3.13)"`

### Task 5.13 — Vendas/nova: indicador de degradação (finding 5.23)

> Quando vendedor pediu `baixa_direta` mas item sem saldo virou `aguardando_separacao`, response inclui `degradado:true, motivo_degradacao`. UI hoje só mostra toast genérico — não fica claro o que aconteceu.

- [ ] Editar `src/app/wms/vendas/nova/page.tsx`
- [ ] Após response do submit (`onSuccess`), inspecionar:

```typescript
    onSuccess: (resp) => {
      if (resp.degradado && resp.motivo_degradacao === "falta_saldo") {
        toast.warning(
          `Venda criada como ${resp.modo_efetivo}. SKUs sem saldo: ${(resp.skus_sem_saldo ?? []).join(", ")}. O pedido vai pra fila de separação.`,
          { duration: 10000 },
        );
      } else {
        toast.success("Venda criada");
      }
      router.push(`/wms/vendas/${resp.pedido_id}`);
    },
```

- [ ] Smoke: criar venda baixa_direta com SKU sem saldo → toast warn explicativo
- [ ] Commit: `git commit -am "fix(p5): venda nova mostra motivo_degradacao (finding 5.23)"`

### Task 5.14 — Vendas/nova: "criar em nome de X" (finding 5.28 / 7.17)

> Vendedor manager (gerente) pode criar venda em nome de outro vendedor. UI não tem switch — sempre atribui `vendedor_id = user.id`.

- [ ] Editar `src/app/wms/vendas/nova/page.tsx`
- [ ] Adicionar query de vendedores ativos:

```typescript
  const { data: vendedoresResp } = useQuery({
    queryKey: ["wms-vendedores"],
    queryFn: () =>
      wmsApi<{ rows: Array<{ id: string; nome: string }> }>(
        "/api/wms/admin/usuarios?cargo=vendedor&ativo=true",
      ),
    enabled: can("vendas.criar_em_nome_de") ?? false,
  });
```

> **Nota:** Permissão `vendas.criar_em_nome_de` será criada em P4. Por ora, condicional fica `false` — não mostra dropdown.

- [ ] Adicionar UI condicional:

```typescript
  {can("vendas.criar_em_nome_de") && vendedoresResp?.rows ? (
    <Field label="Vendedor responsável" hint="Padrão = você mesmo">
      <select
        className="wms-select"
        value={vendedorIdOverride ?? user?.id ?? ""}
        onChange={(e) => setVendedorIdOverride(e.target.value || null)}
      >
        <option value="">— eu mesmo —</option>
        {vendedoresResp.rows
          .filter((v) => v.id !== user?.id)
          .map((v) => (
            <option key={v.id} value={v.id}>
              {v.nome}
            </option>
          ))}
      </select>
    </Field>
  ) : null}
```

- [ ] State `vendedorIdOverride` (default null)
- [ ] No POST body, incluir `vendedor_id_override` quando setado
- [ ] Smoke (depende de P4 entregar a perm): com perm, gerente vê dropdown, escolhe outro vendedor, pedido fica atribuído a ele
- [ ] Commit: `git commit -am "feat(p5): venda nova criar em nome de X (finding 5.28)"`

### Task 5.15 — Devolução page lista: distinguir status no badge

> Pequeno polish — `/wms/devolucoes` lista mistura aguardando/classificada/aplicada. Badge mais visual.

- [ ] Verificar `src/app/wms/devolucoes/page.tsx`
- [ ] Se já usa `<StatusBadge>`, pular. Senão adicionar
- [ ] Commit (se mudou): `git commit -am "polish(p5): badges no list devoluções"`

### Task 5.16 — Smoke matrix das fixes 5.1–5.14

> Executar todos os smoke acima ponta-a-ponta no staging.

- [ ] Lista de smoke tests (cada um clique-a-clique):

| # | Cenário | Esperado |
|---|---|---|
| 5.1 | Abrir devolução pendente → Classe C → ver select fornecedor | Select aparece, valid bloqueia até escolher |
| 5.2 | Abrir devolução com status='classificada' | Detalhe renderiza, não 404 |
| 5.3 | /wms/pedidos/[id] tab admin → ver "Forçar pra separação" | Label coerente, tone primary |
| 5.4 | Pedido cancelado com mov L → banner D10 → estornar | (gated em P3) |
| 5.5 | Card pedido pendente → não tem botão Recusar | OK |
| 5.6 | /wms/guarda/[id] pendente → ver botão "Começar guarda" | Clique inicia, refresh não duplica |
| 5.7 | /wms/inventario/[id] aplicada → DevTools Network | Sem polling `/eventos` |
| 5.8 | /wms quadro → criar venda manual → card mostra split | "0 mkt · 1 manual" |
| 5.9 | Modal Receber → digitar loc nova | Não aparece opção "criar" |
| 5.10 | Imprimir-lote com 1 sem loc destino | Toast warning com contagem |
| 5.11 | /wms/pedidos tab Pendentes com 60+ | Paginação 50/pg |
| 5.12 | /wms/compras tab Histórico com 60+ | Paginação |
| 5.13 | /wms/vendas/nova baixa_direta sem saldo | Toast warn detalhado |
| 5.14 | Vendedor manager (futuro P4) cria em nome de X | Dropdown aparece |

- [ ] Anotar quais passaram / quais falharam
- [ ] Re-abrir tasks correspondentes pras que falharam
- [ ] Commit (vazio): `git commit --allow-empty -m "verify(p5): smoke matrix UI fixes"`

### Task 5.17 — Marca §5 como concluída

- [ ] Tag git: `git tag p5-section-5-complete`

---

## §6. Realtime invalidate em mov R criada/liberada

Finding 1.11: quadro home não reage quando reserva R é criada (aprovar pedido) ou liberada (cancelar). Já parcialmente coberto em §3 task 3.3 (subscribe `siso_movimentacoes` filtrado por tipo=R).

### Task 6.1 — Verificar cobertura de subscribe R

- [ ] Confirmar que §3 task 3.3 cobre INSERT + UPDATE com `filter: "tipo=eq.R"`
- [ ] Smoke ponta-a-ponta:
  1. Abrir /wms (browser 1, DevTools)
  2. Em browser 2 ou via curl, aprovar pedido (cria R)
  3. Browser 1: invalidate dispara → quadro atualiza
- [ ] Idem com cancelar pedido (libera R via mov L estorno_de=R)
- [ ] Commit (vazio): `git commit --allow-empty -m "verify(p5): R created/released invalida quadro home"`

### Task 6.2 — Subscribe em estornos (mov com estorno_de NOT NULL)

> Quando R é estornada (liberada), a mov estornadora insere uma nova linha com `estorno_de = R_id`. Já capturado pelo INSERT em §3.3, mas precisa garantir que invalida cards de Reservas Órfãs (eles dependem do delta).

- [ ] Validar comportamento: criar R órfã → ver card popular → estornar via mov L → ver card sumir em ≤500ms
- [ ] Se não acontecer, ajustar query de reservas órfãs no service (pode estar usando cache desatualizado)
- [ ] Commit (vazio): `git commit --allow-empty -m "verify(p5): reserva órfã desaparece após estorno"`

### Task 6.3 — Ajustar TTL cache do React Query pra evitar re-fetch lento

- [ ] Em `src/components/wms/home/quadro-tarefas.tsx`, atualizar useQuery:

```typescript
  const query = useQuery<DashboardTarefasResult>({
    queryKey: ["wms-tarefas-pendentes", activeGalpaoId],
    queryFn: () => /* ... */,
    staleTime: 0, // sempre stale — realtime invalida via hook
    refetchInterval: 30_000, // fallback caso realtime falhe
  });
```

- [ ] Commit: `git commit -am "perf(p5): staleTime=0 e fallback 30s no quadro home"`

### Task 6.4 — Marca §6 como concluída

- [ ] Tag git: `git tag p5-section-6-complete`

---

## §7. Smoke matrix manual + verificação final

### Task 7.1 — Critérios de pronto da spec §9.5

Re-validar os 6 critérios:

- [ ] Manual smoke: classificar uma devolução → card cai do quadro home em <2s
- [ ] Manual smoke: criar transferência em_transito → card aparece, idade incrementa
- [ ] Quadro home com filtro CWB mostra pedidos `separacao_galpao_id=NULL`
- [ ] Devolução Classe C aplicável no UI (select fornecedor funciona)
- [ ] Label "Forçar pendente" coerente com comportamento
- [ ] Banner D10 ou (a) tem endpoint funcional (b) está removido (depende de P3)

Anotar resultado em commit message.

### Task 7.2 — Validar layout em 3 viewports

- [ ] Mobile 375px (iPhone SE)
- [ ] Tablet 768px (iPad)
- [ ] Desktop 1440px
- [ ] Confirmar:
  - Cards do pipeline horizontais em desktop, empilhados em mobile
  - Kanban 3 colunas em desktop, scroll horizontal em mobile
  - Seção exceções grid responsivo
  - Toggle exceções acessível em mobile
- [ ] Screenshot pra cada viewport, anexar no PR
- [ ] Commit vazio: `git commit --allow-empty -m "verify(p5): layout responsivo em 3 viewports"`

### Task 7.3 — Validar performance no quadro

- [ ] Lighthouse no /wms (logado)
- [ ] Performance ≥85
- [ ] LCP <2.5s
- [ ] Se falhar, diagnosticar (provavelmente query encadeada ou waterfall)
- [ ] Commit: `git commit -am "verify(p5): lighthouse OK"`

### Task 7.4 — Validar todos os links nos cards de exceções

- [ ] Cada `<Link href="...">` nos 6 cards leva a uma página existente
- [ ] `/wms/devolucoes` → 200
- [ ] `/wms/transferir` → 200
- [ ] `/wms/inventario` → 200
- [ ] `/wms/ledger?tipo=R&orfas=true` → 200 (verificar se ledger aceita esses params, senão simplificar pra `/wms/ledger`)
- [ ] `/wms/retroativos` → 200
- [ ] `/wms/estoque?perspectiva=localizacao&tipo=recebimento` → 200 (idem)
- [ ] Ajustar hrefs que não funcionarem
- [ ] Commit (se ajustou): `git commit -am "fix(p5): hrefs dos cards de exceções"`

### Task 7.5 — Validar erro handling

- [ ] Simular falha do endpoint (matar API): cards renderizam estado vazio sem crash
- [ ] Confirmar `query.isError` → mostra mensagem retry no quadro
- [ ] Commit (vazio): `git commit --allow-empty -m "verify(p5): error handling do quadro"`

### Task 7.6 — Rodar suite completa de testes

- [ ] `npm run test` — passa
- [ ] `npm run test:integration -- dashboard` — passa
- [ ] `npm run lint` — passa
- [ ] `npx tsc --noEmit -p .` — passa
- [ ] Se algum falhar, fixar antes de continuar
- [ ] Commit: `git commit -am "test(p5): suite completa passando"`

### Task 7.7 — Documentar status no apêndice da spec

- [ ] Editar `docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md`
- [ ] Atualizar tabela em §9.6 com status:

```markdown
### 9.6 Status implementação (atualizado YYYY-MM-DD)

| Achado | Status |
|---|---|
| 5.1 Devoluções no quadro | ✓ |
| 5.2 Transferências em_transito | ✓ |
| ... |
```

- [ ] Commit: `git commit -am "docs(p5): atualiza spec com status implementação"`

### Task 7.8 — Marca §7 como concluída

- [ ] Tag git: `git tag p5-section-7-complete`

---

## §8. Documentação + PR

### Task 8.1 — Atualizar `docs/architecture-and-flows.md`

> A doc de arquitetura tem seção sobre quadro home. Precisa refletir as 6 novas categorias.

- [ ] `grep -n "quadro de tarefas\|QuadroTarefas\|dashboard-tarefas" docs/architecture-and-flows.md`
- [ ] Adicionar parágrafo descrevendo seção "Exceções":

```markdown
### Seção Exceções (P5, 2026-05-26)

Abaixo do kanban, a seção "Exceções" agrupa 6 categorias de pendência que
quebram o fluxo normal e exigem ação operacional:

1. **Devoluções pendentes** — NFs de entrada aguardando classificação A/B/C/D
2. **Transferências em trânsito** — Inter-galpão que ainda não chegaram (idade visível)
3. **Inventário em revisão** — Sessões com contagem encerrada aguardando supervisor
4. **Reservas órfãs** — Movs R de pedidos cancelados sem estorno (alerta vermelho >5)
5. **Retroativos pendentes** — Lançamentos retroativos não-reconciliados
6. **Saldo órfão em RECEBIMENTO** — Saldo no dock sem pendência viva (após cancelamento de guarda)

Default expandido se qualquer contador > 0. Colapsável manualmente.
Realtime via subscribe em 8 tabelas (incluindo `siso_devolucoes_pendentes`,
`siso_transferencias_galpao`, `siso_movimentacoes` filtrado por tipo=R).
```

- [ ] Commit: `git commit -am "docs(p5): seção Exceções em architecture-and-flows"`

### Task 8.2 — Atualizar `docs/api-reference-complete.md`

> Endpoint `GET /api/wms/dashboard-tarefas` ganhou campo `excecoes`. Endpoint novo `GET /api/wms/devolucoes/[id]`.

- [ ] Localizar seção `/api/wms/dashboard-tarefas` em `docs/api-reference-complete.md`
- [ ] Atualizar Response shape pra incluir chave `excecoes`
- [ ] Adicionar entry pra `GET /api/wms/devolucoes/[id]`
- [ ] Commit: `git commit -am "docs(p5): api-reference inclui excecoes + devolucoes/[id]"`

### Task 8.3 — Atualizar `CLAUDE.md`

> Seção "WMS Plano 5 (Exceções+Dashboards)" — adicionar nota P5.

- [ ] No bullet "**WMS Plano 5 (Exceções + dashboards)**", anexar:

```markdown
**Update 2026-05-26 (P5 fix):** Quadro home ganhou seção colapsável "Exceções"
com 6 cards (devoluções, transferências em_transito, inventário revisão, reservas
órfãs, retroativos, recebimento órfão). Filtro de galpão corrigido pra incluir
pedidos com `separacao_galpao_id IS NULL`. Hook realtime estendido pra 8 tabelas.
12 UI fixes (Classe C select fornecedor, label forçar pendente, etc.). Spec:
`docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md` §9. Plano:
`docs/superpowers/plans/2026-05-26-wms-fix-p5-visibilidade-home-ui-fixes.md`.
```

- [ ] Commit: `git commit -am "docs(p5): CLAUDE.md menciona P5 fixes"`

### Task 8.4 — Abrir PR pra develop

- [ ] `git push -u origin wms-fix-p5`
- [ ] `gh pr create --base develop --title "WMS Fix P5 · Visibilidade Home + UI Fixes (~28 findings)"` com body:

```markdown
## Summary
- 6 novos cards de exceções no quadro home (devoluções, transferências em_transito, inventário revisão, reservas órfãs, retroativos, recebimento órfão) em seção colapsável "Exceções"
- Fix filtro de galpão que escondia 69% dos pendentes (pedidos com `separacao_galpao_id IS NULL`)
- Hook realtime estendido de 5 → 8 tabelas (após P1 mergear publication)
- 12 UI fixes cirúrgicos: Classe C select fornecedor, detalhe devolução fetch dedicado, label forçar pendente, banner D10 wire (gated em P3), recusar pedido removido, guarda useEffect → botão, FeedEventos para polling, LocalizacaoCombo Receber allowCreate=false, toast ignorados, paginação pedidos+compras, criar venda em nome de X

## Princípios restaurados
- **PR-3** (realtime cross-module): publication completa + hook subscribe 8 tabelas
- **PR-8** (exceções visíveis na home): 6 novos cards

## Dependências
- BLOCKED em P1 merge (publication realtime)
- Banner D10 task GATED em P3 (endpoint estornar-cancelado)
- Vendas "em nome de X" GATED em P4 (perm `vendas.criar_em_nome_de`)

## Test plan
- [ ] `npm run test && npm run test:integration -- dashboard` passa
- [ ] Smoke matrix manual em §7.1 (6 critérios da spec)
- [ ] Layout 3 viewports (375/768/1440)
- [ ] Lighthouse Performance ≥85
- [ ] Verificar links dos 6 cards de exceções não 404am
- [ ] Smoke realtime: criar/cancelar pendência em outra aba → quadro home atualiza <2s

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] Anexar screenshots: home com seção exceções expandida + colapsada
- [ ] Anexar resultado do Lighthouse
- [ ] Tag final: `git tag p5-complete`

---

## Apêndice — Mapeamento finding → task

| Finding | Descrição | Task |
|---|---|---|
| 0.5 | Filtro galpão home esconde 69% pendentes | 2.1, 2.2 |
| 1.2 | Forçar pendente label invertido | 5.3 |
| 1.8 | Recusar pedido no-op | 5.5 |
| 1.9 | Banner D10 estornar sem endpoint | 5.4 (gated P3) |
| 1.11 | Quadro home não invalida em R criada/liberada | 3.3, 6.1, 6.2 |
| 1.15 | Tracking pedidos sem paginação | 5.11 |
| 2.17 | desfazer-parcial menciona UI inexistente | (deferida — P6) |
| 3.13 | Compras tab Histórico sem paginação | 5.12 |
| 4.9 | Sessão cancelada não notifica handheld | 3.6 |
| 4.12 | Dashboard conta errado sessões revisao/aprovada | 1.7 |
| 4.17 | FeedEventos polling em aplicadas | 5.7 |
| 5.1 | Devoluções invisíveis | 1.2, 1.3, 4.2 |
| 5.2 | Transferências invisíveis | 1.4, 1.5, 4.3 |
| 5.3 | Sessões revisão invisíveis | 1.6, 1.7, 4.4 |
| 5.4 | Reservas órfãs sem alerta | 1.8, 1.9, 4.5 |
| 5.5 | Retroativos invisíveis | 1.10, 1.11, 4.6 |
| 5.6 | RECEBIMENTO órfão invisível | 1.12, 1.13, 4.7 |
| 5.7 | Hook fora da publication | 0.2, 0.3, 3.1-3.5 |
| 5.8 | Filtro galpão NULL | 2.1, 2.2 |
| 5.9 | Quadro não invalida em R | 3.3, 6.1 |
| 5.10 | Sessão cancelada não notifica | 3.6 |
| 5.11 | Vendas poluem kanban | 1.15, 4.11 |
| 5.12 | Classe C UI quebrada | 5.1 |
| 5.13 | Detalhe devolução array filtrado | 5.2 |
| 5.14 | Forçar pendente label | 5.3 |
| 5.15 | Banner D10 | 5.4 |
| 5.16 | Recusar no-op | 5.5 |
| 5.17 | useEffect iniciar guarda | 5.6 |
| 5.18 | Confirmação parcial guarda regride | (gated P3 backend) |
| 5.19 | imprimir-lote sem ignorados | 5.10 |
| 5.20 | LocalizacaoCombo Receber allowCreate | 5.9 |
| 5.21 | Pendência sem loc no imprimir | 5.10 |
| 5.22 | parcial-modal sem opção OC | (deferida — P6 polish) |
| 5.23 | vendas/criar motivo_degradacao | 5.13 |
| 5.24 | Avatar parcial guarda some | (gated P3 backend) |
| 5.25 | Tracking paginação | 5.11 |
| 5.26 | Compras Histórico paginação | 5.12 |
| 5.27 | FeedEventos polling | 5.7 |
| 5.28 | Re-assign UI sem "em nome de" | 5.14 |
| 6.1 | Devoluções invisíveis no quadro | 1.2, 1.3, 4.2 |
| 6.4 | Classe C garantia quebrada | 5.1 |
| 6.6 | Detalhe devolução 404 | 5.2 |
| 7.6 | Vendas modo separacao poluem kanban | 1.15, 4.11 |
| 7.17 | UI vendas sem "em nome de X" | 5.14 |
| 8.1 (parte) | Transferência sem visibilidade home | 1.4, 1.5, 4.3 |
| 8.12 | LocalizacaoCombo Receber allowCreate | 5.9 |
| 8.13 | /wms/replenishment readonly | (deferida — P6) |

**Total mapeado:** 28 findings principais → ~103 tasks (TDD-strict).

---

## Apêndice — Convenções deste plan

- **TDD estrito:** todo novo helper puro tem teste antes da implementação.
- **Commits frequentes:** 1 task = 1 commit (`git commit -am "..."`), com prefixos `feat/fix/test/docs/style/perf/refactor/verify`.
- **Tags por seção:** `p5-section-N-complete` ao final de cada seção pra checkpoint.
- **Smoke matrix:** §7.1 reexecutado antes do PR. Failures abrem sub-tasks.
- **Dependências externas marcadas como "gated":** Banner D10 (P3), vendas "em nome de X" (P4), parcial guarda avatar (P3). NÃO bloqueiam P5 — só ficam wired-with-fallback ou hidden até dep mergear.
- **Não tocar em:** backend de aprovar/cancelar pedido (P2/P3 territory), schema de tabelas (P1 territory), permissions registry (P4 territory).
