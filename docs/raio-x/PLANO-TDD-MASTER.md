# Plano-Mestre de Remediação TDD — Raio-X SISO/WMS

> **Gerado de:** as **185 respostas** do raio-x (`respostas-problemas.md` / `_respostas.json`) + **re-investigação contra o código ATUAL** (HEAD `de205f2`) via workflow `raio-x-reinvestigacao` (17 agentes, 154 achados estruturados em `_reinvest_findings.json`, síntese em `_reinvest_synthesis.json`).
> **Supersede** `PLANO-REMEDIACAO.md` (aquele saiu de só 83 respostas / 68 acionáveis e está defasado).
> **Decisões do dono:** ordem **fundação-primeiro**, formato **mestre + 1 arquivo TDD por fase**, escopo **todos os 154 acionáveis**.

---

## Estado da re-investigação

Dos **185** problemas respondidos: **31 sem ação** (`opcao=0`) + **154 acionáveis**.

Re-auditando os 154 contra o HEAD atual (houve ~25 commits depois do raio-x: reconciliador OC, separação parcial):

| Status atual | Qtd | O que fazer |
|---|--:|---|
| **`open`** (problema confirmado, intacto) | 118 | implementar |
| **`partially_fixed`** (parte já feita, falta o resto) | 29 | completar |
| **`already_fixed`** (commit recente já resolveu) | 7 | só **teste de regressão** |
| **won't-fix por decisão** (nota = manter comportamento, sem código) | 2 | documentar + regressão |

- **Já corrigidos (7):** P041, P042, P073, P080, P119, P135, P177 — não geram trabalho novo, viram teste de regressão pra travar o comportamento.
- **Won't-fix por decisão (2):** P004 (conta com a rotina de acerto), P092 (defere pra sync marketplace↔WMS futura).
- **A implementar/completar: 145** (118 open + 29 partial − 2 dos quais já contados). Desses, **47 exigem migration** e **29 exigem RPC plpgsql nova**.

> **Por que tanta RPC?** `supabase-js` **não tem transação multi-statement no cliente**. Toda atomicidade "tudo-ou-nada" (N movs no ledger + UPDATE de status na mesma tx) **obriga** RPC plpgsql. Esse é o gargalo arquitetural que define `needs_migration` na maioria das fases 4–5.

---

## Tese de engenharia

Os 145 fixes colapsam em **13 primitivas**, das quais **2 dominam** e são as fundações:

- **(A) Claim atômico de header** — `UPDATE ... WHERE id=$1 AND status=<esperado> [AND lock IS NULL] RETURNING id` (compare-and-set no Postgres). Se 0 rows → 409/no-op idempotente. Serializa transições e mata duplo-clique/concorrência **sem lock global**. Já vivo em `receberTransferencia` e no claim do worker.
- **(B) Envelope de RPC plpgsql transacional** — função que faz `SELECT ... FOR UPDATE` da row-âncora, chama `wms_inserir_movimentacao` N vezes **e** o(s) `UPDATE` de status na **mesma** transação; qualquer `RAISE` → rollback total. TS vira wrapper fino `.rpc()`. Espelha `wms_pick_item_atomico` / `wms_confirmar_guarda_atomico`.

O resto são: wiring de `liberarReserva` idempotente, guards de pré-voo, idempotência de frontend + surfacing de erro, estorno-via-ledger correto, enqueue durável, constraints de banco como backstop, invalidação de cache, guards de permissão no backend, e visibilidade de dados. **Quase nada é infra nova** — é reusar primitivas consagradas onde faltam.

### As 13 primitivas

