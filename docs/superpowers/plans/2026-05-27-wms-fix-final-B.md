# WMS Fix-Final B — Out-of-scope + tasks P6 órfãs (P2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os 11 itens P2 residuais da auditoria 2026-05-26 — 3 tasks P6 sem commit rastreável (B1/B2/B3), 2 out-of-scope P3 do tipo "finally" (B4/B5), 3 out-of-scope P5 de UI/UX (B6/B7/B8) e 3 colunas/RPCs deferidos pra futuro (B9/B10/B11).

**Architecture:**
- Code fixes pontuais em `src/lib/wms/*`, `src/app/api/wms/*`, RPCs (`wms_inventario_sugerir`), 2-3 migrations leves (colunas novas em tabelas existentes), 1 componente UI (`parcial-modal`).
- TDD via cenários quando faz sentido (B4/B5/B9/B10/B11 — RPCs e ledger), validação manual + grep pra tasks puramente UI (B6/B7) ou cleanup (B1/B3).
- **Pré-requisito:** Fix-A merged em `develop`. Este plano roda em branch `wms-fix-final-b` partindo de `develop` pós-Fix-A.

**Tech Stack:** Same as Fix-A — Next.js 16, TypeScript, Supabase (PostgREST + RPC), Tailwind 4.

**Spec:** [`docs/superpowers/specs/2026-05-27-wms-fix-final-design.md`](../specs/2026-05-27-wms-fix-final-design.md) §3 (itens B1-B11).

---

## Arquivos afetados

**Criar:**
- `supabase/migrations/20260528_movs_devolucao_id.sql` (B9)
- `supabase/migrations/20260528_pendencias_tracking_origem_ids.sql` (B11)
- `supabase/migrations/20260528_inventario_sugerir_exclui_quarentena.sql` (B5)
- `scripts/wms/cenarios/catalogo/33-replenishment-cria-mov.ts` (B8)
- `scripts/wms/cenarios/catalogo/34-desfazer-guarda-parcial-qty.ts` (B10)
- `scripts/wms/cenarios/catalogo/35-desclassificar-via-devolucao-id.ts` (B9)

**Modificar:**
- `src/app/api/wms/transferir-galpao/route.ts` — DELETAR se órfão (B1)
- `src/lib/wms/vendas-disponibilidade.ts` — remover hardcoded (B2)
- `src/app/api/wms/separacao/cancelar/route.ts` — limitar JSONB (B3)
- `src/lib/wms/inventario.ts` — guard re-execução `computarDivergencias` (B4)
- `src/app/api/wms/separacao/marcar-item/route.ts` — mensagem `desfazer-parcial` correta (B6)
- `src/components/wms/separacao/parcial-modal.tsx` — opção "encaminhar OC" (B7)
- `src/app/wms/replenishment/page.tsx` — botão "criar movimentação" (B8)
- `src/app/api/wms/devolucoes/[id]/desclassificar/route.ts` — usar `devolucao_id` (B9)
- `src/app/api/wms/guarda/[id]/desfazer/route.ts` — aceitar `{ qty }` (B10)
- `src/lib/nf-webhook-handler.ts` — popular `tracking_origem_ids` (B11)
- `erros-conhecidos.yaml` — 11 entradas novas
- `docs/database-schema.md` — 3 colunas novas
- `CLAUDE.md` — "Recently Fixed: Fix-Final B"

---

## Phase 1 — Setup

### Task 1: Branch + baseline

- [ ] **Step 1: Garantir Fix-A já está em develop**

```bash
git checkout develop && git pull
git log --oneline | grep "fix-final-a\|fix-final-A" | head -3
```
Expected: commits do Fix-A presentes.

- [ ] **Step 2: Criar branch + worktree**

```bash
git worktree add -b wms-fix-final-b .claude/worktrees/wms-fix-final-b/ develop
cd .claude/worktrees/wms-fix-final-b
```

- [ ] **Step 3: Suite verde de partida**

