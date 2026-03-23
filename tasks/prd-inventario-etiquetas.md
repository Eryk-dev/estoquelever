# PRD: Modulos Inventario + Etiquetas de Endereco

## 1. Introduction/Overview

A NetAir atualmente usa uma planilha Google Sheets + Apps Script para inventario fisico (contagem de estoque + atualizacao de localizacao no Tiny ERP) e geracao de etiquetas de endereco ZPL. Esse fluxo usa a API Tiny v2 (legada) com token fixo.

Este PRD cobre a migracao desses dois fluxos para o SISO, aproveitando a infraestrutura ja implementada: API Tiny v3 (OAuth2), rate limiting por empresa, multi-empresa, e PrintNode.

**Prioridade:** Inventario primeiro, Etiquetas depois.

---

## 2. Goals

- Eliminar dependencia do Google Sheets + Apps Script para inventario fisico
- Eliminar uso da API Tiny v2 (token fixo) — tudo via OAuth2 v3
- Permitir inventario fisico com escaneamento de SKU/EAN em qualquer empresa/galpao
- Suportar dois modos de inventario: apenas localizacao (`loc_only`) e localizacao + estoque (`loc_estoque`)
- Gerar e imprimir etiquetas ZPL de endereco (pequena e grande) via PrintNode
- Reusar infraestrutura existente (OAuth2, rate limiter, PrintNode, AppShell)

---

## 3. User Stories

### Modulo 1: Inventario

#### US-001: Criar sessao de inventario
**Description:** As an operador, I want to create an inventory session selecting empresa, galpao, modo, and optionally tipo_estoque, so that I can start scanning items.

**Acceptance Criteria:**
- [ ] Form shows empresa and galpao dropdowns (from existing hierarchy)
- [ ] Modo selector: "Apenas Localizacao" (`loc_only`) or "Localizacao + Estoque" (`loc_estoque`)
- [ ] When `loc_estoque`, tipo_estoque is required (B=Balanco, E=Entrada, S=Saida)
- [ ] When `loc_only`, tipo_estoque field is hidden/disabled
- [ ] Optional observacoes text field
- [ ] Only one `em_andamento` inventario per empresa at a time (API returns 409 if violated)
- [ ] On success, navigates to scan interface
- [ ] All roles can access the module

#### US-002: Escanear itens no inventario
**Description:** As an operador, I want to scan SKUs/EANs while setting the current location, so that items are collected with their physical position.

**Acceptance Criteria:**
- [ ] Sticky location input at the top (persists across scans)
- [ ] SKU input auto-focuses after each scan
- [ ] On scan: POST /coletar searches Tiny by SKU first, then by EAN (GTIN) if not found
- [ ] Found product: appears in list with nome, SKU, EAN, localizacao, quantidade (default 1)
- [ ] Not found: toast error "Produto nao encontrado" (404)
- [ ] Quantidade is editable after scan
- [ ] Audio feedback on successful scan (reuse audio-feedback.ts)
- [ ] Items list shows most recent first
- [ ] Can delete individual items (DELETE endpoint)
- [ ] Counter shows total items scanned

#### US-003: Processar inventario
**Description:** As an operador, I want to process all scanned items in batch, sending location updates (and optionally stock adjustments) to Tiny ERP.

**Acceptance Criteria:**
- [ ] "Processar" button triggers fire-and-forget POST /processar
- [ ] UI transitions to progress view immediately
- [ ] Progress view polls /progresso every 2s
- [ ] Shows progress bar (itens_processados / total consolidado)
- [ ] Shows per-item status (pendente/processando/sucesso/erro) with error messages
- [ ] Items are consolidated: grouped by SKU, quantities summed, locations merged with "; "
- [ ] For `loc_estoque`: calls movimentarEstoque + atualizarLocalizacaoProduto per product
- [ ] For `loc_only`: calls only atualizarLocalizacaoProduto per product
- [ ] Kits (type K): skip stock movement, only update location
- [ ] Partial failures don't block other items — each item has independent status
- [ ] On completion: status → `concluido`, shows summary (sucesso/erro counts)
- [ ] If tab is closed, processing continues server-side; operator can return to see progress

#### US-004: Listar e gerenciar inventarios
**Description:** As an operador, I want to see my inventory sessions (active and completed) so that I can resume work or review past inventories.

**Acceptance Criteria:**
- [ ] Two tabs: "Em Andamento" and "Concluidos"
- [ ] Em Andamento shows active inventarios with empresa, galpao, usuario, modo, total itens, data
- [ ] Concluidos shows finished inventarios with success/error counts
- [ ] Can cancel an `em_andamento` inventario (PATCH status → cancelado)
- [ ] Can click an active inventario to resume scanning
- [ ] Can click a `processando` inventario to see progress

