# Raio-X Fase 1 — Fundações Atômicas Implementation Plan

For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development

**Goal**

Estabelecer as duas primitivas-fundação que dominam todo o resto da remediação do raio-x — **(A) claim atômico de header** (`UPDATE ... WHERE id=$1 AND status=<esperado> [AND lock IS NULL] RETURNING`) e **(B) envelope de RPC plpgsql transacional** (`SELECT FOR UPDATE` da âncora + N mutações + status na mesma transação) — provando-as no **menor blast-radius** possível antes de aplicá-las aos domínios críticos (fases 4–5). Cada PR fecha uma classe de corrida concreta (duplo-clique, dois operadores, worker crashado, dois admins) com TDD estrito.

Cobre os 13 problemas da Fase 1: **P145, P062, P068, P066, P127, P160, P130, P129, P131, P021, P138, P139, P052**.

**Architecture**

- **Backend:** Next.js 16 App Router. Toda lógica de domínio em `src/lib/wms/*`; rotas finas em `src/app/api/wms/**/route.ts`. DB no server só via `createServiceClient()` (service role, bypassa RLS).
- **Atomicidade:** `supabase-js` **não tem transação multi-statement no cliente**. Quando "tudo-ou-nada" envolve >1 statement (delete+insert, soma sob lock, claim+movs), a transação **obriga** RPC plpgsql aplicada via `mcp__supabase__apply_migration` no project **`ehbxpbeijofxtsbezwxd`** (staging). Quando é só compare-and-set de um header, basta `UPDATE ... .eq(status).select()` no TS (1 statement = atômico no Postgres).
- **Ledger:** `wms_inserir_movimentacao` é o único write do ledger. Nenhum PR desta fase toca o ledger central — só metadados de header/fila/role/item.
- **Gotchas que esta fase respeita:** `siso_pedidos.id` é **text**; `siso_pedido_itens.id` é **bigint** (supabase-js serializa como string no JSON, mas a RPC declara `bigint`); `siso_pedido_itens.produto_id` é **tiny_produto_id**; `siso_devolucoes_pendentes.status` tem CHECK `IN ('aguardando_classificacao','classificada','aplicada','cancelada')` — **não existe** `classificando`, então o claim de P052 compara-e-seta direto pra `classificada`.

**Tech Stack**