| Primitiva | # | Construir uma vez | Reusa |
|---|--:|---|---|
| **B. RPC plpgsql transacional (N movs + status)** | 19 | RPCs que envolvem N mutações de ledger (estornos S+L, picks L+S, lote de inventário, classify devolução, set-permissões) numa tx `BEGIN/EXCEPTION` com `FOR UPDATE` da âncora | `wms_inserir_movimentacao`, `wms_pick_item_atomico`, `wms_confirmar_guarda_atomico` |
| **A. Claim atômico de header + lease com staleness** | 9 | `UPDATE...WHERE status=<esp> AND lock IS NULL RETURNING` + colunas de lease (`*_em_andamento_em`) com timeout (30min/5min) pra auto-liberar lock órfão | `recebimento_em_andamento_por`, claim do worker, `iniciada_por` da guarda |
| **Guard de pré-voo (validar antes de mutar)** | 21 | validar estado/insumos ANTES de escrever (qty>0; qty=0 só com loc_zerou; NF p/ nf_venda; sem mistura de galpões; compra-ativa antes de trocar SKU; bipar SKU+loc; custo>0; lead default; status de sessão/loc) | `validarCoerencia`, early-block do concluir-oc, `wmsErrorResponse`, `siso_localizacao_locks` |
| **Idempotência por chave + UX duplo-clique/reconexão + surfacing de erro** | 19 | `idempotency_key` (uuid client) reusado por submissão, coluna+UNIQUE no banco tratando 23505 como no-op; botões `disabled` durante mutation; ler body de erro pra mostrar ao operador | `idempotency_key` de `siso_pedidos`, índice `20260527`, hooks realtime |
| **Estorno tolerante + lookup robusto de movs + categorização correta** | 17 | lookup com fallback (sem `devolucao_id` → data+tipo+NF), estorno parcial via `wms_estornar_parcial_movimentacao`, guard de double-estorno, categorização correta no ledger | `estornarMovimentacao` (guard double-estorno já existe), `wms_estornar_parcial_movimentacao`, `/api/wms/ajuste` |
| **Visibilidade/observabilidade** | 17 | `registrarEvento('erro')` nos pontos de falha; sync-tiny lança erro quando falta mapeamento; filtro "sem mapeamento"; badge `sem_cadastro_tiny`; realtime de divergências | `registrarEvento` (type já tem `erro`), `use-inventario-realtime`, `wmsErrorResponse` |
| **Backstop estrutural: UNIQUE/CHECK no banco** | 8 | UNIQUE parcial: sessão por (galpão,dia), 1 preferencial/produto, estorno único por `estorno_de`, dedup recebimento por NF, kit≥1 componente, guard custo-zero | promover `idx_pf_preferencial` e `idx_mov_estorno` a UNIQUE, template `20260527_p3` |
| **Enqueue durável + retry com backoff + alerta** | 8 | operações fire-and-forget críticas passam a retentar 2–3x ou enfileirar job durável com schedule curto (30s/5min/10min) e **nunca** retornar ok cego | `siso_fila_execucao` (backoff+claim), `registrarEvento`, recovery por cron |
| **Wiring de liberar/estornar reserva no cancelamento** | 6 | todo cancelamento chama `liberarReserva`/`estornarReservaIndividual` + cancela o job na fila; webhook auto-aprovação vira reserva all-or-nothing | `estornarReservaIndividual` (idempotente), `liberarReserva`, padrão já vivo em vendas-cancelamento |
| **Invalidação de cache/limpeza de derivados na escrita** | 4 | invalidar cache PrintNode no PATCH/DELETE; apagar composição de kit ao virar não-kit; varredura de pedidos parados ao corrigir saldo 0→+ | `invalidarCacheImpressora*` (já existem), `varrerPedidosAfetadosPorEntrada` |
| **Guard de permissão específica no backend** | 4 | rotas que usam gate genérico passam a exigir `userCan(session,'<perm>')`→403; anti-lockout (último admin); vendedor inativo some do dropdown | `userCan/userCanAny`, registry de 38 códigos, anti-lockout de roles |
| **Won't-fix / already-fixed por decisão** | 4 | sem código: P092 defere sync, P041 mantém unlink, P042 permite cancelar, P004 conta com acerto. Documentar + regressão | `wms_detectar_pedidos_inconsistentes` |

---

## As 6 fases (ordem de execução — fundação-primeiro)

> **Regra:** fundações atômicas primeiro → aplicação domínio a domínio do **menor pro maior blast-radius** → bugs pontuais e UX por último.

