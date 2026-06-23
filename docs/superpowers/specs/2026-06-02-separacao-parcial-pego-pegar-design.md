# Separação Parcial — linha "PEGO" + linha "PEGAR" (e fix da reserva destruída)

**Data:** 2026-06-02
**Status:** Aprovado (design) → próximo: plano de implementação
**Origem:** bug reportado no SKU ACD003, wave dos pedidos #50144 + #50189 (staging `ehbxpbeijofxtsbezwxd`)

---

## 1. Problema

Numa separação parcial de **wave consolidado** (mesmo SKU em N pedidos colapsados numa linha do checklist), pegar menos que o total **destrói a reserva dos pedidos que não foram atendidos** e a tela volta a pedir a quantidade cheia.

### Caso real (confirmado no banco)
- #50144 e #50189, ambos ACD003 qty 1, mesma empresa (EasyPeasy), mesmo galpão, mesma loc `A-01-1`. Checklist consolidou em **1 linha "2"**.
- Operador pegou **1** sem zerar a prateleira (`loc_zerou=false`); ia pegar o resto em seguida.
- O sistema:
  - liberou **AS DUAS** reservas (2 movs `L`, 100% cada) — `5ff2c0ba` (#50144) + `0fe18c30` (#50189), reservado 2→0;
  - emitiu **1** saída `S` qty 1 (`d1b5f43f`), saldo 70→69, atribuída a #50144;
  - deixou **#50189 órfão**: `quantidade_pega=null`, sem reserva, sem saída, ainda `em_separacao`;
  - checklist voltou a mostrar **"2"** (item de #50189 sem `quantidade_pega` não é reconhecido como parcial → conta cheio).

### Causa raiz
`src/app/api/wms/separacao/parcial/route.ts:298-334` — o loop de liberação de reserva:
1. roda para **todos** os `pedidoIds` do wave, **incondicionalmente** (não está atrás de `if (loc_zerou)`);
2. libera **100%** da reserva de cada pedido (`:316-318`, `qty: Number(r.quantidade)`), não a quantidade pega.

Como `loc_zerou=false`, o cascade que recriaria a reserva do residual é **pulado** (`:799` retorna `parcial_em_progresso` antes do cascade). Resultado: a reserva do pedido não atendido é liberada e **nunca recriada**.

Agravantes:
- A saída `S` é dimensionada pela qty pega; a liberação `L` pela reserva total → **L e S divergem** (no pick normal atômico, `wms_pick_item_atomico`, L=S sempre).
- A UI de parcial (`checklist/page.tsx:1056-1063`) infere "parcial" de `quantidade_pega`; item com pega-zero some do estado parcial e o número volta ao total.
- Esse trecho é **refatoração não-commitada** (último commit `wip: checkpoint`; `distribuir-qty-pega.ts` untracked); o cenário E2E `69-parcial-fila-prateleira.ts` só cobre **single-pedido** — o caso wave multi-pedido não tem teste.

---

## 2. Comportamento desejado

Toda pega parcial gera, na **mesma linha de SKU consolidada**, duas linhas em termos de **quantidade** (não por pedido — os pedidos ficam invisíveis pro operador):

```
Início:      ☐  ACD003  A-01-1   PEGAR 10
pega 1  →    ☑  ACD003  A-01-1   PEGO  1     ← avança o(s) pedido(s) atendido(s)
             ☐  ACD003  A-01-1   PEGAR 9     ← linha nova, RESERVADA
pega 4  →    ☑  ACD003  A-01-1   PEGO  5
             ☐  ACD003  A-01-1   PEGAR 5
pega 5  →    ☑  ACD003  A-01-1   PEGO 10     ← completo; some a linha "PEGAR"
```

Regras:
- **Pegar tudo de uma vez** = só marcar o checkbox; nenhuma linha "PEGAR" sobra.
- A linha **PEGO** é **uma só, acumulativa** (1 → 5 → 10), não histórico empilhado.
- A linha **PEGO** representa pega **commitada**: avança o(s) pedido(s) que ela completou.
- A linha **PEGAR** permanece viva e **com estoque reservado** — ninguém pode roubar o saldo do residual.
- Atribuição interna unidade→pedido = **FCFS** (preenche um pedido por vez); invisível na tela.

---

## 3. Princípio / invariantes

**Invariante de conservação da reserva (o coração do fix):**

> Numa pega parcial, a soma das liberações de reserva (`L`) é **igual à quantidade efetivamente pega** (que vira `S`) — EXCETO quando a prateleira zera (`loc_zerou=true`), caso em que o residual também é liberado **e re-reservado em outra loc** pelo cascade existente.
>
> **Nunca** uma reserva é liberada sem que (a) sua quantidade vire saída, **ou** (b) seja recriada em outra posição.

Hoje: `Σ L = Σ R.quantidade` (cheio) e `S = pega` ⇒ `L > S` quando pega < reservado, e o residual de `loc_zerou=false` nunca é recriado. É exatamente a violação.

---

## 4. Mudanças por camada

### 4.1 Backend — `parcial/route.ts` (caminho modo-item)
- **Liberar só o que foi pego.** Substituir o loop que libera 100% por liberação **da quantidade alocada a cada pedido** (via `distribuirQtyPega`). Pedido com alocação zero → **não tocar** na reserva.
- **`loc_zerou=false`:** o residual de cada pedido **continua reservado** na mesma loc. Item segue "em progresso" (`separacao_parcial` não setado, `separacao_marcado=false`) — como já é o design, mas agora **sem perder a reserva**.
- **`loc_zerou=true`:** comportamento atual preservado — libera também o residual e o **cascade** (`:822-1116`) recria `R` em outra loc / encaminha / manda pra compras.
- **L=S por pega.** Garantir que cada liberação corresponde à saída da sua quantidade (reaproveitar a semântica de `wms_pick_item_atomico` onde fizer sentido, ou manter L/S em lote com a quantidade pega — decisão no plano).
- Manter o gate de concorrência (`:261-286`) e o rollback de race (`:691-788`).

### 4.2 Frontend — `checklist/page.tsx`
- Para um bucket de SKU **parcialmente pego** (`Σ quantidade_pega > 0` e residual `> 0`), renderizar **duas linhas**:
  - **PEGO** — checkbox marcado, `PEGO {Σ quantidade_pega}`, visual concluído;
  - **PEGAR** — checkbox aberto, `PEGAR {Σ max(0, quantidade − quantidade_pega)}`, acionável, mostra loc + "reservado".
- Derivar ambas da **mesma agregação** de `quantidade_pega` — **eliminar** a heurística frágil de `isParcial` (`:1056-1063`) como única fonte de verdade; a divisão pego/restante passa a ser determinística pelo somatório.
- `residual = 0` → só a linha PEGO (ou sai da lista ativa, como hoje). `quantidade_pega = 0` → só a linha PEGAR (cheia).

### 4.3 Schema
- **Sem mudança.** `siso_pedido_itens.quantidade_pega` (por item) já carrega o pego acumulado; `siso_pedido_item_mov_links` já rateia as movs. PEGO e PEGAR são **derivados**.

---

## 5. Reparo de dados (staging) — passo isolado do fix de código
Estado corrompido atual de #50189 (reserva destruída) precisa ser restaurado pro operador terminar a separação:
- **Recriar a reserva `R`** de #50189 (1 un, loc `A-01-1`) via o caminho canônico do ledger (`wms_inserir_movimentacao` / helper de reserva), restaurando `reservado` em `siso_estoque`.
- Verificar que #50144 está coerente (saída + marcação intactas) e que `siso_estoque` (saldo/reservado/disponível) bate.
- Confirmar que o checklist passa a mostrar **PEGO 1 + PEGAR 1** para a wave.
- Executado **manualmente e auditado** (SELECT antes/depois); nunca em prod.

---

## 6. Testes (meta verificável)
- **Cenário E2E novo/estendido** (a partir do `69-parcial-fila-prateleira.ts`) cobrindo **wave multi-pedido**: 2 pedidos, mesmo SKU, mesma loc, pega 1 de 2 com `loc_zerou=false`. Asserções:
  - exatamente **1** `S` (qty 1);
  - **exatamente 1** `L` (a do pedido atendido), reservado do residual **intacto** (`reservado` final = 1, não 0);
  - pedido residual mantém `R` viva;
  - checklist deriva **PEGO 1 + PEGAR 1**.
- **Regressão `loc_zerou=true`:** continua liberando o residual e recriando via cascade (uma `R` nova na loc destino).
- **Unit:** `distribuirQtyPega` (FCFS, bordas: pega 0, pega = total, pega > residual capado) e a aritmética da invariante `Σ L = pega` (loc_zerou=false).

---

## 7. Fora de escopo (YAGNI)
- **Não** criar linha-filha física em `siso_pedido_itens` (sem coluna de parentesco) — o residual vive como `quantidade_pega` na linha existente.
- **Não** adicionar UI de "escolher qual pedido recebe a unidade" — atribuição FCFS automática.
- **Não** mexer no caminho modo-realocação além do necessário para a regressão de `loc_zerou=true`.
- **Não** refatorar o pick normal (`marcar-item`) — só a parcial.

---

## 8. Arquivos-chave
- `src/app/api/wms/separacao/parcial/route.ts` — `:298-334` (loop libera R de todos), `:316-318` (libera 100%), `:336-362` (S pela pega), `:414` (FCFS), `:586-689` (marcação), `:790-821` (bifurcação loc_zerou), `:822-1116` (cascade)
- `src/lib/wms/reservas-picking.ts` — `:39-93` (`buscarReservaPendente`), `:219-246` (`liberarReservaPicking`), `:255-280` (`criarReservaCascade`), `:177-206` (`pickItemAtomico`)
- `src/lib/separacao/distribuir-qty-pega.ts:20-32` (FCFS — untracked)
- `src/app/wms/separacao/checklist/page.tsx` — `:172-218` (`consolidar`), `:1056-1063` (heurística parcial), `:1312` (`qtyExibida`), `:1364-1371` (badge)
- `src/app/api/wms/separacao/checklist-items/route.ts` — fonte dos campos
- `scripts/wms/cenarios/catalogo/69-parcial-fila-prateleira.ts` — cenário (só single-pedido)
- `supabase/migrations/20260518_pick_multi_loc.sql:52-59` — colunas de parcial

> ⚠️ WIP não-commitado nesse fluxo ("deixe correto"): reconciliar `parcial/route.ts`, `checklist/page.tsx`, `distribuir-qty-pega.ts` a partir do working tree atual, fechando a borda de `loc_zerou=false`.
