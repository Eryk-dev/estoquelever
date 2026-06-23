# Relatório de Correções — Separação + Estoque (2026-06-22)

Fixes aplicados após a auditoria adversarial (`docs/auditoria-separacao-estoque.md`).
Cada item: o que mudou, e a **situação concreta** que passa a acontecer / deixa de acontecer.

**Validação:** `npx tsc --noEmit` (0 erros novos) · `eslint` (0 erros) · suíte unit **486/486 verde**
(exceto `realoc-fix-pack.test.ts`, que escreve em staging e tem UUID de loc stale — test-rot, não bug de produto). Nenhuma escrita em dados vivos de staging foi feita.

---

## 1. BUG-06 + BUG-07 — Pick do scanner agora atômico (ALTA)
**Arquivo:** `src/lib/wms/separacao/pick-mov.ts` (+ teste)
**Mudança:** `pickMovPicking` agora delega o par L+S à RPC `wms_pick_item_atomico` (a mesma do `marcar-item`), em vez de emitir L e S em duas transações separadas.

- **ANTES (acontecia):** dois bips simultâneos do MESMO item no checklist (`/bipar-checklist`) — ou o operador clicando 2×, ou retry — passavam os dois pelo guard `if(item.mov_saida_id)` (que lê o estado ANTES do pick). Resultado: **2 pares L+S → baixa dupla de estoque**; numa loc de picking com reserva compartilhada (vários pedidos, mesmo SKU), o 2º consumia a reserva de OUTRO pedido. Também: se a S falhasse depois do L já ter commitado, sobrava uma **L órfã** (saldo reaparecia como disponível = janela de overselling).
- **AGORA (não acontece mais):** a RPC trava a reserva (`FOR UPDATE`) e rejeita a 2ª chamada com "reserva já liberada" → o item simplesmente não é re-picado (sem dupla baixa). L+S saem numa única transação — ou os dois, ou nenhum (sem L órfã).
- **Resíduo:** o ramo SEM reserva (OC "bipa onde achou") ainda não passa `idempotency_key` — double-tap simultâneo sem reserva pode duplicar (raro). Documentado.

## 2. BUG-02 — Retrocesso estorna a S de realocação (ALTA)
**Arquivos:** `src/app/api/wms/separacao/marcar-realocacao/route.ts`, `pick-mov.ts`
**Mudança:** a S de venda passa a carregar `origem_id = pedido` (no pick principal isso vem de graça via a RPC do item 1; na realocação single-pedido foi adicionado explicitamente).

- **ANTES:** você embala um pedido cujo item foi picado via **realocação** (cascade — a peça estava em outra loc). Faz `desfazer-bip` (embalado→em_separacao). A RPC de reversão procurava a S por `origem_id=pedido` ou pelo `mov_saida_id` do item — mas a S de realocação grava o `mov_saida_id` em OUTRA tabela (`siso_pedido_item_realocacoes`) e não tinha `origem_id`. Resultado: a S de realocação **ficava sem estorno → estoque fantasma a menos** e a reserva nunca era recriada.
- **AGORA:** a S de realocação tem `origem_id=pedido` → a RPC a encontra, estorna (E) e recria a reserva. Saldo volta certo no retrocesso.
- **Resíduo:** a S **consolidada de wave** do `/parcial` (uma S cobrindo VÁRIOS pedidos) NÃO foi taggeada — tag de 1 pedido faria super-estorno dos outros. Fica como limitação conhecida.

## 3. BUG-10 — Reversão de estoque que falha não é mais silenciosa (ALTA)
**Arquivos:** `voltar-etapa/route.ts`, `desfazer-bip/route.ts`
**Mudança:** os dois callers checam o retorno de `reverterCutoverSeRetrocedeu`; se a RPC falhou (`motivo='rpc_error'`), gravam `logError` e respondem **500** em vez de `{ok:true}`.

- **ANTES:** você volta um pedido `embalado`→`aguardando_separacao`. Se a RPC de reversão falhasse (lock, erro transitório), o endpoint **respondia 200 e o status retrocedia mesmo assim** — mas `estoque_lancado` continuava `true` e a S continuava viva. Ao re-picar depois: **baixa DUPLA**.
- **AGORA:** falha da reversão → 500 + erro registrado (`siso_erros`) + (no voltar-etapa) a lista de `pedido_ids` que falharam. Como a operação é idempotente, repetir converge. O estado incoerente "status pra trás + estoque lançado" deixa de ser silencioso.

## 4. BUG-12 — Cancelar pós-pick não vaza mais estoque em silêncio (ALTA)
**Arquivos:** `src/lib/wms/devolucoes.ts` (helper novo), `cancelar/route.ts`, `pedido-cancel-handler.ts`
**Mudança:** ao cancelar um pedido com item já pego, cria uma **pendência forte de devolução** por item (`siso_devolucoes_pendentes`, apontando pra S do pick), idempotente por `mov_saida_id`.

- **ANTES:** pedido com item picado (peça já fora da prateleira) é cancelado. A S **não** é estornada (correto — a peça saiu de verdade), mas o sistema só colocava a tag `cancelado_com_picks` — **sem nenhuma fila/worklist** (zero consumidores). Resultado: peça sumia do estoque, pedido morria, **saldo nunca voltava** — dependia de alguém lembrar.
- **AGORA:** cada item pego vira uma devolução pendente na fila de devoluções. O operador classifica como **'integro'** → gera a entrada (E) e a peça volta ao estoque. Funciona tanto no cancelamento humano (D1) quanto no do webhook.

