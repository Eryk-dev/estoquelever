# PRD 4/7 — Separação: API de Separação (Bip, Lista, Undo, Expedir)

**Depende de:** PRD 1 (Schema + função PL/pgSQL), PRD 2 (Sessão server-side)
**Bloqueia:** PRD 5 (Frontend Separação)

---

## 1. Introdução

Este PRD implementa os endpoints da API de separação: listar pedidos, processar bip (scan), desfazer bip, marcar como expedido, e forçar pendente. Todos os endpoints exigem sessão server-side (PRD 2) e operam sobre o schema criado no PRD 1.

### Problema que resolve

- Frontend precisa de API para exibir pedidos por galpão
- Bip precisa ser processado atomicamente no servidor (não no client)
- Operador precisa de undo para corrigir erros sem chamar admin

---

## 2. Goals

- API completa para o frontend de separação consumir
- Bip atômico via `supabase.rpc('siso_processar_bip')`
- Isolamento por galpão enforced no servidor
- Desfazer bip funcional
- Todos endpoints protegidos por sessão server-side

---

## 3. User Stories

### US-003: Scan de itens por SKU/GTIN (API)

**Description:** Como operador, quero bipar o código de barras (GTIN) ou digitar o SKU de cada item para confirmar que separei o produto correto.

**Acceptance Criteria:**
- [ ] `POST /api/separacao/bipar` recebe `{ codigo }` (usuario_id e galpao_id derivados da sessão via header `X-Session-Id`)
- [ ] Chama `supabase.rpc('siso_processar_bip', { p_codigo, p_usuario_id, p_galpao_id })`
- [ ] Retorna response conforme contrato:
  - `200 { status: "parcial", pedido_id, pedido_numero, sku, bipados, total, itens_faltam }`
  - `200 { status: "item_completo", pedido_id, pedido_numero, sku, itens_faltam }`
  - `200 { status: "pedido_completo", pedido_id, pedido_numero, etiqueta_status: "pendente" }`
  - `404 { error: "item_nao_encontrado", codigo }`
  - `409 { error: "item_ja_completo", pedido_id, sku }`
- [ ] Rate limiting: máximo 2 bips/segundo por sessão
- [ ] Sessão inválida retorna 401
- [ ] Typecheck/lint passes

---

### US-011: Rastreio de bips por item (API)

**Description:** Como sistema, preciso expor o estado de bips no endpoint de listagem.

**Acceptance Criteria:**
- [ ] `GET /api/separacao` retorna pedidos do galpão do operador com itens e estado de bips
- [ ] Query params: `status` (filtro por `status_separacao`: `aguardando_nf`, `pendente`, `em_separacao`, `embalado`, `expedido`)
- [ ] Response inclui para cada pedido: `id`, `numero`, `cliente`, `ecommerce`, `forma_envio`, `decisao`, `status_separacao`, `data`, `itens[]`
- [ ] Cada item inclui: `produto_id`, `sku`, `gtin`, `descricao`, `quantidade_pedida`, `quantidade_bipada`, `bipado_completo`, `localizacao`
- [ ] Localização resolvida de `siso_pedido_item_estoques` filtrado pelas empresas do galpão do operador
- [ ] Fallback: `siso_pedido_itens.localizacao_cwb` ou `localizacao_sp` conforme galpão (legacy)
- [ ] Pedidos com `status = 'cancelado'` excluídos
- [ ] Admin (galpaoId null) pode passar `?galpao_id=UUID` para filtrar
- [ ] Typecheck/lint passes

---

### US-015: Desfazer bip (undo) (API)

**Description:** Como operador, quero desfazer um bip errado para corrigir sem precisar chamar admin.

**Acceptance Criteria:**
- [ ] `POST /api/separacao/desfazer-bip` recebe `{ pedido_id, produto_id }`
- [ ] Valida que o pedido pertence ao galpão do operador (via sessão)
- [ ] Decrementa `quantidade_bipada` (mínimo 0), reverte `bipado_completo` se necessário
- [ ] Se pedido estava `em_separacao` e todos bips foram desfeitos (soma de quantidade_bipada = 0), reverte para `pendente`
- [ ] Se pedido estava `embalado` e bip é desfeito, reverte para `em_separacao`
- [ ] Retorna estado atualizado do item e pedido
- [ ] Typecheck/lint passes

---

## 4. Functional Requirements

- FR-1: `POST /api/separacao/bipar` — processa scan via `supabase.rpc('siso_processar_bip')`
- FR-2: `GET /api/separacao` — lista pedidos por galpão com itens e bips, filtro por `status_separacao`
- FR-3: `POST /api/separacao/desfazer-bip` — decrementa bip, reverte status se necessário
- FR-4: `POST /api/separacao/expedir` — recebe `{ pedido_ids: string[] }`, marca como `expedido`
- FR-5: `PATCH /api/separacao/{pedidoId}/forcar-pendente` — admin only, força `aguardando_nf → pendente`
- FR-6: Todos endpoints validam sessão via `getSessionUser(request)` (PRD 2)
- FR-7: Operador só acessa pedidos do seu galpão (enforced no servidor)
- FR-8: Admin pode acessar qualquer galpão (com filtro explícito)

---

## 5. Non-Goals

