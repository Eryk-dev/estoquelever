# PRD — Fluxo de Separacao e Embalagem

## 1. Introduction/Overview

O SISO atualmente gerencia o fluxo de decisao de pedidos (webhook → estoque → aprovacao). Este PRD cobre o **fluxo pos-aprovacao**: separacao fisica no galpao e embalagem com conferencia na bancada.

O fluxo segue o modelo do Tiny ERP (Olist) com uma diferenca: no SISO, o pedido chega **antes** da NF ser autorizada pelo SEFAZ, criando um status extra (`aguardando_nf`).

A nova pagina `/separacao` coexiste com o dashboard existente (`/`), que continua gerenciando o fluxo de aprovacao.

**Status flow:**
```
[aprovado] → aguardando_nf → aguardando_separacao → em_separacao → separado → embalado
```

## 2. Goals

- Substituir processo manual de separacao/embalagem por fluxo digital no tablet
- Suportar separacao em onda (wave picking) com lista consolidada de produtos
- Conferencia na bancada via bipagem de codigo de barras e/ou selecao manual
- Impressao automatica de etiqueta de envio ao completar embalagem de cada pedido
- Suportar multiplos operadores simultaneos sem conflitos
- Auto-save em cada interacao (sem perda de progresso por queda de internet)
- Atualizacao em tempo real via Supabase Realtime

## 3. User Stories

### US-001: Schema — Novos status de separacao
**Description:** As a developer, I want the database schema updated with the new separation statuses so that the entire flow can be tracked.

**Acceptance Criteria:**
- [ ] `siso_pedidos.status_separacao` CHECK constraint updated: `aguardando_nf`, `aguardando_separacao`, `em_separacao`, `separado`, `embalado`, `cancelado`
- [ ] Old `pendente` values migrated to `aguardando_separacao`
- [ ] `expedido` removed from active use (keep in CHECK for backwards compat if needed)
- [ ] New columns on `siso_pedido_itens`: `separacao_marcado` (boolean default false), `separacao_marcado_em` (timestamptz null)
- [ ] Existing `quantidade_bipada` and `bipado_completo` columns on `siso_pedido_itens` repurposed for embalagem stage
- [ ] New column on `siso_pedidos`: `separacao_operador_id` (uuid FK to `siso_usuarios`, nullable) — tracks who is separating
- [ ] New column on `siso_pedidos`: `separacao_iniciada_em` (timestamptz null)
- [ ] New column on `siso_pedidos`: `separacao_concluida_em` (timestamptz null)
- [ ] New column on `siso_pedidos`: `embalagem_concluida_em` (timestamptz null)
- [ ] Migration file created in `supabase/migrations/`
- [ ] Typecheck passes

---

### US-002: PL/pgSQL — Consolidar produtos para separacao em onda
**Description:** As a developer, I want a database function that consolidates products across multiple orders into a single wave-picking list so that the API can return it efficiently.

**Acceptance Criteria:**
- [ ] Function `siso_consolidar_produtos_separacao(pedido_ids uuid[])` created
- [ ] Returns: produto_id, descricao, sku, gtin, quantidade_total (sum across orders), unidade, localizacao
- [ ] Groups by produto_id, sums quantities
- [ ] Includes localizacao from `siso_pedido_item_estoques` (origin empresa)
- [ ] Supports ordering by: localizacao (default), sku, descricao
- [ ] Migration file created
- [ ] Tested with multiple orders sharing the same product

---

### US-003: PL/pgSQL — Processar bip na embalagem
**Description:** As a developer, I want a database function that processes a barcode scan during packing, finds the oldest order with that item pending, and returns the result.

