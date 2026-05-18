# Picking Multi-Loc — Captura de Posição na Separação

**Data:** 2026-05-18
**Status:** Spec aprovado — pronto pra plano de implementação
**Relacionado:** [`2026-05-07-wms-design.md`](2026-05-07-wms-design.md) (spec geral do WMS), [`../plans/2026-05-22-wms-3-roteamento.md`](../plans/2026-05-22-wms-3-roteamento.md) (empréstimos N×N), [`../plans/2026-05-29-wms-4-inventario.md`](../plans/2026-05-29-wms-4-inventario.md) (anti-colisão por loc)

---

## 1. Problema

A tela de separação atual (`/separacao/checklist`) trata picking como uma ação binária por SKU: o operador clica num checkbox e o sistema assume `quantidade_bipada = quantidade_pedida`, debitando do total da empresa. Não há captura de **qual loc** o operador esvaziou nem **quanto** ele pegou de fato.

Isso era compatível com o modelo antigo (estoque agregado por empresa). Mas o ledger WMS (Plano 1+) é **4D — produto × empresa × galpão × localização** — e suporta o mesmo SKU em N locs do mesmo galpão (picking, overstock, recebimento, quarentena). Sem captura no pick, o ledger não consegue debitar da loc correta e divergências entre sistema e prateleira nunca convergem.

Inventário errado por loc é **norma**, não exceção, especialmente nos primeiros meses de operação multi-loc: o sistema diz "B-02-01 tem 5", operador vai lá e encontra 3. Hoje a única saída é o botão "Esgotado", que é macro (afeta TODOS os pedidos do SKU em separação ativa, encaminha pra outro galpão ou vira OC).

Falta o caso intermediário: **a loc específica zerou mas o SKU pode existir em outra loc** — capturar a qty real pega, ajustar o saldo da loc no ledger, e re-rotear o residual sem travar a operação.

## 2. Objetivo

Estender o checklist de separação pra capturar picking multi-loc **com mínimo atrito**:

1. Caso comum (95%): operador clica o checkbox como hoje, assume qty completa, gera mov normal de saída.
2. Caso de divergência: botão dedicado **Parcial** abre modal pra qty real + flag "loc zerou". Sistema:
   - Gera mov de saída pelo que foi pego.
   - Gera mov de ajuste pra zerar o residual na loc original.
   - Procura o saldo faltante no mesmo galpão (mesma empresa + outras empresas do grupo).
   - Re-injeta a qty residual como linha extra **no fim** da onda (sem reordenar geograficamente).
3. Cascade: se a busca só achar em outro galpão ou não achar em lugar nenhum, pedido sai da onda e volta pro painel SISO com status `pendente_realocacao` pra decisão humana (transferência, OC, etc.).

**Não está no escopo deste spec:**

- ❌ Mudar o comportamento atual do botão **Esgotado** (continua existindo, continua tratando o caso macro: SKU sem cobertura no galpão).
- ❌ Inferência automática de qual loc descontar quando o checkbox é marcado sem ambiguidade (assumimos: 1 SKU × 1 empresa × 1 galpão → 1 loc, hoje quase sempre `DEFAULT-PICKING`; quando houver múltiplas locs com saldo, o checkbox debita seguindo regra fixa — ver §6.2).
- ❌ Wave-picking otimizado por rota geográfica (manter ordenação atual: localizacao/sku/descricao).
- ❌ Voice-pick, pick-to-light, etiqueta combinada loc+SKU, e outras opções de hardware (avaliadas e descartadas — ver §10).
- ❌ Dashboards/alertas sobre frequência de ajustes (audit é só histórico padrão — decisão explícita).
- ❌ Aprovação de supervisor (PIN) pra ajustes acima de R$X (descartado por adicionar fricção sem benefício claro nessa fase).
- ❌ Mecanismo de "achei a mais" (qty pega > qty esperada). Bloqueado no input. Caso raro vai por inventário/ajuste manual.

## 3. Decisões de design (com rationale)

Brainstorm extenso foi feito antes deste spec. Decisões fechadas:

