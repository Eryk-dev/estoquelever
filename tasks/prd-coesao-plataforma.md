# PRD: Coesao da Plataforma — Resolver Inconsistencias Estruturais

## 1. Introduction/Overview

A plataforma SISO cresceu organicamente: backend multi-empresa dinamico, mas frontend hardcoded para 2 galpoes (CWB/SP); dois status tracks paralelos no mesmo pedido; inconsistencias visuais entre modulos; worker silencioso quando falha. Este PRD cobre todas as correcoes necessarias para tornar o sistema coeso, escalavel e facil de entender.

**Contexto**: ~500 pedidos/dia, 2 galpoes atuais (CWB, SP), 2 empresas (NetAir, NetParts), mas a arquitetura precisa suportar N galpoes/empresas sem mudanca de codigo.

---

## 2. Goals

- Eliminar todo hardcode de "CWB"/"SP" no frontend e tipos — suportar N galpoes dinamicamente
- Unificar os dois status tracks (`status` + `status_separacao`) em um unico campo com estados claros
- Dar visibilidade ao operador quando o execution worker falha (pedido preso)
- Padronizar componentes visuais (AppShell, design tokens, naming)
- Otimizar queries ineficientes (embalagem fetch all)
- Renomear plataforma para evitar confusao SISO-platform vs SISO-modulo

---

## 3. User Stories

### US-001: Estoque dinamico por galpao no card de pedido
**Description:** As an operador, I want to see stock levels for ALL galpoes in the grupo (not just hardcoded CWB/SP) so that the system works when new galpoes are added.

**Acceptance Criteria:**
- [ ] `EstoqueItem` type in `types/index.ts` replaces `estoqueCWB`/`estoqueSP`/`cwbAtende`/`spAtende`/`localizacaoCWB`/`localizacaoSP` with a dynamic array `estoquesPorGalpao: GalpaoEstoque[]`
- [ ] `GalpaoEstoque` type contains: `galpaoId`, `galpaoNome`, `disponivel`, `saldo`, `reservado`, `depositoId`, `depositoNome`, `localizacao`, `atende` (boolean)
- [ ] `/api/pedidos/route.ts` reads from `siso_pedido_item_estoques` + `siso_empresas` + `siso_galpoes` to build dynamic array (instead of mapping legacy cwb/sp columns)
- [ ] `PedidoCard` renders one stock pill per galpao (not hardcoded 2)
- [ ] `EditableStockPill` receives `galpaoId` + `galpaoNome` instead of literal `"CWB"` / `"SP"`
- [ ] `decisaoIsAvailable()` checks dynamically: propria = origin galpao atende tudo, transferencia = any other galpao atende tudo
- [ ] `getRelevantLocation()` uses origin galpao vs best alternative galpao (not CWB/SP ternary)
- [ ] Decision dropdown label shows actual galpao names (e.g., "Transferencia SP" not hardcoded)
- [ ] Typecheck passes with no `as "CWB" | "SP"` casts

### US-002: API de pedidos retorna estoque normalizado
**Description:** As a developer, I want the `/api/pedidos` endpoint to return stock data from the normalized `siso_pedido_item_estoques` table so that the frontend doesn't depend on legacy CWB/SP columns.

**Acceptance Criteria:**
- [ ] GET `/api/pedidos` joins `siso_pedido_item_estoques` with `siso_empresas` and `siso_galpoes`
- [ ] Each item in the response has `estoquesPorGalpao[]` with aggregated data per galpao
- [ ] The `atende` boolean per galpao is calculated server-side (disponivel >= quantidade_pedida)
- [ ] Legacy fields `estoqueCWB`, `estoqueSP`, `cwbAtende`, `spAtende` are removed from the API response
- [ ] Frontend `Pedido` type updated to match new response shape
- [ ] Existing dashboard continues to render correctly with the new data shape

### US-003: Unificar status em campo unico
**Description:** As an operador, I want a single, clear status for each pedido so that "concluido" actually means the order is fully done (shipped), not just "worker finished executing".