**Acceptance Criteria:**
- [ ] Function `siso_processar_bip_embalagem(sku text, galpao_id uuid, quantidade int default 1)` created
- [ ] Finds the oldest `separado`-status order (by `data_pedido`) in the given galpao that has the scanned item with `bipado_completo = false`
- [ ] Increments `quantidade_bipada` on the matching `siso_pedido_itens` row
- [ ] Sets `bipado_completo = true` when `quantidade_bipada >= quantidade`
- [ ] Returns: pedido_id, pedido_completo (boolean — all items bipado_completo), item details
- [ ] When pedido_completo = true, updates `siso_pedidos.status_separacao` to `embalado` and sets `embalagem_concluida_em`
- [ ] Migration file created

---

### US-004: API — Listar pedidos por status de separacao
**Description:** As an operator, I want to fetch orders filtered by separation status so that each tab shows the right data.

**Acceptance Criteria:**
- [ ] `GET /api/separacao` returns pedidos filtered by `status_separacao` query param
- [ ] Supports filter by `empresa_origem_id` query param
- [ ] Supports `sort` query param: `data_pedido` (default), `localizacao`, `sku`
- [ ] Supports `busca` query param: search by client name or order number
- [ ] Returns count per status (for tab badges)
- [ ] Role-based filtering: operador_cwb sees only CWB galpao, operador_sp sees only SP
- [ ] Response includes: pedido id, numero_nf, numero_ec, numero_pedido, cliente, uf, cidade, forma_envio, data_pedido, empresa_origem (nome), status_separacao, separacao progress (%), marcadores
- [ ] Typecheck passes

---

### US-005: API — Iniciar separacao
**Description:** As an operator, I want to start separation for selected orders so that they move to "em_separacao" and I get a consolidated product checklist.

**Acceptance Criteria:**
- [ ] `POST /api/separacao/iniciar` accepts `{ pedido_ids: string[] }`
- [ ] Validates all pedidos are `aguardando_separacao`
- [ ] Updates status to `em_separacao`, sets `separacao_operador_id` and `separacao_iniciada_em`
- [ ] Calls `siso_consolidar_produtos_separacao` to build wave-picking list
- [ ] Returns consolidated product list (sorted by localizacao by default)
- [ ] Returns 400 if any pedido is not `aguardando_separacao`
- [ ] Typecheck passes

---

### US-006: API — Marcar item no checklist (auto-save)
**Description:** As an operator, I want each checkbox in the separation checklist to save immediately so that I never lose progress.

**Acceptance Criteria:**
- [ ] `POST /api/separacao/marcar-item` accepts `{ pedido_item_id: string, marcado: boolean }`
- [ ] Updates `separacao_marcado` and `separacao_marcado_em` on `siso_pedido_itens`
- [ ] Validates the parent pedido is `em_separacao`
- [ ] Returns updated item state
- [ ] Typecheck passes

---

### US-007: API — Bipar item no checklist de separacao
**Description:** As an operator, I want to scan a barcode during separation to auto-check the corresponding item in the checklist.

**Acceptance Criteria:**
- [ ] `POST /api/separacao/bipar-checklist` accepts `{ sku: string, pedido_ids: string[] }`
- [ ] Finds matching item(s) in the active separation by SKU or GTIN
- [ ] Sets `separacao_marcado = true` and `separacao_marcado_em = now()`
- [ ] Returns the matched item(s) with current checklist state
- [ ] Returns 404 if SKU not found in active separation items
- [ ] Typecheck passes

---

### US-008: API — Concluir separacao
**Description:** As an operator, I want to finish the separation so that fully-checked orders move to "separado" and incomplete ones stay in "em_separacao".

**Acceptance Criteria:**
- [ ] `POST /api/separacao/concluir` accepts `{ pedido_ids: string[] }`
- [ ] For each pedido: if ALL items have `separacao_marcado = true` → status = `separado`, set `separacao_concluida_em`
- [ ] Pedidos with ANY unchecked item remain `em_separacao`
- [ ] Returns summary: `{ separados: string[], pendentes: string[] }`
- [ ] Typecheck passes

---

### US-009: API — Cancelar separacao
**Description:** As an operator, I want to cancel an in-progress separation so that orders return to "aguardando_separacao".