| Decisão | Escolhido | Rejeitado | Por quê |
|---|---|---|---|
| Trigger do modal | Botão **Parcial** no card (exceção explícita) | Modal sempre ao clicar checkbox | Caso comum não pode pagar atrito por exceção |
| Fim do item normal | Checkbox = qty completa (zero atrito, igual hoje) | Bipe da última unidade auto-completa | Operador não bipa hoje na separação — usa checklist |
| Escopo da re-busca | Mesmo galpão: empresa atual → outras empresas do grupo (mov de empréstimo) | Cross-galpão inline | Cross-galpão exige transferência física — não dá pra resolver na mesma onda |
| Cascade quando não acha no mesmo galpão | Volta pro painel SISO com status `pendente_realocacao`, supervisor decide | OC automático | Decisão humana é mais segura no curto prazo; podemos automatizar depois com base no padrão observado |
| Ordenação da linha re-alocada | Append no FIM da onda (badge "Realocada") | Re-ordenar respeitando a ordem geográfica atual | Reordenar inseria a linha "pra trás" da posição física do operador, com risco dele perder e passar batido |
| Qty maior que esperada | Bloqueado no input (range `[0, qty_pedida]`) | Aceitar com mov de ajuste positivo | Cliente pediu N, pegar N+1 não faz sentido pro fluxo de venda; casos raros vão por ajuste manual |
| Audit / observabilidade | Só histórico padrão (`siso_pedido_historico`) + ledger | Dashboard, alertas, aprovação | Volume baixo, dor não validada, evita over-engineering |
| Estado do item original após Parcial | Permanece na lista marcado "Parcial: 3 de 5", badge visual | Sumir e ser substituído pela nova linha | Auditável visualmente, operador entende histórico da onda |

## 4. UX no checklist

### 4.1 Card de item (estado normal)

Layout atual mantém-se. Adiciona-se um botão **Parcial** entre o número da qty esperada e o botão **Esgotado** existente.

```
☐  📦  SKU-XX-31         Produto sintético XX-31 [SWAP]              3      [Parcial]  [Esgotado]
       B-02-01 · saldo 5
```

Botão `Parcial`:
- Cor amarela/laranja (`bg-amber-500/10 text-amber-700 border-amber-500/20`)
- Mesmo estilo visual de `Esgotado` (existente) — discreto, não compete com checkbox.
- `disabled` se item já foi marcado (checkbox) ou já tem realocação ativa.

### 4.2 Modal "Parcial"

Click no botão → modal compacto centralizado:

```
┌──────────────────────────────────────────────────┐
│  SKU-XX-31 — B-02-01                              │
│  Quantas unidades você conseguiu pegar?           │
│                                                    │
│  ┌─────────────────────────────────┐              │
│  │  [- ]    3    [ +]   /  de 5    │              │
│  └─────────────────────────────────┘              │
│                                                    │
│  ☑ Esta loc zerou (não tem mais)                  │
│     ↑ pré-marcado se qty < esperada               │
│                                                    │
│              [Cancelar]   [Confirmar]              │
└──────────────────────────────────────────────────┘
```

Regras do input:
- Default: qty esperada (mas operador tem que confirmar diminuição).
- Range: `[0, qty_pedida]`. Stepper +/- e digitação direta.
- Se qty == esperada, exibir aviso: "Se você pegou tudo, use o checkbox normal." (mas ainda permitir submit — pode haver caso edge de "peguei tudo mas loc continua com algo a mais que precisa ser ajustado").
- Se qty == 0, label do checkbox vira "Esta loc estava vazia".

Após submit:
- Toast loading: "Procurando outras posições..."
- Resultado:
  - Achou no mesmo galpão (mesma empresa) → "Achei 2 em A-01-02 — adicionado ao fim da lista" (toast verde, 4s).
  - Achou em outra empresa do grupo → "Achei 2 em A-01-02 (NetParts, empréstimo) — adicionado ao fim da lista" (toast cyan, 4s).
  - Só achou em outro galpão → "Sem cobertura neste galpão — pedido voltou pro painel SISO" (toast âmbar, 6s). Item some da lista da onda.
  - Não achou em galpão nenhum → "Sem estoque em galpão nenhum — pedido voltou pro painel SISO" (toast vermelho, 6s). Item some da lista.

### 4.3 Estado pós-Parcial

Card do item original:
```
✓  📦  SKU-XX-31  [Parcial]          Pegou 3 de 5             3      [—]  [—]
       B-02-01 · loc zerada às 14:32                                 (botões desativados)
```

Linha re-alocada (aparece no FIM da lista):
```
☐  📦  SKU-XX-31  [Realocada]                                  2      [Parcial]  [Esgotado]
       A-01-02 · saldo 2 · originada de B-02-01
```

Counter no header da onda atualiza: "3 itens · 1/3 produto(s) marcado(s) · 1 realocação pendente".

### 4.4 Comportamento do botão Esgotado (inalterado)

