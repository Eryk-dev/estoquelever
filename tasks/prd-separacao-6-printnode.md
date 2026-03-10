# PRD 6/7 — Separação: Integração PrintNode

**Depende de:** Nada
**Bloqueia:** PRD 7 (Etiqueta — usa PrintNode para imprimir)

---

## 1. Introdução

Este PRD implementa a integração com o PrintNode para impressão de etiquetas na impressora física correta de cada galpão. Inclui o client lib, configuração de impressoras por galpão/usuário, e endpoints de administração.

### Problema que resolve

- Etiquetas saem na impressora errada (galpão errado)
- Não há mecanismo para enviar impressão server-side para impressora física
- Operadores precisam imprimir manualmente a partir do Tiny

---

## 2. Goals

- Lib `printnode.ts` funcional para enviar jobs de impressão
- Cada galpão tem impressora padrão configurada
- Cada usuário pode ter override de impressora
- Admin configura e testa impressoras na tela de configurações

---

## 3. User Stories

### US-005: Integração PrintNode — impressora por galpão/usuário

**Description:** Como admin, quero configurar qual impressora PrintNode é usada em cada galpão, com possibilidade de override por usuário.

**Acceptance Criteria:**
- [ ] Tela de configurações (existente) ganha seção "Impressão (PrintNode)"
- [ ] API Key do PrintNode armazenada em variável de ambiente `PRINTNODE_API_KEY` (não no banco — decisão consciente de simplicidade para app interno)
- [ ] Botão "Testar Conexão" que chama `GET /whoami` do PrintNode e exibe status
- [ ] Após conectar, lista impressoras disponíveis (`GET /printers`) para seleção
- [ ] Cada galpão tem campo "Impressora padrão etiqueta" (dropdown das impressoras PrintNode)
- [ ] Cada usuário pode ter "Impressora override" (opcional, sobrescreve a do galpão)
- [ ] Resolução: `usuario.printnode_printer_id ?? galpao.printnode_printer_id`
- [ ] Se nenhuma impressora configurada, exibe aviso na tela de configurações
- [ ] Typecheck/lint passes

---

### US-008: Enviar job de impressão ao PrintNode

**Description:** Como sistema, preciso enviar o PDF da etiqueta para o PrintNode na impressora correta.

**Acceptance Criteria:**
- [ ] Nova lib `src/lib/printnode.ts` com funções:
  - `testarConexao(apiKey)` → `GET /whoami`
  - `listarImpressoras(apiKey)` → `GET /printers`
  - `enviarImpressao({ apiKey, printerId, pdfUrl, titulo })` → `POST /printjobs`
- [ ] `enviarImpressao` usa `contentType: "pdf_uri"` e `content: URL`
- [ ] Auth via HTTP Basic (API key como username, password vazio)
- [ ] Retorna job ID do PrintNode para rastreabilidade
- [ ] Idempotência controlada pelo SISO: antes de enviar, verifica se `etiqueta_status = 'impresso'` no banco
- [ ] Timeout de 10s, retry 1x em caso de erro de rede
- [ ] Log da impressão em `siso_logs` com pedido_id, printer_id, job_id (sem logar URLs de etiqueta — LGPD)
- [ ] Typecheck/lint passes

---

## 4. Functional Requirements

- FR-1: Lib `printnode.ts` com 3 funções (testar, listar, imprimir)
- FR-2: Auth via HTTP Basic (`base64(apiKey + ":"`)
- FR-3: `POST /printjobs` com `contentType: "pdf_uri"`, `content: URL`, `title: string`, `source: "SISO Separacao"`
- FR-4: Resolução de impressora: `usuario.printnode_printer_id ?? galpao.printnode_printer_id`
- FR-5: Colunas `printnode_printer_id` e `printnode_printer_nome` em `siso_galpoes` e `siso_usuarios`
- FR-6: API routes para admin: `GET /api/admin/printnode/printers`, `POST /api/admin/printnode/test`
- FR-7: UI de configuração de impressoras na tela de configurações existente

---

## 5. Non-Goals

- **Não** implementar o fluxo de etiqueta completo (buscar etiqueta do Tiny, auto-print) — isso é PRD 7
- **Não** implementar webhook de status do PrintNode (job entregue/falhou)
- **Não** implementar impressão de DANFE
- **Não** armazenar API Key no banco (env var é suficiente para app interno)

