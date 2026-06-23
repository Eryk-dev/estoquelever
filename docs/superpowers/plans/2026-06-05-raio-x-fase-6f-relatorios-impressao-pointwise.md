# Raio-X Fase 6f — Relatórios, Impressão e Bugs Pontuais de Cadastro Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal:** Corrigir 16 problemas de baixo blast-radius do raio-x SISO/WMS, agrupados em 3 PRs coesos: (1) o relatório de movimentações por empresa (default 12m + paginação 5k + filtro de empresa no SQL + excluir devoluções), (2) etiqueta/impressão (retry 3x na reimpressão, imprimir as 2 labels, retenção 30d, invalidar cache PrintNode na escrita, preview de impacto ao deletar conta), e (3) bugs pontuais de cadastro (lead default 7d na cobertura, qty inteira na transferência, tipo `packing` no type/rota/form, SKU duplicado 409, reativar vínculo de fornecedor no reimport, bloquear delete de fornecedor/galpão com vínculos, kit qty componente ≥ 1).

**Architecture:** App Next.js 16 (App Router, `output: "standalone"`) sobre Supabase (service role, bypassa RLS). Backend em `/api/wms/**/route.ts`; frontend em `/wms/**` (todos `use client`). Ledger de estoque 3D imutável (`siso_movimentacoes`) com cache materializado (`siso_estoque`) e MV de cobertura (`siso_cobertura_estoque`). Trabalha-se **exclusivamente em staging** (Supabase project `ehbxpbeijofxtsbezwxd`). Migrations: arquivo em `supabase/migrations/YYYYMMDD_*.sql` + aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`.

**Tech Stack:** Next.js 16.1.6 · React 19 · TypeScript 5.9 (strict) · Supabase JS · Vitest (unit happy-dom + integration serializado vs staging) · cenários E2E HTTP (`scripts/wms/cenarios/catalogo/NN-*.ts`) · PrintNode (ZPL) · pg_cron.

**Harness de testes:**
- **Unit (vitest):** `npm test -- <arquivo>` — `src/**/*.test.ts`. Exemplo: `src/lib/wms/ledger.test.ts`.
- **Integration:** `npm run test:integration` — `test/integration/**/*.test.ts` (serializado, trunca tabelas operacionais; `globalSetup.ts` faz `truncateOperacional` + `seedInicial`). Config: `vitest.integration.config.ts`.
- **Scenarios (E2E HTTP):** `npm run scenarios` (`-- --only "<substr do nome>"` p/ um) — `scripts/wms/cenarios/catalogo/NN-*.ts` (export default `Cenario`: `setup/run/assertEsperado`). Exemplo: `scripts/wms/cenarios/catalogo/81-receber-oc-destrava-pedido.ts`.

> Nota de divergência (paths de teste): os achados de P079/P133 citam `tests/integration/` e `src/test/integration/` — o path real no repo é `test/integration/`. Este plano usa `test/integration/`.

---

## PR 1: Relatório movs-por-empresa — default 12m + paginação 5k + filtro SQL de empresa + excluir devoluções [P105, P107, P158]

Os três batem no MESMO `route.ts` (mais a `page.tsx` para o default de período). Fazer juntos evita conflito de merge (conflito resolvido #9 do mestre). Sem migration.

Arquivos no estado atual:
- `src/app/api/wms/relatorios/movs-por-empresa/route.ts` — GET; whitelist `origem_tipo` em `:54-61` (inclui 3 origens de devolução); filtros `.eq` só de `galpao_id`/`produto_id` em `:62-63`; empresa filtrada em memória em `:80-83`; sem `.limit()`. Resposta `{ items }` em `:97`.
- `src/app/wms/relatorios/movs-por-empresa/page.tsx` — default `dataInicio = hoje-30d` em `:54-56`.

### Task 1.1: Excluir origens de devolução da whitelist do relatório (P158)

**Files**
- Modify: `src/app/api/wms/relatorios/movs-por-empresa/route.ts:54-61` (whitelist `origem_tipo`)
- Test: `scripts/wms/cenarios/catalogo/86-relatorio-movs-sem-devolucao.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/86-relatorio-movs-sem-devolucao.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 86 — Relatório de movs por empresa NÃO mistura devoluções (P158).
 *
 * Uma compra real (nf_compra via recebimento de OC) e uma devolução
 * (devolucao_cliente_integra via classificar A) geram movs de ENTRADA pro
 * mesmo produto. O relatório de "compras por empresa" deve listar SÓ a
 * compra real — a entrada de devolução não pode aparecer.
 */
type Setup = { sku: string; produtoUuid: string };

export default {
  nome: "86 — relatório movs-por-empresa exclui devoluções (só compras de verdade)",
  descricao:
    "Compra real (nf_compra) + devolução (devolucao_cliente_integra) pro mesmo produto. " +
    "GET /api/wms/relatorios/movs-por-empresa NÃO retorna o grupo da devolução.",
  tags: ["relatorio", "movs-por-empresa", "devolucao", "p158"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("86");
    const produtoUuid = await ctx.criarProduto({ sku, descricao: "Relatório sem devolução 86" });
    return { sku, produtoUuid };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { produtoUuid } = setup;
    const cwb = ctx.staging.galpoes.cwb;
    const netair = ctx.staging.empresas.netair;
    // Insere 2 entradas direto no ledger: uma nf_compra, uma devolucao_cliente_integra.
    for (const origem of ["nf_compra", "devolucao_cliente_integra"] as const) {
      await ctx.sb.rpc("wms_inserir_movimentacao", {
        p_produto_id: produtoUuid,
        p_galpao_id: cwb.id,
        p_localizacao_id: cwb.recebimento_loc_id,
        p_tipo: "E",
        p_quantidade: 5,
        p_origem_tipo: origem,
        p_origem_id: null,
        p_custo_unitario: 10,
        p_motivo: `seed ${origem}`,
        p_empresa_compradora_id: netair.id,
      });
    }
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { produtoUuid } = setup;
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - 24 * 60 * 60 * 1000);
    const fim = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);
    const res = await ctx.http.get<{ items: { produto_id: string; tipo: string }[] }>(
      `/api/wms/relatorios/movs-por-empresa?data_inicio=${inicio.toISOString()}&data_fim=${fim.toISOString()}&produto_id=${produtoUuid}`,
    );
    // Só a compra (nf_compra) deve agregar — total qty do produto = 5 (não 10).
    const grupos = res.items.filter((i) => i.produto_id === produtoUuid && i.tipo === "E");
    const total = grupos.reduce(
      (s, g) => s + (g as unknown as { qty_total: number }).qty_total,
      0,
    );
    if (total !== 5) {
      throw new Error(
        `Esperava qty_total=5 (só nf_compra); recebeu ${total} — devolução vazou no relatório.`,
      );
    }
  },
} satisfies Cenario<Setup>;

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

> Nota: o cenário usa `ctx.sb.rpc("wms_inserir_movimentacao", ...)` direto (não há helper de classificarDevolucao que produza `devolucao_cliente_integra` sem fluxo completo). `p_empresa_compradora_id` é tag aceita pela RPC.

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- --only "86 — relatório movs-por-empresa exclui devoluções"`
  Expected: FAIL com `Esperava qty_total=5 (só nf_compra); recebeu 10` (hoje a whitelist inclui `devolucao_cliente_integra`).

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/relatorios/movs-por-empresa/route.ts`, remover as 3 origens de devolução da whitelist (`:54-61`):

```ts
    .in("origem_tipo", [
      "nf_compra",
      "nf_venda",
      "venda_manual",
    ]);
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- --only "86 — relatório movs-por-empresa exclui devoluções"`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/relatorios/movs-por-empresa/route.ts scripts/wms/cenarios/catalogo/86-relatorio-movs-sem-devolucao.ts && git commit -m "fix(wms): relatório movs-por-empresa exclui devoluções (só compras de verdade) [P158]"`

### Task 1.2: Filtro de empresa no SQL + paginação 5k + default 12 meses (P107, P105)

**Files**
- Modify: `src/app/api/wms/relatorios/movs-por-empresa/route.ts:42-97` (filtro empresa no SQL + `.limit(5000)` + flag `truncado`)
- Modify: `src/app/wms/relatorios/movs-por-empresa/page.tsx:54-56` (default `hoje-365d`)
- Test: `scripts/wms/cenarios/catalogo/87-relatorio-movs-filtro-empresa.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/87-relatorio-movs-filtro-empresa.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 87 — filtro de empresa no SQL (P107) + paginação (P105).
 *
 * Duas entradas (nf_compra) pro mesmo produto, uma com empresa_compradora=netair
 * e outra com empresa_compradora=netparts. Filtrando por empresa_id=netair,
 * o relatório deve trazer SÓ o grupo da netair. Também valida que a resposta
 * carrega a flag `truncado` (boolean) — contrato de paginação.
 */
type Setup = { sku: string; produtoUuid: string };

export default {
  nome: "87 — relatório movs-por-empresa filtra empresa no SQL + flag truncado",
  descricao:
    "Entradas de 2 empresas pro mesmo produto; filtro empresa_id=netair retorna só netair. " +
    "Resposta tem campo `truncado:boolean`.",
  tags: ["relatorio", "movs-por-empresa", "empresa", "paginacao", "p105", "p107"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("87");
    const produtoUuid = await ctx.criarProduto({ sku, descricao: "Relatório filtro empresa 87" });
    return { sku, produtoUuid };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { produtoUuid } = setup;
    const cwb = ctx.staging.galpoes.cwb;
    for (const emp of [ctx.staging.empresas.netair, ctx.staging.empresas.netparts]) {
      await ctx.sb.rpc("wms_inserir_movimentacao", {
        p_produto_id: produtoUuid,
        p_galpao_id: cwb.id,
        p_localizacao_id: cwb.recebimento_loc_id,
        p_tipo: "E",
        p_quantidade: 3,
        p_origem_tipo: "nf_compra",
        p_origem_id: null,
        p_custo_unitario: 10,
        p_motivo: "seed filtro empresa",
        p_empresa_compradora_id: emp.id,
      });
    }
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { produtoUuid } = setup;
    const inicio = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fim = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const netairId = ctx.staging.empresas.netair.id;
    const res = await ctx.http.get<{
      items: { produto_id: string; empresa_id: string }[];
      truncado: boolean;
    }>(
      `/api/wms/relatorios/movs-por-empresa?data_inicio=${inicio.toISOString()}&data_fim=${fim.toISOString()}&produto_id=${produtoUuid}&empresa_id=${netairId}`,
    );
    if (typeof res.truncado !== "boolean") {
      throw new Error("Resposta não carrega flag `truncado:boolean` (contrato de paginação).");
    }
    const meu = res.items.filter((i) => i.produto_id === produtoUuid);
    if (meu.some((i) => i.empresa_id !== netairId)) {
      throw new Error("Filtro de empresa vazou: apareceu grupo de outra empresa.");
    }
    if (meu.length !== 1) {
      throw new Error(`Esperava 1 grupo (netair); recebeu ${meu.length}.`);
    }
  },
} satisfies Cenario<Setup>;

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

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- --only "87 — relatório movs-por-empresa filtra empresa no SQL"`
  Expected: FAIL com `Resposta não carrega flag` (`truncado` ainda não existe).

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/relatorios/movs-por-empresa/route.ts`:

(a) Validar `empresa_id` como UUID e aplicar filtro no SQL com `.or()` condicional ao tipo (`E→compradora`, `S→vendedora`). Adicionar `.limit(5000)`. Trocar a resposta para incluir `truncado`. Substituir `:62-67`:

```ts
  if (galpaoId) query = query.eq("galpao_id", galpaoId);
  if (produtoId) query = query.eq("produto_id", produtoId);
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (empresaId) {
    if (!UUID_RE.test(empresaId)) {
      return NextResponse.json({ error: "empresa_id inválido" }, { status: 400 });
    }
    query = query.or(
      `and(tipo.eq.E,empresa_compradora_id.eq.${empresaId}),and(tipo.eq.S,empresa_vendedora_id.eq.${empresaId})`,
    );
  }

  const PAGE_LIMIT = 5000;
  const { data, error } = await query.limit(PAGE_LIMIT);
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  const truncado = (data?.length ?? 0) >= PAGE_LIMIT;
```

(b) Manter o guard em memória (`if (empresaId && empresa !== empresaId) continue;` em `:83`) como defense-in-depth.

(c) Trocar a resposta final (`:97`):

```ts
  return NextResponse.json({ items: Array.from(grupos.values()), truncado });
```

(d) No frontend `src/app/wms/relatorios/movs-por-empresa/page.tsx`, trocar o default de `dataInicio` (`:54-56`) de 30 para 365 dias:

```tsx
  const [dataInicio, setDataInicio] = useState(() =>
    isoDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)),
  );
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- --only "87 — relatório movs-por-empresa filtra empresa no SQL"`
  Expected: PASS. Rodar também `npm run scenarios -- --only "86 — relatório movs-por-empresa exclui devoluções"` (no-regress).

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/relatorios/movs-por-empresa/route.ts src/app/wms/relatorios/movs-por-empresa/page.tsx scripts/wms/cenarios/catalogo/87-relatorio-movs-filtro-empresa.ts && git commit -m "fix(wms): relatório movs-por-empresa — filtro empresa no SQL + paginação 5k + default 12m [P105,P107]"`

### Task 1.3: Registrar bug-fixes em erros-conhecidos.yaml (PR 1)

**Files**
- Modify: `erros-conhecidos.yaml`

- [ ] **Step 1 — Adicionar entradas.** Acrescentar ao final de `erros:`:

```yaml
  - id: wms-relatorio-movs-mistura-devolucao
    date: "2026-06-05"
    source: wms.relatorios.movs-por-empresa
    category: business_logic
    message: "Relatório de compras por empresa inclui entradas de devolução (custo agregado viciado)"
    cause: >
      A whitelist .in('origem_tipo', [...]) incluía devolucao_cliente_integra,
      devolucao_cliente_troca_sku e devolucao_fornecedor_enviada — devoluções
      contavam como compra/venda real.
    fix: >
      Removidas as 3 origens de devolução da whitelist; relatório lista só
      nf_compra, nf_venda e venda_manual.
    files:
      - src/app/api/wms/relatorios/movs-por-empresa/route.ts
    tags: [relatorio, devolucao, custo-medio, p158]

  - id: wms-relatorio-movs-filtra-em-memoria
    date: "2026-06-05"
    source: wms.relatorios.movs-por-empresa
    category: infrastructure
    message: "Relatório puxa todas as movs do intervalo e filtra empresa em memória; sem teto de linhas"
    cause: >
      Empresa (compradora p/ E, vendedora p/ S) não era filtrada no SQL e a
      query não tinha .limit() — intervalo grande estourava memória. Default
      de período no front era 30 dias (não 12 meses).
    fix: >
      Filtro de empresa movido pro SQL via .or() condicional ao tipo (UUID
      validado antes); .limit(5000) + flag truncado na resposta; default do
      front virou 365 dias.
    files:
      - src/app/api/wms/relatorios/movs-por-empresa/route.ts
      - src/app/wms/relatorios/movs-por-empresa/page.tsx
    tags: [relatorio, performance, paginacao, p105, p107]
```

- [ ] **Step 2 — Commit.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): relatório movs-por-empresa (filtro empresa SQL + sem devolução) [P105,P107,P158]"`

---

## PR 2: Etiqueta/impressão — retry 3x + 2 labels + retenção 30d + invalidar cache PrintNode + preview delete conta [P142, P144, P143, P183, P141]

Inclui MIGRATION (P143: cron de retenção). P142+P144 batem no mesmo `reimprimir/route.ts`; P183+P141 no mesmo `printnode/contas/[id]/route.ts`. Ordem: P144 (fix do split, base do bloco try) → P142 (retry no mesmo bloco) → P143 (migration cron) → P183 (invalidar cache) → P141 (preview delete).

Arquivos no estado atual:
- `src/app/api/wms/separacao/reimprimir/route.ts` — fast-path com `splitZplLabels(...)[0]` em `:92-93`; `enviarImpressaoZpl` 1x em `:95-100`; catch retorna 500 `erro_interno` em `:110-122`.
- `src/lib/printnode.ts` — `printerCache` (`:281`), `invalidarCacheImpressora` (`:352`), `printerProdutoCache` (`:360`), `invalidarCacheImpressoraProduto` (`:464`). Precedente: `etiqueta-service.ts:147` envia ZPL full (multi-label) sem split.
- `src/app/api/wms/admin/printnode/contas/[id]/route.ts` — PATCH (`:14-82`) não invalida cache; DELETE (`:91-116`) sem preview.
- `supabase/migrations/20260311_cleanup_etiqueta_zpl_cron.sql` — cron `interval '7 days'`.
- `src/app/wms/configuracoes/conexoes/page.tsx:1448-1471` — `remove()` com `confirm()` genérico.

### Task 2.1: Reimpressão envia TODAS as labels (NF + envio), não só a primeira (P144)

**Files**
- Modify: `src/app/api/wms/separacao/reimprimir/route.ts:91-100` (remover `[0]`)
- Test: `src/app/api/wms/separacao/reimprimir/__tests__/reimprimir-labels.test.ts` (Create)

> Para testar a rota como unidade sem subir servidor, extraímos um helper puro `selecionarZplParaImpressao(etiquetaZpl)` que a rota passa a usar. O teste exercita o helper.

- [ ] **Step 1 — Escrever o teste que falha.** Criar `src/app/api/wms/separacao/reimprimir/__tests__/reimprimir-labels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selecionarZplParaImpressao } from "../zpl-reimpressao";
import { splitZplLabels } from "@/lib/etiqueta-download";

describe("selecionarZplParaImpressao (P144 — reimprimir as 2 labels)", () => {
  it("com 2 labels (NF + envio) retorna o ZPL completo, não só a primeira", () => {
    const nf = "^XA^FDNotaFiscal^FS^XZ";
    const envio = "^XA^FDEtiquetaEnvio^FS^XZ";
    const cache = nf + envio;
    const out = selecionarZplParaImpressao(cache);
    expect(splitZplLabels(out)).toHaveLength(2);
    expect(out).toContain("NotaFiscal");
    expect(out).toContain("EtiquetaEnvio");
  });

  it("com 1 label retorna ela mesma", () => {
    const um = "^XA^FDUnica^FS^XZ";
    expect(selecionarZplParaImpressao(um)).toBe(um);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/app/api/wms/separacao/reimprimir/__tests__/reimprimir-labels.test.ts`
  Expected: FAIL com erro de import (`zpl-reimpressao` não existe).

- [ ] **Step 3 — Implementação mínima.** Criar `src/app/api/wms/separacao/reimprimir/zpl-reimpressao.ts`:

```ts
/**
 * Seleciona o ZPL a enviar na reimpressão. Sempre retorna o conteúdo COMPLETO
 * (todas as labels — NF + etiqueta de envio). O PrintNode imprime multi-label
 * num único job (mesmo precedente de etiqueta-service.ts). NÃO fatiar pra
 * pegar só a primeira: isso perdia a etiqueta de envio (P144).
 */
export function selecionarZplParaImpressao(etiquetaZpl: string): string {
  return etiquetaZpl;
}
```

Em `src/app/api/wms/separacao/reimprimir/route.ts`, importar o helper e usar o ZPL completo. Trocar `:92-100`:

```ts
    // Reimprime TODAS as labels cacheadas (NF + etiqueta de envio). P144.
    const zplCompleto = selecionarZplParaImpressao(pedido.etiqueta_zpl);

    const { jobId } = await enviarImpressaoZpl({
      apiKey: printer.apiKey,
      printerId: printer.printerId,
      zpl: zplCompleto,
      titulo: `Etiqueta Pedido #${pedido.numero ?? pedidoId} (reimpressão)`,
    });
```

Adicionar o import no topo (`:7` é onde está `splitZplLabels`; pode remover `splitZplLabels` se ficar sem uso após a Task — verificar):

```ts
import { selecionarZplParaImpressao } from "./zpl-reimpressao";
```

> Nota: após esta task, `splitZplLabels` deixa de ser usado em `reimprimir/route.ts`. Remover o import órfão `import { splitZplLabels } from "@/lib/etiqueta-download";` (linha 7).

- [ ] **Step 4 — Rodar e ver passar.** `npm test -- src/app/api/wms/separacao/reimprimir/__tests__/reimprimir-labels.test.ts`
  Expected: PASS (2 testes).

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/separacao/reimprimir/ && git commit -m "fix(wms): reimpressão envia as 2 labels (NF + envio), não só a primeira [P144]"`

### Task 2.2: Reimpressão tenta 3x (10s cada) e retorna erro tipado `impressora_indisponivel` (P142)

**Files**
- Modify: `src/app/api/wms/separacao/reimprimir/route.ts:91-122` (retry loop + erro tipado)
- Modify: `src/app/wms/separacao/page.tsx` (handler de reimpressão — mensagem clara)
- Test: `src/app/api/wms/separacao/reimprimir/__tests__/reimprimir-retry.test.ts` (Create)

> Extraímos a lógica de envio com retry num helper puro `enviarComRetry(send, { tentativas, esperaMs })` testável sem timers reais (espera injetável).

- [ ] **Step 1 — Escrever o teste que falha.** Criar `src/app/api/wms/separacao/reimprimir/__tests__/reimprimir-retry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { enviarComRetry } from "../enviar-com-retry";

describe("enviarComRetry (P142 — retry 3x na reimpressão)", () => {
  it("falha 2x e sucede na 3a: retorna ok e chamou send 3x", async () => {
    let n = 0;
    const send = vi.fn(async () => {
      n++;
      if (n < 3) throw new Error("printnode down");
      return { jobId: 99 };
    });
    const r = await enviarComRetry(send, { tentativas: 3, esperaMs: 0 });
    expect(r).toEqual({ jobId: 99 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("falha nas 3 tentativas: lança erro tipado ImpressoraIndisponivelError", async () => {
    const send = vi.fn(async () => {
      throw new Error("printnode down");
    });
    await expect(
      enviarComRetry(send, { tentativas: 3, esperaMs: 0 }),
    ).rejects.toMatchObject({ codigo: "impressora_indisponivel" });
    expect(send).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/app/api/wms/separacao/reimprimir/__tests__/reimprimir-retry.test.ts`
  Expected: FAIL com erro de import (`enviar-com-retry` não existe).