**Acceptance Criteria:**
- [ ] New unified `StatusPedido` type with ordered states:
  ```
  pendente → executando → aguardando_compra → aguardando_nf → aguardando_separacao → em_separacao → separado → embalado → cancelado → erro
  ```
- [ ] Database migration adds column `status_unificado` to `siso_pedidos` with the new enum
- [ ] Migration script populates `status_unificado` from existing `status` + `status_separacao` logic:
  - status=pendente → pendente
  - status=executando → executando
  - status=concluido + status_separacao=aguardando_compra → aguardando_compra
  - status=concluido + status_separacao=aguardando_nf → aguardando_nf
  - status=concluido + status_separacao=aguardando_separacao → aguardando_separacao
  - status=concluido + status_separacao=em_separacao → em_separacao
  - status=concluido + status_separacao=separado → separado
  - status=concluido + status_separacao=embalado → embalado
  - status=cancelado → cancelado
  - status=erro → erro
- [ ] All backend code (webhook, processor, worker, approval, separacao APIs, compras APIs) writes to `status_unificado` instead of the two separate fields
- [ ] All frontend code reads `status_unificado` (single field)
- [ ] Old `status` and `status_separacao` columns are kept for now (deprecated, not deleted) to avoid breaking running queries
- [ ] SISO module filters: `pendente` tab shows `status_unificado=pendente`
- [ ] Separacao module filters by the separacao-related statuses from `status_unificado`
- [ ] Compras module filters by `aguardando_compra` from `status_unificado`

### US-004: Feedback visual de erro do worker
**Description:** As an operador, I want to see when an order is stuck in "executando" or has failed so that I can take action instead of the order silently disappearing.

**Acceptance Criteria:**
- [ ] SISO dashboard shows a 4th tab "Executando" (or inline banner) with orders in `status_unificado=executando` for more than 2 minutes
- [ ] Orders in `status_unificado=erro` appear in the "Pendente" tab with a red error badge showing the error message
- [ ] Error badge is clickable and shows full error text + number of retry attempts
- [ ] Admin users see a "Reprocessar" button on error orders that re-enqueues the execution job
- [ ] The `siso_fila_execucao` retry count and next retry time are visible on the error badge
- [ ] Typecheck/lint passes

### US-005: Separacao page usa AppShell
**Description:** As a developer, I want the Separacao page to use `AppShell` like all other pages so that the header is consistent across modules.

**Acceptance Criteria:**
- [ ] `/separacao/page.tsx` uses `<AppShell>` instead of manual header markup
- [ ] Header matches visual pattern of Compras, Configuracoes, Monitoramento
- [ ] `AppShell` supports the extra elements Separacao needs (user badge, logout) via `headerRight` prop
- [ ] `max-w-5xl` is preserved (Separacao uses wider layout than max-w-3xl default)
- [ ] No visual regression in the separacao page

### US-006: Login page usa design tokens
**Description:** As a developer, I want the login page to use the same CSS variable-based tokens as the rest of the app so that theme changes apply consistently.

**Acceptance Criteria:**
- [ ] All `border-zinc-200`, `bg-zinc-50`, `text-zinc-700` etc in `login/page.tsx` are replaced with `border-line`, `bg-surface`, `bg-paper`, `text-ink`, `text-ink-muted` etc
- [ ] Dark mode toggle (if applied to rest of app) also affects login page
- [ ] No visual regression in light mode

### US-007: Embalagem fetch otimizado
**Description:** As a developer, I want the embalagem page to fetch only the selected pedidos (not all separado orders) so that the page stays fast at scale.

**Acceptance Criteria:**
- [ ] `/separacao/embalagem/page.tsx` passes `pedido_ids` as query parameter to the API
- [ ] The API `/api/separacao` (or a dedicated endpoint) accepts `pedido_ids` filter and returns only those orders
- [ ] No full-table scan of all `separado` orders for embalagem
- [ ] Embalagem page still works correctly (pedidos load, scan works, completion works)

