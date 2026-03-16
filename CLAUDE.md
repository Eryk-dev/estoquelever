# SISO - Sistema Inteligente de Separacao de Ordens

## What This Project Is

A fullstack web app that replaces an n8n workflow for processing multi-company auto parts orders. Multiple companies (Empresas) grouped by physical location (Galpao) and business affinity (Grupo) sell on marketplaces (Mercado Livre, Shopee). When an order arrives via Tiny ERP webhook, the system checks stock across all companies in the same group and either auto-approves or routes to a human operator.

The system also handles the full post-approval workflow: separation (wave picking), packing, label printing, purchase orders (OC), and expedition.

**Volume:** ~500 orders/day across all companies.

## Stack

- **Framework:** Next.js 16.1.6 (App Router), React 19, TypeScript
- **Styling:** Tailwind CSS 4 (no component library — all custom)
- **Database:** Supabase (project `wrbrbhuhsaaupqsimkqz`, org `parts-catalogs`)
- **ERP:** Tiny ERP API v3 (OAuth2 via Keycloak)
- **Printing:** PrintNode API (thermal labels — ZPL + PDF)
- **State:** TanStack React Query (client), no global store
- **Realtime:** Supabase Realtime (used in separacao module)
- **UI libs:** Sonner (toasts), Lucide (icons), clsx + tailwind-merge
- **Fonts:** Outfit (sans) + JetBrains Mono (mono)

## Architecture

```
Tiny ERP webhook (POST)
    |
    v
/api/webhook/tiny/route.ts       <-- validates, identifies empresa by CNPJ, dedup
    |                                 discriminates: pedido vs nota_fiscal
    |
    ├─ pedido ───> webhook-processor.ts
    |              resolves grupo, fetches order, enriches stock across ALL
    |              empresas in grupo, aggregates by galpao, calculates
    |              suggestion, saves to DB, auto-approves if propria
    |
    └─ nota_fiscal ───> nf-webhook-handler.ts
                        transitions pedido aguardando_nf → aguardando_separacao
                        reconciles NF that arrives before/after pedido

Dashboard (/siso)                 <-- operators see filtered orders, approve/reject
    |
    v
/api/pedidos/aprovar              <-- enqueues stock-posting job
    |
    v
execution-worker.ts               <-- post-approval: deducts stock following tier order
    |
    v
Separacao (/separacao)            <-- wave picking → checklist → packing → expedition
    |
    └─ /api/separacao/*           <-- bipar, marcar, concluir, embalar, expedir
    └─ agrupamento-service.ts     <-- pre-creates Tiny agrupamentos, downloads ZPL
    └─ etiqueta-service.ts        <-- prints shipping labels via PrintNode

Compras (/compras)                <-- purchase order management for OC decisions
    |
    └─ /api/compras/*             <-- ordens, conferir, devolver, indisponivel
    └─ compras-release.ts         <-- when all items received → resume execution
```

### Hierarchy: Galpao > Empresa > Grupo

- **Galpao**: physical warehouse location (e.g., CWB, SP). Can have N empresas.
- **Empresa**: Tiny ERP account with its own CNPJ (e.g., NetAir, NetParts). FK to galpao.
- **Grupo**: business affinity grouping (e.g., Autopecas). Empresas in the same grupo check stock across each other.
- **Tier**: deduction priority within a grupo. The empresa that received the order gets tier 1 override at runtime.

### Current Data

| Galpao | Empresa | CNPJ | Grupo | Tier |
|---|---|---|---|---|
| CWB | NetAir | `34857388000163` | Autopecas | 1 |
| SP | NetParts | `34857388000244` | Autopecas | 1 |

### Decision Logic (per order, not per item)

1. Origin galpao has all items -> `propria` -> **auto-approve** (no human review)
2. Other galpao has all items -> `transferencia` -> human panel
3. Neither has everything, partial -> `propria` or `transferencia` (whichever covers more) -> human panel
4. Neither has any stock -> `oc` (purchase order) -> human panel

Auto-approval ONLY happens for case 1. Everything else goes to the operator panel.

### Separation Flow (post-approval)

```
aguardando_compra → aguardando_nf → aguardando_separacao → em_separacao → separado → embalado
```

- `aguardando_compra`: OC items not yet purchased
- `aguardando_nf`: waiting for Tiny nota fiscal webhook
- `aguardando_separacao`: ready for operator to start picking
- `em_separacao`: wave picking in progress (barcode scanning)
- `separado`: picking complete, ready for packing
- `embalado`: packing done, ready for expedition

