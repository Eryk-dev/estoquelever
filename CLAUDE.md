# SISO - Sistema Inteligente de Separacao de Ordens

## What This Project Is

A fullstack web app that replaces an n8n workflow for processing multi-company auto parts orders. Multiple companies (Empresas) — grouped by business affinity (Grupo) and operating across multiple physical warehouses (Galpoes) — sell on marketplaces (Mercado Livre, Shopee). When an order arrives via Tiny ERP webhook, the system checks stock across all companies in the same group and either auto-approves or routes to a human operator.

The system also handles the full post-approval workflow: separation (wave picking), packing, label printing, purchase orders (OC), and expedition.

**Volume:** ~500 orders/day across all companies.

## Working Environment (LEIA PRIMEIRO)

**Estamos trabalhando exclusivamente no ambiente de staging.** Toda alteração de schema, RPC, dado de teste ou query exploratória vai pra staging — nunca toque em prod sem pedido explícito do user.

| | Branch | Vercel deploy | Supabase project_id | Nome |
|---|---|---|---|---|
| **Ativo (staging)** | `develop` | `estoquelever.vercel.app` | `ehbxpbeijofxtsbezwxd` | "100M" |
| Prod (dormente) | `main` | — | `wrbrbhuhsaaupqsimkqz` | "parts-catalogs" |

