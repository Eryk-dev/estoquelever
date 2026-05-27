# QA C5 — Realtime browser (2026-05-27) — **DEFERIDO**

**Status:** Não executado neste passe. Razão: requer 2 abas simultâneas no Playwright (tecnicamente possível) + um operador humano pra disparar eventos em uma aba enquanto cronometra latência na outra. Sem isso, o teste não tem sinal — Playwright em headless não consegue avaliar "card surgiu visualmente em <3s" sem comparar DOM antes/depois com cronometragem precisa.

## O que rodaria

2 abas em `/wms`, disparar evento numa, validar reação na outra:

1. Criar pedido novo → aba 2 contador "Aprovação" +1 em <3s
2. Aprovar pedido → aba 2 contador "Separação" +1
3. Cancelar pedido → aba 2 contador "Aprovação" -1
4. Criar pendência de guarda → aba 2 coluna "Guarda" ganha card
5. Concluir inventário → aba 2 coluna "Inventário" perde card
6. Receber NF compra → aba 2 coluna "Compras" muda contador fornecedor

## Validação alternativa (passou em Fix-P1)

Fix-P1 (2026-05-26) restaurou as 8 tabelas faltantes da publication `supabase_realtime` e validou via motor de insights que dispara via cron — 7 alertas ativos no primeiro tick após apply. O hook `useDashboardTarefasRealtime` foi estendido pra 8 tabelas com invalidate debounced 250ms. Em P5 a home `<QuadroTarefas>` ganhou `refetchInterval=30_000` como safety net.

Conclusão: **infra de realtime está em pé** (validado por Fix-P1). O QA browser end-to-end aqui descrito é um teste de UX (latência percebida), não de infra.

## Próximo passo

Não bloqueia merge. Rodar pre-release como parte do C4 smoke matrix (incluir abertura de 2 abas no roteiro de smoke).