#### US-005: Deposito nao configurado
**Description:** As an operador, I want a clear error if the empresa has no deposito configured, so that I know to fix configuration before processing.

**Acceptance Criteria:**
- [ ] On POST /processar, if empresa has no deposito_id in siso_tiny_connections, return 400 with message
- [ ] Frontend shows toast: "Deposito nao configurado para esta empresa"

### Modulo 2: Etiquetas de Endereco

#### US-006: Gerar preview de enderecos
**Description:** As an operador, I want to define address ranges and see a preview of all generated addresses before printing.

**Acceptance Criteria:**
- [ ] Form with 3 range pairs: corredor (inicio/fim), horizontal (inicio/fim), vertical (inicio/fim)
- [ ] Supports numeric ranges (1-5), alpha ranges (A-E), and mixed
- [ ] Address format: `{corredor}-{horizontal}-{vertical}` (e.g., C-01-1)
- [ ] Preview shows all generated addresses as badges with total count
- [ ] Validation: start must be <= end (400 if invalid)

#### US-007: Imprimir etiquetas de endereco
**Description:** As an operador, I want to print address labels in two sizes (pequena and grande) on my configured thermal printer.

**Acceptance Criteria:**
- [ ] Two tabs: "Pequena" and "Grande"
- [ ] Pequena: 2 addresses per label, with text + Code128 barcode + QR code
- [ ] Grande: 1 address per label, rotated 90deg (^FWR), 250pt font
- [ ] Prints to user's configured PrintNode printer (from siso_usuarios)
- [ ] Warning if generating 1000+ labels before printing
- [ ] Toast confirmation on print job sent

---

## 4. Functional Requirements

### Inventario

- **FR-1:** The system must create `siso_inventarios` and `siso_inventario_itens` tables per the schema defined below.
- **FR-2:** The system must enforce max one `em_andamento` inventario per empresa (API-level check, return 409).
- **FR-3:** POST /coletar must search Tiny by SKU first (`buscarProdutoPorSku`), then by EAN/GTIN (`buscarProdutoPorGtin`) if not found.
- **FR-4:** `buscarProdutoPorGtin` is a new function in tiny-api.ts: `GET /produtos?gtin={gtin}&situacao=A`.
- **FR-5:** POST /processar must consolidate items (group by SKU, sum quantities, merge unique locations with "; ") before sending to Tiny.
- **FR-6:** Processing must use `runWithEmpresa` for automatic rate limiting.
- **FR-7:** Processing must fetch `deposito_id` from `siso_tiny_connections` for the empresa. Return 400 if not configured.
- **FR-8:** For `loc_estoque` mode: call `movimentarEstoque(token, produtoId, {tipo, quantidade, deposito: {id}})` then `atualizarLocalizacaoProduto`.
- **FR-9:** For `loc_only` mode: call only `atualizarLocalizacaoProduto`.
- **FR-10:** Kit products (type K): skip stock movement, only update location.
- **FR-11:** Each item's status is updated independently (sucesso/erro with erro_msg). Parent inventario counters are updated atomically.
- **FR-12:** GET /progresso returns current counters + per-item status for poll-based progress tracking.
- **FR-13:** All API routes require authenticated session via `getSessionUser()`.
- **FR-14:** All roles (admin, operador_cwb, operador_sp, comprador) can access inventario.

### Etiquetas

- **FR-15:** Address generation supports numeric, alphabetic, and mixed corridor ranges.
- **FR-16:** Address format is always `{corredor}-{horizontal}-{vertical}`.
- **FR-17:** POST /preview returns the list of generated addresses without printing.
- **FR-18:** POST /imprimir generates ZPL and sends to the user's configured PrintNode printer.
- **FR-19:** Pequena labels: 2 addresses per label with text, Code128 barcode, and QR code.
- **FR-20:** Grande labels: 1 address per label, 90deg rotation (^FWR), 250pt font.
- **FR-21:** Validation: start > end returns 400. Labels > 1000 returns warning flag in preview response.

---

## 5. Non-Goals (Out of Scope)

- Realtime updates via Supabase Realtime (polling is sufficient for batch processing)
- Inventory reconciliation / discrepancy reports (future enhancement)
- Multi-deposito support per empresa (uses single configured deposito)
- Automatic scheduling of inventories
- Barcode printing for individual products (only address labels)
- Editing already-processed inventarios
- Stock adjustment history/audit trail within the inventario module (Tiny handles this)
- Mobile-native app (web mobile-first is sufficient)