```bash
npm run scenarios
```
Expected: 32/32 PASS (cenários do Fix-A incluídos).

---

## Phase 2 — B1: Deletar endpoint órfão `transferir-galpao`

### Task 2: Validar + deletar

**Files:**
- Delete: `src/app/api/wms/transferir-galpao/route.ts` (se órfão)

- [ ] **Step 1: Confirmar arquivo existe**

```bash
ls -la src/app/api/wms/transferir-galpao/route.ts
```

- [ ] **Step 2: Procurar consumidores**

```bash
grep -rn "api/wms/transferir-galpao\|transferir-galpao" src/ scripts/ docs/ \
  | grep -v "transferir-galpao/route.ts" | grep -v "node_modules"
```

- [ ] **Step 3: Decidir**

- Se zero consumidores: deletar arquivo + entrada em `docs/api-reference-complete.md`. Prosseguir.
- Se há consumidores: abrir issue + skipar task (anotar no commit por quê).

- [ ] **Step 4: Deletar (caso órfão)**

```bash
rm src/app/api/wms/transferir-galpao/route.ts
rmdir src/app/api/wms/transferir-galpao 2>/dev/null
```

Editar `docs/api-reference-complete.md` — remover seção do endpoint.

- [ ] **Step 5: Build pra garantir nada quebra**

```bash
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(api): delete transferir-galpao órfão (fix-final-B T2 / P6 A.5)"
```

---

## Phase 3 — B2: `vendas-disponibilidade` sem hardcoded

### Task 3: Remover nomes "CWB"/"SP" do código

**Files:**
- Modify: `src/lib/wms/vendas-disponibilidade.ts`
- Modify: `src/app/api/wms/vendas/disponibilidade/route.ts` (se também tiver)

- [ ] **Step 1: Localizar hardcoded**

```bash
grep -rn "'CWB'\|'SP'\|\"CWB\"\|\"SP\"" src/lib/wms/vendas-disponibilidade.ts src/app/api/wms/vendas/
```

- [ ] **Step 2: Refatorar pra consulta dinâmica**

Substituir comparações por nome por uso de `siso_empresa_galpoes_preferenciais` (geo-priority=0) ou `siso_galpoes` (lista). Padrão já existe em `src/lib/wms/roteamento.ts` — reusar.

Exemplo (depende do código atual):
```ts
// ANTES:
if (galpao.nome === "CWB") { ... }

// DEPOIS:
const { data: prefs } = await sb.from("siso_empresa_galpoes_preferenciais")
  .select("galpao_id")
  .eq("empresa_id", empresaOrigemId);
const galpoesPreferidos = (prefs ?? []).map(p => p.galpao_id);
if (galpoesPreferidos.includes(galpao.id)) { ... }
```

- [ ] **Step 3: Rodar cenários de venda direta (12 + 13)**

```bash
npm run scenarios -- --only=12,13
```
Expected: 2/2 PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/vendas-disponibilidade.ts src/app/api/wms/vendas/disponibilidade/route.ts 2>/dev/null
git commit -m "fix(vendas): remove hardcoded CWB/SP em vendas-disponibilidade (fix-final-B T3 / P6 B.3)"
```

---

## Phase 4 — B3: Limitar `movs_estornadas` JSONB no `cancelar`

### Task 4: Truncar array no cancelamento de separação

**Files:**
- Modify: `src/app/api/wms/separacao/cancelar/route.ts`

- [ ] **Step 1: Localizar onde grava `movs_estornadas`**

```bash
grep -n "movs_estornadas" src/app/api/wms/separacao/cancelar/route.ts
```

- [ ] **Step 2: Truncar pra 50 + adicionar contador**

```ts
const MAX_MOVS_LOG = 50;
const movsEstornadasArr = [...]; // array completo coletado durante cancelamento
const movsParaLog = movsEstornadasArr.slice(-MAX_MOVS_LOG); // últimas N
const updatePayload = {
  status_separacao: "cancelado",
  movs_estornadas: movsParaLog,
  movs_estornadas_total: movsEstornadasArr.length,
  movs_estornadas_truncado: movsEstornadasArr.length > MAX_MOVS_LOG,
};
```

Coluna `movs_estornadas_total` (int) e `movs_estornadas_truncado` (bool) podem precisar de migration trivial. Se já existem campos genéricos JSONB (`metadata`), guardar lá:

```ts
metadata: { ...item.metadata, movs_estornadas_total: movsEstornadasArr.length }
```

- [ ] **Step 3: Smoke manual: cancelar pedido com 5 movs + cancelar pedido sintético com 100 movs**

Pedido com 5 movs: payload completo. Pedido com 100 movs: payload truncado pra 50 + contador.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/separacao/cancelar/route.ts
git commit -m "fix(separacao): limita movs_estornadas JSONB a 50 + contador (fix-final-B T4 / P6 E.26)"
```

