# QA C1 — Layout responsivo (2026-05-27)

**Ambiente:** staging `estoquelever.vercel.app` (branch `develop`).
**Método:** Playwright headless, 5 telas × 3 breakpoints = 15 capturas.
**Tela omitida:** inventário detalhe — sessão de inventário inexistente em staging na hora do QA.

## Breakpoints

- **mobile:** 375×667
- **tablet:** 768×1024
- **desktop:** 1440×900

## Resultados

### /wms (home)

- **mobile (375):** ✅ Sidebar collapsa pra menu hamburger. PageHeader empilha "Ajustar" + "Receber mercadoria" stacked. Pipeline cards (Aprovação/Separação/Embalagem) em coluna única, contadores legíveis. Sem overflow horizontal. Screenshot: `qa-c1-screenshots/wms-home-mobile.png`.
- **tablet (768):** ✅ Sidebar ainda em hamburger (esperado). Pipeline cards mantém coluna única — espaço sobra mas não quebra. Screenshot: `qa-c1-screenshots/wms-home-tablet.png`.
- **desktop (1440):** ✅ Sidebar expandida lateral. Cards distribuídos. Screenshot: `qa-c1-screenshots/wms-home-desktop.png`.

### /wms/separacao

- **mobile (375):** ✅ Tabs (Compras/Aguard.NF/Pra separar/Em separação/Separados/Embalados) viraram scroll horizontal — tab ativa centralizada. Filtros (marketplace/tags/data) empilham. Empty state legível. Screenshot: `qa-c1-screenshots/separacao-mobile.png`.
- **tablet (768):** ✅ Mesmo layout do mobile com mais respiro. Screenshot: `qa-c1-screenshots/separacao-tablet.png`.
- **desktop (1440):** ✅ Tabs em linha única, filtros em linha. Sidebar com seções VENDAS/VISIBILIDADE/OPERAÇÕES/INVENTÁRIO/INSIGHTS legíveis. Screenshot: `qa-c1-screenshots/separacao-desktop.png`.

### /wms/pedidos

- **mobile (375):** ✅ Tabs e listagem stacked. Sem overflow. Screenshot: `qa-c1-screenshots/pedidos-mobile.png`.
- **tablet (768):** ✅ Screenshot: `qa-c1-screenshots/pedidos-tablet.png`.
- **desktop (1440):** ✅ Screenshot: `qa-c1-screenshots/pedidos-desktop.png`.

### /wms/pedidos/937966021 (pedido detalhe)

- **mobile (375):** ✅ Header com título, marketplace+EC+cliente em linhas separadas. Cards STATUS/DECISÃO/ITENS/OPERADOR/GALPÃO empilham verticalmente. Botão "Copiar link" visível. Screenshot: `qa-c1-screenshots/pedido-detalhe-mobile.png`.
- **tablet (768):** ✅ Mesma estrutura com mais respiro. Screenshot: `qa-c1-screenshots/pedido-detalhe-tablet.png`.
- **desktop (1440):** ✅ Sidebar + main content. Cards em grid. Screenshot: `qa-c1-screenshots/pedido-detalhe-desktop.png`.

### /wms/guarda/rota

- **mobile (375):** ✅ Lista de pendências em coluna única. Screenshot: `qa-c1-screenshots/guarda-rota-mobile.png`.
- **tablet (768):** ✅ Screenshot: `qa-c1-screenshots/guarda-rota-tablet.png`.
- **desktop (1440):** ✅ Screenshot: `qa-c1-screenshots/guarda-rota-desktop.png`.

## Bugs encontrados

**Nenhum bug P0/P1 visualmente identificado.** Os 5 fluxos testados em 3 breakpoints renderizam sem overflow horizontal, clipping ou degradação funcional aparente. Todos os componentes principais (sidebar, page headers, tabs, cards, listas, botões de ação) respondem corretamente aos breakpoints.

**Limitações deste QA:**

- Avaliação **estática** via screenshots, sem interação (ex: abrir drawer, modal, sub-páginas).
- Sem dados em algumas das telas (separação tem fila vazia, guarda zero pendências) — bugs específicos de listagens longas (overflow em cards lotados, paginação responsiva) ficam pra suite manual.
- Inventário detalhe não avaliado (zero sessões em staging).
- Lighthouse (Performance/A11y/Best Practices) deferido em C2 — requer CLI separado.

## Conclusão

C1 = ✅ baseline responsivo OK nos 5 fluxos críticos × 3 viewports. Recomendação: re-rodar antes de cada release sob dados de produção (fila com 50+ pedidos, sidebar com role limitado, modais expostos) — possíveis regressões dinâmicas não foram cobertas neste passe estático.
