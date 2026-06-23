# Auditoria Adversarial Estática — Módulo Separação + Estoque (SISO WMS)

> Consolidação dos vereditos de 22 hipóteses de bug analisadas por leitura de código-fonte (sem execução). Cada veredito foi checado contra o código real, migrations e cenários do harness.

---

## 1. Sumário Executivo

**Por veredito:**

| Veredito | Qtd | IDs |
|---|---|---|
| **Confirmado** | 5 | BUG-02, BUG-06, BUG-07, BUG-09, BUG-12 |
| **Parcial** | 11 | BUG-A, BUG-01, BUG-03, BUG-05, BUG-08, BUG-10, BUG-11, BUG-13, BUG-14, BUG-15, BUG-17 |
| **Refutado** | 6 | BUG-B, BUG-04, BUG-16, BUG-18, BUG-19, BUG-20 |
| **Total** | **22** | |

> Nenhum veredito ficou no estado puro "precisa repro ao vivo". O único item com passos de reprodução ao vivo anexados é **BUG-10** (classificado como *parcial*, mas o sub-caminho mais grave só se prova com banco vivo).

**Por severidade (todos os 22):**

| Severidade | Qtd | IDs |
|---|---|---|
| **Alta** | 5 | BUG-02, BUG-06, BUG-09, BUG-12, BUG-10 |
| **Média** | 7 | BUG-03, BUG-05, BUG-07, BUG-08, BUG-11, BUG-13, BUG-14, BUG-15 |
| **Baixa** | 6 | BUG-A, BUG-01, BUG-16, BUG-17, BUG-B |
| **N/A** (refutados) | 4 | BUG-04, BUG-18, BUG-19, BUG-20 |

**Severidade considerando só os que têm dano real (confirmados + parciais):**

| Severidade | Qtd | IDs |
|---|---|---|
| **Alta** | 5 | BUG-02, BUG-06, BUG-09, BUG-10, BUG-12 |
| **Média** | 7 | BUG-03, BUG-05, BUG-07, BUG-08, BUG-11, BUG-13, BUG-14, BUG-15 |
| **Baixa** | 4 | BUG-A, BUG-01, BUG-17 (+ BUG-B refutado mas vivo) |

**Estado geral:** O ledger de estoque tem proteções fortes nas **escritas atômicas centrais** (`wms_inserir_movimentacao` com `FOR UPDATE` + CHECKs de coerência, `wms_pick_item_atomico`, `wms_pick_parcial_atomico`) — por isso 6 hipóteses de corrupção foram **refutadas** com guard concreto. O risco residual real está concentrado em **caminhos não-migrados pra RPC atômica** (`pickMovPicking` via `bipar-checklist`/`validar-oc-item`) e em **retrocessos/compensações best-effort** (`reverter-cutover`, liberação de R em `encaminhar`/`cancelar`/`parcial`) que falham com `logger.warn` em vez de fail-loud. Há **5 confirmados** com caminho de overselling/baixa-dupla/vazamento alcançável; 3 deles são de **severidade alta** e devem ser priorizados.

---

## 2. Confirmados (prioridade)

