# Limpa 2026-06-11 — Diagnóstico Compras · Separação · Inventário · Estoque

> **STATUS 2026-06-11 (fim do dia):** TODOS os achados tratados — P0+P1 (24, exec. direta) e P2+P3 (62, spec Fable → exec. Opus). Migrations 20260611d–p (10) aplicadas no staging e verificadas. tsc limpo, 343/343 unit tests, ESLint limpo nos arquivos tocados. NADA commitado ainda.
>
> Auditoria de 5 agentes (4 módulos + costuras entre módulos). ~85 achados confirmados com evidência.
> **Este arquivo é o tracker vivo:** ao corrigir um item, mudar o status, anotar commit/migration e data.
> Toda correção também vira entrada em `erros-conhecidos.yaml` (convenção do projeto).

**Legenda de status:** ⬜ pendente · 🔧 em andamento · ✅ corrigido · ❌ descartado (justificar)

**Ordem de ataque sugerida:**
1. P0-01, P0-02 (corrupção ativa)
2. SEP-01 (`ledger.ts` rejeita L — destrava 4 bugs downstream de uma vez)
3. CST-01 (roteamento por tipo de loc — estrutural)
4. CST-02 / CST-03 (cancel-handler)
5. EST-01 (guarda parcial quebrada)
6. CMP-02 (está na mudança NÃO COMMITADA — corrigir antes de commitar)

**Padrões sistêmicos identificados** (atacar a causa, não só o sintoma):
- **Erro engolido em caminho de escrita** (`catch → logger.warn → continua`): bipar-checklist, validar-oc-item, desfazer-parcial, race-losers do parcial, reset-state.
- **Fix aplicado em 1 de N caminhos gêmeos**: marcar-item fail-loud ↔ bipar-checklist não; parcial modo item ↔ modo realocação; contagem com `continue` ↔ legado sem; compras-release com guarda ↔ comprar sem.
- **Estados terminais/de erro sem superfície na UI**: `encerrada_sem_saldo`, pedido `erro`, sessão presa em `aprovada`, `expedido`.

---

## 🔴 P0 — Corrompe estoque em fluxo comum

### ✅ P0-01 · Desmarcar item de wave consolidada estorna a mov S inteira, não a fração
- **Onde:** `src/app/api/wms/separacao/marcar-item/route.ts:244-264` + `supabase/migrations/20260608_rpc_desmarcar_item_atomico.sql:37-44`
- **Evidência:** parcial (modo item) cria 1 mov S única pro wave com links rateados por item. Desmarcar checkbox pega `links.find(tipo_link==='saida')` e chama `wms_desmarcar_item_atomico`, que estorna `v_s.quantidade` (TOTAL da mov), não `link.qty`. O `desfazer-parcial` usa `wms_estornar_parcial_movimentacao` com `link.qty` exatamente por isso.
- **Impacto:** wave A(2 un)+B(3 un) mesmo SKU → S de 5. Desmarca só A → E de 5. Saldo +5, só 2 voltaram fisicamente. Estoque fantasma +3.
- **Direção de fix:** no desmarcar, quando a S é consolidada (link.qty < mov.quantidade), usar estorno parcial por `link.qty` (mesmo caminho do desfazer-parcial) + recriar R da fração.
- **Fix:** ✅ 2026-06-11 — migration `20260611d` (RPC aceita `p_qty_link`+`p_pedido_item_id`; estorno parcial idempotente por item, R clampada) + marcar-item itera links com fração. Aplicada no staging.

### ✅ P0-02 · Inventário: loc devolvida ao pool não limpa contagens antigas → recontagem SOMA → estoque fantasma
- **Onde:** `src/lib/wms/inventario.ts:483-507` (sairParty) + `src/lib/wms/inventario-recovery.ts:77-87` (cron 30min) + `src/lib/wms/inventario.ts:281-291`
- **Evidência:** recovery/sairParty resetam loc pra `pendente` mas rows de `siso_inventario_contagens` do 1º operador permanecem. `reconciliarTemporal` soma TODAS as rows da tripla. Op2 recebe tela ZERADA e conta tudo de novo.
- **Impacto:** loc com 10 físicos: op1 bipa 6, handheld morre, cron libera, op2 conta 10 → contado 16, esperado 10 → ganho falso +6 aprovado como achado legítimo. Acontece até com o MESMO operador após refresh.
- **Direção de fix:** ao devolver loc ao pool, deletar (ou marcar invalidadas) as contagens da loc daquela tentativa; ou op2 herdar contagens existentes na tela.
- **Fix:** ✅ 2026-06-11 — `descartarContagensDeLocsDevolvidas` — DELETE das contagens da (sessao,loc) nos 4 pontos de regressão pra pendente (sairParty + 3 do cron), com warn de auditoria; falha aborta a liberação.

---

## 🟠 P1 — Quebra fluxo / corrompe em cenário plausível

### Separação

### ✅ SEP-01 · `estornarMovimentacao` SEMPRE rejeita L de `liberacao_reserva` — recriação de R falha em silêncio em 4 caminhos
- **Onde:** `src/lib/wms/ledger.ts:422-423`; callers afetados: `desfazer-parcial/route.ts:137-150`, `parcial/route.ts:722-735,1740-1753`, `marcar-realocacao/route.ts:227-239`
- **Evidência:** toda L de pick carrega `estorno_de=R.id`; ledger lança "mov já é um estorno". Callers fazem warn-and-continue. Helper correto `estornarLiberacaoReserva` (`reservas-picking.ts:320`) tem ZERO callers.
- **Impacto:** todo desfazer-parcial perde a reserva pra sempre — item volta a "PEGAR" com reservado=0; pedido novo roteia em cima.
- **Direção de fix:** trocar os 4 callers pra `estornarLiberacaoReserva` (ou ensinar `estornarMovimentacao` a aceitar L-de-R).
- **Fix:** ✅ 2026-06-11 — 4 callers trocados pra `estornarLiberacaoReserva`; falhas viram `logger.logError`; links de liberação só deletados após estorno OK.

### ✅ SEP-02 · `bipar-checklist` marca item como pego mesmo com baixa falhando (overselling silencioso)
- **Onde:** `src/app/api/wms/separacao/bipar-checklist/route.ts:167-190`
- **Evidência:** `catch (wmsErr) { logger.warn(...) }` e loop marca TODO item com `quantidade_pega=pedida` sem checar `movSaidaIds[item.id]`. `pickMovPicking` também retorna null silencioso. `marcar-item` já é fail-loud; este ficou pra trás. Agrava: `pickMovPicking` emite L e S em chamadas separadas (não-atômico).
- **Impacto:** peça sai fisicamente sem S no ledger; cutover não acha R.
- **Direção de fix:** replicar o padrão fail-loud do marcar-item (não marcar sem mov confirmada); idealmente migrar pra `wms_pick_item_atomico`.
- **Fix:** ✅ 2026-06-11 — fail-loud no bipar-checklist (mapa `pickFalhas` → item NÃO marcado, 422 com `nao_bipados`). Race double-tap permanece (ver P2-SEP-05).