---

## Phase 5 — B4: `computarDivergencias` re-execução

### Task 5: Guard contra duplicate cleanup

**Files:**
- Modify: `src/lib/wms/inventario.ts`

- [ ] **Step 1: Localizar `computarDivergencias`**

```bash
grep -n "computarDivergencias\|cleanup.*lock" src/lib/wms/inventario.ts
```

- [ ] **Step 2: Adicionar guard early-return**

No topo da função, após validações iniciais:

```ts
const { data: sessao } = await sb.from("siso_inventario_sessoes")
  .select("id, status")
  .eq("id", sessaoId)
  .single();

if (sessao?.status === "revisao" || sessao?.status === "aprovada" || sessao?.status === "aplicada") {
  // Já computado — retorna no-op (não roda cleanup denovo)
  logger.info("computarDivergencias", "sessao já em revisão/aprovada/aplicada, no-op", { sessaoId, status: sessao.status });
  return { divergencias: [], no_op: true };
}
```

- [ ] **Step 3: Smoke manual: rodar `computarDivergencias` 2x em sessão e validar 2ª chamada é no-op**

Via cenário ou via UI:
1. Criar sessão de inventário.
2. Finalizar contagens.
3. Chamar `/inventario/[id]/aprovar` (que chama `computarDivergencias`) → status=revisao.
4. Chamar de novo → resposta `{ no_op: true }`, sem novo cleanup nos logs.

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/inventario.ts
git commit -m "fix(inventario): computarDivergencias guard contra re-execução (fix-final-B T5 / #4.13)"
```

---

## Phase 6 — B5: Excluir `quarentena` da sugestão de inventário

### Task 6: Migration `wms_inventario_sugerir` exclui quarentena

**Files:**
- Create: `supabase/migrations/20260528_inventario_sugerir_exclui_quarentena.sql`

- [ ] **Step 1: Localizar RPC atual**

Via MCP:
```sql
SELECT pg_get_functiondef('wms_inventario_sugerir'::regproc);
```

- [ ] **Step 2: Re-criar RPC com filtro `l.tipo != 'quarentena'`**

Criar migration:

```sql
-- Fix-Final B T6: wms_inventario_sugerir exclui locs tipo=quarentena
CREATE OR REPLACE FUNCTION wms_inventario_sugerir(p_galpao uuid, p_tamanho int)
RETURNS TABLE(localizacao_id uuid, motivo text) AS $$
BEGIN
  RETURN QUERY
  -- ... query original, mas com filtro extra:
  WITH locs_validas AS (
    SELECT l.id, l.codigo
    FROM siso_localizacoes l
    WHERE l.galpao_id = p_galpao
      AND l.ativo = true
      AND l.tipo != 'quarentena'  -- NOVO: exclui quarentena
  )
  -- ... resto da query
  ;
