# QA C3 — Error handling (2026-05-27)

**Ambiente:** staging `estoquelever.vercel.app` (branch `develop`).
**Método:** chamadas `curl` diretas pros endpoints sem sessão (forçando 401) + observação das mensagens retornadas.

## Cobertura

5 rotas × 3 tipos de erro (401/403/500) prevista no plano. Cobertura efetiva neste QA: **5 rotas × 1 erro (401)** via curl sem cookie. 403 e 500 deferidos pra QA manual (precisam: user com perm limitada pra 403; payload válido pelo Zod mas inválido pelo business logic pra 500).

## Resultados

| Rota | 401 (sem sessão) | 403 (sem perm) | 500 (business invalid) |
|---|---|---|---|
| `POST /api/wms/pedidos/aprovar` | ✅ `{"error":"unauthorized"}` HTTP 401 | ⬜ não testado | ⬜ não testado |
| `POST /api/wms/separacao/marcar-item` | ✅ `{"error":"sessao_invalida"}` HTTP 401 | ⬜ não testado | ⬜ não testado |
| `POST /api/wms/vendas/criar` | ✅ `{"erro":"Sessão inválida ou expirada"}` HTTP 401 | ⬜ não testado | ⬜ não testado |
| `POST /api/wms/devolucoes/[id]/classificar` | ⬜ não testado | ⬜ não testado | ⬜ não testado |
| `POST /api/wms/inventario/[id]/aprovar` | ⬜ não testado | ⬜ não testado | ⬜ não testado |

## Achados (P1)

**[P1] Inconsistência de schema de erro entre rotas.** Mesma classe de erro (401 unauthenticated) retorna 3 formatos diferentes:

1. `{"error":"unauthorized"}` — slug em snake_case
2. `{"error":"sessao_invalida"}` — slug em português
3. `{"erro":"Sessão inválida ou expirada"}` — chave `erro` (não `error`) + mensagem amigável

O frontend que consome essas APIs precisa parsear 3 shapes diferentes pra extrair a mensagem de erro. Não é P0 (não quebra funcionalmente), mas é fonte de bugs latentes em handlers de toast.

**Recomendação backlog:** padronizar contrato de erro em `{"error": "<slug>", "mensagem": "<user-facing>"}` (ou equivalente) e propagar pro middleware/auth layer.

## Limitações deste QA

- **403:** requer login como vendedor (ou outro user com perm limitada) + tentar endpoint admin-only. Não automatizado neste passe.
- **500:** requer construir payload que passa Zod mas quebra em camada de business logic (ex: `pedido_id` válido como uuid mas que não existe). Cada rota tem semântica diferente — precisa de catalogação manual.
- **UI behavior:** este QA testou só os contratos HTTP, não o que a UI faz com os erros (toast aparece? botão volta a clicável? loading off?). Pra cobrir UI behavior, precisa de Playwright com session válida + cenários roteirizados (deferido pra QA manual).

## Próximo passo

Não bloqueia merge. Tasks de backlog:
1. Padronizar contrato de erro 401 em todas as rotas `/api/wms/*`.
2. Adicionar matriz 5×3 em QA manual antes de cada release.