### ✅ SEP-03 · "Encontrei" legado (validar-oc-item) marca item pego com pick falho — falta o `continue` do caminho de contagem
- **Onde:** `src/app/api/wms/separacao/validar-oc-item/route.ts:671-676` (vs ramo correto 423-437)
- **Evidência:** ramo cobre_total tem `continue` com comentário "Falha de pick NÃO deve marcar o item como pego"; caminho legado só faz `logger.warn` e cai no update compartilhado (680-696).
- **Impacto:** item sai do balde OC como "pego", saldo nunca debitado.
- **Fix:** ✅ 2026-06-11 — caminho legado ganhou `continue` + backstop `!jaPicado && !movSaidaId`; 422 `falha_baixa_estoque` quando todos falham; `itens_nao_validados` na resposta.

### ✅ SEP-04 · Parcial: liberações de R commitam ANTES do RPC; falha do RPC não reverte
- **Onde:** `src/app/api/wms/separacao/parcial/route.ts:317-360 → 380-408`
- **Evidência:** passo 7a emite L por pedido (commits individuais); passo 7b chama `wms_pick_parcial_atomico`; em erro retorna 409 sem estornar nenhuma L.
- **Impacto:** wave de 3 pedidos (R 2+3+5), RPC falha → 10 un de reserva liberadas permanentemente → overselling.
- **Direção de fix:** mover a liberação pra dentro do RPC, ou compensar as L no caminho de erro (com `estornarLiberacaoReserva` — depende de SEP-01).
- **Fix:** ✅ 2026-06-11 — compensação no caminho de erro do RPC (re-reserva via `estornarLiberacaoReserva`); falha de compensação → `logger.logError` + 409 com `reservas_nao_recriadas`.

### ✅ SEP-05 · Parcial modo realocação: libera 100% da R cascade de todos os pedidos (mesmo picked=0) e não re-reserva residual
- **Onde:** `src/app/api/wms/separacao/parcial/route.ts:1323-1370 + 1800-1804`
- **Evidência:** modo item tem guard `if (!loc_zerou && alloc.picked === 0) continue` (linha 324) e re-reserva residual (822-841); modo realocação não tem nenhum dos dois. Fix #50144/#50189 só foi aplicado no modo item.
- **Impacto:** realoc de 2 pedidos (R 3+4), pega 3, !loc_zerou → 7 un liberadas, S de 3, residual 4 sem reserva.
- **Fix:** ✅ 2026-06-11 — guard `picked===0` + re-reserva residual portados pro modo realocação (FCFS antecipado, `criarReservaCascade` TTL 30d).

### ✅ SEP-06 · Voltar-etapa: reset roda ANTES do reverter-cutover → RPC pula S estornadas → recria 0 reservas
- **Onde:** `src/app/api/wms/separacao/voltar-etapa/route.ts:175 vs 263` + `src/lib/separacao/reset-state.ts:112-126` + `supabase/migrations/20260608b_rpc_reverter_cutover_atomico.sql` (filtro NOT EXISTS)
- **Evidência:** `resetarEstadoSeparacaoItens` (linha 175) estorna as S; `reverterCutoverSeRetrocedeu` (linha 263) roda depois e a RPC só recria R pras S que ELA estorna — não sobra nenhuma. Mesmo leak em `/reiniciar` (etapa separacao). Correlato anotado em erros-conhecidos (~linha 1316) como pendente.
- **Impacto:** pedido volta pra `aguardando_separacao` com 0 R; pedido novo rouba o saldo; re-pick leva 409.
- **Direção de fix:** inverter ordem (reverter-cutover antes do reset) ou reset-state recriar R das S que estornar.
- **Fix:** ✅ 2026-06-11 — reset-state ganhou opt-in `recriarReservas` (ressuscita R via `estornarLiberacaoReserva` + estorna cascade residual); voltar-etapa e reiniciar passam true. Ordem mantida — inversão era insuficiente (S de realocação escapam da RPC).

### ✅ SEP-07 · Reverter cutover não cancela job `lancar_estoque_pos_nf` pendente + worker sem gate de status forward → baixa dupla
- **Onde:** `src/lib/wms/cutover.ts:166-219` + `src/lib/execution-worker-wms.ts:35-213`
- **Evidência:** `reverterCutoverSeRetrocedeu` não toca `siso_fila_execucao`; `executarEstoquePosNfWms` não checa `status_separacao` — converte qualquer R viva em L+S e seta `estoque_lancado=true`.
- **Impacto:** job stale converte R recriada (pós-desmarcar) em S fantasma; re-marcar gera OUTRA S → saldo -10 pra pick de 5.
- **Direção de fix:** reverter cutover cancela jobs pendentes do pedido + worker re-checa status forward antes de converter.
- **Fix:** ✅ 2026-06-11 — reverter cancela jobs pos_nf pendentes do pedido; `executarEstoquePosNfWms` ganhou gate de status {aguardando_nf, separado, embalado, expedido} + não-cancelado → no-op warn, job concluido.

### ✅ SEP-08 · UI "Mover etapa" oferece transições que a API sempre rejeita (`aguardando_compra` fora do STATUS_ORDER)
- **Onde:** `src/app/wms/separacao/page.tsx:179-230` vs `voltar-etapa/route.ts:21-29,55-85`
- **Evidência:** MOVE_TARGETS oferece back/forward envolvendo `aguardando_compra`; STATUS_ORDER não contém → 400 sempre (target inválido OU currentIdx=-1).
- **Impacto:** botões mortos nas tabs "Aguard. OC" / "Aguard. Separação".
- **Direção de fix:** decidir — incluir `aguardando_compra` no STATUS_ORDER (com semântica de limpeza de compra) OU remover as opções da UI.
- **Fix:** ✅ 2026-06-11 — `aguardando_compra` removido dos MOVE_TARGETS (UI); botão não renderiza na tab Aguard. OC; API intocada.

### Compras

### ✅ CMP-01 · Compra parcial (comprada < solicitada) = dead-end permanente — e o default da UI produz isso
- **Onde:** `src/app/api/wms/compras/comprar/route.ts:139,175-186` + `receber-oc.ts:347` + `compras-release.ts:65-68`
- **Evidência:** comprar marca `compra_quantidade_comprada=min(...)` mas nunca ajusta `compra_quantidade_solicitada`; flip pra 'recebido' e release usam SOLICITADA; reconciliador só pega `oc_pendente/aguardando_compra` — item 'comprado' nunca reconcilia.
- **Impacto:** pedido pede 10, UI sugere necessidade líquida 6, fornecedor entrega 6 → item preso 'comprado' pra sempre; OC mostra "4 pendentes" eternamente; sem botão pra destravar.
- **Direção de fix:** ao comprar parcial, ajustar `compra_quantidade_solicitada` pro comprado (e devolver o resto pro ciclo de necessidade) OU permitir flip/recebimento por quantidade comprada + caminho de encerrar saldo de OC.
- **Fix:** ✅ 2026-06-11 — comprar ajusta `compra_quantidade_solicitada=comprada` quando parcial + audit em `detalhes.ajustes_solicitada`; necessidade viva re-expõe o restante.