O botão **Esgotado** continua como hoje:
- Caso macro: SKU não tem em galpão nenhum, afeta TODOS os pedidos com esse SKU em separação ativa.
- Abre modal com galpões alternativos + ações [Encaminhar todos] [Vira OC].
- Não passa por re-busca por loc — vai direto pro fluxo de re-roteamento de pedido inteiro.

Diferença mental:
- **Parcial** = micro (essa loc, esse pedido, esse momento).
- **Esgotado** = macro (esse SKU, todos os pedidos, agora).

## 5. Data model

### 5.1 Novo `origem_tipo` no ledger

```sql
-- Migração: 20260518_pick_zerou_ajuste.sql

ALTER TABLE siso_movimentacoes
  DROP CONSTRAINT siso_movimentacoes_origem_tipo_check;

ALTER TABLE siso_movimentacoes
  ADD CONSTRAINT siso_movimentacoes_origem_tipo_check
  CHECK (origem_tipo IN (
    'compra_manual','lancamento_retroativo','nf_venda','nf_devolucao_cliente',
    'nf_devolucao_avariada','nf_devolucao_fornecedor','transferencia_galpao',
    'transferencia_localizacao','emprestimo','reserva_pedido','liberacao_reserva',
    'troca_sku_in','troca_sku_out','ajuste_manual','inventario','inventario_inicial',
    'estorno','cancelamento_nf',
    'ajuste_pick_zerou'  -- NOVO
  ));
```

### 5.2 Nova tabela `siso_pedido_item_realocacoes`

```sql
CREATE TABLE siso_pedido_item_realocacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_item_id uuid NOT NULL REFERENCES siso_pedido_itens(id) ON DELETE CASCADE,

  -- Onde encontrar o residual
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  quantidade integer NOT NULL CHECK (quantidade > 0),

  -- Se é empréstimo (empresa_dona_id ≠ empresa_origem do pedido)
  is_emprestimo boolean NOT NULL DEFAULT false,
  empresa_devedora_id uuid REFERENCES siso_empresas(id),
  CHECK (
    (is_emprestimo = true AND empresa_devedora_id IS NOT NULL)
    OR (is_emprestimo = false AND empresa_devedora_id IS NULL)
  ),

  -- Workflow
  status text NOT NULL DEFAULT 'aguardando_picking'
    CHECK (status IN ('aguardando_picking','picado','cancelado')),
  motivo text NOT NULL DEFAULT 'loc_zerou',

  -- Audit
  criado_em timestamptz NOT NULL DEFAULT now(),
  criado_por uuid REFERENCES siso_usuarios(id),
  picado_em timestamptz,
  picado_por uuid REFERENCES siso_usuarios(id),
  mov_saida_id uuid REFERENCES siso_movimentacoes(id)
);

CREATE INDEX idx_realoc_pedido_item ON siso_pedido_item_realocacoes(pedido_item_id);
CREATE INDEX idx_realoc_status_aguardando
  ON siso_pedido_item_realocacoes(pedido_item_id, status)
  WHERE status = 'aguardando_picking';
```

**Nota sobre escolha de tabela separada (vs. nova linha em `siso_pedido_itens`):** `siso_pedido_itens` tem `UNIQUE (pedido_id, produto_id)`. Adicionar linha do mesmo produto quebraria. Mover pra tabela própria mantém o invariante e isola o conceito.

### 5.3 Novas colunas em `siso_pedido_itens`

```sql
ALTER TABLE siso_pedido_itens
  ADD COLUMN quantidade_pega integer,         -- qty real pega na loc original (NULL = não tocado; igual quantidade_pedida = caso normal via checkbox)
  ADD COLUMN separacao_parcial boolean NOT NULL DEFAULT false,
  ADD COLUMN parcial_motivo text,             -- 'loc_zerou' | NULL (extensível pra futuras razões)
  ADD COLUMN parcial_em timestamptz,
  ADD COLUMN parcial_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN mov_saida_id uuid REFERENCES siso_movimentacoes(id),         -- mov da saída principal (checkbox normal OU mov 1 do Parcial)
  ADD COLUMN mov_ajuste_loc_zerou_id uuid REFERENCES siso_movimentacoes(id); -- mov 2 do Parcial (ajuste ajuste_pick_zerou)
```

**Estado de "item completo":** um item é considerado totalmente picado quando `separacao_marcado=true` E (`separacao_parcial=false` OU `sum(realocacoes.quantidade WHERE status='picado') = quantidade_pedida - quantidade_pega`). Pra UI, o item aparece riscado/concluído quando essa condição é satisfeita.

