# SISO API Reference - Complete

This is the **authoritative, comprehensive reference** for every API route in the system. Use this before reading route source code or making API changes.

**Last updated:** 2026-05-18

> ⚠️ **Cutover de superfície (2026-05-18, commit `f8b7dbb`):** todas as APIs foram movidas pra `/api/wms/*`. As únicas exceções são `/api/auth/login` e `/api/auth/me`. Endpoints **removidos** nessa data: `/api/inventario/*` (versão Tiny-based), `/api/transferencia/*`, `/api/etiquetas-endereco/*`, `/api/painel`, `/api/monitoring`, `/api/dashboard/*`, `/api/reconciliacao` (SISO; `/api/wms/reconciliacao` permanece). O webhook do Tiny ERP precisa apontar pra `https://.../api/wms/webhook/tiny` (URL nova).

---

## Table of Contents

1. [Webhook API](#webhook-api)
2. [Authentication API](#authentication-api)
3. [Pedidos API](#pedidos-api)
4. [Separação API](#separação-api)
5. [Compras API](#compras-api)
5b. [Compras Manuais API](#compras-manuais-api)
6. [Admin API](#admin-api)
7. [Tiny ERP API](#tiny-erp-api)
8. [Worker & Background Jobs](#worker--background-jobs)
9. [Cross — Busca de produtos e equivalência](#cross--busca-de-produtos-e-equivalência)
10. [WMS — Core (estoque, ledger, localizações, movimentações)](#wms--core)
11. [WMS — Inventário v2 (pull queue + claim hierárquico)](#wms--inventário-v2)
12. [WMS — Exceções, dashboards, insights](#wms--exceções-dashboards-insights)

**Total API Routes Documented:** 100+ endpoints across all sections

---

## Webhook API

### POST /api/wms/webhook/tiny

**File:** `src/app/api/wms/webhook/tiny/route.ts`

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

### POST /api/wms/webhook/reprocessar

**File:** `src/app/api/wms/webhook/reprocessar/route.ts`

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

### GET /api/wms/pedidos

**File:** `src/app/api/wms/pedidos/route.ts`

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
        "imagemUrl": "string | null",
        "imagens": "string[] (fotos do produto via siso_produtos.imagens por SKU; [] se nenhuma)"
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
- Aggregates LIVE stock from `siso_estoque` (3D WMS cache) by (sku, galpão) via `aggregateLiveStockBySku` — reflects every movement (recebimento, ajuste, transferência, separação) without re-running the webhook
- For pedidos `status ∈ {pendente, erro}`, recomputes `sugestao`/`sugestaoMotivo` dynamically via `recomputarSugestaoBatch` (reuses `rotearPedido` from the WMS routing module). `siso_pedidos.sugestao` continues to hold the webhook snapshot for audit, but the response returns the live value.
- Filters by status if provided

**Side Effects:** None (read-only)

**Rate Limiting:** None

**Notes:**
- Stock is live from `siso_estoque` (3D pool), not the frozen `siso_pedido_item_estoques` snapshot
- `sugestao` reflects current stock coverage — if balance arrives after the webhook, the suggestion automatically flips from `oc` to `propria`/`transferencia` on the next GET
- Cost of recompute is bounded: 5 fixed queries regardless of pedido count
- Supports any number of galpões (not hardcoded CWB/SP)

---

### POST /api/wms/pedidos/aprovar

**File:** `src/app/api/wms/pedidos/aprovar/route.ts`

**Purpose:** Operator approves a pending order with a decision. Moves order to "executando" state and enqueues stock posting.

**Auth:** X-Session-Id header (optional role check could be added)

**Request Body:**
```json
{
  "pedidoId": "string",
  "decisao": "propria" | "transferencia" | "oc" | "rejeitado",
  "operadorId": "string | null",
  "operadorNome": "string | null",
  "motivo": "string (optional, used when decisao='rejeitado')"
}
```

**Response (200 - Success, decisao ∈ {propria,transferencia,oc}):**
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

**Response (200 - Success, decisao='rejeitado'):**
```json
{
  "ok": true,
  "pedidoId": "string",
  "decisao": "rejeitado"
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

**Response (422 - OC bloqueado, Fase 1):**
```json
{
  "error": "oc_bloqueado_snapshot_cobre",
  "message": "Saldo vivo cobre os itens — aprove como Própria ou Transferência"
}
```
> **Fase 1:** quando `decisao='oc'` mas o saldo **vivo** de `siso_estoque` (somado em todos os galpões, resolvido por `tiny_produto_id`→WMS) cobre 100% dos itens, o endpoint recusa a OC e força Própria/Transferência. Lê estoque vivo (não snapshot) — era a raiz do loop de OC.

**Response (409 - Reserva sem cobertura, Fase 1):**
```json
{
  "error": "reserva_falhou",
  "motivo": "sem_saldo | mapeamento_ausente | saldo_insuficiente | erro_runtime",
  "item": { "sku": "...", "produto_id_tiny": 0, "qty": 0 },
  "rollback": { "tentativas": 0, "sucesso": 0, "falhou": 0, "orfas_ids": [] }
}
```
> **Fase 1:** `propria`/`transferencia` criam as reservas R atomicamente ANTES de transitar status (tudo-ou-nada). Se algum item não tem cobertura no runtime, estorna as N-1 já criadas e devolve 409 sem mexer no pedido.

**Business Logic:**
- **decisao = "rejeitado" short-circuit (botão Recusar):**
  - Atualiza pedido: `decisao_final='rejeitado'`, `status='cancelado'`, `status_separacao=null`
  - Registra evento `cancelado` em `siso_pedido_historico` com `motivo` do body
  - Não enfileira execução, não cria reservas, não chama worker
  - Retorna `{ ok: true, decisao: "rejeitado" }`
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
- **Fase 1 — OC-block:** se `decisao='oc'` e o saldo vivo cobre 100% dos itens → 422 `oc_bloqueado_snapshot_cobre` (força Própria/Transferência).
- **Fase 1 — reservas:** se `decisao ∈ {propria, transferencia}`, cria 1 R por item via `criarReservasPedido` (loc = maior saldo no galpão de separação) **antes** de transitar status; tudo-ou-nada → 409 `reserva_falhou` se algum item sem cobertura no runtime. `oc` **não** reserva (compra/baixa acontece depois). _(Feature "parcial na entrada" — reservar a parte coberta no caminho OC — está especificada mas ainda não implementada; ver relatório da Fase 3.)_
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

### GET /api/wms/pedidos/[id]/historico

**File:** `src/app/api/wms/pedidos/[id]/historico/route.ts`

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

### GET /api/wms/pedidos/[id]/observacoes

**File:** `src/app/api/wms/pedidos/[id]/observacoes/route.ts`

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

### POST /api/wms/pedidos/[id]/observacoes

**File:** `src/app/api/wms/pedidos/[id]/observacoes/route.ts`

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

### POST /api/wms/pedidos/[id]/estornar

**File:** `src/app/api/wms/pedidos/[id]/estornar/route.ts` (Fix-Final A T22 — 2026-05-27)

**Purpose:** Banner D10 admin: estorna TODAS as movs (S+R) do pedido e marca pedido como cancelado. Cria par de estorno simétrico no ledger (chain estorno_de). Imutabilidade preservada — nada é deletado.

**Auth:** X-Session-Id (required) + `userCan(session, "pedidos.estornar")` (apenas admin via PERMISSAO_CODIGOS spread)

**Request Body:**
```json
{ "motivo": "string (≥3, ≤500 chars)" }
```

**Response (200):**
```json
{ "ok": true, "movs_estornadas": 5 }
```

**Response (401):** `{ "error": "unauthorized" }`
**Response (403):** `{ "error": "forbidden" }`
**Response (400):** `{ "error": "motivo (string ≥3 e ≤500 chars) obrigatório" }`
**Response (404):** `{ "error": "pedido não encontrado" }`
**Response (500):** `{ "error": "estorno_parcial_falhou", "estornadas": N }` (idempotente em re-run)

**Business Logic:**
- Lista movs do pedido com `tipo IN ('S','R')` e `estorno_de IS NULL`
- Pra cada S: chama `estornarMovimentacao()` (cria par E com `estorno_de=S.id`)
- Pra cada R: chama `estornarReservaIndividual({motivo:'outro'})` (cria L com `estorno_de=R.id`)
- UPDATE `siso_pedidos.status_separacao='cancelado'`
- Registra evento `estorno_manual_admin` em `siso_pedido_historico`

**Side Effects:**
- INSERTs em `siso_movimentacoes` (1 par por mov original)
- UPDATE em `siso_pedidos` + `siso_estoque` (via RPC)
- INSERT em `siso_pedido_historico`

---

### POST /api/wms/pedidos/[id]/liberar-reservas

**File:** `src/app/api/wms/pedidos/[id]/liberar-reservas/route.ts` (Fix-Final A T25 — 2026-05-27)

**Purpose:** D2 override admin: libera TODAS as reservas R do pedido (sem cancelar o pedido nem tocar em movs S). Desbloqueia estoque preso em estado fantasma.

**Auth:** X-Session-Id (required) + `userCan(session, "pedidos.liberar_reservas")` (apenas admin)

**Request Body:**
```json
{ "motivo": "string (≥3, ≤500 chars)" }
```

**Response (200):**
```json
{ "ok": true, "rs_liberadas": 3 }
```

**Response (401/403/400):** mesma estrutura do `/estornar`

**Business Logic:**
- Lista movs com `tipo='R'`, `origem_tipo='reserva_pedido'`, `estorno_de IS NULL`, `origem_id=pedido_id`
- Pra cada R: chama `estornarReservaIndividual({motivo:'liberar_reservas_admin'})`
- Best-effort: erro em 1 R não interrompe as demais (loga + continua)
- Registra evento `liberar_reservas_admin` em `siso_pedido_historico`
- NÃO toca em movs S, NÃO muda status do pedido

**Side Effects:**
- INSERT L (par) em `siso_movimentacoes` pra cada R liberada
- UPDATE `siso_estoque.reservado` (via RPC)
- INSERT em `siso_pedido_historico`

---

### GET /api/wms/pedidos/tracking

**File:** `src/app/api/wms/pedidos/tracking/route.ts`

**Purpose:** Paginated list of pedidos for the universal tracking page. Returns pedido summary data with combined status, empresa/galpao names, search, and advanced filters.

**Auth:** X-Session-Id (required)

**Query Params:**
- `page`: page number (default 1) — **LEGACY** — use `cursor` for new clients
- `cursor`: ISO timestamp do `criado_em` do último item da página anterior; quando presente ativa modo cursor-based (mais eficiente, pula `count()` da tabela)
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
  "total": "number (0 quando cursor mode)",
  "page": "number",
  "totalPages": "number (0 quando cursor mode)",
  "next_cursor": "ISO datetime | null"
}
```

**Pagination contract:**
- Modo cursor (recomendado): cliente passa `?cursor=<criado_em ISO>&limit=<N>`. Resposta inclui `next_cursor` se uma página cheia foi retornada (mais itens podem existir) ou `null` quando exausto. `total`/`totalPages` saem como 0 — count é skipado pra evitar O(N) na tabela.
- Modo page (legado): cliente passa `?page=<N>&limit=<N>`. Resposta inclui `total`/`totalPages` calculados. `next_cursor` também é emitido pra clientes que queiram migrar gradualmente.
- Ordering: sempre `criado_em DESC, id DESC` (tiebreaker estável quando dois pedidos têm o mesmo timestamp).

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

### GET /api/wms/pedidos/[id]/detalhe

**File:** `src/app/api/wms/pedidos/[id]/detalhe/route.ts`

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
  "sugestao": "propria | transferencia | oc",
  "sugestao_motivo": "string | null",
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
      "imagens": "string[] (fotos do produto via siso_produtos.imagens por SKU; [] se nenhuma)",
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
- Fetches itens, historico, observacoes in parallel via Promise.all
- Stock aggregated LIVE from `siso_estoque` (3D pool) by (sku, galpão) via `aggregateLiveStockBySku`
- Items include per-galpao stock with `atende` boolean (disponivel >= quantidade)
- For pedidos `status ∈ {pendente, erro}`, `sugestao`/`sugestao_motivo` is recomputed dynamically via `recomputarSugestaoBatch` against live stock — `siso_pedidos.sugestao` continues to hold the webhook snapshot for audit
- Historico ordered ascending (oldest first), observacoes ordered ascending

**Side Effects:** None (read-only)

**Rate Limiting:** None

---

## Vendas Diretas API

Pedidos de venda direta — abrange pedidos manuais inseridos por vendedores E pedidos vindos de marketplaces rastreados (Mercado Livre, Shopee). Cargo `vendedor` tem visibilidade limitada a essa aba.

### POST /api/wms/vendas/criar

**File:** `src/app/api/wms/vendas/criar/route.ts`

**Purpose:** Cria pedido manual de venda. Vendedor escolhe **1 galpão** pro pedido inteiro — localização é resolvida server-side via `resolverDisponibilidadeVenda` (`src/lib/wms/vendas-disponibilidade.ts`). *(3D — refactor 2026-05-20: não resolve mais empresa dona, só loc.)*

Dois modos solicitados:
- `separacao`: entra no fluxo de wave picking (pula NF), `status='executando', status_separacao='aguardando_separacao'`.
- `baixa_direta`: gera mov `'S'` no ledger WMS via `wms_inserir_movimentacao(origem_tipo='venda_manual', empresa_vendedora_id=...)` pra cada item na tripla resolvida automaticamente, baixando estoque imediatamente. `status='concluido', status_separacao=NULL`. A empresa vendedora (`empresa_origem_id`) viaja como tag na mov.

**Degradação automática**: se `modo='baixa_direta'` mas qualquer item não tem saldo suficiente no galpão escolhido, todo o pedido cai pra `modo='separacao'` (igual marketplace sem estoque). Resposta inclui `degradado:true`.

**Auth:** X-Session-Id (qualquer cargo autenticado pode criar; vendedor é auto-preenchido com user.id).

**Request:**
```json
{
  "cliente_nome": "string (req)",
  "cliente_cpf_cnpj": "string|null",
  "canal_venda": "Balcão|WhatsApp|Telefone|...",
  "empresa_origem_id": "uuid (req)",
  "galpao_id": "uuid (req) — galpão único pro pedido",
  "modo": "separacao | baixa_direta",
  "items": [
    {
      "produto_id": "uuid (siso_produtos.id)",
      "quantidade": 1
    }
  ],
  "idempotency_key": "uuid (opcional — evita duplicação em retry)"
}
```

**P3 #7.7 — idempotency_key filtra cancelados.** Antes, se o caller passasse a mesma
`idempotency_key` em retry após cancelar a venda anterior, o sistema devolvia o pedido cancelado
(reaproveitando o registro). Agora o SELECT filtra `status NOT IN ('cancelado')`. Cancelados
não bloqueiam re-criação com mesma key — comportamento esperado (re-tentar venda manual após cancelar).

**Response (200):**
```json
{
  "pedido_id": "MAN-{uuid8}-{ts36}",
  "numero": "string",
  "status": "executando | concluido",
  "status_separacao": "aguardando_separacao | null",
  "movs_criadas": "number (qtd de movs criadas — só em baixa_direta efetiva)",
  "degradado": "boolean (opcional, true se baixa_direta caiu pra separação)",
  "motivo_degradacao": "falta_saldo (opcional)",
  "skus_sem_saldo": ["SKU1", "SKU2"]
}
```

**Errors:**
- 400 — validação (cliente vazio, qty inválida, galpao_id ausente, produto não cadastrado em `siso_produto_empresas`)
- 409 — saldo insuficiente mid-flight em baixa_direta (race condition: tinha saldo no GET disponibilidade, mas baixou entre o resolve e o insert da mov; após rollback das movs anteriores)
- 500 — falha de DB / RPC / tripla não resolvida

**Side Effects:**
- Insert em `siso_pedidos` (origem_pedido='manual')
- Bulk insert em `siso_pedido_itens`
- Em baixa_direta: 1 mov `'S'` por item (origem_tipo='venda_manual', origem_id=pedido_id, `empresa_vendedora_id`=empresa_origem_id, `cliente_nome` populado da request)
- Em caso de falha de mov: estorna movs anteriores via `estornarMovimentacao` + deleta pedido/items
- Audit: `registrarEvento('venda_criada_manual')` + (se baixa_direta) `venda_baixa_direta_executada`

---

### GET /api/wms/vendas/disponibilidade

**File:** `src/app/api/wms/vendas/disponibilidade/route.ts`

**Purpose:** Resolve a melhor localização com saldo disponível pra um produto num galpão (3D — refactor 2026-05-20). Usado pela tela `/wms/vendas/nova` pra exibir read-only ao vendedor a localização sugerida + qty disponível por item.

Ordem de preferência (sem mais empresa dona como critério):
1. Loc tipo `picking` antes de outros tipos.
2. Maior `disponivel` desempata.

Locs tipo `recebimento` são ignoradas (estoque em staging não pode ser vendido).

**Auth:** X-Session-Id (qualquer cargo autenticado).

**Query Params:**
- `produto_id` — uuid em `siso_produtos.id` (req)
- `galpao_id` — uuid em `siso_galpoes.id` (req)

> Param `empresa_origem_id` removido em 2026-05-20 — não há mais "preferir empresa origem" porque o estoque é fungível por galpão. A empresa vendedora viaja como tag na mov.

**Response (200):**
```json
{
  "total_disponivel": 5,
  "sugestao": {
    "localizacao_id": "uuid",
    "localizacao_codigo": "A-01-2",
    "localizacao_tipo": "picking",
    "disponivel": 3
  }
}
```

Se nenhuma loc tem saldo: `{ total_disponivel: 0, sugestao: null }`.

**Errors:**
- 400 — `produto_id` ou `galpao_id` ausentes
- 500 — falha de DB

**Side Effects:** nenhum (GET puro, sem side effects).

---

### GET /api/wms/vendas

**File:** `src/app/api/wms/vendas/route.ts`

**Purpose:** Lista pedidos de venda direta (manuais + ML/Shopee). Auto-filtro "Meus pedidos" pra cargo vendedor.

**Auth:** X-Session-Id

**Query Params:**
- `tab=pendentes|em_separacao|baixados|concluidos` (default: pendentes)
- `vendedor_id` — filtra por vendedor. `__todos__` desliga auto-filtro pra vendedor
- `marketplace` — `manual`, `Mercado Livre`, `Shopee`
- `galpao_id` — filtra por `separacao_galpao_id`
- `data_de`, `data_ate` — ISO dates
- `busca` — número, cliente_nome, id_pedido_ecommerce
- `page` (default 1), `page_size` (default 50, max 200)

**Auto-filter logic:**
- Se `cargos.includes('vendedor')` E `vendedor_id` não foi passado → aplica `vendedor_id=user.id`.
- `vendedor_id=__todos__` desliga o auto-filtro.

**Response (200):**
```json
{
  "pedidos": [ /* siso_pedidos rows com vendedor_*, origem_pedido, canal_venda */ ],
  "total": "number",
  "page": "number",
  "page_size": "number",
  "auto_filtro_meus": "boolean",
  "hide_custo": "boolean"
}
```

---

### GET /api/wms/vendas/[id]

**File:** `src/app/api/wms/vendas/[id]/route.ts`

**Purpose:** Detalhe completo de um pedido de venda (manual ou marketplace). Inclui items + histórico.

**Auth:** X-Session-Id. Vendedor só consegue ler pedidos de venda direta (manual OR ML/Shopee) — outros → 403.

**Response (200):**
```json
{
  "pedido": { /* siso_pedidos com vendedor_*, origem_pedido, canal_venda */ },
  "itens": [ /* siso_pedido_itens */ ],
  "historico": [ /* siso_pedido_historico */ ]
}
```

---

### PATCH /api/wms/vendas/[id]/vendedor

**File:** `src/app/api/wms/vendas/[id]/vendedor/route.ts`

**Purpose:** Atribui (ou desatribui) vendedor a um pedido. Útil pra admin atribuir pedidos ML/Shopee a um vendedor real depois.

**Auth:** X-Session-Id. Permissão: admin OU qualquer cargo operador_* OU o vendedor atual do pedido.

**Request:**
```json
{ "vendedor_id": "uuid | null" }
```

**Response (200):**
```json
{ "ok": true, "vendedor_id": "uuid | null", "vendedor_nome": "string | null" }
```

**Side Effects:**
- Update em `siso_pedidos.vendedor_id` + `vendedor_nome`
- `registrarEvento('venda_vendedor_atribuido')` com anterior/novo

### POST /api/wms/vendas/[id]/cancelar

**P3 #7.13** — Cancela venda manual. **File:** `src/app/api/wms/vendas/[id]/cancelar/route.ts`.

Caminhos suportados:
- `status_separacao ∈ {aguardando_separacao, aguardando_compra}` — libera reservas R via
  `liberarReserva` (idempotente: skip se já houver L apontando).
- `status='concluido'` com movs `origem_tipo='venda_manual'` — estorna cada mov S
  (idempotência por `estorno_de IS NOT NULL` — re-cancelamento retorna 0/0).
- `status_separacao ∈ {em_separacao, separado, embalado}` — retorna **400**: operador
  precisa primeiro voltar etapa pra preservar auditoria dos picks.
- `status='cancelado'` — retorna **200** com `{reservas_liberadas:0, movs_estornadas:0}` (idempotente).

**Auth:** `requireWarehouseAccess`. **Body:** `{ motivo: string (≥3 chars) }`.

**Response 200:** `{ ok: true, reservas_liberadas, movs_estornadas }`. **400** se status incompatível ou motivo curto.

---

## Separação API

### GET /api/wms/separacao

**File:** `src/app/api/wms/separacao/route.ts`

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

### POST /api/wms/separacao/iniciar

**File:** `src/app/api/wms/separacao/iniciar/route.ts`

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
  "error": "todos os pedidos devem estar com status 'aguardando_separacao', 'aguardando_compra', 'validacao_oc' ou 'em_separacao'",
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

**Response (409 - pedido em pendente_realocacao):**
```json
{
  "error": "pedido em pendente_realocacao — resolver realocações antes de iniciar",
  "pedido_ids": ["string"]
}
```

**Business Logic:**
- Validates pedido_ids is non-empty array of strings
- **`pendente_realocacao` é rejeitado com 409 (P6, 2026-05-26).** O status significa "wave bloqueada aguardando ação do supervisor sobre realocações órfãs". Operador precisa resolver realocações (confirmar/cancelar) antes de re-disparar `iniciar`.
- Fetches all pedidos, validates ALL have status_separacao em ["aguardando_separacao", "aguardando_compra", "em_separacao", "validacao_oc"]
- Filters pedidos com status `aguardando_separacao` ou `validacao_oc` (ignores already em_separacao)
- Updates those to "em_separacao" with separacao_operador_id and separacao_iniciada_em
- Calls RPC `siso_consolidar_produtos_separacao` to get consolidated product list (aggregates by SKU/localizacao)
- Returns consolidated products sorted by localizacao
- Fire-and-forget: calls `preCriarAgrupamentosEmLote` to pre-create Tiny agrupamentos and download ZPL labels early

**Side Effects:**
- Updates `siso_pedidos.status_separacao`, `separacao_operador_id`, `separacao_iniciada_em`
- Inserts to `siso_pedido_historico`
- Fire-and-forget: calls `preCriarAgrupamentosEmLote` (creates agrupamentos in Tiny, downloads ZPL)
- *(Removido em 2026-05-20)* O passo de `executarMiniSwap()` antes de `em_separacao` foi descontinuado com o ledger simplificado 3D.
- Logs to `siso_logs`

**Rate Limiting:** None

**Notes:**
- Consolidated products are for wave picking checklist
- Agrupamento pre-creation happens async to cache labels before packing

---

### POST /api/wms/separacao/bipar

**File:** `src/app/api/wms/separacao/bipar/route.ts`

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

### POST /api/wms/separacao/bipar-checklist

**File:** `src/app/api/wms/separacao/bipar-checklist/route.ts`

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

### POST /api/wms/separacao/marcar-item

**File:** `src/app/api/wms/separacao/marcar-item/route.ts`

**Purpose:** Toggle an item's separacao_marcado checkbox during wave-picking. Also generates a WMS ledger movement on mark and estorna it on unmark.

**Auth:** None

**Request Body:**
```json
{
  "pedido_item_id": "string",
  "marcado": "boolean",
  "idempotency_key": "uuid (opcional)"
}
```

**`idempotency_key` (Raio-X Fase 5 P072):** token uuid client-gerado, propagado à `wms_pick_item_atomico` **somente** quando o pick não tem reserva viva (ramo sem-reserva). Com reserva, a R `FOR UPDATE` já serializa e o token é ignorado. Re-envio com a mesma key devolve a mesma saída em vez de gerar baixa duplicada (fecha o duplo-pick sem-reserva sob concorrência).

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
  "error": "Pedido deve estar com status 'em_separacao', 'aguardando_separacao' ou 'pendente_realocacao'",
  "status_atual": "string"
}
```

**Response (400 - Item already partially picked):**
```json
{
  "error": "Item com separacao_parcial=true — use /api/wms/separacao/parcial"
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
- Validates parent pedido has status_separacao = "em_separacao", "aguardando_separacao" **ou `pendente_realocacao`** (fix-pack 2026-05-18 I7 — permite marcar item em pedido travado por realocação sem cobertura)
- Blocks if `separacao_parcial = true` (must use `/api/wms/separacao/parcial` instead)
- Updates separacao_marcado and separacao_marcado_em (null if unmarked)
- **On mark (Fase 1 — fail-loud):** chama a RPC atômica `wms_pick_item_atomico` (L libera a R viva + S `nf_venda`, numa transação). A loc vem da **R viva** do pedido (`buscarReservaPendentePorProduto`), não de heurística. **Se a baixa falhar (saldo insuficiente, R já liberada), retorna 409 e NÃO marca o item** — antes marcava com "graceful failure" (logava warn e seguia), o que deixava item marcado sem saída no ledger (invariante A violado). Item sem R viva (OC já comprado / R liberada) cai no fallback S-only na loc com maior saldo.
- On unmark: estorna a S e **ressuscita a R** (ordem: S antes de L, pra preservar o invariante reservado≤saldo).

**Response (409 — baixa atômica falhou, Fase 1):**
```json
{ "error": "pick_falhou", "detalhe": "<motivo do RPC>" }
```
O item **permanece não-marcado**. O front-end deve avisar o operador (saldo/posição mudou) e reabrir o checklist.
- On unmark **(P3 #2.7)**: agora estorna a leg S **primeiro**, depois a leg L (estorno de
  liberação de reserva). Antes estornava em ordem trocada, o que violava invariante I2
  (saldo_anterior+delta=saldo_posterior) porque a leg L re-bloqueava o saldo que a S ainda
  ocupava. Now S sai do estoque antes da R ser recriada — sequência paritária e invariante-safe.

**Side Effects:**
- Updates `siso_pedido_itens.separacao_marcado`, `separacao_marcado_em`, `mov_saida_id`
- On mark: inserts row in `siso_movimentacoes` (origem_tipo=`nf_venda`). **Shape (fix 2026-05-21, commit `fe1a849`):** `origem_id=NULL` (RPC `wms_inserir_movimentacao` exige uuid; antes vinha string `pedido:<tinyId>` causando 22P02 silencioso). Tiny pedido id agora viaja em `origem_detalhes.pedido_id_tiny` (jsonb) pra rastreabilidade.
- On unmark: inserts estorno row in `siso_movimentacoes` (estorno_de = previous mov_id)
- Logs on error

---

### POST /api/wms/separacao/desfazer-bip

**File:** `src/app/api/wms/separacao/desfazer-bip/route.ts`

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

### POST /api/wms/separacao/concluir

**File:** `src/app/api/wms/separacao/concluir/route.ts`

**Purpose:** Finish separation for selected orders. Only orders where ALL items have separacao_marcado = true are moved to 'separado'.

**Auth:** X-Session-Id (required)

> **Fix-pack 2026-05-18 (C6):** endpoint passou a exigir sessão autenticada. Antes era `auth: none`. Retorna 401 `sessao_invalida` se ausente.

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

**Response (401):**
```json
{
  "error": "sessao_invalida"
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

### POST /api/wms/separacao/concluir-oc

**File:** `src/app/api/wms/separacao/concluir-oc/route.ts`

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

**Response (409 - Pending realocacoes block conclusion):**
```json
{
  "error": "Existem realocacoes pendentes — pique ou cancele antes de concluir",
  "code": "realocacoes_pendentes",
  "pedido_ids_bloqueados": ["string"]
}
```

> **Fix-pack 2026-05-18 (C7):** o endpoint agora bloqueia com 409 se qualquer item dos pedidos selecionados tem realocação em status `aguardando_picking`. Antes, a chamada passava e a chain ficava órfã. Frontend exibe modal pra pickar ou cancelar a realoc antes de tentar de novo.

**Business Logic:**
- Validates pedido_ids is non-empty array of strings
- Fetches all items from `siso_pedido_itens` for the given pedidos
- **Bloqueia 409 `realocacoes_pendentes`** se qualquer item tem realocação em `aguardando_picking` em `siso_pedido_item_realocacoes`. Retorna `pedido_ids_bloqueados` com os IDs problemáticos.
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

### GET /api/wms/separacao/checklist-items?pedidos=id1,id2,id3

**File:** `src/app/api/wms/separacao/checklist-items/route.ts`

**Purpose:** Fetch individual items for the given pedido IDs with localizacao, stock info, and short-pick state. For transfers, resolves to the separating empresa (the one that will ship), not the origin empresa.

**Auth:** X-Session-Id (required)

> **Fix-pack 2026-05-18 (C6):** endpoint passou a exigir sessão autenticada. Retorna 401 `sessao_invalida` se ausente.

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
      "quantidade_pega": "number | null",
      "separacao_parcial": "boolean",
      "parcial_motivo": "string | null",
      "parcial_em": "ISO datetime | null",
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
      "galpao_nome": "string | null",
      "realocacoes": [
        {
          "id": "uuid",
          "empresa_dona_id": "uuid (LEGACY 3D — não populado em inserts novos)",
          "empresa_nome": "string (LEGACY 3D)",
          "localizacao_id": "uuid",
          "localizacao_codigo": "string",
          "quantidade": "number",
          "is_emprestimo": "boolean (LEGACY 3D — sempre false em inserts novos)",
          "empresa_devedora_id": "uuid | null (LEGACY 3D — sempre null em inserts novos)",
          "status": "aguardando_picking",
          "criado_em": "ISO datetime"
        }
      ]
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
- Includes `realocacoes` for items with `separacao_parcial=true` — only rows with `status='aguardando_picking'`

**Side Effects:** None (read-only)

**Rate Limiting:** None

**Notes:**
- For transferência orders, empresa_origem_id refers to the separating empresa, not the origin empresa
- Localizacao comes from the separating empresa's stock snapshot
- `realocacoes` array is empty (not null) when item has no pending re-allocations

---

### POST /api/wms/separacao/cancelar

**File:** `src/app/api/wms/separacao/cancelar/route.ts`

**Purpose:** Cancel an in-progress separation. Resets all item checkmarks, estorna WMS movements (proportional via bridge table), cancels pending re-allocations, and moves pedidos back to 'aguardando_separacao'.

**Auth:** X-Session-Id (required) — usuarioId é usado no evento de histórico `separacao_cancelada`.

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
- Lê todas as linhas relevantes de `siso_pedido_item_mov_links` para os itens dos pedidos (todos os `tipo_link`: `saida` + `ajuste_loc_zerou`)
- **Dedupe via `Set<mov_id>`** — uma mov compartilhada por N itens só é estornada 1× (ou proporcionalmente, conforme a soma de qty dos links). Crítico em wave consolidado onde wave inteira aponta pra mesma mov.
- Para cada mov estornanda chama `wms_estornar_parcial_movimentacao`. Se a RPC raise "ja foi estornada" (mov.qty_estornada == quantidade), **tolera silenciosamente** — outro endpoint pode ter rodado antes.
- Cancels realocações com status `aguardando_picking` em `siso_pedido_item_realocacoes` (incluindo cascade via `parent_realocacao_id`).
- Resets all items: `separacao_marcado=false`, `separacao_marcado_em=null`, `separacao_parcial=false`, `quantidade_pega=null`, `parcial_motivo/em/por=null`, `mov_saida_id=null`, `mov_ajuste_loc_zerou_id=null`
- Resets pedidos: `status_separacao = "aguardando_separacao"`, `separacao_operador_id = null`, `separacao_iniciada_em = null`
- Registers evento `separacao_cancelada` em `siso_pedido_historico` com `usuario_id` da sessão.

**Historico detalhes — movs_estornadas (Fix-Final B B3):** O evento `separacao_cancelada` persiste `detalhes.movs_estornadas` como array **truncado a 50 itens** para evitar rows excessivamente grandes. Campos adicionais: `movs_estornadas_total` (int — total real de movs processadas), `movs_estornadas_truncado` (bool — true quando o total excede 50). Para listar todas as movs estornadas de um cancelamento, consulte `siso_movimentacoes WHERE origem_id = pedido.id AND tipo = 'E'`.

**Side Effects:**
- Updates `siso_pedido_itens` (resets marcado + partial fields)
- Updates `siso_pedidos` (resets status)
- Inserts estorno rows in `siso_movimentacoes` for each unique mov_id (dedupado)
- Atualiza `siso_movimentacoes.qty_estornada` na mov fonte
- Deleta linhas consumidas de `siso_pedido_item_mov_links`
- Updates `siso_pedido_item_realocacoes.status = 'cancelado'`
- Registers audit event `separacao_cancelada` (com usuarioId) in `siso_pedido_historico` — `detalhes.movs_estornadas` truncado a 50 + `movs_estornadas_total` + `movs_estornadas_truncado`
- Logs to `siso_logs`

---

### POST /api/wms/separacao/parcial

**File:** `src/app/api/wms/separacao/parcial/route.ts`

**Purpose:** Marca item ou realocação como parcial. Modo dual: aceita parcial tanto numa loc original do item (modo item) quanto numa loc de realocação ativa (modo realocação). Gera mov S no ledger pela qty pega, opcionalmente gera mov S de ajuste quando a loc zerou, e dispara cascade pra cobrir o residual excluindo todas as locs já tentadas no item.

**Auth:** X-Session-Id (required)

**Request Body — modo item (parcial na loc original):**
```json
{
  "pedido_item_id": 123,
  "quantidade_pega": 2,
  "loc_zerou": true
}
```

**Request Body — modo realocação (parcial em loc de realocação ativa):**
```json
{
  "realocacao_ids": ["uuid", "uuid"],
  "quantidade_pega": 2,
  "loc_zerou": true
}
```

> **Fix-pack 2026-05-18 (I3):** o modo realocação agora aceita `realocacao_ids: string[]` (array, não singular). Necessário pra suportar wave consolidado onde a mesma loc pode atender múltiplas realocações de pedidos diferentes (uma única mov S compartilhada, registrada em N linhas via `siso_pedido_item_mov_links`). O endpoint ainda aceita `realocacao_id: string` (singular) como fallback de compatibilidade, mas o frontend sempre envia array.

**Side effects (ambos os modos):**
- Gera mov S no ledger pela qty pega com `origem_tipo='nf_venda'` (origem `emprestimo` foi removida em 2026-05-20). Wave consolidado: 1 mov S compartilhada por todas as realocações apontando pra mesma tripla (produto, galpão, loc). A mov carrega `empresa_vendedora_id` = empresa origem do pedido (tag para apuração).
- Insere 1 linha em `siso_pedido_item_mov_links` por (item, realocação?, mov, tipo_link) — bridge N:M item↔mov pra estorno proporcional posterior.
- Se `loc_zerou` e `saldo > qty_pega`, gera mov S de ajuste `ajuste_pick_zerou` pra delta (também registrada na bridge).
- Marca registro como parcial:
  - Modo item, `loc_zerou=true` (ou pegou tudo): `siso_pedido_itens.separacao_parcial = true` + `separacao_marcado = true`.
  - Modo item, `loc_zerou=false` + residual (**parcial-em-progresso**, 2026-06-01): item fica **aberto** (`separacao_parcial = false`, `separacao_marcado = false`, `quantidade_pega` acumulada) e o pedido **continua `em_separacao`** com o mesmo operador — **não** reenfileira nem solta a onda. O operador completa o restante na mesma onda (`marcar-item`/`bipar`/novo `parcial` descontam `quantidade_pedida − quantidade_pega`). **NÃO** seta `separacao_parcial` (senão `marcar-item`/`parcial`/`bipar-checklist` rejeitariam o re-pick e o residual ficaria impossível de completar).
  - Modo realocação: `siso_pedido_item_realocacoes.status = 'picado_parcial'` (ou `'picado'` se cobriu integral).
- Acumula `quantidade_pega` no item pai via RPC `wms_acumular_qty_pega` (UPDATE atômico — evita race em wave consolidado).
- Se sobra residual: dispara `resolverRealocacao` excluindo loc original do item + todas as locs de realocações do mesmo item (qualquer status). Em wave consolidado a cascade roda em **todos** os itens afetados (multi-empresa). Cria novas linhas em `siso_pedido_item_realocacoes` com `parent_realocacao_id = realoc.id` no modo realocação, ou sem parent no modo item.

**Resposta:**

| Status | Significado | Modo |
|---|---|---|
| `{ status: 'completo' }` | Sem residual — pegou tudo ou pegou o suficiente | ambos |
| `{ status: 'realocado', realocacoes: [...] }` | Cascade criou linhas novas (mesmo galpão) pra cobrir o residual | ambos |
| `{ status: 'parcial_em_progresso', items_parciais, items_residuais_a_fazer }` | **2026-06-01:** `loc_zerou=false` + residual (prateleira ainda tem). O item fica **aberto no MESMO checklist** mostrando só o que falta; o pedido **continua `em_separacao`** com o mesmo operador (não reenfileira, não solta a onda; `separacao_reenfileirado_em` permanece null). Os itens residuais ficam `separacao_parcial=false`, `separacao_marcado=false`, `quantidade_pega` acumulada (os 3 paths de pick rejeitam `separacao_parcial=true`); o badge "Parcial X/Y" e a qty exibida derivam de `quantidade_pega`. Frontend dá toast e **permanece** no checklist (sem redirect). O `concluir` só fecha o pedido quando todos os itens estiverem marcados. | item |
| `{ status: 'sem_cobertura_outro_galpao', tem_em_outro_galpao: true, galpoes_alternativos: [{galpao_id, galpao_nome, disponivel}], pedido_ids, item_ids }` | **Fase 1:** cascade esgotou no galpão atual mas há saldo VIVO em outro galpão. Frontend abre o `EsgotadoModal` (encaminhar-first): "Encaminhar p/ Galpão X" como 1ª opção, OC como fallback. | item (loc_zerou) |
| `{ status: 'mandado_pra_compras', tem_em_outro_galpao: false, itens_atualizados, pedidos_atualizados }` | **Fase 1:** cascade esgotou e nenhum galpão tem saldo → itens transitam direto pra `aguardando_compra` (sem modal). | item (loc_zerou) |
| `{ status: 'sem_cobertura' }` | Modo realocação: galpão sem cobertura pro residual. Frontend abre modal encaminhar/OC. **NÃO** marca pedido pendente_realocacao. | realocação |
| `{ status: 'aguardando_supervisor', motivo: 'sem_grupos_elegiveis' }` | Defensivo — `porEmpresa` vazio (edge raro). | item |

**Erros:**
- 400 — body inválido, qty > sugerida, ou pedido sem empresa_origem.
- 404 — item / realocação / pedido não encontrado.
- 409 — código estável no payload `{ error, code }`:
  - `realocacao_ja_picada` — race no `UPDATE … WHERE status='aguardando_picking'` (a realoc foi marcada como `picado`/`cancelado` por outra request entre o fetch e o UPDATE pessimista).
  - `race_item_ja_picado` — race no `UPDATE … WHERE separacao_marcado=false` (outro operador marcou o item entre o fetch e o UPDATE).
  - `posicao_reservada` — saldo reservado por **outros** pedidos não cobre a `quantidade_pega`. Gate compara `quantidade_pega` contra `saldo − reservado_de_outros` (= disponível + reserva viva do próprio lote nesta loc), **não** contra `disponivel` cru. A reserva do próprio pedido (R que o `aprovar` criou e que o passo 7a libera) não bloqueia — o pedido tem direito a ela. Fix 2026-06-01: antes usava `disponivel` cru e travava o pedido de pegar a própria reserva quando a loc estava 100% alocada entre vários pedidos (disponivel=0). Payload `{ error, saldo, reservado (de outros), disponivel (pra você), quantidade_pega }`.
  - Item já processado / realocação não-`aguardando_picking` (versões anteriores ao fix-pack — agora coberto pelos códigos acima).

**Side Effects (resumo):**
- Inserts 1-2 rows in `siso_movimentacoes` (origem_tipo=`nf_venda` + optionally `ajuste_pick_zerou`). *(origem `emprestimo` removida em 2026-05-20.)* **Shape (fix 2026-05-21, commit `fe1a849`):** `origem_id=NULL` em todas as movs do endpoint (RPC `wms_inserir_movimentacao` exige uuid; antes vinha string `pedido:<tinyId>` causando 22P02 silencioso). Tiny pedido id viaja em `origem_detalhes.pedido_id_tiny` (jsonb); wave consolidado lista também `pedidos_cobertos` no jsonb.
- Modo item: updates `siso_pedido_itens` (`separacao_parcial`, `quantidade_pega`, `parcial_em`, `parcial_por`, `parcial_motivo`, `mov_saida_id`, `mov_ajuste_loc_zerou_id`, `separacao_marcado=true`).
- Modo realocação: updates `siso_pedido_item_realocacoes` da raiz (`status`, `quantidade_pega`, `parcial`, `parcial_motivo`, `parcial_em`, `parcial_por`, `mov_id`, `mov_ajuste_loc_zerou_id`); acumula `quantidade_pega` no `siso_pedido_itens` pai.
- Inserts rows in `siso_pedido_item_realocacoes` (status=`aguardando_picking`, `parent_realocacao_id` setado no modo realocação).
- May update `siso_pedidos.status_separacao = 'pendente_realocacao'` se modo item sem cobertura.
- Inserts events in `siso_pedido_historico`: `parcial_loc_zerou` (sempre) + `realocacao_sem_cobertura_galpao` (se sem_cobertura no modo item).

**Spec:** `docs/superpowers/specs/2026-05-18-realocacao-cascateavel-design.md`

---

### POST /api/wms/separacao/marcar-realocacao

**File:** `src/app/api/wms/separacao/marcar-realocacao/route.ts`

**Purpose:** Confirm that the operator has physically picked a re-allocated item from the indicated location. Creates a WMS ledger movement.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "realocacao_id": "uuid"
}
```

**Response (200):**
```json
{
  "status": "picado",
  "mov_id": "uuid"
}
```

**Response (409 - Race / already picked or cancelled):**
```json
{
  "error": "Realocacao ja foi picada ou cancelada",
  "code": "realocacao_ja_picada",
  "status_atual": "string"
}
```

> **Fix-pack 2026-05-18 (I2):** retorno passou de 400 para 409 com `code: 'realocacao_ja_picada'` estável, detectado via lock pessimista pós-mov: o UPDATE final tem `WHERE status='aguardando_picking'` — se `rowCount=0` o endpoint estorna a mov S recém-criada e devolve 409, permitindo ao frontend distinguir race de erro de validação.

**Response (404 - Not found):**
```json
{
  "error": "Realocacao nao encontrada"
}
```

**Business Logic:**
- Fetches realocacao row from `siso_pedido_item_realocacoes`
- Validates status = `aguardando_picking`
- Creates WMS movement: tipo=S, origem_tipo=`nf_venda` *(3D — empresa_vendedora_id na mov; flag `is_emprestimo` ignorada em inserts novos desde 2026-05-20)*
- Updates realocacao com lock pessimista: `UPDATE … SET status='picado', mov_id=… WHERE id=… AND status='aguardando_picking'`. Se `rowCount=0`, estorna a mov e devolve 409 `realocacao_ja_picada`.
- Adds `quantidade` to parent item's `quantidade_pega` via RPC `wms_acumular_qty_pega` (UPDATE atômico).
- Insere 1 linha em `siso_pedido_item_mov_links` (tipo_link='saida') pra bridge item↔mov.
- Registers audit event `realocacao_picada`.

**Side Effects:**
- Inserts row in `siso_movimentacoes`. **Shape (fix 2026-05-21, commit `fe1a849`):** `origem_id=NULL` (RPC exige uuid; antes vinha `pedido:<tinyId>` causando 22P02 silencioso). Tiny pedido id viaja em `origem_detalhes.pedido_id_tiny` (jsonb).
- Inserts row in `siso_pedido_item_mov_links`
- Updates `siso_pedido_item_realocacoes.status = 'picado'`
- Updates `siso_pedido_itens.quantidade_pega` (+=quantidade) via RPC atômica
- Inserts event `realocacao_picada` in `siso_pedido_historico`

---

### DELETE /api/wms/separacao/realocacao/[id]

**File:** `src/app/api/wms/separacao/realocacao/[id]/route.ts`

**Purpose:** Cancel a pending re-allocation (status=`aguardando_picking`) and cascade-cancel all pending descendants (linhas de realocação geradas a partir desta via `parent_realocacao_id`). Does not create any WMS movement since no pick has occurred yet.

**Auth:** X-Session-Id (required)

**Path Params:**
- `id`: realocacao UUID

**Response (200):**
```json
{
  "status": "cancelado",
  "descendentes_canceladas": 2
}
```

> **Fix-pack 2026-05-18 (C3):** o cancelamento agora cascateia pra toda a chain descendente via `parent_realocacao_id` (recursive CTE). Retorna `descendentes_canceladas: number` no payload.

**Response (409 - Chain has picked descendants):**
```json
{
  "error": "Chain tem realocacoes ja picadas — use desfazer-parcial",
  "code": "chain_tem_picadas",
  "descendentes_picadas": ["uuid"]
}
```

**Response (404 - Not found):**
```json
{
  "error": "Realocacao nao encontrada"
}
```

**Business Logic:**
- Carrega chain descendente via CTE recursiva (`parent_realocacao_id = :id` + descendentes transitivos)
- Bloqueia com 409 `chain_tem_picadas` se qualquer descendente está em `picado` ou `picado_parcial` — operador precisa usar `desfazer-parcial` pra estornar a chain
- Caso ok: `UPDATE siso_pedido_item_realocacoes SET status='cancelado' WHERE id IN (raiz + descendentes_pendentes)`
- No WMS movement created (nothing was physically picked)
- Registers audit event `realocacao_cancelada` na raiz; descendentes registram `realocacao_cancelada_cascade`

**Side Effects:**
- Updates `siso_pedido_item_realocacoes.status = 'cancelado'` para a raiz + descendentes pendentes
- Inserts event `realocacao_cancelada` (raiz) + `realocacao_cancelada_cascade` (descendentes) in `siso_pedido_historico`

---

### POST /api/wms/separacao/desfazer-parcial

**File:** `src/app/api/wms/separacao/desfazer-parcial/route.ts`

**Purpose:** Undo a short pick entirely. Estorna all ledger movements (saida + ajuste), cancels pending realocacoes, resets all partial fields on the item. Blocked if any realocacao has already been picked.

**Auth:** X-Session-Id (required)

**Request Body:**
```json
{
  "pedido_item_id": "uuid"
}
```

**Response (200):**
```json
{
  "status": "desfeito"
}
```

**Response (400 - Realocacao already picked):**
```json
{
  "error": "Realocacao ja foi picada — nao e possivel desfazer parcial",
  "realocacao_id": "uuid"
}
```

**Response (404 - Item not found):**
```json
{
  "error": "Item nao encontrado"
}
```

**Business Logic:**
- Validates no realocacao has status = `picado` (would require manual correction)
- **Wave consolidado / bridge-table path (preferida):** lê linhas de `siso_pedido_item_mov_links` filtradas por `pedido_item_id = :item_id` e `realocacao_id IS NULL` (mov da raiz do parcial). Para cada link chama `wms_estornar_parcial_movimentacao(mov_id, qty, usuario, observacoes)` — RPC que cria 1 mov contrária com qty proporcional e incrementa `qty_estornada` na mov fonte. Suporta mov compartilhada entre múltiplos itens (estorno proporcional, não total).
- **Legacy path (fallback):** se não há linhas na bridge (parciais criadas antes do fix-pack), estorna `mov_saida_id` e `mov_ajuste_loc_zerou_id` em modo legacy (full estorno).
- Cancels all realocacoes with status = `aguardando_picking` (descendentes da raiz incluso, via `parent_realocacao_id`)
- Resets item fields: `separacao_parcial=false`, `quantidade_pega=null`, `parcial_motivo/em/por=null`, `mov_saida_id=null`, `mov_ajuste_loc_zerou_id=null`, `separacao_marcado=false`
- If pedido was in `pendente_realocacao`: transitions back to `em_separacao`
- Registers audit event `parcial_desfeito`

**Side Effects:**
- Inserts estorno rows in `siso_movimentacoes` via RPC `wms_estornar_parcial_movimentacao` (proporcional) ou `wms_estornar_movimentacao` (legacy)
- Atualiza `siso_movimentacoes.qty_estornada` (acumulado) na mov fonte
- Deleta linhas da bridge `siso_pedido_item_mov_links` consumidas
- Updates `siso_pedido_item_realocacoes.status = 'cancelado'` for pending rows
- Resets `siso_pedido_itens` partial fields
- May update `siso_pedidos.status_separacao = 'em_separacao'`
- Inserts event `parcial_desfeito` in `siso_pedido_historico`

---

### POST /api/wms/separacao/reiniciar

**File:** `src/app/api/wms/separacao/reiniciar/route.ts`

**Purpose:** Reset checklist or packing progress for given pedidos. Usa o helper compartilhado `resetarEstadoSeparacaoItens` (mesma lógica de `encaminhar`/`voltar-etapa`/`produto-esgotado`).

**Auth:** X-Session-Id (required)

> **Fix-pack 2026-05-18 (C6 + I8):** endpoint passou a exigir sessão e foi refatorado pra consumir o helper `resetarEstadoSeparacaoItens` em `src/lib/separacao/reset-state.ts` — antes duplicava a lógica de reset.

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

**P3 #2.10 — `etapa='embalagem'` reverte cutover do ledger.** Quando reverte-se da etapa
de embalagem pra separação, agora estorna as movs `'L'` e `'S'` emitidas pelo cutover via
`reverterCutoverDoPedido` em `src/lib/wms/cutover.ts`. Antes, voltar etapa de embalagem
deixava saldo permanentemente saído (estado fantasma — reserva já tinha virado L+S e ninguém
revertia). Now is paritário: re-iniciar embalagem é seguro.

**Side Effects:**
- Updates `siso_pedido_itens`
- Em `etapa='embalagem'`: chama `reverterCutoverDoPedido` (estorna L+S e re-cria R com saldo)
- Logs to `siso_logs`

---

### POST /api/wms/separacao/encaminhar

**File:** `src/app/api/wms/separacao/encaminhar/route.ts`

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
- `status_separacao` must be `aguardando_separacao`, `em_separacao` **or `pendente_realocacao`** (fix-pack 2026-05-18 I7 — antes pedidos travados em `pendente_realocacao` não podiam ser encaminhados)
- Cannot forward to the same galpão (`separacao_galpao_id !== galpao_destino_id`)
- Reset de estado via helper compartilhado `resetarEstadoSeparacaoItens` (fix-pack I8)

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

### POST /api/wms/separacao/forcar-pendente

**File:** `src/app/api/wms/separacao/forcar-pendente/route.ts`

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

### PATCH /api/wms/separacao/{pedidoId}/forcar-pendente

**File:** `src/app/api/wms/separacao/[pedidoId]/forcar-pendente/route.ts`

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

### POST /api/wms/separacao/voltar-etapa

**File:** `src/app/api/wms/separacao/voltar-etapa/route.ts`

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
- Aceita pedidos em `pendente_realocacao` como origem (fix-pack 2026-05-18 I7 — antes status era rejeitado pela validação).
- **Going backward (to earlier stage):**
  - Reset de estado via helper compartilhado `resetarEstadoSeparacaoItens` (fix-pack I8)
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

### POST /api/wms/separacao/bipar-embalagem

**File:** `src/app/api/wms/separacao/bipar-embalagem/route.ts`

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

**Response (422 - Bipou além do teto em item parcial):**
```json
{
  "error": "bipou_alem_do_teto",
  "code": "bipou_alem_do_teto",
  "teto": 2,
  "tentado": 3
}
```

> **Fix-pack 2026-05-18 (I6):** o endpoint passa `p_strict_qty_pega = true` pra RPC. Quando o item tem `separacao_parcial = true`, o teto da bipagem deixa de ser `quantidade_pedida` e passa a ser **qty pega real** = `item.quantidade_pega + Σ realocs.quantidade_pega (em 'picado'|'picado_parcial')`. Tentativa de ultrapassar retorna 422 com `teto` e `tentado` numéricos. UI da embalagem mostra banner explicativo.

**Business Logic:**
- Validates session to identify the packing operator
- Calls RPC `siso_processar_bip_embalagem` com `p_strict_qty_pega := true`
- RPC finds the oldest separado-status order with matching SKU, increments quantidade_bipada respeitando teto strict pra itens parciais
- If pedido_completo: calls `imprimirEtiquetaDireta` or `buscarEImprimirEtiqueta` to print label on the **packing operator's** printer

**Side Effects:**
- RPC atomically updates `siso_pedido_itens.quantidade_bipada`, `bipado_completo`
- May update `siso_pedidos.status_separacao = "embalado"`, `embalagem_concluida_em`, `embalagem_operador_id`
- Calls label printing (resolves printer from packing operator, not separation operator)
- Logs to `siso_logs`

---

### POST /api/wms/separacao/bipar-embalagem-oc

**File:** `src/app/api/wms/separacao/bipar-embalagem-oc/route.ts`

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

### POST /api/wms/separacao/confirmar-item-embalagem

**File:** `src/app/api/wms/separacao/confirmar-item-embalagem/route.ts`

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

### POST /api/wms/separacao/expedir

**File:** `src/app/api/wms/separacao/expedir/route.ts`

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

### GET /api/wms/separacao/tags

**File:** `src/app/api/wms/separacao/tags/route.ts`

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

### POST /api/wms/separacao/tags

**File:** `src/app/api/wms/separacao/tags/route.ts`

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

### POST /api/wms/separacao/produto-esgotado

**File:** `src/app/api/wms/separacao/produto-esgotado/route.ts`

**Purpose:** Three modes for handling out-of-stock products: preview alternatives, create purchase order, or redirect to another galpão.

**Auth:** X-Session-Id (required)

> **Fix-pack 2026-05-18 (C8 + I9):** endpoint passou a exigir sessão. No modo OC, o cálculo do residual agora considera o que já foi pego (parcial + realocações picadas): `residual = quantidade_pedida - (item.quantidade_pega + Σ realocs.quantidade_pega em status 'picado'|'picado_parcial')`. Itens com `residual=0` são **pulados** (não viram OC) — antes a request criava OC pra qty 0.

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
- **OC mode:** marks items for purchase, creates/updates OC, resets separation state, moves pedidos to aguardando_compra.
  - Calcula `residual = quantidade_pedida - quantidade_pega_total` por item, onde `quantidade_pega_total = item.quantidade_pega + Σ realocs.quantidade_pega (status IN ('picado','picado_parcial'))`. Itens com `residual = 0` são pulados.
  - Usa helper compartilhado `resetarEstadoSeparacaoItens` para reset de estado (mesmo helper consumido por `encaminhar`/`reiniciar`/`voltar-etapa`).
- **Encaminhar mode:** resets separation state, changes separacao_galpao_id to destination, moves pedidos back to aguardando_separacao. Reset via helper `resetarEstadoSeparacaoItens`.

**Side Effects:**
- Updates `siso_pedido_itens` (compra_status, fornecedor_oc, etc. for OC mode)
- Updates `siso_pedidos.status_separacao`, `separacao_galpao_id` for OC/encaminhar modes
- May create `siso_ordens_compra` for OC mode
- Logs to `siso_logs`

---

### POST /api/wms/separacao/validar-oc-item

**File:** `src/app/api/wms/separacao/validar-oc-item/route.ts`

**Purpose:** Handle OC item validation during the validacao_oc phase. Supports "encontrei" (found physically), "esgotado" (confirmed missing), and "desfazer_encontrei" (undo found) actions, with auto-transitions when all OC items are resolved.

**Auth:** Session required (X-Session-Id header)

**Request Body:**
```json
{
  "item_ids": ["uuid", "uuid"],
  "acao": "encontrei | esgotado | desfazer_encontrei",
  "qty_contada": "number (optional, only acao=encontrei)",
  "localizacao_codigo": "string (optional, only acao=encontrei)"
}
```

- `qty_contada` (number, optional — only meaningful when `acao='encontrei'`): total de unidades contadas fisicamente na prateleira (acerto de prateleira / contagem inline). Quando presente, o backend reconcilia o saldo da loc registrando uma contagem oficial (gera mov `inventario_ganho`/`inventario_perda` conforme o delta vs. saldo de sistema) antes de separar o pedido. Exige `qty_contada >= quantidade_pedida` do item — caso contrário responde **422** `contagem_menor_que_pedido`. `qty_contada <= 0` responde **422** `contagem_invalida`. Ausente = comportamento legado (pick sem contagem).
- `localizacao_codigo` (string, optional — only meaningful when `acao='encontrei'`): código da prateleira bipada. Alternativa a `localizacao_id` (uuid) pra resolver a loc-alvo da contagem dentro do galpão do pedido (`siso_localizacoes` filtrado por `galpao_id` do pedido + `codigo`). Usado em conjunto com `qty_contada`.

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

**Response (422 - Contagem inline inválida, only acao=encontrei):**
```json
{
  "error": "contagem_menor_que_pedido | contagem_invalida | loc_obrigatoria | loc_invalida",
  "message": "string",
  "item_id": "uuid",
  "qty_contada": "number (contagem_menor_que_pedido)",
  "qty_pedido": "number (contagem_menor_que_pedido)"
}
```

**Business Logic:**
- **encontrei:** Clears all compra fields (compra_status, fornecedor_oc, compra_quantidade_solicitada, compra_solicitada_em, ordem_compra_id) and marks item as picked (separacao_marcado = true, bipado_completo = true, quantidade_bipada = quantidade_pedida). Quando o body traz `qty_contada` (acerto de prateleira / Fase 1), reconcilia o saldo da loc-alvo (resolvida por `localizacao_id` ou `localizacao_codigo`) via `registrarContagemInline` registrando uma contagem oficial antes do pick. Exige `qty_contada >= quantidade_pedida`.
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

### POST /api/wms/separacao/reimprimir

**File:** `src/app/api/wms/separacao/reimprimir/route.ts`

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

### POST /api/wms/separacao/retry-etiqueta

**File:** `src/app/api/wms/separacao/retry-etiqueta/route.ts`

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

### POST /api/wms/separacao/localizacao

**File:** `src/app/api/wms/separacao/localizacao/route.ts`

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

### GET /api/wms/compras

**File:** `src/app/api/wms/compras/route.ts`

**Purpose:** Comprehensive purchase management dashboard. Returns counts and item groups by supplier, with aging and priority metrics.

> Na tab `comprar`, a `quantidade_necessaria` de cada item é recalculada na leitura (necessidade líquida viva = `max(0, demanda_aberta − estoque_livre − em_transito)`), não um valor congelado. Pode ser 0 quando livre + em-trânsito já cobrem a demanda.

**Auth:** X-Session-Id (required), must have purchase-related cargo (comprador, admin)

**Query Params:**
- `tab`: "comprar" | "receber" | "historico" (default: "comprar")
- `cursor` (apenas tab=historico): ISO timestamp de `comprado_em` do último item retornado anteriormente — ativa modo cursor-based
- `limit` (apenas tab=historico): items per page (default 100, max 200)

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
          "quantidade_necessaria": "number  // VIVO: max(0, demanda_aberta − estoque_livre − em_transito)",
          "demanda_aberta": "number  // Σ(pedida − pega) dos pedidos em aguardando_compra + comprado",
          "estoque_livre": "number  // Σ siso_estoque.disponivel ao vivo do SKU",
          "em_transito": "number  // Σ max(0, solicitada − recebida) dos itens 'comprado'",
          "giro_diario": "number  // giro 30d agregado (MV siso_cobertura_estoque)",
          "dias_cobertura": "number | null  // estoque_livre / giro_diario (null se giro=0)",
          "status_cobertura": "critico | lead_time_risco | atencao | ok | sem_giro  // pior status entre galpões",
          "lead_time_medio": "number | null  // maior lead time entre galpões (dias) ou null",
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
  ],
  "next_cursor": "ISO datetime | null"
}
```

**Business Logic:**
- **Comprar tab:** Groups items by fornecedor, aggregates by SKU, includes all unique pedidos per SKU
- **Receber tab:** Shows purchased items awaiting receipt; auto-fixes items over-received
- **Historico tab:** Shows received items (compra_status = "recebido") grouped by fornecedor and date. Paginação cursor-based via `?cursor=<comprado_em>&limit=<N>` (default 100, max 200); `next_cursor` é null quando exausto. Ordering `comprado_em DESC, id DESC` (tiebreaker estável).

**Side Effects:** Auto-fix in receber tab (marks over-received items as "recebido")

**Rate Limiting:** None

---

### POST /api/wms/compras/ordens

**File:** `src/app/api/wms/compras/ordens/route.ts`

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

### GET /api/wms/compras/conferencia/[ordemCompraId]

**File:** `src/app/api/wms/compras/conferencia/[ordemCompraId]/route.ts`

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

### POST /api/wms/compras/receber

**File:** `src/app/api/wms/compras/receber/route.ts`

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

### POST /api/wms/compras/comprar

**File:** `src/app/api/wms/compras/comprar/route.ts`

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

### POST /api/wms/compras/trocar-sku

**File:** `src/app/api/wms/compras/trocar-sku/route.ts`

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

### POST /api/wms/compras/itens/[itemId]/equivalente

**File:** `src/app/api/wms/compras/itens/[itemId]/equivalente/route.ts`

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

### POST /api/wms/compras/itens/[itemId]/equivalente/confirmar

**File:** `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts`

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

### POST /api/wms/compras/itens/[itemId]/cancelamento

**File:** `src/app/api/wms/compras/itens/[itemId]/cancelamento/route.ts`

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

### POST /api/wms/compras/itens/[itemId]/cancelamento/confirmar

**File:** `src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts`

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

### POST /api/wms/compras/preparar-embalagem

**File:** `src/app/api/wms/compras/preparar-embalagem/route.ts`

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

### POST /api/wms/compras/itens/[itemId]/indisponivel

**File:** `src/app/api/wms/compras/itens/[itemId]/indisponivel/route.ts`

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

### POST /api/wms/compras/itens/[itemId]/devolver

**File:** `src/app/api/wms/compras/itens/[itemId]/devolver/route.ts`

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

### POST /api/wms/compras/pedidos/[pedidoId]/cancelar

**File:** `src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts`

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

## Compras Manuais API

> Compra avulsa de fornecedor (**sem pedido de cliente**). Aggregate próprio (`siso_compras_manuais` + `siso_compras_manuais_itens`), separado da OC ligada a pedido. O recebimento gera mov `E` reusando `origem_tipo='nf_compra'` (whitelist do custo médio), distinguido por `origem_detalhes.origem='compra_manual'`, **sem NF**. Lib de domínio: `src/lib/wms/compras-manuais.ts`. Frontend: aba "Manuais" em `src/app/wms/compras/page.tsx`.

### POST /api/wms/compras-manuais

**File:** `src/app/api/wms/compras-manuais/route.ts`

**Purpose:** Cria uma compra manual (cabeçalho + itens), status inicial `comprado`.

**Auth:** X-Session-Id (required), `compras.executar`

**Request Body:**
```json
{
  "fornecedor_id": "uuid",
  "empresa_compradora_id": "uuid",
  "galpao_id": "uuid",
  "observacao": "string | null",
  "itens": [
    { "produto_id": "uuid", "qty_comprada": "number", "custo_unitario": "number | null" }
  ]
}
```

**Response (201):**
```json
{ "ok": true, "compra_id": "uuid", "itens_criados": "number" }
```

**Response (400):** `fornecedor_id, empresa_compradora_id e galpao_id são obrigatórios` · `envie { itens: [{ produto_id, qty_comprada }] }` · FK/produto inexistente · `qty_comprada deve ser > 0`

**Business Logic:**
- Valida FKs (fornecedor / empresa / galpão) e produtos com mensagens claras antes de inserir
- Insere cabeçalho (`status='comprado'`) + itens (`qty_recebida=0`)
- Rollback best-effort do cabeçalho órfão se o insert dos itens falhar

---

### GET /api/wms/compras-manuais

**File:** `src/app/api/wms/compras-manuais/route.ts`

**Purpose:** Lista compras manuais com fornecedor, empresa e itens (sku/descrição) embutidos.

**Auth:** X-Session-Id (required), `compras.ver`

**Query Params:**
- `status` — `pendentes` (default; agrupa `comprado`+`parcial`) · `recebido` · `cancelado`

**Response (200):**
```json
{
  "rows": [
    {
      "id": "uuid",
      "status": "comprado | parcial | recebido | cancelado",
      "observacao": "string | null",
      "criado_em": "ISO datetime",
      "recebido_em": "ISO datetime | null",
      "galpao_id": "uuid",
      "fornecedor": { "id": "uuid", "nome": "string" } | null,
      "empresa": { "id": "uuid", "nome": "string" } | null,
      "itens": [
        {
          "id": "uuid",
          "produto_id": "uuid",
          "sku": "string",
          "descricao": "string",
          "qty_comprada": "number",
          "qty_recebida": "number",
          "custo_unitario": "number | null"
        }
      ]
    }
  ]
}
```

---

### POST /api/wms/compras-manuais/[id]/receber

**File:** `src/app/api/wms/compras-manuais/[id]/receber/route.ts`

**Purpose:** Recebe itens de uma compra manual (parcial permitido). Cada item recebido gera uma mov `E` no ledger.

**Auth:** X-Session-Id (required), `compras.executar`

**Request Body:**
```json
{
  "itens": [
    { "item_id": "uuid", "qty_recebida": "number", "custo_unitario": "number | null" }
  ]
}
```

**Response (200):**
```json
{ "ok": true, "movs_geradas": "number", "status": "comprado | parcial | recebido" }
```

**Response (400):** `envie { itens: [{ item_id, qty_recebida }] }` · `compra cancelada não pode receber` · `qty excede faltante` · `recebimento concorrente detectado` · loc `recebimento` ausente no galpão

**Business Logic:**
- Itens processados **sequencialmente**. Por item: lock otimista no `qty_recebida` (detecta dupla-recepção concorrente) → grava mov `E` (se falhar, reverte o bump e relança) → recomputa status do cabeçalho.
- Mov `E` na loc `tipo='recebimento'` do galpão, `origem_tipo='nf_compra'` + `origem_detalhes.origem='compra_manual'`, tags `fornecedor_id` + `empresa_compradora_id`, custo via `resolverCustoEntrada` (lança se sem custo nem histórico — guard P108). Custo médio recalcula.
- **Não atômico entre itens:** se um item posterior lança, os anteriores já recebidos PERMANECEM commitados — caller deve re-buscar e retentar só o que falhou.
- **Não** chama `checkAndReleasePedidos` (não há pedido); o `reconciliador-oc` puxa o saldo pra pedidos OC parados via o mov `E` (após put-away).

**Side Effects:**
- Insere mov(s) `E` em `siso_movimentacoes` (via `wms_inserir_movimentacao`), atualiza `siso_estoque` e `siso_custo_medio`
- Atualiza `siso_compras_manuais_itens.qty_recebida`/`custo_unitario` e `siso_compras_manuais.status`/`recebido_em`

---

### DELETE /api/wms/compras-manuais/[id]

**File:** `src/app/api/wms/compras-manuais/[id]/route.ts`

**Purpose:** Cancela uma compra manual.

**Auth:** X-Session-Id (required), `compras.executar`

**Request Body:** Empty

**Response (200):** `{ "ok": true }`

**Response (404 — `nao_encontrada`) / (409 — `tem_recebimento` ou `ja_cancelada`):**
```json
{ "error": "nao_encontrada | tem_recebimento | ja_cancelada" }
```

**Business Logic:**
- 409 se qualquer item já tem `qty_recebida > 0` (`tem_recebimento`) ou se já está cancelada (`ja_cancelada`)
- Senão seta `status='cancelado'`

---

### POST /api/wms/compras-manuais/fornecedor

**File:** `src/app/api/wms/compras-manuais/fornecedor/route.ts`

**Purpose:** Criação inline de fornecedor a partir do modal de compra manual.

**Auth:** X-Session-Id (required), `compras.executar` (**não** `requireAdmin`, ao contrário de `/api/wms/fornecedores`)

**Request Body:**
```json
{ "nome": "string", "cnpj": "string | null" }
```

**Response (201):** o fornecedor criado.

**Response (400 — `nome obrigatório`) / (409 — `Fornecedor com esse nome já existe`).**

---

### POST /api/wms/compras-manuais/produto

**File:** `src/app/api/wms/compras-manuais/produto/route.ts`

**Purpose:** Criação inline de produto mínimo (sku + descrição) a partir do modal de compra manual. Sem dados fiscais — Tiny é a camada fiscal.

**Auth:** X-Session-Id (required), `compras.executar`

**Request Body:**
```json
{ "sku": "string", "descricao": "string" }
```

**Response (201):** o produto criado.

**Response (400 — `sku e descricao obrigatórios`) / (409 — `SKU já existe`).**

---

## Admin API

### GET /api/wms/admin/galpoes

**File:** `src/app/api/wms/admin/galpoes/route.ts`

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

### POST /api/wms/admin/galpoes

**File:** `src/app/api/wms/admin/galpoes/route.ts`

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

### GET /api/wms/admin/usuarios

**File:** `src/app/api/wms/admin/usuarios/route.ts`

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

### POST /api/wms/admin/usuarios

**File:** `src/app/api/wms/admin/usuarios/route.ts`

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

### PUT /api/wms/admin/usuarios

**File:** `src/app/api/wms/admin/usuarios/route.ts`

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

### DELETE /api/wms/admin/usuarios?id=uuid

**File:** `src/app/api/wms/admin/usuarios/route.ts`

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

- **GET** `/api/wms/admin/galpoes/[id]` - Fetch galpão detail with nested empresas and grupo info
- **PUT** `/api/wms/admin/galpoes/[id]` - Update galpão name, descricao, ativo status
- **DELETE** `/api/wms/admin/galpoes/[id]` - Delete galpão (cascades to empresas)

### Additional Admin Routes - Empresas

- **GET** `/api/wms/admin/empresas` - List all empresas with galpão, grupo, and Tiny connection info
- **POST** `/api/wms/admin/empresas` - Create new empresa (CNPJ, name, galpão)
- **PUT** `/api/wms/admin/empresas/[id]` - Update empresa name, CNPJ, ativo status
- **DELETE** `/api/wms/admin/empresas/[id]` - Delete empresa (cascades to grupo relations and connections)

### Additional Admin Routes - Grupos

- **GET** `/api/wms/admin/grupos` - List all grupos
- **POST** `/api/wms/admin/grupos` - Create new grupo (name, descricao)
- **PUT** `/api/wms/admin/grupos/[id]` - Update grupo name, descricao
- **DELETE** `/api/wms/admin/grupos/[id]` - Delete grupo (cascades to empresa relations)

### Additional Admin Routes - Grupo-Empresa Relations

- **POST** `/api/wms/admin/grupos/[id]/empresas` - Add empresa to grupo (updates or creates empresa_id + tier)
- **PUT** `/api/wms/admin/grupos/[id]/empresas/[empresaId]` - Update empresa tier in grupo
- **DELETE** `/api/wms/admin/grupos/[id]/empresas/[empresaId]` - Remove empresa from grupo

### Additional Admin Routes - PrintNode (multi-conta)

PrintNode suporta múltiplas contas (uma API key por conta) desde 2026-05-19.
A key fica em `siso_printnode_contas`, e galpões/usuários guardam
`printnode_account_id` (+ `_produto`) pra lembrar qual conta usar ao imprimir.

- **GET** `/api/wms/admin/printnode/contas` - Lista contas (label, masked, ativo) — nunca expõe a key real
- **POST** `/api/wms/admin/printnode/contas` - Cria conta `{ label, api_key }` (label UNIQUE)
- **PATCH** `/api/wms/admin/printnode/contas/[id]` - Atualiza `{ label?, api_key?, ativo? }`. Trocar api_key não invalida atribuições (galpões/usuários continuam apontando pra mesma conta com a key nova).
- **DELETE** `/api/wms/admin/printnode/contas/[id]` - Remove conta. FKs em galpões/usuários são ON DELETE SET NULL — atribuições viram null e `resolverImpressora` retorna null.
- **POST** `/api/wms/admin/printnode/contas/[id]/test` - Testa via `/whoami` no PrintNode. Body opcional `{ api_key }` permite testar uma key NOVA antes de salvar.
- **GET** `/api/wms/admin/printnode/printers` - Lista impressoras agregadas de TODAS as contas ativas. Retorna `[{ accountId, accountLabel, printers[], error }]`. Contas com falha não derrubam a resposta — vêm com `error` preenchido e `printers: []`.

### Additional Admin Routes - Roles & Permissões (2026-05-21)

### `GET /api/wms/admin/permissoes`
Retorna catálogo do registry (31 perms / 8 módulos) agrupado por módulo. Auth: sessão válida (qualquer cargo autenticado).

Response: `{ modulos: Array<{ id, label, permissoes: Array<{ codigo, label }> }>, total: number }`

### `GET /api/wms/admin/roles`
Lista todas roles + counts (n_permissoes, n_usuarios). Auth: `sistema.roles`.

### `POST /api/wms/admin/roles`
Body: `{ codigo: string, nome: string, descricao?: string }`. Codigo: `^[a-z][a-z0-9_]*$`. 409 se duplicado. Auth: `sistema.roles`.

### `GET /api/wms/admin/roles/[id]`
Detalhe da role: permissoes[] + usuarios[]. Auth: `sistema.roles`.

### `PATCH /api/wms/admin/roles/[id]`
Body: `{ nome?, descricao?, ativo? }`. Role sistema não pode ser desativada. Auth: `sistema.roles`.

### `DELETE /api/wms/admin/roles/[id]`
Chama RPC `wms_role_delete`. 400 se role sistema ou se geraria órfãos. Auth: `sistema.roles`.

### `PUT /api/wms/admin/roles/[id]/permissoes`
Body: `{ permissoes: string[] }` (replace). Role admin sempre recebe TODAS. Códigos não-existentes no registry → 400. Auth: `sistema.roles`.

### `PUT /api/wms/admin/usuarios/[id]/roles`
Body: `{ role_ids: string[] }` (replace). Anti-lockout: 400 se geraria sistema sem admin. Auth: `sistema.usuarios`.

---

## Tiny ERP API

### GET /api/wms/tiny/connections

**Purpose:** List/manage Tiny OAuth2 connections per empresa.

**Auth:** None (should be admin-only)

See `src/app/api/wms/tiny/connections/route.ts`

---

### POST /api/wms/tiny/oauth

**Purpose:** Initiate OAuth2 flow for Tiny.

**Auth:** None

See `src/app/api/wms/tiny/oauth/route.ts`

---

### GET /api/wms/tiny/oauth/callback

**Purpose:** OAuth2 callback from Tiny. Stores access token.

**Auth:** None (Tiny redirects here)

See `src/app/api/wms/tiny/oauth/callback/route.ts`

---

### GET /api/wms/tiny/deposits

**Purpose:** List Tiny deposits (warehouses) for a given empresa.

**Auth:** None (should require auth)

See `src/app/api/wms/tiny/deposits/route.ts`

---

### POST /api/wms/tiny/test-connection

**Purpose:** Test Tiny connection for an empresa.

**Auth:** None (should be admin-only)

See `src/app/api/wms/tiny/test-connection/route.ts`

---

### POST /api/wms/tiny/stock/ajustar

**Purpose:** Manually adjust stock in Tiny ERP.

**Auth:** None (should require auth)

See `src/app/api/wms/tiny/stock/ajustar/route.ts`

---

## Worker & Background Jobs

### POST /api/wms/worker/processar

**File:** `src/app/api/wms/worker/processar/route.ts`

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
- Can be called directly from `/api/wms/pedidos/aprovar` via `kickWorker()`
- Can be called manually from monitoring page
- OC orders now generate NF at approval time (creating Tiny reservation). The Ciclo 2 worker (after compras-release) detects existing NF via `gerarNotaFiscalPedido` idempotency and skips to stock deduction
- `criarAgrupamentoFase1` is fire-and-forget: agrupamento failure after stock posting never causes job retry

---

## Cross — Busca de produtos e equivalência

Módulo de catálogo e equivalência de SKUs/OEMs/veículos. Cache desnormalizado de produtos do Tiny em `siso_produtos_catalogo`, com OEMs e compatibilidade veicular como fontes de verdade em tabelas próprias e denormalização via trigger.

### GET /api/wms/cross/search

**File:** `src/app/api/wms/cross/search/route.ts`

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

### GET /api/wms/cross/produtos/[sku]

**File:** `src/app/api/wms/cross/produtos/[sku]/route.ts`

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

### POST /api/wms/cross/produtos/[sku]/refetch

**File:** `src/app/api/wms/cross/produtos/[sku]/refetch/route.ts`

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
- Não retorna o detalhe — o cliente deve chamar `GET /api/wms/cross/produtos/[sku]` em seguida

**Side Effects:**
- Update em `siso_produtos_catalogo`
- Insert em `siso_produto_oems` (apenas novos OEMs extraídos)

**Rate Limiting:** Per-empresa via Tiny API rate limiter

---

### POST /api/wms/cross/produtos/[sku]/oems

**File:** `src/app/api/wms/cross/produtos/[sku]/oems/route.ts`

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

### DELETE /api/wms/cross/produtos/[sku]/oems/[codigo]

**File:** `src/app/api/wms/cross/produtos/[sku]/oems/[codigo]/route.ts`

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

### POST /api/wms/cross/produtos/[sku]/veiculos

**File:** `src/app/api/wms/cross/produtos/[sku]/veiculos/route.ts`

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

### DELETE /api/wms/cross/produtos/[sku]/veiculos/[id]

**File:** `src/app/api/wms/cross/produtos/[sku]/veiculos/[id]/route.ts`

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

### GET /api/wms/cross/sugestoes/marcas

**File:** `src/app/api/wms/cross/sugestoes/marcas/route.ts`

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

### GET /api/wms/cross/sugestoes/modelos

**File:** `src/app/api/wms/cross/sugestoes/modelos/route.ts`

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

Schema 3D (a partir de 2026-05-20): cada posição de estoque é única por **(produto_id, galpao_id, localizacao_id)**. Empresa virou TAG em movs com NF (`empresa_compradora_id` / `empresa_vendedora_id` / `empresa_referencia_id`). Toda escrita no ledger passa pela RPC `wms_inserir_movimentacao` (lock pessimista no Postgres, recalcula `siso_custo_medio` em entradas com `custo_unitario`).

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

Retorna a última contagem de inventário desse produto agrupada por localização (3D — refactor 2026-05-20: sem mais agrupar por empresa dona). Inclui contagens de sessões em qualquer status menos `cancelada` — útil pra mostrar "conferido em X" mesmo quando a contagem não gerou divergência (e portanto não há mov no ledger). Usado pela aba "Movimentações" do produto.

**Auth:** `requireAuth` (qualquer usuário autenticado).

**RPC:** `wms_produto_ultimas_contagens(p_produto_id uuid)` faz `DISTINCT ON (localizacao_id)` ordenado por `criado_em DESC`. Joina com `siso_localizacoes`, `siso_galpoes`, `siso_usuarios`, `siso_inventario_sessoes` e `siso_estoque` (LEFT) pra trazer o saldo atual da tripla.

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

Atualiza campos da localização (`codigo`, `descricao`, `tipo`, `ativo`). **Auth:** `requireAdmin`.

**Raio-X Fase 4 (P113):** trocar o `tipo` ou desativar (`ativo=false`) uma loc com **contagem
de inventário ativa** é bloqueado — mensagem `"em contagem"` → **409**. Demais validações → 400.

### DELETE /api/wms/localizacoes/[id]

Desativa logicamente. Falha com 400 se houver saldo>0. **Auth:** `requireAdmin`.

**Raio-X Fase 4 (P113/P063/P115):** o desativar agora roda guards extras —
- loc com **contagem de inventário ativa** → **409** (`"em contagem"`);
- loc que é **perna de transferência `em_transito`** (origem/destino) ou tem **pendência de guarda aberta** → bloqueia (400/erro);
- ao desativar com sucesso, **auto-limpa reservas R vencidas** apontando pra essa loc.

### GET /api/wms/localizacoes/[id]/saldos

Lista saldos > 0 da localização agrupados por produto (3D — refactor 2026-05-20: sem mais agrupamento por empresa_dona). Usado no fluxo de exclusão pra mostrar o que precisa ser movido antes da remoção.

**Auth:** `requireAuth`.

**Response 200:**
```json
{
  "rows": [
    {
      "produto_id": "uuid",
      "saldo": 12,
      "sku": "ABC-123",
      "descricao": "Produto X"
    }
  ],
  "total_qty": 12,
  "total_linhas": 1
}
```

### POST /api/wms/localizacoes/[id]/substituir-e-excluir

Move todo o saldo > 0 da loc origem pra loc destino (mesmo galpão) e desativa a origem (3D — refactor 2026-05-20: par S+E neutro em empresa, sem mais loop por dona).

**Auth:** `requireAdmin`.

**Request body:** `{ destino_id: uuid }`.

**Validações:** origem e destino existem; destino está ativo; mesma `galpao_id`; `destino_id !== id`.

**Comportamento:** carrega saldos > 0 da origem por produto, chama `replenishmentIntraGalpao` (par S+E por SKU com `origem_tipo='transferencia_localizacao'`), depois `desativarLocalizacao(origem)`.

**Atomicidade:** cada par S+E é atômico via `wms_inserir_movimentacao`, mas a sequência não tem rollback. Se falhar mid-flight, alguns SKUs já moveram e a loc origem não foi desativada — rodar de novo é seguro (o já-movido fica em saldo=0 e é ignorado).

**Response 200:** `{ ok, origem_codigo, destino_codigo, donas_movidas, itens_movidos }`.

### GET /api/wms/estoque

Saldos agregados por perspectiva (3D — refactor 2026-05-20).

**Query params:**
- `view` — `galpao|localizacao|produto` (default `produto`). *Tab `dono` removida em 2026-05-20.*
- `produto_id`, `galpao_id` — filtros opcionais. *`empresa_id` removido — não é mais coordenada de estoque.*

**Response 200:** `{ rows: [{ chave, nome, saldo, reservado, disponivel, itens: [...] }] }` ordenado por saldo desc. Linhas trazem `custo_medio` global do produto (de `siso_custo_medio`) quando aplicável.

### GET /api/wms/ledger

Lista movimentações (mais recentes primeiro). Response inclui as novas colunas de metadata por empresa/fornecedor desde 2026-05-20.

**Query params:** `produto_id`, `galpao_id`, `localizacao_id`, `origem_tipo`, `desde`, `ate`, `limit` (default 100). Filtros novos: `empresa_compradora_id`, `empresa_vendedora_id`, `empresa_referencia_id`, `fornecedor_id`. *`empresa_id` legacy descontinuado.*

**Response 200:** `{ rows: Movimentacao[] }` com joins (produto, galpao, localizacao) + 9 colunas novas: `empresa_compradora_id/nome`, `empresa_vendedora_id/nome`, `empresa_referencia_id/nome`, `fornecedor_id/nome`, `motivo`, `cliente_nome`, `custo_unitario`, `custo_medio_anterior`, `custo_medio_posterior`.

### POST /api/wms/snapshot-inicial

Bulk-load idempotente do Tiny pra popular `siso_estoque` (Fase 0).

**Auth:** Admin only.

**Query params:** `dryRun=true` para apenas contar.

**Response 200:** `{ total, criados, pulados, erros }`.

**Side Effects:** Chama Tiny `/estoque/{id}` por cada (produto, empresa) com mapeamento ativo, cria mov `inventario_inicial` na DEFAULT-PICKING. Idempotente (pula se já existe mov inventario_inicial pra a tripla produto+galpão+loc). A mov ganha `empresa_referencia_id` = a empresa Tiny que originou o snapshot (apuração histórica via report).

### GET /api/wms/reconciliacao

Detecta divergências entre `siso_movimentacoes` (autoritativo) e `siso_estoque` (cache). Cron-friendly.

**Auth:** Header `x-worker-secret` = `WORKER_SECRET`.

**Query params:** `fix=true` corrige automaticamente via `wms_rebuild_linha_estoque`.

**Response 200:** `{ divergencias: [...], corrigidas: number }`.

### GET /api/wms/reconciliacao-pedidos

**File:** `src/app/api/wms/reconciliacao-pedidos/route.ts` (Fase 2.1 — safety net)

Sinaliza os 3 padrões de inconsistência do fluxo Pedido→Separação→Estoque via RPC `wms_detectar_pedidos_inconsistentes()`. A Fase 1 (pick atômico fail-loud) tornou esses padrões impossíveis daqui pra frente; o endpoint é rede de segurança (pega histórico + detecta regressões caso uma feature reintroduza baixa paralela). Cron-friendly.

**Auth:** Header `x-worker-secret` = `WORKER_SECRET` (403 caso contrário).

**Padrões detectados:**
- `A_marcado_sem_saida` — item `separacao_marcado=true` + `quantidade_pega>0` mas `mov_saida_id IS NULL`.
- `B_saida_sem_estoque_lancado` — pedido FORWARD (`separado/embalado/expedido`) com mov S `nf_venda` viva mas `estoque_lancado=false` (filtro forward evita falso-positivo em pedidos em meio de separação).
- `C_forward_com_reserva_viva` — pedido `separado/embalado/expedido` com reserva R sem L estornando.

**Response 200:**
```json
{
  "ok": true,
  "total": 0,
  "por_padrao": { "A_marcado_sem_saida": 0, "B_saida_sem_estoque_lancado": 0, "C_forward_com_reserva_viva": 0 },
  "amostras": []
}
```
`amostras` traz até 50 linhas `{ padrao, pedido_id, produto_id, status_separacao, estoque_lancado, detalhe }`.

---

### POST /api/wms/reconciliacao-pedidos/[pedidoId]/resolver

**File:** `src/app/api/wms/reconciliacao-pedidos/[pedidoId]/resolver/route.ts` (Raio-X Fase 5 — P084)

Resolve o **pedido-fantasma** (padrão `C` do safety-net acima): pedido FORWARD com reserva R viva sem saída. Via RPC `wms_resolver_pedido_fantasma`, para cada R viva (sem L estornando), numa única transação:
- `saiu` → `L` (estorno_de=R) + `S` (`nf_venda`): converte a R em saída final.
- `cancelado` → `L` (estorno_de=R) que devolve à prateleira (reservado zera, saldo intacto) + marca o pedido `cancelado`.

Idempotente (pula R já liberada). A `empresa_vendedora_id` da S (caso `saiu`) vem do `empresa_origem_id` do pedido.

**Auth:** `requireAdmin` (mexe no ledger + status).

**Request body:**
```json
{ "acao": "saiu" | "cancelado" }
```

**Response 200:**
```json
{ "ok": true, "reservas_resolvidas": 0, "acao": "saiu" }
```

**Erros:** `400` (`acao` ausente/inválida, ou falha da RPC), `404` (pedido não encontrado).

---

## WMS — Movimentações operacionais (Plano 2)

Todas as operações orquestram chamadas a `wms_inserir_movimentacao` (RPC com lock pessimista do Plano 1). `usuario_id` é injetado pelo route handler a partir da sessão.

### POST /api/wms/receber

Registra entrada de estoque. Dois modos:

- **Modo padrão (`entrada_direta=false` ou omitido)** — etapa 1 de 2. Grava na localização tipo='recebimento' do galpão (auto-criada se necessário) e cria 1 pendência em `siso_wms_pendencias_guarda` por linha. A guarda física (decidir loc final + bipar QR + imprimir etiquetas) acontece em `/api/wms/guarda/*`.
- **Modo entrada direta (`entrada_direta=true`)** — etapa única. Grava direto na `localizacao_destino_id` de cada item. Não passa por RECEBIMENTO, não cria pendência. Exige `localizacao_destino_id` em **todos** os itens (caso contrário 500 com mensagem indicando o item faltando).

**Auth:** Session + acesso de armazém (operador/admin).

**Request body (3D — refactor 2026-05-20):**
```json
{
  "galpao_id": "uuid",
  "empresa_compradora_id": "uuid? (NF de compra/devolução)",
  "fornecedor_id": "uuid? (mapeia pra cadastro de fornecedor)",
  "nf_referencia": "string?",
  "origem_tipo": "nf_compra | devolucao_cliente_integra | devolucao_cliente_avariada | devolucao_fornecedor_recebida | lancamento_retroativo",
  "observacoes": "string?",
  "data_recebimento": "ISO timestamp? (se no passado, vira lancamento_retroativo)",
  "entrada_direta": "boolean? (default false — quando true, pula a guarda)",
  "itens": [
    { "produto_id": "uuid", "qty": 50, "custo_unitario": 10.5, "localizacao_destino_id": "uuid?" }
  ]
}
```

> Body **não tem mais `empresa_dona_id`** desde 2026-05-20 — empresa não é coordenada física. `empresa_compradora_id` e `fornecedor_id` viajam como tags na mov (lookup via `/api/wms/relatorios/movs-por-empresa`).
> `localizacao_destino_id` por item é opcional no modo padrão (tablet decide depois) e **obrigatório** no modo entrada direta.

**Side effects:**
- Modo padrão: 1 mov `origem_tipo` tipo `E` por item na loc RECEBIMENTO + 1 linha em `siso_wms_pendencias_guarda` com `qty_inicial=qty`, `status='pendente'`, FK ao `mov_entrada_id`. Se a criação da pendência falhar, a mov é estornada automaticamente (defense-in-depth — bug 2026-05-19).
- Modo entrada direta: 1 mov `origem_tipo` tipo `E` por item **direto na `localizacao_destino_id`**, com `origem_id=lote_id` e `origem_detalhes.entrada_direta=true`. Sem pendência.
- Em ambos: se `custo_unitario` informado, RPC `wms_inserir_movimentacao` recalcula `siso_custo_medio` (cache global por produto) por média ponderada, grava `custo_medio_anterior`/`custo_medio_posterior` na mov, e popula `empresa_compradora_id` + `fornecedor_id` na mov pra apuração por empresa via report.

**Response 200:** `{ ok: true, pendencia_ids: ["uuid", ...] | [], localizacao_recebimento_id: "uuid" | null, lote_id: "uuid", mov_ids: ["uuid", ...] }`. `pendencia_ids` vazio e `localizacao_recebimento_id=null` em modo entrada direta. Use `pendencia_ids` em modo padrão pra disparar `/api/wms/guarda/imprimir-lote` (impressão do maço pré-guarda), ou monte `linhas` a partir dos itens enviados em modo entrada direta.

### GET /api/wms/receber

Sugere localização de putaway. Heurística: SKU já com saldo no galpão → essa localização (prefere picking); senão tipo='recebimento'; fallback DEFAULT-PICKING. No fluxo 2 etapas a sugestão é só informativa no recebimento; a decisão final é feita em `/wms/guarda`.

**Query params:** `produto_id`, `empresa_id`, `galpao_id` (todos obrigatórios).

**Response 200:** `{ localizacao_id, codigo?, razao, locaisExistentes }`.

### GET /api/wms/saldo-recebimento-orfao

Detecta saldo fantasma em locs `tipo='recebimento'` que NÃO têm pendência de guarda ativa (`status ∈ {pendente, em_guarda}`). Cobre o estado órfão quando a pendência foi cancelada sem mover a peça pra prateleira — o saldo continua "preso" em RECEBIMENTO e ninguém vai endereçá-lo. Consumido pelo card de alerta amarelo na home `/wms` (P5).

**Auth:** `requireWarehouseAccess` (admin ou qualquer permissão de operação física de armazém).

**Query params:** `galpao_id` (opcional — quando ausente, agrega todos os galpões).

**Algoritmo:**
1. SELECT locs `siso_localizacoes WHERE tipo='recebimento' AND ativo=true` (filtra por galpão se informado).
2. SELECT saldos `siso_estoque WHERE localizacao_id IN (...) AND saldo > 0`.
3. SELECT pendências ativas `siso_wms_pendencias_guarda WHERE status IN ('pendente','em_guarda') AND localizacao_origem_id IN (...)` — agrega `qty_pendente` por `(produto_id, localizacao_origem_id)`.
4. Pra cada saldo, `orfao = saldo - pendente_total`. Retorna apenas onde `orfao > 0`.

**Response 200:** `{ itens: ItemOrfao[] }` onde
```ts
ItemOrfao = {
  produto_id: string;
  sku: string;
  descricao: string;
  galpao_id: string;
  localizacao_id: string;
  localizacao_codigo: string;
  saldo: number;
  pendente_total: number;
  orfao: number;
}
```

Galpão sem locs `recebimento` ou sem saldos retorna `{ itens: [] }` (200, não 404).

---

### Guarda (put-away — etapa 2/2)

Fila consumida no tablet. Operador imprime etiquetas → cola nas peças → leva pra loc destino → bipa o QR → confirma. Mov de guarda usa `origem_tipo='transferencia_localizacao'` (replenishment_intra) saindo de RECEBIMENTO. Custo médio da loc origem é propagado pra loc destino via `recalcularCustoMedio`.

#### GET /api/wms/guarda

Lista pendências. **Query:** `galpao_id?`, `status=pendente,em_guarda` (CSV, default ativas), `q?`, `limit=200`. *(Filtro `empresa_dona_id` removido em 2026-05-20 — coluna não existe mais na tabela.)*

**Response 200:** `{ rows: PendenciaJoined[] }` com produto/galpao/localizacao_origem populados.

#### GET /api/wms/guarda/[id]

Detalhe de uma pendência + sugestão de loc destino (filtrada — não sugere voltar pra RECEBIMENTO) + lista de locs onde o SKU já tem saldo (atalhos de UI).

**Response 200:** `{ pendencia, sugestao: { localizacao_id, codigo?, razao } | null, locais_existentes: [...] }`. O `pendencia` (via `obterPendencia`) traz o join `destino_sugerido` (`{ codigo, tipo }`) além de `localizacao_destino` — usado pelo tablet pra pré-preencher o destino **cross-dock** (PACKING) quando a pendência tem `prioridade='cross_dock'` e `localizacao_destino_id` nulo. Prioridade do prefill no form: override do operador → `localizacao_destino_id` → `destino_sugerido_id` (cross-dock) → `sugestao` dinâmica.

#### POST /api/wms/guarda/[id]/iniciar

Marca `status='em_guarda'`, registra `iniciada_em/por`. **Anti-race (P3 #5.2)** — agora usa
UPDATE condicional `WHERE status='pendente'` em vez de SELECT+UPDATE. Se dois operadores chegam
juntos na mesma pendência, só o 1º consegue: o 2º recebe **409 PENDENCIA_OUTRA_GUARDA**
(antes ambos passavam, gerando dupla guarda). Idempotente quando o caller já é o dono
(`iniciada_por=usuario_id`).

**Auth:** acesso de armazém. **Response 200:** `{ ok: true, pendencia }`. **400** se status terminal. **409** se outro operador já iniciou.

#### POST /api/wms/guarda/[id]/confirmar

Confirma a guarda (parcial ou total). **P3 #5.3 / #5.8** — agora invoca RPC atômica
`wms_confirmar_guarda_atomico` que faz S+E e atualização da pendência (`qty_guardada`,
`status` final) **dentro de uma transação SQL única**. Antes era TS multi-step (mov par via
RPC + UPDATE da pendência depois) — crash entre os steps deixava saldo movido mas pendência
não atualizada (estado fantasma). Se `qty == qty_pendente` zera, vira `guardada` e fixa
`guardada_em`. Senão fica `pendente` com saldo, próxima iteração zera.

**Body:** `{ qty: number>0, localizacao_destino_id: "uuid", gtin_bipado?: string, sku_bipado?: string, confirmar_manual?: boolean }`.

**Validação:** `qty <= qty_pendente`; loc destino existe + ativa + mesmo galpão + ≠ loc origem (validação dentro da RPC).

**Raio-X Fase 4 (P029) — cross-check do produto bipado.** Quando `gtin_bipado` ou `sku_bipado`
é informado, o produto bipado é confrontado com o produto da pendência; mismatch → **400**
(`produto bipado não bate`). `confirmar_manual: true` é o escape-hatch (pula o cross-check
quando o operador confirma manualmente, ex.: GTIN ausente no cadastro).

**Response 200:** `{ ok: true, pendencia, origem_id, totalmente_guardada: boolean, pedidos_separados: string[] }`. **400** em validação falha (inclui produto bipado divergente); **500** em erro de DB.

#### POST /api/wms/guarda/[id]/desfazer

**P3 #5.1** — Reverte uma confirmação de guarda (parcial ou total). Gera par S+E na direção
**inversa** da guarda original (S de `localizacao_destino` → E de `localizacao_origem`/RECEBIMENTO),
decrementa `qty_guardada`, e recupera status anterior (`pendente` se `qty_guardada` chega a 0,
`em_guarda` em caso contrário). Útil quando operador bipa loc errada.

**Auth:** `requireWarehouseAccess`. **Body:** `{ motivo: string (≥3 chars), qty?: number }`.

- `qty` opcional — default = toda a `qty_guardada` atual (desfaz tudo). **(Fix-Final B B10)**
- Quando `qty` é informado: desfazer parcial — `qty` deve ser `≤ qty_guardada` (400 caso contrário).
- Par S+E usa o mesmo `origem_id` UUID gerado na hora, permitindo rastreio das movs de desfazer juntas.

**Response 200:** `{ ok: true, qty_estornada, pendencia }`.
**400** se pendência cancelada, sem guardas registradas, motivo curto ou `qty > qty_guardada`.

> Para desfazer guardas intermediárias de uma pendência multi-step, repita o endpoint
> com a `qty` desejada até atingir o estado alvo.

#### POST /api/wms/guarda/[id]/cancelar

Tira a pendência da fila sem mover estoque (peça continua em RECEBIMENTO; saída física é fluxo separado — ajuste manual ou devolução fornecedor).

**Body:** `{ motivo: string (≥3 chars) }`.

**Response 200:** `{ ok: true, pendencia }`.

#### POST /api/wms/guarda/[id]/imprimir

Imprime N etiquetas (1 por unidade) pra essa pendência. Não muda status — reimprimir é seguro.

**Body:** `{ qty?: number, localizacao_codigo?: string }`. `qty` default = `qty_pendente` (clampado). `localizacao_codigo` default = melhor candidato de destino (loc com saldo>0 do mesmo SKU exceto RECEBIMENTO) ou `—`.

**Response 200:** `{ ok: true, jobId, totalEtiquetas, totalFolhas, printerId, printerNome, fallbackEnvelope }`. **502** se PrintNode falha.

#### POST /api/wms/guarda/imprimir-lote

Imprime o maço inteiro pra uma lista de itens (bulk). Usado pelo frontend de recebimento ao confirmar lote. Aceita dois modos de body (use **um** dos dois — informar os dois retorna 400):

**Modo guarda** — `{ pendencia_ids: string[] }`. Resolve sku/descricao/loc a partir das pendências em `siso_wms_pendencias_guarda`. Canceladas/zeradas/sem produto são puladas (voltam em `ignorados[]`). Se a pendência não tem loc destino decidida, usa como hint um candidato com saldo>0 do mesmo SKU (ou `—`).

**Modo entrada direta** — `{ linhas: [{ produto_id, galpao_id, qty, localizacao_id? }] }`. Resolve sku/descricao em `siso_produtos` e código da loc em `siso_localizacoes` (2 queries agregadas). Usado quando o recebimento foi feito em `entrada_direta=true` (sem pendências pra referenciar). `localizacao_id` opcional — se omitido, etiqueta mostra `—`.

Em ambos os modos, agrupa por `galpao_id` e dispara 1 print job por galpão (impressora pode ser diferente). Falha em algum galpão não aborta os outros.

**Response 200:** `{ ok: true, ignorados, jobs: [{ galpaoId, jobId, totalEtiquetas, totalFolhas, fallbackEnvelope }], erros: [{ galpaoId, error }], totalEtiquetas, totalFolhas, fallbackEnvelope }`. **502** se todos os jobs falharem. **400** se body inválido ou nenhum galpão pra imprimir.

### POST /api/wms/transferir-galpao

Transferência inter-galpão **neutra em empresa** (3D — refactor 2026-05-20). Galpões devem ser diferentes (caso contrário use `replenishment`).

**Request body:**
```json
{
  "galpao_origem_id": "uuid",
  "localizacao_origem_id": "uuid",
  "galpao_destino_id": "uuid",
  "localizacao_destino_id": "uuid",
  "itens": [{ "produto_id": "uuid", "qty": 10 }],
  "observacoes": "string?"
}
```

> Body **não tem mais `empresa_id`** desde 2026-05-20 — o estoque físico é único por (produto, galpão, loc) e a mov não carrega dona.

**Side effects:** Por item, 2 movs (S na origem + E no destino) com mesmo `origem_id` (uuid), `origem_tipo='transferencia_galpao'`. Custo médio global do produto (em `siso_custo_medio`) não muda — transferência é neutra em valor.

**Response 200:** `{ origem_id, transferencia_id, status: "em_transito" }`.

**Erros:** 400 se origem == destino.

### POST /api/wms/transferencias/[id]/receber

Recebe uma transferência em trânsito (galpão destino). Insere a leg E (entrada destino)
e seta `recebido_em`/`mov_entrada_id` em cada item, vira `status='recebida'`.

**P3 #8.10** — agora protegido por **claim lock** via UPDATE condicional
`WHERE recebimento_em_andamento_por IS NULL` (coluna nova `siso_transferencias_galpao.recebimento_em_andamento_por uuid`).
Dois operadores conferindo o mesmo header em paralelo: o 1º ganha, o 2º recebe
**409 TRANSFERENCIA_OUTRO_RECEBIMENTO** com `bloqueado_por`. Lock é limpo na conclusão ou em erro.

**Body:** `{ localizacao_destino_id: "uuid", itens: [{ produto_id, qty, localizacao_destino_id? }] }`.

**Response 200:** `{ ok: true, mov_entrada_ids: [...] }`. **409** se outro recebimento ativo.

### POST /api/wms/transferencias/[id]/desfazer-recebimento

**P3 #8.2** — Estorna apenas a leg E do recebimento, reseta itens (`mov_entrada_id=NULL`,
`localizacao_destino_id=NULL`), volta header pra `status='em_transito'`. A leg S (saída origem)
permanece — estoque continua em trânsito. Permite re-receber depois (mesmo header, talvez na loc certa).

**Raio-X Fase 4 (P067):** o caminho normal agora vai pela RPC atômica
`wms_desfazer_recebimento_transferencia` (estorno das legs E + reset de itens + reset do header
numa única tx — antes eram statements PostgREST separados sem tx). Idempotente: pula movs já
estornadas via guard `estorno_de`.

**Raio-X Fase 4 (P065) — preflight "quanto dá pra desfazer".** Antes de mexer em nada, valida
por item se o saldo da loc destino ainda cobre a qty recebida. Se algum item não cobre (parte do
estoque já saiu da loc destino) e `force` não foi passado → **409 `DESFAZER_PARCIAL_BLOQUEADO`**
com payload estruturado `{ error, bloqueados: [{ item_id, desfazivel, total }] }`. Passar
`force: true` no body desfaz só os itens que cobrem (caminho TS por-item, pula os bloqueados).

**Auth:** `requireWarehouseAccess`. **Body:** `{ motivo: string (≥3 chars), force?: boolean }`.

**Response 200:** `{ ok: true, movsEstornadas: number }`.
**400** motivo curto / transferência não está em `recebida`.
**409 `DESFAZER_PARCIAL_BLOQUEADO`** (com `bloqueados[]`) quando há itens cujo saldo não cobre e `force` é falso.

### POST /api/wms/transferencias/[id]/cancelar

Cancela transferência. **P3 #8.3** — agora aceita recebimentos parciais:
- Se nenhum item foi recebido (todas as movs E ausentes), estorna apenas as movs S e marca `status='cancelada'`.
- Se alguns itens já foram recebidos, retorna **400** apontando pra `/desfazer-recebimento`
  (operador desfaz recebimento primeiro, depois cancela).

**Auth:** `requireWarehouseAccess`. **Response 200:** `{ ok: true, movs_estornadas: number }`.
**400** com mensagem indicando próximo passo se recebimento ainda ativo.

### POST /api/wms/replenishment

Movimenta entre localizações **dentro do mesmo galpão** (3D — refactor 2026-05-20). Antes era escopado por empresa+galpão; agora apenas galpão.

**P3 #5.8 / #8.8** — Implementação migrada pra RPC SQL atômica `wms_replenishment_intra_galpao`
(insere S+E numa transação única). Antes era TS multi-step que podia deixar a leg S aplicada
e a leg E falhada (saldo "evaporava"). Agora é tudo ou nada.

**Request body:**
```json
{
  "galpao_id": "uuid",
  "localizacao_origem_id": "uuid",
  "localizacao_destino_id": "uuid",
  "itens": [{ "produto_id": "uuid", "qty": 10 }],
  "observacoes": "string?"
}
```

**Side effects:** 2 movs (S+E) com `origem_tipo='transferencia_localizacao'` e mesmo `origem_id`. Neutro em empresa.

**Response 200:** `{ ok: true, origem_id, mov_saida_id, mov_entrada_id }`.

**Erros:** 400 se origem_loc == destino_loc, 400 se saldo insuficiente, 500 em erro RPC.

### POST /api/wms/replenishment/[id]/reverter

**P3 #8.8** — Reverte um replenishment intra-galpão. **`[id]` aqui é o `origem_id` (uuid)
compartilhado pelas duas movs S+E** — não há header próprio. Capturado na resposta do POST anterior.

**Auth:** `requireWarehouseAccess`. **Body:** `{ motivo: string (≥3 chars) }`.

**Side effects:** Estorna ambas as legs (S origem + E destino) via `estornarMovimentacao`.
Idempotente — chamadas repetidas pulam movs já estornadas (`estorno_de IS NOT NULL`).

**Response 200:** `{ ok: true, movsEstornadas: number, movsJaEstornadas: number }`.
**400** se origem_id não encontra movs.

### POST /api/wms/ajuste

Ajuste manual de estoque (avaria, perda, encontro, erro de contagem). **`motivo` agora é obrigatório** (3D — refactor 2026-05-20).

**Request body:**
```json
{
  "tripla": { "produto_id", "galpao_id", "localizacao_id" },
  "qty": 5,
  "direcao": "entrada | saida",
  "motivo": "avaria caixa amassada"
}
```

> Campo renomeado `quadrupla` → `tripla`; `empresa_dona_id` removido (não é mais coordenada).

**Validação:** `motivo.trim().length >= 3` (era opcional, agora obrigatório). Mov gravada com `origem_tipo='ajuste_manual'`, motivo em `siso_movimentacoes.motivo` (coluna nova) + `observacoes`.

**Response 200:** `{ ok: true, mov_id }`.

### POST /api/wms/ajuste/[id]/estornar

**P3 #3.20** — Estorna uma mov de ajuste manual. **`[id]` é o `mov_id`** retornado pelo POST acima.

**Auth:** `requireWarehouseAccess`. **Body:** `{ motivo: string (≥3 chars) }`.

**Defesa:** valida que `origem_tipo='ajuste_manual'` antes de estornar (recusa estornar movs
de outras origens por aqui — cada origem tem seu endpoint reverse próprio). Idempotente —
double-estorno é bloqueado por guard `estorno_de IS NOT NULL` em `estornarMovimentacao`.

**Response 200:** `{ ok: true }`. **400** se mov não encontrada, não é ajuste_manual,
já foi estornada, ou já é em si um estorno.

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

**Auth:** Session + `userCan(session, "operacoes.retroativo")` (403 caso contrário).

**Request body:** `{ "compra_mov_id": "uuid", "qty_estorno"?: number }` (`compra_mov_id` anotada em `observacoes`).

**`qty_estorno` (Raio-X Fase 5 P147):** opcional. Ausente/`null` → estorno default (clamp = `min(qty_original, disponível atual)`). Presente porém não-finito ou `<= 0` → **400**. Permite estorno **parcial** clampado ao disponível; a RPC grava `qty_original` vs `qty_estornada` + flag `parcial` em `origem_detalhes`.

**Idempotência + lock (Fase 5 P150/P152):** a RPC `wms_reconciliar_retroativo` trava a mov retroativo com `FOR UPDATE` (serializa 2 operadores) e, se já existe estorno apontando pro retroativo, é **no-op idempotente** (responde sucesso). Duplo-clique e reclique tardio respondem 200.

**P3 #8.6** — agora valida `[id]` e `compra_mov_id` como UUIDs antes de chamar a RPC (regex
`/^[0-9a-f-]{36}$/i`), e valida que ambas as movs existem antes de inserir o estorno. Bug:
sem essas validações um caller podia passar `null`/string vazia/uuid inexistente e a RPC
levantava 23502/23503 com mensagens crípticas.

**Side effects:** 1 mov `origem_tipo='estorno'`, `tipo='S'`, `qty=clamp(qty_estorno, disponível)`, `estorno_de=retro.id`.

**Response 200:** `{ ok: true, qty_estornada, parcial }` (ou `{ ok: true, idempotente: true, mensagem }` no no-op).

**Status-code mapping:**
- `200` — sucesso ou já-reconciliado (idempotente).
- `400` — uuid inválido, `qty_estorno` inválido, ou mov não é retroativo.
- `404` — `compra_mov_id` não existe em `siso_movimentacoes`.
- `409` — sem saldo disponível pra estornar (mensagem "sem saldo disponível").

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

### Empréstimos API (REMOVIDA em 2026-05-20)

> Os endpoints `/api/wms/emprestimo-regras/*` e `/api/wms/emprestimos/saldos` foram **removidos** com o ledger simplificado 3D. Empresa não é mais coordenada física, não há débito/crédito entre empresas. Para apuração por empresa, use os reports em `/api/wms/relatorios/*` (ver seção "WMS — Relatórios" abaixo).

### POST /api/wms/rotear
Testa o algoritmo (debug + integração futura).

**Body:** `{ empresa_vendedora_id, itens: [{ produto_id, qty }] }`.

**Response 200:** `RotaResult`:
- `{ decisao: 'propria', galpao_id, rotas: [{ produto_id, qty, galpao_id, localizacao_id }] }` *(decisão `emprestimo` removida em 2026-05-20)*
- ou `{ decisao: 'oc', motivo: 'sem_cobertura' | 'split_galpoes' }`

### GET /api/wms/reservas/cleanup
Cron-friendly. **Auth:** `x-worker-secret`. Insere mov L pra reservas com `expira_em < now()` que ainda não foram liberadas. Marca `siso_pedidos.status_alerta='reserva_expirada'`.

**Response 200:** `{ total, liberadas, erros }`.

---

## WMS — Inventário (Plano 4)

### GET /api/wms/inventario
Lista sessões. Query: `status`, `galpao_id`.

### POST /api/wms/inventario
Cria sessão (v2 — pool compartilhado + party dinâmica de operadores, sem cap rígido).

**Body (3D — refactor 2026-05-20):** `{ tipo: 'cycle_count'|'completo', galpao_id, nome?, modo_contagem?: 'blind'|'aberto', tolerancia_pct?, tolerancia_qty_min?, exige_aprovacao_acima_valor?, observacoes?, localizacoes: [{ localizacao_id, motivo? }] }`.

> Body **não tem mais `empresa_dona_id`** desde 2026-05-20 — sessão escopa por galpão+locs, não por dona.

Defaults: blind, 2%, R$1000.

### GET /api/wms/inventario/[id]
Detalhe consolidado: `{ sessao, operadores, localizacoes, contagens, divergencias }` (5 queries paralelas).

### POST /api/wms/inventario/[id]/party
Operador entra na party. **Auth:** `requireWarehouseAccess`. Body vazio.

Auto-inicia a sessão se `status='planejada'`. Idempotente — re-chamar pro mesmo usuário é no-op (retorna `retomado=false`). Quando o usuário já tinha um registro (após `sairParty` prévia), reativa: zera `finalizado_em`, seta `ultima_reentrada_em`, preserva `locs_contadas` (retorna `retomado=true`).

**Response 200:** `{ ok: true, retomado: boolean }`.

### DELETE /api/wms/inventario/[id]/party
Operador sai da party. **Auth:** `requireWarehouseAccess`. Body vazio.

Marca o operador como `finalizado_em=now()`. Não cancela contagens já feitas. Locs em `em_contagem` ficam até o cleanup cron liberar.

**Response 200:** `{ ok: true }`.

### PATCH /api/wms/inventario/[id]
Update genérico de campos da sessão.

**P3 #4.7** — Mudança de `modo_contagem` (`blind` ↔ `aberto`) só é permitida com `status='planejada'`.
Tentar trocar após `em_andamento`/`revisao`/`aprovada`/`aplicada` retorna **409 MODO_LOCKED**
(operadores já estão bipando sob um modo, trocar mid-flow corromperia a comparação).
Outros campos (`nome`, `tolerancia_pct`, etc.) continuam editáveis.

### DELETE /api/wms/inventario/[id]
Cancela (status=cancelada) e libera todos os locks da sessão.

**P3 #4.4** — Retorna **409** se `status='aplicada'`. Sessão aplicada já gerou movs no ledger;
o caminho correto pra reverter é `POST /api/wms/inventario/[id]/estornar`. Status `revisao`,
`aprovada`, `em_andamento`, `planejada` permanecem deletáveis (cancelam normalmente).

### POST /api/wms/inventario/[id]/iniciar
Cria locks em `siso_localizacao_locks` (motivo='cycle_count') e muda status pra `em_andamento`. **400** se sessão não está em 'planejada'.

### POST /api/wms/inventario/[id]/aprovar
Computa divergências + aprova sessão. **400** se há divergências `pendente`.

**P3 #4.5 / #4.6** — Agora avisa se há operadores ativos (`siso_inventario_operadores`
com `finalizado_em IS NULL`): por default retorna **409 OPERADORES_ATIVOS** com lista
`operadores_ativos[]`. Caller pode forçar via `force: true` no body (caso supervisor decida
encerrar mesmo com gente bipando). `computarDivergencias` agora limpa operadores órfãos
(finaliza quem ficou stale) antes de gerar divergências.

**Body (opcional):** `{ parcial?: boolean, force?: boolean }`.
- `parcial=false` (default): comportamento histórico — todas as locs do pool são consideradas. Locs com saldo>0 que ninguém bipou viram divergência qty=0.
- `parcial=true`: só processa locs com status `contada`/`aprovada`. Locs `pendente`/`em_contagem` são puladas (não geram divergência; estoque do sistema mantido). Use quando o supervisor quer encerrar antes de terminar todo o pool e descartar o que não foi contado.
- `force=true`: ignora 409 OPERADORES_ATIVOS e prossegue mesmo assim (finalizando operadores ativos).

**Response 200:** `{ ok: true, parcial: boolean }`. **409 OPERADORES_ATIVOS** quando aplicável (com `{ operadores_ativos: [{ usuario_id, usuario_nome }] }`).

### POST /api/wms/inventario/[id]/aprovar-sessao
Idem `aprovar` mas pra sessão inteira (todas as locs em uma chamada). Mesmo comportamento P3 — aceita `force: true` para bypass do guard `OPERADORES_ATIVOS`.

### POST /api/wms/inventario/[id]/aplicar
Gera movs `origem_tipo='inventario'` no ledger pra cada divergência aprovada (E ou S conforme delta). Marca divergências como `aplicada` e libera locks.

**P3 #4.1 — idempotente.** Migration `20260527_p3_movs_unique_inventario_divergencia.sql`
adiciona UNIQUE partial index `uniq_movs_inventario_divergencia` em `siso_movimentacoes` (`origem_id`, `origem_tipo`)
WHERE `origem_tipo IN ('inventario_perda','inventario_ganho')`. Aplicar 2× em paralelo: o 2º bate na UNIQUE e
recebe **409 SQLSTATE 23505** que é traduzido em ConflictError com `{ code: "DIVERGENCIA_JA_APLICADA", divergencia_id }`.
Resposta: pula a div já aplicada e segue com as outras. No fim, retorna `movsGeradas` real + `divsJaAplicadas` count.

**Response:** `{ ok: true, movsGeradas, divsJaAplicadas }`.

### POST /api/wms/inventario/[id]/estornar

**P3 #4.2 — Admin-only.** Reverte uma sessão `status='aplicada'`. Para cada divergência
`aplicada` (com `mov_aplicada_id` não-null), insere mov de estorno via `estornarMovimentacao`
e volta divergência pra `status='pendente'` (`mov_aplicada_id=NULL`). Sessão volta pra `status='revisao'`.

**Raio-X Fase 4 (P056/P061):** o estorno de sessão agora vai pela RPC tudo-ou-nada
`wms_estornar_sessao_inventario` (preflight de saldo de todas as contra-movs antes de inserir
qualquer uma — se alguma negativaria, RAISE nomeando o SKU + loc → rollback total). A
mensagem `"deixaria saldo negativo"` é mapeada pra **409**.

**Raio-X Fase 4 (P159) — estorno de divergência individual.** Body aceita `divergencia_id`
opcional: quando presente, estorna **uma única** divergência (via `estornarDivergenciaInventario`)
em vez da sessão inteira. Resposta inclui `individual: true`.

**Auth:** `requireAdmin`. **Body:** `{ motivo: string (≥3 chars), divergencia_id?: uuid }`.

**Idempotente:** re-chamada em sessão já estornada (status='revisao') é no-op. Re-execução durante
estorno pula movs já estornadas via guard `estorno_de IS NOT NULL`.

**Response 200:** `{ ok: true, movsEstornadas, divergenciasRevertidas }` (sessão) ou
`{ ok: true, individual: true, ... }` (divergência individual). **400** motivo curto / sessão não
está em `aplicada`. **409** se o estorno deixaria saldo negativo.

### POST /api/wms/inventario/[id]/contagens
Registra contagem. **Body (3D — refactor 2026-05-20):** `{ localizacao_id, produto_id, qty_contada, modo? }`. *Campo `empresa_dona_id` removido — bipe é por tripla (produto, galpão da sessão, loc).*
- `modo='incremental'` (default): soma na contagem do operador (cada bipe = +qty).
- `modo='absoluto'`: substitui contagem prévia.

**P3 #4.3 — lock obrigatório.** Antes de gravar, valida que a loc está bloqueada pelo
caller (`siso_inventario_localizacoes.bloqueada_por = usuario_id`). Sem lock retorna
**409 LOC_NAO_BLOQUEADA**. Bloqueio é adquirido via `POST /api/wms/inventario/[id]/proxima-loc`
(pull queue) ou `POST .../localizacoes/[locId]/bloquear`. Mesma tripla por outro operador
continua suportando duplo-blind, mas o segundo precisa adquirir o lock primeiro (sequencial).

### POST /api/wms/inventario/[id]/localizacoes/[locId]/bloquear
Pega localização atomicamente (RPC). **409** se já bloqueada por outro operador.

### DELETE /api/wms/inventario/[id]/localizacoes/[locId]/bloquear
Libera lock. Status='contada'.

### GET /api/wms/inventario/[id]/divergencias
Lista divergências da sessão. Query: `status`.

### PATCH /api/wms/inventario/[id]/divergencias
Atualiza status de divergências em lote (single-id é caso particular com `[id]`).

**Auth:** `requireWarehouseAccess`
**Body:** `{ divergencia_ids: string[], acao: 'aprovar'|'rejeitar', observacoes? }`
**Response:** `{ ok: true, atualizadas: number }`

Defesas: o UPDATE filtra por `sessao_id` (impede IDs de outra sessão) e `status='pendente'` (idempotente — re-aplicar é no-op). `atualizadas` pode ser menor que `divergencia_ids.length` se algum ID já não estava pendente.

### GET /api/wms/inventario/metricas
RPCs: acuracidade por operador (30d) + por localização (5000 últimas).

### GET /api/wms/inventario/[id]/eventos

**Auth:** `requireWarehouseAccess`
**Query params:** `limit` (default 50, max 200)

**Response:**
```json
{
  "eventos": [
    {
      "id": "uuid",
      "cor": "verde|amarelo|vermelho",
      "tipo": "E|S|R|L",
      "origem_tipo": "nf_venda|recebimento|inventario|...",
      "origem_id": "string|null",
      "loc_codigo": "A-01-3",
      "sku": "001233",
      "descricao": "MASCARA AC FORD FIESTA",
      "quantidade": 1,
      "saldo_anterior": 1,
      "saldo_posterior": 0,
      "criado_em": "2026-05-18T18:10:36Z"
    }
  ]
}
```

**Classificação:**
- verde: contagem normal (origem=inventario) ou mov em loc ainda em jogo
- amarelo: mov em loc não visitada ou em janela contagem_iniciada → contagem_finalizada
- vermelho: mov em loc já visitada (contagem_finalizada_em < criado_em) — sistema reconcilia

**Business logic:** lista as N últimas movs **restritas ao pool de localizações da sessão** (`siso_inventario_localizacoes.localizacao_id`), criadas desde `iniciada_em`. Movs em locs fora da sessão são ignoradas — não fazem parte do escopo do inventário. Usado pelo painel ao vivo do supervisor.

### GET /api/wms/inventario/cleanup
Cron-friendly. Auth: `x-worker-secret`. Detecta:
1. Sessões inativas há 4h+ (apenas log warn);
2. Locks `em_contagem` com 30min+ sem contagem nova → libera (status volta a `pendente`);
3. Operadores ativos zumbi (`finalizado_em IS NULL` + `ultima_acao_em > 30min`) → força `finalizado_em` e libera qualquer loc `em_contagem` que o operador ainda detém;
4. Locks `em_contagem` cuja `bloqueada_por` já está finalizado (sair-party não limpou) → libera via RPC `wms_locks_bloqueada_por_finalizado`.

**Response:** `{ sessoesAlerta: string[], locksLiberados: number, operadoresFinalizados: number, locksLiberadosPorFinalizado: number }`.

---

## WMS — Exceções e dashboards (Plano 5)

### GET /api/wms/devolucoes
Lista devoluções aguardando classificação física. **Response:** `{ rows: [...] }`.

### GET /api/wms/devolucoes/[id] (P5)
Detalhe consolidado de 1 devolução pendente. Reutilizado pela página `/wms/devolucoes/[id]`
quando a fila filtrada não tem mais a linha (status≠`aguardando_classificacao`).
**Auth:** sessão (X-Session-Id).
**Response 200:** `{ devolucao: { id, status, nota_fiscal_id, chave_acesso_nf, criado_em, classificacao, classificada_em, payload_webhook, empresa_receptora: { id, nome }|null } }`.
**Nota:** `empresa_receptora` é a empresa **receptora física** (quem recebeu a NF de devolução no galpão); NÃO é a vendedora original — alinha com P2 #6.5.
**Erros:** 401 sem sessão, 404 quando `id` não existe (`PGRST116`), 500 com mensagem do banco.

### POST /api/wms/devolucoes/[id]/desclassificar

**P3 #6.3** — Reverte classificação anterior estornando todas as movs geradas por
`classificarDevolucao`. Devolução volta pra `aguardando_classificacao` permitindo re-classificação imediata
(útil quando operador escolheu classificação errada).

**Lookup de movs — determinístico via FK (Fix-Final B B9):** busca `SELECT id FROM siso_movimentacoes WHERE devolucao_id = $id`. Substitui a janela temporal ±60s anterior (que era frágil em sistemas com clock drift ou múltiplas classificações próximas). Cada mov vinculada à devolução é estornada individualmente via `wms_estornar_parcial_movimentacao`.

> **Retrocompat:** movs criadas antes de `20260528_movs_devolucao_id.sql` têm `devolucao_id = NULL`. Desclassificar uma devolução antiga retorna `movsEstornadas: 0` — esses registros históricos já foram resolvidos operacionalmente. **Sem fallback** pra janela temporal: a versão antiga era frágil (clock drift, classificações próximas) e foi removida com T11/B9.

**Auth:** `requireWarehouseAccess`. **Body:** `{ motivo: string (≥3 chars) }`.

**Response 200:** `{ ok: true, movsEstornadas, classificacao_anterior }`.
**400** se devolução não está em `classificada`.

### POST /api/wms/devolucoes/[id]/classificar
**Body (3D — refactor 2026-05-20):** `{ classificacao: 'A'|'B'|'C'|'D', produto_id, qty, galpao_id, localizacao_id, empresa_referencia_id?, fornecedor_id?, observacoes? }`.

> `empresa_dona_destino_id` foi renomeado pra `empresa_referencia_id` (apenas tag na mov, não muda coordenada física) e `fornecedor_id` foi adicionado (necessário pra classificação D / RMA). Classificação A/B/C/D substitui os nomes antigos integro/avariado/garantia/troca_sku.

**Side effects por classificação:**
- `A` (íntegro): E `devolucao_cliente_integra` + RPC recalcula `siso_custo_medio` (média ponderada). `empresa_referencia_id` populado.
- `B` (avariado): E `devolucao_cliente_avariada` + transferência interna pra QUARENTENA. Custo médio NÃO recalcula.
- `C` (garantia): E `devolucao_cliente_integra` + S `devolucao_fornecedor_enviada` (RMA) com `fornecedor_id` populado em ambas.
- `D` (troca SKU): E `devolucao_cliente_integra` (a troca real é feita no SISO por enquanto).

**Auth:** sessão válida + `userCan('operacoes.devolucoes_classificar')` (403 caso contrário).

**Raio-X Fase 4 (P049/P050/P051/P054):** o caminho agora vai pela RPC atômica e serializada
`wms_classificar_devolucao` — `FOR UPDATE` na devolução + N movs + UPDATE de status numa única tx
(tudo-ou-nada), com back-fill de `devolucao_id` nas movs criadas. **Idempotente:** devolução já
classificada (status `<> aguardando_classificacao`) → no-op. **Erros:**
- **409** em concorrência/lock (`já classificada` / `em classificação` / `could not obtain lock` / `deadlock`).
- **400** preflight de quarentena (avariado num galpão sem localização tipo `quarentena` → bloqueia antes de mover), `garantia` sem `fornecedor_id`, `qty <= 0`, devolução não encontrada e demais validações.

### GET /api/wms/cobertura
Lista linhas da matview de cobertura. **Query:** `status` (critico|atencao|ok|sem_giro|lead_time_risco), `galpao_id`. Limit 500, ordenado por dias_cobertura asc.

### GET /api/wms/cobertura/refresh
Cron-friendly diário 03h. **Auth:** `x-worker-secret`. Chama RPC `wms_refresh_cobertura()`.

### GET /api/wms/dashboard-geral
Agrega contadores cross-módulo numa resposta única (refetch 30s no client).

**Response (3D — refactor 2026-05-20):**
```json
{
  "cobertura": { "critico": 5, "atencao": 12, "ok": 200, "sem_giro": 8, "lead_time_risco": 3 },
  "inventario": { "sessoesAtivas": 1, "divergenciasPend": 0, "locksAntigos": 0 },
  "reservas": { "expiraEm6h": 2 },
  "retroativosOrfaos": 0
}
```

> Contador `emprestimos.paresComSaldo` removido em 2026-05-20 — empréstimo entre empresas foi arquivado.

---

### `GET /api/wms/dashboard-tarefas`

Retorna o estado das 6 filas operacionais que o quadro de tarefas pendentes da home `/wms` exibe.

**Auth:** sessão válida (`X-Session-Id`).

**Query string:**

| Param | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `galpao_id` | uuid | não | Quando ausente, agrega todos os galpões. Quando presente, filtra pedidos (`separacao_galpao_id`), guarda (`galpao_id`) e inventário (`galpao_id`). Compras é cross-galpão sempre. |

**Resposta 200:**

```json
{
  "galpao_id": "uuid-or-null",
  "aprovacao":  { "count": 0, "marketplace": 0, "manual": 0 },
  "separacao":  { "count": 0, "executores": [{ "id": "uuid", "nome": "…", "foto_url": "…|null" }] },
  "embalagem":  { "count": 0, "executores": [] },
  "guarda": {
    "count": 0,
    "executores": [],
    "itens": [
      {
        "id": "uuid",
        "produto_sku": "EW123",
        "produto_descricao": "string|null",
        "qty_pendente": 5,
        "qty_inicial": 10,
        "status": "pendente|em_guarda",
        "iniciada_por": { "id": "uuid", "nome": "…", "foto_url": "…|null" },
        "criada_em": "ISO",
        "galpao_nome": "string|null"
      }
    ]
  },
  "compras": {
    "aComprar": 0,
    "aReceber": 0,
    "fornecedores": [
      { "fornecedor": "Tiger", "a_comprar": 3, "a_receber": 1 }
    ]
  },
  "inventario": {
    "sessoesAtivas": 0,
    "executores": [],
    "ciclos": [
      {
        "id": "uuid",
        "nome": "string",
        "tipo": "cycle_count|completo",
        "galpao_nome": "string|null",
        "locs_total": 120,
        "locs_contadas": 48,
        "locs_pendentes": 72,
        "progresso_pct": 40,
        "iniciada_em": "ISO|null",
        "operadores": [{ "id": "uuid", "nome": "…", "foto_url": "…|null" }]
      }
    ]
  },
  "excecoes": {
    "devolucoes": {
      "count": 0,
      "itens": [
        { "id": "uuid", "nota_fiscal_id": 12345, "empresa_referencia_nome": "string|null", "criada_em": "ISO" }
      ]
    },
    "transferencias_transito": {
      "count": 0,
      "itens": [
        { "id": "uuid", "origem_galpao_nome": "CWB", "destino_galpao_nome": "SP", "criada_em": "ISO", "qty_itens": 12 }
      ]
    },
    "inventario_revisao": {
      "count": 0,
      "itens": [
        { "id": "uuid", "nome": "Cycle … 26/05", "galpao_nome": "CWB", "total_divergencias": 4, "criado_em": "ISO" }
      ]
    },
    "reservas_orfas": {
      "count": 0,
      "itens": [
        { "id": "uuid (mov_id)", "pedido_id": "string", "pedido_numero": "string|null", "produto_sku": "string", "qty": 5, "criada_em": "ISO" }
      ]
    },
    "retroativos": {
      "count": 0,
      "itens": [
        { "id": "uuid (mov_id)", "produto_sku": "string", "qty": 10, "criado_em": "ISO", "motivo": "string" }
      ]
    },
    "recebimento_orfao": {
      "count": 0,
      "itens": [
        { "produto_id": "uuid", "produto_sku": "string", "galpao_id": "uuid", "galpao_nome": "string|null", "localizacao_codigo": "RECEBIMENTO", "saldo": 5 }
      ]
    }
  }
}
```

**Headers:** `Cache-Control: no-store` (evita cache no CDN).

**Side effects:** nenhum (read-only).

**Notas:**
- `aprovacao.marketplace + aprovacao.manual === aprovacao.count` é invariante (P5). `manual` filtra `origem_pedido === "manual"`; o resto é marketplace.
- `excecoes` (P5) reúne 6 filas de pendência fora do pipeline normal. Os contadores são absolutos e os arrays vêm truncados em `MAX_DETALHE_POR_SECAO=50`. Cada filtro respeita `galpao_id` quando aplicável (devoluções e reservas órfãs são cross-galpão; transferências filtra por destino).
- `reservas_orfas` faz 2 queries (Rs ativas + estornos recentes) e intersecta no app — `pedido_id` em `siso_movimentacoes` é text sem FK, então o JOIN é manual.
- `recebimento_orfao` é dock RECEBIMENTO com saldo > 0 e sem pendência viva em `siso_wms_pendencias_guarda`. Detecta posições "esquecidas" após cancelamento de guarda (P6 deve refinar a heurística).
- `executores` em Separação = `separacao_operador_id` de pedidos em `em_separacao`.
- `executores` em Embalagem = `embalagem_operador_id` quando setado.
- `executores` em Guarda = `iniciada_por` de pendências em `em_guarda`.
- `executores` em Inventário = `siso_inventario_operadores` ativos (party) das sessões em andamento.
- `guarda.itens` é truncado em 50 cards (cards adicionais ficam na tela `/wms/guarda`). `guarda.count` reflete o total real.
- `inventario.ciclos[].progresso_pct` = `locs_contadas / locs_total * 100`, onde "contada" = `siso_inventario_localizacoes.status NOT IN ('pendente','em_contagem')`.
- `compras.fornecedores` agrupa por `siso_pedido_itens.fornecedor_oc` (a comprar) e `siso_ordens_compra.fornecedor` (a receber); valores nulos viram `"Sem fornecedor"`. Ordenado por total desc, depois alfabético.
- Compras "a receber" usa `siso_ordens_compra.status IN ('comprado', 'parcialmente_recebido')`.
- Aprovação e Compras não têm executor (são filas de espera).

---

## WMS — Mini-Swap / Swap (REMOVIDO em 2026-05-20)

> Endpoints `/api/wms/mini-swap/config[*]`, `/api/wms/mini-swap/simular`, `/api/wms/swap/detectar` e `/api/wms/swap/executar` foram **removidos** com o ledger simplificado 3D. Empresa não é mais coordenada física, não há mais o que swappear. Frontend `/wms/configuracoes/otimizacoes` também foi removido. Código TypeScript preservado em `src/lib/wms/_archive/`.

---

## WMS — Relatórios (novo em 2026-05-20)

Com o ledger simplificado, apuração por empresa virou **report sobre tags em movs** em vez de coordenada física. 3 endpoints novos, todos read-only.

### GET /api/wms/relatorios/movs-por-empresa

**File:** `src/app/api/wms/relatorios/movs-por-empresa/route.ts`

**Purpose:** Lista movs filtradas por uma das três tags de empresa.

**Auth:** X-Session-Id (required)

**Query params:**
- `empresa_id` (required) — empresa alvo
- `tipo` (required) — `compradora` | `vendedora` | `referencia` (qual coluna FK filtrar)
- `desde`, `ate` — intervalo ISO 8601
- `origem_tipo` — filtra por enum de origem
- `limit` (default 200, max 1000)

**Response (200):**
```json
{
  "rows": [
    {
      "id": "uuid",
      "criado_em": "ISO",
      "tipo": "E|S|R|L",
      "origem_tipo": "string",
      "produto_sku": "string",
      "produto_descricao": "string",
      "galpao_nome": "string",
      "localizacao_codigo": "string",
      "quantidade": 10,
      "custo_unitario": 12.5,
      "empresa_compradora_nome": "string|null",
      "empresa_vendedora_nome": "string|null",
      "empresa_referencia_nome": "string|null",
      "fornecedor_nome": "string|null"
    }
  ]
}
```

**Side Effects:** None.

---

### GET /api/wms/relatorios/historico-custo

**File:** `src/app/api/wms/relatorios/historico-custo/route.ts`

**Purpose:** Série temporal de custo médio por produto, reconstruída a partir de `custo_medio_anterior` → `custo_medio_posterior` nas movs de entrada com `custo_unitario`.

**Auth:** X-Session-Id (required)

**Query params:**
- `produto_id` (required)
- `desde`, `ate` — intervalo ISO 8601 (default últimos 90 dias)

**Response (200):**
```json
{
  "produto": { "id": "uuid", "sku": "string", "descricao": "string" },
  "custo_atual": 12.5,
  "atualizado_em": "ISO",
  "serie": [
    {
      "mov_id": "uuid",
      "criado_em": "ISO",
      "origem_tipo": "nf_compra",
      "quantidade": 50,
      "custo_unitario": 11.0,
      "custo_medio_anterior": 10.0,
      "custo_medio_posterior": 10.8,
      "empresa_compradora_nome": "string|null",
      "fornecedor_nome": "string|null"
    }
  ]
}
```

**Side Effects:** None.

---

### GET /api/wms/relatorios/saldos-por-empresa

**File:** `src/app/api/wms/relatorios/saldos-por-empresa/route.ts`

**Purpose:** Recompõe saldo "virtual" por empresa a partir das tags em movs. **Não é coordenada física** — é um corte contábil pra apuração de NF: Σ entradas com `empresa_compradora_id=X` − Σ saídas com `empresa_vendedora_id=X` (estornos descontados).

**Auth:** X-Session-Id (required)

**Query params:**
- `empresa_id` (required) — empresa alvo
- `galpao_id` — opcional, filtra por galpão
- `produto_id` — opcional, filtra por produto

**Response (200):**
```json
{
  "rows": [
    {
      "produto_id": "uuid",
      "produto_sku": "string",
      "produto_descricao": "string",
      "saldo_virtual": 42,
      "entradas": 100,
      "saidas": 58
    }
  ],
  "total_skus": 1
}
```

**Side Effects:** None.

**Notes:**
- Cálculo é caro (full scan filtrado de `siso_movimentacoes`). Limit no client/UI.
- Saldo virtual ≠ saldo físico (que é em `siso_estoque` por galpão+loc). Útil pra contabilidade fiscal.

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
- Some endpoints use `.limit(N)` to cap results

### Auth

- Most endpoints require `X-Session-Id` header (except webhooks, oauth callbacks)
- Session is validated via `getSessionUser()` in `src/lib/session.ts`
- If session invalid: return `{ error: "sessao_invalida" }` with status 401

### Timestamps

- All ISO 8601 format (e.g., `2026-03-25T14:30:00Z`)
- BRT timezone is the canonical timezone for date math in dashboards

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