| Status | Fase | Tema | Probs | Depende de | Arquivo de plano |
|:--:|:--:|---|--:|:--:|---|
| ✅ **FEITO** | **1** | Fundações atômicas: claim de header + envelope RPC (provado no menor blast) + reclaim de fila | 13 | — | `docs/superpowers/plans/2026-06-04-raio-x-fase-1-fundacoes-atomicas.md` |
| ✅ **FEITO** | **2** | Backstops de banco: UNIQUE/CHECK + guard de custo + MV de cobertura | 12 | — | `…-fase-2-backstops-banco.md` |
| ✅ **FEITO** | **3** | Permissões backend + wiring de liberação de reserva no cancelamento | 9 | 1 | `…-fase-3-permissoes-reservas.md` |
| ⬜ pendente | **4** | Menor blast: inventário, devoluções, transferências, recebimento, guarda (RPCs atômicas + guards) | 19 | 1,2 | `…-fase-4-dominio-menor-blast.md` |
| ⬜ pendente | **5** | Maior blast: ledger central, cutover, vendas, pick parcial, aplicar inventário, durabilidade | 17 | 1,2,**4** | `…-fase-5-dominio-critico.md` |
| ⬜ pendente | **6** | Bugs pontuais, UX, idempotência de frontend, visibilidade, correção de estoque→ledger | ~75 | 1–5 | `…-fase-6-pontuais-ux-visibilidade.md` |

> **Status (2026-06-06):** Fases **1, 2 e 3 concluídas** e mergeadas no `develop` (cada problema via TDD red→green, migrations aplicadas no staging `ehbxpbeijofxtsbezwxd`, revisão de spec + qualidade por subagente). Próxima: **Fase 4**.

> **Fase 4 → Fase 5 são SEQUENCIAIS, não paralelas.** Dois motivos: (1) **infra (decisivo):** ambas aplicam migrations no mesmo staging e seus testes de integração **truncam as tabelas operacionais** (`truncateOperacional` + `maxWorkers:1`) — duas runs simultâneas corromperiam os dados uma da outra; (2) **lógica:** a 5 depende da 4 (mesmos domínios/arquivos no maior blast — ex.: inventário, onde a 4 faz *estornar/contagem* e a 5 faz *aplicar*, ambos em `inventario.ts` e na mesma máquina de estados de sessão → conflito de merge). Rodar **4 primeiro, depois 5**.

> A Fase 6 é grande (catch-all de baixo blast); o arquivo de plano dela será **subdividido em sub-grupos coesos** (separação-UX, compras/devolução, sync-tiny, relatórios, impressão, frontend, visibilidade, correção-estoque-ledger) pra ficar executável.

---

## PRs sugeridos (por fase)

`✅` = precisa migration/RPC nova. Cada PR = 1 correção coesa ou merge-group.

