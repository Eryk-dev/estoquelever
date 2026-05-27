# Consumers de `siso_empresas.galpao_id` (deprecated)

Last audit: 2026-05-27 (P6 fix).

## Contexto

A coluna `siso_empresas.galpao_id` é **deprecated**. Fica nullable e é apenas espelho do primeiro galpão preferencial (mantido por trigger `sync_empresa_galpao_id_from_preferenciais` pra compat de consumidores legados). Source of truth: `siso_empresa_galpoes_preferenciais` (N:N).

## Categorias

### A — OK (admin UI, ler espelho preferencial)

- `src/app/api/wms/admin/galpoes/route.ts` — admin UI, hierarquia
- `src/app/api/wms/admin/empresas/*.ts` — admin UI, display
- `src/components/wms/configuracoes/aba-*.tsx` — UI

### B — Runtime read-only (display em logs/UI)

- `src/lib/empresa-lookup.ts` — `siso_galpoes!siso_empresas_galpao_id_fkey!inner` em SELECT
- `src/lib/grupo-resolver.ts` — similar
- `src/app/api/wms/pedidos/[id]/detalhe/route.ts` (linha 72)
- `src/app/api/wms/pedidos/tracking/route.ts` (linha 180)
- `src/app/api/wms/tiny/connections/route.ts`

### C — Runtime crítico — MIGRAR

| Consumer | Status | Notas |
|---|---|---|
| `src/lib/compras-release.ts` | ✅ FIXED P6.A.4 | Migrado pra `pedido.separacao_galpao_id` com fallback via `siso_empresa_galpoes_preferenciais` |
| `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts` (linhas 80, 99) | P2 escopo | Coordenar com plano P2 |
| `src/app/api/wms/separacao/encaminhar/route.ts` (linha 280) | TODO POST-P6 | Usar `separacao_galpao_id` |
| `src/app/api/wms/separacao/produto-esgotado/route.ts` (linha 130) | TODO POST-P6 | Idem |
| `src/app/api/wms/separacao/checklist-items/route.ts` (linha 187) | TODO POST-P6 | Idem |
| `src/app/api/wms/tiny/stock/ajustar/route.ts` (linha 68) | TODO POST-P6 | Preferencial via N:N |
| `src/lib/wms/sugestao-dinamica.ts` (linha 99) | TODO POST-P6 | Preferencial via N:N |

### D — One-shot admin (OK por enquanto)

- `src/lib/wms/snapshot-inicial.ts` (linha 46) — admin bulk-load

## Migração proposta

Pra cada consumer da categoria C:
1. Adicionar `separacao_galpao_id` ao SELECT do pedido (quando aplicável).
2. Trocar `siso_empresas.galpao_id` por `pedido.separacao_galpao_id`.
3. Fallback explícito pra `siso_empresa_galpoes_preferenciais` (1º galpão por ordem alfabética) quando `separacao_galpao_id IS NULL`.

A long-term, a coluna `siso_empresas.galpao_id` será dropada uma vez que a categoria C estiver vazia. Trigger `sync_empresa_galpao_id_from_preferenciais` também será removido nesse momento.
