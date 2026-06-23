# HANDOFF — Corrigir BUG-09 (idempotência do parcial) + BUG-A (trocar SKU pós-troca-aplicada)

> Cole este prompt inteiro numa sessão NOVA do Claude Code no repo `/Users/eryk/Documents/ESTOQUE`.
> É autocontido. São DOIS bugs independentes — pode fazer um, validar, depois o outro.
> A "coesão" entre eles é ENGANOSA: leia os ⚠️ antes de mudar qualquer coisa.

## AMBIENTE & SEGURANÇA (LEIA ANTES DE TUDO)
- Staging é **ambiente VIVO** (pedidos reais), projeto Supabase `ehbxpbeijofxtsbezwxd`, branch `develop`. **NUNCA** prod (`wrbrbhuhsaaupqsimkqz`/`main`).
- **NUNCA** `npm run scenarios` / `test:integration` / `seed:staging` (truncam tabelas) nem setar `ALLOW_STAGING_WIPE`. Sem isso eles abortam — é a proteção.
- Pra testar ao vivo: **dado isolado** (produto/galpão/loc com prefixo `TEST-`), escreva só no seu SKU, limpe só suas linhas. O ledger é chaveado por `(produto, galpão, loc)` — não mistura com dado real. Mostre ao Eryk o que vai criar/deletar ANTES de rodar.
- Migrations (CREATE OR REPLACE FUNCTION é não-destrutivo): arquivo em `supabase/migrations/` + aplicar no project staging. Confirme com o Eryk antes de aplicar.
- Validação obrigatória ao terminar: `npx tsc --noEmit` (0 erros novos) · `npx eslint <arquivos>` · `npx vitest run --exclude '**/realoc-fix-pack.test.ts'` (deve ficar verde; `realoc-fix-pack` escreve em staging e tem UUID stale — ignore).
- Toda correção vira entrada em `erros-conhecidos.yaml` (grep antes, adicione depois).

## CONTEXTO JÁ APLICADO (não refaça, mas saiba)
Numa sessão anterior já foram corrigidos (mesmo módulo): pick-mov agora delega L+S à RPC `wms_pick_item_atomico` (atômico, seta `origem_id=pedido` na S); `marcar-realocacao` seta `origem_id=pedido`; voltar-etapa/desfazer-bip fail-loud na reversão; cancelar-com-picks cria pendência em `siso_devolucoes_pendentes`. Detalhes: `docs/relatorio-fixes-separacao-estoque.md` e `docs/auditoria-separacao-estoque.md`.

---

# BUG-09 — Parcial não-idempotente (replay duplica baixa) [ALTA]

## O problema (concreto)
Operador faz um parcial: pegou 4 de 10. No ramo **`loc_zerou=false`** (prateleira ainda tem saldo), o item fica **propositalmente ABERTO** (`separacao_marcado=false`, `separacao_parcial=false`). Se o request for **reenviado** (timeout+retry, ou duplo-clique), o replay com o MESMO body:
1. **Passa** o guard de re-entrada (`parcial/route.ts:139` rejeita só `separacao_marcado || separacao_parcial` — ambos false);
2. Emite uma **2ª saída S** (baixa de estoque dobrada);
3. **Infla `quantidade_pega`** (4 → 8) — o operador pegou 4 fisicamente, o sistema conta 8.

## Anchors no código (verifique antes de mudar)
- `src/app/api/wms/separacao/parcial/route.ts` (**2456 linhas, 2 caminhos**: parcial simples ~L390-960; parcial de realocação ~L1340-2000):
  - body parse: `L41` (`request.json()`); guard re-entrada: `L139`; teto `quantidade_pega > totalFaltante`: `L174`.
  - chama `wms_pick_parcial_atomico`: **`L394`** (emite a S).
  - chama `wms_acumular_qty_pega`: **`L654`, `L890`, `L1980`** (acumula a qty).
  - **O próprio código admite o bug** em `L649-650`: *"RPC é idempotente em retry? Não — wms_acumular_qty_pega é UPDATE com soma. Em retry duplica."*
