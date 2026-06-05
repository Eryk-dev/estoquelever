# Acerto de prateleira no pick — Implementation Plan (Fase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No `Encontrei` de item OC, deixar o operador **contar quantas unidades tem na prateleira** e usar essa contagem como verdade — acertando o saldo no ledger (`inventario_ganho`/`inventario_perda`), registrando contagem oficial (acuracidade + última contagem), e separando o pedido — em vez de materializar cegamente só a quantidade pedida.

**Architecture:** Reaproveita as **tabelas** de inventário (`siso_inventario_contagens`, `siso_inventario_divergencias`, `siso_inventario_localizacoes`) + as métricas (`wms_metricas_operador`/`_localizacao`) + o `ultima_contagem_em`, **sem** a máquina de estados de sessão. A contagem inline se aplica direto no ledger e grava as linhas de relatório numa **sessão operacional contínua por galpão** (`continua=true`), nunca passando por aprovação. Spec: `docs/superpowers/specs/2026-06-01-acerto-prateleira-pick-design.md`.

**Tech Stack:** Next.js 16 App Router (route handler), Supabase (Postgres + RPC `wms_inserir_movimentacao`), TypeScript, harness de cenários em `scripts/wms/cenarios/` (tsx + `npm run scenarios`). Ambiente: staging `ehbxpbeijofxtsbezwxd`.

**Escopo Fase 1 (este plano):** só o gatilho `Encontrei` (OC), e só o caso **`qty_contada ≥ quantidade_pedida`** (operador achou pelo menos o que o pedido precisa). `qty_contada < pedido` retorna 422 guiando pro fluxo Esgotado — tratado numa fase futura. As Fases 2 (Parcial "loc zerou") e 3 (Solicitar contagem + fila + montar ciclo) viram planos próprios.

---

## ⚠ CORREÇÕES descobertas na execução (2026-06-01) — leia ANTES das Tasks 2-4

A análise que gerou este plano leu **arquivos de migration** (stale) em vez do schema vivo. O staging real (verificado via `information_schema`) difere em 3 pontos. **Onde o código abaixo conflitar com isto, isto vence:**

1. **3D dropou `empresa_dona_id`.** `siso_inventario_contagens` e `siso_inventario_divergencias` **não têm** `empresa_dona_id`. No helper (Task 3): NÃO gravar `empresa_dona_id`; remover o param `empresa_origem_id`. Unique real de divergências = `(sessao_id, localizacao_id, produto_id)` → upsert `onConflict: "sessao_id,localizacao_id,produto_id"`.
2. **`siso_inventario_contagens` só tem PK (`id`)** — sem unique com `contada_por`. A contagem é um **INSERT simples por evento** (sem `onConflict`). Cada contagem inline = 1 linha (correto para `COUNT(DISTINCT c.id)` da acuracidade).
3. **A loc bipada NÃO é persistida** (snapshot `siso_pedido_item_estoques` removido da rota). Então: (a) a rota (Task 4) resolve a loc-alvo de `localizacao_id` (uuid) **OU** `localizacao_codigo` (string, dentro do galpão do pedido); (b) o cenário 71 (Task 2) passa o **`localizacao_id` REAL** da A-06-01 (não o galpão id); (c) o frontend (Task 5) passa `localizacao_codigo` (o código bipado) + `qty_contada`.
4. **Acuracidade (D2) já corrigida fora desta fatia:** `wms_metricas_operador` estava quebrada (JOIN em `empresa_dona` dropada) e foi migrada pra 3D (commit `634a039`, migration `20260601b_metricas_operador_3d.sql`). NÃO mexer nela.
5. **Cenário 63 (`encontrei-sem-cadastro`) está VERMELHO no baseline** (pré-existente: o `run()` dele não envia `localizacao_id` e a rota responde `produto_sem_cadastro` 422, pois o snapshot foi removido). **NÃO** é critério de aceite; é bug pré-existente da rota legada. O aceite é **só o cenário 71 verde**.

