# Smoke da Sistemática de Testes de Estoque — 2026-05-21

**Branch:** `worktree-sistematica-testes-estoque`
**Plano:** `docs/superpowers/plans/2026-05-21-destravar-cenarios-estoque.md`

## Resultado da suite completa

Suite executada em 2026-05-21T19:00:29Z — duração 13m 32s.

**Total:** 17 cenários · **Pass:** 13 · **Fail:** 4 · **Skip:** 0 — cobertura **76.5%**.

```
# Suite Scenarios — 2026-05-21T19:00:29.063Z

**Total:** 17 cenários · **Pass:** 13 · **Fail:** 4 · **Skip:** 0 · **Tempo:** 13m 32s

## Cenários OK
- ✅ 01 — Pedido auto-aprovado própria (1m 13s)
- ✅ 04 — Parcial + realocação cascateada (1m 13s)
- ✅ 06 — Inventário com picking concorrente (1m 22s)
- ✅ 07 — Reservas TTL + cleanup (51.0s)
- ✅ 08 — Receber → Guarda parcial → Pendência (57.3s)
- ✅ 09 — Entrada direta (46.8s)
- ✅ 10 — Devolução cliente íntegra (A) (52.9s)
- ✅ 11 — Devolução cliente avariada (B/C/D) (53.2s)
- ✅ 13 — Venda Direta degradação (49.3s)
- ✅ 14 — Replenishment intra-galpão (52.2s)
- ✅ 15 — Transferência inter-galpão (49.4s)
- ✅ 16 — Lançamento retroativo + reconcilia (52.5s)
- ✅ 17 — Ajuste manual com motivo (52.4s)
```

Relatório completo: `scripts/wms/cenarios/reports/2026-05-21T19-00-29-063Z-summary.md`
JSON detalhado: `scripts/wms/cenarios/reports/2026-05-21T19-00-29-063Z-detail.json`

## Cenários passando

✅ **01 — Pedido auto-aprovado própria** — webhook → enrich → auto-approve → NF → separação → embalagem → expedição.
✅ **04 — Parcial + realocação cascateada** — Parcial com loc_zerou true dispara realocação, marcar-realocacao gera mov, segundo parcial encadeia chain.
✅ **06 — Inventário com picking concorrente** — operador entra na party, claim hierárquico funciona, divergência calculada com reconciliação temporal.
✅ **07 — Reservas TTL + cleanup** — `wms_reservar_atomico` cria mov R, cleanup libera após expiração.
✅ **08 — Receber → Guarda parcial → Pendência** — dock RECEBIMENTO cria pendência, put-away parcial mantém qty_pendente, segundo put-away encerra.
✅ **09 — Entrada direta** — flag `entrada_direta=true` em `/receber` pula RECEBIMENTO e grava direto na loc destino.
✅ **10 — Devolução cliente íntegra (A)** — classificação A re-entra estoque na loc original, custo médio inalterado.
✅ **11 — Devolução cliente avariada (B/C/D)** — classes B/C/D vão pra QUARENTENA com recálculo de custo médio (cliente B mantém custo, C/D zera).
✅ **13 — Venda Direta degradação** — modo `baixa_direta` sem saldo degrada pra `aguardando_separacao` (resposta `degradado:true`).
✅ **14 — Replenishment intra-galpão** — mov par S+E (origem → picking) preserva saldo total.
✅ **15 — Transferência inter-galpão** — origem→trânsito→destino mantém Σ saldo, custo médio preservado.
✅ **16 — Lançamento retroativo + reconcilia** — registro retroativo cria pendência, reconciliar vincula com mov real.
✅ **17 — Ajuste manual com motivo** — `/api/wms/ajuste` aceita tripla + direção (E|S) + motivo obrigatório.

## Cenários falhando — triagem

### 02 — Pedido transferência
- **Motivo:** assert
- **Erro:** `aguardarStatus: 9003047591 esperava pendente/transferencia em 5000ms; estado final: {"status":"concluido","sugestao":"propria"}`
- **Hipótese de causa:** `src/lib/tiny-stub.ts:handleGetEstoque` retorna saldo total sem filtrar por galpão preferido — o webhook vê saldo cheio em CWB (NetAir) → decide `propria` em vez de `transferencia`. O cenário semeia saldo só em SP (NetParts) e espera que NetAir veja zero em CWB e sugira transferência.
- **Próximo passo sugerido:** ajustar stub Tiny pra filtrar saldo por galpão preferido da empresa (join `siso_empresa_galpoes_preferenciais`), espelhando o comportamento real do Tiny (deposito_id por empresa).

