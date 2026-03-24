# SISO API Reference

> **Source of truth** for every API route. LLMs and developers MUST consult this before modifying any route.
> When you change a route, **update this file in the same commit**.

Base URL: `http(s)://<host>/api`

All routes are Next.js App Router handlers (`route.ts` with named `GET`/`POST`/`PUT`/`DELETE`/`PATCH` exports).
DB access via `createServiceClient()` (Supabase service role). Logging via `logger.*`.

---

## Table of Contents

- [Auth](#auth)
- [Webhook](#webhook)
- [Pedidos](#pedidos)
- [Separacao](#separacao)
- [Compras](#compras)
- [Worker](#worker)
- [Reconciliação](#reconciliação)
- [Dashboard & Monitoring](#dashboard--monitoring)
- [Admin - Usuarios](#admin---usuarios)
- [Admin - Galpoes](#admin---galpoes)
- [Admin - Empresas](#admin---empresas)
- [Admin - Grupos](#admin---grupos)
- [Admin - PrintNode](#admin---printnode)
- [Tiny ERP](#tiny-erp)
- [Inventário](#inventário)
- [Transferência](#transferência)
- [Etiquetas de Endereço](#etiquetas-de-endereço)

---

## Auth

### `POST /api/auth/login`

**File:** `src/app/api/auth/login/route.ts`
**Auth:** None (public)

Authenticates a user by name + PIN. Creates a server-side session.

**Request Body:**
```json
{ "nome": "Eryk", "pin": "1234" }
```

**Response 200:**
```json
{
  "ok": true,
  "usuario": { "id": "uuid", "nome": "Eryk", "cargo": "admin", "cargos": ["admin"] },
  "sessionId": "uuid"
}
```

**Errors:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ ok: false, erro: "JSON invalido" }` | Malformed JSON |
| 400 | `{ ok: false, erro: "Nome e PIN sao obrigatorios" }` | Missing fields |
| 401 | `{ ok: false, erro: "Usuario nao encontrado" }` | No user with that name |
| 401 | `{ ok: false, erro: "PIN incorreto" }` | Wrong PIN |
| 403 | `{ ok: false, erro: "Usuario desativado" }` | User is inactive |

**Notes:**
- Session ID is returned in body (client stores in localStorage as `siso_user`)
- Client sends `X-Session-Id` header on subsequent requests
- `cargos` array is always populated (backward compat: falls back to `[cargo]`)

---

## Webhook

### `POST /api/webhook/tiny`

**File:** `src/app/api/webhook/tiny/route.ts`
**Auth:** None (called by Tiny ERP)

Receives webhooks from Tiny ERP. Handles two types: `pedido` (order) and `nota_fiscal` (invoice).

**Request Body (from Tiny):**
```json
{
  "tipo": "atualizacao_pedido" | "inclusao_pedido" | "nota_fiscal",
  "cnpj": "34857388000163",
  "dados": {
    "id": "123456",
    "codigoSituacao": "aprovado" | "cancelado",
    "idNotaFiscalTiny": 999  // only for nota_fiscal
  }
}
```

**Flow:**
1. Validates `tipo`, `cnpj`, `dados`
2. Resolves empresa by CNPJ via `getEmpresaByCnpj()`
3. **nota_fiscal** -> fires `handleNfWebhook()` async, returns `{ status: "queued", tipo: "nota_fiscal" }`
4. **pedido (aprovado)** -> dedup via `siso_webhook_logs` unique constraint, fires `processWebhook()` async
5. **pedido (cancelado)** -> cancels order + cleans up compra flow if active

**Response 200 (approved order):**
```json
{
  "status": "queued",
  "pedidoId": "123456",
  "empresaId": "uuid",
  "galpao": "CWB",
  "webhookLogId": "uuid"
}
```

**Response 200 (duplicate):**
```json
{ "status": "duplicate", "pedidoId": "123456" }
```

**Response 200 (cancelled):**
```json
{ "status": "cancelled", "pedidoId": "123456", "previousStatus": "pendente" }
```

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Invalid JSON, missing fields, unknown CNPJ, unsupported tipo/situacao |
| 500 | DB insert failure |

**Business Logic (cancellation):**
- Sets `status: "cancelado"` and `status_separacao: "cancelado"`
- Cancels pending execution queue entries
- If order was in compra flow (`aguardando_compra`/`comprado`): clears compra fields, cancels empty OCs
- Warns if items had stock already entered in Tiny (`compra_estoque_lancado_alerta: true`)

### `GET /api/webhook/tiny`

Health check. Returns `{ status: "ok", service: "SISO Webhook Receiver" }`.

---

### `POST /api/webhook/reprocessar`

**File:** `src/app/api/webhook/reprocessar/route.ts`
**Auth:** None

Reprocesses all failed/pending webhook logs (status = `pendente`, situacao = `aprovado`).

**Request Body:** None

**Response 200:**
```json
{
  "reprocessed": 3,
  "results": [
    { "pedidoId": "123", "status": "ok" },
    { "pedidoId": "456", "status": "erro", "erro": "..." }
  ]
}
```

---

## Pedidos

### `GET /api/pedidos`

**File:** `src/app/api/pedidos/route.ts`
**Auth:** None (service)

Returns orders with items and normalized stock per galpao.

**Query Params:**
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Comma-separated status filter (e.g. `pendente,executando`) |

**Response 200:** Array of:
```json
{
  "id": "tiny_pedido_id",
  "numero": "12345",
  "data": "2026-03-17",
  "filialOrigem": "CWB",
  "empresaOrigemId": "uuid",
  "empresaOrigemNome": "NetAir",
  "idPedidoEcommerce": "MLB-12345",
  "nomeEcommerce": "Mercado Livre",
  "cliente": { "nome": "Joao", "cpfCnpj": "123.456.789-00" },
  "formaEnvio": { "id": "me2", "descricao": "Mercado Envios" },
  "itens": [{
    "produtoId": 999,
    "sku": "19ABC",
    "descricao": "Filtro de oleo",
    "quantidadePedida": 2,
    "estoques": {
      "CWB": {
        "deposito": { "id": 1, "nome": "Principal", "saldo": 10, "reservado": 2, "disponivel": 8 },
        "atende": true,
        "localizacao": "A1-03"
      },
      "SP": { ... }
    },
    "fornecedorOC": "ACA",
    "imagemUrl": "https://..."
  }],
  "sugestao": "propria",
  "sugestaoMotivo": "Estoque proprio atende",
  "status": "pendente",
  "tipoResolucao": "auto" | "manual",
  "decisaoFinal": "propria" | "transferencia" | "oc",
  "operador": "Eryk",
  "processadoEm": "2026-03-17T...",
  "marcadores": ["CWB"],
  "erro": null,
  "criadoEm": "2026-03-17T..."
}
```

**Notes:**
- Limit 200 orders
- Stock is a dynamic `Record<string, GalpaoEstoque>` keyed by galpao name
- Stock aggregates across all empresas in the same galpao

---

### `POST /api/pedidos/aprovar`

**File:** `src/app/api/pedidos/aprovar/route.ts`
**Auth:** None (operator context in body)

Approves a pending order with a decision.

**Request Body:**
```json
{
  "pedidoId": "123456",
  "decisao": "propria" | "transferencia" | "oc",
  "operadorId": "uuid",
  "operadorNome": "Eryk"
}
```

**Response 200:**
```json
{
  "ok": true,
  "pedidoId": "123456",
  "decisao": "propria",
  "filialExecucao": "CWB",
  "empresaExecucaoId": "uuid",
  "status": "executando"
}
```

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Missing fields, invalid decisao |
| 404 | Pedido not found, empresa not found |
| 409 | Pedido not in `pendente` status |
| 422 | Pedido missing `empresa_origem_id` |

**Business Logic:**
- `propria`/`oc` -> execution empresa = origin empresa
- `transferencia` -> finds support empresa in different galpao within grupo
- Sets `status: "executando"`, enqueues `siso_fila_execucao` job
- `oc` decision -> `status_separacao: null` (enters compra flow instead)
- Non-`oc` -> `status_separacao: "aguardando_nf"`
- Kicks worker via `after()` (survives response lifecycle)

---

### `GET /api/pedidos/[id]/historico`

**File:** `src/app/api/pedidos/[id]/historico/route.ts`
**Auth:** None

Returns audit trail for an order.

**Response 200:**
```json
{
  "historico": [{
    "id": "uuid",
    "evento": "aprovado",
    "usuario_id": "uuid",
    "usuario_nome": "Eryk",
    "detalhes": { "decisao": "propria" },
    "criado_em": "2026-03-17T..."
  }]
}
```

---

### `GET /api/pedidos/[id]/observacoes`

**File:** `src/app/api/pedidos/[id]/observacoes/route.ts`
**Auth:** None

Returns observations/comments for an order.

**Response 200:** Array of:
```json
{
  "id": "uuid",
  "pedidoId": "123",
  "usuarioId": "uuid",
  "usuarioNome": "Eryk",
  "texto": "Verificar estoque",
  "criadoEm": "2026-03-17T..."
}
```

### `POST /api/pedidos/[id]/observacoes`

Creates a new observation.

**Request Body:**
```json
{ "usuarioId": "uuid", "usuarioNome": "Eryk", "texto": "Verificar estoque" }
```

**Response 200:** Same shape as GET item.

---

## Separacao

### `GET /api/separacao`

**File:** `src/app/api/separacao/route.ts`
**Auth:** Role-based via `X-User-Cargo` header

Lists orders in separation pipeline with counts.

**Headers:**
| Header | Description |
|--------|-------------|
| `X-User-Cargo` | Comma-separated cargos (e.g. `operador_cwb` or `admin`). Controls galpao filtering. |

**Query Params:**
| Param | Type | Description |
|-------|------|-------------|
| `status_separacao` | string | Filter: `aguardando_compra`, `aguardando_nf`, `aguardando_separacao`, `em_separacao`, `separado`, `embalado`, `cancelado` |
| `empresa_origem_id` | string | Filter by origin empresa |
| `sort` | string | `data_pedido` (default), `localizacao`, `sku` |
| `busca` | string | Search in numero, id_pedido_ecommerce, cliente_nome |
| `marketplace` | string | Filter by e-commerce name (ilike) |
| `tag` | string | Filter by separacao_tag (array contains) |

**Response 200:**
```json
{
  "counts": {
    "aguardando_compra": 5,
    "aguardando_nf": 3,
    "aguardando_separacao": 10,
    "em_separacao": 2,
    "separado": 1,
    "embalado": 4
  },
  "pedidos": [{
    "id": "123",
    "numero_nf": "12345",
    "numero_ec": "MLB-999",
    "numero_pedido": "12345",
    "cliente": "Joao Silva",
    "forma_envio": "Mercado Envios",
    "data_pedido": "2026-03-17",
    "empresa_origem_nome": "NetAir",
    "galpao_id": "uuid",
    "status_separacao": "aguardando_separacao",
    "marcadores": ["CWB"],
    "total_itens": 3,
    "itens_marcados": 1,
    "itens_bipados": 0,
    "compra_stats": null,
    "etiqueta_status": null,
    "etiqueta_pronta": false,
    "separacao_tags": ["urgente"]
  }],
  "empresas": [{ "id": "uuid", "nome": "NetAir" }]
}
```

**Role filtering:**
- `admin` -> sees all
- `operador_cwb` -> sees only pedidos where empresa's galpao = CWB
- `operador_sp` -> sees only pedidos where empresa's galpao = SP

---

### `GET /api/separacao/tags`

**File:** `src/app/api/separacao/tags/route.ts`
**Auth:** `X-Session-Id` (validates session via `getSessionUser`)

Returns all unique user-created tags (`separacao_tags`) across pedidos in the separation pipeline. Used for tag filter dropdown and autocomplete.

**Response 200:**
```json
{
  "tags": ["urgente", "conferir", "especial"]
}
```

**Galpão filtering:** Non-admin users only see tags from their active galpão.

---

### `POST /api/separacao/tags`

**File:** `src/app/api/separacao/tags/route.ts`
**Auth:** `X-Session-Id` (validates session via `getSessionUser`)

Add, remove, or replace tags on pedidos. Tags are stored in `siso_pedidos.separacao_tags` (separate from Tiny `marcadores`).

**Request Body:**
```json
{
  "pedido_ids": ["uuid-1", "uuid-2"],
  "tags": ["urgente"],
  "action": "add"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pedido_ids` | string[] | Target pedido IDs |
| `tags` | string[] | Tags to add/remove/set |
| `action` | string | `add` (append, dedup), `remove`, or `set` (replace all) |

**Response 200:**
```json
{
  "ok": true,
  "action": "add",
  "tags": ["urgente"],
  "total": 2
}
```

Tags are sanitized: trimmed, lowercased, max 50 chars, empty strings removed.

---

### `POST /api/separacao/iniciar`

**File:** `src/app/api/separacao/iniciar/route.ts`
**Auth:** `X-Session-Id` (validates session via `getSessionUser`)

Starts wave picking for selected orders.

**Request Body:**
```json
{ "pedido_ids": ["id1", "id2"], "operador_id": "uuid" }
```

**Response 200:**
```json
{
  "pedido_ids": ["id1", "id2"],
  "produtos": [{
    "produto_id": "999",
    "descricao": "Filtro de oleo",
    "sku": "19ABC",
    "gtin": "7891234567890",
    "quantidade_total": 5,
    "unidade": "UN",
    "localizacao": "A1-03"
  }]
}
```

**Business Logic:**
- Validates all pedidos are `aguardando_separacao` or `em_separacao`
- Moves `aguardando_separacao` -> `em_separacao`
- Calls RPC `siso_consolidar_produtos_separacao` for wave picking list
- Fire-and-forget: pre-creates Tiny agrupamentos + downloads ZPL labels

---

### `POST /api/separacao/bipar`

**File:** `src/app/api/separacao/bipar/route.ts`
**Auth:** `X-Session-Id` (session + galpao required, admin blocked)

Processes barcode scan during individual item picking.

**Request Body:**
```json
{ "codigo": "7891234567890" }
```

**Response 200 (partial):**
```json
{
  "status": "parcial",
  "pedido_id": "123",
  "pedido_numero": 12345,
  "produto_id": 999,
  "sku": "19ABC",
  "bipados": 1,
  "total": 3,
  "itens_faltam": 2
}
```

**Response 200 (item complete):**
```json
{ "status": "item_completo", "pedido_id": "123", "pedido_numero": 12345, "produto_id": 999, "sku": "19ABC", "itens_faltam": 1 }
```

**Response 200 (pedido complete):**
```json
{ "status": "pedido_completo", "pedido_id": "123", "pedido_numero": 12345, "etiqueta_status": "impresso", "etiqueta_erro": null }
```

**Errors:**
| Status | Error code | Cause |
|--------|------------|-------|
| 401 | `sessao_invalida` | Invalid session |
| 403 | - | Admin cannot bip |
| 404 | `item_nao_encontrado` | Barcode not in active orders |
| 409 | `item_ja_completo` | Item already fully scanned |
| 429 | `rate_limit` | Max 2 bips/second per session |

**Notes:**
- Calls PL/pgSQL `siso_processar_bip` atomically
- On `pedido_completo`: triggers label printing via `buscarEImprimirEtiqueta`

---

### `POST /api/separacao/bipar-checklist`

**File:** `src/app/api/separacao/bipar-checklist/route.ts`
**Auth:** None

Scan during wave-picking to auto-check matching items across pedidos.

**Request Body:**
```json
{ "sku": "19ABC", "pedido_ids": ["id1", "id2"] }
```

**Response 200:** Array of updated `siso_pedido_itens` rows.

**Notes:** Tries SKU match first, falls back to GTIN match.

---

### `POST /api/separacao/marcar-item`

**File:** `src/app/api/separacao/marcar-item/route.ts`
**Auth:** None

Toggle item checkbox during wave-picking.

**Request Body:**
```json
{ "pedido_item_id": "uuid", "marcado": true }
```

**Response 200:** Updated item row.

**Validation:** Parent pedido must be `em_separacao` or `aguardando_separacao`.

---

### `POST /api/separacao/desfazer-bip`

**File:** `src/app/api/separacao/desfazer-bip/route.ts`
**Auth:** `X-Session-Id` (session + galpao required)

Undo a barcode scan. Decrements `quantidade_bipada` by 1.

**Request Body:**
```json
{ "pedido_id": "123", "produto_id": 999 }
```

**Response 200:**
```json
{
  "pedido_id": "123",
  "produto_id": 999,
  "quantidade_bipada": 2,
  "bipado_completo": false,
  "status_separacao": "em_separacao"
}
```

**Business Logic:**
- If pedido was `embalado` -> reverts to `em_separacao`, clears etiqueta data
- If all bips become 0 -> reverts to `aguardando_separacao`

---

### `POST /api/separacao/concluir`

**File:** `src/app/api/separacao/concluir/route.ts`
**Auth:** None

Finishes separation. Only moves pedidos where ALL items are `separacao_marcado = true`.

**Request Body:**
```json
{ "pedido_ids": ["id1", "id2"] }
```

**Response 200:**
```json
{ "separados": ["id1"], "pendentes": ["id2"] }
```

**Notes:** Fire-and-forget creates agrupamentos + reloads missing ZPL labels.

---

### `POST /api/separacao/bipar-embalagem`

**File:** `src/app/api/separacao/bipar-embalagem/route.ts`
**Auth:** None

Barcode scan during packing phase.

**Request Body:**
```json
{ "sku": "19ABC", "galpao_id": "uuid", "quantidade": 1 }
```

**Response 200:**
```json
{
  "pedido_id": "123",
  "produto_id": 999,
  "quantidade_bipada": 2,
  "bipado_completo": true,
  "pedido_completo": true,
  "etiqueta_status": "impresso",
  "etiqueta_erro": null
}
```

**Notes:**
- Calls PL/pgSQL `siso_processar_bip_embalagem` atomically
- Finds oldest `separado`-status order with matching SKU
- On `pedido_completo`: uses fast path (direct ZPL print) or slow path (full agrupamento flow)

---

### `POST /api/separacao/confirmar-item-embalagem`

**File:** `src/app/api/separacao/confirmar-item-embalagem/route.ts`
**Auth:** None

Manual +/- quantity during packing (alternative to barcode scanning).

**Request Body:**
```json
{ "pedido_item_id": "uuid", "quantidade": 1 }
```

**Response 200:**
```json
{
  "pedido_item_id": "uuid",
  "quantidade_bipada": 3,
  "bipado_completo": true,
  "pedido_completo": true,
  "etiqueta_status": "impresso",
  "etiqueta_erro": null
}
```

**Validation:** Parent pedido must be `separado`.

---

### `POST /api/separacao/expedir`

**File:** `src/app/api/separacao/expedir/route.ts`
**Auth:** `X-Session-Id` (session + galpao required)

Mark packed orders as shipped.

**Request Body:**
```json
{ "pedido_ids": ["id1", "id2"] }
```

**Response 200:**
```json
{ "updated": 2 }
```

**Validation:**
- All pedidos must be `embalado`
- All pedidos must belong to operator's galpao

---

### `GET /api/separacao/checklist-items`

**File:** `src/app/api/separacao/checklist-items/route.ts`
**Auth:** None

Fetch items for wave-picking checklist with stock and location data.

**Query Params:**
| Param | Type | Description |
|-------|------|-------------|
| `pedidos` | string | Comma-separated pedido IDs |

**Response 200:**
```json
{
  "items": [{
    "id": "uuid",
    "pedido_id": "123",
    "produto_id": 999,
    "sku": "19ABC",
    "gtin": "7891234567890",
    "descricao": "Filtro de oleo",
    "quantidade": 2,
    "separacao_marcado": false,
    "separacao_marcado_em": null,
    "quantidade_bipada": 0,
    "bipado_completo": false,
    "imagem_url": "https://...",
    "localizacao": "A1-03",
    "saldo": 10,
    "disponivel": 8,
    "empresa_origem_id": "uuid",
    "galpao_nome": "CWB"
  }]
}
```

**Notes:** While a pedido is still in `aguardando_compra`, excludes items currently in purchase flow. After release back to separacao, received purchase items are included again. Location comes from origin empresa's stock.

---

### `POST /api/separacao/cancelar`

**File:** `src/app/api/separacao/cancelar/route.ts`
**Auth:** None

Cancel in-progress separation. Resets all item checkmarks.

**Request Body:**
```json
{ "pedido_ids": ["id1", "id2"] }
```

**Response 200:**
```json
{ "ok": true, "pedido_ids": ["id1", "id2"] }
```

**Effect:** Items `separacao_marcado = false`, pedidos -> `aguardando_separacao`.

---

### `POST /api/separacao/reiniciar`

**File:** `src/app/api/separacao/reiniciar/route.ts`
**Auth:** None

Reset progress for a specific stage.

**Request Body:**
```json
{ "pedido_ids": ["id1"], "etapa": "separacao" | "embalagem" }
```

**Response 200:**
```json
{ "ok": true, "pedido_ids": ["id1"], "etapa": "separacao" }
```

**Validation:**
- `separacao` -> pedidos must be `em_separacao`, resets `separacao_marcado`
- `embalagem` -> pedidos must be `separado`, resets `quantidade_bipada`/`bipado_completo`

---

### `POST /api/separacao/voltar-etapa`

**File:** `src/app/api/separacao/voltar-etapa/route.ts`
**Auth:** `X-Session-Id` (admin only)

Move pedidos to ANY separation stage (forward or backward).

**Request Body:**
```json
{
  "pedido_ids": ["id1", "id2"],
  "novo_status": "aguardando_nf" | "aguardando_separacao" | "em_separacao" | "separado" | "embalado"
}
```

Also accepts legacy `{ "pedido_id": "single_id" }`.

**Response 200:**
```json
{ "ok": true, "pedidos_atualizados": ["id1"], "total": 1, "novo_status": "aguardando_separacao" }
```

**Business Logic:**
- Going **backward**: clears timestamps, resets item-level progress, clears etiqueta data
- Going **forward**: sets timestamps, marks items as picked/packed
- Records `status_revertido` event in history

---

### `POST /api/separacao/produto-esgotado`

**File:** `src/app/api/separacao/produto-esgotado/route.ts`
**Auth:** None

Handle out-of-stock SKU during separation. Three modes:

**Request Body (preview - no `acao`):**
```json
{ "sku": "19ABC" }
```
**Response:** `{ pedidos_afetados, itens_afetados, galpoes_alternativos: [{galpao_id, galpao_nome}] }`

**Request Body (OC mode):**
```json
{ "sku": "19ABC", "acao": "oc" }
```
**Response:** `{ pedidos_afetados, itens_afetados, ordem_compra_id }`

**Request Body (redirect mode):**
```json
{ "sku": "19ABC", "acao": "encaminhar", "galpao_destino_id": "uuid" }
```
**Response:** `{ pedidos_afetados, itens_afetados, galpao_destino_nome }`

**Business Logic:**
- Finds all active pedidos (`aguardando_nf`/`aguardando_separacao`/`em_separacao`) with this SKU
- `oc`: marks items for purchase, creates/reuses OC, moves pedidos to `aguardando_compra`
- `encaminhar`: redirects pedidos to another galpao, resets separation progress

---

### `POST /api/separacao/reimprimir`

**File:** `src/app/api/separacao/reimprimir/route.ts`
**Auth:** `X-Session-Id` (session, galpao checked for non-admin)

Reprint a shipping label.

**Request Body:**
```json
{ "pedido_id": "123" }
```

**Response 200:**
```json
{ "status": "impresso", "jobId": 12345 }
```

**Validation:** Pedido must be `embalado`. Uses cached ZPL (fast) or full Tiny flow (slow fallback).

---

### `POST /api/separacao/forcar-pendente`

**File:** `src/app/api/separacao/forcar-pendente/route.ts`
**Auth:** `X-Session-Id` (admin only)

Force multiple orders from `aguardando_nf` -> `aguardando_separacao`.

**Request Body:**
```json
{ "pedido_ids": ["id1", "id2"] }
```

**Response 200:**
```json
{ "ok": true, "pedidos_atualizados": ["id1", "id2"], "total": 2 }
```

---

### `PATCH /api/separacao/[pedidoId]/forcar-pendente`

**File:** `src/app/api/separacao/[pedidoId]/forcar-pendente/route.ts`
**Auth:** `X-Session-Id` (admin only)

Force a single order from `aguardando_nf` -> `aguardando_separacao`.

**Response 200:**
```json
{ "success": true, "pedido_id": "123" }
```

---

### `POST /api/separacao/localizacao`

**File:** `src/app/api/separacao/localizacao/route.ts`
**Auth:** None

Updates product warehouse location in Tiny ERP and local DB.

**Request Body:**
```json
{ "produto_id": 999, "localizacao": "A1-03", "empresa_id": "uuid" }
```

**Response 200:**
```json
{ "ok": true }
```

**Effect:** Calls `atualizarLocalizacaoProduto` in Tiny API, updates all `siso_pedido_item_estoques` rows.

---

## Compras

### `GET /api/compras`

**File:** `src/app/api/compras/route.ts`
**Auth:** `cargo` query param (admin or comprador)

Returns the buyer operational view for purchase flow, with counts, summary metrics, bottlenecks and the requested tab data.

**Query Params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | `aguardando_compra` | `aguardando_compra`, `comprado`, `excecoes` (`indisponivel` ainda aceito por compatibilidade) |
| `cargo` | string | - | User cargo for auth check |

**Response 200:**
```json
{
  "counts": { "aguardando_compra": 5, "comprado": 2, "indisponivel": 1 },
  "summary": {
    "itens_pendentes": 12,
    "quantidade_pendente": 34,
    "pedidos_bloqueados": 7,
    "empresas_em_compra": 3,
    "ocs_abertas": 2,
    "excecoes": 1,
    "mais_antigo_dias": 4,
    "gargalos_fornecedor": [{ "nome": "ACA", "quantidade": 10, "pedidos": 4 }],
    "gargalos_empresa": [{ "nome": "NetAir", "quantidade": 12, "pedidos": 3 }]
  },
  "data": [...]
}
```

**Data shapes by status:**

**`aguardando_compra`:** Array grouped by supplier (across all empresas):
```json
[{
  "fornecedor": "ACA",
  "galpao_sugerido_id": "uuid | null",
  "galpao_sugerido_nome": "CWB | null",
  "empresas": [{ "id": "uuid", "nome": "NetAir" }],
  "prioridade": "critica",
  "aging_dias": 4,
  "pedidos_bloqueados": 3,
  "quantidade_total": 9,
  "total_skus": 2,
  "rascunho_ocs": 0,
  "itens_em_rascunho": 0,
  "proxima_acao": "Selecionar a rodada ideal e confirmar com o fornecedor",
  "itens": [{
    "sku": "19ABC",
    "descricao": "Filtro",
    "imagem": "https://...",
    "quantidade_total": 5,
    "pedidos_bloqueados": 2,
    "aging_dias": 4,
    "primeira_solicitacao_em": "2026-03-18T12:00:00Z",
    "fornecedor_oc": "ACA",
    "pedidos": [{ "pedido_id": "123", "numero_pedido": "12345", "quantidade": 2 }],
    "itens_ids": ["uuid1", "uuid2"]
  }]
}]
```

Groups are split by `fornecedor` only (items from all empresas for same supplier are grouped together). The `galpao_sugerido_id`/`galpao_sugerido_nome` default comes from `sku-fornecedor.ts` → `filialOC`. `empresas` is an informative array of unique empresas with items in the group. `compra_quantidade_solicitada` is the real quantity to buy. Sorted by priority/aging.

**`comprado`:** Array of OCs with items:
```json
[{
  "id": "uuid",
  "fornecedor": "ACA",
  "galpao_id": "uuid | null",
  "galpao_nome": "CWB | null",
  "status": "comprado",
  "comprado_por_nome": "Eryk",
  "comprado_em": "2026-03-17T...",
  "aging_dias": 2,
  "prioridade": "alta",
  "pedidos_bloqueados": 3,
  "quantidade_total": 12,
  "quantidade_recebida": 5,
  "total_itens": 3,
  "itens_recebidos": 1,
  "proxima_acao": "Conferir recebimento da OC",
  "itens": [{
    "id": "uuid",
    "sku": "19ABC",
    "quantidade": 2,
    "compra_status": "comprado",
    "compra_quantidade_recebida": 0,
    "aging_dias": 2
  }]
}]
```

**`excecoes`:** Flat array of itens com `compra_status` em `indisponivel`, `equivalente_pendente` ou `cancelamento_pendente`.

Cada item de exceção inclui, além dos dados básicos, campos como:
- `compra_status`
- `empresa_nome`
- `aging_dias`
- `prioridade`
- `proxima_acao`
- `compra_equivalente_sku`
- `compra_equivalente_descricao`
- `compra_equivalente_fornecedor`
- `compra_equivalente_observacao`
- `compra_cancelamento_motivo`

---

### `POST /api/compras/ordens`

**File:** `src/app/api/compras/ordens/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Creates an OC and links all aguardando items for that supplier across all empresas, with a specific receiving galpão.

**Request Body:**
```json
{
  "fornecedor": "ACA",
  "galpao_id": "uuid",
  "observacao": "Pedido urgente",
  "usuario_id": "uuid",
  "cargo": "comprador"
}
```

**Response 200:**
```json
{
  "ok": true,
  "ordem_compra": { "id": "uuid", "fornecedor": "ACA", ... },
  "itens_vinculados": 5,
  "quantidade_total": 9
}
```

**Business Logic:** If items already have an auto-created OC, updates it to `comprado` instead of creating new one. Links all items for the requested `fornecedor` regardless of empresa origin. The `galpao_id` determines where the purchase will be received; `empresa_id` is derived from the first active empresa in that galpão (backwards compat). `quantidade_total` is based on `compra_quantidade_solicitada`, not `quantidade_pedida`.

---

### `POST /api/compras/conferir`

**File:** `src/app/api/compras/conferir/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Process receiving confirmation. Updates quantities and enters stock in Tiny.

**Request Body:**
```json
{
  "ordem_compra_id": "uuid",
  "usuario_id": "uuid",
  "cargo": "comprador",
  "itens": [
    { "item_id": "uuid", "quantidade_recebida": 2 }
  ]
}
```

**Response 200:**
```json
{
  "processados": 3,
  "erros": 0,
  "erros_detalhe": [],
  "itens_sem_produto_id": 0,
  "pedidos_liberados": ["pedido_id_1"]
}
```

**Business Logic:**
- Resolves the receiving empresa from the OC's `galpao_id` (first active empresa in that galpão, fallback to `oc.empresa_id`)
- Calls `movimentarEstoque(tipo: "E")` in Tiny for each item with `produto_id_tiny`, using the receiving empresa's token and deposit
- Uses `compra_quantidade_solicitada` as the expected quantity
- Rejects conference lines that exceed the pending remaining quantity
- Updates `compra_quantidade_recebida`, marks `recebido` when fully received
- Upserts `siso_pedido_item_estoques` with received stock for each item (so the transferencia worker can find stock at the receiving empresa)
- Updates OC status: `parcialmente_recebido` or `recebido`
- Checks if pedidos can be released via `checkAndReleasePedidos`:
  - Same galpão (OC galpão = pedido origin galpão) → `decisao_final='propria'`
  - Cross-galpão → `decisao_final='transferencia'`, `separacao_galpao_id` set to OC galpão
  - Itens `cancelado` count as resolved; pedidos with all items cancelled are not released
- 500ms delay between Tiny API calls

---

### `GET /api/compras/conferencia/[ordemCompraId]`

**File:** `src/app/api/compras/conferencia/[ordemCompraId]/route.ts`
**Auth:** `cargo` query param (admin or comprador)

Returns OC info + pending items for receiving screen.

`quantidade_esperada` and `quantidade_restante` are calculated from `compra_quantidade_solicitada`.

**Response 200:**
```json
{
  "ordem_compra": {
    "id": "uuid",
    "fornecedor": "ACA",
    "galpao_id": "uuid | null",
    "galpao_nome": "CWB | null",
    "status": "comprado",
    "comprado_por_nome": "Eryk",
    ...
  },
  "itens": [{
    "item_id": "uuid",
    "sku": "19ABC",
    "descricao": "Filtro",
    "quantidade_esperada": 5,
    "quantidade_ja_recebida": 2,
    "quantidade_restante": 3,
    "produto_id_tiny": 999,
    "pedidos": [{ "pedido_id": "123", "numero_pedido": "12345", "quantidade": 5 }]
  }]
}
```

---

### `POST /api/compras/itens/[itemId]/indisponivel`

**File:** `src/app/api/compras/itens/[itemId]/indisponivel/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Marks item as unavailable from supplier. Unlinks from OC.

**Request Body:**
```json
{ "cargo": "comprador" }
```

**Response 200:**
```json
{ "ok": true, "item": { "id": "uuid", "sku": "19ABC", "compra_status": "indisponivel" } }
```

**Side effect:** If OC has no remaining items, cancels the OC.

---

### `POST /api/compras/itens/[itemId]/equivalente`

**File:** `src/app/api/compras/itens/[itemId]/equivalente/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Registra um SKU equivalente para o item e move o caso para exceção `equivalente_pendente`.

**Request Body:**
```json
{
  "sku_equivalente": "EW1234",
  "fornecedor_equivalente": "Eletricway",
  "observacao": "Troca aprovada comercialmente",
  "usuario_id": "uuid",
  "cargo": "comprador"
}
```

**Response 200:**
```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "compra_status": "equivalente_pendente",
    "compra_equivalente_sku": "EW1234"
  }
}
```

**Business Logic:**
- Valida que o SKU equivalente existe na empresa de origem do pedido
- Remove o item da OC atual, se houver
- Zera o vínculo de compra anterior e guarda os dados do equivalente até a confirmação externa
- Se a OC anterior ficar vazia, ela é cancelada

---

### `POST /api/compras/itens/[itemId]/equivalente/confirmar`

**File:** `src/app/api/compras/itens/[itemId]/equivalente/confirmar/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Confirma que a troca do item já foi aplicada externamente e sincroniza o item local com o SKU equivalente.

**Request Body:**
```json
{ "cargo": "comprador" }
```

**Response 200:**
```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "sku": "EW1234",
    "compra_status": "aguardando_compra"
  }
}
```

**Business Logic:**
- Recarrega o produto equivalente e estoques por empresa
- Atualiza `siso_pedido_itens` com SKU/produto/GTIN/imagem do equivalente
- Regrava `siso_pedido_item_estoques` para o novo produto
- Devolve o item para `aguardando_compra`
- Não altera o pedido no Tiny automaticamente; presume que a troca já foi feita externamente

---

### `POST /api/compras/itens/[itemId]/cancelamento`

**File:** `src/app/api/compras/itens/[itemId]/cancelamento/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Marca um item como `cancelamento_pendente`, aguardando remoção/cancelamento externo.

**Request Body:**
```json
{
  "motivo": "Sem disponibilidade no fornecedor",
  "usuario_id": "uuid",
  "cargo": "comprador"
}
```

**Response 200:**
```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "compra_status": "cancelamento_pendente"
  }
}
```

**Side effect:** If OC has no remaining items, cancels the OC.

---

### `POST /api/compras/itens/[itemId]/cancelamento/confirmar`

**File:** `src/app/api/compras/itens/[itemId]/cancelamento/confirmar/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Confirma que o item já foi removido/cancelado externamente e o exclui do fluxo local.

**Request Body:**
```json
{
  "usuario_id": "uuid",
  "cargo": "comprador"
}
```

**Response 200:**
```json
{
  "ok": true,
  "pedido_cancelado": null,
  "pedidos_liberados": ["pedido_id_1"]
}
```

**Business Logic:**
- Marca o item como `cancelado`
- Remove os estoques normalizados do item
- Se todos os itens do pedido forem cancelados, cancela o pedido localmente
- Caso contrário, reavalia a liberação via `checkAndReleasePedidos`

---

### `POST /api/compras/pedidos/[pedidoId]/cancelar`

**File:** `src/app/api/compras/pedidos/[pedidoId]/cancelar/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Cancela o pedido inteiro no Tiny e limpa o fluxo local de compras.

**Request Body:**
```json
{ "cargo": "comprador" }
```

**Response 200:**
```json
{
  "ok": true,
  "pedido_id": "123456",
  "estoque_lancado_alerta": false
}
```

**Business Logic:**
- Chama `atualizarStatusPedido(..., "cancelado")` no Tiny
- Cancela a fila de execução pendente do pedido
- Desvincula todos os itens de compra e cancela OCs que ficarem vazias
- Sinaliza `compra_estoque_lancado_alerta` se já houve entrada de estoque pela conferência

---

### `POST /api/compras/itens/[itemId]/devolver`

**File:** `src/app/api/compras/itens/[itemId]/devolver/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Returns item to "Aguardando Compra" queue. Unlinks from OC.

**Request Body:**
```json
{ "cargo": "comprador" }
```

**Response 200:**
```json
{ "ok": true, "item": { "id": "uuid", "sku": "19ABC", "compra_status": "aguardando_compra" } }
```

---

### `POST /api/compras/itens/[itemId]/trocar-fornecedor`

**File:** `src/app/api/compras/itens/[itemId]/trocar-fornecedor/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Changes supplier of an item.

**Request Body:**
```json
{
  "novo_fornecedor": "Tiger",
  "nova_ordem_compra_id": "uuid",
  "cargo": "comprador"
}
```

**Response 200:**
```json
{ "ok": true, "item": { "id": "uuid", "sku": "19ABC", "fornecedor_oc": "Tiger", "compra_status": "comprado" } }
```

**Notes:** If no `nova_ordem_compra_id`, item goes back to `aguardando_compra` with new supplier.

---

## Worker

### `POST /api/worker/processar`

**File:** `src/app/api/worker/processar/route.ts`
**Auth:** Optional Bearer token via `WORKER_SECRET` env var

Triggers execution worker to process pending jobs from `siso_fila_execucao`.

**Query Params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 5 | Max jobs to process (capped at 20) |

**Headers:** `Authorization: Bearer <WORKER_SECRET>` (when env var set)

**Response 200:**
```json
{ "processed": 3, "errors": 0, "rateLimited": 0 }
```

### `GET /api/worker/processar`

Health check. Returns `{ status: "ok", service: "SISO Execution Worker" }`.

---

## Reconciliação

### `GET /api/reconciliacao`

**File:** `src/app/api/reconciliacao/route.ts`

Two-pronged reconciliation that catches orders lost due to fire-and-forget webhook failures:

1. **Internal**: finds webhook_logs stuck in `processando` for >5 min and reprocesses them
2. **External**: queries Tiny API for approved/preparando/faturado orders within the lookback window and cross-references with `siso_pedidos` to find missing orders

**Auth:** None (should be called by cron or admin)

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `hours` | number | 48 | Lookback window in hours |
| `dryRun` | string | - | Set to `"true"` to only report without reprocessing |

**Response `200`:**

```json
{
  "stuckWebhooks": [
    {
      "pedidoId": "1044892037",
      "empresaId": "uuid",
      "stuckSince": "2026-03-23T16:37:39Z",
      "reprocessed": true,
      "error": "optional error message"
    }
  ],
  "missingOrders": [
    {
      "pedidoId": "123456",
      "empresaId": "uuid",
      "numero": "132500",
      "reprocessed": true,
      "error": "optional error message"
    }
  ],
  "summary": {
    "stuckFound": 4,
    "missingFound": 2,
    "totalReprocessed": 6,
    "dryRun": false,
    "lookbackHours": 48
  }
}
```

**Side effects:**
- Resets stuck webhook_logs and re-runs `processWebhook`
- Creates `tipo=reconciliacao` webhook_log entries for missing orders
- Calls Tiny API (`GET /pedidos`) for each active empresa (rate-limited)

---

## Dashboard & Monitoring

### `GET /api/dashboard/counts`

**File:** `src/app/api/dashboard/counts/route.ts`
**Auth:** None

Lightweight counts for module cards on the landing page.

**Response 200:**
```json
{ "siso": 5, "separacao": 12, "compras": 3 }
```

**Counts:**
- `siso`: pedidos with `status = 'pendente'`
- `separacao`: pedidos with `status_separacao` in `aguardando_separacao`, `em_separacao`, `separado`
- `compras`: pedidos with `status_separacao = 'aguardando_compra'`

---

### `GET /api/painel`

**File:** `src/app/api/painel/route.ts`
**Auth:** None

Control tower (Torre de Controle) aggregated data.

**Query Params:**
| Param | Type | Description |
|-------|------|-------------|
| `galpao_id` | string | Filter by galpao (optional) |

**Response 200:**
```json
{
  "server_time": "2026-03-17T...",
  "galpoes": [{ "id": "uuid", "nome": "CWB" }],
  "pipeline": {
    "aguardando_compra": 5,
    "aguardando_nf": 3,
    "aguardando_separacao": 10,
    "em_separacao": 2,
    "separado": 1,
    "embalado": 4
  },
  "throughput": {
    "buckets": [{ "hour": 8, "count": 5 }, ...],
    "total_today": 42
  },
  "alerts": {
    "stuck_nf": 2,
    "stuck_separacao": 1,
    "recent_errors": 3,
    "error_samples": [{ "source": "webhook", "message": "...", "timestamp": "..." }]
  },
  "kpis": {
    "processed_today": 42,
    "pipeline_total": 25,
    "avg_cycle_time_min": 120
  }
}
```

**Business Logic:**
- `stuck_nf`: pedidos in `aguardando_nf` for > 4 hours
- `stuck_separacao`: pedidos in `em_separacao` for > 2 hours
- Throughput buckets: 24h by hour (BRT timezone)
- Avg cycle time: from `criado_em` to `embalagem_concluida_em` in last 24h

---

### `GET /api/monitoring`

**File:** `src/app/api/monitoring/route.ts`
**Auth:** None

Operational monitoring dashboard data.

**Response 200:**
```json
{
  "generatedAt": "2026-03-17T...",
  "orders": {
    "today": { "pendente": 5, "concluido": 30, "cancelado": 2, "erro": 1 },
    "total": 38
  },
  "webhooks": {
    "last24h": { "received": 100, "processed": 95, "errors": 3, "pending": 2 },
    "avgProcessingMs": 1500,
    "throughputPerHour": [{ "hour": "2026-03-17T14", "count": 8 }],
    "errorRate": 3
  },
  "recentErrors": [{ "id": "uuid", "timestamp": "...", "source": "webhook", "message": "..." }],
  "health": {
    "lastWebhookReceivedAt": "2026-03-17T...",
    "lastSuccessfulProcessingAt": "2026-03-17T...",
    "status": "healthy" | "warning" | "degraded"
  }
}
```

**Health status:** `degraded` if errorRate >= 50%, `warning` if >= 20%, else `healthy`.

---

## Admin - Usuarios

### `GET /api/admin/usuarios`

**File:** `src/app/api/admin/usuarios/route.ts`

Lists all users (PIN excluded).

**Response 200:** Array of:
```json
{
  "id": "uuid", "nome": "Eryk", "cargo": "admin",
  "cargos": ["admin"], "ativo": true,
  "printnode_printer_id": 12345, "printnode_printer_nome": "Zebra GK420d",
  "criado_em": "...", "atualizado_em": "..."
}
```

### `POST /api/admin/usuarios`

Create user. Body: `{ nome, pin, cargos }` or legacy `{ nome, pin, cargo }`.
PIN must be exactly 4 digits. Valid cargos: `admin`, `operador_cwb`, `operador_sp`, `comprador`.

### `PUT /api/admin/usuarios`

Update user. Body: `{ id, nome?, pin?, cargos?, ativo?, printnode_printer_id?, printnode_printer_nome? }`.

### `DELETE /api/admin/usuarios?id=<uuid>`

Delete user permanently.

---

## Admin - Galpoes

### `GET /api/admin/galpoes`

Returns galpoes with nested empresas, grupo info, connection status, and printer config.

### `POST /api/admin/galpoes`

Create galpao. Body: `{ nome, descricao? }`. Returns 409 if name exists.

### `PUT /api/admin/galpoes/[id]`

Update galpao. Body: `{ nome?, descricao?, ativo?, printnode_printer_id?, printnode_printer_nome? }`.

---

## Admin - Empresas

### `GET /api/admin/empresas`

Lists all empresas.

### `POST /api/admin/empresas`

Create empresa. Body: `{ nome, cnpj, galpao_id }`. Auto-creates `siso_tiny_connections` entry. Returns 409 if CNPJ exists. Clears empresa cache.

### `PUT /api/admin/empresas/[id]`

Update empresa. Body: `{ nome?, galpao_id?, ativo? }`. Clears empresa cache.

---

## Admin - Grupos

### `GET /api/admin/grupos`

Lists all grupos with nested empresas and tier info.

### `POST /api/admin/grupos`

Create grupo. Body: `{ nome, descricao? }`. Returns 409 if name exists.

### `PUT /api/admin/grupos/[id]`

Update grupo. Body: `{ nome?, descricao? }`.

### `POST /api/admin/grupos/[id]/empresas`

Add empresa to grupo. Body: `{ empresa_id, tier? }`. Default tier = 1. Returns 409 if empresa already in a grupo. Clears grupo cache.

### `PUT /api/admin/grupos/[id]/empresas/[empresaId]`

Update tier. Body: `{ tier }`. Must be >= 1. Clears grupo cache.

### `DELETE /api/admin/grupos/[id]/empresas/[empresaId]`

Remove empresa from grupo. Clears grupo cache.

---

## Admin - PrintNode

### `GET /api/admin/printnode/api-key`

**Auth:** `x-siso-user-id` header (admin only)

Returns masked API key status. Response: `{ configured: true, masked: "••••abcd" }`.

### `PUT /api/admin/printnode/api-key`

**Auth:** `x-siso-user-id` header (admin only)

Sets API key. Body: `{ api_key: "..." }`.

### `DELETE /api/admin/printnode/api-key`

**Auth:** `x-siso-user-id` header (admin only)

Removes API key.

### `GET /api/admin/printnode/printers`

**Auth:** `x-siso-user-id` header (admin only)

Lists available PrintNode printers. Requires API key configured.

### `POST /api/admin/printnode/test`

**Auth:** `x-siso-user-id` header (admin only)

Tests PrintNode connection.

---

## Tiny ERP

### `GET /api/tiny/connections`

Lists all Tiny connections with masked secrets.

**Response 200:** Array of:
```json
{
  "id": "uuid", "filial": "CWB", "nome_empresa": "NetAir", "cnpj": "34857388000163",
  "ativo": true, "has_client_id": true, "client_id_preview": "abc12345...",
  "has_client_secret": true, "is_authorized": true, "token_expires_at": "...",
  "deposito_id": 1, "deposito_nome": "Principal"
}
```

### `POST /api/tiny/connections`

Create connection for empresa. Body: `{ empresa_id }`. Returns 409 if connection exists.

### `PUT /api/tiny/connections`

Update OAuth2 credentials or deposit. Body: `{ id, client_id?, client_secret?, deposito_id?, deposito_nome? }`.
Changing credentials clears existing tokens.

### `DELETE /api/tiny/connections`

Remove connection and deactivate empresa. Body: `{ empresa_id }`.

### `POST /api/tiny/test-connection`

Test connection using OAuth2 token. Body: `{ connectionId }`. Updates `ultimo_teste_*` fields.

### `GET /api/tiny/deposits?connectionId=xxx`

Fetches deposits from Tiny for a connection. Returns `[{ id, nome }]`.

### `GET /api/tiny/oauth?connectionId=xxx`

Starts OAuth2 flow. Redirects to Tiny authorization page.

### `GET /api/tiny/oauth/callback?code=xxx&state=xxx`

OAuth2 callback. Exchanges code for tokens, tests connection, redirects to `/configuracoes`.

### `POST /api/tiny/stock/ajustar`

**File:** `src/app/api/tiny/stock/ajustar/route.ts`

Sets stock to exact value in Tiny (balanco).

**Request Body:**
```json
{
  "pedidoId": "123",
  "produtoId": 999,
  "galpao": "CWB",
  "quantidade": 10
}
```

**Response 200:**
```json
{ "ok": true, "galpao": "CWB", "saldo": 10, "reservado": 2, "disponivel": 8 }
```

**Business Logic:**
- Resolves empresa in target galpao
- Uses `produto_id_suporte` for cross-galpao adjustments
- Calls `movimentarEstoque(tipo: "B")` (balanco)
- Re-fetches actual values from Tiny after adjustment
- Updates both normalized and legacy stock columns

---

## Inventário

Physical inventory module — barcode scanning of products into location-tagged sessions, with Tiny ERP stock/location updates.

### `GET /api/inventario`

**File:** `src/app/api/inventario/route.ts`
**Auth:** Session required

Lists inventory sessions with item counts.

**Query Params:**
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Optional. Filter by inventory status |

**Response 200:**
```json
{
  "inventarios": [
    {
      "id": "uuid",
      "empresa_id": "uuid",
      "galpao_id": "uuid",
      "usuario_id": "uuid",
      "deposito_id": 1,
      "modo": "loc_estoque",
      "tipo_estoque": "B",
      "manter_localizacao_antiga": false,
      "status": "em_andamento",
      "observacoes": "...",
      "created_at": "2026-03-23T...",
      "processado_em": null,
      "concluido_em": null,
      "empresa": { "nome": "NetAir" },
      "galpao": { "nome": "CWB" },
      "usuario": { "nome": "Eryk" },
      "total_itens": 42,
      "itens_sucesso": 0,
      "itens_erro": 0
    }
  ]
}
```

**Business Logic:**
- Item counts computed via separate COUNT queries per inventory
- Galpão filtering applied if user has `galpaoId` (non-admin users)
- Ordered by created_at desc

**Errors:**
| Status | Cause |
|--------|-------|
| 401 | Invalid session |
| 500 | Database error |

---

### `POST /api/inventario`

**File:** `src/app/api/inventario/route.ts`
**Auth:** Session required

Creates a new inventory session.

**Request Body:**
```json
{
  "empresa_id": "uuid (required)",
  "modo": "loc_estoque | loc_only (required)",
  "tipo_estoque": "B | E | S (required if modo=loc_estoque)",
  "manter_localizacao_antiga": false,
  "observacoes": "optional text"
}
```

**Response 201:**
```json
{
  "id": "uuid",
  "empresa_id": "uuid",
  "galpao_id": "uuid",
  "deposito_id": 1,
  "modo": "loc_estoque",
  "status": "em_andamento"
}
```

**Business Logic:**
- Resolves `galpao_id` from empresa FK
- Resolves `deposito_id` from `siso_tiny_connections` (active connection for empresa)
- Fails if empresa not found, no active Tiny connection, or no deposito configured

**Errors:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ error: "empresa_id e obrigatorio" }` | Missing empresa_id |
| 400 | `{ error: "modo e obrigatorio" }` | Missing modo |
| 400 | `{ error: "tipo_estoque e obrigatorio..." }` | Missing tipo_estoque when modo=loc_estoque |
| 400 | `{ error: "Empresa nao encontrada" }` | Invalid empresa_id |
| 400 | `{ error: "Deposito nao configurado..." }` | No active connection/deposito |
| 401 | | Invalid session |
| 500 | | Insert error |

---

### `GET /api/inventario/[id]`

**File:** `src/app/api/inventario/[id]/route.ts`
**Auth:** Session required

Returns full inventory detail with all items and consolidated view.

**Response 200:**
```json
{
  "id": "uuid",
  "empresa_id": "uuid",
  "galpao_id": "uuid",
  "usuario_id": "uuid",
  "deposito_id": 1,
  "modo": "loc_estoque",
  "tipo_estoque": "B",
  "status": "em_andamento",
  "observacoes": "...",
  "created_at": "...",
  "processado_em": null,
  "concluido_em": null,
  "empresa": { "nome": "NetAir" },
  "galpao": { "nome": "CWB" },
  "usuario": { "nome": "Eryk" },
  "total_itens": 5,
  "itens_sucesso": 0,
  "itens_erro": 0,
  "itens": [
    {
      "id": "uuid",
      "inventario_id": "uuid",
      "produto_id_tiny": 123,
      "sku": "19ABC",
      "nome_produto": "Filtro de Ar",
      "ean": null,
      "localizacao": "A-01-1",
      "quantidade": 2,
      "status": "pendente",
      "erro_msg": null,
      "created_at": "..."
    }
  ],
  "consolidados": [
    {
      "sku": "19ABC",
      "nome_produto": "Filtro de Ar",
      "quantidade_total": 5,
      "localizacoes": "A-01-1; B-02-3",
      "status": "pendente",
      "erro_msg": null
    }
  ]
}
```

**Errors:**
| Status | Cause |
|--------|-------|
| 401 | Invalid session |
| 404 | Inventory not found |
| 500 | Query error |

---

### `PATCH /api/inventario/[id]`

**File:** `src/app/api/inventario/[id]/route.ts`
**Auth:** Session required. Creator or admin only.

Updates observacoes or cancels inventory.

**Request Body:**
```json
{
  "observacoes": "optional text",
  "status": "cancelado"
}
```

**Response 200:**
```json
{
  "id": "uuid",
  "status": "cancelado",
  "observacoes": "...",
  "concluido_em": "2026-03-23T..."
}
```

**Business Logic:**
- Can only cancel if status = `em_andamento`
- Sets `concluido_em` when cancelling

**Errors:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ error: "Nenhuma alteracao informada" }` | No updates provided |
| 400 | `{ error: "So e possivel cancelar inventarios em andamento" }` | Wrong status for cancel |
| 401 | | Invalid session |
| 403 | `{ error: "Apenas o criador pode modificar..." }` | Not creator/admin |
| 404 | | Inventory not found |
| 500 | | Update error |

---

### `POST /api/inventario/[id]/coletar`

**File:** `src/app/api/inventario/[id]/coletar/route.ts`
**Auth:** Session required. Creator or admin only.

Scans a product (by SKU or EAN) and adds it to the inventory session.

**Request Body:**
```json
{
  "codigo": "SKU or EAN string (required)",
  "localizacao": "A-01-1 (required)",
  "quantidade": 1
}
```

**Response 201:**
```json
{
  "item": {
    "id": "uuid",
    "produto_id_tiny": 123,
    "sku": "19ABC",
    "nome_produto": "Filtro de Ar",
    "ean": null,
    "localizacao": "A-01-1",
    "quantidade": 1,
    "status": "pendente",
    "created_at": "..."
  },
  "ja_escaneado": true,
  "localizacoes_anteriores": ["B-02-3 (×2)"],
  "total_itens": 5
}
```

**Business Logic:**
- Searches Tiny: first by SKU (`buscarProdutoPorSku`), then by GTIN (`buscarProdutoPorGtin`) as fallback
- Uses `runWithEmpresa()` for rate limiting
- Detects duplicate SKU in same inventory (case-insensitive via `ilike`)
- Returns previous locations if already scanned
- `ean` is set when found via GTIN search, null otherwise

**Errors:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ error: "Inventario nao esta em andamento" }` | Wrong status |
| 400 | `{ error: "Codigo e obrigatorio" }` | Missing codigo |
| 400 | `{ error: "Localizacao e obrigatoria" }` | Missing localizacao |
| 400 | `{ error: "Quantidade deve ser >= 1" }` | Invalid quantidade |
| 401 | | Invalid session |
| 403 | | Not creator/admin |
| 404 | `{ error: "Inventario nao encontrado" }` | Invalid id |
| 404 | `{ error: "Produto nao encontrado no Tiny" }` | SKU/EAN not in Tiny |
| 500 | | Insert error |

---

### `PATCH /api/inventario/[id]/itens/[itemId]`

**File:** `src/app/api/inventario/[id]/itens/[itemId]/route.ts`
**Auth:** Session required. Creator or admin only.

Updates item quantity.

**Request Body:**
```json
{ "quantidade": 3 }
```

**Response 200:**
```json
{
  "item": { "id": "uuid", "quantidade": 3 },
  "total_itens": 5
}
```

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Inventory not em_andamento, or quantidade < 1 |
| 401 | Invalid session |
| 403 | Not creator/admin |
| 404 | Inventory or item not found |
| 500 | Update error |

---

### `DELETE /api/inventario/[id]/itens/[itemId]`

**File:** `src/app/api/inventario/[id]/itens/[itemId]/route.ts`
**Auth:** Session required. Creator or admin only.

Removes item from inventory.

**Response 200:**
```json
{ "ok": true, "total_itens": 4 }
```

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Inventory not em_andamento |
| 401 | Invalid session |
| 403 | Not creator/admin |
| 404 | Inventory not found |
| 500 | Delete error |

---

### `POST /api/inventario/[id]/processar`

**File:** `src/app/api/inventario/[id]/processar/route.ts`
**Auth:** Session required. Creator or admin only.

Starts inventory processing (fire-and-forget).

**Response 200:**
```json
{ "ok": true, "message": "Processamento iniciado" }
```

**Business Logic:**
- Validates status = `em_andamento` and has items (COUNT > 0)
- Calls `processarInventario(id)` async — does NOT await
- For each item: updates location in Tiny + adjusts stock (if modo=loc_estoque, skip Kit type K)
- Errors logged via `logger.logError` with category `infrastructure`

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Not em_andamento, or no items |
| 401 | Invalid session |
| 403 | Not creator/admin |
| 404 | Inventory not found |
| 500 | Unexpected error |

---

### `GET /api/inventario/[id]/progresso`

**File:** `src/app/api/inventario/[id]/progresso/route.ts`
**Auth:** Session required

Returns processing progress — designed for polling every 2s.

**Response 200:**
```json
{
  "status": "processando",
  "total": 10,
  "processados": 7,
  "sucesso": 5,
  "erro": 2,
  "itens": [
    {
      "sku": "19ABC",
      "nome_produto": "Filtro de Ar",
      "quantidade_total": 3,
      "localizacoes": "A-01-1; B-02-3",
      "status": "sucesso",
      "erro_msg": null
    }
  ]
}
```

**Business Logic:**
- Groups items by SKU (case-insensitive), aggregates quantities and locations
- Consolidates status: sucesso > erro > processando > pendente
- `processados = sucesso + erro`

**Errors:**
| Status | Cause |
|--------|-------|
| 401 | Invalid session |
| 404 | Inventory not found |
| 500 | Query error |

---

### `POST /api/inventario/[id]/reverter`

**File:** `src/app/api/inventario/[id]/reverter/route.ts`
**Auth:** Session required. Creator or admin only.

Starts reversal of completed inventory (fire-and-forget).

**Response 200:**
```json
{ "ok": true, "message": "Reversão iniciada" }
```

**Business Logic:**
- Validates status = `concluido`
- Calls `reverterInventario(id)` async — does NOT await
- Restores locations and reverses stock movements in Tiny

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Not concluido |
| 401 | Invalid session |
| 403 | Not creator/admin |
| 404 | Inventory not found |
| 500 | Unexpected error |

---

## Transferência

Inter-galpão stock transfer module — scan products from origin empresa, process transfers to destination empresa (with auto-cloning of products if needed).

### `GET /api/transferencia`

**File:** `src/app/api/transferencia/route.ts`
**Auth:** Session required

Lists transfer sessions with item counts.

**Query Params:**
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Optional. Filter by transfer status |

**Response 200:**
```json
{
  "transferencias": [
    {
      "id": "uuid",
      "empresa_origem_id": "uuid",
      "empresa_destino_id": "uuid",
      "galpao_origem_id": "uuid",
      "galpao_destino_id": "uuid",
      "usuario_id": "uuid",
      "deposito_origem_id": 1,
      "deposito_destino_id": 2,
      "status": "em_andamento",
      "observacoes": "...",
      "created_at": "...",
      "processado_em": null,
      "concluido_em": null,
      "empresa_origem": { "nome": "NetAir" },
      "empresa_destino": { "nome": "NetParts" },
      "galpao_origem": { "nome": "CWB" },
      "galpao_destino": { "nome": "SP" },
      "usuario": { "nome": "Eryk" },
      "total_itens": 10,
      "itens_sucesso": 0,
      "itens_erro": 0
    }
  ]
}
```

**Business Logic:**
- Galpão filtering: user sees transfers where their galpão is origin OR destination
- Ordered by created_at desc

**Errors:**
| Status | Cause |
|--------|-------|
| 401 | Invalid session |
| 500 | Database error |

---

### `POST /api/transferencia`

**File:** `src/app/api/transferencia/route.ts`
**Auth:** Session required

Creates a new transfer session.

**Request Body:**
```json
{
  "empresa_origem_id": "uuid (required)",
  "empresa_destino_id": "uuid (required)",
  "observacoes": "optional text"
}
```

**Response 201:**
```json
{
  "id": "uuid",
  "empresa_origem_id": "uuid",
  "empresa_destino_id": "uuid",
  "galpao_origem_id": "uuid",
  "galpao_destino_id": "uuid",
  "deposito_origem_id": 1,
  "deposito_destino_id": 2,
  "status": "em_andamento"
}
```

**Business Logic:**
- Validates origem != destino
- Resolves galpao_ids from empresas
- Resolves deposito_ids from active `siso_tiny_connections`

**Errors:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ error: "empresa_origem_id e obrigatorio" }` | Missing field |
| 400 | `{ error: "empresa_destino_id e obrigatorio" }` | Missing field |
| 400 | `{ error: "Origem e destino devem ser diferentes" }` | Same empresa |
| 400 | `{ error: "Empresa origem nao encontrada" }` | Invalid empresa |
| 400 | `{ error: "Empresa destino nao encontrada" }` | Invalid empresa |
| 400 | `{ error: "Deposito nao configurado para empresa origem" }` | No active connection |
| 400 | `{ error: "Deposito nao configurado para empresa destino" }` | No active connection |
| 401 | | Invalid session |
| 500 | | Insert error |

---

### `GET /api/transferencia/[id]`

**File:** `src/app/api/transferencia/[id]/route.ts`
**Auth:** Session required

Returns full transfer detail with all items.

**Response 200:**
```json
{
  "id": "uuid",
  "empresa_origem_id": "uuid",
  "empresa_destino_id": "uuid",
  "galpao_origem_id": "uuid",
  "galpao_destino_id": "uuid",
  "usuario_id": "uuid",
  "deposito_origem_id": 1,
  "deposito_destino_id": 2,
  "status": "em_andamento",
  "observacoes": "...",
  "created_at": "...",
  "processado_em": null,
  "concluido_em": null,
  "empresa_origem": { "nome": "NetAir" },
  "empresa_destino": { "nome": "NetParts" },
  "galpao_origem": { "nome": "CWB" },
  "galpao_destino": { "nome": "SP" },
  "usuario": { "nome": "Eryk" },
  "total_itens": 3,
  "itens_sucesso": 0,
  "itens_erro": 0,
  "itens": [
    {
      "id": "uuid",
      "transferencia_id": "uuid",
      "produto_id_tiny_origem": 123,
      "sku": "19ABC",
      "nome_produto": "Filtro de Ar",
      "ean": null,
      "quantidade": 2,
      "status": "pendente",
      "erro_msg": null,
      "created_at": "..."
    }
  ]
}
```

**Errors:**
| Status | Cause |
|--------|-------|
| 401 | Invalid session |
| 404 | Transfer not found |
| 500 | Query error |

---

### `PATCH /api/transferencia/[id]`

**File:** `src/app/api/transferencia/[id]/route.ts`
**Auth:** Session required. Creator or admin only.

Updates observacoes or cancels transfer.

**Request Body:**
```json
{
  "observacoes": "optional text",
  "status": "cancelado"
}
```

**Response 200:**
```json
{
  "id": "uuid",
  "status": "cancelado",
  "observacoes": "...",
  "concluido_em": "2026-03-23T..."
}
```

**Business Logic:**
- Can only cancel if status = `em_andamento`
- Sets `concluido_em` when cancelling

**Errors:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ error: "Nenhuma alteracao informada" }` | No updates |
| 400 | `{ error: "So e possivel cancelar transferencias em andamento" }` | Wrong status |
| 401 | | Invalid session |
| 403 | `{ error: "Apenas o criador pode modificar..." }` | Not creator/admin |
| 404 | | Transfer not found |
| 500 | | Update error |

---

### `POST /api/transferencia/[id]/coletar`

**File:** `src/app/api/transferencia/[id]/coletar/route.ts`
**Auth:** Session required. Creator or admin only.

Scans a product (by SKU or EAN) from the **origin empresa** and adds it to the transfer.

**Request Body:**
```json
{
  "codigo": "SKU or EAN string (required)",
  "quantidade": 1
}
```

**Response 201:**
```json
{
  "item": {
    "id": "uuid",
    "produto_id_tiny_origem": 123,
    "sku": "19ABC",
    "nome_produto": "Filtro de Ar",
    "ean": null,
    "quantidade": 1,
    "status": "pendente",
    "created_at": "..."
  },
  "total_itens": 5
}
```

**Business Logic:**
- Searches in **origin empresa only** (not destination)
- Uses `buscarProdutoPorSku` then `buscarProdutoPorGtin` as fallback
- No localizacao field (unlike inventario coletar)
- No duplicate detection (unlike inventario)

**Errors:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ error: "Transferencia nao esta em andamento" }` | Wrong status |
| 400 | `{ error: "Codigo e obrigatorio" }` | Missing codigo |
| 401 | | Invalid session |
| 403 | | Not creator/admin |
| 404 | `{ error: "Transferencia nao encontrada" }` | Invalid id |
| 404 | `{ error: "Produto nao encontrado no Tiny" }` | SKU/EAN not found |
| 500 | | Insert error |

---

### `PATCH /api/transferencia/[id]/itens/[itemId]`

**File:** `src/app/api/transferencia/[id]/itens/[itemId]/route.ts`
**Auth:** Session required. Creator or admin only.

Updates item quantity.

**Request Body:**
```json
{ "quantidade": 3 }
```

**Response 200:**
```json
{
  "item": { "id": "uuid", "quantidade": 3 },
  "total_itens": 5
}
```

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Not em_andamento, or quantidade < 1 |
| 401 | Invalid session |
| 403 | Not creator/admin |
| 404 | Transfer or item not found |
| 500 | Update error |

---

### `DELETE /api/transferencia/[id]/itens/[itemId]`

**File:** `src/app/api/transferencia/[id]/itens/[itemId]/route.ts`
**Auth:** Session required. Creator or admin only.

Removes item from transfer.

**Response 200:**
```json
{ "ok": true, "total_itens": 4 }
```

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Not em_andamento |
| 401 | Invalid session |
| 403 | Not creator/admin |
| 404 | Transfer not found |
| 500 | Delete error |

---

### `POST /api/transferencia/[id]/processar`

**File:** `src/app/api/transferencia/[id]/processar/route.ts`
**Auth:** Session required. Creator or admin only.

Starts transfer processing (fire-and-forget).

**Response 200:**
```json
{ "ok": true, "message": "Processamento iniciado" }
```

**Business Logic:**
- Validates status = `em_andamento` and has items
- Calls `processarTransferencia(id)` async — does NOT await
- Per item: searches product in destination, clones if not found, Saída in origin, Entrada in destination
- Alternates `runWithEmpresa` between origin/destination for 2x throughput

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Not em_andamento, or no items |
| 401 | Invalid session |
| 403 | Not creator/admin |
| 404 | Transfer not found |
| 500 | Unexpected error |

---

### `GET /api/transferencia/[id]/progresso`

**File:** `src/app/api/transferencia/[id]/progresso/route.ts`
**Auth:** Session required

Returns processing progress — designed for polling every 2s.

**Response 200:**
```json
{
  "status": "processando",
  "total": 10,
  "processados": 7,
  "sucesso": 5,
  "erro": 2,
  "itens": [
    {
      "sku": "19ABC",
      "nome_produto": "Filtro de Ar",
      "quantidade_total": 3,
      "localizacoes": "",
      "status": "sucesso",
      "erro_msg": null
    }
  ]
}
```

**Notes:**
- `localizacoes` is always empty string for transfers (no location tracking)
- `processados = sucesso + erro`

**Errors:**
| Status | Cause |
|--------|-------|
| 401 | Invalid session |
| 404 | Transfer not found |
| 500 | Query error |

---

### `POST /api/transferencia/[id]/reverter`

**File:** `src/app/api/transferencia/[id]/reverter/route.ts`
**Auth:** Session required. Creator or admin only.

Starts reversal of completed transfer (fire-and-forget).

**Response 200:**
```json
{ "ok": true, "message": "Reversao iniciada" }
```

**Business Logic:**
- Validates status = `concluido`
- Calls `reverterTransferencia(id)` async — does NOT await
- Reverses stock: Entrada on origin + Saída on destination

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Not concluido |
| 401 | Invalid session |
| 403 | Not creator/admin |
| 404 | Transfer not found |
| 500 | Unexpected error |

---

## Etiquetas de Endereço

Address label generation and printing — generates ZPL for thermal printers from corridor/horizontal/vertical ranges.

### `POST /api/etiquetas-endereco/preview`

**File:** `src/app/api/etiquetas-endereco/preview/route.ts`
**Auth:** Session required (any logged-in user)

Generates preview of address labels from range parameters.

**Request Body:**
```json
{
  "corredor_inicio": "A",
  "corredor_fim": "B",
  "horizontal_inicio": 1,
  "horizontal_fim": 5,
  "vertical_inicio": 1,
  "vertical_fim": 3
}
```

**Response 200:**
```json
{
  "enderecos": ["A-01-1", "A-01-2", "A-01-3", "A-02-1", "..."],
  "total": 30,
  "total_labels": 15
}
```

**Business Logic:**
- Generates address combinations: corridors × horizontals × verticals
- Address format: `{CORRIDOR}-{HH padded}-{V}`
- `total_labels = ceil(total / 2)` (small labels fit 2 per label)
- Corridor range supports: single letter (A-Z), numeric ranges, or single value

**Errors:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ error: "Corredor início e fim são obrigatórios" }` | Missing corridors |
| 400 | `{ error: "Horizontal e vertical início/fim são obrigatórios" }` | Missing range numbers |
| 400 | `{ error: "Horizontal início deve ser <= fim" }` | Invalid range |
| 400 | `{ error: "Vertical início deve ser <= fim" }` | Invalid range |
| 401 | | Invalid session |
| 500 | | Generation error |

---

### `POST /api/etiquetas-endereco/imprimir`

**File:** `src/app/api/etiquetas-endereco/imprimir/route.ts`
**Auth:** Session required (any logged-in user)

Generates ZPL and sends print job to PrintNode.

**Request Body:**
```json
{
  "corredor_inicio": "A",
  "corredor_fim": "B",
  "horizontal_inicio": 1,
  "horizontal_fim": 5,
  "vertical_inicio": 1,
  "vertical_fim": 3,
  "tipo": "pequena | grande",
  "printer_id": 12345
}
```

**Response 200:**
```json
{
  "ok": true,
  "job_id": 67890,
  "total_labels": 15
}
```

**Business Logic:**
- Generates addresses, then ZPL based on `tipo`:
  - `pequena`: 100mm×23mm, 2 addresses/label (`gerarZplPequena`)
  - `grande`: 4"×6", 1 address/label, rotated 90° (`gerarZplGrande`)
- `total_labels`: pequena = `ceil(total/2)`, grande = `total`
- Printer resolution:
  - `pequena`: `printer_id` required in body
  - `grande`: `printer_id` optional — falls back to `resolverImpressora(userId, galpaoId)`
- Sends ZPL via `enviarImpressaoZpl()` to PrintNode API
- PrintNode API key from `siso_configuracoes` (key: `printnode_api_key`)

**Side Effects:**
- Sends print job to PrintNode (external API call)
- Logs successful print to `siso_logs`

**Errors:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ error: "Corredor início e fim são obrigatórios" }` | Missing corridors |
| 400 | `{ error: "Horizontal e vertical início/fim são obrigatórios" }` | Missing ranges |
| 400 | `{ error: "Horizontal início deve ser <= fim" }` | Invalid range |
| 400 | `{ error: "Vertical início deve ser <= fim" }` | Invalid range |
| 400 | `{ error: "Tipo deve ser 'pequena' ou 'grande'" }` | Invalid tipo |
| 400 | `{ error: "Nenhum endereço gerado..." }` | Empty result |
| 400 | `{ error: "Nenhuma impressora configurada" }` | No printer |
| 400 | `{ error: "PrintNode API key não configurada" }` | No API key |
| 401 | | Invalid session |
| 500 | | Print error |