- RPCs:
  - `wms_pick_parcial_atomico` (`supabase/migrations/20260607e_rpc_pick_parcial_atomico.sql`): emite `S(qty_pega)` + `S(ajuste_pick_zerou)` via `wms_inserir_movimentacao`. **NÃO aceita `p_idempotency_key`.**
  - `wms_acumular_qty_pega` (`supabase/migrations/20260518_realocacao_fix_pack_rpc_acumular.sql`): `UPDATE ... SET quantidade_pega = COALESCE(quantidade_pega,0) + p_delta`. **Não-idempotente.**
  - `wms_inserir_movimentacao`: **JÁ aceita `p_idempotency_key`** (no-op via UNIQUE parcial `uq_mov_idempotency_key WHERE idempotency_key IS NOT NULL`).

## Abordagem recomendada
**Idempotency-key vinda do cliente, namespada por operação.** Passos:
1. **Cliente**: o modal/ação de confirmar parcial gera UMA `idempotency_key` (uuid v4) por clique de confirmação e a envia no body. Encontre o componente que faz `POST /api/wms/separacao/parcial` (procure `sisoFetch`/`fetch` + `"parcial"` em `src/components/wms/separacao/**` e `src/app/wms/**`) e gere a key no submit (não derive do estado do item — cada confirmação é uma key nova).
2. **RPC `wms_pick_parcial_atomico`**: adicione `p_idempotency_key uuid DEFAULT NULL` e propague pra S de `nf_venda` (`p_idempotency_key := p_idempotency_key`). Migration nova CREATE OR REPLACE; **dropar o overload antigo** pra evitar ambiguidade no PostgREST (veja o padrão em `20260607d_pick_item_atomico_idempotency.sql:12`).
3. **Idempotência da qty** (a parte difícil): a S dedup sozinha pela key, mas `wms_acumular_qty_pega` ainda dobraria. Faça a acumulação **condicional ao S ter sido realmente inserido**. Recomendado: mova a acumulação PARA DENTRO de `wms_pick_parcial_atomico` (S + acúmulo na mesma tx, governados pela mesma idempotência) — assim o `p_delta` só aplica quando a S é nova. Se preferir manter a acumulação no route, a RPC precisa **retornar um flag `ja_aplicado`** (detectando que a key já existia) pro route pular `wms_acumular_qty_pega`.

## ⚠️ Potenciais erros (NÃO tropece)
- **Multi-pedido / multi-item por request**: um parcial de WAVE cobre VÁRIOS pedidos/itens. Há `wms_acumular_qty_pega` em 3 sites e a S de realocação consolidada (`L1612`) cobre N pedidos numa só S. **A key precisa ser namespada por mov distinta** (ex.: `${key}:s:${item_id}` / `${key}:ajuste`). Uma key única reusada em movs diferentes do mesmo request será **REJEITADA** pelo UNIQUE (não vira no-op) → quebra o caminho feliz. Mapeie quantas movs/acúmulos um request emite ANTES de escolher o esquema de namespacing.
- **Não quebre o 2º parcial legítimo**: pegar mais 3 depois é uma ação DIFERENTE com key NOVA — não pode ser deduplicada contra a primeira. Por isso a key é por-clique, nunca derivada do item.
- **Não confie no guard L139 nem no teto L174** pra idempotência: no ramo residual ambos passam no replay.
- **Dois caminhos**: o fix tem que cobrir parcial simples (~L390) E parcial de realocação (~L1340). Teste os dois.
- **`ajuste_pick_zerou`**: a S de ajuste também precisa de key própria (senão replay com `loc_zerou=true` dobra o write-off permanente).
- **Cliente que não auto-retenta**: confirme se o `POST` realmente é retentado (React Query mutation normalmente NÃO retenta POST). Se o único vetor real for duplo-clique, um `disabled` no botão durante o submit já mitiga 90% — mas a idempotency-key é a defesa correta e robusta. Implemente a key; mencione o `disabled` como reforço.

