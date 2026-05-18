# Realocação cascateável no picking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que qualquer loc sugerida no picking (original ou realocada) aceite parcial/loc-zerou, com cascade automático buscando próxima loc no galpão e fallback pro modal encaminhar/OC quando galpão esgota cobertura.

**Architecture:** Generaliza `siso_pedido_item_realocacoes` adicionando 7 colunas (chain via `parent_realocacao_id`, qty pega, parcial, motivo, timestamps, mov refs) + 1 status novo (`picado_parcial`). API `POST /api/wms/separacao/parcial` aceita dual body — `pedido_item_id` (atual) OU `realocacao_id` (novo) — com lógica unificada. `resolverRealocacao` aceita lista de locs a excluir. Frontend remove botão "Esgotado" das linhas normais; modal de encaminhar/OC é disparado automaticamente quando cascade falha. Realocações terminais aparecem read-only no checklist com badges semânticos.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres), Vitest, TanStack Query, Tailwind.

**Spec:** [`docs/superpowers/specs/2026-05-18-realocacao-cascateavel-design.md`](../specs/2026-05-18-realocacao-cascateavel-design.md)
**Workflow visual:** [`docs/superpowers/specs/2026-05-18-realocacao-cascateavel-workflow.html`](../specs/2026-05-18-realocacao-cascateavel-workflow.html)

---

## File Structure

**Backend:**
- Create: `supabase/migrations/20260518_realocacao_cascateavel.sql` — schema changes (7 cols + status + index)
- Modify: `src/lib/separacao/realocacao-resolver.ts` — input shape (`localizacoes_excluir: string[]`)
- Modify: `src/lib/separacao/realocacao-resolver.test.ts` — atualiza testes + adiciona case de exclusão múltipla
- Modify: `src/app/api/wms/separacao/parcial/route.ts` — dual-mode (aceita `realocacao_id`)

**Frontend:**
- Modify: `src/app/wms/separacao/checklist/page.tsx` — remove botão Esgotado, adiciona Parcial em realoc, renderiza realoc histórico, dispara modal encaminhar/OC em sem_cobertura

**Docs:**
- Modify: `CLAUDE.md` — atualiza descrição do fluxo de separação
- Modify: `docs/api-reference-complete.md` — atualiza `POST /api/wms/separacao/parcial`
- Modify: `docs/database-schema.md` — atualiza `siso_pedido_item_realocacoes`
- Modify: `erros-conhecidos.yaml` — apenas se erro for descoberto durante implementação

---

## Premissas

- Projeto Supabase staging: `ehbxpbeijofxtsbezwxd` (validação em staging antes de prod).
- Migration aplicada via `mcp__supabase__apply_migration` ou `supabase db push`.
- Testes unitários só pro `realocacao-resolver` (módulo puro). Lógica do route é validada manualmente em staging (padrão atual do projeto — não há testes de route handler).
- Build/lint check antes de commit em cada task que toca código.
- Não pular hooks de pre-commit.

---

## Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/20260518_realocacao_cascateavel.sql`

- [ ] **Step 1: Escrever a migration**

Conteúdo de `supabase/migrations/20260518_realocacao_cascateavel.sql`:

```sql
-- ============================================================
-- Migration: realocação cascateável no picking
-- Spec: docs/superpowers/specs/2026-05-18-realocacao-cascateavel-design.md
--
-- Adiciona à siso_pedido_item_realocacoes:
--   - parent_realocacao_id: rastreia chain de cascade
--   - quantidade_pega + parcial + parcial_motivo/em/por: estado de parcial
--   - mov_ajuste_loc_zerou_id: ref ao ajuste 'ajuste_pick_zerou' (qdo loc zerou)
--
-- Amplia status: adiciona 'picado_parcial' (terminal — gerou cascade ou sem cobertura).
-- ============================================================

BEGIN;

ALTER TABLE siso_pedido_item_realocacoes
  ADD COLUMN parent_realocacao_id uuid REFERENCES siso_pedido_item_realocacoes(id),
  ADD COLUMN quantidade_pega integer,
  ADD COLUMN parcial boolean NOT NULL DEFAULT false,
  ADD COLUMN parcial_motivo text,
  ADD COLUMN parcial_em timestamptz,
  ADD COLUMN parcial_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN mov_ajuste_loc_zerou_id uuid REFERENCES siso_movimentacoes(id);

-- Substitui constraint de status: adiciona 'picado_parcial'
ALTER TABLE siso_pedido_item_realocacoes
  DROP CONSTRAINT siso_pedido_item_realocacoes_status_check;

ALTER TABLE siso_pedido_item_realocacoes
  ADD CONSTRAINT siso_pedido_item_realocacoes_status_check
  CHECK (status IN ('aguardando_picking','picado','picado_parcial','cancelado'));

-- Index pra navegar a chain do cascade (debug + reconciliação)
CREATE INDEX idx_realoc_parent ON siso_pedido_item_realocacoes(parent_realocacao_id);

COMMIT;
```

- [ ] **Step 2: Aplicar em staging**

Via MCP tool (preferido):

```
mcp__supabase__apply_migration(
  project_id: "ehbxpbeijofxtsbezwxd",
  name: "20260518_realocacao_cascateavel",
  query: <conteúdo do .sql acima sem o BEGIN/COMMIT — apply_migration envelopa>
)
```

Ou via CLI:
```bash
npx supabase db push --linked
```

- [ ] **Step 3: Verificar schema em staging**

```sql
-- Via mcp__supabase__execute_sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'siso_pedido_item_realocacoes'
  AND column_name IN ('parent_realocacao_id','quantidade_pega','parcial','parcial_motivo','parcial_em','parcial_por','mov_ajuste_loc_zerou_id')
ORDER BY column_name;
```

Esperado: 7 linhas retornadas.

```sql
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'siso_pedido_item_realocacoes_status_check';
```

Esperado: `CHECK (status = ANY (ARRAY['aguardando_picking'::text, 'picado'::text, 'picado_parcial'::text, 'cancelado'::text]))`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518_realocacao_cascateavel.sql
git commit -m "feat(wms/separacao): schema para realocação cascateável

Adiciona parent_realocacao_id, quantidade_pega, parcial, parcial_motivo/em/por
e mov_ajuste_loc_zerou_id em siso_pedido_item_realocacoes. Status ganha
'picado_parcial' pra marcar realocações que pegaram parcialmente e
geraram cascade (ou ficaram sem cobertura).

