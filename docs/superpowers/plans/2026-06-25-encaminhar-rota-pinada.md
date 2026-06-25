# Plano TDD — Encaminhar com Re-Rota PINADA no Galpão Destino

> Documento de planejamento. Status: **proposto** (2026-06-25). Aguardando implementação.
> Origem: pedido 953008167 (nº 85043) encaminhado SP→CWB ficou órfão (item coberto em CWB sem reserva/loc → não-bipável → forçado). Raiz: `encaminhar` descarta o destino.

## ⛓️ INVARIANTE CENTRAL (repetir em todo PR/teste/review)

**O roteamento da re-rota é PINADO no galpão destino escolhido pelo operador — NUNCA geo-priority livre.** O algoritmo de cobertura avalia **só o galpão destino**. Se a re-rota usar `rotearPedidoDoBanco` (que carrega TODOS os galpões ativos e ordena por `geoPriority`), o pedido re-roteia pro galpão errado de novo — **esse é exatamente o bug que estamos matando**. A re-rota só pode produzir, para o destino pinado: `própria` (cobre) · `troca` (equivalente no destino) · `oc` (não cobre). **Nunca `transferencia`** (transferência implicaria escolher outro galpão = quebra do pino).

---

## Comportamento alvo

`encaminhar(pedido, destino)` reprocessa o pedido como **nativo do destino, com destino forçado**:

1. **destino COBRE o item com saldo próprio** → `propria`, cria `R reserva_pedido` no destino na loc certa (picking-first), status final `aguardando_separacao` (NF preservada).
2. **não cobre mas há equivalente/cross no destino** → troca de equivalência **no destino**: auto se par livre (vira `propria`), senão `pendente` + `sugestao='troca_equivalente'` **com `separacao_galpao_id` JÁ pinado no destino**.
3. **não cobre e sem cross** → `oc` ancorada no destino (`decisao_final='oc'`, `separacao_galpao_id=destino`, job `lancar_estoque` `decisao='oc'`).

Preserva tudo que o encaminhar atual já faz certo (abaixo). **Falha na re-rota não move o pedido** (catch do caller registra em `falhas[]`, pedido fica intacto).

---

## O que o encaminhar atual JÁ faz certo (PRESERVAR 1:1)

Arquivo: `src/app/api/wms/separacao/encaminhar/route.ts`

- **Guard de status** (linhas 131-139): só `aguardando_separacao | em_separacao | pendente_realocacao`.
- **Guard mesmo galpão** (145-147): erro se `galpaoAtual.id === galpaoDestino.id`.
- **`reverseStockExecution`** (313-396): libera R vivas via `estornarReservaIndividual({motivo:'outro'})` (idempotente; logError LOUD em R não-liberada = reservado fantasma) + `cancelarTrocasPendentesDoPedido`. **Ordem mantida: cancelar trocas → liberar R.** Rodar ANTES de mexer no pedido.
- **`resetarEstadoSeparacaoItens`** (`src/lib/separacao/reset-state.ts:78`, `motivo:'encaminhar'`, `recriarReservas=false` default): estorna S do pick (`mov_saida_id` + realocs `picado`/`picado_parcial`), cancela realocs `aguardando_picking`, reseta 10 campos, apaga links de ponte. **Erro aqui é FATAL** (re-lança → pedido intacto).
- **Reset de campos legados** (212-221): `quantidade_bipada=0`, `bipado_completo=false`, `estoque_saida_lancada=false`, `empresa_deducao_id=null` em TODOS os itens.
- **NF PRESERVADA** (175-176): `nota_fiscal_id`, `chave_acesso_nf`, `url_danfe` **NÃO** zerados.
- **Etiqueta/agrupamento**: só `etiqueta_status=null` (reimprimir). `agrupamento_expedicao_id`/`expedicao_id`/`etiqueta_zpl`/`etiqueta_url` ficam (presos à NF, não ao galpão).
- **`sugestao` dinâmica** (183): será sobrescrita pela re-rota (própria/oc/troca_equivalente).
- **Evento `encaminhado`** (224-234): manter; a re-rota acrescenta eventos.
- **Multi-pedido**: loop por `pedido_ids[]` com `encaminhados[]`/`falhas[]` (83-100).

**A ÚNICA mudança**: substituir o bloco **B3** (linhas 185-210, que faz `status='pendente'` + **`separacao_galpao_id=null`**) por **injetar a re-rota PINADA no destino**.

---

## Onde `rotearPedidoDoBanco` precisa de variante PINADA (assinatura concreta)