**Acceptance Criteria:**
- [ ] `POST /api/separacao/cancelar` accepts `{ pedido_ids: string[] }`
- [ ] Resets `separacao_marcado = false` and `separacao_marcado_em = null` on all items
- [ ] Clears `separacao_operador_id` and `separacao_iniciada_em`
- [ ] Updates status back to `aguardando_separacao`
- [ ] Typecheck passes

---

### US-010: API — Bipar item na embalagem
**Description:** As an operator, I want to scan a barcode during packing so that the system finds the right order and tracks progress.

**Acceptance Criteria:**
- [ ] `POST /api/separacao/bipar-embalagem` accepts `{ sku: string, galpao_id: string, quantidade?: number }`
- [ ] Calls `siso_processar_bip_embalagem` PL/pgSQL function
- [ ] Returns: matched pedido details, item details, pedido_completo flag
- [ ] When `pedido_completo = true`: triggers etiqueta print (fire-and-forget) and creates Tiny expedition grouping
- [ ] Returns 404 if no pending order found for that SKU in the galpao
- [ ] Typecheck passes

---

### US-011: API — Selecao manual na embalagem (sem bip)
**Description:** As an operator, I want to manually confirm item quantities during packing without using a barcode scanner.

**Acceptance Criteria:**
- [ ] `POST /api/separacao/confirmar-item-embalagem` accepts `{ pedido_item_id: string, quantidade: number }`
- [ ] Increments `quantidade_bipada` on the item
- [ ] Sets `bipado_completo = true` when `quantidade_bipada >= quantidade`
- [ ] Checks if all items of the pedido are complete → if yes, status = `embalado`
- [ ] When pedido complete: triggers etiqueta print + Tiny expedition (same as US-010)
- [ ] Typecheck passes

---

### US-012: API — Reiniciar progresso
**Description:** As an operator, I want to reset progress in both separation checklist and packing so that I can start over.

**Acceptance Criteria:**
- [ ] `POST /api/separacao/reiniciar` accepts `{ pedido_ids: string[], etapa: "separacao" | "embalagem" }`
- [ ] For `separacao`: resets `separacao_marcado` and `separacao_marcado_em` on all items
- [ ] For `embalagem`: resets `quantidade_bipada = 0` and `bipado_completo = false` on all items
- [ ] Validates pedidos are in the correct status for the etapa
- [ ] Typecheck passes

---

### US-013: Integracao Tiny — Agrupamento de expedicao e etiqueta
**Description:** As a system, I want to create a Tiny expedition grouping and fetch the shipping label URL when a pedido is fully packed so that the label prints automatically.

**Acceptance Criteria:**
- [ ] `POST /expedicao/agrupamentos` called on Tiny API when pedido reaches `embalado`
- [ ] `GET /expedicao/agrupamentos/{id}/etiquetas` called to retrieve label URL
- [ ] Label URL sent to PrintNode for auto-printing (fire-and-forget)
- [ ] Errors logged but do not block status transition to `embalado`
- [ ] `siso_pedidos.etiqueta_url` column added to store the label URL
- [ ] `siso_pedidos.agrupamento_expedicao_id` column added to store Tiny grouping ID
- [ ] Rate limiting respected per empresa
- [ ] Typecheck passes

---

### US-014: Webhook — Transicao aguardando_nf → aguardando_separacao
**Description:** As a system, I want to automatically move orders from "aguardando_nf" to "aguardando_separacao" when the NF is authorized by SEFAZ via Tiny webhook.

**Acceptance Criteria:**
- [ ] Webhook handler recognizes NF authorization event from Tiny
- [ ] Updates `siso_pedidos.status_separacao` from `aguardando_nf` to `aguardando_separacao`
- [ ] Stores NF data: `danfe_url`, `chave_acesso_nf` on the pedido
- [ ] Idempotent — processing same webhook twice has no adverse effect
- [ ] Typecheck passes

