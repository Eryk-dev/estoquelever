# Acerto de prateleira no pick — Design

**Data:** 2026-06-01
**Status:** spec aprovada em brainstorm; pendente revisão final do user antes do plano
**Fluxo visual:** `docs/superpowers/specs/2026-06-01-acerto-prateleira-pick-fluxo.html`

---

## 1. Contexto e problema

Em dois momentos da separação o sistema **inventa ou zera saldo de uma localização sem nunca contar o que realmente está lá**:

1. **`Encontrei` (item de OC).** Item foi roteado pra compra porque o WMS achava saldo = 0. O operador acha o item fisicamente, bipa a loc e marca "Encontrei". Hoje (`validar-oc-item` acao=`encontrei`), quando o produto não tem saldo em nenhuma loc do galpão, o sistema gera **uma entrada `E` `ajuste_manual` (motivo_categoria=`achado`) na quantidade do pedido** (`validar-oc-item/route.ts:188-204`), e logo em seguida a saída do pedido (`pickMovPicking` → `S` `nf_venda` + opcional `L` `liberacao_reserva`). Resultado: materializa **exatamente a quantidade pedida** e dá baixa dela → a loc termina **zerada no sistema**, mesmo que fisicamente houvesse mais.

2. **`Parcial` → "loc zerou".** O operador pega menos do que o pedido e marca que a prateleira esvaziou. Hoje (`parcial/route.ts`) gera `S` `nf_venda` (qty pega) + `S` `ajuste_pick_zerou` no delta `max(0, saldoWms − qty_pega − reservadoRestanteLoc)` zerando a loc. Também não conta — assume zero.

**A consequência:** se o operador acha 8 e o pedido pede 5, o sistema cria 5 e baixa 5 → o ledger diz "loc zerada", mas **fisicamente sobraram 3 fantasmas**. E a loc que o WMS jurava estar vazia tinha estoque — prova de que a crença do sistema sobre aquela loc estava errada. Hoje **nenhum ciclo de contagem é aberto**: separação e inventário são módulos 100% desacoplados (confirmado — nenhum ponto de `separacao/*` cria sessão/contagem/lock de inventário). A divergência só seria pega num inventário periódico futuro.

**O que queremos:** no momento do pick, o operador está fisicamente na frente da prateleira. Ou ele **conta na hora** (poucas unidades) e o saldo passa a refletir a realidade, ou ele **pede uma recontagem** e a loc entra numa fila pra alguém contar depois — sem nunca segurar a saída do pedido.

---

## 2. Decisões do brainstorm (firmadas)

| # | Decisão |
|---|---|
| D1 | **Escopo:** vale pros dois gatilhos — `Encontrei` (OC) **e** `Parcial` "loc zerou". Não mexe no `marcar-item` normal (pick que bate com o esperado). |
| D2 | **Contagem inline = contagem oficial:** gera divergência registrada, atualiza última contagem, entra na acuracidade do operador/loc, e a loc "pula a fila" de recontagem. |
| D3 | **Solicitar contagem = fila acumuladora:** a loc entra numa fila de recontagem do galpão que vai acumulando; alguém atende depois. Não cria mil sessões de 1 loc. |
| D4 | **O pick sempre sai na hora.** Contar (inline ou solicitada) **nunca** bloqueia a expedição do pedido. |
| D5 | **Inline reconcilia na hora; solicitada reconcilia depois** (assíncrono). |

---

## 3. Restrição descoberta no código + decisão de design (revisão da Abordagem A)

No brainstorm escolhemos **Abordagem A — "reaproveitar o módulo de inventário"**, imaginando uma *sessão `cycle_count` perpétua* que aplica a contagem inline na hora. Ao aterrissar no código, encontrei uma restrição que **derruba a versão ingênua dessa ideia**:

- O módulo de inventário tem **ciclo de vida rígido**: `planejada → em_andamento → revisão → aprovada → aplicada`. `aplicarSessao` exige `status='aprovada'` e itera divergências `status='aprovada'`; divergências nascem `pendente`/`aprovada`, nunca `aplicada` direto. `registrarContagem` exige a loc `bloqueada_por` o operador (claim via `pegarProximaLoc`). Uma sessão não pode "aplicar uma contagem no meio" sem encerrar.
- As métricas leem: `wms_metricas_operador` conta de `siso_inventario_contagens` (nº de contagens via `contada_por`) e pega o erro % via **JOIN** com `siso_inventario_divergencias` em `(sessao_id, localizacao_id, produto_id, empresa_dona_id)` (`20260529_wms_metricas.sql:10-24`). `wms_metricas_localizacao` idem.

**Decisão de design (revisão de A):** "reaproveitar inventário" passa a significar **reaproveitar as tabelas + as métricas + o trigger de última contagem**, **não** a máquina de estados. Concretamente:

- A **contagem inline se aplica direto no ledger** (`inventario_ganho`/`inventario_perda` via `inserirMovimentacao`), e grava as linhas de relatório (`siso_inventario_contagens` + `siso_inventario_divergencias` já em `status='aplicada'`, com `mov_aplicada_id`) por fora do fluxo de aprovação. **Não** chama `aprovarSessao`/`aplicarSessao`.
- Essas linhas penduram numa **sessão operacional contínua por galpão** (`continua=true`, marcador novo), que vive permanentemente em `em_andamento` e serve só como contêiner de relatório/fila — nunca passa pela aprovação em bloco.
- A **fila de recontagem solicitada** acumula como locs `pendente` (`motivo='solicitada_pick'`) nessa mesma sessão contínua. Pra **atender** a fila, um supervisor "monta um ciclo": o sistema cria uma **sessão `cycle_count` discreta normal** a partir das locs acumuladas, que segue o fluxo de inventário **que já existe** (contar → aprovar → aplicar). Assim o caminho de recontagem reaproveita 100% a máquina existente, sem perpetuar sessão nenhuma.

> Essa é a única divergência relevante entre o brainstorm e a spec. Tudo o que o user pediu (D1–D5) é entregue; só a *mecânica interna* de "como a contagem inline vira oficial" mudou de "sessão perpétua auto-aplicando" para "aplica no ledger + grava linhas de relatório fora do ciclo de aprovação".

---

## 4. Conceito unificado

Nos dois gatilhos, o modal passa a perguntar **"quanto tem nessa localização?"**, com duas saídas:

- **Contei: N** → o sistema acerta o saldo da loc na hora (reconciliação no ledger) + registra contagem oficial + executa o pick do pedido. Sobra `N − qtd_pedido` real na loc.
- **Não dá pra contar agora → Solicitar contagem** → o pick sai na hora com o comportamento atual; a loc entra na fila de recontagem do galpão.

---

## 5. Comportamento por gatilho

### 5.1 `Encontrei` (OC) — sistema achava saldo 0

Sejam `Q` = quantidade pedida do item, `N` = quantidade contada pelo operador na loc bipada.

**Caminho "Contei N":**
1. **Reconciliação (acerto):** como o sistema tinha 0 e o operador conta `N`:
   - `inserirMovimentacao({ tripla, tipo:'E', qty:N, origem_tipo:'inventario_ganho', origem_id: <sessao_operacional_id>, origem_detalhes:{ divergencia_id:<id>, contexto:'acerto_pick', sku, pedido_id }, usuario_id })`. Saldo `0 → N`. **Custo médio não é tocado** (`inventario_ganho` não está na whitelist de recálculo — confirmado em `20260526_custo_medio_ajuste_manual.sql:88-96`; o produto mantém o custo médio global que já tinha).
   - Registra contagem oficial (ver §7).
2. **Pick (igual hoje):** `pickMovPicking` → opcional `L` `liberacao_reserva` (se houver R viva) + `S` `nf_venda` na qty `Q`. Saldo `N → N−Q`.
3. **Item:** updates atuais do `encontrei` (`compra_status=null`, `separacao_marcado=true`, `quantidade_pega=Q`, `mov_saida_id`, etc — `validar-oc-item/route.ts:261-272`).
4. **Se `N < Q`:** acerta a loc pra `N`, pega `N`, e o residual `Q−N` segue o caminho que já existe (cascade de realocação ou OC). Ver §11.

