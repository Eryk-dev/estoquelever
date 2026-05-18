# Fix-pack — Realocação cascateável (auditoria pós-implementação)

**Data:** 2026-05-18
**Módulo:** WMS · Separação
**Status:** Aprovado pra implementação
**Antecedentes:**
- Spec original: [`2026-05-18-realocacao-cascateavel-design.md`](./2026-05-18-realocacao-cascateavel-design.md)
- Auditoria: [`2026-05-18-realocacao-cascateavel-fix-pack-audit.html`](./2026-05-18-realocacao-cascateavel-fix-pack-audit.html)

## Objetivo

Fechar os 24 achados da auditoria pra liberar a feature pra produção. O sumário executivo é: a feature está semanticamente correta no caminho feliz, mas a borda — concorrência, wave consolidado, fluxos adjacentes (encaminhar, reiniciar, voltar-etapa, compras-release, embalagem, produto-esgotado) — não foi atualizada quando os campos novos (`quantidade_pega`, `separacao_parcial`, `mov_saida_id`, `mov_ajuste_loc_zerou_id`, status `pendente_realocacao`, tabela `siso_pedido_item_realocacoes`) entraram. Resultado: drift de ledger silencioso, pedidos órfãos em wave consolidado, e estados travados sem caminho de saída.

Decisões estruturais já travadas com o usuário:
- **C3** (mov compartilhada por N itens em wave consolidado): **tabela ponte** `siso_pedido_item_mov_links`.
- **I6** (embalagem ignora qty pega real): **defesa em camadas** — UI avisa + RPC valida.
- **Escopo:** todos os 24 achados.

## Faseamento

| Fase | Conteúdo | Mergeable independente? |
|---|---|---|
| 1 — Schema & primitivas | Tabela ponte, RPCs, publication realtime, padronização de motivos | Sim |
| 2 — Backend semântico | Refator de parcial/cancelar/desfazer/marcar-realocacao + adjacentes (encaminhar, reiniciar, voltar-etapa, concluir-oc, compras-release, produto-esgotado) + auth + helper compartilhado | Depende da 1 |
| 3 — Frontend | C1 (regressão do array), I6 UI, M1, M2, M5, M7, M8 | Depende da 2 |
| 4 — Realtime client-side | Subscribe na publication + invalidação | Depende da 1 (publication) e 3 (hook) |

Se rollback for necessário depois da Fase 1, basta `DROP TABLE` + reverter as RPCs novas (tabela ainda não tem dados em produção). Fase 2 é o ponto de não-retorno semântico.

## Fase 1 — Schema & primitivas

### 1.1 Tabela `siso_pedido_item_mov_links`

```sql
CREATE TABLE siso_pedido_item_mov_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_item_id bigint NOT NULL REFERENCES siso_pedido_itens(id) ON DELETE CASCADE,
  realocacao_id uuid REFERENCES siso_pedido_item_realocacoes(id) ON DELETE CASCADE,
  mov_id uuid NOT NULL REFERENCES siso_movimentacoes(id),
  qty integer NOT NULL CHECK (qty > 0),
  tipo_link text NOT NULL CHECK (tipo_link IN ('saida','ajuste_loc_zerou')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pedido_item_id, realocacao_id, mov_id, tipo_link)
);

CREATE INDEX idx_mov_links_mov ON siso_pedido_item_mov_links(mov_id);
CREATE INDEX idx_mov_links_item ON siso_pedido_item_mov_links(pedido_item_id);
CREATE INDEX idx_mov_links_realoc ON siso_pedido_item_mov_links(realocacao_id) WHERE realocacao_id IS NOT NULL;
```

**Semântica:**
- `realocacao_id IS NULL`: link de mov gerada pelo item pai (modo item de `parcial`).
- `realocacao_id IS NOT NULL`: link de mov gerada por uma realoc (modo realoc de `parcial`, ou `marcar-realocacao`).
- Uma mov pode ter N links — wave consolidado: 1 mov S total, N links (1 por item afetado), `Σ links.qty = mov.quantidade`.
- `tipo_link` separa saída (`'saida'`) de ajuste loc_zerou (`'ajuste_loc_zerou'`).

