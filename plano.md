# Plano de Unificação WMS — Status & Roadmap

> Última atualização: **2026-05-12 (Plano 2 entregue em staging)** · Branch: `develop` · Build verde

---

## Status executivo

| Plano | Escopo | Status | Branch |
|---|---|---|---|
| **Plano 1** | Design unificado + implementação direta das telas em `/wms/*` | ✅ **Implementado em develop** (pivot: usuário autorizou codar direto em vez de só desenhar) | `develop` |
| **Plano 2** | Cutover de tabelas — WMS vira fonte da verdade do estoque, **staging-only** com Tiny stubado | ✅ **Implementado e validado em staging** (15/15 cenários E2E ✓, saídas R→L+S aplicadas via WMS, zero tráfego Tiny). Cutover real pra prod fica pro WMS-6 quando você decidir. | `develop` |
| **Plano 3** | Sistema de reservas por pedido (criada no `pendente`, persiste até `separado`) | 🟡 **Parcialmente entregue no Plano 2** — reservas criadas no pendente + conversão R→L+S no worker. Falta: cancelamento estornando reservas, encaminhamento cross-galpão, OC reserva atômica no recebimento, override admin "liberar e realocar". | — |
| **Plano 4** | Algoritmo de fulfillment com swap automático de dona | ⛔ Bloqueado por Plano 3 (resto) | — |

---

## Plano 1 — O que foi implementado (develop)

### Foundation
- **Shell unificado** (`src/components/wms/wms-shell.tsx`): nova seção "Vendas" no topo da sidebar (Pedidos · Separação · Compras). Cross migrado pra "Cadastros".
- **Filtro global de galpão** (`src/components/wms/filtro-galpao-global.tsx`): barra sticky no topo da view, reusa `useAuth().activeGalpaoId` (já persiste em `localStorage` e manda header `X-Galpao-Id` via `sisoFetch`). Aplica em todos os grupos.
- **Tokens Lever** em `wms.css` — só em CTAs/logo/links críticos (`--wms-c-brand-cyan`, `--wms-c-brand-navy`). Resto do WMS continua neutro.

### Componentes WMS-Vendas (`src/components/wms/vendas/`)
- `<EstoquePorGalpaoBar>` — pílulas 4 cores (info/warn/danger/mute) exibindo `disponível` (não saldo)
- `<DecisaoLabel>` — substituto do dropdown de decisão legado, só galpão, nunca empresa
- `<ReservaIndicator>` — badge "X reservados em pedidos abertos"
- `<TabsStatusSeparacao>` — 6 tabs grossas com contadores
- `<ExcecoesBannerWms>` — banner de cancel/equiv/indisp (compras)
- `<TimelinePedido>` — eventos coloridos por tone (ok/info/warn/danger)
- `<PedidoCardWms>` — card de pedido WMS-native (zero menção a empresa)
- `<HandheldScan>` — input de bipagem sticky com feedback

### Telas novas (8 rotas)
| Rota | Função |
|---|---|
| `/wms/pedidos` | Lista universal com 4 sub-tabs (Pendente / Concluídos / Auto / Expedidos) |
| `/wms/pedidos/[id]` | Detalhe full-width com 4 tabs internas (Itens & estoque · Timeline · Observações · Ações admin) |
| `/wms/separacao` | 6 tabs por `status_separacao`, multi-select shift-range, ações em lote, tags, encaminhar, realtime |
| `/wms/separacao/checklist` | Wave picking handheld no DNA WMS; seção OC âmbar; "encontrei" → bipagem de localização |
| `/wms/separacao/embalagem` | Bipagem item-a-item + conferência, qty configurável |
| `/wms/compras` | 3 tabs (Comprar / Receber / Histórico) com cards por fornecedor + aging + `<ExcecoesBannerWms>` |
| `/wms/cross` | Busca universal SKU/OEM/nome |
| `/wms/cross/[sku]` | Detalhe + edição de OEMs e veículos |

### Ajustes em telas existentes
- `/wms/transferir` — chip de empresa **removido** (mostra só galpão→galpão, Decisão D4)
- `quadrupla-picker.tsx` — prop nova `hideEmpresa` + `galpaoId` pra modos de saída/movimentação interna

### Legado intocado
`/siso`, `/separacao/*`, `/compras/*`, `/pedidos/*`, `/painel/*`, `/cross/*`, `/inventario`, `/transferencias` — todas rodando como antes, sem interferência. Migração progressiva via sidebar.

### Decisões consolidadas (input fixo pra Planos 2-4)

| # | Decisão | Onde aparece na UI |
|---|---|---|
| D1 | wms.css isolado + acentos Lever só em CTAs/logo | tokens em `wms.css` |
| D2 | Sidebar com 5 grupos: Vendas + Visibilidade + Operações + Inventário + Cadastros | `wms-shell.tsx` |
| D3 | Filtro global de galpão persistente, aplica em todos os grupos | `filtro-galpao-global.tsx` |
| D4 | Operador nunca vê empresa em saídas/movimentação interna | cards de pedido/separação/compras/transfer |
| D5 | Cards mostram só galpão origem/destino | `PedidoCardWms`, tabela de `/wms/separacao` |
| D6 | Dropdown de decisão some — rótulo final em termos de galpão | `DecisaoLabel` |
| D7 | 6 tabs grossas por status_separacao + embalagem como sub-rota | `TabsStatusSeparacao` + `/wms/separacao/embalagem` |
| D8 | Pílulas de estoque 4 cores reaproveitando tokens WMS | `EstoquePorGalpaoBar` |
| D9 | Detalhe de pedido = página dedicada | `/wms/pedidos/[id]` |
| D10 | Cancel pós-separado: alerta no card + ação no detalhe | banner em `PedidoCardWms` + tab Admin em `[id]` |
| D11 | OC "encontrei" no checklist: handheld bipagem de localização → reserva | `/wms/separacao/checklist` |
| D12 | Reserva criada no `pendente`, persiste até `separado` | placeholder UI (real depende do Plano 3) |
| D13 | Recebimento OC = entrada+reserva atômica | placeholder UI (real depende do Plano 3) |
| D14 | Painel ao vivo + Gerencial **fora de escopo da Fase 1** | usuário redefine KPIs depois |

### Refinamentos pós-implementação (paridade com legado)

| Commit | Mudança |
|---|---|
| `46dc797` | feat(wms): unifica vendas sob /wms — 18 arquivos, +8232 linhas |
| `b0b8cee` | fix(wms): paridade total das ações de separação com legado (tags, embalar com etiqueta, encaminhar, realtime, footer sempre visível) |
| `952ef60` | refactor(wms): ações de separação saem do footer sticky pra toolbar (não-sticky, junto com filtros) |

---

## Plano 2 — O que foi implementado (develop, validado em staging)

### Princípio: 2 flags ortogonais controlam o cutover

| Flag | Default prod | Função |
|---|---|---|
| `TINY_DISABLED` | `false` | Curto-circuita TODAS as chamadas Tiny pro stub local (`src/lib/tiny-stub.ts`). Stub lê de `siso_*` tables, escritas viram fake IDs no-op. |
| `WMS_AS_SOURCE` | `false` | Webhook lê estoque de `siso_estoque` (não Tiny); worker grava saídas via `wms_inserir_movimentacao` (não `lancarEstoqueNota`/`movimentarEstoque`). |