> Diferença vs hoje: a entrada deixa de ser um `ajuste_manual` do tamanho do pedido e passa a ser um `inventario_ganho` do tamanho **real contado** → o residual `N−Q` é preservado como saldo verdadeiro, e a contagem fica registrada.

**Caminho "Solicitar contagem":** mantém o comportamento atual (`E` `ajuste_manual` `achado` na qty `Q` + `L?` + `S` `nf_venda`), e **adiciona a loc à fila de recontagem** (§9). Não conta nada agora.

### 5.2 `Parcial` → reframe do "loc zerou"

O checkbox binário **"loc zerou"** vira uma pergunta de quanto **sobrou** na loc depois de pegar `P` (qty_pega):

- **Sobrou 0 (zerou):** mantém a mecânica atual de reconciliação no ledger — `S` `nf_venda` (P) + `S` `ajuste_pick_zerou` no delta `max(0, saldoWms − P − reservadoRestanteLoc)` (`parcial/route.ts:365-396`), preservando o invariante de `mov_ajuste_loc_zerou_id` (não estornado em cancelamento). **Adiciona** o registro de contagem oficial (contou: total = `P`, sistema achava `saldoWms`).
- **Sobrou N (N>0, contou):** pick `S` (P) + acerta a loc pra `N` via `inventario_ganho`/`inventario_perda` (delta vs o saldo pós-pick) + registro de contagem oficial (contou total = `P+N`).
- **Não sei → Solicitar contagem:** comportamento atual do parcial sem `loc_zerou` (reenfileira / "em progresso", `parcial/route.ts:805-856`) + loc na fila de recontagem (§9).

---

## 6. Movimentações no ledger (resumo, com `origem_tipo` reais)

| Gatilho / caminho | Movimentações (em ordem) |
|---|---|
| OC `Encontrei` · Contei N (N≥Q) | `E inventario_ganho (+N)` → [`L liberacao_reserva`] → `S nf_venda (−Q)` |
| OC `Encontrei` · Contei N (N<Q) | `E inventario_ganho (+N)` → [`L`] → `S nf_venda (−N)` + residual `Q−N` via cascade/OC |
| OC `Encontrei` · Solicitar | `E ajuste_manual/achado (+Q)` → [`L`] → `S nf_venda (−Q)` + loc na fila |
| Parcial · Sobrou 0 | [`L liberacao_reserva`] → `S nf_venda (−P)` → `S ajuste_pick_zerou (−delta)` |
| Parcial · Sobrou N | [`L`] → `S nf_venda (−P)` → `E/S inventario_ganho/perda` (acerta loc pra N) |
| Parcial · Solicitar | comportamento atual (sem ajuste) + loc na fila |

Todos via `inserirMovimentacao` (RPC `wms_inserir_movimentacao`, lock pessimista `FOR UPDATE`). A reconciliação **vem antes** do `S` pra a saída nunca furar saldo.

---

## 7. Modelo de dados (reuso + mudanças mínimas)

**Reaproveita (sem mudança):** `siso_inventario_contagens`, `siso_inventario_divergencias`, `siso_inventario_localizacoes`, `siso_localizacao_locks`, o trigger `wms_inv_trigger_atualizar_ultima_contagem` (AFTER INSERT em contagens → atualiza `siso_localizacoes.ultima_contagem_em`), as métricas `wms_metricas_operador`/`wms_metricas_localizacao`, e a sugestão `wms_inventario_sugerir` (que já usa `ultima_contagem_em`).

**Mudanças (migrations novas em staging `ehbxpbeijofxtsbezwxd`):**

1. **`siso_inventario_sessoes.continua boolean DEFAULT false`** — marca a sessão operacional contínua (1 por galpão). Resolvida via get-or-create (`continua=true AND galpao_id=X`). `tipo='cycle_count'`, `modo_contagem='aberto'`, `nome='Contagens operacionais'`, fica em `em_andamento`.
2. **`siso_inventario_divergencias` UNIQUE** — o constraint atual `UNIQUE(sessao_id, localizacao_id, produto_id, empresa_dona_id)` colide quando a mesma loc+produto é contada de novo na sessão contínua. **Decisão:** **UPSERT** (a contagem mais recente sobrescreve a divergência daquele `(loc,produto,empresa)` na sessão contínua). Mantém o JOIN das métricas 1:1 (sem fan-out). Custo: o erro % usa o delta da contagem mais recente daquela tripla (aproximação aceitável — ver §13).
3. **`siso_inventario_localizacoes.motivo`** — adicionar valor `'solicitada_pick'` ao conjunto de motivos (hoje `curva_a|divergente_recente|sem_contagem_recente|manual|completo`). É coluna `text` sem CHECK rígido (confirmar), então pode ser só convenção.

