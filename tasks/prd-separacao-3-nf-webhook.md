# PRD 3/7 — Separação: Webhook de NF Autorizada

**Depende de:** PRD 1 (Schema — colunas `status_separacao`, `url_danfe`, `chave_acesso_nf`)
**Bloqueia:** Nada (mas PRD 5 exibe a aba "Aguardando NF" que depende desta transição)

---

## 1. Introdução

Quando o worker do SISO gera a NF e ela é autorizada pela SEFAZ, o Tiny envia um webhook `tipo: "nota_fiscal"`. Este PRD implementa o handler que recebe esse webhook e faz a transição `aguardando_nf → pendente` no pedido, liberando-o para separação.

### Problema que resolve

- Pedidos aprovados ficam em `aguardando_nf` até a NF ser autorizada
- Sem este handler, pedidos nunca aparecem como "prontos para separar"
- Operador não tem como saber quando o pedido está liberado

---

## 2. Goals

- Webhook `tipo: "nota_fiscal"` processado corretamente
- Match NF → Pedido via fast-path (`nota_fiscal_id`) e fallback (API Tiny)
- Transição `aguardando_nf → pendente` acontece automaticamente
- `url_danfe` e `chave_acesso_nf` salvos no pedido
- Race condition tratada (NF chega antes do pedido ser salvo)

---

## 3. User Stories

### US-013: Webhook de NF autorizada como gatilho de separação

**Description:** Como sistema, preciso receber o webhook `tipo: "nota_fiscal"` do Tiny e usar a autorização da NF como gatilho para mover o pedido de "Aguardando NF" para "Pendente" na separação.

**Acceptance Criteria:**
- [ ] `route.ts` do webhook estendido para aceitar `tipo: "nota_fiscal"` além dos tipos existentes. O discriminador por `tipo` deve ocorrer ANTES da validação de `codigoSituacao` (que não existe em webhooks de NF)
- [ ] **PRE-REQUISITO:** Antes de implementar, capturar um payload REAL do webhook de NF do Tiny e validar os nomes dos campos. O formato abaixo é **assumido** e deve ser confirmado:
  - Payload assumido: `{ cnpj, tipo: "nota_fiscal", dados: { idNotaFiscalTiny, numero, serie, urlDanfe, chaveAcesso, dataEmissao, valorNota } }`
- [ ] Match NF → Pedido: fast-path via `siso_pedidos.nota_fiscal_id = dados.idNotaFiscalTiny` (atenção ao cast: `nota_fiscal_id` é `bigint` no banco, garantir comparação numérica)
- [ ] Fallback match: `GET /notas/{idNotaFiscalTiny}` → retorna `origem: { id, tipo }` (confirmado no modelo `ObterNotaFiscalModelResponse` do Tiny v3) — se `tipo = "venda"`, usa `origem.id` como pedido_id Tiny
- [ ] Fallback se NF webhook chega ANTES do pedido ser salvo pelo `processWebhook` (race condition de timing): salvar evento em `siso_webhook_logs` com `status = 'aguardando_pedido'` e reprocessar em 30 segundos via retry
- [ ] Se pedido encontrado e `status_separacao = 'aguardando_nf'`: transiciona para `'pendente'`
- [ ] Salva `url_danfe` e `chave_acesso_nf` no pedido
- [ ] Se pedido NÃO encontrado (NF de outro tipo, devolução, etc): log info e ignora silenciosamente (200 OK). Verificar `origem.tipo` — só processar se `tipo = "venda"`
- [ ] Se pedido já está além de `aguardando_nf` (ex: já `pendente` por reprocessamento): ignora (idempotente)
- [ ] Dedup por `idNotaFiscalTiny` no `siso_webhook_logs` (usa `dedup_key = "nf_{idNotaFiscalTiny}"`)
- [ ] Typecheck/lint passes

---

## 4. Functional Requirements

- FR-1: Discriminação por `tipo` ANTES de validar `codigoSituacao` no webhook route
- FR-2: Dedup via `siso_webhook_logs` com `dedup_key = "nf_{idNotaFiscalTiny}"`
- FR-3: Match NF → Pedido via `nota_fiscal_id` (fast-path) ou `GET /notas/{id}` → `origem.id` (fallback)
- FR-4: Verificar `origem.tipo = "venda"` — ignorar NFs de devolução/serviço
- FR-5: Transição `aguardando_nf → pendente` com UPDATE condicional (`WHERE status_separacao = 'aguardando_nf'`)
- FR-6: Salvar `url_danfe` e `chave_acesso_nf` no pedido
- FR-7: Se pedido não existe ainda, salvar com `status = 'aguardando_pedido'` para retry
- FR-8: webhook-processor.ts: ao salvar pedido, verificar se já existe webhook de NF pendente e fazer transição imediata