Em prod ambas ficam OFF → comportamento idêntico ao pré-Plano 2. Em staging `.env` ambas ON → app roda 100% desacoplado do Tiny real.

### Arquivos novos (10)
| Arquivo | Função |
|---|---|
| `src/lib/tiny-stub.ts` | Roteador central de mocks Tiny-shape (GET pedidos/produtos/estoque/notas + POST marcadores/gerar-nf/lancar-estoque/movimentar + expedição) |
| `src/lib/webhook-processor-wms.ts` | Fluxo WMS de webhook: lê siso_estoque, roteia via `rotearPedidoDoBanco`, cria reservas |
| `src/lib/execution-worker-wms.ts` | Converte reservas R→L+S no worker via `inserirMovimentacao`, idempotência por `estorno_de` |
| `src/lib/wms/flags.ts` | Helper `wmsAsSource()` |
| `scripts/wms/cenarios.ts` | 30 produtos sintéticos (FARTO/SOSP/SEM) + 15 cenários (propria/transferencia/oc/cancel-pre/cancel-pos/parcial) |
| `scripts/wms/seed-staging.ts` | Limpa pedidos/movs/estoque + popula produtos/saldos/regras-empréstimo |
| `scripts/wms/fake-webhook.ts` | Dispara um cenário avulso (CLI ou import) |
| `scripts/wms/seed-cenarios.ts` | Dispara os 15 cenários em sequência com cancel-pre/cancel-pos |
| `scripts/wms/verificar-saldos.ts` | Compara decisão esperada vs obtida + saldos por galpão |
| `supabase/migrations/20260512_wms_cutover_stub_pedidos.sql` | Tabela `siso_stub_pedidos` (staging-only, vazia em prod) |
| `supabase/migrations/20260512_wms_drop_old_inserir_mov_overload.sql` | Dropa overload duplicado de `wms_inserir_movimentacao` (quebrava `wms_reservar_atomico` quando p_criado_em era null) |

### Arquivos modificados (6)
| Arquivo | Mudança |
|---|---|
| `src/lib/tiny-api.ts` | `tinyFetch` curto-circuita pro stub no topo quando `TINY_DISABLED=true` |
| `src/lib/tiny-oauth.ts` | `getValidToken*` retorna token fake quando flag ON |
| `src/lib/webhook-processor.ts` | Após `getPedido`, branch `wmsAsSource()` chama `processWebhookWms` (legado intocado quando flag OFF) |
| `src/lib/execution-worker.ts` | `executarEstoquePosNf{Propria,Transferencia}` rotea pro WMS quando flag ON; `executarSaidaPropria` enfileira pos_nf direto (sem aguardar webhook NF que nunca chega em staging) |
| `package.json` | npm scripts: `seed:staging`, `fake:webhook`, `seed:cenarios`, `verificar:saldos` |
| `.env.example` | Documenta `TINY_DISABLED` + `WMS_AS_SOURCE` |

### Como rodar smoke E2E
```
npm run seed:staging      # limpa staging + popula 30 produtos + saldos + regras
npm run dev               # em outra aba (com .env: TINY_DISABLED=true, WMS_AS_SOURCE=true)
npm run seed:cenarios     # dispara 15 cenários sequencialmente
sleep 15                  # aguarda processWebhook async
npm run verificar:saldos  # imprime tabela esperado vs obtido + saldos
```
**Resultado validado:** 15/15 ✅, saldos NetAir/CWB 1285→1279 (saídas aplicadas), 8 conversões R→L+S no ledger, zero tráfego pra `api.tiny.com.br`.

### Decisões consolidadas no Plano 2

| # | Decisão | Implicação |
|---|---|---|
| P2-1 | **Staging-only, prod intocada**. Cutover de prod não está no escopo do Plano 2 — fica pro WMS-6 quando você decidir. | Tabelas e webhooks de prod continuam idênticos. Toda lógica nova é gated em flags off-by-default. |
| P2-2 | **Tiny stubado em vez de mockado por função**. Centralizamos no `tinyFetch` (1 ponto de injeção). | Adicionar novo endpoint Tiny no futuro só requer adicionar handler em `tiny-stub.ts`, não modificar callers. |
| P2-3 | **Reservas no pendente entram no Plano 2** (não no Plano 3 como originalmente planejado). | Plano 3 fica com escopo reduzido: cancelamento estornando, encaminhamento, OC atômica, override admin. |
| P2-4 | **Scripts em `scripts/wms/`, não rotas `/api/dev/*`**. | Código de teste fora do bundle Next.js. Conexão direta com service role. |
| P2-5 | **Idempotência por `estorno_de`** (não por `origem_id`). | Re-runs do seed:cenarios funcionam — L's antigos do mesmo pedido_id não bloqueiam novas conversões. |
| P2-6 | **Legacy cleanup (`inventario-processor`, `transferencia-processor`) adiado pro WMS-6**. | Em staging com flags ON, esses procs caem em stub no-op (não quebram). UI legada `/inventario` e `/transferencias` continua funcionando em prod sem WMS. |
| P2-7 | **`siso_pedido_itens` legacy columns (`estoque_cwb_*`, `estoque_sp_*`) ficam null/0 em WMS mode**. UI já lê de `siso_pedido_item_estoques` (normalizado). | Compatibilidade backwards preservada sem trabalho extra. |

### Bugs descobertos e resolvidos em staging
- **`wms_inserir_movimentacao` ambiguidade de overload**: PG tinha 2 overloads (16 e 17 args) que conflitavam quando `p_criado_em=null` era passado. `wms_reservar_atomico` (1 caller interno) falhava por isso. Migration `20260512_wms_drop_old_inserir_mov_overload.sql` dropou o overload de 16 args.
- **`executarEstoquePosNfWms` skip-all em re-runs**: a checagem inicial "se já tem L com `origem_id=pedido_id`, skip tudo" pulava conversão de NOVAS reservas em re-runs do staging. Refatorado pra filtrar por `estorno_de=R.id` (1 L por reserva).
- **Pedido `estoque_lancado=true` persistia entre seeds**: re-runs deixavam o flag setado mesmo após reset. Fix: `processWebhookWms` reseta `estoque_lancado: false, nf_estoque_lancado: false` no upsert, mas com guard idempotente acima (pedido já em estado lançado → skip silencioso pra cobrir double-webhook em prod).
- **cancel-pre-1 retornava `cancelled_unknown`**: webhook de cancel chegava antes do `processWebhook` async ter persistido o pedido. Sleep entre approve e cancel aumentado de 500ms → 3500ms em `seed-cenarios.ts`.
- **Regras de empréstimo NetAir↔NetParts faltavam**: sem elas `rotearPedidoDoBanco` caía em `oc` em vez de `transferencia`/`emprestimo`. Adicionadas via `seedRegrasEmprestimo()` no seed.

---

## Bugs ativos / próximos passos imediatos

