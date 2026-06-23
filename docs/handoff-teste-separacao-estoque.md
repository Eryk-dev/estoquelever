# PROMPT DE HANDOFF — Teste E2E Intensivo: Separação + Estoque (SISO/WMS)

> Cole este prompt inteiro numa nova sessão do Claude Code no repo `/Users/eryk/Documents/ESTOQUE`. Ele é autocontido.

## 1. MISSÃO

Rodar um **teste regressivo/E2E exaustivo do módulo de SEPARAÇÃO + integração de ESTOQUE (ledger 3D)** do SISO/WMS, exercitando **cada `status_separacao` × cada transição (forward E backward) × cada estado de estoque**, com foco em **achar inconsistências de saldo, reservas órfãs, baixa dupla, estoque fantasma e estados onde `estoque_lancado` mente sobre o ledger**. Após CADA operação você assere as invariantes do ledger. Entregável: lista de bugs reproduzíveis (template abaixo) + entradas em `erros-conhecidos.yaml`.

O dono (Eryk) **não conhece os nomes técnicos** dos cenários — este prompt os enumera por você. Não pergunte "o que testar"; ataque a matriz inteira.

## 2. AMBIENTE & SEGURANÇA (LEIA ANTES DE QUALQUER COMANDO)

| | Branch | Supabase project | Pode tocar? |
|---|---|---|---|
| **Staging (alvo)** | `develop` → `estoquelever.vercel.app` | `ehbxpbeijofxtsbezwxd` | **SIM — é o alvo** |
| **Prod (dormente)** | `main` | `wrbrbhuhsaaupqsimkqz` | **NUNCA** |