- TypeScript 5.9 strict · Next.js 16.1.6 · Supabase (`@supabase/supabase-js`) · plpgsql RPCs.
- Testes: **vitest unit** (`npm test -- <arquivo>`, `src/**/*.test.ts`), **integration** (`npm run test:integration`, `test/integration/**/*.test.ts`, serializado vs staging real, trunca tabelas operacionais), **scenarios E2E HTTP** (`npm run scenarios`, `scripts/wms/cenarios/catalogo/NN-*.ts`).
- Migrations: arquivo `supabase/migrations/YYYYMMDD_descricao.sql` + aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`.

> **Nota de ancoragem:** todos os change_sites abaixo foram abertos no HEAD atual. Onde uma linha citada no achado divergiu, marquei com `> Nota: divergência do achado`.

---

## PR 1: Reclaim de jobs estagnados na fila (timeout 5min volta a pendente) [P145]

**Problema (P145, grave):** `processQueue` em `src/lib/execution-worker.ts` só seleciona jobs com `.eq("status","pendente")` e faz claim atômico `update status='executando' ... .eq("status","pendente")`. Se o worker morre entre o claim (l.140-149) e o update final, o job fica `executando` **para sempre** — nenhuma rotina o devolve pra `pendente`. Pedidos não saem da fila, estoque não é lançado.

**Decisão do dono (NOTA):** *"timeout 5min: tarefa em progresso há +5min volta pra fila e worker reprocessa"* (opção 1). Reprocessar é seguro: `executeJob`/worker-wms já é idempotente por reserva (`estorno_de`) e por `estoque_lancado`.

> Nota: divergência do achado — o achado cita "src/lib/execution-worker.ts:122-132" como ponto do SELECT; no HEAD atual o SELECT de pendentes está em **l.123-132** e o claim com `atualizado_em` em **l.140-149**. `atualizado_em` já é escrito no claim (l.144), serve de marca de início. Sem migration — `atualizado_em` e `proximo_retry_em` já existem em `siso_fila_execucao`.

### Task 1.1: Reclamar jobs `executando` estagnados >5min antes de selecionar pendentes

**Files**
- Modify `src/lib/execution-worker.ts:122-132` — inserir reclaim antes do SELECT de pendentes.
- Test (Create) `test/integration/reclaim-timeout.test.ts`

> **Onde mora o teste:** `vitest.integration.config.ts` tem `include: ["test/integration/**/*.test.ts"]` (e `globalSetup: test/integration/globalSetup.ts` que limpa+seeda staging). Um teste de integração **precisa** ficar em `test/integration/*.test.ts` — só assim `npm run test:integration -- <nome>` o casa e o globalSetup roda. Os imports daí pra `src/` são `../../src/lib/...` (mesmo padrão de `test/integration/ledger-rpc.test.ts`).

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Crie `test/integration/reclaim-timeout.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { processQueue } from "../../src/lib/execution-worker";

const sb = createServiceClient();
const PEDIDO_ID = `RECLAIM-TEST-${Math.random().toString(36).slice(2, 8)}`;
let empresaId: string;
let staleJobId: string;
let freshJobId: string;

beforeAll(async () => {
  const { data: e } = await sb
    .from("siso_empresas")
    .select("id")
    .eq("ativo", true)
    .order("criado_em", { ascending: true })
    .limit(1)
    .single();
  empresaId = e!.id;

  // Pedido cancelado: o worker pula o job (não toca Tiny), mas o reclaim
  // já deve ter rodado ANTES desse skip. Isolamos só o comportamento de reclaim.
  // siso_pedidos tem NOT NULL em numero/data/filial_origem (colunas legadas) —
  // incluir nos fixtures de teste (o webhook real preenche; o insert direto não).
  await sb.from("siso_pedidos").insert({
    id: PEDIDO_ID,
    numero: PEDIDO_ID,
    data: new Date().toISOString(),
    filial_origem: "TEST",
    status: "cancelado",
    empresa_origem_id: empresaId,
  });

  const seisMinAtras = new Date(Date.now() - 6 * 60_000).toISOString();
  const agora = new Date().toISOString();

  // Job ESTAGNADO: executando há 6min.
  const { data: stale } = await sb
    .from("siso_fila_execucao")
    .insert({
      pedido_id: PEDIDO_ID,
      empresa_id: empresaId,
      tipo: "lancar_estoque",
      decisao: "propria",
      status: "executando",
      tentativas: 0,
      atualizado_em: seisMinAtras,
    })
    .select("id")
    .single();
  staleJobId = stale!.id;

  // Job FRESCO: executando há <5min — NÃO deve ser reclamado.
  const { data: fresh } = await sb
    .from("siso_fila_execucao")
    .insert({
      pedido_id: PEDIDO_ID,
      empresa_id: empresaId,
      tipo: "lancar_estoque",
      decisao: "propria",
      status: "executando",
      tentativas: 0,
      atualizado_em: agora,
    })
    .select("id")
    .single();
  freshJobId = fresh!.id;
});

afterAll(async () => {
  await sb.from("siso_fila_execucao").delete().in("id", [staleJobId, freshJobId]);
  await sb.from("siso_pedidos").delete().eq("id", PEDIDO_ID);
});

describe("processQueue — reclaim de jobs estagnados", () => {
  it("job 'executando' há >5min volta a ser processável (sai de executando)", async () => {
    await processQueue(20);
    const { data: job } = await sb
      .from("siso_fila_execucao")
      .select("status")
      .eq("id", staleJobId)
      .single();
    // Foi reclamado → ou re-selecionado e pulado (pedido cancelado → 'cancelado'),
    // ou voltou a 'pendente'. O essencial: NÃO segue preso em 'executando'.
    expect(job?.status).not.toBe("executando");
  });

  it("job 'executando' há <5min NÃO é reclamado (segue executando)", async () => {
    await processQueue(20);
    const { data: job } = await sb
      .from("siso_fila_execucao")
      .select("status")
      .eq("id", freshJobId)
      .single();
    expect(job?.status).toBe("executando");
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- reclaim-timeout`
  Expected: **FAIL** — o primeiro teste falha com `expected 'executando' not to be 'executando'` (sem reclaim, o job estagnado segue preso).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/execution-worker.ts`, imediatamente após `const now = new Date().toISOString();` (l.122) e **antes** do `const { data: jobs, error } = await supabase.from("siso_fila_execucao")...` (l.123), inserir o reclaim:

```ts
  const now = new Date().toISOString();

  // P145: reclaim de jobs estagnados. Um job que ficou 'executando' (worker
  // crashou, deploy no meio, exceção fora do try) nunca volta a ser selecionado
  // porque o SELECT abaixo filtra só 'pendente'. Aqui devolvemos pra 'pendente'
  // qualquer job 'executando' cujo atualizado_em (marca de início, escrita no
  // claim) seja mais antigo que 5min. Reprocessar é seguro: executeJob é
  // idempotente por reserva (estorno_de) e por estoque_lancado.
  const cincoMinAtras = new Date(Date.now() - 5 * 60_000).toISOString();
  await supabase
    .from("siso_fila_execucao")
    .update({ status: "pendente", proximo_retry_em: now, atualizado_em: now })
    .eq("status", "executando")
    .lt("atualizado_em", cincoMinAtras);

  const { data: jobs, error } = await supabase
    .from("siso_fila_execucao")
    .select(
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- reclaim-timeout`
  Expected: **PASS** — ambos os testes verdes (estagnado reclamado, fresco intacto).

- [ ] **Step 5 — COMMIT.**
```bash
git add src/lib/execution-worker.ts test/integration/reclaim-timeout.test.ts
git commit -m "fix(wms): reclaim de jobs estagnados na fila (>5min volta a pendente) [P145]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.** Sob `erros:`, append:
```yaml
  - id: wms-fila-job-estagnado-nunca-reclamado
    date: "2026-06-05"
    source: wms.execution-worker
    category: infrastructure
    message: "job preso em status='executando' para sempre após crash do worker"
    cause: >
      processQueue só selecionava jobs 'pendente' e fazia claim atômico
      executando. Se o worker morria entre o claim e o update final, o job
      ficava 'executando' indefinidamente — nenhuma rotina o devolvia.
    fix: >
      Antes do SELECT de pendentes, processQueue reclama jobs 'executando'
      cujo atualizado_em (marca de início escrita no claim) é mais antigo que
      5min, devolvendo-os a 'pendente'. Reprocessar é seguro (idempotência por
      reserva e estoque_lancado).
    files:
      - src/lib/execution-worker.ts
    tags: [fila, worker, reclaim, timeout, idempotencia, P145]
```
Commit:
```bash
git add erros-conhecidos.yaml
git commit -m "docs(erros): wms-fila-job-estagnado-nunca-reclamado [P145]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PR 2: Lock de recebimento de transferência: cancel respeita/adquire o mutex + timeout 30min [P062, P068, P066] [MIGRATION/RPC]

**Problema (família grave):** `receberTransferencia` (`src/lib/wms/transferencias.ts:296-323`) já tem claim estrito via `recebimento_em_andamento_por` (migration `20260527_p3_transferencia_recebimento_em_andamento.sql`). Mas `cancelarTransferencia` (`src/lib/wms/transferencias.ts:448-562`) **não lê nem respeita** esse lock — qualquer warehouse-user pode cancelar enquanto outro recebe. Resultado: o cancel estorna a leg S enquanto o receive insere a leg E na mesma tripla → caixa órfã / dupla-contagem.

**Decisões do dono (NOTAs):**
- **P062:** *"só quem está recebendo cancela; + timeout automático 30min libera lock se a tela cair"*. A opção "gerente cancela qualquer hora" foi **rejeitada**.
- **P068:** *"travar transferência durante cancelamento (família P062/P066)"* — reusar o mesmo lock como mutex.
- **P066:** *"bloquear cancelamento enquanto recebimento ativo (mesma linha do P062)"* — cancel respeita `recebimento_em_andamento_por IS NOT NULL`.

**Síntese (mesma família, 1 PR):** cancel passa a (1) **respeitar** o lock de outro recebedor dentro da janela de 30min → 409; (2) permitir cancelar se for o **próprio** recebedor ou se o lock estiver **stale** (>30min). Exige nova coluna `recebimento_em_andamento_em timestamptz` (não existe — a migration só tem o `_por uuid`).

> Nota: divergência do achado — o achado de P068 cita "transferencias.ts:475-490" pro change_site; no HEAD atual o corpo do cancel começa em **l.453** (SELECT do header) e os checks de status em **l.464-473**. O SELECT da linha do header em `cancelarTransferencia` **não** seleciona `recebimento_em_andamento_por` hoje (só `id, status, galpao_origem_id`, l.454-456).

### Task 2.1: Migration — coluna `recebimento_em_andamento_em` + set no claim do receber

**Files**
- Create `supabase/migrations/20260605_transferencia_recebimento_em_andamento_em.sql`
- Modify `src/lib/wms/transferencias.ts:299-305` — incluir `recebimento_em_andamento_em` no UPDATE de claim.
- Test (Create) `test/integration/transferencias-cancel-lock.test.ts`

> **Onde mora o teste:** integração → `test/integration/*.test.ts` (único include do `vitest.integration.config.ts` + globalSetup). Imports daí pra `src/` são `../../src/lib/...`.

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Crie `test/integration/transferencias-cancel-lock.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { cancelarTransferencia } from "../../src/lib/wms/transferencias";

const sb = createServiceClient();
let galpaoOrigemId: string, galpaoDestinoId: string, produtoId: string, locOrigemId: string;
let joaoId: string, mariaId: string;

async function novaTransfEmTransito(): Promise<string> {
  const { data: t } = await sb
    .from("siso_transferencias_galpao")
    .insert({
      galpao_origem_id: galpaoOrigemId,
      galpao_destino_id: galpaoDestinoId,
      status: "em_transito",
      criada_por: joaoId,
    })
    .select("id")
    .single();
  await sb.from("siso_transferencia_galpao_itens").insert({
    transferencia_id: t!.id,
    produto_id: produtoId,
    qty: 1,
    localizacao_origem_id: locOrigemId,
    mov_saida_id: null,
  });
  return t!.id;
}

beforeAll(async () => {
  const { data: gs } = await sb.from("siso_galpoes").select("id, nome").eq("ativo", true);
  galpaoOrigemId = gs!.find((g) => g.nome === "CWB")!.id;
  galpaoDestinoId = gs!.find((g) => g.nome === "SP")!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id").eq("galpao_id", galpaoOrigemId).limit(1).single();
  locOrigemId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `TEST-TR-LOCK-${Math.random().toString(36).slice(2, 8)}`, descricao: "lock test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  const { data: us } = await sb.from("siso_usuarios").select("id").limit(2);
  joaoId = us![0].id;
  mariaId = us![1]?.id ?? us![0].id;
});

describe("cancelarTransferencia respeita o lock de recebimento", () => {
  it("Maria (não-recebedora) NÃO cancela enquanto João recebe (<30min)", async () => {
    const tid = await novaTransfEmTransito();
    await sb
      .from("siso_transferencias_galpao")
      .update({
        recebimento_em_andamento_por: joaoId,
        recebimento_em_andamento_em: new Date().toISOString(),
      })
      .eq("id", tid);

    await expect(cancelarTransferencia(tid, mariaId)).rejects.toThrow(
      /recebimento em andamento|TRANSFERENCIA_RECEBIMENTO/i,
    );
    const { data: t } = await sb
      .from("siso_transferencias_galpao").select("status").eq("id", tid).single();
    expect(t?.status).toBe("em_transito"); // não cancelou
  });

  it("João (dono do lock) consegue cancelar", async () => {
    const tid = await novaTransfEmTransito();
    await sb
      .from("siso_transferencias_galpao")
      .update({
        recebimento_em_andamento_por: joaoId,
        recebimento_em_andamento_em: new Date().toISOString(),
      })
      .eq("id", tid);
    await expect(cancelarTransferencia(tid, joaoId)).resolves.toBeDefined();
    const { data: t } = await sb
      .from("siso_transferencias_galpao").select("status").eq("id", tid).single();
    expect(t?.status).toBe("cancelada");
  });

  it("lock stale (>30min) — qualquer um cancela", async () => {
    const tid = await novaTransfEmTransito();
    await sb
      .from("siso_transferencias_galpao")
      .update({
        recebimento_em_andamento_por: joaoId,
        recebimento_em_andamento_em: new Date(Date.now() - 31 * 60_000).toISOString(),
      })
      .eq("id", tid);
    await expect(cancelarTransferencia(tid, mariaId)).resolves.toBeDefined();
    const { data: t } = await sb
      .from("siso_transferencias_galpao").select("status").eq("id", tid).single();
    expect(t?.status).toBe("cancelada");
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- transferencias-cancel-lock`
  Expected: **FAIL** — o INSERT de `recebimento_em_andamento_em` no `beforeAll`/teste falha com `column "recebimento_em_andamento_em" does not exist` (e o cancel não respeita o lock).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA (migration).** Crie `supabase/migrations/20260605_transferencia_recebimento_em_andamento_em.sql`:

```sql
-- P062 — Timestamp do lock de recebimento de transferência inter-galpão.
--
-- A migration 20260527_p3 adicionou recebimento_em_andamento_por (uuid) mas
-- SEM timestamp. cancelarTransferencia precisa do timestamp pra decidir se o
-- lock está stale (>30min) e pode ser sobrescrito por qualquer operador
-- (caso a tela do recebedor caia no meio).

ALTER TABLE siso_transferencias_galpao
  ADD COLUMN IF NOT EXISTS recebimento_em_andamento_em timestamptz;

COMMENT ON COLUMN siso_transferencias_galpao.recebimento_em_andamento_em IS
  'P062 — Quando o lock de recebimento foi adquirido. NULL = sem recebimento. '
  'Usado por cancelarTransferencia pro timeout de 30min (lock stale = qualquer '
  'um pode cancelar). Setado junto com recebimento_em_andamento_por no claim do '
  'receber; limpado (NULL implícito) no flip pra status=recebida.';
```
Aplicar:
```
mcp__supabase__apply_migration  (project ehbxpbeijofxtsbezwxd)
  name: 20260605_transferencia_recebimento_em_andamento_em
  query: <conteúdo do .sql acima>
```

Em `src/lib/wms/transferencias.ts`, no claim do `receberTransferencia` (l.299-305), incluir o timestamp:

```ts
  const { data: claimed, error: errClaim } = await sb
    .from("siso_transferencias_galpao")
    .update({
      recebimento_em_andamento_por: input.usuario_id,
      recebimento_em_andamento_em: new Date().toISOString(),
    })
    .eq("id", t.id)
    .eq("status", "em_transito")
    .is("recebimento_em_andamento_por", null)
    .select("id");
```

- [ ] **Step 4 — RODAR e ver passar (parcial).** `npm run test:integration -- transferencias-cancel-lock`
  Expected: o teste "João (dono do lock) consegue cancelar" pode passar (dono nunca foi bloqueado), mas os testes 1 e 3 ainda **FAIL** — `cancelarTransferencia` ainda não lê o lock. Prossiga pra Task 2.2 (mesmo arquivo de teste).

- [ ] **Step 5 — COMMIT.**
```bash
git add supabase/migrations/20260605_transferencia_recebimento_em_andamento_em.sql src/lib/wms/transferencias.ts test/integration/transferencias-cancel-lock.test.ts
git commit -m "feat(wms): coluna recebimento_em_andamento_em + set no claim do receber [P062]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: `cancelarTransferencia` respeita/adquire o lock (claim atômico + timeout 30min)

**Files**
- Modify `src/lib/wms/transferencias.ts:453-473` — selecionar o lock, fazer claim atômico de cancelamento (respeita recebedor ativo <30min; permite dono ou stale).
- Modify `src/app/api/wms/transferencias/[id]/cancelar/route.ts:13-25` — mapear o novo erro pra 409.
- Test: reusa `test/integration/transferencias-cancel-lock.test.ts` (Task 2.1).

**Steps**

- [ ] **Step 1 — O TESTE QUE FALHA já existe** (Task 2.1, testes 1 e 3 ainda vermelhos).

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- transferencias-cancel-lock`
  Expected: **FAIL** — teste 1 ("Maria não cancela") falha porque `cancelarTransferencia(tid, mariaId)` resolve (não lança) e o status vira `cancelada`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `cancelarTransferencia`, substituir o bloco de SELECT + checks de status (l.453-473) por SELECT que inclui o lock + claim atômico:

```ts
  const sb = createServiceClient();
  const { data: transf, error } = await sb
    .from("siso_transferencias_galpao")
    .select(
      "id, status, galpao_origem_id, recebimento_em_andamento_por, recebimento_em_andamento_em",
    )
    .eq("id", transferenciaId)
    .single();
  if (error || !transf) throw new Error("transferência não encontrada");
  const t = transf as {
    id: string;
    status: StatusTransferencia;
    galpao_origem_id: string;
    recebimento_em_andamento_por: string | null;
    recebimento_em_andamento_em: string | null;
  };
  if (t.status === "recebida") {
    throw new Error(
      `transferência já foi recebida — use POST /api/wms/transferencias/${transferenciaId}/desfazer-recebimento antes de cancelar`,
    );
  }
  if (t.status !== "em_transito") {
    throw new Error(
      `só transferências em trânsito podem ser canceladas (status: ${t.status})`,
    );
  }

  // P062/P066/P068: respeita o lock de recebimento. Outro operador recebendo
  // dentro da janela de 30min bloqueia o cancel (409). O próprio recebedor ou
  // um lock stale (>30min, tela do recebedor caiu) liberam o cancel.
  const LOCK_TTL_MS = 30 * 60_000;
  const lockAtivo =
    t.recebimento_em_andamento_por != null &&
    t.recebimento_em_andamento_por !== usuarioId &&
    t.recebimento_em_andamento_em != null &&
    Date.now() - new Date(t.recebimento_em_andamento_em).getTime() < LOCK_TTL_MS;
  if (lockAtivo) {
    const err = new Error(
      `recebimento em andamento por outro operador (${t.recebimento_em_andamento_por}) — não é possível cancelar agora`,
    ) as Error & { code?: string };
    err.code = "TRANSFERENCIA_RECEBIMENTO_EM_ANDAMENTO";
    throw err;
  }

  // Claim atômico de cancelamento: fecha a janela TOCTOU entre o SELECT acima e
  // os estornos abaixo. Só passa se ainda em_transito E (sem lock OU lock do
  // próprio usuário OU lock stale). O claim seta o lock pra nós (mutex
  // compartilhado com o receber), serializando os dois fluxos.
  const staleCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const claimQuery = sb
    .from("siso_transferencias_galpao")
    .update({ recebimento_em_andamento_por: usuarioId, recebimento_em_andamento_em: new Date().toISOString() })
    .eq("id", t.id)
    .eq("status", "em_transito")
    .or(
      `recebimento_em_andamento_por.is.null,recebimento_em_andamento_por.eq.${usuarioId},recebimento_em_andamento_em.lt.${staleCutoff}`,
    )
    .select("id");
  const { data: claimed } = await claimQuery;
  if (!claimed || claimed.length === 0) {
    const err = new Error(
      `transferência sendo recebida/cancelada por outro operador, tente em alguns segundos`,
    ) as Error & { code?: string };
    err.code = "TRANSFERENCIA_RECEBIMENTO_EM_ANDAMENTO";
    throw err;
  }
```

O UPDATE final do header (l.552-559) já marca `status='cancelada'`; adicionar a limpeza do lock pra não deixar o campo preso:

```ts
  // 4) Marca header cancelada e limpa o lock de cancelamento.
  await sb
    .from("siso_transferencias_galpao")
    .update({
      status: "cancelada",
      cancelada_por: usuarioId,
      cancelada_em: new Date().toISOString(),
      recebimento_em_andamento_por: null,
      recebimento_em_andamento_em: null,
    })
    .eq("id", transferenciaId);
```

Na rota `src/app/api/wms/transferencias/[id]/cancelar/route.ts`, mapear o novo code pra 409 (substituir o `catch` l.16-24):

```ts
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "TRANSFERENCIA_RECEBIMENTO_EM_ANDAMENTO") {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: msg, code }, { status: 409 });
    }
    return wmsErrorResponse({
      source: "wms.transferencias.cancelar",
      error: e,
      status: 400,
      requestPath: `/api/wms/transferencias/${id}/cancelar`,
      requestMethod: "POST",
      metadata: { transferencia_id: id },
    });
  }
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- transferencias-cancel-lock`
  Expected: **PASS** — os 3 testes verdes (Maria bloqueada, João cancela, lock stale liberado).

- [ ] **Step 5 — COMMIT.**
```bash
git add src/lib/wms/transferencias.ts src/app/api/wms/transferencias/[id]/cancelar/route.ts
git commit -m "fix(wms): cancel de transferência respeita/adquire o lock de recebimento + timeout 30min [P062,P068,P066]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: wms-transferencia-cancel-ignora-lock-recebimento
    date: "2026-06-05"
    source: wms.transferencias.cancelar
    category: business_logic
    message: "caixa órfã / dupla-contagem ao cancelar transferência durante recebimento"
    cause: >
      receberTransferencia tinha claim via recebimento_em_andamento_por mas
      cancelarTransferencia não lia nem respeitava o lock. Cancel e receive
      rodavam concorrentes na mesma tripla (estorno leg S vs insert leg E),
      deixando estoque inconsistente. Faltava timestamp do lock pro timeout.
    fix: >
      Adicionada coluna recebimento_em_andamento_em. cancelarTransferencia
      seleciona o lock, bloqueia (409 TRANSFERENCIA_RECEBIMENTO_EM_ANDAMENTO)
      se outro operador recebe dentro de 30min, e faz claim atômico de
      cancelamento (mutex compartilhado) pro próprio recebedor ou lock stale.
    files:
      - supabase/migrations/20260605_transferencia_recebimento_em_andamento_em.sql
      - src/lib/wms/transferencias.ts
      - src/app/api/wms/transferencias/[id]/cancelar/route.ts
    tags: [transferencia, lock, recebimento, cancelamento, race, P062, P066, P068]
```
Commit:
```bash
git add erros-conhecidos.yaml
git commit -m "docs(erros): wms-transferencia-cancel-ignora-lock-recebimento [P062,P066,P068]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PR 3: Force-unlock 'Tomar de Fulano' na guarda + aviso >30min [P127]

**Problema (P127, grave):** `iniciarGuarda` (`src/lib/wms/guarda.ts:345-402`) não tem caminho de force-unlock: quando `iniciada_por != usuario_id` e `status='em_guarda'`, **sempre** 409 (`PENDENCIA_OUTRA_GUARDA`). Item fica preso ao operador original (tablet travou, internet caiu) — todo o fluxo da guarda para. O paliativo de presença em `quadro-tarefas.tsx:155-159` é cosmético (só nula `iniciada_por` no render — o backend ainda dá 409).

**Decisão do dono (NOTA):** *"força-unlock visível 'Tomar de Fulano' (continua do ponto) + aviso se >30min"* (opção 1). A opção "timeout 60min auto" foi **rejeitada** — não implementar reset automático.

> Nota: divergência do achado — o achado cita "guarda.ts:345-402" pro `iniciarGuarda` e o 409 em "356-371"; no HEAD atual o throw `PENDENCIA_OUTRA_GUARDA` por outro dono está em **l.360-371** e o UPDATE condicional em **l.375-397**. `PendenciaJoined` já expõe `iniciada_em` (guarda.ts:49), então não precisa migration nem mudança de listagem pro badge.

### Task 3.1: Param `forcar` em `iniciarGuarda` (takeover preservando qty)

**Files**
- Modify `src/lib/wms/guarda.ts:345-402` — adicionar param `forcar?: boolean`; quando true, takeover da pendência de outro dono.
- Modify `src/app/api/wms/guarda/[id]/iniciar/route.ts:19-24` — ler `forcar` do body e repassar.
- Test (Create) `test/integration/guarda-force-unlock.test.ts`

> **Onde mora o teste:** integração → `test/integration/*.test.ts` (único include do `vitest.integration.config.ts` + globalSetup). Imports daí pra `src/` são `../../src/lib/...`.

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Crie `test/integration/guarda-force-unlock.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { iniciarGuarda } from "../../src/lib/wms/guarda";

const sb = createServiceClient();
let galpaoId: string, produtoId: string, locId: string, op1: string, op2: string;

async function novaPendenciaEmGuarda(): Promise<string> {
  // Coluna é qty_inicial (não qty_total); qty_pendente é GENERATED = qty_inicial - qty_guardada.
  const { data: pend } = await sb
    .from("siso_wms_pendencias_guarda")
    .insert({
      produto_id: produtoId,
      galpao_id: galpaoId,
      localizacao_origem_id: locId,
      qty_inicial: 5,
      qty_guardada: 2,
      status: "em_guarda",
      iniciada_por: op1,
      iniciada_em: new Date().toISOString(),
    })
    .select("id")
    .single();
  return pend!.id;
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).limit(1).single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `TEST-GD-FORCE-${Math.random().toString(36).slice(2, 8)}`, descricao: "force test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  const { data: us } = await sb.from("siso_usuarios").select("id").limit(2);
  op1 = us![0].id;
  op2 = us![1]?.id ?? us![0].id;
});

describe("iniciarGuarda forcar (Tomar de Fulano)", () => {
  it("op2 SEM forcar continua tomando 409", async () => {
    const pid = await novaPendenciaEmGuarda();
    await expect(
      iniciarGuarda({ pendencia_id: pid, usuario_id: op2 }),
    ).rejects.toMatchObject({ code: "PENDENCIA_OUTRA_GUARDA" });
  });

  it("op2 COM forcar:true assume a pendência preservando qty_pendente", async () => {
    const pid = await novaPendenciaEmGuarda();
    const pend = await iniciarGuarda({ pendencia_id: pid, usuario_id: op2, forcar: true });
    expect(pend.iniciada_por).toBe(op2);
    // qty_total=5, qty_guardada=2 → qty_pendente GENERATED = 3, preservado.
    expect(Number(pend.qty_pendente)).toBe(3);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- guarda-force-unlock`
  Expected: **FAIL** — o 2º teste falha: `iniciarGuarda` não aceita `forcar` (TS error ou 409 mesmo com forcar, pois o caminho não existe).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/wms/guarda.ts`, na assinatura de `iniciarGuarda` (l.345-348) adicionar `forcar`:

```ts
export async function iniciarGuarda(input: {
  pendencia_id: string;
  usuario_id: string;
  forcar?: boolean;
}): Promise<PendenciaJoined> {
```

No bloco que rejeita por outro dono (l.360-371), só rejeitar quando **não** for forçado:

```ts
  // Já reivindicada por outro operador — não tenta sobrescrever, EXCETO
  // quando forcar=true (takeover explícito "Tomar de Fulano"). O takeover
  // preserva qty_guardada/qty_pendente — continua do ponto onde o dono parou.
  if (
    !input.forcar &&
    pend.status === "em_guarda" &&
    pend.iniciada_por &&
    pend.iniciada_por !== input.usuario_id
  ) {
    const err = new Error(
      `pendência já está em_guarda com outro operador (${pend.iniciada_por})`,
    ) as Error & { code?: string; iniciada_por?: string };
    err.code = "PENDENCIA_OUTRA_GUARDA";
    err.iniciada_por = pend.iniciada_por;
    throw err;
  }
```

No UPDATE condicional (l.375-386), relaxar o `.or(iniciada_por...)` quando forçado:

```ts
  // UPDATE condicional. No caminho normal só ganha se iniciada_por ainda for
  // NULL ou já for o usuário. No takeover (forcar) reivindica de qualquer dono,
  // mantendo apenas o guard de status terminal (não tomar pendência já guardada).
  let upd = sb
    .from("siso_wms_pendencias_guarda")
    .update({
      status: "em_guarda",
      iniciada_em: new Date().toISOString(),
      iniciada_por: input.usuario_id,
    })
    .eq("id", input.pendencia_id)
    .neq("status", "guardada")
    .neq("status", "cancelada");
  if (!input.forcar) {
    upd = upd.or(`iniciada_por.is.null,iniciada_por.eq.${input.usuario_id}`);
  }
  const { data: updated, error } = await upd.select("id, iniciada_por");
```

Na rota `src/app/api/wms/guarda/[id]/iniciar/route.ts` (l.19-24), ler `forcar` do body:

```ts
  try {
    const body = await req.json().catch(() => ({}));
    const pend = await iniciarGuarda({
      pendencia_id: id,
      usuario_id: auth.user.id,
      forcar: body?.forcar === true,
    });
    return NextResponse.json({ ok: true, pendencia: pend });
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- guarda-force-unlock`
  Expected: **PASS** — sem forcar dá 409; com forcar assume preservando `qty_pendente=3`.

- [ ] **Step 5 — COMMIT.**
```bash
git add src/lib/wms/guarda.ts src/app/api/wms/guarda/[id]/iniciar/route.ts test/integration/guarda-force-unlock.test.ts
git commit -m "feat(wms): force-unlock 'Tomar de Fulano' na guarda (forcar takeover preservando qty) [P127]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3.2: Botão de takeover ('Assumir guarda') + aviso >30min na tela de guarda

> **Esta task é UI-only — NÃO segue o ciclo TDD (sem teste RED→GREEN).** A cobertura de comportamento do `forcar` está 100% na Task 3.1 (backend, com integration test). Aqui só se liga o botão que envia `forcar:true` ao endpoint já testado; a verificação é build/lint + smoke manual. Não há lógica nova testável em unit/integration neste passo.

**Files**
- Modify `src/app/wms/guarda/[id]/page.tsx:114-130` — `iniciarMut` aceita `forcar`.
- Modify `src/app/wms/guarda/[id]/page.tsx:8` e `:326-335` — importar `useAuth`; renderizar o botão de takeover + badge ">30min" no bloco de ações do header.
- Test: nenhum automatizado (UI-only). Verificação: build/lint + smoke manual no `/wms/guarda/[id]`.

> Nota: divergência do achado — o achado citava `cards-detalhe.tsx:59-63`, mas esse arquivo é só o **card de listagem** do quadro de tarefas: o `CardGuardaItem` é um `<Link>` que navega o card inteiro pra `/wms/guarda/${id}` (l.27), e o tipo `GuardaItem` (`dashboard-tarefas.ts:46-56`) **não expõe `iniciada_em`** (só `iniciada_por: Executor | null`) — colocar um `<button>` dentro de um `<Link>` é interativo-aninhado inválido e o badge ">30min" exigiria mudar a query da listagem. O ponto correto de render é a **tela de detalhe da guarda** (`src/app/wms/guarda/[id]/page.tsx`): lá `pend` é `PendenciaJoined` com `iniciada_por: string | null` **e** `iniciada_em: string | null` (`guarda.ts:49-50`), o botão "Começar guarda" já existe (l.326-335) e há `useQueryClient`/`sisoFetch`/`fmtRelative` no escopo. Re-ancorei a task ali. `PendenciaJoined` **não** carrega o nome do operador dono (só o uuid `iniciada_por`), então o label é genérico ("Assumir guarda") em vez de "Tomar de {nome}".

**Steps**

- [ ] **Step 1 — `iniciarMut` aceita `forcar`.** Em `src/app/wms/guarda/[id]/page.tsx`, trocar o `mutationFn` de `iniciarMut` (l.114-124) pra repassar `forcar` no body:

```ts
  const iniciarMut = useMutation({
    mutationFn: async (forcar?: boolean) => {
      const r = await sisoFetch(`/api/wms/guarda/${id}/iniciar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forcar: forcar === true }),
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

(`forcar` é opcional: o `onClick={() => iniciarMut.mutate()}` existente l.329 continua compilando — cai em `false`. O Step 3 troca esse onClick por `iniciarMut.mutate(undefined)` ao reescrever o bloco do header; ambas as formas são equivalentes.)

- [ ] **Step 2 — Importar `useAuth`.** Em `src/app/wms/guarda/[id]/page.tsx:8`, adicionar `useAuth` ao import existente de `auth-context`:

```ts
import { sisoFetch, usePermissoes, useAuth } from "@/lib/auth-context";
```

E no corpo do componente, logo após `const { can } = usePermissoes();` (l.37):

```ts
  const { user } = useAuth();
```

- [ ] **Step 3 — Botão de takeover + badge ">30min".** No bloco de ações do header (l.325-337), ao lado do botão "Começar guarda" (que só aparece em `status==='pendente'`), adicionar o caminho de `em_guarda` com outro dono. Substituir o `<div style={{ display: "flex", gap: 8, alignItems: "center" }}>` … `</div>` (l.325-337) por:

```tsx
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {pend?.status === "pendente" ? (
            <button
              className="wms-btn wms-btn-primary"
              onClick={() => iniciarMut.mutate(undefined)}
              disabled={iniciarMut.isPending}
            >
              <Icon name="arrow-right" size={12} />
              {iniciarMut.isPending ? "Iniciando…" : "Começar guarda"}
            </button>
          ) : null}
          {pend?.status === "em_guarda" &&
          pend.iniciada_por &&
          user?.id &&
          pend.iniciada_por !== user.id ? (
            <>
              {pend.iniciada_em &&
              Date.now() - new Date(pend.iniciada_em).getTime() > 30 * 60_000 ? (
                <span className="wms-card-badge wms-card-badge-pendente">
                  parado há {fmtRelative(pend.iniciada_em)}
                </span>
              ) : null}
              <button
                className="wms-btn wms-btn-ghost"
                onClick={() => iniciarMut.mutate(true)}
                disabled={iniciarMut.isPending}
                title="Assumir esta guarda de outro operador (continua do ponto)"
              >
                <Icon name="arrow-right" size={12} />
                {iniciarMut.isPending ? "Assumindo…" : "Assumir guarda"}
              </button>
            </>
          ) : null}
          <StatusBadge status={pend.status} size="lg" />
        </div>
```

A presença (`quadro-tarefas.tsx:155-159`) deixa de ser o único caminho: este botão chama o `forcar:true` **real** do backend (Task 3.1), fazendo o takeover atômico que preserva `qty_pendente`.

- [ ] **Step 4 — RODAR build/lint.** `npm run lint && npm run build`
  Expected: PASS (sem erro de tipo/lint). Smoke manual: abrir uma pendência `em_guarda` iniciada por outro operador → o botão "Assumir guarda" aparece; clicar → vira o operador responsável sem perder qty.

- [ ] **Step 5 — COMMIT.**
```bash
git add src/app/wms/guarda/[id]/page.tsx
git commit -m "feat(wms-ui): botão 'Assumir guarda' (forcar) + aviso >30min na tela de guarda [P127]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: wms-guarda-item-preso-sem-force-unlock
    date: "2026-06-05"
    source: wms.guarda.iniciar
    category: business_logic
    message: "item de guarda preso ao operador original (PENDENCIA_OUTRA_GUARDA sempre 409)"
    cause: >
      iniciarGuarda sempre lançava 409 quando iniciada_por != usuario, sem
      caminho de takeover. Se o operador sumia (tablet travou), o item ficava
      preso. O paliativo de presença era só cosmético (nula iniciada_por no
      render, mas o backend seguia dando 409).
    fix: >
      Param forcar:true em iniciarGuarda faz takeover preservando
      qty_guardada/qty_pendente. A tela de detalhe da guarda mostra botão
      'Assumir guarda' (forcar) e badge '>30min'. Sem reset automático
      (rejeitado).
    files:
      - src/lib/wms/guarda.ts
      - src/app/api/wms/guarda/[id]/iniciar/route.ts
      - src/app/wms/guarda/[id]/page.tsx
    tags: [guarda, lock, force-unlock, takeover, P127]
```
Commit:
```bash
git add erros-conhecidos.yaml
git commit -m "docs(erros): wms-guarda-item-preso-sem-force-unlock [P127]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PR 4: Aprovar sessão de inventário idempotente (compare-and-set status='revisao') [P160]

**Problema (P160, média):** `aprovarSessao` (`src/lib/wms/inventario.ts:930-967`) faz `UPDATE ... SET status='aprovada' WHERE id=sessaoId` (l.946-949) **sem** `.eq('status','revisao')` nem leitura prévia. Duas aprovações concorrentes ambas passam, reprocessando a contagem e sobrescrevendo `aprovada_por`.

**Decisão do dono (NOTA):** *"só aprova contagem se etapa ainda é em_revisao (bloqueia 2ª aprovação)"*.

> Nota: o status pós-`finalizarSessao` é literalmente `'revisao'` (inventario.ts:916), **não** `'em_revisao'`. O compare-and-set usa `'revisao'`. `aplicarSessao` (l.987) já tem guard de idempotência — espelhar. Sem migration: 1 statement (`UPDATE ... .eq(status).select()`) é atômico no Postgres.

### Task 4.1: Compare-and-set status='revisao'→'aprovada' + só libera locks se transicionou

**Files**
- Modify `src/lib/wms/inventario.ts:946-966` — adicionar `.eq('status','revisao').select()`, ler linhas afetadas, no-op idempotente se 0 linhas.
- Test (Create) `test/integration/aprovar-sessao-idempotente.test.ts` (integration). O achado pede scenario, mas aprovar-sessão depende de montar uma sessão em `revisao`, o que é mais barato em integration (`aprovarSessao` direto, sem HTTP/seed de sessão completa).

> **Onde mora o teste:** integração → `test/integration/*.test.ts` (único include do `vitest.integration.config.ts` + globalSetup). Imports daí pra `src/` são `../../src/lib/...`.

> Nota: divergência do achado — `test_file` sugere `scripts/wms/cenarios/catalogo/50-...ts` (scenario). Optei por integration (`test/integration/aprovar-sessao-idempotente.test.ts`) por testar `aprovarSessao` direto sem o overhead de um cenário HTTP completo de inventário. Marca a divergência aqui.

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Crie `test/integration/aprovar-sessao-idempotente.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { aprovarSessao } from "../../src/lib/wms/inventario";

const sb = createServiceClient();
let galpaoId: string, op1: string, op2: string;

async function novaSessaoEmRevisao(): Promise<string> {
  // tipo é NOT NULL (CHECK cycle_count|completo); status 'revisao' é válido.
  const { data: s } = await sb
    .from("siso_inventario_sessoes")
    .insert({ tipo: "cycle_count", galpao_id: galpaoId, status: "revisao", criada_por: op1 })
    .select("id")
    .single();
  return s!.id;
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: us } = await sb.from("siso_usuarios").select("id").limit(2);
  op1 = us![0].id;
  op2 = us![1]?.id ?? us![0].id;
});

describe("aprovarSessao idempotente (compare-and-set revisao)", () => {
  it("2ª aprovação é no-op e NÃO sobrescreve aprovada_por", async () => {
    const sid = await novaSessaoEmRevisao();
    await aprovarSessao(sid, op1); // 1ª: revisao → aprovada
    const { data: depois1 } = await sb
      .from("siso_inventario_sessoes").select("status, aprovada_por").eq("id", sid).single();
    expect(depois1?.status).toBe("aprovada");
    expect(depois1?.aprovada_por).toBe(op1);

    // 2ª aprovação por outro operador: deve ser recusada/no-op.
    await expect(aprovarSessao(sid, op2)).rejects.toThrow(/aprovada|revisão|revisao/i);
    const { data: depois2 } = await sb
      .from("siso_inventario_sessoes").select("aprovada_por").eq("id", sid).single();
    expect(depois2?.aprovada_por).toBe(op1); // não sobrescrito
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- aprovar-sessao-idempotente`
  Expected: **FAIL** — a 2ª `aprovarSessao(sid, op2)` resolve (não lança) e sobrescreve `aprovada_por` pra `op2`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `src/lib/wms/inventario.ts`, substituir o UPDATE incondicional (l.946-949) por compare-and-set com checagem de linhas, e só liberar locks se transicionou:

```ts
  const { data: aprovadas } = await sb
    .from("siso_inventario_sessoes")
    .update({ status: "aprovada", aprovada_por: aprovadaPor })
    .eq("id", sessaoId)
    .eq("status", "revisao")
    .select("id");

  // Compare-and-set: 0 linhas → a sessão não estava em 'revisao' (já aprovada
  // por outra chamada concorrente, ou nunca finalizada). No-op idempotente:
  // não reaplica nem dispara efeitos colaterais (liberação de locks).
  if (!aprovadas || aprovadas.length === 0) {
    const { data: atual } = await sb
      .from("siso_inventario_sessoes")
      .select("status")
      .eq("id", sessaoId)
      .single();
    throw new Error(
      `sessão não está em revisão (status atual: ${atual?.status ?? "?"}) — não pode ser aprovada`,
    );
  }

  // Libera locks externos SÓ quando a aprovação efetivamente transicionou.
  const { data: locs } = await sb
    .from("siso_inventario_localizacoes")
    .select("localizacao_id")
    .eq("sessao_id", sessaoId);
  const locIds = ((locs ?? []) as Array<{ localizacao_id: string }>).map(
    (l) => l.localizacao_id,
  );
  if (locIds.length > 0) {
    await sb
      .from("siso_localizacao_locks")
      .update({ finalizado_em: new Date().toISOString() })
      .in("localizacao_id", locIds)
      .is("finalizado_em", null);
  }
}
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- aprovar-sessao-idempotente`
  Expected: **PASS** — 1ª aprova, 2ª lança e `aprovada_por` segue `op1`.

- [ ] **Step 5 — COMMIT.**
```bash
git add src/lib/wms/inventario.ts test/integration/aprovar-sessao-idempotente.test.ts
git commit -m "fix(wms): aprovarSessao idempotente via compare-and-set status='revisao' [P160]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: wms-inventario-aprovar-sessao-nao-idempotente
    date: "2026-06-05"
    source: wms.inventario.aprovar
    category: business_logic
    message: "dupla aprovação de sessão de inventário reprocessa contagem"
    cause: >
      aprovarSessao fazia UPDATE status='aprovada' WHERE id=sessaoId sem
      condicionar à etapa atual. Duas aprovações concorrentes ambas passavam,
      reprocessando a contagem e sobrescrevendo aprovada_por.
    fix: >
      Compare-and-set .eq('status','revisao').select(): 0 linhas → no-op
      idempotente (throw 'não está em revisão'), sem reaplicar nem liberar
      locks de novo. Status correto é 'revisao' (não 'em_revisao').
    files:
      - src/lib/wms/inventario.ts
    tags: [inventario, aprovacao, idempotencia, compare-and-set, P160]
```
Commit:
```bash
git add erros-conhecidos.yaml
git commit -m "docs(erros): wms-inventario-aprovar-sessao-nao-idempotente [P160]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PR 5: RPC `wms_confirmar_item_embalagem_atomico` — soma atômica + dedup por client_request_id [P130, P129, P131] [MIGRATION/RPC]

**Problema (família grave):** `src/app/api/wms/separacao/confirmar-item-embalagem/route.ts:84-95` é read-modify-write puro: lê `quantidade_bipada` (l.84), calcula `newBipada` em JS (l.85), sobrescreve via UPDATE (l.89-95).
- **P130:** dois operadores concorrentes leem o mesmo valor → lost update (A:+3, B:+2 → fica 2, não 5).
- **P129/P131:** sem chave de idempotência por clique → duplo-clique/retry de rede soma 2x; quando atinge `bipado_completo`, dispara conclusão/etiqueta 2x.

**Decisão do dono (NOTAs):**
- **P130:** *"gravar com SOMA atômica no banco (não sobrescrever)"* (opção 2, UPDATE com soma).
- **P129:** *"ID único por clique na embalagem, ignora repetido"* (robustez contra rede, janela 60s).
- **P131:** *"ID único por clique no confirmar item da separação, ignora repetido <1s"*.

**Síntese (1 RPC unifica os três):** RPC `wms_confirmar_item_embalagem_atomico(p_item_id, p_delta, p_client_request_id)` — sob `FOR UPDATE` da linha do item, ignora se `p_client_request_id` já foi visto na janela (60s cobre P129 e P131 — janela maior contém a menor) e senão faz `quantidade_bipada = GREATEST(0, quantidade_bipada + p_delta)`, retornando os valores novos. Dedup via tabela leve `siso_idempotencia_embalagem`.

> Nota: `siso_pedido_itens.id` é **bigint** (a RPC `wms_acumular_qty_pega` em `20260518_realocacao_fix_pack_rpc_acumular.sql` declara `p_item_id bigint`). supabase-js serializa bigint como string no JSON do body — a RPC declara `bigint` e o driver coerce. A coluna do alvo é `quantidade_pedida` (confirmado em `confirmar-item-embalagem/route.ts:46,86`) — **não** `quantidade_pedido`; a RPC e os testes usam `quantidade_pedida`.

### Task 5.1: Migration — tabela de dedup + RPC `wms_confirmar_item_embalagem_atomico`

**Files**
- Create `supabase/migrations/20260605_wms_confirmar_item_embalagem_atomico.sql`
- Test (Create) `test/integration/confirmar-embalagem-atomico.test.ts`

> **Onde mora o teste:** integração → `test/integration/*.test.ts` (único include do `vitest.integration.config.ts` + globalSetup). Imports daí pra `src/` são `../../src/lib/...`.

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Crie `test/integration/confirmar-embalagem-atomico.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
const PEDIDO_ID = `EMB-ATOM-${Math.random().toString(36).slice(2, 8)}`;

async function novoItem(qtdPedida: number): Promise<number> {
  const { data } = await sb
    .from("siso_pedido_itens")
    .insert({
      pedido_id: PEDIDO_ID,
      produto_id: 999001,
      quantidade_pedida: qtdPedida,
      quantidade_bipada: 0,
      bipado_completo: false,
    })
    .select("id")
    .single();
  return data!.id as number;
}

beforeAll(async () => {
  // numero/data/filial_origem são NOT NULL (legado) — fixtures diretos os incluem.
  await sb.from("siso_pedidos").insert({
    id: PEDIDO_ID, numero: PEDIDO_ID, data: new Date().toISOString(),
    filial_origem: "TEST", status: "executando",
  });
});

describe("wms_confirmar_item_embalagem_atomico", () => {
  it("soma atômica: dois incrementos concorrentes não perdem nenhum (+3 e +2 → 5)", async () => {
    const itemId = await novoItem(10);
    await Promise.all([
      sb.rpc("wms_confirmar_item_embalagem_atomico", {
        p_item_id: itemId, p_delta: 3, p_client_request_id: randomUUID(),
      }),
      sb.rpc("wms_confirmar_item_embalagem_atomico", {
        p_item_id: itemId, p_delta: 2, p_client_request_id: randomUUID(),
      }),
    ]);
    const { data: item } = await sb
      .from("siso_pedido_itens").select("quantidade_bipada").eq("id", itemId).single();
    expect(Number(item?.quantidade_bipada)).toBe(5);
  });

  it("dedup: mesmo client_request_id em 2 chamadas não reaplica o delta", async () => {
    const itemId = await novoItem(11);
    await sb.rpc("wms_confirmar_item_embalagem_atomico", {
      p_item_id: itemId, p_delta: 10, p_client_request_id: randomUUID(),
    });
    const reqId = randomUUID();
    const r1 = await sb.rpc("wms_confirmar_item_embalagem_atomico", {
      p_item_id: itemId, p_delta: 1, p_client_request_id: reqId,
    });
    const r2 = await sb.rpc("wms_confirmar_item_embalagem_atomico", {
      p_item_id: itemId, p_delta: 1, p_client_request_id: reqId,
    });
    const { data: item } = await sb
      .from("siso_pedido_itens").select("quantidade_bipada").eq("id", itemId).single();
    expect(Number(item?.quantidade_bipada)).toBe(11); // não 12
    // ambas as chamadas retornam o mesmo estado final
    expect(Number((r1.data as any)?.quantidade_bipada)).toBe(11);
    expect(Number((r2.data as any)?.quantidade_bipada)).toBe(11);
  });

  it("clamp >=0: delta negativo não deixa negativo", async () => {
    const itemId = await novoItem(5);
    await sb.rpc("wms_confirmar_item_embalagem_atomico", {
      p_item_id: itemId, p_delta: -3, p_client_request_id: randomUUID(),
    });
    const { data: item } = await sb
      .from("siso_pedido_itens").select("quantidade_bipada").eq("id", itemId).single();
    expect(Number(item?.quantidade_bipada)).toBe(0);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- confirmar-embalagem-atomico`
  Expected: **FAIL** — todos os testes falham: `function wms_confirmar_item_embalagem_atomico(...) does not exist`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA (migration).** Crie `supabase/migrations/20260605_wms_confirmar_item_embalagem_atomico.sql`:

```sql
-- P130/P129/P131 — Confirmar item de embalagem de forma atômica + idempotente.
--
-- Substitui o read-modify-write em confirmar-item-embalagem/route.ts (lost
-- update sob concorrência) por uma RPC plpgsql que:
--   (1) sob FOR UPDATE da linha do item, soma o delta clampado em >=0 (P130);
--   (2) deduplica por client_request_id numa janela de 60s — cobre tanto a
--       janela de 60s (P129/embalagem) quanto <1s (P131/confirmar) porque a
--       janela maior contém a menor (P129).
--
-- supabase-js não tem transação multi-statement client-side: a soma + dedup
-- na mesma transação implícita da função é o que garante atomicidade.

CREATE TABLE IF NOT EXISTS siso_idempotencia_embalagem (
  client_request_id uuid PRIMARY KEY,
  item_id           bigint NOT NULL,
  quantidade_bipada integer NOT NULL,
  bipado_completo   boolean NOT NULL,
  criado_em         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idem_embalagem_criado_em
  ON siso_idempotencia_embalagem(criado_em);

CREATE OR REPLACE FUNCTION wms_confirmar_item_embalagem_atomico(
  p_item_id bigint,
  p_delta integer,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_qtd_pedida   integer;
  v_nova_bipada  integer;
  v_completo     boolean;
  v_existente    siso_idempotencia_embalagem%ROWTYPE;
BEGIN
  -- Dedup: se a chave já foi vista em <60s, retorna o estado registrado sem
  -- reaplicar o delta (idempotência contra duplo-clique/retry de rede).
  SELECT * INTO v_existente
    FROM siso_idempotencia_embalagem
    WHERE client_request_id = p_client_request_id
      AND criado_em > now() - interval '60 seconds';
  IF FOUND THEN
    RETURN jsonb_build_object(
      'quantidade_bipada', v_existente.quantidade_bipada,
      'bipado_completo', v_existente.bipado_completo,
      'deduplicado', true
    );
  END IF;

  -- Lock pessimista da linha + soma atômica clampada em >=0.
  SELECT quantidade_pedida INTO v_qtd_pedida
    FROM siso_pedido_itens
    WHERE id = p_item_id
    FOR UPDATE;
  IF v_qtd_pedida IS NULL THEN
    RAISE EXCEPTION 'item % nao encontrado', p_item_id;
  END IF;

  UPDATE siso_pedido_itens
    SET quantidade_bipada = GREATEST(0, COALESCE(quantidade_bipada, 0) + p_delta),
        bipado_completo = GREATEST(0, COALESCE(quantidade_bipada, 0) + p_delta) >= v_qtd_pedida
    WHERE id = p_item_id
    RETURNING quantidade_bipada, bipado_completo INTO v_nova_bipada, v_completo;

  -- Registra a chave pra dedup futuro. ON CONFLICT cobre a corrida em que
  -- duas chamadas com a MESMA chave passam o SELECT acima quase juntas — a
  -- segunda colide no PK e cai no ramo de já-aplicado.
  BEGIN
    INSERT INTO siso_idempotencia_embalagem
      (client_request_id, item_id, quantidade_bipada, bipado_completo)
    VALUES (p_client_request_id, p_item_id, v_nova_bipada, v_completo);
  EXCEPTION WHEN unique_violation THEN
    -- Outra tx com a mesma chave venceu o INSERT depois de já ter aplicado o
    -- delta dela. Esta tx já aplicou o seu — desfaz o efeito desta lendo o
    -- valor consolidado e retornando-o (não há reaplicação visível ao caller).
    SELECT quantidade_bipada, bipado_completo INTO v_nova_bipada, v_completo
      FROM siso_idempotencia_embalagem WHERE client_request_id = p_client_request_id;
    RAISE EXCEPTION 'client_request_id % ja aplicado', p_client_request_id
      USING ERRCODE = '40001';
  END;

  RETURN jsonb_build_object(
    'quantidade_bipada', v_nova_bipada,
    'bipado_completo', v_completo,
    'deduplicado', false
  );
END;
$$;
```

> Nota de design: o ramo `unique_violation` levanta `40001` (serialization_failure) pro caller retry — o caso de **mesma** chave em paralelo exato é raro (duplo-clique gera o mesmo `reqId`, mas as duas requisições chegam serializadas pelo `FOR UPDATE`). O caminho quente é a dedup pelo SELECT inicial (segunda chamada chega após a primeira commitar).

Aplicar:
```
mcp__supabase__apply_migration  (project ehbxpbeijofxtsbezwxd)
  name: 20260605_wms_confirmar_item_embalagem_atomico
  query: <conteúdo do .sql acima>
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- confirmar-embalagem-atomico`
  Expected: **PASS** — soma concorrente = 5; dedup mantém 11; clamp = 0.

- [ ] **Step 5 — COMMIT.**
```bash
git add supabase/migrations/20260605_wms_confirmar_item_embalagem_atomico.sql test/integration/confirmar-embalagem-atomico.test.ts
git commit -m "feat(wms): RPC wms_confirmar_item_embalagem_atomico (soma atômica + dedup client_request_id) [P130,P129,P131]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5.2: Rota e front passam a usar a RPC (client_request_id por clique)

**Files**
- Modify `src/app/api/wms/separacao/confirmar-item-embalagem/route.ts:25-95` — aceitar `client_request_id` no body; substituir o read-modify-write (l.84-95) pela RPC; recomputar `pedido_completo` (l.112-129 mantido).
- Modify `src/app/wms/separacao/embalagem/page.tsx:338-346` — gerar `client_request_id` (uuid) por clique e enviar no body.
- Test: reusa `test/integration/confirmar-embalagem-atomico.test.ts` (RPC) + scenario E2E opcional.

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA (scenario E2E HTTP).** Crie `scripts/wms/cenarios/catalogo/cenario-embalagem-idempotencia.ts` (auto-descoberto pelo `run-all`, que lê todos os `.ts` de `catalogo/` — sem registro manual):

> **API REAL do harness** (`scripts/wms/cenarios/_harness/types.ts`, conferida no HEAD): o `Ctx` expõe `ctx.sb` (SupabaseClient), `ctx.http` (`get/post/patch/delete`, **sem `fetchWms`/`put`**), `ctx.skuUnico(prefix)` (**não** `idUnico`) e `ctx.criarProduto({ sku, descricao })`. **Não existe `ctx.assert`** — os cenários sinalizam falha via `throw new Error(...)` (padrão do PR6 e dos cenários existentes). O `assertEsperado` recebe o mesmo `TSetup` que o `setup` retornou; pra propagar o `itemId` criado no `run`, declaramos o `Setup` com `itemId` mutável e o gravamos durante o `run`.

```ts
import type { Cenario, Ctx } from "../_harness/types";
import { randomUUID } from "node:crypto";

/**
 * Cenário — idempotência da confirmação de item de embalagem.
 * Dois POSTs com o MESMO client_request_id em <60s não devem somar 2x.
 */
