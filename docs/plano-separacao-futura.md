# Separação Futura — pré-carregar vendas com etiqueta segurada (ML buffered)

> Status: **IMPLEMENTADO (2026-06-24).** Fases 0-8 entregues, build verde, 27 testes unit novos.
> Data: 2026-06-24 · Autor: Eryk + Claude

## ✅ Implementado (2026-06-24)

| Fase | O que entrou | Arquivos |
|---|---|---|
| 0 | `getMlShipmentStatus` (substatus via `GET /shipments/{id}` — o `/sla` NÃO tem substatus) | `src/lib/ml-api.ts` + test |
| 1 | coluna `siso_pedidos.separacao_futura` + índice parcial | `migrations/20260624_separacao_futura.sql` |
| 2 | intake futura propria: R com TTL derivado (`dataPrevista+14d`), marcador `SEP FUTURA`, tag `FUTURA`, status `aguardando_separacao`, SEM `lancar_estoque` | `webhook-processor-wms.ts`, `wms/separacao-futura.ts` |
| 3 | OC futura sem NF (gate `!separacao_futura` em `executarMarcadoresOnly` + `reconciliador-oc`) | `execution-worker.ts`, `wms/reconciliador-oc.ts` |
| 4 | poll Tiny de abertos + classificador ML (`buffered` → futura) | `tiny-polling-futura.ts`, `api/wms/tiny/polling-futura/route.ts` |
| 5 | tela `/wms/separacao-futura` + filtro `?futura=1` na fila (RPC `wms_separacao_counts` ganhou `p_separacao_futura`) | `app/wms/separacao-futura/page.tsx`, `api/wms/separacao/route.ts`, `migrations/20260624b_*.sql` |
| 6 | promoção (etiqueta liberou): flip flag ANTES do upsert + enfileira `lancar_estoque` (gera NF) | `webhook-processor-wms.ts` |
| 7 | preempção pré-pick (`preempcaoViabiliza` + demoção da futura pra OC) | `wms/preempcao-futura.ts` |
| 8 | cancelamento: futura picada estorna S (volta à prateleira), não devolução manual | `pedido-cancel-handler.ts` |
| 9 | **encaixotamento por dia** (etapa pós-separação): operador bipa SKU/EAN + qty → sistema deposita nas caixas = DIA de `prazo_envio` dos pedidos futura `separado`, FIFO por prazo (mais urgente 1º); mostra todas as caixas de uma vez; rastreia no banco (`quantidade_encaixotada` por item, `encaixotado_em` no pedido). NÃO muda `status_separacao`. Tela `/wms/encaixotamento` reusa `HandheldScan` + fila serial da conferência | `migrations/20260624d_encaixotamento.sql` (RPCs `wms_encaixotar_atomico`/`wms_desencaixotar_atomico`), `api/wms/encaixotamento/{route,bipar,desfazer}`, `app/wms/encaixotamento/page.tsx` |

**Correção da spec:** `substatus` NÃO vem do `/sla` (só status/expected_date) — vive no objeto shipment (`GET /shipments/{id}`). Fase 0 é fn nova, não extensão do SLA.

**Pendente (operacional, não-código):**
- Agendar pg_cron pro `/api/wms/tiny/polling-futura` (~30min) — ML-heavy; mirror do `wms-worker-kick`. Não auto-agendado.
- Confirmar em campo: `situacao` exata do Tiny pra abertos (usei `0`); se o webhook do Tiny dispara no flip buffered→ready (senão promoção roda no poll).
- E2E (`scenarios`/`test:integration`) não rodados aqui (truncam staging + exigem `ALLOW_STAGING_WIPE`).

---


---

## 1. Problema

Hoje o app só age na venda quando a etiqueta libera. Resultado: descobrimos que uma
venda precisa de compra **no dia que libera a etiqueta** — tarde demais pra comprar.
Ficamos vendidos (oversold) sem lead time.

A causa: existem vendas **já pagas** cuja **etiqueta o ML segura pra uma data futura**.
Essas vendas são invisíveis pro app hoje.

### Prova de campo (2 pedidos reais, NetAir, 2026-06-24)

| | `2000017088119608` (Condensador R$789) | `2000017087998330` (Botão R$54,90) |
|---|---|---|
| ML order `status` | `paid` | `paid` |
| ML payment | **approved** | **approved** |
| **ML `shipment.substatus`** | **`ready_to_print`** | **`buffered`** |
| ML entrega estimada | 2026-06-26 | 2026-07-14 |
| Tiny `situacao` | **1** | **0** |
| Tiny `dataPrevista` | 2026-06-26 | 2026-07-14 |
| Está no `siso_pedidos`? | **SIM** (1046474871, foi OC) | **NÃO — app cego** |