> O código das Tasks 3 e 4 abaixo está escrito com as suposições antigas (empresa_dona/snapshot). Use a versão corrigida fornecida no prompt do implementador. Demais partes (estrutura, fases, intenção) seguem válidas.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `supabase/migrations/20260601_acerto_prateleira_pick.sql` | Coluna `continua` em `siso_inventario_sessoes` + índice único 1-por-galpão | Create |
| `src/lib/wms/contagem-inline.ts` | Helper puro de I/O: get-or-create sessão operacional + reconcilia loc no ledger + grava contagem/divergência oficiais | Create |
| `src/app/api/wms/separacao/validar-oc-item/route.ts` | `encontrei` passa a aceitar `qty_contada` e, quando presente, reconcilia a loc + registra contagem antes do pick | Modify (`:29-31`, `:126-259`) |
| `src/app/wms/separacao/checklist/page.tsx` | `OcEncontreiModal` ganha campo "Quantas tem aqui?"; `handleOcEncontreiFinalizar` passa `qty_contada` | Modify (`:581-646`, `:1794-1887`) |
| `scripts/wms/cenarios/catalogo/71-encontrei-contagem-inline.ts` | Cenário E2E do caminho feliz (achou 8, pedido pede 5 → sobra 3 + contagem oficial) | Create |
| `scripts/wms/cenarios/run-all.ts` | Registrar o cenário 71 | Modify |
| `docs/api-reference-complete.md` | Documentar `qty_contada` no `validar-oc-item` | Modify |
| `docs/database-schema.md` | Documentar coluna `continua` | Modify |

---

## Task 1: Migration — coluna `continua` + índice 1-por-galpão

**Files:**
- Create: `supabase/migrations/20260601_acerto_prateleira_pick.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Acerto de prateleira no pick (Fase 1)
-- Marca a sessão de inventário "operacional contínua" por galpão, que hospeda
-- as contagens inline aplicadas na hora (fora do ciclo planejada→aprovada→aplicada).

ALTER TABLE siso_inventario_sessoes
  ADD COLUMN IF NOT EXISTS continua boolean NOT NULL DEFAULT false;

-- No máximo 1 sessão contínua por galpão (get-or-create idempotente).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sessao_continua_galpao
  ON siso_inventario_sessoes (galpao_id)
  WHERE continua;

COMMENT ON COLUMN siso_inventario_sessoes.continua IS
  'Sessão operacional contínua (1 por galpão) que hospeda contagens inline do pick (acerto de prateleira). Nunca passa por aprovação em bloco.';
```

- [ ] **Step 2: Aplicar no staging**

Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` com `name="20260601_acerto_prateleira_pick"` e o SQL acima.

- [ ] **Step 3: Verificar a coluna existe**

Rodar via `mcp__supabase__execute_sql` no project `ehbxpbeijofxtsbezwxd`:
```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'siso_inventario_sessoes' AND column_name = 'continua';
```
Esperado: 1 linha, `boolean`, default `false`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260601_acerto_prateleira_pick.sql
git commit -m "feat(wms): coluna continua p/ sessao operacional de contagem inline"
```

---

## Task 2: Cenário E2E (failing) — contagem inline no Encontrei OC

Escrevemos o teste primeiro (TDD). Ele vai falhar porque `validar-oc-item` ainda ignora `qty_contada` e o helper não existe.

**Files:**
- Create: `scripts/wms/cenarios/catalogo/71-encontrei-contagem-inline.ts`
- Modify: `scripts/wms/cenarios/run-all.ts`

- [ ] **Step 1: Escrever o cenário** (espelha o `63-encontrei-sem-cadastro.ts`)

