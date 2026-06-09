# Refactor Compras + Recebimento — Design

**Data:** 2026-06-09
**Ambiente:** staging (`develop` → `ehbxpbeijofxtsbezwxd`)
**Escopo:** 1 design coeso, 3 fases ordenadas A → B → C.

## Problema

O módulo de compras + recebimento divergiu em telas inconsistentes:

1. **Recebimento de OC e transferência são tabelas secas** — sem badge de anúncio ML, sem imprimir etiqueta, sem sugestão de put-away, sem lightbox. O recebimento avulso (`/wms/receber/avulso`) já tem tudo isso e é muito melhor.
2. **Compra manual fica numa aba isolada** ("Manuais"), separada das OC, mesmo sendo conceitualmente a mesma coisa: uma ordem de compra. Telas diferentes pro mesmo conceito.
3. **Fornecedor por prefixo trava o comprador** — `siso_pedido_itens.fornecedor_oc` é setado uma vez no intake do webhook (via `PREFIX_MAP` hardcoded em `sku-fornecedor.ts`) e é imutável. Quando o prefixo casa com o fornecedor errado, o comprador não tem como corrigir.
4. **Redundância no estágio "Receber"** — dá pra receber OC digitando qty inline na aba "Receber" do `/wms/compras` OU abrindo a page cheia `/wms/receber/oc/[id]`. Dois caminhos pro mesmo ato.

## Decisões (do brainstorming)

| # | Decisão | Escolha |
|---|---|---|
| A | Mecanismo do fornecedor | **Só override por item.** Prefixo continua hardcoded como sugestão inicial. |
| B | Unificar manual + OC | **Mata a aba Manuais.** Manual flui pelas mesmas abas por estágio; como nasce "comprada", cai em "Receber". Flag `origem`. |
| C | Arquitetura do recebimento | **Componente rico compartilhado.** OC/transferência mantêm suas rotas, renderizam o componente pré-preenchido com campos travados por fluxo. Backends intactos. |
| — | Estágio "Receber" | **Uma superfície só.** A lista vira navegação; clicar abre a page rica. Sem qty inline. |

**Sem migration.** Colunas e tabelas necessárias já existem (`fornecedor_oc`, `siso_compras_manuais`). Toda unificação é em camada de query/UI.

---

## FASE A — Fornecedor destravado (override por item)

### Estado atual

- `siso_pedido_itens.fornecedor_oc` (text, nome denormalizado do fornecedor) é setado **uma vez** no intake do webhook via `getFornecedorBySku(item.sku)` (`webhook-processor-wms.ts:588`).
- `PREFIX_MAP` (`sku-fornecedor.ts:16-75`) é um objeto JS hardcoded; match longest-prefix-first.
- **Nenhum endpoint** muda `fornecedor_oc` depois. O param `fornecedor_oc` aceito em `compras/comprar` só audita o momento da compra, não sobrescreve a coluna.
- A lista de compras agrupa por `fornecedor_oc`; item com fornecedor errado fica preso no grupo errado.

### Mudança

- **Nova rota** `PATCH /api/wms/compras/item-fornecedor`
  - Body: `{ item_ids: string[], fornecedor_oc: string }`
  - Valida que `fornecedor_oc` corresponde a um fornecedor existente em `siso_fornecedores` (por nome).
  - Atualiza `siso_pedido_itens.fornecedor_oc` dos `item_ids`.
  - Guard: `requireWarehouseAccess` + `userCan('operacoes.comprar')`.
  - Registra evento de histórico (`registrarEvento`) pro audit trail de quem trocou.
- **UI** (`/wms/compras`, aba Comprar): o kebab de cada item ganha **"Trocar fornecedor"** → abre picker que lista `siso_fornecedores` (reusa `listarFornecedores` de `fornecedores.ts`) → confirma → PATCH → invalida query → item migra pro grupo do fornecedor escolhido (vira novo grupo se ainda não existe).
- **Prefixo não muda** — `sku-fornecedor.ts` e o webhook ficam como estão. O prefixo passa a ser só a sugestão inicial; o override manda.