## Aceite / testes
- Teste: replay do MESMO request (mesma key) → exatamente **1 S** e `quantidade_pega` aplicado **1×**. Request com key NOVA → aplica de novo (não dedup).
- Cubra os 2 caminhos (simples + realocação) e `loc_zerou` true/false.
- Invariantes após: soma de S `nf_venda` por pedido == soma de `quantidade_pega`; `wms_detectar_divergencias_estoque()` = 0. Use `scripts/wms/cenarios/_harness/invariantes.ts` (`rodarInvariantes`).

---

# BUG-A — Trocar SKU pelo equivalente DEPOIS de concluído [BAIXA, mas é o caso que o Eryk pediu]

## ⚠️ COESÃO ENGANOSA — leia primeiro
O caso COMUM **JÁ FUNCIONA, não mexa nele**: item que **nunca teve troca**, picado errado (SKU original errado), pedido concluído →
`voltar-etapa` (pra `aguardando_separacao`) → `solicitarTroca` → `aprovar` → re-picar. Isso é consistente em estoque (reset-state estorna a S, recria a R; o status guard de `solicitarTroca` passa porque a separação NÃO seta `pedido.status='concluido'` — voltar-etapa mexe só em `status_separacao`).

**O bug é SÓ um beco-sem-saída ESTREITO**: quando uma troca **JÁ foi APLICADA** (item com `produto_wms_substituto_id` setado) e, após reabrir, o operador quer trocar pra um **3º SKU** (ou desfazer a troca e voltar ao original). Aí TUDO trava:
- `solicitarTroca` → `TROCA_JA_APLICADA` (`trocas-equivalencia.ts:207-212`, porque `item.produto_wms_substituto_id` está setado).
- `trocarSubstitutoDaTroca` → `TROCA_NAO_PENDENTE` (`:558`, a troca está `aprovada`, não `pendente`).
- `rejeitarTroca`/`cancelarTroca` → RPC `wms_encerrar_troca_atomico` dá `RAISE TROCA_NAO_PENDENTE` pra troca não-pendente (`20260612f`) e **não limpa** os campos do item.
- `reset-state.ts:257-273` reseta 11 campos do item mas **NÃO** `produto_wms_substituto_id` nem `troca_equivalencia_id` (de propósito — ver ⚠️ abaixo).

## Anchors no código
- `src/lib/wms/trocas-equivalencia.ts`: `solicitarTroca` (L190, guard L207-212/236-257) · `aprovarTroca` (L465) · `trocarSubstitutoDaTroca` (L542, guard L558) · `rejeitarTroca` (L680) · `cancelarTrocasPendentesDoPedido` (L733). Erro tipado: `TrocaError`.
- Único writer de `produto_wms_substituto_id`: RPC `wms_aprovar_troca_atomico` (`supabase/migrations/20260612f_troca_equivalencia.sql:192-195`). Colunas do item: `20260612f:80-81`.
- `siso_trocas_equivalencia.status` CHECK: `20260612f:55-59` (verifique os valores aceitos antes de criar um status novo).
- `reset-state.ts:257-273` (campos resetados — note a ausência dos 2 de troca).
- `resolverProdutoEfetivoDoItem` em `src/lib/separacao/wms-mapping.ts` (resolve o produto FÍSICO: substituto se houver, senão original — todo pick/reserva passa por aqui).
- `item.produto_id` (tiny/fiscal) é **INTOCÁVEL** (D3 — NF/Tiny mantêm o SKU vendido). Só o FÍSICO muda via `produto_wms_substituto_id`.

## Estado de estoque após reabrir um pedido com troca aplicada
`voltar-etapa`→`aguardando_separacao` roda reset-state: estorna a S do substituto, recria a **R `reserva_pedido` no SUBSTITUTO** (via os links de pick). `produto_wms_substituto_id` continua setado. Ou seja: há R viva no substituto, item destravado pra re-picar **o mesmo substituto**. Isso é o correto pro caso "re-picar a mesma peça".