**Conclusões factuais:**
- Pagamento **não** distingue futuro de agora — os dois estão `paid`/`approved`.
- O sinal autoritativo de "futuro vs agora" é **`shipment.substatus`** do ML
  (`buffered` = etiqueta segurada; `ready_to_print` = liberada).
- **O pedido buffered JÁ EXISTE no Tiny** (situacao=0), com `dataPrevista`. Logo **não
  precisamos construir um poller de orders do ML** — o intake continua Tiny-driven.
- O app não enxerga o buffered porque hoje só processa o que o webhook empurra (o Tiny
  só dispara o webhook quando o pedido avança, e o buffered fica preso em situacao=0).

---

## 2. Decisões travadas (Eryk)

1. **Reserva no ato.** Venda paga (mesmo buffered) reserva estoque WMS imediatamente —
   é venda certa.
2. **Sem NF até a etiqueta.** Não gera NF nem marca faturamento no Tiny enquanto buffered.
   Motivo: alta taxa de cancelamento na espera → NF emitida que cancela = imposto sobre
   dinheiro que não entrou (irreversível). Bônus: o ML só **aceita** a NF quando libera a
   etiqueta (`invoice_pending`), então segurar a NF é também a mecânica do ML.
3. **Pick físico já (A2).** O operador separa a peça de verdade na pista futura (estoque
   baixa). Peça vai pra uma **caixa ao lado da bancada de etiqueta/fechamento, organizada
   por dia**. Cancelou → estorna e volta pra prateleira (re-trabalho, aceito).
4. **OC automático já (B2).** Buffered sem estoque → dispara a compra na hora (lead time
   máximo). Comprou e a venda cancelou → peça fica em estoque pra próxima venda (aceito).
5. **Marcador no Tiny.** Marca o pedido no Tiny com marcador específico (ex.: `SEP FUTURA`)
   pra visibilidade — **marcador ≠ NF**.
8. **Identificação pro operador** (como saber futura×normal e separada×não):
   - **Pista/tela separada**: a futura vive em `/wms/separacao-futura`; não aparece na fila
     normal. O lugar onde aparece já diz se é futura ou envia-hoje.
   - **Tag no card (app)**: badge `FUTURA` via `siso_pedidos.separacao_tags[]` — visível em
     qualquer tela que mostre o pedido.
   - **Marcador no Tiny**: `SEP FUTURA` (item 5).
   - **"Já separada?"** = o `status_separacao` da futura: `aguardando_separacao` (não picou)
     vs `separado` (picou, na caixa do dia). Na **promoção** entra no fluxo normal já em
     `separado` → cai direto na fila de **embalagem**, não na de separação; o badge `FUTURA`
     permanece pro embalador saber que a peça está na caixa do dia.
6. **Preempção (estoque escasso): venda que envia AGORA ganha de buffered.** Detalhe
   importante (ver §5): só dá pra preemptar enquanto a futura está **reservada e ainda não
   foi picada**. Depois de picada (peça na caixa) está comprometida → a venda nova vai pra OC.
7. **Módulo separado.** Tela de separação futura **distinta** da normal, pra não confundir a
   operação. Mesmo princípio de pick, só que **sem `aguardando_nf`** e **para em `separado`**
   (sem embalagem/conferência/expedição agora).

---

## 3. Arquitetura (Tiny-driven + ML como classificador)

```
NOVO: poll Tiny de pedidos ABERTOS (situacao 0/1, ainda não aprovados)
  → pra cada pedido ML, lê shipment.substatus no ML (getMlShipmentSla estendido)
        ├─ substatus = buffered          → PISTA FUTURA
        └─ substatus = ready_to_print/…  → ignora aqui (fluxo normal de hoje já pega)
  ↓
PISTA FUTURA (reusa processWebhookWms, marcando separacao_futura=true):
  → resolverItensWms + rotearPedidoDoBanco
  → RESERVA R (TTL longo) no ato                       [reusa criarReservasRotaAtomico]
  → marcador Tiny "SEP FUTURA"                          [criarMarcadoresPedido]
  → SEM gerar NF, SEM lancar_estoque_pos_nf            [DIFERENÇA vs normal]
  → rota:
        ├─ propria  → "futura: aguardando separação"
        └─ oc (B2)  → cria compra SEM NF → "futura: aguardando compra"
                       → recebe → "futura: aguardando separação"
  → operador separa (pick real, L+S, estoque baixa)     [reusa wms_pick_item_atomico]
  → "futura: separado"  ◄── PARA AQUI (peça na caixa, por dia)
        │
        │  ML libera etiqueta: substatus → ready_to_print
        │  → Tiny avança situacao → webhook normal dispara pro MESMO tiny id
        ▼
PROMOÇÃO (dentro do processWebhookWms, ao detectar que o pedido já era futura):
  → flipa separacao_futura=false
  → AGORA gera NF + agrupamento (lancar_estoque de hoje)
  → entra no fluxo NORMAL já em "separado" → embalagem → conferência → expedição
```