type Setup = { sku: string; itemId: number };

export default {
  nome: "embalagem-idempotencia — dois cliques com mesmo client_request_id contam 1x",
  descricao:
    "POST /api/wms/separacao/confirmar-item-embalagem duas vezes com o mesmo " +
    "client_request_id (delta=+1, item bipada=10 de 12) → quantidade_bipada=11, não 12.",
  tags: ["embalagem", "idempotencia", "confirmar-item", "P129", "P131"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("emb-idem");
    await ctx.criarProduto({ sku, descricao: "Embalagem idempotencia" });
    return { sku, itemId: 0 };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Monta um item de pedido em estado 'separado' com bipada=10 de 12.
    // 10+1=11 < 12 → o item NÃO completa: o pedido segue 'separado' e a SEGUNDA
    // chamada (sequencial) continua passando o guard de status da rota. Sem dedup
    // ficaria 12 (= completo); com dedup fica 11. numero/data/filial_origem são
    // NOT NULL (legado). id de pedido gerado localmente (não há ctx.idUnico).
    const pedidoId = `EMB-${Math.random().toString(36).slice(2, 8)}`;
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .insert({
        id: pedidoId, numero: pedidoId, data: new Date().toISOString(),
        filial_origem: "TEST", status: "executando", status_separacao: "separado",
      })
      .select("id").single();
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .insert({
        pedido_id: (ped as { id: string }).id, produto_id: 999002,
        quantidade_pedida: 12, quantidade_bipada: 10, bipado_completo: false,
      })
      .select("id").single();
    setup.itemId = (item as { id: number }).id;

    const reqId = randomUUID();
    // pedido_item_id como string do bigint do item (a rota faz .eq('id', pedido_item_id);
    // o supabase-js coerce a string pro bigint da coluna). client_request_id por clique.
    const body = {
      pedido_item_id: String(setup.itemId),
      quantidade: 1,
      client_request_id: reqId,
    };
    await ctx.http.post("/api/wms/separacao/confirmar-item-embalagem", body);
    await ctx.http.post("/api/wms/separacao/confirmar-item-embalagem", body);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens").select("quantidade_bipada").eq("id", setup.itemId).single();
    const v = Number((item as { quantidade_bipada: number } | null)?.quantidade_bipada);
    if (v !== 11) {
      throw new Error(
        `quantidade_bipada deveria ser 11 (dois cliques com mesmo client_request_id = 1×), foi ${v}.`,
      );
    }
  },
} satisfies Cenario<Setup>;
```

> Nota (validação da rota): a rota `confirmar-item-embalagem` resolve o item por `.eq("id", pedido_item_id)` (route l.46) — `pedido_item_id` chega como **string** do bigint e o supabase-js coerce pra a coluna `bigint`. O body usa `produto_id: 999002` no item só pra satisfazer o NOT NULL (não precisa existir em `siso_produtos` — a rota não faz JOIN do produto aqui). O alvo da soma é `quantidade_pedida` (route l.46,86).

- [ ] **Step 2 — RODAR e ver falhar.** `npm run scenarios:only -- "embalagem-idempotencia"` (o `--only` casa por substring do campo `nome` do cenário, não pelo nome do arquivo)
  Expected: **FAIL** — `quantidade_bipada` vira 12 (a rota ainda soma sem dedup, ignora `client_request_id`).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Na rota `confirmar-item-embalagem/route.ts`, aceitar `client_request_id` (gerar se ausente, pra back-compat) e trocar o read-modify-write pela RPC. Substituir o bloco de validação de body (l.25-38) e o cálculo+update (l.83-105):

```ts
  const body = await request.json().catch(() => null);
  if (
    !body ||
    !body.pedido_item_id ||
    typeof body.quantidade !== "number"
  ) {
    return NextResponse.json(
      { error: "'pedido_item_id' (string) e 'quantidade' (number) sao obrigatorios" },
      { status: 400 },
    );
  }

  const pedido_item_id: string = body.pedido_item_id;
  const quantidade: number = body.quantidade;
  // client_request_id por clique (P129/P131). Ausente (cliente legado) →
  // gera um aqui (sem dedup útil, mas mantém o caminho funcional).
  const clientRequestId: string =
    typeof body.client_request_id === "string" ? body.client_request_id : crypto.randomUUID();