## Project Structure

```
src/
  app/
    page.tsx                       # Landing / redirect
    layout.tsx                     # Root layout (Outfit + JetBrains Mono fonts)
    login/page.tsx                 # PIN login page
    siso/page.tsx                  # SISO Dashboard — 3 tabs (Pendente/Concluidos/Auto)
    separacao/
      page.tsx                     # Separation dashboard — 6 tabs by status
      checklist/page.tsx           # Wave picking checklist view
      embalagem/page.tsx           # Packing view
    compras/
      page.tsx                     # Purchase orders — Aguardando/Comprado/Indisponível
      conferencia/[ordemCompraId]/page.tsx  # Receiving screen for specific PO
    configuracoes/page.tsx         # Settings — Galpao/Empresa hierarchy, Grupos, Tiny, PrintNode
    monitoramento/page.tsx         # Monitoring dashboard (admin only)
    admin/usuarios/page.tsx        # User CRUD (admin only)
    api/
      webhook/
        tiny/route.ts              # Webhook receiver (POST) — pedido + nota_fiscal
        reprocessar/route.ts       # Retry failed webhooks (POST)
      auth/login/route.ts          # PIN auth (POST)
      pedidos/
        route.ts                   # List orders (GET) — joins normalized stock table
        aprovar/route.ts           # Order approval (POST) — enqueues execution
        [id]/historico/route.ts    # Order history/audit trail (GET)
        [id]/observacoes/route.ts  # Order comments (GET/POST)
      separacao/
        route.ts                   # List separation orders with counts (GET)
        iniciar/route.ts           # Start separation (POST)
        bipar/route.ts             # Barcode scan during picking (POST)
        bipar-checklist/route.ts   # Barcode scan in checklist phase (POST)
        marcar-item/route.ts       # Mark item as picked (POST)
        desfazer-bip/route.ts      # Undo a barcode scan (POST)
        concluir/route.ts          # Complete separation (POST)
        bipar-embalagem/route.ts   # Barcode scan during packing (POST)
        confirmar-item-embalagem/route.ts  # Confirm item packed (POST)
        expedir/route.ts           # Dispatch order (POST)
        checklist-items/route.ts   # Get checklist items (GET)
        cancelar/route.ts          # Cancel separation (POST)
        reiniciar/route.ts         # Restart separation (POST)
        voltar-etapa/route.ts      # Go back one step (POST)
        produto-esgotado/route.ts  # Mark product out of stock (POST)
        reimprimir/route.ts        # Reprint label (POST)
        forcar-pendente/route.ts   # Force order back to pending (POST)
      compras/
        route.ts                   # List purchase items grouped by supplier (GET)
        ordens/route.ts            # List purchase orders (GET)
        conferir/route.ts          # Mark items as received (POST)
        conferencia/[ordemCompraId]/route.ts  # Receive items for PO (GET/POST)
        itens/[itemId]/indisponivel/route.ts  # Mark item unavailable (POST)
        itens/[itemId]/devolver/route.ts      # Return received item (POST)
        itens/[itemId]/trocar-fornecedor/route.ts  # Change supplier (POST)
      worker/processar/route.ts    # Execution worker trigger (POST)
      admin/
        usuarios/route.ts          # User CRUD (GET/POST/PUT/DELETE)
        galpoes/route.ts           # Galpao CRUD (GET/POST) — GET returns full hierarchy
        galpoes/[id]/route.ts      # Galpao by ID (PUT/DELETE)
        empresas/route.ts          # Empresa CRUD (GET/POST)
        empresas/[id]/route.ts     # Empresa by ID (PUT/DELETE)
        grupos/route.ts            # Grupo CRUD (GET/POST)
        grupos/[id]/route.ts       # Grupo by ID (PUT/DELETE)
        grupos/[id]/empresas/route.ts           # Add empresa to grupo (POST)
        grupos/[id]/empresas/[empresaId]/route.ts  # Update tier / remove
        printnode/
          api-key/route.ts         # Manage PrintNode API key (GET/PUT)
          printers/route.ts        # List printers (GET)
          test/route.ts            # Test PrintNode connection (POST)
      tiny/
        connections/route.ts       # Tiny connections CRUD (GET/POST/PUT)
        test-connection/route.ts   # Test Tiny connection (POST)
        deposits/route.ts          # List Tiny deposits (GET)
        stock/ajustar/route.ts     # Adjust stock in Tiny (POST)
        oauth/route.ts             # OAuth2 initiation (GET -> redirect)
        oauth/callback/route.ts    # OAuth2 callback (GET)
      monitoring/route.ts          # Monitoring data (GET)
  components/
    app-shell.tsx                  # Page wrapper — header, auth check, admin-only pages
    providers.tsx                  # QueryClientProvider + Toaster
    pedido/
      pedido-card.tsx              # Pending order card (dynamic stock per galpão)
      pedido-card-concluido.tsx    # Completed order row (compact, expandable)
      observacoes-timeline.tsx     # Comments/observations timeline
    separacao/
      separacao-card.tsx           # Full separation card (picking/packing)
      pedido-separacao-card.tsx    # Order card in separation list
      item-separacao-row.tsx       # Product row with barcode, location
      scan-input.tsx               # Barcode scanner input
      pedido-timeline.tsx          # Separation event timeline
      tab-pendentes.tsx            # Pending orders tab
      tab-aguardando-nf.tsx        # Awaiting NF tab
      tab-embalados.tsx            # Packed orders tab
      tab-expedidos.tsx            # Dispatched orders tab
      audio-feedback.ts            # Audio beep on scan
    compras/
      fornecedor-card.tsx          # Supplier card with items by SKU
      ordem-compra-card.tsx        # Purchase order card
    configuracoes/
      galpoes-empresas-section.tsx # Galpao > Empresa hierarchy editor
      galpao-card.tsx              # Single galpao card
      empresa-row.tsx              # Single empresa row
      grupos-section.tsx           # Grupo management
      connection-card.tsx          # Tiny OAuth2 connection card
      deposito-selector.tsx        # Deposit selector
      webhook-url-card.tsx         # Webhook URL display
      printnode-section.tsx        # PrintNode printer setup
      types.ts                     # Local types for configuracoes
    ui/
      tabs.tsx                     # Pill-style tab bar with counters
      empty-state.tsx              # Empty list message
      loading-spinner.tsx          # Spinner component
  lib/
    # ── Core business logic ──
    empresa-lookup.ts              # CNPJ -> empresa resolution (cached 5min)
    grupo-resolver.ts              # Resolve grupo, tier-based deduction order, aggregate stock by galpao
    webhook-processor.ts           # Core: fetch order -> enrich stock -> calc suggestion -> save
    nf-webhook-handler.ts          # Handle nota_fiscal webhooks, transition aguardando_nf → aguardando_separacao
    execution-worker.ts            # Post-approval: deduct stock following tier order
    compras-release.ts             # When all OC items received → resume execution
    # ── Tiny ERP integration ──
    tiny-api.ts                    # Tiny ERP API v3 client
    tiny-oauth.ts                  # OAuth2 token management — getValidTokenByEmpresa()
    rate-limiter.ts                # Rate limiting per empresa_id
    sku-fornecedor.ts              # SKU prefix -> supplier/galpao for purchase orders
    # ── Printing & labels ──
    agrupamento-service.ts         # Pre-create Tiny agrupamentos, download ZPL labels
    etiqueta-service.ts            # Print shipping labels via PrintNode (fast: cached ZPL, slow: API)
    etiqueta-download.ts           # Download/extract ZPL from Tiny ZIP files
    printnode.ts                   # PrintNode API client (PDF + ZPL, printer resolution)
    # ── Auth & sessions ──
    auth-context.tsx               # AuthProvider + useAuth (localStorage + sessionId)
    session.ts                     # Server-side session validation (X-Session-Id header)
    filtrar-pedidos.ts             # Role-based order filtering
    # ── Infrastructure ──
    historico-service.ts           # Order audit trail (siso_pedido_historico)
    config.ts                      # System config KV store (siso_configuracoes)
    domain-helpers.ts              # UI helpers: e-commerce abbreviations, decisão colors
    supabase.ts                    # Supabase browser client
    supabase-server.ts             # Supabase service-role client
    logger.ts                      # Structured logger (stdout JSON + Supabase siso_logs + siso_erros)
    utils.ts                       # cn() helper (clsx + tailwind-merge)
    # ── Deprecated ──
    cnpj-filial.ts                 # DEPRECATED — thin wrapper, use empresa-lookup.ts
  hooks/
    use-realtime-separacao.ts      # Supabase Realtime subscription for separation updates
  types/index.ts                   # Central type definitions
  data/
    mock.ts                        # Mock order data for UI development
    mock-separacao.ts              # Mock separation data
supabase/
  migrations/                      # Database migrations (YYYYMMDD_description.sql)
```

