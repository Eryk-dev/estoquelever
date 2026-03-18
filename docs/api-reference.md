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
- [Dashboard & Monitoring](#dashboard--monitoring)
- [Admin - Usuarios](#admin---usuarios)
- [Admin - Galpoes](#admin---galpoes)
- [Admin - Empresas](#admin---empresas)
- [Admin - Grupos](#admin---grupos)
- [Admin - PrintNode](#admin---printnode)
- [Tiny ERP](#tiny-erp)

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
    "etiqueta_pronta": false
  }],
  "empresas": [{ "id": "uuid", "nome": "NetAir" }]
}
```

**Role filtering:**
- `admin` -> sees all
- `operador_cwb` -> sees only pedidos where empresa's galpao = CWB
- `operador_sp` -> sees only pedidos where empresa's galpao = SP

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

**Validation:** Parent pedido must be `em_separacao`.

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

Returns purchase items grouped by supplier and status.

**Query Params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | `aguardando_compra` | `aguardando_compra`, `comprado`, `excecoes` (`indisponivel` ainda aceito por compatibilidade) |
| `cargo` | string | - | User cargo for auth check |

**Response 200:**
```json
{
  "counts": { "aguardando_compra": 5, "comprado": 2, "indisponivel": 1 },
  "data": [...]
}
```

**Data shapes by status:**

**`aguardando_compra`:** Array grouped by supplier + company:
```json
[{
  "fornecedor": "ACA",
  "empresa_id": "uuid",
  "empresa_nome": "NetAir",
  "itens": [{
    "sku": "19ABC",
    "descricao": "Filtro",
    "imagem": "https://...",
    "quantidade_total": 5,
    "fornecedor_oc": "ACA",
    "pedidos": [{ "pedido_id": "123", "numero_pedido": "12345", "quantidade": 2 }],
    "itens_ids": ["uuid1", "uuid2"]
  }]
}]
```

Groups are split by `fornecedor + empresa_origem_id` so the buyer can see which empresa needs each purchase.

**`comprado`:** Array of OCs with items:
```json
[{
  "id": "uuid",
  "fornecedor": "ACA",
  "empresa_id": "uuid",
  "status": "comprado",
  "comprado_por_nome": "Eryk",
  "comprado_em": "2026-03-17T...",
  "total_itens": 3,
  "itens_recebidos": 1,
  "itens": [{ "id": "uuid", "sku": "19ABC", "quantidade": 2, "compra_status": "comprado", "compra_quantidade_recebida": 0 }]
}]
```

**`excecoes`:** Flat array of itens com `compra_status` em `indisponivel`, `equivalente_pendente` ou `cancelamento_pendente`.

Cada item de exceção inclui, além dos dados básicos, campos como:
- `compra_status`
- `empresa_nome`
- `compra_equivalente_sku`
- `compra_equivalente_descricao`
- `compra_equivalente_fornecedor`
- `compra_equivalente_observacao`
- `compra_cancelamento_motivo`

---

### `POST /api/compras/ordens`

**File:** `src/app/api/compras/ordens/route.ts`
**Auth:** `cargo` in body (admin or comprador)

Creates an OC and links all aguardando items for that supplier within one company.

**Request Body:**
```json
{
  "fornecedor": "ACA",
  "empresa_id": "uuid",
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
  "itens_vinculados": 5
}
```

**Business Logic:** If items already have an auto-created OC, updates it to `comprado` instead of creating new one. Links only items for the requested `fornecedor` inside the requested `empresa_id`.

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
- Calls `movimentarEstoque(tipo: "E")` in Tiny for each item with `produto_id_tiny`
- Updates `compra_quantidade_recebida`, marks `recebido` when fully received
- Updates OC status: `parcialmente_recebido` or `recebido`
- Checks if pedidos can be released via `checkAndReleasePedidos` (itens `cancelado` contam como resolvidos; pedidos com todos os itens cancelados não são liberados)
- 500ms delay between Tiny API calls

---

### `GET /api/compras/conferencia/[ordemCompraId]`

**File:** `src/app/api/compras/conferencia/[ordemCompraId]/route.ts`
**Auth:** `cargo` query param (admin or comprador)

Returns OC info + pending items for receiving screen.

**Response 200:**
```json
{
  "ordem_compra": {
    "id": "uuid",
    "fornecedor": "ACA",
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