## 5. BUG-03 — Embalagem OC não decide galpão pela coluna deprecada (MÉDIA)
**Arquivos:** `confirmar-item-embalagem/route.ts`, `bipar-embalagem-oc/route.ts`
**Mudança:** a decisão própria×transferência e o `separacao_galpao_id` preferem `pedido.separacao_galpao_id`; só caem em `siso_empresas.galpao_id` (espelho deprecado) se o pedido não tiver galpão.

- **ANTES:** numa embalagem direta de OC, o galpão era lido de `siso_empresas.galpao_id` — espelho do "1º preferencial". Empresa que opera em N galpões (ou admin que mexeu nas preferências) → **etiqueta impressa / job de execução no galpão errado**.
- **AGORA:** usa o galpão real de separação do pedido. Espelho deprecado só como último fallback.

## 6. BUG-14 — Mudança de localização não perde mais estoque (MÉDIA)
**Arquivo:** `localizacao/route.ts`
**Mudança:** o par S+E que move o saldo entre locs agora compensa — se a E falha depois da S, estorna a S (devolve o saldo à origem) antes de propagar o erro.

- **ANTES:** mover todo o saldo de um produto pra outra loc fazia S (sai da origem) e E (entra no destino) sem transação. Se a **E falhasse após a S**, o saldo **sumia** (saiu da origem, não entrou no destino).
- **AGORA:** falha na E → a S é estornada → saldo volta pra loc origem. Sem perda de estoque. (A re-reserva no destino segue best-effort com `logError`; a falta de `userCan` é convenção das rotas de separação, não mexida.)

## 7. BUG-05 — Re-reserva residual do parcial agora é observável (MÉDIA)
**Arquivo:** `parcial/route.ts`
**Mudança:** falha na re-reserva do residual vira `logError` + contagem `reservas_residuais_falhadas` na resposta (era `logger.warn` silencioso).

- **ANTES:** num parcial sem zerar a loc, se a re-reserva do que falta falhasse, o item ficava aberto **sem reserva viva** e ninguém via — o próximo pick caía no fallback "maior saldo".
- **AGORA:** o erro é registrado e a resposta diz quantas re-reservas falharam. (Não vira 500 — os picks já foram commitados; é degradação, não corrupção.)

## 8. BUG-15 — Encaminhar expõe reserva-fantasma (MÉDIA)
**Arquivo:** `encaminhar/route.ts`
**Mudança:** falha ao liberar uma reserva no encaminhar vira `logError` + contagem `nao_liberadas` (era `logger.warn`).

- **ANTES:** ao encaminhar pra outro galpão, se uma reserva falhasse ao ser liberada, o pedido migrava mesmo assim e a reserva **ficava viva no galpão origem** = saldo travado (reservado-fantasma) que escapa do detector de reservas órfãs.
- **AGORA:** a falha é registrada (loud) com contagem, pra limpeza. (Direção conservadora: trava saldo, não vende dobrado — por isso não aborta o encaminhar.)

---

## Test-rots corrigidos de quebra (não eram bug de produto)
- **`validar-oc-item/encontrei-…test.ts`** (estava vermelho): o teste não mockava `@/lib/wms/sync-tiny` (`resolverProdutoEfetivoComAutoSync`, adicionado pelo commit `c7cb101`) → a função real batia no DB → 500. Adicionados os mocks. **Agora passa.**
- **`realoc-fix-pack.test.ts`** (5 vermelhos): `loc_uuid` hardcoded não existe mais em `siso_localizacoes` do staging (FK). **NÃO mexido** — é smoke test que escreve em staging; precisa refrescar o UUID (read-only) quando você quiser. Não é bug de produto.

---

## NÃO corrigidos — precisam de decisão sua (documentado, não toquei)

| Bug | Severidade | Por que não foi feito agora |
|---|---|---|
| **BUG-09** — parcial não-idempotente (replay → S dobrada) | alta | Fix correto exige **idempotency-key vinda do cliente** (mudança de contrato da API) propagada pra `wms_pick_parcial_atomico`. É no arquivo mais delicado (2456 linhas); um fix errado quebra o pick parcial (operação central). **Risco alto, precisa de decisão de como o cliente gera a chave.** Mitigante atual: o cliente não auto-retenta POST, então o vetor real é duplo-clique (mitigável no botão). |
| **BUG-A** — trocar SKU equivalente após concluído | baixa | O caso comum (item nunca-trocado): **JÁ FUNCIONA** via `voltar-etapa`→reabrir→solicitar troca→aprovar→re-picar (sem inconsistência de estoque). O beco-sem-saída é só quando a troca **já foi aplicada** e você quer mudar pra um 3º SKU — `reset-state` não limpa `produto_wms_substituto_id`. Fix = capability nova (rota "desfazer troca aplicada"). |
| **BUG-11** — S consolidada de wave + estorno parcial → 500 | média | Variante multi-reversal de estorno parcial num S que cobre N itens. Liga ao resíduo do BUG-02. Precisa de tratamento de `estornar_parcial` por fração-de-pedido. |
| **BUG-01** — voltar pra `pendente_realocacao` não roda reset-state | baixa | Premissa principal (over-reserve) **refutada** por guard em `concluir`. Resíduo de coerência de flags, baixíssimo impacto, `pendente_realocacao` nem é oferecido pela UI. |
| **BUG-13 / 16 / 17 / 04 / 18 / 19 / 20 / B** | — | Refutados ou comportamento **por design** (write-off de `loc_zerou`, expedir sem conferir, fallback OC, CHECK do ledger, RPC legada morta, NULL desambiguado, guards do reconciliador, reversão de etiqueta). Não são bugs. |
