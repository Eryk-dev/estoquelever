# PRD 7/7 — Separação: Etiqueta (Busca + Auto-Print + Reimpressão)

**Depende de:** PRD 4 (API Separação), PRD 5 (Frontend), PRD 6 (PrintNode)
**Bloqueia:** Nada (última fase)

---

## 1. Introdução

Este PRD conecta as peças finais: quando todos os itens de um pedido são bipados (pedido `embalado`), o sistema automaticamente busca a etiqueta de envio do Tiny (via expedição/agrupamento) e envia para impressão na impressora correta via PrintNode.

### Problema que resolve

- Operador precisa manualmente acessar o Tiny, abrir a expedição e imprimir a etiqueta
- Etiqueta pode sair na impressora errada (galpão da conta Tiny, não do operador)
- Sem rastreio de status de impressão (imprimiu? falhou? precisa reimprimir?)

---

## 2. Goals

- Ao embalar pedido, buscar etiqueta automaticamente do Tiny
- Enviar para PrintNode na impressora correta
- Rastrear `etiqueta_status` (pendente → imprimindo → impresso / falhou)
- Reimpressão disponível para pedidos já embalados
- Etiqueta URL cacheada para reimpressão rápida

---

## 3. User Stories

### US-004: Completude por pedido e impressão automática de etiqueta

**Description:** Como operador, quero que a etiqueta de envio imprima automaticamente quando todos os itens de um pedido forem bipados.

**Acceptance Criteria:**
- [ ] Quando `status_separacao` muda para `'embalado'` (via bip API), dispara busca de etiqueta async
- [ ] Busca: criar agrupamento no Tiny (`POST /expedicao`) → obter URLs das etiquetas (`GET /expedicao/{id}/etiquetas`)
- [ ] Primeira URL do array cacheada em `siso_pedidos.etiqueta_url`
- [ ] URL enviada ao PrintNode via `enviarImpressao()` (PRD 6)
- [ ] Impressora resolvida: `usuario.printnode_printer_id ?? galpao.printnode_printer_id`
- [ ] Pedido embalado sai da lista de pendentes e vai para aba "Embalados" com timestamp
- [ ] Toast de sucesso: "Pedido #8832 embalado! Etiqueta impressa."
- [ ] Se etiqueta falhar, `etiqueta_status = 'falhou'` — badge visual + botão retry
- [ ] Reimpressão disponível via `POST /api/separacao/reimprimir`
- [ ] Typecheck/lint passes

---

### US-007: Obter etiqueta de envio via Tiny Expedição

**Description:** Como sistema, preciso buscar a URL da etiqueta de envio do Tiny para enviar ao PrintNode.

**Acceptance Criteria:**
- [ ] `tiny-api.ts`: nova função `criarAgrupamento(token, idsPedidos)` → `POST /expedicao` com body `{ idsPedidos: number[] }` → retorna `{ id: number }` (o `idAgrupamento`)
- [ ] `tiny-api.ts`: nova função `obterEtiquetasAgrupamento(token, idAgrupamento)` → `GET /expedicao/{idAgrupamento}/etiquetas` → retorna `{ urls: string[] }`
- [ ] Primeira URL do array cacheada em `siso_pedidos.etiqueta_url` para reimpressão rápida
- [ ] Se expedição já existe (pedido já tem `agrupamento_tiny_id`), ir direto para `GET etiquetas`
- [ ] Se Tiny retorna 404/400 (etiqueta não disponível), `etiqueta_status = 'falhou'`
- [ ] Expedição criada usando o token da **empresa de origem** do pedido (onde a NF está)
- [ ] `agrupamento_tiny_id` salvo no pedido para reusar em reimpressões

**Nota terminológica:** O Tiny usa "agrupamento" (que pode conter múltiplas "expedições"). `POST /expedicao` cria um **agrupamento**. `GET /expedicao/{id}/etiquetas` busca etiquetas do **agrupamento**. No código do SISO usamos `agrupamento_tiny_id` (não `expedicao_tiny_id`).