```typescript
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "71 — Encontrei com contagem inline acerta a prateleira",
  descricao:
    "Item OC, sistema achava 0 na loc. Operador conta 8 (pedido pede 5). " +
    "Sistema gera Entrada inventario_ganho (+8), separa 5 (Saída nf_venda), " +
    "sobram 3 reais na loc. A contagem vira oficial: linha em contagens + " +
    "divergência aplicada + última contagem atualizada.",
  tags: ["separacao", "validar-oc", "encontrei", "contagem-inline", "fase1"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("71");
    await ctx.criarProduto({ sku, descricao: "Contagem inline 71" });
    await ctx.criarLocalizacao({ galpao: "CWB", codigo: "A-06-01" });
    return { sku };
  },

  run: async (ctx: Ctx, { sku }: { sku: string }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 5 }],
    });
    // Sem saldo → força pendente + aprova OC pra entrar em validacao_oc.
    await ctx.sb
      .from("siso_pedidos")
      .update({ status: "pendente" })
      .eq("id", pedido.id);
    await ctx.aprovar(pedido.id, "oc");

    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, produto_id")
      .eq("pedido_id", pedido.id)
      .eq("sku", sku)
      .single();

    // Bipe da loc (modal "onde você achou")
    await ctx.http.post("/api/wms/separacao/localizacao", {
      produto_id: Number(itemRow!.produto_id),
      localizacao: "A-06-01",
      empresa_id: ctx.staging.empresas.netair.id,
      galpao_id: ctx.staging.galpoes.cwb.id,
    });

    // Operador conta 8 e confirma → validar-oc-item com qty_contada
    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: [String(itemRow!.id)],
      acao: "encontrei",
      localizacao_id: ctx.staging.galpoes.cwb.id, // ignorado se loc já no snapshot; ver nota
      qty_contada: 8,
    });
  },

  assertEsperado: async (ctx: Ctx, { sku }: { sku: string }) => {
    // Sobra 3 = 8 contados − 5 separados
    await ctx.assertSaldo(sku, "CWB", "A-06-01", 3);

    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();

    // Movs: Entrada inventario_ganho (+8) + Saída nf_venda (−5)
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("tipo, quantidade, origem_tipo")
      .eq("produto_id", produto!.id);
    const ganho = (movs ?? []).find(
      (m) => m.tipo === "E" && m.origem_tipo === "inventario_ganho",
    );
    const saida = (movs ?? []).find(
      (m) => m.tipo === "S" && m.origem_tipo === "nf_venda",
    );
    if (!ganho) throw new Error("esperava mov E inventario_ganho");
    if (Number(ganho.quantidade) !== 8) {
      throw new Error(`ganho qty esperava 8, recebi ${ganho.quantidade}`);
    }
    if (!saida) throw new Error("esperava mov S nf_venda");
    if (Number(saida.quantidade) !== 5) {
      throw new Error(`saída qty esperava 5, recebi ${saida.quantidade}`);
    }

    // Contagem oficial registrada na sessão contínua do galpão
    const { data: sessao } = await ctx.sb
      .from("siso_inventario_sessoes")
      .select("id")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("continua", true)
      .maybeSingle();
    if (!sessao) throw new Error("esperava sessão operacional contínua do galpão");

    const { data: contagem } = await ctx.sb
      .from("siso_inventario_contagens")
      .select("qty_contada")
      .eq("sessao_id", sessao.id)
      .eq("produto_id", produto!.id)
      .maybeSingle();
    if (!contagem) throw new Error("esperava linha em siso_inventario_contagens");
    if (Number(contagem.qty_contada) !== 8) {
      throw new Error(`contagem esperava 8, recebi ${contagem.qty_contada}`);
    }

    const { data: div } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("status, qty_contada_final, saldo_sistema")
      .eq("sessao_id", sessao.id)
      .eq("produto_id", produto!.id)
      .maybeSingle();
    if (!div) throw new Error("esperava divergência aplicada");
    if (div.status !== "aplicada") {
      throw new Error(`divergência status esperava 'aplicada', recebi ${div.status}`);
    }

    // Última contagem da loc atualizada
    const { data: loc } = await ctx.sb
      .from("siso_localizacoes")
      .select("ultima_contagem_em")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("codigo", "A-06-01")
      .single();
    if (!loc?.ultima_contagem_em) {
      throw new Error("esperava ultima_contagem_em preenchido na loc");
    }
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

const _isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
```

> **Nota sobre `localizacao_id`:** o `validar-oc-item` resolve a loc do produto via `/separacao/localizacao` (chamado antes). O campo `localizacao_id` no body é o fallback "loc bipada". Como o cenário já salva a loc via `/separacao/localizacao`, o helper de contagem deve resolver a loc onde o saldo será criado. Na Task 4 garantimos que, com `qty_contada` presente, a loc-alvo é a loc bipada/salva (a mesma A-06-01).

- [ ] **Step 2: Registrar no run-all.ts**

Abrir `scripts/wms/cenarios/run-all.ts`, localizar o array/import de cenários do catálogo e adicionar o import do `71-encontrei-contagem-inline` no mesmo padrão dos vizinhos (ex.: como o `26-validar-oc-encontrei-mov` ou `63-encontrei-sem-cadastro` são registrados). Seguir exatamente o padrão existente do arquivo.

- [ ] **Step 3: Rodar o cenário isolado e ver FALHAR**

Run: `npx tsx scripts/wms/cenarios/catalogo/71-encontrei-contagem-inline.ts`
Esperado: FALHA — `assertSaldo` espera 3 mas hoje a loc fica 0 (comportamento legado materializa só 5), e não há linha de contagem/divergência nem sessão `continua`.

- [ ] **Step 4: Commit do teste**

```bash
git add scripts/wms/cenarios/catalogo/71-encontrei-contagem-inline.ts scripts/wms/cenarios/run-all.ts
git commit -m "test(wms): cenario 71 — contagem inline no encontrei OC (failing)"
```

