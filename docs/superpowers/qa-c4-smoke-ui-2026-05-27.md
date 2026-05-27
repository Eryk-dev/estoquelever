# QA C4 — Smoke matrix UI (2026-05-27) — **DEFERIDO**

**Status:** Não executado neste passe. Razão: 12 fluxos × 5-10min cada = 60-120min de interação humana em browser (criar pedido, aprovar, separar, embalar, expedir, criar venda manual, criar OC, receber, guardar, fazer ciclo de inventário, etc.). Não é viável via Playwright sem extensos roteiros pré-construídos.

## O que rodaria

Os 12 fluxos prescritos em [`docs/superpowers/plans/2026-05-26-wms-fix-p5-visibilidade-home-ui-fixes.md`](plans/2026-05-26-wms-fix-p5-visibilidade-home-ui-fixes.md) §5.16 (referência: §5.1 a §5.12 desse plano):

- Devolução classe C com select fornecedor
- Devolução detalhe via novo endpoint
- "Forçar pra separação (bypass NF)" label coerente
- Banner D10 estornar gated em P3 (admin only)
- Botão Recusar pedido fluxo limpo
- Guarda [id] botão explícito de iniciar
- FeedEventos para polling em sessão terminal
- LocalizacaoCombo no Receber sem create
- Imprimir-lote contagem `ignorados[]`
- Paginação client-side em /wms/pedidos + /wms/compras
- Vendas/nova toast `motivo_degradacao` + scaffold "criar em nome de"
- QuadroTarefas safety net 30s

## Próximo passo

Rodar como **QA pre-release**, não como gate de PR. Sugestão: capturar isso num runbook (`docs/runbooks/qa-smoke-release.md`) ao invés de doc por release.
