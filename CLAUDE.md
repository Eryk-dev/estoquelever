# SISO - Sistema Inteligente de Separacao de Ordens

## What This Project Is

A fullstack web app that replaces an n8n workflow for processing multi-branch auto parts orders. Two branches (CWB = NetAir, SP = NetParts) sell on marketplaces (Mercado Livre, Shopee). When an order arrives via Tiny ERP webhook, the system checks stock in both branches and either auto-approves or routes to a human operator.

**Volume:** ~500 orders/day across both branches.

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
/api/webhook/tiny/route.ts    <-- validates, identifies branch by CNPJ, dedup
    |
    v
webhook-processor.ts          <-- fetches order, enriches stock, calculates suggestion
    |                              saves to siso_pedidos + siso_pedido_itens
    v
Dashboard (page.tsx)           <-- operators see filtered orders, approve/reject
```

### Decision Logic (per order, not per item)

1. Origin branch has all items -> `propria` -> **auto-approve** (no human review)
2. Support branch has all items -> `transferencia` -> human panel
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
    configuracoes/page.tsx         # Settings — OAuth2 connections, webhook URL, deposits
    monitoramento/page.tsx         # Monitoring dashboard (admin only)
    admin/usuarios/page.tsx        # User CRUD (admin only)
    api/
      webhook/tiny/route.ts        # Webhook receiver (POST)
      auth/login/route.ts          # PIN auth (POST)
      admin/usuarios/route.ts      # User CRUD (GET/POST/PUT/DELETE)
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
    webhook-processor.ts           # Core: fetch order -> enrich stock -> calc suggestion -> save
    tiny-api.ts                    # Tiny ERP API v3 client
    tiny-oauth.ts                  # OAuth2 token management (authorize, exchange, refresh)
    cnpj-filial.ts                 # CNPJ -> CWB/SP mapping
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
```

## Database Tables (Supabase)

All tables are prefixed with `siso_`:

| Table | Purpose |
|---|---|
| `siso_pedidos` | Orders with stock enrichment, suggestion, status |
| `siso_pedido_itens` | Per-item stock data (unique: `pedido_id + produto_id`) |
| `siso_usuarios` | Users with name, PIN, cargo, active flag |
| `siso_tiny_connections` | Tiny API connections per branch (unique: `filial`, `cnpj`) |
| `siso_webhook_logs` | Webhook dedup + processing status (unique: `dedup_key`) |
| `siso_logs` | Structured application logs |

## Key Domain Concepts

### Branches (Filiais)
- **CWB** (Curitiba) = NetAir, CNPJ `34857388000163`
- **SP** (Sao Paulo) = NetParts, CNPJ `34857388000244`

### User Roles (Cargos)
- `admin` — sees everything, manages users and settings
- `operador_cwb` — sees/processes CWB orders only
- `operador_sp` — sees/processes SP orders only
- `comprador` — sees only purchase-order-suggested orders

### Order Statuses
- `pendente` — awaiting operator decision
- `executando` — being processed (future use)
- `concluido` — finished
- `cancelado` — cancelled via webhook
- `erro` — processing failed

### Decisions (Decisoes)
- `propria` — fulfilled by origin branch
- `transferencia` — inter-branch transfer needed
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
- Portuguese for domain terms (pedido, filial, cargo, decisao). English for technical terms (webhook, token, logger).
- File and function names in English (e.g., `filtrar-pedidos.ts`, `getFilialByCnpj`).
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

- **Working:** Dashboard UI (mock data), PIN auth, webhook receiver, stock enrichment, suggestion calculation, Tiny OAuth2 flow, monitoring dashboard, user management.
- **Not yet implemented:**
  - Replace mock data with real-time Supabase subscription on the dashboard
  - Execution worker (post-approval: create markers, update order status in Tiny)
  - Real-time notifications for new pending orders

## Tiny ERP API Notes

- API v3 base: `https://api.tiny.com.br/public-api/v3`
- OAuth2 via Keycloak: `https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect`
- Token lifetime is short — auto-refresh with 60s buffer before expiry
- Deposits (warehouses) are fetched dynamically and selected per branch in settings
- Rate limiting: insert 500ms delays between stock queries to avoid throttling
- Stock response has `depositos[]` array — pick the matching deposit by configured `deposito_id`