---

### US-015: API — Admin forcar transicao aguardando_nf
**Description:** As an admin, I want to manually force an order from "aguardando_nf" to "aguardando_separacao" when the NF webhook is delayed or stuck.

**Acceptance Criteria:**
- [ ] `POST /api/separacao/forcar-pendente` accepts `{ pedido_ids: string[] }`
- [ ] Only accessible by `admin` role
- [ ] Updates status from `aguardando_nf` to `aguardando_separacao`
- [ ] Logs the manual override with admin user info
- [ ] Typecheck passes

---

### US-016: Frontend — Pagina /separacao com 5 abas
**Description:** As an operator, I want a separation page with 5 status tabs so that I can see orders at each stage of the process.

**Acceptance Criteria:**
- [ ] New route `/separacao` with page component
- [ ] 5 tabs: Aguardando NF, Aguardando Separacao, Em Separacao, Separados, Embalados
- [ ] Each tab shows count badge from API
- [ ] Tab content shows order list with: NF number, N EC, N Pedido, cliente, UF/cidade, forma envio, data pedido, empresa origem, marcadores
- [ ] "Aguardando Separacao" tab has: filter by empresa, sort options (localizacao/SKU/nome), search bar
- [ ] "Aguardando Separacao" tab has "Separar N pedidos" action button
- [ ] "Separados" tab has "Embalar N pedidos" action button (default all, or selected)
- [ ] "Aguardando NF" tab has "Forcar pendente" button (admin only)
- [ ] "Em Separacao" tab: clicking a group reopens the saved checklist
- [ ] "Embalados" tab: view-only (final status)
- [ ] Role-based: operador_cwb sees only CWB, operador_sp sees only SP
- [ ] Uses Supabase Realtime for live updates (US-020)
- [ ] Mobile-first layout (tablet-optimized)
- [ ] Typecheck and lint pass

---

### US-017: Frontend — Checklist de separacao em onda
**Description:** As an operator, I want a wave-picking checklist screen so that I can walk through the warehouse and check off items on my tablet.

**Acceptance Criteria:**
- [ ] Opens when operator clicks "Separar N pedidos" on Aguardando Separacao tab
- [ ] Shows consolidated product list (grouped by produto_id, quantities summed)
- [ ] Columns: checkbox, descricao, SKU/GTIN, quantidade total, localizacao
- [ ] Default sort by localizacao (warehouse walk order)
- [ ] Sort options: localizacao, SKU, nome do produto
- [ ] Checkbox click calls `POST /api/separacao/marcar-item` immediately (auto-save)
- [ ] Barcode scan field at the top — scanning calls `POST /api/separacao/bipar-checklist`
- [ ] Visual feedback: checked items show distinct style (strikethrough or dimmed)
- [ ] Progress indicator: "X/Y itens marcados"
- [ ] "Concluir" button: calls `POST /api/separacao/concluir`, shows summary of separados vs pendentes
- [ ] "Reiniciar progresso" button: calls `POST /api/separacao/reiniciar` with etapa=separacao
- [ ] "Cancelar" button: calls `POST /api/separacao/cancelar`, returns to /separacao
- [ ] Reopening from "Em Separacao" tab restores all previously checked items
- [ ] Tablet-optimized: large touch targets, readable font size
- [ ] Typecheck and lint pass

---

### US-018: Frontend — Embalagem por produto
**Description:** As an operator, I want a packing screen where I can scan barcodes or manually confirm items so that orders get packed and labels print automatically.

