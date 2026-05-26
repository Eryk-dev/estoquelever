# Aprovar cria reserva (frontend + backend) — Design

**Status:** Approved — pending implementation plan
**Data:** 2026-05-25
**Autor:** brainstorm Eryk + Claude

## Contexto

Com `WMS_AS_SOURCE=true` (cutover Plano 6, ligado em 25/05), o fluxo correto do estoque é:

1. **Webhook chega** → `webhook-processor-wms.ts` roteia, e SE a sugestão for `propria`/`transferencia` cria reserva R no ledger via `wms_reservar_atomico`. Se sugestão for `oc` (saldo zero), **não reserva**.
2. **Operador aprova** → `aprovar/route.ts` transita o pedido pra `executando` e enfileira o worker.
3. **Operador separa** → `marcar-item` faz mov S direto (caminho legado preservado).
4. **Operador conclui** → `concluir/route.ts` dispara o cutover R→L+S via `executarEstoquePosNfWms`.

O passo 4 procura por reservas R do pedido. Se não acha nenhuma, marca `estoque_lancado=true` e retorna sem fazer L. Isso significa que **se a reserva nunca existiu, o cutover não tem o que liberar** — o estado fica fora do desenho R→L+S, e a auditabilidade do ledger perde a rastreabilidade "reservei → liberei → saí".

### Cenário real que motivou o spec

Pedido `2000016600592930` (TEN001-3, qty 3):

- Webhook chegou em `19:34:55` com saldo zero → `sugestao='oc'` → **nenhuma reserva criada**.
- Estoque inserido em `20:49:58` (ajuste manual, 10 un em `A-01-01 / CWB`).
- Operador aprovou manualmente como `decisao_final='propria'` em `00:38:48` — porque AGORA tinha saldo → mas o `aprovar/route.ts` não cria reserva, só transita status.
- Resultado: pedido entrou em separação **sem rastro de R no ledger**; quando o operador concluir, o cutover não vai achar R e o pedido vai depender exclusivamente do S direto do `marcar-item`.

A query de diagnóstico confirmou: **0 reservas R criadas nas últimas 24h** (todos os 4 pedidos viraram OC no webhook por saldo zero pós-flip, mas nenhum recebeu R quando aprovado manualmente depois).

## Objetivo

Quando o operador aprovar manualmente um pedido como `propria` ou `transferencia`, **o aprovar passa a criar as reservas R correspondentes** — alinhando com o invariante do cutover (R→L+S). Simultaneamente, o frontend bloqueia visualmente a escolha dessas opções quando não há cobertura full no banco, pra evitar approval em vazio.

## Decisões fundamentais (firmadas no brainstorm)

- **Invariante:** `decisao_final ∈ {propria, transferencia}` exige cobertura full de `siso_estoque` no `separacao_galpao_id` pra **todos** os itens do pedido. Sem cobertura full → opção desabilitada no botão.
- **Frontend é gate primário.** Backend confia no frontend e age como rede de segurança contra race condition / chamadas via API direta.
- **Atomicidade tudo-ou-nada.** Se uma das N reservas falha (race), as N-1 já criadas são estornadas via L (`inserirMovimentacao` com `estorno_de=R.id`) e retorna 409. O pedido **continua pendente**.
- **Idempotência por pedido.** Se já existe qualquer R com `origem_id=pedidoId, tipo='R', origem_tipo='reserva_pedido'`, o bloco de reservas inteiro é skippado (pedido já tem reservas — provavelmente do webhook ou de re-aprovação).
- **Decisão OC permanece intocada.** Não cria reserva. Caminho legado de compra/recebimento aplica.
- **TTL 30 dias.** Alinhado com `webhook-processor-wms.ts` (que usa `24 * 30` em vez do default 48h da reserva de inventário).
- **Localização escolhida = loc com maior saldo no galpão.** Mesma heurística do `buscarLocComMaiorSaldoNoGalpao` introduzido hoje pro `marcar-item`. Se um SKU tem múltiplas locs, a com mais saldo ganha (compactação natural).

## 1. Frontend — já implementado (verificar)

**Descoberta na fase de planejamento:** `src/components/wms/vendas/pedido-card-wms.tsx:106` já tem a função `decisaoIsAvailable(decisao, itens, filialOrigem)` que checa cobertura full corretamente:

- `propria` → `galpaoAtendeTudo(itens, filialOrigem)` (galpão origem cobre todos os itens)
- `transferencia` → algum outro galpão cobre todos
- `oc` → sempre `true`

O JSX (linha 198) usa o resultado em `disabled={!available}` no `<button>` do dropdown. O CSS `wms.css:2502` aplica `opacity: .4; cursor: not-allowed` quando `:disabled`. O `onClick` (linha 199) tem `if (!available) return;` como fallback. Label "sem estoque" (linha 210) aparece quando `!available`.

**Combinado com o commit `eac2826`** (estoque live na lista de pedidos), o `pedido.itens[].estoques` recebe saldo live de `siso_estoque` no GET — então `decisaoIsAvailable` agora opera sobre dados frescos, não snapshot.

**Tarefas no plano (frontend):**

- Smoke test manual: pedido com saldo zero → confirma que botão `propria` aparece cinza + não clicável.
- Smoke test manual: insere saldo, espera realtime (≤2s), confirma que botão `propria` vira clicável.
- Caso o smoke acuse problema (improvável dado o código acima), entra como bug separado.

## 2. Backend — `/api/wms/pedidos/aprovar`

**Arquivo:** `src/app/api/wms/pedidos/aprovar/route.ts`.

**Sequência nova (em `POST`):**

```
1. Validações de entrada (já existe)
2. Resolve empresa/galpão (já existe)
3. [NOVO] Se wmsAsSource() && decisao IN ('propria', 'transferencia'):
     a. Idempotência: SELECT R existente pro pedido. Se existe, pula pra 4.
     b. Resolve produtos WMS + loc top por item
     c. Loop atômico de reservas
     d. Se algum falhar: estorna parciais + return 409
4. UPDATE pedido → executando (já existe, agora só roda após reservas OK)
5. INSERT fila execução (já existe)
6. registrarEvento + kickWorker (já existe)
```

**Contrato HTTP:**

| Caso | Status | Body |
|---|---|---|
| Sucesso | 200 | `{ ok: true, pedidoId, decisao, ... reservasCriadas?: number }` |
| Race condition / saldo insuficiente em runtime | 409 | `{ error: "reserva_falhou", motivo: "saldo_insuficiente", item: { sku, qty_pedida }, criadas_estornadas: N }` |
| Item sem mapeamento `siso_produto_empresas` | 409 | `{ error: "reserva_falhou", motivo: "mapeamento_ausente", item: { sku, produto_id_tiny } }` |
| Já existe R pro pedido (idempotente) | 200 | `{ ok: true, ... reservasCriadas: 0, motivo: "ja_reservado" }` |
| Decisão = `oc` | 200 | (sem reservas, comportamento atual) |

**Helpers reusados:**

- `resolverProdutoWms(empresaId, tinyProdutoId)` em `src/lib/separacao/wms-mapping.ts` — Tiny ID → UUID WMS.
- `buscarLocComMaiorSaldoNoGalpao(galpaoId, produtoUuid)` no mesmo arquivo — loc top.
- `reservarAtomico({ tripla, qty, pedido_id, ttl_horas })` em `src/lib/wms/reservas.ts` — RPC `wms_reservar_atomico`.
- `wmsAsSource()` em `src/lib/wms/flags.ts`.

## 3. Helper novo — `estornarReservaIndividual`

**Arquivo:** `src/lib/wms/reservas.ts`.

Pra fazer rollback de uma R específica criada nessa mesma transação lógica do aprovar, sem usar a função `liberarReserva` existente (que opera por `origem_id=pedido_id` e libera TODAS as R do pedido — não serve pra rollback parcial).

```ts
export async function estornarReservaIndividual(input: {
  reserva_id: string;
  motivo: "rollback_aprovacao" | "outro";
  usuario_id?: string;
}): Promise<string> {
  // Busca a R (produto/galpão/loc/quantidade)
  // Insere L com estorno_de=reserva_id
  // Retorna o id do L criado
}
```

Idempotência: se já existe L com `estorno_de=reserva_id`, retorna o id existente sem criar novo.

## 4. Edge cases