| Prioridade | Bug | Status |
|---|---|---|
| 🔴 Alta | **Tabs com count = 0 não permitem entrar** — usuário não consegue clicar em tab vazia | Pendente (Task #14) |
| 🔴 Alta | **Falta "Embalar direto" na tab Aguardando OC** — o legado tem botão verde "Embalar X pedido(s)" quando há pedidos com `nf_emitida && agrupamento_criado`, abrindo `/wms/separacao/embalagem?modo=embalagem-oc` (modo onde produto já chega "separado" e operador só bipa) | Pendente (Task #15) |
| 🟡 Média | Lint warnings de React Compiler em arquivos legados (`react-hooks/preserve-manual-memoization`, `react-hooks/refs`) — não bloqueiam build | Backlog |
| 🟡 Média | `/wms/separacao/embalagem` tem 2 refs acessadas durante render (warning) — funcional, vira `useState<Set>` em polish | Backlog |
| 🟢 Baixa | Realtime via `useRealtimeSeparacao()` funciona, mas pode adicionar em `/wms/pedidos` e `/wms/compras` quando útil | Backlog |

---

## Roadmap — Planos 3 e 4 (próximos passos)

### Plano 3 — Reservas residuais + cancelamento + OC atômica

**Status:** parcialmente entregue no Plano 2 (criação de reserva no pendente + conversão R→L+S). O que falta:

**Pré-requisito:** Plano 2 entregue ✅. Branch já tem reservas atômicas funcionando para o caminho feliz.

**Escopo residual:**

1. **Cancelamento pré-separado libera reservas** — hoje o cancel webhook só seta `status=cancelado`, mas as movs R do pedido ficam ativas no ledger. Adicionar chamada `liberarReserva(pedido_id, motivo='cancelamento')` (helper já existe em `src/lib/wms/reservas.ts`) no handler de cancel em `/api/webhook/tiny/route.ts`.
2. **Cancelamento pós-separado faz entrada compensatória** — após `separado`, as reservas viraram saídas (S). Cancel precisa fazer movs E pra cada SKU (estorno). Marcar `compra_estoque_lancado_alerta=true` (flag já existe).
3. **Recebimento OC atômico** — endpoint `/api/compras/receber` deve chamar nova RPC `wms_receber_oc_atomico(item_id, qty, localizacao_id)` que executa E (entrada) + R (reserva vinculada ao pedido original) numa transação. Sem isso, OC recebida não reserva pro pedido que motivou a compra.
4. **Encaminhamento cross-galpão** — endpoint `/api/separacao/encaminhar` deve liberar reservas no galpão antigo + criar reservas no destino. Hoje só transita status.
5. **Override admin "liberar reserva e realocar"** — endpoint novo `POST /api/pedidos/[id]/liberar-reserva` (admin only) que libera todas as reservas do pedido e marca como pendente pra realocação.
6. **TTL/cleanup automático de reservas expiradas** — cron diário rodando `cleanupReservasExpiradas()` (já implementado em `src/lib/wms/reservas.ts`). Configurar via Vercel Cron ou GitHub Actions.

**Cenários E2E pra adicionar em `scripts/wms/cenarios.ts`:**
- `cancel-pre-libera-reserva`: cancel pré-separado → reservas estornadas em siso_movimentacoes (L vinculadas ao mesmo pedido_id)
- `cancel-pos-estorna-saida`: cancel pós-separado → entrada compensatória aplicada, alerta UI setado
- `oc-recebimento-atomico`: pedido OC recebido → entrada + reserva criadas atomicamente
- `encaminhar-cross-galpao`: pedido encaminhado → reserva movida de NetAir/CWB pra NetParts/SP

**Critério de Done:** verificar-saldos passa em 19/19 cenários (15 atuais + 4 novos). `siso_movimentacoes` mantém chain consistente em todos os caminhos.

**Riscos / cuidados:**
- Cancelamento pós-separado é destrutivo no ledger (cria E compensatória de qty grande). Sempre logar + setar alerta visual. Não disparar automaticamente em cascata.
- OC recebimento atômico precisa lidar com recebimento parcial (5 chegam, 5 faltam → 5 reservas, item ainda pendente de recebimento).
- Override admin precisa de log de auditoria (`siso_pedido_historico`) pra rastreabilidade contábil.

---

### Plano 4 — Algoritmo de fulfillment com swap

**Pré-requisito:** Plano 3 residual entregue.

**Escopo:** (inalterado do plano original)

1. **RPC `wms_executar_swap`** — 4 movimentações no ledger numa transação atômica (saída Z + entrada X em galpão_z; saída X + entrada Z em galpão_x). Locks pessimistas, idempotente.
2. **RPC `wms_resolver_fulfillment(pedido_id)`** — calcula plano (direto / swap / empréstimo / oc) sem aplicar. Retorna `{ classificacao_sugerida, plano[], feasible }`.
3. **RPC `wms_aplicar_fulfillment`** — aplica plano. Re-valida feasibility dentro do lock.
4. **Modificação no `webhook-processor-wms.ts`** — usa `wms_resolver_fulfillment` em vez do `rotearPedidoDoBanco` atual.
5. **Modificação no `execution-worker-wms.ts`** — simplifica ainda mais; a dedução já é feita pelo conversor R→L+S, swap só altera quem é a dona da reserva (não há trabalho extra no worker).
6. **UI de aprovação** — `DecisaoLabel` ganha tooltip "Vai swappar 3 unidades com NetParts" (debug/transparência). Operador continua só vendo galpão.

**Critério de Done:** swap perfeito + parcial + regular + fallback empréstimo + fallback OC + concorrência (2 pedidos simultâneos) testados E2E. Operador nunca vê empresa.

---

### WMS-6 — Cutover de prod (separado dos Planos 2-4)

**Status:** runbook existe em `docs/superpowers/plans/2026-06-12-wms-6-go-live.md`. Não foi executado.

**Pré-requisitos:**
- Plano 2 ✅
- Plano 3 ✅ (reservas residuais)
- Plano 4 (opcional — pode rolar sem swap, mantendo lógica atual de transferência)

**Quando você decidir fazer:**
1. Aplica as migrations WMS em prod (snapshot Tiny → siso_estoque + 5 migrations dos planos WMS 1-5)
2. Liga `WMS_AS_SOURCE=true` + `TINY_DISABLED=false` no env de prod via Vercel
3. Monitora `wms_detectar_divergencias_estoque` por algumas horas
4. Hard delete dos processors legados (`inventario-processor.ts`, `transferencia-processor.ts`) — substituídos pelos módulos WMS

A grande diferença vs WMS-6 original: agora **não é big bang necessário**. Ligar só `WMS_AS_SOURCE=true` em prod (mantendo `TINY_DISABLED=false`) já dá leituras e escritas WMS-source, com Tiny continuando a receber chamadas reais (gerarNotaFiscal, lancarEstoqueNota). Tiny vira escravo no `lancarEstoqueNota` por consequência (saídas WMS já deduziram via RPC; Tiny `lancarEstoqueNota` ainda roda mas com saldo separado). Replicação reversa Tiny ainda é ADR aberto — pode rolar como hotfix se NF começar a sair errada.

---

## Notas operacionais

- **Branch**: `develop` (não tocar `main` durante a migração)
- **Supabase**: staging (`ehbxpbeijofxtsbezwxd`) — todo escrita técnica passa por ele antes de prod (`wrbrbhuhsaaupqsimkqz`)
- **Co-author**: commits assinados como `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

---

# Prompts originais (referência histórica)

Os 4 prompts abaixo foram o input original do projeto. **Plano 1 já foi pivotado** (usuário autorizou implementação direta em vez de só desenhar). Mantidos aqui pra reuso quando abrirmos chats separados para Planos 2, 3 e 4.

---

 Prompt 1 — Design unificado das telas no DNA WMS

 # Objetivo

 Produzir o **design completo** (zero código) do sistema unificado, onde todos os módulos
 (pedidos, separação, compras, Cross, painel, etc.) vivem embaixo de `/wms` como subáreas de uma
 plataforma coerente. Todos os módulos legados são redesenhados pra caber no DNA visual do WMS
 atual — não o contrário.

 Esse é o **Plano 1 de 4** num projeto maior de unificação. Os planos 2, 3 e 4 são técnicos
 (cutover de tabelas, sistema de reservas, algoritmo de swap) e dependem dos artefatos deste.

 # Princípio fundamental

 O design final é o **design do WMS atual** (`/wms/*`, `wms-shell.tsx`, padrões já implementados
 nos Planos WMS 1-5). SISO, separação, compras, pedidos, painel — todos são redesenhados pra caber
  no paradigma WMS, **não o contrário**.

 - Referência canônica: `src/app/wms/*` + `src/components/wms/*`
 - UI legada (`AppShell`, `<GalpaoSelector>` global, `<PedidoCard>`, `<SeparacaoCard>`, tabs
 estilo `/siso`) é **a ser substituída**, não preservada
 - Lógica de negócio é preservada (regras de aprovação, wave picking, OC, exceções de compras); só
  a casca/IA/visual muda
 - Onde o WMS atual ainda não tem pattern (ex: pílulas de estoque por galpão na aprovação,
 dropdown de decisão, bipagem de embalagem), desenha um novo seguindo o **DNA visual do WMS** —
 sem inventar do zero nem copiar do SISO

 # Decisões já tomadas (input fixo)

 1. **Reserva durante ciclo de vida do pedido**: criada no `pendente`, persiste até `separado`,
 vira saída no `separado`. Implica UI mostrando "reservado" pra operadores não-separação.
 2. **Itens OC: reserva nasce no recebimento físico**: entrada+reserva atômica vinculada ao pedido
  original. Implica UI de recebimento mostrando vínculo.
 3. **Empresa dona é metadado contábil em operações de saída e movimentação interna**: operador
 nunca vê escolha de empresa em separação, transferência inter-galpão, replenishment ou ajuste de
 saída. Vê só galpão. **Exceção: recebimento (entrada de estoque) mantém o campo de empresa dona**
 — operador sabe ou pergunta quem comprou o item. Pra OC, vem pré-preenchido do pedido de compra;
 pra entrada avulsa, é escolha manual. Mapeamento default: NetAir→CWB, NetParts→SP, 141AIR→SP.
 Swap automático rola invisível nas saídas.

 # Artefatos esperados

 1. **Information Architecture (IA)** — sitemap completo de `/wms/*` unificado. Mapeamento de
 rotas antigas → novas + estratégia de redirects (`/siso/*`, `/separacao/*`, `/compras/*`,
 `/pedidos/*`, `/painel/*`, `/cross/*` → `/wms/*`).
 2. **Design system aplicado** — referência primária: `src/app/wms/` + `src/components/wms/`.
 Apoio: skill `lever-talents-brand`, `.claude/figma-power/`, `docs/design-changelog/`. **Não**
 importar padrões do SISO/separação.
 3. **Telas-chave redesenhadas** — ASCII ou Figma, decida com o usuário. Cobertura mínima:
    - Dashboard de pedidos pendentes (pílulas de estoque por galpão, dropdown de decisão
 `propria`/`transferencia`/`oc`)
    - Detalhe do pedido com timeline e ações administrativas
    - Painel de separação (6 tabs por status_separacao)
    - Checklist de wave picking com bipagem (input autoFocus, consolidação por SKU)
    - Tela de embalagem (bipagem + conferência item-a-item)
    - Dashboard de compras (Comprar / Receber / Histórico) com cards por fornecedor
    - Banner de exceções de compras (indisponível, equivalente, cancelamento)
    - **Transferência inter-galpão simplificada** (só galpão origem + destino, sem campo de
 empresa — dona é sticky)
    - **Tela de recebimento** (compras/receber + WMS receber) — **mantém campo `empresa_dona`**;
 pra OC vem pré-preenchido, pra entrada avulsa operador escolhe
    - **Painel operacional (torre de controle)** e **Painel gerencial**
    - Cross (busca universal de produtos, edição de OEMs e veículos)
 4. **Data flow diagrams** — Mermaid pros principais cenários pós-cutover:
    - Pedido `propria` (auto-aprovado)
    - Pedido `propria` com swap parcial/total (Decisão 3)
    - Pedido `transferencia` (mover físico necessário)
    - Pedido `oc` (compra → recebimento atômico → release → separação)
    - Cancelamento pré-`separado` (libera reserva)
    - Cancelamento pós-`separado` (estorno completo)
    - Encaminhamento cross-galpão
 5. **ADRs (Architecture Decision Records)** — decisões abertas pra resolver com o usuário:
    - **Replicação reversa pro Tiny**: Tiny continua sendo atualizado pra NF sair correta? Sync ou
  async? Qual ordem?
    - **Dual-write vs shadow read** durante a transição
    - **Localizações no checklist**: fonte da verdade Tiny ou WMS durante a onda de cutover?
    - **`<GalpaoSelector>` legado**: como filtro global se traduz no DNA WMS (que usa
 empresa+galpão por contexto de tela)?
    - **Algoritmo de fulfillment**: RPC único atômico ou pipeline? Como tratar concorrência?
 6. **Plano de ondas pra Fase 2** — sequência de implementação com critérios de Done e testes E2E
 por onda.
 7. **Critérios de sucesso da fase** — checklist de aprovação antes de o usuário começar Fase 2.

 # Restrições

 - **Zero código nesta fase.** Só artefatos: Markdown, ASCII, Mermaid, Figma se necessário
 - **DNA visual: WMS atual é canônico.** SISO/separação UI é legado a ser substituído
 - **Operador nunca vê empresa** em nenhuma tela (Decisão 3 fixada)
 - Cada artefato precisa de **revisão e aprovação do usuário** antes do próximo começar
 - Padrão de spec: seguir o que está em `docs/superpowers/specs/` (3 specs existentes:
 cross-module-design, wms-design, wms-staging-playground-design)

 # Leitura inicial obrigatória

 Antes de propor qualquer coisa:

 - `CLAUDE.md` — overview geral + status WMS
 - `docs/fluxos/README.md` — panorama dos 10 fluxos legados
 - `docs/fluxos/03-aprovacao-decisao.md` — UI da aprovação atual (pra entender o que substituir)
 - `docs/fluxos/05-separacao-wave-picking.md` — UI da separação atual
 - `docs/fluxos/07-compras-v2.md` — UI das compras atual (Comprar/Receber/Histórico)
 - `src/app/wms/` (16 diretórios) — todas as telas WMS atuais pra absorver o DNA visual
 - `src/components/wms/` — componentes canônicos (`wms-shell.tsx`, `quadrupla-picker.tsx`,
 `saldo-perspectiva-tabs.tsx`, etc.)
 - `docs/superpowers/specs/2026-05-07-wms-design.md` — spec WMS original
 - `docs/design-changelog/001-brand-identity-lever.md` — identidade visual Lever

 # Como começar

 Diga ao usuário literalmente:

 "Antes de propor qualquer coisa, vou ler os arquivos listados acima — especialmente as telas WMS
 atuais pra absorver o DNA visual e as 3 decisões já tomadas pra entender as implicações de UX.
 Depois te apresento um resumo do que entendi (especialmente sobre o gap entre os módulos legados
 e o paradigma WMS) e te pergunto sobre os pontos que ficaram ambíguos antes de propor a estrutura
  dos artefatos da Fase 1."

 Não proponha estrutura nem comece a desenhar sem antes ter conversado sobre o resumo da leitura.

 ---
 Prompt 2 — Cutover das tabelas de estoque (foundation técnica)

 # Objetivo

 Fazer o WMS virar **fonte da verdade do estoque**, substituindo o Tiny ERP nas operações de
 leitura e escrita. Tiny passa a ser escravo opcional — atualizado a partir do WMS pra que NFs
 continuem saindo corretas, mas não dita mais o saldo.

 Esse é o **Plano 2 de 4** num projeto maior de unificação. É a foundation técnica — os Planos 3
 (reservas) e 4 (swap) dependem dele. Plano 1 (design) roda em paralelo.

 **Importante:** já existe `docs/superpowers/plans/2026-06-05-wms-6-go-live.md` que cobre cutover.
  Antes de propor qualquer coisa nova, **leia esse plano e decida**: este Plano 2 (a) **estende**
 WMS-6, (b) **substitui** WMS-6, ou (c) **referencia** WMS-6 como base e adiciona escopo.
 Recomendação: ler primeiro, decidir com o usuário.

 # Decisões já tomadas (input fixo)

 1. **Reserva durante ciclo de vida do pedido**: criada no `pendente`, persiste até `separado`,
 vira saída no `separado`. Sistema atual de movimentação direta em NF é substituído pelo modelo de
  reserva→saída.
 2. **Itens OC: reserva nasce no recebimento físico**: entrada+reserva atômica vinculadas ao
 pedido original.
 3. **Empresa dona é metadado contábil em operações de saída**: operador nunca vê escolha de
 empresa em saídas/movimentações internas. **Exceção: tela de recebimento mantém campo
 `empresa_dona`** — pra OC vem pré-preenchido do pedido de compra, pra entrada avulsa operador
 escolhe. Galpão preferencial em `siso_empresas.galpao_id` (NetAir→CWB, NetParts→SP, 141AIR→SP).
 Swap automático será implementado no Plano 4 — neste plano, basta que o cutover de
 leitura/escrita comporte essa lógica futura.

 # Escopo detalhado

 ## 1. Cutover de leitura

 - `src/lib/webhook-processor.ts` — substituir `GET /estoque/{produtoId}` por queries
 `siso_estoque` (agregadas por galpão); salva em `siso_pedido_item_estoques` como hoje
 (compatibilidade) OU lê direto do WMS via view (decisão de design)
 - `src/app/api/separacao/checklist-items/route.ts` — localização do produto vem do WMS
 (`siso_localizacoes` + `siso_estoque`), não do Tiny (ver ADR de localizações)
 - Painel `/siso` (e seu sucessor pós-Plano 1) — `GET /api/pedidos` lê estoque do WMS
 - Outras leituras: módulos de inventário/transferência WMS já fazem isso; legados precisam ser
 direcionados

 ## 2. Cutover de escrita

 - `src/lib/execution-worker.ts` — `lancarEstoqueNota` e `movimentarEstoque` no Tiny são
 **substituídos** por:
   - Reserva criada no `pendente` (via `wms_reservar_atomico`) — Plano 3 detalha
   - Conversão reserva→saída no `separado` (RPC nova) — Plano 3 detalha
   - Worker continua emitindo NF no Tiny, mas **não chama mais `lancarEstoqueNota`**
 - `src/lib/compras-release.ts` — release implícito que esperava Tiny deduzir vira **liberação da
 reserva já criada no recebimento** (Plano 3 detalha)
 - **Aposentadoria dos legados**:
   - `src/lib/inventario-processor.ts` — substituído pelo módulo WMS de inventário (já em
 produção, Plano WMS-4 entregue)
   - `src/lib/transferencia-processor.ts` — substituído pelo módulo WMS de transferência (já em
 produção, Plano WMS-2 entregue)
   - Endpoints `/api/inventario/*` e `/api/transferencia/*` legados redirecionam pros equivalentes
  WMS

 ## 3. Replicação reversa pro Tiny (crítico)

 Tiny precisa continuar com saldo atualizado pra **NF sair com saldo Tiny coerente** (regra
 SEFAZ). Sem replicação reversa, NFs podem falhar ou sair com saldo negativo no Tiny.

 Opções a explorar (resolver como ADR neste plano):

 - **A. Replicação síncrona**: cada `wms_inserir_movimentacao` dispara `movimentarEstoque` no Tiny
  dentro da transação. Lento, mas garantido.
 - **B. Replicação async via fila**: WMS escreve, job em fila atualiza Tiny. Rápido, mas tem
 janela de inconsistência.
 - **C. Replicação batch periódica**: WMS escreve, cron periódico reconcilia Tiny. Mais simples,
 mas Tiny fica "atrasado".
 - **D. Não replicar, deixar Tiny divergir**: aceita que Tiny vai ficar com saldo errado e a NF
 não confere. Inviável fiscalmente, mas listar como opção pra discutir.

 Recomendação a validar com usuário: **B (async via fila)** com fallback de reconciliação
 periódica.

 ## 4. Snapshot inicial + reconciliação contínua

 - Rodar `/api/wms/snapshot-inicial` em staging pra popular `siso_estoque` com Tiny atual
 (idempotente; tem `?dryRun=true`)
 - **Reconciliação contínua durante transição**: `wms_detectar_divergencias_estoque` rodando em
 cron (a cada 5 min em staging), gera relatório no dashboard. Endpoint
 `/api/wms/reconciliacao?fix=true` resolve divergências.
 - **Métricas de divergência** visíveis em dashboard: contagem de divergências por hora, top SKUs
 divergentes, alertas se passar threshold

 ## 5. Feature flags e ondas

 Implementação em ondas com feature flags individuais por touchpoint:

 - `flag.wms_reads_estoque` (leitura): ativa cutover de leitura no webhook + painel
 - `flag.wms_writes_inventario` (escrita inventário): ativa WMS como destino do inventário
 - `flag.wms_writes_transferencia` (escrita transferência): ativa WMS como destino da
 transferência inter-galpão
 - `flag.wms_writes_pedido` (escrita pedido): ativa Plano 3 (reservas) sobre o que este plano
 deixa pronto
 - `flag.tiny_replicacao_async` (replicação): ativa replicação reversa async pra Tiny

 Cada flag tem rollback documentado: como reverter, quanto tempo demora, o que perde.

 # Restrições

 - **Não posso quebrar staging** em momento nenhum durante o cutover
 - Cada onda deve ser **reversível via flag**
 - Testes E2E em staging obrigatórios antes de avançar pra próxima onda
 - **NF deve continuar saindo correta** no Tiny — replicação reversa não é opcional
 - Padrão de plano: seguir formato dos Planos WMS 1-6 em `docs/superpowers/plans/`

 # Leitura inicial obrigatória

 Antes de propor qualquer coisa:

 - `docs/superpowers/plans/2026-06-05-wms-6-go-live.md` — **leia primeiro!** Decida se este plano
 estende, substitui ou referencia
 - `CLAUDE.md` — overview + status WMS
 - `docs/fluxos/01-webhook-pedido.md` §9.6-9.8 — enriquecimento de estoque atual
 - `docs/fluxos/04-execucao-worker.md` §7-9 — decisões própria/transferência/oc no worker
 - `docs/database-schema.md` — schema completo das tabelas
 - `supabase/migrations/` — migrations WMS (especialmente `wms_inserir_movimentacao`,
 `wms_reservar_atomico`, `wms_detectar_divergencias_estoque`)
 - `src/lib/webhook-processor.ts`, `src/lib/execution-worker.ts`, `src/lib/compras-release.ts` —
 touchpoints com Tiny

 # Como começar

 Diga ao usuário literalmente:

 "Antes de propor qualquer coisa, vou ler os arquivos listados — especialmente o WMS-6
 (`2026-06-05-wms-6-go-live.md`) pra decidir se este plano estende, substitui ou referencia ele.
 Depois te apresento um resumo do que entendi e te pergunto sobre os pontos abertos: replicação
 reversa Tiny (4 opções), ordem das ondas, e como integrar com WMS-6 existente."

 ---
 Prompt 3 — Sistema de reservas por pedido (ciclo de vida completo)

 # Objetivo

 Implementar o **sistema de reservas de estoque ligado ao ciclo de vida do pedido**: reserva
 criada no `pendente`, persiste até `separado`, onde vira saída lançada. Cobre Decisão 1 (reservas
  em pedidos normais) e Decisão 2 (reservas atômicas em recebimento de OC), além de todos os edge
 cases do ciclo de vida.

 Esse é o **Plano 3 de 4** num projeto maior de unificação. **Depende do Plano 2** (cutover das
 tabelas de estoque) estar entregue — o WMS já é fonte da verdade quando este plano roda.

 # Decisões já tomadas (input fixo)

 ## Decisão 1 — Reserva durante ciclo de vida do pedido

 | Status do pedido | Estoque no WMS |
 |---|---|
 | `pendente` (aguardando aprovação manual ou auto) | **Reserva criada** no momento da criação do
 pedido |
 | `aguardando_compra` (itens OC) | Sem reserva pros itens OC enquanto não há estoque físico |
 | `aguardando_nf` | Reserva persiste |
 | `aguardando_separacao` / `validacao_oc` | Reserva persiste |
 | `em_separacao` | Reserva persiste (operador ainda não tirou da prateleira) |
 | `separado` ← **trigger da conversão** | Reserva → **Saída lançada** (subtrai do saldo) |
 | `embalado` | Sem alteração de estoque |
 | `expedido` | Sem alteração de estoque |

 Racional: momento físico real é quando operador termina wave picking. Antes disso, só intenção
 (reservado). Outros consumidores veem "disponível = saldo - reservado".

 ## Decisão 2 — Itens OC: reserva nasce no recebimento físico

 No recebimento de OC, executa duas movimentações na mesma transação:
 1. Entrada (tipo='E') — saldo sobe
 2. Reserva (tipo='R') — reservado sobe, vinculada ao pedido original

 Resultado visual: saldo=N, reservado=N, **disponível=0**. Pedidos novos veem disponível=0 e vão
 pra OC. Recebimentos parciais reservam pro pedido original na medida em que chegam.

 **Override admin** (1% comercial): botão "liberar reserva e realocar" no detalhe do pedido —
 manual, com log.

 ## Decisão 3 — Empresa dona é metadado contábil em saídas

 Operador nunca vê empresa em saídas (separação, transferência inter-galpão, replenishment, ajuste
 de saída). **Exceção: tela de recebimento mantém o campo empresa dona** — pra OC vem
 pré-preenchido do pedido de compra; pra entrada avulsa (compra fora de OC, doação, devolução de
 cliente) operador escolhe manualmente quem comprou. Reserva de saída exige empresa pelo schema da
 quádrupla — sistema auto-escolhe (empresa com maior saldo do SKU no galpão escolhido).
 **Algoritmo completo de swap é Plano 4** — neste plano, basta auto-pick simples.

 # Escopo detalhado

 ## 1. Reserva criada no `pendente`

 - Hook no `webhook-processor.ts` (ou onde o pedido é criado): após enriquecer estoque e calcular
 sugestão, **cria reserva** via `wms_reservar_atomico` (já existe, tipo='R', expira_em alto — ex:
 30 dias)
 - Reserva vincula `origem_tipo='reserva_pedido'`, `origem_id=pedido_id`
 - Quádrupla escolhida automaticamente: galpão é o sugerido (`empresa_origem_id.galpao_id` ou
 outro, conforme sugestão); empresa é a com maior saldo do SKU naquele galpão
 - Pedidos auto-aprovados (`propria`) e manuais (todos) criam reserva no mesmo momento

 ## 2. Reserva persiste através das transições

 - Cancelamento, encaminhamento e validações OC não afetam a reserva por padrão (mas têm
 tratamentos específicos abaixo)
 - TTL alto (30 dias) garante que reserva não expira durante ciclo normal
 - Cron `wms_inventario_cleanup` cobre TTL stale — ajustar pra cobrir reservas de pedido também
 (ou criar cron específico)

 ## 3. Conversão reserva → saída no `separado`

 - Trigger: endpoint `POST /api/separacao/concluir` ao detectar que pedido vira `separado`
 - Nova RPC `wms_converter_reserva_em_saida(pedido_id)`:
   - Lê todas as reservas vinculadas ao pedido (`origem_tipo='reserva_pedido'`,
 `origem_id=pedido_id`)
   - Pra cada uma, na mesma transação: estorno da reserva (tipo='L') + saída (tipo='S')
   - Saída registra `dona` real (quem tinha o estoque na quádrupla)
   - Se localização bipada divergir da reserva: realocação silenciosa antes da conversão (regra do
  "tira do bolso mais cheio" pode mover reserva pra outra quádrupla)
 - Idempotente: se já convertida, retorna sem erro

 ## 4. Itens OC: entrada+reserva atômica no recebimento

 - Endpoint `POST /api/compras/receber` modificado:
   - Pra cada item recebido fisicamente, executa nova RPC `wms_receber_oc_atomico(item_id, qty,
 localizacao_id)`:
     - Entrada (tipo='E') no estoque (qty)
     - Reserva (tipo='R') na mesma qty, vinculada ao `pedido_id` original
     - Mesma transação, mesma `origem_id` (`origem_tipo='compra_recebida'`)
   - Recebimentos parciais funcionam — cada chamada reserva o que chegou
 - Endpoint `POST /api/compras/itens/[id]/realocar` (novo) — admin pode liberar reserva e realocar
  (override comercial)

 ## 5. Cancelamento do pedido

 ### Pré-`separado`

 - Trigger: webhook Tiny de cancelamento OU ação admin
 - Lê reservas vinculadas → estorna cada uma (tipo='L', `origem_tipo='cancelamento'`)
 - Pra itens OC já recebidos: reserva é liberada, estoque vira `disponível` (entra na fila pra
 outros pedidos)

 ### Pós-`separado`

 - Reservas já foram convertidas em saídas → não tem o que liberar
 - Mas se cancelamento acontece **com pedido já embalado/expedido**: precisa estorno completo
 (entrada compensatória tipo='E' com `origem_tipo='cancelamento_pos_separado'`)
 - Marca `compra_estoque_lancado_alerta=true` (alerta UI, já existe no schema)

 ## 6. Encaminhamento cross-galpão

 - Endpoint `POST /api/separacao/encaminhar` modificado:
   - Lê reservas atuais → estorna (libera no galpão antigo)
   - Cria novas reservas no galpão destino seguindo mesma regra de auto-pick de empresa
   - Tudo na mesma transação

 ## 7. Compras release (integração com Plano 2)

 - Quando todos itens OC de um pedido estão `recebido` (com reservas já atômicas criadas),
 `compras-release.ts`:
   - Transita pedido pra `aguardando_separacao` (ou `aguardando_nf`)
   - **Não precisa criar reserva** — ela já existe desde o recebimento (Decisão 2)
   - Fluxo simplifica: release é só transição de status

 # Restrições

 - **Idempotência** em todas as RPCs novas (re-execução não duplica movimentações)
 - **Atomicidade** estrita: entrada+reserva, estorno+saída, etc. sempre na mesma transação
 - **Backward compat**: enquanto feature flag desligada, comportamento antigo continua funcionando
 - Padrão de plano: seguir Planos WMS 1-6 em `docs/superpowers/plans/`
 - Testes E2E obrigatórios pra cada caminho:
   - Pedido `propria` auto-aprovado, fluxo completo
   - Pedido `transferencia` manual
   - Pedido `oc` com recebimento parcial + completo + release + separação
   - Cancelamento pré-`separado`
   - Cancelamento pós-`separado` (com estorno)
   - Encaminhamento entre galpões

 # Leitura inicial obrigatória

 - `docs/superpowers/plans/2026-06-05-wms-6-go-live.md` — entender o que o Plano 2 (cutover)
 deixou pronto
 - Plano 2 (este projeto) — quando estiver pronto, ler primeiro
 - `docs/fluxos/03-aprovacao-decisao.md` — fluxo de aprovação atual
 - `docs/fluxos/04-execucao-worker.md` — worker e suas decisões
 - `docs/fluxos/05-separacao-wave-picking.md` — transições de status_separacao
 - `docs/fluxos/07-compras-v2.md` §22 — release atual
 - `supabase/migrations/` — RPCs `wms_reservar_atomico`, `wms_inserir_movimentacao`

 # Como começar

 Diga ao usuário literalmente:

 "Antes de propor qualquer coisa, vou ler o que o Plano 2 (cutover) deixou pronto e os fluxos de
 aprovação, separação e compras. Depois te apresento um resumo de como o novo ciclo de reservas se
  encaixa em cada transição de status, e te pergunto sobre edge cases que não estão cobertos pelas
  3 decisões fixas — antes de propor o plano técnico."

 ---
 Prompt 4 — Algoritmo de fulfillment com swap

 # Objetivo

 Implementar o **algoritmo de fulfillment com swap automático de dona** que otimiza pra evitar
 transferências físicas e reduzir acúmulo de empréstimos entre empresas. Cobre Decisão 3 (empresa
 é metadado contábil) na sua versão final e completa.

 Esse é o **Plano 4 de 4**, último plano da unificação. **Depende dos Planos 2 (cutover de
 tabelas) e 3 (reservas)** estarem entregues — o sistema de reservas já está no ar, este plano
 otimiza como elas são criadas.

 # Decisões já tomadas (input fixo)

 ## Decisão 3 — Empresa é metadado contábil; swap automático otimiza fulfillment

 ### Conceitos

 - **Galpão preferencial de cada empresa** = de onde ela prefere enviar pedidos. Vive em
 `siso_empresas.galpao_id`. Mapeamento:
   - NetAir → CWB
   - NetParts → SP
   - 141AIR → SP
 - **Dona é sticky em transferências físicas**: mover SKU de A pra B mantém a dona. Só
 galpão+localização mudam.
 - **Saída registra dona real**: pedido da empresa X consumindo estoque de Y → ledger registra
 "saída de Y" + "empréstimo Y→X". `wms_saldos_devedores()` acumula naturalmente.

 ### Swap de dona (não-físico, contábil)

 Quando empresa X precisa enviar de seu preferencial A mas tem estoque em B, e existe empresa Z
 com estoque em A:
 - X cede estoque em B pra Z, Z cede estoque em A pra X
 - Nada se move fisicamente — só dona muda em ambas as pontas
 - Quantidade swappada: `min(X_em_B, Z_em_A)`
 - Após swap, X tem estoque em A e pode enviar como "própria"

 **Regras decididas:**
 - **Swap parcial é permitido**: se cobre só parte, restante cai em empréstimo
 - **Swap regular sem bônus é permitido**: mesmo que Z fique com estoque fora do preferencial dela
 - **Swap é triggered por demanda**, não proativo (sem rebalanceamento background)

 ### Algoritmo de fulfillment

 Quando pedido pra empresa X precisa SKU Y em qty Q:

 1. **X tem Y em seu preferencial A com qty ≥ Q?** → reserva em X em A. Done.
 2. **Senão, tenta swap pra trazer estoque pra X em A:**
    - Busca empresas Z com estoque de Y em A
    - Pra cada Z, verifica se X tem Y em outro galpão B
    - Executa swap até `min(X_em_B, Z_em_A)`, preferindo Z cujo preferencial seja B (swap
 "perfeito" antes de "regular")
 3. **Pra qty restante após swap, empréstimo**: reserva no estoque de Z em A. Saída registra
 empréstimo.
 4. **Pra qty restante após empréstimo (nenhuma empresa tem em A)**: marca item como `oc`.
 5. **Se nem em outro galpão tem ninguém**: 100% OC.

 ### Reclassificação de sugestão

 Swap pode reclassificar sugestões:
 - Pós-swap, X tem ≥ Q em A → **própria**
 - Pós-swap insuficiente, mas outro galpão tem fisicamente → **transferência**
 - Nada disponível → **oc**

 Operador continua vendo só pílulas por galpão. Swap rola invisível.

 # Escopo detalhado

 ## 1. RPC `wms_executar_swap`

 Nova RPC atômica que executa o swap como 4 movimentações no ledger numa única transação:

 ```sql
 wms_executar_swap(
   p_produto_id uuid,
   p_qty numeric,
   p_empresa_x uuid,
   p_galpao_x uuid,
   p_empresa_z uuid,
   p_galpao_z uuid
 ) returns swap_id uuid

 Internamente:
 - Saída (tipo='S') de Z em galpão_z (qty)
 - Entrada (tipo='E') de X em galpão_z (qty)
 - Saída (tipo='S') de X em galpão_x (qty)
 - Entrada (tipo='E') de Z em galpão_x (qty)
 - Tudo com mesma origem_id, origem_tipo='swap'
 - Locks pessimistas em ambas as quádruplas envolvidas
 - Validações: ambas quádruplas têm saldo suficiente; X e Z são empresas diferentes; galpões
 diferentes

 2. RPC wms_resolver_fulfillment

 Nova RPC que calcula o plano de fulfillment sem aplicar:

 wms_resolver_fulfillment(p_pedido_id text) returns jsonb

 Retorna estrutura tipo:
 {
   "items": [
     {
       "produto_id": "...",
       "qty_pedida": 5,
       "plano": [
         { "tipo": "direto", "empresa": "X", "galpao": "A", "qty": 3 },
         { "tipo": "swap", "swap_with": "Z", "galpao_swap": "B", "qty": 2 },
         { "tipo": "emprestimo", "credora": "W", "galpao": "A", "qty": 0 },
         { "tipo": "oc", "qty": 0 }
       ]
     }
   ],
   "classificacao_sugerida": "propria",
   "feasible": true
 }

 Usado pelo webhook (na hora de criar reserva) e pela UI de aprovação (mostrar sugestão refinada).

 3. RPC wms_aplicar_fulfillment

 Aplica o plano calculado:
 - Pra cada swap: chama wms_executar_swap
 - Pra cada direto: chama wms_reservar_atomico
 - Pra cada empréstimo: cria reserva apontando pra Z, marca is_emprestimo=true
 - Pra cada oc: marca item como compra_status='aguardando_compra'
 - Tudo atômico

 4. Modificações no webhook-processor.ts

 - Após enriquecer estoque, chamar wms_resolver_fulfillment em vez de fazer cálculo de sugestão
 hoje
 - Usar classificacao_sugerida retornada (que já considera swap)
 - Pra pedidos auto-aprovados: chamar wms_aplicar_fulfillment direto
 - Pra pedidos manuais: gravar plano em siso_pedidos (coluna nova fulfillment_plano jsonb),
 aplicar ao aprovar

 5. Modificações no execution-worker.ts

 - executarSaidaPropria e executarSaidaTransferencia simplificam radicalmente:
   - Reserva já foi criada (Plano 3) com swap já aplicado se aplicável (Plano 4)
   - Worker só emite NF no Tiny e aguarda webhook
 - executarEstoquePosNfPropria e executarEstoquePosNfTransferencia morrem ou viram no-op:
   - A dedução já é feita pelo wms_converter_reserva_em_saida no separado (Plano 3)
   - Tiny dedução desaparece — lancarEstoqueNota não é mais chamado
 - Erro "nenhuma empresa cobre 100%" sai do worker e vira validação hard na aprovação

 6. UI da aprovação (integra com Plano 1 de design)

 - Pílulas de estoque continuam por galpão (já é o padrão)
 - Sugestão exibida considera swap (pode ser "própria" mesmo quando estoque "direto" não cobre)
 - Tooltip opcional: "Vai swappar 3 unidades com NetParts" (debug/transparência)
 - Operador continua só vendo galpão, nunca empresa

 7. Concorrência

 Edge case crítico: 2 pedidos simultâneos competindo pelo mesmo estoque limitado.

 - Locks pessimistas em wms_executar_swap e wms_reservar_atomico resolvem na prática
 - Mas o wms_resolver_fulfillment é puramente de leitura — pode calcular um plano que fica
 obsoleto no momento do wms_aplicar_fulfillment
 - Mitigação: wms_aplicar_fulfillment re-valida feasibility dentro do lock e retorna erro se
 mudou; webhook re-tenta

     - Mitigação: wms_aplicar_fulfillment re-valida feasibility dentro do lock e retorna erro se
     mudou; webhook re-tenta

     Restrições

     - Swap é não-físico — zero movimentação real, só ledger
     - Operador nunca vê empresa em nenhuma tela
     - Idempotência em todas as RPCs
     - Atomicidade estrita: swap é tudo-ou-nada (4 movs ou rollback)
     - Testes E2E obrigatórios:
       - Swap perfeito (ambos ganham preferencial)
       - Swap regular (uma empresa sai do preferencial)
       - Swap parcial + empréstimo (qty restante)
       - Fallback empréstimo puro (sem swap possível)
       - Fallback OC (sem nenhuma empresa em A)
       - Concorrência: 2 pedidos simultâneos competindo

     Leitura inicial obrigatória

     - Planos 2 e 3 (deste projeto) — entender o que deixaram pronto
     - docs/fluxos/01-webhook-pedido.md §10 — lógica de decisão (4 cenários)
     - docs/fluxos/04-execucao-worker.md §7-9 — lógica atual de transferência (que vai sumir)
     - src/lib/grupo-resolver.ts — função getOrdemDeducao (será refatorada)
     - supabase/migrations/ — RPCs WMS existentes (wms_inserir_movimentacao, wms_reservar_atomico,
     wms_saldos_devedores)
     - docs/superpowers/plans/2026-05-22-wms-3-roteamento.md — Plano WMS-3 que já implementou
     roteamento + shadow logging

     Como começar

     Diga ao usuário literalmente:

     "Antes de propor qualquer coisa, vou ler o que os Planos 2 e 3 deixaram pronto e a lógica
     atual de fulfillment no webhook-processor + execution-worker. Depois te apresento um resumo do
      gap entre o estado atual e o algoritmo final com swap, e te pergunto sobre detalhes de
     concorrência e idempotência das novas RPCs."

     ---

     ## Notas operacionais finais

     1. **Cada prompt é self-contained**: o chat novo não vê esta conversa nem os outros prompts.
     Cada um repete as decisões fixadas e o contexto necessário. Não tente "economizar" texto
     referenciando outros chats.

     2. **WMS-6 já existe** (`docs/superpowers/plans/2026-06-05-wms-6-go-live.md`). O Prompt 2
     (Cutover) explicitamente pede pro novo chat ler WMS-6 primeiro e decidir se estende, substitui
      ou referencia. Não force uma decisão aqui — deixe o chat conversar com o usuário.

     3. **Ordem de execução é importante**:
        - Plano 1 (design) pode rodar em paralelo a tudo, mas é desejável começar primeiro porque
     informa ADRs
        - Plano 2 deve estar entregue antes do Plano 3 começar
        - Plano 3 deve estar entregue antes do Plano 4 começar

     4. **Cada chat termina com Fase 1 aprovada → Fase 2 (ondas) executada**. O modelo de Fase 1
     (design/spec) + Fase 2 (implementação) está em todos os 4 prompts. Validar arquitetura antes
     de implementar.

     5. **Validar com o usuário**: depois de abrir os 4 chats, ele pode querer iterar nos prompts.
     Esses são *starting points*, não imutáveis.