| ID | Título | Sev | Reachable | Conf. | Evidência curta | Onde corrigir |
|---|---|---|---|---|---|---|
| **BUG-02** | reverter-cutover não estorna S de realocação (cascade) | **alta** | sim | high | `marcar-realocacao/route.ts:123-144` insere S sem `origem_id`; `mov_saida_id` vai p/ `siso_pedido_item_realocacoes` (não `siso_pedido_itens`) → RPC `20260608b:23-32` não pega por nenhum dos 2 caminhos | Passar `origem_id=pedido_id` na S de realocação (`marcar-realocacao`, `parcial:1612-1636`, `pick-mov.ts:198-214`) **ou** 3º caminho no cursor da RPC `wms_reverter_cutover_atomico` |
| **BUG-06** | double-tap no scanner (bipar-checklist) → overselling | **alta** | sim | medium | TOCTOU: `bipar-checklist/route.ts:170-231` guard `if(item.mov_saida_id) continue` lê snapshot pré-pick, sem lock; `pickMovPicking` não tem `FOR UPDATE`/`v_ja_liberada` (vs `wms_pick_item_atomico`). Documentado em `erros-conhecidos.yaml:4839` | Migrar `bipar-checklist` p/ `wms_pick_item_atomico`, **ou** claim atômico `UPDATE ... WHERE mov_saida_id IS NULL RETURNING` antes do pick |
| **BUG-09** | idempotência do parcial (ramo residual loc_zerou=false) | **alta** | sim | high | `wms_pick_parcial_atomico` (`20260607e:6-37`) não aceita `p_idempotency_key`; `wms_acumular_qty_pega` é UPDATE-soma; ramo residual deixa item aberto (`marcado=false`) → replay passa o guard `route.ts:138-146` → 2ª S + qty inflada | Idempotency key no endpoint `/separacao/parcial` (ramo residual) **ou** propagar `p_idempotency_key` pela RPC + tornar `wms_acumular_qty_pega` idempotente |
| **BUG-12** | cancelar pós-pick → vazamento silencioso | **alta** | sim | high | `cancelar/route.ts:56-125` e `pedido-cancel-handler.ts:140-176` NÃO estornam S do pego; viram só payload/tag `cancelado_com_picks`; nenhum leitor/sweeper (grep = 0 consumidores); `dashboard-tarefas.ts:491-498` só lê `siso_devolucoes_pendentes` | Inserir pendência forte em `siso_devolucoes_pendentes` no cancelamento com pegos, **ou** fonte de exceção em `montarExcecoes` p/ `cancelado_com_picks` |
| **BUG-07** | pickMovPicking: L commita e S falha (par não-atômico) | **média** | sim | high | `pick-mov.ts:170` (L) e `:198` (S) são 2 RPCs/2 tx; docstring `:38-41` admite. L órfã → `disponivel` sobe → janela de overselling. Só `bipar-checklist` + `validar-oc-item` (caminho principal usa RPC atômica) | Migrar `pickMovPicking` p/ `wms_pick_item_atomico` (mesmo fix do BUG-06/07) |

### Detalhamento dos críticos/altos

**BUG-02 — reverter-cutover não estorna a S de realocação (cascade).** Este é o achado mais sólido de corrupção de ledger. A RPC compartilhada `wms_reverter_cutover_atomico` varre as saídas (S) do pedido por dois caminhos: `origem_id = pedido_id AND origem_tipo='nf_venda'`, ou `mov_saida_id ∈ siso_pedido_itens`. A S do pick *principal* casa nos dois. Mas a S de *realocação* (cascade) nasce defeituosa em três call-sites — `marcar-realocacao/route.ts:123-144`, `parcial/route.ts:1612-1636` e `pick-mov.ts:198-214` — onde `inserirMovimentacao` é chamado com `origem_tipo:"nf_venda"` mas **sem `origem_id`** (vira NULL via `ledger.ts:186`), e o `mov_saida_id` dessa S é gravado em `siso_pedido_item_realocacoes`, nunca em `siso_pedido_itens`. Resultado: num retrocesso (ex.: `desfazer-bip` de embalado→em_separacao com `estoque_lancado=true`), a RPC estorna a S principal mas **deixa a S de realocação sem E compensatória** → saldo físico continua deduzido (estoque fantasma a menos) e a R cascade nunca é recriada. Atinge `voltar-etapa`, `desfazer-bip` e todo caller de `reverterCutoverSeRetrocedeu`. Fix mais cirúrgico: passar `origem_id=String(pedido.id)` nas três S de realocação.

**BUG-06 — double-tap no scanner.** TOCTOU clássico de aplicação no `bipar-checklist`: o guard `if (item.mov_saida_id) continue` lê o snapshot carregado *antes* do pick, sem advisory lock, sem row lock, sem re-check pós-pick. O próprio comentário no código admite a corrida. O `pickMovPicking` não tem o `FOR UPDATE` na R nem o check `v_ja_liberada` que o `wms_pick_item_atomico` (usado por `marcar-item`) tem. O CHECK do banco é mitigante apenas parcial: numa loc de picking com `reservado` *pooled* (vários pedidos do mesmo SKU na mesma loc — caso normal de alto volume), o 2º L consome silenciosamente a reserva de **outro** pedido e o 2º S deduz saldo de novo → baixa dupla e o pedido-vítima fica sem reserva. Já está em `erros-conhecidos.yaml:4839` como bug conhecido não corrigido. Confiança **medium** porque o disparo depende de timing real de double-tap + pooling. Mesma raiz que BUG-07.