```

(Adicionar `import { randomUUID } from "node:crypto"` no topo e usar `randomUUID()` em vez de `crypto.randomUUID()` se preferir; ambos funcionam no runtime Node do App Router.)

Substituir o cálculo JS + UPDATE (l.83-105) pela chamada à RPC:

```ts
    // P130/P129/P131: soma atômica + dedup por client_request_id na RPC.
    const { data: rpcRes, error: rpcErr } = await supabase.rpc(
      "wms_confirmar_item_embalagem_atomico",
      {
        p_item_id: Number(pedido_item_id),
        p_delta: quantidade,
        p_client_request_id: clientRequestId,
      },
    );
    if (rpcErr) {
      // 40001 (serialization_failure / chave duplicada concorrente) → trata como
      // duplo-clique já contabilizado: relê o estado e segue.
      logger.warn("confirmar-item-embalagem", "RPC atomica falhou/dedup", {
        error: rpcErr.message,
      });
    }
    const resObj = (rpcRes ?? {}) as {
      quantidade_bipada?: number;
      bipado_completo?: boolean;
    };
    const newBipada = Number(resObj.quantidade_bipada ?? item.quantidade_bipada ?? 0);
    const bipado_completo = Boolean(
      resObj.bipado_completo ?? newBipada >= item.quantidade_pedida,
    );
