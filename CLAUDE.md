# SISO - Sistema Inteligente de Separacao de Ordens

## What This Project Is

A fullstack web app that replaces an n8n workflow for processing multi-company auto parts orders. Multiple companies (Empresas) grouped by physical location (Galpao) and business affinity (Grupo) sell on marketplaces (Mercado Livre, Shopee). When an order arrives via Tiny ERP webhook, the system checks stock across all companies in the same group and either auto-approves or routes to a human operator.

The system also handles the full post-approval workflow: separation (wave picking), packing, label printing, purchase orders (OC), and expedition.

**Volume:** ~500 orders/day across all companies.

## Stack

- **Framework:** Next.js 16.1.6 (App Router), React 19, TypeScript
- **Styling:** Tailwind CSS 4 (no component library — all custom)
- **Database:** Supabase (project `wrbrbhuhsaaupqsimkqz`, org `parts-catalogs`)
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
/api/webhook/tiny/route.ts       <-- validates, identifies empresa by CNPJ, dedup
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

Dashboard (/siso)                 <-- operators see filtered orders, approve/reject
    |
    v
/api/pedidos/aprovar              <-- enqueues stock-posting job
    |
    v
execution-worker.ts               <-- post-approval: deducts stock following tier order
    |
    v
Separacao (/separacao)            <-- wave picking → checklist → packing → expedition
    |
    └─ /api/separacao/*           <-- bipar, marcar, concluir, embalar, expedir
    └─ agrupamento-service.ts     <-- pre-creates Tiny agrupamentos, downloads ZPL
    └─ etiqueta-service.ts        <-- prints shipping labels via PrintNode

Compras (/compras)                <-- purchase order management for OC decisions
    |
    └─ /api/compras/*             <-- ordens, conferir, devolver, indisponivel
    └─ compras-release.ts         <-- when all items received → resume execution
```

### Hierarchy: Galpao > Empresa > Grupo

- **Galpao**: physical warehouse location (e.g., CWB, SP). Can have N empresas.
- **Empresa**: Tiny ERP account with its own CNPJ (e.g., NetAir, NetParts). FK to galpao.
- **Grupo**: business affinity grouping (e.g., Autopecas). Empresas in the same grupo check stock across each other.
- **Tier**: deduction priority within a grupo. The empresa that received the order gets tier 1 override at runtime.

### Current Data

| Galpao | Empresa | CNPJ | Grupo | Tier |
|---|---|---|---|---|
| CWB | NetAir | `34857388000163` | Autopecas | 1 |
| SP | NetParts | `34857388000244` | Autopecas | 1 |

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
- `separado`: picking complete, ready for packing
- `embalado`: packing done, ready for expedition

## Project Structure

```
src/
  app/
    page.tsx                       # Landing / redirect
    layout.tsx                     # Root layout (Outfit + JetBrains Mono fonts)
    login/page.tsx                 # PIN login page
    siso/page.tsx                  # SISO Dashboard — 3 tabs (Pendente/Concluidos/Auto)
    painel/
      page.tsx                     # Painel redirect to operacao
      operacao/page.tsx            # Operational dashboard — real-time wave picking status
      gerencial/page.tsx           # Management dashboard (admin only)
    separacao/
      page.tsx                     # Separation dashboard — 6 tabs by status
      checklist/page.tsx           # Wave picking checklist view
      embalagem/page.tsx           # Packing view
    pedidos/
      page.tsx                     # Universal order tracking — search, filters, Pedidos/Expedidos tabs
      [id]/page.tsx                # Order detail — itens+estoque, timeline, observacoes, acoes
    compras/
      page.tsx                     # Purchase orders — Comprar/Receber tabs with supplier consolidation
      conferencia/[ordemCompraId]/page.tsx  # Receiving screen for specific PO
    cross/
      page.tsx                     # Cross — busca universal de produtos
      [sku]/page.tsx               # Cross — detalhe + edição de OEMs e veículos
    inventario/page.tsx            # Inventory — barcode scanning, location tagging, stock updates
    transferencias/page.tsx        # Transfers — inter-galpão stock transfer
    etiquetas/page.tsx             # Address labels — ZPL generation + PrintNode printing
    configuracoes/page.tsx         # Settings — Galpao/Empresa hierarchy, Grupos, Tiny, PrintNode
    monitoramento/page.tsx         # Monitoring dashboard (admin only) — DEPRECATED, see painel/gerencial
    admin/usuarios/page.tsx        # User CRUD (admin only)
    api/
      webhook/
        tiny/route.ts              # Webhook receiver (POST) — pedido + nota_fiscal
        reprocessar/route.ts       # Retry failed webhooks (POST)
      auth/login/route.ts          # PIN auth (POST)
      pedidos/
        route.ts                   # List orders (GET) — joins normalized stock table
        tracking/route.ts          # Universal tracking list (GET) — paginated, search, filters, tabs
        aprovar/route.ts           # Order approval (POST) — enqueues execution
        [id]/detalhe/route.ts      # Order detail consolidated (GET) — itens+estoque, historico, observacoes
        [id]/historico/route.ts    # Order history/audit trail (GET)
        [id]/observacoes/route.ts  # Order comments (GET/POST)
      separacao/
        route.ts                   # List separation orders with counts (GET)
        iniciar/route.ts           # Start separation (POST)
        bipar/route.ts             # Barcode scan during picking (POST)
        bipar-checklist/route.ts   # Barcode scan in checklist phase (POST)
        marcar-item/route.ts       # Mark item as picked (POST)
        desfazer-bip/route.ts      # Undo a barcode scan (POST)
        concluir/route.ts          # Complete separation (POST)
        concluir-oc/route.ts       # Complete OC separation: auto-resolve compra + enqueue execution (POST)
        bipar-embalagem/route.ts   # Barcode scan during packing (POST)
        confirmar-item-embalagem/route.ts  # Confirm item packed (POST)
        expedir/route.ts           # Dispatch order (POST)
        retry-etiqueta/route.ts    # Retry label printing after failure (POST)
        checklist-items/route.ts   # Get checklist items (GET)
        encaminhar/route.ts        # Forward order to another galpão (POST)
        cancelar/route.ts          # Cancel separation (POST)
        reiniciar/route.ts         # Restart separation (POST)
        voltar-etapa/route.ts      # Go back one step (POST)
        tags/route.ts              # Manage separacao tags (GET list, POST add/remove/set)
        produto-esgotado/route.ts  # Mark product out of stock (POST)
        validar-oc-item/route.ts   # Validate OC item: encontrei/esgotado + auto-transitions (POST)
        reimprimir/route.ts        # Reprint label (POST)
        forcar-pendente/route.ts   # Force orders back to pending — batch (POST)
        [pedidoId]/forcar-pendente/route.ts  # Force single order back to pending (PATCH)
        localizacao/route.ts       # Update product location in Tiny + DB (POST)
      compras/
        route.ts                   # List purchase items by status: comprar/receber (GET)
        comprar/route.ts           # Mark items as purchased (comprado) by SKU, distribute across orders (POST)
        receber/route.ts           # Receive/consolidate purchases into comprado items (POST)
        preparar-embalagem/route.ts  # Prepare/stage orders for packing via compras/embalagem (POST)
        trocar-sku/route.ts        # Change product SKU for a compra item (POST)
        ordens/route.ts            # List purchase orders by supplier (GET)
        conferir/route.ts          # DEPRECATED (POST)
        conferencia/[ordemCompraId]/route.ts  # Receive items for PO (GET/POST)
        pedidos/[pedidoId]/cancelar/route.ts  # Cancel purchase decision for pedido (POST)
        itens/[itemId]/indisponivel/route.ts  # Mark item unavailable — trigger alternatives (POST)
        itens/[itemId]/devolver/route.ts      # Return received item to supplier state (POST)
        itens/[itemId]/cancelamento/route.ts  # Propose cancelamento exception (POST)
        itens/[itemId]/cancelamento/confirmar/route.ts  # Confirm cancelamento + generate credit note (POST)
        itens/[itemId]/equivalente/route.ts   # Propose equivalente SKU (POST)
        itens/[itemId]/equivalente/confirmar/route.ts  # Confirm equivalente + update product mappings (POST)
        itens/[itemId]/trocar-fornecedor/route.ts  # Change supplier (DEPRECATED, use compras-equivalencia) (POST)
      cross/
        search/route.ts            # GET busca (SKU/OEM/nome)
        produtos/[sku]/route.ts    # GET detalhe (com lazy fetch Tiny)
        produtos/[sku]/refetch/route.ts        # POST atualizar do Tiny
        produtos/[sku]/oems/route.ts           # POST adicionar OEM (com aviso de cruzamento)
        produtos/[sku]/oems/[codigo]/route.ts  # DELETE remover OEM (regra de permissão)
        produtos/[sku]/veiculos/route.ts       # POST adicionar veículo
        produtos/[sku]/veiculos/[id]/route.ts  # DELETE remover veículo
        sugestoes/marcas/route.ts              # GET sugestão de marcas
        sugestoes/modelos/route.ts             # GET sugestão de modelos
      inventario/
        route.ts                   # List + create inventory sessions (GET/POST)
        [id]/route.ts              # Inventory detail + cancel (GET/PATCH)
        [id]/coletar/route.ts      # Scan product into inventory (POST)
        [id]/itens/[itemId]/route.ts  # Edit qty + delete item (PATCH/DELETE)
        [id]/processar/route.ts    # Start processing — fire-and-forget (POST)
        [id]/progresso/route.ts    # Processing progress — polling (GET)
        [id]/reverter/route.ts     # Reverse completed inventory (POST)
      transferencia/
        route.ts                   # List + create transfers (GET/POST)
        [id]/route.ts              # Transfer detail + cancel (GET/PATCH)
        [id]/coletar/route.ts      # Scan product from origin empresa (POST)
        [id]/itens/[itemId]/route.ts  # Edit qty + delete item (PATCH/DELETE)
        [id]/processar/route.ts    # Start processing — fire-and-forget (POST)
        [id]/progresso/route.ts    # Processing progress — polling (GET)
        [id]/reverter/route.ts     # Reverse completed transfer (POST)
      etiquetas-endereco/
        preview/route.ts           # Generate address preview (POST)
        imprimir/route.ts          # Generate ZPL + print via PrintNode (POST)
      reconciliacao/route.ts        # Reconciliation: find & reprocess lost orders (GET)
      worker/processar/route.ts    # Execution worker trigger (POST/GET)
      dashboard/counts/route.ts    # Module card counts (GET)
      painel/route.ts              # Control tower / Torre de Controle (GET)
      admin/
        usuarios/route.ts          # User CRUD (GET/POST/PUT/DELETE)
        galpoes/route.ts           # Galpao CRUD (GET/POST) — GET returns full hierarchy
        galpoes/[id]/route.ts      # Galpao by ID (PUT/DELETE)
        empresas/route.ts          # Empresa CRUD (GET/POST)
        empresas/[id]/route.ts     # Empresa by ID (PUT/DELETE)
        grupos/route.ts            # Grupo CRUD (GET/POST)
        grupos/[id]/route.ts       # Grupo by ID (PUT/DELETE)
        grupos/[id]/empresas/route.ts           # Add empresa to grupo (POST)
        grupos/[id]/empresas/[empresaId]/route.ts  # Update tier / remove
        printnode/
          api-key/route.ts         # Manage PrintNode API key (GET/PUT/DELETE)
          printers/route.ts        # List printers (GET)
          test/route.ts            # Test PrintNode connection (POST)
      tiny/
        connections/route.ts       # Tiny connections CRUD (GET/POST/PUT) — empresa-scoped
        test-connection/route.ts   # Test Tiny connection (POST)
        deposits/route.ts          # List Tiny deposits per empresa (GET)
        stock/ajustar/route.ts     # Adjust stock in Tiny (POST)
        oauth/route.ts             # OAuth2 initiation — step 1 (GET -> redirect to Keycloak)
        oauth/callback/route.ts    # OAuth2 callback — step 2 (GET, save token to siso_tiny_connections)
      monitoring/route.ts          # Monitoring data (GET)
  components/
    app-shell.tsx                  # Page wrapper — header, auth check, admin-only pages
    app-header.tsx                 # Header component with breadcrumbs + user menu
    galpao-selector.tsx            # Dropdown to filter by galpao (multi-galpao support)
    sw-register.tsx                # Service worker registration for PWA
    providers.tsx                  # QueryClientProvider + Toaster + AppShell wrapper
    pedido/
      pedido-card.tsx              # Pending order card (dynamic stock per galpão)
      pedido-card-concluido.tsx    # Completed order row (compact, expandable)
      observacoes-timeline.tsx     # Comments/observations timeline
    separacao/
      separacao-card.tsx           # Full separation card (picking/packing)
      pedido-separacao-card.tsx    # Order card in separation list
      item-separacao-row.tsx       # Product row with barcode, location
      scan-input.tsx               # Barcode scanner input
      pedido-timeline.tsx          # Separation event timeline
      tab-pendentes.tsx            # Pending orders tab
      tab-aguardando-nf.tsx        # Awaiting NF tab
      tab-embalados.tsx            # Packed orders tab
      tab-expedidos.tsx            # Dispatched orders tab
      audio-feedback.ts            # Audio beep on scan
    compras/
      fornecedor-comprar-card.tsx  # Supplier card with items by SKU for Comprar tab
      fornecedor-receber-card.tsx  # Supplier card with received items for Receber tab
      qty-input.tsx                # Quantity input component for purchases
      item-context-menu.tsx        # Context menu for compra item actions
      indisponivel-dialog.tsx      # Dialog to mark item indisponível + alternatives
      equivalente-dialog.tsx       # Dialog to set/confirm equivalente SKU
      cancelamento-dialog.tsx      # Dialog to propose/confirm cancelamento
      excecoes-banner.tsx          # Banner showing compra exceptions/resolutions
    cross/
      search-input.tsx             # Input + pílulas de tipo (auto/sku/oem/nome)
      resultado-card.tsx           # Card de resultado na lista
      produto-header.tsx           # Header do detalhe + botão "Atualizar agora"
      estoque-galpao-tabela.tsx    # Tabela compacta de estoque
      oem-list-editor.tsx          # Editor inline de OEMs
      veiculo-list-editor.tsx      # Editor inline de veículos com autocomplete
      equivalentes-list.tsx        # Lista de SKUs equivalentes
    inventario/
      criar-inventario-form.tsx    # New inventory session form
      inventario-card.tsx          # Inventory session card for lists
      scan-inventario.tsx          # Barcode scanning interface with location
      progresso-processamento.tsx  # Reusable progress view (inventario + transferencia)
    transferencia/
      criar-transferencia-form.tsx # New transfer session form
      transferencia-card.tsx       # Transfer session card for lists
      scan-transferencia.tsx       # Barcode scanning interface (no location)
    etiquetas/
      etiqueta-endereco-form.tsx   # Address range input form
      endereco-preview.tsx         # Address preview grid + printer selector
    configuracoes/
      galpoes-empresas-section.tsx # Galpao > Empresa hierarchy editor
      galpao-card.tsx              # Single galpao card
      empresa-row.tsx              # Single empresa row
      grupos-section.tsx           # Grupo management
      connection-card.tsx          # Tiny OAuth2 connection card
      deposito-selector.tsx        # Deposit selector
      webhook-url-card.tsx         # Webhook URL display
      printnode-section.tsx        # PrintNode printer setup
      types.ts                     # Local types for configuracoes
    ui/
      tabs.tsx                     # Pill-style tab bar with counters
      empty-state.tsx              # Empty list message
      loading-spinner.tsx          # Spinner component
  lib/
    # ── Core business logic ──
    empresa-lookup.ts              # CNPJ -> empresa resolution (cached 5min)
    grupo-resolver.ts              # Resolve grupo, tier-based deduction order, aggregate stock by galpao
    webhook-processor.ts           # Core: fetch order -> enrich stock -> calc suggestion -> save
    nf-webhook-handler.ts          # Handle nota_fiscal webhooks, transition aguardando_nf → aguardando_separacao
    execution-worker.ts            # Post-approval: deduct stock following tier order
    compras-release.ts             # When all OC items received → resume execution
    compras-equivalencia.ts        # Handle equivalente SKU resolution for compras items
    compras-embalagem.ts           # Staging/preparation logic for compras items before separacao
    compras-utils.ts               # Shared utilities for compras module (allowed cargos, field reset)
    inventario-processor.ts        # Consolidate + process/reverse inventory sessions via Tiny
    transferencia-processor.ts     # Process/reverse inter-galpão stock transfers via Tiny
    # ── Cross (catálogo e equivalência) ──
    cross/types.ts                 # Tipos compartilhados
    cross/oem-extractor.ts         # Regex de extração de OEM (porta do projeto cross)
    cross/produto-fetcher.ts       # Tiny → catálogo (fetch + persistência)
    cross/catalogo-queries.ts      # Busca, detalhe completo, equivalentes
    # ── Tiny ERP integration ──
    tiny-api.ts                    # Tiny ERP API v3 client
    tiny-oauth.ts                  # OAuth2 token management — getValidTokenByEmpresa()
    tiny-queue.ts                  # Rate limiting + queue per empresa_id (runWithEmpresa wrapper)
    rate-limiter.ts                # Underlying rate limiter implementation
    sku-fornecedor.ts              # SKU prefix -> supplier/galpao for purchase orders
    # ── Printing & labels ──
    agrupamento-service.ts         # Pre-create Tiny agrupamentos, download ZPL labels
    etiqueta-service.ts            # Print shipping labels via PrintNode (fast: cached ZPL, slow: API)
    etiqueta-download.ts           # Download/extract ZPL from Tiny ZIP files
    printnode.ts                   # PrintNode API client (PDF + ZPL, printer resolution)
    zpl-endereco.ts                # Address label ZPL generation (small 2-per-label + large rotated)
    # ── Auth & sessions ──
    auth-context.tsx               # AuthProvider + useAuth (localStorage + sessionId)
    session.ts                     # Server-side session validation (X-Session-Id header)
    filtrar-pedidos.ts             # Role-based order filtering
    # ── Infrastructure ──
    historico-service.ts           # Order audit trail (siso_pedido_historico)
    config.ts                      # System config KV store (siso_configuracoes)
    domain-helpers.ts              # UI helpers: e-commerce abbreviations, decisão colors
    supabase.ts                    # Supabase browser client
    supabase-server.ts             # Supabase service-role client
    logger.ts                      # Structured logger (stdout JSON + Supabase siso_logs + siso_erros)
    utils.ts                       # cn() helper (clsx + tailwind-merge)
    reconciliacao.ts               # Reconciliation: reprocess stuck webhooks + find missing orders from Tiny
    # ── Deprecated ──
    cnpj-filial.ts                 # DEPRECATED — thin wrapper, use empresa-lookup.ts
  hooks/
    use-realtime-separacao.ts      # Supabase Realtime subscription for separation updates
  types/index.ts                   # Central type definitions
  data/
    mock.ts                        # Mock order data for UI development
    mock-separacao.ts              # Mock separation data
supabase/
  migrations/                      # Database migrations (YYYYMMDD_description.sql)
scripts/
  seed-cross-catalogo.ts           # Seed inicial: importa cross.products → siso_produtos_catalogo
  wms-seed-test.ts                 # Seed pra validar pipeline WMS end-to-end (1 produto + 1 mov)

wms/  (subset of src/)
  src/lib/wms/
    types.ts                       # Produto, Localizacao, EstoqueLinha, Movimentacao, Quadrupla, PerspectivaEstoque
    ledger.ts                      # inserirMovimentacao() + helpers (calcularPosteriores, validarCoerencia)
    ledger.test.ts                 # Unit tests da lógica do ledger
    produtos.ts                    # CRUD do catálogo unificado
    localizacoes.ts                # CRUD de localizações por galpão
    estoque.ts                     # Queries de saldos com 4 perspectivas (dono/galpao/localizacao/produto)
    sync-tiny.ts                   # Sincroniza siso_produtos com Tiny (descricao, ncm, gtin, imagem)
    snapshot-inicial.ts            # Bulk-load idempotente do Tiny pra popular siso_estoque (Fase 0)
    reconciliacao.ts               # Detecta + corrige divergências entre ledger e siso_estoque
    putaway.ts                     # Heurística de sugestão de localização (SKU presente > recebimento > default)
    movimentacoes.ts               # Helpers operacionais: receber, transferir, replenishment, ajuste, retroativo, custo médio
    fornecedores.ts                # CRUD fornecedores + relação produto↔fornecedor + auto-cadastro do mapeamento sku-fornecedor.ts
    emprestimos.ts                 # Regras N×N + saldos devedores via RPC
    roteamento.ts                  # Algoritmo de roteamento PURO (geo-priority) + wrapper rotearPedidoDoBanco
    reservas.ts                    # Reservas atômicas com TTL + cleanup cron-friendly
    inventario.ts                  # v2 (pull queue): criarSessao/sugerirLocalizacoes/iniciarSessao/entrarSlot/sairSlot/pegarProximaLoc/finalizarLoc/registrarContagem/computarDivergencias/aprovarSessao/aplicarSessao
    inventario-recovery.ts         # Detecta sessões e locks órfãos pra cron de cleanup
    devolucoes.ts                  # Classificação A/B/C/D (íntegro/avariado/garantia/troca_sku) com recálculo de custo médio
    cobertura.ts                   # Service de cobertura por giro (lê siso_cobertura_estoque)
    dashboard-geral.ts             # Agrega contadores cross-módulo pra dashboard principal
  src/hooks/
    use-inventario-realtime.ts     # Subscreve channel inventario:{id} (Supabase Realtime); retorna contagens + locs + operadores ao vivo
  src/app/wms/
    layout.tsx + page.tsx          # Shell + home com 4 cards (catálogo/localizações/estoque/ledger)
    produtos/page.tsx              # Catálogo de produtos (search + sync com Tiny)
    localizacoes/page.tsx          # Configurar localizações por galpão
    estoque/page.tsx               # Saldos em 4 perspectivas
    ledger/page.tsx                # Histórico imutável de movimentações
    receber/page.tsx               # Recebimento de estoque com sugestão de putaway
    transferir/page.tsx            # Transferência inter-galpão (origem→destino)
    replenishment/page.tsx         # Replenishment intra-galpão (mover entre localizações no mesmo galpão)
    ajuste/page.tsx                # Ajuste manual com motivo (entrada ou saída)
    retroativos/page.tsx           # Pendências de reconciliação de lançamentos retroativos
    fornecedores/page.tsx          # CRUD fornecedores + botão auto-cadastrar mapeamento
    emprestimos/page.tsx           # Matriz N×N de empréstimos + saldos devedores + limites globais
    inventario/page.tsx            # Lista sessões + modal de criação com 3 tipos (Inteligente/Manual/Completo). Modo aberto|blind (default blind).
    inventario/[id]/page.tsx       # Painel realtime do supervisor — 5 slots de operador ao vivo + KPIs + velocidade média + últimos bipes + ações
    inventario/[id]/contar/page.tsx          # Tela handheld do operador: slot-picker → botão "PEGAR PRÓXIMA LOC" → confirmar loc (QR ou manual) → bipar produtos → finalizar → loop. Resumo final ao esvaziar pool.
    inventario/[id]/divergencias/page.tsx    # Relatório do supervisor (aprovar/rejeitar). Sem recontagem mid-flow.
    inventario/metricas/page.tsx   # Acuracidade por operador (30d) e por localização
    devolucoes/page.tsx + [id]/page.tsx  # Lista pendentes + tela de classificação A/B/C/D
    cobertura/page.tsx             # Tabela de cobertura por giro com filtros e cores
    dashboard/page.tsx             # Dashboard geral (4 cards, refresh 30s)
  src/app/api/wms/
    produtos/route.ts              # GET (list/search), POST (create)
    produtos/[id]/route.ts         # GET, PATCH
    produtos/[id]/sync/route.ts    # POST — força sync com Tiny
    produtos/[id]/ultimas-contagens/route.ts  # GET — última contagem de inventário por loc+dona (feed da aba Movimentações do produto)
    localizacoes/route.ts          # GET (por galpão), POST
    localizacoes/[id]/route.ts     # PATCH, DELETE (com proteção saldo>0)
    estoque/route.ts               # GET ?view=dono|galpao|localizacao|produto
    ledger/route.ts                # GET com filtros (produto/empresa/galpao/origem_tipo/desde/ate)
    snapshot-inicial/route.ts      # POST (admin only, idempotente, ?dryRun=true)
    reconciliacao/route.ts         # GET (worker-secret, cron-friendly, ?fix=true)
    receber/route.ts               # POST receber estoque + GET sugestão de putaway
    transferir-galpao/route.ts     # POST transferência inter-galpão (par S+E com origem_id)
    replenishment/route.ts         # POST replenishment intra-galpão
    ajuste/route.ts                # POST ajuste manual com motivo
    lancamento-retroativo/route.ts # POST registrar emergência + GET pendentes
    lancamento-retroativo/[id]/reconciliar/route.ts  # POST reconcilia com mov real (insere estorno)
    fornecedores/route.ts          # GET (list), POST (create)
    fornecedores/[id]/route.ts     # PATCH, DELETE (soft)
    fornecedores/auto-cadastro/route.ts  # POST (admin only) — semeia mapeamento canônico
    produto-fornecedores/route.ts  # GET (?produto_id=), POST (vincular)
    produto-fornecedores/[id]/route.ts   # PATCH, DELETE (soft)
    emprestimo-regras/route.ts     # GET, POST (CHECK credora ≠ devedora)
    emprestimo-regras/[id]/route.ts          # PATCH, DELETE (soft)
    emprestimo-regras/[id]/limites/route.ts  # GET, PATCH limites_por_produto (jsonb)
    emprestimos/saldos/route.ts    # GET — saldo devedor líquido por par+produto
    rotear/route.ts                # POST — testa algoritmo (debug + integração)
    reservas/cleanup/route.ts      # GET (worker secret) — libera reservas com expira_em < now()
    inventario/route.ts                                    # GET (lista), POST (criar sessão — body: { tipo, nome?, galpao_id, empresa_dona_id?, modo_contagem?, localizacoes: [{ localizacao_id, motivo? }] })
    inventario/sugerir/route.ts                            # POST — algoritmo de sugestão inteligente (mix 50/30/20 — curva A + divergentes 60d + sem contagem 30d)
    inventario/[id]/route.ts                               # GET (sessão + operadores + locs + contagens + divergências), PATCH, DELETE (cancela)
    inventario/[id]/iniciar/route.ts                       # POST — idempotente; cria locks, status='em_andamento' (auto-disparado por entrarSlot tb)
    inventario/[id]/slots/[slot]/entrar/route.ts           # POST — operador assume OP{slot} (auto-inicia sessão se planejada)
    inventario/[id]/slots/route.ts                         # DELETE — operador sai do slot
    inventario/[id]/proxima-loc/route.ts                   # POST — pull queue: retorna próxima loc com lock atômico + smart routing (continuidade > anti-colisão > codigo)
    inventario/[id]/localizacoes/[locId]/finalizar/route.ts # POST — finaliza loc (status=contada, libera lock, incrementa contador do op)
    inventario/[id]/aprovar/route.ts                       # POST — computa divergências + aprova
    inventario/[id]/aplicar/route.ts                       # POST — gera movs origem='inventario'
    inventario/[id]/contagens/route.ts                     # POST — registra contagem (incremental|absoluto, sem rodada)
    inventario/[id]/divergencias/route.ts                  # GET, PATCH (aprovar|rejeitar — sem recontagem)
    inventario/metricas/route.ts                           # GET — RPCs operador+localização
    inventario/cleanup/route.ts                            # GET (worker secret) — libera locks órfãos
    devolucoes/route.ts + [id]/classificar/route.ts        # GET fila pendente + POST classificação
    cobertura/route.ts + cobertura/refresh/route.ts        # GET (filtros) + GET refresh worker secret
    dashboard-geral/route.ts                               # GET — agrega 7 contadores
  src/components/wms/
    wms-shell.tsx                  # Navegação superior do módulo WMS (10 atalhos)
    saldo-perspectiva-tabs.tsx     # Tabs entre as 4 perspectivas de saldo
    quadrupla-picker.tsx           # Seletor reutilizável de empresa+localização (filtro tipo opcional)
    scan-contagem.tsx              # Input de bipe pro inventário (autoFocus + Enter dispara onScan)
```

## Database Tables (Supabase)

All tables are prefixed with `siso_`:

### Core Tables

| Table | Purpose |
|---|---|
| `siso_pedidos` | Orders with stock enrichment, suggestion, status, separation status. Has `empresa_origem_id` FK. `separacao_tags text[]` for user-created tags (separate from Tiny `marcadores`). |
| `siso_pedido_itens` | Per-item data (unique: `pedido_id + produto_id`). Has legacy `estoque_cwb_*`/`estoque_sp_*` columns + normalized FK. |
| `siso_pedido_item_estoques` | **Primary stock source.** Normalized stock per empresa (pedido_id, produto_id, empresa_id). API reads from here. |
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
| `siso_empresas` | Tiny ERP accounts (id, nome, cnpj unique, galpao_id FK, ativo) |
| `siso_grupos` | Business affinity groups (id, nome unique) |
| `siso_grupo_empresas` | N:1 empresa→grupo with tier (empresa_id unique) |

### WMS Tables (Plano 1 — Foundation)

Schema 4D: cada posição de estoque é única por **(produto, dona, galpão, localização)**.

| Table | Purpose |
|---|---|
| `siso_produtos` | **Catálogo unificado.** id, sku unique, descricao, gtin, imagem_url, unidade, ncm, cest, origem_fiscal, sincronizado_em, ativo |
| `siso_produto_empresas` | Mapeamento N:N produto↔empresa com tiny_produto_id (PK composto produto_id+empresa_id, UNIQUE empresa_id+tiny_produto_id) |
| `siso_localizacoes` | Localizações dentro do galpão (id, galpao_id FK, codigo, tipo: picking/overstock/recebimento/expedicao/quarentena, ativo). UNIQUE(galpao_id, codigo) |
| `siso_estoque` | **Cache materializado** da posição atual. saldo, reservado, disponivel (GENERATED saldo-reservado), custo_medio. UNIQUE(produto, dona, galpão, localização). CHECK reservado<=saldo |
| `siso_movimentacoes` | **Ledger imutável.** Tipo (E/S/R/L) + saldo_anterior/posterior + reservado_anterior/posterior + origem_tipo (compra_manual, nf_venda, emprestimo, reserva_pedido, …) + observacoes + estorno_de. CHECKs garantem coerência aritmética. |

**RPC `wms_inserir_movimentacao(...)`**: única forma de escrever no ledger. Lock pessimista via `SELECT FOR UPDATE`, valida saldo/reservado, insere mov, atualiza cache atomicamente.

**RPC `wms_detectar_divergencias_estoque()` / `wms_rebuild_linha_estoque(p_id)`**: reconciliação ledger↔cache. Endpoint `/api/wms/reconciliacao` (worker-secret) é cron-friendly.

### WMS Tables (Plano 3 — Roteamento)

| Table | Purpose |
|---|---|
| `siso_fornecedores` | Fornecedores únicos (nome unique, prefixo_sku, cnpj). 11 cadastrados via auto-cadastro do mapeamento canônico. |
| `siso_produto_fornecedores` | Relação produto↔fornecedor com lead_time min/medio/max + custo_unitario + qty_minima_pedido + multiplo_compra + flag preferencial. UNIQUE(produto, fornecedor). |
| `siso_emprestimo_regras` | Matriz N×N direcional credora→devedora (UNIQUE par + CHECK credora ≠ devedora). Tem `limites_por_produto jsonb` pra limite por SKU + `limite_max_por_produto numeric` global. |
| `siso_localizacao_locks` | Locks operacionais de localização (cycle_count, contagem_completa, manutencao). UNIQUE parcial WHERE finalizado_em IS NULL. |

**RPC `wms_reservar_atomico(...)`**: wrapper sobre `wms_inserir_movimentacao` com tipo='R', expira_em=now()+ttl_horas. Retorna mov_id.

**RPC `wms_saldos_devedores()`**: saldo líquido bidirecional credora↔devedora por produto, considerando movs origem_tipo='emprestimo' não-estornadas. Filtrada (devido > 0).

### WMS Tables (Plano 4 — Inventário v2: pull queue + slots)

**v2 rewrite (2026-05-12):** trocamos divisão estática por áreas (causava operador ocioso) por pool compartilhado com pull queue. Operadores assumem slots OP1-OP5 e puxam locs sob demanda com smart routing. Realtime via Supabase Realtime.

| Table | Purpose |
|---|---|
| `siso_inventario_sessoes` | Sessão master. nome (opcional), tipo cycle_count\|completo, modo aberto\|blind (default blind, sem duplo_blind), tolerancia_pct, exige_aprovacao_acima_valor, tamanho_pool. Status workflow: planejada→em_andamento→revisao→aprovada→aplicada\|cancelada. |
| `siso_inventario_operadores` | NOVO. Slots OP1..OP5 dinâmicos: slot smallint (1-5), usuario_id, entrou_em, finalizado_em, locs_contadas, ultima_acao_em. UNIQUE(sessao_id, slot) + UNIQUE parcial (sessao_id, usuario_id) WHERE finalizado_em IS NULL. |
| `siso_inventario_localizacoes` | Pool de locs da sessão (sem area_id). status pendente\|em_contagem\|contada\|divergente\|aprovada (sem recontagem). motivo (curva_a\|divergente_recente\|sem_contagem_recente\|manual\|completo). bloqueada_por + bloqueada_em pra lock atômico por operador. contagem_iniciada_em + contagem_finalizada_em pra cálculo de tempo médio. `slot_atribuido` (1..5 ou NULL) pra distribuição soft entre operadores no cycle count manual — RPC prioriza o bucket próprio mas cai em pull queue puro quando esvazia. |
| `siso_inventario_contagens` | Cada bipe individual. Sem `rodada` (1 contagem por loc). Indexada por quádrupla. Múltiplos operadores podem contar a mesma loc (caso edge: sairSlot mid-loc), `computarDivergencias` soma todas as contagens da quádrupla. |
| `siso_inventario_divergencias` | Saldo sistema vs contagem final por quádrupla. delta + delta_pct GENERATED. Status: pendente\|aprovada\|rejeitada\|aplicada (sem recontagem_solicitada). mov_aplicada_id liga ao ledger ao aplicar. |

Ajustes em `siso_localizacoes`: ADD `ultima_contagem_em timestamptz` (trigger atualiza em cada bipe — usado pela sugestão inteligente) + `zona text` (override manual pro roteamento; default = prefixo antes do "-").

### WMS Tables (Plano 5 — Exceções+Dashboards)

| Table | Purpose |
|---|---|
| `siso_devolucoes_pendentes` | Fila de NFs de entrada esperando classificação física. UNIQUE parcial em nota_fiscal_id e chave_acesso_nf (dedup webhook re-entregue). Status: aguardando_classificacao→classificada→aplicada\|cancelada. |

**Materialized view `siso_cobertura_estoque`**: agrega disponivel + giro 30d + lead time fornecedor preferencial → `status_cobertura` (ok\|atencao\|critico\|lead_time_risco\|sem_giro). Refresh via `wms_refresh_cobertura()`.

**RPC `wms_inventario_proxima_loc(p_sessao, p_user)`**: pull queue inteligente. Verifica que user tem slot ativo + sessão em_andamento. Seleciona próxima loc com lock atômico (`FOR UPDATE OF inv_loc SKIP LOCKED`). Priorização: (0) `slot_atribuido = meu slot` — bucket próprio (soft bucketing do cycle count manual); (1) mesma zona da última loc deste user — continuidade; (2) zona NÃO ocupada por outros ops ativos — anti-colisão; (3) ordem alfabética do codigo — fallback. Retorna `{ pool_vazio: true }` quando esgotado. Em modo aberto, anexa lista de SKUs esperados.

**RPC `wms_inventario_sugerir(p_galpao, p_empresa_dona?, p_tamanho)`**: algoritmo de sugestão inteligente. Mix 50% locs com produtos curva A (giro 30d via `siso_curva_abc`) + 30% locs com divergências aplicadas nos últimos 60d + 20% locs sem contagem em 30d+ (ou nunca contadas). Filtra apenas locs com saldo > 0. Dedupe automático (loc só aparece em uma categoria, priorizada por peso).

**RPCs métricas**: `wms_metricas_operador()` (acuracidade 30d por user) + `wms_metricas_localizacao()` (cobertura+erro 5000 últimas localizações).

**Materialized view `siso_curva_abc`**: ranking ABC automático via giro 30d (movs origem nf_venda+emprestimo, não-estornadas). Função `wms_refresh_curva_abc()` pra cron job de refresh.

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

## Key Domain Concepts

### User Roles (Cargos)
- `admin` — sees everything, manages users and settings
- `operador_cwb` — sees/processes CWB orders only
- `operador_sp` — sees/processes SP orders only
- `comprador` — sees only purchase-order-suggested orders

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

Required in `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://wrbrbhuhsaaupqsimkqz.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # Required for server-side operations
```

Optional:
```
WORKER_SECRET=<secret>   # Protects POST /api/worker/processar
```

OAuth2 credentials for Tiny are stored in the `siso_tiny_connections` table (not env vars).
PrintNode API key is stored in `siso_configuracoes` (key: `printnode_api_key`).

## Development Commands

```bash
npm run dev       # Start dev server (turbopack)
npm run build     # Production build
npm run start     # Start production server
npm run lint      # ESLint
```

## Authentication

- No Supabase Auth — uses custom PIN-based auth
- Login: `POST /api/auth/login` with `{ nome, pin }`
- Session: server-side `siso_sessoes` table + `X-Session-Id` header
- Client persists session in localStorage (`siso_user` key)
- `sisoFetch` wrapper in `auth-context.tsx` auto-sends session header
- Server validates via `getSessionUser()` in `session.ts`
- Seed user: `Eryk / 1234 / admin`

## Documentation

The `docs/` directory contains comprehensive, ground-truth documentation generated from source code:

| Document | Purpose | When to consult |
|---|---|---|
| [`docs/api-reference-complete.md`](docs/api-reference-complete.md) | **All 81+ API routes** — method, path, auth, request/response shapes, business logic, side effects | Before making any API change; understanding any endpoint contract |
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
- **WMS Fase 0 (Foundation) — implementado, validado em staging** (projeto Supabase `ehbxpbeijofxtsbezwxd`). Schema 4D + ledger imutável + RPC com lock + 4 telas de visualização (catálogo, localizações, saldos por 4 perspectivas, ledger). Dependente de promoção pra prod (Fase 1+ ainda pendente). Spec: `docs/superpowers/specs/2026-05-07-wms-design.md`. Plano executado: `docs/superpowers/plans/2026-05-08-wms-1-foundation.md`.
- **WMS Plano 2 (Movimentações operacionais) — implementado, validado em staging.** 5 fluxos (receber, transferir inter-galpão, replenishment intra-galpão, ajuste manual com motivo, lançamento retroativo + reconciliação) + sugestão automática de putaway + recálculo de custo médio em entradas com custo. Validação E2E: receber 50 + ajustar -10 = saldo 40, 0 divergências. Plano: `docs/superpowers/plans/2026-05-15-wms-2-movimentacoes.md`.
- **WMS Plano 3 (Roteamento) — implementado, validado em staging.** Schema fornecedores + matriz de empréstimos N×N (com limites por par+produto) + algoritmo de roteamento puro com geo-priority (home=0, mesma_cidade=1, mesmo_estado=2, outro=3) + reservas atômicas com TTL 48h + cleanup cron-friendly + shadow logging no webhook (legado vs novo, sem mudar comportamento). 9 testes de roteamento + 3 de reservas. Plano: `docs/superpowers/plans/2026-05-22-wms-3-roteamento.md`.
- **WMS Plano 4 v1 (Inventário robusto) — substituído por v2 em 2026-05-12.** Schema original tinha divisão estática por "áreas" (1 área = 1 operador, locs pré-atribuídas), o que causava operador ocioso quando um terminava antes dos outros. Plano original: `docs/superpowers/plans/2026-05-29-wms-4-inventario.md`.

- **WMS Plano 4 v2 (Inventário pull queue + slots) — implementado em staging, 2026-05-12.** Mudança fundamental: pool compartilhado em vez de divisão estática. Operadores assumem slots OP1-OP5 dinâmicos e puxam próxima loc sob demanda via RPC `wms_inventario_proxima_loc` com smart routing (bucket próprio > continuidade > anti-colisão por zona > ordem alfabética). Sugestão inteligente via RPC `wms_inventario_sugerir` (mix 50% curva A + 30% divergentes recentes + 20% sem contagem 30d+) — roda sob demanda quando supervisor abre "Cycle Inteligente". 3 tipos de sessão: Inteligente / Manual / Completo. Modo aberto|blind (default blind). Sem recontagem mid-flow — divergências aparecem no relatório do supervisor após encerrar. Tela handheld redesenhada: slot picker → botão gigante "PRÓXIMA LOC" → confirmar (QR ou manual) → bipar produtos → finalizar → loop → resumo final. **Cycle count manual com distribuição soft** (2026-05-12): supervisor escolhe quantos operadores (1-5), algoritmo greedy LPT por zona pré-atribui locs a slots; operador puxa do bucket próprio primeiro, mas pode pegar de buckets de colegas quando esvaziar (evita operador ocioso). Encerrar parcial: supervisor pode encerrar antes do pool esgotar — modal escolhe entre subir parcial (só locs contadas viram diverg) ou cancelar tudo. Migrations: `supabase/migrations/20260512_wms_inventario_rewrite.sql` + `20260512_wms_inventario_slot_atribuido.sql`.
- **WMS Plano 5 (Exceções + dashboards) — implementado, validado em staging. Encerra Fase 0.** Devoluções classificadas A/B/C/D com recálculo de custo médio + transferência pra QUARENTENA + RMA. Troca SKU na separação (2 movs com mesma origem_id) com validação Cross opcional. Webhook NF detecta devolução (best-effort). Materialized view `siso_cobertura_estoque` com status crítico/atenção/lead_time_risco/ok/sem_giro. Dashboard geral (4 cards, refresh 30s). Shell e home reorganizados em 4 grupos. Plano: `docs/superpowers/plans/2026-06-05-wms-5-excecoes-dashboards.md`. Checklist Fase 0: `docs/superpowers/plans/wms-fase0-checklist.md`. **Próximo: Plano 6 (cutover big bang).**

### Deprecated / To Remove
- Cleanup deprecated `estoque_cwb_*`/`estoque_sp_*` columns from `siso_pedido_itens` (API reads from normalized table)
- Remove deprecated `cnpj-filial.ts` (replaced by empresa-lookup.ts)
- Remove deprecated `/api/compras/conferir` (replaced by comprar/receber flow)
- Remove deprecated `monitoramento/page.tsx` (replaced by painel/gerencial)

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