### Cenário coberto

SKU `MAN123` casa com prefixo `MAN` → auto-atribui *Multiqualita*. Mas é da *Delphi*. Comprador abre o kebab → "Trocar fornecedor" → Delphi → `fornecedor_oc='Delphi'` → item regrupa sob Delphi.

### Testes

- PATCH grava `fornecedor_oc` e regrupa.
- Override persiste após reload.
- Auth gate (sem permissão → 403).
- Fornecedor inexistente → 4xx.

### Arquivos

- **novo** `src/app/api/wms/compras/item-fornecedor/route.ts`
- `src/app/wms/compras/page.tsx` (kebab + picker)
- (reusa `src/lib/wms/fornecedores.ts::listarFornecedores`)

---

## FASE B — Lista de compra unificada (manual + OC)

### Estado atual

- **OC:** `siso_pedido_itens` com `compra_status IN (aguardando_compra, comprado, recebido)`. Abas Comprar / Receber / Histórico. Agregado por SKU+fornecedor. Sem custo (vem da NF, downstream).
- **Manual:** `siso_compras_manuais` (+`_itens`), órfãs (sem link a pedido). Status `comprado → parcial ↔ recebido`, ou `cancelado`. Cards individuais por compra. Tem `custo_unitario` por item. Aba "Manuais" isolada (`aba-manuais.tsx`).
- Manual **nasce "comprada"** (o comprador já comprou do fornecedor) → conceitualmente já está no estágio de receber.

### Mudança

- **Remove a aba "Manuais"** e o componente `aba-manuais.tsx`. A listagem manual passa a viver nas mesmas abas.
- **A aba "Receber" reestrutura de SKU-agregado → por documento.** Hoje agrupa fornecedor→SKU com qty inline; passa a listar **documentos** (cada OC + cada compra manual) como cards agrupados por fornecedor, com badge `origem`. Cada card **linka** pra page rica (Fase C). **Sem qty inline.**
- **Superfície única de listagem de compra:** a aba Receber do `/wms/compras` é a lista única de recebimento de OC + manual. A lista `/wms/receber/oc` (página + endpoint `/api/wms/receber/oc/lista`) vira redundante → **removida** (ou redireciona pra `/wms/compras?tab=receber`). **Transferência continua** em `/wms/receber/transferencia` (não é compra — fluxo inter-galpão à parte).
- `/api/wms/compras?tab=...` muda **Receber** e **Histórico** pra unir `siso_compras_manuais`. Cada entrada carrega `origem: 'oc' | 'manual'` + o id do documento (`ordem_compra_id` ou `compra_manual_id`) pro link.
  - **Comprar:** só OC (`aguardando_compra`). Manual nunca aparece aqui (já foi comprada).
  - **Receber:** OCs (status comprado / pendente de recebimento — reusa a lógica de `/api/wms/receber/oc/lista`) + manuais `comprado`/`parcial`. Cards **por documento**, agrupados por fornecedor. Badge `origem`.
  - **Histórico:** OC `recebido` + manual `recebido`/`cancelado`.
- **Reconciliação das diferenças:**
  - Agrupamento: manual agrupa por fornecedor também (FK `siso_fornecedores` → nome), pra caber no mesmo card de fornecedor das OC.
  - Custo: coluna mostrada quando existe (manual), dash quando não (OC).
  - Identidade: entrada OC = agregação de `pedido_itens`; entrada manual = id de `siso_compras_manuais`.
  - Aging: OC ancora em `compra_solicitada_em`/`criado_em`; manual em `criado_em`. Âncoras diferentes, ambas "desde criada/comprada" — aceitável.
- `siso_compras_manuais` **fica como está** (não migra pra `siso_pedidos` — escopo grande demais). A flag `origem` é computada na resposta da API.
- Clicar uma entrada em **Receber** (OC ou manual) → abre a **page rica unificada** (Fase C). **Sem qty inline na lista.**
- O modal "nova compra manual" (`nova-compra-manual-modal.tsx`) **continua** — manual ainda é criada, só deixa de ter aba própria.