### ✅ CMP-02 · ⚠️ MUDANÇA NÃO COMMITADA: repoint de `separacao_galpao_id` sem guarda de status sequestra pedido em separação ativa
- **Onde:** `src/app/api/wms/compras/comprar/route.ts:206-211,227-250`
- **Evidência:** UPDATE batch de `separacao_galpao_id` sem filtrar `status_separacao`. `compras-release` faz o mesmo repoint COM guarda (linhas 101-105, só aguardando_compra/comprado). Pedidos mistos com item OC continuam na wave.
- **Impacto:** pedido misto sendo separado em CWB flipa pra SP no meio do pick; some da lista de CWB; item pickado fica na bancada.
- **Sub-achado (P2):** `pedidosGalpao.set()` é last-write-wins — pedido multi-SKU comprado pra galpões distintos aponta só pro último; entrada do outro SKU nunca casa no reconciliador (`compras-release.ts:274-282`).
- **Direção de fix:** copiar a guarda de status do compras-release; decidir semântica pro multi-SKU multi-galpão. **Corrigir ANTES de commitar a mudança.**
- **Fix:** ✅ 2026-06-11 — UPDATE batch com guarda `.in(status_separacao, [aguardando_compra, validacao_oc, comprado])`; pulados logados; first-wins por pedido com warn (mitiga P2-CMP-08).

### ✅ CMP-03 · Cross-dock flipa TODOS os pedidos da OC pra 'separado' sem pick
- **Onde:** `src/lib/wms/crossdock-trigger.ts:74-99` + `src/lib/compras-embalagem.ts:101-179`
- **Evidência:** trigger monta `pedidosSeparados` (filtro todosRecebidos) e DESCARTA — chama `prepararPedidosDasOcsParaEmbalagem({ordemCompraIds})` que re-deriva todos os pedidos packable da OC e marca `separacao_marcado=true` sem mov S.
- **Impacto:** pedido A (recebido dia 1, peça já no picking esperando pick real) vira 'separado' quando o cross-dock do pedido B confirma; embalagem embala fantasma; cutover deduz estoque que segue na prateleira.
- **Direção de fix:** passar a lista filtrada de pedidos pro preparar (ou filtrar dentro da lib).
- **Fix:** ✅ 2026-06-11 — `prepararPedidosDasOcsParaEmbalagem` ganhou param `pedidoIds`; trigger passa `pedidosSeparados` filtrado; outro caller preservado.

### ✅ CMP-04 · trocar-sku grava tiny_produto_id da PRIMEIRA empresa do grupo, não da empresa_origem de cada pedido
- **Onde:** `src/app/api/wms/compras/trocar-sku/route.ts:118-143,186-195`
- **Evidência:** loop seta `novoProdutoId` da primeira empresa que retorna o produto; UPDATE `.in("id", itemIds)` aplica o mesmo id a itens de pedidos com empresas diferentes. Viola gotcha #1.
- **Impacto:** recebimento da OC não resolve mapping → throw → rollback all-items → OC irrecebível.
- **Direção de fix:** resolver tiny id POR pedido (empresa_origem_id de cada item).
- **Fix:** ✅ 2026-06-11 — resolução por `empresa_origem_id` de cada pedido via catálogo WMS (1 UPDATE/empresa); fail-loud com `itens_nao_trocados` + toast warning; lookup via API Tiny removido (dead code).

### Estoque / Guarda

### ✅ EST-01 · Guarda parcial em 2+ locs QUEBRADA: 2ª confirmação (e cancelar pós-parcial) estoura `uq_mov_estorno_unico`
- **Onde:** `supabase/migrations/20260609b_guarda_confirmar_valida_saldo_livre.sql:163` (+ `20260609...sql:589`, índice em `20260608_uq_mov_estorno_unico_exclui_parcial.sql:29`)
- **Evidência:** L `liberacao_guarda` insere `p_estorno_de := v_r.id` sem marcar `origem_detalhes.parcial='true'` → 2º L na mesma R = 23505 → 500. Rota `/wms/guarda/rota` inicia guarda on-mount, então reserva forte quase sempre existe.
- **Impacto:** pendência de 10: guarda 4 no picking ok; guardar 6 no overstock → 500. Cancelar também falha.
- **Direção de fix:** marcar os L de liberação parcial com `origem_detalhes.parcial='true'` (mesma convenção do índice).
- **Fix:** ✅ 2026-06-11 — migration `20260611g` — L `liberacao_guarda` com `origem_detalhes.parcial=true` em confirmar+cancelar (proteção double-release vem da própria RPC). Aplicada no staging.

### ✅ EST-02 · AjusteModal global (⌘K/drawer) não envia `motivo_categoria` → 100% dos ajustes rejeitados
- **Onde:** `src/components/wms/ui/modals.tsx:554-566` vs `src/app/api/wms/ajuste/route.ts:73-86`
- **Evidência:** body sem `motivo_categoria` e sem campo no form; API 400 obrigatório desde 2026-05-27.
- **Impacto:** caminho mais acessível de ajuste morto; só a página `/wms/ajuste` funciona.
- **Direção de fix:** adicionar select de categoria no modal.
- **Fix:** ✅ 2026-06-11 — select de categoria no AjusteModal (mesmas 6 categorias da página /wms/ajuste), body + validação client.

### ✅ EST-03 · Cron de reservas expiradas pode liberar a MESMA R duas vezes (rouba reservado de outro pedido)
- **Onde:** `src/lib/wms/reservas.ts:285-292` (guard) × `reservas.ts:210-224` (`estornarReservaIndividual` insere L sem `origem_id`)
- **Evidência:** cron decide "já liberada?" buscando L por `origem_id=pedido_id` — não enxerga L individual nem checa `estorno_de` da R; R liberada continua com `expira_em` no passado e é re-selecionada.
- **Impacto:** double-release rouba reservado de outro pedido da mesma tripla; inverso: 1 L qualquer faz o cron pular Rs legítimas (zumbi eterno).
- **Direção de fix:** guard por `estorno_de=R.id` (existe L apontando pra esta R?) em vez de origem_id.
- **Fix:** ✅ 2026-06-11 — guard do cron por `estorno_de` em batch + compat-legado pra L antigas sem estorno_de; `estornarReservaIndividual` grava origem_id/pedido_id; cron grava estorno_de. Mata também o N+1 (P3-18 parcial).

### Costuras