**BUG-09 — parcial não-idempotente no ramo residual.** O `wms_pick_parcial_atomico` não aceita `p_idempotency_key` e `wms_acumular_qty_pega` é um `UPDATE ... SET quantidade_pega = quantidade_pega + p_delta` puro. Não há dedup no endpoint nem retry/idempotency no cliente. O ramo `loc_zerou=false` com residual deixa o item **propositalmente aberto** (`separacao_marcado=false`, `separacao_parcial=false`), então um replay (mesmo body, ex. `qty_pega=4` num pedido de 10 já com 4 pego) passa o guard de re-entrada, passa o teto `totalFaltante`, e emite uma **segunda S** + infla `quantidade_pega` para 8 — duplo débito de estoque com o operador tendo pego 4 fisicamente uma vez. Caso `loc_zerou=true` ou pick que completa o item é protegido pelo 409 do guard. Por isso parcial: só o ramo residual vaza.

**BUG-12 — cancelar pós-pick.** Por design, cancelar um pedido com item já pego (S viva) **não estorna a S** — vira tag `cancelado_com_picks` (webhook) ou `itens_para_devolver_manual` no JSON da resposta (caminho humano). O problema confirmado não é o não-estorno (decisão de auditoria), mas a **ausência total de fila forte**: grep confirma zero consumidores das tags/payloads (só write-sites + 1 cenário de teste); `registrarDevolucaoPendente` só é chamado no caminho de NF de devolução, nunca no cancelamento; o `montarExcecoes` da home não cobre. Resultado líquido: peça sai do ledger, pedido morre, saldo nunca volta e nada coloca o caso numa worklist acionável — perda de estoque dependente de memória humana. Confirmado por cenário de teste (`83-...:69`) que assere que o saldo permanece deduzido pós-cancelamento.

**BUG-07 — par L+S não-atômico no `pickMovPicking`.** Mesma raiz arquitetural do BUG-06: L e S são duas RPCs separadas, cada uma sua tx. Se a S falha após o L commitar (depleção concorrente entre L e S, ou erro transiente de DB/rede), a L órfã reduz o `reservado` mas o `saldo` fica intacto → `disponivel` aumenta → quantidade "reservada" reaparece como disponível para novo pedido = janela de overselling. A L órfã fica parcialmente invisível (os links e `mov_saida_id` só são escritos *depois* do S). Escopo limitado a `bipar-checklist` + `validar-oc-item`; o caminho principal (`marcar-item`, `parcial`) já é atômico. Fix unifica com BUG-06: migrar `pickMovPicking` para a RPC atômica.

---

## 3. Parciais