```

O restante da rota (contagem de pendentes l.112-129, transições OC/normal, etiqueta) continua usando `newBipada`/`bipado_completo` — nenhuma outra mudança.

No front `src/app/wms/separacao/embalagem/page.tsx`, no `mutationFn` do `confirmarMut` (l.338-346), gerar e enviar o `client_request_id`:

```ts
    mutationFn: async ({ item, delta }) => {
      const clientRequestId = crypto.randomUUID();
      const r = await sisoFetch("/api/wms/separacao/confirmar-item-embalagem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_item_id: item.id,
          quantidade: delta,
          client_request_id: clientRequestId,
        }),
      });
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run scenarios:only -- "embalagem-idempotencia"` e `npm run test:integration -- confirmar-embalagem-atomico`
  Expected: **PASS** — dois cliques com mesma chave = 11; soma concorrente = 5.

- [ ] **Step 5 — COMMIT.**
```bash
git add src/app/api/wms/separacao/confirmar-item-embalagem/route.ts src/app/wms/separacao/embalagem/page.tsx scripts/wms/cenarios/catalogo/cenario-embalagem-idempotencia.ts
git commit -m "fix(wms): confirmar-item-embalagem usa RPC atômica + client_request_id por clique [P130,P129,P131]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: wms-embalagem-confirmar-item-lost-update-e-duplo-clique
    date: "2026-06-05"
    source: wms.separacao.confirmar-item-embalagem
    category: business_logic
    message: "quantidade_bipada errada: lost update concorrente e duplo-clique soma 2x"
    cause: >
      A rota fazia read-modify-write (lê quantidade_bipada, soma em JS,
      sobrescreve). Concorrência perdia incrementos; duplo-clique/retry sem
      chave de idempotência somava o delta 2x e disparava conclusão/etiqueta 2x.
    fix: >
      RPC wms_confirmar_item_embalagem_atomico: FOR UPDATE da linha + soma
      clampada (GREATEST(0, ...)) + dedup por client_request_id (janela 60s,
      tabela siso_idempotencia_embalagem). Front envia uuid por clique.
    files:
      - supabase/migrations/20260605_wms_confirmar_item_embalagem_atomico.sql
      - src/app/api/wms/separacao/confirmar-item-embalagem/route.ts
      - src/app/wms/separacao/embalagem/page.tsx
    tags: [embalagem, idempotencia, lost-update, rpc, atomic, P129, P130, P131]
```
Commit:
```bash
git add erros-conhecidos.yaml
git commit -m "docs(erros): wms-embalagem-confirmar-item-lost-update-e-duplo-clique [P129,P130,P131]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PR 6: Decremento atômico de quantidade_bipada (desfazer-bip) [P021] [MIGRATION/RPC]

**Problema (P021, grave):** `src/app/api/wms/separacao/desfazer-bip/route.ts:84-103` é read-modify-write: lê `currentBipada` (l.84), calcula `newBipada = currentBipada - 1` (l.93), UPDATE (l.96-103). Dois cliques rápidos/retries leem N e ambos gravam N-1 → fica N-1 em vez de N-2.

**Decisão do dono (NOTA):** *"op2"* — *"desfazer sempre diminui exatamente 1, não importa quanto foi lido antes"* = decremento atômico no SQL. Não usar debounce de frontend (op1 rejeitada). `wms_acumular_qty_pega` já prova o padrão.

> Nota: o `desfazer-bip` opera por `(pedido_id, produto_id)` (o `produto_id` aqui é o **tiny_produto_id**, route l.40-43) — **não** pelo `siso_pedido_itens.id`. A RPC deve aceitar essas duas chaves (`p_pedido_id text`, `p_produto_id bigint`). Usar o valor RETORNADO pela RPC (não o calculado em JS) pra decidir `bipado_completo` e reversão de status.

### Task 6.1: Migration — RPC `wms_desfazer_bip_atomico(p_pedido_id, p_produto_id)`