---

## 6. Technical Considerations

### Database

**Migration:** `supabase/migrations/20260320_modulo_inventario.sql`

```sql
CREATE TABLE siso_inventarios (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id         uuid NOT NULL REFERENCES siso_galpoes(id),
  usuario_id        uuid NOT NULL REFERENCES siso_usuarios(id),
  modo              text NOT NULL CHECK (modo IN ('loc_only', 'loc_estoque')),
  tipo_estoque      text CHECK (tipo_estoque IN ('B', 'E', 'S')),
  status            text NOT NULL DEFAULT 'em_andamento'
                    CHECK (status IN ('em_andamento', 'processando', 'concluido', 'cancelado')),
  total_itens       int NOT NULL DEFAULT 0,
  itens_processados int NOT NULL DEFAULT 0,
  itens_sucesso     int NOT NULL DEFAULT 0,
  itens_erro        int NOT NULL DEFAULT 0,
  observacoes       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  processado_em     timestamptz,
  concluido_em      timestamptz
);

CREATE TABLE siso_inventario_itens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventario_id   uuid NOT NULL REFERENCES siso_inventarios(id) ON DELETE CASCADE,
  produto_id_tiny int,
  sku             text NOT NULL,
  nome_produto    text,
  ean             text,
  localizacao     text NOT NULL,
  quantidade      int NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente', 'processando', 'sucesso', 'erro')),
  erro_msg        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventarios_status ON siso_inventarios(status);
CREATE INDEX idx_inventarios_empresa ON siso_inventarios(empresa_id);
CREATE INDEX idx_inventario_itens_inv ON siso_inventario_itens(inventario_id);
```

### Types (add to `src/types/index.ts`)

```typescript
export type InventarioModo = "loc_only" | "loc_estoque";
export type TipoEstoque = "B" | "E" | "S";
export type InventarioStatus = "em_andamento" | "processando" | "concluido" | "cancelado";
export type InventarioItemStatus = "pendente" | "processando" | "sucesso" | "erro";

export interface Inventario {
  id: string;
  empresa_id: string;
  galpao_id: string;
  usuario_id: string;
  modo: InventarioModo;
  tipo_estoque: TipoEstoque | null;
  status: InventarioStatus;
  total_itens: number;
  itens_processados: number;
  itens_sucesso: number;
  itens_erro: number;
  observacoes: string | null;
  created_at: string;
  processado_em: string | null;
  concluido_em: string | null;
  // Joined fields
  empresa_nome?: string;
  galpao_nome?: string;
  usuario_nome?: string;
}

export interface InventarioItem {
  id: string;
  inventario_id: string;
  produto_id_tiny: number | null;
  sku: string;
  nome_produto: string | null;
  ean: string | null;
  localizacao: string;
  quantidade: number;
  status: InventarioItemStatus;
  erro_msg: string | null;
  created_at: string;
}

export interface InventarioItemConsolidado {
  sku: string;
  produto_id_tiny: number;
  nome_produto: string;
  ean: string | null;
  localizacao_merged: string; // unique locations joined with "; "
  quantidade_total: number;
  itens_ids: string[]; // original item IDs for status tracking
  status: InventarioItemStatus;
  erro_msg: string | null;
}
```

### API Routes

| Method | Route | Function |
|---|---|---|
| GET | `/api/inventario` | List inventarios + counts by status |
| POST | `/api/inventario` | Create session (empresa_id, galpao_id, modo, tipo_estoque) |
| GET | `/api/inventario/[id]` | Detail with items + consolidated view |
| PATCH | `/api/inventario/[id]` | Cancel or update observacoes |
| POST | `/api/inventario/[id]/coletar` | Scan item: search Tiny by SKU/EAN, insert |
| DELETE | `/api/inventario/[id]/itens/[itemId]` | Remove scanned item |
| POST | `/api/inventario/[id]/processar` | Fire-and-forget: consolidate and send to Tiny |
| GET | `/api/inventario/[id]/progresso` | Poll progress (counters + per-item status) |
| POST | `/api/etiquetas/preview` | Generate address list for preview |
| POST | `/api/etiquetas/imprimir` | Generate ZPL + send to PrintNode |

### Existing code to reuse