**Por que isto é simples:** o `siso_pedidos.id` É o id do Tiny. Quando a etiqueta libera, o
webhook normal chega com o **mesmo id** → o upsert casa no pedido futura que já existe →
a reserva é idempotente (P003, não duplica) → só promovemos. Sem dedup ML↔Tiny, sem id
paralelo.

---

## 4. O que reusa vs net-new

**Reusa (sem tocar):**
- `processWebhookWms` / `resolverItensWms` / `rotearPedidoDoBanco` (intake + roteamento)
- `criarReservasRotaAtomico` + `wms_reservar_atomico` (reserva idempotente, P003)
- pick (`wms_pick_item_atomico`) — já faz L+S **sem NF** (cutover.ts, 2026-05-28)
- `criarMarcadoresPedido` (tiny-api.ts:701) — marcador no Tiny
- criação de OC (`findOrCreateOcAberta` / sourcing) — só precisa rodar **sem NF**
- `lancar_estoque` + agrupamento — disparam **na promoção**, não antes
- cancelamento (`pedido-cancel-handler`) — já libera reserva / estorna

**Net-new:**
1. **Poll Tiny de abertos** (situacao 0/1) — variante de `tiny-polling.ts`.
2. **Classificador ML substatus** — estender `getMlShipmentSla` p/ retornar `substatus`
   (hoje só retorna `expected_date`/`status`).
3. **Flag `separacao_futura`** em `siso_pedidos` + estados da pista (ver §5).
4. **Branch "futura" no intake**: pula NF/lancar_estoque; OC-futura cria compra sem NF.
5. **Promoção** em `processWebhookWms`: detectar pedido futura virando ready → flipar +
   seguir pro caminho normal de NF.
6. **Preempção**: ao rotear venda ready com estoque escasso, soltar reserva de futura
   ainda-não-picada do mesmo SKU antes de mandar a ready pra OC.
7. **Tela** `/wms/separacao-futura` + fila filtrada por `separacao_futura=true`.
8. **Tag `FUTURA`** em `separacao_tags[]` (badge no card) — identificação que viaja até a
   embalagem após a promoção.

---

## 5. Máquina de estados da pista futura

Proposta: **flag `separacao_futura` (boolean)** + reutilizar valores de `status_separacao`,
filtrando a tela por flag. (Alternativa: estados dedicados `futura_*` — mais verboso, mais
isolado. Decisão de implementação na Fase 1.)

```
                    (sem estoque, B2)
  intake futura ──────────────► aguardando_compra ──recebe──┐
       │                                                    │
       │ (tem estoque)                                      ▼
       └──────────────────────────────► aguardando_separacao
                                                  │
                                          em_separacao (pick real, L+S)
                                                  │
                                              separado  ◄── PARA (peça na caixa/dia)
                                                  │
                                   [ML libera etiqueta → webhook]
                                                  │ PROMOÇÃO (flag=false)
                                                  ▼
                              gera NF + agrupamento → embalagem → conferência → expedição
```

**Diferenças vs separação normal (só estas):** sem `aguardando_nf`; não toca faturamento
Tiny até a etiqueta; para em `separado`; tela própria.

**Preempção (regra exata):** a reserva da futura só pode ser solta enquanto a peça **não
foi picada** (R ainda viva). Depois do pick, o estoque já baixou (R→L+S) e a peça está na
caixa — comprometida. Logo: ready escasso preempta **somente** futura em
`aguardando_separacao` (reservada, não picada); futura já `separado` está travada e a ready
vai pra OC.

---

## 6. Pontos a verificar no build (não bloqueiam a spec)

- **Taxonomia `situacao` do Tiny.** Observado: buffered=`0`, ready=`1`, e o poll atual mira
  `3` (aprovado). Confirmar o conjunto exato de códigos "aberto/futuro" a varrer (a
  classificação real vem do ML substatus; o Tiny situacao é só o filtro grosso do poll).