| Caso | Comportamento |
|---|---|
| Race condition: UI mostrava cobertura, mas outro pedido aprovou e zerou entre o clique e a chamada | RPC `wms_reservar_atomico` falha com saldo insuficiente → estorna parciais → 409. Frontend re-busca lista (estoque live), botões re-calculam. |
| Operador clica "Aprovar" 2x | 1ª chamada cria reservas + transita status. 2ª chamada: pedido já não está `pendente` → retorna 409 atual (`pedido não está pendente`), mas se chegar antes do update, idempotência pega via R existente. |
| Pedido com SKU sem mapeamento `siso_produto_empresas` | `resolverProdutoWms` lança → estorna parciais → 409 com motivo. Operador precisa criar mapeamento e re-aprovar. |
| Frontend bypassed (chamada API direta) sem cobertura | RPC falha → 409 idêntico ao race condition. |
| Decisão `transferencia` com `separacaoGalpaoId` diferente do origem | Reservas vão pro `separacaoGalpaoId` (definido pelo route conforme `empresaSuporte.galpaoId`). |
| Webhook já criou R + operador reaprova como outra decisão | Idempotência detecta R existente, skip criação. Update de status segue. (Caso raro — reaprovação não está modelada hoje no aprovar; se o cenário aparecer, é outro escopo.) |
| Pedido tem 0 itens | `criarReservasPedido` retorna sem fazer nada. Continua fluxo (pedido válido só com `marcadores`?). |

## 5. Não-escopo (explicit)

- **Não muda `marcar-item`.** Continua fazendo S direto. A dupla-baixa potencial com cutover é tratada implicitamente: cutover busca R por `origem_id=pedido + tipo=R`; se foram convertidas em L (com `estorno_de` apontando), pula. (Bug independente, fora do escopo deste spec — abordar quando o caso real aparecer.)
- **Não muda `webhook-processor-wms.ts`.** Continua criando R quando sugestão é propria/transferência no momento do webhook.
- **Não muda `concluir/route.ts` nem `executarEstoquePosNfWms`.** O cutover R→L+S continua igual; agora vai encontrar as R criadas pelo aprovar.
- **Não toca `parcial/route.ts` / `encaminhar`.** Esses lêem snapshot de `siso_pedido_item_estoques` pra alguma coisa; bug separado já mencionado em conversa.
- **Não cria nova tabela.** Tudo via tabelas existentes (`siso_movimentacoes`, `siso_estoque`).

## 6. Testes

- **Cenário novo em `scripts/wms/cenarios/catalogo/`:** `18-aprovar-cria-reserva.ts`
  - Setup: cria pedido com saldo zero (vai pra OC) → adiciona saldo via ajuste → aprova como propria → assert R criada com qty igual a quantidade_pedida + assert ledger coerente (I1–I7).
- **Cenário novo:** `19-aprovar-sem-cobertura-falha.ts`
  - Setup: pedido pendente → tenta aprovar via API direta sem ter saldo → assert 409 com motivo `saldo_insuficiente` + assert pedido continua `pendente` + assert nenhuma R órfã ficou no ledger.
- **Unit test** em `src/app/api/wms/pedidos/aprovar/route.test.ts` (criar se não existir): mock supabase, valida idempotência (2ª chamada com R existente skipa).
- **Invariantes globais** (I1–I7 já existentes) garantem que cada cenário ao fim tem ledger coerente.

## 7. Resumo do impacto

| Camada | Arquivo | Tipo de mudança |
|---|---|---|
| Frontend | `src/components/wms/vendas/pedido-card-wms.tsx` | **Nenhuma** (já implementado — verificação manual) |
| Backend | `src/app/api/wms/pedidos/aprovar/route.ts` | Edit: novo bloco antes do update + helper local |
| Helper | `src/lib/wms/reservas.ts` | Add: função `estornarReservaIndividual` |
| Testes | `scripts/wms/cenarios/catalogo/18-aprovar-cria-reserva.ts` | New |
| Testes | `scripts/wms/cenarios/catalogo/19-aprovar-sem-cobertura-falha.ts` | New |
| Testes | `scripts/wms/cenarios/run-all.ts` | Edit: registra 18 + 19 |
| Docs | `CLAUDE.md` | Edit: linha do aprovar nas APIs e nota no fluxo R→L+S |

Migration SQL: **nenhuma**. Comportamento usa tabelas existentes.
