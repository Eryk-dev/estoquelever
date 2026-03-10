# SISO - Sistema Inteligente de Separacao de Ordens

## What This Project Is

A fullstack web app that replaces an n8n workflow for processing multi-company auto parts orders. Multiple companies (Empresas) grouped by physical location (Galpao) and business affinity (Grupo) sell on marketplaces (Mercado Livre, Shopee). When an order arrives via Tiny ERP webhook, the system checks stock across all companies in the same group and either auto-approves or routes to a human operator.

**Volume:** ~500 orders/day across all companies.

## Stack

- **Framework:** Next.js 16.1.6 (App Router), React 19, TypeScript
- **Styling:** Tailwind CSS 4 (no component library — all custom)
- **Database:** Supabase (project `wrbrbhuhsaaupqsimkqz`, org `parts-catalogs`)
- **ERP:** Tiny ERP API v3 (OAuth2 via Keycloak)
- **State:** TanStack React Query (client), no global store
- **UI libs:** Sonner (toasts), Lucide (icons), clsx + tailwind-merge
- **Fonts:** Outfit (sans) + JetBrains Mono (mono)

## Architecture

```
Tiny ERP webhook (POST)
    |
    v
/api/webhook/tiny/route.ts       <-- validates, identifies empresa by CNPJ, dedup
    |
    v
webhook-processor.ts             <-- resolves grupo, fetches order, enriches stock
    |                                 across ALL empresas in grupo, aggregates by
    |                                 galpao, calculates suggestion, saves to DB
    v
Dashboard (page.tsx)              <-- operators see filtered orders, approve/reject
    |
    v
execution-worker.ts              <-- post-approval: deducts stock following tier order
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

## Project Structure

```
src/
  app/
    page.tsx                       # Dashboard — 3 tabs (Pendente/Concluidos/Auto)
    layout.tsx                     # Root layout (Outfit + JetBrains Mono fonts)
    login/page.tsx                 # PIN login page
    configuracoes/page.tsx         # Settings — Galpao/Empresa hierarchy, Grupos, Tiny connections
    monitoramento/page.tsx         # Monitoring dashboard (admin only)
    admin/usuarios/page.tsx        # User CRUD (admin only)
    api/
      webhook/
        tiny/route.ts              # Webhook receiver (POST) — uses empresa-lookup
        reprocessar/route.ts       # Retry failed webhooks (POST)
      auth/login/route.ts          # PIN auth (POST)
      pedidos/aprovar/route.ts     # Order approval endpoint (POST)
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
        grupos/[id]/empresas/[empresaId]/route.ts  # Update tier / remove from grupo
      tiny/
        connections/route.ts       # Tiny connections CRUD (GET/PUT)
        test-connection/route.ts   # Test Tiny connection (POST)
        deposits/route.ts          # List Tiny deposits (GET)
        oauth/route.ts             # OAuth2 initiation (GET -> redirect)
        oauth/callback/route.ts    # OAuth2 callback (GET)
      monitoring/route.ts          # Monitoring data (GET)
  components/
    pedido/
      pedido-card.tsx              # Pending order card (expandable, with approve)
      pedido-card-concluido.tsx    # Completed order row (compact)
    ui/
      tabs.tsx                     # Pill-style tab bar with counters
      empty-state.tsx              # Empty list message
      loading-spinner.tsx          # Spinner component
    providers.tsx                  # QueryClientProvider + Toaster
  lib/
    empresa-lookup.ts              # CNPJ -> empresa resolution (cached 5min). Replaces cnpj-filial.ts
    grupo-resolver.ts              # Resolve grupo, tier-based deduction order, aggregate stock by galpao
    webhook-processor.ts           # Core: fetch order -> enrich stock across all grupo empresas -> calc suggestion -> save
    execution-worker.ts            # Post-approval: deduct stock following tier order
    tiny-api.ts                    # Tiny ERP API v3 client
    tiny-oauth.ts                  # OAuth2 token management — getValidTokenByEmpresa() (primary) + getValidTokenByFilial() (deprecated)
    rate-limiter.ts                # Rate limiting per empresa_id
    cnpj-filial.ts                 # DEPRECATED — thin wrapper for backwards compat
    sku-fornecedor.ts              # SKU prefix -> supplier/branch for purchase orders
    filtrar-pedidos.ts             # Role-based order filtering
    auth-context.tsx               # AuthProvider + useAuth (localStorage sessions)
    supabase.ts                    # Supabase browser client
    supabase-server.ts             # Supabase service-role client
    logger.ts                      # Structured logger (stdout JSON + Supabase siso_logs)
    utils.ts                       # cn() helper (clsx + tailwind-merge)
  types/index.ts                   # Central type definitions
  data/mock.ts                     # Mock data for UI development