### Testes

- Receber retorna OC + manual unificados, agrupados por fornecedor, com `origem`.
- Histórico inclui ambos.
- Comprar exclui manual.
- Clicar entrada em Receber linka pra page de recebimento.
- Aba "Manuais" não existe mais.

### Arquivos

- `src/app/api/wms/compras/route.ts` (reescreve `fetchReceber` pra cards por documento OC+manual com flag `origem` + id do documento; `fetchHistorico` une manuais; `fetchCounts` inclui manuais)
- `src/app/wms/compras/page.tsx` (remove aba Manuais; Receber vira cards por documento com badge `origem` que linkam pra page rica; tira qty inline)
- **retira** `src/components/wms/compras/aba-manuais.tsx` (e usos)
- **retira/redireciona** `src/app/wms/receber/oc/page.tsx` (lista) + `src/app/api/wms/receber/oc/lista/route.ts` (redundantes com a aba Receber)
- (mantém `src/app/api/wms/compras-manuais/route.ts` + `/[id]/receber` pra criação/recebimento)

---

## FASE C — Recebimento unificado (componente rico compartilhado)

### Estado atual

- **Avulso** (`/wms/receber/avulso/page.tsx`): layout 2 colunas, adiciona N SKUs por busca (`ProdutoCombo`), custo+fornecedor editáveis, `MlAnunciosBlock` por item, sugestão de put-away, plano de guarda na sidebar, checkbox imprimir etiqueta, lightbox, `entrada_direta`. Backend `receberEstoque` (`movimentacoes.ts`).
- **OC** (`/wms/receber/oc/[id]/page.tsx`): tabela seca, itens fixos da ordem, sem anúncio/etiqueta/putaway/lightbox. Backend `receberItensViaOC` (`receber-oc.ts`) — split de excedente (`nf_compra` até solicitado + `ajuste_manual` 'achado'), detecção cross-dock, lock otimista em `compra_quantidade_recebida`.
- **Transferência** (`/wms/receber/transferencia/[id]/page.tsx`): tabela com combo de localização por item, sem custo/fornecedor (herda da perna S). Backend `receberTransferencia` (`transferencias.ts`) — atômico por item, lock anti-race (`recebimento_em_andamento_por`).

### Mudança

- **Extrai `<ReceberLote>`** (`src/components/wms/recebimento/receber-lote.tsx`) a partir do avulso. Configurável por fluxo:

| campo | avulso | OC | manual | transferência |
|---|---|---|---|---|
| adicionar SKU livre | sim (`ProdutoCombo`) | não (itens fixos) | não (itens fixos) | não (itens fixos) |
| custo | editável (obrigatório >0) | pré-preenchido, editável | pré-preenchido, editável | oculto |
| fornecedor | picker | travado (chip read-only) | travado (chip read-only) | nenhum |
| qty | editável | editável + motivo divergência | editável | só confirma (fixa) |
| divergência | não | sim | não | não |

> **Manual** é o caso que abre quando o comprador clica numa compra manual na lista "Receber" (Fase B). Itens, fornecedor e custo vêm pré-preenchidos de `siso_compras_manuais`; comporta-se como OC, mas sem o conceito de divergência/split de excedente.

- **Sempre on nos 3:** `MlAnunciosBlock` por item, sugestão de put-away + `LocalizacaoCombo`, plano de guarda na sidebar, checkbox imprimir etiqueta, lightbox da imagem.
- **Rotas ficam / nova rota manual** (`/receber/avulso`, `/receber/oc/[id]`, **novo** `/receber/manual/[id]`, `/receber/transferencia/[id]`). Cada page: busca header/itens → mapeia pro shape do componente → configura flags → passa `onSubmit` que chama o endpoint do fluxo:
  - avulso → `POST /api/wms/receber`
  - OC → `POST /api/wms/receber/oc/[id]`
  - manual → `POST /api/wms/compras-manuais/[id]/receber` (existente)
  - transferência → `POST /api/wms/transferencias/[id]/receber`