Spec: docs/superpowers/specs/2026-05-18-realocacao-cascateavel-design.md"
```

---

## Task 2: Refactor `resolverRealocacao` para aceitar lista de exclusão

**Files:**
- Modify: `src/lib/separacao/realocacao-resolver.ts`
- Modify: `src/lib/separacao/realocacao-resolver.test.ts`

- [ ] **Step 1: Escrever o teste novo (red)**

Adicionar ao final de `realocacao-resolver.test.ts`, dentro do `describe`:

```typescript
  it("exclui múltiplas localizações via localizacoes_excluir", async () => {
    const deps: ResolverDeps = {
      listarEmpresasDoGrupoMesmoGalpao: vi.fn(async () => [empresaOrigem]),
      listarSaldoCandidato: vi.fn(async ({ localizacao_id_excluir, localizacoes_excluir }) => {
        // O resolver deve passar localizacoes_excluir adiante; dep mock filtra.
        const todas: EstoqueCandidato[] = [
          {
            empresa_dona_id: empresaOrigem,
            localizacao_id: "loc-A",
            localizacao_codigo: "A",
            localizacao_tipo: "picking",
            disponivel: 5,
          },
          {
            empresa_dona_id: empresaOrigem,
            localizacao_id: "loc-B",
            localizacao_codigo: "B",
            localizacao_tipo: "picking",
            disponivel: 5,
          },
          {
            empresa_dona_id: empresaOrigem,
            localizacao_id: "loc-C",
            localizacao_codigo: "C",
            localizacao_tipo: "picking",
            disponivel: 5,
          },
        ];
        const excluidas = new Set(localizacoes_excluir ?? [localizacao_id_excluir]);
        return todas.filter((c) => !excluidas.has(c.localizacao_id));
      }),
    };

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacoes_excluir: ["loc-A", "loc-B"],
        qty_residual: 3,
      },
      deps,
    );

    expect(r.status).toBe("realocado");
    expect(r.realocacoes).toHaveLength(1);
    expect(r.realocacoes[0].localizacao_id).toBe("loc-C");
  });
```

- [ ] **Step 2: Rodar — deve falhar (compile error)**

```bash
npm test -- realocacao-resolver
```

Esperado: TypeScript error em `localizacoes_excluir` (campo não existe em `ResolverInput`) e em `localizacoes_excluir` param de `listarSaldoCandidato`.

- [ ] **Step 3: Atualizar tipos e implementação**

Em `src/lib/separacao/realocacao-resolver.ts`, substituir:

```typescript
export interface ResolverInput {
  produto_id: string;
  empresa_origem_id: string;
  galpao_id: string;
  localizacao_id_original: string;
  qty_residual: number;
}
```

por:

```typescript
export interface ResolverInput {
  produto_id: string;
  empresa_origem_id: string;
  galpao_id: string;
  /** Loc original do item (compat com chamadas legacy — usado quando localizacoes_excluir não é passado). */
  localizacao_id_original?: string;
  /** Lista completa de localizações a excluir do pool. Tem precedência sobre localizacao_id_original. */
  localizacoes_excluir?: string[];
  qty_residual: number;
}
```

Substituir a interface `ResolverDeps`:

```typescript
export interface ResolverDeps {
  listarEmpresasDoGrupoMesmoGalpao: (
    empresaOrigemId: string,
    galpaoId: string,
  ) => Promise<string[]>;
  listarSaldoCandidato: (input: {
    produto_id: string;
    galpao_id: string;
    empresas_grupo: string[];
    /** @deprecated use `localizacoes_excluir`. Mantido por compat. */
    localizacao_id_excluir?: string;
    localizacoes_excluir?: string[];
  }) => Promise<EstoqueCandidato[]>;
}
```

Na função `resolverRealocacao`, substituir a montagem da chamada a `listarSaldoCandidato`:

```typescript
  const excluir =
    input.localizacoes_excluir && input.localizacoes_excluir.length > 0
      ? input.localizacoes_excluir
      : input.localizacao_id_original
        ? [input.localizacao_id_original]
        : [];

  const candidatos = await deps.listarSaldoCandidato({
    produto_id: input.produto_id,
    galpao_id: input.galpao_id,
    empresas_grupo: empresas,
    localizacoes_excluir: excluir,
    // Mantém legacy pra deps que ainda lêem só localizacao_id_excluir
    localizacao_id_excluir: excluir[0],
  });
