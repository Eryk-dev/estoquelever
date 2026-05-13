# SISO API Reference - Complete

This is the **authoritative, comprehensive reference** for every API route in the SISO system. Use this before reading route source code or making API changes.

**Last updated:** 2026-05-07

---

## Table of Contents

1. [Webhook API](#webhook-api)
2. [Authentication API](#authentication-api)
3. [Pedidos API](#pedidos-api)
4. [Separação API](#separação-api)
5. [Compras API](#compras-api)
6. [Inventário API](#inventário-api)
7. [Transferência API](#transferência-api)
8. [Etiquetas API](#etiquetas-api)
9. [Admin API](#admin-api)
10. [Tiny ERP API](#tiny-erp-api)
11. [Worker & Background Jobs](#worker--background-jobs)
12. [Dashboard & Monitoring](#dashboard--monitoring)
13. [Reconciliation API](#reconciliation-api)
14. [Cross — Busca de produtos e equivalência](#cross--busca-de-produtos-e-equivalência)

**Total API Routes Documented:** 100+ endpoints across all sections

---

## Webhook API

### POST /api/webhook/tiny

**File:** `src/app/api/webhook/tiny/route.ts`

**Purpose:** Receives webhooks from Tiny ERP when orders or invoices are updated. Deduplicates by order ID + type + situation.

**Auth:** None (webhook from external system)

**Request Body:**
```json
{
  "tipo": "atualizacao_pedido" | "inclusao_pedido" | "nota_fiscal",
  "cnpj": "string",
  "dados": {
    "id": "string (pedido ID)",
    "codigoSituacao": "aprovado" | "cancelado" | "...",
    ...other fields
  }
}
```

**Response (200 - Queued for processing):**
```json
{
  "status": "queued" | "duplicate" | "cancelled" | "cancelled_unknown",
  "pedidoId": "string",
  "empresaId": "string",
  "galpao": "string",
  "webhookLogId": "string"
}
```

**Response (400 - Validation error):**
```json
{
  "error": "string"
}
```

**Business Logic:**
- Validates payload (tipo, cnpj, dados required)
- Resolves empresa by CNPJ
- Deduplicates via unique index on (pedido_id, tipo, situacao)
- For "nota_fiscal" webhooks: delegates to `handleNfWebhook` (fire-and-forget)
- For "atualizacao_pedido" / "inclusao_pedido":
  - If `codigoSituacao = "cancelado"`: cancels order, cleans up compras items, marks execution job as cancelled
    - **WMS Plano 3:** se `estoque_lancado=false` (pré-separado), chama `liberarReserva` (L com estorno_de=R.id) — release as reservas do ledger
    - **WMS Plano 3:** se `estoque_lancado=true` (pós-separado), chama `estornarSaidasPedido` (E com origem=cancelamento_nf, estorno_de=S.id) e seta `compra_estoque_lancado_alerta=true` pra alerta UI
  - If `codigoSituacao = "aprovado"`: enqueues `processWebhook` (fire-and-forget) which fetches order, enriches stock across all empresas in grupo, calculates suggestion, saves to DB
- Returns 200 immediately (async processing)

**Side Effects:**
- Inserts to `siso_webhook_logs` (dedup on unique constraint)
- For cancellations: updates `siso_pedidos.status`, `siso_fila_execucao.status`, cleans up `siso_pedido_itens.compra_*` fields
- For approvals: enqueues async `processWebhook` task
- Logs to `siso_logs` (info/warn), `siso_erros` (on critical failures)

**Rate Limiting:** None

**Notes:**
- Webhook receiver must respond quickly (returns 200 immediately)
- Processing happens asynchronously in `processWebhook`
- NF webhooks are handled separately to transition `aguardando_nf` → `aguardando_separacao`

---

### POST /api/webhook/reprocessar

**File:** `src/app/api/webhook/reprocessar/route.ts`

**Purpose:** Reprocesses failed webhook logs (status = 'pendente' after manual reset). Used to recover from bugs that have since been fixed.

**Auth:** None (internal use)

**Request Body:** Empty

**Response (200):**
```json
{
  "message": "Nenhum webhook pendente para reprocessar" | "...",
  "count": 0,
  "reprocessed": [
    {
      "pedidoId": "string",
      "status": "ok" | "erro",
      "erro": "string (if status=erro)"
    }
  ]
}
```

**Business Logic:**
- Fetches all logs with `status = 'pendente'` and `codigo_situacao = 'aprovado'`
- Calls `processWebhook` for each in order (oldest first)
- Attempts to resolve empresa from CNPJ or stored empresa_id
- Falls back to fetching empresa_id if not found
- Returns results array with status per pedido

**Side Effects:**
- Calls `processWebhook` for each log (same side effects as webhook POST)
- Logs to `siso_logs`

---

## Authentication API

### POST /api/auth/login

**File:** `src/app/api/auth/login/route.ts`

**Purpose:** PIN-based user authentication. Creates a server-side session.

**Auth:** None

**Request Body:**
```json
{
  "nome": "string",
  "pin": "string (4 digits)"
}
```

**Response (200 - Success):**
```json
{
  "ok": true,
  "usuario": {
    "id": "uuid",
    "nome": "string",
    "cargo": "string",
    "cargos": ["string"],
    "galpoes": [
      {
        "id": "uuid",
        "nome": "string"
      }
    ]
  },
  "sessionId": "uuid"
}
```

**Response (400 - Invalid input):**
```json
{
  "ok": false,
  "erro": "Nome e PIN são obrigatórios"
}
```

**Response (401 - Auth failed):**
```json
{
  "ok": false,
  "erro": "Usuário não encontrado" | "PIN incorreto"
}
```

**Response (403 - User inactive):**
```json
{
  "ok": false,
  "erro": "Usuário desativado"
}
```

**Business Logic:**
- Validates nome and pin are provided
- Fetches user from `siso_usuarios` by nome
- Compares plain-text PIN (no hashing currently)
- Checks `ativo` flag
- Fetches user's allowed galpões from `siso_usuario_galpoes`
- Creates server-side session in `siso_sessoes`
- Returns sessionId for client to store in localStorage
- Normalizes cargos (single cargo column → cargos array)

**Side Effects:**
- Inserts to `siso_sessoes` (id, usuario_id, expira_em)
- Logs to `siso_logs` on errors

**Rate Limiting:** None (but consider adding)

**Notes:**
- Client stores sessionId in localStorage and sends as `X-Session-Id` header on subsequent requests
- Server validates session before allowing route access via `getSessionUser()`

---

## Pedidos API

### GET /api/pedidos

**File:** `src/app/api/pedidos/route.ts`

**Purpose:** List orders with stock enrichment and status information.

**Auth:** None

**Query Params:**
- `status`: comma-separated filter (e.g., "pendente,executando")

**Response (200):**
```json
[
  {
    "id": "string",
    "numero": "string",
    "data": "ISO datetime",
    "filialOrigem": "string (galpao name)",
    "empresaOrigemId": "uuid",
    "empresaOrigemNome": "string",
    "idPedidoEcommerce": "string",
    "nomeEcommerce": "string",
    "cliente": {
      "nome": "string",
      "cpfCnpj": "string"
    },
    "formaEnvio": {
      "id": "string",
      "descricao": "string"
    },
    "itens": [
      {
        "itemId": "uuid",
        "produtoId": "number",
        "sku": "string",
        "descricao": "string",
        "quantidadePedida": "number",
        "estoques": {
          "[galpao_name]": {
            "deposito": {
              "id": "number",
              "nome": "string",
              "saldo": "number",
              "reservado": "number",
              "disponivel": "number"
            },
            "atende": "boolean (disponivel >= quantidadePedida)",
            "localizacao": "string | null"
          }
        },
        "fornecedorOC": "string | null",
        "imagemUrl": "string | null"
      }
    ],
    "sugestao": "propria" | "transferencia" | "oc",
    "sugestaoMotivo": "string",
    "status": "pendente" | "executando" | "concluido" | "cancelado" | "erro",
    "tipoResolucao": "string | null",
    "decisaoFinal": "propria" | "transferencia" | "oc" | null",
    "operador": "string | null",
    "processadoEm": "ISO datetime | null",
    "marcadores": ["string"],
    "erro": "string | null",
    "criadoEm": "ISO datetime"
  }
]
```

**Business Logic:**
- Fetches up to 200 orders from `siso_pedidos`
- Joins `siso_pedido_itens` for item details
- Joins `siso_pedido_item_estoques` (normalized stock) to aggregate by galpão
- For each item, aggregates stock across all empresas in the same galpão
- Maps stock to dynamic galpão-keyed structure (supports any number of galpões)
- Filters by status if provided

**Side Effects:** None (read-only)

**Rate Limiting:** None

**Notes:**
- Stock is normalized in `siso_pedido_item_estoques` (one row per empresa per product)
- API aggregates to galpão level for display
- Supports any number of galpões (not hardcoded CWB/SP)

---

### POST /api/pedidos/aprovar

**File:** `src/app/api/pedidos/aprovar/route.ts`

**Purpose:** Operator approves a pending order with a decision. Moves order to "executando" state and enqueues stock posting.

**Auth:** X-Session-Id header (optional role check could be added)

**Request Body:**
```json
{
  "pedidoId": "string",
  "decisao": "propria" | "transferencia" | "oc",
  "operadorId": "string | null",
  "operadorNome": "string | null"
}
```

**Response (200 - Success):**
```json
{
  "ok": true,
  "pedidoId": "string",
  "decisao": "string",
  "filialExecucao": "string",
  "empresaExecucaoId": "string",
  "status": "executando"
}
```

**Response (400 - Invalid decision):**
```json
{
  "error": "Decisão inválida. Use: propria, transferencia, oc"
}
```

**Response (404 - Order not found):**
```json
{
  "error": "Pedido não encontrado"
}
```

**Response (409 - Order not pending):**
```json
{
  "error": "Pedido não está pendente (status: ...)"
}
```

**Response (422 - Missing empresa):**
```json
{
  "error": "Pedido sem empresa_origem_id — reprocessar webhook"
}
```

**Business Logic:**
- Fetches pedido, validates status = "pendente"
- Validates empresa_origem_id exists
- Resolves empresa_origem and determines filial_origem (galpão name)
- **For decisao = "propria" or "oc":**
  - empresaExecucaoId = pedido.empresa_origem_id
  - filialExecucao = empresa_origem.galpaoNome
  - separacaoGalpaoId = empresa_origem.galpaoId
- **For decisao = "transferencia":**
  - Finds another empresa in same grupo with different galpão
  - If found: uses that empresa for execution
  - If not found: falls back to origin empresa (with warning)
- Sets status = "executando", decisao_final, tipo_resolucao = "manual"
- Sets separacao_status = "aguardando_separacao" (if NF already arrived) or "aguardando_nf"
- Builds marcadores: ["OC", filialOrigem] for OC decisions, else [filialExecucao]
- Enqueues job to `siso_fila_execucao` (type: "lancar_estoque", empresa_id, decisao)
- Records event to `siso_pedido_historico`
- Kicks worker singleton to process queue

**Side Effects:**
- Updates `siso_pedidos.status`, `decisao_final`, `operador_*`, `tipo_resolucao`, `marcadores`, `separacao_galpao_id`, `status_separacao`
- Inserts to `siso_fila_execucao`
- Inserts to `siso_pedido_historico`
- Kicks async worker via `kickWorker()`
- Logs to `siso_logs`

**Rate Limiting:** None

**Notes:**
- Fire-and-forget pattern: returns 200 immediately, processing happens in background
- Decision logic determines which empresa will execute (physical separation/shipment)
- For transferência: tries to find support empresa in another galpão

---

### GET /api/pedidos/[id]/historico

**File:** `src/app/api/pedidos/[id]/historico/route.ts`

**Purpose:** Returns the full audit trail for an order, sorted chronologically.

**Auth:** None

**Response (200):**
```json
{
  "historico": [
    {
      "id": "uuid",
      "evento": "string (e.g., 'aprovado', 'separacao_iniciada')",
      "usuario_id": "uuid | null",
      "usuario_nome": "string | null",
      "detalhes": "json | null",
      "criado_em": "ISO datetime"
    }
  ]
}
```

**Business Logic:**
- Fetches all rows from `siso_pedido_historico` for the given pedido_id
- Orders by criado_em ascending (chronological)
- Returns all events

**Side Effects:** None (read-only)

**Rate Limiting:** None

---

### GET /api/pedidos/[id]/observacoes

**File:** `src/app/api/pedidos/[id]/observacoes/route.ts`

**Purpose:** Returns all observations (comments) for an order.

**Auth:** None

**Response (200):**
```json
[
  {
    "id": "uuid",
    "pedidoId": "string",
    "usuarioId": "string",
    "usuarioNome": "string",
    "texto": "string",
    "criadoEm": "ISO datetime"
  }
]
```

**Business Logic:**
- Fetches all rows from `siso_pedido_observacoes` for the given pedido_id
- Orders by criado_em ascending (oldest first)

**Side Effects:** None (read-only)

---

### POST /api/pedidos/[id]/observacoes

**File:** `src/app/api/pedidos/[id]/observacoes/route.ts`

**Purpose:** Create a new observation (comment) on an order.

**Auth:** None

**Request Body:**
```json
{
  "usuarioId": "string",
  "usuarioNome": "string",
  "texto": "string"
}
```

**Response (201 - Created):**
```json
{
  "id": "uuid",
  "pedidoId": "string",
  "usuarioId": "string",
  "usuarioNome": "string",
  "texto": "string",
  "criadoEm": "ISO datetime"
}
```

**Response (400 - Missing fields):**
```json
{
  "error": "usuarioId, usuarioNome e texto são obrigatórios"
}
```

**Business Logic:**
- Validates all three fields are provided
- Trims texto
- Inserts to `siso_pedido_observacoes`

**Side Effects:**
- Inserts to `siso_pedido_observacoes`
- Logs on error

---

### POST /api/pedidos/[id]/liberar-reserva

**File:** `src/app/api/pedidos/[id]/liberar-reserva/route.ts`

**Purpose:** Admin-only override que libera todas as reservas WMS do pedido e o reseta pra pendente. Quando estoque já foi lançado (cutover R→S rodou), lança entradas compensatórias (E) antes pra zerar a posição.

**Auth:** X-Session-Id (required) + `cargos.includes("admin")`

**Request Body (opcional):**
```json
{ "motivo": "string" }
```

**Response (200):**
```json
{
  "ok": true,
  "pedido_id": "string",
  "reservas_liberadas": 2,
  "saidas_revertidas": 0,
  "alerta_estoque_lancado": false
}
```

**Response (403):** `{ "error": "Apenas admin pode liberar reservas manualmente" }`
**Response (404):** `{ "error": "Pedido não encontrado" }`
**Response (400):** `{ "error": "Pedido cancelado — use webhook de cancel pra liberar" }`

**Business Logic:**
- Se `estoque_lancado=true`: chama `estornarSaidasPedido` (E com origem=cancelamento_nf, estorno_de=S.id) e seta `compra_estoque_lancado_alerta=true`
- Sempre chama `liberarReserva` (L com origem=liberacao_reserva, estorno_de=R.id, motivo=ajuste_admin)
- Reseta pedido pra pendente (decisao_final, status_separacao, estoque_lancado limpos; NF/etiquetas preservadas)
- Reset item-level (separacao_marcado, quantidade_bipada, estoque_saida_lancada)
- Registra evento `status_revertido` com detalhes em siso_pedido_historico

**Side Effects:**
- Insere L (e opcionalmente E) em `siso_movimentacoes`
- UPDATE em `siso_pedidos` e `siso_pedido_itens`
- INSERT em `siso_pedido_historico`

---

### GET /api/pedidos/tracking

**File:** `src/app/api/pedidos/tracking/route.ts`

**Purpose:** Paginated list of pedidos for the universal tracking page. Returns pedido summary data with combined status, empresa/galpao names, search, and advanced filters.

**Auth:** X-Session-Id (required)

**Query Params:**
- `page`: page number (default 1)
- `limit`: items per page (default 50, max 200)
- `data_inicio`: start date filter (ISO date string, default 30 days ago)
- `data_fim`: end date filter (ISO date string, default today)
- `busca`: text search — matches numero, id_pedido_ecommerce, cliente_nome (ilike), and item SKU (subquery on siso_pedido_itens)
- `status`: comma-separated status filter (e.g. "pendente,concluido")
- `status_separacao`: comma-separated status_separacao filter
- `decisao`: comma-separated decisao_final filter
- `empresa_origem_id`: filter by origin empresa UUID
- `marketplace`: ilike filter on nome_ecommerce
- `tab`: "expedidos" for final-state orders (embalado+impresso or cancelado), default shows all other orders

**Response (200):**
```json
{
  "pedidos": [
    {
      "id": "uuid",
      "numero": "string",
      "id_pedido_ecommerce": "string",
      "nome_ecommerce": "string",
      "cliente_nome": "string",
      "cliente_cpf_cnpj": "string",
      "data": "ISO date",
      "status": "pendente | executando | concluido | cancelado | erro",
      "status_separacao": "string | null",
      "sugestao": "propria | transferencia | oc",
      "decisao_final": "string | null",
      "tipo_resolucao": "string | null",
      "operador": "string | null",
      "empresa_origem_nome": "string | null",
      "filial_origem": "string | null (galpao name)",
      "marcadores": ["string"],
      "separacao_tags": ["string"],
      "etiqueta_status": "string | null",
      "embalagem_concluida_em": "ISO datetime | null",
      "criado_em": "ISO datetime",
      "erro": "string | null"
    }
  ],
  "total": "number",
  "page": "number",
  "totalPages": "number"
}
```

**Response (401):**
```json
{
  "error": "sessao_invalida"
}
```

**Business Logic:**
- Validates session via `getSessionUser()`
- Default date filter: last 30 days (overridable with data_inicio/data_fim)
- Role-based filtering: admin sees all, comprador sees only decisao_final='oc', operador sees only pedidos from empresas in their galpao
- SKU search: pre-fetches matching pedido_ids from `siso_pedido_itens`, then includes in OR filter
- Tab "expedidos": filters to (status_separacao=embalado AND etiqueta_status=impresso) OR status=cancelado
- Default tab: excludes expedidos — NOT cancelado AND NOT (embalado+impresso)
- Joins siso_empresas → siso_galpoes for empresa/galpao names
- Pagination via `.range()`, count via separate head query in parallel

**Side Effects:** None (read-only)

**Rate Limiting:** None

---

### GET /api/pedidos/[id]/detalhe

**File:** `src/app/api/pedidos/[id]/detalhe/route.ts`

**Purpose:** Returns all consolidated data for a single pedido: base data, items with stock per galpao, historico (audit trail), and observacoes (comments).

**Auth:** X-Session-Id (required)

**Path Params:**
- `id`: pedido UUID

**Response (200):**
```json
{
  "id": "uuid",
  "numero": "string",
  "id_pedido_ecommerce": "string",
  "nome_ecommerce": "string",
  "cliente_nome": "string",
  "cliente_cpf_cnpj": "string",
  "data": "ISO date",
  "status": "string",
  "status_separacao": "string | null",
  "sugestao": "string",
  "decisao_final": "string | null",
  "tipo_resolucao": "string | null",
  "operador": "string | null",
  "empresa_origem_id": "uuid | null",
  "empresa_origem_nome": "string | null",
  "filial_origem": "string | null",
  "forma_envio": "string | null",
  "forma_frete_id": "string | null",
  "transportador_id": "string | null",
  "encaminhado_de": "string | null",
  "processado_em": "ISO datetime | null",
  "separacao_operador_id": "uuid | null",
  "separacao_iniciada_em": "ISO datetime | null",
  "separacao_concluida_em": "ISO datetime | null",
  "embalagem_concluida_em": "ISO datetime | null",
  "etiqueta_status": "string | null",
  "etiqueta_url": "string | null",
  "agrupamento_expedicao_id": "string | null",
  "compra_estoque_lancado_alerta": "boolean | null",
  "marcadores": ["string"],
  "separacao_tags": ["string"],
  "erro": "string | null",
  "criado_em": "ISO datetime",
  "itens": [
    {
      "id": "uuid",
      "produto_id": "number",
      "sku": "string",
      "descricao": "string",
      "quantidade": "number",
      "imagem_url": "string | null",
      "fornecedor_oc": "string | null",
      "compra_status": "string | null",
      "compra_quantidade_solicitada": "number | null",
      "compra_quantidade_comprada": "number | null",
      "compra_quantidade_recebida": "number | null",
      "separacao_marcado": "boolean",
      "bipado_completo": "boolean",
      "localizacao": "string | null",
      "estoques": {
        "[galpao_name]": {
          "deposito": {
            "id": "number",
            "nome": "string",
            "saldo": "number",
            "reservado": "number",
            "disponivel": "number"
          },
          "atende": "boolean",
          "localizacao": "string | null"
        }
      }
    }
  ],
  "historico": [
    {
      "id": "uuid",
      "evento": "string",
      "usuario_id": "uuid | null",
      "usuario_nome": "string | null",
      "detalhes": "object | null",
      "criado_em": "ISO datetime"
    }
  ],
  "observacoes": [
    {
      "id": "uuid",
      "usuario_id": "uuid | null",
      "usuario_nome": "string | null",
      "texto": "string",
      "criado_em": "ISO datetime"
    }
  ]
}
```

**Response (401):**
```json
{
  "error": "sessao_invalida"
}
```

**Response (403):**
```json
{
  "error": "Acesso negado"
}
```

**Response (404):**
```json
{
  "error": "Pedido não encontrado"
}
```

**Business Logic:**
- Validates session via `getSessionUser()`
- Fetches pedido with empresa/galpao JOIN, returns 404 if not found (PGRST116 code)
- Role-based access: admin sees all, comprador only sees decisao_final='oc', operador only sees pedidos from their galpao
- Fetches itens, estoques, historico, observacoes in parallel via Promise.all
- Stock aggregated from `siso_pedido_item_estoques` by galpao (dynamic, not hardcoded)
- Items include per-galpao stock with `atende` boolean (disponivel >= quantidade)
- Historico ordered ascending (oldest first), observacoes ordered ascending

**Side Effects:** None (read-only)

**Rate Limiting:** None

---

## Separação API

### GET /api/separacao

**File:** `src/app/api/separacao/route.ts`

**Purpose:** List orders filtered by separation status with aggregated item counts. Galpão-aware.

**Auth:** X-Session-Id (required, filters by separacao_galpao_id if user has galpaoId)

**Query Params:**
- `status_separacao`: comma-separated list of statuses — "aguardando_compra" | "aguardando_nf" | "validacao_oc" | "aguardando_separacao" | "em_separacao" | "separado" | "embalado". Multiple values supported (e.g., "aguardando_compra,validacao_oc")
- `empresa_origem_id`: filter by origin empresa
- `marketplace`: filter by e-commerce name (ilike)
- `busca`: search numero, id_pedido_ecommerce, cliente_nome (ilike)
- `tag`: filter by separacao_tags

**Response (200):**
```json
{
  "counts": {
    "aguardando_compra": "number",
    "aguardando_nf": "number",
    "validacao_oc": "number",
    "aguardando_separacao": "number",
    "em_separacao": "number",
    "separado": "number",
    "embalado": "number"
  },
  "pedidos": [
    {
      "id": "string",
      "numero_nf": "string",
      "numero_ec": "string",
      "numero_pedido": "string",
      "cliente": "string",
      "nome_ecommerce": "string | null",
      "uf": "string | null",
      "cidade": "string | null",
      "forma_envio": "string",
      "data_pedido": "ISO date",
      "embalagem_concluida_em": "ISO datetime | null",
      "empresa_origem_nome": "string | null",
      "filial_origem": "string | null",
      "galpao_id": "uuid | null",
      "decisao_final": "string | null",
      "status_separacao": "string",
      "marcadores": ["string"],
      "separacao_tags": ["string"],
      "total_itens": "number",
      "itens_marcados": "number (separacao_marcado = true)",
      "itens_bipados": "number (bipado_completo = true)",
      "compra_stats": {
        "total": "number",
        "aguardando": "number",
        "comprado": "number",
        "recebido": "number",
        "indisponivel": "number",
        "equivalente_pendente": "number",
        "cancelamento_pendente": "number",
        "itens": [
          {
            "sku": "string",
            "descricao": "string",
            "quantidade": "number",
            "compra_status": "string | null",
            "fornecedor_oc": "string | null"
          }
        ]
      } | null,
      "etiqueta_status": "string | null",
      "etiqueta_pronta": "boolean (!!etiqueta_zpl)"
    }
  ],
  "empresas": [
    {
      "id": "uuid",
      "nome": "string"
    }
  ]
}
```

**Response (200 - No galpão selected):**
```json
{
  "counts": { all zeros },
  "pedidos": [],
  "empresas": [],
  "error": "galpao_nao_selecionado"
}
```

**Business Logic:**
- Validates status_separacao if provided
- Fetches counts per status (using exact count queries to bypass max_rows limit)
- Builds filters: activeGalpaoId (from session), empresaFilter, marketplaceFilter, busca, tagFilter
- Fetches orders not in "estado" (status_separacao is null) if querying separation module
- For each pedido, computes:
  - total_itens, itens_marcados, itens_bipados (from siso_pedido_itens)
  - compra_stats for OC orders (aggregate compra_status counters and items)
- Fetches distinct origin empresas visible in the current separation context
- Returns pedidos sorted by data (ascending) unless status = "embalado" (descending by embalagem_concluida_em)

**Side Effects:** None (read-only)

**Rate Limiting:** None

**Notes:**
- Galpão filtering: session.galpaoId determines visible orders via separacao_galpao_id
- Admins see all galpões
- Operators see only their assigned galpão
- compra_stats only present for orders with compra_status items

---

### POST /api/separacao/iniciar

**File:** `src/app/api/separacao/iniciar/route.ts`

**Purpose:** Start separation for selected orders. Moves to "em_separacao" and returns consolidated product checklist for wave picking. Pre-creates Tiny agrupamentos and caches ZPL labels.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "pedido_ids": ["string"],
  "operador_id": "string"
}
```

**Response (200):**
```json
{
  "pedido_ids": ["string"],
  "produtos": [
    {
      "produto_id": "string",
      "descricao": "string",
      "sku": "string",
      "gtin": "string | null",
      "quantidade_total": "number",
      "unidade": "string",
      "localizacao": "string | null"
    }
  ]
}
```

**Response (400 - Invalid status):**
```json
{
  "error": "todos os pedidos devem estar com status 'aguardando_separacao', 'aguardando_compra' ou 'em_separacao'",
  "pedido_ids": ["string"],
  "statuses": ["string"]
}
```

**Response (404 - Orders not found):**
```json
{
  "error": "pedidos não encontrados",
  "pedido_ids": ["string"]
}
```

**Business Logic:**
- Validates pedido_ids is non-empty array of strings
- Fetches all pedidos, validates ALL have status_separacao = "aguardando_separacao", "aguardando_compra", or "em_separacao"
- Filters pedidos with status = "aguardando_separacao" or "aguardando_compra" (ignores already "em_separacao")
- Updates those to "em_separacao" with separacao_operador_id and separacao_iniciada_em
- Calls RPC `siso_consolidar_produtos_separacao` to get consolidated product list (aggregates by SKU/localizacao)
- Returns consolidated products sorted by localizacao
- Fire-and-forget: calls `preCriarAgrupamentosEmLote` to pre-create Tiny agrupamentos and download ZPL labels early

**Side Effects:**
- Updates `siso_pedidos.status_separacao`, `separacao_operador_id`, `separacao_iniciada_em`
- Inserts to `siso_pedido_historico`
- Fire-and-forget: calls `preCriarAgrupamentosEmLote` (creates agrupamentos in Tiny, downloads ZPL)
- Logs to `siso_logs`

**Rate Limiting:** None

**Notes:**
- Consolidated products are for wave picking checklist
- Agrupamento pre-creation happens async to cache labels before packing

---

### POST /api/separacao/bipar

**File:** `src/app/api/separacao/bipar/route.ts`

**Purpose:** Process a barcode scan (GTIN or SKU) to confirm item separation. Calls atomic RPC function siso_processar_bip.

**Auth:** X-Session-Id (required), user must have galpaoId (not admin)

**Request Body:**
```json
{
  "codigo": "string"
}
```

**Response (200 - Partial):**
```json
{
  "status": "parcial",
  "pedido_id": "string",
  "pedido_numero": "number | null",
  "produto_id": "number",
  "sku": "string",
  "bipados": "number",
  "total": "number",
  "itens_faltam": "number"
}
```

**Response (200 - Item complete):**
```json
{
  "status": "item_completo",
  "pedido_id": "string",
  "pedido_numero": "number | null",
  "produto_id": "number",
  "sku": "string",
  "itens_faltam": "number"
}
```

**Response (200 - Order complete, label printed):**
```json
{
  "status": "pedido_completo",
  "pedido_id": "string",
  "pedido_numero": "number | null",
  "etiqueta_status": "impresso" | "falhou",
  "etiqueta_erro": "string | null"
}
```

**Response (404 - Item not found):**
```json
{
  "error": "item_nao_encontrado",
  "codigo": "string"
}
```

**Response (409 - Item already complete):**
```json
{
  "error": "item_ja_completo",
  "pedido_id": "string",
  "sku": "string"
}
```

**Response (429 - Rate limited):**
```json
{
  "error": "rate_limit"
}
```

**Business Logic:**
- Rate limit: max 2 bips/second per session
- Validates user has galpaoId (operators only, not admins)
- Calls RPC `siso_processar_bip` (atomic, finds item by GTIN or SKU, increments quantidade_bipada)
- RPC returns status: "parcial", "item_completo", "pedido_completo", "nao_encontrado", "ja_completo"
- On "pedido_completo": calls `buscarEImprimirEtiqueta` to print shipping label

**Side Effects:**
- RPC atomically updates `siso_pedido_itens.quantidade_bipada`, `bipado_completo`
- On completion: calls label printing (may update `siso_pedidos.etiqueta_*`)
- Logs to `siso_logs`

**Rate Limiting:** 2 bips/second per session (checkBipRateLimit)

**Notes:**
- Atomic RPC ensures no race conditions
- Barcode can be GTIN or SKU
- When order is complete, label is printed immediately

---

### POST /api/separacao/bipar-checklist

**File:** `src/app/api/separacao/bipar-checklist/route.ts`

**Purpose:** Scan a barcode during wave-picking to auto-check matching items across given pedidos.

**Auth:** None

**Request Body:**
```json
{
  "sku": "string",
  "pedido_ids": ["string"]
}
```

**Response (200):**
```json
[
  {
    "id": "uuid",
    "pedido_id": "string",
    "sku": "string",
    "gtin": "string | null",
    "separacao_marcado": "boolean",
    "separacao_marcado_em": "ISO datetime | null",
    "compra_status": "string | null"
  }
]
```

**Response (404 - No items found):**
```json
{
  "error": "Nenhum item encontrado com este SKU/GTIN nos pedidos selecionados"
}
```

**Business Logic:**
- Tries to find items by SKU within the given pedidos
- If no SKU match, tries GTIN match
- Filters out items with compra_status = "cancelado"
- Marks all matching items as separacao_marcado = true
- Returns updated items

**Side Effects:**
- Updates `siso_pedido_itens.separacao_marcado`, `separacao_marcado_em` for matching items
- Logs to `siso_logs`

**Rate Limiting:** None

---

### POST /api/separacao/marcar-item

**File:** `src/app/api/separacao/marcar-item/route.ts`

**Purpose:** Toggle an item's separacao_marcado checkbox during wave-picking.

**Auth:** None

**Request Body:**
```json
{
  "pedido_item_id": "string",
  "marcado": "boolean"
}
```

**Response (200):**
```json
{
  "id": "uuid",
  "pedido_id": "string",
  "separacao_marcado": "boolean",
  "separacao_marcado_em": "ISO datetime | null",
  ...other fields
}
```

**Response (400 - Invalid pedido status):**
```json
{
  "error": "Pedido deve estar com status 'em_separacao' ou 'aguardando_separacao'",
  "status_atual": "string"
}
```

**Response (404 - Item or pedido not found):**
```json
{
  "error": "Item nao encontrado" | "Pedido nao encontrado"
}
```

**Business Logic:**
- Fetches item from `siso_pedido_itens`
- Validates parent pedido has status_separacao = "em_separacao" or "aguardando_separacao"
- Updates separacao_marcado and separacao_marcado_em (null if unmarked)

**Side Effects:**
- Updates `siso_pedido_itens.separacao_marcado`, `separacao_marcado_em`
- Logs on error

---

### POST /api/separacao/desfazer-bip

**File:** `src/app/api/separacao/desfazer-bip/route.ts`

**Purpose:** Undo a bip (decrement quantidade_bipada by 1), revert bipado_completo if needed, and revert pedido status if all bips are now zero.

**Auth:** X-Session-Id (required), user must have galpaoId

**Request Body:**
```json
{
  "pedido_id": "string",
  "produto_id": "number"
}
```

**Response (200):**
```json
{
  "pedido_id": "string",
  "produto_id": "number",
  "quantidade_bipada": "number",
  "bipado_completo": "boolean",
  "status_separacao": "string"
}
```

**Response (400 - No bips to undo):**
```json
{
  "error": "item não tem bips para desfazer"
}
```

**Response (403 - Wrong galpão):**
```json
{
  "error": "pedido não pertence ao seu galpão"
}
```

**Response (404 - Item or pedido not found):**
```json
{
  "error": "pedido não encontrado" | "item não encontrado neste pedido"
}
```

**Business Logic:**
- Validates pedido belongs to operator's galpão
- Fetches item, validates quantidade_bipada > 0
- Decrements quantidade_bipada by 1
- Recalculates bipado_completo (newBipada >= quantidade_pedida)
- If pedido.status_separacao = "embalado": reverts to "em_separacao"
- If all items have quantidade_bipada = 0: reverts to "aguardando_separacao"
- Clears etiqueta_status via RPC (PostgREST schema cache workaround)

**Side Effects:**
- Updates `siso_pedido_itens.quantidade_bipada`, `bipado_completo`
- May update `siso_pedidos.status_separacao`, `embalagem_concluida_em`, `separacao_operador_id`, `separacao_iniciada_em`
- RPC call to clear etiqueta_status
- Logs to `siso_logs`

---

### POST /api/separacao/concluir

**File:** `src/app/api/separacao/concluir/route.ts`

**Purpose:** Finish separation for selected orders. Only orders where ALL items have separacao_marcado = true are moved to 'separado'.

**Auth:** None

**Request Body:**
```json
{
  "pedido_ids": ["string"]
}
```

**Response (200):**
```json
{
  "separados": ["string"],
  "pendentes": ["string"]
}
```

**Business Logic:**
- Fetches all items for the given pedidos
- Groups by pedido_id, checks if ALL items have separacao_marcado = true
- Moves complete pedidos to status = "separado" with separacao_concluida_em
- Fire-and-forget: calls `preCriarAgrupamentosEmLote` (ensure agrupamentos exist)
- Fire-and-forget: calls `recarregarEtiquetasFaltantes` (re-download ZPL for pedidos missing cached labels)

**Side Effects:**
- Updates `siso_pedidos.status_separacao = "separado"`, `separacao_concluida_em`
- Inserts to `siso_pedido_historico`
- Fire-and-forget: pre-create agrupamentos and reload missing ZPL
- Logs to `siso_logs`

**Rate Limiting:** None

---

### POST /api/separacao/concluir-oc

**File:** `src/app/api/separacao/concluir-oc/route.ts`

**Purpose:** Complete OC separation (Pick OC flow). Auto-resolves pending compra items as received, resolves decisao (propria vs transferencia), enqueues execution job, and transitions directly to 'separado' with tag 'pick oc'. Used when the operator physically picks items before the formal purchase order cycle completes.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "pedido_ids": ["string"],
  "operador_id": "string (optional)"
}
```

**Response (200):**
```json
{
  "separados": ["string (pedido IDs successfully completed)"],
  "pendentes": ["string (pedido IDs with unmarked items)"]
}
```

**Response (401 - Unauthorized):**
```json
{
  "error": "Não autenticado"
}
```

**Response (400 - Validation):**
```json
{
  "error": "'pedido_ids' (string[]) é obrigatório"
}
```

**Business Logic:**
- Validates pedido_ids is non-empty array of strings
- Fetches all items from `siso_pedido_itens` for the given pedidos
- Groups by pedido_id, checks if ALL items have `separacao_marcado = true`
- Pedidos where any item is unmarked go to `pendentes[]`
- For fully-marked pedidos:
  1. **Auto-resolve OC items:** Updates items with `compra_status` NOT IN ('recebido', 'cancelado', null) → sets `compra_status = 'recebido'`, `compra_quantidade_recebida = compra_quantidade_solicitada`
  2. **Resolve decisao:** Compares OC galpao_id (from `siso_ordens_compra`) vs pedido origin galpao_id (from `siso_empresas`). Same galpao or no OC linked → `propria`. Different galpao → `transferencia`
  3. **Resolve separacao_galpao_id:** For `propria` uses origin galpao; for `transferencia` uses OC galpao. Finds first active empresa in that galpao for execution
  4. **Update pedido:** `decisao_final`, `status = 'executando'`, `status_separacao = 'separado'`, `separacao_concluida_em = now()`, `separacao_galpao_id`, appends `'pick oc'` to `separacao_tags`
  5. **Enqueue execution:** Inserts job in `siso_fila_execucao` with `tipo = 'lancar_estoque'`, `empresa_id`, `decisao`, `tentativas = 0`, `status = 'pendente'`
  6. **Fire-and-forget:** `kickWorker()`, `preCriarAgrupamentosEmLote()`, `recarregarEtiquetasFaltantes()`, `registrarEventos()` (event: `separacao_oc_concluida`)

**Side Effects:**
- Updates `siso_pedido_itens.compra_status`, `compra_quantidade_recebida` for OC items
- Updates `siso_pedidos.decisao_final`, `status`, `status_separacao`, `separacao_concluida_em`, `separacao_galpao_id`, `separacao_tags`
- Inserts to `siso_fila_execucao`
- Inserts to `siso_pedido_historico` (event: `separacao_oc_concluida`)
- Fire-and-forget: kicks execution worker, pre-creates agrupamentos (fallback), reloads missing ZPL labels (fast path for pedidos with pre-existing agrupamento from early fase-1)
- Logs to `siso_logs`, `siso_erros` (on failures)

**Rate Limiting:** None

**Notes:**
- This endpoint is the "shortcut" for Pick OC: operator physically picks items while compra flow is still pending, then this endpoint auto-resolves everything
- The execution worker then handles Tiny API calls (marcadores, stock posting, NF generation) asynchronously
- Unlike normal `concluir`, this also sets `status = 'executando'` and `decisao_final`, since these pedidos skip the approval flow
- With early agrupamento: OC pedidos typically arrive here with NF + agrupamento already created at approval time, so `recarregarEtiquetasFaltantes` provides the fast path (~200ms) for ZPL label caching

---

### GET /api/separacao/checklist-items?pedidos=id1,id2,id3

**File:** `src/app/api/separacao/checklist-items/route.ts`

**Purpose:** Fetch individual items for the given pedido IDs with localizacao and stock info. For transfers, resolves to the separating empresa (the one that will ship), not the origin empresa.

**Auth:** None

**Query Params:**
- `pedidos`: comma-separated pedido IDs (required)

**Response (200):**
```json
{
  "items": [
    {
      "id": "uuid",
      "pedido_id": "string",
      "produto_id": "number",
      "sku": "string",
      "gtin": "string | null",
      "descricao": "string",
      "quantidade": "number (quantidade_pedida)",
      "separacao_marcado": "boolean",
      "separacao_marcado_em": "ISO datetime | null",
      "quantidade_bipada": "number",
      "bipado_completo": "boolean",
      "imagem_url": "string | null",
      "compra_status": "string | null",
      "localizacao": "string | null",
      "saldo": "number",
      "disponivel": "number",
      "empresa_origem_id": "uuid (separating empresa)",
      "galpao_nome": "string | null"
    }
  ]
}
```

**Business Logic:**
- Fetches items from siso_pedido_itens for the given pedidos
- Fetches pedido info (empresa_origem_id, separacao_galpao_id, status_separacao)
- For each pedido, resolves the "separating empresa" (the empresa in separacao_galpao_id that will physically separate/ship)
- Fetches localizacao and stock from siso_pedido_item_estoques (filtering by separating empresa)
- Filters items based on pedido status:
  - If status = "aguardando_compra": exclude items with compra_status = null (only show OC items)
  - Otherwise: exclude items with compra_status = "indisponivel" or "cancelado"
- Returns items with empresa_origem_id = separating empresa (for location updates)

**Side Effects:** None (read-only)

**Rate Limiting:** None

**Notes:**
- For transferência orders, empresa_origem_id refers to the separating empresa, not the origin empresa
- Localizacao comes from the separating empresa's stock snapshot

---

### POST /api/separacao/cancelar

**File:** `src/app/api/separacao/cancelar/route.ts`

**Purpose:** Cancel an in-progress separation. Resets all item checkmarks and moves pedidos back to 'aguardando_separacao'.

**Auth:** None

**Request Body:**
```json
{
  "pedido_ids": ["string"]
}
```

**Response (200):**
```json
{
  "ok": true,
  "pedido_ids": ["string"]
}
```

**Business Logic:**
- Resets all items: separacao_marcado = false, separacao_marcado_em = null
- Resets pedidos: status_separacao = "aguardando_separacao", separacao_operador_id = null, separacao_iniciada_em = null

**Side Effects:**
- Updates `siso_pedido_itens` and `siso_pedidos`
- Logs to `siso_logs`

---

### POST /api/separacao/reiniciar

**File:** `src/app/api/separacao/reiniciar/route.ts`

**Purpose:** Reset checklist or packing progress for given pedidos.

**Auth:** None

**Request Body:**
```json
{
  "pedido_ids": ["string"],
  "etapa": "separacao" | "embalagem"
}
```

**Response (200):**
```json
{
  "ok": true,
  "pedido_ids": ["string"],
  "etapa": "string"
}
```

**Response (400 - Wrong status for etapa):**
```json
{
  "error": "Pedidos devem estar com status 'em_separacao' ou 'aguardando_separacao' para reiniciar separacao",
  "pedidos_invalidos": [
    {
      "id": "string",
      "status_atual": "string"
    }
  ]
}
```

**Business Logic:**
- Validates all pedidos have correct status for requested etapa
  - etapa = "separacao": status must be "em_separacao"
  - etapa = "embalagem": status must be "separado"
- If etapa = "separacao": resets separacao_marcado, separacao_marcado_em
- If etapa = "embalagem": resets quantidade_bipada, bipado_completo

**Side Effects:**
- Updates `siso_pedido_itens`
- Logs to `siso_logs`

---

### POST /api/separacao/encaminhar

**File:** `src/app/api/separacao/encaminhar/route.ts`

**Purpose:** Forward one or more orders to another galpão. Reverses any stock execution that already occurred, resets the pedido to `pendente` with `sugestao = "transferencia"` so the destination galpão sees it in their SISO dashboard.

**Auth:** X-Session-Id (required), any authenticated user

**Request Body:**
```json
{
  "pedido_ids": ["string"],
  "galpao_destino_id": "string"
}
```

**Response (200):**
```json
{
  "ok": true,
  "encaminhados": ["string"],
  "falhas": [{ "id": "string", "erro": "string" }],
  "galpao_destino_nome": "string"
}
```

**Response (400):**
```json
{
  "error": "pedido_ids deve ser um array de strings não vazio" | "galpao_destino_id obrigatório" | "Galpão destino não encontrado ou inativo"
}
```

**Response (401):**
```json
{
  "error": "sessao_invalida"
}
```

**Validation per pedido:**
- `status_separacao` must be `aguardando_separacao` or `em_separacao`
- Cannot forward to the same galpão (`separacao_galpao_id !== galpao_destino_id`)

**Stock Reversal Logic:**
- `decisao_final = "propria"`: calls `estornarEstoque()` on origin empresa via Tiny API
- `decisao_final = "transferencia"`: reverses `movimentarEstoque()` (entry instead of exit) for each item where `estoque_saida_lancada = true`, using `empresa_deducao_id` and `produto_id_na_empresa`
- `decisao_final = "oc"` or null: no stock to reverse

**WMS Plano 3 — Reservas (quando `WMS_AS_SOURCE=true`):**
- Se `estoque_lancado=true`: chama `estornarSaidasPedido` (E com origem=cancelamento_nf, estorno_de=S.id) — gera entradas compensatórias no galpão antigo
- Sempre chama `liberarReserva` (motivo=encaminhamento) — libera R movs no galpão antigo
- Chama `recriarReservasNoGalpao` — varre `siso_estoque` no galpão destino, prefere a empresa origem, e cria novas R via `reservarAtomico` (TTL 30 dias)
- Falhas individuais (sem estoque no destino) são logadas mas não bloqueiam o encaminhar — operador pode resolver via re-aprovação manual

**Reset Fields on `siso_pedidos`:**
- `status` → `"pendente"`, `sugestao` → `"transferencia"`, `encaminhado_de` → origin galpão name
- Clears: `decisao_final`, `operador_id`, `operador_nome`, `tipo_resolucao`, `processado_em`, `estoque_lancado`, `status_separacao`, `separacao_galpao_id`, `separacao_operador_id`, `separacao_iniciada_em`, `separacao_concluida_em`, `embalagem_concluida_em`, `etiqueta_url`, `agrupamento_expedicao_id`, `expedicao_id`, `etiqueta_zpl`, `etiqueta_status`
- Preserves (NF fields — omission-based): `empresa_origem_id`, `filial_origem`, `numero`, `nota_fiscal_id`, `chave_acesso_nf`, `url_danfe`

> **Reroute contract for early agrupamento:** NF fields are preserved because the NF remains valid across galpao reroute. Shipping artifacts (agrupamento, etiqueta) are explicitly cleared because they must be recreated for the new galpao's shipping context. The re-approved pedido goes through the full worker flow, which detects the existing NF via `gerarNotaFiscalPedido` idempotency and creates a new agrupamento via `criarAgrupamentoFase1`.

**Reset Fields on `siso_pedido_itens`:**
- `separacao_marcado` → false, `separacao_marcado_em` → null, `quantidade_bipada` → 0, `bipado_completo` → false, `estoque_saida_lancada` → false, `empresa_deducao_id` → null

**Error Strategy:** If any Tiny API call fails for a pedido, that pedido is skipped (added to `falhas`), leaving it in its current state. The operator can retry.

**Side Effects:**
- Reverses stock in Tiny ERP (estorno or entry movements)
- Updates `siso_pedidos` and `siso_pedido_itens`
- Inserts "encaminhado" event to `siso_pedido_historico`
- Logs to `siso_logs`

---

### POST /api/separacao/forcar-pendente

**File:** `src/app/api/separacao/forcar-pendente/route.ts`

**Purpose:** Force one or more orders back to pending separation status. Also verifies NF data via Tiny API and attempts early agrupamento creation when NF is complete.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "pedido_ids": ["string"]
}
```

**Response (200):**
```json
{
  "ok": true,
  "atualizados": "number",
  "pedidos": ["string"]
}
```

**Business Logic:**
- Forces pedidos back to `aguardando_separacao` (or `aguardando_compra` for pick OC)
- Resets item-level separation markers
- For each pedido with `nota_fiscal_id`: verifies NF via Tiny API, persists `chave_acesso_nf` if available
- After persisting `chave_acesso_nf`: calls `criarAgrupamentoFase1` (fire-and-forget, `.catch(() => {})`) — never blocks the admin response

**Side Effects:**
- Updates `siso_pedidos.status_separacao`, clears separation timestamps
- Updates `siso_pedido_itens` separation markers
- May persist `chave_acesso_nf` from Tiny API verification
- Fire-and-forget: creates fase-1 agrupamento when NF complete
- Inserts to `siso_pedido_historico`
- Logs to `siso_logs`

---

### PATCH /api/separacao/{pedidoId}/forcar-pendente

**File:** `src/app/api/separacao/[pedidoId]/forcar-pendente/route.ts`

**Purpose:** Force a single order back to pending. Same logic as batch endpoint but for one pedido.

**Auth:** X-Session-Id (required)

**Request Body:** None (pedido ID from URL path)

**Response (200):**
```json
{
  "ok": true,
  "pedido_id": "string"
}
```

**Business Logic:**
- Same as batch forcar-pendente but for a single pedido
- Verifies NF via Tiny API, persists `chave_acesso_nf` if available
- Calls `criarAgrupamentoFase1` fire-and-forget after NF verification

**Side Effects:**
- Same as batch forcar-pendente

---

### POST /api/separacao/voltar-etapa

**File:** `src/app/api/separacao/voltar-etapa/route.ts`

**Purpose:** Admin-only. Move one or more pedidos to ANY separation stage (forward or backward). Cleans up item-level data appropriately.

**Auth:** X-Session-Id (required), must have "admin" cargo

**Request Body:**
```json
{
  "pedido_ids": ["string"],
  "novo_status": "aguardando_nf" | "aguardando_separacao" | "em_separacao" | "separado" | "embalado"
}
```

**Response (200):**
```json
{
  "ok": true,
  "pedidos_atualizados": ["string"],
  "total": "number",
  "novo_status": "string"
}
```

**Response (400 - Invalid status or no pedidos to move):**
```json
{
  "error": "status inválido" | "nenhum pedido pode ser movido para esse status"
}
```

**Response (403 - Not admin):**
```json
{
  "error": "apenas admin pode alterar etapa"
}
```

**Response (404 - Orders not found):**
```json
{
  "error": "pedidos_nao_encontrados"
}
```

**Business Logic:**
- Determines direction: going back or going forward
- **Going backward (to earlier stage):**
  - Clears timestamps and operador info as appropriate
  - Keeps etiqueta/agrupamento data (never clear cached ZPL labels)
  - Clears item-level completion markers (separacao_marcado, quantidade_bipada, bipado_completo, etc.)
- **Going forward (to later stage):**
  - Sets new timestamps
  - For "separado": marks all unmarked items as separacao_marcado = true
  - For "embalado": scans all items (quantidade_bipada = quantidade_pedida, bipado_completo = true)
- Records event to `siso_pedido_historico` for each pedido

**Side Effects:**
- Updates `siso_pedidos.status_separacao` and related timestamps
- Updates `siso_pedido_itens` (clears or sets completion markers)
- RPC calls to clear etiqueta_status when going backward
- Inserts to `siso_pedido_historico`
- Logs to `siso_logs`

---

### POST /api/separacao/bipar-embalagem

**File:** `src/app/api/separacao/bipar-embalagem/route.ts`

**Purpose:** Process a barcode scan during packing. Finds the oldest separado-status order with the scanned SKU and updates quantities atomically.

**Auth:** Session required (`X-Session-Id` header)

**Request Body:**
```json
{
  "sku": "string",
  "galpao_id": "string | null",
  "quantidade": "number (default 1)"
}
```

**Response (200):**
```json
{
  "pedido_id": "string",
  "produto_id": "number",
  "quantidade_bipada": "number",
  "bipado_completo": "boolean",
  "pedido_completo": "boolean",
  "etiqueta_status": "impresso" | "falhou" | null,
  "etiqueta_erro": "string | null"
}
```

**Response (404 - No orders with SKU):**
```json
{
  "error": "Nenhum pedido com este SKU pendente de embalagem" | "SKU encontrado mas não disponível: ..."
}
```

**Business Logic:**
- Validates session to identify the packing operator
- Calls RPC `siso_processar_bip_embalagem` with operator ID to find and update item atomically
- RPC finds the oldest separado-status order with matching SKU, increments quantidade_bipada
- If pedido_completo: calls `imprimirEtiquetaDireta` or `buscarEImprimirEtiqueta` to print label on the **packing operator's** printer

**Side Effects:**
- RPC atomically updates `siso_pedido_itens.quantidade_bipada`, `bipado_completo`
- May update `siso_pedidos.status_separacao = "embalado"`, `embalagem_concluida_em`, `embalagem_operador_id`
- Calls label printing (resolves printer from packing operator, not separation operator)
- Logs to `siso_logs`

---

### POST /api/separacao/bipar-embalagem-oc

**File:** `src/app/api/separacao/bipar-embalagem-oc/route.ts`

**Purpose:** Process a barcode scan for direct packing of OC (aguardando_compra) orders. Finds the oldest matching pedido among provided IDs, increments item quantities, and auto-resolves the full OC lifecycle when a pedido completes.

**Auth:** Session required (`X-Session-Id` header)

**Request Body:**
```json
{
  "sku": "string",
  "pedido_ids": "string[]",
  "quantidade": "number (default 1)"
}
```

**Response (200 - Item scanned, pedido not complete):**
```json
{
  "pedido_id": "string",
  "produto_id": "number",
  "quantidade_bipada": "number",
  "bipado_completo": "boolean",
  "pedido_completo": false
}
```

**Response (200 - Pedido complete):**
```json
{
  "pedido_id": "string",
  "produto_id": "number",
  "quantidade_bipada": "number",
  "bipado_completo": true,
  "pedido_completo": true,
  "etiqueta_status": "impresso" | "falhou",
  "etiqueta_erro": "string | null"
}
```

**Response (404 - SKU not found):**
```json
{
  "error": "sku_nao_encontrado"
}
```

**Business Logic:**
- Validates session to identify the packing operator
- Fetches pedidos from `pedido_ids` that are in `aguardando_compra` status, ordered by `data_pedido` ascending (oldest first)
- Finds the first pedido with a matching item by SKU (case-insensitive via `ilike`), skipping items that are already `bipado_completo` or have `compra_status` in (`indisponivel`, `cancelado`)
- Increments `quantidade_bipada` atomically using an optimistic lock (`WHERE quantidade_bipada = previous_value`)
- Sets `bipado_completo = true` when `quantidade_bipada >= quantidade`
- Checks pedido completion: counts items where `bipado_completo = false`, excluding items with `compra_status` IN (`indisponivel`, `cancelado`)
- When pedido is complete, performs full OC resolution:
  - (a) Auto-resolve compra items: sets `compra_status = 'recebido'`, `compra_quantidade_recebida = compra_quantidade_solicitada`
  - (b) Determines `decisao_final`: compares empresa_origem galpao with OC galpao — same = `propria`, different = `transferencia`
  - (c) Resolves `separacao_galpao_id` based on decisao
  - (d) Updates pedido: `status = 'executando'`, `status_separacao = 'embalado'`, appends `'embalagem direta'` tag
  - (e) Enqueues execution job in `siso_fila_execucao`
  - (f) Prints label via `imprimirEtiquetaDireta` or `buscarEImprimirEtiqueta` fallback
  - (g) Registers `embalagem_direta_concluida` history event
  - (h) Kicks execution worker (fire-and-forget)

**Side Effects:**
- Updates `siso_pedido_itens.quantidade_bipada`, `bipado_completo`
- On completion: updates `siso_pedido_itens.compra_status`, `compra_quantidade_recebida` for all OC items
- On completion: updates `siso_pedidos` status, decisao, tags, embalagem timestamp
- On completion: inserts `siso_fila_execucao` job
- On completion: prints shipping label via PrintNode
- On completion: inserts `siso_pedido_historico` event
- On completion: triggers execution worker
- Logs to `siso_logs` and `siso_erros`

---

### POST /api/separacao/confirmar-item-embalagem

**File:** `src/app/api/separacao/confirmar-item-embalagem/route.ts`

**Purpose:** Manually confirm item quantities during packing via +/- buttons. Increments quantidade_bipada and checks pedido completion.

**Auth:** Session required (`X-Session-Id` header)

**Request Body:**
```json
{
  "pedido_item_id": "string",
  "quantidade": "number (increment, can be negative)"
}
```

**Response (200):**
```json
{
  "pedido_item_id": "string",
  "quantidade_bipada": "number",
  "bipado_completo": "boolean",
  "pedido_completo": "boolean",
  "etiqueta_status": "impresso" | "falhou" | null,
  "etiqueta_erro": "string | null"
}
```

**Response (400 - Wrong pedido status):**
```json
{
  "error": "Pedido deve estar com status 'separado' para embalagem",
  "status_atual": "string"
}
```

**Response (404 - Item or pedido not found):**
```json
{
  "error": "Item nao encontrado" | "Pedido nao encontrado"
}
```

**Business Logic:**
- Validates session to identify the packing operator
- Fetches item and validates parent pedido.status_separacao = "separado"
- Increments quantidade_bipada by quantidade (can be negative to decrement)
- Recalculates bipado_completo (newBipada >= quantidade_pedida)
- Checks if all packable items (non-indisponivel, non-cancelado) have bipado_completo = true
- If all complete: transitions pedido to "embalado" and calls label printing on the **packing operator's** printer

**Side Effects:**
- Updates `siso_pedido_itens.quantidade_bipada`, `bipado_completo`
- May update `siso_pedidos.status_separacao = "embalado"`, `embalagem_concluida_em`, `embalagem_operador_id`
- Calls label printing if pedido complete (resolves printer from packing operator, not separation operator)
- Logs to `siso_logs`

---

### POST /api/separacao/expedir

**File:** `src/app/api/separacao/expedir/route.ts`

**Purpose:** Mark packed orders as shipped (embalado → expedido).

**Auth:** X-Session-Id (required), user must have galpaoId

**Request Body:**
```json
{
  "pedido_ids": ["string"]
}
```

**Response (200):**
```json
{
  "updated": "number"
}
```

**Response (400 - Orders not packed):**
```json
{
  "error": "pedidos não estão embalados",
  "pedido_ids": ["string"]
}
```

**Response (403 - Orders from wrong galpão):**
```json
{
  "error": "pedidos não pertencem ao seu galpão",
  "pedido_ids": ["string"]
}
```

**Response (404 - Orders not found):**
```json
{
  "error": "pedidos não encontrados",
  "pedido_ids": ["string"]
}
```

**Business Logic:**
- Validates all pedidos belong to operator's galpão
- Validates all pedidos have status_separacao = "embalado"
- Updates status_separacao to "expedido"

**Side Effects:**
- Updates `siso_pedidos.status_separacao`
- Logs to `siso_logs`

---

### GET /api/separacao/tags

**File:** `src/app/api/separacao/tags/route.ts`

**Purpose:** Returns all unique separacao_tags used across pedidos (for autocomplete). Galpão-scoped for non-admins.

**Auth:** X-Session-Id (required)

**Response (200):**
```json
{
  "tags": ["string"]
}
```

**Business Logic:**
- Fetches all separacao_tags arrays from pedidos in separation (status_separacao is not null)
- Deduplicates and sorts alphabetically

**Side Effects:** None (read-only)

---

### POST /api/separacao/tags

**File:** `src/app/api/separacao/tags/route.ts`

**Purpose:** Add, remove, or replace tags on pedidos.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "pedido_ids": ["string"],
  "tags": ["string"],
  "action": "add" | "remove" | "set"
}
```

**Response (200):**
```json
{
  "ok": true,
  "action": "string",
  "tags": ["string"],
  "total": "number (pedidos updated)"
}
```

**Business Logic:**
- Sanitizes tags: trim, lowercase, filter empty/long
- If action = "set": replaces all tags (direct update)
- If action = "add" or "remove": reads current tags, modifies, updates only if changed

**Side Effects:**
- Updates `siso_pedidos.separacao_tags`
- Logs on errors

---

### POST /api/separacao/produto-esgotado

**File:** `src/app/api/separacao/produto-esgotado/route.ts`

**Purpose:** Three modes for handling out-of-stock products: preview alternatives, create purchase order, or redirect to another galpão.

**Auth:** None

**Request Body (Preview mode - no action):**
```json
{
  "sku": "string"
}
```

**Request Body (OC mode):**
```json
{
  "sku": "string",
  "acao": "oc"
}
```

**Request Body (Encaminhar mode):**
```json
{
  "sku": "string",
  "acao": "encaminhar",
  "galpao_destino_id": "uuid"
}
```

**Response (Preview mode - 200):**
```json
{
  "pedidos_afetados": "number",
  "itens_afetados": "number",
  "galpoes_alternativos": [
    {
      "galpao_id": "uuid",
      "galpao_nome": "string"
    }
  ]
}
```

**Response (OC mode - 200):**
```json
{
  "pedidos_afetados": "number",
  "itens_afetados": "number",
  "ordem_compra_id": "uuid | null"
}
```

**Response (Encaminhar mode - 200):**
```json
{
  "pedidos_afetados": "number",
  "itens_afetados": "number",
  "galpao_destino_nome": "string"
}
```

**Business Logic:**
- Finds all active pedidos (aguardando_nf, aguardando_separacao, em_separacao) with matching SKU
- Finds stock alternatives in other galpões
- **Preview mode:** returns count of affected pedidos/items and alternative galpões
- **OC mode:** marks items for purchase, creates/updates OC, resets separation state, moves pedidos to aguardando_compra
- **Encaminhar mode:** resets separation state, changes separacao_galpao_id to destination, moves pedidos back to aguardando_separacao

**Side Effects:**
- Updates `siso_pedido_itens` (compra_status, fornecedor_oc, etc. for OC mode)
- Updates `siso_pedidos.status_separacao`, `separacao_galpao_id` for OC/encaminhar modes
- May create `siso_ordens_compra` for OC mode
- Logs to `siso_logs`

---

### POST /api/separacao/validar-oc-item

**File:** `src/app/api/separacao/validar-oc-item/route.ts`

**Purpose:** Handle OC item validation during the validacao_oc phase. Supports "encontrei" (found physically), "esgotado" (confirmed missing), and "desfazer_encontrei" (undo found) actions, with auto-transitions when all OC items are resolved.

**Auth:** Session required (X-Session-Id header)

**Request Body:**
```json
{
  "item_ids": ["uuid", "uuid"],
  "acao": "encontrei | esgotado | desfazer_encontrei"
}
```

**Response (200):**
```json
{
  "itens_atualizados": "number",
  "transicoes": [
    {
      "pedido_id": "uuid",
      "novo_status": "string"
    }
  ]
}
```

**Business Logic:**
- **encontrei:** Clears all compra fields (compra_status, fornecedor_oc, compra_quantidade_solicitada, compra_solicitada_em, ordem_compra_id) and marks item as picked (separacao_marcado = true, bipado_completo = true, quantidade_bipada = quantidade_pedida)
- **esgotado:** Sets compra_status = aguardando_compra, fills fornecedor_oc via getFornecedorBySku, sets compra_quantidade_solicitada and compra_solicitada_em. Auto-creates or finds existing OC (siso_ordens_compra) by fornecedor + galpao and links item.
- **desfazer_encontrei:** Restores compra_status = oc_pendente, fills fornecedor_oc via getFornecedorBySku, clears separacao_marcado/bipado_completo/quantidade_bipada. Reverts decisao_final to "oc" if it was flipped to "propria".
- **Auto-transition FR-9:** When all OC items resolved and none have compra_status (all found), sets decisao_final = propria. If pedido in validacao_oc, transitions to aguardando_separacao.
- **Auto-transition FR-8:** When all OC items resolved and ALL items have compra_status (100% OC pedido), transitions to aguardando_compra, clears separacao_operador_id and separacao_iniciada_em.

**Side Effects:**
- Updates `siso_pedido_itens` (compra fields + separacao fields)
- May update `siso_pedidos` (status_separacao, decisao_final)
- May create `siso_ordens_compra` (for esgotado action)
- Records `oc_item_encontrado`, `oc_item_desfazer_encontrado`, or `oc_item_confirmado` events in `siso_pedido_historico`
- Logs errors to `siso_erros`

---

### POST /api/separacao/reimprimir

**File:** `src/app/api/separacao/reimprimir/route.ts`

**Purpose:** Print/reprint a shipping label. Fast path uses cached ZPL; fallback creates agrupamento in Tiny.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "pedido_id": "string"
}
```

**Response (200):**
```json
{
  "status": "impresso" | "falhou",
  "jobId": "number | null"
}
```

**Response (400 - Pedido not packed):**
```json
{
  "error": "pedido_nao_embalado",
  "status_separacao": "string"
}
```

**Response (403 - Access denied):**
```json
{
  "error": "acesso_negado"
}
```

**Response (404 - Pedido not found):**
```json
{
  "error": "pedido_nao_encontrado"
}
```

**Business Logic:**
- Validates user can access pedido's galpão (admin or matching galpaoId)
- Validates pedido.status_separacao = "embalado"
- If etiqueta_zpl cached: prints directly via PrintNode (fast path)
- If no cache: delegates to `buscarEImprimirEtiqueta` (creates agrupamento, fetches ZPL, prints)

**Side Effects:**
- Prints via PrintNode API
- May create agrupamento in Tiny
- Fire-and-forget: updates etiqueta_status via RPC
- Logs to `siso_logs`

---

### POST /api/separacao/retry-etiqueta

**File:** `src/app/api/separacao/retry-etiqueta/route.ts`

**Purpose:** Retries label (etiqueta) acquisition for packed/separated orders that reached final stages without cached ZPL. Does not print anything, only recovers/re-generates labels.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "pedido_id": "string"
}
```
OR
```json
{
  "pedido_ids": ["string"]
}
```

**Response (200):**
```json
{
  "total": "number",
  "recuperadas": "number",
  "ja_disponiveis": "number",
  "em_andamento": "number",
  "falhas": "number",
  "pedidos": [
    {
      "id": "uuid",
      "numero": "string",
      "status": "ja_disponivel" | "recuperada" | "em_andamento" | "falhou",
      "etiqueta_pronta": "boolean",
      "agrupamento_expedicao_id": "string | null",
      "expedicao_id": "string | null"
    }
  ]
}
```

**Response (400 - Missing/invalid body):**
```json
{
  "error": "envie 'pedido_id' ou 'pedido_ids'"
}
```

**Response (404 - Orders not found):**
```json
{
  "error": "pedidos_nao_encontrados",
  "pedido_ids": ["string"]
}
```

**Response (403 - Wrong galpão):**
```json
{
  "error": "pedidos_nao_pertencem_ao_seu_galpao",
  "pedido_ids": ["string"]
}
```

**Response (400 - Invalid stage):**
```json
{
  "error": "pedido_em_etapa_invalida",
  "pedido_ids": ["string"]
}
```

**Business Logic:**
- Validates orders exist and user has galpão access
- Validates orders are in "separado" or "embalado" status
- For orders without cached ZPL:
  - Calls `preCriarAgrupamentosEmLote` to create Tiny agrupamentos
  - Calls `recarregarEtiquetasFaltantes` to fetch/generate ZPL
  - Retries once if second pass still missing ZPL
- Restores orders moved to "embalado" back to "separado" (label generation auto-advances)
- Classifies each order: already_available | recovered | in_progress | failed
- Updates etiqueta_status based on classification

**Side Effects:**
- Updates `siso_pedidos.agrupamento_expedicao_id`, `etiqueta_status`, `status_separacao`
- Calls Tiny agrupamento creation via `preCriarAgrupamentosEmLote`
- Calls label fetch via `recarregarEtiquetasFaltantes`
- Logs to `siso_logs`

---

### POST /api/separacao/localizacao

**File:** `src/app/api/separacao/localizacao/route.ts`

**Purpose:** Update a product's warehouse location (localização) in Tiny ERP and local DB.

**Auth:** None

**Request Body:**
```json
{
  "produto_id": "number",
  "localizacao": "string",
  "empresa_id": "string"
}
```

**Response (200):**
```json
{
  "ok": true
}
```

**Response (400 - Missing fields):**
```json
{
  "error": "Campo 'produto_id' (number) obrigatorio"
}
```

**Response (500 - Tiny API error):**
```json
{
  "error": "string (error message)"
}
```

**Business Logic:**
- Validates all three fields
- Gets valid token for empresa
- Calls Tiny API `atualizarLocalizacaoProduto`
- Updates all rows in `siso_pedido_item_estoques` for this product+empresa

**Side Effects:**
- Calls Tiny API
- Updates `siso_pedido_item_estoques`
- Logs to `siso_logs`

---

## Compras API

### GET /api/compras

**File:** `src/app/api/compras/route.ts`

**Purpose:** Comprehensive purchase management dashboard. Returns counts and item groups by supplier, with aging and priority metrics.

**Auth:** X-Session-Id (required), must have purchase-related cargo (comprador, admin)

**Query Params:**
- `tab`: "comprar" | "receber" | "historico" (default: "comprar")

**Response (200 - Comprar tab):**
```json
{
  "counts": {
    "comprar": "number",
    "receber": "number",
    "excecoes": "number",
    "historico": "number",
    "pedidos_bloqueados": "number"
  },
  "fornecedores": [
    {
      "fornecedor": "string",
      "galpao_sugerido_id": "uuid | null",
      "galpao_sugerido_nome": "string | null",
      "skus_count": "number",
      "pedidos_bloqueados": "number (unique pedidos)",
      "aging_dias": "number (oldest item)",
      "itens": [
        {
          "sku": "string",
          "descricao": "string",
          "imagem_url": "string | null",
          "quantidade_necessaria": "number",
          "aging_dias": "number",
          "pedidos": [
            {
              "pedido_id": "string",
              "numero": "string",
              "cliente_nome": "string",
              "quantidade": "number",
              "aging_dias": "number",
              "item_id": "string"
            }
          ]
        }
      ]
    }
  ],
  "excecoes": [
    {
      "id": "string",
      "sku": "string",
      "descricao": "string",
      "imagem_url": "string | null",
      "compra_status": "indisponivel" | "equivalente_pendente" | "cancelamento_pendente",
      "quantidade": "number",
      "aging_dias": "number",
      "fornecedor_oc": "string | null",
      "pedido_id": "string",
      "numero_pedido": "string",
      "compra_equivalente_sku": "string | null",
      "compra_equivalente_descricao": "string | null",
      "compra_equivalente_fornecedor": "string | null",
      "compra_equivalente_observacao": "string | null",
      "compra_cancelamento_motivo": "string | null"
    }
  ]
}
```

**Response (200 - Receber tab):**
```json
{
  "counts": { ...same... },
  "fornecedores": [
    {
      "fornecedor": "string",
      "galpao_sugerido_nome": "string | null",
      "skus_count": "number",
      "pendente_count": "number (SKUs with pending qty)",
      "aging_dias": "number",
      "itens": [
        {
          "sku": "string",
          "descricao": "string",
          "imagem_url": "string | null",
          "quantidade_comprada": "number",
          "quantidade_recebida": "number",
          "quantidade_pendente": "number",
          "aging_dias": "number",
          "comprado_em": "ISO datetime | null",
          "pedidos": [ ...same... ]
        }
      ]
    }
  ]
}
```

**Response (200 - Historico tab):**
```json
{
  "counts": { ...same... },
  "fornecedores": [
    {
      "fornecedor": "string",
      "data_recebimento": "date",
      "itens": [
        {
          "sku": "string",
          "descricao": "string",
          "quantidade_recebida": "number",
          "recebido_em": "ISO datetime | null"
        }
      ]
    }
  ]
}
```

**Business Logic:**
- **Comprar tab:** Groups items by fornecedor, aggregates by SKU, includes all unique pedidos per SKU
- **Receber tab:** Shows purchased items awaiting receipt; auto-fixes items over-received
- **Historico tab:** Shows received items (compra_status = "recebido") grouped by fornecedor and date

**Side Effects:** Auto-fix in receber tab (marks over-received items as "recebido")

**Rate Limiting:** None

---

### POST /api/compras/ordens

**File:** `src/app/api/compras/ordens/route.ts`

**Purpose:** Create an ordem de compra and link all aguardando items for that fornecedor.

**Auth:** X-Session-Id (required), must have purchase cargo

**Request Body:**
```json
{
  "fornecedor": "string",
  "galpao_id": "uuid",
  "observacao": "string | null",
  "item_ids": ["string"] (optional, to select specific items)
}
```

**Response (201):**
```json
{
  "ok": true,
  "ordem_compra": {
    "id": "uuid",
    "fornecedor": "string",
    "galpao_id": "uuid",
    "empresa_id": "uuid",
    "status": "comprado",
    "observacao": "string | null",
    "comprado_por": "uuid",
    "comprado_em": "ISO datetime",
    "created_at": "ISO datetime"
  },
  "itens_vinculados": "number",
  "quantidade_total": "number"
}
```

**Response (400 - Missing fields):**
```json
{
  "error": "fornecedor e galpao_id são obrigatórios"
}
```

**Response (400 - No items found):**
```json
{
  "error": "Nenhum item aguardando compra para fornecedor '...'"
}
```

**Business Logic:**
- Validates fornecedor and galpao_id
- Resolves first active empresa in galpão (deterministic ordering)
- Fetches all items for this fornecedor with compra_status = "aguardando_compra" (from all empresas)
- If item_ids provided: filters to selected items only
- Checks for existing draft OC (status = "aguardando_compra") to reuse
- If exactly 1 draft: updates to "comprado" and uses it
- Otherwise: creates new OC with status = "comprado"
- Links all items to OC and sets compra_status = "comprado"
- Cleans up orphaned draft OCs (drafts that lost all their items)

**Side Effects:**
- Creates or updates `siso_ordens_compra`
- Updates `siso_pedido_itens.ordem_compra_id`, `compra_status`
- May delete orphaned draft OCs
- Logs to `siso_logs`

---

### GET /api/compras/conferencia/[ordemCompraId]

**File:** `src/app/api/compras/conferencia/[ordemCompraId]/route.ts`

**Purpose:** Returns OC info + items for the receiving/checking screen.

**Auth:** X-Session-Id (required), must have purchase cargo

**Response (200):**
```json
{
  "ordem_compra": {
    "id": "uuid",
    "fornecedor": "string",
    "galpao_id": "uuid",
    "galpao_nome": "string | null",
    "status": "string",
    "observacao": "string | null",
    "comprado_por_nome": "string | null",
    "comprado_em": "ISO datetime | null",
    "created_at": "ISO datetime"
  },
  "itens": [
    {
      "item_id": "uuid",
      "sku": "string",
      "descricao": "string",
      "imagem": "string | null",
      "quantidade_esperada": "number",
      "quantidade_ja_recebida": "number",
      "quantidade_restante": "number",
      "produto_id_tiny": "number | null",
      "pedidos": [
        {
          "pedido_id": "string",
          "numero_pedido": "string",
          "quantidade": "number"
        }
      ]
    }
  ]
}
```

**Response (404 - OC not found):**
```json
{
  "error": "Ordem de compra nao encontrada"
}
```

**Business Logic:**
- Fetches OC and joins galpão info
- Fetches items linked to OC with compra_status = "comprado" (items still awaiting receipt)
- For each item, calculates expected quantity, received quantity, and restante

**Side Effects:** None (read-only)

---

### POST /api/compras/receber

**File:** `src/app/api/compras/receber/route.ts`

**Purpose:** Confirms receiving of purchased items. Supports partial receiving. Identifies and releases orders where all purchase items are now received.

**Auth:** X-Session-Id (required), must have purchase cargo

**Request Body:**
```json
{
  "itens": [
    {
      "sku": "string",
      "quantidade_recebida": "number",
      "observacao": "string | null"
    }
  ]
}
```

**Response (200):**
```json
{
  "ok": true,
  "recebimento": [
    {
      "sku": "string",
      "itens_atualizados": "number",
      "quantidade_alocada": "number"
    }
  ],
  "pedidos_desbloqueados": ["string"]
}
```

**Business Logic:**
- For each SKU, fetches all items with compra_status = "comprado"
- Distributes received quantity across items by order aging (oldest first)
- Marks items as "recebido" when fully received
- **WMS Plano 3:** quando `WMS_AS_SOURCE=true`, chama `receberOcAtomico` por alocação — RPC `wms_receber_oc_atomico` lança E (compra_manual) + R (reserva_pedido) atômicos no ledger. Localização default vem do putaway helper (overstock/recebimento)
- Checks each affected pedido: if all compra items are resolved (recebido, indisponivel, cancelado), releases pedido
- Released pedidos transition to:
  - "separado" if NF already arrived
  - "aguardando_nf" if NF not yet arrived
- Enqueues priority execution job for released pedidos
- Kicks worker

**Side Effects:**
- Updates `siso_pedido_itens.compra_quantidade_recebida`, `compra_status`
- Updates `siso_pedidos.status`, `status_separacao`
- Inserts to `siso_fila_execucao` (priority jobs)
- **WMS:** Insere E + R em `siso_movimentacoes` via `wms_receber_oc_atomico` (quando flag ativa)
- Logs to `siso_logs`

---

### POST /api/compras/conferir

**File:** `src/app/api/compras/conferir/route.ts`

**Purpose:** Process receiving confirmation. Updates DB, calls Tiny movimentarEstoque, and releases orders where all OC items are received.

**Auth:** X-Session-Id (required), must have purchase cargo

**Request Body:**
```json
{
  "ordem_compra_id": "uuid",
  "itens": [
    {
      "item_id": "uuid",
      "quantidade_recebida": "number"
    }
  ]
}
```

**Response (200):**
```json
{
  "processados": "number",
  "erros": "number",
  "erros_detalhe": ["string"],
  "itens_sem_produto_id": "number",
  "pedidos_liberados": ["string"]
}
```

**Business Logic:**
- Fetches OC and resolves receiving empresa from galpão
- Gets valid Tiny token for receiving empresa
- For each item:
  1. **DB update FIRST** with optimistic lock (prevents race conditions)
  2. **Tiny call AFTER** DB success (if produto_id_tiny exists)
  3. **Rollback DB** if Tiny call fails
  4. Updates stock snapshot in `siso_pedido_item_estoques`
- Updates OC status based on all items (recebido, parcialmente_recebido, comprado)
- Checks each affected pedido: if all compra items are now received, releases it
- Logs each operation

**Side Effects:**
- Updates `siso_pedido_itens.compra_quantidade_recebida`, `compra_status`
- Calls Tiny API `movimentarEstoque` (type E for entry)
- May rollback DB on Tiny failure
- Updates `siso_pedido_item_estoques` stock snapshot
- Updates `siso_ordens_compra.status`
- Calls `checkAndReleasePedidos` to release orders
- Logs to `siso_logs`

**Rate Limiting:** 500ms delay between Tiny API calls

---

### POST /api/compras/comprar

**File:** `src/app/api/compras/comprar/route.ts`

**Purpose:** Marks items as purchased (comprado) for a supplier. Qty is consolidated by SKU and distributed across order items by aging (oldest first).

**Auth:** X-Session-Id (required), must be comprador or admin

**Request Body:**
```json
{
  "itens": [
    {
      "sku": "string",
      "quantidade_comprada": "number"
    }
  ]
}
```

**Response (200):**
```json
{
  "ok": true,
  "resultados": [
    {
      "sku": "string",
      "itens_marcados": "number",
      "quantidade_alocada": "number",
      "quantidade_excedente": "number"
    }
  ]
}
```

**Response (400 - Missing fields):**
```json
{
  "error": "Envie { itens: [{ sku, quantidade_comprada }] }"
}
```

**Response (403 - Insufficient permissions):**
```json
{
  "error": "Apenas compradores podem marcar como comprado"
}
```

**Business Logic:**
- Validates user is comprador or admin
- For each SKU with quantidade_comprada > 0:
  - Fetches all items with this SKU and compra_status = "aguardando_compra"
  - Sorts by order age (oldest first)
  - Distributes purchased quantity across items
  - Updates compra_status = "comprado" and timestamps

**Side Effects:**
- Updates `siso_pedido_itens.compra_status`, `compra_quantidade_comprada`, `comprado_em`, `comprado_por`
- Logs to `siso_logs`

**Rate Limiting:** None

---

### POST /api/compras/trocar-sku

**File:** `src/app/api/compras/trocar-sku/route.ts`

**Purpose:** Swaps the SKU of order items to an equivalent product. Looks up product in Tiny across all group empresas, updates description, image, stock, and supplier. Does not auto-release the order.

**Auth:** X-Session-Id (required), must have compras access

**Request Body:**
```json
{
  "item_ids": ["uuid"],
  "novo_sku": "string"
}
```

**Response (200):**
```json
{
  "ok": true,
  "novo_sku": "string",
  "novo_fornecedor": "string",
  "descricao": "string | null"
}
```

**Response (400 - Missing fields):**
```json
{
  "error": "Envie { item_ids: string[], novo_sku: string }"
}
```

**Response (404 - SKU not found):**
```json
{
  "error": "SKU \"...\" não encontrado em nenhuma empresa do grupo"
}
```

**Business Logic:**
- Fetches items and validates they exist
- Resolves empresa_origem from first item's pedido
- Determines group empresas to search
- Searches for new SKU in all group empresas
- Updates items with new SKU, description, image, produto_id, fornecedor
- Deletes old stock rows (siso_pedido_item_estoques) for old produto
- Inserts stock rows for new produto

**Side Effects:**
- Updates `siso_pedido_itens.sku`, `descricao`, `imagem_url`, `produto_id`, `fornecedor_oc`
- Deletes from `siso_pedido_item_estoques` for old produto
- Inserts to `siso_pedido_item_estoques` for new produto
- Logs to `siso_logs`

---

### POST /api/compras/itens/[itemId]/equivalente

**File:** `src/app/api/compras/itens/[itemId]/equivalente/route.ts`

**Purpose:** Registers an equivalent SKU for an item and moves case to pending exception until swap is applied externally on Tiny/marketplace.

**Auth:** X-Session-Id (required), must have compras access

**Request Body:**
```json
{
  "sku_equivalente": "string",
  "fornecedor_equivalente": "string (optional)",
  "observacao": "string (optional)"
}
```

**Response (200):**
```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "sku": "string (original)",
    "descricao": "string",
    "compra_status": "equivalente_pendente",
    "compra_equivalente_sku": "string",
    "compra_equivalente_descricao": "string",
    "compra_equivalente_fornecedor": "string"
  }
}
```

**Response (404 - Item not found):**
```json
{
  "error": "Item não encontrado"
}
```

**Response (409 - Stock already received):**
```json
{
  "error": "Não é possível trocar por equivalente após entrada de estoque. Cancele o item/pedido ou trate manualmente."
}
```

**Business Logic:**
- Fetches item and validates compra_quantidade_recebida = 0
- Resolves empresa_origem from pedido
- Looks up new SKU in Tiny for empresa_origem
- Fetches product details (image, GTIN)
- Updates item to compra_status = "equivalente_pendente"
- Stores equivalent product metadata in compra_equivalente_* fields
- Clears compra_* fields (resets state)
- Cancels associated OC if it becomes empty

**Side Effects:**
- Updates `siso_pedido_itens` with equivalente data and reset compra fields
- May delete `siso_ordens_compra` if OC becomes empty
- Logs to `siso_logs`

---

### POST /api/compras/itens/[itemId]/equivalente/confirmar

**File:** `src/app/api/compras/itens/[itemId]/equivalente/confirmar/route.ts`

**Purpose:** Confirms that the item swap has been applied externally and synchronizes the local item with the equivalent SKU.

**Auth:** X-Session-Id (required), must have compras access

**Request Body:** Empty

**Response (200):**
```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "sku": "string (new)",
    "descricao": "string",
    "compra_status": "aguardando_compra",
    "fornecedor_oc": "string"
  }
}
```

**Response (404 - Item not found):**
```json
{
  "error": "Item não encontrado"
}
```

**Response (409 - Invalid state):**
```json
{
  "error": "O item não está aguardando confirmação de equivalente"
}
```

**Business Logic:**
- Fetches item and validates compra_status = "equivalente_pendente"
- Validates compra_equivalente_sku is set
- Loads equivalent product data from Tiny (description, image, GTIN, stock)
- Checks for duplicate products in the same pedido (merge not supported)
- Deletes old stock rows (siso_pedido_item_estoques)
- Inserts stock rows for equivalent product
- Updates item with new product metadata
- Sets compra_status = "aguardando_compra" to restart purchase flow

**Side Effects:**
- Deletes from `siso_pedido_item_estoques` for old produto
- Inserts to `siso_pedido_item_estoques` for equivalent produto
- Updates `siso_pedido_itens` with equivalent product data
- Logs to `siso_logs`

---

### POST /api/compras/itens/[itemId]/cancelamento

**File:** `src/app/api/compras/itens/[itemId]/cancelamento/route.ts`

**Purpose:** Marks an item as pending external cancellation with optional reason.

**Auth:** X-Session-Id (required), must have compras access

**Request Body:**
```json
{
  "motivo": "string (optional)"
}
```

**Response (200):**
```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "sku": "string",
    "descricao": "string",
    "compra_status": "cancelamento_pendente",
    "compra_cancelamento_motivo": "string | null"
  }
}
```

**Response (404 - Item not found):**
```json
{
  "error": "Item não encontrado"
}
```

**Business Logic:**
- Fetches item
- Updates compra_status = "cancelamento_pendente"
- Stores reason and timestamp
- Cancels associated OC if it becomes empty

**Side Effects:**
- Updates `siso_pedido_itens` with cancelamento status and metadata
- May delete `siso_ordens_compra` if OC becomes empty
- Logs to `siso_logs` with warning level

---

### POST /api/compras/itens/[itemId]/cancelamento/confirmar

**File:** `src/app/api/compras/itens/[itemId]/cancelamento/confirmar/route.ts`

**Purpose:** Confirms that item cancellation has been processed externally.

**Auth:** X-Session-Id (required), must have compras access

**Request Body:** Empty

**Response (200):**
```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "sku": "string",
    "compra_status": "cancelado"
  }
}
```

**Response (404 - Item not found):**
```json
{
  "error": "Item não encontrado"
}
```

**Response (409 - Invalid state):**
```json
{
  "error": "O item não está aguardando confirmação de cancelamento"
}
```

**Business Logic:**
- Fetches item and validates compra_status = "cancelamento_pendente"
- Sets compra_status = "cancelado"
- Clears compra_cancelamento_* fields

**Side Effects:**
- Updates `siso_pedido_itens.compra_status`
- Logs to `siso_logs`

---

### POST /api/compras/preparar-embalagem

**File:** `src/app/api/compras/preparar-embalagem/route.ts`

**Purpose:** Prepares orders from purchase orders for packing (embalagem). Transitions items to "aguardando_embalagem" status.

**Auth:** X-Session-Id (required), must have compras access

**Request Body:**
```json
{
  "ordem_compra_ids": ["uuid"]
}
```

**Response (200):**
```json
{
  "pedidos_preparados": ["string"],
  "itens_preparados": "number",
  "avisos": ["string (if any)"]
}
```

**Response (400 - Missing/invalid fields):**
```json
{
  "error": "ordem_compra_ids deve ser um array com pelo menos uma OC"
}
```

**Response (400 - Galpão mismatch):**
```json
{
  "error": "string"
}
```

**Business Logic:**
- Validates ordem_compra_ids is a non-empty array
- For each OC:
  - Fetches items linked to OC
  - Fetches associated pedidos
  - Checks all pedidos are in same galpão (must all go to same location)
  - Transitions items to "aguardando_embalagem"
  - Marks pedidos as ready for packing
- Returns list of prepared pedidos and item count

**Side Effects:**
- Updates `siso_pedido_itens` status
- Updates `siso_pedidos` embalagem fields
- Logs to `siso_logs`

---

### POST /api/compras/itens/[itemId]/indisponivel

**File:** `src/app/api/compras/itens/[itemId]/indisponivel/route.ts`

**Purpose:** Marks an item as unavailable from the supplier. Auto-cancels OC if empty and pedido if all items reach terminal status.

**Auth:** X-Session-Id (required), must have compras access

**Request Body:**
```json
{
  "motivo": "string (optional)"
}
```

**Response (200):**
```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "sku": "string",
    "descricao": "string",
    "fornecedor_oc": "string",
    "compra_status": "indisponivel",
    "pedido_id": "uuid"
  },
  "pedido_cancelado": "uuid | null"
}
```

**Response (404 - Item not found):**
```json
{
  "error": "Item não encontrado"
}
```

**Business Logic:**
- Fetches item
- Sets compra_status = "indisponivel"
- Unlinks from OC
- Cancels OC if it becomes empty
- Checks pedido: if all items are in terminal status (recebido, indisponivel, cancelado), cancels entire pedido
- May cancel execution job

**Side Effects:**
- Updates `siso_pedido_itens.compra_status`
- May delete `siso_ordens_compra` if OC becomes empty
- May update `siso_pedidos.status` if pedido cancelled
- May update `siso_fila_execucao.status` if execution job cancelled
- Logs to `siso_logs` with warning level

---

### POST /api/compras/itens/[itemId]/devolver

**File:** `src/app/api/compras/itens/[itemId]/devolver/route.ts`

**Purpose:** Returns an item to the "Aguardando Compra" queue by unlinking it from its OC.

**Auth:** X-Session-Id (required), must have compras access

**Request Body:** Empty

**Response (200):**
```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "sku": "string",
    "descricao": "string",
    "fornecedor_oc": "string",
    "compra_status": "aguardando_compra"
  }
}
```

**Response (404 - Item not found):**
```json
{
  "error": "Item não encontrado"
}
```

**Business Logic:**
- Fetches item
- Sets compra_status = "aguardando_compra"
- Unlinks from OC (ordem_compra_id = null)
- Preserves compra_solicitada_em (original request timestamp)
- Cancels OC if it becomes empty
- Item can be re-purchased via another OC

**Side Effects:**
- Updates `siso_pedido_itens.compra_status`, `ordem_compra_id`
- May delete `siso_ordens_compra` if OC becomes empty
- Logs to `siso_logs`

---

### POST /api/compras/itens/[itemId]/trocar-fornecedor

**File:** `src/app/api/compras/itens/[itemId]/trocar-fornecedor/route.ts`

**Purpose:** Changes the supplier of an item. Optionally moves it to a new OC.

**Auth:** X-Session-Id (required), must have compras access

**Request Body:**
```json
{
  "novo_fornecedor": "string",
  "nova_ordem_compra_id": "uuid (optional)"
}
```

**Response (200):**
```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "sku": "string",
    "descricao": "string",
    "fornecedor_oc": "string (new)",
    "compra_status": "comprado" | "aguardando_compra",
    "ordem_compra_id": "uuid | null"
  }
}
```

**Response (400 - Missing novo_fornecedor):**
```json
{
  "error": "novo_fornecedor é obrigatório"
}
```

**Response (404 - Item not found):**
```json
{
  "error": "Item não encontrado"
}
```

**Business Logic:**
- Fetches item
- Updates fornecedor_oc to novo_fornecedor
- If nova_ordem_compra_id provided:
  - Links item to new OC
  - Sets compra_status = "comprado"
- If NOT provided:
  - Unlinks from any OC
  - Sets compra_status = "aguardando_compra"
- Cancels old OC if it becomes empty

**Side Effects:**
- Updates `siso_pedido_itens.fornecedor_oc`, `ordem_compra_id`, `compra_status`
- May delete old `siso_ordens_compra` if it becomes empty
- Logs to `siso_logs`

---

### POST /api/compras/pedidos/[pedidoId]/cancelar

**File:** `src/app/api/compras/pedidos/[pedidoId]/cancelar/route.ts`

**Purpose:** Cancels entire order in Tiny and cleans up local purchase flow.

**Auth:** X-Session-Id (required), must have compras access

**Request Body:** Empty

**Response (200):**
```json
{
  "ok": true,
  "pedido_id": "uuid",
  "estoque_lancado_alerta": "boolean"
}
```

**Response (404 - Order not found):**
```json
{
  "error": "Pedido não encontrado"
}
```

**Business Logic:**
- Fetches pedido and resolves empresa_origem
- If pedido not already cancelled in DB: cancels in Tiny
- Fetches all compra items for pedido
- Marks compra items as "cancelado"
- Tracks if any items had estoque entrada (received stock)
- Cancels associated OCs that become empty
- Sets pedido.status = "cancelado"
- Cancels execution job in fila_execucao

**Side Effects:**
- Calls Tiny API atualizarStatusPedido
- Updates `siso_pedido_itens.compra_status`
- May delete `siso_ordens_compra` if OC becomes empty
- Updates `siso_pedidos.status`, `status_separacao`, `compra_estoque_lancado_alerta`
- Updates `siso_fila_execucao.status` to "cancelado"
- Logs to `siso_logs` with warning level

---

## Inventário API

### GET /api/inventario

**File:** `src/app/api/inventario/route.ts`

**Purpose:** List inventory sessions with computed item counts.

**Auth:** X-Session-Id (required)

**Query Params:**
- `status`: filter by inventory status (optional)

**Response (200):**
```json
{
  "inventarios": [
    {
      "id": "uuid",
      "empresa_id": "uuid",
      "galpao_id": "uuid",
      "usuario_id": "uuid",
      "modo": "string",
      "tipo_estoque": "string | null",
      "manter_localizacao_antiga": "boolean",
      "status": "em_andamento" | "processado" | "concluido" | "reversao",
      "observacoes": "string | null",
      "created_at": "ISO datetime",
      "processado_em": "ISO datetime | null",
      "concluido_em": "ISO datetime | null",
      "deposito_id": "number | null",
      "empresa": { "nome": "string" } | null,
      "galpao": { "nome": "string" } | null,
      "usuario": { "nome": "string" } | null,
      "total_itens": "number",
      "itens_sucesso": "number",
      "itens_erro": "number"
    }
  ]
}
```

**Business Logic:**
- Fetches inventory sessions (filtered by galpaoId if user has one)
- Computes item counts per status (total, sucesso, erro)
- Returns in descending order of creation

**Side Effects:** None (read-only)

---

### POST /api/inventario

**File:** `src/app/api/inventario/route.ts`

**Purpose:** Create a new inventory session.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "empresa_id": "uuid",
  "modo": "contagem" | "loc_estoque" | "etc",
  "tipo_estoque": "string (if modo=loc_estoque)",
  "manter_localizacao_antiga": "boolean | null",
  "observacoes": "string | null"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "empresa_id": "uuid",
  "galpao_id": "uuid",
  "deposito_id": "number",
  "modo": "string",
  "status": "em_andamento"
}
```

**Response (400 - Missing fields):**
```json
{
  "error": "empresa_id é obrigatório" | "modo é obrigatório"
}
```

**Business Logic:**
- Resolves galpao_id from empresa
- Resolves deposito_id from Tiny connection
- Creates inventory session in DB with status = "em_andamento"

**Side Effects:**
- Inserts to `siso_inventarios`
- Logs to `siso_logs`

---

## Inventário Item Operations

Additional endpoints for inventory items:
- GET `/api/inventario/[id]` - Fetch inventory session detail
- POST `/api/inventario/[id]/coletar` - Scan product into inventory
- PATCH `/api/inventario/[id]/itens/[itemId]` - Edit qty or delete
- POST `/api/inventario/[id]/processar` - Start processing (fire-and-forget)
- GET `/api/inventario/[id]/progresso` - Poll processing progress
- POST `/api/inventario/[id]/reverter` - Reverse completed inventory

---

## Transferência API

### GET /api/transferencia

**File:** `src/app/api/transferencia/route.ts`

**Purpose:** List inter-galpão transfer sessions with computed item counts. User sees transfers where their galpão is origin or destination.

**Auth:** X-Session-Id (required)

**Query Params:**
- `status`: filter by transfer status (optional)

**Response (200):**
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
      "deposito_origem_id": "number | null",
      "deposito_destino_id": "number | null",
      "status": "em_andamento" | "processado" | "concluido" | "reversao",
      "observacoes": "string | null",
      "created_at": "ISO datetime",
      "processado_em": "ISO datetime | null",
      "concluido_em": "ISO datetime | null",
      "empresa_origem": { "nome": "string" } | null,
      "empresa_destino": { "nome": "string" } | null,
      "galpao_origem": { "nome": "string" } | null,
      "galpao_destino": { "nome": "string" } | null,
      "usuario": { "nome": "string" } | null,
      "total_itens": "number",
      "itens_sucesso": "number",
      "itens_erro": "number"
    }
  ]
}
```

**Business Logic:**
- Fetches transfer sessions filtered by galpaoId (origin or destination)
- Computes item counts per status (total, sucesso, erro)
- Returns in descending order of creation

**Side Effects:** None (read-only)

---

### POST /api/transferencia

**File:** `src/app/api/transferencia/route.ts`

**Purpose:** Create a new inter-galpão transfer session.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "empresa_origem_id": "uuid",
  "empresa_destino_id": "uuid",
  "galpao_origem_id": "uuid",
  "galpao_destino_id": "uuid",
  "deposito_origem_id": "number | null",
  "deposito_destino_id": "number | null",
  "observacoes": "string (optional)"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "empresa_origem_id": "uuid",
  "empresa_destino_id": "uuid",
  "galpao_origem_id": "uuid",
  "galpao_destino_id": "uuid",
  "status": "em_andamento"
}
```

**Response (400 - Missing fields):**
```json
{
  "error": "empresa_origem_id e empresa_destino_id são obrigatórios"
}
```

**Business Logic:**
- Validates required fields
- Creates transfer session with status = "em_andamento"

**Side Effects:**
- Inserts to `siso_transferencias`
- Logs to `siso_logs`

---

### Transferência Item Operations

Additional endpoints for transfer items (parallel to inventory):
- GET `/api/transferencia/[id]` - Fetch transfer session detail
- POST `/api/transferencia/[id]/coletar` - Scan product from origin
- PATCH `/api/transferencia/[id]/itens/[itemId]` - Edit qty or delete
- POST `/api/transferencia/[id]/processar` - Start processing (fire-and-forget)
- GET `/api/transferencia/[id]/progresso` - Poll processing progress
- POST `/api/transferencia/[id]/reverter` - Reverse completed transfer

---

## Etiquetas API

### POST /api/etiquetas-endereco/preview

**File:** `src/app/api/etiquetas-endereco/preview/route.ts`

**Purpose:** Generates address label preview for a range of orders. Shows layout and formatting before printing.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "pedido_ids": ["string"],
  "tamanho": "pequeno" | "grande"
}
```

**Response (200):**
```json
{
  "labels": [
    {
      "pedido_id": "string",
      "numero": "string",
      "endereço": "string",
      "zpl": "string",
      "imagem_url": "string | null"
    }
  ],
  "total": "number"
}
```

**Response (400 - Missing fields):**
```json
{
  "error": "pedido_ids é obrigatório"
}
```

**Business Logic:**
- Fetches pedidos with their addresses
- Generates ZPL based on tamanho (pequeno = 2 labels per page rotated, grande = large label)
- Returns preview data for display

**Side Effects:** None (read-only)

---

### POST /api/etiquetas-endereco/imprimir

**File:** `src/app/api/etiquetas-endereco/imprimir/route.ts`

**Purpose:** Generates ZPL address labels and sends to PrintNode for printing via selected printer.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "pedido_ids": ["string"],
  "tamanho": "pequeno" | "grande",
  "printer_id": "number (PrintNode printer ID)"
}
```

**Response (200):**
```json
{
  "ok": true,
  "impressoes": "number",
  "printjob_ids": ["number"]
}
```

**Response (400 - Missing fields):**
```json
{
  "error": "pedido_ids, tamanho e printer_id são obrigatórios"
}
```

**Response (500 - PrintNode error):**
```json
{
  "error": "Erro ao enviar para impressora: ..."
}
```

**Business Logic:**
- Validates all fields
- Fetches pedidos with addresses
- Generates ZPL labels
- Sends to PrintNode API with specified printer
- Returns print job IDs for tracking

**Side Effects:**
- Calls PrintNode API
- Logs to `siso_logs`

---

## Admin API

### GET /api/admin/galpoes

**File:** `src/app/api/admin/galpoes/route.ts`

**Purpose:** Returns galpões with nested empresas, grupo info, and Tiny connection status.

**Auth:** None (should be admin-only, no validation currently)

**Response (200):**
```json
[
  {
    "id": "uuid",
    "nome": "string",
    "descricao": "string | null",
    "ativo": "boolean",
    "printnode_printer_id": "number | null",
    "printnode_printer_nome": "string | null",
    "criado_em": "ISO datetime",
    "atualizado_em": "ISO datetime | null",
    "siso_empresas": [
      {
        "id": "uuid",
        "nome": "string",
        "cnpj": "string",
        "ativo": "boolean",
        "grupo": {
          "id": "uuid",
          "nome": "string"
        } | null,
        "tier": "number | null",
        "grupoEmpresaId": "uuid | null",
        "conexao": {
          "id": "uuid",
          "ativo": "boolean",
          "conectado": "boolean",
          "ultimoTesteOk": "ISO datetime | null",
          "depositoId": "number | null",
          "depositoNome": "string | null"
        } | null
      }
    ]
  }
]
```

**Business Logic:**
- Fetches all galpões with nested empresas, grupo relations, and Tiny connections
- Flattens nested data for easier client consumption

**Side Effects:** None (read-only)

---

### POST /api/admin/galpoes

**File:** `src/app/api/admin/galpoes/route.ts`

**Purpose:** Create a new galpão.

**Auth:** None (should be admin-only)

**Request Body:**
```json
{
  "nome": "string",
  "descricao": "string | null"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "nome": "string"
}
```

**Response (409 - Duplicate name):**
```json
{
  "error": "Já existe um galpão com esse nome"
}
```

**Business Logic:**
- Validates nome is not empty
- Inserts to `siso_galpoes` (nome is unique)

**Side Effects:**
- Inserts to `siso_galpoes`

---

### GET /api/admin/usuarios

**File:** `src/app/api/admin/usuarios/route.ts`

**Purpose:** Lists all users with their galpão associations (without exposing PIN).

**Auth:** None (should be admin-only)

**Response (200):**
```json
[
  {
    "id": "uuid",
    "nome": "string",
    "cargo": "string",
    "cargos": ["string"],
    "ativo": "boolean",
    "criado_em": "ISO datetime",
    "atualizado_em": "ISO datetime | null",
    "printnode_printer_id": "number | null",
    "printnode_printer_nome": "string | null",
    "galpoes": [
      {
        "id": "uuid",
        "nome": "string"
      }
    ]
  }
]
```

**Business Logic:**
- Fetches all users
- Fetches galpão associations from `siso_usuario_galpoes`
- Normalizes cargos (single cargo column → array)

**Side Effects:** None (read-only)

---

### POST /api/admin/usuarios

**File:** `src/app/api/admin/usuarios/route.ts`

**Purpose:** Create a new user with optional galpão associations.

**Auth:** None (should be admin-only)

**Request Body:**
```json
{
  "nome": "string",
  "pin": "string (4 digits)",
  "cargos": ["string"] (or legacy "cargo")
  "galpao_ids": ["uuid | null"]
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "nome": "string",
  "cargo": "string",
  "cargos": ["string"],
  "ativo": "boolean",
  "criado_em": "ISO datetime"
}
```

**Response (400 - Invalid PIN):**
```json
{
  "erro": "PIN deve ter exatamente 4 dígitos"
}
```

**Business Logic:**
- Validates nome, pin, and at least one cargo
- Validates PIN is exactly 4 digits
- Validates cargo values
- Creates user in `siso_usuarios`
- Creates galpão associations if provided

**Side Effects:**
- Inserts to `siso_usuarios` and `siso_usuario_galpoes`

---

### PUT /api/admin/usuarios

**File:** `src/app/api/admin/usuarios/route.ts`

**Purpose:** Update a user. If galpao_ids provided, replaces all galpão associations.

**Auth:** None (should be admin-only)

**Request Body:**
```json
{
  "id": "uuid",
  "nome": "string | null",
  "pin": "string | null",
  "cargos": ["string"] | null,
  "ativo": "boolean | null",
  "galpao_ids": ["uuid"] | null,
  "printnode_printer_id": "number | null",
  "printnode_printer_nome": "string | null"
}
```

**Response (200):**
```json
{
  "id": "uuid",
  "nome": "string",
  "cargo": "string",
  "cargos": ["string"],
  "ativo": "boolean",
  "atualizado_em": "ISO datetime"
}
```

**Business Logic:**
- Updates `siso_usuarios` fields
- If galpao_ids provided: deletes all existing associations and inserts new ones
- Syncs legacy cargo column with first item from cargos

**Side Effects:**
- Updates `siso_usuarios`
- Deletes and inserts `siso_usuario_galpoes` rows

---

### DELETE /api/admin/usuarios?id=uuid

**File:** `src/app/api/admin/usuarios/route.ts`

**Purpose:** Deletes a user permanently (galpão associations cascade).

**Auth:** None (should be admin-only)

**Response (200):**
```json
{
  "ok": true
}
```

**Business Logic:**
- Deletes user from `siso_usuarios` (cascade deletes associations)

**Side Effects:**
- Deletes from `siso_usuarios` (cascades to `siso_usuario_galpoes`)

---

### Additional Admin Routes - Galpões

- **GET** `/api/admin/galpoes/[id]` - Fetch galpão detail with nested empresas and grupo info
- **PUT** `/api/admin/galpoes/[id]` - Update galpão name, descricao, ativo status
- **DELETE** `/api/admin/galpoes/[id]` - Delete galpão (cascades to empresas)

### Additional Admin Routes - Empresas

- **GET** `/api/admin/empresas` - List all empresas with galpão, grupo, and Tiny connection info
- **POST** `/api/admin/empresas` - Create new empresa (CNPJ, name, galpão)
- **PUT** `/api/admin/empresas/[id]` - Update empresa name, CNPJ, ativo status
- **DELETE** `/api/admin/empresas/[id]` - Delete empresa (cascades to grupo relations and connections)

### Additional Admin Routes - Grupos

- **GET** `/api/admin/grupos` - List all grupos
- **POST** `/api/admin/grupos` - Create new grupo (name, descricao)
- **PUT** `/api/admin/grupos/[id]` - Update grupo name, descricao
- **DELETE** `/api/admin/grupos/[id]` - Delete grupo (cascades to empresa relations)

### Additional Admin Routes - Grupo-Empresa Relations

- **POST** `/api/admin/grupos/[id]/empresas` - Add empresa to grupo (updates or creates empresa_id + tier)
- **PUT** `/api/admin/grupos/[id]/empresas/[empresaId]` - Update empresa tier in grupo
- **DELETE** `/api/admin/grupos/[id]/empresas/[empresaId]` - Remove empresa from grupo

### Additional Admin Routes - PrintNode

- **GET** `/api/admin/printnode/api-key` - Fetch stored PrintNode API key
- **PUT** `/api/admin/printnode/api-key` - Update PrintNode API key
- **DELETE** `/api/admin/printnode/api-key` - Delete PrintNode API key
- **GET** `/api/admin/printnode/printers` - List available printers from PrintNode
- **POST** `/api/admin/printnode/test` - Test PrintNode connection

---

## Tiny ERP API

### GET /api/tiny/connections

**Purpose:** List/manage Tiny OAuth2 connections per empresa.

**Auth:** None (should be admin-only)

See `src/app/api/tiny/connections/route.ts`

---

### POST /api/tiny/oauth

**Purpose:** Initiate OAuth2 flow for Tiny.

**Auth:** None

See `src/app/api/tiny/oauth/route.ts`

---

### GET /api/tiny/oauth/callback

**Purpose:** OAuth2 callback from Tiny. Stores access token.

**Auth:** None (Tiny redirects here)

See `src/app/api/tiny/oauth/callback/route.ts`

---

### GET /api/tiny/deposits

**Purpose:** List Tiny deposits (warehouses) for a given empresa.

**Auth:** None (should require auth)

See `src/app/api/tiny/deposits/route.ts`

---

### POST /api/tiny/test-connection

**Purpose:** Test Tiny connection for an empresa.

**Auth:** None (should be admin-only)

See `src/app/api/tiny/test-connection/route.ts`

---

### POST /api/tiny/stock/ajustar

**Purpose:** Manually adjust stock in Tiny ERP.

**Auth:** None (should require auth)

See `src/app/api/tiny/stock/ajustar/route.ts`

---

## Worker & Background Jobs

### POST /api/worker/processar

**File:** `src/app/api/worker/processar/route.ts`

**Purpose:** Triggers the execution worker to process pending jobs from `siso_fila_execucao`.

**Auth:** Optional Bearer token (WORKER_SECRET env var)

**Query Params:**
- `limit`: max jobs to process (default 5; 0 = drain entire queue via singleton loop)

**Response (200):**
```json
{
  "processed": "number",
  "errors": "number",
  "rateLimited": "number"
}
```

**Response (200 - Queue draining):**
```json
{
  "status": "draining"
}
```

**Response (401 - Auth required):**
```json
{
  "error": "Unauthorized"
}
```

**Business Logic:**
- If WORKER_SECRET set: validates Authorization header
- If limit = 0: kicks worker singleton (drains entire queue asynchronously)
- Otherwise: processes up to `limit` jobs (capped at 20)
- Each job: fetches order, enriches stock, calculates suggestion, posts to Tiny, updates DB
- Handles rate limiting per empresa
- Three worker flows per decision type:
  - `propria`: marcadores → NF → stock posting → `criarAgrupamentoFase1` (fire-and-forget after stock persisted)
  - `transferencia`: marcadores → NF → stock posting → `criarAgrupamentoFase1` (fire-and-forget after stock persisted)
  - `oc`: marcadores → NF generation (no stock) → `criarAgrupamentoFase1` → compra item resolution. NF failure isolated from compra resolution via try/catch. Stock deferred to Ciclo 2 (after compras-release)

**Side Effects:**
- Processes jobs from `siso_fila_execucao`
- Updates `siso_pedidos` stock and status
- Calls Tiny API (marcadores, NF, stock posting, agrupamento creation)
- Creates fase-1 agrupamento (fire-and-forget) after NF persistence
- Logs to `siso_logs`

**Rate Limiting:** Per-empresa via rate-limiter.ts

**Notes:**
- Can be called from cron job (e.g., every 10 seconds)
- Can be called directly from `/api/pedidos/aprovar` via `kickWorker()`
- Can be called manually from monitoring page
- OC orders now generate NF at approval time (creating Tiny reservation). The Ciclo 2 worker (after compras-release) detects existing NF via `gerarNotaFiscalPedido` idempotency and skips to stock deduction
- `criarAgrupamentoFase1` is fire-and-forget: agrupamento failure after stock posting never causes job retry

---

## Dashboard & Monitoring

### GET /api/dashboard/counts

**File:** `src/app/api/dashboard/counts/route.ts`

**Purpose:** Lightweight endpoint returning pending counts for each module card.

**Auth:** X-Session-Id (required)

**Response (200):**
```json
{
  "siso": "number (pending orders)",
  "separacao": "number (orders in separation)",
  "compras": "number (orders awaiting purchase)"
}
```

**Response (401 - No session):**
```json
{
  "error": "sessao_invalida"
}
```

**Business Logic:**
- Counts orders by status and galpão
- For operators: filters by assigned galpão
- For admins: returns global counts

**Side Effects:** None (read-only)

---

### GET /api/painel

**File:** `src/app/api/painel/route.ts`

**Purpose:** Aggregated data for the control tower view. Includes pipeline counts, aging, deadlines, cycle time, throughput, operator workload, decision mix, channel mix, etc.

**Auth:** None (should require auth)

**Query Params:**
- `galpao_id`: filter by galpão (optional)

**Response (200):**
```json
{
  "server_time": "ISO datetime",
  "galpoes": [{ "id": "uuid", "nome": "string" }],
  "pipeline": {
    "aguardando_compra": "number",
    "aguardando_nf": "number",
    "aguardando_separacao": "number",
    "em_separacao": "number",
    "separado": "number",
    "embalado": "number"
  },
  "throughput": {
    "buckets": [
      {
        "hour": "number (0-23)",
        "count": "number"
      }
    ],
    "total_today": "number"
  },
  "alerts": {
    "stuck_nf": "number (orders waiting NF > 4h)",
    "stuck_separacao": "number (picking > 2h)",
    "recent_errors": "number (errors in last 1h)",
    "error_samples": [
      {
        "source": "string",
        "message": "string",
        "timestamp": "ISO datetime"
      }
    ]
  },
  "kpis": {
    "processed_today": "number",
    "pipeline_total": "number",
    "avg_cycle_time_min": "number | null"
  },
  "operations": {
    "summary": { ...detailed metrics... },
    "funnel": { ...pipeline stages with bottleneck... },
    "deadlines": { ...overdue/due_in_2h/due_today/future counts... },
    "aging": { ...orders stuck in each stage... },
    "throughput": { ...hourly/daily/weekly metrics... },
    "operators": { ...workload by operator... }
  },
  "management": {
    "lead_time": { ...cycle time metrics... },
    "decision_mix": [...decision type breakdown...],
    "channel_mix": [...e-commerce channel breakdown...],
    "galpao_mix": [...galpão distribution...],
    "concentration": { ...bottleneck and concentration analysis... }
  }
}
```

**Business Logic:**
- Fetches orders from siso_pedidos (paginated to handle large datasets)
- Computes:
  - Pipeline counts per status
  - Cycle time averages and percentiles
  - Deadline aging analysis
  - Hourly throughput
  - Operator workload distribution
  - Decision type mix
  - E-commerce channel distribution
  - Galpão concentration
  - Bottleneck identification
- All BRT timezone aware

**Side Effects:** None (read-only)

---

### GET /api/monitoring

**File:** `src/app/api/monitoring/route.ts`

**Purpose:** Returns monitoring data for the monitoring dashboard (admin only).

**Auth:** None (should be admin-only)

**Response:** (Complex monitoring data structure - see route file for details)

---

## Reconciliation API

### GET /api/reconciliacao

**File:** `src/app/api/reconciliacao/route.ts`

**Purpose:** Reconciliation: find and reprocess lost orders that exist in Tiny but not in SISO, or orders stuck in webhook queue.

**Auth:** None (should be admin-only)

**Query Params:**
- (none currently)

**Response (200):**
```json
{
  "found_in_tiny": "number",
  "reprocessed": "number",
  "erro": "string | null"
}
```

**Business Logic:**
- Queries Tiny for recent approved orders
- Checks if they exist in SISO's `siso_pedidos`
- If missing: fetches order data and queues for processing
- Also finds and reprocesses webhook logs stuck in "pendente" status
- Returns counts of found and reprocessed orders

**Side Effects:**
- Inserts webhook logs
- Enqueues `processWebhook` tasks
- Logs to `siso_logs`

**Rate Limiting:** Per-empresa via Tiny API rate limiter

---

## Cross — Busca de produtos e equivalência

Módulo de catálogo e equivalência de SKUs/OEMs/veículos. Cache desnormalizado de produtos do Tiny em `siso_produtos_catalogo`, com OEMs e compatibilidade veicular como fontes de verdade em tabelas próprias e denormalização via trigger.

### GET /api/cross/search

**File:** `src/app/api/cross/search/route.ts`

**Purpose:** Busca universal de produtos por SKU, código OEM, nome ou modo automático (heurística).

**Auth:** Sessão via `X-Session-Id`

**Query Params:**
- `q` (required): texto de busca (mínimo 2 caracteres)
- `tipo` (optional, default `auto`): `auto`, `sku`, `oem`, `nome`

**Response (200):**
```json
{
  "query": "string",
  "tipo_detectado": "sku" | "oem" | "nome",
  "total": "number",
  "resultados": [
    {
      "sku": "string",
      "nome": "string",
      "fornecedor": "string | null",
      "marca": "string | null",
      "imagem_url": "string | null",
      "oems": ["string"],
      "estoque_total": "number",
      "match": "sku_exato" | "sku_prefixo" | "oem" | "nome"
    }
  ]
}
```

**Response (400 - Validação):**
```json
{ "error": "q deve ter pelo menos 2 caracteres" }
```

**Business Logic:**
- Valida `q` (mín 2 chars) e `tipo`
- Modo `auto`: detecta SKU exato → OEM exato → fallback para busca por nome (trigram)
- Modo `sku`: busca por SKU exato/prefixo via índice trigram
- Modo `oem`: busca em `oem text[]` via índice GIN
- Modo `nome`: busca trigram no campo `nome`
- Persiste a busca em `siso_cross_logs` (fire-and-forget) para telemetria

**Side Effects:**
- Insere em `siso_cross_logs` (query_tipo, query_texto, resultado_count, usuario_id)

**Rate Limiting:** None

---

### GET /api/cross/produtos/[sku]

**File:** `src/app/api/cross/produtos/[sku]/route.ts`

**Purpose:** Detalhe completo de um produto: nome, descrição, OEMs, veículos compatíveis, estoque por galpão e SKUs equivalentes.

**Auth:** Sessão via `X-Session-Id`

**Response (200):**
```json
{
  "sku": "string",
  "nome": "string",
  "descricao": "string | null",
  "fornecedor": "string | null",
  "marca": "string | null",
  "imagem_url": "string | null",
  "gtin": "string | null",
  "sincronizado_em": "ISO datetime | null",
  "oems": [
    {
      "id": "number",
      "codigo": "string",
      "origem": "extracao_tiny" | "manual",
      "adicionado_por": "uuid | null",
      "adicionado_por_nome": "string | null",
      "adicionado_em": "ISO datetime",
      "pode_remover": "boolean"
    }
  ],
  "veiculos": [
    {
      "id": "number",
      "marca": "string",
      "modelo": "string",
      "ano_inicio": "number | null",
      "ano_fim": "number | null",
      "variante": "string | null",
      "adicionado_por": "uuid | null",
      "adicionado_por_nome": "string | null",
      "adicionado_em": "ISO datetime",
      "pode_remover": "boolean"
    }
  ],
  "estoque_por_galpao": {
    "<galpao_nome>": {
      "saldo": "number",
      "reservado": "number",
      "disponivel": "number",
      "deposito_nome": "string | null",
      "localizacao": "string | null"
    }
  },
  "equivalentes": [
    {
      "sku": "string",
      "nome": "string",
      "imagem_url": "string | null",
      "oems_compartilhados": ["string"],
      "estoque_por_galpao": {
        "<galpao_nome>": { "saldo": "number", "reservado": "number", "disponivel": "number" }
      },
      "estoque_total": "number"
    }
  ]
}
```

**Response (404):** `{ "error": "SKU \"<sku>\" não encontrado no Tiny" }` (lazy fetch) ou `{ "error": "Produto não encontrado" }` (já populado mas detalhe vazio)
**Response (503):** `{ "error": "Tiny indisponível, tente em alguns minutos" }` quando o lazy fetch falha
**Response (500):** `{ "error": "Nenhuma empresa Tiny configurada para o seu galpão" }` se o usuário não tem galpão/empresa associada

**Business Logic:**
- Lê `siso_produtos_catalogo` por `sku`
- Se não existir: faz lazy fetch via `produto-fetcher.ts` → consulta Tiny por SKU, persiste no catálogo
- Se Tiny não conhecer o SKU: 404
- Se Tiny estiver offline: 503
- Calcula equivalentes consultando outros SKUs com OEM em comum
- Estoque é consultado **ao vivo no Tiny** a cada requisição (não há cache em DB) — agregado por galpão usando o depósito configurado em `siso_tiny_connections`
- `pode_remover` em OEMs/veículos indica se o usuário corrente pode remover aquela entrada (admin sempre pode; demais cargos só removem o que adicionaram manualmente)

**Side Effects:**
- Possíveis upserts em `siso_produtos_catalogo`, `siso_produto_oems` (origem `extracao_tiny`)

**Rate Limiting:** Per-empresa via Tiny API rate limiter (no lazy fetch)

---

### POST /api/cross/produtos/[sku]/refetch

**File:** `src/app/api/cross/produtos/[sku]/refetch/route.ts`

**Purpose:** Força refresh bloqueante do cache do produto via Tiny.

**Auth:** Sessão via `X-Session-Id`

**Request Body:** Empty

**Response (200):**
```json
{ "ok": true, "sku": "string" }
```

**Response (404):** `{ "error": "SKU \"<sku>\" não encontrado no Tiny" }`
**Response (503):** `{ "error": "Tiny indisponível, tente em alguns minutos" }`
**Response (500):** `{ "error": "Nenhuma empresa Tiny configurada para o seu galpão" }`

**Business Logic:**
- Chama `produto-fetcher.ts` em modo bloqueante
- Atualiza `siso_produtos_catalogo` (nome, descricao, marca, fornecedor, imagem_url, gtin, sincronizado_em)
- Re-extrai OEMs da descrição via `oem-extractor.ts`; insere os novos como `origem='extracao_tiny'` (não duplica os manuais)
- Triggers recomputam `oem text[]` e `compatibility_v2 jsonb` automaticamente
- Não retorna o detalhe — o cliente deve chamar `GET /api/cross/produtos/[sku]` em seguida

**Side Effects:**
- Update em `siso_produtos_catalogo`
- Insert em `siso_produto_oems` (apenas novos OEMs extraídos)

**Rate Limiting:** Per-empresa via Tiny API rate limiter

---

### POST /api/cross/produtos/[sku]/oems

**File:** `src/app/api/cross/produtos/[sku]/oems/route.ts`

**Purpose:** Adiciona um código OEM manual ao produto. Avisa se o mesmo código já existe em outros SKUs (cruzamento).

**Auth:** Sessão via `X-Session-Id`

**Request Body:**
```json
{ "codigo": "string" }
```

**Validation:**
- `codigo` regex: `^[A-Z0-9.\-]{4,30}$` (uppercase, dígitos, ponto, hífen; 4–30 chars)

**Response (200):**
```json
{
  "ok": true,
  "codigo": "string",
  "cruzamentos": [
    { "sku": "string", "nome": "string" }
  ]
}
```

**Response (400 - Validação):** `{ "error": "codigo_invalido" }`
**Response (404 - Produto):** `{ "error": "produto_nao_encontrado" }`
**Response (409 - Duplicado):** `{ "error": "oem_ja_cadastrado" }`

**Business Logic:**
- Insere em `siso_produto_oems` com `origem='manual'`, `adicionado_por=user.id`
- Trigger AFTER INSERT recomputa `siso_produtos_catalogo.oem`
- Após inserir, busca outros SKUs que tenham o mesmo `oem_code` para retornar no campo `cruzamentos` (sugestão de equivalência)

**Side Effects:**
- Insert em `siso_produto_oems`
- Trigger atualiza `siso_produtos_catalogo.oem`

---

### DELETE /api/cross/produtos/[sku]/oems/[codigo]

**File:** `src/app/api/cross/produtos/[sku]/oems/[codigo]/route.ts`

**Purpose:** Remove um código OEM do produto.

**Auth:** Sessão via `X-Session-Id`

**Response (200):** `{ "ok": true }`

**Response (403):** `{ "error": "sem_permissao" }`
**Response (404):** `{ "error": "oem_nao_encontrado" }`

**Business Logic:**
- **admin:** pode remover qualquer OEM (manual ou extraído)
- **outros cargos:** só podem remover OEMs com `origem='manual'` que eles mesmos cadastraram (`adicionado_por = user.id`)
- Trigger AFTER DELETE recomputa `siso_produtos_catalogo.oem`

**Side Effects:**
- Delete em `siso_produto_oems`
- Trigger atualiza `siso_produtos_catalogo.oem`

---

### POST /api/cross/produtos/[sku]/veiculos

**File:** `src/app/api/cross/produtos/[sku]/veiculos/route.ts`

**Purpose:** Adiciona uma compatibilidade veicular ao produto.

**Auth:** Sessão via `X-Session-Id`

**Request Body:**
```json
{
  "marca": "string",
  "modelo": "string",
  "ano_inicio": "number | null",
  "ano_fim": "number | null",
  "variante": "string | null"
}
```

**Validation:**
- `marca` e `modelo` obrigatórios e não vazios
- `ano_inicio` e `ano_fim` (se presentes) entre 1900 e 2100
- Se ambos presentes, `ano_inicio <= ano_fim`

**Response (200):**
```json
{ "ok": true, "id": "number" }
```

**Response (400 - Validação):** `{ "error": "..." }`
**Response (404):** `{ "error": "produto_nao_encontrado" }`
**Response (409 - Duplicado):** `{ "error": "veiculo_ja_cadastrado" }`

**Business Logic:**
- Insere em `siso_produto_veiculos` com `adicionado_por=user.id`
- UNIQUE em `(produto_sku, marca, modelo, ano_inicio, ano_fim, variante)`
- Trigger AFTER INSERT recomputa `siso_produtos_catalogo.compatibility_v2`

**Side Effects:**
- Insert em `siso_produto_veiculos`
- Trigger atualiza `siso_produtos_catalogo.compatibility_v2`

---

### DELETE /api/cross/produtos/[sku]/veiculos/[id]

**File:** `src/app/api/cross/produtos/[sku]/veiculos/[id]/route.ts`

**Purpose:** Remove uma compatibilidade veicular do produto.

**Auth:** Sessão via `X-Session-Id`

**Response (200):** `{ "ok": true }`

**Response (403):** `{ "error": "sem_permissao" }`
**Response (404):** `{ "error": "veiculo_nao_encontrado" }`

**Business Logic:**
- **admin:** pode remover qualquer veículo
- **outros cargos:** só podem remover veículos que eles mesmos cadastraram (`adicionado_por = user.id`)
- Trigger AFTER DELETE recomputa `siso_produtos_catalogo.compatibility_v2`

**Side Effects:**
- Delete em `siso_produto_veiculos`
- Trigger atualiza `siso_produtos_catalogo.compatibility_v2`

---

### GET /api/cross/sugestoes/marcas

**File:** `src/app/api/cross/sugestoes/marcas/route.ts`

**Purpose:** Autocomplete de marcas de veículos cadastradas no catálogo.

**Auth:** Sessão via `X-Session-Id`

**Query Params:**
- `q`: prefixo (opcional)

**Response (200):**
```json
{ "marcas": ["string"] }
```

**Business Logic:**
- Lista DISTINCT de `marca` em `siso_produto_veiculos` filtrando por prefixo `q` (ILIKE)
- Ordenado alfabeticamente; limitado a 20 resultados

**Side Effects:** None

---

### GET /api/cross/sugestoes/modelos

**File:** `src/app/api/cross/sugestoes/modelos/route.ts`

**Purpose:** Autocomplete de modelos para uma marca específica.

**Auth:** Sessão via `X-Session-Id`

**Query Params:**
- `marca` (required): marca exata
- `q` (optional): prefixo do modelo

**Response (200):**
```json
{ "modelos": ["string"] }
```

**Response (400):** `{ "error": "marca_obrigatoria" }`

**Business Logic:**
- Lista DISTINCT de `modelo` em `siso_produto_veiculos` filtrando por `marca` exata e prefixo `q` opcional (ILIKE)
- Ordenado alfabeticamente; limitado a 20 resultados

**Side Effects:** None

---

## WMS — Foundation (Plano 1)

Schema 4D: cada posição de estoque é única por **(produto_id, empresa_dona_id, galpao_id, localizacao_id)**. Toda escrita no ledger passa pela RPC `wms_inserir_movimentacao` (lock pessimista no Postgres).

### GET /api/wms/produtos

Lista produtos do catálogo unificado.

**Auth:** Session.

**Query params:**
- `q` (opcional) — busca em sku, descricao, gtin
- `ativo` — `true|false`
- `limit` (default 50), `offset` (default 0)

**Response 200:**
```json
{ "rows": [{"id":"...","sku":"...","descricao":"...","gtin":null,"ncm":null,"sincronizado_em":null,"ativo":true,...}], "total": 123 }
```

### POST /api/wms/produtos

Cria produto no catálogo.

**Auth:** Session.

**Request body:** `{ sku, descricao, gtin?, unidade?, ncm? }`

**Response 201:** Produto criado.

**Erros:** 400 se `sku` ou `descricao` ausente.

### GET /api/wms/produtos/[id]

Detalhe do produto.

**Response:** Produto ou 404.

### PATCH /api/wms/produtos/[id]

Atualiza campos do produto. Body é `Partial<Produto>`.

### POST /api/wms/produtos/[id]/sync

Força sincronização com Tiny via mapeamento ativo. Atualiza descricao, gtin, ncm, unidade, origem_fiscal, imagem_url + carimba `sincronizado_em`.

**Side Effects:** UPDATE em `siso_produtos`. Chama Tiny API (rate-limited via `runWithEmpresa`).

**Response 200:** `{ ok: true }` ou 500 com erro.

### GET /api/wms/produtos/[id]/ultimas-contagens

Retorna a última contagem de inventário desse produto agrupada por (localização + empresa dona). Inclui contagens de sessões em qualquer status menos `cancelada` — útil pra mostrar "conferido em X" mesmo quando a contagem não gerou divergência (e portanto não há mov no ledger). Usado pela aba "Movimentações" do produto.

**Auth:** `requireAuth` (qualquer usuário autenticado).

**RPC:** `wms_produto_ultimas_contagens(p_produto_id uuid)` faz `DISTINCT ON (localizacao_id, empresa_dona_id)` ordenado por `criado_em DESC`. Joina com `siso_localizacoes`, `siso_galpoes`, `siso_empresas`, `siso_usuarios`, `siso_inventario_sessoes` e `siso_estoque` (LEFT) pra trazer o saldo atual da quádrupla.

**Response 200:**
```json
{
  "rows": [
    {
      "localizacao_id": "uuid",
      "loc_codigo": "A-01-01",
      "loc_tipo": "picking",
      "galpao_id": "uuid",
      "galpao_nome": "CWB",
      "empresa_dona_id": "uuid",
      "empresa_nome": "NetAir",
      "qty_contada": 10,
      "contada_por": "uuid",
      "contada_por_nome": "Eryk",
      "contada_em": "2026-05-12T14:17:31Z",
      "sessao_id": "uuid",
      "sessao_nome": "rua a",
      "sessao_status": "aplicada",
      "saldo_atual": 10
    }
  ]
}
```

Ordenado por `contada_em DESC` (a primeira linha é a última contagem global do produto).

### GET /api/wms/localizacoes

Lista localizações ativas, opcionalmente filtradas por galpão.

**Query params:** `galpao_id` (opcional).

**Response 200:** `{ rows: Localizacao[] }`.

### POST /api/wms/localizacoes

Cria localização.

**Request body:** `{ galpao_id, codigo, descricao?, tipo? }` (tipo default `picking`).

**Response 201:** Localizacao.

### POST /api/wms/localizacoes/lote

Cria localizações em lote a partir do produto cartesiano de dois eixos numéricos.

**Auth:** `requireAuth` (qualquer usuário logado).

**Request body:**
```json
{
  "galpao_id": "uuid",
  "prefixo": "A",
  "h_inicio": 1, "h_fim": 10,
  "v_inicio": 1, "v_fim": 10,
  "tipo": "picking",
  "preview": false
}
```

- `prefixo` 1–8 chars `[A-Z0-9]`.
- Ranges inteiros ≥ 1, `inicio ≤ fim`.
- Total máximo 5000 localizações por chamada (proteção contra digitação errada).
- Padding por eixo: `max(2, len(str(fim)))` — ex: 1–10 vira `01..10`, 1–100 vira `001..100`.
- `tipo` opcional, default `picking`.
- `preview: true` calcula contagem + duplicatas e amostra **sem inserir**.

**Response 200:**
```json
{
  "total": 100,
  "criadas": 77,
  "ja_existiam": 23,
  "amostra": {
    "primeiras": ["A-01-01", "A-01-02", "A-01-03", "A-01-04", "A-01-05"],
    "ultimas":   ["A-10-06", "A-10-07", "A-10-08", "A-10-09", "A-10-10"]
  }
}
```

Se `total ≤ 10`: `amostra.primeiras` = lista completa, `amostra.ultimas` = `[]`.
`criadas + ja_existiam` sempre = `total`.

**Side effects (quando `preview:false`):** bulk `INSERT ... ON CONFLICT (galpao_id,codigo) DO NOTHING` em `siso_localizacoes`. Idempotente — rodar o mesmo lote 2x não duplica nada.

**Erros 400:** prefixo inválido, range invertido, total acima do limite, valores não-inteiros.

### PATCH /api/wms/localizacoes/[id]

Atualiza campos da localização.

### DELETE /api/wms/localizacoes/[id]

Desativa logicamente. Falha com 400 se houver saldo>0.

### GET /api/wms/localizacoes/[id]/saldos

Lista saldos > 0 da localização, agrupados por (produto, empresa_dona). Usado no fluxo de exclusão pra mostrar o que precisa ser movido antes da remoção.

**Auth:** `requireAuth`.

**Response 200:**
```json
{
  "rows": [
    {
      "produto_id": "uuid",
      "empresa_dona_id": "uuid",
      "saldo": 12,
      "sku": "ABC-123",
      "descricao": "Produto X",
      "empresa_nome": "NetParts"
    }
  ],
  "total_qty": 12,
  "total_linhas": 1
}
```

### POST /api/wms/localizacoes/[id]/substituir-e-excluir

Move todo o saldo > 0 da loc origem pra loc destino (mesmo galpão), agrupado por `empresa_dona`, e desativa a origem.

**Auth:** `requireAdmin`.

**Request body:** `{ destino_id: uuid }`.

**Validações:** origem e destino existem; destino está ativo; mesma `galpao_id`; `destino_id !== id`.

**Comportamento:** carrega saldos > 0 da origem, agrupa por `empresa_dona`, chama `replenishmentIntraGalpao` (par S+E por SKU com `origem_tipo='transferencia_localizacao'`) uma vez por dona, depois `desativarLocalizacao(origem)`.

**Atomicidade:** cada par S+E é atômico via `wms_inserir_movimentacao`, mas a sequência não tem rollback. Se falhar mid-flight, alguns SKUs já moveram e a loc origem não foi desativada — rodar de novo é seguro (o já-movido fica em saldo=0 e é ignorado).

**Response 200:** `{ ok, origem_codigo, destino_codigo, donas_movidas, itens_movidos }`.

### GET /api/wms/estoque

Saldos agregados por perspectiva.

**Query params:**
- `view` — `dono|galpao|localizacao|produto` (default `produto`)
- `produto_id`, `empresa_id`, `galpao_id` — filtros opcionais

**Response 200:** `{ rows: [{ chave, nome, saldo, reservado, disponivel, itens: [...] }] }` ordenado por saldo desc.

### GET /api/wms/ledger

Lista movimentações (mais recentes primeiro).

**Query params:** `produto_id`, `empresa_id`, `galpao_id`, `localizacao_id`, `origem_tipo`, `desde`, `ate`, `limit` (default 100).

**Response 200:** `{ rows: Movimentacao[] }` com joins (produto, empresa, galpao, localizacao).

### POST /api/wms/snapshot-inicial

Bulk-load idempotente do Tiny pra popular `siso_estoque` (Fase 0).

**Auth:** Admin only.

**Query params:** `dryRun=true` para apenas contar.

**Response 200:** `{ total, criados, pulados, erros }`.

**Side Effects:** Chama Tiny `/estoque/{id}` por cada (produto, empresa) com mapeamento ativo, cria mov `inventario_inicial` na DEFAULT-PICKING. Idempotente (pula se já existe mov inventario_inicial pra a quádrupla).

### GET /api/wms/reconciliacao

Detecta divergências entre `siso_movimentacoes` (autoritativo) e `siso_estoque` (cache). Cron-friendly.

**Auth:** Header `x-worker-secret` = `WORKER_SECRET`.

**Query params:** `fix=true` corrige automaticamente via `wms_rebuild_linha_estoque`.

**Response 200:** `{ divergencias: [...], corrigidas: number }`.

---

## WMS — Movimentações operacionais (Plano 2)

Todas as operações orquestram chamadas a `wms_inserir_movimentacao` (RPC com lock pessimista do Plano 1). `usuario_id` é injetado pelo route handler a partir da sessão.

### POST /api/wms/receber

Registra entrada de estoque (etapa 1 de 2). Sempre grava na localização tipo='recebimento' do galpão (auto-criada se necessário) e cria 1 pendência em `siso_wms_pendencias_guarda` por linha — a guarda física (decidir loc final + bipar QR + imprimir etiquetas) acontece em `/api/wms/guarda/*`.

**Auth:** Session + acesso de armazém (operador/admin).

**Request body:**
```json
{
  "empresa_dona_id": "uuid",
  "galpao_id": "uuid",
  "nf_referencia": "string?",
  "origem_tipo": "compra_manual | nf_compra | nf_devolucao_cliente | lancamento_retroativo",
  "observacoes": "string?",
  "data_recebimento": "ISO timestamp? (se no passado, vira lancamento_retroativo)",
  "itens": [
    { "produto_id": "uuid", "qty": 50, "custo_unitario": 10.5 }
  ]
}
```

> `localizacao_id` por item foi removido — sempre vai pra loc tipo='recebimento'. Body antigo é aceito (campo ignorado).

**Side effects:** 1 mov `compra_manual` (ou `origem_tipo` informado) tipo `E` por item, na loc RECEBIMENTO. Se `custo_unitario` informado, recalcula `custo_medio` na quádrupla. 1 linha em `siso_wms_pendencias_guarda` por item com `qty_inicial=qty`, `status='pendente'`, FK ao `mov_entrada_id`.

**Response 200:** `{ ok: true, pendencia_ids: ["uuid", ...], localizacao_recebimento_id: "uuid" }`. Use `pendencia_ids` pra disparar `/api/wms/guarda/imprimir-lote` (impressão do maço pré-guarda).

### GET /api/wms/receber

Sugere localização de putaway. Heurística: SKU já com saldo no galpão → essa localização (prefere picking); senão tipo='recebimento'; fallback DEFAULT-PICKING. No fluxo 2 etapas a sugestão é só informativa no recebimento; a decisão final é feita em `/wms/guarda`.

**Query params:** `produto_id`, `empresa_id`, `galpao_id` (todos obrigatórios).

**Response 200:** `{ localizacao_id, codigo?, razao, locaisExistentes }`.

---

### Guarda (put-away — etapa 2/2)

Fila consumida no tablet. Operador imprime etiquetas → cola nas peças → leva pra loc destino → bipa o QR → confirma. Mov de guarda usa `origem_tipo='transferencia_localizacao'` (replenishment_intra) saindo de RECEBIMENTO. Custo médio da loc origem é propagado pra loc destino via `recalcularCustoMedio`.

#### GET /api/wms/guarda

Lista pendências. **Query:** `galpao_id?`, `empresa_dona_id?`, `status=pendente,em_guarda` (CSV, default ativas), `q?`, `limit=200`.

**Response 200:** `{ rows: PendenciaJoined[] }` com produto/empresa/galpao/localizacao_origem populados.

#### GET /api/wms/guarda/[id]

Detalhe de uma pendência + sugestão de loc destino (filtrada — não sugere voltar pra RECEBIMENTO) + lista de locs onde o SKU já tem saldo (atalhos de UI).

**Response 200:** `{ pendencia, sugestao: { localizacao_id, codigo?, razao } | null, locais_existentes: [...] }`.

#### POST /api/wms/guarda/[id]/iniciar

Idempotente. Marca `status='em_guarda'`, registra `iniciada_em/por`. Disparado automaticamente quando a tela tablet abre (não é necessário chamar manualmente).

**Auth:** acesso de armazém. **Response 200:** `{ ok: true, pendencia }`. **400** se status terminal.

#### POST /api/wms/guarda/[id]/confirmar

Confirma a guarda (parcial ou total). Faz mov par S+E (RECEBIMENTO → loc destino) via `replenishmentIntraGalpao`. Se `qty == qty_pendente` zera, vira `guardada` e fixa `guardada_em`. Senão fica `pendente` com saldo, próxima iteração zera.

**Body:** `{ qty: number>0, localizacao_destino_id: "uuid" }`.

**Validação:** `qty <= qty_pendente`; loc destino existe + ativa + mesmo galpão + ≠ loc origem.

**Response 200:** `{ ok: true, pendencia, origem_id, totalmente_guardada: boolean }`. **400** em validação falha; **500** em erro de DB.

#### POST /api/wms/guarda/[id]/cancelar

Tira a pendência da fila sem mover estoque (peça continua em RECEBIMENTO; saída física é fluxo separado — ajuste manual ou devolução fornecedor).

**Body:** `{ motivo: string (≥3 chars) }`.

**Response 200:** `{ ok: true, pendencia }`.

#### POST /api/wms/guarda/[id]/imprimir

Imprime N etiquetas (1 por unidade) pra essa pendência. Não muda status — reimprimir é seguro.

**Body:** `{ qty?: number, localizacao_codigo?: string }`. `qty` default = `qty_pendente` (clampado). `localizacao_codigo` default = melhor candidato de destino (loc com saldo>0 do mesmo SKU exceto RECEBIMENTO) ou `—`.

**Response 200:** `{ ok: true, jobId, totalEtiquetas, totalFolhas, printerId, printerNome, fallbackEnvelope }`. **502** se PrintNode falha.

#### POST /api/wms/guarda/imprimir-lote

Imprime o maço inteiro pra uma lista de pendências (bulk). Usado pelo frontend de recebimento ao confirmar lote.

**Body:** `{ pendencia_ids: string[] }`. Todas precisam ser do mesmo galpão; canceladas/zeradas são puladas (volta em `ignorados[]`).

**Response 200:** `{ ok: true, ignorados, jobId, totalEtiquetas, totalFolhas, fallbackEnvelope, ... }`.

### POST /api/wms/transferir-galpao

Transferência inter-galpão. Galpões devem ser diferentes (caso contrário use `replenishment`).

**Request body:**
```json
{
  "empresa_id": "uuid",
  "galpao_origem_id": "uuid",
  "localizacao_origem_id": "uuid",
  "galpao_destino_id": "uuid",
  "localizacao_destino_id": "uuid",
  "itens": [{ "produto_id": "uuid", "qty": 10 }],
  "observacoes": "string?"
}
```

**Side effects:** Por item, 2 movs (S na origem + E no destino) com mesmo `origem_id` (uuid), `origem_tipo='transferencia_galpao'`.

**Response 200:** `{ origem_id }`.

**Erros:** 400 se origem == destino.

### POST /api/wms/replenishment

Movimenta entre localizações **dentro do mesmo galpão+empresa**.

**Request body:** mesma estrutura mas com `galpao_id` único e `localizacao_origem_id`/`localizacao_destino_id`.

**Side effects:** 2 movs (S+E) com `origem_tipo='transferencia_localizacao'` e mesmo `origem_id`.

**Erros:** 400 se origem_loc == destino_loc.

### POST /api/wms/ajuste

Ajuste manual de estoque (avaria, perda, encontro, erro de contagem).

**Request body:**
```json
{
  "quadrupla": { "produto_id", "empresa_dona_id", "galpao_id", "localizacao_id" },
  "qty": 5,
  "direcao": "entrada | saida",
  "motivo": "avaria caixa amassada"
}
```

**Validação:** `motivo.trim().length >= 3`. Mov gravada com `origem_tipo='ajuste_manual'`, motivo em `origem_detalhes` + `observacoes`.

### POST /api/wms/lancamento-retroativo

Entrada emergencial sem NF formal (chega depois). Vai pra fila de pendências de reconciliação.

**Request body:**
```json
{
  "quadrupla": { ... },
  "qty": 10,
  "fornecedor_id": "uuid?",
  "pedido_id": "uuid?",
  "motivo": "compra urgente sem nota"
}
```

**Validação:** `motivo.length >= 3`. `origem_tipo='lancamento_retroativo'`. `pedido_id` (se passado) vai pra `origem_id`.

### GET /api/wms/lancamento-retroativo

Lista retroativos pendentes (sem mov de estorno apontando pra eles via `estorno_de`).

**Response 200:** `{ rows: [{ id, criado_em, quantidade, observacoes, produto, empresa, galpao, localizacao }] }`.

### POST /api/wms/lancamento-retroativo/[id]/reconciliar

Reconcilia retroativo com mov real (NF formal que chegou depois). Insere mov de estorno (S) apontando pro retroativo via `estorno_de`.

**Request body:** `{ "compra_mov_id": "uuid" }` (anotada em `observacoes`).

**Side effects:** 1 mov `origem_tipo='estorno'`, `tipo='S'`, `qty=retro.quantidade`, `estorno_de=retro.id`.

**Response 200:** `{ ok: true }`. **Erros:** 400 se mov não é retroativo.

---

## WMS — Roteamento (Plano 3)

Motor de decisão própria/empréstimo/OC. Algoritmo puro testável (`rotearPedido`) + wrapper de produção (`rotearPedidoDoBanco`) que filtra locks de localização e aplica limites por par credora↔devedora antes de consultar saldo.

### GET /api/wms/fornecedores
Lista fornecedores ativos. **Response:** `{ rows: Fornecedor[] }`.

### POST /api/wms/fornecedores
Cria fornecedor. **Body:** `{ nome, cnpj?, prefixo_sku?, observacoes?, lead_time_dias_min?, lead_time_dias_medio?, lead_time_dias_max? }`. **400** se sem nome. Lead time é validado: `min ≤ medio ≤ max`, todos opcionais e independentes (qualquer um pode ficar null). Quando setado, vira default para novos vínculos `siso_produto_fornecedores`.

### PATCH /api/wms/fornecedores/[id]
Atualiza campos. **Body:** `{ nome?, cnpj?, prefixo_sku?, ativo?, lead_time_dias_min?, lead_time_dias_medio?, lead_time_dias_max? }`. Lead time pode receber `null` pra limpar. Ordenação `min ≤ medio ≤ max` validada considerando valores atuais quando só parte é informada.

### DELETE /api/wms/fornecedores/[id]
Soft delete (ativo=false).

### POST /api/wms/fornecedores/auto-cadastro
**Admin only.** Insere os 11 fornecedores canônicos do mapeamento sku-fornecedor.ts. Idempotente (skip se nome já existe). **Response:** `{ criados, existentes }`.

### GET /api/wms/produto-fornecedores?produto_id=
Lista vínculos produto↔fornecedor (preferencial primeiro).

### POST /api/wms/produto-fornecedores
Cria vínculo. **Body:** `{ produto_id, fornecedor_id, lead_time_dias_*?, custo_unitario?, qty_minima_pedido?, multiplo_compra?, preferencial? }`. Se `preferencial=true`, despreferencia outros do mesmo produto automaticamente.

### PATCH/DELETE /api/wms/produto-fornecedores/[id]
Atualiza/desativa.

### GET /api/wms/emprestimo-regras
Lista regras ativas da matriz N×N.

### POST /api/wms/emprestimo-regras
Cria regra. **Body:** `{ empresa_credora_id, empresa_devedora_id, limite_max_por_produto?, observacoes? }`. **400** se credora == devedora.

### PATCH/DELETE /api/wms/emprestimo-regras/[id]
Atualiza/desativa.

### GET /api/wms/emprestimo-regras/[id]/limites
**Response:** `{ limites: Record<produto_id, qty> }`.

### PATCH /api/wms/emprestimo-regras/[id]/limites
Adiciona/altera/remove uma entrada do jsonb. **Body:** `{ produto_id, qty }` (qty=null remove).

### GET /api/wms/emprestimos/saldos
Saldo devedor líquido por par credora↔devedora por produto (RPC `wms_saldos_devedores`).

### POST /api/wms/rotear
Testa o algoritmo (debug + integração futura).

**Body:** `{ empresa_vendedora_id, itens: [{ produto_id, qty }] }`.

**Response 200:** `RotaResult`:
- `{ decisao: 'propria' | 'emprestimo', galpao_id, rotas: [{ produto_id, qty, empresa_dona_id, galpao_id, localizacao_id, tipo }] }`
- ou `{ decisao: 'oc', motivo: 'sem_cobertura' | 'split_galpoes' }`

### GET /api/wms/reservas/cleanup
Cron-friendly. **Auth:** `x-worker-secret`. Insere mov L pra reservas com `expira_em < now()` que ainda não foram liberadas. Marca `siso_pedidos.status_alerta='reserva_expirada'`.

**Response 200:** `{ total, liberadas, erros }`.

---

## WMS — Inventário (Plano 4)

### GET /api/wms/inventario
Lista sessões. Query: `status`, `galpao_id`.

### POST /api/wms/inventario
Cria sessão (v2 — pool compartilhado com slots dinâmicos OP1..OP5).

**Body:** `{ tipo: 'cycle_count'|'completo', galpao_id, nome?, empresa_dona_id?, modo_contagem?: 'blind'|'aberto', tolerancia_pct?, tolerancia_qty_min?, exige_aprovacao_acima_valor?, observacoes?, localizacoes: [{ localizacao_id, motivo?, slot_atribuido? }] }`.

Defaults: blind, 2%, R$1000.

**`slot_atribuido` (1..5 ou NULL):** distribuição soft entre operadores no cycle count manual. Quando setado, o RPC `wms_inventario_proxima_loc` prioriza essa loc pro operador que está no slot correspondente; quando o bucket próprio esvazia, o operador cai naturalmente nas regras de continuidade/anti-colisão e pode puxar de buckets de colegas. Sessões sem `slot_atribuido` (NULL em todas as locs) usam pull queue puro (comportamento v2 original).

### GET /api/wms/inventario/[id]
Detalhe consolidado: `{ sessao, operadores, localizacoes, contagens, divergencias }` (5 queries paralelas). `localizacoes[].slot_atribuido` retorna o bucket de cada loc (NULL = pool comum).

### PATCH /api/wms/inventario/[id]
Update genérico de campos da sessão.

### DELETE /api/wms/inventario/[id]
Cancela (status=cancelada) e libera todos os locks da sessão.

### POST /api/wms/inventario/[id]/iniciar
Cria locks em `siso_localizacao_locks` (motivo='cycle_count') e muda status pra `em_andamento`. **400** se sessão não está em 'planejada'.

### POST /api/wms/inventario/[id]/aprovar
Computa divergências + aprova sessão. **400** se há divergências `pendente`.

**Body (opcional):** `{ parcial?: boolean }`.
- `parcial=false` (default): comportamento histórico — todas as locs do pool são consideradas. Locs com saldo>0 que ninguém bipou viram divergência qty=0.
- `parcial=true`: só processa locs com status `contada`/`aprovada`. Locs `pendente`/`em_contagem` são puladas (não geram divergência; estoque do sistema mantido). Use quando o supervisor quer encerrar antes de terminar todo o pool e descartar o que não foi contado.

**Response:** `{ ok: true, parcial: boolean }`.

### POST /api/wms/inventario/[id]/aplicar
Gera movs `origem_tipo='inventario'` no ledger pra cada divergência aprovada (E ou S conforme delta). Marca divergências como `aplicada` e libera locks. **Response:** `{ movsGeradas }`.

### POST /api/wms/inventario/[id]/contagens
Registra contagem. Body: `{ localizacao_id, produto_id, empresa_dona_id, qty_contada, modo? }`.
- `modo='incremental'` (default): soma na contagem do operador (cada bipe = +qty).
- `modo='absoluto'`: substitui contagem prévia.
Mesma quádrupla por outro operador gera nova rodada (suporta duplo blind).

### POST /api/wms/inventario/[id]/localizacoes/[locId]/bloquear
Pega localização atomicamente (RPC). **409** se já bloqueada por outro operador.

### DELETE /api/wms/inventario/[id]/localizacoes/[locId]/bloquear
Libera lock. Status='contada'.

### GET /api/wms/inventario/[id]/divergencias
Lista divergências da sessão. Query: `status`.

### PATCH /api/wms/inventario/[id]/divergencias
Body: `{ divergencia_id, acao: 'aprovar'|'rejeitar'|'recontar', observacoes? }`. 'recontar' devolve a localização pra fila com status='recontagem'.

### GET /api/wms/inventario/metricas
RPCs: acuracidade por operador (30d) + por localização (5000 últimas).

### GET /api/wms/inventario/cleanup
Cron-friendly. Auth: `x-worker-secret`. Detecta sessões inativas há 4h+ (alerta) e libera locks com 30min+ sem contagem nova (mov de status='pendente').

---

## WMS — Exceções e dashboards (Plano 5)

### GET /api/wms/devolucoes
Lista devoluções aguardando classificação física. **Response:** `{ rows: [...] }`.

### POST /api/wms/devolucoes/[id]/classificar
**Body:** `{ classificacao: 'integro'|'avariado'|'garantia'|'troca_sku', produto_id, qty, galpao_id, localizacao_id, empresa_dona_destino_id?, observacoes? }`.

**Side effects por modo:**
- `integro`: E `nf_devolucao_cliente` + recalcula custo médio (média ponderada)
- `avariado`: E `nf_devolucao_avariada` + transferência interna pra QUARENTENA
- `garantia`: E `nf_devolucao_cliente` + S `nf_devolucao_fornecedor` (RMA)
- `troca_sku`: E `nf_devolucao_cliente` (a troca real é feita no SISO por enquanto)

### GET /api/wms/cobertura
Lista linhas da matview de cobertura. **Query:** `status` (critico|atencao|ok|sem_giro|lead_time_risco), `galpao_id`. Limit 500, ordenado por dias_cobertura asc.

### GET /api/wms/cobertura/refresh
Cron-friendly diário 03h. **Auth:** `x-worker-secret`. Chama RPC `wms_refresh_cobertura()`.

### GET /api/wms/dashboard-geral
Agrega contadores cross-módulo numa resposta única (refetch 30s no client).

**Response:**
```json
{
  "cobertura": { "critico": 5, "atencao": 12, "ok": 200, "sem_giro": 8, "lead_time_risco": 3 },
  "inventario": { "sessoesAtivas": 1, "divergenciasPend": 0, "locksAntigos": 0 },
  "reservas": { "expiraEm6h": 2 },
  "retroativosOrfaos": 0,
  "emprestimos": { "paresComSaldo": 1 }
}
```

---

## Common Patterns

### Error Responses

All 4xx/5xx responses follow this pattern:

```json
{
  "error": "string (human-readable message)"
}
```

Or for validation errors:

```json
{
  "error": "string",
  "field_name": "additional context"
}
```

### Pagination

Most list endpoints return up to 200 rows by default. Larger datasets are paginated:
- `/api/painel` uses PAGE=1000 pagination internally
- Some endpoints use `.limit(N)` to cap results

### Auth

- Most endpoints require `X-Session-Id` header (except webhooks, oauth callbacks)
- Session is validated via `getSessionUser()` in `src/lib/session.ts`
- If session invalid: return `{ error: "sessao_invalida" }` with status 401

### Timestamps

- All ISO 8601 format (e.g., `2026-03-25T14:30:00Z`)
- BRT timezone used in `/api/painel` calculations
- Server time always included in painel response

### Rate Limiting

- Tiny API: per-empresa via `rate-limiter.ts`
- Barcode scanning: 2 bips/second per session via `checkBipRateLimit()`
- Worker: 5 jobs per request by default (configurable)

---

## Database Tables Referenced

- `siso_pedidos` - Orders
- `siso_pedido_itens` - Order items
- `siso_pedido_item_estoques` - Normalized stock per empresa
- `siso_pedido_historico` - Audit trail
- `siso_pedido_observacoes` - Order comments
- `siso_fila_execucao` - Execution queue
- `siso_webhook_logs` - Webhook dedup log
- `siso_galpoes` - Warehouse locations
- `siso_empresas` - ERP accounts
- `siso_grupos` - Business affinity groups
- `siso_grupo_empresas` - Empresa-grupo relations with tier
- `siso_usuarios` - Users
- `siso_usuario_galpoes` - User-galpão associations
- `siso_sessoes` - Server-side sessions
- `siso_ordens_compra` - Purchase orders
- `siso_tiny_connections` - Tiny OAuth2 connections
- `siso_inventarios` - Inventory sessions
- `siso_inventario_itens` - Inventory scan items
- `siso_transferencias` - Inter-galpão transfers
- `siso_transferencia_itens` - Transfer items
- `siso_logs` - Application logs
- `siso_erros` - Error tracking
- `siso_configuracoes` - Key-value config store
- `siso_produtos_catalogo` - Cross module: cached product catalog (Tiny mirror)
- `siso_produto_oems` - Cross module: OEM codes per product (audit trail)
- `siso_produto_veiculos` - Cross module: vehicle compatibility per product (audit trail)
- `siso_cross_logs` - Cross module: search telemetry

---

**Last updated:** 2026-05-07
**API Version:** v3 (compatible with Tiny ERP API v3, OAuth2)