**Invariante de coerência:** pra toda mov com `origem_tipo IN ('nf_venda','emprestimo','ajuste_pick_zerou')` gerada por `parcial`/`marcar-realocacao`/`marcar-item`, deve existir pelo menos um link em `siso_pedido_item_mov_links`. Reconciliação: query que detecta movs órfãs.

**Backfill:** sem migração de dados. Realocs/itens criados pré-fix continuam funcionando pelo path legacy (`mov_saida_id` / `mov_ajuste_loc_zerou_id` direto no `siso_pedido_itens` e `siso_pedido_item_realocacoes`). Código novo escreve em **ambos** durante grace period (tabela ponte + campos legacy), e lê **primeiro** da tabela ponte; se vazia, fallback ao legacy. Após 30 dias em produção, migration final remove os campos legacy.

### 1.2 RPC `wms_acumular_qty_pega`

```sql
CREATE OR REPLACE FUNCTION wms_acumular_qty_pega(p_item_id bigint, p_delta integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_nova integer;
BEGIN
  UPDATE siso_pedido_itens
    SET quantidade_pega = COALESCE(quantidade_pega, 0) + p_delta
    WHERE id = p_item_id
    RETURNING quantidade_pega INTO v_nova;
  IF v_nova IS NULL THEN
    RAISE EXCEPTION 'item % nao encontrado', p_item_id;
  END IF;
  IF v_nova < 0 THEN
    RAISE EXCEPTION 'quantidade_pega negativa: novo=% delta=%', v_nova, p_delta;
  END IF;
  RETURN v_nova;
END;
$$;
```

Atômico. UPDATE com retorno. Sem read-then-write no app.

### 1.3 RPC `wms_estornar_parcial_movimentacao`

Suporte a estorno parcial de uma mov (necessário pra `desfazer-parcial` em wave consolidado quando a mov é compartilhada por N items).

```sql
-- Pré-requisito: nova coluna em siso_movimentacoes pra contabilizar parcelas estornadas
ALTER TABLE siso_movimentacoes
  ADD COLUMN qty_estornada integer NOT NULL DEFAULT 0
  CHECK (qty_estornada >= 0);

-- RPC que gera mov de estorno com qty parcial
CREATE OR REPLACE FUNCTION wms_estornar_parcial_movimentacao(
  p_mov_id uuid,
  p_qty integer,
  p_usuario_id uuid,
  p_observacoes text
) RETURNS siso_movimentacoes LANGUAGE plpgsql AS $$
DECLARE
  v_original siso_movimentacoes;
  v_tipo_inverso char(1);
  v_estorno siso_movimentacoes;
BEGIN
  -- Lock pessimista no original
  SELECT * INTO v_original
    FROM siso_movimentacoes
    WHERE id = p_mov_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mov % nao encontrada', p_mov_id;
  END IF;
  IF v_original.estorno_de IS NOT NULL THEN
    RAISE EXCEPTION 'mov % e ela mesma um estorno', p_mov_id;
  END IF;
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'qty deve ser positiva: %', p_qty;
  END IF;
  IF v_original.qty_estornada + p_qty > v_original.quantidade THEN
    RAISE EXCEPTION 'estorno parcial excede saldo: ja_estornado=% + qty=% > total=%',
      v_original.qty_estornada, p_qty, v_original.quantidade;
  END IF;

  v_tipo_inverso := CASE v_original.tipo WHEN 'E' THEN 'S' WHEN 'S' THEN 'E'
                                          WHEN 'R' THEN 'L' WHEN 'L' THEN 'R' END;

  -- Insere via RPC normal (que tem lock em siso_estoque e atualiza cache)
  v_estorno := wms_inserir_movimentacao(
    v_original.produto_id, v_original.empresa_dona_id,
    v_original.galpao_id, v_original.localizacao_id,
    v_tipo_inverso, p_qty,
    'estorno', p_mov_id::text,
    jsonb_build_object('estorno_de', p_mov_id, 'parcial', true, 'mov_original_origem', v_original.origem_tipo),
    NULL, NULL, NULL, NULL,
    p_usuario_id, p_observacoes,
    p_mov_id
  );

  -- Atualiza contador no original
  UPDATE siso_movimentacoes
    SET qty_estornada = qty_estornada + p_qty
    WHERE id = p_mov_id;

  RETURN v_estorno;
END;
$$;
```