```

No `defaultDeps`, substituir a query `.neq("localizacao_id", localizacao_id_excluir)` por filtro com array:

```typescript
    listarSaldoCandidato: async ({
      produto_id,
      galpao_id,
      empresas_grupo,
      localizacoes_excluir,
      localizacao_id_excluir,
    }) => {
      const supabase = createServiceClient();
      const excluir =
        localizacoes_excluir && localizacoes_excluir.length > 0
          ? localizacoes_excluir
          : localizacao_id_excluir
            ? [localizacao_id_excluir]
            : [];

      let query = supabase
        .from("siso_estoque")
        .select(
          `
          empresa_dona_id,
          localizacao_id,
          disponivel,
          siso_localizacoes!inner(codigo, tipo)
        `,
        )
        .eq("produto_id", produto_id)
        .eq("galpao_id", galpao_id)
        .in("empresa_dona_id", empresas_grupo)
        .gt("disponivel", 0);

      if (excluir.length > 0) {
        query = query.not("localizacao_id", "in", `(${excluir.join(",")})`);
      }

      const { data } = await query;
      // ... resto igual
```

- [ ] **Step 4: Atualizar testes existentes que usavam `localizacao_id_original`**

Os 6 testes anteriores no arquivo passam `localizacao_id_original: locOriginal`. Eles devem continuar passando (interface é backward-compat com o campo opcional). Verificar.

- [ ] **Step 5: Rodar testes — devem passar**

```bash
npm test -- realocacao-resolver
```

Esperado: 7 testes passando (6 existentes + 1 novo).

- [ ] **Step 6: Lint + build check**

```bash
npm run lint && npm run build 2>&1 | tail -20
```

Esperado: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/separacao/realocacao-resolver.ts src/lib/separacao/realocacao-resolver.test.ts
git commit -m "refactor(wms/separacao): resolverRealocacao aceita lista de exclusão

Substitui localizacao_id_original (string única) por localizacoes_excluir
(array). Campo antigo mantido como opcional pra compat com chamadas legacy.
Necessário pra cascade: cada nova busca exclui a loc original do item E
todas as locs de realocações anteriores."
```

---

## Task 3: Lógica de marcação parcial em realocação (modo realocacao_id)

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts`

- [ ] **Step 1: Refatorar parsing do body pra aceitar dois modos**

No início do `POST`, substituir a validação de body por:

```typescript
  const body = await request.json().catch(() => null);

  const isRealocacaoMode = body && typeof body.realocacao_id === "string";
  const isItemMode = body && (typeof body.pedido_item_id === "number" || typeof body.pedido_item_id === "string");

  if (!isRealocacaoMode && !isItemMode) {
    return NextResponse.json(
      { error: "campo 'pedido_item_id' ou 'realocacao_id' obrigatório" },
      { status: 400 },
    );
  }

  if (
    typeof body.quantidade_pega !== "number" ||
    body.quantidade_pega < 0 ||
    !Number.isInteger(body.quantidade_pega) ||
    typeof body.loc_zerou !== "boolean"
  ) {
    return NextResponse.json(
      {
        error:
          "campos 'quantidade_pega' (int>=0) e 'loc_zerou' (bool) obrigatórios",
      },
      { status: 400 },
    );
  }

  const { quantidade_pega, loc_zerou } = body as {
    quantidade_pega: number;
    loc_zerou: boolean;
  };
```

- [ ] **Step 2: Extrair função `processarParcialItem(supabase, session, body)` com a lógica atual**

Mover todo o bloco `try { ... }` existente pra uma função interna que recebe `pedido_item_id` e mantém o comportamento atual. Retorna a `NextResponse` direta. Isso isola a refatoração antes de adicionar o modo realocação.

```typescript
async function processarParcialItem(
  supabase: ReturnType<typeof createServiceClient>,
  session: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
  pedido_item_id: number | string,
  quantidade_pega: number,
  loc_zerou: boolean,
): Promise<NextResponse> {
  // ... bloco try existente (linhas 47–322 do arquivo atual)
}
```

E no handler:

```typescript
  const supabase = createServiceClient();

  if (isItemMode) {
    return processarParcialItem(supabase, session, body.pedido_item_id, quantidade_pega, loc_zerou);
  }
  return processarParcialRealocacao(supabase, session, body.realocacao_id, quantidade_pega, loc_zerou);
```

- [ ] **Step 3: Adicionar `processarParcialRealocacao`**

Criar nova função (mesmo arquivo, após `processarParcialItem`):

```typescript
async function processarParcialRealocacao(
  supabase: ReturnType<typeof createServiceClient>,
  session: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
  realocacao_id: string,
  quantidade_pega: number,
  loc_zerou: boolean,
): Promise<NextResponse> {
  try {
    // 1. Busca realocação
    const { data: realoc, error: realocErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select(`
        id, pedido_item_id, empresa_dona_id, galpao_id, localizacao_id,
        quantidade, is_emprestimo, empresa_devedora_id, status
      `)
      .eq("id", realocacao_id)
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
    if (quantidade_pega > realoc.quantidade) {
      return NextResponse.json(
        { error: `quantidade_pega não pode exceder ${realoc.quantidade}` },
        { status: 400 },
      );
    }

    // 2. Busca item pai e pedido
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

    // 3. Resolve produto WMS (na empresa dona da realoc — pode ser empréstimo)
    const produtoWmsId = await resolverProdutoWms(
      realoc.empresa_dona_id,
      String(item.produto_id),
    );

    // 4. Lê saldo atual
    const { data: estoqueWms } = await supabase
      .from("siso_estoque")
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoWmsId)
      .eq("empresa_dona_id", realoc.empresa_dona_id)
      .eq("galpao_id", realoc.galpao_id)
      .eq("localizacao_id", realoc.localizacao_id)
      .maybeSingle();

    const saldoWms = Number(estoqueWms?.saldo ?? 0);
    const reservadoWms = Number(estoqueWms?.reservado ?? 0);
    const disponivelWms = Number(estoqueWms?.disponivel ?? saldoWms - reservadoWms);

    if (quantidade_pega > 0 && disponivelWms < quantidade_pega) {
      return NextResponse.json(
        {
          error: "posicao_reservada",
          message:
            `Posição reservada por outro pedido (saldo ${saldoWms}, reservado ${reservadoWms}, disponível ${disponivelWms}). ` +
            `Não é possível dar saída de ${quantidade_pega}. Avise o supervisor pra liberar a reserva.`,
          saldo: saldoWms,
          reservado: reservadoWms,
          disponivel: disponivelWms,
          quantidade_pega,
        },
        { status: 409 },
      );
    }

    // 5. Gera mov S (qty pega) — origem emprestimo OU nf_venda
    let movSaidaId: string | null = null;
    if (quantidade_pega > 0) {
      const mov = await inserirMovimentacao({
        quadrupla: {
          produto_id: produtoWmsId,
          empresa_dona_id: realoc.empresa_dona_id,
          galpao_id: realoc.galpao_id,
          localizacao_id: realoc.localizacao_id,
        },
        tipo: "S",
        qty: quantidade_pega,
        origem_tipo: realoc.is_emprestimo ? "emprestimo" : "nf_venda",
        origem_id: `pedido:${pedido.id}`,
        origem_detalhes: {
          pedido_numero: pedido.numero,
          pedido_item_id: item.id,
          realocacao_id: realoc.id,
          sku: item.sku,
          contexto: "realocacao_parcial",
        },
        emprestimo_devedora_id: realoc.is_emprestimo
          ? realoc.empresa_devedora_id ?? undefined
          : undefined,
        observacoes: realoc.is_emprestimo
          ? `Picking parcial pedido #${pedido.numero} — empréstimo`
          : `Picking parcial pedido #${pedido.numero} — realocação`,
        usuario_id: session.id,
      });
      movSaidaId = mov.id;
    }

    // 6. Gera mov de ajuste se loc zerou
    let movAjusteId: string | null = null;
    if (loc_zerou) {
      const delta = saldoWms - quantidade_pega;
      if (delta > 0) {
        const movAj = await inserirMovimentacao({
          quadrupla: {
            produto_id: produtoWmsId,
            empresa_dona_id: realoc.empresa_dona_id,
            galpao_id: realoc.galpao_id,
            localizacao_id: realoc.localizacao_id,
          },
          tipo: "S",
          qty: delta,
          origem_tipo: "ajuste_pick_zerou",
          origem_id: `pedido:${pedido.id}`,
          origem_detalhes: {
            pedido_numero: pedido.numero,
            pedido_item_id: item.id,
            realocacao_id: realoc.id,
            saldo_anterior: saldoWms,
            qty_pega: quantidade_pega,
          },
          observacoes: `Loc zerou na realocação — ajuste ${delta} (sistema dizia ${saldoWms}, real ${quantidade_pega})`,
          usuario_id: session.id,
        });
        movAjusteId = movAj.id;
      }
    }

    // 7. Atualiza realocação: parcial ou picado
    const qtyResidual = realoc.quantidade - quantidade_pega;
    const isCompleto = qtyResidual <= 0;
    const nowIso = new Date().toISOString();

    const { error: updErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .update({
        status: isCompleto ? "picado" : "picado_parcial",
        quantidade_pega,
        parcial: !isCompleto,
        parcial_motivo: !isCompleto
          ? loc_zerou ? "cascade_loc_zerou" : "cascade_parcial"
          : null,
        parcial_em: !isCompleto ? nowIso : null,
        parcial_por: !isCompleto ? session.id : null,
        picado_em: isCompleto ? nowIso : null,
        picado_por: isCompleto ? session.id : null,
        mov_saida_id: movSaidaId,
        mov_ajuste_loc_zerou_id: movAjusteId,
      })
      .eq("id", realoc.id);

    if (updErr) {
      logger.logError({
        error: updErr,
        source: "separacao-parcial-realoc",
        message: "Falhou update realocação",
        category: "database",
        requestPath: "/api/wms/separacao/parcial",
        requestMethod: "POST",
        metadata: { realocacao_id: realoc.id, movSaidaId, movAjusteId },
      });
      return NextResponse.json({ error: "erro persistindo realocação" }, { status: 500 });
    }

    // 8. Acumula no item pai
    const novaQtyPaiPega = (item.quantidade_pega ?? 0) + quantidade_pega;
    await supabase
      .from("siso_pedido_itens")
      .update({ quantidade_pega: novaQtyPaiPega })
      .eq("id", item.id);

    // 9. Evento histórico
    await registrarEvento({
      pedidoId: pedido.id,
      evento: isCompleto ? "realocacao_picada" : "realocacao_parcial",
      detalhes: {
        item_id: item.id,
        realocacao_id: realoc.id,
        sku: item.sku,
        quantidade_pega,
        quantidade_sugerida: realoc.quantidade,
        is_emprestimo: realoc.is_emprestimo,
        loc_zerou,
        delta_ajuste: movAjusteId ? saldoWms - quantidade_pega : 0,
      },
      usuarioId: session.id,
    });

    if (isCompleto) {
      return NextResponse.json({ status: "completo" });
    }

    // 10. Cascade — disparado em Task 4
    return NextResponse.json({ status: "completo" }); // STUB — substituído em Task 4
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-parcial-realoc",
      message: "Erro inesperado em parcial realocação",
      category: "unknown",
      requestPath: "/api/wms/separacao/parcial",
      requestMethod: "POST",
      metadata: { realocacao_id, quantidade_pega, loc_zerou },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Build + lint check**

```bash
npm run lint && npm run build 2>&1 | tail -20
```

Esperado: 0 errors. Confirma que o handler refatorado compila e não quebra o caso item.

- [ ] **Step 5: Validação manual em staging — caso item (regressão)**

No app staging:
1. Pedido em separação com 1 item qty=5.
2. Clicar "Parcial", pegar 3, loc zerou=false. Confirmar.
3. Verificar via SQL que mov S=3 foi criada, item.quantidade_pega=3, status=picado_parcial (raiz).
4. Verificar que API retornou `{ status: 'realocado', ... }` ou `'sem_cobertura'` (comportamento preservado do modo item).

Esperado: comportamento idêntico ao anterior à refatoração.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/wms/separacao/parcial/route.ts
git commit -m "refactor(wms/separacao): split parcial route em handlers item/realocacao

Extrai a lógica atual em processarParcialItem; adiciona shell de
processarParcialRealocacao (ainda sem cascade — Task 4) com baixa
de estoque, ajuste loc_zerou, update da realocação e acúmulo no
item pai. Body aceita pedido_item_id (atual) OU realocacao_id (novo)."
```

---

## Task 4: Cascade da realocação quando residual > 0

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts`

- [ ] **Step 1: Substituir o STUB na linha 10 de `processarParcialRealocacao`**

Substituir `return NextResponse.json({ status: "completo" }); // STUB` por:

```typescript
    // 10. Cascade: busca próxima loc no galpão, excluindo todas já tentadas neste item
    const { data: todasRealoc } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("localizacao_id")
      .eq("pedido_item_id", item.pedido_item_id);

    // Loc original do item (do estoque legacy do pedido) — resolver pra UUID WMS
    const { data: estoqueLegacy } = await supabase
      .from("siso_pedido_item_estoques")
      .select("localizacao")
      .eq("pedido_id", item.pedido_id)
      .eq("produto_id", item.produto_id)
      .eq("empresa_id", pedido.empresa_origem_id!)
      .maybeSingle();

    const locOriginalId = await resolverLocalizacaoWms(
      realoc.galpao_id,
      estoqueLegacy?.localizacao ?? null,
    );

    const localizacoes_excluir = Array.from(
      new Set([
        locOriginalId,
        ...(todasRealoc ?? []).map((r) => r.localizacao_id as string),
      ]),
    );

    // empresa_origem do pedido (não da realoc — cascade prioriza empresa original)
    const empresaOrigemPedido = pedido.empresa_origem_id;
    if (!empresaOrigemPedido) {
      return NextResponse.json({ error: "pedido sem empresa de origem" }, { status: 400 });
    }

    // Resolver produto na empresa origem (pode diferir do produtoWmsId se realoc foi empréstimo)
    const produtoWmsOrigemId = await resolverProdutoWms(
      empresaOrigemPedido,
      String(item.produto_id),
    );

    const resolver = await resolverRealocacao({
      produto_id: produtoWmsOrigemId,
      empresa_origem_id: empresaOrigemPedido,
      galpao_id: realoc.galpao_id,
      localizacoes_excluir,
      qty_residual: qtyResidual,
    });

    if (resolver.status === "sem_cobertura") {
      // Tratamento em Task 5
      await registrarEvento({
        pedidoId: pedido.id,
        evento: "realocacao_sem_cobertura_cascade",
        detalhes: {
          item_id: item.id,
          realocacao_id: realoc.id,
          sku: item.sku,
          qty_residual: qtyResidual,
        },
        usuarioId: session.id,
      });
      return NextResponse.json({
        status: "sem_cobertura",
      });
    }

    const rows = resolver.realocacoes.map((r) => ({
      pedido_item_id: item.id,
      parent_realocacao_id: realoc.id,
      empresa_dona_id: r.empresa_dona_id,
      galpao_id: realoc.galpao_id,
      localizacao_id: r.localizacao_id,
      quantidade: r.quantidade,
      is_emprestimo: r.is_emprestimo,
      empresa_devedora_id: r.empresa_devedora_id,
      motivo: loc_zerou ? "cascade_loc_zerou" : "cascade_parcial",
      criado_por: session.id,
    }));

    const { data: criadas, error: insErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .insert(rows)
      .select("id, empresa_dona_id, localizacao_id, quantidade, is_emprestimo");

    if (insErr) {
      logger.logError({
        error: insErr,
        source: "separacao-parcial-realoc",
        message: "Falhou criar realocações no cascade",
        category: "database",
        requestPath: "/api/wms/separacao/parcial",
        requestMethod: "POST",
        metadata: { realocacao_id: realoc.id, rows },
      });
      return NextResponse.json({ error: "erro criando realocações" }, { status: 500 });
    }

    await registrarEvento({
      pedidoId: pedido.id,
      evento: "realocacao_parcial_cascade",
      detalhes: {
        item_id: item.id,
        realocacao_id_origem: realoc.id,
        qtd_novas_realocacoes: criadas?.length ?? 0,
        sku: item.sku,
      },
      usuarioId: session.id,
    });

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
```

**IMPORTANTE:** corrigir o typo na primeira linha (deve ser `item.id`, não `item.pedido_item_id`):

```typescript
    const { data: todasRealoc } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("localizacao_id")
      .eq("pedido_item_id", item.id);
```

- [ ] **Step 2: Atualizar update da realocação no Step 7 anterior pra refletir o status correto**

O update no Step 7 da Task 3 já marca `status: 'picado_parcial'` quando `!isCompleto`. Mas o `picado_parcial` faz sentido tanto pra sucesso de cascade quanto pra falha (sem_cobertura). Verificar que isso já está correto — sim, está.

- [ ] **Step 3: Build + lint**

```bash
npm run lint && npm run build 2>&1 | tail -20
```

Esperado: 0 errors.

- [ ] **Step 4: Validação manual em staging — cascade simples**

1. Pedido qty=5 do item X, loc original A1-02 (saldo sistema 5).
2. Em staging, ajustar saldo real da A1-02 pra 2 (via SQL no banco, ou criar cenário).
3. Garantir que loc B2-15 tem 3+ do mesmo produto.
4. Operador dá parcial qty=2 na A1-02 com loc_zerou=true.
5. Confirmar: resposta `{ status: 'realocado', realocacoes: [{ localizacao_codigo: 'B2-15', quantidade: 3, ... }] }`.
6. SQL: `SELECT id, parent_realocacao_id, status, quantidade, quantidade_pega FROM siso_pedido_item_realocacoes WHERE pedido_item_id = ?` — duas linhas: raiz `picado_parcial` (Tasks 3+4 ainda não criam raiz por item — ela vem do fluxo item; aqui é a raiz que veio do parcial original) E filha `aguardando_picking`.
7. Operador dá parcial na nova realoc (B2-15) com qty=1 loc_zerou=true.
8. Confirmar nova linha de realoc cascade pra próxima loc.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wms/separacao/parcial/route.ts
git commit -m "feat(wms/separacao): cascade automático no parcial de realocação

Quando uma realocação dá parcial e sobra residual, sistema busca próxima
loc no galpão (excluindo loc original do item + todas as locs de realocações
do mesmo item) e cria nova realocação com parent_realocacao_id apontando
pra atual. Empresa origem do pedido tem prioridade (mesmo se realoc atual
era empréstimo). Resposta padrão: { status: 'realocado' | 'sem_cobertura' }."
```

---

## Task 5: Sem cobertura — marcar pedido pendente_realocacao quando frontend não decidir

**Files:**
- Modify: `src/app/api/wms/separacao/parcial/route.ts`

- [ ] **Step 1: Decisão de design**

A resposta `sem_cobertura` da API é apenas informativa. O frontend é quem decide o destino:
- Se operador escolher "Encaminhar" → endpoint `/api/wms/separacao/produto-esgotado` (existente)
- Se operador escolher "Criar OC" → mesmo endpoint, acao=oc
- Se operador fechar o modal sem decidir → frontend faz PATCH no pedido pra marcar `pendente_realocacao` (próxima task)

Backend NÃO marca `pendente_realocacao` automaticamente nesta task. A `processarParcialRealocacao` atual já não marca — segue assim. Só registrar o evento.

- [ ] **Step 2: Verificar que processarParcialItem mantém marcação `pendente_realocacao`**

No `processarParcialItem` original (modo item), o `sem_cobertura` continua marcando `pendente_realocacao` (comportamento legado, não mudar). Confirmar que esse caminho está intacto na refatoração da Task 3.

```bash
grep -A 6 'sem_cobertura' src/app/api/wms/separacao/parcial/route.ts | head -30
```

Esperado: ver dois blocos `if (resolver.status === "sem_cobertura")`. O do `processarParcialItem` marca `pendente_realocacao`; o do `processarParcialRealocacao` apenas retorna a resposta sem marcar.

- [ ] **Step 3: Sem alteração de código nesta task — apenas validação**

Validação manual:
1. Cenário onde galpão NÃO tem cobertura (zerar/remover todas as locs do produto).
2. Parcial qty=2 loc_zerou=true.
3. Resposta: `{ status: 'sem_cobertura' }`.
4. Pedido **NÃO** muda pra `pendente_realocacao` (continua `em_separacao`). Frontend decide.

- [ ] **Step 4: Commit (skip se não houve alteração)**

Se houve algum ajuste durante validação, commit. Senão, pular pra Task 6.

---

## Task 6: Frontend — remover botão "Esgotado" da ItemRow normal

**Files:**
- Modify: `src/app/wms/separacao/checklist/page.tsx`

- [ ] **Step 1: Remover botão Esgotado da `ItemRow`**

No componente `ItemRow` (linhas ~1047–1181), remover o bloco do botão Esgotado:

```tsx
        {!done && (
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onEsgotado}
            title={`Marcar ${produto.sku} como esgotado`}
          >
            Esgotado
          </button>
        )}
```

Remover o param `onEsgotado` da signature de `ItemRow` (mas manter no `onEsgotadoFromCascade` handler interno — vai ser invocado pelo cascade, Task 8).

```tsx
function ItemRow({
  produto,
  isParcial,
  parcialItem,
  onToggle,
  onParcial,
}: {
  produto: ConsolidatedProduct;
  isParcial: boolean;
  parcialItem: ChecklistItem | undefined;
  onToggle: () => void;
  onParcial: () => void;
}) {
```

Atualizar a chamada de `<ItemRow ... />` no map (linha ~824) removendo `onEsgotado={() => handleEsgotadoPreview(p.sku)}`.

- [ ] **Step 2: Build + lint**

```bash
npm run lint && npm run build 2>&1 | tail -20
```

Esperado: 0 errors (a função `handleEsgotadoPreview` ainda existe — será usada na Task 8).

- [ ] **Step 3: Validação manual visual**

```bash
npm run dev
```

Abrir `/wms/separacao`, iniciar wave picking, abrir checklist. Verificar:
- Linhas normais agora têm apenas botão "Parcial" (sem "Esgotado").
- Botão "Parcial" abre o modal idêntico ao anterior.

- [ ] **Step 4: Commit**

```bash
git add src/app/wms/separacao/checklist/page.tsx
git commit -m "feat(wms/separacao): remove botão Esgotado da linha de item

Esgotado vira caso particular do Parcial (qty=0 + loc_zerou=true). Operador
não escolhe mais entre os dois — sempre passa pelo modal de qty. Modal
encaminhar/OC continua existindo mas só dispara via cascade falho (Task 8)."
```

---

## Task 7: Frontend — renderizar realocações com botão Parcial + histórico

**Files:**
- Modify: `src/app/wms/separacao/checklist/page.tsx`

- [ ] **Step 1: Atualizar tipo `Realocacao`**

Substituir interface (linha ~20):

```tsx
interface Realocacao {
  id: string;
  parent_realocacao_id: string | null;
  empresa_dona_id: string;
  empresa_nome: string | null;
  localizacao_id: string;
  localizacao_codigo: string;
  quantidade: number;
  quantidade_pega: number | null;
  parcial: boolean;
  parcial_motivo: string | null;
  is_emprestimo: boolean;
  empresa_devedora_id: string | null;
  status: "aguardando_picking" | "picado" | "picado_parcial" | "cancelado";
  criado_em: string;
}
```

- [ ] **Step 2: Verificar/atualizar API `/api/wms/separacao/checklist-items` pra incluir campos novos**

```bash
grep -n "realocacoes" src/app/api/wms/separacao/checklist-items/route.ts
```

Se o select não pega os campos `parent_realocacao_id`, `quantidade_pega`, `parcial`, `parcial_motivo`, adicionar à query.

- [ ] **Step 3: Substituir o bloco de renderização das realocações (linhas ~848–966)**

```tsx
          {/* ─── Realocações — adicionadas ao fim dos itens normais ─── */}
          {(() => {
            const realocacaoLinhas: Array<{
              item: ChecklistItem;
              realocacao: Realocacao;
            }> = [];
            for (const item of items) {
              if (item.compra_status === "oc_pendente") continue;
              for (const r of item.realocacoes ?? []) {
                realocacaoLinhas.push({ item, realocacao: r });
              }
            }
            if (realocacaoLinhas.length === 0) return null;

            // Ordena cronologicamente
            realocacaoLinhas.sort((a, b) =>
              a.realocacao.criado_em.localeCompare(b.realocacao.criado_em),
            );

            return (
              <>
                <h2 className="wms-sec-h">
                  Realocações ({realocacaoLinhas.length})
                </h2>
                <div>
                  {realocacaoLinhas.map(({ item, realocacao: r }) => (
                    <RealocacaoRow
                      key={`realoc-${r.id}`}
                      item={item}
                      realocacao={r}
                      onMarcar={() => handleMarcarRealocacao(r.id)}
                      onParcial={() =>
                        setParcialModal({
                          itemId: r.id,
                          isRealocacao: true,
                          sku: item.sku,
                          localizacao: r.localizacao_codigo,
                          quantidade: r.quantidade,
                          loading: false,
                        })
                      }
                    />
                  ))}
                </div>
              </>
            );
          })()}
```

- [ ] **Step 4: Adicionar componente `RealocacaoRow`**

Logo após `ItemRowOC` (final do arquivo, antes do EsgotadoModal):

```tsx
function RealocacaoRow({
  item,
  realocacao: r,
  onMarcar,
  onParcial,
}: {
  item: ChecklistItem;
  realocacao: Realocacao;
  onMarcar: () => void;
  onParcial: () => void;
}) {
  const isActive = r.status === "aguardando_picking";
  const isPicadoCompleto = r.status === "picado";
  const isPicadoParcial = r.status === "picado_parcial";
  const isCancelado = r.status === "cancelado";

  const badgeLabel = isPicadoCompleto
    ? "Picado"
    : isPicadoParcial
      ? `Picado ${r.quantidade_pega ?? 0}/${r.quantidade}`
      : isCancelado
        ? "Cancelada"
        : "Aguardando";

  const badgeClass = isPicadoCompleto
    ? "wms-badge wms-badge-ok"
    : isCancelado || isPicadoParcial
      ? "wms-badge"
      : "wms-badge wms-badge-warn";

  const rowStyle: React.CSSProperties = isActive
    ? {
        borderColor: "var(--wms-c-warn-border, #fcd34d)",
        background: "var(--wms-c-warn-faint, #fffbeb)",
      }
    : isPicadoCompleto
      ? {
          borderColor: "var(--wms-c-ok-border, #a7f3d0)",
          background: "var(--wms-c-ok-faint, #ecfdf5)",
          opacity: 0.85,
        }
      : {
          opacity: 0.6,
        };

  return (
    <div
      className="wms-hand-item"
      style={{
        gridTemplateColumns: "28px 44px minmax(0,1fr) 56px 170px",
        ...rowStyle,
      }}
    >
      <div
        role={isActive ? "button" : undefined}
        tabIndex={isActive ? 0 : -1}
        className="wms-hand-item-check"
        onClick={isActive ? onMarcar : undefined}
        onKeyDown={
          isActive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onMarcar();
                }
              }
            : undefined
        }
        style={{ cursor: isActive ? "pointer" : "default" }}
        aria-label={isActive ? "Marcar como picado" : undefined}
      >
        {(isPicadoCompleto || isPicadoParcial) && <Icon name="check" size={12} />}
      </div>
      {item.imagem_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.imagem_url}
          alt={item.sku}
          className="wms-thumb wms-thumb-sm"
          loading="lazy"
        />
      ) : (
        <div
          className="wms-thumb wms-thumb-sm"
          style={{
            display: "grid",
            placeItems: "center",
            background: "var(--wms-c-faint)",
          }}
        >
          <Icon name="box" size={16} className="wms-td-mute" />
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <span className="wms-mono" style={{ fontWeight: 600, fontSize: 13 }}>
            {item.sku}
          </span>
          <span className={badgeClass} style={{ fontSize: 10 }}>
            {badgeLabel}
          </span>
          <span
            className="wms-badge wms-badge-warn"
            style={{ fontSize: 10 }}
          >
            Realocada
          </span>
          {r.is_emprestimo && (
            <span
              className="wms-badge"
              style={{
                fontSize: 10,
                background: "var(--wms-c-info-faint, #cffafe)",
                color: "var(--wms-c-info-text, #164e63)",
              }}
            >
              Empréstimo
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, marginTop: 2 }}>
          <span className="wms-hand-item-loc">{r.localizacao_codigo}</span>
          {r.is_emprestimo && r.empresa_nome && (
            <span className="wms-td-mute"> · {r.empresa_nome}</span>
          )}
          <span className="wms-td-mute"> ← de {item.localizacao ?? "sem loc"}</span>
        </div>
      </div>
      <div
        className="wms-mono wms-tar"
        style={{ fontWeight: 700, fontSize: 16 }}
      >
        {r.quantidade}
      </div>
      <div
        className="wms-tar"
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        {isActive && (
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onParcial}
            title="Pegar parcialmente"
            style={{
              color: "var(--wms-c-warn, #b45309)",
              borderColor: "var(--wms-c-warn, #b45309)",
            }}
          >
            Parcial
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Atualizar `parcialModal` state pra suportar isRealocacao**

Substituir tipo do state (linha ~179):

```tsx
  const [parcialModal, setParcialModal] = useState<{
    itemId: string;
    isRealocacao: boolean;
    sku: string;
    localizacao: string | null;
    quantidade: number;
    loading: boolean;
  } | null>(null);
```

Atualizar `setParcialModal` call em `ItemRow.onParcial` (linha ~833):

```tsx
                    onParcial={() =>
                      setParcialModal({
                        itemId: firstItemId,
                        isRealocacao: false,
                        sku: p.sku,
                        localizacao: p.localizacao,
                        quantidade: p.quantidade_total,
                        loading: false,
                      })
                    }
```

- [ ] **Step 6: Atualizar `handleParcialConfirm` pra dispatch correto**

Substituir body do fetch (linha ~590):

```tsx
  async function handleParcialConfirm(qtyPega: number, locZerou: boolean) {
    if (!parcialModal) return;
    setParcialModal((prev) => (prev ? { ...prev, loading: true } : null));
    try {
      const body = parcialModal.isRealocacao
        ? { realocacao_id: parcialModal.itemId, quantidade_pega: qtyPega, loc_zerou: locZerou }
        : { pedido_item_id: parcialModal.itemId, quantidade_pega: qtyPega, loc_zerou: locZerou };

      const res = await sisoFetch("/api/wms/separacao/parcial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Erro ao processar parcial");
        setParcialModal(null);
        return;
      }
      if (data.status === "completo") {
        toast.success("Item marcado como completo");
      } else if (data.status === "realocado") {
        const locs = (data.realocacoes ?? [])
          .map((r: Realocacao) => r.localizacao_codigo)
          .join(", ");
        toast.success(
          `${data.realocacoes?.length ?? 0} loc(s) encontrada(s): ${locs}`,
        );
      } else if (data.status === "sem_cobertura") {
        // Task 8: disparar modal encaminhar/OC
        toast.warning("Sem cobertura no galpão — abrindo opções…", {
          duration: 4000,
        });
      } else if (data.status === "aguardando_supervisor") {
        toast.warning("Sem cobertura — pedido voltou pro painel SISO", {
          duration: 6000,
        });
      }
      setParcialModal(null);
      queryClient.invalidateQueries({ queryKey });
    } catch {
      toast.error("Erro de conexão");
      setParcialModal(null);
    }
  }
```

- [ ] **Step 7: Build + lint**

```bash
npm run lint && npm run build 2>&1 | tail -20
```

Esperado: 0 errors.

- [ ] **Step 8: Validação manual visual**

```bash
npm run dev
```

1. Em staging, criar cenário com realocação ativa (parcial em item normal).
2. Confirmar que a linha de realocação aparece com:
   - Checkbox clicável (caso `aguardando_picking`)
   - Botão "Parcial" amarelo à direita
   - Badge "Aguardando" amarelo + "Realocada" amarelo (+ "Empréstimo" cyan se aplica)
3. Clicar "Parcial" → modal abre com SKU + loc da realoc.
4. Confirmar parcial qty<sugerida + loc_zerou → toast informa cascade.

- [ ] **Step 9: Commit**

```bash
git add src/app/wms/separacao/checklist/page.tsx src/app/api/wms/separacao/checklist-items/route.ts
git commit -m "feat(wms/separacao): realocação aceita parcial com mesmo modal do item

RealocacaoRow nova substitui render inline antigo. Mostra todas
realocações (incluindo picado_parcial, picado, cancelado) com badges
semânticos. Botão Parcial aparece em aguardando_picking e usa o mesmo
ParcialModal (com flag isRealocacao no body do POST)."
```

---

## Task 8: Frontend — sem_cobertura dispara modal encaminhar/OC automaticamente

**Files:**
- Modify: `src/app/wms/separacao/checklist/page.tsx`

- [ ] **Step 1: Em `handleParcialConfirm`, chamar `handleEsgotadoPreview` no caso sem_cobertura**

Substituir o bloco `else if (data.status === "sem_cobertura")` (Task 7, Step 6) por:

```tsx
      } else if (data.status === "sem_cobertura") {
        // Cascade falhou — abre modal de encaminhar/OC automaticamente
        setParcialModal(null);
        queryClient.invalidateQueries({ queryKey });
        await handleEsgotadoPreview(parcialModal.sku);
        return;
      }
```

Notar: o `setParcialModal(null)` é movido pra antes do `handleEsgotadoPreview` (que abre seu próprio modal). O `queryClient.invalidateQueries` também precede pra refletir o picking parcial já registrado.

- [ ] **Step 2: Verificar que `handleEsgotadoPreview` ainda existe e funciona**

```bash
grep -n "async function handleEsgotadoPreview" src/app/wms/separacao/checklist/page.tsx
```

Confirmar que existe. Não modificar — mantém comportamento atual (consulta `/api/wms/separacao/produto-esgotado`, abre `EsgotadoModal`).

- [ ] **Step 3: Build + lint**

```bash
npm run lint && npm run build 2>&1 | tail -20
```

Esperado: 0 errors.

- [ ] **Step 4: Validação manual — cenário C do workflow**

1. Staging: criar pedido qty=5, zerar todos os saldos do produto X no galpão (deixar só 2 na loc A1-02).
2. Parcial qty=2 loc_zerou=true em A1-02.
3. Resposta API: `{ status: 'sem_cobertura' }`.
4. Frontend: modal de encaminhar/OC abre imediatamente.
5. Confirmar que mostra galpões alternativos (se houver saldo em outro galpão) + botão "Criar OC".
6. Operador escolhe ação → pedido segue fluxo correspondente.

- [ ] **Step 5: Commit**

```bash
git add src/app/wms/separacao/checklist/page.tsx
git commit -m "feat(wms/separacao): cascade sem cobertura abre modal encaminhar/OC

Quando o sistema esgota cobertura dentro do galpão, frontend dispara
automaticamente o modal de encaminhar/OC (handleEsgotadoPreview) em
vez de só mostrar toast. Operador decide na hora sem precisar voltar
pro painel."
```

---

## Task 9: Atualizar documentação

**Files:**
- Modify: `docs/api-reference-complete.md`
- Modify: `docs/database-schema.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Atualizar `docs/api-reference-complete.md`**

Encontrar a entrada de `POST /api/wms/separacao/parcial`. Substituir/ampliar a descrição:

```markdown
### POST /api/wms/separacao/parcial

Marca item ou realocação como parcial. Modo dual:

**Modo item (qty parcial na loc original):**
```json
{ "pedido_item_id": 123, "quantidade_pega": 2, "loc_zerou": true }
```

**Modo realocação (qty parcial em loc de realocação ativa):**
```json
{ "realocacao_id": "uuid", "quantidade_pega": 2, "loc_zerou": true }
```

Side effects (ambos os modos):
- Gera mov S no ledger pela qty pega (origem `nf_venda` ou `emprestimo`).
- Se loc_zerou e saldo > qty_pega, gera mov S de ajuste `ajuste_pick_zerou` pra delta.
- Marca registro como parcial (item: `separacao_parcial=true`; realoc: `status=picado_parcial`).
- Acumula qty_pega no item pai.
- Se sobra residual: dispara `resolverRealocacao` excluindo loc original + todas locs de realocações do mesmo item; cria novas linhas com `parent_realocacao_id` (modo realoc) ou sem (modo item).

Auth: sessão WMS válida (X-Session-Id).

Resposta:
- `{ status: 'completo' }` — sem residual
- `{ status: 'realocado', realocacoes: [...] }` — cascade criou linhas novas
- `{ status: 'sem_cobertura' }` — modo realoc; frontend abre modal encaminhar/OC
- `{ status: 'aguardando_supervisor', motivo: 'sem_cobertura_total' }` — modo item; pedido marcado `pendente_realocacao`
- 400 — body inválido ou qty > sugerida
- 404 — item/realoc não encontrado
- 409 — item já processado, realoc não-aguardando, ou `posicao_reservada`
```

- [ ] **Step 2: Atualizar `docs/database-schema.md`**

Na entrada de `siso_pedido_item_realocacoes`, atualizar a descrição das colunas. Adicionar:

```
- parent_realocacao_id uuid NULL — FK self-ref. NULL = realocação raiz; não-NULL = nó da chain de cascade.
- quantidade_pega int NULL — qty efetivamente pega (pode ser < quantidade se houve parcial).
- parcial bool DEFAULT false — true se a realocação foi parcial e gerou cascade.
- parcial_motivo text NULL — 'cascade_parcial' | 'cascade_loc_zerou' (legado: 'loc_zerou' na raiz).
- parcial_em timestamptz NULL, parcial_por uuid NULL.
- mov_ajuste_loc_zerou_id uuid NULL — FK ao ajuste 'ajuste_pick_zerou' (se loc zerou).

Status: 'aguardando_picking' | 'picado' | 'picado_parcial' | 'cancelado'.
- 'picado_parcial' (terminal): qty_pega < quantidade, sistema disparou cascade
  (criou descendente OU marcou pedido pendente_realocacao por sem_cobertura).
```

- [ ] **Step 3: Atualizar `CLAUDE.md`**

Na seção "Separation Flow (post-approval)" ou similar, adicionar parágrafo curto:

```markdown
**Realocação cascateável (2026-05-18):** quando uma loc sugerida (original
ou realocação anterior) dá parcial/zerou, o sistema busca automaticamente
a próxima loc no galpão, excluindo todas as locs já tentadas no item. A
chain é rastreada via `siso_pedido_item_realocacoes.parent_realocacao_id`.
Cascade que esgota cobertura dispara o modal encaminhar/OC no frontend
(sem marcar `pendente_realocacao` automaticamente — operador decide).
Spec: `docs/superpowers/specs/2026-05-18-realocacao-cascateavel-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/api-reference-complete.md docs/database-schema.md CLAUDE.md
git commit -m "docs: realocação cascateável no picking

Atualiza api-reference-complete (POST /api/wms/separacao/parcial dual mode),
database-schema (7 cols novas + status picado_parcial) e CLAUDE.md (resumo
do fluxo). Spec completo em docs/superpowers/specs/."
```

---

## Task 10: Validação E2E em staging

**Files:** Nenhum (apenas validação)

- [ ] **Step 1: Reproduzir Cenário A do workflow.html**

Pedido qty=5, A1-02 sistema=5 real=2.
- Parcial qty=2 loc_zerou=true em A1-02.
- Cascade encontra B2-15 (saldo 3).
- Operador marca checkbox da realoc B2-15.
- Item original aparece com "Parcial 5/5", realoc com "Picado".

- [ ] **Step 2: Reproduzir Cenário B do workflow.html**

Pedido qty=5, A1-02 real=2, B2-15 real=1, C4-08 (outra empresa do grupo) real=2+.
- Parcial A1-02 qty=2 loc_zerou.
- Cascade sugere B2-15.
- Parcial B2-15 qty=1 loc_zerou.
- Cascade sugere C4-08 com `is_emprestimo=true`.
- Operador bipa C4-08 → realocação `picado`.
- Verificar no banco que `wms_saldos_devedores()` retorna 2un que NetAir deve a NetParts.

- [ ] **Step 3: Reproduzir Cenário C do workflow.html**

Pedido qty=5, A1-02 real=2, nenhuma outra loc do galpão tem o produto.
- Parcial A1-02 qty=2 loc_zerou.
- Resposta API `{ status: 'sem_cobertura' }`.
- Modal encaminhar/OC abre. Lista galpões alternativos OU oferece OC.

- [ ] **Step 4: Reproduzir caso de regressão — modo item ainda funciona**

Parcial normal num pedido sem cascade necessário. Confirmar que comportamento legado é idêntico.

- [ ] **Step 5: Verificar reconciliação ledger ↔ cache**

```sql
-- Via mcp__supabase__execute_sql
SELECT * FROM wms_detectar_divergencias_estoque() LIMIT 10;
```

Esperado: 0 divergências relacionadas aos produtos testados.

- [ ] **Step 6: Se algum cenário falhou, criar issue no `erros-conhecidos.yaml`**

Adicionar entrada com id, data, source, category, message, cause, fix, files, tags.

---

## Validação final

- [ ] **Step 1: Rodar suite de testes completa**

```bash
npm test -- run 2>&1 | tail -30
```

Esperado: todos os testes passando (incluindo 7 do realocacao-resolver).

- [ ] **Step 2: Build de produção limpo**

```bash
npm run build 2>&1 | tail -30
```

Esperado: 0 errors, 0 warnings novos.

- [ ] **Step 3: Lint sem novos warnings**

```bash
npm run lint 2>&1 | tail -20
```

Esperado: 0 errors.

- [ ] **Step 4: Confirmar todos os commits no histórico**

```bash
git log --oneline -15
```

Esperado: ~10 commits da feature, em ordem lógica.

---

## Out of scope (não fazer agora)

- Migração de dados antigos (`siso_pedido_item_realocacoes` legacy sem `parent_realocacao_id`) — campo é nullable e fluxo antigo continua funcionando.
- Refatorar `marcar-realocacao/route.ts` — segue como está pro caso "peguei tudo conforme sugerido".
- DELETE de realocação com cascade automático — manter comportamento atual (sem disparo de busca; só marca `cancelado`).
- UX da tela de supervisor pra `pendente_realocacao` — fora do escopo deste plano.
- Testes de route handler (não há padrão no projeto). Validação manual em staging é o gating.