END;
$$ LANGUAGE plpgsql;
```

**Importante:** copiar a definição atual da RPC (Step 1) e adicionar APENAS o filtro `l.tipo != 'quarentena'` em todos os `FROM siso_localizacoes`. Não reescrever do zero.

- [ ] **Step 3: Aplicar migration em staging**

```
mcp__supabase__apply_migration(
  project_id="ehbxpbeijofxtsbezwxd",
  name="20260528_inventario_sugerir_exclui_quarentena",
  query="<SQL acima>"
)
```

- [ ] **Step 4: Validar via SQL**

```sql
-- Criar 1 loc quarentena pra teste
INSERT INTO siso_localizacoes (galpao_id, codigo, tipo) VALUES ('<galpao>', 'QUAR-TEST-01', 'quarentena');
INSERT INTO siso_estoque (produto_id, galpao_id, localizacao_id, saldo) VALUES ('<prod>', '<galpao>', '<loc-quar>', 10);
SELECT * FROM wms_inventario_sugerir('<galpao>', 100);
-- Esperado: loc QUAR-TEST-01 NÃO aparece no resultado
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260528_inventario_sugerir_exclui_quarentena.sql
git commit -m "fix(inventario): wms_inventario_sugerir exclui quarentena (fix-final-B T6 / #6.9)"
```

---

## Phase 7 — B6: `desfazer-parcial` mensagem aponta UI real

### Task 7: Auditar + corrigir mensagens

**Files:**
- Modify: `src/app/api/wms/separacao/marcar-item/route.ts` (e outros que mencionem `desfazer-parcial`)

- [ ] **Step 1: Localizar todas as mensagens**

```bash
grep -rn "desfazer-parcial\|/desfazer-parcial" src/ --include="*.ts" --include="*.tsx"
```

- [ ] **Step 2: Validar quais apontam pra UI existente vs inexistente**

Cada match: ler contexto. Se mensagem diz "use a UI /desfazer-parcial" mas essa rota não existe, corrigir pra apontar `parcial-modal` ou `pedidos/[id]` (UI real).

- [ ] **Step 3: Substituir mensagens incorretas**

Exemplo:
```ts
// ANTES:
return NextResponse.json({ error: "use /desfazer-parcial pra reverter" }, { status: 409 });

// DEPOIS:
return NextResponse.json({ error: "abra o pedido em /wms/pedidos/[id] e use o botão 'Desfazer parcial' no card do item" }, { status: 409 });
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/separacao/marcar-item/route.ts # + outros que tocou
git commit -m "fix(separacao): mensagens desfazer-parcial apontam UI real (fix-final-B T7 / #2.17)"
```

---

## Phase 8 — B7: `parcial-modal` opção "encaminhar OC"

### Task 8: Adicionar 3ª opção no modal

**Files:**
- Modify: `src/components/wms/separacao/parcial-modal.tsx`

- [ ] **Step 1: Ler estrutura atual do modal**

```bash
grep -n "radio\|opcao\|encaminhar\|esgotado" src/components/wms/separacao/parcial-modal.tsx | head -20
```

- [ ] **Step 2: Adicionar 3ª opção UI**

No JSX, abaixo das opções existentes ("Parcial: loc zerou" / "Parcial: cobertura insuficiente"):

```tsx
<label className="flex items-start gap-2 cursor-pointer">
  <input
    type="radio"
    name="acao_parcial"
    value="encaminhar_oc"
    checked={selectedAcao === "encaminhar_oc"}
    onChange={() => setSelectedAcao("encaminhar_oc")}
  />
  <div>
    <div className="font-medium">Encaminhar pra OC</div>
    <div className="text-xs text-zinc-400">Item sem cobertura em nenhum galpão — sugere compra ao fornecedor</div>
  </div>