### US-008: Renomear plataforma
**Description:** As a user, I want the platform name and module names to be distinct so that "SISO" doesn't mean two different things.

**Acceptance Criteria:**
- [ ] `layout.tsx` metadata title changed from "SISO Platform" to "Gestao de Pedidos" (or similar)
- [ ] Home page (`page.tsx`) header shows "Gestao de Pedidos" as platform name
- [ ] The SISO module card keeps title "SISO" with subtitle "Separacao Inteligente de Ordens"
- [ ] `/siso/page.tsx` header keeps "SISO" as module name
- [ ] Browser tab shows "Gestao de Pedidos" on home, "SISO" on the module page

### US-009: Monitoramento remove campo deprecated filial
**Description:** As a developer, I want the monitoring page to show `empresa_nome` instead of the deprecated `filial` field.

**Acceptance Criteria:**
- [ ] `MonitoringData.recentErrors` type replaces `filial: string | null` with `empresaNome: string | null`
- [ ] `/api/monitoring/route.ts` joins `siso_empresas` to resolve empresa name
- [ ] Monitoring UI renders empresa name badge instead of filial badge
- [ ] No references to `filial` in monitoring code

### US-010: Padronizar refresh intervals
**Description:** As a developer, I want consistent auto-refresh behavior across modules.

**Acceptance Criteria:**
- [ ] All list pages (SISO, Separacao, Compras) use the same base interval (30s)
- [ ] Active workflow pages (Checklist, Embalagem) use a faster interval (10s)
- [ ] Monitoring keeps 30s
- [ ] Intervals are defined as named constants in a shared location (e.g., `lib/constants.ts`)
- [ ] Comment in constants file explains the rationale for each interval

---

## 4. Functional Requirements

### Estoque Dinamico (US-001, US-002)
- FR-1: The system must display stock for any number of galpoes in a pedido card, not just 2
- FR-2: The `/api/pedidos` endpoint must return stock data aggregated by galpao from `siso_pedido_item_estoques`
- FR-3: The decision availability logic must dynamically check if origin or any alternative galpao can fulfill all items
- FR-4: The `EditableStockPill` component must work with any galpao (identified by UUID, displayed by name)
- FR-5: The decision dropdown labels must use actual galpao names from the data

### Status Unificado (US-003)
- FR-6: A new `status_unificado` column must be added to `siso_pedidos` with all possible lifecycle states
- FR-7: All write paths (webhook processor, approval, worker, separacao APIs, compras APIs, cancellation handler) must update `status_unificado`
- FR-8: All read paths (SISO dashboard, Separacao, Compras, Monitoring) must filter on `status_unificado`
- FR-9: A data migration must backfill `status_unificado` from existing `status` + `status_separacao`

### Worker Feedback (US-004)
- FR-10: Orders stuck in `executando` for >2min must be visually flagged in the SISO dashboard
- FR-11: Orders in `erro` status must show error details and retry metadata
- FR-12: Admin users must be able to re-enqueue failed execution jobs

### UI Consistency (US-005, US-006, US-008, US-009, US-010)
- FR-13: All pages must use `AppShell` for header/layout consistency
- FR-14: All pages must use CSS variable design tokens (no hardcoded zinc-* for semantic elements)
- FR-15: Platform title and module title must be distinct strings
- FR-16: Monitoring must show empresa name, not deprecated filial
- FR-17: Refresh intervals must follow a documented standard

### Performance (US-007)
- FR-18: Embalagem page must not fetch all orders of a given status — only the selected subset

---

## 5. Non-Goals (Out of Scope)

- **Pagina de detalhe do pedido**: no cross-module order detail page (deferred)
- **Notificacoes realtime**: no Supabase realtime subscriptions or push notifications (deferred)
- **Dashboard unificado**: no single dashboard spanning all modules (deferred)
- **Remover colunas legacy**: `status`, `status_separacao`, `filial_origem`, `estoque_cwb_*`, `estoque_sp_*` columns are kept deprecated but NOT deleted in this phase
- **Remover webhook-processor legacy writes**: processor still writes to legacy CWB/SP columns for backwards compat during transition (can be cleaned up later)
- **Mobile layout**: no mobile-specific optimizations beyond current responsive behavior
- **Internacionalizacao**: no i18n support

