# Bateria Automática de Testes de Estoque (Ledger Guard) — Design

**Data:** 2026-06-01
**Status:** Aprovado (brainstorming) — pendente plano de implementação
**Autor:** Eryk + Claude
**Ambiente alvo:** staging `ehbxpbeijofxtsbezwxd` (somente)

---

## 1. Problema

Os fluxos de lançamento de estoque (recebimento, guarda, separação, aprovação de
pedido, vendas, transferências, replenishment, ajuste, retroativo, inventário,
devoluções) são fundamentais: qualquer bug que escreva no ledger de forma incorreta
gera **divergência de estoque** quando o app for pra produção. Precisamos de uma
bateria que rode **sozinha**, exercite **todo fluxo que toca o ledger**, valide os
**invariantes globais de estoque** e **avise no instante em que algo quebra**.

### O que já existe (ponto de partida — não é zero)

Existe uma pirâmide de testes em 3 camadas:

- **Unit** (vitest, ~28 arquivos `src/**/*.test.ts`) — lógica pura, sem DB.
- **Integration** (vitest vs staging, 6 arquivos `test/integration/**`) — nível RPC,
  serializado (`maxWorkers: 1`), `globalSetup` faz `validarStaging` + truncate + seed.
- **Scenarios / Camada 3** (`npm run scenarios`) — **82 cenários** ponta-a-ponta que
  batem em `/api/wms/*` via HTTP contra um Next dev server local apontando pra staging,
  com Tiny/PrintNode/ML stubados.

E **7 invariantes globais (I1–I7)** rodam depois de **cada** cenário
(`scripts/wms/cenarios/_harness/invariantes.ts`). O keystone é **I1**, que chama
`wms_detectar_divergencias_estoque()` e exige
`siso_estoque.saldo == Σ(E) − Σ(S)` por posição — ou seja, já detecta exatamente a
"divergência de estoque" que queremos evitar.

### Por que não basta o que existe (as 3 lacunas)

1. **Nada roda automaticamente.** Não há CI (`.github/` não existe), cron, hook de git
   nem Vercel cron que dispare a suíte. Última run foi manual em **2026-05-29**.
2. **A suíte completa nunca ficou verde junta.** Melhor run registrada: **11 pass /
   57 fail / 68**. As falhas são dominadas por **instabilidade do harness** (cascata de
   "fetch failed" do dev server, `/receber` retornando 500, timeouts de espera de
   status) — **não** por bugs de produto. Resultado: um bug real de estoque hoje ficaria
   invisível, soterrado no vermelho.
3. **Alguns dos caminhos mais arriscados estão sem cobertura ou só com cobertura
   instável**, e um invariante tem ponto-cego (ver §5).

### Causa-raiz da instabilidade (diagnosticada)

`scripts/wms/cenarios/run-all.ts` sobe **um único** `next dev` no início, roda os 82
cenários sequencialmente contra ele por ~50-60 min, **sem retry** (`http.ts` faz um
`fetch` único) e **sem recuperação de saúde**. Quando o dev server tropeça no meio
(recompilação turbopack, um 500 de rota, memória), todo cenário **subsequente** falha
com "fetch failed" — um tropeço vira dezenas de falsos vermelhos.

---

## 2. Objetivo verificável (definition of done)

1. A suíte completa roda **determinística** — mesmo input → mesmo resultado, sem
   cascata de falha de infra.
2. Existe um **baseline verde**: todo cenário passa, ou seu vermelho é um bug real já
   triado e documentado — nunca ruído de harness.
3. Roda **nightly, zero ação humana**, e **empurra alerta no Slack/Discord** com os
   fluxos quebrados + invariante violado em qualquer falha.
4. Os fluxos de maior risco hoje sem cobertura passam a ter cenário; o ponto-cego de
   `reservado` na reconciliação é fechado (invariante novo).

---

## 3. Decisões (firmadas no brainstorming)

| Decisão | Escolha | Implicação |
|---|---|---|
| Escopo | **Estabilizar + automatizar + fechar lacunas** | Não reescrever os 82 cenários; consertar harness, automatizar, adicionar cenários/invariantes faltantes. |
| Onde roda | **Staging mesmo, em horário ocioso** | Sem projeto/branch dedicado. Run destrutiva (truncate) só em horário ocioso. |
| Gatilho | **Cron noturno via GitHub Actions** | Repo está em `git@github.com:Eryk-dev/estoquelever.git`. Sem PR-gate. |
| Alerta | **Webhook Slack/Discord** | Push em canal na falha; URL guardada como GitHub secret. |

---

## 4. Arquitetura — 4 workstreams

### A — Estabilização do harness (fundação)

Sem isso, nada mais é confiável.

1. **Rodar contra build de produção, não `next dev`.** Adicionar modo ao runner que
   faz `next build` + `next start -p <porta>` (ou detecta um servidor prod já de pé).
   Dev mode (turbopack, compila sob demanda, HMR) é a fonte nº 1 de instabilidade e
   lentidão. CI builda uma vez, roda rápido e estável. Manter `--dev` pra debug local.