---

## 4. Functional Requirements

- FR-1: Novo arquivo `src/lib/etiqueta-service.ts` com função `buscarEImprimirEtiqueta(pedidoId)`
- FR-2: Criar agrupamento Tiny via `POST /expedicao { idsPedidos: [int] }`
- FR-3: Buscar URLs via `GET /expedicao/{id}/etiquetas`
- FR-4: Token usado é da empresa de origem do pedido (onde a NF está)
- FR-5: Cache `etiqueta_url` e `agrupamento_tiny_id` no pedido
- FR-6: Enviar para PrintNode via `enviarImpressao()` (PRD 6)
- FR-7: Atualizar `etiqueta_status` em cada etapa (pendente → imprimindo → impresso / falhou)
- FR-8: `POST /api/separacao/reimprimir` para reimpressão (usa URL cacheada ou refaz busca se expirou)
- FR-9: URLs de etiqueta nunca expostas ao frontend (contêm dados pessoais LGPD)
- FR-10: Se `etiqueta_url` expirou na reimpressão, refazer `GET /expedicao/{id}/etiquetas`

---

## 5. Non-Goals

- **Não** implementar impressão de DANFE (pode usar mesmo mecanismo depois)
- **Não** implementar PLP (Pré-Lista de Postagem) ou coleta
- **Não** implementar webhook de status do PrintNode
- **Não** suportar múltiplas etiquetas por pedido (MVP = primeira URL do array)

---

## 6. Technical Considerations

### 6.1 Novo arquivo: src/lib/etiqueta-service.ts

```typescript
export async function buscarEImprimirEtiqueta(pedidoId: string): Promise<void> {
  // 1. Buscar pedido com empresa_origem_id
  // 2. Verificar etiqueta_status — se 'impresso', skip (idempotência)
  // 3. Obter URL da etiqueta:
  //    a. Se já tem etiqueta_url → usar (verificar se não expirou)
  //    b. Se já tem agrupamento_tiny_id → GET /expedicao/{id}/etiquetas
  //    c. Senão → POST /expedicao { idsPedidos: [pedido.id_numerico] }
  //              → salvar agrupamento_tiny_id
  //              → GET /expedicao/{id}/etiquetas
  //              → salvar etiqueta_url (urls[0])
  // 4. Atualizar etiqueta_status = 'imprimindo'
  // 5. Resolver impressora (usuario → galpao)
  // 6. Enviar para PrintNode
  // 7. Atualizar etiqueta_status = 'impresso' (ou 'falhou')
}
```

### 6.2 Fluxo Detalhado

```
buscarEImprimirEtiqueta(pedidoId)
     │
     ▼
1. Já tem etiqueta_url cacheada?
   ├── SIM → retorna URL, etiqueta_status = 'imprimindo'
   │
   ▼
2. Já tem agrupamento_tiny_id?
   ├── SIM → GET /expedicao/{idAgrupamento}/etiquetas
   │         ├── retorna { urls: [...] } → salva urls[0], retorna
   │         └── 404 → etiqueta não disponível ainda (raro)
   │
   ▼
3. Criar agrupamento:
   a. Pega token da empresa ORIGEM do pedido (getValidTokenByEmpresa)
   b. POST /expedicao { idsPedidos: [pedido.id_numerico] }
      ├── 200 → salva agrupamento_tiny_id no DB
      └── 400 → etiqueta_status = 'falhou', log erro
   c. GET /expedicao/{idAgrupamento}/etiquetas
      ├── retorna { urls: [...] } → salva etiqueta_url (urls[0])
      └── vazio/404 → etiqueta_status = 'falhou'

4. Atualiza etiqueta_status:
   ├── sucesso → 'imprimindo' → envia PrintNode → 'impresso'
   └── falha   → 'falhou' (visível no frontend, botão retry disponível)
```

### 6.3 Novas funções em tiny-api.ts