- O Vercel mostra `Environment: production` mesmo nos deploys da `develop` — isso é só o "production deployment" do Vercel (o publicado), **não** indica ambiente prod-real. Confiar em `Branch:` do log, não em `Environment:`.
- `wrbrbhuhsaaupqsimkqz` aparece em vários lugares deste CLAUDE.md (Stack, env vars, exemplos antigos) por inércia histórica — ignore essas referências ao decidir onde aplicar mudanças. Source of truth é a tabela acima.
- Migrations: criar arquivo em `supabase/migrations/` + aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`.

## Direção Estratégica (firmada 2026-05-18 — atualizada 2026-05-18)

O app foi unificado sob o módulo **WMS**. Decisões arquiteturais não-negociáveis:

- **`/wms` é a porta de entrada.** Login redireciona direto pra `/wms`. A home (`/`) é apenas um redirect. **Nenhuma rota fora de `/wms` existe além de `/login`.**
- **Todas as APIs vivem em `/api/wms/*`.** Webhook do Tiny, OAuth callbacks, worker, separação, compras, cross, admin — tudo. A única exceção é `/api/auth/*` (login/me).
- **WMS é source of truth absoluta de estoque.** Todo saldo vive em `siso_estoque` + `siso_movimentacoes` (ledger imutável). A tabela `siso_pedido_item_estoques` (e todo o caminho legado de escrita) será descontinuada. Toda escrita de saldo passa por `wms_inserir_movimentacao`.
- **Tiny ERP é camada fiscal/marketplace apenas.** Tiny deixa de controlar estoque próprio — recebe saldo do SISO como *downstream sync* (fire-and-forget). Continua responsável por emissão de NF e propagação pra Mercado Livre / Shopee.
- **Fluxos físicos são eventos timestamped.** Recebimento e putaway são passos separados — saldo entra em `RECEBIMENTO` (staging), e a mov de transferência pra localização final só acontece quando o operador confirma o putaway. Cada movimentação é evento auditável no ledger.
- **Concorrência via reconciliação temporal.** Operações continuam durante inventário; aprovação de divergências calcula `saldo_esperado = saldo_no_bipe + Σ(movs entre contado_em e aprovado_em)` e só sinaliza divergência real se `qty_contada ≠ saldo_esperado`.
- **Realtime é cross-module.** Toda tabela que afeta operação ao vivo (`siso_estoque`, `siso_movimentacoes`, `siso_pedidos`, `siso_pedido_itens`, `siso_fila_execucao`, `siso_localizacao_locks`) entra na publication `supabase_realtime`. Clientes reagem por subscrição, não por polling.
- **Empresa dona deixou de ser coordenada física em 2026-05-20.** Estoque é 3D (produto × galpão × localização). Ledger carrega empresa como TAG em movs com NF (`empresa_compradora_id`, `empresa_vendedora_id`, `empresa_referencia_id`) + `fornecedor_id` + `custo_unitario`. Apuração por empresa = report (`/wms/relatorios/*`). Custo médio é global por produto (`siso_custo_medio`). Empréstimo/swap/mini-swap arquivados. Detalhes: `docs/superpowers/specs/2026-05-20-ledger-simplificado-design.md`.

**Cutover de superfície concluído em 2026-05-18 (commit `f8b7dbb`):** todas as páginas SISO legadas (`/siso`, `/separacao`, `/compras`, `/pedidos`, `/cross`, `/inventario`, `/transferencias`, `/configuracoes`, `/painel`, `/monitoramento`, `/etiquetas`, `/admin`) e suas APIs foram apagadas ou migradas pra `/api/wms/*`. Restam apenas pendências externas (URL do webhook no Tiny ERP, callbacks OAuth) e o cutover lógico (Plano 6) — que troca `webhook-processor.ts` → `webhook-processor-wms.ts` e `execution-worker.ts` → `execution-worker-wms.ts` pra escrever só no ledger.

## Stack

- **Framework:** Next.js 16.1.6 (App Router), React 19, TypeScript
- **Styling:** Tailwind CSS 4 (no component library — all custom)
- **Database:** Supabase — ambiente ativo é staging `ehbxpbeijofxtsbezwxd` (org `100M`). Prod `wrbrbhuhsaaupqsimkqz` (org `parts-catalogs`) está dormente. Ver seção "Working Environment" acima.
- **ERP:** Tiny ERP API v3 (OAuth2 via Keycloak)
- **Printing:** PrintNode API (thermal labels — ZPL + PDF)
- **State:** TanStack React Query (client), no global store
- **Realtime:** Supabase Realtime (used in separacao module)
- **UI libs:** Sonner (toasts), Lucide (icons), clsx + tailwind-merge
- **Fonts:** Outfit (sans) + JetBrains Mono (mono)

## Architecture

```
Tiny ERP webhook (POST)
    |
    v
/api/wms/webhook/tiny/route.ts   <-- validates, identifies empresa by CNPJ, dedup
    |                                 discriminates: pedido vs nota_fiscal
    |
    ├─ pedido ───> webhook-processor.ts
    |              resolves grupo, fetches order, enriches stock across ALL
    |              empresas in grupo, aggregates by galpao, calculates
    |              suggestion, saves to DB, auto-approves if propria
    |
    └─ nota_fiscal ───> nf-webhook-handler.ts
                        transitions pedido aguardando_nf → aguardando_separacao
                        reconciles NF that arrives before/after pedido

Pedidos (/wms/pedidos)            <-- operators see filtered orders, approve/reject
    |
    v
/api/wms/pedidos/aprovar          <-- enqueues stock-posting job
    |
    v
execution-worker.ts               <-- post-approval: deducts stock following tier order
    |                                  (cutover Plano 6 troca por execution-worker-wms.ts)
    v
Separacao (/wms/separacao)        <-- wave picking → checklist → packing → expedition
    |
    └─ /api/wms/separacao/*       <-- bipar, marcar, concluir, embalar, expedir, parcial
    └─ agrupamento-service.ts     <-- pre-creates Tiny agrupamentos, downloads ZPL
    └─ etiqueta-service.ts        <-- prints shipping labels via PrintNode

Compras (/wms/compras)            <-- purchase order management for OC decisions
    |
    └─ /api/wms/compras/*         <-- ordens, conferir, devolver, indisponivel
    └─ compras-release.ts         <-- when all items received → resume execution

Recebimento físico (/wms/receber + /wms/guarda)
    |
    └─ /api/wms/receber           <-- dock RECEBIMENTO (staging)
    └─ /api/wms/guarda/*          <-- put-away (etapa 2/2) — 1 mov par S+E por confirmação
```

### Domain Model: Empresa, Galpao, Grupo

**Importante:** empresa **não pertence** a um galpão. Toda empresa pode operar em **todos** os galpões. O que existe é **preferência** (geo-priority) via tabela N:N `siso_empresa_galpoes_preferenciais` — uma empresa pode ter 0..N galpões preferenciais.

- **Galpao**: physical warehouse location (e.g., CWB, SP). Independent of empresa.
- **Empresa**: Tiny ERP account with its own CNPJ (e.g., NetAir, NetParts, 141AIR, EasyPeasy, Bellator). Operates across all galpões; may have preferred galpões via `siso_empresa_galpoes_preferenciais` (geo-priority=0 in routing).
- **Grupo**: business affinity grouping (e.g., Autopecas). Empresas in the same grupo check stock across each other.
- **Tier**: deduction priority within a grupo. The empresa that received the order gets tier 1 override at runtime.

> ⚠️ A coluna `siso_empresas.galpao_id` é **DEPRECADA** — fica nullable e é apenas espelho do primeiro galpão preferencial (mantido por trigger pra compat de consumidores legados). **Não usar** essa coluna em código novo; consultar `siso_empresa_galpoes_preferenciais`.

### Current Data

| Empresa | CNPJ | Galpões preferenciais | Grupo | Tier |
|---|---|---|---|---|
| NetAir   | `34857388000163` | CWB | Autopecas | 1 |
| NetParts | `34857388000244` | SP  | Autopecas | 1 |
| 141AIR   | `56959528000147` | CWB | —         | — |
| EasyPeasy| `45341545000108` | CWB | —         | — |
| Bellator | `55973586000162` | (sem preferência fixa) | — | — |

### Decision Logic (per order, not per item)

1. Origin galpao has all items -> `propria` -> **auto-approve** (no human review)
2. Other galpao has all items -> `transferencia` -> human panel
3. Neither has everything, partial -> `propria` or `transferencia` (whichever covers more) -> human panel
4. Neither has any stock -> `oc` (purchase order) -> human panel

Auto-approval ONLY happens for case 1. Everything else goes to the operator panel.

### Separation Flow (post-approval)

```
aguardando_compra → aguardando_nf → aguardando_separacao → em_separacao → separado → embalado
```

- `aguardando_compra`: OC items not yet purchased
- `aguardando_nf`: waiting for Tiny nota fiscal webhook
- `aguardando_separacao`: ready for operator to start picking
- `em_separacao`: wave picking in progress (barcode scanning)
- `pendente_realocacao`: short pick happened and galpão has no coverage for remaining qty; needs supervisor action
- `separado`: picking complete, ready for packing
- `embalado`: packing done, ready for expedition

**Realocação cascateável (2026-05-18):** quando uma loc sugerida (original
ou realocação anterior) dá parcial/zerou, o sistema busca automaticamente
a próxima loc no galpão, excluindo todas as locs já tentadas no item. A
chain é rastreada via `siso_pedido_item_realocacoes.parent_realocacao_id`.
Cascade que esgota cobertura dispara o modal encaminhar/OC no frontend
(sem marcar `pendente_realocacao` automaticamente — operador decide).
Botão "Esgotado" das linhas normais removido — caso particular do Parcial
com qty=0 + loc_zerou=true. Spec: `docs/superpowers/specs/2026-05-18-realocacao-cascateavel-design.md`.

## Project Structure

**Pós-cutover de superfície (2026-05-18):** apenas `/login`, `/wms/*` e `/api/{auth,wms}/*` existem.

```
src/
  app/
    page.tsx                       # Redirect: autenticado → /wms, senão → /login
    layout.tsx                     # Root layout (Outfit + JetBrains Mono fonts) + Providers
    login/page.tsx                 # PIN login — após sucesso redireciona pra /wms
    api/
      auth/
        login/route.ts             # PIN auth (POST)
        me/route.ts                # Current session user (GET)
      wms/                         # ⬇ TODO O BACKEND vive aqui
        # ── Webhook + worker ──
        webhook/tiny/route.ts              # Webhook receiver (POST) — pedido + nota_fiscal
        webhook/reprocessar/route.ts       # Retry failed webhooks (POST)
        worker/processar/route.ts          # Execution worker trigger (POST/GET) — WORKER_SECRET
        # ── Pedidos ──
        pedidos/route.ts                   # List orders (GET)
        pedidos/tracking/route.ts          # Universal tracking list (GET)
        pedidos/aprovar/route.ts           # Order approval (POST) — enqueues execution
        pedidos/[id]/detalhe/route.ts      # Order detail consolidated (GET)
        pedidos/[id]/historico/route.ts    # Order history/audit trail (GET)
        pedidos/[id]/observacoes/route.ts  # Order comments (GET/POST)
        # ── Vendas Diretas (5 rotas) ──
        vendas/route.ts                    # List manual+ML/Shopee orders w/ auto-filter (GET)
        vendas/criar/route.ts              # Create manual order (POST) — modo separacao | baixa_direta (degrada pra separação se faltar saldo)
        vendas/disponibilidade/route.ts    # Resolve loc+dona+disponivel pra produto+galpão (GET)
        vendas/[id]/route.ts               # Sales order detalhe (GET)
        vendas/[id]/vendedor/route.ts      # Re-assign vendedor (PATCH)
        # ── Separação (29 rotas) ──
        separacao/route.ts                 # List separation orders with counts (GET)
        separacao/iniciar/route.ts         # Start separation (POST)
        separacao/bipar/route.ts           # Barcode scan during picking (POST)
        separacao/bipar-checklist/route.ts # Barcode scan in checklist phase (POST)
        separacao/marcar-item/route.ts     # Mark item picked (POST) — gera mov ledger WMS
        separacao/desfazer-bip/route.ts    # Undo a barcode scan (POST)
        separacao/concluir/route.ts        # Complete separation (POST)
        separacao/concluir-oc/route.ts     # Complete OC separation (POST)
        separacao/bipar-embalagem/route.ts # Barcode scan during packing (POST)
        separacao/bipar-embalagem-oc/route.ts  # Barcode scan packing OC items (POST)
        separacao/confirmar-item-embalagem/route.ts  # Confirm item packed (POST)
        separacao/expedir/route.ts         # Dispatch order (POST)
        separacao/retry-etiqueta/route.ts  # Retry label printing after failure (POST)
        separacao/checklist-items/route.ts # Get checklist items (GET)
        separacao/encaminhar/route.ts      # Forward order to another galpão (POST)
        separacao/cancelar/route.ts        # Cancel separation (POST)
        separacao/reiniciar/route.ts       # Restart separation (POST)
        separacao/voltar-etapa/route.ts    # Go back one step (POST)
        separacao/tags/route.ts            # Manage separacao tags (GET/POST)
        separacao/produto-esgotado/route.ts          # Mark product out of stock (POST)
        separacao/validar-oc-item/route.ts           # Validate OC item (POST)
        separacao/reimprimir/route.ts                # Reprint label (POST)
        separacao/forcar-pendente/route.ts           # Force orders pending (batch POST)
        separacao/[pedidoId]/forcar-pendente/route.ts # Force single pending (PATCH)
        separacao/localizacao/route.ts               # Update product location (POST)
        separacao/parcial/route.ts                   # Parcial: 2 movs + re-busca cascade (POST)
        separacao/marcar-realocacao/route.ts         # Confirma pick da realocação no WMS (POST)
        separacao/realocacao/[id]/route.ts           # Cancela realocação pendente (DELETE)
        separacao/desfazer-parcial/route.ts          # Estorna parcial + reseta campos (POST)
        # ── Compras (16 rotas) ──
        compras/route.ts                   # List purchase items (GET)
        compras/comprar/route.ts           # Mark items purchased by SKU (POST)
        compras/receber/route.ts           # Receive/consolidate purchases (POST)
        compras/preparar-embalagem/route.ts          # Stage orders for packing (POST)
        compras/trocar-sku/route.ts                  # Change product SKU (POST)
        compras/ordens/route.ts                      # List POs by supplier (GET)
        compras/conferir/route.ts                    # DEPRECATED (POST)
        compras/conferencia/[ordemCompraId]/route.ts # Receive items for PO (GET/POST)
        compras/pedidos/[pedidoId]/cancelar/route.ts # Cancel purchase decision (POST)
        compras/itens/[itemId]/indisponivel/route.ts # Mark item unavailable (POST)
        compras/itens/[itemId]/devolver/route.ts     # Return received item (POST)
        compras/itens/[itemId]/cancelamento/route.ts          # Propose cancelamento (POST)
        compras/itens/[itemId]/cancelamento/confirmar/route.ts # Confirm cancelamento (POST)
        compras/itens/[itemId]/equivalente/route.ts           # Propose equivalente SKU (POST)
        compras/itens/[itemId]/equivalente/confirmar/route.ts # Confirm equivalente (POST)
        compras/itens/[itemId]/trocar-fornecedor/route.ts     # DEPRECATED (POST)
        # ── Cross (14 rotas) ──
        cross/search/route.ts              # GET busca (SKU/OEM/nome)
        cross/produtos/[sku]/route.ts      # GET detalhe (com lazy fetch Tiny)
        cross/produtos/[sku]/refetch/route.ts        # POST atualizar do Tiny
        cross/produtos/[sku]/oems/route.ts           # POST adicionar OEM
        cross/produtos/[sku]/oems/[codigo]/route.ts  # DELETE remover OEM
        cross/produtos/[sku]/veiculos/route.ts       # POST adicionar veículo
        cross/produtos/[sku]/veiculos/[id]/route.ts  # DELETE remover veículo
        cross/produtos/[sku]/equivalentes-rapidos/route.ts # GET equivalências curtas
        cross/produtos/[sku]/estoque/route.ts        # GET estoque agregado
        cross/produtos/[sku]/has-cross/route.ts      # GET flag rápida
        cross/produtos/[sku]/links/route.ts          # GET/POST links manuais
        cross/produtos/[sku]/links/[skuAlvo]/route.ts # DELETE link manual
        cross/sugestoes/marcas/route.ts              # GET sugestão de marcas
        cross/sugestoes/modelos/route.ts             # GET sugestão de modelos
        # ── Admin (galpões, empresas, grupos, usuários, printnode) ──
        admin/usuarios/route.ts            # User CRUD (GET/POST/PUT/DELETE)
        admin/galpoes/route.ts             # Galpao CRUD (GET/POST) — GET inclui hierarquia
        admin/galpoes/[id]/route.ts        # Galpao by ID (PUT/DELETE)
        admin/empresas/route.ts            # Empresa CRUD (GET/POST)
        admin/empresas/[id]/route.ts       # Empresa by ID (PUT/DELETE)
        admin/grupos/route.ts              # Grupo CRUD — SISO legacy (mantido pra compat)
        admin/grupos/[id]/route.ts         # Grupo by ID
        admin/grupos/[id]/empresas/route.ts            # Add empresa to grupo
        admin/grupos/[id]/empresas/[empresaId]/route.ts # Tier / remove
        admin/printnode/contas/route.ts            # Contas PrintNode CRUD (GET list, POST create)
        admin/printnode/contas/[id]/route.ts       # PATCH (label/key/ativo) + DELETE
        admin/printnode/contas/[id]/test/route.ts  # POST — testa key via /whoami (body opcional `{api_key}` pra testar antes de salvar)
        admin/printnode/printers/route.ts          # GET — impressoras agregadas de todas contas ativas, agrupadas por conta
        admin/backfill-agrupamentos/route.ts # Backfill Tiny agrupamentos (admin)
        admin/backfill-lvr/route.ts        # Backfill LVR (admin)
        # ── Tiny OAuth ──
        tiny/connections/route.ts          # Tiny connections CRUD (empresa-scoped)
        tiny/test-connection/route.ts      # Test Tiny connection
        tiny/deposits/route.ts             # List Tiny deposits per empresa
        tiny/stock/ajustar/route.ts        # Adjust stock in Tiny
        tiny/oauth/route.ts                # OAuth2 initiation (step 1)
        tiny/oauth/callback/route.ts       # OAuth2 callback (step 2)
        # ── Mercado Livre ──
        ml/anuncios/route.ts               # ML anúncios sync (GET)
        ml/app/route.ts                    # ML app config (GET/PATCH)
        ml/connections/route.ts            # ML connections CRUD
        ml/connections/[id]/route.ts       # ML connection by ID
        ml/connections/[id]/test/route.ts  # Test ML connection
        ml/oauth/route.ts                  # ML OAuth2 initiation
        ml/oauth/callback/route.ts         # ML OAuth2 callback
        # ── WMS core (estoque, ledger, localizações) ──
        produtos/route.ts                  # GET (list/search), POST (create)
        produtos/[id]/route.ts             # GET, PATCH
        produtos/[id]/sync/route.ts        # POST — força sync com Tiny
        produtos/[id]/kit/route.ts         # GET/POST kit components
        produtos/[id]/ultimas-contagens/route.ts  # GET — última contagem por loc+dona
        produtos/backfill-imagens/route.ts # POST — backfill de imagens (admin)
        localizacoes/route.ts              # GET (por galpão), POST
        localizacoes/lote/route.ts         # POST — cria em lote com preview
        localizacoes/[id]/route.ts         # PATCH, DELETE (protege saldo>0)
        localizacoes/[id]/saldos/route.ts  # GET — saldos > 0
        localizacoes/[id]/substituir-e-excluir/route.ts # POST — move tudo + desativa
        estoque/route.ts                   # GET ?view=dono|galpao|localizacao|produto
        ledger/route.ts                    # GET — histórico imutável
        snapshot-inicial/route.ts          # POST (admin, idempotente, ?dryRun=true)
        reconciliacao/route.ts             # GET (worker-secret, ?fix=true)
        # ── WMS movimentações operacionais ──
        receber/route.ts                   # POST — dock RECEBIMENTO + cria pendências
        guarda/route.ts                    # GET — fila put-away (filtros)
        guarda/rota/route.ts               # GET — fila ordenada por loc destino
        guarda/[id]/route.ts               # GET — detalhe da pendência
        guarda/[id]/iniciar/route.ts       # POST — marca status='em_guarda'
        guarda/[id]/confirmar/route.ts     # POST — mov par S+E RECEBIMENTO→loc destino
        guarda/[id]/cancelar/route.ts      # POST — cancela com motivo
        guarda/[id]/imprimir/route.ts      # POST — imprime etiqueta de produto
        guarda/imprimir-lote/route.ts      # POST — imprime maço inteiro
        transferir-galpao/route.ts         # POST — transferência inter-galpão
        transferencias/route.ts            # GET — lista + sessões
        transferencias/[id]/cancelar/route.ts # POST
        transferencias/[id]/receber/route.ts  # POST
        replenishment/route.ts             # POST — replenishment intra-galpão
        ajuste/route.ts                    # POST — ajuste manual com motivo
        lancamento-retroativo/route.ts                   # POST/GET — registrar + listar
        lancamento-retroativo/[id]/reconciliar/route.ts  # POST — reconcilia com mov real
        # ── WMS fornecedores ──
        fornecedores/route.ts              # GET, POST
        fornecedores/[id]/route.ts         # PATCH, DELETE (soft)
        fornecedores/auto-cadastro/route.ts # POST (admin) — semeia mapeamento canônico
        produto-fornecedores/route.ts      # GET (?produto_id=), POST
        produto-fornecedores/[id]/route.ts # PATCH, DELETE (soft)
        rotear/route.ts                    # POST — testa algoritmo de roteamento
        reservas/cleanup/route.ts          # GET (worker secret) — libera reservas expiradas
        # ── WMS relatórios (apuração por empresa via tags em movs) ──
        relatorios/movs-por-empresa/route.ts    # GET — filtra movs por empresa_compradora|vendedora|referencia
        relatorios/historico-custo/route.ts     # GET — série temporal custo_medio_anterior/posterior por produto
        relatorios/saldos-por-empresa/route.ts  # GET — recompõe saldo "virtual" por empresa a partir das movs
        # ── WMS inventário (v2 pull queue) ──
        inventario/route.ts                # GET (lista), POST (criar)
        inventario/sugerir/route.ts        # POST — sugestão inteligente
        inventario/[id]/route.ts           # GET, PATCH, DELETE
        inventario/[id]/iniciar/route.ts   # POST — inicia sessão
        inventario/[id]/party/route.ts     # POST entrar + DELETE sair da party
        inventario/[id]/proxima-loc/route.ts         # POST — pull queue
        inventario/[id]/localizacoes/[locId]/finalizar/route.ts # POST — finaliza loc
        inventario/[id]/aprovar/route.ts   # POST — computa divergências + aprova
        inventario/[id]/aprovar-sessao/route.ts # POST — aprova sessão inteira
        inventario/[id]/aplicar/route.ts   # POST — gera movs origem='inventario'
        inventario/[id]/contagens/route.ts # POST — registra contagem
        inventario/[id]/divergencias/route.ts # GET, PATCH
        inventario/[id]/eventos/route.ts   # GET — feed classificado verde/amarelo/vermelho pro supervisor
        inventario/metricas/route.ts       # GET — RPCs operador+localização
        inventario/cleanup/route.ts        # GET (worker secret) — libera locks órfãos
        # ── WMS exceções + dashboards + insights ──
        devolucoes/route.ts                # GET fila pendente
        devolucoes/[id]/classificar/route.ts # POST classificação A/B/C/D
        cobertura/route.ts                 # GET (filtros)
        cobertura/refresh/route.ts         # GET (worker secret) — refresh MV
        dashboard-geral/route.ts           # GET — agrega 7 contadores
        dashboard-tarefas/route.ts         # GET — 6 cards da home /wms (contadores + executores)
        insights/hub/route.ts              # GET — dashboard hub de insights
        insights/pessoas/route.ts          # GET — lista pessoas + KPIs
        insights/pessoas/[id]/route.ts     # GET — detalhe pessoa
        insights/fluxo/route.ts            # GET — fluxo operacional
        insights/estoque/route.ts          # GET — insights de estoque
        insights/financeiro/route.ts       # GET — insights financeiros
        insights/devolucoes/route.ts       # GET — insights de devoluções
        insights/regras/route.ts           # GET/POST — CRUD de regras
        insights/regras/[id]/route.ts      # PATCH, DELETE
        insights/regras/[id]/test/route.ts # POST — testa regra
        insights/refresh/route.ts          # POST (worker secret) — refresh agregados
        insights/ativos/[id]/dispensar/route.ts # POST — dispensa alerta ativo
    wms/                                   # ⬇ TODO O FRONTEND vive aqui
      layout.tsx                           # WmsShell + sidebar de navegação
      page.tsx                             # Home WMS — 4 cards (catálogo/locs/saldos/ledger)
      wms.css                              # Estilos do shell
      pedidos/page.tsx + [id]/page.tsx     # Order tracking + detalhe
      vendas/page.tsx + nova/page.tsx + [id]/page.tsx  # Vendas Diretas — listagem, criar venda (page completa), detalhe
      separacao/page.tsx + checklist + embalagem  # Wave picking flow
      compras/page.tsx                     # Compras (Comprar/Receber tabs)
      cross/page.tsx + [sku]/page.tsx      # Cross — busca + detalhe OEMs/veículos
      produtos/page.tsx                    # Catálogo unificado
      localizacoes/page.tsx                # CRUD localizações por galpão
      estoque/page.tsx                     # Saldos em 4 perspectivas
      ledger/page.tsx                      # Histórico imutável
      receber/page.tsx                     # Etapa 1/2 — dock RECEBIMENTO
      guarda/page.tsx + rota + [id]        # Etapa 2/2 — put-away (handheld)
      transferir/page.tsx                  # Transferência inter-galpão
      replenishment/page.tsx               # Replenishment intra-galpão
      ajuste/page.tsx                      # Ajuste manual com motivo
      retroativos/page.tsx                 # Pendências de reconciliação retroativa
      fornecedores/page.tsx                # CRUD fornecedores
      cobertura/page.tsx                   # Cobertura por giro
      devolucoes/page.tsx + [id]/page.tsx  # Classificação A/B/C/D
      dashboard/page.tsx                   # Dashboard geral (4 cards, refresh 30s)
      inventario/page.tsx + [id]/...       # Sessões + supervisor + handheld + divergências
      inventario/metricas/page.tsx         # Acuracidade por operador/localização
      insights/page.tsx + subrotas         # Hub + pessoas + fluxo + estoque + financeiro + ...
      relatorios/                          # Apuração por empresa (3D)
        movs-por-empresa/page.tsx          # Movs filtradas por compradora/vendedora/referência
        historico-custo/page.tsx           # Série temporal de custo médio por produto
        saldos-por-empresa/page.tsx        # Saldo "virtual" recomposto por empresa
      configuracoes/page.tsx + conexoes    # Settings + OAuth (aba "otimizações" removida em 2026-05-20)
  components/
    app-shell.tsx, app-header.tsx          # Shell wrappers (auth + header)
    galpao-selector.tsx                    # Dropdown filtro galpão
    sw-register.tsx                        # Service worker registration
    providers.tsx                          # QueryClientProvider + Toaster
    ui/                                    # Componentes genéricos (tabs, empty-state, spinner, etc.)
    wms/                                   # ⬇ TODOS os components específicos vivem aqui
      wms-shell.tsx                        # Sidebar de navegação (6 grupos: Vendas/Visibilidade/Operações/Inventário/Insights/Cadastros)
      sidebar-galpao-switcher.tsx          # Trocador de galpão na sidebar
      produto-drawer.tsx                   # Drawer de detalhe de produto
      saldo-perspectiva-tabs.tsx           # Tabs entre as 3 perspectivas (galpão/loc/produto)
      tripla-picker.tsx                    # Seletor galpão+localização (3D, renomeado em 2026-05-20)
      scan-contagem.tsx                    # Input de bipe pro inventário
      configuracoes-types.ts               # Types compartilhados das telas de config
      ml-anuncios-block.tsx                # Bloco de anúncios ML
      cross/cross-popover-button.tsx       # Popover Cross reutilizável
      separacao/parcial-modal.tsx          # Modal qty + loc zerou (Parcial)
      separacao/types.ts                   # SeparacaoPedido + CompraStatsData types
      inventario/loc-vazia-modal.tsx       # Modal "está vazia?" handheld
      inventario/feed-eventos.tsx          # Feed ao vivo classificado pro supervisor
      configuracoes/aba-*.tsx              # Abas das configurações
      vendas/pedido-card-wms.tsx           # Card de pedido (WMS-styled)
      ui/{modals,wms-ui}.tsx               # Modais reutilizáveis (Receber/Ajuste/Transferir/Realocar)
  lib/
    # ── Webhook + worker (escreve no caminho legado siso_pedido_item_estoques) ──
    webhook-processor.ts                   # Core: fetch → enrich → calc → save
    webhook-processor-wms.ts               # Versão WMS-first (Plano 6 cutover, ainda dormante)
    nf-webhook-handler.ts                  # nota_fiscal webhooks → aguardando_separacao
    execution-worker.ts                    # Post-approval: deduct stock por tier
    execution-worker-wms.ts                # Versão WMS-first (Plano 6 cutover, ainda dormante)
    empresa-lookup.ts                      # CNPJ → empresa (cached 5min)
    grupo-resolver.ts                      # Resolve grupo, tier order, aggregate stock
    # ── Compras ──
    compras-release.ts                     # All OC items received → resume execution
    compras-equivalencia.ts                # Equivalente SKU resolution
    compras-embalagem.ts                   # Staging compras → packing
    compras-utils.ts                       # Allowed cargos, field reset
    # ── Separação (short pick + re-alocação) ──
    separacao/
      wms-mapping.ts                       # Resolve Tiny produto/loc → uuids WMS
      realocacao-resolver.ts               # Cascade re-busca (empresa → tipo loc → qty)
      *.test.ts                            # Testes unitários
    # ── Cross (catálogo e equivalência) ──
    cross/types.ts, oem-extractor.ts, produto-fetcher.ts, catalogo-queries.ts
    # ── Tiny ERP integration ──
    tiny-api.ts                            # Tiny ERP API v3 client (com fallback tiny-stub)
    tiny-stub.ts                           # Stub completo do Tiny pra staging (TINY_DISABLED=true)
    tiny-oauth.ts                          # OAuth2 token management — getValidTokenByEmpresa()
    tiny-queue.ts                          # Rate limiting per empresa_id
    rate-limiter.ts                        # Underlying rate limiter
    sku-fornecedor.ts                      # SKU prefix → supplier/galpao
    # ── Mercado Livre ──
    ml-api.ts, ml-oauth.ts, ml-anuncios.ts
    # ── Printing & labels ──
    agrupamento-service.ts                 # Pre-cria Tiny agrupamentos + baixa ZPL
    etiqueta-service.ts                    # Print shipping labels via PrintNode
    etiqueta-download.ts                   # Download/extract ZPL de ZIP do Tiny
    printnode.ts                           # PrintNode API client (PDF + ZPL)
    # ── Auth & sessions ──
    auth-context.tsx                       # AuthProvider + useAuth + sisoFetch
    session.ts                             # Server-side session validation
    # ── Infrastructure ──
    historico-service.ts                   # Order audit trail
    config.ts                              # System config KV store
    domain-helpers.ts                      # UI helpers
    supabase.ts, supabase-server.ts        # Clients
    logger.ts                              # Structured logger
    utils.ts                               # cn() helper
  hooks/
    use-realtime-separacao.ts              # Supabase Realtime — separação
    use-inventario-realtime.ts             # Supabase Realtime — inventário
  types/index.ts                           # Central type definitions
supabase/
  migrations/                              # Database migrations (YYYYMMDD_description.sql)
scripts/
  seed-cross-catalogo.ts                   # Seed inicial Cross
  wms-seed-test.ts                         # Seed pra validar pipeline WMS

# ─── WMS library (src/lib/wms/) — toda lógica de negócio WMS ────────────
src/lib/wms/
    types.ts                       # Produto, Localizacao, EstoqueLinha, Movimentacao, Tripla, PerspectivaEstoque
    ledger.ts                      # inserirMovimentacao() + validarCoerencia() (3D, metadata por empresa em movs)
    ledger.test.ts                 # Unit tests da lógica do ledger
    custo-medio.ts                 # Cache global de custo médio por produto (siso_custo_medio)
    produtos.ts                    # CRUD do catálogo unificado
    localizacoes.ts                # CRUD de localizações por galpão
    estoque.ts                     # Queries de saldos com 3 perspectivas (galpão / loc / produto)
    sync-tiny.ts                   # Sincroniza siso_produtos com Tiny
    snapshot-inicial.ts            # Bulk-load idempotente do Tiny (Fase 0)
    reconciliacao.ts               # Detecta + corrige divergências ledger↔cache
    putaway.ts                     # Heurística de sugestão de localização
    movimentacoes.ts               # Helpers: receber, transferir, replenishment, ajuste, retroativo
    fornecedores.ts                # CRUD fornecedores + auto-cadastro mapeamento sku-fornecedor
    roteamento.ts                  # Algoritmo PURO (geo-priority) + rotearPedidoDoBanco
    reservas.ts                    # Reservas atômicas com TTL + cleanup
    inventario.ts                  # v2 pull queue (slots + claim hierárquico)
    inventario-reconciliacao.ts    # Função PURA: reconcilia temporalmente (cutoff_em + saldo_no_bipe via ledger)
    inventario-recovery.ts         # Detecta sessões e locks órfãos
    devolucoes.ts                  # Classificação A/B/C/D + recálculo de custo médio
    cobertura.ts                   # Service de cobertura por giro
    dashboard-geral.ts             # Agrega contadores cross-módulo
    guarda.ts                      # Lógica de put-away (resolverLocRecebimento + confirmar)
    zpl-produto.ts                 # ZPL pra etiqueta de produto (PW800, 2-por-folha)
    etiqueta-produto-service.ts    # ZPL + PrintNode (fire-and-forget no recebimento)
    api-client.ts                  # Cliente fetch wrapper consumido pelas páginas /wms
    _archive/                      # Código histórico — arquivado em 2026-05-20 com o ledger simplificado 3D
      emprestimos.ts, mini-swap.ts, mini-swap-types.ts, mini-swap.test.ts (e correlatos)
```

## Database Tables (Supabase)

All tables are prefixed with `siso_`:

### Core Tables

| Table | Purpose |
|---|---|
| `siso_pedidos` | Orders with stock enrichment, suggestion, status, separation status. Has `empresa_origem_id` FK. `separacao_tags text[]` for user-created tags (separate from Tiny `marcadores`). `status_separacao` includes `pendente_realocacao` (short pick without coverage). |
| `siso_pedido_itens` | Per-item data (unique: `pedido_id + produto_id`). Has legacy `estoque_cwb_*`/`estoque_sp_*` columns + normalized FK. New cols: `quantidade_pega`, `separacao_parcial`, `parcial_motivo/em/por`, `mov_saida_id`, `mov_ajuste_loc_zerou_id`. |
| `siso_pedido_item_estoques` | **Primary stock source.** Normalized stock per empresa (pedido_id, produto_id, empresa_id). API reads from here. |
| `siso_pedido_item_realocacoes` | Re-allocation rows created when a short pick zeroes a location and another location must be used. FK to `siso_pedido_itens`. Status: `aguardando_picking`, `picado`, `cancelado`. |
| `siso_fila_execucao` | Execution queue with empresa_id, retry logic, exponential backoff |
| `siso_usuarios` | Users with name, PIN, cargo, active flag, printnode printer config |
| `siso_sessoes` | Server-side sessions (id, usuario_id, expira_em) |
| `siso_pedido_historico` | Immutable audit trail (evento, detalhes, timestamps) |
| `siso_ordens_compra` | Purchase orders by supplier |
| `siso_inventarios` | Inventory sessions with empresa, galpao, mode, stock type, status lifecycle |
| `siso_inventario_itens` | Per-item scan data (SKU, location, qty). No unique constraint — same SKU can appear multiple times |
| `siso_transferencias` | Inter-galpão transfer sessions with origin/destination empresa+galpao+deposito |
| `siso_transferencia_itens` | Per-item transfer data (SKU, qty, clonado flag for auto-created products) |

### Hierarchy Tables

| Table | Purpose |
|---|---|
| `siso_galpoes` | Physical locations (id, nome unique, descricao, ativo, printnode config). WMS adds: cidade, estado, pais |
| `siso_empresas` | Tiny ERP accounts (id, nome, cnpj unique, ativo). **`galpao_id` é DEPRECADO** (mantido nullable como espelho do primeiro preferencial via trigger). Empresa não pertence mais a um galpão. |
| `siso_empresa_galpoes_preferenciais` | **N:N opcional** (empresa_id, galpao_id, PK composta). Galpões preferenciais (geo-priority=0 no roteamento). Empresa pode ter 0..N. Trigger AFTER mantém `siso_empresas.galpao_id` espelhando primeiro preferencial (ordem alfabética por nome) pra compat de consumidores legados. |
| `siso_grupos` | Business affinity groups (id, nome unique) — usado pelo SISO legacy, não pelo WMS. |
| `siso_grupo_empresas` | N:1 empresa→grupo with tier (empresa_id unique) — SISO legacy. |

### WMS Tables (Plano 1 — Foundation)

Schema 3D (a partir de 2026-05-20): cada posição de estoque é única por **(produto, galpão, localização)**. Empresa deixou de ser coordenada física — passa a viajar como TAG em movs com NF (`empresa_compradora_id` / `empresa_vendedora_id` / `empresa_referencia_id`).

| Table | Purpose |
|---|---|
| `siso_produtos` | **Catálogo unificado.** id, sku unique, descricao, gtin, imagem_url, unidade, ncm, cest, origem_fiscal, sincronizado_em, ativo |
| `siso_produto_empresas` | Mapeamento N:N produto↔empresa com tiny_produto_id (PK composto produto_id+empresa_id, UNIQUE empresa_id+tiny_produto_id) |
| `siso_localizacoes` | Localizações dentro do galpão (id, galpao_id FK, codigo, tipo: picking/overstock/recebimento/expedicao/quarentena, ativo). UNIQUE(galpao_id, codigo) |
| `siso_estoque` | **Cache materializado** da posição atual. saldo, reservado, disponivel (GENERATED saldo-reservado). UNIQUE `siso_estoque_unique_3d (produto_id, galpao_id, localizacao_id)`. CHECK reservado<=saldo. Sem `empresa_dona_id` e sem `custo_medio` (custo migrou pra `siso_custo_medio`). |
| `siso_movimentacoes` | **Ledger imutável.** Tipo (E/S/R/L) + saldo_anterior/posterior + reservado_anterior/posterior + `origem_tipo` (CHECK enumera 18 valores: nf_compra, devolucao_cliente_integra/avariada, devolucao_fornecedor_recebida/enviada, nf_venda, venda_manual, ajuste_manual, ajuste_pick_zerou, inventario_perda/ganho/inicial, transferencia_galpao/localizacao, reserva_pedido, liberacao_reserva, lancamento_retroativo, estorno) + observacoes + estorno_de. **Metadata por empresa/fornecedor**: `empresa_compradora_id`, `empresa_vendedora_id`, `empresa_referencia_id`, `fornecedor_id`, `motivo`, `cliente_nome`, `custo_unitario`, `custo_medio_anterior`, `custo_medio_posterior` (todos nullable). CHECKs garantem coerência aritmética. |
| `siso_custo_medio` | **Cache global de custo médio por produto.** PK `produto_id`, `custo_medio numeric NOT NULL CHECK ≥ 0` (default 0), `ultima_movimentacao_id` FK pra `siso_movimentacoes`, `atualizado_em`. Atualizado pelo RPC em toda entrada com `custo_unitario`. Substitui `siso_estoque.custo_medio` (4D). Tabela entra na publication `supabase_realtime`. |

**RPC `wms_inserir_movimentacao(...)`** (3D): única forma de escrever no ledger. Lock pessimista via `SELECT FOR UPDATE`, valida saldo/reservado, insere mov, atualiza cache atomicamente. Em entradas com `custo_unitario`, recalcula custo médio ponderado e grava `custo_medio_anterior`/`custo_medio_posterior` na mov + atualiza `siso_custo_medio`.

**RPC `wms_detectar_divergencias_estoque()` / `wms_rebuild_linha_estoque(p_id)`** (3D): reconciliação ledger↔cache. Endpoint `/api/wms/reconciliacao` (worker-secret) é cron-friendly.

### WMS Tables (Plano 3 — Roteamento)

| Table | Purpose |
|---|---|
| `siso_fornecedores` | Fornecedores únicos (nome unique, prefixo_sku, cnpj, lead_time_dias_min/medio/max nullable). 11 cadastrados via auto-cadastro do mapeamento canônico. Lead time aqui é **default**: ao vincular um produto via `vincularProdutoFornecedor`/`upsertProdutoFornecedor` (sync Tiny) sem lead_time explícito, herda esses valores. |
| `siso_produto_fornecedores` | Relação produto↔fornecedor com lead_time min/medio/max + custo_unitario + qty_minima_pedido + multiplo_compra + flag preferencial. UNIQUE(produto, fornecedor). Lead time pode ser sobrescrito por produto; defaults vêm de `siso_fornecedores` no insert. |
| `siso_localizacao_locks` | Locks operacionais de localização (cycle_count, contagem_completa, manutencao). UNIQUE parcial WHERE finalizado_em IS NULL. |

> Tabela `siso_emprestimo_regras` **dropada em 2026-05-20** com o ledger simplificado 3D. Empresas não são mais coordenada física — não há débito/crédito entre elas. Apuração por empresa = report sobre tags de movs (`/api/wms/relatorios/*`).

**RPC `wms_reservar_atomico(...)`** (3D): wrapper sobre `wms_inserir_movimentacao` com tipo='R', expira_em=now()+ttl_horas. Retorna mov_id.

### WMS Tables (Plano 4 — Inventário v2: pull queue + slots)

**v2 rewrite (2026-05-12):** trocamos divisão estática por áreas (causava operador ocioso) por pool compartilhado com pull queue. Operadores assumem slots OP1-OP5 e puxam locs sob demanda com smart routing. Realtime via Supabase Realtime.

| Table | Purpose |
|---|---|
| `siso_inventario_sessoes` | Sessão master. nome (opcional), tipo cycle_count\|completo, modo aberto\|blind (default blind, sem duplo_blind), tolerancia_pct, exige_aprovacao_acima_valor, tamanho_pool. Status workflow: planejada→em_andamento→revisao→aprovada→aplicada\|cancelada. |
| `siso_inventario_operadores` | Party dinâmica de operadores ativos. **Sem slot numerado** — identidade = `usuario_id`. UNIQUE parcial (sessao_id, usuario_id) WHERE finalizado_em IS NULL evita duplicação. Reentrada (após `sairParty`) reativa registro existente: zera `finalizado_em`, seta `ultima_reentrada_em`, preserva `locs_contadas`. **+ Claim hierárquico ativo**: `claim_tipo` (rua\|predio\|colisao\|NULL), `claim_codigo` (ex: 'A' ou 'A-03'), `claim_direcao` (asc\|desc), `claim_atualizado_em`. Trigger BEFORE UPDATE limpa claim quando `finalizado_em` é setado (sairParty). |
| `siso_inventario_localizacoes` | Pool de locs da sessão (sem area_id, sem slot_atribuido). status pendente\|em_contagem\|contada\|divergente\|aprovada (sem recontagem). motivo (curva_a\|divergente_recente\|sem_contagem_recente\|manual\|completo). bloqueada_por + bloqueada_em pra lock atômico por operador. contagem_iniciada_em + contagem_finalizada_em pra cálculo de tempo médio. |
| `siso_inventario_contagens` | Cada bipe individual. Sem `rodada` (1 contagem por loc). Indexada por tripla (produto, galpão, localização) — sem empresa_dona desde 2026-05-20. Múltiplos operadores podem contar a mesma loc (caso edge: sairSlot mid-loc), `computarDivergencias` soma todas as contagens da tripla. |
| `siso_inventario_divergencias` | Saldo sistema vs contagem final por tripla. delta + delta_pct GENERATED. Status: pendente\|aprovada\|rejeitada\|aplicada (sem recontagem_solicitada). mov_aplicada_id liga ao ledger ao aplicar. |

Ajustes em `siso_localizacoes`: ADD `ultima_contagem_em timestamptz` (trigger atualiza em cada bipe — usado pela sugestão inteligente) + `zona text` (override manual pro roteamento; default = prefixo antes do "-").

### WMS Tables (Plano 5 — Exceções+Dashboards)

| Table | Purpose |
|---|---|
| `siso_devolucoes_pendentes` | Fila de NFs de entrada esperando classificação física. UNIQUE parcial em nota_fiscal_id e chave_acesso_nf (dedup webhook re-entregue). Status: aguardando_classificacao→classificada→aplicada\|cancelada. |

### WMS Tables (Recebimento em 2 etapas — 2026-05-14)

| Table | Purpose |
|---|---|
| `siso_wms_pendencias_guarda` | Fila de pendências de put-away. 1 linha por linha de recebimento (preserva NF/lote). `qty_pendente = qty_inicial - qty_guardada` GENERATED. Status: pendente → em_guarda → guardada\|cancelada. Indexada por (galpao_id, status, criada_em). Trigger atualiza `atualizada_em`. CHECK garante coerência (guardada exige qty_guardada=qty_inicial+guardada_em). |

> Tabela `siso_wms_mini_swap_config` e RPCs `wms_executar_mini_swap` / `wms_executar_swap` **dropadas em 2026-05-20** com o ledger simplificado 3D. Mini-swap intra-galpão e swap N×N entre empresas perderam o sentido — não há mais empresa dona física a consolidar. Código arquivado em `src/lib/wms/_archive/mini-swap*.ts`.

Ajustes em `siso_galpoes` + `siso_usuarios`: ADD `printnode_printer_id_produto bigint` + `printnode_printer_nome_produto text` — impressora dedicada pra etiqueta de produto, com fallback pra impressora de envio se vazia.

### PrintNode multi-conta (2026-05-19)

| Table | Purpose |
|---|---|
| `siso_printnode_contas` | Contas PrintNode (multi-key). `(id, label UNIQUE, api_key, ativo)`. Substitui `siso_configuracoes['PRINTNODE_API_KEY']`. |

Ajustes em `siso_galpoes` + `siso_usuarios`: ADD `printnode_account_id uuid FK ON DELETE SET NULL` + `printnode_account_id_produto uuid FK ON DELETE SET NULL` — apontam pra conta dona da impressora. `resolverImpressora`/`resolverImpressoraProduto` fazem JOIN com `siso_printnode_contas` pra carregar a `api_key` certa ao enviar o print job. Migration `20260519_printnode_multi_contas` migra a key existente pra uma conta `'Default'` (zero downtime).

Loc auto-criada: a migration semeia 1 `siso_localizacoes` tipo='recebimento' (`codigo='RECEBIMENTO'`) por galpão ativo se não existir uma.

**Materialized view `siso_cobertura_estoque`** (3D — recriada em 2026-05-20): agrega disponivel por (produto, galpão) + giro 30d + lead time fornecedor preferencial → `status_cobertura` (ok\|atencao\|critico\|lead_time_risco\|sem_giro). Refresh via `wms_refresh_cobertura()`.

**RPC `wms_inventario_proxima_loc(p_sessao, p_user)`**: pull queue com **claim hierárquico**. Endereço = rua-prédio-andar (3 segmentos do código). Operador "reivindica" uma unidade e desce nela até esgotar. Algoritmo:
1. **FASE 1**: tem claim ativo (`claim_tipo` IS NOT NULL)? Procura próxima loc dentro do claim respeitando `claim_direcao` (asc default, desc só em colisão).
2. **FASE 2a — claim de rua livre**: rua sem nenhum op (claim ou em_contagem); escolhe a com mais pendentes.
3. **FASE 2b — prédio com buffer ≥1**: prédio livre com gap ≥1 prédio de qualquer ativo. Se a rua tem outro op com claim 'rua', **auto-degrade** o claim dele pra 'predio' (no prédio atual).
4. **FASE 2c — prédio sem buffer**: pega o prédio mais distante de qualquer ativo (maximiza distância mesmo violando buffer).
5. **FASE 2d — último prédio + colisão controlada**: se sobra exatamente 1 prédio com pendentes E ele já tem 1 op, permite 2º entrar com `claim_tipo='colisao'` + `claim_direcao='desc'` (entra pela ponta oposta). Máx 2 ops simultâneos. 3º vai pro pool_vazio.
6. Senão → `{ pool_vazio: true }`.

Helpers: `wms_loc_rua(codigo)` ('A-03-02' → 'A'), `wms_loc_predio(codigo)` ('A-03-02' → 'A-03'), `wms_loc_horizontal_int(codigo)` ('A-03-02' → 3). Lock atômico via `FOR UPDATE OF inv_loc SKIP LOCKED`. Retorna `claim_tipo`/`claim_codigo`/`claim_direcao` no payload pra UI mostrar status do operador. Em modo aberto, anexa SKUs esperados.

**RPC `wms_inventario_sugerir(p_galpao, p_tamanho)`** (3D — assinatura sem `p_empresa_dona` desde 2026-05-20): algoritmo de sugestão inteligente. Mix 50% locs com produtos curva A (giro 30d via `siso_curva_abc`) + 30% locs com divergências aplicadas nos últimos 60d + 20% locs sem contagem em 30d+ (ou nunca contadas). Filtra apenas locs com saldo > 0. Dedupe automático (loc só aparece em uma categoria, priorizada por peso).

**RPCs métricas**: `wms_metricas_operador()` (acuracidade 30d por user) + `wms_metricas_localizacao()` (cobertura+erro 5000 últimas localizações).

**Materialized view `siso_curva_abc`** (3D — recriada em 2026-05-20): ranking ABC automático via giro 30d (movs origem `nf_venda` + `venda_manual`, não-estornadas). Função `wms_refresh_curva_abc()` pra cron job de refresh.

### Infrastructure Tables

| Table | Purpose |
|---|---|
| `siso_tiny_connections` | Tiny API connections per empresa. Has `empresa_id` FK. |
| `siso_webhook_logs` | Webhook dedup + processing status (unique: `dedup_key`). Has `empresa_id` FK. |
| `siso_api_calls` | API call tracking. Has `empresa_id` FK. |
| `siso_logs` | Structured application logs (info/warn/error) |
| `siso_erros` | **Dedicated error tracking** with stack traces, categories, correlation IDs, resolution tracking. Queryable for diagnostics. |
| `siso_configuracoes` | Key-value config store |

### Cross Module Tables

| Table | Purpose |
|---|---|
| `siso_produtos_catalogo` | Cache de produtos do Tiny (módulo Cross) |
| `siso_produto_oems` | Códigos OEM por produto (com audit) |
| `siso_produto_veiculos` | Compatibilidade veicular por produto (com audit) |
| `siso_cross_logs` | Telemetria de buscas no Cross |

> **Note:** `siso_pedido_itens` still has deprecated `estoque_cwb_*` / `estoque_sp_*` columns. The API reads from `siso_pedido_item_estoques` (normalized). The webhook processor writes to both for backwards compat. Legacy columns will be removed in a future migration.

## Reports (Apuração por Empresa — 3D)

Com o ledger simplificado, apuração por empresa virou **report sobre tags de movs** em vez de coordenada física. 3 endpoints + 3 páginas:

| Endpoint | Page | Purpose |
|---|---|---|
| `GET /api/wms/relatorios/movs-por-empresa` | `/wms/relatorios/movs-por-empresa` | Movs filtradas por `empresa_compradora_id` / `empresa_vendedora_id` / `empresa_referencia_id` + intervalo de data + origem_tipo |
| `GET /api/wms/relatorios/historico-custo` | `/wms/relatorios/historico-custo` | Série temporal de `custo_medio_anterior` → `custo_medio_posterior` por produto, reconstruída a partir das entradas com `custo_unitario` |
| `GET /api/wms/relatorios/saldos-por-empresa` | `/wms/relatorios/saldos-por-empresa` | Saldo "virtual" por empresa recomposto a partir das movs: Σ entradas com `empresa_compradora_id=X` − Σ saídas com `empresa_vendedora_id=X`. Não é coordenada física, é um corte contábil sobre o ledger. |

## Key Domain Concepts

### Roles & Permissões (dinâmico)

Acesso é controlado por **roles editáveis** no UI (`/wms/configuracoes/roles`). Cada role tem um conjunto de permissões (granularidade módulo + ação) do registry em `src/lib/permissions.ts` (31 permissões em 8 módulos).

**Roles padrão (sistema=true, não-deletáveis):**
- `admin` — todas 31 permissões
- `operador` — vendas (exceto criar), separação, compras.ver, estoque, cobertura, operações, inventário ver/executar, insights.ver, relatórios, cadastros
- `operador_cwb` / `operador_sp` — idem `operador` (galpão é dimensão à parte, não permissão)
- `comprador` — pedidos.ver, compras.*, estoque, cobertura, relatórios
- `vendedor` — vendas.ver, vendas.criar

**Cargo legado:** colunas `siso_usuarios.cargo` e `siso_usuarios.cargos[]` ficam nullable como espelho do `siso_usuario_roles` (trigger AFTER mantém sincronizado). Código novo **sempre** checa permissão (`userCan(session, "compras.executar")`), nunca cargo (`cargos.includes("comprador")`).

**Check de acesso no código:**
- Backend: `import { userCan } from "@/lib/permissions"; if (!userCan(session, "perm.x")) return 403;`
- Frontend: `const { can } = usePermissoes(); if (!can("perm.x")) return <SemAcesso />;`
- Sidebar: items em `wms-shell.tsx` têm `requires: PermissaoCodigo[]`.

**Spec/plan:** `docs/superpowers/specs/2026-05-21-roles-permissoes-design.md` + `docs/superpowers/plans/2026-05-21-roles-permissoes.md`.

### Order Statuses
- `pendente` — awaiting operator decision
- `executando` — being processed
- `concluido` — finished
- `cancelado` — cancelled via webhook
- `erro` — processing failed

### Decisions (Decisoes)
- `propria` — fulfilled by origin galpao
- `transferencia` — inter-galpao transfer needed
- `oc` — purchase order from supplier

### Stock Data Model

Stock is stored normalized in `siso_pedido_item_estoques` (one row per empresa per item). The API aggregates by galpão and returns a dynamic `estoques: Record<string, GalpaoEstoque>` map keyed by galpão name. This supports any number of galpões without hardcoded references.

### SKU-to-Supplier Mapping
| Prefix | Supplier | Default Galpao |
|---|---|---|
| `19` | Diversos | CWB |
| `EW`, `TG` | Tiger | SP |
| `LD` | LDRU | SP |
| `L0` | LEFS | SP |
| 6-digit numeric | ACA | CWB |
| `GB`, `GE`, `GS`, `GI` | GAUSS | CWB |
| `MK`, `M0`, `B0` | MRMK | SP |
| `CAK`, `CS` | Delphi | SP |
| `KT` | Kintop | SP |
| `MQ`, `APX`, `WDC`, `AT`, `FD`, `FI`, `GM`, `HO`, `HY`, `KI`, `MAN`, `MB`, `NI`, `PG`, `RN`, `SC`, `TO`, `UN`, `VO`, `VW`, `AG`, `BI`, `BA` | Multiqualita | CWB |

## Environment Variables

Required in `.env.local` (use credenciais do projeto staging ativo — ver "Working Environment"):
```
NEXT_PUBLIC_SUPABASE_URL=https://ehbxpbeijofxtsbezwxd.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # Required for server-side operations
```

Optional:
```
WORKER_SECRET=<secret>   # Protects POST /api/wms/worker/processar + cron endpoints
TINY_DISABLED=true       # Staging only — routes all Tiny API calls to tiny-stub.ts
```

OAuth2 credentials for Tiny are stored in the `siso_tiny_connections` table (not env vars).
PrintNode suporta múltiplas contas (uma key por conta) via `siso_printnode_contas`. Galpões e usuários guardam `printnode_account_id` (+ `_produto`) pra lembrar qual key usar ao imprimir. A entrada legacy `siso_configuracoes['PRINTNODE_API_KEY']` foi migrada pra uma conta `Default` em 2026-05-19.

## Development Commands

```bash
npm run dev       # Start dev server (turbopack)
npm run build     # Production build
npm run start     # Start production server
npm run lint      # ESLint
```

## Authentication

- No Supabase Auth — uses custom PIN-based auth
- Login: `POST /api/auth/login` with `{ nome, pin }` (este é o **único** endpoint fora de `/api/wms/*`)
- Após login, redireciona direto pra `/wms` (não passa por home)
- Session: server-side `siso_sessoes` table + `X-Session-Id` header
- Client persists session in localStorage (`siso_user` key)
- `sisoFetch` wrapper in `auth-context.tsx` auto-sends session header
- Server validates via `getSessionUser()` in `session.ts`
- Seed user: `Eryk / 1234 / admin`

## Documentation

The `docs/` directory contains comprehensive, ground-truth documentation generated from source code:

| Document | Purpose | When to consult |
|---|---|---|
| [`docs/api-reference-complete.md`](docs/api-reference-complete.md) | **All API routes** (175+ em `/api/wms/*` + 2 em `/api/auth/*`) — method, path, auth, request/response shapes, business logic, side effects | Before making any API change; understanding any endpoint contract |
| [`docs/database-schema.md`](docs/database-schema.md) | **All 20+ tables** — columns, types, FKs, indexes, constraints, ER diagram (Mermaid), migration history | Before writing migrations; understanding data model; debugging queries |
| [`docs/architecture-and-flows.md`](docs/architecture-and-flows.md) | **System architecture** — webhook pipeline, state machines, separation/compras/inventario/transfer flows, Tiny/PrintNode integration, auth, error handling | Understanding business flows; onboarding; debugging cross-module issues |
| [`docs/fluxos-siso.md`](docs/fluxos-siso.md) | **Visual flow diagrams** — Mermaid state machines and flowcharts for all business processes | Quick visual reference for status transitions and decision logic |
| [`docs/api-reference.md`](docs/api-reference.md) | Legacy API reference (may be incomplete) | Superseded by `api-reference-complete.md` — kept for reference |

### MANDATORY: Keeping Documentation Updated

**When you modify any API route**, update `docs/api-reference-complete.md` in the same commit:
- Adding a new route -> add full documentation entry
- Changing request/response shape -> update the documented shapes
- Adding/removing query params or body fields -> update the docs
- Changing auth requirements -> update the docs
- Changing business logic or side effects -> update the docs
- Removing a route -> remove from docs

**When you modify database schema** (new migration, alter table, new index), update `docs/database-schema.md` in the same commit.

**When you change any business flow** (state transitions, decision logic, webhook handling, separation steps, compras flow, auth, label printing), update both `docs/architecture-and-flows.md` and `docs/fluxos-siso.md` in the same commit.

**When you modify `CLAUDE.md` itself** (project structure, conventions, architecture), ensure it stays consistent with the docs above.

**When you add new lib services**, update the Project Structure section in this file.

Failure to update documentation means the next developer or LLM will work with stale information and introduce bugs.

## Coding Conventions

### General
- TypeScript strict mode. All types in `src/types/index.ts`.
- Portuguese for domain terms (pedido, filial, cargo, decisao, galpao, empresa, grupo). English for technical terms (webhook, token, logger).
- File and function names in English (e.g., `empresa-lookup.ts`, `getEmpresaByCnpj`).
- No barrel exports. Import directly from the source file.
- Stock data is dynamic per galpão — never hardcode "CWB" or "SP" in type definitions or rendering logic.

### Frontend
- All pages are `"use client"` except layout.
- Tailwind classes directly on elements (no CSS modules, no styled-components).
- Design: zinc-based neutral palette, dark mode supported, mobile-first (max-w-3xl).
- Icons: only Lucide (`lucide-react`). No SVG files except favicon.
- Toasts: `sonner` (via `toast.success()`, `toast.error()`).
- No component library (no shadcn, no Radix). All components are custom.
- `AppShell` wraps all pages for consistent layout and auth.

### Backend (API Routes)
- Next.js App Router route handlers (`route.ts` with named exports `GET`, `POST`, etc.).
- All DB access via `createServiceClient()` from `supabase-server.ts` (service role).
- Error responses: `NextResponse.json({ error: "..." }, { status: N })`.
- Logging via `logger.info/warn/error(source, message, meta?)` — never `console.log` directly.
- **Error logging:** Use `logger.logError(opts)` for actual errors — writes to both `siso_logs` and `siso_erros` with stack traces, categories, correlation IDs. See `ErrorLogOptions` in `logger.ts`.
- **Error categories:** `validation`, `database`, `external_api`, `auth`, `config`, `business_logic`, `infrastructure`, `unknown`.
- **Correlation IDs:** Generated at webhook entry via `generateCorrelationId()`, auto-attached to all `logError` calls in the same request.
- Webhook processor is fire-and-forget (returns 200 immediately, processes async).
- History events recorded via `registrarEvento()` — fire-and-forget safe.

### Error Knowledge Base
- **`erros-conhecidos.yaml`** at project root tracks every error that was diagnosed and fixed.
- **MANDATORY:** When you fix any error or bug, add an entry to `erros-conhecidos.yaml` following the format in the file (id, date, source, category, message, cause, fix, files, tags).
- **Before debugging:** Always check `erros-conhecidos.yaml` first — the error may have been fixed before.
- Tags are searchable keywords for fast lookup.

### Database
- All tables prefixed with `siso_`.
- Migrations in `supabase/migrations/` with format `YYYYMMDD_description.sql`.
- Upserts for idempotency (dedup on unique constraints).

## Current Status

### Fully Working
- Full order pipeline (webhook → stock check → approval → execution)
- Separation/picking/packing flow with barcode scanning and real-time updates
- Advanced purchase order management (v2):
  - SKU-based purchasing with supplier consolidation (comprar tab)
  - Receiving with validation and exceptions (receber tab)
  - Equivalente SKU resolution for unavailable items
  - Cancelamento workflow with credit notes
  - Preparation/staging orders for packing (preparar-embalagem)
- Label printing via PrintNode (ZPL + PDF)
- Galpao/Empresa/Grupo hierarchy CRUD with tier-based stock deduction
- Operational dashboard (painel/operacao) with real-time wave picking status
- Management dashboard (painel/gerencial) with KPIs and analytics
- User management with role-based access control (admin, operador_cwb/sp, comprador)
- Tiny OAuth2 connection management per empresa
- NF webhook reconciliation (aguardando_nf transition)
- OC auto-resolution in wave picking (concluir-oc endpoint)
- Módulo Cross: busca universal de produtos (SKU/OEM/nome), edição de OEMs e veículos com audit, equivalência por OEM compartilhado, lazy fetch do Tiny + refresh manual

### In Progress / Minor
- Real-time notifications for new pending orders (polling at 30s for now)
- PWA service worker registration (basic structure in place)
- **WMS Fase 0 (Foundation) — implementado, validado em staging** (projeto Supabase `ehbxpbeijofxtsbezwxd`). Schema 4D original + ledger imutável + RPC com lock + 4 telas de visualização (catálogo, localizações, saldos por 4 perspectivas, ledger). Dependente de promoção pra prod (Fase 1+ ainda pendente). Spec: `docs/superpowers/specs/2026-05-07-wms-design.md`. Plano executado: `docs/superpowers/plans/2026-05-08-wms-1-foundation.md`. > **Nota 2026-05-20**: schema migrado pra 3D — ver bullet "WMS Ledger Simplificado 3D" abaixo.
- **WMS Plano 2 (Movimentações operacionais) — implementado, validado em staging.** 5 fluxos (receber, transferir inter-galpão, replenishment intra-galpão, ajuste manual com motivo, lançamento retroativo + reconciliação) + sugestão automática de putaway + recálculo de custo médio em entradas com custo. Validação E2E: receber 50 + ajustar -10 = saldo 40, 0 divergências. Plano: `docs/superpowers/plans/2026-05-15-wms-2-movimentacoes.md`.
- **WMS Plano 3 (Roteamento) — implementado, validado em staging.** Schema fornecedores + matriz de empréstimos N×N (com limites por par+produto) + algoritmo de roteamento puro com geo-priority (home=0, mesma_cidade=1, mesmo_estado=2, outro=3) + reservas atômicas com TTL 48h + cleanup cron-friendly + shadow logging no webhook (legado vs novo, sem mudar comportamento). 9 testes de roteamento + 3 de reservas. Plano: `docs/superpowers/plans/2026-05-22-wms-3-roteamento.md`.
- **WMS Plano 4 v1 (Inventário robusto) — substituído por v2 em 2026-05-12.** Schema original tinha divisão estática por "áreas" (1 área = 1 operador, locs pré-atribuídas), o que causava operador ocioso quando um terminava antes dos outros. Plano original: `docs/superpowers/plans/2026-05-29-wms-4-inventario.md`.

- **WMS Plano 4 v2 (Inventário pull queue + slots) — implementado em staging, 2026-05-12.** Mudança fundamental: pool compartilhado em vez de divisão estática. Operadores assumem slots OP1-OP5 dinâmicos e puxam próxima loc sob demanda. Sugestão inteligente via RPC `wms_inventario_sugerir` (mix 50% curva A + 30% divergentes recentes + 20% sem contagem 30d+) — roda sob demanda quando supervisor abre "Cycle Inteligente". 3 tipos de sessão: Inteligente / Manual / Completo (estruturalmente idênticas, só muda quem escolhe o pool de locs). Modo aberto|blind (default blind). Sem recontagem mid-flow — divergências aparecem no relatório do supervisor após encerrar. Tela handheld: slot picker → botão "PRÓXIMA LOC" → confirmar (QR ou manual) → bipar produtos → finalizar → loop → resumo final. Encerrar parcial: supervisor pode encerrar antes do pool esgotar — modal escolhe entre subir parcial ou cancelar tudo. Migration: `supabase/migrations/20260512_wms_inventario_rewrite.sql`. **Refatorado 2026-05-18 — modelo party:** dropados `siso_inventario_operadores.slot` e `siso_inventario_sessoes.num_operadores`. Operadores agora são lista dinâmica sem cap rígido — identidade = usuário, reentrada preserva `locs_contadas`. Rotas `/slots/*` viram `/party`. Migration: `supabase/migrations/20260518_wms_inventario_party_model.sql`. Spec: `docs/superpowers/specs/2026-05-18-inventario-party-model-design.md`.

- **WMS Inventário · Claim hierárquico (rua > prédio > buffer > colisão) — implementado em staging, 2026-05-13.** Substitui o slot_atribuido / LPT / smart routing por zonas. Modelo: endereço = rua-prédio-andar (3 segmentos do código); operador "reivindica" uma unidade (rua livre → prédio com buffer ≥1 → prédio sem buffer → colisão controlada no último prédio com max 2 ops + distância vertical máxima) e desce nela até esgotar. Auto-degrade: quando 2º op é forçado a entrar numa rua claimed por colega, o claim do colega cai pra 'predio'. Buffer físico (≥1 prédio de gap entre ops na mesma rua) vale sempre, nos 3 tipos de sessão. Sem `slot_atribuido` — distribuição 100% dinâmica via RPC `wms_inventario_proxima_loc` reescrita. Schema: 4 colunas claim_* em `siso_inventario_operadores` + trigger limpa claim em sairSlot. Frontend mostra "rua A ↓", "prédio A-03 ↓" ou "prédio A-03 ↑ (compartilhando)" no painel do supervisor e na tela do operador. Migration: `supabase/migrations/20260513_wms_inventario_claim_hierarquico.sql`.
- **WMS Inventário · Reconciliação temporal (estoque online) — implementado em 2026-05-18.** Algoritmo `reconciliarTemporal` reconstrói saldo no instante do bipe usando `siso_movimentacoes.saldo_anterior` da primeira mov após `T_ref`. Pure function testada por TDD (16+ testes em `inventario-reconciliacao.test.ts`). `computarDivergencias` agora faz snapshot `cutoff_em` e delega cálculo. Handheld ganha modal "loc vazia?" pra distinguir loc visitada-vazia de não-visitada. Supervisor ganha feed ao vivo classificado (verde/amarelo/vermelho) em `/api/wms/inventario/[id]/eventos`. Spec: `docs/superpowers/specs/2026-05-18-estoque-online-fluxo.html`. Plano: `docs/superpowers/plans/2026-05-18-estoque-online.md`.
- **WMS Plano 5 (Exceções + dashboards) — implementado, validado em staging. Encerra Fase 0.** Devoluções classificadas A/B/C/D com recálculo de custo médio + transferência pra QUARENTENA + RMA. Troca SKU na separação (2 movs com mesma origem_id) com validação Cross opcional. Webhook NF detecta devolução (best-effort). Materialized view `siso_cobertura_estoque` com status crítico/atenção/lead_time_risco/ok/sem_giro. Dashboard geral (4 cards, refresh 30s). Shell e home reorganizados em 4 grupos. Plano: `docs/superpowers/plans/2026-06-05-wms-5-excecoes-dashboards.md`. Checklist Fase 0: `docs/superpowers/plans/wms-fase0-checklist.md`. **Próximo: Plano 6 (cutover big bang).**
- **WMS Recebimento em 2 etapas (Recebimento + Guarda) — implementado em staging, 2026-05-14.** Quebra o recebimento em duas fases pra alinhar com o fluxo físico: dock RECEBIMENTO (chega caminhão, registra qty) → guarda no tablet (imprime etiqueta, bipa QR da loc destino, confirma). 1 pendência em `siso_wms_pendencias_guarda` por linha de recebimento. Suporta guarda parcial (qty<qty_pendente fica aberta) + cancelamento com motivo. Etiqueta de produto em ZPL pareado 2-por-folha (`gerarZplProduto` em `src/lib/wms/zpl-produto.ts`), N etiquetas por unidade. Impressora dedicada de produto (`printnode_printer_id_produto`) com fallback automático pra impressora de envio se não configurada. Migration: `supabase/migrations/20260514_wms_guarda_pendencias.sql`. APIs: `/api/wms/guarda` (lista + detalhe + iniciar/confirmar/cancelar/imprimir + imprimir-lote bulk).
  - **Entrada direta (2026-05-19):** flag `entrada_direta` em `/api/wms/receber` (tanto no modal individual quanto no lote em `/wms/receber`) pula o dock RECEBIMENTO e grava 1 mov direto na `localizacao_destino_id` de cada item — sem criar pendência. Exige loc destino em **todos** os itens (frontend bloqueia o confirm e mostra alerta em vermelho se faltar). Impressão de etiqueta segue funcionando: `/api/wms/guarda/imprimir-lote` ganhou um modo alternativo `{ linhas: [{produto_id, galpao_id, qty, localizacao_id?}] }` pra cobrir o caso sem pendência. Pra casos onde o operador já vai guardando direto na prateleira (pequenas entradas, lançamento retroativo, achados).
- **WMS Mini-Swap Intra-Galpão** — **arquivado em 2026-05-20** com o ledger simplificado 3D. Empresa deixou de ser coordenada física, não há mais o que swappear/consolidar entre empresas no mesmo galpão. Código preservado em `src/lib/wms/_archive/mini-swap*.ts` pra referência histórica.
- **WMS Ledger Simplificado 3D — rollout em 2026-05-20.** Substitui o schema 4D (produto × dona × galpão × loc) por 3D (produto × galpão × loc). Empresa passa a ser TAG em movs com NF (`empresa_compradora_id`, `empresa_vendedora_id`, `empresa_referencia_id`) + `fornecedor_id` + `custo_unitario`. Custo médio migrou pra cache global `siso_custo_medio` (PK produto_id). 3 RPCs reescritas (`wms_inserir_movimentacao`, `wms_reservar_atomico`, `wms_inventario_proxima_loc/sugerir`), 2 MVs recriadas (`siso_cobertura_estoque`, `siso_curva_abc`), 2 tabelas dropadas (`siso_emprestimo_regras`, `siso_wms_mini_swap_config`), 3 RPCs dropadas (`wms_executar_mini_swap`, `wms_executar_swap`, `wms_saldos_devedores`). Apuração por empresa virou report (`/wms/relatorios/movs-por-empresa`, `/historico-custo`, `/saldos-por-empresa`). Frontend: páginas `/wms/emprestimos` e `/wms/configuracoes/otimizacoes` removidas; `QuadruplaPicker` → `TriplaPicker`; sidebar com novo grupo "Relatórios". Migration: `supabase/migrations/20260520_ledger_simplificado*.sql`. Spec: `docs/superpowers/specs/2026-05-20-ledger-simplificado-design.md`. Plano: `docs/superpowers/plans/2026-05-20-ledger-simplificado-3d.md`.
- **Vendas Diretas + role vendedor — implementado em 2026-05-19.** Nova aba `/wms/vendas` agregando pedidos manuais inseridos por vendedores + marketplaces rastreados (ML, Shopee). Cargo `vendedor` adicionado à whitelist. 2 modos de criação: (a) `separacao` — pula NF e entra direto em `status_separacao='aguardando_separacao'`; (b) `baixa_direta` — sistema gera mov `'S'` no ledger via `wms_inserir_movimentacao(origem_tipo='venda_manual')` com rollback manual em caso de falha. `webhook-processor.ts` auto-atribui `vendedor_nome='{nome_ecommerce} {empresa_nome}'` pra ML/Shopee, preservando atribuição manual em re-entregas (SELECT-then-update). Sidebar com visibility por cargo (vendedor só vê Vendas Diretas). Migration: `supabase/migrations/20260519_vendas_diretas_vendedor.sql`. Rotas: `POST /api/wms/vendas/criar`, `GET /api/wms/vendas`, `GET /api/wms/vendas/[id]`, `PATCH /api/wms/vendas/[id]/vendedor`. Funciona em ambiente WMS (staging hoje); em prod só funciona modo `separacao` até promoção das tabelas WMS.
  - **Auto-resolve loc + page completa (2026-05-19):** criação de venda saiu do modal e virou page completa em `/wms/vendas/nova`. Vendedor não escolhe mais empresa dona nem localização — escolhe **1 galpão** pro pedido inteiro e o sistema resolve via novo helper `resolverDisponibilidadeVenda` em `src/lib/wms/vendas-disponibilidade.ts` (ordem: empresa origem com saldo > tipo='picking' > maior disponivel). Novo endpoint `GET /api/wms/vendas/disponibilidade?produto_id=X&galpao_id=Y&empresa_origem_id=Z` alimenta a UI mostrando "Loc sugerida + qty disponível" read-only por item. `POST /api/wms/vendas/criar` mudou contrato: `galpao_id` no top-level, `items[]` só carrega `{produto_id, quantidade}`. **Degradação automática**: se vendedor pediu `baixa_direta` mas algum item não tem saldo no galpão, pedido inteiro vira `aguardando_separacao` (igual marketplace sem estoque); resposta inclui `degradado:true, motivo_degradacao:'falta_saldo', skus_sem_saldo:[]`. Modal antigo `src/components/wms/vendas/form-criar-pedido.tsx` deletado.
- **Quadro de Tarefas Pendentes na home `/wms` — implementado em 2026-05-21, refatorado pra kanban vertical em 2026-05-21.** A home `/wms` agora é **apenas** PageHeader + QuadroTarefas (as 5 seções de navegação Visibilidade/Operações/Inventário/Relatórios/Cadastros foram removidas — já estão na sidebar). **Pipeline do pedido** (Aprovação · Separação · Embalagem) fica no topo como 3 cards de contador. **Guarda · Inventário · Compras** viraram um kanban vertical de 3 colunas lado a lado, cada coluna com cards empilhados verticalmente: cada pendência de guarda é um card (SKU + qty + status + avatar + tempo na fila, truncado em 50 por coluna), cada ciclo de inventário é um card com barra de progresso (`locs_contadas / locs_total`), e Compras agrupa por fornecedor (1 card por fornecedor com `a_comprar / a_receber`). Colunas vazias mostram placeholder dashed dim (clicável). Endpoint: `GET /api/wms/dashboard-tarefas?galpao_id?` — retorna `guarda.itens[]`, `inventario.ciclos[]` e `compras.fornecedores[]` além dos contadores. Realtime via Supabase em 5 tabelas (`siso_pedidos`, `siso_wms_pendencias_guarda`, `siso_inventario_sessoes`, `siso_inventario_operadores`, `siso_pedido_itens`). Spec: `docs/superpowers/specs/2026-05-21-quadro-tarefas-home-design.md`. Plano: `docs/superpowers/plans/2026-05-21-quadro-tarefas-home.md`.

### Deprecated / To Remove
- Cleanup deprecated `estoque_cwb_*`/`estoque_sp_*` columns from `siso_pedido_itens` (API reads from normalized table)
- Remove deprecated `/api/wms/compras/conferir` (replaced by comprar/receber flow)
- Remove deprecated `/api/wms/compras/itens/[itemId]/trocar-fornecedor` (replaced by `compras-equivalencia.ts`)
- Plano 6 (cutover lógico) — trocar `webhook-processor.ts` → `webhook-processor-wms.ts` + `execution-worker.ts` → `execution-worker-wms.ts` pra escrever só no ledger e descontinuar `siso_pedido_item_estoques`.

### Recently Removed (2026-05-18 — commit `f8b7dbb`)
- Páginas legadas: `/siso`, `/separacao`, `/compras`, `/pedidos`, `/cross`, `/inventario`, `/transferencias`, `/configuracoes`, `/painel`, `/monitoramento`, `/etiquetas`, `/admin`, `/fix-login` (todos têm equivalente em `/wms`)
- APIs órfãs: `/api/{painel,monitoring,dashboard,reconciliacao,inventario,transferencia,etiquetas-endereco}`
- Componentes legados: `components/{compras,configuracoes,cross,etiquetas,inventario,pedido,separacao,transferencia}`
- Libs deprecated: `cnpj-filial.ts`, `filtrar-pedidos.ts`, `inventario-processor.ts`, `transferencia-processor.ts`, `reconciliacao.ts`, `zpl-endereco.ts`, `data/mock*.ts`
- Renomeações: `/api/{separacao,compras,cross,admin,tiny,ml,webhook,worker,pedidos}/*` → `/api/wms/$1/*`

## Tiny ERP API Notes

- API v3 base: `https://api.tiny.com.br/public-api/v3`
- OAuth2 via Keycloak: `https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect`
- Token lifetime is short — auto-refresh with 60s buffer before expiry
- Deposits (warehouses) are fetched from stock endpoint — there is NO dedicated `/depositos` endpoint
- Rate limiting: per-empresa, managed by `rate-limiter.ts`
- Stock response has `depositos[]` array — pick the matching deposit by configured `deposito_id`
- **Always consult `api tiny.json` in project root** for endpoint details
- Responses do NOT have a `{ data: ... }` wrapper
- Trade name field = `fantasia`
- Product status values: `A` (active), `I` (inactive), `E` (excluded)