## Database Tables (Supabase)

All tables are prefixed with `siso_`:

### Core Tables

| Table | Purpose |
|---|---|
| `siso_pedidos` | Orders with stock enrichment, suggestion, status, separation status. Has `empresa_origem_id` FK. |
| `siso_pedido_itens` | Per-item data (unique: `pedido_id + produto_id`). Has legacy `estoque_cwb_*`/`estoque_sp_*` columns + normalized FK. |
| `siso_pedido_item_estoques` | **Primary stock source.** Normalized stock per empresa (pedido_id, produto_id, empresa_id). API reads from here. |
| `siso_fila_execucao` | Execution queue with empresa_id, retry logic, exponential backoff |
| `siso_usuarios` | Users with name, PIN, cargo, active flag, printnode printer config |
| `siso_sessoes` | Server-side sessions (id, usuario_id, expira_em) |
| `siso_pedido_historico` | Immutable audit trail (evento, detalhes, timestamps) |
| `siso_ordens_compra` | Purchase orders by supplier |

### Hierarchy Tables

| Table | Purpose |
|---|---|
| `siso_galpoes` | Physical locations (id, nome unique, descricao, ativo, printnode config) |
| `siso_empresas` | Tiny ERP accounts (id, nome, cnpj unique, galpao_id FK, ativo) |
| `siso_grupos` | Business affinity groups (id, nome unique) |
| `siso_grupo_empresas` | N:1 empresa→grupo with tier (empresa_id unique) |