2. **Retry com backoff no HTTP client** (`_harness/http.ts`), separando falha
   transiente de falha real:
   - Retry **só** em throw de rede (`fetch failed`, ECONNRESET, ECONNREFUSED) e em
     502/503/504, com backoff exponencial limitado (~3 tentativas).
   - **Nunca** dar retry num 4xx/5xx de negócio — esse é o sinal que estamos testando.
3. **Recuperação de saúde do servidor entre cenários.** Antes de cada cenário (ou ao
   tomar um throw de rede), pingar `/api/auth/me`; se o servidor morreu, **reiniciar uma
   vez + re-login** em vez de cascatear. Se não recuperar, abortar com veredicto
   **infra** claro — não com dezenas de falsos vermelhos.
4. **Taxonomia de falha no relatório** (`_harness/types.ts` + `relatorio.ts`):
   - `pass`
   - `product-fail` — erro de negócio HTTP (4xx/5xx), assert de cenário, ou invariante
     violado.
   - `infra-fail` — rede/servidor após esgotar retries.
   - **Alerta e exit code disparam só em `product-fail`.** `infra-fail` é sinalizado à
     parte e não se disfarça de bug de estoque.
5. **Isolamento de estado.** Adicionar `siso_transferencias_galpao` (hoje nunca
   truncada — vaza entre runs) ao `wms_truncate_operacional` (migration nova). Auditar
   outras tabelas operacionais não cobertas. Manter modelo truncate-once + `skuUnico`
   por cenário.

### B — Triagem dos bugs reais (systematic-debugging)

Depois que A torna a run confiável:

- Obter **uma run completa limpa**. Separar falha real de ruído de harness.
- Pra cada vermelho real (ex.: `/receber 500`, cenário 24 "mov E nf_compra ausente"):
  reproduzir → causa-raiz → corrigir; **ou**, se for quirk de design já aceito (ex.:
  `ajuste_pick_zerou` nunca estornado por ser realidade física), marcar o cenário com
  motivo documentado.
- **Saída:** baseline verde onde todo vermelho restante é um bug real triado.

### C — Fechar lacunas de maior risco (cenários novos + invariante)

Cenários novos pros caminhos que escrevem no ledger e hoje não têm cobertura (risco de
estoque-fantasma):

| Novo cenário | Fluxo | Assert principal |
|---|---|---|
| `pedidos/[id]/estornar` (Banner D10) | reversão de pedido inteiro (admin) | ledger espelhado 1:1, sem saldo/reserva fantasma; I1+I8 verdes |
| `pedidos/[id]/liberar-reservas` (D2) | override admin libera R | R liberado, sem órfã (I4) |
| Conversão NF → R→L+S (isolada) | coração do WMS-as-source | reservas viram L+S com split correto |
| `separacao/localizacao` com `reservado>0` | libera-R + move S+E + reemite-R | reservado coerente, sem R órfã |
| `guarda/[id]/cancelar` com motivo | cancela pendência | saldo órfão em RECEBIMENTO é esperado/by-design vs estorno |

**Invariante novo — I8 paridade de reservado:**
`siso_estoque.reservado == GREATEST(0, Σ(R) − Σ(L))` por posição. Hoje
`wms_detectar_divergencias_estoque` checa **só saldo** (`R`/`L` mapeiam pra 0 no CASE) —
uma classe inteira de divergência de `reservado` passa silenciosa. Fechar via nova RPC
`wms_detectar_divergencias_reservado()` (espelhando a de saldo) chamada num invariante I8.

**Ajustes nos invariantes existentes:**
- **I2** — incluir linhas `saldo=0` (hoje filtra `saldo>0`).
- **I3** — alinhar o fold de custo médio ao whitelist de 5 origens que a RPC de fato
  recalcula (`nf_compra`, `devolucao_cliente_integra`, `lancamento_retroativo`,
  `ajuste_manual`, `inventario_inicial`), pra não dar falso-positivo com `E` custeada de
  origem não-whitelisted (ex.: `inventario_ganho`).

> Nota de cobertura: o mapeamento completo de write-paths confirmou **19 `origem_tipo`**
> (o 19º é `devolucao_cliente_troca_sku`) e **2 RPCs atômicas além das 5 nomeadas**
> (`wms_pick_item_atomico` — caminho principal de picking em `marcar-item`; e
> `wms_estornar_parcial_movimentacao` — usado em `desfazer-parcial`). A triagem (B) e os
> cenários (C) devem garantir que esses caminhos quentes estejam exercitados.

### D — Automação + alerta (GitHub Actions)

Workflow agendado `.github/workflows/wms-stock-suite.yml`:

- `schedule: cron` em horário ocioso — **06:00 UTC (03:00 BRT)**, configurável — +
  `workflow_dispatch` pra rodar na mão.
- Passos: checkout → setup Node (casar versão local) → `npm ci` → injetar env de staging
  dos **GitHub secrets** → `npm run scenarios` em modo prod-build → subir o relatório
  (md+json) como artifact.