| ID | Título | Sev | Reachable | Conf. | O que é REAL vs o que NÃO |
|---|---|---|---|---|---|
| **BUG-10** | reverterCutover falha silenciosa → status retrocede mas estoque vivo | **alta** | sim | medium | **REAL:** `voltar-etapa:303-310` e `desfazer-bip:172-182` fazem `.catch(()=>warn)` e a função nem lança (`cutover.ts:230-235` retorna `{reverted:false}`) → status persiste mas estorno vira no-op; o `.catch` é ineficaz (deviam usar o retorno). Caso exposto: S residual do worker `lancar_estoque_pos_nf` (sem `mov_saida_id` no item) → re-pick gera 2ª S. **NÃO:** no caminho comum (pick por checkbox), `resetarEstadoSeparacaoItens` roda antes e re-lança falha → 500; double-baixa não ocorre aí. |
| **BUG-03** | leitura de `siso_empresas.galpao_id` (DEPRECADA) no ramo OC | **média** | sim | high | **REAL (parte 2):** `bipar-embalagem-oc:249-254` e `confirmar-item-embalagem:169-174` leem o espelho deprecado p/ decidir própria×transferência e setar `separacao_galpao_id`; divergência quando empresa multi-preferencial ou admin edita entre intake e embalagem → etiqueta/job no galpão errado. **NÃO (parte 1):** escolha de loc/saldo/reserva é toda scoped por galpão — nenhuma rota cruza galpão (8 call-sites verificados com `.eq("galpao_id",...)`). |
| **BUG-05** | parcial !loc_zerou re-reserva fire-and-forget | **média** | sim | high | **REAL:** `parcial:942-961` re-reserva residual só com `logger.warn` em falha; R original 100% liberada no 7a → residual sem R sob corrida; `marcar-item` cai no fallback S-only. **NÃO (refutados por guard):** "galpão errado" (fallback é scoped), "overselling" (S-only valida saldo → 409), "loc errada" (cosmético, pool fungível no galpão). Dano = degradação transitória, não corrupção. |
| **BUG-08** | parcial 7a libera R e RPC falha; compensação falha | **média** | sim | high | **REAL:** L's committed antes do RPC (`20260607e` não engloba a liberação) → janela; double-fault alcançável se S concorrente consumiu saldo. **NÃO catastrófico:** compensação `estornarLiberacaoReserva` existe e é idempotente; double-fault já é **loud** (`logError business_logic` + 409 `reservas_nao_recriadas`) — não corrompe silenciosamente. |
| **BUG-11** | S consolidada de wave com estorno parcial prévio | **média** | sim | high | **REAL:** `estornarMovimentacao` rejeita mov com `qty_estornada>0` (`ledger.ts:498-502`); `reset-state` usa full estorno. 500 é alcançável na variante **multi-reversal** (2+ E na mesma S → `.maybeSingle()` retorna PGRST116 → guard #2 pulado → guard qty_estornada dispara). **NÃO:** a hipótese exata (1 desfazer-parcial) NÃO estoura — guard #2 "já foi estornada" casa com regex de idempotência → skip (mas deixa fração fantasma latente). |
| **BUG-13** | ajuste loc_zerou nunca estornado | **média** | sim | high | **REAL:** `ajuste_pick_zerou` é S única sem E (write-off permanente); nenhum retrocesso estorna (explícito por design em cancelar/desfazer-parcial/reset-state). Misclick em `loc_zerou=true` = write-off de estoque real. **NÃO (contra-ponto):** é decisão deliberada com recurso manual via `/api/wms/ajuste` ou inventário — não é corrupção sem recurso. Nota: invariante I6 do harness trata como par S+E → falso-positivo. |
| **BUG-14** | rota localizacao sem permission + mov em massa | **média** | sim | high | **REAL (sub-2 atomicidade):** L→S→E→re-R são 3-4 RPCs sem tx; catch só loga e retorna `ok:true`; re-R falha após S+E → saldo sem reserva = overselling; E falha após S → perda de saldo. **NÃO (sub-1 permission):** rota TEM `getSessionUser` (401); ausência de `userCan` é a convenção de TODAS as rotas de separação, não buraco específico. |
| **BUG-15** | encaminhar com liberação de R falhando → reservado fantasma | **média** | sim | high | **REAL:** `encaminhar:341-356` libera R per-R com `catch→warn`, não re-lança; pedido migra de galpão mas R fica viva no origem = reservado fantasma; **escapa** de `detectarReservasOrfas` (só flaga status=cancelado) e de I8 (R consistente no ledger). Pior que cancelar. **NÃO determinístico:** gatilho real é falha transitória de DB no INSERT do L — não é todo encaminhar. |
| **BUG-A** | trocar SKU equivalente depois de concluído | **baixa** | sim | high | **REAL:** o guard bloqueia troca pós-pick (funciona); reset-state NÃO limpa `produto_wms_substituto_id`/`troca_equivalencia_id` → troca já aplicada vira **beco sem saída** após reabrir (não há como corrigir p/ 3º SKU). **NÃO:** não há inconsistência de estoque — é capacidade-faltante; a R recriada acompanha o substituto, self-consistente. |
| **BUG-01** | voltar-etapa → pendente_realocacao não roda reset-state | **baixa** | **não** | high | **REAL:** lacuna de coerência de flags (item flags vs ledger) existe ao voltar p/ idx>aguardando_separacao quando reverter estorna S; e a MESMA lacuna existe ao voltar p/ `em_separacao` (esse SIM UI-alcançável). **NÃO:** premissa principal (over-reserve por R cascade) refutada — gate em `concluir:67-83` impede chegar a separado/embalado com realocação viva; `pendente_realocacao` não é oferecido pela UI (só POST direto admin). |
| **BUG-17** | S-only fallback pica loc não-vendável | **baixa** | **não** | high | **REAL:** os 3 fallbacks sem-R chamam `buscarLocComMaiorSaldoNoGalpao` sem `apenasVendaveis` → poderiam pegar recebimento/quarentena; docstring CST-01 stale afirma o contrário. **NÃO alcançável p/ item normal:** item própria/transferência sempre ganha R em loc vendável no `aprovar`; o fallback sem-R é o caminho INTENCIONAL do OC (bipa onde achou, incl. recebimento — documentado). |

---

## 4. Precisa Repro ao Vivo

Apenas **BUG-10** carrega passos de reprodução ao vivo (o sub-caminho mais grave — baixa dupla via S residual do worker — só se prova com banco vivo; o resto da análise foi estática).

> ⚠️ **Pré-requisitos obrigatórios antes de qualquer repro:** staging é ambiente **VIVO** (pedidos reais). Toda mutação destrutiva exige `ALLOW_STAGING_WIPE=true` no env **E autorização explícita do Eryk**. NÃO setar a flag nem executar mutações sem o Eryk pedir.

**BUG-10 — provar a baixa dupla:**
1. Levar um pedido `propria` até `separado`/`embalado` **via worker `lancar_estoque_pos_nf`** (caminho R→L+S residual, sem pick por checkbox). Confirmar `estoque_lancado=true` e existência de S `nf_venda` com `origem_id=pedido` e itens com `mov_saida_id` NULL.
2. Injetar falha na RPC (ex.: renomear temporariamente `wms_reverter_cutover_atomico` ou forçar lock) e chamar `POST /api/wms/separacao/voltar-etapa` `{pedido_ids:[id], novo_status:"aguardando_separacao"}`.
3. Verificar que a rota retornou `{ok:true}`, status virou `aguardando_separacao`, `estoque_lancado` continua `true` e a S residual segue viva sem E counter.
4. Re-pick via `POST /api/wms/separacao/marcar-item` → contar S `nf_venda` do pedido: haverá **2** (baixa dupla).

---

## 5. Refutados (com o guard real)

- **BUG-B** (voltar de embalado/conferido → auto-estorno): reversão do cutover é correta/atômica/idempotente — `wms_reverter_cutover_atomico` (`20260608b:32`) pula S que já tem E (`NOT EXISTS`); `reset-state` estorna a S antes (conjuntos disjuntos); `voltar-etapa:132-141` limpa `embalado_real_por`/`conferido_por`; teste `reverter-cutover-rpc.test.ts:50-53` prova saldo restaurado e idempotente. Preservar etiqueta/agrupamento é por design.
- **BUG-04** (R presa em loc que zerou): CHECK `reservado<=saldo` em `siso_estoque` + `reservado_posterior<=saldo_posterior` em `siso_movimentacoes` (`20260508:89,147`) tornam o cenário impossível pelo ledger; e mesmo num fantasma, `marcar-item` retorna 409 sem overselling; o botão "Parcial" + cascade dá caminho de recuperação automática completo.
- **BUG-16** (expedir sem gate): `expedir` checar só status `IN('embalado','conferido')` é **por design** — conferência é opcional (`CLAUDE.md`: "expedir NÃO exige conferido"), print desacoplado do status é deliberado (PrintNode down não trava), e o endpoint não tem caller UI orgânico hoje (só harness).
- **BUG-18** (RPC legada `siso_processar_bip` não emite S): correto que a RPC não emite S, mas a rota `/separacao/bipar` é **código morto** — grep = zero callers vivos; o único caller (`scan-input.tsx`) não existe no src ativo nem é git-tracked. O pick real vive em `wms_pick_item_atomico`.
- **BUG-19** (`status_separacao=NULL` ambíguo): grep exaustivo das 6 ocorrências mostra que os 3 estados NULL (transferência-pendente/cancelado/encaminhado) são sempre **desambiguados por `status` e/ou `sugestao`** — nenhuma query reúne os 3 sem guard.
- **BUG-20** (reconciliador-oc em estado avançado): dois guards empilhados em `reconciliador-oc.ts` — o item-gatilho é sempre limpo via claim atômico antes da transição (`:205-216`), e `aindaEmCompra` (`:270-281`) bloqueia gravar `decisao_final='propria'` enquanto qualquer item tem `compra_status` pendente. Corroborado pelo cenário `80-reconciliador-saldo-oc.ts`.

---

## 6. Próximos Passos Recomendados (top 5 por impacto/esforço)

1. **Migrar `pickMovPicking` para `wms_pick_item_atomico`** (resolve **BUG-06 + BUG-07** de uma vez — dois ALTAS/médias). É o fix de maior alavancagem: fecha o double-tap (TOCTOU) e o par L+S não-atômico em `bipar-checklist`/`validar-oc-item`, alinhando ao caminho já-atômico de `marcar-item`. Esforço médio (a RPC já existe e aceita `p_reserva_id` null).

2. **BUG-02 — passar `origem_id=pedido_id` na S de realocação** (`marcar-realocacao`, `parcial:1612-1636`, `pick-mov.ts:198-214`). Fix cirúrgico de 3 linhas que faz a S cascade cair no Caminho 1 da RPC de reverter-cutover, eliminando o estoque-fantasma no retrocesso. Alto impacto, baixo esforço.

3. **BUG-12 — alimentar fila forte no cancelamento com pegos** (inserir pendência em `siso_devolucoes_pendentes` ou fonte de exceção em `montarExcecoes` p/ `cancelado_com_picks`). Hoje a peça picada vira perda de estoque silenciosa dependente de memória humana. Esforço baixo-médio; impacto operacional alto (recorrente).

4. **BUG-10 — usar o retorno de `reverterCutoverSeRetrocedeu`, não o `.catch`** em `voltar-etapa:303-310` e `desfazer-bip:172-182`: se `motivo='rpc_error'`, reverter o UPDATE de status e responder 5xx em vez de `{ok:true}`. Adicionar invariante no harness: nenhum pedido com status backward pode ter `estoque_lancado=true`. Fecha a baixa-dupla da S residual do worker. Esforço baixo.

5. **BUG-09 — idempotency key no `/separacao/parcial`** (ramo residual `loc_zerou=false`): aceitar `idempotency_key` gerado no cliente por confirmação de modal e dedupar antes de qualquer escrita. Fecha o duplo-débito por replay. Esforço médio.

> Fixes 6-8 (BUG-03 trocar leitura do espelho deprecado por `separacao_galpao_id`; BUG-14 delegar `/separacao/localizacao` à RPC atômica `wms_trocar_reserva_localizacao_atomico`; BUG-15 tornar `encaminhar` fail-loud) são de severidade média e bom custo-benefício para uma segunda onda.

---

## 7. Baseline `npm test` (rodado — read-only / staging intocado)

6 falhas / 491 testes. **Nenhuma é bug de estoque em produção — são 2 podres de suíte:**

| Falhas | Arquivo | Causa | Tipo |
|---|---|---|---|
| 5 | `src/lib/wms/realoc-fix-pack.test.ts` | `loc_uuid 5b2e833f…` não existe mais em `siso_localizacoes` staging → FK `siso_estoque_localizacao_id_fkey` no seed | fixture stale |
| 1 | `src/app/api/wms/separacao/validar-oc-item/encontrei-…test.ts` | mock não cobre `@/lib/wms/sync-tiny` (`resolverProdutoEfetivoComAutoSync`, linhas 268/339) nem `@/lib/compras-oc` (add pelo commit `c7cb101`) → real roda contra supabase fake → 500 | test drift |

Esse `realoc-fix-pack.test.ts` é o único de 78 que toca staging (smoke de RPC, dado isolado `TEST-FIX-PACK-*` + auto-cleanup). Verificado read-only: **0 órfãos `TEST-*` em staging** — limpou certo.

**Fix dos testes:** refrescar UUID de loc staging no fixture; adicionar `vi.mock` de `sync-tiny` + `compras-oc` no teste validar-oc.