### 5.4 Novo status em `siso_pedidos.status_separacao`

```sql
-- Adicionar ao CHECK do status_separacao:
'pendente_realocacao'  -- saiu de em_separacao pq re-busca falhou; aguarda supervisor
```

Pedido com esse status aparece no painel SISO existente (`/siso` aba "Pendente") com badge **"Realocação"** e exibe na expansão:
- O item que disparou (SKU + qty residual faltante).
- Onde o sistema procurou (galpão atual, empresas do grupo).
- Se há saldo em outro galpão (pra decisão de transferência) ou não (decisão de OC).

## 6. API

### 6.1 `POST /api/separacao/parcial`

**Body:**
```typescript
{
  pedido_item_id: string;       // uuid
  quantidade_pega: number;      // 0 .. quantidade_pedida
  loc_zerou: boolean;           // true → gera ajuste no ledger pra zerar o residual
}
```

**Headers:** `X-Session-Id`. Operador deve ter `galpaoId` (admin não pode).

**Lógica (transação única):**

1. Carrega `siso_pedido_itens` + pedido + empresa_origem + loc original via `siso_pedido_item_estoques`. Valida:
   - Item existe, pedido em `em_separacao`, item ainda não marcado/parcial.
   - `quantidade_pega` no range `[0, quantidade_pedida]`.
2. Calcula saldo atual da loc original em `siso_estoque` (`saldo_sistema`).
3. Gera mov 1 (saída) se `quantidade_pega > 0`:
   - `wms_inserir_movimentacao(p_tipo='S', p_quantidade=quantidade_pega, p_origem_tipo='nf_venda', p_origem_id='pedido:{pedido_id}', p_observacoes='Picking parcial pedido #X')`.
4. Gera mov 2 (ajuste) se `loc_zerou = true`:
   - Delta = `saldo_sistema - quantidade_pega`. Se delta > 0:
   - `wms_inserir_movimentacao(p_tipo='S', p_quantidade=delta, p_origem_tipo='ajuste_pick_zerou', p_origem_id='pedido:{pedido_id}', p_observacoes='Loc zerou no picking — ajuste {delta} unidades')`.
   - Se delta == 0, não gera mov (sistema e real já bateram).
5. Update `siso_pedido_itens`: `quantidade_pega`, `separacao_parcial=true`, `parcial_motivo='loc_zerou'`, `parcial_em`, `parcial_por`, `separacao_marcado=true`, `separacao_marcado_em`.
6. Registra evento histórico `parcial_loc_zerou` com detalhes JSON `{quantidade_pega, quantidade_pedida, loc_original, delta_ajuste}`.
7. **Re-busca residual** (`qty_residual = quantidade_pedida - quantidade_pega`). Só se `qty_residual > 0`:
   - Resolve grupo da empresa origem do pedido (via `grupo-resolver.ts`).
   - Lista empresas do grupo no mesmo galpão (ie. todas que compartilham `galpao_id` da empresa origem).
   - Query em `siso_estoque` filtrada por `produto_id`, `empresa_dona_id IN (empresas_do_grupo_mesmo_galpao)`, `galpao_id = galpao_origem`, `localizacao_id != loc_original`, `disponivel > 0`.
   - **Ordem de prioridade** (tie-breaking em cascata):
     1. Mesma empresa do pedido (evita empréstimo desnecessário).
     2. Dentro da empresa, prioriza por `localizacoes.tipo`: `picking` > `overstock` > `recebimento` > `quarentena`.
     3. Maior `disponivel` primeiro (consolida em menos locs).
     4. `localizacao.codigo` ASC (determinístico).
   - **Se achou**:
     - Cria row em `siso_pedido_item_realocacoes` com loc nova, `quantidade = min(qty_residual, saldo_loc_nova)`, `is_emprestimo` se empresa diferente, `empresa_devedora_id` = empresa origem do pedido (se empréstimo).
     - Se uma loc só não cobre todo o residual, repete pra próximas locs (múltiplas realocações pra mesmo item são permitidas).
     - Retorna `{ status: 'realocado', realocacoes: [...] }`.
   - **Se não achou no mesmo galpão**:
     - Update pedido: `status_separacao = 'pendente_realocacao'`.
     - Registra histórico `realocacao_sem_cobertura_galpao`.
     - Retorna `{ status: 'aguardando_supervisor', motivo: 'apenas_cross_galpao' | 'sem_cobertura_total' }`.