- Em qualquer `product-fail`: passo parseia o relatório e **posta no webhook
  Slack/Discord** (secret `STOCK_SUITE_WEBHOOK_URL`) com: timestamp, contagem pass/fail,
  **lista de fluxos quebrados**, **invariante(s) violado(s)**, link pro artifact.
  Workflow sai non-zero (GitHub registra vermelho também).
- **Guarda-corpo:** o `validarStaging()` do seed já aborta se a URL não for o projeto de
  staging — a run destrutiva **nunca** toca prod.

**Env vars/secrets que o workflow precisa** (nomes; valores colados pelo Eryk no GitHub):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (staging)
- `WORKER_SECRET`
- `STOCK_SUITE_WEBHOOK_URL` (Slack/Discord incoming webhook)
- Fixos no workflow: `TINY_DISABLED=true`, `PRINTNODE_DISABLED=true`, `ML_DISABLED=true`,
  `TEST_RUNNER_NOME=test-runner`, `TEST_RUNNER_PIN=9999`

---

## 5. Invariantes — referência (estado-final desejado)

Depois de **qualquer** fluxo, tudo isso deve valer. (★ existente · ☆ novo/ajuste)

1. ★ **I1** — `siso_estoque.saldo == Σ(E) − Σ(S)` por posição (via
   `wms_detectar_divergencias_estoque`).
2. ☆ **I8** — `siso_estoque.reservado == GREATEST(0, Σ(R) − Σ(L))` por posição (nova
   RPC). **Fecha o ponto-cego de reservado.**
3. ★/☆ **I2** — `disponivel == saldo − reservado` em **toda** linha (incluir `saldo=0`).
4. ★ **I3** — custo médio = fold ponderado sobre entradas custeadas **do whitelist de 5
   origens** (alinhar).
5. ★ **I4** — toda `R` expirada/sem-TTL tem `L` correspondente (mesmo `origem_id`).
6. ★ **I5** — `qty_pendente == qty_inicial − qty_guardada`; `guardada ⇒ qty_pendente=0`.
7. ★ **I6** — pares S+E balanceados (`transferencia_galpao`,
   `transferencia_localizacao`, `ajuste_pick_zerou`): exatamente 1 S + 1 E, qty igual,
   por `origem_id`.
8. ★ **I7** — `siso_fila_execucao` sem linhas `pendente`/`executando` em repouso.

Garantias de nível DB (asseguradas por CHECK; valem como piso): `saldo ≥ 0`,
`0 ≤ reservado ≤ saldo`, `disponivel = saldo − reservado` (GENERATED), `quantidade > 0`,
aritmética por linha (`saldo_posterior`/`reservado_posterior`), `custo_medio ≥ 0`.

---

## 6. Pré-requisitos (Eryk fornece)

- **URL de incoming-webhook** do Slack ou Discord → secret `STOCK_SUITE_WEBHOOK_URL`.
- **Chaves de staging + WORKER_SECRET** como GitHub repo secrets (valores colados por
  ele; Claude não imprime segredos).
- Ciência de que **truncar dados operacionais de staging toda noite é aceitável**
  (catálogo preservado; tabelas operacionais zeradas a cada run). Confirmado pela escolha
  "staging em horário ocioso".

---

## 7. Riscos / tradeoffs

- **Staging compartilhado + destrutivo:** se alguém testar manualmente em staging ~3am,
  pode colidir/perder dado. Aceito; mitigado pelo horário. Upgrade futuro: projeto de
  teste dedicado elimina isso.
- **Service-role key de staging como secret no CI** — padrão, mas é chave poderosa.
  Escopo: repo secrets, só o workflow agendado usa.
- **Primeiro baseline pode revelar bugs reais** (é o objetivo) — a triagem (B) pode achar
  bugs de estoque genuínos; a data de "pronto" depende de quantos existem.

---

## 8. Fora de escopo (YAGNI)

- Projeto/branch de teste dedicado (escolha: staging-at-idle).
- PR-gate CI (escolha: nightly only).
- Reescrever/renumerar os 82 cenários (escolha: estabilizar, não rebuild). Dedupe de
  numeração só se bloquear a estabilização.
- Suíte `auth-matrix` (`npm run auth-matrix`) — separada, não é ledger. Fica fora a menos
  que pedido.

---

## 9. Arquivos que serão tocados (estimativa)

- `scripts/wms/cenarios/run-all.ts` — modo prod-build, health-recovery, taxonomia.
- `scripts/wms/cenarios/_harness/{http.ts,dev-server.ts,types.ts,relatorio.ts,invariantes.ts}`
  — retry, recuperação de servidor, taxonomia, I8/I2/I3.
- `scripts/wms/cenarios/catalogo/` — ~5 cenários novos (workstream C).
- `supabase/migrations/` — `wms_truncate_operacional` (+`siso_transferencias_galpao`),
  `wms_detectar_divergencias_reservado()`.
- `.github/workflows/wms-stock-suite.yml` — novo.
- `package.json` — script de modo prod (ex.: `scenarios:ci`) se necessário.
- Correções de produto conforme a triagem (B) revelar.
- `CLAUDE.md` / docs — atualizar status da sistemática de testes.