| What | Where | For |
|---|---|---|
| `getValidTokenByEmpresa` | tiny-oauth.ts | OAuth2 token per empresa |
| `runWithEmpresa` | tiny-queue.ts | Automatic rate limiting |
| `buscarProdutoPorSku` | tiny-api.ts | Product search on scan |
| `movimentarEstoque` | tiny-api.ts | Stock adjustment B/E/S |
| `atualizarLocalizacaoProduto` | tiny-api.ts | Update location |
| `enviarImpressaoZpl` | printnode.ts | Print ZPL |
| `resolverImpressora` | printnode.ts | Resolve user/galpao printer |
| `getConfig("PRINTNODE_API_KEY")` | config.ts | PrintNode key |
| `AppShell, Tabs, EmptyState` | components/ui/ | Layout |
| `audio-feedback.ts` | components/separacao/ | Audio feedback on scan |
| `getSessionUser` | session.ts | Auth in API routes |
| `logger` | logger.ts | Structured logging |

### Performance

- Processing cost: 2-3 API calls per consolidated product (GET product + PUT location + POST stock)
- At ~55 req/min rate limit, 500 products takes ~27 min
- Acceptable for batch operation — fire-and-forget + poll pattern handles this

### New files (19 total)

```
supabase/migrations/20260320_modulo_inventario.sql
src/lib/inventario-processor.ts
src/lib/zpl-endereco.ts
src/app/inventario/page.tsx
src/app/etiquetas/page.tsx
src/app/api/inventario/route.ts
src/app/api/inventario/[id]/route.ts
src/app/api/inventario/[id]/coletar/route.ts
src/app/api/inventario/[id]/itens/[itemId]/route.ts
src/app/api/inventario/[id]/processar/route.ts
src/app/api/inventario/[id]/progresso/route.ts
src/app/api/etiquetas/preview/route.ts
src/app/api/etiquetas/imprimir/route.ts
src/components/inventario/criar-inventario-form.tsx
src/components/inventario/scan-inventario.tsx
src/components/inventario/inventario-card.tsx
src/components/inventario/progresso-processamento.tsx
src/components/etiquetas/etiqueta-form.tsx
src/components/etiquetas/endereco-preview.tsx
```

### Modified files

| File | Change |
|---|---|
| `src/types/index.ts` | Add Inventario + Etiqueta types |
| `src/lib/tiny-api.ts` | Add `buscarProdutoPorGtin` |
| `src/app/page.tsx` | Add 2 module cards (Inventario + Etiquetas) |
| `src/app/api/dashboard/counts/route.ts` | Add active inventario count |
| `docs/api-reference.md` | Document all new routes |
| `CLAUDE.md` | Update project structure |

### Edge Cases

- **Product not found:** 404 on /coletar — operator sees clear message
- **Rate limit:** runWithEmpresa + tinyQueue handle automatically
- **Partial failure:** Items marked as `erro` with message, inventario still completes
- **PUT /produtos requires descricao:** `atualizarLocalizacaoProduto` already handles (2 calls)
- **Deposito not configured:** Clear error "Deposito nao configurado para esta empresa"
- **Kit product (type K):** Skip stock movement, only update location
- **Large inventory (500+ items):** ~27min processing — fire-and-forget + poll works
- **Tab closed during processing:** Processing runs server-side, operator can return
- **Invalid range (etiquetas):** Validate before generating (start > end = 400)
- **Too many labels (1000+):** Warning flag in preview response

---

## 7. Success Metrics

- Inventario module fully replaces Google Sheets + Apps Script workflow
- Zero usage of Tiny API v2 (legacy token) after migration
- Operators can complete inventory of 500 items with progress tracking
- Etiqueta generation + printing works for all address format combinations
- `npm run build` passes with zero errors after implementation

---

## 8. Implementation Order

| Phase | Description | Steps |
|---|---|---|
| 1 | Foundation (DB + Types + API ext) | Migration SQL, types in index.ts, buscarProdutoPorGtin |
| 2 | Backend Inventario | inventario-processor.ts, CRUD routes, coletar/processar/progresso |
| 3 | Frontend Inventario | Components (form, scan, card, progress), page, dashboard card |
| 4 | Backend Etiquetas | zpl-endereco.ts, preview + imprimir routes |
| 5 | Frontend Etiquetas | Components (form, preview), page, dashboard card |
| 6 | Documentation | api-reference.md, CLAUDE.md |

---

## 9. Verification

1. Criar inventario -> verificar registro em siso_inventarios
2. Escanear 3-5 SKUs validos -> verificar itens no DB + resposta com nome/ean
3. Escanear SKU invalido -> verificar 404
4. Processar -> verificar progresso via poll + status dos itens
5. Verificar no Tiny: localizacao atualizada + saldo correto
6. Etiquetas: preview de enderecos -> print -> verificar impressao na termica
7. `npm run build` sem erros

---

## 10. Open Questions

- None — spec is fully defined. Implementation can proceed.