**Resposta sucesso:**
```typescript
{
  status: 'completo' | 'realocado' | 'aguardando_supervisor';
  realocacoes?: Array<{
    id: string;
    localizacao: string;
    empresa: string;
    quantidade: number;
    is_emprestimo: boolean;
  }>;
  motivo?: 'apenas_cross_galpao' | 'sem_cobertura_total';
}
```

### 6.2 Comportamento do checkbox normal (`/api/separacao/marcar-item`) — atualização

Hoje o endpoint só toggle `separacao_marcado boolean`. Precisa ser estendido pra gerar a mov de saída no ledger:

- Quando `marcado = true`:
  - Verifica que `siso_pedido_itens.separacao_parcial = false` (se for true, refuse — operador deve usar /parcial).
  - Gera mov de saída na loc indicada (`siso_pedido_item_estoques.localizacao` resolvido pra `localizacao_id`).
  - Origem `nf_venda` (ou `emprestimo` se a loc é de outra empresa do grupo — mas isso vai ser raro porque o roteamento inicial sempre alocava na empresa origem).
  - Atualiza `quantidade_pega = quantidade_pedida` no `pedido_itens`.
- Quando `marcado = false` (desfazer):
  - Estorna a mov via `wms_inserir_movimentacao(... estorno_de = mov_anterior_id ...)`.
  - Reset `quantidade_pega = null`.

**Regra de qual loc descontar quando o item tem múltiplas locs com saldo na mesma empresa+galpão:** debita da loc indicada em `siso_pedido_item_estoques.localizacao` (calculada na entrada do webhook, hoje uma só por empresa). Se essa coluna for migrada futuramente pra suportar múltiplas, este endpoint precisa de upgrade — fora do escopo deste spec.

### 6.3 `POST /api/separacao/marcar-realocacao`

**Body:**
```typescript
{
  realocacao_id: string;
}
```

**Lógica:**
1. Carrega `siso_pedido_item_realocacoes` + pedido_item + pedido. Valida status `aguardando_picking`.
2. Gera mov de saída:
   - Se `is_emprestimo = false`: `origem_tipo='nf_venda'`, sem `emprestimo_devedora_id`.
   - Se `is_emprestimo = true`: `origem_tipo='emprestimo'`, `emprestimo_devedora_id = empresa_devedora_id` da realocação.
   - Observação: "Picking pedido #X — realocação de [loc original]".
3. Update realocação: `status='picado'`, `picado_em`, `picado_por`, `mov_saida_id`.
4. Atualiza `siso_pedido_itens.quantidade_pega` somando o `quantidade` da realocação. Quando soma == quantidade_pedida, considera item totalmente coberto.
5. Histórico evento `realocacao_picada`.

### 6.4 `DELETE /api/separacao/realocacao/[id]` (cancelar)

Caso operador queira reverter uma realocação antes de pegar (ex.: descobriu que aquela loc também tá vazia):
- Só permite se `status='aguardando_picking'`.
- Update status='cancelado'.
- **Não** gera estorno automático no ledger (não houve mov ainda). Caso operador queira marcar a nova loc também como zerada, abre Parcial nela quando aparecer.

### 6.5 `POST /api/separacao/desfazer-parcial`

Cancela um Parcial antes de qualquer realocação ser picada:
- Estorna mov 1 e mov 2 do Parcial original.
- Cancela todas as realocações `aguardando_picking` desse item.
- Reset campos `quantidade_pega`, `separacao_parcial`, etc.
- Item volta ao estado inicial; pode ser marcado checkbox normal de novo.

## 7. Fluxo no ledger (exemplo concreto)

**Setup:**
- Pedido #1234 pede 5 de SKU-XX-31. Empresa origem: NetAir (CWB).
- Sistema (cache `siso_estoque`):
  - `(SKU-XX-31, NetAir, CWB, B-02-01) saldo=5`
  - `(SKU-XX-31, NetAir, CWB, A-01-02) saldo=2`
  - `(SKU-XX-31, NetParts, CWB, A-04-07) saldo=3`

**Cenário 1: operador vai em B-02-01, encontra 3, marca Parcial+loc zerou.**

| # | tipo | qty | empresa | loc | origem_tipo | observações |
|---|---|---|---|---|---|---|
| 1 | S | 3 | NetAir | B-02-01 | nf_venda | Picking parcial pedido #1234 |
| 2 | S | 2 | NetAir | B-02-01 | ajuste_pick_zerou | Loc zerou no picking — ajuste 2 unidades |

