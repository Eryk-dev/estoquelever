# PRD 2/7 — Separação: Sessão Server-Side

**Depende de:** Nada
**Bloqueia:** PRD 4 (API Separação)

---

## 1. Introdução

O sistema atual usa autenticação via localStorage (`siso_user`), sem validação server-side. Para o módulo de separação, onde `usuario_id` e `galpao_id` determinam quais pedidos o operador vê e quais itens pode bipar, é necessário sessão validada no servidor.

### Problema que resolve

- Operador poderia falsificar `usuario_id` ou `galpao_id` no body da requisição
- Sem sessão server-side, não há trilha de auditoria confiável de quem bipou o quê
- Sem rate limiting por sessão, scanner defeituoso poderia floodar a API

---

## 2. Goals

- Login gera sessionId persistido no banco
- Helper `getSessionUser(request)` valida sessão e retorna dados do usuário
- Client envia sessionId em toda requisição via header
- Rate limiting por sessão para endpoint de bip

---

## 3. User Stories

### US-016: Sessão server-side para separação

**Description:** Como sistema, preciso validar a identidade do operador no servidor para garantir integridade da trilha de auditoria e isolamento por galpão.

**Acceptance Criteria:**
- [ ] Nova tabela `siso_sessoes` com `id (UUID)`, `usuario_id (FK)`, `criado_em`, `expira_em` (12h)
- [ ] Login (`POST /api/auth/login`) gera `sessionId` e salva na tabela. Retorna `sessionId` ao client no response
- [ ] Client armazena `sessionId` no localStorage junto com os dados existentes
- [ ] Client envia `sessionId` como header `X-Session-Id` em toda requisição
- [ ] Novo helper `getSessionUser(request)` em `src/lib/session.ts` que:
  - Lê header `X-Session-Id`
  - Consulta `siso_sessoes` JOIN `siso_usuarios` JOIN `siso_empresas` (para pegar `galpao_id` via cargo)
  - Valida `expira_em > now()`
  - Retorna `{ id, nome, cargo, galpaoId }` ou `null` se inválida
- [ ] Resolução de `galpaoId` a partir do cargo:
  - `operador_cwb` → galpão CWB (busca por nome no banco)
  - `operador_sp` → galpão SP (busca por nome no banco)
  - `admin` → `null` (vê todos, ou frontend permite seleção)
  - `comprador` → `null`
- [ ] Rate limiting no endpoint de bip: máximo 2 bips/segundo por sessão (scanner físico não bipa mais rápido)
- [ ] Sessões expiradas são ignoradas (não deletadas imediatamente — cleanup periódico opcional)
- [ ] Typecheck/lint passes

---

## 4. Functional Requirements

- FR-1: Tabela `siso_sessoes` criada com migration
- FR-2: `POST /api/auth/login` gera UUID, insere em `siso_sessoes`, retorna `sessionId` no response JSON
- FR-3: Helper `getSessionUser(request)` valida sessão e resolve galpão a partir do cargo
- FR-4: Client (`auth-context.tsx`) armazena e envia `sessionId` em header `X-Session-Id`
- FR-5: Rate limiting de 2 req/s por sessão no endpoint de bip (implementado via in-memory Map com cleanup)
- FR-6: Login existente continua funcionando para funcionalidades atuais (retrocompatível)

---

## 5. Non-Goals

- **Não** migrar todos os endpoints existentes para usar sessão server-side (apenas `/api/separacao/*`)
- **Não** implementar refresh/renovação automática de sessão
- **Não** implementar logout que invalida sessão (expira naturalmente em 12h)
- **Não** implementar multi-sessão por usuário (cada login gera nova sessão, antigas expiram)

---

## 6. Technical Considerations

### 6.1 Migration

```sql
-- Migration: 20260311_create_siso_sessoes.sql

CREATE TABLE siso_sessoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES siso_usuarios(id),
  criado_em timestamptz DEFAULT now(),
  expira_em timestamptz DEFAULT now() + interval '12 hours'
);

CREATE INDEX idx_sessoes_expira ON siso_sessoes (expira_em) WHERE expira_em > now();
```

### 6.2 Novo arquivo: src/lib/session.ts

```typescript
// getSessionUser(request: Request): Promise<SessionUser | null>
// - Lê X-Session-Id do header
// - Query: siso_sessoes JOIN siso_usuarios WHERE id = sessionId AND expira_em > now()
// - Resolve galpaoId a partir do cargo (query siso_galpoes por nome)
// - Retorna { id, nome, cargo, galpaoId } ou null

// Tipo exportado:
export interface SessionUser {
  id: string;
  nome: string;
  cargo: string;
  galpaoId: string | null; // null para admin/comprador
}
```

### 6.3 Alteração em POST /api/auth/login

Após validar PIN e encontrar usuário:
1. Inserir em `siso_sessoes` com `usuario_id`
2. Adicionar `sessionId` ao response JSON existente

### 6.4 Alteração em auth-context.tsx

1. Ao fazer login, armazenar `sessionId` no localStorage junto com dados existentes
2. Expor `sessionId` no contexto de auth
3. Criar helper ou wrapper para fetch que adiciona header `X-Session-Id` automaticamente

### 6.5 Rate Limiting

```typescript
// In-memory rate limiter por sessão
// Map<sessionId, { count: number, resetAt: number }>
// Max 2 bips/segundo
// Cleanup entries mais antigas que 60s a cada 100 requests
```

---

## 7. Validação

```bash
# 1. Login retorna sessionId
curl -X POST /api/auth/login -d '{"nome":"Eryk","pin":"1234"}'
# Espera: { id, nome, cargo, sessionId: "uuid..." }

# 2. getSessionUser resolve corretamente
# (testar via endpoint de separação no PRD 4)
```

---

## 8. Success Metrics

- Login retorna sessionId válido
- `getSessionUser` resolve usuário + galpão corretamente para cada cargo
- Sessão expira após 12h
- Rate limiter bloqueia mais de 2 req/s por sessão