```typescript
// POST /expedicao
export async function criarAgrupamento(
  token: string,
  idsPedidos: number[]
): Promise<{ id: number }> {
  // Body: { idsPedidos }
  // Response: { id: number } (o idAgrupamento)
}

// GET /expedicao/{idAgrupamento}/etiquetas
export async function obterEtiquetasAgrupamento(
  token: string,
  idAgrupamento: number
): Promise<{ urls: string[] }> {
  // Response: { urls: string[] }
}
```

### 6.4 API Route: POST /api/separacao/reimprimir

```typescript
// Request: { pedido_id: string }
// Headers: X-Session-Id

// 1. Validar sessão
// 2. Validar pedido pertence ao galpão do operador
// 3. Validar pedido tem status_separacao = 'embalado' ou 'expedido'
// 4. Se etiqueta_url existe → tentar imprimir direto
//    Se etiqueta_url expirou (PrintNode retorna erro) → refazer GET /expedicao/{id}/etiquetas
// 5. Enviar para PrintNode
// 6. Retornar { status: 'impresso', jobId }
```

### 6.5 Integração com POST /api/separacao/bipar

Quando o bip retorna `status: "pedido_completo"`:
1. O endpoint de bip já seta `etiqueta_status = 'pendente'` (via função PL/pgSQL)
2. **Após** retornar 200 ao client, disparar `buscarEImprimirEtiqueta(pedidoId)` de forma async (fire-and-forget)
3. O frontend faz polling e verá `etiqueta_status` mudar de `pendente` → `imprimindo` → `impresso`

```typescript
// No handler de bipar, após retornar response:
if (result.status === 'pedido_completo') {
  // Fire-and-forget — não bloqueia resposta do bip
  buscarEImprimirEtiqueta(result.pedido_id).catch(err => {
    logger.error('etiqueta-service', 'Falha ao imprimir etiqueta', { pedidoId: result.pedido_id, error: err.message });
  });
}
```

### 6.6 Atualização do Frontend (PRD 5)

Ativar botões que estavam placeholder no PRD 5:
- "Reimprimir Etiqueta" → chama `POST /api/separacao/reimprimir`
- Badge de `etiqueta_status` com cores: pendente (yellow), imprimindo (blue), impresso (green), falhou (red)
- Botão "Tentar Novamente" para `etiqueta_status = 'falhou'`

### 6.7 Segurança

- URLs de etiqueta contêm dados pessoais (nome, endereço) — protegidas pela LGPD
- Nunca expostas ao frontend — reimpressão sempre via server-side
- Não logadas em `siso_logs`
- URLs podem expirar — reimpressão refaz busca se necessário

### 6.8 Edge Cases

| Caso | Tratamento |
|---|---|
| Etiqueta não disponível ao embalar | `etiqueta_status = 'falhou'`, badge visual, botão retry |
| PrintNode offline | Job fica na fila do PrintNode, imprime quando voltar. SISO mostra `impresso` (job enviado) |
| URL da etiqueta expirou | Refazer `GET /expedicao/{id}/etiquetas` com `agrupamento_tiny_id` |
| Sem impressora configurada | `etiqueta_status = 'falhou'`, log warning, toast para operador |
| Marketplace não gerou etiqueta | `etiqueta_status = 'falhou'`, retry manual disponível |
| Agrupamento já existe no Tiny | Usar `agrupamento_tiny_id` salvo, ir direto para GET etiquetas |

---

## 7. Validação

1. Bipar todos os itens de um pedido → `etiqueta_status` muda para `pendente` → `imprimindo` → `impresso`
2. Verificar que etiqueta saiu na impressora correta
3. Reimprimir → nova impressão com mesmo conteúdo
4. Simular falha (impressora off) → `etiqueta_status = 'falhou'` → retry funciona
5. Verificar que URL da etiqueta NÃO aparece no frontend ou nos logs

---

## 8. Success Metrics

- Etiqueta impressa em < 10s após último bip do pedido
- > 95% das etiquetas impressas com sucesso na primeira tentativa
- Zero etiquetas na impressora errada
- Reimpressão funciona mesmo para pedidos antigos (refaz busca se URL expirou)