- **Webhook do Tiny dispara no flip** (situacao sobe quando ML libera)? Se sim, a promoção
  é de graça. Se não, a promoção também roda no próprio poll (re-checar substatus).
- **NF↔S no ledger.** Como o pick-futura cria o S **sem** `nota_fiscal_id`, e a NF nasce
  depois — confirmar se a rastreabilidade fiscal exige vincular a NF ao S a posteriori, ou
  se o desacople atual (já existente) é aceitável.
- **OC sem NF.** Fatorar a criação de compra pra fora de `executarMarcadoresOnly` (que hoje
  tenta gerar NF antes da compra).
- **Marcador exato** (`SEP FUTURA`?) + se deve ser removido na promoção.

---

## 7. Plano TDD (fases verificáveis — cada uma testável e revisável isolada)

> Migrations e RPCs em staging (`ehbxpbeijofxtsbezwxd`). TDD: teste primeiro, faz passar.

**Fase 0 — Classificador ML substatus**
- Estender `getMlShipmentSla` (ou nova `getMlShipmentStatus`) p/ retornar `substatus`.
- ✅ Verifica: teste unit com fixtures dos 2 pedidos reais → `buffered` vs `ready_to_print`.

**Fase 1 — Schema da pista futura**
- Migration: `siso_pedidos.separacao_futura boolean default false` (+ índice parcial).
- Decidir flag vs estados dedicados.
- ✅ Verifica: migration aplica em staging; pedido normal continua `separacao_futura=false`.

**Fase 2 — Intake futura (reserva, sem NF)**
- Branch em `processWebhookWms`: quando `separacao_futura`, cria R + marcador Tiny, **não**
  enfileira `lancar_estoque`; propria→`aguardando_separacao`, sem NF/S.
- ✅ Verifica: cenário E2E — pedido futura com estoque → R criada, **zero** mov S, **zero**
  NF, marcador presente, aparece só na fila futura.

**Fase 3 — OC futura (B2, sem NF)**
- Buffered sem estoque → cria compra (OC) sem gerar NF.
- ✅ Verifica: cenário — futura sem saldo → compra aberta, sem NF, status
  `aguardando_compra`; receber → `aguardando_separacao`.

**Fase 4 — Poll Tiny de abertos + classificação ML**
- Job: varre Tiny situacao aberta → classifica via ML substatus → dispara intake futura só
  pra `buffered`.
- ✅ Verifica: rodar contra staging → o `2000017087998330` (buffered) entra como futura; o
  `…119608` (ready) **não** é duplicado.

**Fase 5 — Pick futura + tela**
- `/wms/separacao-futura` (lista filtrada) reusando o checklist de pick; para em `separado`.
- ✅ Verifica: pick na tela futura → L+S, estoque baixa, status `separado`, **não** avança
  pra embalagem.

**Fase 6 — Promoção (etiqueta liberou)**
- Em `processWebhookWms` (ou no poll): pedido futura vira ready → flag=false → gera NF +
  **cria agrupamento no Tiny** (sai a etiqueta) → entra no fluxo normal em `separado`. Mantém
  o badge `FUTURA` no card pro embalador.
- ✅ Verifica: cenário — futura `separado` recebe webhook ready → NF gerada (1x) +
  **agrupamento criado (1x)**, reserva **não** duplica, pedido cai na fila de **embalagem**
  (não na de separação).

**Fase 7 — Preempção**
- Roteamento de ready escasso solta reserva de futura não-picada do mesmo SKU.
- ✅ Verifica: cenário — 1 peça, futura reservou; ready cai → futura volta pra OC, ready vira
  propria. Repetir com futura JÁ picada → ready vai pra OC, futura intacta.

**Fase 8 — Cancelamento na espera**
- Buffered cancela → estorna S (se picada) + solta reserva + remove marcador; OC comprada
  fica em estoque.
- ✅ Verifica: cenário — cancelar futura picada → S estornado, saldo de volta; cancelar
  futura reservada → R liberada.

---

## 8. Riscos

- **Reserva fantasma**: buffered cancela muito → trava estoque que venda real precisava. A
  preempção (Fase 7) mitiga só pré-pick. Monitorar taxa de cancelamento buffered.
- **Pick antecipado**: A2 gera re-trabalho físico quando cancela. Aceito pelo Eryk.
- **Compra contra venda incerta**: B2 pode gerar dead stock. Aceito (autopeça gira).
- **Acoplamento ML**: depende do substatus do ML estar correto/estável. O Tiny situacao
  serve de rede (filtro grosso), mas a verdade é o ML.