| Fase | Esf | Mig | PR | Problemas |
|:--:|:--:|:--:|---|---|
| 1 | S |  | Reclaim de jobs estagnados na fila (timeout 5min volta a pendente) | P145 |
| 1 | M | ✅ | Lock de recebimento de transferência: cancel respeita/adquire o mutex + timeout 30min | P062, P068, P066 |
| 1 | M |  | Force-unlock 'Tomar de Fulano' na guarda + aviso >30min | P127 |
| 1 | S |  | Aprovar sessão de inventário idempotente (compare-and-set status='revisao') | P160 |
| 1 | M | ✅ | RPC `wms_confirmar_item_embalagem_atomico`: soma atômica + dedup por client_request_id | P130, P129, P131 |
| 1 | S | ✅ | Decremento atômico de quantidade_bipada (desfazer-bip) | P021 |
| 1 | M | ✅ | RPC `wms_set_role_permissoes`: replace tudo-ou-nada + FOR UPDATE serializa edição | P138, P139 |
| 1 | M | ✅ | Claim atômico de classify de devolução (compare-and-set status) — base p/ fase 4 | P052 |
| 2 | S | ✅ | UNIQUE estorno único por `estorno_de` (promover idx a UNIQUE) + 23505 idempotente | P106 |
| 2 | S | ✅ | UNIQUE parcial fornecedor preferencial por produto + disabled no botão | P124, P125 |
| 2 | S | ✅ | UNIQUE parcial sessão de inventário por (galpão,dia) + 409 amigável | P055 |
| 2 | M | ✅ | Trigger kit→≥1 componente (cobre sync e escrita direta) | P120 |
| 2 | M | ✅ | Dedup de recebimento por assinatura NF (UNIQUE parcial) — saldo/custo não dobram | P099, P109 |
| 2 | L | ✅ | Guard custo-zero + reversão de custo médio no estorno (recria `wms_inserir_movimentacao`) | P108, P110, P104 |
| 2 | S |  | Upsert no auto-cadastro de fornecedores por prefixo (contagem correta) | P123 |
| 2 | S | ✅ | Recriar MV `siso_cobertura_estoque` no shape 3D (reverte regressão 20260605) | P128 |
| 3 | S |  | Guard backend de permissão específica em /ajuste e /localizacoes/lote | P069, P116 |
| 3 | M |  | Anti-lockout: recusar desativação do último admin ativo | P136 |
| 3 | S |  | Cancelar job na fila ao estornar pedido + alinhar status/status_separacao | P008 |
| 3 | M |  | Liberar reserva R nos caminhos de cancelamento (recusar pedido, cancelar item de compra) | P034, P038, P039 |
| 3 | M | ✅ | **[D1]** Cancelar pedido em separação parcial (venda manual **+ `/separacao/cancelar` marketplace**): libera só não-pego, pego vira pendência de devolução manual — RPC atômica | P007 |
| 3 | M |  | Reserva all-or-nothing no webhook auto-aprovação + dedup R viva por (pedido,produto) | P085, P003 |
| 4 | M |  | Guard de status da sessão no bipe + reconciliação temporal desde início do dia | P058, P059 |
| 4 | L | ✅ | RPC `wms_estornar_sessao_inventario` (tudo-ou-nada) + estorno por divergência individual | P056, P061, P159 |
| 4 | M | ✅ | RPC `wms_contagem_inline_atomica` (acerto de prateleira no pick) | P057 |
| 4 | L | ✅ | RPC `wms_classificar_devolucao`: movs+status atômicos + preflight quarentena | P049, P050, P051, P054 |
| 4 | M | ✅ | RPC `wms_desfazer_recebimento_transferencia` atômica + preflight "quanto dá pra desfazer" | P067, P065 |
| 4 | M |  | Reverter replenishment com estorno parcial residual | P078 |
| 4 | M |  | Recebimento all-items tudo-ou-nada (receberItensViaOC para de engolir falha) | P028 |
| 4 | M |  | Cross-check produto bipado na guarda + escape-hatch manual | P029 |
| 4 | M |  | Over-receive: categorizar excedente como ganho de inventário | P033 |
| 4 | S |  | Não desativar/excluir loc com saldo/reserva/pendência/perna de transferência/contagem ativa | P115, P063, P113 |
| 5 | L | ✅ | RPC `wms_aplicar_sessao_inventario` (aplicar tudo-ou-nada) | P060 |
| 5 | L | ✅ | RPC `wms_pick_parcial_atomico` (L+S+ajuste do wave) + idempotency token no pick sem-reserva | P019, P072 |
| 5 | M | ✅ | ⚠️**D4** RPC `wms_desmarcar_item_atomico` + estorno tolerante (clamp R + status_alerta) | P014, P015 |
| 5 | L | ✅ | RPC `wms_reverter_cutover_atomico` (reversão tudo-ou-nada) | P023 |
| 5 | L | ✅ | RPCs `wms_vender_baixa_direta_atomico` + `wms_cancelar_venda_atomico` | P075, P077 |
| 5 | M | ✅ | Enqueue durável + atômico da aprovação (RPC `wms_aprovar_e_enfileirar`) com retry | P005 |
| 5 | M | ✅ | RPC `wms_reconciliar_retroativo` (lock + idempotência + estorno parcial) — unifica 5 | P152, P150, P151, P147, P148 |
| 5 | L | ✅ | Durabilidade do reconciliador OC + varredura pós-entrada (jobs com retry 30s/5min/10min) | P082, P149 |
| 5 | M |  | Resolução de pedido-fantasma (R→S se saiu, R→prateleira se cancelado) | P084 |
| 6 | S |  | Registrar erros de separação no histórico do pedido | P006 |
| 6 | S |  | Reordenar iniciar: consolida (RPC) antes de marcar em_separacao + reportar já_em_separacao | P012, P153 |
| 6 | M | ✅ | Guards de pré-condição (qty=0, NF nf_venda, concluir-oc multi-galpão, trocar-sku, voltar-etapa stale) | P017, P074, P031, P036, P154, P081 |
| 6 | L | ✅ | Validar pedido na chegada (qty=0 rejeita, nomeia item) + kit sem cadastro Tiny (flag, não dropar) | P001, P002, P095 |
| 6 | L | ✅ | **[D3/D5]** Correção de estoque no `/api/wms/ajuste` (ledger-only, auditável, lock, varredura, idempotency, guard 0; **P090: aceita físico, libera R a descoberto, alerta + enfileira compra do excedente**) | P086, P089, P166, P164, P165, P184, P087, P090, P091, P093, P088 |
| 6 | M |  | **[D2]** Guards de compra/devolução: estorno na devolução, bloqueio lançado, status OC (**P035: reentra só se cancelada, não se indisponível**), equivalente cria item novo | P040, P047, P046, P045, P035, P155, P053, P070 |
| 6 | M | ✅ | Sync-tiny: surfacing de erro sem mapeamento + filtro produtos sem mapeamento + kit→não-kit limpa + kit vazio + empresa determinística | P117, P118, P171, P098, P097, P169, P170, P176 |
| 6 | S |  | Relatório movs-por-empresa: default 12m + paginação + filtro SQL de empresa + excluir devoluções | P105, P107, P158 |
| 6 | M | ✅ | Etiqueta/impressão: reimprimir retry 3x + 2 labels + retenção 30d + invalidar cache + preview delete conta | P142, P144, P143, P183, P141 |
| 6 | M | ✅ | Pointwise: lead default 7d, qty inteira transferência, packing no type, sku duplicado 409, reativar/bloquear vínculo fornecedor, kit qty≥1 | P079, P162, P173, P174, P178, P179, P133, P121 |
| 6 | M | ✅ | Frontend idempotency/UX: key estável (venda nova), botões disabled, surfacing de erro, forms galpão obrigatório | P071, P043, P146, P185, P168, P163, P134, P137, P076 |
| 6 | M |  | Marcar-item idempotente pós-reconexão (UX) + concluir no-regress + crossdock no-regress | P013, P073, P080 |
| 6 | L | ✅ | Visibilidade: realtime+Reabrir divergências, auditoria de produto, contagem de kit, deposito no pedido, insight operador inativo, limpa operador no estorno embalagem | P161, P180, P175, P122, P132, P182 |
| 6 | M |  | Durabilidade residual: token ML retry+alerta, cleanup locks órfãos >24h, cancelOcIfEmpty retry+surfacing | P094, P126, P048 |
| 6 | S |  | Won't-fix / regressão: travar comportamento (acerto, unlink, permite-cancelar, defer) | P004, P041, P042, P092 |