`rotearPedidoDoBanco(empresaVendedoraId, itens)` (`roteamento.ts:206`) **não serve** — carrega `siso_galpoes WHERE ativo=true` (228-231) e ordena por `geoPriority`. **Não pinar via ele.**

O núcleo `rotearPedido(ctx: RotearContext)` (`roteamento.ts:118`) **já é agnóstico ao banco**: itera `ctx.galpoes`. **Pinar = passar `ctx.galpoes = [galpaoDestino]`.** Com lista de um galpão e `galpoes_preferenciais=[destino.id]`, `geoPriority(destino, homes)=0` → `RotaResult.decisao` só pode ser `'propria'` (cobre) ou `'oc'` (`sem_cobertura`/`split_galpoes`). **Nunca `transferencia`** (linha 185-186: `dist===0 ? 'propria' : 'transferencia'`; com pino `dist` é sempre 0).

O `buscarLinha` está inline em `rotearPedidoDoBanco` (240-286): query `siso_estoque` filtrando `galpao_id`, join `!inner siso_localizacoes` em `TIPOS_LOC_VENDAVEIS` (`['picking','overstock']`, CST-01), `disponivel >= qty`, exclui locs com lock ativo, ordena picking-first + maior saldo.

### Nova função em `src/lib/wms/roteamento.ts`

```ts
// 1) Extrair o closure de query (linhas 240-286) para reuso:
export function criarBuscarLinhaDoBanco(
  sb: ReturnType<typeof createServiceClient>,
): RotearContext["buscarLinha"]

// 2) Variante PINADA — avalia cobertura SÓ no galpão destino:
export async function rotearPedidoPinado(
  galpaoPinadoId: string,
  itens: ItemPedido[],
): Promise<RotaResult>
```

`rotearPedidoPinado` carrega só o galpão `galpaoPinadoId`, monta `ctx = { vendedora: { id: '<irrelevante>', galpoes_preferenciais: [galpaoPinadoId] }, galpoes: [esseGalpao], itens, buscarLinha: criarBuscarLinhaDoBanco(sb) }` e chama `rotearPedido(ctx)`. Retorna `RotaResult` com `decisao ∈ {'propria','oc'}`.

> **VERIFICAR**: destino já validado `ativo=true` pelo endpoint (route.ts:66-78) — manter validação no caller.

---

## FASES TDD

### Fase 0 — Red guard: provar o bug atual

**Objetivo:** capturar em teste que hoje o encaminhar descarta o destino (`separacao_galpao_id=null`, `status='pendente'`).

**Teste:** `test/integration/encaminhar-rota-pinada.test.ts` (staging real, padrão de `cancelar-venda-rpc.test.ts`). Seed: pedido SP, item `022820` com saldo em CWB `A-02-3`. `POST encaminhar → CWB`. Assert estado legado (`it.skip`/`it.todo`, "substituído na Fase 2").

**Verificação:** `npm run test:integration`.

### Fase 1 — `rotearPedidoPinado` (unidade pura)

**Objetivo:** algoritmo pinado nunca olha outro galpão; cobre → `propria`; não cobre → `oc('sem_cobertura')`.

**Teste:** `src/lib/wms/roteamento.test.ts` (mock `buscarLinha`, estilo linhas 47-90):
1. **Cobre no destino (022820 em CWB A-02-3):** `decisao==='propria'`, `galpao_id==='g-cwb'`, `rotas[0].localizacao_id==='A-02-3'`.
2. **NÃO cobre (007237 só em SP):** `decisao==='oc'`, `motivo==='sem_cobertura'`.
3. **Anti-vazamento geo:** cobre em `g-sp` mas `ctx.galpoes=[g-cwb]` → `decisao==='oc'` (NÃO `transferencia`) — prova o pino.

**Implementação:** extrair `criarBuscarLinhaDoBanco(sb)` + `rotearPedidoPinado` (só movimentação + wrapper; `rotearPedido` intocado).

**Verificação:** `npm test src/lib/wms/roteamento.test.ts`.

### Fase 2 — Re-rota PINADA: caso PRÓPRIA (destino cobre)

**Teste (integration):** pedido SP só com `022820` (saldo CWB A-02-3), NF emitida. `POST encaminhar → CWB`. Asserts:
- `separacao_galpao_id === CWB` (**PINADO, não null**); `decisao_final==='propria'`, `status==='executando'`, `status_separacao==='aguardando_separacao'`;
- `R reserva_pedido` viva em `(022820_uuid, CWB, A-02-3)`; NF inalterada; job `lancar_estoque decisao='propria'`; R de origem (SP) liberadas.