`estornarMovimentacao` (total) existente fica intacto, mas valida agora também `qty_estornada = 0` antes de aceitar (não pode estornar total se já houve parcial). Migration faz: `UPDATE siso_movimentacoes SET qty_estornada = quantidade WHERE estorno_de IS NULL AND EXISTS (SELECT 1 FROM siso_movimentacoes e WHERE e.estorno_de = siso_movimentacoes.id)` pra backfill.

### 1.4 RPC `siso_processar_bip_embalagem` — ampliação

Adicionar parâmetro `p_strict_qty_pega boolean DEFAULT false`. Quando `true` e `item.separacao_parcial=true`:

```sql
v_teto := COALESCE(item.quantidade_pega, 0) +
          (SELECT COALESCE(SUM(quantidade_pega), 0)
           FROM siso_pedido_item_realocacoes
           WHERE pedido_item_id = item.id
             AND status IN ('picado','picado_parcial'));
v_bipado_completo := (v_quantidade_bipada >= v_teto);
IF v_quantidade_bipada > v_teto THEN
  RAISE EXCEPTION 'bipou mais que pega real (% > %)', v_quantidade_bipada, v_teto;
END IF;
```

Quando `false` (default), mantém comportamento atual (teto = `quantidade_pedida`). Backward-compat preservada pra qualquer call-site legado.

### 1.5 Publication realtime

```sql
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='siso_pedido_item_realocacoes'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE siso_pedido_item_realocacoes';
  END IF;
END $$;
```

Idempotente. Habilita C5.

### 1.6 Padronização de `parcial_motivo` (M4)

Valores canônicos: `loc_zerou` | `qty_diferente`. Discriminação modo item vs realoc é feita por `parent_realocacao_id IS NOT NULL` (já existe). Backfill em movs/realocs antigas: `UPDATE siso_pedido_item_realocacoes SET parcial_motivo = CASE WHEN parcial_motivo IN ('cascade_loc_zerou','loc_zerou') THEN 'loc_zerou' WHEN parcial_motivo IN ('cascade_parcial','qty_diferente') THEN 'qty_diferente' ELSE parcial_motivo END WHERE parcial = true`.

## Fase 2 — Backend semântico

### 2.1 Helper compartilhado `resetarEstadoSeparacaoItens`

Novo módulo `src/lib/separacao/reset-state.ts`. Função:

```ts
async function resetarEstadoSeparacaoItens(opts: {
  supabase: SupabaseClient;
  itemIds: number[];
  usuarioId: string;
  motivo: 'encaminhar' | 'reiniciar' | 'voltar_etapa' | 'esgotado';
}): Promise<{ estornadas: string[]; realocsCanceladas: number }>
```

Comportamento:
1. Carrega `siso_pedido_itens` + suas realocs.
2. Pra cada item: estorna `mov_saida_id` (se existe e não estornada). **NÃO estorna `mov_ajuste_loc_zerou_id`** (mesma regra de `cancelar`).
3. Pra cada realoc com status `'picado' | 'picado_parcial'`: estorna seu `mov_saida_id`.
4. Cancela todas as realocs com status `'aguardando_picking'` desses items (UPDATE em batch).
5. Reseta no item: `separacao_marcado=false`, `separacao_marcado_em=null`, `quantidade_pega=null`, `separacao_parcial=false`, `parcial_motivo=null`, `parcial_em=null`, `parcial_por=null`, `mov_saida_id=null`, `mov_ajuste_loc_zerou_id=null`, `quantidade_bipada=0`, `bipado_completo=false`.
6. Apaga linhas de `siso_pedido_item_mov_links` desses items (links órfãos).
7. Registra evento `'separacao_resetada'` com `usuarioId` e `motivo`.