Após mov 1+2: cache `(SKU-XX-31, NetAir, CWB, B-02-01) saldo=0`.

Re-busca: prioridade mesma empresa → acha 2 em A-01-02 (NetAir). Cria realocação `{loc=A-01-02, empresa=NetAir, qty=2, is_emprestimo=false}`.

Quando operador marca a realocação:
| # | tipo | qty | empresa | loc | origem_tipo | observações |
|---|---|---|---|---|---|---|
| 3 | S | 2 | NetAir | A-01-02 | nf_venda | Picking pedido #1234 (realocação de B-02-01) |

**Cenário 2: re-busca não acha em NetAir, mas acha 2 em A-04-07 (NetParts) no mesmo galpão.**

(Movs 1+2 idênticos ao cenário 1.)

Re-busca: NetAir não tem; vai pra outras empresas do grupo no mesmo galpão → NetParts A-04-07 (saldo 3, precisa 2). Cria realocação `{loc=A-04-07, empresa=NetParts, qty=2, is_emprestimo=true, empresa_devedora=NetAir}`.

Quando picada:
| # | tipo | qty | empresa | loc | origem_tipo | emprestimo_devedora | observações |
|---|---|---|---|---|---|---|---|
| 3 | S | 2 | NetParts | A-04-07 | emprestimo | NetAir | Picking pedido #1234 — empréstimo NetParts→NetAir |

`siso_emprestimo_regras` deve permitir (NetParts credora, NetAir devedora). Saldo devedor reflete em `wms_saldos_devedores()`.

**Cenário 3: B-02-01 estava vazia (saldo real = 0), operador marca Parcial com qty=0.**

| # | tipo | qty | empresa | loc | origem_tipo | observações |
|---|---|---|---|---|---|---|
| — | (sem mov 1) | | | | | |
| 1 | S | 5 | NetAir | B-02-01 | ajuste_pick_zerou | Loc estava vazia (sistema dizia 5) — ajuste total |

Re-busca segue normal.

**Cenário 4: re-busca não acha em galpão nenhum.**

(Mov 1+2 idênticos.) Pedido vai pra `status_separacao = pendente_realocacao`. Supervisor decide no painel /siso. Linha some da onda do operador.

## 8. Edge cases

- **Realocação encontrada também zerou.** Operador vai na A-01-02 da realocação, encontra 0. Clica Parcial nela mesma → mesmo fluxo, recursivo. Mov de ajuste em A-01-02, nova re-busca.
- **Re-busca encontra saldo em múltiplas locs (fragmentado).** Operador clica Parcial em B-02-01 (3 de 5), residual = 2. A-01-02 tem 1 e A-03-05 tem 1. Cria 2 realocações. Ambas aparecem no fim da lista.
- **Operador concluiu Parcial, foi pra outra linha, depois mudou de ideia.** `POST /api/separacao/desfazer-parcial` reverte. Só funciona se nenhuma realocação foi picada ainda. Se já foi, exige cancelamento manual via supervisor (fora do escopo deste spec — não é caso comum esperado).
- **Pedido com múltiplos itens, um vira Parcial+sem-cobertura → muda status_separacao.** Os outros itens já picados ficam picados (movs no ledger). Quando supervisor resolve no painel (transferência ou OC), pedido pode voltar pra `em_separacao` (se transferência local resolveu) ou seguir pra `aguardando_compra` (se OC). O ledger é fonte da verdade pro que já foi pego.
- **Dois operadores tentam fazer Parcial no mesmo item simultaneamente.** Travado pela atomicidade do `wms_inserir_movimentacao` (lock pessimista em `siso_estoque`). O segundo recebe erro de saldo inconsistente e a UI mostra mensagem clara.
- **Operador cancela onda (`/api/separacao/cancelar`) com Parcial pendente.** Lógica de cancelamento existente já reseta `separacao_marcado` etc. Precisa estender pra também:
  - Estornar movs `nf_venda` geradas no Parcial (mas NÃO estornar `ajuste_pick_zerou` — o ajuste é descoberta física, vale independentemente).
  - Cancelar realocações pendentes.
- **Loc cujo saldo era "errado pra mais" (operador encontrou MAIS do que sistema dizia).** Bloqueado no input (qty max = qty esperada). Caso real raríssimo — operador segue picking normal pelo checkbox, o excedente físico fica "fantasma" na loc até inventário corrigir.

## 9. Testing