---

## 5. Non-Goals

- **Não** criar tela — a visualização é no PRD 5 (aba "Aguardando NF")
- **Não** processar webhook de NF de devolução, serviço, ou transferência
- **Não** implementar impressão de DANFE

---

## 6. Technical Considerations

### 6.1 Novo arquivo: src/lib/nf-webhook-handler.ts

Handler isolado para manter o webhook route limpo:

```typescript
export async function handleNfWebhook(payload: NfWebhookPayload, empresaId: string): Promise<void> {
  // 1. Dedup check
  // 2. Match NF → Pedido (fast-path + fallback)
  // 3. Validate origem.tipo = "venda"
  // 4. Transition aguardando_nf → pendente
  // 5. Save url_danfe, chave_acesso_nf
}
```

### 6.2 Nova função em tiny-api.ts

```typescript
// obterNotaFiscal(token, notaId) → GET /notas/{id}
// Retorna: { id, origem: { id: string, tipo: string }, ... }
```

### 6.3 Fluxo no route.ts

```
POST /api/webhook/tiny  (tipo: "nota_fiscal")
     │
     ▼
0. Discriminar por tipo ANTES de validar codigoSituacao:
   if (tipo === "nota_fiscal") → nfWebhookHandler(...)
   else → validar codigoSituacao e processar como antes
     │
     ▼
1. Valida payload: cnpj, tipo = "nota_fiscal", dados.idNotaFiscalTiny
     │
     ▼
2. Dedup: siso_webhook_logs com dedup_key = "nf_{idNotaFiscalTiny}"
     │
     ├── Já processado → 200 OK (idempotente)
     │
     ▼
3. Identifica empresa pelo CNPJ (empresa-lookup existente)
     │
     ▼
4. Match NF → Pedido:
   a. Fast-path: SELECT FROM siso_pedidos WHERE nota_fiscal_id = CAST(idNotaFiscalTiny AS bigint)
   b. Fallback: GET /notas/{idNotaFiscalTiny} → se origem.tipo = "venda", buscar pedido por origem.id
   c. Não encontrou → salvar com status = 'aguardando_pedido', retry em 30s
   d. Não encontrou após retry → log info, 200 OK
     │
     ▼
5. UPDATE siso_pedidos SET
     status_separacao = 'pendente',
     url_danfe = dados.urlDanfe,
     chave_acesso_nf = dados.chaveAcesso
   WHERE id = pedido_id AND status_separacao = 'aguardando_nf'
     │
     ▼
6. Log + 200 OK
```

### 6.4 Reconciliação no webhook-processor.ts

Ao salvar pedido (final do `processWebhook`):
```typescript
// Verificar se já existe webhook de NF pendente para este pedido
const { data: pendingNf } = await supabase
  .from('siso_webhook_logs')
  .select('payload')
  .eq('status', 'aguardando_pedido')
  .ilike('dedup_key', 'nf_%')
  // match pelo pedido_id ou nota_fiscal_id
```

### 6.5 Timing

```
Pedido aprovado ──┬── Worker: gera NF → salva nota_fiscal_id (EXISTENTE)
                  │
                  └── SISO: status_separacao = 'aguardando_nf' (PRD 1)

NF autorizada ────────► webhook tipo="nota_fiscal" chega (ESTE PRD)
                        match: idNotaFiscalTiny → pedido
                        salva url_danfe, chave_acesso_nf
                        status_separacao = 'pendente'
```

---

## 7. Validação

1. Configurar webhook de NF no Tiny (se não existir)
2. Capturar payload real e confirmar campos
3. Enviar webhook mock:
```bash
curl -X POST /api/webhook/tiny -d '{
  "cnpj": "34857388000163",
  "tipo": "nota_fiscal",
  "dados": { "idNotaFiscalTiny": 12345, "numero": "001", "urlDanfe": "https://...", "chaveAcesso": "..." }
}'
```
4. Verificar no banco: pedido transicionou de `aguardando_nf` para `pendente`

---

## 8. Success Metrics

- Webhook de NF processado sem erro
- Pedidos transitam de `aguardando_nf` → `pendente` automaticamente
- NFs duplicadas ignoradas (idempotente)
- NFs de devolução/serviço ignoradas silenciosamente
- Race condition (NF antes do pedido) tratada via retry