Consumidores: `encaminhar/route.ts`, `reiniciar/route.ts`, `voltar-etapa/route.ts` (caminho backward), `produto-esgotado/route.ts` (modo encaminhar).

### 2.2 C2 — `desfazer-parcial` não estorna `mov_ajuste_loc_zerou_id`

`src/app/api/wms/separacao/desfazer-parcial/route.ts`: remover linhas 82-88. Manter estorno só do `mov_saida_id`. Comentário explícito alinhado com `cancelar/route.ts:79-80`.

### 2.3 C3 — Tabela ponte em `parcial`/`marcar-realocacao`/`cancelar`/`desfazer-parcial`

**`parcial/route.ts` modo item:**
- Quando insere mov S (linha 247+) e mov ajuste (linha 290+): também insere N linhas em `siso_pedido_item_mov_links`, uma por item afetado, com `qty = qty_para_este` (distribuída por FCFS). `tipo_link = 'saida'` ou `'ajuste_loc_zerou'`.
- O campo legacy `mov_saida_id`/`mov_ajuste_loc_zerou_id` continua escrito em **todos** os itens afetados (não só no primeiro beneficiário) durante grace period — apontando pro mesmo `mov_id`. Isso já remove ambiguidade do C3 mesmo no caminho legacy.

**`parcial/route.ts` modo realoc:**
- Mesmo padrão, agora com `realocacao_id` populado nos links.

**`marcar-realocacao/route.ts`:**
- Após inserir mov S, criar link `(pedido_item_id, realocacao_id, mov_id, qty=realoc.quantidade, tipo_link='saida')`.

**`desfazer-parcial/route.ts`:**
- Lê todos os links da tabela ponte filtrando por `pedido_item_id` do item alvo (separa por `tipo_link`).
- Pra cada link de `tipo_link='saida'`:
  - Conta links irmãos da mesma `mov_id` (`SELECT COUNT(*) FROM siso_pedido_item_mov_links WHERE mov_id=$mov_id`).
  - Se count=1 (link único): chama `estornarMovimentacao(mov_id)` (total) e apaga o link.
  - Se count>1 (compartilhada): chama `wms_estornar_parcial_movimentacao(mov_id, link.qty, usuario_id, "Desfazer parcial — operador")` e apaga o link. Os outros links e seus items continuam intactos.
- Pra link de `tipo_link='ajuste_loc_zerou'`: **apaga o link mas NÃO estorna a mov** (regra de design — mov ajuste reflete descoberta física, fica permanente; cf. C2).
- Reset dos campos do item via RPC `wms_acumular_qty_pega(item_id, -delta)` onde delta é a soma de qty dos links de saída desfeitos.
- Realocs `aguardando_picking` órfãs (sem mov) do item são canceladas.
- Status do pedido volta a `em_separacao` se estava `pendente_realocacao`.

Comportamento resultante: desfazer no item 1 de um wave de 3 estorna **parcial** apenas a fatia do item 1; items 2 e 3 continuam com qty_pega intacta, mov original mantém os outros 2 links.

**`cancelar/route.ts`:**
- Lê links da ponte em vez de só `mov_saida_id`. Estorna cada mov **uma vez** (deduplicando por `mov_id`). Apaga os links após estornar.
- Mantém regra: não estorna `mov_ajuste_loc_zerou_id`.

### 2.4 C4 — Lock pessimista pós-mov com rollback se race

**Estratégia:** confirmação otimista com rollback explícito. A `wms_inserir_movimentacao` já tem `FOR UPDATE` em `siso_estoque`, então 2 chamadas concorrentes serializam ali. O risco real é o **segundo UPDATE de status** sobrescrever o do primeiro. Solução: UPDATE condicional com filtro de status; se afetar 0 linhas, **estornar a mov que acabamos de criar**.

**`parcial/route.ts:569-597` (modo realoc), padrão:**