supabase/
  migrations/
    20260309_create_siso_logs.sql
    20260309_add_deposito_columns.sql
    20260309_create_execution_queue.sql
    20260309_add_estoque_saida_lancada.sql
    20260310_create_siso_api_calls.sql
    20260310_create_galpao_empresa_grupo.sql
```

## Database Tables (Supabase)

All tables are prefixed with `siso_`:

### Core Tables

| Table | Purpose |
|---|---|
| `siso_pedidos` | Orders with stock enrichment, suggestion, status. Has `empresa_origem_id` FK. |
| `siso_pedido_itens` | Per-item stock data (unique: `pedido_id + produto_id`). Has `empresa_deducao_id` FK. |
| `siso_pedido_item_estoques` | Normalized stock per empresa (pedido_id, produto_id, empresa_id) |
| `siso_fila_execucao` | Execution queue with empresa_id |
| `siso_usuarios` | Users with name, PIN, cargo, active flag |

### Hierarchy Tables

| Table | Purpose |
|---|---|
| `siso_galpoes` | Physical locations (id, nome unique, descricao, ativo) |
| `siso_empresas` | Tiny ERP accounts (id, nome, cnpj unique, galpao_id FK, ativo) |
| `siso_grupos` | Business affinity groups (id, nome unique) |
| `siso_grupo_empresas` | N:1 empresa→grupo with tier (empresa_id unique) |

### Infrastructure Tables

| Table | Purpose |
|---|---|
| `siso_tiny_connections` | Tiny API connections per empresa. Has `empresa_id` FK. |
| `siso_webhook_logs` | Webhook dedup + processing status (unique: `dedup_key`). Has `empresa_id` FK. |
| `siso_api_calls` | API call tracking. Has `empresa_id` FK. |
| `siso_logs` | Structured application logs |

> **Note:** Several tables still have deprecated `filial` columns alongside the new `empresa_id` FK. The `filial` columns will be removed in a future cleanup.

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

### SKU-to-Supplier Mapping
| Prefix | Supplier | Default Branch |
|---|---|---|
| `19` | Diversos | CWB |
| `LD` | LDRU | SP |
| `TH` | Tiger | SP |
| `L0` | LEFS | SP |
| 6-digit numeric | ACA | CWB |
| `G` | GAUSS | CWB |
| `M` | MRMK | SP |
| `CAK` | Delphi | SP |
| `CS` | Delphi | SP |

## Environment Variables

Required in `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://wrbrbhuhsaaupqsimkqz.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # Required for server-side operations
```

OAuth2 credentials for Tiny are stored in the `siso_tiny_connections` table (not env vars).

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
- Session persisted in localStorage (`siso_user` key)
- No JWT/token — the stored object contains `{ id, nome, cargo }`
- Seed user: `Eryk / 1234 / admin`

## Coding Conventions

### General
- TypeScript strict mode. All types in `src/types/index.ts`.
- Portuguese for domain terms (pedido, filial, cargo, decisao, galpao, empresa, grupo). English for technical terms (webhook, token, logger).
- File and function names in English (e.g., `empresa-lookup.ts`, `getEmpresaByCnpj`).
- No barrel exports. Import directly from the source file.

### Frontend
- All pages are `"use client"` except layout.
- Tailwind classes directly on elements (no CSS modules, no styled-components).
- Design: zinc-based neutral palette, dark mode supported, mobile-first (max-w-3xl).
- Icons: only Lucide (`lucide-react`). No SVG files except favicon.
- Toasts: `sonner` (via `toast.success()`, `toast.error()`).
- No component library (no shadcn, no Radix). All components are custom.

### Backend (API Routes)
- Next.js App Router route handlers (`route.ts` with named exports `GET`, `POST`, etc.).
- All DB access via `createServiceClient()` from `supabase-server.ts` (service role).
- Error responses: `NextResponse.json({ error: "..." }, { status: N })`.
- Logging via `logger.info/warn/error(source, message, meta?)` — never `console.log` directly.
- Webhook processor is fire-and-forget (returns 200 immediately, processes async).

### Database
- All tables prefixed with `siso_`.
- Migrations in `supabase/migrations/` with format `YYYYMMDD_description.sql`.
- Upserts for idempotency (dedup on unique constraints).

## Current Status

- **Working:** Dashboard UI (mock data), PIN auth, webhook receiver, multi-empresa stock enrichment, suggestion calculation, Tiny OAuth2 flow, monitoring dashboard, user management, Galpao/Empresa/Grupo hierarchy CRUD, execution worker, webhook reprocessing.
- **Not yet implemented:**
  - Replace mock data with real-time Supabase subscription on the dashboard
  - Real-time notifications for new pending orders
  - Cleanup deprecated `filial` columns from tables

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