---

## Task 3: Helper `registrarContagemInline`

Helper de I/O isolado: get-or-create da sessão operacional contínua + reconciliação no ledger + gravação de contagem/divergência oficiais + atualização de última contagem.

**Files:**
- Create: `src/lib/wms/contagem-inline.ts`

- [ ] **Step 1: Escrever o helper**

```typescript
import { randomUUID } from "crypto";
import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { logger } from "@/lib/logger";

const NOME_SESSAO_OPERACIONAL = "Contagens operacionais";

export interface ContagemInlineInput {
  /** uuid WMS do produto (já resolvido via resolverProdutoWms) */
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
  /** N — total que o operador contou nessa loc pra esse SKU */
  qty_contada: number;
  /** usado como empresa_dona tag (3D legacy) pra casar o JOIN das métricas */
  empresa_origem_id: string | null;
  /** operador que contou */
  contada_por: string;
  sku?: string;
  pedido_id?: string;
}

export interface ContagemInlineResult {
  sessao_id: string;
  contagem_id: string;
  divergencia_id: string;
  mov_reconciliacao_id: string | null;
  saldo_anterior: number;
  delta: number;
}

/**
 * Get-or-create da sessão operacional contínua do galpão. Idempotente sob
 * corrida graças ao índice único parcial uniq_sessao_continua_galpao.
 */
async function getOrCreateSessaoOperacional(
  sb: ReturnType<typeof createServiceClient>,
  galpao_id: string,
  criada_por: string,
): Promise<string> {
  const { data: existente } = await sb
    .from("siso_inventario_sessoes")
    .select("id")
    .eq("galpao_id", galpao_id)
    .eq("continua", true)
    .maybeSingle();
  if (existente) return (existente as { id: string }).id;

  const { data, error } = await sb
    .from("siso_inventario_sessoes")
    .insert({
      tipo: "cycle_count",
      galpao_id,
      modo_contagem: "aberto",
      nome: NOME_SESSAO_OPERACIONAL,
      status: "em_andamento",
      continua: true,
      criada_por,
      iniciada_em: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // Corrida: outro request criou no intervalo — re-busca.
    const { data: again } = await sb
      .from("siso_inventario_sessoes")
      .select("id")
      .eq("galpao_id", galpao_id)
      .eq("continua", true)
      .maybeSingle();
    if (again) return (again as { id: string }).id;
    throw new Error(`getOrCreateSessaoOperacional: ${error.message}`);
  }
  return (data as { id: string }).id;
}

/**
 * Registra uma contagem feita pelo operador na frente da prateleira como
 * contagem OFICIAL, aplicada na hora:
 *  - reconcilia o saldo da loc pro número contado (inventario_ganho/perda);
 *  - grava linha em siso_inventario_contagens (acuracidade + nº de contagens);
 *  - faz upsert da divergência (status='aplicada', mov_aplicada_id);
 *  - garante a loc como membro da sessão + atualiza ultima_contagem_em.
 *
 * NÃO faz o pick do pedido — isso é responsabilidade do caller (pickMovPicking).
 * Idempotência da AÇÃO de pick fica a cargo do caller (mov_saida_id); aqui o
 * divergencia_id da mov é uma chave por-evento (randomUUID) só pra satisfazer
 * o índice uniq_movs_inventario_divergencia sem colidir entre contagens.
 */
export async function registrarContagemInline(
  input: ContagemInlineInput,
): Promise<ContagemInlineResult> {
  const sb = createServiceClient();

  const sessaoId = await getOrCreateSessaoOperacional(
    sb,
    input.galpao_id,
    input.contada_por,
  );

  // Saldo atual na loc (0 se não existe linha)
  const { data: estoqueRow } = await sb
    .from("siso_estoque")
    .select("saldo")
    .eq("produto_id", input.produto_id)
    .eq("galpao_id", input.galpao_id)
    .eq("localizacao_id", input.localizacao_id)
    .maybeSingle();
  const saldo = Number((estoqueRow as { saldo?: number } | null)?.saldo ?? 0);
  const delta = input.qty_contada - saldo;

  // Reconciliação no ledger (só se há divergência)
  let movId: string | null = null;
  if (delta !== 0) {
    const mov = await inserirMovimentacao({
      tripla: {
        produto_id: input.produto_id,
        galpao_id: input.galpao_id,
        localizacao_id: input.localizacao_id,
      },
      tipo: delta > 0 ? "E" : "S",
      qty: Math.abs(delta),
      origem_tipo: delta > 0 ? "inventario_ganho" : "inventario_perda",
      origem_id: sessaoId,
      origem_detalhes: {
        divergencia_id: randomUUID(), // chave por-evento p/ índice único de movs
        contexto: "acerto_pick",
        sku: input.sku,
        pedido_id: input.pedido_id,
      },
      motivo: "Acerto de prateleira no pick",
      usuario_id: input.contada_por,
    });
    movId = mov.id;
  }

  // Garante a loc como membro da sessão (metrica_localizacao lê daqui)
  await sb
    .from("siso_inventario_localizacoes")
    .upsert(
      {
        sessao_id: sessaoId,
        localizacao_id: input.localizacao_id,
        status: "contada",
        motivo: "manual",
      },
      { onConflict: "sessao_id,localizacao_id" },
    );

  // Contagem oficial (UNIQUE sessao,loc,produto,contada_por)
  const { data: contagem, error: cErr } = await sb
    .from("siso_inventario_contagens")
    .upsert(
      {
        sessao_id: sessaoId,
        localizacao_id: input.localizacao_id,
        produto_id: input.produto_id,
        empresa_dona_id: input.empresa_origem_id,
        qty_contada: input.qty_contada,
        contada_por: input.contada_por,
      },
      { onConflict: "sessao_id,localizacao_id,produto_id,contada_por" },
    )
    .select("id")
    .single();
  if (cErr) throw new Error(`registrarContagemInline contagem: ${cErr.message}`);

  // Divergência aplicada (UNIQUE sessao,loc,produto,empresa_dona)
  const { data: div, error: dErr } = await sb
    .from("siso_inventario_divergencias")
    .upsert(
      {
        sessao_id: sessaoId,
        localizacao_id: input.localizacao_id,
        produto_id: input.produto_id,
        empresa_dona_id: input.empresa_origem_id,
        saldo_sistema: saldo,
        qty_contada_final: input.qty_contada,
        status: "aplicada",
        mov_aplicada_id: movId,
        resolucao_por: input.contada_por,
        resolucao_em: new Date().toISOString(),
      },
      { onConflict: "sessao_id,localizacao_id,produto_id,empresa_dona_id" },
    )
    .select("id")
    .single();
  if (dErr) throw new Error(`registrarContagemInline divergencia: ${dErr.message}`);

  // Última contagem da loc (explícito — não dependemos do trigger AFTER INSERT,
  // que não dispara no ramo UPDATE do upsert de contagens).
  await sb
    .from("siso_localizacoes")
    .update({ ultima_contagem_em: new Date().toISOString() })
    .eq("id", input.localizacao_id);

  logger.info("contagem-inline", "acerto de prateleira registrado", {
    sessao_id: sessaoId,
    produto_id: input.produto_id,
    loc_id: input.localizacao_id,
    saldo_anterior: saldo,
    contado: input.qty_contada,
    delta,
    mov_id: movId,
  });

  return {
    sessao_id: sessaoId,
    contagem_id: (contagem as { id: string }).id,
    divergencia_id: (div as { id: string }).id,
    mov_reconciliacao_id: movId,
    saldo_anterior: saldo,
    delta,
  };
}
```