### Infrastructure Tables

| Table | Purpose |
|---|---|
| `siso_tiny_connections` | Tiny API connections per empresa. Has `empresa_id` FK. |
| `siso_webhook_logs` | Webhook dedup + processing status (unique: `dedup_key`). Has `empresa_id` FK. |
| `siso_api_calls` | API call tracking. Has `empresa_id` FK. |
| `siso_logs` | Structured application logs (info/warn/error) |
| `siso_erros` | **Dedicated error tracking** with stack traces, categories, correlation IDs, resolution tracking. Queryable for diagnostics. |
| `siso_configuracoes` | Key-value config store |

> **Note:** `siso_pedido_itens` still has deprecated `estoque_cwb_*` / `estoque_sp_*` columns. The API reads from `siso_pedido_item_estoques` (normalized). The webhook processor writes to both for backwards compat. Legacy columns will be removed in a future migration.

## Key Domain Concepts

### User Roles (Cargos)
- `admin` — sees everything, manages users and settings
- `operador_cwb` — sees/processes CWB orders only
- `operador_sp` — sees/processes SP orders only
- `comprador` — sees only purchase-order-suggested orders

### Order Statuses
- `pendente` — awaiting operator decision
- `executando` — being processed
- `concluido` — finished
- `cancelado` — cancelled via webhook
- `erro` — processing failed

### Decisions (Decisoes)
- `propria` — fulfilled by origin galpao
- `transferencia` — inter-galpao transfer needed
- `oc` — purchase order from supplier

### Stock Data Model

Stock is stored normalized in `siso_pedido_item_estoques` (one row per empresa per item). The API aggregates by galpão and returns a dynamic `estoques: Record<string, GalpaoEstoque>` map keyed by galpão name. This supports any number of galpões without hardcoded references.

### SKU-to-Supplier Mapping
| Prefix | Supplier | Default Galpao |
|---|---|---|
| `19` | Diversos | CWB |
| `EW` | Eletricway | SP |
| `LD` | LDRU | SP |
| `TH`, `TG` | Tiger | SP |
| `L0` | LEFS | SP |
| 6-digit numeric | ACA | CWB |
| `G` | GAUSS | CWB |
| `M` | MRMK | SP |
| `CAK`, `CS` | Delphi | SP |

## Environment Variables

Required in `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://wrbrbhuhsaaupqsimkqz.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # Required for server-side operations
```

Optional:
```
WORKER_SECRET=<secret>   # Protects POST /api/worker/processar
```

OAuth2 credentials for Tiny are stored in the `siso_tiny_connections` table (not env vars).
PrintNode API key is stored in `siso_configuracoes` (key: `printnode_api_key`).

## Development Commands

```bash
npm run dev       # Start dev server (turbopack)
npm run build     # Production build
npm run start     # Start production server
npm run lint      # ESLint
```