## Abordagem recomendada — capability "desfazer troca aplicada"
NÃO automatize dentro do reset-state (ver ⚠️). Crie uma ação EXPLÍCITA:
1. **RPC nova atômica** `wms_desfazer_troca_aplicada_atomico(p_pedido_item_id, p_usuario_id)`:
   - Trava o item (`FOR UPDATE`); valida que está **reaberto e não-picado** (`status_separacao ∈ {aguardando_separacao, em_separacao}`, `separacao_marcado=false`, `quantidade_pega` nulo/0). Se já picado → RAISE (não dá pra desfazer troca cujo estoque já saiu).
   - Libera a R `reserva_pedido` viva no **substituto** (mov `L`).
   - Limpa `produto_wms_substituto_id = NULL`, `troca_equivalencia_id = NULL` no item.
   - Marca o registro `siso_trocas_equivalencia` como encerrado (status novo `desfeita` — **adicione ao CHECK** se não existir; NÃO reuse `wms_encerrar_troca_atomico`, que exige pendente).
   - **NÃO** recria R no original aqui (deixe o item sem R) — re-roteie no passo 2. (Decida com o Eryk: recriar R no original automaticamente exige saldo do original no galpão; sem saldo, vira OC. Mais simples: deixar sem R e re-rotear.)
2. **Endpoint** `POST /api/wms/trocas/desfazer-aplicada` (ou `/trocas/[id]/desfazer`), gated por `vendas.aprovar_troca`.
3. Após desfazer, o item tem `produto_wms_substituto_id=NULL` → `solicitarTroca` passa o guard de novo → operador escolhe o 3º SKU, OU re-roteia/pica o original (chame o re-roteamento existente — `rotear` / `rotearPedidoDoBanco` — pra recriar a R no produto efetivo).

## ⚠️ Potenciais erros (NÃO tropece)
- **NÃO limpe `produto_wms_substituto_id` cego no reset-state**: o reset roda em TODO voltar-etapa/reiniciar; o caso normal quer MANTER o substituto pra re-picar a mesma peça. Limpar lá forçaria re-decidir a troca toda vez que reabre. A limpeza tem que ser ação explícita "desfazer troca".
- **Ordem das movs**: libere a R do substituto ANTES de recriar qualquer R no original (senão dupla reserva / viola `CHECK reservado<=saldo`).
- **Só permita desfazer quando o substituto NÃO foi picado** (qty_pega=0, item não marcado). Se a S do substituto já saiu, desfazer cega deixaria estoque inconsistente — exija reabertura/estorno antes (ou bloqueie).
- **`item.produto_id` (fiscal) intocável** — não mexa; a NF mantém o SKU vendido. Só o `produto_wms_substituto_id`.
- **`resolverProdutoEfetivoDoItem`**: após limpar o substituto, o item volta a resolver pro original. Garanta que todo caminho de pick/reserva re-resolve (não cacheie o produto efetivo).
- **Status enum de `siso_trocas_equivalencia`**: confira o CHECK (`20260612f:55`) antes de gravar `desfeita`; pode precisar ALTER do CHECK.
- **Confirme a premissa do caso comum**: valide que `pedido.status` permanece `executando` após reabrir um pedido concluído (grep mostrou que a separação não seta `concluido`; se algum fluxo setar, o caso comum também quebra e o escopo cresce). Teste o caminho comum ANTES de assumir que só o beco-sem-saída precisa de fix.

## Aceite / testes
- Reproduza: aplique uma troca (par verificado, auto) → conclua → `voltar-etapa` → confirme que `solicitarTroca`/`trocarSubstituto` dão erro hoje (beco-sem-saída).
- Depois do fix: `desfazer-aplicada` → `produto_wms_substituto_id=NULL`, R do substituto liberada, sem R órfã, troca marcada `desfeita`; então `solicitarTroca` pra um 3º SKU funciona OU o original é re-roteado/picável.
- Invariantes: `rodarInvariantes` (sem R órfã, `reservado<=saldo`, ledger↔cache = 0).
- Confirme que o caso COMUM (item nunca-trocado) continua funcionando inalterado.

---

## Formato de reporte (ambos)
Para cada fix: o que mudou (arquivo:linha), a situação concreta que passa a acontecer / deixa de acontecer, e a entrada em `erros-conhecidos.yaml` (ids sugeridos: `parcial-replay-double-s-idempotencia`, `troca-aplicada-beco-sem-saida-desfazer`). Atualize `docs/database-schema.md` se criar coluna/status, `docs/api-reference-complete.md` se criar rota.