### 9.1 Unit tests (db functions)

- `wms_inserir_movimentacao` com origem_tipo `ajuste_pick_zerou` aceita corretamente.
- CHECK constraint em `siso_pedido_item_realocacoes` (is_emprestimo + empresa_devedora_id coerência).
- Status `pendente_realocacao` aceito em `siso_pedidos.status_separacao`.

### 9.2 Integration tests (API)

- `POST /parcial` com `qty=3, esperada=5, loc_zerou=true`, achando residual em outra loc da mesma empresa: 2 movs + 1 realocação criados.
- Mesmo fluxo achando em outra empresa do grupo: mov de saída + flag `is_emprestimo` + 1 realocação.
- Não achando em lugar nenhum: pedido vai pra `pendente_realocacao`, movs de ajuste persistem.
- Re-busca cobrindo qty residual via múltiplas locs (fragmentado).
- Concorrência: 2 operadores fazendo Parcial no mesmo item → segundo recebe erro.
- `POST /marcar-realocacao` gera mov correta, `is_emprestimo` reflete em saldo devedor.
- `POST /desfazer-parcial` estorna corretamente, realocações são canceladas.
- `marcar-item` (checkbox normal) gera mov de saída na loc indicada — não só toggle.

### 9.3 E2E manual no staging

Validar com seed de produtos multi-loc:
1. Criar pedido com SKU em 2 locs (B-02-01 saldo 5, A-01-02 saldo 2).
2. Iniciar separação → checklist mostra B-02-01.
3. Clicar Parcial, qty=3, loc zerou.
4. Verificar: toast "Achei 2 em A-01-02", linha original mostra "Parcial 3/5", nova linha no fim da lista com loc A-01-02 qty=2.
5. Marcar nova linha → checkbox normal → pedido fica `separado`.
6. Conferir ledger: 3 movs (saída B 3, ajuste B 2, saída A 2). Cache zerado em B, A diminuído pra 0.

## 10. Alternativas avaliadas (e descartadas)

Brainstorm completo gerou 19 opções, agrupadas por nível de atrito e custo. As descartadas:

- **Inferência por regra fixa sem captura** (FIFO/FEFO/maior saldo): ledger silenciosamente errado quando inventário diverge. Inviabiliza qualquer reconciliação confiável.
- **Picking única por SKU + replenishment**: exige disciplina operacional pesada (1 SKU = 1 loc) que a operação atual não tem.
- **Reserva antecipada na entrada da onda**: reusa infra do Plano 3, mas complexidade de UX alta pra ganho marginal; depende de inventário acurado (problema principal não resolvido).
- **Pergunta de loc só em ambiguidade (multi-loc detectada)**: o caso é raro hoje porque `siso_pedido_item_estoques.localizacao` é singular. Quando virar plural, reabriremos.
- **Directed picking / "siga-me"**: mudança grande de UX, precisa de rota otimizada. Adia.
- **Voice-pick, pick-to-light, etiqueta loc+SKU**: hardware caro, ROI não justificado no volume atual (~500 pedidos/dia).
- **Reconciliação batch via inventário** (ledger não captura loc no pick): perde toda observabilidade por loc.
- **Aprovação supervisor (PIN) acima de R$X**: adiciona fricção sem dor validada.

Detalhes do brainstorm em transcrição da sessão (não comitada — preservado no histórico de chat).

## 11. Riscos e mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Operador esquece de usar Parcial e marca checkbox com qty divergente | Médio | Ledger divergir silenciosamente | Treinamento + UI clara. Em fase 1, opcionalmente trocar checkbox padrão por "Confirma 5/5?" só pra itens com saldo no limite (qty_pedida == saldo_loc). Decisão fora do escopo. |
| Re-busca encontrar loc com saldo desatualizado (cascade infinito de Parciais) | Baixo | Operação trava em loop | Limite implícito: a cada Parcial, sistema só busca em locs ≠ das já tentadas no pedido. Audit via histórico permite ver loops. |
| Empréstimo entre empresas saldo devedor acumula | Médio | Distorção financeira | Já mitigado pelo Plano 3 (`siso_emprestimo_regras` + `wms_saldos_devedores`). Saldo aparece no painel de empréstimos. |
| Status `pendente_realocacao` se acumula no painel | Baixo (depende da acuracidade do inventário) | Backlog de supervisor | Métricas via consulta ao status. Se virar problema, automatizar OC após N tentativas (futuro). |
| Mov de saída no checkbox normal não existe hoje — adicionar pode quebrar fluxos a jusante | Médio | Regressão em `execution-worker.ts` ou `agrupamento-service.ts` | Verificar quem hoje "deduz estoque" (provavelmente `execution-worker.ts` faz isso direto no Tiny, sem ledger). Pra essa migração: ledger e Tiny são fontes paralelas (WMS Plano 6/cutover ainda não rodou). Mov de saída no ledger não afeta Tiny — só o cache WMS. Verificar em §12. |