```ts
// 1. Validação leitura (SELECT) — pode passar por race
// 2. Gera mov via wms_inserir_movimentacao (lock serializa em siso_estoque)
const mov = await inserirMovimentacao({ ..., observacoes: "..." });

// 3. Tenta atualizar status com CONDIÇÃO. Se 0 rows, perdemos a race.
const { data: claimed, error } = await supabase
  .from("siso_pedido_item_realocacoes")
  .update({
    status: isCompletoEsta ? "picado" : "picado_parcial",
    quantidade_pega: qty_para_esta,
    mov_saida_id: ehBeneficiario ? mov.id : null,
    parcial_em: ...,
    parcial_por: session.id,
  })
  .in("id", realocIds)
  .eq("status", "aguardando_picking")
  .select("id");

if (!claimed || claimed.length !== realocIds.length) {
  // Race detectada. Estorna a mov.
  await estornarMovimentacao({ mov_id: mov.id, usuario_id: session.id,
    observacoes: "Race condition — outro operador já picou" });
  return NextResponse.json(
    { error: "realocacao_ja_picada", message: "Outro operador picou primeiro" },
    { status: 409 });
}

// 4. Sucesso — segue criando links da ponte, registrando evento, cascade, etc.
```

A ordem é importante: insert mov → UPDATE condicional → se falhou, estorna. O ledger fica com 1 par S+E (mov + estorno) anulando-se quando há race, mas semanticamente correto. Não temos drift.

**`marcar-realocacao/route.ts:31-48`:** mesma pattern. Insere mov, tenta UPDATE com `.eq("status","aguardando_picking")`, estorna se 0 rows.

**Para o modo item de `parcial`:** mesma técnica em cima de `siso_pedido_itens`. UPDATE com `.eq("separacao_marcado", false).eq("separacao_parcial", false)`; se 0 rows, estorna mov e retorna 409.

### 2.5 I7 — DELETE cascade chain

`src/app/api/wms/separacao/realocacao/[id]/route.ts`:

1. SELECT recursivo via WITH RECURSIVE (ou loop iterativo no app) coletando toda a chain descendente de `parent_realocacao_id`.
2. Se qualquer descendente tem status `'picado'` ou `'picado_parcial'`: 409 com mensagem "chain tem realocs já picadas — use Cancelar separação".
3. Senão: UPDATE em batch cancelando toda a chain.
4. Evento `realocacao_cancelada_chain` com `usuarioId` e lista de IDs cancelados.

### 2.6 I8 — Cascade multi-empresa

`parcial/route.ts:884-922` (modo realoc) e `:413-438` (modo item):

Antes de chamar `resolverRealocacao`, agrupar `itemsResiduais` por `empresa_origem_id` (do pedido pai). Pra cada grupo: chamar resolver com a empresa correta + qty residual do grupo + exclusion list do grupo.

Resultado: lista combinada de realocações pra inserir, cada uma com `is_emprestimo`/`empresa_devedora_id` corretos pro seu grupo.

### 2.7 I9 — RPC pra acumular qty_pega

Substituir em:
- `parcial/route.ts:828-837` (modo realoc) e `:333-340` (modo item)
- `marcar-realocacao/route.ts:124-128`

Pelo call `supabase.rpc("wms_acumular_qty_pega", { p_item_id, p_delta })`.

### 2.8 I1 — `pendente_realocacao` aceito em endpoints adjacentes

Adicionar ao `STATUS_PERMITIDOS` (ou equivalente) de:

| Endpoint | Lógica adicional |
|---|---|
| `iniciar/route.ts` | Aceita status; quando inicia wave, retoma pedido (transita pra `em_separacao`) |
| `marcar-item/route.ts` | Aceita status; marca item normalmente; pedido fica em `pendente_realocacao` se ainda há itens residuais |
| `voltar-etapa/route.ts` | Inclui `pendente_realocacao` no `STATUS_ORDER` (entre `em_separacao` e `separado`) |
| `produto-esgotado/route.ts` | Inclui no `ACTIVE_STATUSES` |

### 2.9 I2 — `encaminhar` reseta estado + cancela realocs