</label>
```

- [ ] **Step 3: Implementar handler**

No `onSubmit`, branch:
```ts
if (selectedAcao === "encaminhar_oc") {
  await sisoFetch(`/api/wms/separacao/encaminhar`, {
    method: "POST",
    body: JSON.stringify({ pedido_id: pedidoId, decisao: "oc" }),
  });
  onClose();
  return;
}
```

- [ ] **Step 4: Smoke manual em staging**

Pedido com item sem cobertura → modal abre → escolher "encaminhar OC" → pedido vai pra `compras_status='a_comprar'`.

- [ ] **Step 5: Commit**

```bash
git add src/components/wms/separacao/parcial-modal.tsx
git commit -m "feat(separacao): parcial-modal opção 'encaminhar OC' (fix-final-B T8 / #5.22)"
```

---

## Phase 9 — B8: `/wms/replenishment` deixa de ser readonly

### Task 9: Cenário 33 — replenishment cria mov

**Files:**
- Create: `scripts/wms/cenarios/catalogo/33-replenishment-cria-mov.ts`

- [ ] **Step 1: Criar cenário**

Sequência:
1. Receber estoque em loc overstock (saldo 100).
2. Loc picking do mesmo produto: saldo 0.
3. `POST /api/wms/replenishment { produto_id, galpao_id, loc_origem, loc_destino, qty: 20 }`.
4. Asserts:
   - Mov par S+E criada (overstock → picking).
   - Saldo correto pós-mov.
   - I1-I7 verde.

Esse endpoint **já existe** (CLAUDE.md confirma: `replenishment/route.ts`). Cenário valida que ainda funciona.

- [ ] **Step 2: Rodar — esperado PASS (já existe backend)**

Se falhar, há bug latente no endpoint — fixar antes de continuar.

- [ ] **Step 3: Commit cenário**

```bash
git add scripts/wms/cenarios/catalogo/33-replenishment-cria-mov.ts
git commit -m "test(cenarios): 33 replenishment cria mov (fix-final-B T9 / #8.13)"
```

---

### Task 10: Botão "Criar movimentação" na página

**Files:**
- Modify: `src/app/wms/replenishment/page.tsx`

- [ ] **Step 1: Ler página atual**

Identificar como sugestões são listadas (provavelmente tabela).

- [ ] **Step 2: Adicionar botão por linha**

```tsx
<button
  onClick={() => createMovMutation.mutate({
    produto_id: row.produto_id,
    galpao_id: row.galpao_id,
    loc_origem: row.loc_origem_id,
    loc_destino: row.loc_destino_id,
    qty: row.qty_sugerida,
  })}
  className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500"
  disabled={createMovMutation.isPending}
>
  Criar mov
</button>
```

```ts
const createMovMutation = useMutation({
  mutationFn: (body) => sisoFetch("/api/wms/replenishment", { method: "POST", body: JSON.stringify(body) }),
  onSuccess: () => {
    toast.success("Movimentação criada");
    queryClient.invalidateQueries({ queryKey: ["replenishment"] });
  },
  onError: (e: any) => toast.error(e.message),
});
```

- [ ] **Step 3: Atualizar subtitle**

P6 commit `28d0502` mudou subtitle pra "primariamente consulta". Agora reverter pra "consulte e execute" ou similar.

- [ ] **Step 4: Smoke manual em staging**

- [ ] **Step 5: Commit**

```bash
git add src/app/wms/replenishment/page.tsx
git commit -m "feat(replenishment): botão criar mov por linha (fix-final-B T10 / #8.13)"
```

---

## Phase 10 — B9: Coluna `devolucao_id` em `siso_movimentacoes`

### Task 11: Migration + cenário 35

**Files:**
- Create: `supabase/migrations/20260528_movs_devolucao_id.sql`
- Create: `scripts/wms/cenarios/catalogo/35-desclassificar-via-devolucao-id.ts`
- Modify: `src/app/api/wms/devolucoes/[id]/classificar/route.ts`
- Modify: `src/app/api/wms/devolucoes/[id]/desclassificar/route.ts`
- Modify: `src/lib/wms/ledger.ts` (aceitar `devolucao_id` em InserirMovInput)

- [ ] **Step 1: Migration**

Create:

```sql
-- Fix-Final B T11: devolucao_id em movs B/C/D pra lookup determinístico
BEGIN;