**Acceptance Criteria:**
- [ ] Opens when operator clicks "Embalar N pedidos" on Separados tab
- [ ] Scan/search field at top: accepts SKU, GTIN, or description
- [ ] Quantity field (default 1)
- [ ] "Ultimo item lido" section: shows image and details of last scanned item
- [ ] Order list showing all orders being packed with progress: "X/Y itens" + color indicator (yellow=pending, green=complete)
- [ ] Scanning a barcode calls `POST /api/separacao/bipar-embalagem`
- [ ] System highlights the matched order and expands it
- [ ] If order has only that one item → auto-completes → prints label → toast notification
- [ ] If order has more items → expands showing remaining items
- [ ] Manual mode: click order to expand → +/- buttons per item → calls `POST /api/separacao/confirmar-item-embalagem`
- [ ] Intercalation supported: operator can scan items from different orders freely
- [ ] When any order reaches 100% → status `embalado` + auto-print label + toast
- [ ] "Salvar para depois" button: saves progress, returns to /separacao
- [ ] "Reiniciar progresso" button: calls `POST /api/separacao/reiniciar` with etapa=embalagem
- [ ] Order list updates in real-time as items are scanned
- [ ] Tablet-optimized
- [ ] Typecheck and lint pass

---

### US-019: Frontend — Selecao seletiva para embalagem
**Description:** As an operator, I want to select specific orders for packing instead of packing all separated orders at once.

**Acceptance Criteria:**
- [ ] "Separados" tab shows checkboxes per order
- [ ] Default (no selection): button says "Embalar N pedidos" (all separated)
- [ ] When checkboxes selected: button changes to "Embalar X pedidos" (selected count)
- [ ] Only selected orders passed to embalagem screen
- [ ] Typecheck passes

---

### US-020: Realtime — Supabase Realtime subscriptions
**Description:** As an operator, I want the separation page to update in real-time so that I see status changes from other operators without refreshing.

**Acceptance Criteria:**
- [ ] Subscribe to `siso_pedidos` changes on `status_separacao` column
- [ ] Tab counts update automatically when orders change status
- [ ] Orders appear/disappear from tabs as status changes
- [ ] No polling — uses Supabase Realtime channels
- [ ] Handles reconnection gracefully (re-subscribe on disconnect)
- [ ] Typecheck passes

---

### US-021: Tipos — Atualizar types/index.ts
**Description:** As a developer, I want all new types defined so that the codebase has full type safety.

**Acceptance Criteria:**
- [ ] `StatusSeparacao` type: `'aguardando_nf' | 'aguardando_separacao' | 'em_separacao' | 'separado' | 'embalado' | 'cancelado'`
- [ ] `ProdutoConsolidado` type for wave-picking list items
- [ ] `BipEmbalagemResult` type for packing scan response
- [ ] `SeparacaoFilter` type for list query params
- [ ] Updated `PedidoItem` type with `separacao_marcado`, `separacao_marcado_em`
- [ ] Updated `Pedido` type with `separacao_operador_id`, `separacao_iniciada_em`, `separacao_concluida_em`, `embalagem_concluida_em`, `etiqueta_url`, `agrupamento_expedicao_id`
- [ ] Typecheck passes

## 4. Functional Requirements

- **FR-01:** The system must support 5 separation statuses: `aguardando_nf`, `aguardando_separacao`, `em_separacao`, `separado`, `embalado` (plus `cancelado`).
- **FR-02:** The system must consolidate products across multiple orders into a single wave-picking list, grouping by produto_id and summing quantities.
- **FR-03:** The system must auto-save every checkbox interaction in the separation checklist immediately to the database.
- **FR-04:** The system must support barcode scanning as an alternative to manual checkbox in both separation and packing stages.
- **FR-05:** The system must automatically transition a pedido to `embalado` when all items reach `bipado_completo = true` during packing.
- **FR-06:** The system must automatically create a Tiny expedition grouping and print the shipping label when a pedido reaches `embalado`.
- **FR-07:** The system must prevent conflicts between concurrent operators by moving pedidos to `em_separacao` atomically, removing them from the available pool.
- **FR-08:** The system must support order intercalation during packing — operators can scan items from different orders without completing one first.
- **FR-09:** The system must find the oldest pending order when a barcode is scanned during packing (ordered by `data_pedido`).
- **FR-10:** The system must update the UI in real-time via Supabase Realtime when any pedido changes separation status.
- **FR-11:** The system must filter orders by role: operador_cwb sees only CWB galpao orders, operador_sp sees only SP.
- **FR-12:** The system must allow admins to manually force orders from `aguardando_nf` to `aguardando_separacao`.
- **FR-13:** The separation checklist must display product localizacao (warehouse address) to guide the operator's physical path.
- **FR-14:** Cancelling a separation must return all selected orders to `aguardando_separacao` and reset checklist progress.
- **FR-15:** Only orders with 100% of items checked may transition from `em_separacao` to `separado`. Partial orders remain in `em_separacao`.