---

## ✅ Decisões de produto (RESOLVIDAS pelo dono — 2026-06-05)

| # | Probs | Decisão |
|:--:|---|---|
| **D1** | P007 | **Estender ao marketplace também.** Aplicar "libera só o não-pego; o pego vira pendência de devolução manual" tanto na venda manual (`cancelarVendaManual`) **quanto no fluxo `/separacao/cancelar`** dos pedidos de marketplace. Blast maior — toca o caminho quente de separação; tratar com cuidado (RPC atômica + teste de concorrência). |
| **D2** | P035 | **Distinguir o motivo.** Pedido volta a `pendente` **só** quando a OC foi **cancelada** (pode re-rotear). Se o item é genuinamente **indisponível/esgotado**, o pedido **não** reentra (estado terminal) — evita loop de re-roteamento. Requer marcar o motivo do término da OC. |
| **D3** | P090 | **Aceitar o físico + liberar a R a descoberto + alertar + enfileirar compra do excedente.** A correção aplica o saldo físico (verdade), **libera** (R→prateleira) a parte da reserva sem lastro (mantém o invariante `reservado<=saldo` intacto), gera **alerta** de reserva a descoberto, **e já enfileira a necessidade de compra (OC)** da quantidade faltante. Conecta com o fluxo de compras/necessidade. |
| **D4** | P014/P015 | **Estratégia técnica vence.** Estorno tolerante com clamp da R ao saldo livre + `status_alerta`, tudo na mesma tx atômica (fiel ao ledger imutável). P015 `respeita_nota=false` é aceitável aqui. |
| **D5** | P086/P166 | **Verificado:** `tiny/stock/ajustar/route.ts` **não tem caller no frontend** (dead-path). A correção de estoque viva é `/api/wms/ajuste` (page + modal + `movimentacoes.ts`). A migração consolida a correção no `/api/wms/ajuste` (ledger-only, auditável); `tiny/stock/ajustar` é ignorado. |

---

## Conflitos resolvidos (técnicos — não precisam do dono)