- **Não** implementar frontend — apenas API (PRD 5 consome estes endpoints)
- **Não** implementar impressão de etiqueta — apenas retornar `etiqueta_status` (PRD 7)
- **Não** implementar reimpressão de etiqueta (PRD 7)

---

## 6. Technical Considerations

### 6.1 Estrutura de Rotas

```
src/app/api/separacao/
  route.ts                          # GET (lista) + POST (bipar, via query param action?)
  bipar/route.ts                    # POST /api/separacao/bipar
  desfazer-bip/route.ts             # POST /api/separacao/desfazer-bip
  expedir/route.ts                  # POST /api/separacao/expedir
  [pedidoId]/
    forcar-pendente/route.ts        # PATCH /api/separacao/{pedidoId}/forcar-pendente
```

### 6.2 GET /api/separacao — Query de listagem

```sql
SELECT
  p.id, p.numero, p.cliente_nome, p.ecommerce, p.forma_envio,
  p.decisao_final, p.status_separacao, p.data,
  p.separado_por, p.separado_em, p.embalado_em, p.etiqueta_status,
  json_agg(json_build_object(
    'produto_id', pi.produto_id,
    'sku', pi.sku,
    'gtin', pi.gtin,
    'descricao', pi.descricao,
    'quantidade_pedida', pi.quantidade_pedida,
    'quantidade_bipada', pi.quantidade_bipada,
    'bipado_completo', pi.bipado_completo,
    'localizacao', pie.localizacao
  )) AS itens
FROM siso_pedidos p
JOIN siso_pedido_itens pi ON pi.pedido_id = p.id
LEFT JOIN siso_pedido_item_estoques pie ON pie.pedido_id = p.id
  AND pie.produto_id = pi.produto_id
  AND pie.empresa_id IN (SELECT id FROM siso_empresas WHERE galpao_id = $galpao_id)
WHERE p.separacao_galpao_id = $galpao_id
  AND p.status_separacao = $status_filter
  AND p.status != 'cancelado'
GROUP BY p.id
ORDER BY p.data ASC;
```

**Nota:** Se houver múltiplas empresas no mesmo galpão, a localização pode vir de qualquer uma delas. Usar `DISTINCT ON` ou pegar a primeira não-nula.

### 6.3 POST /api/separacao/bipar — Contrato

```typescript
// Request
{ codigo: string }  // SKU ou GTIN
// Headers: X-Session-Id: <sessionId>

// Responses
200 { status: "parcial", pedido_id, pedido_numero, sku, bipados: N, total: M, itens_faltam: K }
200 { status: "item_completo", pedido_id, pedido_numero, sku, itens_faltam: K }
200 { status: "pedido_completo", pedido_id, pedido_numero, etiqueta_status: "pendente" }
404 { error: "item_nao_encontrado", codigo }
409 { error: "item_ja_completo", pedido_id, sku }
401 { error: "sessao_invalida" }
429 { error: "rate_limit" }
```

### 6.4 POST /api/separacao/desfazer-bip — Lógica

```typescript
// 1. Validar sessão
// 2. Validar pedido pertence ao galpão do operador
// 3. Buscar item
// 4. Decrementar quantidade_bipada (min 0)
// 5. Se quantidade_bipada < quantidade_pedida, bipado_completo = false
// 6. Checar soma total de bips no pedido:
//    - Se soma = 0 e status = 'em_separacao' → revert para 'pendente', limpar separado_por/separado_em
//    - Se status = 'embalado' → revert para 'em_separacao', limpar embalado_em, etiqueta_status = null
// 7. Retornar estado atualizado
```

### 6.5 POST /api/separacao/expedir

```typescript
// Request
{ pedido_ids: string[] }

// Validações
// - Sessão válida
// - Todos pedidos pertencem ao galpão do operador
// - Todos pedidos têm status_separacao = 'embalado'
// - Update: status_separacao = 'expedido'
```

### 6.6 PATCH /api/separacao/{pedidoId}/forcar-pendente

```typescript
// Admin only (cargo = 'admin')
// Valida: pedido tem status_separacao = 'aguardando_nf'
// Update: status_separacao = 'pendente'
// Use case: webhook de NF falhou, admin força manualmente
```

---

## 7. Validação

```bash
# 1. Bipar item
curl -X POST /api/separacao/bipar \
  -H "X-Session-Id: <sessionId>" \
  -d '{"codigo":"SKU123"}'

# 2. Listar pendentes
curl -G /api/separacao \
  -H "X-Session-Id: <sessionId>" \
  -d "status=pendente"

# 3. Desfazer bip
curl -X POST /api/separacao/desfazer-bip \
  -H "X-Session-Id: <sessionId>" \
  -d '{"pedido_id":"uuid","produto_id":"123"}'

# 4. Sessão inválida
curl -X POST /api/separacao/bipar \
  -H "X-Session-Id: invalid" \
  -d '{"codigo":"SKU123"}'
# Espera: 401
```

---

## 8. Success Metrics

- Bip processa em < 100ms (função PL/pgSQL atômica)
- Zero race conditions entre operadores simultâneos (`FOR UPDATE SKIP LOCKED`)
- Desfazer bip funciona corretamente em todos os cenários de status
- Sessão inválida/expirada retorna 401
- Rate limiter bloqueia bips excessivos