### 03 — Pedido OC completo
- **Motivo:** assert (timeout)
- **Erro:** `aguardarStatusSeparacao: 9077486999 esperava validacao_oc em 8000ms; real: null`
- **Hipótese de causa:** o worker tenta setar `status_separacao='validacao_oc'` mas esse valor não existe no CHECK constraint de `siso_pedidos.status_separacao`. UPDATE silenciosamente falha (Postgres recusa o valor), campo fica null. **Bug prod real** — qualquer pedido OC completo passa pelo mesmo caminho.
- **Próximo passo sugerido:** opção A — adicionar `'validacao_oc'` no CHECK de `status_separacao` via migration; opção B — mudar `src/lib/execution-worker.ts:663` pra usar valor já permitido (provavelmente `aguardando_compra`). Decidir qual é a semântica correta antes de fixar.

### 05 — Parcial esgota → encaminhar
- **Motivo:** assert
- **Erro:** `aguardarStatus: 9038700264 esperava pendente/undefined em 5000ms; estado final: {"status":"concluido","sugestao":"propria"}`
- **Hipótese de causa:** mesma causa-raiz do cenário 02 — o stub Tiny não filtra saldo por galpão preferido da empresa, então o webhook auto-aprova como `propria` em vez de cair em `pendente` aguardando decisão humana.
- **Próximo passo sugerido:** mesmo fix do cenário 02 (cobre ambos).

### 12 — Venda Direta baixa_direta
- **Motivo:** run (HTTP 409)
- **Erro:** `POST /api/wms/vendas/criar → HTTP 409: {"erro":"Falha ao baixar TEST-12-fc6099: [object Object]","sku":"TEST-12-fc6099","movs_estornadas":0}`
- **Hipótese de causa:** `src/app/api/wms/vendas/criar/route.ts:343` passa `pedidoId='MAN-...'` (text) pra `wms_inserir_movimentacao.p_pedido_id` (uuid). **Bug prod real, mesmo padrão do C2 já catado em 5+ sites** (`execution-worker-wms`, `cutover.ts`, etc — corrigido em `marcar-item`, `marcar-realocacao`, `parcial` em commit `fe1a849`). O caminho `vendas/criar` ainda passa text pra uuid em modo `baixa_direta`.
- **Próximo passo sugerido:** opção A — gerar UUID pra `pedidoId` e passar identificador `MAN-...` em `origem_detalhes`; opção B — não passar `pedido_id` (deixar null) e referenciar a venda manual via `origem_detalhes.pedido_id_tiny`. Considerar fix sistêmico em `inserirMovimentacao` adicionando validação defensiva pra uuid mismatch (silencioso hoje, deveria gritar).

## Conclusão

**76.5% de cobertura** (13/17) alcançada após 1 round de iteração no plano de destravo + 1 fix prod (uuid mismatch em picking — commit `fe1a849`) + ajustes de harness. Acima da meta original de 12/17 do plano. Zona "PR com follow-ups" do plano: a infraestrutura funciona (truncate idempotente, seed determinístico, invariantes globais rodando, stubs PrintNode/ML/Tiny estáveis) e os 4 falhos restantes têm diagnóstico técnico claro:

- **2 cenários** (02, 05) dependem do mesmo fix: stub Tiny filtrar saldo por galpão preferido da empresa.
- **1 cenário** (03) expõe bug prod real: CHECK constraint de `siso_pedidos.status_separacao` não inclui `validacao_oc` (worker tenta setar e falha silenciosamente).
- **1 cenário** (12) expõe outro bug prod do mesmo padrão C2 (text vs uuid): `vendas/criar` em `baixa_direta` passa `pedidoId='MAN-...'` pra coluna uuid. Considerar adicionar validação defensiva em `inserirMovimentacao` pra catar essa classe sistemicamente.

**Recomendação:** merge da branch com os 4 follow-ups documentados aqui e nos commits do PR. A sistemática está produtiva — qualquer dev novo agora roda `npm run scenarios` e tem 13 cenários validando regressões em fluxos críticos (picking, devolução, inventário, replenishment, transferência inter-galpão, lançamento retroativo). Os 4 follow-ups viram tickets independentes, dos quais 2 são bugs prod reais que valem fix imediato.