## 12. Integração com fluxo de estoque atual

Hoje a dedução de estoque acontece em duas camadas, em paralelo:

- **`execution-worker.ts`** chama `siso_pedido_itens` e atualiza Tiny via API (canonical).
- **Ledger WMS** (`siso_movimentacoes` + `siso_estoque`) é a fonte da verdade interna do SISO/WMS.

Atualmente o `execution-worker` NÃO gera mov no ledger no momento do pick — ele só deduz no Tiny. Esse spec **adiciona** geração de mov ao fluxo de checkbox + Parcial, sem mexer no caminho do Tiny.

**Resultado**: durante a transição (até o cutover do Plano 6), o ledger reflete o picking físico e o Tiny reflete o pedido contabilizado. Divergências pontuais entre ledger e Tiny são esperadas e reconciliadas pelo Plano 6 (cutover big bang).

Decisão: este spec **não** mexe em `execution-worker.ts` nem na deduplicação no Tiny. Movs no ledger são puramente internas ao WMS. Cutover é problema do Plano 6.

## 13. Arquivos afetados

### Migrations
- `supabase/migrations/20260518_pick_zerou_ajuste.sql` (novo origem_tipo, nova tabela realocações, colunas em pedido_itens, novo status).

### Backend
- `src/app/api/separacao/parcial/route.ts` (novo).
- `src/app/api/separacao/marcar-realocacao/route.ts` (novo).
- `src/app/api/separacao/realocacao/[id]/route.ts` (DELETE — novo).
- `src/app/api/separacao/desfazer-parcial/route.ts` (novo).
- `src/app/api/separacao/marcar-item/route.ts` (estendido — gerar mov no ledger).
- `src/app/api/separacao/checklist-items/route.ts` (estendido — retornar realocações junto com itens).
- `src/lib/separacao/realocacao-resolver.ts` (novo — lógica de re-busca, reusa `grupo-resolver.ts`).
- `src/lib/wms/movimentacoes.ts` (estendido — helper pra mov de ajuste_pick_zerou se útil).

### Frontend
- `src/app/separacao/checklist/page.tsx` (botão Parcial, modal, badge Realocada, badge Parcial no item original).
- Novo componente: `src/components/separacao/parcial-modal.tsx`.
- Atualizar tipo `ChecklistItem` pra incluir `realocacoes: Realocacao[]` e `quantidade_pega: number | null`.

### Painel SISO
- `src/app/siso/page.tsx` (badge "Realocação" em pedidos com `status_separacao=pendente_realocacao`).
- `src/components/pedido/pedido-card.tsx` (mostrar detalhes da realocação pendente quando aplicável).

### Docs
- `docs/api-reference-complete.md` (adicionar 4 novos endpoints + atualização do marcar-item).
- `docs/database-schema.md` (nova tabela, novo origem_tipo, novo status, novas colunas).
- `docs/architecture-and-flows.md` (seção de short pick + re-alocação).
- `docs/fluxos-siso.md` (diagrama de status incluindo `pendente_realocacao`).
- `CLAUDE.md` (project structure: novos arquivos lib + components).

## 14. Implementação faseada (proposta inicial)

O plano de implementação completo será gerado pelo skill `writing-plans`. Esboço de fases:

1. **Migration** (schema + check constraints + nova tabela).
2. **Backend core**: lib `realocacao-resolver.ts`, endpoint `/parcial`, endpoint `/marcar-realocacao`.
3. **Estender marcar-item** com geração de mov.
4. **Endpoints auxiliares**: `desfazer-parcial`, `cancelar realocação`.
5. **Frontend modal + botão Parcial** no checklist.
6. **Visualização de realocação no fim da lista** + badges.
7. **Status `pendente_realocacao` no painel SISO** com detalhes.
8. **Testes integração + E2E manual em staging**.
9. **Docs updates**.

---

## Sign-off

Spec aprovado pelo user em 2026-05-18 após brainstorm guiado de 7 decisões fechadas. Pronto pra invocar `superpowers:writing-plans` pra gerar o plano de implementação.