**Implementação** (no `encaminharPedido`, substituindo B3): após reverse+reset:
1. Montar `itensRotear` resolvendo tiny→uuid via `resolverProdutoEfetivoDoItem` (`wms-mapping.ts:95`, padrão `aprovar/route.ts:296-315`).
2. `const rota = await rotearPedidoPinado(galpaoDestino.id, itensRotear)`.
3. `propria` → `criarReservasRotaAtomico` (`webhook-processor-wms.ts:478`, exportado, rollback atômico) + `wms_aprovar_e_enfileirar` (`p_decisao='propria'`, `p_status_separacao = NF? 'aguardando_separacao':'aguardando_nf'`, `p_separacao_galpao_id=galpaoDestino.id`, `p_marcadores=[galpaoDestino.nome,'LVR']`) — espelha `aprovarPedidoPosTroca` (`trocas-roteamento.ts:448-461`). O UPDATE legado deixa de setar `status='pendente'`/`separacao_galpao_id=null`.

> **VERIFICAR** `execution-worker-wms.ts`: job `propria` com NF presente = no-op fiscal, não regride status.

**Verificação:** integration passa.

### Fase 3 — Re-rota PINADA: caso TROCA (equivalente no destino)

**Teste (integration):** pedido SP com `007237` (SEM saldo CWB) cujo equivalente `031128` TEM saldo em CWB CP-18-7:
- **3a — par LIVRE:** `decisao_final==='propria'`, `aguardando_separacao`, `produto_wms_substituto_id===031128_uuid`, troca `aprovada`, `R reserva_pedido` em `(031128, CWB, CP-18-7)`, `separacao_galpao_id===CWB`.
- **3b — par exige APROVAÇÃO:** `status==='pendente'`, `sugestao==='troca_equivalente'`, **`separacao_galpao_id===CWB` (pinado mesmo pendente)**, `R reserva_troca` (TTL 48h) em `(031128, CWB, CP-18-7)`, `decisao_final===null`. `POST /trocas/[id]/aprovar` → `aprovarPedidoPosTroca` usa `separacao_galpao_id` (já CWB) → `propria`+`aguardando_separacao`.

**Implementação:** quando `rota.decisao!=='propria'` → espelhar `webhook-processor-wms.ts:711-756`+`1158-1212` **SEM troca remota** (pino = só destino): `planejarTrocaRoteamento({galpaoId: galpaoDestino.id, itens})`; se `plano` → `aplicarTrocasRoteamento({pedidoId, galpaoId: galpaoDestino.id, swaps, forcarPendente:false})` + `criarReservasRotaAtomico` p/ cobertos+swaps auto; `todosAuto` → `wms_aprovar_e_enfileirar propria`; senão → UPDATE `pendente`/`troca_equivalente`/`separacao_galpao_id=destino`.

**Verificação:** 3a e 3b passam.

### Fase 4 — Re-rota PINADA: caso OC ancorada no destino

**Teste (integration):** `007237` sem saldo nem equivalente em CWB (`planejarTrocaRoteamento`→`null`). Asserts: `decisao_final==='oc'`, `separacao_galpao_id===CWB`, `status==='executando'`, `status_separacao===null`; job `lancar_estoque decisao='oc'`; nenhuma `R reserva_pedido`; worker → `varredura-validacao-oc` ancora em CWB (`varredura-validacao-oc.ts:66` filtra `separacao_galpao_id`).

**Implementação:** `rota.decisao==='oc'` E `plano===null` → espelhar `autoEnfileiraOc` (`webhook-processor-wms.ts:806-807,1234-1258`): UPDATE `decisao_final='oc'`, `separacao_galpao_id=destino`, `status='executando'`, `status_separacao=null`, `marcadores=['OC',galpaoDestino.nome,'LVR']`; job `lancar_estoque {decisao:'oc'}` (dedup) + `kickWorker()`.

> **VERIFICAR** `execution-worker-wms.ts`/`varredura-validacao-oc.ts`: `executarMarcadoresOnly` seta `validacao_oc` usando `separacao_galpao_id` do pedido, sem recalcular galpão.

**Verificação:** OC ancora em CWB.

### Fase 5 — Idempotência, falha-não-move, NF/status