ALTER TABLE siso_movimentacoes
  ADD COLUMN IF NOT EXISTS devolucao_id uuid NULL REFERENCES siso_devolucoes_pendentes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_siso_movimentacoes_devolucao_id ON siso_movimentacoes(devolucao_id) WHERE devolucao_id IS NOT NULL;

COMMIT;
```

Aplicar via MCP.

- [ ] **Step 2: Estender `inserirMovimentacao` pra aceitar `devolucao_id`**

Edit `src/lib/wms/ledger.ts` — adicionar campo opcional + passar pro RPC. Se RPC não aceita, criar nova versão `wms_inserir_movimentacao_v2` ou fazer UPDATE pós-insert na coluna nova.

Mais simples: após `inserirMovimentacao` retornar, se `input.devolucao_id` setado, dar UPDATE no row:
```ts
if (input.devolucao_id && mov.id) {
  await sb.from("siso_movimentacoes").update({ devolucao_id: input.devolucao_id }).eq("id", mov.id);
}
```

- [ ] **Step 3: Classificar passa `devolucao_id`**

Edit `src/app/api/wms/devolucoes/[id]/classificar/route.ts` — em cada chamada `inserirMovimentacao` (B/C/D), incluir `devolucao_id: devolucao.id`.

- [ ] **Step 4: Desclassificar usa `devolucao_id`**

Edit `desclassificar/route.ts` — substituir lookup heurístico por:
```ts
const { data: movsB } = await sb.from("siso_movimentacoes")
  .select("id")
  .eq("devolucao_id", params.id)
  .is("estorno_de", null);

for (const m of movsB ?? []) {
  await criarEstorno({ mov_id: m.id, motivo: "desclassificar_devolucao" });
}
```

- [ ] **Step 5: Cenário 35**

Create `scripts/wms/cenarios/catalogo/35-desclassificar-via-devolucao-id.ts`:
1. Devolução chega (webhook NF entrada).
2. Classificar como B → movs B criadas com `devolucao_id` populado.
3. Validar `siso_movimentacoes WHERE devolucao_id=X` retorna N rows.
4. Desclassificar → todas as movs B têm par E (estorno).
5. I1-I7 verde.

- [ ] **Step 6: Rodar suite — 35/35 PASS**

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260528_movs_devolucao_id.sql \
        src/lib/wms/ledger.ts \
        src/app/api/wms/devolucoes/[id]/classificar/route.ts \
        src/app/api/wms/devolucoes/[id]/desclassificar/route.ts \
        scripts/wms/cenarios/catalogo/35-desclassificar-via-devolucao-id.ts
git commit -m "feat(devolucoes): devolucao_id em movs + lookup determinístico (fix-final-B T11 / OoS P3 T43)"
```

---

## Phase 11 — B10: Desfazer guarda parcial com qty configurável

### Task 12: Cenário 34 + endpoint

**Files:**
- Create: `scripts/wms/cenarios/catalogo/34-desfazer-guarda-parcial-qty.ts`
- Modify: `src/app/api/wms/guarda/[id]/desfazer/route.ts`

- [ ] **Step 1: Cenário 34**

Sequência:
1. Receber 50 unidades em RECEBIMENTO → pendência aberta.
2. Guardar 30 unidades em loc destino (parcial: pendência fica com qty_guardada=30, qty_pendente=20).
3. `POST /api/wms/guarda/[id]/desfazer { qty: 10 }` (desfazer só 10 das 30 guardadas).
4. Asserts:
   - Mov par S+E (loc destino → RECEBIMENTO) com qty=10.
   - Pendência: qty_guardada=20, qty_pendente=30.
   - I1-I7 verde.

- [ ] **Step 2: Estender endpoint pra aceitar `{ qty }`**

Edit `src/app/api/wms/guarda/[id]/desfazer/route.ts`:

```ts
const Body = z.object({ qty: z.number().int().positive().optional() }).optional();
const parsed = Body.safeParse(await req.json().catch(() => ({})));
const qtyDesfazer = parsed.data?.qty ?? pendencia.qty_guardada; // default = tudo

if (qtyDesfazer > pendencia.qty_guardada) {
  return NextResponse.json({ error: `qty ${qtyDesfazer} > qty_guardada ${pendencia.qty_guardada}` }, { status: 400 });
}

// Par S+E loc destino → RECEBIMENTO com qty=qtyDesfazer
await inserirMovimentacao({ tipo: "S", localizacao_id: pendencia.localizacao_destino_id, qty: qtyDesfazer, origem_tipo: "transferencia_localizacao", ... });
await inserirMovimentacao({ tipo: "E", localizacao_id: locRecebimentoId, qty: qtyDesfazer, origem_tipo: "transferencia_localizacao", ... });

// Atualizar pendência
await sb.from("siso_wms_pendencias_guarda").update({
  qty_guardada: pendencia.qty_guardada - qtyDesfazer,
  status: pendencia.qty_guardada - qtyDesfazer === 0 ? "pendente" : "em_guarda",
}).eq("id", params.id);
```

- [ ] **Step 3: Rodar cenário + suite**

- [ ] **Step 4: Commit**

```bash
git add scripts/wms/cenarios/catalogo/34-desfazer-guarda-parcial-qty.ts \
        src/app/api/wms/guarda/[id]/desfazer/route.ts
git commit -m "feat(guarda): desfazer parcial com qty configurável (fix-final-B T12 / OoS P3 T35)"
```

---

## Phase 12 — B11: Coluna `tracking_origem_ids text[]`

### Task 13: Migration + popular array

**Files:**
- Create: `supabase/migrations/20260528_pendencias_tracking_origem_ids.sql`
- Modify: `src/lib/nf-webhook-handler.ts` (ou onde pendência é criada)
- Modify: `src/app/wms/guarda/[id]/page.tsx` (exibir lista)

- [ ] **Step 1: Migration**

```sql
BEGIN;
ALTER TABLE siso_wms_pendencias_guarda
  ADD COLUMN IF NOT EXISTS tracking_origem_ids text[] NULL;
COMMIT;
```

Aplicar via MCP.

- [ ] **Step 2: Backfill: copiar `tracking_origem_id` singular pro array**

```sql
UPDATE siso_wms_pendencias_guarda
SET tracking_origem_ids = ARRAY[tracking_origem_id]
WHERE tracking_origem_ids IS NULL AND tracking_origem_id IS NOT NULL;
```

- [ ] **Step 3: Webhook popula array (additive)**

Quando pendência é criada via webhook NF, popular tanto `tracking_origem_id` (compat) quanto `tracking_origem_ids` (novo).

```ts
const trackingIds = nf.tracking_ids ?? [nf.tracking_id].filter(Boolean);
await sb.from("siso_wms_pendencias_guarda").insert({
  ...,
  tracking_origem_id: trackingIds[0],
  tracking_origem_ids: trackingIds,
});
```

- [ ] **Step 4: UI exibe lista**

Edit `src/app/wms/guarda/[id]/page.tsx` — onde mostra `tracking_origem_id`, mostrar `tracking_origem_ids.join(", ")` se array tem >1.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260528_pendencias_tracking_origem_ids.sql \
        src/lib/nf-webhook-handler.ts \
        src/app/wms/guarda/[id]/page.tsx