**Convenção `empresa_dona_id`:** a coluna ainda existe nas tabelas de inventário (legado pré-3D). O JOIN das métricas casa em `empresa_dona_id`, e `NULL = NULL` não casa em SQL. Por isso, contagens e divergências do acerto inline gravam **`empresa_dona_id = empresa_origem_id` do pedido** (consistente nas duas tabelas) pra o JOIN das métricas funcionar.

**Idempotência da reconciliação:** o índice único `uniq_movs_inventario_divergencia` (`siso_movimentacoes((origem_detalhes->>'divergencia_id')) WHERE origem_tipo IN ('inventario_ganho','inventario_perda')`) já garante 1 mov por `divergencia_id`. O acerto inline passa um `divergencia_id` determinístico no `origem_detalhes` → retry não duplica.

---

## 8. Contagem inline = oficial (detalhe)

Ao "Contei N", além da reconciliação no ledger (§5/§6), grava:

1. **`siso_inventario_contagens`** (sessao=contínua do galpão, loc, produto, `qty_contada=N` [ou `P` / `P+N` no parcial], `contada_por=operador`, `empresa_dona_id=empresa_origem`). → dispara o trigger que atualiza `ultima_contagem_em` da loc → a loc **pula a fila** na sugestão de inventário.
2. **`siso_inventario_divergencias`** via UPSERT (sessao=contínua, loc, produto, `saldo_sistema` = saldo no instante do bipe, `qty_contada_final` = contagem, `status='aplicada'`, `mov_aplicada_id` = mov de reconciliação, `resolucao_por=operador`, `empresa_dona_id=empresa_origem`). → o erro % entra na acuracidade do operador e da loc.

Sem aprovação de supervisor: a contagem do operador na frente da prateleira é a verdade (D2). Se `N` = saldo do sistema (sem divergência), grava contagem (pra última contagem/acuracidade) e **não** gera mov de reconciliação.

---

## 9. Fila de recontagem solicitada + montar ciclo

- **Solicitar contagem** (em qualquer dos dois gatilhos): insere/garante uma loc `pendente` `motivo='solicitada_pick'` na sessão contínua do galpão (dedup por `(sessao, loc)` — UNIQUE já existe em `siso_inventario_localizacoes`). Não cria lock (a operação na loc continua normal). O pick do pedido segue seu caminho atual na hora.
- **Atender a fila ("montar ciclo de recontagem"):** ação do supervisor (tela de inventário) que cria uma **sessão `cycle_count` discreta** a partir das locs `solicitada_pick` acumuladas (snapshot), e marca essas locs como atendidas na fila. A sessão discreta segue o fluxo de inventário **que já existe** (handheld → contar → computar → aprovar → aplicar). Zero máquina de estados nova.

---

## 10. UX nos modais

- **`OcEncontreiModal`** (inline em `checklist/page.tsx:1794-1887`): depois do bipe da loc, adicionar campo **"Quantas unidades tem aqui?"** + botão **Contei**, e link discreto **"Não dá pra contar agora → solicitar contagem"**.
- **`ParcialModal`** (`src/components/wms/separacao/parcial-modal.tsx`): o checkbox "loc zerou" vira **"Quanto sobrou na prateleira?"** → `0` / campo `N` / **"Não sei → solicitar contagem"**.
- Padrão visual: zinc, mobile-first, Lucide, Sonner (conforme convenções). Sem lib nova.

---

## 11. Casos de borda