1. **P056/P060/P061** — 1 migration com 2 RPCs (`wms_aplicar_sessao_inventario`, `wms_estornar_sessao_inventario`) compartilhando helper de preflight. P056+P061 no mesmo PR (fase 4); P060 fase 5 (maior blast).
2. **P099/P109** — 1 índice único parcial + captura 23505 cobre os dois. Mesmo PR fase 2.
3. **P108/P110** — 1 migration recria `wms_inserir_movimentacao` com os dois guards (custo-zero + reversão no estorno). Fase 2.
4. **P124/P125** — migration do P124 é o backstop do P125; P125 só adiciona `disabled`. Mesmo PR fase 2.
5. **P138/P139** — RPC `wms_set_role_permissoes` faz `FOR UPDATE` do role (serializa P139) + delete+insert atômico (P138). Fase 1.
6. **P049/P050/P051/P052/P054** — 1 RPC `wms_classificar_devolucao`: claim de status (P052) → preflight quarentena (P051) → movs+status na mesma tx (P049/P050/P054). Fase 4.
7. **P150/P151/P152/P147/P148** — 1 RPC `wms_reconciliar_retroativo`: lock por lançamento + checagem de estorno existente + estorno parcial clampado. Fase 5.
8. **P046/P047** — mesma rota; **P047 roda primeiro** (409 se lançado), só se não-lançado P046 grava o estorno. Mesmo PR fase 6.
9. **P105/P107/P158** — 1 PR no mesmo `route.ts`: default 12m + paginação (P105) + filtro SQL de empresa (P107) + excluir devoluções (P158). Fase 6.
10. **P134/P137** — helper puro `calcDisabled` compartilhado entre criar e editar operador. Mesmo PR fase 6.
11. **P099/P146/P184** — 1 coluna `idempotency_key` (uuid) + unique partial em `siso_movimentacoes`, reusada pelos três. Não duplicar infra.
12. **P178/P179** — não colidem: P179 bloqueia delete; P178 reativa vínculo no reimport (ortogonal). Revisar juntos.

---

## Quick wins (começar por aqui dentro de cada fase)

`P145 · P160 · P021 · P006 · P012 · P017 · P058 · P069 · P116 · P008 · P106 · P123 · P128 · P164 · P158 · P173 · P174 · P163 · P185 · P071 · P143 · P148 · P150 · P132 · P124 · P055`

---

## Harness de testes (o que cada passo TDD usa)

| Harness | Comando | Quando | Onde |
|---|---|---|---|
| **Unit (vitest)** | `npm test -- <arquivo>` | lógica pura (calc, seletores, reducers, guards puros) | `src/**/*.test.ts` |
| **Integration** | `npm run test:integration` | atomicidade/concorrência/RPC contra **staging real** (serializado, `maxWorkers=1`, stubs Tiny/ML/PrintNode on, **trunca tabelas operacionais**) | `test/integration/**/*.test.ts` |
| **Scenarios (E2E HTTP)** | `npm run scenarios` (`:only` p/ um) | fluxo de rota `/api/wms/*` ponta-a-ponta | `scripts/wms/cenarios/catalogo/NN-*.ts` (export `Cenario`: `setup/run/assertEsperado`) |

- **RPC/migration:** arquivo em `supabase/migrations/YYYYMMDD_*.sql` + aplicar via `mcp__supabase__apply_migration` no project **`ehbxpbeijofxtsbezwxd`** (staging).
- Cada bug-fix **deve** virar entrada em `erros-conhecidos.yaml` (grep antes, adicionar depois).

---

## Como executar este plano

1. Resolver **D1–D5** (acima) — desbloqueia autoria fiel.
2. Para cada fase, abrir o arquivo `docs/superpowers/plans/2026-06-04-raio-x-fase-N-*.md` e executar via **`superpowers:subagent-driven-development`** (1 subagent por task, review entre tasks) — TDD estrito: RED → ver falhar → GREEN mínimo → ver passar → commit.
3. Ordem: **Fase 1 → 2** (podem ir em paralelo, sem deps entre si) → **3** → **4** → **5** → **6**.
4. Ao fim de cada fase: rodar `npm test` + `npm run test:integration` + `npm run scenarios` e atualizar `docs/` + `erros-conhecidos.yaml` no mesmo commit.

> Dados-fonte desta análise: `_master_acionaveis.json` (154 problemas + decisão + nota), `_reinvest_findings.json` (154 achados re-investigados), `_reinvest_synthesis.json` (primitivas/fases/PRs/conflitos).