### ✅ CST-01 · Roteamento conta saldo de QUARENTENA/recebimento/packing/expedição como vendável e RESERVA lá
- **Onde:** `src/lib/wms/roteamento.ts:236-267` + `src/lib/wms/sugestao-dinamica.ts:131-159` + `src/lib/webhook-processor-wms.ts:386-391` (contraste: `reconciliador-oc.ts:142-159` conta SÓ picking)
- **Evidência:** buscarLinha prefere picking (sort) mas não EXCLUI nenhum tipo de loc; R do pedido é criada na loc retornada. Sistema tem duas definições de "vendável".
- **Impacto:** devolução avariada na quarentena → pedido roteia propria, auto-aprova, checklist manda pegar peça avariada e expedir. Maior achado estrutural da auditoria.
- **Direção de fix:** definir tipos vendáveis (picking+overstock?) e aplicar em roteamento + sugestão + criação de R; alinhar com reconciliador.
- **Fix:** ✅ 2026-06-11 — `TIPOS_LOC_VENDAVEIS = [picking, overstock]` aplicado em roteamento, sugestão dinâmica e aprovar (R + gate OC). Fallback de loc do pick deliberadamente sem filtro (saída física pós-fato).

### ✅ CST-02 · Cancelamento via webhook/polling NÃO estorna picks nem gera devolução manual
- **Onde:** `src/lib/pedido-cancel-handler.ts:44-79` (contraste: `separacao/cancelar/route.ts:55-80` + `vendas-cancelamento.ts:69-123` tratam)
- **Evidência:** handler libera R e marca cancelado — não estorna `mov_saida_id`, não cria pendência de devolução, não alerta.
- **Impacto:** pedido com 4/6 itens picados cancelado no Tiny → peças voltam pra prateleira sem registro. Ledger 10, prateleira 14. Mesmo vazamento em separado/embalado (S do cutover ficam de pé).
- **Direção de fix:** reusar a classificação do caminho humano (itensParaDevolverManual) + superfície de exceção.
- **Fix:** ✅ 2026-06-11 — webhook espelha o caminho humano (D1/P007): S preservada como auditoria, `registrarEvento` com `itens_devolucao_manual` + tag `cancelado_com_picks` em separacao_tags.

### ✅ CST-03 · Cancelamento não limpa fluxo de compras quando pedido está em `validacao_oc`/`em_separacao`
- **Onde:** `src/lib/pedido-cancel-handler.ts:90-92` × `compras/route.ts:341-343,195-207`
- **Evidência:** gate `isInComprasFlow` só cobre aguardando_compra/comprado; listagem de compras consulta por compra_status sem filtrar status do pedido.
- **Impacto:** comprador compra pra pedido morto; recebimento falha release; estoque vira sobra não-intencional.
- **Fix:** ✅ 2026-06-11 — limpeza por ITEM (compra_status ativo: oc_pendente/aguardando_compra/comprado/indisponivel/equivalente_pendente/cancelamento_pendente) em vez de gate por status do pedido; recebido/cancelado preservados; OC órfã cancelada.

### Inventário

### ✅ INV-01 · Re-aplicar sessão após estorno SEMPRE falha (23505 em `uniq_movs_inventario_divergencia`)
- **Onde:** `supabase/migrations/20260527_p3_movs_unique_inventario_divergencia.sql` + `20260607_rpc_aplicar_sessao_inventario.sql:74` + `estornarSessaoInventario` em `inventario.ts`
- **Evidência:** estorno reseta divergência pra 'pendente' com MESMO id; mov original fica no ledger (contra-mov é 'estorno', fora do predicado do índice); re-aplicar insere mov com mesmo divergencia_id → unique violation → rollback total. Modal da UI promete exatamente esse fluxo.
- **Impacto:** sessão presa oscilando revisao↔aprovada; única saída é cancelar (perde contagem) ou SQL.
- **Direção de fix:** índice considerar estorno (excluir movs estornadas do predicado) OU re-aplicação gerar novo divergencia_id/idempotency.
- **Fix:** ✅ 2026-06-11 — migration `20260611e` — coluna `aplicacoes` (geração) + índice por (divergencia_id, geração) + RPCs gravam/bumpam; count idempotente exclui estornadas. Aplicada no staging.

### ✅ INV-02 · Aplicar que falha em 1 divergência deixa sessão presa em 'aprovada' sem caminho de recuperação
- **Onde:** `20260607_rpc_aplicar_sessao_inventario.sql:65-78` + `[id]/divergencias/route.ts:714` + `inventario.ts:711-728` + `[id]/page.tsx:288`
- **Evidência:** aplicar é tudo-ou-nada; divergência culpada está 'aprovada' — PATCH só atualiza 'pendente'; computar tem guard no-op; UI só mostra "Cancelar" em planejada/em_andamento.
- **Impacto:** pick consome saldo entre aprovação e aplicação → "saldo insuficiente" → pra sempre.
- **Direção de fix:** permitir rejeitar/repender divergência aprovada (e/ou clamp/skip com relatório no aplicar).
- **Fix:** ✅ 2026-06-11 — PATCH aceita aprovada→rejeitada (sessão 'aprovada', `inventario.supervisionar`) + botão na UI + RPC nomeia divergência culpada + extração correta de message de PostgrestError.

### ✅ INV-03 · Sessão contínua listada com "Encerrar contagem" — encerrá-la re-aplica acertos inline históricos como ganho falso
- **Onde:** `src/lib/wms/contagem-inline.ts:49-89` + GET `/api/wms/inventario` (sem filtro `continua`) + `computarDivergencias` sem guard `continua=true`
- **Evidência:** contagens inline acumulam 1 INSERT por evento; movs de acerto são excluídas da reconstrução como "movs da própria sessão" → agregado soma acertos já aplicados.
- **Impacto:** acertos de maio+junho viram ganho falso pendente → aprovado → fantasma.
- **Direção de fix:** guard `continua=true` em computar/encerrar + esconder/rotular a sessão na lista.
- **Fix:** ✅ 2026-06-11 — guard hard `continua=true` em computarDivergencias + GET da lista filtra `.eq(continua,false)`.

### ✅ INV-04 · Perda de inventário abaixo do reservado vivo estoura CHECK(reservado<=saldo) com erro críptico
- **Onde:** `20260607c_inserir_mov_idempotency_param.sql:81-83` + `20260605_rpc_contagem_inline_atomica.sql:45-65` + `20260607_rpc_aplicar_sessao_inventario.sql:66` + `validar-oc-item/route.ts:274-287`
- **Evidência:** branch S só valida `saldo_posterior >= 0`; UPDATE do cache viola CHECK → 23514 cru → 500 genérico (inline) ou sessão presa (aplicar, vide INV-02).
- **Impacto:** loc saldo 10/reservado 8, conta 5 → trava sem orientação.
- **Direção de fix:** clampar/realocar R antes do S (padrão do `wms_desmarcar_item_atomico`) ou erro orientado ("libere reservas primeiro").
- **Fix:** ✅ 2026-06-11 — migration `20260611f` — pré-check reservado nas RPCs de inventário com RAISE orientado; caller mapeia 409 `contagem_bloqueada_reserva`. Branch S universal não alterado. Aplicada no staging.