`encaminhar/route.ts`:
1. Aceita `pendente_realocacao` no status.
2. Antes do switch de `separacao_galpao_id`, chama `resetarEstadoSeparacaoItens` (helper 2.1) com os items do pedido.
3. Estorno via WMS ledger (não mais via Tiny API legado, pra alinhar com a direção estratégica do CLAUDE.md).
4. Registra evento `pedido_encaminhado` com `usuarioId` e galpão destino.

### 2.10 I3 — `reiniciar` usa helper

`reiniciar/route.ts`: substitui o reset incompleto pelo `resetarEstadoSeparacaoItens`. Registra evento.

### 2.11 I4 — `concluir-oc` bloqueia realocs pendentes

Espelhar query de bloqueio de `concluir/route.ts:59-75` em `concluir-oc/route.ts`. Se há realocs aguardando_picking, retorna 409 com lista.

### 2.12 I5 — `compras-release` + worker honram `mov_saida_id` já feita

**`src/lib/compras-release.ts`:** ao montar payload de `siso_fila_execucao` (linhas 181-197), adicionar:

```ts
const itensJaLancados = items
  .filter((i) => i.mov_saida_id != null)
  .map((i) => i.id);

await supabase.from("siso_fila_execucao").insert({
  ...,
  payload: { ..., itens_ja_lancados: itensJaLancados }
});
```

**`src/lib/execution-worker.ts`:** ao processar job `lancar_estoque`, lê `payload.itens_ja_lancados` (default `[]`). No loop de items, `if (itens_ja_lancados.includes(item.id)) { continue; }` — pula dedução pra esses items. Também: pula a baixa no Tiny ERP legacy (`siso_pedido_item_estoques`) pra esses items, mantendo somente o lançamento que já foi feito via parcial/realoc.

Worker continua processando os items que NÃO foram pré-lançados (caminho normal). Evita double-deduction.

### 2.13 I10 — `produto-esgotado` modo OC usa residual

`produto-esgotado/route.ts:257`:

```ts
const realocsPicadas = await supabase
  .from("siso_pedido_item_realocacoes")
  .select("quantidade_pega")
  .eq("pedido_item_id", item.id)
  .in("status", ["picado","picado_parcial"]);

const qtyPegaTotal = (item.quantidade_pega ?? 0) +
                     (realocsPicadas.data ?? []).reduce((s, r) => s + (r.quantidade_pega ?? 0), 0);

const compra_quantidade_solicitada = Math.max(0, item.quantidade_pedida - qtyPegaTotal);
```

Se `qtyPegaTotal >= quantidade_pedida`, não cria linha de compra (não há residual).

### 2.14 I11 — Auth em endpoints destrutivos

Adicionar `getSessionUser` no início de:
- `concluir/route.ts`
- `reiniciar/route.ts`
- `produto-esgotado/route.ts`
- `checklist-items/route.ts` (read-only — pode ser opcional aqui; decisão: incluir por consistência)

Retorna 401 sem sessão. Eventos passam a ter `usuarioId`.

### 2.15 M3 — `registrarEvento` com `usuarioId`

`cancelar/route.ts`: adicionar `registrarEvento('separacao_cancelada', { usuarioId: session.id, ... })`. Em `concluir/route.ts`: propagar `usuarioId` nos `registrarEventos` (linhas 207-223).

### 2.16 M6 — `buildCompraFieldReset` estendido

`compras-utils.ts:7-24`: adicionar campos `quantidade_pega`, `separacao_parcial`, `parcial_motivo`, `parcial_em`, `parcial_por`, `mov_saida_id`, `mov_ajuste_loc_zerou_id` no reset. Adicionar (em call-sites de troca SKU equivalente) cancelamento de realocs do item via helper.

## Fase 3 — Frontend

### 3.1 C1 — Trocar `realocacao_id` por `realocacao_ids`

`src/app/wms/separacao/checklist/page.tsx:597`:

```diff
-  ? { realocacao_id: parcialModal.itemIds[0], quantidade_pega: qtyPega, loc_zerou: locZerou }
+  ? { realocacao_ids: parcialModal.itemIds, quantidade_pega: qtyPega, loc_zerou: locZerou }
```

Uma linha.

### 3.2 I6 UI — Banner qty pega real na embalagem