- **Backends intactos** — o componente só alimenta os endpoints existentes. `receberItensViaOC` mantém split/cross-dock/lock; `receberTransferencia` mantém atomicidade/anti-race.
- **Avulso também** é refatorado pra usar `<ReceberLote>` (senão não é compartilhado de verdade — vira a referência).
- Transferência ganha anúncio + etiqueta + putaway (úteis), mas **não** custo/fornecedor.

### Gotchas a respeitar

- Resolução de custo: `resolverCustoEntrada` lança se não houver custo informado nem histórico (guard P108) → o componente avisa antes do submit em produto sem custo.
- `entrada_direta=true` exige `localizacao_destino_id` em **todos** os itens (`movimentacoes.ts:113-117`).
- Impressão é fire-and-forget — falha de etiqueta não bloqueia o recebimento, só toast.
- Override de localização por item limpa ao trocar galpão (locs são scoped por galpão).
- OC: split de excedente (`qty > solicitado`) é automático no backend — UI não precisa replicar, mas mostra a qty real.
- Transferência: `LocalizacaoCombo` com `allowCreate=false` (evita loc órfã).

### Testes

- OC: componente renderiza pré-preenchido, fornecedor travado, custo pré-preenchido, anúncio aparece, imprimir etiqueta funciona.
- Manual: pré-preenchido de `siso_compras_manuais` (itens/fornecedor/custo), submit no endpoint manual, respeita lock otimista de `qty_recebida`.
- Transferência: sem custo/fornecedor, localização por item obrigatória, anúncio aparece.
- Avulso: continua funcionando (add livre, custo obrigatório).
- Cada `onSubmit` bate no endpoint certo; comportamento backend preservado (split de excedente em OC, atômico em transferência).
- TDD: testes por fluxo antes do refactor da UI.

### Arquivos

- **novo** `src/components/wms/recebimento/receber-lote.tsx` (extraído do avulso)
- `src/app/wms/receber/avulso/page.tsx` (refatora pra usar o componente)
- `src/app/wms/receber/oc/[id]/page.tsx` (reescreve pra usar o componente, pré-preenchido)
- **nova** `src/app/wms/receber/manual/[id]/page.tsx` (recebimento de compra manual via componente)
- `src/app/wms/receber/transferencia/[id]/page.tsx` (reescreve pra usar o componente)
- (reusa `POST /api/wms/compras-manuais/[id]/receber` — sem mudança de backend)

---

## Ordem de execução

**A → B → C.**

- **A primeiro** — destrava o `fornecedor_oc`, base pro agrupamento correto que a lista (B) usa.
- **B depois** — lista unificada; o estágio "Receber" da lista linka pra page de recebimento.
- **C por último** — extrai o componente rico que a lista (B) abre.

Cada fase é independente o suficiente pra ser implementada e testada isolada, mas a ordem maximiza coerência.

## Cross-cutting

- Atualizar `docs/api-reference-complete.md` (nova rota `PATCH /api/wms/compras/item-fornecedor`, mudança na resposta de `/api/wms/compras` com flag `origem`).
- Adicionar entradas em `erros-conhecidos.yaml` (fornecedor_oc imutável; redundância de recebimento).
- TDD nas 3 fases.
- Tudo aplicado em staging (`develop`).

## Não-objetivos (YAGNI)

- **Não** migrar `PREFIX_MAP` pro banco (override por item já resolve a trava).
- **Não** migrar `siso_compras_manuais` pra `siso_pedidos` (união em query basta).
- **Não** unificar as rotas de recebimento numa só `/wms/receber` (componente compartilhado já entrega UX idêntica com risco menor).
- **Não** adicionar rastreio de custo às OC (custo vem da NF, downstream — fora de escopo).