---

## 6. Technical Considerations

### 6.1 Migration

```sql
-- Migration: 20260311_add_printnode_config.sql

ALTER TABLE siso_galpoes
  ADD COLUMN printnode_printer_id bigint,
  ADD COLUMN printnode_printer_nome text;

ALTER TABLE siso_usuarios
  ADD COLUMN printnode_printer_id bigint,
  ADD COLUMN printnode_printer_nome text;
```

### 6.2 Novo arquivo: src/lib/printnode.ts

```typescript
const PRINTNODE_BASE = 'https://api.printnode.com';

function getAuthHeader(apiKey: string): string {
  return 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
}

export async function testarConexao(apiKey: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  // GET /whoami
}

export async function listarImpressoras(apiKey: string): Promise<PrintNodePrinter[]> {
  // GET /printers
  // Returns: [{ id, name, computer: { name }, state }]
}

export async function enviarImpressao(params: {
  apiKey: string;
  printerId: number;
  pdfUrl: string;
  titulo: string;
}): Promise<{ jobId: number }> {
  // POST /printjobs
  // Body: { printerId, contentType: "pdf_uri", content: pdfUrl, title, source: "SISO Separacao" }
  // Timeout: 10s
  // Retry: 1x on network error
}

export async function resolverImpressora(
  usuarioId: string,
  galpaoId: string
): Promise<{ printerId: number; printerNome: string } | null> {
  // 1. Check usuario.printnode_printer_id
  // 2. Fallback to galpao.printnode_printer_id
  // 3. Return null if neither configured
}
```

### 6.3 API Routes

**GET /api/admin/printnode/printers**
```typescript
// Requires: admin cargo
// Reads PRINTNODE_API_KEY from env
// Calls listarImpressoras()
// Returns: [{ id, name, computer, state }]
```

**POST /api/admin/printnode/test**
```typescript
// Requires: admin cargo
// Reads PRINTNODE_API_KEY from env
// Calls testarConexao()
// Returns: { ok, email } or { ok: false, error }
```

### 6.4 UI na Tela de Configurações

Nova seção na página `/configuracoes` (após a seção de Conexões Tiny):

```
┌─────────────────────────────────────────┐
│ Impressão (PrintNode)                    │
│                                          │
│ Status: ✓ Conectado (admin@empresa.com)  │  ← resultado do /whoami
│ [Testar Conexão]                         │
│                                          │
│ Impressoras por Galpão:                  │
│ ┌──────────────────────────────────────┐ │
│ │ CWB: [Zebra ZD421 (Galpão CWB) ▼]  │ │  ← dropdown das impressoras
│ │ SP:  [Zebra GK420d (Galpão SP) ▼]   │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ Override por Usuário (opcional):          │
│ ┌──────────────────────────────────────┐ │
│ │ Eryk: [Nenhuma (usa padrão) ▼]      │ │
│ └──────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 6.5 Env Var

```
PRINTNODE_API_KEY=<api-key>  # em .env.local
```

### 6.6 PrintNode API Details

```
Base URL: https://api.printnode.com
Auth: HTTP Basic (api_key:)

GET /whoami → { id, email, ... }
GET /printers → [{ id, name, computer: { id, name }, state, ... }]
POST /printjobs → jobId (number)
  Body: { printerId: int, contentType: "pdf_uri", content: "https://...", title: "...", source: "..." }

Rate limit: 10 req/s (irrelevante para nosso volume)
```

---

## 7. Validação

1. Configurar `PRINTNODE_API_KEY` no `.env.local`
2. Acessar configurações → seção PrintNode → "Testar Conexão" → status verde
3. Listar impressoras → ver impressoras do PrintNode no dropdown
4. Selecionar impressora para galpão CWB → salvar → verificar no banco
5. Enviar job de teste (endpoint de teste ou via curl):
```bash
curl -X POST /api/admin/printnode/test
# Espera: { ok: true, email: "..." }
```

---

## 8. Success Metrics

- Conexão PrintNode testável pela UI
- Impressoras listadas corretamente
- Job de impressão entregue ao PrintNode com sucesso
- Resolução impressora: user override > galpão default > null