**Files**
- Create `supabase/migrations/20260605_wms_desfazer_bip_atomico.sql`
- Test (Create) `test/integration/desfazer-bip-decremento-atomico.test.ts`

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Crie `test/integration/desfazer-bip-decremento-atomico.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
const PEDIDO_ID = `DESF-BIP-${Math.random().toString(36).slice(2, 8)}`;
const PRODUTO_TINY = 999003;

beforeAll(async () => {
  // numero/data/filial_origem NOT NULL (legado) — fixtures diretos os incluem.
  await sb.from("siso_pedidos").insert({
    id: PEDIDO_ID, numero: PEDIDO_ID, data: new Date().toISOString(),
    filial_origem: "TEST", status: "executando",
  });
  await sb.from("siso_pedido_itens").insert({
    pedido_id: PEDIDO_ID,
    produto_id: PRODUTO_TINY,
    quantidade_pedida: 5,
    quantidade_bipada: 3,
    bipado_completo: false,
  });
});

describe("wms_desfazer_bip_atomico", () => {
  it("dois desfazer concorrentes decrementam exatamente 1 cada (3 → 1)", async () => {
    await Promise.all([
      sb.rpc("wms_desfazer_bip_atomico", { p_pedido_id: PEDIDO_ID, p_produto_id: PRODUTO_TINY }),
      sb.rpc("wms_desfazer_bip_atomico", { p_pedido_id: PEDIDO_ID, p_produto_id: PRODUTO_TINY }),
    ]);
    const { data: item } = await sb
      .from("siso_pedido_itens")
      .select("quantidade_bipada")
      .eq("pedido_id", PEDIDO_ID)
      .eq("produto_id", PRODUTO_TINY)
      .single();
    expect(Number(item?.quantidade_bipada)).toBe(1);
  });

  it("não desce abaixo de 0 (clamp)", async () => {
    // de 1 → 0 → 0 (segunda chamada não muda)
    await sb.rpc("wms_desfazer_bip_atomico", { p_pedido_id: PEDIDO_ID, p_produto_id: PRODUTO_TINY });
    await sb.rpc("wms_desfazer_bip_atomico", { p_pedido_id: PEDIDO_ID, p_produto_id: PRODUTO_TINY });
    const { data: item } = await sb
      .from("siso_pedido_itens")
      .select("quantidade_bipada")
      .eq("pedido_id", PEDIDO_ID)
      .eq("produto_id", PRODUTO_TINY)
      .single();
    expect(Number(item?.quantidade_bipada)).toBe(0);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- desfazer-bip-decremento-atomico`
  Expected: **FAIL** — `function wms_desfazer_bip_atomico(...) does not exist`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA (migration).** Crie `supabase/migrations/20260605_wms_desfazer_bip_atomico.sql`:

```sql
-- P021 — Decremento atômico de quantidade_bipada no desfazer-bip.
--
-- Substitui o read-modify-write em desfazer-bip/route.ts (dois cliques rápidos
-- lêem N e ambos gravam N-1 → fica N-1 em vez de N-2). Espelha o padrão de
-- wms_acumular_qty_pega (UPDATE += delta atômico).
--
-- desfazer-bip identifica o item por (pedido_id text, produto_id = tiny_produto_id).
-- GREATEST(... - 1, 0) garante clamp em 0 e a soma é atômica sob a linha.

CREATE OR REPLACE FUNCTION wms_desfazer_bip_atomico(
  p_pedido_id text,
  p_produto_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_qtd_pedida  integer;
  v_nova_bipada integer;
BEGIN
  SELECT quantidade_pedida INTO v_qtd_pedida
    FROM siso_pedido_itens
    WHERE pedido_id = p_pedido_id AND produto_id = p_produto_id
    FOR UPDATE;
  IF v_qtd_pedida IS NULL THEN
    RAISE EXCEPTION 'item (pedido=%, produto=%) nao encontrado', p_pedido_id, p_produto_id;
  END IF;

  UPDATE siso_pedido_itens
    SET quantidade_bipada = GREATEST(COALESCE(quantidade_bipada, 0) - 1, 0),
        bipado_completo   = GREATEST(COALESCE(quantidade_bipada, 0) - 1, 0) >= v_qtd_pedida
    WHERE pedido_id = p_pedido_id AND produto_id = p_produto_id
    RETURNING quantidade_bipada INTO v_nova_bipada;

  RETURN jsonb_build_object(
    'quantidade_bipada', v_nova_bipada,
    'bipado_completo', v_nova_bipada >= v_qtd_pedida
  );
END;
$$;
```
Aplicar:
```
mcp__supabase__apply_migration  (project ehbxpbeijofxtsbezwxd)
  name: 20260605_wms_desfazer_bip_atomico
  query: <conteúdo do .sql acima>
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- desfazer-bip-decremento-atomico`
  Expected: **PASS** — 3→1 (dois decrementos), clamp em 0.

- [ ] **Step 5 — COMMIT.**
```bash
git add supabase/migrations/20260605_wms_desfazer_bip_atomico.sql test/integration/desfazer-bip-decremento-atomico.test.ts
git commit -m "feat(wms): RPC wms_desfazer_bip_atomico (decremento atômico clampado) [P021]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 6.2: Rota desfazer-bip usa a RPC (valor retornado decide status)

**Files**
- Modify `src/app/api/wms/separacao/desfazer-bip/route.ts:84-103` — trocar read+UPDATE pela RPC; usar o valor retornado em l.117-146.
- Test (Create) `scripts/wms/cenarios/catalogo/82-desfazer-bip-concorrente.ts` — scenario E2E HTTP que bate na **rota** (RED enquanto read-modify-write, GREEN após o swap).

> Nota: a Task 6.1 cobre a RPC isoladamente (integration que chama `sb.rpc(...)` direto — passa identicamente antes e depois do swap da rota). Pra gatear a **mudança de produção da rota** (read-modify-write → RPC) com RED→GREEN de verdade, este teste dispara **dois POSTs concorrentes na rota** `/api/wms/separacao/desfazer-bip` com o mesmo `(pedido_id, produto_id)`: com o read-modify-write antigo ambos lêem N e gravam N-1 (fica 2 a partir de 3 → FAIL); com a RPC cada um decrementa atômico (fica 1 → PASS). Auto-descoberto pelo `run-all` (lê todos os `.ts` de `catalogo/`, ordenado — sem registro manual). O `--only` casa por substring do campo `nome` do cenário.

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA (scenario E2E HTTP, bate na rota).** Crie `scripts/wms/cenarios/catalogo/82-desfazer-bip-concorrente.ts`:

```ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 82 — desfazer-bip concorrente decrementa exatamente 1 cada.
 *
 * Dois POSTs concorrentes em /api/wms/separacao/desfazer-bip com o MESMO
 * (pedido_id, produto_id). Com read-modify-write ambos lêem 3 e gravam 2
 * (FAIL). Com a RPC wms_desfazer_bip_atomico cada um decrementa atômico → 1.
 *
 * Gateia a mudança de produção da ROTA (read-modify-write → RPC), não só a RPC.
 */

type Setup = { pedidoId: string; produtoTiny: number; galpaoId: string };