| Caso | Tratamento |
|---|---|
| **N < Q** (achou menos que o pedido) | Acerta loc pra `N`, pega `N`, residual `Q−N` segue cascade de realocação / OC existente (`resolverRealocacao`). |
| **N = Q** | Acerta (sistema 0 → N, ou parcial), pega `Q`, loc fica `N−Q` (0 no OC). Contagem registrada. |
| **Parcial "sobrou N"** | Novo caminho de reconciliação `inventario_ganho/perda` pra setar a loc em `N` (hoje o parcial só zera ou reenfileira). |
| **Idempotência** | Pick: `mov_saida_id` já guarda re-pick (`validar-oc-item/route.ts:130-137`). Reconciliação: `divergencia_id` determinístico no `origem_detalhes` + índice único. |
| **Concorrência** | Reconciliação e pick via `inserirMovimentacao` (lock `FOR UPDATE` por linha de `siso_estoque`). Ordem: reconcilia (sobe saldo) → pick. Dois operadores na mesma loc: o segundo recebe erro de coerência/saldo e refaz. |
| **Desfazer** | `desfazer_encontrei` já estorna o `S` e reseta o item. **Acréscimo:** estornar também a mov de reconciliação `inventario_ganho` (via `estornarMovimentacao`) e marcar a divergência inline como estornada. Decidir no plano se o desfazer reverte a contagem oficial (provável: sim, é uma ação do operador no mesmo fluxo). |

---

## 12. Fases de implementação (pro plano)

1. **Fase 1 — Contagem inline no `Encontrei` (OC).** O caso da screenshot, maior valor e mais isolado. Inclui: migration (`continua`, divergencias UPSERT, `empresa_dona` convention), helper de "registrar contagem inline aplicada" em `inventario.ts`, mudança no `validar-oc-item` (recebe `qty_contada` opcional), `OcEncontreiModal` (campo + botão), desfazer estornando reconciliação. Testes de cenário.
2. **Fase 2 — Contagem inline no `Parcial` "loc zerou".** Reframe do modal (quanto sobrou: 0/N/não sei), caminho "sobrou N" no `parcial/route.ts`, registro de contagem oficial no caminho "zerou".
3. **Fase 3 — Solicitar contagem + fila + montar ciclo.** Botão "solicitar" nos dois modais → fila `solicitada_pick`; ação supervisor "montar ciclo de recontagem" → sessão discreta. UI da fila.

---

## 13. Fora de escopo / YAGNI

- Não mexe no `marcar-item` normal (pick que bate com o esperado).
- Sem aprovação de supervisor pra contagem inline.
- Sem travar a loc por ter recontagem pendente (operação segue normal).
- Sem `duplo_blind`, sem party/claim hierárquico na contagem inline (é 1 loc, 1 operador, na hora).

---

## 14. Riscos e decisões abertas

- **Aproximação na acuracidade (UPSERT de divergência):** múltiplas contagens da mesma loc+produto na sessão contínua compartilham 1 divergência (a última). O `wms_metricas_operador` então usa o delta da última contagem pra todas as contagens daquela tripla no AVG. Distorção pequena e rara; se precisar de acuracidade por evento no futuro, adicionar `contagem_id` FK em divergencias e reescrever o JOIN das métricas. **Aceito pra v1.**
- **Sessão contínua "em_andamento" pra sempre:** a UI de inventário lista sessões; a contínua apareceria sempre em andamento. Tratar como sessão de sistema (filtro/badge "operacional") pra não confundir o supervisor. **Resolver no plano (UI).**
- **`empresa_dona_id` em ambiente 3D:** usamos `empresa_origem_id` como tag só pra casar o JOIN das métricas; não tem semântica física (coerente com o ledger 3D, onde empresa é tag, não coordenada).
- **Custo do residual no OC (`inventario_ganho`):** o residual `N−Q` fica com o custo médio global vigente do produto (entrada de ganho não recalcula custo). Coerente com como ganhos de inventário funcionam hoje.
- **Não-atomicidade do acerto inline:** mov de reconciliação + linhas de contagem/divergência não são uma transação única. Falha parcial deixa ganho sem registro; retry é seguro pro saldo (reconcilia-para-N → delta 0) mas pode duplicar a linha de contagem. Aceito pra v1; RPC transacional se necessário no futuro.