**Testes (integration):**
1. **Idempotência:** encaminhar 2× SP→CWB → exatamente 1 R viva no destino, 1 job (dedup por tripla + status já executando).
2. **Falha não move:** uuid não resolve / saldo some → `criarReservasRotaAtomico` rollback + re-lança → `catch` (route.ts:92-99) registra `falhas[]`, pedido permanece no estado original (ver D5).
3. **NF ausente:** `p_status_separacao='aguardando_nf'`.

### Fase 6 — Wiring final + multi-pedido + remover legado

**Teste:** `pedido_ids=[A(cobre), B(cross), C(OC)]` → cada no estado da sua fase, evento `encaminhado` em todos.

**Implementação:** extrair helper `reRotearPinadoNoDestino({supabase, pedido, galpaoDestino, session})` no lugar de B3. Remover `status:'pendente'`/`separacao_galpao_id:null` do UPDATE legado. Manter `encaminhado_de`, limpeza operador/etiqueta, evento.

**Verificação:** `npm test && npm run test:integration && npm run lint`.

---

## DECISÕES (D1..D8)

- **D1 — Pino via `rotearPedidoPinado`, não `rotearPedidoDoBanco`.** `galpoes=[destino]`, preferenciais=`[destino.id]` → `geoPriority=0` → decisão só `propria`/`oc`. Nunca `transferencia`.
- **D2 — Sem cobertura nem cross → `oc` PINADO no destino.** NÃO usar `planejarTrocaRemota` (reabriria geo-priority e quebraria o pino). Mirror de `autoEnfileiraOc`.
- **D3 — Troca local no destino PODE auto-aprovar** (`forcarPendente=false`). Remoto força pendente; aqui o destino É a casa pinada → par livre vira `propria`. Tier diferente/não-verificado → `pendente`.
- **D4 — Troca que precisa aprovação → `pendente` + `troca_equivalente`, MAS `separacao_galpao_id` JÁ pinado** + `R reserva_troca`. `aprovarPedidoPosTroca` (`trocas-roteamento.ts:412,442`) lê `separacao_galpao_id` do pedido → finaliza no destino, sem re-rotear.
- **D5 — Ordem por pedido (mantém "falha não move"):** reverse → reset (FATAL) → re-rota. Como B3 legado some, `separacao_galpao_id` não é zerado até a re-rota decidir o novo. **VERIFICAR**: se necessário, adiar escrita de `status`/`galpao` ao commit da re-rota.
- **D6 — Reusar `criarReservasRotaAtomico` (exportado), não `criarReservasPedido` (file-private).** A rota pinada já devolve `localizacao_id`. (Se quiser picking-first re-resolvido, exportar `criarReservasPedido` — decidir na impl.)
- **D7 — Status final:** `propria`/troca-auto = `aguardando_separacao`; `oc` = `null` (worker→`validacao_oc`); troca-pendente = `pendente`.
- **D8 — Marcadores recalculados pro novo galpão:** `[galpaoDestino.nome,'LVR']` (própria/troca) ou `['OC',galpaoDestino.nome,'LVR']` (oc). NÃO preservar do galpão antigo.

---

## RISCOS e casos extremos

- **Kit:** `siso_pedido_itens` do encaminhado já vem expandido em componentes (vindo do intake). **VERIFICAR** + teste de kit.
- **Multi-item parcial:** `rotearPedido` é tudo-ou-nada por galpão (sem fallback parcial, `roteamento.ts:155-176`). `[022820(cobre), 007237(não, sem cross)]` → pedido INTEIRO `oc` no destino. Consistente com intake.
- **Item já bipado antes:** `resetarEstadoSeparacaoItens` estorna a S do pick; re-rota cria R fresca. Teste de regressão: bipar 1 em SP, encaminhar, conferir S estornada + R nova em CWB.
- **Reserva órfã:** se `estornarReservaIndividual` falhar, R viva trava saldo na origem (logError LOUD já existe). Re-rota cria R no destino mesmo assim. Aceito (trava, não vende dobrado); não regredir a severidade.
- **Concorrência (TOCTOU):** dedup por tripla + `wms_aprovar_e_enfileirar` no-op + job dedup. Janela ~500ms (mesma do `criarReservasPedido`). Guard de status no início. Aceitável.
- **Promoção de futura:** guard de status barra encaminhar de futura `separado` hoje. **VERIFICAR** se é o desejado.
- **NF/agrupamento stale:** `agrupamento_expedicao_id` preservado (preso à NF); `etiqueta_status=null` reimprime. Sem ação.

---

## ARQUIVOS tocados