`src/app/wms/separacao/embalagem/page.tsx` (ou equivalente):

Quando renderiza item com `separacao_parcial=true`, computar:

```ts
const qtyPegaTotal = (item.quantidade_pega ?? 0) +
                     realocsPicadas.reduce((s, r) => s + (r.quantidade_pega ?? 0), 0);
```

Se `qtyPegaTotal < quantidade_pedida`:
- Banner amarelo no card do item: "Parcial — pega real X de Y. Bipar X unidades."
- Botão explícito "Fechar como parcial (X/Y)" que envia bipe de exatamente `qtyPegaTotal` via uma chamada agregada.
- Endpoint `bipar-embalagem` passa `p_strict_qty_pega=true` por padrão. RPC rejeita se operador tentar bipar mais (defesa em profundidade).

### 3.3 M1 — Remover useEffect que força `locZerou`

`src/components/wms/separacao/parcial-modal.tsx:35-39`: deletar o `useEffect`. Manter default `locZerou=false`. Operador decide.

### 3.4 M2 — Distinguir 409 `posicao_reservada`

`checklist/page.tsx:606-610` em `handleParcialConfirm` (e ponto análogo em `handleMarcarRealocacao`):

```ts
if (!res.ok) {
  if (res.status === 409 && data.error === "posicao_reservada") {
    toast.warning(`Outro operador pegou primeiro — atualizando…`, { duration: 4000 });
  } else if (res.status === 409 && data.error?.startsWith("realocação")) {
    toast.warning(data.error, { duration: 4000 });
  } else {
    toast.error(data.error ?? "Erro ao processar parcial");
  }
  // ...
}
```

### 3.5 M5 — `naturalLocCompare` no resolver

`src/lib/separacao/realocacao-resolver.ts:104`: importar `naturalLocCompare` de `src/app/wms/separacao/checklist/page.tsx:14` (ou mover pra um util compartilhado em `src/lib/wms/utils.ts`). Substituir o `localeCompare`.

### 3.6 M7 — Proteção double-click

`checklist/page.tsx`: adicionar flag local `submittingActionRef = useRef<boolean>(false)` em:
- `handleParcialConfirm` (linha 592)
- `handleMarcarRealocacao` (linha 641)
- `onToggle` do checkbox `ItemRow` (linha 1094)

Cada handler checa a ref no início; se `true`, retorna early; senão seta `true`, executa, e seta `false` no `finally`.

### 3.7 M8 — `compras-equivalencia` galpões dinâmicos

`src/lib/compras-equivalencia.ts:185-198`: trocar `estoqueCwb*`/`estoqueSp*` por `estoques: Record<string, { saldo: number; ... }>` chaveado por nome de galpão. Iterar sobre galpões ativos via query. Atualizar consumidores em `src/app/wms/compras/...` que esperam os campos antigos.

## Fase 4 — Realtime client-side

### 4.1 Hook estendido

Estender `src/hooks/use-realtime-separacao.ts` (ou criar `use-realtime-checklist.ts`) pra escutar:

- INSERT em `siso_pedido_item_realocacoes` WHERE `pedido_item_id IN (items_do_pedido_visivel)` → invalida query.
- UPDATE em `siso_pedido_item_realocacoes` WHERE id IN (realocs_visiveis) → invalida query.

Filtro client-side por `pedidoIds` da página atual pra não causar tempestade de eventos.

### 4.2 Consumo no checklist

`src/app/wms/separacao/checklist/page.tsx`: chamar o hook e passar `queryClient` + `pedidoIds`. Hook chama `queryClient.invalidateQueries({ queryKey: ["wms-sep-checklist", pedidoIds, modo] })` no evento.

## Testes

### Unitários