## 5. Non-Goals (Out of Scope)

- **No "embalar por pedido" mode** — only "embalar por produto" (barcode-driven)
- **No printed pick lists** — tablet only
- **No DANFE auto-print** — only shipping label (etiqueta de envio)
- **No `expedido` status** — `embalado` is the final status in this flow
- **No changes to the existing approval dashboard** (`/` page) — it coexists
- **No stock deduction changes** — stock is already deducted during approval flow
- **No multi-galpao transfer handling** — this flow assumes pedidos are already assigned to a galpao
- **No product images in checklist v1** — may add later if Tiny API provides image URLs efficiently

## 6. Technical Considerations

### Database
- Migration must handle renaming `pendente` → `aguardando_separacao` for existing data
- PL/pgSQL functions should use row-level locking (`FOR UPDATE`) to prevent race conditions during concurrent bip/checklist operations
- Consider index on `siso_pedidos(status_separacao, empresa_origem_id)` for tab filtering performance

### Tiny API
- Expedition endpoints (`POST /expedicao/agrupamentos`, `GET .../etiquetas`) need to be added to `tiny-api.ts`
- Consult `api tiny.json` for exact endpoint shapes
- Rate limiting per empresa must be respected
- Label printing is fire-and-forget — errors logged but don't block

### PrintNode
- Research PrintNode API for label printing integration
- Need to configure printer ID per galpao
- Fallback: store `etiqueta_url` and allow manual download/print

### Realtime
- Supabase Realtime requires the table to have Realtime enabled in the Supabase dashboard
- Enable Realtime on `siso_pedidos` table (at minimum for `status_separacao` changes)
- Consider RLS implications — Realtime respects RLS policies

### Frontend
- Barcode scanner input: use a focused text input that captures scanner output (scanners emulate keyboard)
- Auto-save debounce: 0ms (immediate) since each checkbox is a single DB update
- Large touch targets for tablet: minimum 44x44px tap areas

## 7. Success Metrics

- **Adoption:** 100% of separation/packing done through SISO within 2 weeks of launch (no parallel paper/manual process)
- **Speed:** Average time from `aguardando_separacao` to `embalado` decreases vs. current manual process
- **Accuracy:** Zero missed items (checklist enforces 100% before transitioning to `separado`)
- **Concurrency:** Multiple operators can separate/pack simultaneously without conflicts or duplicated work
- **Auto-print:** >95% of etiquetas print automatically without manual intervention

## 8. Open Questions

1. **PrintNode configuration:** How do we configure which printer to use per galpao? Is there already a PrintNode account set up?
2. **Product images:** Does the Tiny API return product image URLs in the order/stock endpoints? Worth adding to the checklist if available.
3. **Barcode format:** Are all products using standard EAN-13/GTIN barcodes, or are some using internal SKU barcodes?
4. **Label format:** What is the etiqueta format? ZPL, PDF, PNG? Depends on printer type and Tiny API response.
5. **NF webhook event:** What is the exact Tiny webhook event type/payload for "NF autorizada"? Need to verify in `api tiny.json`.
6. **Offline support:** Should the checklist work offline on the tablet and sync when back online? (Would significantly increase complexity.)
7. **Localizacao data completeness:** Are all products in Tiny populated with localizacao? What to show if missing?
