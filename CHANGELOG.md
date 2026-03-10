# Changelog

All notable changes to the SISO project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-03-09

Initial release of SISO - Sistema Inteligente de Separacao de Ordens.

### Added

#### Core System
- Webhook receiver (`POST /api/webhook/tiny`) that accepts Tiny ERP order-update webhooks
- Webhook deduplication via `siso_webhook_logs` unique constraint on `dedup_key`
- CNPJ-based branch identification (CWB: `34857388000163`, SP: `34857388000244`)
- Order cancellation handling via webhook (`codigoSituacao: "cancelado"`)

#### Stock Enrichment Engine
- Per-item stock lookup across both branches (CWB and SP) using Tiny API v3
- Configurable deposit (warehouse) selection per branch connection
- SKU-prefix-based supplier mapping for purchase order suggestions
- Rate-limited API calls (500ms between Tiny requests)

#### Decision Logic
- Automatic suggestion calculation per order (not per item):
  - `propria` — origin branch has all items in stock
  - `transferencia` — support branch has all items
  - `oc` — neither branch has stock, suggest purchase order
  - Partial coverage detection with best-branch recommendation
- Auto-approval for orders where origin has full stock (no human review needed)
- Partial orders always routed to human review panel

#### Dashboard (Frontend)
- Three-tab dashboard: Pendente, Concluidos, Auto
- Role-based filtering of orders per tab
- Pedido cards with stock details, suggestion badge, and approve action
- Concluido cards showing decision, operator, and timestamp
- Mobile-first responsive layout (max-w-3xl centered)

#### Authentication & Authorization
- PIN-based login (4 digits) via `siso_usuarios` table
- Four roles: `admin`, `operador_cwb`, `operador_sp`, `comprador`
- Role-based visibility:
  - Admin sees all orders and all pages
  - Operador CWB sees CWB orders only
  - Operador SP sees SP orders only
  - Comprador sees only OC-suggested orders
- AuthProvider with localStorage session persistence
- Login page with name + PIN input

#### Admin Pages
- User management CRUD (`/admin/usuarios`) — create, edit role, toggle active, delete
- Settings page (`/configuracoes`) with:
  - Webhook URL display and copy-to-clipboard
  - Tiny ERP OAuth2 credential management per branch
  - OAuth2 authorization flow (Keycloak-based)
  - Deposit (warehouse) selector per branch
  - Links to user management and monitoring

#### Monitoring
- System health dashboard (`/monitoramento`) with auto-refresh (30s)
- Stat cards: orders today, webhooks 24h, avg processing time, errors
- Webhook throughput bar chart (last 12 hours)
- Recent errors list with source, filial, and metadata
- Health status badge (healthy/warning/degraded)

#### Tiny ERP Integration
- OAuth2 Authorization Code flow (Keycloak endpoints)
- Automatic token refresh with 60s buffer before expiry
- API client for: get order, get stock, search product by SKU, list deposits, test connection
- Per-branch connection management with credential masking in UI

#### Infrastructure
- Structured logger writing to both stdout (JSON) and Supabase `siso_logs` table
- Fire-and-forget log persistence (never blocks request handling)
- Supabase migrations for `siso_logs` and `deposito_id`/`deposito_nome` columns
- Service-role Supabase client for server-side operations

#### UI Components
- `Tabs` — pill-style tab bar with counters
- `EmptyState` — centered message for empty lists
- `LoadingSpinner` — consistent loading indicator
- `PedidoCard` — expandable order card with stock table and approve button
- `PedidoCardConcluido` — compact completed order row
- `Providers` — React Query + Sonner toast wrapper

### Technical Notes
- Frontend currently uses mock data (`src/data/mock.ts`) for demonstration
- Real-time Supabase subscription not yet connected to dashboard
- Execution worker (post-approval actions like creating markers in Tiny) not yet implemented