| Módulo | Cases novos |
|---|---|
| `resolverRealocacao` | (a) `localizacoes_excluir=[]` vazio; (b) ordenação com `naturalLocCompare`; (c) `is_emprestimo=true` em empresa diferente; (d) cobertura tudo-ou-nada |
| `resetarEstadoSeparacaoItens` | (a) item com mov simples; (b) item com mov compartilhada via links; (c) item com realocs picadas + aguardando; (d) idempotência (chamar 2x) |
| `desfazer-parcial` | (a) último link → estorna mov total; (b) link compartilhado → estorno parcial via RPC; (c) sem links (legacy path) → fallback via campo `mov_saida_id` direto |
| `wms_acumular_qty_pega` | (a) primeira chamada (null → delta); (b) acumulação; (c) qty negativa → erro |
| `wms_estornar_parcial_movimentacao` | (a) qty < total → estorno parcial inserido + qty_estornada atualizada; (b) qty == total restante → último estorno parcial; (c) qty > restante → erro; (d) mov já totalmente estornada → erro; (e) qty=0 ou negativa → erro |

### Integração

- **Wave consolidado 3 pedidos + parcial:** confirma que `siso_pedido_item_mov_links` tem 3 linhas pra mesma mov; soma `qty` = mov.quantidade.
- **Race 2 ops na mesma realoc:** chamadas simultâneas via Promise.all; verificar que só 1 sucesso, outro 409.
- **Cascade cross-empresa:** wave com pedidos de NetAir + NetParts; verificar que cada residual tem `is_emprestimo` correto.
- **Encaminhar pedido em `pendente_realocacao`:** verifica estorno de mov + cancelamento de realocs + switch de galpão.
- **`concluir-oc` com realoc pendente:** retorna 409 com lista de pedidos bloqueados.

### Manual / staging

Cenários A/B/C do `2026-05-18-realocacao-cascateavel-workflow.html` re-rodados end-to-end. Adicional: 2 operadores simultâneos no mesmo wave; pedido cross-empresa; embalagem de pedido parcial.

## Riscos

| Risco | Mitigação |
|---|---|
| Migration nova lock numa tabela viva | `siso_pedido_item_mov_links` é tabela nova — sem lock. Publication realtime é DDL idempotente. RPC `wms_acumular_qty_pega` é função nova. RPC `siso_processar_bip_embalagem` é alteração de função (CREATE OR REPLACE) — Postgres faz isso atomicamente. |
| Backward-compat com dados legacy | Código novo lê de mov_links **primeiro**, fallback ao campo legacy. Grace period de 30 dias. |
| Frontend antigo (cache do navegador) mandando `realocacao_id` singular | Backend continua aceitando ambos os formatos. C1 corrige forward; clientes antigos não quebram. |
| Concorrência via UPDATE...RETURNING não dispara erro elegante | Retorna 409 explícito com mensagem clara. Frontend M2 distingue. |
| Helper `resetarEstadoSeparacaoItens` chamado em estados invalidos | Helper é idempotente — checa estado antes de estornar. Chama `estornarMovimentacao` que já tem proteção contra double-estorno. |
| Mudança na RPC de embalagem quebra fluxo OC | Parâmetro novo `p_strict_qty_pega` é opcional com default `false`. Sem efeito em chamadas antigas. |

## Fora de escopo

- Refator do `siso_pedido_item_estoques` legado (Plano 6 cutover).
- Mudança no modelo de empréstimos (regras N×N).
- Cascade cross-galpão (continua via modal encaminhar).
- Integração com Tiny stock sync downstream (Plano 6).
- Remoção dos campos legacy (`mov_saida_id`/`mov_ajuste_loc_zerou_id` em `siso_pedido_itens`/`siso_pedido_item_realocacoes`) — só depois do grace period de 30 dias.

## Critério de aceitação

- [ ] Todas as 24 issues do audit fechadas (validadas por re-leitura do código pós-fix)
- [ ] Cenários A/B/C do workflow.html passam end-to-end em staging
- [ ] Race test 2 ops simultâneos: zero drift de estoque
- [ ] Pedido em `pendente_realocacao` consegue ser encaminhado/desfeito sem intervenção manual no DB
- [ ] Wave consolidado de 3 pedidos: parcial agrupado → 3 links na tabela ponte, soma de qty = mov.quantidade
- [ ] Realtime: op A marca realoc, op B vê na UI em ≤2s sem refresh manual