## Authentication

- No Supabase Auth — uses custom PIN-based auth
- Login: `POST /api/auth/login` with `{ nome, pin }`
- Session: server-side `siso_sessoes` table + `X-Session-Id` header
- Client persists session in localStorage (`siso_user` key)
- `sisoFetch` wrapper in `auth-context.tsx` auto-sends session header
- Server validates via `getSessionUser()` in `session.ts`
- Seed user: `Eryk / 1234 / admin`

## Coding Conventions

### General
- TypeScript strict mode. All types in `src/types/index.ts`.
- Portuguese for domain terms (pedido, filial, cargo, decisao, galpao, empresa, grupo). English for technical terms (webhook, token, logger).
- File and function names in English (e.g., `empresa-lookup.ts`, `getEmpresaByCnpj`).
- No barrel exports. Import directly from the source file.
- Stock data is dynamic per galpão — never hardcode "CWB" or "SP" in type definitions or rendering logic.

### Frontend
- All pages are `"use client"` except layout.
- Tailwind classes directly on elements (no CSS modules, no styled-components).
- Design: zinc-based neutral palette, dark mode supported, mobile-first (max-w-3xl).
- Icons: only Lucide (`lucide-react`). No SVG files except favicon.
- Toasts: `sonner` (via `toast.success()`, `toast.error()`).
- No component library (no shadcn, no Radix). All components are custom.
- `AppShell` wraps all pages for consistent layout and auth.

### Backend (API Routes)
- Next.js App Router route handlers (`route.ts` with named exports `GET`, `POST`, etc.).
- All DB access via `createServiceClient()` from `supabase-server.ts` (service role).
- Error responses: `NextResponse.json({ error: "..." }, { status: N })`.
- Logging via `logger.info/warn/error(source, message, meta?)` — never `console.log` directly.
- **Error logging:** Use `logger.logError(opts)` for actual errors — writes to both `siso_logs` and `siso_erros` with stack traces, categories, correlation IDs. See `ErrorLogOptions` in `logger.ts`.
- **Error categories:** `validation`, `database`, `external_api`, `auth`, `config`, `business_logic`, `infrastructure`, `unknown`.
- **Correlation IDs:** Generated at webhook entry via `generateCorrelationId()`, auto-attached to all `logError` calls in the same request.
- Webhook processor is fire-and-forget (returns 200 immediately, processes async).
- History events recorded via `registrarEvento()` — fire-and-forget safe.

### Error Knowledge Base
- **`erros-conhecidos.yaml`** at project root tracks every error that was diagnosed and fixed.
- **MANDATORY:** When you fix any error or bug, add an entry to `erros-conhecidos.yaml` following the format in the file (id, date, source, category, message, cause, fix, files, tags).
- **Before debugging:** Always check `erros-conhecidos.yaml` first — the error may have been fixed before.
- Tags are searchable keywords for fast lookup.

### Database
- All tables prefixed with `siso_`.
- Migrations in `supabase/migrations/` with format `YYYYMMDD_description.sql`.
- Upserts for idempotency (dedup on unique constraints).

## Current Status

- **Working:** Full order pipeline (webhook → stock check → approval → execution), separation/picking/packing flow, purchase order management, label printing via PrintNode, Galpao/Empresa/Grupo hierarchy CRUD, monitoring dashboard, user management, Tiny OAuth2, NF webhook reconciliation.
- **Not yet implemented:**
  - Real-time notifications for new pending orders (polling at 30s currently)
  - Cleanup deprecated `estoque_cwb_*`/`estoque_sp_*` columns from `siso_pedido_itens`
  - Remove deprecated `cnpj-filial.ts`

## Tiny ERP API Notes

- API v3 base: `https://api.tiny.com.br/public-api/v3`
- OAuth2 via Keycloak: `https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect`
- Token lifetime is short — auto-refresh with 60s buffer before expiry
- Deposits (warehouses) are fetched from stock endpoint — there is NO dedicated `/depositos` endpoint
- Rate limiting: per-empresa, managed by `rate-limiter.ts`
- Stock response has `depositos[]` array — pick the matching deposit by configured `deposito_id`
- **Always consult `api tiny.json` in project root** for endpoint details
- Responses do NOT have a `{ data: ... }` wrapper
- Trade name field = `fantasia`
- Product status values: `A` (active), `I` (inactive), `E` (excluded)