- [ ] **Step 3 — Implementação mínima.** Criar `src/app/api/wms/separacao/reimprimir/enviar-com-retry.ts`:

```ts
/** Erro tipado pra distinguir indisponibilidade de impressora de erro genérico. */
export class ImpressoraIndisponivelError extends Error {
  readonly codigo = "impressora_indisponivel" as const;
  constructor() {
    super("Impressora indisponível após múltiplas tentativas");
    this.name = "ImpressoraIndisponivelError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tenta `send` até `tentativas` vezes, esperando `esperaMs` entre falhas.
 * Sucesso → retorna o resultado. Esgotou as tentativas → lança
 * ImpressoraIndisponivelError. P142: 3 tentativas, 10s cada.
 */
export async function enviarComRetry<T>(
  send: () => Promise<T>,
  opts: { tentativas: number; esperaMs: number },
): Promise<T> {
  let ultimoErro: unknown;
  for (let i = 0; i < opts.tentativas; i++) {
    try {
      return await send();
    } catch (err) {
      ultimoErro = err;
      if (i < opts.tentativas - 1 && opts.esperaMs > 0) await sleep(opts.esperaMs);
    }
  }
  void ultimoErro;
  throw new ImpressoraIndisponivelError();
}
```

Em `src/app/api/wms/separacao/reimprimir/route.ts`, envolver o envio com retry. Trocar o bloco `try { ... } catch { ... }` (`:91-122`):

```ts
  try {
    // Reimprime TODAS as labels cacheadas (NF + etiqueta de envio). P144.
    const zplCompleto = selecionarZplParaImpressao(pedido.etiqueta_zpl);

    // P142: tenta 3x (10s entre falhas) antes de desistir.
    const { jobId } = await enviarComRetry(
      () =>
        enviarImpressaoZpl({
          apiKey: printer.apiKey,
          printerId: printer.printerId,
          zpl: zplCompleto,
          titulo: `Etiqueta Pedido #${pedido.numero ?? pedidoId} (reimpressão)`,
        }),
      { tentativas: 3, esperaMs: 10_000 },
    );

    supabase.rpc("siso_set_etiqueta_status", {
      p_pedido_id: pedidoId,
      p_status: "impresso",
    }).then(() => {}, () => {});

    logger.info(LOG_SOURCE, "Reimpressão via cache", { pedidoId, jobId: String(jobId) });
    return NextResponse.json({ status: "impresso", jobId });
  } catch (err) {
    supabase.rpc("siso_set_etiqueta_status", {
      p_pedido_id: pedidoId,
      p_status: "falhou",
    }).then(() => {}, () => {});

    const indisponivel = err instanceof ImpressoraIndisponivelError;
    logger.error(LOG_SOURCE, "Erro ao reimprimir", {
      pedidoId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        status: "falhou",
        error: indisponivel ? "impressora_indisponivel" : "erro_interno",
      },
      { status: indisponivel ? 503 : 500 },
    );
  }
```

Adicionar o import no topo:

```ts
import { enviarComRetry, ImpressoraIndisponivelError } from "./enviar-com-retry";
```

No frontend `src/app/wms/separacao/page.tsx`, o handler real é a mutation `reimprimirMut` (`:559-584`), que processa um LOTE de ids via `Promise.allSettled` e mapeia cada resposta a um boolean (`r.ok && b.status === "impresso"`) — ele NÃO inspeciona `b.error` hoje. Capturar o caso `impressora_indisponivel` para dar um toast específico quando a impressora estiver fora. Substituir o `mutationFn` por (mudança cirúrgica: acrescenta a contagem `indisponivel`):

```tsx
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const r = await sisoFetch("/api/wms/separacao/reimprimir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pedido_id: id }),
          });
          const b = await r.json().catch(() => ({}));
          if (r.ok && b.status === "impresso") return "ok" as const;
          if (b?.error === "impressora_indisponivel") return "indisponivel" as const;
          return "fail" as const;
        }),
      );
      let ok = 0;
      let fail = 0;
      let indisponivel = 0;
      for (const r of results) {
        if (r.status === "fulfilled" && r.value === "ok") ok++;
        else if (r.status === "fulfilled" && r.value === "indisponivel") indisponivel++;
        else fail++;
      }
      return { ok, fail, indisponivel };
    },
    onSuccess: ({ ok, fail, indisponivel }) => {
      if (ok > 0) toast.success(`${ok} etiqueta(s) impressa(s)`);
      if (indisponivel > 0)
        toast.error(`${indisponivel} impressora(s) indisponível(is), tente novamente em instantes.`);
      if (fail > 0) toast.error(`${fail} etiqueta(s) falharam`);
    },
```

> ⚠️ Cobertura: esta mudança de UI (`reimprimirMut`) NÃO tem teste automatizado — é best-effort, não TDD. O RED↔GREEN desta task cobre só o helper puro `enviarComRetry` (Step 1). A alteração no `page.tsx` é verificada por inspeção/`npm run lint`, não por teste. Não inflar como coberto.

- [ ] **Step 4 — Rodar e ver passar.** `npm test -- src/app/api/wms/separacao/reimprimir/__tests__/reimprimir-retry.test.ts`
  Expected: PASS (2 testes). Rodar também a Task 2.1 (no-regress) e `npm run lint`.

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/separacao/reimprimir/ src/app/wms/separacao/page.tsx && git commit -m "fix(wms): reimpressão tenta 3x (10s) e retorna erro tipado impressora_indisponivel [P142]"`

### Task 2.3: Migration — retenção de etiqueta_zpl sobe de 7 para 30 dias (P143)

**Files**
- Create: `supabase/migrations/20260605_etiqueta_zpl_retencao_30d.sql`
- Test: `test/integration/etiqueta-zpl-retencao.test.ts` (Create)