---

## 🟡 P2 — Bugs reais, raros ou contornáveis

### Compras
- ✅ **P2-CMP-01** · Race no recebimento OC: caminho perdedor não estorna mov 'achado' nem cancela pendências de guarda já criadas; rollback all-items idem — `receber-oc.ts:237-261,364-383,415-452`
  - **Fix:** ✅ 2026-06-11 (Opus) — race-loser/rollback agora cancelam pendências (RPC cancelar) e estornam mov 'achado' — receber-oc.ts
- ✅ **P2-CMP-02** · SELECT de fechamento falho → `(data ?? []).every()`=true → OC marcada 'recebido' com itens pendentes — `receber-oc.ts:455-471`
  - **Fix:** ✅ 2026-06-11 (Opus) — SELECT de fechamento captura error; em erro NÃO fecha a OC
- ✅ **P2-CMP-03** · Cancelar pedido OC busca movs por `origem_id=pedidoId` mas caminho rico grava `origem_id=ocId` → 0 estornos silenciosos — `compras/pedidos/[pedidoId]/cancelar/route.ts:86-90` vs `receber-oc.ts:217`
  - **Fix:** ✅ 2026-06-11 (Opus) — estorno busca também origem_detalhes->>pedido_id (caminho rico), dedup por id
- ✅ **P2-CMP-04** · `liberarReserva({pedido_id})` derruba R de TODOS os itens do pedido, não só do cancelado/trocado — `itens/[itemId]/cancelamento/confirmar:86` + `equivalente/confirmar:135`
  - **Fix:** ✅ 2026-06-11 (Opus) — liberação escopada ao produto do item (resolve uuid via gotcha #1, estornarReservaIndividual por R)
- ✅ **P2-CMP-05** · Operador de doca vê compra manual na fila mas leva 403 ao abrir (rotas exigem `compras.executar`; fluxo OC aceita `operacoes.receber`) — `compras-manuais/[id]/route.ts:13` + `[id]/receber/route.ts:13`
  - **Fix:** ✅ 2026-06-11 (Opus) — GET detalhe + POST receber aceitam userCanAny(compras.executar, operacoes.receber)
- ✅ **P2-CMP-06** · `devolver` sem guarda de compra_status — reseta item já 'recebido'/pickado, zera `mov_saida_id` sem estorno → risco de dedução dupla — `itens/[itemId]/devolver/route.ts:44-58`
  - **Fix:** ✅ 2026-06-11 (Opus) — guards 409 item_ja_recebido / item_com_pick antes do reset
- ✅ **P2-CMP-07** · Coluna DEPRECADA `siso_empresas.galpao_id` em `ordens` (400 em galpão não-preferencial) e `equivalente/confirmar` — `ordens/route.ts:51-65` + `equivalente/confirmar:80-96`
  - **Fix:** ✅ 2026-06-11 (Opus) — ordens resolve empresas via preferenciais (fallback todas ativas); equivalente/confirmar deriva galpão de pedido.separacao_galpao_id → preferencial → 400
- ✅ **P2-CMP-08** · Last-write-wins no repoint multi-SKU multi-galpão — mitigado 2026-06-11 junto com CMP-02 (first-wins determinístico por pedido + warn explícito em escolha conflitante)

### Separação
- ✅ **P2-SEP-01** · `produto-esgotado` sem filtro de galpão — derruba pedidos em separação de TODOS os galpões — `produto-esgotado/route.ts:64-100`
  - **Fix:** ✅ 2026-06-11 (Opus) — galpão obrigatório (body ?? session.galpaoId, 400 sem) + filtro separacao_galpao_id
- ✅ **P2-SEP-02** · Esgotado→OC calcula residual com qty_pega ANTES do reset estornar o pick → OC compra menos + drift físico×ledger — `produto-esgotado:287-340 → 361-378`
  - **Fix:** ✅ 2026-06-11 (Opus) — residual calculado APÓS o reset (re-fetch) = necessidade cheia; evento com qty_estornada_pick + instrução de devolver
- ✅ **P2-SEP-03** · `desfazer-parcial` ignora erro da RPC de estorno parcial → deleta link e decrementa qty_pega com S viva, sem rastro — `desfazer-parcial/route.ts:93-107`
  - **Fix:** ✅ 2026-06-11 (Opus) — erro da RPC → 409 falha_estorno_parcial sem deletar link nem decrementar qty_pega
- ✅ **P2-SEP-04** · `encaminhar` reseta pedido pra pendente ANTES de estornar S — falha deixa pedido re-roteável com S vivas no galpão antigo — `encaminhar/route.ts:149-215`
  - **Fix:** ✅ 2026-06-11 (Opus) — reset (estorno S) ANTES do UPDATE pra pendente; falha → pedido intacto em falhas[]
- ✅ **P2-SEP-05** · `idempotency_key` do marcar-item (P072) nunca enviada pela UI — ramo sem-reserva desprotegido contra double-pick concorrente — `checklist/page.tsx:406-413`
  - **Fix:** ✅ 2026-06-11 (Opus) — checklist envia idempotency_key (crypto.randomUUID) por item por clique
- ✅ **P2-SEP-06** · Concluir responde "separados" sem checar se o UPDATE `.eq(em_separacao)` pegou — pedido em aguardando_separacao com tudo marcado fica preso com toast de sucesso — `concluir/route.ts:267-275`
  - **Fix:** ✅ 2026-06-11 (Opus) — claim .in([em_separacao, aguardando_separacao]) + .select(id); nao_concluidos na resposta + toast warn
- ✅ **P2-SEP-08** · (novo, achado durante o fix do SEP-04) Parcial modo realocação: se o `inserirMovimentacao` da S (~linha 1467) lança, o catch externo retorna 500 sem compensar as L do 7a — análogo do SEP-04 no outro modo — `parcial/route.ts`
  - **Fix:** ✅ 2026-06-11 (Opus) — S do modo realocação com compensação das L do 7a (helper espelhado) → 409 em vez de 500
- ✅ **P2-SEP-07** · `expedido` é beco sem saída — nenhuma rota reverte — `voltar-etapa:21-29` + `expedir:114-119`
  - **Fix:** ✅ 2026-06-11 (Opus) — 'expedido' no STATUS_ORDER (hop expedido→embalado só status; reset não dispara; sem tab na UI — rota only)

### Inventário
- ✅ **P2-INV-01** · `registrarContagemSimples` check-then-act sem UNIQUE no banco (JSDoc mente) → row dupla trava a tripla pro operador — `inventario.ts:597-641`
  - **Fix:** ✅ 2026-06-11 (Opus) — migration 20260611h: dedup + UNIQUE(sessao,loc,produto,operador) + RPC inline vira upsert incremental; TS trata 23505 com update
- ✅ **P2-INV-02** · 23505 do INSERT em lote de locks ENGOLIDO → sessão inicia com ZERO locks; `aprovarSessao` libera lock por localizacao_id sem distinguir dono — `inventario.ts:180-186 + 1010-1023`
  - **Fix:** ✅ 2026-06-11 (Opus) — 23505 do lote → fallback um-a-um, conflito → rollback + 409 locs_bloqueadas; release escopado por iniciado_em>=sessão (tabela não tem coluna de dono — limitação documentada)
- ✅ **P2-INV-03** · Encerrar com operador ativo: backend aceita `force` + retorna lista, UI nunca envia e mostra jargão de API no toast — `[id]/page.tsx:140-170` vs `aprovar/route.ts:796-812`
  - **Fix:** ✅ 2026-06-11 (Opus) — modal lista operadores + 'Encerrar mesmo assim' → re-mutate com force
- ✅ **P2-INV-04** · Botão "Aplicar no estoque" gated em `inventario.supervisionar`, rota exige `requireAdmin` → 403 garantido pra supervisor não-admin — `[id]/page.tsx:462-471` vs `aplicar/route.ts:890`
  - **Fix:** ✅ 2026-06-11 (Opus) — rota aplicar exige inventario.supervisionar (era requireAdmin)
- ✅ **P2-INV-05** · "Solicitar contagem depois" é no-op se a loc já teve acerto inline (status 'contada' nunca volta pra 'pendente') — `contagem-inline.ts:9-23` (quebra o tradeoff documentado no erro #106)
  - **Fix:** ✅ 2026-06-11 (Opus) — enfileirar reabre loc 'contada' → 'pendente'
- ✅ **P2-INV-06** · Bipe de kit expande componentes em loop sem transação — falha no meio + retry duplica contagem — `inventario.ts:571-592`
  - **Fix:** ✅ 2026-06-11 (Opus) — falha no meio do kit → compensa componentes gravados + erro kit_contagem_parcial_revertida
- ✅ **P2-INV-07** · Estorno individual de divergência devolve row pra 'pendente' em sessão 'aplicada' onde aplicar é no-op → re-aplicação impossível (feature morta/armadilha) — `inventario.ts:1122-1163`
  - **Fix:** ✅ 2026-06-11 (Opus) — estorno individual em sessão 'aplicada' reabre pra 'aprovada' (CAS) — re-aplicação possível

### Estoque / Guarda / Transferências
- ✅ **P2-EST-01** · Estorno PARCIAL de entrada de custo restaura custo médio INTEIRO ao pré-entrada (branch P110 sem checar qty) — `20260607c:126-135` × `20260610b_rpc_reconciliar_retroativo.sql:41-52`
  - **Fix:** ✅ 2026-06-11 (Opus) — migration 20260611l: branch P110 distingue estorno total×parcial (remoção ponderada com guards)
- ✅ **P2-EST-02** · Cron de transferências usa usuário uuid-zero (FK pra siso_usuarios inexistente) → todo estorno falha → cron MORTO — `transferencias/cleanup/route.ts:24`
  - **Fix:** ✅ 2026-06-11 (Opus) — migration 20260611m: usuário Sistema uuid-zero (ativo=false, pin impossível) — cron revivido
- ✅ **P2-EST-03** · Mesmo cleanup ignora `mov_entrada_id`/`recebimento_em_andamento_por` → se revivido (fix EST-02), duplica saldo de receber crashado — `cleanup/route.ts:46-66` (⚠️ corrigir JUNTO com P2-EST-02)
  - **Fix:** ✅ 2026-06-11 (Opus) — cleanup substituído por cancelarTransferencia() (estorna E antes de S, respeita claims)
- ✅ **P2-EST-04** · R `reserva_guarda` tem TTL 7d mas NENHUM limpador cobre (cleanup filtra `reserva_pedido`) → pendência abandonada trava disponível pra sempre — `reservas.ts:276` × `20260609...sql:127`
  - **Fix:** ✅ 2026-06-11 (Opus) — cleanup ganha passada reserva_guarda: libera L liberacao_guarda (parcial=true) + regride pendência em_guarda→pendente
- ✅ **P2-EST-05** · `a_guardar` calculado no serviço mas NENHUMA tela usa; `obterPendencia` nem calcula → fix do known-error 'guarda-a-guardar' incompleto — `guarda.ts:331-350` + `guarda/[id]/page.tsx:124,602` + `rota/page.tsx:325`
  - **Fix:** ✅ 2026-06-11 (Opus) — obterPendencia enriquece a_guardar; [id] e rota pré-preenchem/limitam input + hint de picks
- ✅ **P2-EST-06** · `encerrada_sem_saldo` invisível: toast diz "Parcial: faltam N", GET /api/wms/guarda rejeita o status (400), tabs não mostram — `guarda/[id]/page.tsx:211-215` + `api/wms/guarda/route.ts:7-12`
  - **Fix:** ✅ 2026-06-11 (Opus) — status em STATUS_VALIDOS + tab 'Sem saldo' + toast correto no auto-encerrar (auto_encerrada propagado)
- ✅ **P2-EST-07** · Desfazer guarda seleciona movs E candidates por produto+galpão sem vínculo com a pendência → pode desfazer guarda/replenishment de OUTRA — `20260609...sql:397-408`
  - **Fix:** ✅ 2026-06-11 (Opus) — migration 20260611n: confirmar carimba pendencia_id no par S+E (replenishment ganhou p_origem_detalhes); desfazer filtra por vínculo (fallback legado com NOTICE)
- ✅ **P2-EST-08** · Liveness da R de guarda testa `estorno_de IS NULL` na R (sempre true) → R totalmente liberada conta como viva → re-guarda roda SEM reserva forte — `20260609b:267-273` + `20260609:467-472`
  - **Fix:** ✅ 2026-06-11 (Opus) — iniciar testa NET (SUM R − SUM L) > 0; re-guarda pós-liberação total cria R nova (desfazer mantido existence-based — deve re-reservar mesmo com net=0, documentado)
- ✅ **P2-EST-09** · `transferirInterGalpao` não-atômico (S e E separadas sem compensação); ledger aceita loc de galpão errado (tripla fantasma) em transferir-galpao/receber/replenishment — `movimentacoes.ts:302-340` + `transferencias.ts:361-373`
  - **Fix:** ✅ 2026-06-11 (Opus) — perna E falha → estorna a S do item e aborta; receber valida loc (galpão/ativa)
- ✅ **P2-EST-10** · `/wms/estoque` trunca silenciosamente em 500 triplas — SKUs somem da tela — `estoque.ts:45` + `estoque/page.tsx:98`
  - **Fix:** ✅ 2026-06-11 (Opus) — paginação interna .range() 1000/pág (cap 10 págs + warn) — sem truncamento silencioso

### Costuras
- ✅ **P2-CST-01** · E criada dentro de RPC (devolução íntegra `wms_classificar_devolucao`, ganho de `wms_aplicar_sessao_inventario`) NÃO dispara reconciliador-oc — pedido OC fica preso; guarda/confirmar já chama manualmente, devoluções/inventário não — `ledger.ts:267-309` + `devolucoes.ts:228-246`
  - **Fix:** ✅ 2026-06-11 (Opus) — devoluções íntegras + ganhos de inventário disparam reconciliarEntradaEstoque fire-and-forget (padrão guarda/confirmar)
- ✅ **P2-CST-02** · Retry do worker sem motor: job com `proximo_retry_em` futuro só roda no próximo kick orgânico (sem cron; polling Tiny não kicka) → fila congela de madrugada — `execution-worker.ts:826-846`
  - **Fix:** ✅ 2026-06-11 (Opus) — migration 20260611o: pg_cron wms_worker_kick */2min → POST /api/wms/worker/processar (Bearer secret)
- ✅ **P2-CST-03** · Pedido `status='erro'` (job maxed) invisível no quadro-tarefas/exceções da home — só aparece em /wms/pedidos — `execution-worker.ts:243-262` + `dashboard-tarefas.ts:455-545`
  - **Fix:** ✅ 2026-06-11 (Opus) — seção pedidos_erro no montarExcecoes (pedidos status=erro + jobs erro dedup) + card na home
- ✅ **P2-CST-04** · Janela pendência-criada → guarda-iniciada: saldo do RECEBIMENTO roteia pedido NOVO, furando FIFO dos pedidos OC antigos (reconciliador só conta picking) — `roteamento.ts:262-267` (relacionado: CST-01)
  - **Fix:** ✅ 2026-06-11 (Opus) — resolvido como efeito do CST-01 (loc tipo recebimento excluída do roteamento/vendável) — sem trabalho adicional
- ✅ **P2-CST-05** · Cancel só mata jobs 'pendente'; job 'executando' termina de converter R→L+S de pedido cancelado — `pedido-cancel-handler.ts:167-174` + `execution-worker.ts:173-187`
  - **Fix:** ✅ 2026-06-11 (Opus) — pós-conversão re-checa pedido cancelado → estorna S criadas + estoque_lancado=false + evento

---

## ⚪ P3 — Processos burros / dívidas

- ✅ **P3-01** · ⚠️ MINA ARMADA: `validar-oc-item` consulta coluna inexistente `qty_picada` — erro engolido, soma 0 "por acidente correto"; fix ingênuo do nome causaria double-desconto (marcar-realocacao já acumula em quantidade_pega) — `validar-oc-item/route.ts:796-808,1022-1034`. Fix certo: remover a query, documentar.
  - **Fix:** ✅ 2026-06-11 (Opus) — blocos qty_picada removidos; comentário explica double-count; const 0
- ✅ **P3-02** · Histórico de compras exibe `comprado_em` como `recebido_em` — `compras/route.ts:663-720`
  - **Fix:** ✅ 2026-06-11 (Opus) — coluna recebido_em existe mas é dead (nunca populada) — payload/label renomeados pra comprado_em (não mentir)
- ✅ **P3-03** · `flag_saldo_apareceu` nunca zerada (banner eterno) — `varredura-validacao-oc.ts:80`
  - **Fix:** ✅ 2026-06-11 (Opus) — varredura bidirecional: flag_saldo_apareceu = (dispTotal>0), zera quando cobertura some
- ✅ **P3-04** · Seleção/necessidade de compras keyed por SKU global vaza entre fornecedores (risco double-buy) — `compras/page.tsx:608-622` + `compras/route.ts:429-456`
  - **Fix:** ✅ 2026-06-11 (Opus) — chave composta fornecedor::sku na seleção/overrides (necessidade global do backend intocada — limitação documentada)
- ✅ **P3-05** · "Marcar indisponível"/"Propor cancelamento" atingem só `pedidos[0]` — `compras/page.tsx:1243,1281`
  - **Fix:** ✅ 2026-06-11 (Opus) — rotas aceitam item_ids[]; UI envia todos os pedidos do card em 1 request
- ✅ **P3-06** · `findOrCreateOC` sem unique constraint — corrida cria OCs duplicadas — `comprar/route.ts:312-350`
  - **Fix:** ✅ 2026-06-11 (Opus) — migration 20260611p: consolida duplicatas + UNIQUE parcial (fornecedor,galpao) WHERE aguardando_compra; TS trata 23505 com re-select
- ✅ **P3-07** · Caminho legado `/compras/receber` gera E sem pendência de put-away (estoque invisível no dock) — `compras/receber/route.ts:222-267`
  - **Fix:** ✅ 2026-06-11 (Opus) — gravarMovEntradaCompra cria pendência de guarda (estorna E se falhar) — padrão compras-manuais
- ✅ **P3-08** · Modal de confirmação de compra não trata erro do fetch de galpões (botão trava sem explicação) — `compras/page.tsx:1082-1096` (NA MUDANÇA NÃO COMMITADA)
  - **Fix:** ✅ 2026-06-11 (Opus) — isError → mensagem + Tentar de novo (refetch) no modal
- ✅ **P3-09** · Grupo da aba Receber mostra galpão do primeiro doc do fornecedor — `compras-receber-merge.ts:47-57`
  - **Fix:** ✅ 2026-06-11 (Opus) — grupo misto vira 'Vários galpões' + chip de galpão por doc
- ✅ **P3-10** · Gate em `cargo==='admin'` viola convenção RBAC — `receber/transferencia/lista/route.ts:28`
  - **Fix:** ✅ 2026-06-11 (Opus) — cargo==='admin' → userCan(sistema.usuarios)
- ✅ **P3-11** · N+1 em mandar-compras (1 UPDATE/item) e comprar (1 SELECT preferencial/item) — `mandar-compras.ts:50-90` + `comprar:156-191`
  - **Fix:** ✅ 2026-06-11 (Opus) — SELECT preferencial memoizado por empresa (1 query/empresa); mandar-compras intocado
- ✅ **P3-12** · Toggle de linha consolidada do checklist = N POSTs paralelos sem transação; falha de link no parcial retorna 500 com S órfã commitada — `checklist/page.tsx:406-414` + `parcial/route.ts:454-469,1495-1511`
  - **Fix:** ✅ 2026-06-11 (Opus) — (a) toggle sequencial com abort + toast por sku; (b) link falho → estorna S + 409 nos dois modos
- ✅ **P3-13** · Tolerância de inventário: `qty_min` só vale se `pct=0` (if/else em vez de OR); loc zerada → custo 0 → bypassa gate de valor — `inventario.ts:897-907 + 809-813`
  - **Fix:** ✅ 2026-06-11 (Opus) — tolerância vira OR (pct OU qty_min); custo de TODAS as divergências via siso_custo_medio
- ✅ **P3-14** · `computarDivergencias` delete+upsert por divergência (2×N round-trips); crash mid-loop deixa pendente fantasma — `inventario.ts:884-931`
  - **Fix:** ✅ 2026-06-11 (Opus) — delete em lote de pendentes + bulk upsert chunks 200 (mata fantasma pós-crash)
- ✅ **P3-15** · Recovery rouba lock de operador ativo-mas-lento (>30min) → alimenta P0-02; sem nag pra sessões paradas em revisao/aprovada — `inventario-recovery.ts:51-88`
  - **Fix:** ✅ 2026-06-11 (Opus) — recovery checa atividade do operador na sessão (<30min → não rouba lock), 1 query agregada
- ✅ **P3-16** · Métrica "últimas 5000 locs" ordena por uuid aleatório = amostra aleatória — `20260529_wms_metricas.sql`
  - **Fix:** ✅ 2026-06-11 (Opus) — migration 20260611h: métrica ordena por contagem_finalizada_em DESC (era uuid)
- ✅ **P3-17** · `reconciliarEstoqueComLedger` mascara falha da RPC como "0 divergências" — `reconciliacao.ts:24-28`
  - **Fix:** ✅ 2026-06-11 (Opus) — erro da RPC → throw + wmsErrorResponse no caller (era '0 divergências' falso)
- ✅ **P3-18** · Cleanup de reservas re-escaneia TODA a história a cada hora (N+1 crescente) — `reservas.ts:272-292` (relacionado: EST-03)
  - **Fix:** ✅ 2026-06-11 (Opus) — piso temporal 60d nas queries de candidatas do cleanup
- ✅ **P3-19** · `/wms/ledger` sem paginação real (300 fixo, Exportar disabled); drawer pagina por offset em ordem desc (duplica linhas) — `ledger/page.tsx:69` + `produto-drawer.tsx:115`
  - **Fix:** ✅ 2026-06-11 (Opus) — paginação real na page global (offset+count) + keyset cursor no drawer (tupla criado_em,id)
- ✅ **P3-20** · Estorno de ajuste manual: rota existe, nenhum caller na UI — `ajuste/[id]/estornar/route.ts`
  - **Fix:** ✅ 2026-06-11 (Opus) — ação Estornar em movs ajuste_manual no ledger (gated operacoes.ajuste_manual, confirm modal)
- ✅ **P3-21** · `venderKit` sem compensação (código morto hoje — não ressuscitar sem fix) — `ledger.ts:328-398`
  - **Fix:** ✅ 2026-06-11 (Opus) — venderKit compensa S anteriores em ordem reversa + JSDoc 'sem callers'
- ✅ **P3-22** · Contrato divergente no desfazer guarda (UI lê qtyEstornada/statusFinal; API devolve pendencia/movsEstornadas) — `guarda/[id]/page.tsx:236-247`
  - **Fix:** ✅ 2026-06-11 (Opus) — resposta ganha qty_estornada/status_final (additive); UI lê com fallback
- ✅ **P3-23** · `reconciliar` retroativo aceita `compra_mov_id` de QUALQUER mov (sem validar produto/tipo) — trilha de auditoria suja — `lancamento-retroativo/[id]/reconciliar/route.ts:55-80`
  - **Fix:** ✅ 2026-06-11 (Opus) — valida compra_mov: existe, tipo E, mesmo produto, origem nf_compra/retroativo → 400 mov_invalida
- ✅ **P3-24** · `snapshot-inicial` usa coluna deprecada `siso_empresas.galpao_id` — `snapshot-inicial.ts:57`
  - **Fix:** ✅ 2026-06-11 (Opus) — galpão via siso_empresa_galpoes_preferenciais (mais antigo = principal — tabela sem coluna de prioridade); sem preferencial → skip + error
- ✅ **P3-25** · Hook pós-entrada fire-and-forget sem waitUntil — serverless pode congelar antes do reconciliador rodar (fallback durável só cobre ERRO) — `ledger.ts:273-308`
  - **Fix:** ✅ 2026-06-11 (Opus) — job varredura_pos_entrada enfileirado SEMPRE (dedup por payload) — backstop pra freeze serverless
- ✅ **P3-26** · Reconciliador ignora `siso_localizacao_locks` — cria R em loc sendo inventariada — `reconciliador-oc.ts:163-175`
  - **Fix:** ✅ 2026-06-11 (Opus) — melhorLocPicking exclui locs com lock ativo (padrão roteamento)
- ✅ **P3-27** · Receber transferência aceita loc tipo 'recebimento' sem criar pendência de guarda (OC/manual/avulso validam; transferência não) — `transferencias.ts:356-381`
  - **Fix:** ✅ 2026-06-11 (Opus) — receber transferência rejeita destino recebimento/quarentena/packing/expedicao
- ✅ **P3-28** · Comentários/JSDoc stale induzindo erro: tabelas dropadas citadas, UNIQUE de contagens inexistente (já induziu P2-INV-01), "5 slots de operador" — `types/index.ts:420,445` + `inventario.ts:504` + `inventario/page.tsx:59`
  - **Fix:** ✅ 2026-06-11 (Opus) — JSDoc/labels corrigidos (tabelas dropadas, '5 slots' → party dinâmica)

---

## Verificado e OK (cobertura da auditoria — não retrabalhar)

- Ledger core: zero writes diretos em `siso_estoque`/`siso_movimentacoes` fora das RPCs em todo `src/`; `wms_inserir_movimentacao` (20260607c) com FOR UPDATE, validações E/S/R/L, idempotency, guard custo-zero.
- `wms_pick_item_atomico` (ramo com reserva), `wms_desmarcar_item_atomico` (idempotente, clamp D4), `wms_reverter_cutover_atomico` (tudo-ou-nada — correto quando chamado SEM reset prévio), claim 2-pass do parcial, `wms_aplicar_sessao_inventario` (delta relativo, comutativo com movs legítimas), `wms_contagem_inline_atomica`, `wms_inventario_proxima_loc` (SKIP LOCKED), reconciliador-oc (claim CAS, FIFO, retry durável), compras-release (idempotência uq_fila_release_pedido), `wms_desfazer_recebimento_transferencia`, cancelarTransferencia, auto-encerrar da guarda (trigger saldo=0 correto).
- Tiny: `runWithEmpresa` presente em todas as chamadas auditadas. Logging: zero `console.*` no escopo.
- Transferência inter-galpão × pedidos: pedido 'transferencia' separa/expede DO galpão coberto — não há "chegada a ligar" (premissa antiga não se aplica).
- Mudança não-commitada (galpão+preço na compra): funcionalmente completa exceto CMP-02, P2-CMP-08 e P3-08.