| Arquivo | Mudança |
|---|---|
| `src/lib/wms/roteamento.ts` | **NOVO** `criarBuscarLinhaDoBanco(sb)` (extrai 240-286) + `rotearPedidoPinado(galpaoPinadoId, itens)`. |
| `src/app/api/wms/separacao/encaminhar/route.ts` | Substituir B3 (185-210) por `reRotearPinadoNoDestino(...)`; remover `status:'pendente'` e `separacao_galpao_id:null`; manter NF/etiqueta/eventos/reset legados. |
| `src/lib/wms/roteamento.test.ts` | Casos `rotearPedido` pinado (Fase 1). |
| `test/integration/encaminhar-rota-pinada.test.ts` | **NOVO** — Fases 0,2,3a,3b,4,5,6 (staging). |
| `docs/api-reference-complete.md` | Atualizar contrato de `POST /api/wms/separacao/encaminhar`. |
| `docs/architecture-and-flows.md` + `docs/fluxos-siso.md` | Atualizar fluxo "encaminhar/forward". |
| `erros-conhecidos.yaml` | Entrada `ENCAMINHAR-ROTA-PINADA-01`. |

**Reusados sem alteração:** `reverseStockExecution`, `resetarEstadoSeparacaoItens` (`reset-state.ts:78`), `estornarReservaIndividual` (`reservas.ts:183`), `cancelarTrocasPendentesDoPedido` (`trocas-equivalencia.ts:836`), `criarReservasRotaAtomico` (`webhook-processor-wms.ts:478`), `planejarTrocaRoteamento` (`trocas-roteamento.ts:109`), `aplicarTrocasRoteamento` (`trocas-roteamento.ts:263`), `aprovarPedidoPosTroca` (`trocas-roteamento.ts:412`), `resolverProdutoEfetivoDoItem` (`wms-mapping.ts:95`), RPC `wms_aprovar_e_enfileirar`, varredura OC.

---

## Pontos **VERIFICAR** antes de implementar

1. `execution-worker-wms.ts` — job `propria` com NF presente é no-op fiscal, não regride `aguardando_separacao` (Fase 2).
2. `execution-worker-wms.ts`/`varredura-validacao-oc.ts` — `executarMarcadoresOnly` seta `validacao_oc` usando `separacao_galpao_id` do pedido (Fase 4/D2).
3. `aprovar/route.ts:487` — exportar `criarReservasPedido` (picking-first) vs `criarReservasRotaAtomico` (loc da rota) (D6; default = `criarReservasRotaAtomico`).
4. Ordem reset×re-rota e contrato "falha não move" (D5).
5. `siso_pedido_itens` do encaminhado já vem com kit expandido.
6. Guard de status barra encaminhar de futura `separado` — confirmar se desejado.

---

## Entrada para `erros-conhecidos.yaml` (adicionar ao implementar)

```yaml
- id: ENCAMINHAR-ROTA-PINADA-01
  date: 2026-06-25
  source: src/app/api/wms/separacao/encaminhar/route.ts
  category: business_logic
  message: >
    Encaminhar (forward) de pedido entre galpões descartava o destino escolhido
    pelo operador: zerava separacao_galpao_id, virava pendente+sugestao=transferencia
    e delegava re-aprovação humana que re-roteava por geo-priority LIVRE — podendo
    re-rotear pro galpão errado (o mesmo de onde o operador quis tirar).
  cause: >
    O reset reusava o caminho de re-aprovação que chama rotearPedidoDoBanco
    (carrega TODOS os galpões ativos + ordena por geoPriority). Sem pino no
    destino, a cobertura era avaliada na rede inteira.
  fix: >
    Re-rota PINADA no destino: rotearPedidoPinado(galpaoDestinoId, itens) avalia
    cobertura SÓ no galpão destino (ctx.galpoes=[destino], preferenciais=[destino]
    -> geoPriority=0 -> decisão propria|oc, nunca transferencia). Cobre->propria+R na
    loc (criarReservasRotaAtomico) + wms_aprovar_e_enfileirar(separacao_galpao_id=
    destino). Não cobre mas cross no destino->planejar/aplicarTrocasRoteamento
    (galpaoId=destino, forcarPendente=false). Sem cobertura nem cross->OC ancorada
    no destino. NF preservada -> aguardando_separacao quando a reserva fecha.
  files:
    - src/lib/wms/roteamento.ts
    - src/app/api/wms/separacao/encaminhar/route.ts
    - test/integration/encaminhar-rota-pinada.test.ts
  tags: [encaminhar, forward, roteamento, pino, geo-priority, troca-equivalencia, oc, reservas]
```