- [ ] **Step 2: Compilar (typecheck do arquivo)**

Run: `npx tsc --noEmit` (ou `npm run build` se preferir)
Esperado: sem erros de tipo no novo arquivo. Se `inserirMovimentacao` retornar tipo sem `.id`, ajustar o acesso (ver `src/lib/wms/types.ts` `Movimentacao`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/contagem-inline.ts
git commit -m "feat(wms): helper registrarContagemInline (acerto de prateleira)"
```

---

## Task 4: Wire `qty_contada` no `validar-oc-item`

Quando o body trouxer `qty_contada`, o `encontrei` reconcilia a loc pro número contado (via helper) e separa o pedido a partir dela — em vez do `E ajuste_manual` cego do tamanho do pedido.

**Files:**
- Modify: `src/app/api/wms/separacao/validar-oc-item/route.ts`

- [ ] **Step 1: Parsear `qty_contada` no topo do POST**

Logo após `const acao: unknown = body?.acao;` (linha ~31), adicionar:

```typescript
  // Fase 1 acerto-de-prateleira: contagem inline opcional. Quando presente,
  // o "encontrei" reconcilia a loc pro número contado e registra contagem
  // oficial, em vez de materializar cegamente a quantidade do pedido.
  const qtyContadaBody =
    typeof body?.qty_contada === "number" && Number.isFinite(body.qty_contada)
      ? Math.trunc(body.qty_contada)
      : null;
```

- [ ] **Step 2: Importar o helper**

No bloco de imports do topo (junto de `import { pickMovPicking } ...`):

```typescript
import { registrarContagemInline } from "@/lib/wms/contagem-inline";
```

- [ ] **Step 3: Inserir o ramo de contagem inline dentro do loop `encontrei`**

Dentro do `for (const item of itensFull ?? [])`, no bloco `if (!jaPicado && ctx && ctx.galpao && ctx.empresa)`, **antes** do bloco `if (semSaldo) { ... }` (linha ~154), inserir o ramo que trata `qtyContadaBody`. A loc-alvo é a loc bipada (`locManualBody`) — exigida quando há contagem inline:

```typescript
          if (qtyContadaBody !== null) {
            // ─── Caminho contagem inline (Fase 1) ───
            // Fase 1: só cobre contagem >= pedido (achou pelo menos o necessário).
            if (qtyContadaBody < qty) {
              return NextResponse.json(
                {
                  error: "contagem_menor_que_pedido",
                  message:
                    "Contou menos do que o pedido pede. Use 'Esgotado' pra mandar o restante pra compra.",
                  item_id: item.id,
                  qty_contada: qtyContadaBody,
                  qty_pedido: qty,
                },
                { status: 422 },
              );
            }
            // Loc bipada é obrigatória pra contagem inline.
            if (!locManualBody) {
              return NextResponse.json(
                {
                  error: "loc_obrigatoria",
                  message: "Bipe a localização onde contou o item.",
                  item_id: item.id,
                },
                { status: 422 },
              );
            }
            const { data: locC } = await supabase
              .from("siso_localizacoes")
              .select("id, galpao_id")
              .eq("id", locManualBody)
              .maybeSingle();
            if (!locC || locC.galpao_id !== ctx.galpao) {
              return NextResponse.json(
                {
                  error: "loc_invalida",
                  message: "Localização não pertence ao galpão do pedido",
                },
                { status: 422 },
              );
            }
            try {
              await registrarContagemInline({
                produto_id: produtoWmsId,
                galpao_id: ctx.galpao,
                localizacao_id: locManualBody,
                qty_contada: qtyContadaBody,
                empresa_origem_id: ctx.empresa,
                contada_por: user.id,
                sku: String(item.sku),
                pedido_id: String(item.pedido_id),
              });
            } catch (contErr) {
              logger.logError({
                error: contErr instanceof Error ? contErr : new Error(String(contErr)),
                source: "validar-oc-item",
                message: "Falhou registrar contagem inline",
                category: "business_logic",
                metadata: { item_id: item.id, sku: item.sku, loc_id: locManualBody },
              });
              return NextResponse.json(
                { error: "falhou_contagem_inline", message: "Não foi possível registrar a contagem" },
                { status: 500 },
              );
            }

            // Pick normal: a loc agora tem saldo >= qty (acabamos de reconciliar).
            try {
              const result = await pickMovPicking({
                empresa_origem_id: ctx.empresa,
                galpao_id: ctx.galpao,
                pedido_id: String(item.pedido_id),
                pedido_numero: ctx.numero,
                item_id: Number(item.id),
                produto_id_tiny: String(item.produto_id),
                sku: String(item.sku),
                qty,
                usuario_id: user.id,
                contexto: "encontrei_oc",
              });
              movSaidaId = result?.movSaidaId ?? null;
            } catch (movErr) {
              logger.warn("validar-oc-item", "pickMovPicking falhou em encontrei (inline)", {
                item_id: item.id,
                error: movErr instanceof Error ? movErr.message : String(movErr),
              });
            }
            // Pula o caminho legado semSaldo + pick abaixo.
            // (Atualização de campos do item segue normalmente fora deste if.)
          } else {
```

E fechar esse `else {` envolvendo o bloco legado existente (`const semSaldo = ...` até o `pickMovPicking` legado, linhas ~152-258), de modo que o caminho legado só rode quando `qtyContadaBody === null`. Fechar o `else` com `}` logo após o `pickMovPicking` legado (antes de `}` que fecha o `if (!jaPicado ...)`).

> **Cuidado de edição:** o `produtoWmsId` é resolvido dentro do bloco legado hoje (linha ~141). Mover a resolução de `produtoWmsId` pra **antes** do `if (qtyContadaBody !== null)` (logo no início do `if (!jaPicado && ctx ...)`), pois os dois ramos precisam dele. O bloco fica:
> ```
> const qty = Number(item.quantidade_pedida ?? 0);
> const produtoWmsId = await resolverProdutoWms(ctx.empresa, String(item.produto_id));
> if (qtyContadaBody !== null) { /* inline */ } else { /* legado: semSaldo + E ajuste_manual + pick */ }
> ```

- [ ] **Step 4: Rodar o cenário 71 e ver PASSAR**

Run: `npx tsx scripts/wms/cenarios/catalogo/71-encontrei-contagem-inline.ts`
Esperado: PASS — saldo final 3, mov `inventario_ganho` (+8), mov `nf_venda` (−5), contagem + divergência aplicada na sessão contínua, `ultima_contagem_em` setado.

- [ ] **Step 5: Rodar o cenário irmão pra garantir não-regressão**

Run: `npx tsx scripts/wms/cenarios/catalogo/63-encontrei-sem-cadastro.ts`
Esperado: PASS — o caminho legado (sem `qty_contada`) segue gerando `E ajuste_manual achado` + `S nf_venda`, loc fica 0.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/wms/separacao/validar-oc-item/route.ts
git commit -m "feat(wms): encontrei OC aceita qty_contada e acerta a prateleira na hora"
```

---

## Task 5: Frontend — campo de contagem no `OcEncontreiModal`

O modal ganha um campo "Quantas unidades tem aqui?" antes do bipe da loc; ao confirmar, passa `qty_contada` pro endpoint. Mantemos a quantidade do pedido visível como referência.

**Files:**
- Modify: `src/app/wms/separacao/checklist/page.tsx` (`OcEncontreiModal` `:1794-1887`, `handleOcEncontreiFinalizar` `:581-646`)

- [ ] **Step 1: `OcEncontreiModal` — adicionar estado de quantidade + passar pro onConfirmar**

Trocar a assinatura `onConfirmar: (codigoLoc: string) => void` por `onConfirmar: (codigoLoc: string, qtyContada: number) => void`, e adicionar um input numérico. Dentro do componente, antes do `HandheldScan`:

```tsx
  const [qtdContada, setQtdContada] = useState<string>("");

  function handleSubmit(codigo: string) {
    if (!codigo.trim()) {
      setFeedback({ text: "Código vazio", tone: "warn" });
      return;
    }
    const n = Number(qtdContada);
    if (!qtdContada.trim() || !Number.isFinite(n) || n <= 0) {
      setFeedback({ text: "Informe quantas unidades tem na prateleira", tone: "warn" });
      return;
    }
    if (n < produto.quantidade_total) {
      setFeedback({
        text: `Contou ${n}, mas o pedido pede ${produto.quantidade_total}. Use "Esgotado" pro restante.`,
        tone: "warn",
      });
      return;
    }
    setFeedback({ text: `Salvando ${codigo.trim()}…`, tone: "neutral" });
    onConfirmar(codigo.trim(), n);
  }
```

E o campo, logo abaixo do bloco "QTD A SEPARAR" (antes do `<HandheldScan ...>`):

```tsx
          <label
            className="wms-td-mute"
            style={{ fontSize: 10.5, letterSpacing: 1, display: "block", marginBottom: 4 }}
          >
            QUANTAS UNIDADES TEM NESSA PRATELEIRA?
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={qtdContada}
            onChange={(e) => setQtdContada(e.target.value)}
            placeholder={`mínimo ${produto.quantidade_total}`}
            disabled={bipando}
            className="wms-input"
            style={{ width: "100%", marginBottom: 12, fontSize: 18, textAlign: "center" }}
          />
```

> Use a classe de input existente do shell WMS (verifique o nome real — ex. `wms-input`/`wms-md-input` — em `src/app/wms/wms.css` ou em outros modais como `parcial-modal.tsx`). Não criar CSS novo.

- [ ] **Step 2: `handleOcEncontreiFinalizar` — receber e passar `qty_contada`**

Trocar a assinatura `async function handleOcEncontreiFinalizar(codigoLoc: string)` por `async function handleOcEncontreiFinalizar(codigoLoc: string, qtyContada: number)`, e no `body` do POST `/validar-oc-item` (linha ~614) adicionar `qty_contada`:

```typescript
        body: JSON.stringify({
          item_ids: produto.item_ids,
          acao: "encontrei",
          qty_contada: qtyContada,
        }),
```

> O `/separacao/localizacao` (chamado antes, linha ~592) já salva a loc bipada; o backend usa essa loc como alvo da contagem. Se for necessário passar a loc explicitamente, incluir `localizacao_id` resolvido — mas o fluxo atual já resolve via snapshot, então não mexer aqui salvo se a Task 4 exigir.

- [ ] **Step 3: Verificar a chamada do modal**

Onde `<OcEncontreiModal ... onConfirmar={handleOcEncontreiFinalizar} />` é renderizado, garantir que a nova assinatura `(codigoLoc, qtyContada)` casa. Como passamos a referência direta, casa automaticamente.

- [ ] **Step 4: Verificação visual no app**

Rodar `npm run dev`, abrir `/wms/separacao/checklist` com um pedido OC, clicar "Encontrei", confirmar que: aparece o campo "Quantas unidades tem nessa prateleira?", o submit exige número ≥ quantidade do pedido, e ao confirmar o item some da seção OC. (Sem screenshot automatizado — verificação manual.)

- [ ] **Step 5: Commit**

```bash
git add src/app/wms/separacao/checklist/page.tsx
git commit -m "feat(wms): modal Encontrei pede contagem da prateleira"
```

---

## Task 6: Documentação

**Files:**
- Modify: `docs/api-reference-complete.md`
- Modify: `docs/database-schema.md`

- [ ] **Step 1: Documentar `qty_contada` no `validar-oc-item`**

Na entrada de `POST /api/wms/separacao/validar-oc-item` em `docs/api-reference-complete.md`, adicionar ao request body:
```
- qty_contada (number, opcional): quando acao='encontrei', total contado pelo operador na loc bipada. Reconcilia o saldo da loc (inventario_ganho/perda), registra contagem oficial (acuracidade + última contagem) e separa o pedido. Exige qty_contada ≥ quantidade_pedida (senão 422 contagem_menor_que_pedido). Ausente = comportamento legado (materializa a quantidade do pedido).
```

- [ ] **Step 2: Documentar coluna `continua`**

Em `docs/database-schema.md`, na tabela `siso_inventario_sessoes`, adicionar a coluna `continua boolean DEFAULT false` — "marca a sessão operacional contínua (1 por galpão, índice único parcial) que hospeda contagens inline do pick".

- [ ] **Step 3: Commit**

```bash
git add docs/api-reference-complete.md docs/database-schema.md
git commit -m "docs(wms): qty_contada no validar-oc-item + coluna continua"
```

---

## Self-Review (preenchido)

**1. Spec coverage (Fase 1):**
- §5.1 "Contei N" (OC) → Tasks 3+4 (helper + route). ✓
- §6 movs `E inventario_ganho` → `S nf_venda` → Task 3 (helper) + Task 4 (pick). ✓
- §7 modelo de dados (coluna `continua`, UPSERT divergência, convenção `empresa_dona`) → Task 1 + Task 3. ✓
- §8 contagem oficial (contagens + divergencia + ultima_contagem) → Task 3. ✓
- §10 UX modal → Task 5. ✓
- §11 borda N=Q → Task 2 testa (8≥5; N=Q também passa pelo mesmo caminho). N<Q → 422 (limite Fase 1, documentado). ✓
- **Fora da Fase 1 (planos próprios):** §5.2 Parcial (Fase 2), §9 Solicitar/fila (Fase 3). Marcado no header.

**2. Placeholder scan:** sem TBD/TODO funcionais. Os "verifique o nome da classe CSS" e "siga o padrão do run-all" são instruções de fidelidade ao código existente, não placeholders de lógica.

**3. Type consistency:** `registrarContagemInline(input: ContagemInlineInput)` — mesmo nome e shape na Task 3 (definição) e Task 4 (uso). `qty_contada` é o nome do campo no body (Tasks 2, 4, 5) e `qtyContadaBody` a variável parseada (Task 4). `onConfirmar(codigoLoc, qtyContada)` consistente entre modal e handler (Task 5).

---

## Próximas fases (planos próprios, após Fase 1 validada)

- **Fase 2 — Parcial "loc zerou":** reframe do checkbox pra "quanto sobrou?" (0 / N / não sei), caminho "sobrou N" reconciliando a loc, e registro de contagem oficial no caminho "zerou" (mantendo o `ajuste_pick_zerou` atual). Spec §5.2.
- **Fase 3 — Solicitar contagem + fila + montar ciclo:** botão "solicitar" nos dois modais → loc `pendente motivo='solicitada_pick'` na sessão contínua; ação supervisor "montar ciclo de recontagem" → cria sessão `cycle_count` discreta. Spec §9.
- **Pendência Fase 1 → futura:** tratar `qty_contada < pedido` (achou menos) integrando com a cascade de realocação / esgotado, em vez do 422.