> **Estado real do staging (verificado):** o job `cleanup-etiqueta-zpl` NÃO existe em `cron.job` (a migration `20260311_cleanup_etiqueta_zpl_cron.sql` está no repo mas nunca foi aplicada no staging). Logo esta migration **cria** o job (com `30 days`) — o `unschedule` prévio é só defensivo (caso já exista). Além disso, `cron.job` vive no schema `cron`, que o PostgREST NÃO expõe — `sb.from("cron.job")` falharia. O caminho determinístico do teste é uma **RPC SECURITY DEFINER em `public`** que lê `cron.job`; o teste a chama via `sb.rpc(...)`. Sem `it.skip`.

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/etiqueta-zpl-retencao.test.ts`. Lê o comando agendado via a RPC `wms_cron_command` (criada na migration do Step 3). Antes da migration a RPC ainda não existe → o `error` não é nulo → a primeira asserção falha (RED determinístico, não skip):

```ts
import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("cron cleanup-etiqueta-zpl — retenção 30 dias (P143)", () => {
  it("o comando agendado usa interval '30 days', não '7 days'", async () => {
    const { data, error } = await sb.rpc("wms_cron_command", {
      p_jobname: "cleanup-etiqueta-zpl",
    });
    // Antes da migration: a RPC não existe -> error preenchido (RED).
    // Depois: data é o command string do job (ou null se ausente).
    expect(error).toBeNull();
    const command = (data as string | null) ?? "";
    expect(command).toContain("30 days");
    expect(command).not.toContain("7 days");
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- etiqueta-zpl-retencao`
  Expected: FAIL — `wms_cron_command` ainda não existe, então `error` vem preenchido (`function ... does not exist`) e `expect(error).toBeNull()` falha. (Não é skip: o teste roda e reprova.)

- [ ] **Step 3 — Implementação mínima.** Criar `supabase/migrations/20260605_etiqueta_zpl_retencao_30d.sql`. Cria (ou recria) o job com `30 days` e expõe a RPC de leitura SECURITY DEFINER:

```sql
-- P143: retenção do ZPL cacheado = 30 dias (antes 7).
-- O job NÃO existe no staging (a 20260311 nunca foi aplicada lá); esta migration
-- o cria. O unschedule guardado é defensivo caso exista em outro ambiente.
DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-etiqueta-zpl');
EXCEPTION WHEN OTHERS THEN
  -- job não existia: segue em frente
  NULL;
END $$;

SELECT cron.schedule(
  'cleanup-etiqueta-zpl',
  '0 3 * * *',
  $$UPDATE siso_pedidos SET etiqueta_zpl = NULL, etiqueta_url = NULL WHERE etiqueta_zpl IS NOT NULL AND etiqueta_status = 'impresso' AND updated_at < now() - interval '30 days'$$
);

-- Leitura determinística do command do job (cron.job não é exposto via PostgREST).
-- SECURITY DEFINER: roda como owner (acesso ao schema cron). Retorna NULL se ausente.
CREATE OR REPLACE FUNCTION public.wms_cron_command(p_jobname text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = cron, pg_catalog
AS $$
  SELECT command FROM cron.job WHERE jobname = p_jobname LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.wms_cron_command(text) TO service_role;
```

Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (name: `etiqueta_zpl_retencao_30d`, query = conteúdo acima).

> Nota: o `DO $$ ... EXCEPTION ... $$` torna o `unschedule` seguro quando o job não existe (caso do staging) — `cron.unschedule(text)` lança se o nome não existe. Após o `cron.schedule`, validar com `mcp__supabase__execute_sql`: `SELECT command FROM cron.job WHERE jobname='cleanup-etiqueta-zpl'` deve conter `30 days`.

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- etiqueta-zpl-retencao`
  Expected: PASS — `wms_cron_command('cleanup-etiqueta-zpl')` retorna o command com `30 days` e sem `7 days`.

- [ ] **Step 5 — Commit.** `git add supabase/migrations/20260605_etiqueta_zpl_retencao_30d.sql test/integration/etiqueta-zpl-retencao.test.ts && git commit -m "fix(wms): retenção de etiqueta_zpl sobe de 7 para 30 dias + RPC wms_cron_command [P143]"`

### Task 2.4: Invalidar cache PrintNode ao salvar/deletar conta (P183)

**Files**
- Modify: `src/app/api/wms/admin/printnode/contas/[id]/route.ts` (PATCH `:57-82` e DELETE `:104-116` — invalidar ambos os caches)
- Test: `src/lib/printnode-cache.test.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Criar `src/lib/printnode-cache.test.ts`. O teste prova que **uma única chamada** (helper combinado) limpa OS DOIS caches. Como os caches são privados ao módulo, exercitamos via um helper exportado `invalidarTodoCacheImpressora()` que chama ambos:

```ts
import { describe, it, expect } from "vitest";
import {
  invalidarTodoCacheImpressora,
  invalidarCacheImpressora,
  invalidarCacheImpressoraProduto,
} from "./printnode";

describe("invalidarTodoCacheImpressora (P183)", () => {
  it("existe e é função (limpa cache de envio E de produto)", () => {
    expect(typeof invalidarTodoCacheImpressora).toBe("function");
    expect(typeof invalidarCacheImpressora).toBe("function");
    expect(typeof invalidarCacheImpressoraProduto).toBe("function");
    // Não deve lançar ao limpar ambos os caches.
    expect(() => invalidarTodoCacheImpressora()).not.toThrow();
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/lib/printnode-cache.test.ts`
  Expected: FAIL com erro de import (`invalidarTodoCacheImpressora` não existe).

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/printnode.ts`, adicionar (após `invalidarCacheImpressoraProduto`, `:466`):

```ts
/**
 * Limpa AMBOS os caches de impressora (envio + produto). Usar no PATCH/DELETE
 * de conta PrintNode pra que a key nova valha na hora (P183). invalidarCacheImpressora
 * sozinho NÃO limpa o cache de produto.
 */
export function invalidarTodoCacheImpressora(): void {
  invalidarCacheImpressora();
  invalidarCacheImpressoraProduto();
}
```

Em `src/app/api/wms/admin/printnode/contas/[id]/route.ts`, importar e chamar após o UPDATE (PATCH) e após o DELETE. Topo:

```ts
import { invalidarTodoCacheImpressora } from "@/lib/printnode";
```

No PATCH, após `if (!data) { ... }` e antes do `return` final (`:73`):

```ts
  invalidarTodoCacheImpressora();
```

No DELETE, após o check de erro e antes do `return NextResponse.json({ ok: true })` (`:114`):

```ts
  invalidarTodoCacheImpressora();
```

- [ ] **Step 4 — Rodar e ver passar.** `npm test -- src/lib/printnode-cache.test.ts`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/lib/printnode.ts src/app/api/wms/admin/printnode/contas/[id]/route.ts src/lib/printnode-cache.test.ts && git commit -m "fix(wms): invalidar cache PrintNode (envio + produto) ao salvar/deletar conta [P183]"`

### Task 2.5: Preview de impacto antes de deletar conta PrintNode (P141)

**Files**
- Modify: `src/app/api/wms/admin/printnode/contas/[id]/route.ts` (adicionar `GET` de preview)
- Modify: `src/app/wms/configuracoes/conexoes/page.tsx:1448-1471` (`remove()` usa preview)
- Test: `scripts/wms/cenarios/catalogo/88-printnode-delete-preview.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/88-printnode-delete-preview.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 88 — preview de impacto ao deletar conta PrintNode (P141).
 *
 * Cria conta, atribui a 1 galpão (envio) e 1 usuário; o GET de preview deve
 * listar exatamente esses afetados. Não bloqueia o delete (decisão = opção 1).
 */
type Setup = { contaId: string; galpaoId: string; usuarioId: string };

export default {
  nome: "88 — preview de impacto ao deletar conta PrintNode lista galpões + usuários afetados",
  descricao:
    "Conta atribuída a 1 galpão (envio) e 1 usuário; GET ?preview=1 retorna esses afetados.",
  tags: ["printnode", "delete", "preview", "p141"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const cwb = ctx.staging.galpoes.cwb;
    const { data: conta } = await ctx.sb
      .from("siso_printnode_contas")
      .insert({ label: `PN-88-${Date.now()}`, api_key: "k88", ativo: true })
      .select("id")
      .single();
    const contaId = (conta as { id: string }).id;
    await ctx.sb
      .from("siso_galpoes")
      .update({ printnode_account_id: contaId })
      .eq("id", cwb.id);
    const { data: u } = await ctx.sb
      .from("siso_usuarios")
      .select("id")
      .limit(1)
      .single();
    const usuarioId = (u as { id: string }).id;
    await ctx.sb
      .from("siso_usuarios")
      .update({ printnode_account_id: contaId })
      .eq("id", usuarioId);
    return { contaId, galpaoId: cwb.id, usuarioId };
  },

  run: async (): Promise<void> => {
    /* assert-only */
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const res = await ctx.http.get<{
      galpoes: { id: string }[];
      usuarios: { id: string }[];
    }>(`/api/wms/admin/printnode/contas/${setup.contaId}?preview=1`);
    if (!res.galpoes.some((g) => g.id === setup.galpaoId)) {
      throw new Error("Preview não listou o galpão afetado.");
    }
    if (!res.usuarios.some((u) => u.id === setup.usuarioId)) {
      throw new Error("Preview não listou o usuário afetado.");
    }
  },
} satisfies Cenario<Setup>;

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

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- --only "88 — preview de impacto ao deletar conta PrintNode"`
  Expected: FAIL (rota GET não existe → 404/erro de http).

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/admin/printnode/contas/[id]/route.ts`, adicionar um `GET` que, com `?preview=1`, conta/lista os afetados nas 4 colunas FK (envio + produto, em galpões + usuários):

```ts
/**
 * GET /api/wms/admin/printnode/contas/[id]?preview=1
 * Lista galpões e usuários que ficariam sem impressora se a conta for deletada.
 * Cobre as 4 colunas FK: printnode_account_id (envio) e
 * printnode_account_id_produto (produto), em galpões e usuários. P141.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }
  if (!userCan(session, "sistema.conexoes")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();
  const { id } = await params;

  const [galpEnvio, galpProduto, usuEnvio, usuProduto] = await Promise.all([
    supabase.from("siso_galpoes").select("id, nome").eq("printnode_account_id", id),
    supabase.from("siso_galpoes").select("id, nome").eq("printnode_account_id_produto", id),
    supabase.from("siso_usuarios").select("id, nome").eq("printnode_account_id", id),
    supabase.from("siso_usuarios").select("id, nome").eq("printnode_account_id_produto", id),
  ]);

  const galMap = new Map<string, { id: string; nome: string; uso: "envio" | "produto" }>();
  for (const g of galpEnvio.data ?? []) galMap.set(g.id, { id: g.id, nome: g.nome, uso: "envio" });
  for (const g of galpProduto.data ?? [])
    if (!galMap.has(g.id)) galMap.set(g.id, { id: g.id, nome: g.nome, uso: "produto" });

  const usuMap = new Map<string, { id: string; nome: string; uso: "envio" | "produto" }>();
  for (const u of usuEnvio.data ?? []) usuMap.set(u.id, { id: u.id, nome: u.nome, uso: "envio" });
  for (const u of usuProduto.data ?? [])
    if (!usuMap.has(u.id)) usuMap.set(u.id, { id: u.id, nome: u.nome, uso: "produto" });

  return NextResponse.json({
    galpoes: Array.from(galMap.values()),
    usuarios: Array.from(usuMap.values()),
  });
}
```

No frontend `src/app/wms/configuracoes/conexoes/page.tsx`, `remove()` (`:1448-1471`): antes do `confirm`, buscar o preview e montar a mensagem concreta:

```tsx
  async function remove() {
    if (!user) return;
    let prev: { galpoes: { nome: string }[]; usuarios: { nome: string }[] } = {
      galpoes: [],
      usuarios: [],
    };
    try {
      const r = await sisoFetch(
        `/api/wms/admin/printnode/contas/${conta.id}?preview=1`,
        { headers: { "x-siso-user-id": user.id } },
      );
      if (r.ok) prev = await r.json();
    } catch {
      /* preview best-effort */
    }
    const linhas = [
      ...prev.galpoes.map((g) => `Galpão: ${g.nome}`),
      ...prev.usuarios.map((u) => `Usuário: ${u.nome}`),
    ];
    const detalhe =
      linhas.length > 0
        ? `\n\nEstes ${linhas.length} ficarão sem impressora:\n` + linhas.join("\n")
        : "\n\nNenhum galpão/usuário usa esta conta.";
    if (!confirm(`Remover conta "${conta.label}"?${detalhe}`)) return;
    setBusy(true);
    try {
      const r = await sisoFetch(`/api/wms/admin/printnode/contas/${conta.id}`, {
        method: "DELETE",
        headers: { "x-siso-user-id": user.id },
      });
      if (!r.ok) throw new Error();
      toast.success("Conta removida");
      onChanged();
    } catch {
      toast.error("Erro ao remover");
    } finally {
      setBusy(false);
    }
  }
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- --only "88 — preview de impacto ao deletar conta PrintNode"`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/app/api/wms/admin/printnode/contas/[id]/route.ts src/app/wms/configuracoes/conexoes/page.tsx scripts/wms/cenarios/catalogo/88-printnode-delete-preview.ts && git commit -m "feat(wms): preview de impacto (galpões+usuários) antes de deletar conta PrintNode [P141]"`

### Task 2.6: Registrar bug-fixes em erros-conhecidos.yaml (PR 2)

**Files**
- Modify: `erros-conhecidos.yaml`

- [ ] **Step 1 — Adicionar entradas.** Acrescentar:

```yaml
  - id: wms-reimpressao-perde-etiqueta-envio
    date: "2026-06-05"
    source: wms.separacao.reimprimir
    category: business_logic
    message: "Reimpressão imprime só a NF e perde a etiqueta de envio"
    cause: >
      O fast-path fatiava o ZPL cacheado e enviava só splitZplLabels(...)[0],
      descartando a segunda label (etiqueta de envio).
    fix: >
      Reimpressão passa a enviar o ZPL completo (multi-label num único job,
      como etiqueta-service), via helper selecionarZplParaImpressao.
    files:
      - src/app/api/wms/separacao/reimprimir/route.ts
      - src/app/api/wms/separacao/reimprimir/zpl-reimpressao.ts
    tags: [reimpressao, etiqueta, zpl, p144]

  - id: wms-reimpressao-sem-retry
    date: "2026-06-05"
    source: wms.separacao.reimprimir
    category: external_api
    message: "Reimpressão retorna 500 erro_interno na primeira falha do PrintNode"
    cause: >
      enviarImpressaoZpl era chamado 1x; qualquer falha transitória virava 500
      genérico, sem distinguir impressora indisponível.
    fix: >
      Envio com retry de 3 tentativas (10s entre falhas) via enviarComRetry;
      esgotado, retorna 503 com error:'impressora_indisponivel'.
    files:
      - src/app/api/wms/separacao/reimprimir/route.ts
      - src/app/api/wms/separacao/reimprimir/enviar-com-retry.ts
      - src/app/wms/separacao/page.tsx
    tags: [reimpressao, printnode, retry, p142]

  - id: wms-etiqueta-zpl-retencao-curta
    date: "2026-06-05"
    source: wms.cron.cleanup-etiqueta-zpl
    category: infrastructure
    message: "Retenção do ZPL cacheado em 7 dias (e o job nem estava aplicado no staging)"
    cause: >
      A migration 20260311 agendava o cleanup com interval '7 days' mas nunca foi
      aplicada no staging (job ausente em cron.job); quando rodasse, apagaria o
      etiqueta_zpl em 7 dias e o caminho de re-geração (siso_claim_etiqueta)
      recusa pedidos já 'impresso'.
    fix: >
      Migration cria/recria o cron cleanup-etiqueta-zpl com interval '30 days' e
      expõe a RPC wms_cron_command (SECURITY DEFINER) pra leitura determinística.
    files:
      - supabase/migrations/20260605_etiqueta_zpl_retencao_30d.sql
    tags: [etiqueta, cron, retencao, p143]

  - id: wms-printnode-cache-nao-invalida
    date: "2026-06-05"
    source: wms.admin.printnode.contas
    category: config
    message: "Após trocar api_key da conta PrintNode, impressão usa key antiga por até 5min"
    cause: >
      PATCH/DELETE de conta não limpavam os caches in-memory (printerCache e
      printerProdutoCache, TTL 5min).
    fix: >
      PATCH e DELETE chamam invalidarTodoCacheImpressora (limpa envio + produto).
    files:
      - src/lib/printnode.ts
      - src/app/api/wms/admin/printnode/contas/[id]/route.ts
    tags: [printnode, cache, p183]

  - id: wms-printnode-delete-sem-preview
    date: "2026-06-05"
    source: wms.admin.printnode.contas
    category: business_logic
    message: "Deletar conta PrintNode tira impressora de galpões/usuários sem mostrar impacto"
    cause: >
      O DELETE removia a conta direto (FK SET NULL) sem preview; o front usava
      um confirm() genérico.
    fix: >
      Novo GET ?preview=1 lista galpões e usuários afetados (4 colunas FK); o
      remove() do front mostra a lista concreta antes de confirmar.
    files:
      - src/app/api/wms/admin/printnode/contas/[id]/route.ts
      - src/app/wms/configuracoes/conexoes/page.tsx
    tags: [printnode, delete, preview, p141]
```

- [ ] **Step 2 — Commit.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): etiqueta/impressão (reimpressão, cache, retenção, preview) [P141,P142,P143,P144,P183]"`

---

## PR 3: Pointwise cadastros — lead default 7d, qty inteira transferência, packing no type/rota/form, SKU duplicado 409, reativar/bloquear vínculo fornecedor, kit qty ≥ 1 [P079, P162, P173, P174, P178, P179, P133, P121]

Inclui MIGRATIONS (P079: recria MV; P133: FK ON DELETE RESTRICT). Tasks independentes; ordenadas dos quick-wins puros aos com migration. Conflito #12 do mestre: P178 e P179 são ortogonais (P179 bloqueia delete de fornecedor; P178 reativa vínculo no reimport) — não colidem.

### Task 3.1: Quantidade inteira na transferência inter-galpão (P162)

**Files**
- Modify: `src/components/wms/ui/modals.tsx:1176-1181` (validação `itensValidos`) e `:985-992` (input `step="1"`)
- Test: `src/components/wms/ui/modals.qty-inteira.test.ts` (Create)

> A validação principal é a `itensValidos`. Extraímos um predicado puro `qtyTransferenciaValida(qty)` testável.

- [ ] **Step 1 — Escrever o teste que falha.** Criar `src/components/wms/ui/modals.qty-inteira.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { qtyTransferenciaValida } from "./qty-transferencia";

describe("qtyTransferenciaValida (P162 — só inteiros)", () => {
  it("rejeita 12.5", () => {
    expect(qtyTransferenciaValida("12.5")).toBe(false);
  });
  it("rejeita 0 e negativos", () => {
    expect(qtyTransferenciaValida("0")).toBe(false);
    expect(qtyTransferenciaValida("-3")).toBe(false);
  });
  it("aceita inteiro positivo", () => {
    expect(qtyTransferenciaValida("12")).toBe(true);
    expect(qtyTransferenciaValida("1")).toBe(true);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm test -- src/components/wms/ui/modals.qty-inteira.test.ts`
  Expected: FAIL com erro de import (`qty-transferencia` não existe).

- [ ] **Step 3 — Implementação mínima.** Criar `src/components/wms/ui/qty-transferencia.ts`:

```ts
/**
 * Valida a quantidade de transferência inter-galpão: só inteiro positivo.
 * (P162) Produto a granel kg/m seria exceção configurável — não há flag de
 * granel no schema hoje, então hard-block inteiro.
 */
export function qtyTransferenciaValida(raw: string | number): boolean {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0;
}
```

Em `src/components/wms/ui/modals.tsx`, importar e usar na `itensValidos` (`:1176-1181`):

```tsx
  const itensValidos = itens.every(
    (it) =>
      !!it.produto &&
      it.locs.length > 0 &&
      it.locs.every((l) => qtyTransferenciaValida(l.qty)),
  );
```

E nos inputs de qty (`:985-987` e o segundo bloco em `:1522-1530`), adicionar `step="1"`:

```tsx
                  <input
                    type="number"
                    min="1"
                    step="1"
                    max={l.saldo}
```

Adicionar o import no topo de `modals.tsx`:

```tsx
import { qtyTransferenciaValida } from "./qty-transferencia";
```

- [ ] **Step 4 — Rodar e ver passar.** `npm test -- src/components/wms/ui/modals.qty-inteira.test.ts`
  Expected: PASS (3 testes).

- [ ] **Step 5 — Commit.** `git add src/components/wms/ui/qty-transferencia.ts src/components/wms/ui/modals.tsx src/components/wms/ui/modals.qty-inteira.test.ts && git commit -m "fix(wms): transferência aceita só quantidade inteira positiva [P162]"`

### Task 3.2: Tipo `packing` válido no type/rotas/form (P173)

**Files**
- Modify: `src/lib/wms/types.ts:6-11` (`TipoLocalizacao`)
- Modify: `src/app/api/wms/localizacoes/lote/route.ts:8-14` (`TIPOS_VALIDOS`)
- Modify: `src/app/api/wms/localizacoes/[id]/route.ts:7-13` (`TIPOS_VALIDOS`)
- Modify: `src/app/wms/localizacoes/page.tsx:16-22` (`TIPOS`)
- Test: `scripts/wms/cenarios/catalogo/89-loc-tipo-packing.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/89-loc-tipo-packing.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 89 — criar localização tipo 'packing' (P173).
 * O DB já aceita 'packing' (CHECK); a rota de lote rejeitava por TIPOS_VALIDOS.
 */
type Setup = { codigo: string };

export default {
  nome: "89 — POST /localizacoes/lote aceita tipo packing",
  descricao: "Criação em lote com tipo='packing' não retorna 'tipo inválido'.",
  tags: ["localizacoes", "packing", "p173"],

  setup: async (ctx: Ctx): Promise<Setup> => ({ codigo: `PK89-${Date.now()}` }),

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const cwb = ctx.staging.galpoes.cwb;
    await ctx.http.post("/api/wms/localizacoes/lote", {
      galpao_id: cwb.id,
      prefixo: setup.codigo,
      h_inicio: 1,
      h_fim: 1,
      tipo: "packing",
    });
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data } = await ctx.sb
      .from("siso_localizacoes")
      .select("tipo")
      .ilike("codigo", `${setup.codigo}%`)
      .limit(1)
      .maybeSingle();
    if (!data || (data as { tipo: string }).tipo !== "packing") {
      throw new Error("Localização tipo 'packing' não foi criada.");
    }
  },
} satisfies Cenario<Setup>;

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

> Nota: confira o shape do body de `/api/wms/localizacoes/lote` (campos `prefixo/h_inicio/h_fim/tipo`) no `route.ts` ao escrever o cenário — ajuste os campos se o builder de códigos esperar nomes diferentes (`gerarCodigosLote`).

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- --only "89 — POST /localizacoes/lote aceita tipo packing"`
  Expected: FAIL — rota retorna tipo inválido (TIPOS_VALIDOS não inclui `packing`).

- [ ] **Step 3 — Implementação mínima.** Adicionar `"packing"` em cada um dos 4 arrays.

`src/lib/wms/types.ts:6-11`:

```ts
export type TipoLocalizacao =
  | "picking"
  | "overstock"
  | "recebimento"
  | "expedicao"
  | "quarentena"
  | "packing";
```

`src/app/api/wms/localizacoes/lote/route.ts:8-14` e `src/app/api/wms/localizacoes/[id]/route.ts:7-13` (mesmo array):

```ts
const TIPOS_VALIDOS: TipoLocalizacao[] = [
  "picking",
  "overstock",
  "recebimento",
  "expedicao",
  "quarentena",
  "packing",
];
```

`src/app/wms/localizacoes/page.tsx:16-22`:

```ts
const TIPOS: TipoLocalizacao[] = [
  "picking",
  "overstock",
  "recebimento",
  "expedicao",
  "quarentena",
  "packing",
];
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- --only "89 — POST /localizacoes/lote aceita tipo packing"`
  Expected: PASS. Rodar `npm run lint` (typecheck do union novo).

- [ ] **Step 5 — Commit.** `git add src/lib/wms/types.ts src/app/api/wms/localizacoes/lote/route.ts "src/app/api/wms/localizacoes/[id]/route.ts" src/app/wms/localizacoes/page.tsx scripts/wms/cenarios/catalogo/89-loc-tipo-packing.ts && git commit -m "fix(wms): tipo 'packing' válido no type/rotas/form de localização [P173]"`

### Task 3.3: SKU duplicado retorna 409 legível (P174)

**Files**
- Modify: `src/lib/wms/produtos.ts:124-139` (`criarProduto` traduz 23505)
- Modify: `src/app/api/wms/produtos/route.ts:52-71` (POST → 409 com mensagem)
- Test: `scripts/wms/cenarios/catalogo/90-produto-sku-duplicado.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/90-produto-sku-duplicado.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 90 — SKU duplicado retorna 409 legível (P174).
 * Cria um produto, depois POST com o mesmo sku deve dar 409 (não 500).
 */
type Setup = { sku: string };

export default {
  nome: "90 — POST /produtos com sku duplicado retorna 409 legível",
  descricao: "Segundo POST com mesmo sku → 409 + mensagem 'esse código já existe' (não 500).",
  tags: ["produtos", "sku", "duplicado", "p174"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("90");
    await ctx.criarProduto({ sku, descricao: "SKU dup base 90" });
    return { sku };
  },

  run: async (): Promise<void> => {
    /* assert-only */
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    let status = 0;
    let body: { error?: string } = {};
    try {
      await ctx.http.post("/api/wms/produtos", {
        sku: setup.sku,
        descricao: "SKU dup tentativa 90",
      });
    } catch (e) {
      const err = e as { status?: number; body?: { error?: string } };
      status = err.status ?? 0;
      body = err.body ?? {};
    }
    if (status !== 409) {
      throw new Error(`Esperava 409 para sku duplicado; recebeu ${status}.`);
    }
    if (!/já existe|ja existe/i.test(body.error ?? "")) {
      throw new Error(`Mensagem não é legível: "${body.error}"`);
    }
  },
} satisfies Cenario<Setup>;

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

> Nota: confira como o `http` helper do harness expõe o status/body em erro (ele lança em status >= 400?). Olhe `scripts/wms/cenarios/_harness/http.ts` — se o erro lançado não carregar `status`/`body`, ajuste o `try/catch` (ex.: ler `e.message` que contém o status). O contrato esperado é 409.

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- --only "90 — POST /produtos com sku duplicado retorna 409"`
  Expected: FAIL — hoje retorna 500 `internal_error` (23505 mascarado por `wmsErrorResponse`).

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/produtos.ts`, `criarProduto` (`:132-138`) — traduzir 23505 num erro tipado:

```ts
  const { data, error } = await sb
    .from("siso_produtos")
    .insert({ ...input, unidade: input.unidade ?? "UN" })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") {
      const dup = new Error("Esse código já existe") as Error & {
        codigo: string;
        sku: string;
      };
      dup.codigo = "sku_duplicado";
      dup.sku = input.sku;
      throw dup;
    }
    throw error;
  }
  return data as Produto;
```

Em `src/app/api/wms/produtos/route.ts`, POST (`:60-71`) — detectar o erro tipado antes do `wmsErrorResponse`:

```ts
  try {
    const produto = await criarProduto(body);
    return NextResponse.json(produto, { status: 201 });
  } catch (e) {
    if (e && typeof e === "object" && (e as { codigo?: string }).codigo === "sku_duplicado") {
      return NextResponse.json(
        { error: "Esse código já existe", sku: (e as { sku?: string }).sku },
        { status: 409 },
      );
    }
    return wmsErrorResponse({
      source: "wms.produtos.criar",
      error: e,
      requestPath: "/api/wms/produtos",
      requestMethod: "POST",
      metadata: { sku: body.sku },
    });
  }
```

> Frontend (modal de novo produto): ao receber 409 com `{error, sku}`, mostrar a mensagem e oferecer ação de buscar o SKU na lista. Localize o handler de criação de produto (chama `POST /api/wms/produtos`) e adicione o tratamento do 409. Mudança de UX best-effort; o contrato 409 é o que o teste trava.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- --only "90 — POST /produtos com sku duplicado retorna 409"`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/lib/wms/produtos.ts src/app/api/wms/produtos/route.ts scripts/wms/cenarios/catalogo/90-produto-sku-duplicado.ts && git commit -m "fix(wms): SKU duplicado retorna 409 legível (não 500) [P174]"`

### Task 3.4: Kit — quantidade de componente inválida retorna 400 legível (P121)

**Files**
- Modify: `src/app/api/wms/produtos/[id]/kit/route.ts:72-97` (guard `quantidade < 1` → 400)
- Test: `scripts/wms/cenarios/catalogo/91-kit-qty-invalida.ts` (Create)

> Frontend já valida (produto-drawer `:1606`/`:1834`); falta o 400 legível no servidor (hoje 500 genérico).

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/91-kit-qty-invalida.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 91 — kit com qty de componente <1 retorna 400 legível (P121).
 */
type Setup = { kitId: string };

export default {
  nome: "91 — POST /produtos/[id]/kit com quantidade 0 retorna 400 legível",
  descricao: "quantidade=0 (ou -5) → 400 com mensagem clara (não 500/internal_error).",
  tags: ["produtos", "kit", "quantidade", "p121"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const kitSku = ctx.skuUnico("91K");
    const compSku = ctx.skuUnico("91C");
    const kitId = await ctx.criarProduto({ sku: kitSku, descricao: "Kit 91" });
    await ctx.criarProduto({ sku: compSku, descricao: "Componente 91" });
    return { kitId };
  },

  run: async (): Promise<void> => {
    /* assert-only */
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: comp } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .ilike("sku", "%91C%")
      .limit(1)
      .single();
    const compId = (comp as { id: string }).id;
    let status = 0;
    let body: { error?: string } = {};
    try {
      await ctx.http.post(`/api/wms/produtos/${setup.kitId}/kit`, {
        componente_produto_id: compId,
        quantidade: 0,
      });
    } catch (e) {
      const err = e as { status?: number; body?: { error?: string } };
      status = err.status ?? 0;
      body = err.body ?? {};
    }
    if (status !== 400) {
      throw new Error(`Esperava 400 para quantidade 0; recebeu ${status}.`);
    }
    if (!/quantidade/i.test(body.error ?? "")) {
      throw new Error(`Mensagem não menciona quantidade: "${body.error}"`);
    }
  },
} satisfies Cenario<Setup>;

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

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- --only "91 — POST /produtos/[id]/kit com quantidade 0"`
  Expected: FAIL — hoje retorna 500 `internal_error` (Error de `upsertComponente` mascarado).

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/produtos/[id]/kit/route.ts`, adicionar guard explícito antes de `upsertComponente` (`:72-77`):

```ts
  if (!body.componente_produto_id || typeof body.quantidade !== "number") {
    return NextResponse.json(
      { error: "componente_produto_id e quantidade obrigatórios" },
      { status: 400 },
    );
  }
  if (!Number.isInteger(body.quantidade) || body.quantidade < 1) {
    return NextResponse.json(
      { error: "quantidade deve ser um inteiro >= 1" },
      { status: 400 },
    );
  }
```

> `src/lib/wms/kits.ts:217-219` mantém a validação existente (mensagem clara) como backstop.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- --only "91 — POST /produtos/[id]/kit com quantidade 0"`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add "src/app/api/wms/produtos/[id]/kit/route.ts" scripts/wms/cenarios/catalogo/91-kit-qty-invalida.ts && git commit -m "fix(wms): kit qty componente <1 retorna 400 legível (não 500) [P121]"`

### Task 3.5: Reativar vínculo de fornecedor no reimport (P178)

**Files**
- Modify: `src/lib/wms/fornecedores.ts:244-251` (payload do upsert inclui `ativo: true`)
- Test: `test/integration/fornecedor-upsert-reativa.test.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/fornecedor-upsert-reativa.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { upsertProdutoFornecedor } from "../../src/lib/wms/fornecedores";

const sb = createServiceClient();
let produtoId: string;
let fornecedorId: string;
const SKU = `TEST-PF-REATIVA-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "PF reativa test", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;
  const { data: f } = await sb
    .from("siso_fornecedores")
    .insert({ nome: `Forn reativa ${SKU}`, ativo: true })
    .select("id")
    .single();
  fornecedorId = f!.id;
  // cria vínculo soft-deletado (ativo=false) com lead time existente
  await sb.from("siso_produto_fornecedores").insert({
    produto_id: produtoId,
    fornecedor_id: fornecedorId,
    ativo: false,
    lead_time_dias_medio: 11,
  });
});

describe("upsertProdutoFornecedor (P178 — reativa vínculo soft-deletado)", () => {
  it("reimport reativa o vínculo e preserva o lead time existente", async () => {
    await upsertProdutoFornecedor({
      produto_id: produtoId,
      fornecedor_id: fornecedorId,
      codigo_fornecedor: "REATIVA-1",
    });
    const { data } = await sb
      .from("siso_produto_fornecedores")
      .select("ativo, lead_time_dias_medio")
      .eq("produto_id", produtoId)
      .eq("fornecedor_id", fornecedorId)
      .single();
    expect(data!.ativo).toBe(true);
    expect(Number(data!.lead_time_dias_medio)).toBe(11);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- fornecedor-upsert-reativa`
  Expected: FAIL com `expected false to be true` — o upsert mantém `ativo=false`.

- [ ] **Step 3 — Implementação mínima.** Em `src/lib/wms/fornecedores.ts`, incluir `ativo: true` no payload do upsert (`:244-251`):

```ts
  const payload: Record<string, unknown> = {
    produto_id: input.produto_id,
    fornecedor_id: input.fornecedor_id,
    codigo_fornecedor: input.codigo_fornecedor ?? null,
    custo_unitario: input.custo_unitario ?? null,
    preferencial: input.preferencial ?? false,
    ativo: true,
    atualizado_em: new Date().toISOString(),
  };
```

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- fornecedor-upsert-reativa`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add src/lib/wms/fornecedores.ts test/integration/fornecedor-upsert-reativa.test.ts && git commit -m "fix(wms): reimport reativa vínculo de fornecedor soft-deletado (preserva lead time/custo) [P178]"`

### Task 3.6: Bloquear delete de fornecedor com vínculos ativos (P179)

**Files**
- Modify: `src/app/api/wms/fornecedores/[id]/route.ts:105-116` (DELETE preflight → 409)
- Test: `scripts/wms/cenarios/catalogo/92-fornecedor-delete-bloqueia-vinculos.ts` (Create)

- [ ] **Step 1 — Escrever o teste que falha.** Criar `scripts/wms/cenarios/catalogo/92-fornecedor-delete-bloqueia-vinculos.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 92 — DELETE de fornecedor com vínculo ativo retorna 409 (P179).
 */
type Setup = { fornecedorId: string };

export default {
  nome: "92 — DELETE /fornecedores/[id] com vínculo ativo retorna 409",
  descricao: "Fornecedor com ≥1 vínculo ativo: DELETE → 409 e não seta ativo=false.",
  tags: ["fornecedores", "delete", "vinculos", "p179"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("92");
    const produtoId = await ctx.criarProduto({ sku, descricao: "Forn delete 92" });
    const fornecedorId = await ctx.criarFornecedor({ nome: `Forn 92 ${Date.now()}` });
    await ctx.sb.from("siso_produto_fornecedores").insert({
      produto_id: produtoId,
      fornecedor_id: fornecedorId,
      ativo: true,
    });
    return { fornecedorId };
  },

  run: async (): Promise<void> => {
    /* assert-only */
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    let status = 0;
    let body: { error?: string } = {};
    try {
      await ctx.http.delete(`/api/wms/fornecedores/${setup.fornecedorId}`);
    } catch (e) {
      const err = e as { status?: number; body?: { error?: string } };
      status = err.status ?? 0;
      body = err.body ?? {};
    }
    if (status !== 409) {
      throw new Error(`Esperava 409 (fornecedor com vínculos); recebeu ${status}.`);
    }
    if (!/vínculo|vinculo/i.test(body.error ?? "")) {
      throw new Error(`Mensagem não cita vínculos: "${body.error}"`);
    }
    const { data } = await ctx.sb
      .from("siso_fornecedores")
      .select("ativo")
      .eq("id", setup.fornecedorId)
      .single();
    if ((data as { ativo: boolean }).ativo !== true) {
      throw new Error("Fornecedor foi desativado apesar do 409.");
    }
  },
} satisfies Cenario<Setup>;

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

- [ ] **Step 2 — Rodar e ver falhar.** `npm run scenarios -- --only "92 — DELETE /fornecedores/[id] com vínculo ativo"`
  Expected: FAIL — hoje o DELETE sempre seta `ativo=false` e retorna 200.

- [ ] **Step 3 — Implementação mínima.** Em `src/app/api/wms/fornecedores/[id]/route.ts`, DELETE (`:105-116`) — preflight de vínculos ativos:

```ts
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = createServiceClient();

  const { count } = await sb
    .from("siso_produto_fornecedores")
    .select("id", { count: "exact", head: true })
    .eq("fornecedor_id", id)
    .eq("ativo", true);

  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: `Não é possível deletar: fornecedor tem ${count} vínculo(s) ativo(s).` },
      { status: 409 },
    );
  }

  await sb.from("siso_fornecedores").update({ ativo: false }).eq("id", id);
  return NextResponse.json({ ok: true });
}
```

> Frontend (UI de fornecedores): ao receber 409, mostrar quantos vínculos precisam ser removidos (mensagem do backend já carrega a contagem). Mudança de UX best-effort.

- [ ] **Step 4 — Rodar e ver passar.** `npm run scenarios -- --only "92 — DELETE /fornecedores/[id] com vínculo ativo"`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add "src/app/api/wms/fornecedores/[id]/route.ts" scripts/wms/cenarios/catalogo/92-fornecedor-delete-bloqueia-vinculos.ts && git commit -m "fix(wms): bloquear delete de fornecedor com vínculos ativos (409) [P179]"`

### Task 3.7: Migration — lead time default 7d na MV de cobertura (P079)

**Files**
- Create: `supabase/migrations/20260605_cobertura_lead_default.sql`
- Test: `test/integration/cobertura-lead-default.test.ts` (Create)

> **Definição real da MV no staging (verificada via `pg_get_viewdef`):** o CASE é, nesta ordem, `sem_giro` → `<7 critico` → `<14 atencao` → `lead_time_dias_medio IS NOT NULL AND <lead → lead_time_risco` → `ok`. Como `<14 atencao` vem ANTES do ramo de lead, esse ramo é **morto** (cobertura abaixo de 14 sempre cai em `atencao`/`critico` primeiro; lead típico é <14). Resultado: um produto com fornecedor preferencial cujo lead é maior que a cobertura nunca dispara `lead_time_risco`.
>
> Nota P079 (vinculante) = "assumir 7 dias por padrão quando tempo de entrega vazio (NÃO forçar preenchimento)". A intenção é: lead ausente/curto não pode virar silêncio. O fix tem DUAS partes acopladas e só faz sentido juntas: (1) `COALESCE(lp.lead_time_dias_medio, 7)` (o lead NULL vira 7 em vez de pular o ramo), e (2) **reordenar** o CASE para avaliar `lead_time_risco` (cobertura < lead) ANTES de `atencao`, senão o ramo continua morto e o COALESCE não tem efeito observável. O teste abaixo é construído para que o RED↔GREEN seja determinístico: um produto com fornecedor preferencial `lead=10` e `dias_cobertura=8` (∈ [7,10)) hoje retorna `atencao` (RED) e, após o fix, `lead_time_risco` (GREEN).
>
> Por que não usar "sem fornecedor preferencial + COALESCE 7": com lead NULL→7, o ramo de lead só dispararia para `cobertura < 7`, faixa que o ramo `critico (<7)` já cobre — então a parte COALESCE-7 **sozinha** não muda status algum (é subsumida por `critico`). O efeito observável de P079 vem da reordenação somada a um lead real > 7. Por isso o seed usa um fornecedor preferencial com `lead=10`.

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/cobertura-lead-default.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let produtoId: string;
let fornecedorId: string;
let galpaoId: string;
let locId: string;
const SKU = `TEST-COB-LEAD-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  // A-01-01 é loc picking real em CWB (verificado no staging).
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("codigo", "A-01-01")
    .single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "Cobertura lead test", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;

  // Fornecedor preferencial com lead = 10 dias. O ramo lead_time_risco do CASE
  // só é alcançável após o fix (reordenação + COALESCE). Com cobertura = 8 (< 10),
  // hoje o status cai em 'atencao' (< 14); após o fix vira 'lead_time_risco'.
  const { data: f } = await sb
    .from("siso_fornecedores")
    .insert({ nome: `Forn cobertura ${SKU}`, ativo: true })
    .select("id")
    .single();
  fornecedorId = f!.id;
  await sb.from("siso_produto_fornecedores").insert({
    produto_id: produtoId,
    fornecedor_id: fornecedorId,
    preferencial: true,
    ativo: true,
    lead_time_dias_medio: 10,
  });

  // Saldo disponível = 4 e giro_diario = 0.5 => dias_cobertura = 4 / 0.5 = 8 (∈ [7,10)).
  // Entrada de 19 e venda de 15 em 30d: saldo 4; giro = SUM(S)/30 = 15/30 = 0.5.
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: locId,
    p_tipo: "E",
    p_quantidade: 19,
    p_origem_tipo: "inventario_inicial",
    p_origem_id: null,
    p_custo_unitario: 1,
    p_motivo: "seed cobertura",
  });
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: locId,
    p_tipo: "S",
    p_quantidade: 15,
    p_origem_tipo: "venda_manual",
    p_origem_id: null,
    p_custo_unitario: 1,
    p_motivo: "venda seed",
  });

  await sb.rpc("wms_refresh_cobertura");
});

describe("siso_cobertura_estoque — lead default 7d / ramo lead_time_risco (P079)", () => {
  it("fornecedor preferencial lead=10 e dias_cobertura=8 vira 'lead_time_risco' (não 'atencao')", async () => {
    const { data } = await sb
      .from("siso_cobertura_estoque")
      .select("status_cobertura, dias_cobertura, lead_time_medio")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .single();
    // dias_cobertura = 8: abaixo do lead (10), acima de 7, abaixo de 14.
    expect(Number(data!.dias_cobertura)).toBeCloseTo(8, 5);
    expect(Number(data!.lead_time_medio)).toBe(10);
    expect(data!.status_cobertura).toBe("lead_time_risco");
  });
});
```

> Por que o RED↔GREEN é coerente: hoje (MV verificada no staging) o CASE avalia `< 14 → 'atencao'` ANTES do ramo de lead, então `dias_cobertura=8` retorna `'atencao'` (RED). O fix reordena o ramo `lead_time_risco` (`cobertura < COALESCE(lead, 7)`) para ANTES de `'atencao'`; com `lead=10` e cobertura `8`, `8 < 10` dispara `'lead_time_risco'` (GREEN). O seed produz `dias_cobertura` exatamente 8 (saldo 4 / giro 0.5), valor escolhido para ficar estritamente entre 7 e o lead 10 — sem ambiguidade de fronteira.

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- cobertura-lead-default`
  Expected: FAIL na asserção `status_cobertura` — vem `'atencao'` (porque o CASE atual avalia `< 14 → 'atencao'` antes do ramo de lead), não `'lead_time_risco'`.

- [ ] **Step 3 — Implementação mínima.** Criar `supabase/migrations/20260605_cobertura_lead_default.sql`. Recria a MV com `COALESCE(lp.lead_time_dias_medio, 7)` e reordena o CASE para avaliar `lead_time_risco` (cobertura abaixo do lead) ANTES de `atencao`, mantendo `critico` primeiro:

```sql
-- P079: (1) lead ausente assume 7 dias via COALESCE(lp.lead_time_dias_medio, 7);
-- (2) ramo 'lead_time_risco' (cobertura < lead) reordenado para ANTES de 'atencao'
-- (<14). Antes esse ramo era morto: '<14 -> atencao' vinha primeiro, então um
-- produto com fornecedor preferencial de lead longo nunca era sinalizado.
-- Recria a MV + índices + função de refresh (shape idêntico ao staging, só o CASE muda).

DROP MATERIALIZED VIEW IF EXISTS siso_cobertura_estoque;

CREATE MATERIALIZED VIEW siso_cobertura_estoque AS
WITH giro_30d AS (
  SELECT produto_id, galpao_id,
         SUM(quantidade) / 30.0 AS giro_diario
  FROM siso_movimentacoes
  WHERE tipo = 'S'
    AND origem_tipo IN ('nf_venda','venda_manual')
    AND criado_em >= now() - interval '30 days'
    AND estorno_de IS NULL
  GROUP BY produto_id, galpao_id
),
saldo_agregado AS (
  SELECT produto_id, galpao_id,
         SUM(disponivel) AS disponivel_total
  FROM siso_estoque
  GROUP BY produto_id, galpao_id
),
lead_pref AS (
  SELECT pf.produto_id, pf.lead_time_dias_medio
  FROM siso_produto_fornecedores pf
  WHERE pf.preferencial = true AND pf.ativo = true
)
SELECT
  s.produto_id,
  s.galpao_id,
  s.disponivel_total,
  COALESCE(g.giro_diario, 0) AS giro_diario,
  CASE WHEN g.giro_diario > 0
       THEN s.disponivel_total / g.giro_diario
       ELSE NULL END AS dias_cobertura,
  COALESCE(lp.lead_time_dias_medio, 7) AS lead_time_medio,
  CASE
    WHEN g.giro_diario IS NULL OR g.giro_diario = 0 THEN 'sem_giro'
    WHEN s.disponivel_total / g.giro_diario < 7 THEN 'critico'
    WHEN s.disponivel_total / g.giro_diario < COALESCE(lp.lead_time_dias_medio, 7)
      THEN 'lead_time_risco'
    WHEN s.disponivel_total / g.giro_diario < 14 THEN 'atencao'
    ELSE 'ok'
  END AS status_cobertura
FROM saldo_agregado s
LEFT JOIN giro_30d g USING (produto_id, galpao_id)
LEFT JOIN lead_pref lp USING (produto_id);

CREATE UNIQUE INDEX uq_cobertura
  ON siso_cobertura_estoque(produto_id, galpao_id);
CREATE INDEX idx_cobertura_status
  ON siso_cobertura_estoque(status_cobertura, dias_cobertura);

CREATE OR REPLACE FUNCTION wms_refresh_cobertura() RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW siso_cobertura_estoque;
$$;
```

Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (name: `cobertura_lead_default`).

> Nota de divergência do achado (resolvida nos artefatos): o achado P079 pede COALESCE só na coluna de saída e no ramo `lead_time_risco` mantendo a ordem. Mas a MV real (verificada via `pg_get_viewdef` no staging) tem `dias_cobertura < 14 → 'atencao'` ANTES do ramo de lead — então o ramo lead é morto. Esta migration faz as duas mudanças acopladas e nada mais: (1) `COALESCE(lp.lead_time_dias_medio, 7)` e (2) reordenar `lead_time_risco` para ANTES de `atencao`. Os ramos `sem_giro`/`critico`/`ok` ficam idênticos. Esse é exatamente o shape do bloco SQL acima — não há nada a "decidir" depois: o RED↔GREEN é fechado pelo seed do Step 1 (`lead=10`, cobertura `8` → hoje `atencao`, depois `lead_time_risco`).
>
> Conferência determinística do GREEN (opcional, não substitui o teste): após aplicar a migration, `mcp__supabase__execute_sql` em
> `SELECT status_cobertura FROM siso_cobertura_estoque WHERE produto_id = '<id do seed>'` deve retornar `lead_time_risco`. O teste de integração do Step 4 é a verificação canônica.
>
> ⚠️ Coordenação com P128 (Fase 2): o mestre tem um PR "Recriar MV siso_cobertura_estoque no shape 3D (reverte regressão 20260605)". Esta migration deve ser aplicada DEPOIS de P128 ou ser rebaseada sobre o shape canônico que P128 deixar. Conferir o estado da MV no staging antes de aplicar; se P128 já recriou a MV com outro shape, portar o COALESCE/reordenação para cima do shape vigente. Não duplicar colunas.

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- cobertura-lead-default`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add supabase/migrations/20260605_cobertura_lead_default.sql test/integration/cobertura-lead-default.test.ts && git commit -m "fix(wms): cobertura — lead default 7d (COALESCE) + ramo lead_time_risco antes de atencao [P079]"`

### Task 3.8: Migration — bloquear delete de galpão preferencial (FK RESTRICT) (P133)

**Files**
- Create: `supabase/migrations/20260605_galpao_pref_restrict.sql`
- Test: `test/integration/galpao-delete-restrict.test.ts` (Create)

> A FK `siso_empresa_galpoes_preferenciais.galpao_id` é `ON DELETE CASCADE` (migration `20260514`, `:17`) — deletar galpão remove silenciosamente os preferenciais. Não há rota DELETE de galpão (só PUT em `admin/galpoes/[id]/route.ts`), então o fix durável é DB-level (RESTRICT). Nota P133 = bloquear delete se é preferencial ou tem estoque/pedido.

- [ ] **Step 1 — Escrever o teste que falha.** Criar `test/integration/galpao-delete-restrict.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let empresaId: string;
let galpaoId: string;
const NOME = `GAL-RESTRICT-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: g } = await sb
    .from("siso_galpoes")
    .insert({ nome: NOME, ativo: true })
    .select("id")
    .single();
  galpaoId = g!.id;
  const { data: e } = await sb
    .from("siso_empresas")
    .insert({ nome: `Emp ${NOME}`, cnpj: `0000${Date.now()}`.slice(0, 14), ativo: true })
    .select("id")
    .single();
  empresaId = e!.id;
  await sb
    .from("siso_empresa_galpoes_preferenciais")
    .insert({ empresa_id: empresaId, galpao_id: galpaoId });
});

describe("FK galpao preferencial — ON DELETE RESTRICT (P133)", () => {
  it("deletar galpão que é preferencial de uma empresa falha por FK", async () => {
    const { error } = await sb.from("siso_galpoes").delete().eq("id", galpaoId);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503"); // foreign_key_violation
    // galpão segue existindo
    const { data } = await sb.from("siso_galpoes").select("id").eq("id", galpaoId).maybeSingle();
    expect(data?.id).toBe(galpaoId);
  });
});
```

- [ ] **Step 2 — Rodar e ver falhar.** `npm run test:integration -- galpao-delete-restrict`
  Expected: FAIL — o delete CASCATEIA (sucesso, sem erro): o `expect(error).not.toBeNull()` falha.

- [ ] **Step 3 — Implementação mínima.** Criar `supabase/migrations/20260605_galpao_pref_restrict.sql`. Troca a FK de CASCADE para RESTRICT (nome default `siso_empresa_galpoes_preferenciais_galpao_id_fkey`):

```sql
-- P133: impede delete de galpão que é preferencial de alguma empresa.
-- A FK galpao_id era ON DELETE CASCADE (remoção silenciosa dos preferenciais).
-- Troca para ON DELETE RESTRICT: deletar o galpão falha enquanto houver
-- preferencial apontando pra ele (backstop DB-level; não há rota DELETE hoje).

ALTER TABLE siso_empresa_galpoes_preferenciais
  DROP CONSTRAINT IF EXISTS siso_empresa_galpoes_preferenciais_galpao_id_fkey;

ALTER TABLE siso_empresa_galpoes_preferenciais
  ADD CONSTRAINT siso_empresa_galpoes_preferenciais_galpao_id_fkey
  FOREIGN KEY (galpao_id) REFERENCES siso_galpoes(id) ON DELETE RESTRICT;
```

Aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (name: `galpao_pref_restrict`).

> Nota: antes de aplicar, confirme o nome real da constraint no staging com `mcp__supabase__execute_sql`: `SELECT conname FROM pg_constraint WHERE conrelid='siso_empresa_galpoes_preferenciais'::regclass AND contype='f' AND 'galpao_id' = ANY(SELECT attname FROM pg_attribute WHERE attrelid=conrelid AND attnum=ANY(conkey))`. Se o nome divergir do default, ajustar o `DROP CONSTRAINT`. O `IF EXISTS` torna o drop seguro; a re-criação usa o nome canônico.
>
> Escopo: esta migration cobre só a FK de `preferenciais` (o cascade silencioso que a nota cita como crítico). Estoque/pedidos (`siso_estoque.galpao_id`, `siso_pedidos.separacao_galpao_id`) já bloqueiam delete por suas próprias FKs (não-CASCADE) ou seriam tratados num guard de rota futura — fora do escopo deste fix cirúrgico (não há rota DELETE de galpão).

- [ ] **Step 4 — Rodar e ver passar.** `npm run test:integration -- galpao-delete-restrict`
  Expected: PASS.

- [ ] **Step 5 — Commit.** `git add supabase/migrations/20260605_galpao_pref_restrict.sql test/integration/galpao-delete-restrict.test.ts && git commit -m "fix(wms): FK galpao preferencial vira ON DELETE RESTRICT (bloqueia delete) [P133]"`

### Task 3.9: Registrar bug-fixes em erros-conhecidos.yaml (PR 3)

**Files**
- Modify: `erros-conhecidos.yaml`

- [ ] **Step 1 — Adicionar entradas.**

```yaml
  - id: wms-transferencia-qty-fracionaria
    date: "2026-06-05"
    source: wms.transferencia.inter-galpao
    category: validation
    message: "Transferência aceita quantidade fracionária (12.5) e quebra faturamento/picking"
    cause: >
      itensValidos só checava Number(qty) > 0; input type=number sem step
      aceitava decimais.
    fix: >
      Predicado qtyTransferenciaValida (Number.isInteger && > 0) na validação
      + step="1" nos inputs de qty.
    files:
      - src/components/wms/ui/qty-transferencia.ts
      - src/components/wms/ui/modals.tsx
    tags: [transferencia, quantidade, inteiro, p162]

  - id: wms-localizacao-packing-nao-aceita
    date: "2026-06-05"
    source: wms.localizacoes
    category: validation
    message: "Formulário/rotas rejeitam tipo 'packing' embora o DB aceite"
    cause: >
      O CHECK do DB inclui 'packing' (20260528) mas TipoLocalizacao e os arrays
      TIPOS_VALIDOS/TIPOS não tinham — desalinhamento app↔DB.
    fix: >
      Adicionado 'packing' ao type e aos 3 arrays (lote, [id], page).
    files:
      - src/lib/wms/types.ts
      - src/app/api/wms/localizacoes/lote/route.ts
      - src/app/api/wms/localizacoes/[id]/route.ts
      - src/app/wms/localizacoes/page.tsx
    tags: [localizacao, packing, cross-docking, p173]

  - id: wms-produto-sku-duplicado-500
    date: "2026-06-05"
    source: wms.produtos.criar
    category: validation
    message: "SKU duplicado retorna 500 internal_error em vez de 409 legível"
    cause: >
      Violação unique (23505) não era mapeada; caía no wmsErrorResponse default
      (5xx mascarado).
    fix: >
      criarProduto traduz 23505 em erro tipado 'sku_duplicado'; a rota POST
      retorna 409 com {error:'Esse código já existe', sku}.
    files:
      - src/lib/wms/produtos.ts
      - src/app/api/wms/produtos/route.ts
    tags: [produtos, sku, 23505, p174]

  - id: wms-kit-qty-componente-500
    date: "2026-06-05"
    source: wms.produtos.kit.upsert
    category: validation
    message: "Quantidade de componente <1 no kit retorna 500 genérico"
    cause: >
      upsertComponente lançava Error comum (mascarado pra internal_error); a
      rota não validava quantidade antes.
    fix: >
      Guard na rota: quantidade inteira >= 1 → 400 legível antes de chamar
      upsertComponente.
    files:
      - src/app/api/wms/produtos/[id]/kit/route.ts
    tags: [kit, quantidade, p121]

  - id: wms-fornecedor-vinculo-nao-reativa
    date: "2026-06-05"
    source: wms.fornecedores.upsert
    category: business_logic
    message: "Reimport do Tiny não reativa vínculo de fornecedor soft-deletado"
    cause: >
      O payload do upsert nunca setava ativo=true; vínculo conflitante seguia
      ativo=false (histórico/lead time inacessível).
    fix: >
      Incluído ativo:true no payload de upsertProdutoFornecedor.
    files:
      - src/lib/wms/fornecedores.ts
    tags: [fornecedor, vinculo, reimport, p178]

  - id: wms-fornecedor-delete-orfana-vinculos
    date: "2026-06-05"
    source: wms.fornecedores.delete
    category: business_logic
    message: "Deletar fornecedor com vínculos ativos deixa vínculos órfãos visíveis"
    cause: >
      O DELETE só setava fornecedor.ativo=false sem verificar vínculos ativos
      em siso_produto_fornecedores.
    fix: >
      Preflight: se há vínculo ativo, retorna 409 com a contagem; só desativa
      sem vínculos ativos.
    files:
      - src/app/api/wms/fornecedores/[id]/route.ts
    tags: [fornecedor, delete, vinculos, p179]

  - id: wms-cobertura-lead-ausente-ok
    date: "2026-06-05"
    source: wms.cobertura
    category: business_logic
    message: "Cobertura nunca dispara 'lead_time_risco' (ramo morto) e lead ausente vira silêncio"
    cause: >
      Na MV siso_cobertura_estoque o ramo '< 14 -> atencao' vinha ANTES do ramo
      de lead, tornando 'lead_time_risco' inalcançável (cobertura abaixo de 14
      sempre caía em atencao/critico). Além disso o ramo de lead exigia
      lead_time_dias_medio NOT NULL, então lead vazio não gerava risco.
    fix: >
      Recriada a MV com COALESCE(lead_time_dias_medio, 7) e o ramo lead_time_risco
      ('cobertura < COALESCE(lead, 7)') reordenado para ANTES de 'atencao'.
    files:
      - supabase/migrations/20260605_cobertura_lead_default.sql
    tags: [cobertura, lead-time, mview, p079]

  - id: wms-galpao-delete-cascade-pref
    date: "2026-06-05"
    source: wms.admin.galpoes
    category: database
    message: "Deletar galpão remove preferenciais via CASCADE (empresa fica sem roteamento)"
    cause: >
      FK siso_empresa_galpoes_preferenciais.galpao_id era ON DELETE CASCADE.
    fix: >
      FK trocada para ON DELETE RESTRICT (backstop DB-level).
    files:
      - supabase/migrations/20260605_galpao_pref_restrict.sql
    tags: [galpao, preferencial, fk, restrict, p133]
```

- [ ] **Step 2 — Commit.** `git add erros-conhecidos.yaml && git commit -m "docs(erros): pointwise cadastros (lead, qty inteira, packing, sku, fornecedor, kit, galpão) [P079,P121,P133,P162,P173,P174,P178,P179]"`

---

## Ordem de execução e dependências

- **PR 1** (relatório): sem migration, sem deps. P107 antes ou junto de P105 (mesmo route). Quick wins: P158, P107.
- **PR 2** (impressão): P144 antes de P142 (mesmo bloco try). P143 (migration cron) e P183 (cache) independentes. P141 (preview) independente. Quick win: P143.
- **PR 3** (cadastros): tasks independentes; P079 (migration MV) deve respeitar P128 da Fase 2 (coordenação anotada). P133 (migration FK) independente. Quick wins: P173, P174.

Ao fim de cada PR: `npm run lint` + `npm test` + (PRs com migration) `npm run test:integration` + (PRs com cenário) `npm run scenarios`. Atualizar `docs/` se algum fluxo/rota mudou (PR2 adiciona o GET de preview em `admin/printnode/contas/[id]` — atualizar `docs/api-reference-complete.md`).