---

## 6. Technical Considerations

### Database Migration
- New column `status_unificado TEXT` on `siso_pedidos` with CHECK constraint for valid states
- Backfill script must handle all combinations of `status` + `status_separacao`
- Index on `status_unificado` for query performance (replaces existing indexes on `status` and `status_separacao`)
- Migration must be backwards compatible — old columns stay, new column added

### Breaking Change: Pedido Type
- The `Pedido` and `EstoqueItem` types change significantly (dynamic arrays vs fixed fields)
- All components consuming these types will need updates: `PedidoCard`, `PedidoCardConcluido`, `ProductRow`, `ActionRow`, `DecisaoDropdown`
- The `/api/pedidos` response shape changes — any external consumers would break (there are none currently)

### Dependency Order
Recommended implementation order:
1. **US-003** (status unificado) — database migration first, then update all write paths, then all read paths
2. **US-002** (API retorna estoque normalizado) — backend change
3. **US-001** (frontend dinamico) — depends on US-002
4. **US-004** (worker feedback) — depends on US-003
5. **US-005 to US-010** (cleanup) — independent, can be done in any order

### Existing Normalized Data
- `siso_pedido_item_estoques` already has per-empresa stock data (written by webhook-processor)
- This table just needs to be JOINed with `siso_empresas` + `siso_galpoes` to get galpao-level aggregation
- No new data capture needed — the data is already there, just not consumed by the frontend

### Risk: Status Unification Complexity
- The `status + status_separacao` dual-track is deeply embedded in:
  - `webhook-processor.ts` (writes both)
  - `execution-worker.ts` (writes both)
  - `/api/pedidos/aprovar/route.ts` (writes both)
  - `/api/separacao/*.ts` (reads/writes status_separacao)
  - `/api/compras/*.ts` (reads/writes status_separacao)
  - `nf-webhook-handler.ts` (writes status_separacao)
  - Cancellation handler in webhook route (writes both)
- All of these must be updated atomically to avoid inconsistent state
- Recommended: update write paths to write BOTH old + new columns during transition, then switch reads to new column, then stop writing old columns

---

## 7. Success Metrics

- Zero hardcoded "CWB" or "SP" strings in frontend/types code (grep test)
- Adding a 3rd galpao via Configuracoes shows stock correctly in PedidoCard without code changes
- Single `status_unificado` field drives all filtering in all 3 modules
- Failed worker jobs are visible in the SISO dashboard within 2 minutes
- All pages render with consistent header via AppShell
- Embalagem page makes 1 API call for N selected pedidos (not 1 call for all separado orders)
- `npm run build` passes with zero type errors

---

## 8. Open Questions (Resolved)

1. **Stock adjustment endpoint**: Yes — `/api/tiny/stock/ajustar` will receive `galpao_id: UUID` instead of `galpao: "CWB"|"SP"`. Resolves empresa/token internally via `siso_empresas` + `siso_tiny_connections`.
2. **Concluido tab in SISO**: "Concluidos" shows all manually-approved pedidos past `executando` (i.e., `tipoResolucao=manual` AND status in `aguardando_nf, aguardando_separacao, em_separacao, separado, embalado`). It's the operator's history of "pedidos que eu aprovei".
3. **Auto tab in SISO**: Shows all pedidos with `tipoResolucao=auto` regardless of current status. Operator wants to know "quais foram auto-aprovados", not "quais chegaram ao fim".
4. **Compras module status filter**: Lifecycle is clear — `aguardando_compra` (waiting for OC) → items move to OC → conferencia receives → transition to `aguardando_separacao`. The `status_unificado` field handles this naturally.