- O `.env` ativo aponta pra **staging** (`ehbxpbeijofxtsbezwxd`); a linha do prod está comentada. **Confie na branch, não no rótulo "production" do Vercel.** Confirme com `grep SUPABASE_URL .env` antes de começar (deve conter `ehbxpbe...`).
- **Staging é AMBIENTE VIVO (pedidos reais).** Todo wipe (truncate via harness / `seed:staging`) está **bloqueado por padrão**: `scripts/wms/cenarios/_harness/seed.ts:16` e `scripts/wms/seed-staging.ts:34` abortam se `ALLOW_STAGING_WIPE !== "true"`.
- **NUNCA** sete `ALLOW_STAGING_WIPE=true` por conta própria. Só o Eryk pede isso explicitamente. Sem essa flag, `npm run test:integration`, `npm run scenarios` e `npm run seed:staging` **vão abortar** ao tentar truncar — isso é esperado e é a proteção.
- `npm run test:integration` e `npm run scenarios` **truncam tabelas operacionais** (`wms_truncate_operacional`) antes de cada run. Por isso só rodam com a flag, e só quando o Eryk autorizar.
- **Migrations:** se precisar de uma RPC de diagnóstico, crie arquivo em `supabase/migrations/` e aplique via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` — nunca no prod. Prefira **não** criar migrations; use queries de leitura.
- Toda chamada Tiny/PrintNode/ML deve rodar com stubs: exporte `TINY_DISABLED=true PRINTNODE_DISABLED=true ML_DISABLED=true` para testes manuais (a config de integração já faz isso em `vitest.integration.config.ts:13`).

**Regra de ouro:** se um passo exigir apagar dados vivos e o Eryk não autorizou, **PARE e reporte** em vez de setar a flag.

## 3. COMO RODAR

```bash
grep SUPABASE_URL .env                 # CONFIRME ehbxpbe... antes de tudo
npm test                               # vitest unit (happy-dom) — SEGURO, não toca staging
npm run test:integration               # vitest contra staging REAL (precisa flag + autorização — trunca)
npm run scenarios                      # E2E HTTP em /api/wms/* via run-all.ts (precisa flag — trunca + reseed)
npm run scenarios:only -- <substr>     # roda só cenários cujo nome casa (mais cirúrgico)
npm run verificar:saldos               # reconcilia saldos vs esperado pós seed-cenarios
npm run auth-matrix                     # matriz de auth/permissões
```

**Infra já existente que você DEVE reusar (não reinvente):**
- `scripts/wms/cenarios/catalogo/` — **113 cenários E2E** já escritos. Os mais relevantes pra sua missão: `18-aprovar-cria-reserva`, `19-aprovar-sem-cobertura-falha`, `20-checkbox-preserva-reserva`, `21-parcial-libera-R-total`, `25-bipar-checklist-gera-mov`, `27-encaminhar-libera-reserva`, `27b-encaminhar-pos-pick-libera-r`, `28-delete-realocacao-libera-r`, `30-webhook-cancel-libera-r`, `31-venda-separacao-cria-r`, `34/42-recusar/rejeitar`, `49-reiniciar-embalagem-reverte-cutover`, `70-parcial-wave-reserva`, `70-parcial-reserva-propria-saldo-alocado`, `82-desfazer-bip-concorrente`, `82-desmarcar-item-atomico`, `83-cancelar-pedido-em-separacao-parcial`, `83b-cancelar-marketplace-parcial`, `84-cancelar-item-libera-reserva`, `86-resolver-pedido-fantasma`, `cenario-embalagem-idempotencia`. **Sua tarefa inclui achar buracos que ESSES cenários não cobrem.**
- `scripts/wms/cenarios/_harness/invariantes.ts` — checker `rodarInvariantes(sb)` com **I1–I8** (ver §6). Use depois de cada operação.
- Testes unit/integração já existentes (rode `npm test` primeiro como baseline): `test/integration/reverter-cutover-rpc.test.ts`, `pick-item-idempotency.test.ts`, `pick-parcial-atomico-rpc.test.ts`, `reservas-rpc.test.ts`, `estorno-parcial-movimentacao-repair.integration.test.ts`, `src/lib/separacao/reset-state.test.ts`, `src/app/api/wms/separacao/cancelar/cancelar-recria-reserva.test.ts`.

**Teste manual via HTTP** (quando o Eryk autorizar um pedido de cobaia, ou via harness que cria pedidos isolados): autentique com `POST /api/auth/login {nome,pin}` → use `sessionId` no header `X-Session-Id` (+ `X-Galpao-Id`). Endpoints chave (todos POST salvo indicado), sob `/api/wms/separacao/`:
`iniciar · marcar-item · bipar-checklist · parcial · marcar-realocacao · concluir · concluir-oc · confirmar-item-embalagem · bipar-embalagem · bipar-embalagem-oc · conferencia/bipar · conferencia/divergencia · expedir · desfazer-bip · desfazer-parcial · voltar-etapa · cancelar · reiniciar · encaminhar · produto-esgotado · validar-oc-item · trocar-localizacao · localizacao · realocacao/[id] (DELETE) · forcar-pendente`. E `/api/wms/pedidos/aprovar`, `/api/wms/trocas` (+ `[id]/aprovar`, `[id]/trocar-substituto`).

**Sugestão de método quando NÃO houver autorização pra truncar:** crie um harness isolado em TS (estilo `scripts/wms/cenarios/_harness/standalone.ts`) que insira produtos/locs/estoque com prefixo `TEST-`/SKU dedicado, dispare as operações via service client, rode `rodarInvariantes(sb)` entre cada passo, e **limpe só seus próprios registros** ao final. Nunca trunque tabelas globais.

## 4. MATRIZ DE TESTE (status_separacao × transição × estado de estoque)

**Régua canônica (STATUS_ORDER, `voltar-etapa/route.ts:31-41`):**
`aguardando_nf(0) → validacao_oc(1) → aguardando_separacao(2) → em_separacao(3) → pendente_realocacao(4) → separado(5) → embalado(6) → conferido(7) → expedido(8)`. `aguardando_compra` está **FORA** dessa régua. `expedido` é gravado na coluna mas **não existe no type `StatusSeparacao`** (`src/types/index.ts:175-184`).

**Conjunto FORWARD (cutover) =** `{separado, embalado, conferido, expedido}` (`cutover.ts:39`). Entrar nele → `estoque_lancado=true`; sair dele (com `estoque_lancado=true`) → reversão (estorna S + recria R + `estoque_lancado=false`).

**Estados de estoque a variar em cada linha:** (A) saldo livre cobre 100%; (B) loc da R zerada por consumo concorrente; (C) item sem loc / sem R viva; (D) multi-loc (cascade); (E) saldo só em OUTRO galpão; (F) saldo compartilhado disputado por 2 pedidos.

### 4a. FORWARD — efeito esperado no ledger

| De → Para | Endpoint | Efeito esperado no ledger |
|---|---|---|
| (R criada no aprovar) | `pedidos/aprovar` | 1 `R` `reserva_pedido` por item na loc de `escolherLocCobrindo` (picking que cobre tudo, senão maior disponível). `reservado += qty`. Sem cobertura → rollback de TODAS as R já criadas (all-or-nothing). |
| aguardando_separacao/validacao_oc → em_separacao | `iniciar` | **Nenhum** débito. Pode reconciliar OC→própria (cria R best-effort). |
| em_separacao (pick) | `marcar-item` | **AQUI sai o estoque:** `L`(liberacao_reserva, estorno_de=R.id) + `S`(nf_venda) atômico (`wms_pick_item_atomico`) na loc da R. `reservado −qty`, `saldo −qty`. Status NÃO muda. |
| em_separacao (pick scanner) | `bipar-checklist` | Mesmo par L+S MAS via `pickMovPicking` — **NÃO atômico, NÃO idempotente** (chamadas separadas). Guard só `mov_saida_id` (TOCTOU). |
| em_separacao (pick parcial) | `parcial` | `S`(qty_pega) + (loc_zerou) `S`(ajuste_pick_zerou) atômicos + `L` de quem pegou + re-reserva/cascade do residual. |
| em_separacao → separado | `concluir` | Sem débito novo. `dispararCutoverSePronto` liga `estoque_lancado=true` (backstop; S já saiu). Itens OC → validacao_oc/aguardando_compra. |
| separado → embalado | `confirmar-item-embalagem`/`bipar-embalagem` | Sem débito (cutover no-op). Dispara impressão física da etiqueta. |
| embalado → conferido | `conferencia/bipar` (modo conferir) | **Zero ledger.** |
| embalado/conferido → expedido | `expedir` | **Zero ledger.** Não exige `conferido` nem `etiqueta_status=impresso`. |

### 4b. BACKWARD — efeito esperado no ledger

| De → Para | Endpoint | Efeito esperado no ledger |
|---|---|---|
| qualquer forward → target **≤ aguardando_separacao** | `voltar-etapa` | **DOIS mecanismos:** reset-state estorna `S` (gera `E`, saldo +qty) + ressuscita `R` das L de pick (`recriarReservas=true`) + estorna R cascade; depois `wms_reverter_cutover_atomico` estorna S residuais + recria R + `estoque_lancado=false`/`nf_estoque_lancado=false`. Resultado: saldo restaurado, **exatamente 1 R viva por item**, flag=false. |
| forward → **separado** | `voltar-etapa` | NO-OP de estoque (separado ainda é forward). Só desfaz embalagem. |
| forward → **pendente_realocacao (idx 4)** | `voltar-etapa` | ⚠ **SUSPEITO:** cai no tier que NÃO roda reset-state, MAS pendente_realocacao não é forward → RPC estorna a S principal + recria R + flag=false, **sem limpar links/campos do item nem R cascade**. Ver edge-case BUG-01. |
| embalado → em_separacao / em_separacao → aguardando_separacao | `desfazer-bip` | RPC estorna S (via `mov_saida_id`) + recria R + flag=false. **NÃO roda reset-state** → não limpa links/campos. |
| pendente_realocacao → em_separacao | `desfazer-parcial` | Estorno parcial por link + recria R + estorna R cascade. **NÃO** estorna `ajuste_loc_zerou`. |
| desmarcar item | `marcar-item` (marcado=false) | `wms_desmarcar_item_atomico`: estorna par S+L por fração, recria R **clampada ao saldo livre** (pode recriar menor → `status_alerta`). Não toca `estoque_lancado`. |
| qualquer → outro galpão | `encaminhar` | Libera TODAS as R (`L`) + estorna S de picks (`E`) + cancela trocas pendentes; **NÃO recria R** (`recriarReservas=false`) → saldo livre pro destino. `status_separacao=NULL`, `estoque_lancado=false`. |
| cancelar wave (voltar) | `cancelar` (sem `cancelar_pedido`) | Estorna S + recria R + estorna R cascade; **NÃO** estorna `ajuste_loc_zerou`; volta validacao_oc/aguardando_compra/aguardando_separacao. |
| cancelar pedido pós-pick | `cancelar` (`cancelar_pedido=true`) / webhook | Itens pegos: **S NÃO estornada** → vira `itens_para_devolver_manual` + tag `cancelado_com_picks`. Não-pegos: R liberada. Pedido → cancelado. |
| reiniciar embalagem | `reiniciar` | Força reversão de cutover MESMO em "separado" (pula gate forward). Zera bip. Não toca etiqueta_zpl. |

## 5. CASOS DE BORDA NOMEADOS (cenários concretos — reproduza cada um com números)

> Use produtos/locs de teste. Padrão: **produto P, galpão G1 (e G2 quando indicado), 10 unidades** salvo dito. Após cada caso rode `rodarInvariantes(sb)` + reconcilie soma de movs vs `siso_estoque`.

**BUG-A (PEDIDO-CHAVE: trocar SKU pelo equivalente DEPOIS de concluído).** P vendido, pedido picado e em `separado`/`embalado`/`expedido`. Tente `POST /api/wms/trocas {pedido_item_id, sku_substituto}`. **Esperado documentado:** 409 `PEDIDO_ESTADO_INVALIDO`/`ITEM_JA_SEPARADO` (guard em `trocas-equivalencia.ts:235-257`). **O que investigar:** (1) confirme que NÃO há nenhum caminho que corrija o SKU pós-conclusão; (2) o caminho admin de 2 passos — `voltar-etapa`→`aguardando_separacao` (estorna S, recria R) → `solicitarTroca` → aprovar → re-picar — funciona de ponta a ponta SEM deixar estoque inconsistente? (3) `reset-state` NÃO limpa `produto_wms_substituto_id`/`troca_equivalencia_id` — re-abra um item que JÁ tinha troca aplicada via voltar-etapa e veja se a R recriada e o produto efetivo batem. (4) Cenário físico: operador pega a marca ERRADA mas o S foi do SKU vendido — o WMS não sabe da divergência; documente como gap (sem ajuste automático).

**BUG-B (PEDIDO-CHAVE: voltar de embalado/conferido pra antes-de-separado com etiqueta impressa → estoque deve auto-estornar).** P, 5 un, pedido `embalado`, `etiqueta_status=impresso`. `voltar-etapa` para `aguardando_separacao`. **Asserir:** para cada S existe 1 `E` (estorno_de=S); exatamente 1 R viva por item; `estoque_lancado=false`; `saldo` voltou +5. **Investigar também:** etiqueta física vira lixo — `etiqueta_zpl/url/barcodes/agrupamento_expedicao_id` são **preservados de propósito**; ao re-embalar, reimprime a MESMA etiqueta (agrupamento Tiny pode estar obsoleto/cancelado). Documente o risco operacional (não é bug de saldo, mas de etiqueta dupla/inválida). Repita com `desfazer-bip` (embalado→em_separacao): cheque se `embalado_real_por`/`conferido_por` ficam grudados num pedido des-embalado (suspeito de métrica suja).

**BUG-01 (voltar-etapa → pendente_realocacao não roda reset-state).** P, 5 un, pedido com pick parcial (qty_pega=3, residual 2 em cascade). `voltar-etapa` para `pendente_realocacao`. **Asserir:** R cascade residual deve ser estornada e item-flags (`separacao_marcado`, `quantidade_pega`, `separacao_parcial`) resetados. **Suspeita:** RPC restaura só a S principal; cascade fica VIVA (over-reserve) e flags inconsistentes (`separacao_marcado=true` com S estornada). Re-pick depois pode duplicar baixa ou travar. Compare `reservado` na tripla antes/depois.

**BUG-02 (desfazer-bip com pick parcial / múltiplas S).** P, pedido com S principal + S de realocação (cascade). `desfazer-bip` embalado→em_separacao. **Suspeita:** `desfazer-bip` confia só na RPC via `mov_saida_id` (= só a S principal); S de cascade que não bate `origem_id=pedido` fica SEM estorno (estoque fantasma a menos) e R cascade nunca recriada.

**BUG-03 (cross-galpão na escolha de loc — vetor histórico, hoje fechado por convenção).** P com saldo SÓ em G2; pedido separa em G1. Toda a cadeia DEVE filtrar `.eq(galpao_id, G1)` (`buscarLocComMaiorSaldoNoGalpao`, `checklist-items`, `produto-localizacoes`, `buscarReservaPendentePorProduto`, `trocar-localizacao` rejeita loc de outro galpão com 422). **Investigar:** alguma rota retorna loc/saldo de G2? `trocar-localizacao` com loc de G2 → deve dar 422 `loc_invalida`. **Atenção especial:** `bipar-embalagem-oc` e `confirmar-item-embalagem` (ramo OC) leem `siso_empresas.galpao_id` (**coluna DEPRECADA**) pra decidir própria vs transferência — pode resolver galpão/empresa errados. Reproduza um pedido OC e confirme a decisão final.

**BUG-04 (R presa em loc que zerou).** P, R do pedido na loc L1 com 3 un; outro pedido/guarda/inventário consome L1 até 0. `marcar-item`. **Esperado:** S viola CHECK → RPC lança → 409, item NÃO marcado (sem overselling). **Investigar:** se L1 era a ÚNICA loc com saldo, `locs_disponiveis<=1` → a flecha "outras localizações" não aparece → pedido **preso** sem caminho automático. Documente.

**BUG-05 (parcial !loc_zerou re-reserva falha — fire-and-forget).** P, pedido `em_separacao`, parcial qty_pega=2 de 5, `loc_zerou=false`. A re-reserva do residual (`criarReservaCascade` contexto `residual_mesma_loc`) é só `logger.warn` em falha. Force/observe item aberto SEM R viva → ao completar via `marcar-item`, cai no fallback "maior saldo vivo" (pode pegar loc/galpão errado ou 409). **Asserir:** item aberto sempre tem R viva, OU documente a janela.

**BUG-06 (double-tap no scanner — overselling).** Dois POST `bipar-checklist` simultâneos pro MESMO item antes do 1º gravar `mov_saida_id`. **Suspeita (reconhecida no código):** 2 pares L+S → `saldo −2×qty`, `reservado` pode estourar, 2º L pode falhar deixando S sem par. **Asserir:** nunca 2 S pro mesmo pick. Este é o maior vetor de baixa dupla. (Compare com `marcar-item` que serializa via `FOR UPDATE` na R.)

**BUG-07 (pickMovPicking: L commita e S falha).** Simule (mock/queda) S falhando após L no `bipar-checklist`. **Suspeita:** L órfã (reservado −qty) sem S → saldo reaparece disponível mas pedido não baixado → overselling. Sem rollback automático.

**BUG-08 (parcial: 7a libera R e RPC falha; compensação falha).** Force `wms_pick_parcial_atomico` a falhar após o passo 7a (libera R do wave). Compensação recria R via `estornarLiberacaoReserva`; se ela TAMBÉM falhar → R liberadas e não recriadas → overselling. Confirme que o endpoint retorna 409 com `reservas_nao_recriadas` (não silencioso).

**BUG-09 (idempotência do parcial).** Replay do endpoint `/parcial` (timeout + retry) entre a S e o commit dos flags. `wms_pick_parcial_atomico` NÃO aceita `p_idempotency_key`; `wms_acumular_qty_pega` é UPDATE-soma não-idempotente. **Suspeita:** S duplicada e/ou `quantidade_pega` duplicada. Verifique se há dedup de request no cliente.

**BUG-10 (reverterCutover falha silenciosa — CRÍTICO documentado).** `reverterCutoverSeRetrocedeu` é chamado com `.catch(()=>logger.warn)` em `voltar-etapa` e `desfazer-bip`, **APÓS** o UPDATE de status já ter persistido. Se a RPC falhar: pedido retrocede de status mas `estoque_lancado` fica `true` e S viva → re-pick depois gera **baixa DUPLA**. Force a RPC a falhar e confirme o estado divergente.

**BUG-11 (S consolidada de wave com estorno parcial prévio).** Wave com 1 S cobrindo N itens; `desfazer-parcial` de 1 item deixa `qty_estornada>0` na S; depois `voltar-etapa` tenta full-estorno (`estornarMovimentacao`) → lança "use estornar_parcial" → reset fica PARCIAL (alguns itens estornados, outros não) + 500. Reproduza.

**BUG-12 (cancelar pós-pick → vazamento silencioso).** Pedido com item pego (S viva), `cancelar` com `cancelar_pedido=true`. **Esperado:** S NÃO estornada, item em `itens_para_devolver_manual` + tag `cancelado_com_picks`. **Investigar:** existe FILA FORTE (`siso_devolucoes_pendentes`) alimentada por esse fluxo, ou depende só da tag + ação humana? Se for só tag → vazamento de estoque silencioso (peça saiu da prateleira, pedido morto, saldo nunca volta). Confirme contra o schema.

**BUG-13 (ajuste loc_zerou nunca estornado).** Parcial com `loc_zerou=true` que era um ERRO (peça existia). `ajuste_pick_zerou` é permanente — nem cancelar/desfazer/reset estornam. Confirme que NÃO há caminho automático de correção (só lançamento retroativo/inventário ad-hoc).

**BUG-14 (rota `localizacao` sem permission check + mov em massa).** `POST /api/wms/separacao/localizacao` só tem `getSessionUser` (sem `userCan`) e move TODO o saldo entre locs (par S+E + manipula R). Falha no meio (R liberadas, S feita, reemissão falha) só vira `logError`. Teste falha parcial → saldo na loc nova sem reserva (overselling) ou R órfã.

**BUG-15 (encaminhar com liberação de R falhando).** `encaminhar` libera todas as R; se uma falha é só `logger.warn` e segue. **Suspeita:** reservado fica preso (zumbi) no galpão origem com o pedido já fora → saldo fantasma reservado. Confirme se há reconciliador que limpa, ou só rebuild manual.

**BUG-16 (expedir sem gate).** `expedir` aceita pedido com `etiqueta_status=falhou` (sem etiqueta física) ou com `divergencia_tipo` aberta. Documente (não é bug de saldo).

**BUG-17 (S-only fallback pica loc não-vendável).** `marcar-item`/`parcial` no fallback sem-R usam `buscarLocComMaiorSaldoNoGalpao` SEM `apenasVendaveis` → pode picar de recebimento/quarentena. Confirme se isso regride item normal cuja R foi liberada (deveria ser só caminho OC).

**BUG-18 (RPC legada `siso_processar_bip`).** A rota `/bipar` delega 100% à RPC `siso_processar_bip`. **Inspecione a RPC** (via `mcp__supabase__` ou migration): ela emite S no ledger ou só marca `quantidade_bipada`? Se NÃO emite S mas marca pedido completo, o estoque pode ficar não-baixado dependendo do cutover. Isso fecha um invariante de baixa.

**BUG-19 (status_separacao=NULL ambíguo).** NULL = (a) transferência aguardando aprovação, (b) cancelado, (c) encaminhado. Confirme que filtros/UI cruzam com `status` (pendente vs cancelado) pra desambiguar; ache query que trate os 3 iguais.

**BUG-20 (reconciliador-oc em estado avançado).** Pedido OC já `em_separacao`/`separado` quando entra saldo (mov E): `reconciliador-oc.ts:294-311` seta `decisao_final=propria` SEM regredir e sem limpar `compra_status` do item → inconsistência entre `decisao_final=propria` e item com `compra_status` pendente. Reproduza com entrada de estoque.

## 6. INVARIANTES A ASSERTAR (após CADA operação)

Rode `rodarInvariantes(sb)` (de `scripts/wms/cenarios/_harness/invariantes.ts`) — ele já cobre **I1–I8**:
- **I1 — ledger ↔ cache:** `wms_detectar_divergencias_estoque()` retorna 0 linhas (soma de movs == `siso_estoque.saldo`).
- **I2 — disponível:** `disponivel == saldo - reservado` em toda linha (coluna GENERATED).
- **I3 — custo médio:** custo só muda em `E` com `custo_unitario` de origem `nf_compra`/`devolucao_cliente_integra`/`lancamento_retroativo`; recalcule ponderado e compare com `siso_custo_medio`.
- **I4 — sem reservas órfãs:** toda `R` expirada/sem TTL tem `L` correspondente (mesmo `origem_id`).
- **I5 — pendências de guarda** coerentes.
- **I6 — pares S+E** (transferências).
- **I7 — fila** sem jobs presos.
- **I8 — reservado ↔ ledger:** `wms_detectar_divergencias_reservado()` retorna 0 linhas.

**Invariantes ADICIONAIS específicos de separação (assira manualmente por SQL/leitura, não cobertos por I1–I8):**
1. **Par atômico:** todo pick que consome R emite `L`(estorno_de=R.id) **E** `S` juntos, ou nenhum. Nunca S sem L par; nunca L sem S (= reserva liberada sem saída = overselling). [Garantido em `wms_pick_item_atomico`; **NÃO** garantido em `pickMovPicking`/bipar-checklist.]
2. **CHECK `reservado <= saldo`** nunca violado em nenhum ponto do par L+S.
3. **`mov_saida_id`** só setado quando a S teve sucesso; item nunca `marcado=true` sem S (fail-loud).
4. **`quantidade_pega <= quantidade_pedida`** sempre (teto = pedida−pega).
5. **Soma de S `nf_venda` por pedido == soma de `quantidade_pega`** de todos os itens (parcial + completo + realocações picadas).
6. **Pós-retrocesso (target ≤ aguardando_separacao):** exatamente 1 R viva por item (nem 0 = overselling, nem 2 = over-reserve); para cada S estornada existe 1 `E`; `estoque_lancado=false` E `nf_estoque_lancado=false`.
7. **`estoque_lancado` coerente:** `true` ⟺ status ∈ `{separado,embalado,conferido,expedido}` de forma estável (liga ao entrar no forward, reverte ao sair). Nunca `true` com pedido em `aguardando_separacao`.
8. **Conferência e expedição NUNCA mexem no ledger** (S já saiu no pick).
9. **Encaminhar:** galpão origem fica `reservado=0` e saldo livre (todas R liberadas, S estornadas) ANTES do pedido migrar; **nenhuma R recriada** no origem.
10. **Cancelar pós-pick (D1):** S dos itens pegos permanece VIVA (não estornada); item em `itens_para_devolver_manual` + tag.
11. **`ajuste_pick_zerou` NUNCA estornado** por nenhum fluxo (permanente).
12. **Idempotência:** mesmo `idempotency_key` → no máx 1 mov (UNIQUE parcial `uq_mov_idempotency_key`); guard `NOT EXISTS(E com estorno_de=S)` impede estorno duplo.
13. **Sem job `lancar_estoque_pos_nf` pendente** sobrevive a uma reversão (cancelados antes da RPC).
14. **Toda R recriada tem `expira_em`** populado (TTL).
15. **Escolha de loc dentro do galpão:** loc exibida no checklist (`escolherLocExibida`) == loc que o pick consome (R viva) == loc que `aprovar` escolheu (todas via `escolherLocCobrindo` no mesmo galpão).

**Reconciliação final:** rode `npm run verificar:saldos` (reconcilia saldo real vs esperado dos cenários) e cheque que a soma de movimentações por `(produto,galpao,loc)` bate com `siso_estoque`.

## 7. FORMATO DE REPORTE

Para cada bug encontrado, emita um bloco:

```
### BUG-<id>: <título curto>
- **Cenário:** <produto/qty/galpão/estado de estoque>
- **Passos:** 1) … 2) … 3) … (endpoints + bodies exatos)
- **Esperado:** <invariante que deveria valer + valores>
- **Obtido:** <estado real do ledger/siso_estoque/flags + linhas divergentes de wms_detectar_divergencias_*>
- **Severidade:** critica | alta | media | baixa
- **Arquivos suspeitos:** <caminhos absolutos + linhas>
- **Invariante violada:** <I1..I8 ou nº da lista §6>
```

**Severidades de referência:** baixa double-tap/overselling → **alta**; reverterCutover falha silenciosa → **crítica**; vazamento por devolução manual → **alta**; etiqueta órfã → **alta** (operacional); type drift / UX → **baixa/media**.

**Ao FINAL, para cada bug confirmado, adicione entrada em `erros-conhecidos.yaml`** (raiz). **Grep ANTES** (`grep -i <termo> erros-conhecidos.yaml`) pra não duplicar — já existem entradas como `separacao-loc-picking-ignorada-maior-saldo` (6291), `separacao-flechinha-loc-unica` (6450), `wms-fix-final-a-a4-marcar-item-transferencia` (1960). Formato: `id, date, source, category, message, cause, fix, files, tags`.

**NÃO escreva relatórios .md** — entregue tudo no seu output final de texto.

## 8. ORDEM DE ATAQUE

1. **Baseline:** `grep SUPABASE_URL .env` (confirme staging) → `npm test` (unit, seguro) → leia os 3 mapas/arquivos chave (`cutover.ts`, `reset-state.ts`, `marcar-item/route.ts`, `parcial/route.ts`, `voltar-etapa/route.ts`). Rode `rodarInvariantes(sb)` pra fotografar o estado limpo do staging ANTES de qualquer mutação.
2. **Caminho feliz forward (estado A):** aprovar → iniciar → marcar-item → concluir → embalar → conferir → expedir. Assere ledger em cada passo. Estabelece a baseline de pares L+S.
3. **Pick alternativo:** repita com `bipar-checklist` (caça BUG-06/07) e com `parcial` loc_zerou=true e false (BUG-05/08/09/13).
4. **Retrocessos curtos:** desmarcar item, desfazer-bip, desfazer-parcial, reiniciar (BUG-02, BUG-B).
5. **Retrocessos longos (admin):** voltar-etapa de cada forward até cada target ≤ aguardando_separacao — célula por célula da matriz §4b (BUG-01, BUG-10, BUG-11, BUG-B).
6. **Cancelamentos:** cancelar wave, cancelar pós-pick (D1), webhook cancel (BUG-12, BUG-19).
7. **Cross-galpão:** encaminhar, escolha de loc, trocar-localizacao, ramo OC com `siso_empresas.galpao_id` (BUG-03, BUG-14, BUG-15, BUG-17).
8. **Troca de equivalência pós-pick:** BUG-A (o pedido-chave do dono) + re-abertura admin.
9. **OC / reconciliador / RPC legada:** BUG-18, BUG-20.
10. **Reconciliação final:** `npm run verificar:saldos` + `wms_detectar_divergencias_estoque`/`_reservado` == 0 + limpe seus registros TEST-* (sem truncar global).

Se em qualquer ponto um passo exigir truncar/wipar dados vivos do staging e o Eryk não autorizou → **PARE, reporte, não sete a flag.**

---

**Arquivos de referência (absolutos):** `src/lib/wms/cutover.ts`, `src/lib/separacao/reset-state.ts`, `src/lib/wms/reservas-picking.ts`, `src/lib/separacao/wms-mapping.ts`, `src/lib/wms/ledger.ts`, `src/lib/wms/trocas-equivalencia.ts`, `src/app/api/wms/separacao/{marcar-item,bipar-checklist,parcial,concluir,voltar-etapa,desfazer-bip,desfazer-parcial,cancelar,encaminhar,confirmar-item-embalagem,conferencia/bipar,expedir,trocar-localizacao,localizacao}/route.ts`, `supabase/migrations/{20260528_wms_pick_item_atomico,20260607d_pick_item_atomico_idempotency,20260607e_rpc_pick_parcial_atomico,20260608_rpc_desmarcar_item_atomico,20260608b_rpc_reverter_cutover_atomico}.sql`, `scripts/wms/cenarios/_harness/invariantes.ts`, `scripts/wms/cenarios/catalogo/`, `erros-conhecidos.yaml`.