export default {
  nome: "82 — desfazer-bip concorrente decrementa exatamente 1 cada (3 → 1)",
  descricao:
    "Dois POSTs concorrentes em /api/wms/separacao/desfazer-bip com o mesmo " +
    "(pedido_id, produto_id), item bipada=3/5. Esperado quantidade_bipada=1 " +
    "(read-modify-write deixaria 2).",
  tags: ["separacao", "desfazer-bip", "concorrencia", "P021"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const galpaoId = ctx.staging.galpoes.cwb.id;
    const produtoTiny = 999004;
    // numero/data/filial_origem são NOT NULL (legado) — incluir no insert direto.
    // separacao_galpao_id = CWB pra a rota validar ownership contra X-Galpao-Id.
    const pedidoId = `DESF-BIP-E2E-${Math.random().toString(36).slice(2, 8)}`;
    await ctx.sb.from("siso_pedidos").insert({
      id: pedidoId,
      numero: pedidoId,
      data: new Date().toISOString(),
      filial_origem: "TEST",
      status: "executando",
      status_separacao: "em_separacao",
      separacao_galpao_id: galpaoId,
    });
    await ctx.sb.from("siso_pedido_itens").insert({
      pedido_id: pedidoId,
      produto_id: produtoTiny,
      quantidade_pedida: 5,
      quantidade_bipada: 3,
      bipado_completo: false,
    });
    return { pedidoId, produtoTiny, galpaoId };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const body = { pedido_id: setup.pedidoId, produto_id: setup.produtoTiny };
    // X-Galpao-Id = CWB → session.galpaoId casa com separacao_galpao_id (ownership OK).
    const headers = { "X-Galpao-Id": setup.galpaoId };
    await Promise.all([
      ctx.http.post("/api/wms/separacao/desfazer-bip", body, headers),
      ctx.http.post("/api/wms/separacao/desfazer-bip", body, headers),
    ]);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .select("quantidade_bipada")
      .eq("pedido_id", setup.pedidoId)
      .eq("produto_id", setup.produtoTiny)
      .single();
    const v = Number((item as { quantidade_bipada: number } | null)?.quantidade_bipada);
    if (v !== 1) {
      throw new Error(
        `desfazer-bip concorrente: quantidade_bipada deveria ser 1 (3 - 2), foi ${v} ` +
          `(read-modify-write deixaria 2 — lost decrement).`,
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

- [ ] **Step 2 — RODAR e ver falhar (rota antiga read-modify-write).** `npm run scenarios:only -- "82 — desfazer-bip concorrente"`
  Expected: **FAIL** — `quantidade_bipada deveria ser 1 ... foi 2`. As duas requisições concorrentes interleavam no event loop do dev server: ambas lêem 3 antes de qualquer UPDATE commitar, e ambas gravam 2 (lost decrement). A RPC da Task 6.1 já existe, mas a rota **não a usa** — é exatamente o que este passo prova. (É uma corrida: o interleaving read-read-write-write é o caminho dominante com 2 POSTs simultâneos, mas se uma execução não falhar, rodar de novo — o `FOR UPDATE` da RPC é o que torna o GREEN determinístico no Step 4.)

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Em `desfazer-bip/route.ts`, substituir o decremento JS + UPDATE (l.84-115) pela RPC:

```ts
    const currentBipada = item.quantidade_bipada ?? 0;
    if (currentBipada <= 0) {
      return NextResponse.json(
        { error: "item não tem bips para desfazer" },
        { status: 400 },
      );
    }

    // P021: decremento atômico no SQL (dois cliques rápidos decrementam
    // exatamente 1 cada, sem perder decrementos). Usa o valor RETORNADO.
    const { data: rpcRes, error: rpcErr } = await supabase.rpc(
      "wms_desfazer_bip_atomico",
      { p_pedido_id: pedido_id, p_produto_id: produto_id },
    );
    if (rpcErr) {
      logger.error("separacao-desfazer-bip", "RPC atomica falhou", {
        error: rpcErr.message,
        pedido_id,
        produto_id,
      });
      return NextResponse.json({ error: rpcErr.message }, { status: 500 });
    }
    const decRes = (rpcRes ?? {}) as { quantidade_bipada?: number; bipado_completo?: boolean };
    const newBipada = Number(decRes.quantidade_bipada ?? currentBipada - 1);
    const newBipadoCompleto = Boolean(decRes.bipado_completo ?? false);
```

A partir daí, o resto da rota (l.117-201) já usa `newBipada`/`newBipadoCompleto`/`pedido.status_separacao` — nenhuma outra mudança.

- [ ] **Step 4 — RODAR e ver passar.** `npm run scenarios:only -- "82 — desfazer-bip concorrente"` e `npm run test:integration -- desfazer-bip-decremento-atomico` e `npm run build`
  Expected: **PASS** — o cenário 82 agora dá `quantidade_bipada=1` (rota usa a RPC atômica), o integration da RPC segue verde, build limpo.

- [ ] **Step 5 — COMMIT.**
```bash
git add src/app/api/wms/separacao/desfazer-bip/route.ts scripts/wms/cenarios/catalogo/82-desfazer-bip-concorrente.ts
git commit -m "fix(wms): desfazer-bip usa RPC de decremento atômico (valor retornado decide status) [P021]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: wms-desfazer-bip-decremento-nao-atomico
    date: "2026-06-05"
    source: wms.separacao.desfazer-bip
    category: business_logic
    message: "dois cliques no desfazer-bip decrementam só 1 (read-modify-write)"
    cause: >
      A rota lia quantidade_bipada, calculava N-1 em JS e gravava. Dois cliques
      rápidos liam o mesmo N e ambos gravavam N-1, perdendo um decremento.
    fix: >
      RPC wms_desfazer_bip_atomico(p_pedido_id, p_produto_id) faz
      GREATEST(quantidade_bipada-1, 0) atômico sob FOR UPDATE, identificando o
      item por (pedido_id, tiny_produto_id). A rota usa o valor retornado pra
      decidir bipado_completo e reversão de status.
    files:
      - supabase/migrations/20260605_wms_desfazer_bip_atomico.sql
      - src/app/api/wms/separacao/desfazer-bip/route.ts
      - scripts/wms/cenarios/catalogo/82-desfazer-bip-concorrente.ts
    tags: [separacao, desfazer-bip, decremento, atomic, rpc, P021]
```
Commit:
```bash
git add erros-conhecidos.yaml
git commit -m "docs(erros): wms-desfazer-bip-decremento-nao-atomico [P021]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PR 7: RPC `wms_set_role_permissoes` — replace tudo-ou-nada + FOR UPDATE serializa edição [P138, P139] [MIGRATION/RPC]

**Problema (família grave):** `src/app/api/wms/admin/roles/[id]/permissoes/route.ts:65-76` faz `delete().eq('role_id')` + `insert(rows)` em **duas** chamadas separadas pelo client — sem transação (o próprio docstring l.16-18 admite "best-effort"). Se o insert falha após o delete, o role fica **sem permissões** (P138). E sem serialização: dois PUTs concorrentes fazem delete+insert intercalados → last-write-wins, perda silenciosa (P139).

**Decisões do dono (NOTAs):**
- **P138:** *"troca de permissões de cargo tudo-ou-nada via transação no banco"*.
- **P139:** *"cadeado: um admin edita o cargo por vez; 2º vê aviso e espera"*.

**Síntese (1 RPC unifica os dois — conflito resolvido no mestre, item 5):** `wms_set_role_permissoes(p_role_id uuid, p_codigos text[])` faz `SELECT ... FOR UPDATE` da row do role (serializa P139), depois `DELETE` + `INSERT` na mesma transação implícita (atômico P138). A nota fala em "2º vê aviso e espera" → usar `FOR UPDATE` **blocking** (o 2º espera o 1º terminar e re-aplica serializado; sem mesclar). `siso_role_permissoes(role_id, permissao_codigo, PK(role_id, permissao_codigo))`.

> Nota: a coluna é `permissao_codigo` (não `codigo`). Há precedente de plpgsql nessa tabela (`wms_role_delete` em `20260521_roles_permissoes.sql:145`).

### Task 7.1: Migration — RPC `wms_set_role_permissoes`

**Files**
- Create `supabase/migrations/20260605_wms_set_role_permissoes.sql`
- Test (Create) `test/integration/set-role-permissoes.test.ts`

> **Onde mora o teste:** integração → `test/integration/*.test.ts` (único include do `vitest.integration.config.ts` + globalSetup). Imports daí pra `src/` são `../../src/lib/...`. (O comando `-- set-role-permissoes` casa por substring, então também roda o `set-role-permissoes-rota-concorrencia.test.ts` da Task 7.2 quando ele existir — esperado.)

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Crie `test/integration/set-role-permissoes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let roleId: string;

beforeAll(async () => {
  const { data: r } = await sb
    .from("siso_roles")
    .insert({ codigo: `test_role_${Math.random().toString(36).slice(2, 8)}`, nome: "Test Role", sistema: false })
    .select("id")
    .single();
  roleId = r!.id;
  // semeia 2 permissões existentes
  await sb.from("siso_role_permissoes").insert([
    { role_id: roleId, permissao_codigo: "operacoes.separar" },
    { role_id: roleId, permissao_codigo: "operacoes.embalar" },
  ]);
});

afterAll(async () => {
  await sb.from("siso_role_permissoes").delete().eq("role_id", roleId);
  await sb.from("siso_roles").delete().eq("id", roleId);
});

describe("wms_set_role_permissoes — replace tudo-ou-nada", () => {
  it("replace substitui o conjunto inteiro", async () => {
    const { error } = await sb.rpc("wms_set_role_permissoes", {
      p_role_id: roleId,
      p_codigos: ["operacoes.guardar", "inventario.contar"],
    });
    expect(error).toBeNull();
    const { data: perms } = await sb
      .from("siso_role_permissoes").select("permissao_codigo").eq("role_id", roleId);
    const codigos = (perms ?? []).map((p) => p.permissao_codigo).sort();
    expect(codigos).toEqual(["inventario.contar", "operacoes.guardar"]);
  });

  it("role inexistente → erro, e NÃO esvazia nada", async () => {
    const { error } = await sb.rpc("wms_set_role_permissoes", {
      p_role_id: "00000000-0000-0000-0000-000000000000",
      p_codigos: ["operacoes.guardar"],
    });
    expect(error).not.toBeNull();
    // o role real continua com suas permissões do teste anterior
    const { data: perms } = await sb
      .from("siso_role_permissoes").select("permissao_codigo").eq("role_id", roleId);
    expect((perms ?? []).length).toBe(2);
  });

  it("replace com array vazio zera (caminho válido)", async () => {
    const { error } = await sb.rpc("wms_set_role_permissoes", {
      p_role_id: roleId,
      p_codigos: [],
    });
    expect(error).toBeNull();
    const { data: perms } = await sb
      .from("siso_role_permissoes").select("permissao_codigo").eq("role_id", roleId);
    expect((perms ?? []).length).toBe(0);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- set-role-permissoes`
  Expected: **FAIL** — `function wms_set_role_permissoes(...) does not exist`.

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA (migration).** Crie `supabase/migrations/20260605_wms_set_role_permissoes.sql`:

```sql
-- P138/P139 — Replace atômico das permissões de um role.
--
-- A rota fazia delete+insert em duas chamadas client-side (sem transação): se
-- o insert falhava após o delete, o role ficava sem permissões (P138). E dois
-- PUTs concorrentes intercalavam delete/insert → last-write-wins (P139).
--
-- supabase-js não tem transação multi-statement client-side. Esta função faz,
-- na sua transação implícita:
--   (1) SELECT ... FOR UPDATE da row do role — serializa edições concorrentes
--       (P139: o 2º admin espera o 1º terminar e re-aplica de forma serializada).
--   (2) DELETE de todas as permissões + INSERT das novas — atômico (P138).
-- Qualquer RAISE → rollback total: as permissões pré-existentes permanecem.

CREATE OR REPLACE FUNCTION wms_set_role_permissoes(
  p_role_id uuid,
  p_codigos text[]
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
  v_total   integer;
BEGIN
  -- Lock pessimista por row: serializa P139. O 2º PUT bloqueia aqui até o 1º
  -- commitar, então re-aplica em cima do estado consistente (sem mesclar).
  SELECT id INTO v_role_id FROM siso_roles WHERE id = p_role_id FOR UPDATE;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'role % nao encontrado', p_role_id;
  END IF;

  DELETE FROM siso_role_permissoes WHERE role_id = p_role_id;

  IF array_length(p_codigos, 1) IS NOT NULL THEN
    INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
    SELECT p_role_id, unnest(p_codigos)
    ON CONFLICT (role_id, permissao_codigo) DO NOTHING;
  END IF;

  SELECT count(*) INTO v_total FROM siso_role_permissoes WHERE role_id = p_role_id;
  RETURN v_total;
END;
$$;
```
Aplicar:
```
mcp__supabase__apply_migration  (project ehbxpbeijofxtsbezwxd)
  name: 20260605_wms_set_role_permissoes
  query: <conteúdo do .sql acima>
```

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- set-role-permissoes`
  Expected: **PASS** — replace troca o conjunto; role inexistente não esvazia; vazio zera.

- [ ] **Step 5 — COMMIT.**
```bash
git add supabase/migrations/20260605_wms_set_role_permissoes.sql test/integration/set-role-permissoes.test.ts
git commit -m "feat(wms): RPC wms_set_role_permissoes (replace tudo-ou-nada + FOR UPDATE serializa) [P138,P139]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 7.2: Rota usa a RPC (uma chamada atômica)

**Files**
- Modify `src/app/api/wms/admin/roles/[id]/permissoes/route.ts:60-78` — substituir delete+insert por `sb.rpc("wms_set_role_permissoes", ...)`; manter validação do registry (l.41-48) e regra admin=todas (l.60-63).
- Test (Create) `test/integration/set-role-permissoes-rota-concorrencia.test.ts`

> **Onde mora o teste (crítico):** este teste **precisa** rodar sob o `vitest.integration.config.ts`, que (1) tem `globalSetup: test/integration/globalSetup.ts` → `seedInicial` → `seedTestUsers`, criando o usuário `admin-runner` que o `beforeAll` busca, e (2) injeta `TINY_DISABLED`/`maxWorkers=1` (ambiente de staging serializado). Por isso o arquivo vive em `test/integration/set-role-permissoes-rota-concorrencia.test.ts` — fora desse diretório o globalSetup **não** roda, `admin-runner` não é seeded, e o `.eq("nome","admin-runner").single()` quebraria por causa errada (mascarando o RED real). Imports daí pra `src/` são `../../src/lib/...` e `../../src/app/...`.

> Nota (TDD da ROTA, não da RPC): a Task 7.1 já cobre a RPC isolada (chamando `sb.rpc(...)` direto). Esse teste passa identicamente antes e depois da rota ser trocada — não gateia a mudança de produção da rota (delete+insert client-side → RPC). Este teste **importa o handler `PUT` da rota** e dispara **dois PUTs concorrentes** contra ele. Com o delete+insert antigo, os dois `delete().eq()` + `insert()` intercalam e o resultado pode ficar **mesclado** (4 códigos) ou **vazio/parcial** (um insert sobre o outro) → RED. Com a RPC (`SELECT ... FOR UPDATE` serializa), o conjunto final é exatamente A **ou** B, nunca mesclado/vazio → GREEN.
>
> Ancoragem da auth: o handler usa `getSessionUser(request)` (lê `X-Session-Id` em `siso_sessoes` com `expira_em > now`, `session.ts:86-101`) e `userCan(session, "sistema.roles")`. O `globalSetup` (acima) semeia `admin-runner` com a role `admin` (cross-join de TODAS as permissões em `20260521_roles_permissoes.sql:62`, inclui `sistema.roles`); o fixture só cria uma **sessão** pra esse usuário já existente. O `HttpClient` do harness de cenários **não tem `put`** (só get/post/patch/delete em `_harness/types.ts`), por isso chamamos o handler direto via `Request` em vez de cenário HTTP.

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA (concorrência P139 NA ROTA).** Crie `test/integration/set-role-permissoes-rota-concorrencia.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { PUT } from "../../src/app/api/wms/admin/roles/[id]/permissoes/route";

const sb = createServiceClient();
let roleId: string;
let sessionId: string;

beforeAll(async () => {
  // Role-alvo da edição.
  const { data: r } = await sb
    .from("siso_roles")
    .insert({ codigo: `test_rota_${Math.random().toString(36).slice(2, 8)}`, nome: "Rota Conc Role", sistema: false })
    .select("id")
    .single();
  roleId = r!.id;

  // Sessão válida do admin-runner. O globalSetup (test/integration/globalSetup.ts)
  // roda seedInicial → seedTestUsers, que cria 'admin-runner' (PIN 1001) com a
  // role 'admin' (cross-join de TODAS as permissões → inclui 'sistema.roles').
  // Logo o usuário e o vínculo de role já existem aqui.
  const { data: admin } = await sb
    .from("siso_usuarios").select("id").eq("nome", "admin-runner").single();
  const { data: sess } = await sb
    .from("siso_sessoes")
    .insert({ usuario_id: admin!.id, expira_em: new Date(Date.now() + 3600_000).toISOString() })
    .select("id")
    .single();
  sessionId = sess!.id;
});

afterAll(async () => {
  await sb.from("siso_sessoes").delete().eq("id", sessionId);
  await sb.from("siso_role_permissoes").delete().eq("role_id", roleId);
  await sb.from("siso_roles").delete().eq("id", roleId);
});

function reqPut(perms: string[]): Request {
  return new Request(`http://test/api/wms/admin/roles/${roleId}/permissoes`, {
    method: "PUT",
    headers: { "X-Session-Id": sessionId, "Content-Type": "application/json" },
    body: JSON.stringify({ permissoes: perms }),
  });
}

describe("rota PUT permissoes — serialização concorrente (P139)", () => {
  it("dois PUTs concorrentes resultam em EXATAMENTE um conjunto (nunca mesclado/vazio)", async () => {
    const A = ["operacoes.separar", "operacoes.embalar"];
    const B = ["inventario.contar"];
    const params = Promise.resolve({ id: roleId });
    await Promise.all([
      PUT(reqPut(A), { params }),
      PUT(reqPut(B), { params }),
    ]);
    const { data: perms } = await sb
      .from("siso_role_permissoes").select("permissao_codigo").eq("role_id", roleId);
    const codigos = (perms ?? []).map((p) => p.permissao_codigo).sort();
    const isA = JSON.stringify(codigos) === JSON.stringify([...A].sort());
    const isB = JSON.stringify(codigos) === JSON.stringify([...B].sort());
    expect(isA || isB).toBe(true); // serializado, não mesclado (A∪B = 3 códigos)
    expect(codigos.length).toBeGreaterThan(0); // nunca vazio/parcial
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar (rota antiga delete+insert).** `npm run test:integration -- set-role-permissoes-rota-concorrencia`
  Expected: **FAIL** — com o delete+insert client-side sem serialização, os dois PUTs intercalam: o resultado tende a ficar **mesclado** (`codigos.length===3`, A∪B) ou **vazio/parcial** (um delete apaga o insert do outro). Em ambos `isA || isB` é `false` (ou `length===0`), o teste falha. (Nota: por ser uma corrida, rodar 1–2× pra confirmar a falha; o read-modify-write não-serializado é não-determinístico mas o caminho mesclado é o mais comum.)

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA.** Na rota, substituir o bloco de replace (l.65-78) pela RPC:

```ts
  // P138/P139: replace atômico + serializado na RPC (delete+insert numa só
  // transação, sob FOR UPDATE do role). Substitui o delete+insert client-side.
  const { data: total, error: rpcErr } = await sb.rpc("wms_set_role_permissoes", {
    p_role_id: id,
    p_codigos: finalSet,
  });
  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, total: total ?? finalSet.length });
}
```

(A validação do registry l.41-48 e a regra admin=todas l.60-63 permanecem intactas — `finalSet` já é o conjunto resolvido.)

> Nota: o docstring "best-effort" (l.16-18) descreve o comportamento antigo — atualizar a linha pra refletir o replace atômico via RPC.

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- set-role-permissoes-rota-concorrencia` e `npm run build`
  Expected: **PASS** — com a rota usando a RPC (`FOR UPDATE` serializa), o conjunto final é A ou B (nunca vazio/mesclado), build limpo. O mesmo teste que falhava na rota antiga agora passa: este é o RED→GREEN que gateia a mudança de produção da rota.

- [ ] **Step 5 — COMMIT.**
```bash
git add src/app/api/wms/admin/roles/[id]/permissoes/route.ts test/integration/set-role-permissoes-rota-concorrencia.test.ts
git commit -m "fix(wms): rota de permissões de role usa RPC atômica wms_set_role_permissoes [P138,P139]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: wms-set-role-permissoes-delete-insert-nao-atomico
    date: "2026-06-05"
    source: wms.admin.roles.permissoes
    category: business_logic
    message: "role fica sem permissões / perda silenciosa ao editar permissões"
    cause: >
      A rota fazia delete+insert em duas chamadas client-side (sem transação).
      Falha no insert após o delete deixava o role vazio (P138); edições
      concorrentes intercalavam delete/insert → last-write-wins (P139).
    fix: >
      RPC wms_set_role_permissoes(p_role_id, p_codigos): SELECT FOR UPDATE do
      role (serializa concorrência) + delete+insert na mesma transação
      (tudo-ou-nada). Rollback total em qualquer erro mantém o conjunto antigo.
    files:
      - supabase/migrations/20260605_wms_set_role_permissoes.sql
      - src/app/api/wms/admin/roles/[id]/permissoes/route.ts
    tags: [roles, permissoes, rpc, atomic, for-update, P138, P139]
```
Commit:
```bash
git add erros-conhecidos.yaml
git commit -m "docs(erros): wms-set-role-permissoes-delete-insert-nao-atomico [P138,P139]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PR 8: Claim atômico de classify de devolução (compare-and-set status) — base p/ fase 4 [P052] [MIGRATION/RPC]

**Problema (P052, grave):** `classificarDevolucao` (`src/lib/wms/devolucoes.ts:103-118`) tem guard TOCTOU: a leitura do status (l.118) e a escrita final (l.325-334) estão separadas por **todas** as movs. Sob concorrência real (duplo-clique com rede lenta), ambas as requisições passam o read-check `if (d.status !== "aguardando_classificacao") throw "já classificada"` e emitem movs duplicadas. O guard sequencial cobre duplo-clique simples, mas não a janela concorrente.

**Decisão do dono (NOTA):** *"verificar status aguardando_classificacao antes de processar; rejeita 2ª chamada"*.

**Síntese (base atômica p/ fase 4):** a Fase 4 fará a RPC completa `wms_classificar_devolucao` (movs+status na mesma tx). **Aqui** entregamos só a peça-fundação: um **claim atômico de status** que compara-e-seta `aguardando_classificacao` antes de qualquer mov, rejeitando a 2ª chamada concorrente. Como a CHECK de `siso_devolucoes_pendentes.status` **não tem** `classificando`, o claim usa uma coluna de lease leve `classificacao_em_andamento_por` (espelho do padrão de transferência/guarda) em vez de mudar `status`.

> Nota: divergência do achado — o achado sugere `UPDATE ... SET status='classificando' WHERE status='aguardando_classificacao'`, mas a CHECK constraint (`20260605_wms_excecoes_dashboards.sql:14-16` e `20260527_devolucoes_pendentes_status_aplicada.sql:16`) **proíbe** `classificando`. Em vez de relaxar a CHECK (toca o backstop de banco), uso uma coluna de lease `classificacao_em_andamento_por uuid` claimada via UPDATE condicional — o `status` continua `aguardando_classificacao` até o flip final pra `classificada`. Isso fecha a janela concorrente sem violar a CHECK e é a base reusável pela RPC da fase 4.

> Nota de ancoragem (fixture): o CREATE TABLE de `siso_devolucoes_pendentes` (`supabase/migrations/20260605_wms_excecoes_dashboards.sql:7-23`) tem **apenas** `id` (DEFAULT `gen_random_uuid()`), `status` (NOT NULL DEFAULT `'aguardando_classificacao'`), `payload_webhook` (NOT NULL DEFAULT `'{}'`) e `criado_em` (NOT NULL DEFAULT `now()`) como colunas com restrição — **todas com default**. Os demais campos (`nota_fiscal_id`, `chave_acesso_nf`, `pedido_origem_id`, `pedido_origem_mov_id`, `empresa_id`, `classificacao`, `classificada_por`, `classificada_em`, `observacoes`) são **nullable**. **Não existem** colunas `qty`/`quantidade`/`produto_id`/`galpao_id`. Logo o INSERT do fixture com só `{ status }` **não** dispara NOT NULL — garantindo que o **Expected FAIL** do Step 2 seja atribuído à coluna de lease `classificacao_em_andamento_por` faltante (e não a um NOT NULL acidental que mascararia a causa).

### Task 8.1: Migration — coluna de lease + claim atômico em `classificarDevolucao`

**Files**
- Create `supabase/migrations/20260605_devolucao_classificacao_em_andamento.sql`
- Modify `src/lib/wms/devolucoes.ts:101-118` — claim atômico antes das movs; limpar o lease no flip final (l.325-334) e no sad-path.
- Test (Create) `test/integration/devolucoes-classificar-concorrente.test.ts`

> **Onde mora o teste:** integração → `test/integration/*.test.ts` (único include do `vitest.integration.config.ts` + globalSetup). Imports daí pra `src/` são `../../src/lib/...`.

**Steps**

- [ ] **Step 1 — ESCREVER O TESTE QUE FALHA.** Crie `test/integration/devolucoes-classificar-concorrente.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { classificarDevolucao } from "../../src/lib/wms/devolucoes";

const sb = createServiceClient();
let galpaoId: string, locId: string, produtoId: string, usuarioId: string;

async function novaDevolucao(): Promise<string> {
  // siso_devolucoes_pendentes NÃO tem produto_id/galpao_id/qty — esses vêm via
  // ClassificarInput. As únicas colunas com restrição (status, payload_webhook,
  // criado_em, id) têm DEFAULT (ver CREATE TABLE em 20260605_wms_excecoes_
  // dashboards.sql:7-23), então o insert com só { status } é suficiente — não
  // há NOT NULL sem default que faria o beforeAll quebrar por outra causa.
  const { data: d } = await sb
    .from("siso_devolucoes_pendentes")
    .insert({ status: "aguardando_classificacao" })
    .select("id")
    .single();
  return d!.id;
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).limit(1).single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `TEST-DEV-CLAIM-${Math.random().toString(36).slice(2, 8)}`, descricao: "claim test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").limit(1).single();
  usuarioId = u!.id;
});

describe("classificarDevolucao — claim atômico de status", () => {
  it("2 classify concorrentes: exatamente 1 vence, o outro rejeita", async () => {
    const devId = await novaDevolucao();
    const input = {
      devolucao_id: devId,
      classificacao: "integro" as const,
      galpao_id: galpaoId,
      localizacao_id: locId,
      produto_id: produtoId,
      qty: 1,
      usuario_id: usuarioId,
    };
    const results = await Promise.allSettled([
      classificarDevolucao(input),
      classificarDevolucao(input),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rej = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(1);
    expect(rej).toBe(1);

    // movs geradas = exatamente as de 1 classificação (Classe A = 1 mov E).
    const { data: movs } = await sb
      .from("siso_movimentacoes").select("id").eq("devolucao_id", devId);
    expect((movs ?? []).length).toBe(1);
  });
});
```

- [ ] **Step 2 — RODAR e ver falhar.** `npm run test:integration -- classificar-concorrente`
  Expected: **FAIL** com `column "classificacao_em_andamento_por" does not exist` (a migration da Task 8.1 ainda não foi aplicada e o claim novo referencia a coluna). O `beforeAll`/fixture **não** quebra por NOT NULL — confirmado na Nota de ancoragem acima (todas as colunas com restrição têm default). Após aplicar a migration mas antes do claim, a falha vira `ok=2` (ambas as chamadas passam o read-check e geram 2 movs).

- [ ] **Step 3 — IMPLEMENTAÇÃO MÍNIMA (migration).** Crie `supabase/migrations/20260605_devolucao_classificacao_em_andamento.sql`:

```sql
-- P052 — Lease de classificação de devolução (claim atômico anti-race).
--
-- classificarDevolucao tinha guard TOCTOU: lia status (aguardando_classificacao),
-- emitia N movs, e só no fim setava status='classificada'. Duas chamadas
-- concorrentes ambas passavam o read-check e duplicavam movs.
--
-- A CHECK de status (IN aguardando_classificacao/classificada/aplicada/cancelada)
-- proíbe um estado intermediário 'classificando'. Em vez de relaxar a CHECK
-- (backstop de banco), adicionamos uma coluna de lease claimada via UPDATE
-- condicional — mesmo padrão de recebimento_em_andamento_por (transferência) e
-- iniciada_por (guarda). É a base reusável pela RPC wms_classificar_devolucao
-- (fase 4), onde o claim vira o primeiro statement da transação.

ALTER TABLE siso_devolucoes_pendentes
  ADD COLUMN IF NOT EXISTS classificacao_em_andamento_por uuid;

COMMENT ON COLUMN siso_devolucoes_pendentes.classificacao_em_andamento_por IS
  'P052 — Lease anti-race em classificarDevolucao. Claimado via UPDATE '
  'condicional (WHERE status=aguardando_classificacao AND col IS NULL) antes '
  'de emitir movs; limpado no flip pra status=classificada e no sad-path. '
  'Loser concorrente leva 0 rows e rejeita.';
```
Aplicar:
```
mcp__supabase__apply_migration  (project ehbxpbeijofxtsbezwxd)
  name: 20260605_devolucao_classificacao_em_andamento
  query: <conteúdo do .sql acima>
```

Em `src/lib/wms/devolucoes.ts`, substituir o read-check (l.103-118) por claim atômico:

```ts
export async function classificarDevolucao(input: ClassificarInput): Promise<void> {
  const sb = createServiceClient();

  // P052: claim atômico de status (compare-and-set). Fecha a janela
  // concorrente: só uma chamada reivindica a devolução; a 2ª leva 0 rows e
  // rejeita. O status segue 'aguardando_classificacao' (a CHECK proíbe
  // 'classificando') — usamos o lease classificacao_em_andamento_por.
  const { data: claimed } = await sb
    .from("siso_devolucoes_pendentes")
    .update({ classificacao_em_andamento_por: input.usuario_id })
    .eq("id", input.devolucao_id)
    .eq("status", "aguardando_classificacao")
    .is("classificacao_em_andamento_por", null)
    .select("id");
  if (!claimed || claimed.length === 0) {
    throw new Error("já classificada ou em classificação por outro operador");
  }

  const { data: dev, error } = await sb
    .from("siso_devolucoes_pendentes")
    .select("*")
    .eq("id", input.devolucao_id)
    .single();
  if (error || !dev) throw new Error("devolução não encontrada");
  type DevRow = {
    status: string;
    pedido_origem_mov_id: string | null;
    nota_fiscal_id: number | null;
    chave_acesso_nf: string | null;
    empresa_id: string | null;
    payload_webhook: unknown;
  };
  const d = dev as DevRow;
```

(Remover a linha `if (d.status !== "aguardando_classificacao") throw new Error("já classificada");` — o claim já garante isso.)

No flip final (l.325-334), incluir a limpeza do lease:

```ts
  await sb
    .from("siso_devolucoes_pendentes")
    .update({
      status: "classificada",
      classificacao: input.classificacao,
      classificada_por: input.usuario_id,
      classificada_em: new Date().toISOString(),
      observacoes: input.observacoes,
      classificacao_em_andamento_por: null,
    })
    .eq("id", input.devolucao_id);
```

Envolver as movs num `try/catch` que limpa o lease no sad-path (pra não deixar a devolução presa se uma mov falhar). Inserir logo após o claim/SELECT do header, antes do `switch (input.classificacao)`:

```ts
  try {
    // ... todo o corpo existente: upsertNotaFiscal, resolução de empresa,
    // custo, switch(classificacao) com inserirMovimentacao, e o flip final.
  } catch (e) {
    // Sad-path: libera o lease pra a devolução não ficar presa. Só limpa se
    // ainda formos o dono (proteção contra interleavings).
    await sb
      .from("siso_devolucoes_pendentes")
      .update({ classificacao_em_andamento_por: null })
      .eq("id", input.devolucao_id)
      .eq("classificacao_em_andamento_por", input.usuario_id)
      .catch(() => {});
    throw e;
  }
}
```

> Nota: ao envolver o corpo no `try`, manter a indentação e o `logger.info(...)` final dentro do `try` (antes do flip ou logo após). Não alterar a lógica de movs — só o claim no início, a limpeza do lease no flip, e o `try/catch` ao redor.

- [ ] **Step 4 — RODAR e ver passar.** `npm run test:integration -- classificar-concorrente`
  Expected: **PASS** — exatamente 1 vence, 1 rejeita, 1 mov gerada.

- [ ] **Step 5 — COMMIT.**
```bash
git add supabase/migrations/20260605_devolucao_classificacao_em_andamento.sql src/lib/wms/devolucoes.ts test/integration/devolucoes-classificar-concorrente.test.ts
git commit -m "fix(wms): claim atômico de status no classificarDevolucao (anti-race) [P052]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6 — Adicionar entrada em `erros-conhecidos.yaml`.**
```yaml
  - id: wms-devolucao-classificar-toctou-movs-duplicadas
    date: "2026-06-05"
    source: wms.devolucoes.classificar
    category: business_logic
    message: "classify concorrente de devolução duplica movimentações (TOCTOU)"
    cause: >
      classificarDevolucao lia o status (aguardando_classificacao), emitia N
      movs e só no fim setava classificada. Duas chamadas concorrentes ambas
      passavam o read-check e geravam movs duplicadas. A CHECK de status proíbe
      um estado intermediário 'classificando'.
    fix: >
      Claim atômico via lease classificacao_em_andamento_por (UPDATE condicional
      WHERE status=aguardando_classificacao AND col IS NULL): a 2ª chamada leva
      0 rows e rejeita. Lease limpo no flip pra classificada e no sad-path.
      Base reusável pela RPC wms_classificar_devolucao (fase 4).
    files:
      - supabase/migrations/20260605_devolucao_classificacao_em_andamento.sql
      - src/lib/wms/devolucoes.ts
    tags: [devolucao, classificar, toctou, claim, race, P052]
```
Commit:
```bash
git add erros-conhecidos.yaml
git commit -m "docs(erros): wms-devolucao-classificar-toctou-movs-duplicadas [P052]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Fechamento da Fase 1

Ao concluir os 8 PRs, rodar a suíte completa e atualizar docs:

- [ ] `npm test` (unit) — todos verdes.
- [ ] `npm run test:integration` — todos verdes (serializado vs staging).
- [ ] `npm run scenarios` — cenário de embalagem-idempotência verde.
- [ ] `npm run lint && npm run build` — limpos.
- [ ] Atualizar `docs/api-reference-complete.md` se a forma de erro/body de `confirmar-item-embalagem`, `desfazer-bip`, `guarda/[id]/iniciar`, `transferencias/[id]/cancelar`, `admin/roles/[id]/permissoes` mudou (campos `client_request_id`, `forcar`, codes 409). Atualizar `docs/database-schema.md` com as colunas novas (`recebimento_em_andamento_em`, `classificacao_em_andamento_por`) e a tabela `siso_idempotencia_embalagem` + as RPCs novas.
- [ ] Confirmar que todas as 8 entradas de `erros-conhecidos.yaml` estão presentes.

**Ordem de execução dos PRs:** PR 1 (sem dep, quick win) → PR 4 (sem dep, quick win) → PR 6 (sem dep) → PR 3 → PR 2 (migration) → PR 5 (migration) → PR 7 (migration) → PR 8 (migration, base p/ fase 4). PRs 2/5/6/7/8 exigem migration aplicada no staging antes do GREEN; sem deps cruzadas entre eles.