git commit -m "feat(guarda): tracking_origem_ids text[] + UI lista (fix-final-B T13 / OoS P3 T53)"
```

---

## Phase 13 — Closure

### Task 14: `erros-conhecidos.yaml` (11 entradas)

**Files:**
- Modify: `erros-conhecidos.yaml`

- [ ] **Step 1: Adicionar 1 entrada por item B1-B11**

Mesmo formato do Fix-A T29. IDs `wms-fix-final-b-X.Y-titulo`.

- [ ] **Step 2: Commit**

```bash
git add erros-conhecidos.yaml
git commit -m "docs(errors): 11 entradas fix-final-B em erros-conhecidos (T14)"
```

---

### Task 15: Atualizar docs

**Files:**
- Modify: `docs/database-schema.md` (3 colunas novas + 1 RPC alterada)
- Modify: `docs/api-reference-complete.md` (endpoints existentes ganharam body novos)
- Modify: `CLAUDE.md` ("Recently Fixed: Fix-Final B")

- [ ] **Step 1: database-schema — documentar 3 colunas**

- `siso_movimentacoes.devolucao_id` (uuid FK)
- `siso_wms_pendencias_guarda.tracking_origem_ids` (text[])
- `wms_inventario_sugerir` RPC modificada (filtro quarentena)

- [ ] **Step 2: api-reference — atualizar body de `/desfazer` (qty opcional)**

- [ ] **Step 3: CLAUDE.md — bullet**

```markdown
- **Fix-Final B — Out-of-scope + tasks P6 órfãs (2026-05-28).** 11 itens P2 fechados: delete transferir-galpao órfão (P6 A.5), vendas-disponibilidade sem hardcoded (P6 B.3), cancelar limita movs_estornadas JSONB (P6 E.26), computarDivergencias guard (#4.13), quarentena fora da sugestão (#6.9), desfazer-parcial mensagem correta (#2.17), parcial-modal opção OC (#5.22), replenishment com botão criar mov (#8.13), devolucao_id em movs (OoS P3 T43), desfazer guarda qty parcial (OoS P3 T35), tracking_origem_ids array (OoS P3 T53). 3 migrations leves, 3 cenários novos (33-35). Plano: `docs/superpowers/plans/2026-05-27-wms-fix-final-B.md`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/database-schema.md docs/api-reference-complete.md CLAUDE.md
git commit -m "docs: atualiza schema + api + CLAUDE pro fix-final-B (T15)"
```

---

### Task 16: Verificação final + PR

- [ ] **Step 1: Suite**

```bash
npm run scenarios
```
Expected: **35/35 PASS** (32 Fix-A + 33/34/35 Fix-B).

- [ ] **Step 2: Smoke manual em staging**

1. Replenishment: criar mov via botão novo → ledger atualiza.
2. Devolução: classificar B → mov tem `devolucao_id` → desclassificar → estorno.
3. Guarda: desfazer parcial com qty → metade volta.
4. Parcial-modal: opção "encaminhar OC" → pedido vai pra compras.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin wms-fix-final-b
gh pr create --title "WMS Fix-Final B — Out-of-scope + tasks P6 órfãs (11 itens P2)" --body "$(cat <<'EOF'
## Summary
- Fecha 11 itens P2 residuais (3 tasks P6 sem commit + 2 OoS P3 finally + 3 OoS P5 UI + 3 colunas/RPCs deferidos).
- 3 migrations leves em staging: devolucao_id em movs, tracking_origem_ids em pendencias, wms_inventario_sugerir exclui quarentena.
- 3 cenários novos (33-35), suite 35/35 PASS.

## Spec + plano
- Spec: `docs/superpowers/specs/2026-05-27-wms-fix-final-design.md` §3
- Plano: `docs/superpowers/plans/2026-05-27-wms-fix-final-B.md`
- Pré-req: Fix-A merged

## Test plan
- [x] `npm run scenarios` → 35/35 PASS
- [x] Smoke: replenishment + desclassificar + desfazer parcial + parcial-modal OC

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Apêndice — checklist final

- [ ] 16 commits no PR
- [ ] `erros-conhecidos.yaml` ganhou 11 entradas
- [ ] 3 migrations aplicadas em staging (`ehbxpbeijofxtsbezwxd`), zero em prod
- [ ] Suite 35/35 PASS
- [ ] Cenários 33/34/35 commitados com I1-I7 verde
- [ ] `docs/database-schema.md` documenta 3 schema changes
- [ ] `CLAUDE.md` ganha bullet "Recently Fixed: Fix-Final B"
- [ ] PR aberto contra `develop`
